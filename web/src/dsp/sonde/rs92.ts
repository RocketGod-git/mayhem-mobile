/**
 * Vaisala RS92 (RS92-SGP at 400 MHz, RS92-NGP at 1680 MHz): 4800 baud, Manchester (0 = 10, 1 = 01), 8N1 bytes sent
 * least significant bit first, one 240-byte frame per second, no whitening. Six header bytes 2A 2A 2A 2A 2A 10, then
 * blocks [id, len/2, data, CRC16-CCITT LE] at fixed offsets (config, PTU, GPS, aux) and 24 bytes of RS(255,231).
 *
 * The RS92 sends raw GPS (pseudoranges and Doppler per channel), not a position: solving one needs the GPS orbits
 * (an ephemeris or almanac), which the sonde does not send. This decoder reports everything else: serial, frame,
 * reported frequency, burst timer, temperature, humidity and pressure (once the 32-row calibration table is in, about
 * 32 s), GPS time of week, the satellites tracked and the aux words. The NGP scrambles its calibration table and PTU
 * counts; both are unscrambled here. The TypeScript twin of core/sonde/Rs92.kt and Rs92.swift.
 */
import { RS_VAISALA, crc16ccitt } from './rs.js';
import type { SondeFrame } from './types.js';

export const RS92_BAUD = 4800;
/** 2A 2A 10 as 8N1 Manchester symbols: the last three of the six header bytes. */
export const RS92_HEADER = '10100110011001101001' + '1010011001100110100110101010100110101001';
export const RS92_HEADER_BYTES = [0x2a, 0x2a, 0x2a, 0x2a, 0x2a, 0x10];
export const RS92_LEN = 240;
/** Channel symbols after the header: 234 bytes of 20 symbols. */
export const RS92_SYMS = (RS92_LEN - 6) * 20;

/** Calibration bytes 0x170..0x17F of every RS92-SGP; an NGP's differ (they key its scrambling). */
export const RS92_CALX170 = [0x36, 0x98, 0x92, 0x25, 0x6b, 0xb3, 0x99, 0xe1, 0x57, 0x05, 0x30, 0x9a, 0xfe, 0x51, 0xf4, 0xab];

const POS_CFG = 0x08, POS_PTU = 0x2c, POS_GPS = 0x48, POS_AUX = 0xc6;
const LEN_CFG = 32, LEN_PTU = 24, LEN_GPS = 122, LEN_AUX = 10;
const POS_PAR = 216, MSG_LEN = 210;

