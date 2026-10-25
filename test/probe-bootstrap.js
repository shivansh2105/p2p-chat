// Probe: do the public libp2p bootstrap nodes offer circuit-relay (hop)?
const { loadEsm } = require('../src/main/esm');
(async () => {
  const m = await loadEsm();
  const node = await m.createLibp2p({
    transports: [m.tcp(), m.webSockets()],
    connectionEncrypters: [m.noise()],
    streamMuxers: [m.yamux()],
    services: { identify: m.identify() }
  });
  await node.start();
  const addrs = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
  ];
  for (const a of addrs) {
    try {
      const conn = await node.dial(m.multiaddr(a), { signal: AbortSignal.timeout(15000) });
      await new Promise((r) => setTimeout(r, 3000));
      const peer = await node.peerStore.get(conn.remotePeer);
      const hop = peer.protocols.includes('/libp2p/circuit/relay/0.2.0/hop');
      console.log(a.slice(-12), 'connected via', conn.remoteAddr.toString().split('/p2p/')[0], '| relay hop:', hop, '| agent:', new TextDecoder().decode(peer.metadata.get('AgentVersion') || new Uint8Array()));
    } catch (e) {
      console.log(a.slice(-12), 'FAILED', e.message.slice(0, 80));
    }
  }
  await node.stop();
  process.exit(0);
})();
