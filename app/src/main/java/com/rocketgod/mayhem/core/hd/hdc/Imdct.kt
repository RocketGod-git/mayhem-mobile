package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

// IMDCT for the AAC filterbank: M coefficients in, 2M samples out, scaled by 2/N as in ISO/IEC 14496-3.
class Imdct(private val m: Int) {
    private val tw: DoubleArray
    private val fc: DoubleArray
    private val fs: DoubleArray
    private val rev: IntArray
    private val re: DoubleArray
    private val im: DoubleArray
    private val u: DoubleArray

    init {
        val h = m / 2
        tw = DoubleArray(2 * h)
        for (k in 0 until h) { val a = -PI * (8 * k + 1) / (8 * m); tw[2 * k] = cos(a); tw[2 * k + 1] = sin(a) }
        fc = DoubleArray(h / 2); fs = DoubleArray(h / 2)
        for (k in 0 until h / 2) { fc[k] = cos(-2 * PI * k / h); fs[k] = sin(-2 * PI * k / h) }
        val bits = Integer.numberOfTrailingZeros(h)
        rev = IntArray(h)
        for (i in 0 until h) { var r = 0; for (b in 0 until bits) r = r or (((i shr b) and 1) shl (bits - 1 - b)); rev[i] = r }
        re = DoubleArray(h); im = DoubleArray(h); u = DoubleArray(m)
    }

    // DCT-IV via an M/2-point complex FFT, then unfolded to the 2M-sample IMDCT output.
    fun run(x: DoubleArray, xo: Int, out: DoubleArray) {
        val h = m / 2
        for (k in 0 until h) {
            val a = x[xo + 2 * k]; val b = x[xo + m - 1 - 2 * k]; val c = tw[2 * k]; val s = tw[2 * k + 1]; val r = rev[k]
            re[r] = a * c - b * s; im[r] = a * s + b * c
        }
        var len = 2
        while (len <= h) {
            val half = len shr 1; val step = h / len
            var i = 0
            while (i < h) {
                for (j in 0 until half) {
                    val c = fc[j * step]; val s = fs[j * step]; val p = i + j; val q = p + half
                    val tr = re[q] * c - im[q] * s; val ti = re[q] * s + im[q] * c
                    re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti
                }
                i += len
            }
            len = len shl 1
        }
        val g = 1.0 / m
        for (j in 0 until h) {
            val c = tw[2 * j]; val s = tw[2 * j + 1]; val a = re[j] * c - im[j] * s; val b = re[j] * s + im[j] * c
            u[2 * j] = a * g; u[m - 1 - 2 * j] = -b * g
        }
        val q = m / 2
        for (n in 0 until q) out[n] = u[n + q]
        for (n in q until 3 * q) out[n] = -u[3 * q - 1 - n]
        for (n in 3 * q until 2 * m) out[n] = -u[n - 3 * q]
    }
}

// Direct O(N^2) reference, for tests.
fun imdctRef(x: DoubleArray, m: Int): DoubleArray {
    val n2 = 2 * m; val out = DoubleArray(n2); val n0 = (m + 1) / 2.0
    for (n in 0 until n2) { var s = 0.0; for (k in 0 until m) s += x[k] * cos(PI / m * (n + n0) * (k + 0.5)); out[n] = s / m }
    return out
}
