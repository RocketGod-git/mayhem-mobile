package com.rocketgod.mayhem.ui

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.modeFor
import com.rocketgod.mayhem.core.rasterFor
import com.rocketgod.mayhem.core.signalAt
import com.rocketgod.mayhem.core.signalDial
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Waterfall colour maps. Inferno is the web app's and the default; the others follow taste or the skin. */
enum class WfPalette(val title: String) {
    INFERNO("Inferno · the web app's"), RAINBOW("Rainbow · SDR++ style"), SKIN("Skin · the theme's own colors");
}

object Waterfalls {
    var palette by mutableStateOf(WfPalette.INFERNO); private set
    fun load(ctx: Context) {
        val n = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getString("wf_palette", null)
        palette = runCatching { WfPalette.valueOf(n ?: "") }.getOrDefault(WfPalette.INFERNO)
    }
    fun set(ctx: Context, p: WfPalette) {
        palette = p
        ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).edit().putString("wf_palette", p.name).apply()
    }

    /** 256 colours for 0..1. */
    fun lut(p: WfPalette, paper: Color, accent: Color, accent2: Color): IntArray = when (p) {
        WfPalette.INFERNO -> ramp(listOf(0.00f to 0xFF000004.toInt(), 0.13f to 0xFF1F0C48.toInt(), 0.25f to 0xFF550F6D.toInt(),
            0.38f to 0xFF88226A.toInt(), 0.50f to 0xFFBA3655.toInt(), 0.63f to 0xFFE35933.toInt(), 0.75f to 0xFFF98C0A.toInt(),
            0.88f to 0xFFF9C932.toInt(), 1.00f to 0xFFFCFFA4.toInt()))
        WfPalette.RAINBOW -> IntArray(256) { heat(it / 255f) }
        WfPalette.SKIN -> ramp(listOf(0f to Color.Black.toArgb(), 0.30f to lerp(paper, accent, 0.45f).toArgb(), 0.60f to accent.toArgb(),
            0.85f to accent2.toArgb(), 1f to Color.White.toArgb()))
    }

    private fun lerp(a: Color, b: Color, t: Float) = Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t, 1f)

    private fun ramp(stops: List<Pair<Float, Int>>): IntArray = IntArray(256) { i ->
        val t = i / 255f
        var k = 0
        while (k < stops.size - 2 && t > stops[k + 1].first) k++
        val (t0, c0) = stops[k]; val (t1, c1) = stops[k + 1]
        val f = ((t - t0) / (t1 - t0)).coerceIn(0f, 1f)
        fun ch(c: Int, s: Int) = (c shr s) and 0xff
        val r = (ch(c0, 16) + (ch(c1, 16) - ch(c0, 16)) * f).roundToInt()
        val g = (ch(c0, 8) + (ch(c1, 8) - ch(c0, 8)) * f).roundToInt()
        val b = (ch(c0, 0) + (ch(c1, 0) - ch(c0, 0)) * f).roundToInt()
        (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }
}

private const val WF_BLACK = 0xFF000004.toInt()
/** Pixels a waterfall may spend on its memory beyond the view (four bytes each). */
private const val MEM_PX = 2_500_000
/** Time ruler intervals, seconds. */
private val RULER_S = intArrayOf(5, 10, 15, 30, 60, 120, 300, 600)
private const val MAX_MARKS = 8

/**
 * Resample [bins] into [out], one value per column from bin [lo] with [span] bins per column: max-pooled when a
 * column covers more than one bin so a narrow carrier never falls between pixels, interpolated when it covers less.
 */
private fun resample(bins: FloatArray, out: FloatArray, lo: Float, span: Float) {
    val n = out.size; val nb = bins.size
    if (nb == 0) return
    if (span >= 1f) for (x in 0 until n) {
        val a = floor(lo + x * span).toInt().coerceIn(0, nb - 1)
        val b = floor(lo + (x + 1) * span).toInt().coerceIn(a + 1, nb)
        var m = 0f
        for (i in a until b) if (bins[i] > m) m = bins[i]
        out[x] = m
    } else for (x in 0 until n) {
        val p = (lo + (x + 0.5f) * span - 0.5f).coerceIn(0f, (nb - 1).toFloat())
        val i = p.toInt(); val f = p - i
        out[x] = if (i + 1 < nb) bins[i] * (1 - f) + bins[i + 1] * f else bins[i]
    }
}

/**
 * A waterfall's pixels. The ring is what the view shows, one column per screen pixel and [rows] rows with the
 * newest at [head], so a new row is one row written. The memory holds the whole span at 1× resolution, two spans
 * wide and anchored to frequency; it repaints exactly what the ring has no rows for (the sliver a pan or a slide
 * exposes, the wings when zooming out), so going back over a place finds what was painted there. Ring and memory
 * share row slots.
 */
private class WfHistory {
    var cols = 0; private set
    var rows = 0; private set
    var head = 0; private set
    var filled = 0; private set
    /** When each row slot was laid down (wall-clock ms), for the time ruler. */
    var stamps = LongArray(0); private set
    var peak = FloatArray(0); private set
    /** The newest spectrum resampled to the view's columns, for the trace; valid once [hasLast]. */
    var last = FloatArray(0); private set
    var hasLast = false; private set
    var lastCenter = 0L
    var lastSpan = 0
    private var ring: Bitmap? = null
    private var spare: Bitmap? = null
    private var lastSpec: FloatArray? = null
    private var peakBuf = FloatArray(0)
    private var rowArgb = IntArray(0)
    private var mem: Bitmap? = null
    private var memW = 0
    /** Memory column where the span's left edge sits; it moves as the span slides. */
    private var memOrigin = 0
    private var memVals = FloatArray(0)
    private var memArgb = IntArray(0)
    private var memLine = IntArray(0)
    private var blackLine = IntArray(0)
    // sub-pixel remainders of span slides, so many small ones add up rather than round away
    private var ringAcc = 0.0
    private var memAcc = 0.0
    private val cv = android.graphics.Canvas()
    private val paint = android.graphics.Paint()
    private val src = android.graphics.Rect()
    private val dst = android.graphics.RectF()

