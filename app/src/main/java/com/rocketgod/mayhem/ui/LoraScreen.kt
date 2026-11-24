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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
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
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.MeshField
import com.rocketgod.mayhem.core.lora.LoraEvent
import com.rocketgod.mayhem.core.lora.LoraHub
import com.rocketgod.mayhem.core.lora.LoraLocal
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
    val logSnap by Apps.loraLog.snapshot.collectAsState()
    // opens on the LOG: it fills first (every frame and burst), while nodes and chat take minutes
    var view by rememberSaveable { mutableIntStateOf(3) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var focusKey by remember { mutableIntStateOf(0) }
    var full by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(100); value = System.currentTimeMillis() } }.value

    val mapItems = nodes.mapNotNull { n -> val la = n.lat; val lo = n.lon; if (la != null && lo != null) GeoItem(n.key, la, lo, n.label, GeoItem.Kind.DEVICE) else null }
    val messages = events.filter { it.text != null }
    val picked = nodes.firstOrNull { it.key == sel }

    val wf = waterfallOn(MayhemApp.LORA, phoneDefault = true)
    // NODES, MAP, CHAT and the decode LOG: one switcher, the same inline and full screen
    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        Row(modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            SegBar(listOf("NODES · ${nodes.size}", "MAP · ${mapItems.size}", "CHAT · ${messages.size}", "LOG · ${logSnap.total}"), view, accent,
                Modifier.weight(1f).fillMaxHeight()) { view = it }
            if (withFull) IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
        }
    }

    @Composable
    fun stage(modifier: Modifier) {
        // each place the stage shows (inline, full screen) keeps its own scroll
        val cardGrid = rememberLazyGridState(); val chatList = rememberLazyListState()
        Box(modifier) {
            when (view) {
                // newest first, and kept on the newest while the reader is at the top; scrolled down, "↑ NEW" goes back
                0 -> if (nodes.isEmpty()) EmptyState("lora", Modifier.fillMaxSize().panel(), accent) else Box(Modifier.fillMaxSize()) {
                    val sorted = nodes.sortedByDescending { it.lastMs }
                    val follow = rememberFollowNewest(cardGrid, sorted.first().lastMs)
                    LazyVerticalGrid(GridCells.Adaptive(d.dp(if (full) 300f else 250f)), Modifier.fillMaxSize(), state = cardGrid,
                        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        items(sorted, key = { it.key }) { n ->
                            LoraNodeCard(n, accent, now, selected = sel == n.key) { sel = if (sel == n.key) null else n.key }
                        }
                    }
                    NewestPill(follow, cardGrid, sorted.count { it.lastMs > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
                }
                1 -> {
                    val pla = picked?.lat; val plo = picked?.lon
                    val focus = if (pla != null && plo != null) pla to plo else null
                    Box(Modifier.fillMaxSize()) {
                        GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = null, selected = sel, layers = GeoLayers(),
                            start = remember { mapStart(com.rocketgod.mayhem.core.Geo.fix.value) },
                            focus = focus, focusKey = focusKey, fitHome = true) { sel = it }
                        if (mapItems.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                            modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
                    }
                }
                3 -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "listening for LoRa frames…", total = logSnap.total, accent = accent)
                else -> if (messages.isEmpty()) EmptyState("loramsg", Modifier.fillMaxSize().panel(), accent) else Box(Modifier.fillMaxSize()) {
                    val follow = rememberFollowNewest(chatList, messages.first().id.toLong())
                    LazyColumn(Modifier.fillMaxSize(), state = chatList, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        items(messages, key = { it.id }) { e ->
                            LoraMessageRow(e, accent) { val k = e.nodeKey; if (k != null && nodes.any { it.key == k }) sel = k }
                        }
                    }
                    NewestPill(follow, chatList, messages.count { it.id > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
                }
            }
            if (picked != null) {
                LoraDetail(picked, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                    onMap = if (mapItems.any { it.id == picked.key }) ({ view = 1; focusKey++ }) else null,
                    onCards = if (view != 0) ({ view = 0 }) else null) { sel = null }
            }
        }
    }

    PacketFrame(accent, Apps.loraLog, tag = "MESH", title = "MESH RADIO TEXT", roomy = true, waterfall = wf,
        onWaterfall = { Apps.setWaterfall(MayhemApp.LORA, !wf) }, controls = {
        val wide = rate >= 10_000_000
        val narrowed by Apps.lora.narrowed.collectAsState()
        val midSpan = rate in 2_400_001 until LoraScanner.RATE
        // the area, the user's own channel and the saved picks all live in prefs: this redraws on each change
        val localTick by LoraLocal.version.collectAsState()
        var pickTick by remember { mutableIntStateOf(0) }
        var customOpen by remember { mutableStateOf(false) }
        val area = remember(localTick) { LoraLocal.area() }
        val local = remember(localTick, area) { LoraLocal.channels(area) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            RowLabel("AREA")
            LoraAreaMenu(accent, LoraLocal.picked, area, Modifier.weight(1f)) { LoraLocal.picked = it }
        }
        if (wide) {
            // LOCAL follows the area; a band tile is the user's own pick, kept until LOCAL is tapped again
            val localHz = remember(localTick, area) { LoraLocal.wideCenter(area) ?: LoraPlan.homeBand().center }
            val userWide = remember(pickTick, localTick) { SdrEngine.savedLong("lora_user_wide") }
            val tiles = listOf(Tile("LOCAL", LoraLocal.title(area), userWide == 0L && freq == localHz)) +
                LoraPlan.bands.map { Tile(it.title, it.sub, userWide != 0L && freq == it.center) }
            TileRow(tiles, accent, width = 132.dp) { i ->
                if (i == 0) { SdrEngine.saveLong("lora_user_wide", 0L); SdrEngine.tune(localHz) }
                else { val c = LoraPlan.bands[i - 1].center; SdrEngine.saveLong("lora_user_wide", c); SdrEngine.tune(c) }
                pickTick++
            }
        } else {
            // one channel at a time, the area's own first; the radio sits 300 kHz above it, clear of the spike at the center
            val chans = local.take(8)
            val tiles = chans.map { c -> Tile("%.3f".format(c.hz / 1e6), c.name.removePrefix("MeshCore ").removePrefix("Meshtastic "), freq - 300_000 == c.hz) }
            TileRow(tiles, accent, width = 132.dp) { i ->
                SdrEngine.saveLong("lora_user_narrow", chans[i].hz); SdrEngine.tune(chans[i].hz + 300_000); pickTick++
            }
        }
        val whyWide = Radio.rateWhy(LoraScanner.RATE)
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            RowLabel("SPAN")
            SegBar(listOf("2 MHz", if (midSpan) "${rate / 1_000_000} MHz" else "20 MHz"), if (rate > 2_400_000) 1 else 0, accent, Modifier.weight(1f),
                tints = listOf(null, if (whyWide.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null)) {
                if (it == 0) {
                    if (rate > 2_400_000) { SdrEngine.setRate(2_000_000); SdrEngine.tune(Apps.loraNarrowStart()) }
                } else gated(whyWide) {
                    if (rate < LoraScanner.RATE) { Apps.lora.narrowed.value = 0; SdrEngine.setRate(LoraScanner.RATE); SdrEngine.tune(Apps.loraWideStart()) }
                }()
            }
            IconBox(TuneIcon, "Your own channel", Modifier.fillMaxHeight()) { customOpen = true }
        }
        val mine = remember(localTick) { LoraLocal.custom }
        if (mine != null)
            Text("YOUR CHANNEL · %.4f MHz · %s · SF%d".format(mine.hz / 1e6, LoraHub.bwName(mine.bw), mine.sf),
                color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (narrowed != 0 && narrowed == rate)
            Text("Span narrowed to ${rate / 1_000_000} MHz: this device fell behind at a wider one. Tap 20 MHz to try again.",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (customOpen) LoraCustomDialog(accent) { customOpen = false }
    }, body = {
        // the log is a tab of its own (LOG), so the cards and the waterfall share the height between them
        Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            val by = nodes.groupingBy { it.proto }.eachCount()
            val parts = listOf("Meshtastic", "MeshCore", "LoRaWAN").mapNotNull { p -> by[p]?.let { "${p.uppercase()} $it" } }
            Text(if (parts.isEmpty()) (if (bursts > 0) "$bursts LoRa bursts heard · $frames frames" else "listening for LoRa") else parts.joinToString(" · ") + " · $frames frames",
                color = if (parts.isEmpty()) Palette.muted else accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            switcher(true, Modifier.fillMaxWidth())
            stage(Modifier.fillMaxWidth().weight(1f))
        }
    })
    // full screen: the title and its exit on top (the switcher crowded the exit off a phone's edge), the tabs below
    if (full) FullscreenPanel(listOf("LORA · ${nodes.size} NODES", "LORA · MAP", "LORA · CHAT", "LORA · LOG")[view], accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** The area picker: Automatic (where the device is) or any country or part of one with presets of its own. */
@Composable
private fun LoraAreaMenu(accent: Color, picked: String, area: String, modifier: Modifier, onPick: (String) -> Unit) {
    val d = rememberDims()
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(6.dp)
    val label = if (picked == "AUTO") "AUTOMATIC · " + LoraLocal.title(area).uppercase() else LoraLocal.title(picked).uppercase()
    Box(modifier) {
        Text("$label  ▾", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().clip(shape).border(1.dp, accent.copy(alpha = 0.7f), shape).clickable { open = true }
                .padding(horizontal = d.dp(12f), vertical = d.dp(7f)))
        androidx.compose.material3.DropdownMenu(open, onDismissRequest = { open = false }, modifier = Modifier.background(Palette.surface)) {
            for (a in LoraLocal.areas()) androidx.compose.material3.DropdownMenuItem(
                text = {
                    Text((if (a.id == picked) "✓ " else "") + a.title, color = if (a.id == picked) accent else Palette.ink, fontFamily = Mono,
                        fontWeight = if (a.id == picked) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(12f))
                },
                onClick = { open = false; if (a.id != picked) onPick(a.id) })
        }
    }
}

/** A channel of the user's own: frequency, bandwidth and spreading factor, listened to all the time while in span. */
@Composable
private fun LoraCustomDialog(accent: Color, onDone: () -> Unit) {
    val d = rememberDims()
    val now = remember { LoraLocal.custom }
    var mhz by remember { mutableStateOf(now?.let { "%.4f".format(java.util.Locale.US, it.hz / 1e6) } ?: "") }
    var bw by remember { mutableIntStateOf(LoraScanner.BWS.indexOf(now?.bw ?: 125_000).let { if (it < 0) 1 else it }) }
    var sf by remember { mutableIntStateOf((now?.sf ?: 7) - 7) }
    fun save() {
        val f = mhz.replace(',', '.').toDoubleOrNull() ?: return
        if (f < 400 || f > 1000) return
        LoraLocal.custom = LoraLocal.Custom(Math.round(f * 1e6), LoraScanner.BWS[bw], 7 + sf)
        onDone()
    }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDone) {
        val shape = RoundedCornerShape(d.dp(14f))
        Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.6f), shape).padding(d.dp(18f)),
            verticalArrangement = Arrangement.spacedBy(d.dp(12f))) {
            Text("YOUR OWN CHANNEL", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("MHz")
                androidx.compose.material3.OutlinedTextField(
                    value = mhz, onValueChange = { t -> mhz = t.filter { it.isDigit() || it == '.' || it == ',' }.take(10) }, singleLine = true,
                    placeholder = { Text("915.0000", fontFamily = Mono, color = Palette.muted) },
                    textStyle = androidx.compose.ui.text.TextStyle(fontFamily = Mono, fontWeight = FontWeight.Bold, color = Palette.ink, fontSize = d.sp(14f)),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal,
                        imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { save() }),
                    colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = accent.copy(alpha = 0.7f),
                        cursorColor = accent),
                    modifier = Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("BW")
                SegBar(LoraScanner.BWS.map { LoraHub.bwName(it) }, bw, accent, Modifier.weight(1f)) { bw = it }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("SF")
                SegBar((7..12).map { "$it" }, sf, accent, Modifier.weight(1f)) { sf = it }
            }
            SegBar(listOf("CLEAR", "SAVE"), -1, accent, Modifier.fillMaxWidth()) { i ->
                if (i == 0) { LoraLocal.custom = null; onDone() } else save()
            }
        }
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
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.94f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(node.label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f), maxLines = 1)
            Text("${node.proto.uppercase()} · ${node.kind}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        val all = listOf(MeshField("FIRST HEARD", LoraHub.clock(node.firstMs)), MeshField("LAST HEARD", LoraHub.clock(node.lastMs)),
            MeshField("PACKETS", "${node.packets}"), MeshField("FREQUENCY", LoraHub.mhz(node.hz)), MeshField("MODEM", node.modem)) + node.fields
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(all.map { it.name to it.value }, labelWidth = 96f, minColumn = 220f)
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
