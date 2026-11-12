/**
 * Spectrum: the dBm scale, and how a span is taken from the radio.
 *
 * The radio measures in dBFS (0 dBFS = a full-scale tone at its 8-bit converter). What that is in dBm depends on
 * the gain in front of the converter, so the scale is gain-aware: dBm = dBFS - gain + K, with K the input level that
 * reaches full scale at 0 dB of gain. K is a typical figure per radio, not a measured one: real parts vary by several
 * dB and with frequency, so the scale is always marked approximate. A trim (CAL) set against a known source moves it.
 */

export type RadioKind = 'hackrf' | 'rtlsdr' | 'none';
export interface GainState {
  kind: RadioKind;
  /** A HackRF Pro reads about 28 dB lower than a One at the same settings (bench-measured). */
  pro: boolean;
  lna: number;
  vga: number;
  amp: boolean;
  /** An RTL-SDR's tuner gain, dB; NaN when the tuner's own AGC sets it (the scale cannot follow it then). */
  tunerDb: number;
}

/** Input level (dBm) at full scale with 0 dB of gain: typical, not measured. */
export const FULL_SCALE_DBM: Record<RadioKind, number> = { hackrf: -10, rtlsdr: -5, none: 0 };
export const HACKRF_AMP_DB = 14;
export const HACKRF_PRO_DB = 28;

/** dBm = dBFS + offset, and why it is only approximate. */
export function dbmOffset(g: GainState, trimDb = 0): { offset: number; note: string; ok: boolean } {
  if (g.kind === 'hackrf') {
    const gain = g.lna + g.vga + (g.amp ? HACKRF_AMP_DB : 0);
    return { offset: FULL_SCALE_DBM.hackrf - gain + (g.pro ? HACKRF_PRO_DB : 0) + trimDb, note: `≈ from LNA ${g.lna} + VGA ${g.vga}${g.amp ? ' + AMP' : ''}`, ok: true };
  }
  if (g.kind === 'rtlsdr') {
    if (!Number.isFinite(g.tunerDb)) return { offset: FULL_SCALE_DBM.rtlsdr + trimDb, note: 'tuner AGC: the dBm scale cannot follow it', ok: false };
    return { offset: FULL_SCALE_DBM.rtlsdr - g.tunerDb + trimDb, note: `≈ from tuner gain ${g.tunerDb} dB`, ok: true };
  }
  return { offset: trimDb, note: 'no radio', ok: false };
}

/** How a span is taken: one FFT (offset clear of DC, or centered with the DC bins patched), or a sweep of slices. */
export type SpanPlan =
  | { kind: 'FFT'; rate: number; tuneHz: number; dcPatch: boolean }
  | { kind: 'SWEEP'; sliceRate: number };

/** Usable fraction of a rate (the baseband filter rolls off the edges). */
export const USABLE = 0.8;
/** A span this fraction of the rate or less is taken with the radio tuned off it. */
export const OFFSET_FIT = 0.3;
/** Where the span's center sits from the radio's when tuned off it, as a fraction of the rate. */
export const OFFSET_AT = 0.25;

/**
 * Pick the cheapest way to take [start, stop] with the rates this radio does (any order): the smallest rate that
 * holds the span clear of DC (up to 10 Msps), else the smallest that holds it centered, else a sweep with the
 * widest slice.
 */
export function planSpan(startHz: number, stopHz: number, rates: number[]): SpanPlan {
  const span = stopHz - startHz, c = (startHz + stopHz) / 2;
  const asc = [...rates].sort((a, b) => a - b);
  for (const r of asc) if (r <= 10_000_000 && span <= OFFSET_FIT * r) return { kind: 'FFT', rate: r, tuneHz: c + OFFSET_AT * r, dcPatch: false };
  for (const r of asc) if (span <= USABLE * r) return { kind: 'FFT', rate: r, tuneHz: c, dcPatch: true };
  return { kind: 'SWEEP', sliceRate: asc[asc.length - 1] };
}

/** "433.92M", "100k", "2.4G", "915000000", "-30" → hertz (a bare number under 10 000 is taken as MHz). */
export function parseHz(s: string): number | null {
  const m = /^\s*([-+]?\d*\.?\d+)\s*([kKmMgG]?)(?:hz|Hz|HZ)?\s*$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'k') return v * 1e3;
  if (u === 'm') return v * 1e6;
  if (u === 'g') return v * 1e9;
  return Math.abs(v) < 10_000 ? v * 1e6 : v;
}

/** A frequency the way a bench analyzer prints it: 433.920 000 MHz, 12.5 kHz. */
export function fmtHz(hz: number, digits = 6): string {
  const a = Math.abs(hz);
  if (a >= 1e9) return `${(hz / 1e9).toFixed(Math.max(0, digits + 0))} GHz`.replace(/(\.\d*?)0+ GHz$/, '$1 GHz').replace(/\. GHz$/, ' GHz');
  if (a >= 1e6) return `${(hz / 1e6).toFixed(digits)} MHz`.replace(/(\.\d*?)0+ MHz$/, '$1 MHz').replace(/\. MHz$/, ' MHz');
  if (a >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`.replace(/(\.\d*?)0+ kHz$/, '$1 kHz').replace(/\. kHz$/, ' kHz');
  return `${hz.toFixed(a < 10 ? 2 : 1)} Hz`.replace(/(\.\d*?)0+ Hz$/, '$1 Hz').replace(/\. Hz$/, ' Hz');
}

/** A time the way a scope prints it: 1.25 ms, 830 µs. */
export function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const a = Math.abs(s);
  if (a === 0) return '0 s';
  if (a >= 1) return `${s.toFixed(3)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  if (a >= 1e-6) return `${(s * 1e6).toFixed(2)} µs`;
  return `${(s * 1e9).toFixed(1)} ns`;
}