    /** Size to [c] columns × [r] rows, carrying the history over rescaled (newest row first from here on). */
    fun fit(c: Int, r: Int, start: Float, zoom: Float) {
        if (c == cols && r == rows) return
        val oRing = ring; val oCols = cols; val oRows = rows; val oHead = head
        val oMem = mem; val oMemW = memW; val oOrigin = memOrigin
        paint.isFilterBitmap = true
        val nRing = Bitmap.createBitmap(c, r, Bitmap.Config.ARGB_8888).apply { eraseColor(WF_BLACK) }
        if (oRing != null) { cv.setBitmap(nRing); unroll(cv, oRing, oHead, oRows, 0f, c.toFloat(), r.toFloat(), paint) }
        val mw = min(2 * c, MEM_PX / r)
        if (mw >= c + c / 2) {
            val nMem = Bitmap.createBitmap(mw, r, Bitmap.Config.ARGB_8888).apply { eraseColor(WF_BLACK) }
            val origin = (mw - c) / 2
            if (oMem != null) {
                val k = c.toFloat() / oCols; val left = origin - oOrigin * k
                cv.setBitmap(nMem); unroll(cv, oMem, oHead, oRows, left, left + oMemW * k, r.toFloat(), paint)
            }
            mem = nMem; memW = mw; memOrigin = origin
            memVals = FloatArray(c); memArgb = IntArray(c); memLine = IntArray(mw); blackLine = IntArray(mw) { WF_BLACK }
        } else { mem = null; memW = 0; memOrigin = 0 }
        cv.setBitmap(null)
        val st = LongArray(r)
        if (oRows > 0) for (y in 0 until r) st[y] = stamps[(oHead + min(oRows - 1, y * oRows / r)) % oRows]
        val pk = FloatArray(c)
        if (oCols > 0) for (x in 0 until c) pk[x] = peak[min(oCols - 1, x * oCols / c)]
        filled = if (oRows > 0) min(r, filled * r / oRows) else 0
        ring = nRing; spare = Bitmap.createBitmap(c, r, Bitmap.Config.ARGB_8888)
        cols = c; rows = r; head = 0; stamps = st; peak = pk
        peakBuf = FloatArray(c); last = FloatArray(c); rowArgb = IntArray(c)
        val ls = lastSpec
        hasLast = ls != null
        if (ls != null) resample(ls, last, start * ls.size, ls.size / zoom / c)
    }

    fun clear() {
        ring?.eraseColor(WF_BLACK); mem?.eraseColor(WF_BLACK)
        if (mem != null) memOrigin = (memW - cols) / 2
        head = 0; filled = 0; peak.fill(0f); hasLast = false; lastSpec = null; ringAcc = 0.0; memAcc = 0.0
    }

    /** Lay down [spec] (0..1 across the whole span, any length) as the newest row, [n] rows tall. */
    fun push(spec: FloatArray, start: Float, zoom: Float, lut: IntArray, n: Int, now: Long) {
        val b = ring ?: return
        val nb = spec.size
        resample(spec, last, start * nb, nb / zoom / cols)
        lastSpec = spec; hasLast = true
        for (x in 0 until cols) {
            val v = last[x]
            rowArgb[x] = lut[(v * 255f).toInt().coerceIn(0, 255)]
            peak[x] = if (v > peak[x]) v else peak[x] * 0.985f
        }
        // the memory takes the whole span at 1× whatever the view is showing
        val m = mem
        if (m != null) {
            resample(spec, memVals, 0f, nb.toFloat() / cols)
            for (x in 0 until cols) memArgb[x] = lut[(memVals[x] * 255f).toInt().coerceIn(0, 255)]
        }
        repeat(n.coerceIn(1, rows)) {
            head = (head - 1 + rows) % rows
            b.setPixels(rowArgb, 0, cols, 0, head, cols, 1)
            // the memory's slot goes black right across first: beyond the span it holds a row from a whole history ago
            if (m != null) { m.setPixels(blackLine, 0, memW, 0, head, memW, 1); m.setPixels(memArgb, 0, cols, memOrigin, head, cols, 1) }
            stamps[head] = now
            if (filled < rows) filled++
        }
    }

    /** Show [spec] in the trace without laying down a row; it only ever raises the peak hold. */
    fun setLive(spec: FloatArray, start: Float, zoom: Float) {
        if (cols == 0) return
        val nb = spec.size
        resample(spec, last, start * nb, nb / zoom / cols)
        lastSpec = spec; hasLast = true
        for (x in 0 until cols) if (last[x] > peak[x]) peak[x] = last[x]
    }

    /** The view went from [s0] / [z0] to [s1] / [z1]: paint the new window from the memory, then the old rows over it where they reach. */
    fun reproject(s0: Float, z0: Float, s1: Float, z1: Float) {
        val old = ring ?: return; val nr = spare ?: return
        val sx = (s1 - s0) * z0 * cols; val sw = cols * z0 / z1
        nr.eraseColor(WF_BLACK); cv.setBitmap(nr)
        backfill(0, cols, s1, z1)
        cv.save(); cv.clipRect(0, 0, cols, rows); cv.scale(cols / sw, 1f); cv.translate(-sx, 0f)
        paint.isFilterBitmap = z1 < z0
        cv.drawBitmap(old, 0f, 0f, paint); cv.restore(); cv.setBitmap(null)
        ring = nr; spare = old
        for (x in 0 until cols) { val i = floor(sx + (x + 0.5f) * sw / cols).toInt(); peakBuf[x] = if (i in 0 until cols) peak[i] else 0f }
        val p = peak; peak = peakBuf; peakBuf = p
        lastSpec?.let { resample(it, last, s1 * it.size, it.size / z1 / cols) }
    }

    /** The span moved by [dFrac] of its width (+ = up): slide the rows to stay under their frequencies and repaint the strip that opens up. */
    fun shiftSpan(dFrac: Double, start: Float, zoom: Float) {
        val old = ring ?: return; val nr = spare ?: return
        ringAcc += dFrac * cols * zoom
        val sxL = Math.round(ringAcc); ringAcc -= sxL
        val sx = sxL.coerceIn(-cols.toLong(), cols.toLong()).toInt()
        if (mem != null) {
            memAcc += dFrac * cols
            val msL = Math.round(memAcc); memAcc -= msL
            memOrigin += msL.coerceIn(-4L * memW, 4L * memW).toInt()
            recenterMem()
        }
        if (sx == 0) return
        nr.eraseColor(WF_BLACK); cv.setBitmap(nr)
        if (abs(sx) < cols) { paint.isFilterBitmap = false; cv.drawBitmap(old, -sx.toFloat(), 0f, paint) }
        val w = min(cols, abs(sx))
        backfill(if (sx > 0) cols - w else 0, w, start, zoom)
        cv.setBitmap(null)
        ring = nr; spare = old
        for (x in 0 until cols) { val i = x + sx; peakBuf[x] = if (i in 0 until cols) peak[i] else 0f }
        val p = peak; peak = peakBuf; peakBuf = p
    }

