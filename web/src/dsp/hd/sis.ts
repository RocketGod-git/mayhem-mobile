/** Station Information Service on the PIDS channel (1020s rev K, section 4); only PDUs whose CRC-12 verifies are voted. */

const CHARS5 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ?-*$';
export const SIS_PAYLOAD = [32, 22, 58, 32, 27, 58, 27, 22, 58, 58, 27];

export type SisMsg =
  | { kind: 'id'; country: string; facility: number }
  | { kind: 'short'; name: string }
  | { kind: 'long'; last: number; frame: number; chars: string; seq: number }
  | { kind: 'loc'; high: boolean; deg: number; alt: number }
  | { kind: 'smsg'; frame: number; seq: number; priority?: number; encoding?: number; length?: number; checksum?: number; bytes: number[] }
  | { kind: 'svc'; adv: boolean; audio: boolean; access: number; program: number; progType: number; soundExp: number; dataType: number; mime12: number }
  | { kind: 'param'; index: number; value: number }
  | { kind: 'usn'; frame: number; encoding?: number; append?: number; frames?: number; bytes: number[] }
  | { kind: 'slogan'; frame: number; encoding?: number; length?: number; bytes: number[] }
  | { kind: 'alert'; frame: number; seq: number; encoding?: number; length?: number; crc7?: number; cntLength?: number; bytes: number[] }
  | { kind: 'alfn'; alfn: number }
  | { kind: 'other'; id: number; bits: string };

export interface SisPdu { llds: boolean; msgs: SisMsg[]; timeLocked: number; advAlfn: number; crc: number; crcOk: boolean; bits: string }

const u = (b: ArrayLike<number>, a: number, n: number) => { let v = 0; for (let i = a; i < a + n; i++) v = v * 2 + (b[i] & 1); return v; };
const s = (v: number, n: number) => v >= 2 ** (n - 1) ? v - 2 ** n : v;
const bytesAt = (b: ArrayLike<number>, a: number, n: number) => Array.from({ length: n }, (_, i) => u(b, a + 8 * i, 8));
const rev16 = (v: number) => { let r = 0; for (let i = 0; i < 16; i++) r = (r << 1) | ((v >> i) & 1); return r; };

/** The 16-bit register shared by the SIS and alert control CRCs: bits fed in order, then 16 zeros, returned reversed. */
function crcReg(bits: ArrayLike<number>, initReversed = 0): number {
  let r = rev16(initReversed);
  const step = (bit: number) => { const top = r & 0x8000; r = ((r << 1) | bit) & 0xFFFF; if (top) r ^= 0x080B; };
  for (let i = 0; i < bits.length; i++) step(bits[i] & 1);
  for (let i = 0; i < 16; i++) step(0);
  return rev16(r);
}
/** 1020s 4.11: whether a PDU's CRC-12 verifies. */
export function sisCrcOk(b: ArrayLike<number>): boolean {
  const fed: number[] = []; for (let i = 67; i >= 0; i--) fed.push(b[i] & 1);
  return ((crcReg(fed) ^ 0x955) & 0xFFF) === u(b, 68, 12);
}
/** The CRC-12 field a PDU's bits 0..67 need (the synthetic transmitter). */
export function sisCrc(b: ArrayLike<number>): number {
  const fed: number[] = []; for (let i = 67; i >= 0; i--) fed.push(b[i] & 1);
  return (crcReg(fed) ^ 0x955) & 0xFFF;
}

