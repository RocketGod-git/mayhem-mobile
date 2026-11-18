/**
 * MPEG-2 PSI (ITU-T H.222.0: PAT, PMT, CRC-32 of Annex A) and ATSC PSIP (A/65: STT, MGT, TVCT/CVCT, EIT, ETT, RRT,
 * the multiple string structure with the Annex C Huffman text, and the descriptors receivers use).
 */
import { HUFF_TITLE, HUFF_DESC } from './huffman-tables.js';

const CRC_T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; CRC_T[i] = c >>> 0; }
/** CRC-32 of H.222.0 Annex A; a whole section including its CRC gives 0. */
export function crc32(b: Uint8Array, from = 0, to = b.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = ((c << 8) ^ CRC_T[((c >>> 24) ^ b[i]) & 255]) >>> 0;
  return c >>> 0;
}

/** Reassembles sections on one PID from TS payloads; whole sections come out through `onSection`. */
export class SectionAssembler {
  private buf: Uint8Array | null = null; private len = 0;
  constructor(private readonly onSection: (s: Uint8Array) => void) {}
  reset(): void { this.buf = null; this.len = 0; }
  feed(pusi: boolean, p: Uint8Array): void {
    if (pusi) {
      if (!p.length) return;
      const ptr = p[0];
      if (this.buf && ptr > 0) { this.append(p.subarray(1, 1 + ptr)); this.drain(); }
      this.buf = new Uint8Array(4096); this.len = 0;
      this.append(p.subarray(1 + ptr));
      this.drain();
    } else if (this.buf) { this.append(p); this.drain(); }
  }
  private append(p: Uint8Array): void {
    if (!this.buf) return;
    if (this.len + p.length > this.buf.length) { const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + p.length)); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; }
    this.buf.set(p, this.len); this.len += p.length;
  }
  private drain(): void {
    while (this.buf && this.len >= 3) {
      const b = this.buf;
      if (b[0] === 0xff) { this.buf = null; this.len = 0; return; }
      const L = ((b[1] & 0x0f) << 8) | b[2];
      if (L > 4093) { this.buf = null; this.len = 0; return; }
      if (this.len < 3 + L) return;
      this.onSection(b.slice(0, 3 + L));
      b.copyWithin(0, 3 + L, this.len); this.len -= 3 + L;
    }
  }
}

export interface SecHeader { tableId: number; ext: number; version: number; current: boolean; section: number; last: number }
export function secHeader(s: Uint8Array): SecHeader {
  return { tableId: s[0], ext: (s[3] << 8) | s[4], version: (s[5] >> 1) & 31, current: (s[5] & 1) === 1, section: s[6], last: s[7] };
}
const u16 = (s: Uint8Array, p: number) => (s[p] << 8) | s[p + 1];
const u32 = (s: Uint8Array, p: number) => ((s[p] << 24) | (s[p + 1] << 16) | (s[p + 2] << 8) | s[p + 3]) >>> 0;
const pid13 = (s: Uint8Array, p: number) => ((s[p] & 0x1f) << 8) | s[p + 1];
const latin = (s: Uint8Array) => { let t = ''; for (const c of s) t += String.fromCharCode(c); return t; };

// ---- Huffman text (A/65 Annex C) ----
type Tree = Map<string, number>;
function trees(src: string): Map<number, Tree> {
  const out = new Map<number, Tree>();
  for (const part of src.split(';')) {
    const [prior, list] = part.split(':');
    const t: Tree = new Map();
    for (const e of list.split(',')) { const [code, sym] = e.split('='); t.set(code, Number(sym)); }
    out.set(Number(prior), t);
  }
  return out;
}
let huff: Map<number, Tree>[] | null = null;
/** The trees of compression_type 1 (titles) and 2 (descriptions), prior character to code to symbol. */
export function huffTrees(ctype: 1 | 2): Map<number, Tree> {
  huff ??= [trees(HUFF_TITLE), trees(HUFF_DESC)];
  return huff[ctype - 1];
}
/** Order-1 Huffman: the first character uses prior 0; ESC (27) sends the next byte plain; a plain byte of 128 or more
 *  is followed by another plain byte; Terminate (0) ends the string. */
