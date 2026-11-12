package com.rocketgod.mayhem.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.analyzer.AnBurst
import com.rocketgod.mayhem.core.analyzer.Alignment as BitAlignment
import com.rocketgod.mayhem.core.analyzer.Analysis
import com.rocketgod.mayhem.core.analyzer.Analyzer
import com.rocketgod.mayhem.core.analyzer.BurstMeta
import com.rocketgod.mayhem.core.analyzer.CODINGS
import com.rocketgod.mayhem.core.analyzer.CaptureFilter
import com.rocketgod.mayhem.core.analyzer.CheckFound
import com.rocketgod.mayhem.core.analyzer.Coding
import com.rocketgod.mayhem.core.analyzer.FIELD_KINDS
import com.rocketgod.mayhem.core.analyzer.FM_SCALE
import com.rocketgod.mayhem.core.analyzer.Field
import com.rocketgod.mayhem.core.analyzer.FieldKind
import com.rocketgod.mayhem.core.analyzer.Frame
import com.rocketgod.mayhem.core.analyzer.GroupIn
import com.rocketgod.mayhem.core.analyzer.Transmission
import com.rocketgod.mayhem.core.analyzer.groupPresses
import com.rocketgod.mayhem.core.analyzer.sameFrame
import com.rocketgod.mayhem.core.analyzer.MODS
import com.rocketgod.mayhem.core.analyzer.Mod
import com.rocketgod.mayhem.core.analyzer.Overrides
import com.rocketgod.mayhem.core.analyzer.Protocol
import com.rocketgod.mayhem.core.analyzer.Similar
import com.rocketgod.mayhem.core.analyzer.align
import com.rocketgod.mayhem.core.analyzer.analyze
import com.rocketgod.mayhem.core.analyzer.bitsToAscii
import com.rocketgod.mayhem.core.analyzer.bitsToHex
import com.rocketgod.mayhem.core.analyzer.carrierOf
import com.rocketgod.mayhem.core.analyzer.checkHolds
import com.rocketgod.mayhem.core.analyzer.dataStart
import com.rocketgod.mayhem.core.analyzer.fieldValue
import com.rocketgod.mayhem.core.analyzer.fromStart
import com.rocketgod.mayhem.core.analyzer.histogram
import com.rocketgod.mayhem.core.analyzer.noiseOf
import com.rocketgod.mayhem.core.analyzer.recognize
import com.rocketgod.mayhem.core.analyzer.similar
import com.rocketgod.mayhem.core.analyzer.suggest
import com.rocketgod.mayhem.core.r433.Devices
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import com.rocketgod.mayhem.core.analyzer.FrameSeg
import com.rocketgod.mayhem.core.analyzer.INNER
import com.rocketgod.mayhem.core.analyzer.Levels
import com.rocketgod.mayhem.core.analyzer.PulseTable
import com.rocketgod.mayhem.core.analyzer.classCsv
import com.rocketgod.mayhem.core.analyzer.clockDrift
import com.rocketgod.mayhem.core.analyzer.edgesOf
import com.rocketgod.mayhem.core.analyzer.eyeStarts
import com.rocketgod.mayhem.core.analyzer.frameSegments
import com.rocketgod.mayhem.core.analyzer.framesCsv
import com.rocketgod.mayhem.core.analyzer.levels
import com.rocketgod.mayhem.core.analyzer.pulseCsv
import com.rocketgod.mayhem.core.analyzer.pulseTable
import com.rocketgod.mayhem.core.analyzer.samplesCsv
import com.rocketgod.mayhem.core.analyzer.selectionCsv
import com.rocketgod.mayhem.core.analyzer.signalOf
import com.rocketgod.mayhem.core.analyzer.symbolFit
import kotlinx.coroutines.delay
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/*
 * Drawing one burst for the Analyzer: the trace in any of its views with the sliced line, the frames, the symbol
 * clock, the A/B cursors and the crosshair; the overview strip above it; the time axis under it; the eye and the
 * constellation; the pulse-length histogram with its class thresholds. The screen (AnalyzerScreen.kt) owns the state.
 * Twin of web/src/analyzer-paint.ts and App/ui/AnalyzerPaint.swift.
 */

private fun fmt(f: String, vararg a: Any?) = String.format(Locale.US, f, *a)

