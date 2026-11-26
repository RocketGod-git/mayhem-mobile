package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// DRM parametric stereo (ETSI ES 201 980) as used by HDC: 32 QMF slots per frame instead of 30.

private const val SA_BANDS = 8
private const val PAN_BANDS = 20
private const val LINKS = 3
private const val SA_QMF = 23
private val SA_SCALE = intArrayOf(0, 1, 2, 3, 5, 7, 10, 13, 23)
private val PAN_SCALE = intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 22, 26, 32, 64)
private val PAN_CLASS = intArrayOf(0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4)
private val SA_QUANT = arrayOf(doubleArrayOf(0.0, 0.0), doubleArrayOf(0.0501, 0.1778), doubleArrayOf(0.0706, 0.2818), doubleArrayOf(0.0995, 0.4467),
    doubleArrayOf(0.1399, 0.5623), doubleArrayOf(0.1957, 0.7079), doubleArrayOf(0.2713, 0.8913), doubleArrayOf(0.3699, 1.0))
private val PAN_QUANT = arrayOf(
    doubleArrayOf(0.0, 0.0, 0.0, 0.0, 0.0), doubleArrayOf(0.1661, 0.1661, 0.3322, 0.3322, 0.3322), doubleArrayOf(0.3322, 0.3322, 0.6644, 0.8305, 0.8305),
    doubleArrayOf(0.4983, 0.6644, 0.9966, 1.4949, 1.6610), doubleArrayOf(0.6644, 0.9966, 1.4949, 2.1593, 2.4914), doubleArrayOf(0.8305, 1.3288, 2.1593, 2.9897, 3.4880),
    doubleArrayOf(0.9966, 1.8271, 2.8236, 3.8202, 4.6507), doubleArrayOf(1.3288, 2.3253, 3.4880, 4.6507, 5.8134),
)
private val FILTER = doubleArrayOf(0.65143905754106, 0.56471812200776, 0.48954165955695)
private val DELAY = intArrayOf(3, 4, 5)
private val FRACT = doubleArrayOf(0.43, 0.75, 0.347)
private const val PEAK_DECAY = 0.76592833836465
private const val SMOOTH = 0.25

private fun bandOf(scale: IntArray, b: Int): Int { var i = 0; while (scale[i + 1] <= b) i++; return i }
private val SA_INV = IntArray(SA_QMF) { bandOf(SA_SCALE, it) }
private val PAN_INV = IntArray(64) { bandOf(PAN_SCALE, it) }
private val DECAY = DoubleArray(SA_QMF) { b -> max(0.0, if (b < 3) 1.0 else 1 - 0.05 * (b - 2)) }
/** exp(-j pi a (k + 1/2)) */
val PHI_RE = DoubleArray(64) { cos(PI * 0.39 * (it + 0.5)) }
val PHI_IM = DoubleArray(64) { -sin(PI * 0.39 * (it + 0.5)) }
val Q_RE = DoubleArray(64 * LINKS) { cos(PI * FRACT[it % LINKS] * (it / LINKS + 0.5)) }
val Q_IM = DoubleArray(64 * LINKS) { -sin(PI * FRACT[it % LINKS] * (it / LINKS + 0.5)) }
private val HT_F_SA = buildHuff(PS_HUFF.getValue("fSa"))
private val HT_T_SA = buildHuff(PS_HUFF.getValue("tSa"))
private val HT_F_PAN = buildHuff(PS_HUFF.getValue("fPan"))
private val HT_T_PAN = buildHuff(PS_HUFF.getValue("tPan"))
private fun panGain(i: Int, c: Int): Double = (if (i < 0) -1 else 1) * PAN_QUANT[abs(i)][c]

