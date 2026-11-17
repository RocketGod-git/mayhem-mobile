/**
 * Large objects (files) carried on AAS ports, and the service directory port. Neither framing is in the NRSC-5-E
 * documents we work from; both were worked out from our own recordings and are marked as derived.
 *
 * Object packets: [0] the header length (where the file data starts in this packet), [1] a repeat count, [2..3]
 * object id, [4..7] fragment index (little endian), then the file data in 256-byte fragments. Fragment 0's header goes
 * on with 16 bytes of metadata ([16..19] the file size, little endian) and the file name in ASCII.
 *
 * Service directory (a TLV list, each length counting its own length byte): 0x40 an audio service and 0x41 a data
 * service (each followed by three header bytes), 0x69 a name (an encoding byte, then text), 0x66 audio service info
 * ([1] the program, [2] its type), 0x67 a component ([1..2] its AAS port, little endian, then four bytes ending in the
 * component's MIME hash), 0x60 a component detail.
 */

export interface LotObject { port: number; id: number; name: string; size: number; bytes: Uint8Array; mime: string; ms: number }

const FRAG = 256;
interface Partial { name: string; size: number; frags: Map<number, Uint8Array>; have: number; need: number; first: number }

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
      if (hl < 24) return;
      const size = (p[16] | (p[17] << 8) | (p[18] << 16) | (p[19] << 24)) >>> 0;
      if (size === 0 || size > 4_000_000) return;
      let name = ''; for (const c of p.subarray(24, hl)) name += String.fromCharCode(c);
      name = name.replace(/\0+$/, '');
      const sig = `${name}/${size}`;
      if (this.done.get(key) === hashSig(sig)) return;
      if (!o || (o.size > 0 && (o.name !== name || o.size !== size))) { o = { name, size, frags: new Map(), have: 0, need: Math.ceil(size / FRAG), first: Date.now() }; this.parts.set(key, o); }
      else if (o.size < 0) { o.name = name; o.size = size; o.need = Math.ceil(size / FRAG); }
      if (!o.frags.has(0)) { o.frags.set(0, p.slice(hl)); o.have++; }
    } else {
      if (!o) { o = { name: '', size: -1, frags: new Map(), have: 0, need: Infinity, first: Date.now() }; this.parts.set(key, o); }
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
    this.onObject({ port, id, name: o.name, size: o.size, bytes, mime: sniffMime(bytes, o.name), ms: Date.now() });
  }

  /** Objects still being collected: port, id, name, fragments in hand and needed. */
  pending(): { port: number; id: number; name: string; have: number; need: number }[] {
    return [...this.parts.entries()].filter(([, o]) => o.size > 0).map(([k, o]) => { const [port, id] = k.split('/').map(Number); return { port, id, name: o.name, have: o.have, need: o.need }; });
  }
  clear(): void { this.parts.clear(); this.done.clear(); this.doneNames.clear(); this.objects = 0; this.fragments = 0; }
}
function hashSig(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function sniffMime(b: Uint8Array, name: string): string {
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (/\.txt$/i.test(name)) return 'text/plain';
  return 'application/octet-stream';
}

/** What an object is, from its name and content. */
export type LotKind = 'art' | 'logo' | 'traffic' | 'traffic-info' | 'radar' | 'radar-info' | 'image' | 'text' | 'file';
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
  if (o.mime === 'text/plain') return 'text';
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

export interface SigComponent { index: number; port: number; mime: number; mimeHex: string }
export interface SigService { kind: 'audio' | 'data'; id: number; name: string; program: number; progType: number; components: SigComponent[] }
/** The service directory (derived): audio and data services, their names and their component ports. */
export function parseSig(p: Uint8Array): SigService[] {
  const out: SigService[] = [];
  let cur: SigService | null = null, i = 0;
  while (i < p.length) {
    const tag = p[i];
    if (tag === 0x40 || tag === 0x41) {
      if (i + 4 > p.length) break;
      cur = { kind: tag === 0x40 ? 'audio' : 'data', id: p[i + 1] | (p[i + 2] << 8), name: '', program: -1, progType: -1, components: [] };
      out.push(cur); i += 4; continue;
    }
    const len = p[i + 1];
    if (len === undefined || len < 1 || i + 1 + len > p.length) break;
    const v = p.subarray(i + 2, i + 1 + len);
    if (cur) {
      if (tag === 0x69 && v.length >= 1) { let s = ''; for (const c of v.subarray(1)) s += String.fromCharCode(c); cur.name = s.replace(/\0+$/, '').trim(); }
      else if (tag === 0x66 && v.length >= 3) { cur.program = v[1]; cur.progType = v[2]; }
      else if (tag === 0x67 && v.length >= 7) {
        const mime = ((v[v.length - 4] << 24) | (v[v.length - 3] << 16) | (v[v.length - 2] << 8) | v[v.length - 1]) >>> 0;
        cur.components.push({ index: v[0], port: v[1] | (v[2] << 8), mime, mimeHex: mime.toString(16).padStart(8, '0') });
      }
    }
    i += 1 + len;
  }
  return out.filter(s => s.name || s.components.length);
}

/** The PSD XHDR frame (derived): a MIME hash, then parameter / length / value triples; parameter 0 names the object
 *  id of the image for this song, parameter 1 (no value) says there is none. */
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
