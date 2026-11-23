/**
 * Who and what an identity names, offline first: DMR radio IDs (radioid.net's user list), talkgroup names
 * (Brandmeister's list and the PAPA system's own), and repeaters (PAPA's published lists, HearHam's directory,
 * Brandmeister's devices) matched by frequency with the tone or color code heard. Parsers and lookups only: the
 * downloads and their caches belong to each platform. Only what was heard on the air is looked up. No DOM.
 */

// ------------------------------------------------------------------------------------------------ CSV
/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
/** Runs of ASCII white space as one space, none at either end (the same rule on every platform). */
const clean = (s: string | undefined) => (s ?? '').replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ | $/g, '');

// ------------------------------------------------------------------------------------------------ DMR radio IDs
export interface RadioIdUser { id: number; callsign: string; name: string; city: string; state: string; country: string }

/**
 * radioid.net's user list (RADIO_ID, CALLSIGN, FIRST_NAME, LAST_NAME, CITY, STATE, COUNTRY), held compact: the IDs
 * sorted in one array and each row's text in one pooled string.
 */
export class RadioIdTable {
  private ids: Int32Array; private offs: Int32Array; private pool: string;
  private byCall: Map<string, number> | null = null;
  private constructor(ids: Int32Array, offs: Int32Array, pool: string) { this.ids = ids; this.offs = offs; this.pool = pool; }
  get size(): number { return this.ids.length; }

  static fromCsv(text: string): RadioIdTable {
    const rows = parseCsv(text);
    let start = 0;
    if (rows.length && !/^\d+$/.test(clean(rows[0][0]))) {
      start = 1;
    }
    const recs: { id: number; t: string }[] = [];
    for (let r = start; r < rows.length; r++) {
      const c = rows[r]; const id = parseInt(clean(c[0]), 10);
      if (!(id > 0) || !clean(c[1])) continue;
      const name = [clean(c[2]), clean(c[3])].filter(Boolean).join(' ');
      recs.push({ id, t: [clean(c[1]).toUpperCase(), name, clean(c[4]), clean(c[5]), clean(c[6])].map(s => s.replace(/\|/g, '/')).join('|') });
    }
    recs.sort((a, b) => a.id - b.id);
    const ids = new Int32Array(recs.length), offs = new Int32Array(recs.length + 1);
    const parts: string[] = []; let o = 0;
    recs.forEach((r, i) => { ids[i] = r.id; offs[i] = o; parts.push(r.t); o += r.t.length; });
    offs[recs.length] = o;
    return new RadioIdTable(ids, offs, parts.join(''));
  }

  private row(i: number): RadioIdUser {
    const f = this.pool.slice(this.offs[i], this.offs[i + 1]).split('|');
    return { id: this.ids[i], callsign: f[0], name: f[1], city: f[2], state: f[3], country: f[4] };
  }
  byId(id: number): RadioIdUser | null {
    let lo = 0, hi = this.ids.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1, v = this.ids[m]; if (v === id) return this.row(m); if (v < id) lo = m + 1; else hi = m - 1; }
    return null;
  }
  /** The first ID registered to a callsign. */
  byCallsign(call: string): RadioIdUser | null {
    if (!this.byCall) {
      this.byCall = new Map();
      for (let i = 0; i < this.ids.length; i++) { const p = this.pool.indexOf('|', this.offs[i]); const c = this.pool.slice(this.offs[i], p); if (!this.byCall.has(c)) this.byCall.set(c, i); }
    }
    const i = this.byCall.get(call.trim().toUpperCase());
    return i === undefined ? null : this.row(i);
  }
}

// ------------------------------------------------------------------------------------------------ talkgroups
export interface Talkgroup { id: number; name: string; network: string }
/**
 * The PAPA system's DMR talkgroups as papasys.com/papa-repeaters/dmr/ lists them (read 2026-11-22). Time slot 1:
 * California, California-1, North America, Worldwide, TAC 310, USA. Time slot 2: PAPA Chat, Local, PAPA Bridge (the
 * link to the analog repeaters), SoCal, SoCal 1.
 */
