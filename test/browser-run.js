// Run a page in Electron's Chromium and print window.__e2e results.
//   electron test/browser-run.js <url>
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL(process.argv[process.argv.length - 1]);
  for (let i = 0; i < 330; i++) {
    const done = await win.webContents.executeJavaScript('window.__e2e && window.__e2e.done');
    if (done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(await win.webContents.executeJavaScript("document.getElementById('log').textContent"));
  app.exit(0);
});
