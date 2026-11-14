/**
 * Meteo-Radiy MRZ (MRZ-3MK / MP3-H1): 2400 baud, Manchester (1 = 10, 0 = 01), bits most significant first, integers
 * little-endian. A frame is AA BF 35, 45 bytes of payload (ECEF position and velocity, or latitude/longitude with
 * FF FF at bytes 30..31 and 42 bytes of payload), CRC16-MODBUS; every frame is sent six times. Each frame also carries
 * one 32-bit configuration word by slot (sensor coefficients, the sonde and sensor-boom serials, the date). The serial
 * is MRZ-<sonde>-<boom>, so nothing is reported until both serial slots have arrived (16 slots, a few seconds each).
 * The TypeScript twin of core/sonde/Mrz.kt and Mrz.swift.
 */
import { ecefToGeo, ecefVelToNeu, type SondeFrame } from './types.js';

export const MRZ_BAUD = 2399;
/** The tail of AA AA and the first six bits of BF, as Manchester symbols. */
export const MRZ_HEADER = '100110011001100110011001100110011001' + '10101010';
/** Frame bytes 0..49 (ECEF); the decoded bits start inside BF (the header ends 6 bits into it). */
export const MRZ_LEN = 50;
const MRZ_SHIFTS = 3;
/**
 * Symbols handed over after the header. The preamble repeats every bit, so the header also matches (at the allowed two
 * errors) one, two or three bits early; the decoder tries each alignment and the CRC picks the right one.
 */
export const MRZ_SYMS = 2 * (2 + (MRZ_LEN - 2) * 8) + 2 * MRZ_SHIFTS;
const CRCLEN_ECEF = 45, CRCLEN_LATLON = 42;

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const i16 = (b: Uint8Array, p: number) => (u16(b, p) << 16) >> 16;
const i32 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
const u32 = (b: Uint8Array, p: number) => i32(b, p) >>> 0;

/** CRC16-MODBUS (reflected 0x8005, init 0xFFFF). */
export function crc16modbus(b: ArrayLike<number>, start: number, len: number): number {
  let c = 0xffff;
  for (let i = start; i < start + len; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  return c & 0xffff;
}

export class MrzDecoder {
  private readonly fr = new Uint8Array(MRZ_LEN);
  private readonly cfg = new Uint32Array(16);
  private have = 0;
  private lastTime = -1;

  decode(soft: Float32Array): SondeFrame | null {
    for (let shift = 0; shift <= MRZ_SHIFTS; shift++) {
      const fr = this.bytesAt(soft, 2 * shift);
      if (this.crcOk(fr)) return this.parse(fr);
    }
    return null;
  }
  private bytesAt(soft: Float32Array, at: number): Uint8Array {
    const fr = this.fr;
    fr[0] = 0xaa; fr[1] = 0xbf;
    // bit k is the pair (2k, 2k+1): 1 when the first half is higher; bits 0..1 finish the BF
    for (let i = 0; i < MRZ_LEN - 2; i++) {
      let v = 0;
      for (let k = 0; k < 8; k++) {
        const s = at + 2 * (2 + 8 * i + k);
        const bit = s + 1 < soft.length && soft[s] > soft[s + 1] ? 1 : 0;
        v = (v << 1) | bit;
      }
      fr[2 + i] = v;
    }
    return fr;
  }
  private crcOk(fr: Uint8Array): boolean {
    return crc16modbus(fr, 3, CRCLEN_ECEF) === u16(fr, 3 + CRCLEN_ECEF) || crc16modbus(fr, 3, CRCLEN_LATLON) === u16(fr, 3 + CRCLEN_LATLON);
  }

  /** Frame bytes 0..49 (a lat/lon frame uses 0..46). */
  parse(fr: Uint8Array): SondeFrame | null {
    const ecefOk = crc16modbus(fr, 3, CRCLEN_ECEF) === u16(fr, 3 + CRCLEN_ECEF);
    const llOk = crc16modbus(fr, 3, CRCLEN_LATLON) === u16(fr, 3 + CRCLEN_LATLON);
    const marked = fr[30] === 0xff && fr[31] === 0xff;
    let latlon: boolean;
    if (marked && llOk) latlon = true;
    else if (ecefOk) latlon = false;
    else return null;
    const o = latlon ? -3 : 0;
    // the configuration word for this frame's slot
    const slot = fr[3] & 0x0f, word = u32(fr, 44 + o);
    if (slot === 0x0c || slot === 0x0d) {
      if ((this.have >> slot) & 1 && this.cfg[slot] !== word) { this.have = 0; this.lastTime = -1; }
    }
    this.cfg[slot] = word; this.have |= 1 << slot;
    const snC = (this.have >> 0xc) & 1 ? this.cfg[0xc] : 0, snD = (this.have >> 0xd) & 1 ? this.cfg[0xd] : 0;
    if (!snC || !snD) return null;
    const hh = fr[4], mm = fr[5], ss = fr[6];
    const timeOk = hh < 24 && mm < 60 && ss < 60;
    const tod = hh * 3600 + mm * 60 + ss;
    // six copies of every frame: report each time of day once
    if (timeOk && tod === this.lastTime) return null;
    if (timeOk) this.lastTime = tod;
    const out: SondeFrame = { type: 'MRZ', serial: `MRZ-${snC}-${snD}`, fixed: 0 };
    const extra: Record<string, string> = { 'SONDE SERIAL': `${snC}`, 'SENSOR SERIAL': `${snD}` };
    if (timeOk) out.timeS = tod;
    if ((this.have >> 0xf) & 1) {
      let v = this.cfg[0xf];
      const yr = (v % 100) + 2000; v = Math.floor(v / 100);
      const mth = v % 100; v = Math.floor(v / 100);
      const day = v % 100;
      if (mth >= 1 && mth <= 12 && day >= 1 && day <= 31) {
        out.date = `${yr}-${String(mth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (timeOk) out.frame = (Date.UTC(yr, mth - 1, day) - Date.UTC(1980, 0, 6)) / 1000 + tod;
      }
    }
    if ((this.have >> 0xe) & 1) extra['CALIBRATION DATE'] = String(this.cfg[0xe]).padStart(6, '0');
    if (latlon) {
      const lat = i32(fr, 7) * 1e-6, lon = i32(fr, 11) * 1e-6, alt = i32(fr, 15) * 1e-2;
      if (alt > -1000 && alt < 80000 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        out.lat = lat; out.lon = lon; out.alt = alt;
        out.vH = i16(fr, 19) / 100; out.heading = u16(fr, 21) / 100;
        extra.ALTITUDE = 'mean sea level';
      }
    } else {
      const x = i32(fr, 8) / 100, y = i32(fr, 12) / 100, z = i32(fr, 16) / 100;
      const g = ecefToGeo(x, y, z);
      if ((x || y || z) && g.alt > -1000 && g.alt < 80000) {
        out.lat = g.lat; out.lon = g.lon; out.alt = g.alt;
        const v = ecefVelToNeu(i16(fr, 20) / 100, i16(fr, 22) / 100, i16(fr, 24) / 100, g.lat, g.lon);
        out.vH = v.vH; out.heading = v.heading; out.climb = v.climb;
      }
    }
    out.sats = fr[26 + o];
    const T = i16(fr, 29 + o) / 100, rh = i16(fr, 31 + o) / 100;
    if (T > -120 && T < 80) out.tempC = T;
    if (rh > -10 && rh < 120) out.rh = Math.max(0, Math.min(100, rh));
    out.extra = extra;
    return out;
  }
}
