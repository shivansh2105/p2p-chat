/**
 * SERVERLESS P2P Node - True BitTorrent/Bitcoin-style networking
 * 
 * ═══════════════════════════════════════════════════════════════════
 * NO CENTRAL SERVERS REQUIRED - Completely decentralized like torrents
 * ═══════════════════════════════════════════════════════════════════
 * 
 * HOW IT WORKS (Same as BitTorrent/Bitcoin):
 * 
 * 1. DHT (Distributed Hash Table) - Like BitTorrent's Mainline DHT
 *    - PEERS ARE THE NETWORK - no central directory
 *    - Each peer maintains part of the global routing table
 *    - Find any peer by querying closest nodes (XOR distance)
 *    - 1000+ node network can route in ~3 hops
 * 
 * 2. GOSSIP PROTOCOL - Like Bitcoin transaction propagation
 *    - Messages flood through connected peers
 *    - Redundant delivery through multiple paths
 *    - Works even if some peers are offline
 * 
 * 3. NAT TRAVERSAL - Uses FREE public STUN servers
 *    - Google, Cloudflare, Mozilla provide free STUN
 *    - Hole-punching for direct P2P even behind routers
 *    - WebRTC as fallback for browser compatibility
 * 
 * 4. BOOTSTRAP (ALL SERVERLESS):
 *    - Share address with friend → they connect directly
 *    - QR code scan → instant connection  
 *    - Same WiFi → auto-discovery via mDNS
 *    - Once connected to 1 peer → discover entire network via DHT
 * 
 * NETWORK GROWTH (Like Bitcoin):
 *    User A starts → User A shares address → User B connects
 *    → User B shares with C → Now A,B,C all discover each other via DHT
 *    → Each new user strengthens the network
 */

const { loadEsm, esm, fromString, toString } = require('./esm');
const multiaddr = (a) => esm().multiaddr(a);

// Public libp2p bootstrap nodes (for initial peer discovery)
const BOOTSTRAP_NODES = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
];
const crypto = require('crypto');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// Enhanced crypto and naming modules (Tailscale-inspired)
const P2PCrypto = require('./crypto');
const UsernameRegistry = require('./username-registry');
const { RelayServer, RelayClient } = require('./relay-server');

// ═══════════════════════════════════════════════════════════════════
// FREE PUBLIC STUN SERVERS - No cost, no maintenance, no servers needed
// These are provided freely by Google, Cloudflare, Mozilla etc.
// ═══════════════════════════════════════════════════════════════════
const PUBLIC_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.services.mozilla.com:3478',
  'stun:stun.stunprotocol.org:3478'
];

const MESSAGE_PROTOCOL = '/p2p-chat/message/1.0.0';
const SYNC_PROTOCOL = '/p2p-chat/sync/1.0.0';

class P2PNode extends EventEmitter {
  constructor(database, store, dataDir) {
    super();
    this.database = database;
    this.store = store;
    this.dataDir = dataDir || require('path').join(require('os').homedir(), '.p2p-chat');
    this.node = null;
    this.peerId = null;
    this.publicKey = null;
    this.connectedPeers = new Map();
    this.knownPeers = new Map();         // Persistent peers for reconnection
    this.peerUsernames = new Map();      // Map peerId -> username
    this.messageCache = new Map();        // Deduplicate messages
    this.pendingMessages = new Map();     // Queue for offline peers
    
    // Tailscale-inspired modules
    this.crypto = new P2PCrypto(this.dataDir);
    this.registry = null;  // Initialized after node starts
    
    // Volunteer relay server (like Tor/Bitcoin node)
    this.relayServer = null;
    this.relayClient = null;
    
    // Message store for offline delivery (BitTorrent-style)
    const { MessageStore } = require('./message-store');
    this.messageStore = new MessageStore(this.store);
    
    // Video store for P2P video sharing (YouTube-style)
    const { VideoStore } = require('./video-store');
    this.videoStore = new VideoStore(this.dataDir, this.store);
    this.videoProtocol = null;
  }