export function parseSisMsg(id: number, b: ArrayLike<number>): SisMsg {
  switch (id) {
    case 0: { const cc = u(b, 0, 10); return { kind: 'id', country: (cc >> 5) < 26 && (cc & 31) < 26 ? CHARS5[cc >> 5] + CHARS5[cc & 31] : `#${cc}`, facility: u(b, 13, 19) }; }
    case 1: {
      let name = '';
      for (let i = 0; i < 4; i++) { const c = u(b, 5 * i, 5); name += c < 31 ? CHARS5[c] : '#'; }
      return { kind: 'short', name: name.trim() + (u(b, 20, 2) === 1 ? '-FM' : '') };
    }
    case 2: return { kind: 'long', last: u(b, 0, 3), frame: u(b, 3, 3), chars: Array.from({ length: 7 }, (_, i) => String.fromCharCode(u(b, 6 + 7 * i, 7))).join(''), seq: u(b, 55, 3) };
    // reserved in the documents; on air it is the frame's whole 32-bit ALFN (KLOS: equal to the ADV ALFN pairs)
    case 3: return { kind: 'alfn', alfn: u(b, 0, 32) };
    case 4: return { kind: 'loc', high: u(b, 0, 1) === 1, deg: s(u(b, 1, 22), 22) / 8192, alt: u(b, 23, 4) };
    case 5: {
      const frame = u(b, 0, 5), seq = u(b, 5, 2);
      if (frame === 0) return { kind: 'smsg', frame, seq, priority: u(b, 7, 1), encoding: u(b, 8, 3), length: u(b, 11, 8), checksum: u(b, 19, 7), bytes: bytesAt(b, 26, 4) };
      return { kind: 'smsg', frame, seq, bytes: bytesAt(b, 10, 6) };
    }
    case 6: case 10: {
      const cat = u(b, 0, 2);
      if (cat === 0) return { kind: 'svc', adv: id === 10, audio: true, access: u(b, 2, 1), program: u(b, 3, 6), progType: u(b, 9, 8), soundExp: u(b, 22, 5), dataType: -1, mime12: -1 };
      return { kind: 'svc', adv: id === 10, audio: false, access: u(b, 2, 1), program: -1, progType: -1, soundExp: -1, dataType: u(b, 3, 9), mime12: u(b, 15, 12) };
    }
    case 7: return { kind: 'param', index: u(b, 0, 6), value: u(b, 6, 16) };
    case 8: {
      const frame = u(b, 0, 4);
      if (u(b, 4, 1) === 0) return frame === 0 ? { kind: 'usn', frame, encoding: u(b, 5, 3), append: u(b, 8, 1), frames: u(b, 9, 1) + 1, bytes: bytesAt(b, 10, 6) } : { kind: 'usn', frame, bytes: bytesAt(b, 10, 6) };
      return frame === 0 ? { kind: 'slogan', frame, encoding: u(b, 5, 3), length: u(b, 11, 7), bytes: bytesAt(b, 18, 5) } : { kind: 'slogan', frame, bytes: bytesAt(b, 10, 6) };
    }
    case 9: {
      const frame = u(b, 0, 6), seq = u(b, 6, 2);
      if (frame === 0) return { kind: 'alert', frame, seq, encoding: u(b, 10, 3), length: u(b, 13, 9), crc7: u(b, 22, 7), cntLength: 1 + 2 * u(b, 29, 5), bytes: bytesAt(b, 34, 3) };
      return { kind: 'alert', frame, seq, bytes: bytesAt(b, 10, 6) };
    }
    default: return { kind: 'other', id, bits: Array.from({ length: b.length }, (_, i) => b[i] & 1).join('') };
  }
}

/** One 80-bit SIS PDU in L2 bit order. */
export function parseSis(b: ArrayLike<number>): SisPdu {
  const crcOk = sisCrcOk(b), bits = Array.from({ length: 80 }, (_, i) => b[i] & 1).join('');
  if (b[0]) return { llds: true, msgs: [], timeLocked: 0, advAlfn: u(b, 66, 2), crc: u(b, 68, 12), crcOk, bits };
  const msgs: SisMsg[] = [];
  const id1 = u(b, 2, 4), n1 = SIS_PAYLOAD[id1] ?? 58;
  msgs.push(parseSisMsg(id1, Array.prototype.slice.call(b, 6, 6 + n1)));
  if (b[1]) {
    const p = 6 + n1, id2 = u(b, p, 4), n2 = SIS_PAYLOAD[id2] ?? 0;
    if (n2 && p + 4 + n2 <= 64) msgs.push(parseSisMsg(id2, Array.prototype.slice.call(b, p + 4, p + 4 + n2)));
  }
  return { llds: false, msgs, timeLocked: b[65] & 1, advAlfn: u(b, 66, 2), crc: u(b, 68, 12), crcOk, bits };
}