export const PAPA_TALKGROUPS: Talkgroup[] = [
  { id: 3106, name: 'California', network: 'PAPA' }, { id: 31061, name: 'California-1', network: 'PAPA' },
  { id: 93, name: 'North America', network: 'PAPA' }, { id: 91, name: 'Worldwide', network: 'PAPA' },
  { id: 310, name: 'TAC 310', network: 'PAPA' }, { id: 3100, name: 'USA', network: 'PAPA' },
  { id: 31077, name: 'PAPA Chat', network: 'PAPA' }, { id: 2, name: 'Local', network: 'PAPA' },
  { id: 31078, name: 'PAPA Bridge', network: 'PAPA' }, { id: 31066, name: 'SoCal', network: 'PAPA' },
  { id: 31067, name: 'SoCal 1', network: 'PAPA' },
];

export class TalkgroupTable {
  private readonly nets = new Map<string, Map<number, string>>();
  constructor() { this.addList(PAPA_TALKGROUPS); }
  addList(list: Talkgroup[]): void { for (const t of list) { let m = this.nets.get(t.network); if (!m) { m = new Map(); this.nets.set(t.network, m); } m.set(t.id, t.name); } }
  /** Brandmeister's /v2/talkgroup answer: { "91": "World-wide", ... }. */
  addBrandmeister(json: string): number {
    const o = JSON.parse(json) as Record<string, unknown>; const list: Talkgroup[] = [];
    for (const k of Object.keys(o)) { const id = parseInt(k, 10), v = o[k]; if (id >= 0 && typeof v === 'string' && v.trim()) list.push({ id, name: v.trim(), network: 'Brandmeister' }); }
    this.addList(list); return list.length;
  }
  /** A talkgroup's name, from the [network] named first (the repeater's, when it is known), then any other. */
  lookup(id: number, network = ''): Talkgroup | null {
    const order = [network, 'PAPA', 'Brandmeister', ...this.nets.keys()].filter((n, i, a) => n && a.indexOf(n) === i);
    for (const n of order) { const name = this.nets.get(n)?.get(id); if (name) return { id, name, network: n }; }
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ repeaters
export interface Repeater {
  /** Short name or callsign as the source gives it ("PAPA 01", "WIL", "K6ABC"). */
  name: string; call: string; site: string; city: string;
  mode: string; outputHz: number; inputHz: number;
  /** CTCSS tone (Hz) or DCS code ("073 DPL") to access it, color code for DMR (-1 when unknown). */
  tone: string; cc: number; network: string; lat: number; lon: number; status: string; source: string;
}
const blankRepeater = (): Repeater => ({ name: '', call: '', site: '', city: '', mode: '', outputHz: 0, inputHz: 0, tone: '', cc: -1, network: '', lat: NaN, lon: NaN, status: '', source: '' });

/** "446.580-" → output and input (Hz) with the band's standard split; "144.460 s" is simplex. */
export function parseFreqField(s: string): { out: number; inp: number } | null {
  const m = /^\s*(\d{2,4}\.\d+)\s*([+\-s])?/.exec(s);
  if (!m) return null;
  const out = Math.round(parseFloat(m[1]) * 1e6);
  const split = out < 148e6 ? 600_000 : out < 230e6 ? 1_600_000 : out < 470e6 ? 5_000_000 : 12_000_000;
  const inp = m[2] === '-' ? out - split : m[2] === '+' ? out + split : out;
  return { out, inp };
}

/** The PAPA system's repeater sheet (Status, NAME, Site Link, Frequency, tone or color code, ...). */
export function parsePapaCsv(text: string, kind: 'analog' | 'dmr'): Repeater[] {
  const rows = parseCsv(text), out: Repeater[] = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const name = clean(c[1]), f = parseFreqField(c[3] ?? '');
    if (!name || !f) continue;
    const rp = blankRepeater();
    rp.name = kind === 'dmr' ? `PAPA ${name}` : name; rp.site = clean(c[2]); rp.status = clean(c[0]);
    rp.outputHz = f.out; rp.inputHz = f.inp; rp.network = 'PAPA'; rp.source = 'papasys.com';
    if (kind === 'dmr') { rp.mode = 'DMR'; const m = /CC\s*(\d+)/i.exec(c[4] ?? ''); rp.cc = m ? parseInt(m[1], 10) : -1; }
    else { rp.mode = 'FM'; rp.tone = clean(c[4]); }
    out.push(rp);
  }
  return out;
}

/** HearHam's repeater list (https://hearham.com/api/repeaters/v1): frequency and offset in Hz. */
export function parseHearHam(json: string): Repeater[] {
  const a = JSON.parse(json) as Record<string, unknown>[]; const out: Repeater[] = [];
  for (const o of a) {
    const f = Number(o.frequency), off = Number(o.offset ?? 0);
    if (!(f > 0)) continue;
    const rp = blankRepeater();
    rp.call = clean(String(o.callsign ?? '')).toUpperCase(); rp.name = rp.call; rp.city = clean(String(o.city ?? ''));
    rp.mode = clean(String(o.mode ?? '')); rp.outputHz = Math.round(f); rp.inputHz = Math.round(f + off);
    rp.tone = clean(String(o.encode ?? '')); rp.network = clean(String(o.group ?? '')); rp.lat = Number(o.latitude); rp.lon = Number(o.longitude);
    rp.status = o.operational === 0 || o.operational === false ? 'Down' : ''; rp.source = 'hearham.com';
    out.push(rp);
  }
  return out;
}

/** Brandmeister's device list: repeaters are the devices whose transmit and receive frequencies differ. */
export function parseBrandmeisterDevices(json: string): Repeater[] {
  const a = JSON.parse(json) as Record<string, unknown>[]; const out: Repeater[] = [];
  for (const o of a) {
    const tx = parseFloat(String(o.tx ?? '')), rx = parseFloat(String(o.rx ?? ''));
    if (!(tx > 0) || !(rx > 0) || tx === rx) continue;
    const rp = blankRepeater();
    rp.call = clean(String(o.callsign ?? '')).toUpperCase(); rp.name = rp.call; rp.city = clean(String(o.city ?? ''));
    rp.mode = 'DMR'; rp.outputHz = Math.round(tx * 1e6); rp.inputHz = Math.round(rx * 1e6); rp.cc = Number(o.colorcode ?? -1);
    rp.network = 'Brandmeister'; rp.lat = Number(o.lat); rp.lon = Number(o.lng); rp.source = 'brandmeister.network';
    out.push(rp);
  }
  return out;
}

const km = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const r = Math.PI / 180, x = (bLon - aLon) * r * Math.cos((aLat + bLat) * r / 2), y = (bLat - aLat) * r;
  return 6371 * Math.sqrt(x * x + y * y);
};