/** URH's pulse-length histogram: marks in the burst's color, gaps in the second accent, symbol multiples faint, class cuts dashed. */
@Composable
internal fun HistogramView(a: Analysis, rate: Double, t: PulseTable, c: Color, modifier: Modifier) {
    val h = remember(a) { histogram(a, rate) }
    val measurer = rememberTextMeasurer()
    val label = TextStyle(color = Palette.muted, fontFamily = Mono, fontSize = 9.sp)
    val gap = Palette.accent2; val muted = Palette.muted; val paper = Palette.paper
    Canvas(modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, Palette.line, RoundedCornerShape(6.dp))) {
        drawRect(paper)
        val W = size.width; val axisH = 13.dp.toPx(); val plotH = size.height - axisH - 3.dp.toPx(); val top = 3.dp.toPx()
        val bins = h.marks.size
        val peak = max(1, max(h.marks.maxOrNull() ?: 0, h.spaces.maxOrNull() ?: 0))
        val bw = W / bins
        val maxUs = h.binUs * bins
        // the symbol and its multiples
        if (a.symUs > 0) { var k = 1; while (k * a.symUs < maxUs && k <= 40) { val xx = (k * a.symUs / maxUs * W).toFloat(); drawLine(muted.copy(alpha = 0.25f), Offset(xx, top), Offset(xx, top + plotH), 1f); k++ } }
        for (i in 0 until bins) {
            val hm = h.marks[i].toFloat() / peak * plotH; val hs = h.spaces[i].toFloat() / peak * plotH
            if (hm > 0) drawRect(c, Offset(i * bw, top + plotH - hm), Size(max(1f, bw / 2 - 0.5f), hm))
            if (hs > 0) drawRect(gap.copy(alpha = 0.8f), Offset(i * bw + bw / 2, top + plotH - hs), Size(max(1f, bw / 2 - 0.5f), hs))
        }
        // the class thresholds, dashed and labeled
        val dash = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))
        for ((cuts, col) in listOf(t.markCuts to c, t.spaceCuts to gap)) for (cu in cuts) {
            if (cu >= maxUs) continue
            val xx = (cu / maxUs * W).toFloat()
            drawLine(col, Offset(xx, top), Offset(xx, top + plotH), 1.dp.toPx(), pathEffect = dash)
            drawText(measurer, fmt("%.0f", cu), Offset(xx + 2f, top + 12.dp.toPx()), label.copy(color = col))
        }
        drawText(measurer, "0 µs", Offset(2f, size.height - axisH), label)
        val mid = fmt("%.0f µs", maxUs / 2); val mw = measurer.measure(mid, label).size.width
        drawText(measurer, mid, Offset(W / 2 - mw / 2, size.height - axisH), label)
        val end = fmt("%.0f µs", maxUs); val ew = measurer.measure(end, label).size.width
        drawText(measurer, end, Offset(W - ew - 2f, size.height - axisH), label)
        drawText(measurer, "marks", Offset(W - 92.dp.toPx(), top), label.copy(color = c))
        drawText(measurer, "gaps", Offset(W - 44.dp.toPx(), top), label.copy(color = gap))
    }
}

// ---- the waveform -------------------------------------------------------------------------------------------

/** The burst plus 6% either side: where the trace starts (FIT). */
internal fun fitOf(x: AnBurst): Pair<Int, Int> {
    val a = x.auto; val pad = max(16, ((a.to - a.from) * 0.06).roundToInt())
    return if (a.to > a.from) max(0, a.from - pad) to min(x.b.n, a.to + pad) else 0 to x.b.n
}

/**
 * The trace's time window [a0, a1) in samples, shared by every view, with its zoom history (up to 50 states, one kept
 * once the view has held still for 400 ms), and the measuring cursors.
 */
internal class TraceState(val n: Int, fit: Pair<Int, Int>) {
    var a0 by mutableIntStateOf(fit.first); private set
    var a1 by mutableIntStateOf(fit.second); private set
    var curA by mutableStateOf<Int?>(null)
    var curB by mutableStateOf<Int?>(null)
    /** The crosshair, in canvas pixels, while measuring. */
    var cross by mutableStateOf<Offset?>(null)
    /** The edge (sample) picked in the sliced row, for the lengths either side of it. */
    var edge by mutableStateOf<Int?>(null)
    private val hist = ArrayList<Pair<Int, Int>>()
    private var at by mutableIntStateOf(-1)
    private var stepping = false

    /** Show [x0, x1): at least 16 samples, at most the whole burst, inside it. */
    fun set(x0: Double, x1: Double) {
        var w = (x1 - x0).coerceIn(min(16.0, n.toDouble()), n.toDouble())
        var s = x0
        if (s < 0) s = 0.0
        if (s + w > n) s = n - w
        if (w < 1) w = 1.0
        a0 = s.roundToInt(); a1 = (s + w).roundToInt().coerceAtMost(n)
    }
    /** Zoom in by [f] (out when below 1) keeping the sample at [frac] of the width where it is. */
    fun zoomBy(f: Double, frac: Double) {
        val w = (a1 - a0).toDouble(); val anchor = a0 + frac * w; val nw = w / f
        set(anchor - frac * nw, anchor - frac * nw + nw)
    }
    fun panBy(samples: Double) { set(a0 + samples, a1 + samples) }
    fun record() {
        if (stepping) { stepping = false; return }
        val s = a0 to a1
        if (at >= 0 && hist[at] == s) return
        while (hist.size > at + 1) hist.removeAt(hist.size - 1)
        hist.add(s); if (hist.size > 50) hist.removeAt(0)
        at = hist.size - 1
    }
    fun canBack() = at > 0
    fun canForward() = at in 0 until hist.size - 1
    fun back() { if (canBack()) { at--; stepping = true; hist[at].let { a0 = it.first; a1 = it.second } } }
    fun forward() { if (canForward()) { at++; stepping = true; hist[at].let { a0 = it.first; a1 = it.second } } }
}

