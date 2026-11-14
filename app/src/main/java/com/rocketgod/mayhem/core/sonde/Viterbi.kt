package com.rocketgod.mayhem.core.sonde

/**
 * The CCSDS rate-1/2, K=7 convolutional code the Lockheed Martin LMS6-403 and LMSX send (G1 = 0x4F, G2 = 0x6D with
 * the newest bit in bit 0), its encoder and a soft-decision Viterbi decoder. The decoder allocates its tables once
 * and is meant to run once per frame. The Kotlin twin of web/src/dsp/sonde/viterbi.ts.
 *
 * State convention: the encoder state holds the last 6 input bits, bit 0 = the most recent. For a new bit u the
 * 7-bit register is r = (state << 1 | u) & 0x7F and the next state is r & 0x3F.
 */
object Conv {
    const val POLY_A = 0x4f
    const val POLY_B = 0x6d

    /** Code bits for each 7-bit register value. */
    internal val OUT_A = IntArray(128) { Integer.bitCount(it and POLY_A) and 1 }
    internal val OUT_B = IntArray(128) { Integer.bitCount(it and POLY_B) and 1 }

    /** Encode bits, writing two code bits (c0, c1) per input bit to [out] from [outPos]. Returns the encoder state after. */
    fun encode(bits: IntArray, state: Int, out: IntArray, outPos: Int): Int {
        var s = state and 0x3f
        for (k in bits.indices) {
            val r = ((s shl 1) or (bits[k] and 1)) and 0x7f
            out[outPos + 2 * k] = OUT_A[r]
            out[outPos + 2 * k + 1] = OUT_B[r]
            s = r and 0x3f
        }
        return s
    }

    /** The encoder state after a run of bits starting from [state]. */
    fun state(bits: IntArray, state: Int): Int {
        var s = state and 0x3f
        for (b in bits) s = ((s shl 1) or (b and 1)) and 0x3f
        return s
    }
}

class Viterbi(val maxBits: Int) {
    private val dec = ByteArray(maxBits * 64)
    private var pm = DoubleArray(64)
    private var nm = DoubleArray(64)

    /**
     * Soft-decision decode. [soft] holds (c0, c1) pairs from [start], positive = code bit 1. [state0] is the known
     * encoder state before the first bit. Decoded bits go to out[0 .. nBits-1]. The end is left open (the best final
     * state wins). Returns the number of code symbols whose hard decision disagrees with the decoded path (the channel
     * errors the code repaired).
     */
    fun decode(soft: FloatArray, start: Int, nBits: Int, state0: Int, out: IntArray): Int {
        val n = minOf(nBits, maxBits)
        val neg = -1e300
        var pm = this.pm; var nm = this.nm
        for (s in 0 until 64) pm[s] = neg
        pm[state0 and 0x3f] = 0.0
        val oa = Conv.OUT_A; val ob = Conv.OUT_B
        for (k in 0 until n) {
            val a = soft[start + 2 * k].toDouble(); val b = soft[start + 2 * k + 1].toDouble()
            for (ns in 0 until 64) {
                // the two predecessors differ in the bit that falls out of the register (t)
                val s0 = ns shr 1; val s1 = s0 or 32
                val r0 = ns; val r1 = 64 or ns
                val m0 = pm[s0] + (if (oa[r0] != 0) a else -a) + (if (ob[r0] != 0) b else -b)
                val m1 = pm[s1] + (if (oa[r1] != 0) a else -a) + (if (ob[r1] != 0) b else -b)
                if (m1 > m0) { nm[ns] = m1; dec[k * 64 + ns] = 1 } else { nm[ns] = m0; dec[k * 64 + ns] = 0 }
            }
            val t = pm; pm = nm; nm = t
        }
        var best = 0
        for (s in 1 until 64) if (pm[s] > pm[best]) best = s
        this.pm = pm; this.nm = nm
        // trace back
        var ns = best
        for (k in n - 1 downTo 0) {
            out[k] = ns and 1
            val t = dec[k * 64 + ns].toInt()
            ns = (ns shr 1) or (t shl 5)
        }
        // count the code symbols the decoded path disagrees with
        var errs = 0; var s = state0 and 0x3f
        for (k in 0 until n) {
            val r = ((s shl 1) or out[k]) and 0x7f
            if ((if (soft[start + 2 * k] > 0) 1 else 0) != oa[r]) errs++
            if ((if (soft[start + 2 * k + 1] > 0) 1 else 0) != ob[r]) errs++
            s = r and 0x3f
        }
        return errs
    }
}
