/**
 * Test signals for the iMet-1/iMet-4, iMet-54 and Meisei decoders: frames built the way each sonde builds them (CRCs,
 * Hamming code and interleave, BCH blocks, biphase-S, 8N1) and an AFSK-on-FM modulator for the iMet-1/iMet-4.
 * Used by the tests only.
 */
import { Prng } from './synth.js';
import { imetCrc, IMET_BAUD, IMET_MARK, IMET_SPACE, PKT_EGPS, PKT_EPTU, PKT_GPS, PKT_PTU, PKT_XDATA } from './imet.js';
import { IMET54_HAM, IMET54_LEN, imet54ContCrc, imet54StdCrc } from './imet54.js';
import { MEISEI_HDR0, MEISEI_HDR1, meiseiBlock, toF32e2 } from './meisei.js';

// ---------------------------------------------------------------- iMet-1 / iMet-4

export interface ImetData {
  frame: number; hPa: number; tempC: number; rh: number; battV: number;
  lat: number; lon: number; alt: number; sats: number; timeS: number;
  vE?: number; vN?: number; vU?: number;
  /** Extended PTU: internal, pressure-sensor and humidity-sensor temperatures. */
  ext?: [number, number, number];
  /** Extra-data payload (instrument id first). */
  xdata?: number[];
}

const fvw = new DataView(new ArrayBuffer(4));
function putF32le(b: number[], v: number): void { fvw.setFloat32(0, v, true); for (let k = 0; k < 4; k++) b.push(fvw.getUint8(k)); }
function crcTail(b: number[], start: number): void { const c = imetCrc(b, start, b.length - start); b.push(c >> 8, c & 255); }

/** One burst's bytes: GPS (or eGPS when velocities are given), PTU (or ePTU), and an XDATA packet if any. */
export function imetBurst(d: ImetData): number[] {
  const b: number[] = [];
  let s = b.length;
  const eg = d.vE !== undefined;
  b.push(0x01, eg ? PKT_EGPS : PKT_GPS);
  putF32le(b, d.lat); putF32le(b, d.lon);
  const a = Math.round(d.alt) + 5000; b.push(a & 255, (a >> 8) & 255, d.sats);
  if (eg) { putF32le(b, d.vE!); putF32le(b, d.vN!); putF32le(b, d.vU!); }
  const t = Math.floor(d.timeS);
  b.push(Math.floor(t / 3600) % 24, Math.floor(t / 60) % 60, t % 60);
  crcTail(b, s);
  s = b.length;
  b.push(0x01, d.ext ? PKT_EPTU : PKT_PTU, d.frame & 255, (d.frame >> 8) & 255);
  const p = Math.round(d.hPa * 100); b.push(p & 255, (p >> 8) & 255, (p >> 16) & 255);
  const T = Math.round(d.tempC * 100) & 0xffff; b.push(T & 255, T >> 8);
  const U = Math.round(d.rh * 100); b.push(U & 255, U >> 8);
  b.push(Math.round(d.battV * 10));
  if (d.ext) for (const v of d.ext) { const x = Math.round(v * 100) & 0xffff; b.push(x & 255, x >> 8); }
  crcTail(b, s);
  if (d.xdata) {
    s = b.length;
    b.push(0x01, PKT_XDATA, d.xdata.length, ...d.xdata);
    crcTail(b, s);
  }
  return b;
}

/** The line bits of a burst: idle mark, then each byte as 8N1 (least significant bit first), then idle again. */
export function imetLineBits(bytes: ArrayLike<number>, idleBefore = 24, idleAfter = 12): number[] {
  const o: number[] = [];
  for (let i = 0; i < idleBefore; i++) o.push(1);
  for (let i = 0; i < bytes.length; i++) { o.push(0); for (let k = 0; k < 8; k++) o.push((bytes[i] >> k) & 1); o.push(1); }
  for (let i = 0; i < idleAfter; i++) o.push(1);
  return o;
}

