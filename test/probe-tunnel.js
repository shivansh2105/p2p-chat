// node test/probe-tunnel.js <wss multiaddr>
// Connects ONLY through a Cloudflare Quick Tunnel address, then searches + downloads a video.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
const { esm } = require('../src/main/esm');
(async () => {
  const addr = process.argv[2];
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-tun-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ bootstrap: false, mdns: false, upnp: false, storageEnabled: false, user: { username: 'tunnel-client' } })) store.set(k, v);
  const n = new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
  await n.start();
  const t0 = Date.now();
  const conn = await n.node.dial(esm().multiaddr(addr), { signal: AbortSignal.timeout(30000) });
  console.log('connected via', conn.remoteAddr.toString().split('/p2p/')[0], 'in', Date.now() - t0, 'ms');
  await new Promise((r) => setTimeout(r, 1500));
  const found = await n.searchVideos('desktop');
  const v = found.find((x) => x.title === 'desktop clip');
  console.log('search found:', !!v);
  const t1 = Date.now();
  await n.downloadVideo(v.id);
  const secs = (Date.now() - t1) / 1000;
  const mb = v.size / 1048576;
  console.log(`downloaded ${mb.toFixed(1)} MB in ${secs.toFixed(1)}s = ${(mb * 8 / secs).toFixed(1)} Mbps, verified: ${n.videoStore.verifyComplete(v.id)}`);
  await n.stop();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
