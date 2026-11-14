/**
 * InterMet iMet-54 (and the iMet-50, the same frame without the PTU sensors): 4800 baud GFSK in 8N1 groups (a 0
 * start bit, 8 data bits, a 1 stop bit; data most significant bit first). Preamble 10 x (0x00 0xAA), sync 0x24 0x24
 * 0x24 0x24 0x42, then 27 blocks of 64 data bits. A block is 8 Hamming(8,4) codewords interleaved 8 x 8 (codeword k
 * is bit k of each of the block's 8 groups) and carries 4 bytes, so a frame is 108 bytes, big-endian: serial, GPS
 * time (decimal HHMMSSmmm), latitude and longitude (NMEA ddmm.mmmm x 1e4), altitude, temperature, humidity and the
 * humidity sensor's temperature as floats, a status word. Two CRC32s check it: one over the whole frame (words at
 * bytes 100 and 106), one over bytes 0..0x33 (at 0x34, the newer firmware); either passing is enough.
 */
import type { ChannelDecoder } from './bank.js';
import type { SondeFrame, SondeSink } from './types.js';

export const IMET54_BAUD = 4800;
/** 0x00 0xAA 0x24 0x24 in 8N1. */
export const IMET54_HEADER = '0000000001010101010100010010010001001001';
/** Channel symbols after the header: 220 8N1 groups (the rest of the sync, 216 data groups, one spare). */
export const IMET54_SYMS = 2200;
export const IMET54_LEN = 108;

/** Codeword of each nibble (codeword bit j = bit j of the byte). */
export const IMET54_HAM = [0x00, 0x87, 0x99, 0x1e, 0xaa, 0x2d, 0x33, 0xb4, 0x4b, 0xcc, 0xd2, 0x55, 0xe1, 0x66, 0x78, 0xff];
/** Received byte to nibble (| 0x10 when one bit was repaired), -1 for two wrong bits. */
const HAM_DEC: Int8Array = (() => {
  const t = new Int8Array(256);
  for (let r = 0; r < 256; r++) {
    t[r] = -1;
    for (let m = 0; m < 16; m++) {
      let x = r ^ IMET54_HAM[m], d = 0;
      while (x) { x &= x - 1; d++; }
      if (d === 0) { t[r] = m; break; }
      if (d === 1) { t[r] = m | 0x10; break; }
    }
  }
  return t;
})();

/** The whole-frame check: the two 16-bit halves of a CRC32 run over the frame word by word from the top. */
export function imet54StdCrc(b: Uint8Array): number {
  const poly0 = 0x0edb, poly1 = 0x8260;
  let n = 104, bit = 0, c0 = 0x48eb, c1 = 0x1aca, crc0 = 0, crc1 = 0;
  while (n >= 0) {
    if (n < 100 || (n > 101 && n < 106)) {
      if ((b[n] >> bit) & 1) { crc0 ^= c0; crc1 ^= c1; }
    }
    let n0 = c0, n1 = c1;
    if (c1 & 0x8000) { n0 ^= poly0; n1 ^= poly1; }
    n0 <<= 1; n1 <<= 1;
    if (c1 & 0x8000) n0 |= 1;
    if ((c1 ^ c0) & 0x8000) n1 |= 1;
    c0 = n0 & 0xffff; c1 = n1;
    if (bit < 7) bit++;
    else { bit = 0; if (n % 4 === 3) n -= 7; else n += 1; }
  }
  return (((crc0 & 0xffff) << 16) | (crc1 & 0xffff)) >>> 0;
}
export function imet54StdOk(b: Uint8Array): boolean {
  const r = imet54StdCrc(b);
  const c0 = (r >>> 16) ^ ((b[100] << 8) | b[101]) ^ 0x5000, c1 = (r & 0xffff) ^ ((b[106] << 8) | b[107]) ^ 0x1dad;
  return c1 === 0 && (c0 & 0xf000) === 0;
}
/** CRC-32 (0x04C11DB7, MSB first, out-XOR 0x63D60875) over bytes 0..0x33 with each 4-byte word reversed. */
export function imet54ContCrc(b: Uint8Array): number {
  let rem = 0;
  for (let i = 0; i < 0x34; i++) {
    rem = (rem ^ (b[(i & ~3) + 3 - (i & 3)] << 24)) >>> 0;
    for (let j = 0; j < 8; j++) rem = (rem & 0x80000000) ? ((rem << 1) ^ 0x04c11db7) >>> 0 : (rem << 1) >>> 0;
  }
  return (rem ^ 0x63d60875) >>> 0;
}
export const imet54ContOk = (b: Uint8Array): boolean => imet54ContCrc(b) === u32(b, 0x34);

