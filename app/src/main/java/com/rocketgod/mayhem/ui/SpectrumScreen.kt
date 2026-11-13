package com.rocketgod.mayhem.ui

import android.graphics.Bitmap
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.spectrum.DETECTORS
import com.rocketgod.mayhem.core.spectrum.Meas
import com.rocketgod.mayhem.core.spectrum.SPAN_PRESETS
import com.rocketgod.mayhem.core.spectrum.SpBig
import com.rocketgod.mayhem.core.spectrum.SpMkRow
import com.rocketgod.mayhem.core.spectrum.SpMode
import com.rocketgod.mayhem.core.spectrum.SpTile
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
import kotlin.math.sqrt

/*
 * The Spectrum screen: a bench analyzer's instrument panel. Readout tiles across the top (a knob each, a tap opens a
 * keypad), the status line, the plot (glowing traces, marker diamonds and the active marker's readout, measurement
 * bands, a density display at the plot's own resolution; or the zero-span panes), the measurement card and the marker
 * table beside it on a wide screen (under it on a phone), then the controls. On the plot: pinch or wheel to zoom the
 * span, drag to pan, tap to drop the active marker, drag a marker to move it. The state and the measurements are
 * core/spectrum/Spectrum.kt. Twin of the web app's web/src/spectrum-ui.ts.
 */

/** Trace colors (a bench analyzer's yellow, cyan, magenta, green). */
val TRACE_COLOR = listOf(Color(0xFFFFD400), Color(0xFF3FD0C9), Color(0xFFFF5DD8), Color(0xFF3FD07A))
/** The active marker, the sweep line and the trigger: amber. */
private val SP_ACTIVE = Color(0xFFFFAF00)
private val SP_BLACK = Color(0xFF05080A)

/** What a save is waiting to write, for the document picker. */
private class PendingBytes(val name: String, val bytes: ByteArray)

@Composable
fun SpectrumScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    // read, not just collected: a State nobody reads subscribes nobody, and the screen would never redraw
    Spectrum.ver.collectAsState().value
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val tunerAgc by SdrEngine.tunerAgc.collectAsState()
    val kind by Radio.kind.collectAsState()
    Spectrum.density = LocalDensity.current.density
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

    val screenH = LocalConfiguration.current.screenHeightDp
    val plotH = if (d.wide) max(300f, screenH * 0.62f) else max(260f, screenH * 0.46f)
    val scroll = rememberScrollState()
    Column(Modifier.fillMaxSize().scrollGlow(scroll).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        SpTiles(accent)
        SpStatus()
        if (d.wide) {
            Row(Modifier.fillMaxWidth().height(plotH.dp), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                SpPlotBox(Modifier.weight(1f).fillMaxHeight())
                Column(Modifier.width(d.dp(300f)).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) { SpSide(accent) }
            }
        } else {
            SpPlotBox(Modifier.fillMaxWidth().height(plotH.dp))
            SpSide(accent)
        }
        Column(Modifier.fillMaxWidth().padding(bottom = d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            SpControls(accent, exportCsv, exportPng)
        }
    }
    if (Spectrum.pad != null) SpKeypad(accent)
}

// ---- the readout tiles -----------------------------------------------------------------------------------------

@Composable
private fun SpTiles(accent: Color) {
    // read so this part redraws with every frame (a State nobody reads subscribes nobody)
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val d = rememberDims()
    val tiles = Spectrum.tiles()
    if (d.wide) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            tiles.forEachIndexed { i, t -> SpTileView(t, i == 0, accent, Modifier.weight(1f).fillMaxHeight()) }
        }
    } else {
        // a phone: the first tile across the full width, the rest two by two
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            SpTileView(tiles[0], true, accent, Modifier.fillMaxWidth())
            for (pair in tiles.drop(1).chunked(2)) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (t in pair) SpTileView(t, false, accent, Modifier.weight(1f).fillMaxHeight())
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun SpTileView(t: SpTile, first: Boolean, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val tint = if (first) Palette.accent2 else accent
    val shape = RoundedCornerShape(d.dp(12f))
    Column(modifier.clip(shape).background(Brush.verticalGradient(listOf(spLerp(Palette.surface, tint, if (first) 0.12f else 0.10f), Palette.surface)))
        .border(1.dp, spLerp(Palette.line, tint, if (first) 0.55f else 0.35f), shape).padding(horizontal = d.dp(10f), vertical = d.dp(6f))) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(t.label, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1, modifier = Modifier.weight(1f))
            if (t.badge.isNotEmpty()) {
                val on = t.badge == "AUTO" || (t.id == "ref" && Spectrum.s.refAuto && Spectrum.s.mode == SpMode.FREQ)
                Text(t.badge, color = if (on) SP_BLACK else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (on) accent else Color.Transparent).border(1.dp, if (on) accent else Palette.line, RoundedCornerShape(6.dp))
                        .clickable { Spectrum.badge(t.id) }.padding(horizontal = 6.dp, vertical = 2.dp))
            }
        }
        val value = @Composable { mod: Modifier ->
            Text(buildAnnotatedString {
                append(t.value)
                withStyle(SpanStyle(color = Palette.muted, fontSize = d.sp(if (d.wide) 12f else 10f), fontWeight = FontWeight.Bold, letterSpacing = 1.sp)) { append(" " + t.unit) }
            }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(if (d.wide) 24f else 18f), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
                style = TextStyle(shadow = Shadow(tint.copy(alpha = 0.45f), blurRadius = 28f)),
                modifier = mod.clickable { Spectrum.openPad(t.id) }.padding(top = 2.dp))
        }
        if (!d.wide) {
            // a phone: the knob's arrows either side of the value, one line, so five tiles leave room for the plot
            Row(Modifier.fillMaxWidth().padding(top = d.dp(2f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                SpKnob("‹", accent, compact = true) { Spectrum.turn(t.id, -1) }
                value(Modifier.weight(1f))
                SpKnob("›", accent, compact = true) { Spectrum.turn(t.id, 1) }
            }
            return@Column
        }
        value(Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            SpKnob("‹", accent) { Spectrum.turn(t.id, -1) }
            Canvas(Modifier.weight(1f).height(2.dp)) {
                val step = 6.dp.toPx(); var x = 0f
                while (x < size.width) { drawCircle(Palette.line, 1.dp.toPx(), Offset(x, size.height / 2)); x += step }
            }
            SpKnob("›", accent) { Spectrum.turn(t.id, 1) }
        }
    }
}

