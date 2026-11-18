/**
 * 8VSB channel coding, ATSC A/53 Part 2 Sec 5.2: randomizer, RS(207,187), the 52-segment byte interleaver and the
 * 12-way trellis coder, each with its inverse.
 * Resolved against recordings: bytes go to the trellis coders just in time (a coder fetches the next interleaver
 * byte when it starts a byte), the randomizer starts from its preload for the first data byte of a field and shifts
 * once per data byte, the first byte sent is the highest-degree RS coefficient.
 */

export const SEG = 832, FIELD_SEGS = 313, DATA_SEGS = 312, DATA_SYMS = 828;
export const FIELD_SYMS = SEG * FIELD_SEGS;
export const FIELD_DATA_SYMS = DATA_SEGS * DATA_SYMS;
export const FIELD_BYTES = DATA_SEGS * 207;
export const RS_N = 207, RS_K = 187, RS_T = 10;

// ---- randomizer (Fig 5.3) ----
let prbsTable: Uint8Array | null = null;
/** The 312 x 187 randomizer bytes of one field, in order. */
export function prbs(): Uint8Array {
  if (prbsTable) return prbsTable;
  const r = new Uint8Array(17);
  for (const k of [16, 15, 14, 13, 9, 8]) r[k] = 1;
  const out = new Uint8Array(DATA_SEGS * RS_K);
  for (let i = 0; i < out.length; i++) {
    out[i] = (r[14] << 7) | (r[13] << 6) | (r[12] << 5) | (r[11] << 4) | (r[7] << 3) | (r[4] << 2) | (r[3] << 1) | r[1];
    const o = r[16];
    for (let k = 16; k > 1; k--) r[k] = r[k - 1];
    r[1] = o;
    if (o) for (const k of [2, 4, 7, 8, 12, 13, 14]) r[k] ^= 1;
  }
  prbsTable = out;
  return out;
}

// ---- GF(256), p(x) = x^8+x^4+x^3+x^2+1 ----
export const GF_EXP = new Uint8Array(512), GF_LOG = new Int16Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = v; GF_LOG[v] = i; v <<= 1; if (v & 0x100) v ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  GF_LOG[0] = -1;
}
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
const ginv = (a: number) => GF_EXP[255 - GF_LOG[a]];

/** g(x) = prod (x + a^i), i = 0..19, highest power first (21 coefficients). */
export const RS_GEN: Uint8Array = (() => {
  let g = [1];
  for (let i = 0; i < 20; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], GF_EXP[i]); }
    g = ng;
  }
  return Uint8Array.from(g);
})();

/** Systematic RS(207,187): 187 data bytes in, 207 out. */
export function rsEncode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(RS_N); out.set(data.subarray(0, RS_K));
  const rem = new Uint8Array(20);
  for (let i = 0; i < RS_K; i++) {
    const f = out[i] ^ rem[0];
    for (let j = 0; j < 19; j++) rem[j] = rem[j + 1] ^ gmul(f, RS_GEN[j + 1]);
    rem[19] = gmul(f, RS_GEN[20]);
  }
  out.set(rem, RS_K);
  return out;
}

const synd = new Uint8Array(20);
/**
 * Corrects one 207-byte codeword in place (Berlekamp-Massey, Chien, Forney, roots a^0..a^19).
 * Returns the number of bytes corrected (0 when clean), or -1 when it cannot be corrected.
 */
export function rsDecode(cw: Uint8Array, off = 0): number {
  let any = 0;
  for (let j = 0; j < 20; j++) {
    let s = 0;
    const lj = j;
    for (let i = 0; i < RS_N; i++) s = cw[off + i] ^ (s === 0 ? 0 : GF_EXP[GF_LOG[s] + lj]);
    synd[j] = s; any |= s;
  }
  if (!any) return 0;
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let n = 0; n < 20; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) if (i < C.length) d ^= gmul(C[i], synd[n - i]);
    if (d === 0) { m++; continue; }
    const coef = gmul(d, ginv(b));
    const T = C.slice();
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
    if (2 * L <= n) { L = n + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (L > RS_T || C.length - 1 !== L) return -1;
  const locs: number[] = [];
  for (let i = 0; i < RS_N; i++) {
    const p = RS_N - 1 - i, xinv = GF_EXP[(255 - p) % 255];
    let v = 0, xp = 1;
    for (let k = 0; k < C.length; k++) { v ^= gmul(C[k], xp); xp = gmul(xp, xinv); }
    if (v === 0) locs.push(i);
  }
  if (locs.length !== L) return -1;
  const Om = new Array(20).fill(0);
  for (let i = 0; i < 20; i++) for (let j = 0; j < C.length && j <= i; j++) Om[i] ^= gmul(C[j], synd[i - j]);
  for (const i of locs) {
    const p = RS_N - 1 - i, X = GF_EXP[p], Xi = ginv(X);
    let om = 0, xp = 1;
    for (let k = 0; k < 20; k++) { om ^= gmul(Om[k], xp); xp = gmul(xp, Xi); }
    let dl = 0; xp = 1;
    for (let k = 1; k < C.length; k += 2) { dl ^= gmul(C[k], xp); xp = gmul(xp, gmul(Xi, Xi)); }
    if (dl === 0) return -1;
    cw[off + i] ^= gmul(X, gmul(om, ginv(dl)));
  }
  return L;
}

