// electron test/phone-autojoin-check.js <url>
// Real phone UI, fresh profile, NOTHING pasted: how long until it shows an app peer?
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'phone-auto-')));
const url = process.argv[process.argv.length - 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 390, height: 844 });
  const t0 = Date.now();
  await win.loadURL(url);
  let last = '';
  for (let i = 0; i < 72; i++) { // up to 6 min
    await sleep(5000);
    const s = await win.webContents.executeJavaScript(
      `(document.querySelector('#peerCount')?.textContent || '') + ' | ' + (document.querySelector('#peerList')?.innerText || '').split(String.fromCharCode(10)).join(' ')`
    ).catch((e) => 'ERR ' + e.message);
    if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s: ${s}`); last = s; }
    if (/^\d+ online/.test(s)) { console.log(`FOUND an app peer with nothing pasted after ${((Date.now() - t0) / 1000).toFixed(0)}s`); break; }
  }
  app.exit(0);
});
