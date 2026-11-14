/**
 * Meteomodem M10 (and M2K2, M10+) and M20: about 9600 baud 2-FSK, biphase-mark coded (two channel symbols per bit, the
 * level flips at every bit boundary and once more in the middle of a 1), so the FM polarity does not matter. A 32-symbol
 * sync, then the frame, bytes most significant bit first: [length - 1, type, data ..., checksum (big-endian)]. No FEC,
 * no whitening: the 16-bit Meteomodem checksum is the only integrity check, and nothing is reported without it.
 * M10 frames are 101 bytes (Trimble GPS, lat/lon in units of 360/2^32 degrees), M20 frames 70 bytes. The TypeScript twin of
 * core/sonde/M10.kt and M10.swift.
 */
import { gpsDate, type SondeFrame } from './types.js';

/** M10 at 9615 symbols/s, M20 (and the 2025 M10) at 9600: one slicer in the middle tracks both. */
export const M10_BAUD = 9608;
/** The sync as channel symbols (biphase-mark zeros, then the code violations). */
export const M10_HEADER = '11001100110011001010011001001100';
/** The longest frame: the standard M10 frame plus 64 aux bytes. */
export const M10_MAX_BYTES = 0x64 + 64 + 1;
export const M10_SYMS = M10_MAX_BYTES * 16;

/** Type bytes (frame[1]): M2K2, M10 (Trimble), the M10 signal-level frame, M10+ (Gtop), M20. */
const T_M2K2 = 0x8f, T_M10 = 0x9f, T_M10DUB = 0x49, T_M10PLUS = 0xaf, T_M20 = 0x20;

/** One step of the Meteomodem checksum. */
function updateCheckM10(c: number, b0: number): number {
  const c1 = c & 0xff;
  let b = ((b0 >> 1) | ((b0 & 1) << 7)) & 0xff;
  b ^= (b >> 2) & 0xff;
  const t6 = (c & 1) ^ ((c >> 2) & 1) ^ ((c >> 4) & 1);
  const t7 = ((c >> 1) & 1) ^ ((c >> 3) & 1) ^ ((c >> 5) & 1);
  const t = (c & 0x3f) | (t6 << 6) | (t7 << 7);
  let s = (c >> 7) & 0xff;
  s ^= (s >> 2) & 0xff;
  const c0 = (b ^ t ^ s) & 0xff;
  return ((c1 << 8) | c0) & 0xffff;
}
/** The checksum over msg[0 .. len-1]. */
export function checkM10(msg: ArrayLike<number>, len: number): number {
  let cs = 0;
  for (let i = 0; i < len; i++) cs = updateCheckM10(cs, msg[i] & 0xff);
  return cs & 0xffff;
}

const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const bes16 = (b: Uint8Array, p: number) => (be16(b, p) << 16) >> 16;
const be24 = (b: Uint8Array, p: number) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
const be32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const bes32 = (b: Uint8Array, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const le16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const le24 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);

// thermistor fit (both types) and the M10's three ranges: series and parallel resistors
const TP0 = 1.07303516e-03, TP1 = 2.41296733e-04, TP2 = 2.26744154e-06, TP3 = 6.52855181e-08;
const RS = [12.1e3, 36.5e3, 475.0e3], RP = [1e20, 330.0e3, 2000.0e3];

/** The main thermistor's resistance to degrees C (Steinhart-Hart fit). NaN when out of range. */
export function m10TempFromR(R: number): number {
  if (!(R > 0)) return NaN;
  const l = Math.log(R);
  return 1 / (TP0 + TP1 * l + TP2 * l * l + TP3 * l * l * l) - 273.15;
}
/** ADC count (12 bits) and range index to degrees C. NaN when invalid. */
export function m10TempFromAdc(adc: number, scT: number): number {
  if (scT < 0 || scT > 2 || adc <= 0) return NaN;
  const x = (4095 - adc) / adc;
  const R = RS[scT] / (x - RS[scT] / RP[scT]);
  const T = m10TempFromR(R);
  return T < -120 || T > 60 ? NaN : T;
}
/** The M10 humidity sensor's own thermistor (SMD NTC, 22.1 k series). */
export function m10TntcFromAdc(adc: number): number {
  if (adc <= 0 || adc >= 4095) return NaN;
  const x = (4095 - adc) / adc, R = 22.1e3 / x, l = Math.log(R);
  return 1 / (4.42606809e-03 - 6.58184309e-04 * l + 8.95735557e-05 * l * l - 2.84347503e-06 * l * l * l) - 273.15;
}
/** The M20 humidity sensor's thermistor (Beta model). */
export function m20TntcFromAdc(adc: number): number {
  if (adc <= 0 || adc >= 4095) return NaN;
  const x = (4095 - adc) / adc, R = 22.1e3 / x;
  return 1 / (1 / 298.15 + Math.log(R / 2.2e3) / 3650) - 273.15;
}
/** M20 relative humidity from the raw count, its calibration word and the sensor temperature. NaN when invalid. */
export function m20Humidity(humval: number, rhCal: number, tu: number): number {
  const cal = 6.4e8 / (rhCal + 80000);
  let x = (humval + 80000) * cal * (1 - 5.8e-4 * (tu - 25));
  x = 4.16e9 / x;
  x = 10.087 * x * x * x - 211.62 * x * x + 1388.2 * x - 2797.0;
  if (humval >= 48000 || !(x > -20 && x < 120)) return NaN;
  return Math.max(0, Math.min(100, x));
}

