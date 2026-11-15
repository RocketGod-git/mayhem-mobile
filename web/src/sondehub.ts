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
  /** Everything else the latest frame carries, labeled for the detail (temperature, battery, the station hearing it...). */
  fields: { name: string; value: string }[];
  tempC: number | null;
  rh: number | null;
  battV: number | null;
}

/** One balloon's whole flight so far, from SondeHub's telemetry: its track, where it came from, and who hears it. */
export interface HubFlight {
  track: [number, number][];
  launch: { lat: number; lon: number; alt: number; ms: number } | null;
  maxAlt: number;
  maxAltMs: number;
  /** Every station that has uploaded a frame, most frames first. */
  stations: { call: string; frames: number }[];
  frames: number;
  /** Up to ~240 samples across the flight: time, altitude and (when the sonde sends it) temperature. */
  profile: { ms: number; alt: number; temp: number | null }[];
}

/** SondeHub's own landing prediction for a balloon. */
export interface HubPredict {
  lat: number;
  lon: number;
  ms: number;
  path: [number, number][];
  burstAlt: number | null;
  ascent: number | null;
  descent: number | null;
  descending: boolean;
  landed: boolean;
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
  const raw = await r.json() as Record<string, Record<string, unknown>>;
  const out: HubSonde[] = [];
  for (const [serial, v] of Object.entries(raw)) {
    const h = hubParse(serial, v);
    if (h) out.push(h);
  }
  return out.sort((a, b) => b.ms - a.ms);
}

const num = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) ? x : null;
const str = (x: unknown): string | null => typeof x === 'string' && x.trim() ? x.trim() : null;

/** One SondeHub frame as a card: the flight numbers, plus every other field it carries, labeled. */
export function hubParse(serial: string, v: Record<string, unknown>): HubSonde | null {
  const lat = num(v.lat), lon = num(v.lon);
  if (lat === null || lon === null) return null;
  const fields: { name: string; value: string }[] = [];
  const f = (name: string, value: string | null | false) => { if (value) fields.push({ name, value }); };
  const temp = num(v.temp), rh = num(v.humidity), hPa = num(v.pressure), batt = num(v.batt);
  const timer = num(v.burst_timer), snr = num(v.snr), rssi = num(v.rssi), sats = num(v.sats), frame = num(v.frame);
  const tx = num(v.tx_frequency);
  f('MAKER', str(v.manufacturer));
  f('TEMPERATURE', temp !== null && v.invalid_temp !== true && `${temp.toFixed(1)} °C`);
  f('HUMIDITY', rh !== null && `${rh.toFixed(0)} %`);
  f('PRESSURE', hPa !== null && hPa > 0 && `${hPa.toFixed(1)} hPa`);
  f('BATTERY', batt !== null && `${batt.toFixed(1)} V`);
  f('SATELLITES', sats !== null && `${sats}`);
  f('FRAME NUMBER', frame !== null && `${frame}`);
  f('BURST TIMER', timer !== null && timer > 0 && timer < 65535 && hubDur(timer));
  f('TX FREQUENCY', tx !== null && `${tx.toFixed(3)} MHz`);
  f('SIGNAL', snr !== null ? `${snr.toFixed(1)} dB SNR${rssi !== null ? ` · ${rssi.toFixed(0)} dBm` : ''}` : rssi !== null && `${rssi.toFixed(0)} dBm`);
  f('MAINBOARD', str(v.rs41_mainboard) && `${v.rs41_mainboard}${str(v.rs41_mainboard_fw) ? ` · firmware ${v.rs41_mainboard_fw}` : ''}`);
  f('DFM CODE', str(v.dfmcode));
  f('POSITION FROM', str(v.ref_position));
  f('HEARD BY', str(v.uploader_callsign));
  f('THEIR ANTENNA', str(v.uploader_antenna));
  const up = str(v.uploader_position)?.split(',').map(Number);
  if (up && up.length === 2 && up.every(Number.isFinite)) f('THEIR STATION', `${up[0].toFixed(4)}, ${up[1].toFixed(4)}${num(v.uploader_alt) !== null ? ` · ${Math.round(num(v.uploader_alt)!)} m` : ''}`);
  f('THEIR SOFTWARE', str(v.software_name) && `${v.software_name}${str(v.software_version) ? ` ${v.software_version}` : ''}`);
  const dt = str(v.datetime);
  return {
    serial, type: str(v.subtype) ?? str(v.type) ?? 'sonde', mhz: num(v.frequency),
    lat, lon, alt: num(v.alt) ?? 0, climb: num(v.vel_v), speedMs: num(v.vel_h), heading: num(v.heading),
    ms: dt ? Date.parse(dt) : Date.now(), fields, tempC: v.invalid_temp === true ? null : temp, rh, battV: batt,
  };
}

