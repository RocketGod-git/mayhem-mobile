/**
 * The CCSDS rate-1/2, K=7 convolutional code the Lockheed Martin LMS6-403 and LMSX send (G1 = 0x4F, G2 = 0x6D with
 * the newest bit in bit 0), its encoder and a soft-decision Viterbi decoder. The decoder allocates its tables once
 * and is meant to run once per frame. The TypeScript twin of core/sonde/Viterbi.kt and Viterbi.swift.
 *
 * State convention: the encoder state holds the last 6 input bits, bit 0 = the most recent. For a new bit u the
 * 7-bit register is r = (state << 1 | u) & 0x7F and the next state is r & 0x3F.
 */

export const CONV_POLY_A = 0x4f;
export const CONV_POLY_B = 0x6d;

/** Code bits for each 7-bit register value. */
const OUT_A = new Uint8Array(128);
const OUT_B = new Uint8Array(128);
for (let r = 0; r < 128; r++) {
  let a = r & CONV_POLY_A, b = r & CONV_POLY_B, pa = 0, pb = 0;
  while (a) { pa ^= a & 1; a >>= 1; }
  while (b) { pb ^= b & 1; b >>= 1; }
  OUT_A[r] = pa; OUT_B[r] = pb;
}

/**
 * Encode bits, appending two code bits (c0, c1) per input bit to `out` starting at `outPos`. Returns the encoder
 * state after the last bit.
 */
export function convEncode(bits: ArrayLike<number>, state: number, out: Uint8Array, outPos: number): number {
  let s = state & 0x3f;
  for (let k = 0; k < bits.length; k++) {
    const r = ((s << 1) | (bits[k] & 1)) & 0x7f;
    out[outPos + 2 * k] = OUT_A[r];
    out[outPos + 2 * k + 1] = OUT_B[r];
    s = r & 0x3f;
  }
  return s;
}

/** The encoder state after a run of bits starting from `state`. */
export function convState(bits: ArrayLike<number>, state: number): number {
  let s = state & 0x3f;
  for (let k = 0; k < bits.length; k++) s = ((s << 1) | (bits[k] & 1)) & 0x3f;
  return s;
}

export class Viterbi {
  private readonly dec: Uint8Array;
  private pm = new Float64Array(64);
  private nm = new Float64Array(64);
  constructor(readonly maxBits: number) { this.dec = new Uint8Array(maxBits * 64); }

  /**
   * Soft-decision decode. `soft` holds (c0, c1) pairs from `start`, positive = code bit 1. `state0` is the known
   * encoder state before the first bit. Decoded bits go to `out[0 .. nBits-1]`. The end is left open (the best
   * final state wins). Returns the number of code symbols whose hard decision disagrees with the decoded path
   * (the channel errors the code repaired).
   */
  decode(soft: ArrayLike<number>, start: number, nBits: number, state0: number, out: Uint8Array): number {
    const n = Math.min(nBits, this.maxBits);
    const NEG = -1e300;
    let pm = this.pm, nm = this.nm;
    for (let s = 0; s < 64; s++) pm[s] = NEG;
    pm[state0 & 0x3f] = 0;
    const dec = this.dec;
    for (let k = 0; k < n; k++) {
      const a = soft[start + 2 * k], b = soft[start + 2 * k + 1];
      for (let ns = 0; ns < 64; ns++) {
        // the two predecessors differ in the bit that falls out of the register (t)
        const s0 = ns >> 1, s1 = s0 | 32;
        const r0 = ns, r1 = 64 | ns;
        const m0 = pm[s0] + (OUT_A[r0] ? a : -a) + (OUT_B[r0] ? b : -b);
        const m1 = pm[s1] + (OUT_A[r1] ? a : -a) + (OUT_B[r1] ? b : -b);
        if (m1 > m0) { nm[ns] = m1; dec[k * 64 + ns] = 1; } else { nm[ns] = m0; dec[k * 64 + ns] = 0; }
      }
      const t = pm; pm = nm; nm = t;
    }
    let best = 0;
    for (let s = 1; s < 64; s++) if (pm[s] > pm[best]) best = s;
    this.pm = pm; this.nm = nm;
    // trace back
    let ns = best;
    for (let k = n - 1; k >= 0; k--) {
      out[k] = ns & 1;
      const t = dec[k * 64 + ns];
      ns = (ns >> 1) | (t << 5);
    }
    // count the code symbols the decoded path disagrees with
    let errs = 0, s = state0 & 0x3f;
    for (let k = 0; k < n; k++) {
      const r = ((s << 1) | out[k]) & 0x7f;
      if ((soft[start + 2 * k] > 0 ? 1 : 0) !== OUT_A[r]) errs++;
      if ((soft[start + 2 * k + 1] > 0 ? 1 : 0) !== OUT_B[r]) errs++;
      s = r & 0x3f;
    }
    return errs;
  }
}
