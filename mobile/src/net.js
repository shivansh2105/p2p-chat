// Mobile P2P node — joins the SAME network as desktop PCs.
// Speaks the desktop protocols: chat, inbox keys + offline mail, video search /
// chunks / replication, DHT provider records.
//
// Reachability on a phone (WebView can't accept TCP):
//   • WebSocket → any desktop PC on the same WiFi or with a public/UPnP/IPv6 port
//   • Circuit relay through those PCs → reach every other PC
//   • WebRTC (browser-native) with STUN/TURN → phone↔phone and hole punching
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { dcutr } from '@libp2p/dcutr';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { CID } from 'multiformats/cid';
import { sha256 as mfSha256 } from 'multiformats/hashes/sha2';
import { sha256 } from '@noble/hashes/sha256';
import { WebCrypto, b64, unb64, toHex } from './crypto-web.js';
import { idb } from './idb.js';
import { SERVERS } from './servers.js';

export const PROTO = {
  MESSAGE: '/p2p-chat/message/1.0.0',
  KEYS: '/p2p-chat/keys/1.0.0',
  INBOX: '/p2p-chat/inbox/1.0.0',
  VIDEO: '/p2p-chat/video/1.0.0',
  VSYNC: '/p2p-chat/video-sync/1.0.0'
};
export const CHUNK_SIZE = 256 * 1024;

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  // Free public TURN (Open Relay Project by metered.ca). Relays packets only, stores nothing.
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject', credential: 'openrelayproject' }
];

const te = new TextEncoder();
const td = new TextDecoder();

