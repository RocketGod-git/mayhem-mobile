package com.rocketgod.mayhem.core.sonde

/**
 * Reed-Solomon over GF(2^8) for the radiosonde decoders (RS41, RS92: RS(255,231); LMS6: the CCSDS RS(255,223)).
 * Codewords are polynomial coefficients by power: cw[i] multiplies X^i. The parity sits in cw[0 .. nroots-1] and the
 * message in cw[nroots ..], which is how the sondes lay their check bytes out. A shortened code is the same code with
 * the unused high message positions left zero. Symbols are 0..255 in an IntArray. Kotlin twin of rs.ts.
 *
 * @param poly the field's primitive polynomial (0x11D for the Vaisala codes, 0x187 for CCSDS)
 * @param fcr the first consecutive root, as a power of the code's root
 * @param prim the code's root as a power of the field's generator (1, or 11 for CCSDS)
 * @param nroots check bytes (24 or 32)
 */
class ReedSolomon(val poly: Int, val fcr: Int, val prim: Int, val nroots: Int) {
    val n = 255
    private val exp = IntArray(512)
    private val log = IntArray(256)
    private val gen: IntArray

    init {
        var x = 1
        for (i in 0 until 255) { exp[i] = x; log[x] = i; x = x shl 1; if (x and 0x100 != 0) x = x xor poly }
        for (i in 255 until 512) exp[i] = exp[i - 255]
        log[0] = -1
        // g(X) = prod (X - beta^(fcr+j)), beta = alpha^prim
        var g = intArrayOf(1)
        for (j in 0 until nroots) {
            val r = exp[(prim * (fcr + j)) % 255]
            val ng = IntArray(g.size + 1)
            for (i in g.indices) { ng[i + 1] = ng[i + 1] xor g[i]; ng[i] = ng[i] xor mul(g[i], r) }
            g = ng
        }
        gen = g
    }

    fun mul(a: Int, b: Int): Int = if (a != 0 && b != 0) exp[log[a] + log[b]] else 0
    private fun div(a: Int, b: Int): Int = if (a != 0) exp[(log[a] - log[b] + 255) % 255] else 0
    /** beta^e for any integer e. */
    private fun bpow(e: Int): Int = exp[(((prim * e) % 255) + 255) % 255]

    /** Fill cw[0 .. nroots-1] with the parity of cw[nroots .. 254]. */
    fun encode(cw: IntArray) {
        val r = nroots; val rem = IntArray(r)
        // long division of msg(X)*X^R by g(X), highest power first
        for (i in 254 downTo r) {
            val fb = cw[i] xor rem[r - 1]
            for (k in r - 1 downTo 1) rem[k] = rem[k - 1] xor mul(fb, gen[k])
            rem[0] = mul(fb, gen[0])
        }
        for (k in 0 until r) cw[k] = rem[k]
    }

    /** Correct cw in place. Returns the number of symbols fixed, or -1 when it can't be corrected. */
    fun decode(cw: IntArray): Int {
        val r = nroots; val syn = IntArray(r)
        var any = 0
        for (j in 0 until r) {
            // Horner from the top power down: S_j = cw(beta^(fcr+j))
            val root = bpow(fcr + j)
            var s = 0
            for (i in 254 downTo 0) s = mul(s, root) xor cw[i]
            syn[j] = s; any = any or s
        }
        if (any == 0) return 0
        // Berlekamp-Massey
        var lambda = IntArray(r + 1); lambda[0] = 1
        var b = IntArray(r + 1); b[0] = 1
        var l = 0; var m = 1; var bb = 1
        for (k in 0 until r) {
            var d = syn[k]
            for (i in 1..l) d = d xor mul(lambda[i], syn[k - i])
            if (d == 0) { m++; continue }
            val coef = div(d, bb)
            val t = lambda.copyOf()
            var i = 0
            while (i + m <= r) { lambda[i + m] = lambda[i + m] xor mul(coef, b[i]); i++ }
            if (2 * l <= k) { l = k + 1 - l; b = t; bb = d; m = 1 } else m++
        }
        if (l > r / 2.0) return -1
        // Chien search: roots of lambda at beta^(-i) mark error position i
        val pos = ArrayList<Int>()
        for (i in 0 until 255) {
            val xinv = bpow(-i)
            var v = 0
            for (k in l downTo 0) v = mul(v, xinv) xor lambda[k]
            if (v == 0) pos.add(i)
        }
        if (pos.size != l) return -1
        // Omega = S * lambda mod X^R
        val omega = IntArray(r)
        for (i in 0 until r) { var v = 0; for (k in 0..minOf(i, l)) v = v xor mul(lambda[k], syn[i - k]); omega[i] = v }
        for (p in pos) {
            val xinv = bpow(-p); val x = bpow(p)
            var om = 0; for (i in r - 1 downTo 0) om = mul(om, xinv) xor omega[i]
            // formal derivative: the odd terms
            var dl = 0; var k = 1
            while (k <= l) { dl = dl xor mul(lambda[k], powOf(xinv, k - 1)); k += 2 }
            if (dl == 0) return -1
            // Forney: e = X^(1-fcr) * omega(X^-1) / lambda'(X^-1)
            val e = mul(powOf(x, ((1 - fcr) % 255 + 255) % 255), div(om, dl))
            cw[p] = cw[p] xor e
        }
        return pos.size
    }

    private fun powOf(a: Int, e: Int): Int { if (e == 0) return 1; if (a == 0) return 0; return exp[(log[a] * e) % 255] }

    companion object {
        /** The Vaisala RS(255,231): x^8+x^4+x^3+x^2+1, roots alpha^0 .. alpha^23. */
        val VAISALA = ReedSolomon(0x11d, 0, 1, 24)

        /** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), the Vaisala and LMS block check. */
        fun crc16ccitt(b: IntArray, start: Int, len: Int, init: Int = 0xffff): Int {
            var c = init
            for (i in start until start + len) {
                c = c xor (b[i] shl 8)
                for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xffff else (c shl 1) and 0xffff
            }
            return c
        }
    }
}