/** The alert's CRC-7 (x^7 + x^3 + 1, start 0x42) over its message bytes, last byte first, seven bits each. */
export function alertCrc7(a: ArrayLike<number>, len: number): number {
  let r = 0x42;
  const step = (bit: number) => { r = (r << 1) | bit; if (r & 0x80) r ^= 0x89; };
  for (let i = len - 1; i >= 0; i--) for (let j = 6; j >= 0; j--) step(((a[i] >> j) & 1) ^ (j === 0 && i > 0 ? (a[i - 1] >> 7) & 1 : 0));
  for (let j = 0; j < 7; j++) step(0);
  return r & 0x7F;
}
/** The control data's CRC-12: control bytes from the last down to byte 1, low bit first, CRC field as zeros. */
export function alertCntCrc(c: ArrayLike<number>, len: number): number {
  const fed: number[] = [];
  for (let i = len - 1; i >= 1; i--) for (let j = 0; j < 8; j++) fed.push(i === 1 || (i === 2 && j < 4) ? 0 : (c[i] >> j) & 1);
  return crcReg(fed, 0x7E1B) & 0xFFF;
}

export interface SisAlert {
  text: string; encoding: number; seq: number; categories: [number, number]; locationFormat: string; locations: number[];
  /** The control data as hex; its CRC and the message CRC-7 both verified. */
  control: string; ms: number;
}
/** The alert control data: categories and the area codes (SAME, FIPS or ZIP), fields read low bit first. */
export function parseAlertControl(c: ArrayLike<number>, len: number): { categories: [number, number]; format: number; locations: number[] } {
  const bits: number[] = []; for (let i = 0; i < len; i++) for (let j = 0; j < 8; j++) bits.push((c[i] >> j) & 1);
  let o = 0;
  const r = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v |= (bits[o++] ?? 0) << i; return v; };
  o += 28;
  const c1 = r(5), c2 = r(5); o += 9;
  const format = r(3), n = r(5); o += 1;
  const [full, short] = format === 0 ? [20, 14] : [17, 10];
  const locations: number[] = [];
  for (let i = 0; i < n && o < bits.length; i++) {
    const isFull = i === 0 || bits[o++] === 1;
    if (o + (isFull ? full : short) > bits.length) break;
    if (isFull) locations.push(r(full));
    else { const d = r(short), prev = locations[i - 1]; locations.push(Math.floor(d / 1000) * 100000 + (d % 1000) + (prev % 100000) - (prev % 1000)); }
  }
  return { categories: [c1, c2], format, locations };
}
export const ALERT_LOCATION_FORMATS = ['SAME', 'FIPS', 'ZIP'];

/** SIS parameters 4..7 (exciter) or 8..11 (importer): maker, core and maker versions, status. */
export interface SisDevice { maker: string; core: string; makerVersion: string; coreStatus: number; makerStatus: number; importerConnected?: boolean }
export function sisDevice(p: Record<number, number>, base: number): SisDevice | null {
  const [a, b, c, d] = [p[base], p[base + 1], p[base + 2], p[base + 3]];
  if (a === undefined && b === undefined && c === undefined) return null;
  // the four parameters come one per PDU; any not heard yet shows as '?'
  const ver = (x: number | undefined, y: number) => x === undefined ? '?' : [(x >> 11) & 31, (x >> 6) & 31, (x >> 1) & 31, d === undefined ? '?' : y].join('.');
  const ch = (v: number) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '?');
  const out: SisDevice = { maker: a === undefined ? '?' : ch((a >> 8) & 0x7F) + ch(a & 0x7F), core: ver(b, ((d ?? 0) >> 11) & 31), makerVersion: ver(c, ((d ?? 0) >> 6) & 31), coreStatus: d === undefined ? -1 : (d >> 3) & 7, makerStatus: d === undefined ? -1 : d & 7 };
  if (base === 4 && a !== undefined) out.importerConnected = ((a >> 7) & 1) === 1;
  return out;
}
/** SIS parameters 0..2: leap seconds now and pending, and the ALFN the pending count takes effect. */
export function sisLeap(p: Record<number, number>): { current: number; pending: number; pendingAlfn: number } | null {
  if (p[0] === undefined || p[1] === undefined || p[2] === undefined) return null;
  return { current: p[0] & 0xFF, pending: p[0] >> 8, pendingAlfn: p[2] * 65536 + p[1] };
}

