/**
 * BitTorrent bridge (main process side).
 *
 * Videos are also published as normal BitTorrent torrents, so uTorrent /
 * qBittorrent / any torrent client can download AND seed them (extra backups),
 * and we can fall back to those seeders when no app peer has a video.
 *
 * FAIL-SAFE by design — BitTorrent is an optional extra layer:
 *  - engine runs in a separate child process (torrent-worker.mjs)
 *  - every call has a timeout and NEVER throws: failures return null/false
 *  - crashes → automatic restart with back-off, disabled after 3 failures
 *  - nothing in chat/video/relay waits on it
 * Opt-out: store 'bittorrent' = false.
 */
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

class TorrentBridge {
  constructor(p2p) {
    this.p2p = p2p;
    this.child = null;
    this.available = false;
    this.failures = 0;
    this.stopped = false;
    this.seq = 0;
    this.pending = new Map();
    this.progress = new Map();
    this.port = null;
    this.lastError = null;
    this.workerPath = p2p.store?.get('torrentWorker') || path.join(__dirname, 'torrent-worker.mjs');
  }

  enabled() { return this.p2p.store?.get('bittorrent', true) ?? true; }

  async start() {
    if (!this.enabled() || this.stopped) return false;
    try {
      if (!fs.existsSync(this.workerPath)) throw new Error('torrent worker missing');
      this.child = fork(this.workerPath, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      this.child.stderr?.on('data', () => {}); // never let worker output block
      this.child.on('message', (m) => this.onMessage(m));
      this.child.on('error', (e) => this.onExit(e.message));
      this.child.on('exit', (code) => this.onExit(`exit ${code}`));

      const st = this.p2p.store;
      const r = await this.call('init', {
        dht: st?.get('torrentDht', true) ?? true,
        lsd: st?.get('torrentLsd', true) ?? true,
        upnp: st?.get('upnp', true) ?? true,
        port: st?.get('torrentPort', 0) || 0
      }, 30000);
      if (!r) throw new Error(this.lastError || 'init failed');
      this.port = r.port;
      this.available = true;
      console.log(`[BitTorrent] Ready on port ${r.port} — videos are also shared with uTorrent/qBittorrent users`);
      this.seedAll(); // background
      return true;
    } catch (e) {
      this.lastError = e.message;
      console.log('[BitTorrent] unavailable (app continues normally):', e.message);
      this.kill();
      return false;
    }
  }

  onMessage(m) {
    if (!m) return;
    if (m.type === 'progress') return this.progress.get(m.id)?.(m);
    if (m.type === 'log') return; // worker-internal noise
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) { this.lastError = m.error; p.resolve(null); } else p.resolve(m.result);
  }

  onExit(reason) {
    if (!this.child) return;
    this.child = null;
    this.available = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
    if (this.stopped) return;
    this.failures++;
    console.log(`[BitTorrent] worker stopped (${reason})`);
    if (this.failures <= 3) {
      const delay = 5000 * 2 ** (this.failures - 1);
      setTimeout(() => this.start(), delay).unref?.();
    } else {
      console.log('[BitTorrent] disabled after repeated failures — app unaffected');
    }
  }

  /** Never throws. Resolves null on error / timeout / unavailable. */
  call(type, payload, timeout = 60000) {
    if (!this.child?.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); this.lastError = `${type} timed out`; resolve(null); }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      try { this.child.send({ id, type, payload }); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
  }

  chunkPaths(video) {
    return video.chunkHashes.map((h) => path.join(this.p2p.videoStore.dataDir, `${h}.chunk`));
  }

  static fileName(video) {
    const ext = { 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov' }[video.mimeType] || '.mp4';
    const safe = (video.title || 'video').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60) || 'video';
    return `${safe} [${video.id}]${ext}`;
  }

  /** Start seeding a fully-held video; stores its magnet/torrent on the video record */
  async seedVideo(video) {
    try {
      if (!this.available || !video || !this.p2p.videoStore.seeding.has(video.id)) return null;
      const r = await this.call('seed', { name: TorrentBridge.fileName(video), paths: this.chunkPaths(video), torrent: video.torrent || null }, 10 * 60 * 1000);
      if (!r) return null;
      const v = this.p2p.videoStore.getVideo(video.id);
      if (v && v.infoHash !== r.infoHash) {
        Object.assign(v, { infoHash: r.infoHash, magnet: r.magnet, torrent: r.torrent });
        this.p2p.videoStore.saveIndex();
      }
      return r.magnet;
    } catch (e) { return null; }
  }

  async seedAll() {
    for (const v of this.p2p.videoStore.getSeedingVideos()) {
      if (!this.available) return;
      await this.seedVideo(v);
    }
  }

  /** Fallback download from the BitTorrent swarm. Returns true/false, never throws. */
  async download(video, onProgress) {
    try {
      if (!this.available || !(video?.torrent || video?.magnet)) return false;
      const id = `${video.id}:${++this.seq}`;
      if (onProgress) this.progress.set(id, (m) => onProgress({ stage: 'bittorrent', percent: m.percent, peers: m.peers }));
      const r = await this.call('download', {
        id, torrent: video.torrent || null, magnet: video.magnet || null,
        paths: this.chunkPaths(video), hashes: video.chunkHashes,
        peers: this.p2p.store?.get('torrentPeers', []) || []
      }, 30 * 60 * 1000);
      this.progress.delete(id);
      return !!r?.ok;
    } catch (e) { return false; }
  }

  async remove(video) {
    try { if (this.available && video?.infoHash) await this.call('remove', { infoHash: video.infoHash }, 15000); } catch {}
  }

  async stats() {
    return (this.available && (await this.call('stats', {}, 5000))) || { torrents: 0, peers: 0 };
  }

  kill() {
    const c = this.child;
    this.child = null;
    this.available = false;
    try { c?.kill(); } catch {}
  }

  stop() { this.stopped = true; this.kill(); }
}

module.exports = { TorrentBridge };
