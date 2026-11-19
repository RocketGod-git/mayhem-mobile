/**
 * JS8 waveform: 79 tones, continuous phase, the tone frequency Gaussian-smoothed across symbol boundaries
 * (BT 2), with a short raised-cosine ramp at both ends. As audio for USB, or as the instantaneous audio-offset
 * frequency a transmitter adds to its carrier.
 */
import { frameSeconds, type Js8Mode } from './modes.js';

const BT = 2, KG = Math.PI * Math.sqrt(2 / Math.LN2);
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
/** Frequency pulse of one symbol over three symbols: (erf(k BT (t + 1/2)) - erf(k BT (t - 1/2))) / 2. */
function gaussPulse(sps: number): Float32Array {
  const n = 3 * sps, p = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / sps - 1.5; p[i] = 0.5 * (erf(KG * BT * (t + 0.5)) - erf(KG * BT * (t - 0.5))); }
  return p;
}

/** Instantaneous offset from tone 0, Hz, at `rate` samples per second, for the whole frame. */
export function toneTrack(tones: ArrayLike<number>, mode: Js8Mode, rate: number): Float32Array {
  const sps = Math.round(mode.symbol * rate), n = 79 * sps, out = new Float32Array(n), p = gaussPulse(sps);
  // the first and last tones are held one symbol beyond the frame so its ends are steady
  for (let k = -1; k <= 79; k++) {
    const f = tones[Math.max(0, Math.min(78, k))] * mode.spacing, at = (k - 1) * sps;
    for (let i = 0; i < p.length; i++) { const j = at + i; if (j >= 0 && j < n) out[j] += f * p[i]; }
  }
  return out;
}

/** Amplitude ramp at the ends of the frame (an eighth of a symbol), 0..1. */
export function rampAt(i: number, n: number, sps: number): number {
  const r = Math.max(1, Math.round(sps / 8));
  if (i < r) return 0.5 - 0.5 * Math.cos(Math.PI * i / r);
  if (i >= n - r) return 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / r);
  return 1;
}

/** One frame as real audio: tone 0 at `baseHz`. */
export function js8Audio(tones: ArrayLike<number>, mode: Js8Mode, baseHz: number, rate: number, amplitude = 0.5): Float32Array {
  const tr = toneTrack(tones, mode, rate), n = tr.length, sps = Math.round(mode.symbol * rate), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += 2 * Math.PI * (baseHz + tr[i]) / rate; if (ph > 2 * Math.PI) ph -= 2 * Math.PI; out[i] = amplitude * rampAt(i, n, sps) * Math.sin(ph); }
  return out;
}
export const frameSamples = (mode: Js8Mode, rate: number): number => Math.round(frameSeconds(mode) * rate);
