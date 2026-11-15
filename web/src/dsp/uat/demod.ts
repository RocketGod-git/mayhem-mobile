/**
 * UAT receiver (978 MHz, DO-282B): 1.041667 Mbit/s binary CPFSK, modulation index 0.6, so the phase turns about
 * +-108 degrees across each bit. Ground uplinks (FIS-B weather, TIS-B traffic) open with the 36-bit sync 0x153225B1D
 * and carry 4416 bits (six interleaved RS(92,72) blocks); aircraft downlinks open with its complement 0xEACDDA4E2 and
 * carry a basic (RS(30,18)) or long (RS(48,34)) ADS-B frame.
 *
 * How. A wide span (8 or 20 Msps) is first boxcar-decimated to about 2 Msps; the channel is low-passed to +-700 kHz;
 * the result is resampled (linear interpolation) to exactly 4 samples a bit. The bit decision is the sign of the phase
 * change across one whole bit, Im(x[n+4] conj(x[n])), which needs no arctangent and is far steadier than a
 * sample-to-sample frequency estimate. The four sampling phases each feed a 36-bit shift register that is matched
 * against both sync words (up to four bit errors). A match on any phase schedules the frame; when its bits have
 * arrived they are sliced at that phase and, if the Reed-Solomon check fails, at the neighboring phases.
 */
import { type Emit, type IqProcessor } from '../core.js';
import { uplinkMessage, rsCorrect } from './rs.js';

export const UAT_HZ = 978_000_000;
export const UAT_BITRATE = 1_041_666.667;
const SPS = 4;
const SYNC_UP = 0x153225b1d;
const SYNC_DOWN = 0xeacdda4e2;
const UP_BITS = 4416;
const DOWN_LONG_BITS = 384, DOWN_BASIC_BITS = 240;
const MAX_SYNC_ERRS = 4;
const RING = 1 << 16;                 // sign history in 4-sps samples (about 15.7 ms, more than one uplink)

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
const SU_HI = Math.floor(SYNC_UP / 2 ** 32), SU_LO = SYNC_UP >>> 0;
const SD_HI = Math.floor(SYNC_DOWN / 2 ** 32), SD_LO = SYNC_DOWN >>> 0;

/** A decoded uplink: the 432-byte message (8-byte header + 424 bytes of information frames). */
export interface UatUplink { msg: Uint8Array; fixed: number; snrDb: number }
/** A decoded aircraft downlink: its bytes (18 or 34) and which kind. */
export interface UatDownlink { bytes: Uint8Array; long: boolean; fixed: number; snrDb: number }

interface Pending { at: number; kind: 'up' | 'down'; phase: number; snr: number }

export class UatReceiver {
  // decimation and channel filter state
  private rate = 0; private dec = 1; private accI = 0; private accQ = 0; private accN = 0;
  private lp: Float32Array = new Float32Array(1); private hI = new Float32Array(1); private hQ = new Float32Array(1); private hPos = 0;
  // resampler: input rate r2 -> 4 * bitrate
  private step = 1; private frac = 0; private lastI = 0; private lastQ = 0; private haveLast = false;
  // 4-sps history: complex samples (for the one-bit product), signs, power
  private yI = new Float32Array(RING); private yQ = new Float32Array(RING); private sgn = new Int8Array(RING); private pw = new Float32Array(RING);
  private n = 0;                                  // 4-sps samples produced so far
  private regHi = new Uint32Array(SPS); private regLo = new Uint32Array(SPS);
  private pending: Pending[] = [];
  private lastUpAt = -1e9; private lastDownAt = -1e9;
  private floor = 1;
  uplinks = 0; downlinks = 0; bad = 0;

  constructor(private readonly onUp: (u: UatUplink) => void, private readonly onDown: (d: UatDownlink) => void) {}

