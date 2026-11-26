package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

// HDC spectral band replication: 22.05 kHz AAC core -> 44.1 kHz, plus DRM-style parametric stereo for mono streams.

typealias HdcSbrPayload = HdcSbrData

private val H: Map<String, HuffTree> = SBR_HUFF.mapValues { buildHuff(it.value) }
private val H_T_ENV15 = H.getValue("tEnv15"); private val H_F_ENV15 = H.getValue("fEnv15")
private val H_T_ENV_BAL15 = H.getValue("tEnvBal15"); private val H_F_ENV_BAL15 = H.getValue("fEnvBal15")
private val H_T_ENV30 = H.getValue("tEnv30"); private val H_F_ENV30 = H.getValue("fEnv30")
private val H_T_ENV_BAL30 = H.getValue("tEnvBal30"); private val H_F_ENV_BAL30 = H.getValue("fEnvBal30")
private val H_T_NOISE30 = H.getValue("tNoise30"); private val H_T_NOISE_BAL30 = H.getValue("tNoiseBal30")

private const val FIXFIX = 0
private const val FIXVAR = 1
private const val VARFIX = 2
private const val VARVAR = 3
private const val SLOTS = 32
private const val HFGEN = 8
private const val HFADJ = 2
private const val ROWS = SLOTS + HFGEN
private val LIM_GAIN = doubleArrayOf(0.70795, 1.0, 1.41254, 1e10)
private val H_SMOOTH = doubleArrayOf(0.33333333333333, 0.30150283239582, 0.21816949906249, 0.11516383427084, 0.03183050093751)
private val BW_NEW = doubleArrayOf(0.0, 0.75, 0.9, 0.98)
private val SINE_RE = intArrayOf(1, 0, -1, 0)
private val SINE_IM = intArrayOf(0, 1, 0, -1)
private val TWO_50 = 2.0.pow(50)

private class ChFrame(
    val frameClass: Int, val le: Int, val lq: Int, val tE: IntArray, val tQ: IntArray, val f: IntArray, val pointer: Int, val lA: Int,
    var dfEnv: IntArray, var dfNoise: IntArray, var invf: IntArray, val ampRes: Int,
    var E: List<IntArray>, var Q: List<IntArray>, var harmFlag: Int, var harm: IntArray,
    var eOrig: List<DoubleArray>, var qOrig: List<DoubleArray>,
) {
    fun copy() = ChFrame(frameClass, le, lq, tE.copyOf(), tQ.copyOf(), f.copyOf(), pointer, lA, dfEnv, dfNoise, invf, ampRes, E, Q, harmFlag, harm, eOrig, qOrig)
}

private class ChState {
    val qa = QmfAnalysis()
    val qs = QmfSynthesis()
    val xr = DoubleArray(ROWS * 64)
    val xi = DoubleArray(ROWS * 64)
    val ePrev = IntArray(64)
    val qPrev = IntArray(5)
    var fPrev = 0
    var prevLaLast = false
    val sIdxPrev = IntArray(64)
    val invfPrev = IntArray(5)
    val bwPrev = DoubleArray(5)
    val gHist = MutableList(5) { DoubleArray(64) }
    val qHist = MutableList(5) { DoubleArray(64) }
    var histValid = false
    var noiseIdx = 0
    var sineIdx = 0
    var endPrev = 16
    var aPrev = 1
}

/** scale: core PCM full scale mapped to the 16-bit range the SBR envelopes are coded for. */
class HdcSbr(private val scale: Double = 32768.0) {
    private var hdr = SbrHeader()
    private var headerSeen = false
    private var tab: SbrTables? = null
    private var reset = true
    private var ch: List<ChState> = emptyList()
    private var nch = 0
    private var kxPrev = 0
    private var mPrev = 0
    private var ps = DrmPs()
    private var psUsed = false
    private var psSynth = QmfSynthesis()
    private val alpha0r = DoubleArray(64); private val alpha0i = DoubleArray(64)
    private val alpha1r = DoubleArray(64); private val alpha1i = DoubleArray(64)
    private val xR = DoubleArray(SLOTS * 64); private val xI = DoubleArray(SLOTS * 64)
    private val rR = DoubleArray(SLOTS * 64); private val rI = DoubleArray(SLOTS * 64)
    /** The last parsed frame per channel, replayed for a lost one. */
    private var good: List<ChFrame>? = null
    /** Bit position where the last SBR parse stopped (for bench checks). */
    var lastEnd = -1
    /** Why the last frame was not SBR-processed, "" when it was. */
    var lastSkip = ""

