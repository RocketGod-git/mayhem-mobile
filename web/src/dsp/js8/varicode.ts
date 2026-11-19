/**
 * The JS8 protocol's message layer: how callsigns, groups, grids, commands and text are packed into the 72 bits of
 * a frame, and how a typed line becomes frames. Formats and tables follow the JS8 protocol (JS8Call 2.x).
 *
 * Bits are handled as arrays of 0/1, most significant first. The 72 bits of a frame are the LDPC message's payload.
 */
import { FLAG_FIRST, FLAG_LAST, FLAG_RESERVED as FLAG_DATA, type Frame } from './codec.js';
import { HUFFMAN } from './tables.js';

// ---- tables ---------------------------------------------------------------------------------------------------------
/** Directed commands as typed (with their leading space where JS8 has one) and their 5-bit codes. */
export const DIRECTED_CMDS: ReadonlyArray<readonly [string, number]> = [
  [' HEARTBEAT', -1], [' HB', -1], [' CQ', -1],
  [' SNR?', 0], ['?', 0], [' DIT DIT', 1], [' HEARING?', 3], [' GRID?', 4], ['>', 5], [' STATUS?', 6], [' STATUS', 7],
  [' HEARING', 8], [' MSG', 9], [' MSG TO:', 10], [' QUERY', 11], [' QUERY MSGS', 12], [' QUERY MSGS?', 12],
  [' QUERY CALL', 13], [' GRID', 15], [' INFO?', 16], [' INFO', 17], [' FB', 18], [' HW CPY?', 19], [' SK', 20],
  [' RR', 21], [' QSL?', 22], [' QSL', 23], [' CMD', 24], [' SNR', 25], [' NO', 26], [' YES', 27], [' 73', 28],
  [' NACK', 2], [' ACK', 14], [' HEARTBEAT SNR', 29], [' AGN?', 30], ['  ', 31], [' ', 31],
];
const CMD_CODE = new Map<string, number>(DIRECTED_CMDS);
/** The name a received code shows as. */
export const CMD_NAME: readonly string[] = [
  ' SNR?', ' DIT DIT', ' NACK', ' HEARING?', ' GRID?', '>', ' STATUS?', ' STATUS', ' HEARING', ' MSG', ' MSG TO:',
  ' QUERY', ' QUERY MSGS', ' QUERY CALL', ' ACK', ' GRID', ' INFO?', ' INFO', ' FB', ' HW CPY?', ' SK', ' RR', ' QSL?',
  ' QSL', ' CMD', ' SNR', ' NO', ' YES', ' 73', ' HEARTBEAT SNR', ' AGN?', ' ',
];
export const BUFFERED_CMDS = new Set([5, 9, 10, 11, 12, 13, 15, 24]);
export const CHECKSUM_CMDS = new Map<number, number>([[5, 16], [9, 16], [10, 16], [11, 16], [12, 16], [13, 16], [15, 0], [24, 16]]);
const SNR_CMDS = new Set([25, 29]);

/** 37*36*10*27*27*27: callsign values at and above this are the fixed calls and groups below. */
export const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
const BASECALL_NAMES = [
  '<....>', '@ALLCALL', '@JS8NET', '@DX/NA', '@DX/SA', '@DX/EU', '@DX/AS', '@DX/AF', '@DX/OC', '@DX/AN',
  '@REGION/1', '@REGION/2', '@REGION/3', '@GROUP/0', '@GROUP/1', '@GROUP/2', '@GROUP/3', '@GROUP/4', '@GROUP/5',
  '@GROUP/6', '@GROUP/7', '@GROUP/8', '@GROUP/9', '@COMMAND', '@CONTROL', '@NET', '@NTS', '@RESERVE/0',
  '@RESERVE/1', '@RESERVE/2', '@RESERVE/3', '@RESERVE/4', '@APRSIS', '@RAGCHEW', '@JS8', '@EMCOMM', '@ARES', '@MARS',
  '@AMRRON', '@RACES', '@RAYNET', '@RADAR', '@SKYWARN', '@CQ', '@HB', '@QSO', '@QSOPARTY', '@CONTEST', '@FIELDDAY',
  '@SOTA', '@IOTA', '@POTA', '@QRP', '@QRO',
];
export const BASECALLS = new Map<string, number>(BASECALL_NAMES.map((n, i) => [n, NBASECALL + 1 + i]));
const BASECALL_OF = new Map<number, string>([...BASECALLS].map(([k, v]) => [v, k]));
export const CQS = ['CQ CQ CQ', 'CQ DX', 'CQ QRP', 'CQ CONTEST', 'CQ FIELD', 'CQ FD', 'CQ CQ', 'CQ'];
const HBS = ['HB', 'HB', 'HB', 'HB', 'HB', 'HB', 'HB', 'HB'];
/** Groups that may not be used as a user group. */
export const isGroupAllowed = (g: string): boolean => g !== '@APRSIS' && g !== '@JS8NET';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@';
const B41 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';
export const NBASEGRID = 180 * 180, NUSERGRID = NBASEGRID + 10, NMAXGRID = (1 << 15) - 1;

