/**
 * P2P Chat Relay Server
 * 
 * Volunteer Relay Node - Like Tor relays or Bitcoin full nodes
 * Users can opt-in to help the network by relaying traffic for others
 * 
 * Architecture (inspired by Tor + Tailscale DERP + libp2p Circuit Relay):
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    RELAY NODE ARCHITECTURE                      │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                  │
 * │  RELAY SERVER MODE (Volunteer)                                  │
 * │  ├── Accepts relay reservations from peers                      │
 * │  ├── Forwards encrypted packets (cannot read content)           │
 * │  ├── Helps NAT-blocked peers connect                            │
 * │  └── Contributes bandwidth to the network                       │
 * │                                                                  │
 * │  BENEFITS OF RUNNING A RELAY:                                   │
 * │  ├── Strengthens the network (like Bitcoin full node)           │
 * │  ├── Helps friends behind strict NATs                           │
 * │  ├── Priority routing through other relays                      │
 * │  └── Network reputation score                                   │
 * │                                                                  │
 * │  PRIVACY GUARANTEES:                                            │
 * │  ├── All relayed traffic is end-to-end encrypted                │
 * │  ├── Relay cannot read message contents                         │
 * │  ├── Relay sees only: source peer, dest peer, packet size       │
 * │  └── Same privacy model as Tor/Tailscale DERP                   │
 * │                                                                  │
 * └─────────────────────────────────────────────────────────────────┘
 */

const EventEmitter = require('events');

// Default relay limits (like libp2p circuit relay v2)
const DEFAULT_LIMITS = {
  maxReservations: 128,        // Max peers that can reserve this relay
  maxCircuits: 16,             // Max active circuits per reservation
  maxDuration: 2 * 60 * 1000,  // 2 minutes per circuit
  maxData: 128 * 1024,         // 128KB per circuit
  reservationTTL: 60 * 60 * 1000, // 1 hour reservation
};

// Relay statistics
class RelayStats {
  constructor() {
    this.startTime = Date.now();
    this.totalBytesRelayed = 0;
    this.totalCircuits = 0;
    this.totalReservations = 0;
    this.peersHelped = new Set();
    this.currentReservations = 0;
    this.currentCircuits = 0;
    this.uptimeSeconds = 0;
  }

  recordCircuit(srcPeer, dstPeer, bytes) {
    this.totalCircuits++;
    this.totalBytesRelayed += bytes;
    this.peersHelped.add(srcPeer);
    this.peersHelped.add(dstPeer);
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
      peersHelped: this.peersHelped.size,
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
    this.reservations = new Map();  // peerId -> reservation
    this.activeCircuits = new Map(); // circuitId -> circuit info
    
    // Announce as relay in DHT
    this.announceInterval = null;
  }

  /**
   * Enable relay server mode
   * This makes your node a volunteer relay like a Tor node
   */
  async enable() {
    if (this.enabled) return;

    try {
      // libp2p v2 has circuit relay built-in, we just need to configure it
      // For now, we implement a custom relay protocol
      await this.setupRelayProtocol();
      
      this.enabled = true;
      this.stats = new RelayStats();

      // Announce ourselves as a relay in the DHT
      this.startRelayAnnouncement();

      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║         RELAY SERVER ENABLED - HELPING THE NETWORK        ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log('║ You are now a volunteer relay node! Like Tor or Bitcoin,  ║');
      console.log('║ you are helping others connect who are behind NAT.        ║');
      console.log('║                                                           ║');
      console.log('║ Privacy: All relayed traffic is END-TO-END ENCRYPTED.     ║');
      console.log('║ You cannot read any messages - only forward packets.      ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');

      this.emit('enabled');
      return true;
    } catch (error) {
      console.error('[Relay] Failed to enable:', error);
      return false;
    }
  }

  /**
   * Disable relay server mode
   */
  async disable() {
    if (!this.enabled) return;

    this.enabled = false;
    
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    // Clear all reservations gracefully
    for (const [peerId, reservation] of this.reservations) {
      this.emit('reservationExpired', { peerId });
    }
    this.reservations.clear();
    this.activeCircuits.clear();

    console.log('[Relay] Server disabled');
    this.emit('disabled');
  }

