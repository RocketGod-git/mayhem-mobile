package com.rocketgod.mayhem.core.hamplus

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * Whether a channel's demodulated audio carries a voice, block by block: what makes an open channel a transmission
 * (talk time, the log, the time machine, the scan staying) rather than a steady carrier.
 *
 * FM (Repeaters): the discriminator in blocks of [SPEECH_N] samples (about 85 ms at 24 kS/s), each one's spectrum
 * turned back up by the down-converter's own response. Noise out of an FM discriminator rises with frequency, so the
 * band above any voice (5 to 8 kHz) is the block's own noise reference:
 *  - a voice, or a digital voice (P25, DMR), puts its power into 400 to 3000 Hz, [SPEECH_DB] (6 dB) and more over the
 *    noise band a Hz. A carrier with nothing on it measures under 0 dB, quieted (its noise rising with frequency) or not
 *    (the noise about flat), and so does a sub-audible tone, which sits under 400 Hz;
 *  - a CW ID is a tone keyed on and off: a bin [TONE_DB] (20 dB) over the median of 400 to 3000 Hz, counted while the
 *    last two seconds also hold a block without it. A tone that never goes off (a whistle) is not keyed.
 * Measured on real air (fixtures/hamplus/air), each threshold about 6 dB clear of both sides: the office's 420.000
 * and 29.552 / 29.520 carriers read -9 to +0.1 dB with no bin over 13.1 dB; home's WB6NXP, K7FYS and P25 voice reach
 * 19 to 37 dB, and K6VGP's CW ID 26 to 41 dB over the median while its band ratio stays near 0 dB.
 */

/** Samples a block, the band ratio and the keyed tone a block needs, and how long a tone must have been off. */
const val SPEECH_N = 2048
const val SPEECH_DB = 6.0
const val TONE_DB = 20.0
const val KEYED_BLOCKS = 24
/** Speech blocks, within the last [SPEECH_RECENT], before an open channel is a transmission (a quarter second of voice). */
const val SPEECH_MIN = 3
const val SPEECH_RECENT = 16
/** A transmission without speech this long while its carrier stays on ends at its last speech: the rest is steady. */
const val SPEECH_LAPSE_MS = 10_000.0
/** The carrier's reference floor: over this many blocks (about ten seconds), once it has this many (half a second). */
const val FLOOR_BLOCKS = 160
const val FLOOR_MIN = 8
/** How much of each block's measure is kept for the tests and the card. */
private const val KEEP = 2_000

/** The count every speech meter keeps: blocks heard, those that carried a voice, and when. */
open class SpeechCount {
    var blocks = 0; private set
    var speech = 0; private set
    /** Speech blocks among the last [SPEECH_RECENT]: a voice is [SPEECH_MIN] of them, so a stray block is not. */
    var recent = 0; private set
    /** Milliseconds into the channel (its demodulator's time) the first speech of the last run of [SPEECH_MIN] began,
     *  and the last speech block ended; -1 before any. */
    var firstMs = -1.0; private set
    var lastMs = -1.0; private set
    /** Each block's measure (dB) and whether it counted, the last [KEEP] of them. */
    val db = ArrayDeque<Double>(); val hit = ArrayDeque<Boolean>()
    private val ring = ArrayDeque<Double>()

    protected fun mark(db: Double, speech: Boolean, endMs: Double) {
        blocks++
        ring.addLast(if (speech) endMs else -1.0); if (ring.size > SPEECH_RECENT) ring.removeFirst()
        recent = ring.count { it >= 0 }
        if (speech) { this.speech++; lastMs = endMs; if (firstMs < 0 && recent >= SPEECH_MIN) firstMs = ring.first { it >= 0 } }
        this.db.addLast((db * 10).roundToInt() / 10.0); hit.addLast(speech)
        if (this.db.size > KEEP) { this.db.removeFirst(); hit.removeFirst() }
    }

    /** A voice was heard: [SPEECH_MIN] speech blocks within [SPEECH_RECENT]. */
    val heard: Boolean get() = firstMs >= 0
}

/** FM: the discriminator's voice band against the noise above it, and keyed tones. */
class FmSpeech(private val fs: Double, powerGain: (Double) -> Double) : SpeechCount() {
    private val buf = FloatArray(SPEECH_N); private var n = 0; private var samples = 0L
    private val win = FloatArray(SPEECH_N) { (0.5 - 0.5 * cos(2 * PI * it / (SPEECH_N - 1))).toFloat() }
    private val re = FloatArray(SPEECH_N); private val im = FloatArray(SPEECH_N)
    private val v0: Int; private val v1: Int; private val n0: Int; private val n1: Int
    /** Each bin's correction for the down-converter's response (1 over its power gain). */
    private val gain: DoubleArray
    private val tones = ArrayDeque<Boolean>()
    private val band: DoubleArray
    /** The tone level (dB over the median) of each block, the last [KEEP]. */
    val tone = ArrayDeque<Double>()

