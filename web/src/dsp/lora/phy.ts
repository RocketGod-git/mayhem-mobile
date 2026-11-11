/**
 * A LoRa receiver for complex baseband at the channel's own bandwidth (one sample a chip). Port of
 * core/lora/LoraPhy.swift: same algorithms and constants.
 */
import { fft } from '../../fft.js';

/** One LoRa frame as it came off the air. */
export interface LoraFrame {
  sf: number;
  bw: number;
  cr: number;
  /** The payload (the CRC removed), and whether its CRC checked out (null: sent without one). */
  payload: Uint8Array;
  crcOk: boolean | null;
  /** Frequency error in Hz, signal-to-noise of the dechirped peaks in dB, the two sync-word symbols. */
  cfoHz: number;
  snrDb: number;
  sync: number[];
}

export interface LoraHeader { len: number; cr: number; crc: boolean; rest: number[] }

/** Swift's `.rounded()`: to nearest, halves away from zero. */
export const roundAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/**
 * The bit-level steps of LoRa as the open receivers (gr-lora_sdr) document them, checked against real Meshtastic
 * packets: symbol = (FFT peak - 1) mod 2^SF, divided by 4 (rounded) in the header and in low-data-rate mode,
 * Gray coded s ^ (s >> 1), written into a diagonal interleaver (row (i - j - 1) mod sf_app), four data bits of each
 * Hamming codeword taken from bits 3, 2, 1, 0, nibbles low first, whitened with an LFSR that steps once a byte, and a
 * CRC-16/CCITT over all but the last two payload bytes, then folded with them.
 */
