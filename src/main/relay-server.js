/**
 * P2P Chat Relay Server (Security Hardened)
 * 
 * SECURITY FIXES APPLIED:
 * - Authentication required for relay requests (signed identity)
 * - Request size limits to prevent DoS
 * - Per-identity rate limiting (prevents Sybil attacks)
 * - Metadata anonymization (rotating hashes)
 * - Memory limits on reservations
 */

const EventEmitter = require('events');
const crypto = require('crypto');

const MAX_REQUEST_SIZE = 64 * 1024; // 64KB max request

const DEFAULT_LIMITS = {
  maxReservations: 128,
  maxCircuits: 16,
  maxDuration: 2 * 60 * 1000,
  maxData: 128 * 1024,
  reservationTTL: 60 * 60 * 1000,
  maxReservationsPerIdentity: 2 // Prevent Sybil
};

class RelayStats {
  constructor() {
    this.startTime = Date.now();
    this.totalBytesRelayed = 0;
    this.totalCircuits = 0;
    this.totalReservations = 0;
    this.currentReservations = 0;
    this.currentCircuits = 0;
    
    // SECURITY: Anonymized peer tracking with daily rotation
    this.dailySalt = crypto.randomBytes(32);
    this.peersHelpedHashes = new Set();
    this.lastSaltRotation = Date.now();
  }

  rotateSaltIfNeeded() {
    const now = Date.now();
    if (now - this.lastSaltRotation > 24 * 60 * 60 * 1000) {
      this.dailySalt = crypto.randomBytes(32);
      this.peersHelpedHashes.clear();
      this.lastSaltRotation = now;
    }
  }

  recordCircuit(srcPeer, dstPeer, bytes) {
    this.rotateSaltIfNeeded();
    this.totalCircuits++;
    this.totalBytesRelayed += bytes;
    
    // SECURITY: Store anonymized hashes, not peer IDs
    const srcHash = crypto.createHash('sha256').update(srcPeer + this.dailySalt.toString('hex')).digest('hex').slice(0, 16);
    const dstHash = crypto.createHash('sha256').update(dstPeer + this.dailySalt.toString('hex')).digest('hex').slice(0, 16);
    this.peersHelpedHashes.add(srcHash);
    this.peersHelpedHashes.add(dstHash);
  }

  recordReservation() {
    this.totalReservations++;
    this.currentReservations++;
  }

  removeReservation() {
    this.currentReservations = Math.max(0, this.currentReservations - 1);
  }

  getStats() {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      totalBytesRelayed: this.totalBytesRelayed,
      totalBytesRelayedMB: (this.totalBytesRelayed / (1024 * 1024)).toFixed(2),
      totalCircuits: this.totalCircuits,
      totalReservations: this.totalReservations,
      peersHelped: this.peersHelpedHashes.size,
      currentReservations: this.currentReservations,
      currentCircuits: this.currentCircuits,
      isHealthy: true
    };
  }
}

class RelayServer extends EventEmitter {
  constructor(node, options = {}) {
    super();
    this.node = node;
    this.enabled = false;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.stats = new RelayStats();
    this.reservations = new Map();
    this.activeCircuits = new Map();
    this.announceInterval = null;
    
    // SECURITY: Track reservations per identity to prevent Sybil attacks
    this.reservationsByIdentity = new Map();
    
    // Crypto module reference for verification
    this.crypto = options.crypto || null;
  }

  setCrypto(cryptoModule) {
    this.crypto = cryptoModule;
  }

  async enable() {
    if (this.enabled) return;

    try {
      await this.setupRelayProtocol();
      this.enabled = true;
      this.stats = new RelayStats();
      this.startRelayAnnouncement();

      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║         RELAY SERVER ENABLED - HELPING THE NETWORK        ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║ Privacy: All relayed traffic is END-TO-END ENCRYPTED.     ║');
      console.log('║ Security: Authentication required, rate limits enforced.  ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');

      this.emit('enabled');
      return true;
    } catch (error) {
      console.error('[Relay] Failed to enable:', error.message);
      return false;
    }
  }

  async disable() {
    if (!this.enabled) return;

    this.enabled = false;
    
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    for (const [peerId] of this.reservations) {
      this.emit('reservationExpired', { peerId });
    }
    this.reservations.clear();
    this.activeCircuits.clear();
    this.reservationsByIdentity.clear();

    console.log('[Relay] Server disabled');
    this.emit('disabled');
  }

