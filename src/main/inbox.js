/**
 * Offline Inbox — store-and-forward over the volunteer network.
 *
 *  KEYS  protocol: on connect, peers swap their X25519 inbox key, signed with
 *                  their Ed25519 identity (trust-on-first-use).
 *  INBOX protocol: STORE  – put a sealed blob for <recipient> on a peer
 *                  FETCH  – get blobs addressed to *me* (identity proven by the
 *                           Noise-authenticated libp2p connection, no extra auth)
 *                  ACK    – delete blobs I have received
 *
 * Holders (any PC with storage enabled) only ever see ciphertext.
 */

const MAX_BLOB = 64 * 1024;
const REPLICAS = 5;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // per holder

const KEYS_PROTOCOL = '/p2p-chat/keys/1.0.0';
const INBOX_PROTOCOL = '/p2p-chat/inbox/1.0.0';

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream.source) chunks.push(Buffer.from(c.subarray()));
  return Buffer.concat(chunks);
}

async function request(node, peerId, protocol, body) {
  const stream = await node.dialProtocol(peerId, protocol, { signal: AbortSignal.timeout(15000) });
  await stream.sink([Buffer.from(JSON.stringify(body))]);
  const res = await readAll(stream);
  return res.length ? JSON.parse(res.toString()) : {};
}

class Inbox {
  constructor(p2p) {
    this.p2p = p2p;                    // P2PNode
    this.store = p2p.store;
    this.peerBoxKeys = new Map(Object.entries(this.store?.get('peerBoxKeys', {}) || {}));
    this.peerIdKeys = new Map(Object.entries(this.store?.get('peerIdKeys', {}) || {}));
  }

  storageEnabled() {
    return this.store?.get('storageEnabled', true) ?? true;  // ON by default, opt-out
  }

  async start() {
    const node = this.p2p.node;
    const crypto = this.p2p.crypto;

    await node.handle(KEYS_PROTOCOL, async ({ stream }) => {
      try {
        await readAll(stream);
        const boxKey = crypto.getBoxPublicKey();
        await stream.sink([Buffer.from(JSON.stringify({
          peerId: this.p2p.peerId,
          boxKey,
          idKey: crypto.getPublicKey(),
          sig: crypto.sign(`${this.p2p.peerId}:${boxKey}`)
        }))]);
      } catch (e) { /* ignore */ }
    });

    await node.handle(INBOX_PROTOCOL, async ({ stream, connection }) => {
      try {
        const req = JSON.parse((await readAll(stream)).toString());
        const from = connection.remotePeer.toString(); // authenticated by Noise
        const res = this.handleInbox(req, from);
        await stream.sink([Buffer.from(JSON.stringify(res))]);
      } catch (e) {
        try { await stream.sink([Buffer.from(JSON.stringify({ error: 'bad request' }))]); } catch {}
      }
    });
  }

  handleInbox(req, from) {
    const ms = this.p2p.messageStore;
    switch (req.type) {
      case 'STORE': {
        if (!this.storageEnabled()) return { ok: false, error: 'storage disabled' };
        if (typeof req.recipient !== 'string' || typeof req.blob !== 'string') return { ok: false };
        if (req.blob.length > MAX_BLOB) return { ok: false, error: 'too large' };
        if (ms.getStats && Number(ms.getStats().totalSizeKB) * 1024 > MAX_TOTAL_BYTES) return { ok: false, error: 'full' };
        ms.storeMessage(req.recipient, req.blob, from, req.id);
        return { ok: true };
      }
      case 'FETCH':
        return { messages: ms.fetchMessages(from) };
      case 'ACK':
        ms.confirmReceipt(from, Array.isArray(req.ids) ? req.ids : []);
        return { ok: true };
      default:
        return { error: 'unknown type' };
    }
  }

  /** Called on every new connection */
  async onPeerConnected(peerId) {
    await this.exchangeKeys(peerId).catch(() => {});
    await this.fetchFrom(peerId).catch(() => {});
  }

