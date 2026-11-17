/**
 * PBCH and MIB. 36.211 6.6 (scrambling with c_init = PCI over 1920 bits per 40 ms, QPSK, transmit diversity, the 240
 * REs of symbols 0..3 of slot 1 on the central 72 subcarriers, CRS REs of all four ports skipped).
 * 36.212 5.3.1 (24-bit MIB, CRC-16 masked by the port count), 5.1.3.1 tail-biting convolutional code K=7
 * (133, 171, 165 octal), 5.1.4.2 rate matching for convolutional codes. 36.331 MasterInformationBlock.
 */
import { CRC16, Grid, bitsToInt, chanEst, crcBits, crsShift, crsSymbols, gold, qpskLlr, tdDecode } from './common.js';

const GEN = [0o133, 0o171, 0o165];
const TAPS = GEN.map(g => Array.from({ length: 7 }, (_, i) => (g >> (6 - i)) & 1));

/** Tail-biting encoder: d[i][k], register seeded with the last 6 input bits. */
export function convEncode(c: ArrayLike<number>): Uint8Array[] {
  const K = c.length, d = [new Uint8Array(K), new Uint8Array(K), new Uint8Array(K)];
  for (let k = 0; k < K; k++) for (let i = 0; i < 3; i++) {
    let v = 0;
    for (let j = 0; j < 7; j++) v ^= TAPS[i][j] & c[(k - j + K * 7) % K];
    d[i][k] = v;
  }
  return d;
}

// trellis: state = (c_{k-1} .. c_{k-6}), c_{k-1} in bit 5; next = (b << 5) | (s >> 1)
const OUT = new Int8Array(64 * 2 * 3);
for (let s = 0; s < 64; s++) for (let b = 0; b < 2; b++) for (let i = 0; i < 3; i++) {
  let v = TAPS[i][0] & b;
  for (let j = 1; j < 7; j++) v ^= TAPS[i][j] & ((s >> (6 - j)) & 1);
  OUT[(s * 2 + b) * 3 + i] = 1 - 2 * v;
}

/** Tail-biting Viterbi by wrap-around (three copies, the middle kept). llr[i][k], positive = 0. */
export function viterbiTb(llr: Float32Array[], K: number, reps = 3): Uint8Array {
  const T = K * reps, choice = new Uint8Array(T * 64);
  let metric = new Float32Array(64), next = new Float32Array(64);
  const bm = new Float32Array(128);
  for (let t = 0; t < T; t++) {
    const k = t % K, l0 = llr[0][k], l1 = llr[1][k], l2 = llr[2][k];
    for (let q = 0; q < 128; q++) bm[q] = OUT[q * 3] * l0 + OUT[q * 3 + 1] * l1 + OUT[q * 3 + 2] * l2;
    let mx = -Infinity;
    for (let n = 0; n < 64; n++) {
      const b = n >> 5, p0 = (n & 31) << 1, p1 = p0 | 1;
      const m0 = metric[p0] + bm[p0 * 2 + b], m1 = metric[p1] + bm[p1 * 2 + b];
      if (m1 > m0) { next[n] = m1; choice[t * 64 + n] = 1; } else next[n] = m0;
      if (next[n] > mx) mx = next[n];
    }
    for (let n = 0; n < 64; n++) next[n] -= mx;
    const tmp = metric; metric = next; next = tmp;
  }
  let s = 0;
  for (let n = 1; n < 64; n++) if (metric[n] > metric[s]) s = n;
  const bits = new Uint8Array(T);
  for (let t = T - 1; t >= 0; t--) { bits[t] = s >> 5; s = ((s & 31) << 1) | choice[t * 64 + s]; }
  const mid = Math.floor(reps / 2) * K;
  return bits.slice(mid, mid + K);
}

export const PERM_CC = [1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31, 0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30];

