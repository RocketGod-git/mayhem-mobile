/**
 * CB receiver: all 40 channels at once on HAM+'s watcher, each open one demodulated in its own mode.
 *
 * Each 100 ms the span's spectrum (about 150 to 250 Hz a bin) is cut into the 40 channels, ±4 kHz each, every bin
 * measured against the span's own noise (the quietest quarter of all the channel bins). A bin that stands well over
 * the noise and 6 dB over its channel's middle level and holds the same for two measurements is a steady line (an
 * unmodulated carrier, a receiver's own birdie, a carrier left keyed); it and its neighbors are left out, and so is
 * the channel's strongest bin and any bin that held a line for 3 s in the last ten minutes.
 *
 * A channel opens on what is left: its bins moving from one measurement to the next against their own floors (a
 * weak talker's voice, measured against how far the quietest quarter of the channels move), or plenty of power in
 * them (a strong talker, whose voice fills the channel). Then the demodulator decides: an opening that never
 * measures as AM, FM or sideband in its first 3 s (a burst of noise, a carrier keyed with nothing on it, sideband
 * facing a busy neighbor) is dropped without a trace. Nothing opens in the first 3 s of a span.
 *
 * A channel holding a steady line and no voice is reported as such: the level of the line over the noise, how long
 * it has held and how much of the last ten minutes it was there.
 */
import type { Emit } from '../core.js';
import { ChannelWatch, quietQuarter, type Open, type WatchPlan } from '../hamplus/engine.js';
import { HamTracker, chanKey, type TxRec } from '../hamplus/tracker.js';
import { CbProbe } from './probe.js';
import { CB_CENTER, CB_CHANNELS, CB_RASTER, CB_TRACKER_PLAN, cbChannel, type CbMode } from './plan.js';

/** The voice level (dB over the quiet channels' motion) a channel opens at; an open one closes 2 dB under it. */
export const CB_OPEN_DB = 3;
/** Or its power outside its steady lines this far over the noise (dB), and staying open 3 dB under that. */
export const CB_SIG_OPEN_DB = 10;
/** An open channel must measure as a readable station within this long, or it is dropped. */
export const CB_CONFIRM_MS = 3_000;
/** A dropped channel stays shut this long. */
export const CB_DROP_HOLD_MS = 5_000;
/** Nothing opens this long after the span starts: the floors and lines settle first. */
export const CB_WARM_MS = 3_000;
/** A channel stays open this long without voice: a talker's breath, a short pause. */
export const CB_CLOSE_HOLD_MS = 1_200;
/** The demodulated power falling this far under the transmission's peak this long is the carrier dropping: the end. */
export const CARRIER_DROP_DB = 10, CARRIER_GONE_MS = 200;
const MEASURE_STEP_MS = 100;
/** A steady line nearer the channel's center than this is not notched out (Hz). The probe also never notches within
 *  30 Hz of the carrier it holds, which is where a station on a line's frequency would be. */
export const NOTCH_KEEP_HZ = 0;
/** Only a line that held this many measurements (2 s) is notched: longer than a talker's own carrier has been up when its channel opens. */
export const NOTCH_HELD = 20;
/** A channel this much weaker than an open neighbor within 20 kHz is taken for its splatter (dB). */
export const SPLATTER_DB = 20;
/** Sideband facing a neighbor this much stronger outside its steady lines (dB), or open, is that neighbor's splatter. */
export const SPLATTER_FACING_DB = 6;
/** A steady line: over the noise by this much (linear, 8 dB), its measurements within what noise moves it by (never
 *  less than this share of their mean). */
export const LINE_MIN = 6.3, LINE_STEADY_MIN = 0.1;
/** A line is also this many times the channel's middle level (linear, 6 dB). */
export const LINE_OVER_CH = 4;
/** A line holding this many measurements running (3 s) is remembered, and its bins left out this long after. */
export const LINE_REMEMBER = 30;
export const LINE_MEMORY_MS = 600_000;
/** A channel shows "steady carrier, no voice" once a line has held this long without voice. */
export const STEADY_SHOW_MS = 3_000;
/** A steady line missing this long is gone. */
export const LINE_GONE_MS = 1_000;
/** The share of the last ten minutes a line was there decays with this time constant. */
const STEADY_TAU_MS = 600_000;
/** The voice level is the mean of the last [V_N] motions without the [V_DROP] highest (a carrier keying up is two or three). */
const V_N = 8, V_DROP = 3;
/** A bin's noise floor follows a drop at once and a rise slowly (a measurement's share), about 20 s. */
const FLOOR_DOWN = 0.3, FLOOR_UP = 0.005;
const HALF_HZ = 4_000, GUARD_HZ = 300;

