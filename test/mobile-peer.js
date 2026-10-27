// Desktop peer for the mobile e2e test (mobile/src/e2e.js).
//   node test/mobile-peer.js     → prints WS_ADDR=..., writes $TMPDIR/mobile-peer.json
// Uploads "desktop clip", answers chat with "pong: …", reports phone uploads it receives.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { P2PNode } = require('../src/main/p2p-node');

(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'p2p-desk-'));
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: 'desktop' }); store.set('bootstrap', false); store.set('mdns', false); store.set('upnp', false); store.set('tunnel', process.env.TUNNEL === '1'); store.set('bittorrent', process.env.BITTORRENT === '1'); store.set('rendezvous', false);
  const n = new P2PNode({ async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} }, store, dir);
  await n.start();

  // VIDEO_FILE=<real.mp4> uploads a playable video (for player tests)
  const file = process.env.VIDEO_FILE || path.join(dir, 'clip.mp4');
  if (!process.env.VIDEO_FILE) fs.writeFileSync(file, crypto.randomBytes(1024 * 1024 + 777));
  await n.uploadVideo(file, { title: 'desktop clip', tags: ['desktop'] });

  n.on('message', async (m) => {
    if (m.content?.startsWith('pong:')) return;
    try { await n.sendMessage(m.senderId || m.chatId, { content: 'pong: ' + m.content, type: 'text' }); } catch (e) { console.log('reply failed', e.message); }
  });

  const out = path.join(process.env.TMPDIR || os.tmpdir(), 'mobile-peer.json');
  const ws = n.node.getMultiaddrs().map(String).find((a) => a.startsWith('/ip4/127.0.0.1/') && a.includes('/ws/'));
  const state = () => ({ ws, share: n.getShareableAddresses()[0], tunnel: n.tunnel?.addr || null, peerId: n.peerId, videos: n.videoStore.getSeedingVideos().map((v) => ({ id: v.id, title: v.title, ok: n.videoStore.verifyComplete(v.id) })) });
  fs.writeFileSync(out, JSON.stringify(state()));
  setInterval(() => fs.writeFileSync(out, JSON.stringify(state())), 1000);
  console.log('WS_ADDR=' + ws);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
