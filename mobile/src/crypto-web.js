// Browser/WebView crypto that is wire-compatible with src/main/crypto.js (desktop)
//  - Ed25519 identity: desktop sends/accepts public keys as base64 DER SPKI
//  - X25519 "box" key: raw 32 bytes, base64
//  - Sealed box: ephPub(32) | iv(12) | tag(16) | ciphertext, HKDF-SHA256(info 'p2p-chat-sealed-v1')
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const ED_SPKI_PREFIX = hex('302a300506032b6570032100');
const te = new TextEncoder();
const td = new TextDecoder();

export function hex(s) { return Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16))); }
export function toHex(u) { return [...u].map((b) => b.toString(16).padStart(2, '0')).join(''); }
export function b64(u) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export class WebCrypto {
  /** keys = { edPriv, boxPriv } as base64 (persisted by caller) or undefined → generate */
  constructor(keys) {
    this.edPriv = keys?.edPriv ? unb64(keys.edPriv) : ed25519.utils.randomPrivateKey();
    this.boxPriv = keys?.boxPriv ? unb64(keys.boxPriv) : x25519.utils.randomPrivateKey();
    this.edPub = ed25519.getPublicKey(this.edPriv);
    this.boxPub = x25519.getPublicKey(this.boxPriv);
  }

  exportKeys() { return { edPriv: b64(this.edPriv), boxPriv: b64(this.boxPriv) }; }
  getPublicKey() { return b64(concat(ED_SPKI_PREFIX, this.edPub)); }   // = desktop format
  getBoxPublicKey() { return b64(this.boxPub); }

  sign(text) { return b64(ed25519.sign(te.encode(text), this.edPriv)); }

  verify(text, sigB64, idKeyB64) {
    try {
      const der = unb64(idKeyB64);
      const pub = der.length === 44 ? der.subarray(12) : der;
      return ed25519.verify(unb64(sigB64), te.encode(text), pub);
    } catch { return false; }
  }

  async encryptForRecipient(plaintext, recipientBoxB64) {
    const recip = unb64(recipientBoxB64);
    if (recip.length !== 32) throw new Error('Invalid recipient box key');
    const ephPriv = x25519.utils.randomPrivateKey();
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, recip);
    const keyBytes = hkdf(sha256, shared, concat(ephPub, recip), 'p2p-chat-sealed-v1', 32);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext)));
    const ct = out.subarray(0, out.length - 16), tag = out.subarray(out.length - 16); // WebCrypto = ct||tag
    return b64(concat(ephPub, iv, tag, ct));
  }

  async decryptFromSender(sealedB64) {
    const d = unb64(sealedB64);
    if (d.length < 60) throw new Error('Ciphertext too short');
    const ephPub = d.subarray(0, 32), iv = d.subarray(32, 44), tag = d.subarray(44, 60), ct = d.subarray(60);
    const shared = x25519.getSharedSecret(this.boxPriv, ephPub);
    const keyBytes = hkdf(sha256, shared, concat(ephPub, this.boxPub), 'p2p-chat-sealed-v1', 32);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, concat(ct, tag));
    return td.decode(pt);
  }
}
