/**
 * Home's CB demodulator, the one the owner signed off by ear ("holds well now"), in streaming form. Home works a
 * keyup at a time on a recording; here the same steps run as the samples come, each 10 ms:
 *  - the spectrum of the last 20 ms (Hann, zero-padded to about 6 Hz a bin) within 2.8 kHz of the center, its
 *    strongest bin and how far it stands over the median (q);
 *  - finding: over the first half second, the frequencies (to 10 Hz) of the bins standing 20 dB and more are counted;
 *    a station's carrier is one held for 8 % of those (or more), up to three of them 40 Hz apart, never one within
 *    8 Hz of an idle line. The most held is taken and the others are notched and kept out of its search;
 *  - tracking: each 10 ms the strongest bin within 60 Hz of the carrier's last frequency (50 Hz clear of the others),
 *    moving the carrier there when it stands 15 dB over the median; a gap of up to 1.5 s is bridged, a longer one
 *    ends the keyup and the next one is found afresh;
 *  - AM: the signal turned down by the carrier (the median of its last five readings), the carrier phasor from a 40 Hz
 *    low-pass, audio = the part in line with it over the carrier's level (a 5 Hz low-pass, never under 0.15 of its
 *    middle: about 16 dB of gain at most). FM when the envelope is flat (spread under 0.12 of its mean);
 *  - readable: a carrier whose median q over the keyup is 22 dB or more (under that it was static to the ear);
 *  - no carrier: single sideband when one side of the center (300 to 3000 Hz) holds 4 times the other (6 dB).
 */
import { fft, hann } from '../../fft.js';

export const HOP_MS = 10, WIN_MS = 20, SEARCH_HZ = 2_800;
export const STRONG_DB = 20, HELD_SHARE = 0.08, CAND_APART_HZ = 40, MAX_CAND = 3, ON_LINE_HZ = 8;
export const FIND_MS = 500, TRACK_HZ = 60, OTHERS_HZ = 50, ON_DB = 15, BRIDGE_MS = 1_500;
/** The held carrier gone this long while another stands strong elsewhere: a new keyup, found at once (ms). */
export const NEXT_KEYUP_MS = 300;
export const SQUELCH_DB = 22, FLAT_FM = 0.12, LVL_FLOOR = 0.15;
/** Lines are notched 12 Hz wide, and never within 30 Hz of the carrier. */
export const NOTCH_HZ = 12, NOTCH_CLEAR_HZ = 30;
/** A notch keeps itself on its line within this far of where it was set (Hz). */
export const NOTCH_PULL_HZ = 25;

