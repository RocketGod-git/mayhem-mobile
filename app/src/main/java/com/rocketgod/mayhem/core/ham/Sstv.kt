package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * SSTV decoder on the HAM receiver's audio (ISS SSTV events on 145.800, 14.230 / 28.680 on HF): a quadrature
 * frequency detector around 1900 Hz gives the instantaneous tone frequency; the VIS header (1900 leader, 1200
 * start bit, 8 bits at 30 ms, 1100 = 1 / 1300 = 0) names the mode; then each line is timed from its 1200 Hz sync
 * pulse and the color components are read as pixel = (f − 1500) / 800. Martin, Scottie, Robot and PD modes,
 * including the PD120 the ISS uses. Twin of web/src/dsp/ham/sstv.ts.
 *
 * Also the NOAA APT weather-image decoder, twin of apt.ts.
 */

private const val RATE = 48_000
private const val MS = RATE / 1000.0

internal enum class SstvKind { R, G, B, Y, RY, BY, Y2 }
internal class SstvComp(val at: Double, val dur: Double, val kind: SstvKind, val odd: SstvKind? = null)
class SstvMode internal constructor(
    val name: String, val vis: Int, val width: Int, val height: Int, internal val line: Double, internal val firstSync: Double,
    internal val syncLen: Double, internal val rows: Int, internal val comps: List<SstvComp>,
)

private fun martin(name: String, vis: Int, t: Double) = SstvMode(name, vis, 320, 256, 4.862 + 0.572 + 3 * (t + 0.572), 0.0, 4.862, 1,
    listOf(SstvComp(5.434, t, SstvKind.G), SstvComp(5.434 + t + 0.572, t, SstvKind.B), SstvComp(5.434 + 2 * (t + 0.572), t, SstvKind.R)))

// a lone 9 ms sync, then per line: sep G sep B | sync porch R — the sync sits before the red scan
private fun scottie(name: String, vis: Int, t: Double) = SstvMode(name, vis, 320, 256, 13.5 + 3 * t, 12 + 2 * t, 9.0, 1,
    listOf(SstvComp(-(2 * t + 1.5), t, SstvKind.G), SstvComp(-t, t, SstvKind.B), SstvComp(10.5, t, SstvKind.R)))

private fun pd(name: String, vis: Int, t: Double, width: Int, height: Int) = SstvMode(name, vis, width, height, 22.08 + 4 * t, 0.0, 20.0, 2,
    listOf(SstvComp(22.08, t, SstvKind.Y), SstvComp(22.08 + t, t, SstvKind.RY), SstvComp(22.08 + 2 * t, t, SstvKind.BY), SstvComp(22.08 + 3 * t, t, SstvKind.Y2)))

val SSTV_MODES: List<SstvMode> = listOf(
    martin("Martin M1", 44, 146.432), martin("Martin M2", 40, 73.216),
    scottie("Scottie S1", 60, 138.24), scottie("Scottie S2", 56, 88.064), scottie("Scottie DX", 76, 345.6),
    SstvMode("Robot 36", 8, 320, 240, 150.0, 0.0, 9.0, 1, listOf(SstvComp(12.0, 88.0, SstvKind.Y), SstvComp(106.0, 44.0, SstvKind.RY, SstvKind.BY))),
    SstvMode("Robot 72", 12, 320, 240, 300.0, 0.0, 9.0, 1, listOf(SstvComp(12.0, 138.0, SstvKind.Y), SstvComp(156.0, 69.0, SstvKind.RY), SstvComp(231.0, 69.0, SstvKind.BY))),
    pd("PD50", 93, 91.52, 320, 256), pd("PD90", 99, 170.24, 320, 256), pd("PD120", 95, 121.6, 640, 496), pd("PD160", 98, 195.584, 512, 400),
    pd("PD180", 96, 183.04, 640, 496), pd("PD240", 97, 244.48, 640, 496), pd("PD290", 94, 228.8, 800, 616),
)

/** [count] finished rows starting at [line], ARGB. */
class SstvRows(val mode: String, val width: Int, val height: Int, val line: Int, val count: Int, val argb: IntArray)

private fun clamp255(v: Double): Int = if (v <= 0) 0 else if (v >= 255) 255 else v.roundToInt()

class SstvDecoder : DigitalDecoder {
    override val name = "SSTV"
    override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    var onImage: (SstvRows) -> Unit = {}

