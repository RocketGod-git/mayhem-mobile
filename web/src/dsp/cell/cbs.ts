/**
 * ETWS and CMAS (Wireless Emergency Alerts) content from SIB10, SIB11 and SIB12:
 *   36.331 SIB10/11/12 fields; SIB11/SIB12 segments are joined in segment-number order up to lastSegment.
 *   23.041 9.4.1.2.1 Serial Number (GS 2 bits, Message Code 10 bits, Update Number 4 bits),
 *          9.4.1.2.2 Message Identifier, 9.3.24 Warning Type, 9.4.2.2.5 CB Data (pages of 82 octets + 1 length octet).
 *   23.038 5 CBS Data Coding Scheme, 6.2.1 GSM 7-bit default alphabet and extension table, 6.1.2.2 packing.
 */

const MSG_ID: Record<number, string> = {
  4352: 'ETWS earthquake warning', 4353: 'ETWS tsunami warning', 4354: 'ETWS earthquake and tsunami warning',
  4355: 'ETWS test message', 4356: 'ETWS other emergency type',
  4370: 'CMAS Presidential Level Alert',
  4371: 'CMAS Extreme Alert (Extreme, Immediate, Observed)',
  4372: 'CMAS Extreme Alert (Extreme, Immediate, Likely)',
  4373: 'CMAS Severe Alert (Extreme, Expected, Observed)',
  4374: 'CMAS Severe Alert (Extreme, Expected, Likely)',
  4375: 'CMAS Severe Alert (Severe, Immediate, Observed)',
  4376: 'CMAS Severe Alert (Severe, Immediate, Likely)',
  4377: 'CMAS Severe Alert (Severe, Expected, Observed)',
  4378: 'CMAS Severe Alert (Severe, Expected, Likely)',
  4379: 'CMAS Child Abduction Emergency (AMBER Alert)',
  4380: 'CMAS Required Monthly Test',
  4381: 'CMAS Exercise',
  4382: 'CMAS operator defined use',
  4396: 'CMAS Public Safety Alert',
  4398: 'CMAS State/Local WEA Test',
  4400: 'CMAS geo-fencing trigger',
};
for (let i = 4383; i <= 4395; i++) MSG_ID[i] = MSG_ID[i - 13] + ' (additional language)';
MSG_ID[4397] = MSG_ID[4396] + ' (additional language)';
MSG_ID[4399] = MSG_ID[4398] + ' (additional language)';

/** The primary-language identifier of an additional-language CMAS identifier (the same id otherwise). */
export function baseId(id: number): number {
  if (id >= 4383 && id <= 4395) return id - 13;
  if (id === 4397 || id === 4399) return id - 1;
  return id;
}
export const isWarningId = (id: number) => (id >= 4352 && id <= 4356) || (id >= 4370 && id <= 4400);
export const isAdditionalLanguage = (id: number) => baseId(id) !== id;
export function category(id: number): string { return MSG_ID[id] ?? (id >= 4352 && id <= 4359 ? 'ETWS reserved' : id >= 4370 && id <= 4399 ? 'CMAS reserved' : 'not an ETWS or CMAS identifier'); }

/** Short class label and a severity rank for color: 5 Presidential/ETWS disaster, 4 Extreme, 3 Severe/AMBER, 2 Public Safety, 1 tests and others. */
export function cmasClass(id: number): { label: string; rank: number; kind: 'ETWS' | 'CMAS' | '' } {
  const b = baseId(id);
  if (b === 4352) return { label: 'ETWS Earthquake', rank: 5, kind: 'ETWS' };
  if (b === 4353) return { label: 'ETWS Tsunami', rank: 5, kind: 'ETWS' };
  if (b === 4354) return { label: 'ETWS Earthquake and Tsunami', rank: 5, kind: 'ETWS' };
  if (b === 4355) return { label: 'ETWS Test', rank: 1, kind: 'ETWS' };
  if (b === 4356) return { label: 'ETWS Other', rank: 4, kind: 'ETWS' };
  if (b === 4370) return { label: 'Presidential', rank: 5, kind: 'CMAS' };
  if (b === 4371 || b === 4372) return { label: 'Extreme', rank: 4, kind: 'CMAS' };
  if (b >= 4373 && b <= 4378) return { label: 'Severe', rank: 3, kind: 'CMAS' };
  if (b === 4379) return { label: 'AMBER', rank: 3, kind: 'CMAS' };
  if (b === 4380) return { label: 'Required Monthly Test', rank: 1, kind: 'CMAS' };
  if (b === 4381) return { label: 'Exercise', rank: 1, kind: 'CMAS' };
  if (b === 4382) return { label: 'Operator', rank: 1, kind: 'CMAS' };
  if (b === 4396) return { label: 'Public Safety', rank: 2, kind: 'CMAS' };
  if (b === 4398) return { label: 'State/Local Test', rank: 1, kind: 'CMAS' };
  if (b === 4400) return { label: 'Geo-fencing trigger', rank: 1, kind: 'CMAS' };
  if (id >= 4352 && id <= 4359) return { label: 'ETWS', rank: 1, kind: 'ETWS' };
  if (id >= 4370 && id <= 4399) return { label: 'CMAS', rank: 1, kind: 'CMAS' };
  return { label: 'Unknown', rank: 0, kind: '' };
}

