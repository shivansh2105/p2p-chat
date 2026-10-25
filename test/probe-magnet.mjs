// node test/probe-magnet.mjs "<magnet>" — standard client with DHT + trackers + LSD,
// NO manually added peers: does it find a seeder and download?
if (typeof Promise.withResolvers !== 'function') Promise.withResolvers = function () { let a, b; const p = new this((r, j) => { a = r; b = j; }); return { promise: p, resolve: a, reject: b }; };
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const { default: WebTorrent } = await import('webtorrent');
const magnet = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnet-'));
const client = new WebTorrent({ utp: false });
const t0 = Date.now();
const t = client.add(magnet, { path: dir });
t.on('wire', (w) => console.log(`found peer ${w.remoteAddress}:${w.remotePort} after ${((Date.now() - t0) / 1000).toFixed(1)}s`));
const done = await Promise.race([new Promise((r) => t.once('done', () => r(true))), new Promise((r) => setTimeout(() => r(false), 120000))]);
console.log(done ? `downloaded ${t.files[0]?.name} (${(t.length / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s` : `not finished: peers=${t.numPeers} progress=${(t.progress * 100).toFixed(0)}%`);
client.destroy(() => process.exit(0));
