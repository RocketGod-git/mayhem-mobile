package com.rocketgod.mayhem.core

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The HF comb notch (web: hfcomb.ts). Both sites' receivers (a HackRF Pro and an RTL-SDR, in two buildings) hear
 * narrow steady lines at exact multiples of 16.000 kHz in RF across HF, from an outside, precisely clocked source
 * (likely network gear): each 0.2 Hz wide, within a few Hz of n x 16 kHz (the radio's own tuning leftover, the same for
 * every line at one tuning). They show as steady lines in the waterfall and as tones in the audio.
 *
 * A channel's complex baseband goes through here before it is demodulated. Each n x 16 kHz inside the channel's band
 * (below 30 MHz only) is measured on its own: mixed to DC, low-passed (fourth-order Butterworth, 70 Hz) and sampled at
 * 256 Hz, then a 2 s spectrum (Hann, 0.5 Hz a bin) every second, the last 16 kept. Each bin is the mean of its quietest
 * two thirds over them: the idle seconds, so a talker or an FT8 signal that comes and goes drops out of it. A line is
 * there when the strongest bin within 10 Hz of n x 16 kHz stands 6 dB over the median of the bins 12 to 60 Hz either
 * side (10 dB from the 4th spectrum until 11 are in: with fewer, noise alone reaches 8 dB), and a new one is narrow, 6 dB
 * over the bins 2.5 to 7 Hz from it (a voice sitting on the grid point is not), and steady, moving from spectrum to
 * spectrum no more than noise moves it (an FT8 tone is a narrow line too, but comes and goes). Its frequency is read
 * between bins by a parabola. Only a line found is notched, by a one-pole complex notch 1 Hz wide (-3 dB at 0.5 Hz
 * either side), so a tone 3 Hz away loses 0.1 dB. A line missing from two measurements running is let go.
 */
