/**
 * LoRa transmit side: a modulator that is the exact inverse of phy.ts, and packet builders for Meshtastic text and
 * node info and MeshCore public channel text, the inverse of meshtastic.ts and meshcore.ts.
 *
 * Every builder sends as the node the caller names (the user's own node). Nothing here builds packets for other
 * nodes, positions, alerts or emergency messages.
 */
import { Aes128 } from './aes128.js';
import { Sha256 } from './sha256.js';
import { LoraCodec } from './phy.js';
import { channelHash, defaultKey } from './meshtastic.js';
import { publicKey as mcPublicKey } from './meshcore.js';

/** Sync words: Meshtastic's, MeshCore's (RadioLib's private one). */
export const MESHTASTIC_SYNC = 0x2b;
export const MESHCORE_SYNC = 0x12;

export interface LoraTxOpts {
  sf: number;
  bw: number;
  /** Coding rate 1..4 (4/5 to 4/8). */
  cr: number;
  syncWord: number;
  /** Preamble up-chirps (16 by default, what Meshtastic sends). */
  preamble?: number;
  explicitHeader: true;
  crc: true;
  /** Low data rate optimization; by default on when a symbol lasts 16 ms or more, as phy.ts assumes. */
  ldro?: boolean;
}

/** The inverse of Gray coding: g = v ^ (v >> 1) gives back v. */
function unGray(g: number): number {
  let v = g;
  for (let s = g >> 1; s > 0; s >>= 1) v ^= s;
  return v;
}

/** Hamming codeword bits for one nibble, in the order phy.ts reads them: data bits 0..3, then parity. */
function codeword(nib: number, cwLen: number): number[] {
  const b0 = nib & 1, b1 = (nib >> 1) & 1, b2 = (nib >> 2) & 1, b3 = (nib >> 3) & 1;
  if (cwLen === 5) return [b0, b1, b2, b3, b0 ^ b1 ^ b2 ^ b3];
  const p = [b0 ^ b1 ^ b2, b1 ^ b2 ^ b3, b0 ^ b1 ^ b3, b0 ^ b2 ^ b3];
  return [b0, b1, b2, b3, ...p.slice(0, cwLen - 4)];
}

/** sfApp nibbles into cwLen Gray-coded symbol values of sfApp bits: the inverse of LoraCodec.block. */
function interleave(nibs: number[], sfApp: number, cwLen: number): number[] {
  const cw = nibs.map(n => codeword(n, cwLen));
  const out: number[] = [];
  for (let i = 0; i < cwLen; i++) {
    let g = 0;
    for (let j = 0; j < sfApp; j++) {
      const r = (((i - j - 1) % sfApp) + sfApp) % sfApp;
      g |= cw[r][i] << (sfApp - 1 - j);
    }
    out.push(g);
  }
  return out;
}

/**
 * The chirp shifts of a frame's data symbols (header block first), each the cyclic shift of an up-chirp. Exposed for
 * tests; loraModulate adds the preamble, sync word and start-of-frame.
 */
