/**
 * Lockheed Martin LMS6-403 and LMSX (403 MHz): 4800 baud NRZ FSK (LMSX 4797.8), a rate-1/2 K=7 convolutional code
 * sent as (c0, NOT c1), info bits packed least significant bit first, CCSDS RS(255,223) blocks behind the sync
 * 00 58 F3 3F B8. Fields are big-endian.
 *
 * LMS6-403 sends a 260-byte block per header (5 sync + 255 RS). The 223-byte RS messages, laid end to end, carry a
 * stream of 223-byte data frames (sync 24 54 00 00, CRC16-XMODEM at the end) with fill between them, one frame per
 * second, so a frame usually straddles two blocks. LMSX sends one 300-byte unit per second: the sync, the codeword
 * whose message is the frame itself (sync 24 46 05 00) and 40 fill bytes.
 * The TypeScript twin of core/sonde/Lms6.kt and Lms6.swift.
 */
import { ReedSolomon, crc16ccitt } from './rs.js';
import type { SondeFrame } from './types.js';
import { Viterbi, convState } from './viterbi.js';

export const LMS6_BAUD = 4800;
export const LMSX_BAUD = 4797.8;
/** The on-air symbols of 58 F3 3F B8 (each code pair as c0, NOT c1): the header both types search for. */
export const LMS6_HEADER = '0101011000001000' + '0001110010010111' + '0001101010100111' + '0011110100111110';
/** The block sync bytes. The leading 0x00 flushes the encoder, so the header above never depends on earlier data. */
export const LMS6_SYNC = [0x00, 0x58, 0xf3, 0x3f, 0xb8];
/** Code symbols of the sync, the block and the LMSX unit. */
const SYNC_SYMS = 80;
export const LMS6_BLOCK = 260, LMSX_UNIT = 300;
/** Channel symbols the framer hands over after the header: the rest of one block (or unit). */
export const LMS6_SYMS = LMS6_BLOCK * 16 - SYNC_SYMS;
export const LMSX_SYMS = LMSX_UNIT * 16 - SYNC_SYMS;
/** The LMSX frame sync. */
const LMSX_SYNC = [0x24, 0x46, 0x05, 0x00];
/** The frame (and RS message) length. */
export const LMS_FRAME = 223;

/** CCSDS RS(255,223) in the plain polynomial basis: field 0x187, roots alpha^(11*(112+i)). */
export const RS_CCSDS = /*#__PURE__*/ new ReedSolomon(0x187, 112, 11, 32);

/** Encoder state after the sync (both types). */
export const LMS6_SYNC_STATE = /*#__PURE__*/ (() => {
  const bits: number[] = [];
  for (const b of LMS6_SYNC) for (let k = 0; k < 8; k++) bits.push((b >> k) & 1);
  return convState(bits, 0);
})();

/** 2^32 / 360: LMS6 latitude and longitude units. */
const B60B60 = (1 << 30) / 90.0;

const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const be32 = (b: Uint8Array, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const be24s = (b: Uint8Array, p: number) => { let v = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]; if (v > 0x7fffff) v -= 0x1000000; return v; };
const be16s = (b: Uint8Array, p: number) => (be16(b, p) << 16) >> 16;
const dv = new DataView(new ArrayBuffer(8));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The frame's CRC16-XMODEM over bytes 0..220, stored big-endian at 221..222. */
export function lmsCrcOk(fr: Uint8Array, p = 0): boolean {
  return crc16ccitt(fr, p, LMS_FRAME - 2, 0) === be16(fr, p + LMS_FRAME - 2);
}

/** Correct one RS codeword whose first transmitted byte (the highest power) is at `bytes[p]`. -1 = beyond repair. */
export function lmsRsFix(bytes: Uint8Array, p: number, cw: Uint8Array): number {
  for (let j = 0; j < 255; j++) cw[254 - j] = bytes[p + j];
  const n = RS_CCSDS.decode(cw);
  if (n < 0) return -1;
  for (let j = 0; j < 255; j++) bytes[p + j] = cw[254 - j];
  return n;
}

