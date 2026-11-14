/**
 * Lockheed Martin LMS6-1680 (and the Sippican Mk2a it grew from): 9616 baud NRZ FSK at 1680 MHz, 8N1 bytes sent least
 * significant bit first, no forward error correction. Between subframes the sonde sends CA bytes; a subframe is
 * CA CA CA 24 52 <type> ... <CRC16-XMODEM, big-endian>, variable length (the CRC finds the end). Type 0x54 carries
 * GPS (time of week, position, velocity), type 0x4D the full 32-bit serial; every subframe is sent twice. Only the
 * low 16 bits of the serial ride in every subframe, so nothing is reported until a 0x4D has given the rest.
 * The TypeScript twin of core/sonde/Mk2a.kt and Mk2a.swift.
 */
import { crc16ccitt } from './rs.js';
import type { SondeFrame, SondeSink } from './types.js';

export const MK2A_BAUD = 9616;
/** CA CA CA 24 52 as 8N1 symbols (start 0, data LSB first, stop 1). */
export const MK2A_HEADER = '0010100111' + '0010100111' + '0010100111' + '0001001001' + '0010010101';
export const MK2A_MAX = 176;

/** 0xB60B60 (integer): LMS6-1680 latitude and longitude units, as the reference decoder uses them. */
const DEG = 0xb60b60;
const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const be32 = (b: Uint8Array, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const be24s = (b: Uint8Array, p: number) => { let v = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]; if (v > 0x7fffff) v -= 0x1000000; return v; };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The shortest data length (CRC excluded) a subframe of this type can have, so a chance CRC match comes later. */
/** Candidate bits the CRC repair tries (any one or two of them flipped). */
const REPAIR_BITS = 16;
/** The data length (CRC excluded) of the subframe types seen on air: 0x54 = 172, 0x4D = 66; 0 = unknown. */
export function mk2aKnownLen(type: number): number { return type === 0x54 ? 172 : type === 0x4d ? 66 : 0; }
export function mk2aMinLen(type: number): number { return type === 0x54 ? 41 : type === 0x4d ? 56 : 8; }

function crcStep(c: number, byte: number): number {
  c ^= byte << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  return c;
}

/**
 * The data length (CRC excluded) of the subframe in b[0 .. n-1]: the first length whose CRC matches the two bytes
 * after it. -1 when none does.
 */
export function mk2aLength(b: Uint8Array, n: number): number {
  const min = n > 2 ? mk2aMinLen(b[2]) : 8;
  let c = 0;
  for (let len = 0; len + 2 <= n; len++) {
    if (len >= min && c === be16(b, len)) return len;
    c = crcStep(c, b[len]);
  }
  return -1;
}

export class Mk2aDecoder {
  /** Short serial (low 16 bits) to the full serial, from the 0x4D subframes. */
  private readonly ids = new Map<number, number>();
  private readonly lastFrame = new Map<number, number>();

  /** One subframe, `len` data bytes (b[len], b[len+1] = its CRC). Null for config subframes and repeats. */
  parse(b: Uint8Array, len: number): SondeFrame | null {
    if (len < 6 || b[0] !== 0x24 || b[1] !== 0x52) return null;
    if (crc16ccitt(b, 0, len, 0) !== be16(b, len)) return null;
    const type = b[2], short = be16(b, 4);
    if (type === 0x4d) {
      if (len > 54 && b[50] === b[4] && b[51] === b[5]) {
        const id = ((b[52] << 24) | (b[53] << 16) | (b[50] << 8) | b[51]) >>> 0;
        if (id & 0xffff0000) {
          this.ids.set(short, id);
          if (this.ids.size > 64) this.ids.delete(this.ids.keys().next().value!);
        }
      }
      return null;
    }
    if (type !== 0x54 || len < 39) return null;
    const id = this.ids.get(short);
    if (id === undefined) return null;
    const frame = be16(b, 6);
    if (this.lastFrame.get(short) === frame) return null;
    this.lastFrame.set(short, frame);
    if (this.lastFrame.size > 64) this.lastFrame.delete(this.lastFrame.keys().next().value!);
    const out: SondeFrame = { type: 'LMS6', model: 'LMS6-1680', serial: `LMS6-${id}`, frame, fixed: 0 };
    const tow = (be32(b, 10) >>> 0) / 1000;
    if (tow < 7 * 86400) { out.timeS = tow % 86400; out.extra = { 'GPS WEEKDAY': WEEKDAYS[Math.floor(tow / 86400)] }; }
    const lat = be32(b, 18) / DEG, lon = be32(b, 22) / DEG, alt = be32(b, 26) / 1000;
    if (alt >= -100 && alt <= 60000 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.lat = lat; out.lon = lon; out.alt = alt;
      const vE = be24s(b, 30) / 1e3, vN = be24s(b, 33) / 1e3, vU = be24s(b, 36) / 1e3;
      out.vH = Math.hypot(vE, vN);
      let h = Math.atan2(vE, vN) * 180 / Math.PI; if (h < 0) h += 360;
      out.heading = h; out.climb = vU;
    }
    return out;
  }
}