/** ALFN from the 16 ADV ALFN pairs of one frame (1020s 5.3.1): blocks 0..7 the low 16 bits, 8..15 the high. */
export function alfnFromPairs(adv: number[]): number {
  let v = 0;
  for (let bc = 0; bc < 16; bc++) {
    const hi = bc < 8 ? 30 - 2 * bc : 14 - 2 * (bc - 8);
    v += (adv[bc] & 3) * 2 ** (31 - (hi + 1));
  }
  return v;
}
/** ALFN to UTC milliseconds: frames of 65536/44100 s since the GPS epoch, less the GPS-UTC leap seconds. */
export function alfnToMs(alfn: number, leap = 18): number { return Date.UTC(1980, 0, 6) + (alfn * 65536 / 44100 - leap) * 1000; }

/** NRSC-5 program types (the US table shared with RBDS). */
export const PROGRAM_TYPES: Record<number, string> = {
  0: 'None', 1: 'News', 2: 'Information', 3: 'Sports', 4: 'Talk', 5: 'Rock', 6: 'Classic Rock', 7: 'Adult Hits', 8: 'Soft Rock', 9: 'Top 40',
  10: 'Country', 11: 'Oldies', 12: 'Soft', 13: 'Nostalgia', 14: 'Jazz', 15: 'Classical', 16: 'Rhythm and Blues', 17: 'Soft Rhythm and Blues',
  18: 'Foreign Language', 19: 'Religious Music', 20: 'Religious Talk', 21: 'Personality', 22: 'Public', 23: 'College', 24: 'Spanish Talk',
  25: 'Spanish Music', 26: 'Hip-Hop', 29: 'Weather', 30: 'Emergency Test', 31: 'Emergency', 65: 'Traffic', 76: 'Special Reading Services',
};
export const programTypeName = (t: number | null | undefined) => t === null || t === undefined || t < 0 ? '' : PROGRAM_TYPES[t] ?? `Type ${t}`;
/** Service data types (1020s Table 4-13). */
export const DATA_TYPES: Record<number, string> = {
  0: 'Non-specific', 1: 'News', 3: 'Sports', 29: 'Weather', 31: 'Emergency', 65: 'Traffic', 66: 'Image maps', 80: 'Text', 256: 'Advertising', 257: 'Financial',
  258: 'Stock ticker', 259: 'Navigation', 260: 'Program guide', 261: 'Audio', 262: 'Private data network', 263: 'Service maintenance', 264: 'HD Radio system services',
  265: 'Audio-related objects', 511: 'Special tests',
};
export const dataTypeName = (t: number) => DATA_TYPES[t] ?? `Data type ${t}`;

class Votes<T> {
  private readonly m = new Map<string, { v: T; n: number }>();
  add(key: string, v: T): void { const e = this.m.get(key); if (e) e.n++; else this.m.set(key, { v, n: 1 }); }
  best(): { v: T; n: number; total: number } | null {
    let b: { v: T; n: number } | null = null, total = 0;
    for (const e of this.m.values()) { total += e.n; if (!b || e.n > b.n) b = e; }
    return b ? { ...b, total } : null;
  }
  get size(): number { return this.m.size; }
  /** How many distinct values came at least `n` times. */
  atLeast(n: number): number { let c = 0; for (const e of this.m.values()) if (e.n >= n) c++; return c; }
}

