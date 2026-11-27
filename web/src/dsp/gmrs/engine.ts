/**
 * GMRS and MURS receiver: every channel of the plan in one span at once on HAM+'s watcher, every keyup opened and
 * demodulated by HAM+'s own FM probe (narrow FM, its CTCSS / DCS decoder, its Morse reader and the identity layer's
 * analog signaling: MDC-1200, FleetSync, other data bursts). Receive only.
 *
 * GMRS watches its 30 channels on their 12.5 kHz raster, a keyup opening on the channel that is the strongest within
 * one step; MURS its five on 2.5 kHz. Beyond HAM+:
 *  - a keyup on a repeater input (467.550 to 467.725) is paired with the keyup on its output 5 MHz down that starts
 *    with it, at once (the tracker also learns the pair, as HAM+ does, and then shows the two as one channel);
 *  - every callsign a Morse ID carries is listed (GMRS calls, WRAB123 or KAE1234, and amateur ones);
 *  - a keyup without a voice that carried signaling (an MDC-1200 or FleetSync ID, a data burst, a Morse ID alone) is
 *    logged all the same; a data burst no decoder names is flagged as data with a short hex dump of its bits.
 */
import type { Emit } from '../core.js';
import { CLOSE_HOLD_MS, ChannelWatch, HAM_PLAN, Probe, STEADY_SHOW_MS, type Open, type WatchPlan } from '../hamplus/engine.js';
import { HamTracker, PAIR_START_MS, chanKey, type TxRec } from '../hamplus/tracker.js';
import type { HamIdent } from '../hamid/ident.js';
import { GMRS_TRACKER_PLAN, centerOf, channelsOf, gmrsChan, gmrsName, idCalls, type GmrsBand, type GmrsChan } from './plan.js';

export const GMRS_WATCH: WatchPlan = {
  name: 'GMRS', type: 'gmrs', raster: 12_500, inPlan: hz => { const c = gmrsChan(hz); return !!c && c.kind !== 'murs'; },
  nfft: HAM_PLAN.nfft, spanHalf: HAM_PLAN.spanHalf, peakSteps: 1, clearSteps: 0, snap: false,
};
export const MURS_WATCH: WatchPlan = {
  name: 'MURS', type: 'gmrs', raster: 2_500, inPlan: hz => gmrsChan(hz)?.kind === 'murs',
  nfft: HAM_PLAN.nfft, spanHalf: HAM_PLAN.spanHalf, peakSteps: 0, clearSteps: 0, snap: false,
};
/** A GMRS channel this much under its neighbor 12.5 kHz away is taken for that one's splatter (dB). */
export const ADJ_DB = 15;
/** The GMRS channel filter: cut and taps. */
export const PROBE_CUT_HZ = 6_000, PROBE_TAPS = 127;
/** How many finished keyups are kept for pairing. */
const KEEP_KEYS = 400;

/** A repeater keyup: its output and input, each one's tone, and which of the two were heard. */
export interface GmrsRpt { outHz: number; inHz: number; inTone: number; inDcs: number; outTone: number; outDcs: number; inHeard: boolean; outHeard: boolean }
/** A callsign heard in a Morse ID. */
export interface GmrsCall { call: string; gmrs: boolean; hz: number; firstMs: number; lastMs: number; count: number }
/** What the board shows of a channel. */
export interface GmrsChanState {
  id: string; hz: number; key: string; kind: GmrsChan['kind']; name: string; inSpan: boolean;
  open: boolean; steady: boolean; tone: number; dcs: number; lastMs: number; txs: number; call: string;
  /** The last keyup on it carried a data burst no decoder named. */
  data: boolean;
}
interface KeyRec { id: number; hz: number; startMs: number; endMs: number; tone: number; dcs: number }
interface Seen { tone: number; dcs: number; lastMs: number; txs: number; call: string; data: boolean }

/**
 * A DCS code read through this share of a keyup is its code (HAM+ asks half): a code passes the Golay check and
 * repeats three times before it counts, so voice is never read as one, but loud voice breaks the reading for a while.
 */