// ---- bits -----------------------------------------------------------------------------------------------------------
function put(p: number[], v: number | bigint, n: number): void { let b = BigInt(v); const out: number[] = []; for (let i = 0; i < n; i++) { out.push(Number(b & 1n)); b >>= 1n; } for (let i = n - 1; i >= 0; i--) p.push(out[i]); }
function get(p: ArrayLike<number>, at: number, n: number): bigint { let v = 0n; for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(p[at + i] ? 1 : 0); return v; }
const toFrame = (bits: number[], flags: number): Frame => { const p = new Uint8Array(72); for (let i = 0; i < 72; i++) p[i] = bits[i] ?? 0; return { payload: p, flags }; };

// ---- callsigns: 28 bits -----------------------------------------------------------------------------------------------
const PACK_CALL_RE = /([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])/;
/** A standard callsign or fixed group → 28 bits and its portable (/P) flag; 0 when it cannot be packed. */
export function packCall28(value: string): { v: number; portable: boolean } {
  let c = value.toUpperCase().trim(), portable = false;
  const base = BASECALLS.get(c); if (base !== undefined) return { v: base, portable };
  if (c.endsWith('/P')) { c = c.slice(0, -2); portable = true; }
  if (c.startsWith('3DA0')) c = '3D0' + c.slice(4);
  if (c.startsWith('3X') && c.length > 2 && c[2] >= 'A' && c[2] <= 'Z') c = 'Q' + c.slice(2);
  const n = c.length; if (n < 2 || n > 6) return { v: 0, portable };
  const perms = [c];
  if (n === 2) perms.push(' ' + c + '   ');
  if (n === 3) perms.push(' ' + c + '  ', c + '   ');
  if (n === 4) perms.push(' ' + c + ' ', c + '  ');
  if (n === 5) perms.push(' ' + c, c + ' ');
  let m = '';
  for (const p of perms) { const r = PACK_CALL_RE.exec(p); if (r) m = r[0]; }
  if (m.length < 6) return { v: 0, portable };
  const ix = (k: number) => ALNUM.indexOf(m[k]);
  let v = ix(0); v = 36 * v + ix(1); v = 10 * v + ix(2); v = 27 * v + ix(3) - 10; v = 27 * v + ix(4) - 10; v = 27 * v + ix(5) - 10;
  return { v, portable };
}
export function unpackCall28(value: number, portable: boolean): string {
  const base = BASECALL_OF.get(value); if (base !== undefined) return base;
  const w: string[] = [];
  let v = value;
  w[5] = ALNUM[v % 27 + 10]; v = Math.floor(v / 27);
  w[4] = ALNUM[v % 27 + 10]; v = Math.floor(v / 27);
  w[3] = ALNUM[v % 27 + 10]; v = Math.floor(v / 27);
  w[2] = ALNUM[v % 10]; v = Math.floor(v / 10);
  w[1] = ALNUM[v % 36]; v = Math.floor(v / 36);
  w[0] = ALNUM[v] ?? ' ';
  let c = w.join('');
  if (c.startsWith('3D0')) c = '3DA0' + c.slice(3);
  if (c.startsWith('Q') && c[1] >= 'A' && c[1] <= 'Z') c = '3X' + c.slice(1);
  if (portable) c = c.trim() + '/P';
  return c.trim();
}

