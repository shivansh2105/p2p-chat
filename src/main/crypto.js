/**
 * P2P Chat Crypto Module (Security Hardened)
 * 
 * SECURITY FIXES APPLIED:
 * - Private key encrypted at rest using Electron safeStorage or machine-derived key
 * - Key ratcheting for Perfect Forward Secrecy (PFS)
 * - Message sequence numbers to prevent replay attacks
 * - Dynamic HKDF salt using peer IDs
 * - Strong scrypt parameters (N=2^17)
 * - Memory clearing for sensitive data
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Try to use Electron's secure storage
let safeStorage = null;
try {
  const { safeStorage: ss } = require('electron');
  if (ss && ss.isEncryptionAvailable()) {
    safeStorage = ss;
  }
} catch (e) {}

class P2PCrypto {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.identityKeyPair = null;
    this.sessionKeys = new Map();
  }

  async initializeIdentity() {
    const keyPath = path.join(this.dataDir, 'identity.key');
    const encryptedKeyPath = path.join(this.dataDir, 'identity.key.enc');
    
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });

      if (fs.existsSync(encryptedKeyPath)) {
        const encryptedData = fs.readFileSync(encryptedKeyPath);
        let keyData;
        
        if (safeStorage) {
          const decrypted = safeStorage.decryptString(encryptedData);
          keyData = JSON.parse(decrypted);
        } else {
          keyData = this.decryptKeyFile(encryptedData);
        }
        
        this.identityKeyPair = {
          publicKey: Buffer.from(keyData.publicKey, 'base64'),
          privateKey: Buffer.from(keyData.privateKey, 'base64')
        };
        console.log('[Crypto] Loaded encrypted identity key');
      } 
      else if (fs.existsSync(keyPath)) {
        // Migrate old plaintext key
        const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        this.identityKeyPair = {
          publicKey: Buffer.from(keyData.publicKey, 'base64'),
          privateKey: Buffer.from(keyData.privateKey, 'base64')
        };
        await this.saveIdentitySecure();
        this.secureDelete(keyPath);
        console.log('[Crypto] Migrated identity key to encrypted storage');
      } 
      else {
        this.identityKeyPair = await this.generateEd25519KeyPair();
        await this.saveIdentitySecure();
        console.log('[Crypto] Generated new identity key');
      }
      
      return this.getPublicKeyFingerprint();
    } catch (error) {
      console.error('[Crypto] Failed to initialize identity:', error.message);
      throw error;
    }
  }

  async saveIdentitySecure() {
    const encryptedKeyPath = path.join(this.dataDir, 'identity.key.enc');
    const keyData = JSON.stringify({
      publicKey: this.identityKeyPair.publicKey.toString('base64'),
      privateKey: this.identityKeyPair.privateKey.toString('base64'),
      version: 2
    });

    if (safeStorage) {
      const encrypted = safeStorage.encryptString(keyData);
      fs.writeFileSync(encryptedKeyPath, encrypted, { mode: 0o600 });
    } else {
      const encrypted = this.encryptKeyFile(keyData);
      fs.writeFileSync(encryptedKeyPath, encrypted, { mode: 0o600 });
    }
  }

  encryptKeyFile(data) {
    const machineId = this.getMachineEntropy();
    const salt = crypto.randomBytes(32);
    const key = crypto.scryptSync(machineId, salt, 32, { N: 2 ** 17, r: 8, p: 1 });
    const iv = crypto.randomBytes(12);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(data, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([Buffer.from([2]), salt, iv, authTag, encrypted]);
  }

  decryptKeyFile(data) {
    const version = data[0];
    if (version !== 2) throw new Error('Unknown key file version');
    
    const salt = data.slice(1, 33);
    const iv = data.slice(33, 45);
    const authTag = data.slice(45, 61);
    const encrypted = data.slice(61);
    
    const machineId = this.getMachineEntropy();
    const key = crypto.scryptSync(machineId, salt, 32, { N: 2 ** 17, r: 8, p: 1 });
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return JSON.parse(decrypted.toString('utf8'));
  }

  getMachineEntropy() {
    const os = require('os');
    const components = [
      os.hostname(), os.homedir(), os.platform(), os.arch(),
      process.env.USERNAME || process.env.USER || '', this.dataDir
    ];
    return crypto.createHash('sha256').update(components.join('|')).digest();
  }

  secureDelete(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const fd = fs.openSync(filePath, 'r+');
        fs.writeSync(fd, crypto.randomBytes(stats.size));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch (e2) {}
    }
  }

  async generateEd25519KeyPair() {
    return new Promise((resolve, reject) => {
      crypto.generateKeyPair('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      }, (err, publicKey, privateKey) => {
        if (err) reject(err);
        else resolve({ publicKey, privateKey });
      });
    });
  }

  generateEphemeralKeyPair() {
    const ecdh = crypto.createECDH('x25519');
    ecdh.generateKeys();
    return { publicKey: ecdh.getPublicKey(), privateKey: ecdh.getPrivateKey(), ecdh };
  }

  getPublicKeyFingerprint() {
    if (!this.identityKeyPair) return null;
    return crypto.createHash('sha256').update(this.identityKeyPair.publicKey).digest().slice(0, 8).toString('hex');
  }

  getPublicKey() {
    if (!this.identityKeyPair) return null;
    return this.identityKeyPair.publicKey.toString('base64');
  }

  sign(data) {
    if (!this.identityKeyPair) throw new Error('Identity not initialized');
    const privateKey = crypto.createPrivateKey({
      key: this.identityKeyPair.privateKey, format: 'der', type: 'pkcs8'
    });
    return crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
  }

  verify(data, signature, publicKeyBase64) {
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki'
      });
      return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64'));
    } catch (error) {
      return false;
    }
  }

  initiateSession(peerId, ourPeerId) {
    const ephemeral = this.generateEphemeralKeyPair();
    this.sessionKeys.set(peerId, {
      ourEphemeral: ephemeral, ourPeerId: ourPeerId || 'unknown', theirPeerId: peerId,
      theirPublic: null, sharedSecret: null, chainKey: null,
      messageCounter: 0, receivedCounters: new Set(), initiated: true, createdAt: Date.now()
    });
    return ephemeral.publicKey.toString('base64');
  }

  completeSession(peerId, theirPublicKeyBase64, ourPeerId) {
    let session = this.sessionKeys.get(peerId);
    
    if (!session) {
      const ephemeral = this.generateEphemeralKeyPair();
      session = {
        ourEphemeral: ephemeral, ourPeerId: ourPeerId || 'unknown', theirPeerId: peerId,
        theirPublic: Buffer.from(theirPublicKeyBase64, 'base64'),
        sharedSecret: null, chainKey: null, messageCounter: 0,
        receivedCounters: new Set(), initiated: false, createdAt: Date.now()
      };
    } else {
      session.theirPublic = Buffer.from(theirPublicKeyBase64, 'base64');
    }
    
    session.sharedSecret = session.ourEphemeral.ecdh.computeSecret(session.theirPublic);
    
    // SECURITY: Unique salt from peer IDs
    const peerIds = [session.ourPeerId, session.theirPeerId].sort();
    const salt = crypto.createHash('sha256').update(peerIds.join(':')).digest();
    
    session.chainKey = crypto.hkdfSync('sha256', session.sharedSecret, salt, 'p2p-chat-chain-v2', 32);
    
    // SECURITY: Clear sensitive ephemeral material after key derivation
    if (session.ourEphemeral.privateKey) session.ourEphemeral.privateKey.fill(0);
    session.sharedSecret.fill(0);
    session.sharedSecret = null;
    session.ourEphemeral.ecdh = null; // Remove ECDH object containing private key
    
    this.sessionKeys.set(peerId, session);
    
    return session.ourEphemeral.publicKey.toString('base64');
  }

  ratchetChainKey(session) {
    session.chainKey = crypto.hkdfSync('sha256', session.chainKey, Buffer.from('ratchet'), 'chain-ratchet', 32);
    return crypto.hkdfSync('sha256', session.chainKey, Buffer.from('message'), 'message-key', 32);
  }

  hasSession(peerId) {
    const session = this.sessionKeys.get(peerId);
    return session && session.sharedSecret;
  }

  encryptMessage(peerId, plaintext) {
    const session = this.sessionKeys.get(peerId);
    if (!session || !session.chainKey) throw new Error('No encryption session with peer');
    
    session.messageCounter++;
    const messageKey = this.ratchetChainKey(session);
    const iv = crypto.randomBytes(12);
    
    // Include message number for replay protection
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(BigInt(session.messageCounter));
    const payload = Buffer.concat([header, Buffer.from(plaintext, 'utf8')]);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', messageKey, iv);
    let encrypted = cipher.update(payload);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    messageKey.fill(0);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  decryptMessage(peerId, ciphertext) {
    const session = this.sessionKeys.get(peerId);
    if (!session || !session.chainKey) throw new Error('No decryption session with peer');
    
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.slice(0, 12);
    const authTag = data.slice(12, 28);
    const encrypted = data.slice(28);
    
    const messageKey = this.ratchetChainKey(session);
    const decipher = crypto.createDecipheriv('aes-256-gcm', messageKey, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    messageKey.fill(0);
    
    const messageNumber = Number(decrypted.slice(0, 8).readBigUInt64BE());
    
    // SECURITY: Replay protection
    if (session.receivedCounters.has(messageNumber)) {
      throw new Error('Replay attack detected');
    }
    if (messageNumber > session.messageCounter + 1000) {
      throw new Error('Invalid message number');
    }
    
    session.receivedCounters.add(messageNumber);
    if (session.receivedCounters.size > 10000) {
      const sorted = Array.from(session.receivedCounters).sort((a, b) => a - b);
      for (let i = 0; i < 5000; i++) session.receivedCounters.delete(sorted[i]);
    }
    
    return decrypted.slice(8).toString('utf8');
  }

  exportSessions(password) {
    const sessions = {};
    for (const [peerId, session] of this.sessionKeys) {
      if (session.chainKey) {
        sessions[peerId] = {
          chainKey: session.chainKey.toString('base64'),
          messageCounter: session.messageCounter,
          ourPeerId: session.ourPeerId, theirPeerId: session.theirPeerId
        };
      }
    }
    
    const salt = crypto.randomBytes(32);
    const key = crypto.scryptSync(password, salt, 32, { N: 2 ** 17, r: 8, p: 1 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessions), 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    return {
      version: 2, salt: salt.toString('base64'), iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64')
    };
  }

  importSessions(backup, password) {
    const salt = Buffer.from(backup.salt, 'base64');
    const params = backup.version >= 2 ? { N: 2 ** 17, r: 8, p: 1 } : {};
    const key = crypto.scryptSync(password, salt, 32, params);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(backup.authTag, 'base64'));
    
    let decrypted = decipher.update(Buffer.from(backup.data, 'base64'));
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const sessions = JSON.parse(decrypted.toString('utf8'));
    for (const [peerId, data] of Object.entries(sessions)) {
      this.sessionKeys.set(peerId, {
        chainKey: Buffer.from(data.chainKey, 'base64'),
        messageCounter: data.messageCounter || 0,
        ourPeerId: data.ourPeerId, theirPeerId: data.theirPeerId,
        receivedCounters: new Set()
      });
    }
    return Object.keys(sessions).length;
  }

  clearAllSessions() {
    for (const [, session] of this.sessionKeys) {
      if (session.chainKey) session.chainKey.fill(0);
      if (session.sharedSecret) session.sharedSecret.fill(0);
    }
    this.sessionKeys.clear();
  }

  /**
   * Encrypt a message for a specific recipient's public key
   * Used for storing offline messages on relay nodes
   */
  encryptForRecipient(plaintext, recipientPublicKey) {
    // Generate ephemeral keypair for this message
    const ephemeral = crypto.createECDH('secp256k1');
    ephemeral.generateKeys();
    
    // Derive shared secret with recipient's public key
    const sharedSecret = ephemeral.computeSecret(
      Buffer.from(recipientPublicKey, 'hex')
    );
    
    // Derive encryption key
    const key = crypto.createHash('sha256').update(sharedSecret).digest();
    const iv = crypto.randomBytes(16);
    
    // Encrypt
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Clear sensitive data
    sharedSecret.fill(0);
    key.fill(0);
    
    // Return: ephemeralPubKey + iv + authTag + ciphertext
    return Buffer.concat([
      ephemeral.getPublicKey(),
      iv,
      authTag,
      encrypted
    ]).toString('base64');
  }

  /**
   * Decrypt a message encrypted for us
   */
  decryptFromSender(encryptedBase64) {
    const data = Buffer.from(encryptedBase64, 'base64');
    
    // Parse components
    const ephemeralPubKey = data.subarray(0, 65); // secp256k1 uncompressed
    const iv = data.subarray(65, 81);
    const authTag = data.subarray(81, 97);
    const ciphertext = data.subarray(97);
    
    // Derive shared secret using our private key
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(this.privateKey);
    const sharedSecret = ecdh.computeSecret(ephemeralPubKey);
    
    // Derive decryption key
    const key = crypto.createHash('sha256').update(sharedSecret).digest();
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    // Clear sensitive data
    sharedSecret.fill(0);
    key.fill(0);
    
    return decrypted.toString('utf8');
  }

  /**
   * Get our public key for others to encrypt to
   */
  getPublicKey() {
    if (!this.publicKey) return null;
    return this.publicKey.toString('hex');
  }
}

module.exports = P2PCrypto;
