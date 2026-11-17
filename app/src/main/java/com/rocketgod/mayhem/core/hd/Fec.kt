package com.rocketgod.mayhem.core.hd

/**
 * NRSC-5 FM Layer 1 forward error correction for service mode MP1, receive side and the matching transmit side
 * (the transmit side serves round-trip checks). From SY_IDD_1011s rev H:
 *  - PM interleaver I (P1) and II (PIDS), 10.2.3, 10.2.4, 10.4.1.1, Tables 10-16 to 10-18;
 *  - interleaver partition to subcarrier map, Table 12-1, Table 12-19, 12.2.1.2;
 *  - rate 2/5 puncturing of the K=7 133/171/165 mother code, 9.3.5, tail-biting;
 *  - scrambler 1 + x^2 + x^11, 8.2.
 * Two orderings were settled on recordings: the generator MSB multiplies the current input bit, and the scrambler's
 * initial state 0111 1111 111 lists stage 1 first.
 * Bits are ByteArrays of 0 and 1.
 */
object HdFec {
    val V_PM = intArrayOf(10, 2, 18, 6, 14, 8, 16, 0, 12, 4, 11, 3, 19, 7, 15, 9, 17, 1, 13, 5)
    private const val J = 20; private const val B = 16; private const val C = 36
    /** P1 coded bits per L1 frame (Table 10-1) and information bits after rate 2/5. */
    const val N_P1 = 365_440; const val P1_BITS = 146_176
    /** PIDS coded bits per block and information bits (one SIS PDU). */
    const val N_PIDS = 200; const val PIDS_BITS = 80
    /** The PM matrix: 512 rows (16 blocks of 32 symbols), 720 columns (20 partitions of 36). */
    const val PM_ROWS = 512; const val PM_COLS = 720

    private fun rowOf(k: Int) = (k * 11) % 32
    private fun colOf(k: Int) = (k * 11 + k / (32 * 9)) % C

    /** For each P1 coded bit, its flat index (row * 720 + column) in the PM matrix. */
    val p1Index: IntArray by lazy {
        IntArray(N_P1) { i ->
            val part = V_PM[i % J]
            val block = (i / J + part * 7) % B
            val k = i / (J * B)
            (block * 32 + rowOf(k)) * PM_COLS + part * C + colOf(k)
        }
    }

    private val pidsCache = arrayOfNulls<IntArray>(16)
    /** PIDS coded bits of block [bc], as flat PM matrix indices (Interleaver II). */
    fun pidsIndex(bc: Int): IntArray = pidsCache[bc] ?: run {
        val k0 = N_P1 / (J * B)
        IntArray(N_PIDS) { n ->
            val i = N_PIDS * bc + n; val part = V_PM[i % J]; val block = i / N_PIDS
            val k = (i / J) % (N_PIDS / J) + k0
            (block * 32 + rowOf(k)) * PM_COLS + part * C + colOf(k)
        }.also { pidsCache[bc] = it }
    }

    /** PM matrix column to subcarrier (-546..546) and to the I (0) or Q (1) rail. */
    val pmSc: IntArray; val pmIq: IntArray
    init {
        val sc = IntArray(PM_COLS); val iq = IntArray(PM_COLS)
        for (p in 0 until J) {
            val fp = if (p < 10) p else p + 8
            val start = if (fp < 10) -545 + 19 * fp else 357 + 19 * (fp - 18)
            for (c in 0 until C) { sc[p * C + c] = start + (c shr 1); iq[p * C + c] = c and 1 }
        }
        pmSc = sc; pmIq = iq
    }

    // ---- convolutional code ----
    private const val K = 7; const val NST = 64
    private val GENS = intArrayOf(0x5B, 0x79, 0x75)
    /** OUT[state * 2 + input] = the three code bits as g1 g2 g3 (g1 in bit 2); NEXT likewise. */
    internal val OUT = IntArray(NST * 2); internal val NEXT = IntArray(NST * 2)
    init {
        val taps = Array(3) { h -> IntArray(K) { j -> (GENS[h] shr (K - 1 - j)) and 1 } }
        for (s in 0 until NST) for (u in 0..1) {
            val reg = IntArray(K) { j -> if (j == 0) u else (s shr (K - 1 - j)) and 1 }
            var c = 0
            for (h in 0 until 3) { var p = 0; for (j in 0 until K) p = p xor (taps[h][j] and reg[j]); c = (c shl 1) or p }
            OUT[s * 2 + u] = c; NEXT[s * 2 + u] = (u shl (K - 2)) or (s shr 1)
        }
    }

    /** Tail-biting encode: 3 mother-code bits per input bit (g1, g2, g3). */
    fun encode(bits: ByteArray): ByteArray {
        var s = 0
        for (i in bits.size - (K - 1) until bits.size) s = NEXT[s * 2 + bits[i]]
        val out = ByteArray(bits.size * 3)
        for (i in bits.indices) {
            val c = OUT[s * 2 + bits[i]]
            out[3 * i] = (c shr 2).toByte(); out[3 * i + 1] = ((c shr 1) and 1).toByte(); out[3 * i + 2] = (c and 1).toByte()
            s = NEXT[s * 2 + bits[i]]
        }
        return out
    }

