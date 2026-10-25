/**
 * DHT "tracker" — trackerless discovery like BitTorrent's Mainline DHT.
 *
 * Any key (e.g. "video:<id>", "kw:goa", "inbox:<peerId>") is hashed to a CID.
 * Peers that hold the thing publish a provider record for that CID; anyone can
 * look up who holds it. Records live on the DHT (incl. public IPFS DHT nodes),
 * so this works even when none of OUR app's PCs are reachable.
 */
const { esm } = require('./esm');

const REPROVIDE_MS = 12 * 60 * 60 * 1000; // provider records expire ~48h

class Discovery {
  constructor(p2p) {
    this.p2p = p2p;
    this.provided = new Set(); // keys we re-announce periodically
    this.timer = null;
  }

  async cidFor(key) {
    const { CID, sha256 } = esm();
    return CID.createV1(0x55, await sha256.digest(new TextEncoder().encode('p2p-chat:v1:' + key)));
  }

  /** Announce "I have <key>" (fire-and-forget; DHT puts can take a while) */
  provide(key) {
    this.provided.add(key);
    return this._provide(key);
  }

  unprovide(key) {
    // DHT records can't be retracted; we just stop re-announcing so they expire.
    this.provided.delete(key);
  }

  async _provide(key) {
    try {
      await this.p2p.node.contentRouting.provide(await this.cidFor(key), { signal: AbortSignal.timeout(60000) });
    } catch (e) { /* best effort */ }
  }

  /** Who has <key>? Returns [{ id: PeerId, multiaddrs }] excluding ourselves */
  async findProviders(key, { max = 20, timeout = 20000 } = {}) {
    const out = new Map();
    const self = this.p2p.node.peerId;
    try {
      const cid = await this.cidFor(key);
      for await (const prov of this.p2p.node.contentRouting.findProviders(cid, { signal: AbortSignal.timeout(timeout) })) {
        if (prov.id.equals(self)) continue;
        out.set(prov.id.toString(), prov);
        if (out.size >= max) break;
      }
    } catch (e) { /* timeout / no peers */ }
    return [...out.values()];
  }

  /** Dial a provider (works through relays if it advertises /p2p-circuit addrs) */
  async connect(prov) {
    const id = prov.id.toString();
    if (this.p2p.connectedPeers.has(id)) return true;
    try {
      if (prov.multiaddrs?.length) await this.p2p.node.peerStore.merge(prov.id, { multiaddrs: prov.multiaddrs });
      await this.p2p.node.dial(prov.id, { signal: AbortSignal.timeout(20000) });
      return true;
    } catch (e) {
      return false;
    }
  }

  start() {
    this.timer = setInterval(() => {
      for (const k of this.provided) this._provide(k);
    }, REPROVIDE_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { Discovery };
