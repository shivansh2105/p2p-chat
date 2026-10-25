/**
 * P2P Video Store - YouTube meets BitTorrent
 * 
 * Videos are chunked, distributed across peers, and streamable.
 * More viewers = more seeders = faster streaming.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const CHUNK_SIZE = 256 * 1024; // 256KB chunks (like torrent pieces)
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB max
const VIDEO_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

class VideoStore extends EventEmitter {
  constructor(dataDir, store) {
    super();
    this.dataDir = path.join(dataDir, 'videos');
    this.store = store;
    this.videos = new Map(); // videoId -> metadata
    this.chunks = new Map(); // chunkHash -> chunk data
    this.seeding = new Set(); // videoIds we're seeding
    
    // Ensure directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    this.loadIndex();
  }

  /**
   * Upload a video - chunks it and makes it available
   */
  async uploadVideo(filePath, metadata) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_VIDEO_SIZE) {
      throw new Error(`Video too large. Max ${MAX_VIDEO_SIZE / 1024 / 1024}MB`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const chunks = this.chunkFile(fileBuffer);
    
    // Generate video ID from content hash
    const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const videoId = contentHash.slice(0, 16);
    
    // Store chunks locally
    const chunkHashes = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
      chunkHashes.push(chunkHash);
      
      // Save chunk to disk
      const chunkPath = path.join(this.dataDir, `${chunkHash}.chunk`);
      fs.writeFileSync(chunkPath, chunk);
      this.chunks.set(chunkHash, chunkPath);
    }

    // Create video metadata
    const video = {
      id: videoId,
      title: metadata.title || 'Untitled',
      description: metadata.description || '',
      tags: metadata.tags || [],
      uploader: metadata.uploader,
      uploaderName: metadata.uploaderName,
      duration: metadata.duration || 0,
      size: stat.size,
      chunkSize: CHUNK_SIZE,
      chunkCount: chunks.length,
      chunkHashes,
      contentHash,
      mimeType: this.getMimeType(filePath),
      thumbnail: metadata.thumbnail || null,
      uploadedAt: Date.now(),
      views: 0,
      seeders: 1
    };

    this.videos.set(videoId, video);
    this.seeding.add(videoId);
    this.saveIndex();

    this.emit('videoUploaded', video);
    console.log(`[VideoStore] Uploaded: ${video.title} (${chunks.length} chunks)`);
    
    return video;
  }

  /**
   * Split file into chunks
   */
  chunkFile(buffer) {
    const chunks = [];
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      chunks.push(buffer.subarray(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  /**
   * Get a specific chunk (for serving to peers)
   */
  getChunk(chunkHash) {
    const chunkPath = this.chunks.get(chunkHash);
    if (!chunkPath || !fs.existsSync(chunkPath)) {
      return null;
    }
    return fs.readFileSync(chunkPath);
  }

  /**
   * Check if we have a chunk
   */
  hasChunk(chunkHash) {
    const chunkPath = this.chunks.get(chunkHash);
    return chunkPath && fs.existsSync(chunkPath);
  }

  /**
   * Store a chunk received from another peer
   */
  storeChunk(chunkHash, data) {
    // Verify hash
    const actualHash = crypto.createHash('sha256').update(data).digest('hex');
    if (actualHash !== chunkHash) {
      throw new Error('Chunk hash mismatch');
    }

    const chunkPath = path.join(this.dataDir, `${chunkHash}.chunk`);
    fs.writeFileSync(chunkPath, data);
    this.chunks.set(chunkHash, chunkPath);
    
    return true;
  }

  /**
   * Get video metadata
   */
  getVideo(videoId) {
    return this.videos.get(videoId);
  }

  /**
   * Search videos by title/tags
   */
  searchVideos(query) {
    const q = query.toLowerCase();
    const results = [];
    
    for (const video of this.videos.values()) {
      const titleMatch = video.title.toLowerCase().includes(q);
      const tagMatch = video.tags.some(t => t.toLowerCase().includes(q));
      const descMatch = video.description.toLowerCase().includes(q);
      
      if (titleMatch || tagMatch || descMatch) {
        results.push(video);
      }
    }
    
    return results.sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  /**
   * Get all videos we're seeding
   */
  getSeedingVideos() {
    return Array.from(this.seeding)
      .map(id => this.videos.get(id))
      .filter(Boolean);
  }

  /**
   * Get all videos we know about
   */
  getAllVideos() {
    return Array.from(this.videos.values())
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  /**
   * Add video metadata from network (for discovery)
   */
  addVideoFromNetwork(video) {
    if (!this.videos.has(video.id)) {
      this.videos.set(video.id, {
        ...video,
        isLocal: false,
        seeders: video.seeders || 1
      });
      this.saveIndex();
      this.emit('videoDiscovered', video);
    }
  }

  /**
   * Record that we have all chunks for a video (we can seed it)
   */
  markAsSeeding(videoId) {
    this.seeding.add(videoId);
    const video = this.videos.get(videoId);
    if (video) {
      video.seeders = (video.seeders || 0) + 1;
    }
    this.saveIndex();
  }

  /**
   * Get chunks we have for a video (for partial seeding)
   */
  getAvailableChunks(videoId) {
    const video = this.videos.get(videoId);
    if (!video) return [];
    
    return video.chunkHashes.filter(hash => this.hasChunk(hash));
  }

  /**
   * Get chunks we're missing
   */
  getMissingChunks(videoId) {
    const video = this.videos.get(videoId);
    if (!video) return [];
    
    return video.chunkHashes.filter(hash => !this.hasChunk(hash));
  }

  /**
   * Assemble video from chunks
   */
  assembleVideo(videoId) {
    const video = this.videos.get(videoId);
    if (!video) return null;
    
    const missing = this.getMissingChunks(videoId);
    if (missing.length > 0) {
      throw new Error(`Missing ${missing.length} chunks`);
    }

    const chunks = video.chunkHashes.map(hash => this.getChunk(hash));
    return Buffer.concat(chunks);
  }

  /**
   * Save video to file
   */
  saveVideoToFile(videoId, outputPath) {
    const buffer = this.assembleVideo(videoId);
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
  }

  /**
   * Get stats
   */
  getStats() {
    let totalSize = 0;
    for (const video of this.videos.values()) {
      if (this.seeding.has(video.id)) {
        totalSize += video.size;
      }
    }

    return {
      videosKnown: this.videos.size,
      videosSeeding: this.seeding.size,
      chunksStored: this.chunks.size,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
  }

  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.m4v': 'video/mp4'
    };
    return types[ext] || 'video/mp4';
  }

  saveIndex() {
    if (!this.store) return;
    
    const data = {
      videos: Object.fromEntries(this.videos),
      chunks: Object.fromEntries(this.chunks),
      seeding: Array.from(this.seeding)
    };
    this.store.set('videoIndex', data);
  }

  loadIndex() {
    if (!this.store) return;
    
    const data = this.store.get('videoIndex', {});
    
    if (data.videos) {
      for (const [id, video] of Object.entries(data.videos)) {
        this.videos.set(id, video);
      }
    }
    
    if (data.chunks) {
      for (const [hash, path] of Object.entries(data.chunks)) {
        if (fs.existsSync(path)) {
          this.chunks.set(hash, path);
        }
      }
    }
    
    if (data.seeding) {
      for (const id of data.seeding) {
        this.seeding.add(id);
      }
    }
    
    console.log(`[VideoStore] Loaded ${this.videos.size} videos, seeding ${this.seeding.size}`);
  }

  /**
   * Cleanup old videos
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, video] of this.videos.entries()) {
      if (!video.isLocal && (now - video.uploadedAt) > VIDEO_TTL) {
        // Remove chunks
        for (const hash of video.chunkHashes) {
          const chunkPath = this.chunks.get(hash);
          if (chunkPath && fs.existsSync(chunkPath)) {
            fs.unlinkSync(chunkPath);
          }
          this.chunks.delete(hash);
        }
        this.videos.delete(id);
        this.seeding.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[VideoStore] Cleaned ${cleaned} expired videos`);
      this.saveIndex();
    }
  }
}

module.exports = { VideoStore, CHUNK_SIZE };
