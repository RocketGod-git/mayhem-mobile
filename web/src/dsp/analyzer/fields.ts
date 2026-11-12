/**
 * Naming the parts of a frame: what COMPARE shows once repeats are lined up.
 *
 * A field is a stretch of bits with a name and a kind (preamble, sync, ID, counter, CRC, data), counted from where
 * the frame's data starts: the first bit of the sync word (or the end of the preamble when there is none). Fields
 * are suggested from what lines up (fixed runs become sync and ID, a stretch that steps up from press to press
 * becomes a counter, a byte or two that a common CRC or checksum reproduces becomes the CRC) and the person can
 * drag out and name their own. A set of named fields with its sync word is a protocol: saved, it is recognized in
 * every later capture that carries the same sync word. Twin of core/analyzer/Fields.kt and Fields.swift.
 */

import type { Alignment } from './align.js';

export type FieldKind = 'preamble' | 'sync' | 'id' | 'counter' | 'crc' | 'data';
export const FIELD_KINDS: FieldKind[] = ['preamble', 'sync', 'id', 'counter', 'crc', 'data'];

export interface Field {
  name: string;
  kind: FieldKind;
  /** Bits [from, to) counted from the data start (the preamble's are negative). */
  from: number;
  to: number;
}

/** A checksum that was found to hold: which one, over which bytes, and where it sits (bytes from the data start). */
export interface CheckFound {
  /** A readable name: "CRC-16/XMODEM (poly 0x1021, init 0x0000)". */
  name: string;
  spec: CheckSpec;
  /** Bytes [from, to) it covers, and the byte it starts at. */
  from: number;
  to: number;
  at: number;
  /** For a 16-bit value: true when the low byte comes first. */
  little: boolean;
}

export interface CheckSpec {
  kind: 'crc' | 'sum8' | 'xor8' | 'negsum8' | 'sum16';
  width: number;
  poly: number;
  init: number;
  /** Reflected input and output (they go together in every common CRC). */
  refl: boolean;
  xorout: number;
}

export interface Protocol {
  name: string;
  /** The sync word as bits: a frame carrying it is this protocol. */
  sync: string;
  mod: string;
  coding: string;
  symUs: number;
  fields: Field[];
  check?: CheckFound;
}

// ---- checksums ----------------------------------------------------------------------------------------------

const reflect = (v: number, w: number) => { let r = 0; for (let i = 0; i < w; i++) if (v & (1 << i)) r |= 1 << (w - 1 - i); return r >>> 0; };

/** A CRC or simple checksum over bytes [a, b). */
export function checkOf(spec: CheckSpec, bytes: Uint8Array, a: number, b: number): number {
  if (spec.kind === 'sum8') { let s = 0; for (let i = a; i < b; i++) s += bytes[i]; return s & 0xff; }
  if (spec.kind === 'negsum8') { let s = 0; for (let i = a; i < b; i++) s += bytes[i]; return (-s) & 0xff; }
  if (spec.kind === 'xor8') { let s = 0; for (let i = a; i < b; i++) s ^= bytes[i]; return s; }
  if (spec.kind === 'sum16') { let s = 0; for (let i = a; i < b; i++) s += bytes[i]; return s & 0xffff; }
  const w = spec.width, top = 1 << (w - 1), mask = w === 32 ? 0xffffffff : (1 << w) - 1;
  let crc = spec.init;
  for (let i = a; i < b; i++) {
    const byte = spec.refl ? reflect(bytes[i], 8) : bytes[i];
    crc ^= byte << (w - 8);
    for (let k = 0; k < 8; k++) crc = (crc & top ? (crc << 1) ^ spec.poly : crc << 1) & mask;
  }
  if (spec.refl) crc = reflect(crc, w);
  return (crc ^ spec.xorout) & mask;
}

const KNOWN: Record<string, string> = {
  '16/1021/0000/0/0000': 'CRC-16/XMODEM', '16/1021/ffff/0/0000': 'CRC-16/CCITT-FALSE', '16/1021/0000/1/0000': 'CRC-16/KERMIT',
  '16/1021/ffff/1/ffff': 'CRC-16/X-25', '16/1021/ffff/0/ffff': 'CRC-16/GENIBUS', '16/8005/0000/1/0000': 'CRC-16/ARC',
  '16/8005/ffff/1/0000': 'CRC-16/MODBUS', '16/8005/0000/0/0000': 'CRC-16/BUYPASS', '16/3d65/0000/1/ffff': 'CRC-16/EN-13757',
  '8/07/00/0/00': 'CRC-8/SMBUS', '8/31/00/1/00': 'CRC-8/MAXIM', '8/31/ff/0/00': 'CRC-8/NRSC-5', '8/1d/ff/0/ff': 'CRC-8/SAE-J1850',
  '8/9b/00/0/00': 'CRC-8/LTE', '8/07/00/0/55': 'CRC-8/I-432-1',
};

