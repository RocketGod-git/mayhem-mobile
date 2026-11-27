/**
 * Which LoRa networks are local. Port of core/lora/LoraLocal.swift: MeshCore's community presets (plan.ts MESHCORE),
 * the Meshtastic region each country uses, and the choice of where to listen: the user's own pick, else where the
 * browser is, else the browser's language region. Nothing is assumed for everyone: mesh users are worldwide.
 *
 * Where the browser is: the web has no offline reverse geocoder, and this app does not send positions to a web
 * service, so the country is the language region (navigator.language, "en-US" -> US). The stored position (the last
 * GPS fix the app had) only picks the part of that country with a preset of its own (SoCal, an Australian state,
 * Limburg, Gisborne), by rough bounds.
 *
 * This runs on the main thread (it reads and writes localStorage); the DSP worker gets the channels it produces
 * (plan.ts setLocalChannels) in a message.
 */
import { MESHCORE, REGIONS, WIDE_RATE, homeBand, localeRegion, slotHz, usableHalf, type LocalChannel, type McPreset } from './plan.js';

/** Europe as MeshCore's "EU/UK" presets mean it. */
export const EUROPE = new Set(['GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'AT', 'CH', 'LI', 'DK', 'SE', 'NO', 'FI', 'IS',
  'PL', 'CZ', 'SK', 'HU', 'SI', 'HR', 'RO', 'BG', 'GR', 'CY', 'MT', 'EE', 'LV', 'LT', 'RS', 'BA', 'ME', 'MK',
  'AL', 'MD', 'UA', 'MC', 'SM', 'AD', 'VA', 'GI', 'XK', 'FO']);

/** Parts of a country with their own preset, by rough bounds: [lat lo, lat hi, lon lo, lon hi]. */
const PARTS: { area: string; boxes: [number, number, number, number][] }[] = [
  { area: 'US-SOCAL', boxes: [[32.5, 35.8, -121.0, -114.1]] },
  { area: 'AU-SAWA', boxes: [[-35.2, -13.7, 112.9, 129.0], [-38.1, -26.0, 129.0, 141.0]] },
  { area: 'AU-QLD', boxes: [[-29.2, -10.0, 138.0, 153.6]] },
  { area: 'NL-LI', boxes: [[50.75, 51.78, 5.56, 6.23]] },
  { area: 'NZ-GIS', boxes: [[-39.0, -37.5, 177.0, 178.7]] },
];

const AMERICAS_US = new Set(['US', 'CA', 'MX', 'PR', 'GU', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'BO', 'PY', 'UY', 'CR', 'PA', 'GT', 'HN', 'SV', 'NI',
  'DO', 'JM', 'TT', 'BS', 'CU']);
const OWN_REGION: Record<string, string> = {
  BR: 'BR_902', AU: 'ANZ', NZ: 'ANZ', JP: 'JP', KR: 'KR', TW: 'TW', TH: 'TH', IN: 'IN', MY: 'MY_919', SG: 'SG_923', PH: 'PH_915',
  CN: 'CN', RU: 'RU', KZ: 'KZ_863', NP: 'NP_865',
};
const EU_868_TOO = new Set(['ZA', 'IL', 'TR', 'AE', 'SA', 'EG', 'MA', 'KE', 'NG']);

/** The Meshtastic region (plan.ts REGIONS) each country uses. */
export function meshtasticRegion(cc: string): string | null {
  if (AMERICAS_US.has(cc)) return 'US';
  if (OWN_REGION[cc]) return OWN_REGION[cc];
  if (EUROPE.has(cc) || EU_868_TOO.has(cc)) return 'EU_868';
  return null;
}

// ---- kept between visits ----

const KEY_AREA = 'mm.lora.area', KEY_CUSTOM = 'mm.lora.custom', KEY_WIDE = 'mm.lora.userWide', KEY_NARROW = 'mm.lora.userNarrow';
function read(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function write(k: string, v: string | null): void {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window, blocked storage */ }
}
function readHz(k: string): number { const v = Number(read(k) ?? 0); return Number.isFinite(v) ? v : 0; }

/** An area someone can pick: "AUTO", a country, or a part of one. */
export interface Area { id: string; title: string }
/** A channel of the user's own: listened to all the time while in span. */
export interface Custom { hz: number; bw: number; sf: number }

