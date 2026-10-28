package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Sound-card style digital decoders fed with the HAM receiver's 48 kHz audio (SSB / CW audio, like a rig into a
 * computer). Each reports text through [DigitalDecoder.onText], plus a confidence (0..1) that AUTO uses to pick the
 * decoder that is actually making sense of the signal. Twin of web/src/dsp/ham/digital.ts.
 *
 *   CW     tone detector at the pitch → adaptive threshold → mark/space timing → adaptive dit → Morse table
 *   RTTY   mark/space tone detectors (2125/2295, 170 Hz shift, 45.45 Bd by default) → UART framing → ITA2 Baudot
 *   PSK31  mix to baseband at the audio center → matched low-pass → symbol clock from the envelope dips at
 *          phase reversals → differential BPSK → varicode
 */

interface DigitalDecoder {
    val name: String
    val confidence: Float
    var onText: (text: String, meta: String?) -> Unit
    fun reset()
    fun push(audio: FloatArray, n: Int)
}

private const val RATE = 48_000.0

/** Quadrature tone detector: complex mix + two-pole low-pass, magnitude at the decimated rate. */
private class ToneDetector(hz: Double, bwHz: Double, private val decim: Int) {
    private var cr = 1.0; private var ci = 0.0
    private val dr = cos(-2 * PI * hz / RATE); private val di = sin(-2 * PI * hz / RATE)
    private var i1 = 0.0; private var i2 = 0.0; private var q1 = 0.0; private var q2 = 0.0
    private val a = 1 - exp(-2 * PI * bwHz / RATE)
    private var n = 0

    private fun step(x: Float): Boolean {
        val i = x * cr; val q = x * ci
        val nr = cr * dr - ci * di; ci = cr * di + ci * dr; cr = nr
        i1 += a * (i - i1); i2 += a * (i1 - i2)
        q1 += a * (q - q1); q2 += a * (q1 - q2)
        if (++n >= decim) {
            n = 0
            val g = 1 / sqrt(cr * cr + ci * ci); cr *= g; ci *= g
            return true
        }
        return false
    }

    /** One sample in; the magnitude when a decimated sample is due, else −1. */
    fun push(x: Float): Double = if (step(x)) sqrt(i2 * i2 + q2 * q2) else -1.0

    /** Complex output (for PSK). */
    fun pushIq(x: Float, out: DoubleArray): Boolean {
        if (!step(x)) return false
        out[0] = i2; out[1] = q2; return true
    }
}

// ------------------------------------------------------------------------------------------------ CW
private val MORSE = mapOf(
    ".-" to "A", "-..." to "B", "-.-." to "C", "-.." to "D", "." to "E", "..-." to "F", "--." to "G", "...." to "H", ".." to "I",
    ".---" to "J", "-.-" to "K", ".-.." to "L", "--" to "M", "-." to "N", "---" to "O", ".--." to "P", "--.-" to "Q", ".-." to "R",
    "..." to "S", "-" to "T", "..-" to "U", "...-" to "V", ".--" to "W", "-..-" to "X", "-.--" to "Y", "--.." to "Z",
    "-----" to "0", ".----" to "1", "..---" to "2", "...--" to "3", "....-" to "4", "....." to "5", "-...." to "6", "--..." to "7",
    "---.." to "8", "----." to "9", ".-.-.-" to ".", "--..--" to ",", "..--.." to "?", "-..-." to "/", "-...-" to "=", "-....-" to "-",
    ".--.-." to "@", "---..." to ":", ".-.-." to "+", "-.--." to "(", "-.--.-" to ")", ".-..." to "<AS>", "...-.-" to "<SK>",
    "-.-.-" to "<KA>", "........" to "<ERR>",
)

class CwDecoder(pitch: Double = 600.0) : DigitalDecoder {
    override val name = "CW"
    override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    var wpm = 20; private set
    private val step = 96            // 500 Hz envelope rate
    private var det = ToneDetector(pitch, 80.0, step)
    private var peak = 0.0; private var floor = 0.0
    private var mark = false; private var run = 0.0
    private var dit = 60.0           // ms
    private var sym = StringBuilder(); private var idleChars = 0
    private val marks = ArrayDeque<Double>()

    fun setPitch(hz: Double) { det = ToneDetector(hz, 80.0, step) }

    override fun reset() { peak = 0.0; floor = 0.0; mark = false; run = 0.0; sym.clear(); marks.clear(); confidence = 0f }

    override fun push(audio: FloatArray, n: Int) {
        val ms = 1000.0 * step / RATE
        for (i in 0 until n) {
            val m = det.push(audio[i]); if (m < 0) continue
            // adaptive threshold between a fast-rising peak tracker and a slow floor tracker
            peak = if (m > peak) peak + 0.5 * (m - peak) else peak + 0.002 * (m - peak)
            floor = if (m < floor) floor + 0.2 * (m - floor) else floor + 0.004 * (m - floor)
            val thr = sqrt(max(1e-9, peak * floor)) * (if (mark) 0.8 else 1.25)
            val on = m > thr && peak > floor * 3
            if (on == mark) { run += ms; if (!on) gap(); continue }
            if (mark) element(run) else if (run > 0) space(run)
            mark = on; run = ms
        }
    }