/** A two-pole Butterworth section, designed by the bilinear transform. */
export class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(kind: 'lp' | 'hp', hz: number, fs: number, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * hz / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
    if (kind === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
    else { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
/** Fourth-order Butterworth as two sections (Q 0.541 and 1.307). */
export const butter4 = (kind: 'lp' | 'hp', hz: number, fs: number) => [new Biquad(kind, hz, fs, 0.5412), new Biquad(kind, hz, fs, 1.3066)];
/** A two-pole Butterworth twice over: the response of home's filtfilt of one. */
export const twice = (kind: 'lp' | 'hp', hz: number, fs: number) => [new Biquad(kind, hz, fs), new Biquad(kind, hz, fs)];
/** A sample through a chain of sections. */
export const run = (fs: Biquad[], x: number) => { for (const f of fs) x = f.step(x); return x; };

/**
 * Takes one steady line out: the signal turned down by it, a 12 Hz two-pole low-pass of that subtracted, turned back.
 * Home's low-pass runs both ways over the recording, so it takes no phase and a line a few Hz off its frequency still
 * cancels; streaming it can only run forward, so the notch keeps itself on the line instead (by how fast the low-passed
 * line turns, every 64 samples, never more than 25 Hz from where it was set).
 */
export class LineNotch {
  private readonly li: Biquad; private readonly lq: Biquad; private ph = 0; private w: number;
  private n = 0; private pr = 0; private pq = 0; private readonly w0: number; private readonly wMax: number;
  constructor(public hz: number, private readonly fs: number) { this.li = new Biquad('lp', NOTCH_HZ, fs); this.lq = new Biquad('lp', NOTCH_HZ, fs); this.w = this.w0 = 2 * Math.PI * hz / fs; this.wMax = 2 * Math.PI * NOTCH_PULL_HZ / fs; }
  run(xi: Float32Array, xq: Float32Array, m: number): void {
    for (let k = 0; k < m; k++) {
      const c = Math.cos(this.ph), s = Math.sin(this.ph), i = xi[k], q = xq[k];
      const ui = i * c + q * s, uq = q * c - i * s, li = this.li.step(ui), lq = this.lq.step(uq);
      xi[k] = i - (li * c - lq * s); xq[k] = q - (li * s + lq * c);
      this.ph += this.w; if (this.ph > Math.PI) this.ph -= 2 * Math.PI; else if (this.ph < -Math.PI) this.ph += 2 * Math.PI;
      if (++this.n >= 64) {
        this.n = 0;
        if (this.pr || this.pq) { const d = Math.atan2(lq * this.pr - li * this.pq, li * this.pr + lq * this.pq); this.w = Math.max(this.w0 - this.wMax, Math.min(this.w0 + this.wMax, this.w + 0.3 * d / 64)); this.hz = this.w * this.fs / (2 * Math.PI); }
        this.pr = li; this.pq = lq;
      }
    }
  }
}

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export class CarrierTracker {
  /** The carrier (Hz from the center), whether one is held, how often it changed, and each change (ms in, Hz). */
  hz = 0; have = false; switches = 0;
  readonly changes: { ms: number; hz: number }[] = [];
  /** The other stations' carriers found with it (notched), and the idle lines never taken for a carrier. */
  others: number[] = []; ignore: number[] = [];
  /** Present now (on, or inside a bridged gap), and on in the last 10 ms itself. */
  present = false; onNow = false;
  /** The signal turned down by the carrier, the carrier phasor (40 Hz) and its level (5 Hz), written each sample. */
  br = 0; bi = 0; cr = 0; ci = 0; lvl = 0;
  /** Each 10 ms while held and on: the carrier's frequency, its q and its level. */
  readonly log: number[] = []; readonly qs: number[] = []; readonly lvls: number[] = [];
  private envS = 0; private envS2 = 0; private envN = 0;
  private readonly B: number; private readonly HOP: number; private readonly NF: number; private readonly win: Float32Array;
  private readonly ri: Float32Array; private readonly rq: Float32Array; private rn = 0; private filled = 0; private n = 0; private ms = 0;
  /** Hops since the carrier was taken, and how many of them it stood 15 dB over the median. */
  heldHops = 0; onHops = 0;
  private find: number[] = []; private findHops = 0; private offMs = 0; private recent: number[] = []; private elsewhere = 0;
  private ph = 0; private w = 0; private floorV = 0;
  // each of home's low-passes is run forward and back (filtfilt), which squares its response: here each runs twice
  // forward, the same response with a delay instead of none
  private readonly carI: Biquad[]; private readonly carQ: Biquad[]; private readonly lvlF: Biquad[];
  constructor(private readonly fs: number) {
    this.B = Math.round(fs * WIN_MS / 1000); this.HOP = Math.round(fs * HOP_MS / 1000);
    let nf = 1; while (nf < fs / 6) nf <<= 1; this.NF = nf;
    this.win = hann(this.B); this.ri = new Float32Array(this.B); this.rq = new Float32Array(this.B);
    this.carI = twice('lp', 40, fs); this.carQ = twice('lp', 40, fs); this.lvlF = twice('lp', 5, fs);
  }
  get heldMs(): number { return this.have ? this.ms - (this.changes.length ? this.changes[this.changes.length - 1].ms : 0) : 0; }
  /** The level floor: 0.15 of the carrier's middle level over the keyup. */
  floor(): number { return this.floorV; }
  /** The keyup's median q, NaN before the carrier was on 10 times. */
  medianQ(): number { return this.medQ; }
  private medQ = NaN;
  /** The envelope's spread over its mean while the carrier was on. */
  flatness(): number { if (this.envN < 10) return NaN; const m = this.envS / this.envN; return Math.sqrt(Math.max(0, this.envS2 / this.envN - m * m)) / (m + 1e-9); }
  offset(): number { return this.log.length >= 3 ? median(this.log) : NaN; }

  step(i: number, q: number): void {
    this.ri[this.rn] = i; this.rq[this.rn] = q; if (++this.rn >= this.B) this.rn = 0; if (this.filled < this.B) this.filled++;
    const c = Math.cos(this.ph), s = Math.sin(this.ph);
    const br = i * c + q * s, bi = q * c - i * s; this.br = br; this.bi = bi;
    this.cr = run(this.carI, br); this.ci = run(this.carQ, bi);
    this.lvl = run(this.lvlF, Math.hypot(this.cr, this.ci));
    if (this.have && this.present) { const e = Math.hypot(br, bi); this.envS += e; this.envS2 += e * e; this.envN++; }
    this.ph += this.w; if (this.ph > Math.PI) this.ph -= 2 * Math.PI; else if (this.ph < -Math.PI) this.ph += 2 * Math.PI;
    if (++this.n >= this.HOP) { this.n = 0; this.hop(); }
  }

  /** The last 20 ms: the strongest bin within [lo, hi] Hz clear of [avoid] (±[clear] Hz), and q over the median of ±2.8 kHz. */
  private peak(lo: number, hi: number, avoid: number[], clear: number): { hz: number; q: number } {
    const N = this.NF, re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 0; k < this.B; k++) { const j = (this.rn + k) % this.B; re[k] = this.ri[j] * this.win[k]; im[k] = this.rq[j] * this.win[k]; }
    fft(re, im);
    const bh = this.fs / N, R = Math.floor(SEARCH_HZ / bh), pw: number[] = [];
    for (let b = -R; b <= R; b++) { const k = (b + N) % N; pw.push(re[k] * re[k] + im[k] * im[k]); }
    const med = median(pw) || 1e-20;
    let best = -1;
    for (let b = 0; b < pw.length; b++) {
      const f = (b - R) * bh; if (f < lo || f > hi || avoid.some(x => Math.abs(f - x) <= clear)) continue;
      if (best < 0 || pw[b] > pw[best]) best = b;
    }
    if (best < 0) return { hz: NaN, q: -99 };
    let d = 0;
    if (best > 0 && best < pw.length - 1) { const l = Math.log(pw[best - 1] + 1e-20), cc = Math.log(pw[best] + 1e-20), r = Math.log(pw[best + 1] + 1e-20); d = 0.5 * (l - r) / (l - 2 * cc + r - 1e-12); if (!Number.isFinite(d) || Math.abs(d) > 1) d = 0; }
    return { hz: (best - R + d) * bh, q: 10 * Math.log10(pw[best] / med) };
  }

  private hop(): void {
    this.ms += HOP_MS;
    if (this.filled < this.B) return;
    if (!this.have) {
      // finding: count the strong bins' frequencies over half a second
      const p = this.peak(-SEARCH_HZ, SEARCH_HZ, [], 0);
      this.findHops++;
      if (p.q > STRONG_DB) this.find.push(Math.round(p.hz / 10) * 10);
      const span = FIND_MS / HOP_MS;
      if (this.findHops >= span) {
        const strong = this.find;
        if (strong.length >= HELD_SHARE * this.findHops) {
          const count = new Map<number, number>(); for (const v of strong) count.set(v, (count.get(v) ?? 0) + 1);
          const cand: number[] = [];
          for (const [v, c] of [...count].sort((a, b) => b[1] - a[1])) if (c >= HELD_SHARE * strong.length && cand.every(x => Math.abs(v - x) > CAND_APART_HZ)) cand.push(v);
          const ok = cand.slice(0, MAX_CAND).filter(x => !this.ignore.some(l => Math.abs(x - l) < ON_LINE_HZ));
          if (ok.length) { this.take(ok[0], ok.slice(1)); return; }
        }
        // slide on: the oldest tenth goes, and the half second is looked at again
        this.find = this.find.slice(Math.ceil(this.find.length / 10)); this.findHops = Math.round(span * 0.9);
      }
      return;
    }
    // tracking: the strongest bin within 60 Hz of the carrier, 50 Hz clear of the others
    const p = this.peak(this.hz - TRACK_HZ, this.hz + TRACK_HZ, this.others, OTHERS_HZ);
    this.heldHops++;
    this.onNow = p.q > ON_DB;
    if (p.q > ON_DB) {
      this.onHops++;
      this.recent.push(p.hz); if (this.recent.length > 5) this.recent.shift();
      this.hz = p.hz; this.setW(median(this.recent));
      this.offMs = 0; this.present = true;
      this.log.push(p.hz); this.qs.push(p.q); this.lvls.push(this.lvl);
      if (this.qs.length >= 10 && (this.qs.length < 100 || this.qs.length % 10 === 0)) this.medQ = median(this.qs.slice(-1000));
      if (this.lvls.length % 10 === 1) this.floorV = LVL_FLOOR * median(this.lvls.slice(-500));
    } else {
      this.offMs += HOP_MS;
      // gone a while with another station strong elsewhere: the next keyup has started, find it now; with nothing
      // else there, a fade is bridged up to 1.5 s
      const o = this.peak(-SEARCH_HZ, SEARCH_HZ, [], 0);
      this.elsewhere = o.q > STRONG_DB && Math.abs(o.hz - this.hz) > TRACK_HZ ? this.elsewhere + HOP_MS : 0;
      if (this.offMs > BRIDGE_MS || this.elsewhere >= NEXT_KEYUP_MS) { this.present = this.elsewhere >= NEXT_KEYUP_MS && this.offMs <= BRIDGE_MS; this.have = false; this.find = []; this.findHops = 0; this.recent = []; this.elsewhere = 0; }
    }
  }
  private setW(hz: number): void { this.w = 2 * Math.PI * hz / this.fs; }
  private take(hz: number, others: number[]): void {
    if (this.changes.length) this.switches++;
    this.changes.push({ ms: this.ms, hz });
    this.heldHops = 0; this.onHops = 0;
    this.have = true; this.present = true; this.hz = hz; this.recent = [hz]; this.setW(hz); this.others = others; this.offMs = 0;
    this.find = []; this.findHops = 0;
  }
}

/**
 * Home's gentle noise reduction, streaming: half-overlapped frames of about 21 ms, each bin's noise the 20th
 * percentile of its power over the last 150 frames that had any, and a gain of 1 less that noise over the power
 * smoothed 3 bins by 5 frames, never under 0.35. Two frames late, so the smoothing is centered as home's is.
 */
export class Denoiser {
  private readonly N: number; private readonly H: number; private readonly win: Float32Array;
  private readonly inBuf: Float32Array; private inN = 0;
  private readonly frames: { re: Float32Array; im: Float32Array; p: Float32Array }[] = [];
  private readonly hist: Float32Array[] = [];
  private readonly ola: Float32Array; private out: number[] = []; private noise: Float32Array | null = null; private sinceNoise = 0;
  constructor(fs: number) {
    let n = 1; while (n < fs * 0.0213) n <<= 1; this.N = n; this.H = n >> 1;
    // the square root of a Hann window both ways sums to one at half overlap
    this.win = new Float32Array(n).map((_, k) => Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * k / n)));
    this.inBuf = new Float32Array(n); this.ola = new Float32Array(n);
  }
  process(x: Float32Array, m: number, y: Float32Array): void {
    for (let k = 0; k < m; k++) {
      this.inBuf[this.inN++] = x[k];
      if (this.inN === this.N) { this.frame(); this.inBuf.copyWithin(0, this.H); this.inN = this.H; }
    }
    const k = Math.min(m, this.out.length); for (let i = 0; i < k; i++) y[i] = this.out[i]; this.out.splice(0, k);
    // until the first frames are through, silence (a few tens of ms)
    for (let i = k; i < m; i++) y[i] = 0;
  }
  private frame(): void {
    const N = this.N, re = new Float32Array(N), im = new Float32Array(N), nb = N / 2 + 1, p = new Float32Array(nb);
    for (let k = 0; k < N; k++) re[k] = this.inBuf[k] * this.win[k];
    fft(re, im);
    let e = 0; for (let b = 0; b < nb; b++) { p[b] = re[b] * re[b] + im[b] * im[b]; e += p[b]; }
    if (e > 0) { this.hist.push(p); if (this.hist.length > 150) this.hist.shift(); }
    this.frames.push({ re, im, p }); if (this.frames.length > 5) this.frames.shift();
    if (this.frames.length < 3) return;
    // the frame two back, its power smoothed over the five frames around it and the bins beside
    const f = this.frames[this.frames.length - 3], g = new Float32Array(nb), col: number[] = [];
    // the noise per bin, worked out again every 10 frames (it moves slowly)
    if (!this.noise || ++this.sinceNoise >= 10) {
      this.sinceNoise = 0; this.noise = new Float32Array(nb);
      for (let b = 0; b < nb; b++) { col.length = 0; for (const h of this.hist) col.push(h[b]); col.sort((x, y) => x - y); this.noise[b] = col.length ? col[Math.floor(0.2 * (col.length - 1))] : 0; }
    }
    for (let b = 0; b < nb; b++) {
      const noise = this.noise[b];
      let s = 0, c = 0; for (const fr of this.frames) for (let d = -1; d <= 1; d++) { const j = b + d; if (j >= 0 && j < nb) { s += fr.p[j]; c++; } }
      g[b] = Math.max(1 - noise / (s / c + 1e-12), 0.35);
    }
    const ore = new Float32Array(N), oim = new Float32Array(N);
    for (let b = 0; b < nb; b++) { ore[b] = f.re[b] * g[b]; oim[b] = -f.im[b] * g[b]; if (b > 0 && b < N / 2) { ore[N - b] = f.re[N - b] * g[b]; oim[N - b] = -f.im[N - b] * g[b]; } }
    // the inverse transform, as the forward transform of the conjugate
    fft(ore, oim);
    for (let k = 0; k < N; k++) this.ola[k] += ore[k] / N * this.win[k];
    for (let k = 0; k < this.H; k++) this.out.push(this.ola[k]);
    this.ola.copyWithin(0, this.H); this.ola.fill(0, this.H);
  }
}
