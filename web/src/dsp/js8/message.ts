/**
 * The JS8 message layer: what a frame's 72 bits carry, how frames make a transmission, and what the assembled
 * text means.
 *
 * Frame types (first bits of the 72): 000 heartbeat, 001 compound callsign, 010 compound directed, 011 directed,
 * 10 data (character code of the User Guide's Appendix A), 11 dictionary-compressed data.
 * Directed frame: type(3) from(28) to(28) command(5) extra(8). Callsigns use the 28-bit packing of the EME 2000
 * paper (JT65). Data frames end with a 0 and then 1s to the end of the frame, so 69 bits carry characters.
 */
import { FLAG_FIRST, FLAG_LAST, type Frame } from './codec.js';
import { HUFFMAN } from './tables.js';

export type FrameKind = 'heartbeat' | 'compound' | 'compoundDirected' | 'directed' | 'data' | 'compressed';
export interface Js8Frame {
  kind: FrameKind;
  flags: number;
  from?: string;
  to?: string;
  cmd?: number;
  extra?: number;
  /** SNR carried in a directed frame, dB. */
  snr?: number;
  /** Characters a data frame carries; for a directed frame, its rendered head ("K1ABC: W9XYZ HEARTBEAT SNR -12"). */
  text?: string;
}

/** Directed commands whose 5-bit codes are established. */
export const CMD_TEXT = 31, CMD_HB_SNR = 29;
export const COMMANDS: Readonly<Record<number, string>> = { [CMD_HB_SNR]: 'HEARTBEAT SNR', [CMD_TEXT]: '' };

// ---- bits ---------------------------------------------------------------------------------------------------------
function getBits(p: Uint8Array, at: number, n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + p[at + i]; return v; }
function putBits(p: Uint8Array, at: number, n: number, v: number): void { for (let i = n - 1; i >= 0; i--) { p[at + i] = v % 2; v = Math.floor(v / 2); } }

// ---- callsigns (28 bits) -------------------------------------------------------------------------------------------
const A37 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ', A36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A27 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
export const NBASE = 37 * 36 * 10 * 27 * 27 * 27;
/** A standard callsign (one or two characters, a digit, up to three letters) → 28 bits, or -1. */
export function packCall(raw: string): number {
  const c = raw.trim().toUpperCase();
  let s: string;
  if (/^[A-Z0-9][A-Z0-9][0-9][A-Z]{0,3}$/.test(c)) s = c.padEnd(6);
  else if (/^[A-Z][0-9][A-Z]{0,3}$/.test(c)) s = (' ' + c).padEnd(6);
  else return -1;
  const i0 = A37.indexOf(s[0]), i1 = A36.indexOf(s[1]), i2 = Number(s[2]), i3 = A27.indexOf(s[3]), i4 = A27.indexOf(s[4]), i5 = A27.indexOf(s[5]);
  if (i0 < 0 || i1 < 0 || i3 < 0 || i4 < 0 || i5 < 0) return -1;
  return ((((i0 * 36 + i1) * 10 + i2) * 27 + i3) * 27 + i4) * 27 + i5;
}
/** 28 bits → the callsign, or `#n` above the standard range (groups and other special values). */
export function unpackCall(n: number): string {
  if (n >= NBASE) return `#${n - NBASE}`;
  const c: string[] = [];
  c[5] = A27[n % 27]; n = Math.floor(n / 27); c[4] = A27[n % 27]; n = Math.floor(n / 27); c[3] = A27[n % 27]; n = Math.floor(n / 27);
  c[2] = String(n % 10); n = Math.floor(n / 10); c[1] = A36[n % 36]; n = Math.floor(n / 36); c[0] = A37[n];
  return c.join('').trim();
}
export const isStandardCall = (c: string): boolean => packCall(c) >= 0;

// ---- SNR in the extra byte -------------------------------------------------------------------------------------------
/** The low 6 bits hold SNR + 31 (0 = no number), -30..+30 dB. */
export const snrToExtra = (snr: number): number => Math.max(-30, Math.min(30, Math.round(snr))) + 31;
export const extraToSnr = (x: number): number | undefined => { const v = x & 63; return v === 0 ? undefined : v - 31; };
const fmtSnr = (s: number) => `${s < 0 ? '-' : '+'}${String(Math.abs(s)).padStart(2, '0')}`;

