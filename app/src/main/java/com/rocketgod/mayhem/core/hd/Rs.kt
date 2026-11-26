package com.rocketgod.mayhem.core.hd

/** Reed-Solomon over GF(256) (poly 0x11D, first root a^1, 8 parity bytes), for the 96-byte audio PDU header (1017s). */
object HdRs {
    private val EXP = IntArray(512)
    private val LOG = IntArray(256)
    init {
        var x = 1
        for (i in 0 until 255) { EXP[i] = x; LOG[x] = i; x = x shl 1; if (x and 0x100 != 0) x = x xor 0x11D }
        for (i in 255 until 512) EXP[i] = EXP[i - 255]
    }
    private fun mul(a: Int, b: Int) = if (a != 0 && b != 0) EXP[LOG[a] + LOG[b]] else 0
    private const val NROOTS = 8
    private const val HDR = 96

    /** Corrects a codeword given highest degree first; returns the corrections made, or -1 if it can't. */
    fun decode(c: IntArray): Int {
        val n = c.size
        val S = IntArray(NROOTS)
        var any = 0
        for (j in 0 until NROOTS) {
            var s = 0; val a = j + 1
            for (i in 0 until n) s = mul(s, EXP[a]) xor c[i]
            S[j] = s; any = any or s
        }
        if (any == 0) return 0
        // Berlekamp-Massey
        var L = 0; val C = IntArray(NROOTS + 1); val B = IntArray(NROOTS + 1); C[0] = 1; B[0] = 1
        var m = 1; var b = 1
        for (r in 0 until NROOTS) {
            var d = S[r]; for (i in 1..L) d = d xor mul(C[i], S[r - i])
            if (d == 0) { m++; continue }
            val coef = mul(d, EXP[255 - LOG[b]]); val T = C.copyOf()
            for (i in m..NROOTS) C[i] = C[i] xor mul(coef, B[i - m])
            if (2 * L <= r) { L = r + 1 - L; T.copyInto(B); b = d; m = 1 } else m++
        }
        if (L > NROOTS / 2) return -1
        // Chien search over the positions this (shortened) codeword has: position p counts from the end
        val pos = ArrayList<Int>()
        for (p in 0 until n) {
            val xinv = EXP[(255 - p) % 255]; var v = 0; var xp = 1
            for (i in 0..L) { v = v xor mul(C[i], xp); xp = mul(xp, xinv) }
            if (v == 0) pos.add(p)
        }
        if (pos.size != L) return -1
        // Forney: Omega = S(x) C(x) mod x^NROOTS
        val Om = IntArray(NROOTS)
        for (i in 0 until NROOTS) { var v = 0; for (k in 0..minOf(i, L)) v = v xor mul(C[k], S[i - k]); Om[i] = v }
        for (p in pos) {
            val xinv = EXP[(255 - p) % 255]
            var om = 0; var xp = 1; for (i in 0 until NROOTS) { om = om xor mul(Om[i], xp); xp = mul(xp, xinv) }
            var dc = 0; xp = 1; var i = 1; while (i <= L) { dc = dc xor mul(C[i], xp); xp = mul(xp, mul(xinv, xinv)); i += 2 }
            if (dc == 0) return -1
            c[n - 1 - p] = c[n - 1 - p] xor mul(om, EXP[255 - LOG[dc]])
        }
        return pos.size
    }

    /** Corrects an audio PDU header in place (its bytes are stored lowest degree first); false if beyond repair. */
    fun fixAudioHeader(by: IntArray, off: Int): Boolean {
        if (off + HDR > by.size) return false
        val c = IntArray(HDR) { by[off + HDR - 1 - it] }
        if (decode(c) < 0) return false
        for (i in 0 until HDR) by[off + i] = c[HDR - 1 - i]
        return true
    }
}
