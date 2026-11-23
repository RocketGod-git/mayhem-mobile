/**
 * One CB channel's demodulator: home's method (see carrier.ts), the mode found from the transmission or set by hand.
 *
 * Down-converted to about 16 kS/s, the idle lines the engine measured are notched (12 Hz wide, never within 30 Hz of
 * the carrier, so only once the carrier is known), and the carrier tracker finds and holds a station's carrier.
 *  - A carrier held: AM, or FM when its envelope is flat; readable when its median q is 22 dB or more.
 *  - None: single sideband, the side of the center (300 to 3000 Hz) with 4 times the other's energy (6 dB),
 *    demodulated by the Weaver method and leveled by its own 0.3 s power.
 * Audio is 300 to 3000 Hz (fourth-order each way), clipped at 3, faded in and out over 15 ms where the carrier comes
 * and goes, and gently denoised (home's smoothed gain, never under 0.35).
 *
 * The carrier's offset tells AM and FM talkers apart; SSB has no carrier to read.
 */
import { Ddc } from '../trains.js';
import { fft, hann } from '../../fft.js';
import { Resampler, lowpassTaps, RealFir } from '../ham/filters.js';
import { ClipWriter, CLIP_RATE } from '../hamplus/clips.js';
import { ENV_MS } from '../hamplus/tracker.js';
import type { WatchProbe } from '../hamplus/engine.js';
import { RatioSpeech } from '../hamplus/speech.js';
import type { CbMode } from './plan.js';
import { Biquad, butter4, run, twice, CarrierTracker, Denoiser, median, FLAT_FM, LineNotch, NOTCH_CLEAR_HZ, SQUELCH_DB } from './carrier.js';

export const CB_PROBE_RATE = 16_000;
/** The Weaver shift: a sideband 300 to 3000 Hz from the carrier is centered at 1650 Hz and kept 1350 Hz either side. */
export const SSB_MID_HZ = 1_650, SSB_HALF_HZ = 1_350;
/** Single sideband: one side holds this many times the other's energy (6 dB). */
export const SSB_RATIO = 4;
/** A carrier stands 15 dB over the median through this share of its keyup, once held a second (real AM 0.84 to 1, a
 *  sideband voice followed as if a carrier 0.34 to 0.81, on home's recordings). */
export const CARRIER_HELD = 0.6;
/** Our sideband guard: steady lines stand [TONE_DB] over their neighborhood, and may hold at most [TONE_SHARE]. */
export const TONE_DB = 20, TONE_SHARE = 0.5;
const TONE_X = Math.pow(10, TONE_DB / 10), SIDE_BAND = 25, SIDE_FROM = 300, SIDE_TO = 3_000, EDGE_FROM = 3_200, EDGE_TO = 4_800, TONE_CARRIER_HZ = 40;
/** SSB's level is its power over this long (s). */
export const SSB_AGC_S = 0.3;
/** Audio is clipped here (the carrier's level is 1), and faded in and out over this long (ms). */
export const AUDIO_CLIP = 3, RAMP_MS = 15;
/** How the demodulated audio is scaled to the clip and the speaker. */
const OUT_GAIN = 0.35;
const OFF_WIN_MS = 100;

export interface CbVotes { AM: number; FM: number; USB: number; LSB: number }