export const CB_PLAN: WatchPlan = {
  name: 'CB', type: 'cb', raster: CB_RASTER, inPlan: hz => cbChannel(hz) > 0,
  // fine enough that a carrier sits in a bin or two and the voice beside it in others
  nfft: rate => 1 << Math.max(12, Math.min(14, Math.ceil(Math.log2(rate / 250)))), spanHalf: rate => Math.min(rate * 0.44 - 6_250, 400_000),
  peakSteps: 0, clearSteps: 1, snap: false,
};

/** What the CB screen knows about a channel beyond the tracker's tile. */
export interface CbChan {
  ch: number; hz: number; key: string; inSpan: boolean; open: boolean;
  /** The mode heard (live or last), what the measurement found for it, and the one set by hand ('' for auto). */
  mode: CbMode; measured: CbMode | ''; override: CbMode | ''; clarHz: number;
  /** Voice level (dB over the quiet channels' motion) and the modulated power over the noise (dB), now. */
  voiceDb: number; sigDb: number;
  /** A steady line now: its level over the noise (dB, 0 when none), how long it held (ms) and its share of the last ten minutes. */
  lineDb: number; steadyMs: number; steadyPct: number;
  /** Steady carrier and no voice: what the screen shows muted. */
  steady: boolean;
}

interface ChanState {
  hist: Float32Array[]; mem: Float64Array; run: Uint16Array; fl: Float32Array; v: number[]; voiceDb: number; sigDb: number; totDb: number; d: number;
  lineDb: number; lineSince: number; lineLast: number; noVoiceMs: number; seen: number; total: number; lastT: number; over: number; mode: CbMode;
}
export interface CbPrefs { modes: Record<string, CbMode | ''>; clar: Record<string, number> }

export class CbEngine extends ChannelWatch<CbProbe> {
  readonly st: ChanState[] = CB_CHANNELS.map(() => ({ hist: [], mem: new Float64Array(0), run: new Uint16Array(0), fl: new Float32Array(0), v: [], voiceDb: 0, sigDb: 0, totDb: 0, d: 0, lineDb: 0, lineSince: 0, lineLast: 0, noVoiceMs: -Infinity, seen: 0, total: 0, lastT: 0, over: 0, mode: 'AM' as CbMode }));
  cbPrefs: CbPrefs = { modes: {}, clar: {} };
  private readonly txMode = new Map<number, CbMode>();
  private readonly confirmed = new Set<number>();
  /** When an opening's demodulator started, when it did not start with it. */
  private readonly checkFrom = new Map<number, number>();
  /** Each finished transmission's carriers, as its demodulator took them. */
  readonly txCarriers = new Map<number, { ms: number; hz: number }[]>();
  /** Openings dropped as no voice, since the start (the log and the tests read it). */
  dropped = 0;
  private readonly peakLevel = new Map<number, number>(); private readonly goneMs = new Map<number, number>();
  private binHz = 0;

  constructor(emit: Emit, sink: (chunk: Float32Array) => void, clock: () => number = () => Date.now(), perf: () => number = () => performance.now()) {
    super(CB_PLAN, emit, sink, clock, perf, now => new HamTracker(now, CB_TRACKER_PLAN));
    this.centerHz = CB_CENTER;
    this.params.thresholdDb = CB_OPEN_DB;
  }

  /**
   * A new span (the radio started, retuned or changed rate) starts every channel's measurement over, and nothing opens
   * for [CB_WARM_MS] while the floors and the lines settle: a radio just started moves its gain and its own noise.
   */
  protected override layout(): void {
    super.layout();
    for (const s of this.st) { s.hist = []; s.fl.fill(0); s.run.fill(0); s.v = []; s.over = 0; s.voiceDb = 0; s.lineSince = 0; s.lineLast = 0; s.lineDb = 0; }
    this.warmUntil = this.nowMs() + CB_WARM_MS;
  }
  private warmUntil = 0;
  /** The span's noise variance a sample at the radio's rate, from the quietest quarter of the channel bins. */
  private noiseVarIn = 0;

