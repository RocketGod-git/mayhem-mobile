/**
 * PCFICH and PDCCH, common search space, SI-RNTI and P-RNTI. 36.211 6.2.4 REGs, 6.7 PCFICH, 6.9.3 PHICH mapping (the REGs it
 * takes from symbol 0, normal duration), 6.8 PDCCH (scrambling, quadruplet interleaving with the 36.212 5.1.4.2.1
 * sub-block interleaver, cyclic shift by N_ID, k-first mapping over the free REGs). 36.212 5.3.4 CFI code words,
 * 5.3.3 DCI CRC with the RNTI on the parity, formats 1A and 1C with the ambiguous-size padding. 36.213 9.1.1 common
 * search space (aggregation 4 x 4 candidates and 8 x 2, Y_k = 0).
 */
import { CRC16, Chan, Grid, bitsToInt, crcBits, crsMask, gold, qpskLlr, tdDecode } from './common.js';
import { PERM_CC, ccDematch, viterbiTb } from './pbch.js';

export const SI_RNTI = 0xffff;
const CFI_CW: Record<number, number[]> = { 1: [], 2: [], 3: [] };
for (let i = 0; i < 32; i++) { CFI_CW[1].push([0, 1, 1][i % 3]); CFI_CW[2].push([1, 0, 1][i % 3]); CFI_CW[3].push([1, 1, 0][i % 3]); }
export const cfiCodeword = (cfi: number) => CFI_CW[cfi];

export interface Reg { k0: number; l: number; n: number; ks: number[] }
/** All REGs of symbols 0..L-1 (CRS excluded; with one port, ports 0 and 1 are assumed). */
export function regs(pci: number, nrb: number, nports: number, L: number): Reg[] {
  const K = 12 * nrb, crs = crsMask(pci, nrb, Math.max(nports, 2)), out: Reg[] = [];
  for (let l = 0; l < L; l++) for (let prb = 0; prb < nrb; prb++) {
    const k0 = 12 * prb, six = l === 0 || (l === 1 && nports === 4);
    const groups = six ? [[k0, 6], [k0 + 6, 6]] : [[k0, 4], [k0 + 4, 4], [k0 + 8, 4]];
    for (const [g, n] of groups) {
      const ks: number[] = [];
      for (let k = g; k < g + n; k++) if (!crs[l * K + k]) ks.push(k);
      out.push({ k0: g, l, n, ks });
    }
  }
  return out;
}
const regAt = (R: Reg[], k: number, l: number) => R.find(r => r.l === l && k >= r.k0 && k < r.k0 + r.n)!;

export function pcfichRegs(pci: number, nrb: number, R: Reg[]): Reg[] {
  const kbar = 6 * (pci % (2 * nrb)), out: Reg[] = [];
  for (let i = 0; i < 4; i++) out.push(regAt(R, (kbar + Math.floor(i * nrb / 2) * 6) % (12 * nrb), 0));
  return out;
}
export function phichRegs(pci: number, nrb: number, R: Reg[], pc: Reg[], ng: string, mi = 1): Reg[] {
  const ngv = ({ oneSixth: 1 / 6, half: 0.5, one: 1, two: 2 } as Record<string, number>)[ng] ?? 1;
  const groups = mi * Math.ceil(ngv * nrb / 8), free0 = R.filter(r => r.l === 0 && !pc.includes(r)).sort((a, b) => a.k0 - b.k0), n0 = free0.length, out: Reg[] = [];
  for (let m = 0; m < groups; m++) for (let i = 0; i < 3; i++) out.push(free0[(pci + m + Math.floor(i * n0 / 3)) % n0]);
  return out;
}
/** Sub-block interleaver on M quadruplets: output j carries input perm[j]. */
export function quadInterleaver(M: number): number[] {
  const C = 32, R = Math.ceil(M / C), ND = R * C - M, out: number[] = [];
  for (let j = 0; j < C; j++) for (let r = 0; r < R; r++) { const q = r * C + PERM_CC[j] - ND; if (q >= 0) out.push(q); }
  return out;
}

