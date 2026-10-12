package com.rocketgod.mayhem.core.audio

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

data class HdReport(
    /** Sidebands present and carrying OFDM: the decision the badge shows. */
    val present: Boolean,
    /** Digital sideband power over the noise just beyond it, dB (the better sideband). */
    val snrDb: Double,
    /** Cyclic-prefix lock, peak-to-mean of the folded correlation (1.0 = nothing; a clean signal reads 2–4). */
    val lock: Double, val lockLo: Double, val lockHi: Double,
    val sbLoDb: Double, val sbHiDb: Double, val refDb: Double, val analogDb: Double,
    /** Station carrier error against the dial, modulo one subcarrier spacing (±181 Hz): the prefix resolves only that. */
    val cfoHz: Double,
    val symbols: Int,
)

private const val HD_RATE = 744_187.5               // the standard's reference rate: 2048-point symbols at 363.373 Hz spacing
private const val OFDM_N = 2048
private const val OFDM_CP = 112
private const val OFDM_SYM = OFDM_N + OFDM_CP
private const val SUB_SPACING = HD_RATE / OFDM_N
private const val SB_LO_HZ = 356 * SUB_SPACING      // primary main sideband: subcarriers 356..545
private const val SB_HI_HZ = 545 * SUB_SPACING
/** A whole number of spacings, so the subcarrier grid lands exactly on DC; a fraction would read as a constant carrier error. */
private const val SB_MIX_HZ = 450 * SUB_SPACING
private const val REF_LO_HZ = 205_000.0
private const val REF_HI_HZ = 235_000.0
private const val ANALOG_HZ = 100_000.0
private const val FOLD = 64
private const val PRESENT_SNR_DB = 6.0
private const val PRESENT_LOCK = 1.35

/** Hann-windowed sinc low-pass, unity DC gain; [cutoff] as a fraction of the sample rate. */
private fun lowpass(taps: Int, cutoff: Double): FloatArray {
    val h = FloatArray(taps); val m = (taps - 1) / 2.0
    var sum = 0.0
    for (i in 0 until taps) {
        val x = i - m
        val sinc = if (x == 0.0) 2 * cutoff else sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
        val w = 0.5 - 0.5 * cos(2 * Math.PI * (i + 1) / (taps + 1))
        h[i] = (sinc * w).toFloat(); sum += h[i]
    }
    for (i in 0 until taps) h[i] = (h[i] / sum).toFloat()
    return h
}

/** One sideband brought to DC at its own low rate, with the cyclic-prefix correlator on it. */
private class Sideband {
    private var stepRe = 1.0; private var stepIm = 0.0; private var phRe = 1.0; private var phIm = 0.0; private var phN = 0
    private var d2 = 1; private var cnt = 0; private var pathRate = 0.0
    private var taps = FloatArray(0)
    private var lineRe = FloatArray(0); private var lineIm = FloatArray(0); private var lineAt = 0
    private var L = 0; private var cp = 0; private var P = 1.0
    private var yRe = FloatArray(1024); private var yIm = FloatArray(1024); private var yAt = 0; private var yN = 0
    private var rRe = DoubleArray(64); private var rIm = DoubleArray(64); private var rAt = 0
    private var sRe = 0.0; private var sIm = 0.0
    private var phase = 0.0
    private val prof = DoubleArray(FOLD); private val profRe = DoubleArray(FOLD); private val profIm = DoubleArray(FOLD)
    private var symbols = 0

    fun configure(rate1: Double, shiftHz: Double) {
        val w = -2 * Math.PI * shiftHz / rate1
        stepRe = cos(w); stepIm = sin(w); phRe = 1.0; phIm = 0.0; phN = 0
        d2 = max(1, (rate1 / 96_000).roundToInt()); cnt = 0
        pathRate = rate1 / d2
        taps = lowpass(63, 36_000 / rate1)
        lineRe = FloatArray(taps.size); lineIm = FloatArray(taps.size); lineAt = 0
        L = (OFDM_N * pathRate / HD_RATE).roundToInt()
        cp = max(4, (OFDM_CP * pathRate / HD_RATE).roundToInt())
        P = OFDM_SYM * pathRate / HD_RATE
        yRe = FloatArray(1024); yIm = FloatArray(1024); yAt = 0; yN = 0
        rRe = DoubleArray(cp); rIm = DoubleArray(cp); rAt = 0; sRe = 0.0; sIm = 0.0
        clear()
    }
    fun clear() { prof.fill(0.0); profRe.fill(0.0); profIm.fill(0.0); symbols = 0 }

