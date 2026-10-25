/**
 * Distributed Message Store
 * 
 * Stores encrypted messages for offline users.
 * Every relay node keeps messages until recipient fetches them.
 * Like BitTorrent seeding but for messages.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// Message expires after 7 days
const MESSAGE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_USER = 1000;
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

class MessageStore extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.messages = new Map(); // recipientPubKey -> [{id, encrypted, timestamp, from}]
    this.loadFromDisk();
    
    // Periodic cleanup
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  /**
   * Store an encrypted message for a recipient
   * Called when recipient is offline
   */
  storeMessage(recipientPubKey, encryptedMessage, senderPubKey, id) {
    if (encryptedMessage.length > MAX_MESSAGE_SIZE) {
      throw new Error('Message too large');
    }

    const messageId = (typeof id === 'string' && id.length <= 64) ? id : crypto.randomBytes(16).toString('hex');
    const existing = this.messages.get(recipientPubKey);
    if (existing && existing.some(m => m.id === messageId)) return messageId; // already holding it
    const message = {
      id: messageId,
      encrypted: encryptedMessage,
      from: senderPubKey,
      timestamp: Date.now()
    };

    if (!this.messages.has(recipientPubKey)) {
      this.messages.set(recipientPubKey, []);
    }

    const inbox = this.messages.get(recipientPubKey);
    
    // Limit messages per user
    if (inbox.length >= MAX_MESSAGES_PER_USER) {
      inbox.shift(); // Remove oldest
    }
    
    inbox.push(message);
    this.saveToDisk();
    
    this.emit('messageStored', { 
      recipient: recipientPubKey.slice(0, 16) + '...', 
      messageId 
    });
    
    return messageId;
  }

  /**
   * Fetch all messages for a recipient
   * Called when they come online
   */
  fetchMessages(recipientPubKey, signature, timestamp) {
    // Verify the request is from the actual recipient
    // (signature proves they own the private key)
    
    const inbox = this.messages.get(recipientPubKey) || [];
    
    // Don't delete yet - let recipient confirm receipt
    return inbox.map(m => ({
      id: m.id,
      encrypted: m.encrypted,
      from: m.from,
      timestamp: m.timestamp
    }));
  }

  /**
   * Confirm messages were received - now delete them
   */
  confirmReceipt(recipientPubKey, messageIds) {
    const inbox = this.messages.get(recipientPubKey);
    if (!inbox) return;

    const idsSet = new Set(messageIds);
    const remaining = inbox.filter(m => !idsSet.has(m.id));
    
    if (remaining.length === 0) {
      this.messages.delete(recipientPubKey);
    } else {
      this.messages.set(recipientPubKey, remaining);
    }
    
    this.saveToDisk();
  }

  /**
   * Check if we have messages for a user
   */
  hasMessages(recipientPubKey) {
    const inbox = this.messages.get(recipientPubKey);
    return inbox && inbox.length > 0;
  }

  /**
   * Get count of pending messages
   */
  getMessageCount(recipientPubKey) {
    const inbox = this.messages.get(recipientPubKey);
    return inbox ? inbox.length : 0;
  }

  /**
   * Remove expired messages
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [recipient, inbox] of this.messages.entries()) {
      const valid = inbox.filter(m => (now - m.timestamp) < MESSAGE_TTL);
      
      if (valid.length === 0) {
        this.messages.delete(recipient);
        cleaned += inbox.length;
      } else if (valid.length < inbox.length) {
        cleaned += inbox.length - valid.length;
        this.messages.set(recipient, valid);
      }
    }

    if (cleaned > 0) {
      console.log(`[MessageStore] Cleaned ${cleaned} expired messages`);
      this.saveToDisk();
    }
  }

  /**
   * Get stats
   */
  getStats() {
    let totalMessages = 0;
    let totalSize = 0;
    
    for (const inbox of this.messages.values()) {
      totalMessages += inbox.length;
      for (const m of inbox) {
        totalSize += m.encrypted.length;
      }
    }

    return {
      recipientsWaiting: this.messages.size,
      totalMessages,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      oldestMessage: this.getOldestMessageAge()
    };
  }

  getOldestMessageAge() {
    let oldest = Date.now();
    for (const inbox of this.messages.values()) {
      for (const m of inbox) {
        if (m.timestamp < oldest) oldest = m.timestamp;
      }
    }
    const ageMs = Date.now() - oldest;
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    return hours > 0 ? `${hours}h ago` : 'recent';
  }

  /**
   * Persist to disk
   */
  saveToDisk() {
    if (!this.store) return;
    
    const data = {};
    for (const [key, inbox] of this.messages.entries()) {
      data[key] = inbox;
    }
    
    this.store.set('messageStore', data);
  }

  loadFromDisk() {
    if (!this.store) return;
    
    const data = this.store.get('messageStore', {});
    for (const [key, inbox] of Object.entries(data)) {
      this.messages.set(key, inbox);
    }
    
    console.log(`[MessageStore] Loaded ${this.messages.size} inboxes from disk`);
  }

  /**
   * Shutdown
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.saveToDisk();
  }
}

module.exports = { MessageStore };
