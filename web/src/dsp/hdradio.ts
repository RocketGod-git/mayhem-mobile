/**
 * HD Radio (NRSC-5, FM hybrid mode) detector.
 *
 * What it does: finds the digital sidebands an HD station puts either side of its analog carrier, measures how
 * strong they are against the noise just beyond them, and proves they carry OFDM by locking to the cyclic prefix,
 * which also yields the carrier frequency error. What it does not do: decode audio. The codec (HDC) is proprietary
 * and undocumented; nrsc5's decoder is a reverse-engineering of it running to tens of thousands of lines, well
 * beyond a port. Layer 1 proper (symbol sync, system control, the station-information service) is the honest next
 * step, and this is its front end.
 *
 * How. The channel is mixed to DC and brought to ~480 kHz. A 1024-point spectrum there gives the power in each
 * primary sideband (129.4–198.0 kHz out: subcarriers 356–545 at 363.373 Hz spacing), in the analog channel, and
 * just beyond the sidebands (205–235 kHz) as the noise reference; sideband over reference is the digital
 * signal-to-noise. Each sideband is then mixed to DC on its own, low-passed to ±36 kHz and brought to ~96 kHz,
 * where one OFDM symbol is ~278.6 samples with a ~14-sample cyclic prefix. The prefix is a copy of the symbol's
 * tail, so x[n]·conj(x[n−L]) (L = the useful symbol length) summed over a prefix length peaks once per symbol at a
 * fixed phase of the symbol clock. Folding that magnitude by symbol phase into 64 bins over a few hundred symbols
 * gives a profile whose peak-to-mean ratio is the lock — noise folds flat, about 1.0 — and the phase of the complex
 * sum at the peak is the carrier error. Any input rate works; everything is derived from it.
 */
import { fft, hann } from '../fft.js';

export interface HdReport {
  /** Sidebands present and carrying OFDM: the decision the badge shows. */
  present: boolean;
  /** Digital sideband power over the noise just beyond it, dB (the better sideband). */
  snrDb: number;
  /** Cyclic-prefix lock, peak-to-mean of the folded correlation (1.0 = nothing; a clean signal reads 2–4). */
  lock: number;
  lockLo: number; lockHi: number;
  sbLoDb: number; sbHiDb: number; refDb: number; analogDb: number;
  /** Carrier frequency error of the station relative to the dial, Hz, from the locked sideband — modulo one subcarrier
   *  spacing (so within ±181 Hz): the cyclic prefix resolves only the fractional part of the error. */
  cfoHz: number;
  /** OFDM symbols folded into this report. */
  symbols: number;
  /** The folded prefix-correlation profile of the better sideband (64 bins over one symbol), for diagnosis. */
  profile: number[];
  /** Milliseconds of worker time this report cost, against the 500 ms of signal it covers. */
  ms: number;
}

const HD_RATE = 744_187.5;                 // the standard's reference rate: 2048-point symbols at 363.373 Hz spacing
const OFDM_N = 2048, OFDM_CP = 112, OFDM_SYM = OFDM_N + OFDM_CP;
const SUB_SPACING = HD_RATE / OFDM_N;
/** Primary main sideband: subcarriers 356..545, so 129.36–198.04 kHz from the carrier. */
const SB_LO_HZ = 356 * SUB_SPACING, SB_HI_HZ = 545 * SUB_SPACING;
/** The sideband is brought down by a whole number of subcarrier spacings (450 of the 450.5 to its centre), so the
 *  subcarrier grid lands exactly on DC. Mixing by a fraction of a spacing leaves the cyclic-prefix phase carrying
 *  that fraction as a turn, which read as a constant carrier error of half the symbol rate. */
const SB_MIX_HZ = 450 * SUB_SPACING;
const REF_LO_HZ = 205_000, REF_HI_HZ = 235_000;    // just past the sideband: the noise reference
const ANALOG_HZ = 100_000;
const FOLD = 64;
const PRESENT_SNR_DB = 6, PRESENT_LOCK = 1.35;

