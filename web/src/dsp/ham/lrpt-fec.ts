/**
 * Channel coding for Meteor-M LRPT (CCSDS-style): the rate-1/2 K=7 convolutional code with a full-frame Viterbi
 * decoder, the 0x1ACFFC1D sync word as it looks after the encoder (used to find frames in the symbol stream under
 * every QPSK phase / swap ambiguity), the CCSDS pseudo-random descrambler, and the Reed-Solomon (255,223)
 * decoder (interleave 4, dual-root spacing 11) that guards each VCDU. Reed-Solomon and descrambler follow
 * meteor_decode by dbdexter-dev (MIT).
 */

export const G1 = 0x79, G2 = 0x5b, K = 7, STATES = 1 << K;
export const SYNCWORD = 0x1acffc1d;
export const CADU_BYTES = 1024, FRAME_SYMBOLS = CADU_BYTES * 8;

function parity(x: number): number { x ^= x >> 16; x ^= x >> 8; x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; }

/** Encoder output (2 bits: G1 << 1 | G2) for each 7-bit shift-register state. */
const OUT = new Uint8Array(STATES);
for (let s = 0; s < STATES; s++) OUT[s] = parity(s & G1) << 1 | parity(s & G2);

/** Convolutionally encode `bits` (MSB first from a 32-bit word) from state 0; returns the coded bit pairs as an array of 2-bit values. */
export function convEncode32(word: number): Uint8Array {
  const out = new Uint8Array(32);
  let state = 0;
  for (let i = 31; i >= 0; i--) {
    state = ((state >> 1) | (((word >>> i) & 1) << (K - 1))) & (STATES - 1);
    out[31 - i] = OUT[state];
  }
  return out;
}

/**
 * Full-frame Viterbi decoder: `soft` holds 2 × n int8 values (first of each pair = the G1 bit, second = G2;
 * positive means 1), `out` receives n / 8 bytes. Returns the fraction of received bits that disagree with the
 * re-encoded path (a BER estimate).
 */
export class Viterbi {
  private readonly prev: Uint8Array;
  private m0 = new Int32Array(STATES); private m1 = new Int32Array(STATES);
  constructor(private readonly n: number) { this.prev = new Uint8Array(n * STATES); }
  decode(soft: Int8Array, out: Uint8Array): number {
    const n = this.n, prev = this.prev;
    let m = this.m0, nm = this.m1;
    m.fill(0);
    for (let t = 0; t < n; t++) {
      const x = soft[2 * t], y = soft[2 * t + 1];
      // branch metric for coded pair (b1 b2): (b1 ? x : -x) + (b2 ? y : -y)
      const bm0 = -x - y, bm1 = -x + y, bm2 = x - y, bm3 = x + y;
      const base = t * STATES;
      for (let s = 0; s < STATES; s++) {
        // predecessors of state s: (s << 1) & 63 and ((s << 1) & 63) | 1 ; the input bit is s >> 6
        const p0 = (s << 1) & (STATES - 1), p1 = p0 | 1;
        const o0 = OUT[s], o1 = OUT[s];          // output depends only on the new state (shift register contents)
        const bm = o0 === 0 ? bm0 : o0 === 1 ? bm1 : o0 === 2 ? bm2 : bm3;
        const c0 = m[p0] + bm, c1 = m[p1] + (o1 === 0 ? bm0 : o1 === 1 ? bm1 : o1 === 2 ? bm2 : bm3);
        if (c0 >= c1) { nm[s] = c0; prev[base + s] = p0; } else { nm[s] = c1; prev[base + s] = p1; }
      }
      // keep the metrics bounded
      if ((t & 255) === 255) { let mx = -1e9; for (let s = 0; s < STATES; s++) if (nm[s] > mx) mx = nm[s]; for (let s = 0; s < STATES; s++) nm[s] -= mx; }
      const tmp = m; m = nm; nm = tmp;
    }
    let best = 0; for (let s = 1; s < STATES; s++) if (m[s] > m[best]) best = s;
    // trace back: the input bit that led to state s is its top bit
    let s = best, wrong = 0;
    out.fill(0);
    for (let t = n - 1; t >= 0; t--) {
      const bit = s >> (K - 1);
      if (bit) out[t >> 3] |= 0x80 >> (t & 7);
      const o = OUT[s];
      if (((o >> 1) & 1) !== (soft[2 * t] > 0 ? 1 : 0)) wrong++;
      if ((o & 1) !== (soft[2 * t + 1] > 0 ? 1 : 0)) wrong++;
      s = prev[t * STATES + s];
    }
    return wrong / (2 * n);
  }
}