export class CbProbe implements WatchProbe {
  readonly ddc = new Ddc(4_500, CB_PROBE_RATE, 63);
  readonly fs: number;
  readonly clip = new ClipWriter();
  readonly means: number[] = []; readonly env: number[] = [];
  oi = new Float32Array(0); oq = new Float32Array(0); au = new Float32Array(0); au2 = new Float32Array(0); a8 = new Float32Array(0); a48 = new Float32Array(0);
  out48 = 0; levelDb = -90; cw0 = '';
  /** The mode set by hand ('' lets the measurement choose), the clarifier for SSB (Hz), and the mode before any measurement. */
  override: CbMode | '' = ''; clarHz = 0; guess: CbMode = 'AM';
  /** The channel's noise as the engine measures it (kept for the engine; home's method needs no noise figure). */
  noiseRatio = 0; noiseVarIn = 0;
  /** How each 10 ms of the transmission measured, for the card and the tests. */
  readonly votes: CbVotes = { AM: 0, FM: 0, USB: 0, LSB: 0 };
  /** The carrier, found and held. */
  readonly trk: CarrierTracker;
  /** Whether the audio carries a voice (speech.ts): only this measure, on what the demodulator already makes, is new
   *  here; the demodulator and its audio are home's. */
  readonly speech: RatioSpeech;
  private readonly spI: Biquad[]; private readonly spQ: Biquad[];
  private notches: LineNotch[] = []; private otherNotches: LineNotch[] = []; private pending: number[] = []; private notchedFor = NaN; private sw = -1;
  private readonly to8: Resampler; private readonly to48: Resampler;
  private readonly uI: RealFir; private readonly uQ: RealFir; private readonly lI: RealFir; private readonly lQ: RealFir;
  private ub = { i: new Float32Array(0), q: new Float32Array(0), li: new Float32Array(0), lq: new Float32Array(0), ti: new Float32Array(0), tq: new Float32Array(0), si: new Float32Array(0), sq: new Float32Array(0) };
  private readonly hp: Biquad[]; private readonly lpA: Biquad[]; private readonly ssbP: Biquad[]; private readonly den: Denoiser;
  private pi = 1; private pq = 0; private wu = 0; private wl = 0; private wb = 0; private gate = 0; private lastHop = 0;
  private eS = 0; private eS2 = 0; private eN = 0;
  /** The envelope's spread over its mean while the carrier was on (home's FM test: under 0.12). */
  flatness(): number {
    // over the last two seconds (the first moments after a notch is set leave a line's beat in it)
    let S = this.eS, S2 = this.eS2, N = this.eN; for (const b of this.eBlocks) { S += b[0]; S2 += b[1]; N += b[2]; }
    if (N < 100) return NaN; const m = S / N; return Math.sqrt(Math.max(0, S2 / N - m * m)) / (m + 1e-9);
  }
  private eBlocks: [number, number, number][] = [];
 private notCarrier = false;
  private readonly dl: Float32Array; private dn = 0;
  /** SSB and FM leveled as home does: over its power over 0.3 s, times 3, the audio held back to center the level on it. */
  private agcDelay(x: number): number {
    const p = run(this.ssbP, x * x), y = this.dl[this.dn]; this.dl[this.dn] = x; if (++this.dn >= this.dl.length) this.dn = 0;
    return y / (Math.sqrt(Math.max(1e-12, p)) * 3);
  }
  private offAcc = 0; private offN = 0; private envAcc = 0; private envN = 0; private hpE = 0; private pow = 0; private powN = 0;

