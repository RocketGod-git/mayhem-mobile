/**
 * One CB channel's demodulator: AM, FM, USB or LSB, chosen by hand or by what the transmission measures.
 *
 * Every 100 ms block of the channel (down-converted to about 16 kS/s) is measured three ways:
 *  - the carrier: the power that stays put at the carrier frequency (10 ms averages of the signal turned to DC by the
 *    carrier offset the discriminator reads), as a share of all the power. AM keeps at least two thirds of its power
 *    in the carrier; single sideband has none;
 *  - what is left once the carrier is taken out, split into the part in line with the carrier and the part across it.
 *    AM moves only the carrier's size, so its remainder lies in line; FM moves its phase, across; single sideband
 *    (and noise) turns all the way round, half and half. A single sideband tone looks like a carrier, this does not;
 *  - the envelope: how much |z| moves in the voice band against its mean, less what the channel's noise alone would
 *    move it. AM carries the voice there; FM keeps a constant envelope;
 *  - the sidebands: the power 300 to 3000 Hz above the carrier against the same below (each by the Weaver method, the
 *    same filters that demodulate SSB). Single sideband has its energy on one side; AM and FM on both.
 * A block with the voice in it votes, and the transmission's mode is the one with most votes.
 *
 * The carrier offset (the median of the discriminator's 100 ms means) tells AM and FM talkers apart, as HAM+ does for
 * FM; SSB has no carrier to read, so its offset is not measured.
 */
import { Ddc } from '../trains.js';
import { RealFir, Resampler, lowpassTaps } from '../ham/filters.js';
import { ClipWriter, CLIP_RATE } from '../hamplus/clips.js';
import { ENV_MS } from '../hamplus/tracker.js';
import type { WatchProbe } from '../hamplus/engine.js';
import type { CbMode } from './plan.js';

export const CB_PROBE_RATE = 16_000;
/** The Weaver shift: a sideband 300 to 3000 Hz from the carrier is centered at 1650 Hz and kept 1350 Hz either side. */
export const SSB_MID_HZ = 1_650, SSB_HALF_HZ = 1_350;
/** Votes: SSB has this much more on one side (dB), and its remainder is not in line with a carrier. */
export const SSB_SIDE_DB = 10;
/** SSB's envelope follows the voice all the way (a carrier between words does not, so an AM pause casts no SSB vote). */
export const SSB_ENV_MIN = 0.25;
/** FM: the envelope moves less than this (beyond noise) while the discriminator swings more than this (Hz rms). */
export const FM_ENV_MAX = 0.1, FM_DEV_MIN = 350;
/** AM: at least this share in the carrier, the envelope moving at least this much beyond noise, and at least this share
 *  of the rest in line with the carrier. */
export const AM_CARRIER_MIN = 0.6, AM_ENV_MIN = 0.06, AM_INLINE_MIN = 0.65;
/** A block votes only when its power is at least this share of the transmission's strongest block (SSB pauses do not). */
const VOTE_POWER = 0.3;
const BLOCK_MS = 100, SUB_MS = 10, OFF_WIN_MS = 100;

/**
 * Takes one steady line out of the channel: the line turned to DC and averaged (about 20 Hz wide) is its phasor, which
 * is turned back and subtracted. The phasor's own turning corrects the line's frequency, so a line read off an FFT bin
 * to within a few tens of Hz settles on it.
 */
export class LineCanceller {
  private w: number; private ph = 0; private cr = 0; private ci = 0; private n = 0; private lr = 0; private li = 0;
  private readonly a: number;
  constructor(readonly hz: number, fs: number) { this.w = 2 * Math.PI * hz / fs; this.a = 2 * Math.PI * 20 / fs; }
  run(xi: Float32Array, xq: Float32Array, m: number): void {
    let ph = this.ph, cr = this.cr, ci = this.ci; const a = this.a;
    for (let k = 0; k < m; k++) {
      const c = Math.cos(ph), s = Math.sin(ph), i = xi[k], q = xq[k];
      cr += a * (i * c + q * s - cr); ci += a * (q * c - i * s - ci);
      xi[k] = i - (cr * c - ci * s); xq[k] = q - (cr * s + ci * c);
      ph += this.w;
      if (++this.n >= 64) {
        // the phasor turning means the line sits a little off: move onto it, half the way each time
        this.n = 0;
        if (this.lr || this.li) { const d = Math.atan2(ci * this.lr - cr * this.li, cr * this.lr + ci * this.li); this.w += 0.5 * d / 64; }
        this.lr = cr; this.li = ci;
      }
    }
    this.ph = ph % (2 * Math.PI); this.cr = cr; this.ci = ci;
  }
}