export const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
  + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT: Record<number, string> = { 0x0a: '\f', 0x14: '^', 0x28: '{', 0x29: '}', 0x2f: '\\', 0x3c: '[', 0x3d: '~', 0x3e: ']', 0x40: '|', 0x65: '€' };

/** 23.038 6.1.2.2: septets packed least significant bit first. */
export function unpack7(octets: Uint8Array, nChars?: number): number[] {
  let bits = 0, nb = 0;
  const out: number[] = [];
  for (const o of octets) {
    bits |= o << nb; nb += 8;
    while (nb >= 7) { out.push(bits & 0x7f); bits >>>= 7; nb -= 7; }
  }
  return nChars === undefined ? out : out.slice(0, nChars);
}
export function pack7(septets: number[]): Uint8Array {
  let bits = 0, nb = 0;
  const out: number[] = [];
  for (const s of septets) { bits |= s << nb; nb += 7; while (nb >= 8) { out.push(bits & 0xff); bits >>>= 8; nb -= 8; } }
  if (nb) out.push(bits & 0xff);
  return Uint8Array.from(out);
}
export function gsm7Text(septets: number[]): string {
  let s = '', esc = false;
  for (const c of septets) {
    if (esc) { s += GSM7_EXT[c] ?? '?'; esc = false; }
    else if (c === 0x1b) esc = true;
    else s += GSM7[c];
  }
  return s;
}
/** GSM 7-bit septets for a text (default alphabet and extension table); unknown characters become '?'. */
export function gsm7Septets(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const i = GSM7.indexOf(ch);
    if (i >= 0 && ch !== '\x1b') { out.push(i); continue; }
    const e = Object.entries(GSM7_EXT).find(([, v]) => v === ch);
    if (e) out.push(0x1b, Number(e[0])); else out.push(GSM7.indexOf('?'));
  }
  return out;
}

export type Alphabet = 'GSM7' | '8bit' | 'UCS2' | 'reserved' | 'unknown';
/** 23.038 5 (CBS Data Coding Scheme): alphabet, the language it names, and whether the text starts with a language code. */
export function dcsInfo(dcs: number): { alphabet: Alphabet; language: string | null; languagePrefix: boolean } {
  const g = dcs >> 4, lo = dcs & 15;
  if (g === 0) {
    const langs = ['German', 'English', 'Italian', 'French', 'Spanish', 'Dutch', 'Swedish', 'Danish', 'Portuguese', 'Finnish', 'Norwegian', 'Greek', 'Turkish', 'Hungarian', 'Polish', 'unspecified'];
    return { alphabet: 'GSM7', language: langs[lo], languagePrefix: false };
  }
  if (g === 1) return { alphabet: lo === 1 ? 'UCS2' : 'GSM7', language: null, languagePrefix: lo <= 1 };
  if (g === 2) return { alphabet: 'GSM7', language: ['Czech', 'Hebrew', 'Arabic', 'Russian', 'Icelandic'][lo] ?? null, languagePrefix: false };
  if (g === 3) return { alphabet: 'GSM7', language: null, languagePrefix: false };
  if ((g >= 4 && g <= 7) || g === 9) return { alphabet: (['GSM7', '8bit', 'UCS2', 'reserved'] as Alphabet[])[(dcs >> 2) & 3], language: null, languagePrefix: false };
  if (g === 15) return { alphabet: dcs & 4 ? '8bit' : 'GSM7', language: null, languagePrefix: false };
  return { alphabet: 'unknown', language: null, languagePrefix: false };
}

