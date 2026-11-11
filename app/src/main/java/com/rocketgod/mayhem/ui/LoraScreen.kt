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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.MeshField
import com.rocketgod.mayhem.core.lora.LoraEvent
import com.rocketgod.mayhem.core.lora.LoraHub
import com.rocketgod.mayhem.core.lora.LoraNode
import com.rocketgod.mayhem.core.lora.LoraPlan
import com.rocketgod.mayhem.core.lora.LoraScanner
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

/**
 * LoRa: every Meshtastic, MeshCore and LoRaWAN node heard across the span, each on its own live card; MAP puts the
 * ones that broadcast a position where they say they are; MESSAGES is the text traffic in order. A tap on a card or
 * a pin opens everything decoded from that node.
 */
@Composable
fun LoraScreen(accent: Color) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val nodes by Apps.lora.nodes.collectAsState()
    val events by Apps.lora.events.collectAsState()
    val bursts by Apps.lora.bursts.collectAsState()
    val frames by Apps.lora.frames.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var focusKey by remember { mutableIntStateOf(0) }
    var full by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(100); value = System.currentTimeMillis() } }.value

    val mapItems = nodes.mapNotNull { n -> val la = n.lat; val lo = n.lon; if (la != null && lo != null) GeoItem(n.key, la, lo, n.label, GeoItem.Kind.DEVICE) else null }
    val messages = events.filter { it.text != null }
    val picked = nodes.firstOrNull { it.key == sel }

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        Row(modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            SegBar(listOf("NODES · ${nodes.size}", "MAP · ${mapItems.size}", "CHAT · ${messages.size}"), view, accent, Modifier.weight(1f).fillMaxHeight()) { view = it }
            if (withFull) IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
        }
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            when (view) {
                0 -> LazyVerticalGrid(GridCells.Adaptive(d.dp(if (full) 300f else 250f)), Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    items(nodes.sortedByDescending { it.lastMs }, key = { it.key }) { n ->
                        LoraNodeCard(n, accent, now, selected = sel == n.key) { sel = if (sel == n.key) null else n.key }
                    }
                }
                1 -> {
                    val pla = picked?.lat; val plo = picked?.lon
                    val focus = if (pla != null && plo != null) pla to plo else null
                    Box(Modifier.fillMaxSize()) {
                        GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = null, selected = sel, layers = GeoLayers(),
                            focus = focus, focusKey = focusKey, fitHome = true) { sel = it }
                        if (mapItems.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                            modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    items(messages, key = { it.id }) { e ->
                        LoraMessageRow(e, accent) { val k = e.nodeKey; if (k != null && nodes.any { it.key == k }) sel = k }
                    }
                }
            }
            if (picked != null) {
                LoraDetail(picked, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                    onMap = if (mapItems.any { it.id == picked.key }) ({ view = 1; focusKey++ }) else null,
                    onCards = if (view != 0) ({ view = 0 }) else null) { sel = null }
            }
        }
    }

    PacketFrame(accent, Apps.loraLog, tag = "LORA", title = "MESHTASTIC · MESHCORE · LORAWAN", roomy = true, listWeight = 3.2f, controls = {
        val wide = rate >= 10_000_000
        val narrowed by Apps.lora.narrowed.collectAsState()
        val midSpan = rate in 2_400_001 until LoraScanner.RATE
        if (wide) {
            PresetTiles(accent, LoraPlan.bands.map { Preset(it.title, it.sub, it.center) }, width = 132.dp)
        } else {
            // one channel at a time: the radio sits 300 kHz above it, clear of the spike at the center
            PresetTiles(accent, listOf(Preset("906.875", "LongFast US", 906_875_000L), Preset("910.525", "MeshCore US", 910_525_000L),
                Preset("869.525", "LongFast EU", 869_525_000L), Preset("869.618", "MeshCore EU", 869_618_000L),
                Preset("916.575", "MeshCore ANZ", 916_575_000L), Preset("927.875", "MeshCore", 927_875_000L)), shift = 300_000L)
        }
        val whyWide = Radio.rateWhy(LoraScanner.RATE)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            RowLabel("SPAN")
            SegBar(listOf("2 MHz", if (midSpan) "${rate / 1_000_000} MHz" else "20 MHz"), if (rate > 2_400_000) 1 else 0, accent, Modifier.weight(1f),
                tints = listOf(null, if (whyWide.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null)) {
                if (it == 0) {
                    if (rate > 2_400_000) { SdrEngine.setRate(2_000_000); SdrEngine.tune((LoraPlan.bands.firstOrNull { b -> b.center == freq }?.narrow ?: LoraPlan.homeBand().narrow) + 300_000) }
                } else gated(whyWide) {
                    if (rate < LoraScanner.RATE) { Apps.lora.narrowed.value = 0; SdrEngine.setRate(LoraScanner.RATE); SdrEngine.tune(LoraPlan.bands.minByOrNull { b -> abs(b.center - freq) }?.center ?: LoraPlan.homeBand().center) }
                }()
            }
        }
        if (narrowed != 0 && narrowed == rate)
            Text("Span narrowed to ${rate / 1_000_000} MHz: this device fell behind at a wider one. Tap 20 MHz to try again.",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }, list = {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            val by = nodes.groupingBy { it.proto }.eachCount()
            val parts = listOf("Meshtastic", "MeshCore", "LoRaWAN").mapNotNull { p -> by[p]?.let { "${p.uppercase()} $it" } }
            Text(if (parts.isEmpty()) (if (bursts > 0) "$bursts LoRa bursts heard · $frames frames" else "listening for LoRa") else parts.joinToString(" · ") + " · $frames frames",
                color = if (parts.isEmpty()) Palette.muted else accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            switcher(true, Modifier.fillMaxWidth())
            stage(Modifier.fillMaxWidth().weight(1f))
        }
    })
    if (full) FullscreenPanel(listOf("LORA · ${nodes.size} NODES", "LORA · MAP", "LORA · CHAT")[view], accent, onClose = { full = false },
        actions = { switcher(false, Modifier.width(d.dp(380f))) }) {
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** One text message: who, where it went, when, and what it said. */
@Composable
private fun LoraMessageRow(event: LoraEvent, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.panel).border(1.dp, accent.copy(alpha = 0.25f), shape).clickable { onClick() }.padding(d.dp(9f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            Text(event.from ?: "?", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
            Text(event.proto.uppercase() + (event.channel?.let { " · $it" } ?: ""), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(LoraHub.clock(event.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
        SelectionContainer { Text(event.text ?: "", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(12f)) }
    }
}

/** Everything decoded from one node, field by field, its recent messages, with MAP when it has a position. */
@Composable
private fun LoraDetail(node: LoraNode, accent: Color, modifier: Modifier, onMap: (() -> Unit)?, onCards: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    var tall by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(d.dp(14f))
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.94f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(node.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f), maxLines = 1)
            Text("${node.proto.uppercase()} · ${node.kind}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
            ToggleBox(if (tall) "LESS" else "MORE", false, accent, Modifier.fillMaxHeight()) { tall = !tall }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        val all = listOf(MeshField("FIRST HEARD", LoraHub.clock(node.firstMs)), MeshField("LAST HEARD", LoraHub.clock(node.lastMs)),
            MeshField("PACKETS", "${node.packets}"), MeshField("FREQUENCY", LoraHub.mhz(node.hz)), MeshField("MODEM", node.modem)) + node.fields
        val scroll = rememberScrollState()
        SelectionContainer {
            Column(Modifier.fillMaxWidth().heightIn(max = d.dp(if (tall) 420f else 170f)).scrollGlow(scroll).verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                for (f in all) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text(f.name, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp,
                        modifier = Modifier.width(d.dp(96f)))
                    Text(f.value, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                }
                for (t in node.texts.reversed()) Text("“$t”", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
            }
        }
    }
}

/** One node, live: its name, what it is, how it was last heard, its signal over the recent packets. */
@Composable
private fun LoraNodeCard(node: LoraNode, accent: Color, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = (now - node.lastMs) / 1000.0
    val flash = max(0.0, 1 - age / 0.9).toFloat()
    // nodes speak every few minutes: lit for ten, and once heard a node stays on the board
    val live = age < 600
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.8f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f + 0.14f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, accent.copy(alpha = if (selected) 1f else 0.22f + 0.7f * flash), shape)
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(node.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (node.label.length > 6) 16f else 24f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(node.proto.uppercase(), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text(node.kind, color = if (node.lat != null) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.size(d.dp(9f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(when { age < 60 -> "${max(0, age.toInt())} s ago"; age < 3600 -> "${(age / 60).toInt()} min ago"; else -> "${(age / 3600).toInt()} h ago" },
                color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        val nm = node.name
        if (nm != null && nm != node.label) Text(nm, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${node.packets}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(20f))
            Text(if (node.packets == 1) "PACKET" else "PACKETS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text("%.3f · %s".format(node.hz / 1e6, node.modem.substringBefore(" · CR")), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(9f), maxLines = 1, modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        LoraSpark(node.snr, accent, Modifier.fillMaxWidth().height(d.dp(22f)))
        Text(node.last, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** Signal of the recent packets, as a filled line. */
@Composable
private fun LoraSpark(v: List<Int>, accent: Color, modifier: Modifier) {
    if (v.isEmpty()) { Box(modifier); return }
    Box(modifier) {
        if (v.size >= 2) Canvas(Modifier.fillMaxSize()) {
            val lo = (v.min() - 3).toDouble(); val hi = (v.max() + 3).toDouble()
            val w = size.width; val h = size.height
            val pts = v.mapIndexed { i, s -> Offset(w * i / (v.size - 1), h - h * ((s - lo) / max(hi - lo, 1.0)).toFloat()) }
            val line = Path().apply { moveTo(pts[0].x, pts[0].y); for (p in pts.drop(1)) lineTo(p.x, p.y) }
            val fill = Path().apply { addPath(line); lineTo(w, h); lineTo(0f, h); close() }
            drawPath(fill, Brush.verticalGradient(listOf(accent.copy(alpha = 0.35f), accent.copy(alpha = 0.02f)), 0f, h))
            drawPath(line, accent.copy(alpha = 0.9f), style = Stroke(1.4.dp.toPx()))
        }
        val last = v.last()
        Text((if (last >= 0) "+" else "") + "$last dB", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 9.sp,
            modifier = Modifier.align(Alignment.TopEnd))
    }
}