@Composable
private fun SpKnob(label: String, accent: Color, compact: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.width(d.dp(if (compact) 30f else 40f)).height(d.dp(if (compact) 30f else 28f)).clip(shape).background(Palette.paper).border(1.dp, Palette.line, shape).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Text(label, color = accent, fontWeight = FontWeight.Black, fontSize = d.sp(18f))
    }
}

/** A color part of the way from [a] toward [b]. */
private fun spLerp(a: Color, b: Color, f: Float) = androidx.compose.ui.graphics.lerp(a, b, f)

@Composable
private fun SpStatus() {
    // read so this part redraws with every frame (a State nobody reads subscribes nobody)
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val d = rememberDims()
    val (left, note) = Spectrum.status()
    Text(buildAnnotatedString {
        append(left); append("   ")
        withStyle(SpanStyle(color = if (Spectrum.calOk) Palette.muted else SP_ACTIVE)) { append(note) }
    }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), letterSpacing = 1.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 2.dp))
}

// ---- the keypad ------------------------------------------------------------------------------------------------

@Composable
private fun SpKeypad(accent: Color) {
    // read so this part redraws with every frame (a State nobody reads subscribes nobody)
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val d = rememberDims()
    val p = Spectrum.pad ?: return
    val focus = remember { FocusRequester() }
    val blink by rememberInfiniteTransition(label = "caret").animateFloat(1f, 0f, infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse), label = "caret")
    Dialog(onDismissRequest = { Spectrum.closePad() }) {
        val shape = RoundedCornerShape(d.dp(16f))
        Column(Modifier.widthIn(max = d.dp(380f)).clip(shape).background(Palette.surface).border(1.dp, spLerp(Palette.line, accent, 0.5f), shape)
            .focusRequester(focus).focusable().onKeyEvent { e -> spHardKey(e)?.let { Spectrum.padHardKey(it) } ?: false }
            .padding(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
                Text("✕", color = Palette.muted, fontSize = d.sp(18f), modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { Spectrum.closePad() }.padding(horizontal = 8.dp))
            }
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Palette.paper).border(1.dp, Palette.line, RoundedCornerShape(10.dp)).padding(horizontal = d.dp(12f), vertical = d.dp(8f)),
                verticalAlignment = Alignment.CenterVertically) {
                Text(p.text.ifEmpty { " " }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(30f), textAlign = TextAlign.End, maxLines = 1,
                    style = TextStyle(shadow = Shadow(accent.copy(alpha = 0.4f), blurRadius = 24f)), modifier = Modifier.weight(1f))
                Box(Modifier.padding(start = 3.dp).width(3.dp).height(d.dp(30f)).alpha(blink).background(SP_ACTIVE))
            }
            // counting order, 1 2 3 on top (the web keypad is laid out the same)
            val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", if (p.kind == "db") "±" else "C")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Column(Modifier.weight(3f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (row in keys.chunked(3)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        for (k in row) SpPadKey(k, Palette.ink, Modifier.weight(1f)) { Spectrum.padKey(k) }
                    }
                }
                Column(Modifier.weight(1.3f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for ((l, m) in Spectrum.padUnits()) SpPadKey(l, accent, Modifier.fillMaxWidth(), filled = true) { Spectrum.enterPad(m) }
                    SpPadKey("⌫", Palette.muted, Modifier.fillMaxWidth()) { Spectrum.padKey("bs") }
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

@Composable
private fun SpPadKey(label: String, c: Color, modifier: Modifier, filled: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.height(d.dp(48f)).clip(shape).background(if (filled) c.copy(alpha = 0.18f) else Palette.paper).border(1.dp, if (filled) c else Palette.line, shape).clickable { onClick() },
        contentAlignment = Alignment.Center) {
        // every unit key (GHz, MHz, kHz, Hz, dB...) one size, every digit another: sized by length, "Hz" came out as big as
        // a digit beside its smaller neighbours
        Text(label, color = c, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(if (filled) 14f else 20f), maxLines = 1)
    }
}

/** A hardware key as the keypad and the plot read it ("0".."9", ".", "-", "+", "enter", "bs", "esc", arrows, letters). */
private fun spHardKey(e: KeyEvent): String? {
    if (e.type != KeyEventType.KeyDown) return null
    return when (e.key) {
        Key.Enter, Key.NumPadEnter -> "enter"; Key.Backspace -> "bs"; Key.Escape -> "esc"
        Key.DirectionLeft -> "left"; Key.DirectionRight -> "right"
        else -> { val c = e.utf16CodePoint; if (c > 0) c.toChar().lowercaseChar().toString() else null }
    }
}

// ---- the plot --------------------------------------------------------------------------------------------------

@Composable
private fun SpPlotBox(modifier: Modifier) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Box(modifier.clip(shape).border(1.dp, Palette.line, shape)) { SpPlot() }
}

@Composable
private fun SpPlot() {
    // read so this part redraws with every frame (a State nobody reads subscribes nobody)
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val k = LocalDensity.current.density
    val focus = remember { FocusRequester() }
    var size by remember { mutableStateOf(android.util.Size(1, 1)) }
    fun g() = geom(size.width.toFloat(), size.height.toFloat(), k)
    Canvas(Modifier.fillMaxSize().focusRequester(focus).focusable()
        .onKeyEvent { e ->
            when (val key = spHardKey(e)) {
                null -> false
                "p" -> Spectrum.onKey("peak"); "n" -> Spectrum.onKey("next"); "=" -> Spectrum.onKey("+")
                else -> Spectrum.onKey(key)
            }
        }
        .pointerInput(Unit) {
            // the mouse wheel: zoom about the pointer, or pan sideways
            awaitPointerEventScope {
                while (true) {
                    val ev = awaitPointerEvent()
                    if (ev.type == PointerEventType.Scroll) {
                        val c = ev.changes.firstOrNull() ?: continue
                        val gg = g(); Spectrum.wheel(c.position.x, c.scrollDelta.y, c.scrollDelta.x, gg.l, gg.w); c.consume()
                    }
                }
            }
        }
        .pointerInput(Unit) {
            // The plot fills most of a phone, so it must not trap the page: a finger moving up or down is left to the
            // page's scroll (nothing here consumes it); the plot takes a gesture only once it is clearly sideways (pan,
            // a marker or a cursor), two fingers (a pinch), or a tap.
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                runCatching { focus.requestFocus() }
                val gg = g()
                Spectrum.down(down.position.x, gg.l, gg.w)
                val slop = viewConfiguration.touchSlop
                var pinching = false; var decided = false; var vertical = false
                var lastX = down.position.x
                while (true) {
                    val ev = awaitPointerEvent()
                    val pressed = ev.changes.filter { it.pressed }
                    if (pressed.isEmpty()) { if (vertical) Spectrum.cancel() else Spectrum.up(lastX, gg.l, gg.w); break }
                    if (vertical) continue
                    val xs = pressed.map { it.position.x }
                    if (xs.size >= 2 && !pinching) { pinching = true; decided = true; Spectrum.pinch(xs[0], xs[1]) }
                    if (!decided) {
                        val p = pressed[0].position
                        val dx = abs(p.x - down.position.x); val dy = abs(p.y - down.position.y)
                        if (dy > slop && dy > dx) { vertical = true; Spectrum.cancel(); continue }
                        if (dx > slop) decided = true
                    }
                    lastX = xs[0]
                    if (decided) { Spectrum.move(xs, gg.l, gg.w); ev.changes.forEach { it.consume() } }
                }
            }
        }) {
        // the frame counter, read here so every new frame redraws the plot
        if (ver < 0) return@Canvas
        if (size.width != this.size.width.toInt() || size.height != this.size.height.toInt()) size = android.util.Size(this.size.width.toInt(), this.size.height.toInt())
        val gg = geom(this.size.width, this.size.height, k)
        Spectrum.plotW = gg.w.roundToInt(); Spectrum.plotH = gg.h.roundToInt()
        drawIntoCanvas { renderPlot(it.nativeCanvas, gg, k) }
    }
}

