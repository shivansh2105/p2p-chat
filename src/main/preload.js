const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  // User
  user: {
    get: () => ipcRenderer.invoke('user:get'),
    create: (username) => ipcRenderer.invoke('user:create', username),
    updateUsername: (username) => ipcRenderer.invoke('user:updateUsername', username)
  },

  // P2P
  p2p: {
    getPeerId: () => ipcRenderer.invoke('p2p:getPeerId'),
    getPeers: () => ipcRenderer.invoke('p2p:getPeers'),
    getNodeInfo: () => ipcRenderer.invoke('p2p:getNodeInfo'),
    connectPeer: (multiaddr) => ipcRenderer.invoke('p2p:connectPeer', multiaddr),
    getPeerUsername: (peerId) => ipcRenderer.invoke('peer:getUsername', peerId),
    getAllUsernames: () => ipcRenderer.invoke('peer:getAllUsernames'),
    onPeerConnected: (callback) => ipcRenderer.on('p2p:peerConnected', (_, peer) => callback(peer)),
    onPeerDisconnected: (callback) => ipcRenderer.on('p2p:peerDisconnected', (_, peer) => callback(peer)),
    onPeerPresence: (callback) => ipcRenderer.on('p2p:peerPresence', (_, presence) => callback(presence))
  },

  // Chat
  chat: {
    getAll: () => ipcRenderer.invoke('chat:getAll'),
    create: (peerId, peerName) => ipcRenderer.invoke('chat:create', peerId, peerName),
    updateName: (chatId, name) => ipcRenderer.invoke('chat:updateName', chatId, name),
    getMessages: (chatId, limit = 50, offset = 0) => 
      ipcRenderer.invoke('chat:getMessages', chatId, limit, offset),
    sendMessage: (chatId, content, type = 'text') => 
      ipcRenderer.invoke('chat:sendMessage', chatId, content, type),
    onNewMessage: (callback) => ipcRenderer.on('chat:newMessage', (_, msg) => callback(msg))
  },

  // Contacts
  contact: {
    get: (peerId) => ipcRenderer.invoke('contact:get', peerId),
    setNickname: (peerId, nickname) => ipcRenderer.invoke('contact:setNickname', peerId, nickname)
  },

  // Username Registry (DHT-based, globally unique)
  registry: {
    // Register a unique username (3-20 chars, alphanumeric)
    register: (username) => ipcRenderer.invoke('registry:register', username),
    // Lookup user by username
    lookup: (username) => ipcRenderer.invoke('registry:lookup', username),
    // Search usernames by prefix
    search: (prefix) => ipcRenderer.invoke('registry:search', prefix),
    // Connect to user by username (instead of raw address)
    connectByUsername: (username) => ipcRenderer.invoke('registry:connectByUsername', username),
    // Set optional coordination server URL
    setCoordServer: (url) => ipcRenderer.invoke('registry:setCoordServer', url)
  },

  // Crypto (Tailscale-inspired identity)
  crypto: {
    // Get identity info (public key, fingerprint, registered username)
    getIdentity: () => ipcRenderer.invoke('crypto:getIdentity')
  },

  // Volunteer Relay Server (Like Tor/Bitcoin Node)
  // Help the network by relaying traffic for others
  relay: {
    // Enable relay server (start helping the network)
    enable: () => ipcRenderer.invoke('relay:enable'),
    // Disable relay server
    disable: () => ipcRenderer.invoke('relay:disable'),
    // Check if relay is enabled
    isEnabled: () => ipcRenderer.invoke('relay:isEnabled'),
    // Get relay statistics (uptime, bytes relayed, peers helped)
    getStats: () => ipcRenderer.invoke('relay:getStats'),
    // Get list of known relay nodes in the network
    getKnownRelays: () => ipcRenderer.invoke('relay:getKnownRelays'),
    // Event: relay started helping a peer
    onRelayHelping: (callback) => ipcRenderer.on('relay:helping', (_, data) => callback(data)),
    // Event: relay status changed
    onRelayStatusChanged: (callback) => ipcRenderer.on('relay:statusChanged', (_, status) => callback(status))
  },

  // Groups
  group: {
    create: (name, memberIds) => ipcRenderer.invoke('group:create', name, memberIds)
  },

  // Videos (P2P, BitTorrent-style)
  video: {
    upload: (meta) => ipcRenderer.invoke('video:upload', meta),
    search: (q) => ipcRenderer.invoke('video:search', q),
    library: () => ipcRenderer.invoke('video:library'),
    watch: (id) => ipcRenderer.invoke('video:watch', id),
    stats: () => ipcRenderer.invoke('video:stats'),
    setStorage: (opts) => ipcRenderer.invoke('video:setStorage', opts),
    onProgress: (cb) => ipcRenderer.on('video:progress', (_, p) => cb(p))
  },

  // Backup
  backup: {
    getStatus: () => ipcRenderer.invoke('backup:getStatus'),
    connect: () => ipcRenderer.invoke('backup:connect'),
    authenticate: (code) => ipcRenderer.invoke('backup:authenticate', code),
    create: () => ipcRenderer.invoke('backup:create'),
    restore: () => ipcRenderer.invoke('backup:restore'),
    setAutoBackup: (enabled) => ipcRenderer.invoke('backup:setAutoBackup', enabled)
  }
});
