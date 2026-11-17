/**
 * PDSCH carrying BCCH (SI-RNTI). 36.213 7.1.6.3 allocation type 2 (RIV), 7.1.7 TBS for SI-RNTI (I_TBS = I_MCS, QPSK,
 * DCI 1A column N_PRB 2 or 3 from the TPC LSB; DCI 1C Table 7.1.7.2.3-1). 36.211 6.2.3 localized and distributed VRBs,
 * 6.3.1 scrambling (c_init = n_RNTI 2^14 + q 2^13 + floor(ns/2) 2^9 + N_ID), 6.4 RE mapping (skipping CRS of the
 * configured ports, the control region, PSS/SSS in subframes 0 and 5 and PBCH in subframe 0 on the central 72
 * subcarriers). 36.212 5.3.2 DL-SCH: CRC-24A on one code block.
 */
import { CRC24A, Chan, Grid, crcBits, crsMask, gold, qpskLlr, tdDecode } from './common.js';
import { gapValues, type Dci, type Dci1A, type Dci1C } from './pdcch.js';
import { blockSize, rateDematchAdd, turboDecode } from './turbo.js';

export const TBS_COL2 = [32, 56, 72, 104, 120, 144, 176, 224, 256, 296, 328, 376, 440, 488, 552, 600, 632, 696, 776, 840, 904, 1000, 1064, 1128, 1192, 1256, 1480];
export const TBS_COL3 = [56, 88, 144, 176, 208, 224, 256, 328, 392, 456, 504, 584, 680, 744, 840, 904, 968, 1064, 1160, 1288, 1384, 1480, 1608, 1736, 1800, 1864, 2216];
export const TBS_1C = [40, 56, 72, 120, 136, 144, 176, 208, 224, 256, 280, 296, 328, 336, 392, 488, 552, 600, 632, 696, 776, 840, 904, 1000, 1064, 1128, 1224, 1288, 1384, 1480, 1608, 1736];

/** Inverse of 7.1.6.3: [start, length]. */
export function rivDecode(riv: number, n: number): [number, number] {
  const L1 = Math.floor(riv / n), st = riv % n;
  return L1 + 1 + st <= n ? [st, L1 + 1] : [n - 1 - st, n - L1 + 1];
}
export function rivEncode(start: number, len: number, n: number): number {
  return len - 1 <= Math.floor(n / 2) ? n * (len - 1) + start : n * (n - len + 1) + (n - 1 - start);
}
const rbgSize = (nrb: number) => nrb <= 10 ? 1 : nrb <= 26 ? 2 : nrb <= 63 ? 3 : 4;

/** Distributed VRB to PRB in the even (slot 0) or odd slot, 6.2.3.2. */
export function dvrbToPrb(v: number, oddSlot: boolean, nrb: number, gap2 = false): number {
  const [g1, g2] = gapValues(nrb);
  let Ngap: number, Nvrb: number, Nt: number;
  if (gap2 && g2) { Ngap = g2; Nvrb = Math.floor(nrb / (2 * Ngap)) * 2 * Ngap; Nt = 2 * Ngap; }
  else { Ngap = g1; Nvrb = 2 * Math.min(Ngap, nrb - Ngap); Nt = Nvrb; }
  const P = rbgSize(nrb), Nrow = Math.ceil(Nt / (4 * P)) * P, Nnull = 4 * Nrow - Nt;
  const nt = v % Nt, base = Nt * Math.floor(v / Nt);
  const n1 = 2 * Nrow * (nt % 2) + Math.floor(nt / 2) + base, n2 = Nrow * (nt % 4) + Math.floor(nt / 4) + base;
  let p: number;
  if (Nnull && nt >= Nt - Nnull && nt % 2 === 1) p = n1 - Nrow;
  else if (Nnull && nt >= Nt - Nnull && nt % 2 === 0) p = n1 - Nrow + Nnull / 2;
  else if (Nnull && nt < Nt - Nnull && nt % 4 >= 2) p = n2 - Nnull / 2;
  else p = n2;
  if (oddSlot) p = (p + Nt / 2) % Nt + base;
  return p < Nvrb / 2 ? p : p + Ngap - Nvrb / 2;
}
/** PRBs used in slot 0 and slot 1. */
export function allocation(d: Dci, nrb: number): [number[], number[]] {
  if (d.fmt === '1A') {
    const [st, L] = rivDecode(d.riv, nrb), v = Array.from({ length: L }, (_, i) => st + i);
    if (!d.distributed) return [v, v];
    const gap2 = !!d.ndiOrGap && nrb >= 50;
    return [v.map(x => dvrbToPrb(x, false, nrb, gap2)), v.map(x => dvrbToPrb(x, true, nrb, gap2))];
  }
  const [g1, g2] = gapValues(nrb), gap2 = !!d.gap && !!g2, Ngap = gap2 ? g2! : g1;
  const Nvrb = gap2 ? Math.floor(nrb / (2 * Ngap)) * 2 * Ngap : 2 * Math.min(Ngap, nrb - Ngap), step = nrb < 50 ? 2 : 4;
  const [st, L] = rivDecode(d.rba, Math.floor(Nvrb / step)), v = Array.from({ length: L * step }, (_, i) => st * step + i);
  return [v.map(x => dvrbToPrb(x, false, nrb, gap2)), v.map(x => dvrbToPrb(x, true, nrb, gap2))];
}
export function tbsSi(d: Dci): number | null {
  if (d.fmt === '1C') return TBS_1C[(d as Dci1C).tbsIndex] ?? null;
  const a = d as Dci1A;
  if (a.mcs > 26) return null;
  return (a.nPrb1A === 3 ? TBS_COL3 : TBS_COL2)[a.mcs];
}

