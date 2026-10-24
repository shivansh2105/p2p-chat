# P2P Chat - Decentralized Messenger

A Telegram-like chat application that works **completely serverless** using peer-to-peer networking, similar to how BitTorrent and Bitcoin work.

## 🔥 New: Username Registry & End-to-End Encryption

**Connect by username, not addresses!** Like @handles but decentralized:

```
You: "Hey, add me on P2P Chat! My username is @alice"
Friend: Searches "alice" → Finds you → Connects directly
```

**Tailscale-inspired architecture:**
- **Ed25519 Identity Keys** — Your permanent cryptographic identity
- **X25519 Session Keys** — Per-chat encryption (like Signal)
- **DHT Username Registry** — Globally unique usernames stored in the network
- **Optional Coordination Server** — Faster lookups (works without it too)

## 🌐 Volunteer Relay Nodes (Like Tor/Bitcoin)

**Help the network!** Your PC can be a relay node to help others connect:

```
┌─────────────────────────────────────────────────────────────────┐
│                    VOLUNTEER RELAY NETWORK                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User A (behind NAT)                                           │
│       │                                                          │
│       │ ← Can't connect directly                                │
│       ▼                                                          │
│   ┌──────────────────┐                                          │
│   │  VOLUNTEER RELAY  │ ← Your PC (helping the network!)        │
│   │  (Your PC!)       │                                          │
│   └──────────────────┘                                          │
│       │                                                          │
│       │ → Forwards encrypted packets                            │
│       ▼                                                          │
│   User B (also behind NAT)                                      │
│                                                                  │
│   Privacy: All traffic END-TO-END ENCRYPTED                     │
│   Relay cannot read messages - only forward packets             │
│   Same model as Tor/Tailscale DERP                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Why run a relay?**
- 🌍 **Strengthen the network** — More relays = better connectivity
- 🤝 **Help friends** — Especially those behind strict firewalls/NAT
- ⚡ **Priority routing** — Relay nodes get faster connections
- 📊 **Track your impact** — See how many peers you've helped

**Enabled by default** (like BitTorrent seeding). Turn off in Settings → Relay if needed.

## 🌐 How It Works (No Servers Required!)

```
┌─────────────────────────────────────────────────────────────────┐
│                    P2P NETWORK ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User A ◄─────────────► User B                                 │
│      │                      │                                    │
│      │    Direct P2P        │                                    │
│      │    Connection        │                                    │
│      ▼                      ▼                                    │
│   ┌──────────────────────────────────────┐                      │
│   │         KADEMLIA DHT                  │                      │
│   │   (Distributed Hash Table)            │                      │
│   │   Same as BitTorrent peer discovery   │                      │
│   └──────────────────────────────────────┘                      │
│      │                      │                                    │
│      ▼                      ▼                                    │
│   User C ◄──────────────► User D                                │
│                                                                  │
│   Messages spread via GOSSIP (like Bitcoin transactions)        │
│   NAT traversal via FREE STUN servers (Google, Cloudflare)      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technologies

| Component | Technology | Similar To |
|-----------|-----------|------------|
| Peer Discovery | Kademlia DHT | BitTorrent DHT |
| Message Propagation | GossipSub | Bitcoin Gossip |
| NAT Traversal | WebRTC + STUN | WebRTC calls |
| Local Discovery | mDNS | AirDrop |
| Encryption | Noise Protocol | Signal Protocol |

## ✨ Features

- **🔒 Fully Decentralized** - No central servers, peers connect directly
- **💾 Local Storage** - All chats stored on your device
- **☁️ Google Drive Backup** - WhatsApp-style encrypted cloud backup
- **🔍 Auto-Discovery** - Find friends on same WiFi automatically
- **📱 Telegram-style UI** - Beautiful, familiar interface
- **🔐 End-to-End Encryption** - Messages encrypted in transit
- **🌍 Works Over Internet** - Connect to anyone, anywhere
- **📲 Cross-Platform** - Windows, Mac, Linux, Android, iOS

## 📥 Download