    /** conceal: for a lost frame, the core's energy against its last good one; above 0 the last envelopes play on. */
    fun process(pcm: List<FloatArray>, stereo: Boolean, sbr: HdcSbrPayload?, conceal: Double = 0.0): List<FloatArray> {
        val nch = if (stereo && pcm.size > 1) 2 else 1
        if (nch != this.nch) {
            this.nch = nch
            ch = List(nch) { ChState() }
            headerSeen = false; tab = null; reset = true; kxPrev = 0; mPrev = 0
            ps = DrmPs(); psUsed = false; psSynth = QmfSynthesis(); good = null
        }
        var frames: List<ChFrame>? = null
        lastEnd = -1; lastSkip = ""
        var parsedOk = false
        if (sbr != null) {
            try { frames = parse(sbr, nch); parsedOk = frames != null } catch (e: Exception) { frames = null; lastSkip = "overrun" }
        } else {
            val g = good
            if (conceal > 0 && g != null && tab != null) { frames = concealed(g, conceal); lastSkip = "concealed" }
            else lastSkip = "no payload"
        }
        if (parsedOk) good = frames
        val t = tab
        val run = frames != null && t != null
        val out = ArrayList<FloatArray>()
        for (c in 0 until nch) {
            val s = ch[c]
            analyze(s, pcm[c], if (run) t.kx else 32)
            if (run) {
                hfGenerate(s, frames[c], t)
                hfAdjust(s, frames[c], t)
            }
            buildX(s, if (run) frames[c] else null, t, xR, xI)
            if (c == 0 && nch == 1 && psUsed) {
                ps.apply(xR, xI, rR, rI, SLOTS, !parsedOk)
            }
            val o = FloatArray(2048)
            for (l in 0 until SLOTS) s.qs.slot(xR, xI, l * 64, o, l * 64, 1 / scale)
            out.add(o)
            if (c == 0 && nch == 1 && psUsed) {
                val r = FloatArray(2048)
                for (l in 0 until SLOTS) psSynth.slot(rR, rI, l * 64, r, l * 64, 1 / scale)
                out.add(r)
            }
        }
        if (run) {
            for (c in 0 until nch) savePrev(ch[c], frames[c], t)
            kxPrev = t.kx; mPrev = t.m; reset = false
        }
        for (s in ch) {
            System.arraycopy(s.xr, SLOTS * 64, s.xr, 0, HFGEN * 64); s.xr.fill(0.0, HFGEN * 64)
            System.arraycopy(s.xi, SLOTS * 64, s.xi, 0, HFGEN * 64); s.xi.fill(0.0, HFGEN * 64)
        }
        return out
    }

    // ---- bitstream ----

