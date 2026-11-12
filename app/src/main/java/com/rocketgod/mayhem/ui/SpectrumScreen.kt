package com.rocketgod.mayhem.ui

import android.graphics.Bitmap
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.spectrum.DETECTORS
import com.rocketgod.mayhem.core.spectrum.Meas
import com.rocketgod.mayhem.core.spectrum.SPAN_PRESETS
import com.rocketgod.mayhem.core.spectrum.SpMode
import com.rocketgod.mayhem.core.spectrum.SpUnit
import com.rocketgod.mayhem.core.spectrum.Spectrum
import com.rocketgod.mayhem.core.spectrum.TRACE_MODES
import com.rocketgod.mayhem.core.spectrum.TRIG_MODES
import com.rocketgod.mayhem.core.spectrum.TraceMode
import com.rocketgod.mayhem.core.spectrum.TrigMode
import com.rocketgod.mayhem.core.spectrum.WindowKind
import com.rocketgod.mayhem.core.spectrum.bwText
import com.rocketgod.mayhem.core.spectrum.fmtHz
import com.rocketgod.mayhem.core.spectrum.fmtSec
import com.rocketgod.mayhem.core.spectrum.occupiedBw
import com.rocketgod.mayhem.core.spectrum.toColumns
import java.io.ByteArrayOutputStream
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * The Spectrum screen: a bench spectrum analyzer and its zero-span (waveform) mode. The header line, the plot (10×10
 * graticule, traces, markers, measurement bands, persistence; or the zero-span panes), the readout rows, then every
 * control. The state and the measurements are core/spectrum/Spectrum.kt. Twin of the web app's web/src/spectrum-ui.ts.
 */

/** Trace colors (a bench analyzer's yellow, cyan, magenta, green). */
val TRACE_COLOR = listOf(Color(0xFFFFD400), Color(0xFF3FD0C9), Color(0xFFFF5DD8), Color(0xFF3FD07A))
private val AMBER = Color(0xFFFFAF00)
private val MEAS_BLUE = Color(0xFF4C8DFF)

private fun mono(f: String, vararg a: Any?) = String.format(Locale.US, f, *a)
/** A dB label as the web prints it: no trailing zeros. */
private fun dbLabel(v: Double): String { val s = mono("%.1f", v); return if (s.endsWith(".0")) s.dropLast(2) else s }

/** What a save is waiting to write, for the document picker. */
private class PendingBytes(val name: String, val bytes: ByteArray)

@Composable
fun SpectrumScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    @Suppress("UNUSED_VARIABLE") val ver by Spectrum.ver.collectAsState()
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val tunerAgc by SdrEngine.tunerAgc.collectAsState()
    val kind by Radio.kind.collectAsState()
    // the gain moved (RADIO panel): the scale follows it, and a trigger level in dBm keeps its meaning
    LaunchedEffect(lna, vga, amp, tunerAgc, kind) { Spectrum.gainChanged() }

    var pending by remember { mutableStateOf<PendingBytes?>(null) }
    val onSaved: (android.net.Uri?) -> Unit = { uri ->
        val p = pending; pending = null
        if (uri != null && p != null) runCatching { ctx.contentResolver.openOutputStream(uri)?.use { it.write(p.bytes) }; Spectrum.saved(p.name) }
            .onFailure { Toast.makeText(ctx, "Could not save the file", Toast.LENGTH_LONG).show() }
    }
    val csvSaver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv"), onSaved)
    val pngSaver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/png"), onSaved)
    val exportCsv = { val n = Spectrum.fileName("csv"); pending = PendingBytes(n, Spectrum.csv().toByteArray()); runCatching { csvSaver.launch(n) }; Unit }
    val exportPng = { val n = Spectrum.fileName("png"); pending = PendingBytes(n, pngBytes()); runCatching { pngSaver.launch(n) }; Unit }

    AdaptivePane(
        face = { SpHeader(accent) },
        visual = { m ->
            Column(m, verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) { SpPlot() }
                SpReadout(accent)
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                SpControls(accent, exportCsv, exportPng)
            }
        }
    }
}

// ---- header and readouts ---------------------------------------------------------------------------------------

