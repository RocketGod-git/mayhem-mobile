package com.rocketgod.mayhem.core.ham

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * Sub-audible squelch decoders fed with the NFM discriminator output. Twin of web/src/dsp/ham/ctcss.ts.
 *  - CTCSS: the 50 EIA tones, a Goertzel bank on 0.5 s blocks at 4 kHz (2 Hz bins resolve the 2.3 Hz spacing at
 *    the bottom of the table); a tone is reported when it beats the runner-up by 6 dB.
 *  - DCS: 134.4 bit/s Golay(23,12) words; the stream is cyclic so any 23-bit window is a codeword — the fixed
 *    "100" field in bits 9..11 picks the alignment, the 9 low bits are the octal code. Both polarities are tried
 *    (inverted DCS shows up as the complementary bitstream).
 */

val CTCSS_TONES = doubleArrayOf(
    67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8,
    123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9,
    183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
)

/** The standard DCS code set, written in octal as the table conventionally is. */
val DCS_CODES = intArrayOf(
    23, 25, 26, 31, 32, 36, 43, 47, 51, 53, 54, 65, 71, 72, 73, 74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145,
    152, 155, 156, 162, 165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255, 261, 263, 265, 266,
    271, 274, 306, 311, 315, 325, 331, 332, 343, 346, 351, 356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446,
    452, 454, 455, 462, 464, 465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654, 662,
    664, 703, 712, 723, 731, 732, 734, 743, 754,
)

private val DCS_SET: Set<Int> = DCS_CODES.map { it.toString().toInt(8) }.toSet()
private const val SUB_RATE = 4000.0

class SubAudioDecoder(inRate: Double) {
    /** Detected CTCSS tone in Hz, 0 = none. */
    var tone = 0.0; private set
    /** Margin over the runner-up, dB. */
    var toneDb = 0.0; private set
    /** Detected DCS code (octal digits as in the table), 0 = none. */
    var dcs = 0; private set
    var dcsInverted = false; private set

    private val bank = Array(CTCSS_TONES.size) { Goertzel(CTCSS_TONES[it], SUB_RATE, (SUB_RATE / 2).toInt()) }
    private val power = DoubleArray(CTCSS_TONES.size)
    private var acc = 0.0; private var accN = 0
    private var decim = max(1, (inRate / SUB_RATE).roundToInt())
    private var lp = 0.0
    private var dc = 0.0
    private var toneMiss = 0

    // DCS bit sync
    private var bitPhase = 0.0
    private val bitLen = SUB_RATE / 134.4
    private var lastSign = false
    private var word = 0; private var wordBits = 0
    private var lastCode = 0; private var codeRun = 0; private var dcsMiss = 0

    fun reset(rate: Double) {
        decim = max(1, (rate / SUB_RATE).roundToInt())
        tone = 0.0; dcs = 0; acc = 0.0; accN = 0; lp = 0.0; dc = 0.0
        word = 0; wordBits = 0; codeRun = 0; lastCode = 0
    }

    /** Feed discriminator samples (any scale). */
    fun push(fm: FloatArray, n: Int) {
        for (i in 0 until n) {
            acc += fm[i]
            if (++accN >= decim) {
                val x = acc / accN; acc = 0.0; accN = 0
                sub(x)
            }
        }
    }

    private fun sub(x: Double) {
        // ~300 Hz one-pole low-pass keeps voice out of the tone detectors
        lp += 0.35 * (x - lp)
        val s = lp

        var done = false
        for (k in bank.indices) { val p = bank[k].push(s.toFloat()); if (p >= 0) { power[k] = p; done = true } }
        if (done) {
            var best = 0.0; var second = 0.0; var bi = -1
            for (k in power.indices) {
                val p = power[k]
                if (p > best) { second = best; best = p; bi = k } else if (p > second) second = p
            }
            val margin = 10 * log10((best + 1e-12) / (second + 1e-12))
            if (bi >= 0 && margin > 6) { tone = CTCSS_TONES[bi]; toneDb = margin; toneMiss = 0 }
            else if (++toneMiss >= 2) { tone = 0.0; toneDb = 0.0 }
        }

        // DCS: slow DC tracker, slicer, 134.4 baud clock pulled by zero crossings
        dc += 0.002 * (s - dc)
        val sign = s - dc > 0
        if (sign != lastSign) {
            bitPhase = if (bitPhase < bitLen / 2) bitPhase * 0.7 else bitPhase + (bitLen - bitPhase) * 0.3
            lastSign = sign
        }
        bitPhase += 1
        if (bitPhase >= bitLen) {
            bitPhase -= bitLen
            bit(if (sign) 1 else 0)
        }
    }

    private fun bit(b: Int) {
        word = ((word shl 1) or b) and 0x7FFFFF
        if (wordBits < 23) { wordBits++; return }
        val code = decodeWord(word)
        val found = code ?: decodeWord(word.inv() and 0x7FFFFF)
        if (found != null && found != 0) {
            val inv = code == null
            if (found == lastCode) {
                if (++codeRun >= 3) { dcs = found; dcsInverted = inv; dcsMiss = 0 }
            } else { lastCode = found; codeRun = 1 }
        } else if (++dcsMiss > 23 * 4) { dcs = 0; lastCode = 0; codeRun = 0; dcsMiss = 0 }
    }

    companion object {
        /**
         * Try the 23 rotations of a window; return the code (as its octal digits) when one has the 100 marker,
         * a zero Golay syndrome and is in the standard set.
         */
        fun decodeWord(w: Int): Int? {
            for (r in 0 until 23) {
                val x = ((w ushr r) or (w shl (23 - r))) and 0x7FFFFF
                if (((x ushr 9) and 7) != 4) continue
                if (golaySyndrome(x) != 0) continue
                val code = x and 0x1FF
                if (code in DCS_SET) return Integer.toOctalString(code).toInt()
            }
            return null
        }
    }
}

/** Golay(23,12) syndrome by polynomial division by x^11+x^10+x^6+x^5+x^4+x^2+1 (0xC75). Codewords give 0. */
private fun golaySyndrome(x: Int): Int {
    var v = x
    for (i in 22 downTo 11) if ((v and (1 shl i)) != 0) v = v xor (0xC75 shl (i - 11))
    return v and 0x7FF
}
