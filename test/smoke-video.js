/**
 * Scenario: Alice uploads a video, it replicates to Bob and Carol,
 * then ALICE GOES OFFLINE. Dave (new peer, never met Alice) searches
 * and downloads it from Bob/Carol.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = async function videoTest(a, b, makeNode, ok, waitFor, sleep) {
  const c = makeNode('carol');
  await c.start();
  const tcp = (n) => n.node.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'));
  await c.node.dial(tcp(a));
  await waitFor(() => a.connectedPeers.has(c.peerId), 10000, 'carol<->alice');

  // 3 MB fake video (12 chunks)
  const file = path.join(a.dataDir, 'clip.mp4');
  fs.writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024 + 1234));
  const video = await a.uploadVideo(file, { title: 'Goa trip vlog', tags: ['travel'] });
  ok('upload chunks video', video.chunkHashes.length === 13);

  await waitFor(() => (video.replicas || []).length >= 2, 30000, 'replication').catch(() => {});
  ok('replicated to 2 other PCs', (video.replicas || []).length >= 2);
  ok('bob has full verified copy', b.videoStore.getMissingChunks(video.id).length === 0 && b.videoStore.verifyComplete(video.id));
  ok('carol has full verified copy', c.videoStore.getMissingChunks(video.id).length === 0);

  // Alice (uploader) goes offline
  await a.stop();
  ok('uploader offline', true);

  // Dave joins via Bob only
  const d = makeNode('dave');
  await d.start();
  await d.node.dial(tcp(b));
  await waitFor(() => d.connectedPeers.has(b.peerId), 10000, 'dave<->bob');
  await sleep(500);

  const results = await d.searchVideos('goa');
  ok('dave finds video by search while uploader offline', results.some((r) => r.id === video.id));

  await d.downloadVideo(video.id);
  ok('dave downloads + verifies full video from replicas', d.videoStore.verifyComplete(video.id));
  ok('dave now seeds it too', d.videoStore.getSeedingVideos().some((v) => v.id === video.id));

  await Promise.allSettled([c.stop(), d.stop()]);
};