  reset(rate: number): void {
    this.rate = rate;
    this.dec = Math.max(1, Math.floor(rate / 2_000_000));
    const r2 = rate / this.dec;
    // 15-tap Hamming-windowed low-pass at 700 kHz (relative to r2)
    const taps = 15, cut = 700_000 / r2, m = taps - 1;
    this.lp = new Float32Array(taps);
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - m / 2, s = x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
      this.lp[k] = s * (0.54 - 0.46 * Math.cos(2 * Math.PI * k / m)); sum += this.lp[k];
    }
    for (let k = 0; k < taps; k++) this.lp[k] /= sum;
    this.hI = new Float32Array(taps); this.hQ = new Float32Array(taps); this.hPos = 0;
    this.step = r2 / (SPS * UAT_BITRATE);         // input samples per output sample (< 1: upsampling)
    this.frac = 0; this.haveLast = false; this.accI = this.accQ = 0; this.accN = 0;
    this.n = 0; this.regHi.fill(0); this.regLo.fill(0); this.pending = [];
    this.lastUpAt = this.lastDownAt = -1e9; this.floor = 1;
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const dec = this.dec, lp = this.lp, taps = lp.length;
    for (let k = 0; k + 1 < iq.length; k += 2) {
      // boxcar decimation to about 2 Msps
      this.accI += iq[k]; this.accQ += iq[k + 1];
      if (++this.accN < dec) continue;
      const xi = this.accI, xq = this.accQ;
      this.accI = this.accQ = 0; this.accN = 0;
      // channel filter
      this.hI[this.hPos] = xi; this.hQ[this.hPos] = xq;
      let fi = 0, fq = 0;
      for (let t = 0, p = this.hPos; t < taps; t++) { fi += lp[t] * this.hI[p]; fq += lp[t] * this.hQ[p]; p = p === 0 ? taps - 1 : p - 1; }
      this.hPos = this.hPos + 1 === taps ? 0 : this.hPos + 1;
      // resample to 4 samples a bit, by linear interpolation between this input and the last
      if (!this.haveLast) { this.lastI = fi; this.lastQ = fq; this.haveLast = true; continue; }
      while (this.frac < 1) {
        const a = this.frac;
        this.push(this.lastI + (fi - this.lastI) * a, this.lastQ + (fq - this.lastQ) * a);
        this.frac += this.step;
      }
      this.frac -= 1;
      this.lastI = fi; this.lastQ = fq;
    }
  }

  /** One 4-sps sample: the one-bit phase product, sync search, and any frame now complete. */
  private push(i: number, q: number): void {
    const n = this.n, w = n & (RING - 1);
    this.yI[w] = i; this.yQ[w] = q;
    const p = i * i + q * q;
    this.pw[w] = p;
    this.n = n + 1;
    if (n < SPS) { this.sgn[w] = 0; return; }
    // the bit that ended at this sample: Im(y[n] conj(y[n-4]))
    const b = (n - SPS) & (RING - 1);
    const im = q * this.yI[b] - i * this.yQ[b];
    const bit = im > 0 ? 1 : 0;
    this.sgn[w] = bit ? 1 : -1;
    // slow noise floor (median-ish: follows down fast, up slowly)
    this.floor = p < this.floor ? this.floor * 0.99 + p * 0.01 : this.floor * 0.99999 + p * 0.00001;
    const ph = n & (SPS - 1);
    let hi = this.regHi[ph], lo = this.regLo[ph];
    hi = ((hi << 1) | (lo >>> 31)) & 0xf;
    lo = ((lo << 1) | bit) >>> 0;
    this.regHi[ph] = hi; this.regLo[ph] = lo;
    const eu = popcount32((lo ^ SU_LO) >>> 0) + popcount32((hi ^ SU_HI) & 0xf);
    if (eu <= MAX_SYNC_ERRS && n - this.lastUpAt > 8 * SPS) {
      this.lastUpAt = n;
      this.pending.push({ at: n, kind: 'up', phase: ph, snr: this.snr(n) });
    } else {
      const ed = popcount32((lo ^ SD_LO) >>> 0) + popcount32((hi ^ SD_HI) & 0xf);
      if (ed <= MAX_SYNC_ERRS && n - this.lastDownAt > 8 * SPS) {
        this.lastDownAt = n;
        this.pending.push({ at: n, kind: 'down', phase: ph, snr: this.snr(n) });
      }
    }
    // frames whose bits are all in
    if (this.pending.length) {
      const due = this.pending[0];
      const need = due.kind === 'up' ? UP_BITS : DOWN_LONG_BITS;
      if (n >= due.at + need * SPS + 2) { this.pending.shift(); this.finish(due); }
    }
  }

  private snr(n: number): number {
    let s = 0;
    for (let k = 0; k < 36 * SPS; k++) s += this.pw[(n - k) & (RING - 1)];
    return 10 * Math.log10(s / (36 * SPS) / Math.max(1e-9, this.floor));
  }

  /** Bits after the sync at [at] (the sample of the sync's last bit) on the phase [off] samples away. */
  private bits(at: number, nbits: number, off: number): Uint8Array {
    const out = new Uint8Array(nbits >> 3);
    for (let k = 0; k < nbits; k++) {
      const s = this.sgn[(at + off + (k + 1) * SPS) & (RING - 1)];
      if (s > 0) out[k >> 3] |= 0x80 >> (k & 7);
    }
    return out;
  }

  private finish(f: Pending): void {
    for (const off of [0, -1, 1, -2, 2]) {
      if (f.kind === 'up') {
        const r = uplinkMessage(this.bits(f.at, UP_BITS, off));
        if (r) { this.uplinks++; this.onUp({ msg: r.msg, fixed: r.fixed, snrDb: f.snr }); return; }
      } else {
        const long = this.bits(f.at, DOWN_LONG_BITS, off);
        const nl = rsCorrect(long, 14);
        if (nl >= 0) { this.downlinks++; this.onDown({ bytes: long.subarray(0, 34), long: true, fixed: nl, snrDb: f.snr }); return; }
        const basic = this.bits(f.at, DOWN_BASIC_BITS, off);
        const nb = rsCorrect(basic, 12);
        if (nb >= 0) { this.downlinks++; this.onDown({ bytes: basic.subarray(0, 18), long: false, fixed: nb, snrDb: f.snr }); return; }
      }
    }
    this.bad++;
  }
}

/** The worker-side processor: decodes and hands every good frame to the interface. */
export class UatProcessor implements IqProcessor {
  private rx: UatReceiver;
  private lastStat = 0;
  constructor(private readonly emit: Emit) {
    this.rx = new UatReceiver(
      u => emit({ type: 'uatUp', msg: u.msg, fixed: u.fixed, snr: u.snrDb, at: Date.now() }, [u.msg.buffer]),
      d => emit({ type: 'uatDown', bytes: d.bytes.slice(), long: d.long, fixed: d.fixed, snr: d.snrDb, at: Date.now() }));
  }
  reset(rate: number): void { this.rx.reset(rate); }
  onIq(iq: Int8Array, rate: number): void {
    this.rx.onIq(iq, rate);
    const now = Date.now();
    if (now - this.lastStat > 1000) {
      this.lastStat = now;
      this.emit({ type: 'uatStat', uplinks: this.rx.uplinks, downlinks: this.rx.downlinks, bad: this.rx.bad });
    }
  }
}
