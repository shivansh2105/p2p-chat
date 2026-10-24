/**
 * Local JSON Database (No native dependencies - works everywhere)
 * Stores all chats and messages locally using electron-store
 */

const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');

class ChatDatabase {
  constructor(userDataPath) {
    this.store = new Store({
      name: 'p2p-chat-data',
      cwd: userDataPath,
      defaults: {
        contacts: {},
        chats: {},
        messages: {},
        groups: {},
        backupHistory: []
      }
    });
  }

  async initialize() {
    return this;
  }

  // CONTACTS
  addContact(id, username, publicKey) {
    const contacts = this.store.get('contacts', {});
    contacts[id] = {
      id, username, publicKey,
      lastSeen: Date.now(),
      createdAt: contacts[id]?.createdAt || Date.now()
    };
    this.store.set('contacts', contacts);
    return contacts[id];
  }

  updateContactUsername(id, username) {
    const contacts = this.store.get('contacts', {});
    if (contacts[id]) {
      contacts[id].username = username;
      contacts[id].lastSeen = Date.now();
    } else {
      contacts[id] = { id, username, lastSeen: Date.now(), createdAt: Date.now() };
    }
    this.store.set('contacts', contacts);
    this.updateChatName(id, username);
  }

  getContact(id) {
    return this.store.get('contacts', {})[id] || null;
  }

  getAllContacts() {
    return Object.values(this.store.get('contacts', {}))
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  }

  // CHATS
  createChat(peerId, peerName, type = 'direct') {
    const chats = this.store.get('chats', {});
    const id = type === 'direct' ? peerId : uuidv4();
    
    if (!chats[id]) {
      chats[id] = {
        id, type, name: peerName, peerId,
        createdAt: Date.now(), updatedAt: Date.now(),
        unreadCount: 0, pinned: false, muted: false, archived: false
      };
      this.store.set('chats', chats);
    }
    return this.getChat(id);
  }

  updateChatName(chatId, name) {
    const chats = this.store.get('chats', {});
    if (chats[chatId]) {
      chats[chatId].name = name;
      this.store.set('chats', chats);
    }
  }

  getChat(id) {
    const chat = this.store.get('chats', {})[id];
    if (!chat) return null;
    const chatMessages = this.store.get('messages', {})[id] || [];
    const lastMsg = chatMessages[chatMessages.length - 1];
    return {
      ...chat,
      last_message: lastMsg?.content || null,
      last_message_time: lastMsg?.timestamp || chat.updatedAt,
      last_message_type: lastMsg?.type || null
    };
  }

  getAllChats() {
    const chats = this.store.get('chats', {});
    const messages = this.store.get('messages', {});
    return Object.values(chats)
      .filter(c => !c.archived)
      .map(chat => {
        const chatMessages = messages[chat.id] || [];
        const lastMsg = chatMessages[chatMessages.length - 1];
        return {
          ...chat,
          last_message: lastMsg?.content || null,
          last_message_time: lastMsg?.timestamp || chat.updatedAt
        };
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned - a.pinned;
        return (b.last_message_time || 0) - (a.last_message_time || 0);
      });
  }

  updateChatUpdatedAt(chatId) {
    const chats = this.store.get('chats', {});
    if (chats[chatId]) {
      chats[chatId].updatedAt = Date.now();
      this.store.set('chats', chats);
    }
  }

  // GROUPS
  createGroup(name, memberIds) {
    const id = uuidv4();
    const now = Date.now();
    const chats = this.store.get('chats', {});
    chats[id] = { id, type: 'group', name, createdAt: now, updatedAt: now, unreadCount: 0 };
    this.store.set('chats', chats);
    const groups = this.store.get('groups', {});
    groups[id] = { id, name, members: memberIds, createdAt: now };
    this.store.set('groups', groups);
    return { id, name, type: 'group', members: memberIds, createdAt: now };
  }

  getGroupMembers(groupId) {
    return this.store.get('groups', {})[groupId]?.members || [];
  }

  // MESSAGES
  addMessage(chatId, content, type = 'text', status = 'sent', senderId = null, messageId = null) {
    const id = messageId || uuidv4();
    const timestamp = Date.now();
    if (!this.getChat(chatId)) this.createChat(chatId, chatId);

    const messages = this.store.get('messages', {});
    if (!messages[chatId]) messages[chatId] = [];

    const message = { id, chatId, senderId, content, type, status, timestamp, deleted: false };
    messages[chatId].push(message);
    this.store.set('messages', messages);
    this.updateChatUpdatedAt(chatId);

    if (status === 'received') {
      const chats = this.store.get('chats', {});
      if (chats[chatId]) {
        chats[chatId].unreadCount = (chats[chatId].unreadCount || 0) + 1;
        this.store.set('chats', chats);
      }
    }
    return message;
  }

  getMessages(chatId, limit = 50, offset = 0) {
    const messages = this.store.get('messages', {})[chatId] || [];
    return messages.filter(m => !m.deleted).slice(-limit - offset, offset ? -offset : undefined);
  }

  getMessagesSince(chatId, since, limit = 100) {
    const messages = this.store.get('messages', {})[chatId] || [];
    return messages.filter(m => !m.deleted && m.timestamp > since).slice(-limit);
  }

  markChatAsRead(chatId) {
    const messages = this.store.get('messages', {});
    (messages[chatId] || []).forEach(m => { m.status = 'read'; m.readAt = Date.now(); });
    this.store.set('messages', messages);
    const chats = this.store.get('chats', {});
    if (chats[chatId]) { chats[chatId].unreadCount = 0; this.store.set('chats', chats); }
  }

  // SEARCH
  searchMessages(query, chatId = null) {
    const messages = this.store.get('messages', {});
    const chats = this.store.get('chats', {});
    const results = [];
    const lowerQuery = query.toLowerCase();
    const searchIn = chatId ? { [chatId]: messages[chatId] } : messages;
    for (const [cid, chatMessages] of Object.entries(searchIn)) {
      for (const msg of chatMessages || []) {
        if (!msg.deleted && msg.content?.toLowerCase().includes(lowerQuery)) {
          results.push({ ...msg, chatName: chats[cid]?.name || cid });
        }
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  }

  // BACKUP
  addBackupHistory(type, fileId, size, status) {
    const history = this.store.get('backupHistory', []);
    history.push({ id: uuidv4(), type, fileId, size, status, createdAt: Date.now() });
    this.store.set('backupHistory', history.slice(-20));
  }

  getLastBackup() {
    return this.store.get('backupHistory', []).filter(h => h.status === 'success').pop() || null;
  }

  exportAll() {
    return {
      contacts: this.store.get('contacts', {}),
      chats: this.store.get('chats', {}),
      messages: this.store.get('messages', {}),
      groups: this.store.get('groups', {}),
      exportedAt: Date.now()
    };
  }

  importAll(data) {
    if (data.contacts) this.store.set('contacts', data.contacts);
    if (data.chats) this.store.set('chats', data.chats);
    if (data.messages) this.store.set('messages', data.messages);
    if (data.groups) this.store.set('groups', data.groups);
  }

  close() {}
}

module.exports = { Database: ChatDatabase };