export class RepeaterDirectory {
  readonly list: Repeater[] = [];
  add(rs: Repeater[]): void { this.list.push(...rs); }
  /**
   * Repeaters whose output is within [tolHz] of [hz], best first: a matching tone or color code, then a listed
   * position nearer [lat, lon], then PAPA's own list. [tone] is the CTCSS (Hz, as text) or "073 DPL".
   */
  at(hz: number, opts: { tolHz?: number; tone?: string; cc?: number; mode?: string; lat?: number; lon?: number; maxKm?: number } = {}): Repeater[] {
    const tol = opts.tolHz ?? 2_500;
    const want = opts.mode === undefined ? '' : modeKey(opts.mode);
    const c = this.list.filter(r => Math.abs(r.outputHz - hz) <= tol && (!want || !r.mode || modeKey(r.mode).split(' ').includes(want)));
    const near = (r: Repeater) => opts.lat !== undefined && opts.lon !== undefined && Number.isFinite(r.lat) && Number.isFinite(r.lon) ? km(opts.lat, opts.lon, r.lat, r.lon) : NaN;
    const kept = c.filter(r => { const d = near(r); return !(opts.maxKm !== undefined && Number.isFinite(d) && d > opts.maxKm); });
    const score = (r: Repeater) => {
      let s = 0;
      if (opts.tone && r.tone && toneEq(r.tone, opts.tone)) s += 100; else if (opts.tone && r.tone) s -= 50;
      if (opts.cc !== undefined && opts.cc >= 0 && r.cc >= 0) s += r.cc === opts.cc ? 100 : -50;
      if (r.status === 'Down') s -= 10;
      if (r.network === 'PAPA') s += 5;
      const d = near(r); if (Number.isFinite(d)) s -= Math.min(40, d / 10);
      return s;
    };
    return kept.map(r => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || (a.r.name < b.r.name ? -1 : a.r.name > b.r.name ? 1 : 0)).map(x => x.r);
  }
  byCall(call: string): Repeater | null { const c = call.trim().toUpperCase(); return this.list.find(r => r.call === c) ?? null; }
}
/** A directory's mode text as the decoder's names: FM, DMR, DSTAR, YSF, P25, NXDN (several, space separated). */
export function modeKey(m: string): string {
  const u = m.toUpperCase(), out: string[] = [];
  if (/D-?STAR|DSTAR/.test(u)) out.push('DSTAR');
  if (/FUSION|C4FM|YSF|SYSTEM FUSION/.test(u)) out.push('YSF');
  if (/DMR|MOTOTRBO/.test(u)) out.push('DMR');
  if (/P25|APCO/.test(u)) out.push('P25');
  if (/NXDN/.test(u)) out.push('NXDN');
  if (/FM|ANALOG|^FM|NFM/.test(u) || out.length === 0) out.push('FM');
  return out.join(' ');
}
/** "127.3" equals "127.3 Hz"; "073 DPL" equals "D073". */
export function toneEq(a: string, b: string): boolean {
  const n = (s: string) => { const d = /(\d{3})\s*(DPL|DCS)|D(\d{3})/i.exec(s); if (d) return 'D' + (d[1] ?? d[3]); const f = parseFloat(s); return Number.isFinite(f) ? f.toFixed(1) : s.trim().toUpperCase(); };
  return n(a) === n(b);
}

