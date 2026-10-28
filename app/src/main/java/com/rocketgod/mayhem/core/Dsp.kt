package com.rocketgod.mayhem.core

import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.sin

/** Shared DSP primitives: radix-2 FFT, IQ windowing, power spectrum. */
object Dsp {
    /** In-place iterative radix-2 FFT (N power of two). */
    fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j or bit
            if (i < j) { val tr = re[i]; re[i] = re[j]; re[j] = tr; val ti = im[i]; im[i] = im[j]; im[j] = ti }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wr = cos(ang).toFloat(); val wi = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f; var ci = 0f
                for (k in 0 until len / 2) {
                    val a = i + k; val b = i + k + len / 2
                    val tr = cr * re[b] - ci * im[b]; val ti = cr * im[b] + ci * re[b]
                    re[b] = re[a] - tr; im[b] = im[a] - ti
                    re[a] += tr; im[a] += ti
                    val ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** Load the first min(N, nSamp) offset-128 IQ samples of [iq] into [re]/[im] with a Hann window, zero-padded. */
    fun loadIq(iq: ByteArray, nSamp: Int, re: FloatArray, im: FloatArray) {
        val nFft = re.size
        val n = min(nFft, nSamp)
        for (k in 0 until n) {
            val w = 0.5f - 0.5f * cos(2.0 * Math.PI * k / (n - 1)).toFloat()
            re[k] = ((iq[2 * k].toInt() and 0xff) - 127.4f) * w
            im[k] = ((iq[2 * k + 1].toInt() and 0xff) - 127.4f) * w
        }
        for (k in n until nFft) { re[k] = 0f; im[k] = 0f }
    }

    /** fftshifted power in dB, downsampled to out.size bins (peak within each group), DC in the center. */
    fun powerDb(re: FloatArray, im: FloatArray, out: FloatArray) {
        val nFft = re.size
        val bins = out.size
        val group = nFft / bins
        for (bin in 0 until bins) {
            var peak = 0f
            for (j in 0 until group) {
                val idx = bin * group + j
                val shifted = (idx + nFft / 2) % nFft
                val mag = re[shifted] * re[shifted] + im[shifted] * im[shifted]
                if (mag > peak) peak = mag
            }
            out[bin] = 10f * ln(peak + 1e-9f) / ln(10f)
        }
    }
}
