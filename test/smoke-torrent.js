/**
 * BitTorrent layer test (local, no public DHT):
 *  1. A uploads a real video → it is also seeded as a torrent (magnet link)
 *  2. A STANDARD BitTorrent client (plain WebTorrent, like uTorrent) downloads it
 *     via the magnet → bytes identical
 *  3. B knows the video but NO app peer has it → falls back to BitTorrent swarm
 *  4. Fail-safe: broken worker → app starts, uploads, chats normally; magnet = null
 *  5. Fail-safe: worker killed mid-run → app still serves video over P2P; worker restarts
 */
if (typeof Promise.withResolvers !== 'function') Promise.withResolvers = function () { let a, b; const p = new this((r, j) => { a = r; b = j; }); return { promise: p, resolve: a, reject: b }; };
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { P2PNode } = require('../src/main/p2p-node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } throw new Error('timeout: ' + label); }
function mk(name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: name }, bootstrap: false, mdns: false, upnp: false, tunnel: false,
    bittorrent: true, torrentDht: false, torrentLsd: false, ...extra })) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
const res = []; const ok = (n, c, x = '') => { res.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); };

(async () => {
  const clip = process.env.VIDEO_FILE;
  const file = clip && fs.existsSync(clip) ? clip : (() => { const f = path.join(os.tmpdir(), 'bt-test.mp4'); fs.writeFileSync(f, crypto.randomBytes(3 * 1024 * 1024 + 99)); return f; })();
  const original = fs.readFileSync(file);

  // 1. upload → magnet
  const A = mk('btA');
  await A.start();
  await waitFor(() => A.torrent?.available, 30000, 'worker ready');
  ok('BitTorrent worker starts in its own process', A.torrent.available, `port ${A.torrent.port}`);
  const video = await A.uploadVideo(file, { title: 'Torrent test clip', tags: ['bt'] });
  await waitFor(() => A.videoStore.getVideo(video.id)?.magnet, 60000, 'magnet').catch((e) => { console.log('lastError:', A.torrent.lastError); throw e; });
  const magnet = A.videoStore.getVideo(video.id).magnet;
  ok('upload also creates a magnet link', /^magnet:\?xt=urn:btih:[0-9a-f]{40}/.test(magnet), magnet.slice(0, 60) + '…');

  // 2. standard BitTorrent client downloads it
  const { default: WebTorrent } = await import('webtorrent');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-client-'));
  const other = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  const t = other.add(magnet, { path: outDir, announce: [] });
  t.on('infoHash', () => t.addPeer(`127.0.0.1:${A.torrent.port}`));
  await Promise.race([new Promise((r) => t.once('done', r)), sleep(60000)]);
  const got = t.done ? fs.readFileSync(path.join(outDir, t.files[0].path)) : null;
  ok('standard torrent client (uTorrent-style) downloads identical bytes', got && Buffer.compare(got, original) === 0, t.done ? `${(original.length / 1048576).toFixed(1)} MB` : 'not done');
  await new Promise((r) => other.destroy(r));

  // 3. B: no app seeders → BitTorrent fallback
  const B = mk('btB', { torrentPeers: [`127.0.0.1:${A.torrent.port}`] });
  await B.start();
  await waitFor(() => B.torrent?.available, 30000, 'B worker');
  B.videoStore.addVideoFromNetwork({ ...A.videoStore.getVideo(video.id) }); // learned via search earlier; A not connected over P2P
  const vB = await B.downloadVideo(video.id).catch((e) => ({ error: e.message }));
  ok('no app seeders → downloads from BitTorrent swarm, hash-verified', !vB.error && B.videoStore.verifyComplete(video.id), vB.error ? vB.error + ' | bt: ' + B.torrent.lastError : '');
  ok('…and B now seeds it (P2P + BitTorrent)', B.videoStore.seeding.has(video.id) && (await B.torrent.stats()).torrents >= 1);

  // 4. broken worker → app still fine
  const C = mk('btC', { torrentWorker: path.join(os.tmpdir(), 'does-not-exist.mjs') });
  await C.start();
  await sleep(1500);
  ok('broken BitTorrent worker → app starts normally', !!C.node && C.torrent && !C.torrent.available);
  const f2 = path.join(C.dataDir, 'c.mp4'); fs.writeFileSync(f2, crypto.randomBytes(600 * 1024));
  const vc = await C.uploadVideo(f2, { title: 'no bt' });
  await sleep(1000);
  ok('…uploads still work (just no magnet)', C.videoStore.verifyComplete(vc.id) && !C.videoStore.getVideo(vc.id).magnet);
  const tcp = (n) => n.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));
  await C.node.dial(tcp(A));
  await waitFor(() => A.connectedPeers.has(C.peerId), 10000, 'C<->A');
  const msg = new Promise((r) => A.once('message', r));
  await C.sendMessage(A.peerId, { content: 'chat works without bittorrent', type: 'text' });
  ok('…chat still works', (await Promise.race([msg, sleep(8000).then(() => null)]))?.content === 'chat works without bittorrent');

  // 5. kill A's worker → P2P video unaffected, worker restarts
  A.torrent.child.kill('SIGKILL');
  await sleep(500);
  ok('worker crash → marked unavailable, no app crash', !A.torrent.available && !!A.node);
  const D = mk('btD', { bittorrent: false });
  await D.start(); await D.node.dial(tcp(A));
  await waitFor(() => A.connectedPeers.has(D.peerId), 10000, 'D<->A');
  D.videoStore.addVideoFromNetwork({ ...A.videoStore.getVideo(video.id) });
  await D.downloadVideo(video.id);
  ok('…videos still stream over P2P while BitTorrent is down', D.videoStore.verifyComplete(video.id));
  ok('…worker restarts automatically', await waitFor(() => A.torrent.available, 30000, 'restart').catch(() => false));

  for (const n of [A, B, C, D]) await n.stop().catch(() => {});
  const failed = res.filter((r) => !r).length;
  console.log(`\n${res.length - failed}/${res.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