const u32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const i32 = (b: Uint8Array, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const fv = new DataView(new ArrayBuffer(4));
const f32 = (b: Uint8Array, p: number) => { fv.setUint32(0, u32(b, p)); return fv.getFloat32(0); };
/** The "no sensor" float, 1e9. */
const ABSENT = 0x4e6e6b28;

/** Hyland-Wexler saturation vapor pressure, Pa. */
function vaporSat(tc: number): number {
  const T = tc + 273.15;
  return Math.exp(-5800.2206 / T + 1.3914993 + 6.5459673 * Math.log(T) - 4.8640239e-2 * T + 4.1764768e-5 * T * T - 1.4452093e-8 * T * T * T);
}

function nmeaDeg(v: number): number {
  const deg = Math.trunc(v / 1e6);
  return deg + (v / 1e6 - deg) * 100 / 60;
}

export class Imet54Decoder {
  private readonly data = new Uint8Array(1760);
  private readonly frame = new Uint8Array(IMET54_LEN);

  /** One frame's soft symbols after the header (the 2200 symbols FskFramer would collect). */
  decode(soft: Float32Array): SondeFrame | null {
    // strip the start and stop bits
    const d = this.data;
    let m = 0;
    for (let n = 0; n < IMET54_SYMS; n++) { const k = n % 10; if (k > 0 && k < 9) d[m++] = soft[n] > 0 ? 1 : 0; }
    // the 3 sync bytes still to come, then the blocks
    return this.decodeData(d, 24);
  }

  /** 27 x 64 data bits (8N1 framing removed) from `ofs`: de-interleave, Hamming, parse. */
  decodeData(d: Uint8Array, ofs: number): SondeFrame | null {
    const fr = this.frame;
    let fixed = 0, bad = 0;
    for (let blk = 0; blk < 27; blk++) {
      for (let k = 0; k < 8; k++) {
        let cw = 0;
        for (let i = 0; i < 8; i++) cw |= d[ofs + 64 * blk + 8 * i + k] << i;
        let nib = HAM_DEC[cw];
        if (nib < 0) { bad++; nib = 0; } else if (nib & 0x10) { fixed++; nib &= 15; }
        const at = 4 * blk + (k >> 1);
        fr[at] = k & 1 ? (fr[at] & 0xf0) | nib : nib << 4;
      }
    }
    const out = this.parse(fr);
    if (out) { out.fixed = fixed; if (bad) out.extra = { ...out.extra, 'UNREPAIRED NIBBLES': `${bad}` }; }
    return out;
  }

  /** A 108-byte frame (after the Hamming code). Null unless a CRC passes and the status says GPS and PTU are in. */
  parse(fr: Uint8Array): SondeFrame | null {
    const std = imet54StdOk(fr), cont = imet54ContOk(fr);
    if (!std && !cont) return null;
    const status = (fr[0x2a] << 8) | fr[0x2b];
    if ((status & 0x30) !== 0x30) return null;
    const t = i32(fr, 4);
    if (t < 0 || t > 235959999) return null;
    const hh = Math.floor(t / 10000000), mm = Math.floor(t / 100000) % 100, ss = (t % 100000) / 1000;
    if (hh > 23 || mm > 59 || ss >= 61) return null;
    const lat = nmeaDeg(i32(fr, 8)), lon = nmeaDeg(i32(fr, 12)), alt = i32(fr, 16) / 10;
    if (!(lat > -90 && lat < 90 && lon > -180 && lon < 180 && alt > -400 && alt < 60000)) return null;
    const sn = u32(fr, 0);
    const timeS = hh * 3600 + mm * 60 + ss;
    const out: SondeFrame = { type: 'iMet-54', model: 'iMet-54', serial: `${sn}`, frame: Math.floor(timeS + 0.5), timeS, lat, lon, alt };
    let absent = 0;
    const T = u32(fr, 0x1c) === ABSENT ? (absent++, NaN) : f32(fr, 0x1c);
    const RH = u32(fr, 0x20) === ABSENT ? (absent++, NaN) : f32(fr, 0x20);
    const Trh = u32(fr, 0x24) === ABSENT ? (absent++, NaN) : f32(fr, 0x24);
    let aux = 0;
    for (let i = 0x2c; i < 0x52; i++) aux += fr[i];
    if (aux === 0 && (status & 0xf0f) === 0 && absent === 3) out.model = 'iMet-50';
    if (T > -120 && T < 80) out.tempC = T;
    if (Trh > -120 && Trh < 80) out.tHumC = Trh;
    if (out.tempC !== undefined && out.tHumC !== undefined && Number.isFinite(RH)) {
      out.rh = Math.max(0, Math.min(100, RH * vaporSat(Trh) / vaporSat(T)));
    }
    out.extra = { STATUS: `0x${status.toString(16).padStart(4, '0')}`, CRC: std && cont ? 'both' : std ? 'frame' : 'first 52 bytes' };
    return out;
  }
}

/**
 * The iMet-54 on a channel. A symbol clock on the discriminator's level changes (found on a short running mean, so
 * noise makes few false ones; integrate and dump over each symbol), sliced at the midpoint of the 0 and 1 levels the
 * decisions themselves track (the frame's long runs of zeros would drag a running mean off), then the last three sync
 * bytes 0x24 0x24 0x42 as 30 8N1 symbols in either polarity, then 216 groups of data.
 */
export class Imet54Channel implements ChannelDecoder {
  readonly name = 'iMet-54';
  private readonly dec = new Imet54Decoder();
  private readonly inc: number;
  private readonly ring: Float64Array; private rp = 0; private rs = 0;
  private phase = 0; private acc = 0; private cnt = 0; private lastPos = false;
  private mean = 0; private lvl0 = 0; private lvl1 = 0; private started = false;
  private sh = 0;
  private collecting = 0; private inv = false;
  private readonly soft = new Float32Array(2160); private ns = 0;
  private readonly bits = new Uint8Array(1728);
  /** Timing-loop gain per level change. */
  gain = 0.05;
  /** Level changes counted only this close to a boundary, in symbols. */
  gate = 0.35;
  constructor(rate: number, private readonly sink: SondeSink) {
    this.inc = IMET54_BAUD / rate;
    this.ring = new Float64Array(Math.max(1, Math.round(rate / IMET54_BAUD / 3)));
  }
  push(x: number): void {
    const m = this.ring.length;
    this.rs += x - this.ring[this.rp]; this.ring[this.rp] = x; this.rp = this.rp + 1 === m ? 0 : this.rp + 1;
    const v = this.rs / m;
    if (!this.started) { this.mean = v; this.lvl0 = v; this.lvl1 = v; this.started = true; }
    const thr = (this.lvl0 + this.lvl1) / 2;
    const pos = v > thr;
    if (pos !== this.lastPos) {
      // level changes far from a symbol boundary are noise; leave them out
      const err = this.phase < 0.5 ? this.phase : this.phase - 1;
      if (err < this.gate && err > -this.gate) this.phase -= err * this.gain;
    }
    this.lastPos = pos;
    this.acc += v; this.cnt++;
    this.phase += this.inc;
    if (this.phase < 1) return;
    this.phase -= 1;
    const s = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
    this.symbol(s, thr);
  }
  private symbol(s: number, thr: number): void {
    // the levels follow the decisions; outside a frame they also drift with the carrier (the slow mean)
    if (s > thr) this.lvl1 += (s - this.lvl1) * 0.02; else this.lvl0 += (s - this.lvl0) * 0.02;
    if (this.collecting === 0) {
      this.mean += (s - this.mean) * 0.01;
      const mid = (this.lvl0 + this.lvl1) / 2, pull = (this.mean - mid) * 0.002;
      this.lvl0 += pull; this.lvl1 += pull;
    }
    if (this.collecting > 0) {
      this.soft[this.ns++] = this.inv ? thr - s : s - thr;
      if (--this.collecting === 0) this.frame();
      return;
    }
    this.sh = ((this.sh << 1) | (s > thr ? 1 : 0)) & 0x3fffffff;
    let a = this.sh ^ SYNC_TAIL, e = 0, ei = 0;
    while (a) { a &= a - 1; e++; }
    a = (this.sh ^ ~SYNC_TAIL) & 0x3fffffff;
    while (a) { a &= a - 1; ei++; }
    if (e <= 2 || ei <= 2) { this.inv = ei < e; this.collecting = 2160; this.ns = 0; this.sh = 0; }
  }
  private frame(): void {
    let m = 0;
    for (let n = 0; n < 2160; n++) { const k = n % 10; if (k > 0 && k < 9) this.bits[m++] = this.soft[n] > 0 ? 1 : 0; }
    const f = this.dec.decodeData(this.bits, 0);
    if (f && f.serial) this.sink(f);
  }
}

/** 0x24 0x24 0x42 as 8N1 symbols (30 bits, the first in bit 29). */
const SYNC_TAIL: number = (() => {
  let v = 0;
  for (const b of [0x24, 0x24, 0x42]) { v = (v << 1) | 0; for (let k = 7; k >= 0; k--) v = (v << 1) | ((b >> k) & 1); v = (v << 1) | 1; }
  return v;
})();