// ---- character code ---------------------------------------------------------------------------------------------------
const CODE_OF = new Map<string, string>(Object.entries(HUFFMAN));
interface Node { c?: string; k: [Node | null, Node | null]; }
const ROOT: Node = { k: [null, null] };
for (const [ch, code] of CODE_OF) { let n = ROOT; for (const b of code) { const i = b === '1' ? 1 : 0; n = n.k[i] ?? (n.k[i] = { k: [null, null] }); } n.c = ch; }
export const encodable = (ch: string): boolean => CODE_OF.has(ch);
/** Text as the data frames would carry it: upper case, characters the code has. */
export function cleanText(t: string): string { return [...t.toUpperCase().replace(/\s+/g, ' ')].filter(encodable).join(''); }
export const DATA_BITS = 69;
export function codeBits(t: string): number { let n = 0; for (const ch of t) n += CODE_OF.get(ch)?.length ?? 0; return n; }
function decodeCodes(bits: Uint8Array, from: number, to: number): string | null {
  let s = '', n = ROOT;
  for (let i = from; i < to; i++) { const nx = n.k[bits[i]]; if (!nx) return null; n = nx; if (n.c !== undefined) { s += n.c; n = ROOT; } }
  return n === ROOT ? s : null;
}

// ---- frames ---------------------------------------------------------------------------------------------------------
export function unpackFrame(f: Frame): Js8Frame {
  const p = f.payload;
  if (p[0] === 1) {
    if (p[1] === 1) return { kind: 'compressed', flags: f.flags };
    let end = 71; while (end >= 2 && p[end] === 1) end--;
    if (end < 2 || p[end] !== 0) return { kind: 'data', flags: f.flags, text: '' };
    return { kind: 'data', flags: f.flags, text: decodeCodes(p, 2, end) ?? '' };
  }
  const type = getBits(p, 0, 3);
  if (type === 3) {
    const from = unpackCall(getBits(p, 3, 28)), to = unpackCall(getBits(p, 31, 28)), cmd = getBits(p, 59, 5), extra = getBits(p, 64, 8);
    const name = COMMANDS[cmd];
    const snr = cmd === CMD_HB_SNR ? extraToSnr(extra) : undefined;
    const head = `${from}: ${to}${name === undefined ? ` CMD${cmd}` : name ? ` ${name}` : ''}${snr !== undefined ? ` ${fmtSnr(snr)}` : ''}`;
    return { kind: 'directed', flags: f.flags, from, to, cmd, extra, snr, text: head };
  }
  return { kind: type === 0 ? 'heartbeat' : type === 1 ? 'compound' : 'compoundDirected', flags: f.flags };
}

export function packDirected(from: string, to: string, cmd: number, extra: number, flags: number): Frame | null {
  const a = packCall(from), b = packCall(to);
  if (a < 0 || b < 0 || cmd < 0 || cmd > 31) return null;
  const p = new Uint8Array(72);
  putBits(p, 0, 3, 3); putBits(p, 3, 28, a); putBits(p, 31, 28, b); putBits(p, 59, 5, cmd); putBits(p, 64, 8, extra & 0xFF);
  return { payload: p, flags };
}
/** As many characters of `t` as fit one data frame; returns the frame and how many characters it took. */
export function packData(t: string, flags: number): { frame: Frame; used: number } {
  const p = new Uint8Array(72); p[0] = 1; p[1] = 0;
  let at = 2, used = 0;
  for (const ch of t) { const c = CODE_OF.get(ch); if (!c) { used++; continue; } if (at + c.length > 2 + DATA_BITS) break; for (const b of c) p[at++] = b === '1' ? 1 : 0; used++; }
  p[at++] = 0; while (at < 72) p[at++] = 1;
  return { frame: { payload: p, flags }, used };
}
/** Text → data frames (flags not set). */
export function dataFrames(t: string): Frame[] {
  const out: Frame[] = []; let rest = cleanText(t);
  while (rest.length) { const { frame, used } = packData(rest, 0); out.push(frame); rest = rest.slice(Math.max(1, used)); }
  return out;
}

export type Compose =
  | { kind: 'directed'; from: string; to: string; text: string }
  | { kind: 'hbsnr'; from: string; to: string; snr: number }
  | { kind: 'text'; text: string };
