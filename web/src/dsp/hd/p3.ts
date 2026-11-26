/**
 * The P3 and P4 logical channels of service modes MP2, MP3 and MP11 (SY_IDD_1011s): the PX1 and PX2 partitions on
 * the extended subcarriers, Interleaver IV (10.2.6, Tables 10-15, 10-16), the rate 1/2 code (9.3.4.3), the scrambler.
 */
import { TbViterbi, descramble, encode } from './fec.js';
import { pduFromFrame, type L2Pdu } from './l2.js';

const C = 36, B = 32, BK_BITS = 32 * C, BK_ADJ = 32 * C - 1;
/** Transfer frames per Interleaver IV cycle. */
export const P3_CYCLE = 16;

/** PX1 column to subcarrier and I (0) or Q (1) rail, for `ext` extended partitions per sideband (Tables 12-4, 12-5). */
export function pxColumns(ext: number): { sc: Int16Array; iq: Uint8Array } {
  const J = 2 * ext, sc = new Int16Array(J * C), iq = new Uint8Array(J * C);
  for (let p = 0; p < J; p++) {
    const start = p < ext ? -355 + 19 * p : 357 - 19 * (J - p);
    for (let c = 0; c < C; c++) { sc[p * C + c] = start + (c >> 1); iq[p * C + c] = c & 1; }
  }
  return { sc, iq };
}

/** PX2 (P4, mode MP11) column to subcarrier and rail (Table 12-6). */
export function px2Columns(): { sc: Int16Array; iq: Uint8Array } {
  const sc = new Int16Array(4 * C), iq = new Uint8Array(4 * C);
  for (let p = 0; p < 4; p++) { const start = p < 2 ? -317 + 19 * p : 281 + 19 * (p - 2); for (let c = 0; c < C; c++) { sc[p * C + c] = start + (c >> 1); iq[p * C + c] = c & 1; } }
  return { sc, iq };
}

/** Interleaver IV write address of every input bit over one cycle (row * J * C + column of the internal matrix). */
function writeAddr(J: number): Int32Array {
  const M = J === 2 ? 4 : 2, cols = J * C, N = B * 32 * cols, pt = new Int32Array(J), w = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const part = Math.floor((i + 2 * Math.floor(M / 4)) / M) % J, k = pt[part]++;
    const block = (k + part * 7 - BK_ADJ * Math.floor(k / BK_BITS)) % B;
    const row = Math.floor(((11 * k) % BK_BITS) / C), col = (k * 11) % C;
    w[i] = (block * 32 + row) * cols + part * C + col;
  }
  return w;
}

/** Rate 1/2 keeps g1 and g3 of the mother code, in serial order g1 g3. */
export function depuncture12(soft: ArrayLike<number>, nIn: number, out = new Float32Array(nIn * 3)): Float32Array {
  for (let i = 0; i < nIn; i++) { out[3 * i] = soft[2 * i]; out[3 * i + 1] = 0; out[3 * i + 2] = soft[2 * i + 1]; }
  return out;
}
export function puncture12(code: Uint8Array): Uint8Array {
  const n = code.length / 3, out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { out[2 * i] = code[3 * i]; out[2 * i + 1] = code[3 * i + 2]; }
  return out;
}

/** Each column (one rail of one subcarrier) scaled by its own signal to noise: next to the analog FM some are far worse. */
function weigh(rows: Float32Array, cols: number): Float32Array {
  const out = new Float32Array(rows.length), n = rows.length / cols;
  for (let c = 0; c < cols; c++) {
    let s = 0, s2 = 0;
    for (let r = 0; r < n; r++) { const a = Math.abs(rows[r * cols + c]); s += a; s2 += a * a; }
    const m = s / n, v = Math.max(s2 / n - m * m, 1e-12 + m * m * 1e-4), g = m / v;
    for (let r = 0; r < n; r++) out[r * cols + c] = rows[r * cols + c] * g;
  }
  return out;
}

export interface P3Frame { pdu: L2Pdu; ber: number }

/**
 * Takes the PX1 soft matrix one block pair (64 rows) at a time and gives back P3 transfer frames. Interleaver IV is
 * convolutional, so a frame comes out up to a cycle (16 block pairs) after it went in. Where the cycle starts is not
 * signaled; each candidate phase is tried until one decodes cleanly.
 */
