package com.rocketgod.mayhem.core.uat

/**
 * UAT error correction (DO-282B): Reed-Solomon codes over GF(2^8) with primitive polynomial x^8+x^7+x^2+x+1 (0x187)
 * and generator roots alpha^120 .. alpha^(120+nroots-1). The twin of the web app's dsp/uat/rs.ts.
 *
 * - Ground uplink: six RS(92,72) blocks (20 parity bytes each), byte-interleaved: byte i of block j sits at 6*i + j.
 * - Basic downlink (short ADS-B): RS(30,18), 12 parity bytes. Long downlink: RS(48,34), 14 parity bytes.
 *
 * Decoding is Berlekamp-Massey, a Chien search and Forney's formula, checked by recomputing the syndromes, so a block
 * is either returned corrected and verified or rejected.
 */
object UatRs {
    private const val PRIM = 0x187
    private const val FCR = 120
    private val EXP = IntArray(512)
    private val LOG = IntArray(256)

    init {
        var x = 1
        for (i in 0 until 255) {
            EXP[i] = x; LOG[x] = i
            x = x shl 1
            if (x and 0x100 != 0) x = x xor PRIM
        }
        for (i in 255 until 512) EXP[i] = EXP[i - 255]
    }

    private fun mul(a: Int, b: Int) = if (a == 0 || b == 0) 0 else EXP[LOG[a] + LOG[b]]
    private fun div(a: Int, b: Int) = if (a == 0) 0 else EXP[(LOG[a] - LOG[b] + 255) % 255]
    private fun pow(e: Int) = EXP[((e % 255) + 255) % 255]

    private fun evalAt(p: IntArray, x: Int): Int { var y = 0; for (v in p) y = mul(y, x) xor v; return y }
    private fun syndromes(block: IntArray, nroots: Int) = IntArray(nroots) { evalAt(block, pow(FCR + it)) }

    /** Corrects a codeword in place (data + parity bytes). Returns the byte errors fixed, or -1 when it cannot. */
    fun correct(block: IntArray, nroots: Int): Int {
        val n = block.size
        val s = syndromes(block, nroots)
        if (s.all { it == 0 }) return 0
        var c = IntArray(nroots + 1).also { it[0] = 1 }
        var b = c.copyOf()
        var l = 0; var m = 1; var bb = 1
        for (k in 0 until nroots) {
            var d = s[k]
            for (i in 1..l) d = d xor mul(c[i], s[k - i])
            if (d == 0) { m++; continue }
            val coef = div(d, bb)
            if (2 * l <= k) {
                val t = c.copyOf()
                for (i in 0..nroots - m) c[i + m] = c[i + m] xor mul(coef, b[i])
                l = k + 1 - l; b = t; bb = d; m = 1
            } else {
                for (i in 0..nroots - m) c[i + m] = c[i + m] xor mul(coef, b[i])
                m++
            }
        }
        if (l == 0 || 2 * l > nroots) return -1
        val sigma = c.copyOf(l + 1)
        val pos = ArrayList<Int>()
        for (p in 0 until n) {
            val xInv = pow(-(n - 1 - p))
            var v = 0
            for (i in l downTo 0) v = mul(v, xInv) xor sigma[i]
            if (v == 0) pos.add(p)
        }
        if (pos.size != l) return -1
        val omega = IntArray(nroots)
        for (i in 0 until nroots) for (j in 0..minOf(i, l)) omega[i] = omega[i] xor mul(sigma[j], s[i - j])
        for (p in pos) {
            val e = n - 1 - p
            val xInv = pow(-e)
            var num = 0
            for (i in nroots - 1 downTo 0) num = mul(num, xInv) xor omega[i]
            var den = 0
            var i = 1
            while (i <= l) { den = den xor mul(sigma[i], pow(LOG[xInv] * (i - 1))); i += 2 }
            if (den == 0) return -1
            block[p] = block[p] xor mul(num, div(pow(e * (1 - FCR)), den))
        }
        return if (syndromes(block, nroots).all { it == 0 }) pos.size else -1
    }

    /** Parity bytes for data (tests): systematic encoding, data first. */
    fun encode(data: IntArray, nroots: Int): IntArray {
        var g = intArrayOf(1)
        for (i in 0 until nroots) {
            val r = pow(FCR + i); val next = IntArray(g.size + 1)
            for (j in g.indices) { next[j] = next[j] xor g[j]; next[j + 1] = next[j + 1] xor mul(g[j], r) }
            g = next
        }
        val rem = IntArray(nroots)
        for (v in data) {
            val f = v xor rem[0]
            for (j in 0 until nroots - 1) rem[j] = rem[j + 1]
            rem[nroots - 1] = 0
            if (f != 0) for (j in 0 until nroots) rem[j] = rem[j] xor mul(f, g[j + 1])
        }
        return data + rem
    }

    /** The 552-byte uplink as sent to its 432-byte message and the byte errors fixed, or null if any block fails. */
    fun uplinkMessage(frame: IntArray): Pair<ByteArray, Int>? {
        val msg = ByteArray(432)
        val blk = IntArray(92)
        var fixed = 0
        for (j in 0 until 6) {
            for (i in 0 until 92) blk[i] = frame[6 * i + j]
            val n = correct(blk, 20)
            if (n < 0) return null
            fixed += n
            for (i in 0 until 72) msg[72 * j + i] = blk[i].toByte()
        }
        return msg to fixed
    }

    /** The 432-byte message to the 552-byte uplink frame (tests). */
    fun uplinkFrame(msg: ByteArray): IntArray {
        val frame = IntArray(552)
        for (j in 0 until 6) {
            val cw = encode(IntArray(72) { msg[72 * j + it].toInt() and 0xff }, 20)
            for (i in 0 until 92) frame[6 * i + j] = cw[i]
        }
        return frame
    }
}
