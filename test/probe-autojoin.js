// LIVE: headless server on a NAT'd PC (free tunnel, no public IP) + a brand-new install
// that has NO addresses configured. Both use the public internet DHT only (no mDNS/LAN).
//   node test/probe-autojoin.js
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { P2PNode } = require('../src/main/p2p-node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
(async () => {
  const data = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-oldpc-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js'), '--data', data, '--tcp', '4901', '--ws', '4902', '--http', '4911', '--bittorrent', 'off', '--upnp', 'off'], { stdio: 'ignore' });
  let h = null;
  for (let i = 0; i < 90 && !(h && h.tunnel); i++) { await sleep(2000); h = await getJSON('http://127.0.0.1:4911/health').catch(() => null); }
  console.log('server (NAT, no public IP) tunnel:', h?.tunnel ? h.tunnel.split('/p2p/')[0] : 'NONE');
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-newinstall-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: 'new-install' }, mdns: false, upnp: false, tunnel: false, bittorrent: false })) store.set(k, v);
  const n = new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
  await n.start();
  let conn = null;
  for (let i = 0; i < 150 && !conn; i++) { await sleep(2000); conn = n.node.getConnections().find((c) => c.remotePeer.toString() === h.peerId); }
  console.log(conn
    ? `new install found the server by itself in ${((Date.now() - t0) / 1000).toFixed(0)}s via ${conn.remoteAddr.toString().split('/p2p/')[0]}${conn.limits ? ' (relayed)' : ''}`
    : 'new install did NOT find the server within 5 min');
  if (conn) {
    await sleep(20000);
    const all = n.node.getConnections().filter((c) => c.remotePeer.toString() === h.peerId);
    const { esm } = require('../src/main/esm');
    const peer = await n.node.peerStore.get(esm().peerIdFromString(h.peerId)).catch(() => null);
    console.log('new install knows server tunnel addr:', (peer?.addresses || []).some((a) => a.multiaddr.toString().includes('trycloudflare')));
    const hs = await getJSON('http://127.0.0.1:4911/health').catch(() => ({}));
    console.log('server announces its tunnel:', (hs.announced || []).some((a) => a.includes('trycloudflare')));
    const rel = await n.discovery.findProviders('relays:v1', { max: 50, timeout: 40000 });
    const me = rel.find((p) => p.id.toString() === h.peerId);
    console.log('public DHT record for the server:', me ? ((me.multiaddrs || []).some((a) => a.toString().includes('trycloudflare')) ? 'includes tunnel address' : 'NO tunnel address: ' + (me.multiaddrs || []).map(String).join(' ').slice(0, 120)) : 'not in this lookup');
    try {
      const c2 = await n.node.dial(esm().multiaddr(h.tunnel), { signal: AbortSignal.timeout(20000), force: true });
      console.log('explicit tunnel dial:', c2.limits ? 'LIMITED' : 'direct OK', c2.remoteAddr.toString().split('/p2p/')[0]);
    } catch (e) { console.log('explicit tunnel dial FAILED:', e.message); }
    console.log('connections to server 20s later:', all.map((c) => `${c.limits ? 'relayed' : 'direct'} ${c.remoteAddr.toString().split('/p2p/')[0].slice(0, 70)}`).join(' | '));
  }
  await n.stop(); srv.kill('SIGTERM'); await sleep(1500); process.exit(conn ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
