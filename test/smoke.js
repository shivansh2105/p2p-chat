/**
 * Smoke test: boots two real P2PNode instances (no Electron) and checks
 * startup, connection, and messaging. Run with the same Node major Electron
 * uses (Electron 33 → Node 20.18):  node test/smoke.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { P2PNode } = require('../src/main/p2p-node');

class MemStore {
  constructor() { this.m = new Map(); }
  get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }
  set(k, v) { this.m.set(k, v); }
  delete(k) { this.m.delete(k); }
}

class MemDb {
  constructor() { this.msgs = []; }
  async addMessage(chatId, content, type, status, senderId, id) { this.msgs.push({ chatId, content, type, status, senderId, id }); }
  getMessagesSince() { return []; }
  updateContactUsername() {}
  getAllChats() { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, label = 'condition') {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeNode(name) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `p2p-${name}-`));
  const store = new MemStore();
  store.set('user', { username: name });
  store.set('bootstrap', false);
  store.set('tunnel', false); store.set('bittorrent', false); // local test: public network covered by probe:internet
  store.set('tunnel', false); store.set('bittorrent', false);
  return new P2PNode(new MemDb(), store, dir);
}

(async () => {
  const results = [];
  const ok = (name, cond) => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

  const a = makeNode('alice');
  const b = makeNode('bob');
  await a.start();
  await b.start();
  ok('both nodes start', a.node && b.node);
  ok('box keys exist', a.crypto.getBoxPublicKey() && b.crypto.getBoxPublicKey());

  const addr = a.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));
  await b.node.dial(addr);
  await waitFor(() => a.connectedPeers.has(b.peerId) && b.connectedPeers.has(a.peerId), 10000, 'connection');
  ok('peers connect', true);

  // Wait for presence exchange (box keys)
  await waitFor(() => a.inbox?.peerBoxKeys.has(b.peerId), 15000, 'key exchange').catch(() => {});
  ok('inbox keys exchanged on connect', a.inbox?.peerBoxKeys.has(b.peerId));

  // Direct message
  const got = new Promise((res) => b.once('message', res));
  await a.sendMessage(b.peerId, { content: 'hi bob', type: 'text' });
  const m = await Promise.race([got, sleep(8000).then(() => null)]);
  ok('direct message delivered', m && m.content === 'hi bob');

  if (process.argv.includes('--video')) await require('./smoke-video')(a, b, makeNode, ok, waitFor, sleep);
  if (process.argv.includes('--offline')) await require('./smoke-offline')(a, b, makeNode, ok, waitFor, sleep);

  await Promise.allSettled([a.stop(), b.stop()]);
  const failed = results.filter(([, p]) => !p).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(2); });