/** M10 serial "YMM-T-Nnnnn" from the five raw bytes at 0x5D. */
export function m10Serial(f: Uint8Array, p: number): string {
  const b2 = f[p + 2];
  const w = f[p + 3] | (f[p + 4] << 8);
  return `${((b2 >> 4) & 0xf).toString(16).toUpperCase()}${String(b2 & 0xf).padStart(2, '0')}-` +
    `${(f[p] & 0xf).toString(16).toUpperCase()}-${(w >> 13) & 7}${String(w & 0x1fff).padStart(4, '0')}`;
}
/** M20 serial "YMM-T-Nnnnn" from the 24-bit little-endian word at 0x12 (all zeros: the counter offset is appended). */
export function m20Serial(sn24: number, diffcnt: number): string {
  if (sn24 === 0) return `000-0-00000-${String(diffcnt & 0xff).padStart(3, '0')}`;
  const ym = sn24 & 0x7f, y = Math.floor(ym / 12), m = (ym % 12) + 1;
  return `${y}${String(m).padStart(2, '0')}-${((sn24 >> 7) & 7) + 1}-${(sn24 >> 23) & 1}${String((sn24 >> 10) & 0x1fff).padStart(4, '0')}`;
}

/** Heading in degrees true from east and north speed. */
function headingOf(vE: number, vN: number): number {
  let d = Math.atan2(vE, vN) * 180 / Math.PI;
  if (d < 0) d += 360;
  return d;
}

export class M10Decoder {
  private readonly bits = new Uint8Array(M10_SYMS / 2);
  private readonly fr = new Uint8Array(M10_MAX_BYTES);

  /** Soft symbols right after the sync. Returns null unless the checksum passes. */
  decode(soft: Float32Array): SondeFrame | null {
    const nb = Math.min(this.bits.length, soft.length >> 1);
    for (let k = 0; k < nb; k++) {
      const a = soft[2 * k], b = soft[2 * k + 1];
      this.bits[k] = (a > 0) !== (b > 0) ? 1 : 0;
    }
    const nBytes = nb >> 3, fr = this.fr;
    for (let i = 0; i < nBytes; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | this.bits[8 * i + k];
      fr[i] = v;
    }
    for (let i = nBytes; i < fr.length; i++) fr[i] = 0;
    return this.parse(fr, nBytes);
  }

  /** A frame's bytes (nBytes of them valid). */
  parse(fr: Uint8Array, nBytes = fr.length): SondeFrame | null {
    const type = fr[1];
    // only the type bytes sonde firmware sends (a 16-bit checksum alone lets through one random frame in 65536)
    if (type !== T_M10 && type !== T_M2K2 && type !== T_M10PLUS && type !== T_M10DUB && type !== T_M20) return null;
    const std = type === T_M20 ? 0x45 : 0x64;
    let flen = fr[0];
    if (flen === 0) return null;
    // the length byte must be one a sonde sends: the standard length, a short M20 (0x43) or an M10 with aux data
    if (type === T_M20) { if (flen !== 0x45 && flen !== 0x43) return null; }
    else if (flen < 0x64 || flen > std + 64) return null;
    if (flen + 1 > nBytes) return null;
    const posCheck = flen - 1;
    if (checkM10(fr, posCheck) !== be16(fr, posCheck)) return null;
    if (type === T_M10DUB) return null;      // signal-level frame: nothing for a card
    return type === T_M20 ? this.m20(fr, flen) : this.m10(fr, type, flen);
  }