/** Every checksum tried: the common CRC-8 and CRC-16 polynomials at both usual starting values, both bit orders. */
export function checkSpecs(): CheckSpec[] {
  const out: CheckSpec[] = [];
  for (const poly of [0x1021, 0x8005, 0x3d65, 0x8bb7, 0xc867, 0x0589, 0x6f63])
    for (const init of [0, 0xffff]) for (const refl of [false, true]) for (const xorout of [0, 0xffff]) out.push({ kind: 'crc', width: 16, poly, init, refl, xorout });
  for (const poly of [0x07, 0x31, 0x1d, 0x2f, 0x9b, 0x39, 0xd5])
    for (const init of [0, 0xff]) for (const refl of [false, true]) for (const xorout of [0, 0xff, 0x55]) out.push({ kind: 'crc', width: 8, poly, init, refl, xorout });
  out.push({ kind: 'sum8', width: 8, poly: 0, init: 0, refl: false, xorout: 0 }, { kind: 'xor8', width: 8, poly: 0, init: 0, refl: false, xorout: 0 },
    { kind: 'negsum8', width: 8, poly: 0, init: 0, refl: false, xorout: 0 }, { kind: 'sum16', width: 16, poly: 0, init: 0, refl: false, xorout: 0 });
  return out;
}

const hx = (v: number, w: number) => '0x' + v.toString(16).toUpperCase().padStart(w / 4, '0');
export function specName(s: CheckSpec): string {
  if (s.kind !== 'crc') return { sum8: 'SUM-8', xor8: 'XOR-8', negsum8: 'SUM-8, negated', sum16: 'SUM-16' }[s.kind];
  const key = `${s.width}/${s.poly.toString(16).padStart(s.width / 4, '0')}/${s.init.toString(16).padStart(s.width / 4, '0')}/${s.refl ? 1 : 0}/${s.xorout.toString(16).padStart(s.width / 4, '0')}`;
  const base = `poly ${hx(s.poly, s.width)}, init ${hx(s.init, s.width)}${s.refl ? ', reflected' : ''}${s.xorout ? `, xor ${hx(s.xorout, s.width)}` : ''}`;
  return `${KNOWN[key] ?? `CRC-${s.width}`} (${base})`;
}

/** Bits to bytes, eight at a time from the first bit; a short last byte is dropped. */
export function bytesOf(bits: string): Uint8Array {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(8 * i, 8 * i + 8), 2);
  return out;
}

/**
 * Look for a checksum that every frame agrees with: a CRC-8/16 (common polynomials) or a sum or XOR of a run of
 * bytes, stored in one or two bytes after them. `frames` are the frames' bits from their data start, all lined
 * up. The value must change from frame to frame (a constant byte "matches" anything constant), and at least two
 * frames are needed. The check nearest the end and the longest run of bytes win, the order a protocol is usually
 * built in.
 */
export function findCheck(frames: string[]): CheckFound | null {
  if (frames.length < 2) return null;
  const n = Math.min(...frames.map(f => f.length >> 3));
  if (n < 3) return null;
  const rows = frames.map(bytesOf);
  const specs = checkSpecs();
  for (let at = n - 1; at >= 1; at--) {
    for (let a = 0; a < at; a++) {
      for (const spec of specs) {
        const wb = spec.width >> 3;
        if (at + wb > n || (spec.width === 16 && at - a < 2)) continue;
        for (const little of wb === 2 ? [false, true] : [false]) {
          const stored = (r: Uint8Array) => (wb === 1 ? r[at] : little ? r[at] | (r[at + 1] << 8) : (r[at] << 8) | r[at + 1]);
          if (rows.every(r => stored(r) === stored(rows[0]))) continue;
          if (rows.every(r => checkOf(spec, r, a, at) === stored(r))) return { name: specName(spec), spec, from: a, to: at, at, little };
        }
      }
    }
  }
  return null;
}

// ---- counters ---------------------------------------------------------------------------------------------------

const valueOf = (bits: string, lsbFirst: boolean) => { const b = lsbFirst ? [...bits].reverse().join('') : bits; return parseInt(b, 2); };

/** Whether the stretch [s, s+w) counts up across the rows: never down, up at least twice, never by more than `step`. */
function counts(rows: string[], s: number, w: number, lsbFirst: boolean, step: number): boolean {
  if (s < 0) return false;
  let ups = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length < s + w || rows[i - 1].length < s + w) return false;
    const d = valueOf(rows[i].slice(s, s + w), lsbFirst) - valueOf(rows[i - 1].slice(s, s + w), lsbFirst);
    if (d < 0 || d > step) return false;
    if (d > 0) ups++;
  }
  return ups >= 2;
}

/**
 * A stretch that counts: read as a number (either bit order) in the frames' order in time, it never goes down and
 * goes up at least twice (repeats of one press share a value). Whole bytes that take in a changing stretch are
 * tried first (a counter is nearly always a byte or a few), steps up to 16 allowed for presses missed; then any
 * stretch of 4 to 32 bits inside the changing ones, steps up to 4, longest first. `rows` are bits from the data
 * start, in time order.
 */
