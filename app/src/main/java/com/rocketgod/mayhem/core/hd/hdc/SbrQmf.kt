package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

// Complex SBR QMF banks (ISO/IEC 14496-3 4.6.18.4): 32-band analysis and 64-band synthesis.

private val A_COS = DoubleArray(32 * 64) { val k = it / 64; val n = it % 64; 2 * cos(PI / 64 * (k + 0.5) * (2 * n - 0.5)) }
private val A_SIN = DoubleArray(32 * 64) { val k = it / 64; val n = it % 64; 2 * sin(PI / 64 * (k + 0.5) * (2 * n - 0.5)) }
private val S_COS = DoubleArray(128 * 64) { val n = it / 64; val k = it % 64; cos(PI / 128 * (k + 0.5) * (2 * n - 255)) / 64 }
private val S_SIN = DoubleArray(128 * 64) { val n = it / 64; val k = it % 64; sin(PI / 128 * (k + 0.5) * (2 * n - 255)) / 64 }
private val WIN_A = DoubleArray(320) { QMF_WINDOW[2 * it] }

class QmfAnalysis {
    private val x = DoubleArray(320)
    private val u = DoubleArray(64)
    /** 32 input samples -> 32 complex subbands written to re/im at offset. */
    fun slot(input: FloatArray, inOff: Int, scale: Double, re: DoubleArray, im: DoubleArray, off: Int) {
        System.arraycopy(x, 0, x, 32, 288)
        for (n in 0 until 32) x[31 - n] = input[inOff + n] * scale
        for (n in 0 until 64) u[n] = x[n] * WIN_A[n] + x[n + 64] * WIN_A[n + 64] + x[n + 128] * WIN_A[n + 128] + x[n + 192] * WIN_A[n + 192] + x[n + 256] * WIN_A[n + 256]
        for (k in 0 until 32) {
            var r = 0.0; var i = 0.0
            val b = k * 64
            for (n in 0 until 64) { r += u[n] * A_COS[b + n]; i += u[n] * A_SIN[b + n] }
            re[off + k] = r; im[off + k] = i
        }
    }
    fun reset() { x.fill(0.0) }
}

class QmfSynthesis {
    private val v = DoubleArray(1280)
    /** 64 complex subbands -> 64 output samples. */
    fun slot(re: DoubleArray, im: DoubleArray, off: Int, out: FloatArray, outOff: Int, scale: Double) {
        System.arraycopy(v, 0, v, 128, 1152)
        for (n in 0 until 128) {
            var s = 0.0
            val b = n * 64
            for (k in 0 until 64) s += re[off + k] * S_COS[b + k] - im[off + k] * S_SIN[b + k]
            v[n] = s
        }
        val c = QMF_WINDOW
        for (n in 0 until 64) {
            var s = 0.0
            for (i in 0 until 5) s += v[256 * i + n] * c[128 * i + n] + v[256 * i + 192 + n] * c[128 * i + 64 + n]
            out[outOff + n] = (s * scale).toFloat()
        }
    }
    fun reset() { v.fill(0.0) }
    fun copyFrom(o: QmfSynthesis) { o.v.copyInto(v) }
}
