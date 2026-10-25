# Run a P2P Chat server (headless)

An always-on node that keeps the network healthy. It runs the same network code as the desktop app, without a window:

- **Relay** for PCs and phones behind NAT. It has bigger limits than a desktop: 1,024 slots, 1 GB and 2 hours per relayed connection.
- **Storage**: it accepts video copies and sealed offline messages, so content stays available when uploaders and senders go offline.
- **Seeding** on the app network and on BitTorrent.
- **DHT server** for discovery and search.

The network does **not** depend on servers. Volunteers, free tunnels and public relays keep working without them. Servers just make it faster and keep content online 24/7.

## Where to run it (free options first)

| Machine | Cost | Notes |
|---|---|---|
| Old PC / laptop / Raspberry Pi at home | Free | Works behind NAT: it gets a free Cloudflare tunnel automatically. Best if your router supports UPnP or you forward ports 4001 and 4002 |
| Any VPS with a public IP | ~$4–6/month | Most reliable. Use `P2P_PUBLIC_IP` |
| Oracle Cloud Always Free | Free (card needed at signup) | 4 ARM cores, 24 GB RAM, 10 TB/month traffic |

## Install

**Ubuntu / Debian / Raspberry Pi OS (one command):**
```bash
curl -fsSL https://raw.githubusercontent.com/shivansh2105/p2p-chat/master/deploy/install.sh | sudo bash
```
This installs Node 22 and a hardened systemd service, writes settings to `/etc/p2p-chat.env`, and detects your public IP. Re-run it to update.

**Docker:**
```bash
docker build -t p2p-chat-server .
docker run -d --name p2p-chat --restart unless-stopped \
  -p 4001:4001 -p 4002:4002 -v p2p-data:/data \
  -e P2P_PUBLIC_IP=203.0.113.10 p2p-chat-server
```

**Any OS with Node 20+:**
```bash
npm ci --omit=dev --ignore-scripts
npm run server -- --public-ip 203.0.113.10 --storage-gb 100 --http 8080
```

## Settings

| Flag | Env | Default | |
|---|---|---|---|
| `--tcp` / `--ws` | `P2P_TCP` / `P2P_WS` | 4001 / 4002 | Open both in your firewall. Phones use the WebSocket port |
| `--public-ip` | `P2P_PUBLIC_IP` | none | Announce your public IPv4 |
| `--domain` | `P2P_DOMAIN` | none | Announce a DNS name instead |
| `--storage-gb` | `P2P_STORAGE_GB` | 50 | Disk space for videos and mail |
| `--relay-slots` | `P2P_RELAY_SLOTS` | 1024 | Concurrent relay reservations |
| `--tunnel` | `P2P_TUNNEL` | auto | Free Cloudflare tunnel, used when there's no public IP or domain |
| `--bittorrent` | `P2P_BITTORRENT` | on | Also seed on BitTorrent |
| `--http` | `P2P_HTTP` | off | `GET /health` returns status as JSON (bound to 127.0.0.1) |

Run `npm run server -- --help` for everything.

## Put your server into the apps

On startup the server prints its addresses. To make every new install connect to it first:

1. Add the TCP address to `src/main/servers.js` (desktop app).
2. Add the `/ws` address to `mobile/src/servers.js` (Android app).
3. Push. CI builds new installers with the server built in.

## Operate

```bash
journalctl -u p2p-chat -f            # logs (status line every 5 min)
curl -s localhost:8080/health        # peers, relay slots, storage, mail held, tunnel
sudo systemctl restart p2p-chat
```

The server's identity is stored in its data directory. Back that directory up, and keep the same ports, so its address never changes.