function pop32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * Subframes out of channel symbols (from the bank's symbol clock): a 50-symbol header search in both FM polarities,
 * then 8N1 bytes until the CRC closes the subframe (or 176 bytes, or four CA bytes in a row).
 */
export class Mk2aCollector {
  /** The last 50 hard symbols: lo = the newest 32, hi = the 18 before. */
  private hi = 0; private lo = 0; private shN = 0;
  private readonly hHi: number; private readonly hLo: number;
  collecting = false;
  private inv = false;
  private readonly bytes = new Uint8Array(MK2A_MAX + 2);
  /** crcs[k] = the CRC of bytes 0 .. k-1 of the subframe being collected. */
  private readonly crcs = new Uint16Array(MK2A_MAX + 3);
  private len = 0; private bitN = 0; private cur = 0;
  /** |soft| of every data bit collected (byte * 8 + bit). */
  private readonly rel = new Float32Array((MK2A_MAX + 2) * 8);
  private readonly cand = new Int32Array(REPAIR_BITS);
  private readonly syn = new Uint16Array(REPAIR_BITS);
  private readonly dec = new Mk2aDecoder();
  constructor(private readonly sink: SondeSink, private readonly maxErr = 2) {
    let hi = 0, lo = 0;
    for (let i = 0; i < MK2A_HEADER.length; i++) {
      const b = MK2A_HEADER.charCodeAt(i) === 49 ? 1 : 0;
      hi = ((hi << 1) | (lo >>> 31)) & 0x3ffff; lo = ((lo << 1) | b) >>> 0;
    }
    this.hHi = hi; this.hLo = lo;
  }
  /** One channel symbol (soft: positive = 1). */
  symbol(s: number): void {
    const bit = s > 0 ? 1 : 0;
    if (this.collecting) { this.collect(this.inv ? 1 - bit : bit, Math.abs(s)); return; }
    this.hi = ((this.hi << 1) | (this.lo >>> 31)) & 0x3ffff;
    this.lo = ((this.lo << 1) | bit) >>> 0;
    if (++this.shN < MK2A_HEADER.length) return;
    const e = pop32((this.hi ^ this.hHi) >>> 0) + pop32((this.lo ^ this.hLo) >>> 0);
    const ei = MK2A_HEADER.length - e;
    if (e <= this.maxErr || ei <= this.maxErr) {
      this.inv = ei < e;
      this.collecting = true; this.shN = 0;
      this.bytes[0] = 0x24; this.bytes[1] = 0x52; this.len = 2;
      this.crcs[0] = 0; this.crcs[1] = crcStep(0, 0x24); this.crcs[2] = crcStep(this.crcs[1], 0x52);
      this.bitN = 0; this.cur = 0;
    }
  }
  private collect(bit: number, mag: number): void {
    // symbol 0 = start bit, 1..8 = data LSB first, 9 = stop bit
    if (this.bitN >= 1 && this.bitN <= 8) { this.cur |= bit << (this.bitN - 1); this.rel[this.len * 8 + this.bitN - 1] = mag; }
    if (++this.bitN < 10) return;
    const b = this.cur; this.bitN = 0; this.cur = 0;
    const n = this.len, by = this.bytes, crcs = this.crcs;
    by[n] = b; this.len = n + 1;
    crcs[n + 1] = crcStep(crcs[n], b);
    // bytes n-1, n as the CRC of bytes 0 .. n-2
    const dataLen = n - 1;
    if (dataLen >= mk2aMinLen(by[2]) && crcs[dataLen] === ((by[n - 1] << 8) | b)) {
      this.collecting = false;
      const f = this.dec.parse(by, dataLen);
      if (f) this.sink(f);
      return;
    }
    // a subframe of a known length that missed its CRC: try flipping its least reliable bits
    const known = mk2aKnownLen(by[2]);
    if (known > 0 && this.len === known + 2) {
      this.collecting = false;
      const fixed = this.repair(known);
      if (fixed > 0) { const f = this.dec.parse(by, known); if (f) { f.fixed = fixed; this.sink(f); } }
      return;
    }
    if (this.len >= MK2A_MAX || (n >= 5 && b === 0xca && by[n - 1] === 0xca && by[n - 2] === 0xca && by[n - 3] === 0xca)) {
      this.collecting = false;
    }
  }

  /**
   * Chase repair of bytes[0 .. len+1] (data and CRC): the REPAIR_BITS least reliable bits (the 24 52 sync excluded),
   * any one or two of them flipped, accepted when the CRC then matches. The CRC is linear, so each flip's effect on
   * the check is worked out once. Returns the bits flipped, or 0 when no pattern fits.
   */
  private repair(len: number): number {
    const by = this.bytes, rel = this.rel, cand = this.cand, syn = this.syn, K = REPAIR_BITS;
    let m = 0;
    for (let i = 16; i < (len + 2) * 8; i++) {
      // keep the K smallest, an insertion into a short sorted list
      if (m < K) { cand[m++] = i; } else if (rel[i] < rel[cand[K - 1]]) cand[K - 1] = i; else continue;
      for (let j = m - 1; j > 0 && rel[cand[j]] < rel[cand[j - 1]]; j--) { const t = cand[j]; cand[j] = cand[j - 1]; cand[j - 1] = t; }
    }
    // the residual: the CRC of the data against the stored CRC
    let c = 0;
    for (let i = 0; i < len; i++) c = crcStep(c, by[i]);
    const r = c ^ ((by[len] << 8) | by[len + 1]);
    for (let k = 0; k < m; k++) {
      const byte = cand[k] >> 3, bitv = 1 << (cand[k] & 7);
      if (byte >= len) {
        // a bit of the stored CRC (high byte first)
        syn[k] = byte === len ? bitv << 8 : bitv;
      } else {
        let e = crcStep(0, bitv);
        for (let i = byte + 1; i < len; i++) e = crcStep(e, 0);
        syn[k] = e;
      }
    }
    for (let a = 0; a < m; a++) {
      if (syn[a] === r) { this.flip(cand[a]); return 1; }
      for (let b = a + 1; b < m; b++) if ((syn[a] ^ syn[b]) === r) { this.flip(cand[a]); this.flip(cand[b]); return 2; }
    }
    return 0;
  }
  private flip(bit: number): void { this.bytes[bit >> 3] ^= 1 << (bit & 7); }
}
