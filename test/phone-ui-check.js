// electron test/phone-ui-check.js <url> <shareAddr> <tcpAddr>
// Real phone UI (fresh profile): status before/after pasting a PC address,
// list shows only app users, TCP address gives a clear error.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ui-')));
const [url, share, tcp] = process.argv.slice(-3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 390, height: 844 });
  await win.loadURL(url);
  // Every snippet runs inside try/catch so a page error is printed, not thrown
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (${code}); } catch (e) { return 'ERR ' + e.message; } })()`);
  const state = () => js(`JSON.stringify({
    status: document.querySelector('#peerCount')?.textContent,
    list: (document.querySelector('#peerList')?.innerText || '').split(String.fromCharCode(10)).join(' | '),
    toast: document.querySelector('.toast')?.textContent || ''
  })`);
  const paste = (addr) => js(`(document.querySelector('#addrInput').value = ${JSON.stringify(addr)}, document.querySelector('#connectBtn').click(), 'ok')`);
  await sleep(15000);
  console.log('netScreen text:', String(await js(`document.querySelector('#netScreen .setup-card').innerText`)).replace(/\n+/g, ' / '));
  console.log('before paste  :', await state());
  await paste(tcp);
  await sleep(1500);
  console.log('paste TCP addr:', await state());
  await paste(share);
  await sleep(8000);
  console.log('paste share   :', await state());
  app.exit(0);
});