/** The plot area inside the canvas: left, top, width, height of the graticule, and the whole canvas, in pixels. */
private class Geom(val l: Float, val t: Float, val w: Float, val h: Float, val fullW: Float, val fullH: Float)
private fun geom(W: Float, H: Float, k: Float): Geom {
    val l = 48 * k; val t = 30 * k; val r = 10 * k; val b = 24 * k
    return Geom(l, t, max(1f, W - l - r), max(1f, H - t - b), W, H)
}

private val SP_MONO_BOLD: Typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
private fun paint(c: Color, k: Float, stroke: Float = 0f, text: Float = 0f, align: Paint.Align = Paint.Align.LEFT, bold: Boolean = true): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = c.toArgb()
    if (stroke > 0f) { style = Paint.Style.STROKE; strokeWidth = stroke * k; strokeJoin = Paint.Join.ROUND }
    if (text > 0f) { textSize = text * k; typeface = if (bold) SP_MONO_BOLD else Typeface.MONOSPACE; textAlign = align }
}
private fun Color.a(alpha: Int) = copy(alpha = alpha / 255f)

/** A 256-step palette for the density display: night blue, violet, red, orange, yellow, white (ARGB). */
private val SP_PALETTE: IntArray = run {
    val stops = arrayOf(doubleArrayOf(0.0, 8.0, 12.0, 40.0), doubleArrayOf(0.2, 60.0, 20.0, 120.0), doubleArrayOf(0.45, 190.0, 30.0, 110.0),
        doubleArrayOf(0.65, 250.0, 110.0, 30.0), doubleArrayOf(0.85, 255.0, 210.0, 60.0), doubleArrayOf(1.0, 255.0, 255.0, 235.0))
    IntArray(256) { i ->
        val t = i / 255.0
        var q = 0; while (q < stops.size - 2 && t > stops[q + 1][0]) q++
        val s0 = stops[q]; val s1 = stops[q + 1]; val f = (t - s0[0]) / (s1[0] - s0[0])
        val r = s0[1] + f * (s1[1] - s0[1]); val g = s0[2] + f * (s1[2] - s0[2]); val b = s0[3] + f * (s1[3] - s0[3]); val a = min(255.0, 40 + t * 600)
        (Math.round(a).toInt() shl 24) or (Math.round(r).toInt() shl 16) or (Math.round(g).toInt() shl 8) or Math.round(b).toInt()
    }
}
private var densityBmp: Bitmap? = null
private var densityPx = IntArray(0)

private fun spGraticule(cv: android.graphics.Canvas, g: Geom, k: Float, label: (Int) -> String, rows: Int = 10) {
    val line = Palette.line
    val strong = paint(line, k, stroke = 1f); val soft = paint(line.a(0xaa), k, stroke = 1f)
    for (q in 0..10) { val x = g.l + q * g.w / 10; cv.drawLine(x, g.t, x, g.t + g.h, if (q == 5) strong else soft) }
    val lab = paint(Palette.muted, k, text = 10f, align = Paint.Align.RIGHT)
    for (q in 0..rows) {
        val y = g.t + q * g.h / rows
        cv.drawLine(g.l, y, g.l + g.w, y, if (q * 2 == rows) strong else soft)
        cv.drawText(label(q), g.l - 5 * k, y + 3 * k, lab)
    }
    // minor ticks along the center lines, as on a bench screen
    for (q in 0..50) { val x = g.l + q * g.w / 50; val y = g.t + g.h / 2; cv.drawLine(x, y - 2 * k, x, y + 2 * k, strong) }
    for (q in 0..rows * 5) { val y = g.t + q * g.h / (rows * 5); val x = g.l + g.w / 2; cv.drawLine(x - 2 * k, y, x + 2 * k, y, strong) }
}

private fun spDbLabel(v: Double): String { val s = String.format(Locale.US, "%.1f", v); return if (s.endsWith(".0")) s.dropLast(2) else s }