export interface CbVotes { AM: number; FM: number; USB: number; LSB: number }

export class CbProbe implements WatchProbe {
  readonly ddc = new Ddc(4_500, CB_PROBE_RATE, 63);
  readonly fs: number;
  readonly clip = new ClipWriter();
  readonly means: number[] = []; readonly env: number[] = [];
  oi = new Float32Array(0); oq = new Float32Array(0); au = new Float32Array(0); au2 = new Float32Array(0); a8 = new Float32Array(0); a48 = new Float32Array(0);
  out48 = 0; levelDb = -90; cw0 = '';
  /** The mode set by hand ('' lets the measurement choose), the clarifier for SSB (Hz), and the mode before any vote. */
  override: CbMode | '' = ''; clarHz = 0; guess: CbMode = 'AM';
  /** Steady lines in the channel before this transmission (birdies), taken out of what is measured and heard. */
  private notches: LineCanceller[] = [];
  setNotches(hz: number[]): void { this.notches = hz.map(h => new LineCanceller(h, this.fs)); }
  get notchHz(): number[] { return this.notches.map(n => n.hz); }
  /** The channel's noise against its signal (linear), from the engine's measurement: what noise alone moves. */
  noiseRatio = 0;
  readonly votes: CbVotes = { AM: 0, FM: 0, USB: 0, LSB: 0 };
  /** The last block's measurements, for the tests and the card. */
  last = { carrier: 0, envAc: 0, devHz: 0, sideDb: 0, inline: 0 };
  private readonly lp: RealFir; private readonly to8: Resampler; private readonly to48: Resampler;
  private readonly uI: RealFir; private readonly uQ: RealFir; private readonly lI: RealFir; private readonly lQ: RealFir;
  private ub = { i: new Float32Array(0), q: new Float32Array(0), li: new Float32Array(0), lq: new Float32Array(0), ti: new Float32Array(0), tq: new Float32Array(0), si: new Float32Array(0), sq: new Float32Array(0) };
  private readonly de: number; private readonly hpa: number;
  private pi = 1; private pq = 0; private deemph = 0; private carRad = 0;
  // the Weaver oscillators: the shift down (by the clarifier and the sideband's middle) and back up for the audio
  private wu = 0; private wl = 0; private wb = 0;
  // AM: the carrier level the envelope is measured against
  private car = 0;
  // SSB: the audio level for the AGC
  private agc = 0;
  // per block: power, carrier, envelope and its voice-band motion, discriminator swing, the two sidebands
  private bN = 0; private bPow = 0; private bEnv = 0; private bEnvAc = 0; private bDev = 0; private bU = 0; private bL = 0; private bCar = 0; private bSubs = 0;
  private sI = 0; private sQ = 0; private sN = 0; private cph = 0; private cI = 0; private cQ = 0; private bIn = 0; private bAcross = 0;
  private envHpS = 0; private devHpS = 0; private peakPow = 0;
  private offAcc = 0; private offN = 0; private envAcc = 0; private envN = 0; private hpE = 0; private pow = 0; private powN = 0;

  constructor(rate: number, readonly offsetHz: number) {
    this.ddc.reset(rate); this.ddc.offsetHz = offsetHz; this.fs = this.ddc.outRate;
    this.lp = new RealFir(lowpassTaps(3_000 / this.fs, 47));
    const w = lowpassTaps(SSB_HALF_HZ / this.fs, 63);
    this.uI = new RealFir(w); this.uQ = new RealFir(w); this.lI = new RealFir(w); this.lQ = new RealFir(w);
    this.to8 = new Resampler(CLIP_RATE / this.fs); this.to48 = new Resampler(48_000 / this.fs);
    this.de = 1 - Math.exp(-1 / (this.fs * 530e-6));
    this.hpa = 1 - Math.exp(-2 * Math.PI * 150 / this.fs);
  }
  retune(offsetHz: number): void { this.ddc.offsetHz = offsetHz; }
  /** The mode demodulated now: by hand, else the most votes, else the channel's last mode. */
  mode(): CbMode {
    if (this.override) return this.override;
    const v = this.votes; let best: CbMode = this.guess, n = 1;
    for (const m of ['AM', 'FM', 'USB', 'LSB'] as CbMode[]) if (v[m] > n || (v[m] === n && m === this.guess)) { n = v[m]; best = m; }
    return best;
  }
  /** The mode the measurement found, '' before two blocks voted. */
  measuredMode(): CbMode | '' { const v = this.votes, t = v.AM + v.FM + v.USB + v.LSB; if (t < 2) return ''; let b: CbMode = 'AM'; for (const m of ['FM', 'USB', 'LSB'] as CbMode[]) if (v[m] > v[b]) b = m; return b; }