// ---- compound callsigns and groups: 50 bits ----------------------------------------------------------------------------
export function pack50(value: string): bigint {
  let w = value.replace(/[^A-Z0-9 /@]/g, '');
  if (w.length > 3 && w[3] !== '/') w = w.slice(0, 3) + ' ' + w.slice(3);
  if (w.length > 7 && w[7] !== '/') w = w.slice(0, 7) + ' ' + w.slice(7);
  w = w.padEnd(11, ' ');
  const ix = (k: number) => BigInt(Math.max(0, ALNUM.indexOf(w[k])));
  let v = ix(0);
  v = v * 38n + ix(1); v = v * 38n + ix(2); v = v * 2n + (w[3] === '/' ? 1n : 0n);
  v = v * 38n + ix(4); v = v * 38n + ix(5); v = v * 38n + ix(6); v = v * 2n + (w[7] === '/' ? 1n : 0n);
  v = v * 38n + ix(8); v = v * 38n + ix(9); v = v * 38n + ix(10);
  return v;
}
export function unpack50(packed: bigint): string {
  const w: string[] = []; let v = packed;
  const take = (r: bigint) => { const d = v % r; v /= r; return Number(d); };
  w[10] = ALNUM[take(38n)]; w[9] = ALNUM[take(38n)]; w[8] = ALNUM[take(38n)]; w[7] = take(2n) ? '/' : ' ';
  w[6] = ALNUM[take(38n)]; w[5] = ALNUM[take(38n)]; w[4] = ALNUM[take(38n)]; w[3] = take(2n) ? '/' : ' ';
  w[2] = ALNUM[take(38n)]; w[1] = ALNUM[take(38n)]; w[0] = ALNUM[take(39n)];
  return w.join('').replace(/ /g, '');
}

// ---- grids: 15 bits ---------------------------------------------------------------------------------------------------
/** A 4-character locator → 15 bits (NMAXGRID when there is none). Longitude is counted west-positive, as JS8 does. */
export function packGrid(value: string): number {
  const g = value.trim().toUpperCase();
  if (g.length < 4) return NMAXGRID;
  const dlong = 180 - 20 * (g.charCodeAt(0) - 65) - 2 * (g.charCodeAt(2) - 48) - (5 * (12 + 0.5)) / 60;
  const dlat = -90 + 10 * (g.charCodeAt(1) - 65) + (g.charCodeAt(3) - 48) + (2.5 * (12 + 0.5)) / 60;
  const ilong = Math.trunc(dlong), ilat = Math.trunc(dlat + 90);
  return Math.trunc((ilong + 180) / 2) * 180 + ilat;
}
export function unpackGrid(value: number): string {
  if (value > NBASEGRID) return '';
  const dlat = (value % 180) - 90;
  let dlong = Math.floor(value / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360; if (dlong > 180) dlong -= 360;
  const nlong = Math.trunc((60 * (180 - dlong)) / 5);
  const n1 = Math.trunc(nlong / 240), n2 = Math.trunc((nlong - 240 * n1) / 24);
  const nlat = Math.trunc((60 * (dlat + 90)) / 2.5);
  const m1 = Math.trunc(nlat / 240), m2 = Math.trunc((nlat - 240 * m1) / 24);
  return String.fromCharCode(65 + n1, 65 + m1, 48 + n2, 48 + m2);
}

// ---- numbers and commands -------------------------------------------------------------------------------------------
/** A number or SNR → 6 bits (0 means none). */
export function packNum(num: string): { v: number; ok: boolean } {
  const t = num.trim(); if (!t || !/^[-+]?\d+$/.test(t)) return { v: 0, ok: false };
  return { v: Math.max(-30, Math.min(Number(t), 31)) + 31, ok: true };
}
export const formatSnr = (snr: number): string => (snr < -60 || snr > 60 ? '' : `${snr >= 0 ? '+' : '-'}${String(Math.abs(snr)).padStart(2, '0')}`);
function packCmd(cmd: number, num: number): number {
  if (SNR_CMDS.has(cmd)) return ((2 | (cmd === 29 ? 1 : 0)) << 6) + (num & 63);
  return cmd & 127;
}
function unpackCmd(value: number): { cmd: number; num: number } {
  if (value & 128) return { cmd: value & 64 ? 29 : 25, num: value & 63 };
  return { cmd: value & 127, num: 0 };
}

// ---- checksums ------------------------------------------------------------------------------------------------------
const latin1 = (s: string): number[] => [...s].map(ch => ch.charCodeAt(0) & 0xFF);
export function crc16Kermit(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1; }
  return crc & 0xFFFF;
}
export function crc32Bzip2(bytes: number[]): number {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) { crc ^= b << 24; for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04C11DB7 : crc << 1; }
  return (~crc) >>> 0;
}
const pack16 = (v: number): string => B41[Math.floor(v / 1681)] + B41[Math.floor((v % 1681) / 41)] + B41[v % 41];
export const checksum16 = (text: string): string => pack16(crc16Kermit(latin1(text))).padEnd(3, ' ');
export const checksum32 = (text: string): string => { const c = crc32Bzip2(latin1(text)); return (pack16(c >>> 16) + pack16(c & 0xFFFF)).padEnd(6, ' '); };

