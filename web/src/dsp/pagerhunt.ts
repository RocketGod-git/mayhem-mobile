/**
 * The pager hunter, the TypeScript twin of the Android app's PagerEngine and PagerChannelRx: multi-channel pager
 * decode over whatever span the radio is tuned to. It peak-holds the span's spectrum, finds the carriers in it, and
 * decodes up to [SLOTS] at once, each cut out of the wide IQ by its own channel receiver and fed to a FLEX and a
 * POCSAG decoder. AUTO tracks the span's busiest carriers itself; pinning keeps only the ones tapped.
 */
import { fft } from '../fft.js';
import type { Emit, IqProcessor } from './core.js';
import { FlexDecoder } from './flex.js';
import { PocsagDecoder } from './pocsag.js';

const SLOTS = 4;
const SETTLE_MS = 300;        // ignore the span right after a retune, while the AGC and stream settle
const SURVEY_MS = 2000;       // peak-hold this long before the first carrier list
const TRIAL_MS = 20_000;      // a hunted carrier gets this long to show a sync
const RETRY_MS = 90_000;      // before an evicted carrier is tried again
const PROVEN_MS = 180_000;    // a carrier that synced this recently keeps its slot

/** Hamming-windowed sinc, unity gain at DC; [cut] is the cutoff as a fraction of the sample rate. */
function lowpass(taps: number, cut: number): Float32Array {
  const m = taps - 1, h = new Float64Array(taps);
  let g = 0;
  for (let k = 0; k < taps; k++) {
    const x = k - m / 2;
    const sinc = x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
    h[k] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * k / m)); g += h[k];
  }
  const out = new Float32Array(taps);
  for (let k = 0; k < taps; k++) out[k] = h[k] / g;
  return out;
}

/**
 * One pager channel cut out of the wide IQ stream: mixed to baseband by an oscillator, filtered and decimated in two
 * FIR stages (to ~240 kHz, then to ~48 kHz with a channel filter tight enough that the next 25 kHz channel is gone),
 * FM-discriminated, and fed to both a FLEX and a POCSAG decoder.
 */
class ChannelRx {
  outRate = 0;
  private rate = 0; private center = 0;
  private pr = 1; private pi = 0; private sr = 1; private si = 0;
  private d1 = 1; private d2 = 1;
  private t1 = new Float32Array(1); private t2 = new Float32Array(1);
  private h1i = new Float32Array(2); private h1q = new Float32Array(2); private p1 = 0; private c1 = 0;
  private h2i = new Float32Array(2); private h2q = new Float32Array(2); private p2 = 0; private c2 = 0;
  private lastI = 0; private lastQ = 0;
  private readonly out = new Float32Array(4096); private nOut = 0;
  private readonly flex: FlexDecoder; private readonly pocsag: PocsagDecoder;
  /** Sees every discriminator block before the decoders do: the heard channel's audio. */
  tap: ((xs: Float32Array, n: number, rate: number) => void) | null = null;

  constructor(readonly hz: number, emit: Emit) { this.flex = new FlexDecoder(emit); this.pocsag = new PocsagDecoder(emit); }

  configure(centerHz: number, sampleRate: number): void {
    if (centerHz === this.center && sampleRate === this.rate) return;
    this.center = centerHz;
    if (sampleRate !== this.rate) {
      this.rate = sampleRate;
      this.d1 = Math.max(1, Math.round(sampleRate / 240_000));
      const inter = sampleRate / this.d1;
      this.d2 = Math.max(1, Math.round(inter / 48_000));
      this.outRate = inter / this.d2;
      this.t1 = lowpass(5 * this.d1 + 1, 50_000 / sampleRate);
      this.t2 = lowpass(127, 10_000 / inter);
      this.h1i = new Float32Array(this.t1.length * 2); this.h1q = new Float32Array(this.t1.length * 2); this.p1 = 0; this.c1 = 0;
      this.h2i = new Float32Array(this.t2.length * 2); this.h2q = new Float32Array(this.t2.length * 2); this.p2 = 0; this.c2 = 0;
      this.flex.reset(); this.pocsag.reset();
    }
    const w = -2 * Math.PI * (this.hz - centerHz) / sampleRate;
    this.sr = Math.cos(w); this.si = Math.sin(w);
  }

