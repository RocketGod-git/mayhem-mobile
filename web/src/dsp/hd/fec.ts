/**
 * NRSC-5 FM Layer 1 forward error correction for service mode MP1, receive side and the matching transmit side
 * (the transmit side serves round-trip checks). From SY_IDD_1011s rev H:
 *  - PM interleaver I (P1) and II (PIDS), 10.2.3, 10.2.4, 10.4.1.1, Tables 10-16 to 10-18;
 *  - interleaver partition to subcarrier map, Table 12-1, Table 12-19, 12.2.1.2;
 *  - rate 2/5 puncturing of the K=7 133/171/165 mother code, 9.3.5, tail-biting;
 *  - scrambler 1 + x^2 + x^11, 8.2.
 * Two orderings were settled on recordings: the generator MSB multiplies the current input bit, and the scrambler's
 * initial state 0111 1111 111 lists stage 1 first.
 */

export const V_PM = [10, 2, 18, 6, 14, 8, 16, 0, 12, 4, 11, 3, 19, 7, 15, 9, 17, 1, 13, 5];
const J = 20, B = 16, C = 36;
/** P1 coded bits per L1 frame (Table 10-1) and information bits after rate 2/5. */
export const N_P1 = 365_440, P1_BITS = 146_176;
/** PIDS coded bits per block and information bits (one SIS PDU). */
export const N_PIDS = 200, PIDS_BITS = 80;
/** The PM matrix: 512 rows (16 blocks of 32 symbols), 720 columns (20 partitions of 36). */
export const PM_ROWS = 512, PM_COLS = 720;

const rowOf = (k: number) => (k * 11) % 32;
const colOf = (k: number) => (k * 11 + Math.floor(k / (32 * 9))) % C;

let p1Cache: Int32Array | null = null;
/** For each P1 coded bit, its flat index (row * 720 + column) in the PM matrix. */
export function p1Index(): Int32Array {
  if (p1Cache) return p1Cache;
  const out = new Int32Array(N_P1);
  for (let i = 0; i < N_P1; i++) {
    const part = V_PM[i % J];
    const block = (Math.floor(i / J) + part * 7) % B;
    const k = Math.floor(i / (J * B));
    out[i] = (block * 32 + rowOf(k)) * PM_COLS + part * C + colOf(k);
  }
  return (p1Cache = out);
}

const pidsCache: Int32Array[] = [];
/** PIDS coded bits of block `bc`, as flat PM matrix indices (Interleaver II). */
export function pidsIndex(bc: number): Int32Array {
  if (pidsCache[bc]) return pidsCache[bc];
  const out = new Int32Array(N_PIDS), k0 = N_P1 / (J * B);
  for (let n = 0; n < N_PIDS; n++) {
    const i = N_PIDS * bc + n, part = V_PM[i % J], block = Math.floor(i / N_PIDS);
    const k = (Math.floor(i / J) % (N_PIDS / J)) + k0;
    out[n] = (block * 32 + rowOf(k)) * PM_COLS + part * C + colOf(k);
  }
  return (pidsCache[bc] = out);
}

/** PM matrix column to subcarrier (-546..546) and to the I (0) or Q (1) rail. */
export function pmColumns(): { sc: Int16Array; iq: Uint8Array } {
  const sc = new Int16Array(PM_COLS), iq = new Uint8Array(PM_COLS);
  for (let p = 0; p < J; p++) {
    const fp = p < 10 ? p : p + 8;
    const start = fp < 10 ? -545 + 19 * fp : 357 + 19 * (fp - 18);
    for (let c = 0; c < C; c++) { sc[p * C + c] = start + (c >> 1); iq[p * C + c] = c & 1; }
  }
  return { sc, iq };
}

// ---- convolutional code ----
const K = 7, NST = 64;
const GENS = [0o133, 0o171, 0o165];
/** OUT[state * 2 + input] = the three code bits as g1 g2 g3 (g1 in bit 2); NEXT likewise. */
const OUT = new Uint8Array(NST * 2), NEXT = new Uint8Array(NST * 2);
(() => {
  const taps = GENS.map(g => Array.from({ length: K }, (_, j) => (g >> (K - 1 - j)) & 1));
  for (let s = 0; s < NST; s++) for (let u = 0; u < 2; u++) {
    const reg = [u, ...Array.from({ length: K - 1 }, (_, j) => (s >> (K - 2 - j)) & 1)];
    let c = 0;
    for (let h = 0; h < 3; h++) { let p = 0; for (let j = 0; j < K; j++) p ^= taps[h][j] & reg[j]; c = (c << 1) | p; }
    OUT[s * 2 + u] = c; NEXT[s * 2 + u] = (u << (K - 2)) | (s >> 1);
  }
})();

/** Tail-biting encode: 3 mother-code bits per input bit (g1, g2, g3). */
export function encode(bits: Uint8Array): Uint8Array {
  let s = 0;
  for (let i = bits.length - (K - 1); i < bits.length; i++) s = NEXT[s * 2 + bits[i]];
  const out = new Uint8Array(bits.length * 3);
  for (let i = 0; i < bits.length; i++) {
    const c = OUT[s * 2 + bits[i]];
    out[3 * i] = c >> 2; out[3 * i + 1] = (c >> 1) & 1; out[3 * i + 2] = c & 1;
    s = NEXT[s * 2 + bits[i]];
  }
  return out;
}

