/**
 * Free public reachability via Cloudflare Quick Tunnels (trycloudflare.com).
 *
 * No account, no card, no open ports: `cloudflared` connects OUT to Cloudflare
 * and receives a public https URL that forwards to our local WebSocket
 * listener. Even a PC behind strict NAT / CGNAT becomes reachable at
 *   /dns4/<random>.trycloudflare.com/tcp/443/wss/p2p/<peerId>
 * so phones and other NAT'd peers can connect to it and relay through it.
 *
 * Limits (Cloudflare): meant for testing, no SLA, ≤200 in-flight requests per
 * tunnel, URL changes on every restart. Opt-out: store 'tunnel' = false.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const EventEmitter = require('events');

const BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function assetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch] || 'amd64';
  if (process.platform === 'win32') return { file: `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe` }; // x64 runs under emulation on ARM64
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch}.tgz`, tgz: true };
  return { file: `cloudflared-linux-${arch}` };
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'p2p-chat' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed: HTTP ${res.statusCode}`)); }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

class TunnelManager extends EventEmitter {
  constructor(p2p) {
    super();
    this.p2p = p2p;
    this.binDir = path.join(p2p.dataDir, 'bin');
    this.proc = null;
    this.url = null;
    this.addr = null;
    this.stopped = false;
    this.restarts = 0;
  }

  enabled() { return this.p2p.store?.get('tunnel', true) ?? true; }

  async ensureBinary() {
    const { file, tgz } = assetName();
    const exe = path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(exe) && fs.statSync(exe).size > 1e6) return exe;
    fs.mkdirSync(this.binDir, { recursive: true });
    console.log(`[Tunnel] Downloading cloudflared (${file})…`);
    if (tgz) {
      const archive = path.join(this.binDir, file);
      await download(BASE + file, archive);
      await new Promise((res, rej) => spawn('tar', ['-xzf', archive, '-C', this.binDir]).on('exit', (c) => (c === 0 ? res() : rej(new Error('tar failed')))));
      fs.unlinkSync(archive);
    } else {
      await download(BASE + file, exe);
    }
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    if (fs.statSync(exe).size < 1e6) throw new Error('cloudflared download looks corrupt');
    return exe;
  }

  wsPort() {
    const addrs = this.p2p.node.components?.transportManager?.getAddrs?.().map(String) || [];
    const ws = addrs.find((a) => /^\/ip4\/.*\/tcp\/\d+\/ws$/.test(a));
    return ws ? Number(ws.split('/tcp/')[1].split('/')[0]) : null;
  }

  async start() {
    if (!this.enabled()) return null;
    this.stopped = false;
    const port = this.wsPort();
    if (!port) throw new Error('no WebSocket listener to tunnel');
    const exe = await this.ensureBinary();

    return new Promise((resolve) => {
      const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
      this.proc = proc;
      let resolved = false;
      const onData = (buf) => {
        const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(buf.toString());
        if (m && !this.url) {
          this.url = `https://${m[1]}`;
          this.announce(m[1]);
        }
        // cloudflared prints the URL before the edge connection is ready
        if (this.url && /Registered tunnel connection/.test(buf.toString()) && !resolved) {
          resolved = true;
          this.restarts = 0;
          console.log(`[Tunnel] Public address: ${this.addr}`);
          this.emit('ready', this.addr);
          resolve(this.addr);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => {
        this.unannounce();
        this.proc = null;
        if (!resolved) { resolved = true; resolve(null); }
        if (this.stopped) return;
        // Restart with backoff (URL will change; new one is announced)
        const delay = Math.min(60000, 2000 * 2 ** this.restarts++);
        console.log(`[Tunnel] cloudflared exited (${code}); restarting in ${delay / 1000}s`);
        setTimeout(() => this.start().catch(() => {}), delay).unref?.();
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 45000).unref?.();
    });
  }

  // The address itself is added by P2PNode's announceFilter (reads this.addrMa);
  // here we only set it and make libp2p re-publish our address list (identify
  // push to connected peers + peer record).
  announce(host) {
    const { multiaddr } = require('./esm').esm();
    this.addrMa = multiaddr(`/dns4/${host}/tcp/443/wss`);
    this.addr = `${this.addrMa.toString()}/p2p/${this.p2p.peerId}`;
    this.refreshAddresses();
  }

  unannounce() {
    const had = !!this.addrMa;
    this.addrMa = null; this.addr = null; this.url = null;
    if (had) this.refreshAddresses();
  }

  refreshAddresses() {
    try {
      const am = this.p2p.node?.components?.addressManager;
      if (typeof am?._updatePeerStoreAddresses === 'function') am._updatePeerStoreAddresses();
    } catch (e) { /* DHT records still carry it: announceSelf runs on 'ready' */ }
  }

  stop() {
    this.stopped = true;
    this.unannounce();
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }
}

module.exports = { TunnelManager };