/** Where the browser was last (the app's GPS fix, kept between visits); set by the app. */
let position: () => { lat: number; lon: number } | null = () => null;
/** Something the plan depends on changed (another area, the user's own channel). */
let onChange: (() => void) | null = null;
const changed = (): void => { onChange?.(); };

/** The user's own pick ("AUTO" when none). */
function picked(): string { return read(KEY_AREA) ?? 'AUTO'; }
function setPicked(id: string): void { write(KEY_AREA, id === 'AUTO' ? null : id); changed(); }

/** The area in use: the user's pick, else the language region's country (and the part of it the stored position
 *  is in). */
function area(): string {
  const p = picked();
  if (p !== 'AUTO') return p;
  const cc = localeRegion();
  const pos = position();
  if (pos) {
    for (const part of PARTS) {
      if (!part.area.startsWith(cc + '-')) continue;
      if (part.boxes.some(b => pos.lat >= b[0] && pos.lat <= b[1] && pos.lon >= b[2] && pos.lon <= b[3])) return part.area;
    }
  }
  return cc;
}

const country = (a: string): string => a.split('-')[0];

/** A stretch of band a LoRaWAN network lives on: its uplink channels, as one span to listen to. */
export interface LoraWanBand { name: string; hz: number; bw: number; lo: number; hi: number }
/** Where The Things Network and Helium put their uplinks: sub-band 2 of US915 (channels 8 to 15 and 65) in the USA
 *  and Canada, and of AU915 in Australia and New Zealand. Everywhere else LoRaWAN spreads over the band's few
 *  channels, which the band plan already covers. */
function lorawanBands(a: string): LoraWanBand[] {
  const cc = country(a);
  const b = (name: string, first: number) => ({ name, hz: first + 700_000, bw: 1_600_000, lo: first - 62_500, hi: first + 1_400_000 + 62_500 });
  if (cc === 'US' || cc === 'CA') return [b('LoRaWAN sub-band 2', 903_900_000)];
  if (cc === 'AU' || cc === 'NZ') return [b('LoRaWAN sub-band 2', 916_800_000)];
  return [];
}

/** The MeshCore presets for an area: its own part's first, then its country's, then Europe's. */
function meshcore(a: string): McPreset[] {
  const cc = country(a);
  return [...MESHCORE.filter(p => p.area === a && a.includes('-')), ...MESHCORE.filter(p => p.area === cc),
    ...(EUROPE.has(cc) ? MESHCORE.filter(p => p.area === 'EU') : [])];
}

function custom(): Custom | null {
  try {
    const v = JSON.parse(read(KEY_CUSTOM) ?? 'null');
    if (v && Number.isFinite(v.hz) && v.hz > 0 && Number.isFinite(v.bw) && Number.isFinite(v.sf)) return { hz: v.hz, bw: v.bw, sf: v.sf };
  } catch { /* not ours */ }
  return null;
}
function setCustom(c: Custom | null): void { write(KEY_CUSTOM, c ? JSON.stringify(c) : null); changed(); }

/** Everything an area listens for first, most local first. */
function channels(a: string): LocalChannel[] {
  const out: LocalChannel[] = meshcore(a).map(p => ({ hz: p.hz, bw: p.bw, sf: p.sf, name: `MeshCore ${p.title}` }));
  const rn = meshtasticRegion(country(a));
  const r = rn ? REGIONS.find(x => x.name === rn) : undefined;
  if (rn && r) {
    // LongTurbo is the US default from Meshtastic 2.8 (channel 0 resolves to slot 14, 908.75 MHz) and where SoCal's
    // mesh moved; MediumFast is widely used everywhere (many European meshes moved to it for airtime). A region with
    // room for one slot (EU_868) puts it on LongFast's frequency at another spreading factor
    const names = rn === 'US' ? ['LongTurbo', r.start, 'MediumFast'] : rn === 'ANZ' ? [r.start, 'LongTurbo', 'MediumFast'] : [r.start, 'MediumFast'];
    for (const n of names) {
      const p = r.presets.find(x => x.name === n);
      const hz = p ? slotHz(r, p) : null;
      if (p && hz !== null) out.push({ hz, bw: p.bw, sf: p.sf, name: `Meshtastic ${p.name} ${rn}` });
    }
  }
  const c = custom();
  if (c) out.unshift({ hz: c.hz, bw: c.bw, sf: c.sf, name: 'Custom' });
  return out;
}