@Composable
private fun SpHeader(accent: Color) {
    val d = rememberDims()
    val (big, line) = Spectrum.header()
    Column(Modifier.fillMaxWidth().panel(accent.copy(alpha = 0.5f), RoundedCornerShape(d.dp(12f))).padding(horizontal = d.dp(10f), vertical = d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("SPECTRUM", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f), letterSpacing = 2.sp,
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(accent).padding(horizontal = d.dp(6f), vertical = 2.dp))
            Text("ANALYZER · ZERO SPAN", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = d.dp(8f)))
        }
        Text(big, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(22f), maxLines = 1, softWrap = false,
            modifier = Modifier.padding(top = d.dp(2f)))
        Text(line, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SpReadout(accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (r in Spectrum.readout()) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                .background(if (r.on) AMBER.copy(alpha = 0.12f) else if (r.meas) MEAS_BLUE.copy(alpha = 0.10f) else Palette.surface)
                .padding(horizontal = d.dp(8f), vertical = d.dp(3f)), verticalAlignment = Alignment.CenterVertically) {
                if (r.label.isNotEmpty()) Text(r.label, color = if (r.on) AMBER else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10.5f),
                    modifier = Modifier.width(d.dp(46f)))
                Text(r.text, color = if (r.dim) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
                if (r.tag.isNotEmpty()) {
                    val ti = r.tag.removePrefix("T").toIntOrNull()?.minus(1) ?: 0
                    Text(r.tag, color = TRACE_COLOR.getOrElse(ti) { Palette.muted }, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
                }
            }
        }
    }
}

// ---- the plot --------------------------------------------------------------------------------------------------

@Composable
private fun SpPlot() {
    @Suppress("UNUSED_VARIABLE") val ver by Spectrum.ver.collectAsState()
    val k = LocalDensity.current.density
    val focus = remember { FocusRequester() }
    var widthPx by remember { mutableStateOf(1f) }
    fun fx(x: Float): Double { val g = geom(widthPx, 1f, k); return ((x - g.l) / g.w).toDouble() }
    Canvas(Modifier.fillMaxSize().focusRequester(focus).focusable()
        .onKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
            when (e.key) {
                Key.DirectionLeft -> Spectrum.onKey("left"); Key.DirectionRight -> Spectrum.onKey("right")
                Key.P -> Spectrum.onKey("peak"); Key.N -> Spectrum.onKey("next"); else -> false
            }
        }
        .pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown()
                runCatching { focus.requestFocus() }
                Spectrum.pointer(fx(down.position.x), true)
                while (true) {
                    val ev = awaitPointerEvent()
                    val c = ev.changes.firstOrNull() ?: break
                    if (!c.pressed) break
                    if (c.positionChange() != androidx.compose.ui.geometry.Offset.Zero) { Spectrum.pointer(fx(c.position.x), false); c.consume() }
                }
                Spectrum.pointerUp()
            }
        }) {
        widthPx = size.width
        val g = geom(size.width, size.height, k)
        drawIntoCanvas { renderPlot(it.nativeCanvas, g, k) }
    }
}

/** The plot area inside the canvas: left, top, width, height of the graticule, and the whole canvas, in pixels. */
private class Geom(val l: Float, val t: Float, val w: Float, val h: Float, val fullW: Float, val fullH: Float)
private fun geom(W: Float, H: Float, k: Float): Geom {
    val l = 46 * k; val t = 8 * k; val r = 8 * k; val b = 22 * k
    return Geom(l, t, W - l - r, H - t - b, W, H)
}

private fun paint(c: Color, k: Float, stroke: Float = 0f, text: Float = 0f, align: Paint.Align = Paint.Align.LEFT): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = c.toArgb()
    if (stroke > 0f) { style = Paint.Style.STROKE; strokeWidth = stroke * k }
    if (text > 0f) { textSize = text * k; typeface = Typeface.MONOSPACE; textAlign = align }
}