    init {
        val bh = fs / SPEECH_N
        v0 = (400 / bh).roundToInt(); v1 = (3_000 / bh).roundToInt(); n0 = (5_000 / bh).roundToInt(); n1 = min(SPEECH_N / 2 - 1, (8_000 / bh).roundToInt())
        gain = DoubleArray(n1 + 1) { 1 / max(1e-4, powerGain(it * bh)) }
        band = DoubleArray(v1 - v0 + 1)
    }

    fun push(x: FloatArray, m: Int) {
        for (i in 0 until m) { buf[n++] = x[i]; if (n >= SPEECH_N) { samples += SPEECH_N; block(); n = 0 } }
    }

    private fun block() {
        for (k in 0 until SPEECH_N) { re[k] = buf[k] * win[k]; im[k] = 0f }
        Dsp.fft(re, im)
        var v = 0.0; var nz = 0.0; var pk = 0.0
        for (k in v0..v1) { val p = re[k].toDouble() * re[k] + im[k].toDouble() * im[k]; band[k - v0] = p; if (p > pk) pk = p; v += p * gain[k] }
        for (k in n0..n1) nz += (re[k].toDouble() * re[k] + im[k].toDouble() * im[k]) * gain[k]
        v /= v1 - v0 + 1; nz /= n1 - n0 + 1
        band.sort()
        val ratio = 10 * log10((v + 1e-20) / (nz + 1e-20)); val toneDb = 10 * log10((pk + 1e-20) / (band[band.size shr 1] + 1e-20))
        val tone = toneDb >= TONE_DB; val keyed = tone && tones.any { !it }
        tones.addLast(tone); if (tones.size > KEYED_BLOCKS) tones.removeFirst()
        this.tone.addLast((toneDb * 10).roundToInt() / 10.0); if (this.tone.size > KEEP) this.tone.removeFirst()
        mark(ratio, ratio >= SPEECH_DB || keyed, samples * 1000.0 / fs)
    }
}

/**
 * CB's voice, a block of [len] samples (64 ms at 16 kS/s) at a time, against a reference only noise moves:
 *  - a carrier held (AM, or FM): the audio in line with the carrier against the floor (the quietest fifth over the
 *    last ten seconds) of the part at right angles to it. Noise puts the same power in both, so a carrier with nothing
 *    on it never stands over that floor; a voice does, AM or FM, and still does when the carrier followed is a
 *    neighbor's (both parts then carry it);
 *  - no carrier, single sideband: the side heard against the other side, the same block.
 * A block is a voice [thrDb] (6 dB) over its reference. Noise alone reads within a dB of 0 (a steady carrier, a carrier
 * that wanders, a comb line); home's real AM talkers read 5 to 12 dB through half their blocks and more, and its LSB
 * talker 7 dB at the median (fixtures/cb/real).
 */
class RatioSpeech(private val fs: Double, val thrDb: Double = SPEECH_DB, private val len: Int = SPEECH_N / 2) : SpeechCount() {
    private var fa = 0.0; private var fb = 0.0; private var fn = 0; private var sa = 0.0; private var sb = 0.0; private var sn = 0; private var n = 0; private var samples = 0L
    private val hist = ArrayDeque<Double>()

    /** One sample: its power in the voice and in its reference, judged against the reference's floor over time
     *  ([kind] 1, a carrier held) or the same block (2, a sideband); 0 where there is nothing to measure. */
    fun push(voice: Double, ref: Double, kind: Int) {
        samples++
        if (kind == 1) { fa += voice; fb += ref; fn++ } else if (kind == 2) { sa += voice; sb += ref; sn++ }
        if (++n < len) return
        var db = -99.0
        if (fn * 2 >= len) {
            val a = fa / fn; val b = fb / fn
            hist.addLast(b); if (hist.size > FLOOR_BLOCKS) hist.removeFirst()
            if (hist.size >= FLOOR_MIN) { val f = hist.sorted()[hist.size / 5]; db = 10 * log10((a + 1e-30) / (f + 1e-30)) }
        } else if (sn * 2 >= len) db = 10 * log10((sa + 1e-30) / (sb + 1e-30))
        mark(db, db >= thrDb, samples * 1000.0 / fs)
        fa = 0.0; fb = 0.0; fn = 0; sa = 0.0; sb = 0.0; sn = 0; n = 0
    }
}