/** A step of 1, 2 or 5 × 10^k of [unit] at least [min] wide. */
private fun niceStep(min: Double): Double {
    if (min <= 0) return 1.0
    var p = Math.pow(10.0, floor(log10(min)))
    while (true) { for (m in doubleArrayOf(1.0, 2.0, 5.0)) if (m * p >= min) return m * p; p *= 10 }
}

/** The whole burst in miniature, with the window as a bright box: drag the box to pan, tap outside it to center there. */
@Composable
internal fun OverviewStrip(x: AnBurst, ts: TraceState, c: Color, modifier: Modifier) {
    val b = x.b
    val paper = Palette.paper; val ink = Palette.ink
    var widthPx by remember { mutableIntStateOf(0) }
    val cols = remember(b.id, widthPx) {
        val w = max(1, widthPx); var pk = 1
        for (i in 0 until b.n) if (b.env[i] > pk) pk = b.env[i].toInt()
        FloatArray(w) { px -> val i0 = (px.toLong() * b.n / w).toInt(); val i1 = max(i0 + 1, ((px + 1L) * b.n / w).toInt()); var m = 0; for (i in i0 until min(i1, b.n)) if (b.env[i] > m) m = b.env[i].toInt(); m.toFloat() / pk }
    }
    Canvas(modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, Palette.line, RoundedCornerShape(6.dp)).onSizeChanged { widthPx = it.width }
        .pointerInput(ts) {
            detectTapGestures { p -> val at = p.x / size.width * ts.n; val w = (ts.a1 - ts.a0).toDouble(); ts.set(at - w / 2, at + w / 2) }
        }.pointerInput(ts) {
            detectHorizontalDragGestures { ch, dx -> ts.panBy(dx.toDouble() / size.width * ts.n); ch.consume() }
        }) {
        drawRect(paper)
        val W = size.width; val H = size.height
        for (px in cols.indices) { val v = cols[px] * (H - 4); drawLine(c.copy(alpha = 0.7f), Offset(px + 0.5f, H - 2 - v), Offset(px + 0.5f, H - 2), 1f) }
        val x0 = ts.a0.toFloat() / b.n * W; val x1 = ts.a1.toFloat() / b.n * W
        drawRect(ink.copy(alpha = 0.15f), Offset(x0, 0f), Size(max(2f, x1 - x0), H))
        drawRect(ink, Offset(x0, 0f), Size(max(2f, x1 - x0), H), style = Stroke(1.5.dp.toPx()))
    }
}

/**
 * The selected burst's trace, in the window [ts.a0, ts.a1): the envelope, the discriminator (in-carrier samples
 * bright, the rest dim), I and Q as two traces, the raw I/Q as a spectrogram, the eye, or the constellation; the frames
 * shaded and labeled F1..Fn, the cut line on the view that is sliced, the sliced line under it all (with each run's
 * length when DURATIONS is on), the symbol grid (CLOCK), the cursors and crosshair, the bits lit from the strip or the
 * text, and the selection. Pinch zooms around the fingers and two fingers pan in every tool; one finger selects,
 * measures or pans by the tool chosen.
 */
