/**
 * Large objects (files) carried on AAS ports, and the service directory port. Neither framing is in the NRSC-5-E
 * documents we work from; both were worked out from our own recordings and are marked as derived.
 *
 * Object packets: [0] the header length (where the file data starts in this packet), [1] a repeat count, [2..3]
 * object id, [4..7] fragment index (little endian), then the file data in 256-byte fragments. Fragment 0's header goes
 * on with 16 bytes of metadata ([8..11] always 01 00 00 00, [16..19] the file size, little endian) and the file name
 * in ASCII; fragment 0 is the one with index 0 and that word.
 *
 * Service directory (a TLV list, each length counting its own length byte): 0x40 an audio service and 0x41 a data
 * service (each followed by three header bytes), 0x69 a name (an encoding byte, then text), 0x66 audio service info
 * ([1] the program, [2] its type), 0x67 a component ([1..2] its AAS port, little endian, then four bytes ending in the
 * component's MIME hash), 0x60 a component detail.
 */

import { mimeName } from './sis.js';

export interface LotObject {
  port: number; id: number; name: string; size: number; bytes: Uint8Array; mime: string; ms: number;
  /** From fragment 0's header: the format version, the MIME hash (little endian, as sent) and the expiry (UTC). */
  version: number; mimeHash: number; expires: string;
}

const FRAG = 256;
interface Partial { name: string; size: number; frags: Map<number, Uint8Array>; have: number; need: number; first: number; version: number; mimeHash: number; expires: string }

/** Reassembles every object on every port; each finished object is reported once (repeats are dropped). */
export class LotAssembler {
  onObject: (o: LotObject) => void = () => {};
  private readonly parts = new Map<string, Partial>();
  private readonly done = new Map<string, number>();
  private readonly doneNames = new Set<string>();
  objects = 0; fragments = 0;