    private val freq = FloatArray(RATE * 6)
    private var n = 0L
    private var cr = 1.0; private var ci = 0.0
    private val dr = cos(-2 * PI * 1900 / RATE); private val di = sin(-2 * PI * 1900 / RATE)
    // four one-pole stages at 1.1 kHz: pass the ±400 Hz tone range, kill the 3.8 kHz image that would ripple the estimate
    private var i1 = 0.0; private var i2 = 0.0; private var i3 = 0.0; private var i4 = 0.0
    private var q1 = 0.0; private var q2 = 0.0; private var q3 = 0.0; private var q4 = 0.0
    private val a = 1 - exp(-2 * PI * 1100 / RATE)
    private var pi = 1.0; private var pq = 0.0; private var sm = 1900.0
    private var tick = 0
    private var state = 0; private var leader = 0; private var tStart = 0.0; private var visChecked = false
    private var mode: SstvMode? = null; private var tImg = 0.0; private var line = 0; private var corr = 0.0; private var missed = 0
    private var cb = DoubleArray(0); private var crRow = DoubleArray(0)
    private var lastImage = -1e9
    private val y = DoubleArray(1024); private val u = DoubleArray(1024); private val v = DoubleArray(1024); private val y2 = DoubleArray(1024)
    private val rgbTmp = DoubleArray(1024 * 3)

    override fun reset() { n = 0; state = 0; leader = 0; mode = null; confidence = 0f; sm = 1900.0; freq.fill(1900f) }

    override fun push(audio: FloatArray, n: Int) {
        val f = freq; val len = f.size; val al = a
        for (k in 0 until n) {
            val x = audio[k].toDouble()
            val i = x * cr; val q = x * ci
            val nr = cr * dr - ci * di; ci = cr * di + ci * dr; cr = nr
            i1 += al * (i - i1); i2 += al * (i1 - i2); i3 += al * (i2 - i3); i4 += al * (i3 - i4)
            q1 += al * (q - q1); q2 += al * (q1 - q2); q3 += al * (q2 - q3); q4 += al * (q3 - q4)
            val re = i4 * pi + q4 * pq; val im = q4 * pi - i4 * pq
            pi = i4; pq = q4
            val hz = 1900 + atan2(im, re) * RATE / (2 * PI)
            sm += 0.35 * (hz - sm)
            f[(this.n % len).toInt()] = sm.toFloat()
            this.n++
            if (++tick >= 48) {
                tick = 0; onTick()
                if ((this.n and 0xffff) == 0L) { val g = 1 / hypot(cr, ci); cr *= g; ci *= g }
            }
        }
    }

    /** Mean frequency over [from, to) samples (absolute indices). */
    private fun mean(from: Double, to: Double): Double {
        val f = freq; val len = f.size
        val a = max(floor(from).toLong(), n - len); val b = min(floor(to).toLong(), n)
        if (b <= a) return 1900.0
        var s = 0.0; var i = a
        while (i < b) { s += f[(i % len).toInt()]; i++ }
        return s / (b - a)
    }

    private fun onTick() {
        val now = n.toDouble(); val fa = mean(now - 48, now)
        if (state == 3) { decodeReady(); if (now - lastImage > 3 * RATE) confidence = max(0f, confidence - 0.05f); return }
        if (state == 0 || state == 1) {
            if (abs(fa - 1900) < 70) { leader++; if (leader >= 100) state = 1 }
            else if (state == 1 && fa < 1350) {           // 1900 → 1200: the start bit (or the 10 ms leader break)
                var best = now - 48; var bestD = -1.0
                var t = now - 3 * MS
                while (t <= now - 24) { val d = mean(t - MS, t) - mean(t, t + 24); if (d > bestD) { bestD = d; best = t }; t += 2 }
                tStart = best; state = 2; visChecked = false
            } else leader = 0
            return
        }
        if (state == 2 && !visChecked && now >= tStart + 22 * MS) {
            visChecked = true
            if (mean(tStart + 12 * MS, tStart + 20 * MS) > 1600) { state = 1; return }   // that was the break
        }
        if (state == 2 && now >= tStart + 315 * MS) {
            var code = 0; var ones = 0; var ok = true
            for (i in 0 until 8) {
                val fb = mean(tStart + (30 * (i + 1) + 8) * MS, tStart + (30 * (i + 1) + 22) * MS)
                val one = abs(fb - 1100) < 80; val zero = abs(fb - 1300) < 80
                if (!one && !zero) { ok = false; break }
                if (one) { ones++; if (i < 7) code = code or (1 shl i) }
            }
            val m = if (ok && (ones and 1) == 0) SSTV_MODES.firstOrNull { it.vis == code } else null
            if (m == null) { state = 0; leader = 0; return }
            start(m, tStart + 300 * MS)
        }
    }

