/**
 * P2P Chat Mobile App
 * Uses WebRTC + Circuit Relay for P2P connections on mobile
 */

import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { all } from '@libp2p/websockets/filters';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { v4 as uuidv4 } from 'uuid';
import { Preferences } from '@capacitor/preferences';

// App State
let node = null;
let username = '';
let peerId = '';
let currentChat = null;
let chats = {};
let messages = {};
let peerUsernames = {};

// Public relay servers for WebRTC signaling
const RELAY_SERVERS = [
  '/dns4/relay.p2pchat.example.com/tcp/443/wss/p2p-circuit',
  // Add more relay servers as fallbacks
];

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
  await loadStoredData();
  setupEventListeners();
  
  if (username) {
    showMainScreen();
    await initP2P();
  }
});

// Load stored data from Capacitor Preferences
async function loadStoredData() {
  const { value: storedUsername } = await Preferences.get({ key: 'username' });
  const { value: storedChats } = await Preferences.get({ key: 'chats' });
  const { value: storedMessages } = await Preferences.get({ key: 'messages' });
  
  if (storedUsername) username = storedUsername;
  if (storedChats) chats = JSON.parse(storedChats);
  if (storedMessages) messages = JSON.parse(storedMessages);
}

// Save data to storage
async function saveData() {
  await Preferences.set({ key: 'username', value: username });
  await Preferences.set({ key: 'chats', value: JSON.stringify(chats) });
  await Preferences.set({ key: 'messages', value: JSON.stringify(messages) });
}

// Setup event listeners
function setupEventListeners() {
  // Setup screen
  document.getElementById('start-btn').onclick = handleStart;
  document.getElementById('username-input').onkeypress = (e) => {
    if (e.key === 'Enter') handleStart();
  };
  
  // Main screen
  document.getElementById('new-chat-btn').onclick = () => openModal('new-chat-modal');
  document.getElementById('settings-btn').onclick = () => {
    document.getElementById('settings-username').value = username;
    document.getElementById('my-peer-id').textContent = peerId || 'Loading...';
    openModal('settings-modal');
  };
  
  // Chat view
  document.getElementById('back-btn').onclick = closeChat;
  document.getElementById('send-btn').onclick = sendMessage;
  document.getElementById('message-input').onkeypress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };
  
  // New chat modal
  document.getElementById('connect-peer-btn').onclick = connectToPeer;
  document.getElementById('copy-address-btn').onclick = copyMyAddress;
  
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });
  
  // Settings
  document.getElementById('save-settings-btn').onclick = saveSettings;
}

// Handle start button
async function handleStart() {
  const input = document.getElementById('username-input');
  const name = input.value.trim();
  
  if (!name) {
    input.style.borderColor = 'var(--error)';
    return;
  }
  
  username = name;
  await Preferences.set({ key: 'username', value: username });
  
  showMainScreen();
  await initP2P();
}

// Show main screen
function showMainScreen() {
  document.getElementById('setup-screen').classList.remove('active');
  document.getElementById('main-screen').classList.add('active');
  renderChatList();
}

// Initialize P2P node
async function initP2P() {
  try {
    updatePeerStatus('Initializing P2P...');
    
    node = await createLibp2p({
      transports: [
        webSockets({ filter: all }),
        webRTC(),
        circuitRelayTransport()
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        pubsub: gossipsub({
          emitSelf: false,
          gossipIncoming: true,
          fallbackToFloodsub: true
        })
      }
    });
    
    await node.start();
    peerId = node.peerId.toString();
    
    console.log('P2P node started:', peerId);
    
    // Subscribe to chat topics
    node.services.pubsub.subscribe('p2p-chat:messages');
    node.services.pubsub.subscribe('p2p-chat:presence');
    
    // Handle incoming messages
    node.services.pubsub.addEventListener('message', handlePubsubMessage);
    
    // Handle peer connections
    node.addEventListener('peer:connect', handlePeerConnect);
    node.addEventListener('peer:disconnect', handlePeerDisconnect);
    
    // Update UI
    updateMyAddress();
    updatePeerStatus(`Online • ${node.getPeers().length} peers`);
    
    // Announce presence
    announcePresence();
    setInterval(announcePresence, 30000);
    
  } catch (error) {
    console.error('Failed to initialize P2P:', error);
    updatePeerStatus('Connection failed');
  }
}