/** Draw the whole plot into a canvas (the screen, or the PNG export); [k] is pixels per dp. */
private fun renderPlot(cv: android.graphics.Canvas, g: Geom, k: Float) {
    val muted = Palette.muted; val ink = Palette.ink
    cv.drawRect(0f, 0f, g.fullW, g.fullH, paint(Palette.paper, k))
    // the screen: a faint glass gradient inside the graticule
    cv.drawRect(g.l, g.t, g.l + g.w, g.t + g.h, Paint().apply {
        shader = LinearGradient(0f, g.t, 0f, g.t + g.h, Color(0x124C8DFF).toArgb(), Color(0x044C8DFF).toArgb(), Shader.TileMode.CLAMP)
    })
    if (Spectrum.s.mode == SpMode.ZERO) { renderZero(cv, g, k); return }
    val s = Spectrum.s; val top = s.ref.toDouble(); val range = s.div * 10.0
    val vs = Spectrum.vSpan(); val vStart = Spectrum.vCenter() - vs / 2
    fun yOf(v: Double) = (g.t + (top - v) / range * g.h).toFloat().coerceIn(-1e5f, 1e5f)
    fun xOf(hz: Double) = (g.l + (hz - vStart) / vs * g.w).toFloat()
    // the density display, under everything (it is drawn for the settled span only)
    val per = Spectrum.persistence
    if (s.persist && per != null && Spectrum.view == null) {
        val lv = per.level()
        if (densityPx.size != lv.size) densityPx = IntArray(lv.size)
        for (i in lv.indices) { val v = lv[i]; densityPx[i] = if (v > 0.003f) SP_PALETTE[min(255, (sqrt(v.toDouble()) * 255).roundToInt())] else 0 }
        val bmp = densityBmp?.takeIf { it.width == per.cols && it.height == per.rows } ?: Bitmap.createBitmap(per.cols, per.rows, Bitmap.Config.ARGB_8888).also { densityBmp = it }
        bmp.setPixels(densityPx, 0, per.cols, 0, 0, per.cols, per.rows)
        cv.drawBitmap(bmp, Rect(0, 0, per.cols, per.rows), RectF(g.l, g.t, g.l + g.w, g.t + g.h),
            Paint(Paint.FILTER_BITMAP_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.ADD) })
    }
    spGraticule(cv, g, k, { q -> spDbLabel(top - q * s.div) })
    val wide = g.w / k >= 560
    val axis = paint(muted, k, text = 11f)
    val yb = g.t + g.h + 16 * k
    cv.drawText("${if (wide) "START " else ""}${fmtHz(vStart, 4)}", g.l, yb, axis)
    cv.drawText(if (wide) "${fmtHz(vStart + vs / 2, 6)}  ·  ${bwText(vs / 10)}/div" else "${bwText(vs / 10)}/div", g.l + g.w / 2, yb, paint(muted, k, text = 11f, align = Paint.Align.CENTER))
    cv.drawText("${if (wide) "STOP " else ""}${fmtHz(vStart + vs, 4)}", g.l + g.w, yb, paint(muted, k, text = 11f, align = Paint.Align.RIGHT))
    // top-left: the scale
    val refText = "REF ${s.ref} ${Spectrum.unitLabel()}"
    val refP = paint(ink, k, text = 12f)
    cv.drawText(refText, g.l, 13 * k, refP)
    // a narrow plot (a phone) leaves the second line to the marker: RBW and VBW are on the tiles anyway
    if (wide) cv.drawText("${s.div} dB/div · RBW ${bwText(Spectrum.frame?.rbw ?: Spectrum.rbwHz())} · VBW ${if (s.vbwAuto) "AUTO" else bwText(s.vbw)}", g.l, 26 * k, axis)
    else cv.drawText("${s.div} dB/div", g.l + refP.measureText("$refText  ") + 12 * k, 13 * k, axis)
    cv.save(); cv.clipRect(g.l, g.t, g.l + g.w, g.t + g.h)
    // measurement bands
    val t0 = Spectrum.measTrace()
    if (t0 != null && s.meas != Meas.OFF && s.meas != Meas.NOISE) {
        fun band(c: Double, bw: Double, col: Color) {
            val a = xOf(c - bw / 2); val b = xOf(c + bw / 2)
            cv.drawRect(a, g.t, a + max(1f, b - a), g.t + g.h, paint(col, k))
            val edge = paint(col.copy(alpha = 0.7f), k, stroke = 1f).apply { pathEffect = DashPathEffect(floatArrayOf(3 * k, 3 * k), 0f) }
            cv.drawLine(a, g.t, a, g.t + g.h, edge); cv.drawLine(b, g.t, b, g.t + g.h, edge)
        }
        val blue = Color(0xFF4C8DFF).copy(alpha = 0.16f); val amber = SP_ACTIVE.copy(alpha = 0.13f)
        if (s.meas == Meas.CHP) band(s.center, s.chBw, blue)
        if (s.meas == Meas.ACPR) { band(s.center, s.chBw, blue); band(s.center - s.spacing, s.chBw, amber); band(s.center + s.spacing, s.chBw, amber) }
        val y = t0.data
        if (s.meas == Meas.OBW && y != null) { val o = occupiedBw(y, t0.f0, t0.binHz, Spectrum.frame?.rbw ?: 1.0); band((o.lo + o.hi) / 2, o.bw, blue) }
    }
    // traces: a soft glow under a crisp line, the live trace filled down to the floor
    val cols = max(2, g.w.roundToInt())
    for (i in Spectrum.traces.indices.reversed()) {
        val t = Spectrum.traces[i]; val data = t.data ?: continue
        if (t.mode == TraceMode.OFF || data.isEmpty()) continue
        val x0 = xOf(t.f0 - t.binHz / 2); val x1 = xOf(t.f0 + (data.size - 0.5) * t.binHz)
        val a = max(g.l - 2 * k, x0); val b = min(g.l + g.w + 2 * k, x1)
        if (b <= a) continue
        // the bins visible on screen, one column per pixel
        val n = max(2, min(cols, (b - a).roundToInt()))
        val i0 = max(0, ((a - x0) / (x1 - x0) * data.size).toInt()); val i1 = min(data.size, kotlin.math.ceil((b - x0) / (x1 - x0) * data.size).toInt())
        if (i1 - i0 < 1) continue
        val y = toColumns(data.copyOfRange(i0, i1), n, s.det)
        val xa = x0 + i0.toFloat() / data.size * (x1 - x0); val xb = x0 + i1.toFloat() / data.size * (x1 - x0)
        val path = android.graphics.Path()
        for (c in 0 until n) { val x = xa + (c + 0.5f) * (xb - xa) / n; val yy = yOf(y[c].toDouble()); if (c > 0) path.lineTo(x, yy) else path.moveTo(x, yy) }
        val col = TRACE_COLOR[i]
        if (t.mode == TraceMode.LIVE && !s.persist) {
            val fill = android.graphics.Path(path).apply { lineTo(xb, g.t + g.h); lineTo(xa, g.t + g.h); close() }
            cv.drawPath(fill, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = LinearGradient(0f, g.t, 0f, g.t + g.h, intArrayOf(col.a(0x2e).toArgb(), col.a(0x0c).toArgb(), col.a(0).toArgb()), floatArrayOf(0f, 0.6f, 1f), Shader.TileMode.CLAMP)
            })
        }
        cv.drawPath(path, paint(col.a(0x22), k, stroke = 7f))
        cv.drawPath(path, paint(col.a(0x55), k, stroke = 3.5f))
        cv.drawPath(path, paint(col, k, stroke = 1.4f))
    }
    // a sweep's position: a thin bright line where the radio is now, with a fading tail
    val f = Spectrum.frame
    if (f != null && f.sweep && f.steps > 1 && f.step < f.steps && Spectrum.view == null) {
        val x = g.l + g.w * f.step / f.steps
        cv.drawRect(x - 18 * k, g.t, x, g.t + g.h, Paint().apply { shader = LinearGradient(x - 18 * k, 0f, x, 0f, SP_ACTIVE.a(0).toArgb(), SP_ACTIVE.copy(alpha = 0.25f).toArgb(), Shader.TileMode.CLAMP) })
        cv.drawRect(x - k, g.t, x + k, g.t + g.h, paint(SP_ACTIVE, k))
    }
    cv.restore()
    // markers: a diamond on the trace and a numbered tag over it
    s.markers.forEachIndexed { q, m ->
        if (!m.on) return@forEachIndexed
        val lvl = Spectrum.markerY(q)
        val x = xOf(m.hz)
        if (x < g.l - k || x > g.l + g.w + k) return@forEachIndexed
        val y = if (lvl.isFinite()) max(g.t + 4 * k, min(g.t + g.h - 4 * k, yOf(lvl))) else g.t + 12 * k
        val col = if (q == s.active) SP_ACTIVE else Color.White
        val dia = android.graphics.Path().apply { moveTo(x, y - 7 * k); lineTo(x + 6 * k, y); lineTo(x, y + 7 * k); lineTo(x - 6 * k, y); close() }
        cv.drawPath(dia, paint(col, k).apply { setShadowLayer(10 * k, 0f, 0f, col.toArgb()) })
        cv.drawPath(dia, paint(SP_BLACK, k, stroke = 1.5f))
        val tag = "${if (m.delta && q > 0) "Δ" else ""}${q + 1}"
        val tp = paint(SP_BLACK, k, text = 11f, align = Paint.Align.CENTER)
        val tw = tp.measureText(tag) + 8 * k; val ty = max(g.t + 2 * k, y - 26 * k)
        cv.drawRoundRect(RectF(x - tw / 2, ty, x + tw / 2, ty + 15 * k), 4 * k, 4 * k, paint(col, k))
        cv.drawText(tag, x, ty + 11 * k, tp)
    }
    // top-right: the active marker, large, as a bench analyzer prints it
    Spectrum.activeReadout()?.let { (head, fx, fy) ->
        cv.drawText(head, g.l + g.w, 13 * k, paint(SP_ACTIVE, k, text = 11f, align = Paint.Align.RIGHT))
        cv.drawText("$fx   $fy", g.l + g.w, 27 * k, paint(ink, k, text = if (wide) 15f else 13f, align = Paint.Align.RIGHT))
    }
    if (!Spectrum.connected()) cv.drawText("Connect a radio to measure", g.l + g.w / 2, g.t + g.h / 2, paint(muted, k, text = 13f, align = Paint.Align.CENTER).apply { typeface = Typeface.SANS_SERIF })
}