  async exchangeKeys(peerId) {
    const res = await request(this.p2p.node, peerId, KEYS_PROTOCOL, {});
    if (!res.boxKey || !res.idKey || res.peerId !== peerId) return;
    if (!this.p2p.crypto.verify(`${peerId}:${res.boxKey}`, res.sig, res.idKey)) return;
    const knownId = this.peerIdKeys.get(peerId);
    if (knownId && knownId !== res.idKey) {
      console.warn(`[Inbox] Identity key CHANGED for ${peerId.slice(-8)} — ignoring (possible impersonation)`);
      return;
    }
    this.peerIdKeys.set(peerId, res.idKey);
    this.peerBoxKeys.set(peerId, res.boxKey);
    this.store?.set('peerIdKeys', Object.fromEntries(this.peerIdKeys));
    this.store?.set('peerBoxKeys', Object.fromEntries(this.peerBoxKeys));
    this.p2p.emit('peer:keys', { id: peerId });
  }

  /**
   * Seal a payload for an offline recipient and spread it to holders.
   * Returns number of copies stored (0 = couldn't, caller should queue).
   */
  async sendOffline(recipientId, payload) {
    const boxKey = this.peerBoxKeys.get(recipientId);
    if (!boxKey) return 0; // never met them → no key to encrypt to
    const crypto = this.p2p.crypto;
    const body = JSON.stringify(payload);
    const sealed = crypto.encryptForRecipient(JSON.stringify({
      body, idKey: crypto.getPublicKey(), sig: crypto.sign(body)
    }), boxKey);
    if (sealed.length > MAX_BLOB) throw new Error('Message too large for offline delivery');

    const id = payload.id;
    let copies = 0;
    // 1) Keep a copy ourselves (we're a holder too)
    this.p2p.messageStore.storeMessage(recipientId, sealed, this.p2p.peerId, id);
    copies++;
    // 2) Replicate to other online peers
    const holders = this.p2p.getConnectedPeers()
      .map((p) => (typeof p === 'string' ? p : p.id))
      .filter((p) => p && p !== recipientId)
      .slice(0, REPLICAS);
    await Promise.allSettled(holders.map(async (h) => {
      const r = await request(this.p2p.node, h, INBOX_PROTOCOL, { type: 'STORE', recipient: recipientId, blob: sealed, id });
      if (r.ok) copies++;
    }));
    console.log(`[Inbox] Sealed message for ${recipientId.slice(-8)} stored on ${copies} node(s)`);
    return copies;
  }

  /** Pull my messages from a holder, decrypt, verify, deliver, ACK */
  async fetchFrom(peerId) {
    const res = await request(this.p2p.node, peerId, INBOX_PROTOCOL, { type: 'FETCH' });
    const msgs = Array.isArray(res.messages) ? res.messages : [];
    if (!msgs.length) return 0;
    const done = [];
    for (const m of msgs) {
      try {
        const inner = JSON.parse(this.p2p.crypto.decryptFromSender(m.encrypted));
        if (!this.p2p.crypto.verify(inner.body, inner.sig, inner.idKey)) throw new Error('bad signature');
        const payload = JSON.parse(inner.body);
        const known = this.peerIdKeys.get(payload.senderId);
        if (known && known !== inner.idKey) throw new Error('sender key mismatch');
        payload.verified = !!known;
        await this.p2p.handleDirectMessage(payload, payload.senderId);
      } catch (e) {
        console.warn('[Inbox] Dropped undecryptable/forged message:', e.message);
      }
      done.push(m.id);
    }
    await request(this.p2p.node, peerId, INBOX_PROTOCOL, { type: 'ACK', ids: done }).catch(() => {});
    console.log(`[Inbox] Fetched ${done.length} offline message(s) from ${peerId.slice(-8)}`);
    return done.length;
  }
}

module.exports = { Inbox, KEYS_PROTOCOL, INBOX_PROTOCOL };
