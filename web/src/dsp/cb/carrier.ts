/**
 * The carrier an AM transmission is demodulated against: found, followed and held.
 *
 * Stations are seldom on the channel's center (a few hundred Hz off is common) and some key up as much as 2.4 kHz
 * high and slide down over a couple of seconds. So the carrier is found, not assumed: the strongest line within
 * 1.5 kHz below the center to 2.6 kHz above it in the last 250 ms is taken, then followed every 10 ms by how fast its phasor (the signal
 * turned to DC at the carrier and smoothed about 20 Hz wide) turns, by at most 60 Hz a step. Several stations on a
 * channel at once is common when the band is open; the one taken is held for its whole keyup, since flipping between
 * carriers is heard as a warble. Another is taken only when it is 10 dB stronger (checked every half second, and as
 * soon as the held one has faded 10 dB under its keyup's peak for 200 ms); after 1.5 s gone, whatever is strongest.
 * A shorter fade is bridged at the carrier's last frequency.
 */
import { fft, hann } from '../../fft.js';

const ACQ_N = 4096;
/**
 * Where a carrier is looked for (Hz from the center): stations sit a few hundred Hz off, and some key up as much as
 * 2.4 kHz high and slide down, none far low. A line 3 kHz below the center (a spur's) is never taken.
 */
export const ACQ_LOW_HZ = -1_500, ACQ_HIGH_HZ = 2_600;
export const ACQ_RANGE_HZ = 3_000, ACQ_MIN_DB = 10, TRACK_BW_HZ = 60, STEP_MS = 10;
/** The carrier phasor is smoothed this wide (Hz): narrow enough to keep a neighbor 100 Hz away out of it. */
export const PHASOR_HZ = 20;
/** While held, the carrier is checked against the others this often (ms). */
export const RECHECK_MS = 500;
/** How much of the measured offset each step corrects: enough to follow a key-up glide of 2 kHz a second. */
export const FLL_GAIN = 0.8;
export const LOST_DB = 10, LOST_MS = 200, BRIDGE_MS = 1_500, SWITCH_DB = 10;
/** Other lines this far from the carrier are notched (Hz); nearer, they may be the station itself. */
export const NOTCH_CLEAR_HZ = 30;
/** Where the noise is read: past the voice (3 kHz from a carrier up to a few hundred Hz off), inside the probe's band. */
export const NOISE_LO_HZ = 3_600, NOISE_HI_HZ = 4_200;

export class CarrierTracker {
  /** The carrier's frequency (Hz from the channel's center), whether one is held, and how often it was changed. */
  hz = 0; have = false; switches = 0;
  /** The signal in the carrier's frame (written each step) and the carrier phasor. */
  br = 0; bi = 0; cr = 0; ci = 0;
  /** The carrier's level smoothed to about 5 Hz, and its keyup's peak. */
  lvl = 0; peak = 0;
  /**
   * The noise a sample carries (its variance), measured 3.6 to 4.2 kHz either side of the center where no voice
   * reaches, at each look at the spectrum; 0 before the first.
   */
  noiseVar = 0;
  /** The power gain of whatever filtered the signal before it, at a frequency (the noise band is read through it). */
  gain: (hz: number) => number = () => 1;
  /** Steady lines measured on the idle channel (Hz): never taken for a station's carrier. */
  ignore: number[] = [];
  /** How long the carrier now held has been held (ms). */
  get heldMs(): number { return this.have ? this.ms - (this.changes.length ? this.changes[this.changes.length - 1].ms : 0) : 0; }
  /** The carrier's frequency every 100 ms while held, for the offset. */
  readonly log: number[] = [];
  /** Each change of carrier: when (ms since the start) and to what (Hz). */
  readonly changes: { ms: number; hz: number }[] = [];
  private readonly ri = new Float32Array(ACQ_N); private readonly rq = new Float32Array(ACQ_N); private rn = 0; private filled = 0;
  private readonly win = hann(ACQ_N); private readonly g2: number; private readonly w2: number;
  private ph = 0; private w = 0; private readonly a: number; private readonly a5: number; private readonly stepN: number;
  private n = 0; private lr = 0; private li = 0; private lowMs = 0; private sinceTry = 0; private sinceCheck = 0; private ms = 0; private logN = 0;
  constructor(private readonly fs: number) {
    this.a = 1 - Math.exp(-2 * Math.PI * PHASOR_HZ / fs);
    this.a5 = 1 - Math.exp(-2 * Math.PI * 5 * STEP_MS / 1000);
    this.stepN = Math.round(fs * STEP_MS / 1000);
    const g = this.win.reduce((s, v) => s + v, 0); this.g2 = g * g; this.w2 = this.win.reduce((s, v) => s + v * v, 0);
  }

  step(i: number, q: number): void {
    this.ri[this.rn] = i; this.rq[this.rn] = q; if (++this.rn >= ACQ_N) this.rn = 0; if (this.filled < ACQ_N) this.filled++;
    const c = Math.cos(this.ph), s = Math.sin(this.ph);
    const br = i * c + q * s, bi = q * c - i * s;
    this.br = br; this.bi = bi;
    this.cr += this.a * (br - this.cr); this.ci += this.a * (bi - this.ci);
    this.ph += this.w; if (this.ph > Math.PI) this.ph -= 2 * Math.PI; else if (this.ph < -Math.PI) this.ph += 2 * Math.PI;
    if (++this.n >= this.stepN) { this.n = 0; this.tick(); }
  }

