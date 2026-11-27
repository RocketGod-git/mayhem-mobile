/**
 * DMR packet data put back together (ETSI TS 102 361-1 V2.6.1: 8.2, 9.2, 9.3, B.2.5, B.3.8 to B.3.10, B.3.12) and read
 * for what it carries. Written from the standard:
 *
 *   · Data header (9.2): its Data Packet Format (table 9.30) says which layout follows: 0 UDT, 1 response, 2
 *     unconfirmed, 3 confirmed, 13 defined short data, 14 raw or status/precoded short data, 15 the second header of a
 *     proprietary packet (SAP 9). G/I, A, the SAP (table 9.31), the 5-bit pad octet count, the destination and source
 *     LLIDs, the blocks to follow (6-bit AB for short data, UAB + 1 for UDT), the DD or UDT format, the pad nibbles.
 *   · Blocks: rate 1/2 (BPTC, 12 octets), rate 3/4 (trellis, 18, dmrdata.ts) and rate 1 (24: the 196 bits are 96, four
 *     zero pad bits, 96, table B.10B). A confirmed block opens with its 7-bit serial number and a CRC-9 (B.3.10,
 *     x^9 + x^6 + x^4 + x^3 + 1, inverted, masked 0F0, 1FF or 10F by rate) over its data and the serial number.
 *   · The last block ends in the 32-bit message CRC (B.3.9) over the data and pad octets of every block: the octets
 *     taken in swapped pairs, x^32 + x^26 + x^23 + x^22 + x^16 + x^12 + x^11 + x^10 + x^8 + x^7 + x^5 + x^4 + x^2 + x + 1
 *     from zero, the CRC sent least significant octet first (read either way round here). UDT ends in a CRC-CCITT
 *     instead (9.2.14), over all its appended blocks, no mask.
 *   · What it carries: IPv4 (SAP 4) with UDP to LIP (5017), Motorola LRRP (4001) or Motorola TMS text (4007); NMEA
 *     sentences with good checksums; the text of defined short data (DD format, table 9.50: 2 is 7-bit characters, 3 to
 *     17 ISO 8859, 18 UTF-8, 19 to 21 UTF-16) or of a UDT (table 9.51: 3 ISO 7-bit, 4 ISO 8-bit, 7 UTF-16BE, 10 an
 *     address then UTF-16BE); a status/precoded short data value. IP header compression (SAP 2, 3) is not read.
 * Motorola's TMS is not a published standard: its layout (a length, a header octet, an address, header extension
 * octets, then UTF-16LE text) is read from public descriptions of captured traffic. No DOM.
 */
import { crcCcitt } from '../fleet/codes.js';
import { parseNmea, type Position } from './gps.js';
import { lipShortReport, lrrpReport, udpPayload } from './dmrdata.js';