export interface SisSummary {
  callsign: string; country: string; facility: number; longName: string; slogan: string; message: string; universal: string;
  lat: number | null; lon: number | null; altM: number | null;
  audio: { program: number; type: number; access: number; soundExp: number }[];
  data: { type: number; mime12: number; access: number; mimeName: string }[];
  params: Record<number, number>;
  timeLocked: boolean; alfn: number; alfnMs: number; pdus: number; llds: number; alerts: number;
  /** Votes behind the call sign, out of all short-name messages. */
  nameVotes: [number, number];
  /** The station message has the priority bit set (1020s 4.5: it goes to the top of the queue). */
  messagePriority: boolean;
  /** Votes behind each SIS parameter's value, out of all sent for that index. */
  paramVotes: Record<number, [number, number]>;
  /** This device's clock when the last ALFN came in (0: none yet). */
  alfnLocalMs: number;
  /** 1 when an emergency alert decoded with both its CRCs verified. */
  alertsRepeated: number;
  /** PDUs whose CRC-12 verified and failed; only the good ones are voted. */
  crcGood: number; crcBad: number;
  /** The station message's own checksum (1020s 4.5) verified over the voted text. */
  messageChecksumOk: boolean; messageEncoding: number;
  /** The newest emergency alert that verified, or null; alerts that failed a CRC. */
  alert: SisAlert | null; alertsBad: number;
  exciter: SisDevice | null; importer: SisDevice | null; leap: { current: number; pending: number; pendingAlfn: number } | null; importerConfig: number;
  /** Messages by kind, PDUs that passed. */
  msgCounts: Record<string, number>;
  /** Message ids with no defined payload (3, 11..15), with the bits last seen. */
  other: { id: number; n: number; bits: string }[];
  /** Low latency data PDUs: the last one's bits and how many distinct were seen. */
  lldsLast: string; lldsDistinct: number;
  /** Message id 3 PDUs (the whole ALFN, sent by some stations) and the last value. */
  alfnMsgs: number; alfnMsgLast: number;
}

/** Known 32-bit MIME hashes (as sent, little endian) of the service directory, XHDR and LOT headers. */
export const MIME_HASHES: Record<number, string> = {
  0xBE4B7536: 'Primary image (album art)', 0xD9C72536: 'Station logo', 0x2D42AC3E: 'NAVTEQ traffic', 0x82F03DFC: 'HERE TPEG traffic', 0xB7F03DFC: 'HERE traffic image',
  0xEECB55B6: 'HD TMC traffic', 0x4DC66C5A: 'HDC audio', 0xBB492AAC: 'Text', 0x1E653E9C: 'JPEG image', 0x4F328CA0: 'PNG image',
  0xB39EBEB2: 'TTN TPEG traffic 1', 0x4EB03469: 'TTN TPEG traffic 2', 0x52103469: 'TTN TPEG traffic 3', 0xFF8422D7: 'TTN STM traffic maps', 0xEF042E96: 'TTN STM weather maps',
};
/** A 32-bit MIME hash's name, or ''. */
export const mimeName = (h: number) => MIME_HASHES[h >>> 0] ?? '';
/** The 12-bit hash SIS sends (the low 12 bits of the 32-bit one): the known types it can be, or ''. */
export function sisMimeName(m12: number): string {
  return [...new Set(Object.entries(MIME_HASHES).filter(([k]) => (Number(k) & 0xFFF) === m12).map(([, v]) => v))].join(' or ');
}

