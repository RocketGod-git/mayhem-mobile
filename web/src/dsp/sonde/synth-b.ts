/**
 * Test signals for the RS92, LMS6-403 / LMSX, LMS6-1680 and MRZ decoders: frames built the way each sonde builds them
 * (CRCs, Reed-Solomon parity, convolutional code, Manchester, 8N1) and their channel symbols for fskIq(). Used by the
 * tests only. The TypeScript twin of the Kotlin and Swift test helpers.
 */
import { crc16ccitt } from './rs.js';
import { RS92_CALX170, RS92_HEADER_BYTES, rs92Parity, rs92PtuKey } from './rs92.js';
import { LMS6_SYNC, LMS_FRAME, RS_CCSDS } from './lms6.js';
import { crc16modbus } from './mrz.js';
import { bitsOf, manchesterOf, type FlightPoint } from './synth.js';
import { convEncode } from './viterbi.js';
import { geoToEcef, neuToEcefVel } from './types.js';

const putLe16 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; };
const putLe24 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; b[p + 2] = (v >> 16) & 255; };
const putLe32 = (b: Uint8Array, p: number, v: number) => { b[p] = v & 255; b[p + 1] = (v >> 8) & 255; b[p + 2] = (v >> 16) & 255; b[p + 3] = (v >>> 24) & 255; };
const putBe16 = (b: Uint8Array, p: number, v: number) => { b[p] = (v >> 8) & 255; b[p + 1] = v & 255; };
const putBe24 = (b: Uint8Array, p: number, v: number) => { b[p] = (v >> 16) & 255; b[p + 1] = (v >> 8) & 255; b[p + 2] = v & 255; };
const putBe32 = (b: Uint8Array, p: number, v: number) => { b[p] = (v >>> 24) & 255; b[p + 1] = (v >> 16) & 255; b[p + 2] = (v >> 8) & 255; b[p + 3] = v & 255; };
const f32Bytes = (v: number): number[] => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return [d.getUint8(0), d.getUint8(1), d.getUint8(2), d.getUint8(3)]; };

/** Bits to 8N1 symbols: start 0, data least significant first, stop 1. */
export function uartBits(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) { out.push(0); for (let k = 0; k < 8; k++) out.push((bytes[i] >> k) & 1); out.push(1); }
  return out;
}

// ---------------------------------------------------------------- RS92

/**
 * Test calibration: T = -80 + 50x, RH = 50x (both sensors), P = 500x, with y0 = 1.5 for each, where
 * x = 1 / (y0 - (ref1 - m) / (ref1 - ref)).
 */
export const RS92_TEST_COEF: Record<number, number> = {
  10: 0, 11: 500, 12: 0, 13: 0, 14: 0, 15: 0, 17: 1.5,
  30: -80, 31: 50, 32: 0, 33: 0, 34: 0, 35: 0, 37: 1.5,
  40: 0, 41: 50, 42: 0, 43: 0, 44: 0, 45: 0, 47: 1.5,
  50: 0, 51: 50, 52: 0, 53: 0, 54: 0, 55: 0, 57: 1.5,
};
const RS92_REF1 = 1_000_000, RS92_REF3 = 700_000, RS92_REF4 = 600_000;
/** The NGP test key (any 16 bytes). */
const NGP_KEY = Array.from({ length: 16 }, (_, i) => (0x5a + 37 * i) & 255);
/** Which RS92_CALX170 byte keys each key position. */
const NGP_PERM = [0, 1, 4, 2, 3, 5, 6, 9, 7, 8, 10, 11, 14, 12, 13, 15];