export interface DciSizes { f0: number; f1a: number; f1c: number; riv: number }
const AMBIG = new Set([12, 14, 16, 20, 24, 26, 32, 40, 44, 56]);
/** N_gap1, N_gap2 of 36.211 Table 6.2.3.2-1. */
export function gapValues(nrb: number): [number, number | null] {
  if (nrb <= 10) return [Math.ceil(nrb / 2), null];
  if (nrb === 11) return [4, null];
  if (nrb <= 19) return [8, null];
  if (nrb <= 26) return [12, null];
  if (nrb <= 44) return [18, null];
  if (nrb <= 49) return [27, null];
  if (nrb <= 63) return [27, 9];
  if (nrb <= 79) return [32, 16];
  return [48, 16];
}
/** Format 0/1A/1C sizes; TDD adds the 4-bit HARQ number and the DAI to 1A and the UL index or DAI to 0. */
export function dciSizes(nrb: number, tdd = false): DciSizes {
  const riv = Math.ceil(Math.log2(nrb * (nrb + 1) / 2));
  const f0 = 1 + 1 + riv + 5 + 1 + 2 + 3 + 1 + (tdd ? 2 : 0);
  let f1a = Math.max(1 + 1 + riv + 5 + (tdd ? 4 : 3) + 1 + 2 + 2 + (tdd ? 2 : 0), f0);
  if (AMBIG.has(f1a)) f1a++;
  const g1 = gapValues(nrb)[0], nvrb = 2 * Math.min(g1, nrb - g1), step = nrb < 50 ? 2 : 4, n = Math.floor(nvrb / step);
  const f1c = (nrb >= 50 ? 1 : 0) + Math.ceil(Math.log2(n * (n + 1) / 2)) + 5;
  return { f0, f1a, f1c, riv };
}
export interface Dci1A { fmt: '1A'; distributed: number; riv: number; mcs: number; harq: number; ndiOrGap: number; rv: number; tpc: number; nPrb1A: number }
export interface Dci1C { fmt: '1C'; gap: number; rba: number; tbsIndex: number }
export type Dci = Dci1A | Dci1C;
export function parse1A(b: Uint8Array, nrb: number, tdd = false): Dci1A | null {
  if (!b[0]) return null;
  const riv = Math.ceil(Math.log2(nrb * (nrb + 1) / 2));
  let i = 1;
  const take = (n: number) => { const v = bitsToInt(b, i, n); i += n; return v; };
  const distributed = take(1), rv0 = take(riv), mcs = take(5), harq = take(tdd ? 4 : 3), ndi = take(1), rv = take(2), tpc = take(2);
  return { fmt: '1A', distributed, riv: rv0, mcs, harq, ndiOrGap: ndi, rv, tpc, nPrb1A: tpc & 1 ? 3 : 2 };
}
export function parse1C(b: Uint8Array, nrb: number): Dci1C {
  let i = 0, gap = 0;
  if (nrb >= 50) { gap = b[0]; i = 1; }
  const nb = b.length - 5 - i;
  return { fmt: '1C', gap, rba: bitsToInt(b, i, nb), tbsIndex: bitsToInt(b, i + nb, 5) };
}

/** Encodes DCI bits with the RNTI-masked CRC (5.3.3.2) for the tests' transmitter and the decoder's re-check. */
export function dciWithCrc(bits: Uint8Array, rnti: number): Uint8Array {
  const p = crcBits(bits, CRC16), out = new Uint8Array(bits.length + 16);
  out.set(bits);
  for (let i = 0; i < 16; i++) out[bits.length + i] = p[i] ^ ((rnti >> (15 - i)) & 1);
  return out;
}

