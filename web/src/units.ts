/**
 * Units: Metric or Imperial, one choice in Settings, used for every measurement that is not aviation or marine.
 * Twin of Units.kt and Units.swift.
 *
 * Every value comes in metric (°C, km, m, m/s, km/h, mm, hPa, kPa) and is converted here, never just relabeled.
 * Aviation keeps feet, knots and nautical miles in Flights, UAT and Flight Msgs, and Ships keeps knots and
 * nautical miles: those screens do not call these helpers for them.
 *
 * Metric shows speeds in km/h (wind and vehicles alike), Imperial in mph.
 */
export type UnitSystem = 'metric' | 'imperial';

/** The countries that still measure in Imperial: the United States, Liberia and Myanmar. */
export const IMPERIAL_REGIONS: ReadonlySet<string> = new Set(['US', 'LR', 'MM']);

/** The region of a BCP 47 tag ('en-US' → 'US', 'zh-Hant-TW' → 'TW', 'en_LR' → 'LR'); '' when there is none. */
export function regionOf(tag: string | undefined | null): string {
  if (!tag) return '';
  const parts = tag.replace(/_/g, '-').split('-').slice(1);
  // the region is the first later part that is two letters or three digits (a script is four letters)
  for (const p of parts) if (/^[A-Za-z]{2}$/.test(p) || /^\d{3}$/.test(p)) return p.toUpperCase();
  return '';
}
/** The default for a locale: Imperial in the US, Liberia and Myanmar, Metric everywhere else (and when unknown). */
export function unitsForLocale(tag: string | undefined | null): UnitSystem {
  return IMPERIAL_REGIONS.has(regionOf(tag)) ? 'imperial' : 'metric';
}

const KEY = 'mm.units';
function stored(): UnitSystem | null {
  try { const v = globalThis.localStorage?.getItem(KEY); return v === 'metric' || v === 'imperial' ? v : null; } catch { return null; }
}
function deviceLocale(): string { try { return globalThis.navigator?.language ?? ''; } catch { return ''; } }
let current: UnitSystem = stored() ?? unitsForLocale(deviceLocale());
/** The units in use: the one picked in Settings, or the device's region until one is picked. */
export const units = (): UnitSystem => current;
export function setUnits(u: UnitSystem): void {
  current = u;
  try { globalThis.localStorage?.setItem(KEY, u); } catch { /* private window: it holds for this visit */ }
}

// ---- conversions --------------------------------------------------------------------------------------------------
export const cToF = (c: number) => c * 9 / 5 + 32;
export const fToC = (f: number) => (f - 32) * 5 / 9;
export const KM_PER_MI = 1.609344;
export const M_PER_FT = 0.3048;
export const MM_PER_IN = 25.4;
export const HPA_PER_INHG = 33.8638866667;
export const KPA_PER_PSI = 6.894757293;

const fix = (v: number, d: number) => { const s = v.toFixed(d); return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s; };
const grouped = (v: number) => Math.round(v).toLocaleString('en-US');

/** A temperature given in °C: '19.1 °C' or '66.4 °F'. */
export function fmtTemp(c: number, digits = 1, u = current): string {
  return u === 'imperial' ? `${fix(cToF(c), digits)} °F` : `${fix(c, digits)} °C`;
}
/** Just the number and degree sign, for a big clock face: '19°' or '66°'; [tempUnit] says C or F. */
export const tempNumber = (c: number, digits = 0, u = current) => `${fix(u === 'imperial' ? cToF(c) : c, digits)}°`;
export const tempUnit = (u = current) => (u === 'imperial' ? 'F' : 'C');
/** A speed given in km/h: '12 km/h' or '7 mph'. */
export function fmtSpeedKmh(kmh: number, digits = 0, u = current): string {
  return u === 'imperial' ? `${fix(kmh / KM_PER_MI, digits)} mph` : `${fix(kmh, digits)} km/h`;
}
/** A speed given in m/s: shown in km/h or mph. */
export const fmtSpeedMs = (ms: number, digits = 0, u = current) => fmtSpeedKmh(ms * 3.6, digits, u);
/** A vertical speed given in m/s: '+4.8 m/s' or '+945 ft/min'. */
export function fmtClimb(ms: number, sign = true, u = current): string {
  const s = sign && ms >= 0 ? '+' : '';
  return u === 'imperial' ? `${s}${grouped(ms / M_PER_FT * 60)} ft/min` : `${s}${fix(ms, 1)} m/s`;
}
/** Rain given in mm: '3.2 mm' or '0.13 in'. */
export function fmtRain(mm: number, u = current): string {
  return u === 'imperial' ? `${fix(mm / MM_PER_IN, 2)} in` : `${fix(mm, 1)} mm`;
}
/** A rain rate given in mm/h. */
export function fmtRainRate(mmh: number, u = current): string {
  return u === 'imperial' ? `${fix(mmh / MM_PER_IN, 2)} in/h` : `${fix(mmh, 1)} mm/h`;
}
/** Air pressure given in hPa: '1013.2 hPa' or '29.92 inHg'. */
export function fmtPressure(hPa: number, u = current): string {
  return u === 'imperial' ? `${fix(hPa / HPA_PER_INHG, 2)} inHg` : `${fix(hPa, 1)} hPa`;
}
/** A tire or line pressure given in kPa: '220 kPa' or '31.9 psi'. */
export function fmtTire(kPa: number, u = current): string {
  return u === 'imperial' ? `${fix(kPa / KPA_PER_PSI, 1)} psi` : `${fix(kPa, 0)} kPa`;
}
/** A gauge pressure given in psig (a train's brake pipe): '90 psig' or '621 kPa'. */
export function fmtPsig(psig: number, u = current): string {
  return u === 'imperial' ? `${Math.round(psig)} psig` : `${Math.round(psig * KPA_PER_PSI)} kPa`;
}
/** The same for a gauge face: its number and its unit word. */
export const psigNumber = (psig: number, u = current) => String(Math.round(u === 'imperial' ? psig : psig * KPA_PER_PSI));
export const psigWord = (u = current) => (u === 'imperial' ? 'PSIG' : 'KPA');
/** A ground distance given in km: '850 m' / '2.4 km' / '37 km', or '600 ft' / '1.5 mi' / '23 mi'. */
export function fmtDist(km: number, u = current): string {
  if (u === 'imperial') {
    const mi = km / KM_PER_MI;
    return mi < 0.1 ? `${grouped(mi * 5280)} ft` : `${mi < 10 ? fix(mi, 1) : grouped(mi)} mi`;
  }
  return km < 1 ? `${grouped(km * 1000)} m` : `${km < 10 ? fix(km, 1) : grouped(km)} km`;
}
/** A height or short length given in m: '1,234 m' or '4,049 ft'. */
export function fmtAlt(m: number, u = current): string {
  return u === 'imperial' ? `${grouped(m / M_PER_FT)} ft` : `${grouped(m)} m`;
}
/** A high altitude given in m, for a map label: '23.4 km' or '76,800 ft'. */
export function fmtAltShort(m: number, u = current): string {
  return u === 'imperial' ? `${(Math.round(m / M_PER_FT / 100) * 100).toLocaleString('en-US')} ft` : `${fix(m / 1000, 1)} km`;
}
/** Just the altitude number for a big clock face, and its unit word. */
export const altNumber = (m: number, u = current) => grouped(u === 'imperial' ? m / M_PER_FT : m);
export const altWord = (u = current) => (u === 'imperial' ? 'FEET' : 'METERS');
/** A depth or small length given in cm: '12 cm' or '4.7 in'. */
export function fmtCm(cm: number, u = current): string {
  return u === 'imperial' ? `${fix(cm / 2.54, 1)} in` : `${fix(cm, 0)} cm`;
}
/** An area given in km²: '3.2 km²' or '1.2 sq mi'. */
export function fmtArea(km2: number, u = current): string {
  return u === 'imperial' ? `${fix(km2 / (KM_PER_MI * KM_PER_MI), 1)} sq mi` : `${fix(km2, 1)} km²`;
}

