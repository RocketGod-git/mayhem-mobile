package com.rocketgod.mayhem.core.hd

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

private const val N = 1024
private const val H = N / 2
private const val K = N / 2 + 1
private const val EPS = 1e-12
private val SQRT2 = sqrt(2.0)

/** Stereo to 5.1 (L, R, C, LFE, Ls, Rs), an active matrix decoder steering each frequency bin. */
// lossless before the surround delay: L + .707 C + .707 Ls = Lt, R + .707 C - .707 Rs = Rt
class Upmixer(rate: Int = 48_000, center: Double = 0.85, ambience: Double = 0.5, delayMs: Double = 10.0, lfe: Double = 0.5) {
    /** Samples from an input sample to the same sample in every output (the surrounds add their delay). */
    val latency = N
    private val win = FloatArray(N) { sqrt(0.5 - 0.5 * cos(2 * PI * it / N)).toFloat() }
    private val inL = FloatArray(N)
    private val inR = FloatArray(N)
    private var fill = N - H
    private val ola = Array(6) { FloatArray(N) }
    private val ready = Array(6) { FloatArray(H) }
    private var rp = 0
    private val pLL = FloatArray(K)
    private val pRR = FloatArray(K)
    private val cRe = FloatArray(K)
    private val cIm = FloatArray(K)
    private val re = FloatArray(N)
    private val im = FloatArray(N)
    private val specRe = Array(6) { FloatArray(K) }
    private val specIm = Array(6) { FloatArray(K) }
    private val Lr = FloatArray(K)
    private val Li = FloatArray(K)
    private val Rr = FloatArray(K)
    private val Ri = FloatArray(K)
    private val lfeW = FloatArray(K)
    private val hiW = FloatArray(K)
    private val alpha = exp(-(H.toDouble() / rate) / 0.04)
    private val centerAmt = center
    private val ambAmt = ambience
    private val lfeAmt = lfe
    private val dly = max(0, (delayMs * rate / 1000).roundToInt())
    private val dlyL = FloatArray(dly + 1)
    private val dlyR = FloatArray(dly + 1)
    private var dp = 0

    init {
        for (k in 0 until K) {
            val f = k.toDouble() * rate / N
            lfeW[k] = (if (f <= 80) 1.0 else if (f >= 160) 0.0 else 0.5 + 0.5 * cos(PI * (f - 80) / 80)).toFloat()
            // surrounds roll off above 7 kHz (the fronts keep it), as matrix decoders do against leakage
            hiW[k] = (if (f <= 7000) 1.0 else if (f >= 12000) 0.25 else 1 - 0.75 * (f - 7000) / 5000).toFloat()
        }
    }

    fun reset() {
        inL.fill(0f); inR.fill(0f); fill = N - H; rp = 0
        for (a in ola) a.fill(0f)
        for (a in ready) a.fill(0f)
        pLL.fill(0f); pRR.fill(0f); cRe.fill(0f); cIm.fill(0f)
        dlyL.fill(0f); dlyR.fill(0f); dp = 0
    }

    /** One block of stereo in, the same length of 5.1 out. */
    fun process(l: FloatArray, r: FloatArray, n: Int = l.size): Array<FloatArray> {
        val out = Array(6) { FloatArray(n) }
        val oL = out[0]; val oR = out[1]; val oC = out[2]; val oF = out[3]; val oLs = out[4]; val oRs = out[5]
        val rd = ready; val D = dly
        for (i in 0 until n) {
            inL[fill] = l[i]; inR[fill] = r[i]
            val j = rp++
            oL[i] = rd[0][j]; oR[i] = rd[1][j]; oC[i] = rd[2][j]; oF[i] = rd[3][j]
            if (D != 0) {
                oLs[i] = dlyL[dp]; oRs[i] = dlyR[dp]
                dlyL[dp] = rd[4][j]; dlyR[dp] = rd[5][j]; dp = (dp + 1) % D
            } else { oLs[i] = rd[4][j]; oRs[i] = rd[5][j] }
            if (++fill == N) { frame(); fill = N - H; rp = 0 }
        }
        return out
    }