/** A 512-byte RS92 calibration table (32 rows) as the sonde sends it; scrambled the NGP way when `ngp`. */
export function rs92CalTable(txKHz = 402_150, killS = 0x1234, ngp = false, coef = RS92_TEST_COEF): Uint8Array {
  const c = new Uint8Array(512);
  const code = Math.round((txKHz - (ngp ? 1_600_000 : 400_000)) / 10);
  putLe16(c, 2, code); putLe16(c, 4, killS);
  for (let i = 6; i < 0x40; i++) c[i] = (i * 29 + 7) & 255;
  // records [index, float32] from 0x40, the first 40 slots (the last ones overlap the 0x170 key bytes)
  let r = 0;
  for (const [k, v] of Object.entries(coef)) {
    const at = 0x40 + 5 * r++, fb = f32Bytes(v);
    c[at] = Number(k);
    if (ngp) { c[at + 1] = fb[2]; c[at + 2] = fb[0]; c[at + 3] = fb[1]; c[at + 4] = fb[3]; }
    else { c[at + 1] = fb[0]; c[at + 2] = fb[1]; c[at + 3] = fb[2]; c[at + 4] = fb[3]; }
  }
  for (let i = 0; i < 16; i++) c[0x170 + i] = RS92_CALX170[i];
  if (ngp) {
    for (let j = 0; j < 330; j++) if (0x40 + j < 0x170 || 0x40 + j >= 0x180) c[0x40 + j] ^= NGP_KEY[j % 16];
    for (let i = 0; i < 16; i++) c[0x170 + i] = NGP_KEY[i] ^ RS92_CALX170[NGP_PERM[i]];
  }
  return c;
}

/** PTU counts [temp, hum1, hum2, ref1, ref2, pres, ref3, ref4] that read back as these values with RS92_TEST_COEF. */
export function rs92PtuCounts(tempC: number, rh1: number, rh2: number, hPa: number): number[] {
  const count = (v: number, a0: number, a1: number, ref: number) => {
    const x = (v - a0) / a1, y = 1.5 - 1 / x;
    return Math.round(RS92_REF1 - y * (RS92_REF1 - ref));
  };
  return [count(tempC, -80, 50, RS92_REF4), count(rh1, 0, 50, RS92_REF3), count(rh2, 0, 50, RS92_REF3), RS92_REF1, 900_000,
    count(hPa, 0, 500, RS92_REF4), RS92_REF3, RS92_REF4];
}

export interface Rs92Opts {
  serial: string; frame: number; cal: Uint8Array; ptu: number[]; towMs: number;
  /** Satellites tracked (PRN 1..31), up to 12. */
  prns: number[]; aux?: number[]; ngp?: boolean;
}
/** One 240-byte RS92 frame: blocks, CRCs, RS parity. */
export function rs92Frame(o: Rs92Opts): Uint8Array {
  const fr = new Uint8Array(240);
  fr.set(RS92_HEADER_BYTES, 0);
  const block = (pos: number, id: number, words: number, fill: (d: number) => void) => {
    fr[pos] = id; fr[pos + 1] = words; fill(pos + 2);
    putLe16(fr, pos + 2 + 2 * words, crc16ccitt(fr, pos + 2, 2 * words));
  };
  const row = o.frame % 32;
  block(0x06, 0x65, 0x10, d => {
    putLe16(fr, d, o.frame); fr[d + 2] = 0x20; fr[d + 3] = 0x20;
    for (let i = 0; i < 8; i++) fr[d + 4 + i] = o.serial.charCodeAt(i);
    fr[d + 15] = row;
    for (let i = 0; i < 16; i++) fr[d + 16 + i] = o.cal[row * 16 + i];
  });
  block(0x2a, 0x69, 0x0c, d => {
    for (let k = 0; k < 8; k++) putLe24(fr, d + 3 * k, o.ptu[k]);
    if (o.ngp) {
      const key = new Uint8Array(16); rs92PtuKey(o.cal, key);
      for (let j = 0; j < 24; j++) fr[d + j] ^= fr[0x08 + (j & 1)] ^ key[j % 16];
    }
  });
  block(0x46, 0x67, 0x3d, d => {
    putLe32(fr, d, o.towMs);
    for (let w = 0; w < 4; w++) {
      let word = 0;
      for (let c = 0; c < 3; c++) { const ch = 3 * w + c; if (ch < o.prns.length) word |= (o.prns[ch] & 0x1f) << (5 * c); }
      putLe16(fr, d + 6 + 2 * w, word);
    }
    for (let ch = 0; ch < 12; ch++) {
      fr[d + 14 + ch] = ch < o.prns.length ? 0x0f : 0x00;
      putLe32(fr, d + 26 + 8 * ch, ch < o.prns.length ? 0x00200000 + ch * 0x1111 : 0x7fffffff);
      putLe24(fr, d + 30 + 8 * ch, ch < o.prns.length ? 0x001000 + ch : 0);
    }
  });
  block(0xc4, 0x68, 0x05, d => {
    fr[d] = 3; fr[d + 1] = 3;
    const aux = o.aux ?? [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) putLe16(fr, d + 2 + 2 * i, aux[i]);
  });
  fr.set([0xff, 0x02, 0x02, 0x00, 0x02, 0x00], 0xd2);
  rs92Parity(fr);
  return fr;
}
/** The channel symbols of a frame: 8N1, LSB first, each bit as Manchester 0 = 10, 1 = 01. */
export function rs92Symbols(fr: Uint8Array): number[] { return manchesterOf(uartBits(fr), false); }