  async start() {
    // Load saved peers from previous sessions
    this.loadKnownPeers();

    const {
      createLibp2p, tcp, webSockets, noise, yamux, identify, kadDHT, gossipsub, mdns,
      circuitRelayTransport, circuitRelayServer, autoNAT, dcutr, bootstrap
    } = await loadEsm();

    // Persistent libp2p identity → same Peer ID across restarts
    // (contacts, chats and offline inboxes are keyed by Peer ID)
    const { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } = esm();
    let privateKey;
    const saved = this.crypto.loadSecret('libp2p.key');
    if (saved?.key) {
      privateKey = privateKeyFromProtobuf(Buffer.from(saved.key, 'base64'));
    } else {
      privateKey = await generateKeyPair('Ed25519');
      this.crypto.saveSecret('libp2p.key', { key: Buffer.from(privateKeyToProtobuf(privateKey)).toString('base64') });
    }

    this.node = await createLibp2p({
      privateKey,
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0',              // TCP - works on any port
          '/ip4/0.0.0.0/tcp/0/ws',           // WebSocket - browser compatible
          '/p2p-circuit'                      // Listen via relay (for NAT traversal)
        ]
      },
      transports: [
        tcp(),
        webSockets(),
        circuitRelayTransport()             // Connect THROUGH other peers (relays found via '/p2p-circuit' listen addr)
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        
        // ═══════════════════════════════════════════════════════════
        // CIRCUIT RELAY - NAT TRAVERSAL (Critical for P2P behind NAT)
        // Allows peers behind NAT to connect through relay peers
        // ═══════════════════════════════════════════════════════════
        relay: circuitRelayServer({
          reservations: {
            maxReservations: 128,           // How many peers we relay for
            reservationTtl: 60 * 60 * 1000, // 1 hour reservation
            // Per relayed connection. 10MB default would cut off video replicas;
            // DCUtR upgrades to direct when hole punching works, so this only
            // caps the worst case (both peers behind symmetric NAT).
            defaultDataLimit: BigInt(256 * 1024 * 1024),   // 256MB
            defaultDurationLimit: 30 * 60 * 1000             // 30 min
          }
        }),
        
        // Auto-detect NAT status
        autonat: autoNAT(),
        
        // Direct Connection Upgrade - hole punching after relay connect
        dcutr: dcutr(),
        
        // ═══════════════════════════════════════════════════════════
        // KADEMLIA DHT - Heart of serverless peer discovery
        // Same algorithm BitTorrent uses to find peers without trackers
        // ═══════════════════════════════════════════════════════════
        dht: kadDHT({
          clientMode: false,           // We ARE the DHT network
          kBucketSize: 20,             // Standard Kademlia bucket size
          randomWalk: {
            enabled: true,             // Actively explore network
            interval: 60000,           // Every minute
            timeout: 10000
          },
          providers: { enabled: true }
        }),

        // ═══════════════════════════════════════════════════════════
        // GOSSIPSUB - Bitcoin-style message propagation
        // Messages spread through mesh without central relay
        // ═══════════════════════════════════════════════════════════
        pubsub: gossipsub({
          emitSelf: false,
          gossipIncoming: true,
          fallbackToFloodsub: true,
          floodPublish: true,          // Flood for reliability
          doPX: true,                  // Peer exchange (PEX) like BitTorrent
          allowPublishToZeroPeers: true,
          scoreParams: {
            appSpecificScore: (peerId) => {
              return this.knownPeers.has(peerId) ? 100 : 0;
            }
          }
        })
      },
      
      // LOCAL DISCOVERY - Zero config on same network
      peerDiscovery: [
        mdns({
          interval: 10000,
          broadcast: true,
          serviceTag: 'p2p-chat.local'
        }),
        // Bootstrap from public libp2p nodes (for internet discovery)
        bootstrap({
          list: BOOTSTRAP_NODES,
          timeout: 3000
        })
      ],
      
      connectionManager: {
        minConnections: 3,
        maxConnections: 50,
        autoDialInterval: 30000
      }
    });

    // Identity
    this.peerId = this.node.peerId.toString();
    this.publicKey = crypto.createHash('sha256')
      .update(this.peerId)
      .digest('hex');

    // Behind NAT most connections are relayed ("limited"). libp2p refuses to
    // run app protocols on those unless runOnLimitedConnection is set, so
    // default it on for every handler/dial. Also accept string peer IDs.
    const { peerIdFromString } = esm();
    const toPeer = (p) => (typeof p === 'string' && !p.startsWith('/') ? peerIdFromString(p) : p);
    const rawHandle = this.node.handle.bind(this.node);
    const rawDialProtocol = this.node.dialProtocol.bind(this.node);
    const rawDial = this.node.dial.bind(this.node);
    this.node.handle = (proto, handler, opts = {}) =>
      rawHandle(proto, handler, { runOnLimitedConnection: true, ...opts });
    this.node.dialProtocol = (peer, proto, opts = {}) =>
      rawDialProtocol(toPeer(peer), proto, { runOnLimitedConnection: true, ...opts });
    this.node.dial = (peer, opts) => rawDial(toPeer(peer), opts);

    // Setup
    await this.setupProtocols();
    this.setupEventHandlers();
    await this.node.start();

    // Initialize Tailscale-inspired crypto and naming
    await this.initializeCrypto();

    // Offline inbox (store-and-forward on volunteer PCs)
    const { Inbox } = require('./inbox');
    this.inbox = new Inbox(this);
    await this.inbox.start();
    
    // Initialize relay server and client (volunteer node support)
    await this.initializeRelay();
    
    // Initialize video protocol (P2P YouTube-style sharing)
    await this.initializeVideoProtocol();

    // Get shareable addresses
    this.publicAddresses = this.getShareableAddresses();

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║     P2P CHAT - NO SERVERS REQUIRED (Like BitTorrent)      ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║ Your Peer ID: ' + this.peerId.slice(0, 45) + '...║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║ SHARE THIS ADDRESS WITH FRIENDS TO CONNECT:               ║');
    this.publicAddresses.slice(0, 2).forEach(addr => {
      console.log('║ ' + addr.slice(0, 59).padEnd(59) + '║');
    });
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║ • Same WiFi: Friends auto-discovered                      ║');
    console.log('║ • Internet: Share address (QR/text), they connect direct  ║');
    console.log('║ • Network grows: Each new peer strengthens DHT            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');

    // Reconnect to saved peers
    this.reconnectToKnownPeers();
    
    // Start maintenance tasks
    this.startPeriodicTasks();

    return this;
  }

  async setupProtocols() {
    // Direct message protocol - reliable 1:1 delivery
    await this.node.handle(MESSAGE_PROTOCOL, async ({ stream, connection }) => {
      try {
        const chunks = [];
        for await (const chunk of stream.source) {
          chunks.push(Buffer.from(chunk.subarray()));
        }
        const data = Buffer.concat(chunks);
        const message = JSON.parse(data.toString());
        
        await this.handleDirectMessage(message, connection.remotePeer.toString());
        
        // ACK
        const ack = Buffer.from(JSON.stringify({ ack: true, id: message.id }));
        await stream.sink([ack]);
      } catch (error) {
        console.error('Message protocol error:', error);
      }
    });

    // Sync protocol - catch up on missed messages
    await this.node.handle(SYNC_PROTOCOL, async ({ stream, connection }) => {
      try {
        const chunks = [];
        for await (const chunk of stream.source) {
          chunks.push(Buffer.from(chunk.subarray()));
        }
        const request = JSON.parse(Buffer.concat(chunks).toString());
        const response = await this.handleSyncRequest(request);
        await stream.sink([Buffer.from(JSON.stringify(response))]);
      } catch (error) {
        console.error('Sync protocol error:', error);
      }
    });
  }

  setupEventHandlers() {
    // Peer discovered via mDNS or DHT
    this.node.addEventListener('peer:discovery', async (event) => {
      const peerId = event.detail.id.toString();
      console.log('🔍 Discovered:', peerId.slice(0, 20) + '...');
      
      // Auto-connect
      if (event.detail.multiaddrs?.length > 0) {
        try {
          await this.node.dial(event.detail.multiaddrs[0]);
        } catch (e) { /* not reachable */ }
      }
    });

    // Peer connected
    this.node.addEventListener('peer:connect', async (event) => {
      const peerId = event.detail.toString();
      console.log('✅ Connected:', peerId.slice(0, 20) + '...');
      
      const addrs = await this.node.peerStore.get(event.detail).catch(() => null);
      const addresses = addrs?.addresses?.map(a => a.multiaddr.toString()) || [];
      
      this.connectedPeers.set(peerId, {
        id: peerId,
        addresses,
        connectedAt: Date.now()
      });

      // Save for reconnection
      this.saveKnownPeer(peerId, addresses);

      // Exchange peers (BitTorrent PEX)
      this.exchangePeers(peerId);

      // Sync missed messages
      this.syncWithPeer(peerId);

      // Send our presence/username to the new peer
      this.sendPresenceToPeer(peerId);

      // Swap inbox keys + pull any messages this peer is holding for us
      this.inbox?.onPeerConnected(peerId);

      // Push videos that still need replicas
      this.retryPendingReplication?.(peerId);

      this.emit('peer:connected', { 
        id: peerId,
        username: this.peerUsernames.get(peerId) || null
      });
    });

    // Peer disconnected
    this.node.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      console.log('❌ Disconnected:', peerId.slice(0, 20) + '...');
      this.connectedPeers.delete(peerId);
      this.emit('peer:disconnected', { id: peerId });
    });

    // Subscribe to gossip
    this.setupGossipTopics();
  }

  setupGossipTopics() {
    const pubsub = this.node.services.pubsub;
    
    // Global presence
    pubsub.subscribe('p2p-chat:presence');
    
    // Personal topic (messages addressed to us)
    pubsub.subscribe(`p2p-chat:user:${this.peerId}`);
    
    pubsub.addEventListener('message', (event) => {
      this.handleGossipMessage(event.detail);
    });
  }

  async handleGossipMessage(event) {
    try {
      const data = JSON.parse(toString(event.data));
      const senderId = event.from?.toString();

      // Deduplicate
      if (this.messageCache.has(data.id)) return;
      this.messageCache.set(data.id, Date.now());

      switch (data.type) {
        case 'chat_message':
          await this.handleChatMessage(data, senderId);
          break;
        case 'presence':
          this.handlePresence(data, senderId);
          break;
        case 'peer_exchange':
          await this.handlePeerExchange(data);
          break;
        case 'receipt':
          this.emit('message:receipt', data);
          break;
      }
    } catch (error) {
      console.error('Gossip error:', error);
    }
  }

  async handleChatMessage(data, senderId) {
    const message = {
      id: data.id,
      chatId: data.groupId || senderId,
      senderId,
      content: data.content,
      type: data.contentType || 'text',
      timestamp: data.timestamp,
      status: 'received'
    };

    await this.database.addMessage(
      message.chatId,
      message.content,
      message.type,
      'received',
      message.senderId,
      message.id
    );

    this.emit('message', message);
    this.sendReceipt(senderId, data.id, 'delivered');
  }

  handlePresence(data, senderId) {
    // Store username for this peer
    if (data.username && data.username !== 'Anonymous') {
      this.peerUsernames.set(senderId, data.username);
      // Also save to database
      this.database.updateContactUsername?.(senderId, data.username);
    }

    this.emit('peer:presence', {
      id: senderId,
      username: data.username,
      status: data.status,
      lastSeen: data.timestamp
    });
  }

  // Get username for a peer
  getPeerUsername(peerId) {
    return this.peerUsernames.get(peerId) || null;
  }

  // Get all known usernames
  getAllPeerUsernames() {
    return Object.fromEntries(this.peerUsernames);
  }

  async handlePeerExchange(data) {
    // Connect to shared peers (BitTorrent PEX)
    for (const peer of data.peers || []) {
      if (peer.id === this.peerId) continue;
      if (this.connectedPeers.has(peer.id)) continue;

      for (const addr of peer.addresses || []) {
        try {
          await this.node.dial(multiaddr(addr));
          break;
        } catch (e) { /* not reachable */ }
      }
    }
  }

  async handleDirectMessage(message, senderId) {
    if (this.messageCache.has(message.id)) return;
    this.messageCache.set(message.id, Date.now());

    await this.database.addMessage(
      message.groupId || senderId,
      message.content,
      message.contentType || 'text',
      'received',
      senderId,
      message.id
    );

    this.emit('message', {
      id: message.id,
      chatId: message.groupId || senderId,
      senderId,
      content: message.content,
      type: message.contentType || 'text',
      timestamp: message.timestamp,
      status: 'received'
    });
  }

  async handleSyncRequest(request) {
    const messages = this.database.getMessagesSince?.(
      request.chatId,
      request.since,
      100
    ) || [];
    return { messages, syncedAt: Date.now() };
  }

  // ═══════════════════════════════════════════════════════════════════
  // MESSAGE SENDING - Multiple methods for reliability
  // ═══════════════════════════════════════════════════════════════════

  async sendMessage(recipientId, message) {
    const payload = {
      id: message.id || uuidv4(),
      type: 'chat_message',
      senderId: this.peerId,
      recipientId,
      content: message.content,
      contentType: message.type || 'text',
      timestamp: Date.now()
    };

    let delivered = false;

    // METHOD 1: Direct protocol (if peer connected)
    if (this.connectedPeers.has(recipientId)) {
      try {
        const stream = await this.node.dialProtocol(
          recipientId,
          MESSAGE_PROTOCOL
        );
        
        await stream.sink([Buffer.from(JSON.stringify(payload))]);
        
        const chunks = [];
        for await (const chunk of stream.source) {
          chunks.push(Buffer.from(chunk.subarray()));
        }
        const ack = JSON.parse(Buffer.concat(chunks).toString());
        delivered = ack?.ack === true;
      } catch (e) {
        console.log('Direct send failed, using gossip...');
      }
    }

    // METHOD 2: Gossip to recipient's topic
    if (!delivered) {
      try {
        const pubsub = this.node.services.pubsub;
        await pubsub.publish(
          `p2p-chat:user:${recipientId}`,
          fromString(JSON.stringify(payload))
        );
        delivered = true;
      } catch (e) {
        console.log('Gossip failed');
      }
    }

    // METHOD 3: Sealed store-and-forward on volunteer PCs (recipient offline)
    if (!delivered && this.inbox) {
      try {
        delivered = (await this.inbox.sendOffline(recipientId, payload)) > 0;
      } catch (e) {
        console.log('Offline store failed:', e.message);
      }
    }

    // METHOD 4: Queue locally as last resort
    if (!delivered) {
      this.queuePendingMessage(recipientId, payload);
    }

    return payload;
  }

  async sendGroupMessage(groupId, message, memberIds) {
    const payload = {
      id: message.id || uuidv4(),
      type: 'chat_message',
      senderId: this.peerId,
      groupId,
      content: message.content,
      contentType: message.type || 'text',
      timestamp: Date.now()
    };

    const pubsub = this.node.services.pubsub;
    const data = fromString(JSON.stringify(payload));

    for (const memberId of memberIds) {
      if (memberId === this.peerId) continue;
      try {
        await pubsub.publish(`p2p-chat:user:${memberId}`, data);
      } catch (e) {
        this.queuePendingMessage(memberId, payload);
      }
    }

    return payload;
  }

  sendReceipt(recipientId, messageId, status) {
    const pubsub = this.node.services.pubsub;
    const payload = {
      id: uuidv4(),
      type: 'receipt',
      messageId,
      status,
      timestamp: Date.now()
    };
    
    pubsub.publish(
      `p2p-chat:user:${recipientId}`,
      fromString(JSON.stringify(payload))
    ).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════
  // PEER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  async connectToPeer(addressString) {
    try {
      const addr = multiaddr(addressString);
      await this.node.dial(addr);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async exchangePeers(peerId) {
    const peers = Array.from(this.connectedPeers.values())
      .filter(p => p.id !== peerId)
      .slice(0, 10)
      .map(p => ({ id: p.id, addresses: p.addresses }));

    if (peers.length === 0) return;

    const payload = {
      id: uuidv4(),
      type: 'peer_exchange',
      peers,
      timestamp: Date.now()
    };

    try {
      const pubsub = this.node.services.pubsub;
      await pubsub.publish(
        `p2p-chat:user:${peerId}`,
        fromString(JSON.stringify(payload))
      );
    } catch (e) {}
  }

  async syncWithPeer(peerId) {
    const lastSync = this.store.get(`lastSync:${peerId}`) || 0;

    try {
      const stream = await this.node.dialProtocol(peerId, SYNC_PROTOCOL);
      const request = { chatId: peerId, since: lastSync };
      await stream.sink([Buffer.from(JSON.stringify(request))]);

      const chunks = [];
      for await (const chunk of stream.source) {
        chunks.push(Buffer.from(chunk.subarray()));
      }
      
      const response = JSON.parse(Buffer.concat(chunks).toString());
      
      for (const msg of response.messages || []) {
        if (!this.messageCache.has(msg.id)) {
          await this.handleDirectMessage(msg, peerId);
        }
      }

      this.store.set(`lastSync:${peerId}`, response.syncedAt);
    } catch (e) {}

    // Send pending messages
    const pending = this.pendingMessages.get(peerId) || [];
    for (const msg of pending) {
      await this.sendMessage(peerId, msg);
    }
    this.pendingMessages.delete(peerId);
  }

  queuePendingMessage(peerId, message) {
    const pending = this.pendingMessages.get(peerId) || [];
    pending.push(message);
    this.pendingMessages.set(peerId, pending);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PERSISTENCE - Remember peers for reconnection
  // ═══════════════════════════════════════════════════════════════════

  loadKnownPeers() {
    const saved = this.store.get('knownPeers') || {};
    for (const [id, info] of Object.entries(saved)) {
      this.knownPeers.set(id, info);
    }
  }

  saveKnownPeer(peerId, addresses) {
    this.knownPeers.set(peerId, {
      id: peerId,
      addresses,
      lastSeen: Date.now()
    });
    this.store.set('knownPeers', Object.fromEntries(this.knownPeers));
  }

  async reconnectToKnownPeers() {
    if (this.knownPeers.size === 0) return;
    console.log(`🔄 Reconnecting to ${this.knownPeers.size} known peers...`);
    
    for (const [peerId, info] of this.knownPeers) {
      if (this.connectedPeers.has(peerId)) continue;

      for (const addr of info.addresses || []) {
        try {
          await this.node.dial(multiaddr(addr));
          console.log('✅ Reconnected:', peerId.slice(0, 20) + '...');
          break;
        } catch (e) {}
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PERIODIC TASKS
  // ═══════════════════════════════════════════════════════════════════

  startPeriodicTasks() {
    // Presence every 5 min
    setInterval(() => this.announcePresence(), 300000);

    // Clean cache every hour
    setInterval(() => {
      const now = Date.now();
      for (const [id, time] of this.messageCache) {
        if (now - time > 3600000) this.messageCache.delete(id);
      }
    }, 3600000);

    // Reconnect every 10 min
    setInterval(() => this.reconnectToKnownPeers(), 600000);

    this.announcePresence();
  }

  async announcePresence() {
    const user = this.store.get('user') || {};
    const pubsub = this.node.services.pubsub;

    const presence = {
      id: uuidv4(),
      type: 'presence',
      peerId: this.peerId,
      username: user.username || 'Anonymous',
      status: 'online',
      timestamp: Date.now()
    };

    await pubsub.publish(
      'p2p-chat:presence',
      fromString(JSON.stringify(presence))
    ).catch(() => {});
  }

  // Send presence directly to a specific peer
  async sendPresenceToPeer(peerId) {
    const user = this.store.get('user') || {};
    const pubsub = this.node.services.pubsub;

    const presence = {
      id: uuidv4(),
      type: 'presence',
      peerId: this.peerId,
      username: user.username || 'Anonymous',
      status: 'online',
      timestamp: Date.now()
    };

    await pubsub.publish(
      `p2p-chat:user:${peerId}`,
      fromString(JSON.stringify(presence))
    ).catch(() => {});
  }

  async announceGroup(group) {
    for (const memberId of group.members) {
      if (memberId === this.peerId) continue;
      
      const payload = {
        id: uuidv4(),
        type: 'group_created',
        group: {
          id: group.id,
          name: group.name,
          createdBy: this.peerId,
          members: group.members
        },
        timestamp: Date.now()
      };

      const pubsub = this.node.services.pubsub;
      await pubsub.publish(
        `p2p-chat:user:${memberId}`,
        fromString(JSON.stringify(payload))
      ).catch(() => {});
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════

  getShareableAddresses() {
    const addrs = this.node.getMultiaddrs();
    const shareable = [];

    // Get local IPs
    const interfaces = os.networkInterfaces();
    for (const nets of Object.values(interfaces)) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          for (const addr of addrs) {
            if (addr.toString().includes(net.address)) {
              shareable.push(addr.toString());
            }
          }
        }
      }
    }

    // WebRTC addresses
    for (const addr of addrs) {
      if (addr.toString().includes('/webrtc')) {
        shareable.push(addr.toString());
      }
    }

    return shareable.length > 0 
      ? [...new Set(shareable)]
      : addrs.map(a => a.toString());
  }

  getConnectedPeers() {
    return Array.from(this.connectedPeers.values());
  }

  getNodeInfo() {
    return {
      peerId: this.peerId,
      publicKey: this.publicKey,
      identityKey: this.crypto?.getPublicKey(),
      keyFingerprint: this.crypto?.getPublicKeyFingerprint(),
      addresses: this.getShareableAddresses(),
      connectedPeers: this.connectedPeers.size,
      knownPeers: this.knownPeers.size,
      registeredUsername: this.registry?.myUsername
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // TAILSCALE-INSPIRED CRYPTO & NAMING
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Initialize crypto identity and username registry
   */
  async initializeCrypto() {
    try {
      // Initialize identity keypair
      const fingerprint = await this.crypto.initializeIdentity();
      console.log(`[Crypto] Identity key: ${fingerprint}`);

      // Initialize username registry
      this.registry = new UsernameRegistry(this.node, this.crypto);

      // Subscribe to registry topic
      await this.node.services.pubsub.subscribe('p2p-chat:registry');

      // Handle registry messages
      this.node.services.pubsub.addEventListener('message', (event) => {
        if (event.detail.topic === 'p2p-chat:registry') {
          this.registry.handleRegistryMessage(event);
        }
      });

      console.log('[Crypto] Username registry initialized');
    } catch (error) {
      console.error('[Crypto] Initialization failed:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // VOLUNTEER RELAY SERVER (Like Tor/Bitcoin Node)
  // Users can opt-in to help the network by relaying traffic for others
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Initialize relay server and client
   * Relay is enabled by default to help the network (like BitTorrent seeding)
   */
  async initializeRelay() {
    try {
      // Create relay server (volunteer mode)
      this.relayServer = new RelayServer(this.node, { crypto: this.crypto });
      
      // Create relay client (to use other relays)
      this.relayClient = new RelayClient(this.node);
      
      // Setup relay event handlers
      this.relayServer.on('enabled', () => {
        this.emit('relayEnabled');
      });
      
      this.relayServer.on('disabled', () => {
        this.emit('relayDisabled');
      });
      
      this.relayServer.on('reservation', ({ peerId }) => {
        console.log(`[Relay] Helping peer ${peerId.slice(0, 16)}...`);
        this.emit('relayHelping', { peerId });
      });
      
      this.relayServer.on('circuitOpened', (info) => {
        this.emit('relayCircuit', info);
      });

      // Check stored preference for relay mode
      const relayEnabled = this.store?.get('relayEnabled', true) ?? true;
      
      if (relayEnabled) {
        await this.relayServer.enable();
      }

      // Start discovering other relay nodes
      await this.relayClient.discoverRelays();

      console.log('[Relay] Relay subsystem initialized');
      console.log(`[Relay] Volunteer mode: ${relayEnabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (error) {
      console.error('[Relay] Initialization failed:', error);
    }
  }

  /**
   * Enable volunteer relay server mode
   * This makes your PC help others connect (like Tor/Bitcoin)
   */
  async enableRelay() {
    if (this.relayServer) {
      await this.relayServer.enable();
      this.store?.set('relayEnabled', true);
      return true;
    }
    return false;
  }

  /**
   * Disable volunteer relay server mode
   */
  async disableRelay() {
    if (this.relayServer) {
      await this.relayServer.disable();
      this.store?.set('relayEnabled', false);
      return true;
    }
    return false;
  }

  /**
   * Initialize P2P video sharing protocol
   */
  async initializeVideoProtocol() {
    try {
      const { VideoProtocol } = require('./video-protocol');
      this.videoProtocol = new VideoProtocol(this.node, this.videoStore);
      await this.videoProtocol.start();
      
      // Re-queue our uploads that never reached 3 replicas
      this.pendingReplication = new Set(
        this.videoStore.getSeedingVideos()
          .filter((v) => v.uploader === this.peerId && (v.replicas || []).length < 3)
          .map((v) => v.id)
      );

      // Re-announce videos we're seeding
      for (const video of this.videoStore.getSeedingVideos()) {
        await this.videoProtocol.announceVideo(video);
      }
      
      console.log('[Video] P2P video sharing enabled');
    } catch (error) {
      console.error('[Video] Initialization failed:', error);
    }
  }

  /**
   * Upload a video to the P2P network
   * IMPORTANT: Also replicates to other peers for availability
   */
  async uploadVideo(filePath, metadata) {
    const video = await this.videoStore.uploadVideo(filePath, {
      ...metadata,
      uploader: this.peerId,
      uploaderName: this.username
    });
    
    // Announce to network
    if (this.videoProtocol) {
      await this.videoProtocol.announceVideo(video);
    }
    
    // REPLICATE to other peers (like BitTorrent seeding)
    this.replicateVideo(video).catch((e) => console.log("[Video] replication error:", e.message)); // background
    
    return video;
  }

  /**
   * Push full copies of a video to other PCs (target: REPLICA_TARGET copies)
   * so it stays watchable after the uploader goes offline. Works over relayed
   * connections too, so it doesn't matter that everyone is behind NAT.
   */
  async replicateVideo(video, target = 3) {
    if (!this.videoProtocol) return 0;
    const done = new Set(video.replicas || []);
    const candidates = this.getConnectedPeers()
      .map((p) => p.id)
      .filter((id) => id && !done.has(id));

    for (const peerId of candidates) {
      if (done.size >= target) break;
      try {
        await this.videoProtocol.replicateTo(peerId, video);
        done.add(peerId);
        console.log(`[Video] "${video.title}" replicated to ${peerId.slice(-8)} (${done.size}/${target})`);
      } catch (e) {
        console.log(`[Video] ${peerId.slice(-8)} declined replica: ${e.message}`);
      }
    }

    video.replicas = [...done];
    this.videoStore.saveIndex();
    if (done.size < target) {
      this.pendingReplication = this.pendingReplication || new Set();
      this.pendingReplication.add(video.id);
      console.log(`[Video] "${video.title}" has ${done.size}/${target} replicas — will retry as peers connect`);
    } else {
      this.pendingReplication?.delete(video.id);
    }
    return done.size;
  }

  /** On each new connection, top up videos that are under-replicated */
  async retryPendingReplication(peerId) {
    if (!this.pendingReplication?.size || this._replicating) return;
    this._replicating = true;
    try {
      for (const id of [...this.pendingReplication]) {
        const video = this.videoStore.getVideo(id);
        if (video) await this.replicateVideo(video);
      }
    } finally {
      this._replicating = false;
    }
  }

  /**
   * Search videos on the network
   */
  async searchVideos(query) {
    if (this.videoProtocol) {
      return await this.videoProtocol.searchNetwork(query);
    }
    return this.videoStore.searchVideos(query);
  }

  /**
   * Download a video from peers
   */
  async downloadVideo(videoId, onProgress) {
    if (this.videoProtocol) {
      return await this.videoProtocol.downloadVideo(videoId, onProgress);
    }
    throw new Error('Video protocol not initialized');
  }

  /**
   * Get video stats
   */
  getVideoStats() {
    return this.videoStore.getStats();
  }

  /**
   * Check if relay server is enabled
   */
  isRelayEnabled() {
    return this.relayServer?.isEnabled() ?? false;
  }

  /**
   * Get relay server statistics
   * Shows how much you've helped the network
   */
  getRelayStats() {
    if (!this.relayServer) {
      return {
        enabled: false,
        uptimeSeconds: 0,
        totalBytesRelayed: 0,
        totalBytesRelayedMB: '0.00',
        peersHelped: 0,
        currentReservations: 0
      };
    }
    return this.relayServer.getStats();
  }

  /**
   * Get list of known relay nodes in the network
   */
  getKnownRelays() {
    return this.relayClient?.getKnownRelays() ?? [];
  }

  /**
   * Register username in the DHT (globally unique)
   * @param {string} username - Desired username (3-20 chars, alphanumeric)
   * @returns {Promise<object>} Registration record
   */
  async registerUsername(username) {
    if (!this.registry) {
      throw new Error('Registry not initialized');
    }
    return await this.registry.registerUsername(username);
  }

  /**
   * Search for a user by username
   * @param {string} username - Username to find
   * @returns {Promise<object|null>} User record with peerId, publicKey, addresses
   */
  async lookupUsername(username) {
    if (!this.registry) {
      throw new Error('Registry not initialized');
    }
    return await this.registry.lookupUsername(username);
  }

  /**
   * Search usernames by prefix
   * @param {string} prefix - Search prefix
   * @returns {Array} Matching user records
   */
  searchUsernames(prefix) {
    if (!this.registry) return [];
    return this.registry.searchUsernames(prefix);
  }

  /**
   * Connect to user by username (instead of raw address)
   * @param {string} username - Username to connect to
   * @returns {Promise<boolean>} Success
   */
  async connectByUsername(username) {
    const record = await this.lookupUsername(username);
    if (!record) {
      throw new Error(`User "${username}" not found`);
    }

    // Try each address
    for (const addr of record.addresses) {
      try {
        await this.connectToPeer(addr);
        
        // Store username mapping
        this.peerUsernames.set(record.peerId, record.username);
        
        return true;
      } catch (error) {
        console.warn(`[P2P] Address ${addr} failed:`, error.message);
      }
    }

    throw new Error(`Could not connect to ${username}`);
  }

  /**
   * Initiate encrypted session with peer
   * @param {string} peerId - Peer to establish session with
   * @returns {string} Our ephemeral public key to send
   */
  initiateEncryptedSession(peerId) {
    return this.crypto.initiateSession(peerId);
  }

  /**
   * Complete encrypted session with peer's key
   * @param {string} peerId - Peer ID
   * @param {string} theirPublicKey - Their ephemeral public key (base64)
   * @returns {string} Our ephemeral public key
   */
  completeEncryptedSession(peerId, theirPublicKey) {
    return this.crypto.completeSession(peerId, theirPublicKey);
  }

  /**
   * Send encrypted message to peer
   * @param {string} peerId - Recipient peer ID
   * @param {string} content - Message content
   * @returns {Promise<void>}
   */
  async sendEncryptedMessage(peerId, content) {
    // Ensure we have an encrypted session
    if (!this.crypto.hasSession(peerId)) {
      // Initiate key exchange first
      await this.initiateKeyExchange(peerId);
    }

    // Encrypt the message
    const encrypted = this.crypto.encryptMessage(peerId, content);

    // Send via existing message protocol
    await this.sendDirectMessage(peerId, {
      type: 'encrypted',
      ciphertext: encrypted,
      from: this.peerId,
      timestamp: Date.now()
    });
  }

  /**
   * Initiate key exchange with peer
   */
  async initiateKeyExchange(peerId) {
    const ourPublicKey = this.crypto.initiateSession(peerId);

    // Send key exchange request
    await this.sendDirectMessage(peerId, {
      type: 'key_exchange',
      subtype: 'initiate',
      publicKey: ourPublicKey,
      identityKey: this.crypto.getPublicKey(),
      from: this.peerId,
      timestamp: Date.now()
    });

    // Wait for response (with timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Key exchange timeout'));
      }, 10000);

      const handler = (msg) => {
        if (msg.type === 'key_exchange' && msg.subtype === 'response' && msg.from === peerId) {
          clearTimeout(timeout);
          this.off('directMessage', handler);
          this.crypto.completeSession(peerId, msg.publicKey);
          resolve(true);
        }
      };

      this.on('directMessage', handler);
    });
  }

  /**
   * Handle incoming key exchange request
   */
  handleKeyExchange(message) {
    if (message.subtype === 'initiate') {
      // Complete our side of the exchange
      const ourPublicKey = this.crypto.completeSession(message.from, message.publicKey);

      // Send response
      this.sendDirectMessage(message.from, {
        type: 'key_exchange',
        subtype: 'response',
        publicKey: ourPublicKey,
        identityKey: this.crypto.getPublicKey(),
        from: this.peerId,
        timestamp: Date.now()
      }).catch(console.warn);

      console.log(`[Crypto] Established encrypted session with ${message.from.slice(0, 16)}...`);
    }
  }

  /**
   * Get my registered username
   */
  getMyUsername() {
    return this.registry?.myUsername || null;
  }

  /**
   * Get identity public key (for sharing/verification)
   */
  getIdentityPublicKey() {
    return this.crypto?.getPublicKey() || null;
  }

  /**
   * Verify a message signature from a peer
   */
  verifyPeerSignature(data, signature, publicKey) {
    return this.crypto.verify(data, signature, publicKey);
  }

  /**
   * Set coordination server for faster username lookups
   * @param {string} url - Coordination server URL (optional)
   */
  setCoordinationServer(url) {
    if (this.registry) {
      this.registry.setCoordinationServer(url);
    }
  }

  async stop() {
    if (this.node) {
      const pubsub = this.node.services.pubsub;
      await pubsub.publish(
        'p2p-chat:presence',
        fromString(JSON.stringify({
          id: uuidv4(),
          type: 'presence',
          status: 'offline',
          timestamp: Date.now()
        }))
      ).catch(() => {});

      await this.node.stop();
      console.log('P2P Node stopped');
    }
  }
}

module.exports = { P2PNode };