export const LoraCodec = {
  whitening: ((): Uint8Array => {
    const out = new Uint8Array(256);
    let s = 0xff;
    for (let i = 0; i < 256; i++) {
      out[i] = s;
      const b = ((s >> 7) ^ (s >> 5) ^ (s >> 4) ^ (s >> 3)) & 1;
      s = ((s << 1) | b) & 0xff;
    }
    return out;
  })(),

  headerChecksum(n: number[]): number {
    const bit = (x: number, i: number): number => (x >> i) & 1;
    const a = n[0], b = n[1], c = n[2];
    const c4 = bit(a, 3) ^ bit(a, 2) ^ bit(a, 1) ^ bit(a, 0);
    const c3 = bit(a, 3) ^ bit(b, 3) ^ bit(b, 2) ^ bit(b, 1) ^ bit(c, 0);
    const c2 = bit(a, 2) ^ bit(b, 3) ^ bit(b, 0) ^ bit(c, 3) ^ bit(c, 1);
    const c1 = bit(a, 1) ^ bit(b, 2) ^ bit(b, 0) ^ bit(c, 2) ^ bit(c, 1) ^ bit(c, 0);
    const c0 = bit(a, 0) ^ bit(b, 1) ^ bit(c, 3) ^ bit(c, 2) ^ bit(c, 1) ^ bit(c, 0);
    return (c4 << 4) | (c3 << 3) | (c2 << 2) | (c1 << 1) | c0;
  },

  /** cw_len symbols of sfApp bits into sfApp nibbles. */
  block(syms: number[], sfApp: number, cwLen: number): number[] {
    const cw: number[][] = [];
    for (let r = 0; r < sfApp; r++) cw.push(new Array<number>(cwLen).fill(0));
    for (let i = 0; i < syms.length; i++) {
      const s = syms[i], g = s ^ (s >> 1);
      for (let j = 0; j < sfApp; j++) {
        const bit = (g >> (sfApp - 1 - j)) & 1;
        cw[(((i - j - 1) % sfApp) + sfApp) % sfApp][i] = bit;
      }
    }
    return cw.map(r => (r[3] << 3) | (r[2] << 2) | (r[1] << 1) | r[0]);
  },

  crc16(d: ArrayLike<number>, from = 0, to = d.length): number {
    let c = 0;
    for (let k = from; k < to; k++) {
      c ^= d[k] << 8;
      for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  },

  /** Header fields from the first block's symbols (already reduced to sf-2 bits): length, cr, crc flag; null when
   *  the header checksum fails. */
  header(syms: number[], sf: number): LoraHeader | null {
    const n = LoraCodec.block(syms.slice(0, 8), sf - 2, 8);
    const len = (n[0] << 4) | n[1], cr = n[2] >> 1, crc = (n[2] & 1) === 1;
    if (LoraCodec.headerChecksum(n) !== (((n[3] & 1) << 4) | n[4]) || len === 0 || cr < 1 || cr > 4) return null;
    return { len, cr, crc, rest: n.slice(5) };
  },

  /** Payload bytes from all the symbols (header block first), given the header. */
  payload(syms: number[], sf: number, ldro: boolean, h: LoraHeader): { data: Uint8Array; ok: boolean | null } | null {
    let nib = h.rest.slice();
    const need = 2 * (h.len + (h.crc ? 2 : 0));
    const cwLen = 4 + h.cr, sfApp = ldro ? sf - 2 : sf;
    let p = 8;
    while (nib.length < need) {
      if (p + cwLen > syms.length) return null;
      const blk = syms.slice(p, p + cwLen).map(v => (ldro ? (Math.trunc((v + 2) / 4) % (1 << (sf - 2))) : v));
      nib = nib.concat(LoraCodec.block(blk, sfApp, cwLen));
      p += cwLen;
    }
    const by = new Uint8Array(need / 2);
    for (let i = 0; i < need / 2; i++) by[i] = nib[2 * i] | (nib[2 * i + 1] << 4);
    const data = new Uint8Array(h.len);
    for (let i = 0; i < h.len; i++) data[i] = by[i] ^ LoraCodec.whitening[i % 256];
    if (!h.crc) return { data, ok: null };
    let c = LoraCodec.crc16(data, 0, Math.max(0, h.len - 2));
    if (h.len >= 2) c ^= data[h.len - 1] ^ (data[h.len - 2] << 8);
    const rx = by[h.len] | (by[h.len + 1] << 8);
    return { data, ok: c === rx };
  },

  /** How many symbols a frame of this header takes (the header block included). */
  symbolCount(sf: number, ldro: boolean, h: LoraHeader): number {
    const need = 2 * (h.len + (h.crc ? 2 : 0)) - h.rest.length;
    const perBlock = ldro ? sf - 2 : sf;
    const blocks = need <= 0 ? 0 : Math.floor((need + perBlock - 1) / perBlock);
    return 8 + blocks * (4 + h.cr);
  },
};

interface Pending { p: number; c: number; sfd: number; sync: number[]; snr: number }

const THRESH = 12;

/**
 * A streaming LoRa receiver for one channel: complex samples at exactly the bandwidth (one per chip) go in, frames
 * come out. It dechirps window after window; a run of matching peaks is a preamble; the up-chirp peak and the
 * start-of-frame down-chirp peak, both read on the same window grid, give the timing (where the symbols really
 * start) and the frequency error; then the header, its length, and the payload.
 */
export class LoraReceiver {
  readonly ldro: boolean;
  private readonly n: number;
  private readonly up: Float32Array;     // interleaved chirps
  private readonly down: Float32Array;
  private buf = new Float32Array(0);    // interleaved complex; the first `len` floats are in use
  private len = 0;
  private base = 0;                      // absolute index of buf[0] (in samples)
  private grid = 0;                      // absolute position of the next window to look at
  private run: { pos: number; k: number }[] = [];
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  onFrame: ((f: LoraFrame) => void) | null = null;
  /** Debug: each stage of each frame attempt. */
  trace: ((s: string) => void) | null = null;
  private pending: Pending | null = null;

  constructor(readonly sf: number, readonly bw: number, ldro?: boolean) {
    const n = 1 << sf;
    this.n = n;
    // low data rate optimization: on when a symbol lasts 16 ms or more
    this.ldro = ldro ?? (n / bw >= 0.016);
    this.up = new Float32Array(2 * n); this.down = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      const ph = 2 * Math.PI * ((i * i) / (2 * n) - i / 2);
      const c = Math.cos(ph), s = Math.sin(ph);
      this.up[2 * i] = c; this.up[2 * i + 1] = s; this.down[2 * i] = c; this.down[2 * i + 1] = -s;
    }
    this.re = new Float32Array(n); this.im = new Float32Array(n);
  }

  /** Peak bin and its height over the mean, of the window at absolute sample `at`, times `chirp`, with a frequency
   *  correction of `c` bins. */
  private peak(at: number, chirp: Float32Array, c = 0): [number, number] {
    const n = this.n, buf = this.buf, re = this.re, im = this.im;
    const o = (at - this.base) * 2;
    const w = -2 * Math.PI * c / n;
    for (let i = 0; i < n; i++) {
      let xr = buf[o + 2 * i], xi = buf[o + 2 * i + 1];
      if (c !== 0) { const cr = Math.fround(Math.cos(w * i)), ci = Math.fround(Math.sin(w * i)); const t = xr * cr - xi * ci; xi = xr * ci + xi * cr; xr = t; }
      re[i] = xr * chirp[2 * i] - xi * chirp[2 * i + 1];
      im[i] = xr * chirp[2 * i + 1] + xi * chirp[2 * i];
    }
    fft(re, im);
    let best = 0, bv = -1, sum = 0;
    for (let i = 0; i < n; i++) { const m = re[i] * re[i] + im[i] * im[i]; sum += m; if (m > bv) { bv = m; best = i; } }
    // over the mean of the other bins (the noise): a clean strong peak is N x the signal-to-noise ratio, not N
    return [best, bv / Math.max((sum - bv) / (n - 1), 1e-12)];
  }

  /** The peak's position to a fraction of a bin (Jacobsen's estimator on the complex bins around it), signed. */
  private peakFrac(at: number, chirp: Float32Array, c: number): number {
    const n = this.n, re = this.re, im = this.im;
    const [k] = this.peak(at, chirp, c);
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    // (X[k-1] - X[k+1]) / (2 X[k] - X[k-1] - X[k+1]), real part
    const nr = re[a] - re[b], ni = im[a] - im[b];
    const dr = 2 * re[k] - re[a] - re[b], di = 2 * im[k] - im[a] - im[b];
    const den = dr * dr + di * di;
    const d = den > 0 ? (nr * dr + ni * di) / den : 0;
    let v = k + Math.max(-0.5, Math.min(0.5, d));
    if (v > n / 2) v -= n;
    return v;
  }

  private get end(): number { return this.base + this.len / 2; }

  push(x: ArrayLike<number>, count = x.length): void {
    if (this.len + count > this.buf.length) {
      const nb = new Float32Array(Math.max(this.len + count, this.buf.length * 2, 4 * this.n));
      nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
    }
    const buf = this.buf;
    for (let i = 0; i < count; i++) buf[this.len + i] = x[i];
    this.len += count;
    this.work();
    // keep what an unfinished frame or the next look still needs, and a second of history at most
    const keepFrom = Math.min(this.pending?.p ?? this.grid, this.run[0]?.pos ?? this.grid, this.grid) - this.n;
    const drop = keepFrom - this.base;
    if (drop > 4 * this.n) { buf.copyWithin(0, drop * 2, this.len); this.len -= drop * 2; this.base += drop; }
  }

  private work(): void {
    const n = this.n;
    for (;;) {
      if (this.pending) {
        if (!this.finish(this.pending)) return;
        continue;
      }
      if (this.grid + n > this.end) return;
      const [k, q] = this.peak(this.grid, this.down);
      const last = this.run[this.run.length - 1];
      if (q > THRESH && last && this.near(k, last.k, 2)) {
        this.run.push({ pos: this.grid, k });
      } else {
        if (this.run.length >= 6) {
          // the preamble has ended: wait until the start-of-frame is in, then solve it
          if (this.run[this.run.length - 1].pos + 8 * n > this.end) return;
          this.startFrame();
          if (this.pending) continue;
        }
        this.run = q > THRESH ? [{ pos: this.grid, k }] : [];
      }
      this.grid += n;
    }
  }

  private near(a: number, b: number, t: number): boolean { const n = this.n, d = (((a - b) % n) + n) % n; return Math.min(d, n - d) <= t; }

  /** A preamble just ended: find the down-chirps on the same grid, solve timing and frequency. */
  private startFrame(): void {
    const n = this.n, run = this.run;
    const p0 = run[0].pos, k1 = run[Math.floor(run.length / 2)].k;
    const last = run[run.length - 1].pos;
    let bestQ = 0, k2 = -1;
    for (let m = 1; m <= 6; m++) { const [k, q] = this.peak(last + m * n, this.up); if (q > bestQ) { bestQ = q; k2 = k; } }
    this.run = [];
    this.trace?.(`preamble ${p0} k1 ${k1} k2 ${k2} q2 ${bestQ}`);
    if (bestQ < THRESH) return;
    const sols: [number, number, number][] = [];
    for (const half of [0, n / 2]) {
      let c = ((k1 + k2) / 2 + half) % n; if (c > n / 2) c -= n;
      const d = ((k2 - k1) / 2 + half) % n;
      sols.push([Math.abs(c), c, d < 0 ? d + n : d]);
    }
    let pick = sols[0];
    for (const s of sols) if (s[0] < pick[0]) pick = s;
    const [, c, d] = pick;
    // which way round the delay goes: the one that puts the preamble on bin c
    let best: [number, number] | null = null;
    for (const dd of [d, d - n]) {
      const p = p0 + roundAway(dd);
      if (p - this.base < 0 || p + 6 * n > this.end) continue;
      let score = 0;
      for (let m = 1; m <= 4; m++) { const [k] = this.peak(p + m * n, this.down, c); if (this.near(k, 0, 1)) score++; }
      if (best === null || score > best[0]) best = [score, p];
    }
    this.trace?.(`align c ${c} d ${d} best ${best ? `(${best[0]}, ${best[1]})` : 'nil'}`);
    if (!best || best[0] < 3) return;
    const p = best[1];
    // what is left once the whole bins are taken out: the frequency error's fraction and the timing's, which the
    // data symbols (up-chirps, like the preamble) carry exactly as the preamble does
    let r = 0;
    for (let m = 1; m <= 4; m++) r += this.peakFrac(p + m * n, this.down, c);
    const cf = c + r / 4;
    this.trace?.(`fraction ${r / 4}`);
    // the start-of-frame: the first aligned window whose up-dechirp sits on bin 0
    let m = 1;
    while (m < 30) {
      if (p + (m + 1) * n > this.end) return;
      const [k, q] = this.peak(p + m * n, this.up, cf);
      if (q > THRESH && this.near(k, 0, 2)) break;
      m++;
    }
    this.trace?.(`sfd m ${m}`);
    if (m >= 30) return;
    const sync = [2, 1].map(j => this.peak(p + (m - j) * n, this.down, cf)[0]);
    // the dechirped peak over the noise bins is 1 + N x the signal-to-noise ratio (power, per sample)
    const pq = this.peak(p + 2 * n, this.down, cf)[1];
    this.pending = { p, c: cf, sfd: p + m * n, sync, snr: 10 * Math.log10(Math.max(pq - 1, 1e-3) / n) };
  }

  /** Decode the frame once enough samples are in; false while waiting. */
  private finish(pd: Pending): boolean {
    const n = this.n, sf = this.sf;
    const start = pd.sfd + Math.floor((9 * n) / 4);
    if (start + 8 * n > this.end) return false;
    // the frequency estimate first, then a little either side of it: the frame's own CRC says which was right
    // (a strong or clipped signal can leave the estimate a quarter or half a bin out)
    let fallback: LoraFrame | null = null;
    let consumed = start;
    for (const dc of [0, -0.5, 0.5, -0.25, 0.25]) {
      const c = pd.c + dc;
      const sym = (i: number): number => (((this.peak(start + i * n, this.down, c)[0] - 1) % n) + n) % n;
      // reduced to sf-2 bits by rounding, not truncating: a fraction of a bin of timing or frequency error puts
      // a peak one bin either side of its multiple of 4
      const hs: number[] = [];
      for (let i = 0; i < 8; i++) hs.push(Math.floor((sym(i) + 2) / 4) % (n / 4));
      if (dc === 0) this.trace?.(`header syms [${hs.join(', ')}]`);
      const h = LoraCodec.header(hs, sf);
      if (!h) continue;
      const total = LoraCodec.symbolCount(sf, this.ldro, h);
      if (start + total * n > this.end) {
        if (dc === 0) this.trace?.(`waiting for ${start + total * n - this.end} of ${total} symbols, base ${this.base} buf ${this.len / 2}`);
        return false;
      }
      const syms = hs.slice();
      for (let i = 8; i < total; i++) syms.push(sym(i));
      const res = LoraCodec.payload(syms, sf, this.ldro, h);
      if (!res) continue;
      consumed = Math.max(consumed, start + total * n);
      const f: LoraFrame = { sf, bw: this.bw, cr: h.cr, payload: res.data, crcOk: res.ok, cfoHz: c * this.bw / n, snrDb: pd.snr, sync: pd.sync };
      if (res.ok !== false) {
        this.trace?.(`frame at correction ${dc}`);
        this.pending = null; this.grid = Math.max(this.grid, start + total * n);
        this.onFrame?.(f);
        return true;
      }
      // (the Swift's `if ok == nil { break }` here can never run: a frame without a CRC has already returned)
      if (!fallback) fallback = f;
    }
    this.pending = null;
    this.grid = Math.max(this.grid, consumed);
    if (fallback) this.onFrame?.(fallback);
    return true;
  }
}
