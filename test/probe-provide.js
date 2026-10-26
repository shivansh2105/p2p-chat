// Can node A publish a provider record on the PUBLIC DHT that node B then finds?
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
function mk(name) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-pv-' + name + '-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: name }, mdns: false, upnp: false, tunnel: false, bittorrent: false, rendezvous: false })) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
(async () => {
  const key = 'probe:' + Date.now();
  const A = mk('A'); await A.start();
  await new Promise((r) => setTimeout(r, 15000));
  console.log('A routing table:', A.node.services.dht.routingTable.size);
  let t = Date.now();
  try {
    const cid = await A.discovery.cidFor(key);
    await A.node.contentRouting.provide(cid, { signal: AbortSignal.timeout(240000) });
    console.log(`provide OK in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  } catch (e) { console.log(`provide FAILED after ${((Date.now() - t) / 1000).toFixed(0)}s: ${e.name} ${e.message}`); }
  const B = mk('B'); await B.start();
  await new Promise((r) => setTimeout(r, 15000));
  t = Date.now();
  const found = await B.discovery.findProviders(key, { max: 5, timeout: 90000 });
  console.log(`B found ${found.length} provider(s) in ${((Date.now() - t) / 1000).toFixed(0)}s; is A: ${found.some((p) => p.id.toString() === A.peerId)}`);
  await A.stop(); await B.stop(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
