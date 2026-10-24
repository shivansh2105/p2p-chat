// P2P Chat - Renderer Application

let currentUser = null;
let currentChat = null;
let chats = [];
let messages = {};
let peerUsernames = {}; // Cache of peer usernames

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  await checkUser();
  setupEventListeners();
  startNetworkStatusUpdater();
  initializeRelay();  // Initialize volunteer relay server
});

async function checkUser() {
  currentUser = await api.user.get();
  
  if (currentUser) {
    showMainScreen();
    await loadChats();
    await updateNodeInfo();
  } else {
    showSetupScreen();
  }
}

function showSetupScreen() {
  document.getElementById('setupScreen').style.display = 'flex';
  document.getElementById('mainScreen').style.display = 'none';
}

function showMainScreen() {
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'flex';
}

function setupEventListeners() {
  // Setup screen
  document.getElementById('startBtn').addEventListener('click', createUser);
  document.getElementById('usernameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createUser();
  });

  // Menu
  document.getElementById('menuBtn').addEventListener('click', toggleMenu);
  document.getElementById('newChatBtn').addEventListener('click', () => openModal('newChatModal'));

  // Chat input
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('messageInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // Back button (mobile)
  document.getElementById('backBtn').addEventListener('click', closeActiveChat);

  // Modal tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Connect peer
  document.getElementById('connectPeerBtn').addEventListener('click', connectToPeer);

  // Search
  document.getElementById('searchInput').addEventListener('input', searchChats);

  // P2P events
  api.chat.onNewMessage(handleNewMessage);
  api.p2p.onPeerConnected(handlePeerConnected);
  api.p2p.onPeerDisconnected(handlePeerDisconnected);
  api.p2p.onPeerPresence(handlePeerPresence);

  // Click outside to close menu
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('mainMenu');
    const menuBtn = document.getElementById('menuBtn');
    if (!menu.contains(e.target) && !menuBtn.contains(e.target)) {
      menu.style.display = 'none';
    }
  });

  // Backup buttons
  document.getElementById('connectDriveBtn').addEventListener('click', connectGoogleDrive);
  document.getElementById('backupNowBtn').addEventListener('click', createBackup);
  
  // Save username button
  document.getElementById('saveUsernameBtn').addEventListener('click', saveUsername);
}

// User Management
async function createUser() {
  const username = document.getElementById('usernameInput').value.trim();
  if (!username) {
    document.getElementById('usernameInput').focus();
    return;
  }

  document.getElementById('startBtn').disabled = true;
  document.getElementById('startBtn').textContent = 'Setting up...';

  try {
    currentUser = await api.user.create(username);
    showMainScreen();
    await updateNodeInfo();
  } catch (error) {
    console.error('Failed to create user:', error);
    alert('Failed to create user. Please try again.');
  } finally {
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startBtn').textContent = 'Start Chatting';
  }
}

// Chat Management
async function loadChats() {
  try {
    chats = await api.chat.getAll();
    // Also load cached usernames
    peerUsernames = await api.p2p.getAllUsernames() || {};
    renderChatList();
  } catch (error) {
    console.error('Failed to load chats:', error);
  }
}

// Get display name for a peer (username > chat name > shortened ID)
function getDisplayName(chat) {
  // Priority: username from presence > stored name > shortened peer ID
  if (peerUsernames[chat.id]) {
    return peerUsernames[chat.id];
  }
  if (chat.name && !chat.name.startsWith('Peer ')) {
    return chat.name;
  }
  return shortenId(chat.id);
}

