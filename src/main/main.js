const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');

// p2pvideo://v/<id> — streams video bytes straight from the chunk store,
// fetching missing chunks from the swarm on demand (play before fully downloaded)
protocol.registerSchemesAsPrivileged([
  { scheme: 'p2pvideo', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);
const path = require('path');
const { P2PNode } = require('./p2p-node');
const { Database } = require('./database');
const { GoogleDriveBackup } = require('./google-drive');
const Store = require('electron-store');

const store = new Store();

// IPC handlers are registered immediately (so the window never hits "No handler
// registered"), but each call waits until the P2P node has finished starting.
let markReady;
const ready = new Promise((r) => (markReady = r));
const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => rawHandle(channel, async (...args) => { await ready; return fn(...args); });
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

  forwardP2PEvents();
  markReady();
}

// ─────────────────────────── VIDEO ───────────────────────────
const summarize = (v) => v && ({
  id: v.id, title: v.title, description: v.description, tags: v.tags || [], size: v.size,
  chunkCount: v.chunkCount, mimeType: v.mimeType, uploaderName: v.uploaderName,
  uploadedAt: v.uploadedAt, replicas: (v.replicas || []).length,
  local: p2pNode.videoStore.seeding.has(v.id),
  have: p2pNode.videoStore.getAvailableChunks(v.id).length
});

function setupVideo() {
  const vs = new Proxy({}, { get: (_, k) => { const t = p2pNode.videoStore; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });

  protocol.handle('p2pvideo', async (req) => {
    await ready;
    try {
      const id = new URL(req.url).pathname.replace(/^\//, '');
      const v = vs.getVideo(id);
      if (!v) return new Response('not found', { status: 404 });
      const CS = v.chunkSize || 256 * 1024;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      let start = m && m[1] ? Number(m[1]) : 0;
      // Serve ~2MB per request so playback starts fast; the player asks for more
      let end = m && m[2] ? Math.min(Number(m[2]), v.size - 1) : Math.min(start + 2 * 1024 * 1024 - 1, v.size - 1);
      if (start >= v.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${v.size}` } });
      const first = Math.floor(start / CS), last = Math.floor(end / CS);
      const hashes = v.chunkHashes.slice(first, last + 1);
      await p2pNode.videoProtocol.ensureChunks(id, hashes);
      const buf = Buffer.concat(hashes.map((h) => vs.getChunk(h))).subarray(start - first * CS, end - first * CS + 1);
      return new Response(buf, {
        status: 206,
        headers: {
          'Content-Type': v.mimeType || 'video/mp4', 'Content-Length': String(buf.length),
          'Content-Range': `bytes ${start}-${end}/${v.size}`, 'Accept-Ranges': 'bytes'
        }
      });
    } catch (e) {
      return new Response(String(e.message), { status: 503 });
    }
  });

  ipcMain.handle('video:upload', async (_, meta = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Upload a video', properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const title = String(meta.title || '').slice(0, 120) || path.basename(r.filePaths[0]);
    const tags = (Array.isArray(meta.tags) ? meta.tags : []).map((t) => String(t).slice(0, 30)).slice(0, 10);
    const v = await p2pNode.uploadVideo(r.filePaths[0], { title, tags, description: String(meta.description || '').slice(0, 1000) });
    vs.touch(v.id);
    return summarize(v);
  });

  ipcMain.handle('video:search', async (_, q) => {
    const results = await p2pNode.searchVideos(String(q || '').slice(0, 100));
    return results.map((r) => summarize(vs.getVideo(r.id) || r)).filter(Boolean);
  });

  ipcMain.handle('video:library', () => vs.getAllVideos().map(summarize));

  ipcMain.handle('video:watch', (_, id) => {
    const v = vs.getVideo(String(id));
    if (!v) throw new Error('Unknown video');
    vs.touch(v.id);
    // Keep downloading in the background → becomes a full seeder
    if (!vs.seeding.has(v.id)) {
      p2pNode.downloadVideo(v.id, (p) => mainWindow?.webContents.send('video:progress', { id: v.id, ...p }))
        .then(() => mainWindow?.webContents.send('video:progress', { id: v.id, percent: 100, done: true }))
        .catch((e) => mainWindow?.webContents.send('video:progress', { id: v.id, error: e.message }));
    }
    return `p2pvideo://v/${v.id}`;
  });

  ipcMain.handle('video:stats', () => ({
    ...p2pNode.getVideoStats(),
    storageEnabled: store.get('storageEnabled', true),
    quotaMB: store.get('storageQuotaMB', 5120)
  }));

  ipcMain.handle('video:setStorage', (_, { enabled, quotaMB } = {}) => {
    if (typeof enabled === 'boolean') store.set('storageEnabled', enabled);
    if (Number.isFinite(quotaMB) && quotaMB >= 100 && quotaMB <= 1024 * 1024) store.set('storageQuotaMB', Math.round(quotaMB));
    return true;
  });
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
    // SECURITY: Input validation
    if (!username || typeof username !== 'string') {
      throw new Error('Invalid username');
    }
    // Sanitize username - only allow safe characters
    const sanitizedUsername = username.replace(/[<>\"'&]/g, '').slice(0, 50);
    if (sanitizedUsername.length < 1) {
      throw new Error('Username too short or contains invalid characters');
    }
    
    const user = {
      id: p2pNode.peerId,
      username: sanitizedUsername,
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
    // SECURITY: Input validation
    if (!username || typeof username !== 'string') {
      throw new Error('Invalid username');
    }
    const sanitizedUsername = username.replace(/[<>\"'&]/g, '').slice(0, 50);
    if (sanitizedUsername.length < 1) {
      throw new Error('Username too short or contains invalid characters');
    }
    
    const user = store.get('user');
    if (user) {
      user.username = sanitizedUsername;
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
}

// P2P → renderer events (needs a started node)
function forwardP2PEvents() {
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
    // SECURITY: Sanitize username to prevent XSS
    if (presence.username && typeof presence.username === 'string') {
      presence.username = presence.username.replace(/[<>\"'&]/g, '').slice(0, 50);
    }
    
    // Update chat name when we receive username
    if (presence.username && presence.username !== 'Anonymous') {
      database.updateChatName(presence.id, presence.username);
    }
    mainWindow.webContents.send('p2p:peerPresence', presence);
  });
}

app.whenReady().then(async () => {
  setupIpcHandlers();
  setupVideo();
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
