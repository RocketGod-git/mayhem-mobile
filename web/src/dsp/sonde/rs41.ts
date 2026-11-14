/**
 * Vaisala RS41 (SG, SGP, SGM, NG): 4800 baud GFSK, bytes sent least significant bit first, whitened with a 64-byte
 * mask, 8 sync bytes then 312 (or 510 with extra data) bytes protected by two interleaved RS(255,231) codewords.
 * The body is a chain of blocks [id, length, data, CRC16]: status (serial, frame, battery and one 16-byte slice of the
 * calibration table), PTU, GPS time, raw GPS, GPS position/velocity, aux. Temperature, humidity and pressure need the
 * calibration table, which arrives one slice per frame (51 slices, under a minute).
 */
import { RS_VAISALA, crc16ccitt } from './rs.js';
import { bytesOf, ecefToGeo, ecefVelToNeu, gpsDate, type SondeFrame } from './types.js';

export const RS41_BAUD = 4800;
export const RS41_HEADER = '0000100001101101010100111000100001000100011010010100100000011111';
export const RS41_HEADER_BYTES = [0x86, 0x35, 0xf4, 0x40, 0x93, 0xdf, 0x1a, 0x60];
export const RS41_MASK = [0x96, 0x83, 0x3E, 0x51, 0xB1, 0x49, 0x08, 0x98, 0x32, 0x05, 0x59, 0x0E, 0xF9, 0x44, 0xC6, 0x26,
  0x21, 0x60, 0xC2, 0xEA, 0x79, 0x5D, 0x6D, 0xA1, 0x54, 0x69, 0x47, 0x0C, 0xDC, 0xE8, 0x5C, 0xF1,
  0xF7, 0x76, 0x82, 0x7F, 0x07, 0x99, 0xA2, 0x2C, 0x93, 0x7C, 0x30, 0x63, 0xF5, 0x10, 0x2E, 0x61,
  0xD0, 0xBC, 0xB4, 0xB6, 0x06, 0xAA, 0xF4, 0x23, 0x78, 0x6E, 0x3B, 0xAE, 0xBF, 0x7B, 0x4C, 0xC1];
export const RS41_LEN = 320, RS41_XLEN = 518;
/** Channel symbols after the 64-bit header for the longest frame. */
export const RS41_SYMS = (RS41_XLEN - 8) * 8;

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const i16 = (b: Uint8Array, p: number) => (u16(b, p) << 16) >> 16;
const u24 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const i32 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
const dv = new DataView(new ArrayBuffer(4));
const f32 = (b: Uint8Array, p: number) => { for (let k = 0; k < 4; k++) dv.setUint8(k, b[p + k]); return dv.getFloat32(0, true); };

/** The calibration table of one sonde, slice by slice. */
class Rs41Cal {
  readonly bytes = new Uint8Array(51 * 16);
  readonly have = new Uint8Array(51);
  count = 0;
  model = ''; killS?: number; burstArmed?: boolean; txKHz?: number; fw?: number;
  set(i: number, data: Uint8Array, p: number): void {
    if (i > 50) return;
    for (let k = 0; k < 16; k++) this.bytes[i * 16 + k] = data[p + k];
    if (!this.have[i]) { this.have[i] = 1; this.count++; }
  }
  all(...ix: number[]): boolean { return ix.every(i => this.have[i] === 1); }
  f(p: number): number { return f32(this.bytes, p); }
}

/** Packet ids (high byte of the block id word). */
const ID_STATUS = 0x79, ID_PTU = 0x7a, ID_GPSTIME = 0x7c, ID_GPSRAW = 0x7d, ID_GPSPOS = 0x7b, ID_ZERO = 0x76,
  ID_AUX = 0x7e, ID_SGM_TU = 0x7f, ID_CRYPT = 0x80, ID_POSDATETIME = 0x82, ID_SATS = 0x83;

export class Rs41Decoder {
  private readonly cals = new Map<string, Rs41Cal>();
  /** Decode one frame's soft symbols (after the header). Returns null when nothing in it checks out. */
  decode(soft: Float32Array): SondeFrame | null {
    const bits = Uint8Array.from(soft, v => (v > 0 ? 1 : 0));
    const fr = new Uint8Array(RS41_XLEN);
    fr.set(RS41_HEADER_BYTES, 0);
    const body = bytesOf(bits, 0, RS41_XLEN - 8, true);
    for (let i = 8; i < RS41_XLEN; i++) fr[i] = body[i - 8] ^ RS41_MASK[i % 64];
    return this.parse(fr);
  }

