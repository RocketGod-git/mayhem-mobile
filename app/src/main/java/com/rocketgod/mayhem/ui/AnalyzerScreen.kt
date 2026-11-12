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
 * The Analyzer: the list of captured signals (marked on the waterfall too), the selected one full screen with its
 * waveform in four views, its bits on the trace, its demodulation (worked out, or set by hand), its frames as bits,
 * hex and text, its pulse lengths, and its repeats lined up bit by bit with named fields that save as a protocol.
 * Twin of the web app's web/src/analyzer-ui.ts; the capture and the reading are core/analyzer.
 */

private fun fmt(f: String, vararg a: Any?) = String.format(Locale.US, f, *a)
private fun mhzOf(hz: Double) = fmt("%.3f MHz", hz / 1e6)
private val CODING_LABEL = mapOf(Coding.NRZ to "NRZ", Coding.Manchester to "MANCH", Coding.PWM to "PWM", Coding.PPM to "PPM")
private fun rateLabel(bps: Double) = if (bps >= 1000) fmt("%.2f kbit/s", bps / 1000) else fmt("%.0f bit/s", bps)
private fun group8(bits: String) = bits.chunked(8).joinToString(" ")
private fun modColor(m: Mod): Color = when (m) { Mod.OOK -> Color(0xFFFFB020); Mod.ASK -> Color(0xFFB48CFF); Mod.FSK -> Color(0xFF3FD0C9) }

/** Field colors by kind: preamble gray, sync blue, ID green, counter orange, CRC red, data purple. */
private fun kindColor(k: FieldKind): Color = when (k) {
    FieldKind.Preamble -> Color(0xFF8A939C); FieldKind.Sync -> Color(0xFF4C8DFF); FieldKind.Id -> Color(0xFF3FBF6F)
    FieldKind.Counter -> Color(0xFFFF9A3C); FieldKind.Crc -> Color(0xFFE5484D); FieldKind.Data -> Color(0xFFA77BFF)
}
private val KIND_LABEL = mapOf(FieldKind.Preamble to "PRE", FieldKind.Sync to "SYNC", FieldKind.Id to "ID", FieldKind.Counter to "CNT", FieldKind.Crc to "CRC", FieldKind.Data to "DATA")

/** The card glyph: a pulse train, in a 24-unit box. */
private const val WAVE_GLYPH = "M2 17h3V7h3.5v10H11V7h1.8v10h3V7H20v10h2"
private var wavePath: Path? = null

/** Where the burst was: its absolute frequency, or its offset from center when the center is not known. */
private fun whereOf(a: AnBurst): String =
    if (a.center != 0L) mhzOf(Analyzer.freqOf(a)) else fmt("%s%.0f kHz", if (a.b.hz >= 0) "+" else "", a.b.hz / 1e3)
private fun whenOf(a: AnBurst): String = if (a.b.src != null) fmt("+%.3f s", a.b.t) else Devices.clock(a.b.wall)

/** The longest frame of a reading. */
private fun bestOf(a: Analysis): Frame? = a.frames.maxByOrNull { it.bits.length }

/** What a pick in the detail panel is waiting to save, for the document picker. */
private class PendingSave(val bytes: ByteArray)

/** What the screen keeps between bursts and visits: the view, the text format, and the list's toggles. */
private object UiState {
    var view by mutableStateOf(0)
    var fmt by mutableStateOf(1)
    var selOnly by mutableStateOf(false)
    var starredOnly by mutableStateOf(false)
    var showFilter by mutableStateOf(false)
    var showProtocols by mutableStateOf(false)
}

@Composable
fun AnalyzerScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val bursts by Analyzer.bursts.collectAsState()
    val meta by Analyzer.meta.collectAsState()
    val protocols by Analyzer.protocols.collectAsState()
    val stats by Analyzer.stats.collectAsState()
    val capturing by Analyzer.capturing.collectAsState()
    val note by Analyzer.note.collectAsState()
    val filtered by Analyzer.filtered.collectAsState()
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
    // each live burst as a box on the waterfall at its time and frequency (imports have no place in its history)
    val rate = SdrEngine.currentRate()
    val boxes = remember(bursts, sel, freq, rate) {
        if (rate <= 0) emptyList() else bursts.filter { it.b.src == null && it.center != 0L }.map { x ->
            val t1 = x.b.wall - 60; val t0 = t1 - max(1L, x.b.ms.roundToLong())
            WfMark(x.b.id, t0, t1, (0.5 + (Analyzer.freqOf(x) - freq) / rate).toFloat(), (max(20_000.0, if (x.auto.mod == Mod.FSK) x.auto.shiftHz * 1.6 else 0.0) / rate).toFloat(),
                modColor(x.auto.mod), bold = x.b.id == sel)
        }
    }
    AdaptivePane(
        share = true,
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
                    onPreviewFrac = onPreview, onTapFrac = onTune, boxes = boxes, onBox = { id -> sel = id; comparing = false })
            }
        }
    ) {
        Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            TileRow(Analyzer.BANDS.map { (label, hz) -> Tile(label, "MHz", freq == hz) }, accent, width = 84.dp) { Analyzer.pickFreq(Analyzer.BANDS[it].second) }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("CAPTURE", capturing, accent, Modifier.fillMaxHeight()) { Analyzer.setCapturing(!capturing) }
                ToggleBox("IMPORT", false, accent, Modifier.fillMaxHeight()) { runCatching { importer.launch(arrayOf("*/*")) } }
                ToggleBox("FILTER", UiState.showFilter, accent, Modifier.fillMaxHeight()) { UiState.showFilter = !UiState.showFilter }
                ToggleBox("★ STARRED", UiState.starredOnly, accent, Modifier.fillMaxHeight()) { UiState.starredOnly = !UiState.starredOnly }
                ToggleBox("PROTOCOLS${if (protocols.isNotEmpty()) " ${protocols.size}" else ""}", UiState.showProtocols, accent, Modifier.fillMaxHeight()) { UiState.showProtocols = !UiState.showProtocols }
                ToggleBox("EXPORT SESSION", false, accent, Modifier.fillMaxHeight(), dim = bursts.isEmpty() && protocols.isEmpty()) {
                    if (bursts.isNotEmpty() || protocols.isNotEmpty()) save(Analyzer.sessionName(), Analyzer.exportSession())
                }
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { Analyzer.clear(); if (Analyzer.bursts.value.none { it.b.id == sel }) { sel = 0; comparing = false } }
            }
            if (UiState.showFilter) FilterRow(accent)
            if (UiState.showProtocols) ProtocolList(protocols, accent)
            StatusLines(stats, freq, capturing, bursts, note, filtered)
        }
        val shown = if (UiState.starredOnly) bursts.filter { meta[it.b.id]?.star == true } else bursts
        Box(Modifier.fillMaxWidth().weight(1f)) {
            BurstCards(shown, meta, protocols, sel, UiState.starredOnly, Modifier.fillMaxSize()) { id -> sel = id; comparing = false }
        }
    }
    if (picked != null) {
        val c = modColor(picked.auto.mod)
        Dialog(onDismissRequest = { if (comparing) comparing = false else sel = 0 },
            properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false)) {
            val shape = RoundedCornerShape(d.dp(14f))
            Box(Modifier.fillMaxSize().padding(d.dp(4f)).clip(shape).background(Palette.paper)
                .background(Brush.linearGradient(listOf(c.copy(alpha = 0.08f), Palette.paper)))
                .border(1.5.dp, c.copy(alpha = 0.8f), shape)) {
                if (comparing) ComparePanel(picked, bursts, protocols, c, onBack = { comparing = false }, onClose = { sel = 0; comparing = false })
                else BurstDetail(picked, meta[picked.b.id] ?: BurstMeta(), protocols, c, save, onCompare = { comparing = true }, onClose = { sel = 0 },
                    onTx = { a ->
                        // closed first: Transmit takes the screen, and the burst must not reopen on the way back
                        val keep = sel; sel = 0; comparing = false
                        val why = Analyzer.sendToTx(picked, a)
                        if (why != null) { sel = keep; Toast.makeText(ctx, why, Toast.LENGTH_LONG).show() }
                    })
            }
        }
    }
}