export const DCS_SHARE = 0.2;
/** The data bursts no decoder named, as the identity layer lists them. */
export const dataLines = (id: HamIdent | null | undefined) => (id?.signaling ?? []).filter(l => /data burst/.test(l));

export class GmrsEngine extends ChannelWatch<Probe> {
  private readonly keys: KeyRec[] = [];
  private readonly seen = new Map<number, Seen>();
  readonly calls = new Map<string, GmrsCall>();

  constructor(readonly band: GmrsBand, emit: Emit, sink: (chunk: Float32Array) => void, clock: () => number = () => Date.now(), perf: () => number = () => performance.now()) {
    super(band === 'murs' ? MURS_WATCH : GMRS_WATCH, emit, sink, clock, perf, now => new HamTracker(now, GMRS_TRACKER_PLAN));
    this.centerHz = centerOf(band, true);
    this.checkClip = true;
  }

  /**
   * GMRS hears each channel through a 6 kHz filter steep enough to keep the next channel, 12.5 kHz away, out. Every
   * keyup's analog signaling is read through, not only around its steady tones as Repeaters does: a data burst is
   * short and seldom holds one tone long enough to be found that way.
   */
  protected makeProbe(hz: number): Probe {
    const p = this.band === 'gmrs' ? new Probe(this.rate, hz - this.centerHz, null, this.centerHz, PROBE_CUT_HZ, PROBE_TAPS) : new Probe(this.rate, hz - this.centerHz, null, this.centerHz);
    p.idc.analog.onlyTonal = false; p.dcsShare = DCS_SHARE;
    return p;
  }

  /**
   * HAM+'s opening and closing, but on GMRS one raster step is the next channel: an open keyup is held by its own
   * channel alone, and a keyup opens beside a busy neighbor unless it is [ADJ_DB] under it (the neighbor's splatter).
   * MURS, on 2.5 kHz, keeps HAM+'s step either side.
   */
  protected override gate(now: number): void {
    const p = this.params, pl = this.plan, wide = pl.raster >= 12_500, hold = wide ? 0 : 1, margin = wide ? ADJ_DB : 0;
    for (const o of [...this.opens.values()]) {
      let best = -99; for (let d = -hold; d <= hold; d++) { const j = o.k + d; if (j >= 0 && j < this.count) best = Math.max(best, this.snr[j]); }
      o.snr = best; o.peak = Math.max(o.peak, best);
      if (best > p.thresholdDb - 3) o.quietMs = 0;
      else if (!o.quietMs) o.quietMs = now;
      else if (now - o.quietMs >= CLOSE_HOLD_MS) this.close(o, o.quietMs);
    }
    for (let k = 0; k < this.count; k++) {
      if (this.snr[k] <= p.thresholdDb || !this.hamBand[k] || Math.abs(this.hzOf(k) - this.centerHz) < 6_000) continue;
      let peak = true; for (let d = -pl.peakSteps; d <= pl.peakSteps && peak; d++) { const j = k + d; if (d && j >= 0 && j < this.count && this.power[j] > this.power[k] + margin) peak = false; }
      if (!peak || [...this.opens.values()].some(o => Math.abs(o.k - k) <= pl.clearSteps)) continue;
      this.openAt(k, now);
    }
  }

  /** A keyup no voice was heard on is kept when it carried signaling or a Morse callsign: an ID, a data burst. */
  protected override steadyClosed(o: Open<Probe>, endMs: number): void {
    const p = o.probe;
    if (!p || o.flood || this.ownSpur(o.hz)) return;
    p.end();
    if (!p.ident()?.signaling.length && !idCalls(p.cwId() || p.cw0).length) return;
    o.talk = true;
    this.close(o, endMs);
  }

