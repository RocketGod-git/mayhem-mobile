/**
 * Test signals for the DFM, M10/M20 and MTS01 decoders: frames built the way each sonde builds them (Hamming and
 * column interleave, Meteomodem checksum, CRC), as channel symbols for fskIq(). Used by the tests only.
 */
import { dfmFl24, dfmHamming, dfmTempFromR } from './dfm.js';
import { checkM10, m10TempFromAdc, m10TempFromR, m10TntcFromAdc, m20Humidity, m20TntcFromAdc } from './m10.js';
import { mts01Crc } from './mts01.js';
import type { FlightPoint } from './synth.js';

/** The x (between lo and hi, on a log scale) where f(x) = want, for a monotonic f. */
function solveLog(f: (x: number) => number, want: number, lo: number, hi: number): number {
  const up = f(hi) > f(lo);
  for (let i = 0; i < 100; i++) {
    const mid = Math.sqrt(lo * hi);
    if ((f(mid) < want) === up) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// ---------------------------------------------------------------- DFM

export type DfmKind = 'DFM-06' | 'DFM-09' | 'DFM-09P' | 'DFM-17' | 'PS-15';
export interface DfmOptions {
  kind: DfmKind;
  /** Decimal serial (DFM-09/17, PS-15) or the six BCD digits as a number like 0x123456 (DFM-06). */
  serial: number;
  tempC: number; battV?: number;
  /** UTC start, ms since 1970. */
  startMs: number;
  /** Position at second k of the flight. */
  flight: (k: number) => FlightPoint;
  sats?: number;
  frnr0?: number;
  /** The config channel to start the cycle at (the serial channel is the last one). */
  chStart?: number;
}

/** A DFM transmitter: one 280-bit frame per call, data packets 0..8 two per frame, config channels in turn. */
export class DfmTx {
  private pk = 0;
  private ch = 0;
  private readonly chans: number[];
  constructor(private readonly o: DfmOptions) { this.chans = this.channels(); this.ch = o.chStart ?? 0; }
  /** Config channels in one cycle. */
  get cycleLen(): number { return this.chans.length; }

  /** The config channel values (index = channel number), the serial channel last, two halves alternating. */
  private channels(): number[] {
    const o = this.o, k = o.kind;
    const fl = (v: number, p: number) => (p << 20) | Math.round(v * (1 << p));
    const R = solveLog(dfmTempFromR, o.tempC, 100, 1e7);
    const mv = Math.round((o.battV ?? 3.1) * 1000);
    if (k === 'DFM-06') {
      const Rs = 10e3, Rf = 220e3, g = 1;
      // 0..4 measurements, 5 = the null channel 0x5A, 6 = the serial
      return [fl(g * (R + Rs), 2), fl(12345, 2), fl(23456, 2), fl(g * Rs, 2), fl(g * Rf, 2), 0xa00000, o.serial & 0xffffff];
    }
    if (k === 'PS-15') {
      // no PTU channels the decoder uses; 6 = null, 7 = the serial halves with a 0 second nibble
      return [fl(1000, 0), fl(2000, 0), fl(3000, 0), fl(4000, 0), fl(5000, 0), mv << 4, 0, -1];
    }
    const P = k === 'DFM-09P';
    const Rf = k === 'DFM-17' ? 332e3 : 220e3, Rs = 20e3, g = P ? 0.5 : 1, p = P ? 3 : Rf > 300e3 ? 1 : 2;
    const v: number[] = [];
    for (let c = 0; c <= 8; c++) v.push(fl(10000 + 1000 * c, 2));
    const tf = P ? [1, 5, 6] : [0, 3, 4];
    v[tf[0]] = fl(g * (R + Rs), p); v[tf[1]] = fl(g * Rs, p); v[tf[2]] = fl(g * Rf, p);
    const ofs = P ? 2 : 0;
    v[5 + ofs] = mv << 4;
    v[6 + ofs] = Math.round((25 + 273.15) * 100) << 4;    // MCU temperature, 25 °C
    if (k === 'DFM-17') v[7] = 4321 << 4;                  // the sonde's seconds counter
    const sub = k === 'DFM-09' ? 0xa : k === 'DFM-17' ? 0xb : 0xc;
    while (v.length < sub - 1) v.push(fl(5000, 0));
    v.push(0);    // the null channel, just below the serial channel
    v.push(-1);   // the serial channel, filled per cycle
    return v;
  }

  private serialValue(cycle: number): number {
    const o = this.o, hl = cycle & 1;
    const half = hl ? o.serial & 0xffff : (o.serial >>> 16) & 0xffff;
    const top = o.kind === 'PS-15' ? 0x0 : 0xc;
    return (top << 20) | (half << 4) | hl;
  }

  /** Data packet `id` for flight second `sec`: 6 payload bytes. */
  private packet(id: number, sec: number): number[] {
    const o = this.o, p = o.flight(sec);
    const ms = o.startMs + sec * 1000, d = new Date(ms);
    const frnr = ((o.frnr0 ?? 1) + sec) & 0xff;
    const b = [0, 0, 0, 0, 0, 0];
    const s32 = (v: number) => { b[0] = (v >>> 24) & 255; b[1] = (v >>> 16) & 255; b[2] = (v >>> 8) & 255; b[3] = v & 255; };
    const s16 = (v: number) => { b[4] = (v >> 8) & 255; b[5] = v & 255; };
    const vH = Math.hypot(p.vN, p.vE);
    let hd = Math.atan2(p.vE, p.vN) * 180 / Math.PI; if (hd < 0) hd += 360;
    switch (id) {
      case 0: b[2] = 2; b[3] = frnr; break;
      case 1: s32(0x0f0f0f0f); s16(d.getUTCSeconds() * 1000 + d.getUTCMilliseconds()); break;
      case 2: s32(Math.round(p.lat * 1e7)); s16(Math.round(vH * 100)); break;
      case 3: s32(Math.round(p.lon * 1e7)); s16(Math.round(hd * 100)); break;
      case 4: s32(Math.round(p.alt * 100)); s16(Math.round(p.vU * 100)); break;
      case 5: b[0] = ((-3350) >> 8) & 255; b[1] = -3350 & 255; break;   // MSL - ellipsoid = -33.5 m
      case 8: {
        const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, dd = d.getUTCDate(), h = d.getUTCHours(), mi = d.getUTCMinutes();
        b[0] = (y >> 4) & 255; b[1] = ((y & 15) << 4) | mo; b[2] = (dd << 3) | (h >> 2); b[3] = ((h & 3) << 6) | mi; b[4] = o.sats ?? 10;
        break;
      }
    }
    return b;
  }

  /** Nibbles of a block -> codewords -> column-wise bits. */
  private static block(nibs: number[], out: number[]): void {
    const L = nibs.length;
    const cw = nibs.map(dfmHamming);
    for (let j = 0; j < 8; j++) for (let i = 0; i < L; i++) out.push((cw[i] >> (7 - j)) & 1);
  }

  /** The next 280-bit frame. */
  next(): number[] {
    const bits: number[] = [];
    for (let k = 0; k < 16; k++) bits.push((0x45cf >> (15 - k)) & 1);
    const nCh = this.chans.length, cycle = Math.floor(this.ch / nCh), c = this.ch % nCh;
    let val = this.chans[c];
    if (val < 0) val = this.serialValue(cycle);
    this.ch++;
    const conf = [c]; for (let k = 5; k >= 0; k--) conf.push((val >> (4 * k)) & 15);
    DfmTx.block(conf, bits);
    for (let d = 0; d < 2; d++) {
      const id = this.pk % 9, sec = Math.floor(this.pk / 9);
      this.pk++;
      const by = this.packet(id, sec), nib: number[] = [];
      for (const x of by) nib.push(x >> 4, x & 15);
      nib.push(id);
      DfmTx.block(nib, bits);
    }
    return bits;
  }
}

/** DFM channel symbols: Manchester "01" = 1, "10" = 0; `invert` flips the FM polarity (DFM-06, DFM-17). */
export function dfmSymbols(frames: number[][], invert = false): number[] {
  const out: number[] = [];
  for (const f of frames) for (const b of f) { const x = invert ? 1 - b : b; out.push(1 - x, x); }
  return out;
}

// ---------------------------------------------------------------- M10 / M20

export interface M10Options {
  /** "YMM-T-Nnnnn" (no M10- prefix). */
  serial: string;
  counter: number; p: FlightPoint;
  week: number; towMs: number; leap?: number; sats?: number;
  tempC: number; rh: number; tHumC: number; battV: number;
  /** 0x9F (M10), 0x8F (M2K2), 0xAF (M10+ with the Gtop GPS). */
  type?: number;
  /** Extra aux bytes (frame length 0x64 + aux). */
  aux?: number;
}

const be = (b: Uint8Array, p: number, v: number, n: number) => { for (let k = 0; k < n; k++) b[p + k] = (v >>> (8 * (n - 1 - k))) & 255; };
const le = (b: Uint8Array, p: number, v: number, n: number) => { for (let k = 0; k < n; k++) b[p + k] = (v >>> (8 * k)) & 255; };

/** The ADC count (and M10 range) that reads closest to a temperature. */
function m10TempAdc(tempC: number): { adc: number; scT: number } {
  const RS = [12.1e3, 36.5e3, 475.0e3], RP = [1e20, 330.0e3, 2000.0e3];
  const R = solveLog(m10TempFromR, tempC, 100, 1e8);
  let best = { adc: 2048, scT: 0 }, err = Infinity;
  for (let s = 0; s < 3; s++) {
    const x = RS[s] / R + RS[s] / RP[s], adc = Math.round(4095 / (x + 1));
    if (adc < 1 || adc > 4094) continue;
    const e = Math.abs(m10TempFromAdc(adc, s) - tempC);
    if (e < err) { err = e; best = { adc, scT: s }; }
  }
  return best;
}
function nearestAdc(f: (a: number) => number, want: number, lo: number, hi: number): number {
  let best = lo, err = Infinity;
  for (let a = lo; a <= hi; a++) { const e = Math.abs(f(a) - want); if (e < err) { err = e; best = a; } }
  return best;
}
/** Parse "YMM-T-Nnnnn". */
function serialParts(s: string): { y: number; mm: number; t: number; d: number; n: number } {
  const [a, t, n] = s.split('-');
  return { y: parseInt(a[0], 16), mm: Number(a.slice(1)), t: parseInt(t, 16), d: Number(n[0]), n: Number(n.slice(1)) };
}

export function m10Frame(o: M10Options): Uint8Array {
  const type = o.type ?? 0x9f, aux = o.aux ?? 0;
  const flen = 0x64 + aux;
  const f = new Uint8Array(flen + 1);
  f[0] = flen; f[1] = type; f[2] = 0x20;
  const p = o.p;
  if (type === 0xaf) {
    be(f, 0x04, Math.round(p.lat * 1e6), 4); be(f, 0x08, Math.round(p.lon * 1e6), 4);
    be(f, 0x0c, Math.round(p.alt * 100) & 0xffffff, 3);
    be(f, 0x0f, Math.round(p.vE * 100), 2); be(f, 0x11, Math.round(p.vN * 100), 2); be(f, 0x13, Math.round(p.vU * 100), 2);
    const d = new Date(Date.UTC(1980, 0, 6) + (o.week * 604800 + Math.floor(o.towMs / 1000) - (o.leap ?? 18)) * 1000);
    be(f, 0x15, d.getUTCHours() * 10000 + d.getUTCMinutes() * 100 + d.getUTCSeconds(), 3);
    be(f, 0x18, d.getUTCDate() * 10000 + (d.getUTCMonth() + 1) * 100 + (d.getUTCFullYear() % 100), 3);
  } else {
    be(f, 0x04, Math.round(p.vE * 200), 2); be(f, 0x06, Math.round(p.vN * 200), 2); be(f, 0x08, Math.round(p.vU * 200), 2);
    be(f, 0x0a, o.towMs, 4);
    const B60B60 = (1 << 30) / 90.0;
    be(f, 0x0e, Math.round(p.lat * B60B60), 4); be(f, 0x12, Math.round(p.lon * B60B60), 4);
    be(f, 0x16, Math.round(p.alt * 1000), 4);
    f[0x1c] = 1; f[0x1d] = 0; f[0x1e] = o.sats ?? 9; f[0x1f] = o.leap ?? 18;
    be(f, 0x20, o.week, 2);
  }
  // humidity: count ratio 0.8955 + 0.002 RH (at or above 0 °C)
  const c55 = 8_000_000;
  le(f, 0x32, c55, 3); le(f, 0x35, Math.round(c55 * (0.8955 + 0.002 * o.rh)), 3);
  const t = m10TempAdc(o.tempC);
  f[0x3e] = t.scT; le(f, 0x3f, t.adc + 0xa000, 2);
  le(f, 0x45, Math.round(o.battV * 1023 / (2.709 * 2.5)), 2);
  le(f, 0x59, nearestAdc(m10TntcFromAdc, o.tHumC, 1, 4094), 2);
  const s = serialParts(o.serial);
  f[0x5d] = 0x40 | s.t; f[0x5e] = 0; f[0x5f] = (s.y << 4) | s.mm; le(f, 0x60, (s.d << 13) | s.n, 2);
  f[0x62] = o.counter & 255;
  be(f, flen - 1, checkM10(f, flen - 1), 2);
  return f;
}

export interface M20Options {
  /** "YMM-T-Nnnnn" (no M20- prefix). */
  serial: string;
  counter: number; p: FlightPoint; week: number; towS: number;
  tempC: number; rh: number; tHumC: number; battV: number; hPa?: number; fw?: number;
}
export function m20Frame(o: M20Options): Uint8Array {
  const f = new Uint8Array(0x46);
  f[0] = 0x45; f[1] = 0x20;
  const p = o.p, fw = o.fw ?? 0x07;
  const tu = m20TntcFromAdc(nearestAdc(m20TntcFromAdc, o.tHumC, 1, 4094));
  const rhCal = 20000;
  le(f, 0x02, nearestAdc(h => m20Humidity(h, rhCal, tu), o.rh, 0, 47999), 2);
  const t = m10TempAdc(o.tempC);
  le(f, 0x04, t.adc + 4096 * t.scT, 2);
  le(f, 0x06, nearestAdc(m20TntcFromAdc, o.tHumC, 1, 4094), 2);
  be(f, 0x08, Math.round(p.alt * 100), 3);
  be(f, 0x0b, Math.round(p.vE * 100), 2); be(f, 0x0d, Math.round(p.vN * 100), 2);
  be(f, 0x0f, o.towS, 3);
  const s = serialParts(o.serial);
  // ym = years*12 + month-1; the type digit is stored minus one; the 5-digit number's first digit is the top bit
  const sn24 = (s.y * 12 + s.mm - 1) | ((s.t - 1) << 7) | (s.n << 10) | (s.d << 23);
  le(f, 0x12, sn24, 3);
  f[0x15] = o.counter & 255;
  be(f, 0x18, Math.round(p.vU * 100), 2);
  be(f, 0x1a, o.week, 2);
  be(f, 0x1c, Math.round(p.lat * 1e6), 4); be(f, 0x20, Math.round(p.lon * 1e6), 4);
  if (o.hPa) { const v = Math.round(o.hPa * 4096); f[0x16] = v & 255; le(f, 0x24, v >>> 8, 2); }
  f[0x26] = Math.round(o.battV * 255 / 3.3);
  le(f, 0x2f, rhCal, 2);
  f[0x43] = fw;
  be(f, 0x44, checkM10(f, 0x44), 2);
  return f;
}

/** M10/M20 channel symbols: a preamble of biphase-mark zeros, the sync, then the frame biphase-mark coded. */
export function m10Symbols(frame: ArrayLike<number>, invert = false, preamble = 24): number[] {
  const out: number[] = [];
  for (let i = 0; i < preamble; i++) out.push(1, 1, 0, 0);
  for (const c of '11001100110011001010011001001100') out.push(c === '1' ? 1 : 0);
  let prev = 0;
  for (let i = 0; i < frame.length; i++) for (let k = 7; k >= 0; k--) {
    const bit = (frame[i] >> k) & 1, level = 1 - prev;
    out.push(level, bit ? 1 - level : level);
    prev = out[out.length - 1];
  }
  return invert ? out.map(s => 1 - s) : out;
}

// ---------------------------------------------------------------- MTS01

export interface Mts01Options {
  id: string; counter: number; startMs: number; battMv: number;
  lat: number; lon: number; alt: number; heading: number; speed: number;
  /** Thermistor reading, kilohms. */
  rawT: number; rawRh?: number;
}
export function mts01Frame(o: Mts01Options): Uint8Array {
  const d = new Date(o.startMs), p2 = (v: number) => String(v).padStart(2, '0');
  const dt = `${p2(d.getUTCFullYear() % 100)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  const text = [o.id, '1', `${o.counter}`, dt, `${o.battMv}`, o.lat.toFixed(6), o.lon.toFixed(6), o.alt.toFixed(1),
    o.heading.toFixed(1), o.speed.toFixed(2), '0', o.rawT.toFixed(4), o.rawT.toFixed(4), `${o.rawRh ?? 512}`, '0', '0'].join(',');
  const fb = new Uint8Array(131);
  fb[0] = 0x80;
  for (let i = 0; i < text.length && i < 128; i++) fb[1 + i] = text.charCodeAt(i);
  const crc = mts01Crc(fb, 1, 128);
  fb[129] = crc & 255; fb[130] = crc >> 8;
  return fb;
}
/** MTS01 channel symbols: AA preamble, the header, the frame; NRZ, most significant bit first, '1' = upper tone. */
export function mts01Symbols(frame: ArrayLike<number>, invert = false, preamble = 6): number[] {
  const out: number[] = [];
  const bytes = [...new Array(preamble).fill(0xaa), 0xaa, 0xaa, 0xb4, 0x2b, ...Array.from(frame)];
  for (const b of bytes) for (let k = 7; k >= 0; k--) out.push((b >> k) & 1);
  return invert ? out.map(s => 1 - s) : out;
}

/** The fl24 encoding used above, exported for tests. */
export const dfmFl24Of = (v: number, p: number): number => (p << 20) | Math.round(v * (1 << p));
export { dfmFl24 };

// ---------------------------------------------------------------- IQ

export interface FskSignal { syms: ArrayLike<number>; baud: number; offsetHz: number; dev: number; amp: number }
/**
 * Several 2-FSK signals on one signed int8 IQ buffer of n samples, with Gaussian noise of `sigma` per component. Each
 * signal's frequency is smoothed by a running mean over half a symbol (about GFSK BT 0.5) like fskIq(), but kept in a
 * ring so slow baud rates stay cheap. A signal is plain carrier (symbol 0's tone) once its symbols run out.
 */
export function fskMix(rate: number, n: number, sigs: FskSignal[], sigma: number, seed = 11): Int8Array {
  const acc = new Float64Array(2 * n);
  for (const s of sigs) {
    const sps = rate / s.baud, half = Math.max(1, Math.round(sps / 2));
    const ring = new Float32Array(half);
    let sum = 0, cnt = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / sps);
      const v = k < s.syms.length && s.syms[k] ? 1 : -1;
      const slot = i % half;
      if (cnt === half) sum -= ring[slot]; else cnt++;
      ring[slot] = v; sum += v;
      ph += 2 * Math.PI * (s.offsetHz + s.dev * sum / cnt) / rate;
      if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
      acc[2 * i] += s.amp * Math.cos(ph); acc[2 * i + 1] += s.amp * Math.sin(ph);
    }
  }
  let st = seed >>> 0;
  const uni = () => { st = (st * 1103515245 + 12345) >>> 0; return st / 4294967296; };
  const out = new Int8Array(2 * n);
  for (let i = 0; i < 2 * n; i += 2) {
    const u = Math.max(1e-12, uni()), w = uni(), r = Math.sqrt(-2 * Math.log(u)) * sigma;
    const a = acc[i] + r * Math.cos(2 * Math.PI * w), b = acc[i + 1] + r * Math.sin(2 * Math.PI * w);
    out[i] = Math.max(-127, Math.min(127, Math.round(a)));
    out[i + 1] = Math.max(-127, Math.min(127, Math.round(b)));
  }
  return out;
}
