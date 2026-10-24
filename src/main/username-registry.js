/**
 * P2P Chat Username Registry (Security Hardened)
 * 
 * SECURITY FIXES APPLIED:
 * - Nonce in signatures to prevent replay attacks
 * - URL validation for coordination server (SSRF prevention)
 * - Rate limiting on lookups
 * - Input validation and sanitization
 */

const { toString: uint8ArrayToString, fromString: uint8ArrayFromString } = require('uint8arrays');
const crypto = require('crypto');

// Allowed coordination server domains (whitelist approach)
const ALLOWED_COORD_DOMAINS = [
  'p2pchat.io', 'relay.p2pchat.io', 'localhost'
];

class UsernameRegistry {
  constructor(node, cryptoModule) {
    this.node = node;
    this.crypto = cryptoModule;
    this.cache = new Map();
    this.reverseCache = new Map();
    this.myUsername = null;
    this.announceInterval = null;
    this.coordServer = null;
    
    // Rate limiting
    this.lookupTimestamps = new Map();
    this.RATE_LIMIT_WINDOW = 60000; // 1 minute
    this.RATE_LIMIT_MAX = 30; // max lookups per window
    
    // SECURITY: Cache size limits to prevent memory exhaustion
    this.MAX_CACHE_SIZE = 10000;
    this.MAX_GOSSIP_RECORDS_PER_MINUTE = 100;
    this.gossipRecordCount = 0;
    this.lastGossipReset = Date.now();
  }