/** Grid indices of the PDSCH REs, mapping order (k over the assigned PRBs first, then l). */
/** In TDD the SSS is symbol 13 of subframes 0/5 and the PSS symbol 2 of subframes 1/6. */
export function pdschRes(pci: number, nrb: number, nports: number, sf: number, cfi: number, prb0: number[], prb1: number[], tdd = false): Int32Array {
  const K = 12 * nrb, crs = crsMask(pci, nrb, nports), c0 = nrb * 6 - 36, c1 = nrb * 6 + 36, l0 = nrb > 10 ? cfi : cfi + 1, out: number[] = [];
  const s0 = [...prb0].sort((a, b) => a - b), s1 = [...prb1].sort((a, b) => a - b);
  for (let l = l0; l < 14; l++) for (const p of l < 7 ? s0 : s1) for (let k = 12 * p; k < 12 * p + 12; k++) {
    if (crs[l * K + k]) continue;
    if (k >= c0 && k < c1) {
      if (!tdd && (sf === 0 || sf === 5) && (l === 5 || l === 6)) continue;
      if (tdd && (((sf === 0 || sf === 5) && l === 13) || ((sf === 1 || sf === 6) && l === 2))) continue;
      if (sf === 0 && l >= 7 && l <= 10) continue;
    }
    out.push(l * K + k);
  }
  return Int32Array.from(out);
}
export function pdschLlr(g: Grid, H: Chan, pci: number, nrb: number, nports: number, sf: number, cfi: number, prb0: number[], prb1: number[], rnti = 0xffff, tdd = false): Float32Array {
  const res = pdschRes(pci, nrb, nports, sf, cfi, prb0, prb1, tdd), x = tdDecode(g, H, res, nports), llr = qpskLlr(x, H.nv);
  const c = gold(rnti * 16384 + sf * 512 + pci, llr.length);
  for (let i = 0; i < llr.length; i++) if (c[i]) llr[i] = -llr[i];
  return llr;
}

/** Soft-combining DL-SCH decoder for one transport block size (one code block). */
export class TbDecoder {
  readonly B: number; readonly K: number; readonly F: number;
  acc: Float32Array[] | null = null;
  n = 0;
  constructor(readonly A: number) { this.B = A + 24; this.K = blockSize(this.B); this.F = this.K - this.B; }
  add(llr: Float32Array, rv: number): void { this.acc = rateDematchAdd(llr, this.K, this.F, rv, this.acc); this.n++; }
  decode(iters = 8): Uint8Array | null {
    if (!this.acc) return null;
    const { A, F } = this, ok = (bits: Uint8Array) => {
      const p = crcBits(bits.subarray(F), CRC24A, A);
      for (let i = 0; i < 24; i++) if (p[i] !== bits[F + A + i]) return false;
      return true;
    };
    const r = turboDecode(this.acc, this.K, F, ok, iters);
    return r.ok ? r.bits.slice(F, F + A) : null;
  }
}
