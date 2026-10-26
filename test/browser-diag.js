// electron test/browser-diag.js <url> — inspect the phone node's connectivity over time
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL(process.argv[process.argv.length - 1]);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const s = await win.webContents.executeJavaScript(`(async () => {
      const m = window.__m; if (!m) return 'no node yet';
      const conns = m.node.getConnections();
      const kinds = {}; for (const c of conns) { const a = c.remoteAddr.toString(); const k = a.includes('webrtc') ? 'webrtc' : a.includes('p2p-circuit') ? 'circuit' : a.includes('/wss') || a.includes('/tls/') ? 'wss' : a.includes('/ws') ? 'ws' : 'other'; kinds[k] = (kinds[k] || 0) + 1; }
      const rt = m.node.services.dht?.routingTable?.size;
      const app = await m.appPeers('/p2p-chat/video-sync/1.0.0');
      return JSON.stringify({ t: ${'${i}'}, conns: conns.length, kinds, dhtTable: rt, appPeers: app.length, log: document.getElementById('log').textContent.split('\\n').slice(-2).join(' | ') });
    })()`.replace('${i}', String((i + 1) * 10)));
    console.log(s);
  }
  app.exit(0);
});
