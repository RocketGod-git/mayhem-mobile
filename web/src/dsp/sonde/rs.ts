/**
 * Reed-Solomon over GF(2^8) for the radiosonde decoders (RS41, RS92: RS(255,231); LMS6: the CCSDS RS(255,223)).
 * Codewords are polynomial coefficients by power: cw[i] multiplies X^i. The parity sits in cw[0 .. nroots-1] and the
 * message in cw[nroots ..], which is how the sondes lay their check bytes out. A shortened code is the same code with
 * the unused high message positions left zero.
 */
export class ReedSolomon {
  readonly n = 255;
  private readonly exp = new Uint8Array(512);
  private readonly log = new Int16Array(256);
  private readonly gen: Uint8Array;
  /**
   * @param poly the field's primitive polynomial (0x11D for the Vaisala codes, 0x187 for CCSDS)
   * @param fcr the first consecutive root, as a power of the code's root
   * @param prim the code's root as a power of the field's generator (1, or 11 for CCSDS)
   * @param nroots check bytes (24 or 32)
   */
  constructor(readonly poly: number, readonly fcr: number, readonly prim: number, readonly nroots: number) {
    let x = 1;
    for (let i = 0; i < 255; i++) { this.exp[i] = x; this.log[x] = i; x <<= 1; if (x & 0x100) x ^= poly; }
    for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255];
    this.log[0] = -1;
    // g(X) = prod (X - beta^(fcr+j)), beta = alpha^prim
    let g = new Uint8Array([1]);
    for (let j = 0; j < nroots; j++) {
      const r = this.exp[(prim * (fcr + j)) % 255];
      const ng = new Uint8Array(g.length + 1);
      for (let i = 0; i < g.length; i++) { ng[i + 1] ^= g[i]; ng[i] ^= this.mul(g[i], r); }
      g = ng;
    }
    this.gen = g;
  }
  mul(a: number, b: number): number { return a && b ? this.exp[this.log[a] + this.log[b]] : 0; }
  private div(a: number, b: number): number { return a ? this.exp[(this.log[a] - this.log[b] + 255) % 255] : 0; }
  /** beta^e for any integer e. */
  private bpow(e: number): number { return this.exp[(((this.prim * e) % 255) + 255) % 255]; }

  /** Fill cw[0 .. nroots-1] with the parity of cw[nroots .. 254]. */
  encode(cw: Uint8Array): void {
    const R = this.nroots, rem = new Uint8Array(R);
    // long division of msg(X)*X^R by g(X), highest power first
    for (let i = 254; i >= R; i--) {
      const fb = cw[i] ^ rem[R - 1];
      for (let k = R - 1; k > 0; k--) rem[k] = rem[k - 1] ^ this.mul(fb, this.gen[k]);
      rem[0] = this.mul(fb, this.gen[0]);
    }
    for (let k = 0; k < R; k++) cw[k] = rem[k];
  }

  /** Correct cw in place. Returns the number of symbols fixed, or -1 when it can't be corrected. */
  decode(cw: Uint8Array): number {
    const R = this.nroots, S = new Uint8Array(R);
    let any = 0;
    for (let j = 0; j < R; j++) {
      // Horner from the top power down: S_j = cw(beta^(fcr+j))
      const r = this.bpow(this.fcr + j);
      let s = 0;
      for (let i = 254; i >= 0; i--) s = this.mul(s, r) ^ cw[i];
      S[j] = s; any |= s;
    }
    if (!any) return 0;
    // Berlekamp-Massey
    let lambda = new Uint8Array(R + 1); lambda[0] = 1;
    let b = new Uint8Array(R + 1); b[0] = 1;
    let L = 0, m = 1, bb = 1;
    for (let k = 0; k < R; k++) {
      let d = S[k];
      for (let i = 1; i <= L; i++) d ^= this.mul(lambda[i], S[k - i]);
      if (d === 0) { m++; continue; }
      const coef = this.div(d, bb);
      const t = lambda.slice();
      for (let i = 0; i + m <= R; i++) lambda[i + m] ^= this.mul(coef, b[i]);
      if (2 * L <= k) { L = k + 1 - L; b = t; bb = d; m = 1; } else m++;
    }
    if (L > R / 2) return -1;
    // Chien search: roots of lambda at beta^(-i) mark error position i
    const pos: number[] = [];
    for (let i = 0; i < 255; i++) {
      const xinv = this.bpow(-i);
      let v = 0;
      for (let k = L; k >= 0; k--) v = this.mul(v, xinv) ^ lambda[k];
      if (v === 0) pos.push(i);
    }
    if (pos.length !== L) return -1;
    // Omega = S * lambda mod X^R
    const omega = new Uint8Array(R);
    for (let i = 0; i < R; i++) { let v = 0; for (let k = 0; k <= Math.min(i, L); k++) v ^= this.mul(lambda[k], S[i - k]); omega[i] = v; }
    for (const p of pos) {
      const xinv = this.bpow(-p), x = this.bpow(p);
      let om = 0; for (let i = R - 1; i >= 0; i--) om = this.mul(om, xinv) ^ omega[i];
      // formal derivative: the odd terms
      let dl = 0; for (let k = 1; k <= L; k += 2) dl ^= this.mul(lambda[k], this.powOf(xinv, k - 1));
      if (dl === 0) return -1;
      // Forney: e = X^(1-fcr) * omega(X^-1) / lambda'(X^-1)
      const e = this.mul(this.powOf(x, ((1 - this.fcr) % 255 + 255) % 255), this.div(om, dl));
      cw[p] ^= e;
    }
    return pos.length;
  }
  private powOf(a: number, e: number): number { if (e === 0) return 1; if (!a) return 0; return this.exp[(this.log[a] * e) % 255]; }
}

/** The Vaisala RS(255,231): x^8+x^4+x^3+x^2+1, roots alpha^0 .. alpha^23. */
export const RS_VAISALA = /*#__PURE__*/ new ReedSolomon(0x11d, 0, 1, 24);

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), the Vaisala and LMS block check. */
export function crc16ccitt(b: ArrayLike<number>, start: number, len: number, init = 0xffff): number {
  let c = init;
  for (let i = start; i < start + len; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
