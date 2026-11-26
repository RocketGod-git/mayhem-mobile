/**
 * NXDN data calls and the Kenwood talker alias (NXDN TS 1-A v1.3), on top of nxdn.ts. No DOM.
 *
 *  - UDCH and FACCH2 (4.5.2.3): 184 bits (SR and 22 octets of layer 3), a 15-bit CRC (X^15 + X^14 + X^11 + X^10 +
 *    X^7 + X^6 + X^2 + 1, from a register of ones), 4 tail bits, the K = 5 code punctured like the CAC to 348 bits, a 29
 *    by 12 interleaver. Sent alone after the LICH on a traffic channel whose functional channel is 01 (option 11:
 *    FACCH2).
 *  - A data call: the header (DCALL_HDR 0x09, or SDCALL_REQ 0x38 for short data): call type, source and destination,
 *    the cipher and key, then the packet information (delivery, selective retransmission, the frames that follow less
 *    one in 4 bits, the pad octets in 5); then DCALL_UDT frames (0x0B): the frame and block numbers, 20 octets of user
 *    data. The last 4 octets of the data are its CRC-32.
 *  - What the data says: NMEA (RMC, GGA, GLL, any talker) and Kenwood's $PKNSH (latitude, longitude like GLL), else
 *    text (a short message).
 *  - STAT_REQ and STAT_RESP (0x32, 0x33): source, destination and the 8-bit status.
 *  - The Kenwood talker alias is not published: read as a proprietary message (type 0x3F) from manufacturer 0x68,
 *    function 0x82, then the block number and count (a nibble each) and ASCII to the end, in a SACCH superframe or a
 *    FACCH1, for the call's source.
 */
import { nxdnCrc, nxdnDecodeChannel } from './nxdn.js';
import { p25Crc32 } from './p25data.js';
import { posText, type UnitData, type UnitPos } from './unitdata.js';
import { parseNmea } from '../hamid/gps.js';

const field = (b: ArrayLike<number>, at: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + b[at + k]; return v; };
export const nxdnCrc15 = (bits: ArrayLike<number>, n: number) => nxdnCrc(bits, n, 15, 0x4cc5);
const UDCH_KEEP = [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1];
/** UDCH or FACCH2: 348 received bits (or soft values) to the 184 of SR and layer 3, null when the CRC fails. */
export function nxdnUdch(rx: ArrayLike<number>, soft = false): Uint8Array | null {
  const s = soft ? rx : Float32Array.from({ length: rx.length }, (_, i) => rx[i] ? -1 : 1);
  const d = nxdnDecodeChannel(s, 29, 12, UDCH_KEEP, 203);
  return nxdnCrc15(d, 184) === field(d, 184, 15) ? d.slice(0, 184) : null;
}
/** The other way, for the tests: 23 octets (SR first) to the 348 coded bits as sent. */
export function nxdnUdchEncode(o: ArrayLike<number>): Uint8Array {
  const info = new Uint8Array(203);
  for (let i = 0; i < 184; i++) info[i] = (o[i >> 3] >> (7 - (i & 7))) & 1;
  const c = nxdnCrc15(info, 184); for (let i = 0; i < 15; i++) info[184 + i] = (c >> (14 - i)) & 1;
  const at = (k: number) => k >= 0 ? info[k] : 0, coded: number[] = [];
  for (let k = 0; k < 203; k++) { coded.push(at(k) ^ at(k - 3) ^ at(k - 4)); coded.push(at(k) ^ at(k - 1) ^ at(k - 2) ^ at(k - 4)); }
  const p = coded.filter((_, i) => UDCH_KEEP[i % 14]), out = new Uint8Array(348);
  let j = 0; for (let c2 = 0; c2 < 12; c2++) for (let r = 0; r < 29; r++) out[j++] = p[r * 12 + c2];
  return out;
}

export interface NxdnDataHeader { type: number; callType: number; src: number; dst: number; cipher: number; keyId: number; confirmed: boolean; frames: number; pad: number }
/** DCALL_HDR or SDCALL_REQ from its octets. */
export function nxdnDataHeader(o: ArrayLike<number>): NxdnDataHeader {
  const pi = (o[8] << 8) | o[9];
  return { type: o[0] & 0x3f, callType: o[2] >> 5, src: (o[3] << 8) | o[4], dst: (o[5] << 8) | o[6], cipher: o[7] >> 6, keyId: o[7] & 0x3f, confirmed: (pi & 0x8000) !== 0, frames: ((pi >> 10) & 15) + 1, pad: (pi >> 5) & 31 };
}

