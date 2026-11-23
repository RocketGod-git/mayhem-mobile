package com.rocketgod.mayhem.core.hamid

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A Codec 2 style speech decoder for M17 voice (3200 and 1600 bit/s), from David Rowe's "Codec 2 Algorithm
 * Description" (February 2025): harmonic sinusoidal synthesis every 10 ms through a 512-point inverse DFT and a
 * triangular overlap-add, the LPC/LSP envelope with the post filter (β = 0.2, γ = 0.5), zero-order phase, and the
 * published frame sizes and bit counts. The bit order, pitch and energy ranges and LSP tables are our own (the
 * reference ones are only in its source), so frames from radios using the reference tables do not decode to the
 * right spectrum. The same as the web's dsp/hamid/codec2.ts.
 */
object Codec2 {
    const val FS = 8000; const val N = 80; const val NDFT = 512
    private const val TWO_PI = 2 * PI
    const val OWN_F0_MIN = 50.0; const val OWN_F0_MAX = 400.0
    const val OWN_E_MIN_DB = 10.0; const val OWN_E_MAX_DB = 80.0
    val OWN_LSPD_HZ = arrayOf(doubleArrayOf(100.0, 700.0)) + Array(9) { doubleArrayOf(40.0, 800.0) }
    val OWN_LSP_BITS = intArrayOf(4, 4, 4, 4, 4, 4, 4, 3, 3, 2)
    val OWN_LSP_HZ = arrayOf(doubleArrayOf(100.0, 700.0), doubleArrayOf(200.0, 1100.0), doubleArrayOf(400.0, 1600.0), doubleArrayOf(650.0, 2000.0), doubleArrayOf(1000.0, 2400.0),
        doubleArrayOf(1300.0, 2800.0), doubleArrayOf(1700.0, 3200.0), doubleArrayOf(2000.0, 3400.0), doubleArrayOf(2400.0, 3600.0), doubleArrayOf(2800.0, 3800.0))

    fun f0FromIndex(i: Int) = OWN_F0_MIN + i * (OWN_F0_MAX - OWN_F0_MIN) / 127
    fun eDbFromIndex(i: Int) = OWN_E_MIN_DB + i * (OWN_E_MAX_DB - OWN_E_MIN_DB) / 31
    fun lspdHz(k: Int, i: Int) = OWN_LSPD_HZ[k][0] + i * (OWN_LSPD_HZ[k][1] - OWN_LSPD_HZ[k][0]) / 31
    fun lspHz(k: Int, i: Int) = OWN_LSP_HZ[k][0] + i * (OWN_LSP_HZ[k][1] - OWN_LSP_HZ[k][0]) / ((1 shl OWN_LSP_BITS[k]) - 1)
    /** JavaScript's Math.round: halves go up. */
    fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

    class Params(val wo: Double, val voiced: Boolean, val eDb: Double, var lsp: DoubleArray)
    private class Bits(private val b: IntArray) { private var p = 0; fun read(n: Int): Int { var v = 0; repeat(n) { v = (v shl 1) or ((b[p shr 3] shr (7 - (p and 7))) and 1); p++ }; return v } }

