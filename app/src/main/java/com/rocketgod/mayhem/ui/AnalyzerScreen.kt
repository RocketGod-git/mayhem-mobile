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
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
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
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.analyzer.AnBurst
import com.rocketgod.mayhem.core.analyzer.Alignment as BitAlignment
import com.rocketgod.mayhem.core.analyzer.Analysis
import com.rocketgod.mayhem.core.analyzer.Analyzer
import com.rocketgod.mayhem.core.analyzer.CODINGS
import com.rocketgod.mayhem.core.analyzer.Coding
import com.rocketgod.mayhem.core.analyzer.FM_SCALE
import com.rocketgod.mayhem.core.analyzer.MODS
import com.rocketgod.mayhem.core.analyzer.Mod
import com.rocketgod.mayhem.core.analyzer.Overrides
import com.rocketgod.mayhem.core.analyzer.Similar
import com.rocketgod.mayhem.core.analyzer.align
import com.rocketgod.mayhem.core.analyzer.analyze
import com.rocketgod.mayhem.core.analyzer.bitsToAscii
import com.rocketgod.mayhem.core.analyzer.bitsToHex
import com.rocketgod.mayhem.core.analyzer.carrierOf
import com.rocketgod.mayhem.core.analyzer.noiseOf
import com.rocketgod.mayhem.core.analyzer.similar
import com.rocketgod.mayhem.core.r433.Devices
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
 * The Analyzer: the list of captured signals, the selected one's waveform in three views, its demodulation (worked
 * out, or set by hand), its frames as bits, hex and text, and its repeats lined up bit by bit. Twin of the web app's
 * web/src/analyzer-ui.ts; the capture and the reading are core/analyzer.
 */

private fun fmt(f: String, vararg a: Any?) = String.format(Locale.US, f, *a)
private fun mhzOf(hz: Double) = fmt("%.3f MHz", hz / 1e6)
private val CODING_LABEL = mapOf(Coding.NRZ to "NRZ", Coding.Manchester to "MANCH", Coding.PWM to "PWM", Coding.PPM to "PPM")
private fun rateLabel(bps: Double) = if (bps >= 1000) fmt("%.2f kbit/s", bps / 1000) else fmt("%.0f bit/s", bps)
private fun group8(bits: String) = bits.chunked(8).joinToString(" ")
private fun modColor(m: Mod): Color = when (m) { Mod.OOK -> Color(0xFFFFB020); Mod.ASK -> Color(0xFFB48CFF); Mod.FSK -> Color(0xFF3FD0C9) }

/** The card glyph: a pulse train, in a 24-unit box. */
private const val WAVE_GLYPH = "M2 17h3V7h3.5v10H11V7h1.8v10h3V7H20v10h2"
private var wavePath: Path? = null

/** Where the burst was: its absolute frequency, or its offset from center when the center is not known. */
private fun whereOf(a: AnBurst): String =
    if (a.center != 0L) mhzOf(Analyzer.freqOf(a)) else fmt("%s%.0f kHz", if (a.b.hz >= 0) "+" else "", a.b.hz / 1e3)
private fun whenOf(a: AnBurst): String = if (a.b.src != null) fmt("+%.3f s", a.b.t) else Devices.clock(a.b.wall)

/** What a pick in the detail panel is waiting to save, for the document picker. */
private class PendingSave(val bytes: ByteArray)