// ---- interleaver (Fig 5.5): byte n of the stream goes through branch n mod 52, delayed (n mod 52) x 208 bytes ----
export const IL_STEP = 208, IL_MAX = 51 * IL_STEP;
/** Interleaves a whole stream that starts on a field boundary (bytes before the start count as zero). */
export function interleave(x: Uint8Array): Uint8Array {
  const y = new Uint8Array(x.length);
  for (let n = 0; n < x.length; n++) { const s = n - (n % 52) * IL_STEP; y[n] = s >= 0 ? x[s] : 0; }
  return y;
}
/** De-interleaves a stream that starts on a field boundary; the last IL_MAX bytes have no complete output. */
export function deinterleave(y: Uint8Array, n: number): Uint8Array {
  const m = Math.max(0, n - IL_MAX), x = new Uint8Array(m);
  for (let i = 0; i < m; i++) x[i] = y[i + (i % 52) * IL_STEP];
  return x;
}

// ---- trellis symbol map (Table 5.1/5.2, just in time) ----
export interface SymMap { enc: Uint8Array; byte: Int32Array; shift: Uint8Array; streams: Int32Array[] }
let symMap: SymMap | null = null;
/** For every data symbol of a field in time order: its coder, the interleaved byte it carries, the bit shift. */
export function symbolMap(): SymMap {
  if (symMap) return symMap;
  const n = FIELD_DATA_SYMS, enc = new Uint8Array(n), byte = new Int32Array(n), shift = new Uint8Array(n);
  const cnt = new Int32Array(12), cur = new Int32Array(12);
  let nxt = 0, i = 0;
  for (let s = 0; s < DATA_SEGS; s++) for (let k = 0; k < DATA_SYMS; k++, i++) {
    const e = (k + 4 * s) % 12;
    if ((cnt[e] & 3) === 0) cur[e] = nxt++;
    enc[i] = e; byte[i] = cur[e]; shift[i] = 6 - 2 * (cnt[e] & 3); cnt[e]++;
  }
  const streams: Int32Array[] = [];
  for (let e = 0; e < 12; e++) { const a = new Int32Array(n / 12); let j = 0; for (let t = 0; t < n; t++) if (enc[t] === e) a[j++] = t; streams.push(a); }
  symMap = { enc, byte, shift, streams };
  return symMap;
}

/** Trellis encoder state for the 12 coders: precoder memory and the two delays of each. */
export class TrellisEncoder {
  private readonly z2 = new Uint8Array(12); private readonly s1 = new Uint8Array(12); private readonly s2 = new Uint8Array(12);
  /** One field of interleaved bytes (64584) to 258336 data symbols (levels -7..+7). */
  field(bytes: Uint8Array, out = new Int8Array(FIELD_DATA_SYMS)): Int8Array {
    const { enc, byte, shift } = symbolMap();
    for (let i = 0; i < FIELD_DATA_SYMS; i++) {
      const e = enc[i], pair = (bytes[byte[i]] >> shift[i]) & 3, x2 = pair >> 1, x1 = pair & 1;
      const z2 = x2 ^ this.z2[e]; this.z2[e] = z2;
      const z0 = this.s2[e], ns2 = this.s1[e] ^ x1; this.s1[e] = this.s2[e]; this.s2[e] = ns2;
      out[i] = 2 * (4 * z2 + 2 * x1 + z0) - 7;
    }
    return out;
  }
}

/**
 * Viterbi: next state (a,b) = 2a+b comes from state 2*s1+a with X1 = s1^b and subset Z1Z0 = 2*X1+a.
 * The 12-way trellis decoder over whole fields, keeping the precoder memory from field to field. */
