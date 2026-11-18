package com.rocketgod.mayhem.core.cell

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Cell search on the central 6 RBs at 1.92 MS/s (N_FFT 128): PSS (36.211 6.11.1), SSS (6.11.2), CFO from the cyclic
 * prefix (6.12), and a per half-frame PSS map that survives sample drops (a drop only ever moves the PSS earlier).
 */
const val LOW_FS = 1_920_000
val LOW = Numerology(LOW_FS)
val HALF = LOW.halfFrame      // 9600

/** d_u(n) of 6.11.1.1, roots 25/29/34 for N_ID2 0/1/2. */
fun pssFreq(nid2: Int): Pair<FloatArray, FloatArray> {
    val u = intArrayOf(25, 29, 34)[nid2]; val re = FloatArray(62); val im = FloatArray(62)
    for (n in 0 until 62) {
        val a = if (n < 31) -Math.PI * u * n * (n + 1) / 63 else -Math.PI * u * (n + 1) * (n + 2) / 63
        re[n] = cos(a).toFloat(); im[n] = sin(a).toFloat()
    }
    return re to im
}
/** Subcarrier offsets of the 62 PSS/SSS elements from DC (DC skipped). */
val K62 = IntArray(62) { if (it < 31) it - 31 else it - 30 }

/** Time-domain PSS of one N_FFT symbol (no CP), unit energy per sample on average. */
fun pssTime(nid2: Int, nfft: Int): Pair<FloatArray, FloatArray> {
    val re = FloatArray(nfft); val im = FloatArray(nfft); val (pr, pi) = pssFreq(nid2)
    for (n in 0 until 62) { val b = (K62[n] + nfft) % nfft; re[b] = pr[n]; im[b] = -pi[n] }
    Dsp.fft(re, im)
    val s = (1 / sqrt(nfft.toDouble())).toFloat()
    for (i in 0 until nfft) { re[i] *= s; im[i] *= -s }
    return re to im
}

private fun mseq(taps: IntArray): IntArray {
    val x = arrayListOf(0, 0, 0, 0, 1)
    for (i in 0 until 26) x.add(taps.sumOf { x[i + it] } % 2)
    return IntArray(x.size) { 1 - 2 * x[it] }
}
private val S_T = mseq(intArrayOf(2, 0)); private val C_T = mseq(intArrayOf(3, 0)); private val Z_T = mseq(intArrayOf(4, 2, 1, 0))

/** d(0..61) of 6.11.2.1 for subframe 0 (sub5 false) or 5. */
fun sssSeq(nid1: Int, nid2: Int, sub5: Boolean): IntArray {
    val qp = nid1 / 30; val q = (nid1 + qp * (qp + 1) / 2) / 30; val mp = nid1 + q * (q + 1) / 2
    val m0 = mp % 31; val m1 = (m0 + mp / 31 + 1) % 31; val d = IntArray(62)
    for (n in 0 until 31) {
        val s0 = S_T[(n + m0) % 31]; val s1 = S_T[(n + m1) % 31]; val c0 = C_T[(n + nid2) % 31]; val c1 = C_T[(n + nid2 + 3) % 31]
        val z0 = Z_T[(n + (m0 % 8)) % 31]; val z1 = Z_T[(n + (m1 % 8)) % 31]
        if (!sub5) { d[2 * n] = s0 * c0; d[2 * n + 1] = s1 * c1 * z0 } else { d[2 * n] = s1 * c0; d[2 * n + 1] = s0 * c1 * z1 }
    }
    return d
}
private val BANK = arrayOfNulls<List<IntArray>>(3)
@Synchronized private fun bank(nid2: Int): List<IntArray> =
    BANK[nid2] ?: (0 until 168).flatMap { listOf(sssSeq(it, nid2, false), sssSeq(it, nid2, true)) }.also { BANK[nid2] = it }