@Composable
fun AnalyzerScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val bursts by Analyzer.bursts.collectAsState()
    val stats by Analyzer.stats.collectAsState()
    val capturing by Analyzer.capturing.collectAsState()
    val note by Analyzer.note.collectAsState()
    var sel by rememberSaveable { mutableStateOf(0) }
    var comparing by rememberSaveable { mutableStateOf(false) }
    val picked = bursts.firstOrNull { it.b.id == sel }

    // import: any file the document picker offers; the rate comes from its name, as on the web
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) kotlin.concurrent.thread(isDaemon = true, name = "analyzer-import") {
            val name = displayName(ctx, uri)
            val bytes = runCatching { ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            if (bytes == null) android.os.Handler(android.os.Looper.getMainLooper()).post { Toast.makeText(ctx, "Could not read $name", Toast.LENGTH_LONG).show() }
            else Analyzer.import(name, bytes)
        }
    }
    var pending by remember { mutableStateOf<PendingSave?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val p = pending; pending = null
        if (uri != null && p != null) runCatching { ctx.contentResolver.openOutputStream(uri)?.use { it.write(p.bytes) } }
            .onFailure { Toast.makeText(ctx, "Could not save the file", Toast.LENGTH_LONG).show() }
    }
    val save: (String, ByteArray) -> Unit = { name, bytes -> pending = PendingSave(bytes); runCatching { saver.launch(name) } }

    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        share = true,
        // a burst open in the detail takes the waterfall's room: its own trace is the one to look at
        noVisual = picked != null && !d.wide,
        face = {
            FreqCard(accent, tag = "ANALYZER", title = "CAPTURE · DEMOD · COMPARE", freq = freq, meter = level / 40f, left = "SIGNAL +%.0f dB".format(level),
                right = "${bursts.size} captured",
                lamp = {
                    when {
                        !capturing -> Lamp("CAPTURE OFF", Palette.muted)
                        (stats?.channels ?: 0) > 0 -> Lamp("CAPTURING", Palette.ok, blink = true)
                        else -> Lamp("WATCHING", Palette.accent2, blink = true)
                    }
                })
        },
        visual = { m ->
            Box(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxSize(),
                    rows = if (d.wide) 160 else 80, traceFrac = 0.26f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = onPreview, onTapFrac = onTune)
            }
        }
    ) {
        Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            TileRow(Analyzer.BANDS.map { (label, hz) -> Tile(label, "MHz", freq == hz) }, accent, width = 84.dp) { Analyzer.pickFreq(Analyzer.BANDS[it].second) }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("CAPTURE", capturing, accent, Modifier.fillMaxHeight()) { Analyzer.setCapturing(!capturing) }
                ToggleBox("IMPORT", false, accent, Modifier.fillMaxHeight()) { runCatching { importer.launch(arrayOf("*/*")) } }
                Spacer(Modifier.weight(1f))
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { Analyzer.clear(); sel = 0; comparing = false }
            }
            StatusLines(stats, freq, capturing, bursts, note)
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            BurstCards(bursts, sel, Modifier.fillMaxSize()) { id -> sel = if (sel == id) 0 else id; comparing = false }
            if (picked != null) {
                val shape = RoundedCornerShape(d.dp(14f))
                val c = modColor(picked.auto.mod)
                Box(Modifier.fillMaxSize().padding(d.dp(2f)).clip(shape).background(Palette.panel.copy(alpha = 0.97f))
                    .background(Brush.linearGradient(listOf(c.copy(alpha = 0.10f), Palette.panel)))
                    .border(1.5.dp, c.copy(alpha = 0.8f), shape)) {
                    if (comparing) ComparePanel(picked, bursts, c, onBack = { comparing = false }, onClose = { sel = 0; comparing = false })
                    else BurstDetail(picked, c, save, onCompare = { comparing = true }, onClose = { sel = 0 })
                }
            }
        }
    }
}

private fun displayName(ctx: Context, uri: Uri): String =
    runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "import.cu8"