    private fun parse(p: HdcSbrPayload, nch: Int): List<ChFrame>? {
        val b = Bits(p.buf, p.bitEnd)
        b.pos = p.bitPos
        if (b.bit() != 0) {
            val h = SbrHeader()
            h.ampRes = b.bit(); h.startFreq = b.read(4); h.stopFreq = b.read(4); h.xoverBand = b.read(3); b.skip(2)
            val x1 = b.bit(); val x2 = b.bit()
            if (x1 != 0) { h.freqScale = b.read(2); h.alterScale = b.bit(); h.noiseBands = b.read(2) }
            if (x2 != 0) { h.limiterBands = b.read(2); h.limiterGains = b.read(2); h.interpolFreq = b.bit(); h.smoothingMode = b.bit() }
            val o = hdr
            val changed = !headerSeen || o.startFreq != h.startFreq || o.stopFreq != h.stopFreq || o.freqScale != h.freqScale ||
                o.alterScale != h.alterScale || o.xoverBand != h.xoverBand || o.noiseBands != h.noiseBands
            if (changed) {
                val nt = buildTables(h)
                if (nt == null) { lastSkip = "bad header"; return null }
                tab = nt; reset = true; good = null
                for (s in ch) { s.noiseIdx = 0 }
            } else if (o.limiterBands != h.limiterBands && tab != null) tab!!.lim = limiterTable(tab!!, h.limiterBands)
            hdr = h; headerSeen = true
        }
        val t = tab
        if (!headerSeen || t == null) { lastSkip = "no header yet"; return null }
        val fr = ArrayList<ChFrame>()
        if (nch == 1) {
            if (b.bit() != 0) b.skip(4)
            b.skip(1)
            val f = grid(b) ?: return null
            dtdf(b, f); invf(b, f, t)
            envelope(b, f, ch[0], t, false); noise(b, f, ch[0], t, false)
            harmonics(b, f, t)
            fr.add(f)
            dequant(f, null, t)
        } else {
            if (b.bit() != 0) b.skip(8)
            val coupling = b.bit()
            if (coupling != 0) {
                val f0 = grid(b) ?: return null
                val f1 = f0.copy()
                dtdf(b, f0); dtdf(b, f1)
                invf(b, f0, t); f1.invf = f0.invf.copyOf()
                envelope(b, f0, ch[0], t, false); noise(b, f0, ch[0], t, false)
                envelope(b, f1, ch[1], t, true); noise(b, f1, ch[1], t, true)
                harmonics(b, f0, t); harmonics(b, f1, t)
                fr.add(f0); fr.add(f1)
                dequant(f0, f1, t)
            } else {
                val f0 = grid(b); val f1 = grid(b)
                if (f0 == null || f1 == null) return null
                dtdf(b, f0); dtdf(b, f1)
                invf(b, f0, t); invf(b, f1, t)
                envelope(b, f0, ch[0], t, false); envelope(b, f1, ch[1], t, false)
                noise(b, f0, ch[0], t, false); noise(b, f1, ch[1], t, false)
                harmonics(b, f0, t); harmonics(b, f1, t)
                fr.add(f0); fr.add(f1)
                dequant(f0, null, t); dequant(f1, null, t)
            }
        }
        if (b.bit() != 0) {
            var cnt = b.read(4)
            if (cnt == 15) cnt += b.read(8)
            var left = 8 * cnt; var psSeen = false
            while (left > 7) {
                val id = b.read(2); left -= 2
                if (id == 0 && nch == 1 && !psSeen) {
                    psSeen = true
                    val p0 = b.pos
                    ps.read(b)
                    if (!psUsed) psSynth.copyFrom(ch[0].qs)
                    psUsed = true
                    left -= b.pos - p0
                    if (left < 0) throw IllegalStateException("PS overran extension")
                } else { b.skip(left); left = 0 }
            }
            b.skip(left)
        }
        lastEnd = b.pos
        return fr
    }