    /** Keep the span inside the memory: when its origin walks off an edge, slide the memory by whole spans; a jump past all of it starts fresh. */
    private fun recenterMem() {
        val m = mem ?: return
        val s = when {
            memOrigin < 0 -> cols * ((-memOrigin + cols - 1) / cols)
            memOrigin + cols > memW -> -cols * ((memOrigin + cols - memW + cols - 1) / cols)
            else -> 0
        }
        if (s == 0) return
        if (abs(s) >= memW) { m.eraseColor(WF_BLACK); memOrigin = (memW - cols) / 2; return }
        for (r in 0 until rows) {
            m.getPixels(memLine, 0, memW, 0, r, memW, 1)
            if (s > 0) { System.arraycopy(memLine, 0, memLine, s, memW - s); java.util.Arrays.fill(memLine, 0, s, WF_BLACK) }
            else { System.arraycopy(memLine, -s, memLine, 0, memW + s); java.util.Arrays.fill(memLine, memW + s, memW, WF_BLACK) }
            m.setPixels(memLine, 0, memW, 0, r, memW, 1)
        }
        memOrigin = (memOrigin + s).coerceIn(0, memW - cols)
    }

    /**
     * Repaint ring columns [x0, x0 + w) of [cv]'s bitmap from the memory, full height. A ring column is a view
     * fraction, a view fraction a span fraction through start / zoom, and a span fraction a memory column through
     * the origin.
     */
    private fun backfill(x0: Int, w: Int, start: Float, zoom: Float) {
        val m = mem ?: return
        if (w <= 0) return
        val sx = memOrigin + (start + x0.toFloat() / cols / zoom) * cols
        cv.save(); cv.clipRect(x0, 0, x0 + w, rows)
        cv.translate(x0 - sx * zoom, 0f); cv.scale(zoom, 1f)
        paint.isFilterBitmap = zoom > 1f
        cv.drawBitmap(m, 0f, 0f, paint); cv.restore()
    }

    /** Draw ring [b] ([n] rows, newest at [h0]) newest-first into columns [dl, dr) and rows [0, dh). */
    private fun unroll(c: android.graphics.Canvas, b: Bitmap, h0: Int, n: Int, dl: Float, dr: Float, dh: Float, p: android.graphics.Paint) {
        val k = dh / n; val below = n - h0
        src.set(0, h0, b.width, n); dst.set(dl, 0f, dr, below * k); c.drawBitmap(b, src, dst, p)
        if (h0 > 0) { src.set(0, 0, b.width, h0); dst.set(dl, below * k, dr, dh); c.drawBitmap(b, src, dst, p) }
    }

    fun drawTo(c: android.graphics.Canvas, w: Float, h: Float, p: android.graphics.Paint) {
        val b = ring ?: return
        unroll(c, b, head, rows, 0f, w, h, p)
    }
}

/**
 * The labels over the spectrum: up to [MAX_MARKS] in the order added (strongest first), each as low as it can sit
 * above its signal without overlapping a label already drawn, or left out. Also finds the peaks to label when no
 * classifier speaks for the view.
 */
private class SignalMarks {
    private val text = android.graphics.Paint().apply { typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true }
    private val bg = android.graphics.Paint().apply { color = 0x8C000000.toInt() }
    private val xs = FloatArray(MAX_MARKS); private val ys = FloatArray(MAX_MARKS); private val texts = arrayOfNulls<String>(MAX_MARKS)
    /** Left, top, right, bottom of each label drawn this frame. */
    private val boxes = FloatArray(MAX_MARKS * 4)
    private var n = 0
    val full: Boolean get() = n >= MAX_MARKS
    /** View columns and levels of the peaks [peaks] found, strongest first. */
    val pIdx = IntArray(MAX_MARKS); val pVal = FloatArray(MAX_MARKS)
    private var prefix = DoubleArray(0); private var smooth = FloatArray(0)
    private var cIdx = IntArray(0); private var cVal = FloatArray(0)

    fun clear() { n = 0 }
    fun add(x: Float, y: Float, t: String) { if (n < MAX_MARKS) { xs[n] = x; ys[n] = y; texts[n] = t; n++ } }

    /**
     * Humps of the peak-hold trace [v], box-smoothed over 1/80 of the view so a wide FM station reads as one hump
     * labelled at its centre, at least 6 dB over the floor (which sits 4 dB up a [rangeDb] scale) and 1/30 of the
     * view apart. Returns how many of [pIdx] / [pVal] it filled.
     */
    fun peaks(v: FloatArray, rangeDb: Float): Int {
        val len = v.size
        if (len < 8) return 0
        val rad = max(2, (len / 80f).roundToInt()); val sep = max(3, (len / 30f).roundToInt())
        if (prefix.size != len + 1) { prefix = DoubleArray(len + 1); smooth = FloatArray(len); cIdx = IntArray(len); cVal = FloatArray(len) }
        for (i in 0 until len) prefix[i + 1] = prefix[i] + v[i]
        for (i in 0 until len) { val a = max(0, i - rad); val b = min(len, i + rad + 1); smooth[i] = ((prefix[b] - prefix[a]) / (b - a)).toFloat() }
        val thr = (6f + 4f) / rangeDb
        var nc = 0
        for (i in 1 until len - 1) {
            val s = smooth[i]
            if (s < thr || s < smooth[i - 1] || s < smooth[i + 1]) continue
            var best = true
            for (k in max(0, i - sep) until min(len, i + sep)) if (smooth[k] > s) { best = false; break }
            if (!best) continue
            var pk = 0f
            for (k in max(0, i - rad) until min(len, i + rad + 1)) if (v[k] > pk) pk = v[k]
            cIdx[nc] = i; cVal[nc] = pk; nc++
        }
        var out = 0
        while (out < MAX_MARKS) {
            var bi = -1
            for (j in 0 until nc) if (cIdx[j] >= 0 && (bi < 0 || cVal[j] > cVal[bi])) bi = j
            if (bi < 0) break
            pIdx[out] = cIdx[bi]; pVal[out] = cVal[bi]; out++; cIdx[bi] = -1
        }
        return out
    }