  add(port: number, p: Uint8Array): void {
    if (p.length < 8) return;
    const id = p[2] | (p[3] << 8), idx = (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0;
    const key = `${port}/${id}`;
    this.fragments++;
    let o = this.parts.get(key);
    const hl = p[0];
    if (hl < 8 || hl > p.length) return;
    if (idx === 0) {
      // fragment 0 carries the metadata word 01 00 00 00 at bytes 8..11
      if (hl < 24 || p[8] !== 1 || p[9] !== 0 || p[10] !== 0 || p[11] !== 0) return;
      const size = (p[16] | (p[17] << 8) | (p[18] << 16) | (p[19] << 24)) >>> 0;
      if (size === 0 || size > 4_000_000) return;
      let name = ''; for (const c of p.subarray(24, hl)) name += String.fromCharCode(c);
      name = name.replace(/\0+$/, '');
      const version = (p[8] | (p[9] << 8) | (p[10] << 16) | (p[11] << 24)) >>> 0, mimeHash = (p[20] | (p[21] << 8) | (p[22] << 16) | (p[23] << 24)) >>> 0, expires = lotExpiry(p.subarray(12, 16));
      const sig = `${name}/${size}`;
      if (this.done.get(key) === hashSig(sig)) return;
      if (!o || (o.size > 0 && (o.name !== name || o.size !== size))) { o = { name, size, frags: new Map(), have: 0, need: Math.ceil(size / FRAG), first: Date.now(), version, mimeHash, expires }; this.parts.set(key, o); }
      else if (o.size < 0) { o.name = name; o.size = size; o.need = Math.ceil(size / FRAG); }
      o.version = version; o.mimeHash = mimeHash; o.expires = expires;
      if (!o.frags.has(0)) { o.frags.set(0, p.slice(hl)); o.have++; }
    } else {
      if (!o) { o = { name: '', size: -1, frags: new Map(), have: 0, need: Infinity, first: Date.now(), version: 0, mimeHash: 0, expires: '' }; this.parts.set(key, o); }
      if (!o.frags.has(idx)) { o.frags.set(idx, p.slice(hl)); o.have++; }
    }
    if (o.size > 0 && o.have >= o.need) this.finish(port, id, key, o);
    if (this.parts.size > 400) { const oldest = [...this.parts.entries()].sort((a, b) => a[1].first - b[1].first)[0]; this.parts.delete(oldest[0]); }
  }

  private finish(port: number, id: number, key: string, o: Partial): void {
    for (let i = 0; i < o.need; i++) if (!o.frags.has(i)) return;
    const bytes = new Uint8Array(o.size);
    let at = 0;
    for (let i = 0; i < o.need && at < o.size; i++) { const f = o.frags.get(i)!; bytes.set(f.subarray(0, Math.min(f.length, o.size - at)), at); at += f.length; }
    this.parts.delete(key);
    this.done.set(key, hashSig(`${o.name}/${o.size}`));
    // the same file sent again under a new id
    const same = `${port}/${o.name}/${o.size}`;
    if (o.name && this.doneNames.has(same)) return;
    this.doneNames.add(same); if (this.doneNames.size > 500) this.doneNames.delete(this.doneNames.values().next().value!);
    this.objects++;
    this.onObject({ port, id, name: o.name, size: o.size, bytes, mime: sniffMime(bytes, o.name, o.mimeHash), ms: Date.now(), version: o.version, mimeHash: o.mimeHash, expires: o.expires });
  }

  /** Objects still being collected: port, id, name, fragments in hand and needed. */
  pending(): { port: number; id: number; name: string; have: number; need: number }[] {
    return [...this.parts.entries()].filter(([, o]) => o.size > 0).map(([k, o]) => { const [port, id] = k.split('/').map(Number); return { port, id, name: o.name, have: o.have, need: o.need }; });
  }
  clear(): void { this.parts.clear(); this.done.clear(); this.doneNames.clear(); this.objects = 0; this.fragments = 0; }
}
function hashSig(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** The LOT expiry word (bytes 12..15, little endian): minute, hour, day, month and year packed low bits first. */
export function lotExpiry(b: Uint8Array): string {
  const v = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  const min = v & 63, hour = (v >>> 6) & 31, day = (v >>> 11) & 31, mon = (v >>> 16) & 15, year = v >>> 20;
  if (!v || !mon || mon > 12 || !day || hour > 23 || min > 59 || year < 1990 || year > 2200) return '';
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const at = (b: Uint8Array, o: number, sig: number[]) => sig.every((x, i) => b[o + i] === x);
/** The file type from its first bytes, then its name, then the LOT MIME hash. */
export function sniffMime(b: Uint8Array, name: string, hash = 0): string {
  if (at(b, 0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (at(b, 0, [0x89, 0x50, 0x4E, 0x47])) return 'image/png';
  if (at(b, 0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(b, 0, [0x52, 0x49, 0x46, 0x46]) && at(b, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (at(b, 0, [0x42, 0x4D]) && b.length > 26 && le32(b, 2) === b.length) return 'image/bmp';
  if (at(b, 0, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (at(b, 0, [0x50, 0x4B, 0x03, 0x04])) return 'application/zip';
  if (at(b, 0, [0x1F, 0x8B])) return 'application/gzip';
  if (at(b, 0, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  let head = ''; for (const c of b.subarray(0, 512)) head += String.fromCharCode(c);
  head = head.trimStart();
  if (/^<svg|^<\?xml[^>]*>\s*<svg/i.test(head)) return 'image/svg+xml';
  if (/^<\?xml/i.test(head)) return 'application/xml';
  if (/^<!doctype html|^<html/i.test(head)) return 'text/html';
  if (/\.txt$/i.test(name) || hash === 0xBB492AAC) return 'text/plain';
  if (/\.jpe?g$/i.test(name) || hash === 0x1E653E9C) return 'image/jpeg';
  if (/\.png$/i.test(name) || hash === 0x4F328CA0) return 'image/png';
  if (b.length && printable(b) > 0.97) return /^[[{]/.test(head) ? 'application/json' : 'text/plain';
  return 'application/octet-stream';
}
/** The share of bytes that are text: tab, line ends, 0x20..0x7E and Latin-1 letters. */
export function printable(b: Uint8Array): number {
  let n = 0; const m = Math.min(b.length, 4096);
  for (let i = 0; i < m; i++) { const c = b[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xA0) n++; }
  return m ? n / m : 0;
}
/** Shannon entropy of a sample in bits per byte (near 8: compressed or encrypted). */
export function entropy(b: ArrayLike<number>): number {
  const c = new Array<number>(256).fill(0); let n = 0;
  for (let i = 0; i < b.length; i++) { c[b[i]]++; n++; }
  let h = 0; for (const x of c) if (x) { const p = x / n; h -= p * Math.log2(p); }
  return h;
}

/** An image or file start found inside a byte run: where, how long (to its end marker when it has one) and its size. */
export interface Embedded { type: string; offset: number; length: number; width?: number; height?: number; complete: boolean }
/** Every image signature in `b` from `from`, each checked past its magic so random bytes rarely pass. */
export function scanEmbedded(b: Uint8Array, from = 0, limit = 32): Embedded[] {
  const out: Embedded[] = [];
  for (let i = from; i + 30 < b.length && out.length < limit; i++) {
    const x = b[i];
    if (x === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF && b[i + 3] >= 0xC0 && b[i + 3] !== 0xFF) {
      const m = b[i + 3], seg = (b[i + 4] << 8) | b[i + 5];
      if (seg < 2 || (m === 0xE0 && !at(b, i + 6, [0x4A, 0x46, 0x49, 0x46])) || (m === 0xE1 && !at(b, i + 6, [0x45, 0x78, 0x69, 0x66]) && !at(b, i + 6, [0x68, 0x74, 0x74, 0x70]))) continue;
      if (m !== 0xE0 && m !== 0xE1 && m !== 0xDB && m !== 0xEE && m !== 0xED && m !== 0xE2 && m !== 0xC0 && m !== 0xC4) continue;
      const end = jpegEnd(b, i);
      out.push({ type: 'image/jpeg', offset: i, length: end > 0 ? end - i : b.length - i, complete: end > 0, ...jpegSize(b, i, end > 0 ? end : b.length) });
      if (end > 0) i = end - 1;
    } else if (x === 0x89 && at(b, i, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) && at(b, i + 12, [0x49, 0x48, 0x44, 0x52])) {
      const end = pngEnd(b, i);
      out.push({ type: 'image/png', offset: i, length: end > 0 ? end - i : b.length - i, complete: end > 0, width: be32(b, i + 16), height: be32(b, i + 20) });
      if (end > 0) i = end - 1;
    } else if (x === 0x47 && (at(b, i, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) || at(b, i, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))) {
      const w = b[i + 6] | (b[i + 7] << 8), h = b[i + 8] | (b[i + 9] << 8);
      if (w && h && w < 8192 && h < 8192) out.push({ type: 'image/gif', offset: i, length: b.length - i, complete: false, width: w, height: h });
    } else if (x === 0x42 && b[i + 1] === 0x4D) {
      const size = le32(b, i + 2), off = le32(b, i + 10), hdr = le32(b, i + 14);
      if (!b[i + 6] && !b[i + 7] && !b[i + 8] && !b[i + 9] && (hdr === 40 || hdr === 12 || hdr === 108 || hdr === 124) && off >= 14 + hdr && off < 2000 && size > off && size < 20_000_000)
        out.push({ type: 'image/bmp', offset: i, length: Math.min(size, b.length - i), complete: i + size <= b.length, width: le32(b, i + 18), height: Math.abs(le32(b, i + 22) | 0) });
    } else if (x === 0x52 && at(b, i, [0x52, 0x49, 0x46, 0x46]) && at(b, i + 8, [0x57, 0x45, 0x42, 0x50])) {
      const size = le32(b, i + 4) + 8;
      out.push({ type: 'image/webp', offset: i, length: Math.min(size, b.length - i), complete: i + size <= b.length });
    }
  }
  return out;
}
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** Where a JPEG starting at `s` ends (just past its EOI), walking its marker segments and entropy-coded data, or -1. */
function jpegEnd(b: Uint8Array, s: number): number {
  let i = s + 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xFF) return -1;
    const m = b[i + 1];
    if (m === 0xD9) return i + 2;
    if (m === 0xFF) { i++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3]; if (len < 2) return -1;
    i += 2 + len;
    if (m === 0xDA) while (i + 1 < b.length && !(b[i] === 0xFF && b[i + 1] !== 0 && !(b[i + 1] >= 0xD0 && b[i + 1] <= 0xD7))) i++;
  }
  return -1;
}
function jpegSize(b: Uint8Array, s: number, e: number): { width?: number; height?: number } {
  let i = s + 2;
  while (i + 9 < e && b[i] === 0xFF) {
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    if (m === 0xDA || len < 2) break;
    i += 2 + len;
  }
  return {};
}
/** Where a PNG starting at `s` ends (just past IEND), walking its chunks, or -1. */
function pngEnd(b: Uint8Array, s: number): number {
  let i = s + 8;
  while (i + 12 <= b.length) { const n = be32(b, i); if (n > 0x7FFFFFFF) return -1; const t = be32(b, i + 4); i += 12 + n; if (t === 0x49454E44) return i <= b.length ? i : -1; }
  return -1;
}

/** What a file holds beyond its picture: text chunks, its segment list, images inside it and bytes past its end. */
export interface Inspect { width?: number; height?: number; text: { key: string; value: string }[]; embedded: Embedded[]; trailing: number; chunks: string[] }
export function inspectFile(b: Uint8Array, mime: string): Inspect {
  const out: Inspect = { text: [], embedded: [], trailing: 0, chunks: [] };
  const latin = (x: Uint8Array) => { let s = ''; for (const c of x) s += String.fromCharCode(c); return s; };
  if (mime === 'image/png' && at(b, 0, [0x89, 0x50, 0x4E, 0x47])) {
    out.width = be32(b, 16); out.height = be32(b, 20);
    let i = 8;
    while (i + 12 <= b.length) {
      const n = be32(b, i), t = latin(b.subarray(i + 4, i + 8)), d = b.subarray(i + 8, Math.min(b.length, i + 8 + n));
      if (!out.chunks.includes(t)) out.chunks.push(t);
      if (t === 'tEXt' || t === 'iTXt' || t === 'zTXt') { const z = d.indexOf(0); out.text.push({ key: `${t} ${latin(d.subarray(0, Math.max(0, z)))}`, value: t === 'zTXt' ? `(compressed, ${d.length} bytes)` : latin(d.subarray(z + 1)).replace(/^[\x00-\x02]+/, '').slice(0, 2000) }); }
      else if (t === 'eXIf') out.text.push({ key: 'eXIf', value: `${d.length} bytes` });
      i += 12 + n;
      if (t === 'IEND') break;
    }
    out.trailing = Math.max(0, b.length - i);
  } else if (mime === 'image/jpeg') {
    const end = jpegEnd(b, 0); Object.assign(out, jpegSize(b, 0, end > 0 ? end : b.length));
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xFF) {
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xDA || m === 0xD9 || len < 2) break;
      const d = b.subarray(i + 4, Math.min(b.length, i + 2 + len));
      if (m >= 0xE0 && m <= 0xEF) {
        const id = latin(d.subarray(0, Math.max(0, d.indexOf(0)))).slice(0, 40), name = `APP${m - 0xE0} ${id}`.trim();
        if (!out.chunks.includes(name)) out.chunks.push(name);
        if (/^http:\/\/ns\.adobe\.com\/xap/.test(id)) out.text.push({ key: 'XMP', value: latin(d.subarray(id.length + 1)).slice(0, 4000) });
      }
      if (m === 0xFE) out.text.push({ key: 'COM', value: latin(d).slice(0, 2000) });
      i += 2 + len;
    }
    out.trailing = end > 0 ? b.length - end : 0;
  } else if (mime === 'image/gif') {
    out.width = b[6] | (b[7] << 8); out.height = b[8] | (b[9] << 8);
    for (let i = 13; i + 3 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xFE) { let s = '', k = i + 2; while (k < b.length && b[k]) { s += latin(b.subarray(k + 1, k + 1 + b[k])); k += 1 + b[k]; } out.text.push({ key: 'GIF comment', value: s.slice(0, 2000) }); break; }
  }
  out.embedded = scanEmbedded(b, 1, 16);
  return out;
}

/** What an object is, from its name and content. */
export type LotKind = 'art' | 'logo' | 'traffic' | 'traffic-info' | 'radar' | 'radar-info' | 'image' | 'text' | 'file' | 'carved';
export function lotKind(o: { name: string; mime: string; port: number }, artPorts: Set<number>, logoPorts: Set<number>): LotKind {
  const n = o.name;
  if (/^TMT_/i.test(n)) return 'traffic';
  if (/^TMI_/i.test(n)) return 'traffic-info';
  if (/^DWRO_/i.test(n)) return 'radar';
  if (/^DWRI_/i.test(n)) return 'radar-info';
  const img = o.mime.startsWith('image/');
  if (img && artPorts.has(o.port)) return 'art';
  if (img && logoPorts.has(o.port)) return 'logo';
  if (img && /^SL/i.test(n)) return 'logo';
  if (img) return 'image';
  if (o.mime.startsWith('text/') || o.mime === 'application/json' || o.mime === 'application/xml') return 'text';
  return 'file';
}

/** A traffic tile name: TMT_<map>_<row>_<column>_<yyyymmdd>_<hhmm>_<id>. */
export function trafficTile(name: string): { map: string; row: number; col: number; stamp: string } | null {
  const m = /^TMT_([^_]+)_(\d+)_(\d+)_(\d{8})_(\d{4})/i.exec(name);
  return m ? { map: m[1], row: +m[2], col: +m[3], stamp: `${m[4]}_${m[5]}` } : null;
}
/** A radar image name: DWRO_<area>_..._<yyyymmdd>_<hhmm>_<id>. */
export function radarImage(name: string): { area: string; stamp: string } | null {
  const m = /^DWRO_([^_]+)_.*?(\d{8})_(\d{4})/i.exec(name);
  return m ? { area: m[1], stamp: `${m[2]}_${m[3]}` } : null;
}

/** key="value" pairs of the map description files; values keep their inner quoting. */
function kv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, '')); }
  return m;
}
const coords = (s: string) => [...s.matchAll(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)].map(x => [+x[1], +x[2]] as [number, number]);
const rgb = (s: string | undefined) => { const m = s ? /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s) : null; return m ? [+m[1], +m[2], +m[3]] as [number, number, number] : null; };

export interface TrafficInfo { map: string; rows: number; cols: number; north: number; south: number; west: number; east: number; background: [number, number, number] | null; stations: string[]; copyright: string }
/** The traffic map description (TMI): the tile grid and the corners of the whole map. */
export function parseTrafficInfo(text: string): TrafficInfo | null {
  const m = kv(text), rows = +(m.get('NumRows') ?? 0), cols = +(m.get('NumColumns') ?? 0);
  const pts = [...m.entries()].filter(([k]) => /^CoordinatesRow/i.test(k)).flatMap(([, v]) => coords(v));
  if (!rows || !cols || !pts.length) return null;
  return {
    map: m.get('TrafficMapID') ?? '', rows, cols,
    north: Math.max(...pts.map(p => p[0])), south: Math.min(...pts.map(p => p[0])), west: Math.min(...pts.map(p => p[1])), east: Math.max(...pts.map(p => p[1])),
    background: rgb(m.get('BackgroundRGBColor')), stations: coords2(m.get('StationList') ?? ''), copyright: m.get('CopyrightNotice') ?? '',
  };
}
const coords2 = (s: string) => [...s.matchAll(/\(\s*[^,()]*,\s*([^()]*?)\s*\)/g)].map(x => x[1]);
/** A tile's corners in a traffic map. */
export function tileBounds(t: TrafficInfo, row: number, col: number): { north: number; south: number; west: number; east: number } {
  const dLat = (t.north - t.south) / t.rows, dLon = (t.east - t.west) / t.cols;
  return { north: t.north - (row - 1) * dLat, south: t.north - row * dLat, west: t.west + (col - 1) * dLon, east: t.west + col * dLon };
}

export interface RadarInfo { area: string; north: number; south: number; west: number; east: number; legends: { name: string; colors: [number, [number, number, number]][] }[]; stations: string[]; copyright: string }
/** The weather radar description (DWRI): the image's corners and its color legends. */
export function parseRadarInfo(text: string): RadarInfo | null {
  const m = kv(text), pts = coords(m.get('Coordinates') ?? '');
  if (pts.length < 2) return null;
  const legends = [...m.entries()].filter(([k]) => /^Legend_/i.test(k)).map(([k, v]) => ({
    name: k.replace(/^Legend_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
    colors: [...v.matchAll(/\(\s*(\d+)\s*,\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*\)/g)].map(x => [+x[1], [+x[2], +x[3], +x[4]]] as [number, [number, number, number]]),
  }));
  return {
    area: m.get('DWR_Area_ID') ?? '', north: Math.max(pts[0][0], pts[1][0]), south: Math.min(pts[0][0], pts[1][0]), west: Math.min(pts[0][1], pts[1][1]), east: Math.max(pts[0][1], pts[1][1]),
    legends, stations: coords2(m.get('StationList') ?? ''), copyright: m.get('CopyrightNotice') ?? '',
  };
}

/** A data component (tag 0x67); `mime` is high byte first, the standard hash that word byte-reversed (`mimeName`). */
export interface SigComponent { index: number; port: number; mime: number; mimeHex: string; mimeName: string; dataType: number; aasType: number; aasTypeName: string }
/** A service; `extra` keeps every other tag (the audio component 0x66 and any not decoded) as hex. */
export interface SigService { kind: 'audio' | 'data'; id: number; name: string; program: number; progType: number; components: SigComponent[]; extra: { tag: number; hex: string; text: string }[] }
export const AAS_TYPES: Record<number, string> = { 0: 'stream', 1: 'packet', 3: 'LOT' };
const swap32 = (v: number) => (((v & 255) << 24) | (((v >> 8) & 255) << 16) | (((v >> 16) & 255) << 8) | ((v >>> 24) & 255)) >>> 0;
/** The service directory (derived): audio and data services, their names and their component ports. */
export function parseSig(p: Uint8Array): SigService[] {
  const out: SigService[] = [];
  let cur: SigService | null = null, i = 0;
  while (i < p.length) {
    const tag = p[i];
    if (tag === 0x40 || tag === 0x41) {
      if (i + 4 > p.length) break;
      cur = { kind: tag === 0x40 ? 'audio' : 'data', id: p[i + 1] | (p[i + 2] << 8), name: '', program: -1, progType: -1, components: [], extra: [] };
      out.push(cur); i += 4; continue;
    }
    const len = p[i + 1];
    if (len === undefined || len < 1 || i + 1 + len > p.length) break;
    const v = p.subarray(i + 2, i + 1 + len);
    if (cur) {
      if (tag === 0x69 && v.length >= 1) { let s = ''; for (const c of v.subarray(1)) s += String.fromCharCode(c); cur.name = s.replace(/\0+$/, '').trim(); }
      else if (tag === 0x66 && v.length >= 3) {
        cur.program = v[1]; cur.progType = v[2];
        const mime = v.length >= 11 ? ((v[7] << 24) | (v[8] << 16) | (v[9] << 8) | v[10]) >>> 0 : 0;
        cur.extra.push({ tag, hex: hexOf(v), text: mime ? `audio component, program ${v[1]}, MIME ${mimeName(swap32(mime)) || mime.toString(16).padStart(8, '0')}` : '' });
      }
      else if (tag === 0x67 && v.length >= 7) {
        const mime = ((v[v.length - 4] << 24) | (v[v.length - 3] << 16) | (v[v.length - 2] << 8) | v[v.length - 1]) >>> 0;
        const aasType = v.length >= 6 ? v[5] : -1;
        cur.components.push({ index: v[0], port: v[1] | (v[2] << 8), mime, mimeHex: mime.toString(16).padStart(8, '0'), mimeName: mimeName(swap32(mime)), dataType: v.length >= 5 ? v[3] | (v[4] << 8) : -1, aasType, aasTypeName: AAS_TYPES[aasType] ?? `type ${aasType}` });
      }
      else cur.extra.push({ tag, hex: hexOf(v), text: asciiHead(v) });
    }
    i += 1 + len;
  }
  return out.filter(s => s.name || s.components.length);
}

/** The PSD XHDR frame (derived): a MIME hash, then parameter / length / value triples; parameter 0 names the object
 *  id of the image for this song, parameter 1 (no value) says there is none. */
const hexOf = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
/** A tag value that starts with a four-character code: the code, then the rest as a little-endian number ('CCU1 40'). */
function asciiHead(v: Uint8Array): string {
  if (v.length < 4 || ![...v.subarray(0, 4)].every(c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A))) return '';
  let n = 0; for (let i = v.length - 1; i >= 4; i--) n = n * 256 + v[i];
  return `${String.fromCharCode(...v.subarray(0, 4))} ${n}`;
}
/** The standard name of a high-byte-first MIME word (as `mimeHex`, XHDR `mime`). */
export const mimeNameBe = (be: number) => mimeName(swap32(be));
export function parseXhdr(b: Uint8Array): { mime: number; objectId: number | null; flush: boolean } | null {
  if (b.length < 5) return null;
  const mime = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  let objectId: number | null = null, flush = false, i = 4;
  while (i + 1 < b.length) {
    const param = b[i], len = b[i + 1], v = b.subarray(i + 2, i + 2 + len);
    if (param === 0 && v.length >= 2) objectId = v[0] | (v[1] << 8);
    if (param === 1) flush = true;
    i += 2 + len;
  }
  return { mime, objectId, flush };
}
