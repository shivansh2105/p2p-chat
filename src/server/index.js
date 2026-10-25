#!/usr/bin/env node
/**
 * P2P Chat — headless server mode (always-on relay + storage + seeder).
 *
 *   npm run server -- --public-ip 203.0.113.10
 *   node src/server/index.js --data /var/lib/p2p-chat --storage-gb 100 --http 8080
 *
 * Runs the SAME network node as the desktop app, without a window:
 *  - circuit relay for NAT'd PCs and phones (bigger limits than desktops)
 *  - holds sealed offline messages, accepts video replicas, seeds videos
 *  - DHT server, BitTorrent seeding, optional free Cloudflare tunnel
 * Every flag also has an env var (e.g. --storage-gb → P2P_STORAGE_GB).
 */
const path = require('path');
const os = require('os');
const http = require('http');
const { P2PNode } = require('../main/p2p-node');
const { FileStore, ServerDatabase } = require('./file-store');

const HELP = `
P2P Chat server — always-on relay, storage and seeder

Options (env var in brackets):
  --data DIR            data directory            [P2P_DATA]       default ~/.p2p-chat-server
  --name NAME           display name              [P2P_NAME]       default "server"
  --tcp PORT            TCP port                  [P2P_TCP]        default 4001
  --ws PORT             WebSocket port (phones)   [P2P_WS]         default 4002
  --public-ip IP        announce this public IPv4 [P2P_PUBLIC_IP]  (VPS with a public IP)
  --domain NAME         announce this DNS name    [P2P_DOMAIN]
  --announce ADDR       extra multiaddr to announce, repeatable [P2P_ANNOUNCE, comma-separated]
  --bootstrap ADDR      extra peer to join through, repeatable  [P2P_BOOTSTRAP]
  --storage-gb N        disk for videos/mail      [P2P_STORAGE_GB] default 50
  --relay-slots N       relay reservations        [P2P_RELAY_SLOTS] default 1024
  --tunnel on|off|auto  free Cloudflare tunnel    [P2P_TUNNEL]     default auto (on unless --public-ip/--domain)
  --bittorrent on|off   seed on BitTorrent        [P2P_BITTORRENT] default on
  --upnp on|off         router port mapping       [P2P_UPNP]       default on
  --public-dht on|off   join public libp2p DHT    [P2P_PUBLIC_DHT] default on
  --http PORT           health/status JSON on 127.0.0.1:PORT/health [P2P_HTTP]
  --http-host HOST      bind health endpoint      [P2P_HTTP_HOST]  default 127.0.0.1
  -h, --help
`;