// ------------------------------------------------------------------------------------------------ callsigns
/** What callook.info's JSON says about a US callsign. */
export interface CallRecord { callsign: string; name: string; city: string; state: string; grid: string; lat: number; lon: number; licenseClass: string; source: string }
export function parseCallook(json: string): CallRecord | null {
  const j = JSON.parse(json) as { status?: string; name?: string; current?: { callsign?: string; operClass?: string }; address?: { line2?: string }; location?: { latitude?: string; longitude?: string; gridsquare?: string } };
  if (j.status !== 'VALID' || !j.current?.callsign) return null;
  const m = /^(.*?),\s*([A-Z]{2})\s+\d{5}/.exec(j.address?.line2 ?? '');
  return {
    callsign: j.current.callsign.toUpperCase(), name: clean(j.name), city: m ? clean(m[1]) : clean(j.address?.line2), state: m ? m[2] : '',
    grid: clean(j.location?.gridsquare), lat: parseFloat(j.location?.latitude ?? ''), lon: parseFloat(j.location?.longitude ?? ''),
    licenseClass: clean(j.current.operClass), source: 'callook.info',
  };
}
/** A plausible amateur or GMRS callsign heard on the air (what may be looked up), base call only. */
export function lookupKey(heard: string): string {
  const s = heard.trim().toUpperCase().split(/[\s/-]/)[0] ?? '';
  return /^[A-Z0-9]{1,3}\d[A-Z]{1,4}$/.test(s) && /[A-Z]/.test(s) ? s : '';
}
