/**
 * NAT scenario: "nat1" and "nat2" never dial each other directly. Both only
 * connect OUT to "relay". nat2 reaches nat1 via /p2p-circuit, then chat +
 * offline-key exchange + video replication all run over the relayed link.
 *   node test/smoke-relay.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { P2PNode } = require('../src/main/p2p-node');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); }
  throw new Error('timeout: ' + label);
}
function makeNode(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: name });
  store.set('bootstrap', false);
  store.set('tunnel', false); store.set('bittorrent', false); store.set('rendezvous', false);
  const db = { async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} };
  return new P2PNode(db, store, dir);
}

(async () => {
  const results = [];
  const ok = (n, c) => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
  const relay = makeNode('relay');
  const nat1 = makeNode('nat1');
  const nat2 = makeNode('nat2');
  await relay.start(); await nat1.start(); await nat2.start();
  const tcp = (n) => n.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));

  await nat1.node.dial(tcp(relay));
  await nat2.node.dial(tcp(relay));

  // nat1 should obtain a relay reservation → a /p2p-circuit address
  await waitFor(() => nat1.node.getMultiaddrs().some((m) => m.toString().includes('/p2p-circuit')), 20000, 'reservation').catch(() => {});
  const circuit = nat1.node.getMultiaddrs().find((m) => m.toString().includes('/p2p-circuit'));
  ok('nat1 got relay reservation (/p2p-circuit address)', !!circuit);
  if (!circuit) process.exit(1);

  // Make sure mDNS / direct links between nat1 & nat2 don't exist
  for (const c of nat2.node.getConnections(nat1.node.peerId)) await c.close();
  const conn = await nat2.node.dial(circuit);
  ok('nat2 -> nat1 connected THROUGH relay', conn.remoteAddr.toString().includes('/p2p-circuit'));
  ok('connection is limited (relayed)', !!conn.limits);

  await waitFor(() => nat2.inbox.peerBoxKeys.has(nat1.peerId), 10000, 'keys').catch(() => {});
  ok('inbox key exchange over relay', nat2.inbox.peerBoxKeys.has(nat1.peerId));

  const got = new Promise((res) => nat1.once('message', res));
  nat2.connectedPeers.set(nat1.peerId, { id: nat1.peerId });
  await nat2.sendMessage(nat1.peerId, { content: 'via relay', type: 'text' });
  const m = await Promise.race([got, sleep(10000).then(() => null)]);
  ok('chat message over relay', m && m.content === 'via relay');

  const file = path.join(nat2.dataDir, 'v.mp4');
  fs.writeFileSync(file, crypto.randomBytes(2 * 1024 * 1024));
  const video = await nat2.videoStore.uploadVideo(file, { title: 'relay clip', uploader: nat2.peerId });
  await nat2.videoProtocol.replicateTo(nat1.peerId, video);
  ok('video replicated over relay + hash verified', nat1.videoStore.verifyComplete(video.id));

  await Promise.allSettled([relay.stop(), nat1.stop(), nat2.stop()]);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