    private fun frame() {
        for (i in 0 until N) { re[i] = inL[i] * win[i]; im[i] = inR[i] * win[i] }
        Dsp.fft(re, im)
        val a = alpha; val b = 1 - a
        for (k in 0 until K) {
            val m = (N - k) % N
            Lr[k] = 0.5f * (re[k] + re[m]); Li[k] = 0.5f * (im[k] - im[m])
            Rr[k] = 0.5f * (im[k] + im[m]); Ri[k] = -0.5f * (re[k] - re[m])
            pLL[k] = (a * pLL[k] + b * (Lr[k] * Lr[k] + Li[k] * Li[k])).toFloat()
            pRR[k] = (a * pRR[k] + b * (Rr[k] * Rr[k] + Ri[k] * Ri[k])).toFloat()
            cRe[k] = (a * cRe[k] + b * (Lr[k] * Rr[k] + Li[k] * Ri[k])).toFloat()
            cIm[k] = (a * cIm[k] + b * (Li[k] * Rr[k] - Lr[k] * Ri[k])).toFloat()
        }
        for (k in 0 until K) {
            // the statistics over three neighboring bins, which keeps the masks from fluttering
            var ll = 0.0; var rr = 0.0; var cr = 0.0; var ci = 0.0
            for (q in max(0, k - 1)..min(K - 1, k + 1)) { ll += pLL[q]; rr += pRR[q]; cr += cRe[q]; ci += cIm[q] }
            val g = sqrt(ll * rr) + EPS; val phi = cr / g; val coh = min(1.0, hypot(cr, ci) / g)
            val bal = abs(ll - rr) / (ll + rr + EPS)
            val inPh = if (phi > 0) phi else 0.0; val outPh = if (phi < 0) -phi else 0.0
            val gc = centerAmt * inPh * inPh * (1 - bal)
            val ga = min(1.0, outPh + ambAmt * (1 - coh) * (1 - bal)) * hiW[k]
            val mr = 0.5 * (Lr[k] + Rr[k]); val mi = 0.5 * (Li[k] + Ri[k])
            val fLr = Lr[k] - gc * mr; val fLi = Li[k] - gc * mi; val fRr = Rr[k] - gc * mr; val fRi = Ri[k] - gc * mi
            val s = SQRT2 * ga; val f = 1 - ga; val w = lfeW[k] * lfeAmt
            specRe[0][k] = (f * fLr).toFloat(); specIm[0][k] = (f * fLi).toFloat()
            specRe[1][k] = (f * fRr).toFloat(); specIm[1][k] = (f * fRi).toFloat()
            specRe[2][k] = (SQRT2 * gc * mr).toFloat(); specIm[2][k] = (SQRT2 * gc * mi).toFloat()
            specRe[3][k] = (w * mr).toFloat(); specIm[3][k] = (w * mi).toFloat()
            specRe[4][k] = (s * fLr).toFloat(); specIm[4][k] = (s * fLi).toFloat()
            specRe[5][k] = (-s * fRr).toFloat(); specIm[5][k] = (-s * fRi).toFloat()
        }
        var c = 0
        while (c < 6) { inverse(c, c + 1); c += 2 }
        for (ch in 0 until 6) {
            val o = ola[ch]
            System.arraycopy(o, 0, ready[ch], 0, H)
            System.arraycopy(o, H, o, 0, N - H); o.fill(0f, N - H)
        }
        System.arraycopy(inL, H, inL, 0, N - H); System.arraycopy(inR, H, inR, 0, N - H)
    }

    /** Two real channels' half spectra back to time, windowed and added into their overlap buffers. */
    private fun inverse(x: Int, y: Int) {
        val xr = specRe[x]; val xi = specIm[x]; val yr = specRe[y]; val yi = specIm[y]; val ox = ola[x]; val oy = ola[y]
        // Z = X + jY over the full spectrum, conjugated so the forward FFT runs as an inverse
        for (k in 0 until K) {
            re[k] = xr[k] - yi[k]; im[k] = -(xi[k] + yr[k])
            if (k > 0 && k < N / 2) { val m = N - k; re[m] = xr[k] + yi[k]; im[m] = -(-xi[k] + yr[k]) }
        }
        Dsp.fft(re, im)
        val s = 1f / N
        for (i in 0 until N) { ox[i] += re[i] * s * win[i]; oy[i] -= im[i] * s * win[i] }
    }
}