function renderChatList() {
  const chatList = document.getElementById('chatList');
  
  if (chats.length === 0) {
    chatList.innerHTML = `
      <div class="empty-state">
        <p>No chats yet</p>
        <p class="hint">Connect with a peer to start chatting</p>
      </div>
    `;
    return;
  }

  chatList.innerHTML = chats.map(chat => {
    const displayName = getDisplayName(chat);
    return `
    <div class="chat-item ${currentChat?.id === chat.id ? 'active' : ''}" 
         onclick="openChat('${chat.id}')" data-chat-id="${chat.id}">
      <div class="chat-avatar">${getInitials(displayName)}</div>
      <div class="chat-item-content">
        <div class="chat-item-header">
          <span class="chat-item-name">${escapeHtml(displayName)}</span>
          <span class="chat-item-time">${formatTime(chat.last_message_time)}</span>
        </div>
        <div class="chat-item-preview">${chat.last_message || 'No messages yet'}</div>
      </div>
      ${chat.unread_count > 0 ? `<span class="unread-badge">${chat.unread_count}</span>` : ''}
    </div>
  `;
  }).join('');
}

async function openChat(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  currentChat = chat;
  const displayName = getDisplayName(chat);
  
  // Update UI
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('activeChat').style.display = 'flex';
  document.getElementById('chatArea').classList.add('open');
  
  document.getElementById('chatName').textContent = displayName;
  document.getElementById('chatAvatar').textContent = getInitials(displayName);
  document.getElementById('chatStatus').textContent = 'online'; // Would be dynamic

  // Load messages
  await loadMessages(chatId);
  
  // Update chat list highlight
  renderChatList();
  
  // Focus input
  document.getElementById('messageInput').focus();
}

async function loadMessages(chatId) {
  try {
    const chatMessages = await api.chat.getMessages(chatId);
    messages[chatId] = chatMessages;
    renderMessages(chatMessages);
  } catch (error) {
    console.error('Failed to load messages:', error);
  }
}

