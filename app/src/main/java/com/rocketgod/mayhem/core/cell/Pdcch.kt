package com.rocketgod.mayhem.core.cell

import kotlin.math.ceil
import kotlin.math.min

/*
 * PCFICH and PDCCH, common search space, SI-RNTI and P-RNTI. 36.211 6.2.4 REGs, 6.7 PCFICH, 6.9.3 PHICH mapping (the REGs it
 * takes from symbol 0, normal duration), 6.8 PDCCH (scrambling, quadruplet interleaving with the 36.212 5.1.4.2.1
 * sub-block interleaver, cyclic shift by N_ID, k-first mapping over the free REGs). 36.212 5.3.4 CFI code words,
 * 5.3.3 DCI CRC with the RNTI on the parity, formats 1A and 1C with the ambiguous-size padding. 36.213 9.1.1 common
 * search space (aggregation 4 x 4 candidates and 8 x 2, Y_k = 0).
 */
const val SI_RNTI = 0xffff
private val CFI_CW: Map<Int, ByteArray> = mapOf(
    1 to ByteArray(32) { intArrayOf(0, 1, 1)[it % 3].toByte() },
    2 to ByteArray(32) { intArrayOf(1, 0, 1)[it % 3].toByte() },
    3 to ByteArray(32) { intArrayOf(1, 1, 0)[it % 3].toByte() },
)
fun cfiCodeword(cfi: Int): ByteArray = CFI_CW.getValue(cfi)

class Reg(val k0: Int, val l: Int, val n: Int, val ks: IntArray)
/** All REGs of symbols 0..L-1 (CRS excluded; with one port, ports 0 and 1 are assumed). */
fun regs(pci: Int, nrb: Int, nports: Int, nl: Int): List<Reg> {
    val kk = 12 * nrb; val crs = crsMask(pci, nrb, maxOf(nports, 2)); val out = ArrayList<Reg>()
    for (l in 0 until nl) for (prb in 0 until nrb) {
        val k0 = 12 * prb; val six = l == 0 || (l == 1 && nports == 4)
        val groups = if (six) listOf(k0 to 6, k0 + 6 to 6) else listOf(k0 to 4, k0 + 4 to 4, k0 + 8 to 4)
        for ((g, n) in groups) {
            val ks = (g until g + n).filter { crs[l * kk + it].toInt() == 0 }.toIntArray()
            out.add(Reg(g, l, n, ks))
        }
    }
    return out
}
private fun regAt(r: List<Reg>, k: Int, l: Int): Reg = r.first { it.l == l && k >= it.k0 && k < it.k0 + it.n }

fun pcfichRegs(pci: Int, nrb: Int, r: List<Reg>): List<Reg> {
    val kbar = 6 * (pci % (2 * nrb))
    return (0 until 4).map { i -> regAt(r, (kbar + (i * nrb / 2) * 6) % (12 * nrb), 0) }
}
fun phichRegs(pci: Int, nrb: Int, r: List<Reg>, pc: List<Reg>, ng: String, mi: Int = 1): List<Reg> {
    val ngv = when (ng) { "oneSixth" -> 1.0 / 6; "half" -> 0.5; "one" -> 1.0; "two" -> 2.0; else -> 1.0 }
    val groups = mi * ceil(ngv * nrb / 8).toInt()
    val free0 = r.filter { it.l == 0 && it !in pc }.sortedBy { it.k0 }; val n0 = free0.size; val out = ArrayList<Reg>()
    for (m in 0 until groups) for (i in 0 until 3) out.add(free0[(pci + m + (i * n0 / 3)) % n0])
    return out
}
/** Sub-block interleaver on M quadruplets: output j carries input perm[j]. */
fun quadInterleaver(m: Int): IntArray {
    val c = 32; val r = (m + c - 1) / c; val nd = r * c - m; val out = ArrayList<Int>()
    for (j in 0 until c) for (row in 0 until r) { val q = row * c + PERM_CC[j] - nd; if (q >= 0) out.add(q) }
    return out.toIntArray()
}

