/**
 * DL-SCH turbo coding, 36.212: 5.1.2 single code block (B <= 6144, F filler bits at the front), 5.1.3.2 PCCC with two
 * 8-state RSC encoders (g0 = 1 + D^2 + D^3, g1 = 1 + D + D^3), trellis termination, QPP interleaver (Table 5.1.3-3),
 * 5.1.4.1 rate matching (sub-block interleavers, circular buffer, N_cb = K_w, k0 by redundancy version).
 * Decoder: max-log-MAP with scaled extrinsic exchange, stopped early by the caller's CRC check.
 */
const QPP_K = [40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256, 264, 272, 280, 288, 296, 304, 312, 320, 328, 336, 344, 352, 360, 368, 376, 384, 392, 400, 408, 416, 424, 432, 440, 448, 456, 464, 472, 480, 488, 496, 504, 512, 528, 544, 560, 576, 592, 608, 624, 640, 656, 672, 688, 704, 720, 736, 752, 768, 784, 800, 816, 832, 848, 864, 880, 896, 912, 928, 944, 960, 976, 992, 1008, 1024, 1056, 1088, 1120, 1152, 1184, 1216, 1248, 1280, 1312, 1344, 1376, 1408, 1440, 1472, 1504, 1536, 1568, 1600, 1632, 1664, 1696, 1728, 1760, 1792, 1824, 1856, 1888, 1920, 1952, 1984, 2016, 2048, 2112, 2176, 2240, 2304, 2368, 2432, 2496, 2560, 2624, 2688, 2752, 2816, 2880, 2944, 3008, 3072, 3136, 3200, 3264, 3328, 3392, 3456, 3520, 3584, 3648, 3712, 3776, 3840, 3904, 3968, 4032, 4096, 4160, 4224, 4288, 4352, 4416, 4480, 4544, 4608, 4672, 4736, 4800, 4864, 4928, 4992, 5056, 5120, 5184, 5248, 5312, 5376, 5440, 5504, 5568, 5632, 5696, 5760, 5824, 5888, 5952, 6016, 6080, 6144];
const QPP_F1 = [3, 7, 19, 7, 7, 11, 5, 11, 7, 41, 103, 15, 9, 17, 9, 21, 101, 21, 57, 23, 13, 27, 11, 27, 85, 29, 33, 15, 17, 33, 103, 19, 19, 37, 19, 21, 21, 115, 193, 21, 133, 81, 45, 23, 243, 151, 155, 25, 51, 47, 91, 29, 29, 247, 29, 89, 91, 157, 55, 31, 17, 35, 227, 65, 19, 37, 41, 39, 185, 43, 21, 155, 79, 139, 23, 217, 25, 17, 127, 25, 239, 17, 137, 215, 29, 15, 147, 29, 59, 65, 55, 31, 17, 171, 67, 35, 19, 39, 19, 199, 21, 211, 21, 43, 149, 45, 49, 71, 13, 17, 25, 183, 55, 127, 27, 29, 29, 57, 45, 31, 59, 185, 113, 31, 17, 171, 209, 253, 367, 265, 181, 39, 27, 127, 143, 43, 29, 45, 157, 47, 13, 111, 443, 51, 51, 451, 257, 57, 313, 271, 179, 331, 363, 375, 127, 31, 33, 43, 33, 477, 35, 233, 357, 337, 37, 71, 71, 37, 39, 127, 39, 39, 31, 113, 41, 251, 43, 21, 43, 45, 45, 161, 89, 323, 47, 23, 47, 263];
const QPP_F2 = [10, 12, 42, 16, 18, 20, 22, 24, 26, 84, 90, 32, 34, 108, 38, 120, 84, 44, 46, 48, 50, 52, 36, 56, 58, 60, 62, 32, 198, 68, 210, 36, 74, 76, 78, 120, 82, 84, 86, 44, 90, 46, 94, 48, 98, 40, 102, 52, 106, 72, 110, 168, 114, 58, 118, 180, 122, 62, 84, 64, 66, 68, 420, 96, 74, 76, 234, 80, 82, 252, 86, 44, 120, 92, 94, 48, 98, 80, 102, 52, 106, 48, 110, 112, 114, 58, 118, 60, 122, 124, 84, 64, 66, 204, 140, 72, 74, 76, 78, 240, 82, 252, 86, 88, 60, 92, 846, 48, 28, 80, 102, 104, 954, 96, 110, 112, 114, 116, 354, 120, 610, 124, 420, 64, 66, 136, 420, 216, 444, 456, 468, 80, 164, 504, 172, 88, 300, 92, 188, 96, 28, 240, 204, 104, 212, 192, 220, 336, 228, 232, 236, 120, 244, 248, 168, 64, 130, 264, 134, 408, 138, 280, 142, 480, 146, 444, 120, 152, 462, 234, 158, 80, 96, 902, 166, 336, 170, 86, 174, 176, 178, 120, 182, 184, 186, 94, 190, 480];
export const PERM_TC = [0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30, 1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31];