/** Bell 202 AFSK (continuous audio phase) as FM on signed int8 IQ: `dev` Hz peak deviation, `lead` s of idle mark around it. */
export function afskFmIq(bits: ArrayLike<number>, rate: number, offsetHz: number, dev = 4000, snrDb = 30, lead = 0.05, rng = new Prng(7), amp = 60): Int8Array {
  const sps = rate / IMET_BAUD, leadN = Math.round(lead * rate);
  const n = Math.ceil(bits.length * sps) + 2 * leadN;
  const out = new Int8Array(2 * n);
  // noise over the FM channel bandwidth (dev + tones, both sides)
  const noise = amp * Math.pow(10, -snrDb / 20) * Math.sqrt(rate / (2 * (dev + IMET_SPACE))) / Math.SQRT2;
  let ph = 0, aph = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i - leadN) / sps);
    const bit = k < 0 || k >= bits.length ? 1 : bits[k];
    aph += 2 * Math.PI * (bit ? IMET_MARK : IMET_SPACE) / rate;
    if (aph > Math.PI) aph -= 2 * Math.PI;
    ph += 2 * Math.PI * (offsetHz + dev * Math.sin(aph)) / rate;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    out[2 * i] = Math.max(-127, Math.min(127, Math.round(amp * Math.cos(ph) + noise * rng.gauss())));
    out[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(amp * Math.sin(ph) + noise * rng.gauss())));
  }
  return out;
}

// ---------------------------------------------------------------- iMet-54

export interface Imet54Data {
  serial: number; timeS: number; lat: number; lon: number; alt: number;
  tempC?: number; rh?: number; tRh?: number;
  /** iMet-54 = 0x003E (GPS + PTU), iMet-50 = 0x0030. */
  status?: number;
  /** Write the newer firmware's CRC over bytes 0..0x33 as well. */
  cont?: boolean;
}
const put32be = (b: Uint8Array, p: number, v: number) => { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; };
const putF32be = (b: Uint8Array, p: number, v: number) => { fvw.setFloat32(0, v); for (let k = 0; k < 4; k++) b[p + k] = fvw.getUint8(k); };
/** Degrees as NMEA ddmm.mmmm x 1e4. */
export const toNmea = (deg: number): number => { const d = Math.trunc(deg), m = (deg - d) * 60; return d * 1_000_000 + Math.round(m * 10_000); };

export function imet54Frame(d: Imet54Data): Uint8Array {
  const b = new Uint8Array(IMET54_LEN);
  put32be(b, 0, d.serial);
  const t = Math.round(d.timeS * 1000), hh = Math.floor(t / 3_600_000), mm = Math.floor(t / 60_000) % 60, ms = t % 60_000;
  put32be(b, 4, hh * 10_000_000 + mm * 100_000 + ms);
  put32be(b, 8, toNmea(d.lat)); put32be(b, 12, toNmea(d.lon)); put32be(b, 16, Math.round(d.alt * 10));
  const ABSENT = 1e9;
  putF32be(b, 0x1c, d.tempC ?? ABSENT); putF32be(b, 0x20, d.rh ?? ABSENT); putF32be(b, 0x24, d.tRh ?? ABSENT);
  const st = d.status ?? 0x003e;
  b[0x2a] = st >> 8; b[0x2b] = st & 255;
  if (d.cont) put32be(b, 0x34, imet54ContCrc(b));
  imet54SetStd(b);
  return b;
}
/** Fill a frame's two whole-frame check words (bytes 100..101 and 106..107 do not feed the CRC). */
export function imet54SetStd(b: Uint8Array): void {
  const r = imet54StdCrc(b);
  const c0 = (r >>> 16) ^ 0x5000, c1 = (r & 0xffff) ^ 0x1dad;
  b[100] = c0 >> 8; b[101] = c0 & 255; b[106] = c1 >> 8; b[107] = c1 & 255;
}
/** The channel symbols: preamble and sync as 8N1, then the Hamming-coded, interleaved frame, then two spare groups. */
export function imet54Symbols(fr: Uint8Array): number[] {
  const o: number[] = [];
  const group = (bits: ArrayLike<number>) => { o.push(0); for (let k = 0; k < 8; k++) o.push(bits[k]); o.push(1); };
  const byte = (v: number) => { const g = [0, 0, 0, 0, 0, 0, 0, 0]; for (let k = 0; k < 8; k++) g[k] = (v >> (7 - k)) & 1; group(g); };
  for (let i = 0; i < 10; i++) { byte(0x00); byte(0xaa); }
  for (const v of [0x24, 0x24, 0x24, 0x24, 0x42]) byte(v);
  for (let blk = 0; blk < 27; blk++) {
    const cw = new Array(8);
    for (let k = 0; k < 8; k++) { const by = fr[4 * blk + (k >> 1)]; cw[k] = IMET54_HAM[k & 1 ? by & 15 : by >> 4]; }
    for (let i = 0; i < 8; i++) { const g = new Array(8); for (let j = 0; j < 8; j++) g[j] = (cw[j] >> i) & 1; group(g); }
  }
  byte(0x00); byte(0x00);
  return o;
}