export interface CbContent { pages: number; alphabet: Alphabet; language: string | null; text: string; binaryHex?: string }
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** CB Data (23.041 9.4.2.2.5): number of pages, then each page as 82 octets and its information length. */
export function cbDataText(cb: Uint8Array, dcs: number): CbContent {
  const n = cb[0] ?? 0;
  const info = dcsInfo(dcs);
  const parts: Uint8Array[] = [];
  let p = 1;
  for (let i = 0; i < n && p < cb.length; i++) {
    const page = cb.subarray(p, p + 82);
    const ln = p + 82 < cb.length ? Math.min(cb[p + 82], 82) : page.length;
    parts.push(page.subarray(0, ln));
    p += 83;
  }
  let language = info.language, text = '';
  if (info.alphabet === 'GSM7') {
    text = parts.map(d => gsm7Text(unpack7(d, Math.floor(d.length * 8 / 7)))).join('');
    text = text.replace(/[\r\n]+$/, '');
    if (info.languagePrefix) { language = text.slice(0, 2); text = text.slice(3); }
  } else if (info.alphabet === 'UCS2') {
    const all = new Uint8Array(parts.reduce((s, d) => s + d.length, 0));
    let o = 0; for (const d of parts) { all.set(d, o); o += d.length; }
    let start = 0;
    if (info.languagePrefix) { language = gsm7Text(unpack7(all.subarray(0, 2), 2)); start = 2; }
    for (let i = start; i + 1 < all.length; i += 2) text += String.fromCharCode((all[i] << 8) | all[i + 1]);
    text = text.replace(/[\r\n\0]+$/, '');
  } else {
    const all = parts.map(hexOf).join('');
    return { pages: n, alphabet: info.alphabet, language, text: '', binaryHex: all };
  }
  return { pages: n, alphabet: info.alphabet, language, text };
}

export function serialInfo(sn: number): { scope: string; messageCode: number; updateNumber: number } {
  return { scope: ['cell-wide (immediate)', 'PLMN-wide', 'tracking-area-wide', 'cell-wide'][sn >> 14], messageCode: (sn >> 4) & 0x3ff, updateNumber: sn & 15 };
}

/** 23.041 9.3.24 Warning Type (SIB10): 7-bit type, emergency user alert, popup. */
export function warningTypeInfo(hex: string): { type: string; userAlert: boolean; popup: boolean } {
  const v = parseInt(hex.slice(0, 4).padEnd(4, '0'), 16);
  const t = v >> 9;
  return { type: ['earthquake', 'tsunami', 'earthquake and tsunami', 'test', 'other'][t] ?? `reserved ${t}`, userAlert: !!(v & 0x100), popup: !!(v & 0x80) };
}

const bitsNum = (s: unknown) => typeof s === 'string' && /^[01]+$/.test(s) ? parseInt(s, 2) : -1;
const bytesOfHex = (h: string) => { const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16); return o; };

export interface WarningMessage {
  key: string; kind: 'ETWS' | 'CMAS' | ''; source: 'SIB10' | 'SIB11' | 'SIB12';
  id: number; serial: number; scope: string; messageCode: number; updateNumber: number;
  category: string; cls: string; rank: number; additionalLanguage: boolean;
  warningType?: { type: string; userAlert: boolean; popup: boolean };
  complete: boolean; segments: number[]; lastSegment: number;
  dcs: number; alphabet: Alphabet | ''; language: string | null; pages: number; text: string; binaryHex: string;
  areaHex: string; cells: string[]; firstMs: number; lastMs: number; receptions: number;
}

interface Pending { msg: WarningMessage; seg: Map<number, { data: string; area: string; dcs: number }> }

/** Collects SIB10/SIB11/SIB12 from any number of cells into whole messages, one per message identifier and serial number. */
export class WarningAssembler {
  private readonly map = new Map<string, Pending>();

