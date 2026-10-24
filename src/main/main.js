const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { P2PNode } = require('./p2p-node');
const { Database } = require('./database');
const { GoogleDriveBackup } = require('./google-drive');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let p2pNode;
let database;
let driveBackup;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#0e1621',
    icon: path.join(__dirname, '../renderer/assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

async function initializeApp() {
  // Initialize database
  database = new Database(app.getPath('userData'));
  await database.initialize();

  // Initialize P2P node
  p2pNode = new P2PNode(database, store);
  await p2pNode.start();

  // Initialize Google Drive backup
  driveBackup = new GoogleDriveBackup(database, store);

  // Set up IPC handlers
  setupIpcHandlers();
}

function setupIpcHandlers() {
  // Window controls
  ipcMain.on('window:minimize', () => mainWindow.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on('window:close', () => mainWindow.close());

  // User management
  ipcMain.handle('user:get', () => store.get('user'));
  ipcMain.handle('user:create', async (_, username) => {
    const user = {
      id: p2pNode.peerId,
      username,
      publicKey: p2pNode.publicKey,
      createdAt: Date.now()
    };
    store.set('user', user);
    return user;
  });

  // P2P operations
  ipcMain.handle('p2p:getPeerId', () => p2pNode.peerId);
  ipcMain.handle('p2p:getPeers', () => p2pNode.getConnectedPeers());
  ipcMain.handle('p2p:getNodeInfo', () => p2pNode.getNodeInfo());
  ipcMain.handle('p2p:connectPeer', (_, multiaddr) => p2pNode.connectToPeer(multiaddr));

  // Chat operations
  ipcMain.handle('chat:getAll', () => database.getAllChats());
  ipcMain.handle('chat:create', (_, peerId, peerName) => database.createChat(peerId, peerName));
  ipcMain.handle('chat:updateName', (_, chatId, name) => database.updateChatName(chatId, name));
  ipcMain.handle('chat:getMessages', (_, chatId, limit, offset) => 
    database.getMessages(chatId, limit, offset));
  
  ipcMain.handle('chat:sendMessage', async (_, chatId, content, type = 'text') => {
    const message = await database.addMessage(chatId, content, type, 'sent');
    await p2pNode.sendMessage(chatId, message);
    return message;
  });

  // Username operations
  ipcMain.handle('user:updateUsername', (_, username) => {
    const user = store.get('user');
    if (user) {
      user.username = username;
      store.set('user', user);
      p2pNode.announcePresence(); // Broadcast new username
    }
    return user;
  });
  
  ipcMain.handle('peer:getUsername', (_, peerId) => p2pNode.getPeerUsername(peerId));
  ipcMain.handle('peer:getAllUsernames', () => p2pNode.getAllPeerUsernames());
  ipcMain.handle('contact:get', (_, peerId) => database.getContact(peerId));
  ipcMain.handle('contact:setNickname', (_, peerId, nickname) => {
    database.updateContactUsername(peerId, nickname);
    database.updateChatName(peerId, nickname);
  });

  // ═══════════════════════════════════════════════════════════════════
  // USERNAME REGISTRY (DHT-based, like ENS)
  // ═══════════════════════════════════════════════════════════════════
  
  // Register a globally unique username
  ipcMain.handle('registry:register', async (_, username) => {
    try {
      const record = await p2pNode.registerUsername(username);
      // Also update local user store
      const user = store.get('user') || {};
      user.registeredUsername = username;
      user.publicKey = record.publicKey;
      store.set('user', user);
      return { success: true, record };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Lookup a user by username
  ipcMain.handle('registry:lookup', async (_, username) => {
    try {
      const record = await p2pNode.lookupUsername(username);
      return { success: true, record };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Search usernames by prefix
  ipcMain.handle('registry:search', (_, prefix) => {
    return p2pNode.searchUsernames(prefix);
  });

  // Connect to user by username
  ipcMain.handle('registry:connectByUsername', async (_, username) => {
    try {
      await p2pNode.connectByUsername(username);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get identity info (public key, fingerprint)
  ipcMain.handle('crypto:getIdentity', () => {
    return {
      publicKey: p2pNode.getIdentityPublicKey(),
      fingerprint: p2pNode.getNodeInfo().keyFingerprint,
      registeredUsername: p2pNode.getMyUsername()
    };
  });

  // Set optional coordination server
  ipcMain.handle('registry:setCoordServer', (_, url) => {
    p2pNode.setCoordinationServer(url);
    store.set('coordServer', url);
  });

  // ═══════════════════════════════════════════════════════════════════
  // VOLUNTEER RELAY SERVER (Like Tor/Bitcoin Node)
  // ═══════════════════════════════════════════════════════════════════

  // Enable relay server (start helping the network)
  ipcMain.handle('relay:enable', async () => {
    try {
      await p2pNode.enableRelay();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Disable relay server
  ipcMain.handle('relay:disable', async () => {
    try {
      await p2pNode.disableRelay();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Check if relay is enabled
  ipcMain.handle('relay:isEnabled', () => {
    return p2pNode.isRelayEnabled();
  });

  // Get relay statistics (how much you've helped)
  ipcMain.handle('relay:getStats', () => {
    return p2pNode.getRelayStats();
  });

  // Get list of known relay nodes
  ipcMain.handle('relay:getKnownRelays', () => {
    return p2pNode.getKnownRelays();
  });

  // Groups
  ipcMain.handle('group:create', async (_, name, memberIds) => {
    const group = await database.createGroup(name, memberIds);
    await p2pNode.announceGroup(group);
    return group;
  });

  // Google Drive backup
  ipcMain.handle('backup:getStatus', () => driveBackup.getStatus());
  ipcMain.handle('backup:connect', async () => {
    const authUrl = await driveBackup.getAuthUrl();
    shell.openExternal(authUrl);
    return authUrl;
  });
  ipcMain.handle('backup:authenticate', (_, code) => driveBackup.authenticate(code));
  ipcMain.handle('backup:create', () => driveBackup.createBackup());
  ipcMain.handle('backup:restore', () => driveBackup.restoreBackup());
  ipcMain.handle('backup:setAutoBackup', (_, enabled) => {
    store.set('autoBackup', enabled);
    if (enabled) driveBackup.startAutoBackup();
    else driveBackup.stopAutoBackup();
  });

  // P2P events to renderer
  p2pNode.on('message', (message) => {
    mainWindow.webContents.send('chat:newMessage', message);
  });

  p2pNode.on('peer:connected', (peer) => {
    mainWindow.webContents.send('p2p:peerConnected', peer);
  });

  p2pNode.on('peer:disconnected', (peer) => {
    mainWindow.webContents.send('p2p:peerDisconnected', peer);
  });

  p2pNode.on('peer:presence', (presence) => {
    // Update chat name when we receive username
    if (presence.username && presence.username !== 'Anonymous') {
      database.updateChatName(presence.id, presence.username);
    }
    mainWindow.webContents.send('p2p:peerPresence', presence);
  });
}

app.whenReady().then(async () => {
  createWindow();
  await initializeApp();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (p2pNode) await p2pNode.stop();
  if (process.platform !== 'darwin') app.quit();
});