/** Windowed-sinc low-pass decimator from fs to 1.92 MS/s (keeps the central 1.08 MHz). */
fun decimate(xr: FloatArray, xi: FloatArray, fs: Int): Pair<FloatArray, FloatArray> {
    val dd = Math.round(fs.toDouble() / LOW_FS).toInt()
    if (dd <= 1) return xr to xi
    val taps = 16 * dd + 1; val h = FloatArray(taps); val fc = 0.62e6 / fs; val mid = (taps - 1) / 2.0
    var sum = 0.0
    for (i in 0 until taps) {
        val t = i - mid; val w = 0.42 - 0.5 * cos(2 * Math.PI * i / (taps - 1)) + 0.08 * cos(4 * Math.PI * i / (taps - 1))
        val v = (if (t == 0.0) 2 * fc else sin(2 * Math.PI * fc * t) / (Math.PI * t)) * w
        h[i] = v.toFloat(); sum += h[i]
    }
    for (i in 0 until taps) h[i] = (h[i] / sum).toFloat()
    val n = (xr.size - taps) / dd + 1
    val yr = FloatArray(max(0, n)); val yi = FloatArray(max(0, n))
    for (o in 0 until n) {
        var ar = 0f; var ai = 0f; val s = o * dd
        for (k in 0 until taps) { ar += h[k] * xr[s + k]; ai += h[k] * xi[s + k] }
        yr[o] = ar; yi[o] = ai
    }
    return yr to yi
}
/** Delay of the decimator output: output o is centered on input sample o * D + delayIn. */
fun decimDelay(fs: Int): Int { val dd = Math.round(fs.toDouble() / LOW_FS).toInt(); return if (dd <= 1) 0 else 8 * dd }

/** CFO in Hz from the CP repetition over the whole buffer: x[n] x*[n + N] (unambiguous +-7.5 kHz). */
fun cpCfo(xr: FloatArray, xi: FloatArray, fs: Int): Pair<Double, Double> {
    val nn = Math.round(fs / 15_000.0).toInt()
    var ar = 0.0; var ai = 0.0; var p = 0.0
    var n = 0
    while (n + nn < xr.size) {
        val a = xr[n].toDouble(); val b = xi[n].toDouble(); val c = xr[n + nn].toDouble(); val d = xi[n + nn].toDouble()
        ar += a * c + b * d; ai += b * c - a * d; p += a * a + b * b
        n++
    }
    return (-atan2(ai, ar) * fs / (2 * Math.PI * nn)) to (if (p > 0) hypot(ar, ai) / p else 0.0)
}
/** Multiplies by exp(-j 2 pi f n / fs) in place, n counted from n0, over the first `len` samples. */
fun rotate(xr: FloatArray, xi: FloatArray, f: Double, fs: Int, n0: Int = 0, len: Int = xr.size) {
    if (f == 0.0) return
    val w = -2 * Math.PI * f / fs
    var cr = cos(w * n0); var ci = sin(w * n0)
    val dr = cos(w); val di = sin(w)
    for (n in 0 until len) {
        val a = xr[n]; val b = xi[n]
        xr[n] = (a * cr - b * ci).toFloat(); xi[n] = (a * ci + b * cr).toFloat()
        val t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t
        if ((n and 1023) == 1023) { val m = hypot(cr, ci); cr /= m; ci /= m }
    }
}

class PssHit(val nid2: Int, val pos: Int, val score: Double, val cfo: Double)
private const val FFT_N = 32_768
private val PSS_SPEC = arrayOfNulls<Pair<FloatArray, FloatArray>>(3)
private val PSS_T = arrayOfNulls<Pair<FloatArray, FloatArray>>(3)
@Synchronized private fun pssSpec(nid2: Int): Pair<FloatArray, FloatArray> = PSS_SPEC[nid2] ?: run {
    val (tr, ti) = pssTime(nid2, 128); val re = FloatArray(FFT_N); val im = FloatArray(FFT_N)
    System.arraycopy(tr, 0, re, 0, 128); System.arraycopy(ti, 0, im, 0, 128); Dsp.fft(re, im)
    (re to im).also { PSS_SPEC[nid2] = it }
}
@Synchronized private fun pssT(nid2: Int): Pair<FloatArray, FloatArray> = PSS_T[nid2] ?: pssTime(nid2, 128).also { PSS_T[nid2] = it }

