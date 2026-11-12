package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.r433.Devices
import com.rocketgod.mayhem.core.r433.HeardDevice
import com.rocketgod.mayhem.core.r433.R433Protocol
import com.rocketgod.mayhem.core.r433.fmtValue
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

/**
 * Car keys, remotes, tire sensors, weather and alarms: every burst in the span is tuned to on its own and offered to
 * every decoder at once, and each thing heard gets a card. Twin of the web app's Devices view.
 */
@Composable
fun DevicesScreen(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val live by Devices.proc.devices.collectAsState()
    val rep by Devices.proc.report.collectAsState()
    val hop by Devices.hop.collectAsState()
    var showProtocols by remember { mutableStateOf(false) }
    var paused by remember { mutableStateOf<List<HeardDevice>?>(null) }
    var filter by rememberSaveable { mutableStateOf(Devices.Filter.ALL) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    val heard = paused ?: live
    // ages and the live dots run on between readings, and a card flashes as a reading arrives
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(200); value = System.currentTimeMillis() } }.value

    // The band walk; tuning goes through the normal path, so the waterfall follows.
    LaunchedEffect(hop) { while (hop) { delay(Devices.DWELL_MS); Devices.nextBand() } }

    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    val level by SdrEngine.levelDb.collectAsState()
    AdaptivePane(
        // the card keeps its height; the waterfall and the device cards split the rest evenly
        share = true,
        face = {
            FreqCard(accent, tag = "DEVICES", title = if (rep.span > 0) "${rep.protocols} PROTOCOLS · ${rep.decoded} DECODED" else "KEYS · REMOTES · SENSORS",
                freq = freq, meter = level / 40f, left = "SIGNAL +%.0f dB".format(level), right = if (rep.span > 0) "${rep.followed} bursts followed" else "listening",
                lamp = {
                    when {
                        hop -> Lamp("HOPPING", Palette.accent2, blink = true)
                        heard.isNotEmpty() -> Lamp("${heard.size} HEARD", Palette.ok)
                        else -> Lamp("LISTENING", Palette.accent2, blink = true)
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
            // 315 and 433.92 are 119 MHz apart, further than any radio here spans, so HOP takes turns
            TileRow(Devices.BANDS.map { (label, hz) -> Tile(label, "MHz", freq == hz) }, accent, width = 84.dp) { Devices.pickFreq(Devices.BANDS[it].second) }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                val filters = Devices.Filter.entries
                SegBar(filters.map { f -> "${f.label} ${heard.count { Devices.shows(f, it) }}" }, filters.indexOf(filter), accent,
                    Modifier.weight(1f).fillMaxHeight()) { filter = filters[it]; sel = null }
                ToggleBox("HOP", hop, accent, Modifier.fillMaxHeight()) { Devices.setHop(!hop) }
            }
            if (rep.span > 0) {
                val lo = (freq - rep.span / 2) / 1e6; val hi = (freq + rep.span / 2) / 1e6
                Text("WATCHING %.2f–%.2f MHz".format(lo, hi) + (if (rep.channels > 0) " · TUNED TO ${rep.channels} BURST${if (rep.channels == 1) "" else "S"} NOW" else ""),
                    color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${rep.followed} bursts followed · ${rep.decoded} decoded · ${rep.protocols} sensor protocols and every car key and remote run on each" +
                    (if (rep.badChecksum > 0) " · ${rep.badChecksum} near misses" else ""), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2,
                    overflow = TextOverflow.Ellipsis)
            } else Text("listening…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                SegBar(listOf("${heard.size} DEVICE${if (heard.size == 1) "" else "S"}", "${Devices.protocols.size} PROTOCOLS"), if (showProtocols) 1 else 0, accent,
                    Modifier.weight(1f).fillMaxHeight()) { showProtocols = it == 1 }
                ToggleBox(if (paused != null) "RESUME" else "PAUSE", paused != null, accent, Modifier.fillMaxHeight()) { paused = if (paused == null) live else null }
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { Devices.proc.clear(); sel = null; if (paused != null) paused = emptyList() }
            }
        }
        if (showProtocols) ProtocolList(Devices.protocols, Modifier.fillMaxWidth().weight(1f))
        else DeviceCards(heard, filter, sel, now, Modifier.fillMaxWidth().weight(1f)) { sel = it }
    }
}