export function loraSymbols(payload: Uint8Array, opts: LoraTxOpts): number[] {
  const { sf, cr } = opts;
  if (sf < 7 || sf > 12) throw new RangeError('spreading factor must be 7 to 12');
  if (cr < 1 || cr > 4) throw new RangeError('coding rate must be 1 to 4');
  if (payload.length < 1 || payload.length > 255) throw new RangeError('payload must be 1 to 255 bytes');
  const n = 1 << sf;
  const ldro = opts.ldro ?? (n / opts.bw >= 0.016);
  const len = payload.length;
  // whitened payload, then the CRC as phy.ts checks it (sent as is, low byte first)
  const by: number[] = [];
  for (let i = 0; i < len; i++) by.push(payload[i] ^ LoraCodec.whitening[i % 256]);
  let c = LoraCodec.crc16(payload, 0, Math.max(0, len - 2));
  if (len >= 2) c ^= payload[len - 1] ^ (payload[len - 2] << 8);
  by.push(c & 0xff, (c >> 8) & 0xff);
  const nibs: number[] = [];
  for (const b of by) nibs.push(b & 0x0f, b >> 4);
  // header: length, coding rate and CRC flag, checksum
  const h = [len >> 4, len & 0x0f, (cr << 1) | 1];
  const chk = LoraCodec.headerChecksum(h);
  h.push((chk >> 4) & 1, chk & 0x0f);
  const syms: number[] = [];
  // the first block: always 4/8, sf-2 bits a symbol, the header and the first payload nibbles
  const first = h.concat(nibs.splice(0, sf - 2 - 5));
  while (first.length < sf - 2) first.push(0);
  for (const g of interleave(first, sf - 2, 8)) syms.push(4 * unGray(g) + 1);
  const sfApp = ldro ? sf - 2 : sf, cwLen = 4 + cr;
  while (nibs.length > 0) {
    const blk = nibs.splice(0, sfApp);
    while (blk.length < sfApp) blk.push(0);
    for (const g of interleave(blk, sfApp, cwLen)) syms.push(((ldro ? 4 * unGray(g) : unGray(g)) + 1) % n);
  }
  return syms;
}

/**
 * One LoRa frame as complex baseband at `rate` samples a second, centered on the channel: interleaved I/Q at unit
 * amplitude, continuous phase. Preamble, the two sync-word symbols, two and a quarter down-chirps, then the symbols.
 */
export function loraModulate(payload: Uint8Array, opts: LoraTxOpts, rate: number): Float32Array {
  const { sf, bw } = opts;
  const n = 1 << sf;
  if (!(rate >= bw)) throw new RangeError('sample rate must be at least the bandwidth');
  const data = loraSymbols(payload, opts);
  // segments: [up (true) or down, shift, length in chips]
  const seg: [boolean, number, number][] = [];
  for (let i = 0; i < (opts.preamble ?? 16); i++) seg.push([true, 0, n]);
  seg.push([true, ((opts.syncWord >> 4) & 0x0f) << 3, n], [true, (opts.syncWord & 0x0f) << 3, n]);
  seg.push([false, 0, n], [false, 0, n], [false, 0, n / 4]);
  for (const s of data) seg.push([true, s, n]);
  const chips = seg.reduce((a, s) => a + s[2], 0);
  const total = Math.round(chips * rate / bw);
  const out = new Float32Array(2 * total);
  const step = bw / rate;          // chips a sample
  let ph = 0, si = 0, segStart = 0;
  for (let k = 0; k < total; k++) {
    const u = (k + 0.5) * step;    // the middle of the sample, in chips from the frame start
    while (si < seg.length - 1 && u >= segStart + seg[si][2]) { segStart += seg[si][2]; si++; }
    const [up, shift] = seg[si];
    const x = u - segStart;
    // frequency in units of the bandwidth, from -1/2 to 1/2
    const f = up ? (((x + shift) % n) / n) - 0.5 : 0.5 - ((x % n) / n);
    out[2 * k] = Math.cos(ph); out[2 * k + 1] = Math.sin(ph);
    ph += 2 * Math.PI * f * step;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
  }
  return out;
}

// ---- Meshtastic ----

const enc = new TextEncoder();

