// node test/crypto-compat.mjs  — mobile WebCrypto <-> desktop crypto.js interop
import { createRequire } from 'module';
import { WebCrypto } from '../src/crypto-web.js';
const require = createRequire(import.meta.url);
const P2PCrypto = require('../../src/main/crypto.js');
const fs = require('fs'); const os = require('os'); const path = require('path');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'compat-'));
const desk = new P2PCrypto(dir); await desk.initializeIdentity();
const mob = new WebCrypto();
let fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

// sealed box both ways
ok('desktop -> mobile sealed box', (await mob.decryptFromSender(desk.encryptForRecipient('hi phone', mob.getBoxPublicKey()))) === 'hi phone');
ok('mobile -> desktop sealed box', desk.decryptFromSender(await mob.encryptForRecipient('hi pc', desk.getBoxPublicKey())) === 'hi pc');
// signatures both ways (desktop idKey = base64 DER SPKI)
ok('mobile signs, desktop verifies', desk.verify('msg', mob.sign('msg'), mob.getPublicKey()));
ok('desktop signs, mobile verifies', mob.verify('msg', desk.sign('msg'), desk.getPublicKey()));
ok('tampered rejected', !desk.verify('msg2', mob.sign('msg'), mob.getPublicKey()));
// key persistence
const again = new WebCrypto(mob.exportKeys());
ok('mobile keys persist', again.getBoxPublicKey() === mob.getBoxPublicKey() && again.getPublicKey() === mob.getPublicKey());
process.exit(fail ? 1 : 0);