  constructor(inRate: number, readonly offsetHz: number) {
    this.ddc.reset(inRate); this.ddc.offsetHz = offsetHz; this.fs = this.ddc.outRate;
    const w = lowpassTaps(SSB_HALF_HZ / this.fs, 63);
    this.uI = new RealFir(w); this.uQ = new RealFir(w); this.lI = new RealFir(w); this.lQ = new RealFir(w);
    this.to8 = new Resampler(CLIP_RATE / this.fs); this.to48 = new Resampler(48_000 / this.fs);
    this.trk = new CarrierTracker(this.fs);
    // home's filters run forward and back, squaring their response; here each runs twice forward
    this.hp = [...butter4('hp', 300, this.fs), ...butter4('hp', 300, this.fs)]; this.lpA = [...butter4('lp', 3_000, this.fs), ...butter4('lp', 3_000, this.fs)];
    this.ssbP = twice('lp', 1 / SSB_AGC_S, this.fs);
    // a two-pole Butterworth's delay at low frequencies is sqrt(2) / (2 pi fc), twice that here
    this.dl = new Float32Array(Math.max(1, Math.round(2 * this.fs * Math.SQRT2 / (2 * Math.PI / SSB_AGC_S))));
    this.den = new Denoiser(this.fs);
    this.speech = new RatioSpeech(this.fs);
    this.spI = [...butter4('hp', 300, this.fs), ...butter4('lp', 3_000, this.fs)]; this.spQ = [...butter4('hp', 300, this.fs), ...butter4('lp', 3_000, this.fs)];

  }
  retune(offsetHz: number): void { this.ddc.offsetHz = offsetHz; }
  /** The lines the engine measured on the idle channel: notched once the carrier is known, and never taken for one. */
  setNotches(hz: number[]): void { this.coarse = hz; this.pending = []; this.trk.ignore = []; this.notches = []; this.notchedFor = NaN; this.lineN = 0; }
  /**
   * The engine reads idle lines on bins of 150 to 250 Hz; a 12 Hz notch needs them to a few Hz, as home measured them
   * (1 s spectra). The first half second here is looked at in one spectrum (2 Hz bins), where a steady line is a sharp
   * peak whatever a voice does around it, and each line is put on the strongest bin within 150 Hz of the engine's
   * reading. Until then nothing is notched or ignored.
   */
  private coarse: number[] = []; private lineN = 0; private lineI = new Float32Array(0); private lineQ = new Float32Array(0);
  private refineLines(): void {
    const N = this.lineI.length, re = this.lineI.slice(), im = this.lineQ.slice(), w = hann(N);
    for (let k = 0; k < N; k++) { re[k] *= w[k]; im[k] *= w[k]; }
    fft(re, im);
    const bh = this.fs / N;
    this.pending = this.coarse.map(h => {
      let best = -1, bp = -1;
      for (let b = Math.round((h - 150) / bh); b <= Math.round((h + 150) / bh); b++) { const k = (b + N) % N, p = re[k] * re[k] + im[k] * im[k]; if (p > bp) { bp = p; best = b; } }
      return best * bh;
    });
    this.trk.ignore = this.pending; this.notchedFor = NaN;
  }
  get notchHz(): number[] { return this.notches.map(n => n.hz); }