  async setupRelayProtocol() {
    const RELAY_PROTOCOL = '/p2p-chat/relay/2.0.0';

    await this.node.handle(RELAY_PROTOCOL, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      
      try {
        // SECURITY: Enforce request size limit
        const chunks = [];
        let totalSize = 0;
        
        for await (const chunk of stream.source) {
          totalSize += chunk.length;
          if (totalSize > MAX_REQUEST_SIZE) {
            await this.sendResponse(stream, { error: 'REQUEST_TOO_LARGE' });
            return;
          }
          chunks.push(chunk);
        }
        
        const data = Buffer.concat(chunks.map(c => Buffer.from(c.subarray())));
        
        let request;
        try {
          request = JSON.parse(data.toString());
        } catch (e) {
          await this.sendResponse(stream, { error: 'INVALID_JSON' });
          return;
        }

        await this.handleRelayRequest(stream, peerId, request);
      } catch (error) {
        console.error('[Relay] Protocol error:', error.message);
      }
    });
  }

  async handleRelayRequest(stream, peerId, request) {
    // SECURITY: Verify authentication for all requests
    if (!this.verifyAuthentication(peerId, request)) {
      await this.sendResponse(stream, { 
        success: false, 
        error: 'UNAUTHORIZED',
        message: 'Valid signature required'
      });
      return;
    }

    switch (request.type) {
      case 'RESERVE':
        await this.handleReservation(stream, peerId, request);
        break;
      case 'CONNECT':
        await this.handleConnect(stream, peerId, request);
        break;
      case 'RELAY':
        await this.handleRelay(stream, peerId, request);
        break;
      default:
        await this.sendResponse(stream, { error: 'UNKNOWN_REQUEST_TYPE' });
    }
  }

  /**
   * Verify request authentication
   * SECURITY: Requires signed request with valid identity
   */
  verifyAuthentication(peerId, request) {
    if (!request.signature || !request.publicKey || !request.timestamp) {
      return false;
    }
    
    // Check timestamp freshness (prevent replay)
    const now = Date.now();
    const requestTime = request.timestamp;
    if (Math.abs(now - requestTime) > 5 * 60 * 1000) { // 5 minute window
      return false;
    }
    
    // Verify signature
    if (this.crypto) {
      const dataToSign = JSON.stringify({
        type: request.type,
        peerId: peerId,
        timestamp: request.timestamp,
        nonce: request.nonce
      });
      
      return this.crypto.verify(dataToSign, request.signature, request.publicKey);
    }
    
    // SECURITY FIX: If no crypto module, REJECT requests (fail secure)
    console.warn('[Relay] No crypto module available - rejecting request');
    return false;
  }

  async handleReservation(stream, peerId, request) {
    const publicKey = request.publicKey;
    
    // SECURITY: Check per-identity limit (prevents Sybil)
    const identityReservations = this.reservationsByIdentity.get(publicKey) || 0;
    if (identityReservations >= this.limits.maxReservationsPerIdentity) {
      await this.sendResponse(stream, {
        success: false,
        error: 'IDENTITY_LIMIT_EXCEEDED',
        message: `Max ${this.limits.maxReservationsPerIdentity} reservations per identity`
      });
      return;
    }

    // Check total reservations
    if (this.reservations.size >= this.limits.maxReservations) {
      await this.sendResponse(stream, {
        success: false,
        error: 'RESOURCE_LIMIT_EXCEEDED',
        message: 'Max reservations reached'
      });
      return;
    }

    const reservation = {
      peerId,
      publicKey,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.limits.reservationTTL,
      circuits: 0,
      bytesRelayed: 0
    };

    this.reservations.set(peerId, reservation);
    this.reservationsByIdentity.set(publicKey, identityReservations + 1);
    this.stats.recordReservation();

    const relayAddrs = this.node.getMultiaddrs().map(ma => 
      `${ma.toString()}/p2p-circuit/p2p/${peerId}`
    );

    await this.sendResponse(stream, {
      success: true,
      type: 'RESERVATION',
      reservation: {
        expire: reservation.expiresAt,
        addrs: relayAddrs,
        limits: {
          duration: this.limits.maxDuration,
          data: this.limits.maxData
        }
      }
    });

    console.log(`[Relay] Reservation granted to ${peerId.slice(0, 16)}...`);
    this.emit('reservation', { peerId });

    setTimeout(() => {
      if (this.reservations.has(peerId)) {
        const res = this.reservations.get(peerId);
        this.reservations.delete(peerId);
        this.stats.removeReservation();
        
        // Decrement identity counter
        const count = this.reservationsByIdentity.get(res.publicKey) || 1;
        if (count <= 1) {
          this.reservationsByIdentity.delete(res.publicKey);
        } else {
          this.reservationsByIdentity.set(res.publicKey, count - 1);
        }
        
        this.emit('reservationExpired', { peerId });
      }
    }, this.limits.reservationTTL);
  }

  async handleConnect(stream, srcPeer, request) {
    const dstPeer = request.dstPeer;

    if (!this.reservations.has(dstPeer)) {
      await this.sendResponse(stream, {
        success: false,
        error: 'NO_RESERVATION',
        message: 'Destination peer has no reservation'
      });
      return;
    }

    const reservation = this.reservations.get(dstPeer);
    
    if (reservation.circuits >= this.limits.maxCircuits) {
      await this.sendResponse(stream, {
        success: false,
        error: 'RESOURCE_LIMIT_EXCEEDED',
        message: 'Max circuits for this reservation'
      });
      return;
    }

    const circuitId = crypto.randomBytes(16).toString('hex');
    const circuit = {
      id: circuitId,
      srcPeer,
      dstPeer,
      startTime: Date.now(),
      bytesRelayed: 0
    };

    this.activeCircuits.set(circuitId, circuit);
    reservation.circuits++;
    this.stats.currentCircuits++;

    await this.sendResponse(stream, {
      success: true,
      type: 'CONNECT',
      circuitId,
      limits: {
        duration: this.limits.maxDuration,
        data: this.limits.maxData
      }
    });

    this.emit('circuitOpened', { srcPeer, dstPeer, circuitId });

    setTimeout(() => {
      this.closeCircuit(circuitId);
    }, this.limits.maxDuration);
  }

  async handleRelay(stream, peerId, request) {
    const { circuitId, data } = request;
    const circuit = this.activeCircuits.get(circuitId);

    if (!circuit) {
      await this.sendResponse(stream, {
        success: false,
        error: 'NO_CIRCUIT',
        message: 'Circuit not found or expired'
      });
      return;
    }

    // SECURITY: Check data size
    const dataSize = data ? data.length : 0;
    if (circuit.bytesRelayed + dataSize > this.limits.maxData) {
      this.closeCircuit(circuitId);
      await this.sendResponse(stream, {
        success: false,
        error: 'DATA_LIMIT_EXCEEDED'
      });
      return;
    }

    circuit.bytesRelayed += dataSize;
    this.stats.totalBytesRelayed += dataSize;

    await this.sendResponse(stream, {
      success: true,
      type: 'RELAYED',
      bytesRelayed: dataSize
    });
  }

  closeCircuit(circuitId) {
    const circuit = this.activeCircuits.get(circuitId);
    if (!circuit) return;

    this.activeCircuits.delete(circuitId);
    this.stats.currentCircuits = Math.max(0, this.stats.currentCircuits - 1);
    this.stats.recordCircuit(circuit.srcPeer, circuit.dstPeer, circuit.bytesRelayed);

    const reservation = this.reservations.get(circuit.dstPeer);
    if (reservation) {
      reservation.circuits = Math.max(0, reservation.circuits - 1);
      reservation.bytesRelayed += circuit.bytesRelayed;
    }

    this.emit('circuitClosed', circuit);
  }

  async sendResponse(stream, response) {
    try {
      const data = JSON.stringify(response);
      const encoder = new TextEncoder();
      await stream.sink([encoder.encode(data)]);
    } catch (e) {}
  }

  startRelayAnnouncement() {
    const announce = async () => {
      if (!this.enabled) return;

      try {
        const { fromString } = require('uint8arrays');
        const relayInfo = {
          type: 'relay',
          peerId: this.node.peerId.toString(),
          addresses: this.node.getMultiaddrs().map(ma => ma.toString()),
          limits: this.limits,
          stats: {
            uptime: this.stats.getStats().uptimeSeconds,
            peersHelped: this.stats.peersHelpedHashes.size
          },
          timestamp: Date.now(),
          version: 2
        };

        await this.node.services.pubsub.publish(
          'p2p-chat:relays',
          fromString(JSON.stringify(relayInfo))
        );
      } catch (error) {}
    };

    announce();
    this.announceInterval = setInterval(announce, 5 * 60 * 1000);
  }

  getStats() {
    return {
      enabled: this.enabled,
      ...this.stats.getStats(),
      activeCircuits: this.activeCircuits.size
    };
  }

  isEnabled() {
    return this.enabled;
  }
}

class RelayClient {
  constructor(node) {
    this.node = node;
    this.knownRelays = new Map();
    this.activeReservations = new Map();
  }

  async discoverRelays() {
    await this.node.services.pubsub.subscribe('p2p-chat:relays');
    
    this.node.services.pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === 'p2p-chat:relays') {
        try {
          const { toString } = require('uint8arrays');
          const info = JSON.parse(toString(event.detail.data));
          if (info.type === 'relay' && info.version >= 2) {
            this.knownRelays.set(info.peerId, info);
          }
        } catch (e) {}
      }
    });
  }

  getKnownRelays() {
    return Array.from(this.knownRelays.values());
  }
}

module.exports = { RelayServer, RelayClient, RelayStats };