export function findCounter(rows: string[], segments: { from: number; to: number }[]): { from: number; to: number; lsbFirst: boolean } | null {
  if (rows.length < 3) return null;
  for (const w of [32, 24, 16, 8]) {
    for (const seg of segments) {
      for (let s = Math.floor(seg.from / 8) * 8; s < seg.to; s += 8) {
        if (s + w < seg.to && w > 8) continue;
        for (const lsbFirst of [false, true]) if (counts(rows, s, w, lsbFirst, 16)) return { from: s, to: s + w, lsbFirst };
      }
    }
  }
  for (const seg of segments) {
    for (let w = Math.min(32, seg.to - seg.from); w >= 4; w--) {
      for (let s = seg.from; s + w <= seg.to; s++) {
        for (const lsbFirst of [false, true]) if (counts(rows, s, w, lsbFirst, 4)) return { from: s, to: s + w, lsbFirst };
      }
    }
  }
  return null;
}

// ---- suggestions and protocols ----------------------------------------------------------------------------------

/** Where the data starts in an alignment: the sync word, or the end of the preamble, or the first shared column. */
export function dataStart(al: Alignment): number {
  if (al.sync) return al.sync.from;
  if (al.preamble) return al.preamble[1];
  let c = 0; while (c < al.width && al.state[c] === 2) c++;
  return c;
}

/** Each row's bits from the data start (rows that start later are padded with nothing: they are simply shorter). */
export function fromStart(al: Alignment, start: number): string[] {
  return al.rows.map(r => r.bits.slice(Math.max(0, start - r.shift)));
}

/**
 * Fields suggested from lined-up frames: the preamble, the sync word, fixed stretches after it as ID, a counter,
 * and a checksum. `order` gives each row's place in time (rows are in the order passed to align()).
 */
export function suggest(al: Alignment): { fields: Field[]; check: CheckFound | null } {
  const start = dataStart(al);
  const fields: Field[] = [];
  if (al.preamble) fields.push({ name: 'preamble', kind: 'preamble', from: al.preamble[0] - start, to: al.preamble[1] - start });
  if (al.sync) fields.push({ name: 'sync', kind: 'sync', from: al.sync.from - start, to: al.sync.to - start });
  const syncEnd = al.sync ? al.sync.to : start;
  const rows = fromStart(al, start);
  const check = findCheck(rows);
  const checkFrom = check ? check.at * 8 : Infinity, checkTo = check ? (check.at + (check.spec.width >> 3)) * 8 : -Infinity;
  let ids = 0;
  const changing: { from: number; to: number }[] = [];
  for (const s of al.segments) {
    const a = Math.max(s.from, syncEnd) - start, b = s.to - start;
    if (b <= a || (a >= checkFrom && b <= checkTo)) continue;
    if (s.fixed && b - a >= 8) fields.push({ name: ids++ ? `fixed ${ids}` : 'ID / fixed', kind: 'id', from: a, to: b });
    if (!s.fixed) changing.push({ from: a, to: Math.min(b, a + 64) });
  }
  const counter = findCounter(rows, changing.filter(c => !(c.from >= checkFrom && c.to <= checkTo)));
  if (counter) fields.push({ name: counter.lsbFirst ? 'counter (LSB first)' : 'counter', kind: 'counter', from: counter.from, to: counter.to });
  if (check) fields.push({ name: check.name.split(' (')[0], kind: 'crc', from: checkFrom, to: checkTo });
  return { fields: fields.sort((x, y) => x.from - y.from), check };
}

/** The saved protocol a frame belongs to, if any: same modulation and coding, and its sync word in the frame. */
export function recognize(protocols: Protocol[], bits: string, mod: string, coding: string): { protocol: Protocol; start: number } | null {
  for (const p of protocols) {
    if (p.sync.length < 8 || p.mod !== mod || p.coding !== coding) continue;
    const i = bits.indexOf(p.sync);
    if (i >= 0) return { protocol: p, start: i };
  }
  return null;
}

/** A field's bits in a frame whose data starts at `start`, as hex (and binary when short). */
export function fieldValue(bits: string, start: number, f: Field): string {
  const a = start + f.from, b = start + f.to;
  if (a < 0 || b > bits.length) return '—';
  const v = bits.slice(a, b);
  let hex = '';
  for (let i = 0; i < v.length; i += 4) hex += parseInt(v.slice(i, i + 4).padEnd(4, '0'), 2).toString(16).toUpperCase();
  return v.length <= 8 ? `${hex} (${v})` : hex;
}

/** Whether a protocol's checksum holds for a frame. Null when the protocol has none or the frame is too short. */
export function checkHolds(p: Protocol, bits: string, start: number): boolean | null {
  const c = p.check;
  if (!c) return null;
  const bytes = bytesOf(bits.slice(start));
  const wb = c.spec.width >> 3;
  if (c.at + wb > bytes.length) return null;
  const stored = wb === 1 ? bytes[c.at] : c.little ? bytes[c.at] | (bytes[c.at + 1] << 8) : (bytes[c.at] << 8) | bytes[c.at + 1];
  return checkOf(c.spec, bytes, c.from, c.to) === stored;
}
