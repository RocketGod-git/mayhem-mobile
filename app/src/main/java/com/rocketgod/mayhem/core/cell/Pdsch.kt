package com.rocketgod.mayhem.core.cell

import kotlin.math.min

/*
 * PDSCH carrying BCCH (SI-RNTI). 36.213 7.1.6.3 allocation type 2 (RIV), 7.1.7 TBS for SI-RNTI (I_TBS = I_MCS, QPSK,
 * DCI 1A column N_PRB 2 or 3 from the TPC LSB; DCI 1C Table 7.1.7.2.3-1). 36.211 6.2.3 localized and distributed VRBs,
 * 6.3.1 scrambling (c_init = n_RNTI 2^14 + q 2^13 + floor(ns/2) 2^9 + N_ID), 6.4 RE mapping (skipping CRS of the
 * configured ports, the control region, PSS/SSS in subframes 0 and 5 and PBCH in subframe 0 on the central 72
 * subcarriers). 36.212 5.3.2 DL-SCH: CRC-24A on one code block.
 */
val TBS_COL2 = intArrayOf(32, 56, 72, 104, 120, 144, 176, 224, 256, 296, 328, 376, 440, 488, 552, 600, 632, 696, 776, 840, 904, 1000, 1064, 1128, 1192, 1256, 1480)
val TBS_COL3 = intArrayOf(56, 88, 144, 176, 208, 224, 256, 328, 392, 456, 504, 584, 680, 744, 840, 904, 968, 1064, 1160, 1288, 1384, 1480, 1608, 1736, 1800, 1864, 2216)
val TBS_1C = intArrayOf(40, 56, 72, 120, 136, 144, 176, 208, 224, 256, 280, 296, 328, 336, 392, 488, 552, 600, 632, 696, 776, 840, 904, 1000, 1064, 1128, 1224, 1288, 1384, 1480, 1608, 1736)

/** Inverse of 7.1.6.3: [start, length]. */
fun rivDecode(riv: Int, n: Int): Pair<Int, Int> {
    val l1 = riv / n; val st = riv % n
    return if (l1 + 1 + st <= n) st to l1 + 1 else (n - 1 - st) to (n - l1 + 1)
}
fun rivEncode(start: Int, len: Int, n: Int): Int = if (len - 1 <= n / 2) n * (len - 1) + start else n * (n - len + 1) + (n - 1 - start)
private fun rbgSize(nrb: Int) = if (nrb <= 10) 1 else if (nrb <= 26) 2 else if (nrb <= 63) 3 else 4

/** Distributed VRB to PRB in the even (slot 0) or odd slot, 6.2.3.2. */
fun dvrbToPrb(v: Int, oddSlot: Boolean, nrb: Int, gap2: Boolean = false): Int {
    val (g1, g2) = gapValues(nrb)
    val ngap: Int; val nvrb: Int; val nt: Int
    if (gap2 && g2 != null && g2 != 0) { ngap = g2; nvrb = (nrb / (2 * ngap)) * 2 * ngap; nt = 2 * ngap }
    else { ngap = g1; nvrb = 2 * min(ngap, nrb - ngap); nt = nvrb }
    val p0 = rbgSize(nrb); val nrow = ((nt + 4 * p0 - 1) / (4 * p0)) * p0; val nnull = 4 * nrow - nt
    val ntl = v % nt; val base = nt * (v / nt)
    val n1 = 2 * nrow * (ntl % 2) + ntl / 2 + base; val n2 = nrow * (ntl % 4) + ntl / 4 + base
    var p = when {
        nnull != 0 && ntl >= nt - nnull && ntl % 2 == 1 -> n1 - nrow
        nnull != 0 && ntl >= nt - nnull && ntl % 2 == 0 -> n1 - nrow + nnull / 2
        nnull != 0 && ntl < nt - nnull && ntl % 4 >= 2 -> n2 - nnull / 2
        else -> n2
    }
    if (oddSlot) p = (p + nt / 2) % nt + base
    return if (p < nvrb / 2) p else p + ngap - nvrb / 2
}
/** PRBs used in slot 0 and slot 1. */
fun allocation(d: Dci, nrb: Int): Pair<List<Int>, List<Int>> {
    if (d is Dci1A) {
        val (st, l) = rivDecode(d.riv, nrb); val v = (0 until l).map { st + it }
        if (d.distributed == 0) return v to v
        val gap2 = d.ndiOrGap != 0 && nrb >= 50
        return v.map { dvrbToPrb(it, false, nrb, gap2) } to v.map { dvrbToPrb(it, true, nrb, gap2) }
    }
    d as Dci1C
    val (g1, g2) = gapValues(nrb); val gap2 = d.gap != 0 && g2 != null && g2 != 0; val ngap = if (gap2) g2!! else g1
    val nvrb = if (gap2) (nrb / (2 * ngap)) * 2 * ngap else 2 * min(ngap, nrb - ngap); val step = if (nrb < 50) 2 else 4
    val nn = nvrb / step
    if (nn <= 0) return emptyList<Int>() to emptyList()
    val (st, l) = rivDecode(d.rba, nn); val v = (0 until l * step).map { st * step + it }
    return v.map { dvrbToPrb(it, false, nrb, gap2) } to v.map { dvrbToPrb(it, true, nrb, gap2) }
}
fun tbsSi(d: Dci): Int? {
    if (d is Dci1C) return TBS_1C.getOrNull(d.tbsIndex)
    val a = d as Dci1A
    if (a.mcs > 26) return null
    return (if (a.nPrb1A == 3) TBS_COL3 else TBS_COL2)[a.mcs]
}