/** Draw the whole plot into a canvas (the screen, or the PNG export); [k] is pixels per CSS pixel. */
private fun renderPlot(cv: android.graphics.Canvas, g: Geom, k: Float) {
    val paper = Palette.paper; val line = Palette.line; val muted = Palette.muted
    cv.drawRect(0f, 0f, g.fullW, g.fullH, paint(paper, k))
    if (Spectrum.s.mode == SpMode.ZERO) { renderZero(cv, g, k, line, muted); return }
    val s = Spectrum.s; val top = s.ref.toDouble(); val range = s.div * 10.0
    fun yOf(v: Double) = (g.t + (top - v) / range * g.h).toFloat()
    // persistence under everything
    val per = Spectrum.persistence
    if (s.persist && per != null) {
        val lv = per.level()
        val px = IntArray(lv.size)
        for (i in lv.indices) {
            val v = lv[i]; if (v == 0f) continue
            // dark blue → cyan → yellow → white
            val r = if (v < 0.5f) 0f else (v - 0.5f) * 2 * 255; val gg = min(255f, v * 2 * 255); val b = if (v < 0.5f) 120 + v * 270 else 255 - (v - 0.5f) * 300
            val a = min(255f, 60 + v * 400)
            px[i] = (a.toInt() shl 24) or (r.toInt().coerceIn(0, 255) shl 16) or (gg.toInt().coerceIn(0, 255) shl 8) or max(0f, b).toInt().coerceIn(0, 255)
        }
        val bmp = Bitmap.createBitmap(px, per.cols, per.rows, Bitmap.Config.ARGB_8888)
        cv.drawBitmap(bmp, Rect(0, 0, per.cols, per.rows), RectF(g.l, g.t, g.l + g.w, g.t + g.h), Paint(Paint.FILTER_BITMAP_FLAG))
    }
    // graticule: 10 by 10
    val grid = paint(line, k, stroke = 1f); val lab = paint(muted, k, text = 10f, align = Paint.Align.RIGHT)
    for (q in 0..10) {
        val x = g.l + q * g.w / 10; val y = g.t + q * g.h / 10
        cv.drawLine(x, g.t, x, g.t + g.h, grid); cv.drawLine(g.l, y, g.l + g.w, y, grid)
        cv.drawText(dbLabel(top - q * s.div), g.l - 4 * k, y + 3 * k, lab)
    }
    val yb = g.t + g.h + 14 * k
    cv.drawText(fmtHz(Spectrum.start, 3), g.l, yb, paint(muted, k, text = 10f))
    cv.drawText(fmtHz(s.center, 3), g.l + g.w / 2, yb, paint(muted, k, text = 10f, align = Paint.Align.CENTER))
    cv.drawText(fmtHz(Spectrum.stop, 3), g.l + g.w, yb, lab)
    fun xOf(hz: Double) = (g.l + (hz - Spectrum.start) / s.span * g.w).toFloat()
    cv.save(); cv.clipRect(g.l, g.t, g.l + g.w, g.t + g.h)
    // measurement bands
    val t0 = Spectrum.measTrace()
    if (t0 != null && s.meas != Meas.OFF && s.meas != Meas.NOISE) {
        val fill = paint(Color(0x294C8DFF), k)
        fun band(c: Double, bw: Double, p: Paint) = cv.drawRect(xOf(c - bw / 2), g.t, xOf(c - bw / 2) + max(1f, xOf(c + bw / 2) - xOf(c - bw / 2)), g.t + g.h, p)
        if (s.meas == Meas.CHP) band(s.center, s.chBw, fill)
        if (s.meas == Meas.ACPR) { band(s.center, s.chBw, fill); val f2 = paint(Color(0x24FFAF00), k); band(s.center - s.spacing, s.chBw, f2); band(s.center + s.spacing, s.chBw, f2) }
        val y = t0.data
        if (s.meas == Meas.OBW && y != null) {
            val o = occupiedBw(y, t0.f0, t0.binHz, Spectrum.frame?.rbw ?: 1.0)
            cv.drawRect(xOf(o.lo), g.t, xOf(o.lo) + max(1f, xOf(o.hi) - xOf(o.lo)), g.t + g.h, fill)
            val edge = paint(MEAS_BLUE, k, stroke = 1f)
            cv.drawLine(xOf(o.lo), g.t, xOf(o.lo), g.t + g.h, edge); cv.drawLine(xOf(o.hi), g.t, xOf(o.hi), g.t + g.h, edge)
        }
    }
    // traces
    val cols = max(2, g.w.roundToInt())
    Spectrum.traces.forEachIndexed { i, t ->
        val y = t.data ?: return@forEachIndexed
        if (t.mode == TraceMode.OFF || y.isEmpty()) return@forEachIndexed
        // the columns the trace's bins cover
        val x0 = xOf(t.f0 - t.binHz / 2); val x1 = xOf(t.f0 + (y.size - 0.5) * t.binHz)
        val n = max(2, min(cols, (x1 - x0).roundToInt()))
        val ys = toColumns(y, n, s.det)
        val path = android.graphics.Path()
        for (c in 0 until n) { val x = x0 + (c + 0.5f) * (x1 - x0) / n; val yy = yOf(ys[c].toDouble()).coerceIn(-1e5f, 1e5f); if (c > 0) path.lineTo(x, yy) else path.moveTo(x, yy) }
        cv.drawPath(path, paint(TRACE_COLOR[i], k, stroke = 1.25f))
    }
    // a sweep's position
    val f = Spectrum.frame
    if (f != null && f.sweep && f.steps > 1 && f.step < f.steps) cv.drawRect(g.l + g.w * f.step / f.steps - k, g.t + g.h - 4 * k, g.l + g.w * f.step / f.steps + 2 * k, g.t + g.h, paint(AMBER, k))
    // markers
    s.markers.forEachIndexed { q, m ->
        if (!m.on) return@forEachIndexed
        val lvl = Spectrum.markerY(q)
        val x = xOf(m.hz); val y = if (lvl.isFinite()) max(g.t + 6 * k, min(g.t + g.h, yOf(lvl))) else g.t + 10 * k
        val tri = android.graphics.Path().apply { moveTo(x, y); lineTo(x - 5 * k, y - 8 * k); lineTo(x + 5 * k, y - 8 * k); close() }
        val c = if (q == s.active) AMBER else Color.White
        cv.drawPath(tri, paint(c, k)); cv.drawPath(tri, paint(Color.Black, k, stroke = 1f))
        cv.drawText("${if (m.delta) "Δ" else ""}${q + 1}", x, y - 11 * k, paint(c, k, text = 10f, align = Paint.Align.CENTER))
    }
    cv.restore()
    if (!Spectrum.connected()) cv.drawText("Connect a radio to measure", g.l + g.w / 2, g.t + g.h / 2, paint(muted, k, text = 12f, align = Paint.Align.CENTER).apply { typeface = Typeface.SANS_SERIF })
}

