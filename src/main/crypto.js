/**
 * P2P Chat Crypto Module
 * Implements Tailscale-like key management with per-chat encryption
 * 
 * Key Types:
 * - Identity Key (Ed25519): Long-term identity, signs messages, stored in DHT
 * - Session Key (X25519): Per-chat ephemeral key for encryption
 * - Message Key: Derived from session key via HKDF for each message
 * 
 * Architecture (Tailscale-inspired):
 * - Control Plane: Username→PublicKey mapping in DHT (like Tailscale coord server)
 * - Data Plane: Direct P2P encrypted messages (like WireGuard tunnels)
 */

const crypto = require('crypto');

class P2PCrypto {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.identityKeyPair = null;  // Ed25519 for signing
    this.sessionKeys = new Map(); // peerId -> { ourEphemeral, theirPublic, sharedSecret }
  }

  /**
   * Initialize or load identity keypair
   * This is the user's permanent identity (like Tailscale's node key)
   */
  async initializeIdentity() {
    const keyPath = require('path').join(this.dataDir, 'identity.key');
    const fs = require('fs');
    
    try {
      if (fs.existsSync(keyPath)) {
        // Load existing identity
        const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        this.identityKeyPair = {
          publicKey: Buffer.from(keyData.publicKey, 'base64'),
          privateKey: Buffer.from(keyData.privateKey, 'base64')
        };
        console.log('[Crypto] Loaded existing identity key');
      } else {
        // Generate new identity
        this.identityKeyPair = await this.generateEd25519KeyPair();
        
        // Save to disk (like Tailscale stores machine key)
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(keyPath, JSON.stringify({
          publicKey: this.identityKeyPair.publicKey.toString('base64'),
          privateKey: this.identityKeyPair.privateKey.toString('base64')
        }), { mode: 0o600 }); // Restrict permissions
        
        console.log('[Crypto] Generated new identity key');
      }
      
      return this.getPublicKeyFingerprint();
    } catch (error) {
      console.error('[Crypto] Failed to initialize identity:', error);
      throw error;
    }
  }

  /**
   * Generate Ed25519 keypair for identity/signing
   */
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

  /**
   * Generate X25519 ephemeral keypair for key exchange (per-chat)
   * Like WireGuard's session keys
   */
  generateEphemeralKeyPair() {
    const ecdh = crypto.createECDH('x25519');
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey(),
      privateKey: ecdh.getPrivateKey(),
      ecdh
    };
  }

  /**
   * Get public key fingerprint (short identifier)
   */
  getPublicKeyFingerprint() {
    if (!this.identityKeyPair) return null;
    const hash = crypto.createHash('sha256')
      .update(this.identityKeyPair.publicKey)
      .digest();
    return hash.slice(0, 8).toString('hex');
  }

  /**
   * Get full public key for sharing
   */
  getPublicKey() {
    if (!this.identityKeyPair) return null;
    return this.identityKeyPair.publicKey.toString('base64');
  }

  /**
   * Sign data with identity key
   */
  sign(data) {
    if (!this.identityKeyPair) throw new Error('Identity not initialized');
    
    const privateKey = crypto.createPrivateKey({
      key: this.identityKeyPair.privateKey,
      format: 'der',
      type: 'pkcs8'
    });
    
    return crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
  }

  /**
   * Verify signature from a peer
   */
  verify(data, signature, publicKeyBase64) {
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki'
      });
      
      return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64'));
    } catch (error) {
      console.error('[Crypto] Verification failed:', error);
      return false;
    }
  }

  /**
   * Initiate encrypted session with a peer (key exchange)
   * Returns ephemeral public key to send to peer
   */
  initiateSession(peerId) {
    const ephemeral = this.generateEphemeralKeyPair();
    
    this.sessionKeys.set(peerId, {
      ourEphemeral: ephemeral,
      theirPublic: null,
      sharedSecret: null,
      initiated: true
    });
    
    return ephemeral.publicKey.toString('base64');
  }

  /**
   * Complete session with peer's ephemeral key
   * Derives shared secret using X25519 ECDH
   */
  completeSession(peerId, theirPublicKeyBase64) {
    let session = this.sessionKeys.get(peerId);
    
    if (!session) {
      // We're responding to their initiation
      const ephemeral = this.generateEphemeralKeyPair();
      session = {
        ourEphemeral: ephemeral,
        theirPublic: Buffer.from(theirPublicKeyBase64, 'base64'),
        sharedSecret: null,
        initiated: false
      };
    } else {
      session.theirPublic = Buffer.from(theirPublicKeyBase64, 'base64');
    }
    
    // Compute shared secret (X25519 ECDH)
    session.sharedSecret = session.ourEphemeral.ecdh.computeSecret(session.theirPublic);
    
    // Derive encryption key using HKDF
    session.encryptionKey = crypto.hkdfSync(
      'sha256',
      session.sharedSecret,
      'p2p-chat-v1',  // Salt
      'message-encryption',  // Info
      32  // Key length (256-bit)
    );
    
    this.sessionKeys.set(peerId, session);
    
    return session.ourEphemeral.publicKey.toString('base64');
  }

  /**
   * Check if we have an active encrypted session with peer
   */
  hasSession(peerId) {
    const session = this.sessionKeys.get(peerId);
    return session && session.sharedSecret;
  }

  /**
   * Encrypt message for a specific peer
   * Uses AES-256-GCM (same as WireGuard's ChaCha20-Poly1305 security level)
   */
  encryptMessage(peerId, plaintext) {
    const session = this.sessionKeys.get(peerId);
    if (!session || !session.encryptionKey) {
      throw new Error('No encryption session with peer');
    }
    
    // Generate random IV
    const iv = crypto.randomBytes(12);
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', session.encryptionKey, iv);
    
    // Encrypt
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Get auth tag
    const authTag = cipher.getAuthTag();
    
    // Return IV + authTag + ciphertext as base64
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  /**
   * Decrypt message from a specific peer
   */
  decryptMessage(peerId, ciphertext) {
    const session = this.sessionKeys.get(peerId);
    if (!session || !session.encryptionKey) {
      throw new Error('No decryption session with peer');
    }
    
    const data = Buffer.from(ciphertext, 'base64');
    
    // Extract IV (12 bytes), authTag (16 bytes), and ciphertext
    const iv = data.slice(0, 12);
    const authTag = data.slice(12, 28);
    const encrypted = data.slice(28);
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', session.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  }

  /**
   * Export session for backup (encrypted with user password)
   */
  exportSessions(password) {
    const sessions = {};
    for (const [peerId, session] of this.sessionKeys) {
      if (session.sharedSecret) {
        sessions[peerId] = {
          sharedSecret: session.sharedSecret.toString('base64'),
          encryptionKey: session.encryptionKey.toString('base64')
        };
      }
    }
    
    // Encrypt with password
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessions), 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return {
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  /**
   * Import sessions from backup
   */
  importSessions(backup, password) {
    const salt = Buffer.from(backup.salt, 'base64');
    const key = crypto.scryptSync(password, salt, 32);
    const iv = Buffer.from(backup.iv, 'base64');
    const authTag = Buffer.from(backup.authTag, 'base64');
    const data = Buffer.from(backup.data, 'base64');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(data);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const sessions = JSON.parse(decrypted.toString('utf8'));
    
    for (const [peerId, sessionData] of Object.entries(sessions)) {
      this.sessionKeys.set(peerId, {
        sharedSecret: Buffer.from(sessionData.sharedSecret, 'base64'),
        encryptionKey: Buffer.from(sessionData.encryptionKey, 'base64')
      });
    }
    
    return Object.keys(sessions).length;
  }
}

module.exports = P2PCrypto;