// ---------------------------------------------------------------- Meisei

export interface MeiseiData {
  lat: number; lon: number; alt: number; vH: number; heading: number; climb: number;
  /** UTC time of day, s. */
  timeS: number; year: number; month: number; day: number;
  tRaw: number; uRaw: number; fRef: number;
}

/** The 64-slot configuration table: serial, frequency, temperature points, resistances, polynomials. */
export function meiseiCfg(model: 'iMS-100' | 'RS-11G', serial: number, txKHz: number): Float32Array {
  const c = new Float32Array(64);
  for (const s of [0, 16, 32, 48]) c[s] = serial;
  c[15] = (txKHz - (model === 'iMS-100' ? 400_000 : 403_700)) / 100;
  const n = model === 'iMS-100' ? 12 : 11, rLo = model === 'iMS-100' ? 33 : 37, poly = model === 'iMS-100' ? 53 : 33;
  for (let i = 0; i < n; i++) { c[17 + i] = 40 - 10 * i; c[rLo + i] = 3 * Math.exp(0.4 * i); }
  // R = c0 + c1 f + c2 f^2 - c3 with f = 1 / (4 t_raw / f_ref - 1): here just R = f
  c[poly] = 0; c[poly + 1] = 1; c[poly + 2] = 0; c[poly + 3] = 0;
  // RH = 25 f, f = 4 u_raw / f_ref
  c[49] = 0; c[50] = 25; c[51] = 0; c[52] = 0;
  return c;
}
/** The raw temperature count that reads `tempC` with meiseiCfg's table (log-linear between the points). */
export function meiseiTRaw(model: 'iMS-100' | 'RS-11G', cfg: Float32Array, tempC: number, fRef: number): number {
  const n = model === 'iMS-100' ? 12 : 11, rLo = model === 'iMS-100' ? 33 : 37;
  let R = cfg[rLo];
  for (let j = 0; j < n - 1; j++) {
    if (tempC <= cfg[17 + j] && tempC >= cfg[18 + j]) {
      const g = (cfg[17 + j] - tempC) / (cfg[17 + j] - cfg[18 + j]);
      R = Math.exp(Math.log(cfg[rLo + j]) + g * (Math.log(cfg[rLo + j + 1]) - Math.log(cfg[rLo + j])));
      break;
    }
  }
  return Math.round(fRef * (1 + 1 / R) / 4);
}

const fbe = new DataView(new ArrayBuffer(4));
const floatBits = (f: number) => { fbe.setFloat32(0, f); return fbe.getUint32(0); };
const swap16 = (v: number) => ((v >> 8) & 0xff) | ((v & 0xff) << 8);

