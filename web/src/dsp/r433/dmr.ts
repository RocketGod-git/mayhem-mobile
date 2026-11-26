/**
 * DMR bursts on a Devices channel, named for what they are.
 *
 * Two-way radios on DMR (ETSI TS 102 361) send 30 ms bursts of 4-level FSK at 4800 symbols a second, the outer
 * levels about ±1.94 kHz, so the whole burst is under 5 kHz wide. On 433 MHz they hop between a few 12.5 kHz
 * channels and look to the burst finder like an FSK sensor, but the shift is far too narrow for the sensor
 * slicers. This reads each channel the way a DMR receiver does: a narrow filter on the burst's own center, the
 * frequency at each symbol, and the 24-symbol sync word in the middle of the burst. A data burst's slot type
 * (color code and data type, Golay(20,8) protected) sits either side of that sync, so a burst is named only when
 * the sync matches and the slot type decodes. What the burst carries is left to Dispatch, which reads DMR in full.
 */

import { DMR_SYNC, golay208Decode, syncSigns } from '../fleet/codes.js';

/** Data types of the slot type field (TS 102 361-1, 9.3.6). 12 to 15 are reserved, and taken for a misread. */
export const DMR_DATA_TYPE = ['PI header', 'voice LC header', 'terminator with LC', 'CSBK', 'MBC header', 'MBC continuation',
  'data header', 'rate 1/2 data', 'rate 3/4 data', 'idle', 'rate 1 data', 'unified single block data'];

/** One data burst whose sync matched and whose slot type decoded. */
export interface DmrSeen {
  /** Color code, 0 to 15. */
  cc: number;
  /** Data type, an index into `DMR_DATA_TYPE`. */
  dt: number;
  /** Sent by a radio (mobile station sync) or by a repeater (base station sync). */
  from: 'radio' | 'repeater';
  /** The burst's center against the channel's, Hz. */
  offsetHz: number;
  /** Bits the Golay code corrected in the slot type. */
  errs: number;
  /** Where the sync word started, in channel samples since the reader was reset. */
  at: number;
}

const BAUD = 4800;
/** The rate the burst is read at: about ten samples a symbol. */
const READ_RATE = 50_000;
/** Kept and searched at most this much at a time; a full buffer is searched and its tail kept. */
const KEEP_S = 0.4;
/** The tail carried over, so a burst across the join is read whole. */
const TAIL_S = 0.04;
/** Sync correlation (signed, over the mean deviation of the 24 symbols) a burst must reach. */
const SYNC_MIN = 0.85;
const SYNCS: { from: 'radio' | 'repeater'; sig: Int8Array }[] = [
  { from: 'radio', sig: syncSigns(DMR_SYNC.msData) },
  { from: 'repeater', sig: syncSigns(DMR_SYNC.bsData) },
];

export class DmrSpot {
  private D = 5;
  private sps = 10.4;
  private zi = new Float32Array(0); private zq = new Float32Array(0);
  private n = 0;
  /** Channel samples before `zi[0]`. */
  private base = 0;
  /** Channel samples taken in since the reset. */
  private seen = 0;
  private ai = 0; private aq = 0; private acc = 0;
  /** Syncs before this (channel samples) were read already. */
  private doneTo = 0;

  reset(rate: number): void {
    this.D = Math.max(1, Math.round(rate / READ_RATE));
    const fs = rate / this.D;
    this.sps = fs / BAUD;
    const cap = Math.ceil(fs * KEEP_S);
    if (this.zi.length !== cap) { this.zi = new Float32Array(cap); this.zq = new Float32Array(cap); }
    this.n = 0; this.base = 0; this.seen = 0; this.ai = 0; this.aq = 0; this.acc = 0; this.doneTo = 0;
  }

  /** Take in a block of the channel's samples (interleaved I, Q); bursts found go to `out`. */
  push(iq: ArrayLike<number>, count: number, out: DmrSeen[]): void {
    const D = this.D;
    for (let k = 0; k < count; k++) {
      this.ai += iq[2 * k]; this.aq += iq[2 * k + 1];
      if (++this.acc < D) continue;
      this.acc = 0;
      if (this.n >= this.zi.length) this.scan(out, true);
      this.zi[this.n] = this.ai / D; this.zq[this.n] = this.aq / D; this.n++;
      this.ai = 0; this.aq = 0;
    }
    this.seen += count;
  }

  /** The channel closed: read what is left. */
  end(out: DmrSeen[]): void { this.scan(out, false); this.n = 0; }

  private scan(out: DmrSeen[], keepTail: boolean): void {
    const n = this.n, sps = this.sps, fs = sps * BAUD;
    if (n > 140 * sps) this.find(out, n, fs);
    if (keepTail) {
      const t = Math.min(n, Math.round(fs * TAIL_S));
      this.zi.copyWithin(0, n - t, n); this.zq.copyWithin(0, n - t, n);
      this.base += n - t; this.n = t;
    }
  }