private fun renderZero(cv: android.graphics.Canvas, g: Geom, k: Float, line: Color, muted: Color) {
    val s = Spectrum.s; val z = Spectrum.zcap
    val panes = ArrayList<String>()
    if (s.showAmp) panes.add("amp"); if (s.showFm) panes.add("fm"); if (s.showPh) panes.add("ph")
    if (panes.isEmpty()) panes.add("amp")
    val gap = 10 * k; val ph = (g.h - gap * (panes.size - 1)) / panes.size
    // time axis: the trigger at 0, the window's start at -pre
    val len = z?.amp?.size ?: 1; val rate = z?.rate ?: 1.0; val total = if (z != null) len / rate else s.zsTime
    val t0 = if (z != null && z.trig >= 0) -z.trig / rate else 0.0
    val grid = paint(line, k, stroke = 1f); val lab = paint(muted, k, text = 10f, align = Paint.Align.RIGHT); val labL = paint(muted, k, text = 10f)
    panes.forEachIndexed { q, p ->
        val top = g.t + q * (ph + gap)
        for (dd in 0..10) { val x = g.l + dd * g.w / 10; cv.drawLine(x, top, x, top + ph, grid) }
        val rows = if (p == "amp") 10 else 4
        val hi: Double; val lo: Double
        when (p) { "amp" -> { hi = s.ref.toDouble(); lo = s.ref - s.div * 10.0 }; "fm" -> { hi = s.zsBw / 2; lo = -s.zsBw / 2 }; else -> { hi = 180.0; lo = -180.0 } }
        for (dd in 0..rows) {
            val y = top + dd * ph / rows
            cv.drawLine(g.l, y, g.l + g.w, y, grid)
            val v = hi - dd * (hi - lo) / rows
            val txt = if (p == "fm") (if (v < 0) "-" else if (v > 0) "+" else "") + bwText(abs(v)).replace(" ", "") else mono("%.0f", v).let { if (it == "-0") "0" else it }
            cv.drawText(txt, g.l - 4 * k, y + 3 * k, lab)
        }
        cv.drawText(when (p) { "amp" -> "AMPLITUDE ${Spectrum.unitLabel()}"; "fm" -> "FREQUENCY"; else -> "PHASE °" }, g.l + 4 * k, top + 11 * k, labL)
        if (z == null) return@forEachIndexed
        val arr = when (p) { "amp" -> z.amp; "fm" -> z.fm; else -> z.ph }
        fun yOf(v: Double) = (top + (hi - v) / (hi - lo) * ph).toFloat().coerceIn(-1e5f, 1e5f)
        cv.save(); cv.clipRect(g.l, top, g.l + g.w, top + ph)
        if (p == "amp" && s.trig != TrigMode.FREE) {
            val dash = paint(AMBER, k, stroke = 1f).apply { pathEffect = DashPathEffect(floatArrayOf(4 * k, 4 * k), 0f) }
            cv.drawLine(g.l, yOf(s.level.toDouble()), g.l + g.w, yOf(s.level.toDouble()), dash)
        }
        val tr = paint(TRACE_COLOR[q], k, stroke = 1.25f)
        val cols = max(2, g.w.roundToInt())
        val path = android.graphics.Path()
        if (arr.size > cols * 2) {
            // min / max per column so a dense trace keeps its envelope
            for (c in 0 until cols) {
                val a = (c.toLong() * arr.size / cols).toInt(); val b = max(a + 1, ((c + 1).toLong() * arr.size / cols).toInt())
                var mn = Float.POSITIVE_INFINITY; var mx = Float.NEGATIVE_INFINITY
                for (i in a until min(b, arr.size)) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i] }
                val x = g.l + (c + 0.5f) * g.w / cols
                path.moveTo(x, yOf(mx.toDouble())); path.lineTo(x, yOf(mn.toDouble()) + 0.5f * k)
            }
        } else {
            for (i in arr.indices) { val x = g.l + (i + 0.5f) / arr.size * g.w; val y = yOf(arr[i].toDouble()); if (i > 0) path.lineTo(x, y) else path.moveTo(x, y) }
        }
        cv.drawPath(path, tr)
        if (z.trig >= 0) {
            val x = g.l + z.trig.toFloat() / len * g.w
            cv.drawLine(x, top, x, top + ph, paint(AMBER, k, stroke = 1f))
            if (q == 0) cv.drawText("T", x, top + 10 * k, paint(AMBER, k, text = 10f, align = Paint.Align.CENTER))
        }
        if (s.cursors) for ((c, l) in listOf(s.curA to "A", s.curB to "B")) {
            val x = (g.l + c * g.w).toFloat()
            cv.drawLine(x, top, x, top + ph, paint(Color.White, k, stroke = 1f).apply { pathEffect = DashPathEffect(floatArrayOf(2 * k, 3 * k), 0f) })
            if (q == 0) cv.drawText(l, x, top + 22 * k, paint(Color.White, k, text = 10f, align = Paint.Align.CENTER))
        }
        cv.restore()
    }
    val yb = g.t + g.h + 14 * k
    cv.drawText(fmtSec(t0), g.l, yb, labL)
    cv.drawText(fmtSec(t0 + total), g.l + g.w, yb, lab)
    cv.drawText("${fmtSec(total / 10)}/div", g.l + g.w / 2, yb, paint(muted, k, text = 10f, align = Paint.Align.CENTER))
    val mid = paint(muted, k, text = 12f, align = Paint.Align.CENTER).apply { typeface = Typeface.SANS_SERIF }
    if (!Spectrum.connected()) cv.drawText("Connect a radio to measure", g.l + g.w / 2, g.t + g.h / 2, mid)
    else if (z == null) cv.drawText(if (s.trig == TrigMode.FREE) "Starting…" else "Waiting for the trigger (${if (s.trig == TrigMode.RISE) "rising" else "falling"} through ${s.level} ${Spectrum.unitLabel()})",
        g.l + g.w / 2, g.t + g.h / 2, mid)
}

