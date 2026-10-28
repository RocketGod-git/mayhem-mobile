/** Wideband sweep (Mayhem Looking Glass / Search; port of core/apps/SweepProcessor.kt). */
import { fft, hann, loadIqAt, accumulatePower, powerDbFrom } from '../fft.js';
import type { Emit, IqProcessor } from './core.js';

export const SWEEP_BINS = 512;
/** Keep the inner 80% of every slice: the baseband filter rolls the outer bins off, which drew a dark seam at each
 *  slice boundary. Slices therefore overlap and step by KEEP/SWEEP_BINS of their width. Doubled from 256 bins so a
 *  focused span reads finer, at no cost to the step overlap (the ratio is unchanged). */
const KEEP0 = 52, KEEP1 = 460;
export const SWEEP_KEEP = KEEP1 - KEEP0;
/** How long to keep discarding after asking for a retune when nothing says the radio has got there: long enough
 *  for a HackRF's retune, its settle, and the reads queued before it. A `tuned()` from the main thread cuts this
 *  short - it is only ever the fallback now. */
const SETTLE_MS = 130;
/** Bulk reads queued before a retune still carry the old frequency when they land. The HackRF driver keeps
 *  eight in flight; one more covers the read that was filling while the synthesizer moved. */
const INFLIGHT_STALE = 9;

export class SweepProcessor implements IqProcessor {
  readonly steps: number;
  private readonly re = new Float32Array(1024);
  private readonly im = new Float32Array(1024);
  private readonly acc = new Float32Array(1024);
  private readonly win = hann(1024);
  private readonly slice = new Float32Array(SWEEP_BINS);
  private readonly work: Float32Array;
  private step = 0;
  private settle = 0;
  private awaitingTune = false;
  private sweeps = 0;
  /** Mean square (counts²) of the loudest slice so far this pass: the AGC steers a sweep by it. */
  private peakSq = 0;

  readonly stepHz: number;
  readonly binHz: number;
  constructor(readonly startHz: number, readonly endHz: number, readonly sliceHz: number, private readonly emit: Emit) {
    this.stepHz = sliceHz * SWEEP_KEEP / SWEEP_BINS;
    this.binHz = sliceHz / SWEEP_BINS;
    this.steps = Math.max(1, Math.ceil((endHz - startHz) / this.stepHz));
    this.work = new Float32Array(this.steps * SWEEP_KEEP);
  }
  /** Tune so the kept (inner) part of slice i covers [start + i·step, start + (i+1)·step). */
  centerOf(i: number): number { return this.startHz + this.stepHz / 2 + i * this.stepHz; }
  freqOfBin(idx: number): number { return this.startHz + idx * this.binHz; }

  reset(): void { this.step = 0; this.settle = 8; this.awaitingTune = true; this.emit({ type: 'tune', hz: this.centerOf(0) }); }
  /** The radio has confirmed the frequency asked for: only the reads already in flight are stale now. */
  tuned(): void { if (!this.awaitingTune) return; this.awaitingTune = false; this.settle = Math.min(this.settle, INFLIGHT_STALE); }

  onIq(iq: Int8Array, rate: number): void {
    if (this.settle > 0) { this.settle--; return; }
    const nSamp = iq.length >> 1;
    // power-average every whole 1024-point frame in the buffer (32 at 64 KiB) so a slice is not one noisy shot
    this.acc.fill(0); let frames = 0;
    for (let off = 0; off + 1024 <= nSamp; off += 1024) { loadIqAt(iq, off, this.re, this.im, this.win); fft(this.re, this.im); accumulatePower(this.re, this.im, this.acc); frames++; }
    if (frames === 0) return;
    let sq = 0;
    for (let k = 0; k < frames * 2048; k++) sq += iq[k] * iq[k];
    this.peakSq = Math.max(this.peakSq, sq / (frames * 1024));
    powerDbFrom(this.acc, frames, this.slice);
    const c = SWEEP_BINS / 2;
    this.slice[c] = (this.slice[c - 2] + this.slice[c + 2]) * 0.5; this.slice[c - 1] = this.slice[c - 2]; this.slice[c + 1] = this.slice[c + 2];
    this.work.set(this.slice.subarray(KEEP0, KEEP1), this.step * SWEEP_KEEP);
    // Hand the slice we just measured up to the display right away, so the spectrum trace paints across the span as
    // the radio steps rather than sitting frozen until the whole pass finishes. The waterfall row still lands once
    // a full pass completes, below.
    const live = this.slice.slice(KEEP0, KEEP1);
    this.emit({ type: 'sweepLive', slice: live, step: this.step, steps: this.steps }, [live.buffer]);
    this.step++;
    if (this.step >= this.steps) {
      this.step = 0; this.sweeps++;
      const row = this.work.slice();
      const peakRms = Math.sqrt(this.peakSq); this.peakSq = 0;
      this.emit({ type: 'sweep', row, peakRms, steps: this.steps, sweeps: this.sweeps, startHz: this.startHz, endHz: this.startHz + this.steps * this.stepHz, binHz: this.binHz, progress: 0 }, [row.buffer]);
    } else this.emit({ type: 'sweepProgress', progress: this.step, steps: this.steps, sweeps: this.sweeps });
    this.emit({ type: 'tune', hz: this.centerOf(this.step) });
    const bufMs = nSamp * 1000 / rate;
    this.settle = Math.min(500, Math.max(2, Math.ceil(SETTLE_MS / bufMs)));
    this.awaitingTune = true;
  }
}