    fun push(re: Double, im: Double) {
        val xr = re * phRe - im * phIm; val xi = re * phIm + im * phRe
        val nr = phRe * stepRe - phIm * stepIm; phIm = phRe * stepIm + phIm * stepRe; phRe = nr
        if (++phN >= 4096) { phN = 0; val g = 1 / sqrt(phRe * phRe + phIm * phIm); phRe *= g; phIm *= g }
        // delay line for the low-pass; only every d2-th output is computed (polyphase)
        val n = taps.size
        lineRe[lineAt] = xr.toFloat(); lineIm[lineAt] = xi.toFloat(); lineAt = (lineAt + 1) % n
        if (++cnt < d2) return
        cnt = 0
        var yr = 0.0; var yi = 0.0; var j = lineAt
        for (i in 0 until n) { val h = taps[n - 1 - i]; yr += h * lineRe[j]; yi += h * lineIm[j]; if (++j == n) j = 0 }
        onPath(yr, yi)
    }

    private fun onPath(yr: Double, yi: Double) {
        val ring = yRe.size
        yRe[yAt] = yr.toFloat(); yIm[yAt] = yi.toFloat()
        val at = yAt; yAt = (yAt + 1) % ring
        if (yN < ring) yN++
        if (yN <= L) return
        val j = (at - L + ring) % ring; val br = yRe[j].toDouble(); val bi = yIm[j].toDouble()
        // x[n]·conj(x[n−L]), summed over the last cp samples
        val rr = yr * br + yi * bi; val rim = yi * br - yr * bi
        sRe += rr - rRe[rAt]; sIm += rim - rIm[rAt]
        rRe[rAt] = rr; rIm[rAt] = rim; rAt = (rAt + 1) % cp
        val bin = min(FOLD - 1, floor(phase * FOLD).toInt())
        prof[bin] += sqrt(sRe * sRe + sIm * sIm)
        profRe[bin] += sRe; profIm[bin] += sIm
        phase += 1 / P
        if (phase >= 1) { phase -= 1; symbols++ }
    }

    /** Lock (peak-to-mean of the folded profile), carrier error at the peak, symbols folded; then start over. */
    fun report(): Triple<Double, Double, Int> {
        var sum = 0.0; var peak = 0.0; var pk = 0
        for (b in 0 until FOLD) { sum += prof[b]; if (prof[b] > peak) { peak = prof[b]; pk = b } }
        val mean = sum / FOLD
        val lock = if (mean > 0) peak / mean else 0.0
        val cfo = atan2(profIm[pk], profRe[pk]) * pathRate / (2 * Math.PI * L)
        val s = symbols
        clear()
        return Triple(lock, cfo, s)
    }
}

/**
 * HD Radio (NRSC-5, FM hybrid) detector: finds the digital sidebands either side of the analog carrier, measures them
 * against the noise just beyond, and proves they carry OFDM by locking to the cyclic prefix, which also yields the
 * carrier error. Detection only: the audio codec is proprietary, so there is nothing to play.
 *
 * The channel is brought to ~480 kHz, where a 1024-point spectrum gives the sideband, analog and reference powers.
 * Each sideband is then mixed to DC on its own and brought to ~96 kHz, where x[n]·conj(x[n−L]) over a prefix length
 * peaks once per symbol at a fixed phase of the symbol clock; folding its magnitude by symbol phase gives a profile
 * whose peak-to-mean is the lock (noise folds flat, about 1.0).
 */
class HdDetector(private val emit: (HdReport) -> Unit) {
    private var rate = 0; private var d1 = 1; private var rate1 = 0.0
    private var offset = Double.NaN; private var stepRe = 1.0; private var stepIm = 0.0; private var phRe = 1.0; private var phIm = 0.0; private var phN = 0
    private var accRe = 0.0; private var accIm = 0.0; private var accN = 0
    private val hi = Sideband(); private val lo = Sideband()
    private val n = 1024
    private val fre = FloatArray(1024); private val fim = FloatArray(1024)
    private val win = FloatArray(1024) { (0.5 - 0.5 * cos(2 * Math.PI * it / 1024)).toFloat() }
    private val frame = FloatArray(2048); private var frameN = 0; private var frameGap = 0
    private val pow = DoubleArray(1024); private var pows = 0
    private var since = 0; private var every = 0