async function readAll(stream) {
  const parts = [];
  for await (const c of stream.source) parts.push(c.subarray());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class MobileNode extends EventTarget {
  async start() {
    // Persistent identities
    const saved = await idb.get('keys');
    this.crypto = new WebCrypto(saved?.app);
    let privateKey;
    if (saved?.libp2p) privateKey = privateKeyFromProtobuf(unb64(saved.libp2p));
    else privateKey = await generateKeyPair('Ed25519');
    await idb.set('keys', { app: this.crypto.exportKeys(), libp2p: b64(privateKeyToProtobuf(privateKey)) });

    this.peerBoxKeys = new Map(Object.entries((await idb.get('peerBoxKeys')) || {}));
    this.peerIdKeys = new Map(Object.entries((await idb.get('peerIdKeys')) || {}));
    this.knownAddrs = (await idb.get('knownAddrs')) || [];
    this.seen = new Set();

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen: ['/p2p-circuit', '/webrtc'] },
      transports: [
        webSockets(),
        webRTC({ rtcConfiguration: { iceServers: ICE_SERVERS } }),
        circuitRelayTransport()
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // Browser default blocks LAN IPs + plain ws:// — we need both for PCs on the same WiFi
      connectionGater: { denyDialMultiaddr: async () => false },
      services: {
        identify: identify(),
        dcutr: dcutr(),
        dht: kadDHT({ clientMode: true, peerInfoMapper: passthroughMapper })
      }
    });

    const h = (proto, fn) => this.node.handle(proto, async ({ stream, connection }) => {
      try {
        const req = JSON.parse(td.decode(await readAll(stream)) || '{}');
        const res = await fn(req, connection.remotePeer.toString());
        await stream.sink([te.encode(JSON.stringify(res ?? {}))]);
      } catch (e) {
        try { await stream.sink([te.encode(JSON.stringify({ error: e.message }))]); } catch {}
      }
    }, { runOnLimitedConnection: true });

    await h(PROTO.MESSAGE, async (msg, from) => { await this.receiveMessage(msg, from); return { ack: true, id: msg.id }; });
    await h(PROTO.KEYS, async () => ({
      peerId: this.peerId, boxKey: this.crypto.getBoxPublicKey(), idKey: this.crypto.getPublicKey(),
      sig: this.crypto.sign(`${this.peerId}:${this.crypto.getBoxPublicKey()}`)
    }));
    // Seed videos while the app is open. (No INBOX / VSYNC handler: phones are
    // not chosen as long-term holders because they go offline a lot.)
    await h(PROTO.VIDEO, (req) => this.handleVideoRequest(req));

    this.node.addEventListener('peer:connect', (e) => this.onConnect(e.detail.toString()));
    this.node.addEventListener('peer:disconnect', () => this.emit('peers'));

    await this.node.start();
    this.peerId = this.node.peerId.toString();
    // Project servers first, then PCs we've used before
    for (const a of [...SERVERS, ...this.knownAddrs]) this.dial(a).catch(() => {});
    return this;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async stop() { await this.node?.stop(); }

  // ── connections ───────────────────────────────────────────
  async dial(addr) {
    const ma = multiaddr(addr.trim());
    const conn = await this.node.dial(ma, { signal: AbortSignal.timeout(20000) });
    if (!this.knownAddrs.includes(addr)) {
      this.knownAddrs = [addr, ...this.knownAddrs].slice(0, 20);
      await idb.set('knownAddrs', this.knownAddrs);
    }
    return conn.remotePeer.toString();
  }

  peers() { return this.node.getPeers().map(String); }

  async appPeers(proto) {
    const out = [];
    for (const p of this.node.getPeers()) {
      const info = await this.node.peerStore.get(p).catch(() => null);
      if (info?.protocols.includes(proto)) out.push(p.toString());
    }
    return out;
  }

  async request(peer, proto, body, timeout = 20000) {
    const stream = await this.node.dialProtocol(typeof peer === 'string' ? peerIdFromString(peer) : peer, proto, {
      runOnLimitedConnection: true, signal: AbortSignal.timeout(timeout)
    });
    await stream.sink([te.encode(JSON.stringify(body))]);
    const res = await readAll(stream);
    return res.length ? JSON.parse(td.decode(res)) : {};
  }

  async onConnect(peerId) {
    this.emit('peers');
    // identify needs a moment to learn the peer's protocols
    await new Promise((r) => setTimeout(r, 500));
    await this.exchangeKeys(peerId).catch(() => {});
    await this.fetchMail(peerId).catch(() => {});
  }

  // ── DHT tracker (same keys as desktop discovery.js) ─────────────
  async cidFor(key) { return CID.createV1(0x55, await mfSha256.digest(te.encode('p2p-chat:v1:' + key))); }

  async provide(key) {
    try { await this.node.contentRouting.provide(await this.cidFor(key), { signal: AbortSignal.timeout(60000) }); } catch {}
  }

  async findProviders(key, max = 20) {
    const out = new Map();
    try {
      for await (const p of this.node.contentRouting.findProviders(await this.cidFor(key), { signal: AbortSignal.timeout(20000) })) {
        if (p.id.toString() === this.peerId) continue;
        out.set(p.id.toString(), p);
        if (out.size >= max) break;
      }
    } catch {}
    return [...out.values()];
  }

  async connectProvider(p) {
    const id = p.id.toString();
    if (this.peers().includes(id)) return true;
    try {
      if (p.multiaddrs?.length) await this.node.peerStore.merge(p.id, { multiaddrs: p.multiaddrs });
      await this.node.dial(p.id, { signal: AbortSignal.timeout(20000) });
      return true;
    } catch { return false; }
  }

  // ── chat + offline mail ────────────────────────────────────
  async exchangeKeys(peerId) {
    const r = await this.request(peerId, PROTO.KEYS, {});
    if (!r.boxKey || r.peerId !== peerId || !this.crypto.verify(`${peerId}:${r.boxKey}`, r.sig, r.idKey)) return;
    const known = this.peerIdKeys.get(peerId);
    if (known && known !== r.idKey) return; // key changed → possible impersonation
    this.peerIdKeys.set(peerId, r.idKey);
    this.peerBoxKeys.set(peerId, r.boxKey);
    await idb.set('peerIdKeys', Object.fromEntries(this.peerIdKeys));
    await idb.set('peerBoxKeys', Object.fromEntries(this.peerBoxKeys));
  }

  async receiveMessage(msg, from) {
    if (!msg?.id || this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    this.emit('message', { id: msg.id, from: msg.senderId || from, content: String(msg.content ?? ''), timestamp: msg.timestamp || Date.now(), verified: msg.verified });
  }

  /** Returns 'direct' | 'offline' (sealed on N PCs) | throws */
  async sendMessage(peerId, content) {
    const payload = { id: crypto.randomUUID(), type: 'chat_message', senderId: this.peerId, recipientId: peerId, content, contentType: 'text', timestamp: Date.now() };
    try {
      const r = await this.request(peerId, PROTO.MESSAGE, payload, 8000);
      if (r.ack) return 'direct';
    } catch {}
    const boxKey = this.peerBoxKeys.get(peerId);
    if (!boxKey) throw new Error('Peer offline and no inbox key yet (connect once first)');
    const body = JSON.stringify(payload);
    const sealed = await this.crypto.encryptForRecipient(JSON.stringify({ body, idKey: this.crypto.getPublicKey(), sig: this.crypto.sign(body) }), boxKey);
    const holders = (await this.appPeers(PROTO.INBOX)).filter((p) => p !== peerId).slice(0, 5);
    let copies = 0;
    await Promise.allSettled(holders.map(async (h) => {
      const r = await this.request(h, PROTO.INBOX, { type: 'STORE', recipient: peerId, blob: sealed, id: payload.id });
      if (r.ok) copies++;
    }));
    if (!copies) throw new Error('No PC online to hold the message');
    return `offline (${copies} PCs holding it)`;
  }

  async fetchMail(holder) {
    const r = await this.request(holder, PROTO.INBOX, { type: 'FETCH' });
    const ids = [];
    for (const m of r.messages || []) {
      try {
        const inner = JSON.parse(await this.crypto.decryptFromSender(m.encrypted));
        if (!this.crypto.verify(inner.body, inner.sig, inner.idKey)) throw new Error('bad sig');
        const p = JSON.parse(inner.body);
        const known = this.peerIdKeys.get(p.senderId);
        if (known && known !== inner.idKey) throw new Error('sender key mismatch');
        await this.receiveMessage({ ...p, verified: !!known }, p.senderId);
      } catch {}
      ids.push(m.id);
    }
    if (ids.length) await this.request(holder, PROTO.INBOX, { type: 'ACK', ids }).catch(() => {});
    return ids.length;
  }

  async findMyMail() {
    let n = 0;
    for (const p of await this.findProviders('inbox:' + this.peerId, 10)) {
      if (await this.connectProvider(p)) n += await this.fetchMail(p.id.toString()).catch(() => 0);
    }
    return n;
  }

  // ── video ──────────────────────────────────────────────────
  async handleVideoRequest(req) {
    switch (req.type) {
      case 'GET_CHUNK': {
        const data = await idb.getChunk(req.chunkHash);
        return data ? { chunk: b64(new Uint8Array(data)), hash: req.chunkHash } : { error: 'Chunk not found' };
      }
      case 'GET_AVAILABLE_CHUNKS': {
        const v = await idb.getVideo(req.videoId);
        if (!v) return { chunks: [] };
        const have = [];
        for (const h of v.chunkHashes) if (await idb.hasChunk(h)) have.push(h);
        return { chunks: have };
      }
      case 'SEARCH': return { results: await this.searchLocal(req.query || '') };
      default: return { error: 'unsupported' };
    }
  }

  static keywords(v) {
    const words = `${v.title || ''} ${(v.tags || []).join(' ')}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    return [...new Set(words)].slice(0, 12);
  }

  async searchLocal(q) {
    q = q.toLowerCase();
    return (await idb.allVideos()).filter((v) =>
      v.title.toLowerCase().includes(q) || (v.tags || []).some((t) => t.toLowerCase().includes(q)) || (v.description || '').toLowerCase().includes(q));
  }

  announce(v) {
    this.provide('video:' + v.id);
    for (const w of MobileNode.keywords(v)) this.provide('kw:' + w);
  }

  /** Upload from the phone: chunk + hash, then push copies to up to 3 PCs */
  async uploadVideo(file, { title, tags = [], description = '' }, onProgress) {
    const whole = sha256.create();
    const chunkHashes = [];
    for (let off = 0; off < file.size; off += CHUNK_SIZE) {
      const buf = new Uint8Array(await file.slice(off, off + CHUNK_SIZE).arrayBuffer());
      whole.update(buf);
      const h = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
      await idb.putChunk(h, buf);
      chunkHashes.push(h);
      onProgress?.({ stage: 'hashing', percent: Math.round(((off + buf.length) / file.size) * 100) });
    }
    const contentHash = toHex(whole.digest());
    const video = {
      id: contentHash.slice(0, 16), title: title || file.name, description, tags, duration: 0, size: file.size,
      chunkSize: CHUNK_SIZE, chunkCount: chunkHashes.length, chunkHashes, contentHash,
      mimeType: file.type || 'video/mp4', uploader: this.peerId, uploaderName: 'mobile',
      uploadedAt: Date.now(), views: 0, seeders: 1, replicas: [], lastWatched: Date.now()
    };
    await idb.putVideo(video);
    this.announce(video);
    video.replicas = await this.replicate(video, onProgress);
    await idb.putVideo(video);
    return video;
  }

  async replicate(video, onProgress, target = 3) {
    const done = [];
    for (const peer of await this.appPeers(PROTO.VSYNC)) {
      if (done.length >= target) break;
      try {
        const { chunkHashes, replicas, lastWatched, ...meta } = video;
        const m = await this.request(peer, PROTO.VSYNC, { type: 'VIDEO_METADATA', video: { ...meta, chunkHashes } });
        if (!m.ok) continue;
        const have = new Set(m.have || []);
        let sent = 0;
        for (const h of chunkHashes) {
          if (!have.has(h)) {
            const data = new Uint8Array(await idb.getChunk(h));
            const r = await this.request(peer, PROTO.VSYNC, { type: 'VIDEO_CHUNK', videoId: video.id, chunkHash: h, data: b64(data) }, 60000);
            if (!r.ok) throw new Error(r.error || 'rejected');
          }
          onProgress?.({ stage: `copy ${done.length + 1}`, percent: Math.round((++sent / chunkHashes.length) * 100) });
        }
        done.push(peer);
      } catch {}
    }
    return done;
  }

  /** Search connected PCs + anyone the DHT lists for the query words */
  async searchNetwork(query) {
    const ask = new Set(await this.appPeers(PROTO.VIDEO));
    const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 3);
    for (const w of words) {
      for (const p of await this.findProviders('kw:' + w, 10)) {
        if (ask.size >= 25) break;
        if (await this.connectProvider(p)) ask.add(p.id.toString());
      }
    }
    const results = new Map((await this.searchLocal(query)).map((v) => [v.id, v]));
    await Promise.allSettled([...ask].map(async (p) => {
      const r = await this.request(p, PROTO.VIDEO, { type: 'SEARCH', query });
      for (const v of r.results || []) {
        if (!results.has(v.id) && Array.isArray(v.chunkHashes) && v.contentHash?.slice(0, 16) === v.id) results.set(v.id, v);
      }
    }));
    return [...results.values()];
  }

  /** Swarm-download (hash-verified), then seed while open. Returns a playable Blob URL */
  async watch(video, onProgress) {
    const existing = await idb.getVideo(video.id);
    if (!existing) await idb.putVideo({ ...video, replicas: [], lastWatched: Date.now() });
    const missing = [];
    for (const h of video.chunkHashes) if (!(await idb.hasChunk(h))) missing.push(h);

    if (missing.length) {
      const seeders = new Set(await this.appPeers(PROTO.VIDEO));
      for (const p of await this.findProviders('video:' + video.id, 20)) if (await this.connectProvider(p)) seeders.add(p.id.toString());
      const peers = [...seeders];
      if (!peers.length) throw new Error('No seeders online for this video');
      let done = video.chunkHashes.length - missing.length, turn = 0;
      const queue = [...missing];
      const worker = async () => {
        while (queue.length) {
          const h = queue.shift();
          let got = false;
          for (let i = 0; i < peers.length && !got; i++) {
            try {
              const r = await this.request(peers[(turn++ + i) % peers.length], PROTO.VIDEO, { type: 'GET_CHUNK', chunkHash: h }, 30000);
              if (!r.chunk) continue;
              const data = unb64(r.chunk);
              if (toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))) !== h) continue; // reject bad data
              await idb.putChunk(h, data);
              got = true;
            } catch {}
          }
          if (!got) throw new Error('Could not get chunk ' + h.slice(0, 8));
          onProgress?.({ stage: 'downloading', percent: Math.round((++done / video.chunkHashes.length) * 100) });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    }

    // Whole-file check before playing / seeding
    const whole = sha256.create();
    const parts = [];
    for (const h of video.chunkHashes) { const c = new Uint8Array(await idb.getChunk(h)); whole.update(c); parts.push(c); }
    if (toHex(whole.digest()) !== video.contentHash) throw new Error('Video failed integrity check');
    this.announce(video); // now a seeder too (while the app is open)
    return URL.createObjectURL(new Blob(parts, { type: video.mimeType || 'video/mp4' }));
  }
}
