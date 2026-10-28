package com.rocketgod.mayhem.core.r433

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * From raw samples to bursts: the envelope and discriminator streams (rtl_433's baseband.c), the OOK / FSK pulse
 * detector (pulse_detect.c and pulse_detect_fsk.c), and the description of a burst nobody recognized. Twin of
 * web/src/dsp/r433/baseband.ts, detect.ts and analyze.ts.
 */

const val PD_MAX_PULSES = 1200
const val PD_MIN_PULSES = 16
const val PD_MIN_PULSE_SAMPLES = 10
const val PD_MIN_GAP_MS = 10
const val PD_MAX_GAP_MS = 100
const val PD_MAX_GAP_RATIO = 10
private const val OOK_MAX_HIGH_LEVEL = 16384
private const val OOK_EST_HIGH_RATIO = 64
private const val OOK_EST_LOW_RATIO = 1024
private const val FSK_EST_SLOW = 64
/**
 * Far below rtl_433's floor: a HackRF does not run its own AGC, so a quiet scene can sit near the bottom of the
 * range and rtl_433's fixed floor would never trigger. This is only a backstop; the ratio to the measured noise
 * decides.
 */
private const val OOK_MIN_HIGH_LEVEL = 600
private const val OOK_HIGH_LOW_RATIO = 3

private fun shiftPulses(p: PulseData) {
    val offs = PD_MAX_PULSES shr 1
    System.arraycopy(p.pulse, offs, p.pulse, 0, p.pulse.size - offs)
    System.arraycopy(p.gap, offs, p.gap, 0, p.gap.size - offs)
    p.numPulses -= offs
}

/** The FSK half: a min/max tracker finding the midpoint between the tones and timing the crossings. */
private class FskDetect {
    var varMax = -32768; var varMin = 32767
    var state = 0          // 0 init, 1 high, 2 low
    var pulseLength = 0
    var f1Est = 0; var f2Est = 0
    var skipSamples = 40

    fun reset() { varMax = -32768; varMin = 32767; state = 0; pulseLength = 0; f1Est = 0; f2Est = 0; skipSamples = 40 }

    fun step(fm: Int, out: PulseData) {
        if (skipSamples == 0) {
            if (fm > varMax) varMax = fm
            if (fm < varMin) varMin = fm
            val mid = (varMax + varMin) / 2
            if (fm > mid) varMax -= 10
            if (fm < mid) varMin += 10
            pulseLength += 1
            when (state) {
                0 -> state = if (fm > mid) 1 else 2
                1 -> {
                    if (fm < mid) { state = 2; out.pulse[out.numPulses] = pulseLength; pulseLength = 0 }
                    f2Est += fm / FSK_EST_SLOW - f2Est / FSK_EST_SLOW
                }
                2 -> {
                    if (fm > mid) {
                        state = 1; out.gap[out.numPulses] = pulseLength; out.numPulses += 1; pulseLength = 0
                        if (out.numPulses >= PD_MAX_PULSES) shiftPulses(out)
                    }
                    f1Est += fm / FSK_EST_SLOW - f1Est / FSK_EST_SLOW
                }
            }
        }
        if (skipSamples > 0) skipSamples -= 1
    }
}

/** Called once per burst (true = FSK). The buffer is reused, so read it before returning. */
typealias BurstFn = (Boolean, PulseData) -> Unit

class PulseDetect(private var sampleRate: Double) {
    private var ookState = 0   // 0 idle, 1 pulse, 2 gap start, 3 gap
    private var pulseLength = 0
    private var maxPulse = 0
    private var leadIn = 0
    private var lowEstimate = 0
    private var highEstimate = 0
    private val fsk = FskDetect()
    private val ook = PulseData(PD_MAX_PULSES + 1, sampleRate, false)
    private val fskPulses = PulseData(PD_MAX_PULSES + 1, sampleRate, true)

    fun reset() {
        ookState = 0; pulseLength = 0; maxPulse = 0; leadIn = 0; lowEstimate = 0; highEstimate = 0
        fsk.reset(); ook.clear(); fskPulses.clear()
    }

    /** [env] full scale 16384, [fm] signed with full deviation near ±32767. */
    fun process(env: ShortArray, fm: ShortArray, len: Int, onBurst: BurstFn) {
        val samplesPerMs = (sampleRate / 1000).toInt()
        var eopOnSpurious = false
        if (highEstimate < OOK_MIN_HIGH_LEVEL) highEstimate = OOK_MIN_HIGH_LEVEL
        var n = 0
        while (n < len) {
            val amp = env[n].toInt()
            val threshold = (lowEstimate + min(highEstimate, OOK_MAX_HIGH_LEVEL)) / 2
            val hysteresis = threshold / 8
            when (ookState) {
                0 -> {
                    if (amp > threshold + hysteresis && leadIn > OOK_EST_LOW_RATIO) {
                        ook.clear(); fskPulses.clear(); pulseLength = 0; maxPulse = 0; fsk.reset(); ookState = 1
                    } else {
                        val delta = amp - lowEstimate
                        lowEstimate += delta / OOK_EST_LOW_RATIO
                        lowEstimate += if (delta > 0) 1 else -1
                        highEstimate = max(OOK_HIGH_LOW_RATIO * lowEstimate, OOK_MIN_HIGH_LEVEL)
                        if (leadIn <= OOK_EST_LOW_RATIO) leadIn += 1
                    }
                }
                1 -> {
                    pulseLength += 1
                    if (amp < threshold - hysteresis) {
                        if (pulseLength < PD_MIN_PULSE_SAMPLES) {
                            if (ook.numPulses <= 1) ookState = 0 else { eopOnSpurious = true; ookState = 3 }
                        } else {
                            ook.pulse[ook.numPulses] = pulseLength
                            if (pulseLength > maxPulse) maxPulse = pulseLength
                            pulseLength = 0; ookState = 2
                        }
                    } else {
                        highEstimate += amp / OOK_EST_HIGH_RATIO - highEstimate / OOK_EST_HIGH_RATIO
                        if (highEstimate < OOK_MIN_HIGH_LEVEL) highEstimate = OOK_MIN_HIGH_LEVEL
                    }
                    if (ook.numPulses == 0) fsk.step(fm[n].toInt(), fskPulses)
                }
                2 -> {
                    pulseLength += 1
                    if (amp > threshold + hysteresis) {
                        // the carrier came straight back: that dip was noise, not a space
                        pulseLength += ook.pulse[ook.numPulses]; ookState = 1
                    } else if (pulseLength >= PD_MIN_PULSE_SAMPLES) {
                        ookState = 3
                        if (fskPulses.numPulses > PD_MIN_PULSES) {
                            ookState = 0
                            onBurst(true, fskPulses)
                            eopOnSpurious = false
                            continue          // re-read this sample with the state reset
                        }
                    }
                    if (ook.numPulses == 0) fsk.step(fm[n].toInt(), fskPulses)
                }
                3 -> {
                    pulseLength += 1
                    if (amp > threshold + hysteresis) {
                        ook.gap[ook.numPulses] = pulseLength
                        ook.numPulses += 1
                        if (ook.numPulses >= PD_MAX_PULSES) { ookState = 0; onBurst(false, ook); eopOnSpurious = false; continue }
                        pulseLength = 0; ookState = 1
                    }
                    if (eopOnSpurious || (pulseLength > PD_MAX_GAP_RATIO * maxPulse && pulseLength > PD_MIN_GAP_MS * samplesPerMs) || pulseLength > PD_MAX_GAP_MS * samplesPerMs) {
                        ook.gap[ook.numPulses] = pulseLength
                        ook.numPulses += 1
                        ookState = 0
                        onBurst(false, ook)
                        eopOnSpurious = false
                        continue
                    }
                }
            }
            n += 1
        }
    }

    /** The noise floor the trigger has settled on, and the magnitude a burst must exceed. */
    fun levels(): Pair<Int, Int> {
        val threshold = (lowEstimate + min(highEstimate, OOK_MAX_HIGH_LEVEL)) / 2
        return lowEstimate to (threshold + threshold / 8)
    }
}

/** butter(1, 0.05) on the envelope, butter(1, 0.2) on the discriminator. */
private const val ENV_A1 = 0.85408
private const val ENV_B0 = 0.07296
private const val FM_A1 = 0.50953
private const val FM_B0 = 0.24524

/** Arctangent to about one part in ten thousand, several times quicker than the library call. */
private fun fastAtan2(y: Double, x: Double): Double {
    val ax = abs(x); val ay = abs(y)
    val a = min(ax, ay) / (max(ax, ay) + 1e-20)
    val s = a * a
    var r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a
    if (ay > ax) r = 1.57079637 - r
    if (x < 0) r = 3.14159274 - r
    return if (y < 0) -r else r
}

/**
 * Raw samples to the envelope and discriminator streams. Not channelised: the whole sampled span at once, which is
 * how one receiver hears every device in a band. [decim] narrows that span with a two-stage CIC (worth ~5 dB on a
 * weak sensor, since the envelope detector takes in the noise of everything it is given).
 */
class Baseband {
    var env = ShortArray(0); private set
    var fm = ShortArray(0); private set
    private var envX = 0.0; private var envY = 0.0
    private var xr = 0.0; private var xi = 0.0; private var xf = 0.0; private var yf = 0.0
    private var i1 = 0; private var i2 = 0; private var q1 = 0; private var q2 = 0
    private var c1i = 0; private var c2i = 0; private var c1q = 0; private var c2q = 0
    private var accN = 0
    var decim = 1

    fun reset() { envX = 0.0; envY = 0.0; xr = 0.0; xi = 0.0; xf = 0.0; yf = 0.0; i1 = 0; i2 = 0; q1 = 0; q2 = 0; c1i = 0; c2i = 0; c1q = 0; c2q = 0; accN = 0 }

    /** Offset-128 IQ bytes in; returns how many samples [env] / [fm] now hold. */
    fun process(iq: ByteArray, len: Int): Int {
        val total = len / 2
        val dc = if (decim < 1) 1 else decim
        val cap = ceil((total + dc).toDouble() / dc).toInt()
        if (env.size < cap) { env = ShortArray(cap); fm = ShortArray(cap) }
        val e = env; val f = fm
        var ex = envX; var ey = envY
        var x1r = xr; var x1i = xi; var x1f = xf; var y1f = yf
        var a1 = i1; var a2 = i2; var b1 = q1; var b2 = q2
        var ci1 = c1i; var ci2 = c2i; var cq1 = c1q; var cq2 = c2q
        var acc = accN
        val gain = (dc * dc).toDouble()
        var n = 0
        for (s in 0 until total) {
            // 32-bit integrators that may wrap: the differences that follow come out exact
            a1 += (iq[2 * s].toInt() and 0xff) - 128; a2 += a1
            b1 += (iq[2 * s + 1].toInt() and 0xff) - 128; b2 += b1
            if (++acc < dc) continue
            acc = 0
            val d1i = a2 - ci1; ci1 = a2
            val d2i = d1i - ci2; ci2 = d1i
            val d1q = b2 - cq1; cq1 = b2
            val d2q = d1q - cq2; cq2 = d1q
            val ir = d2i / gain; val ii = d2q / gain
            val i = n++
            // magnitude without a square root: 122/128 of the larger plus 51/128 of the smaller, full scale ≈ 16384
            val ax = abs(ir); val ay = abs(ii)
            val mag = if (ax > ay) 122 * ax + 51 * ay else 122 * ay + 51 * ax
            ey = ENV_A1 * ey + ENV_B0 * (mag + ex); ex = mag
            e[i] = (if (ey > 32767) 32767.0 else ey).toInt().toShort()
            val pr = ir * x1r + ii * x1i; val pi = ii * x1r - ir * x1i
            val x0f = fastAtan2(pi, pr) * 10430.378
            y1f = FM_A1 * y1f + FM_B0 * (x0f + x1f); x1f = x0f
            x1r = ir; x1i = ii
            f[i] = (if (y1f > 32767) 32767.0 else if (y1f < -32768) -32768.0 else y1f).toInt().toShort()
        }
        envX = ex; envY = ey; xr = x1r; xi = x1i; xf = x1f; yf = y1f
        i1 = a1; i2 = a2; q1 = b1; q2 = b2; c1i = ci1; c2i = ci2; c1q = cq1; c2q = cq2; accN = acc
        return n
    }
}

// ================================================================================================ analyze

/** One recurring width, µs, with how many times it occurred. */
data class Cluster(val us: Int, val n: Int)

/** Everything measurable about one unrecognized burst. */
data class BurstShape(val fsk: Boolean, val pulses: Int, val ms: Double, val mark: List<Cluster>, val space: List<Cluster>, val coding: String, val rate: Int, val key: String)

private fun cluster(v: IntArray, n: Int, spus: Double): List<Cluster> {
    if (n <= 0) return emptyList()
    val us = DoubleArray(n) { v[it] / spus }.sorted()
    val groups = ArrayList<Pair<Double, Int>>()
    var sum = us[0]; var count = 1
    for (i in 1 until us.size) {
        val mean = sum / count
        if (us[i] - mean <= mean * 0.2) { sum += us[i]; count++ } else { groups.add(sum to count); sum = us[i]; count = 1 }
    }
    groups.add(sum to count)
    val floor = max(1, (us.size * 0.08).roundToInt())
    return groups.filter { it.second >= floor }.map { Cluster((it.first / it.second).roundToInt(), it.second) }
}

private fun nameCoding(mark: List<Cluster>, space: List<Cluster>): String {
    if (mark.isEmpty()) return ""
    if (mark.size == 1 && space.size >= 2) return "pulse position"
    if (mark.size >= 2 && space.size == 1) return "pulse width"
    if (mark.size == 1 && space.size == 1) return "fixed period — a preamble, or every bit the same"
    if (mark.size == 2 && space.size == 2) {
        val mr = mark[1].us.toDouble() / mark[0].us; val sr = space[1].us.toDouble() / space[0].us
        if (mr > 1.6 && mr < 2.5 && sr > 1.6 && sr < 2.5) return "Manchester or level per bit"
        return "two widths each way"
    }
    return ""
}

fun describeBurst(p: PulseData): BurstShape {
    val spus = p.sampleRate / 1e6; val n = p.numPulses
    val mark = cluster(p.pulse, n, spus); val space = cluster(p.gap, max(0, n - 1), spus)
    var total = 0L
    for (i in 0 until n) total += p.pulse[i]
    for (i in 0 until n - 1) total += p.gap[i]
    val ms = total / spus / 1000
    val rate = if (n > 1) (1e6 / (total / spus / (n - 1))).roundToInt() else 0
    val key = listOf(if (p.fsk) "F" else "O", mark.joinToString(".") { (it.us / 10.0).roundToInt().toString() },
        space.joinToString(".") { (it.us / 10.0).roundToInt().toString() }, (n / 8.0).roundToInt().toString()).joinToString("-")
    return BurstShape(p.fsk, n, ms, mark, space, nameCoding(mark, space), rate, key)
}

fun shapeSummary(s: BurstShape): String {
    val parts = arrayListOf("${s.pulses} pulses", if (s.ms < 10) "%.1f ms".format(s.ms) else "${s.ms.roundToInt()} ms")
    if (s.rate != 0) parts.add(if (s.rate >= 1000) "%.1fk sym/s".format(s.rate / 1000.0) else "${s.rate} sym/s")
    if (s.mark.isNotEmpty()) parts.add("marks ${s.mark.joinToString("/") { it.us.toString() }} µs")
    if (s.space.isNotEmpty()) parts.add("gaps ${s.space.joinToString("/") { it.us.toString() }} µs")
    return parts.joinToString(" · ")
}