    private fun grid(b: Bits): ChFrame? {
        val cls = b.read(2)
        var le: Int; var pointer = 0
        val tE: IntArray; val f: IntArray
        if (cls == FIXFIX) {
            le = min(1 shl b.read(2), 4)
            val r = b.bit()
            f = IntArray(le) { r }
            tE = IntArray(le + 1) { Math.round(16.0 * it / le).toInt() }
        } else if (cls == FIXVAR || cls == VARFIX) {
            val abs = b.read(2); val nrel = b.read(2)
            le = nrel + 1
            val rel = IntArray(nrel)
            for (i in 0 until nrel) rel[i] = 2 * b.read(2) + 2
            pointer = b.read(ceilLog2(le + 1))
            f = IntArray(le)
            for (i in 0 until le) f[i] = b.bit()
            tE = IntArray(le + 1)
            if (cls == FIXVAR) {
                f.reverse()
                tE[0] = 0; tE[le] = abs + 16
                for (i in 0 until nrel) tE[le - 1 - i] = tE[le - i] - rel[i]
            } else {
                tE[0] = abs
                for (i in 0 until nrel) tE[i + 1] = tE[i] + rel[i]
                tE[le] = 16
            }
        } else {
            val lead = b.read(2); val trail = b.read(2) + 16; val n0 = b.read(2); val n1 = b.read(2)
            le = n0 + n1 + 1
            val r0 = IntArray(n0); val r1 = IntArray(n1)
            for (i in 0 until n0) r0[i] = 2 * b.read(2) + 2
            for (i in 0 until n1) r1[i] = 2 * b.read(2) + 2
            pointer = b.read(ceilLog2(le + 1))
            f = IntArray(le)
            for (i in 0 until le) f[i] = b.bit()
            if (le > 5) return fail("grid: too many envelopes")
            tE = IntArray(le + 1); tE[0] = lead; tE[le] = trail
            for (i in 0 until n0) tE[i + 1] = tE[i] + r0[i]
            for (i in 0 until n1) tE[le - 1 - i] = tE[le - i] - r1[i]
        }
        if (pointer > le + 1) return fail("grid: pointer")
        for (i in 1..le) if (!(tE[i] > tE[i - 1])) return fail("grid: borders")
        val lq = if (le > 1) 2 else 1
        val tQ = IntArray(lq + 1); tQ[0] = tE[0]
        if (lq == 2) {
            val idx = if (cls == FIXFIX) le shr 1
                else if (cls == VARFIX) (if (pointer == 0) 1 else if (pointer == 1) le - 1 else pointer - 1)
                else (if (pointer > 1) le + 1 - pointer else le - 1)
            if (idx <= 0 || idx >= le) return fail("grid: noise border")
            tQ[1] = tE[idx]
        }
        tQ[lq] = tE[le]
        var lA = -1
        if ((cls == FIXVAR || cls == VARVAR) && pointer > 0) lA = le + 1 - pointer
        else if (cls == VARFIX && pointer > 1) lA = pointer - 1
        val ampRes = if (cls == FIXFIX && le == 1) 0 else hdr.ampRes
        return ChFrame(cls, le, lq, tE, tQ, f, pointer, lA, IntArray(0), IntArray(0), IntArray(0), ampRes, emptyList(), emptyList(), 0, IntArray(0), emptyList(), emptyList())
    }

    private fun fail(why: String): ChFrame? { lastSkip = why; return null }

    // One envelope over the whole lost frame from each channel's last one, energy scaled by e.
    private fun concealed(good: List<ChFrame>, e: Double): List<ChFrame> = good.mapIndexed { c, p ->
        val lE = p.le - 1; val lQ = p.lq - 1; val t0 = max(0, ch[c].endPrev - 16)
        ChFrame(FIXFIX, 1, 1, intArrayOf(t0, 16), intArrayOf(t0, 16), intArrayOf(p.f[lE]), 0, -1,
            intArrayOf(0), intArrayOf(0), p.invf, p.ampRes, listOf(p.E[lE]), listOf(p.Q[lQ]), p.harmFlag, p.harm,
            listOf(DoubleArray(p.eOrig[lE].size) { p.eOrig[lE][it] * e }), listOf(p.qOrig[lQ]))
    }

    private fun dtdf(b: Bits, f: ChFrame) {
        f.dfEnv = IntArray(f.le) { b.bit() }
        f.dfNoise = IntArray(f.lq) { b.bit() }
    }

    private fun invf(b: Bits, f: ChFrame, t: SbrTables) {
        f.invf = IntArray(t.nQ) { b.read(2) }
    }