const qppCache = new Map<number, Int32Array>();
export function qpp(K: number): Int32Array {
  let p = qppCache.get(K);
  if (p) return p;
  const j = QPP_K.indexOf(K);
  if (j < 0) throw new Error(`no QPP interleaver for K=${K}`);
  p = new Int32Array(K);
  for (let i = 0; i < K; i++) p[i] = (QPP_F1[j] * i + QPP_F2[j] * i * i) % K;
  qppCache.set(K, p);
  return p;
}
/** K of a single code block: the smallest table size >= B. */
export function blockSize(B: number): number {
  for (const K of QPP_K) if (K >= B) return K;
  throw new Error('needs segmentation');
}

// state s = (s1 s2 s3), s1 the newest register bit; a = u ^ s2 ^ s3, parity = a ^ s1 ^ s3
const NXT = new Int8Array(16), PAR = new Int8Array(16), TERM_U = new Int8Array(8);
for (let s = 0; s < 8; s++) {
  const s1 = (s >> 2) & 1, s2 = (s >> 1) & 1, s3 = s & 1;
  for (let u = 0; u < 2; u++) { const a = u ^ s2 ^ s3; PAR[s * 2 + u] = a ^ s1 ^ s3; NXT[s * 2 + u] = (a << 2) | (s1 << 1) | s2; }
  TERM_U[s] = s2 ^ s3;
}

function rsc(c: ArrayLike<number>): { z: Uint8Array; xt: number[]; zt: number[] } {
  let s = 0; const z = new Uint8Array(c.length), xt: number[] = [], zt: number[] = [];
  for (let i = 0; i < c.length; i++) { z[i] = PAR[s * 2 + c[i]]; s = NXT[s * 2 + c[i]]; }
  for (let i = 0; i < 3; i++) { const u = TERM_U[s]; xt.push(u); zt.push(PAR[s * 2 + u]); s = NXT[s * 2 + u]; }
  return { z, xt, zt };
}
/** d(0), d(1), d(2), each K + 4 long, tails placed per 5.1.3.2.2. */
export function turboEncode(c: Uint8Array): Uint8Array[] {
  const K = c.length, pi = qpp(K), ci = new Uint8Array(K);
  for (let i = 0; i < K; i++) ci[i] = c[pi[i]];
  const a = rsc(c), b = rsc(ci), d0 = new Uint8Array(K + 4), d1 = new Uint8Array(K + 4), d2 = new Uint8Array(K + 4);
  d0.set(c); d1.set(a.z); d2.set(b.z);
  d0.set([a.xt[0], a.zt[1], b.xt[0], b.zt[1]], K);
  d1.set([a.zt[0], a.xt[2], b.zt[0], b.xt[2]], K);
  d2.set([a.xt[1], a.zt[2], b.xt[1], b.zt[2]], K);
  return [d0, d1, d2];
}