@Composable
private fun StatusLines(s: com.rocketgod.mayhem.core.analyzer.AnalyzerStats?, center: Long, capturing: Boolean, bursts: List<AnBurst>, note: String) {
    val d = rememberDims()
    val matched = bursts.count { it.b.matches.isNotEmpty() }
    val top = if (s != null) fmt("WATCHING %.2f–%.2f MHz", (center - s.span / 2) / 1e6, (center + s.span / 2) / 1e6) +
        (if (s.channels > 0) " · TUNED TO ${s.channels} BURST${if (s.channels == 1) "" else "S"} NOW" else "") + (if (capturing) "" else " · CAPTURE OFF")
        else if (capturing) "listening…" else "CAPTURE OFF"
    Text(top, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text("${bursts.size} captured · $matched matched a Devices decoder" + (if (s != null) " · ${s.followed} bursts followed" else "") +
        (if (note.isNotEmpty()) " · $note" else ""), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, overflow = TextOverflow.Ellipsis)
}

// ---- the cards ------------------------------------------------------------------------------------------------

@Composable
private fun BurstCards(bursts: List<AnBurst>, sel: Int, modifier: Modifier, onSel: (Int) -> Unit) {
    val d = rememberDims()
    Box(modifier) {
        if (bursts.isEmpty()) {
            Box(Modifier.fillMaxSize().panel(), contentAlignment = Alignment.Center) {
                Text("nothing yet. Press a key fob or a remote near the antenna, or IMPORT a recording (.cu8 .cs8 .sub)",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(d.dp(14f)))
            }
        } else {
            val shown = remember(bursts) { bursts.asReversed().toList() }
            LazyVerticalGrid(GridCells.Adaptive(d.dp(230f)), Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                items(shown, key = { it.b.id }) { a -> BurstCard(a, sel == a.b.id) { onSel(a.b.id) } }
            }
        }
    }
}

@Composable
private fun WaveGlyph(c: Color) {
    val d = rememberDims()
    Box(Modifier.size(d.dp(34f)).background(c.copy(alpha = 0.16f), RoundedCornerShape(d.dp(10f))), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(d.dp(22f))) {
            val path = wavePath ?: PathParser().parsePathString(WAVE_GLYPH).toPath().also { wavePath = it }
            val s = size.minDimension / 24f
            scale(s, s, pivot = Offset.Zero) { drawPath(path, c, style = Stroke(width = 1.7f, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
        }
    }
}

/** One captured burst: where and when, how it reads in big type, its bits as hex, and what a decoder made of it. */
@Composable
private fun BurstCard(x: AnBurst, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val a = x.auto
    val c = modColor(a.mod)
    val big = if (a.frames.isNotEmpty()) "${a.mod} · ${a.coding.name.uppercase()}" else if (a.mod == Mod.OOK && a.why.startsWith("a plain")) "CARRIER" else a.mod.name
    val sub = if (a.frames.isNotEmpty()) "${rateLabel(a.baud)} · ${x.best.length} bits${if (a.frames.size > 1) " · ${a.frames.size} frames" else ""}" else a.why
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().clip(shape)
        .background(Brush.linearGradient(listOf(c.copy(alpha = 0.10f), Palette.panel)))
        .border(if (selected) 2.5.dp else 1.dp, c.copy(alpha = if (selected) 1f else 0.3f), shape)
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            WaveGlyph(c)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(whereOf(x), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
                Text(x.b.src ?: "burst ${x.b.id}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(whenOf(x), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
            Text(big, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (x.best.isNotEmpty()) Text(bitsToHex(x.best), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        for (m in x.b.matches.take(2)) Pill(m, Palette.ok)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(fmt("%.1f ms", x.b.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(fmt("%.0f dBFS · %.0f dB SNR", x.b.dbfs, x.b.snr), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
    }
}

// ---- the detail ---------------------------------------------------------------------------------------------

/** What the panel keeps between bursts: the hand settings of each, by id, and the view. */
private object DetailState {
    val over = mutableStateMapOf<Int, Overrides>()
    var view by mutableStateOf(0)
    var fmt by mutableStateOf(1)
    var selOnly by mutableStateOf(false)
}

/** What the trace shows: the zoom if there is one, else the burst itself with a little either side. */
private fun shownOf(x: AnBurst, zoom: Pair<Int, Int>?): Pair<Int, Int> {
    if (zoom != null) return zoom
    val a = x.auto; val pad = max(16, ((a.to - a.from) * 0.06).roundToInt())
    return if (a.to > a.from) max(0, a.from - pad) to min(x.b.n, a.to + pad) else 0 to x.b.n
}

@Composable
private fun BurstDetail(x: AnBurst, c: Color, save: (String, ByteArray) -> Unit, onCompare: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val b = x.b
    var zoom by remember(b.id) { mutableStateOf<Pair<Int, Int>?>(null) }
    var pick by remember(b.id) { mutableStateOf<Pair<Int, Int>?>(null) }
    val o = DetailState.over[b.id] ?: Overrides()
    val selOnly = DetailState.selOnly
    val range = pick ?: zoom
    val a: Analysis = remember(b.id, o, selOnly, range) {
        val oo = if (selOnly && range != null) o.copy(from = range.first.toDouble(), to = range.second.toDouble()) else o
        if (oo == Overrides()) x.auto else analyze(b.env, b.fm, b.n, b.rate, oo)
    }
    fun setOver(f: (Overrides) -> Overrides) { val n = f(o); if (n == Overrides()) DetailState.over.remove(b.id) else DetailState.over[b.id] = n }
    val shown = shownOf(x, zoom)
    val scroll = rememberScrollState()
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Column(Modifier.weight(1f)) {
                Text(whereOf(x), color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
                Text((if (b.src != null) "${b.src} · ${whenOf(x)}" else whenOf(x)) + fmt(" · %.1f ms · %.0f dB SNR", b.ms, b.snr),
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ToggleBox("COMPARE", false, c, Modifier.fillMaxHeight()) { onCompare() }
            ToggleBox("✕", false, c, Modifier.fillMaxHeight()) { onClose() }
        }
        SegBar(listOf("AMPLITUDE", "FREQUENCY", "I/Q"), DetailState.view, c) { DetailState.view = it }
        WaveCanvas(x, a, DetailState.view, shown, pick, c, Modifier.fillMaxWidth().height(d.dp(180f))) { pick = it }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox("ZOOM", false, c, Modifier.fillMaxHeight(), dim = pick == null) { pick?.let { zoom = it; pick = null } }
            ToggleBox("FULL", false, c, Modifier.fillMaxHeight()) { zoom = 0 to b.n; pick = null }
            val r = pick ?: zoom
            Text(if (r != null) fmt("%.3f ms · %.1f symbols", (r.second - r.first) / b.rate * 1000, (r.second - r.first) / b.rate * 1e6 / max(1.0, a.symUs)) else "drag across the trace to select",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), modifier = Modifier.weight(1f), maxLines = 2)
        }
        CtlRow("MOD") {
            val opts = listOf<Mod?>(null) + MODS
            SegBar(opts.map { it?.name ?: "AUTO" }, opts.indexOf(o.mod), c, Modifier.weight(1f)) { i -> setOver { it.copy(mod = opts[i], thr = null) } }
        }
        CtlRow("CODING") {
            val opts = listOf<Coding?>(null) + CODINGS
            SegBar(opts.map { if (it == null) "AUTO" else CODING_LABEL.getValue(it) }, opts.indexOf(o.coding), c, Modifier.weight(1f)) { i -> setOver { it.copy(coding = opts[i]) } }
        }
        CtlRow("SYMBOL") {
            ToggleBox("−", false, c, Modifier.fillMaxHeight()) { setOver { it.copy(symUs = a.symUs / 1.05) } }
            Text(fmt("%.1f µs", a.symUs), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), modifier = Modifier.width(d.dp(76f)), maxLines = 1)
            ToggleBox("+", false, c, Modifier.fillMaxHeight()) { setOver { it.copy(symUs = a.symUs * 1.05) } }
            Spacer(Modifier.weight(1f))
            ToggleBox("AUTO", o.symUs == null, c, Modifier.fillMaxHeight()) { setOver { it.copy(symUs = null) } }
        }
        CtlRow("THRESHOLD") {
            var drag by remember(b.id, a.thr) { mutableStateOf((a.thr * 100).toFloat()) }
            Slider(drag, { drag = it }, Modifier.weight(1f), valueRange = 2f..98f, onValueChangeFinished = { val v = drag / 100.0; setOver { it.copy(thr = v) } },
                colors = SliderDefaults.colors(thumbColor = c, activeTrackColor = c, inactiveTrackColor = Palette.line))
            Text("${drag.roundToInt()}%", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), modifier = Modifier.width(d.dp(40f)))
            ToggleBox("AUTO", o.thr == null, c, Modifier.fillMaxHeight()) { setOver { it.copy(thr = null) } }
        }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox("INVERT", o.invert, c, Modifier.fillMaxHeight()) { setOver { it.copy(invert = !it.invert) } }
            ToggleBox("SELECTION ONLY", selOnly, c, Modifier.fillMaxHeight()) { DetailState.selOnly = !selOnly }
        }
        val why = "${a.mod} (${a.why}) · ${a.coding} · symbol ${fmt("%.1f", a.symUs)} µs · ${rateLabel(a.baud)}" + if (a.mod == Mod.FSK) fmt(" · shift %.1f kHz", a.shiftHz / 1e3) else ""
        Text(why, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
        SegBar(listOf("BITS", "HEX", "ASCII"), DetailState.fmt, c) { DetailState.fmt = it }
        if (a.frames.isEmpty()) Text("no frames: set the modulation, symbol or cut by hand, or select the part that carries data", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        else SelectionContainer {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                a.frames.forEachIndexed { i, f ->
                    val body = when (DetailState.fmt) { 0 -> group8(f.bits); 1 -> bitsToHex(f.bits); else -> bitsToAscii(f.bits) }
                    Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text("${i + 1}", color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(18f)))
                        Text("${f.bits.length}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(30f)))
                        Text(body, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.weight(1f))
                    }
                }
            }
        }
        Text(if (b.matches.isNotEmpty()) "DEVICES DECODERS: ${b.matches.joinToString(" · ")}" else "no Devices decoder claimed it",
            color = if (b.matches.isNotEmpty()) Palette.ok else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        CtlRow("EXPORT") {
            ToggleBox(".CU8", false, c, Modifier.fillMaxHeight()) { save(Analyzer.nameFor(x, "cu8"), Analyzer.cu8(x)) }
            ToggleBox(".CS8", false, c, Modifier.fillMaxHeight()) { save(Analyzer.nameFor(x, "cs8"), Analyzer.cs8(x)) }
            ToggleBox(".SUB", false, c, Modifier.fillMaxHeight(), dim = a.runs.isEmpty()) { if (a.runs.isNotEmpty()) save(Analyzer.nameFor(x, "sub"), Analyzer.sub(x, a)) }
        }
        Text(fmt("%.0f kHz I/Q, %d samples", b.rate / 1e3, b.n), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

@Composable
private fun CtlRow(label: String, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Box(Modifier.width(d.dp(74f))) { RowLabel(label) }
        content()
    }
}

// ---- the waveform -------------------------------------------------------------------------------------------

/**
 * The selected burst's trace: the envelope, the discriminator (only where the carrier is up) or the raw I/Q as a
 * spectrogram; the frames shaded, the cut line on the view that is sliced, the sliced line under it all, and the
 * part dragged across. [onPick] gets a selection in samples, or null.
 */
@Composable
private fun WaveCanvas(x: AnBurst, a: Analysis, view: Int, shown: Pair<Int, Int>, pick: Pair<Int, Int>?, c: Color, modifier: Modifier, onPick: (Pair<Int, Int>?) -> Unit) {
    val b = x.b
    val (a0, a1) = shown
    val len = max(1, a1 - a0)
    val on = remember(b.id) { carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate)) }
    val paper = Palette.paper; val ink = Palette.ink; val muted = Palette.muted; val accent2 = Palette.accent2
    val spectro = if (view == 2) remember(b.id, a0, a1, paper, c, accent2) { spectrogram(b.iq, b.n, a0, a1, paper, c, accent2) } else null
    val measurer = rememberTextMeasurer()
    val label = TextStyle(color = muted, fontFamily = Mono, fontSize = 10.sp)
    val shownNow by rememberUpdatedState(shown)
    val pickNow by rememberUpdatedState(onPick)
    Canvas(modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, Palette.line, RoundedCornerShape(8.dp)).pointerInput(b.id) {
        var from = -1
        fun at(px: Float): Int { val (s0, s1) = shownNow; return (s0 + (px / size.width).coerceIn(0f, 1f) * (s1 - s0)).roundToInt() }
        var last: Pair<Int, Int>? = null
        detectDragGestures(
            onDragStart = { p -> from = at(p.x); last = null },
            onDragEnd = { if (last != null && last!!.second - last!!.first < 4) pickNow(null); from = -1 },
            onDragCancel = { from = -1 },
        ) { change, _ ->
            if (from < 0) return@detectDragGestures
            val to = at(change.position.x)
            last = if (to == from) null else min(from, to) to max(from, to)
            pickNow(last)
        }
    }) {
        val W = size.width; val H = size.height
        drawRect(paper)
        fun xOf(i: Int) = (i - a0).toFloat() / len * W
        val axisH = 14.dp.toPx(); val digH = 18.dp.toPx(); val top = 4.dp.toPx()
        val plotH = H - digH - axisH - top
        // frames, shaded behind everything
        for (f in a.frames) drawRect(c.copy(alpha = 0.1f), Offset(xOf(f.start), 0f), Size(max(1f, xOf(f.end) - xOf(f.start)), H - axisH))
        if (view == 2 && spectro != null) {
            drawImage(spectro, IntOffset.Zero, IntSize(spectro.width, spectro.height), IntOffset(0, top.roundToInt()), IntSize(W.roundToInt(), plotH.roundToInt()), filterQuality = FilterQuality.None)
            drawText(measurer, fmt("+%.0f kHz", b.rate / 2e3), Offset(4f, top + 2f), label.copy(color = Color.White.copy(alpha = 0.7f)))
            drawText(measurer, fmt("−%.0f kHz", b.rate / 2e3), Offset(4f, top + plotH - 16.dp.toPx()), label.copy(color = Color.White.copy(alpha = 0.7f)))
        } else {
            val sig = if (view == 0) b.env else b.fm
            val gate = if (view == 1) on else null
            var lo = Double.POSITIVE_INFINITY; var hi = Double.NEGATIVE_INFINITY
            for (i in a0 until min(a1, b.n)) { if (gate != null && !gate[i]) continue; val v = sig[i].toDouble(); if (v < lo) lo = v; if (v > hi) hi = v }
            if (lo == Double.POSITIVE_INFINITY) { lo = -1.0; hi = 1.0 }
            if (view == 1) { val m = max(max(abs(lo), abs(hi)), 1.0); lo = -m; hi = m } else lo = 0.0
            if (hi <= lo) hi = lo + 1
            fun yOf(v: Double) = (top + plotH - (v - lo) / (hi - lo) * plotH).toFloat()
            if (view == 1) drawLine(muted.copy(alpha = 0.4f), Offset(0f, yOf(0.0)), Offset(W, yOf(0.0)), 1f)
            val cols = W.toInt()
            val stroke = max(1f, 1.dp.toPx() * 0.6f)
            for (px in 0 until cols) {
                val i0 = a0 + floor(px.toDouble() * len / cols).toInt(); val i1 = max(i0 + 1, a0 + floor((px + 1).toDouble() * len / cols).toInt())
                var mn = Double.POSITIVE_INFINITY; var mx = Double.NEGATIVE_INFINITY
                var i = i0
                while (i < i1 && i < b.n) { if (gate == null || gate[i]) { val v = sig[i].toDouble(); if (v < mn) mn = v; if (v > mx) mx = v }; i++ }
                if (mn == Double.POSITIVE_INFINITY) continue
                drawLine(c, Offset(px + 0.5f, yOf(mx)), Offset(px + 0.5f, yOf(mn) + 0.5f), stroke)
            }
            // the cut line, when this view is the one sliced
            val sliced = (view == 1) == (a.mod == Mod.FSK)
            if (sliced && a.runs.isNotEmpty()) drawLine(accent2, Offset(0f, yOf(a.cut)), Offset(W, yOf(a.cut)), 1.dp.toPx(),
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx())))
            val note = if (view == 1) fmt("±%.0f kHz", hi / FM_SCALE * b.rate / (2 * PI) / 1e3) else fmt("%.0f dBFS peak", 20 * log10(max(1.0, hi) / 16384))
            drawText(measurer, note, Offset(4.dp.toPx(), top), label)
        }
        // the sliced line, under the trace
        val y0 = H - axisH - 3.dp.toPx(); val y1 = y0 - digH + 6.dp.toPx()
        val path = Path(); path.moveTo(0f, y0)
        var pos = a.from; var lvl = false
        for (r in a.runs) {
            val x0 = xOf(pos); val x1 = xOf(pos + r.n)
            if (x1 >= 0 && x0 <= W) { val y = if (r.hi) y1 else y0; if (r.hi != lvl) path.lineTo(max(0f, x0), y); path.lineTo(min(W, x1), y) }
            lvl = r.hi; pos += r.n
        }
        drawPath(path, ink, style = Stroke(width = max(1f, 1.dp.toPx() * 0.7f)))
        // the selection
        if (pick != null) {
            val x0 = xOf(pick.first); val x1 = xOf(pick.second)
            drawRect(accent2.copy(alpha = 0.18f), Offset(x0, 0f), Size(x1 - x0, H - axisH))
            drawRect(accent2, Offset(x0, 0f), Size(x1 - x0, H - axisH), style = Stroke(1f))
        }
        // time axis
        val dec = if (len / b.rate < 0.01) "%.3f ms" else "%.1f ms"
        drawText(measurer, fmt(dec, a0 / b.rate * 1000), Offset(2f, H - axisH), label)
        val t = fmt(dec, a1 / b.rate * 1000)
        val tw = measurer.measure(t, label).size.width
        drawText(measurer, t, Offset(W - tw - 2f, H - axisH), label)
    }
}

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

// ---- compare ------------------------------------------------------------------------------------------------

private class Cand(val x: AnBurst, override val mod: Mod, override val coding: Coding, override val symUs: Double, override val bits: Int) : Similar

/** Bursts left out of the comparison, by id. */
private val leftOut = mutableStateMapOf<Int, Boolean>()

/**
 * The repeats of the selected burst lined up bit by bit: each one's longest frame, read with its own auto settings,
 * fixed bits plain and changing ones in the accent, the preamble and sync word marked over them.
 */
@Composable
private fun ComparePanel(sel: AnBurst, bursts: List<AnBurst>, c: Color, onBack: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val group = remember(bursts, sel.b.id) {
        if (sel.best.isEmpty()) emptyList() else {
            val sum = bursts.filter { it.best.isNotEmpty() }.map { Cand(it, it.auto.mod, it.auto.coding, it.auto.symUs, it.best.length) }
            similar(sum, sum.first { it.x.b.id == sel.b.id }).map { it.x }
        }
    }
    val rows = group.filter { leftOut[it.b.id] != true || it.b.id == sel.b.id }
    val al = remember(rows) { align(rows.map { it.best }) }
    val scroll = rememberScrollState()
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Column(Modifier.weight(1f)) {
                Text("COMPARE", color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f))
                Text("${rows.size} frame${if (rows.size == 1) "" else "s"} like burst ${sel.b.id} · ${sel.auto.mod} · ${sel.auto.coding} · ${fmt("%.0f", sel.auto.symUs)} µs",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2)
            }
            ToggleBox("BACK", false, c, Modifier.fillMaxHeight()) { onBack() }
            ToggleBox("✕", false, c, Modifier.fillMaxHeight()) { onClose() }
        }
        if (rows.size < 2) {
            Text("capture the same button a few more times: frames that read alike are lined up here", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        } else AlignedRows(al, rows, sel.b.id, c)
        val out = group.filter { leftOut[it.b.id] == true && it.b.id != sel.b.id }
        if (out.isNotEmpty()) {
            Text("LEFT OUT (tap to put back)", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (x in out) ToggleBox("#${x.b.id}", false, c) { leftOut.remove(x.b.id) }
            }
        }
    }
}

@Composable
private fun AlignedRows(al: BitAlignment, rows: List<AnBurst>, selId: Int, c: Color) {
    val d = rememberDims()
    val pre = al.preamble; val sync = al.sync
    Text("${rows.size} frames · " + (if (pre != null) "preamble ${pre.second - pre.first} bits · " else "") + (if (sync != null) "sync ${sync.hex} · " else "") +
        "${al.fixedBits} fixed · ${al.changingBits} changing", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
    // the segment bar: fixed and changing stretches, with their lengths where there is room
    val total = max(1, al.segments.sumOf { it.to - it.from })
    if (al.segments.isNotEmpty()) Row(Modifier.fillMaxWidth().height(d.dp(18f)).clip(RoundedCornerShape(4.dp)), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
        for (s in al.segments) {
            val w = s.to - s.from
            Box(Modifier.weight(w.toFloat()).fillMaxHeight().background(if (s.fixed) Palette.line else c.copy(alpha = 0.7f)), contentAlignment = Alignment.Center) {
                if (w > total / 12) Text("$w", color = if (s.fixed) Palette.ink else inkOn(c), fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1, softWrap = false)
            }
        }
    }
    // the consensus a byte at a time from the end of the preamble: hex where all eight bits are fixed, dots where any change
    val start = pre?.second ?: sync?.from ?: 0
    val bytes = buildAnnotatedString {
        var col = start
        while (col + 8 <= al.width) {
            var fixed = true; for (k in 0 until 8) if (al.state[col + k] != 1) fixed = false
            if (fixed) withStyle(SpanStyle(color = Palette.ink)) { append(Integer.toHexString(al.consensus.substring(col, col + 8).toInt(2)).uppercase(Locale.US).padStart(2, '0')) }
            else withStyle(SpanStyle(color = c)) { append("··") }
            append(' ')
            col += 8
        }
    }
    Text("BYTES FROM THE ${if (pre != null) "END OF THE PREAMBLE" else "SYNC WORD"}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
    SelectionContainer { Text(bytes, fontFamily = Mono, fontSize = d.sp(10.5f)) }
    // the rows, scrolled sideways together under one ruler: P over the preamble, S over the sync, a tick every byte
    val ruler = buildString {
        for (col in 0 until al.width) append(
            if (pre != null && col >= pre.first && col < pre.second) 'P' else if (sync != null && col >= sync.from && col < sync.to) 'S'
            else if (col >= start && (col - start) % 8 == 0) '|' else ' ')
    }
    val bitSize = d.sp(10f)
    Row(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(" ", fontFamily = Mono, fontSize = bitSize)
            for (r in al.rows) {
                val x = rows[r.index]
                val me = x.b.id == selId
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    Text("${x.b.id}", color = if (me) c else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = bitSize, modifier = Modifier.width(d.dp(30f)), maxLines = 1)
                    Text(if (me) "  " else "IN", color = Palette.ok, fontFamily = Mono, fontSize = bitSize,
                        modifier = Modifier.width(d.dp(20f)).then(if (me) Modifier else Modifier.clickable { leftOut[x.b.id] = true }))
                }
            }
        }
        Column(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(ruler, color = Palette.accent2, fontFamily = Mono, fontSize = bitSize, maxLines = 1, softWrap = false)
            for (r in al.rows) {
                val line = buildAnnotatedString {
                    append(" ".repeat(r.shift))
                    for (j in r.bits.indices) {
                        val st = al.state[r.shift + j]
                        withStyle(SpanStyle(color = when (st) { 1 -> Palette.ink; 0 -> c; else -> Palette.muted.copy(alpha = 0.5f) }, fontWeight = if (st == 0) FontWeight.Bold else FontWeight.Normal)) { append(r.bits[j]) }
                    }
                }
                Text(line, fontFamily = Mono, fontSize = bitSize, maxLines = 1, softWrap = false)
            }
        }
    }
    Text("fixed in plain · changing in color · dim where one frame only · tap IN to leave a frame out", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
}