    /** Rate 2/5: even inputs keep g1 g2 g3, odd inputs keep g1 g2 (9.3.5.2), in serial order. */
    fun puncture25(code: ByteArray): ByteArray {
        val n = code.size / 3; val out = ByteArray(n / 2 * 5)
        var o = 0
        for (i in 0 until n) { out[o++] = code[3 * i]; out[o++] = code[3 * i + 1]; if (i and 1 == 0) out[o++] = code[3 * i + 2] }
        return out
    }

    /** Serial soft values (positive means 1) back to three per input bit, zero where punctured. */
    fun depuncture25(soft: FloatArray, nIn: Int, out: FloatArray = FloatArray(nIn * 3)): FloatArray {
        var o = 0
        for (i in 0 until nIn) { out[3 * i] = soft[o++]; out[3 * i + 1] = soft[o++]; out[3 * i + 2] = if (i and 1 != 0) 0f else soft[o++] }
        return out
    }

    /** Decode in one go. */
    fun viterbiTb(llr: FloatArray, n: Int, wrap: Int = 96): ByteArray { val v = TbViterbi(); v.start(llr, n, wrap); v.run(); return v.bits.copyOf() }

    // ---- scrambler ----
    private val scrCache = HashMap<Int, ByteArray>()
    /** The scrambling sequence: 11 stages, output and feedback = stage 2 XOR stage 11, reset to 0111 1111 111 per frame. */
    @Synchronized fun scramblerSeq(n: Int): ByteArray = scrCache.getOrPut(n) {
        val s = ByteArray(n)
        val st = intArrayOf(0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
        for (i in 0 until n) { val b = st[1] xor st[10]; s[i] = b.toByte(); for (k in 10 downTo 1) st[k] = st[k - 1]; st[0] = b }
        s
    }
    /** XOR with the scrambling sequence (the same operation scrambles and descrambles). */
    fun descramble(bits: ByteArray): ByteArray {
        val s = scramblerSeq(bits.size)
        return ByteArray(bits.size) { (bits[it].toInt() xor s[it].toInt()).toByte() }
    }

    /** Fraction of hard decisions that disagree with the re-encoded output: the channel bit error rate before FEC. */
    fun reencodeBer(bits: ByteArray, soft: FloatArray): Double {
        val p = puncture25(encode(bits))
        var e = 0; var n = 0
        for (i in p.indices) { val s = soft[i]; if (s == 0f) continue; n++; if ((if (s > 0) 1 else 0) != p[i].toInt()) e++ }
        return if (n > 0) e.toDouble() / n else 1.0
    }
}

/**
 * Tail-biting Viterbi by wrap-around: the trellis runs over [last `wrap` | frame | first `wrap`] from equal metrics
 * and the middle is kept. The work can be spread over several calls: [run] advances at most that many trellis steps
 * and returns true once the bits are ready.
 */
class TbViterbi {
    private var llr = FloatArray(0); private var n = 0; private var wrap = 96; private var len = 0; private var t = 0
    private var dec = IntArray(0)
    private var m = FloatArray(HdFec.NST); private var m2 = FloatArray(HdFec.NST)
    private val bm = FloatArray(8)
    var bits = ByteArray(0); private set

    fun start(llr: FloatArray, n: Int, wrap: Int = 96) {
        this.llr = llr; this.n = n; this.wrap = minOf(wrap, n); len = n + 2 * this.wrap; t = 0
        if (dec.size < len * 2) dec = IntArray(len * 2)
        m.fill(0f)
        if (bits.size != n) bits = ByteArray(n)
    }

    fun run(maxSteps: Int = Int.MAX_VALUE): Boolean {
        val out = HdFec.OUT
        var m = this.m; var m2 = this.m2
        val end = if (maxSteps >= len - t) len else t + maxSteps
        for (tt in t until end) {
            val i = (tt - wrap + n) % n; val l0 = llr[3 * i]; val l1 = llr[3 * i + 1]; val l2 = llr[3 * i + 2]
            for (c in 0 until 8) bm[c] = (if (c and 4 != 0) l0 else -l0) + (if (c and 2 != 0) l1 else -l1) + (if (c and 1 != 0) l2 else -l2)
            var d0 = 0; var d1 = 0; var best = Float.NEGATIVE_INFINITY
            for (ns in 0 until HdFec.NST) {
                val u = ns shr 5; val s0 = (ns and 31) shl 1; val s1 = s0 or 1
                val a = m[s0] + bm[out[s0 * 2 + u]]; val b = m[s1] + bm[out[s1 * 2 + u]]
                var v = a
                if (b > a) { v = b; if (ns < 32) d0 = d0 or (1 shl ns) else d1 = d1 or (1 shl (ns - 32)) }
                m2[ns] = v; if (v > best) best = v
            }
            for (s in 0 until HdFec.NST) m2[s] -= best
            dec[2 * tt] = d0; dec[2 * tt + 1] = d1
            val tmp = m; m = m2; m2 = tmp
        }
        this.m = m; this.m2 = m2; t = end
        if (end < len) return false
        var s = 0; var best = Float.NEGATIVE_INFINITY
        for (k in 0 until HdFec.NST) if (m[k] > best) { best = m[k]; s = k }
        for (tt in len - 1 downTo 0) {
            if (tt >= wrap && tt < wrap + n) bits[tt - wrap] = (s shr 5).toByte()
            val d = if (s < 32) (dec[2 * tt] ushr s) and 1 else (dec[2 * tt + 1] ushr (s - 32)) and 1
            s = ((s and 31) shl 1) or d
        }
        return true
    }
}
