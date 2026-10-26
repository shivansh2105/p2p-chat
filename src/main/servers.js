/**
 * OPTIONAL pinned servers. You normally don't need to list anything here:
 * every install (and every `npm run server` node, incl. home PCs behind NAT
 * using a free tunnel) announces itself on the DHT and new installs find it
 * automatically (discovery.js rendezvous).
 *
 * Only add a server with a FIXED address (public IP or domain) to make first
 * contact instant instead of 30-90 s, e.g.
 *   '/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW…'            (desktop: TCP)
 *   '/dns4/node1.example.com/tcp/4002/ws/p2p/12D3KooW…'    (desktop + phones)
 * Never add a trycloudflare.com address: it changes on every restart.
 * Phones need a ws/wss address, also listed in mobile/src/servers.js.
 */
const SERVERS = [
  ...(process.env.P2P_SERVERS ? process.env.P2P_SERVERS.split(',').map((s) => s.trim()).filter(Boolean) : [])
];

module.exports = { SERVERS };