/** One 600-bit frame (both subframes) for counter c. */
export function meiseiFrame(model: 'iMS-100' | 'RS-11G', c: number, d: MeiseiData, cfg: Float32Array): Uint8Array {
  const ims = model === 'iMS-100';
  const w0 = new Array(12).fill(0), w1 = new Array(12).fill(0);
  const even = c % 2 === 0;
  const t = Math.round(d.timeS * 1000), hh = Math.floor(t / 3_600_000), mm = Math.floor(t / 60_000) % 60, ms = t % 60_000;
  w0[0] = c & 0xffff;
  if (c % 4 === 0) w0[1] = d.fRef;
  const slot = c % 64;
  if (ims) { const v = floatBits(cfg[slot]); w0[2] = v & 0xffff; w0[3] = v >>> 16; }
  else { const v = toF32e2(cfg[slot]); w0[2] = swap16(v & 0xffff); w0[3] = swap16(v >>> 16); }
  w0[5] = d.tRaw;
  w0[6] = ims && c % 4 === 3 ? d.fRef : d.uRaw;
  w0[7] = (even ? 0x3000 : 0x3100) | (ims ? 0xc1 : 0xa2);
  if (ims && even) { w0[10] = ms; w0[11] = (hh << 8) | mm; }
  if (!ims && !even) { w0[10] = swap16(ms); w0[11] = (hh << 8) | mm; }
  if (ims) {
    if (even) {
      w1[0] = d.day * 1000 + d.month * 10 + (d.year % 10);
      const la = toNmea(d.lat) >>> 0, lo = toNmea(d.lon) >>> 0, al = Math.round(d.alt * 100);
      w1[1] = la >>> 16; w1[2] = la & 0xffff; w1[3] = lo >>> 16; w1[4] = lo & 0xffff;
      w1[5] = (al >> 8) & 0xffff; w1[6] = (al & 0xff) << 8;
      w1[9] = Math.round(d.heading * 100); w1[10] = Math.round(d.vH * 194.384);
    } else {
      w1[1] = Math.round(d.climb * 19.4384) & 0xffff;
    }
    let sum = w0[10] + w0[11];
    for (let j = 0; j < 11; j++) sum += w1[j];
    w1[11] = sum & 0xffff;
  } else if (even) {
    const la = Math.round(d.lat * 1e7) >>> 0, lo = Math.round(d.lon * 1e7) >>> 0, al = Math.round(d.alt * 100) >>> 0;
    w1[1] = la >>> 16; w1[2] = la & 0xffff; w1[3] = lo >>> 16; w1[4] = lo & 0xffff; w1[5] = al >>> 16; w1[6] = al & 0xffff;
    w1[7] = Math.round(d.vH * 100); w1[8] = Math.round(d.heading * 100); w1[9] = Math.round(d.climb * 100) & 0xffff;
    w1[10] = (d.year - 0x700) & 0xff; w1[11] = (d.month << 8) | d.day;
  }
  const b = new Uint8Array(600);
  for (let s = 0; s < 2; s++) {
    const h = s === 0 ? MEISEI_HDR0 : MEISEI_HDR1, w = s === 0 ? w0 : w1;
    for (let k = 0; k < 24; k++) b[300 * s + k] = (h >> (23 - k)) & 1;
    for (let k = 0; k < 6; k++) meiseiBlock(w[2 * k], w[2 * k + 1], b, 300 * s + 24 + 46 * k);
  }
  return b;
}

/** Biphase-S line coding with the level carried from one frame to the next: a transition every cell, one more mid-cell for a 0. */
export class BiphaseS {
  private level = 0;
  encode(bits: ArrayLike<number>): number[] {
    const o: number[] = [];
    for (let i = 0; i < bits.length; i++) {
      this.level ^= 1; o.push(this.level);
      if (!bits[i]) this.level ^= 1;
      o.push(this.level);
    }
    return o;
  }
}