class HfComb(
    val fs: Double,
    /** Lines this far either side of the baseband's center are measured. */
    val maxHz: Double,
    /** One line when the lines notched change. */
    private val log: ((String) -> Unit)? = null,
    /** A line this near the center is never notched (where a station's own carrier would be). */
    val clearHz: Double = 0.0,
    /** Shared by the channels of one span (Repeaters: a demodulator lives only as long as a transmission). */
    private val memory: Memory? = null,
) {
    class Memory {
        var lo = Double.NaN
        val lines = LinkedHashMap<Long, Pair<Double, Double>>()   // n -> (offset Hz, dB)
        var said = ""
    }

    data class Found(val rfHz: Double, val offsetHz: Double, val db: Double)

    /** A two-pole Butterworth low-pass section (bilinear), in double precision. */
    internal class Lp2(hz: Double, fs: Double, q: Double) {
        private val b0: Double; private val b1: Double; private val b2: Double; private val a1: Double; private val a2: Double
        private var z1 = 0.0; private var z2 = 0.0
        init {
            val w = 2 * PI * hz / fs; val c = cos(w); val s = sin(w); val al = s / (2 * q); val a0 = 1 + al
            b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = b0; a1 = -2 * c / a0; a2 = (1 - al) / a0
        }
        fun step(x: Double): Double { val y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y }
    }

    inner class Line(val n: Long) {
        var f0 = 0.0
        var mr = 1.0; var mi = 0.0; var dr = 1.0; var di = 0.0
        internal val li = arrayOf(Lp2(LP_HZ, fs, 0.5412), Lp2(LP_HZ, fs, 1.3066))
        internal val lq = arrayOf(Lp2(LP_HZ, fs, 0.5412), Lp2(LP_HZ, fs, 1.3066))
        val ri = FloatArray(MEAS_N); val rq = FloatArray(MEAS_N); var w = 0; var got = 0; var hop = 0
        val specs = ArrayList<FloatArray>()
        val meds = ArrayList<Double>()
        var on = false; var hz = 0.0; var db = 0.0; var miss = 0
        var nr = 1.0; var ni = 0.0; var ndr = 1.0; var ndi = 0.0; var er = 0.0; var ei = 0.0
    }

    private var lo = Double.NaN; private var rf = Double.NaN
    var lines: List<Line> = emptyList(); private set
    private val a = 1 - exp(-2 * PI * NOTCH_HALF_HZ / fs)
    private var dec = 0.0; private val decStep = MEAS_RATE / fs
    private val win = FloatArray(MEAS_N) { (0.5 - 0.5 * cos(2 * PI * it / MEAS_N)).toFloat() }
    // the low-pass's droop over the bins measured, taken back out (fourth-order Butterworth: 1 / (1 + (f/fc)^8))
    private val comp = FloatArray(MEAS_N) { b -> val f = (b - MEAS_N / 2) * MEAS_RATE / MEAS_N; (1 + (f / LP_HZ).pow(8)).toFloat() }
    private val re = FloatArray(MEAS_N); private val im = FloatArray(MEAS_N)
    private var said = ""
    private var renorm = 0

    /** Lines notched now (RF frequency, offset from n x 16 kHz, how far over the local median). */
    fun found(): List<Found> = lines.filter { it.on }.map { Found(it.n * STEP_HZ + it.hz, it.hz, it.db) }
    /** Whether any line could be here at all (some n x 16 kHz inside the band, under 30 MHz). */
    val active: Boolean get() = lines.isNotEmpty()

    /**
     * The radio's LO and the baseband center's offset from it (Hz). A new LO starts over (the radio's few-Hz tuning
     * leftover changes with it); moving the channel keeps what was measured on the lines still inside the band.
     */
    fun tune(loHz: Double, offsetHz: Double) {
        val f = loHz + offsetHz
        if (loHz == lo && f == rf) return
        if (loHz != lo) { lines = emptyList(); lo = loHz }
        rf = f
        val mem = memory
        if (mem != null && mem.lo != loHz) { mem.lo = loHz; mem.lines.clear(); mem.said = "" }
        val first = max(1L, ceil((f - maxHz) / STEP_HZ).toLong()); val last = floor((f + maxHz) / STEP_HZ).toLong()
        val keep = ArrayList<Line>()
        var n = first
        while (n <= last) {
            if (n * STEP_HZ >= TOP_HZ) break
            val l = lines.firstOrNull { it.n == n } ?: Line(n).also { nl -> mem?.lines?.get(n)?.let { nl.on = true; nl.hz = it.first; nl.db = it.second } }
            l.f0 = n * STEP_HZ - f
            val w = -2 * PI * l.f0 / fs; l.dr = cos(w); l.di = sin(w)
            setNotch(l)
            keep.add(l); n++
        }
        lines = keep
    }

    private fun setNotch(l: Line) { val w = 2 * PI * (l.f0 + l.hz) / fs; l.ndr = cos(w); l.ndi = sin(w) }

    /** Interleaved I/Q, in place. */
    fun processInterleaved(buf: FloatArray, n: Int) {
        if (lines.isEmpty()) return
        for (i in 0 until n) { step(buf[2 * i].toDouble(), buf[2 * i + 1].toDouble()); buf[2 * i] = oR.toFloat(); buf[2 * i + 1] = oI.toFloat() }
    }
    /** Separate I and Q, in place. */
    fun processSplit(bi: FloatArray, bq: FloatArray, n: Int) {
        if (lines.isEmpty()) return
        for (i in 0 until n) { step(bi[i].toDouble(), bq[i].toDouble()); bi[i] = oR.toFloat(); bq[i] = oI.toFloat() }
    }

    private var oR = 0.0; private var oI = 0.0
    private fun step(xr: Double, xi: Double) {
        dec += decStep
        val take = dec >= 1; if (take) dec -= 1
        val norm = ++renorm >= 4096; if (norm) renorm = 0
        var yr = xr; var yi = xi
        for (l in lines) {
            // measured on what came in
            val zr = xr * l.mr - xi * l.mi; val zi = xr * l.mi + xi * l.mr
            val fr = l.li[1].step(l.li[0].step(zr)); val fi = l.lq[1].step(l.lq[0].step(zi))
            run { val t = l.mr * l.dr - l.mi * l.di; l.mi = l.mr * l.di + l.mi * l.dr; l.mr = t }
            if (take) sample(l, fr.toFloat(), fi.toFloat())
            if (l.on) {
                // the line turned to DC, its one-pole estimate, turned back and taken out
                val ur = yr * l.nr + yi * l.ni; val ui = yi * l.nr - yr * l.ni
                l.er += a * (ur - l.er); l.ei += a * (ui - l.ei)
                yr -= l.er * l.nr - l.ei * l.ni; yi -= l.er * l.ni + l.ei * l.nr
            }
            run { val t = l.nr * l.ndr - l.ni * l.ndi; l.ni = l.nr * l.ndi + l.ni * l.ndr; l.nr = t }
            if (norm) {
                val g = 1 / hypot(l.mr, l.mi); l.mr *= g; l.mi *= g
                val h = 1 / hypot(l.nr, l.ni); l.nr *= h; l.ni *= h
            }
        }
        oR = yr; oI = yi
    }

    private fun sample(l: Line, i: Float, q: Float) {
        l.ri[l.w] = i; l.rq[l.w] = q; l.w = (l.w + 1) % MEAS_N
        if (l.got < MEAS_N) l.got++
        if (++l.hop < MEAS_HOP || l.got < MEAS_N) return
        l.hop = 0
        val nn = MEAS_N
        for (k in 0 until nn) { val j = (l.w + k) % nn; re[k] = l.ri[j] * win[k]; im[k] = l.rq[j] * win[k] }
        Dsp.fft(re, im)
        val s = FloatArray(nn)
        for (k in 0 until nn) { val b = (k + nn / 2) % nn; s[b] = (re[k] * re[k] + im[k] * im[k]) * comp[b] }
        val loB = (LOCAL_LO_HZ * nn / MEAS_RATE).roundToInt(); val hiB = (LOCAL_HI_HZ * nn / MEAS_RATE).roundToInt()
        val loc = ArrayList<Float>(); for (d in loB..hiB) { loc.add(s[nn / 2 + d]); loc.add(s[nn / 2 - d]) }
        loc.sort()
        l.specs.add(s); l.meds.add(loc[loc.size / 2].toDouble().takeIf { it > 0 } ?: 1e-30)
        if (l.specs.size > KEEP) { l.specs.removeAt(0); l.meds.removeAt(0) }
        if (l.specs.size >= MIN) judge(l)
    }

    /** Is the line there, on the idle part of the spectra kept? */
    private fun judge(l: Line) {
        val nn = MEAS_N; val c = nn / 2; val perHz = nn / MEAS_RATE; val k = l.specs.size; val use = k - k / 3
        val hiB = (LOCAL_HI_HZ * perHz).roundToInt(); val loB = (LOCAL_LO_HZ * perHz).roundToInt(); val srch = (SEARCH_HZ * perHz).roundToInt()
        val quiet = DoubleArray(2 * hiB + 1); val col = DoubleArray(k)
        for (d in -hiB..hiB) {
            for (j in 0 until k) col[j] = l.specs[j][c + d].toDouble()
            col.sort(); var sum = 0.0; for (j in 0 until use) sum += col[j]
            quiet[d + hiB] = sum / use
        }
        val local = ArrayList<Double>(); for (d in loB..hiB) { local.add(quiet[hiB + d]); local.add(quiet[hiB - d]) }
        local.sort()
        val med = local[local.size / 2].takeIf { it > 0 } ?: 1e-30
        var pk = -srch; for (d in -srch..srch) if (quiet[d + hiB] > quiet[pk + hiB]) pk = d
        val over = 10 * log10(quiet[pk + hiB] / med)
        val near = ArrayList<Double>(); val nLo = (NEAR_LO_HZ * perHz).roundToInt(); val nHi = (NEAR_HI_HZ * perHz).roundToInt()
        for (d in nLo..nHi) { near.add(quiet[hiB + pk + d]); near.add(quiet[hiB + pk - d]) }
        near.sort()
        val narrow = 10 * log10(quiet[pk + hiB] / (near[near.size / 2].takeIf { it > 0 } ?: 1e-30)) > OVER_DB
        // and steady: its level in each spectrum (over that spectrum's median) moves no more than noise moves a line that
        // strong, about sqrt(2 / level) of it (an FT8 tone, which CPFSK also makes a narrow line, comes and goes)
        var sum = 0.0; var sq = 0.0
        for (j in 0 until k) { val sp = l.specs[j]; val v = maxOf(sp[c + pk - 1], sp[c + pk], sp[c + pk + 1]) / l.meds[j]; sum += v; sq += v * v }
        val mean = sum / k; val sd = sqrt(max(0.0, sq / k - mean * mean))
        val steady = sd < mean * max(STEADY_MIN, STEADY_K * sqrt(2 / mean))
        val need = if (k >= FULL) OVER_DB else OVER_EARLY_DB
        var hz = pk / perHz
        if (pk > -srch && pk < srch) {
            val ya = ln(quiet[pk - 1 + hiB] + 1e-30); val yb = ln(quiet[pk + hiB] + 1e-30); val yc = ln(quiet[pk + 1 + hiB] + 1e-30); val den = ya - 2 * yb + yc
            if (den < 0) hz = (pk + 0.5 * (ya - yc) / den) / perHz
        }
        val was = l.on; val clear = abs(l.f0 + hz) >= clearHz
        // the stricter early level only turns a line on; one already notched stays while it stands 6 dB
        if (clear && ((over > need && narrow && steady) || (l.on && over > OVER_DB))) {
            l.hz = if (l.on) 0.5 * (l.hz + hz) else hz; l.db = over; l.miss = 0; l.on = true
            memory?.lines?.put(l.n, l.hz to l.db)
        } else if (l.on && ++l.miss >= MISS) { l.on = false; l.er = 0.0; l.ei = 0.0; memory?.lines?.remove(l.n) }
        if (l.on) setNotch(l)
        if (was != l.on) report()
    }

    private fun report() {
        val lg = log ?: return
        val all = memory?.lines?.map { (n, v) -> Found(n * STEP_HZ + v.first, v.first, v.second) } ?: found()
        val text = if (all.isEmpty()) "HF comb: no lines at n x 16 kHz now" else {
            val top = all.maxByOrNull { it.db }!!
            "HF comb: ${all.size} line${if (all.size > 1) "s" else ""} at n x 16 kHz notched, strongest %.3f MHz %.0f dB over the floor (offset %s%.1f Hz)".format(
                java.util.Locale.US, top.rfHz / 1e6, top.db, if (top.offsetHz >= 0) "+" else "", top.offsetHz)
        }
        val last = memory?.said ?: said
        // the first "none" is not news: only say so once lines were notched
        if (text == last || (all.isEmpty() && last.isEmpty())) return
        if (memory != null) memory.said = text else said = text
        lg(text)
    }

    companion object {
        const val STEP_HZ = 16_000L
        /** Nothing at or above this RF frequency is measured or notched. */
        const val TOP_HZ = 30_000_000.0
        const val MEAS_RATE = 256.0; const val MEAS_N = 512; const val MEAS_HOP = 256; const val KEEP = 16; const val MIN = 4; const val FULL = 11
        const val SEARCH_HZ = 10.0; const val LOCAL_LO_HZ = 12.0; const val LOCAL_HI_HZ = 60.0
        /** A new line is narrow: 6 dB over the median of the bins 2.5 to 7 Hz either side of its peak. */
        const val NEAR_LO_HZ = 2.5; const val NEAR_HI_HZ = 7.0
        /** And steady: its spread over the spectra kept under this share of its level, or this many times what noise gives. */
        const val STEADY_MIN = 0.35; const val STEADY_K = 1.5
        const val OVER_DB = 6.0; const val OVER_EARLY_DB = 10.0
        const val NOTCH_HALF_HZ = 0.5; const val LP_HZ = 70.0; const val MISS = 2
    }
}
