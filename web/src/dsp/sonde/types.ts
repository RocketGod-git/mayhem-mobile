/**
 * Radiosondes: what every decoder reports, and the bit framer they share. The TypeScript twin of
 * core/sonde/SondeTypes.kt and SondeTypes.swift.
 */

/** One decoded frame from one sonde. Fields a type does not carry stay undefined. */
export interface SondeFrame {
  /** The family shown on the card: "RS41", "M10", "DFM-09" ... */
  type: string;
  /** The model when the sonde says more than the family (RS41-SGP, DFM-17, iMet-4 ...). */
  model?: string;
  serial: string;
  frame?: number;
  /** GPS time of day, UTC, seconds since midnight. */
  timeS?: number;
  /** Date as YYYY-MM-DD, when the type sends it. */
  date?: string;
  lat?: number; lon?: number;
  /** Meters above the WGS84 ellipsoid (or mean sea level for the types that send that). */
  alt?: number;
  /** Ground speed m/s, heading degrees true, climb m/s (negative descending). */
  vH?: number; heading?: number; climb?: number;
  sats?: number;
  tempC?: number; rh?: number; hPa?: number;
  /** Humidity sensor temperature (RS41). */
  tHumC?: number;
  battV?: number;
  /** Burst/kill timer, seconds left, when the sonde reports one. */
  killS?: number;
  /** Transmit frequency the sonde reports for itself, kHz. */
  txKHz?: number;
  /** Bytes or bits the error correction repaired (0 = clean). */
  fixed?: number;
  /** Anything else worth a line on the detail card, by label. */
  extra?: Record<string, string>;
}

export type SondeSink = (f: SondeFrame) => void;

/**
 * A symbol-rate bit slicer on the FM discriminator, with a sync-word search in both FM polarities. Once the header
 * matches it collects `frameSyms` more channel symbols and hands them over (soft values: the integrated
 * discriminator per symbol, positive = the header's 1), then goes back to searching.
 */
export class FskFramer {
  private readonly inc: number;
  private phase = 0; private acc = 0; private lastPos = false; private first = true;
  /** The last symbols, newest in bit 0 of lo; up to 64 in two 32-bit words. */
  private hi = 0; private lo = 0; private shN = 0;
  private readonly hHi: number; private readonly hLo: number; private readonly mHi: number; private readonly mLo: number;
  private collecting = 0; private inv = false;
  private buf: Float32Array; private n = 0;
  /** Running mean of |soft| for scaling; also the DC the slicer is centered on. */
  private dc = 0;
  constructor(
    readonly baud: number, rate: number, header: string, readonly frameSyms: number,
    private readonly maxErr: number,
    private readonly onFrame: (soft: Float32Array, headerErrs: number) => void,
    private readonly gain = 0.2,
  ) {
    this.inc = baud / rate;
    if (header.length > 64) throw new Error('sync word over 64 symbols');
    this.hdrLen = header.length;
    let hh = 0, hl = 0;
    for (const c of header) { hh = ((hh << 1) | (hl >>> 31)) >>> 0; hl = ((hl << 1) | (c === '1' ? 1 : 0)) >>> 0; }
    this.hHi = hh; this.hLo = hl;
    const n = header.length;
    this.mLo = n >= 32 ? 0xffffffff : ((1 << n) >>> 0) - 1;
    this.mHi = n >= 64 ? 0xffffffff : n > 32 ? ((1 << (n - 32)) >>> 0) - 1 : 0;
    this.buf = new Float32Array(frameSyms);
  }
  readonly hdrLen: number;
  reset(): void { this.phase = 0; this.acc = 0; this.first = true; this.hi = 0; this.lo = 0; this.shN = 0; this.collecting = 0; this.n = 0; }
  /** One discriminator sample. */
  push(x: number): void {
    // the slicer's center follows the carrier between frames, and holds still inside one (long runs of one
    // symbol, like MTS01's padding, would drag it off)
    if (this.collecting === 0) this.dc += (x - this.dc) * 0.0005;
    const v = x - this.dc;
    const pos = v > 0;
    if (!this.first && pos !== this.lastPos) {
      const err = this.phase < 0.5 ? this.phase : this.phase - 1;
      this.phase -= err * this.gain;
    }
    this.first = false; this.lastPos = pos;
    this.acc += v;
    this.phase += this.inc;
    if (this.phase < 1) return;
    this.phase -= 1;
    const s = this.acc; this.acc = 0;
    this.symbol(s);
  }
  private symbol(s: number): void {
    if (this.collecting > 0) {
      this.buf[this.n++] = this.inv ? -s : s;
      if (--this.collecting === 0) this.onFrame(this.buf.slice(0, this.n), this.lastErrs);
      return;
    }
    this.hi = (((this.hi << 1) | (this.lo >>> 31)) & this.mHi) >>> 0;
    this.lo = (((this.lo << 1) | (s > 0 ? 1 : 0)) & this.mLo) >>> 0;
    if (++this.shN < this.hdrLen) return;
    const dh = (this.hi ^ this.hHi) >>> 0, dl = (this.lo ^ this.hLo) >>> 0;
    const e = popcount32(dh) + popcount32(dl);
    const ei = this.hdrLen - e;
    if (e <= this.maxErr || ei <= this.maxErr) {
      this.inv = ei < e; this.lastErrs = Math.min(e, ei);
      this.collecting = this.frameSyms; this.n = 0; this.shN = 0;
    }
  }
  private lastErrs = 0;
}

