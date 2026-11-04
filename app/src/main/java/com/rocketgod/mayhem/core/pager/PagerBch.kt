package com.rocketgod.mayhem.core.pager

/**
 * BCH(31,21) plus an even parity bit: the 32-bit codeword POCSAG and FLEX both use. Words here are MSB-first as
 * received: bits 31..11 carry the 21 data bits, 10..1 the check bits, bit 0 even parity over all 32. Up to two bit
 * errors are corrected; a parity miss on top of a two-bit fix means three errors, which is refused rather than
 * risking a miscorrected page.
 */
object PagerBch {
    private const val GEN = 0x769   // x^10 + x^9 + x^8 + x^6 + x^5 + x^3 + 1

    /** Syndrome → the error pattern (bits 31..1) that produces it, for every 0-, 1- and 2-bit error. */
    private val fix = IntArray(1024) { -1 }.also { t ->
        t[0] = 0
        for (i in 1..31) t[rem((1 shl i) ushr 1)] = 1 shl i
        for (i in 1..31) for (j in i + 1..31) {
            val e = (1 shl i) or (1 shl j)
            val s = rem(e ushr 1)
            if (t[s] == -1) t[s] = e
        }
    }

    /** Remainder of a 31-bit value (data in 30..10, check in 9..0) divided by the generator. */
    private fun rem(v31: Int): Int {
        var r = v31
        for (bit in 30 downTo 10) if (((r ushr bit) and 1) != 0) r = r xor (GEN shl (bit - 10))
        return r and 0x3FF
    }

    /** A full codeword (check bits + parity) for 21 data bits. */
    fun encode(data21: Int): Int {
        val m = (data21 and 0x1FFFFF) shl 10
        val w = (m or rem(m)) shl 1
        return w or (Integer.bitCount(w) and 1)
    }

    /** The corrected word, or null when it holds more errors than the code can fix. */
    fun correct(w: Int): Int? {
        val e = fix[rem(w ushr 1)]
        if (e == -1) return null
        val c = w xor e
        if ((Integer.bitCount(c) and 1) == 0) return c
        return if (Integer.bitCount(e) >= 2) null else c xor 1   // the parity bit itself was the error
    }

    /** FLEX sends a word's 21 data bits low bit first; this is that data field of an MSB-first received word. */
    fun flexData(w: Int): Int = Integer.reverse(w) and 0x1FFFFF

    /** The MSB-first on-air word for a FLEX data field (the encoder side, used by tests). */
    fun flexWord(data: Int): Int = encode(Integer.reverse(data and 0x1FFFFF) ushr 11)
}