    private fun start(m: SstvMode, t: Double) {
        mode = m; tImg = t; line = 0; corr = 0.0; missed = 0; state = 3
        cb = DoubleArray(m.width) { 128.0 }; crRow = DoubleArray(m.width) { 128.0 }
        confidence = 1f; lastImage = n.toDouble()
        onText("\n[SSTV ${m.name} · ${m.width}×${m.height}]\n", "SSTV")
    }

    private fun decodeReady() {
        val m = mode ?: return
        while (state == 3) {
            val scan = line.toDouble() / m.rows
            val tRef = tImg + (m.firstSync + scan * m.line) * MS + corr
            var tEnd = tRef
            for (c in m.comps) { tEnd = max(tEnd, tRef + (c.at + c.dur) * MS) }
            if (n < tEnd + 4 * MS) return
            decodeScan(m, tRef)
            line += m.rows
            if (line >= m.height) { state = 0; leader = 0; onText("[SSTV ${m.name} complete]\n", "SSTV"); confidence = 0.6f; return }
            if (missed > 12) { state = 0; leader = 0; onText("[SSTV ${m.name} lost after $line lines]\n", "SSTV"); confidence = 0f; return }
        }
    }

    private fun decodeScan(m: SstvMode, tRef0: Double) {
        var tRef = tRef0
        // re-time on the sync pulse's leading edge: the biggest drop into 1200 Hz within ±3 ms of where it should be
        val w = floor(min(m.syncLen / 2, 3.0) * MS)
        var best = tRef; var bestD = -1e9; var bestF = 1e9
        var t = tRef - 3 * MS
        while (t <= tRef + 3 * MS) {
            val after = mean(t, t + w); val d = mean(t - w, t) - after
            if (d > bestD) { bestD = d; best = t; bestF = after }
            t += 4
        }
        if (bestF < 1400 && bestD > 150) { val e = best - tRef; corr += 0.7 * e; tRef += 0.7 * e; missed = 0 } else missed++
        val wd = m.width
        val odd = (line and 1) == 1
        var haveRgb = false; var haveY2 = false
        for (c in m.comps) {
            val kind = if (odd && c.odd != null) c.odd else c.kind
            val step = c.dur * MS / wd; val t0 = tRef + c.at * MS
            val dst = when (kind) { SstvKind.Y -> y; SstvKind.Y2 -> y2; SstvKind.RY -> v; SstvKind.BY -> u; else -> null }
            for (k in 0 until wd) {
                val f = mean(t0 + k * step, t0 + (k + 1) * step)
                val value = max(0.0, min(255.0, (f - 1500) / 800 * 255))
                if (dst != null) dst[k] = value
                else { rgbTmp[k * 3 + when (kind) { SstvKind.R -> 0; SstvKind.G -> 1; else -> 2 }] = value; haveRgb = true }
            }
            if (kind == SstvKind.Y2) haveY2 = true
            if (kind == SstvKind.RY) System.arraycopy(v, 0, crRow, 0, wd)
            if (kind == SstvKind.BY) System.arraycopy(u, 0, cb, 0, wd)
        }
        val out = IntArray(wd * m.rows)
        fun yuv(yy: DoubleArray, row: Int) {
            for (k in 0 until wd) {
                val crv = crRow[k] - 128; val cbv = cb[k] - 128
                out[row * wd + k] = argb(clamp255(yy[k] + 1.402 * crv), clamp255(yy[k] - 0.344 * cbv - 0.714 * crv), clamp255(yy[k] + 1.772 * cbv))
            }
        }
        if (haveRgb) for (k in 0 until wd) out[k] = argb(clamp255(rgbTmp[k * 3]), clamp255(rgbTmp[k * 3 + 1]), clamp255(rgbTmp[k * 3 + 2]))
        else { yuv(y, 0); if (haveY2) yuv(y2, 1) }
        lastImage = n.toDouble(); confidence = 1f
        onImage(SstvRows(m.name, wd, m.height, line, m.rows, out))
    }
}

private fun argb(r: Int, g: Int, b: Int) = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

// ------------------------------------------------------------------------------------------------ NOAA APT

/*
 * NOAA APT on the NFM discriminator (137 MHz, ±17 kHz deviation): the picture is AM on a 2400 Hz subcarrier at
 * 4160 words per second, two 909-pixel channels per 2080-word line with a 1040 Hz "sync A" square-wave burst at
 * the start of each line. Envelope-detect the subcarrier, resample to the word rate, find the sync burst, and hand
 * out one gray line every half second. Calibration is a slow running black / white.
 */
