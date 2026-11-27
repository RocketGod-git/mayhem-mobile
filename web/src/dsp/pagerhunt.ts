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
import { ReflexDecoder, type ReflexFrame } from './reflex.js';

const SLOTS = 4;
const SETTLE_MS = 300;        // ignore the span right after a retune, while the AGC and stream settle
const SURVEY_MS = 2000;       // peak-hold this long before the first carrier list
const MANAGE_MS = 250;        // how often the carrier list is looked at again
const HISTORY_S = 1.0;        // IQ kept to replay into a new receiver (a POCSAG preamble is ~1.1 s at 512)
const QUICK_MS = 3000;        // an unproven receiver this old gives way to a new carrier
/** How far above the span's noise (its median peak-hold) a carrier must stand. The noise holds flat to a dB or two,
 *  and a weak 2400 baud POCSAG carrier spreads over a few bins, so 12 dB lost carriers it could decode. */
const SURVEY_DB = 8;
const TRIAL_MS = 20_000;      // a hunted carrier gets this long to show a sync
const RETRY_MS = 90_000;      // before an evicted carrier is tried again
const PROVEN_MS = 180_000;    // a carrier that synced this recently keeps its slot
/**
 * Image copies of a strong carrier. The HackRF puts weak copies of every strong carrier at multiples of 41.667 kHz
 * (20 MHz / 480) either side of it, about 30 dB down at the first and 43 dB at the second (measured on the 2026-11-20
 * roof recording, 929.6125, 931.5375, 935.275 and 940.8625 MHz). A copy carries the same pages at the same instant,
 * so it would decode them a second time and take a receiver a real carrier needs. A carrier sitting within
 * [IMAGE_TOL] of such an offset from one [IMAGE_DB] stronger gets no receiver in AUTO; a receiver at such an offset
 * that decodes a page another, much stronger receiver just decoded is a copy too, and gives its slot up.
 */
const IMAGE_STEP = 41_667;
const IMAGE_STEPS = 4;
const IMAGE_TOL = 5_000;
const IMAGE_DB = 15;
/** A page heard again on another carrier this soon after is the same transmission. */
const COPY_MS = 3_000;
/** How much weaker a receiver repeating another's page must be to be taken for a copy of it. */
const COPY_DB = 10;
/**
 * A page with pieces missing waits this long before it is shown. Simulcast carriers send the same pages a moment
 * apart, and one receiver often hears a page whole while another misses its first fragment; the whole copy usually
 * lands within a couple of seconds, and then the broken one is never shown.
 */
const PARTIAL_WAIT_MS = 8_000;
/** A whole copy arriving this soon after a broken one was shown takes that card's place, and a broken copy arriving
 *  this soon after a whole one is dropped (networks send a page again on another carrier seconds later). */
const PARTIAL_REPLACE_MS = 60_000;

/** The readable runs of a broken page, four characters or more: a missing fragment (<…>), a cut end ( …) and the
 *  '?' of lost words split it. Errors come in bursts, so the word on either side of a lost one (three characters) may
 *  have been fixed into the wrong word: it is left out as well. */
