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
| 🧹 | **Smart cleanup** | Your copy is deleted only if your disk is >90% of quota and ≥10 other PCs are confirmed live seeders, or ≥25 are and you haven't watched it in 7 days |
| 🔗 | **Works behind NAT** | UPnP opens a port on home routers, IPv6 needs no NAT, otherwise relay via another PC → hole punching. Falls back to public IPFS relays when no app user can relay |
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

## Download

- **Windows / macOS / Linux / Android:** go to [Actions](https://github.com/shivansh2105/p2p-chat/actions), open the latest green run, and download from **Artifacts**.
- **Releases:** pushing a `v*` tag publishes a [GitHub Release](https://github.com/shivansh2105/p2p-chat/releases).

See [INSTALL.md](INSTALL.md) for install steps.

## Develop

```bash
npm install
npm start               # run the desktop app
npm test                # 42 end-to-end network tests: chat, offline mail,
                        # video swarm, relay-only links, safe eviction
npm run probe:internet  # check public relays / hole punching from your network
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

- **The phone needs one PC address to join.** The first time, paste a PC's address (Network tab). After that, the rest of the network is found automatically. Phones seed only while the app is open.
- **No video compression.** Videos are stored at their original size.
- **Strict NAT on both sides** (common on mobile data): video then needs an app user's PC with an open port to relay. Public relays only carry small amounts of data (~128 KB / 2 min).
- **DHT metadata is public.** Anyone can see who seeds a video and that someone holds mail for a given Peer ID. Message contents stay private.
- **Uploader names on videos aren't signed yet.** Video content is still verified by hash.

## License

MIT. Built on [libp2p](https://libp2p.io/) by Protocol Labs. UI inspired by Telegram.
