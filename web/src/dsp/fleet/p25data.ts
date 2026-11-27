/**
 * P25 Phase 1 packet data, receive only (TIA-102.BAAA common air interface, TIA-102.BAEB SNDCP), and the vendor GPS
 * link control words. No DOM.
 *
 *  - A data frame (DUID C) is the sync, the NID, then blocks of 98 dibits, the status symbol after every 35 as ever.
 *    The first block is the header: 12 octets through the rate 1/2 trellis, the last two a CRC-CCITT of the ten before.
 *  - Header: octet 0 A/N (0x40, confirmed), I/O (0x20, outbound) and the format (0x16 confirmed, 0x15 unconfirmed,
 *    0x03 response, 0x17 alternate multiple block trunking); octet 1 the SAP (6 bits); 2 the manufacturer; 3 to 5 the
 *    logical link ID (the unit: the source inbound, the destination outbound); 6 FMF and the blocks to follow (7 bits);
 *    7 the pad octets (5 bits); 8 (confirmed) synchronize, N(S) and the fragment sequence; 9 the data header offset.
 *  - Confirmed blocks: rate 3/4 trellis, 18 octets: a 7-bit serial number, a CRC-9 (x^9 + x^6 + x^4 + x^3 + 1, the
 *    remainder inverted) over the serial and the data, 16 data octets. Unconfirmed blocks: rate 1/2, 12 data octets.
 *    The last block ends in the packet CRC-32 (x^32 + x^26 + x^23 + ... + 1, inverted) over every data octet before it.
 *  - SAP 4 (packet data): SNDCP's two octets (PDU type and NSAPI, the compression) ahead of an IPv4 datagram; the data
 *    header offset says how many. In the datagram, UDP: Motorola LRRP (port 4001), ETSI LIP (5017), NMEA text on any.
 *  - The Harris and Motorola GPS link controls are not published: read as an LDU1 link control from manufacturer A4
 *    (Harris) or 90 (Motorola), opcode 2A, with the latitude in octets 2 to 4 (24 bits two's complement, 90/2^23
 *    degrees) and the longitude in 5 to 7 (24 bits two's complement, 180/2^23 degrees). It names no unit: it is the
 *    talker's.
 */
import { crc12Ok, crcCcitt, tsbkDecode, tsbkEncode, nidEncode, syncSigns, isStatusPos, P25_SYNC, hex } from './codes.js';
import { rate34Decode, rate34Encode, lrrpReport, lipShortReport } from '../hamid/dmrdata.js';
import { parseNmea } from '../hamid/gps.js';
import { posText, type UnitData, type UnitPos } from './unitdata.js';
export type { UnitData };

export interface P25PduHeader {
  confirmed: boolean; outbound: boolean; format: number; sap: number; mfid: number; llid: number;
  fmf: boolean; blocks: number; pad: number; ns: number; fsn: number; dho: number; hex: string;
}
export interface P25Packet extends UnitData {
  header: P25PduHeader; blocksOk: number; crcOk: boolean;
  /** The user data, pad and CRC taken off. */
  data: Uint8Array;
  ip?: { src: string; dst: string; proto: number; sport: number; dport: number };
}

export const P25_SAP: Record<number, string> = {
  0: 'USER DATA', 1: 'ENCRYPTED USER DATA', 2: 'CIRCUIT DATA', 3: 'CIRCUIT DATA CONTROL', 4: 'PACKET DATA', 5: 'ARP',
  6: 'SNDCP CONTROL', 31: 'EXTENDED ADDRESS', 32: 'REGISTRATION AND AUTHORIZATION', 33: 'CHANNEL REASSIGNMENT',
  34: 'SYSTEM CONFIGURATION', 35: 'LOOPBACK', 36: 'STATISTICS', 37: 'OUT OF SERVICE', 38: 'PAGING', 39: 'CONFIGURATION',
  40: 'KEY MANAGEMENT', 41: 'ENCRYPTED KEY MANAGEMENT', 61: 'TRUNKING CONTROL', 63: 'PROTECTED TRUNKING CONTROL',
};
const FORMAT: Record<number, string> = { 0x03: 'RESPONSE', 0x15: 'UNCONFIRMED DATA', 0x16: 'CONFIRMED DATA', 0x17: 'ALTERNATE TRUNKING' };

