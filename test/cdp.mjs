// node test/cdp.mjs "<js expression>" [shot.png]  — eval in the running Electron window + optional screenshot
const [, , expr = '1', shot] = process.argv;
const targets = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || 9333) + '/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
const res = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails?.exception?.description ?? res.result, null, 1));
if (shot) {
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const s = await Promise.race([
    call('Page.captureScreenshot', { format: 'png', fromSurface: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 20000))
  ]);
  (await import('fs')).writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
  console.log('saved', shot);
}
ws.close();
