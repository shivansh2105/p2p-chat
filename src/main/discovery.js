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

// Rendezvous keys: how installs find each other with ZERO configuration
// (like BitTorrent clients finding peers via the DHT). Every node is a server.
const NODES_KEY = 'nodes:v1';   // every app node
const RELAYS_KEY = 'relays:v1'; // nodes others can actually reach (public IP / UPnP / IPv6 / tunnel / server)
const PRIVATE_IP = /^\/ip4\/(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^\/ip6\/(::1|fe80|fc|fd)/i;

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
      await this.p2p.node.contentRouting.provide(await this.cidFor(key), { signal: AbortSignal.timeout(180000) }); // public DHT puts can take minutes
    } catch (e) { /* best effort */ }
  }

  /** Who has <key>? Returns [{ id: PeerId, multiaddrs }] excluding ourselves */
  async findProviders(key, { max = 20, timeout = 20000 } = {}) {
    const out = new Map();
    const self = this.p2p.node.peerId;
    const ctrl = new AbortController();
    let it;
    try {
      const cid = await this.cidFor(key);
      it = this.p2p.node.contentRouting.findProviders(cid, { signal: ctrl.signal })[Symbol.asyncIterator]();
      // Hard deadline enforced HERE: libp2p's compound router doesn't always
      // honour the abort signal (a public-DHT lookup ran for 7+ minutes).
      const deadline = Date.now() + timeout;
      let lastHit = 0;
      while (out.size < max) {
        // Stop at the deadline, or 1.5s after the last new result: one of the
        // two DHTs (often the public one) may never signal "done"
        const left = Math.min(deadline - Date.now(), lastHit ? lastHit + 1500 - Date.now() : Infinity);
        if (left <= 0) break;
        let timer;
        const r = await Promise.race([it.next(), new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), left); })]);
        clearTimeout(timer);
        if (r.timedOut || r.done) break;
        if (!r.value.id.equals(self)) out.set(r.value.id.toString(), r.value);
        lastHit = Date.now();
      }
    } catch (e) { /* no peers / aborted */ }
    ctrl.abort();
    it?.return?.().catch?.(() => {});
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
    if (this.rvTimers) this.rvTimers.forEach(clearInterval);
  }

  // ───────────────────────── rendezvous ─────────────────────────
  /** Can other people dial us without a relay? */
  isReachable() {
    if (this.p2p.tunnel?.addr) return true;
    if ((this.p2p.store?.get('announceAddrs', []) || []).length) return true;
    return this.p2p.node.getMultiaddrs().map(String)
      .some((a) => !a.includes('/p2p-circuit') && !PRIVATE_IP.test(a) && /^\/(ip4|ip6|dns4|dns6|dns)\//.test(a));
  }

  async announceSelf() {
    // In parallel: a slow public-DHT provide must not delay the other record
    await Promise.allSettled([
      this._provide(NODES_KEY),
      this.isReachable() ? this._provide(RELAYS_KEY) : null
    ]);
  }

  /** Connect to more app nodes (relays first) until we have `target` */
  async findNodes(target = this.p2p.store?.get('rendezvousTarget', 6) ?? 6) {
    const { INBOX_PROTOCOL } = require('./inbox');
    let have = (await this.p2p.getAppPeers(INBOX_PROTOCOL)).length;
    if (have >= target) return have;
    for (const key of [RELAYS_KEY, NODES_KEY]) {
      for (const prov of await this.findProviders(key, { max: 20, timeout: 15000 })) {
        if (key === RELAYS_KEY) await this.reserveOn(prov); // even if already connected
        if (have >= target) continue;
        if (this.p2p.connectedPeers.has(prov.id.toString())) continue;
        if (await this.connect(prov)) have++;
      }
      if (have >= target) break;
    }
    return have;
  }

  /**
   * If WE are not reachable, hold a relay slot on a node that is (max 2), so
   * others can always reach us through it. libp2p alone would reserve on the
   * first relay it happens to meet.
   */
  async reserveOn(prov) {
    try {
      if (this.isReachable()) return false;
      const id = prov.id.toString();
      const mine = this.p2p.node.getMultiaddrs().map(String).filter((a) => a.includes('/p2p-circuit'));
      if (mine.some((a) => a.includes(`/p2p/${id}/p2p-circuit`))) return true;
      const viaRelays = new Set(mine.map((a) => a.split('/p2p-circuit')[0].split('/p2p/').pop()));
      if ([...viaRelays].filter((r) => this.relayPeers?.has(r)).length >= 2) return false;
      if (!(await this.connect(prov))) return false;
      const { multiaddr } = esm();
      await this.p2p.node.components.transportManager.listen([multiaddr(`/p2p/${id}/p2p-circuit`)]);
      (this.relayPeers ||= new Set()).add(id);
      return true;
    } catch (e) { return false; }
  }

  startRendezvous() {
    const announce = () => this.announceSelf().catch(() => {});
    const find = () => this.findNodes().catch(() => {});
    setTimeout(() => { announce(); find(); }, this.p2p.store?.get('rendezvousDelayMs', 5000) ?? 5000).unref?.();
    this.rvTimers = [
      setInterval(announce, 30 * 60 * 1000),
      setInterval(find, this.p2p.store?.get('rendezvousEveryMs', 5 * 60 * 1000) ?? 5 * 60 * 1000)
    ];
    this.rvTimers.forEach((t) => t.unref?.());
    // A new public address (tunnel restart, UPnP mapping) → re-announce right away
    this.p2p.tunnel?.on?.('ready', announce);
  }
}

module.exports = { Discovery, NODES_KEY, RELAYS_KEY };
