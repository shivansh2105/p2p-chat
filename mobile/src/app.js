/**
 * P2P Chat Mobile - Browser-Native WebRTC Implementation
 * 
 * Uses browser's built-in WebRTC APIs (no Node.js native modules).
 * Signaling is done via QR codes or manual copy/paste - truly serverless.
 */

import { Preferences } from '@capacitor/preferences';

// Free public STUN + TURN servers for NAT traversal
// TURN servers relay traffic when direct P2P fails (required for symmetric NAT)
const ICE_SERVERS = [
  // STUN servers (discover public IP)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  
  // Free TURN servers from Open Relay Project (relay traffic through firewalls)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  
  // Backup TURN servers
  {
    urls: 'turn:relay.metered.ca:80',
    username: 'e8dd65b92c62d5e90c2495b1',
    credential: 'kfOyCZvnMCGtk2xR'
  },
  {
    urls: 'turn:relay.metered.ca:443',
    username: 'e8dd65b92c62d5e90c2495b1',
    credential: 'kfOyCZvnMCGtk2xR'
  }
];

class P2PChatMobile {
  constructor() {
    this.peerId = this.generatePeerId();
    this.username = 'Anonymous';
    this.connections = new Map(); // peerId -> { pc, dataChannel }
    this.messages = [];
    this.onMessage = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
  }