    fun draw(c: android.graphics.Canvas, w: Float, top: Float, base: Float, dp: Float, textPx: Float, color: Int) {
        text.textSize = textPx; text.color = color
        // Placed against the boxes already drawn, not by rows: a label sits at its signal's height, so two labels in
        // different rows still collided whenever their signals were close in level. Each starts just above its
        // signal and rises a line at a time until it clears every box so far; one that never does is left out.
        val asc = textPx * 0.85f; val desc = textPx * 0.25f; val lineH = asc + desc + 2 * dp
        var nb = 0
        for (i in 0 until n) {
            val t = texts[i] ?: continue
            val x = xs[i]; val y = ys[i]
            val tw = text.measureText(t)
            val tx = if (x > w * 0.85f) x - 3 * dp - tw else x + 3 * dp
            val l = tx - 2 * dp; val r = tx + tw + 2 * dp
            var ty = max(top + asc, y - 2 * dp)
            var placed = false
            while (ty - asc >= top) {
                var free = true
                for (j in 0 until nb) { val o = j * 4; if (boxes[o] < r && l < boxes[o + 2] && boxes[o + 1] < ty + desc && ty - asc < boxes[o + 3]) { free = false; break } }
                if (free) { placed = true; break }
                ty -= lineH
            }
            if (!placed) continue
            val o = nb * 4; boxes[o] = l; boxes[o + 1] = ty - asc; boxes[o + 2] = r; boxes[o + 3] = ty + desc; nb++
            c.drawRect(l, ty - asc, r, ty + desc, bg)
            c.drawText(t, tx, ty, text)
            c.drawRect(x - dp / 2, y, x + dp / 2, base, text)
        }
    }
}

/** Every engine-fed waterfall on screen asks for its bins; the engine makes the most any of them wants. */
private object SpecWants {
    private val wants = HashMap<Any, Int>()
    fun set(owner: Any, bins: Int) {
        if (bins > 0) wants[owner] = bins else wants.remove(owner)
        SdrEngine.specBinsWanted = wants.values.maxOrNull() ?: SdrEngine.SPEC_BINS
    }
}

/**
 * Waterfall (top), live spectrum (bottom), frequency axis and, when [onSlide] is given, a span bar: the twin of the
 * web app's scope.
 *
 * - One column per screen pixel and, unless [rows] asks for more, one row per pixel of height (up to 600), coloured
 *   by the chosen palette, with a seconds ruler down the side. When the radio moves ([centerHz0]) the history slides
 *   with it so what was painted stays under its true frequency; history slid or panned out of view is remembered and
 *   comes back with it. Only a span change clears it.
 * - Pinch (or the − / + buttons) zooms up to 32×, and an engine-fed view asks the engine for finer bins to match;
 *   two fingers pan a zoomed view, and at 1× slide the span itself. A zoomed view follows the channel when it leaves
 *   the screen, unless the user has worked the view in the last two seconds.
 * - Press and slide to pick a frequency: a guide and [onPreviewFrac] follow the finger, [onTapFrac] fires on release.
 * - The channel ([channel]) is shaded with its edges drawn last; with [onChannelEdge] the edges can be dragged.
 * - Signals found by the engine's classifier are labelled with frequency, class and level; a view the engine does
 *   not feed (a sweep) labels the peaks it finds itself. The spectrum carries a dB grid against the floor.
 *
 * Every fraction passed in or out is of the whole span, whatever the zoom.
 */
