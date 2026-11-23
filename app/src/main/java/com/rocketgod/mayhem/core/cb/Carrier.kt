package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * The carrier an AM transmission is demodulated against: found, followed and held. Twin of web dsp/cb/carrier.ts.
 *
 * Stations are seldom on the channel's center (a few hundred Hz off is common) and some key up as much as 2.4 kHz
 * high and slide down over a couple of seconds. So the carrier is found, not assumed: the strongest line within
 * 1.5 kHz below the center to 2.6 kHz above it in the last 250 ms is taken, then followed every 10 ms by how fast its
 * phasor (the signal turned to DC at the carrier and smoothed about 20 Hz wide) turns, by at most 60 Hz a step.
 * Several stations on a channel at once is common when the band is open; the one taken is held for its whole keyup,
 * since flipping between carriers is heard as a warble. Another is taken only when it is 10 dB stronger (checked every
 * half second, and as soon as the held one has faded 10 dB under its keyup's peak for 200 ms); after 1.5 s gone,
 * whatever is strongest. A shorter fade is bridged at the carrier's last frequency.
 */

private const val ACQ_N = 4096
/**
 * Where a carrier is looked for (Hz from the center): stations sit a few hundred Hz off, and some key up as much as
 * 2.4 kHz high and slide down, none far low. A line 3 kHz below the center (a spur's) is never taken.
 */
const val ACQ_LOW_HZ = -1_500.0
const val ACQ_HIGH_HZ = 2_600.0
const val ACQ_RANGE_HZ = 3_000.0
const val ACQ_MIN_DB = 10.0
const val TRACK_BW_HZ = 60.0
const val STEP_MS = 10.0
/** The carrier phasor is smoothed this wide (Hz): narrow enough to keep a neighbor 100 Hz away out of it. */
const val PHASOR_HZ = 20.0
/** While held, the carrier is checked against the others this often (ms). */
const val RECHECK_MS = 500.0
/** How much of the measured offset each step corrects: enough to follow a key-up glide of 2 kHz a second. */
const val FLL_GAIN = 0.8
const val LOST_DB = 10.0
const val LOST_MS = 200.0
const val BRIDGE_MS = 1_500.0
const val SWITCH_DB = 10.0
/** Other lines this far from the carrier are notched (Hz); nearer, they may be the station itself. */
const val NOTCH_CLEAR_HZ = 30.0
/** Where the noise is read: past the voice (3 kHz from a carrier up to a few hundred Hz off), inside the probe's band. */
const val NOISE_LO_HZ = 3_600.0
const val NOISE_HI_HZ = 4_200.0

class CarrierChange(val ms: Double, val hz: Double)

class CarrierTracker(private val fs: Double) {
    /** The carrier's frequency (Hz from the channel's center), whether one is held, and how often it was changed. */
    var hz = 0.0; private set
    var have = false; private set
    var switches = 0; private set
    /** The signal in the carrier's frame (written each step) and the carrier phasor. */
    var br = 0.0; private set
    var bi = 0.0; private set
    var cr = 0.0; private set
    var ci = 0.0; private set
    /** The carrier's level smoothed to about 5 Hz, and its keyup's peak. */
    var lvl = 0.0; private set
    var peak = 0.0; private set
    /**
     * The noise a sample carries (its variance), measured 3.6 to 4.2 kHz either side of the center where no voice
     * reaches, at each look at the spectrum; 0 before the first.
     */
    var noiseVar = 0.0; private set
    /** The power gain of whatever filtered the signal before it, at a frequency (the noise band is read through it). */
    var gain: (Double) -> Double = { 1.0 }
    /** Steady lines measured on the idle channel (Hz): never taken for a station's carrier. */
    var ignore: List<Double> = emptyList()
    /** How long the carrier now held has been held (ms). */
    val heldMs: Double get() = if (have) ms - (changes.lastOrNull()?.ms ?: 0.0) else 0.0
    /** The carrier's frequency every 100 ms while held, for the offset. */
    val log = ArrayList<Double>()
    /** Each change of carrier: when (ms since the start) and to what (Hz). */
    val changes = ArrayList<CarrierChange>()
    private val ri = FloatArray(ACQ_N); private val rq = FloatArray(ACQ_N); private var rn = 0; private var filled = 0
    private val win = FloatArray(ACQ_N) { (0.5 - 0.5 * cos(2 * PI * it / (ACQ_N - 1))).toFloat() }
    private val g2: Double; private val w2: Double
    private var ph = 0.0; private var w = 0.0
    private val a = 1 - exp(-2 * PI * PHASOR_HZ / fs)
    private val a5 = 1 - exp(-2 * PI * 5 * STEP_MS / 1000)
    private val stepN = (fs * STEP_MS / 1000).roundToInt()
    private var n = 0; private var lr = 0.0; private var li = 0.0; private var lowMs = 0.0; private var sinceTry = 0.0; private var sinceCheck = 0.0; private var ms = 0.0; private var logN = 0

    init {
        var g = 0.0; var ww = 0.0
        for (v in win) { g += v; ww += v.toDouble() * v }
        g2 = g * g; w2 = ww
    }

    fun step(i: Double, q: Double) {
        ri[rn] = i.toFloat(); rq[rn] = q.toFloat(); if (++rn >= ACQ_N) rn = 0; if (filled < ACQ_N) filled++
        val c = cos(ph); val s = sin(ph)
        val br = i * c + q * s; val bi = q * c - i * s
        this.br = br; this.bi = bi
        cr += a * (br - cr); ci += a * (bi - ci)
        ph += w; if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
        if (++n >= stepN) { n = 0; tick() }
    }

    private fun tick() {
        ms += STEP_MS
        if (!have) { sinceTry += STEP_MS; if (filled >= ACQ_N / 4 && sinceTry >= 100) { sinceTry = 0.0; acquire(0.0, false) }; return }
        val mag = hypot(cr, ci)
        lvl += a5 * (mag - lvl)
        peak = max(peak, lvl)
        val low = lvl < peak / 10.0.pow(LOST_DB / 20)
        if (!low) {
            // the phasor's turning since the last step is how far the carrier sits off: move most of the way onto it
            if (lr != 0.0 || li != 0.0) {
                val d = atan2(ci * lr - cr * li, cr * lr + ci * li)
                setHz(hz + max(-TRACK_BW_HZ, min(TRACK_BW_HZ, FLL_GAIN * d * fs / (2 * PI * stepN))))
            }
            lowMs = 0.0
            if (++logN >= 100 / STEP_MS) { logN = 0; log.add(hz) }
            sinceCheck += STEP_MS
            if (sinceCheck >= RECHECK_MS) { sinceCheck = 0.0; acquire(mag * mag * 10.0.pow(SWITCH_DB / 10), true) }
        } else {
            lowMs += STEP_MS; sinceTry += STEP_MS
            // faded: another line takes over only if it is 10 dB over what is left and no more than 6 dB under the keyup's peak
            if (lowMs >= LOST_MS && sinceTry >= 100) {
                sinceTry = 0.0
                acquire(if (lowMs >= BRIDGE_MS) 0.0 else max(mag * mag * 10.0.pow(SWITCH_DB / 10), peak * peak / 4), true)
            }
        }
        lr = cr; li = ci
    }

    private fun setHz(hz: Double) { this.hz = hz; w = 2 * PI * hz / fs }

    /** Takes the strongest line within reach of the center when its power is at least [needPow] (0: any clear line). */
    private fun acquire(needPow: Double, elsewhere: Boolean) {
        val nn = ACQ_N; val re = FloatArray(nn); val im = FloatArray(nn); val have = min(filled, nn)
        // the newest [have] samples, the window over them
        for (k in nn - have until nn) { val j = (rn + k) % nn; re[k] = ri[j] * win[k]; im[k] = rq[j] * win[k] }
        Dsp.fft(re, im)
        val binHz = fs / nn; val r = (ACQ_RANGE_HZ / binHz).roundToInt(); val pw = DoubleArray(2 * r + 1)
        for (b in -r..r) { val k = (b + nn) % nn; pw[b + r] = p2(re[k], im[k]) }
        val med = pw.sorted()[r].let { if (it == 0.0) 1e-12 else it }
        val lo = (NOISE_LO_HZ / binHz).roundToInt(); val hi = (NOISE_HI_HZ / binHz).roundToInt(); val edge = ArrayList<Double>()
        var b0 = lo
        while (b0 <= hi && b0 < nn / 2) {
            val gk = max(1e-3, gain(b0 * binHz))
            for (k in intArrayOf(b0, nn - b0)) edge.add(p2(re[k], im[k]) / gk)
            b0++
        }
        if (edge.isNotEmpty()) { edge.sort(); noiseVar = edge[edge.size / 2] / w2 * (nn.toDouble() / have) }
        var best = -1
        fun idle(b: Int) = ignore.any { h -> abs((b - r) * binHz - h) <= NOTCH_CLEAR_HZ + binHz }
        fun reach(b: Int) = (b - r) * binHz >= ACQ_LOW_HZ && (b - r) * binHz <= ACQ_HIGH_HZ
        for (b in 1 until pw.size - 1) if (reach(b) && pw[b] >= pw[b - 1] && pw[b] >= pw[b + 1] && !idle(b) && (best < 0 || pw[b] > pw[best])) best = b
        if (best < 0 || pw[best] < med * 10.0.pow(ACQ_MIN_DB / 10)) return
        val q = nn.toDouble() / have
        val linePow = pw[best] / g2 * q * q
        if (needPow > 0 && linePow < needPow) return
        val l = ln(pw[best - 1] + 1e-12); val c = ln(pw[best] + 1e-12); val rr = ln(pw[best + 1] + 1e-12); val den = l - 2 * c + rr
        val hz = (best - r + (if (den < 0) 0.5 * (l - rr) / den else 0.0)) * binHz
        // a check while holding takes over only for a different line
        if (elsewhere && this.have && abs(hz - this.hz) <= TRACK_BW_HZ) return
        if (this.have) switches++
        changes.add(CarrierChange(ms, hz))
        setHz(hz); this.have = true; cr = 0.0; ci = 0.0; lr = 0.0; li = 0.0
        lvl = sqrt(linePow); peak = lvl; lowMs = 0.0; sinceCheck = 0.0
    }

    private fun p2(x: Float, y: Float): Double { val a = x.toDouble(); val b = y.toDouble(); return a * a + b * b }

    /** The carrier's frequency over the keyup: the median of the 100 ms readings. */
    fun offset(): Double { if (log.size < 3) return Double.NaN; val s = log.sorted(); return s[s.size / 2] }
}