  generatePeerId() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  }

  async init() {
    // Load saved data
    const { value: savedUsername } = await Preferences.get({ key: 'username' });
    if (savedUsername) this.username = savedUsername;

    const { value: savedMessages } = await Preferences.get({ key: 'messages' });
    if (savedMessages) {
      try {
        this.messages = JSON.parse(savedMessages);
      } catch (e) {
        this.messages = [];
      }
    }

    console.log('P2P Chat Mobile initialized with peer ID:', this.peerId);
    return this;
  }

  async setUsername(name) {
    // Sanitize
    this.username = name.replace(/[<>"'&]/g, '').slice(0, 50);
    await Preferences.set({ key: 'username', value: this.username });
  }

  /**
   * Create an offer to connect to this device.
   * Display this as a QR code for the other device to scan.
   */
  async createConnectionOffer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    
    // Monitor connection state
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.error('ICE connection failed - may need TURN server');
      }
    };
    
    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
    };
    
    // Create data channel for messaging
    const dataChannel = pc.createDataChannel('chat', { ordered: true });
    this.setupDataChannel(dataChannel, null);

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete
    await this.waitForIceGathering(pc);

    const connectionInfo = {
      type: 'offer',
      peerId: this.peerId,
      username: this.username,
      sdp: pc.localDescription.sdp
    };

    // Store pending connection
    this.pendingOffer = { pc, dataChannel };

    return btoa(JSON.stringify(connectionInfo));
  }

  /**
   * Accept a connection offer (from QR scan or paste)
   */
  async acceptConnectionOffer(offerData) {
    try {
      const info = JSON.parse(atob(offerData));
      if (info.type !== 'offer') throw new Error('Invalid offer');

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      
      // Monitor connection state
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          console.error('ICE connection failed - may need TURN server');
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
      };
      
      // Handle incoming data channel
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, info.peerId);
        this.connections.set(info.peerId, { 
          pc, 
          dataChannel: event.channel,
          username: info.username 
        });
        if (this.onPeerConnected) {
          this.onPeerConnected(info.peerId, info.username);
        }
      };

      // Set remote description (the offer)
      await pc.setRemoteDescription({ type: 'offer', sdp: info.sdp });
      
      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      // Wait for ICE gathering
      await this.waitForIceGathering(pc);

      const answerInfo = {
        type: 'answer',
        peerId: this.peerId,
        username: this.username,
        sdp: pc.localDescription.sdp
      };

      // Store the connection
      this.pendingAnswer = { pc, remotePeerId: info.peerId, remoteUsername: info.username };

      return btoa(JSON.stringify(answerInfo));
    } catch (e) {
      console.error('Failed to accept offer:', e);
      throw new Error('Invalid connection code');
    }
  }

  /**
   * Complete connection with answer (the offerer calls this)
   */
  async completeConnection(answerData) {
    if (!this.pendingOffer) throw new Error('No pending offer');

    try {
      const info = JSON.parse(atob(answerData));
      if (info.type !== 'answer') throw new Error('Invalid answer');

      const { pc, dataChannel } = this.pendingOffer;
      
      await pc.setRemoteDescription({ type: 'answer', sdp: info.sdp });
      
      // Store connection
      this.connections.set(info.peerId, { 
        pc, 
        dataChannel,
        username: info.username 
      });

      this.pendingOffer = null;

      if (this.onPeerConnected) {
        this.onPeerConnected(info.peerId, info.username);
      }

      return info.peerId;
    } catch (e) {
      console.error('Failed to complete connection:', e);
      throw new Error('Invalid answer code');
    }
  }

  setupDataChannel(channel, peerId) {
    channel.onopen = () => {
      console.log('Data channel opened with peer:', peerId);
    };

    channel.onclose = () => {
      console.log('Data channel closed:', peerId);
      if (peerId && this.connections.has(peerId)) {
        this.connections.delete(peerId);
        if (this.onPeerDisconnected) {
          this.onPeerDisconnected(peerId);
        }
      }
    };

    channel.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        // Add to messages
        const message = {
          id: msg.id || this.generatePeerId(),
          from: msg.from,
          fromUsername: msg.fromUsername,
          content: msg.content.replace(/[<>"'&]/g, ''), // XSS sanitize
          timestamp: msg.timestamp || Date.now()
        };
        
        this.messages.push(message);
        await this.saveMessages();
        
        if (this.onMessage) {
          this.onMessage(message);
        }
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };
  }

  async waitForIceGathering(pc) {
    if (pc.iceGatheringState === 'complete') return;
    
    return new Promise((resolve) => {
      let candidateCount = 0;
      
      // Log ICE candidates for debugging
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidateCount++;
          console.log(`ICE candidate ${candidateCount}:`, event.candidate.type, event.candidate.address);
        }
      };
      
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          console.log(`ICE gathering complete. Total candidates: ${candidateCount}`);
          resolve();
        }
      };
      pc.onicegatheringstatechange = checkState;
      
      // Timeout after 15 seconds (TURN candidates take longer)
      setTimeout(() => {
        console.log(`ICE gathering timeout. Candidates gathered: ${candidateCount}`);
        resolve();
      }, 15000);
    });
  }

  /**
   * Send a message to all connected peers
   */
  async sendMessage(content) {
    const sanitizedContent = content.replace(/[<>"'&]/g, '').slice(0, 5000);
    
    const message = {
      id: this.generatePeerId(),
      from: this.peerId,
      fromUsername: this.username,
      content: sanitizedContent,
      timestamp: Date.now()
    };

    // Send to all connected peers
    for (const [peerId, conn] of this.connections) {
      if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
        try {
          conn.dataChannel.send(JSON.stringify(message));
        } catch (e) {
          console.error('Failed to send to peer:', peerId, e);
        }
      }
    }

    // Add to our own messages
    this.messages.push(message);
    await this.saveMessages();

    return message;
  }

  /**
   * Send a direct message to a specific peer
   */
  async sendDirectMessage(peerId, content) {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.dataChannel || conn.dataChannel.readyState !== 'open') {
      throw new Error('Not connected to peer');
    }

    const sanitizedContent = content.replace(/[<>"'&]/g, '').slice(0, 5000);

    const message = {
      id: this.generatePeerId(),
      from: this.peerId,
      fromUsername: this.username,
      content: sanitizedContent,
      timestamp: Date.now(),
      direct: true
    };

    conn.dataChannel.send(JSON.stringify(message));
    this.messages.push(message);
    await this.saveMessages();

    return message;
  }

  async saveMessages() {
    // Keep last 1000 messages
    if (this.messages.length > 1000) {
      this.messages = this.messages.slice(-1000);
    }
    await Preferences.set({ 
      key: 'messages', 
      value: JSON.stringify(this.messages) 
    });
  }

  getConnectedPeers() {
    const peers = [];
    for (const [peerId, conn] of this.connections) {
      if (conn.dataChannel && conn.dataChannel.readyState === 'open') {
        peers.push({
          peerId,
          username: conn.username || 'Unknown'
        });
      }
    }
    return peers;
  }

  disconnect(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) {
      if (conn.dataChannel) conn.dataChannel.close();
      if (conn.pc) conn.pc.close();
      this.connections.delete(peerId);
    }
  }

  disconnectAll() {
    for (const peerId of this.connections.keys()) {
      this.disconnect(peerId);
    }
  }
}

// Export singleton
const p2pChat = new P2PChatMobile();
export default p2pChat;

// Also expose globally for the HTML
window.P2PChat = p2pChat;
