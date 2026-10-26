// Browser-side interop test. Open /e2e.html?peer=<desktop ws multiaddr>
// Desktop side: node test/mobile-peer.js (in repo root)
import { MobileNode } from './net.js';

const log = document.getElementById('log');
const results = [];
window.__e2e = { done: false, results };
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); log.textContent += `\n${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const peer = new URLSearchParams(location.search).get('peer');
  const m = await new MobileNode().start();
  window.__m = m;
  ok('mobile libp2p node starts in browser', !!m.peerId, m.peerId.slice(-8));

  let deskId;
  if (peer) {
    deskId = await m.dial(peer);
    ok('phone connects to desktop over WebSocket', !!deskId);
  } else {
    // Zero-config: public bootstrap → DHT rendezvous → a desktop/server
    const t0 = Date.now();
    for (let i = 0; i < 90 && !deskId; i++) {
      await m.findNodes().catch(() => {});
      deskId = (await m.appPeers('/p2p-chat/video-sync/1.0.0'))[0];
      if (!deskId) await sleep(2000);
    }
    const conn = deskId && m.node.getConnections().find((c) => c.remotePeer.toString() === deskId);
    ok('phone finds a desktop with NO address (public DHT rendezvous)', !!deskId,
      deskId ? `${((Date.now() - t0) / 1000).toFixed(0)}s via ${conn?.remoteAddr.toString().split('/p2p/')[0]}` : '');
    if (!deskId) throw new Error('no desktop found');
  }
  await sleep(1500);

  ok('desktop advertises app protocols', (await m.appPeers('/p2p-chat/video-sync/1.0.0')).includes(deskId));
  ok('inbox keys exchanged with desktop', m.peerBoxKeys.has(deskId));

  // chat phone -> desktop, desktop replies "pong: …"
  const reply = new Promise((r) => m.addEventListener('message', (e) => e.detail.content.startsWith('pong:') && r(e.detail)));
  const how = await m.sendMessage(deskId, 'hello from phone');
  const got = await Promise.race([reply, sleep(10000).then(() => null)]);
  ok('chat phone → desktop', how === 'direct');
  ok('chat desktop → phone', got && got.content === 'pong: hello from phone');

  // watch a video that the desktop uploaded
  const found = await m.searchNetwork('desktop');
  const v = found.find((x) => x.title === 'desktop clip');
  ok('phone finds desktop video by search', !!v);
  if (v) {
    const url = await m.watch(v);
    const el = document.createElement('video'); el.src = url; document.body.append(el);
    ok('phone downloads + verifies video, gets playable URL', url.startsWith('blob:'));
  }

  // upload from phone → copy lands on desktop
  const bytes = new Uint8Array(700 * 1024); crypto.getRandomValues(bytes.subarray(0, 65536));
  const file = new File([bytes], 'phone.mp4', { type: 'video/mp4' });
  const up = await m.uploadVideo(file, { title: 'phone clip', tags: ['mobile'] });
  ok('phone upload replicated to desktop', up.replicas.includes(deskId), `${up.chunkCount} chunks`);
  window.__e2e.phoneVideoId = up.id;

  window.__e2e.done = true;
  log.textContent += `\n\n${results.filter((r) => r.pass).length}/${results.length} passed`;
})().catch((e) => { log.textContent += '\nCRASH ' + e.stack; window.__e2e.done = true; window.__e2e.crash = String(e); });
