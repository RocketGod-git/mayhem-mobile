package com.rocketgod.mayhem.core.cell

/*
 * PBCH and MIB. 36.211 6.6 (scrambling with c_init = PCI over 1920 bits per 40 ms, QPSK, transmit diversity, the 240
 * REs of symbols 0..3 of slot 1 on the central 72 subcarriers, CRS REs of all four ports skipped).
 * 36.212 5.3.1 (24-bit MIB, CRC-16 masked by the port count), 5.1.3.1 tail-biting convolutional code K=7
 * (133, 171, 165 octal), 5.1.4.2 rate matching for convolutional codes. 36.331 MasterInformationBlock.
 */
private val GEN = intArrayOf(0x5b, 0x79, 0x75)
private val TAPS = Array(3) { i -> IntArray(7) { j -> (GEN[i] shr (6 - j)) and 1 } }

/** Tail-biting encoder: d[i][k], register seeded with the last 6 input bits. */
fun convEncode(c: ByteArray): Array<ByteArray> {
    val k0 = c.size; val d = Array(3) { ByteArray(k0) }
    for (k in 0 until k0) for (i in 0 until 3) {
        var v = 0
        for (j in 0 until 7) v = v xor (TAPS[i][j] and c[(k - j + k0 * 7) % k0].toInt())
        d[i][k] = v.toByte()
    }
    return d
}

// trellis: state = (c_{k-1} .. c_{k-6}), c_{k-1} in bit 5; next = (b << 5) | (s >> 1)
private val OUT = IntArray(64 * 2 * 3).also { o ->
    for (s in 0 until 64) for (b in 0 until 2) for (i in 0 until 3) {
        var v = TAPS[i][0] and b
        for (j in 1 until 7) v = v xor (TAPS[i][j] and ((s shr (6 - j)) and 1))
        o[(s * 2 + b) * 3 + i] = 1 - 2 * v
    }
}

/** Tail-biting Viterbi by wrap-around (three copies, the middle kept). llr[i][k], positive = 0. */
fun viterbiTb(llr: Array<FloatArray>, k0: Int, reps: Int = 3): ByteArray {
    val t0 = k0 * reps; val choice = ByteArray(t0 * 64)
    var metric = FloatArray(64); var next = FloatArray(64)
    val bm = FloatArray(128)
    for (t in 0 until t0) {
        val k = t % k0; val l0 = llr[0][k]; val l1 = llr[1][k]; val l2 = llr[2][k]
        for (q in 0 until 128) bm[q] = OUT[q * 3] * l0 + OUT[q * 3 + 1] * l1 + OUT[q * 3 + 2] * l2
        var mx = Float.NEGATIVE_INFINITY
        for (n in 0 until 64) {
            val b = n shr 5; val p0 = (n and 31) shl 1; val p1 = p0 or 1
            val m0 = metric[p0] + bm[p0 * 2 + b]; val m1 = metric[p1] + bm[p1 * 2 + b]
            if (m1 > m0) { next[n] = m1; choice[t * 64 + n] = 1 } else next[n] = m0
            if (next[n] > mx) mx = next[n]
        }
        for (n in 0 until 64) next[n] -= mx
        val tmp = metric; metric = next; next = tmp
    }
    var s = 0
    for (n in 1 until 64) if (metric[n] > metric[s]) s = n
    val bits = ByteArray(t0)
    for (t in t0 - 1 downTo 0) { bits[t] = (s shr 5).toByte(); s = ((s and 31) shl 1) or choice[t * 64 + s].toInt() }
    val mid = (reps / 2) * k0
    return bits.copyOfRange(mid, mid + k0)
}

val PERM_CC = intArrayOf(1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31, 0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30)