    private fun element(ms: Double) {
        if (ms < 15) return
        val isDah = ms > dit * 2
        sym.append(if (isDah) '-' else '.')
        val est = if (isDah) ms / 3 else ms
        dit = min(240.0, max(20.0, dit * 0.85 + est * 0.15))
        wpm = (1200 / dit).roundToInt()
        marks.addLast(ms); if (marks.size > 24) marks.removeFirst()
        // two clusters of mark lengths near 1:3 read as Morse
        if (marks.size >= 8) {
            val s = marks.sorted()
            val lo = s[(s.size * 0.25).toInt()]; val hi = s[(s.size * 0.75).toInt()]
            val r = hi / max(1.0, lo)
            confidence = (max(0.0, min(1.0, 1 - abs(r - 3) / 2.5)) * 0.9).toFloat()
        }
    }

    private fun space(ms: Double) { if (ms > dit * 2.2) flush() }

    private fun gap() {
        if (!mark && sym.isNotEmpty() && run > dit * 2.2) flush()
        if (!mark && run > dit * 6 && idleChars == 0) { idleChars = 1; onText(" ", null) }
        if (!mark && run > dit * 30) confidence *= 0.999f
    }

    private fun flush() {
        if (sym.isEmpty()) return
        onText(MORSE[sym.toString()] ?: "·", "$wpm WPM"); sym.clear(); idleChars = 0
    }
}

// ------------------------------------------------------------------------------------------------ RTTY
private const val ITA2_LTRS = "\u0000E\nA SIU\rDRJNFCKTZLWHYPQOBG\u0000MXV\u0000"
private const val ITA2_FIGS = "\u00003\n- \u000787\r$4',!:(5\")2#6019?&\u0000./;\u0000"

class RttyDecoder(mark: Double = 2125.0, shift: Double = 170.0, baud: Double = 45.45, reverse: Boolean = false) : DigitalDecoder {
    override val name = "RTTY"
    override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    var mark = mark; private set
    var shift = shift; private set
    var baud = baud; private set
    var reverse = reverse; private set
    private val step = 48            // 1 kHz decision rate
    private lateinit var markDet: ToneDetector
    private lateinit var spaceDet: ToneDetector
    private var bitLen = 1000 / 45.45
    private var figs = false
    private var state = 0            // 0 idle, 1 start, 2 data, 3 stop
    private var t = 0.0; private var bits = 0; private var nbits = 0
    private var lastSign = 1
    private var frames = 0; private var badFrames = 0
    private var dc = 0.0

    init { setup() }

    fun configure(mark: Double, shift: Double, baud: Double, reverse: Boolean) {
        this.mark = mark; this.shift = shift; this.baud = baud; this.reverse = reverse; setup()
    }

    private fun setup() {
        val bw = max(40.0, baud * 0.9)
        markDet = ToneDetector(mark, bw, step); spaceDet = ToneDetector(mark - shift, bw, step)
        bitLen = 1000 / baud
        state = 0; frames = 0; badFrames = 0; confidence = 0f
    }

    override fun reset() { setup(); figs = false }

    override fun push(audio: FloatArray, n: Int) {
        for (i in 0 until n) {
            val m = markDet.push(audio[i]); val s = spaceDet.push(audio[i])
            if (m < 0) continue
            var v = (m - s) / (m + s + 1e-9)            // +1 mark, −1 space
            if (reverse) v = -v
            dc += 0.001 * (v - dc)
            clock(if (v - dc * 0.5 > 0) 1 else 0)
        }
    }

    private fun clock(bit: Int) {
        t += 1
        when (state) {
            0 -> if (lastSign == 1 && bit == 0) { state = 1; t = 0.0 }
            1 -> if (t >= bitLen / 2) { if (bit == 0) { state = 2; bits = 0; nbits = 0; t = 0.0 } else state = 0 }
            2 -> if (t >= bitLen) { t -= bitLen; bits = bits or (bit shl nbits); if (++nbits >= 5) state = 3 }
            3 -> if (t >= bitLen) {
                frames++
                if (bit == 1) emit(bits) else badFrames++
                confidence = max(0.0, min(1.0, (1 - badFrames.toDouble() / max(4, frames)) * min(1.0, frames / 12.0))).toFloat()
                state = 0; t = 0.0
            }
        }
        lastSign = bit
    }

    private fun emit(code: Int) {
        if (code == 0x1F) { figs = false; return }
        if (code == 0x1B) { figs = true; return }
        val table = if (figs) ITA2_FIGS else ITA2_LTRS
        val ch = if (code < table.length) table[code] else '\u0000'
        if (ch == '\u0000' || ch == '\r') return
        onText(ch.toString(), "$baud Bd · ${shift.toInt()} Hz")
    }
}