    private fun envelope(b: Bits, f: ChFrame, s: ChState, t: SbrTables, bal: Boolean) {
        val delta = if (bal) 2 else 1; val n = intArrayOf(t.nLow, t.nHigh); val odd = t.nHigh and 1
        val th = if (bal) (if (f.ampRes != 0) H_T_ENV_BAL30 else H_T_ENV_BAL15) else (if (f.ampRes != 0) H_T_ENV30 else H_T_ENV15)
        val fh = if (bal) (if (f.ampRes != 0) H_F_ENV_BAL30 else H_F_ENV_BAL15) else (if (f.ampRes != 0) H_F_ENV30 else H_F_ENV15)
        val bits = (if (bal) 5 else 6) + (if (f.ampRes != 0) 0 else 1)
        var prev: IntArray = s.ePrev; var gPrev = s.fPrev
        // the reference frame was coded in the other amplitude resolution (after a loss)
        if (s.aPrev != f.ampRes) prev = IntArray(s.ePrev.size) { if (f.ampRes != 0) s.ePrev[it] shr 1 else 2 * s.ePrev[it] }
        val all = ArrayList<IntArray>()
        for (l in 0 until f.le) {
            val res = f.f[l]; val e = IntArray(n[res])
            if (f.dfEnv[l] == 0) {
                e[0] = delta * b.read(bits)
                for (k in 1 until n[res]) e[k] = e[k - 1] + delta * huffDecode(b, fh)
            } else {
                for (k in 0 until n[res]) {
                    val i = if (res == gPrev) k else if (res != 0) (k + odd) shr 1 else (if (k != 0) 2 * k - odd else 0)
                    e[k] = prev[i] + delta * huffDecode(b, th)
                }
            }
            for (k in e.indices) e[k] = max(0, min(127, e[k]))
            all.add(e); prev = e; gPrev = res
        }
        f.E = all
    }

    private fun noise(b: Bits, f: ChFrame, s: ChState, t: SbrTables, bal: Boolean) {
        val delta = if (bal) 2 else 1
        val th = if (bal) H_T_NOISE_BAL30 else H_T_NOISE30; val fh = if (bal) H_F_ENV_BAL30 else H_F_ENV30
        var prev: IntArray = s.qPrev
        val all = ArrayList<IntArray>()
        for (l in 0 until f.lq) {
            val q = IntArray(t.nQ)
            if (f.dfNoise[l] == 0) {
                q[0] = delta * b.read(5)
                for (k in 1 until t.nQ) q[k] = q[k - 1] + delta * huffDecode(b, fh)
            } else for (k in 0 until t.nQ) q[k] = prev[k] + delta * huffDecode(b, th)
            for (k in q.indices) q[k] = max(0, min(30, q[k]))
            all.add(q); prev = q
        }
        f.Q = all
    }

    private fun harmonics(b: Bits, f: ChFrame, t: SbrTables) {
        f.harmFlag = b.bit()
        f.harm = if (f.harmFlag != 0) IntArray(t.nHigh) { b.bit() } else IntArray(0)
    }

    private fun dequant(f0: ChFrame, f1: ChFrame?, t: SbrTables) {
        dequantRaw(f0, f1, t)
        // 16-bit audio never needs subband energies near 2^50; larger means corrupt bits
        for (f in if (f1 != null) listOf(f0, f1) else listOf(f0)) for (e in f.eOrig) for (v in e) if (!(v < TWO_50)) throw IllegalStateException("envelope out of range")
    }

    private fun dequantRaw(f0: ChFrame, f1: ChFrame?, t: SbrTables) {
        val n = intArrayOf(t.nLow, t.nHigh)
        if (f1 == null) {
            val a = if (f0.ampRes != 0) 1 else 2
            f0.eOrig = f0.E.map { e -> DoubleArray(e.size) { 2.0.pow(e[it].toDouble() / a + 6) } }
            f0.qOrig = f0.Q.map { q -> DoubleArray(q.size) { 2.0.pow(6.0 - q[it]) } }
            return
        }
        val a = if (f0.ampRes != 0) 1 else 2; val pan = if (f0.ampRes != 0) 12 else 24
        val e0s = ArrayList<DoubleArray>(); val e1s = ArrayList<DoubleArray>()
        for (l in 0 until f0.le) {
            val e0 = DoubleArray(n[f0.f[l]]); val e1 = DoubleArray(n[f0.f[l]])
            for (k in 0 until n[f0.f[l]]) {
                val t1 = 2.0.pow(f0.E[l][k].toDouble() / a + 7); val t2 = 2.0.pow((pan - f1.E[l][k]).toDouble() / a); val fac = t1 / (1 + t2)
                e0[k] = fac; e1[k] = fac * t2
            }
            e0s.add(e0); e1s.add(e1)
        }
        f0.eOrig = e0s; f1.eOrig = e1s
        val q0s = ArrayList<DoubleArray>(); val q1s = ArrayList<DoubleArray>()
        for (l in 0 until f0.lq) {
            val q0 = DoubleArray(t.nQ); val q1 = DoubleArray(t.nQ)
            for (k in 0 until t.nQ) {
                val t1 = 2.0.pow(6.0 - f0.Q[l][k] + 1); val t2 = 2.0.pow(12.0 - f1.Q[l][k]); val fac = t1 / (1 + t2)
                q0[k] = fac; q1[k] = fac * t2
            }
            q0s.add(q0); q1s.add(q1)
        }
        f0.qOrig = q0s; f1.qOrig = q1s
    }