/**
 * PSS search over two half-frames from `start` of a 1.92 MS/s buffer, folded modulo 5 ms. Returns peaks (position of
 * the PSS useful part, relative to `start`, in 0..9599) for every root and each extra CFO hypothesis (Hz), strongest first.
 */
fun pssSearch(yr: FloatArray, yi: FloatArray, start: Int, cfos: DoubleArray = doubleArrayOf(0.0)): List<PssHit> {
    val len = 2 * HALF + 128; val hits = ArrayList<PssHit>()
    if (start + len > yr.size) return hits
    val ar = FloatArray(FFT_N); val ai = FloatArray(FFT_N); val cr = FloatArray(FFT_N); val ci = FloatArray(FFT_N); val fold = FloatArray(HALF)
    for (cfo in cfos) {
        ar.fill(0f); ai.fill(0f)
        System.arraycopy(yr, start, ar, 0, len); System.arraycopy(yi, start, ai, 0, len)
        rotate(ar, ai, cfo, LOW_FS, 0, len)
        Dsp.fft(ar, ai)
        for (nid2 in 0 until 3) {
            val (pr, pi) = pssSpec(nid2)
            // correlation = IFFT(Y conj(P)); IFFT via conj(FFT(conj(.)))
            for (i in 0 until FFT_N) { cr[i] = ar[i] * pr[i] + ai[i] * pi[i]; ci[i] = -(ai[i] * pr[i] - ar[i] * pi[i]) }
            Dsp.fft(cr, ci)
            for (i in 0 until HALF) fold[i] = (hypot(cr[i].toDouble(), ci[i].toDouble()) + hypot(cr[i + HALF].toDouble(), ci[i + HALF].toDouble())).toFloat()
            val sorted = fold.copyOf().also { it.sort() }; val med = sorted[HALF shr 1].takeIf { it != 0f } ?: 1e-9f
            // up to three separated peaks per root (co-channel cells on the same root sit a few samples apart)
            val taken = ArrayList<Int>()
            for (r in 0 until 3) {
                var best = -1; var bv = 0f
                for (i in 0 until HALF) if (fold[i] > bv && taken.all { t -> min(abs(t - i), HALF - abs(t - i)) > 3 }) { bv = fold[i]; best = i }
                if (best < 0) break
                val score = bv.toDouble() / med
                if (r > 0) { val f0 = hits.firstOrNull { it.nid2 == nid2 && it.cfo == cfo }; if (f0 != null && score < 0.45 * f0.score) break }
                taken.add(best)
                hits.add(PssHit(nid2, best, score, cfo))
            }
        }
    }
    return hits.sortedByDescending { it.score }
}

class PssLocal(val pos: Double, val peak: Double, val snr: Double)
/** Correlation magnitude of root nid2 at positions lo..hi of the buffer; returns the best position, sub-sample. */
fun pssLocal(yr: FloatArray, yi: FloatArray, nid2: Int, lo0: Double, hi0: Double): PssLocal? {
    val (tr, ti) = pssT(nid2)
    val lo = max(0, floor(lo0).toInt()); val hi = min(yr.size - 128, ceil(hi0).toInt())
    if (hi < lo + 2) return null
    val mags = DoubleArray(hi - lo + 1)
    for (p in lo..hi) {
        var ar = 0f; var ai = 0f
        for (m in 0 until 128) { val a = yr[p + m]; val b = yi[p + m]; val c = tr[m]; val d = ti[m]; ar += a * c + b * d; ai += b * c - a * d }
        mags[p - lo] = hypot(ar.toDouble(), ai.toDouble())
    }
    var j = 0
    for (i in 1 until mags.size) if (mags[i] > mags[j]) j = i
    val sorted = mags.copyOf().also { it.sort() }; val med = sorted[mags.size shr 1].takeIf { it != 0.0 } ?: 1e-9
    var frac = 0.0
    if (j > 0 && j < mags.size - 1) { val a = mags[j - 1]; val b = mags[j]; val c = mags[j + 1]; val den = a - 2 * b + c; if (den < 0) frac = 0.5 * (a - c) / den }
    return PssLocal(lo + j + frac, mags[j], mags[j] / med)
}