/** Hann-windowed sinc low-pass, unity DC gain. `cutoff` as a fraction of the sample rate. */
function lowpass(taps: number, cutoff: number): Float32Array {
  const h = new Float32Array(taps), m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (taps + 1));
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/** One sideband, brought to DC at its own low rate, with the cyclic-prefix correlator on it. */
class Sideband {
  private stepRe = 1; private stepIm = 0; private phRe = 1; private phIm = 0; private phN = 0;
  private d2 = 1; private cnt = 0; private pathRate = 0;
  private taps = new Float32Array(0);
  private lineRe = new Float32Array(0); private lineIm = new Float32Array(0); private lineAt = 0;
  private L = 0; private cp = 0; private P = 1;
  private yRe = new Float32Array(1024); private yIm = new Float32Array(1024); private yAt = 0; private yN = 0;
  private rRe = new Float32Array(64); private rIm = new Float32Array(64); private rAt = 0;
  private sRe = 0; private sIm = 0;
  private phase = 0;
  private readonly prof = new Float64Array(FOLD); private readonly profRe = new Float64Array(FOLD); private readonly profIm = new Float64Array(FOLD);
  private symbols = 0;

  configure(rate1: number, shiftHz: number): void {
    const w = -2 * Math.PI * shiftHz / rate1;
    this.stepRe = Math.cos(w); this.stepIm = Math.sin(w); this.phRe = 1; this.phIm = 0; this.phN = 0;
    this.d2 = Math.max(1, Math.round(rate1 / 96_000)); this.cnt = 0;
    this.pathRate = rate1 / this.d2;
    this.taps = lowpass(63, 36_000 / rate1);
    this.lineRe = new Float32Array(this.taps.length); this.lineIm = new Float32Array(this.taps.length); this.lineAt = 0;
    this.L = Math.round(OFDM_N * this.pathRate / HD_RATE);
    this.cp = Math.max(4, Math.round(OFDM_CP * this.pathRate / HD_RATE));
    this.P = OFDM_SYM * this.pathRate / HD_RATE;
    this.yRe = new Float32Array(1024); this.yIm = new Float32Array(1024); this.yAt = 0; this.yN = 0;
    this.rRe = new Float32Array(this.cp); this.rIm = new Float32Array(this.cp); this.rAt = 0; this.sRe = 0; this.sIm = 0;
    this.clear();
  }
  clear(): void { this.prof.fill(0); this.profRe.fill(0); this.profIm.fill(0); this.symbols = 0; }

  /** One sample at rate1. */
  push(re: number, im: number): void {
    // mix this sideband's centre to DC
    const xr = re * this.phRe - im * this.phIm, xi = re * this.phIm + im * this.phRe;
    const nr = this.phRe * this.stepRe - this.phIm * this.stepIm; this.phIm = this.phRe * this.stepIm + this.phIm * this.stepRe; this.phRe = nr;
    if (++this.phN >= 4096) { this.phN = 0; const g = 1 / Math.sqrt(this.phRe * this.phRe + this.phIm * this.phIm); this.phRe *= g; this.phIm *= g; }
    // delay line for the low-pass; only every d2-th output is computed (polyphase)
    const n = this.taps.length;
    this.lineRe[this.lineAt] = xr; this.lineIm[this.lineAt] = xi; this.lineAt = (this.lineAt + 1) % n;
    if (++this.cnt < this.d2) return;
    this.cnt = 0;
    let yr = 0, yi = 0, j = this.lineAt;                          // oldest sample first
    for (let i = 0; i < n; i++) { const h = this.taps[n - 1 - i]; yr += h * this.lineRe[j]; yi += h * this.lineIm[j]; if (++j === n) j = 0; }
    this.onPath(yr, yi);
  }