private fun renderZero(cv: android.graphics.Canvas, g: Geom, k: Float) {
    val s = Spectrum.s; val z = Spectrum.zcap; val muted = Palette.muted; val u = Spectrum.unitLabel()
    val panes = ArrayList<String>()
    if (s.showAmp) panes.add("amp"); if (s.showFm) panes.add("fm"); if (s.showPh) panes.add("ph")
    if (panes.isEmpty()) panes.add("amp")
    val gap = 12 * k; val ph = (g.h - gap * (panes.size - 1)) / panes.size
    val len = z?.amp?.size ?: 1; val rate = z?.rate ?: 1.0; val total = if (z != null) len / rate else s.zsTime
    val t0 = if (z != null && z.trig >= 0) -z.trig / rate else 0.0
    // the level frequency and phase are drawn above: 10 dB over the median of the window (the noise between bursts)
    val gate = if (z == null) 0f else z.amp.copyOf().also { it.sort() }.let { it[it.size / 2] + 10f }
    // the frequency pane fits the signal's swing (an FSK tone may sit past half the filter), in 1-2-2.5-5 steps
    // steady samples only: a carrier switching on or off (about one filter response, rate / bandwidth samples) is left out
    val steady = if (z != null) com.rocketgod.mayhem.core.spectrum.steadyMask(z.amp, gate, max(1, Math.round(z.rate / s.zsBw).toInt())) else ByteArray(0)
    val fmHalf = if (z != null) com.rocketgod.mayhem.core.spectrum.fmScale(z.fm, z.amp, gate, s.zsBw, steady) else s.zsBw / 2
    cv.drawText("${fmtHz(s.zsFreq, 6)} · FILTER ${bwText(s.zsBw)}", g.l, 13 * k, paint(Palette.ink, k, text = 12f))
    cv.drawText("REF ${s.ref} $u · ${s.div} dB/div · ${if (s.trig == TrigMode.FREE) "FREE RUN" else "${if (s.trig == TrigMode.RISE) "RISING" else "FALLING"} ${s.level} $u"}", g.l, 26 * k, paint(muted, k, text = 11f))
    panes.forEachIndexed { q, p ->
        val top = g.t + q * (ph + gap)
        val rows = if (p == "amp") 10 else 4
        val hi: Double; val lo: Double
        when (p) { "amp" -> { hi = s.ref.toDouble(); lo = s.ref - s.div * 10.0 }; "fm" -> { hi = fmHalf; lo = -fmHalf }; else -> { hi = 180.0; lo = -180.0 } }
        val pg = Geom(g.l, top, g.w, ph, g.fullW, g.fullH)
        if (q > 0) cv.drawRect(g.l, top, g.l + g.w, top + ph, paint(Color(0x0D4C8DFF), k))
        spGraticule(cv, pg, k, { dd ->
            val v = hi - dd * (hi - lo) / rows
            if (p == "fm") "${if (v > 0) "+" else if (v < 0) "−" else ""}${bwText(abs(v)).replace(" ", "")}" else String.format(Locale.US, "%.0f", v).let { if (it == "-0") "0" else it }
        }, rows)
        val col = TRACE_COLOR[when (p) { "amp" -> 0; "fm" -> 1; else -> 2 }]
        cv.drawText(when (p) { "amp" -> "AMPLITUDE $u"; "fm" -> "FREQUENCY"; else -> "PHASE °" }, g.l + 5 * k, top + 12 * k, paint(col, k, text = 10f))
        if (z == null) return@forEachIndexed
        val arr = when (p) { "amp" -> z.amp; "fm" -> z.fm; else -> z.ph }
        fun yOf(v: Double) = (top + (hi - v) / (hi - lo) * ph).toFloat().coerceIn(-1e5f, 1e5f)
        cv.save(); cv.clipRect(g.l, top, g.l + g.w, top + ph)
        if (p == "amp" && s.trig != TrigMode.FREE) cv.drawLine(g.l, yOf(s.level.toDouble()), g.l + g.w, yOf(s.level.toDouble()),
            paint(SP_ACTIVE, k, stroke = 1f).apply { pathEffect = DashPathEffect(floatArrayOf(5 * k, 4 * k), 0f) })
        // Frequency and phase mean something only while there is a signal: they are drawn where the amplitude stands
        // 10 dB over the noise and left blank in the noise between.
        fun gated(i: Int) = p == "amp" || steady[i].toInt() == 1
        val cols = max(2, g.w.roundToInt())
        val band = android.graphics.Path(); val trace = android.graphics.Path()
        var pen = false
        if (arr.size > cols * 2) {
            // dense: each column's spread as a faint band, and a crisp line through its peak (amplitude) or its middle
            for (c in 0 until cols) {
                val a = (c.toLong() * arr.size / cols).toInt(); val b = max(a + 1, ((c + 1).toLong() * arr.size / cols).toInt())
                var mn = Float.POSITIVE_INFINITY; var mx = Float.NEGATIVE_INFINITY; var sum = 0.0; var n = 0
                for (i in a until min(b, arr.size)) { if (!gated(i)) continue; val v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++ }
                val x = g.l + c + 0.5f
                if (n == 0) { pen = false; continue }
                band.moveTo(x, yOf(mx.toDouble())); band.lineTo(x, yOf(mn.toDouble()) + 0.6f * k)
                val y = yOf(when (p) { "amp" -> mx.toDouble(); "fm" -> sum / n; else -> arr[min(arr.size - 1, (a + b) / 2)].toDouble() })
                if (pen) trace.lineTo(x, y) else trace.moveTo(x, y)
                pen = true
            }
        } else {
            for (i in arr.indices) {
                if (!gated(i)) { pen = false; continue }
                val x = g.l + (i + 0.5f) / arr.size * g.w; val y = yOf(arr[i].toDouble())
                if (pen) trace.lineTo(x, y) else trace.moveTo(x, y)
                pen = true
            }
        }
        // a preview (waiting for the trigger) is drawn dimmed: it is the channel now, not a capture
        val dim = if (z.preview) 0.4f else 1f
        cv.drawPath(band, paint(col.copy(alpha = 0.22f * dim), k, stroke = 1f))
        cv.drawPath(trace, paint(col.copy(alpha = 0x30 / 255f * dim), k, stroke = 4f))
        cv.drawPath(trace, paint(col.copy(alpha = dim), k, stroke = 1.4f))
        if (z.trig >= 0) {
            val x = g.l + z.trig.toFloat() / len * g.w
            cv.drawLine(x, top, x, top + ph, paint(SP_ACTIVE, k, stroke = 1f))
            if (q == 0) cv.drawPath(android.graphics.Path().apply { moveTo(x - 6 * k, top); lineTo(x + 6 * k, top); lineTo(x, top + 8 * k); close() }, paint(SP_ACTIVE, k))
        }
        if (s.cursors) for ((c, l) in listOf(s.curA to "A", s.curB to "B")) {
            val x = (g.l + c * g.w).toFloat()
            cv.drawLine(x, top, x, top + ph, paint(Color.White, k, stroke = 1f).apply { pathEffect = DashPathEffect(floatArrayOf(3 * k, 3 * k), 0f) })
            if (q == 0) {
                cv.drawRoundRect(RectF(x - 8 * k, top + 2 * k, x + 8 * k, top + 17 * k), 4 * k, 4 * k, paint(Color.White, k))
                cv.drawText(l, x, top + 13 * k, paint(SP_BLACK, k, text = 11f, align = Paint.Align.CENTER))
            }
        }
        cv.restore()
    }
    val yb = g.t + g.h + 16 * k
    cv.drawText(fmtSec(t0), g.l, yb, paint(muted, k, text = 11f))
    cv.drawText(fmtSec(t0 + total), g.l + g.w, yb, paint(muted, k, text = 11f, align = Paint.Align.RIGHT))
    cv.drawText("${fmtSec(total / 10)}/div", g.l + g.w / 2, yb, paint(muted, k, text = 11f, align = Paint.Align.CENTER))
    val mid = paint(muted, k, text = 13f, align = Paint.Align.CENTER).apply { typeface = Typeface.SANS_SERIF }
    if (!Spectrum.connected()) cv.drawText("Connect a radio to measure", g.l + g.w / 2, g.t + g.h / 2, mid)
    else if (z == null || z.preview) {
        val msg = if (s.trig == TrigMode.FREE) "Starting…" else "Waiting for the trigger (${if (s.trig == TrigMode.RISE) "rising" else "falling"} through ${s.level} $u)"
        // with a preview on screen the dimmed trace says it all (the status line says ARMED); text only on an empty plot
        if (z == null) cv.drawText(msg, g.l + g.w / 2, g.t + g.h / 2, mid)
    }
}

