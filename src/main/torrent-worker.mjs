// BitTorrent engine, running in its OWN process (forked by torrent-bridge.js).
// If anything here crashes (bad torrent, library bug, network error), only
// this process dies — the app keeps working and the bridge just marks
// BitTorrent as unavailable / restarts it.
//
// Pieces = our 256KB chunks (pieceLength 262144), so a torrent seeds straight
// from the app's chunk files: no duplicate copy on disk.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () { let a, b; const p = new this((r, j) => { a = r; b = j; }); return { promise: p, resolve: a, reject: b }; };
}
import fs from 'node:fs';
import crypto from 'node:crypto';

const { default: WebTorrent } = await import('webtorrent');
const { default: bencode } = await import('bencode');

const PIECE = 256 * 1024;
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'http://tracker.opentrackr.org:1337/announce'
];

let client = null;
const send = (m) => { try { process.send(m); } catch {} };

// Chunk store backed by the app's chunk files. On download, every piece must
// ALSO match the app's SHA-256 for that chunk before it is written.
function chunkStore(paths, hashes) {
  return class ChunkFileStore {
    constructor(chunkLength) { this.chunkLength = chunkLength; }
    put(i, buf, cb = () => {}) {
      const p = paths[i];
      if (!p) return queueMicrotask(() => cb(new Error('bad piece index')));
      if (hashes && crypto.createHash('sha256').update(buf).digest('hex') !== hashes[i]) {
        return queueMicrotask(() => cb(new Error('piece failed sha256 check')));
      }
      fs.stat(p, (e, st) => (!e && st.size === buf.length ? cb(null) : fs.writeFile(p, buf, cb)));
    }
    get(i, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = null; }
      fs.readFile(paths[i], (e, b) => {
        if (e) return cb(e);
        if (opts) { const off = opts.offset || 0; b = b.subarray(off, off + (opts.length ?? b.length - off)); }
        cb(null, b);
      });
    }
    close(cb = () => {}) { cb(null); }
    destroy(cb = () => {}) { cb(null); }
  };
}

function info(t) {
  return { infoHash: t.infoHash, magnet: t.magnetURI, torrent: Buffer.from(t.torrentFile).toString('base64'), peers: t.numPeers };
}

function waitReady(t, ms = 120000) {
  return new Promise((resolve, reject) => {
    if (t.ready) return resolve(t);
    const timer = setTimeout(() => reject(new Error('torrent not ready in time')), ms);
    t.once('ready', () => { clearTimeout(timer); resolve(t); });
    t.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const handlers = {
  async init({ dht = true, lsd = true, upnp = true, port = 0 }) {
    client = new WebTorrent({ dht, lsd, natUpnp: upnp, natPmp: upnp, utp: false, webSeeds: false, torrentPort: port, maxConns: 55 });
    client.on('error', (e) => send({ type: 'log', msg: 'client error: ' + e.message }));
    await new Promise((r) => (client.listening ? r() : client.once('listening', r)));
    return { port: client.address()?.port || client.torrentPort };
  },

  // Seed a video we hold completely. Pieces == our 256KB chunks, so we build the
  // .torrent ourselves from per-chunk SHA-1s (streaming, low memory) and serve
  // pieces straight from the chunk files. Same chunks → same info-hash on every PC.
  async seed({ name, paths, torrent }) {
    const store = chunkStore(paths, null);
    let buf = torrent ? Buffer.from(torrent, 'base64') : null;
    if (!buf) {
      const pieces = [];
      let length = 0;
      for (const p of paths) {
        const data = await fs.promises.readFile(p);
        length += data.length;
        pieces.push(crypto.createHash('sha1').update(data).digest());
      }
      buf = Buffer.from(bencode.encode({
        announce: TRACKERS[0],
        'announce-list': TRACKERS.map((t) => [t]),
        'created by': 'P2P Chat',
        info: { length, name, 'piece length': PIECE, pieces: Buffer.concat(pieces) }
      }));
    }
    const existing = await client.get(buf);
    if (existing) return info(await waitReady(existing));
    const t = client.add(buf, { store, skipVerify: true, announce: TRACKERS });
    return info(await waitReady(t));
  },

  // Download from the BitTorrent swarm into the app's chunk files
  async download({ id, torrent, magnet, paths, hashes, peers = [] }) {
    const store = chunkStore(paths, hashes);
    const src = torrent ? Buffer.from(torrent, 'base64') : magnet;
    const t = (await client.get(src)) || client.add(src, { store, announce: TRACKERS });
    // addPeer needs the info-hash to be known first
    const addPeers = () => { for (const p of peers) { try { t.addPeer(p); } catch {} } };
    if (t.infoHash) addPeers(); else t.once('infoHash', addPeers);
    await waitReady(t);
    if (t.done) return { ok: true };
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => send({ type: 'progress', id, percent: Math.round(t.progress * 100), peers: t.numPeers }), 1000);
      t.once('done', () => { clearInterval(tick); resolve({ ok: true }); });
      t.once('error', (e) => { clearInterval(tick); reject(e); });
    });
  },

  async remove({ infoHash }) {
    const t = await client.get(infoHash);
    if (t) await new Promise((r) => client.remove(t, { destroyStore: false }, r));
    return { ok: true };
  },

  async stats() {
    return {
      torrents: client.torrents.length,
      peers: client.torrents.reduce((n, t) => n + t.numPeers, 0),
      uploadKBps: Math.round(client.uploadSpeed / 1024),
      downloadKBps: Math.round(client.downloadSpeed / 1024),
      uploadedMB: Math.round(client.torrents.reduce((n, t) => n + t.uploaded, 0) / 1048576)
    };
  }
};

process.on('message', async (msg) => {
  const fn = handlers[msg?.type];
  if (!fn) return send({ id: msg?.id, error: 'unknown request' });
  try {
    send({ id: msg.id, result: await fn(msg.payload || {}) });
  } catch (e) {
    send({ id: msg.id, error: e.message });
  }
});
process.on('uncaughtException', (e) => send({ type: 'log', msg: 'uncaught: ' + e.message }));
process.on('unhandledRejection', (e) => send({ type: 'log', msg: 'unhandled: ' + (e?.message || e) }));
process.on('disconnect', () => process.exit(0)); // parent gone → exit
send({ type: 'hello' });