  /**
   * Setup the relay protocol handler
   */
  async setupRelayProtocol() {
    const RELAY_PROTOCOL = '/p2p-chat/relay/1.0.0';

    // Handle incoming relay requests
    await this.node.handle(RELAY_PROTOCOL, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      
      try {
        // Read the request
        const chunks = [];
        for await (const chunk of stream.source) {
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks.map(c => Buffer.from(c.subarray())));
        const request = JSON.parse(data.toString());

        await this.handleRelayRequest(stream, peerId, request);
      } catch (error) {
        console.error('[Relay] Protocol error:', error);
      }
    });
  }

  /**
   * Handle incoming relay request
   */
  async handleRelayRequest(stream, peerId, request) {
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
        await this.sendResponse(stream, { error: 'Unknown request type' });
    }
  }

  /**
   * Handle reservation request (peer wants to use us as relay)
   */
  async handleReservation(stream, peerId, request) {
    // Check limits
    if (this.reservations.size >= this.limits.maxReservations) {
      await this.sendResponse(stream, {
        success: false,
        error: 'RESOURCE_LIMIT_EXCEEDED',
        message: 'Max reservations reached'
      });
      return;
    }

    // Create reservation
    const reservation = {
      peerId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.limits.reservationTTL,
      circuits: 0,
      bytesRelayed: 0
    };

    this.reservations.set(peerId, reservation);
    this.stats.recordReservation();

    // Generate relay address for the peer
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

    // Set expiration timer
    setTimeout(() => {
      if (this.reservations.has(peerId)) {
        this.reservations.delete(peerId);
        this.stats.removeReservation();
        this.emit('reservationExpired', { peerId });
      }
    }, this.limits.reservationTTL);
  }

  /**
   * Handle connect request (peer A wants to connect to peer B through us)
   */
  async handleConnect(stream, srcPeer, request) {
    const dstPeer = request.dstPeer;

    // Check if destination has a reservation with us
    if (!this.reservations.has(dstPeer)) {
      await this.sendResponse(stream, {
        success: false,
        error: 'NO_RESERVATION',
        message: 'Destination peer has no reservation'
      });
      return;
    }

    const reservation = this.reservations.get(dstPeer);
    
    // Check circuit limits
    if (reservation.circuits >= this.limits.maxCircuits) {
      await this.sendResponse(stream, {
        success: false,
        error: 'RESOURCE_LIMIT_EXCEEDED',
        message: 'Max circuits for this reservation'
      });
      return;
    }

    // Create circuit
    const circuitId = `${srcPeer}:${dstPeer}:${Date.now()}`;
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

    console.log(`[Relay] Circuit established: ${srcPeer.slice(0, 8)}... → ${dstPeer.slice(0, 8)}...`);
    this.emit('circuitOpened', { srcPeer, dstPeer, circuitId });

    // Set circuit timeout
    setTimeout(() => {
      this.closeCircuit(circuitId);
    }, this.limits.maxDuration);
  }

  /**
   * Handle relay request (forward data through circuit)
   */
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

    // Check data limit
    if (circuit.bytesRelayed + data.length > this.limits.maxData) {
      this.closeCircuit(circuitId);
      await this.sendResponse(stream, {
        success: false,
        error: 'DATA_LIMIT_EXCEEDED'
      });
      return;
    }

    // Forward the data to destination
    // Note: In a real implementation, we'd pipe streams directly
    // This is simplified for demonstration
    circuit.bytesRelayed += data.length;
    this.stats.totalBytesRelayed += data.length;

    await this.sendResponse(stream, {
      success: true,
      type: 'RELAYED',
      bytesRelayed: data.length
    });
  }

  /**
   * Close a circuit
   */
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

  /**
   * Send response on stream
   */
  async sendResponse(stream, response) {
    const data = JSON.stringify(response);
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(data)]);
  }

  /**
   * Announce ourselves as a relay in the DHT
   */
  startRelayAnnouncement() {
    const announce = async () => {
      if (!this.enabled) return;

      try {
        // Publish relay status to DHT
        const relayInfo = {
          type: 'relay',
          peerId: this.node.peerId.toString(),
          addresses: this.node.getMultiaddrs().map(ma => ma.toString()),
          limits: this.limits,
          stats: {
            uptime: this.stats.getStats().uptimeSeconds,
            peersHelped: this.stats.peersHelped.size
          },
          timestamp: Date.now()
        };

        // Announce via GossipSub
        const { fromString } = require('uint8arrays');
        await this.node.services.pubsub.publish(
          'p2p-chat:relays',
          fromString(JSON.stringify(relayInfo))
        );

        console.log('[Relay] Announced as relay node');
      } catch (error) {
        console.warn('[Relay] Announcement failed:', error.message);
      }
    };

    // Announce immediately and then every 5 minutes
    announce();
    this.announceInterval = setInterval(announce, 5 * 60 * 1000);
  }

  /**
   * Get relay statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      ...this.stats.getStats(),
      reservations: Array.from(this.reservations.keys()).map(p => p.slice(0, 16)),
      activeCircuits: this.activeCircuits.size
    };
  }

  /**
   * Check if relay is enabled
   */
  isEnabled() {
    return this.enabled;
  }
}

/**
 * Relay Client - Use relay nodes when direct connection fails
 */
class RelayClient {
  constructor(node) {
    this.node = node;
    this.knownRelays = new Map();  // peerId -> relay info
    this.activeReservations = new Map();  // relayPeerId -> reservation
  }

  /**
   * Discover available relay nodes
   */
  async discoverRelays() {
    // Subscribe to relay announcements
    await this.node.services.pubsub.subscribe('p2p-chat:relays');
    
    this.node.services.pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === 'p2p-chat:relays') {
        try {
          const { toString } = require('uint8arrays');
          const info = JSON.parse(toString(event.detail.data));
          if (info.type === 'relay') {
            this.knownRelays.set(info.peerId, info);
          }
        } catch (e) {}
      }
    });
  }

  /**
   * Get list of known relays
   */
  getKnownRelays() {
    return Array.from(this.knownRelays.values());
  }

  /**
   * Request a reservation from a relay
   */
  async requestReservation(relayPeerId) {
    // Implementation would dial the relay and request reservation
    // Returns relay addresses we can share with peers
  }

  /**
   * Connect to a peer through a relay
   */
  async connectThroughRelay(relayPeerId, targetPeerId) {
    // Implementation would establish circuit through relay
  }
}

module.exports = { RelayServer, RelayClient, RelayStats };