    fun reset() {
        rate = 0; offset = Double.NaN; pow.fill(0.0); pows = 0; frameN = 0; frameGap = 0
        since = 0; hi.clear(); lo.clear()
    }

    private fun configure(rate: Int) {
        this.rate = rate
        d1 = max(1, (rate / 480_000.0).roundToInt()); accRe = 0.0; accIm = 0.0; accN = 0
        rate1 = rate.toDouble() / d1
        hi.configure(rate1, SB_MIX_HZ); lo.configure(rate1, -SB_MIX_HZ)
        pow.fill(0.0); pows = 0; frameN = 0; frameGap = 0
        every = rate / 2; since = 0
        offset = Double.NaN
    }

    /** Offset-128 interleaved IQ at [rate]; the station sits [offsetHz] from the span centre. */
    fun push(iq: ByteArray, nSamp: Int, rate: Int, offsetHz: Double) {
        if (rate != this.rate) configure(rate)
        if (offsetHz != offset) { offset = offsetHz; val w = -2 * Math.PI * offsetHz / rate; stepRe = cos(w); stepIm = sin(w) }
        val d1 = d1
        for (k in 0 until nSamp) {
            val a = (iq[2 * k].toInt() and 0xff) - 127.4; val b = (iq[2 * k + 1].toInt() and 0xff) - 127.4
            val xr = a * phRe - b * phIm; val xi = a * phIm + b * phRe
            val nr = phRe * stepRe - phIm * stepIm; phIm = phRe * stepIm + phIm * stepRe; phRe = nr
            if (++phN >= 4096) { phN = 0; val g = 1 / sqrt(phRe * phRe + phIm * phIm); phRe *= g; phIm *= g }
            accRe += xr; accIm += xi
            if (++accN >= d1) { val yr = accRe / d1; val yi = accIm / d1; accRe = 0.0; accIm = 0.0; accN = 0; at1(yr, yi) }
        }
        since += nSamp
        if (since >= every) { since = 0; report() }
    }

    /** One sample at ~480 kHz: every eighth 1024-sample frame goes to the spectrum; every sample to both sidebands. */
    private fun at1(re: Double, im: Double) {
        if (frameGap > 0) frameGap--
        else {
            frame[2 * frameN] = re.toFloat(); frame[2 * frameN + 1] = im.toFloat()
            if (++frameN >= n) {
                frameN = 0; frameGap = 7 * n
                for (i in 0 until n) { fre[i] = frame[2 * i] * win[i]; fim[i] = frame[2 * i + 1] * win[i] }
                Dsp.fft(fre, fim)
                for (i in 0 until n) pow[i] += (fre[i] * fre[i] + fim[i] * fim[i]).toDouble()
                pows++
            }
        }
        hi.push(re, im); lo.push(re, im)
    }

    /** Mean power, dB, over the bins covering [loHz, hiHz) (negative for below the carrier). */
    private fun bandDb(loHz: Double, hiHz: Double): Double {
        val binHz = rate1 / n
        var a = Math.round(loHz / binHz).toInt(); var b = Math.round(hiHz / binHz).toInt()
        if (a > b) { val t = a; a = b; b = t }
        var sum = 0.0; var cnt = 0
        for (k in a until b) { val i = ((k % n) + n) % n; sum += pow[i]; cnt++ }
        return if (cnt > 0 && pows > 0) 10 * log10(sum / cnt / pows + 1e-20) else -200.0
    }

    private fun report() {
        val sbHiDb = bandDb(SB_LO_HZ, SB_HI_HZ); val sbLoDb = bandDb(-SB_HI_HZ, -SB_LO_HZ)
        val refDb = 10 * log10((10.0.pow(bandDb(REF_LO_HZ, REF_HI_HZ) / 10) + 10.0.pow(bandDb(-REF_HI_HZ, -REF_LO_HZ) / 10)) / 2 + 1e-20)
        val analogDb = bandDb(-ANALOG_HZ, ANALOG_HZ)
        pow.fill(0.0); pows = 0
        val h = hi.report(); val l = lo.report()
        val best = if (h.first >= l.first) h else l
        val snrDb = max(sbHiDb, sbLoDb) - refDb
        val lock = max(h.first, l.first)
        emit(HdReport(snrDb >= PRESENT_SNR_DB && lock >= PRESENT_LOCK, snrDb, lock, l.first, h.first, sbLoDb, sbHiDb, refDb, analogDb, best.second, best.third))
    }
}
