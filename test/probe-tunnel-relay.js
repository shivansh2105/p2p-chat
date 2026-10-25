// Two NAT'd peers that can ONLY reach one PC through its free Cloudflare tunnel:
//   node test/probe-tunnel-relay.js <tunnel multiaddr of PC>
// A and B never dial each other directly; B reaches A via PC (relay) over the tunnel.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
const { esm } = require('../src/main/esm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(name) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-' + name + '-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ bootstrap: false, mdns: false, upnp: false, tunnel: false, user: { username: name } })) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
(async () => {
  const pc = process.argv[2];
  const A = mk('natA'), B = mk('natB');
  await A.start(); await B.start();
  await A.node.dial(esm().multiaddr(pc)); await B.node.dial(esm().multiaddr(pc));
  let circ;
  for (let i = 0; i < 40 && !circ; i++) { await sleep(500); circ = A.node.getMultiaddrs().map(String).find((a) => a.includes('trycloudflare.com') && a.includes('/p2p-circuit')); }
  console.log('A got relay slot on the tunneled PC:', !!circ);
  if (!circ) { console.log('A addrs:', A.node.getMultiaddrs().map(String).filter((a) => a.includes('circuit'))); const pcConns = A.node.getConnections().map((c) => c.remoteAddr.toString()); console.log('A conns:', pcConns); const pcPeer = await A.node.peerStore.get(A.node.getConnections()[0].remotePeer); console.log('PC protocols has hop:', pcPeer.protocols.includes('/libp2p/circuit/relay/0.2.0/hop')); }
  // make sure no direct/LAN path is used
  for (const c of B.node.getConnections(A.node.peerId)) await c.close();
  const conn = await B.node.dial(esm().multiaddr(circ), { signal: AbortSignal.timeout(30000) });
  console.log('B -> A via:', conn.remoteAddr.toString().includes('/p2p-circuit') ? 'RELAY through tunneled PC' : conn.remoteAddr.toString());
  const got = new Promise((r) => A.once('message', r));
  B.connectedPeers.set(A.peerId, { id: A.peerId });
  await B.sendMessage(A.peerId, { content: 'hello through a free tunnel', type: 'text' });
  const m = await Promise.race([got, sleep(15000).then(() => null)]);
  console.log('chat B -> A through relay:', m?.content === 'hello through a free tunnel');
  console.log('B<->A connections now:', B.node.getConnections(A.node.peerId).map((c) => (c.limits ? 'relayed ' : 'direct ') + c.status));
  const file = path.join(B.dataDir, 'v.mp4'); fs.writeFileSync(file, require('crypto').randomBytes(2 * 1024 * 1024));
  const v = await B.videoStore.uploadVideo(file, { title: 'via tunnel relay', uploader: B.peerId });
  const t = Date.now();
  await B.videoProtocol.replicateTo(A.peerId, v);
  console.log(`video B -> A through relay: verified=${A.videoStore.verifyComplete(v.id)} (${(2 * 8 / ((Date.now() - t) / 1000)).toFixed(1)} Mbps)`);
  await A.stop(); await B.stop(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