  /** One buffer of signed 8-bit interleaved IQ. */
  process(iq: Int8Array): void {
    if (!this.rate) return;
    const n = iq.length >> 1, t1 = this.t1, t2 = this.t2, L1 = t1.length, L2 = t2.length;
    const h1i = this.h1i, h1q = this.h1q, h2i = this.h2i, h2q = this.h2q, sr = this.sr, si = this.si, d1 = this.d1, d2 = this.d2;
    let r = this.pr, s = this.pi, p1 = this.p1, c1 = this.c1, p2 = this.p2, c2 = this.c2;
    for (let k = 0; k < n; k++) {
      const xi = iq[2 * k], xq = iq[2 * k + 1];
      const yi = xi * r - xq * s, yq = xi * s + xq * r;
      const nr = r * sr - s * si; s = r * si + s * sr; r = nr;
      // stage 1: keep the last L1 samples (written twice so the window is always contiguous)
      h1i[p1] = yi; h1i[p1 + L1] = yi; h1q[p1] = yq; h1q[p1 + L1] = yq;
      p1 = p1 + 1 === L1 ? 0 : p1 + 1;
      if (++c1 < d1) continue;
      c1 = 0;
      let ai = 0, aq = 0;
      for (let t = 0; t < L1; t++) { const c = t1[t]; ai += h1i[p1 + t] * c; aq += h1q[p1 + t] * c; }
      // stage 2: the channel filter
      h2i[p2] = ai; h2i[p2 + L2] = ai; h2q[p2] = aq; h2q[p2 + L2] = aq;
      p2 = p2 + 1 === L2 ? 0 : p2 + 1;
      if (++c2 < d2) continue;
      c2 = 0;
      let bi = 0, bq = 0;
      for (let t = 0; t < L2; t++) { const c = t2[t]; bi += h2i[p2 + t] * c; bq += h2q[p2 + t] * c; }
      this.out[this.nOut++] = Math.atan2(bq * this.lastI - bi * this.lastQ, bi * this.lastI + bq * this.lastQ);
      this.lastI = bi; this.lastQ = bq;
      if (this.nOut === this.out.length) this.drain();
    }
    const m = Math.sqrt(r * r + s * s); this.pr = r / m; this.pi = s / m;
    this.p1 = p1; this.c1 = c1; this.p2 = p2; this.c2 = c2;
    this.drain();
  }

  private drain(): void {
    if (!this.nOut) return;
    this.tap?.(this.out, this.nOut, this.outRate);
    this.flex.onFm(this.out, this.nOut, this.outRate);
    this.pocsag.onFm(this.out, this.nOut, this.outRate);
    this.nOut = 0;
  }
}

interface Slot { hz: number; rx: ChannelRx; since: number; lastSync: number; syncs: number; pages: number; protocol: string; rate: string }
interface Carrier { hz: number; db: number }