/** The plot with its settings and readouts, as a PNG (1600 px wide, as on the web). */
private fun pngBytes(): ByteArray {
    Spectrum.measCard()
    val rows = if (Spectrum.s.mode == SpMode.ZERO) Spectrum.cursorRows() else Spectrum.markerRows()
    val w = 1600; val plotH = 720; val head = 64; val foot = 34 + 22 * (rows.size + (if (Spectrum.measText.isNotEmpty()) 1 else 0))
    val bmp = Bitmap.createBitmap(w, head + plotH + foot, Bitmap.Config.ARGB_8888)
    val cv = android.graphics.Canvas(bmp)
    cv.drawColor(Palette.paper.toArgb())
    cv.drawText(Spectrum.tiles().joinToString("   ") { "${it.label} ${it.value} ${it.unit}" }, 16f, 30f, paint(Palette.ink, 1f, text = 24f))
    cv.drawText("Mayhem Mobile · Spectrum · ${java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.MEDIUM, Locale.US).format(java.util.Date())} · ${Spectrum.calNote}",
        16f, 52f, paint(Palette.muted, 1f, text = 13f, bold = false))
    cv.save(); cv.translate(0f, head.toFloat())
    renderPlot(cv, Geom(60f, 34f, (w - 60 - 14).toFloat(), (plotH - 34 - 28).toFloat(), w.toFloat(), plotH.toFloat()), 1f)
    cv.restore()
    val ink = paint(Palette.ink, 1f, text = 15f, bold = false)
    var y = head + plotH + 24f
    if (Spectrum.measText.isNotEmpty()) { cv.drawText(Spectrum.measText, 16f, y, ink); y += 22f }
    for (r in rows) { cv.drawText(listOf(r.chip, if (r.k >= 0) "T${r.trace + 1}" else "", r.x, r.y, r.noise, r.extra).filter { it.isNotEmpty() }.joinToString("   "), 16f, y, ink); y += 22f }
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
    bmp.recycle()
    return out.toByteArray()
}

// ---- the side panel: the measurement, large, and the marker table ----------------------------------------------