/** Whether a station location is on the globe (1020s 4.4); some stations send one that is not. */
export function locationValid(lat: number | null, lon: number | null): boolean {
  return lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

/** The station clock against this device's (1020s 5.4.1): trusted only when locked to GPS and within `tolMs`. */
export function clockCheck(alfnMs: number, localMs: number, timeLocked: boolean, tolMs = 10_000): { offsetMs: number; trusted: boolean } {
  const offsetMs = alfnMs && localMs ? alfnMs - localMs : 0;
  return { offsetMs, trusted: !!alfnMs && !!localMs && timeLocked && Math.abs(offsetMs) <= tolMs };
}

/** SIS parameter 3, local time (1020s 4.7.1, bit 0 the most significant): UTC offset in minutes, DST schedule, DST
 *  practiced locally, DST in effect regionally. */
export function localTimeHint(v: number): { offsetMin: number; schedule: number; dstLocal: boolean; dstNow: boolean } {
  const o = (v >> 5) & 0x7FF;
  return { offsetMin: o >= 1024 ? o - 2048 : o, schedule: (v >> 2) & 7, dstLocal: ((v >> 1) & 1) === 1, dstNow: (v & 1) === 1 };
}
/** A UTC offset as UTC-8:00. */
export const utcOffsetText = (min: number) => `UTC${min < 0 ? '-' : '+'}${Math.floor(Math.abs(min) / 60)}:${String(Math.abs(min) % 60).padStart(2, '0')}`;

/** Blend control of the MPS (1017s Table 5-4). */
export const BLEND_NAMES = ['disabled (all digital)', 'select (analog forced)', 'enabled (blends on signal)', 'reserved'];


const text = (b: number[], enc: number | undefined) => {
  const t = enc === 4 ? (() => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; })() : String.fromCharCode(...b);
  return t.replace(/\0+$/, '').replace(/[\x00-\x08\x0b-\x1f]/g, '');
};
const hex = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Every SIS PDU of a station, majority-voted field by field over the PDUs whose CRC verifies. */
export class SisVoter {
  pdus = 0; llds = 0; alerts = 0; crcGood = 0; crcBad = 0;
  private readonly short = new Votes<string>(); private readonly id = new Votes<[string, number]>();
  private readonly locHi = new Votes<[number, number]>(); private readonly locLo = new Votes<[number, number]>();
  private readonly long = new Map<number, Votes<string>>(); private longLast = new Votes<number>();
  private readonly slogan = new Map<number, Votes<number[]>>(); private sloganLen = new Votes<[number, number]>();
  private readonly usn = new Map<number, Votes<number[]>>(); private usnHead = new Votes<[number, number, number]>();
  private readonly smsg = new Map<string, Votes<number[]>>(); private readonly smsgHead = new Map<number, Votes<[number, number, number, number]>>();
  private alfnLocal = 0;
  private readonly svcAudio = new Map<number, Votes<[number, number, number]>>(); private readonly svcData = new Map<string, { type: number; mime12: number; access: number; n: number }>();
  private readonly params = new Map<number, Votes<number>>();
  private locked = new Votes<number>();
  private alfn = -1; private alfnFrames = 0; private readonly alfnOff = new Votes<number>();
  private readonly msgCounts = new Map<string, number>();
  private readonly other = new Map<number, { n: number; bits: string }>();
  private lldsLast = ''; private lldsDistinct = new Set<string>();
  private alertBuf: { seq: number; head: { encoding: number; length: number; crc7: number; cntLength: number } | null; bytes: number[]; have: Set<number> } | null = null;
  private alert: SisAlert | null = null; private alertsBad = 0;
  private alfnMsgs = 0; private alfnMsgLast = -1;

  add(p: SisPdu): void {
    this.pdus++;
    if (!p.crcOk) { this.crcBad++; return; }
    this.crcGood++;
    if (p.llds) { this.llds++; this.lldsLast = p.bits; if (this.lldsDistinct.size < 64) this.lldsDistinct.add(p.bits.slice(1, 68)); return; }
    this.locked.add(String(p.timeLocked), p.timeLocked);
    for (const m of p.msgs) { this.msgCounts.set(m.kind, (this.msgCounts.get(m.kind) ?? 0) + 1); this.addMsg(m); }
  }
  /** One frame's ALFN as sent (from PDUs that passed their CRC), kept as the voted offset from the frames counted. */
  setAlfn(a: number, localMs = 0): void { this.alfnLocal = localMs; this.alfnFrames++; this.alfnOff.add(String(a - this.alfnFrames), a - this.alfnFrames); const b = this.alfnOff.best()!; this.alfn = b.v + this.alfnFrames; }
  /** A missed frame: the next ALFN is one further on. */
  skipFrame(): void { this.alfnFrames++; if (this.alfn >= 0) this.alfn++; }