private val rmCache = HashMap<Long, IntArray>()
/** For each output bit e_k: stream * D + index of the coded bit (5.1.4.2). */
@Synchronized
fun ccRmMap(d: Int, e: Int): IntArray {
    val key = d.toLong() * 1_000_000_000L + e
    rmCache[key]?.let { return it }
    val c = 32; val r = (d + c - 1) / c; val nd = r * c - d; val w = ArrayList<Int>()
    for (i in 0 until 3) for (j in 0 until c) for (row in 0 until r) {
        val q = row * c + PERM_CC[j] - nd
        if (q >= 0) w.add(i * d + q)
    }
    val out = IntArray(e) { w[it % w.size] }
    if (rmCache.size > 64) rmCache.clear()
    rmCache[key] = out
    return out
}
/** Sums the received soft bits into the 3 x D coded positions. */
fun ccDematch(e: FloatArray, d: Int, from: Int = 0, len: Int = e.size - from, kOffset: Int = 0, eLen: Int = len): Array<FloatArray> {
    val m = ccRmMap(d, eLen); val acc = Array(3) { FloatArray(d) }
    for (k in 0 until len) { val v = m[k + kOffset]; acc[v / d][v % d] += e[from + k] }
    return acc
}
/** Rate matching forward: the E transmitted bits of a coded block d[3][D]. */
fun ccRateMatch(d: Array<ByteArray>, e: Int): ByteArray {
    val dd = d[0].size; val m = ccRmMap(dd, e)
    return ByteArray(e) { d[m[it] / dd][m[it] % dd] }
}

/** Grid indices (nrb grid) of the 240 PBCH REs of subframe 0, mapping order. */
fun pbchRes(pci: Int, nrb: Int): IntArray {
    val k0g = 12 * nrb; val k0 = nrb * 6 - 36; val out = ArrayList<Int>()
    for (l in intArrayOf(7, 8, 9, 10)) for (k in k0 until k0 + 72) {
        var crs = false
        for (p in 0 until 4) if (l in crsSymbols(p) && ((k - crsShift(p, l, pci)) % 6 + 6) % 6 == 0) crs = true
        if (!crs) out.add(l * k0g + k)
    }
    return out.toIntArray()
}

val MIB_MASK = mapOf(1 to 0x0000, 2 to 0xffff, 4 to 0x5555)
data class Mib(
    val bandwidth: Int, val phichDuration: String, val phichResource: String,
    val sfn: Int, val sib1BR: Int, val unchangedBR: Boolean, val ports: Int, val bits: String,
)
val NRB_OF = intArrayOf(6, 15, 25, 50, 75, 100)
fun parseMib(b: ByteArray, frameInTti: Int, ports: Int): Mib? {
    val bw = bitsToInt(b, 0, 3)
    if (bw > 5) return null
    return Mib(NRB_OF[bw], if (b[3].toInt() != 0) "extended" else "normal", listOf("oneSixth", "half", "one", "two")[bitsToInt(b, 4, 2)],
        bitsToInt(b, 6, 8) * 4 + frameInTti, bitsToInt(b, 14, 5), b[19].toInt() != 0, ports, b.copyOfRange(0, 24).joinToString("") { "$it" })
}

/** Decodes one frame's 480 PBCH soft bits as each of the 4 positions in the 40 ms TTI; CRC with the port masks. */
fun decodeMibLlr(llr: FloatArray, pci: Int, precodePorts: Int): Mib? {
    val c = gold(pci, 1920); val hits = ArrayList<Mib>()
    for (j in 0 until 4) {
        val l = FloatArray(480) { i -> if (c[480 * j + i].toInt() != 0) -llr[i] else llr[i] }
        val acc = ccDematch(l, 40, 0, 480, 480 * j, 1920); val bits = viterbiTb(acc, 40); val par = crcBits(bits, CRC16, 24)
        val rx = bitsToInt(bits, 24, 16); val p = bitsToInt(par)
        for (ports in intArrayOf(1, 2, 4)) if ((p xor MIB_MASK.getValue(ports)) == rx) { val m = parseMib(bits, j, ports); if (m != null) hits.add(m) }
    }
    // the CRC mask decides the port count; a matching precoding hypothesis is preferred
    return hits.sortedBy { if (it.ports != precodePorts) 1 else 0 }.firstOrNull()
}

/** Tries 1, 2 and 4 port precoding on a demodulated subframe 0 (nrb-wide grid, usually the central 6 RBs). */
fun decodeMib(g: Grid, pci: Int, nrb: Int): Pair<Mib, Double>? {
    val res = pbchRes(pci, nrb)
    for (np in intArrayOf(4, 2, 1)) {
        val h = chanEst(g, 0, pci, nrb, np); val x = tdDecode(g, h, res, np); val llr = qpskLlr(x, h.nv)
        val m = decodeMibLlr(llr, pci, np)
        if (m != null) return m to h.snr
    }
    return null
}
