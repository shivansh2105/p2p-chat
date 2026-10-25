/**
 * Scenario: Alice and Bob have met (keys exchanged). Bob goes offline.
 * Alice sends a message → sealed and stored on Alice + Carol.
 * ALICE ALSO GOES OFFLINE. Bob comes back (same identity), connects only
 * to Carol, and receives the message from Carol's inbox.
 */
module.exports = async function offlineTest(a, b, makeNode, ok, waitFor, sleep) {
  const tcp = (n) => n.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));
  const c = makeNode('carol2');
  await c.start();
  await c.node.dial(tcp(a));
  await waitFor(() => a.connectedPeers.has(c.peerId), 10000, 'carol<->alice');

  await waitFor(() => a.inbox.peerBoxKeys.has(b.peerId), 10000, 'keys').catch(() => {});
  ok('alice learned bob inbox key', a.inbox.peerBoxKeys.has(b.peerId));

  const bobId = b.peerId;
  const bobDir = b.dataDir;
  await b.stop();
  await waitFor(() => !a.connectedPeers.has(bobId), 10000, 'bob disconnect');

  await a.sendMessage(bobId, { content: 'msg while you were away', type: 'text' });
  ok('carol holds sealed copy', c.messageStore.getMessageCount(bobId) === 1);
  const blob = c.messageStore.fetchMessages(bobId)[0]?.encrypted || '';
  ok('holder cannot see plaintext', !Buffer.from(blob, 'base64').toString('latin1').includes('while you were away'));

  await a.stop(); // sender offline too

  // Bob restarts with same data dir → same Peer ID
  const { P2PNode } = require('../src/main/p2p-node');
  const store = { m: new Map(), get(k, d) { return this.m.has(k) ? this.m.get(k) : d; }, set(k, v) { this.m.set(k, v); }, delete(k) { this.m.delete(k); } };
  store.set('user', { username: 'bob' });
  store.set('bootstrap', false);
  const db = { msgs: [], async addMessage() {}, getMessagesSince() { return []; }, updateContactUsername() {} };
  const b2 = new P2PNode(db, store, bobDir);
  await b2.start();
  ok('bob keeps same Peer ID after restart', b2.peerId === bobId);

  const got = new Promise((res) => b2.on('message', (m) => m.content === 'msg while you were away' && res(m)));
  await b2.node.dial(tcp(c));
  const m = await Promise.race([got, sleep(15000).then(() => null)]);
  ok('bob receives message from carol while alice offline', !!m);
  await waitFor(() => c.messageStore.getMessageCount(bobId) === 0, 5000, 'ack').catch(() => {});
  ok('holder deletes after ACK', c.messageStore.getMessageCount(bobId) === 0);

  await Promise.allSettled([c.stop(), b2.stop()]);
};