  private addMsg(m: SisMsg): void {
    const map = <K, V>(mp: Map<K, Votes<V>>, k: K) => { let v = mp.get(k); if (!v) { v = new Votes<V>(); mp.set(k, v); } return v; };
    switch (m.kind) {
      case 'id': this.id.add(`${m.country}/${m.facility}`, [m.country, m.facility]); break;
      case 'short': this.short.add(m.name, m.name); break;
      case 'long': map(this.long, m.frame).add(m.chars, m.chars); this.longLast.add(String(m.last), m.last); break;
      case 'loc': (m.high ? this.locHi : this.locLo).add(`${m.deg}/${m.alt}`, [m.deg, m.alt]); break;
      case 'smsg':
        map(this.smsg, `${m.seq}/${m.frame}`).add(m.bytes.join(','), m.bytes);
        if (m.frame === 0) map(this.smsgHead, m.seq).add(`${m.length}/${m.encoding}/${m.priority}/${m.checksum}`, [m.length ?? 0, m.encoding ?? 0, m.priority ?? 0, m.checksum ?? 0]);
        break;
      case 'svc':
        if (m.audio) map(this.svcAudio, m.program).add(`${m.progType}/${m.access}/${m.soundExp}`, [m.progType, m.access, m.soundExp]);
        else { const k = `${m.dataType}/${m.mime12}`, e = this.svcData.get(k); if (e) e.n++; else this.svcData.set(k, { type: m.dataType, mime12: m.mime12, access: m.access, n: 1 }); }
        break;
      case 'param': map(this.params, m.index).add(String(m.value), m.value); break;
      case 'usn': map(this.usn, m.frame).add(m.bytes.join(','), m.bytes); if (m.frame === 0) this.usnHead.add(`${m.encoding}/${m.append}/${m.frames}`, [m.encoding ?? 0, m.append ?? 0, m.frames ?? 1]); break;
      case 'slogan': map(this.slogan, m.frame).add(m.bytes.join(','), m.bytes); if (m.frame === 0) this.sloganLen.add(`${m.length}/${m.encoding}`, [m.length ?? 0, m.encoding ?? 0]); break;
      case 'alert': this.alerts++; this.addAlert(m); break;
      case 'alfn': this.alfnMsgs++; this.alfnMsgLast = m.alfn; break;
      case 'other': { const e = this.other.get(m.id); if (e) { e.n++; e.bits = m.bits; } else this.other.set(m.id, { n: 1, bits: m.bits }); break; }
    }
  }

  /** 1020s 4.10: the alert's frames, its CRC-7 over the message, then the control data's own CRC. */
  private addAlert(m: Extract<SisMsg, { kind: 'alert' }>): void {
    if (!this.alertBuf || (m.frame === 0 && m.seq !== this.alertBuf.seq)) this.alertBuf = { seq: m.seq, head: null, bytes: [], have: new Set() };
    const a = this.alertBuf;
    if (m.frame === 0) { a.head = { encoding: m.encoding ?? 0, length: m.length ?? 0, crc7: m.crc7 ?? 0, cntLength: m.cntLength ?? 0 }; m.bytes.forEach((v, i) => { a.bytes[i] = v; }); }
    else m.bytes.forEach((v, i) => { a.bytes[6 * m.frame - 3 + i] = v; });
    a.have.add(m.frame);
    const h = a.head; if (!h) return;
    const need = Math.ceil((h.length + 3) / 6);
    for (let f = 0; f < need; f++) if (!a.have.has(f)) return;
    const msg = Array.from({ length: h.length }, (_, i) => a.bytes[i] ?? 0);
    if (alertCrc7(msg, h.length) !== h.crc7 || h.cntLength < 7 || h.length < h.cntLength) { this.alertsBad++; this.alertBuf = null; return; }
    const cnt = msg.slice(0, h.cntLength);
    if ((((cnt[2] & 15) << 8) | cnt[1]) !== alertCntCrc(cnt, h.cntLength)) { this.alertsBad++; this.alertBuf = null; return; }
    const c = parseAlertControl(cnt, h.cntLength);
    const t = h.encoding === 4 ? text(msg.slice(h.cntLength), 4) : new TextDecoder('latin1').decode(Uint8Array.from(msg.slice(h.cntLength)));
    if (!this.alert || this.alert.control !== hex(cnt) || this.alert.text !== t.trim())
      this.alert = { text: t.trim(), encoding: h.encoding, seq: a.seq, categories: c.categories, locationFormat: ALERT_LOCATION_FORMATS[c.format] ?? `format ${c.format}`, locations: c.locations, control: hex(cnt), ms: Date.now() };
    this.alertBuf = null;
  }

