/**
 * Swarm test (DHT as tracker, no public bootstrap):
 *
 *   A(uploader)─B   A─C   B─E   C─E        D joins knowing ONLY E
 *
 *  1. A uploads → pushed to B, C → A goes offline
 *  2. D (only connected to E) searches "goa" → DHT keyword lookup finds B/C
 *  3. D swarm-downloads from B+C, verifies, and becomes a seeder itself
 *  4. B is low on disk and others have it → B evicts its copy
 *  5. X→Y message while Y offline; Y comes back knowing only D and finds
 *     its mail holders via the DHT
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { P2PNode } = require('../src/main/p2p-node');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); }
  throw new Error('timeout: ' + label);
}
function mk(name, dir, extra = {}) {
  dir = dir || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: name });
  store.set('bootstrap', false);
  store.set('tunnel', false); store.set('bittorrent', false); store.set('rendezvous', false); // isolate from public network
  store.set('tunnel', false); store.set('bittorrent', false); store.set('rendezvous', false);
  store.set('mdns', false);      // no LAN auto-discovery: only explicit links + DHT
  for (const [k, v] of Object.entries(extra)) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
const tcp = (n) => n.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));
async function link(x, y) {
  await x.node.dial(tcp(y));
  await waitFor(() => x.connectedPeers.has(y.peerId) && y.connectedPeers.has(x.peerId), 10000, 'link');
}

(async () => {
  const res = [];
  const ok = (n, c) => { res.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

  const A = mk('A'), B = mk('B'), C = mk('C'), E = mk('E');
  for (const n of [A, B, C, E]) await n.start();
  await link(A, B); await link(A, C); await link(B, E); await link(C, E);
  await sleep(1500);

  const file = path.join(A.dataDir, 'goa.mp4');
  fs.writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024));
  const video = await A.uploadVideo(file, { title: 'Goa beach sunset', tags: ['travel'] });
  await waitFor(() => (video.replicas || []).length >= 2, 30000, 'replicas');
  ok('initial copies pushed to B and C', video.replicas.length >= 2);
  await sleep(3000); // DHT provider records propagate

  await A.stop();
  ok('uploader offline', true);

  const D = mk('D');
  await D.start();
  await link(D, E);
  ok('D starts knowing only E', !D.connectedPeers.has(B.peerId) && !D.connectedPeers.has(C.peerId));

  if (process.env.P2P_DEBUG) {
    const t = Date.now(); const pv = await D.discovery.findProviders('kw:goa', { max: 10, timeout: 15000 });
    console.log('debug kw:goa providers', pv.map((p) => p.id.toString().slice(-6)), 'in', Date.now() - t, 'ms', 'B', B.peerId.slice(-6), 'C', C.peerId.slice(-6),
      'lanRT', D.node.services.lanDht.routingTable.size, 'pubRT', D.node.services.dht.routingTable.size);
  }
  const results = await D.searchVideos('goa');
  ok('D finds video network-wide via DHT keyword record', results.some((r) => r.id === video.id));

  const seeders = await D.videoProtocol.findSeeders(video.id);
  ok(`D finds ${seeders.length} seeders via DHT (B, C)`, seeders.includes(B.peerId) && seeders.includes(C.peerId));

  await D.downloadVideo(video.id);
  ok('D swarm-downloads + verifies', D.videoStore.verifyComplete(video.id));
  await sleep(3000);

  const provs = await E.discovery.findProviders('video:' + video.id);
  ok(`viewer D is now a seeder on the DHT (${provs.length} seeders seen from E)`, provs.some((p) => p.id.toString() === D.peerId));

  // B: tiny disk quota, "lots of others" threshold = 2 for the test
  B.store.set('storageQuotaMB', 2);
  B.store.set('videoSafeCopies', 2);
  B.store.set('videoProtectMs', 0);
  const evicted = await B.videoProtocol.evictionPass();
  ok('B evicts its copy because C + D still seed it', evicted.some((e) => e.id === video.id) && B.videoStore.getMissingChunks(video.id).length > 0);
  ok('video still complete on C and D', C.videoStore.verifyComplete(video.id) && D.videoStore.verifyComplete(video.id));

  // DHT still lists A (offline) and B (evicted) as seeders → 4 records, but only
  // D and E (A's 3rd replica) are LIVE. With safeCopies = 3, C must keep its copy.
  C.store.set('storageQuotaMB', 2); C.store.set('videoSafeCopies', 3); C.store.set('videoProtectMs', 0);
  await sleep(500);
  const ev2 = await C.videoProtocol.evictionPass();
  ok('C keeps its copy: stale DHT records (A offline, B evicted) not counted', !ev2.some((e) => e.id === video.id) && C.videoStore.verifyComplete(video.id));

  // ── Offline mail found via DHT ──
  const X = mk('X'), Y = mk('Y');
  await X.start(); await Y.start();
  await link(X, Y); await link(X, E);
  await waitFor(() => X.inbox.peerBoxKeys.has(Y.peerId), 10000, 'keys');
  const yId = Y.peerId, yDir = Y.dataDir;
  await Y.stop();
  await waitFor(() => !X.connectedPeers.has(yId), 10000, 'Y gone');
  await X.sendMessage(yId, { content: 'found you via DHT', type: 'text' });
  ok('E holds sealed mail for Y', E.messageStore.getMessageCount(yId) === 1);
  await sleep(3000);
  await X.stop();

  const Y2 = mk('Y', yDir);
  await Y2.start();
  const got = new Promise((r) => Y2.on('message', (m) => m.content === 'found you via DHT' && r(m)));
  await link(Y2, D); // Y only knows D (not a holder)
  await sleep(1000);
  await Y2.inbox.findMyMail();
  const m = await Promise.race([got, sleep(15000).then(() => null)]);
  ok('Y (knowing only D) finds mail holder E via DHT and receives message', !!m);

  await Promise.allSettled([B, C, D, E, Y2].map((n) => n.stop()));
  const failed = res.filter((r) => !r).length;
  console.log(`\n${res.length - failed}/${res.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
