package com.rocketgod.mayhem.core.cb

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
 * One CB channel's demodulator: AM, FM, USB or LSB, chosen by hand or by what the transmission measures.
 *
 * Every 100 ms block of the channel (down-converted to about 16 kS/s) is measured:
 *  - the carrier: the power that stays put at the carrier frequency (10 ms averages of the signal turned to DC by the
 *    carrier offset the discriminator reads), as a share of all the power. AM keeps at least two thirds of its power
 *    in the carrier; single sideband has none;
 *  - what is left once the carrier is taken out, split into the part in line with the carrier and the part across it.
 *    AM moves only the carrier's size, so its remainder lies in line; FM moves its phase, across; single sideband
 *    (and noise) turns all the way round, half and half. A single sideband tone looks like a carrier, this does not;
 *  - the envelope: how much |z| moves in the voice band against its mean, less what the channel's noise alone would
 *    move it. AM carries the voice there; FM keeps a constant envelope;
 *  - the sidebands: the power 300 to 3000 Hz above the carrier against the same below (each by the Weaver method, the
 *    same filters that demodulate SSB). Single sideband has its energy on one side; AM and FM on both.
 * A block with the voice in it votes, and the transmission's mode is the one with most votes.
 *
 * The carrier offset (the median of the discriminator's 100 ms means) tells AM and FM talkers apart, as HAM+ does for
 * FM; SSB has no carrier to read, so its offset is not measured. Twin of web dsp/cb/probe.ts.
 */

const val CB_PROBE_RATE = 16_000.0
/** The Weaver shift: a sideband 300 to 3000 Hz from the carrier is centered at 1650 Hz and kept 1350 Hz either side. */
const val SSB_MID_HZ = 1_650.0
const val SSB_HALF_HZ = 1_350.0
/** Votes: SSB has this much more on one side (dB), and its remainder is not in line with a carrier. */
const val SSB_SIDE_DB = 10.0
/** SSB's envelope follows the voice all the way (a carrier between words does not, so an AM pause casts no SSB vote). */
const val SSB_ENV_MIN = 0.25
/** FM: the envelope moves less than this (beyond noise) while the discriminator swings more than this (Hz rms). */
const val FM_ENV_MAX = 0.1
const val FM_DEV_MIN = 350.0
/** AM: at least this share in the carrier, the envelope moving at least this much beyond noise, and at least this share
 *  of the rest in line with the carrier. */
const val AM_CARRIER_MIN = 0.6
const val AM_ENV_MIN = 0.06
const val AM_INLINE_MIN = 0.65
/** A block votes only when its power is at least this share of the transmission's strongest block (SSB pauses do not). */
private const val VOTE_POWER = 0.3
private const val BLOCK_MS = 100.0
private const val SUB_MS = 10.0
private const val OFF_WIN_MS = 100.0
private const val TWO_PI = 2 * PI

/**
 * Takes one steady line out of the channel: the line turned to DC and averaged (about 20 Hz wide) is its phasor, which
 * is turned back and subtracted. The phasor's own turning corrects the line's frequency, so a line read off an FFT bin
 * to within a few tens of Hz settles on it.
 */
class LineCanceller(val hz: Double, fs: Double) {
    private var w = 2 * PI * hz / fs
    private var ph = 0.0; private var cr = 0.0; private var ci = 0.0; private var n = 0; private var lr = 0.0; private var li = 0.0
    private val a = 2 * PI * 20 / fs

    fun run(xi: FloatArray, xq: FloatArray, m: Int) {
        var ph = ph; var cr = cr; var ci = ci; val a = a
        for (k in 0 until m) {
            val c = cos(ph); val s = sin(ph); val i = xi[k].toDouble(); val q = xq[k].toDouble()
            cr += a * (i * c + q * s - cr); ci += a * (q * c - i * s - ci)
            xi[k] = (i - (cr * c - ci * s)).toFloat(); xq[k] = (q - (cr * s + ci * c)).toFloat()
            ph += w
            if (++n >= 64) {
                // the phasor turning means the line sits a little off: move onto it, half the way each time
                n = 0
                if (lr != 0.0 || li != 0.0) { val d = atan2(ci * lr - cr * li, cr * lr + ci * li); w += 0.5 * d / 64 }
                lr = cr; li = ci
            }
        }
        this.ph = ph % (2 * PI); this.cr = cr; this.ci = ci
    }
}

/** The last block's measurements, for the tests and the card. */
data class CbBlock(val carrier: Double, val envAc: Double, val devHz: Double, val sideDb: Double, val inline: Double)

class CbProbe(rate: Double, val offsetHz: Double) : WatchProbe {
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
    /** The mode set by hand (null lets the measurement choose), the clarifier for SSB (Hz), and the mode before any vote. */
    var manual: CbMode? = null
    var clarHz = 0.0
    var guess = CbMode.AM
    /** Steady lines in the channel before this transmission (birdies), taken out of what is measured and heard. */
    private var notches: List<LineCanceller> = emptyList()
    fun setNotches(hz: List<Int>) { notches = hz.map { LineCanceller(it.toDouble(), fs) } }
    val notchHz: List<Double> get() = notches.map { it.hz }
    /** The channel's noise against its signal (linear), from the engine's measurement: what noise alone moves. */
    var noiseRatio = 0.0
    /** Votes by [CbMode.ordinal]. */
    val votes = IntArray(4)
    var last = CbBlock(0.0, 0.0, 0.0, 0.0, 0.0); private set
    private val lp: RealFir; private val to8: Resampler; private val to48: Resampler
    private val uI: RealFir; private val uQ: RealFir; private val lI: RealFir; private val lQ: RealFir
    private var ui = FloatArray(0); private var uq = FloatArray(0); private var uli = FloatArray(0); private var ulq = FloatArray(0)
    private var uti = FloatArray(0); private var utq = FloatArray(0); private var usi = FloatArray(0); private var usq = FloatArray(0)
    private val de: Double; private val hpa: Double
    private var pi = 1.0; private var pq = 0.0; private var deemph = 0.0; private var carRad = 0.0
    // the Weaver oscillators: the shift down (by the clarifier and the sideband's middle) and back up for the audio
    private var wu = 0.0; private var wl = 0.0; private var wb = 0.0
    // AM: the carrier level the envelope is measured against
    private var car = 0.0
    // SSB: the audio level for the AGC
    private var agc = 0.0
    // per block: power, carrier, envelope and its voice-band motion, discriminator swing, the two sidebands
    private var bN = 0; private var bPow = 0.0; private var bEnv = 0.0; private var bEnvAc = 0.0; private var bDev = 0.0; private var bU = 0.0; private var bL = 0.0; private var bCar = 0.0; private var bSubs = 0
    private var sI = 0.0; private var sQ = 0.0; private var sN = 0; private var cph = 0.0; private var cI = 0.0; private var cQ = 0.0; private var bIn = 0.0; private var bAcross = 0.0
    private var envHpS = 0.0; private var devHpS = 0.0; private var peakPow = 0.0
    private var offAcc = 0.0; private var offN = 0; private var envAcc = 0.0; private var envN = 0; private var hpE = 0.0; private var pow = 0.0; private var powN = 0

    init {
        ddc.reset(rate); ddc.offsetHz = offsetHz; fs = ddc.outRate
        lp = RealFir(lowpassTaps(3_000 / fs, 47))
        val w = lowpassTaps(SSB_HALF_HZ / fs, 63)
        uI = RealFir(w); uQ = RealFir(w); lI = RealFir(w); lQ = RealFir(w)
        to8 = Resampler(CLIP_RATE / fs); to48 = Resampler(48_000 / fs)
        de = 1 - exp(-1 / (fs * 530e-6))
        hpa = 1 - exp(-2 * PI * 150 / fs)
    }

    override fun retune(offsetHz: Double) { ddc.offsetHz = offsetHz }

    /** The mode demodulated now: by hand, else the most votes, else the channel's last mode. */
    fun mode(): CbMode {
        manual?.let { return it }
        var best = guess; var n = 1
        for (m in CbMode.entries) { val v = votes[m.ordinal]; if (v > n || (v == n && m == guess)) { n = v; best = m } }
        return best
    }

    /** The mode the measurement found, null before two blocks voted. */
    fun measuredMode(): CbMode? {
        if (votes.sum() < 2) return null
        var b = CbMode.AM
        for (m in listOf(CbMode.FM, CbMode.USB, CbMode.LSB)) if (votes[m.ordinal] > votes[b.ordinal]) b = m
        return b
    }

    override fun push(fi: FloatArray, fq: FloatArray, n: Int, listen: Boolean) {
        val max = ddc.maxOut(n)
        if (oi.size < max) {
            oi = FloatArray(max); oq = FloatArray(max); au = FloatArray(max); au2 = FloatArray(max); a8 = FloatArray(max); a48 = FloatArray(ceil(48_000 / fs * max).toInt() + 16)  // 16 kS/s to 48: three times as many
            ui = FloatArray(max); uq = FloatArray(max); uli = FloatArray(max); ulq = FloatArray(max)
            uti = FloatArray(max); utq = FloatArray(max); usi = FloatArray(max); usq = FloatArray(max)
        }
        val m = ddc.push(fi, fq, n, oi, oq); val fs = fs; val oi = oi; val oq = oq
        for (c in notches) c.run(oi, oq, m)
        // the Weaver shifts: upper sideband down by clarifier + 1650 Hz, lower by clarifier - 1650 Hz
        val du = -TWO_PI * (clarHz + SSB_MID_HZ) / fs; val dl = -TWO_PI * (clarHz - SSB_MID_HZ) / fs
        for (i in 0 until m) {
            val a = oi[i].toDouble(); val b = oq[i].toDouble()
            val cu = cos(wu); val su = sin(wu); val cl = cos(wl); val sl = sin(wl)
            ui[i] = (a * cu - b * su).toFloat(); uq[i] = (a * su + b * cu).toFloat(); uli[i] = (a * cl - b * sl).toFloat(); ulq[i] = (a * sl + b * cl).toFloat()
            wu += du; wl += dl
        }
        wu %= TWO_PI; wl %= TWO_PI
        uI.process(ui, m, uti); uQ.process(uq, m, utq); lI.process(uli, m, usi); lQ.process(ulq, m, usq)
        val mode = mode(); val au = au
        val win = (fs * OFF_WIN_MS / 1000).roundToInt(); val blk = (fs * BLOCK_MS / 1000).roundToInt(); val sub = (fs * SUB_MS / 1000).roundToInt()
        val offRad = carRad
        val dbk = TWO_PI * SSB_MID_HZ / fs
        for (i in 0 until m) {
            val a = oi[i].toDouble(); val b = oq[i].toDouble(); val p2 = a * a + b * b; val e = sqrt(p2)
            val f = atan2(b * pi - a * pq, a * pi + b * pq)
            pi = a; pq = b
            offAcc += f; if (++offN >= win) { means.add(offAcc / offN * fs / TWO_PI); offAcc = 0.0; offN = 0 }
            // the block's measurements
            bPow += p2; bEnv += e
            envHpS += hpa * (e - envHpS); val eh = e - envHpS; bEnvAc += eh * eh
            val fh = max(-6_000.0, min(6_000.0, f * fs / TWO_PI))
            devHpS += hpa * (fh - devHpS); val dh = fh - devHpS; bDev += dh * dh
            val ti = uti[i].toDouble(); val tq = utq[i].toDouble(); val si = usi[i].toDouble(); val sq = usq[i].toDouble()
            bU += ti * ti + tq * tq; bL += si * si + sq * sq
            // 10 ms averages of the signal turned to DC at the carrier: what stays put is the carrier
            val cc = cos(cph); val cs = sin(cph); cph -= offRad
            val zr = a * cc - b * cs; val zi = a * cs + b * cc
            sI += zr; sQ += zi
            // the remainder against the last 10 ms carrier: in line with it, and across it
            val cm = hypot(cI, cQ)
            if (cm > 0) {
                val rI = zr - cI; val rQ = zi - cQ; val pin = (rI * cI + rQ * cQ) / cm; val pac = (rQ * cI - rI * cQ) / cm
                bIn += pin * pin; bAcross += pac * pac
            }
            if (++sN >= sub) { cI = sI / sN; cQ = sQ / sN; bCar += cI * cI + cQ * cQ; bSubs++; sI = 0.0; sQ = 0.0; sN = 0 }
            if (++bN >= blk) endBlock()
            // the audio, by the mode
            val v: Double
            if (mode == CbMode.FM) { deemph += de * (f - deemph); v = deemph * 0.4 }
            else if (mode == CbMode.AM) {
                car += (if (car != 0.0) 0.002 else 1.0) * (e - car)
                v = if (car > 1e-3) (e - car) / car * 0.5 else 0.0
            } else {
                // back up by 1650 Hz and take the real part: the sideband's audio, 300 to 3000 Hz
                val s = if (mode == CbMode.USB) 1 else -1; val c = cos(wb); val sn = sin(s * wb)
                val x = if (mode == CbMode.USB) ti * c - tq * sn else si * c - sq * sn
                wb += dbk
                val ax = abs(x); agc = if (ax > agc) agc + 0.05 * (ax - agc) else agc * (1 - 2 / fs)
                v = x * 0.35 / max(0.5, agc)
            }
            au[i] = v.toFloat()
        }
        wb %= TWO_PI; cph %= TWO_PI

        lp.process(au, m, au2)
        val a2 = au2; val envWin = (fs * ENV_MS / 1000).roundToInt(); val hpa = 1 - exp(-2 * PI * 300 / fs)
        for (i in 0 until m) {
            hpE += hpa * (a2[i] - hpE); val v = a2[i] - hpE
            envAcc += v * v; if (++envN >= envWin) { env.add(sqrt(envAcc / envN).toFloat()); envAcc = 0.0; envN = 0 }
            val x = oi[i].toDouble(); val y = oq[i].toDouble(); pow += x * x + y * y; powN++
        }
        val k8 = to8.process(a2, m, a8); clip.push(a8, k8)
        out48 = if (listen) to48.process(a2, m, a48) else 0
        if (powN > fs / 10) { levelDb = 10 * log10(pow / powN + 1e-9); pow = 0.0; powN = 0 }
    }

    /** One 100 ms block measured: the carrier's share, the envelope's motion beyond noise, the swing, the sidebands; its vote. */
    private fun endBlock() {
        val n = bN; val pow = bPow / n; val envM = bEnv / n
        val carrier = if (bSubs != 0) min(1.0, bCar / bSubs / max(1e-9, pow)) else 0.0
        // the noise alone moves a constant envelope by about sqrt(noise / 2) of its mean
        val envAc2 = bEnvAc / n / max(1e-9, envM * envM) - noiseRatio / 2
        val envAc = sqrt(max(0.0, envAc2)); val devHz = sqrt(bDev / n)
        val sideDb = 10 * log10((bU + 1e-9) / (bL + 1e-9))
        val inline = if (bIn + bAcross > 0) bIn / (bIn + bAcross) else 0.5
        last = CbBlock(carrier, envAc, devHz, sideDb, inline)
        peakPow = max(peakPow, pow)
        if (pow >= VOTE_POWER * peakPow) {
            val v = votes
            if (carrier >= AM_CARRIER_MIN && envAc >= AM_ENV_MIN && inline >= AM_INLINE_MIN) v[CbMode.AM.ordinal]++
            else if (envAc < FM_ENV_MAX && devHz > FM_DEV_MIN && noiseRatio < 0.2) v[CbMode.FM.ordinal]++
            else if (abs(sideDb) > SSB_SIDE_DB && envAc >= SSB_ENV_MIN && inline < AM_INLINE_MIN) { if (sideDb > 0) v[CbMode.USB.ordinal]++ else v[CbMode.LSB.ordinal]++ }
        }
        // the carrier the next block is turned to DC by: the median of the last second's discriminator means
        val rec = means.subList(max(0, means.size - 10), means.size).sorted()
        carRad = if (rec.isNotEmpty()) 2 * PI * rec[rec.size / 2] / fs else 0.0
        bN = 0; bPow = 0.0; bEnv = 0.0; bEnvAc = 0.0; bDev = 0.0; bU = 0.0; bL = 0.0; bCar = 0.0; bSubs = 0; bIn = 0.0; bAcross = 0.0
    }

    /** Carrier offset: the median of the 100 ms means and their spread; none for SSB, which has no carrier. */
    override fun offset(skip: Int): ProbeOffset {
        val m = manual ?: measuredMode()
        if (m == CbMode.USB || m == CbMode.LSB) return ProbeOffset(Double.NaN, 0.0)
        if (means.size - skip < 3) return ProbeOffset(Double.NaN, 0.0)
        val s = means.subList(skip, means.size).sorted()
        val med = s[s.size / 2]; val q1 = s[s.size / 4]; val q3 = s[s.size * 3 / 4]
        return ProbeOffset(med, (q3 - q1) / 1.35 / sqrt(s.size.toDouble()))
    }
    override fun tone(): Double = 0.0
    override fun dcs(): Int = 0
    override fun end() { /* nothing buffered */ }
}