class DrmPs {
    private var avail = false
    private var enSa = 0; private var enPan = 0; private var saDt = 0; private var panDt = 0
    private var lastSa = false; private var lastPan = false
    private val saData = IntArray(SA_BANDS); private val panData = IntArray(PAN_BANDS)
    private val sa = IntArray(SA_BANDS); private val pan = IntArray(PAN_BANDS)
    private val saPrev = IntArray(SA_BANDS); private val panPrev = IntArray(PAN_BANDS)
    private val saGood = IntArray(SA_BANDS); private val panGood = IntArray(PAN_BANDS)
    private var saErr = false; private var panErr = false
    private val delayIdx = intArrayOf(0, 0, 0)
    private val dRe = arrayOf(DoubleArray(SA_QMF), DoubleArray(SA_QMF)); private val dIm = arrayOf(DoubleArray(SA_QMF), DoubleArray(SA_QMF))
    private val d2Re = DoubleArray(LINKS * 5 * SA_QMF); private val d2Im = DoubleArray(LINKS * 5 * SA_QMF)
    private val prevNrg = DoubleArray(SA_QMF); private val prevPeak = DoubleArray(SA_QMF); private val peakFast = DoubleArray(SA_QMF)
    private val saRe = DoubleArray(32 * SA_QMF); private val saIm = DoubleArray(32 * SA_QMF)

    fun read(b: Bits) {
        avail = true
        enSa = b.bit(); enPan = b.bit()
        if (enSa != 0) { saDt = b.bit(); val h = if (saDt != 0) HT_T_SA else HT_F_SA; for (i in 0 until SA_BANDS) saData[i] = huffDecode(b, h) }
        if (enPan != 0) { panDt = b.bit(); val h = if (panDt != 0) HT_T_PAN else HT_F_PAN; for (i in 0 until PAN_BANDS) panData[i] = huffDecode(b, h) }
    }

    /** X (slots x 64, in place) -> left; right into R. guess: SBR data of this frame was bad. */
    fun apply(xr: DoubleArray, xi: DoubleArray, rr: DoubleArray, ri: DoubleArray, slots: Int, guess: Boolean) {
        if (!avail && !guess) {
            xr.copyInto(rr); xi.copyInto(ri)
            saPrev.fill(0); panPrev.fill(0)
            return
        }
        if (!guess) { saErr = false; panErr = false; deltaDecode() } else { saErr = true; panErr = true }
        avail = false
        sideSignal(xr, xi, slots)
        ambiance(xr, xi, rr, ri, slots)
        if (enSa != 0) { lastSa = true; sa.copyInto(saPrev) } else lastSa = false
        if (enPan != 0) { addPan(xr, xi, rr, ri, slots); lastPan = true; pan.copyInto(panPrev) } else lastPan = false
    }

    private fun clipSa(v: Int): Int { if (v < 0) { saErr = true; return 0 }; if (v > 7) { saErr = true; return 7 }; return v }
    private fun clipPan(v: Int): Int { if (v < -7) { panErr = true; return -7 }; if (v > 7) { panErr = true; return 7 }; return v }

    private fun deltaDecode() {
        if (enSa != 0) {
            if (saDt != 0 && !lastSa) enSa = 0
            else if (saDt != 0) sa[0] = clipSa(saPrev[0] + saData[0])
            else sa[0] = clipSa(saData[0])
            for (i in 1 until SA_BANDS) {
                if (saDt != 0 && lastSa) sa[i] = clipSa(saPrev[i] + saData[i])
                else if (saDt == 0) sa[i] = clipSa(sa[i - 1] + saData[i])
            }
        }
        if (saErr) { panErr = true; enPan = if (lastPan) 1 else 0; enSa = if (lastSa) 1 else 0 }
        if (enSa != 0) { if (saErr) saGood.copyInto(sa) else sa.copyInto(saGood) }
        if (enPan != 0) {
            if (panDt != 0 && !lastPan) enPan = 0
            else if (panDt != 0) pan[0] = clipPan(panPrev[0] + panData[0])
            else pan[0] = clipPan(panData[0])
            for (i in 1 until PAN_BANDS) {
                if (panDt != 0 && lastPan) pan[i] = clipPan(panPrev[i] + panData[i])
                else if (panDt == 0) pan[i] = clipPan(pan[i - 1] + panData[i])
            }
            if (panErr) panGood.copyInto(pan) else pan.copyInto(panGood)
        }
    }

