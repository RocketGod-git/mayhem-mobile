/**
 * SondeHub, the open network of radiosonde receivers: where the launch sites are, and every balloon in the air
 * that someone, somewhere, is hearing. Sondes shows both before its own radio hears anything, so the screen says
 * what is up and where to listen; a sonde our own decoder hears takes over its card.
 *
 * API: https://api.v2.sondehub.org (open data). /sites lists every launch site (902 of them); /sondes lists the
 * latest frame of every sonde heard in a window, optionally within a distance of a point.
 */

export interface HubSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Sonde types flown there ("41" is a Vaisala RS41), with a frequency where the site lists one. */
  types: string[];
  /** Nominal launch times as listed ("0:00:00" style: day:hh:mm), or a note such as "Irregular". */
  times: string[];
}

export interface HubSonde {
  serial: string;
  type: string;
  mhz: number | null;
  lat: number;
  lon: number;
  alt: number;
  climb: number | null;
  speedMs: number | null;
  heading: number | null;
  ms: number;
}

const API = 'https://api.v2.sondehub.org';
const SITES_KEY = 'mm.sondehub.sites';
const DAY = 86_400_000;

/** The launch sites, from the browser's copy when it is under a day old. */
export async function hubSites(): Promise<HubSite[]> {
  try {
    const kept = JSON.parse(localStorage.getItem(SITES_KEY) ?? 'null') as { at: number; sites: HubSite[] } | null;
    if (kept && Date.now() - kept.at < DAY && kept.sites.length) return kept.sites;
  } catch { /* storage blocked or unreadable: fetch */ }
  const r = await fetch(`${API}/sites`);
  if (!r.ok) throw new Error(`SondeHub sites: HTTP ${r.status}`);
  const raw = await r.json() as Record<string, { station?: string; station_name?: string; position?: [number, number]; rs_types?: (string | string[])[]; times?: string[] }>;
  const sites: HubSite[] = [];
  for (const [id, v] of Object.entries(raw)) {
    const p = v.position; if (!p || p.length < 2) continue;
    sites.push({
      id: v.station ?? id,
      name: (v.station_name ?? id).replace(/\s*\((United States|USA)\)\s*$/, ''),
      lat: p[1], lon: p[0],
      types: (v.rs_types ?? []).map(t => Array.isArray(t) ? `${hubTypeName(t[0])} ${t[1]} MHz` : hubTypeName(t)),
      times: v.times ?? [],
    });
  }
  try { localStorage.setItem(SITES_KEY, JSON.stringify({ at: Date.now(), sites })); } catch { /* storage full or blocked */ }
  return sites;
}

/** Every sonde heard by anyone in the last [lastS] seconds within [km] of a point. */
export async function hubSondes(lat: number, lon: number, km = 400, lastS = 3 * 3600): Promise<HubSonde[]> {
  const r = await fetch(`${API}/sondes?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&distance=${Math.round(km * 1000)}&last=${lastS}`);
  if (!r.ok) throw new Error(`SondeHub sondes: HTTP ${r.status}`);
  const raw = await r.json() as Record<string, { type?: string; subtype?: string; frequency?: number; lat?: number; lon?: number; alt?: number; vel_v?: number; vel_h?: number; heading?: number; datetime?: string }>;
  const out: HubSonde[] = [];
  for (const [serial, v] of Object.entries(raw)) {
    if (typeof v.lat !== 'number' || typeof v.lon !== 'number') continue;
    out.push({
      serial, type: v.subtype || v.type || 'sonde', mhz: typeof v.frequency === 'number' ? v.frequency : null,
      lat: v.lat, lon: v.lon, alt: v.alt ?? 0, climb: v.vel_v ?? null, speedMs: v.vel_h ?? null, heading: v.heading ?? null,
      ms: v.datetime ? Date.parse(v.datetime) : Date.now(),
    });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/** SondeHub's short type codes as the names people know. */
export function hubTypeName(t: string): string {
  const m: Record<string, string> = { '41': 'RS41', '92': 'RS92', '11': 'LMS6', '82': 'LMS6-1680', '17': 'DFM-17', '09': 'DFM-09', '06': 'DFM-06', '52': 'RS92-NGP', '77': 'M10', '87': 'M20' };
  return m[t] ?? t;
}

/**
 * When a site next launches, by its listed times (taken as UTC hours, as SondeHub writes them: "0:12:00" is 12:00),
 * about an hour before each nominal time as weather services do. Null when the site lists none or calls itself
 * irregular.
 */
export function nextLaunchMs(site: HubSite, now = Date.now()): number | null {
  const hours = site.times.map(t => /^\d+:(\d{1,2}):(\d{2})$/.exec(t.trim())).filter((m): m is RegExpExecArray => !!m).map(m => Number(m[1]) + Number(m[2]) / 60);
  if (!hours.length) return null;
  const d = new Date(now), day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let best: number | null = null;
  for (let k = -1; k <= 1; k++) for (const h of hours) {
    const launch = day0 + k * DAY + h * 3_600_000 - 3_600_000;
    // a launch counts as current for 90 minutes after it goes up (the balloon is still climbing)
    if (launch + 90 * 60_000 >= now && (best === null || launch < best)) best = launch;
  }
  return best;
}
