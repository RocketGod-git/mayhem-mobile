package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Waterfall (top) + live spectrum (bottom) with a filled trace, a decaying peak-hold line, a frequency axis and
 * an optional centre marker. [spec] is one row of normalised 0..1 magnitudes, [cols] wide; every new row scrolls
 * the bitmap. [labels] are (fraction → text) axis labels.
 *
 * Tuning gesture: press anywhere, slide left/right — an accent guide line follows the finger and [onPreviewFrac]
 * reports the fraction under it (null when the gesture ends) — and [onTapFrac] fires with the final fraction only
 * when the finger (or mouse button) is lifted, so the radio retunes once, on release.
 */
@Composable
fun WaterfallView(
    spec: FloatArray, cols: Int, accent: Color, modifier: Modifier = Modifier,
    rows: Int = 140, traceFrac: Float = 0.38f, centreMarker: Boolean = true,
    /** A receiver's pass band as [from, to] fractions of the span, shaded so the channel can be seen. */
    channel: Pair<Float, Float>? = null,
    labels: List<Pair<Float, String>> = emptyList(), onPreviewFrac: ((Float?) -> Unit)? = null, onTapFrac: ((Float) -> Unit)? = null
) {
    var dragFrac by remember { mutableStateOf<Float?>(null) }
    val pixels = remember(cols, rows) { IntArray(cols * rows) }
    val bmp = remember(cols, rows) { android.graphics.Bitmap.createBitmap(cols, rows, android.graphics.Bitmap.Config.ARGB_8888) }
    val peak = remember(cols) { FloatArray(cols) }
    var frame by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val textPx = with(density) { 9.sp.toPx() }
    val paint = remember(textPx) {
        android.graphics.Paint().apply {
            color = Palette.muted.toArgb(); textSize = textPx; typeface = android.graphics.Typeface.MONOSPACE; isAntiAlias = true
        }
    }
    LaunchedEffect(spec) {
        if (spec.size >= cols && cols > 0) {
            System.arraycopy(pixels, 0, pixels, cols, cols * (rows - 1))
            for (x in 0 until cols) {
                pixels[x] = heat(spec[x])
                peak[x] = if (spec[x] > peak[x]) spec[x] else peak[x] * 0.985f
            }
            bmp.setPixels(pixels, 0, cols, 0, 0, cols, rows)
            frame++
        }
    }
    Canvas(
        modifier.panel(accent.copy(alpha = 0.7f), RoundedCornerShape(8.dp)).clipToBounds().pointerInput(onTapFrac, onPreviewFrac) {
            if (onTapFrac != null) awaitEachGesture {
                val down = awaitFirstDown()
                val w = size.width.toFloat().coerceAtLeast(1f)
                var frac = (down.position.x / w).coerceIn(0f, 1f)
                dragFrac = frac; onPreviewFrac?.invoke(frac)
                down.consume()
                while (true) {
                    val ev = awaitPointerEvent()
                    val ch = ev.changes.firstOrNull { it.id == down.id } ?: ev.changes.first()
                    frac = (ch.position.x / w).coerceIn(0f, 1f)
                    if (ch.changedToUp() || !ch.pressed) break
                    if (ch.positionChanged()) { dragFrac = frac; onPreviewFrac?.invoke(frac); ch.consume() }
                }
                dragFrac = null; onPreviewFrac?.invoke(null)
                onTapFrac(frac)
            }
        }
    ) {
        frame
        val w = size.width; val h = size.height
        val axisH = if (labels.isEmpty()) 0f else textPx * 1.6f
        val wfH = (h - axisH) * (1f - traceFrac)
        val traceTop = wfH + 2f
        val traceBase = h - axisH
        drawIntoCanvas { c ->
            val dst = android.graphics.Rect(0, 0, w.toInt(), wfH.toInt())
            c.nativeCanvas.drawBitmap(bmp, null, dst, null)
        }
        // spectrum pane background
        drawRect(Palette.paper.copy(alpha = 0.85f), Offset(0f, wfH), androidx.compose.ui.geometry.Size(w, traceBase - wfH))
        // faint dB grid
        for (k in 1..3) {
            val y = traceBase - (traceBase - traceTop) * k / 4f
            drawLine(accent.copy(alpha = 0.10f), Offset(0f, y), Offset(w, y), 1f)
        }
        if (spec.size >= cols && cols > 1) {
            val band = traceBase - traceTop
            val step = w / (cols - 1)
            val fill = Path()
            fill.moveTo(0f, traceBase)
            for (i in 0 until cols) fill.lineTo(i * step, traceBase - spec[i] * band)
            fill.lineTo(w, traceBase); fill.close()
            drawPath(fill, Brush.verticalGradient(listOf(accent.copy(alpha = 0.55f), accent.copy(alpha = 0.05f)), startY = traceTop, endY = traceBase))
            val line = Path()
            line.moveTo(0f, traceBase - spec[0] * band)
            for (i in 1 until cols) line.lineTo(i * step, traceBase - spec[i] * band)
            drawPath(line, accent, style = Stroke(2f, cap = StrokeCap.Round))
            val hold = Path()
            hold.moveTo(0f, traceBase - peak[0] * band)
            for (i in 1 until cols) hold.lineTo(i * step, traceBase - peak[i] * band)
            drawPath(hold, Palette.hold.copy(alpha = 0.6f), style = Stroke(1f))
        }
        if (centreMarker) {
            drawLine(accent.copy(alpha = 0.55f), Offset(w / 2, 0f), Offset(w / 2, traceBase), strokeWidth = 1.5f)
        }
        channel?.let { (a, b) ->
            val x0 = (minOf(a, b) * w).coerceIn(0f, w); val x1 = (maxOf(a, b) * w).coerceIn(0f, w)
            drawRect(accent.copy(alpha = 0.22f), Offset(x0, 0f), androidx.compose.ui.geometry.Size(maxOf(2f, x1 - x0), traceBase))
            drawLine(accent, Offset((x0 + x1) / 2, 0f), Offset((x0 + x1) / 2, traceBase), strokeWidth = 1.5f)
        }
        dragFrac?.let { f ->
            val x = f * w
            drawLine(Color.Black.copy(alpha = 0.5f), Offset(x, 0f), Offset(x, traceBase), strokeWidth = 4f)
            drawLine(Palette.accent2, Offset(x, 0f), Offset(x, traceBase), strokeWidth = 2f)
        }
        if (labels.isNotEmpty()) {
            drawRect(Palette.surface, Offset(0f, traceBase), androidx.compose.ui.geometry.Size(w, axisH))
            drawIntoCanvas { c ->
                for ((f, text) in labels) {
                    val x = f * w
                    drawLine(accent.copy(alpha = 0.35f), Offset(x, traceBase), Offset(x, traceBase + axisH * 0.3f), 1f)
                    val tw = paint.measureText(text)
                    val tx = (x - tw / 2f).coerceIn(2f, w - tw - 2f)
                    c.nativeCanvas.drawText(text, tx, traceBase + axisH * 0.85f, paint)
                }
            }
        }
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

/** Classic multi-colour waterfall ramp (SDR++/GQRX style): dark → blue → cyan → green → yellow → red → white. */
fun heat(v: Float): Int {
    val t = v.coerceIn(0f, 1f)
    val hue = 240f * (1f - t)
    val sat = if (t > 0.85f) ((1f - t) / 0.15f).coerceIn(0f, 1f) else 1f
    val value = (0.10f + t * 1.5f).coerceIn(0f, 1f)
    return android.graphics.Color.HSVToColor(floatArrayOf(hue, sat, value))
}