export interface DciHit { L: number; cce: number; size: number; bits: Uint8Array; dci: Dci; rnti: number }
/** Per cell control-region decoder: CFI, then blind decoding of the common search space for SI-RNTI and P-RNTI. */
export class ControlDecoder {
  readonly sizes: DciSizes;
  private readonly R: Reg[][] = [];
  readonly pc: Reg[]; readonly ph: Reg[];
  private readonly layouts = new Map<number, { order: Reg[]; zidx: Int32Array; M: number; idx: Int32Array }>();
  /** mi: the PHICH group factor m_i of 36.211 Table 6.9-1 for the subframe (1 in FDD). */
  constructor(readonly pci: number, readonly nrb: number, readonly nports: number, phich: string, readonly tdd = false, mi = 1) {
    for (const L of [1, 2, 3, 4]) this.R[L] = regs(pci, nrb, nports, L);
    this.pc = pcfichRegs(pci, nrb, this.R[1]);
    this.ph = phichRegs(pci, nrb, this.R[1], this.pc, phich, mi);
    this.sizes = dciSizes(nrb, tdd);
  }
  /** REG order of 6.8.5 (by frequency, then symbol), its interleaved z index, and grid indices of every RE. */
  layout(L: number): { order: Reg[]; zidx: Int32Array; M: number; idx: Int32Array } {
    let lay = this.layouts.get(L);
    if (lay) return lay;
    const K = 12 * this.nrb, used = new Set([...this.pc, ...this.ph].map(r => r.l * 10_000 + r.k0));
    const order = this.R[L].filter(r => !used.has(r.l * 10_000 + r.k0)).sort((a, b) => a.k0 - b.k0 || a.l - b.l);
    const M = order.length, perm = quadInterleaver(M), zidx = new Int32Array(M);
    for (let m = 0; m < M; m++) zidx[m] = perm[(m + this.pci) % M];
    const idx = new Int32Array(4 * M);
    order.forEach((r, i) => r.ks.forEach((k, j) => { idx[4 * i + j] = r.l * K + k; }));
    lay = { order, zidx, M, idx };
    this.layouts.set(L, lay);
    return lay;
  }
  regIdx(list: Reg[]): Int32Array {
    const K = 12 * this.nrb, idx = new Int32Array(4 * list.length);
    list.forEach((r, i) => r.ks.forEach((k, j) => { idx[4 * i + j] = r.l * K + k; }));
    return idx;
  }
  cfi(g: Grid, H: Chan, sf: number): { cfi: number; margin: number } {
    const x = tdDecode(g, H, this.regIdx(this.pc), this.nports), llr = qpskLlr(x, H.nv);
    const c = gold(((sf + 1) * (2 * this.pci + 1) << 9) + this.pci, 32);
    const sc = [1, 2, 3].map(v => { let s = 0; const cw = CFI_CW[v]; for (let i = 0; i < 32; i++) s += (c[i] ? -llr[i] : llr[i]) * (1 - 2 * cw[i]); return s; });
    const order = [0, 1, 2].sort((a, b) => sc[b] - sc[a]);
    return { cfi: order[0] + 1, margin: sc[order[0]] - sc[order[1]] };
  }
  /** Descrambled soft bits of the whole control region, CCE-ordered (bits 72n..72n+71 = CCE n). */
  softBits(g: Grid, H: Chan, sf: number, L: number): { soft: Float32Array; ncce: number } {
    const lay = this.layout(L), x = tdDecode(g, H, lay.idx, this.nports), llr = qpskLlr(x, H.nv), soft = new Float32Array(8 * lay.M);
    for (let m = 0; m < lay.M; m++) for (let j = 0; j < 8; j++) soft[8 * lay.zidx[m] + j] = llr[8 * m + j];
    const c = gold((sf << 9) + this.pci, 8 * lay.M);
    for (let i = 0; i < soft.length; i++) if (c[i]) soft[i] = -soft[i];
    return { soft, ncce: Math.floor(lay.M / 9) };
  }
  /** Every DCI in the common search space whose CRC carries one of the RNTIs (one Viterbi pass serves them all). */
  search(g: Grid, H: Chan, sf: number, cfi: number, rntis: number[] = [SI_RNTI]): DciHit[] {
    const { soft, ncce } = this.softBits(g, H, sf, cfi), hits: DciHit[] = [], seen = new Set<string>();
    const sizes = [...new Set([this.sizes.f1a, this.sizes.f1c])];
    for (const [Lagg, ncand] of [[4, 4], [8, 2]]) {
      const nposs = Math.floor(ncce / Lagg);
      for (let m = 0; m < Math.min(ncand, nposs); m++) {
        const cce0 = Lagg * (m % nposs), from = 72 * cce0, len = 72 * Lagg;
        for (const A of sizes) {
          const D = A + 16, acc = ccDematch(soft, D, from, len), bits = viterbiTb(acc, D), par = crcBits(bits, CRC16, A);
          const rnti = bitsToInt(par) ^ bitsToInt(bits, A, 16);
          if (!rntis.includes(rnti)) continue;
          const b = bits.slice(0, A), key = rnti + ':' + Array.from(b).join('');
          if (seen.has(key)) continue;
          seen.add(key);
          const dci = A === this.sizes.f1c ? parse1C(b, this.nrb) : parse1A(b, this.nrb, this.tdd);
          if (dci) hits.push({ L: Lagg, cce: cce0, size: A, bits: b, dci, rnti });
        }
      }
    }
    return hits;
  }
}