function parseArgs(argv) {
  const out = { announce: [], bootstrap: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const v = inline ?? argv[++i];
      if (k === 'announce' || k === 'bootstrap') out[k].push(v);
      else out[k] = v;
    }
  }
  const env = (k) => process.env[`P2P_${k}`];
  const list = (k) => (env(k) ? env(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
  const onOff = (v, def) => (v == null ? def : !/^(off|false|0|no)$/i.test(String(v)));
  const cfg = {
    data: out.data || env('DATA') || path.join(os.homedir(), '.p2p-chat-server'),
    name: out.name || env('NAME') || 'server',
    tcp: Number(out.tcp || env('TCP') || 4001),
    ws: Number(out.ws || env('WS') || 4002),
    publicIp: out['public-ip'] || env('PUBLIC_IP') || null,
    domain: out.domain || env('DOMAIN') || null,
    announce: [...out.announce, ...list('ANNOUNCE')],
    bootstrap: [...out.bootstrap, ...list('BOOTSTRAP')],
    storageGb: Number(out['storage-gb'] || env('STORAGE_GB') || 50),
    relaySlots: Number(out['relay-slots'] || env('RELAY_SLOTS') || 1024),
    tunnel: out.tunnel || env('TUNNEL') || 'auto',
    bittorrent: onOff(out.bittorrent ?? env('BITTORRENT'), true),
    upnp: onOff(out.upnp ?? env('UPNP'), true),
    publicDht: onOff(out['public-dht'] ?? env('PUBLIC_DHT'), true),
    http: out.http || env('HTTP') ? Number(out.http || env('HTTP')) : null,
    httpHost: out['http-host'] || env('HTTP_HOST') || '127.0.0.1',
    help: out.help
  };
  if (cfg.publicIp) cfg.announce.push(`/ip4/${cfg.publicIp}/tcp/${cfg.tcp}`, `/ip4/${cfg.publicIp}/tcp/${cfg.ws}/ws`);
  if (cfg.domain) cfg.announce.push(`/dns4/${cfg.domain}/tcp/${cfg.tcp}`, `/dns4/${cfg.domain}/tcp/${cfg.ws}/ws`);
  cfg.tunnelOn = cfg.tunnel === 'auto' ? !(cfg.publicIp || cfg.domain) : onOff(cfg.tunnel, false);
  return cfg;
}

function status(node, cfg, startedAt) {
  const vs = node.videoStore;
  const relay = node.node?.services?.relay;
  return {
    ok: !!node.node && node.node.status === 'started',
    name: cfg.name,
    peerId: node.peerId,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    addresses: node.getShareableAddresses(),
    announced: node.node?.getMultiaddrs().map(String) || [],
    peers: node.connectedPeers.size,
    connections: node.node?.getConnections().length || 0,
    relayReservations: relay?.reservations?.size ?? null,
    videos: vs.getStats(),
    storageQuotaMB: node.store.get('storageQuotaMB'),
    mailbox: node.messageStore.getStats(),
    tunnel: node.tunnel?.addr || null,
    bittorrent: node.torrent ? { active: node.torrent.available, port: node.torrent.port } : null
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) { console.log(HELP); return; }

  const store = new FileStore(path.join(cfg.data, 'server-config.json'));
  // Server role: always relay + store; settings are re-applied on every start
  const settings = {
    user: { username: cfg.name },
    relayEnabled: true,
    storageEnabled: true,
    storageQuotaMB: Math.round(cfg.storageGb * 1024),
    listenPorts: { tcp: cfg.tcp, ws: cfg.ws, tcp6: cfg.tcp + 2, ws6: cfg.ws + 2 },
    announceAddrs: cfg.announce,
    extraBootstrap: cfg.bootstrap,
    bootstrap: cfg.publicDht,
    mdns: false,
    upnp: cfg.upnp,
    tunnel: cfg.tunnelOn,
    bittorrent: cfg.bittorrent,
    relayMaxReservations: cfg.relaySlots,
    relayDataLimitMB: 1024,
    relayDurationMin: 120,
    maxConnections: 1000,
    videoSafeCopies: 10
  };
  for (const [k, v] of Object.entries(settings)) store.set(k, v);

  const node = new P2PNode(new ServerDatabase(), store, cfg.data);
  const startedAt = Date.now();
  await node.start();

  let httpServer = null;
  if (cfg.http) {
    httpServer = http.createServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/') { res.writeHead(404); return res.end(); }
      const s = status(node, cfg, startedAt);
      res.writeHead(s.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s, null, 2));
    }).listen(cfg.http, cfg.httpHost);
  }

  const banner = () => {
    const s = status(node, cfg, startedAt);
    console.log('\n══════════ P2P Chat server ══════════');
    console.log(`Peer ID : ${s.peerId}`);
    console.log(`Peers   : ${s.peers} app peers, ${s.connections} connections`);
    console.log(`Storage : ${s.videos.videosSeeding} videos seeding, ${s.videos.totalSizeMB} MB / ${cfg.storageGb} GB; ${s.mailbox.totalMessages} sealed messages held`);
    if (s.tunnel) console.log(`Tunnel  : ${s.tunnel}`);
    if (s.bittorrent) console.log(`BitTorrent: ${s.bittorrent.active ? 'active on port ' + s.bittorrent.port : 'not running (optional)'}`);
    console.log('Add one of these to src/main/servers.js (and a /ws one to mobile/src/servers.js):');
    for (const a of [...new Set([...cfg.announce.map((x) => `${x}/p2p/${s.peerId}`), ...s.addresses])].slice(0, 6)) console.log('  ' + a);
    if (cfg.http) console.log(`Health  : http://${cfg.httpHost}:${cfg.http}/health`);
    console.log('═════════════════════════════════════\n');
  };
  setTimeout(banner, 8000); // after tunnel/BitTorrent come up
  setInterval(() => {
    const s = status(node, cfg, startedAt);
    console.log(`[status] peers=${s.peers} conns=${s.connections} relaySlots=${s.relayReservations ?? '?'} seeding=${s.videos.videosSeeding} mail=${s.mailbox.totalMessages} tunnel=${s.tunnel ? 'up' : 'off'}`);
  }, 5 * 60 * 1000).unref();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received — shutting down cleanly…`);
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    try { httpServer?.close(); await node.stop(); store.flush(); } catch (e) { console.error(e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A bug in one request must never take the server down
  process.on('uncaughtException', (e) => console.error('[server] uncaught:', e.stack || e.message));
  process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e?.stack || e));
}

if (require.main === module) {
  main().catch((e) => { console.error('Server failed to start:', e); process.exit(1); });
}

module.exports = { parseArgs, status, main };
