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
import type { CbMode } from './plan.js';
import { Biquad, butter4, run, twice, CarrierTracker, Denoiser, FLAT_FM, LineNotch, NOTCH_CLEAR_HZ, SQUELCH_DB } from './carrier.js';

export const CB_PROBE_RATE = 16_000;
/** The Weaver shift: a sideband 300 to 3000 Hz from the carrier is centered at 1650 Hz and kept 1350 Hz either side. */
export const SSB_MID_HZ = 1_650, SSB_HALF_HZ = 1_350;
/** Single sideband: one side holds this many times the other's energy (6 dB). */
export const SSB_RATIO = 4;
/** A carrier stands 15 dB over the median through this share of its keyup, once held a second (real AM 0.84 to 1, a
 *  sideband voice followed as if a carrier 0.34 to 0.81, on home's recordings). */
export const CARRIER_HELD = 0.8;
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
  private notches: LineNotch[] = []; private otherNotches: LineNotch[] = []; private pending: number[] = []; private notchedFor = NaN; private sw = -1;
  private readonly to8: Resampler; private readonly to48: Resampler;
  private readonly uI: RealFir; private readonly uQ: RealFir; private readonly lI: RealFir; private readonly lQ: RealFir;
  private ub = { i: new Float32Array(0), q: new Float32Array(0), li: new Float32Array(0), lq: new Float32Array(0), ti: new Float32Array(0), tq: new Float32Array(0), si: new Float32Array(0), sq: new Float32Array(0) };
  private readonly hp: Biquad[]; private readonly lpA: Biquad[]; private readonly ssbP: Biquad[]; private readonly den: Denoiser;
  private pi = 1; private pq = 0; private wu = 0; private wl = 0; private wb = 0; private gate = 0; private lastHop = 0;
  private up = 0; private lo = 0; private upOff = 0; private loOff = 0; private nOff = 0; private eS = 0; private eS2 = 0; private eN = 0;
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
    const side = this.up + this.lo > 0 && Math.max(this.up, this.lo) >= SSB_RATIO * Math.min(this.up, this.lo);
    const sideOff = this.nOff >= this.fs * 0.1 && Math.max(this.upOff, this.loOff) >= SSB_RATIO * Math.min(this.upOff, this.loOff);
    const q = t.medianQ(), carrier = (t.have || t.log.length >= 10) && !(q < SQUELCH_DB) && held >= CARRIER_HELD && (t.heldHops >= 100 || !sideOff);
    if (carrier) { const f = this.flatness(); return Number.isFinite(f) && f < FLAT_FM ? 'FM' : 'AM'; }
    if (side) return this.up > this.lo ? 'USB' : 'LSB';
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
      // how the energy splits either side of the center, over the keyup
      this.up += u.ti[i] * u.ti[i] + u.tq[i] * u.tq[i]; this.lo += u.si[i] * u.si[i] + u.sq[i] * u.sq[i];
      // and while a followed line is off (a carrier, off frequency, would tip the split by itself)
      if (trk.have && !trk.onNow) { this.upOff += u.ti[i] * u.ti[i] + u.tq[i] * u.tq[i]; this.loOff += u.si[i] * u.si[i] + u.sq[i] * u.sq[i]; this.nOff++; }
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
        this.wb += dbk;
        // home levels it by its power over 0.3 s on both sides of each sample; streaming, the audio is held back by
        // the smoothing's own delay so its level is centered on it
        v = this.agcDelay(x);
      }
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