/** The header's 12 octets (its CRC already checked). */
export function p25PduHeader(b: ArrayLike<number>): P25PduHeader {
  return {
    confirmed: (b[0] & 0x40) !== 0, outbound: (b[0] & 0x20) !== 0, format: b[0] & 0x1f, sap: b[1] & 0x3f, mfid: b[2],
    llid: (b[3] << 16) | (b[4] << 8) | b[5], fmf: (b[6] & 0x80) !== 0, blocks: b[6] & 0x7f, pad: b[7] & 0x1f,
    ns: (b[8] >> 4) & 7, fsn: b[8] & 0xf, dho: b[9] & 0x3f, hex: hex(b, 0, 12).toUpperCase(),
  };
}

// ------------------------------------------------------------------------------------------------ CRCs
/** CRC-9 of a confirmed block: the 7-bit serial, then the 16 data octets. */
export function p25Crc9(serial: number, data: ArrayLike<number>): number {
  let r = 0;
  const bit = (x: number) => { const fb = ((r >> 8) & 1) ^ x; r = (r << 1) & 0x1ff; if (fb) r ^= 0x059; };
  for (let i = 6; i >= 0; i--) bit((serial >> i) & 1);
  for (let i = 0; i < 16; i++) for (let j = 7; j >= 0; j--) bit((data[i] >> j) & 1);
  return r ^ 0x1ff;
}
const CRC32_T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; CRC32_T[i] = c >>> 0; }
/** The packet CRC-32 over the first [n] octets: MSB first, register from zero, the remainder inverted. */
export function p25Crc32(b: ArrayLike<number>, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) c = ((c << 8) ^ CRC32_T[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return (~c) >>> 0;
}

// ------------------------------------------------------------------------------------------------ blocks
const toBits = (d: ArrayLike<number>) => { const r = new Uint8Array(196); for (let k = 0; k < 98; k++) { r[2 * k] = (d[k] >> 1) & 1; r[2 * k + 1] = d[k] & 1; } return r; };
const toDibits = (r: ArrayLike<number>) => { const d = new Uint8Array(98); for (let k = 0; k < 98; k++) d[k] = (r[2 * k] << 1) | r[2 * k + 1]; return d; };
/** A confirmed block's 98 dibits: serial, CRC-9 and 16 data octets. */
export function p25Block34(d: ArrayLike<number>): { serial: number; data: Uint8Array; ok: boolean } {
  const { bytes } = rate34Decode(toBits(d)), serial = bytes[0] >> 1, crc = ((bytes[0] & 1) << 8) | bytes[1], data = bytes.slice(2, 18);
  return { serial, data, ok: p25Crc9(serial, data) === crc };
}

/**
 * The blocks of one data frame put back into a packet: [push] each block's 98 dibits, the header first; it says when
 * the frame is done (the blocks the header named came, or the header failed its CRC).
 */
export class P25PduReader {
  onPacket: (p: P25Packet) => void = () => undefined;
  private hdr: P25PduHeader | null = null; private got: { data: Uint8Array; ok: boolean; serial: number }[] = [];
  start(): void { this.hdr = null; this.got = []; }
  /** One block: true while more are wanted. */
  push(d: ArrayLike<number>): boolean {
    if (!this.hdr) {
      const { bytes } = tsbkDecode(d);
      if (!crc12Ok(bytes)) return false;
      const h = p25PduHeader(bytes);
      if (h.format !== 0x15 && h.format !== 0x16) return false;
      this.hdr = h;
      if (!h.blocks) return false;
      return true;
    }
    const h = this.hdr;
    if (h.confirmed) this.got.push(p25Block34(d));
    else { const { bytes } = tsbkDecode(d); this.got.push({ data: bytes, ok: true, serial: this.got.length }); }
    if (this.got.length < h.blocks) return true;
    this.onPacket(p25Packet(h, this.got));
    return false;
  }
}

/** The packet in a header and its blocks (confirmed blocks put in serial order). */
export function p25Packet(h: P25PduHeader, blocks: { data: Uint8Array; ok: boolean; serial: number }[]): P25Packet {
  const per = h.confirmed ? 16 : 12, all = new Uint8Array(per * blocks.length);
  const order = h.confirmed ? [...blocks].sort((a, b) => a.serial - b.serial) : blocks;
  order.forEach((b, i) => all.set(b.data, per * i));
  const n = Math.max(0, all.length - 4), crc = ((all[n] << 24) | (all[n + 1] << 16) | (all[n + 2] << 8) | all[n + 3]) >>> 0;
  const crcOk = blocks.length > 0 && p25Crc32(all, n) === crc;
  const data = all.slice(0, Math.max(0, n - h.pad));
  const p: P25Packet = {
    proto: 'P25', unit: h.llid, kind: 'packet data', name: FORMAT[h.format] ?? 'DATA', line: '', hex: hex(data).toUpperCase(),
    header: h, blocksOk: blocks.filter(b => b.ok).length, crcOk, data, encrypted: h.sap === 1,
  };
  if (crcOk && h.sap === 4) readIp(p);
  p.line = p25PacketLine(p);
  return p;
}

const ipText = (b: ArrayLike<number>, i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
/** An IPv4 header with a good checksum at [at]: its length and the protocol. */
function ipv4At(b: Uint8Array, at: number): { ihl: number; len: number } | null {
  if (b.length < at + 20 || (b[at] >> 4) !== 4) return null;
  const ihl = (b[at] & 15) * 4; if (ihl < 20 || b.length < at + ihl) return null;
  let s = 0; for (let i = 0; i < ihl; i += 2) s += (b[at + i] << 8) | b[at + i + 1];
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return s === 0xffff ? { ihl, len: Math.min(b.length - at, (b[at + 2] << 8) | b[at + 3]) } : null;
}
/** SNDCP's datagram: at the data header offset, else after SNDCP's two octets, else at the start. */
function readIp(p: P25Packet): void {
  const b = p.data;
  for (const at of [p.header.dho, 2, 0]) {
    const v = ipv4At(b, at); if (!v) continue;
    const ip = b.subarray(at, at + v.len), proto = ip[9];
    p.ip = { src: ipText(ip, 12), dst: ipText(ip, 16), proto, sport: 0, dport: 0 };
    if (proto !== 17 || ip.length < v.ihl + 8) return;
    const u = ip.subarray(v.ihl), sport = (u[0] << 8) | u[1], dport = (u[2] << 8) | u[3];
    const pay = u.subarray(8, Math.min(u.length, Math.max(8, (u[4] << 8) | u[5])));
    p.ip.sport = sport; p.ip.dport = dport;
    const lrrp = sport === 4001 || dport === 4001 ? lrrpReport(pay) : null;
    if (lrrp) { p.position = lrrp; p.kind = 'LRRP'; return; }
    const lip = dport === 5017 ? lipShortReport(pay) : null;
    if (lip) { p.position = { lat: lip.lat, lon: lip.lon, source: lip.source, heading: lip.heading }; p.kind = 'LIP'; return; }
    const text = printable(pay);
    if (text) {
      for (const s of text.split(/[\r\n]+/)) { const pos = s.startsWith('$') ? parseNmea(s) : null; if (pos) { p.position = pos; p.kind = 'NMEA'; return; } }
      p.message = text; p.kind = 'text';
    }
    return;
  }
}
/** Bytes as text when they all are (printable ASCII, tabs and line ends), '' otherwise. */
export function printable(b: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < b.length; i++) { const c = b[i]; if (c === 0 && i === b.length - 1) break; if ((c < 0x20 || c > 0x7e) && c !== 9 && c !== 10 && c !== 13) return ''; s += String.fromCharCode(c); }
  return s.trim();
}

/** One packet in words, for the log. */
export function p25PacketLine(p: P25Packet): string {
  const h = p.header, parts = [p.name, `${P25_SAP[h.sap] ?? `SAP ${h.sap}`}`, `${h.outbound ? 'TO' : 'FROM'} UNIT ${h.llid}`];
  if (h.mfid) parts.push(`MFID ${h.mfid.toString(16).toUpperCase().padStart(2, '0')}`);
  parts.push(`${h.blocks} blocks${h.confirmed ? ` (${p.blocksOk} through their CRC)` : ''}`);
  if (!p.crcOk) parts.push('packet CRC failed');
  if (p.encrypted) parts.push('ENCRYPTED');
  if (p.ip) parts.push(`IP ${p.ip.src} → ${p.ip.dst}${p.ip.proto === 17 ? ` · UDP ${p.ip.sport} → ${p.ip.dport}` : ` · protocol ${p.ip.proto}`}`);
  if (p.position) parts.push(`${p.kind} ${posText(p.position)}`);
  if (p.message) parts.push(`"${p.message}"`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------------------------------------ GPS link control
const GPS_LC: Record<number, string> = { 0xa4: 'HARRIS', 0x90: 'MOTOROLA' };
/** A vendor GPS link control (its 9 octets), for the talker [unit]; null for any other. */
export function p25GpsLc(b: ArrayLike<number>, unit: number): UnitData | null {
  const vendor = GPS_LC[b[1]];
  if (!vendor || (b[0] & 0x3f) !== 0x2a || (b[0] & 0x80)) return null;
  const s24 = (i: number) => { const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]; return v & 0x800000 ? v - 0x1000000 : v; };
  const lat = s24(2) * 90 / 8388608, lon = s24(5) * 180 / 8388608;
  if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const position: UnitPos = { lat, lon, source: `${vendor.toLowerCase()}-lc` }, h = hex(b, 0, 9).toUpperCase();
  return { proto: 'P25', unit, kind: 'GPS', name: `${vendor} GPS`, line: `${vendor} GPS · UNIT ${unit || '?'} · ${posText(position)}`, hex: h, position };
}

// ------------------------------------------------------------------------------------------------ encoders (tests)
/** A packet's blocks (98 dibits each, the header first). The CRCs, pad and serials are filled in. */
export function p25PduEncode(o: { confirmed: boolean; outbound?: boolean; sap: number; mfid?: number; llid: number; data: ArrayLike<number>; dho?: number }): Uint8Array[] {
  const per = o.confirmed ? 16 : 12, n = Math.max(1, Math.ceil((o.data.length + 4) / per)), pad = n * per - 4 - o.data.length;
  const all = new Uint8Array(n * per); all.set(Array.from(o.data));
  const c = p25Crc32(all, all.length - 4); all[all.length - 4] = c >>> 24; all[all.length - 3] = (c >> 16) & 255; all[all.length - 2] = (c >> 8) & 255; all[all.length - 1] = c & 255;
  const h = new Uint8Array(12);
  h[0] = (o.confirmed ? 0x40 : 0) | (o.outbound ? 0x20 : 0) | (o.confirmed ? 0x16 : 0x15); h[1] = 0xc0 | o.sap; h[2] = o.mfid ?? 0;
  h[3] = (o.llid >> 16) & 255; h[4] = (o.llid >> 8) & 255; h[5] = o.llid & 255; h[6] = 0x80 | n; h[7] = pad; h[8] = o.confirmed ? 0x80 : 0; h[9] = o.dho ?? 0;
  const hc = crcCcitt(h, 10); h[10] = hc >> 8; h[11] = hc & 255;
  const out = [tsbkEncode(h)];
  for (let i = 0; i < n; i++) {
    const d = all.subarray(per * i, per * i + per);
    if (!o.confirmed) { out.push(tsbkEncode(d)); continue; }
    const b = new Uint8Array(18), crc = p25Crc9(i, d); b[0] = (i << 1) | (crc >> 8); b[1] = crc & 255; b.set(d, 2);
    out.push(toDibits(rate34Encode(b)));
  }
  return out;
}
/** One data frame: sync, NID (DUID C), the blocks, the status symbols put in. */
export function p25DataSymbols(nac: number, blocks: ArrayLike<number>[], status = 1): Uint8Array {
  const info: number[] = [];
  for (const s of syncSigns(P25_SYNC)) info.push(s > 0 ? 1 : 3);
  for (const d of nidEncode(nac, 0xc)) info.push(d);
  for (const b of blocks) for (let i = 0; i < b.length; i++) info.push(b[i]);
  const out: number[] = [];
  let k = 0;
  while (k < info.length) { if (isStatusPos(out.length)) out.push(status); else out.push(info[k++]); }
  while (out.length % 36 !== 0 && !isStatusPos(out.length)) out.push(0);
  if (isStatusPos(out.length)) out.push(status);
  return Uint8Array.from(out);
}