// ---------------------------------------------------------------- LMS6-403 / LMSX

const B60B60 = (1 << 30) / 90.0;

export interface LmsOpts { sn: number; frame: number; towMs: number; p: FlightPoint; sub05?: boolean }
/** One 223-byte LMS6-403 frame with its CRC. */
export function lms6Frame(o: LmsOpts): Uint8Array {
  const fr = new Uint8Array(LMS_FRAME);
  fr.set([0x24, 0x54, 0x00, o.sub05 ? 0x05 : 0x00], 0);
  putBe32(fr, 4, o.sn & 0xffffff);
  putBe16(fr, 8, o.frame);
  putBe32(fr, 10, o.towMs);
  putBe32(fr, 18, Math.round(o.p.lat * B60B60));
  putBe32(fr, 22, Math.round(o.p.lon * B60B60));
  putBe32(fr, 26, Math.round(o.p.alt * 1000));
  putBe24(fr, 30, Math.round(o.p.vE * 1000) & 0xffffff);
  putBe24(fr, 33, Math.round(o.p.vN * 1000) & 0xffffff);
  putBe24(fr, 36, Math.round(o.p.vU * 1000) & 0xffffff);
  for (let i = 39; i < 221; i++) fr[i] = (i * 7 + o.frame) & 0x3f;
  putBe16(fr, 221, crc16ccitt(fr, 0, 221, 0));
  return fr;
}
/** One 223-byte LMSX frame with its CRC. */
export function lmsxFrame(o: LmsOpts): Uint8Array {
  const fr = new Uint8Array(LMS_FRAME);
  fr.set([0x24, 0x46, 0x05, 0x00], 0);
  putBe32(fr, 4, o.sn & 0xffffff);
  putBe16(fr, 8, o.frame);
  const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, o.towMs / 1000, false);
  for (let k = 0; k < 4; k++) { fr[14 + k] = d.getUint8(k); fr[10 + k] = d.getUint8(4 + k); }
  putBe32(fr, 18, Math.round(o.p.lat * 1e7));
  putBe32(fr, 22, Math.round(o.p.lon * 1e7));
  putBe32(fr, 26, Math.round(o.p.alt * 100));
  let hd = Math.atan2(o.p.vE, o.p.vN) * 180 / Math.PI; if (hd < 0) hd += 360;
  putBe16(fr, 30, Math.round(Math.hypot(o.p.vE, o.p.vN) * 100) & 0xffff);
  putBe16(fr, 32, Math.round(hd * 100) & 0xffff);
  putBe16(fr, 34, Math.round(o.p.vU * 100) & 0xffff);
  for (let i = 36; i < 221; i++) fr[i] = (i * 5 + o.frame) & 0x3f;
  putBe16(fr, 221, crc16ccitt(fr, 0, 221, 0));
  return fr;
}
/** A 223-byte message as the 255-byte codeword the sonde sends: message first, then the 32 parity bytes. */
export function lmsCodeword(msg: Uint8Array): Uint8Array {
  const cw = new Uint8Array(255);
  for (let j = 0; j < LMS_FRAME; j++) cw[254 - j] = msg[j];
  RS_CCSDS.encode(cw);
  const out = new Uint8Array(255);
  for (let j = 0; j < 255; j++) out[j] = cw[254 - j];
  return out;
}
/**
 * LMS6-403 bytes on air: the frames laid end to end with `fill` bytes of 0xCA between them, cut into 223-byte RS
 * messages, each sent as a 260-byte block (sync, message, parity).
 */