private fun Double.roundToLong(): Long = Math.round(this)

private fun displayName(ctx: Context, uri: Uri): String =
    runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "import.cu8"

@Composable
private fun StatusLines(s: com.rocketgod.mayhem.core.analyzer.AnalyzerStats?, center: Long, capturing: Boolean, bursts: List<AnBurst>, note: String, filtered: Int) {
    val d = rememberDims()
    val matched = bursts.count { it.b.matches.isNotEmpty() }
    val top = if (s != null) fmt("WATCHING %.2f–%.2f MHz", (center - s.span / 2) / 1e6, (center + s.span / 2) / 1e6) +
        (if (s.channels > 0) " · TUNED TO ${s.channels} BURST${if (s.channels == 1) "" else "S"} NOW" else "") + (if (capturing) "" else " · CAPTURE OFF")
        else if (capturing) "listening…" else "CAPTURE OFF"
    Text(top, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text("${bursts.size} captured · $matched matched a Devices decoder" + (if (filtered > 0) " · $filtered filtered out" else "") +
        (if (s != null) " · ${s.followed} bursts followed" else "") +
        (if (note.isNotEmpty()) " · $note" else ""), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, overflow = TextOverflow.Ellipsis)
}

// ---- the capture filter and the protocols -------------------------------------------------------------------------

private fun numOf(s: String): Double = s.trim().toDoubleOrNull() ?: 0.0
private fun numText(v: Double, scale: Double = 1.0): String = if (v == 0.0) "" else fmt("%s", (v / scale).let { if (it == floor(it)) it.toLong().toString() else fmt("%.3f", it).trimEnd('0') })

/** FILTER: what gets kept as bursts arrive. Blank is no limit. */
@Composable
private fun FilterRow(accent: Color) {
    val d = rememberDims()
    val f by Analyzer.filter.collectAsState()
    var lo by remember { mutableStateOf(numText(f.loHz, 1e6)) }
    var hi by remember { mutableStateOf(numText(f.hiHz, 1e6)) }
    var snr by remember { mutableStateOf(numText(f.minSnr)) }
    var minMs by remember { mutableStateOf(numText(f.minMs)) }
    var maxMs by remember { mutableStateOf(numText(f.maxMs)) }
    fun apply(g: (CaptureFilter) -> CaptureFilter) = Analyzer.setFilter(g(Analyzer.filter.value))
    Column(Modifier.fillMaxWidth().panel(accent.copy(alpha = 0.5f)).padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            TxField(lo, accent, "FROM MHz", Modifier.weight(1f), kb = Kb.DECIMAL) { lo = decimalOf(it); apply { x -> x.copy(loHz = numOf(lo) * 1e6) } }
            TxField(hi, accent, "TO MHz", Modifier.weight(1f), kb = Kb.DECIMAL) { hi = decimalOf(it); apply { x -> x.copy(hiHz = numOf(hi) * 1e6) } }
            TxField(snr, accent, "MIN SNR dB", Modifier.weight(1f), kb = Kb.DECIMAL) { snr = decimalOf(it); apply { x -> x.copy(minSnr = numOf(snr)) } }
        }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            TxField(minMs, accent, "MIN ms", Modifier.weight(1f), kb = Kb.DECIMAL) { minMs = decimalOf(it); apply { x -> x.copy(minMs = numOf(minMs)) } }
            TxField(maxMs, accent, "MAX ms", Modifier.weight(1f), kb = Kb.DECIMAL) { maxMs = decimalOf(it); apply { x -> x.copy(maxMs = numOf(maxMs)) } }
            ToggleBox("ONLY UNKNOWN", f.unknownOnly, accent) { apply { x -> x.copy(unknownOnly = !x.unknownOnly) } }
        }
        Text("kept bursts must pass every limit set; blank is no limit. A recording with no frequency in its name skips the MHz test.",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

/** The saved protocols: rename or delete. */
@Composable
private fun ProtocolList(protocols: List<Protocol>, accent: Color) {
    val d = rememberDims()
    var renaming by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().panel(accent.copy(alpha = 0.5f)).padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        if (protocols.isEmpty()) Text("no saved protocols yet: open a burst, COMPARE, name its fields and SAVE AS PROTOCOL",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        for (p in protocols) {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${p.mod} · ${p.coding} · ${fmt("%.0f", p.symUs)} µs · sync ${bitsToHex(p.sync)} · ${p.fields.size} fields" + (p.check?.let { " · ${it.name.substringBefore(" (")}" } ?: ""),
                            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    ToggleBox("RENAME", renaming == p.name, accent, Modifier.fillMaxHeight()) { renaming = if (renaming == p.name) null else p.name; newName = p.name }
                    ToggleBox("DELETE", false, Palette.danger, Modifier.fillMaxHeight()) { Analyzer.deleteProtocol(p.name) }
                }
                if (renaming == p.name) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    TxField(newName, accent, "NAME", Modifier.weight(1f)) { newName = it.take(40) }
                    ToggleBox("SAVE", false, accent) { Analyzer.renameProtocol(p.name, newName.trim()); renaming = null }
                }
            }
        }
    }
}

