/**
 * The frame both Inmarsat receivers share: a block of 64 rows sent one after another, each row opening with unique
 * word symbols (one UW bit a row, sent once or twice, never scrambled) and then its share of the coded data. The
 * coded symbols fill the table column by column and the rows go out in the order (i × 73) mod 64. The data is
 * scrambled, then coded with the rate 1/2, K = 7 code (the Meteor decoder's Viterbi, dsp/ham/lrpt-fec.ts), its last
 * byte zeros to flush the coder. The scrambler is x^8 + x^6 + x^5 + x^4 + 1 (Galois, 0xB8) from 0x80, restarted
 * every frame: 0x80, not the 0x40 some write-ups give.
 *
 * Twins: core/sat/LbandFrame.kt and core/sat/LbandFrame.swift.
 */
import { G1, G2, K, Viterbi } from '../ham/lrpt-fec.js';

export const ROWS = 64;
export const SCRAMBLER_SEED = 0x80;

/** One kind of frame: its unique word, how many times each UW bit is sent, and the coded symbols a row. */
export interface FrameLayout { uw: number[]; uwPerRow: number; cols: number }
export const frameSymbols = (l: FrameLayout) => ROWS * (l.uwPerRow + l.cols);
/** Data bytes a frame carries, the flush byte included. */
export const frameBytes = (l: FrameLayout) => (ROWS * l.cols) / 16;

/** A 64-bit unique word from two 32-bit halves, first bit sent = most significant. */
export function uwBits(hi: number, lo: number): number[] {
  const out: number[] = [];
  for (let i = 31; i >= 0; i--) out.push((hi >>> i) & 1);
  for (let i = 31; i >= 0; i--) out.push((lo >>> i) & 1);
  return out;
}

/** The row of the table sent in place i. */
export const rowOrder = (i: number) => (i * 73) % ROWS;

/** The scrambler's bytes for one frame. */
export function scramblerBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = SCRAMBLER_SEED;
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) { const o = s & 1; b = (b << 1) | o; s >>= 1; if (o) s ^= 0xB8; }
    out[i] = b;
  }
  return out;
}

function parity(x: number): number { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; }

/** Transmitter side (tests, tools): data bytes (frameBytes - 1 of them) to the frame's symbols, ±1. */
export function buildFrame(l: FrameLayout, data: Uint8Array): Int8Array {
  const nb = frameBytes(l), sc = scramblerBytes(nb - 1), bits = new Uint8Array(8 * nb);
  for (let i = 0; i < nb - 1; i++) { const v = (data[i] ?? 0) ^ sc[i]; for (let j = 0; j < 8; j++) bits[8 * i + j] = (v >> (7 - j)) & 1; }
  const coded = new Uint8Array(2 * bits.length);
  let st = 0;
  for (let i = 0; i < bits.length; i++) {
    st = ((st >> 1) | (bits[i] << (K - 1))) & ((1 << K) - 1);
    coded[2 * i] = parity(st & G1); coded[2 * i + 1] = parity(st & G2);
  }
  const rowLen = l.uwPerRow + l.cols, out = new Int8Array(ROWS * rowLen);
  for (let i = 0; i < ROWS; i++) {
    const r = rowOrder(i);
    for (let j = 0; j < l.uwPerRow; j++) out[i * rowLen + j] = l.uw[i] ? 1 : -1;
    for (let c = 0; c < l.cols; c++) out[i * rowLen + l.uwPerRow + c] = coded[c * ROWS + r] ? 1 : -1;
  }
  return out;
}

/**
 * Finds frames in a stream of soft symbols by their unique word (either polarity) and decodes each: de-interleave,
 * Viterbi, descramble. `onFrame` gets the data bytes (without the flush byte), the UW match (0..1) and the share of
 * coded bits the Viterbi path disagreed with.
 */
export class FrameSync {
  frames = 0;
  private readonly n: number; private readonly rowLen: number; private readonly mask: number;
  private readonly ring: Float32Array; private k = 0;
  private hold = 0; private pend = -1; private pendScore = 0; private pendSign = 1;
  private readonly vit: Viterbi; private readonly soft: Int8Array; private readonly out: Uint8Array; private readonly sc: Uint8Array;
  private readonly uwAt: number[] = [];

  constructor(private readonly l: FrameLayout, private readonly onFrame: (data: Uint8Array, score: number, ber: number) => void, private readonly threshold = 0.6) {
    this.n = frameSymbols(l); this.rowLen = l.uwPerRow + l.cols;
    let size = 1; while (size < 2 * this.n) size <<= 1;
    this.ring = new Float32Array(size); this.mask = size - 1;
    const bits = 32 * l.cols;
    this.vit = new Viterbi(bits); this.soft = new Int8Array(2 * bits); this.out = new Uint8Array(bits / 8);
    this.sc = scramblerBytes(bits / 8 - 1);
    for (let i = 0; i < ROWS; i++) for (let j = 0; j < l.uwPerRow; j++) this.uwAt.push(i * this.rowLen + j);
  }

  reset(): void { this.k = 0; this.hold = 0; this.pend = -1; this.ring.fill(0); }

  push(x: number): void {
    this.ring[this.k & this.mask] = x;
    this.k++;
    if (this.k < this.n) return;
    const s = this.k - this.n;
    if (this.pend >= 0 && s - this.pend >= 4) { this.decode(this.pend, this.pendSign, this.pendScore); this.hold = this.pend + this.n - 8; this.pend = -1; }
    if (s < this.hold) return;
    const [score, sign] = this.score(s);
    if (score >= this.threshold && (this.pend < 0 || score > this.pendScore)) { this.pend = s; this.pendScore = score; this.pendSign = sign; }
  }

  private score(s: number): [number, number] {
    const r = this.ring, m = this.mask, uw = this.l.uw, per = this.l.uwPerRow;
    let c = 0, a = 0;
    for (let q = 0; q < this.uwAt.length; q++) {
      const x = r[(s + this.uwAt[q]) & m];
      c += uw[(q / per) | 0] ? x : -x; a += x < 0 ? -x : x;
    }
    const v = a > 0 ? c / a : 0;
    return [Math.abs(v), v < 0 ? -1 : 1];
  }

  private decode(s: number, sign: number, score: number): void {
    const r = this.ring, m = this.mask, l = this.l, soft = this.soft;
    // the scale for the Viterbi's int8 values: the mean size of a data symbol
    let a = 0;
    for (let i = 0; i < this.n; i++) a += Math.abs(r[(s + i) & m]);
    const g = 40 / ((a / this.n) || 1);
    for (let i = 0; i < ROWS; i++) {
      const row = rowOrder(i), base = s + i * this.rowLen + l.uwPerRow;
      for (let c = 0; c < l.cols; c++) {
        const v = Math.round(sign * r[(base + c) & m] * g);
        soft[c * ROWS + row] = v > 127 ? 127 : v < -127 ? -127 : v;
      }
    }
    const ber = this.vit.decode(soft, this.out);
    const data = new Uint8Array(this.out.length - 1);
    for (let i = 0; i < data.length; i++) data[i] = this.out[i] ^ this.sc[i];
    this.frames++;
    this.onFrame(data, score, ber);
  }
}