// Handle pubsub messages
function handlePubsubMessage(event) {
  const topic = event.detail.topic;
  const data = JSON.parse(uint8ArrayToString(event.detail.data));
  
  if (topic === 'p2p-chat:messages') {
    handleIncomingMessage(data);
  } else if (topic === 'p2p-chat:presence') {
    handlePresence(data);
  }
}

// Handle incoming chat message
function handleIncomingMessage(data) {
  const { from, to, content, timestamp, id } = data;
  
  // Check if message is for us
  if (to !== peerId && to !== 'all') return;
  
  const chatId = from;
  
  // Create chat if doesn't exist
  if (!chats[chatId]) {
    chats[chatId] = {
      id: chatId,
      name: peerUsernames[from] || `Peer ${from.slice(-8)}`,
      lastMessage: content,
      lastMessageTime: timestamp,
      unread: 0
    };
  }
  
  // Add message
  if (!messages[chatId]) messages[chatId] = [];
  messages[chatId].push({
    id,
    content,
    timestamp,
    sent: false
  });
  
  // Update chat
  chats[chatId].lastMessage = content;
  chats[chatId].lastMessageTime = timestamp;
  if (currentChat !== chatId) {
    chats[chatId].unread = (chats[chatId].unread || 0) + 1;
  }
  
  saveData();
  
  // Update UI
  if (currentChat === chatId) {
    renderMessages();
  } else {
    renderChatList();
  }
  
  // Vibrate for notification
  if ('vibrate' in navigator) {
    navigator.vibrate(200);
  }
}

// Handle presence announcement
function handlePresence(data) {
  const { peerId: fromPeerId, username: peerUsername } = data;
  if (fromPeerId && peerUsername) {
    peerUsernames[fromPeerId] = peerUsername;
    
    // Update chat name if exists
    if (chats[fromPeerId]) {
      chats[fromPeerId].name = peerUsername;
      renderChatList();
    }
  }
}

// Announce our presence
async function announcePresence() {
  if (!node) return;
  
  const presence = {
    peerId,
    username,
    timestamp: Date.now()
  };
  
  try {
    await node.services.pubsub.publish(
      'p2p-chat:presence',
      uint8ArrayFromString(JSON.stringify(presence))
    );
  } catch (e) {
    console.warn('Failed to announce presence:', e);
  }
}

// Handle peer connect
function handlePeerConnect(event) {
  console.log('Peer connected:', event.detail.toString());
  updatePeerStatus(`Online • ${node.getPeers().length} peers`);
  announcePresence();
}

// Handle peer disconnect
function handlePeerDisconnect(event) {
  console.log('Peer disconnected:', event.detail.toString());
  updatePeerStatus(`Online • ${node.getPeers().length} peers`);
}

// Connect to peer
async function connectToPeer() {
  const input = document.getElementById('peer-address-input');
  const address = input.value.trim();
  
  if (!address) return;
  
  try {
    const ma = multiaddr(address);
    await node.dial(ma);
    
    // Extract peer ID from multiaddr
    const peerIdStr = ma.getPeerId();
    if (peerIdStr && !chats[peerIdStr]) {
      chats[peerIdStr] = {
        id: peerIdStr,
        name: `Peer ${peerIdStr.slice(-8)}`,
        lastMessage: '',
        lastMessageTime: Date.now(),
        unread: 0
      };
      saveData();
      renderChatList();
    }
    
    closeModal();
    input.value = '';
    
  } catch (error) {
    console.error('Failed to connect:', error);
    alert('Failed to connect to peer');
  }
}