export class PagerHunter implements IqProcessor {
  /** The span's centre, set by the worker before each buffer. */
  centerHz = 0;
  /** The heard channel's discriminator, for the speaker. */
  onAudio: ((xs: Float32Array, n: number, rate: number) => void) | null = null;
  private hunting = true;
  private listenHz: number | null = null;
  private readonly pinned = new Set<number>();
  private restart = true;
  private center = 0; private rate = 0; private spanStart = 0; private lastManage = 0; private lastPublish = 0;
  private peak = new Float32Array(0);
  private carrierList: Carrier[] = [];
  private slots: Slot[] = [];
  private readonly tried = new Map<number, number>();
  private heard: Slot | null = null;
  private readonly re = new Float32Array(1024); private readonly im = new Float32Array(1024);
  private readonly hann = Float32Array.from({ length: 1024 }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / 1023));

  /** The clock (a test can play a recording faster than real time). */
  clock: () => number = () => performance.now();

  constructor(private readonly post: Emit) {}
  reset(): void { this.restart = true; }

  /** From the page: AUTO (hunt again), pin a carrier, or let one go. */
  command(cmd: string, hz?: number): void {
    if (cmd === 'auto') { this.pinned.clear(); this.listenHz = null; this.hunting = true; }
    else if (cmd === 'pin' && hz) { this.pinned.add(hz); this.hunting = false; this.listenHz = hz; }
    else if (cmd === 'unpin' && hz) { this.pinned.delete(hz); if (this.listenHz === hz) this.listenHz = null; if (!this.pinned.size) this.hunting = true; }
    this.lastManage = 0; this.publish();
  }

  onIq(iq: Int8Array, rate: number): void {
    const t = this.clock();
    if (this.restart || this.centerHz !== this.center || rate !== this.rate) {
      this.center = this.centerHz; this.rate = rate; this.restart = false;
      this.slots = []; this.tried.clear(); this.peak = new Float32Array(0); this.carrierList = [];
      this.spanStart = t; this.lastManage = 0; this.heard = null;
      this.publish();
    }
    if (t - this.spanStart < SETTLE_MS) return;
    this.scan(iq);
    if (this.slots.length) {
      this.heard = (this.listenHz !== null ? this.slots.find(s => s.hz === this.listenHz) : undefined)
        ?? this.slots.reduce<Slot | null>((a, s) => (!a || s.lastSync > a.lastSync ? s : a), null);
      for (const s of this.slots) { s.rx.configure(this.center, rate); s.rx.process(iq); }
    }
    if (t - this.spanStart >= SETTLE_MS + SURVEY_MS && t - this.lastManage > 2000) { this.lastManage = t; this.manage(t); }
    if (t - this.lastPublish > 500) { this.lastPublish = t; this.publish(); }
  }

  // ---- spectrum: find the carriers. The survey looks at far more of the signal than a waterfall does (every 4th
  // 1024-sample block of every buffer), so a POCSAG transmitter keyed for only a second still shows up.
  private scan(iq: Int8Array): void {
    const n = iq.length >> 1, re = this.re, im = this.im, hann = this.hann;
    for (let start = 0; start + 1024 <= n; start += 4096) {
      for (let k = 0; k < 1024; k++) { re[k] = iq[2 * (start + k)] * hann[k]; im[k] = iq[2 * (start + k) + 1] * hann[k]; }
      fft(re, im);
      if (this.peak.length !== 1024) this.peak = new Float32Array(1024).fill(-200);
      for (let k = 0; k < 1024; k++) {
        const s = (k + 512) % 1024;   // DC to the middle
        const db = 10 * Math.log10(re[s] * re[s] + im[s] * im[s] + 1e-9);
        // a slow-decaying peak so carriers that come and go stay ranked
        this.peak[k] = db > this.peak[k] ? db : this.peak[k] - 0.02;
      }
    }
  }

  private carriers(): Carrier[] {
    const peak = this.peak, n = peak.length;
    if (!n) return [];
    const floor = Float32Array.from(peak).sort()[n >> 1];
    const bin = this.rate / n, reach = Math.max(1, Math.floor(12_000 / bin));
    const out: Carrier[] = [];
    for (let k = 0; k < n; k++) {
      const off = (k - n / 2) * bin;
      if (Math.abs(off) < 15_000 || Math.abs(off) > this.rate * 0.45) continue;   // the DC spike and the band edges
      const p = peak[k];
      if (p < floor + 12) continue;
      let top = true;
      for (let j = Math.max(0, k - reach); j <= Math.min(n - 1, k + reach); j++) if (peak[j] > p || (peak[j] === p && j < k)) { top = false; break; }
      if (!top) continue;
      // A FLEX carrier's spectrum is flat-topped, so its peak bin is not its centre: take the power centroid of the
      // bins within 10 dB of the top, then snap onto a 2.5 kHz raster.
      let wsum = 0, isum = 0;
      for (let j = Math.max(0, k - reach); j <= Math.min(n - 1, k + reach); j++) if (peak[j] > p - 10) { const lin = 10 ** ((peak[j] - p) / 10); wsum += lin; isum += lin * j; }
      const est = this.center + (isum / wsum - n / 2) * bin;
      out.push({ hz: Math.round(est / 2500) * 2500, db: p - floor });
    }
    return out.sort((a, b) => b.db - a.db).slice(0, 16);
  }

  // ---- slots
  private newSlot(hz: number, t: number): Slot {
    const slot: Slot = { hz, rx: null as unknown as ChannelRx, since: t, lastSync: 0, syncs: 0, pages: 0, protocol: '', rate: '' };
    slot.rx = new ChannelRx(hz, (m) => {
      if (m.type === 'sync') { slot.lastSync = this.clock(); slot.syncs++; slot.protocol = m.protocol as string; slot.rate = m.rate as string; }
      else if (m.type === 'packet' && m.page) { slot.pages++; this.post({ type: 'huntPage', hz, page: m.page, line: m.line, replaces: m.replaces }); }
      else if (m.type === 'pagerNoise') this.post({ type: 'huntPage', hz, page: m.page });
    });
    slot.rx.tap = (xs, n, r) => { if (this.heard === slot) this.onAudio?.(xs, n, r); };
    return slot;
  }

  private manage(t: number): void {
    this.carrierList = this.carriers();
    const want = this.hunting ? this.carrierList.slice(0, SLOTS).map(c => c.hz) : [...this.pinned];
    // evict: in AUTO, carriers that had their trial and never proved; pinned, anything no longer pinned
    const gone = this.slots.filter(s => !this.hunting ? !want.includes(s.hz) : t - s.since > TRIAL_MS && t - s.lastSync > PROVEN_MS && !want.includes(s.hz));
    for (const s of gone) { this.slots = this.slots.filter(x => x !== s); if (this.hunting) this.tried.set(s.hz, t); }
    for (const hz of want) {
      if (this.slots.length >= SLOTS) break;
      if (this.slots.some(s => Math.abs(s.hz - hz) < 10_000)) continue;
      if (this.hunting && t - (this.tried.get(hz) ?? -Infinity) < RETRY_MS) continue;
      this.slots.push(this.newSlot(hz, t));
    }
    this.publish();
  }

  private statusText(): string {
    if (!this.hunting) { const np = this.pinned.size; return np === 0 ? 'Pinned · tap an active frequency to listen' : `Pinned ${np} channel${np === 1 ? '' : 's'}`; }
    const now = this.clock(), dec = this.slots.filter(s => now - s.lastSync < PROVEN_MS && s.syncs > 0).length;
    if (!this.peak.length) return 'Surveying the span';
    if (!this.slots.length) return 'Watching · no carriers yet (tune to a pager band)';
    if (!dec) return `Trying ${this.slots.length} carrier${this.slots.length === 1 ? '' : 's'}`;
    return `Decoding ${dec} channel${dec === 1 ? '' : 's'}`;
  }

  private publish(): void {
    // a carrier's estimate wanders a raster step or two between surveys: within 10 kHz of a channel, it is that channel
    const near = (a: number, b: number) => Math.abs(a - b) < 10_000;
    const channels = this.slots.map(s => ({ hz: s.hz, db: this.carrierList.find(c => near(c.hz, s.hz))?.db ?? 0, listening: true, protocol: s.protocol, rate: s.rate, pages: s.pages }));
    for (const c of this.carrierList) if (!this.slots.some(s => near(s.hz, c.hz)) && channels.length < 12) channels.push({ hz: c.hz, db: c.db, listening: false, protocol: '', rate: '', pages: 0 });
    this.post({ type: 'huntState', text: this.statusText(), hunting: this.hunting, pinned: [...this.pinned], channels });
  }
}