// ---- JSC dense coding -------------------------------------------------------------------------------------------------
interface Jsc { words: string[]; mapSize: Record<string, number>; list: number[]; listSize: Record<string, number>; prefix: [string, number, number][]; }
let jsc: Jsc | null = null;
let jscLoading: Promise<void> | null = null;
/** The dictionary is large: it is loaded once, the first time JS8 needs it. */
export function loadJsc(url = './assets/js8-jsc.json'): Promise<void> {
  if (jsc) return Promise.resolve();
  jscLoading ??= fetch(url).then(r => r.json()).then((d: Jsc) => { jsc = d; });
  return jscLoading;
}
/** For tests and workers: hand the dictionary in directly. */
export function setJsc(d: Jsc): void { jsc = d; }
export const jscReady = (): boolean => jsc !== null;
const mapSize = (i: number): number => jsc!.mapSize[i] ?? jsc!.words[i].length;
const listSize = (li: number): number => jsc!.listSize[li] ?? jsc!.words[jsc!.list[li]].length;
const JB = 4, JS = 7, JC = 16 - JS;
function lookup(w: string): number {
  for (const [ch, count, start] of jsc!.prefix) {
    if (w[0] !== ch) continue;
    if (count === 1) return jsc!.list[start];
    for (let li = start; li < start + count; li++) {
      const n = listSize(li), s = jsc!.words[jsc!.list[li]].slice(0, n);
      if (w.startsWith(s)) return jsc!.list[li];
    }
    return -1;
  }
  return -1;
}
function codeword(index: number, sep: boolean): number[] {
  const groups: number[][] = [];
  const last: number[] = []; put(last, ((index % JS) << 1) + (sep ? 1 : 0), JB + 1); groups.unshift(last);
  let x = Math.floor(index / JS);
  while (x > 0) { x -= 1; const g: number[] = []; put(g, (x % JC) + JS, JB); groups.unshift(g); x = Math.floor(x / JC); }
  return groups.flat();
}
/** Text → codewords, each with how many characters it covers. */
export function jscCompress(text: string): { bits: number[]; chars: number }[] {
  const out: { bits: number[]; chars: number }[] = [];
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    let w = words[i]; const isLastWord = i === words.length - 1; let isSpace = false;
    if (!w && !isLastWord) { w = ' '; isSpace = true; }
    while (w) {
      const idx = lookup(w); if (idx < 0) break;
      w = w.slice(mapSize(idx));
      const isLast = !w, sep = isLast && !isSpace && !isLastWord;
      out.push({ bits: codeword(idx, sep), chars: mapSize(idx) + (sep ? 1 : 0) });
    }
  }
  return out;
}
export function jscDecompress(bits: ArrayLike<number>, from = 0, to = bits.length): string {
  const base = [0]; for (let k = 1; k < 8; k++) base[k] = base[k - 1] + JS * JC ** (k - 1);
  const bytes: number[] = [], seps: number[] = [];
  let i = from;
  while (i < to) {
    if (to - i < JB) break;
    const b = Number(get(bits, i, JB)); bytes.push(b); i += JB;
    if (b < JS) { if (to - i > 0 && bits[i]) seps.push(bytes.length - 1); i += 1; }
  }
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let k = 0, j = 0;
    while (start + k < bytes.length && bytes[start + k] >= JS) { j = j * JC + (bytes[start + k] - JS); k++; }
    if (j >= jsc!.words.length || start + k >= bytes.length) break;
    j = j * JS + bytes[start + k] + base[k];
    if (j >= jsc!.words.length) break;
    out.push(jsc!.words[j]);
    if (seps.length && seps[0] === start + k) { out.push(' '); seps.shift(); }
    start += k + 1;
  }
  return out.join('');
}

