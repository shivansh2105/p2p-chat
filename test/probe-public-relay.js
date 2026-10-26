// Probe: with NO volunteer relays, does a node get a public relay reservation,
// and can a second node reach it through that public relay (then hole-punch)?
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(name) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: name });
  store.set('tunnel', false); store.set('bittorrent', false); store.set('rendezvous', false);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
(async () => {
  const a = mk('pubA');
  await a.start();
  let circuit;
  for (let i = 0; i < 60 && !circuit; i++) {
    await sleep(1000);
    circuit = a.node.getMultiaddrs().map(String).find((m) => m.includes('/p2p-circuit') && !m.includes('127.0.0.1') && !m.includes('192.168.'));
  }
  await sleep(15000); // let more reservations land
  console.log('first public relay reservation:', circuit || 'NONE after 60s');
  if (circuit) {
    const b = mk('pubB');
    await b.start();
    const circuits = a.node.getMultiaddrs().map(String).filter((m) => m.includes('/p2p-circuit') && !m.includes('127.0.0.1') && !m.includes('192.168.'));
    console.log('public relay reservations:', circuits.length);
    let conn;
    for (const c of circuits) {
      try {
        conn = await b.node.dial(require('../src/main/esm').esm().multiaddr(c), { signal: AbortSignal.timeout(20000) });
        console.log('B reached A via public relay', c.split('/p2p-circuit')[0].split('/').slice(0, 3).join('/'), '| limited:', !!conn.limits, conn.limits ? JSON.stringify({ bytes: String(conn.limits.bytes), secs: conn.limits.seconds }) : '');
        break;
      } catch (e) { console.log('  relay', c.split('/').slice(2, 3)[0], 'failed:', e.message.slice(0, 60)); }
    }
    await sleep(8000);
    const conns = b.node.getConnections(a.node.peerId).map((c) => (c.limits ? 'relayed' : 'DIRECT') + ' ' + c.remoteAddr.toString().split('/p2p/')[0]);
    console.log('after DCUtR, B<->A connections: ' + JSON.stringify(conns));
    await b.stop();
  }
  await a.stop();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