  summary(): SisSummary {
    const sn = this.short.best(), id = this.id.best()?.v, hi = this.locHi.best()?.v, lo = this.locLo.best()?.v;
    const join = (mp: Map<number, Votes<number[]>>) => [...mp.keys()].sort((a, b) => a - b).flatMap(k => mp.get(k)!.best()!.v);
    let longName = '';
    if (this.long.size) { const last = this.longLast.best()?.v ?? 7; for (let f = 0; f <= last; f++) longName += this.long.get(f)?.best()?.v ?? ''; }
    let slogan = '';
    if (this.slogan.size) { const [len, enc] = this.sloganLen.best()?.v ?? [0, 0]; const b = join(this.slogan); slogan = text(len ? b.slice(0, enc === 4 ? 2 * len : len) : b, enc); }
    const [usnEnc, usnAppend, usnFrames] = this.usnHead.best()?.v ?? [0, 0, 0];
    let universal = '';
    if (this.usn.size) { const b: number[] = []; for (let f = 0; f < (usnFrames || this.usn.size); f++) b.push(...(this.usn.get(f)?.best()?.v ?? [])); universal = text(b, usnEnc).trim() + (usnAppend ? '-FM' : ''); }
    let message = '', messagePriority = false, messageChecksumOk = false, messageEncoding = 0;
    const seqs = [...this.smsgHead.keys()];
    if (seqs.length) {
      const seq = seqs.sort((a, b) => (this.smsgHead.get(b)!.best()!.total) - (this.smsgHead.get(a)!.best()!.total))[0];
      const [len, enc, prio, sum] = this.smsgHead.get(seq)!.best()!.v;
      messagePriority = prio === 1; messageEncoding = enc;
      const b: number[] = [];
      for (let f = 0; f < 32; f++) { const v = this.smsg.get(`${seq}/${f}`)?.best()?.v; if (!v) { if (b.length >= len) break; continue; } b.push(...v); }
      const body = b.slice(0, len);
      let t = 0; for (const x of body) t += x;
      messageChecksumOk = body.length === len && ((((t >> 8) & 0x7F) + (t & 0xFF)) & 0x7F) === sum;
      message = text(body, enc);
    }
    const params: Record<number, number> = {};
    const paramVotes: Record<number, [number, number]> = {};
    for (const [k, v] of this.params) { const b = v.best()!; params[k] = b.v; paramVotes[k] = [b.n, b.total]; }
    return {
      callsign: sn?.v ?? '', country: id?.[0] ?? '', facility: id?.[1] ?? -1, longName: longName.replace(/\0+$/, '').trim(), slogan: slogan.trim(), message: message.trim(), universal,
      lat: hi ? hi[0] : null, lon: lo ? lo[0] : null, altM: hi && lo ? ((hi[1] << 4) | lo[1]) * 16 : null,
      audio: [...this.svcAudio.entries()].filter(([, v]) => v.best()!.n >= 2).map(([program, v]) => ({ program, type: v.best()!.v[0], access: v.best()!.v[1], soundExp: v.best()!.v[2] })).sort((a, b) => a.program - b.program),
      data: [...this.svcData.values()].filter(d => d.n >= 2).map(d => ({ type: d.type, mime12: d.mime12, access: d.access, mimeName: sisMimeName(d.mime12) })),
      params, timeLocked: this.locked.best()?.v === 1, alfn: this.alfn, alfnMs: this.alfn >= 0 ? alfnToMs(this.alfn) : 0,
      pdus: this.pdus, llds: this.llds, alerts: this.alerts, nameVotes: sn ? [sn.n, sn.total] : [0, 0],
      messagePriority, paramVotes, alfnLocalMs: this.alfnLocal, alertsRepeated: this.alert ? 1 : 0,
      crcGood: this.crcGood, crcBad: this.crcBad, messageChecksumOk, messageEncoding,
      alert: this.alert, alertsBad: this.alertsBad,
      exciter: sisDevice(params, 4), importer: sisDevice(params, 8), leap: sisLeap(params), importerConfig: params[12] ?? -1,
      msgCounts: Object.fromEntries(this.msgCounts),
      other: [...this.other.entries()].map(([id, e]) => ({ id, n: e.n, bits: e.bits })),
      lldsLast: this.lldsLast, lldsDistinct: this.lldsDistinct.size, alfnMsgs: this.alfnMsgs, alfnMsgLast: this.alfnMsgLast,
    };
  }
}