@Composable
fun WaterfallView(
    spec: FloatArray,
    /** Columns to start with until the view has been measured; after that it has one per pixel. */
    cols: Int, accent: Color, modifier: Modifier = Modifier,
    /** Fewest history rows; the history is otherwise one row per pixel of waterfall height. */
    rows: Int = 140, traceFrac: Float = 0.38f, centreMarker: Boolean = true,
    channel: Pair<Float, Float>? = null,
    labels: List<Pair<Float, String>> = emptyList(), onPreviewFrac: ((Float?) -> Unit)? = null,
    /** The span the spectrum covers; -1 takes the engine's own, 0 means a sweep (no fixed span to label or slide). */
    centerHz0: Long = -1L, spanHz0: Int = -1,
    onChannelEdge: ((lo: Float, hi: Float, hiEdge: Boolean) -> Unit)? = null,
    onSlide: ((Long) -> Unit)? = null,
    /** ⌖, offered while the channel is off the span. */
    onRecentre: (() -> Unit)? = null,
    /** Zooming out past 1× (−1) widens the span itself, and zooming in from a wide span (+1) narrows it; true when it did. */
    onSpanStep: ((Int) -> Boolean)? = null,
    showSignals: Boolean = true,
    /** A trace to show without laying down a row: a sweep's pass as it is measured, slice by slice. */
    live: FloatArray? = null,
    /** The (floor, range) dB the 0..1 values are scaled against; null takes the engine's. */
    scale: Pair<Float, Float>? = null,
    /** Frequency text at a full-span fraction, for the zoomed axis and the labels of peaks found here. */
    labelAt: ((frac: Float, zoom: Float) -> String)? = null,
    /** Rows laid down per spectrum: a sweep pushes one per pass, so it lays down a few. */
    rowPx: Int = 1,
    /** The span bar covers everything the radio tunes rather than a window around the span. */
    wholeRange: Boolean = false,
    onTapFrac: ((Float) -> Unit)? = null,
) {
    val engineLo by SdrEngine.freqHz.collectAsState()
    val engineRate by SdrEngine.rateHz.collectAsState()
    val centerHz = if (centerHz0 < 0) engineLo else centerHz0
    val spanHz = if (spanHz0 < 0) engineRate else spanHz0
    val engineFed = centerHz0 != 0L && spanHz0 != 0
    val hist = remember { WfHistory() }
    val marks = remember { SignalMarks() }
    var frame by remember { mutableIntStateOf(0) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var start by remember { mutableFloatStateOf(0f) }
    var dragFrac by remember { mutableStateOf<Float?>(null) }
    var barLo by remember { mutableStateOf(0L) }
    var barHi by remember { mutableStateOf(0L) }
    var boxW by remember { mutableIntStateOf(0) }
    var boxH by remember { mutableIntStateOf(0) }
    val gestureAt = remember { LongArray(1) }
    val owner = remember { Any() }
    val palette = Waterfalls.palette
    val lut = remember(palette, Palette.paper, Palette.accent, Palette.accent2) { Waterfalls.lut(palette, Palette.paper, Palette.accent, Palette.accent2) }
    val engineScale by SdrEngine.specScale.collectAsState()
    val (floorDb, rangeDb) = scale ?: engineScale
    val signals by SdrEngine.signals.collectAsState()
    val density = LocalDensity.current
    val dp = density.density
    val textPx = with(density) { 9.sp.toPx() }
    val axisPaint = remember(textPx) { android.graphics.Paint().apply { textSize = textPx; typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true } }
    val rulerPaint = remember(textPx) { android.graphics.Paint().apply { textSize = textPx; typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true; color = 0x8CFFFFFF.toInt() } }
    val bmpPaint = remember { android.graphics.Paint() }
    val fillPath = remember { Path() }; val linePath = remember { Path() }; val holdPath = remember { Path() }

    val barH = if (onSlide != null) 16 * dp else 0f
    val axisH = if (labels.isEmpty() && centerHz == 0L) 0f else textPx * 1.6f
    val wfPx = (boxH - axisH - barH) * (1f - traceFrac)
    val histCols = (if (boxW > 0) boxW else cols).coerceIn(16, 4096)
    val histRows = max(rows, if (wfPx >= 1f) (min(600, wfPx.roundToInt()) + 7) / 8 * 8 else 0).coerceIn(8, 4096)

    LaunchedEffect(histCols, histRows) { hist.fit(histCols, histRows, start, zoom); frame++ }
    LaunchedEffect(spec) {
        if (spec.isEmpty()) return@LaunchedEffect
        hist.fit(histCols, histRows, start, zoom)
        // the radio moved: slide the history so old rows stay under their frequencies; a new span clears it
        if (centerHz != 0L && spanHz > 0) {
            if (hist.lastSpan != 0 && hist.lastSpan != spanHz) hist.clear()
            else if (hist.lastCenter != 0L && centerHz != hist.lastCenter) hist.shiftSpan((centerHz - hist.lastCenter).toDouble() / spanHz, start, zoom)
            hist.lastCenter = centerHz; hist.lastSpan = spanHz
        }
        hist.push(spec, start, zoom, lut, rowPx, System.currentTimeMillis())
        frame++
    }
    LaunchedEffect(live) {
        val l = live ?: return@LaunchedEffect
        if (l.isEmpty()) return@LaunchedEffect
        hist.fit(histCols, histRows, start, zoom)
        hist.setLive(l, start, zoom)
        frame++
    }

    // finer bins from the engine while zoomed: one per column of the whole span at this magnification
    val wantBins = if (engineFed) SdrEngine.specBinsFor(min(8192f, histCols * zoom).toInt()) else 0
    DisposableEffect(wantBins) {
        SpecWants.set(owner, wantBins)
        onDispose { SpecWants.set(owner, 0) }
    }

    // the span bar's window: the radio's whole range, or 24 spans around it re-centred only when the span nears its edge
    if (onSlide != null && spanHz > 0 && centerHz > 0) {
        if (wholeRange) {
            val lim = Radio.limits
            barLo = max(1_000_000L, lim.minHz); barHi = lim.maxHz
        } else {
            val w = 24L * spanHz
            if (barHi - barLo != w || centerHz - spanHz / 2 < barLo || centerHz + spanHz / 2 > barHi) {
                barLo = max(0L, centerHz - w / 2); barHi = barLo + w
            }
        }
    }

    fun clampStart(s: Float, z: Float) = s.coerceIn(0f, max(0f, 1f - 1f / z))
    fun setView(z0: Float, keepFrac: Float? = null, at: Float = 0.5f, startFrac: Float? = null) {
        val z = z0.coerceIn(1f, 32f)
        val s = clampStart(startFrac ?: ((keepFrac ?: (start + 0.5f / zoom)) - at / z), z)
        if (z == zoom && abs(s - start) < 1e-6f) return
        hist.reproject(start, zoom, s, z)
        start = s; zoom = z; frame++
    }

    // A zoomed view follows the channel off the screen, by the least that brings it back, but never while the user is
    // aiming with it: a tap that moves the dial must not slide the spectrum under the finger.
    val chanAt = channel?.let { (it.first + it.second) / 2 }
    LaunchedEffect(chanAt) {
        val at = chanAt ?: return@LaunchedEffect
        if (zoom <= 1.001f || SystemClock.uptimeMillis() - gestureAt[0] < 2000L) return@LaunchedEffect
        val v = (at - start) * zoom
        if (v in 0.03f..0.97f) return@LaunchedEffect
        val margin = 0.2f / zoom
        setView(zoom, startFrac = if (v < 0.5f) at - margin else at - 1f / zoom + margin)
    }

    // the gesture reads these as they are now, without restarting (and dropping a drag) every time one changes
    val channelNow = rememberUpdatedState(channel); val centerNow = rememberUpdatedState(centerHz); val spanNow = rememberUpdatedState(spanHz)
    val tapNow = rememberUpdatedState(onTapFrac); val previewNow = rememberUpdatedState(onPreviewFrac)
    val edgeNow = rememberUpdatedState(onChannelEdge); val slideNow = rememberUpdatedState(onSlide)
    Box(modifier.panel(accent.copy(alpha = 0.7f), RoundedCornerShape(8.dp)).clipToBounds()) {
        Canvas(Modifier.fillMaxSize().onSizeChanged { boxW = it.width; boxH = it.height }.pointerInput(Unit) {
            awaitEachGesture {
                val channel = channelNow.value; val centerHz = centerNow.value; val spanHz = spanNow.value
                val onTapFrac = tapNow.value; val onPreviewFrac = previewNow.value; val onChannelEdge = edgeNow.value; val onSlide = slideNow.value
                val down = awaitFirstDown(requireUnconsumed = false)
                gestureAt[0] = SystemClock.uptimeMillis()
                val w = size.width.toFloat().coerceAtLeast(1f)
                val h = size.height.toFloat()
                val barH = if (onSlide != null) 16 * dp else 0f
                fun viewFrac(x: Float) = (x / w).coerceIn(0f, 1f)
                fun fullFrac(x: Float) = (start + viewFrac(x) / zoom).coerceIn(0f, 1f)
                // which control the press landed on: the span bar, a channel edge, or the spectrum itself
                val onBar = onSlide != null && down.position.y > h - barH
                var edge: Boolean? = null
                if (!onBar && channel != null && onChannelEdge != null) {
                    val tol = 14 * dp / w
                    val vx = viewFrac(down.position.x)
                    val loV = (channel.first - start) * zoom; val hiV = (channel.second - start) * zoom
                    edge = when { abs(vx - hiV) < tol -> true; abs(vx - loV) < tol -> false; else -> null }
                }
                var multi = false
                var pinch0 = 0f; var zoom0 = 1f; var mid0 = 0f; var start0 = 0f; var center0 = centerHz; var spanDrag = false
                val barW = (barHi - barLo).toFloat()
                val grab = if (onBar && barW > 0) {
                    val f = down.position.x / w; val c = (centerHz - barLo) / barW
                    val half = spanHz / 2f / barW
                    // the thumb is drawn at least 2% of the bar wide, so it is grabbable at that width too
                    if (abs(f - c) <= max(half, 0.01f) + 0.01f) f - c else 0f
                } else 0f
                if (onBar && grab == 0f && barW > 0) onSlide?.invoke((barLo + (down.position.x / w) * barW).roundToLong())
                if (!onBar && edge == null && onTapFrac != null) { dragFrac = fullFrac(down.position.x); onPreviewFrac?.invoke(dragFrac) }
                down.consume()
                while (true) {
                    val ev = awaitPointerEvent()
                    gestureAt[0] = SystemClock.uptimeMillis()
                    val pressed = ev.changes.filter { it.pressed }
                    if (pressed.isEmpty()) break
                    if (pressed.size >= 2) {
                        val a = pressed[0].position.x; val b = pressed[1].position.x
                        val dist = max(8f, abs(a - b)); val mid = (a + b) / 2 / w
                        if (!multi) {
                            multi = true; dragFrac = null; onPreviewFrac?.invoke(null)
                            pinch0 = dist; zoom0 = zoom; mid0 = mid; start0 = start; center0 = centerHz
                            spanDrag = zoom <= 1.001f && onSlide != null
                        }
                        val z = (zoom0 * dist / pinch0).coerceIn(1f, 32f)
                        if (spanDrag && z <= 1.05f) {
                            // at 1x there is nothing to pan to inside the view, so two fingers slide the span itself
                            onSlide?.invoke((center0 - (mid - mid0) * spanHz).roundToLong())
                        } else {
                            spanDrag = false
                            val under = start0 + mid0 / zoom0
                            setView(z, under, mid)
                        }
                        ev.changes.forEach { it.consume() }
                        continue
                    }
                    if (multi) { ev.changes.forEach { it.consume() }; continue }
                    val ch = pressed[0]
                    when {
                        onBar && barW > 0 -> onSlide?.invoke((barLo + (ch.position.x / w - grab) * barW).roundToLong())
                        edge != null && channelNow.value != null -> {
                            val cur = channelNow.value!!
                            val f = fullFrac(ch.position.x)
                            var lo = cur.first; var hi = cur.second
                            if (edge == true) hi = max(f, lo + 0.0005f) else lo = min(f, hi - 0.0005f)
                            onChannelEdge?.invoke(lo, hi, edge == true)
                        }
                        onTapFrac != null -> { dragFrac = fullFrac(ch.position.x); onPreviewFrac?.invoke(dragFrac) }
                    }
                    ch.consume()
                }
                gestureAt[0] = SystemClock.uptimeMillis()
                val f = dragFrac
                if (f != null) { dragFrac = null; onPreviewFrac?.invoke(null); if (!multi) onTapFrac?.invoke(f) }
            }
        }) {
            frame
            val w = size.width; val h = size.height
            val bodyH = h - axisH - barH
            val wfH = bodyH * (1f - traceFrac)
            val traceTop = wfH + 2f
            val traceBase = bodyH
            fun toView(f: Float): Float? { val v = (f - start) * zoom; return if (v >= -0.001f && v <= 1.001f) v else null }

            // waterfall: the ring, newest row at the top, and a seconds ruler down its left edge
            drawIntoCanvas { c ->
                val can = c.nativeCanvas
                bmpPaint.isFilterBitmap = hist.rows > wfH + 1f
                hist.drawTo(can, w, wfH, bmpPaint)
                // a tick and label wherever the history crosses a whole interval, picked from the rows' actual pace so
                // labels stay at least 40 dp apart (a sweep's row can be seconds)
                val n = hist.filled; val r = hist.rows
                if (n > 2 && wfH >= 56 * dp) {
                    val now = System.currentTimeMillis()
                    val st = hist.stamps; val hd = hist.head
                    val rowH = wfH / r
                    val secPerRow = max(1e-3f, (now - st[(hd + n - 1) % r]) / 1000f / n)
                    var ivl = RULER_S[0]
                    for (s in RULER_S) { ivl = s; if (s / secPerRow * rowH >= 40 * dp) break }
                    var prev = -1L
                    for (y in 0 until n) {
                        val mark = (now - st[(hd + y) % r]) / 1000L / ivl
                        if (prev >= 0 && mark != prev && mark > 0) {
                            val yy = y * rowH
                            can.drawRect(0f, yy, 6 * dp, yy + max(1f, dp / 2), rulerPaint)
                            val secs = mark * ivl
                            can.drawText(if (secs >= 120) "-${secs / 60}m" else "-${secs}s", 8 * dp, yy + textPx * 0.35f, rulerPaint)
                        }
                        prev = mark
                    }
                }
            }
            channel?.let { (a, b) ->
                val x0 = (a - start) * zoom * w; val x1 = (b - start) * zoom * w
                drawRect(Color.White.copy(alpha = 0.05f), Offset(min(x0, x1), 0f), Size(max(2f, abs(x1 - x0)), wfH))
            }
            // spectrum pane and its dB grid against the floor
            drawRect(Palette.paper.copy(alpha = 0.9f), Offset(0f, wfH), Size(w, traceBase - wfH))
            val steps = max(2, (rangeDb / 10f).roundToInt())
            axisPaint.color = Palette.muted.toArgb(); axisPaint.textAlign = android.graphics.Paint.Align.RIGHT
            for (k in 1 until steps) {
                val y = traceBase - (traceBase - traceTop) * k / steps
                drawLine(Color.White.copy(alpha = 0.07f), Offset(0f, y), Offset(w, y), 1f)
                if (!floorDb.isNaN()) drawIntoCanvas { it.nativeCanvas.drawText("${(floorDb + k * rangeDb / steps).roundToInt()}", w - 3 * dp, y + textPx, axisPaint) }
            }
            channel?.let { (a, b) ->
                val x0 = (a - start) * zoom * w; val x1 = (b - start) * zoom * w
                drawRect(Color.White.copy(alpha = 0.06f), Offset(min(x0, x1), wfH), Size(max(2f, abs(x1 - x0)), traceBase - wfH))
            }
            val nc = hist.cols
            if (hist.hasLast && nc > 1) {
                val tr = hist.last; val pk = hist.peak
                val band = traceBase - traceTop
                val step = w / nc
                fillPath.reset(); fillPath.moveTo(0f, traceBase); fillPath.lineTo(0f, traceBase - tr[0] * band)
                for (i in 0 until nc) fillPath.lineTo((i + 0.5f) * step, traceBase - tr[i] * band)
                fillPath.lineTo(w, traceBase - tr[nc - 1] * band); fillPath.lineTo(w, traceBase); fillPath.close()
                drawPath(fillPath, Brush.verticalGradient(listOf(accent.copy(alpha = 0.66f), accent.copy(alpha = 0.06f)), startY = traceTop, endY = traceBase))
                linePath.reset(); linePath.moveTo(0.5f * step, traceBase - tr[0] * band)
                for (i in 1 until nc) linePath.lineTo((i + 0.5f) * step, traceBase - tr[i] * band)
                drawPath(linePath, accent.copy(alpha = 0.25f), style = Stroke(5f * dp / 2, cap = StrokeCap.Round, join = StrokeJoin.Round))   // glow
                drawPath(linePath, accent, style = Stroke(1.25f * dp, cap = StrokeCap.Round, join = StrokeJoin.Round))
                holdPath.reset(); holdPath.moveTo(0.5f * step, traceBase - pk[0] * band)
                for (i in 1 until nc) holdPath.lineTo((i + 0.5f) * step, traceBase - pk[i] * band)
                drawPath(holdPath, Palette.hold.copy(alpha = 0.6f), style = Stroke(1f))
                if (showSignals && !floorDb.isNaN()) {
                    marks.clear()
                    if (engineFed) {
                        if (centerHz > 0 && spanHz > 0) for (s in signals.sortedByDescending { it.snr }) {
                            if (marks.full) break
                            val v = toView((0.5 + (s.hz - centerHz) / spanHz).toFloat()) ?: continue
                            val y = traceBase - ((s.db.toFloat() - floorDb) / rangeDb).coerceIn(0f, 1f) * band
                            marks.add(v * w, y, "%.3f%s %ddB".format(s.hz / 1e6, if (s.cls.isNotEmpty()) " ${s.cls}${if (s.conf < 0.6) "?" else ""}" else "", s.db.roundToInt()))
                        }
                    } else if (labelAt != null) {
                        val k = marks.peaks(pk, rangeDb)
                        for (j in 0 until k) {
                            val i = marks.pIdx[j]; val v = marks.pVal[j]
                            marks.add((i + 0.5f) * step, traceBase - v * band, "${labelAt(start + (i + 0.5f) / nc / zoom, zoom)} ${(floorDb + v * rangeDb).roundToInt()}dB")
                        }
                    }
                    val holdArgb = Palette.hold.toArgb()
                    drawIntoCanvas { marks.draw(it.nativeCanvas, w, traceTop, traceBase, dp, textPx, holdArgb) }
                }
            }
            // lines over everything, each on a dark casing so it reads over black grid and bright trace alike
            fun vline(x: Float, c: Color, lw: Float, bottom: Float = traceBase) {
                drawLine(Color.Black.copy(alpha = 0.6f), Offset(x, 0f), Offset(x, bottom), strokeWidth = lw + 2.5f * dp)
                drawLine(c, Offset(x, 0f), Offset(x, bottom), strokeWidth = lw)
            }
            channel?.let { (a, b) ->
                val x0 = (a - start) * zoom * w; val x1 = (b - start) * zoom * w
                vline(x0, accent, 1.25f * dp); vline(x1, accent, 1.25f * dp)
                if (onChannelEdge != null) {
                    val s = 5 * dp
                    val g = Path(); g.moveTo(x0, 6 * dp); g.lineTo(x0 - s, 6 * dp + s); g.lineTo(x0, 6 * dp + 2 * s); g.close()
                    g.moveTo(x1, 6 * dp); g.lineTo(x1 + s, 6 * dp + s); g.lineTo(x1, 6 * dp + 2 * s); g.close()
                    drawPath(g, Color.White.copy(alpha = 0.75f))
                }
            }
            if (centreMarker) toView(0.5f)?.let { vline(it * w, accent.copy(alpha = 0.66f), 0.8f * dp) }
            dragFrac?.let { f -> toView(f)?.let { vline(it * w, Palette.accent2, 2f * dp / 1.5f) } }

            // frequency axis: the view's own labels when zoomed, else the caller's
            if (axisH > 0f) {
                drawRect(Palette.surface, Offset(0f, bodyH), Size(w, axisH))
                val shown: List<Pair<Float, String>> = when {
                    zoom > 1.001f && labelAt != null -> (0..4).map { k -> val v = k / 4f; v to labelAt(start + v / zoom, zoom) }
                    zoom > 1.001f && centerHz > 0 && spanHz > 0 ->
                        (0..4).map { k -> val v = k / 4f; v to fmtMhz(centerHz + ((start + v / zoom - 0.5f) * spanHz).toLong(), if (zoom >= 8) 5 else 4) }
                    else -> labels.mapNotNull { (f, t) -> toView(f)?.let { it to t } }
                }
                axisPaint.color = Palette.muted.toArgb(); axisPaint.textAlign = android.graphics.Paint.Align.LEFT
                drawIntoCanvas { c ->
                    for ((v, text) in shown) {
                        val x = v * w
                        drawLine(accent.copy(alpha = 0.35f), Offset(x, bodyH), Offset(x, bodyH + axisH * 0.3f), 1f)
                        val tw = axisPaint.measureText(text)
                        c.nativeCanvas.drawText(text, (x - tw / 2f).coerceIn(2f, w - tw - 2f), bodyH + axisH * 0.85f, axisPaint)
                    }
                }
            }
            // span bar: the thumb is the span within the bar's window; drag it to slide the radio
            if (barH > 0f && barHi > barLo) {
                val top = h - barH
                drawRect(Palette.surface, Offset(0f, top), Size(w, barH))
                drawRect(Palette.line.copy(alpha = 0.8f), Offset(0f, top + barH / 2 - 1.5f * dp), Size(w, 3f * dp))
                val bw = (barHi - barLo).toFloat()
                var lo = (centerHz - spanHz / 2 - barLo) / bw; var hi = (centerHz + spanHz / 2 - barLo) / bw
                if (hi - lo < 0.02f) { val m = (lo + hi) / 2; lo = m - 0.01f; hi = m + 0.01f }
                // on the bar however small the span is against it, or however near its ends
                val tw = hi - lo; lo = lo.coerceIn(0f, max(0f, 1f - tw)); hi = lo + min(tw, 1f - lo)
                drawRoundRect(accent.copy(alpha = 0.85f), Offset(lo * w, top + 3 * dp), Size((hi - lo) * w, barH - 6 * dp), androidx.compose.ui.geometry.CornerRadius(3 * dp))
                if (zoom > 1.001f) drawRect(Color.White.copy(alpha = 0.8f), Offset((lo + (hi - lo) * start) * w, top + 3 * dp), Size(max(2f, (hi - lo) / zoom * w), barH - 6 * dp), style = Stroke(1f * dp))
                axisPaint.color = Palette.muted.toArgb()
                drawIntoCanvas { c ->
                    axisPaint.textAlign = android.graphics.Paint.Align.LEFT; c.nativeCanvas.drawText(fmtMhz(barLo, 2), 3 * dp, top + barH * 0.72f, axisPaint)
                    axisPaint.textAlign = android.graphics.Paint.Align.RIGHT; c.nativeCanvas.drawText(fmtMhz(barHi, 2), w - 3 * dp, top + barH * 0.72f, axisPaint)
                }
            }
        }
        // zoom: back to the channel (only while it is off the span), out, how far in (or the span), in
        val offSpan = channel != null && spanHz > 0 && abs((channel.first + channel.second) / 2 - 0.5f) > 0.5f - 40_000f / spanHz
        Row(Modifier.align(Alignment.TopEnd).padding(4.dp).background(Palette.surface.copy(alpha = 0.82f), RoundedCornerShape(6.dp)),
            verticalAlignment = Alignment.CenterVertically) {
            if (onRecentre != null && offSpan) ZoomBtn("⌖", Palette.accent2) { onRecentre(); setView(zoom, 0.5f) }
            ZoomBtn("−") { if (zoom <= 1.001f) onSpanStep?.invoke(-1) else setView(zoom / 2) }
            Text(if (zoom > 1.001f) "${zoom.roundToInt()}×" else if (spanHz > 0) fmtSpan(spanHz) else "1×", color = Palette.muted, fontFamily = Mono, fontSize = 10.sp)
            ZoomBtn("+") { if (zoom <= 1.001f && onSpanStep?.invoke(1) == true) return@ZoomBtn; val c = channel; setView(zoom * 2, c?.let { (it.first + it.second) / 2 }) }
        }
    }
}

@Composable
private fun ZoomBtn(t: String, color: Color = Palette.ink, onClick: () -> Unit) =
    Text(t, color = color, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 13.sp,
        modifier = Modifier.clickable { onClick() }.padding(horizontal = 9.dp, vertical = 4.dp))

private fun fmtMhz(hz: Long, dec: Int) = "%.${dec}f".format(hz / 1e6)
private fun fmtSpan(hz: Int) = if (hz % 1_000_000 == 0) "${hz / 1_000_000} MHz" else "%.2f MHz".format(hz / 1e6)

/**
 * The waterfall of a plain receiver: the channel shaded at its width for the mode, a tap snapping to a found signal
 * (and setting the mode when its shape is clear), the span bar sliding the radio and ⌖ bringing it back. With
 * [wholeRange] the span bar covers everything the radio tunes.
 */
@Composable
fun ReceiverScope(accent: Color, modifier: Modifier, rows: Int = 160, traceFrac: Float = 0.38f, fitMode: Boolean = true, wholeRange: Boolean = false) {
    val spec by SdrEngine.spectrum.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val wide = rememberDims().cls != ScreenClass.COMPACT
    val (a, b) = when (mode) {
        SdrEngine.Mode.WFM -> -100_000 to 100_000; SdrEngine.Mode.NFM -> -6_250 to 6_250; SdrEngine.Mode.AM -> -5_000 to 5_000
        SdrEngine.Mode.USB -> 0 to 3_000; SdrEngine.Mode.LSB -> -3_000 to 0; SdrEngine.Mode.NONE -> 0 to 0
    }
    val channel = if (mode == SdrEngine.Mode.NONE || rate <= 0) null else (0.5f + (offset + a).toFloat() / rate) to (0.5f + (offset + b).toFloat() / rate)
    fun target(f: Float): Pair<Long, com.rocketgod.mayhem.core.Signal?> {
        val hz = lo + ((f - 0.5f) * rate).toLong()
        val s = signalAt(hz, rate * 0.015)
        return if (s != null) signalDial(s, rasterFor(mode)) to s else ((hz / 1000.0).roundToLong() * 1000) to null
    }
    WaterfallView(spec, SdrEngine.SPEC_BINS, accent, modifier, rows = rows, traceFrac = traceFrac, centreMarker = offset != 0, channel = channel,
        labels = centredLabels(lo, rate),
        onPreviewFrac = { f -> Tuning.previewHz = f?.let { target(it).first } },
        onSlide = { SdrEngine.slideSpan(it) }, onRecentre = { SdrEngine.recentre() },
        onSpanStep = { dir -> SdrEngine.stepSpan(dir, if (wide) 20_000_000 else 10_000_000) },
        wholeRange = wholeRange,
    ) { f ->
        val (hz, s) = target(f)
        if (fitMode && s != null) modeFor(s)?.let { if (it != mode) SdrEngine.setMode(it) }
        SdrEngine.tune(hz)
    }
}

/** UI-only tuning preview shown by [FreqReadout] while a waterfall gesture is in progress. */
object Tuning {
    var previewHz by mutableStateOf<Long?>(null)
}

/** Frequency at horizontal fraction [frac] of a span centred on [centerHz], rounded to 1 kHz. */
fun spanHz(centerHz: Long, spanHz: Int, frac: Float): Long = Math.round((centerHz + ((frac - 0.5f) * spanHz).toLong()) / 1000.0) * 1000L

/** Axis labels for a span centred on [centerHz] with width [spanHz]. */
fun centredLabels(centerHz: Long, spanHz: Int): List<Pair<Float, String>> {
    val out = ArrayList<Pair<Float, String>>()
    for (k in 0..4) {
        val f = k / 4f
        val hz = centerHz + ((f - 0.5f) * spanHz).toLong()
        out.add(f to "%.3f".format(hz / 1e6))
    }
    return out
}

/** Axis labels for an absolute range. */
fun rangeLabels(startHz: Long, endHz: Long, n: Int = 5): List<Pair<Float, String>> {
    val out = ArrayList<Pair<Float, String>>()
    for (k in 0 until n) {
        val f = k / (n - 1).toFloat()
        val hz = startHz + ((endHz - startHz) * f.toDouble()).toLong()
        out.add(f to (if (endHz - startHz >= 50_000_000L) "%.0f".format(hz / 1e6) else "%.2f".format(hz / 1e6)))
    }
    return out
}

/** Rainbow ramp (SDR++ / GQRX style): dark → blue → cyan → green → yellow → red → white. */
fun heat(v: Float): Int {
    val t = v.coerceIn(0f, 1f)
    val hue = 240f * (1f - t)
    val sat = if (t > 0.85f) ((1f - t) / 0.15f).coerceIn(0f, 1f) else 1f
    val value = (0.10f + t * 1.5f).coerceIn(0f, 1f)
    return android.graphics.Color.HSVToColor(floatArrayOf(hue, sat, value))
}
