/**
 * FIS-B (DO-267A / DO-358) from UAT ground uplinks (DO-282B): the products inside each 432-byte uplink message.
 *
 * Message: an 8-byte header (the ground station's position, flags, slot), then information frames: a 9-bit length,
 * 3 reserved bits and a 4-bit type; type 0 holds one FIS-B APDU. APDU header: A, G, P flags, an 11-bit product ID,
 * an S (segmented) flag, a 2-bit time option, the time, and (if S) segmentation fields; then the product's payload.
 *
 * Products read here:
 * - 63 / 64 NEXRAD radar (regional / CONUS): a 3-byte block reference (run-length or empty flag, north/south, a 2-bit
 *   scale, a 20-bit block number: 450 blocks a row, each 4 arc-minutes tall and 48 wide), then either run-length bytes
 *   (5-bit run + 1, 3-bit intensity 0-7) filling 128 bins (32 wide, 4 rows), or a bitmap of further empty blocks.
 * - Text (413 generic text: METAR, SPECI, TAF, PIREP, winds; 8 and 11-17 NOTAM, AIRMET, SIGMET, SUA): FIS-B's 6-bit
 *   text (1-26 = A-Z, 32-63 as ASCII, 28 tab, 29 new line, 30 record separator).
 */
export interface UatStation { lat: number; lon: number; slot: number; site: number; utc: boolean }

export interface RadarBlock {
  /** 63 regional, 64 CONUS. */
  product: number;
  block: number;
  scale: number;
  /** South-west corner and size, degrees. */
  lat: number; lon: number; dLat: number; dLon: number;
  /** 128 intensities, 32 a row, the northern row first; null for an empty (no echo) block. */
  bins: Uint8Array | null;
}

export interface FisbProduct {
  id: number;
  /** UTC hours and minutes the product is valid for (day and month when the product says). */
  hh: number; mm: number; month?: number; day?: number;
  payload: Uint8Array;
}

export function stationOf(b: Uint8Array): UatStation {
  let lat = ((b[0] << 15) | (b[1] << 7) | (b[2] >> 1)) * 360 / 2 ** 24; if (lat > 90) lat -= 180;
  let lon = (((b[2] & 1) << 23) | (b[3] << 15) | (b[4] << 7) | (b[5] >> 1)) * 360 / 2 ** 24; if (lon > 180) lon -= 360;
  return { lat, lon, utc: !!(b[6] & 0x80), slot: b[6] & 0x1f, site: b[7] >> 4 };
}