@Composable
internal fun WaveCanvas(x: AnBurst, a: Analysis, meas: Measured, ts: TraceState, pick: Pair<Int, Int>?, hlSpan: Pair<Int, Int>?, c: Color, modifier: Modifier,
                       onTapAt: (Double) -> Unit, onPick: (Pair<Int, Int>?) -> Unit) {
    val b = x.b
    val view = UiState.view
    val a0 = ts.a0; val a1 = ts.a1
    val len = max(1, a1 - a0)
    val on = remember(b.id) { carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate)) }
    // in the carrier and clear of its edges (the INNER rule): where the discriminator means something
    val inner = remember(b.id) {
        val out = BooleanArray(b.n); var run = 0
        val runAt = IntArray(b.n)
        for (i in 0 until b.n) { run = if (on[i]) run + 1 else 0; runAt[i] = run }
        var next = 0
        for (i in b.n - 1 downTo 0) { next = if (on[i]) next + 1 else 0; out[i] = runAt[i] > INNER && next > INNER }
        out
    }
    val paper = Palette.paper; val ink = Palette.ink; val muted = Palette.muted; val accent2 = Palette.accent2; val okC = Palette.ok
    val spectro = if (view == 3) remember(b.id, a0, a1, paper, c, accent2) { spectrogram(b.iq, b.n, a0, a1, paper, c, accent2) } else null
    val measurer = rememberTextMeasurer()
    val label = TextStyle(color = muted, fontFamily = Mono, fontSize = 10.sp)
    val small = TextStyle(color = ink, fontFamily = Mono, fontSize = 9.sp)
    val pickNow by rememberUpdatedState(onPick)
    val tapNow by rememberUpdatedState(onTapAt)
    val aNow by rememberUpdatedState(a)
    val yz = UiState.yZoom[view] ?: 1
    val density = LocalDensity.current.density
    Canvas(modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, Palette.line, RoundedCornerShape(8.dp)).pointerInput(ts) {
        val slop = viewConfiguration.touchSlop
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val W = size.width.toFloat().coerceAtLeast(1f); val H = size.height.toFloat()
            fun sampleAt(px: Float) = ts.a0 + (px / W).coerceIn(0f, 1f).toDouble() * (ts.a1 - ts.a0)
            val tool = UiState.tool
            val start = down.position
            val s0 = sampleAt(start.x)
            val w0 = (ts.a1 - ts.a0).toDouble(); val a00 = ts.a0.toDouble()
            var dragging = false; var multi = false
            var lastPick: Pair<Int, Int>? = null
            var pinchD0 = 0f; var pinchW0 = 0.0; var pinchS0 = 0.0
            // which cursor a measuring drag moves: the nearer one
            fun nearer(at: Double): Int { val ca = ts.curA; val cb = ts.curB; return if (ca == null) 0 else if (cb == null) 1 else if (abs(at - ca) <= abs(at - cb)) 0 else 1 }
            val moving = if (tool == 1) nearer(s0) else -1
            if (tool == 1) ts.cross = start
            while (true) {
                val ev = awaitPointerEvent()
                val pressed = ev.changes.filter { it.pressed }
                if (pressed.isEmpty()) break
                if (pressed.size >= 2) {
                    // two fingers: pinch zooms around them, and moving them pans
                    val p0 = pressed[0].position; val p1 = pressed[1].position
                    val cx = (p0.x + p1.x) / 2; val dist = max(8f, abs(p0.x - p1.x))
                    if (!multi) { multi = true; pinchD0 = dist; pinchW0 = (ts.a1 - ts.a0).toDouble(); pinchS0 = sampleAt(cx) }
                    val nw = pinchW0 * pinchD0 / dist
                    ts.set(pinchS0 - cx / W * nw, pinchS0 - cx / W * nw + nw)
                    ev.changes.forEach { it.consume() }
                    continue
                }
                if (multi) { ev.changes.forEach { it.consume() }; continue }
                val p = pressed[0]
                if (!dragging && (p.position - start).getDistance() > slop) dragging = true
                if (!dragging) continue
                val at = sampleAt(p.position.x)
                when (tool) {
                    0 -> { val from = s0.roundToInt(); val to = at.roundToInt(); lastPick = if (to == from) null else min(from, to) to max(from, to); pickNow(lastPick) }
                    1 -> { ts.cross = p.position; if (moving == 0) ts.curA = at.roundToInt() else ts.curB = at.roundToInt() }
                    else -> { val dx = p.position.x - start.x; ts.set(a00 - dx / W * w0, a00 - dx / W * w0 + w0) }
                }
                p.consume()
            }
            if (!dragging && !multi) {
                // a tap
                val axisH = 14 * density; val digH = 18 * density
                when (tool) {
                    0 -> if (start.y > H - axisH - digH - 4 * density) {
                        // the sliced row: the edge nearest the tap, for the runs either side of it
                        var pos = aNow.from; var best: Int? = null; var bd = Double.MAX_VALUE
                        for (r in aNow.runs) { val dd = abs(pos - s0); if (dd < bd) { bd = dd; best = pos }; pos += r.n }
                        ts.edge = if (best != null && bd / w0 * W < 24 * density) best else null
                    } else { pickNow(null); tapNow(s0) }
                    1 -> { ts.cross = start; if (ts.curA == null) ts.curA = s0.roundToInt() else if (ts.curB == null) ts.curB = s0.roundToInt() else if (nearer(s0) == 0) ts.curA = s0.roundToInt() else ts.curB = s0.roundToInt() }
                }
            } else if (tool == 0 && dragging && !multi) {
                // a selection too short to mean anything is none
                val cur = lastPick
                if (cur == null || cur.second - cur.first < 4) pickNow(null)
            }
        }
    }) {
        val W = size.width; val H = size.height
        drawRect(paper)
        fun xOf(i: Number) = ((i.toDouble() - a0) / len * W).toFloat()
        val axisH = 14.dp.toPx(); val digH = 18.dp.toPx(); val top = 14.dp.toPx()
        val plotH = H - digH - axisH - top
        // frames, shaded behind everything, each labeled F1..Fn above it
        if (view != 4 && view != 5) a.frames.forEachIndexed { i, f ->
            val fx0 = xOf(f.start); val fx1 = xOf(f.end)
            if (fx1 < 0 || fx0 > W) return@forEachIndexed
            drawRect(c.copy(alpha = 0.1f), Offset(fx0, top), Size(max(1f, fx1 - fx0), H - axisH - top))
            drawText(measurer, "F${i + 1}", Offset(max(0f, fx0) + 2f, 0f), small.copy(color = c))
        }
        // the bits lit from the strip or the text
        if (hlSpan != null && view < 4) drawRect(accent2.copy(alpha = 0.28f), Offset(xOf(hlSpan.first), top), Size(max(2f, xOf(hlSpan.second) - xOf(hlSpan.first)), H - axisH - top))
        // the symbol grid (CLOCK): a tick every symbol from each frame's start
        if (UiState.clock && view < 4) for (dr in meas.drift) {
            val f = a.frames.getOrNull(dr.frame) ?: continue
            if (dr.u / len * W < 4) continue
            var t = dr.start.toDouble()
            while (t <= f.end) { val xx = xOf(t); if (xx in 0f..W) drawLine(okC.copy(alpha = 0.35f), Offset(xx, top), Offset(xx, top + plotH + digH), 1f); t += dr.u }
        }
        var valueAtY: ((Float) -> String)? = null
        when (view) {
            3 -> if (spectro != null) {
                drawImage(spectro, IntOffset.Zero, IntSize(spectro.width, spectro.height), IntOffset(0, top.roundToInt()), IntSize(W.roundToInt(), plotH.roundToInt()), filterQuality = FilterQuality.None)
                drawText(measurer, fmt("+%.0f kHz", b.rate / 2e3), Offset(4f, top + 2f), label.copy(color = Color.White.copy(alpha = 0.7f)))
                drawText(measurer, fmt("−%.0f kHz", b.rate / 2e3), Offset(4f, top + plotH - 16.dp.toPx()), label.copy(color = Color.White.copy(alpha = 0.7f)))
                if (a.mod == Mod.FSK && a.shiftHz > 0) for (s in listOf(1, -1)) {
                    val y = (top + plotH * (0.5 - s * a.shiftHz / 2 / b.rate)).toFloat()
                    drawLine(Color.White, Offset(W - 14.dp.toPx(), y), Offset(W, y), 2.dp.toPx())
                }
                valueAtY = { y -> fmt("%+.1f kHz", (0.5 - (y - top) / plotH) * b.rate / 1e3) }
            }
            2 -> {
                // I and Q, each scaled to the peak in view (or the vertical zoom)
                var pk = 1
                for (i in a0 until min(a1, b.n)) { pk = max(pk, abs(b.iq[2 * i].toInt())); pk = max(pk, abs(b.iq[2 * i + 1].toInt())) }
                val scale = pk.toFloat() / yz
                fun yOf(v: Int) = top + plotH / 2 - v.toFloat() / scale * plotH / 2 * 0.95f
                drawLine(muted.copy(alpha = 0.4f), Offset(0f, yOf(0)), Offset(W, yOf(0)), 1f)
                val cols = W.toInt(); val stroke = max(1f, 1.dp.toPx() * 0.6f)
                for (ch in 0..1) {
                    val col = if (ch == 0) c else accent2.copy(alpha = 0.85f)
                    if (len <= cols) {
                        val p = Path()
                        for (i in a0 until min(a1, b.n)) { val xx = xOf(i); val yy = yOf(b.iq[2 * i + ch].toInt()); if (i == a0) p.moveTo(xx, yy) else p.lineTo(xx, yy) }
                        drawPath(p, col, style = Stroke(stroke))
                    } else for (px in 0 until cols) {
                        val i0 = a0 + floor(px.toDouble() * len / cols).toInt(); val i1 = max(i0 + 1, a0 + floor((px + 1).toDouble() * len / cols).toInt())
                        var mn = 127; var mx = -128; var i = i0
                        while (i < i1 && i < b.n) { val v = b.iq[2 * i + ch].toInt(); if (v < mn) mn = v; if (v > mx) mx = v; i++ }
                        if (mn > mx) continue
                        drawLine(col, Offset(px + 0.5f, yOf(mx)), Offset(px + 0.5f, yOf(mn) + 0.5f), stroke)
                    }
                }
                drawText(measurer, "I", Offset(4.dp.toPx(), top), label.copy(color = c))
                drawText(measurer, "Q", Offset(16.dp.toPx(), top), label.copy(color = accent2))
                valueAtY = { y -> fmt("%.0f", (top + plotH / 2 - y) / (plotH / 2 * 0.95f) * scale) }
            }
            4 -> {
                // the eye: two symbols of the sliced signal at every clock tick, laid over each other
                val sig = signalOf(a.mod, b.env, b.fm)
                val e = meas.eye
                if (e.len > 1 && e.starts.isNotEmpty()) {
                    // FSK: the middle of the tones ± 0.8 of their spread; OOK/ASK: from 0 to well over the marks
                    var lo: Double; var hi: Double
                    if (a.mod == Mod.FSK) { val mid = (a.lo + a.hi) / 2; val sp = 0.8 * abs(a.hi - a.lo); lo = mid - sp; hi = mid + sp }
                    else { lo = 0.0; hi = max(a.hi, 2 * a.cut) * 1.25 }
                    if (hi <= lo) hi = lo + 1
                    val eTop = 6.dp.toPx(); val eH = H - 12.dp.toPx()
                    fun yOf(v: Double) = (eTop + eH - ((v - lo) / (hi - lo)).coerceIn(-0.02, 1.02) * eH).toFloat()
                    val step = max(1, e.len / max(1, W.toInt()))
                    for (s in e.starts) {
                        val p = Path(); var first = true
                        var k = 0
                        while (k < e.len) { val i = s + k; if (i in 0 until b.n) { val xx = k.toFloat() / (e.len - 1) * W; val yy = yOf(sig[i].toDouble()); if (first) p.moveTo(xx, yy) else p.lineTo(xx, yy); first = false }; k += step }
                        drawPath(p, c.copy(alpha = 0.08f), style = Stroke(1.5f))
                    }
                    drawLine(accent2, Offset(0f, yOf(a.cut)), Offset(W, yOf(a.cut)), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx())))
                    // the ticks (a quarter and three quarters across) and the symbol center between them
                    for (fx in listOf(0.25f, 0.75f)) drawLine(muted.copy(alpha = 0.5f), Offset(fx * W, eTop), Offset(fx * W, eTop + eH), 1f)
                    drawLine(accent2.copy(alpha = 0.8f), Offset(0.5f * W, eTop), Offset(0.5f * W, eTop + eH), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())))
                    drawText(measurer, "${e.starts.size} traces · 2 symbols (${fmt("%.0f", 2 * a.symUs)} µs)", Offset(4.dp.toPx(), eTop), label)
                } else drawText(measurer, "no symbol clock: nothing to fold", Offset(4.dp.toPx(), top), label)
            }
            5 -> {
                // the constellation: the window's I/Q as points, in-carrier bright
                val side = min(W, H - 12.dp.toPx()); val cx = W / 2; val cy = H / 2
                var pk = 1
                for (i in a0 until min(a1, b.n)) { pk = max(pk, abs(b.iq[2 * i].toInt())); pk = max(pk, abs(b.iq[2 * i + 1].toInt())) }
                val r = side / 2 * 0.92f
                drawLine(muted.copy(alpha = 0.5f), Offset(cx - side / 2, cy), Offset(cx + side / 2, cy), 1f)
                drawLine(muted.copy(alpha = 0.5f), Offset(cx, cy - side / 2), Offset(cx, cy + side / 2), 1f)
                drawRect(muted.copy(alpha = 0.3f), Offset(cx - side / 2, cy - side / 2), Size(side, side), style = Stroke(1f))
                val step = max(1, len / 20_000)
                val bright = ArrayList<Offset>(); val dim = ArrayList<Offset>()
                var i = a0
                while (i < min(a1, b.n)) { val pt = Offset(cx + b.iq[2 * i] / pk.toFloat() * r, cy - b.iq[2 * i + 1] / pk.toFloat() * r); if (on[i]) bright.add(pt) else dim.add(pt); i += step }
                drawPoints(dim, androidx.compose.ui.graphics.PointMode.Points, muted.copy(alpha = 0.35f), strokeWidth = 2f)
                drawPoints(bright, androidx.compose.ui.graphics.PointMode.Points, c.copy(alpha = 0.6f), strokeWidth = 2f)
                drawText(measurer, "I →", Offset(cx + side / 2 - 28.dp.toPx(), cy + 2f), label)
                drawText(measurer, "Q ↑", Offset(cx + 3f, cy - side / 2), label)
                drawText(measurer, "${bright.size + dim.size} points", Offset(4.dp.toPx(), top), label)
            }
            else -> {
                val sig = if (view == 0) b.env else b.fm
                val gate = if (view == 1) inner else null
                var lo = Double.POSITIVE_INFINITY; var hi = Double.NEGATIVE_INFINITY
                for (i in a0 until min(a1, b.n)) { if (gate != null && !gate[i]) continue; val v = sig[i].toDouble(); if (v < lo) lo = v; if (v > hi) hi = v }
                if (lo == Double.POSITIVE_INFINITY) { lo = -1.0; hi = 1.0 }
                if (view == 1) { val m = max(max(abs(lo), abs(hi)), 1.0) / yz; lo = -m; hi = m } else { lo = 0.0; hi /= yz }
                if (hi <= lo) hi = lo + 1
                fun yOf(v: Double) = (top + plotH - ((v - lo) / (hi - lo)).coerceIn(-0.05, 1.05) * plotH).toFloat()
                if (view == 1) drawLine(muted.copy(alpha = 0.4f), Offset(0f, yOf(0.0)), Offset(W, yOf(0.0)), 1f)
                val cols = W.toInt()
                val stroke = max(1f, 1.dp.toPx() * 0.6f)
                // the frequency view: in-carrier samples bright, everything else (gap noise, keying spikes) at 18%
                val dimC = c.copy(alpha = 0.18f)
                if (len <= cols) {
                    // fewer samples than pixels: join them with a line
                    for (i in a0 until min(a1, b.n) - 1) {
                        val bright = gate == null || (gate[i] && gate[i + 1])
                        drawLine(if (bright) c else dimC, Offset(xOf(i), yOf(sig[i].toDouble())), Offset(xOf(i + 1), yOf(sig[i + 1].toDouble())), stroke)
                    }
                } else for (px in 0 until cols) {
                    val i0 = a0 + floor(px.toDouble() * len / cols).toInt(); val i1 = max(i0 + 1, a0 + floor((px + 1).toDouble() * len / cols).toInt())
                    var mn = Double.POSITIVE_INFINITY; var mx = Double.NEGATIVE_INFINITY
                    var dmn = Double.POSITIVE_INFINITY; var dmx = Double.NEGATIVE_INFINITY
                    var i = i0
                    while (i < i1 && i < b.n) {
                        val v = sig[i].toDouble()
                        if (gate == null || gate[i]) { if (v < mn) mn = v; if (v > mx) mx = v } else { if (v < dmn) dmn = v; if (v > dmx) dmx = v }
                        i++
                    }
                    if (dmn != Double.POSITIVE_INFINITY) drawLine(dimC, Offset(px + 0.5f, yOf(dmx)), Offset(px + 0.5f, yOf(dmn) + 0.5f), stroke)
                    if (mn != Double.POSITIVE_INFINITY) drawLine(c, Offset(px + 0.5f, yOf(mx)), Offset(px + 0.5f, yOf(mn) + 0.5f), stroke)
                }
                // the cut line, when this view is the one sliced
                val sliced = (view == 1) == (a.mod == Mod.FSK)
                if (sliced && a.runs.isNotEmpty()) drawLine(accent2, Offset(0f, yOf(a.cut)), Offset(W, yOf(a.cut)), 1.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx())))
                val note = (if (view == 1) fmt("±%.0f kHz", hi / FM_SCALE * b.rate / (2 * PI) / 1e3) else fmt("%.0f dBFS top", 20 * log10(max(1.0, hi) / 16384))) + if (yz > 1) " · Y ×$yz" else ""
                drawText(measurer, note, Offset(4.dp.toPx(), top), label)
                valueAtY = { y ->
                    val v = lo + (top + plotH - y) / plotH * (hi - lo)
                    if (view == 1) fmt("%+.1f kHz", v / FM_SCALE * b.rate / (2 * PI) / 1e3) else fmt("%.1f dBFS", 20 * log10(max(1.0, v) / 16384))
                }
            }
        }
        if (view != 4 && view != 5) {
            // the sliced line, under the trace, with each run's length when there is room (DURATIONS)
            val y0 = H - axisH - 3.dp.toPx(); val y1 = y0 - digH + 6.dp.toPx()
            val path = Path(); path.moveTo(0f, y0)
            var pos = a.from; var lvl = false
            val room = 34.dp.toPx()
            for ((ri, r) in a.runs.withIndex()) {
                val x0 = xOf(pos); val x1 = xOf(pos + r.n)
                if (x1 >= 0 && x0 <= W) {
                    val y = if (r.hi) y1 else y0
                    if (r.hi != lvl) path.lineTo(max(0f, x0), y); path.lineTo(min(W, x1), y)
                    if (UiState.durations && x1 - x0 >= room) {
                        val t = measurer.measure(fmt("%.0f", (meas.edges[ri + 1] - meas.edges[ri]) / b.rate * 1e6), small.copy(color = if (r.hi) okC else accent2, background = paper))
                        drawText(t, topLeft = Offset((x0 + x1) / 2 - t.size.width / 2, (if (r.hi) y1 - t.size.height - 1f else y1 + 1f)))
                    }
                }
                lvl = r.hi; pos += r.n
            }
            drawPath(path, ink, style = Stroke(width = max(1f, 1.dp.toPx() * 0.7f)))
            // the lengths either side of the edge tapped in the sliced row
            ts.edge?.let { e ->
                var p0 = a.from; var kAfter = -1
                for ((k, r) in a.runs.withIndex()) { if (p0 == e) { kAfter = k; break }; p0 += r.n }
                val before = a.runs.getOrNull(kAfter - 1); val after = a.runs.getOrNull(kAfter)
                val xe = xOf(e)
                if (xe in 0f..W) {
                    drawLine(accent2, Offset(xe, top), Offset(xe, H - axisH), 1.dp.toPx())
                    fun desc(r: com.rocketgod.mayhem.core.analyzer.Run?, k: Int) = r?.let { fmt("%s %.0f µs", if (it.hi) "mark" else "gap", (meas.edges[k + 1] - meas.edges[k]) / b.rate * 1e6) } ?: "—"
                    val t = measurer.measure("${desc(before, kAfter - 1)} | ${desc(after, kAfter)}", small.copy(color = accent2, background = paper.copy(alpha = 0.85f)))
                    drawText(t, topLeft = Offset((xe - t.size.width / 2).coerceIn(0f, max(0f, W - t.size.width)), y1 - t.size.height - 14.dp.toPx()))
                }
            }
        }
        // the selection
        if (pick != null && view < 4) {
            val x0 = xOf(pick.first); val x1 = xOf(pick.second)
            drawRect(accent2.copy(alpha = 0.18f), Offset(x0, top), Size(x1 - x0, H - axisH - top))
            drawRect(accent2, Offset(x0, top), Size(x1 - x0, H - axisH - top), style = Stroke(1f))
        }
        // the cursors and the crosshair
        if (view < 4) {
            for ((nm, cur) in listOf("A" to ts.curA, "B" to ts.curB)) {
                val s = cur ?: continue
                val xx = xOf(s)
                if (xx < 0 || xx > W) continue
                val col = if (nm == "A") accent2 else okC
                drawLine(col, Offset(xx, top), Offset(xx, H - axisH), 1.5.dp.toPx())
                val bx = 14.dp.toPx()
                drawRect(col, Offset(xx - bx / 2, top), Size(bx, bx))
                val t = measurer.measure(nm, small.copy(color = paper, fontWeight = FontWeight.Bold))
                drawText(t, topLeft = Offset(xx - t.size.width / 2, top + (bx - t.size.height) / 2))
            }
            ts.cross?.let { p ->
                if (UiState.tool == 1) {
                    val dash = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))
                    drawLine(ink.copy(alpha = 0.6f), Offset(p.x, top), Offset(p.x, H - axisH), 1f, pathEffect = dash)
                    drawLine(ink.copy(alpha = 0.6f), Offset(0f, p.y), Offset(W, p.y), 1f, pathEffect = dash)
                    val at = a0 + p.x / W * len
                    val txt = (if (UiState.samplesAxis) "${at.roundToInt()}" else timeLabel(at / b.rate)) + (valueAtY?.let { "  " + it(p.y) } ?: "")
                    val t = measurer.measure(txt, small.copy(background = paper.copy(alpha = 0.85f)))
                    drawText(t, topLeft = Offset(min(p.x + 6f, W - t.size.width - 2f), max(top, p.y - t.size.height - 4f)))
                }
            }
        }
        // the time axis: ticks every 1, 2 or 5 × 10^k, at least 90 dp apart, in s, ms, µs or samples
        if (view < 4) {
            val minPx = 90.dp.toPx()
            val samples = UiState.samplesAxis
            val spanUnits = if (samples) len.toDouble() else len / b.rate
            val step = niceStep(spanUnits * minPx / W)
            val startU = if (samples) a0.toDouble() else a0 / b.rate
            var u = Math.ceil(startU / step) * step
            while (true) {
                val s = if (samples) u else u * b.rate
                if (s > a1) break
                val xx = xOf(s)
                drawLine(muted.copy(alpha = 0.5f), Offset(xx, H - axisH), Offset(xx, H - axisH + 4.dp.toPx()), 1f)
                val txt = if (samples) fmt("%.0f", u) else when { step >= 1 -> fmt("%.0f s", u); step >= 1e-3 -> fmt("%s ms", trimNum(u * 1e3)); else -> fmt("%s µs", trimNum(u * 1e6)) }
                val t = measurer.measure(txt, label)
                drawText(t, topLeft = Offset((xx - t.size.width / 2).coerceIn(0f, max(0f, W - t.size.width)), H - axisH + 2f))
                u += step
            }
        }
    }
}