  private onPath(yr: number, yi: number): void {
    const ring = this.yRe.length;
    this.yRe[this.yAt] = yr; this.yIm[this.yAt] = yi;
    const at = this.yAt; this.yAt = (this.yAt + 1) % ring;
    if (this.yN < ring) this.yN++;
    if (this.yN <= this.L) return;
    const j = (at - this.L + ring) % ring, br = this.yRe[j], bi = this.yIm[j];
    // x[n]·conj(x[n−L]), summed over the last cp samples
    const rr = yr * br + yi * bi, ri = yi * br - yr * bi;
    this.sRe += rr - this.rRe[this.rAt]; this.sIm += ri - this.rIm[this.rAt];
    this.rRe[this.rAt] = rr; this.rIm[this.rAt] = ri; this.rAt = (this.rAt + 1) % this.cp;
    const bin = Math.min(FOLD - 1, Math.floor(this.phase * FOLD));
    this.prof[bin] += Math.sqrt(this.sRe * this.sRe + this.sIm * this.sIm);
    this.profRe[bin] += this.sRe; this.profIm[bin] += this.sIm;
    this.phase += 1 / this.P;
    if (this.phase >= 1) { this.phase -= 1; this.symbols++; }
  }

  /** Lock (peak-to-mean of the folded profile), carrier error at the peak, symbols folded; then start over. */
  report(): { lock: number; cfoHz: number; symbols: number; profile: number[] } {
    let sum = 0, peak = 0, pk = 0;
    for (let b = 0; b < FOLD; b++) { sum += this.prof[b]; if (this.prof[b] > peak) { peak = this.prof[b]; pk = b; } }
    const mean = sum / FOLD;
    const lock = mean > 0 ? peak / mean : 0;
    const cfoHz = Math.atan2(this.profIm[pk], this.profRe[pk]) * this.pathRate / (2 * Math.PI * this.L);
    const symbols = this.symbols;
    const profile = Array.from(this.prof, v => mean > 0 ? Math.round(v / mean * 100) / 100 : 0);
    this.clear();
    return { lock, cfoHz, symbols, profile };
  }
}

export class HdDetector {
  private rate = 0; private d1 = 1; private rate1 = 0;
  private offset = NaN; private stepRe = 1; private stepIm = 0; private phRe = 1; private phIm = 0; private phN = 0;
  private accRe = 0; private accIm = 0; private accN = 0;
  private readonly hi = new Sideband(); private readonly lo = new Sideband();
  private readonly N = 1024;
  private readonly fre = new Float32Array(1024); private readonly fim = new Float32Array(1024);
  private readonly win = hann(1024);
  private readonly frame = new Float32Array(2048); private frameN = 0; private frameGap = 0;
  private readonly pow = new Float64Array(1024); private pows = 0;
  private since = 0; private every = 0;
  private last: HdReport | null = null;
  private spent = 0;

  constructor(private readonly emit: (r: HdReport) => void) {}

  get state(): HdReport | null { return this.last; }

  reset(): void {
    this.rate = 0; this.offset = NaN; this.pow.fill(0); this.pows = 0; this.frameN = 0; this.frameGap = 0;
    this.since = 0; this.hi.clear(); this.lo.clear(); this.last = null;
  }

  private configure(rate: number): void {
    this.rate = rate;
    this.d1 = Math.max(1, Math.round(rate / 480_000)); this.accRe = this.accIm = 0; this.accN = 0;
    this.rate1 = rate / this.d1;
    this.hi.configure(this.rate1, SB_MIX_HZ); this.lo.configure(this.rate1, -SB_MIX_HZ);
    this.pow.fill(0); this.pows = 0; this.frameN = 0; this.frameGap = 0;
    this.every = Math.round(rate / 2); this.since = 0;
    this.offset = NaN;
  }