// ------------------------------------------------------------------------------------------- sync search
/** The coded sync word as 32 symbols, as it appears in the stream under each of 8 constellation ambiguities. */
export const SYNC_VARIANTS: Int8Array[] = (() => {
  const pairs = convEncode32(SYNCWORD);
  const base: [number, number][] = Array.from(pairs, p => [(p >> 1) & 1 ? 1 : -1, p & 1 ? 1 : -1]);
  const out: Int8Array[] = [];
  for (let v = 0; v < 8; v++) {
    const arr = new Int8Array(64);
    for (let i = 0; i < 32; i++) { const [a, b] = applyVariant(base[i][0], base[i][1], v, true); arr[2 * i] = a; arr[2 * i + 1] = b; }
    out.push(arr);
  }
  return out;
})();
/**
 * Map a received (I, Q) to the decoder's (G1, G2) under variant v: rotation v & 3 (× 90°) then swap when v ≥ 4.
 * `forward` produces "what the stream looks like" from the true bits; the decoder applies the inverse.
 */
export function applyVariant(i: number, q: number, v: number, forward: boolean): [number, number] {
  let a = i, b = q;
  if (forward) {
    switch (v & 3) { case 1: [a, b] = [-b, a]; break; case 2: [a, b] = [-a, -b]; break; case 3: [a, b] = [b, -a]; break; }
    if (v & 4) [a, b] = [b, a];
  } else {
    if (v & 4) [a, b] = [b, a];
    switch (v & 3) { case 1: [a, b] = [b, -a]; break; case 2: [a, b] = [-a, -b]; break; case 3: [a, b] = [-b, a]; break; }
  }
  return [a, b];
}
/** Correlate 32 symbols of soft values (I,Q interleaved, starting at `at`) against every sync variant; returns [variant, score 0..1]. */
export function syncScore(soft: Int8Array, at: number): [number, number] {
  let bestV = 0, best = -1;
  for (let v = 0; v < 8; v++) {
    const s = SYNC_VARIANTS[v];
    let c = 0, a = 0;
    for (let k = 0; k < 64; k++) { const x = soft[at + k]; c += x * s[k]; a += x < 0 ? -x : x; }
    const score = a > 0 ? c / a : 0;
    if (score > best) { best = score; bestV = v; }
  }
  return [bestV, best];
}

// ------------------------------------------------------------------------------------------- descrambler
const NOISE = new Uint8Array(255);
{ let state = 0xff; for (let i = 0; i < 255; i++) { let b = 0; for (let j = 0; j < 8; j++) { const nb = ((state >> 7) ^ (state >> 5) ^ (state >> 3) ^ state) & 1; b = (b << 1) | (state & 1); state = (state >> 1) | (nb << 7); } NOISE[i] = b; } }
/** Undo the CCSDS randomizer over the 1020 bytes after the sync marker. */
export function descramble(cadu: Uint8Array): void { for (let i = 0; i < 1020; i++) cadu[4 + i] ^= NOISE[i % 255]; }