/** A message → its frames in order, the first and last flagged. Null when a callsign cannot be sent this way. */
export function buildFrames(c: Compose): Frame[] | null {
  let frames: Frame[];
  if (c.kind === 'hbsnr') { const f = packDirected(c.from, c.to, CMD_HB_SNR, snrToExtra(c.snr), 0); if (!f) return null; frames = [f]; }
  else if (c.kind === 'directed') {
    const head = packDirected(c.from, c.to, CMD_TEXT, 0, 0); if (!head) return null;
    frames = [head, ...dataFrames(c.text)];
  } else { frames = dataFrames(c.text); if (!frames.length) return null; }
  frames[0].flags |= FLAG_FIRST; frames[frames.length - 1].flags |= FLAG_LAST;
  return frames;
}

// ---- assembled text: what a message means --------------------------------------------------------------------------
export type MsgKind = 'heartbeat' | 'hbsnr' | 'cq' | 'allcall' | 'group' | 'directed' | 'snr' | 'query' | 'msg' | 'msgto' | 'querymsgs' | 'querymsg' | 'ack' | 'relay' | 'text';
export interface Js8Meaning {
  kind: MsgKind;
  from: string;
  /** A callsign, @ALLCALL, @HB or @GROUP, or '' for plain text. */
  to: string;
  body: string;
  snr?: number;
  grid?: string;
  /** Relay hops after the first addressee, in order. */
  path?: string[];
  /** Final addressee of a MSG TO: or a relay. */
  dest?: string;
  msgId?: number;
  command?: string;
}
const QUERIES = ['SNR?', 'GRID?', 'INFO?', 'STATUS?', 'HEARING?', 'AGN?', 'QSL?', 'HW CPY?'];
const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i;
/**
 * Reads an assembled message the way the User Guide writes them: "FROM: TO COMMAND ..." for directed traffic,
 * "FROM: @GROUP ...", heartbeats "FROM: @HB HEARTBEAT GRID", relays "FROM: HOP>HOP>TEXT", the inbox commands
 * MSG, MSG TO:CALL, QUERY MSGS, QUERY MSG n, and ACK.
 */
export function parseMessage(text: string): Js8Meaning {
  const t = text.replace(/♢/g, '').trim();
  const m = /^([A-Z0-9/]+):\s*(.*)$/s.exec(t);
  if (!m) return { kind: 'text', from: '', to: '', body: t };
  const from = m[1]; let rest = m[2].trim();
  const out: Js8Meaning = { kind: 'text', from, to: '', body: rest };
  // relay: HOP>HOP>TEXT
  const rl = /^([A-Z0-9/@]+)>((?:[A-Z0-9/@]+>)*)(.*)$/s.exec(rest);
  if (rl && !/^\S+\s/.test(rest.slice(0, rest.indexOf('>')))) {
    const hops = rl[2] ? rl[2].split('>').filter(Boolean) : [];
    return { kind: 'relay', from, to: rl[1], body: rl[3].trim(), path: hops, dest: hops.length ? hops[hops.length - 1] : rl[1] };
  }
  const sp = rest.indexOf(' '), first = sp < 0 ? rest : rest.slice(0, sp), after = sp < 0 ? '' : rest.slice(sp + 1).trim();
  if (/^CQ\b/.test(rest)) { const g = rest.split(/\s+/).find(w => GRID_RE.test(w)); return { kind: 'cq', from, to: '@CQ', body: rest, grid: g }; }
  if (!/^@?[A-Z0-9/]+$/.test(first)) return out;
  out.to = first; rest = after; out.body = rest;
  const words = rest.split(/\s+/).filter(Boolean);
  const grid = words.find(w => GRID_RE.test(w));
  if (/^HEARTBEAT SNR\b/.test(rest)) {
    const s = /HEARTBEAT SNR ([+-]\d+)/.exec(rest); const id = /\bMSG (\d+)/.exec(rest);
    return { ...out, kind: 'hbsnr', snr: s ? Number(s[1]) : undefined, msgId: id ? Number(id[1]) : undefined, command: 'HEARTBEAT SNR' };
  }
  if (first === '@HB' || /^HEARTBEAT\b/.test(rest) || /^HB\b/.test(rest)) return { ...out, kind: 'heartbeat', grid, command: 'HEARTBEAT' };
  let mm: RegExpExecArray | null;
  if ((mm = /^MSG TO:\s*([A-Z0-9/]+)\s*(.*)$/s.exec(rest))) return { ...out, kind: 'msgto', dest: mm[1], body: mm[2].trim(), command: 'MSG TO:' };
  if ((mm = /^MSG\s+(.*)$/s.exec(rest))) return { ...out, kind: 'msg', body: mm[1].trim(), command: 'MSG' };
  if (/^QUERY MSGS\b/.test(rest)) return { ...out, kind: 'querymsgs', body: '', command: 'QUERY MSGS' };
  if ((mm = /^QUERY MSG\s+(\d+)/.exec(rest))) return { ...out, kind: 'querymsg', msgId: Number(mm[1]), body: '', command: 'QUERY MSG' };
  if (/^ACK\b/.test(rest)) return { ...out, kind: 'ack', command: 'ACK' };
  if ((mm = /^SNR\s+([+-]?\d+)/.exec(rest))) return { ...out, kind: 'snr', snr: Number(mm[1]), command: 'SNR' };
  const q = QUERIES.find(x => rest === x || rest.startsWith(x + ' '));
  if (q) return { ...out, kind: 'query', command: q };
  if (first === '@ALLCALL') return { ...out, kind: 'allcall', grid };
  if (first.startsWith('@')) return { ...out, kind: 'group', grid };
  return { ...out, kind: 'directed', grid };
}

