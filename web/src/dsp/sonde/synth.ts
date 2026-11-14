/**
 * Test signals for the sonde decoders: frames built the way each sonde builds them, and an FSK modulator that puts
 * channel symbols on raw IQ. Used by the tests only. The TypeScript twin of the Kotlin and Swift test helpers.
 */
import { crc16ccitt } from './rs.js';
import { RS41_HEADER_BYTES, RS41_MASK, rs41Parity } from './rs41.js';
import { geoToEcef, neuToEcefVel } from './types.js';

/** A small deterministic generator (tests must repeat). */
export class Prng {
  constructor(private s = 12345) {}
  /** mulberry32: an LCG's low bits repeat and put false carriers in the test noise. */
  next(): number { let t = (this.s = (this.s + 0x6d2b79f5) >>> 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  gauss(): number { const u = Math.max(1e-12, this.next()), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}

/**
 * Channel symbols (0/1) as 2-FSK on signed int8 IQ: `dev` Hz either side of `offsetHz`, a raised-cosine-smoothed
 * frequency (about GFSK BT 0.5), `snrDb` in the symbol bandwidth. `lead` seconds of carrier before and after.
 */
export function fskIq(syms: ArrayLike<number>, baud: number, rate: number, offsetHz: number, dev: number, snrDb = 30, lead = 0.05, rng = new Prng(7), amp = 60): Int8Array {
  const sps = rate / baud, leadN = Math.round(lead * rate);
  const n = Math.ceil(syms.length * sps) + 2 * leadN;
  const out = new Int8Array(2 * n);
  const noise = amp * Math.pow(10, -snrDb / 20) * Math.sqrt(rate / baud) / Math.SQRT2;
  let ph = 0;
  const half = Math.max(1, Math.round(sps / 2));
  // a running mean over half a symbol smooths the frequency steps
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.floor((i - leadN) / sps);
    f[i] = k < 0 || k >= syms.length ? -1 : syms[k] ? 1 : -1;
  }
  let acc = 0; const q: number[] = [];
  for (let i = 0; i < n; i++) {
    q.push(f[i]); acc += f[i]; if (q.length > half) acc -= q.shift()!;
    const fr = offsetHz + dev * acc / q.length;
    ph += 2 * Math.PI * fr / rate;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    const i0 = amp * Math.cos(ph) + noise * rng.gauss(), q0 = amp * Math.sin(ph) + noise * rng.gauss();
    out[2 * i] = Math.max(-127, Math.min(127, Math.round(i0)));
    out[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(q0)));
  }
  return out;
}

/** Plain noise IQ (a gap between transmissions). */
export function noiseIq(n: number, sigma = 2, rng = new Prng(9)): Int8Array {
  const out = new Int8Array(2 * n);
  for (let i = 0; i < 2 * n; i++) out[i] = Math.max(-127, Math.min(127, Math.round(sigma * rng.gauss())));
  return out;
}

/** Bits of bytes, least or most significant first. */
export function bitsOf(bytes: ArrayLike<number>, lsbFirst: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) for (let k = 0; k < 8; k++) out.push(lsbFirst ? (bytes[i] >> k) & 1 : (bytes[i] >> (7 - k)) & 1);
  return out;
}
export const manchesterOf = (bits: ArrayLike<number>, oneIsHighLow = true): number[] => { const o: number[] = []; for (let i = 0; i < bits.length; i++) { const b = bits[i] ? 1 : 0; o.push(oneIsHighLow ? b : 1 - b, oneIsHighLow ? 1 - b : b); } return o; };

export interface FlightPoint { lat: number; lon: number; alt: number; vN: number; vE: number; vU: number }

const put16 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; };
const put24 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; b[p + 2] = (v >> 16) & 255; };
const put32 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; b[p + 2] = (v >> 16) & 255; b[p + 3] = (v >>> 24) & 255; };
const putF = (b: Uint8Array, p: number, v: number) => { const d = new DataView(b.buffer, b.byteOffset); d.setFloat32(p, v, true); };