data class DciSizes(val f0: Int, val f1a: Int, val f1c: Int, val riv: Int)
private val AMBIG = setOf(12, 14, 16, 20, 24, 26, 32, 40, 44, 56)
/** N_gap1, N_gap2 of 36.211 Table 6.2.3.2-1. */
fun gapValues(nrb: Int): Pair<Int, Int?> = when {
    nrb <= 10 -> (nrb + 1) / 2 to null
    nrb == 11 -> 4 to null
    nrb <= 19 -> 8 to null
    nrb <= 26 -> 12 to null
    nrb <= 44 -> 18 to null
    nrb <= 49 -> 27 to null
    nrb <= 63 -> 27 to 9
    nrb <= 79 -> 32 to 16
    else -> 48 to 16
}
internal fun log2Ceil(x: Int): Int = if (x <= 1) 0 else 32 - Integer.numberOfLeadingZeros(x - 1)
/** Format 0/1A/1C sizes; TDD adds the 4-bit HARQ number and the DAI to 1A and the UL index or DAI to 0. */
fun dciSizes(nrb: Int, tdd: Boolean = false): DciSizes {
    val riv = log2Ceil(nrb * (nrb + 1) / 2)
    val f0 = 1 + 1 + riv + 5 + 1 + 2 + 3 + 1 + (if (tdd) 2 else 0)
    var f1a = maxOf(1 + 1 + riv + 5 + (if (tdd) 4 else 3) + 1 + 2 + 2 + (if (tdd) 2 else 0), f0)
    if (f1a in AMBIG) f1a++
    val g1 = gapValues(nrb).first; val nvrb = 2 * min(g1, nrb - g1); val step = if (nrb < 50) 2 else 4; val n = nvrb / step
    val f1c = (if (nrb >= 50) 1 else 0) + log2Ceil(n * (n + 1) / 2) + 5
    return DciSizes(f0, f1a, f1c, riv)
}

sealed class Dci { abstract val fmt: String }
data class Dci1A(val distributed: Int, val riv: Int, val mcs: Int, val harq: Int, val ndiOrGap: Int, val rv: Int, val tpc: Int, val nPrb1A: Int) : Dci() { override val fmt = "1A" }
data class Dci1C(val gap: Int, val rba: Int, val tbsIndex: Int) : Dci() { override val fmt = "1C" }

fun parse1A(b: ByteArray, nrb: Int, tdd: Boolean = false): Dci1A? {
    if (b[0].toInt() == 0) return null
    val riv = log2Ceil(nrb * (nrb + 1) / 2)
    var i = 1
    fun take(n: Int): Int { val v = bitsToInt(b, i, n); i += n; return v }
    val distributed = take(1); val rv0 = take(riv); val mcs = take(5); val harq = take(if (tdd) 4 else 3); val ndi = take(1); val rv = take(2); val tpc = take(2)
    return Dci1A(distributed, rv0, mcs, harq, ndi, rv, tpc, if (tpc and 1 != 0) 3 else 2)
}
fun parse1C(b: ByteArray, nrb: Int): Dci1C {
    var i = 0; var gap = 0
    if (nrb >= 50) { gap = b[0].toInt(); i = 1 }
    val nb = b.size - 5 - i
    return Dci1C(gap, bitsToInt(b, i, nb), bitsToInt(b, i + nb, 5))
}

/** Encodes DCI bits with the RNTI-masked CRC (5.3.3.2) for a transmitter and the decoder's re-check. */
fun dciWithCrc(bits: ByteArray, rnti: Int): ByteArray {
    val p = crcBits(bits, CRC16); val out = ByteArray(bits.size + 16)
    System.arraycopy(bits, 0, out, 0, bits.size)
    for (i in 0 until 16) out[bits.size + i] = (p[i].toInt() xor ((rnti shr (15 - i)) and 1)).toByte()
    return out
}

class DciHit(val L: Int, val cce: Int, val size: Int, val bits: ByteArray, val dci: Dci, val rnti: Int)
class ControlLayout(val order: List<Reg>, val zidx: IntArray, val M: Int, val idx: IntArray)

/** Per cell control-region decoder: CFI, then blind decoding of the common search space for SI-RNTI and P-RNTI. */
class ControlDecoder(val pci: Int, val nrb: Int, val nports: Int, phich: String, val tdd: Boolean = false, mi: Int = 1) {
    val sizes: DciSizes = dciSizes(nrb, tdd)
    private val r: Array<List<Reg>> = Array(5) { if (it == 0) emptyList() else regs(pci, nrb, nports, it) }
    val pc: List<Reg> = pcfichRegs(pci, nrb, r[1])
    val ph: List<Reg> = phichRegs(pci, nrb, r[1], pc, phich, mi)
    private val layouts = HashMap<Int, ControlLayout>()