/**
 * One reading from a sensor decoder, by its field name's unit suffix (temperature_C, wind_avg_m_s, rain_in,
 * pressure_kPa...). Returns null for a field that is not a measurement this setting covers.
 */
export function fmtField(key: string, raw: unknown, u = current): string | null {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' && !isNaN(Number(raw)) ? Number(raw) : NaN;
  if (!Number.isFinite(v)) return null;
  const k = key.toLowerCase();
  if (/(^|_)(temperature|setpoint|ambient|alarm|floor_limit|temp)[\w]*_c$/.test(k) || /^temperature\d*_c$/.test(k)) return fmtTemp(v, 1, u);
  if (/(^|_)(temperature|setpoint|ambient|alarm|floor_limit|temp)[\w]*_f$/.test(k) || /^temperature\d*_f$/.test(k)) return fmtTemp(fToC(v), 1, u);
  if (/_km_h$|_kmh$|_kph$/.test(k)) return fmtSpeedKmh(v, 1, u);
  if (/_m_s$/.test(k)) return fmtSpeedMs(v, 1, u);
  if (/_mi_h$|_mph$/.test(k)) return fmtSpeedKmh(v * KM_PER_MI, 1, u);
  if (/rain[\w]*_mm_h$/.test(k)) return fmtRainRate(v, u);
  if (/rain[\w]*_in_h$/.test(k)) return fmtRainRate(v * MM_PER_IN, u);
  if (/rain[\w]*_mm$/.test(k)) return fmtRain(v, u);
  if (/rain[\w]*_in$/.test(k)) return fmtRain(v * MM_PER_IN, u);
  if (/pressure[\w]*_hpa$/.test(k)) return fmtPressure(v, u);
  if (/pressure[\w]*_kpa$/.test(k)) return fmtTire(v, u);
  if (/pressure[\w]*_psi$/.test(k)) return fmtTire(v * KPA_PER_PSI, u);
  if (/pressure[\w]*_bar$/.test(k)) return fmtTire(v * 100, u);
  if (/_cm$/.test(k)) return fmtCm(v, u);
  if (k === 'storm_dist' || /_km$/.test(k)) return fmtDist(v, u);
  if (k === 'strike_distance' || /_mi$/.test(k)) return fmtDist(v * KM_PER_MI, u);
  return null;
}

/**
 * A reading a decoder already wrote out in metric, such as '21.4 °C', '1012.6 hPa', '3.1 m/s' or '125 m', shown in
 * the chosen units. Anything else (a count, a percentage, a voltage) comes back as it was.
 */
export function fmtText(s: string, u = current): string {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(°C|°F|hPa|kPa|m\/s|km\/h|mm|km|m)\s*$/.exec(s);
  if (!m) return s;
  const v = Number(m[1]), d = (m[1].split('.')[1] ?? '').length;
  switch (m[2]) {
    case '°C': return fmtTemp(v, d, u);
    case '°F': return fmtTemp(fToC(v), d, u);
    case 'hPa': return fmtPressure(v, u);
    case 'kPa': return fmtTire(v, u);
    case 'm/s': return fmtSpeedMs(v, 1, u);
    case 'km/h': return fmtSpeedKmh(v, 0, u);
    case 'mm': return fmtRain(v, u);
    case 'km': return fmtDist(v, u);
    default: return fmtAlt(v, u);
  }
}
