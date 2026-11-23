/**
 * DMR data beyond rate 1/2 (ETSI TS 102 361-1) and the ETSI Location Information Protocol:
 *
 *   · rate 3/4 data blocks (B.2.4): 18 octets as 48 tribits plus a flushing zero tribit through the 8-state trellis
 *     encoder whose next state is its input (table B.7), each constellation point a dibit pair (table B.8), interleaved
 *     by table B.9; read here with a Viterbi decoder;
 *   · LIP (ETSI TS 100 392-18-1, 6.2.1): the SHORT LOCATION REPORT, PDU type 0, time elapsed (2 bits), longitude (25,
 *     two's complement, 360/2^25 degrees), latitude (24, 180/2^24 degrees), position error (3), horizontal velocity
 *     (7: 0 to 28 km/h in 1 km/h steps, then 16 x 1.038^(K - 13)), direction of travel (4, 22.5 degree steps);
 *   · LIP in DMR: over UDP/IPv4 to port 5017 in packet data (TS 102 361-4, 6.6.3.4.2), and the USBD poll response
 *     (Data Type 1011, CRC mask 3333, service type 0000 then the same fields, TS 102 361-4 table 6.79).
 * Motorola's LRRP, not a published standard, is read from the layout in the DSD-FME decoder (below). No DOM.
 */
import type { Position } from './gps.js';

/** Table B.7: constellation point by [state][input tribit]. */
const T34 = [
  [0, 8, 4, 12, 2, 10, 6, 14], [4, 12, 2, 10, 6, 14, 0, 8], [1, 9, 5, 13, 3, 11, 7, 15], [5, 13, 3, 11, 7, 15, 1, 9],
  [3, 11, 7, 15, 1, 9, 5, 13], [7, 15, 1, 9, 5, 13, 3, 11], [2, 10, 6, 14, 0, 8, 4, 12], [6, 14, 0, 8, 4, 12, 2, 10],
];
/** Table B.8: constellation point → its two dibits (DMR dibit values: 0 is +1, 1 is +3, 2 is -1, 3 is -3). */
const LV = (v: number) => v === 1 ? 0 : v === 3 ? 1 : v === -1 ? 2 : 3;
const PT = [[1, -1], [-1, -1], [3, -3], [-3, -3], [-3, -1], [3, -1], [-1, -3], [1, -3], [-3, 3], [3, 3], [-1, 1], [1, 1], [1, 3], [-1, 3], [3, 1], [-3, 1]]
  .map(([a, b]) => (LV(a) << 2) | LV(b));
/** Table B.9: the transmitted dibit k is the encoder's dibit R34_INTERLEAVE[k]. */
export const R34_INTERLEAVE = (() => {
  const t: number[] = [];
  for (let m = 0; m < 13; m++) t.push(8 * m, 8 * m + 1);
  for (const c of [2, 4, 6]) for (let m = 0; m < 12; m++) t.push(c + 8 * m, c + 8 * m + 1);
  return t;
})();
/** Distance between two dibit pairs: how many level steps apart their symbols are (+1, +3, -1, -3 for dibits 0 to 3). */
const LEVEL = [1, 3, -1, -3];
const dibitDist = (a: number, b: number) => (Math.abs(LEVEL[a >> 2] - LEVEL[b >> 2]) + Math.abs(LEVEL[a & 3] - LEVEL[b & 3])) >> 1;

