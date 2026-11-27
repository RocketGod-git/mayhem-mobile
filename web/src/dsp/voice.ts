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
 * None of the three is conclusive alone, so the score is a blend, and it needs a reasonable level before it will
 * claim anything at all. A tone keyed on and off (a page, DTMF, AFSK) has all three, so it is ruled out by how
 * much of the speech band's energy sits in a few bins.
 *
 * All of it is read from the speech band only. A CTCSS tone sits steady under the voice, so in the full-band
 * level it flattened the rhythm and the swing of a real over (155.055, PL 82.5: 0.09 before, 0.74 after).
 */
const NF = 512;                                   // analysis frame at 48 kHz: 10.7 ms, 93.75 Hz per bin
const ENV = 128;                                  // envelope history: 1.37 s at the frame rate
const TOP = 6;                                    // bins that hold a tone or a pair of tones

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
  /** Share of frames whose speech band is nearly all in 6 bins: a tone or a pair of tones. */
  tone: number;
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
  /** Per frame: speech band share, and the full-band level for the quiet gate. */
  private readonly share = new Float32Array(ENV);
  private readonly full = new Float32Array(ENV);
  private readonly peak = new Float32Array(ENV);
  private readonly top = new Float32Array(TOP);
  private readonly sorted = new Float32Array(ENV);
  private envN = 0;
  private filled = 0;
  private readonly ere = new Float32Array(ENV);
  private readonly eim = new Float32Array(ENV);
  /** Frames per second of the envelope, and the bins holding the syllable rate. */
  private readonly envRate = 48_000 / NF;
  private readonly loBin = Math.max(1, Math.round(2 * ENV / this.envRate));
  private readonly hiBin = Math.min(ENV / 2 - 1, Math.round(8 * ENV / this.envRate));

  constructor() { for (let i = 0; i < NF; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF); }

  reset(): void { this.n = 0; this.envN = 0; this.filled = 0; this.env.fill(0); this.envDb.fill(0); this.share.fill(0); this.full.fill(0); this.peak.fill(0); }

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
    // Bin k covers k * 93.75 Hz. The speech band is 300-3400, measured against 300-8000 so that hiss counts
    // against it and a CTCSS tone below 300 does not.
    const bin = (hz: number) => Math.round(hz * NF / 48_000);
    let inBand = 0, wide = 0;
    const top = this.top; top.fill(0);
    for (let k = bin(300); k <= bin(8000); k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      wide += p;
      if (k > bin(3400)) continue;
      inBand += p;
      if (p > top[TOP - 1]) { let m = TOP - 1; while (m > 0 && top[m - 1] < p) { top[m] = top[m - 1]; m--; } top[m] = p; }
    }
    let pk = 0;
    for (let m = 0; m < TOP; m++) pk += top[m];
    // Hann power gain 3/8, one-sided: this is the speech band's RMS
    const rms = Math.sqrt(2 * inBand / (NF * NF * 0.375));
    const j = this.envN;
    this.env[j] = rms;
    this.envDb[j] = 20 * Math.log10(rms + 1e-9);
    this.share[j] = wide > 0 ? inBand / wide : 0;
    this.full[j] = Math.sqrt(sq / NF);
    this.peak[j] = inBand > 0 ? pk / inBand : 0;
    this.envN = (j + 1) % ENV;
    if (this.filled < ENV) this.filled++;
  }

  /** Share of frames that are a tone or a pair of tones. */
  private tonal(): number {
    let n = 0;
    for (let i = 0; i < ENV; i++) if (this.peak[i] > 0.9) n++;
    return n / ENV;
  }

  /** Upper quartile of the band share: a fade or a pause between words does not pull it down. */
  private bandShare(): number {
    this.sorted.set(this.share); this.sorted.sort();
    return this.sorted[ENV * 3 / 4];
  }

  /** The current verdict. Meaningless until roughly a second of audio has gone through. */
  read(): VoiceScore {
    if (this.filled < ENV) return { score: 0, band: 0, mod: 0, vary: 0, levelDb: -99, tone: 0 };
    const env = this.env, ere = this.ere, eim = this.eim;
    let mean = 0, fullMean = 0;
    for (let i = 0; i < ENV; i++) { mean += env[i]; fullMean += this.full[i]; }
    mean /= ENV; fullMean /= ENV;
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
    const levelDb = 20 * Math.log10(fullMean + 1e-9), share = this.bandShare(), tone = this.tonal();
    // Too quiet to judge: an open squelch on noise would otherwise score well on variability alone.
    if (levelDb < -46) return { score: 0, band: share, mod, vary, levelDb, tone };
    // Rhythm and swing count only as far as the energy is in the speech band: squelch noise that flutters on a
    // weak carrier swings at the syllable rate too. A tone keyed on and off (a page, DTMF, AFSK packets) has
    // the band and the swing, so a window that is tone for a quarter of its frames scores nothing.
    const band = clamp01((share - 0.50) / 0.30);
    const rhythm = clamp01((mod - 0.06) / 0.14);
    const moving = clamp01((vary - 2) / 6);
    const untoned = clamp01(1 - tone / 0.25);
    return { score: untoned * band * (0.35 + 0.40 * rhythm + 0.25 * moving), band: share, mod, vary, levelDb, tone };
  }
}