  /** Raw interleaved int8 IQ at `rate`; the station sits `offsetHz` from the span centre. */
  push(iq: Int8Array, n: number, rate: number, offsetHz: number): void {
    const t0 = performance.now();
    if (rate !== this.rate) this.configure(rate);
    if (offsetHz !== this.offset) { this.offset = offsetHz; const w = -2 * Math.PI * offsetHz / rate; this.stepRe = Math.cos(w); this.stepIm = Math.sin(w); }
    const d1 = this.d1;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k], b = iq[2 * k + 1];
      const xr = a * this.phRe - b * this.phIm, xi = a * this.phIm + b * this.phRe;
      const nr = this.phRe * this.stepRe - this.phIm * this.stepIm; this.phIm = this.phRe * this.stepIm + this.phIm * this.stepRe; this.phRe = nr;
      if (++this.phN >= 4096) { this.phN = 0; const g = 1 / Math.sqrt(this.phRe * this.phRe + this.phIm * this.phIm); this.phRe *= g; this.phIm *= g; }
      this.accRe += xr; this.accIm += xi;
      if (++this.accN >= d1) { const yr = this.accRe / d1, yi = this.accIm / d1; this.accRe = this.accIm = 0; this.accN = 0; this.at1(yr, yi); }
    }
    this.since += n;
    this.spent += performance.now() - t0;
    if (this.since >= this.every) { this.since = 0; this.report(); }
  }

  /** One sample at ~480 kHz: every eighth 1024-sample frame goes to the spectrum; every sample to both sidebands. */
  private at1(re: number, im: number): void {
    if (this.frameGap > 0) this.frameGap--;
    else {
      this.frame[2 * this.frameN] = re; this.frame[2 * this.frameN + 1] = im;
      if (++this.frameN >= this.N) {
        this.frameN = 0; this.frameGap = 7 * this.N;
        for (let i = 0; i < this.N; i++) { this.fre[i] = this.frame[2 * i] * this.win[i]; this.fim[i] = this.frame[2 * i + 1] * this.win[i]; }
        fft(this.fre, this.fim);
        for (let i = 0; i < this.N; i++) this.pow[i] += this.fre[i] * this.fre[i] + this.fim[i] * this.fim[i];
        this.pows++;
      }
    }
    this.hi.push(re, im); this.lo.push(re, im);
  }

  /** Mean power, dB, over the bins covering [loHz, hiHz) (negative for below the carrier). */
  private bandDb(loHz: number, hiHz: number): number {
    const binHz = this.rate1 / this.N;
    let a = Math.round(loHz / binHz), b = Math.round(hiHz / binHz);
    if (a > b) { const t = a; a = b; b = t; }
    let sum = 0, cnt = 0;
    for (let k = a; k < b; k++) { const i = ((k % this.N) + this.N) % this.N; sum += this.pow[i]; cnt++; }
    return cnt && this.pows ? 10 * Math.log10(sum / cnt / this.pows + 1e-20) : -200;
  }

  private report(): void {
    const sbHiDb = this.bandDb(SB_LO_HZ, SB_HI_HZ), sbLoDb = this.bandDb(-SB_HI_HZ, -SB_LO_HZ);
    const refDb = 10 * Math.log10((Math.pow(10, this.bandDb(REF_LO_HZ, REF_HI_HZ) / 10) + Math.pow(10, this.bandDb(-REF_HI_HZ, -REF_LO_HZ) / 10)) / 2 + 1e-20);
    const analogDb = this.bandDb(-ANALOG_HZ, ANALOG_HZ);
    this.pow.fill(0); this.pows = 0;
    const hi = this.hi.report(), lo = this.lo.report();
    const best = hi.lock >= lo.lock ? hi : lo;
    const snrDb = Math.max(sbHiDb, sbLoDb) - refDb;
    const lock = Math.max(hi.lock, lo.lock);
    const r: HdReport = {
      present: snrDb >= PRESENT_SNR_DB && lock >= PRESENT_LOCK,
      snrDb, lock, lockLo: lo.lock, lockHi: hi.lock, sbLoDb, sbHiDb, refDb, analogDb,
      cfoHz: best.cfoHz, symbols: best.symbols, profile: best.profile, ms: Math.round(this.spent),
    };
    this.spent = 0;
    this.last = r;
    this.emit(r);
  }
}