export class P3Decoder {
  readonly J: number; readonly b: number; readonly N: number;
  private readonly w: Int32Array;
  /** Per input bit of the cycle: which output position (counted from the cycle's start, up to 2N) carries it. */
  private readonly tRel: Int32Array;
  /** Per input frame of the cycle: the last output frame (from the cycle's start) it needs. */
  private readonly needs: Int32Array;
  private readonly out = new Map<number, Float32Array>();
  private last = -1; private misses = 0;
  phase = -1;
  private tries = new Int32Array(P3_CYCLE); private good = new Int32Array(P3_CYCLE);

  constructor(ext: number) {
    this.J = 2 * ext; this.b = 64 * this.J * C; this.N = this.b * P3_CYCLE;
    this.w = writeAddr(this.J);
    this.tRel = new Int32Array(this.N); this.needs = new Int32Array(P3_CYCLE);
    for (let j = 0; j < this.N; j++) {
      const t = this.w[j] >= j ? this.w[j] : this.N + this.w[j];
      this.tRel[j] = t;
      const f = Math.floor(j / this.b), of = Math.floor(t / this.b);
      if (of > this.needs[f]) this.needs[f] = of;
    }
  }

  /**
   * One block pair's 64 rows of PX1 soft values (row major, J * 36 columns), numbered by its place in time so a
   * missed L1 frame leaves a gap rather than shifting everything after it. Returns the frames now complete.
   */
  push(rows: Float32Array, k: number): P3Frame[] {
    if (k <= this.last) this.reset();
    this.last = k;
    this.out.set(k, weigh(rows, this.J * C));
    for (const key of this.out.keys()) if (key < k - 2 * P3_CYCLE - 2) this.out.delete(key);
    const done: P3Frame[] = [];
    if (this.phase < 0 && this.tries.every(n => n > 40)) this.unlock();
    const phases = this.phase >= 0 ? [this.phase] : Array.from({ length: P3_CYCLE }, (_, i) => i);
    for (const ph of phases) {
      // input frames whose last needed output frame is k, for a cycle starting at output frame s = ph mod 16
      for (let f = 0; f < P3_CYCLE; f++) {
        const s = k - this.needs[f];
        if (s < 0 || ((s - ph) % P3_CYCLE + P3_CYCLE) % P3_CYCLE !== 0) continue;
        if (this.phase >= 0 ? ph !== this.phase : this.tries[ph] > 40) continue;
        const r = this.decode(s, f);
        if (!r) continue;
        if (this.phase >= 0) {
          // a whole cycle that will not decode: the alignment is lost, search again
          if (r.pdu.pciErrors > 4 && r.ber > 0.15) { if (++this.misses >= P3_CYCLE) { this.unlock(); return done; } } else this.misses = 0;
        } else {
          this.tries[ph]++;
          if (r.pdu.pciErrors <= 2 && r.ber < 0.1) this.good[ph]++;
          if (this.good[ph] >= 3) { this.phase = ph; }
          else continue;
        }
        done.push(r);
      }
    }
    return done;
  }

  private decode(s: number, f: number): P3Frame | null {
    const soft = new Float32Array(this.b), base = f * this.b;
    for (let i = 0; i < this.b; i++) {
      const t = this.tRel[base + i], o = this.out.get(s + Math.floor(t / this.b));
      if (!o) return null;
      soft[i] = o[t % this.b];
    }
    const nIn = this.b / 2, v = new TbViterbi(); v.start(depuncture12(soft, nIn), nIn); v.run();
    const bits = v.bits.slice(), p = puncture12(encode(bits));
    let e = 0, m = 0; for (let i = 0; i < p.length; i++) { const x = soft[i]; if (!x) continue; m++; if ((x > 0 ? 1 : 0) !== p[i]) e++; }
    return { pdu: pduFromFrame(descramble(bits)), ber: m ? e / m : 1 };
  }

  private unlock(): void { this.phase = -1; this.misses = 0; this.tries.fill(0); this.good.fill(0); }
  reset(): void { this.out.clear(); this.last = -1; this.unlock(); }
}
