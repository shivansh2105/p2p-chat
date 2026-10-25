/**
 * P2P Video Protocol - BitTorrent-style video sharing
 * 
 * Handles:
 * - Video discovery via gossip
 * - Chunk requests from peers
 * - Multi-peer streaming (download from multiple sources)
 */

const EventEmitter = require('events');
const { CHUNK_SIZE } = require('./video-store');

const VIDEO_PROTOCOL = '/p2p-chat/video/1.0.0';
const VIDEO_TOPIC = 'p2p-chat:videos';
const VIDEO_SYNC_PROTOCOL = '/p2p-chat/video-sync/1.0.0';
const DEFAULT_QUOTA_MB = 5 * 1024; // each PC donates up to 5 GB by default (opt-out / adjustable)

class VideoProtocol extends EventEmitter {
  constructor(node, videoStore) {
    super();
    this.node = node;
    this.videoStore = videoStore;
    this.pendingRequests = new Map();
    this.discovery = null; // set by P2PNode
  }

  async start() {
    // Register protocol handler
    await this.node.handle(VIDEO_PROTOCOL, async ({ stream, connection }) => {
      await this.handleRequest(stream, connection.remotePeer.toString());
    });

    // Replication receiver: other PCs push copies of videos to us so the
    // video survives when the uploader goes offline.
    await this.node.handle(VIDEO_SYNC_PROTOCOL, async ({ stream, connection }) => {
      let res;
      try {
        const chunks = [];
        for await (const c of stream.source) chunks.push(Buffer.from(c.subarray()));
        res = this.handleSync(JSON.parse(Buffer.concat(chunks).toString()), connection.remotePeer.toString());
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      try { await stream.sink([Buffer.from(JSON.stringify(res))]); } catch {}
    });

    // Subscribe to video announcements
    const pubsub = this.node.services.pubsub;
    pubsub.subscribe(VIDEO_TOPIC);
    pubsub.addEventListener('message', (evt) => {
      if (evt.detail.topic === VIDEO_TOPIC) {
        this.handleVideoAnnouncement(evt.detail);
      }
    });

    console.log('[VideoProtocol] Started');
  }

  /**
   * Handle incoming video requests
   */
  async handleRequest(stream, peerId) {
    try {
      const chunks = [];
      for await (const chunk of stream.source) {
        chunks.push(Buffer.from(chunk.subarray()));
      }
      
      const request = JSON.parse(Buffer.concat(chunks).toString());
      let response;

      switch (request.type) {
        case 'GET_VIDEO_INFO':
          response = this.handleGetVideoInfo(request.videoId);
          break;
        case 'GET_CHUNK':
          response = this.handleGetChunk(request.chunkHash);
          break;
        case 'GET_AVAILABLE_CHUNKS':
          response = this.handleGetAvailableChunks(request.videoId);
          break;
        case 'SEARCH':
          response = this.handleSearch(request.query);
          break;
        case 'LIST_VIDEOS':
          response = this.handleListVideos();
          break;
        default:
          response = { error: 'Unknown request type' };
      }

      await stream.sink([Buffer.from(JSON.stringify(response))]);
    } catch (e) {
      console.error('[VideoProtocol] Request error:', e.message);
    }
  }

  storageEnabled() {
    return this.videoStore.store?.get('storageEnabled', true) ?? true;
  }

  quotaBytes() {
    return (this.videoStore.store?.get('storageQuotaMB', DEFAULT_QUOTA_MB) ?? DEFAULT_QUOTA_MB) * 1024 * 1024;
  }

  handleSync(req, fromPeer) {
    if (!this.storageEnabled()) return { ok: false, error: 'storage disabled' };
    const vs = this.videoStore;
    if (req.type === 'VIDEO_METADATA') {
      const v = req.video;
      if (!v || typeof v.id !== 'string' || !Array.isArray(v.chunkHashes) || !v.contentHash) return { ok: false, error: 'bad metadata' };
      if (v.id !== v.contentHash.slice(0, 16)) return { ok: false, error: 'id/hash mismatch' };
      if (v.chunkHashes.length !== Math.ceil(v.size / CHUNK_SIZE)) return { ok: false, error: 'bad chunk count' };
      if (vs.getUsedBytes() + v.size > this.quotaBytes()) return { ok: false, error: 'quota full' };
      vs.addVideoFromNetwork({ ...v, replicaFrom: fromPeer });
      return { ok: true, have: vs.getAvailableChunks(v.id) };
    }
    if (req.type === 'VIDEO_CHUNK') {
      const video = vs.getVideo(req.videoId);
      if (!video || !video.chunkHashes.includes(req.chunkHash)) return { ok: false, error: 'unknown chunk' };
      const data = Buffer.from(req.data || '', 'base64');
      if (data.length > CHUNK_SIZE) return { ok: false, error: 'chunk too big' };
      if (vs.getUsedBytes() + data.length > this.quotaBytes()) return { ok: false, error: 'quota full' };
      vs.storeChunk(req.chunkHash, data); // verifies sha256
      if (vs.getMissingChunks(video.id).length === 0 && vs.verifyComplete(video.id)) {
        vs.markAsSeeding(video.id);
        this.announceSeeding(video);
        this.emit('replicaComplete', video);
      }
      return { ok: true };
    }
    return { ok: false, error: 'unknown type' };
  }

  /**
   * Push a full copy of a video to one peer. Skips chunks it already has.
   */
  async replicateTo(peerId, video) {
    const meta = await this.sendSync(peerId, { type: 'VIDEO_METADATA', video: {
      id: video.id, title: video.title, description: video.description, tags: video.tags,
      duration: video.duration, size: video.size, chunkSize: video.chunkSize, chunkCount: video.chunkCount,
      chunkHashes: video.chunkHashes, contentHash: video.contentHash, mimeType: video.mimeType,
      thumbnail: video.thumbnail, uploader: video.uploader, uploaderName: video.uploaderName,
      uploadedAt: video.uploadedAt
    }});
    if (!meta.ok) throw new Error(meta.error || 'rejected');
    const have = new Set(meta.have || []);
    for (const hash of video.chunkHashes) {
      if (have.has(hash)) continue;
      const data = this.videoStore.getChunk(hash);
      if (!data) continue;
      const r = await this.sendSync(peerId, { type: 'VIDEO_CHUNK', videoId: video.id, chunkHash: hash, data: data.toString('base64') });
      if (!r.ok) throw new Error(r.error || 'chunk rejected');
    }
    return true;
  }

  async sendSync(peerId, body) {
    const stream = await this.node.dialProtocol(peerId, VIDEO_SYNC_PROTOCOL, { signal: AbortSignal.timeout(60000) });
    await stream.sink([Buffer.from(JSON.stringify(body))]);
    const chunks = [];
    for await (const c of stream.source) chunks.push(Buffer.from(c.subarray()));
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }

  handleGetVideoInfo(videoId) {
    const video = this.videoStore.getVideo(videoId);
    if (!video) return { error: 'Video not found' };
    
    // Don't send chunk data, just metadata
    const { chunkHashes, ...metadata } = video;
    return { 
      video: {
        ...metadata,
        chunkCount: chunkHashes.length
      }
    };
  }

  handleGetChunk(chunkHash) {
    const chunk = this.videoStore.getChunk(chunkHash);
    if (!chunk) return { error: 'Chunk not found' };
    
    return { 
      chunk: chunk.toString('base64'),
      hash: chunkHash
    };
  }

  handleGetAvailableChunks(videoId) {
    const available = this.videoStore.getAvailableChunks(videoId);
    return { chunks: available };
  }

  handleSearch(query) {
    const results = this.videoStore.searchVideos(query);
    return { 
      results: results.map(v => ({
        id: v.id,
        title: v.title,
        description: v.description,
        tags: v.tags,
        duration: v.duration,
        size: v.size,
        chunkSize: v.chunkSize,
        chunkCount: v.chunkCount,
        chunkHashes: v.chunkHashes,
        contentHash: v.contentHash,
        mimeType: v.mimeType,
        uploader: v.uploader,
        uploaderName: v.uploaderName,
        uploadedAt: v.uploadedAt,
        views: v.views,
        seeders: v.seeders
      }))
    };
  }

  handleListVideos() {
    const videos = this.videoStore.getSeedingVideos();
    return {
      videos: videos.map(v => ({
        id: v.id,
        title: v.title,
        duration: v.duration,
        size: v.size,
        uploadedAt: v.uploadedAt
      }))
    };
  }

  /**
   * Handle video announcements from network
   */
  handleVideoAnnouncement(message) {
    try {
      const data = JSON.parse(Buffer.from(message.data).toString());
      
      if (data.type === 'NEW_VIDEO') {
        const v = data.video;
        if (!v?.contentHash || v.id !== v.contentHash.slice(0, 16) || !Array.isArray(v.chunkHashes)) return;
        this.videoStore.addVideoFromNetwork(v);
        this.emit('newVideo', data.video);
      } else if (data.type === 'SEEDING') {
        // Peer is seeding a video - update seeder count
        const video = this.videoStore.getVideo(data.videoId);
        if (video) {
          video.seeders = (video.seeders || 0) + 1;
        }
      }
    } catch (e) {
      // Ignore invalid messages
    }
  }

  /**
   * Announce a new video to the network
   */
  async announceVideo(video) {
    const pubsub = this.node.services.pubsub;
    const announcement = {
      type: 'NEW_VIDEO',
      video: {
        id: video.id,
        title: video.title,
        description: video.description,
        tags: video.tags,
        duration: video.duration,
        size: video.size,
        chunkCount: video.chunkCount,
        chunkHashes: video.chunkHashes,
        contentHash: video.contentHash,
        chunkSize: video.chunkSize,
        mimeType: video.mimeType,
        uploader: video.uploader,
        uploaderName: video.uploaderName,
        uploadedAt: video.uploadedAt
      },
      peerId: this.node.peerId.toString()
    };

    await pubsub.publish(VIDEO_TOPIC, Buffer.from(JSON.stringify(announcement)));
    console.log(`[VideoProtocol] Announced: ${video.title}`);
  }

  /** Words used for DHT keyword records */
  static keywords(video) {
    const words = `${video.title || ''} ${(video.tags || []).join(' ')}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    return [...new Set(words)].slice(0, 12);
  }

  /**
   * We hold a full verified copy → become a seeder: announce on the DHT under
   * the video id and each title/tag keyword (so strangers can find it).
   */
  announceSeeding(video) {
    if (!this.discovery) return;
    this.discovery.provide('video:' + video.id);
    for (const w of VideoProtocol.keywords(video)) this.discovery.provide('kw:' + w);
  }

  /**
   * Network-wide search: connected peers + anyone the DHT says has a video
   * matching a query word (works without knowing the uploader).
   */
  async searchNetwork(query) {
    const localResults = this.videoStore.searchVideos(query);
    const askPeers = new Set();
    for (const pid of this.node.getPeers()) {
      if (askPeers.size >= 10) break;
      const peer = await this.node.peerStore.get(pid).catch(() => null);
      if (peer?.protocols.includes(VIDEO_PROTOCOL)) askPeers.add(pid.toString());
    }

    if (this.discovery) {
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 3);
      const found = await Promise.all(words.map((w) => this.discovery.findProviders('kw:' + w, { max: 10 })));
      for (const prov of found.flat()) {
        if (askPeers.size >= 25) break;
        if (await this.discovery.connect(prov)) askPeers.add(prov.id.toString());
      }
    }

    const networkResults = [];
    await Promise.allSettled([...askPeers].map(async (peerId) => {
      const response = await this.sendRequest(peerId, { type: 'SEARCH', query });
      if (Array.isArray(response.results)) networkResults.push(...response.results);
    }));

    const seen = new Set(localResults.map(v => v.id));
    const combined = [...localResults];
    for (const video of networkResults) {
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      combined.push(video);
      if (Array.isArray(video.chunkHashes) && video.contentHash?.slice(0, 16) === video.id) {
        this.videoStore.addVideoFromNetwork(video);
      }
    }
    return combined;
  }

  /** Peers that (probably) have this video: connected peers + DHT seeders */
  async findSeeders(videoId) {
    const peers = new Set();
    for (const pid of this.node.getPeers()) {
      const peer = await this.node.peerStore.get(pid).catch(() => null);
      if (peer?.protocols.includes(VIDEO_PROTOCOL)) peers.add(pid.toString());
    }
    if (this.discovery) {
      for (const prov of await this.discovery.findProviders('video:' + videoId, { max: 20 })) {
        if (await this.discovery.connect(prov)) peers.add(prov.id.toString());
      }
    }
    return [...peers];
  }

  /**
   * Swarm download: fetch missing chunks from many seeders in parallel.
   * Each chunk is hash-verified; finished chunks are servable immediately,
   * and when complete we become a full seeder.
   */
  async downloadVideo(videoId, onProgress) {
    const video = this.videoStore.getVideo(videoId);
    if (!video) throw new Error('Video not found - search first');

    const missing = this.videoStore.getMissingChunks(videoId);
    const total = video.chunkHashes.length;
    let downloaded = total - missing.length;

    if (missing.length) {
      const peers = await this.findSeeders(videoId);
      if (!peers.length) throw new Error('No seeders online for this video');
      const queue = [...missing];
      const failures = new Map();
      const WORKERS = Math.min(6, peers.length * 2, queue.length);
      let turn = 0;

      const worker = async () => {
        while (queue.length) {
          const chunkHash = queue.shift();
          let got = false;
          for (let i = 0; i < peers.length && !got; i++) {
            const peerId = peers[(turn++ + i) % peers.length]; // spread load across seeders
            try {
              const r = await this.sendRequest(peerId, { type: 'GET_CHUNK', chunkHash });
              if (r.chunk) {
                this.videoStore.storeChunk(chunkHash, Buffer.from(r.chunk, 'base64')); // verifies sha256
                got = true;
              }
            } catch (e) { /* next seeder */ }
          }
          if (got) {
            downloaded++;
            onProgress?.({ downloaded, total, percent: Math.round((downloaded / total) * 100) });
          } else {
            failures.set(chunkHash, (failures.get(chunkHash) || 0) + 1);
            if (failures.get(chunkHash) < 3) queue.push(chunkHash);
          }
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));
      this.videoStore.saveIndex();
    }

    const stillMissing = this.videoStore.getMissingChunks(videoId);
    if (stillMissing.length) throw new Error(`Failed to download ${stillMissing.length} chunks`);
    if (!this.videoStore.verifyComplete(videoId)) throw new Error('Video content hash mismatch');

    this.videoStore.markAsSeeding(videoId);
    this.videoStore.touch(videoId);
    this.announceSeeding(video); // every viewer becomes a seeder
    return video;
  }

  // ─────────────────────────────────────────────────────────────
  // EVICTION — drop our copy once plenty of other PCs have it
  // ─────────────────────────────────────────────────────────────
  evictionSettings() {
    const st = this.videoStore.store;
    return {
      safeCopies: st?.get('videoSafeCopies', 10) ?? 10,      // never delete below this many OTHER copies
      plentyCopies: st?.get('videoPlentyCopies', 25) ?? 25,  // "lots of people have it"
      idleMs: st?.get('videoIdleMs', 7 * 24 * 3600 * 1000) ?? 7 * 24 * 3600 * 1000,
      protectMs: st?.get('videoProtectMs', 24 * 3600 * 1000) ?? 24 * 3600 * 1000 // keep anything watched in last 24h
    };
  }

  /**
   * DHT provider records can't be retracted and linger ~48h, so a record does
   * NOT mean the peer still has the video. Count only peers that are online
   * right now AND report holding every chunk.
   */
  async countLiveSeeders(video, needed) {
    if (!this.discovery) return 0;
    const provs = await this.discovery.findProviders('video:' + video.id, { max: needed * 2 });
    let live = 0;
    for (const prov of provs) {
      if (live >= needed) break;
      try {
        if (!(await this.discovery.connect(prov))) continue;
        const r = await this.sendRequest(prov.id.toString(), { type: 'GET_AVAILABLE_CHUNKS', videoId: video.id });
        if (Array.isArray(r.chunks) && r.chunks.length === video.chunkHashes.length) live++;
      } catch (e) { /* offline / not holding */ }
    }
    return live;
  }

  /**
   * Decide which local copies are safe to delete.
   *  - storage over 90% of quota → delete best-seeded videos (≥ safeCopies others) until < 80%
   *  - or a video has ≥ plentyCopies other seeders and nobody here watched it for idleMs
   */
  async evictionPass() {
    const vs = this.videoStore;
    const cfg = this.evictionSettings();
    const quota = this.quotaBytes();
    const now = Date.now();
    const evicted = [];

    const candidates = vs.getSeedingVideos().filter((v) => now - (v.lastWatched || v.uploadedAt || 0) > cfg.protectMs);
    const counted = [];
    for (const v of candidates) {
      // Need up to plentyCopies confirmations; fewer is fine if we only check safeCopies
      const others = await this.countLiveSeeders(v, cfg.plentyCopies);
      counted.push({ v, others });
    }
    counted.sort((a, b) => b.others - a.others); // most-seeded first

    for (const { v, others } of counted) {
      const pressure = vs.getUsedBytes() > quota * 0.9;
      const plentyAndIdle = others >= cfg.plentyCopies && now - (v.lastWatched || v.uploadedAt || 0) > cfg.idleMs;
      if ((pressure && others >= cfg.safeCopies) || plentyAndIdle) {
        vs.removeLocalCopy(v.id);
        this.discovery?.unprovide('video:' + v.id);
        evicted.push({ id: v.id, title: v.title, otherCopies: others, reason: pressure ? 'disk quota' : 'plenty of seeders' });
        console.log(`[Video] Freed space: dropped "${v.title}" (${others} other PCs still have it)`);
      }
      if (!pressure && evicted.length && vs.getUsedBytes() < quota * 0.8) break;
    }
    return evicted;
  }

  /**
   * Send request to peer
   */
  async sendRequest(peerId, request, timeout = 30000) {
    const stream = await this.node.dialProtocol(peerId, VIDEO_PROTOCOL);
    
    await stream.sink([Buffer.from(JSON.stringify(request))]);
    
    const chunks = [];
    for await (const chunk of stream.source) {
      chunks.push(Buffer.from(chunk.subarray()));
    }
    
    return JSON.parse(Buffer.concat(chunks).toString());
  }
}

module.exports = { VideoProtocol, VIDEO_PROTOCOL, VIDEO_TOPIC, VIDEO_SYNC_PROTOCOL };