export function readableRuns(text: string): string[] {
  const c = [...text];
  const lost = c.map((ch, i) => ch === '?' ? i : -1).filter(i => i >= 0);
  for (const i of lost) for (let k = Math.max(0, i - 3); k <= Math.min(c.length - 1, i + 3); k++) if (c[k] !== '…' && c[k] !== '<' && c[k] !== '>') c[k] = '?';
  return c.join('').split(/<…>| …$|\?+/).map(s => s.trim()).filter(s => s.length >= 4);
}
/** Whether a whole page carries every readable run of a broken one, in order: the broken one is a copy of it. */
export function coversPage(whole: string, broken: string): boolean {
  const runs = readableRuns(broken);
  if (!runs.length) return false;
  let at = 0;
  for (const r of runs) { const k = whole.indexOf(r, at); if (k < 0) return false; at = k + r.length; }
  return true;
}

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
 * FM-discriminated, and fed to a FLEX, a POCSAG and a ReFLEX decoder.
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
  private readonly flex: FlexDecoder; private readonly pocsag: PocsagDecoder; private readonly reflex: ReflexDecoder;
  /** Sees every discriminator block before the decoders do: the heard channel's audio. */
  tap: ((xs: Float32Array, n: number, rate: number) => void) | null = null;

  constructor(readonly hz: number, emit: Emit) { this.flex = new FlexDecoder(emit); this.pocsag = new PocsagDecoder(emit); this.reflex = new ReflexDecoder(emit); }

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
      this.flex.reset(); this.pocsag.reset(); this.reflex.reset();
    }
    const w = -2 * Math.PI * (this.hz - centerHz) / sampleRate;
    this.sr = Math.cos(w); this.si = Math.sin(w);
  }

  /** One buffer of signed 8-bit interleaved IQ, less the radio's DC offset ([dcI], [dcQ]). */
  process(iq: Int8Array, dcI = 0, dcQ = 0): void {
    if (!this.rate) return;
    const n = iq.length >> 1, t1 = this.t1, t2 = this.t2, L1 = t1.length, L2 = t2.length;
    const h1i = this.h1i, h1q = this.h1q, h2i = this.h2i, h2q = this.h2q, sr = this.sr, si = this.si, d1 = this.d1, d2 = this.d2;
    let r = this.pr, s = this.pi, p1 = this.p1, c1 = this.c1, p2 = this.p2, c2 = this.c2;
    for (let k = 0; k < n; k++) {
      const xi = iq[2 * k] - dcI, xq = iq[2 * k + 1] - dcQ;
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
    this.reflex.onFm(this.out, this.nOut, this.outRate);
    this.nOut = 0;
  }
}

interface Slot { hz: number; rx: ChannelRx; since: number; lastSync: number; syncs: number; pages: number; protocol: string; rate: string; reflexLine?: string }
interface Carrier { hz: number; db: number; image?: number }

/** The stronger carrier [c] is an image copy of, if any (see [IMAGE_STEP]). */
export function imageOf(c: Carrier, all: Carrier[], rate = 0): number | undefined {
  const steps = [IMAGE_STEP];
  const r = rate / 480;   // the same spur scaled to the stream's rate, when that is its own spacing
  if (r >= 2 * IMAGE_TOL && Math.abs(r - IMAGE_STEP) > IMAGE_TOL) steps.push(r);
  for (const s of all) {
    if (s === c || s.db - c.db < IMAGE_DB) continue;
    const d = Math.abs(c.hz - s.hz);
    for (const st of steps) for (let k = 1; k <= IMAGE_STEPS; k++) if (Math.abs(d - k * st) <= IMAGE_TOL) return s.hz;
  }
  return undefined;
}