/** One checked 223-byte frame (LMS6-403 when `x` is false, LMSX when true). Null when the CRC fails. */
export function lmsParse(fr: Uint8Array, x: boolean, p = 0): SondeFrame | null {
  if (!lmsCrcOk(fr, p)) return null;
  if (x) { if (fr[p] !== 0x24 || fr[p + 1] !== 0x46 || fr[p + 2] !== 0x05 || fr[p + 3] !== 0x00) return null; }
  else if (fr[p] !== 0x24 || fr[p + 1] !== 0x54 || fr[p + 2] !== 0x00 || (fr[p + 3] !== 0x00 && fr[p + 3] !== 0x05)) return null;
  if (fr[p + 5] === 0) return null;
  const sn = (fr[p + 5] << 16) | (fr[p + 6] << 8) | fr[p + 7];
  const out: SondeFrame = {
    type: 'LMS6', model: x ? 'LMSX' : fr[p + 3] === 0x05 ? 'LMS6-403-2' : 'LMS6-403',
    serial: `${x ? 'LMSX' : 'LMS6'}-${sn}`, frame: be16(fr, p + 8),
  };
  let towS: number;
  if (x) {
    // an IEEE-754 double in seconds: two big-endian words, the low word first
    for (let k = 0; k < 4; k++) { dv.setUint8(k, fr[p + 14 + k]); dv.setUint8(4 + k, fr[p + 10 + k]); }
    towS = dv.getFloat64(0, false);
  } else towS = be32(fr, p + 10) / 1000;
  if (Number.isFinite(towS) && towS >= 0 && towS < 7 * 86400) {
    out.timeS = towS % 86400;
    out.extra = { 'GPS WEEKDAY': WEEKDAYS[Math.floor(towS / 86400)] };
  }
  let lat: number, lon: number, alt: number;
  if (x) { lat = be32(fr, p + 18) / 1e7; lon = be32(fr, p + 22) / 1e7; alt = be32(fr, p + 26) / 100; }
  else { lat = be32(fr, p + 18) / B60B60; lon = be32(fr, p + 22) / B60B60; alt = be32(fr, p + 26) / 1000; }
  if (alt >= -200 && alt <= 60000 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.lat = lat; out.lon = lon; out.alt = alt;
    if (x) {
      out.vH = be16s(fr, p + 30) / 100;
      out.heading = be16(fr, p + 32) / 100;
      out.climb = be16s(fr, p + 34) / 100;
    } else {
      const vE = be24s(fr, p + 30) / 1e3, vN = be24s(fr, p + 33) / 1e3, vU = be24s(fr, p + 36) / 1e3;
      out.vH = Math.hypot(vE, vN);
      let h = Math.atan2(vE, vN) * 180 / Math.PI; if (h < 0) h += 360;
      out.heading = h; out.climb = vU;
    }
  }
  return out;
}

/** Soft symbols after the header to info bytes: undo the inverted c1, Viterbi, pack LSB first. */
class LmsInner {
  private readonly vit: Viterbi;
  private readonly pairs: Float32Array;
  private readonly bits: Uint8Array;
  /** The whole block, sync included, as bytes. */
  readonly block: Uint8Array;
  lastVitFixed = 0;
  constructor(readonly blockBytes: number) {
    const nBits = (blockBytes - LMS6_SYNC.length) * 8;
    this.vit = new Viterbi(nBits);
    this.pairs = new Float32Array(2 * nBits);
    this.bits = new Uint8Array(nBits);
    this.block = new Uint8Array(blockBytes);
  }
  /** Fill `block` from soft symbols (polarity already matched to the header). */
  run(soft: Float32Array): void {
    const nBits = this.bits.length, n = Math.min(soft.length >> 1, nBits);
    for (let k = 0; k < n; k++) { this.pairs[2 * k] = soft[2 * k]; this.pairs[2 * k + 1] = -soft[2 * k + 1]; }
    for (let k = 2 * n; k < 2 * nBits; k++) this.pairs[k] = 0;
    this.lastVitFixed = this.vit.decode(this.pairs, 0, nBits, LMS6_SYNC_STATE, this.bits);
    for (let i = 0; i < LMS6_SYNC.length; i++) this.block[i] = LMS6_SYNC[i];
    for (let i = 0; i < this.blockBytes - LMS6_SYNC.length; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v |= this.bits[8 * i + k] << k;
      this.block[LMS6_SYNC.length + i] = v;
    }
  }
}