  private find(out: DmrSeen[], n: number, fs: number): void {
    const zi = this.zi, zq = this.zq, sps = this.sps;
    // the burst's own center: the mean frequency where it is strong
    const p = new Float32Array(n);
    for (let k = 0; k < n; k++) p[k] = zi[k] * zi[k] + zq[k] * zq[k];
    const sorted = Float32Array.from(p).sort(), top = sorted[Math.floor(n * 0.9)];
    if (!(top > 0)) return;
    let sr = 0, sim = 0, cnt = 0;
    for (let k = 1; k < n; k++) {
      if (p[k] < top * 0.3 || p[k - 1] < top * 0.3) continue;
      sr += zi[k] * zi[k - 1] + zq[k] * zq[k - 1]; sim += zq[k] * zi[k - 1] - zi[k] * zq[k - 1]; cnt++;
    }
    if (cnt < 100 * sps) return;                      // less than a burst of signal here
    const off = Math.atan2(sim, sr) * fs / (2 * Math.PI);
    // mix it to zero, a 16 kHz boxcar, the discriminator, then the frequency summed over one symbol (the phase it turned)
    const L1 = Math.max(1, Math.round(fs / 16_000)), L2 = Math.max(1, Math.round(fs / BAUD));
    const f = new Float32Array(n), w = -2 * Math.PI * off / fs;
    let si = 0, sq = 0, pi = 0, pq = 0, fsum = 0;
    const bi = new Float32Array(L1), bq = new Float32Array(L1), bf = new Float32Array(L2);
    for (let k = 0; k < n; k++) {
      const c = Math.cos(w * k), s = Math.sin(w * k), I = zi[k] * c - zq[k] * s, Q = zi[k] * s + zq[k] * c;
      si += I - bi[k % L1]; sq += Q - bq[k % L1]; bi[k % L1] = I; bq[k % L1] = Q;
      const v = Math.atan2(sq * pi - si * pq, si * pi + sq * pq) * fs / (2 * Math.PI);
      pi = si; pq = sq;
      fsum += v - bf[k % L2]; bf[k % L2] = v;
      f[k] = fsum / L2;
    }
    const at = (x: number) => f[Math.min(n - 1, Math.max(0, Math.round(x)))];
    const first = Math.ceil(54 * sps) + L1 + L2, last = n - Math.ceil(78 * sps);
    for (let x = first; x < last; x++) {
      if (this.base + x < this.doneTo) continue;
      if (p[Math.round(x)] < top * 0.1) continue;
      for (const S of SYNCS) {
        const r = this.corr(at, x, S.sig);
        if (r < SYNC_MIN) continue;
        // the best alignment close by
        let bx = x, br = r;
        for (let d = 1; d <= Math.ceil(sps / 2); d++) { const r2 = this.corr(at, x + d, S.sig); if (r2 > br) { br = r2; bx = x + d; } }
        let m = 0; for (let i = 0; i < 24; i++) m += at(bx + i * sps); m /= 24;
        let lvl = 0; for (let i = 0; i < 24; i++) lvl += (at(bx + i * sps) - m) * S.sig[i]; lvl /= 24;
        if (lvl <= 0) continue;
        // DMR holds its carrier: an on-off keyed burst, whose spaces read as noise, is not one
        let held = true;
        for (let k = Math.max(0, Math.round(bx - 5 * sps)), e = Math.min(n, Math.round(bx + 29 * sps)); k < e && held; k++) held = p[k] >= top * 0.1;
        if (!held) break;
        // dibits 61 to 65 and 90 to 94 of the 144-dibit burst (sync at 66): the 20-bit slot type
        const dib = (j: number) => { const v = (at(bx + (j - 66) * sps) - m) / lvl * 3; return v >= 2 ? 1 : v >= 0 ? 0 : v >= -2 ? 2 : 3; };
        let st = 0;
        for (let j = 61; j <= 65; j++) st = (st << 2) | dib(j);
        for (let j = 90; j <= 94; j++) st = (st << 2) | dib(j);
        const g = golay208Decode(st >>> 0);
        if (g && g.errs <= 2 && (g.data & 15) < DMR_DATA_TYPE.length) {
          out.push({ cc: g.data >> 4, dt: g.data & 15, from: S.from, offsetHz: Math.round(off), errs: g.errs, at: (this.base + bx) * this.D });
          this.doneTo = this.base + bx + Math.round(100 * sps);
          x = bx + Math.round(100 * sps);
        }
        break;
      }
    }
  }

  private corr(at: (x: number) => number, x: number, sig: Int8Array): number {
    let m = 0; for (let i = 0; i < 24; i++) m += at(x + i * this.sps); m /= 24;
    let c = 0, a = 0;
    for (let i = 0; i < 24; i++) { const v = at(x + i * this.sps) - m; c += v * sig[i]; a += Math.abs(v); }
    return a > 0 ? c / a : 0;
  }
}