/** The plot with its header and readouts, as a PNG (1400 px wide, as on the web). */
private fun pngBytes(): ByteArray {
    val rows = Spectrum.readout()
    val w = 1400; val plotH = 640; val head = 54; val read = 22 * max(1, rows.size)
    val bmp = Bitmap.createBitmap(w, head + plotH + read + 12, Bitmap.Config.ARGB_8888)
    val cv = android.graphics.Canvas(bmp)
    cv.drawColor(Palette.paper.toArgb())
    val (big, line) = Spectrum.header()
    cv.drawText(big, 12f, 26f, paint(Palette.ink, 1f, text = 20f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
    cv.drawText("$line  ·  ${Spectrum.calNote}", 12f, 46f, paint(Palette.muted, 1f, text = 13f))
    cv.save(); cv.translate(0f, head.toFloat())
    renderPlot(cv, Geom(56f, 8f, (w - 56 - 12).toFloat(), (plotH - 8 - 26).toFloat(), w.toFloat(), plotH.toFloat()), 1f)
    cv.restore()
    var y = head + plotH + 16f
    val ink = paint(Palette.ink, 1f, text = 13f)
    for (r in rows) { cv.drawText(listOf(r.label, r.text, r.tag).filter { it.isNotEmpty() }.joinToString(" "), 12f, y, ink); y += 22f }
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
    bmp.recycle()
    return out.toByteArray()
}

// ---- controls --------------------------------------------------------------------------------------------------

/** A row of controls the height of its tallest. */
@Composable
private fun Line(content: @Composable RowScope.() -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically, content = content)
}

/** A row that scrolls sideways when it holds more than fits (presets, filters, the OPEN IN buttons). */
@Composable
private fun ScrollLine(content: @Composable RowScope.() -> Unit) {
    val d = rememberDims()
    val sc = rememberScrollState()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).scrollGlow(sc, horizontal = true).horizontalScroll(sc), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically, content = content)
}