// ---- Huffman text ---------------------------------------------------------------------------------------------------
const HUFF_KEYS = Object.keys(HUFFMAN).sort((a, b) => b.length - a.length || (b < a ? -1 : 1));
function huffEncode(text: string): { bits: number[]; chars: number }[] {
  const out: { bits: number[]; chars: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const k = HUFF_KEYS.find(key => text.startsWith(key, i));
    if (!k) { i++; continue; }
    out.push({ bits: [...HUFFMAN[k]].map(c => (c === '1' ? 1 : 0)), chars: k.length }); i += k.length;
  }
  return out;
}
const HUFF_ROOT = (() => { const root: { c?: string; k: [unknown, unknown] } = { k: [null, null] }; for (const [ch, code] of Object.entries(HUFFMAN)) { let n: any = root; for (const b of code) { const x = b === '1' ? 1 : 0; n = n.k[x] ?? (n.k[x] = { k: [null, null] }); } n.c = ch; } return root; })();
function huffDecode(bits: ArrayLike<number>, from: number, to: number): string {
  let s = '', n: any = HUFF_ROOT;
  for (let i = from; i < to; i++) { n = n.k[bits[i] ? 1 : 0]; if (!n) break; if (n.c !== undefined) { s += n.c; n = HUFF_ROOT; } }
  return s;
}

// ---- data frames ------------------------------------------------------------------------------------------------------
function fill(prefix: number[], codes: { bits: number[]; chars: number }[]): { bits: number[]; chars: number } {
  const bits = [...prefix]; let chars = 0;
  for (const c of codes) { if (bits.length + c.bits.length < 72) { bits.push(...c.bits); chars += c.chars; continue; } break; }
  if (bits.length < 72) { bits.push(0); while (bits.length < 72) bits.push(1); }
  return { bits, chars };
}
/** Normal speed: Huffman or dictionary, whichever carries more characters (a tie goes to the dictionary). */
function packData(text: string): { bits: number[]; chars: number } {
  const valid = new Set(Object.keys(HUFFMAN));
  const huffOk = [...text.toUpperCase()].every(ch => valid.has(ch));
  const huff = huffOk ? fill([1, 0], huffEncode(text)) : { bits: [], chars: 0 };
  const comp = fill([1, 1], jscCompress(text));
  return huff.chars > comp.chars ? huff : comp;
}
/** Fast, Turbo and Slow: the whole frame is dictionary code (the frame is flagged as data). */
const packFastData = (text: string): { bits: number[]; chars: number } => fill([], jscCompress(text));
function unpad(bits: ArrayLike<number>, from: number): number { let n = bits.length - 1; while (n >= from && bits[n]) n--; return n; }

// ---- frames ---------------------------------------------------------------------------------------------------------
export const FRAME_HEARTBEAT = 0, FRAME_COMPOUND = 1, FRAME_COMPOUND_DIRECTED = 2, FRAME_DIRECTED = 3;
function compoundFrame(call: string, type: number, num: number, bits3: number): number[] | null {
  const pc = pack50(call); if (pc === 0n) return null;
  const b: number[] = [];
  put(b, type, 3); put(b, pc, 50); put(b, (num >> 5) & 0x7FF, 11); put(b, num & 31, 5); put(b, bits3 & 7, 3);
  return b;
}

