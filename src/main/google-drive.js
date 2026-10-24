/**
 * Google Drive Backup - WhatsApp-style cloud backup
 * 
 * Features:
 * - Encrypted backup to Google Drive
 * - Auto-backup scheduling
 * - Selective restore
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// You would register your app at Google Cloud Console and get these
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const BACKUP_FOLDER_NAME = 'P2P-Chat-Backup';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

class GoogleDriveBackup {
  constructor(database, store) {
    this.database = database;
    this.store = store;
    this.oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      REDIRECT_URI
    );
    this.drive = null;
    this.backupFolderId = null;
    this.autoBackupInterval = null;

    // Load saved tokens
    this.loadTokens();
  }

  loadTokens() {
    const tokens = this.store.get('googleDriveTokens');
    if (tokens) {
      this.oauth2Client.setCredentials(tokens);
      this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    }
  }

  saveTokens(tokens) {
    this.store.set('googleDriveTokens', tokens);
    this.oauth2Client.setCredentials(tokens);
    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
  }

  getStatus() {
    const tokens = this.store.get('googleDriveTokens');
    const lastBackup = this.database.getLastBackup();
    const autoBackup = this.store.get('autoBackup', false);

    return {
      connected: !!tokens,
      lastBackup: lastBackup ? {
        date: lastBackup.created_at,
        size: lastBackup.size,
        status: lastBackup.status
      } : null,
      autoBackupEnabled: autoBackup
    };
  }

  async getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
  }

  async authenticate(code) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.saveTokens(tokens);

      // Set up token refresh
      this.oauth2Client.on('tokens', (newTokens) => {
        if (newTokens.refresh_token) {
          this.saveTokens({ ...tokens, ...newTokens });
        }
      });

      // Initialize backup folder
      await this.ensureBackupFolder();

      return { success: true };
    } catch (error) {
      console.error('Authentication failed:', error);
      return { success: false, error: error.message };
    }
  }

  async ensureBackupFolder() {
    if (!this.drive) return null;

    // Check if folder already exists
    const response = await this.drive.files.list({
      q: `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name)'
    });

    if (response.data.files.length > 0) {
      this.backupFolderId = response.data.files[0].id;
      return this.backupFolderId;
    }

    // Create folder
    const folder = await this.drive.files.create({
      requestBody: {
        name: BACKUP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    this.backupFolderId = folder.data.id;
    return this.backupFolderId;
  }

  async createBackup() {
    if (!this.drive) {
      return { success: false, error: 'Not connected to Google Drive' };
    }

    try {
      await this.ensureBackupFolder();

      // Export database
      const data = this.database.exportAll();

      // Generate encryption key from user's identity
      const user = this.store.get('user');
      const encryptionKey = this.deriveKey(user?.id || 'default');

      // Encrypt and compress
      const jsonData = JSON.stringify(data);
      const compressed = await gzip(jsonData);
      const encrypted = this.encrypt(compressed, encryptionKey);

      // Create backup file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `backup-${timestamp}.p2pchat`;

      const response = await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [this.backupFolderId],
          description: `P2P Chat backup created on ${new Date().toISOString()}`
        },
        media: {
          mimeType: 'application/octet-stream',
          body: require('stream').Readable.from(encrypted)
        },
        fields: 'id, name, size'
      });

      // Log backup
      this.database.addBackupHistory(
        'google_drive',
        response.data.id,
        encrypted.length,
        'success'
      );

      // Clean up old backups (keep last 5)
      await this.cleanupOldBackups();

      return {
        success: true,
        fileId: response.data.id,
        fileName: response.data.name,
        size: encrypted.length
      };

    } catch (error) {
      console.error('Backup failed:', error);
      this.database.addBackupHistory('google_drive', null, 0, 'failed');
      return { success: false, error: error.message };
    }
  }

  async restoreBackup(fileId = null) {
    if (!this.drive) {
      return { success: false, error: 'Not connected to Google Drive' };
    }

    try {
      await this.ensureBackupFolder();

      // If no file specified, get the latest backup
      if (!fileId) {
        const response = await this.drive.files.list({
          q: `'${this.backupFolderId}' in parents and trashed=false`,
          orderBy: 'createdTime desc',
          pageSize: 1,
          fields: 'files(id, name, createdTime)'
        });

        if (response.data.files.length === 0) {
          return { success: false, error: 'No backups found' };
        }

        fileId = response.data.files[0].id;
      }

      // Download the backup
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );

      const encrypted = Buffer.from(response.data);

      // Decrypt
      const user = this.store.get('user');
      const encryptionKey = this.deriveKey(user?.id || 'default');
      const compressed = this.decrypt(encrypted, encryptionKey);

      // Decompress
      const jsonData = await gunzip(compressed);
      const data = JSON.parse(jsonData.toString());

      // Import into database
      this.database.importAll(data);

      return {
        success: true,
        restoredAt: Date.now(),
        messagesCount: data.messages?.length || 0,
        chatsCount: data.chats?.length || 0
      };

    } catch (error) {
      console.error('Restore failed:', error);
      return { success: false, error: error.message };
    }
  }

  async listBackups() {
    if (!this.drive) return [];

    try {
      await this.ensureBackupFolder();

      const response = await this.drive.files.list({
        q: `'${this.backupFolderId}' in parents and trashed=false`,
        orderBy: 'createdTime desc',
        pageSize: 20,
        fields: 'files(id, name, size, createdTime)'
      });

      return response.data.files.map(file => ({
        id: file.id,
        name: file.name,
        size: parseInt(file.size),
        createdAt: new Date(file.createdTime).getTime()
      }));

    } catch (error) {
      console.error('Failed to list backups:', error);
      return [];
    }
  }

  async cleanupOldBackups(keepCount = 5) {
    try {
      const backups = await this.listBackups();
      
      if (backups.length <= keepCount) return;

      const toDelete = backups.slice(keepCount);
      
      for (const backup of toDelete) {
        await this.drive.files.delete({ fileId: backup.id });
      }

    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  }

  startAutoBackup(intervalHours = 24) {
    this.stopAutoBackup();

    const intervalMs = intervalHours * 60 * 60 * 1000;
    this.autoBackupInterval = setInterval(() => {
      this.createBackup();
    }, intervalMs);

    // Also backup immediately
    this.createBackup();
  }

  stopAutoBackup() {
    if (this.autoBackupInterval) {
      clearInterval(this.autoBackupInterval);
      this.autoBackupInterval = null;
    }
  }

  // Encryption helpers
  deriveKey(secret) {
    return crypto.scryptSync(secret, 'p2p-chat-salt', 32);
  }

  encrypt(data, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  decrypt(data, key) {
    const iv = data.slice(0, 16);
    const authTag = data.slice(16, 32);
    const encrypted = data.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  disconnect() {
    this.store.delete('googleDriveTokens');
    this.stopAutoBackup();
    this.drive = null;
    this.backupFolderId = null;
  }
}

module.exports = { GoogleDriveBackup };
