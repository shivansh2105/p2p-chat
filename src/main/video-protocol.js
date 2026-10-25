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

  /**
   * Search for videos across the network
   */
  async searchNetwork(query) {
    const localResults = this.videoStore.searchVideos(query);
    const networkResults = [];

    // Query connected peers
    const peers = this.node.getPeers();
    const requests = peers.slice(0, 5).map(async (peerId) => {
      try {
        const response = await this.sendRequest(peerId, {
          type: 'SEARCH',
          query
        });
        if (response.results) {
          networkResults.push(...response.results);
        }
      } catch (e) {
        // Peer didn't respond
      }
    });

    await Promise.allSettled(requests);

    // Dedupe and merge results
    const seen = new Set(localResults.map(v => v.id));
    const combined = [...localResults];
    
    for (const video of networkResults) {
      if (!seen.has(video.id)) {
        seen.add(video.id);
        combined.push(video);
        if (Array.isArray(video.chunkHashes) && video.contentHash?.slice(0, 16) === video.id) {
          this.videoStore.addVideoFromNetwork(video);
        }
      }
    }

    return combined;
  }

  /**
   * Download a video from the network
   */
  async downloadVideo(videoId, onProgress) {
    const video = this.videoStore.getVideo(videoId);
    if (!video) {
      throw new Error('Video not found - search first');
    }

    const missing = this.videoStore.getMissingChunks(videoId);
    if (missing.length === 0) {
      return video; // Already have it
    }

    const total = video.chunkHashes.length;
    let downloaded = total - missing.length;

    // Find peers that have chunks
    const peers = this.node.getPeers();
    
    for (const chunkHash of missing) {
      // Try each peer until we get the chunk
      for (const peerId of peers) {
        try {
          const response = await this.sendRequest(peerId, {
            type: 'GET_CHUNK',
            chunkHash
          });

          if (response.chunk) {
            const data = Buffer.from(response.chunk, 'base64');
            this.videoStore.storeChunk(chunkHash, data);
            downloaded++;
            
            if (onProgress) {
              onProgress({
                downloaded,
                total,
                percent: Math.round((downloaded / total) * 100)
              });
            }
            break; // Got it, move to next chunk
          }
        } catch (e) {
          // Try next peer
        }
      }
    }

    // Check if complete
    const stillMissing = this.videoStore.getMissingChunks(videoId);
    if (stillMissing.length === 0) {
      if (!this.videoStore.verifyComplete(videoId)) throw new Error('Video content hash mismatch');
      this.videoStore.markAsSeeding(videoId);
      return video;
    } else {
      throw new Error(`Failed to download ${stillMissing.length} chunks`);
    }
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
