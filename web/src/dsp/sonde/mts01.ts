/**
 * Meteosis MTS01: 1200 baud NRZ 2-FSK ('1' = upper tone), header AA AA B4 2B, then 131 bytes most significant bit
 * first: one lead byte, a 128-byte comma-separated ASCII record (NUL padded) and a CRC-16 (polynomial 0x8005, init
 * 0xFFFF, result bit-reversed, stored little-endian) over the record. The slicer follows the header's polarity; the
 * CRC decides. The TypeScript twin of core/sonde/Mts01.kt and Mts01.swift.
 */
import type { ChannelDecoder } from './bank.js';
import type { SondeFrame, SondeSink } from './types.js';

export const MTS01_BAUD = 1200;
export const MTS01_HEADER = '10101010101010101011010000101011';
const HDR = 0xaaaab42b;
export const MTS01_BYTES = 131;
export const MTS01_SYMS = MTS01_BYTES * 8;
const DATLEN = 128;

/** CRC-16 0x8005 / 0xFFFF over bytes[off .. off+len-1], the result's 16 bits reversed. */
export function mts01Crc(bytes: ArrayLike<number>, off: number, len: number): number {
  let rem = 0xffff;
  for (let i = 0; i < len; i++) {
    rem ^= (bytes[off + i] & 0xff) << 8;
    for (let j = 0; j < 8; j++) rem = (rem & 0x8000 ? (rem << 1) ^ 0x8005 : rem << 1) & 0xffff;
  }
  let re = 0;
  for (let j = 0; j < 16; j++) if (rem & (1 << (15 - j))) re |= 1 << j;
  return re;
}

/** Degrees C from the thermistor reading (kilohms; Beta 3000 K, 15 k at 0 °C). */
export function mts01TempFromR(R: number): number {
  if (!(R > 0)) return NaN;
  return 1 / (1 / 273.15 + Math.log(R / 15.0) / 3000.0) - 273.15;
}

export class Mts01Decoder {
  private readonly fb = new Uint8Array(MTS01_BYTES);

  decode(soft: Float32Array): SondeFrame | null {
    const fb = this.fb;
    const n = Math.min(MTS01_BYTES, soft.length >> 3);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | (soft[8 * i + k] > 0 ? 1 : 0);
      fb[i] = v;
    }
    for (let i = n; i < MTS01_BYTES; i++) fb[i] = 0;
    return this.parse(fb);
  }

  /** The 131 bytes after the header. */
  parse(fb: Uint8Array): SondeFrame | null {
    const crc = (fb[130] << 8) | fb[129];
    if (mts01Crc(fb, 1, DATLEN) !== crc) return null;
    // the record: printable ASCII up to the first NUL
    let text = '';
    for (let i = 1; i <= DATLEN; i++) {
      const c = fb[i];
      if (c === 0) break;
      if (c < 0x20 || c > 0x7e) return null;
      text += String.fromCharCode(c);
    }
    const fld = text.split(',');
    if (fld.length < 8) return null;
    const id = fld[0].slice(0, 8).trim();
    if (!id) return null;
    const out: SondeFrame = { type: 'MTS01', model: 'MTS01', serial: 'MTS01-' + id, fixed: 0 };
    const num = (k: number): number => (k < fld.length && fld[k].trim() !== '' ? Number(fld[k]) : NaN);
    const cnt = num(2);
    if (Number.isFinite(cnt)) out.frame = Math.trunc(cnt);
    const dt = fld[3] ?? '';
    if (/^\d{12}$/.test(dt)) {
      const yy = Number(dt.slice(0, 2)), mo = Number(dt.slice(2, 4)), dd = Number(dt.slice(4, 6));
      const hh = Number(dt.slice(6, 8)), mi = Number(dt.slice(8, 10)), ss = Number(dt.slice(10, 12));
      if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) out.date = `${2000 + yy}-${dt.slice(2, 4)}-${dt.slice(4, 6)}`;
      if (hh < 24 && mi < 60 && ss < 61) out.timeS = hh * 3600 + mi * 60 + ss;
    }
    const batt = num(4);
    if (Number.isFinite(batt) && batt > 0) out.battV = Math.trunc(batt) / 1000;
    const lat = num(5), lon = num(6), alt = num(7);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.lat = lat; out.lon = lon;
      if (Number.isFinite(alt)) out.alt = alt;
    }
    const hd = num(8), vH = num(9);
    if (Number.isFinite(hd) && hd >= 0 && hd <= 360) out.heading = hd;
    if (Number.isFinite(vH)) out.vH = vH;
    const T = mts01TempFromR(num(11));
    if (Number.isFinite(T) && T > -120 && T < 80) out.tempC = T;
    if (fld.length > 13 && fld[13].trim() !== '') out.extra = { 'RAW HUMIDITY': fld[13].trim() };
    return out;
  }
}

function pop32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The MTS01 decoder on a channel. NRZ needs its own slicer: the record ends in dozens of NUL bytes (hundreds of zero
 * bits in a row), which would drag a running DC estimate onto the zero tone, so the estimate is held still from the
 * header to the end of the frame. Otherwise the same as FskFramer: a symbol clock nudged at every zero crossing, the
 * integrated discriminator per symbol, the 32-bit header in either FM polarity (up to 2 symbols wrong).
 */
export class Mts01Channel implements ChannelDecoder {
  readonly name = 'MTS01';
  private readonly inc: number;
  private phase = 0; private acc = 0; private lastPos = false; private first = true;
  private dc = 0;
  private sh = 0; private shN = 0;
  private collecting = 0; private inv = false;
  private readonly buf = new Float32Array(MTS01_SYMS); private n = 0;
  private readonly dec = new Mts01Decoder();
  constructor(rate: number, private readonly sink: SondeSink) { this.inc = MTS01_BAUD / rate; }
  push(x: number): void {
    if (this.collecting === 0) this.dc += (x - this.dc) * 0.0005;
    const v = x - this.dc, pos = v > 0;
    if (!this.first && pos !== this.lastPos) {
      const err = this.phase < 0.5 ? this.phase : this.phase - 1;
      this.phase -= err * 0.2;
    }
    this.first = false; this.lastPos = pos;
    this.acc += v;
    this.phase += this.inc;
    if (this.phase < 1) return;
    this.phase -= 1;
    const s = this.acc; this.acc = 0;
    if (this.collecting > 0) {
      this.buf[this.n++] = this.inv ? -s : s;
      if (--this.collecting === 0) {
        const f = this.dec.decode(this.buf);
        if (f) this.sink(f);
      }
      return;
    }
    this.sh = ((this.sh << 1) | (s > 0 ? 1 : 0)) >>> 0;
    if (++this.shN < 32) return;
    const e = pop32((this.sh ^ HDR) >>> 0), ei = pop32((~(this.sh ^ HDR)) >>> 0);
    if (e <= 2 || ei <= 2) {
      this.inv = ei < e; this.collecting = MTS01_SYMS; this.n = 0; this.shN = 0;
    }
  }
}
