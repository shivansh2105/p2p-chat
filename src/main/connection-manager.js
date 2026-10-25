/**
 * Smart Connection Manager
 * 
 * Tries ALL possible ways to connect two peers:
 * 1. Direct TCP/WebSocket (same network)
 * 2. STUN hole punching (simple NAT)
 * 3. TURN relay (symmetric NAT)
 * 4. Circuit relay through other peers (P2P fallback)
 * 
 * Falls through methods until one works.
 */

const EventEmitter = require('events');

// Free public STUN servers (just for discovery, no relay)
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.services.mozilla.com:3478'
];

// Free TURN servers (actual relay)
// These are provided by metered.ca - a company with free tier
// They can see IPs but NOT content (encrypted)
const FREE_TURN_SERVERS = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
    provider: 'Open Relay Project (metered.ca)',
    note: 'Free, community supported'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject', 
    credential: 'openrelayproject',
    provider: 'Open Relay Project (metered.ca)',
    note: 'Free, HTTPS port'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
    provider: 'Open Relay Project (metered.ca)',
    note: 'Free, TCP fallback'
  }
];

// Public libp2p relay nodes (for circuit relay)
const PUBLIC_LIBP2P_RELAYS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb'
];

class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Allow custom TURN servers
    this.stunServers = options.stunServers || STUN_SERVERS;
    this.turnServers = options.turnServers || FREE_TURN_SERVERS;
    this.libp2pRelays = options.libp2pRelays || PUBLIC_LIBP2P_RELAYS;
    
    // Connection stats
    this.stats = {
      directConnections: 0,
      stunConnections: 0,
      turnConnections: 0,
      circuitConnections: 0,
      failedConnections: 0
    };
    
    // NAT type detection
    this.natType = null;
    this.publicIP = null;
    this.isRelayable = false;
  }

  /**
   * Get ICE servers config for WebRTC
   */
  getIceServers() {
    return [
      // STUN servers (free, just for discovery)
      ...this.stunServers.map(url => ({ urls: url })),
      
      // TURN servers (free tier, actual relay)
      ...this.turnServers.map(server => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential
      }))
    ];
  }

  /**
   * Get libp2p bootstrap/relay addresses
   */
  getLibp2pRelays() {
    return this.libp2pRelays;
  }

  /**
   * Detect NAT type
   */
  async detectNatType() {
    try {
      // Use STUN to detect NAT
      const pc = new (require('wrtc').RTCPeerConnection)({
        iceServers: [{ urls: this.stunServers[0] }]
      });

      return new Promise((resolve) => {
        let candidates = [];
        
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            candidates.push(event.candidate);
          } else {
            // ICE gathering complete
            pc.close();
            
            const hasHostCandidate = candidates.some(c => c.type === 'host');
            const hasSrflxCandidate = candidates.some(c => c.type === 'srflx');
            const hasRelayCandidate = candidates.some(c => c.type === 'relay');
            
            if (!hasSrflxCandidate && !hasRelayCandidate) {
              this.natType = 'blocked';
            } else if (hasSrflxCandidate) {
              this.natType = 'open-or-cone';
              this.isRelayable = true;
            } else {
              this.natType = 'symmetric';
            }
            
            // Extract public IP
            const srflx = candidates.find(c => c.type === 'srflx');
            if (srflx) {
              const match = srflx.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
              if (match) this.publicIP = match[1];
            }
            
            resolve({
              natType: this.natType,
              publicIP: this.publicIP,
              canRelay: this.isRelayable,
              candidateTypes: {
                host: hasHostCandidate,
                srflx: hasSrflxCandidate,
                relay: hasRelayCandidate
              }
            });
          }
        };

        pc.createDataChannel('nat-detect');
        pc.createOffer().then(offer => pc.setLocalDescription(offer));
        
        // Timeout
        setTimeout(() => {
          pc.close();
          resolve({ natType: 'unknown', error: 'timeout' });
        }, 10000);
      });
    } catch (e) {
      return { natType: 'unknown', error: e.message };
    }
  }

  /**
   * Try all connection methods in order
   */
  async connectToPeer(targetPeerId, node) {
    const methods = [
      { name: 'direct', fn: () => this.tryDirect(targetPeerId, node) },
      { name: 'dht-lookup', fn: () => this.tryDhtLookup(targetPeerId, node) },
      { name: 'circuit-relay', fn: () => this.tryCircuitRelay(targetPeerId, node) }
    ];

    for (const method of methods) {
      try {
        console.log(`[Connection] Trying ${method.name}...`);
        const connection = await method.fn();
        
        if (connection) {
          console.log(`[Connection] Success via ${method.name}`);
          this.stats[`${method.name}Connections`] = 
            (this.stats[`${method.name}Connections`] || 0) + 1;
          
          this.emit('connected', { 
            peerId: targetPeerId, 
            method: method.name,
            connection 
          });
          
          return { success: true, method: method.name, connection };
        }
      } catch (e) {
        console.log(`[Connection] ${method.name} failed: ${e.message}`);
      }
    }

    this.stats.failedConnections++;
    this.emit('connectionFailed', { peerId: targetPeerId });
    return { success: false, error: 'All methods failed' };
  }

  async tryDirect(peerId, node) {
    // Try direct connection to known addresses
    const peerInfo = await node.peerStore.get(peerId);
    if (!peerInfo?.addresses?.length) return null;

    for (const addr of peerInfo.addresses) {
      try {
        const connection = await node.dial(addr.multiaddr, { 
          signal: AbortSignal.timeout(5000) 
        });
        return connection;
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  async tryDhtLookup(peerId, node) {
    // Find peer via DHT
    try {
      const peer = await node.peerRouting.findPeer(peerId, {
        signal: AbortSignal.timeout(10000)
      });
      
      if (peer?.multiaddrs?.length) {
        return await node.dial(peer.id, { 
          signal: AbortSignal.timeout(5000) 
        });
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  async tryCircuitRelay(peerId, node) {
    // Try connecting through relay peers
    const relayPeers = this.getConnectedRelays(node);
    
    for (const relay of relayPeers) {
      try {
        // Construct relay address
        const relayAddr = `${relay}/p2p-circuit/p2p/${peerId}`;
        const connection = await node.dial(relayAddr, {
          signal: AbortSignal.timeout(10000)
        });
        return connection;
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  getConnectedRelays(node) {
    // Get peers that advertise relay capability
    const relays = [];
    for (const conn of node.getConnections()) {
      // Check if peer supports relay
      const protocols = conn.remoteAddr?.protoNames() || [];
      if (protocols.includes('p2p-circuit')) {
        relays.push(conn.remoteAddr.toString());
      }
    }
    
    // Also add public relays
    return [...relays, ...this.libp2pRelays];
  }

  /**
   * Add custom TURN server
   */
  addTurnServer(url, username, credential, label = 'Custom') {
    this.turnServers.push({
      urls: url,
      username,
      credential,
      provider: label,
      note: 'User provided'
    });
  }

  /**
   * Get connection stats
   */
  getStats() {
    return {
      ...this.stats,
      natType: this.natType,
      publicIP: this.publicIP,
      turnServers: this.turnServers.map(t => ({
        url: t.urls,
        provider: t.provider
      })),
      libp2pRelays: this.libp2pRelays.length
    };
  }

  /**
   * List all TURN server providers (for transparency)
   */
  getTurnProviders() {
    return this.turnServers.map(t => ({
      url: t.urls,
      provider: t.provider,
      note: t.note,
      privacyNote: 'Can see your IP, cannot read encrypted content'
    }));
  }
}

// Export servers for mobile app to use
module.exports = { 
  ConnectionManager,
  STUN_SERVERS,
  FREE_TURN_SERVERS,
  PUBLIC_LIBP2P_RELAYS
};