  setCbPrefs(p: Partial<CbPrefs>): void {
    Object.assign(this.cbPrefs, p);
    for (const o of this.opens.values()) if (o.probe) { o.probe.override = this.cbPrefs.modes[o.tileKey] ?? ''; o.probe.clarHz = this.cbPrefs.clar[o.tileKey] ?? 0; }
  }

  protected makeProbe(hz: number, key: string): CbProbe {
    const p = new CbProbe(this.rate, hz - this.centerHz), ch = cbChannel(hz);
    p.override = this.cbPrefs.modes[key] ?? ''; p.clarHz = this.cbPrefs.clar[key] ?? 0;
    if (ch) { p.guess = this.st[ch - 1].mode; p.noiseRatio = this.noiseOf(ch - 1); p.noiseVarIn = this.noiseVarIn; p.setNotches(this.birdies(ch - 1)); }
    return p;
  }
  /**
   * The steady lines on a channel before a transmission opens, as offsets from its center (Hz): the peaks of the bins
   * steady for [NOTCH_HELD] measurements, read between bins by a parabola through the three around each. A line within [NOTCH_KEEP_HZ] of the
   * center is left alone, as it may be where the talker's own carrier is.
   */
  birdies(i: number): number[] {
    const s = this.st[i], p = s.hist[s.hist.length - 1], bh = this.binHz; if (!p || !bh) return [];
    const W = (p.length - 1) / 2, out: number[] = [];
    for (let b = 1; b < p.length - 1; b++) {
      if (s.run[b] < NOTCH_HELD || p[b] < p[b - 1] || p[b] < p[b + 1]) continue;
      const l = Math.log(p[b - 1]), c = Math.log(p[b]), r = Math.log(p[b + 1]), den = l - 2 * c + r;
      const hz = (b - W + (den < 0 ? 0.5 * (l - r) / den : 0)) * bh;
      if (Math.abs(hz) > NOTCH_KEEP_HZ) out.push(Math.round(hz));
    }
    return out.slice(0, 4);
  }
  /** The channel's noise against all its power, carrier too: what the probe takes noise alone to move. */
  private noiseOf(i: number): number { return 1 / Math.max(1e-3, Math.pow(10, this.st[i].totDb / 10)); }

