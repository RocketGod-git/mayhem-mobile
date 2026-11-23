package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.ham.RealFir
import com.rocketgod.mayhem.core.ham.Resampler
import com.rocketgod.mayhem.core.ham.lowpassTaps
import com.rocketgod.mayhem.core.hamplus.CLIP_RATE
import com.rocketgod.mayhem.core.hamplus.ClipWriter
import com.rocketgod.mayhem.core.hamplus.ENV_MS
import com.rocketgod.mayhem.core.hamplus.ProbeOffset
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
const val CARRIER_HELD = 0.8
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
    private var notches: List<LineNotch> = emptyList(); private var otherNotches: List<LineNotch> = emptyList()
    private var pending: List<Double> = emptyList(); private var notchedFor = Double.NaN; private var sw = -1
    private val to8: Resampler; private val to48: Resampler
    private val uI: RealFir; private val uQ: RealFir; private val lI: RealFir; private val lQ: RealFir
    private var ui = FloatArray(0); private var uq = FloatArray(0); private var uli = FloatArray(0); private var ulq = FloatArray(0)
    private var uti = FloatArray(0); private var utq = FloatArray(0); private var usi = FloatArray(0); private var usq = FloatArray(0)
    private val hp: List<Biquad>; private val lpA: List<Biquad>; private val ssbP: List<Biquad>; private val den: Denoiser
    private var pi = 1.0; private var pq = 0.0; private var wu = 0.0; private var wl = 0.0; private var wb = 0.0; private var gate = 0.0; private var lastHop = 0
    private var up = 0.0; private var lo = 0.0; private var upOff = 0.0; private var loOff = 0.0; private var nOff = 0; private var eS = 0.0; private var eS2 = 0.0; private var eN = 0
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
        val side = up + lo > 0 && max(up, lo) >= SSB_RATIO * min(up, lo)
        val sideOff = nOff >= fs * 0.1 && max(upOff, loOff) >= SSB_RATIO * min(upOff, loOff)
        val q = t.medianQ()
        val carrier = (t.have || t.log.size >= 10) && !(q < SQUELCH_DB) && held >= CARRIER_HELD && (t.heldHops >= 100 || !sideOff)
        if (carrier) { val f = flatness(); return if (f.isFinite() && f < FLAT_FM) CbMode.FM else CbMode.AM }
        if (side) return if (up > lo) CbMode.USB else CbMode.LSB
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
            // how the energy splits either side of the center, over the keyup
            up += ti * ti + tq * tq; lo += si * si + sq * sq
            // and while a followed line is off (a carrier, off frequency, would tip the split by itself)
            if (trk.have && !trk.onNow) { upOff += ti * ti + tq * tq; loOff += si * si + sq * sq; nOff++ }
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
                wb += dbk
                // home levels it by its power over 0.3 s on both sides of each sample; streaming, the audio is held back by
                // the smoothing's own delay so its level is centered on it
                v = agcDelay(x)
            }
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
