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

  // Groups
  group: {
    create: (name, memberIds) => ipcRenderer.invoke('group:create', name, memberIds)
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
