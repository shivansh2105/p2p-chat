/**
 * Minimal drop-in for electron-store (get/set/delete/has) for headless mode.
 * Plain JSON file, atomic writes (tmp + rename), debounced so frequent
 * updates don't hammer the disk. flush() on shutdown.
 */
const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(file, defaults = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep a copy instead of silently losing it
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      }
      this.data = { ...defaults };
    }
    this.timer = null;
  }

  get(key, def) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : def; }
  has(key) { return Object.prototype.hasOwnProperty.call(this.data, key); }
  set(key, value) { this.data[key] = value; this.schedule(); }
  delete(key) { delete this.data[key]; this.schedule(); }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** The network layer only needs these database calls; a relay server keeps no chat history */
class ServerDatabase {
  constructor() { this.received = 0; }
  async initialize() { return this; }
  async addMessage() { this.received++; return null; }
  getMessagesSince() { return []; }
  updateContactUsername() {}
  updateChatName() {}
  getAllChats() { return []; }
}

module.exports = { FileStore, ServerDatabase };
