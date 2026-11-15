/**
 * UAT error correction (DO-282B): Reed-Solomon codes over GF(2^8) with primitive polynomial x^8+x^7+x^2+x+1 (0x187)
 * and generator roots alpha^120 .. alpha^(120+nroots-1).
 *
 * - Ground uplink: six RS(92,72) blocks (20 parity bytes each), byte-interleaved: byte i of block j sits at 6*i + j.
 * - Basic downlink (short ADS-B): RS(30,18), 12 parity bytes.
 * - Long downlink: RS(48,34), 14 parity bytes.
 *
 * Decoding is Berlekamp-Massey, a Chien search and Forney's formula, checked by recomputing the syndromes, so a block
 * is either returned corrected and verified or rejected.
 */
const PRIM = 0x187;
const FCR = 120;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => (a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);
const pow = (e: number) => EXP[((e % 255) + 255) % 255];

/** p(x) at x, p[0] the highest power (bytes in transmission order). */
function evalAt(p: ArrayLike<number>, x: number): number {
  let y = 0;
  for (let i = 0; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function syndromes(block: ArrayLike<number>, nroots: number): number[] {
  const s = new Array<number>(nroots);
  for (let i = 0; i < nroots; i++) s[i] = evalAt(block, pow(FCR + i));
  return s;
}

/**
 * Corrects a codeword in place (n = data + parity bytes, the shortened code's length). Returns the number of byte
 * errors fixed, or -1 when it cannot be corrected.
 */
export function rsCorrect(block: Uint8Array, nroots: number): number {
  const n = block.length;
  const S = syndromes(block, nroots);
  if (S.every(v => v === 0)) return 0;
  // Berlekamp-Massey: error locator sigma, lowest power first
  let C = new Array<number>(nroots + 1).fill(0); C[0] = 1;
  let B = C.slice();
  let L = 0, m = 1, b = 1;
  for (let k = 0; k < nroots; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i], S[k - i]);
    if (d === 0) { m++; continue; }
    const coef = div(d, b);
    if (2 * L <= k) {
      const T = C.slice();
      for (let i = 0; i + m <= nroots; i++) C[i + m] ^= mul(coef, B[i]);
      L = k + 1 - L; B = T; b = d; m = 1;
    } else {
      for (let i = 0; i + m <= nroots; i++) C[i + m] ^= mul(coef, B[i]);
      m++;
    }
  }
  if (L === 0 || 2 * L > nroots) return -1;
  const sigma = C.slice(0, L + 1);
  // Chien search: byte p (0 = first sent) has locator X = alpha^(n-1-p)
  const pos: number[] = [];
  for (let p = 0; p < n; p++) {
    const xInv = pow(-(n - 1 - p));
    let v = 0;
    for (let i = L; i >= 0; i--) v = mul(v, xInv) ^ sigma[i];
    if (v === 0) pos.push(p);
  }
  if (pos.length !== L) return -1;
  // Forney: Omega = S(x) sigma(x) mod x^nroots
  const omega = new Array<number>(nroots).fill(0);
  for (let i = 0; i < nroots; i++) for (let j = 0; j <= Math.min(i, L); j++) omega[i] ^= mul(sigma[j], S[i - j]);
  for (const p of pos) {
    const e = n - 1 - p;
    const xInv = pow(-e);
    let num = 0;
    for (let i = nroots - 1; i >= 0; i--) num = mul(num, xInv) ^ omega[i];
    let den = 0;                                 // sigma'(Xinv): the odd terms
    for (let i = 1; i <= L; i += 2) den ^= mul(sigma[i], pow(LOG[xInv] * (i - 1)));
    if (den === 0) return -1;
    block[p] ^= mul(num, div(pow(e * (1 - FCR)), den));
  }
  return syndromes(block, nroots).every(v => v === 0) ? pos.length : -1;
}

/** Parity bytes for data (test and synthesis use): systematic encoding, data first. */
export function rsEncode(data: ArrayLike<number>, nroots: number): Uint8Array {
  // generator polynomial g(x) = prod (x - alpha^(FCR+i)), highest power first
  let g = [1];
  for (let i = 0; i < nroots; i++) {
    const r = pow(FCR + i), next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], r); }
    g = next;
  }
  const out = new Uint8Array(data.length + nroots);
  out.set(Array.from(data));
  const rem = new Array<number>(nroots).fill(0);
  for (let i = 0; i < data.length; i++) {
    const f = data[i] ^ rem[0];
    rem.shift(); rem.push(0);
    if (f) for (let j = 0; j < nroots; j++) rem[j] ^= mul(f, g[j + 1]);
  }
  out.set(rem, data.length);
  return out;
}

/** The 552-byte uplink as sent (6 interleaved blocks) to the 432-byte message, or null if any block fails. */
export function uplinkMessage(frame: Uint8Array): { msg: Uint8Array; fixed: number } | null {
  const msg = new Uint8Array(432);
  const blk = new Uint8Array(92);
  let fixed = 0;
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 92; i++) blk[i] = frame[6 * i + j];
    const n = rsCorrect(blk, 20);
    if (n < 0) return null;
    fixed += n;
    msg.set(blk.subarray(0, 72), 72 * j);
  }
  return { msg, fixed };
}

/** The 432-byte message to the 552-byte uplink frame (synthesis for tests). */
export function uplinkFrame(msg: Uint8Array): Uint8Array {
  const frame = new Uint8Array(552);
  for (let j = 0; j < 6; j++) {
    const cw = rsEncode(msg.subarray(72 * j, 72 * j + 72), 20);
    for (let i = 0; i < 92; i++) frame[6 * i + j] = cw[i];
  }
  return frame;
}
