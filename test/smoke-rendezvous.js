/**
 * Zero-config discovery: a brand-new install that knows ONLY a bootstrap peer
 * finds the other app nodes by itself (DHT rendezvous), relays first.
 *   Z = bootstrap (plain DHT node)   R = reachable node (relay)   X = NAT'd node
 *   N = new install: extraBootstrap = [Z] and nothing else
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const { P2PNode } = require('../src/main/p2p-node');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(500); } throw new Error('timeout: ' + label); }
const res = []; const ok = (n, c, x = '') => { res.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); };
function mk(name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  for (const [k, v] of Object.entries({ user: { username: name }, bootstrap: false, mdns: false, upnp: false, tunnel: false, bittorrent: false,
    rendezvous: true, rendezvousDelayMs: 1000, rendezvousEveryMs: 4000, ...extra })) store.set(k, v);
  return new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
}
(async () => {
  const PORT_R = 5100 + Math.floor(Math.random() * 400);
  const Z = mk('Z', { rendezvous: false });
  await Z.start();
  const zAddr = Z.node.getMultiaddrs().map(String).find((a) => a.includes('/tcp/') && !a.includes('/ws') && a.includes('127.0.0.1'));
  const R = mk('R', { extraBootstrap: [zAddr], listenPorts: { tcp: PORT_R }, announceAddrs: [`/ip4/127.0.0.1/tcp/${PORT_R}`] });
  const X = mk('X', { extraBootstrap: [zAddr] });
  await R.start(); await X.start();
  ok('R knows it is reachable (announces as relay)', R.discovery.isReachable());
  ok('X knows it is NOT reachable (announces as node only)', !X.discovery.isReachable());
  await sleep(6000); // let R and X publish their rendezvous records

  const N = mk('N', { extraBootstrap: [zAddr] });
  await N.start();
  ok('new install starts knowing only the bootstrap peer', N.connectedPeers.size <= 1);
  await waitFor(() => N.connectedPeers.has(R.peerId), 40000, 'found R').catch(() => {});
  ok('new install finds the relay node by itself', N.connectedPeers.has(R.peerId));
  await waitFor(() => N.connectedPeers.has(X.peerId), 40000, 'found X').catch(() => {});
  ok('…and other app nodes', N.connectedPeers.has(X.peerId));
  await waitFor(() => N.node.getMultiaddrs().some((m) => m.toString().includes(`${R.peerId}/p2p-circuit`)), 30000, 'reservation').catch(() => {});
  ok('…and gets a relay slot on it (reachable through R)', N.node.getMultiaddrs().some((m) => m.toString().includes(`${R.peerId}/p2p-circuit`)),
    N.node.getMultiaddrs().some((m) => m.toString().includes(`${R.peerId}/p2p-circuit`)) ? '' : 'circuits: ' + JSON.stringify(N.node.getMultiaddrs().map(String).filter((a) => a.includes('circuit')).map((a) => a.split('/p2p-circuit')[0].slice(-12))) + ' R=' + R.peerId.slice(-8) + ' Z=' + Z.peerId.slice(-8) + ' X=' + X.peerId.slice(-8));

  // Lone node: rendezvous finds nothing → no crash, keeps running
  const L = mk('L', { extraBootstrap: [] });
  await L.start(); await sleep(6000);
  ok('alone on the network → keeps running, no crash', !!L.node && L.node.status === 'started');

  for (const n of [N, X, R, Z, L]) await n.stop().catch(() => {});
  const failed = res.filter((r) => !r).length;
  console.log(`\n${res.length - failed}/${res.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
