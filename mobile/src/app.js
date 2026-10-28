// Mobile UI controller (Telegram-style). Networking lives in net.js.
import { MobileNode, PROTO } from './net.js';
import { idb } from './idb.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (t) => { const d = document.createElement('div'); d.textContent = t ?? ''; return d.innerHTML; };
const short = (id) => (id ? '…' + id.slice(-6) : '?');
const toast = (t) => { $$('.toast').forEach((x) => x.remove()); const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3000); };

let node;
let chats = {};          // peerId -> { name, messages: [{from, content, timestamp}] }
let current = null;      // open chat peerId
let results = [];

function show(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $('#' + id).classList.add('active');
  const nav = id === 'threadScreen' ? 'chatsScreen' : id;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === nav));
}

async function saveChats() { await idb.set('chats', chats); }

async function renderPeers() {
  // Only P2P Chat users/PCs — not the public DHT/bootstrap nodes we're also connected to
  const ps = await node.appPeers(PROTO.MESSAGE).catch(() => []);
  const internet = node.peers().length > 0;
  const d = node.discovery;
  const secs = Math.max(0, Math.round((d.nextAt - Date.now()) / 1000));
  let title, detail;
  if (ps.length) {
    title = `Connected · ${ps.length} online`;
    detail = 'You are on the P2P Chat network. Tap someone below to chat.';
  } else if (!internet) {
    title = 'Connecting to the internet…';
    detail = 'Waiting for a network connection.';
  } else if (d.searching || d.searches < 3) {
    title = 'Looking for P2P Chat users…';
    detail = 'Automatic, nothing to type. The first time can take about a minute.';
  } else {
    title = 'No P2P Chat PC found yet';
    detail = `Phones join through PCs that run P2P Chat. Open the desktop app (v1.1.1 or newer) on any PC, on any network, and this phone connects by itself. Next search in ${secs}s.`;
  }
  $('#netTitle').textContent = title;
  $('#netDetail').textContent = detail;
  $('#searchNowBtn').disabled = !!d.searching;
  $('#searchNowBtn').textContent = d.searching ? 'Searching…' : 'Search again now';
  $('#peerCount').textContent = ps.length ? `${ps.length} online` : internet ? 'Searching…' : 'Offline';
  $('#statusDot').className = `status-dot ${ps.length ? 'online' : ''}`;
  $('#peerList').innerHTML = ps.map((p) => `<li data-peer="${esc(p)}">${esc(chats[p]?.name || short(p))}<span class="hint">chat ›</span></li>`).join('')
    || '<li class="hint">Nobody yet</li>';
}

function renderChats() {
  const ids = Object.keys(chats);
  $('#noChats').style.display = ids.length ? 'none' : '';
  $('#chatList').innerHTML = ids.map((id) => {
    const last = chats[id].messages.at(-1);
    return `<li data-peer="${esc(id)}"><b>${esc(chats[id].name || short(id))}</b><br><span class="hint">${esc(last?.content || '')}</span></li>`;
  }).join('');
}

function renderThread() {
  const c = chats[current];
  $('#threadName').textContent = c?.name || short(current);
  $('#messages').innerHTML = (c?.messages || []).map((m) => `
    <div class="message ${m.from === node.peerId ? 'own' : 'other'}">
      <div class="message-content">${esc(m.content)}</div>
      <div class="message-header"><span class="time">${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.note ? ' · ' + esc(m.note) : ''}</span></div>
    </div>`).join('');
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function openChat(peerId) {
  chats[peerId] ||= { name: short(peerId), messages: [] };
  current = peerId;
  renderThread();
  show('threadScreen');
}

async function send() {
  const text = $('#messageInput').value.trim();
  if (!text || !current) return;
  $('#messageInput').value = '';
  const msg = { from: node.peerId, content: text, timestamp: Date.now(), note: 'sending…' };
  chats[current].messages.push(msg);
  renderThread();
  try { msg.note = (await node.sendMessage(current, text)) === 'direct' ? '✓' : '✓ stored for offline'; }
  catch (e) { msg.note = '✗ ' + e.message; }
  renderThread(); renderChats(); saveChats();
}

function renderVideos() {
  $('#videoList').innerHTML = results.map((v, i) => `
    <li data-i="${i}"><b>${esc(v.title)}</b><br>
    <span class="hint">${(v.size / 1048576).toFixed(1)} MB · ${esc(v.uploaderName || short(v.uploader))}</span></li>`).join('') || '<li class="hint">No videos found</li>';
}

const progress = (p) => { $('#progress').textContent = p ? `${p.stage} ${p.percent}%` : ''; };

async function search() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  $('#progress').textContent = 'Searching the network…';
  results = await node.searchNetwork(q).catch(() => []);
  progress(null); renderVideos();
}