const rmCache = new Map<string, Int32Array>();
/** For each output bit e_k: stream * D + index of the coded bit (5.1.4.2). */
export function ccRmMap(D: number, E: number): Int32Array {
  const key = `${D}:${E}`, hit = rmCache.get(key);
  if (hit) return hit;
  const C = 32, R = Math.ceil(D / C), ND = R * C - D, w: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < C; j++) for (let r = 0; r < R; r++) {
    const q = r * C + PERM_CC[j] - ND;
    if (q >= 0) w.push(i * D + q);
  }
  const out = new Int32Array(E);
  for (let k = 0; k < E; k++) out[k] = w[k % w.length];
  if (rmCache.size > 64) rmCache.clear();
  rmCache.set(key, out);
  return out;
}
/** Sums the received soft bits into the 3 x D coded positions. */
export function ccDematch(e: Float32Array, D: number, from = 0, len = e.length - from, kOffset = 0, E = len): Float32Array[] {
  const m = ccRmMap(D, E), acc = [new Float32Array(D), new Float32Array(D), new Float32Array(D)];
  for (let k = 0; k < len; k++) { const v = m[k + kOffset]; acc[Math.floor(v / D)][v % D] += e[from + k]; }
  return acc;
}
/** Rate matching forward: the E transmitted bits of a coded block d[3][D]. */
export function ccRateMatch(d: Uint8Array[], E: number): Uint8Array {
  const D = d[0].length, m = ccRmMap(D, E), out = new Uint8Array(E);
  for (let k = 0; k < E; k++) out[k] = d[Math.floor(m[k] / D)][m[k] % D];
  return out;
}

/** Grid indices (nrb grid) of the 240 PBCH REs of subframe 0, mapping order. */
export function pbchRes(pci: number, nrb: number): Int32Array {
  const K = 12 * nrb, k0 = nrb * 6 - 36, out: number[] = [];
  for (const l of [7, 8, 9, 10]) for (let k = k0; k < k0 + 72; k++) {
    let crs = false;
    for (let p = 0; p < 4; p++) if (crsSymbols(p).includes(l) && ((k - crsShift(p, l, pci)) % 6 + 6) % 6 === 0) crs = true;
    if (!crs) out.push(l * K + k);
  }
  return Int32Array.from(out);
}

export const MIB_MASK: Record<number, number> = { 1: 0x0000, 2: 0xffff, 4: 0x5555 };
export interface Mib {
  bandwidth: number; phichDuration: 'normal' | 'extended'; phichResource: 'oneSixth' | 'half' | 'one' | 'two';
  sfn: number; sib1BR: number; unchangedBR: boolean; ports: number; bits: string;
}
export const NRB_OF = [6, 15, 25, 50, 75, 100];
export function parseMib(b: Uint8Array, frameInTti: number, ports: number): Mib | null {
  const bw = bitsToInt(b, 0, 3);
  if (bw > 5) return null;
  return {
    bandwidth: NRB_OF[bw], phichDuration: b[3] ? 'extended' : 'normal', phichResource: (['oneSixth', 'half', 'one', 'two'] as const)[bitsToInt(b, 4, 2)],
    sfn: bitsToInt(b, 6, 8) * 4 + frameInTti, sib1BR: bitsToInt(b, 14, 5), unchangedBR: !!b[19], ports, bits: Array.from(b.slice(0, 24)).join(''),
  };
}

/** Decodes one frame's 480 PBCH soft bits as each of the 4 positions in the 40 ms TTI; CRC with the port masks. */
export function decodeMibLlr(llr: Float32Array, pci: number, precodePorts: number): Mib | null {
  const c = gold(pci, 1920), hits: Mib[] = [];
  for (let j = 0; j < 4; j++) {
    const l = new Float32Array(480);
    for (let i = 0; i < 480; i++) l[i] = c[480 * j + i] ? -llr[i] : llr[i];
    const acc = ccDematch(l, 40, 0, 480, 480 * j, 1920), bits = viterbiTb(acc, 40), par = crcBits(bits, CRC16, 24);
    const rx = bitsToInt(bits, 24, 16), p = bitsToInt(par);
    for (const ports of [1, 2, 4]) if ((p ^ MIB_MASK[ports]) === rx) { const m = parseMib(bits, j, ports); if (m) hits.push(m); }
  }
  // the CRC mask decides the port count; a matching precoding hypothesis is preferred
  hits.sort((a, b) => Number(a.ports !== precodePorts) - Number(b.ports !== precodePorts));
  return hits[0] ?? null;
}

/** Tries 1, 2 and 4 port precoding on a demodulated subframe 0 (nrb-wide grid, usually the central 6 RBs). */
export function decodeMib(g: Grid, pci: number, nrb: number): { mib: Mib; snr: number } | null {
  const res = pbchRes(pci, nrb);
  for (const np of [4, 2, 1]) {
    const H = chanEst(g, 0, pci, nrb, np), x = tdDecode(g, H, res, np), llr = qpskLlr(x, H.nv);
    const m = decodeMibLlr(llr, pci, np);
    if (m) return { mib: m, snr: H.snr };
  }
  return null;
}