export function huffDecode(data: Uint8Array, ctype: 1 | 2): string {
  const tab = huffTrees(ctype), n = data.length * 8;
  const bit = (i: number) => (data[i >> 3] >> (7 - (i & 7))) & 1;
  let pos = 0, prior = 0, plain = false, out = '';
  while (pos < n) {
    if (plain) {
      if (pos + 8 > n) break;
      let ch = 0; for (let k = 0; k < 8; k++) ch = (ch << 1) | bit(pos + k);
      pos += 8;
      if (ch === 0) break;
      out += String.fromCharCode(ch);
      prior = ch < 128 ? ch : 0; plain = ch >= 128;
      continue;
    }
    const tree = tab.get(prior); if (!tree) break;
    let code = '', sym = -1;
    while (pos < n && code.length < 24) { code += bit(pos++) ? '1' : '0'; const s = tree.get(code); if (s !== undefined) { sym = s; break; } }
    if (sym <= 0) break;
    if (sym === 27) { plain = true; continue; }
    out += String.fromCharCode(sym); prior = sym;
  }
  return out;
}

export interface MString { lang: string; text: string }
/** multiple_string_structure (A/65 6.10): every string with its language. */
export function mss(s: Uint8Array, p = 0, end = s.length): MString[] {
  const out: MString[] = [];
  if (p >= end) return out;
  const n = s[p++];
  for (let i = 0; i < n && p + 4 <= end; i++) {
    const lang = latin(s.subarray(p, p + 3)); p += 3;
    const segs = s[p++];
    let text = '';
    for (let j = 0; j < segs && p + 3 <= end; j++) {
      const ct = s[p], mode = s[p + 1], nb = s[p + 2]; p += 3;
      const seg = s.subarray(p, Math.min(end, p + nb)); p += nb;
      if (ct === 0 && mode <= 0x33) for (const b of seg) text += String.fromCharCode((mode << 8) | b);
      else if (ct === 0 && mode === 0x3f) for (let k = 0; k + 1 < seg.length; k += 2) text += String.fromCharCode((seg[k] << 8) | seg[k + 1]);
      else if ((ct === 1 || ct === 2) && mode === 0xff) text += huffDecode(seg, ct);
    }
    out.push({ lang, text });
  }
  return out;
}
const firstText = (m: MString[]) => (m.find(x => x.lang === 'eng') ?? m[0])?.text ?? '';

