package com.rocketgod.mayhem.core

import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.sin

/** Shared DSP primitives: radix-2 FFT, IQ windowing, power spectrum. */
object Dsp {
    /** What a transform of one size needs, worked out once: the bit-reversal swaps and the twiddles (exact, from a table). */
    private class Plan(n: Int) {
        val swaps: IntArray
        val cosT = FloatArray(n / 2) { cos(-2.0 * Math.PI * it / n).toFloat() }
        val sinT = FloatArray(n / 2) { sin(-2.0 * Math.PI * it / n).toFloat() }
        init {
            val sw = ArrayList<Int>()
            var j = 0
            for (i in 1 until n) {
                var bit = n shr 1
                while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
                j = j or bit
                if (i < j) { sw.add(i); sw.add(j) }
            }
            swaps = sw.toIntArray()
        }
    }
    /** By log2 of the size; a plan never changes once made, so threads share them freely. */
    private val plans = arrayOfNulls<Plan>(31)

    /** In-place iterative radix-2 FFT (N power of two). */
    fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
        if (n < 2) return
        val lg = Integer.numberOfTrailingZeros(n)
        val plan = plans[lg] ?: Plan(n).also { plans[lg] = it }
        val sw = plan.swaps
        var s = 0
        while (s < sw.size) {
            val i = sw[s]; val j = sw[s + 1]
            val tr = re[i]; re[i] = re[j]; re[j] = tr; val ti = im[i]; im[i] = im[j]; im[j] = ti
            s += 2
        }
        // the first pass has no twiddles
        var i0 = 0
        while (i0 < n) {
            val ar = re[i0]; val ai = im[i0]; val br = re[i0 + 1]; val bi = im[i0 + 1]
            re[i0] = ar + br; im[i0] = ai + bi; re[i0 + 1] = ar - br; im[i0 + 1] = ai - bi
            i0 += 2
        }
        val ct = plan.cosT; val st = plan.sinT
        var len = 4
        while (len <= n) {
            val half = len / 2; val step = n / len
            var i = 0
            while (i < n) {
                var t = 0
                for (k in 0 until half) {
                    val a = i + k; val b = a + half
                    val cr = ct[t]; val ci = st[t]
                    val xr = re[b]; val xi = im[b]
                    val tr = cr * xr - ci * xi; val ti = cr * xi + ci * xr
                    val ar = re[a]; val ai = im[a]
                    re[b] = ar - tr; im[b] = ai - ti
                    re[a] = ar + tr; im[a] = ai + ti
                    t += step
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

    /** fftshifted power in dB, downsampled to out.size bins (peak within each group), DC in the centre. */
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