  push(fi: Float32Array, fq: Float32Array, n: number, listen: boolean): void {
    const max = this.ddc.maxOut(n);
    if (this.oi.length < max) {
      this.oi = new Float32Array(max); this.oq = new Float32Array(max); this.au = new Float32Array(max); this.au2 = new Float32Array(max); this.a8 = new Float32Array(max); this.a48 = new Float32Array(Math.ceil(48_000 / this.fs * max) + 16);
      this.ub = { i: new Float32Array(max), q: new Float32Array(max), li: new Float32Array(max), lq: new Float32Array(max), ti: new Float32Array(max), tq: new Float32Array(max), si: new Float32Array(max), sq: new Float32Array(max) };
    }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq), fs = this.fs, oi = this.oi, oq = this.oq, u = this.ub;
    for (const c of this.notches) c.run(oi, oq, m);
    // the Weaver shifts: upper sideband down by clarifier + 1650 Hz, lower by clarifier - 1650 Hz
    const twoPi = 2 * Math.PI, du = -twoPi * (this.clarHz + SSB_MID_HZ) / fs, dl = -twoPi * (this.clarHz - SSB_MID_HZ) / fs;
    for (let i = 0; i < m; i++) {
      const a = oi[i], b = oq[i];
      const cu = Math.cos(this.wu), su = Math.sin(this.wu), cl = Math.cos(this.wl), sl = Math.sin(this.wl);
      u.i[i] = a * cu - b * su; u.q[i] = a * su + b * cu; u.li[i] = a * cl - b * sl; u.lq[i] = a * sl + b * cl;
      this.wu += du; this.wl += dl;
    }
    this.wu %= twoPi; this.wl %= twoPi;
    this.uI.process(u.i, m, u.ti); this.uQ.process(u.q, m, u.tq); this.lI.process(u.li, m, u.si); this.lQ.process(u.lq, m, u.sq);
    const mode = this.mode(), au = this.au;
    const win = Math.round(fs * OFF_WIN_MS / 1000), blk = Math.round(fs * BLOCK_MS / 1000), sub = Math.round(fs * SUB_MS / 1000);
    const offRad = this.carRad;
    const dbk = twoPi * SSB_MID_HZ / fs;
    for (let i = 0; i < m; i++) {
      const a = oi[i], b = oq[i], p2 = a * a + b * b, e = Math.sqrt(p2);
      const f = Math.atan2(b * this.pi - a * this.pq, a * this.pi + b * this.pq);
      this.pi = a; this.pq = b;
      this.offAcc += f; if (++this.offN >= win) { this.means.push(this.offAcc / this.offN * fs / twoPi); this.offAcc = 0; this.offN = 0; }
      // the block's measurements
      this.bPow += p2; this.bEnv += e;
      this.envHpS += this.hpa * (e - this.envHpS); const eh = e - this.envHpS; this.bEnvAc += eh * eh;
      const fh = Math.max(-6_000, Math.min(6_000, f * fs / twoPi));
      this.devHpS += this.hpa * (fh - this.devHpS); const dh = fh - this.devHpS; this.bDev += dh * dh;
      this.bU += u.ti[i] * u.ti[i] + u.tq[i] * u.tq[i]; this.bL += u.si[i] * u.si[i] + u.sq[i] * u.sq[i];
      // 10 ms averages of the signal turned to DC at the carrier: what stays put is the carrier
      const cc = Math.cos(this.cph), cs = Math.sin(this.cph); this.cph -= offRad;
      const zr = a * cc - b * cs, zi = a * cs + b * cc;
      this.sI += zr; this.sQ += zi;
      // the remainder against the last 10 ms carrier: in line with it, and across it
      const cm = Math.hypot(this.cI, this.cQ);
      if (cm > 0) { const rI = zr - this.cI, rQ = zi - this.cQ, pin = (rI * this.cI + rQ * this.cQ) / cm, pac = (rQ * this.cI - rI * this.cQ) / cm; this.bIn += pin * pin; this.bAcross += pac * pac; }
      if (++this.sN >= sub) { this.cI = this.sI / this.sN; this.cQ = this.sQ / this.sN; this.bCar += this.cI * this.cI + this.cQ * this.cQ; this.bSubs++; this.sI = 0; this.sQ = 0; this.sN = 0; }
      if (++this.bN >= blk) this.endBlock();
      // the audio, by the mode
      let v: number;
      if (mode === 'FM') { this.deemph += this.de * (f - this.deemph); v = this.deemph * 0.4; }
      else if (mode === 'AM') {
        this.car += (this.car ? 0.002 : 1) * (e - this.car);
        v = this.car > 1e-3 ? (e - this.car) / this.car * 0.5 : 0;
      } else {
        // back up by 1650 Hz and take the real part: the sideband's audio, 300 to 3000 Hz
        const s = mode === 'USB' ? 1 : -1, c = Math.cos(this.wb), sn = Math.sin(s * this.wb);
        const x = mode === 'USB' ? u.ti[i] * c - u.tq[i] * sn : u.si[i] * c - u.sq[i] * sn;
        this.wb += dbk;
        const ax = Math.abs(x); this.agc = ax > this.agc ? this.agc + 0.05 * (ax - this.agc) : this.agc * (1 - 2 / fs);
        v = x * 0.35 / Math.max(0.5, this.agc);
      }
      au[i] = v;
    }
    this.wb %= twoPi; this.cph %= twoPi;