  private tick(): void {
    this.ms += STEP_MS;
    if (!this.have) { this.sinceTry += STEP_MS; if (this.filled >= ACQ_N / 4 && this.sinceTry >= 100) { this.sinceTry = 0; this.acquire(0, false); } return; }
    const mag = Math.hypot(this.cr, this.ci);
    this.lvl += this.a5 * (mag - this.lvl);
    this.peak = Math.max(this.peak, this.lvl);
    const low = this.lvl < this.peak / Math.pow(10, LOST_DB / 20);
    if (!low) {
      // the phasor's turning since the last step is how far the carrier sits off: move most of the way onto it
      if (this.lr || this.li) {
        const d = Math.atan2(this.ci * this.lr - this.cr * this.li, this.cr * this.lr + this.ci * this.li);
        this.setHz(this.hz + Math.max(-TRACK_BW_HZ, Math.min(TRACK_BW_HZ, FLL_GAIN * d * this.fs / (2 * Math.PI * this.stepN))));
      }
      this.lowMs = 0;
      if (++this.logN >= 100 / STEP_MS) { this.logN = 0; this.log.push(this.hz); }
      this.sinceCheck += STEP_MS;
      if (this.sinceCheck >= RECHECK_MS) { this.sinceCheck = 0; this.acquire(mag * mag * Math.pow(10, SWITCH_DB / 10), true); }
    } else {
      this.lowMs += STEP_MS; this.sinceTry += STEP_MS;
      // faded: another line takes over only if it is 10 dB over what is left and no more than 6 dB under the keyup's peak
      if (this.lowMs >= LOST_MS && this.sinceTry >= 100) { this.sinceTry = 0; this.acquire(this.lowMs >= BRIDGE_MS ? 0 : Math.max(mag * mag * Math.pow(10, SWITCH_DB / 10), this.peak * this.peak / 4), true); }
    }
    this.lr = this.cr; this.li = this.ci;
  }

  private setHz(hz: number): void { this.hz = hz; this.w = 2 * Math.PI * hz / this.fs; }

  /** Takes the strongest line within reach of the center when its power is at least [needPow] (0: any clear line). */
  private acquire(needPow: number, elsewhere: boolean): void {
    const N = ACQ_N, re = new Float32Array(N), im = new Float32Array(N), have = Math.min(this.filled, N);
    // the newest [have] samples, the window over them
    for (let k = 0; k < N; k++) { if (k < N - have) continue; const j = (this.rn + k) % N; re[k] = this.ri[j] * this.win[k]; im[k] = this.rq[j] * this.win[k]; }
    fft(re, im);
    const binHz = this.fs / N, R = Math.round(ACQ_RANGE_HZ / binHz), pw = new Float64Array(2 * R + 1);
    for (let b = -R; b <= R; b++) { const k = (b + N) % N; pw[b + R] = re[k] * re[k] + im[k] * im[k]; }
    const med = [...pw].sort((x, y) => x - y)[R] || 1e-12;
    const lo = Math.round(NOISE_LO_HZ / binHz), hi = Math.round(NOISE_HI_HZ / binHz), edge: number[] = [];
    for (let b = lo; b <= hi && b < N / 2; b++) { const gk = Math.max(1e-3, this.gain(b * binHz)); for (const k of [b, N - b]) edge.push((re[k] * re[k] + im[k] * im[k]) / gk); }
    if (edge.length) { edge.sort((x, y) => x - y); this.noiseVar = edge[Math.floor(edge.length / 2)] / this.w2 * (N / have); }
    let best = -1;
    const idle = (b: number) => this.ignore.some(h => Math.abs((b - R) * binHz - h) <= NOTCH_CLEAR_HZ + binHz);
    const reach = (b: number) => (b - R) * binHz >= ACQ_LOW_HZ && (b - R) * binHz <= ACQ_HIGH_HZ;
    for (let b = 1; b < pw.length - 1; b++) if (reach(b) && pw[b] >= pw[b - 1] && pw[b] >= pw[b + 1] && !idle(b) && (best < 0 || pw[b] > pw[best])) best = b;
    if (best < 0 || pw[best] < med * Math.pow(10, ACQ_MIN_DB / 10)) return;
    const linePow = pw[best] / this.g2 * (N / have) * (N / have);
    if (needPow > 0 && linePow < needPow) return;
    const l = Math.log(pw[best - 1] + 1e-12), c = Math.log(pw[best] + 1e-12), r = Math.log(pw[best + 1] + 1e-12), den = l - 2 * c + r;
    const hz = (best - R + (den < 0 ? 0.5 * (l - r) / den : 0)) * binHz;
    // a check while holding takes over only for a different line
    if (elsewhere && this.have && Math.abs(hz - this.hz) <= TRACK_BW_HZ) return;
    if (this.have) this.switches++;
    this.changes.push({ ms: this.ms, hz });
    this.setHz(hz); this.have = true; this.cr = 0; this.ci = 0; this.lr = 0; this.li = 0;
    this.lvl = Math.sqrt(linePow); this.peak = this.lvl; this.lowMs = 0; this.sinceCheck = 0;
  }

  /** The carrier's frequency over the keyup: the median of the 100 ms readings. */
  offset(): number { if (this.log.length < 3) return NaN; const s = [...this.log].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
}