private const val WORDS = 4160
const val APT_LINE = 2080
private val SYNC_A = IntArray(39).also { s ->
    var k = 0
    repeat(4) { s[k++] = -1 }
    repeat(7) { s[k++] = 1; s[k++] = 1; s[k++] = -1; s[k++] = -1 }
    while (k < 39) s[k++] = -1
}

class AptDecoder : FmTap {
    override val minHalf = 20_000.0
    /** One finished line of [APT_LINE] gray values 0..255, and its index. */
    var onRow: (IntArray, Int) -> Unit = { _, _ -> }
    private var cr = 1.0; private var ci = 0.0
    private val dr = cos(-2 * PI * 2400 / RATE); private val di = sin(-2 * PI * 2400 / RATE)
    private var i1 = 0.0; private var i2 = 0.0; private var q1 = 0.0; private var q2 = 0.0
    private val a = 1 - exp(-2 * PI * 2600 / RATE)
    private var ph = 0.0; private var acc = 0.0; private var accN = 0
    private val words = FloatArray(APT_LINE * 8); private var m = 0L
    private var lineStart = -1L; private var lines = 0; private var miss = 0
    private var lo = 0.0; private var hi = 1.0; private var calibrated = false
    private val tmp = FloatArray(APT_LINE)

    fun reset() { m = 0; lineStart = -1; lines = 0; miss = 0; calibrated = false; acc = 0.0; accN = 0; ph = 0.0 }

    override fun onFm(samples: FloatArray, n: Int, rate: Double) {
        if (abs(rate - RATE) > 1) return
        val al = a; val step = WORDS.toDouble() / RATE
        for (k in 0 until n) {
            val x = samples[k].toDouble()
            val i = x * cr; val q = x * ci
            val nr = cr * dr - ci * di; ci = cr * di + ci * dr; cr = nr
            i1 += al * (i - i1); i2 += al * (i1 - i2)
            q1 += al * (q - q1); q2 += al * (q1 - q2)
            acc += sqrt(i2 * i2 + q2 * q2); accN++
            ph += step
            if (ph >= 1) { ph -= 1; word(acc / accN); acc = 0.0; accN = 0 }
        }
        val g = 1 / hypot(cr, ci); cr *= g; ci *= g
    }

    private fun word(w: Double) {
        val len = words.size
        words[(m % len).toInt()] = w.toFloat(); m++
        if (lineStart < 0) {                            // searching: a sync-A burst that repeats one line later
            if (m < APT_LINE + 39) return
            val c = corr(m - 39); val cPrev = corr(m - 39 - APT_LINE)
            if (c > 0.55 && cPrev > 0.4) { lineStart = m - 39; miss = 0 }
            return
        }
        if (m < lineStart + APT_LINE + 40) return
        // a line is complete: re-time on the strongest sync within ±20 words of where the next one should be
        var best = lineStart + APT_LINE; var bestC = 0.0
        for (d in -20..20) { val c = corr(lineStart + APT_LINE + d); if (c > bestC) { bestC = c; best = lineStart + APT_LINE + d } }
        if (bestC < 0.35) { miss++; best = lineStart + APT_LINE; if (miss > 6) { lineStart = -1; return } } else miss = 0
        emit(lineStart)
        lineStart = best
    }

    /** Normalized correlation of the words starting at [at] with the sync-A template. */
    private fun corr(at: Long): Double {
        val len = words.size
        if (at < m - len || at + 39 > m) return 0.0
        var mean = 0.0; for (k in 0 until 39) mean += words[((at + k) % len).toInt()]; mean /= 39
        var s = 0.0; var a = 0.0
        for (k in 0 until 39) { val v = words[((at + k) % len).toInt()] - mean; s += v * SYNC_A[k]; a += abs(v) }
        return if (a > 0) s / a else 0.0
    }

    private fun emit(at: Long) {
        val len = words.size
        for (k in 0 until APT_LINE) tmp[k] = words[((at + k) % len).toInt()]
        // black / white from the line's own extremes, followed slowly so one bad line does not flash
        val sorted = tmp.copyOf().also { it.sort() }
        val l = sorted[(APT_LINE * 0.02).toInt()].toDouble(); val h = sorted[(APT_LINE * 0.98).toInt()].toDouble()
        if (!calibrated) { lo = l; hi = h; calibrated = true } else { lo += 0.05 * (l - lo); hi += 0.05 * (h - hi) }
        val g = 255 / max(1e-6, hi - lo)
        val row = IntArray(APT_LINE) { clamp255((tmp[it] - lo) * g) }
        onRow(row, lines++)
    }
}