    this.lp.process(au, m, this.au2);
    const a2 = this.au2, envWin = Math.round(fs * ENV_MS / 1000), hpa = 1 - Math.exp(-2 * Math.PI * 300 / fs);
    for (let i = 0; i < m; i++) {
      this.hpE += hpa * (a2[i] - this.hpE); const v = a2[i] - this.hpE;
      this.envAcc += v * v; if (++this.envN >= envWin) { this.env.push(Math.sqrt(this.envAcc / this.envN)); this.envAcc = 0; this.envN = 0; }
      this.pow += oi[i] * oi[i] + oq[i] * oq[i]; this.powN++;
    }
    const k8 = this.to8.process(a2, m, this.a8); this.clip.push(this.a8, k8);
    this.out48 = listen ? this.to48.process(a2, m, this.a48) : 0;
    if (this.powN > fs / 10) { this.levelDb = 10 * Math.log10(this.pow / this.powN + 1e-9); this.pow = 0; this.powN = 0; }
  }

  /** One 100 ms block measured: the carrier's share, the envelope's motion beyond noise, the swing, the sidebands; its vote. */
  private endBlock(): void {
    const n = this.bN, pow = this.bPow / n, envM = this.bEnv / n;
    const carrier = this.bSubs ? Math.min(1, this.bCar / this.bSubs / Math.max(1e-9, pow)) : 0;
    // the noise alone moves a constant envelope by about sqrt(noise / 2) of its mean
    const envAc2 = this.bEnvAc / n / Math.max(1e-9, envM * envM) - this.noiseRatio / 2;
    const envAc = Math.sqrt(Math.max(0, envAc2)), devHz = Math.sqrt(this.bDev / n);
    const sideDb = 10 * Math.log10((this.bU + 1e-9) / (this.bL + 1e-9));
    const inline = this.bIn + this.bAcross > 0 ? this.bIn / (this.bIn + this.bAcross) : 0.5;
    this.last = { carrier, envAc, devHz, sideDb, inline };
    this.peakPow = Math.max(this.peakPow, pow);
    if (pow >= VOTE_POWER * this.peakPow) {
      const v = this.votes;
      if (carrier >= AM_CARRIER_MIN && envAc >= AM_ENV_MIN && inline >= AM_INLINE_MIN) v.AM++;
      else if (envAc < FM_ENV_MAX && devHz > FM_DEV_MIN && this.noiseRatio < 0.2) v.FM++;
      else if (Math.abs(sideDb) > SSB_SIDE_DB && envAc >= SSB_ENV_MIN && inline < AM_INLINE_MIN) { if (sideDb > 0) v.USB++; else v.LSB++; }
    }
    // the carrier the next block is turned to DC by: the median of the last second's discriminator means
    const rec = this.means.slice(-10).sort((a, b) => a - b);
    this.carRad = rec.length ? 2 * Math.PI * rec[Math.floor(rec.length / 2)] / this.fs : 0;
    this.bN = 0; this.bPow = 0; this.bEnv = 0; this.bEnvAc = 0; this.bDev = 0; this.bU = 0; this.bL = 0; this.bCar = 0; this.bSubs = 0; this.bIn = 0; this.bAcross = 0;
  }

  /** Carrier offset: the median of the 100 ms means and their spread; none for SSB, which has no carrier. */
  offset(skip = 0): { hz: number; sd: number } {
    const m = this.override || this.measuredMode();
    if (m === 'USB' || m === 'LSB') return { hz: NaN, sd: 0 };
    const ms = this.means.slice(skip); if (ms.length < 3) return { hz: NaN, sd: 0 };
    const s = [...ms].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
    const q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
    return { hz: med, sd: (q3 - q1) / 1.35 / Math.sqrt(ms.length) };
  }
  tone(): number { return 0; }
  dcs(): number { return 0; }
  end(): void { /* nothing buffered */ }
}