  protected override gate(now: number, pdb: Float32Array, binHz: number): void {
    const N = this.nfft, W = Math.max(2, Math.round(HALF_HZ / binHz)), G = Math.max(1, Math.round(GUARD_HZ / binHz)), nb = 2 * W + 1;
    if (binHz !== this.binHz) { this.binHz = binHz; for (const s of this.st) { s.hist = []; s.mem = new Float64Array(nb); s.run = new Uint16Array(nb); s.fl = new Float32Array(nb); s.v = []; } }
    const half = this.plan.spanHalf(this.rate);
    // the raw bins of every channel heard, and the span's noise a bin: their quietest quarter
    const raw: (Float32Array | null)[] = CB_CHANNELS.map(hz => {
      if (Math.abs(hz - this.centerHz) > half) return null;
      const c = Math.round((hz - this.centerHz) / binHz) + N / 2, out = new Float32Array(nb);
      for (let b = 0; b < nb; b++) out[b] = pdb[Math.max(0, Math.min(N - 1, c - W + b))];
      return out;
    });
    const all: number[] = []; for (const r of raw) if (r) for (let b = 0; b < nb; b++) all.push(r[b]);
    if (!all.length) return;
    const nbin = quietQuarter(all, all.length) || 1e-12;
    // the span's noise a sample, for the demodulators: a Hann-windowed bin holds the noise variance times 0.375 N
    this.noiseVarIn = nbin / (0.375 * N);
    const ds: number[] = [];
    raw.forEach((r, i) => {
      const s = this.st[i];
      if (!r) { s.hist = []; s.d = NaN; return; }
      const p = new Float32Array(nb); for (let b = 0; b < nb; b++) p[b] = r[b] / nbin;
      s.hist.push(p); if (s.hist.length > 3) s.hist.shift();
      // steady lines: well over the noise and the same two measurements running are left out at once and reported;
      // one that held [LINE_REMEMBER] measurements is remembered for ten minutes
      const ex = new Uint8Array(nb); let line = 0;
      // a line stands out of its channel: over the noise, and 6 dB over the channel's own middle level (a band of hiss
      // raised across the whole channel is not a line)
      const chMed = [...p].sort((x, y) => x - y)[nb >> 1], lineMin = Math.max(LINE_MIN, LINE_OVER_CH * chMed);
      const H = s.hist.length, steadyOver = (b: number, n: number) => {
        if (H < n) return false;
        let lo = Infinity, hi = 0, sum = 0; for (let j = H - n; j < H; j++) { const v = s.hist[j][b]; lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
        // a line in noise wobbles by the noise riding on it, less the stronger it is: about sqrt(2 / level) of
        // itself a frame, less over the frames a measurement averages; a voice's bins move far more
        return lo > lineMin && (hi - lo) / (sum / n) < Math.max(LINE_STEADY_MIN, 0.7 * Math.sqrt(2 / lo));
      };
      for (let b = 0; b < nb; b++) {
        if (!steadyOver(b, 2)) { s.run[b] = 0; continue; }
        s.run[b]++;
        for (let d = -G; d <= G; d++) { const j = b + d; if (j >= 0 && j < nb) ex[j] = 1; }
        if (s.run[b] >= 2) line = Math.max(line, p[b]);
        // only a line that held for seconds is remembered: a held note in a voice is not
        if (s.run[b] >= LINE_REMEMBER) s.mem[b] = now;
      }
      for (let b = 0; b < nb; b++) if (s.mem[b] && now - s.mem[b] < LINE_MEMORY_MS) for (let d = -G; d <= G; d++) { const j = b + d; if (j >= 0 && j < nb) ex[j] = 1; }
      // the channel's strongest peak, steady or not, and the bins beside it: a carrier whose level wanders (fading, a
      // keyed carrier fluttering) moves its own bins, while a voice moves bins 300 Hz and more from its carrier
      { let pk = -1, pv = LINE_MIN; for (let b = 0; b < nb; b++) if (p[b] > pv) { pv = p[b]; pk = b; }
        if (pk >= 0) for (let d = -G; d <= G; d++) { const j = pk + d; if (j >= 0 && j < nb) ex[j] = 1; } }
      // how far the bins left move (the mean of the quarter that move most: a voice's bins, not the noise around
      // them), and the power in them
      let pw = 0, cnt = 0, tot = 0;
      for (let b = 0; b < nb; b++) tot += p[b];
      s.totDb = 10 * Math.log10(Math.max(1e-3, tot / nb - 1));
      const mvs: number[] = [];
      // each bin's move is measured against its own noise floor (fast down, slow up), so a stretch of the span with
      // more noise than the rest (a receiver's own noise near its center) moves no more than a quiet one
      for (let b = 0; b < nb; b++) { const f = s.fl[b]; s.fl[b] = !f ? p[b] : p[b] < f ? f + FLOOR_DOWN * (p[b] - f) : f + FLOOR_UP * (p[b] - f); }
      if (s.hist.length >= 2) { const q = s.hist[s.hist.length - 2]; for (let b = 0; b < nb; b++) if (!ex[b]) { mvs.push(Math.abs(p[b] - q[b]) / Math.max(1e-3, s.fl[b])); pw += p[b]; cnt++; } }
      mvs.sort((a, b) => b - a);
      const top = Math.max(1, Math.floor(mvs.length / 4));
      s.d = cnt >= nb / 4 ? mvs.slice(0, top).reduce((a, b) => a + b, 0) / top : NaN;
      s.sigDb = cnt ? 10 * Math.log10(Math.max(1e-3, pw / cnt - 1)) : 0;
      if (Number.isFinite(s.d)) ds.push(s.d);
      // the steady line's history: since when, and its share of the last ten minutes
      const dt = s.lastT ? Math.min(1_000, now - s.lastT) : 0; s.lastT = now;
      const k = Math.exp(-dt / STEADY_TAU_MS); s.seen = s.seen * k + (line || now - s.lineLast <= LINE_GONE_MS ? dt : 0); s.total = s.total * k + dt;
      // a weak line misses a measurement now and then: it counts as gone only after [LINE_GONE_MS] without it
      if (line) { s.lineDb = Math.round(10 * Math.log10(line)); s.lineLast = now; if (!s.lineSince) s.lineSince = now; }
      else if (now - s.lineLast > LINE_GONE_MS) { s.lineDb = 0; s.lineSince = 0; }
    });
    const dref = ds.length ? quietQuarter(ds, ds.length) || 1e-9 : 1e-9;
    const thr = this.params.thresholdDb;
    for (let i = 0; i < this.st.length; i++) {
      const s = this.st[i];
      if (!s.hist.length) { s.fl.fill(0); s.v = []; s.voiceDb = 0; s.over = 0; continue; }
      // too few bins left to measure (a strong carrier and its neighbors): the level holds
      if (Number.isFinite(s.d)) s.v.push(s.d / dref); if (s.v.length > V_N) s.v.shift();
      const sorted = [...s.v].sort((a, b) => a - b), keep = sorted.slice(0, Math.max(1, sorted.length - V_DROP));
      s.voiceDb = s.v.length >= 4 ? 10 * Math.log10(Math.max(1e-3, keep.reduce((a, b) => a + b, 0) / keep.length)) : 0;
      // a channel opens on its voice moving its bins (a weak talker), or on plenty of power outside its steady lines (a
      // strong one, whose voice fills the channel without much motion); the demodulator then has to find a voice in it
      s.over = s.voiceDb > thr || s.sigDb >= CB_SIG_OPEN_DB ? s.over + 1 : 0;
    }
    // open channels: still voiced? A carrier that drops away ends the transmission at once (the next talker may key
    // up a moment later); without one (SSB, or a weak talker under a steady line) the voice going quiet ends it
    for (const o of [...this.opens.values()]) {
      // an opening that found every demodulator busy gets one as soon as one is free, and its check starts then
      if (!o.probe && this.probes() < this.cap) { o.probe = this.makeProbe(o.hz, o.tileKey); o.cut = false; this.checkFrom.set(o.id, now); }
      const i = cbChannel(o.hz) - 1, s = this.st[i], p = o.probe;
      // a voice is AM, FM or sideband to the demodulator: something that moves the spectrum but measures as none of
      // them in its first seconds (a burst of noise from a nearby device) is dropped, not logged, and the channel is
      // held shut a while
      if (p && !this.confirmed.has(o.id) && now - (this.checkFrom.get(o.id) ?? o.startMs) >= CB_CONFIRM_MS) {
        if (this.voiced(p, o.hz)) this.confirmed.add(o.id);
        else { this.drop(o, now); continue; }
      }
      o.snr = s.sigDb; o.peak = Math.max(o.peak, s.sigDb);
      if (p) {
        p.noiseRatio = this.noiseOf(i); p.noiseVarIn = this.noiseVarIn;
        const pk = Math.max(this.peakLevel.get(o.id) ?? -99, p.levelDb); this.peakLevel.set(o.id, pk);
        const m = p.mode(), gone = (m === 'AM' || m === 'FM') && p.levelDb < pk - CARRIER_DROP_DB;
        if (!gone) this.goneMs.delete(o.id);
        else if (!this.goneMs.has(o.id)) this.goneMs.set(o.id, now);
        else if (now - this.goneMs.get(o.id)! >= CARRIER_GONE_MS) { this.close(o, this.goneMs.get(o.id)! - MEASURE_STEP_MS); continue; }
      }
      if (s.voiceDb > thr - 2 || s.sigDb >= CB_SIG_OPEN_DB - 3) o.quietMs = 0;
      else if (!o.quietMs) o.quietMs = now;
      else if (now - o.quietMs >= CB_CLOSE_HOLD_MS) this.close(o, o.quietMs);
    }
    // new talkers: four measurements over the threshold, and not a strong neighbor's splatter (an open channel within
    // 20 kHz with its power [SPLATTER_DB] over this one's)
    for (let i = 0; i < this.st.length; i++) {
      if (this.st[i].over < 4 || now < this.warmUntil || now - this.st[i].noVoiceMs < CB_DROP_HOLD_MS) continue;
      const hz = CB_CHANNELS[i];
      if ([...this.opens.values()].some(o => o.hz === hz)) continue;
      if ([...this.opens.values()].some(o => Math.abs(o.hz - hz) <= 20_000 && this.st[cbChannel(o.hz) - 1].totDb - this.st[i].totDb > SPLATTER_DB)) continue;
      const k = Math.round(hz / CB_RASTER) - this.first;
      if (k < 0 || k >= this.count) continue;
      this.openAt(k, now);
    }
  }

  /**
   * Whether an opening is a readable station by home's measure (a carrier 22 dB over the median through the keyup, or
   * a clear sideband), and not sideband facing a busy neighbor 10 kHz away (USB facing the channel above, LSB the one
   * below), which is that neighbor's AM splatter.
   */
  private voiced(p: CbProbe, hz: number): boolean {
    if (!p.readable()) return false;
    const m = p.measuredMode(), own = this.st[cbChannel(hz) - 1];
    const busy = (f: number) => { const ch = cbChannel(f); if (!ch) return false; const n = this.st[ch - 1];
      return [...this.opens.values()].some(o => o.hz === f) || (!!own && n.sigDb >= own.sigDb + SPLATTER_FACING_DB); };
    if (m === 'USB' && busy(hz + 10_000)) return false;
    if (m === 'LSB' && busy(hz - 10_000)) return false;
    return true;
  }
  /** An opening that never measured as a voice: gone without a trace, and its channel held shut a while. */
  private drop(o: Open<CbProbe>, now: number): void {
    const s = this.st[cbChannel(o.hz) - 1];
    this.opens.delete(o.id); this.peakLevel.delete(o.id); this.goneMs.delete(o.id); this.confirmed.delete(o.id); this.checkFrom.delete(o.id);
    if (s) { s.v = []; s.over = 0; s.noVoiceMs = now; }
    this.dropped++;
  }
  /** One that ends before its voice check (a carrier dropping within 3 s) faces the check as it ends. */
  protected override close(o: Open<CbProbe>, endMs: number): void {
    // (one never demodulated cannot be checked: it is not logged either)
    if (!this.confirmed.has(o.id) && (!o.probe || !this.voiced(o.probe, o.hz))) { this.drop(o, this.nowMs()); return; }
    super.close(o, endMs);
  }

  protected override closed(o: Open<CbProbe>, t: TxRec): void {
    this.peakLevel.delete(o.id); this.goneMs.delete(o.id); this.confirmed.delete(o.id); this.checkFrom.delete(o.id);
    const i = cbChannel(o.hz) - 1;
    // the next transmission on the channel opens on its own voice, not on what is left of this one's
    if (i >= 0) { this.st[i].v = []; this.st[i].over = 0; }
    const m = o.probe ? o.probe.mode() : this.st[i]?.mode ?? 'AM';
    this.txMode.set(t.id, m);
    // the carriers it was heard on, in order with when (ms into it): one a keyup is the aim
    if (o.probe) { this.txCarriers.set(t.id, o.probe.trk.changes.map(c => ({ ms: c.ms, hz: Math.round(c.hz) }))); if (this.txCarriers.size > 4_000) this.txCarriers.delete(this.txCarriers.keys().next().value!); }
    if (this.txMode.size > 4_000) this.txMode.delete(this.txMode.keys().next().value!);
    if (i >= 0 && o.probe && o.probe.measuredMode()) this.st[i].mode = o.probe.measuredMode() as CbMode;
  }
  override clear(): void { super.clear(); this.txMode.clear(); this.txCarriers.clear(); }

  /** Each of the 40 channels as the screen shows it. */
  chans(now: number): CbChan[] {
    const half = this.plan.spanHalf(this.rate);
    return CB_CHANNELS.map((hz, i) => {
      const s = this.st[i], key = chanKey(hz), o = [...this.opens.values()].find(x => x.hz === hz), p = o?.probe;
      const override = this.cbPrefs.modes[key] ?? '';
      const steadyMs = s.lineSince ? now - s.lineSince : 0;
      return {
        ch: i + 1, hz, key, inSpan: !!this.rate && Math.abs(hz - this.centerHz) <= half, open: !!o,
        mode: p ? p.mode() : override || s.mode, measured: p ? p.measuredMode() : '', override, clarHz: this.cbPrefs.clar[key] ?? 0,
        voiceDb: Math.round(s.voiceDb * 10) / 10, sigDb: Math.round(s.sigDb * 10) / 10,
        lineDb: s.lineDb, steadyMs, steadyPct: s.total > 0 ? Math.round(100 * s.seen / s.total) : 0,
        steady: !o && s.lineDb > 0 && steadyMs >= STEADY_SHOW_MS,
      };
    });
  }

  override snapshot(now = this.nowMs()) {
    const s = super.snapshot(now);
    const live = new Map<number, CbMode>(); for (const o of this.opens.values()) if (o.probe) live.set(o.id, o.probe.mode());
    // a transmission still waiting for its voice check is on the air, but not yet known to be a station (pending)
    const rows = s.rows.map(r => ({ ...r, mode: live.get(r.id) ?? this.txMode.get(r.id) ?? '', pending: r.live && !this.confirmed.has(r.id) }));
    return { ...s, rows, chans: this.chans(now) };
  }
}
export type CbSnap = ReturnType<CbEngine['snapshot']>;