  /** A de-whitened frame, header included. */
  parse(fr: Uint8Array): SondeFrame | null {
    // 0x0F: 320 bytes, 0xF0: 518 (with aux data); vote the nibbles in case of bit errors
    const b = fr[0x38]; let ft = 0; for (let i = 0; i < 4; i++) ft += ((b >> i) & 1) - ((b >> (i + 4)) & 1);
    const len = ft >= 0 ? RS41_LEN : RS41_XLEN;
    for (let i = len; i < RS41_XLEN; i++) fr[i] = 0;
    const fixed = rs41Ecc(fr);
    const out: SondeFrame = { type: 'RS41', serial: '' };
    if (fixed >= 0) out.fixed = fixed;
    let pos = 0x39, sawStatus = false, cal: Rs41Cal | null = null, meas: number[] | null = null, pTemp = 0, encrypted = false;
    let ecef: number[] | null = null;
    while (pos + 4 <= len) {
      const id = fr[pos], bl = fr[pos + 1];
      if (pos + 2 + bl + 2 > len) break;
      const crcOk = crc16ccitt(fr, pos + 2, bl) === u16(fr, pos + 2 + bl);
      const d = pos + 2;
      if (crcOk) {
        switch (id) {
          case ID_STATUS: {
            let s = ''; for (let k = 0; k < 8; k++) { const c = fr[d + 2 + k]; if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c); }
            if (s.length < 8) return null;
            out.serial = s; out.frame = u16(fr, d);
            out.battV = fr[d + 10] / 10;
            cal = this.cals.get(s) ?? new Rs41Cal();
            if (!this.cals.has(s)) { this.cals.set(s, cal); if (this.cals.size > 64) this.cals.delete(this.cals.keys().next().value!); }
            const sub = fr[d + 23];
            cal.set(sub, fr, d + 24);
            this.subframe(cal, sub, fr, d + 24);
            sawStatus = true;
            break;
          }
          case ID_PTU: meas = []; for (let k = 0; k < 12; k++) meas.push(u24(fr, d + 3 * k)); pTemp = bl >= 40 ? i16(fr, d + 38) : 0; break;
          case ID_SGM_TU: meas = []; for (let k = 0; k < Math.floor(bl / 3); k++) meas.push(u24(fr, d + 3 * k)); break;
          case ID_GPSTIME: {
            const week = u16(fr, d), tow = (i32(fr, d + 2) >>> 0) / 1000;
            out.timeS = tow % 86400; out.date = gpsDate(week, tow);
            out.extra = { ...out.extra, 'GPS WEEK': `${week}` };
            break;
          }
          case ID_GPSPOS: ecef = [i32(fr, d) / 100, i32(fr, d + 4) / 100, i32(fr, d + 8) / 100, i16(fr, d + 12) / 100, i16(fr, d + 14) / 100, i16(fr, d + 16) / 100];
            out.sats = fr[d + 18];
            out.extra = { ...out.extra, 'POSITION ACCURACY': `${fr[d + 19] / 10} m`, PDOP: `${(fr[d + 20] / 10).toFixed(1)}` };
            break;
          case ID_POSDATETIME: if (bl >= 26) {
            ecef = [i32(fr, d) / 100, i32(fr, d + 4) / 100, i32(fr, d + 8) / 100, i16(fr, d + 12) / 100, i16(fr, d + 14) / 100, i16(fr, d + 16) / 100];
            const y = u16(fr, d + 18), mo = fr[d + 20], dd = fr[d + 21];
            out.date = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
            out.timeS = fr[d + 22] * 3600 + fr[d + 23] * 60 + fr[d + 24] + (fr[d + 25] < 100 ? fr[d + 25] / 100 : 0);
          } break;
          case ID_CRYPT: encrypted = true; break;
          case ID_AUX: {
            let s = ''; for (let k = 0; k < bl; k++) { const c = fr[d + k]; if (c > 0x1e && c < 0x7f) s += String.fromCharCode(c); }
            if (s) out.extra = { ...out.extra, 'AUX DATA': s.length > 40 ? s.slice(0, 40) + '…' : s };
            if (/^0[15]/.test(s)) out.extra = { ...out.extra, AUX: s.startsWith('01') ? 'ozone (OIF411)' : 'ozone (ECC)' };
            break;
          }
          case ID_ZERO: case ID_GPSRAW: case ID_SATS: break;
        }
      }
      pos += 2 + bl + 2;
      if (id === ID_ZERO && !crcOk) break;
    }
    if (!sawStatus) return null;
    if (ecef) {
      const g = ecefToGeo(ecef[0], ecef[1], ecef[2]);
      if (g.alt > -1000 && g.alt < 80000 && (ecef[0] || ecef[1] || ecef[2])) {
        out.lat = g.lat; out.lon = g.lon; out.alt = g.alt;
        const v = ecefVelToNeu(ecef[3], ecef[4], ecef[5], g.lat, g.lon);
        out.vH = v.vH; out.heading = v.heading; out.climb = v.climb;
      }
    }
    if (cal) {
      out.model = cal.model || undefined;
      if (cal.killS !== undefined) out.killS = cal.killS;
      if (cal.txKHz) out.txKHz = cal.txKHz;
      if (cal.burstArmed !== undefined) out.extra = { ...out.extra, 'BURST KILL': cal.burstArmed ? 'armed' : 'off' };
      if (cal.fw) out.extra = { ...out.extra, FIRMWARE: `0x${cal.fw.toString(16)}` };
      out.extra = { ...out.extra, CALIBRATION: `${cal.count}/51` };
      if (meas) this.ptu(cal, meas, pTemp, out);
    }
    if (encrypted) { out.model = 'RS41-SGM'; out.extra = { ...out.extra, ENCRYPTED: 'yes (military): no position' }; }
    return out;
  }

  private subframe(cal: Rs41Cal, sub: number, fr: Uint8Array, p: number): void {
    switch (sub) {
      case 0x00: cal.txKHz = 400000 + 40 * fr[p + 3] + Math.floor(((fr[p + 2] & 0xc0) * 10) / 64); break;
      case 0x01: cal.fw = u16(fr, p + 5); break;
      case 0x02: cal.burstArmed = fr[p + 11] !== 0; break;
      case 0x21: case 0x22: {
        const c = cal.bytes, t: string[] = [];
        if (!cal.have[0x21]) break;
        for (let k = 0; k < 8; k++) { const ch = c[0x21 * 16 + 8 + k]; if (ch >= 0x20 && ch < 0x7f) t.push(String.fromCharCode(ch)); else break; }
        if (cal.have[0x22] && t.length === 8) { const ch = c[0x22 * 16]; if (ch >= 0x20 && ch < 0x7f) t.push(String.fromCharCode(ch)); }
        const m = t.join('').trim();
        if (m.startsWith('RS41')) cal.model = m;
        break;
      }
      case 0x32: { const cd = u16(fr, p); cal.killS = cd !== 0xffff ? cd : undefined; break; }
    }
  }

  /** Temperature, humidity and pressure from the measurement block and whatever calibration has arrived. */
  private ptu(cal: Rs41Cal, m: number[], pTemp: number, out: SondeFrame): void {
    const c = cal;
    const Rf1 = c.f(61), Rf2 = c.f(65);
    const temp = (f: number, f1: number, f2: number, co: number, ct: number): number => {
      const g = (f2 - f1) / (Rf2 - Rf1), Rb = (f1 * Rf2 - f2 * Rf1) / (f2 - f1), Rc = f / g - Rb, R = Rc * c.f(ct);
      return (c.f(co) + c.f(co + 4) * R + c.f(co + 8) * R * R + c.f(ct + 4)) * (1 + c.f(ct + 8));
    };
    let T = NaN, TH = NaN, P = NaN;
    if (c.all(3, 4, 5, 6) && m[2] !== m[1]) T = temp(m[0], m[1], m[2], 77, 89);
    if (c.all(3, 4, 0x12, 0x13) && m[8] !== m[7]) TH = temp(m[6], m[7], m[8], 293, 305);
    if (Number.isFinite(T) && T > -120 && T < 70) out.tempC = T;
    if (Number.isFinite(TH) && TH > -120 && TH < 70) out.tHumC = TH;
    // pressure: the optional sensor (RS41-SGP), a 6x4 polynomial
    if (m.length >= 12 && c.all(0x21, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a) && c.bytes[0x21f] === 0x50 && m[11] !== m[10] && m[9] !== m[10]) {
      const calP = new Float64Array(25);
      const at = [606, 610, 614, 618, 622, 626, 630, 634, 638, 642, 646, 650, 654, 658, 662, 666, 670, 674];
      const ix = [0, 4, 8, 12, 16, 20, 24, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11];
      for (let k = 0; k < at.length; k++) calP[ix[k]] = c.f(at[k]);
      const a0 = calP[24] / ((m[9] - m[10]) / (m[11] - m[10])), a1 = pTemp * 0.01;
      let p = 0, a0j = 1;
      for (let j = 0; j < 6; j++) { let a1k = 1; for (let k = 0; k < 4; k++) { p += a0j * a1k * calP[j * 4 + k]; a1k *= a1; } a0j *= a0; }
      if (p > 0 && p < 1100) { P = p; out.hPa = p; }
      if (!out.model || out.model === 'RS41-SG') out.model = 'RS41-SGP';
    }
    if (!Number.isFinite(T)) return;
    // humidity: the full capacitance model once its tables are in, the simple one before
    const fh = (m[3] - m[4]) / (m[5] - m[4]);
    const tablesH = c.all(7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e);
    let rh = NaN;
    if (tablesH && Number.isFinite(TH)) {
      const Pa = Number.isFinite(P) ? P : out.alt !== undefined ? stdPressure(out.alt) : -1;
      const cap = c.f(69) + (c.f(73) - c.f(69)) * fh;
      let Cp = (cap / c.f(117) - 1) * c.f(121);
      const tp = (TH - 20) / 180, bk = [1, 0, 0, 0, 0, 0]; for (let k = 1; k < 6; k++) bk[k] = bk[k - 1] * tp;
      if (Pa > 0) {
        const pb = Pa / 1000; let cpj = 1, corr = 0;
        for (let j = 0; j < 3; j++) {
          const h = c.f(678 + 4 * j), bp = h * (pb / (1 + h * pb) - cpj / (1 + h));
          let bt = 0; for (let k = 0; k < 4; k++) bt += c.f(698 + 4 * (4 * j + k)) * bk[k];
          corr += bp * bt; cpj *= Cp;
        }
        Cp -= corr;
      }
      let r = 0, aj = 1;
      for (let j = 0; j < 7; j++) { for (let k = 0; k < 6; k++) r += aj * bk[k] * c.f(125 + 4 * (6 * j + k)); aj *= Cp; }
      if (Pa <= 0 && T < -40) r += (T + 40) / 12;
      rh = r * vaporSat(TH) / vaporSat(T);
    } else if (c.all(7)) {
      rh = 100 * ((350 / c.f(117)) * fh - 7.5);
      rh += -T / 5.5;
      if (T < -20) rh *= 1 + (-20 - T) / 100;
      if (T < -40) rh *= 1 + (-40 - T) / 120;
    }
    if (Number.isFinite(rh)) out.rh = Math.max(0, Math.min(100, rh));
  }

  forget(serial: string): void { this.cals.delete(serial); }
}