export class PagerHunter implements IqProcessor {
  /** The span's center, set by the worker before each buffer. */
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
  /** Carriers a receiver proved to be copies of another (it decoded that one's pages), by frequency. */
  private readonly copies = new Map<number, number>();
  /** Pages posted in the last [COPY_MS]: line, carrier and when. */
  private recent: { line: string; hz: number; at: number }[] = [];
  /** Broken pages waiting [PARTIAL_WAIT_MS] for a whole copy. */
  private held: { slot: Slot; m: Record<string, unknown>; at: number }[] = [];
  /** Broken pages shown in the last [PARTIAL_REPLACE_MS], so a late whole copy can take the card's place. */
  private shownBroken: { line: string; cap: number; text: string; at: number }[] = [];
  /** Whole pages shown in the last [PARTIAL_REPLACE_MS], so a broken copy arriving after one is dropped. */
  private wholes: { cap: number; text: string; at: number }[] = [];
  private heard: Slot | null = null;
  // The radio's DC offset (LO leakage), tracked per buffer and removed, so a carrier at the tuned center is not
  // buried under the spike and the center of the span can be hunted like the rest of it.
  private dcI = 0; private dcQ = 0; private dcFresh = true;
  // The last HISTORY_S of IQ: a carrier found now keyed up a moment ago, and POCSAG (unlike FLEX) only transmits in
  // bursts, so a new receiver is first fed what it missed, preamble and all.
  private hist = new Int8Array(0); private hW = 0; private hFill = 0;
  private readonly re = new Float32Array(1024); private readonly im = new Float32Array(1024);
  private readonly hann = Float32Array.from({ length: 1024 }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / 1023));

  /** The clock (a test can play a recording faster than real time). */
  clock: () => number = () => performance.now();

  constructor(private readonly post: Emit) {}
  reset(): void { this.restart = true; }

  /**
   * From the page. 'auto' turns AUTO off (the channels being decoded stay until one is picked) or back on (the pins
   * are forgotten). 'pin' keeps a carrier and turns AUTO off; 'unpin' lets it go and stops decoding it. 'pick' is a
   * tap on the waterfall: the frequency under the finger snaps onto the carrier there, which is then pinned.
   */
  command(cmd: string, hz?: number): void {
    if (cmd === 'auto') {
      this.pinned.clear(); this.listenHz = null; this.hunting = !this.hunting;
    } else if (cmd === 'pin' && hz) { this.pinned.add(hz); this.hunting = false; this.listenHz = hz; }
    else if (cmd === 'pick' && hz) { const at = this.snap(hz); this.pinned.add(at); this.hunting = false; this.listenHz = at; }
    else if (cmd === 'unpin' && hz) {
      this.pinned.delete(hz); if (this.listenHz === hz) this.listenHz = null;
      this.slots = this.slots.filter(s => s.hz !== hz); if (this.heard?.hz === hz) this.heard = null;
    }
    this.lastManage = 0;
    // a pick wants its receiver now, not at the next survey
    if (!this.hunting && this.rate && this.clock() - this.spanStart >= SETTLE_MS) this.fill(this.clock());
    if (this.heard && !this.slots.includes(this.heard)) this.heard = null;
    this.publish();
  }

  /**
   * The carrier at a tapped frequency: a listed carrier within half a 25 kHz channel of it, else the power centroid
   * of the held spectrum within 12 kHz of it (a carrier the survey ranked too low to list), else the tap itself;
   * all on the 2.5 kHz raster the survey uses.
   */
  snap(hz: number): number {
    const listed = this.carriers().reduce<Carrier | null>((a, c) => Math.abs(c.hz - hz) <= 12_500 && (!a || Math.abs(c.hz - hz) < Math.abs(a.hz - hz)) ? c : a, null);
    if (listed) return listed.hz;
    const peak = this.peak, n = peak.length;
    if (n && this.rate) {
      const bin = this.rate / n, k0 = Math.round((hz - this.center) / bin + n / 2), reach = Math.max(1, Math.floor(12_000 / bin));
      let top = -Infinity;
      for (let j = Math.max(0, k0 - reach); j <= Math.min(n - 1, k0 + reach); j++) top = Math.max(top, peak[j]);
      const floor = Float32Array.from(peak).sort()[n >> 1];
      if (top > floor + 6) {
        let wsum = 0, isum = 0;
        for (let j = Math.max(0, k0 - reach); j <= Math.min(n - 1, k0 + reach); j++) if (peak[j] > top - 10) { const lin = 10 ** ((peak[j] - top) / 10); wsum += lin; isum += lin * j; }
        return Math.round((this.center + (isum / wsum - n / 2) * bin) / 2500) * 2500;
      }
    }
    return Math.round(hz / 2500) * 2500;
  }

  onIq(iq: Int8Array, rate: number): void {
    const t = this.clock();
    if (this.restart || this.centerHz !== this.center || rate !== this.rate) {
      // a retune ends every receiver, so no whole copy can come now: what was waiting is shown as it is
      this.release(Infinity);
      this.shownBroken = []; this.wholes = [];
      this.center = this.centerHz; this.rate = rate; this.restart = false;
      this.slots = []; this.tried.clear(); this.copies.clear(); this.recent = []; this.peak = new Float32Array(0); this.carrierList = [];
      this.spanStart = t; this.lastManage = 0; this.heard = null;
      this.hist = new Int8Array(Math.max(2, Math.floor(rate * HISTORY_S) * 2)); this.hW = 0; this.hFill = 0;
      this.dcFresh = true;
      this.publish();
    }
    // the DC estimate follows the radio through the settle time too, so it is right by the first survey
    const n = iq.length >> 1;
    if (n) {
      let si = 0, sq = 0;
      for (let k = 0; k < n; k++) { si += iq[2 * k]; sq += iq[2 * k + 1]; }
      if (this.dcFresh) { this.dcI = si / n; this.dcQ = sq / n; this.dcFresh = false; }
      else { this.dcI += (si / n - this.dcI) * 0.3; this.dcQ += (sq / n - this.dcQ) * 0.3; }
    }
    this.release(t);
    if (t - this.spanStart < SETTLE_MS) return;
    this.record(iq);
    this.scan(iq);
    if (this.slots.length) {
      this.heard = (this.listenHz !== null ? this.slots.find(s => s.hz === this.listenHz) : undefined)
        ?? this.slots.reduce<Slot | null>((a, s) => (!a || s.lastSync > a.lastSync ? s : a), null);
      for (const s of this.slots) { s.rx.configure(this.center, rate); s.rx.process(iq, this.dcI, this.dcQ); }
    }
    if (t - this.spanStart >= SETTLE_MS + SURVEY_MS && t - this.lastManage >= MANAGE_MS) { this.lastManage = t; this.manage(t); }
    if (t - this.lastPublish > 500) { this.lastPublish = t; this.publish(); }
  }

  // ---- spectrum: find the carriers. The survey looks at far more of the signal than a waterfall does (every 4th
  // 1024-sample block of every buffer), so a POCSAG transmitter keyed for only a second still shows up.
  private scan(iq: Int8Array): void {
    const n = iq.length >> 1, re = this.re, im = this.im, hann = this.hann, dcI = this.dcI, dcQ = this.dcQ;
    for (let start = 0; start + 1024 <= n; start += 4096) {
      for (let k = 0; k < 1024; k++) { re[k] = (iq[2 * (start + k)] - dcI) * hann[k]; im[k] = (iq[2 * (start + k) + 1] - dcQ) * hann[k]; }
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
      if (Math.abs(off) > this.rate * 0.45) continue;   // the band edges (the DC spike is removed before the survey)
      const p = peak[k];
      if (p < floor + SURVEY_DB) continue;
      let top = true;
      for (let j = Math.max(0, k - reach); j <= Math.min(n - 1, k + reach); j++) if (peak[j] > p || (peak[j] === p && j < k)) { top = false; break; }
      if (!top) continue;
      // A FLEX carrier's spectrum is flat-topped, so its peak bin is not its center: take the power centroid of the
      // bins within 10 dB of the top, then snap onto a 2.5 kHz raster.
      let wsum = 0, isum = 0;
      for (let j = Math.max(0, k - reach); j <= Math.min(n - 1, k + reach); j++) if (peak[j] > p - 10) { const lin = 10 ** ((peak[j] - p) / 10); wsum += lin; isum += lin * j; }
      const est = this.center + (isum / wsum - n / 2) * bin;
      out.push({ hz: Math.round(est / 2500) * 2500, db: p - floor });
    }
    out.sort((a, b) => b.db - a.db);
    for (const c of out) c.image = imageOf(c, out, this.rate);
    return out.slice(0, 16);
  }

  // ---- slots
  private newSlot(hz: number, t: number): Slot {
    const slot: Slot = { hz, rx: null as unknown as ChannelRx, since: t, lastSync: 0, syncs: 0, pages: 0, protocol: '', rate: '' };
    slot.rx = new ChannelRx(hz, (m) => {
      if (m.type === 'sync') { slot.lastSync = this.clock(); slot.syncs++; slot.protocol = m.protocol as string; slot.rate = m.rate as string; }
      else if (m.type === 'packet' && m.page) this.onPage(slot, m);
      else if (m.type === 'reflex') this.onReflex(slot, m.frame as ReflexFrame, m.line as string);
      else if (m.type === 'pagerNoise') this.post({ type: 'huntPage', hz, page: m.page });
    });
    slot.rx.tap = (xs, n, r) => { if (this.heard === slot) this.onAudio?.(xs, n, r); };
    slot.rx.configure(this.center, this.rate);
    this.replay(slot.rx);
    return slot;
  }

  /** The survey's level for a carrier (0 when it is not listed). */
  private levelOf(hz: number): number { return this.carrierList.find(c => Math.abs(c.hz - hz) < 10_000)?.db ?? 0; }

  /**
   * A decoded page. A whole one goes to the feed, and a broken copy of it that is waiting, or was shown not long
   * ago, gives way to it. A broken one (pieces missing) waits [PARTIAL_WAIT_MS] for a whole copy from another carrier
   * or a repeat, and is dropped if a whole copy was shown just before it.
   */
  private onPage(slot: Slot, m: Record<string, unknown>): void {
    const page = m.page as { cap: number; text: string; errors: number }, t = this.clock(), text = page.text ?? '';
    if (!text.trim()) { this.show(slot, m); return; }
    this.wholes = this.wholes.filter(w => t - w.at <= PARTIAL_REPLACE_MS);
    if (page.errors > 0) {
      if (this.wholes.some(w => w.cap === page.cap && coversPage(w.text, text))) return;
      this.held.push({ slot, m, at: t });
      return;
    }
    this.held = this.held.filter(h => { const p = h.m.page as { cap: number; text: string }; return !(p.cap === page.cap && coversPage(text, p.text)); });
    this.shownBroken = this.shownBroken.filter(b => t - b.at <= PARTIAL_REPLACE_MS);
    const was = this.shownBroken.findIndex(b => b.cap === page.cap && coversPage(text, b.text));
    if (was >= 0) { if (!m.replaces) m = { ...m, replaces: this.shownBroken[was].line }; this.shownBroken.splice(was, 1); }
    this.wholes.push({ cap: page.cap, text, at: t });
    this.show(slot, m);
  }

  /** Broken pages whose wait is over (all of them when [now] is Infinity) go to the feed as they are. */
  private release(now: number): void {
    if (!this.held.length) return;
    const due = this.held.filter(h => now - h.at >= PARTIAL_WAIT_MS);
    if (!due.length) return;
    this.held = this.held.filter(h => now - h.at < PARTIAL_WAIT_MS);
    for (const h of due) {
      const p = h.m.page as { cap: number; text: string };
      this.shownBroken.push({ line: typeof h.m.line === 'string' ? h.m.line : '', cap: p.cap, text: p.text, at: this.clock() });
      this.show(h.slot, h.m);
    }
  }

  /**
   * A page for the feed. The same line from another receiver a moment ago is one transmission heard twice: a receiver
   * on an image copy (see [IMAGE_STEP]). It is shown once, on the stronger carrier, and the weaker one gives its slot up.
   */
  private show(slot: Slot, m: Record<string, unknown>): void {
    const t = this.clock(), line = typeof m.line === 'string' ? m.line : '';
    this.recent = this.recent.filter(r => t - r.at <= COPY_MS);
    const twin = line ? this.recent.find(r => r.hz !== slot.hz && r.line === line) : undefined;
    if (twin) {
      const mine = this.levelOf(slot.hz), theirs = this.levelOf(twin.hz);
      const strong = mine >= theirs ? slot.hz : twin.hz, weak = strong === slot.hz ? twin.hz : slot.hz;
      // much weaker and at a spur offset: a copy. Two real carriers can carry the same page; those both show.
      if (Math.abs(mine - theirs) >= COPY_DB && imageOf({ hz: weak, db: 0 }, [{ hz: strong, db: IMAGE_DB }], this.rate) !== undefined) {
        this.copies.set(weak, strong);
        this.lastManage = 0;
        if (strong !== slot.hz) return;      // the copy: already shown
        // the stronger carrier decoded it second: its card takes the copy's place
        twin.hz = slot.hz; slot.pages++;
        const w = this.slots.find(s => s.hz === weak);
        if (w && w.pages > 0) w.pages--;
        this.post({ type: 'huntPage', hz: slot.hz, page: m.page, line, replaces: line });
        return;
      }
    }
    slot.pages++;
    if (line) this.recent.push({ line, hz: slot.hz, at: t });
    this.post({ type: 'huntPage', hz: slot.hz, page: m.page, line: m.line, replaces: m.replaces });
  }

  /**
   * A ReFLEX frame: one card per carrier, replaced by each new frame, with what the frame showed (its cycle and frame,
   * blocks, the checked words). Its addresses and messages are not decoded, so it has no capcode.
   */
  private onReflex(slot: Slot, f: ReflexFrame, line: string): void {
    if (this.isCopy(slot.hz)) return;
    const page = { protocol: 'ReFLEX', rate: '6400', cap: -1, kind: 'FRAME', text: ReflexDecoder.text(f), errors: 0, where: ReflexDecoder.where(f) };
    this.post({ type: 'huntPage', hz: slot.hz, page, line, replaces: slot.reflexLine });
    slot.reflexLine = line;
  }

  /** A carrier AUTO leaves alone: an image copy by the survey, or one a receiver showed to be a copy. */
  private isCopy(hz: number): boolean {
    for (const k of this.copies.keys()) if (Math.abs(k - hz) < 5_000) return true;
    return this.carrierList.some(c => c.image !== undefined && Math.abs(c.hz - hz) < 5_000);
  }

  private record(iq: Int8Array): void {
    const cap = this.hist.length;
    if (cap < 2) return;
    let off = Math.max(0, iq.length - cap);
    while (off < iq.length) {
      const m = Math.min(iq.length - off, cap - this.hW);
      this.hist.set(iq.subarray(off, off + m), this.hW);
      off += m; this.hW = (this.hW + m) % cap; this.hFill = Math.min(cap, this.hFill + m);
    }
  }

  /** Feeds a new receiver the last HISTORY_S of the span, oldest first, with the DC removed as now. */
  private replay(rx: ChannelRx): void {
    const cap = this.hist.length;
    if (this.hFill < 2) return;
    const start = (this.hW - this.hFill + cap) % cap;
    if (start + this.hFill <= cap) rx.process(this.hist.subarray(start, start + this.hFill), this.dcI, this.dcQ);
    else { rx.process(this.hist.subarray(start, cap), this.dcI, this.dcQ); rx.process(this.hist.subarray(0, this.hW), this.dcI, this.dcQ); }
  }

  private manage(t: number): void {
    this.carrierList = this.carriers();
    this.fill(t);
  }

  /** Who gets a receiver: AUTO, the busiest carriers; AUTO off with pins, only those; AUTO off without, whoever has one. */
  private fill(t: number): void {
    if (!this.hunting && !this.pinned.size) { this.publish(); return; }
    // In AUTO, the strongest carriers, less any sitting out RETRY_MS after a failed trial (the next ones move up).
    const resting = (hz: number) => t - (this.tried.get(hz) ?? -Infinity) < RETRY_MS && !this.slots.some(s => Math.abs(s.hz - hz) < 10_000);
    const wanted = () => this.hunting ? this.carrierList.filter(c => !this.isCopy(c.hz) && !resting(c.hz)).slice(0, SLOTS).map(c => c.hz) : [...this.pinned];
    const want = wanted();
    // evict: in AUTO, carriers that had their trial and never proved; pinned, anything no longer pinned. A carrier
    // that wants a receiver while all are busy: one that never synced, has had a few seconds and is no longer among
    // the wanted gives way (POCSAG keys up for a second; it can't wait out a 20 s trial). A carrier that never synced
    // gives way after its trial even while it is still among the strongest: a spur or a non-pager signal can outrank
    // every pager in the span, and would otherwise hold its receiver for good.
    const waiting = this.hunting && this.slots.length >= SLOTS && want.some(hz => !this.slots.some(s => Math.abs(s.hz - hz) < 10_000) && t - (this.tried.get(hz) ?? -Infinity) >= RETRY_MS);
    const failed = (s: Slot) => s.syncs === 0 && t - s.since > TRIAL_MS;
    const gone = this.slots.filter(s => !this.hunting ? !want.includes(s.hz)
      : this.isCopy(s.hz) || failed(s) || !want.includes(s.hz) && t - s.lastSync > PROVEN_MS && (t - s.since > TRIAL_MS || (waiting && s.syncs === 0 && t - s.since > QUICK_MS)));
    // only a carrier that never synced waits out RETRY_MS: a pager that went quiet is welcome back at once
    for (const s of gone) { this.slots = this.slots.filter(x => x !== s); if (this.hunting && s.syncs === 0) this.tried.set(s.hz, t); }
    for (const hz of gone.length ? wanted() : want) {
      if (this.slots.length >= SLOTS) break;
      if (this.slots.some(s => Math.abs(s.hz - hz) < 10_000)) continue;
      if (this.hunting && t - (this.tried.get(hz) ?? -Infinity) < RETRY_MS) continue;
      this.slots.push(this.newSlot(hz, t));
    }
    this.publish();
  }

  private statusText(): string {
    if (!this.hunting) {
      const np = this.pinned.size;
      if (np) return `Pinned ${np} channel${np === 1 ? '' : 's'}`;
      return this.slots.length ? `AUTO off · holding ${this.slots.length} · tap a signal to keep just it` : 'AUTO off · tap a signal to decode it';
    }
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
    for (const c of this.carrierList) if (!this.slots.some(s => near(s.hz, c.hz)) && !this.isCopy(c.hz) && channels.length < 12) channels.push({ hz: c.hz, db: c.db, listening: false, protocol: '', rate: '', pages: 0 });
    this.post({ type: 'huntState', text: this.statusText(), hunting: this.hunting, pinned: [...this.pinned], channels, heardHz: this.listenHz ?? this.heard?.hz ?? null });
  }
}