/** 196 payload bits (as dmrReadBurst lays them out: info before, then after, the center field) → 18 octets. */
export function rate34Decode(raw: ArrayLike<number>): { bytes: Uint8Array; metric: number } {
  const enc = new Uint8Array(98);
  for (let k = 0; k < 98; k++) enc[R34_INTERLEAVE[k]] = ((raw[2 * k] & 1) << 1) | (raw[2 * k + 1] & 1);
  let pm = new Int32Array(8).fill(1 << 20); pm[0] = 0;
  const back = new Uint8Array(49 * 8);
  for (let t = 0; t < 49; t++) {
    const sym = (enc[2 * t] << 2) | enc[2 * t + 1], np = new Int32Array(8).fill(1 << 30);
    for (let s = 0; s < 8; s++) {
      if (pm[s] >= 1 << 20) continue;
      for (let i = 0; i < 8; i++) {
        if (t === 48 && i !== 0) continue;
        const m = pm[s] + dibitDist(PT[T34[s][i]], sym);
        if (m < np[i]) { np[i] = m; back[t * 8 + i] = s; }
      }
    }
    pm = np;
  }
  const trib = new Uint8Array(49); let s = 0;
  for (let t = 48; t >= 0; t--) { trib[t] = s; s = back[t * 8 + s]; }
  const bytes = new Uint8Array(18);
  for (let t = 0; t < 48; t++) for (let j = 0; j < 3; j++) { const bit = 3 * t + j; if ((trib[t] >> (2 - j)) & 1) bytes[bit >> 3] |= 0x80 >> (bit & 7); }
  return { bytes, metric: pm[0] };
}
/** 18 octets → the 196 payload bits, for the tests and for checking a decode. */
export function rate34Encode(bytes: ArrayLike<number>): Uint8Array {
  const enc = new Uint8Array(98); let s = 0;
  for (let t = 0; t < 49; t++) {
    let tr = 0; if (t < 48) for (let j = 0; j < 3; j++) { const bit = 3 * t + j; tr = (tr << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); }
    const p = PT[T34[s][tr]]; enc[2 * t] = p >> 2; enc[2 * t + 1] = p & 3; s = tr;
  }
  const raw = new Uint8Array(196);
  for (let k = 0; k < 98; k++) { const v = enc[R34_INTERLEAVE[k]]; raw[2 * k] = v >> 1; raw[2 * k + 1] = v & 1; }
  return raw;
}

/** Bits [from, from + n) of a byte array, MSB first, as an unsigned number. */
const field = (b: ArrayLike<number>, from: number, n: number) => { let v = 0; for (let i = from; i < from + n; i++) v = v * 2 + ((b[i >> 3] >> (7 - (i & 7))) & 1); return v; };

export interface LipReport extends Position { timeElapsed: number; posError: number; speedKmh: number; heading: number }
/** LIP horizontal velocity (km/h), -1 when unknown (127). */
export const lipSpeed = (k: number) => k === 127 ? -1 : k <= 28 ? k : 16 * Math.pow(1.038, k - 13);

/** The LIP fields after the PDU type, starting at bit [at]: time elapsed, longitude, latitude, error, velocity, direction. */
function lipFields(b: ArrayLike<number>, at: number, source: string): LipReport | null {
  const te = field(b, at, 2);
  let lon = field(b, at + 2, 25), lat = field(b, at + 27, 24);
  if (lon >= 0x1000000) lon -= 0x2000000;
  if (lat >= 0x800000) lat -= 0x1000000;
  const r: LipReport = { lat: lat * 180 / 16777216, lon: lon * 360 / 33554432, source, timeElapsed: te, posError: field(b, at + 51, 3), speedKmh: lipSpeed(field(b, at + 54, 7)), heading: field(b, at + 61, 4) * 22.5 };
  if (r.posError === 7 || (lat === 0 && lon === 0) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) return null;
  return r;
}
/** A LIP PDU: only the SHORT LOCATION REPORT (PDU type 0) is read. */
export function lipShortReport(b: ArrayLike<number>): LipReport | null {
  if (b.length < 10 || field(b, 0, 2) !== 0) return null;
  return lipFields(b, 2, 'lip');
}
/** A USBD block's 10 octets (the CRC already checked): service type 0, LIP, then the poll response fields. */
export function usbdLip(b: ArrayLike<number>): LipReport | null {
  if ((b[0] >> 4) !== 0) return null;
  return lipFields(b, 4, 'lip-usbd');
}

