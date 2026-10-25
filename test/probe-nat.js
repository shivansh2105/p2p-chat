// Probe: what does THIS network give us? IPv6? UPnP port mapping? NAT status?
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-nat-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: 'probe' }); store.set('tunnel', false); store.set('bittorrent', false);
  const n = new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
  await n.start();
  console.log('services:', Object.keys(n.node.services).join(', '));
  console.log('listening on:', n.node.getMultiaddrs().length ? '' : '(none)');
  for (const a of n.node.components?.transportManager?.getAddrs?.() || []) console.log('  listen', a.toString());
  await sleep(45000);
  const addrs = n.node.getMultiaddrs().map(String);
  const v6 = addrs.filter((a) => a.startsWith('/ip6/') && !a.startsWith('/ip6/::1') && !a.startsWith('/ip6/fe80'));
  const v4pub = addrs.filter((a) => a.startsWith('/ip4/') && !/\/ip4\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) && !a.includes('p2p-circuit'));
  const circ = addrs.filter((a) => a.includes('p2p-circuit'));
  console.log('IPv6 global addrs:', v6.length ? v6.slice(0, 3) : 'none');
  console.log('Public IPv4 (UPnP/direct):', v4pub.length ? v4pub.slice(0, 3) : 'none');
  console.log('Relay addrs:', circ.length);
  await n.stop();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