export function lms6Blocks(frames: Uint8Array[], fill = 34): Uint8Array {
  const stream: number[] = [];
  for (const f of frames) { for (const b of f) stream.push(b); for (let i = 0; i < fill; i++) stream.push(0xca); }
  while (stream.length % LMS_FRAME) stream.push(0xca);
  const nb = stream.length / LMS_FRAME, out = new Uint8Array(nb * 260);
  for (let k = 0; k < nb; k++) {
    out.set(LMS6_SYNC, 260 * k);
    out.set(lmsCodeword(Uint8Array.from(stream.slice(k * LMS_FRAME, (k + 1) * LMS_FRAME))), 260 * k + 5);
  }
  return out;
}
/** LMSX bytes on air: per frame (one a second) the sync, the codeword, 40 fill bytes. */
export function lmsxUnits(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.length * 300);
  for (let k = 0; k < frames.length; k++) {
    out.set(LMS6_SYNC, 300 * k);
    out.set(lmsCodeword(frames[k]), 300 * k + 5);
    for (let i = 260; i < 300; i++) out[300 * k + i] = 0xca;
  }
  return out;
}
/** Bytes to LMS channel symbols: bits LSB first, convolutional code from the zero state, sent as (c0, NOT c1). */
export function lmsSymbols(bytes: Uint8Array): number[] {
  const bits = bitsOf(bytes, true), code = new Uint8Array(2 * bits.length);
  convEncode(bits, 0, code, 0);
  const out: number[] = new Array(code.length);
  for (let i = 0; i < code.length; i++) out[i] = i & 1 ? 1 - code[i] : code[i];
  return out;
}

// ---------------------------------------------------------------- LMS6-1680 (Mk2a)

/** A 0x54 (GPS) subframe: 172 data bytes and the CRC. */
export function mk2aGps(id: number, frame: number, towMs: number, p: FlightPoint, rep = 0x32): Uint8Array {
  const b = new Uint8Array(174);
  b.set([0x24, 0x52, 0x54, rep], 0);
  putBe16(b, 4, id & 0xffff); putBe16(b, 6, frame); b[8] = 0x00; b[9] = 0xa2;
  putBe32(b, 10, towMs);
  putBe32(b, 18, Math.round(p.lat * 0xb60b60)); putBe32(b, 22, Math.round(p.lon * 0xb60b60));
  putBe32(b, 26, Math.round(p.alt * 1000));
  putBe24(b, 30, Math.round(p.vE * 1000) & 0xffffff); putBe24(b, 33, Math.round(p.vN * 1000) & 0xffffff); putBe24(b, 36, Math.round(p.vU * 1000) & 0xffffff);
  for (let i = 39; i < 172; i++) b[i] = (i * 11 + frame) & 0x7f;
  putBe16(b, 172, crc16ccitt(b, 0, 172, 0));
  return b;
}
/** A 0x4D (config) subframe carrying the full serial: 66 data bytes and the CRC. */
export function mk2aConfig(id: number, frame: number, rep = 0x31): Uint8Array {
  const b = new Uint8Array(68);
  b.set([0x24, 0x52, 0x4d, rep], 0);
  putBe16(b, 4, id & 0xffff); putBe16(b, 6, frame);
  for (let i = 8; i < 50; i++) b[i] = (i * 3) & 0x7f;
  b[50] = (id >> 8) & 255; b[51] = id & 255; b[52] = (id >>> 24) & 255; b[53] = (id >> 16) & 255;
  for (let i = 54; i < 66; i++) b[i] = 0x0f;
  putBe16(b, 66, crc16ccitt(b, 0, 66, 0));
  return b;
}
/** Subframes on air: idle CA bytes, then each subframe after CA CA CA, with `gap` CA bytes after it. */
export function mk2aSymbols(subs: Uint8Array[], gap = 10): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) bytes.push(0xca);
  for (const s of subs) { bytes.push(0xca, 0xca, 0xca); for (const b of s) bytes.push(b); for (let i = 0; i < gap; i++) bytes.push(0xca); }
  return uartBits(bytes);
}