async function watch(v) {
  try {
    const url = await node.watch(v, progress);
    $('#videoEl').src = url; $('#playerTitle').textContent = v.title;
    $('#player').style.display = ''; $('#videoEl').play().catch(() => {});
    toast('Playing — you are now seeding this video while the app is open');
  } catch (e) { toast(e.message); }
  progress(null);
}

async function upload() {
  const f = $('#fileInput').files[0];
  if (!f) return toast('Pick a video first');
  try {
    const v = await node.uploadVideo(f, {
      title: $('#titleInput').value.trim() || f.name,
      tags: $('#tagsInput').value.split(',').map((t) => t.trim()).filter(Boolean)
    }, progress);
    toast(v.replicas.length ? `Uploaded · copied to ${v.replicas.length} PC(s)` : 'Saved on phone · no PC online to copy to yet');
  } catch (e) { toast(e.message); }
  progress(null);
}

(async () => {
  chats = (await idb.get('chats')) || {};
  node = await new MobileNode().start();
  $('#myId').textContent = node.peerId;
  renderPeers(); renderChats();

  node.addEventListener('peers', renderPeers);
  setInterval(renderPeers, 5000);
  $('#searchNowBtn').onclick = () => { node.searchNow(); renderPeers(); };
  node.addEventListener('message', (e) => {
    const m = e.detail;
    chats[m.from] ||= { name: short(m.from), messages: [] };
    chats[m.from].messages.push({ from: m.from, content: m.content, timestamp: m.timestamp });
    saveChats(); renderChats();
    if (current === m.from) renderThread(); else toast(`New message from ${chats[m.from].name}`);
  });

  // Mail held for us anywhere on the network (via DHT), once connected
  setTimeout(() => node.findMyMail().catch(() => {}), 8000);
  setInterval(() => node.findMyMail().catch(() => {}), 5 * 60 * 1000);

  $('#connectBtn').onclick = async () => {
    const a = $('#addrInput').value.trim();
    if (!a) return;
    try { await node.dial(a); toast('Connected'); renderPeers(); } catch (e) { toast('Could not connect: ' + e.message); }
  };
  $('#peerList').onclick = (e) => { const p = e.target.closest('li')?.dataset.peer; if (p) openChat(p); };
  $('#chatList').onclick = (e) => { const p = e.target.closest('li')?.dataset.peer; if (p) openChat(p); };
  $('#backBtn').onclick = () => { current = null; show('chatsScreen'); };
  $('#sendBtn').onclick = send;
  $('#messageInput').onkeydown = (e) => e.key === 'Enter' && send();
  $('#searchBtn').onclick = search;
  $('#searchInput').onkeydown = (e) => e.key === 'Enter' && search();
  $('#videoList').onclick = (e) => { const i = e.target.closest('li')?.dataset.i; if (i != null) watch(results[i]); };
  $('#uploadBtn').onclick = upload;
  $$('.nav-item').forEach((n) => (n.onclick = () => show(n.dataset.screen)));
})().catch((e) => { $('#peerCount').textContent = 'Error'; toast(e.message); console.error(e); });
