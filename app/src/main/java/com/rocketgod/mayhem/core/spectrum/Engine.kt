package com.rocketgod.mayhem.core.spectrum

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.ceil
import kotlin.math.ln

/**
 * Spectrum: the FFT engine. Offset-128 IQ bytes in (the radio's bytes on Android; byte - 128 is the signed-int8
 * count the web reads), one power spectrum per N samples out, each bin in dBFS (0 dBFS is a full-scale complex
 * tone, whichever window is used), fftshifted so index 0 is the lowest frequency.
 *
 * Every frame goes through the video filter (VBW). Between two reads of `take()` the engine also keeps each bin's
 * highest and lowest frame, so a max hold or min hold drawn at the display's frame rate still catches a burst that
 * came and went between two drawn frames.
 */

/** Samples per second the engine will transform at most; above it, whole frames are skipped (the RBW is unchanged). */
const val FFT_BUDGET = 6_000_000
private val LN10_10 = 10 / ln(10.0)

/** Linear power to dB, floored well under anything an 8-bit radio can show. */
fun toDb(p: Double): Double = LN10_10 * ln(p + 1e-20)

/**
 * Lay the bins `c - half .. c + half` (the DC spike's spread) on a straight line between their outer neighbors.
 * A HackRF's or an RTL-SDR's DC offset is a pure tone at 0 Hz: it is the radio, not the signal.
 */
fun patchDc(p: FloatArray, c: Int, half: Int) {
    val a = c - half - 1; val b = c + half + 1
    if (a < 0 || b >= p.size) return
    for (i in a + 1 until b) p[i] = (p[a] + (p[b].toDouble() - p[a]) * (i - a) / (b - a)).toFloat()
}

/** How many bins either side of DC a window's DC spike covers. */
fun dcHalfWidth(kind: WindowKind): Int = if (kind == WindowKind.HANN) 2 else 4

/** One signed IQ count from the radio's offset-128 byte. */
internal fun iqCount(b: Byte): Int = (b.toInt() and 0xff) - 128

/** What `take()` hands back: the video-filtered spectrum and the extremes since the take before, in dB. */
class Take(val live: FloatArray, val max: FloatArray, val min: FloatArray, val frames: Int)

class FftEngine(val n: Int, val kind: WindowKind, val rate: Double, var vbwHz: Double, var dcPatch: Boolean) {
    val w: FloatArray = windowOf(kind, n)
    /** 1 / (128 · Σw)²: |X|² times this is the power in dBFS. */
    private val norm: Double
    private val re = FloatArray(n)
    private val im = FloatArray(n)
    private val bufI = FloatArray(n)
    private val bufQ = FloatArray(n)
    private var fill = 0
    private var skipLeft = 0
    private val power = FloatArray(n)
    val video = VideoFilter(n)
    val max = FloatArray(n) { Float.NEGATIVE_INFINITY }
    val min = FloatArray(n) { Float.POSITIVE_INFINITY }
    /** The video-filtered frames since the last take, summed in linear power: the screen's frame is their mean. */
    private val sum = DoubleArray(n)
    /** Frames folded in since the last take(). */
    var framesSince = 0
    /** Frames transformed since the engine was made. */
    var frames = 0
    /** Frames skipped between two transformed ones, to stay within FFT_BUDGET. */
    val skip: Int = kotlin.math.max(0, ceil(rate / FFT_BUDGET).toInt() - 1)
    val enbw: Double

    init {
        val g = windowGains(w)
        enbw = g.enbw
        norm = 1 / ((128 * g.sum) * (128 * g.sum))
    }

    /** The RBW in hertz. */
    val rbwHz: Double get() = enbw * rate / n
    /** Bin spacing in hertz. */
    val binHz: Double get() = rate / n
    /** Time from one transformed frame to the next, which is what the video filter integrates over. */
    val frameSec: Double get() = (n * (1 + skip)) / rate

    /** Fold in a read of offset-128 IQ ([len] bytes valid). Returns how many frames it completed. */
    fun push(iq: ByteArray, len: Int = iq.size): Int {
        val nSamp = len shr 1
        var done = 0
        var s = 0
        while (s < nSamp) {
            if (skipLeft > 0) { val k = kotlin.math.min(skipLeft, nSamp - s); skipLeft -= k; s += k; continue }
            val k = kotlin.math.min(n - fill, nSamp - s)
            for (j in 0 until k) { bufI[fill + j] = iqCount(iq[2 * (s + j)]).toFloat(); bufQ[fill + j] = iqCount(iq[2 * (s + j) + 1]).toFloat() }
            fill += k; s += k
            if (fill == n) { frame(); fill = 0; skipLeft = skip * n; done++ }
        }
        return done
    }

    /** Fold in one frame of float IQ (in int8 counts) directly: what the tests drive. */
    fun pushFloat(i: FloatArray, q: FloatArray) {
        System.arraycopy(i, 0, bufI, 0, n); System.arraycopy(q, 0, bufQ, 0, n); frame()
    }

    private fun frame() {
        val h = n shr 1
        for (k in 0 until n) { re[k] = bufI[k] * w[k]; im[k] = bufQ[k] * w[k] }
        Dsp.fft(re, im)
        for (i in 0 until n) {
            val s = if (i < h) i + h else i - h
            power[i] = ((re[s].toDouble() * re[s] + im[s].toDouble() * im[s]) * norm).toFloat()
        }
        if (dcPatch) patchDc(power, h, dcHalfWidth(kind))
        video.push(power, videoAlpha(vbwHz, frameSec))
        val y = video.y
        for (i in 0 until n) { val d = toDb(y[i].toDouble()).toFloat(); if (d > max[i]) max[i] = d; if (d < min[i]) min[i] = d; sum[i] += y[i] }
        framesSince++; frames++
    }

    /**
     * The spectrum since the last take, bins a..b (inclusive), in dB: `live` is the power mean of every video-filtered
     * frame since then (an FFT analyzer's displayed frame: one lone frame of noise swings 20 dB bin to bin, dozens
     * averaged read steady), `max` and `min` the highest and lowest single frames (so a short burst is never lost).
     */
    fun take(a: Int = 0, b: Int = n - 1): Take {
        val len = b - a + 1
        val live = FloatArray(len); val mx = FloatArray(len); val mn = FloatArray(len)
        val frames = framesSince; val k = 1.0 / kotlin.math.max(1, frames)
        for (i in 0 until len) { live[i] = toDb(if (frames > 0) sum[a + i] * k else video.y[a + i].toDouble()).toFloat(); mx[i] = max[a + i]; mn[i] = min[a + i] }
        max.fill(Float.NEGATIVE_INFINITY); min.fill(Float.POSITIVE_INFINITY); sum.fill(0.0); framesSince = 0
        return Take(live, mx, mn, frames)
    }
}
