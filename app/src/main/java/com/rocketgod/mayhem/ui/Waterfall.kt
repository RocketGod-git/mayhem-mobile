package com.rocketgod.mayhem.ui

import android.content.Context
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
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.SdrEngine
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Waterfall colour maps. Inferno is the web app's and the default; the others follow taste or the skin. */
enum class WfPalette(val title: String) {
    INFERNO("Inferno · the web app's"), RAINBOW("Rainbow · SDR++ style"), SKIN("Skin · the theme's own colours");
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

/**
 * Waterfall (top), live spectrum (bottom), frequency axis and, when [onSlide] is given, a span bar: the twin of the
 * web app's scope.
 *
 * - One column per spectrum bin, coloured by the chosen palette; when the radio moves ([centerHz]) the history
 *   slides with it so what was painted stays under its true frequency, and only a span change clears it.
 * - Pinch (or the − / + buttons) zooms up to 32×; two fingers pan a zoomed view, and at 1× slide the span itself.
 * - Press and slide to pick a frequency: a guide and [onPreviewFrac] follow the finger, [onTapFrac] fires on release.
 * - The channel ([channel]) is shaded with its edges drawn last; with [onChannelEdge] the edges can be dragged.
 * - Signals found by the engine's classifier are labelled with frequency, class and level; the spectrum carries a
 *   dB grid against the engine's floor.
 *
 * Every fraction passed in or out is of the whole span, whatever the zoom.
 */
@Composable
fun WaterfallView(
    spec: FloatArray, cols: Int, accent: Color, modifier: Modifier = Modifier,
    rows: Int = 140, traceFrac: Float = 0.38f, centreMarker: Boolean = true,
    channel: Pair<Float, Float>? = null,
    labels: List<Pair<Float, String>> = emptyList(), onPreviewFrac: ((Float?) -> Unit)? = null,
    /** The span the spectrum covers; -1 takes the engine's own, 0 means a sweep (no fixed span to label or slide). */
    centerHz0: Long = -1L, spanHz0: Int = -1,
    onChannelEdge: ((lo: Float, hi: Float, hiEdge: Boolean) -> Unit)? = null,
    onSlide: ((Long) -> Unit)? = null,
    onRecentre: (() -> Unit)? = null,
    /** Zooming out past 1× (−1) widens the span itself, and zooming in from a wide span (+1) narrows it; true when it did. */
    onSpanStep: ((Int) -> Boolean)? = null,
    showSignals: Boolean = true,
    onTapFrac: ((Float) -> Unit)? = null,
) {
    val engineLo by SdrEngine.freqHz.collectAsState()
    val engineRate by SdrEngine.rateHz.collectAsState()
    val centerHz = if (centerHz0 < 0) engineLo else centerHz0
    val spanHz = if (spanHz0 < 0) engineRate else spanHz0
    val n = if (spec.isNotEmpty()) spec.size else max(1, cols)
    val pixels = remember(n, rows) { IntArray(n * rows) }
    val bmp = remember(n, rows) { android.graphics.Bitmap.createBitmap(n, rows, android.graphics.Bitmap.Config.ARGB_8888) }
    val peak = remember(n) { FloatArray(n) }
    var frame by remember { mutableIntStateOf(0) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var start by remember { mutableFloatStateOf(0f) }
    var dragFrac by remember { mutableStateOf<Float?>(null) }
    var lastCenter by remember { mutableStateOf(0L) }
    var lastSpan by remember { mutableStateOf(0) }
    var barLo by remember { mutableStateOf(0L) }
    var barHi by remember { mutableStateOf(0L) }
    val palette = Waterfalls.palette
    val lut = remember(palette, Palette.paper, Palette.accent, Palette.accent2) { Waterfalls.lut(palette, Palette.paper, Palette.accent, Palette.accent2) }
    val scale by SdrEngine.specScale.collectAsState()
    val signals by SdrEngine.signals.collectAsState()
    val density = LocalDensity.current
    val dp = density.density
    val textPx = with(density) { 9.sp.toPx() }
    val axisPaint = remember(textPx) { android.graphics.Paint().apply { textSize = textPx; typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true } }
    val bmpPaint = remember { android.graphics.Paint() }

    LaunchedEffect(spec) {
        if (spec.size < n) return@LaunchedEffect
        // the radio moved: slide the history so old rows stay under their frequencies; a new span clears it
        if (centerHz != 0L && spanHz > 0) {
            if (lastSpan != 0 && lastSpan != spanHz) { pixels.fill(0xFF000004.toInt()); peak.fill(0f) }
            else if (lastCenter != 0L && centerHz != lastCenter) {
                val dx = ((centerHz - lastCenter).toDouble() / spanHz * n).roundToInt()
                if (abs(dx) >= n) { pixels.fill(0xFF000004.toInt()); peak.fill(0f) }
                else if (dx != 0) for (r in 0 until rows) {
                    val o = r * n
                    if (dx > 0) { System.arraycopy(pixels, o + dx, pixels, o, n - dx); java.util.Arrays.fill(pixels, o + n - dx, o + n, 0xFF000004.toInt()) }
                    else { System.arraycopy(pixels, o, pixels, o - dx, n + dx); java.util.Arrays.fill(pixels, o, o - dx, 0xFF000004.toInt()) }
                }
            }
            lastCenter = centerHz; lastSpan = spanHz
        }
        System.arraycopy(pixels, 0, pixels, n, n * (rows - 1))
        for (x in 0 until n) {
            val v = spec[x]
            pixels[x] = lut[(v * 255f).toInt().coerceIn(0, 255)]
            peak[x] = if (v > peak[x]) v else peak[x] * 0.985f
        }
        bmp.setPixels(pixels, 0, n, 0, 0, n, rows)
        frame++
    }

    // the span bar's window: 24 spans around the radio, re-centred only when the span nears its edge
    if (onSlide != null && spanHz > 0 && centerHz > 0) {
        val w = 24L * spanHz
        if (barHi - barLo != w || centerHz - spanHz / 2 < barLo || centerHz + spanHz / 2 > barHi) {
            barLo = max(0L, centerHz - w / 2); barHi = barLo + w
        }
    }

    fun clampStart(s: Float, z: Float) = s.coerceIn(0f, max(0f, 1f - 1f / z))
    fun setView(z0: Float, keepFrac: Float? = null, at: Float = 0.5f) {
        val z = z0.coerceIn(1f, 32f)
        val keep = keepFrac ?: (start + 0.5f / zoom)
        start = clampStart(keep - at / z, z); zoom = z
    }

    // the gesture reads these as they are now, without restarting (and dropping a drag) every time one changes
    val channelNow = rememberUpdatedState(channel); val centerNow = rememberUpdatedState(centerHz); val spanNow = rememberUpdatedState(spanHz)
    val tapNow = rememberUpdatedState(onTapFrac); val previewNow = rememberUpdatedState(onPreviewFrac)
    val edgeNow = rememberUpdatedState(onChannelEdge); val slideNow = rememberUpdatedState(onSlide)
    Box(modifier.panel(accent.copy(alpha = 0.7f), RoundedCornerShape(8.dp)).clipToBounds()) {
        Canvas(Modifier.fillMaxSize().pointerInput(Unit) {
            awaitEachGesture {
                val channel = channelNow.value; val centerHz = centerNow.value; val spanHz = spanNow.value
                val onTapFrac = tapNow.value; val onPreviewFrac = previewNow.value; val onChannelEdge = edgeNow.value; val onSlide = slideNow.value
                val down = awaitFirstDown(requireUnconsumed = false)
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
                    if (abs(f - c) <= half + 0.01f) f - c else 0f
                } else 0f
                if (onBar && grab == 0f && barW > 0) onSlide?.invoke((barLo + (down.position.x / w) * barW).roundToLong())
                if (!onBar && edge == null && onTapFrac != null) { dragFrac = fullFrac(down.position.x); onPreviewFrac?.invoke(dragFrac) }
                down.consume()
                while (true) {
                    val ev = awaitPointerEvent()
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
                val f = dragFrac
                if (f != null) { dragFrac = null; onPreviewFrac?.invoke(null); if (!multi) onTapFrac?.invoke(f) }
            }
        }) {
            frame
            val w = size.width; val h = size.height
            val barH = if (onSlide != null) 16 * dp else 0f
            val axisH = if (labels.isEmpty() && centerHz == 0L) 0f else textPx * 1.6f
            val bodyH = h - axisH - barH
            val wfH = bodyH * (1f - traceFrac)
            val traceTop = wfH + 2f
            val traceBase = bodyH
            fun toView(f: Float): Float? { val v = (f - start) * zoom; return if (v >= -0.001f && v <= 1.001f) v else null }

            // waterfall: the zoomed window of the history, scaled to the width
            drawIntoCanvas { c ->
                val sx0 = (start * n).toInt().coerceIn(0, n - 1); val sx1 = ceil((start + 1f / zoom) * n).toInt().coerceIn(sx0 + 1, n)
                bmpPaint.isFilterBitmap = sx1 - sx0 > w
                c.nativeCanvas.drawBitmap(bmp, android.graphics.Rect(sx0, 0, sx1, rows), android.graphics.Rect(0, 0, w.toInt(), wfH.toInt()), bmpPaint)
            }
            channel?.let { (a, b) ->
                val x0 = (a - start) * zoom * w; val x1 = (b - start) * zoom * w
                drawRect(Color.White.copy(alpha = 0.05f), Offset(min(x0, x1), 0f), Size(max(2f, abs(x1 - x0)), wfH))
            }
            // spectrum pane and its dB grid against the engine's floor
            drawRect(Palette.paper.copy(alpha = 0.9f), Offset(0f, wfH), Size(w, traceBase - wfH))
            val (floorDb, rangeDb) = scale
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
            if (spec.size >= n && n > 1) {
                val band = traceBase - traceTop
                val i0 = floor(start * n).toInt().coerceIn(0, n - 1); val i1 = ceil((start + 1f / zoom) * n).toInt().coerceIn(i0 + 1, n)
                fun xAt(i: Int) = (((i + 0.5f) / n) - start) * zoom * w
                val fill = Path(); fill.moveTo(xAt(i0), traceBase)
                for (i in i0 until i1) fill.lineTo(xAt(i), traceBase - spec[i] * band)
                fill.lineTo(xAt(i1 - 1), traceBase); fill.close()
                drawPath(fill, Brush.verticalGradient(listOf(accent.copy(alpha = 0.66f), accent.copy(alpha = 0.06f)), startY = traceTop, endY = traceBase))
                val line = Path(); line.moveTo(xAt(i0), traceBase - spec[i0] * band)
                for (i in i0 + 1 until i1) line.lineTo(xAt(i), traceBase - spec[i] * band)
                drawPath(line, accent.copy(alpha = 0.25f), style = Stroke(5f * dp / 2, cap = StrokeCap.Round, join = StrokeJoin.Round))   // glow
                drawPath(line, accent, style = Stroke(1.25f * dp, cap = StrokeCap.Round, join = StrokeJoin.Round))
                val hold = Path(); hold.moveTo(xAt(i0), traceBase - peak[i0] * band)
                for (i in i0 + 1 until i1) hold.lineTo(xAt(i), traceBase - peak[i] * band)
                drawPath(hold, Palette.hold.copy(alpha = 0.6f), style = Stroke(1f))
                if (showSignals && centerHz > 0 && spanHz > 0 && !floorDb.isNaN()) signalLabels(signals.take(8), centerHz, spanHz, w, traceTop, traceBase, floorDb, rangeDb, textPx, dp, ::toView)
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
                val shown: List<Pair<Float, String>> = if (zoom > 1.001f && centerHz > 0 && spanHz > 0)
                    (0..4).map { k -> val v = k / 4f; v to fmtMhz(centerHz + ((start + v / zoom - 0.5f) * spanHz).toLong(), if (zoom >= 8) 5 else 4) }
                else labels.mapNotNull { (f, t) -> toView(f)?.let { it to t } }
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
            // span bar: the thumb is the span within a 24-span window; drag it to slide the radio
            if (barH > 0f && barHi > barLo) {
                val top = h - barH
                drawRect(Palette.surface, Offset(0f, top), Size(w, barH))
                drawRect(Palette.line.copy(alpha = 0.8f), Offset(0f, top + barH / 2 - 1.5f * dp), Size(w, 3f * dp))
                val bw = (barHi - barLo).toFloat()
                var lo = (centerHz - spanHz / 2 - barLo) / bw; var hi = (centerHz + spanHz / 2 - barLo) / bw
                if (hi - lo < 0.02f) { val m = (lo + hi) / 2; lo = m - 0.01f; hi = m + 0.01f }
                drawRoundRect(accent.copy(alpha = 0.85f), Offset(lo * w, top + 3 * dp), Size((hi - lo) * w, barH - 6 * dp), androidx.compose.ui.geometry.CornerRadius(3 * dp))
                if (zoom > 1.001f) drawRect(Color.White.copy(alpha = 0.8f), Offset((lo + (hi - lo) * start) * w, top + 3 * dp), Size(max(2f, (hi - lo) / zoom * w), barH - 6 * dp), style = Stroke(1f * dp))
                axisPaint.color = Palette.muted.toArgb()
                drawIntoCanvas { c ->
                    axisPaint.textAlign = android.graphics.Paint.Align.LEFT; c.nativeCanvas.drawText(fmtMhz(barLo, 2), 3 * dp, top + barH * 0.72f, axisPaint)
                    axisPaint.textAlign = android.graphics.Paint.Align.RIGHT; c.nativeCanvas.drawText(fmtMhz(barHi, 2), w - 3 * dp, top + barH * 0.72f, axisPaint)
                }
            }
        }
        // zoom: back to the channel, out, how far in (or the span), in
        Row(Modifier.align(Alignment.TopEnd).padding(4.dp).background(Palette.surface.copy(alpha = 0.82f), RoundedCornerShape(6.dp)),
            verticalAlignment = Alignment.CenterVertically) {
            if (onRecentre != null) ZoomBtn("⌖") { onRecentre(); setView(zoom, 0.5f) }
            ZoomBtn("−") { if (zoom <= 1.001f) onSpanStep?.invoke(-1) else setView(zoom / 2) }
            Text(if (zoom > 1.001f) "${zoom.roundToInt()}×" else if (spanHz > 0) fmtSpan(spanHz) else "1×", color = Palette.muted, fontFamily = Mono, fontSize = 10.sp)
            ZoomBtn("+") { if (zoom <= 1.001f && onSpanStep?.invoke(1) == true) return@ZoomBtn; val c = channel; setView(zoom * 2, c?.let { (it.first + it.second) / 2 }) }
        }
    }
}

@Composable
private fun ZoomBtn(t: String, onClick: () -> Unit) =
    Text(t, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 13.sp,
        modifier = Modifier.clickable { onClick() }.padding(horizontal = 9.dp, vertical = 4.dp))

private fun DrawScope.signalLabels(
    list: List<com.rocketgod.mayhem.core.Signal>, centerHz: Long, spanHz: Int, w: Float, top: Float, base: Float,
    floorDb: Float, rangeDb: Float, textPx: Float, dp: Float, toView: (Float) -> Float?,
) {
    val p = android.graphics.Paint().apply { textSize = textPx; typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true }
    val bg = android.graphics.Paint().apply { color = 0x8C000000.toInt() }
    val holdArgb = Palette.hold.toArgb()
    // strongest first; each label takes the first of three rows where it overlaps nothing, or is left out
    val taken = Array(3) { ArrayList<Pair<Float, Float>>() }
    for (s in list.sortedByDescending { it.snr }) {
        val v = toView((0.5 + (s.hz - centerHz) / spanHz).toFloat()) ?: continue
        val x = v * w
        val y = base - ((s.db.toFloat() - floorDb) / rangeDb).coerceIn(0f, 1f) * (base - top)
        val text = "%.3f%s %ddB".format(s.hz / 1e6, if (s.cls.isNotEmpty()) " ${s.cls}${if (s.conf < 0.6) "?" else ""}" else "", s.snr.roundToInt())
        val tw = p.measureText(text)
        val right = x > w * 0.85f
        val tx = if (right) x - 3 * dp - tw else x + 3 * dp
        val span = (tx - 4 * dp) to (tx + tw + 4 * dp)
        val row = (0 until 3).firstOrNull { r -> taken[r].none { it.first < span.second && span.first < it.second } } ?: continue
        taken[row].add(span)
        val ty = max(top + 11 * dp * (row + 1), y - 2 * dp - row * 11 * dp)
        drawIntoCanvas { c ->
            c.nativeCanvas.drawRect(tx - 2 * dp, ty - 10 * dp, tx + tw + 2 * dp, ty + 1 * dp, bg)
            p.color = holdArgb; c.nativeCanvas.drawText(text, tx, ty, p)
            c.nativeCanvas.drawRect(x - dp / 2, y, x + dp / 2, base, p)
        }
    }
}

private fun fmtMhz(hz: Long, dec: Int) = "%.${dec}f".format(hz / 1e6)
private fun fmtSpan(hz: Int) = if (hz % 1_000_000 == 0) "${hz / 1_000_000} MHz" else "%.2f MHz".format(hz / 1e6)

/** The signal under a tap: the strongest whose band holds it, else the nearest within [reachHz]. */
fun signalAt(hz: Long, reachHz: Double): com.rocketgod.mayhem.core.Signal? {
    var inside: com.rocketgod.mayhem.core.Signal? = null; var near: com.rocketgod.mayhem.core.Signal? = null; var nearD = Double.MAX_VALUE
    for (s in SdrEngine.signals.value) {
        val d = abs(s.hz - hz)
        if (d <= s.bw6 / 2 + reachHz / 3 && (inside == null || s.db > inside.db)) inside = s
        if (d <= reachHz && d < nearD) { near = s; nearD = d }
    }
    return inside ?: near
}

/** The channel raster a mode lives on, for snapping. */
fun rasterFor(m: SdrEngine.Mode): Long = when (m) { SdrEngine.Mode.WFM -> 100_000L; SdrEngine.Mode.NFM -> 12_500L; SdrEngine.Mode.AM -> 10_000L; else -> 1_000L }

/**
 * Where to put the dial for a signal: its measured centre, pulled onto the raster when close (a repeater measured
 * 200 Hz off still reads 146.520). SSB humps sit beside the suppressed carrier, so the dial goes to the carrier.
 */
fun signalDial(s: com.rocketgod.mayhem.core.Signal, raster: Long): Long {
    var hz = s.hz
    if (s.cls == "USB") hz -= s.bw6 / 2 + 300 else if (s.cls == "LSB") hz += s.bw6 / 2 + 300
    val on = (hz / raster).roundToLong() * raster
    val wide = s.cls == "WFM" || s.cls == "WIDE" || s.bw6 > 60_000
    if (abs(on - hz) < if (wide) raster / 2.0 else max(raster / 3.0, s.bw6 * 0.2)) return on
    return (hz / 100).roundToLong() * 100
}

/** The mode a tapped signal asks for, only when its shape is clear: a wide hump is WFM, a confident label picks its own. */
fun modeFor(s: com.rocketgod.mayhem.core.Signal): SdrEngine.Mode? {
    val wide = s.cls == "WFM" || s.cls == "WIDE" || s.bw6 > 60_000 || (s.hz > 87_500_000 && s.hz < 108_000_000)
    if (wide) return SdrEngine.Mode.WFM
    if (s.conf < 0.6) return null
    return when (s.cls) { "AM" -> SdrEngine.Mode.AM; "USB" -> SdrEngine.Mode.USB; "LSB" -> SdrEngine.Mode.LSB; "NFM", "DMR", "FSK" -> SdrEngine.Mode.NFM; else -> null }
}

/**
 * The waterfall of a plain receiver: the channel shaded at its width for the mode, a tap snapping to a found signal
 * (and setting the mode when its shape is clear), the span bar sliding the radio and ⌖ bringing it back.
 */
@Composable
fun ReceiverScope(accent: Color, modifier: Modifier, rows: Int = 160, traceFrac: Float = 0.38f, fitMode: Boolean = true) {
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