const bufCache = new Map<string, { w: Int32Array; R: number }>();
/** Circular buffer w as stream * (K + 4) + index, -1 for <NULL> (the filler bits of d(0) and d(1) are <NULL>). */
export function rmBuffer(K: number, F: number): { w: Int32Array; R: number } {
  const key = `${K}:${F}`;
  let b = bufCache.get(key);
  if (b) return b;
  const D = K + 4, C = 32, R = Math.ceil(D / C), Kp = R * C, ND = Kp - D;
  const y = (i: number, q: number) => { const k = q - ND; return k < 0 || (i < 2 && k < F) ? -1 : i * D + k; };
  const w = new Int32Array(3 * Kp);
  let n = 0;
  for (let j = 0; j < C; j++) for (let r = 0; r < R; r++) w[n++] = y(0, r * C + PERM_TC[j]);
  for (let k = 0; k < Kp; k++) {
    w[n++] = y(1, (k % R) * C + PERM_TC[Math.floor(k / R)]);
    w[n++] = y(2, (PERM_TC[Math.floor(k / R)] + C * (k % R) + 1) % Kp);
  }
  b = { w, R };
  if (bufCache.size > 32) bufCache.clear();
  bufCache.set(key, b);
  return b;
}
const posCache = new Map<string, Int32Array>();
/** The coded-bit position carried by each of the E transmitted bits, redundancy version rv. */
export function rmPositions(K: number, F: number, E: number, rv: number): Int32Array {
  const key = `${K}:${F}:${E}:${rv}`, hit = posCache.get(key);
  if (hit) return hit;
  const { w, R } = rmBuffer(K, F), Ncb = w.length, k0 = R * (2 * Math.ceil(Ncb / (8 * R)) * rv + 2), out = new Int32Array(E);
  let n = 0, j = 0;
  while (n < E) { const q = w[(k0 + j) % Ncb]; if (q >= 0) out[n++] = q; j++; }
  if (posCache.size > 64) posCache.clear();
  posCache.set(key, out);
  return out;
}
export function rateMatch(d: Uint8Array[], F: number, E: number, rv: number): Uint8Array {
  const K = d[0].length - 4, D = K + 4, pos = rmPositions(K, F, E, rv), out = new Uint8Array(E);
  for (let i = 0; i < E; i++) out[i] = d[Math.floor(pos[i] / D)][pos[i] % D];
  return out;
}
/** Adds received soft bits into the 3 x (K + 4) accumulator; soft combining across RVs is addition. */
export function rateDematchAdd(llr: Float32Array, K: number, F: number, rv: number, acc: Float32Array[] | null): Float32Array[] {
  const D = K + 4, a = acc ?? [new Float32Array(D), new Float32Array(D), new Float32Array(D)], pos = rmPositions(K, F, llr.length, rv);
  for (let i = 0; i < llr.length; i++) a[Math.floor(pos[i] / D)][pos[i] % D] += llr[i];
  return a;
}