export class TrellisDecoder {
  private readonly prevZ2 = new Uint8Array(12);
  private ys = new Float32Array(FIELD_DATA_SYMS / 12);
  private readonly dec = new Uint8Array(FIELD_DATA_SYMS / 12);
  private readonly z2b = new Uint8Array(FIELD_DATA_SYMS / 12 * 4);
  /** Re-encoded levels of the decoded path, for the SNR against trellis decisions. */
  readonly levels = new Int8Array(FIELD_DATA_SYMS);
  reset(): void { this.prevZ2.fill(0); }
  /** Soft data symbols of one field in, its 64584 interleaved bytes out. */
  field(y: Float32Array, out = new Uint8Array(FIELD_BYTES)): Uint8Array {
    const { streams, byte, shift } = symbolMap(), T = FIELD_DATA_SYMS / 12;
    out.fill(0);
    const ys = this.ys, dec = this.dec, z2b = this.z2b, lv = this.levels;
    for (let e = 0; e < 12; e++) {
      const idx = streams[e];
      for (let t = 0; t < T; t++) ys[t] = y[idx[t]];
      let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
      for (let t = 0; t < T; t++) {
        const v = ys[t], o = 4 * t;
        // subset s holds levels 2s-7 (Z2 = 0) and 2s+1 (Z2 = 1)
        let a0 = v + 7, b0 = v - 1; a0 *= a0; b0 *= b0;
        let a1 = v + 5, b1 = v - 3; a1 *= a1; b1 *= b1;
        let a2 = v + 3, b2 = v - 5; a2 *= a2; b2 *= b2;
        let a3 = v + 1, b3 = v - 7; a3 *= a3; b3 *= b3;
        let g0: number, g1: number, g2: number, g3: number;
        if (b0 < a0) { g0 = b0; z2b[o] = 1; } else { g0 = a0; z2b[o] = 0; }
        if (b1 < a1) { g1 = b1; z2b[o + 1] = 1; } else { g1 = a1; z2b[o + 1] = 0; }
        if (b2 < a2) { g2 = b2; z2b[o + 2] = 1; } else { g2 = a2; z2b[o + 2] = 0; }
        if (b3 < a3) { g3 = b3; z2b[o + 3] = 1; } else { g3 = a3; z2b[o + 3] = 0; }
        let d = 0, n0: number, n1: number, n2: number, n3: number, c0: number, c1: number;
        c0 = m0 + g0; c1 = m2 + g2; if (c1 < c0) { n0 = c1; d |= 1; } else n0 = c0;
        c0 = m0 + g2; c1 = m2 + g0; if (c1 < c0) { n1 = c1; d |= 2; } else n1 = c0;
        c0 = m1 + g1; c1 = m3 + g3; if (c1 < c0) { n2 = c1; d |= 4; } else n2 = c0;
        c0 = m1 + g3; c1 = m3 + g1; if (c1 < c0) { n3 = c1; d |= 8; } else n3 = c0;
        dec[t] = d;
        let mn = n0; if (n1 < mn) mn = n1; if (n2 < mn) mn = n2; if (n3 < mn) mn = n3;
        m0 = n0 - mn; m1 = n1 - mn; m2 = n2 - mn; m3 = n3 - mn;
      }
      let st = 0, best = m0;
      if (m1 < best) { best = m1; st = 1; } if (m2 < best) { best = m2; st = 2; } if (m3 < best) st = 3;
      for (let t = T - 1; t >= 0; t--) {
        const s1 = (dec[t] >> st) & 1, a = st >> 1, b = st & 1, x1 = s1 ^ b, sb = 2 * x1 + a, z2 = z2b[4 * t + sb];
        ys[t] = z2 * 2 + x1;
        lv[idx[t]] = 2 * (4 * z2 + 2 * x1 + a) - 7;
        st = 2 * s1 + a;
      }
      let p = this.prevZ2[e];
      for (let t = 0; t < T; t++) {
        const z2 = (ys[t] as number) >> 1, x1 = (ys[t] as number) & 1, x2 = z2 ^ p; p = z2;
        const i = idx[t];
        out[byte[i]] |= ((x2 << 1) | x1) << shift[i];
      }
      this.prevZ2[e] = p;
    }
    return out;
  }
}

/** RS-decodes and de-randomizes 207-byte packets that start on a field boundary into 188-byte TS packets. */
export interface RsStats { ok: number; corrected: number; failed: number; bytes: number }
export function packetsToTs(x: Uint8Array, firstPacket: number, stats: RsStats, out?: Uint8Array): Uint8Array {
  const n = Math.floor(x.length / RS_N), ts = out ?? new Uint8Array(n * 188), pr = prbs();
  for (let p = 0; p < n; p++) {
    const r = rsDecode(x, p * RS_N);
    if (r === 0) stats.ok++; else if (r > 0) { stats.corrected++; stats.bytes += r; } else stats.failed++;
    const base = ((firstPacket + p) % DATA_SEGS) * RS_K, o = p * 188;
    ts[o] = 0x47;
    for (let i = 0; i < RS_K; i++) ts[o + 1 + i] = x[p * RS_N + i] ^ pr[base + i];
    if (r < 0) ts[o + 1] |= 0x80;
  }
  return ts;
}

/** TS packets (188 bytes each) to the interleaver input of whole fields: randomized and RS coded, sync dropped. */
export function tsToPackets(ts: Uint8Array): Uint8Array {
  const n = Math.floor(ts.length / 188), x = new Uint8Array(n * RS_N), pr = prbs(), d = new Uint8Array(RS_K);
  for (let p = 0; p < n; p++) {
    const base = (p % DATA_SEGS) * RS_K;
    for (let i = 0; i < RS_K; i++) d[i] = ts[p * 188 + 1 + i] ^ pr[base + i];
    x.set(rsEncode(d), p * RS_N);
  }
  return x;
}
