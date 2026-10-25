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
        duration: v.duration,
        size: v.size,
        uploader: v.uploaderName,
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
        this.videoStore.addVideoFromNetwork(data.video);
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

module.exports = { VideoProtocol, VIDEO_PROTOCOL, VIDEO_TOPIC };