// ---- reassembly -----------------------------------------------------------------------------------------------------
export interface FramePart { frame: Js8Frame; mode: string; hz: number; slotMs: number; snr: number; dt: number; }
export interface Js8Message {
  id: string; mode: string; hz: number; startMs: number; endMs: number; snr: number; dt: number;
  frames: number; text: string; complete: boolean; meaning: Js8Meaning;
}
interface Open { id: string; mode: string; hz: number; startMs: number; lastMs: number; period: number; snr: number[]; dt: number[]; head: string; body: string; frames: number; }
/**
 * Joins frames into transmissions: the same speed, within a few tones of the same offset, in consecutive slots,
 * from a first-flagged frame to a last-flagged one. A transmission with no frame for a minute is closed as it is.
 */
export class Assembler {
  private open: Open[] = [];
  private seq = 0;
  onMessage: (m: Js8Message) => void = () => {};
  push(p: FramePart, periodS: number, toneHz: number): void {
    const f = p.frame;
    let o = this.open.find(x => x.mode === p.mode && Math.abs(x.hz - p.hz) <= 4 * toneHz && p.slotMs > x.lastMs && p.slotMs - x.lastMs <= 2 * periodS * 1000 + 500);
    if (o && (f.flags & FLAG_FIRST)) { this.close(o, false); o = undefined; }
    if (!o) {
      o = { id: `${p.mode}-${p.slotMs}-${Math.round(p.hz)}-${this.seq++}`, mode: p.mode, hz: p.hz, startMs: p.slotMs, lastMs: p.slotMs, period: periodS, snr: [], dt: [], head: '', body: '', frames: 0 };
      this.open.push(o);
    }
    o.lastMs = p.slotMs; o.frames++; o.snr.push(p.snr); o.dt.push(p.dt); o.hz = (o.hz * (o.frames - 1) + p.hz) / o.frames;
    if (f.kind === 'directed') o.head = o.head ? o.head : f.text ?? '';
    else if (f.kind === 'data') o.body += f.text ?? '';
    else if (f.kind === 'compressed') o.body += '';
    if (f.kind === 'directed' && o.frames > 1 && o.head !== f.text) o.body += ` ${f.text}`;
    if (f.flags & FLAG_LAST) this.close(o, true);
    else this.emit(o, false);
  }
  /** Close transmissions that have gone quiet. */
  tick(nowMs: number): void { for (const o of [...this.open]) if (nowMs - o.lastMs > Math.max(60_000, 3 * o.period * 1000)) this.close(o, false); }
  private text(o: Open): string { const b = o.body.replace(/\s+/g, ' '); return o.head ? `${o.head}${b ? (o.head.endsWith(' ') ? '' : ' ') + b.trimStart() : ''}`.trim() : b.trim(); }
  private emit(o: Open, complete: boolean): void {
    const text = this.text(o);
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    this.onMessage({ id: o.id, mode: o.mode, hz: Math.round(o.hz), startMs: o.startMs, endMs: o.lastMs, snr: Math.round(avg(o.snr)), dt: Math.round(avg(o.dt) * 10) / 10, frames: o.frames, text, complete, meaning: parseMessage(text) });
  }
  private close(o: Open, complete: boolean): void { this.open = this.open.filter(x => x !== o); this.emit(o, complete); }
}