/**
 * Grid indices of the PDSCH REs, mapping order (k over the assigned PRBs first, then l).
 * In TDD the SSS is symbol 13 of subframes 0/5 and the PSS symbol 2 of subframes 1/6.
 */
fun pdschRes(pci: Int, nrb: Int, nports: Int, sf: Int, cfi: Int, prb0: List<Int>, prb1: List<Int>, tdd: Boolean = false): IntArray {
    val kk = 12 * nrb; val crs = crsMask(pci, nrb, nports); val c0 = nrb * 6 - 36; val c1 = nrb * 6 + 36; val l0 = if (nrb > 10) cfi else cfi + 1
    val out = ArrayList<Int>()
    val s0 = prb0.sorted(); val s1 = prb1.sorted()
    for (l in l0 until 14) for (p in (if (l < 7) s0 else s1)) for (k in 12 * p until 12 * p + 12) {
        if (crs[l * kk + k].toInt() != 0) continue
        if (k >= c0 && k < c1) {
            if (!tdd && (sf == 0 || sf == 5) && (l == 5 || l == 6)) continue
            if (tdd && (((sf == 0 || sf == 5) && l == 13) || ((sf == 1 || sf == 6) && l == 2))) continue
            if (sf == 0 && l >= 7 && l <= 10) continue
        }
        out.add(l * kk + k)
    }
    return out.toIntArray()
}
fun pdschLlr(g: Grid, h: Chan, pci: Int, nrb: Int, nports: Int, sf: Int, cfi: Int, prb0: List<Int>, prb1: List<Int>, rnti: Int = 0xffff, tdd: Boolean = false): FloatArray {
    val res = pdschRes(pci, nrb, nports, sf, cfi, prb0, prb1, tdd); val x = tdDecode(g, h, res, nports); val llr = qpskLlr(x, h.nv)
    val c = gold(rnti.toLong() * 16384 + sf * 512 + pci, llr.size)
    for (i in llr.indices) if (c[i].toInt() != 0) llr[i] = -llr[i]
    return llr
}

/** Soft-combining DL-SCH decoder for one transport block size (one code block). */
class TbDecoder(val A: Int) {
    val B = A + 24; val K = blockSize(B); val F = K - B
    var acc: Array<FloatArray>? = null
    var n = 0
    fun add(llr: FloatArray, rv: Int) { acc = rateDematchAdd(llr, K, F, rv, acc); n++ }
    fun decode(iters: Int = 8): ByteArray? {
        val a = acc ?: return null
        val ok = { bits: ByteArray ->
            val p = crcBits(bits, CRC24A, A, F)
            (0 until 24).all { p[it] == bits[F + A + it] }
        }
        val r = turboDecode(a, K, F, ok, iters)
        return if (r.ok) r.bits.copyOfRange(F, F + A) else null
    }
}