/** An RS41 calibration table whose sensors read `tempC` (and a fixed humidity reading), with a burst timer. */
export function rs41CalTable(model = 'RS41-SG', txKHz = 403_000, killS = 0x7788): Uint8Array {
  const c = new Uint8Array(51 * 16);
  // subframe 0: frequency (40 kHz steps + quarter steps)
  const k = txKHz - 400_000; c[3] = Math.floor(k / 40); c[2] = Math.round((k % 40) / 10) * 64 & 0xc0;
  put16(c, 16 + 5, 0x5139);                 // subframe 1: firmware
  c[2 * 16 + 11] = 1;                       // subframe 2: burst kill on
  putF(c, 61, 750); putF(c, 65, 1100);      // reference resistors
  putF(c, 77, -243.9108); putF(c, 81, 0.187654); putF(c, 85, 8.2e-6);   // PT1000 polynomial
  putF(c, 89, 1); putF(c, 93, 0); putF(c, 97, 0);
  putF(c, 117, 46.5); putF(c, 121, 0.0);
  putF(c, 293, -243.9108); putF(c, 297, 0.187654); putF(c, 301, 8.2e-6);
  putF(c, 305, 1); putF(c, 309, 0); putF(c, 313, 0);
  for (let i = 0; i < 8 && i < model.length; i++) c[0x21 * 16 + 8 + i] = model.charCodeAt(i);
  put16(c, 0x32 * 16, killS);
  return c;
}
/** The measurement count a PT1000 at tempC gives with this table (gain 100 counts per ohm). */
export function rs41TempCounts(tempC: number): [number, number, number] {
  // solve -243.9108 + 0.187654 R + 8.2e-6 R^2 = T
  const a = 8.2e-6, b = 0.187654, cc = -243.9108 - tempC, R = (-b + Math.sqrt(b * b - 4 * a * cc)) / (2 * a);
  return [Math.round(R * 100), 75_000, 110_000];
}

/** One RS41 frame (320 bytes, de-whitened, parity filled). */
export function rs41Frame(serial: string, frame: number, p: FlightPoint, cal: Uint8Array, tempC: number, gps: { week: number; towMs: number }, battV = 2.9): Uint8Array {
  const fr = new Uint8Array(518);
  fr.set(RS41_HEADER_BYTES, 0);
  fr[0x38] = 0x0f;
  const block = (pos: number, id: number, len: number, fill: (d: number) => void) => {
    fr[pos] = id; fr[pos + 1] = len; fill(pos + 2);
    put16(fr, pos + 2 + len, crc16ccitt(fr, pos + 2, len));
  };
  block(0x39, 0x79, 0x28, d => {
    put16(fr, d, frame);
    for (let i = 0; i < 8; i++) fr[d + 2 + i] = serial.charCodeAt(i);
    fr[d + 10] = Math.round(battV * 10);
    const sub = frame % 51; fr[d + 23] = sub;
    for (let i = 0; i < 16; i++) fr[d + 24 + i] = cal[sub * 16 + i];
  });
  block(0x65, 0x7a, 0x2a, d => {
    const [f, f1, f2] = rs41TempCounts(tempC);
    put24(fr, d, f); put24(fr, d + 3, f1); put24(fr, d + 6, f2);
    put24(fr, d + 9, 520_000); put24(fr, d + 12, 500_000); put24(fr, d + 15, 600_000);
    const [g, g1, g2] = rs41TempCounts(tempC + 3);
    put24(fr, d + 18, g); put24(fr, d + 21, g1); put24(fr, d + 24, g2);
  });
  block(0x93, 0x7c, 0x1e, d => { put16(fr, d, gps.week); put32(fr, d + 2, gps.towMs); });
  block(0xb5, 0x7d, 0x59, () => undefined);
  block(0x112, 0x7b, 0x15, d => {
    const [x, y, z] = geoToEcef(p.lat, p.lon, p.alt), [vx, vy, vz] = neuToEcefVel(p.vN, p.vE, p.vU, p.lat, p.lon);
    put32(fr, d, Math.round(x * 100)); put32(fr, d + 4, Math.round(y * 100)); put32(fr, d + 8, Math.round(z * 100));
    put16(fr, d + 12, Math.round(vx * 100)); put16(fr, d + 14, Math.round(vy * 100)); put16(fr, d + 16, Math.round(vz * 100));
    fr[d + 18] = 9; fr[d + 19] = 25; fr[d + 20] = 14;
  });
  block(0x12b, 0x76, 0x11, () => undefined);
  rs41Parity(fr);
  return fr.slice(0, 320);
}
/** The channel symbols an RS41 sends for a frame: the header, then the whitened bytes, LSB first. */
export function rs41Symbols(fr: Uint8Array): number[] {
  const x = new Uint8Array(fr.length);
  for (let i = 0; i < fr.length; i++) x[i] = fr[i] ^ RS41_MASK[i % 64];
  return bitsOf(x, true);
}
