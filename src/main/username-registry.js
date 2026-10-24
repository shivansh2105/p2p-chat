/**
 * P2P Chat Username Registry
 * 
 * Implements a distributed naming system using DHT (like ENS for Ethereum)
 * Users register their username → publicKey mapping in the DHT
 * Anyone can lookup a username to find the user's public key and connection info
 * 
 * Architecture (Tailscale MagicDNS inspired):
 * - Usernames are stored as DHT records: /p2pchat/username/<name>
 * - Records contain: publicKey, peerId, lastSeen, signedByOwner
 * - Records expire after 24h and need re-announcement
 * - Optional: coordination server for faster lookups (not required)
 */

const { toString: uint8ArrayToString, fromString: uint8ArrayFromString } = require('uint8arrays');
const crypto = require('crypto');

class UsernameRegistry {
  constructor(node, cryptoModule) {
    this.node = node;
    this.crypto = cryptoModule;
    this.cache = new Map();        // Local cache: username -> record
    this.reverseCache = new Map(); // peerId -> username
    this.myUsername = null;
    
    // Re-announce interval (every 30 minutes)
    this.announceInterval = null;
    
    // Coordination server (optional, for faster lookups)
    this.coordServer = null;
  }

  /**
   * Set optional coordination server URL
   * Like Tailscale's controlplane.tailscale.com
   */
  setCoordinationServer(url) {
    this.coordServer = url;
    console.log('[Registry] Coordination server set:', url);
  }

  /**
   * Register username in the DHT
   * Creates a signed record that proves ownership
   */
  async registerUsername(username) {
    if (!this.validateUsername(username)) {
      throw new Error('Invalid username. Use 3-20 alphanumeric characters, underscores, or hyphens.');
    }

    // Check if username is already taken
    const existing = await this.lookupUsername(username);
    if (existing && existing.peerId !== this.node.peerId.toString()) {
      throw new Error(`Username "${username}" is already taken`);
    }

    // Create registration record
    const record = {
      username,
      peerId: this.node.peerId.toString(),
      publicKey: this.crypto.getPublicKey(),
      addresses: this.node.getMultiaddrs().map(ma => ma.toString()),
      registeredAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
      version: 1
    };

    // Sign the record (proves ownership)
    const dataToSign = `${record.username}:${record.peerId}:${record.registeredAt}`;
    record.signature = this.crypto.sign(dataToSign);

    // Store in DHT
    const key = this.getUsernameKey(username);
    try {
      await this.node.services.dht.put(
        uint8ArrayFromString(key),
        uint8ArrayFromString(JSON.stringify(record))
      );
      console.log(`[Registry] Registered username "${username}" in DHT`);
    } catch (error) {
      console.warn('[Registry] DHT put failed, using gossip fallback:', error.message);
    }

    // Also announce via GossipSub for faster propagation
    await this.announceUsername(record);

    // Cache locally
    this.cache.set(username.toLowerCase(), record);
    this.reverseCache.set(record.peerId, username);
    this.myUsername = username;

    // Start periodic re-announcement
    this.startReannouncement();

    // Register with coordination server if available
    if (this.coordServer) {
      this.registerWithCoordServer(record).catch(console.warn);
    }

    return record;
  }

  /**
   * Announce username registration via GossipSub
   */
  async announceUsername(record) {
    try {
      await this.node.services.pubsub.publish(
        'p2p-chat:registry',
        uint8ArrayFromString(JSON.stringify({
          type: 'register',
          record
        }))
      );
    } catch (error) {
      console.warn('[Registry] Gossip announcement failed:', error.message);
    }
  }

  /**
   * Lookup username in DHT/cache
   * Returns: { peerId, publicKey, addresses, ... } or null
   */
  async lookupUsername(username) {
    const normalizedUsername = username.toLowerCase();

    // Check local cache first
    const cached = this.cache.get(normalizedUsername);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    // Try coordination server for fast lookup
    if (this.coordServer) {
      try {
        const result = await this.lookupViaCoordServer(username);
        if (result) {
          this.cache.set(normalizedUsername, result);
          this.reverseCache.set(result.peerId, result.username);
          return result;
        }
      } catch (error) {
        console.warn('[Registry] Coord server lookup failed:', error.message);
      }
    }

    // Query via GossipSub (broadcast request)
    const gossipResult = await this.lookupViaGossip(username);
    if (gossipResult) {
      this.cache.set(normalizedUsername, gossipResult);
      this.reverseCache.set(gossipResult.peerId, gossipResult.username);
      return gossipResult;
    }

    // Try DHT lookup
    const key = this.getUsernameKey(username);
    try {
      for await (const event of this.node.services.dht.get(uint8ArrayFromString(key))) {
        if (event.name === 'VALUE') {
          const record = JSON.parse(uint8ArrayToString(event.value));
          
          // Verify signature
          if (this.verifyRecord(record)) {
            this.cache.set(normalizedUsername, record);
            this.reverseCache.set(record.peerId, record.username);
            return record;
          }
        }
      }
    } catch (error) {
      console.warn('[Registry] DHT lookup failed:', error.message);
    }

    return null;
  }