  /**
   * Our guard on home's sideband rule, which the no-antenna recordings need: a receiver's own spurs come in bursts of
   * lines (on the Mac's HackRF, lines every 100 Hz 221.5 kHz below the tuning, 60 dB over the noise, on for seconds),
   * and a burst of them on one side passes home's split as a sideband. A voice's harmonics wander with its pitch and
   * smear over tens of Hz in half a second; a spur's lines stay put to a Hz. So on fine spectra (2 Hz bins, each half
   * second) the share of the 300 to 3000 Hz power over the noise that sits in bins [TONE_DB] over their neighborhood
   * must stay under [TONE_SHARE] for the keyup to be taken for single sideband.
   */
  private tI = new Float32Array(0); private tQ = new Float32Array(0); private tN = 0;
  private toneIn = 0; private toneAll = 0;
  /** The power over the noise a Hz, 300 to 3000 Hz and 3200 to 4800 Hz from the center, above (0) and below (1). */
  private readonly edgeIn = [0, 0]; private readonly edgeOut = [0, 0];
  /** The share of the sidebands' power in steady lines (the followed carrier left out), NaN before a half second. */
  get toneShare(): number { return this.toneAll > 0 ? this.toneIn / this.toneAll : NaN; }
  /** The power over the noise 300 to 3000 Hz above and below the followed carrier, over the keyup, and the noise. */
  private readonly carSide = [0, 0]; private carNoise = 0; private carBins = 0;
  /** Whether the followed carrier's sidebands differ by [SSB_RATIO] or more, the louder over the noise. */
  lopsided(): boolean {
    const [u, l] = this.carSide, big = Math.max(u, l);
    return this.carBins > 0 && big >= SSB_RATIO * Math.min(u, l) && big >= this.carNoise * this.carBins;
  }
  /** Whether [side] holds more power a Hz just past the voice band (3.2 to 4.8 kHz) than in it: the skirt of something
   *  strong beyond the band, not a voice (a transmitter's audio stops near 3 kHz). */
  skirt(side: 'USB' | 'LSB'): boolean { const j = side === 'USB' ? 0 : 1; return this.edgeOut[j] > this.edgeIn[j]; }
  private toneBlock(): void {
    const N = this.tI.length, re = this.tI.slice(), im = this.tQ.slice(), w = hann(N);
    for (let k = 0; k < N; k++) { re[k] *= w[k]; im[k] *= w[k]; }
    fft(re, im);
    const bh = this.fs / N, G = Math.max(1, Math.round(SIDE_BAND / bh)), lo = Math.round(SIDE_FROM / bh), hi = Math.round(SIDE_TO / bh);
    const o0 = Math.round(EDGE_FROM / bh), o1 = Math.min(N / 2 - 1, Math.round(EDGE_TO / bh));
    const car = this.trk.have ? this.trk.hz : NaN;
    for (const sgn of [1, -1]) {
      // band medians, then each bin against the median of the bands around it
      const pw: number[] = []; for (let b = lo; b <= hi; b++) { const k = (sgn * b + N) % N; pw.push(re[k] * re[k] + im[k] * im[k]); }
      const bm: number[] = []; for (let g = 0; g < pw.length; g += G) bm.push(median(pw.slice(g, g + G)));
      const noise = [...bm].sort((x, y) => x - y)[Math.floor(bm.length / 5)] || 1e-20;
      let inP = 0;
      for (let b = 0; b < pw.length; b++) {
        const x = Math.max(0, pw[b] - noise); inP += x;
        if (Math.abs(sgn * (b + lo) * bh - car) <= TONE_CARRIER_HZ) continue;
        const g = Math.floor(b / G), near = median(bm.slice(Math.max(0, g - 4), g + 5));
        this.toneAll += x; if (pw[b] >= near * TONE_X) this.toneIn += x;
      }
      let outP = 0; for (let b = o0; b <= o1; b++) { const k = (sgn * b + N) % N; outP += Math.max(0, re[k] * re[k] + im[k] * im[k] - noise); }
      const j = sgn > 0 ? 0 : 1; this.edgeIn[j] += inP / pw.length; this.edgeOut[j] += outP / Math.max(1, o1 - o0 + 1);
      // around the carrier
      if (this.trk.have) {
        const c = Math.round(car / bh); let sum = 0, nb = 0;
        // (a steady line, 20 dB over the bands around it, left out: a comb line beside a station is not its sideband)
        const cp: number[] = []; for (let b = lo; b <= hi; b++) { const k = ((c + sgn * b) % N + N) % N; cp.push(re[k] * re[k] + im[k] * im[k]); }
        const cm: number[] = []; for (let g = 0; g < cp.length; g += G) cm.push(median(cp.slice(g, g + G)));
        for (let b = 0; b < cp.length; b++) { const g = Math.floor(b / G); nb++; if (cp[b] >= median(cm.slice(Math.max(0, g - 4), g + 5)) * TONE_X) continue; sum += Math.max(0, cp[b] - noise); }
        this.carSide[j] += sum; if (j === 0) { this.carNoise += noise; this.carBins = nb; }
      }
    }
  }
  /** What the measurement found: '' until a carrier is held or a sideband stands out. */
  measuredMode(): CbMode | '' {
    // a carrier is a station's when it stands 22 dB over the median through the keyup (home skips one under that: on
    // single sideband a held voice harmonic looks like a carrier, but a weak one)
    // and it stays: a carrier stands 15 dB over the median through nearly all of its keyup, while a voice harmonic on
    // single sideband (followed as if it were one) comes and goes with the syllables
    // (once a followed line has failed that, a new one is not taken for a carrier until it has held a second itself)
    // (and before a line has been held that second, a clear sideband while it is off says it is single sideband: a
    // voice harmonic comes and goes with the voice on one side, and home, deciding on the whole keyup, never took such
    // a line for a carrier)
    const t = this.trk, held = t.heldHops >= 100 ? t.onHops / t.heldHops : this.notCarrier ? 0 : 1;
    if (t.heldHops >= 100 && held < CARRIER_HELD) this.notCarrier = true;
    // (the split is home's, 300 to 3000 Hz either side, with its idle-line notches done another way, so the steady
    // lines of a nearby device, which home notched, cannot tip it: see CarrierTracker.side)
    const sideAll = t.side(false, SSB_RATIO), side = sideAll !== '';
    const sideOff = t.side(true, SSB_RATIO) !== '';
    const q = t.medianQ(), carrier = (t.have || t.log.length >= 10) && !(q < SQUELCH_DB) && held >= CARRIER_HELD && (t.heldHops >= 100 || !sideOff);
    // (and a carrier is a station's when its two sidebands are alike, as AM's are: a receiver's own spur burst has a
    // strongest line too, with its other lines on one side of it)
    if (carrier && !this.lopsided()) { const f = this.flatness(); return Number.isFinite(f) && f < FLAT_FM ? 'FM' : 'AM'; }
    if (side && !(this.toneShare >= TONE_SHARE) && !this.skirt(sideAll as 'USB' | 'LSB')) return sideAll;
    return '';
  }
  /** The mode demodulated now: by hand, else measured, else the channel's last. */
  mode(): CbMode { return this.override || this.measuredMode() || this.guess; }
  /** A readable station: a carrier standing 22 dB over the median through the keyup, or a clear sideband. */
  readable(): boolean {
    const m = this.measuredMode();
    if (m === 'AM' || m === 'FM') return this.trk.medianQ() >= SQUELCH_DB;
    return m === 'USB' || m === 'LSB';
  }