    // ---- signal path ----

    private fun analyze(s: ChState, pcm: FloatArray, kx: Int) {
        for (l in 0 until SLOTS) {
            val o = (l + HFGEN) * 64
            s.qa.slot(pcm, l * 32, scale, s.xr, s.xi, o)
            for (k in kx until 32) { s.xr[o + k] = 0.0; s.xi[o + k] = 0.0 }
        }
    }

    private fun hfGenerate(s: ChState, f: ChFrame, t: SbrTables) {
        val xr = s.xr; val xi = s.xi
        for (k in 0 until t.k0) lpc(xr, xi, k)
        val bw = DoubleArray(5)
        for (i in 0 until t.nQ) {
            val cur = f.invf[i]; val prv = s.invfPrev[i]
            var nb = if (cur + prv == 1) 0.6 else BW_NEW[cur]
            nb = if (nb < s.bwPrev[i]) 0.75 * nb + 0.25 * s.bwPrev[i] else 0.90625 * nb + 0.09375 * s.bwPrev[i]
            bw[i] = if (nb < 0.015625) 0.0 else nb
        }
        val l0 = 2 * f.tE[0]; val l1 = 2 * f.tE[f.le]
        var k = t.kx
        for (p in t.patchCount.indices) {
            for (x in 0 until t.patchCount[p]) {
                val src = t.patchStart[p] + x
                var g = 0
                while (g < t.nQ - 1 && k >= t.noise[g + 1]) g++
                val w = bw[g]; val a0r = alpha0r[src] * w; val a0i = alpha0i[src] * w; val w2 = w * w; val a1r = alpha1r[src] * w2; val a1i = alpha1i[src] * w2
                for (l in l0 until l1) {
                    val i0 = (l + HFADJ) * 64 + src; val i1 = i0 - 64; val i2 = i0 - 128
                    xr[(l + HFADJ) * 64 + k] = xr[i0] + a0r * xr[i1] - a0i * xi[i1] + a1r * xr[i2] - a1i * xi[i2]
                    xi[(l + HFADJ) * 64 + k] = xi[i0] + a0r * xi[i1] + a0i * xr[i1] + a1r * xi[i2] + a1i * xr[i2]
                }
                k++
            }
        }
        while (k < 64) { for (l in l0 until l1) { xr[(l + HFADJ) * 64 + k] = 0.0; xi[(l + HFADJ) * 64 + k] = 0.0 }; k++ }
        for (i in 0 until t.nQ) { s.bwPrev[i] = bw[i]; s.invfPrev[i] = f.invf[i] }
    }

    private fun lpc(xr: DoubleArray, xi: DoubleArray, k: Int) {
        // phi(i,j) = sum_n x[n+2-i] conj(x[n+2-j]), n = 0..37
        var p11 = 0.0; var p22 = 0.0; var p01r = 0.0; var p01i = 0.0; var p02r = 0.0; var p02i = 0.0; var p12r = 0.0; var p12i = 0.0
        for (n in 0 until SLOTS + 6) {
            val a = (n + 2) * 64 + k; val b = a - 64; val c = a - 128
            val ar = xr[a]; val ai = xi[a]; val br = xr[b]; val bi = xi[b]; val cr = xr[c]; val ci = xi[c]
            p11 += br * br + bi * bi; p22 += cr * cr + ci * ci
            p01r += ar * br + ai * bi; p01i += ai * br - ar * bi
            p02r += ar * cr + ai * ci; p02i += ai * cr - ar * ci
            p12r += br * cr + bi * ci; p12i += bi * cr - br * ci
        }
        val d = p22 * p11 - (p12r * p12r + p12i * p12i) / (1 + 1e-6)
        var a1r = 0.0; var a1i = 0.0; var a0r = 0.0; var a0i = 0.0
        if (d != 0.0) {
            a1r = (p01r * p12r - p01i * p12i - p02r * p11) / d
            a1i = (p01r * p12i + p01i * p12r - p02i * p11) / d
        }
        if (p11 != 0.0) {
            a0r = -(p01r + a1r * p12r + a1i * p12i) / p11
            a0i = -(p01i + a1i * p12r - a1r * p12i) / p11
        }
        if (a1r * a1r + a1i * a1i >= 16 || a0r * a0r + a0i * a0i >= 16 || !(a0r + a0i + a1r + a1i).isFinite()) { a0r = 0.0; a0i = 0.0; a1r = 0.0; a1i = 0.0 }
        alpha0r[k] = a0r; alpha0i[k] = a0i; alpha1r[k] = a1r; alpha1i[k] = a1i
    }