@Composable
private fun SpSide(accent: Color) {
    // read so this part redraws with every frame (a State nobody reads subscribes nobody)
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val d = rememberDims()
    val card = Spectrum.measCard()
    val shape = RoundedCornerShape(d.dp(12f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Brush.verticalGradient(listOf(spLerp(Palette.surface, accent, 0.08f), Palette.surface)))
        .border(1.dp, spLerp(Palette.line, accent, 0.3f), shape).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row {
            Text(card.title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
            if (card.tag.isNotEmpty()) Text(card.tag, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
        }
        card.xl?.let { SpBigNum(it, accent, xl = true) }
        if (card.bigs.isNotEmpty()) {
            val per = if (card.three) 3 else 2
            for (row in card.bigs.chunked(per)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                for (b in row) Box(Modifier.weight(1f)) { SpBigNum(b, accent) }
                repeat(per - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        if (card.sub.isNotEmpty()) Text(card.sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        if (card.warn.isNotEmpty()) Text(card.warn, color = SP_ACTIVE, fontFamily = Mono, fontSize = d.sp(10f))
    }
    if (Spectrum.s.mode == SpMode.ZERO) {
        val rows = Spectrum.cursorRows()
        if (rows.isEmpty()) SpNote("CURSORS (below) puts two time cursors on the trace.")
        else SpTable(listOf("CUR", "TIME", "AMPLITUDE", "FREQ", "PHASE"), rows, zero = true)
    } else {
        val rows = Spectrum.markerRows()
        if (rows.isEmpty()) SpNote("Tap the trace to drop a marker, or PEAK below.")
        else SpTable(listOf("MKR", "TRC", "X", "Y", "NOISE"), rows, zero = false)
    }
}

@Composable
private fun SpBigNum(b: SpBig, accent: Color, xl: Boolean = false) {
    val d = rememberDims()
    Column {
        Text(b.label, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
        Text(buildAnnotatedString {
            append(b.value)
            if (b.unit.isNotEmpty()) withStyle(SpanStyle(color = Palette.muted, fontSize = d.sp(if (xl) 18f else 11f), fontWeight = FontWeight.Bold)) { append(" " + b.unit) }
        }, color = if (b.hot) SP_ACTIVE else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(if (xl) 38f else 19f), maxLines = 1, softWrap = false,
            overflow = TextOverflow.Ellipsis, style = if (xl || b.hot) TextStyle(shadow = Shadow((if (b.hot) SP_ACTIVE else accent).copy(alpha = 0.55f), blurRadius = 36f)) else TextStyle.Default)
    }
}

@Composable
private fun SpNote(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.fillMaxWidth().panel().padding(d.dp(10f)))
}

@Composable
private fun SpTable(head: List<String>, rows: List<SpMkRow>, zero: Boolean) {
    val d = rememberDims()
    val weights = if (zero) listOf(0.7f, 1.2f, 1.3f, 1.3f, 0.7f) else listOf(0.7f, 0.5f, 1.9f, 1.3f, 1.2f)
    Column(Modifier.fillMaxWidth().panel().padding(horizontal = d.dp(8f), vertical = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        Row(Modifier.fillMaxWidth()) {
            head.forEachIndexed { i, h -> Text(h, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.5.sp, modifier = Modifier.weight(weights[i])) }
        }
        for (r in rows) {
            val diff = r.k == -2
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(if (r.active) SP_ACTIVE.copy(alpha = 0.10f) else Color.Transparent)
                .then(if (r.k >= 0) Modifier.clickable { Spectrum.setActive(r.k) } else Modifier).padding(vertical = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(weights[0])) {
                    if (diff) Text(r.chip, color = SP_ACTIVE, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f))
                    else Text(r.chip, color = SP_BLACK, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f),
                        modifier = Modifier.clip(RoundedCornerShape(5.dp)).background(if (r.active) SP_ACTIVE else Color.White).padding(horizontal = 6.dp, vertical = 1.dp))
                }
                val c = if (diff) SP_ACTIVE else Palette.ink
                val cells = if (zero) listOf(r.x, r.y, r.noise, r.extra) else listOf("T${r.trace + 1}", r.x, r.y, if (r.noise.isEmpty()) "" else "${r.noise} ${Spectrum.unitLabel()}/Hz")
                cells.forEachIndexed { i, v ->
                    Text(v, color = if (!zero && i == 0) TRACE_COLOR[r.trace] else c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (!zero && i == 3) 9f else 10.5f),
                        maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(weights[i + 1]))
                }
            }
        }
    }
}

// ---- controls --------------------------------------------------------------------------------------------------

/** A row of controls the height of its tallest. */
@Composable
private fun SpLine(content: @Composable RowScope.() -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically, content = content)
}

/** A row that scrolls sideways when it holds more than fits (presets, filters, the OPEN IN buttons). */
@Composable
private fun SpScrollLine(content: @Composable RowScope.() -> Unit) {
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
    Row(modifier.fillMaxHeight().heightIn(min = d.dp(40f)).clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.fillMaxHeight().clickable { onStep(-1) }.padding(horizontal = d.dp(12f)), contentAlignment = Alignment.Center) {
            Text("−", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1)
            Text("  $value", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11.5f), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.fillMaxHeight().clickable { onStep(1) }.padding(horizontal = d.dp(12f)), contentAlignment = Alignment.Center) {
            Text("+", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
    }
}

@Composable
private fun ColumnScope.SpControls(accent: Color, exportCsv: () -> Unit, exportPng: () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val ver = Spectrum.ver.collectAsState().value
    val d = rememberDims()
    val s = Spectrum.s
    fun sgnI(v: Int) = if (v > 0) "+$v" else "$v"
    SegBar(listOf("FREQUENCY", "ZERO SPAN"), if (s.mode == SpMode.FREQ) 0 else 1, accent) { Spectrum.setMode(if (it == 0) SpMode.FREQ else SpMode.ZERO) }
    if (s.mode == SpMode.FREQ) {
        SectionLabel("SPAN")
        SpScrollLine {
            for ((l, v) in SPAN_PRESETS) Chip(l, s.span == v, accent) { Spectrum.setSpan(s.center, v) }
            ToggleBox("START/STOP", s.startStop, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("ss") }
        }
        SectionLabel("SCALE · RESOLUTION")
        SpLine {
            SpStep("SCALE", "${s.div} dB/div", accent, Modifier.weight(1f)) { Spectrum.stepper("div", it) }
            SpStep("CAL", "${sgnI(s.cal)} dB", accent, Modifier.weight(1f)) { Spectrum.stepper("cal", it) }
        }
        SegBar(listOf("dBm", "dBFS"), if (s.unit == SpUnit.DBM) 0 else 1, accent) { Spectrum.setUnit(if (it == 0) SpUnit.DBM else SpUnit.DBFS) }
        SpLine {
            SegBar(listOf("HANN", "FLAT TOP"), if (s.window == WindowKind.HANN) 0 else 1, accent, Modifier.weight(1f)) { Spectrum.setWindow(if (it == 0) WindowKind.HANN else WindowKind.FLATTOP) }
            SegBar(DETECTORS.map { it.name }, DETECTORS.indexOf(s.det), accent, Modifier.weight(1.4f)) { Spectrum.setDet(DETECTORS[it]) }
        }
        SectionLabel("TRACES")
        Spectrum.traces.forEachIndexed { i, t ->
            SpLine {
                Text("T${i + 1}", color = TRACE_COLOR[i], fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f))
                SegBar(TRACE_MODES.map { it.name }, TRACE_MODES.indexOf(t.mode), TRACE_COLOR[i], Modifier.weight(1f)) { Spectrum.setTraceMode(i, TRACE_MODES[it]) }
                ToggleBox("CLEAR", false, accent, Modifier.fillMaxHeight()) { Spectrum.clearTrace(i) }
            }
            if (t.mode == TraceMode.AVG) SpLine { SpStep("N", t.avgN.toString(), TRACE_COLOR[i], Modifier.weight(1f)) { Spectrum.stepper("avg$i", it) } }
        }
        SectionLabel("MARKERS")
        val mk = s.markers[s.active]
        SpLine {
            SegBar(s.markers.mapIndexed { i, m -> "M${i + 1}${if (m.on) (if (m.delta) " Δ" else " ◆") else ""}" }, s.active, accent, Modifier.weight(1f)) { Spectrum.setActive(it) }
            ToggleBox("ON", mk.on, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("mkon") }
            if (s.active > 0) ToggleBox("DELTA", mk.delta, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("mkd") }
        }
        SegBar((0 until 4).map { "READS T${it + 1}" }, mk.trace, accent) { Spectrum.setMarkerTrace(it) }
        SpScrollLine {
            ToggleBox("PEAK", true, SP_ACTIVE, Modifier.fillMaxHeight()) { Spectrum.action("peak") }
            for ((id, l) in listOf("next" to "NEXT PEAK", "left" to "◀ NEXT", "right" to "NEXT ▶", "mkcf" to "MKR → CENTER", "mkoff" to "ALL OFF", "autoscale" to "AUTO SCALE"))
                ToggleBox(l, false, accent, Modifier.fillMaxHeight()) { Spectrum.action(id) }
        }
        SectionLabel("MEASURE")
        SegBar(Meas.entries.map { it.label }, Meas.entries.indexOf(s.meas), accent) { Spectrum.setMeas(Meas.entries[it]) }
        SpLine { ToggleBox("PERSISTENCE", s.persist, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("persist") } }
        if (s.meas == Meas.CHP || s.meas == Meas.ACPR) SpLine {
            SpStep("CHANNEL", bwText(s.chBw), accent, Modifier.weight(1f)) { Spectrum.stepper("chbw", it) }
            if (s.meas == Meas.ACPR) SpStep("SPACING", bwText(s.spacing), accent, Modifier.weight(1f)) { Spectrum.stepper("spacing", it) }
        }
    } else {
        SectionLabel("FILTER")
        SpScrollLine { for (b in Spectrum.zsBws()) Chip(bwText(b).replace(" ", ""), s.zsBw == b, accent) { Spectrum.setZsBw(b) } }
        SectionLabel("TRIGGER")
        SegBar(TRIG_MODES.map { when (it) { TrigMode.FREE -> "FREE RUN"; TrigMode.RISE -> "RISING"; TrigMode.FALL -> "FALLING" } }, TRIG_MODES.indexOf(s.trig), accent) { Spectrum.setTrig(TRIG_MODES[it]) }
        SpScrollLine {
            ToggleBox("SINGLE", s.single, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("single") }
            if (s.single) ToggleBox(if (Spectrum.armed) "ARMED" else "ARM", Spectrum.armed, SP_ACTIVE, Modifier.fillMaxHeight()) { Spectrum.action("arm") }
            ToggleBox("AUTO LEVEL", false, accent, Modifier.fillMaxHeight()) { Spectrum.action("autolvl") }
        }
        if (s.trig != TrigMode.FREE) SpLine { SpStep("PRE-TRIGGER", "${(s.pre * 100).roundToInt()} %", accent, Modifier.weight(1f)) { Spectrum.stepper("pre", it) } }
        SectionLabel("VIEW · SCALE")
        SpScrollLine {
            ToggleBox("AMPLITUDE", s.showAmp, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vamp") }
            ToggleBox("FREQUENCY", s.showFm, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vfm") }
            ToggleBox("PHASE", s.showPh, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("vph") }
            ToggleBox("CURSORS", s.cursors, accent, Modifier.fillMaxHeight()) { Spectrum.toggle("cur") }
        }
        SpLine { SpStep("SCALE", "${s.div} dB/div", accent, Modifier.weight(1f)) { Spectrum.stepper("div", it) } }
        SegBar(listOf("dBm", "dBFS"), if (s.unit == SpUnit.DBM) 0 else 1, accent) { Spectrum.setUnit(if (it == 0) SpUnit.DBM else SpUnit.DBFS) }
    }
    SectionLabel("RADIO · EXPORT · OPEN IN")
    SpScrollLine {
        ToggleBox("RADIO · ${Spectrum.gainText()}", false, Palette.danger, Modifier.fillMaxHeight()) { RadioUi.show() }
        ToggleBox("CSV", false, accent, Modifier.fillMaxHeight()) { exportCsv() }
        ToggleBox("PNG", false, accent, Modifier.fillMaxHeight()) { exportPng() }
        ToggleBox("OPEN IN ANALYZER", false, accent, Modifier.fillMaxHeight()) { Spectrum.openIn(MayhemApp.ANALYZER) }
        ToggleBox("OPEN IN DEVICES", false, accent, Modifier.fillMaxHeight()) { Spectrum.openIn(MayhemApp.DEVICES) }
    }
    Text("Gain is set in RADIO and held while Spectrum is open (the AGC does not move it under a measurement). The dBm scale follows the gain and is approximate; " +
        "CAL trims it against a known source. ANALYZER and DEVICES open on " + (if (s.mode == SpMode.ZERO) "the zero-span frequency" else "the active marker (or the center)") +
        ". On the plot: pinch to zoom, drag to pan, tap to drop the active marker, drag a marker to move it.",
        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
    Spacer(Modifier.size(1.dp))
}