/**
 * What an area listens to. A part of a country (its position known) listens to its own channels. A whole country
 * (where in it is not known) also listens to the regional networks inside it, after the rest: Southern California's
 * MeshCore runs on its own frequency, so do parts of Australia, the Netherlands and New Zealand. They are heard
 * whenever the span holds them, but they never move where the span is centered: that stays on channels(), the
 * country's own, the same everywhere as before.
 */
function listening(a: string): LocalChannel[] {
  const out = channels(a);
  if (a.includes('-')) return out;
  for (const p of MESHCORE) {
    if (!p.area.startsWith(a + '-') || out.some(c => c.hz === p.hz && c.bw === p.bw && c.sf === p.sf)) continue;
    out.push({ hz: p.hz, bw: p.bw, sf: p.sf, name: `MeshCore ${p.title}` });
  }
  return out;
}

const PART_TITLES: Record<string, string> = {
  'US-SOCAL': 'USA · Southern California', 'AU-SAWA': 'Australia · SA, WA', 'AU-QLD': 'Australia · QLD',
  'NL-LI': 'Netherlands · Limburg', 'NZ-GIS': 'New Zealand · Gisborne',
};
let regionNames: Intl.DisplayNames | null | undefined;
function title(a: string): string {
  if (a === 'AUTO') return 'Automatic';
  if (PART_TITLES[a]) return PART_TITLES[a];
  if (regionNames === undefined) { try { regionNames = new Intl.DisplayNames(['en-US'], { type: 'region' }); } catch { regionNames = null; } }
  try { return regionNames?.of(a) ?? a; } catch { return a; }
}