  push(fi: Float32Array, fq: Float32Array, n: number, listen: boolean): void {
    const max = this.ddc.maxOut(n);
    if (this.oi.length < max) {
      this.oi = new Float32Array(max); this.oq = new Float32Array(max); this.au = new Float32Array(max); this.au2 = new Float32Array(max); this.a8 = new Float32Array(max); this.a48 = new Float32Array(Math.ceil(48_000 / this.fs * max) + 16);
      this.ub = { i: new Float32Array(max), q: new Float32Array(max), li: new Float32Array(max), lq: new Float32Array(max), ti: new Float32Array(max), tq: new Float32Array(max), si: new Float32Array(max), sq: new Float32Array(max) };
    }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq), fs = this.fs, oi = this.oi, oq = this.oq, u = this.ub, trk = this.trk;
    // every half second, a fine spectrum (2 Hz bins) for the tone share
    if (!this.tI.length) { let n2 = 1; while (n2 < fs / 2) n2 <<= 1; this.tI = new Float32Array(n2); this.tQ = new Float32Array(n2); }
    for (let i = 0; i < m; i++) { this.tI[this.tN] = oi[i]; this.tQ[this.tN] = oq[i]; if (++this.tN >= this.tI.length) { this.toneBlock(); this.tN = 0; } }
    if (this.coarse.length && this.lineN >= 0) {
      if (!this.lineI.length) { let n2 = 1; while (n2 < fs / 2) n2 <<= 1; this.lineI = new Float32Array(n2); this.lineQ = new Float32Array(n2); }
      for (let i = 0; i < m && this.lineN < this.lineI.length; i++) { this.lineI[this.lineN] = oi[i]; this.lineQ[this.lineN] = oq[i]; this.lineN++; }
      if (this.lineN >= this.lineI.length) { this.refineLines(); this.lineN = -1; }
    }
    const ssb = this.measuredMode() === 'USB' || this.measuredMode() === 'LSB';
    if (ssb && this.notchedFor !== -1e9) {
      // single sideband: only the idle lines (what looked like other carriers were voice)
      this.notchedFor = -1e9; this.notches = this.pending.map(h => new LineNotch(h, fs)); this.otherNotches = [];
    } else if (!ssb && trk.have && (Number.isNaN(this.notchedFor) || this.notchedFor === -1e9 || trk.switches !== this.sw)) {
      // the idle lines, now the carrier is known (again when it changes), and the other stations' carriers
      this.notchedFor = trk.hz; this.sw = trk.switches;
      this.notches = this.pending.filter(h => Math.abs(h - trk.hz) > NOTCH_CLEAR_HZ).map(h => new LineNotch(h, fs));
      this.otherNotches = trk.others.map(h => new LineNotch(h, fs));
    }
    for (const c of this.notches) c.run(oi, oq, m);
    // the envelope's spread while the carrier is on, read before the other stations' carriers are notched (taking a
    // line out of an FM signal would make its envelope move)
    if (this.trk.have && this.trk.onNow) for (let i = 0; i < m; i++) { const e = Math.hypot(oi[i], oq[i]); this.eS += e; this.eS2 += e * e; this.eN++; }
    if (this.eN >= fs / 10) { this.eBlocks.push([this.eS, this.eS2, this.eN]); if (this.eBlocks.length > 20) this.eBlocks.shift(); this.eS = 0; this.eS2 = 0; this.eN = 0; }
    for (const c of this.otherNotches) c.run(oi, oq, m);
    // the Weaver shifts: upper sideband down by clarifier + 1650 Hz, lower by clarifier - 1650 Hz
    const twoPi = 2 * Math.PI, du = -twoPi * (this.clarHz + SSB_MID_HZ) / fs, dl = -twoPi * (this.clarHz - SSB_MID_HZ) / fs;
    for (let i = 0; i < m; i++) {
      const a = oi[i], b = oq[i], cu = Math.cos(this.wu), su = Math.sin(this.wu), cl = Math.cos(this.wl), sl = Math.sin(this.wl);
      u.i[i] = a * cu - b * su; u.q[i] = a * su + b * cu; u.li[i] = a * cl - b * sl; u.lq[i] = a * sl + b * cl;
      this.wu += du; this.wl += dl;
    }
    this.wu %= twoPi; this.wl %= twoPi;
    this.uI.process(u.i, m, u.ti); this.uQ.process(u.q, m, u.tq); this.lI.process(u.li, m, u.si); this.lQ.process(u.lq, m, u.sq);
    let mode = this.mode();
    const au = this.au, win = Math.round(fs * OFF_WIN_MS / 1000), dbk = twoPi * SSB_MID_HZ / fs, rampN = fs * RAMP_MS / 1000;
    for (let i = 0; i < m; i++) {
      const a = oi[i], b = oq[i];
      const f = Math.atan2(b * this.pi - a * this.pq, a * this.pi + b * this.pq);
      this.pi = a; this.pq = b;
      this.offAcc += f; if (++this.offN >= win) { this.means.push(this.offAcc / this.offN * fs / twoPi); this.offAcc = 0; this.offN = 0; }
      trk.step(a, b);
      if ((i & 63) === 0) mode = this.mode();
      let v = 0, on = true;
      if (mode === 'AM' || mode === 'FM') {
        on = trk.have && trk.present;
        // FM: the phase step, leveled by its own power over 0.3 s as SSB is
        if (mode === 'FM') v = this.agcDelay(f);
        else {
          // carrier-locked: the part in line with the carrier phasor, over its level (floored at 0.15 of its middle)
          const cm = Math.hypot(trk.cr, trk.ci), L = Math.max(trk.lvl, trk.floor());
          v = cm > 0 && L > 0 ? (trk.br * trk.cr + trk.bi * trk.ci) / cm / L : 0;
        }
      } else {
        // the sideband's real part, back up by 1650 Hz, over its own power over 0.3 s (times 3, as home's)
        const s = mode === 'USB' ? 1 : -1, c = Math.cos(this.wb), sn = Math.sin(s * this.wb);
        const x = mode === 'USB' ? u.ti[i] * c - u.tq[i] * sn : u.si[i] * c - u.sq[i] * sn;
        const pu = u.ti[i] * u.ti[i] + u.tq[i] * u.tq[i], pl = u.si[i] * u.si[i] + u.sq[i] * u.sq[i];
        if (!(trk.have && trk.present)) this.speech.push(mode === 'USB' ? pu : pl, mode === 'USB' ? pl : pu, 2);
        this.wb += dbk;
        // home levels it by its power over 0.3 s on both sides of each sample; streaming, the audio is held back by
        // the smoothing's own delay so its level is centered on it
        v = this.agcDelay(x);
      }
      // the speech measure, while a carrier is held whatever the mode: the signal in line with it and at right angles
      if (trk.have && trk.present) {
        const cm = Math.hypot(trk.cr, trk.ci), L = Math.max(trk.lvl, trk.floor());
        const x = cm > 0 && L > 0 ? (trk.br * trk.cr + trk.bi * trk.ci) / cm / L : 0, y = cm > 0 && L > 0 ? (trk.bi * trk.cr - trk.br * trk.ci) / cm / L : 0;
        const si = run(this.spI, x), sq = run(this.spQ, y); this.speech.push(si * si, sq * sq, 1);
      } else if (mode === 'AM' || mode === 'FM') this.speech.push(0, 0, 0);
      // 300 to 3000 Hz, clipped at 3, faded in and out where the carrier comes and goes
      for (const h of this.hp) v = h.step(v);
      for (const h of this.lpA) v = h.step(v);
      v = Math.max(-AUDIO_CLIP, Math.min(AUDIO_CLIP, v));
      this.gate = on ? Math.min(rampN, this.gate + 1) : Math.max(0, this.gate - 1);
      const g = 0.5 - 0.5 * Math.cos(Math.PI * this.gate / rampN);
      au[i] = v * g * OUT_GAIN;
      this.pow += a * a + b * b; this.powN++;
    }
    this.wb %= twoPi;
    // a measurement a 10 ms, for the card and the tests
    if (trk.log.length !== this.lastHop) { const k = trk.log.length - this.lastHop; this.lastHop = trk.log.length; const md = this.measuredMode(); if (md) this.votes[md] += k; }
    else { const md = this.measuredMode(); if (md === 'USB' || md === 'LSB') this.votes[md]++; }
    this.den.process(au, m, this.au2);
    const a2 = this.au2, envWin = Math.round(fs * ENV_MS / 1000), hpa = 1 - Math.exp(-2 * Math.PI * 300 / fs);
    for (let i = 0; i < m; i++) {
      this.hpE += hpa * (a2[i] - this.hpE); const vv = a2[i] - this.hpE;
      this.envAcc += vv * vv; if (++this.envN >= envWin) { this.env.push(Math.sqrt(this.envAcc / this.envN)); this.envAcc = 0; this.envN = 0; }
    }
    const k8 = this.to8.process(a2, m, this.a8); this.clip.push(this.a8, k8);
    this.out48 = listen ? this.to48.process(a2, m, this.a48) : 0;
    if (this.powN > fs / 10) { this.levelDb = 10 * Math.log10(this.pow / this.powN + 1e-9); this.pow = 0; this.powN = 0; }
  }

  /** Carrier offset: the held carrier's median frequency; for FM without one, the discriminator's; none for SSB. */
  offset(skip = 0): { hz: number; sd: number } {
    const m = this.override || this.measuredMode();
    if (m === 'USB' || m === 'LSB') return { hz: NaN, sd: 0 };
    const t = this.trk.offset(); if (Number.isFinite(t)) return { hz: t, sd: 0 };
    const ms = this.means.slice(skip); if (ms.length < 3) return { hz: NaN, sd: 0 };
    const s = [...ms].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
    const q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
    return { hz: med, sd: (q3 - q1) / 1.35 / Math.sqrt(ms.length) };
  }
  tone(): number { return 0; }
  dcs(): number { return 0; }
  /** The transmission ended: its kept audio fades out over 15 ms. */
  end(): void { this.clip.fadeOut(Math.round(CLIP_RATE * RAMP_MS / 1000)); }
}
