// node test/probe-rendezvous.js — who is listed under the rendezvous keys on the PUBLIC DHT?
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-rv-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: 'probe' }, mdns: false, upnp: false, tunnel: false, bittorrent: false, rendezvous: false })) store.set(k, v);
  const n = new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
  await n.start();
  await new Promise((r) => setTimeout(r, 15000));
  for (const key of ['relays:v1', 'nodes:v1']) {
    const t = Date.now();
    const provs = await n.discovery.findProviders(key, { max: 20, timeout: 40000 });
    console.log(`${key}: ${provs.length} found in ${((Date.now() - t) / 1000).toFixed(0)}s`);
    for (const p of provs) console.log('   ', p.id.toString().slice(-10), (p.multiaddrs || []).map(String).filter((a) => a.includes('trycloudflare') || a.includes('/ws')).slice(0, 2).join(' '));
  }
  await n.stop(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