/** One received frame, read: the text JS8 shows for it and what it carries. */
export interface Decoded {
  kind: 'heartbeat' | 'compound' | 'compoundDirected' | 'directed' | 'data' | 'compressed';
  text: string;
  from?: string; to?: string; cmd?: string; snr?: number; grid?: string; cq?: string;
}
export function decodeFrame(f: Frame): Decoded | null {
  const p = f.payload;
  if (f.flags & FLAG_DATA) {
    if (!jsc) return { kind: 'compressed', text: '' };
    return { kind: 'compressed', text: unescape(jscDecompress(p, 0, unpad(p, 0))) };
  }
  if (p[0] === 1) {
    const n = unpad(p, 2);
    if (p[1] === 1) return { kind: 'compressed', text: jsc ? unescape(jscDecompress(p, 2, n)) : '' };
    return { kind: 'data', text: unescape(huffDecode(p, 2, n)) };
  }
  const type = Number(get(p, 0, 3));
  if (type === FRAME_DIRECTED) {
    const extra = Number(get(p, 64, 8));
    const from = unpackCall28(Number(get(p, 3, 28)), !!(extra & 128)), to = unpackCall28(Number(get(p, 31, 28)), !!(extra & 64));
    const code = Number(get(p, 59, 5)), cmd = CMD_NAME[code % 32], x = extra % 64;
    const numStr = x === 0 ? '' : SNR_CMDS.has(code) ? formatSnr(x - 31) : String(x - 31);
    return { kind: 'directed', text: `${from}: ${to}${cmd}${numStr ? ' ' + numStr : ''} `, from, to, cmd: cmd.trim(), snr: numStr && SNR_CMDS.has(code) ? x - 31 : undefined };
  }
  const call = unpack50(get(p, 3, 50));
  const num = (Number(get(p, 53, 11)) << 5) | Number(get(p, 64, 5));
  const bits3 = Number(get(p, 69, 3));
  if (type === FRAME_HEARTBEAT) {
    const alt = !!(num & 0x8000), grid = unpackGrid(num & 0x7FFF);
    if (alt) { const cq = CQS[bits3] ?? 'CQ'; return { kind: 'heartbeat', text: `${call}: @ALLCALL ${cq} ${grid} `, from: call, to: '@ALLCALL', grid: grid || undefined, cq }; }
    const hb = HBS[bits3] ?? 'HB';
    return { kind: 'heartbeat', text: `${call}: @HB ${hb === 'HB' ? 'HEARTBEAT' : hb} ${grid} `, from: call, to: '@HB', grid: grid || undefined };
  }
  if (type === FRAME_COMPOUND) {
    const grid = num <= NBASEGRID ? unpackGrid(num) : '';
    return { kind: 'compound', text: `${call}: `, from: call, grid: grid || undefined };
  }
  if (type === FRAME_COMPOUND_DIRECTED) {
    let extra = '', snr: number | undefined, cmdName: string | undefined;
    if (num <= NBASEGRID) extra = ' ' + unpackGrid(num);
    else if (num >= NUSERGRID && num < NMAXGRID) {
      const { cmd, num: n } = unpackCmd(num - NUSERGRID);
      cmdName = CMD_NAME[cmd] ?? '';
      extra = cmdName;
      if (SNR_CMDS.has(cmd)) { snr = n - 31; extra += ' ' + formatSnr(snr); }
    }
    return { kind: 'compoundDirected', text: `${call}${extra} `, to: call, cmd: cmdName?.trim(), snr };
  }
  return null;
}
export function unescape(t: string): string { return t.replace(/(?:[uU]\+|\\[uU])([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); }

// ---- callsign tests ---------------------------------------------------------------------------------------------------
const BASE_CALL_RE = /^(?:[0-9A-Z])?[0-9A-Z][0-9][A-Z]?[A-Z]?[A-Z]?(?:\/P)?$/;
const COMPOUND_RE = /^@?[A-Z0-9/@][A-Z0-9/]{0,2}\/?[A-Z0-9/]{0,3}\/?[A-Z0-9/]{0,3}$/;
function validCompound(c: string): boolean {
  if (c.length - (c.match(/\//g)?.length ?? 0) > 9) return false;
  const i = c.indexOf('/'); if (i >= 0) return !BASECALLS.has(c.slice(0, i));
  if (c.startsWith('@')) return true;
  return c.length > 2 && /[0-9][A-Z]|[A-Z][0-9]/.test(c);
}
export function isValidCallsign(c: string): { valid: boolean; compound: boolean } {
  if (BASECALLS.has(c)) return { valid: true, compound: false };
  if (BASE_CALL_RE.test(c)) return { valid: c.length > 2 && /[0-9][A-Z]|[A-Z][0-9]/.test(c), compound: false };
  if (COMPOUND_RE.test(c)) { const v = validCompound(c); return { valid: v, compound: v }; }
  return { valid: false, compound: false };
}
export function isCompoundCallsign(c: string): boolean {
  if (BASECALLS.has(c) && !c.startsWith('@')) return false;
  if (BASE_CALL_RE.test(c)) return false;
  return COMPOUND_RE.test(c) && validCompound(c);
}

// ---- building frames from a typed line --------------------------------------------------------------------------------
const CMD_ALT = String.raw`(?<cmd>\s?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]|QUERY MSGS[?]|HEARING[?]|(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|$))|[?> ]))?`;
const NUM_ALT = String.raw`(?<num>(?<=SNR)\s?[-+]?(?:3[01]|[0-2]?[0-9]))?`;
const DIRECTED_RE = new RegExp(String.raw`^(?<callsign>[@]?[A-Z0-9/]+)` + CMD_ALT + NUM_ALT);
const HEARTBEAT_RE = /^\s*(?<callsign>[@](?:ALLCALL|HB)\s+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!\s+SNR))(?:\s(?<grid>[A-R]{2}[0-9]{2}))?\b/;
const COMPOUND_MSG_RE = new RegExp(String.raw`^\s*[\x60](?<callsign>[@]?[A-Z0-9/]+)(?<extra>(?<grid>\s?[A-R]{2}[0-9]{2})?` + CMD_ALT + NUM_ALT + ')');

function heartbeatFrame(text: string, call: string): { bits: number[]; n: number } | null {
  const m = HEARTBEAT_RE.exec(text); if (!m || !call) return null;
  const type = m.groups!.type, alt = type.startsWith('CQ'), grid = m.groups!.grid ?? '';
  let extra = grid.length === 4 ? packGrid(grid) : NMAXGRID;
  let n3 = Math.max(0, HBS.indexOf(type));
  if (alt) { extra |= 0x8000; n3 = Math.max(0, CQS.indexOf(type)); }
  const b = compoundFrame(call, FRAME_HEARTBEAT, extra, n3); if (!b) return null;
  return { bits: b, n: m[0].length };
}
function compoundMessage(text: string): { bits: number[]; n: number } | null {
  const m = COMPOUND_MSG_RE.exec(text); if (!m) return null;
  const call = m.groups!.callsign, grid = (m.groups!.grid ?? '').trim(), cmd = m.groups!.cmd ?? '', num = (m.groups!.num ?? '').trim();
  if (!call) return null;
  let type = FRAME_COMPOUND, extra = NMAXGRID;
  const code = CMD_CODE.get(cmd);
  if (cmd && code !== undefined && code >= 0) { extra = NUSERGRID + packCmd(code, packNum(num).v); type = FRAME_COMPOUND_DIRECTED; }
  else if (grid) extra = packGrid(grid);
  const b = compoundFrame(call, type, extra, 0); if (!b) return null;
  return { bits: b, n: m[0].length };
}
function directedMessage(text: string, mycall: string): { bits: number[]; n: number; to: string; toCompound: boolean; cmd: string; num: string } | null {
  const m = DIRECTED_RE.exec(text); if (!m) return null;
  let to = m.groups!.callsign; const cmd = m.groups!.cmd ?? '', num = m.groups!.num ?? '';
  if (!cmd) return null;
  const from = isCompoundCallsign(mycall) ? '<....>' : mycall;
  const v = isValidCallsign(to); if (to === mycall || !v.valid) return null;
  const toCompound = v.compound, realTo = to;
  if (toCompound) to = '<....>';
  let code = CMD_CODE.get(cmd); if (code === undefined) code = CMD_CODE.get(cmd.trim());
  if (code === undefined || code < 0) return null;
  const pn = packNum(num.trim());
  const f = packCall28(from), t = packCall28(to);
  if (f.v === 0 || t.v === 0) return null;
  const b: number[] = [];
  put(b, FRAME_DIRECTED, 3); put(b, f.v, 28); put(b, t.v, 28); put(b, code % 32, 5);
  put(b, ((f.portable ? 1 : 0) << 7) + ((t.portable ? 1 : 0) << 6) + pn.v, 8);
  return { bits: b, n: m[0].length, to: realTo, toCompound, cmd: CMD_CODE.has(cmd) ? cmd : cmd.trim(), num };
}

export type Speed = 'normal' | 'fast' | 'turbo' | 'slow';
/**
 * A typed line → frames, the way JS8 sends it: heartbeats and CQs, compound callsigns and groups, directed commands
 * with their checksums, then text. The first frame is flagged first and the last flagged last.
 */
export function buildMessageFrames(mycall: string, mygrid: string, selectedCall: string, text: string, speed: Speed): Frame[] {
  const frames: { bits: number[]; flags: number }[] = [];
  let line = text.toUpperCase();
  if (line.startsWith(mycall + ':') || line.startsWith(mycall + ' ')) line = line.slice(mycall.length + 1).trimStart();
  if (selectedCall && !line.startsWith(selectedCall) && !line.startsWith('`')) {
    const startsBase = line.startsWith('@ALLCALL') || /^\s*CQ\b/.test(line) || /^\s*(?:HB|HEARTBEAT)\b/.test(line);
    const firstWord = line.split(/\s+/)[0] ?? '';
    const startsCall = firstWord.length > 3 && isValidCallsign(firstWord).valid;
    if (!startsBase && !startsCall) line = `${selectedCall}${line.startsWith(' ') ? '' : ' '}${line}`;
  }
  const mycallCompound = isCompoundCallsign(mycall);
  let hasDirected = false, hasData = false, guard = 0;
  while (line.length > 0 && guard++ < 200) {
    const hb = !hasDirected && !hasData ? heartbeatFrame(line, mycall) : null;
    const cmp = !hasDirected && !hasData && !hb ? compoundMessage(line) : null;
    const dir = !hasDirected && !hasData && !hb && !cmp ? directedMessage(line, mycall) : null;
    if (hb) { frames.push({ bits: hb.bits, flags: 0 }); line = line.slice(hb.n); continue; }
    if (cmp) { frames.push({ bits: cmp.bits, flags: 0 }); line = line.slice(cmp.n); continue; }
    if (dir) {
      hasDirected = true;
      if (mycallCompound || dir.toCompound) {
        const de = compoundMessage(`\x60${mycall} ${mygrid}`); if (de) frames.push({ bits: de.bits, flags: 0 });
        const dc = compoundMessage(`\x60${dir.to}${dir.cmd}${dir.num}`); if (dc) frames.push({ bits: dc.bits, flags: 0 });
      } else frames.push({ bits: dir.bits, flags: 0 });
      line = line.slice(dir.n);
      const code = CMD_CODE.get(dir.cmd) ?? CMD_CODE.get(dir.cmd.trim()) ?? -1;
      if (BUFFERED_CMDS.has(code) && line) {
        line = line.trimStart();
        const size = CHECKSUM_CMDS.get(code) ?? 0;
        if (size === 32) line = `${line} ${checksum32(line)}`;
        else if (size === 16) line = `${line} ${checksum16(line)}`;
      }
      continue;
    }
    const d = speed === 'normal' ? packData(line) : packFastData(line);
    if (d.chars <= 0) break;
    hasData = true;
    frames.push({ bits: d.bits, flags: speed === 'normal' ? 0 : FLAG_DATA });
    line = line.slice(d.chars);
  }
  if (!frames.length) return [];
  frames[0].flags |= FLAG_FIRST; frames[frames.length - 1].flags |= FLAG_LAST;
  return frames.map(f => toFrame(f.bits, f.flags));
}