/** "4807.038" with "N" → degrees. */
const dm = (v: string, hemi: string, deg: number) => {
  if (!new RegExp(`^\\d{${deg + 2}}(\\.\\d+)?$`).test(v)) return NaN;
  const x = parseInt(v.slice(0, deg), 10) + parseFloat(v.slice(deg)) / 60;
  return hemi === 'S' || hemi === 'W' ? -x : hemi === 'N' || hemi === 'E' ? x : NaN;
};
/** Kenwood's $PKNSH (latitude, N/S, longitude, E/W, time, status, ...), its checksum checked; or any NMEA position. */
export function kenwoodPosition(line: string): UnitPos | null {
  const s = line.trim();
  if (!s.startsWith('$PKNSH,')) return parseNmea(s);
  const star = s.lastIndexOf('*'); if (star < 0) return null;
  let x = 0; for (let i = 1; i < star; i++) x ^= s.charCodeAt(i);
  if (parseInt(s.slice(star + 1, star + 3), 16) !== x) return null;
  const f = s.slice(1, star).split(',');
  if (f.length >= 7 && f[6] && f[6] !== 'A') return null;
  const lat = dm(f[1], f[2], 2), lon = dm(f[3], f[4], 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon, source: 'kenwood' };
}
/** The printable runs of 4 or more characters in some bytes, joined. */
const textRuns = (b: ArrayLike<number>) => {
  let s = '', run = '';
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i] : 0;
    if ((c >= 0x20 && c <= 0x7e) || c === 10 || c === 13) run += String.fromCharCode(c);
    else { if (run.trim().length >= 4) s += (s ? ' ' : '') + run; run = ''; }
  }
  return s.trim();
};
const hexOf = (b: ArrayLike<number>) => Array.from(b, x => (x & 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * One channel's data calls, statuses and aliases: fed every layer 3 message the framer reads (in order), it hands back
 * what a unit sent once it is whole.
 */
export class NxdnDataReader {
  private hdr: NxdnDataHeader | null = null; private parts = new Map<number, Uint8Array>();
  private talker = 0; private alias: string[] = []; private aliasN = 0; private aliasDone = '';
  reset(): void { this.hdr = null; this.parts.clear(); this.talker = 0; this.alias = []; this.aliasN = 0; this.aliasDone = ''; }
  /** A message's octets (its type in octet 0). */
  push(o: Uint8Array): UnitData[] {
    const type = o[0] & 0x3f, out: UnitData[] = [];
    if (type === 0x01) { const src = (o[3] << 8) | o[4]; if (src !== this.talker) { this.talker = src; this.alias = []; this.aliasN = 0; this.aliasDone = ''; } }
    else if (type === 0x09 || type === 0x38) { this.hdr = nxdnDataHeader(o); this.parts.clear(); }
    else if (type === 0x0b && this.hdr) {
      const n = o[1] >> 4; this.parts.set(n, o.slice(2, 22));
      if (this.parts.size >= this.hdr.frames) { const d = this.done(); if (d) out.push(d); }
    } else if (type === 0x32 || type === 0x33) {
      const src = (o[3] << 8) | o[4], dst = (o[5] << 8) | o[6], status = o[7];
      out.push({ proto: 'NXDN', unit: src, kind: 'status', name: type === 0x32 ? 'STAT_REQ' : 'STAT_RESP', line: `${type === 0x32 ? 'STAT_REQ' : 'STAT_RESP'} · UNIT ${src} → ${dst} · STATUS ${status}`, hex: hexOf(o), status });
    } else if (type === 0x3f && o[1] === 0x68 && o[2] === 0x82 && this.talker) {
      const blk = o[3] >> 4, of = o[3] & 15;
      if (blk >= 1 && blk <= of) {
        if (of !== this.aliasN) { this.alias = []; this.aliasN = of; }
        this.alias[blk - 1] = String.fromCharCode(...Array.from(o.subarray(4)).filter(c => c >= 0x20 && c <= 0x7e));
        const name = this.alias.length === of && [...this.alias].every(x => x !== undefined) ? this.alias.join('').trim() : '';
        if (name && name !== this.aliasDone) {
          this.aliasDone = name;
          out.push({ proto: 'NXDN', unit: this.talker, kind: 'alias', name: 'TALKER ALIAS', line: `TALKER ALIAS · UNIT ${this.talker} · "${name}"`, hex: hexOf(o), alias: name });
        }
      }
    }
    return out;
  }
  /** The data call put together: its position or its text. */
  private done(): UnitData | null {
    const h = this.hdr!; this.hdr = null;
    const all: number[] = []; for (let i = 0; i < h.frames; i++) { const p = this.parts.get(i); if (!p) return null; all.push(...p); }
    this.parts.clear();
    const n = Math.max(0, all.length - 4), crc = ((all[n] << 24) | (all[n + 1] << 16) | (all[n + 2] << 8) | all[n + 3]) >>> 0;
    const crcOk = p25Crc32(all, n) === crc, data = all.slice(0, Math.max(0, n - h.pad));
    const name = h.type === 0x38 ? 'SHORT DATA' : 'DATA CALL', who = `UNIT ${h.src} → ${h.callType < 2 ? 'TG' : 'UNIT'} ${h.dst}`;
    const d: UnitData = { proto: 'NXDN', unit: h.src, kind: 'data', name, line: '', hex: hexOf(data) };
    if (h.cipher) { d.encrypted = true; d.line = `${name} · ${who} · ENCRYPTED · KEY ${h.keyId}`; return d; }
    const text = textRuns(data);
    for (const s of text.split(/\s*(?=\$)|[\r\n]+/)) { const p = s.startsWith('$') ? kenwoodPosition(s) : null; if (p) { d.position = p; d.kind = 'GPS'; break; } }
    if (!d.position && text) { d.message = text; d.kind = 'message'; }
    d.line = `${name} · ${who}${d.position ? ` · GPS ${posText(d.position)}` : d.message ? ` · "${d.message}"` : ''}${crcOk ? '' : ' · CRC failed'}`;
    return d;
  }
}