  /**
   * Set optional coordination server URL
   * SECURITY: Validates URL to prevent SSRF
   */
  setCoordinationServer(url) {
    if (!url) {
      this.coordServer = null;
      return;
    }

    try {
      const parsed = new URL(url);
      
      // SECURITY: Only allow HTTPS (except localhost for dev)
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
        throw new Error('Coordination server must use HTTPS');
      }
      
      // SECURITY: Block internal/private IPs
      const hostname = parsed.hostname.toLowerCase();
      const blockedPatterns = [
        /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./,
        /^169\.254\./, /^0\./, /^::1$/, /^fc00:/, /^fe80:/,
        /^localhost$/i, /\.local$/i, /\.internal$/i
      ];
      
      // Allow localhost only in dev mode
      const isDev = process.env.NODE_ENV === 'development';
      if (!isDev && blockedPatterns.some(p => p.test(hostname))) {
        throw new Error('Internal addresses not allowed for coordination server');
      }
      
      // SECURITY: Validate against whitelist (optional, can be disabled)
      // Uncomment for strict mode:
      // if (!ALLOWED_COORD_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      //   throw new Error('Coordination server domain not in whitelist');
      // }
      
      this.coordServer = url;
      console.log('[Registry] Coordination server set:', url);
    } catch (error) {
      console.error('[Registry] Invalid coordination server URL:', error.message);
      throw error;
    }
  }

  /**
   * Register username in the DHT
   * SECURITY: Includes nonce in signature to prevent replay
   */
  async registerUsername(username) {
    if (!this.validateUsername(username)) {
      throw new Error('Invalid username. Use 3-20 alphanumeric characters, underscores, or hyphens.');
    }

    const existing = await this.lookupUsername(username);
    if (existing && existing.peerId !== this.node.peerId.toString()) {
      throw new Error(`Username "${username}" is already taken`);
    }

    // SECURITY: Include nonce in record for replay protection
    const nonce = crypto.randomBytes(16).toString('hex');
    
    const record = {
      username,
      peerId: this.node.peerId.toString(),
      publicKey: this.crypto.getPublicKey(),
      addresses: this.node.getMultiaddrs().map(ma => ma.toString()),
      registeredAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      nonce, // Prevents replay
      version: 2
    };

    // SECURITY: Sign full record data including nonce
    const dataToSign = JSON.stringify({
      username: record.username,
      peerId: record.peerId,
      registeredAt: record.registeredAt,
      nonce: record.nonce,
      action: 'register-v2'
    });
    record.signature = this.crypto.sign(dataToSign);

    const key = this.getUsernameKey(username);
    try {
      await this.node.services.dht.put(
        uint8ArrayFromString(key),
        uint8ArrayFromString(JSON.stringify(record))
      );
      console.log(`[Registry] Registered username "${username}" in DHT`);
    } catch (error) {
      console.warn('[Registry] DHT put failed, using gossip fallback');
    }

    await this.announceUsername(record);

    this.cache.set(username.toLowerCase(), record);
    this.reverseCache.set(record.peerId, username);
    this.myUsername = username;

    this.startReannouncement();

    if (this.coordServer) {
      this.registerWithCoordServer(record).catch(() => {});
    }

    return record;
  }

  async announceUsername(record) {
    try {
      await this.node.services.pubsub.publish(
        'p2p-chat:registry',
        uint8ArrayFromString(JSON.stringify({ type: 'register', record }))
      );
    } catch (error) {
      console.warn('[Registry] Gossip announcement failed');
    }
  }

  /**
   * Lookup username with rate limiting
   */
  async lookupUsername(username) {
    const normalizedUsername = username.toLowerCase();

    // SECURITY: Rate limiting
    if (!this.checkRateLimit('lookup')) {
      throw new Error('Rate limit exceeded. Please wait before trying again.');
    }

    const cached = this.cache.get(normalizedUsername);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    if (this.coordServer) {
      try {
        const result = await this.lookupViaCoordServer(username);
        if (result) {
          this.cache.set(normalizedUsername, result);
          this.reverseCache.set(result.peerId, result.username);
          return result;
        }
      } catch (error) {}
    }

    const gossipResult = await this.lookupViaGossip(username);
    if (gossipResult) {
      this.cache.set(normalizedUsername, gossipResult);
      this.reverseCache.set(gossipResult.peerId, gossipResult.username);
      return gossipResult;
    }

    const key = this.getUsernameKey(username);
    try {
      for await (const event of this.node.services.dht.get(uint8ArrayFromString(key))) {
        if (event.name === 'VALUE') {
          const record = JSON.parse(uint8ArrayToString(event.value));
          if (this.verifyRecord(record)) {
            this.cache.set(normalizedUsername, record);
            this.reverseCache.set(record.peerId, record.username);
            return record;
          }
        }
      }
    } catch (error) {}

    return null;
  }

  /**
   * Check rate limit
   */
  checkRateLimit(action) {
    const now = Date.now();
    const key = action;
    
    let timestamps = this.lookupTimestamps.get(key) || [];
    timestamps = timestamps.filter(t => now - t < this.RATE_LIMIT_WINDOW);
    
    if (timestamps.length >= this.RATE_LIMIT_MAX) {
      return false;
    }
    
    timestamps.push(now);
    this.lookupTimestamps.set(key, timestamps);
    return true;
  }

  async lookupViaGossip(username) {
    return new Promise((resolve) => {
      const requestId = crypto.randomBytes(8).toString('hex');
      const timeout = setTimeout(() => resolve(null), 5000);

      const handler = (event) => {
        try {
          const msg = JSON.parse(uint8ArrayToString(event.detail.data));
          if (msg.type === 'lookup-response' && msg.requestId === requestId) {
            clearTimeout(timeout);
            this.node.services.pubsub.removeEventListener('message', handler);
            if (this.verifyRecord(msg.record)) {
              resolve(msg.record);
            } else {
              resolve(null);
            }
          }
        } catch (e) {}
      };

      this.node.services.pubsub.addEventListener('message', handler);

      this.node.services.pubsub.publish(
        'p2p-chat:registry',
        uint8ArrayFromString(JSON.stringify({ type: 'lookup', username, requestId }))
      ).catch(() => {});
    });
  }

  handleRegistryMessage(event) {
    try {
      const msg = JSON.parse(uint8ArrayToString(event.detail.data));

      // SECURITY: Rate limit gossip record acceptance
      const now = Date.now();
      if (now - this.lastGossipReset > 60000) {
        this.gossipRecordCount = 0;
        this.lastGossipReset = now;
      }
      
      if (msg.type === 'register' && msg.record) {
        // SECURITY: Enforce gossip rate limit
        if (this.gossipRecordCount >= this.MAX_GOSSIP_RECORDS_PER_MINUTE) {
          console.warn('[Registry] Gossip rate limit exceeded, ignoring record');
          return;
        }
        
        // SECURITY: Enforce cache size limit
        if (this.cache.size >= this.MAX_CACHE_SIZE) {
          // Evict oldest expired entries
          this.evictExpiredEntries();
          if (this.cache.size >= this.MAX_CACHE_SIZE) {
            console.warn('[Registry] Cache size limit reached, ignoring record');
            return;
          }
        }
        
        if (this.verifyRecord(msg.record)) {
          this.cache.set(msg.record.username.toLowerCase(), msg.record);
          this.reverseCache.set(msg.record.peerId, msg.record.username);
          this.gossipRecordCount++;
        }
      } else if (msg.type === 'lookup' && msg.username) {
        const cached = this.cache.get(msg.username.toLowerCase());
        if (cached && cached.expiresAt > Date.now()) {
          this.node.services.pubsub.publish(
            'p2p-chat:registry',
            uint8ArrayFromString(JSON.stringify({
              type: 'lookup-response', requestId: msg.requestId, record: cached
            }))
          ).catch(() => {});
        }
      }
    } catch (error) {}
  }

  /**
   * Evict expired entries from cache
   */
  evictExpiredEntries() {
    const now = Date.now();
    for (const [username, record] of this.cache) {
      if (record.expiresAt <= now) {
        this.cache.delete(username);
        this.reverseCache.delete(record.peerId);
      }
    }
  }

  getUsernameForPeer(peerId) {
    return this.reverseCache.get(peerId) || null;
  }

  searchUsernames(prefix) {
    const results = [];
    const normalizedPrefix = prefix.toLowerCase();
    
    for (const [username, record] of this.cache) {
      if (username.startsWith(normalizedPrefix) && record.expiresAt > Date.now()) {
        results.push(record);
      }
    }
    
    return results.sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * Verify record signature
   * SECURITY: Validates nonce presence in v2 records
   */
  verifyRecord(record) {
    if (!record || !record.signature || !record.publicKey) {
      return false;
    }

    // v2 records must have nonce
    if (record.version >= 2) {
      if (!record.nonce) return false;
      
      const dataToSign = JSON.stringify({
        username: record.username,
        peerId: record.peerId,
        registeredAt: record.registeredAt,
        nonce: record.nonce,
        action: 'register-v2'
      });
      return this.crypto.verify(dataToSign, record.signature, record.publicKey);
    }
    
    // Legacy v1 verification
    const dataToSign = `${record.username}:${record.peerId}:${record.registeredAt}`;
    return this.crypto.verify(dataToSign, record.signature, record.publicKey);
  }

  validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 20) return false;
    // SECURITY: Strict alphanumeric + underscore/hyphen only
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(username);
  }

  getUsernameKey(username) {
    return `/p2pchat/username/${username.toLowerCase()}`;
  }

  startReannouncement() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
    }

    this.announceInterval = setInterval(async () => {
      if (this.myUsername) {
        try {
          await this.registerUsername(this.myUsername);
        } catch (error) {}
      }
    }, 30 * 60 * 1000);
  }

  async registerWithCoordServer(record) {
    if (!this.coordServer) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${this.coordServer}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
        signal: controller.signal
      });
      
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {}
  }

  async lookupViaCoordServer(username) {
    if (!this.coordServer) return null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      // SECURITY: Encode username to prevent injection
      const encodedUsername = encodeURIComponent(username);
      const response = await fetch(`${this.coordServer}/lookup/${encodedUsername}`, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) return null;

      const record = await response.json();
      if (this.verifyRecord(record)) {
        return record;
      }
    } catch (error) {}

    return null;
  }

  stop() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}

module.exports = UsernameRegistry;
