// electron test/renderer-check.js — desktop renderer: message direction, unread badge, XSS-safe chat list
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, 'renderer-check.html'));
  await new Promise((r) => setTimeout(r, 1000));
  const r = await win.webContents.executeJavaScript(`(() => {
    const out = [];
    const ok = (n, c) => out.push((c ? 'PASS ' : 'FAIL ') + n);
    const evilId = "x');window.__xss1=1;('";
    chats = [{ id: evilId, name: 'peer', last_message: '<img src=x onerror="window.__xss2=1">', last_message_time: Date.now(), unreadCount: 2 }];
    renderChatList();
    const item = document.querySelector('#chatList .chat-item');
    ok('chat id kept exactly (attribute-safe)', item && item.dataset.chatId === evilId);
    ok('message preview shown as text, no <img> injected', !document.querySelector('#chatList img') && item.textContent.includes('<img src=x'));
    ok('unread badge shows 2 (reads unreadCount)', document.querySelector('#chatList .unread-badge')?.textContent === '2');
    renderMessages([
      { content: 'from them', status: 'read', senderId: '12D3KooWpeer', timestamp: Date.now() },
      { content: 'from me', status: 'sent', senderId: null, timestamp: Date.now() },
      { content: 'old row', status: 'received', sender_id: '12D3KooWpeer', timestamp: Date.now() }
    ]);
    const cls = [...document.querySelectorAll('#messagesContainer .message')].map((m) => m.classList.contains('sent') ? 'sent' : 'received');
    ok('received message on the left even after being marked read', cls[0] === 'received');
    ok('my message on the right', cls[1] === 'sent');
    ok('old-format row still works', cls[2] === 'received');
    return new Promise((res) => setTimeout(() => { ok('no injected script ran', !window.__xss1 && !window.__xss2); res(out.join('\\n')); }, 500));
  })()`);
  console.log(r);
  app.exit(0);
});
