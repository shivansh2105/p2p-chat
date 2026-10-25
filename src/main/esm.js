/**
 * ESM bridge.
 *
 * libp2p 2.x and its modules are ESM-only. Electron 33 embeds Node 20.18,
 * where require() of an ESM-only package throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Dynamic import() works from CommonJS, so load everything once here.
 */

let mods = null;

// libp2p's deps (it-queue, mortice, …) call Promise.withResolvers, which only
// exists from Node 22. Electron 33 embeds Node 20.18 → polyfill it.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

async function loadEsm() {
  if (mods) return mods;
  const [
    libp2p, tcp, ws, noise, yamux, identify, dht, gossipsub, mdns,
    relay, autonat, dcutr, bootstrap, maddr, peerId, keys, cid, sha2, upnp
  ] = await Promise.all([
    import('libp2p'),
    import('@libp2p/tcp'),
    import('@libp2p/websockets'),
    import('@chainsafe/libp2p-noise'),
    import('@chainsafe/libp2p-yamux'),
    import('@libp2p/identify'),
    import('@libp2p/kad-dht'),
    import('@chainsafe/libp2p-gossipsub'),
    import('@libp2p/mdns'),
    import('@libp2p/circuit-relay-v2'),
    import('@libp2p/autonat'),
    import('@libp2p/dcutr'),
    import('@libp2p/bootstrap'),
    import('@multiformats/multiaddr'),
    import('@libp2p/peer-id'),
    import('@libp2p/crypto/keys'),
    import('multiformats/cid'),
    import('multiformats/hashes/sha2'),
    import('@libp2p/upnp-nat')
  ]);
  mods = {
    createLibp2p: libp2p.createLibp2p,
    tcp: tcp.tcp,
    webSockets: ws.webSockets,
    noise: noise.noise,
    yamux: yamux.yamux,
    identify: identify.identify,
    kadDHT: dht.kadDHT,
    passthroughMapper: dht.passthroughMapper,
    gossipsub: gossipsub.gossipsub,
    mdns: mdns.mdns,
    circuitRelayTransport: relay.circuitRelayTransport,
    circuitRelayServer: relay.circuitRelayServer,
    autoNAT: autonat.autoNAT,
    dcutr: dcutr.dcutr,
    bootstrap: bootstrap.bootstrap,
    multiaddr: maddr.multiaddr,
    peerIdFromString: peerId.peerIdFromString,
    generateKeyPair: keys.generateKeyPair,
    privateKeyToProtobuf: keys.privateKeyToProtobuf,
    privateKeyFromProtobuf: keys.privateKeyFromProtobuf,
    CID: cid.CID,
    sha256: sha2.sha256,
    uPnPNAT: upnp.uPnPNAT
  };
  return mods;
}

function esm() {
  if (!mods) throw new Error('ESM modules not loaded yet — call loadEsm() first');
  return mods;
}

// Replacement for the ESM-only `uint8arrays` utf8 helpers
const enc = new TextEncoder();
const dec = new TextDecoder();
const fromString = (s) => enc.encode(s);
const toString = (u) => dec.decode(u);

module.exports = { loadEsm, esm, fromString, toString };