| Platform | Download |
|----------|----------|
| Windows | [Download .exe](https://github.com/shivansh2105/p2p-chat/releases/latest) |
| macOS | [Download .dmg](https://github.com/shivansh2105/p2p-chat/releases/latest) |
| Linux | [Download .AppImage](https://github.com/shivansh2105/p2p-chat/releases/latest) |
| Android | [Download .apk](https://github.com/shivansh2105/p2p-chat/actions) (from Actions artifacts) |

Or build from source (see below).

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Clone or navigate to the project
cd p2p-chat

# Install dependencies
npm install

# Rebuild native modules for Electron
npm run rebuild

# Start the app
npm start
```

### Development

```bash
npm run dev  # Opens with DevTools
```

## 🤝 Connecting with Friends

### Method 1: Share Address (Internet)
1. Click the **menu** (☰) → **Settings** → copy your **Peer Address**
2. Send it to your friend (via any channel)
3. They paste it in **New Chat** → **Connect**

### Method 2: Same WiFi (Auto-Discovery)
1. Both users on same network
2. Peers appear automatically in **New Chat** → **Nearby Peers**

### Method 3: QR Code
1. Go to **New Chat** → **Share** tab
2. Friend scans QR code

## 📁 Project Structure

```
p2p-chat/
├── src/
│   ├── main/
│   │   ├── main.js           # Electron main process
│   │   ├── preload.js        # Context bridge
│   │   ├── p2p-node.js       # libp2p networking (DHT + Gossip)
│   │   ├── database.js       # SQLite local storage
│   │   └── google-drive.js   # Backup functionality
│   └── renderer/
│       ├── index.html        # Main UI
│       ├── styles.css        # Telegram-style CSS
│       └── app.js            # Frontend logic
├── package.json
└── README.md
```

## 🔧 Configuration

### Google Drive Backup

1. Create a project at [Google Cloud Console](https://console.cloud.google.com/)
2. Enable Google Drive API
3. Create OAuth 2.0 credentials
4. Set environment variables:
   ```bash
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   ```

### Running Your Own Bootstrap Nodes

For a larger network, you can run relay nodes:

```javascript
// In p2p-node.js, add to BOOTSTRAP_NODES:
const BOOTSTRAP_NODES = [
  '/ip4/YOUR_SERVER_IP/tcp/4001/p2p/YOUR_PEER_ID'
];
```

## 🔐 Security

- **Transport Encryption**: Noise protocol (same as Signal)
- **Message Privacy**: Messages only readable by sender/recipient
- **No Metadata Leakage**: No central server logs your activity
- **Backup Encryption**: AES-256-GCM with user-derived keys

### Encryption Architecture (Tailscale-inspired)

```
┌─────────────────────────────────────────────────────────────────┐
│                    SECURITY ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  IDENTITY LAYER (Ed25519)                                       │
│  ├── Each user has a permanent keypair                          │
│  ├── Public key = Your identity (like Tailscale node key)       │
│  ├── Private key NEVER leaves device                            │
│  └── Used to sign username registrations                        │
│                                                                  │
│  SESSION LAYER (X25519 ECDH)                                    │
│  ├── Ephemeral keys generated per chat                          │
│  ├── Diffie-Hellman key exchange                                │
│  └── Perfect forward secrecy                                    │
│                                                                  │
│  MESSAGE LAYER (AES-256-GCM)                                    │
│  ├── Symmetric encryption for speed                             │
│  ├── Keys derived via HKDF from session secret                  │
│  └── Each message has unique IV                                 │
│                                                                  │
│  TRANSPORT LAYER (Noise Protocol)                               │
│  └── All P2P connections encrypted                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Username Registry (DHT-based)

Usernames are stored in the distributed hash table:

| Key | Value |
|-----|-------|
| `/p2pchat/username/alice` | `{ publicKey, peerId, addresses, signature }` |

- **Globally unique** — First come, first served
- **Self-sovereign** — You own your username (signed by your key)
- **Decentralized** — No central authority controls usernames
- **Renewable** — Re-announce every 24 hours to keep active

## 📊 Network Properties

| Property | Value |
|----------|-------|
| Min Connections | 3 peers |
| Max Connections | 50 peers |
| DHT Routing | ~3 hops for 1000+ nodes |
| Message Delivery | Multi-path redundancy |
| Offline Sync | Automatic on reconnect |

## 🛠️ Technologies Used

- **Electron** - Cross-platform desktop app
- **libp2p** - Modular P2P networking
- **better-sqlite3** - Fast local database
- **Google APIs** - Drive backup
- **WebRTC** - NAT traversal

## 📱 Mobile App

### Android Build

```bash
cd mobile
npm install
npm run build
npx cap add android
npx cap sync android
npx cap open android  # Opens in Android Studio
```

Then build APK from Android Studio, or run:
```bash
cd android && ./gradlew assembleDebug
```

### iOS Build (requires macOS)

```bash
cd mobile
npm install
npm run build
npx cap add ios
npx cap sync ios
npx cap open ios  # Opens in Xcode
```

## 📜 License

MIT

## 🙏 Acknowledgments

- [libp2p](https://libp2p.io/) - The networking stack
- [Protocol Labs](https://protocol.ai/) - IPFS/libp2p creators
- [Telegram](https://telegram.org/) - UI inspiration