const NEG = -1e9;
/** One constituent max-log-MAP decoder: a-posteriori LLRs of the K inputs (positive = 0). */
function bcjr(Lu: Float32Array, Lp: Float32Array, Lut: number[], Lpt: number[], alpha: Float32Array, out: Float32Array): void {
  const K = Lu.length, T = K + 3;
  alpha.fill(NEG, 0, 8); alpha[0] = 0;
  for (let t = 0; t < T; t++) {
    const lu = t < K ? Lu[t] : Lut[t - K], lp = t < K ? Lp[t] : Lpt[t - K], a = t * 8, b = a + 8;
    for (let n = 0; n < 8; n++) alpha[b + n] = NEG;
    for (let s = 0; s < 8; s++) {
      const as = alpha[a + s];
      if (as <= NEG / 2) continue;
      for (let u = 0; u < 2; u++) {
        if (t >= K && u !== TERM_U[s]) continue;
        const v = as + 0.5 * ((u ? -lu : lu) + (PAR[s * 2 + u] ? -lp : lp)), n = NXT[s * 2 + u];
        if (v > alpha[b + n]) alpha[b + n] = v;
      }
    }
    let mx = NEG;
    for (let n = 0; n < 8; n++) if (alpha[b + n] > mx) mx = alpha[b + n];
    for (let n = 0; n < 8; n++) alpha[b + n] -= mx;
  }
  let beta = new Float32Array(8).fill(NEG), prev = new Float32Array(8);
  beta[0] = 0;
  for (let t = T - 1; t >= 0; t--) {
    const lu = t < K ? Lu[t] : Lut[t - K], lp = t < K ? Lp[t] : Lpt[t - K], a = t * 8;
    let m0 = NEG, m1 = NEG;
    prev.fill(NEG);
    for (let s = 0; s < 8; s++) for (let u = 0; u < 2; u++) {
      if (t >= K && u !== TERM_U[s]) continue;
      const v = 0.5 * ((u ? -lu : lu) + (PAR[s * 2 + u] ? -lp : lp)) + beta[NXT[s * 2 + u]];
      if (v > prev[s]) prev[s] = v;
      if (t < K) { const tot = alpha[a + s] + v; if (u) { if (tot > m1) m1 = tot; } else if (tot > m0) m0 = tot; }
    }
    if (t < K) out[t] = m0 - m1;
    let mx = NEG;
    for (let s = 0; s < 8; s++) if (prev[s] > mx) mx = prev[s];
    for (let s = 0; s < 8; s++) prev[s] -= mx;
    const tmp = beta; beta = prev; prev = tmp;
  }
}

/** acc: combined soft bits [3][K + 4]. Hard bits of the K inputs and whether crc() accepted them. */
export function turboDecode(acc: Float32Array[], K: number, F: number, crc: (bits: Uint8Array) => boolean, iters = 8, scale = 0.75): { bits: Uint8Array; ok: boolean; iters: number } {
  const pi = qpp(K), Ls = acc[0].slice(0, K), Lp1 = acc[1].subarray(0, K), Lp2 = acc[2].subarray(0, K);
  for (let i = 0; i < F; i++) Ls[i] = 50;
  const xt1 = [acc[0][K], acc[2][K], acc[1][K + 1]], zt1 = [acc[1][K], acc[0][K + 1], acc[2][K + 1]];
  const xt2 = [acc[0][K + 2], acc[2][K + 2], acc[1][K + 3]], zt2 = [acc[1][K + 2], acc[0][K + 3], acc[2][K + 3]];
  const La = new Float32Array(K), in1 = new Float32Array(K), in2 = new Float32Array(K), L1 = new Float32Array(K), L2 = new Float32Array(K);
  const Lsp = new Float32Array(K), La2 = new Float32Array(K), alpha = new Float32Array((K + 4) * 8), bits = new Uint8Array(K);
  for (let i = 0; i < K; i++) Lsp[i] = Ls[pi[i]];
  for (let it = 1; it <= iters; it++) {
    for (let i = 0; i < K; i++) in1[i] = Ls[i] + La[i];
    bcjr(in1, Lp1, xt1, zt1, alpha, L1);
    for (let i = 0; i < K; i++) { const j = pi[i]; La2[i] = (L1[j] - Ls[j] - La[j]) * scale; in2[i] = Lsp[i] + La2[i]; }
    bcjr(in2, Lp2, xt2, zt2, alpha, L2);
    for (let i = 0; i < K; i++) { const j = pi[i]; La[j] = (L2[i] - Lsp[i] - La2[i]) * scale; bits[j] = L2[i] < 0 ? 1 : 0; }
    if (crc(bits)) return { bits, ok: true, iters: it };
  }
  return { bits, ok: false, iters };
}