/** A duration in seconds as "8 h 02 min" / "14 min". */
export function hubDur(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** The whole flight so far: every frame anyone uploaded in the last [hours], as one track. */
export async function hubFlight(serial: string, hours = 6): Promise<HubFlight> {
  const r = await fetch(`${API}/sondes/telemetry?serial=${encodeURIComponent(serial)}&duration=${hours}h`);
  if (!r.ok) throw new Error(`SondeHub telemetry: HTTP ${r.status}`);
  const raw = await r.json() as Record<string, Record<string, Record<string, unknown>>>;
  return hubFlightOf(raw[serial] ?? {});
}

export function hubFlightOf(frames: Record<string, Record<string, unknown>>): HubFlight {
  const rows = Object.entries(frames).map(([t, v]) => ({ ms: Date.parse(t), v })).filter(x => Number.isFinite(x.ms) && num(x.v.lat) !== null && num(x.v.lon) !== null)
    .sort((a, b) => a.ms - b.ms);
  const calls = new Map<string, number>();
  let maxAlt = 0, maxAltMs = 0;
  const track: [number, number][] = [];
  for (const { ms, v } of rows) {
    const lat = num(v.lat)!, lon = num(v.lon)!, alt = num(v.alt) ?? 0;
    const last = track[track.length - 1];
    // one point per ~50 m of movement keeps a 5000-frame flight light on the map
    if (!last || Math.abs(last[0] - lat) + Math.abs(last[1] - lon) > 0.0005) track.push([lat, lon]);
    if (alt > maxAlt) { maxAlt = alt; maxAltMs = ms; }
    const ups = Array.isArray(v.uploaders) ? v.uploaders as { uploader_callsign?: string }[] : [{ uploader_callsign: str(v.uploader_callsign) ?? undefined }];
    for (const u of ups) if (u.uploader_callsign) calls.set(u.uploader_callsign, (calls.get(u.uploader_callsign) ?? 0) + 1);
  }
  const first = rows[0];
  const step = Math.max(1, Math.ceil(rows.length / 240));
  const profile = rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
    .map(({ ms, v }) => ({ ms, alt: num(v.alt) ?? 0, temp: v.invalid_temp === true ? null : num(v.temp) }));
  return {
    track, maxAlt, maxAltMs, frames: rows.length, profile,
    launch: first ? { lat: num(first.v.lat)!, lon: num(first.v.lon)!, alt: num(first.v.alt) ?? 0, ms: first.ms } : null,
    stations: [...calls].map(([call, frames]) => ({ call, frames })).sort((a, b) => b.frames - a.frames),
  };
}

/** SondeHub's landing predictions for several balloons in one request, by serial. */
export async function hubPredictions(serials: string[]): Promise<Map<string, HubPredict>> {
  const out = new Map<string, HubPredict>();
  if (!serials.length) return out;
  const r = await fetch(`${API}/predictions?vehicles=${serials.map(encodeURIComponent).join(',')}`);
  if (!r.ok) throw new Error(`SondeHub predictions: HTTP ${r.status}`);
  for (const p of await r.json() as Record<string, unknown>[]) {
    const v = hubPredictOf(p);
    if (v && typeof p.vehicle === 'string') out.set(p.vehicle, v);
  }
  return out;
}

/** SondeHub's landing prediction, or null when it has none for this balloon. */
export async function hubPredict(serial: string): Promise<HubPredict | null> {
  const r = await fetch(`${API}/predictions?vehicles=${encodeURIComponent(serial)}`);
  if (!r.ok) throw new Error(`SondeHub predictions: HTTP ${r.status}`);
  const list = await r.json() as Record<string, unknown>[];
  return hubPredictOf(list.find(x => x.vehicle === serial));
}

export function hubPredictOf(p: Record<string, unknown> | undefined): HubPredict | null {
  if (!p) return null;
  let pts: { time?: number; lat?: number; lon?: number }[] = [];
  try { pts = typeof p.data === 'string' ? JSON.parse(p.data) : Array.isArray(p.data) ? p.data as typeof pts : []; } catch { pts = []; }
  const path = pts.filter(x => typeof x.lat === 'number' && typeof x.lon === 'number').map(x => [x.lat!, x.lon! > 180 ? x.lon! - 360 : x.lon!] as [number, number]);
  const end = pts[pts.length - 1];
  if (!path.length || !end) return null;
  return {
    lat: path[path.length - 1][0], lon: path[path.length - 1][1], ms: (end.time ?? 0) * 1000, path,
    burstAlt: num(p.burst_altitude), ascent: num(p.ascent_rate), descent: num(p.descent_rate),
    descending: p.descending === 1 || p.descending === true, landed: p.landed === 1 || p.landed === true,
  };
}

/** The listed launch site a flight started from: the nearest within 25 km of its first frame. */
export function hubLaunchSite(sites: HubSite[], at: { lat: number; lon: number }): HubSite | null {
  let best: HubSite | null = null, bestKm = 25;
  for (const s of sites) {
    const dy = (s.lat - at.lat) * 111.2, dx = (s.lon - at.lon) * 111.2 * Math.cos(at.lat * Math.PI / 180), km = Math.hypot(dx, dy);
    if (km < bestKm) { bestKm = km; best = s; }
  }
  return best;
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