// ---- the cards ------------------------------------------------------------------------------------------------

@Composable
private fun BurstCards(bursts: List<AnBurst>, meta: Map<Int, BurstMeta>, protocols: List<Protocol>, sel: Int, starredOnly: Boolean, modifier: Modifier, onSel: (Int) -> Unit) {
    val d = rememberDims()
    Box(modifier) {
        if (bursts.isEmpty()) {
            Box(Modifier.fillMaxSize().panel(), contentAlignment = Alignment.Center) {
                Text(if (starredOnly) "no starred bursts: open one and tap ☆ to keep it through CLEAR"
                    else "nothing yet. Press a key fob or a remote near the antenna, or IMPORT a recording (.cu8 .cs8 .sub) or a session (.mmanalyzer)",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(d.dp(14f)))
            }
        } else {
            val shown = remember(bursts) { bursts.asReversed().toList() }
            LazyVerticalGrid(GridCells.Adaptive(d.dp(230f)), Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                // unkeyed on purpose: keyed, the grid keeps the card on screen anchored while newer ones are added above
                // it, so a fresh import opened scrolled to its oldest burst instead of its newest
                items(shown) { a -> BurstCard(a, meta[a.b.id] ?: BurstMeta(), protocols, sel == a.b.id) { onSel(a.b.id) } }
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

/** One captured burst: where and when, how it reads in big type, its bits as hex, its name, star and protocol. */
@Composable
private fun BurstCard(x: AnBurst, m: BurstMeta, protocols: List<Protocol>, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val a = x.auto
    val c = modColor(a.mod)
    val proto = remember(x, protocols) { Analyzer.recognized(x, protocols) }
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
                Text(m.name.ifEmpty { x.b.src ?: "burst ${x.b.id}" }, color = if (m.name.isNotEmpty()) Palette.ink else Palette.muted, fontFamily = Mono,
                    fontWeight = if (m.name.isNotEmpty()) FontWeight.Bold else FontWeight.Normal, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (m.star) Text("★", color = Palette.accent2, fontSize = d.sp(14f))
            Text(whenOf(x), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
            Text(big, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (x.best.isNotEmpty()) Text(bitsToHex(x.best), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (proto != null) Pill("PROTOCOL: ${proto.protocol.name}", Palette.accent2)
        for (mm in x.b.matches.take(2)) Pill(mm, Palette.ok)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(fmt("%.1f ms", x.b.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(fmt("%.0f dBFS · %.0f dB SNR", x.b.dbfs, x.b.snr), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
    }
}

// ---- the detail ---------------------------------------------------------------------------------------------

/** Bits [b0, b1) of frame [frame] lit on the trace, the bit strip and the decoded text. */
private data class Hl(val frame: Int, val b0: Int, val b1: Int)

/** What the trace shows: the zoom if there is one, else the burst itself with a little either side. */
private fun shownOf(x: AnBurst, zoom: Pair<Int, Int>?): Pair<Int, Int> {
    if (zoom != null) return zoom
    val a = x.auto; val pad = max(16, ((a.to - a.from) * 0.06).roundToInt())
    return if (a.to > a.from) max(0, a.from - pad) to min(x.b.n, a.to + pad) else 0 to x.b.n
}

/** The samples bits [b0, b1) of a frame span. */
private fun spanOf(f: Frame, b0: Int, b1: Int): Pair<Int, Int>? {
    if (f.spans.isEmpty() || b0 >= b1 || 2 * (b1 - 1) + 1 >= f.spans.size) return null
    return f.spans[2 * b0] to f.spans[2 * (b1 - 1) + 1]
}

/** The bit whose span holds sample [at], if any. */
private fun bitAt(a: Analysis, at: Double): Hl? {
    a.frames.forEachIndexed { fi, f ->
        for (k in 0 until f.spans.size / 2) if (at >= f.spans[2 * k] && at < f.spans[2 * k + 1]) return Hl(fi, k, k + 1)
    }
    return null
}

/** Text index to bit range, for the format shown (BITS grouped by 8, HEX, ASCII). */
private fun bitsAtChar(fmtI: Int, c: Int, nBits: Int): Pair<Int, Int>? = when (fmtI) {
    0 -> if (c % 9 == 8) null else (c / 9 * 8 + c % 9).let { if (it < nBits) it to it + 1 else null }
    1 -> (4 * c).let { if (it < nBits) it to min(nBits, it + 4) else null }
    else -> (8 * c).let { if (it + 8 <= nBits) it to it + 8 else null }
}

/** Bit range to text range [c0, c1). */
private fun charsOf(fmtI: Int, b0: Int, b1: Int): Pair<Int, Int> = when (fmtI) {
    0 -> (b0 / 8 * 9 + b0 % 8) to ((b1 - 1) / 8 * 9 + (b1 - 1) % 8 + 1)
    1 -> (b0 / 4) to ((b1 - 1) / 4 + 1)
    else -> (b0 / 8) to ((b1 - 1) / 8 + 1)
}

@Composable
private fun BurstDetail(x: AnBurst, m: BurstMeta, protocols: List<Protocol>, c: Color, save: (String, ByteArray) -> Unit,
                        onCompare: () -> Unit, onClose: () -> Unit, onTx: (Analysis) -> Unit) {
    val d = rememberDims()
    val b = x.b
    val overs by Analyzer.over.collectAsState()
    var zoom by remember(b.id) { mutableStateOf<Pair<Int, Int>?>(null) }
    var pick by remember(b.id) { mutableStateOf<Pair<Int, Int>?>(null) }
    var hl by remember(b.id) { mutableStateOf<Hl?>(null) }
    val o = overs[b.id] ?: Overrides()
    val selOnly = UiState.selOnly
    val range = pick ?: zoom
    val a: Analysis = remember(b.id, o, selOnly, range) {
        val oo = if (selOnly && range != null) o.copy(from = range.first.toDouble(), to = range.second.toDouble()) else o
        if (oo == Overrides()) x.auto else analyze(b.env, b.fm, b.n, b.rate, oo)
    }
    fun setOver(f: (Overrides) -> Overrides) = Analyzer.setOver(b.id, f(o))
    val shown = shownOf(x, zoom)
    val hlSpan = hl?.let { h -> a.frames.getOrNull(h.frame)?.let { spanOf(it, h.b0, h.b1) } }
    val screenH = LocalConfiguration.current.screenHeightDp
    val traceH = max(240f, screenH * 0.38f).coerceAtMost(screenH * 0.5f)
    Column(Modifier.fillMaxSize().padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        // header: where, when, how long and strong, the name and star, and what to do with it
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Column(Modifier.weight(1f)) {
                Text(whereOf(x) + if (m.name.isNotEmpty()) " · ${m.name}" else "", color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text((if (b.src != null) "${b.src} · ${whenOf(x)}" else whenOf(x)) + fmt(" · %.1f ms · %.0f dB SNR", b.ms, b.snr),
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ToggleBox(if (m.star) "★" else "☆", m.star, Palette.accent2, Modifier.fillMaxHeight()) { Analyzer.setMeta(b.id) { it.copy(star = !it.star) } }
            ToggleBox("✕", false, c, Modifier.fillMaxHeight()) { onClose() }
        }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox("COMPARE", false, c, Modifier.weight(1f).fillMaxHeight()) { onCompare() }
            ToggleBox("SEND TO TX", false, Palette.danger, Modifier.weight(1f).fillMaxHeight(), dim = a.runs.isEmpty()) { if (a.runs.isNotEmpty()) onTx(a) }
        }
        SegBar(listOf("AMPLITUDE", "FREQUENCY", "I/Q", "SPECTRUM"), UiState.view, c) { UiState.view = it }
        WaveCanvas(x, a, UiState.view, shown, pick, hlSpan, c, Modifier.fillMaxWidth().height(d.dp(traceH)), onTapAt = { at -> hl = bitAt(a, at) }) { pick = it }
        BitStrip(a, shown, hl, c, Modifier.fillMaxWidth().height(d.dp(22f))) { hl = it }
        // the decoded output, pinned under the trace
        SegBar(listOf("BITS", "HEX", "ASCII"), UiState.fmt, c) { UiState.fmt = it }
        Box(Modifier.fillMaxWidth().heightIn(max = d.dp(110f)).panel().padding(d.dp(6f))) {
            if (a.frames.isEmpty()) Text("no frames: set the modulation, symbol or cut by hand, or select the part that carries data", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            else Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                a.frames.forEachIndexed { i, f ->
                    Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text("${i + 1}", color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(18f)))
                        Text("${f.bits.length}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(30f)))
                        FrameText(i, f, UiState.fmt, hl, Modifier.weight(1f), onHl = { hl = it }, onPick = { pick = it })
                    }
                }
            }
        }
        // the rest scrolls
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("ZOOM", false, c, Modifier.fillMaxHeight(), dim = pick == null) { pick?.let { zoom = it; pick = null } }
                ToggleBox("FULL", false, c, Modifier.fillMaxHeight()) { zoom = 0 to b.n; pick = null }
                val r = pick ?: zoom
                Text(if (r != null) fmt("%.3f ms · %.1f symbols", (r.second - r.first) / b.rate * 1000, (r.second - r.first) / b.rate * 1e6 / max(1.0, a.symUs))
                    else "drag across the trace to select; tap or drag the bit strip, tap or long-press-drag the text",
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
            CtlRow("CUT") {
                var drag by remember(b.id, a.thr) { mutableStateOf((a.thr * 100).toFloat()) }
                Slider(drag, { drag = it }, Modifier.weight(1f), valueRange = 2f..98f, onValueChangeFinished = { val v = drag / 100.0; setOver { it.copy(thr = v) } },
                    colors = SliderDefaults.colors(thumbColor = c, activeTrackColor = c, inactiveTrackColor = Palette.line))
                Text("${drag.roundToInt()}%", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), modifier = Modifier.width(d.dp(40f)))
                ToggleBox("AUTO", o.thr == null, c, Modifier.fillMaxHeight()) { setOver { it.copy(thr = null) } }
            }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("INVERT", o.invert, c, Modifier.fillMaxHeight()) { setOver { it.copy(invert = !it.invert) } }
                ToggleBox("SELECTION ONLY", selOnly, c, Modifier.fillMaxHeight()) { UiState.selOnly = !selOnly }
            }
            val why = "${a.mod} (${a.why}) · ${a.coding} · symbol ${fmt("%.1f", a.symUs)} µs · ${rateLabel(a.baud)}" + if (a.mod == Mod.FSK) fmt(" · shift %.1f kHz", a.shiftHz / 1e3) else ""
            Text(why, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
            if (a.runs.size > 2) {
                Text("PULSE LENGTHS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
                HistogramView(a, b.rate, c, Modifier.fillMaxWidth().height(d.dp(90f)))
            }
            Text(if (b.matches.isNotEmpty()) "DEVICES DECODERS: ${b.matches.joinToString(" · ")}" else "no Devices decoder claimed it",
                color = if (b.matches.isNotEmpty()) Palette.ok else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            ProtocolFields(a, protocols)
            // name and note
            var name by remember(b.id) { mutableStateOf(m.name) }
            var noteText by remember(b.id) { mutableStateOf(m.note) }
            TxField(name, c, "NAME") { name = it.take(48); Analyzer.setMeta(b.id) { mm -> mm.copy(name = name.trim()) } }
            TxField(noteText, c, "NOTE", lines = 2) { noteText = it.take(500); Analyzer.setMeta(b.id) { mm -> mm.copy(note = noteText) } }
            CtlRow("EXPORT") {
                ToggleBox(".CU8", false, c, Modifier.fillMaxHeight()) { save(Analyzer.nameFor(x, "cu8"), Analyzer.cu8(x)) }
                ToggleBox(".CS8", false, c, Modifier.fillMaxHeight()) { save(Analyzer.nameFor(x, "cs8"), Analyzer.cs8(x)) }
                ToggleBox(".SUB", false, c, Modifier.fillMaxHeight(), dim = a.runs.isEmpty()) { if (a.runs.isNotEmpty()) save(Analyzer.nameFor(x, "sub"), Analyzer.sub(x, a)) }
            }
            Text(fmt("%.0f kHz I/Q, %d samples", b.rate / 1e3, b.n), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
    }
}

/** A saved protocol this reading carries: each field's value and whether its check holds. */
@Composable
private fun ProtocolFields(a: Analysis, protocols: List<Protocol>) {
    val d = rememberDims()
    val f = bestOf(a) ?: return
    val hit = remember(f.bits, protocols, a.mod, a.coding) { recognize(protocols, f.bits, a.mod.name, a.coding.name) } ?: return
    val p = hit.protocol
    val holds = checkHolds(p, f.bits, hit.start)
    Column(Modifier.fillMaxWidth().panel(Palette.accent2.copy(alpha = 0.6f)).padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        Text("PROTOCOL: ${p.name}", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp)
        for (fl in p.fields) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(fl.name, color = kindColor(fl.kind), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(130f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(fieldValue(f.bits, hit.start, fl), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
        }
        p.check?.let { ck ->
            Text("${ck.name} over bytes ${ck.from}–${ck.to - 1}: " + when (holds) { true -> "✓ holds"; false -> "✗ fails"; null -> "frame too short" },
                color = when (holds) { true -> Palette.ok; false -> Palette.danger; null -> Palette.muted }, fontFamily = Mono, fontSize = d.sp(10f))
        }
    }
}

@Composable
private fun CtlRow(label: String, content: @Composable RowScope.() -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Box(Modifier.width(d.dp(74f))) { RowLabel(label) }
        content()
    }
}

/**
 * One frame in the format chosen. Tapping a character lights its bits on the trace; a long press and drag over
 * characters selects that stretch of the trace. The bits lit from the strip light their characters here.
 */
@Composable
private fun FrameText(i: Int, f: Frame, fmtI: Int, hl: Hl?, modifier: Modifier, onHl: (Hl?) -> Unit, onPick: (Pair<Int, Int>?) -> Unit) {
    val d = rememberDims()
    val body = when (fmtI) { 0 -> group8(f.bits); 1 -> bitsToHex(f.bits); else -> bitsToAscii(f.bits) }
    val lit = Palette.accent2
    val text: AnnotatedString = remember(body, hl, fmtI, lit) {
        val h = hl?.takeIf { it.frame == i }
        if (h == null) AnnotatedString(body) else buildAnnotatedString {
            val (c0, c1) = charsOf(fmtI, h.b0, h.b1)
            val a0 = c0.coerceIn(0, body.length); val a1 = c1.coerceIn(a0, body.length)
            append(body.substring(0, a0))
            withStyle(SpanStyle(background = lit.copy(alpha = 0.45f), color = Color.White, fontWeight = FontWeight.Bold)) { append(body.substring(a0, a1)) }
            append(body.substring(a1))
        }
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val hlNow by rememberUpdatedState(onHl); val pickNow by rememberUpdatedState(onPick)
    fun bitsAt(p: Offset): Pair<Int, Int>? { val l = layout ?: return null; return bitsAtChar(fmtI, l.getOffsetForPosition(p), f.bits.length) }
    Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f), onTextLayout = { layout = it },
        modifier = modifier
            .pointerInput(f, fmtI) { detectTapGestures { p -> val r = bitsAt(p); hlNow(r?.let { Hl(i, it.first, it.second) }) } }
            .pointerInput(f, fmtI) {
                var from: Pair<Int, Int>? = null
                detectDragGesturesAfterLongPress(onDragStart = { p -> from = bitsAt(p); from?.let { hlNow(Hl(i, it.first, it.second)) } }) { ch, _ ->
                    val s = from ?: return@detectDragGesturesAfterLongPress
                    val e = bitsAt(ch.position) ?: return@detectDragGesturesAfterLongPress
                    val b0 = min(s.first, e.first); val b1 = max(s.second, e.second)
                    hlNow(Hl(i, b0, b1)); spanOf(f, b0, b1)?.let { pickNow(it) }
                    ch.consume()
                }
            })
}

/**
 * The bits under the trace: each one's span a cell, with its 0 or 1 where there is room (otherwise the boundaries
 * alone). Tapping or dragging over a cell lights that bit here, on the trace and in the text.
 */
@Composable
private fun BitStrip(a: Analysis, shown: Pair<Int, Int>, hl: Hl?, c: Color, modifier: Modifier, onHl: (Hl?) -> Unit) {
    val (a0, a1) = shown
    val len = max(1, a1 - a0)
    val measurer = rememberTextMeasurer()
    val ink = Palette.ink; val muted = Palette.muted; val lit = Palette.accent2; val paper = Palette.surface
    val style = TextStyle(color = ink, fontFamily = Mono, fontSize = 9.sp)
    val zero = remember(measurer) { measurer.measure("0", style) }
    val one = remember(measurer) { measurer.measure("1", style) }
    val shownNow by rememberUpdatedState(shown); val aNow by rememberUpdatedState(a); val hlNow by rememberUpdatedState(onHl)
    fun bitAt(x: Float, w: Float): Hl? {
        val (s0, s1) = shownNow
        return bitAt(aNow, (s0 + (x / w).coerceIn(0f, 1f) * (s1 - s0)).toDouble())
    }
    Canvas(modifier.clip(RoundedCornerShape(4.dp)).background(paper)
        .pointerInput(Unit) { detectTapGestures { p -> hlNow(bitAt(p.x, size.width.toFloat())) } }
        .pointerInput(Unit) { detectHorizontalDragGestures { ch, _ -> bitAt(ch.position.x, size.width.toFloat())?.let { hlNow(it) }; ch.consume() } }) {
        val W = size.width; val H = size.height
        fun xOf(i: Int) = (i - a0).toFloat() / len * W
        val room = 7.dp.toPx()
        a.frames.forEachIndexed { fi, f ->
            val n = f.spans.size / 2
            for (k in 0 until n) {
                val x0 = xOf(f.spans[2 * k]); val x1 = xOf(f.spans[2 * k + 1])
                if (x1 < 0 || x0 > W) continue
                val on = hl != null && hl.frame == fi && k >= hl.b0 && k < hl.b1
                if (on) drawRect(lit.copy(alpha = 0.55f), Offset(x0, 0f), Size(max(1f, x1 - x0), H))
                else if (f.bits[k] == '1') drawRect(c.copy(alpha = 0.16f), Offset(x0, 0f), Size(max(1f, x1 - x0), H))
                drawLine(muted.copy(alpha = 0.5f), Offset(x0, 0f), Offset(x0, H), 1f)
                if (x1 - x0 >= room) {
                    val t = if (f.bits[k] == '1') one else zero
                    drawText(t, topLeft = Offset((x0 + x1) / 2 - t.size.width / 2, (H - t.size.height) / 2))
                }
            }
        }
    }
}

/** URH's pulse-length histogram: marks in the burst's color, gaps in the second accent, symbol multiples faint. */
@Composable
private fun HistogramView(a: Analysis, rate: Double, c: Color, modifier: Modifier) {
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
        if (a.symUs > 0) { var k = 1; while (k * a.symUs < maxUs && k <= 40) { val x = (k * a.symUs / maxUs * W).toFloat(); drawLine(muted.copy(alpha = 0.25f), Offset(x, top), Offset(x, top + plotH), 1f); k++ } }
        for (i in 0 until bins) {
            val hm = h.marks[i].toFloat() / peak * plotH; val hs = h.spaces[i].toFloat() / peak * plotH
            if (hm > 0) drawRect(c, Offset(i * bw, top + plotH - hm), Size(max(1f, bw / 2 - 0.5f), hm))
            if (hs > 0) drawRect(gap.copy(alpha = 0.8f), Offset(i * bw + bw / 2, top + plotH - hs), Size(max(1f, bw / 2 - 0.5f), hs))
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

/**
 * The selected burst's trace: the envelope, the discriminator (only where the carrier is up), I and Q as two
 * traces, or the raw I/Q as a spectrogram; the frames shaded, the cut line on the view that is sliced, the sliced
 * line under it all, the bits lit from the strip or the text, and the part dragged across. [onPick] gets a
 * selection in samples, or null.
 */
@Composable
private fun WaveCanvas(x: AnBurst, a: Analysis, view: Int, shown: Pair<Int, Int>, pick: Pair<Int, Int>?, hlSpan: Pair<Int, Int>?, c: Color, modifier: Modifier,
                       onTapAt: (Double) -> Unit, onPick: (Pair<Int, Int>?) -> Unit) {
    val b = x.b
    val (a0, a1) = shown
    val len = max(1, a1 - a0)
    val on = remember(b.id) { carrierOf(b.env, b.n, noiseOf(b.env, b.n, b.rate)) }
    val paper = Palette.paper; val ink = Palette.ink; val muted = Palette.muted; val accent2 = Palette.accent2
    val spectro = if (view == 3) remember(b.id, a0, a1, paper, c, accent2) { spectrogram(b.iq, b.n, a0, a1, paper, c, accent2) } else null
    val measurer = rememberTextMeasurer()
    val label = TextStyle(color = muted, fontFamily = Mono, fontSize = 10.sp)
    val shownNow by rememberUpdatedState(shown)
    val pickNow by rememberUpdatedState(onPick)
    val tapNow by rememberUpdatedState(onTapAt)
    Canvas(modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, Palette.line, RoundedCornerShape(8.dp)).pointerInput(b.id) {
        // a tap (no drag) lights the bit under it
        detectTapGestures { p -> val (s0, s1) = shownNow; tapNow(s0 + (p.x / size.width).coerceIn(0f, 1f).toDouble() * (s1 - s0)) }
    }.pointerInput(b.id) {
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
        // the bits lit from the strip or the text
        if (hlSpan != null) drawRect(accent2.copy(alpha = 0.28f), Offset(xOf(hlSpan.first), 0f), Size(max(2f, xOf(hlSpan.second) - xOf(hlSpan.first)), H - axisH))
        if (view == 3 && spectro != null) {
            drawImage(spectro, IntOffset.Zero, IntSize(spectro.width, spectro.height), IntOffset(0, top.roundToInt()), IntSize(W.roundToInt(), plotH.roundToInt()), filterQuality = FilterQuality.None)
            drawText(measurer, fmt("+%.0f kHz", b.rate / 2e3), Offset(4f, top + 2f), label.copy(color = Color.White.copy(alpha = 0.7f)))
            drawText(measurer, fmt("−%.0f kHz", b.rate / 2e3), Offset(4f, top + plotH - 16.dp.toPx()), label.copy(color = Color.White.copy(alpha = 0.7f)))
            // a tick at either FSK tone
            if (a.mod == Mod.FSK && a.shiftHz > 0) for (s in listOf(1, -1)) {
                val y = (top + plotH * (0.5 - s * a.shiftHz / 2 / b.rate)).toFloat()
                drawLine(Color.White, Offset(W - 14.dp.toPx(), y), Offset(W, y), 2.dp.toPx())
            }
        } else if (view == 2) {
            // I and Q, each scaled to the peak in view
            var pk = 1
            for (i in a0 until min(a1, b.n)) { pk = max(pk, abs(b.iq[2 * i].toInt())); pk = max(pk, abs(b.iq[2 * i + 1].toInt())) }
            fun yOf(v: Int) = top + plotH / 2 - v.toFloat() / pk * plotH / 2 * 0.95f
            drawLine(muted.copy(alpha = 0.4f), Offset(0f, yOf(0)), Offset(W, yOf(0)), 1f)
            val cols = W.toInt()
            val stroke = max(1f, 1.dp.toPx() * 0.6f)
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
            if (len <= cols) {
                // fewer samples than pixels: join them with a line (broken where the carrier is down)
                val p = Path(); var pen = false
                for (i in a0 until min(a1, b.n)) {
                    if (gate != null && !gate[i]) { pen = false; continue }
                    val xx = xOf(i); val yy = yOf(sig[i].toDouble())
                    if (pen) p.lineTo(xx, yy) else p.moveTo(xx, yy); pen = true
                }
                drawPath(p, c, style = Stroke(stroke))
            } else for (px in 0 until cols) {
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

/** The fields being named in COMPARE and the check found, by the burst it was opened from. */
private object CompareState {
    val fields = mutableStateMapOf<Int, List<Field>>()
    val checks = mutableStateMapOf<Int, CheckFound?>()
}

/**
 * The repeats of the selected burst lined up bit by bit: each one's longest frame, read with its own auto settings,
 * fixed bits plain and changing ones in the accent, the named fields in a bar over them.
 */
@Composable
private fun ComparePanel(sel: AnBurst, bursts: List<AnBurst>, protocols: List<Protocol>, c: Color, onBack: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val group = remember(bursts, sel.b.id) {
        if (sel.best.isEmpty()) emptyList() else {
            val sum = bursts.filter { it.best.isNotEmpty() }.map { Cand(it, it.auto.mod, it.auto.coding, it.auto.symUs, it.best.length) }
            similar(sum, sum.first { it.x.b.id == sel.b.id }).map { it.x }
        }
    }
    val rows = group.filter { leftOut[it.b.id] != true || it.b.id == sel.b.id }
    val al = remember(rows) { align(rows.map { it.best }) }
    val id = sel.b.id
    // a burst that is a saved protocol starts with that protocol's fields
    if (CompareState.fields[id] == null) {
        val rec = Analyzer.recognized(sel, protocols)
        if (rec != null) { CompareState.fields[id] = rec.protocol.fields; CompareState.checks[id] = rec.protocol.check }
    }
    val fields = CompareState.fields[id] ?: emptyList()
    val check = CompareState.checks[id]
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
        } else {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("SUGGEST", false, c, Modifier.fillMaxHeight()) {
                    val sg = suggest(al)
                    CompareState.fields[id] = sg.fields; CompareState.checks[id] = sg.check
                }
                ToggleBox("CLEAR FIELDS", false, c, Modifier.fillMaxHeight(), dim = fields.isEmpty()) { CompareState.fields[id] = emptyList(); CompareState.checks[id] = null }
            }
            AlignedRows(al, rows, sel.b.id, c, fields, check) { CompareState.fields[id] = it }
            SaveProtocol(sel, al, fields, check, protocols, c)
        }
        val out = group.filter { leftOut[it.b.id] == true && it.b.id != sel.b.id }
        if (out.isNotEmpty()) {
            Text("LEFT OUT (tap to put back)", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (x in out) ToggleBox("#${x.b.id}", false, c) { leftOut.remove(x.b.id) }
            }
        }
    }
}

/** SAVE AS PROTOCOL: a name, then the sync word, the reading and the fields go into the saved list. */
@Composable
private fun SaveProtocol(sel: AnBurst, al: BitAlignment, fields: List<Field>, check: CheckFound?, protocols: List<Protocol>, c: Color) {
    val d = rememberDims()
    var asking by remember(sel.b.id) { mutableStateOf(false) }
    val known = Analyzer.recognized(sel, protocols)?.protocol?.name
    var name by remember(sel.b.id) { mutableStateOf(known ?: "protocol ${protocols.size + 1}") }
    // a sync field of the person's own wins over the one lined up; the fields then count from it (where recognize()
    // finds the data start), and a check found from the old start no longer lines up, so it is dropped
    val start = dataStart(al)
    val sf = fields.firstOrNull { it.kind == FieldKind.Sync }
    val sync = if (sf != null) al.consensus.substring((start + sf.from).coerceIn(0, al.width), (start + sf.to).coerceIn(0, al.width)).filter { it != '?' } else al.sync?.bits ?: ""
    val base = sf?.from ?: 0
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        ToggleBox("SAVE AS PROTOCOL", asking, Palette.accent2, Modifier.fillMaxHeight(), dim = fields.isEmpty() || sync.length < 8) { if (fields.isNotEmpty() && sync.length >= 8) asking = !asking }
        Text(if (sync.length < 8) "mark a sync field of 8 bits or more: a protocol is recognized by its sync word" else if (fields.isEmpty()) "name some fields first (SUGGEST, or drag over the field bar)"
            else if (known != null) "this burst is \"$known\" already: saving under that name replaces it" else "",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f), maxLines = 2)
    }
    if (asking) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        TxField(name, Palette.accent2, "PROTOCOL NAME", Modifier.weight(1f)) { name = it.take(40) }
        ToggleBox("SAVE", false, Palette.accent2) {
            val n = name.trim()
            if (n.isNotEmpty()) {
                Analyzer.saveProtocol(Protocol(n, sync, sel.auto.mod.name, sel.auto.coding.name, sel.auto.symUs,
                    fields.map { it.copy(from = it.from - base, to = it.to - base) }, if (base == 0) check else null))
                asking = false
            }
        }
    }
}

@Composable
private fun AlignedRows(al: BitAlignment, rows: List<AnBurst>, selId: Int, c: Color, fields: List<Field>, check: CheckFound?, onFields: (List<Field>) -> Unit) {
    val d = rememberDims()
    val pre = al.preamble; val sync = al.sync
    val start = dataStart(al)
    Text("${rows.size} frames · " + (if (pre != null) "preamble ${pre.second - pre.first} bits · " else "") + (if (sync != null) "sync ${sync.hex} · " else "") +
        "${al.fixedBits} fixed · ${al.changingBits} changing", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
    // the check, and whether it holds on every row
    if (check != null) {
        val holds = remember(al, check) { fromStart(al, start).all { r -> val p = Protocol("", "", "", "", 0.0, emptyList(), check); checkHolds(p, r, 0) == true } }
        Text("${check.name} over bytes ${check.from}–${check.to - 1} ${if (holds) "✓" else "✗"}", color = if (holds) Palette.ok else Palette.danger,
            fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
    }
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
    // the consensus a byte at a time from the data start: hex where all eight bits are fixed, dots where any change
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
    Text("BYTES FROM THE ${if (sync != null) "SYNC WORD" else if (pre != null) "END OF THE PREAMBLE" else "FIRST SHARED BIT"}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
    SelectionContainer { Text(bytes, fontFamily = Mono, fontSize = d.sp(10.5f)) }
    // the field being made: a column range dragged out on the bar, or a field tapped
    var selCols by remember(al) { mutableStateOf<Pair<Int, Int>?>(null) }
    var editing by remember(al) { mutableStateOf(-1) }
    var fName by remember { mutableStateOf("") }
    var fKind by remember { mutableStateOf(FieldKind.Data) }
    // the rows, scrolled sideways together under the field bar and a ruler: P over the preamble, S over the sync, a tick every byte
    val ruler = buildString {
        for (col in 0 until al.width) append(
            if (pre != null && col >= pre.first && col < pre.second) 'P' else if (sync != null && col >= sync.from && col < sync.to) 'S'
            else if (col >= start && (col - start) % 8 == 0) '|' else ' ')
    }
    val bitSize = d.sp(10f)
    val measurer = rememberTextMeasurer()
    val bitStyle = TextStyle(fontFamily = Mono, fontSize = bitSize)
    val charW = remember(measurer, bitSize) { measurer.measure("0".repeat(64), bitStyle).size.width / 64f }
    val density = LocalDensity.current
    val barW = with(density) { (charW * max(1, al.width)).toDp() }
    val fieldsNow by rememberUpdatedState(fields)
    Row(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Box(Modifier.height(d.dp(18f)))
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
            // the field bar: drag across it (or the ruler) to select columns, tap a field to rename, retype or delete it
            val sc = selCols
            val tm = rememberTextMeasurer()
            val small = TextStyle(fontFamily = Mono, fontSize = 8.sp, color = Color.White)
            Column(Modifier.pointerInput(al, charW) {
                fun colAt(px: Float) = (px / charW).toInt().coerceIn(0, max(0, al.width - 1))
                var from = -1
                detectHorizontalDragGestures(onDragStart = { p -> from = colAt(p.x); selCols = from to from + 1; editing = -1 }) { ch, _ ->
                    val to = colAt(ch.position.x)
                    selCols = min(from, to) to max(from, to) + 1
                    ch.consume()
                }
            }.pointerInput(al, charW) {
                detectTapGestures { p ->
                    val col = (p.x / charW).toInt() - start
                    val i = fieldsNow.indexOfFirst { col >= it.from && col < it.to }
                    if (i >= 0) { editing = i; selCols = null; fName = fieldsNow[i].name; fKind = fieldsNow[i].kind } else { editing = -1; selCols = null }
                }
            }) {
                Canvas(Modifier.width(barW).height(d.dp(18f))) {
                    val h = size.height
                    fields.forEachIndexed { i, f ->
                        val x0 = (start + f.from) * charW; val x1 = (start + f.to) * charW
                        val col = kindColor(f.kind)
                        drawRect(col.copy(alpha = if (i == editing) 1f else 0.75f), Offset(x0, 0f), Size(max(1f, x1 - x0 - 1f), h))
                        val t = tm.measure(f.name, small)
                        if (t.size.width + 4 < x1 - x0) drawText(t, topLeft = Offset(x0 + 2f, (h - t.size.height) / 2))
                    }
                    if (sc != null) {
                        drawRect(Color.White.copy(alpha = 0.25f), Offset(sc.first * charW, 0f), Size((sc.second - sc.first) * charW, h))
                        drawRect(Color.White, Offset(sc.first * charW, 0f), Size((sc.second - sc.first) * charW, h), style = Stroke(1.5f))
                    }
                }
                Text(ruler, color = Palette.accent2, fontFamily = Mono, fontSize = bitSize, maxLines = 1, softWrap = false)
            }
            for (r in al.rows) {
                val line = buildAnnotatedString {
                    append(" ".repeat(r.shift))
                    for (j in r.bits.indices) {
                        val st = al.state[r.shift + j]
                        val col = r.shift + j
                        val inSel = sc != null && col >= sc.first && col < sc.second
                        withStyle(SpanStyle(color = when (st) { 1 -> Palette.ink; 0 -> c; else -> Palette.muted.copy(alpha = 0.5f) }, fontWeight = if (st == 0) FontWeight.Bold else FontWeight.Normal,
                            background = if (inSel) Color.White.copy(alpha = 0.18f) else Color.Unspecified)) { append(r.bits[j]) }
                    }
                }
                Text(line, fontFamily = Mono, fontSize = bitSize, maxLines = 1, softWrap = false)
            }
        }
    }
    // naming the selection, or the field tapped
    val sc = selCols
    if (sc != null || editing >= 0) {
        val range = if (editing >= 0) fields.getOrNull(editing)?.let { "bits ${it.from}..${it.to} from the data start (${it.to - it.from})" }
            else sc?.let { "bits ${it.first - start}..${it.second - start} from the data start (${it.second - it.first})" }
        Column(Modifier.fillMaxWidth().panel(kindColor(fKind).copy(alpha = 0.7f)).padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
            Text((if (editing >= 0) "FIELD · " else "NEW FIELD · ") + (range ?: ""), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
            TxField(fName, kindColor(fKind), "NAME") { fName = it.take(32) }
            SegBar(FIELD_KINDS.map { KIND_LABEL.getValue(it) }, FIELD_KINDS.indexOf(fKind), kindColor(fKind), tints = FIELD_KINDS.map { kindColor(it) }) { fKind = FIELD_KINDS[it] }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox(if (editing >= 0) "SAVE FIELD" else "ADD FIELD", false, c, Modifier.fillMaxHeight()) {
                    val n = fName.trim().ifEmpty { fKind.key }
                    if (editing >= 0) onFields(fields.mapIndexed { i, f -> if (i == editing) f.copy(name = n, kind = fKind) else f })
                    else if (sc != null) onFields((fields.filter { it.to <= sc.first - start || it.from >= sc.second - start } + Field(n, fKind, sc.first - start, sc.second - start)).sortedBy { it.from })
                    selCols = null; editing = -1; fName = ""
                }
                if (editing >= 0) ToggleBox("DELETE", false, Palette.danger, Modifier.fillMaxHeight()) { onFields(fields.filterIndexed { i, _ -> i != editing }); editing = -1 }
                ToggleBox("CANCEL", false, c, Modifier.fillMaxHeight()) { selCols = null; editing = -1 }
            }
        }
    }
    if (fields.isNotEmpty()) {
        // the fields and the selected burst's values for them
        val me = al.rows.firstOrNull { rows[it.index].b.id == selId }
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            for (f in fields) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(f.name, color = kindColor(f.kind), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(130f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${f.kind.key} · ${f.from}..${f.to}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), modifier = Modifier.width(d.dp(110f)))
                if (me != null) Text(fieldValue(me.bits, start - me.shift, f), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
            }
        }
    }
    Text("fixed in plain · changing in color · dim where one frame only · tap IN to leave a frame out · drag the field bar to name columns",
        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
}