/** Bits [from, from + n) of a byte array, MSB first. */
const field = (b: ArrayLike<number>, from: number, n: number) => { let v = 0; for (let i = from; i < from + n; i++) v = v * 2 + ((b[i >> 3] >> (7 - (i & 7))) & 1); return v; };
const u24 = (b: ArrayLike<number>, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

/** The 196 payload bits of a data burst's dibits (before and after the center field). */
export function dmrPayloadBits(d: ArrayLike<number>): Uint8Array {
  const raw = new Uint8Array(196); let p = 0;
  for (let i = 12; i <= 60; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  for (let i = 95; i <= 143; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  return raw;
}
/** Rate 1 coded data (B.2.5): the 196 bits are info bits 191 to 96, four pad bits, then 95 to 0. → 24 octets. */
export function rate1Bytes(raw: ArrayLike<number>): Uint8Array {
  const o = new Uint8Array(24);
  for (let k = 0; k < 192; k++) if (raw[k < 96 ? k : k + 4] & 1) o[k >> 3] |= 0x80 >> (k & 7);
  return o;
}

/** The 32-bit message CRC (B.3.9) over [n] octets: in swapped pairs (each word's low octet first), from zero. */
export function dmrCrc32(b: ArrayLike<number>, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) {
    c = (c ^ ((b[i ^ 1] ?? 0) << 24)) >>> 0;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c;
}
/** The CRC-9 of a confirmed block (B.3.10): its data octets then the 7-bit serial number, inverted. */
export function dmrCrc9(b: ArrayLike<number>, from: number, n: number, sn: number): number {
  let r = 0;
  const bit = (x: number) => { const fb = ((r >> 8) & 1) ^ x; r = (r << 1) & 0x1ff; if (fb) r ^= 0x059; };
  for (let i = 0; i < 8 * n; i++) bit((b[from + (i >> 3)] >> (7 - (i & 7))) & 1);
  for (let i = 6; i >= 0; i--) bit((sn >> i) & 1);
  return r ^ 0x1ff;
}
/** Table B.21: the CRC-9 mask of a confirmed block, by its size (12, 18 or 24 octets). */
const CRC9_MASK: Record<number, number> = { 12: 0x0f0, 18: 0x1ff, 24: 0x10f };

export interface DataHeader {
  /** Data Packet Format (table 9.30). */
  dpf: number; group: boolean; ack: boolean; sap: number; dst: number; src: number;
  /** Blocks after this header (BF, AB, or UAB + 1). */
  blocks: number;
  /** Pad octets (POC), pad bits (short data's bit padding) or pad nibbles (UDT). */
  pad: number;
  /** Defined short data: the DD format; UDT: the UDT format; else -1. */
  format: number;
  /** UDT: its opcode; status/precoded short data: the 10-bit value; a response: class, type, status (8 bits); else -1. */
  code: number;
  /** Proprietary: the manufacturer's ID of the second header, else -1. */
  mfid: number;
}
/** A data header's 12 octets (the CRC already checked), or null for a reserved format. */
export function dataHeader(b: ArrayLike<number>): DataHeader | null {
  const dpf = b[0] & 15, h: DataHeader = { dpf, group: (b[0] & 0x80) !== 0, ack: (b[0] & 0x40) !== 0, sap: b[1] >> 4, dst: u24(b, 2), src: u24(b, 5), blocks: b[8] & 0x7f, pad: 0, format: -1, code: -1, mfid: -1 };
  switch (dpf) {
    case 0: h.format = b[1] & 15; h.pad = b[8] >> 3; h.blocks = (b[8] & 3) + 1; h.code = b[9] & 0x3f; return h;
    case 1: h.code = b[9]; return h;
    case 2: case 3: h.pad = (b[0] & 0x10) | (b[1] & 15); return h;
    case 13: case 14:
      h.blocks = (b[0] & 0x30) | (b[1] & 15);
      if (dpf === 13) { h.format = b[8] >> 2; h.pad = b[9]; }
      else if (h.blocks) h.pad = b[9];
      else h.code = ((b[8] & 3) << 8) | b[9];
      return h;
    case 15: h.sap = b[0] >> 4; h.mfid = b[1]; h.blocks = 0; return h;
    default: return null;
  }
}
/** The DPF in words. */
export const dpfName = (dpf: number) => ({ 0: 'UDT', 1: 'RESPONSE', 2: 'UNCONFIRMED DATA', 3: 'CONFIRMED DATA', 13: 'DEFINED SHORT DATA', 14: 'SHORT DATA', 15: 'PROPRIETARY DATA' } as Record<number, string>)[dpf] ?? `DPF ${dpf}`;

export interface DmrPdu {
  hdr: DataHeader;
  /** The user data, pad octets and the CRC taken off. */
  data: Uint8Array;
  /** How many bits of [data] are data (short data and UDT end mid-octet). */
  bits: number;
  /** The message CRC (or a UDT's CRC-CCITT) checked. */
  crcOk: boolean;
  /** Octets per block: 12 rate 1/2, 18 rate 3/4, 24 rate 1. */
  size: number;
}

/**
 * One slot's packet data: a data header opens a PDU, the blocks it announced fill it. A header that comes before the
 * last block starts over; so does a block at another rate.
 */
export class DmrPduAssembler {
  private hdr: DataHeader | null = null;
  private blocks: (Uint8Array | null)[] = [];
  private size = 0; private next = 0;

  reset(): void { this.hdr = null; this.blocks = []; this.size = 0; this.next = 0; }
  get open(): boolean { return this.hdr !== null; }

  /** A data header that passed its CRC (mask CCCC). A proprietary second header joins the packet before it. */
  header(b: ArrayLike<number>): DataHeader | null {
    const h = dataHeader(b);
    if (!h) { this.reset(); return null; }
    if (h.dpf === 15 && this.hdr && this.hdr.sap === 9 && this.next === 0 && this.hdr.mfid < 0) {
      this.hdr.mfid = h.mfid; this.hdr.blocks = Math.max(0, this.hdr.blocks - 1); this.blocks = new Array(this.hdr.blocks).fill(null);
      return this.hdr;
    }
    this.reset();
    if (h.dpf === 1 || h.dpf === 15 || (h.dpf === 14 && !h.blocks)) return h;
    if (h.blocks > 0) { this.hdr = h; this.blocks = new Array(h.blocks).fill(null); }
    return h;
  }
  /** A data block of 12, 18 or 24 octets; the PDU when this one completes it. */
  block(bytes: ArrayLike<number>): DmrPdu | null {
    const h = this.hdr; if (!h) return null;
    const n = bytes.length;
    if ((this.size && this.size !== n) || (h.dpf === 0 && n !== 12)) { this.reset(); return null; }
    this.size = n;
    const b = Uint8Array.from(bytes);
    let at = -1;
    if (h.dpf === 3) {
      // a confirmed block is placed by its serial number when its CRC-9 checks (a block sent again lands on itself)
      const sn = b[0] >> 1, c9 = ((b[0] & 1) << 8) | b[1];
      if ((dmrCrc9(b, 2, n - 2, sn) ^ CRC9_MASK[n]) === c9 && sn < this.blocks.length) at = sn;
    }
    if (at < 0) { while (this.next < this.blocks.length && this.blocks[this.next]) this.next++; at = this.next; }
    if (at >= this.blocks.length) { this.reset(); return null; }
    this.blocks[at] = b;
    if (this.blocks.some(x => !x)) return null;
    const pdu = this.assemble(h, this.blocks as Uint8Array[], n);
    this.reset();
    return pdu;
  }
  private assemble(h: DataHeader, blocks: Uint8Array[], size: number): DmrPdu {
    const parts: number[] = [];
    for (const x of blocks) for (let i = h.dpf === 3 ? 2 : 0; i < x.length; i++) parts.push(x[i]);
    if (h.dpf === 0) {
      const n = parts.length - 2, crc = (parts[n] << 8) | parts[n + 1];
      const bits = Math.max(0, 8 * n - 4 * h.pad);
      return { hdr: h, data: Uint8Array.from(parts.slice(0, (bits + 7) >> 3)), bits, crcOk: crcCcitt(parts, n) === crc, size };
    }
    const n = parts.length - 4, c = dmrCrc32(parts, n);
    const le = parts[n] | (parts[n + 1] << 8) | (parts[n + 2] << 16) | (parts[n + 3] << 24), be = (parts[n] << 24) | (parts[n + 1] << 16) | (parts[n + 2] << 8) | parts[n + 3];
    const short = h.dpf === 13 || h.dpf === 14;
    const bits = short ? Math.max(0, 8 * n - h.pad) : 8 * Math.max(0, n - h.pad);
    return { hdr: h, data: Uint8Array.from(parts.slice(0, (bits + 7) >> 3)), bits, crcOk: (le >>> 0) === c || (be >>> 0) === c, size };
  }
}

// ------------------------------------------------------------------------------------------------ what it carries
export interface DmrPduContent {
  /** 'position', 'text' or 'status'. */
  kind: string;
  /** What carried it: 'LIP', 'LRRP', 'NMEA', 'TMS', 'SHORT DATA', 'UDT'. */
  via: string;
  text: string; pos: Position | null;
  /** From LIP: speed (km/h, -1 unknown), heading (degrees, -1 unknown), position error (-1 unknown). */
  speedKmh: number; heading: number; posError: number;
}
const content = (kind: string, via: string, text: string, pos: Position | null = null): DmrPduContent => ({ kind, via, text, pos, speedKmh: -1, heading: -1, posError: -1 });

/** NMEA sentences with good checksums anywhere in a byte payload; the last one with a position. */
export function nmeaInPayload(b: ArrayLike<number>): Position | null {
  let s = ''; for (let i = 0; i < b.length; i++) { const c = b[i] & 255; s += c >= 32 && c < 127 ? String.fromCharCode(c) : '\n'; }
  let found: Position | null = null;
  for (const m of s.match(/\$[A-Z]{2}[A-Z]{3},[^$\n]*\*[0-9A-F]{2}/g) ?? []) { const p = parseNmea(m); if (p) { p.source = 'dmr-data'; found = p; } }
  return found;
}

/** Characters to text: controls (line breaks as spaces) and unpaired surrogates dropped, trimmed. */
function clean(codes: number[]): string {
  let s = '';
  for (const c of codes) { if (c === 10 || c === 13 || c === 9) s += ' '; else if (c >= 32 && c !== 0x7f && (c < 0xd800 || c > 0xdfff) && c < 0x10000) s += String.fromCharCode(c); }
  return s.replace(/\s+/g, ' ').trim();
}
const latin1 = (b: ArrayLike<number>, from: number, to: number) => { const o: number[] = []; for (let i = from; i < to; i++) o.push(b[i] & 255); return clean(o); };
const utf16 = (b: ArrayLike<number>, from: number, to: number, le: boolean) => { const o: number[] = []; for (let i = from; i + 1 < to; i += 2) o.push(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]); return clean(o); };
const iso7 = (b: ArrayLike<number>, bits: number) => { const o: number[] = []; for (let i = 0; i + 7 <= bits; i += 7) o.push(field(b, i, 7)); return clean(o); };
function utf8(b: ArrayLike<number>, from: number, to: number): string {
  const o: number[] = [];
  for (let i = from; i < to;) {
    const x = b[i] & 255, n = x < 0x80 ? 0 : x >= 0xf0 ? 3 : x >= 0xe0 ? 2 : x >= 0xc0 ? 1 : -1;
    if (n < 0 || i + n >= to) { i++; continue; }
    let c = n ? x & (0x3f >> n) : x; for (let k = 1; k <= n; k++) c = (c << 6) | (b[i + k] & 0x3f);
    o.push(c); i += n + 1;
  }
  return clean(o);
}
/** Defined short data's text by its DD format (table 9.50), '' for a format that is not text. */
export function ddText(fmt: number, b: ArrayLike<number>, bits: number): string {
  const n = bits >> 3;
  if (fmt === 2) return iso7(b, bits);
  if (fmt >= 3 && fmt <= 17) return latin1(b, 0, n);
  if (fmt === 18) return utf8(b, 0, n);
  if (fmt === 19) { const le = b[0] === 0xff && b[1] === 0xfe, bom = le || (b[0] === 0xfe && b[1] === 0xff); return utf16(b, bom ? 2 : 0, n, le); }
  if (fmt === 20 || fmt === 21) return utf16(b, 0, n, fmt === 21);
  return '';
}
/** A UDT's text by its format (table 9.51), '' for a format that is not text. */
export function udtText(fmt: number, b: ArrayLike<number>, bits: number): string {
  const n = bits >> 3;
  if (fmt === 3) return iso7(b, bits);
  if (fmt === 4) return latin1(b, 0, n);
  if (fmt === 7) return utf16(b, 0, n, false);
  if (fmt === 10) return utf16(b, 3, n, false);
  return '';
}
/**
 * Motorola TMS (UDP port 4007): a 2-octet length, a header octet (its 0x20 bit: extension octets follow), an address
 * length and that many octets, the extension octets (each with its top bit set but the last), then UTF-16LE text.
 * '' when there is no text (an acknowledgment).
 */
export function tmsText(u: ArrayLike<number>): string {
  if (u.length < 4) return '';
  const end = Math.min(u.length, 2 + ((u[0] << 8) | u[1])), hdr = u[2];
  let i = 4 + u[3];
  if (hdr & 0x20) while (i < end && (u[i++] & 0x80)) { /* the extension octets */ }
  return i < end ? utf16(u, i, end, true) : '';
}

/**
 * What a PDU carries. Positions in IP (the IP header checksum) and NMEA (its own checksum) are read whatever the
 * message CRC says; text and status only when it checked.
 */
export function dmrPduContent(p: DmrPdu): DmrPduContent | null {
  const h = p.hdr, d = p.data;
  if (h.dpf === 13 && p.crcOk) { const t = ddText(h.format, d, p.bits); if (t) return content('text', 'SHORT DATA', t); }
  if (h.dpf === 0 && p.crcOk) { const t = udtText(h.format, d, p.bits); if (t) return content('text', 'UDT', t); }
  const u = udpPayload(d);
  if (u) {
    if (u.dport === 5017) {
      const r = lipShortReport(u.data);
      if (r) { const x = content('position', 'LIP', '', { lat: r.lat, lon: r.lon, source: r.source }); x.speedKmh = r.speedKmh; x.heading = r.heading; x.posError = r.posError; return x; }
    }
    if (u.dport === 4001 || u.sport === 4001) { const r = lrrpReport(u.data); if (r) { const x = content('position', 'LRRP', '', { lat: r.lat, lon: r.lon, source: r.source }); x.heading = r.heading; return x; } }
    if (u.dport === 4007 || u.sport === 4007) { const t = tmsText(u.data); if (t) return content('text', 'TMS', t); }
  }
  const pos = nmeaInPayload(d);
  if (pos) return content('position', 'NMEA', '', pos);
  return null;
}
