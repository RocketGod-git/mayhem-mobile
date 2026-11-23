package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.ham.RealFir
import com.rocketgod.mayhem.core.ham.Resampler
import com.rocketgod.mayhem.core.ham.lowpassTaps
import com.rocketgod.mayhem.core.hamplus.CLIP_RATE
import com.rocketgod.mayhem.core.hamplus.ClipWriter
import com.rocketgod.mayhem.core.hamplus.ENV_MS
import com.rocketgod.mayhem.core.hamplus.ProbeOffset
import com.rocketgod.mayhem.core.hamplus.RatioSpeech
import com.rocketgod.mayhem.core.hamplus.WatchProbe
import com.rocketgod.mayhem.core.trains.Ddc
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * One CB channel's demodulator: home's method (see Carrier.kt), the mode found from the transmission or set by hand.
 *
 * Down-converted to about 16 kS/s, the idle lines the engine measured are notched (12 Hz wide, never within 30 Hz of
 * the carrier, so only once the carrier is known), and the carrier tracker finds and holds a station's carrier.
 *  - A carrier held: AM, or FM when its envelope is flat; readable when its median q is 22 dB or more.
 *  - None: single sideband, the side of the center (300 to 3000 Hz) with 4 times the other's energy (6 dB),
 *    demodulated by the Weaver method and leveled by its own 0.3 s power.
 * Audio is 300 to 3000 Hz (fourth-order each way), clipped at 3, faded in and out over 15 ms where the carrier comes
 * and goes, and gently denoised (home's smoothed gain, never under 0.35).
 *
 * The carrier's offset tells AM and FM talkers apart; SSB has no carrier to read. Twin of web dsp/cb/probe.ts.
 */

const val CB_PROBE_RATE = 16_000.0
/** The Weaver shift: a sideband 300 to 3000 Hz from the carrier is centered at 1650 Hz and kept 1350 Hz either side. */
const val SSB_MID_HZ = 1_650.0
const val SSB_HALF_HZ = 1_350.0
/** Single sideband: one side holds this many times the other's energy (6 dB). */
const val SSB_RATIO = 4.0
/** A carrier stands 15 dB over the median through this share of its keyup, once held a second (real AM 0.84 to 1, a
 *  sideband voice followed as if a carrier 0.34 to 0.81, on home's recordings). */
const val CARRIER_HELD = 0.6
/** Our sideband guard: steady lines stand [TONE_DB] over their neighborhood, and may hold at most [TONE_SHARE]. */
const val TONE_DB = 20.0
const val TONE_SHARE = 0.5
private val TONE_X = Math.pow(10.0, TONE_DB / 10)
private const val SIDE_BAND = 25.0
private const val SIDE_FROM = 300.0
private const val SIDE_TO = 3_000.0
private const val EDGE_FROM = 3_200.0
private const val EDGE_TO = 4_800.0
private const val TONE_CARRIER_HZ = 40.0
/** SSB's level is its power over this long (s). */
const val SSB_AGC_S = 0.3
/** Audio is clipped here (the carrier's level is 1), and faded in and out over this long (ms). */
const val AUDIO_CLIP = 3.0
const val RAMP_MS = 15.0
/** How the demodulated audio is scaled to the clip and the speaker. */
private const val OUT_GAIN = 0.35
private const val OFF_WIN_MS = 100.0
private const val TWO_PI = 2 * PI

class CbProbe(inRate: Double, val offsetHz: Double) : WatchProbe {
    private val ddc = Ddc(4_500.0, CB_PROBE_RATE, 63)
    val fs: Double
    override val clip = ClipWriter()
    override val means = ArrayList<Double>()
    override val env = ArrayList<Float>()
    private var oi = FloatArray(0); private var oq = FloatArray(0); private var au = FloatArray(0); private var au2 = FloatArray(0); private var a8 = FloatArray(0)
    override var a48 = FloatArray(0); private set
    override var out48 = 0; private set
    override var levelDb = -90.0; private set
    override val cw0 = ""
    /** The mode set by hand (null lets the measurement choose), the clarifier for SSB (Hz), and the mode before any measurement. */
    var manual: CbMode? = null
    var clarHz = 0.0
    var guess = CbMode.AM
    /** The channel's noise as the engine measures it (kept for the engine; home's method needs no noise figure). */
    var noiseRatio = 0.0
    var noiseVarIn = 0.0
    /** How each 10 ms of the transmission measured, by [CbMode.ordinal], for the card and the tests. */
    val votes = IntArray(4)
    /** The carrier, found and held. */
    val trk: CarrierTracker
    /** Whether the audio carries a voice (Speech.kt): only this measure, on what the demodulator already makes, is new
     *  here; the demodulator and its audio are home's. */
    override val speech: RatioSpeech
    private val spI: List<Biquad>; private val spQ: List<Biquad>
    private var notches: List<LineNotch> = emptyList(); private var otherNotches: List<LineNotch> = emptyList()
    private var pending: List<Double> = emptyList(); private var notchedFor = Double.NaN; private var sw = -1
    private val to8: Resampler; private val to48: Resampler
    private val uI: RealFir; private val uQ: RealFir; private val lI: RealFir; private val lQ: RealFir
    private var ui = FloatArray(0); private var uq = FloatArray(0); private var uli = FloatArray(0); private var ulq = FloatArray(0)
    private var uti = FloatArray(0); private var utq = FloatArray(0); private var usi = FloatArray(0); private var usq = FloatArray(0)
    private val hp: List<Biquad>; private val lpA: List<Biquad>; private val ssbP: List<Biquad>; private val den: Denoiser
    private var pi = 1.0; private var pq = 0.0; private var wu = 0.0; private var wl = 0.0; private var wb = 0.0; private var gate = 0.0; private var lastHop = 0
    private var eS = 0.0; private var eS2 = 0.0; private var eN = 0
    private val eBlocks = ArrayList<DoubleArray>()
    private var notCarrier = false
    private val dl: FloatArray; private var dn = 0
    private var offAcc = 0.0; private var offN = 0; private var envAcc = 0.0; private var envN = 0; private var hpE = 0.0; private var pow = 0.0; private var powN = 0
    /**
     * The engine reads idle lines on bins of 150 to 250 Hz; a 12 Hz notch needs them to a few Hz, as home measured them
     * (1 s spectra). The first half second here is looked at in one spectrum (2 Hz bins), where a steady line is a sharp
     * peak whatever a voice does around it, and each line is put on the strongest bin within 150 Hz of the engine's
     * reading. Until then nothing is notched or ignored.
     */
    private var coarse: List<Int> = emptyList(); private var lineN = 0; private var lineI = FloatArray(0); private var lineQ = FloatArray(0)

    init {
        ddc.reset(inRate); ddc.offsetHz = offsetHz; fs = ddc.outRate
        val w = lowpassTaps(SSB_HALF_HZ / fs, 63)
        uI = RealFir(w); uQ = RealFir(w); lI = RealFir(w); lQ = RealFir(w)
        to8 = Resampler(CLIP_RATE / fs); to48 = Resampler(48_000 / fs)
        trk = CarrierTracker(fs)
        // home's filters run forward and back, squaring their response; here each runs twice forward
        hp = butter4(false, 300.0, fs) + butter4(false, 300.0, fs); lpA = butter4(true, 3_000.0, fs) + butter4(true, 3_000.0, fs)
        ssbP = twice(true, 1 / SSB_AGC_S, fs)
        // a two-pole Butterworth's delay at low frequencies is sqrt(2) / (2 pi fc), twice that here
        dl = FloatArray(max(1, (2 * fs * sqrt(2.0) / (2 * PI / SSB_AGC_S)).roundToInt()))
        den = Denoiser(fs)
        speech = RatioSpeech(fs)
        spI = butter4(false, 300.0, fs) + butter4(true, 3_000.0, fs); spQ = butter4(false, 300.0, fs) + butter4(true, 3_000.0, fs)
    }

    /** The envelope's spread over its mean while the carrier was on (home's FM test: under 0.12). */
    fun flatness(): Double {
        // over the last two seconds (the first moments after a notch is set leave a line's beat in it)
        var s = eS; var s2 = eS2; var n = eN.toDouble(); for (b in eBlocks) { s += b[0]; s2 += b[1]; n += b[2] }
        if (n < 100) return Double.NaN; val m = s / n; return sqrt(max(0.0, s2 / n - m * m)) / (m + 1e-9)
    }
    /** SSB and FM leveled as home does: over its power over 0.3 s, times 3, the audio held back to center the level on it. */
    private fun agcDelay(x: Double): Double {
        val p = run(ssbP, x * x); val y = dl[dn].toDouble(); dl[dn] = x.toFloat(); if (++dn >= dl.size) dn = 0
        return y / (sqrt(max(1e-12, p)) * 3)
    }

    override fun retune(offsetHz: Double) { ddc.offsetHz = offsetHz }
    /** The lines the engine measured on the idle channel: notched once the carrier is known, and never taken for one. */
    fun setNotches(hz: List<Int>) { coarse = hz; pending = emptyList(); trk.ignore = emptyList(); notches = emptyList(); notchedFor = Double.NaN; lineN = 0 }
    private fun refineLines() {
        val n = lineI.size; val re = lineI.copyOf(); val im = lineQ.copyOf(); val w = hannSym(n)
        for (k in 0 until n) { re[k] *= w[k]; im[k] *= w[k] }
        Dsp.fft(re, im)
        val bh = fs / n
        pending = coarse.map { h ->
            var best = -1; var bp = -1.0
            for (b in ((h - 150) / bh).roundToInt()..((h + 150) / bh).roundToInt()) {
                val k = (b + n) % n; val x = re[k].toDouble(); val y = im[k].toDouble(); val p = x * x + y * y
                if (p > bp) { bp = p; best = b }
            }
            best * bh
        }
        trk.ignore = pending; notchedFor = Double.NaN
    }
    val notchHz: List<Double> get() = notches.map { it.hz }

    /*
     * Our guard on home's sideband rule, which the no-antenna recordings need: a receiver's own spurs come in bursts of
     * lines (on the Mac's HackRF, lines every 100 Hz 221.5 kHz below the tuning, 60 dB over the noise, on for seconds),
     * and a burst of them on one side passes home's split as a sideband. A voice's harmonics wander with its pitch and
     * smear over tens of Hz in half a second; a spur's lines stay put to a Hz. So on fine spectra (2 Hz bins, each half
     * second) the share of the 300 to 3000 Hz power over the noise that sits in bins [TONE_DB] over their neighborhood
     * must stay under [TONE_SHARE] for the keyup to be taken for single sideband.
     */
    private var tI = FloatArray(0); private var tQ = FloatArray(0); private var tN = 0
    private var toneIn = 0.0; private var toneAll = 0.0
    /** The power over the noise a Hz, 300 to 3000 Hz and 3200 to 4800 Hz from the center, above (0) and below (1). */
    private val edgeIn = DoubleArray(2); private val edgeOut = DoubleArray(2)
    /** The share of the sidebands' power in steady lines (the followed carrier left out), NaN before a half second. */
    val toneShare: Double get() = if (toneAll > 0) toneIn / toneAll else Double.NaN
    /** The power over the noise 300 to 3000 Hz above and below the followed carrier, over the keyup, and the noise. */
    private val carSide = DoubleArray(2); private var carNoise = 0.0; private var carBins = 0
    /** Whether the followed carrier's sidebands differ by [SSB_RATIO] or more, the louder over the noise. */
    fun lopsided(): Boolean {
        val u = carSide[0]; val l = carSide[1]; val big = max(u, l)
        return carBins > 0 && big >= SSB_RATIO * min(u, l) && big >= carNoise * carBins
    }
    /** Whether [side] holds more power a Hz just past the voice band (3.2 to 4.8 kHz) than in it: the skirt of something
     *  strong beyond the band, not a voice (a transmitter's audio stops near 3 kHz). */
    fun skirt(side: CbMode): Boolean { val j = if (side == CbMode.USB) 0 else 1; return edgeOut[j] > edgeIn[j] }
    private fun toneBlock() {
        val n = tI.size; val re = tI.copyOf(); val im = tQ.copyOf(); val w = hannSym(n)
        for (k in 0 until n) { re[k] *= w[k]; im[k] *= w[k] }
        Dsp.fft(re, im)
        fun p2(k: Int): Double { val x = re[k].toDouble(); val y = im[k].toDouble(); return x * x + y * y }
        val bh = fs / n; val g0 = max(1, (SIDE_BAND / bh).roundToInt()); val lo = (SIDE_FROM / bh).roundToInt(); val hi = (SIDE_TO / bh).roundToInt()
        val o0 = (EDGE_FROM / bh).roundToInt(); val o1 = min(n / 2 - 1, (EDGE_TO / bh).roundToInt())
        val car = if (trk.have) trk.hz else Double.NaN
        for (sgn in intArrayOf(1, -1)) {
            // band medians, then each bin against the median of the bands around it
            val pw = ArrayList<Double>(); for (b in lo..hi) { val k = (sgn * b + n) % n; pw.add(p2(k)) }
            val bm = ArrayList<Double>(); var g = 0; while (g < pw.size) { bm.add(median(pw.subList(g, min(pw.size, g + g0)))); g += g0 }
            val noise = bm.sorted()[bm.size / 5].let { if (it == 0.0 || it.isNaN()) 1e-20 else it }
            var inP = 0.0
            for (b in pw.indices) {
                val x = max(0.0, pw[b] - noise); inP += x
                if (abs(sgn * (b + lo) * bh - car) <= TONE_CARRIER_HZ) continue
                val gg = b / g0; val near = median(bm.subList(max(0, gg - 4), min(bm.size, gg + 5)))
                toneAll += x; if (pw[b] >= near * TONE_X) toneIn += x
            }
            var outP = 0.0; for (b in o0..o1) { val k = (sgn * b + n) % n; outP += max(0.0, p2(k) - noise) }
            val j = if (sgn > 0) 0 else 1; edgeIn[j] += inP / pw.size; edgeOut[j] += outP / max(1, o1 - o0 + 1)
            // around the carrier
            if (trk.have) {
                val c = (car / bh).roundToInt(); var sum = 0.0; var nb = 0
                // (a steady line, 20 dB over the bands around it, left out: a comb line beside a station is not its sideband)
                val cp = ArrayList<Double>(); for (b in lo..hi) { val k = ((c + sgn * b) % n + n) % n; cp.add(p2(k)) }
                val cm = ArrayList<Double>(); var gg = 0; while (gg < cp.size) { cm.add(median(cp.subList(gg, min(cp.size, gg + g0)))); gg += g0 }
                for (b in cp.indices) { val g2 = b / g0; nb++; if (cp[b] >= median(cm.subList(max(0, g2 - 4), min(cm.size, g2 + 5))) * TONE_X) continue; sum += max(0.0, cp[b] - noise) }
                carSide[j] += sum; if (j == 0) { carNoise += noise; carBins = nb }
            }
        }
    }

    /** What the measurement found: null until a carrier is held or a sideband stands out. */
    fun measuredMode(): CbMode? {
        // a carrier is a station's when it stands 22 dB over the median through the keyup (home skips one under that: on
        // single sideband a held voice harmonic looks like a carrier, but a weak one)
        // and it stays: a carrier stands 15 dB over the median through nearly all of its keyup, while a voice harmonic on
        // single sideband (followed as if it were one) comes and goes with the syllables
        // (once a followed line has failed that, a new one is not taken for a carrier until it has held a second itself)
        // (and before a line has been held that second, a clear sideband while it is off says it is single sideband: a
        // voice harmonic comes and goes with the voice on one side, and home, deciding on the whole keyup, never took such
        // a line for a carrier)
        val t = trk
        val held = if (t.heldHops >= 100) t.onHops.toDouble() / t.heldHops else if (notCarrier) 0.0 else 1.0
        if (t.heldHops >= 100 && held < CARRIER_HELD) notCarrier = true
        // (the split is home's, 300 to 3000 Hz either side, with its idle-line notches done another way, so the steady
        // lines of a nearby device, which home notched, cannot tip it: see CarrierTracker.side)
        val sideAll = t.side(false, SSB_RATIO); val side = sideAll != null
        val sideOff = t.side(true, SSB_RATIO) != null
        val q = t.medianQ()
        val carrier = (t.have || t.log.size >= 10) && !(q < SQUELCH_DB) && held >= CARRIER_HELD && (t.heldHops >= 100 || !sideOff)
        // (and a carrier is a station's when its two sidebands are alike, as AM's are: a receiver's own spur burst has a
        // strongest line too, with its other lines on one side of it)
        if (carrier && !lopsided()) { val f = flatness(); return if (f.isFinite() && f < FLAT_FM) CbMode.FM else CbMode.AM }
        if (side && !(toneShare >= TONE_SHARE) && !skirt(sideAll!!)) return sideAll
        return null
    }
    /** The mode demodulated now: by hand, else measured, else the channel's last. */
    fun mode(): CbMode = manual ?: measuredMode() ?: guess
    /** A readable station: a carrier standing 22 dB over the median through the keyup, or a clear sideband. */
    fun readable(): Boolean {
        val m = measuredMode()
        if (m == CbMode.AM || m == CbMode.FM) return trk.medianQ() >= SQUELCH_DB
        return m == CbMode.USB || m == CbMode.LSB
    }

    override fun push(fi: FloatArray, fq: FloatArray, n: Int, listen: Boolean) {
        val max = ddc.maxOut(n)
        if (oi.size < max) {
            oi = FloatArray(max); oq = FloatArray(max); au = FloatArray(max); au2 = FloatArray(max); a8 = FloatArray(max); a48 = FloatArray(ceil(48_000 / fs * max).toInt() + 16)  // 16 kS/s to 48: three times as many
            ui = FloatArray(max); uq = FloatArray(max); uli = FloatArray(max); ulq = FloatArray(max)
            uti = FloatArray(max); utq = FloatArray(max); usi = FloatArray(max); usq = FloatArray(max)
        }
        val m = ddc.push(fi, fq, n, oi, oq); val fs = fs; val oi = oi; val oq = oq; val trk = trk
        // every half second, a fine spectrum (2 Hz bins) for the tone share
        if (tI.isEmpty()) { var n2 = 1; while (n2 < fs / 2) n2 = n2 shl 1; tI = FloatArray(n2); tQ = FloatArray(n2) }
        for (i in 0 until m) { tI[tN] = oi[i]; tQ[tN] = oq[i]; if (++tN >= tI.size) { toneBlock(); tN = 0 } }
        if (coarse.isNotEmpty() && lineN >= 0) {
            if (lineI.isEmpty()) { var n2 = 1; while (n2 < fs / 2) n2 = n2 shl 1; lineI = FloatArray(n2); lineQ = FloatArray(n2) }
            var i = 0
            while (i < m && lineN < lineI.size) { lineI[lineN] = oi[i]; lineQ[lineN] = oq[i]; lineN++; i++ }
            if (lineN >= lineI.size) { refineLines(); lineN = -1 }
        }
        val md0 = measuredMode(); val ssb = md0 == CbMode.USB || md0 == CbMode.LSB
        if (ssb && notchedFor != -1e9) {
            // single sideband: only the idle lines (what looked like other carriers were voice)
            notchedFor = -1e9; notches = pending.map { LineNotch(it, fs) }; otherNotches = emptyList()
        } else if (!ssb && trk.have && (notchedFor.isNaN() || notchedFor == -1e9 || trk.switches != sw)) {
            // the idle lines, now the carrier is known (again when it changes), and the other stations' carriers
            notchedFor = trk.hz; sw = trk.switches
            notches = pending.filter { abs(it - trk.hz) > NOTCH_CLEAR_HZ }.map { LineNotch(it, fs) }
            otherNotches = trk.others.map { LineNotch(it, fs) }
        }
        for (c in notches) c.run(oi, oq, m)
        // the envelope's spread while the carrier is on, read before the other stations' carriers are notched (taking a
        // line out of an FM signal would make its envelope move)
        if (trk.have && trk.onNow) for (i in 0 until m) { val e = hypot(oi[i].toDouble(), oq[i].toDouble()); eS += e; eS2 += e * e; eN++ }
        if (eN >= fs / 10) { eBlocks.add(doubleArrayOf(eS, eS2, eN.toDouble())); if (eBlocks.size > 20) eBlocks.removeAt(0); eS = 0.0; eS2 = 0.0; eN = 0 }
        for (c in otherNotches) c.run(oi, oq, m)
        // the Weaver shifts: upper sideband down by clarifier + 1650 Hz, lower by clarifier - 1650 Hz
        val du = -TWO_PI * (clarHz + SSB_MID_HZ) / fs; val dl0 = -TWO_PI * (clarHz - SSB_MID_HZ) / fs
        for (i in 0 until m) {
            val a = oi[i].toDouble(); val b = oq[i].toDouble()
            val cu = cos(wu); val su = sin(wu); val cl = cos(wl); val sl = sin(wl)
            ui[i] = (a * cu - b * su).toFloat(); uq[i] = (a * su + b * cu).toFloat(); uli[i] = (a * cl - b * sl).toFloat(); ulq[i] = (a * sl + b * cl).toFloat()
            wu += du; wl += dl0
        }
        wu %= TWO_PI; wl %= TWO_PI
        uI.process(ui, m, uti); uQ.process(uq, m, utq); lI.process(uli, m, usi); lQ.process(ulq, m, usq)
        var mode = mode()
        val au = au; val win = (fs * OFF_WIN_MS / 1000).roundToInt(); val dbk = TWO_PI * SSB_MID_HZ / fs; val rampN = fs * RAMP_MS / 1000
        for (i in 0 until m) {
            val a = oi[i].toDouble(); val b = oq[i].toDouble()
            val f = atan2(b * pi - a * pq, a * pi + b * pq)
            pi = a; pq = b
            offAcc += f; if (++offN >= win) { means.add(offAcc / offN * fs / TWO_PI); offAcc = 0.0; offN = 0 }
            trk.step(a, b)
            val ti = uti[i].toDouble(); val tq = utq[i].toDouble(); val si = usi[i].toDouble(); val sq = usq[i].toDouble()
            if ((i and 63) == 0) mode = mode()
            var v: Double; var on = true
            if (mode == CbMode.AM || mode == CbMode.FM) {
                on = trk.have && trk.present
                // FM: the phase step, leveled by its own power over 0.3 s as SSB is
                if (mode == CbMode.FM) v = agcDelay(f)
                else {
                    // carrier-locked: the part in line with the carrier phasor, over its level (floored at 0.15 of its middle)
                    val cm = hypot(trk.cr, trk.ci); val l = max(trk.lvl, trk.floor())
                    v = if (cm > 0 && l > 0) (trk.br * trk.cr + trk.bi * trk.ci) / cm / l else 0.0
                }
            } else {
                // the sideband's real part, back up by 1650 Hz, over its own power over 0.3 s (times 3, as home's)
                val s = if (mode == CbMode.USB) 1 else -1; val c = cos(wb); val sn = sin(s * wb)
                val x = if (mode == CbMode.USB) ti * c - tq * sn else si * c - sq * sn
                val pu = ti * ti + tq * tq; val pl = si * si + sq * sq
                if (!(trk.have && trk.present)) speech.push(if (mode == CbMode.USB) pu else pl, if (mode == CbMode.USB) pl else pu, 2)
                wb += dbk
                // home levels it by its power over 0.3 s on both sides of each sample; streaming, the audio is held back by
                // the smoothing's own delay so its level is centered on it
                v = agcDelay(x)
            }
            // the speech measure, while a carrier is held whatever the mode: the signal in line with it and at right angles
            if (trk.have && trk.present) {
                val cm = hypot(trk.cr, trk.ci); val l = max(trk.lvl, trk.floor())
                val x = if (cm > 0 && l > 0) (trk.br * trk.cr + trk.bi * trk.ci) / cm / l else 0.0
                val y = if (cm > 0 && l > 0) (trk.bi * trk.cr - trk.br * trk.ci) / cm / l else 0.0
                val si2 = run(spI, x); val sq2 = run(spQ, y); speech.push(si2 * si2, sq2 * sq2, 1)
            } else if (mode == CbMode.AM || mode == CbMode.FM) speech.push(0.0, 0.0, 0)
            // 300 to 3000 Hz, clipped at 3, faded in and out where the carrier comes and goes
            for (h in hp) v = h.step(v)
            for (h in lpA) v = h.step(v)
            v = max(-AUDIO_CLIP, min(AUDIO_CLIP, v))
            gate = if (on) min(rampN, gate + 1) else max(0.0, gate - 1)
            val g = 0.5 - 0.5 * cos(PI * gate / rampN)
            au[i] = (v * g * OUT_GAIN).toFloat()
            pow += a * a + b * b; powN++
        }
        wb %= TWO_PI
        // a measurement a 10 ms, for the card and the tests
        if (trk.log.size != lastHop) { val k = trk.log.size - lastHop; lastHop = trk.log.size; val md = measuredMode(); if (md != null) votes[md.ordinal] += k }
        else { val md = measuredMode(); if (md == CbMode.USB || md == CbMode.LSB) votes[md.ordinal]++ }
        den.process(au, m, au2)
        val a2 = au2; val envWin = (fs * ENV_MS / 1000).roundToInt(); val hpa = 1 - exp(-2 * PI * 300 / fs)
        for (i in 0 until m) {
            hpE += hpa * (a2[i] - hpE); val vv = a2[i] - hpE
            envAcc += vv * vv; if (++envN >= envWin) { env.add(sqrt(envAcc / envN).toFloat()); envAcc = 0.0; envN = 0 }
        }
        val k8 = to8.process(a2, m, a8); clip.push(a8, k8)
        out48 = if (listen) to48.process(a2, m, a48) else 0
        if (powN > fs / 10) { levelDb = 10 * log10(pow / powN + 1e-9); pow = 0.0; powN = 0 }
    }

    /** Carrier offset: the held carrier's median frequency; for FM without one, the discriminator's; none for SSB. */
    override fun offset(skip: Int): ProbeOffset {
        val m = manual ?: measuredMode()
        if (m == CbMode.USB || m == CbMode.LSB) return ProbeOffset(Double.NaN, 0.0)
        val t = trk.offset(); if (t.isFinite()) return ProbeOffset(t, 0.0)
        if (means.size - skip < 3) return ProbeOffset(Double.NaN, 0.0)
        val s = means.subList(skip, means.size).sorted()
        val med = s[s.size / 2]; val q1 = s[s.size / 4]; val q3 = s[s.size * 3 / 4]
        return ProbeOffset(med, (q3 - q1) / 1.35 / sqrt(s.size.toDouble()))
    }
    override fun tone(): Double = 0.0
    override fun dcs(): Int = 0
    /** The transmission ended: its kept audio fades out over 15 ms. */
    override fun end() { clip.fadeOut((CLIP_RATE * RAMP_MS / 1000).roundToInt()) }
}