/** An IPv4 packet with a good header checksum holding UDP to port 5017 → its LIP report. */
export function lipInIp(b: ArrayLike<number>): LipReport | null {
  const u = udpPayload(b);
  return u && u.dport === 5017 && u.data.length >= 10 ? lipShortReport(u.data) : null;
}
/** An IPv4 packet with a good header checksum holding UDP to or from port 4001 → its LRRP report. */
export function lrrpInIp(b: ArrayLike<number>): LrrpReport | null {
  const u = udpPayload(b);
  return u && (u.dport === 4001 || u.sport === 4001) ? lrrpReport(u.data) : null;
}
/** The UDP datagram in an IPv4 packet whose header checksum checks. */
export function udpPayload(b: ArrayLike<number>): { sport: number; dport: number; data: number[] } | null {
  if (b.length < 28 || (b[0] >> 4) !== 4 || b[9] !== 17) return null;
  const ihl = (b[0] & 15) * 4; if (ihl < 20 || b.length < ihl + 8) return null;
  let sum = 0; for (let i = 0; i < ihl; i += 2) sum += (b[i] << 8) | b[i + 1];
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  if (sum !== 0xffff) return null;
  const ulen = (b[ihl + 4] << 8) | b[ihl + 5];
  if (ulen < 8) return null;
  return { sport: (b[ihl] << 8) | b[ihl + 1], dport: (b[ihl + 2] << 8) | b[ihl + 3], data: Array.from({ length: ulen - 8 }, (_, i) => b[ihl + 8 + i] ?? 0) };
}

// ------------------------------------------------------------------------------------------------ Motorola LRRP
/**
 * Motorola LRRP (its location protocol over UDP port 4001; not a published standard, the layout is from the DSD-FME
 * decoder, see the credits): a message type (0x07 immediate location response, 0x0B triggered start response, 0x0D
 * triggered location), a length, then tokens: 0x22 request ID (a length and that many bytes), 0x34 or 0x35 time (5
 * bytes), 0x51, 0x54 or 0x55 a circle (latitude, longitude, 2 more bytes), 0x66 a point (latitude, longitude),
 * 0x69 or 0x6A a point with altitude (1 more byte), 0x56 the heading (one byte, 2 degree steps), 0x6C or 0x70 a
 * speed (2 bytes, not read). Latitude: 32 bits, the top one the sign (south), 90/2^31 degrees; longitude: 32 bits
 * two's complement, 180/2^31 degrees.
 */
export interface LrrpReport extends Position { heading: number }
const LRRP_SKIP: Record<number, number> = { 0x34: 6, 0x35: 6, 0x36: 2, 0x37: 2, 0x56: 2, 0x6c: 3, 0x70: 3 };
const LRRP_POS: Record<number, number> = { 0x51: 11, 0x54: 11, 0x55: 11, 0x66: 9, 0x69: 10, 0x6a: 10 };
export function lrrpReport(p: ArrayLike<number>): LrrpReport | null {
  if (p.length < 4 || (p[0] !== 0x07 && p[0] !== 0x0b && p[0] !== 0x0d)) return null;
  const end = Math.min(p.length, 2 + p[1]);
  let lat = NaN, lon = NaN, heading = -1;
  const u32 = (i: number) => ((p[i] << 24) | (p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3]) >>> 0;
  for (let i = 2; i < end;) {
    const t = p[i];
    if (t === 0x22 || t === 0x23) { i += 2 + (i + 1 < end ? p[i + 1] : 0); continue; }
    const n = LRRP_POS[t];
    if (n && i + 8 < end && Number.isNaN(lat)) {
      const a = u32(i + 1), o = u32(i + 5);
      lat = (a & 0x7fffffff) * 90 / 2147483648 * (a >= 0x80000000 ? -1 : 1);
      lon = (o | 0) * 180 / 2147483648;
      i += n; continue;
    }
    if (t === 0x56 && i + 1 < end) heading = p[i + 1] * 2;
    i += LRRP_SKIP[t] ?? 1;
  }
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon, source: 'lrrp', heading };
}