/** Each kind's color, as on the web app's cards. */
private fun kindColor(k: Devices.Kind): Color = when (k) {
    Devices.Kind.CAR_KEY -> Color(0xFFFFB020)
    Devices.Kind.REMOTE -> Color(0xFFB48CFF)
    Devices.Kind.TIRE -> Color(0xFF3FD0C9)
    Devices.Kind.WEATHER -> Color(0xFF5FB3FF)
    Devices.Kind.SECURITY -> Color(0xFFFF6B6B)
    Devices.Kind.METER -> Color(0xFF8FD14F)
    Devices.Kind.SENSOR -> Palette.accent
}

/** Each kind's glyph (the web app's, with its circles and rounded rectangle written as arcs), in a 24-unit box. */
private val KIND_GLYPH: Map<Devices.Kind, String> = mapOf(
    Devices.Kind.CAR_KEY to "M3.5 12a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0M12.5 12H21v3M18 12v2.5",
    Devices.Kind.REMOTE to "M10 3h4a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-4a3 3 0 0 1 -3 -3V6a3 3 0 0 1 3 -3zM10.4 8.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M10 14h4M10 17h4",
    Devices.Kind.TIRE to "M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0 -17 0M8.5 12a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5",
    Devices.Kind.WEATHER to "M10 4v10.5a3.5 3.5 0 1 0 4 0V4a2 2 0 0 0-4 0zM12 9v7",
    Devices.Kind.SECURITY to "M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z",
    Devices.Kind.METER to "M4 16a8 8 0 1 1 16 0M12 16l4-5",
    Devices.Kind.SENSOR to "M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14",
)
private val glyphPaths = HashMap<Devices.Kind, Path>()