  private m10(f: Uint8Array, type: number, flen: number): SondeFrame | null {
    const out: SondeFrame = { type: 'M10', serial: 'M10-' + m10Serial(f, 0x5d), frame: f[0x62], fixed: 0 };
    out.model = type === T_M2K2 ? 'M2K2' : type === T_M10PLUS ? 'M10+' : 'M10';
    if (flen > 0x64) out.extra = { 'AUX DATA': `${flen - 0x64} bytes` };
    if (type === T_M10PLUS) {
      // Gtop GPS
      out.lat = bes32(f, 0x04) / 1e6; out.lon = bes32(f, 0x08) / 1e6;
      let a = be24(f, 0x0c); if (a & 0x800000) a -= 0x1000000;
      out.alt = a / 100;
      const vE = bes16(f, 0x0f) / 100, vN = bes16(f, 0x11) / 100;
      out.vH = Math.hypot(vE, vN); out.heading = headingOf(vE, vN); out.climb = bes16(f, 0x13) / 100;
      const t = be24(f, 0x15), d = be24(f, 0x18);
      out.timeS = Math.floor(t / 10000) * 3600 + Math.floor((t % 10000) / 100) * 60 + (t % 100);
      const y = 2000 + (d % 100), mo = Math.floor((d % 10000) / 100), dd = Math.floor(d / 10000);
      if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) out.date = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    } else {
      // Trimble GPS
      let week = be16(f, 0x20);
      const towMs = be32(f, 0x0a);
      const gpsSec = Math.floor(towMs / 1000);
      const day = Math.floor(gpsSec / 86400);
      if (week <= 4000 && day >= 0 && day <= 6) {
        if (week < 1304) week += 1024;
        const B60B60 = (1 << 30) / 90.0;
        out.lat = bes32(f, 0x0e) / B60B60; out.lon = bes32(f, 0x12) / B60B60; out.alt = bes32(f, 0x16) / 1000;
        const vE = bes16(f, 0x04) / 200, vN = bes16(f, 0x06) / 200;
        out.vH = Math.hypot(vE, vN); out.heading = headingOf(vE, vN); out.climb = bes16(f, 0x08) / 200;
        out.sats = f[0x1e];
        const leap = f[0x1f];
        let utcWeek = week, utc = gpsSec - leap;
        if (utc < 0) { utcWeek -= 1; utc += 604800; }
        out.timeS = (utc % 86400) + (towMs % 1000) / 1000;
        out.date = gpsDate(utcWeek, utc);
        out.extra = { ...out.extra, 'GPS WEEK': `${week}` };
        if (f[0x1d] & 1) out.extra['GPS FIX'] = 'none';
        else out.extra['GPS FIX'] = f[0x1d] & 4 ? '2D' : '3D';
      }
    }
    // PTU
    const scT = f[0x3e], adc = le16(f, 0x3f) - 0xa000;
    const T = m10TempFromAdc(adc, scT);
    if (Number.isFinite(T)) {
      out.tempC = T;
      const c55 = le24(f, 0x32) / 1000, cRh = le24(f, 0x35) / 1000;
      if (c55 > 0) {
        let rh = (cRh / c55 - 0.8955) / 0.002;
        if (T < 0) rh += 0 - T / 5.5;
        if (T < -30) rh *= 1 + (-30 - T) / 75;
        out.rh = Math.max(0, Math.min(100, rh));
      }
    }
    const tu = m10TntcFromAdc(le16(f, 0x59));
    if (Number.isFinite(tu) && tu > -120 && tu < 80) out.tHumC = tu;
    const bat = le16(f, 0x45);
    out.battV = 2.709 * bat * 2.5 / 1023;
    return out;
  }

  private m20(f: Uint8Array, flen: number): SondeFrame | null {
    const sn24 = le24(f, 0x12);
    const cnt = f[0x15];
    let week = be16(f, 0x1a);
    const tow = be24(f, 0x0f);
    const out: SondeFrame = { type: 'M20', model: 'M20', serial: '', frame: cnt, fixed: 0 };
    if (week <= 4000 && tow < 604800) {
      if (week < 1304) week += 1024;
      out.lat = bes32(f, 0x1c) / 1e6; out.lon = bes32(f, 0x20) / 1e6; out.alt = be24(f, 0x08) / 100;
      const vE = bes16(f, 0x0b) / 100, vN = bes16(f, 0x0d) / 100;
      out.vH = Math.hypot(vE, vN); out.heading = headingOf(vE, vN); out.climb = bes16(f, 0x18) / 100;
      out.timeS = tow % 86400;          // GPS time, as auto_rx reports it
      out.date = gpsDate(week, tow);
      out.extra = { 'GPS WEEK': `${week}` };
    }
    out.serial = 'M20-' + m20Serial(sn24, (tow & 0xff) - cnt);
    let fw = f[flen - 2]; if (fw > 0x20) fw = 0;
    out.extra = { ...out.extra, FIRMWARE: `0x${fw.toString(16).padStart(2, '0')}` };
    // temperature: the range is coded in the ADC value
    let adc = le16(f, 0x04), scT = 0;
    if (adc > 8191) { scT = 2; adc -= 8192; } else if (adc > 4095) { scT = 1; adc -= 4096; }
    const T = m10TempFromAdc(adc, scT);
    if (Number.isFinite(T)) out.tempC = T;
    const tu = m20TntcFromAdc(le16(f, 0x06));
    if (Number.isFinite(tu) && tu > -120 && tu < 80) {
      out.tHumC = tu;
      const rh = m20Humidity(le16(f, 0x02), le16(f, 0x2f), tu);
      if (Number.isFinite(rh)) out.rh = rh;
    }
    if (flen >= 0x45) {
      const p0 = fw >= 0x07 ? f[0x16] : 0;
      const val = ((le16(f, 0x24) << 8) | p0) >>> 0;
      if (val > 0) { const hPa = val / 4096; if (hPa < 2560) out.hPa = hPa; }
    }
    out.battV = f[0x26] * 3.3 / 255;
    return out;
  }
}