  /** Feeds one decoded SIB; returns the message it belongs to when that message is new, completed or carried by a new cell. */
  add(sib: string, v: Record<string, unknown>, cell: string, ms: number): WarningMessage | null {
    const r9 = sib.startsWith('sib12');
    const f = (n: string) => v[r9 ? `${n}-r9` : n];
    const id = bitsNum(f('messageIdentifier')), serial = bitsNum(f('serialNumber'));
    if (id < 0 || serial < 0) return null;
    const key = `${id}/${serial}`;
    let p = this.map.get(key), changed = false;
    if (!p) {
      const c = cmasClass(id), s = serialInfo(serial);
      p = { seg: new Map(), msg: {
        key, kind: c.kind, source: sib === 'sib10' ? 'SIB10' : r9 ? 'SIB12' : 'SIB11', id, serial, scope: s.scope, messageCode: s.messageCode, updateNumber: s.updateNumber,
        category: category(id), cls: c.label, rank: c.rank, additionalLanguage: isAdditionalLanguage(id),
        complete: false, segments: [], lastSegment: -1, dcs: -1, alphabet: '', language: null, pages: 0, text: '', binaryHex: '', areaHex: '',
        cells: [], firstMs: ms, lastMs: ms, receptions: 0 } };
      this.map.set(key, p);
      changed = true;
    }
    const m = p.msg;
    m.lastMs = Math.max(m.lastMs, ms); m.firstMs = Math.min(m.firstMs, ms); m.receptions++;
    if (!m.cells.includes(cell)) { m.cells.push(cell); changed = true; }
    if (sib === 'sib10') {
      if (typeof v.warningType === 'string' && !m.warningType) { m.warningType = warningTypeInfo(v.warningType); m.complete = true; changed = true; }
      return changed ? m : null;
    }
    const num = Number(f('warningMessageSegmentNumber'));
    if (!p.seg.has(num)) {
      const dcsHex = f('dataCodingScheme');
      p.seg.set(num, { data: String(f('warningMessageSegment') ?? ''), area: String(v['warningAreaCoordinatesSegment-r15'] ?? ''), dcs: typeof dcsHex === 'string' ? parseInt(dcsHex, 16) : -1 });
      if (f('warningMessageSegmentType') === 'lastSegment') m.lastSegment = num;
      m.segments = [...p.seg.keys()].sort((a, b) => a - b);
      changed = true;
      if (!m.complete && m.lastSegment >= 0 && m.segments.length >= m.lastSegment + 1 && m.segments.every((n, i) => n === i)) { this.finish(p); }
    }
    return changed ? m : null;
  }

  private finish(p: Pending): void {
    const m = p.msg, segs = m.segments.slice(0, m.lastSegment + 1).map(n => p.seg.get(n)!);
    const dcs = segs[0].dcs >= 0 ? segs[0].dcs : 0x0f;
    const c = cbDataText(bytesOfHex(segs.map(s => s.data).join('')), dcs);
    m.dcs = dcs; m.alphabet = c.alphabet; m.language = c.language; m.pages = c.pages; m.text = c.text; m.binaryHex = c.binaryHex ?? '';
    m.areaHex = segs.map(s => s.area).join('');
    m.complete = true;
  }

  messages(): WarningMessage[] { return [...this.map.values()].map(p => p.msg).sort((a, b) => b.firstMs - a.firstMs); }
  /** Restores messages kept from an earlier session (complete ones only; their segments are not needed again). */
  restore(list: WarningMessage[]): void { for (const m of list) if (m && m.key && !this.map.has(m.key)) this.map.set(m.key, { msg: { ...m, cells: [...m.cells] }, seg: new Map(m.segments.map(n => [n, { data: '', area: '', dcs: m.dcs }])) }); }
  clear(): void { this.map.clear(); }
}

/** One alert: the messages of one category sent together in several languages (same class, overlapping cells, within 10 minutes). */
export interface AlertGroup { key: string; cls: string; rank: number; kind: string; firstMs: number; lastMs: number; cells: string[]; messages: WarningMessage[] }
export function groupAlerts(msgs: WarningMessage[]): AlertGroup[] {
  const out: AlertGroup[] = [];
  for (const m of [...msgs].sort((a, b) => a.firstMs - b.firstMs)) {
    const b = baseId(m.id);
    const g = out.find(x => baseId(x.messages[0].id) === b && Math.abs(x.firstMs - m.firstMs) < 600_000 && x.cells.some(c => m.cells.includes(c)) && !x.messages.some(y => y.id === m.id));
    if (g) { g.messages.push(m); g.lastMs = Math.max(g.lastMs, m.lastMs); for (const c of m.cells) if (!g.cells.includes(c)) g.cells.push(c); }
    else out.push({ key: m.key, cls: m.cls, rank: m.rank, kind: m.kind, firstMs: m.firstMs, lastMs: m.lastMs, cells: [...m.cells], messages: [m] });
  }
  for (const g of out) g.messages.sort((a, b) => Number(a.additionalLanguage) - Number(b.additionalLanguage) || a.id - b.id);
  return out.sort((a, b) => b.firstMs - a.firstMs);
}
