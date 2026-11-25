/**
 * How Devices writes a sensor's readings, on its card and in its detail alike, in the units picked in Settings
 * (twin of the Devices formatting in DevicesScreen.kt and DevicesScreen.swift). The card's big line and the detail's
 * fields go through the same helpers, so the two can never disagree on °C and °F or kPa and psi.
 */
import type { R433Data } from './dsp/r433/device.js';
import * as U from './units.js';

/** Units for the readings that are not measurements this setting converts, so a number is never shown bare. */
const R433_UNITS: Record<string, string> = {
  humidity: ' %', humidity_1: ' %', moisture: ' %', wind_dir_deg: '°',
  light_lux: ' lux', battery_mV: ' mV', pm2_5_ug_m3: ' µg/m³', estimated_pm10_0_ug_m3: ' µg/m³',
};

export const r433Num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);

/** One field of a reading, as the detail shows it. */
export function r433Value(k: string, v: unknown, u = U.units()): string {
  if (k === 'battery_ok') return v === 1 || v === true ? 'battery ok' : typeof v === 'number' && v > 0 && v < 1 ? `battery ${Math.round(v * 100)}%` : 'BATTERY LOW';
  if (k === 'leak_detected') return v ? 'WET' : 'dry';
  // a measurement in the chosen units; a reading a decoder wrote out in metric ('19.1 °C') is converted too
  const m = U.fmtField(k, v, u) ?? (typeof v === 'string' ? U.fmtText(v, u) : null);
  return m ?? `${v}${R433_UNITS[k] ?? ''}`;
}

/** The temperature a reading carries, in °C, whichever unit the sensor sent it in; null when it has none. */
export function r433TempC(v: R433Data): number | null {
  const c = r433Num(v.temperature_C), f = r433Num(v.temperature_F);
  return c !== null ? c : f !== null ? U.fToC(f) : null;
}

/**
 * The big line and the line under it on a tire or weather sensor's card, or null for anything else. A tire shows
 * its pressure and temperature, a weather sensor its temperature and humidity.
 */
export function r433Measure(v: R433Data, tire: boolean, u = U.units()): [string, string] | null {
  const tc = r433TempC(v);
  if (tire) {
    const kpaRaw = r433Num(v.pressure_kPa), psiRaw = r433Num(v.pressure_PSI), barRaw = r433Num(v.pressure_bar);
    const kpa = kpaRaw !== null ? kpaRaw : psiRaw !== null ? psiRaw * U.KPA_PER_PSI : barRaw !== null ? barRaw * 100 : null;
    return [kpa !== null ? U.fmtTire(kpa, u) : 'TIRE', tc !== null ? U.fmtTemp(tc, 0, u) : ''];
  }
  if (tc !== null) return [U.fmtTemp(tc, 1, u), v.humidity !== undefined ? `${v.humidity}% humidity` : ''];
  if (typeof v.temperature === 'string') return [U.fmtText(v.temperature, u), v.humidity !== undefined ? `${v.humidity} humidity` : ''];
  return null;
}