@Composable
private fun KindGlyph(k: Devices.Kind, c: Color) {
    val d = rememberDims()
    Box(Modifier.size(d.dp(34f)).background(c.copy(alpha = 0.16f), RoundedCornerShape(d.dp(10f))), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(d.dp(22f))) {
            val path = glyphPaths.getOrPut(k) { PathParser().parsePathString(KIND_GLYPH.getValue(k)).toPath() }
            val s = size.minDimension / 24f
            scale(s, s, pivot = Offset.Zero) {
                drawPath(path, c, style = Stroke(width = 1.7f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
    }
}

/** The cards, newest first, with the selected one's details over them. */
@Composable
private fun DeviceCards(heard: List<HeardDevice>, filter: Devices.Filter, sel: String?, now: Long, modifier: Modifier, onSel: (String?) -> Unit) {
    val d = rememberDims()
    val shown = heard.filter { Devices.shows(filter, it) }.sortedByDescending { it.lastSeen }
    Box(modifier) {
        if (shown.isEmpty()) {
            Box(Modifier.fillMaxSize().panel(), contentAlignment = Alignment.Center) {
                Text(if (heard.isNotEmpty()) "nothing of this kind yet" else "nothing yet. Press a key fob or a remote near the antenna, or wait: sensors report every thirty to sixty seconds",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(d.dp(14f)))
            }
        } else {
            LazyVerticalGrid(GridCells.Adaptive(d.dp(230f)), Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                items(shown, key = { it.key }) { h -> DeviceCard(h, now, sel == h.key) { onSel(if (sel == h.key) null else h.key) } }
            }
        }
        val picked = heard.firstOrNull { it.key == sel }
        if (picked != null) {
            val k = Devices.kind(picked)
            FieldDetail(detailFields(picked), picked.data["id"]?.let { fmtValue(it) } ?: picked.model, "${k.label} · ${picked.model}", kindColor(k),
                Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                history = picked.history.asReversed().map { r ->
                    Devices.clock(r.at) to (Devices.historyLine(picked, r.data) + if (r.hz > 0) " · ${Devices.mhz(r.hz)}" else "")
                }) { onSel(null) }
        }
    }
}

/** One thing heard: its kind and glyph, what it just said in big type, where, how often, and whether it is live. */
@Composable
private fun DeviceCard(h: HeardDevice, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val k = Devices.kind(h)
    val c = kindColor(k)
    val age = now - h.lastSeen
    val live = age < Devices.liveMs(k)
    val flash = max(0f, 1 - age / 2500f)
    val (big, sub) = Devices.headline(h, k)
    val id = h.data["id"]?.let { fmtValue(it) } ?: ""
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.75f).clip(shape)
        .background(Brush.linearGradient(listOf(c.copy(alpha = 0.10f + 0.16f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, c.copy(alpha = if (selected) 1f else 0.25f + 0.7f * flash), shape)
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            KindGlyph(k, c)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(k.label, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), letterSpacing = 2.sp, maxLines = 1)
                Text(h.model, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (id.isNotEmpty()) Text("ID $id", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.size(d.dp(8f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(if (live) "LIVE" else Devices.ago(age), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(big, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(20f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
            Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text("${h.count}×", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(if (h.hz > 0) Devices.mhz(h.hz) else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(if (live) Devices.ago(age) else Devices.clock(h.lastSeen), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
    }
}

/** Everything a device sent, then where it was heard, how it was read, and when. */
private fun detailFields(h: HeardDevice): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    for ((k, v) in h.data) { if (k == "model") continue; out.add(k.replace('_', ' ').uppercase() to Devices.value(k, v)) }
    if (h.hz > 0) out.add("FREQUENCY" to "${Devices.mhz(h.hz)} (${if (h.offsetHz >= 0) "+" else "-"}${"%.0f".format(abs(h.offsetHz) / 1e3)} kHz from the dial)")
    out.add("MODULATION" to if (h.family == "sensor") (if (h.fsk) "FSK (frequency shift)" else "OOK (on-off)") else "OOK or FSK, both are tried")
    out.add("DECODER" to when (h.family) { "key" -> "ProtoPirate car keys"; "sensor" -> "rtl_433 protocol ${h.num} · ${h.what}"; else -> "Mayhem sub-GHz" })
    out.add("HEARD" to "${h.count} time${if (h.count == 1) "" else "s"} · first ${Devices.clock(h.firstSeen)} · last ${Devices.clock(h.lastSeen)}")
    if (h.num in Devices.doubtful) out.add("NOTE" to "this protocol has no checksum, so nothing in the frame proves the reading")
    return out
}

/** Everything the receiver can recognize, so "nothing there" can be told from "not supported". */
@Composable
private fun ProtocolList(protocols: List<R433Protocol>, modifier: Modifier) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(6f), vertical = d.dp(4f)), state = state) {
            item {
                Text("Every burst in the span is tuned to on its own, wherever it lands, and offered to every decoder at once: car keys " +
                    "(ProtoPirate), gate and garage remotes, tire sensors, weather stations, alarms and hundreds more (rtl_433, listed here). " +
                    "A key that hops between two frequencies is followed on both. 315 and 433.92 are 119 MHz apart, further than any radio " +
                    "here spans, so HOP takes turns. Tire sensors (Schrader, Ford, GM, Toyota and dozens more) repeat about once a minute " +
                    "and wake up when a car moves: 315 in the US, 433.92 in Europe. Tap a card for everything it sent.",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(horizontal = d.dp(4f), vertical = d.dp(6f)))
            }
            itemsIndexed(protocols, key = { _, p -> p.num }) { i, p ->
                Row(Modifier.fillMaxWidth()
                    .background(if (i % 2 == 0) Color.Transparent else Palette.panel.copy(alpha = 0.6f), RoundedCornerShape(3.dp))
                    .padding(vertical = d.dp(3f), horizontal = d.dp(4f))) {
                    Text("${p.num}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.width(d.dp(34f)))
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = if (p.doubtful) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                        Text(buildString {
                            append(p.what.ifEmpty { "—" })
                            append(" · ${p.coding}")
                            if (p.bands.isNotEmpty()) append(" · ${p.bands.joinToString(", ") { fmtValue(it) }} MHz")
                            if (p.doubtful) append(" · no checksum, readings unverified")
                        }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                }
            }
        }
    }
}
