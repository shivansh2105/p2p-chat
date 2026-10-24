# P2P Chat - Installation Guide

## 🚀 Quick Install Options

### Option 1: Download Ready-to-Run (Easiest)

Download the installer for your system:

| Platform | Download |
|----------|----------|
| **Windows** | `P2P-Chat-Setup-1.0.0.exe` (installer) or `P2P-Chat-1.0.0-portable.exe` (no install needed) |
| **macOS** | `P2P-Chat-1.0.0.dmg` |
| **Linux** | `P2P-Chat-1.0.0.AppImage` or `.deb` |

Just download, run, and start chatting!

---

### Option 2: Run from Source (For Developers)

```bash
# 1. Clone or download the project
git clone <repo-url>
cd p2p-chat

# 2. Install dependencies
npm install

# 3. Run
npm start
```

Requirements: Node.js 18+ and npm

---

### Option 3: Build Your Own Installer

```bash
# Install dependencies first
npm install

# Build for your current platform
npm run build

# Or build for specific platform:
npm run build:win     # Windows .exe
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux .AppImage

# Build for all platforms (requires all SDKs)
npm run dist
```

Installers will be in the `dist/` folder.

---

## 📱 First Time Setup

1. **Launch the app**
2. **Choose a username** - This is how friends will see you
3. **Share your address** - Go to Menu → New Chat → Share tab
4. **Connect with friends** - Paste their address in the Connect tab

---

## 🔗 Connecting with Friends

### Same WiFi Network
Friends are discovered automatically! Just open the app on the same network.

### Over the Internet
1. **You**: Copy your address from New Chat → Share
2. **Send** the address to your friend (via any channel - SMS, email, etc.)
3. **Friend**: Pastes it in New Chat → Connect → Connect button
4. **Done!** You're connected directly, no server involved

### Example Address
```
/ip4/192.168.1.100/tcp/45678/p2p/12D3KooWAbCdEfGhIjKlMnOpQrStUvWxYz...
```

---

## 🔒 Your Data

- **Local storage**: All chats saved on YOUR device only
- **No servers**: Messages go directly between you and friends
- **Backup**: Optional Google Drive encrypted backup

---

## ❓ Troubleshooting

### "Can't connect to friend"
- Make sure both apps are running
- Check firewall isn't blocking the app
- Try using the WebRTC address (contains `/webrtc`)
- If on different networks, ensure port forwarding or use WebRTC

### "Friend shows as peer ID instead of username"
- They need to set their username in Settings
- Wait a few seconds for presence broadcast

### "Messages not delivering"
- Check network connection
- The other person might be offline (messages will sync when they reconnect)

---

## 🛠 System Requirements

- **Windows**: 10/11 (x64 or ARM64)
- **macOS**: 10.15+ (Intel or Apple Silicon)
- **Linux**: Ubuntu 20.04+ or equivalent
- **RAM**: 200MB
- **Disk**: 150MB

---

## 📦 What's in the Box

```
P2P Chat uses:
├── libp2p      → P2P networking (same as IPFS)
├── Kademlia    → Peer discovery (same as BitTorrent)
├── GossipSub   → Message propagation (same as Bitcoin)
├── SQLite      → Local encrypted storage
├── WebRTC      → NAT traversal
└── Electron    → Cross-platform desktop app
```

No servers. No tracking. Just you and your friends.