/** Hyland-Wexler saturation vapor pressure, Pa. */
function vaporSat(tc: number): number {
  const T = tc + 273.15;
  return Math.exp(-5800.2206 / T + 1.3914993 + 6.5459673 * Math.log(T) - 4.8640239e-2 * T + 4.1764768e-5 * T * T - 1.4452093e-8 * T * T * T);
}
/** The standard atmosphere's pressure at a height, hPa. */
export function stdPressure(h: number): number {
  const gMR = 9.80665 * 0.0289644 / 8.31446;
  const [Pb, Tb, Lb, hb] = h > 32000 ? [8.6802, 228.65, 0.0028, 32000] : h > 20000 ? [54.7489, 216.65, 0.001, 20000] : h > 11000 ? [226.321, 216.65, 0, 11000] : [1013.25, 288.15, -0.0065, 0];
  return Lb === 0 ? Pb * Math.exp(-gMR * (h - hb) / Tb) : Pb * Math.pow(1 + Lb * (h - hb) / Tb, -gMR / Lb);
}

/** Correct both interleaved codewords in place. Returns bytes fixed, or -1 when either is beyond repair. */
export function rs41Ecc(fr: Uint8Array): number {
  const R = 24, K = 231, msg = 56, par = 8;
  let total = 0;
  for (let w = 0; w < 2; w++) {
    const cw = new Uint8Array(255);
    for (let i = 0; i < R; i++) cw[i] = fr[par + w * R + i];
    for (let i = 0; i < K; i++) { const p = msg + 2 * i + w; cw[R + i] = p < RS41_XLEN ? fr[p] : 0; }
    const n = RS_VAISALA.decode(cw);
    if (n < 0) return -1;
    total += n;
    for (let i = 0; i < R; i++) fr[par + w * R + i] = cw[i];
    for (let i = 0; i < K; i++) { const p = msg + 2 * i + w; if (p < RS41_XLEN) fr[p] = cw[R + i]; }
  }
  return total;
}

/** The two codewords' parity for a frame being built (tests). */
export function rs41Parity(fr: Uint8Array): void {
  const R = 24, K = 231, msg = 56, par = 8;
  for (let w = 0; w < 2; w++) {
    const cw = new Uint8Array(255);
    for (let i = 0; i < K; i++) { const p = msg + 2 * i + w; cw[R + i] = p < RS41_XLEN ? fr[p] : 0; }
    RS_VAISALA.encode(cw);
    for (let i = 0; i < R; i++) fr[par + w * R + i] = cw[i];
  }
}