// Send message
async function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  
  if (!content || !currentChat) return;
  
  const msg = {
    id: uuidv4(),
    from: peerId,
    to: currentChat,
    content,
    timestamp: Date.now()
  };
  
  // Add to local messages
  if (!messages[currentChat]) messages[currentChat] = [];
  messages[currentChat].push({
    id: msg.id,
    content,
    timestamp: msg.timestamp,
    sent: true
  });
  
  // Update chat
  chats[currentChat].lastMessage = content;
  chats[currentChat].lastMessageTime = msg.timestamp;
  
  saveData();
  renderMessages();
  input.value = '';
  
  // Send via pubsub
  try {
    await node.services.pubsub.publish(
      'p2p-chat:messages',
      uint8ArrayFromString(JSON.stringify(msg))
    );
  } catch (e) {
    console.warn('Failed to send message:', e);
  }
}

// Render chat list
function renderChatList() {
  const list = document.getElementById('chat-list');
  const chatArray = Object.values(chats).sort((a, b) => 
    (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
  );
  
  if (chatArray.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No chats yet</p>
        <p class="hint">Tap + to connect with someone</p>
      </div>
    `;
    return;
  }
  
  list.innerHTML = chatArray.map(chat => `
    <div class="chat-item" onclick="openChat('${chat.id}')">
      <div class="chat-avatar">${(chat.name || 'P')[0].toUpperCase()}</div>
      <div class="chat-details">
        <h3>${escapeHtml(chat.name || 'Unknown')}</h3>
        <p>${escapeHtml(chat.lastMessage || 'No messages')}</p>
      </div>
      <div class="chat-meta">
        <div class="chat-time">${formatTime(chat.lastMessageTime)}</div>
        ${chat.unread ? `<div class="unread-badge">${chat.unread}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// Open chat
window.openChat = function(chatId) {
  currentChat = chatId;
  const chat = chats[chatId];
  
  document.getElementById('chat-name').textContent = chat?.name || 'Chat';
  document.getElementById('chat-status').textContent = 'connected';
  
  // Mark as read
  if (chat) {
    chat.unread = 0;
    saveData();
  }
  
  document.getElementById('chat-list-view').classList.remove('active');
  document.getElementById('chat-view').classList.add('active');
  
  renderMessages();
};

// Close chat
function closeChat() {
  currentChat = null;
  document.getElementById('chat-view').classList.remove('active');
  document.getElementById('chat-list-view').classList.add('active');
  renderChatList();
}

// Render messages
function renderMessages() {
  const container = document.getElementById('messages');
  const chatMessages = messages[currentChat] || [];
  
  container.innerHTML = chatMessages.map(msg => `
    <div class="message ${msg.sent ? 'sent' : 'received'}">
      ${escapeHtml(msg.content)}
      <div class="message-time">${formatTime(msg.timestamp)}</div>
    </div>
  `).join('');
  
  container.scrollTop = container.scrollHeight;
}

// Update my address display
function updateMyAddress() {
  const el = document.getElementById('my-address');
  if (node) {
    const addrs = node.getMultiaddrs();
    el.textContent = addrs.length > 0 
      ? addrs[0].toString()
      : `No public address yet. Peer ID: ${peerId}`;
  }
}

// Copy my address
async function copyMyAddress() {
  const addr = document.getElementById('my-address').textContent;
  try {
    await navigator.clipboard.writeText(addr);
    alert('Address copied!');
  } catch (e) {
    // Fallback for older devices
    const el = document.createElement('textarea');
    el.value = addr;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    alert('Address copied!');
  }
}

// Update peer status
function updatePeerStatus(status) {
  document.getElementById('peer-count').textContent = status;
}

// Save settings
async function saveSettings() {
  const newUsername = document.getElementById('settings-username').value.trim();
  if (newUsername) {
    username = newUsername;
    await Preferences.set({ key: 'username', value: username });
    announcePresence();
  }
  closeModal();
}

// Modal functions
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

window.closeModal = function() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
};

// Tab switching
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`${tabName}-tab`).classList.add('active');
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