/** The areas offered to pick from: automatic, then every country or part with a preset of its own. */
function areas(): Area[] {
  const ids: string[] = [];
  for (const p of MESHCORE) if (p.area !== 'EU' && !ids.includes(p.area)) ids.push(p.area);
  for (const cc of ['GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'KR', 'TW', 'IN', 'MY', 'SG', 'PH', 'CN', 'RU', 'KZ', 'NP', 'MX', 'ZA']) if (!ids.includes(cc)) ids.push(cc);
  const named = ids.map(id => ({ id, title: title(id) })).sort((x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0));
  return [{ id: 'AUTO', title: 'Automatic' }, ...named];
}

/** The area's Meshtastic default channel: its region's starting preset (LongFast in most), the busiest Meshtastic
 *  channel almost everywhere. Null where no Meshtastic region is known. */
function meshtasticDefault(a: string): LocalChannel | null {
  const rn = meshtasticRegion(country(a));
  const r = rn ? REGIONS.find(x => x.name === rn) : undefined;
  const p = r?.presets.find(x => x.name === r.start);
  const hz = r && p ? slotHz(r, p) : null;
  return p && hz !== null ? { hz, bw: p.bw, sf: p.sf, name: `Meshtastic ${p.name} ${rn}` } : null;
}

/** The wide span's center at `rate`. The user's own channel and the area's Meshtastic default channel are always in
 *  view; then, from each channel in turn (most local first), every other one that still fits inside the radio's
 *  filter is taken, most local first; the window holding the most wins, the more local start breaking a tie
 *  (Portugal's 868 channels outnumber its 433). Leftover room goes toward the channels that didn't fit but are in
 *  reach of the band (433 MHz presets never pull an 868 MHz view). Kept off the spike at the center. */
function wideCenter(a: string, rate = WIDE_RATE): number | null {
  const ch = channels(a);
  if (ch.length === 0) return null;
  const half = Math.trunc(usableHalf(rate));
  const edge = (c: LocalChannel): [number, number] => [c.hz - Math.trunc(c.bw / 2), c.hz + Math.trunc(c.bw / 2)];
  // what must be in view: the user's own channel (first in the list), then the Meshtastic default if both fit
  const must: number[] = custom() ? [0] : [];
  const md = meshtasticDefault(a);
  const mi = md ? ch.findIndex(c => c.hz === md.hz && c.bw === md.bw) : -1;
  if (mi >= 0 && !must.includes(mi)) {
    const ends = [...must, mi].flatMap(i => edge(ch[i]));
    if (Math.max(...ends) - Math.min(...ends) <= 2 * half) must.push(mi);
  }
  let best: { lo: number; hi: number; n: number; out: number[]; held: number[] } | null = null;
  for (const start of [-1, ...ch.map((_, i) => i)]) {
    if (start < 0 && must.length === 0) continue;
    let lo = Infinity, hi = -Infinity;
    const held: number[] = [], out: number[] = [];
    const take = (i: number): boolean => {
      const [l0, h0] = edge(ch[i]);
      const l = Math.min(lo, l0), h = Math.max(hi, h0);
      if (h - l > 2 * half) return false;
      lo = l; hi = h; held.push(i);
      return true;
    };
    for (const i of must) take(i);
    if (start >= 0 && !held.includes(start) && !take(start)) continue;
    ch.forEach((c, i) => {
      if (held.includes(i) || take(i)) return;
      if (Math.abs(c.hz - Math.trunc((lo + hi) / 2)) < 3 * half) out.push(c.hz);
    });
    if (!best || held.length > best.n) best = { lo, hi, n: held.length, out, held };
  }
  const { lo, hi, out, held } = best!;
  let center = Math.trunc((lo + hi) / 2);
  const slack = half - Math.trunc((hi - lo) / 2);
  if (slack > 0 && out.length > 0) {
    const toward = Math.trunc(out.reduce((s, x) => s + x, 0) / out.length);
    center += toward > center ? slack : -slack;
  }
  // off the spike, to whichever side keeps every held channel in view
  const near = ch.find(c => Math.abs(c.hz - center) < c.bw);
  if (near) {
    const fits = (x: number): boolean => held.every(i => Math.abs(ch[i].hz - x) + Math.trunc(ch[i].bw / 2) <= half);
    center = [near.hz + near.bw + 100_000, near.hz - near.bw - 100_000].find(fits) ?? center;
  }
  return center;
}

/** One channel at a time (a 2 MHz radio): the user's own, else the area's Meshtastic default, else the most local. */
function narrowChannel(a: string): number | null {
  if (custom()) return channels(a)[0]?.hz ?? null;
  return meshtasticDefault(a)?.hz ?? channels(a)[0]?.hz ?? null;
}

/** Every area this module knows a Meshtastic region or MeshCore preset for (for tests and tools). */
function knownAreas(): string[] {
  const ids = new Set<string>([...AMERICAS_US, ...Object.keys(OWN_REGION), ...EUROPE, ...EU_868_TOO, ...PARTS.map(p => p.area)]);
  for (const p of MESHCORE) if (p.area !== 'EU') ids.add(p.area);
  for (const x of areas()) if (x.id !== 'AUTO') ids.add(x.id);
  return [...ids];
}

/** How far above a narrow channel the radio is tuned (clear of the spike at the center). */
const NARROW_SHIFT = 300_000;
const sane = (hz: number): boolean => hz >= 400_000_000 && hz <= 1_000_000_000;

/** The wide span's center: the band the user picked (kept until they pick LOCAL again), else the local one. */
function wideStart(rate = WIDE_RATE): number {
  const u = readHz(KEY_WIDE);
  if (sane(u)) return u;
  return wideCenter(area(), rate) ?? homeBand().center;
}
/** One channel at a time: the user's pick, else narrowChannel; the radio sits 300 kHz above it. */
function narrowStart(): number {
  const u = readHz(KEY_NARROW);
  if (sane(u)) return u + NARROW_SHIFT;
  return (narrowChannel(area()) ?? homeBand().narrow) + NARROW_SHIFT;
}

export const LoraLocal = {
  NARROW_SHIFT, WIDE_RATE,
  picked, setPicked, area, country, meshcore, channels, listening, lorawanBands, title, areas, custom, setCustom, wideCenter, narrowChannel,
  wideStart, narrowStart, meshtasticDefault, knownAreas,
  /** The band tile the user picked (0: LOCAL). */
  userWide: (): number => readHz(KEY_WIDE),
  setUserWide: (hz: number): void => write(KEY_WIDE, hz > 0 ? String(hz) : null),
  setUserNarrow: (hz: number): void => write(KEY_NARROW, hz > 0 ? String(hz) : null),
  set position(f: () => { lat: number; lon: number } | null) { position = f; },
  set onChange(f: (() => void) | null) { onChange = f; },
};