    fun orderLsps(w: DoubleArray, minSep: Double = 0.02) {
        for (i in w.indices) { val lo = if (i == 0) minSep else w[i - 1] + minSep; if (!(w[i] >= lo)) w[i] = lo }
        for (i in w.indices.reversed()) { val hi = if (i == w.size - 1) PI - minSep else w[i + 1] - minSep; if (w[i] > hi) w[i] = hi }
    }
    class F3200(val wo: Double, val eDb: Double, val v1: Boolean, val v2: Boolean, val lsp: DoubleArray)
    fun unpack3200(b: IntArray): F3200 {
        val r = Bits(b)
        val wo = TWO_PI * f0FromIndex(r.read(7)) / FS; val eDb = eDbFromIndex(r.read(5))
        val v1 = r.read(1) == 1; val v2 = r.read(1) == 1
        val lsp = DoubleArray(10); var f = 0.0
        for (k in 0 until 10) { f += lspdHz(k, r.read(5)); lsp[k] = TWO_PI * f / FS }
        orderLsps(lsp)
        return F3200(wo, eDb, v1, v2, lsp)
    }
    class F1600(val wo: DoubleArray, val eDb: DoubleArray, val v: BooleanArray, val lsp: DoubleArray)
    fun unpack1600(b: IntArray): F1600 {
        val r = Bits(b)
        val v1 = r.read(1) == 1; val wo1 = TWO_PI * f0FromIndex(r.read(7)) / FS; val e1 = eDbFromIndex(r.read(5))
        val v2 = r.read(1) == 1; val v3 = r.read(1) == 1; val wo2 = TWO_PI * f0FromIndex(r.read(7)) / FS; val e2 = eDbFromIndex(r.read(5))
        val v4 = r.read(1) == 1
        val lsp = DoubleArray(10) { TWO_PI * lspHz(it, r.read(OWN_LSP_BITS[it])) / FS }
        orderLsps(lsp)
        return F1600(doubleArrayOf(wo1, wo2), doubleArrayOf(e1, e2), booleanArrayOf(v1, v2, v3, v4), lsp)
    }

    fun lspToLpc(w: DoubleArray): DoubleArray {
        fun mul(a: DoubleArray, c: Double): DoubleArray { val o = DoubleArray(a.size + 2); for (i in a.indices) { o[i] += a[i]; o[i + 1] += c * a[i]; o[i + 2] += a[i] }; return o }
        var p = doubleArrayOf(1.0, 1.0); var q = doubleArrayOf(1.0, -1.0)
        for (i in w.indices step 2) p = mul(p, -2 * cos(w[i]))
        for (i in 1 until w.size step 2) q = mul(q, -2 * cos(w[i]))
        return DoubleArray(w.size + 1) { (p[it] + q[it]) / 2 }
    }

    private val COS = DoubleArray(NDFT / 2) { cos(TWO_PI * it / NDFT) }
    private val SIN = DoubleArray(NDFT / 2) { sin(TWO_PI * it / NDFT) }
    private val REV = IntArray(NDFT) { var x = it; var y = 0; repeat(9) { y = (y shl 1) or (x and 1); x = x shr 1 }; y }
    fun fft512(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        for (i in 0 until NDFT) { val j = REV[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t } }
        var len = 2
        while (len <= NDFT) {
            val half = len shr 1; val step = NDFT / len
            var s = 0
            while (s < NDFT) {
                for (k in 0 until half) {
                    val c = COS[k * step]; val sn = if (inverse) SIN[k * step] else -SIN[k * step]
                    val a = s + k; val b = a + half
                    val tr = re[b] * c - im[b] * sn; val ti = re[b] * sn + im[b] * c
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
                }
                s += len
            }
            len = len shl 1
        }
    }
    class Spectrum(val pw: DoubleArray, val phase: DoubleArray)
    fun lpcSpectrum(a: DoubleArray): Spectrum {
        val re = DoubleArray(NDFT); val im = DoubleArray(NDFT); val rg = DoubleArray(NDFT); val ig = DoubleArray(NDFT)
        var g = 1.0
        for (k in a.indices) { re[k] = a[k]; rg[k] = a[k] * g; g *= 0.5 }
        fft512(re, im, false); fft512(rg, ig, false)
        val pw = DoubleArray(NDFT / 2 + 1); val phase = DoubleArray(NDFT / 2 + 1)
        for (k in 0..NDFT / 2) {
            val p = re[k] * re[k] + im[k] * im[k] + 1e-12; val pg = rg[k] * rg[k] + ig[k] * ig[k]
            pw[k] = (pg / p).pow(0.1) / p
            phase[k] = -atan2(im[k], re[k])
        }
        return Spectrum(pw, phase)
    }
    private fun mixLsp(a: DoubleArray, b: DoubleArray, f: Double) = DoubleArray(10) { a[it] * (1 - f) + b[it] * f }
    private fun interp(a: Params, b: Params, f: Double, v: Boolean): Params {
        val wo = if (a.voiced && b.voiced) a.wo * (1 - f) + b.wo * f else if (b.voiced) b.wo else if (a.voiced) a.wo else b.wo
        return Params(wo, v, a.eDb * (1 - f) + b.eDb * f, mixLsp(a.lsp, b.lsp, f))
    }