// ---------------------------------------------------------------- MRZ

export interface MrzOpts {
  slot: number; word: number; h: number; m: number; s: number; p: FlightPoint; sats: number; tempC: number; rh: number;
  latlon?: boolean;
}
/** One MRZ frame (50 bytes ECEF, 47 lat/lon), CRC filled. */
export function mrzFrame(o: MrzOpts): Uint8Array {
  const ll = !!o.latlon, b = new Uint8Array(ll ? 47 : 50), x = ll ? -3 : 0;
  b[0] = 0xaa; b[1] = 0xbf; b[2] = 0x35; b[3] = 0x80 | (o.slot & 0x0f);
  b[4] = o.h; b[5] = o.m; b[6] = o.s;
  if (ll) {
    putLe32(b, 7, Math.round(o.p.lat * 1e6)); putLe32(b, 11, Math.round(o.p.lon * 1e6)); putLe32(b, 15, Math.round(o.p.alt * 100));
    let hd = Math.atan2(o.p.vE, o.p.vN) * 180 / Math.PI; if (hd < 0) hd += 360;
    putLe16(b, 19, Math.round(Math.hypot(o.p.vE, o.p.vN) * 100)); putLe16(b, 21, Math.round(hd * 100));
    b[30] = 0xff; b[31] = 0xff;
  } else {
    const [X, Y, Z] = geoToEcef(o.p.lat, o.p.lon, o.p.alt), [vx, vy, vz] = neuToEcefVel(o.p.vN, o.p.vE, o.p.vU, o.p.lat, o.p.lon);
    putLe32(b, 8, Math.round(X * 100)); putLe32(b, 12, Math.round(Y * 100)); putLe32(b, 16, Math.round(Z * 100));
    putLe16(b, 20, Math.round(vx * 100)); putLe16(b, 22, Math.round(vy * 100)); putLe16(b, 24, Math.round(vz * 100));
  }
  b[26 + x] = o.sats;
  putLe16(b, 29 + x, Math.round(o.tempC * 100)); putLe16(b, 31 + x, Math.round(o.rh * 100));
  putLe32(b, 35 + x, 1_234_500); putLe32(b, 39 + x, 2_345_600);
  b[43 + x] = (o.slot + 1) & 0xff;
  putLe32(b, 44 + x, o.word >>> 0);
  const n = ll ? 42 : 45;
  putLe16(b, 3 + n, crc16modbus(b, 3, n));
  return b;
}
/** Frames on air, each `repeats` times: AA AA, the frame (from its own AA), AA AA after. Manchester 1 = 10, MSB first. */
export function mrzSymbols(frames: Uint8Array[], repeats = 6): number[] {
  const bytes: number[] = [0xaa, 0xaa];
  for (const f of frames) for (let r = 0; r < repeats; r++) {
    bytes.push(0xaa); for (const v of f) bytes.push(v);
    if (r === repeats - 1) bytes.push(0x00, 0x00); else bytes.push(0xaa, 0xaa);
  }
  return manchesterOf(bitsOf(bytes, false), true);
}