function varint(v: number, out: number[]): void {
  let x = v >>> 0;
  while (x >= 0x80) { out.push((x & 0x7f) | 0x80); x >>>= 7; }
  out.push(x);
}
function pbVarint(field: number, v: number, out: number[]): void { varint(field << 3, out); varint(v, out); }
function pbBytes(field: number, b: ArrayLike<number>, out: number[]): void {
  varint((field << 3) | 2, out); varint(b.length, out);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

function randomId(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  const a = new Uint32Array(1);
  if (c?.getRandomValues) c.getRandomValues(a); else a[0] = Math.floor(Math.random() * 0x1_0000_0000);
  return a[0] || 1;
}

const u32le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

interface MtBase { from: number; channelName: string; hopLimit?: number; licensed?: boolean; id?: number }

/** A broadcast Meshtastic packet: the 16-byte header, then the Data message, encrypted with the default key unless
 *  licensed (ham mode sends it in the clear, on the channel hash of the name alone). */
function meshtasticPacket(o: MtBase, port: number, inner: Uint8Array): Uint8Array {
  const from = o.from >>> 0;
  if (from === 0 || from === 0xffffffff) throw new RangeError('not a node id');
  const id = (o.id ?? randomId()) >>> 0;
  const hop = Math.max(0, Math.min(7, Math.trunc(o.hopLimit ?? 3)));
  const data: number[] = [];
  pbVarint(1, port, data);
  pbBytes(2, inner, data);
  const key = o.licensed ? new Uint8Array(0) : defaultKey;
  const hdr = [...u32le(0xffffffff), ...u32le(from), ...u32le(id), (hop << 5) | hop, channelHash(o.channelName, key), 0, from & 0xff];
  let body = Uint8Array.from(data);
  if (!o.licensed) {
    const nonce = new Uint8Array(16);
    for (let k = 0; k < 4; k++) { nonce[k] = hdr[8 + k]; nonce[8 + k] = hdr[4 + k]; }
    body = Aes128.ctr(defaultKey, nonce, body);
  }
  if (16 + body.length > 255) throw new RangeError('message too long for one packet');
  const out = new Uint8Array(16 + body.length);
  out.set(hdr); out.set(body, 16);
  return out;
}

/** A text message to everyone on the channel, from the caller's own node. */
export function meshtasticText(opts: { from: number; text: string; channelName: string; hopLimit?: number; licensed?: boolean; id?: number }): Uint8Array {
  const t = enc.encode(opts.text);
  if (t.length === 0) throw new RangeError('empty message');
  if (t.length > 200) throw new RangeError('message too long (200 bytes at most)');
  return meshtasticPacket(opts, 1, t);
}

/** The caller's own node info (its User message): id, long name, short name, and the licensed flag. */
export function meshtasticNodeInfo(opts: { from: number; longName: string; shortName: string; channelName: string; licensed?: boolean; hopLimit?: number; id?: number }): Uint8Array {
  const u: number[] = [];
  pbBytes(1, enc.encode(`!${(opts.from >>> 0).toString(16).padStart(8, '0')}`), u);
  pbBytes(2, enc.encode(opts.longName), u);
  pbBytes(3, enc.encode(opts.shortName), u);
  if (opts.licensed) pbVarint(6, 1, u);
  return meshtasticPacket(opts, 4, Uint8Array.from(u));
}

// ---- MeshCore ----

/** A message on MeshCore's public channel: flood route, no hops yet, group text encrypted with the public key
 *  (AES-128 ECB, zero padded) behind its 2-byte HMAC-SHA256, the text sent as "name: text". */
export function meshcorePublicText(opts: { senderName: string; text: string; timestamp?: number }): Uint8Array {
  const ts = (opts.timestamp ?? Math.floor(Date.now() / 1000)) >>> 0;
  const msg = enc.encode(`${opts.senderName}: ${opts.text}`);
  if (opts.text.length === 0) throw new RangeError('empty message');
  const plain: number[] = [...u32le(ts), 0, ...msg];
  while (plain.length % 16 !== 0) plain.push(0);
  if (plain.length > 176) throw new RangeError('message too long for one packet');
  const rk = Aes128.expand(mcPublicKey);
  const ct = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i += 16) ct.set(Aes128.encrypt(plain.slice(i, i + 16), rk), i);
  const mk = new Uint8Array(32); mk.set(mcPublicKey);
  const mac = Sha256.hmac(mk, ct);
  const out = new Uint8Array(5 + ct.length);
  out.set([0x15, 0x00, Sha256.hash(mcPublicKey)[0], mac[0], mac[1]]);   // flood, group text, version 0; no path
  out.set(ct, 5);
  return out;
}
