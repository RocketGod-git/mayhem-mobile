/**
 * The receiver's audio rate. The demodulator gets from the radio's rate to its audio in two whole-number stages: stage 1
 * (to about 240 kHz for WFM by a plain average, to about 48 kHz for the narrow modes through the ChannelDecimator) and
 * stage 2 (a plain average down to the audio). The audio lands on exactly 48 kHz only when the rate is 48 kHz times
 * both; 1.92 and 2.4 Msps do, 1.8 Msps gives 50 kHz for NFM (1.8 M / 36) and 51.4 kHz for WFM (1.8 M / 7 / 5).
 * AudioRateConverter brings any other rate to exactly 48 kHz with a windowed-sinc resampler; an exact rate is left
 * alone, bit for bit.
 */
import { ChannelDecimator } from './ham/filters.js';

export const AUDIO_OUT_RATE = 48_000;

export interface AudioPlan { rate: number; stage1: number; stage2: number; audioRate: number; exact: boolean }

/** The worker's plan for `rate`: `wfm` takes stage 1 to about 240 kHz, the other modes through the ChannelDecimator. */
export function audioPlan(rate: number, wfm: boolean): AudioPlan {
  let stage1: number;
  if (wfm) stage1 = Math.max(1, Math.floor(rate / 240_000));
  else { const [c, f] = ChannelDecimator.split(Math.max(1, Math.floor(rate / AUDIO_OUT_RATE))); stage1 = c * f; }
  const stage2 = Math.max(1, Math.floor(rate / stage1 / AUDIO_OUT_RATE));
  return { rate, stage1, stage2, audioRate: rate / stage1 / stage2, exact: rate === AUDIO_OUT_RATE * stage1 * stage2 };
}

/**
 * Arbitrary-ratio resampler for one channel: a windowed-sinc kernel (Blackman window) tabulated at `phases` fractional
 * offsets, the cutoff at 46 % of the lower of the two rates, so a rate above the output is filtered before it is
 * thinned. The same kernel as the Android and Apple apps' SincResampler.
 */
export class SincResampler {
  private readonly step: number;
  private readonly table: Float32Array;
  private work = new Float32Array(0);
  private have = 0;
  private pos = 0;

  constructor(inRate: number, outRate: number, private readonly taps = 32, private readonly phases = 512) {
    this.step = inRate / outRate;
    this.table = new Float32Array((phases + 1) * taps);
    const fc = Math.min(1, outRate / inRate) * 0.92;
    const half = taps / 2 - 1;
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const t = k - half - frac;
        const x = Math.PI * fc * t;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
        const w = 0.42 + 0.5 * Math.cos(Math.PI * t / (taps / 2)) + 0.08 * Math.cos(2 * Math.PI * t / (taps / 2));
        const v = sinc * Math.max(0, w);
        this.table[p * taps + k] = v; sum += v;
      }
      for (let k = 0; k < taps; k++) this.table[p * taps + k] /= sum;
    }
  }

  reset(): void { this.have = 0; this.pos = 0; }

  /** `n` samples in; the samples written to `out` (room for maxOut) are returned. */
  process(inp: Float32Array, n: number, out: Float32Array): number {
    const taps = this.taps, phases = this.phases, table = this.table;
    if (this.work.length < this.have + n) { const w = new Float32Array((this.have + n) * 2); w.set(this.work.subarray(0, this.have)); this.work = w; }
    const work = this.work;
    work.set(inp.subarray(0, n), this.have); this.have += n;
    let o = 0, pos = this.pos;
    const have = this.have;
    while (pos + taps <= have) {
      const i0 = Math.floor(pos);
      const row = Math.round((pos - i0) * phases) * taps;
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += work[i0 + k] * table[row + k];
      out[o++] = acc;
      pos += this.step;
    }
    const drop = Math.min(Math.floor(pos), have);
    work.copyWithin(0, drop, have);
    this.have = have - drop; this.pos = pos - drop;
    return o;
  }
}

/** The demodulator's audio at `inRate`, converted to exactly `outRate`; at the output rate itself a plain copy. */
export class AudioRateConverter {
  readonly exact: boolean;
  private readonly rs: SincResampler | null;
  constructor(readonly inRate: number, readonly outRate = AUDIO_OUT_RATE) {
    this.exact = inRate === outRate;
    this.rs = this.exact ? null : new SincResampler(inRate, outRate);
  }
  maxOut(n: number): number { return this.exact ? n : Math.ceil(n * this.outRate / this.inRate) + 4; }
  reset(): void { this.rs?.reset(); }
  process(inp: Float32Array, n: number, out: Float32Array): number {
    if (!this.rs) { out.set(inp.subarray(0, n)); return n; }
    return this.rs.process(inp, n, out);
  }
}