function renderMessages(msgs) {
  const container = document.getElementById('messagesContainer');
  
  if (!msgs || msgs.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No messages yet. Say hello!</p></div>';
    return;
  }

  let html = '';
  let lastDate = null;

  for (const msg of msgs) {
    const msgDate = new Date(msg.timestamp).toDateString();
    
    if (msgDate !== lastDate) {
      html += `<div class="date-divider">${formatDate(msg.timestamp)}</div>`;
      lastDate = msgDate;
    }

    const isSent = msg.status === 'sent' || !msg.sender_id;
    
    html += `
      <div class="message ${isSent ? 'sent' : 'received'}">
        <div class="message-content">${escapeHtml(msg.content)}</div>
        <div class="message-time">
          ${formatMessageTime(msg.timestamp)}
          ${isSent ? `<span class="message-status ${msg.status}"></span>` : ''}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  
  if (!content || !currentChat) return;

  input.value = '';

  try {
    const message = await api.chat.sendMessage(currentChat.id, content);
    
    // Add to local messages
    if (!messages[currentChat.id]) messages[currentChat.id] = [];
    messages[currentChat.id].push(message);
    
    // Re-render
    renderMessages(messages[currentChat.id]);
    
    // Update chat list
    await loadChats();
  } catch (error) {
    console.error('Failed to send message:', error);
    input.value = content; // Restore message
  }
}

function handleNewMessage(message) {
  // Add to messages cache
  if (!messages[message.chatId]) messages[message.chatId] = [];
  messages[message.chatId].push(message);

  // If this chat is open, render it
  if (currentChat?.id === message.chatId) {
    renderMessages(messages[message.chatId]);
  }

  // Reload chat list to update preview
  loadChats();

  // Show notification if chat not open
  if (!currentChat || currentChat.id !== message.chatId) {
    showNotification('New message', message.content);
  }
}

function closeActiveChat() {
  currentChat = null;
  document.getElementById('chatArea').classList.remove('open');
  document.getElementById('chatEmpty').style.display = 'flex';
  document.getElementById('activeChat').style.display = 'none';
  renderChatList();
}

function searchChats() {
  const query = document.getElementById('searchInput').value.toLowerCase();
  const items = document.querySelectorAll('.chat-item');
  
  items.forEach(item => {
    const name = item.querySelector('.chat-item-name').textContent.toLowerCase();
    const preview = item.querySelector('.chat-item-preview').textContent.toLowerCase();
    const visible = name.includes(query) || preview.includes(query);
    item.style.display = visible ? 'flex' : 'none';
  });
}

// P2P Connection
async function connectToPeer() {
  const addressInput = document.getElementById('peerAddressInput');
  const address = addressInput.value.trim();
  
  if (!address) {
    alert('Please enter a peer address');
    return;
  }

  const btn = document.getElementById('connectPeerBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const result = await api.p2p.connectPeer(address);
    
    if (result.success) {
      addressInput.value = '';
      closeModal('newChatModal');
      
      // Extract peer ID from address and create chat
      const peerId = extractPeerId(address);
      if (peerId) {
        // Try to get username, fallback to peer ID
        const username = peerUsernames[peerId] || 'Peer ' + shortenId(peerId);
        await api.chat.create(peerId, username);
        await loadChats();
      }
    } else {
      alert('Failed to connect: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Connection error: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function handlePeerConnected(peer) {
  console.log('Peer connected:', peer.id);
  updateNetworkStatus(true);
  updateNearbyPeers();
}

function handlePeerDisconnected(peer) {
  console.log('Peer disconnected:', peer.id);
  updateNearbyPeers();
}

function handlePeerPresence(presence) {
  console.log('Peer presence:', presence);
  
  // Update username cache
  if (presence.username && presence.username !== 'Anonymous') {
    peerUsernames[presence.id] = presence.username;
    
    // Update UI if we have a chat with this peer
    const chat = chats.find(c => c.id === presence.id);
    if (chat) {
      renderChatList();
      
      // Update active chat header if this is the current chat
      if (currentChat?.id === presence.id) {
        document.getElementById('chatName').textContent = presence.username;
        document.getElementById('chatAvatar').textContent = getInitials(presence.username);
      }
    }
  }
}

async function updateNearbyPeers() {
  try {
    const peers = await api.p2p.getPeers();
    const container = document.getElementById('nearbyPeers');
    
    if (peers.length === 0) {
      container.innerHTML = '<p class="hint">No peers found nearby</p>';
      return;
    }

    container.innerHTML = peers.map(peer => {
      const username = peerUsernames[peer.id] || peer.username;
      const displayName = username || shortenId(peer.id);
      return `
      <div class="peer-list-item">
        <span title="${peer.id}">${escapeHtml(displayName)}</span>
        <button class="copy-btn" onclick="startChatWithPeer('${peer.id}', '${escapeHtml(displayName)}')">Chat</button>
      </div>
    `;
    }).join('');
  } catch (error) {
    console.error('Failed to get peers:', error);
  }
}

async function startChatWithPeer(peerId, displayName) {
  const name = displayName || peerUsernames[peerId] || 'Peer ' + shortenId(peerId);
  await api.chat.create(peerId, name);
  await loadChats();
  closeModal('newChatModal');
  openChat(peerId);
}

// Node Info
async function updateNodeInfo() {
  try {
    const info = await api.p2p.getNodeInfo();
    
    document.getElementById('peerIdDisplay').textContent = info.peerId;
    document.getElementById('settingsPeerId').textContent = shortenId(info.peerId);
    document.getElementById('settingsConnectedPeers').textContent = info.connectedPeers;
    
    if (info.addresses.length > 0) {
      document.getElementById('shareAddress').textContent = info.addresses[0];
    }

    updateNetworkStatus(info.connectedPeers > 0);
  } catch (error) {
    console.error('Failed to get node info:', error);
  }
}

function updateNetworkStatus(connected) {
  const status = document.getElementById('networkStatus');
  if (connected) {
    status.textContent = '● Online';
    status.classList.add('online');
  } else {
    status.textContent = '● Connecting...';
    status.classList.remove('online');
  }
}

function startNetworkStatusUpdater() {
  setInterval(async () => {
    try {
      const info = await api.p2p.getNodeInfo();
      updateNetworkStatus(info.connectedPeers > 0);
      document.getElementById('settingsConnectedPeers').textContent = info.connectedPeers;
    } catch (e) {}
  }, 5000);
}

// Google Drive Backup
async function connectGoogleDrive() {
  try {
    const authUrl = await api.backup.connect();
    
    // User will be redirected to Google auth
    const code = prompt('After authorizing, paste the code here:');
    if (code) {
      const result = await api.backup.authenticate(code);
      if (result.success) {
        alert('Google Drive connected successfully!');
        updateBackupStatus();
      } else {
        alert('Authentication failed: ' + result.error);
      }
    }
  } catch (error) {
    alert('Failed to connect: ' + error.message);
  }
}

async function createBackup() {
  const btn = document.getElementById('backupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Backing up...';

  try {
    const result = await api.backup.create();
    if (result.success) {
      alert(`Backup created! Size: ${formatSize(result.size)}`);
      updateBackupStatus();
    } else {
      alert('Backup failed: ' + result.error);
    }
  } catch (error) {
    alert('Backup error: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Backup Now';
  }
}

async function updateBackupStatus() {
  try {
    const status = await api.backup.getStatus();
    
    if (status.connected) {
      document.getElementById('backupStatus').textContent = 'Connected';
      document.getElementById('connectDriveBtn').style.display = 'none';
      document.getElementById('backupNowBtn').style.display = 'block';
      
      if (status.lastBackup) {
        document.getElementById('backupStatus').textContent = 
          `Last backup: ${formatDate(status.lastBackup.date)}`;
      }
      
      document.getElementById('autoBackupToggle').checked = status.autoBackupEnabled;
    }
  } catch (error) {
    console.error('Failed to get backup status:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════
// RELAY SERVER FUNCTIONS (Volunteer Node)
// ═══════════════════════════════════════════════════════════════════

async function initializeRelay() {
  const toggle = document.getElementById('relayToggle');
  if (!toggle) return;

  // Load current state
  try {
    const isEnabled = await api.relay.isEnabled();
    toggle.checked = isEnabled;
    await updateRelayStats();
  } catch (error) {
    console.error('Failed to get relay status:', error);
  }

  // Handle toggle
  toggle.addEventListener('change', async (e) => {
    try {
      if (e.target.checked) {
        await api.relay.enable();
        showToast('🌐 Relay enabled - Helping the network!');
      } else {
        await api.relay.disable();
        showToast('Relay disabled');
      }
      await updateRelayStats();
    } catch (error) {
      console.error('Failed to toggle relay:', error);
      e.target.checked = !e.target.checked; // Revert
    }
  });

  // Update stats periodically
  setInterval(updateRelayStats, 10000); // Every 10 seconds
}

async function updateRelayStats() {
  try {
    const stats = await api.relay.getStats();
    
    // Status
    const statusEl = document.getElementById('relayStatus');
    if (statusEl) {
      statusEl.textContent = stats.enabled ? '● Active' : '○ Inactive';
      statusEl.className = 'stat-value relay-status' + (stats.enabled ? '' : ' inactive');
    }
    
    // Uptime
    const uptimeEl = document.getElementById('relayUptime');
    if (uptimeEl) {
      const hours = Math.floor(stats.uptimeSeconds / 3600);
      const mins = Math.floor((stats.uptimeSeconds % 3600) / 60);
      uptimeEl.textContent = `${hours}h ${mins}m`;
    }
    
    // Data relayed
    const dataEl = document.getElementById('relayData');
    if (dataEl) {
      dataEl.textContent = `${stats.totalBytesRelayedMB || '0.00'} MB`;
    }
    
    // Peers helped
    const peersEl = document.getElementById('relayPeersHelped');
    if (peersEl) {
      peersEl.textContent = stats.peersHelped || 0;
    }
  } catch (error) {
    console.error('Failed to update relay stats:', error);
  }
}

// UI Helpers
function toggleMenu() {
  const menu = document.getElementById('mainMenu');
  const btn = document.getElementById('menuBtn');
  const rect = btn.getBoundingClientRect();
  
  menu.style.top = rect.bottom + 'px';
  menu.style.left = rect.left + 'px';
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Save username
async function saveUsername() {
  const input = document.getElementById('settingsUsername');
  const username = input.value.trim();
  
  if (!username) {
    alert('Please enter a username');
    return;
  }
  
  try {
    await api.user.updateUsername(username);
    currentUser.username = username;
    showToast('Username updated!');
  } catch (error) {
    alert('Failed to update username: ' + error.message);
  }
}

// Show contact info modal
function showContactInfo() {
  if (!currentChat) return;
  
  const displayName = getDisplayName(currentChat);
  document.getElementById('contactInfoAvatar').textContent = getInitials(displayName);
  document.getElementById('contactInfoUsername').textContent = displayName;
  document.getElementById('contactInfoPeerId').textContent = currentChat.id;
  document.getElementById('contactNicknameInput').value = currentChat.name || '';
  
  openModal('contactInfoModal');
}

// Save contact nickname
async function saveContactNickname() {
  if (!currentChat) return;
  
  const input = document.getElementById('contactNicknameInput');
  const nickname = input.value.trim();
  
  if (!nickname) {
    alert('Please enter a nickname');
    return;
  }
  
  try {
    await api.contact.setNickname(currentChat.id, nickname);
    
    // Update local cache
    peerUsernames[currentChat.id] = nickname;
    
    // Update current chat
    currentChat.name = nickname;
    
    // Update UI
    document.getElementById('chatName').textContent = nickname;
    document.getElementById('chatAvatar').textContent = getInitials(nickname);
    
    await loadChats();
    closeModal('contactInfoModal');
    showToast('Nickname saved!');
  } catch (error) {
    alert('Failed to save nickname: ' + error.message);
  }
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.getElementById('mainMenu').style.display = 'none';
  
  if (id === 'newChatModal') {
    updateNearbyPeers();
  } else if (id === 'settingsModal') {
    updateBackupStatus();
    // Load current username
    if (currentUser?.username) {
      document.getElementById('settingsUsername').value = currentUser.username;
    }
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  document.getElementById('connectTab').style.display = tabName === 'connect' ? 'block' : 'none';
  document.getElementById('shareTab').style.display = tabName === 'share' ? 'block' : 'none';
}

function showContacts() {
  // Would show contacts list
  document.getElementById('mainMenu').style.display = 'none';
}

async function showNodeInfo() {
  document.getElementById('mainMenu').style.display = 'none';
  const info = await api.p2p.getNodeInfo();
  alert(`Peer ID: ${info.peerId}\n\nAddresses:\n${info.addresses.join('\n')}\n\nConnected Peers: ${info.connectedPeers}`);
}

// Utility functions
function copyPeerId() {
  const peerId = document.getElementById('peerIdDisplay').textContent;
  navigator.clipboard.writeText(peerId);
  showToast('Peer ID copied!');
}

function copyShareAddress() {
  const address = document.getElementById('shareAddress').textContent;
  navigator.clipboard.writeText(address);
  showToast('Address copied!');
}

function showToast(message) {
  // Simple toast notification
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    z-index: 9999;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

function showNotification(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body: body.slice(0, 100) });
  }
}

function getInitials(name) {
  return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function shortenId(id) {
  if (!id) return 'Unknown';
  return id.slice(0, 8) + '...' + id.slice(-4);
}

function extractPeerId(address) {
  const match = address.match(/\/p2p\/([^/]+)/);
  return match ? match[1] : null;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMessageTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  
  if (date.toDateString() === now.toDateString()) {
    return 'Today';
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return bytes.toFixed(1) + ' ' + units[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}