function popcount32(x: number): number {
  x = x >>> 0; x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hard bits out of soft symbols. */
export const hard = (s: Float32Array): Uint8Array => Uint8Array.from(s, v => (v > 0 ? 1 : 0));

/** Manchester pairs to bits: a pair (a, b) is 1 when a > b (the "10" = 1 convention) unless `zeroFirst`. */
export function manchester(s: Float32Array, start: number, nBits: number, oneIsHighLow = true): Uint8Array {
  const out = new Uint8Array(nBits);
  for (let k = 0; k < nBits; k++) {
    const a = s[start + 2 * k], b = s[start + 2 * k + 1];
    out[k] = (a > b) === oneIsHighLow ? 1 : 0;
  }
  return out;
}

/** Bytes from bits, least significant bit first (RS41, RS92) or most significant first. */
export function bytesOf(bits: ArrayLike<number>, start: number, nBytes: number, lsbFirst: boolean): Uint8Array {
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) { const b = bits[start + 8 * i + k] & 1; v |= lsbFirst ? b << k : b << (7 - k); }
    out[i] = v;
  }
  return out;
}

/** WGS84 ECEF (meters) to latitude, longitude (degrees) and height above the ellipsoid. */
export function ecefToGeo(x: number, y: number, z: number): { lat: number; lon: number; alt: number } {
  const a = 6378137.0, b = 6356752.31424518, e2 = (a * a - b * b) / (a * a), ee2 = (a * a - b * b) / (b * b);
  const lon = Math.atan2(y, x), p = Math.hypot(x, y), t = Math.atan2(z * a, p * b);
  const st = Math.sin(t), ct = Math.cos(t);
  const lat = Math.atan2(z + ee2 * b * st * st * st, p - e2 * a * ct * ct * ct);
  const R = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI, alt: p / Math.cos(lat) - R };
}
/** Latitude, longitude, height to ECEF (for the test encoders). */
export function geoToEcef(latD: number, lonD: number, h: number): [number, number, number] {
  const a = 6378137.0, b = 6356752.31424518, e2 = (a * a - b * b) / (a * a);
  const la = latD * Math.PI / 180, lo = lonD * Math.PI / 180, N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + h) * Math.sin(la)];
}
/** ECEF velocity to ground speed, heading and climb at a position. */
export function ecefVelToNeu(vx: number, vy: number, vz: number, latD: number, lonD: number): { vH: number; heading: number; climb: number } {
  const la = latD * Math.PI / 180, lo = lonD * Math.PI / 180;
  const vN = -vx * Math.sin(la) * Math.cos(lo) - vy * Math.sin(la) * Math.sin(lo) + vz * Math.cos(la);
  const vE = -vx * Math.sin(lo) + vy * Math.cos(lo);
  const vU = vx * Math.cos(la) * Math.cos(lo) + vy * Math.cos(la) * Math.sin(lo) + vz * Math.sin(la);
  let hd = Math.atan2(vE, vN) * 180 / Math.PI; if (hd < 0) hd += 360;
  return { vH: Math.hypot(vN, vE), heading: hd, climb: vU };
}
export function neuToEcefVel(vN: number, vE: number, vU: number, latD: number, lonD: number): [number, number, number] {
  const la = latD * Math.PI / 180, lo = lonD * Math.PI / 180;
  return [
    -vN * Math.sin(la) * Math.cos(lo) - vE * Math.sin(lo) + vU * Math.cos(la) * Math.cos(lo),
    -vN * Math.sin(la) * Math.sin(lo) + vE * Math.cos(lo) + vU * Math.cos(la) * Math.sin(lo),
    vN * Math.cos(la) + vU * Math.sin(la)];
}
/** GPS week + seconds of week to a date string (no leap seconds: the date only). */
export function gpsDate(week: number, tow: number): string {
  const ms = Date.UTC(1980, 0, 6) + (week * 7 * 86400 + Math.floor(tow)) * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}