  protected override closed(_o: Open<Probe>, t: TxRec): void {
    this.keys.push({ id: t.id, hz: t.hz, startMs: t.startMs, endMs: t.endMs, tone: t.tone, dcs: t.dcs });
    if (this.keys.length > KEEP_KEYS) this.keys.shift();
    const s = this.seen.get(t.hz) ?? { tone: 0, dcs: 0, lastMs: 0, txs: 0, call: '', data: false };
    s.lastMs = t.endMs; s.txs++; if (t.tone || t.dcs) { s.tone = t.tone; s.dcs = t.dcs; }
    s.data = dataLines(t.ident).length > 0;
    for (const c of idCalls(t.cw)) {
      s.call = c.call;
      const k = this.calls.get(c.call);
      if (k) { k.count++; k.lastMs = t.endMs; k.hz = t.hz; } else this.calls.set(c.call, { ...c, hz: t.hz, firstMs: t.startMs, lastMs: t.endMs, count: 1 });
    }
    this.seen.set(t.hz, s);
  }

  /** Keyups finished and on the air now, oldest first. */
  private allKeys(): KeyRec[] {
    const live = [...this.opens.values()].filter(o => this.counted(o)).map(o => ({ id: o.id, hz: o.hz, startMs: o.startMs, endMs: 0, tone: o.probe?.tone() ?? 0, dcs: o.probe?.dcs() ?? 0 }));
    return [...this.keys, ...live];
  }
  /**
   * Repeater keyups by keyup id: an input keyup and the output keyup that starts within [PAIR_START_MS] of it and
   * overlaps it are one, both ids naming it. An input keyed alone is a repeater keyup whose output was not heard.
   */
  repeaterKeys(): Map<number, GmrsRpt> {
    const all = this.allKeys(), out = new Map<number, GmrsRpt>();
    for (const r of all) {
      const c = gmrsChan(r.hz); if (!c || c.kind !== 'input') continue;
      const o = all.find(x => Math.abs(x.hz - c.outHz) < 1_000 && Math.abs(x.startMs - r.startMs) <= PAIR_START_MS && (x.endMs === 0 || x.endMs >= r.startMs) && (r.endMs === 0 || r.endMs >= x.startMs));
      const p: GmrsRpt = { outHz: c.outHz, inHz: c.hz, inTone: r.tone, inDcs: r.dcs, outTone: o?.tone ?? 0, outDcs: o?.dcs ?? 0, inHeard: true, outHeard: !!o };
      out.set(r.id, p);
      if (o) out.set(o.id, p);
    }
    return out;
  }

  /** Every channel of this band as the board shows it. */
  chans(now: number): GmrsChanState[] {
    const half = this.plan.spanHalf(this.rate);
    return channelsOf(this.band).map(c => {
      const all = [...this.opens.values()].filter(o => Math.abs(o.hz - c.hz) < 1_000), o = all.find(x => this.counted(x)), s = this.seen.get(c.hz);
      const steady = !o && all.some(x => !x.talk && now - x.startMs >= STEADY_SHOW_MS), lt = o?.probe?.tone() ?? 0, ld = o?.probe?.dcs() ?? 0;
      return {
        id: c.id, hz: c.hz, key: chanKey(c.hz), kind: c.kind, name: gmrsName(c), inSpan: !!this.rate && Math.abs(c.hz - this.centerHz) <= half,
        open: !!o, steady, tone: lt || ld ? lt : s?.tone ?? 0, dcs: lt || ld ? ld : s?.dcs ?? 0,
        lastMs: o ? now : s?.lastMs ?? 0, txs: (s?.txs ?? 0) + (o ? 1 : 0), call: s?.call ?? '', data: s?.data ?? false,
      };
    });
  }

  override clear(): void { super.clear(); this.keys.length = 0; this.seen.clear(); this.calls.clear(); }

  override snapshot(now = this.nowMs()) {
    const s = super.snapshot(now), rpt = this.repeaterKeys();
    const rows = s.rows.map(r => ({ ...r, rpt: rpt.get(r.id) ?? null, data: dataLines(r.ident), calls: idCalls(r.cw).map(c => c.call) }));
    return { ...s, band: this.band, rows, chans: this.chans(now), calls: [...this.calls.values()].sort((a, b) => b.lastMs - a.lastMs) };
  }
}
export type GmrsSnap = ReturnType<GmrsEngine['snapshot']>;
export type GmrsRow = GmrsSnap['rows'][number];
