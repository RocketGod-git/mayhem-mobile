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
import { MESHCORE, REGIONS, homeBand, localeRegion, slotHz, usableHalf, type LocalChannel, type McPreset } from './plan.js';

/** The LoRa scanner's wide rate (LoraScanner.RATE; not imported, so this module stays clear of the DSP). */
const WIDE_RATE = 20_000_000;

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
    // mesh moved; LongFast and MediumFast are still widely used
    const names = rn === 'US' ? ['LongTurbo', r.start, 'MediumFast'] : rn === 'ANZ' ? [r.start, 'LongTurbo', 'MediumFast'] : [r.start];
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

/** The wide span's center that holds the most local channels. From each channel in turn (most local first), every
 *  other one that still fits inside the radio's filter is taken, most local first; the window holding the most wins,
 *  the more local start breaking a tie (Portugal's 868 channels outnumber its 433). The user's own channel (first in
 *  the list) is always in view. Leftover room goes toward the channels that didn't fit but are in reach of the band
 *  (433 MHz presets never pull an 868 MHz view). Kept off the spike at the center. */
function wideCenter(a: string): number | null {
  const ch = channels(a);
  if (ch.length === 0) return null;
  const half = Math.trunc(usableHalf(WIDE_RATE));
  let best: { lo: number; hi: number; n: number; out: number[] } | null = null;
  const starts = custom() ? [0] : ch.map((_, i) => i);
  for (const start of starts) {
    const s0 = ch[start];
    let lo = s0.hz - Math.trunc(s0.bw / 2), hi = s0.hz + Math.trunc(s0.bw / 2), n = 1;
    const out: number[] = [];
    ch.forEach((c, i) => {
      if (i === start) return;
      const l = Math.min(lo, c.hz - Math.trunc(c.bw / 2)), h = Math.max(hi, c.hz + Math.trunc(c.bw / 2));
      if (h - l <= 2 * half) { lo = l; hi = h; n++; }
      else if (Math.abs(c.hz - Math.trunc((lo + hi) / 2)) < 3 * half) out.push(c.hz);
    });
    if (!best || n > best.n) best = { lo, hi, n, out };
  }
  const { lo, hi, out } = best!;
  let center = Math.trunc((lo + hi) / 2);
  const slack = half - Math.trunc((hi - lo) / 2);
  if (slack > 0 && out.length > 0) {
    const toward = Math.trunc(out.reduce((s, x) => s + x, 0) / out.length);
    center += toward > center ? slack : -slack;
  }
  const near = ch.find(c => Math.abs(c.hz - center) < c.bw);
  if (near) center = near.hz + near.bw + 100_000;
  return center;
}

/** One channel at a time (a 2 MHz radio): the most local one. */
function narrowChannel(a: string): number | null { return channels(a)[0]?.hz ?? null; }

/** How far above a narrow channel the radio is tuned (clear of the spike at the center). */
const NARROW_SHIFT = 300_000;
const sane = (hz: number): boolean => hz >= 400_000_000 && hz <= 1_000_000_000;

/** The wide span's center: the band the user picked (kept until they pick LOCAL again), else the local one. */
function wideStart(): number {
  const u = readHz(KEY_WIDE);
  if (sane(u)) return u;
  return wideCenter(area()) ?? homeBand().center;
}
/** One channel at a time: the user's pick, else the most local channel; the radio sits 300 kHz above it. */
function narrowStart(): number {
  const u = readHz(KEY_NARROW);
  if (sane(u)) return u + NARROW_SHIFT;
  return (narrowChannel(area()) ?? homeBand().narrow) + NARROW_SHIFT;
}

export const LoraLocal = {
  NARROW_SHIFT,
  picked, setPicked, area, country, meshcore, channels, title, areas, custom, setCustom, wideCenter, narrowChannel,
  wideStart, narrowStart,
  /** The band tile the user picked (0: LOCAL). */
  userWide: (): number => readHz(KEY_WIDE),
  setUserWide: (hz: number): void => write(KEY_WIDE, hz > 0 ? String(hz) : null),
  setUserNarrow: (hz: number): void => write(KEY_NARROW, hz > 0 ? String(hz) : null),
  set position(f: () => { lat: number; lon: number } | null) { position = f; },
  set onChange(f: (() => void) | null) { onChange = f; },
};
