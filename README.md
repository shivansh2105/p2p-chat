# P2P Chat

Chat and video sharing with **no central server**, built like BitTorrent: every PC that runs the app helps carry the network.

## What it can do

| | Feature | How |
|---|---|---|
| 💬 | **Encrypted chat** | Direct peer-to-peer. Ed25519 identity, X25519 per-chat keys, AES-256-GCM |
| 📭 | **Offline messages** | Friend offline? The message is sealed to their key and stored on up to 5 other PCs. They get it when they're back, even if you're offline by then. The PCs holding it can't read it |
| 🎬 | **Video sharing** (desktop 🎬 tab + phone Videos tab) | Upload → split into 256 KB chunks → copied to 3 PCs. It stays watchable after the uploader goes offline |
| 🔍 | **Network-wide search** | Find videos by title or tag across the whole network, not just your contacts |
| 🌱 | **Every viewer seeds** | Watching a video makes you a seeder. Desktop streams while downloading (playback starts after the first chunks), pulling from many seeders in parallel |
| 🧲 | **BitTorrent backup layer** | Every video is also a normal torrent (🧲 magnet link). uTorrent / qBittorrent users can download and seed it, and the app falls back to those seeders when no app peer has a video. Runs in a separate process, so if it fails, the app just carries on without it |
| 🧹 | **Smart cleanup** | Your copy is deleted only if your disk is >90% of quota and ≥10 other PCs are confirmed live seeders, or ≥25 are and you haven't watched it in 7 days |
| 🔗 | **Works behind any NAT, free** | Each PC gets a free public address via a Cloudflare Quick Tunnel (no account), so even strict-NAT/CGNAT PCs become reachable relays. Plus UPnP, IPv6, hole punching, and public IPFS relays |
| 🧭 | **Zero-config discovery** | Every install announces itself on the DHT, and reachable ones (public IP, UPnP, IPv6, tunnel, servers) also announce as relays. New desktops **and phones** find community nodes with no address typed in, relays first |
| 🙋 | **Usernames** | Find people by @username via the DHT |
| 📱 | **Phone + PC, one network** | The Android app runs libp2p in the WebView. It joins PCs over WebSocket, reaches the rest via their relays, and uses WebRTC + TURN between phones |
| ☁️ | **Google Drive backup** | Optional, encrypted |

Each PC donates relay + storage (5 GB default). **On by default, opt-out in settings.**

## How it works

```
Upload ─► your PC + 3 copies ─► you go offline ─► others still find & download it
                                                  └─► each viewer becomes a seeder
```

- **No tracker server.** The Kademlia DHT is the tracker. PCs publish provider records:
  - `video:<id>`: I seed this video
  - `kw:<word>`: I have a video with this word in its title or tags
  - `inbox:<you>`: I'm holding mail for you
- **Your keys are your account.** No email or phone number. Keys are stored encrypted on your device (OS keychain), and your Peer ID stays the same across restarts.
- **Integrity.** Every chunk and every full video is checked against its SHA-256 hash. Fake or corrupted data is rejected.
- **Safe cleanup.** Before deleting its copy, a PC connects to the other seeders and checks they really hold the whole video. Stale DHT records don't count.

| Layer | Technology |
|---|---|
| Networking | libp2p (TCP, WebSockets, circuit-relay v2, DCUtR hole punching, AutoNAT) |
| Discovery | Kademlia DHT, mDNS (same WiFi), public libp2p bootstrap nodes |
| Transport encryption | Noise |
| Message encryption | X25519 + HKDF + AES-256-GCM, Ed25519 signatures |
| Storage | electron-store (JSON) + chunk files on disk |

## Servers (optional, recommended)

Run an always-on **headless node** (relay + storage + seeder) on any VPS, old PC or Raspberry Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/shivansh2105/p2p-chat/master/deploy/install.sh | sudo bash
```

Or use `docker build -t p2p-chat-server .`, or `npm run server`. **Every app install is already a server**, and they find each other automatically through DHT rendezvous, so you don't have to list them anywhere. A dedicated always-on node just adds capacity and 24/7 availability. It's found automatically too. Optionally, put a server with a **fixed** address in `src/main/servers.js` / `mobile/src/servers.js` for even faster first contact. See **[deploy/README.md](deploy/README.md)**.

## Download

- **Latest release (Windows / macOS / Linux / Android):** [GitHub Releases](https://github.com/shivansh2105/p2p-chat/releases/latest). Each release lists which file is for which platform.
- **Newest development build:** go to [Actions](https://github.com/shivansh2105/p2p-chat/actions), open the latest green run, and download from **Artifacts**.
- **Maintainers:** bump the version in `package.json` and `mobile/package.json`, then push a `v*` tag. CI publishes the release only if every test and build passes.

See [INSTALL.md](INSTALL.md) for install steps.

## Develop

```bash
npm install
npm start               # run the desktop app
npm test                # 72 end-to-end tests: chat, offline mail, video swarm, relay-only
                        # links, safe eviction, BitTorrent interop + fail-safety, headless server
npm run server          # run a headless always-on node
npm run probe:internet  # check public relays / hole punching from your network
npm run probe:magnet -- "<magnet>"  # standard torrent client fetches an app video
```

Tests run on Node 20.18 (the Node version inside Electron 33).

### Project structure

```
src/main/
  main.js            Electron main process + IPC
  p2p-node.js        libp2p node: transports, relay, DHT, chat
  esm.js             loads ESM-only libp2p modules into Electron's CommonJS
  crypto.js          identity, session + sealed-box encryption
  inbox.js           offline messages (store-and-forward)
  discovery.js       DHT provider records ("trackerless tracker")
  video-store.js     chunking, local storage, hash checks, eviction
  video-protocol.js  search, swarm download, replication
  relay-server.js    volunteer relay stats/limits
  username-registry.js, database.js, google-drive.js
mobile/src/net.js    phone libp2p node (same protocols as desktop)
mobile/src/crypto-web.js  phone crypto, byte-compatible with desktop
test/                end-to-end tests + internet probes
```

### Google Drive backup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the Drive API.
2. Create OAuth 2.0 credentials, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Android build

```bash
cd mobile && npm install && npm run build
npx cap add android && npx cap sync android
cd android && ./gradlew assembleDebug
```

## Limitations (honest)

- **First contact takes a little while.** A brand-new install with nothing configured usually finds the network within 30–90 s via the public DHT. Pasting an address or listing a fixed server in `servers.js` makes it instant. Phones seed only while the app is open.
- **No video compression.** Videos are stored at their original size.
- **Free tunnels are best-effort.** Cloudflare Quick Tunnels need no account but have no SLA, allow up to 200 in-flight requests per PC, and the address changes on restart (it's re-announced automatically). `cloudflared` is downloaded from Cloudflare's GitHub releases on first use. Turn it off with the relay setting.
- **BitTorrent is public.** Seeding a torrent shows your IP to others in that swarm (normal for torrents), and anyone with the magnet can download the video. Turn it off in Videos → "Also share on the BitTorrent network". Desktop only: phones don't join the torrent swarm.
- **Phones-only networks.** Two phones on strict NAT with no app PC online anywhere still can't reach each other, because phones can't run tunnels. One desktop app online, even behind strict NAT, is enough.
- **DHT metadata is public.** Anyone can see who seeds a video and that someone holds mail for a given Peer ID. Message contents stay private.
- **Uploader names on videos aren't signed yet.** Video content is still verified by hash.

## License

MIT. Built on [libp2p](https://libp2p.io/) by Protocol Labs. UI inspired by Telegram.