  /**
   * Lookup via GossipSub broadcast
   */
  async lookupViaGossip(username) {
    return new Promise((resolve) => {
      const requestId = crypto.randomBytes(8).toString('hex');
      const timeout = setTimeout(() => resolve(null), 5000);

      // Listen for response
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

      // Send lookup request
      this.node.services.pubsub.publish(
        'p2p-chat:registry',
        uint8ArrayFromString(JSON.stringify({
          type: 'lookup',
          username,
          requestId
        }))
      ).catch(console.warn);
    });
  }

  /**
   * Handle incoming registry messages
   */
  handleRegistryMessage(event) {
    try {
      const msg = JSON.parse(uint8ArrayToString(event.detail.data));

      if (msg.type === 'register' && msg.record) {
        // Cache registration announcements
        if (this.verifyRecord(msg.record)) {
          this.cache.set(msg.record.username.toLowerCase(), msg.record);
          this.reverseCache.set(msg.record.peerId, msg.record.username);
        }
      } else if (msg.type === 'lookup' && msg.username) {
        // Respond to lookup if we have the info
        const cached = this.cache.get(msg.username.toLowerCase());
        if (cached && cached.expiresAt > Date.now()) {
          this.node.services.pubsub.publish(
            'p2p-chat:registry',
            uint8ArrayFromString(JSON.stringify({
              type: 'lookup-response',
              requestId: msg.requestId,
              record: cached
            }))
          ).catch(console.warn);
        }
      }
    } catch (error) {
      // Ignore malformed messages
    }
  }

  /**
   * Get username for a peer ID (reverse lookup)
   */
  getUsernameForPeer(peerId) {
    return this.reverseCache.get(peerId) || null;
  }

  /**
   * Search usernames (prefix match)
   */
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
   */
  verifyRecord(record) {
    if (!record || !record.signature || !record.publicKey) {
      return false;
    }

    const dataToSign = `${record.username}:${record.peerId}:${record.registeredAt}`;
    return this.crypto.verify(dataToSign, record.signature, record.publicKey);
  }

  /**
   * Validate username format
   */
  validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 20) return false;
    return /^[a-zA-Z0-9_-]+$/.test(username);
  }

  /**
   * Get DHT key for username
   */
  getUsernameKey(username) {
    return `/p2pchat/username/${username.toLowerCase()}`;
  }

  /**
   * Start periodic re-announcement
   */
  startReannouncement() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
    }

    this.announceInterval = setInterval(async () => {
      if (this.myUsername) {
        try {
          await this.registerUsername(this.myUsername);
          console.log('[Registry] Re-announced username');
        } catch (error) {
          console.warn('[Registry] Re-announcement failed:', error.message);
        }
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }

  /**
   * Register with coordination server (optional)
   */
  async registerWithCoordServer(record) {
    if (!this.coordServer) return;

    try {
      const response = await fetch(`${this.coordServer}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      console.log('[Registry] Registered with coordination server');
    } catch (error) {
      console.warn('[Registry] Coord server registration failed:', error.message);
    }
  }

  /**
   * Lookup via coordination server
   */
  async lookupViaCoordServer(username) {
    if (!this.coordServer) return null;

    try {
      const response = await fetch(`${this.coordServer}/lookup/${encodeURIComponent(username)}`);
      
      if (!response.ok) {
        return null;
      }

      const record = await response.json();
      
      if (this.verifyRecord(record)) {
        return record;
      }
    } catch (error) {
      console.warn('[Registry] Coord server lookup failed:', error.message);
    }

    return null;
  }

  /**
   * Stop the registry (cleanup)
   */
  stop() {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
  }
}

module.exports = UsernameRegistry;