/** A number without trailing zeros (up to 3 decimals). */
private fun trimNum(v: Double): String = fmt("%.3f", v).trimEnd('0').trimEnd('.')

/** The raw I/Q as a spectrogram: 64-point transforms (Hann) spread over the range, frequency up, in dB. */
private fun spectrogram(iq: ByteArray, n: Int, a0: Int, a1: Int, paper: Color, mid: Color, hi: Color): ImageBitmap {
    val nn = 64
    val win = FloatArray(nn) { (0.5 - 0.5 * kotlin.math.cos(2 * PI * it / (nn - 1))).toFloat() }
    val re = FloatArray(nn); val im = FloatArray(nn)
    // 64-point transforms every 16 samples, or fewer spread across the range when it is long
    val cols = max(1, min(600, (a1 - a0) / 16))
    val mags = Array(cols) { FloatArray(nn) }
    var peak = 1e-9f
    for (col in 0 until cols) {
        val m0 = a0 + ((col + 0.5) * (a1 - a0) / cols).roundToInt()
        for (k in 0 until nn) { val i = (m0 - nn / 2 + k).coerceIn(0, max(0, n - 1)); re[k] = iq[2 * i] * win[k]; im[k] = iq[2 * i + 1] * win[k] }
        Dsp.fft(re, im)
        for (k in 0 until nn) { val v = re[k] * re[k] + im[k] * im[k]; mags[col][k] = v; if (v > peak) peak = v }
    }
    val px = IntArray(cols * nn)
    for (col in 0 until cols) for (k in 0 until nn) {
        val bin = (k + nn / 2) % nn                        // negative frequencies at the bottom
        val db = 10 * log10(mags[col][bin] / peak + 1e-12)
        val t = ((db + 45) / 45).coerceIn(0.0, 1.0).pow(1.6).toFloat()
        val color = if (t < 0.6f) lerp(paper, mid, t / 0.6f) else lerp(mid, hi, (t - 0.6f) / 0.4f)
        px[(nn - 1 - k) * cols + col] = color.toArgb()
    }
    return android.graphics.Bitmap.createBitmap(px, cols, nn, android.graphics.Bitmap.Config.ARGB_8888).asImageBitmap()
}