class BitReader {
  p = 0;
  constructor(private readonly d: Uint8Array) {}
  take(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.p++) v = (v << 1) | ((this.d[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    return v;
  }
}

/** Every FIS-B product in one uplink message. */
export function productsOf(msg: Uint8Array): FisbProduct[] {
  const out: FisbProduct[] = [];
  if (!(msg[6] & 0x20)) return out;                 // application data not valid
  let i = 8;
  while (i + 2 <= msg.length) {
    const len = (msg[i] << 1) | (msg[i + 1] >> 7);
    const type = msg[i + 1] & 0x0f;
    if (len === 0) break;
    const data = msg.subarray(i + 2, Math.min(msg.length, i + 2 + len));
    i += 2 + len;
    if (type !== 0 || data.length < 4) continue;
    const r = new BitReader(data);
    r.take(3);                                       // A, G, P flags
    const id = r.take(11);
    const seg = r.take(1);
    const tOpt = r.take(2);
    let month: number | undefined, day: number | undefined;
    if (tOpt >= 2) { month = r.take(4); day = r.take(5); }
    const hh = r.take(5), mm = r.take(6);
    if (tOpt === 1 || tOpt === 3) r.take(6);         // seconds
    if (seg) continue;                               // segmented products (large text) are not reassembled yet
    out.push({ id, hh, mm, month, day, payload: data.subarray((r.p + 7) >> 3) });
  }
  return out;
}

const SCALE = [1, 5, 9, 9];

/** Where a radar block sits: 450 blocks a row below 60 degrees (48 arc-min wide), 225 above (96 arc-min). */
function blockPlace(block: number, south: boolean, scale: number): { lat: number; lon: number; dLat: number; dLon: number } {
  const BELOW = 450 * 900;
  let row: number, col: number, wide: number;
  if (block < BELOW) { row = Math.floor(block / 450); col = block % 450; wide = 48 / 60; }
  else { const b = block - BELOW; row = 900 + Math.floor(b / 225); col = b % 225; wide = 96 / 60; }
  const k = SCALE[scale];
  let lat = row * 4 / 60, lon = col * wide;
  if (south) lat = -lat - 4 / 60 * k;
  if (lon > 180) lon -= 360;
  return { lat, lon, dLat: 4 / 60 * k, dLon: wide * k };
}

/** Radar blocks in one product 63/64 payload (a run-length block, or an empty block plus its bitmap of empties). */
export function radarBlocks(p: FisbProduct): RadarBlock[] {
  const d = p.payload;
  if (d.length < 3) return [];
  const rle = (d[0] >> 7) & 1, south = !!((d[0] >> 6) & 1), scale = (d[0] >> 4) & 3;
  const block = ((d[0] & 0x0f) << 16) | (d[1] << 8) | d[2];
  const place = blockPlace(block, south, scale);
  if (rle) {
    const bins = new Uint8Array(128);
    let n = 0;
    for (let i = 3; i < d.length && n < 128; i++) {
      const run = (d[i] >> 3) + 1, v = d[i] & 7;
      for (let k = 0; k < run && n < 128; k++) bins[n++] = v;
    }
    if (n !== 128) return [];                        // not a whole block: something is off, keep nothing
    return [{ product: p.id, block, scale, ...place, bins }];
  }
  // empty block, then a bitmap of the blocks after it that are empty too
  const out: RadarBlock[] = [{ product: p.id, block, scale, ...place, bins: null }];
  if (d.length > 3) {
    const nBytes = d[3] & 0x0f;
    const bits: number[] = [];
    for (let k = 4; k < 8; k++) bits.push((d[3] >> k) & 1);
    for (let j = 0; j < nBytes && 4 + j < d.length; j++) for (let k = 0; k < 8; k++) bits.push((d[4 + j] >> k) & 1);
    bits.forEach((on, idx) => { if (on) { const b = block + idx + 1; out.push({ product: p.id, block: b, scale, ...blockPlace(b, south, scale), bins: null }); } });
  }
  return out;
}

function char6(c: number): string {
  if (c >= 1 && c <= 26) return String.fromCharCode(64 + c);
  if (c >= 32 && c <= 63) return String.fromCharCode(c);
  if (c === 28) return '\t';
  if (c === 29 || c === 30) return '\n';
  if (c === 31) return '|';                         // field separator (special use airspace schedules)
  return '';
}

const KEYWORDS = ['METAR', 'SPECI', 'TAF', 'NOTAM', 'PIREP', 'WINDS', 'SIGMET', 'AIRMET', 'CWA', 'SUA'];

/** The readable 6-bit text in a payload; records that are not text (graphic overlays) come back empty. */
export function textOf(payload: Uint8Array): string {
  let best = '', bestScore = 0;
  for (let off = 0; off < 6; off++) {
    let s = '';
    const nbits = payload.length * 8;
    for (let p = off; p + 6 <= nbits; p += 6) {
      let v = 0;
      for (let k = 0; k < 6; k++) v = (v << 1) | ((payload[(p + k) >> 3] >> (7 - ((p + k) & 7))) & 1);
      s += char6(v);
    }
    const at = KEYWORDS.map(k => s.indexOf(k)).filter(i => i >= 0);
    const cand = at.length ? s.slice(Math.min(...at)) : s;
    let score = 0;
    for (const ch of cand) score += /[A-Z0-9 /.\-\n]/.test(ch) ? 1 : -3;
    if (score > bestScore) { best = cand; bestScore = score; }
  }
  best = best.trim();
  return KEYWORDS.some(k => best.startsWith(k)) ? best : '';
}

/** A METAR read into the parts a display needs. */
export interface Metar {
  station: string; raw: string; day?: number; hh?: number; mm?: number;
  windDir?: number; windKt?: number; gustKt?: number; visSm?: number;
  /** Lowest broken or overcast layer, ft (the ceiling), and the sky as reported. */
  ceilingFt?: number; sky: string[];
  tempC?: number; dewC?: number; altimInHg?: number; wx: string[];
  /** VFR, MVFR, IFR, LIFR from ceiling and visibility. */
  category?: 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
}

const tempOf = (s: string) => (s.startsWith('M') ? -Number(s.slice(1)) : Number(s));

export function parseMetar(text: string): Metar | null {
  const m = /^(METAR|SPECI)\s+([A-Z0-9]{4})\s+(.*)$/s.exec(text.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const raw = `${m[1]} ${m[2]} ${m[3]}`.replace(/=.*$/, '').trim();
  const out: Metar = { station: m[2], raw, sky: [], wx: [] };
  const body = m[3].split(' RMK')[0];
  for (const tok of body.split(' ')) {
    let x: RegExpExecArray | null;
    if ((x = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tok))) { out.day = +x[1]; out.hh = +x[2]; out.mm = +x[3]; }
    else if ((x = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(tok))) { out.windDir = x[1] === 'VRB' ? undefined : +x[1]; out.windKt = +x[2]; if (x[3]) out.gustKt = +x[3]; }
    else if ((x = /^(M)?(\d+)?(?:\s?(\d)\/(\d))?SM$/.exec(tok)) && (x[2] || x[3])) {
      out.visSm = (x[2] ? +x[2] : 0) + (x[3] ? +x[3] / +x[4] : 0);
    }
    else if ((x = /^(\d)\/(\d)SM$/.exec(tok))) out.visSm = +x[1] / +x[2];
    else if ((x = /^(FEW|SCT|BKN|OVC|VV)(\d{3})/.exec(tok))) {
      const ft = +x[2] * 100;
      out.sky.push(`${x[1]} ${ft.toLocaleString('en-US')}`);
      if ((x[1] === 'BKN' || x[1] === 'OVC' || x[1] === 'VV') && (out.ceilingFt === undefined || ft < out.ceilingFt)) out.ceilingFt = ft;
    }
    else if (/^(CLR|SKC|NSC)$/.test(tok)) out.sky.push('clear');
    else if ((x = /^(M?\d{2})\/(M?\d{2})?$/.exec(tok))) { out.tempC = tempOf(x[1]); if (x[2]) out.dewC = tempOf(x[2]); }
    else if ((x = /^A(\d{4})$/.exec(tok))) out.altimInHg = +x[1] / 100;
    else if (/^[-+]?(VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|SQ|FC|SS|DS)+$/.test(tok)) out.wx.push(tok);
  }
  const ceil = out.ceilingFt ?? Infinity, vis = out.visSm ?? Infinity;
  if (out.visSm !== undefined || out.sky.length) {
    out.category = ceil < 500 || vis < 1 ? 'LIFR' : ceil < 1000 || vis < 3 ? 'IFR' : ceil <= 3000 || vis <= 5 ? 'MVFR' : 'VFR';
  }
  return out;
}

/**
 * The gridded hazard products, worked out from our recordings: they share the radar's 3-byte block reference, but
 * the three bits after the run-length flag are the altitude level instead of north/south and scale.
 * - 70 / 71 icing (low: 8 levels from 2,000 ft, high: 4 from 18,000 ft, 2,000 ft apart): (run - 1, value) byte pairs;
 *   the value packs 2 bits of supercooled large drops, 3 of severity and 3 of probability; all ones is no data.
 * - 84 cloud tops, 90 / 91 turbulence (low / high, levels as icing), 103 lightning: a byte is (run - 1) << 4 | value,
 *   and 0xE<value> is followed by a byte holding a run of up to 256. 15 is no data.
 * Every block that does not fill its 128 bins exactly is dropped, so a misread never paints the map.
 */
export interface HazardBlock {
  product: number; block: number;
  /** 0-based altitude level (0 for one-level products). */
  level: number;
  lat: number; lon: number; dLat: number; dLon: number;
  /** 128 values, 32 a row, the northern row first; null for an empty block (nothing there). */
  bins: Uint8Array | null;
}

/** The altitude, ft, of a level of icing or turbulence (low products 70 / 90, high 71 / 91). */
export const hazardAltFt = (product: number, level: number) => (product === 71 || product === 91 ? 18000 : 2000) + level * 2000;

export function hazardBlocks(p: FisbProduct): HazardBlock[] {
  const d = p.payload;
  if (d.length < 3) return [];
  const rle = (d[0] >> 7) & 1, level = (d[0] >> 4) & 7;
  const block = ((d[0] & 0x0f) << 16) | (d[1] << 8) | d[2];
  const place = blockPlace(block, false, 0);
  if (rle) {
    const bins = new Uint8Array(128);
    let n = 0, i = 3;
    if (p.id === 70 || p.id === 71) {
      while (i + 1 < d.length && n < 128) { const run = d[i] + 1, v = d[i + 1]; i += 2; for (let k = 0; k < run && n < 128; k++) bins[n++] = v; }
    } else {
      while (i < d.length && n < 128) {
        const b = d[i++]; let run: number, v: number;
        if (b >> 4 === 0xe) { v = b & 15; if (i >= d.length) return []; run = d[i++] + 1; } else { run = (b >> 4) + 1; v = b & 15; }
        for (let k = 0; k < run && n < 128; k++) bins[n++] = v;
      }
    }
    if (n !== 128) return [];
    return [{ product: p.id, block, level, ...place, bins }];
  }
  const out: HazardBlock[] = [{ product: p.id, block, level, ...place, bins: null }];
  if (d.length > 3) {
    const nBytes = d[3] & 0x0f, bits: number[] = [];
    for (let k = 4; k < 8; k++) bits.push((d[3] >> k) & 1);
    for (let j = 0; j < nBytes && 4 + j < d.length; j++) for (let k = 0; k < 8; k++) bits.push((d[4 + j] >> k) & 1);
    bits.forEach((on, idx) => { if (on) { const b = block + idx + 1; out.push({ product: p.id, block: b, level, ...blockPlace(b, false, 0), bins: null }); } });
  }
  return out;
}

/** An icing value's parts: severity 0-7 (7 no data), probability 0-7, supercooled large drops 0-3. */
export const icingOf = (v: number) => ({ sld: v >> 6, severity: (v >> 3) & 7, prob: v & 7, none: v === 0xff });

/**
 * A graphic overlay record (format 8: G-AIRMET, TFR shapes, others): its kind, valid times and its shape. The layout
 * is found by where the vertex list fits: a geometry byte (low nibble), then 2 bits of operator and 6 of vertex count
 * minus one, then start and end times (month, day, hour, minute), then 6-byte vertices: 19-bit longitude, 19-bit
 * latitude (360 / 2^19 degrees) and a 10-bit altitude in hundreds of feet. Geometry 3 and 4 are areas (MSL / AGL),
 * 11 and 12 lines, 9 a point (a NOTAM's place). A record is kept only when its vertices end exactly at the end of the record.
 */
export interface Overlay {
  product: number;
  /** For G-AIRMETs, 1 turbulence, 3 surface wind, 4 icing, 5 freezing level, 6 IFR, 7 mountain obscuration. */
  element: number;
  /** Cause codes (IFR and mountain obscuration), as sent. */
  qualifiers: number;
  location: string;
  report: number;
  geometry: number;
  line: boolean;
  start?: { month: number; day: number; hh: number; mm: number };
  end?: { month: number; day: number; hh: number; mm: number };
  pts: [number, number][];
  /** Altitudes on the vertices, ft (bottom and top when they differ). */
  altsFt: number[];
}

function six4(d: Uint8Array, at: number): string {
  let s = '';
  const v = (d[at] << 16) | (d[at + 1] << 8) | d[at + 2];
  for (let k = 3; k >= 0; k--) { const c = (v >> (k * 6)) & 63; s += c >= 1 && c <= 26 ? String.fromCharCode(64 + c) : c >= 48 && c <= 57 ? String.fromCharCode(c) : ''; }
  return s;
}

export function overlayOf(p: FisbProduct): Overlay | null {
  const d = p.payload;
  if (d.length < 26 || d[0] >> 4 !== 8) return null;
  const okTime = (i: number) => d[i] >= 1 && d[i] <= 12 && d[i + 1] >= 1 && d[i + 1] <= 31 && d[i + 2] < 24 && d[i + 3] < 60;
  for (let g = 10; g + 10 <= d.length; g++) {
    const geometry = d[g] & 15, cnt = (d[g + 1] & 63) + 1;
    if (![3, 4, 7, 8, 9, 11, 12].includes(geometry)) continue;
    const v0 = g + 2 + 8;
    if (v0 + cnt * 6 !== d.length || !okTime(g + 2) || !okTime(g + 6)) continue;
    const pts: [number, number][] = [], alts = new Set<number>();
    let bad = false;
    for (let k = 0; k < cnt; k++) {
      const i = v0 + k * 6;
      const hi = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2], lo = (d[i + 3] << 16) | (d[i + 4] << 8) | d[i + 5];
      let lon = (hi >> 5) * 360 / 2 ** 19; if (lon > 180) lon -= 360;
      let lat = (((hi & 31) << 14) | (lo >> 10)) * 360 / 2 ** 19; if (lat > 180) lat -= 360;
      if (Math.abs(lat) > 90) { bad = true; break; }
      pts.push([lat, lon]); alts.add((lo & 0x3ff) * 100);
    }
    if (bad) continue;
    const t = d[13];
    const q = (t >> 6) & 1;
    return {
      product: p.id, element: p.id === 14 ? t & 7 : 0, qualifiers: q && g >= 18 ? (d[g - 3] << 16) | (d[g - 2] << 8) | d[g - 1] : 0,
      location: six4(d, 2), report: ((d[6] & 0x3f) << 8) | d[7], geometry, line: geometry === 11 || geometry === 12,
      start: { month: d[g + 2], day: d[g + 3], hh: d[g + 4], mm: d[g + 5] }, end: { month: d[g + 6], day: d[g + 7], hh: d[g + 8], mm: d[g + 9] },
      pts, altsFt: [...alts].sort((a, b) => a - b),
    };
  }
  return null;
}

/** A special use airspace schedule line ("SUA ...|name|...|start|end|bottom|top|...") read into its parts. */
export interface Sua { name: string; from?: string; to?: string; bottomFt?: number; topFt?: number; fields: string[] }
export function suaOf(text: string): Sua | null {
  if (!text.startsWith('SUA')) return null;
  const f = text.split('|').map(x => x.trim());
  const name = f.find(x => /^[A-Z]{1,2}\d{2,5}[A-Z]?$/.test(x) && !/^\d+$/.test(x)) ?? '';
  const when = f.filter(x => /^\d{10}$/.test(x));
  const alts = f.filter(x => /^\d{3}$/.test(x)).map(x => +x * 100);
  const t = (s?: string) => (s ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)} ${s.slice(6, 8)}:${s.slice(8, 10)}Z` : undefined);
  return { name, from: t(when[0]), to: t(when[1]), bottomFt: alts[0], topFt: alts[1], fields: f };
}