// ------------------------------------------------------------------------------------------- Reed-Solomon
const RS_N = 255, RS_K = 223, RS_T = RS_N - RS_K, RS_T2 = RS_T / 2, GEN_POLY = 0x187, FIRST_ROOT = 112, ROOT_SKIP = 11;
const ALPHA = new Uint8Array(RS_N + 1), LOGT = new Uint8Array(RS_N + 1), GAPROOT = new Uint8Array(RS_N), ZEROES = new Uint8Array(RS_T);
{
  ALPHA[0] = 1; LOGT[1] = 0; LOGT[0] = 183;
  for (let i = 1; i < RS_N; i++) { let t = ALPHA[i - 1] << 1; if (t > RS_N) t ^= GEN_POLY; ALPHA[i] = t; LOGT[t] = i; }
  LOGT[255] = 183; ALPHA[255] = 0;
  const gfpow = (x: number, e: number) => x === 0 ? 0 : ALPHA[(LOGT[x] * e) % RS_N];
  for (let i = 0; i < RS_N; i++) GAPROOT[gfpow(i, ROOT_SKIP)] = i;
  for (let i = 0; i < RS_T; i++) ZEROES[i] = ALPHA[((i + FIRST_ROOT) * ROOT_SKIP) % RS_N];
}
const gfmul = (x: number, y: number) => x === 0 || y === 0 ? 0 : ALPHA[(LOGT[x] + LOGT[y]) % RS_N];
const gfdiv = (x: number, y: number) => x === 0 || y === 0 ? 0 : ALPHA[(LOGT[x] - LOGT[y] + RS_N) % RS_N];
const gfpow = (x: number, e: number) => x === 0 ? 0 : ALPHA[(LOGT[x] * e) % RS_N];
function polyEval(p: Uint8Array, x: number, len: number): number { let r = 0; for (let i = len - 1; i >= 0; i--) r = gfmul(r, x) ^ p[i]; return r; }
/** Correct one 255-byte code word in place. Returns the number of corrected symbols, or −1 when uncorrectable. */
function fixBlock(d: Uint8Array): number {
  const syn = new Uint8Array(RS_T);
  let any = 0;
  for (let i = 0; i < RS_T; i++) { syn[i] = polyEval(d, ZEROES[i], RS_N); any |= syn[i]; }
  if (!any) return 0;
  const lambda = new Uint8Array(RS_T2 + 1), prevL = new Uint8Array(RS_T2 + 1), tmp = new Uint8Array(RS_T2 + 1);
  let deg = 0, prevDelta = 1, m = 1;
  lambda[0] = prevL[0] = 1;
  for (let n = 0; n < RS_T; n++) {
    let delta = syn[n];
    for (let i = 1; i <= deg; i++) delta ^= gfmul(syn[n - i], lambda[i]);
    if (delta === 0) m++;
    else if (2 * deg <= n) {
      tmp.set(lambda);
      for (let i = m; i < RS_T2 + 1; i++) lambda[i] ^= gfmul(gfdiv(delta, prevDelta), prevL[i - m]);
      prevL.set(tmp); prevDelta = delta; deg = n + 1 - deg; m = 1;
    } else {
      for (let i = m; i < RS_T2 + 1; i++) lambda[i] ^= gfmul(gfdiv(delta, prevDelta), prevL[i - m]);
      m++;
    }
  }
  const roots: number[] = [], pos: number[] = [];
  for (let i = 1; i <= RS_N && roots.length < deg; i++) if (polyEval(lambda, i, RS_T2 + 1) === 0) { roots.push(i); pos.push(LOGT[GAPROOT[gfdiv(1, i)]]); }
  if (roots.length !== deg) return -1;
  const omega = new Uint8Array(RS_T);
  for (let j = 0; j < RS_T2 + 1; j++) for (let i = 0; i < RS_T; i++) if (i + j < RS_T) omega[i + j] ^= gfmul(syn[i], lambda[j]);
  const lprime = new Uint8Array(RS_T2);
  for (let i = 1; i < RS_T2 + 1; i++) { lprime[i - 1] = 0; for (let j = 0; j < i; j++) lprime[i - 1] ^= lambda[i]; }
  for (let i = 0; i < roots.length; i++) {
    const fcr = gfpow(roots[i], FIRST_ROOT - 1);
    const num = polyEval(omega, roots[i], RS_T), den = polyEval(lprime, roots[i], RS_T2);
    d[pos[i]] ^= gfdiv(gfmul(num, fcr), den);
  }
  return roots.length;
}
/** Correct the four interleaved RS code words of a CADU (bytes 4..1023) in place; total corrections or −1. */
export function rsFix(cadu: Uint8Array): number {
  const block = new Uint8Array(RS_N);
  let errors = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < RS_N; j++) block[j] = cadu[4 + j * 4 + i];
    const e = fixBlock(block);
    if (e < 0 || errors < 0) errors = -1; else errors += e;
    for (let j = 0; j < RS_N; j++) cadu[4 + j * 4 + i] = block[j];
  }
  return errors;
}