// ---- descriptors ----
export interface ServiceElement { streamType: number; pid: number; lang: string }
export interface Caption { lang: string; digital: boolean; service: number; line21Field: number; easyReader: boolean; wide: boolean }
export interface Advisory { region: number; dims: [number, number][]; text: string }
export interface Ac3Info { sampleRate: string; bsid: number; kbps: number; channels: string; lang: string }
export interface Descriptors {
  longName?: string; pcrPid?: number; elements?: ServiceElement[]; captions?: Caption[]; advisory?: Advisory[];
  lang?: string; registration?: string; ac3?: Ac3Info; tags: number[];
}
const AC3_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const AC3_MODES = ['1+1', '1/0', '2/0', '3/0', '2/1', '3/1', '2/2', '3/2'];
export function descriptors(s: Uint8Array, p: number, end: number): Descriptors {
  const d: Descriptors = { tags: [] };
  while (p + 2 <= end) {
    const tag = s[p], len = s[p + 1], b = p + 2, e = Math.min(end, b + len);
    d.tags.push(tag);
    try {
      if (tag === 0xa0) d.longName = firstText(mss(s, b, e));
      else if (tag === 0xa1) {
        d.pcrPid = pid13(s, b); const n = s[b + 2]; d.elements = [];
        for (let i = 0, q = b + 3; i < n && q + 6 <= e; i++, q += 6) d.elements.push({ streamType: s[q], pid: pid13(s, q + 1), lang: latin(s.subarray(q + 3, q + 6)).replace(/\0/g, '') });
      } else if (tag === 0x86) {
        const n = s[b] & 0x1f; d.captions = [];
        for (let i = 0, q = b + 1; i < n && q + 6 <= e; i++, q += 6) {
          const dig = (s[q + 3] & 0x80) !== 0;
          d.captions.push({ lang: latin(s.subarray(q, q + 3)), digital: dig, service: dig ? s[q + 3] & 0x3f : 0, line21Field: dig ? -1 : s[q + 3] & 1, easyReader: (s[q + 4] & 0x80) !== 0, wide: (s[q + 4] & 0x40) !== 0 });
        }
      } else if (tag === 0x87) {
        const n = s[b] & 0x3f; d.advisory = [];
        let q = b + 1;
        for (let i = 0; i < n && q + 2 <= e; i++) {
          const region = s[q], nd = s[q + 1]; q += 2;
          const dims: [number, number][] = [];
          for (let k = 0; k < nd; k++, q += 2) dims.push([s[q], s[q + 1] & 0x0f]);
          const dl = s[q++]; const text = dl ? firstText(mss(s, q, q + dl)) : ''; q += dl;
          d.advisory.push({ region, dims, text });
        }
      } else if (tag === 0x0a) d.lang = latin(s.subarray(b, b + 3));
      else if (tag === 0x05) d.registration = latin(s.subarray(b, b + 4));
      else if (tag === 0x81 && len >= 3) {
        // A/52 Annex A AC-3 audio descriptor: sample rate, bsid, bit rate code (an upper limit from 32 up), channels
        const sr = s[b] >> 5, bsid = s[b] & 0x1f, brc = (s[b + 1] >> 2) & 0x3f, nc = (s[b + 2] >> 1) & 0x0f;
        const kbps = brc < 19 ? AC3_RATES[brc] : brc >= 32 && brc < 51 ? AC3_RATES[brc - 32] : 0;
        d.ac3 = { sampleRate: ['48 kHz', '44.1 kHz', '32 kHz'][sr] ?? 'any', bsid, kbps, channels: nc < 8 ? AC3_MODES[nc] : ['1', 'up to 2', 'up to 3', 'up to 4', 'up to 5', 'up to 6'][nc - 8] ?? '', lang: len >= 10 ? latin(s.subarray(b + len - 3, b + len)) : '' };
      }
    } catch { /* a cut-short descriptor */ }
    p = b + len;
  }
  return d;
}