    private fun hfAdjust(s: ChState, f: ChFrame, t: SbrTables) {
        val kx = t.kx; val M = t.m; val xr = s.xr; val xi = s.xi
        val tables = arrayOf(t.low, t.high)
        val laPrev = if (s.prevLaLast) 0 else -1
        val hSL = if (hdr.smoothingMode != 0) 0 else 4
        val sIdx = IntArray(64)
        val eo = DoubleArray(64); val qm = DoubleArray(64); val sm = IntArray(64); val ec = DoubleArray(64)
        val G = DoubleArray(64); val QM = DoubleArray(64); val SM = DoubleArray(64)
        if (reset || !s.histValid) s.histValid = false
        for (l in 0 until f.le) {
            val tab = tables[f.f[l]]; val nb = tab.size - 1
            for (i in 0 until nb) for (k in tab[i] until tab[i + 1]) eo[k - kx] = f.eOrig[l][i]
            val qi = if (f.lq == 2 && f.tE[l] >= f.tQ[1]) 1 else 0
            for (i in 0 until t.nQ) for (k in t.noise[i] until t.noise[i + 1]) qm[k - kx] = f.qOrig[qi][i]
            val prevS = s.sIdxPrev
            sIdx.fill(0)
            if (f.harmFlag != 0) for (i in 0 until t.nHigh) {
                val mid = ((t.high[i] + t.high[i + 1]) shr 1) - kx
                sIdx[mid] = if (f.harm[i] != 0 && (l >= f.lA || prevS[mid] == 1)) 1 else 0
            }
            for (i in 0 until nb) {
                var any = 0
                for (k in tab[i] until tab[i + 1]) if (sIdx[k - kx] != 0) { any = 1; break }
                for (k in tab[i] until tab[i + 1]) sm[k - kx] = any
            }
            val s0 = 2 * f.tE[l] + HFADJ; val s1 = 2 * f.tE[l + 1] + HFADJ
            if (hdr.interpolFreq != 0) {
                for (m in 0 until M) {
                    var e = 0.0
                    for (i in s0 until s1) { val j = i * 64 + m + kx; e += xr[j] * xr[j] + xi[j] * xi[j] }
                    ec[m] = e / (s1 - s0)
                }
            } else {
                for (i in 0 until nb) {
                    var e = 0.0
                    for (k in tab[i] until tab[i + 1]) for (j in s0 until s1) { val x = j * 64 + k; e += xr[x] * xr[x] + xi[x] * xi[x] }
                    e /= ((s1 - s0) * (tab[i + 1] - tab[i])).toDouble()
                    for (k in tab[i] until tab[i + 1]) ec[k - kx] = e
                }
            }
            val trans = l == f.lA || l == laPrev
            val delta = if (trans) 0 else 1
            var b = 0
            while (b + 1 < t.lim.size) {
                val m0 = t.lim[b] - kx; val m1 = t.lim[b + 1] - kx
                var so = 0.0; var sc = 0.0
                for (m in m0 until m1) {
                    val tmp = eo[m] / (1 + qm[m])
                    QM[m] = sqrt(tmp * qm[m])
                    SM[m] = sqrt(tmp * sIdx[m])
                    G[m] = if (sm[m] != 0) sqrt(eo[m] * qm[m] / ((1 + ec[m]) * (1 + qm[m]))) else sqrt(eo[m] / ((1 + ec[m]) * (1 + qm[m] * delta)))
                    so += eo[m]; sc += ec[m]
                }
                val gMax = min(1e5, LIM_GAIN[hdr.limiterGains] * sqrt((1e-12 + so) / (1e-12 + sc)))
                var den = 0.0
                for (m in m0 until m1) {
                    if (G[m] > gMax) { QM[m] *= gMax / G[m]; G[m] = gMax }
                    den += ec[m] * G[m] * G[m] + SM[m] * SM[m] + (if (delta != 0 && SM[m] == 0.0) QM[m] * QM[m] else 0.0)
                }
                val boost = min(1.584893192, sqrt((1e-12 + so) / (1e-12 + den)))
                for (m in m0 until m1) { G[m] *= boost; QM[m] *= boost; SM[m] *= boost }
                b++
            }
            if (!s.histValid) {
                for (h in 0 until 5) { G.copyInto(s.gHist[h]); QM.copyInto(s.qHist[h]) }
                s.histValid = true
            }
            for (i in s0 - HFADJ until s1 - HFADJ) {
                val gh = s.gHist.removeAt(s.gHist.size - 1); val qh = s.qHist.removeAt(s.qHist.size - 1)
                G.copyInto(gh); QM.copyInto(qh)
                s.gHist.add(0, gh); s.qHist.add(0, qh)
                val row = (i + HFADJ) * 64 + kx
                val sine = s.sineIdx; val sr = SINE_RE[sine]; val si = SINE_IM[sine]
                for (m in 0 until M) {
                    var g = G[m]; var q = QM[m]
                    if (hSL != 0 && !trans) {
                        g = 0.0; q = 0.0
                        for (j in 0..4) { g += s.gHist[j][m] * H_SMOOTH[j]; q += s.qHist[j][m] * H_SMOOTH[j] }
                    }
                    val x = row + m
                    xr[x] *= g; xi[x] *= g
                    val ni = (s.noiseIdx + m + 1) and 511
                    if (SM[m] != 0.0) {
                        val sg = if (((m + kx) and 1) != 0) -1 else 1
                        xr[x] += SM[m] * sr; xi[x] += SM[m] * si * sg
                    } else if (!trans) {
                        xr[x] += q * NOISE_TABLE[2 * ni]; xi[x] += q * NOISE_TABLE[2 * ni + 1]
                    }
                }
                s.noiseIdx = (s.noiseIdx + M) and 511
                s.sineIdx = (s.sineIdx + 1) and 3
            }
            if (l == f.le - 1) sIdx.copyInto(s.sIdxPrev)
        }
    }

