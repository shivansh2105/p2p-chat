/**
 * Headless server end-to-end (server runs as a real child process):
 *  1. starts, /health OK, fixed ports
 *  2. clients join ONLY via its bootstrap address (no manual dials, no LAN discovery)
 *  3. relay: a NAT'd client gets a relay slot on the server
 *  4. video: uploader pushes a replica to the server, goes offline, another client downloads it
 *  5. mail: message for an offline user is held by the server and delivered later
 *  6. SIGTERM → clean exit; restart → same Peer ID + same address
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const http = require('http');
const { P2PNode } = require('../src/main/p2p-node');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } throw new Error('timeout: ' + label); }
const getJSON = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const res = []; const ok = (n, c, x = '') => { res.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); };

const DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-server-'));
const TCP = 4300 + Math.floor(Math.random() * 500); const WS = TCP + 1; const HTTP = TCP + 10;

function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js'),
    '--data', DATA, '--tcp', String(TCP), '--ws', String(WS), '--http', String(HTTP),
    '--public-dht', 'off', '--tunnel', 'off', '--bittorrent', 'off', '--upnp', 'off', '--storage-gb', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => (p.log += d)); p.stderr.on('data', (d) => (p.log += d));
  return p;
}

function client(name, serverAddr, dir) {
  dir = dir || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: name }, bootstrap: false, extraBootstrap: [serverAddr], mdns: false, upnp: false, tunnel: false, bittorrent: false })) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}

(async () => {
  let srv = startServer();
  let health;
  await waitFor(async () => { try { health = await getJSON(`http://127.0.0.1:${HTTP}/health`); return health.ok; } catch { return false; } }, 60000, 'server health');
  ok('server starts headless, /health OK', health.ok, health.peerId.slice(-8));
  ok('fixed ports', health.announced.some((a) => a.includes(`/tcp/${TCP}/`)) && health.announced.some((a) => a.includes(`/tcp/${WS}/ws/`)));
  const serverAddr = `/ip4/127.0.0.1/tcp/${TCP}/p2p/${health.peerId}`;

  // 2. clients join only via bootstrap list
  const A = client('A', serverAddr); const B = client('B', serverAddr);
  await A.start(); await B.start();
  await waitFor(() => A.connectedPeers.has(health.peerId) && B.connectedPeers.has(health.peerId), 30000, 'bootstrap to server');
  ok('clients join automatically via built-in server address', true);

  // 3. relay slot on the server
  await waitFor(() => A.node.getMultiaddrs().some((m) => m.toString().includes(`${health.peerId}/p2p-circuit`)), 30000, 'reservation').catch(() => {});
  ok('NAT\'d client gets a relay slot on the server', A.node.getMultiaddrs().some((m) => m.toString().includes(`${health.peerId}/p2p-circuit`)));

  // 4. video replica to server, uploader offline, B downloads
  const f = path.join(A.dataDir, 'v.mp4'); fs.writeFileSync(f, crypto.randomBytes(2 * 1024 * 1024 + 7));
  const v = await A.uploadVideo(f, { title: 'Server backed clip', tags: ['server'] });
  await waitFor(() => (v.replicas || []).includes(health.peerId), 30000, 'replica on server');
  ok('upload is replicated to the server', (v.replicas || []).includes(health.peerId));
  await A.stop();
  const found = await B.searchVideos('server');
  ok('uploader offline → video still found (server holds it)', found.some((x) => x.id === v.id));
  await B.downloadVideo(v.id);
  ok('…and downloaded from the server, hash-verified', B.videoStore.verifyComplete(v.id));

  // 5. offline mail held by the server
  const C = client('C', serverAddr); await C.start();
  await waitFor(() => C.connectedPeers.has(health.peerId), 20000, 'C joined');
  await C.node.dial(B.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws') && !m.toString().includes('circuit')));
  await waitFor(() => C.inbox.peerBoxKeys.has(B.peerId), 15000, 'keys');
  const bId = B.peerId, bDir = B.dataDir;
  await B.stop();
  await waitFor(() => !C.connectedPeers.has(bId), 10000, 'B offline');
  await C.sendMessage(bId, { content: 'held by the server', type: 'text' });
  health = await getJSON(`http://127.0.0.1:${HTTP}/health`);
  ok('server holds sealed mail for offline user', health.mailbox.totalMessages >= 1);
  await C.stop();
  const B2 = client('B', serverAddr, bDir);
  const got = new Promise((r) => B2.on('message', (m) => m.content === 'held by the server' && r(m)));
  await B2.start();
  ok('user comes back (sender offline) → gets mail from server', !!(await Promise.race([got, sleep(30000).then(() => null)])));
  await B2.stop();

  // 6. clean shutdown + stable identity/address
  const exited = new Promise((r) => srv.on('exit', (code) => r(code)));
  srv.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(20000).then(() => 'timeout')]);
  ok('SIGTERM → clean exit', code === 0 || (process.platform === 'win32' && code !== 'timeout'), `code=${code}`);
  srv = startServer();
  await waitFor(async () => { try { const h = await getJSON(`http://127.0.0.1:${HTTP}/health`); return h.ok && (health = h); } catch { return false; } }, 60000, 'restart');
  ok('restart keeps same Peer ID and address', serverAddr.endsWith(health.peerId) && health.announced.some((a) => a.includes(`/tcp/${TCP}/`)));
  ok('restart keeps stored video', health.videos.videosSeeding >= 1);
  srv.kill('SIGTERM');

  const failed = res.filter((r) => !r).length;
  console.log(`\n${res.length - failed}/${res.length} passed`);
  if (failed) console.log('--- server log tail ---\n' + srv.log.split('\n').slice(-25).join('\n'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
