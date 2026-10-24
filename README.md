# P2P Chat - Decentralized Messenger

A Telegram-like chat application that works **completely serverless** using peer-to-peer networking, similar to how BitTorrent and Bitcoin work.

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
- **💾 Local Storage** - All chats stored on your device (SQLite)
- **☁️ Google Drive Backup** - WhatsApp-style encrypted cloud backup
- **🔍 Auto-Discovery** - Find friends on same WiFi automatically
- **📱 Telegram-style UI** - Beautiful, familiar interface
- **🔐 End-to-End Encryption** - Messages encrypted in transit
- **🌍 Works Over Internet** - Connect to anyone, anywhere

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

## 📜 License

MIT

## 🙏 Acknowledgments

- [libp2p](https://libp2p.io/) - The networking stack
- [Protocol Labs](https://protocol.ai/) - IPFS/libp2p creators
- [Telegram](https://telegram.org/) - UI inspiration