const u16 = (b: ArrayLike<number>, p: number) => b[p] | (b[p + 1] << 8);
const u24 = (b: ArrayLike<number>, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const u32 = (b: ArrayLike<number>, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const dv = new DataView(new ArrayBuffer(4));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One sonde's calibration table, row by row, and what it unlocks once complete. */
class Rs92Cal {
  readonly bytes = new Uint8Array(32 * 16);
  readonly have = new Uint8Array(32);
  count = 0;
  /** Coefficients by index (NaN = not sent), built once all 32 rows are in. */
  f: Float64Array | null = null;
  ngp = false;
  readonly xptu = new Uint8Array(16);
  set(row: number, fr: Uint8Array, p: number): void {
    if (row >= 32 || this.have[row]) return;
    for (let k = 0; k < 16; k++) this.bytes[row * 16 + k] = fr[p + k];
    this.have[row] = 1; this.count++;
    if (this.count === 32) this.build();
  }
  private build(): void {
    const c = this.bytes;
    let sgp = true;
    for (let i = 0; i < 16; i++) if (c[0x170 + i] !== RS92_CALX170[i]) { sgp = false; break; }
    this.ngp = !sgp;
    // the NGP key: the bytes at 0x170 against the SGP's, a few of them swapped
    const key = new Uint8Array(16);
    if (this.ngp) {
      const p = 0x170, q = RS92_CALX170;
      for (let k = 0; k < 3; k++) {
        key[5 * k] = c[p + 5 * k] ^ q[5 * k];
        key[5 * k + 1] = c[p + 5 * k + 1] ^ q[5 * k + 1];
        key[5 * k + 3] = c[p + 5 * k + 3] ^ q[5 * k + 2];
        key[5 * k + 4] = c[p + 5 * k + 4] ^ q[5 * k + 3];
        key[5 * k + 2] = c[p + 5 * k + 2] ^ q[5 * k + 4];
      }
      key[15] = c[p + 15] ^ q[15];
      rs92PtuKey(this.bytes, this.xptu);
    }
    // 66 records [index, float32] from 0x40
    const f = new Float64Array(256); f.fill(NaN);
    for (let r = 0; r < 66; r++) {
      const j = 5 * r, at = 0x40 + j;
      const idx = c[at] ^ key[j % 16];
      const d0 = c[at + 1] ^ key[(j + 1) % 16], d1 = c[at + 2] ^ key[(j + 2) % 16];
      const d2 = c[at + 3] ^ key[(j + 3) % 16], d3 = c[at + 4] ^ key[(j + 4) % 16];
      if (this.ngp) { dv.setUint8(0, d1); dv.setUint8(1, d2); dv.setUint8(2, d0); dv.setUint8(3, d3); }
      else { dv.setUint8(0, d0); dv.setUint8(1, d1); dv.setUint8(2, d2); dv.setUint8(3, d3); }
      f[idx] = dv.getFloat32(0, true);
    }
    this.f = f;
  }
}

/** The NGP's PTU scrambling key, from calibration bytes 0x24..0x2E (32-bit unsigned arithmetic). */
export function rs92PtuKey(cal: ArrayLike<number>, out: Uint8Array): void {
  const base = 0x24;
  for (let j = 0; j < 8; j++) {
    let tmp = 0x1d89;
    for (let k = 0; k < 4; k++) {
      let a = (cal[base + j + k] + tmp) >>> 0, c = a;
      a = (((a << 10) >>> 0) + c) >>> 0; c = a;
      a = ((a >>> 6) ^ c) >>> 0; tmp = a;
    }
    let a = tmp, c = a;
    a = (((a << 3) >>> 0) + c) >>> 0; c = a;
    a = ((a >>> 11) ^ c) >>> 0; c = a;
    a = (((a << 15) >>> 0) + c) >>> 0;
    out[2 * j] = a & 0xff;
    out[2 * j + 1] = (a >>> 8) & 0xff;
  }
}

function poly5(x: number, f: Float64Array, at: number): number {
  return ((((f[at + 5] * x + f[at + 4]) * x + f[at + 3]) * x + f[at + 2]) * x + f[at + 1]) * x + f[at];
}
/** One sensor through its calibration: x = 1 / (y0 - (ref1 - m) / (ref1 - ref)), value = poly5(x). NaN if invalid. */
function sensor(m: number, ref1: number, ref: number, f: Float64Array, at: number, y0i: number): number {
  const t = ref1 - m, t0 = ref1 - ref;
  if (t <= 0 || t0 <= 0) return NaN;
  for (let k = 0; k < 6; k++) if (!Number.isFinite(f[at + k])) return NaN;
  const y0 = f[y0i];
  if (!Number.isFinite(y0)) return NaN;
  const x = 1 / (y0 - t / t0);
  return poly5(x, f, at);
}

export class Rs92Decoder {
  private readonly cals = new Map<string, Rs92Cal>();
  private readonly cw = new Uint8Array(255);
  private readonly fr = new Uint8Array(RS92_LEN);
  private readonly ptu = new Uint8Array(LEN_PTU);

  /** One frame's soft symbols (after the header). */
  decode(soft: Float32Array): SondeFrame | null {
    const fr = this.fr;
    for (let i = 0; i < 6; i++) fr[i] = RS92_HEADER_BYTES[i];
    const n = Math.min(RS92_LEN - 6, Math.floor(soft.length / 20));
    for (let i = 0; i < n; i++) {
      // symbols: start pair, 8 data pairs (LSB first), stop pair; a data pair (a, b) is 1 when b > a
      const b0 = 20 * i + 2;
      let v = 0;
      for (let k = 0; k < 8; k++) if (soft[b0 + 2 * k + 1] > soft[b0 + 2 * k]) v |= 1 << k;
      fr[6 + i] = v;
    }
    for (let i = 6 + n; i < RS92_LEN; i++) fr[i] = 0;
    return this.parse(fr);
  }

  /** A 240-byte frame, header included (repaired in place). */
  parse(fr: Uint8Array): SondeFrame | null {
    const fixed = this.ecc(fr);
    if (crc16ccitt(fr, POS_CFG, LEN_CFG) !== u16(fr, POS_CFG + LEN_CFG)) return null;
    let serial = '';
    for (let k = 0; k < 8; k++) {
      const c = fr[0x0c + k];
      if (c < 0x20 || c > 0x7e) return null;
      serial += String.fromCharCode(c);
    }
    const out: SondeFrame = { type: 'RS92', serial, frame: u16(fr, POS_CFG) };
    if (fixed >= 0) out.fixed = fixed;
    let cal = this.cals.get(serial);
    if (!cal) {
      cal = new Rs92Cal(); this.cals.set(serial, cal);
      if (this.cals.size > 64) this.cals.delete(this.cals.keys().next().value!);
    }
    const row = fr[0x17];
    cal.set(row, fr, 0x18);
    const extra: Record<string, string> = { POSITION: 'raw GPS only (needs an ephemeris)', CALIBRATION: `${cal.count}/32` };
    // row 0: the reported frequency and the burst timer
    const code = cal.have[0] ? u16(cal.bytes, 2) : -1, kill = cal.have[0] ? u16(cal.bytes, 4) : -1;
    const ngp = cal.f ? cal.ngp : code > 1000;
    if (cal.f) out.model = cal.ngp ? 'RS92-NGP' : 'RS92-SGP';
    if (code >= 0) out.txKHz = (ngp ? 1_600_000 : 400_000) + 10 * code;
    if (kill >= 0 && kill < 0xffff) out.killS = kill;
    // PTU
    if (cal.f && crc16ccitt(fr, POS_PTU, LEN_PTU) === u16(fr, POS_PTU + LEN_PTU)) {
      const m = this.ptu;
      for (let j = 0; j < LEN_PTU; j++) {
        let b = fr[POS_PTU + j];
        if (cal.ngp) b ^= fr[POS_CFG + (j & 1)] ^ cal.xptu[j % 16];
        m[j] = b;
      }
      const temp = u24(m, 0), hum1 = u24(m, 3), hum2 = u24(m, 6), ref1 = u24(m, 9), pres = u24(m, 15), ref3 = u24(m, 18), ref4 = u24(m, 21);
      const f = cal.f;
      const T = sensor(temp, ref1, ref4, f, 30, 37);
      if (Number.isFinite(T) && T > -120 && T < 80) out.tempC = T;
      const U1 = sensor(hum1, ref1, ref3, f, 40, 47), U2 = sensor(hum2, ref1, ref3, f, 50, 57);
      const U = Number.isFinite(U1) && Number.isFinite(U2) ? Math.max(U1, U2) : Number.isFinite(U1) ? U1 : U2;
      if (Number.isFinite(U)) out.rh = Math.max(0, Math.min(100, U));
      const P = sensor(pres, ref1, ref4, f, 10, 17);
      if (Number.isFinite(P) && P > 0 && P < 2000) out.hPa = P;
    }
    // GPS: time of week and the channels tracking a satellite
    if (crc16ccitt(fr, POS_GPS, LEN_GPS) === u16(fr, POS_GPS + LEN_GPS)) {
      const tow = u32(fr, POS_GPS) / 1000;
      out.timeS = tow % 86400;
      extra['GPS WEEKDAY'] = WEEKDAYS[Math.floor(tow / 86400) % 7];
      const prns: number[] = [];
      let sats = 0, clearNext = false;
      for (let w = 0; w < 4; w++) {
        const word = u16(fr, 0x4e + 2 * w);
        for (let c = 0; c < 3; c++) {
          const ch = 3 * w + c, st = fr[0x56 + ch];
          let prn = (word >> (5 * c)) & 0x1f;
          if (clearNext) { prn &= 0x1e; clearNext = false; }
          if (prn === 0 && (st & 0x0f) !== 0) {
            if (c === 2) { if (word & 0x8000) prn = 32; }
            else if ((word >> (5 * (c + 1))) & 1) { prn = 32; clearNext = true; }
          }
          if ((st & 0x0f) === 0x0f) { sats++; if (prn) prns.push(prn); }
        }
      }
      out.sats = sats;
      if (prns.length) extra.PRN = prns.join(' ');
    }
    // aux words (ozone and other add-on sensors)
    if (crc16ccitt(fr, POS_AUX, LEN_AUX) === u16(fr, POS_AUX + LEN_AUX)) {
      let any = 0, s = '';
      for (let i = 0; i < 4; i++) { const v = u16(fr, 0xc8 + 2 * i); any |= v; s += v.toString(16).padStart(4, '0'); }
      if (any) extra.AUX = s;
    }
    out.extra = extra;
    return out;
  }

  /** RS(255,231): frame[216+i] is X^i, frame[6+i] is X^(24+i). Bytes fixed, or -1 beyond repair. */
  private ecc(fr: Uint8Array): number {
    const cw = this.cw;
    cw.fill(0);
    for (let i = 0; i < 24; i++) cw[i] = fr[POS_PAR + i];
    for (let i = 0; i < MSG_LEN; i++) cw[24 + i] = fr[6 + i];
    const n = RS_VAISALA.decode(cw);
    if (n < 0) return -1;
    for (let i = 0; i < 24; i++) fr[POS_PAR + i] = cw[i];
    for (let i = 0; i < MSG_LEN; i++) fr[6 + i] = cw[24 + i];
    return n;
  }

  forget(serial: string): void { this.cals.delete(serial); }
}

/** RS(255,231) parity for a frame being built (tests). */
export function rs92Parity(fr: Uint8Array): void {
  const cw = new Uint8Array(255);
  for (let i = 0; i < MSG_LEN; i++) cw[24 + i] = fr[6 + i];
  RS_VAISALA.encode(cw);
  for (let i = 0; i < 24; i++) fr[POS_PAR + i] = cw[i];
}