/** − LABEL value +, the height of a [SegBar]. */
@Composable
private fun SpStep(label: String, value: String, accent: Color, modifier: Modifier, onStep: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Row(modifier.fillMaxHeight().clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.fillMaxHeight().clickable { onStep(-1) }.padding(horizontal = d.dp(10f)), contentAlignment = Alignment.Center) {
            Text("−", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
        Column(Modifier.weight(1f).padding(vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1)
            Text(value, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.fillMaxHeight().clickable { onStep(1) }.padding(horizontal = d.dp(10f)), contentAlignment = Alignment.Center) {
            Text("+", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
    }
}

/** A frequency field: typed as 433.92M, 100k, 2.4G or plain MHz, applied on Done. */
@Composable
private fun HzField(label: String, hz: Double, accent: Color, modifier: Modifier, onDone: (String) -> Unit) {
    val d = rememberDims()
    val focus = LocalFocusManager.current
    var txt by remember(hz) { mutableStateOf(fmtHz(hz)) }
    val shape = RoundedCornerShape(d.dp(12f))
    Column(modifier.fillMaxHeight().clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(10f), vertical = d.dp(4f))) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
        BasicTextField(txt, { txt = it }, singleLine = true, cursorBrush = SolidColor(accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); onDone(txt) }),
            textStyle = TextStyle(color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f)), modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun SpControls(accent: Color, exportCsv: () -> Unit, exportPng: () -> Unit) {
    val d = rememberDims()
    val s = Spectrum.s
    val u = Spectrum.unitLabel()
    fun sgn(v: Int) = if (v > 0) "+$v" else "$v"
    SegBar(listOf("FREQUENCY", "ZERO SPAN"), if (s.mode == SpMode.FREQ) 0 else 1, accent) { Spectrum.setMode(if (it == 0) SpMode.FREQ else SpMode.ZERO) }
    if (s.mode == SpMode.FREQ) {
        val f = Spectrum.frame
        SectionLabel("FREQUENCY")
        Line {
            if (s.startStop) {
                HzField("START", Spectrum.start, accent, Modifier.weight(1f)) { Spectrum.setField("start", it) }
                HzField("STOP", Spectrum.stop, accent, Modifier.weight(1f)) { Spectrum.setField("stop", it) }
            } else {
                HzField("CENTER", s.center, accent, Modifier.weight(1f)) { Spectrum.setField("center", it) }
                HzField("SPAN", s.span, accent, Modifier.weight(1f)) { Spectrum.setField("span", it) }
            }
            ToggleBox(if (s.startStop) "START/STOP" else "CENTER/SPAN", s.startStop, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("ss") }
        }
        ScrollLine { for ((l, v) in SPAN_PRESETS) Chip(l, s.span == v, accent) { Spectrum.setSpan(v) } }
        SectionLabel("BANDWIDTH · SCALE")
        Line {
            SpStep("RBW", if (s.rbwAuto) "AUTO ${bwText(f?.rbw ?: Spectrum.rbwHz())}" else bwText(f?.rbw ?: s.rbw), accent, Modifier.weight(1f)) { Spectrum.stepper("rbw", it) }
            ToggleBox("AUTO", s.rbwAuto, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("rbwa") }
        }
        Line {
            SpStep("VBW", if (s.vbwAuto) "AUTO = RBW" else bwText(s.vbw), accent, Modifier.weight(1f)) { Spectrum.stepper("vbw", it) }
            ToggleBox("AUTO", s.vbwAuto, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vbwa") }
        }
        Line {
            SpStep("REF", "${s.ref} $u", accent, Modifier.weight(1f)) { Spectrum.stepper("ref", it) }
            SpStep("SCALE", "${s.div} dB/div", accent, Modifier.weight(1f)) { Spectrum.stepper("div", it) }
        }
        SegBar(listOf("dBm", "dBFS"), if (s.unit == SpUnit.DBM) 0 else 1, accent) { Spectrum.setUnit(if (it == 0) SpUnit.DBM else SpUnit.DBFS) }
        SegBar(listOf("HANN", "FLAT TOP"), if (s.window == WindowKind.HANN) 0 else 1, accent) { Spectrum.setWindow(if (it == 0) WindowKind.HANN else WindowKind.FLATTOP) }
        Line {
            SegBar(DETECTORS.map { it.name }, DETECTORS.indexOf(s.det), accent, Modifier.weight(1.4f)) { Spectrum.setDet(DETECTORS[it]) }
            SpStep("CAL", "${sgn(s.cal)} dB", accent, Modifier.weight(1f)) { Spectrum.stepper("cal", it) }
        }
        SectionLabel("TRACES")
        Spectrum.traces.forEachIndexed { i, t ->
            Line {
                Text("T${i + 1}", color = TRACE_COLOR[i], fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f))
                SegBar(TRACE_MODES.map { it.name }, TRACE_MODES.indexOf(t.mode), TRACE_COLOR[i], Modifier.weight(1f)) { Spectrum.setTraceMode(i, TRACE_MODES[it]) }
                ToggleBox("CLEAR", false, accent, Modifier.fillMaxHeight()) { Spectrum.clearTrace(i) }
            }
            if (t.mode == TraceMode.AVG) Line { SpStep("N", t.avgN.toString(), TRACE_COLOR[i], Modifier.weight(1f)) { Spectrum.stepper("avg$i", it) } }
        }
        SectionLabel("MARKERS")
        val mk = s.markers[s.active]
        SegBar(s.markers.mapIndexed { i, m -> "M${i + 1}${if (m.on) (if (m.delta) " Δ" else " ●") else ""}" }, s.active, accent) { Spectrum.setActive(it) }
        Line {
            ToggleBox("ON", mk.on, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("mkon") }
            if (s.active > 0) ToggleBox("DELTA", mk.delta, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("mkd") }
            SegBar((0 until 4).map { "T${it + 1}" }, mk.trace, accent, Modifier.weight(1f)) { Spectrum.setMarkerTrace(it) }
        }
        ScrollLine {
            for ((id, l) in listOf("peak" to "PEAK", "next" to "NEXT PEAK", "left" to "◀ NEXT", "right" to "NEXT ▶", "mkcf" to "MKR → CENTER", "mkoff" to "ALL OFF"))
                ToggleBox(l, false, accent, Modifier.fillMaxHeight()) { Spectrum.action(id) }
        }
        SectionLabel("MEASURE")
        SegBar(Meas.entries.map { it.label }, Meas.entries.indexOf(s.meas), accent) { Spectrum.setMeas(Meas.entries[it]) }
        Line { ToggleBox("PERSISTENCE", s.persist, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("persist") } }
        if (s.meas == Meas.CHP || s.meas == Meas.ACPR) Line {
            SpStep("CHANNEL", bwText(s.chBw), accent, Modifier.weight(1f)) { Spectrum.stepper("chbw", it) }
            if (s.meas == Meas.ACPR) SpStep("SPACING", bwText(s.spacing), accent, Modifier.weight(1f)) { Spectrum.stepper("spacing", it) }
        }
    } else {
        SectionLabel("FREQUENCY · FILTER")
        Line {
            HzField("FREQ", s.zsFreq, accent, Modifier.weight(1f)) { Spectrum.setField("zf", it) }
            SpStep("SWEEP", fmtSec(s.zsTime), accent, Modifier.weight(1f)) { Spectrum.stepper("zst", it) }
        }
        ScrollLine { for (b in Spectrum.zsBws()) Chip(bwText(b).replace(" ", ""), s.zsBw == b, accent) { Spectrum.setZsBw(b) } }
        SectionLabel("TRIGGER")
        SegBar(TRIG_MODES.map { when (it) { TrigMode.FREE -> "FREE RUN"; TrigMode.RISE -> "RISING"; TrigMode.FALL -> "FALLING" } }, TRIG_MODES.indexOf(s.trig), accent) { Spectrum.setTrig(TRIG_MODES[it]) }
        Line {
            ToggleBox("SINGLE", s.single, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("single") }
            if (s.single) ToggleBox(if (Spectrum.armed) "ARMED" else "ARM", Spectrum.armed, accent, Modifier.fillMaxHeight()) { Spectrum.action("arm") }
        }
        if (s.trig != TrigMode.FREE) Line {
            SpStep("LEVEL", "${s.level} $u", accent, Modifier.weight(1f)) { Spectrum.stepper("lvl", it) }
            SpStep("PRE-TRIGGER", "${(s.pre * 100).roundToInt()} %", accent, Modifier.weight(1f)) { Spectrum.stepper("pre", it) }
        }
        SectionLabel("VIEW · SCALE")
        ScrollLine {
            ToggleBox("AMPLITUDE", s.showAmp, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vamp") }
            ToggleBox("FREQUENCY", s.showFm, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vfm") }
            ToggleBox("PHASE", s.showPh, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vph") }
            ToggleBox("CURSORS", s.cursors, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("cur") }
        }
        Line {
            SpStep("REF", "${s.ref} $u", accent, Modifier.weight(1f)) { Spectrum.stepper("ref", it) }
            SpStep("SCALE", "${s.div} dB/div", accent, Modifier.weight(1f)) { Spectrum.stepper("div", it) }
        }
        SegBar(listOf("dBm", "dBFS"), if (s.unit == SpUnit.DBM) 0 else 1, accent) { Spectrum.setUnit(if (it == 0) SpUnit.DBM else SpUnit.DBFS) }
    }
    SectionLabel("RADIO · EXPORT · OPEN IN")
    ScrollLine {
        ToggleBox("RADIO · ${Spectrum.gainText()}", false, Palette.danger, Modifier.fillMaxHeight()) { RadioUi.show() }
        ToggleBox("CSV", false, accent, Modifier.fillMaxHeight()) { exportCsv() }
        ToggleBox("PNG", false, accent, Modifier.fillMaxHeight()) { exportPng() }
        ToggleBox("ANALYZER", false, accent, Modifier.fillMaxHeight()) { Spectrum.openIn(MayhemApp.ANALYZER) }
        ToggleBox("DEVICES", false, accent, Modifier.fillMaxHeight()) { Spectrum.openIn(MayhemApp.DEVICES) }
    }
    Text("Gain is set in RADIO and held while Spectrum is open (the AGC does not move it under a measurement). ${Spectrum.calNote}. ANALYZER and DEVICES open on " +
        (if (s.mode == SpMode.ZERO) "the zero-span frequency" else "the active marker (or the center)") + ".",
        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
}