    class Decoder(val rate: Int) {
        private fun start() = Params(TWO_PI * 100 / FS, false, OWN_E_MIN_DB, DoubleArray(10) { TWO_PI * (it + 1) * 360 / FS })
        private var prev = start()
        private var phi1 = 0.0
        private val tail = DoubleArray(N)
        private var seed = 1
        val samples get() = if (rate == 3200) 160 else 320
        fun reset() { prev = start(); phi1 = 0.0; tail.fill(0.0); seed = 1 }

        /** One frame (8 bytes) → 16-bit PCM at 8 kHz. */
        fun decode(frame: IntArray): ShortArray {
            val out = ShortArray(samples); val subs = ArrayList<Params>()
            val p = prev
            if (rate == 3200) {
                val f = unpack3200(frame)
                val b = Params(f.wo, f.v2, f.eDb, f.lsp)
                subs.add(interp(p, b, 0.5, f.v1)); subs.add(b)
            } else {
                val f = unpack1600(frame)
                val a = Params(f.wo[0], f.v[1], f.eDb[0], mixLsp(p.lsp, f.lsp, 0.5))
                val b = Params(f.wo[1], f.v[3], f.eDb[1], f.lsp)
                val s1 = interp(p, a, 0.5, f.v[0]); s1.lsp = mixLsp(p.lsp, f.lsp, 0.25)
                val s3 = interp(a, b, 0.5, f.v[2]); s3.lsp = mixLsp(p.lsp, f.lsp, 0.75)
                subs.add(s1); subs.add(a); subs.add(s3); subs.add(b)
            }
            for (s in subs.indices) synth(subs[s], out, s * N)
            prev = subs.last()
            return out
        }

        fun synth(q: Params, out: ShortArray, at: Int) {
            val wo = if (q.voiced) q.wo else TWO_PI * 50 / FS
            val sp = lpcSpectrum(lspToLpc(q.lsp))
            val L = floor(PI / wo).toInt(); val r = wo * NDFT / TWO_PI
            val shape = DoubleArray(L + 1); var sum = 0.0
            for (m in 1..L) {
                val am = jsRound((m - 0.5) * r); val bm = min(jsRound((m + 0.5) * r), NDFT / 2)
                var e = 0.0; for (k in am until bm) e += sp.pw[k]
                shape[m] = e; sum += e
            }
            val power = 10.0.pow(q.eDb / 10)
            phi1 += N * wo; phi1 -= TWO_PI * floor(phi1 / TWO_PI)
            val re = DoubleArray(NDFT); val im = DoubleArray(NDFT)
            for (m in 1..L) {
                val k = jsRound(m * r); if (k >= NDFT / 2 || k < 1) continue
                val A = if (sum > 0) sqrt(2 * power * shape[m] / sum) else 0.0
                var th: Double
                if (q.voiced) th = m * phi1
                else { seed = (seed * 1103515245 + 12345) and 0x7fffffff; th = seed / 2147483648.0 * TWO_PI - PI }
                th += sp.phase[k]
                val mag = A * NDFT / 2
                re[k] += mag * cos(th); im[k] += mag * sin(th)
                re[NDFT - k] += mag * cos(th); im[NDFT - k] -= mag * sin(th)
            }
            fft512(re, im, true)
            for (n in 0 until N) {
                val y = tail[n] + re[NDFT - N + n] / NDFT * (n.toDouble() / N)
                tail[n] = re[n] / NDFT * (1 - n.toDouble() / N)
                val v = jsRound(y)
                out[at + n] = (if (v > 32767) 32767 else if (v < -32767) -32767 else v).toShort()
            }
        }
    }
}