// ------------------------------------------------------------------------------------------------ PSK31
class Psk31Decoder(center: Double = 1000.0) : DigitalDecoder {
    override val name = "PSK31"
    override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    var center = center; private set
    private val decim = 96           // 500 Hz → 16 samples per symbol
    private val spb = 16
    private lateinit var det: ToneDetector
    private val iq = DoubleArray(2)
    private val energy = DoubleArray(16)
    private var phase = 0
    private var lastI = 0.0; private var lastQ = 0.0
    private val code = StringBuilder(); private var zeros = 0
    private var afc = 0.0
    private var dips = 0; private var samples = 0

    init { setup() }

    fun setCenter(hz: Double) { center = hz; setup() }

    private fun setup() {
        det = ToneDetector(center, 40.0, decim); energy.fill(0.0); phase = 0; code.clear(); zeros = 0; afc = 0.0; confidence = 0f
    }

    override fun reset() = setup()

    override fun push(audio: FloatArray, n: Int) {
        for (i in 0 until n) {
            if (!det.pushIq(audio[i], iq)) continue
            val ii = iq[0]; val qq = iq[1]
            // symbol clock: the envelope dips at every phase reversal; sample at the energy peak of the clock phases
            energy[phase] = energy[phase] * 0.97 + (ii * ii + qq * qq) * 0.03
            var best = 0; for (k in 1 until spb) if (energy[k] > energy[best]) best = k
            if (phase == best) symbol(ii, qq)
            phase = (phase + 1) % spb
        }
    }

    private fun symbol(ii: Double, qq: Double) {
        // differential decision, with AFC from the residual rotation on "1" symbols
        val c = cos(afc); val s = sin(afc)
        val ri = ii * c + qq * s; val rq = qq * c - ii * s
        val dot = ri * lastI + rq * lastQ; val cross = rq * lastI - ri * lastQ
        val mag = sqrt((ri * ri + rq * rq) * (lastI * lastI + lastQ * lastQ)) + 1e-12
        val bit = if (dot / mag > 0) 1 else 0
        if (bit == 1) afc += 0.02 * atan2(cross, dot)
        lastI = ri; lastQ = rq
        samples++; if (bit == 0) dips++
        if (samples >= 64) {
            val r = dips.toDouble() / samples
            confidence = if (r > 0.15 && r < 0.7 && mag > 1e-8) min(1f, confidence + 0.1f) else max(0f, confidence - 0.15f)
            samples = 0; dips = 0
        }
        // varicode: characters never contain "00" and never start or end with 0; "00" is the boundary
        if (bit == 0) {
            if (zeros == 1) {
                val cd = code.substring(0, max(0, code.length - 1))
                if (cd.isNotEmpty()) {
                    val idx = VARICODE.indexOf(cd)
                    if (idx in 32..126) onText(idx.toChar().toString(), "${center.toInt()} Hz")
                    else if (idx == 10 || idx == 13) onText("\n", null)
                }
                code.clear(); zeros = 0
            } else { zeros = 1; code.append('0') }
        } else { zeros = 0; code.append('1') }
        if (code.length > 12) code.clear()
    }
}

/** PSK31 varicode, ASCII 0..127 (protocol constant; the list index is the character code). */
val VARICODE = listOf(
    "1010101011", "1011011011", "1011101101", "1101110111", "1011101011", "1101011111", "1011101111", "1011111101", "1011111111", "11101111",
    "11101", "1101101111", "1011011101", "11111", "1101110101", "1110101011", "1011110111", "1011110101", "1110101101", "1110101111",
    "1101011011", "1101101011", "1101101101", "1101010111", "1101111011", "1101111101", "1110110111", "1101010101", "1101011101", "1110111011",
    "1011111011", "1101111111", "1", "111111111", "101011111", "111110101", "111011011", "1011010101", "1010111011", "101111111",
    "11111011", "11110111", "101101111", "111011111", "1110101", "110101", "1010111", "110101111", "10110111", "10111101",
    "11101101", "11111111", "101110111", "101011011", "101101011", "110101101", "110101011", "110110111", "11110101", "110111101",
    "111101101", "1010101", "111010111", "1010101111", "1010111101", "1111101", "11101011", "10101101", "10110101", "1110111",
    "11011011", "11111101", "101010101", "1111111", "111111101", "101111101", "11010111", "10111011", "11011101", "10101011",
    "11010101", "111011101", "10101111", "1101111", "1101101", "101010111", "110110101", "101011101", "101110101", "101111011",
    "1010101101", "111110111", "111101111", "111111011", "1010111111", "101101101", "1011011111", "1011", "1011111", "101111",
    "101101", "11", "111101", "1011011", "101011", "1101", "111101011", "10111111", "11011", "111011",
    "1111", "111", "111111", "110111111", "10101", "10111", "101", "110111", "1111011", "1101011",
    "11011111", "1011101", "111010101", "1010110111", "110111011", "1010110101", "1011010111", "1110110101",
)
