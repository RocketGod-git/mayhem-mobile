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
import androidx.compose.ui.geometry.CornerRadius
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
import com.rocketgod.mayhem.core.apps.MeshDecoder
import com.rocketgod.mayhem.core.apps.MeshDevice
import com.rocketgod.mayhem.core.apps.MeshNet
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.min

/**
 * Meters: ERT meters, the hopping mesh networks and Gridstream meters, all heard at once. DEVICES shows every device
 * live; MAP puts the ones that broadcast a position where they say they are (only positions decoded off the air:
 * this device's own location is not used), with the mesh links between them. A tap on a card or a pin opens
 * everything decoded from that device.
 */
@Composable
fun MetersScreen(accent: Color) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val nets by Apps.mesh.nets.collectAsState()
    val devices by Apps.mesh.devices.collectAsState()
    val bursts by Apps.mesh.bursts.collectAsState()
    val links by Apps.mesh.links.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var focusKey by remember { mutableIntStateOf(0) }
    var full by remember { mutableStateOf(false) }
    // the cards run their clocks on between frames and flash as each one arrives
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(100); value = System.currentTimeMillis() } }.value

    val ertCount = devices.count { it.net == MeshDecoder.ERT }
    val mapItems = devices.mapNotNull { dv ->
        val la = dv.lat; val lo = dv.lon
        if (la != null && lo != null) GeoItem(dv.key, la, lo, dv.label, GeoItem.Kind.DEVICE) else null
    }
    val mapLayers = run {
        val byId = HashMap<Long, Pair<Double, Double>>()
        for (dv in devices) if (dv.net == MeshDecoder.GRIDSTREAM) { val la = dv.lat; val lo = dv.lon; if (la != null && lo != null) byId[dv.id] = la to lo }
        GeoLayers(lines = links.mapNotNull { k -> val a = byId[k.a]; val b = byId[k.b]; if (a != null && b != null) a to b else null })
    }
    val picked = devices.firstOrNull { it.key == sel }

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        Row(modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            SegBar(listOf("DEVICES · ${devices.size}", "MAP · ${mapItems.size}"), view, accent, Modifier.weight(1f).fillMaxHeight()) { view = it }
            if (withFull) IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
        }
    }

    /** The device cards or the map, with the selected device's details over them. */
    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            if (view == 0 && devices.isEmpty()) {
                EmptyState("ert", Modifier.fillMaxSize().panel(), accent)
            } else if (view == 0) {
                val sorted = devices.sortedWith(compareBy<MeshDevice> { it.firstMs }.thenBy { it.key })
                LazyVerticalGrid(GridCells.Adaptive(d.dp(if (full) 300f else 250f)), Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    items(sorted, key = { it.key }) { dv ->
                        MeshDeviceCard(dv, accent, freq, rate, now, selected = sel == dv.key) { sel = if (sel == dv.key) null else dv.key }
                    }
                }
            } else {
                val pla = picked?.lat; val plo = picked?.lon
                val focus = if (pla != null && plo != null) pla to plo else null
                Box(Modifier.fillMaxSize()) {
                    GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = null, selected = sel, layers = mapLayers,
                        start = remember { mapStart(com.rocketgod.mayhem.core.Geo.fix.value) },
                        focus = focus, focusKey = focusKey, fitHome = true) { sel = it }
                    if (mapItems.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                        modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
                }
            }
            if (picked != null) {
                MeshDetail(picked, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                    onMap = if (mapItems.any { it.id == picked.key }) ({ view = 1; focusKey++ }) else null,
                    onCards = if (view == 1) ({ view = 0 }) else null) { sel = null }
            }
        }
    }

    PacketFrame(accent, Apps.metersLog, tag = "METERS", title = "ERT · MESH · GRIDSTREAM", roomy = true, listWeight = 3.2f, controls = {
        PresetTiles(accent, listOf(Preset("904.0", "low", 904_000_000L), Preset("911.6", "lower mid", 911_600_000L), Preset("916.0", "mid", 916_000_000L),
            Preset("920.0", "upper mid", 920_000_000L), Preset("925.0", "high", 925_000_000L)))
        val why = Radio.rateWhy(MeshDecoder.RATE)
        val whyWide = Radio.rateWhy(MeshDecoder.WIDE)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            RowLabel("SPAN")
            SegBar(listOf("2 MHz", "4.2 MHz", "19.2 MHz"),
                when (rate) { MeshDecoder.WIDE -> 2; MeshDecoder.RATE -> 1; 2_000_000 -> 0; else -> -1 }, accent, Modifier.weight(1f),
                tints = listOf(null, if (why.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null, if (whyWide.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null)) {
                when (it) {
                    0 -> SdrEngine.setRate(2_000_000)
                    1 -> gated(why) { SdrEngine.setRate(MeshDecoder.RATE) }()
                    else -> gated(whyWide) { SdrEngine.setRate(MeshDecoder.WIDE) }()
                }
            }
        }
    }, list = {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                if (nets.isEmpty() && ertCount == 0) Text(if (bursts > 0) "$bursts bursts heard, no network locked yet" else "watching the band for meters",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                for (n in nets.take(3)) NetLine(n, accent)
                if (ertCount > 0) Text("ERT · $ertCount meters", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
            }
            switcher(true, Modifier.fillMaxWidth())
            stage(Modifier.fillMaxWidth().weight(1f))
        }
    })
    if (full) FullscreenPanel(if (view == 0) "METERS · ${devices.size} DEVICES" else "METERS · MAP", accent, onClose = { full = false },
        actions = { switcher(false, Modifier.width(d.dp(320f))) }) {
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

@Composable
private fun NetLine(n: MeshNet, accent: Color) {
    val d = rememberDims()
    val span = if (n.hiHz > n.loHz) "%.2f–%.2f MHz".format(n.loHz / 1e6, n.hiHz / 1e6) else "%.3f MHz".format(n.loHz / 1e6)
    val name = if (n.sync == MeshDecoder.GRIDSTREAM) "GRIDSTREAM" else "NETWORK ${MeshDecoder.syncName(n.sync)}"
    Text("$name · ${n.frames} frames · ${n.channels.size} channels · $span", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold,
        fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Everything decoded from one device, field by field, with MAP when it has a position. */
@Composable
private fun MeshDetail(dev: MeshDevice, accent: Color, modifier: Modifier, onMap: (() -> Unit)?, onCards: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    val kind = when (dev.net) {
        MeshDecoder.ERT -> "ERT METER"
        MeshDecoder.GRIDSTREAM -> "GRIDSTREAM METER"
        else -> "MESH NODE · ${MeshDecoder.syncName(dev.net)}"
    }
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.94f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(dev.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(kind, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(dev.fields.map { it.name to it.value }, labelWidth = 96f, minColumn = 220f)
                if (dev.net == MeshDecoder.GRIDSTREAM && dev.wanVotes.size > 1) {
                    Text("position heard ${dev.wanVotes.values.maxOrNull() ?: 0}× of ${dev.wanVotes.values.sum()} beacons (the most-heard one is shown)",
                        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                }
            }
        }
    }
}

/**
 * One transmitter, live: its id, its hop clock running on between frames, a trail of where its last hops landed
 * across the span (newest at the bottom, brightest), its signal over the recent frames, and the last frame. The
 * card lights up as each frame arrives.
 */
@Composable
private fun MeshDeviceCard(dev: MeshDevice, accent: Color, centerHz: Long, rate: Int, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = if (dev.lastMs > 0) (now - dev.lastMs) / 1000.0 else 1e9
    val flash = max(0.0, 1 - age / 0.7).toFloat()
    // bursty senders go quiet for a while between bursts: a device stays lit for a minute, and once found it stays
    // on the board, dimmed only a little
    val live = age < 60
    val shape = RoundedCornerShape(d.dp(14f))
    val ert = dev.net == MeshDecoder.ERT
    val gs = dev.net == MeshDecoder.GRIDSTREAM
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.8f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f + 0.14f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, accent.copy(alpha = if (selected) 1f else 0.22f + 0.7f * flash), shape)
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        // header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(dev.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (dev.label.length > 2) 18f else 30f))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(if (ert) "ERT METER" else if (gs) "GRIDSTREAM METER" else "TRANSMITTER", color = Palette.ink, fontFamily = Mono,
                    fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text(if (ert) "${dev.ertKind} · ${dev.commodity}" else if (gs) (if (dev.lat != null) "POSITION ON AIR" else "LANDIS+GYR") else "NET ${MeshDecoder.syncName(dev.net)}",
                    color = if (dev.lat != null) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
                if (dev.address >= 0) Text("NODE ID %06X · %d".format(dev.address, dev.address), color = accent, fontFamily = Mono,
                    fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1)
            }
            Box(Modifier.size(d.dp(9f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(when { live -> "LIVE"; dev.lastMs == 0L -> "ADDRESSED"; age < 120 -> "${age.toInt()} s ago"; else -> "${(age / 60).toInt()} min ago" },
                color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        // clock row (consumption for an ERT meter)
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            if (ert) {
                Text("${dev.cons}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
                Text(if (dev.cons > dev.consFirst) "+${dev.cons - dev.consFirst} SINCE HEARD" else "CONSUMPTION", color = Palette.muted, fontFamily = Mono,
                    fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)), maxLines = 1)
                Text("${dev.frames} readings", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
            } else {
                val c = dev.clockAt(now)
                if (gs) {
                    val up = dev.uptimeAt(now)
                    Text(if (c >= 0) "%06.2f".format(c / 100.0) else "---.--", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
                    Text(if (up >= 0) "HOP s · UP %dd %02dh %02dm %02ds".format(up / 86400, up / 3600 % 24, up / 60 % 60, up % 60) else "HOP s",
                        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)), maxLines = 1)
                } else {
                    Text(if (c >= 0) "%04X".format(c) else "----", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
                    Text(if (dev.clockRate != 0.0) "HOP CLOCK %+.0f/s".format(dev.clockRate) else "HOP CLOCK", color = Palette.muted, fontFamily = Mono,
                        fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)), maxLines = 1)
                }
                Text("%d · %.1f/s".format(dev.frames, dev.perSecond()), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold,
                    fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
            }
        }
        if (!ert) HopTrail(dev, accent, centerHz, rate, now, Modifier.fillMaxWidth().height(d.dp(46f)))
        if (ert) ConsSpark(dev, accent, Modifier.fillMaxWidth().height(d.dp(34f))) else SnrSpark(dev, accent, Modifier.fillMaxWidth().height(d.dp(24f)))
        Text(dev.lastHex, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Each recent hop at its frequency across the span; time runs down the strip, joined by a faint path. */
@Composable
private fun HopTrail(dev: MeshDevice, accent: Color, centerHz: Long, rate: Int, now: Long, modifier: Modifier) {
    val back = Palette.paper; val grid = Palette.line
    Canvas(modifier) {
        val w = size.width; val h = size.height
        drawRoundRect(back.copy(alpha = 0.55f), cornerRadius = CornerRadius(6.dp.toPx()))
        for (k in 1 until 8) { val x = w * k / 8; drawLine(grid.copy(alpha = 0.35f), Offset(x, 2f), Offset(x, h - 2f), 0.5.dp.toPx()) }
        val hops = dev.hops; val n = hops.size
        if (n == 0) return@Canvas
        val lo = centerHz - rate / 2.0; val span = max(rate, 1).toDouble()
        val pts = hops.mapIndexed { i, hp ->
            val fx = ((hp.hz - lo) / span).coerceIn(0.0, 1.0).toFloat()
            val y = if (n == 1) h / 2 else 4f + (h - 8f) * i / (n - 1)
            Offset(w * fx, y)
        }
        val path = Path().apply { moveTo(pts[0].x, pts[0].y); for (p in pts.drop(1)) lineTo(p.x, p.y) }
        drawPath(path, accent.copy(alpha = 0.22f), style = Stroke(1.dp.toPx()))
        for ((i, p) in pts.withIndex()) {
            val a = 0.15f + 0.85f * (i + 1) / n
            drawCircle(accent.copy(alpha = a), (if (i == n - 1) 3.6f else 2.2f).dp.toPx(), p)
        }
        val fresh = max(0f, 1 - (now - dev.lastMs) / 900f)
        val r = (4 + 9 * (1 - fresh)).dp.toPx()
        drawCircle(accent.copy(alpha = 0.8f * fresh), r, pts.last(), style = Stroke(1.5.dp.toPx()))
    }
}

/** An ERT meter's consumption across its readings, as a rising line. */
@Composable
private fun ConsSpark(dev: MeshDevice, accent: Color, modifier: Modifier) {
    val v = dev.consHistory
    if (v.size < 2) {
        Box(modifier, contentAlignment = Alignment.CenterStart) {
            Text("waiting for the next reading", color = Palette.ink.copy(alpha = 0.6f), fontFamily = Mono, fontSize = 9.sp)
        }
        return
    }
    Canvas(modifier) {
        val w = size.width; val h = size.height
        val lo = v.min(); val hi = v.max(); val span = max(hi - lo, 1L).toDouble()
        val pts = v.mapIndexed { i, c -> Offset(w * i / (v.size - 1), h - h * ((c - lo) / span).toFloat()) }
        val path = Path().apply { moveTo(pts[0].x, pts[0].y); for (p in pts.drop(1)) lineTo(p.x, p.y) }
        drawPath(path, accent.copy(alpha = 0.9f), style = Stroke(1.6.dp.toPx()))
        for (p in pts) drawCircle(accent, 2.dp.toPx(), p)
    }
}

/** Signal of the recent frames, as a filled line. */
@Composable
private fun SnrSpark(dev: MeshDevice, accent: Color, modifier: Modifier) {
    val v = dev.snr
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
        if (v.size >= 2) Text("+${v.last()} dB", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 9.sp,
            modifier = Modifier.align(Alignment.TopEnd))
    }
}