/** Rate 2/5: even inputs keep g1 g2 g3, odd inputs keep g1 g2 (9.3.5.2), in serial order. */
export function puncture25(code: Uint8Array): Uint8Array {
  const n = code.length / 3, out = new Uint8Array(n / 2 * 5);
  let o = 0;
  for (let i = 0; i < n; i++) { out[o++] = code[3 * i]; out[o++] = code[3 * i + 1]; if (!(i & 1)) out[o++] = code[3 * i + 2]; }
  return out;
}

/** Serial soft values (positive means 1) back to three per input bit, zero where punctured. */
export function depuncture25(soft: ArrayLike<number>, nIn: number, out = new Float32Array(nIn * 3)): Float32Array {
  let o = 0;
  for (let i = 0; i < nIn; i++) { out[3 * i] = soft[o++]; out[3 * i + 1] = soft[o++]; out[3 * i + 2] = i & 1 ? 0 : soft[o++]; }
  return out;
}

/**
 * Tail-biting Viterbi by wrap-around: the trellis runs over [last `wrap` | frame | first `wrap`] from equal metrics
 * and the middle is kept. The work can be spread over several calls: `run(steps)` advances at most that many trellis
 * steps and returns true once the bits are ready.
 */
export class TbViterbi {
  private llr = new Float32Array(0); private n = 0; private wrap = 96; private L = 0; private t = 0;
  private dec = new Uint32Array(0);
  private m = new Float32Array(NST); private m2 = new Float32Array(NST);
  private readonly bm = new Float32Array(8);
  bits = new Uint8Array(0);

  start(llr: Float32Array, n: number, wrap = 96): void {
    this.llr = llr; this.n = n; this.wrap = Math.min(wrap, n); this.L = n + 2 * this.wrap; this.t = 0;
    if (this.dec.length < this.L * 2) this.dec = new Uint32Array(this.L * 2);
    this.m.fill(0);
    if (this.bits.length !== n) this.bits = new Uint8Array(n);
  }

  run(maxSteps = Infinity): boolean {
    const { llr, n, wrap, L, dec, bm } = this;
    let m = this.m, m2 = this.m2;
    const end = Math.min(L, this.t + maxSteps);
    for (let t = this.t; t < end; t++) {
      const i = (t - wrap + n) % n, l0 = llr[3 * i], l1 = llr[3 * i + 1], l2 = llr[3 * i + 2];
      for (let c = 0; c < 8; c++) bm[c] = (c & 4 ? l0 : -l0) + (c & 2 ? l1 : -l1) + (c & 1 ? l2 : -l2);
      let d0 = 0, d1 = 0, best = -Infinity;
      for (let ns = 0; ns < NST; ns++) {
        const u = ns >> 5, s0 = (ns & 31) << 1, s1 = s0 | 1;
        const a = m[s0] + bm[OUT[s0 * 2 + u]], b = m[s1] + bm[OUT[s1 * 2 + u]];
        let v = a;
        if (b > a) { v = b; if (ns < 32) d0 |= 1 << ns; else d1 |= 1 << (ns - 32); }
        m2[ns] = v; if (v > best) best = v;
      }
      for (let s = 0; s < NST; s++) m2[s] -= best;
      dec[2 * t] = d0 >>> 0; dec[2 * t + 1] = d1 >>> 0;
      const tmp = m; m = m2; m2 = tmp;
    }
    this.m = m; this.m2 = m2; this.t = end;
    if (end < L) return false;
    let s = 0, best = -Infinity;
    for (let k = 0; k < NST; k++) if (m[k] > best) { best = m[k]; s = k; }
    const bits = this.bits;
    for (let t = L - 1; t >= 0; t--) {
      if (t >= wrap && t < wrap + n) bits[t - wrap] = s >> 5;
      const d = s < 32 ? (dec[2 * t] >>> s) & 1 : (dec[2 * t + 1] >>> (s - 32)) & 1;
      s = ((s & 31) << 1) | d;
    }
    return true;
  }
}

/** Decode in one go. */
export function viterbiTb(llr: Float32Array, n: number, wrap = 96): Uint8Array {
  const v = new TbViterbi(); v.start(llr, n, wrap); v.run(); return v.bits.slice();
}

// ---- scrambler ----
const scrCache = new Map<number, Uint8Array>();
/** The scrambling sequence: 11 stages, output and feedback = stage 2 XOR stage 11, reset to 0111 1111 111 per frame. */
export function scramblerSeq(n: number): Uint8Array {
  let s = scrCache.get(n);
  if (s) return s;
  s = new Uint8Array(n);
  const st = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  for (let i = 0; i < n; i++) { const b = st[1] ^ st[10]; s[i] = b; st.pop(); st.unshift(b); }
  scrCache.set(n, s);
  return s;
}
/** XOR with the scrambling sequence (the same operation scrambles and descrambles). */
export function descramble(bits: Uint8Array): Uint8Array {
  const s = scramblerSeq(bits.length), out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[i] ^ s[i];
  return out;
}

/** Fraction of hard decisions that disagree with the re-encoded output: the channel bit error rate before FEC. */
export function reencodeBer(bits: Uint8Array, soft: ArrayLike<number>): number {
  const p = puncture25(encode(bits));
  let e = 0, n = 0;
  for (let i = 0; i < p.length; i++) { const s = soft[i]; if (s === 0) continue; n++; if ((s > 0 ? 1 : 0) !== p[i]) e++; }
  return n ? e / n : 1;
}
