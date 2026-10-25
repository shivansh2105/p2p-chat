/**
 * Always-on nodes run by the project (headless server mode: `npm run server`).
 *
 * Every desktop app and phone connects to these first, so new users join the
 * network instantly and videos/messages stay online 24/7. The network does NOT
 * depend on them — volunteers, tunnels and public relays keep working without.
 *
 * Add the address your server prints on startup, e.g.
 *   '/ip4/203.0.113.10/tcp/4001/p2p/12D3KooW…'            (desktop: TCP)
 *   '/dns4/node1.example.com/tcp/4002/ws/p2p/12D3KooW…'    (desktop + phones)
 * Phones need a ws/wss address — also add it to mobile/src/servers.js.
 */
const SERVERS = [
  ...(process.env.P2P_SERVERS ? process.env.P2P_SERVERS.split(',').map((s) => s.trim()).filter(Boolean) : [])
];

module.exports = { SERVERS };
