import { fft } from '../fft.js';

/**
 * Does this sound like somebody talking?
 *
 * Signal strength says nothing about it: a data carrier, a paging burst and a dispatcher all look the same on a
 * waterfall. Three things do separate speech from everything else a receiver lands on.
 *
 *  - Where the energy sits. Speech lives between about 300 and 3400 Hz. A data carrier spreads flat across the
 *    channel, and a tone puts everything in one place.
 *  - How the envelope moves. Syllables come two to eight times a second, and that rhythm is remarkably constant
 *    across languages and speakers. A carrier, a tone and most digital modes hold a steady level instead.
 *  - How much the level varies. Speech has pauses and stresses; a continuous transmission does not.
 *
 * None of the three is conclusive alone, so the score is a weighted blend, and it needs a reasonable level
 * before it will claim anything at all.
 */
const NF = 512;                                   // analysis frame at 48 kHz: 10.7 ms, 93.75 Hz per bin
const ENV = 128;                                  // envelope history: 1.37 s at the frame rate

export interface VoiceScore {
  /** 0 = certainly not speech, 1 = certainly speech. */
  score: number;
  /** Share of the energy in the speech band. */
  band: number;
  /** Depth of the syllable-rate swing in the envelope. */
  mod: number;
  /** How much the level moves, in dB. */
  vary: number;
  /** Level of the audio itself, in dB below full scale. */
  levelDb: number;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

export class VoiceDetector {
  private readonly buf = new Float32Array(NF);
  private n = 0;
  private readonly re = new Float32Array(NF);
  private readonly im = new Float32Array(NF);
  private readonly win = new Float32Array(NF);
  private readonly env = new Float32Array(ENV);
  private readonly envDb = new Float32Array(ENV);
  private envN = 0;
  private filled = 0;
  private bandAvg = 0;
  private readonly ere = new Float32Array(ENV);
  private readonly eim = new Float32Array(ENV);
  /** Frames per second of the envelope, and the bins holding the syllable rate. */
  private readonly envRate = 48_000 / NF;
  private readonly loBin = Math.max(1, Math.round(2 * ENV / this.envRate));
  private readonly hiBin = Math.min(ENV / 2 - 1, Math.round(8 * ENV / this.envRate));

  constructor() { for (let i = 0; i < NF; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF); }

  reset(): void { this.n = 0; this.envN = 0; this.filled = 0; this.bandAvg = 0; this.env.fill(0); this.envDb.fill(0); }

  /** Feed demodulated audio at 48 kHz, full scale ±1. */
  push(a: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) {
      this.buf[this.n++] = a[i];
      if (this.n >= NF) { this.frame(); this.n = 0; }
    }
  }

  private frame(): void {
    const re = this.re, im = this.im, b = this.buf, w = this.win;
    let sq = 0;
    for (let i = 0; i < NF; i++) { const v = b[i]; sq += v * v; re[i] = v * w[i]; im[i] = 0; }
    fft(re, im);
    // Bin k covers k * 93.75 Hz. The speech band is 300-3400, measured against 100-8000 so that hum and hiss
    // outside the passband count against it.
    const bin = (hz: number) => Math.round(hz * NF / 48_000);
    let inBand = 0, wide = 0;
    for (let k = bin(100); k <= bin(8000); k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      wide += p;
      if (k >= bin(300) && k <= bin(3400)) inBand += p;
    }
    const rms = Math.sqrt(sq / NF);
    this.env[this.envN] = rms;
    this.envDb[this.envN] = 20 * Math.log10(rms + 1e-9);
    this.envN = (this.envN + 1) % ENV;
    if (this.filled < ENV) this.filled++;
    const ratio = wide > 0 ? inBand / wide : 0;
    this.bandAvg += 0.1 * (ratio - this.bandAvg);
  }

  /** The current verdict. Meaningless until roughly a second of audio has gone through. */
  read(): VoiceScore {
    if (this.filled < ENV) return { score: 0, band: this.bandAvg, mod: 0, vary: 0, levelDb: -99 };
    const env = this.env, ere = this.ere, eim = this.eim;
    let mean = 0;
    for (let i = 0; i < ENV; i++) mean += env[i];
    mean /= ENV;
    for (let i = 0; i < ENV; i++) { ere[i] = env[(this.envN + i) % ENV] - mean; eim[i] = 0; }
    fft(ere, eim);
    let syl = 0;
    for (let k = this.loBin; k <= this.hiBin; k++) syl += ere[k] * ere[k] + eim[k] * eim[k];
    const mod = mean > 0 ? Math.sqrt(syl / ENV) / (mean * ENV / 2) : 0;
    let dbMean = 0;
    for (let i = 0; i < ENV; i++) dbMean += this.envDb[i];
    dbMean /= ENV;
    let vsum = 0;
    for (let i = 0; i < ENV; i++) { const d = this.envDb[i] - dbMean; vsum += d * d; }
    const vary = Math.sqrt(vsum / ENV);
    const levelDb = 20 * Math.log10(mean + 1e-9);
    // Too quiet to judge: an open squelch on noise would otherwise score well on variability alone.
    if (levelDb < -46) return { score: 0, band: this.bandAvg, mod, vary, levelDb };
    const band = clamp01((this.bandAvg - 0.35) / 0.30);
    const rhythm = clamp01((mod - 0.06) / 0.14);
    const moving = clamp01((vary - 2) / 6);
    return { score: 0.35 * band + 0.40 * rhythm + 0.25 * moving, band: this.bandAvg, mod, vary, levelDb };
  }
}