/**
 * LMS6-403: block by block, the RS messages joined into a byte stream, frames found in it by their sync and CRC.
 * `contiguous` says whether this block followed the previous one without a gap (else the stream starts over).
 */
export class Lms6Decoder {
  private readonly inner = new LmsInner(LMS6_BLOCK);
  private readonly cw = new Uint8Array(255);
  private readonly stream = new Uint8Array(3 * LMS_FRAME);
  private len = 0;
  private fixedRun = 0;
  /** Decode one block's soft symbols (after the header). Returns the frames it completed. */
  decode(soft: Float32Array, contiguous: boolean): SondeFrame[] {
    this.inner.run(soft);
    return this.blockBytes(this.inner.block, contiguous);
  }
  /** One 260-byte block, sync included (tests feed these directly). */
  blockBytes(block: Uint8Array, contiguous: boolean): SondeFrame[] {
    const out: SondeFrame[] = [];
    const fixed = lmsRsFix(block, LMS6_SYNC.length, this.cw);
    if (fixed < 0) { this.len = 0; return out; }
    if (!contiguous) this.len = 0;
    if (this.len + LMS_FRAME > this.stream.length) this.len = 0;
    for (let i = 0; i < LMS_FRAME; i++) this.stream[this.len + i] = block[LMS6_SYNC.length + i];
    this.len += LMS_FRAME;
    const fixedHere = fixed;
    let p = 0, keep = -1;
    while (p + 4 <= this.len) {
      const s = this.stream;
      if (s[p] === 0x24 && s[p + 1] === 0x54 && s[p + 2] === 0x00 && (s[p + 3] === 0x00 || s[p + 3] === 0x05)) {
        if (p + LMS_FRAME > this.len) { keep = p; break; }
        const f = lmsParse(s, false, p);
        if (f) {
          f.fixed = this.fixedRun + fixedHere;
          if (this.inner.lastVitFixed) f.extra = { ...f.extra, 'VITERBI FIXED': `${this.inner.lastVitFixed} symbols` };
          out.push(f);
          p += LMS_FRAME;
          continue;
        }
      }
      p++;
    }
    // keep a frame in progress, or the last 3 bytes (a sync split across blocks)
    const from = keep >= 0 ? keep : Math.max(p, this.len - 3);
    this.stream.copyWithin(0, from, this.len);
    this.len -= from;
    this.fixedRun = keep >= 0 ? fixedHere : 0;
    return out;
  }
}

/** LMSX: one unit per second, the frame is the RS message of the codeword at block byte 5 (or 40, 45). */
export class LmsxDecoder {
  private readonly inner = new LmsInner(LMSX_UNIT);
  private readonly cw = new Uint8Array(255);
  private readonly tmp = new Uint8Array(LMSX_UNIT);
  decode(soft: Float32Array): SondeFrame | null {
    this.inner.run(soft);
    return this.unit(this.inner.block, this.inner.lastVitFixed);
  }
  /** One 300-byte unit, sync included. */
  unit(block: Uint8Array, vitFixed = 0): SondeFrame | null {
    const at = [5, 40, 45];
    for (let a = 0; a < at.length; a++) {
      const pos = at[a];
      if (pos + 255 > block.length) continue;
      // a quick look first: the frame sync within two bytes' worth of errors, or the first position always
      let m = 0;
      for (let j = 0; j < 4; j++) if (block[pos + j] === LMSX_SYNC[j]) m++;
      if (m < 2 && a > 0) continue;
      this.tmp.set(block);
      const fixed = lmsRsFix(this.tmp, pos, this.cw);
      if (fixed < 0) continue;
      const f = lmsParse(this.tmp, true, pos);
      if (!f) continue;
      f.fixed = fixed;
      if (vitFixed) f.extra = { ...f.extra, 'VITERBI FIXED': `${vitFixed} symbols` };
      return f;
    }
    return null;
  }
}