class HalfFrame(val h: Int, val pos: Double, val snr: Double)
/**
 * Follows the PSS through the buffer one half-frame at a time, from a position known modulo 5 ms. A gap re-derives
 * the true half-frame count, so h stays the count of 5 ms periods since the first one even across sample drops.
 */
fun halfFrameMap(yr: FloatArray, yi: FloatArray, nid2: Int, pos0: Int): List<HalfFrame> {
    val out = ArrayList<HalfFrame>()
    var pred = pos0.toDouble(); var h = 0; var miss = 0; var last: HalfFrame? = null
    while (pred + 200 < yr.size) {
        val r = pssLocal(yr, yi, nid2, pred - (if (miss > 0) 1200 else 320), pred + 16)
        if (r == null || r.snr < 3.2) { miss++; pred += HALF; h++; if (miss > 3) break; continue }
        if (last != null && miss > 0) h = last.h + Math.round((r.pos - last.pos) / HALF + 0.25).toInt()
        val hf = HalfFrame(h, r.pos, r.snr)
        last = hf
        out.add(hf)
        miss = 0; pred = r.pos + HALF; h++
    }
    return out
}

/** One SSS hypothesis: N_ID1, whether the even half-frames carry subframe 0, and its score. */
class SssScore(val nid1: Int, val evenSf0: Boolean, val score: Double)
/**
 * Coherent SSS scores over the mapped half-frames (36.211 6.11.2): the SSS sits `lag` samples before the PSS (one
 * symbol in FDD, three in TDD) and is equalized with the PSS channel. Sorted best first.
 */
fun sssIdentify(yr: FloatArray, yi: FloatArray, nid2: Int, map: List<HalfFrame>, maxN: Int = 40, lag: Int = 128 + LOW.cpn): List<SssScore> {
    val n0 = 128; val bk = bank(nid2); val (pr, pi) = pssFreq(nid2)
    val acc = DoubleArray(336); val sr = FloatArray(n0); val si = FloatArray(n0); val qr = FloatArray(n0); val qi = FloatArray(n0)
    val z = FloatArray(62); val hr = FloatArray(62); val hi = FloatArray(62)
    for (hf in map.take(maxN)) {
        val s = jsRound(hf.pos); val a = s - lag - 1; val b = s - 1
        if (a < 0 || b + n0 > yr.size) continue
        System.arraycopy(yr, a, sr, 0, n0); System.arraycopy(yi, a, si, 0, n0); System.arraycopy(yr, b, qr, 0, n0); System.arraycopy(yi, b, qi, 0, n0)
        Dsp.fft(sr, si); Dsp.fft(qr, qi)
        for (n in 0 until 62) { val j = (K62[n] + n0) % n0; val ur = qr[j]; val ui = qi[j]; hr[n] = ur * pr[n] + ui * pi[n]; hi[n] = ui * pr[n] - ur * pi[n] }
        for (n in 0 until 62) {
            var cr = 0f; var ci = 0f
            for (d in -1..1) if (n + d in 0..61) { cr += hr[n + d]; ci += hi[n + d] }
            cr /= 3; ci /= 3
            val j = (K62[n] + n0) % n0; val yr2 = sr[j]; val yi2 = si[j]
            z[n] = (yr2 * cr + yi2 * ci) / max(cr * cr + ci * ci, 1e-9f)
        }
        val even = hf.h % 2 == 0
        for (i in 0 until 168) {
            var m0 = 0.0; var m1 = 0.0; val d0 = bk[2 * i]; val d1 = bk[2 * i + 1]
            for (n in 0 until 62) { m0 += d0[n] * z[n]; m1 += d1[n] * z[n] }
            if (even) { acc[2 * i] += m0; acc[2 * i + 1] += m1 } else { acc[2 * i] += m1; acc[2 * i + 1] += m0 }
        }
    }
    return (0 until 336).map { SssScore(it shr 1, it % 2 == 0, acc[it]) }.sortedByDescending { it.score }
}