    private fun buildX(s: ChState, f: ChFrame?, t: SbrTables?, XR: DoubleArray, XI: DoubleArray) {
        XR.fill(0.0); XI.fill(0.0)
        for (l in 0 until SLOTS) {
            var top = 32
            if (f != null && t != null) top = if (l < 2 * f.tE[0]) (if (kxPrev != 0) kxPrev + mPrev else t.kx) else t.kx + t.m
            val src = (l + HFADJ) * 64; val dst = l * 64
            for (k in 0 until top) { XR[dst + k] = s.xr[src + k]; XI[dst + k] = s.xi[src + k] }
        }
    }

    private fun savePrev(s: ChState, f: ChFrame, t: SbrTables) {
        val last = f.E[f.le - 1]
        s.ePrev.fill(0); for (i in last.indices) s.ePrev[i] = last[i]
        s.fPrev = f.f[f.le - 1]
        val q = f.Q[f.lq - 1]
        s.qPrev.fill(0); for (i in q.indices) s.qPrev[i] = q[i]
        s.prevLaLast = f.lA == f.le
        s.endPrev = f.tE[f.le]
        s.aPrev = f.ampRes
    }
}

private fun ceilLog2(x: Int): Int = intArrayOf(0, 0, 1, 2, 2, 3, 3, 3, 3, 4).getOrElse(x) { 4 }