    private fun sideSignal(xr: DoubleArray, xi: DoubleArray, slots: Int) {
        val idx = intArrayOf(0, 0, 0); val slope = DoubleArray(LINKS)
        for (b in 0 until SA_QMF) {
            for (k in 0 until LINKS) idx[k] = delayIdx[k]
            for (k in 0 until LINKS) slope[k] = DECAY[b] * FILTER[k]
            for (s in 0 until slots) {
                val inR = xr[s * 64 + b]; val inI = xi[s * 64 + b]; val power = inR * inR + inI * inI
                peakFast[b] = max(peakFast[b] * PEAK_DECAY, power)
                prevPeak[b] += (peakFast[b] - power - prevPeak[b]) * SMOOTH; val peak = prevPeak[b]
                prevNrg[b] += (power - prevNrg[b]) * SMOOTH; val nrg = prevNrg[b]
                val ratio = if (peak * 1.5 <= nrg) 1.5625 else nrg / (peak * 1.5) * 1.5625
                val t0r = dRe[0][b]; val t0i = dIm[0][b]
                dRe[0][b] = dRe[1][b]; dIm[0][b] = dIm[1][b]
                dRe[1][b] = inR; dIm[1][b] = inI
                var r0r = t0r * PHI_RE[b] - t0i * PHI_IM[b]; var r0i = t0r * PHI_IM[b] + t0i * PHI_RE[b]
                for (k in 0 until LINKS) {
                    val at = (k * 5 + idx[k]) * SA_QMF + b; val dr = d2Re[at]; val di = d2Im[at]
                    val qr = Q_RE[b * LINKS + k]; val qi = Q_IM[b * LINKS + k]
                    val tr = dr * qr - di * qi - slope[k] * r0r; val ti = dr * qi + di * qr - slope[k] * r0i
                    d2Re[at] = r0r + slope[k] * tr; d2Im[at] = r0i + slope[k] * ti
                    r0r = tr; r0i = ti
                }
                saRe[s * SA_QMF + b] = r0r * ratio; saIm[s * SA_QMF + b] = r0i * ratio
                for (k in 0 until LINKS) if (++idx[k] >= DELAY[k]) idx[k] = 0
            }
        }
        for (k in 0 until LINKS) delayIdx[k] = idx[k]
    }

    private fun ambiance(xr: DoubleArray, xi: DoubleArray, rr: DoubleArray, ri: DoubleArray, slots: Int) {
        xr.copyInto(rr); xi.copyInto(ri)
        if (enSa == 0) return
        for (b in 0 until SA_QMF) {
            val f = SA_INV[b]; val c = if (b != 0) 1 else 0
            var sa = SA_QUANT[saPrev[f]][c]; var dir = sqrt(1 - sa * sa)
            val saN = SA_QUANT[this.sa[f]][c]; val dirN = sqrt(1 - saN * saN)
            val kSa = (saN - sa) / slots; val kDir = (dirN - dir) / slots
            for (s in 0 until slots) {
                val x = s * 64 + b; val y = s * SA_QMF + b
                val lr = xr[x]; val li = xi[x]; val sr = saRe[y]; val si = saIm[y]
                rr[x] = lr * dir - sr * sa; ri[x] = li * dir - si * sa
                xr[x] = lr * dir + sr * sa; xi[x] = li * dir + si * sa
                sa += kSa; dir += kDir
            }
        }
    }

    private fun addPan(xr: DoubleArray, xi: DoubleArray, rr: DoubleArray, ri: DoubleArray, slots: Int) {
        for (b in 0 until 64) {
            val f = PAN_INV[b]; val c = PAN_CLASS[f]
            val g0 = panGain(panPrev[f], c); val g1 = panGain(pan[f], c)
            var base = 2.0.pow(g0)
            val step = 2.0.pow((g1 - g0) / slots)
            for (s in 0 until slots) {
                val x = s * 64 + b; val c2 = 2 / (1 + base); val c1 = c2 * base
                xr[x] *= c1; xi[x] *= c1; rr[x] *= c2; ri[x] *= c2
                base *= step
            }
        }
    }
}