// ---- tables ----
export interface Pat { tsid: number; version: number; programs: { program: number; pid: number }[] }
export function parsePat(s: Uint8Array): Pat {
  const h = secHeader(s), programs: Pat['programs'] = [];
  for (let q = 8; q + 4 <= s.length - 4; q += 4) { const pn = u16(s, q); if (pn) programs.push({ program: pn, pid: pid13(s, q + 2) }); }
  return { tsid: h.ext, version: h.version, programs };
}
export interface PmtStream { type: number; pid: number; desc: Descriptors }
export interface Pmt { program: number; version: number; pcrPid: number; desc: Descriptors; streams: PmtStream[] }
export function parsePmt(s: Uint8Array): Pmt {
  const h = secHeader(s), pil = ((s[10] & 0x0f) << 8) | s[11], streams: PmtStream[] = [];
  let p = 12 + pil;
  while (p + 5 <= s.length - 4) { const il = ((s[p + 3] & 0x0f) << 8) | s[p + 4]; streams.push({ type: s[p], pid: pid13(s, p + 1), desc: descriptors(s, p + 5, p + 5 + il) }); p += 5 + il; }
  return { program: h.ext, version: h.version, pcrPid: pid13(s, 8), desc: descriptors(s, 12, 12 + pil), streams };
}
export interface MgtTable { type: number; pid: number; version: number; bytes: number }
export interface Mgt { version: number; tables: MgtTable[] }
export function parseMgt(s: Uint8Array): Mgt {
  const h = secHeader(s), n = u16(s, 9), tables: MgtTable[] = [];
  let p = 11;
  for (let i = 0; i < n && p + 11 <= s.length - 4; i++) { const dl = ((s[p + 9] & 0x0f) << 8) | s[p + 10]; tables.push({ type: u16(s, p), pid: pid13(s, p + 2), version: s[p + 4] & 31, bytes: u32(s, p + 5) }); p += 11 + dl; }
  return { version: h.version, tables };
}
export function tableTypeName(t: number): string {
  if (t === 0) return 'TVCT'; if (t === 1) return 'TVCT next'; if (t === 2) return 'CVCT'; if (t === 3) return 'CVCT next';
  if (t === 4) return 'channel ETT'; if (t === 5) return 'DCCSCT';
  if (t >= 0x100 && t <= 0x17f) return `EIT-${t - 0x100}`;
  if (t >= 0x200 && t <= 0x27f) return `ETT-${t - 0x200}`;
  if (t >= 0x301 && t <= 0x3ff) return `RRT ${t - 0x300}`;
  if (t >= 0x1400 && t <= 0x14ff) return `DCCT ${t - 0x1400}`;
  return `0x${t.toString(16).padStart(4, '0')}`;
}
export interface VChannel {
  major: number; minor: number; shortName: string; modulation: number; carrierHz: number; tsid: number; program: number;
  etm: number; access: boolean; hidden: boolean; hideGuide: boolean; serviceType: number; sourceId: number; desc: Descriptors;
}
export interface Vct { cable: boolean; tsid: number; version: number; section: number; last: number; channels: VChannel[] }
export function parseVct(s: Uint8Array): Vct {
  const h = secHeader(s), n = s[9], channels: VChannel[] = [];
  let p = 10;
  for (let i = 0; i < n && p + 32 <= s.length - 4; i++) {
    let name = ''; for (let k = 0; k < 7; k++) { const c = u16(s, p + 2 * k); if (c) name += String.fromCharCode(c); }
    const v = u32(s, p + 14), f = u16(s, p + 26), dl = ((s[p + 30] & 0x03) << 8) | s[p + 31];
    channels.push({ shortName: name.trim(), major: (v >> 18) & 0x3ff, minor: (v >> 8) & 0x3ff, modulation: v & 0xff, carrierHz: u32(s, p + 18), tsid: u16(s, p + 22), program: u16(s, p + 24),
      etm: f >> 14, access: ((f >> 13) & 1) === 1, hidden: ((f >> 12) & 1) === 1, hideGuide: ((f >> 9) & 1) === 1, serviceType: f & 0x3f, sourceId: u16(s, p + 28), desc: descriptors(s, p + 32, p + 32 + dl) });
    p += 32 + dl;
  }
  return { cable: s[0] === 0xc9, tsid: h.ext, version: h.version, section: h.section, last: h.last, channels };
}
/** GPS seconds (from 1980-01-06) less the GPS-UTC offset to Unix milliseconds. */
export const gpsToUnixMs = (gps: number, offset: number) => (gps + 315_964_800 - offset) * 1000;
export interface Stt { gps: number; offset: number; utcMs: number; dsStatus: boolean; dsDay: number; dsHour: number }
export function parseStt(s: Uint8Array): Stt {
  const gps = u32(s, 9), off = s[13], ds = u16(s, 14);
  return { gps, offset: off, utcMs: gpsToUnixMs(gps, off), dsStatus: (ds >> 15) === 1, dsDay: (ds >> 8) & 0x1f, dsHour: ds & 0xff };
}
export interface Event { eventId: number; startGps: number; seconds: number; etm: number; title: string; desc: Descriptors }
export interface Eit { sourceId: number; version: number; section: number; last: number; events: Event[] }
export function parseEit(s: Uint8Array): Eit {
  const h = secHeader(s), n = s[9], events: Event[] = [];
  let p = 10;
  for (let i = 0; i < n && p + 10 <= s.length - 4; i++) {
    const tl = s[p + 9];
    const title = firstText(mss(s, p + 10, p + 10 + tl));
    const q = p + 10 + tl, dl = ((s[q] & 0x0f) << 8) | s[q + 1];
    events.push({ eventId: ((s[p] & 0x3f) << 8) | s[p + 1], startGps: u32(s, p + 2), etm: (s[p + 6] >> 4) & 3, seconds: ((s[p + 6] & 0x0f) << 16) | (s[p + 7] << 8) | s[p + 8], title, desc: descriptors(s, q + 2, q + 2 + dl) });
    p = q + 2 + dl;
  }
  return { sourceId: h.ext, version: h.version, section: h.section, last: h.last, events };
}
export interface Ett { version: number; etmId: number; sourceId: number; eventId: number; isEvent: boolean; text: string }
export function parseEtt(s: Uint8Array): Ett {
  const h = secHeader(s), id = u32(s, 9);
  return { version: h.version, etmId: id, sourceId: id >>> 16, eventId: (id >> 2) & 0x3fff, isEvent: (id & 3) === 2, text: firstText(mss(s, 13, s.length - 4)) };
}
export interface Rrt { region: number; version: number; name: string; dims: { name: string; graduated: boolean; values: { abbrev: string; text: string }[] }[] }
export function parseRrt(s: Uint8Array): Rrt {
  const h = secHeader(s);
  let p = 9;
  const nl = s[p++], name = firstText(mss(s, p, p + nl)); p += nl;
  const nd = s[p++], dims: Rrt['dims'] = [];
  for (let i = 0; i < nd && p < s.length - 4; i++) {
    const l = s[p++], dn = firstText(mss(s, p, p + l)); p += l;
    const graduated = ((s[p] >> 4) & 1) === 1, nv = s[p++] & 0x0f, values: { abbrev: string; text: string }[] = [];
    for (let k = 0; k < nv; k++) { const la = s[p++], ab = firstText(mss(s, p, p + la)); p += la; const lr = s[p++], rv = firstText(mss(s, p, p + lr)); p += lr; values.push({ abbrev: ab, text: rv }); }
    dims.push({ name: dn, graduated, values });
  }
  return { region: h.ext & 0xff, version: h.version, name, dims };
}