    /** REG order of 6.8.5 (by frequency, then symbol), its interleaved z index, and grid indices of every RE. */
    fun layout(nl: Int): ControlLayout = layouts.getOrPut(nl) {
        val kk = 12 * nrb; val used = (pc + ph).map { it.l * 10_000 + it.k0 }.toSet()
        val order = r[nl].filter { (it.l * 10_000 + it.k0) !in used }.sortedWith(compareBy<Reg> { it.k0 }.thenBy { it.l })
        val m = order.size; val perm = quadInterleaver(m); val zidx = IntArray(m) { perm[(it + pci) % m] }
        val idx = IntArray(4 * m)
        order.forEachIndexed { i, rg -> rg.ks.forEachIndexed { j, k -> idx[4 * i + j] = rg.l * kk + k } }
        ControlLayout(order, zidx, m, idx)
    }
    fun regIdx(list: List<Reg>): IntArray {
        val kk = 12 * nrb; val idx = IntArray(4 * list.size)
        list.forEachIndexed { i, rg -> rg.ks.forEachIndexed { j, k -> idx[4 * i + j] = rg.l * kk + k } }
        return idx
    }
    fun cfi(g: Grid, h: Chan, sf: Int): Pair<Int, Float> {
        val x = tdDecode(g, h, regIdx(pc), nports); val llr = qpskLlr(x, h.nv)
        val c = gold((((sf + 1) * (2 * pci + 1)) shl 9) + pci, 32)
        val sc = (1..3).map { v -> var s = 0f; val cw = CFI_CW.getValue(v); for (i in 0 until 32) s += (if (c[i].toInt() != 0) -llr[i] else llr[i]) * (1 - 2 * cw[i]); s }
        val order = listOf(0, 1, 2).sortedByDescending { sc[it] }
        return (order[0] + 1) to (sc[order[0]] - sc[order[1]])
    }
    /** Descrambled soft bits of the whole control region, CCE-ordered (bits 72n..72n+71 = CCE n). */
    fun softBits(g: Grid, h: Chan, sf: Int, nl: Int): Pair<FloatArray, Int> {
        val lay = layout(nl); val x = tdDecode(g, h, lay.idx, nports); val llr = qpskLlr(x, h.nv); val soft = FloatArray(8 * lay.M)
        for (m in 0 until lay.M) for (j in 0 until 8) soft[8 * lay.zidx[m] + j] = llr[8 * m + j]
        val c = gold((sf shl 9) + pci, 8 * lay.M)
        for (i in soft.indices) if (c[i].toInt() != 0) soft[i] = -soft[i]
        return soft to lay.M / 9
    }
    /** Every DCI in the common search space whose CRC carries one of the RNTIs (one Viterbi pass serves them all). */
    fun search(g: Grid, h: Chan, sf: Int, cfi: Int, rntis: List<Int> = listOf(SI_RNTI)): List<DciHit> {
        val (soft, ncce) = softBits(g, h, sf, cfi); val hits = ArrayList<DciHit>(); val seen = HashSet<String>()
        val sizes = linkedSetOf(this.sizes.f1a, this.sizes.f1c)
        for ((lagg, ncand) in listOf(4 to 4, 8 to 2)) {
            val nposs = ncce / lagg
            for (m in 0 until min(ncand, nposs)) {
                val cce0 = lagg * (m % nposs); val from = 72 * cce0; val len = 72 * lagg
                if (from + len > soft.size) continue
                for (a in sizes) {
                    val d = a + 16; val acc = ccDematch(soft, d, from, len); val bits = viterbiTb(acc, d); val par = crcBits(bits, CRC16, a)
                    val rnti = bitsToInt(par) xor bitsToInt(bits, a, 16)
                    if (rnti !in rntis) continue
                    val b = bits.copyOfRange(0, a); val key = "$rnti:" + b.joinToString("")
                    if (!seen.add(key)) continue
                    val dci: Dci? = if (a == this.sizes.f1c) parse1C(b, nrb) else parse1A(b, nrb, tdd)
                    if (dci != null) hits.add(DciHit(lagg, cce0, a, b, dci, rnti))
                }
            }
        }
        return hits
    }
}
