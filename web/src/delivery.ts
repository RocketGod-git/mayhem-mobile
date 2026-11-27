/**
 * How much of what a radio sends arrives: samples delivered against wall time, for the HackRF and RTL-SDR drivers.
 *
 * A radio read too late overflows and drops samples with no error at all. At 20 Msps many hosts lose a few 64 KiB
 * reads a second that way, and one gap ruins any frame it lands in.
 *
 * The lag (samples the clock says were sent, less those delivered) rises while the reads are late and falls back as
 * they arrive. Lost samples never arrive, so they lift its floor for good. When the lowest lag over a settling time
 * stands clear above the floor, that is a gap, placed where the lag first came down to its new level.
 */

/** A gap: samples lost, samples delivered since it, and how far either side it may really be. */
export interface Gap { lost: number; back: number; slack: number }

/** Delivery under this share is losing samples (about one 64 KiB read in 30 s at 20 Msps). */
export const DELIVERY_OK = 0.999;

export class DeliveryMeter {
  private rate = 0;
  private t0 = 0;
  private delivered = 0;
  private floor = 0;
  private settleMs = 300;
  private buf = 32_768;
  /** Recent buffers: [ms, delivered before it, lag after it]. */
  private hist: [number, number, number][] = [];
  /** Recent gaps: [ms, samples lost]. */
  private losses: [number, number][] = [];
  /** Samples lost since the last restart. */
  lostTotal = 0;
  /** Gaps since the last restart. */
  gaps = 0;

  /** Watched from here: the stream (re)started at `rate`, with `inflight` samples of reads queued at most and
   *  buffers of `buf` samples. Call after bring-up, a rate change, or any pause the driver makes on purpose. */
  restart(rate: number, now: number, inflight = 262_144, buf = 32_768): void {
    this.rate = rate; this.t0 = now; this.delivered = 0; this.floor = Infinity;
    this.buf = Math.max(1, buf);
    // a stall shorter than the reads queued loses nothing, so the lag may stand up that long without a gap
    this.settleMs = Math.max(300, 1.5 * 1000 * inflight / Math.max(1, rate) + 100);
    this.hist = []; this.losses = []; this.lostTotal = 0; this.gaps = 0;
  }

  /** How long this rate has been watched (ms). */
  measuredMs(now: number): number { return this.rate > 0 ? now - this.t0 : 0; }

  /** The share of samples delivered over the last `windowMs` (1: none lost). */
  share(now: number, windowMs = 10_000): number {
    const span = Math.min(windowMs, now - this.t0);
    if (this.rate <= 0 || span <= 0) return 1;
    let lost = 0;
    for (const [t, n] of this.losses) if (now - t <= windowMs) lost += n;
    return Math.max(0, 1 - lost / (this.rate * span / 1000));
  }

  /** Losing samples: watched at least `minMs` at this rate, and delivering under DELIVERY_OK. */
  losing(now: number, minMs = 5000): boolean { return this.measuredMs(now) >= minMs && this.share(now) < DELIVERY_OK; }

  /** A buffer of `n` samples arrived at `now` (ms). Returns the gap found, if any. */
  push(n: number, now: number): Gap | null {
    if (this.rate <= 0) return null;
    const before = this.delivered;
    this.delivered += n;
    const lag = this.rate * (now - this.t0) / 1000 - this.delivered;
    this.hist.push([now, before, lag]);
    while (this.hist.length > 0 && now - this.hist[0][0] > 2 * this.settleMs) this.hist.shift();
    // a host clock running slow, or a late first read, lowers the floor
    if (lag < this.floor) this.floor = lag;
    if (now - this.t0 < this.settleMs || now - this.hist[0][0] < this.settleMs) return null;
    let low = Infinity;
    for (const h of this.hist) if (now - h[0] <= this.settleMs && h[2] < low) low = h[2];
    const up = low - this.floor;
    const thr = Math.max(4096, this.buf / 4);
    if (up < thr) {
      // the radio's crystal against the host's clock: a slow drift, followed
      if (up > 0) this.floor += 0.02 * up;
      return null;
    }
    // after the last buffer still at the old floor, the first one down at the new level came after the gap (or is
    // the last one queued before it: the slack covers that)
    const tol = Math.min(up, this.buf) / 2;
    let j = -1;
    for (let i = 0; i < this.hist.length; i++) if (this.hist[i][2] < this.floor + tol) j = i;
    let at = before;
    for (let i = j + 1; i < this.hist.length; i++) if (this.hist[i][2] <= low + tol) { at = this.hist[i][1]; break; }
    const lost = Math.round(up);
    this.floor = low;
    this.lostTotal += lost; this.gaps++;
    this.losses.push([now, lost]);
    while (this.losses.length > 0 && now - this.losses[0][0] > 60_000) this.losses.shift();
    return { lost, back: this.delivered - at, slack: 2 * this.buf };
  }

  /** For a health line: '' while nothing is lost, else what share went missing lately. */
  note(now: number): string {
    const s = this.share(now);
    if (s >= 1) return '';
    const pct = (1 - s) * 100;
    return `radio lost ${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}% of samples`;
  }
}