export const STREAM_TYPES: Record<number, string> = {
  0x01: 'MPEG-1 video', 0x02: 'MPEG-2 video', 0x03: 'MPEG-1 audio', 0x04: 'MPEG-2 audio', 0x05: 'private sections', 0x06: 'PES private data',
  0x0b: 'DSM-CC data carousel', 0x0d: 'DSM-CC', 0x0f: 'AAC audio', 0x1b: 'H.264 video', 0x24: 'HEVC video', 0x81: 'AC-3 audio', 0x87: 'E-AC-3 audio', 0x95: 'data service table',
};
export const SERVICE_TYPES: Record<number, string> = { 1: 'ANALOG TV', 2: 'DIGITAL TV', 3: 'AUDIO', 4: 'DATA', 5: 'SOFTWARE', 6: 'UNASSOCIATED', 7: 'PARAMETERIZED', 8: 'ATSC 3.0', 9: 'ATSC 3.0 AUDIO' };
export const isVideo = (t: number) => t === 0x02 || t === 0x01 || t === 0x1b || t === 0x24;
export const isAudio = (t: number) => t === 0x81 || t === 0x87 || t === 0x03 || t === 0x04 || t === 0x0f;
/** A content advisory as the station words it (its rating description), else its region and dimension values. */
export function ratingText(a: Advisory[] | undefined): string {
  if (!a || !a.length) return '';
  const r = a.find(x => x.text) ?? a[0];
  return r.text || `region ${r.region} ${r.dims.map(([d, v]) => `${d}:${v}`).join(' ')}`;
}
