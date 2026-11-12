package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.AdsbStore
import com.rocketgod.mayhem.core.AircraftInfo
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.AcarsDecoder
import com.rocketgod.mayhem.core.apps.AcarsPlane
import com.rocketgod.mayhem.core.apps.BleDevice
import com.rocketgod.mayhem.core.apps.BlePos
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.kindLabel
import com.rocketgod.mayhem.core.apps.labelMeaning
import com.rocketgod.mayhem.core.apps.normReg
import com.rocketgod.mayhem.model.Aircraft
import kotlinx.coroutines.delay
import java.util.Locale
import kotlin.math.max

/** `now`, `12 s ago`, `3 min ago`, `2 h ago` (the BLE and ACARS cards' ages). */
private fun bleAgo(ms: Long): String = when {
    ms < 2_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s ago"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    else -> "${ms / 3_600_000} h ago"
}

/** Live while it keeps advertising: phones and tags send several times a second, so ten quiet seconds means gone. */
private const val BLE_LIVE_MS = 10_000L

/** The card stage's switcher: the cards or the log, with PAUSE and CLEAR beside it. */
@Composable
private fun StageBar(labels: List<String>, view: Int, accent: Color, paused: Boolean, onView: (Int) -> Unit, onPause: () -> Unit, onClear: () -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(8f), bottom = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically) {
        SegBar(labels, view, accent, Modifier.weight(1f).fillMaxHeight()) { onView(it) }
        ToggleBox(if (paused) "RESUME" else "PAUSE", paused, accent, Modifier.fillMaxHeight()) { onPause() }
        IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { onClear() }
    }
}

/** A red warning line: a tracker alert on a card, in the banner, or with its advice in the panel. */
@Composable
private fun BleWarn(text: String, big: Boolean = false, modifier: Modifier = Modifier) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    Text(text, color = Palette.danger, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (big) 11f else 10f), letterSpacing = 1.sp,
        modifier = modifier.fillMaxWidth().clip(shape).background(Palette.danger.copy(alpha = 0.12f))
            .then(if (big) Modifier.border(1.dp, Palette.danger, shape) else Modifier)
            .padding(horizontal = d.dp(if (big) 10f else 8f), vertical = d.dp(if (big) 8f else 5f)))
}

/** The card style Meters and Devices use: an accent wash that flashes as something arrives, a thicker edge when picked. */
private fun Modifier.liveCard(accent: Color, flash: Float, selected: Boolean, alert: Boolean, live: Boolean, d: Dims, onClick: () -> Unit): Modifier {
    val shape = RoundedCornerShape(d.dp(14f))
    return this.fillMaxWidth().alpha(if (live) 1f else 0.8f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f + 0.14f * flash), Palette.panel)))
        .border(if (alert || selected) 2.dp else (1 + 1.4f * flash).dp,
            if (alert) Palette.danger else accent.copy(alpha = if (selected) 1f else 0.22f + 0.7f * flash), shape)
        .clickable { onClick() }.padding(d.dp(11f))
}

/** The live dot and its word: LIVE, else how long ago. */
@Composable
private fun LiveDot(live: Boolean, flash: Float, ago: String) {
    val d = rememberDims()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Box(Modifier.size(d.dp(9f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
        Text(if (live) "LIVE" else ago, color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
            fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
    }
}

/**
 * A card's full detail over the cards (the Meters and Devices panel): a title, what it is, [actions] and ✕, then
 * [content]. As tall as its content, up to the space over the cards; only past that does the whole panel scroll.
 */
@Composable
private fun CardPanel(title: String, kind: String, accent: Color, modifier: Modifier, edge: Color = accent, actions: (@Composable RowScope.() -> Unit)? = null,
                      onClose: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.95f))
        .background(Brush.linearGradient(listOf(edge.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, edge.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(title, color = edge, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
            Text(kind, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            actions?.invoke(this)
            ToggleBox("✕", false, edge, Modifier.fillMaxHeight()) { onClose() }
        }
        content()
    }
}

/** A heading inside a panel. */
@Composable
private fun PanelCaption(text: String, accent: Color) {
    val d = rememberDims()
    Text(text, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, modifier = Modifier.padding(top = d.dp(4f)))
}

/** A signal history as a filled line (the Meters SNR spark). */
@Composable
private fun RssiSpark(v: List<Int>, accent: Color, modifier: Modifier) {
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
    }
}

// ---- BLE RX: one card per advertiser, the raw log one tap away -------------------------------------------------------

/**
 * The BLE screen: DEVICES shows one card per device (name, maker, type, signal, packets, last heard), a tap opens every
 * field and its raw advertisements; LOG is the decoder's line per packet. A tracker-type device that stays with you
 * raises an alert on its card and in the banner.
 */
@Composable
fun BtleScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val freq by SdrEngine.freqHz.collectAsState()
    val logCount by Apps.btleLog.count.collectAsState()
    val snap by Apps.btleLog.snapshot.collectAsState()
    val fix by Geo.fix.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var held by remember { mutableStateOf<List<BleDevice>?>(null) }
    var heldLog by remember { mutableStateOf<List<String>?>(null) }
    // where you are, so a tracker still heard after you have moved is flagged too; only when location is already allowed
    LaunchedEffect(Unit) { Geo.start(ctx) }
    LaunchedEffect(fix) { Apps.blePos = fix?.let { BlePos(it.first, it.second) } }
    // ages and live dots run on between packets; the cards redraw at most four times a second
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    // a fresh copy when a packet has come in (or each second, for the alerts' minutes), at most four times a second
    val live = produceState(Apps.bleDevices()) {
        var seen = -1L; var at = 0L
        while (true) {
            val t = Apps.bleTick.value; val n = System.currentTimeMillis()
            if (t != seen || n - at >= 1000) { seen = t; at = n; value = Apps.bleDevices() }
            delay(250)
        }
    }.value
    val devs = held ?: live
    val alerts = live.filter { it.alert.isNotEmpty() }
    val picked = live.firstOrNull { it.mac == sel }

    PacketFrame(accent, Apps.btleLog, tag = "BLE", title = "ADVERTISING", tunable = false, emptyKey = "btle",
        lamp = {
            when {
                alerts.isNotEmpty() -> Lamp("${alerts.size} TRACKER${if (alerts.size == 1) "" else "S"}", Palette.danger)
                live.isNotEmpty() -> Lamp("${live.size} DEVICE${if (live.size == 1) "" else "S"}", Palette.ok)
                else -> Lamp("LISTENING", Palette.accent2, blink = true)
            }
        },
        controls = {
            val chans = intArrayOf(37, 38, 39)
            TileRow(chans.map { ch -> val hz = BtleDecoder.channelFreq(ch); Tile("CH $ch", "${hz / 1_000_000} MHz", freq == hz) }, accent, width = 104.dp) { i ->
                val ch = chans[i]; Apps.btle.channel = ch; SdrEngine.tune(BtleDecoder.channelFreq(ch))
            }
            if (alerts.isNotEmpty()) BleWarn(if (alerts.size == 1) "⚠ ${alerts[0].alert}" else "⚠ ${alerts.size} TRACKERS ARE STAYING NEAR YOU", big = true)
        },
        body = {
            StageBar(listOf("DEVICES ${live.size}", "LOG $logCount"), view, accent, held != null || heldLog != null, onView = { view = it },
                onPause = { if (held == null) { held = live; heldLog = snap.lines } else { held = null; heldLog = null } },
                onClear = { Apps.bleClear(); sel = ""; if (held != null) { held = emptyList(); heldLog = emptyList() } })
            if (view == 1) {
                LogList(heldLog ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (heldLog == null) snap.total else null, accent = accent, emptyKey = "btle")
            } else Box(Modifier.fillMaxWidth().weight(1f)) {
                val note = "One card per device, by its address: the maker from its manufacturer ID, the type from what it advertises (Find My, Tile, SmartTag, " +
                    "Find Hub, iBeacon, Eddystone, Fast Pair, AirPods, phones, watches). A tracker that stays near you for 20 minutes, or is still there after " +
                    "you move 500 m (with location allowed), is flagged. Phones and tags change their random address every 15 minutes or so, so one phone can " +
                    "show up as several cards over time."
                if (devs.isEmpty()) BoxWithConstraints(Modifier.fillMaxSize()) {
                    val stageH = maxHeight
                    // the empty state fills the stage, and keeps its room on a short phone (then the stage scrolls to the note)
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        EmptyState("btle", Modifier.fillMaxWidth().heightIn(min = stageH * 0.75f).panel(), accent)
                        AppNote(note)
                    }
                } else LazyVerticalGrid(GridCells.Adaptive(d.dp(250f)), Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    items(devs, key = { it.mac }) { dv -> BleCard(dv, accent, now, sel == dv.mac) { sel = if (sel == dv.mac) "" else dv.mac } }
                    item(key = "note", span = { GridItemSpan(maxLineSpan) }) { AppNote(note) }
                }
                if (picked != null) BleDetail(picked, accent, now, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f))) { sel = "" }
            }
        })
}

@Composable
private fun BleCard(dv: BleDevice, accent: Color, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = now - dv.lastMs
    val live = age < BLE_LIVE_MS
    val flash = max(0f, 1 - age / 700f)
    val kind = kindLabel(dv.kind)
    Column(Modifier.liveCard(accent, flash, selected, dv.alert.isNotEmpty(), live, d, onClick), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            val tag = if (dv.tracker) Palette.accent2 else accent
            Text(kind.uppercase(Locale.US), color = tag, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, lineHeight = d.sp(10f),
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = d.dp(92f)).border(1.dp, tag.copy(alpha = if (dv.tracker) 0.6f else 0.5f), RoundedCornerShape(6.dp))
                    .padding(horizontal = d.dp(5f), vertical = d.dp(3f)))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(dv.name.ifEmpty { kind }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 0.5.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(dv.maker.ifEmpty { "unknown maker" } + if (dv.name.isNotEmpty()) " · $kind" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            LiveDot(live, flash, bleAgo(age))
        }
        if (dv.alert.isNotEmpty()) BleWarn("⚠ ${dv.alert}")
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${dv.rssi.lastOrNull() ?: "—"} dB", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("SIGNAL", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text("${dv.count} packets", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        RssiSpark(dv.rssi, accent, Modifier.fillMaxWidth().height(d.dp(24f)))
        Text("${dv.mac} · ${if (dv.random) "random" else "public"} · first ${bleAgo(now - dv.firstMs)}", color = Palette.muted, fontFamily = Mono,
            fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Every field from a device and its raw advertisements, newest first. */
@Composable
private fun BleDetail(dv: BleDevice, accent: Color, now: Long, modifier: Modifier, onClose: () -> Unit) {
    val d = rememberDims()
    val kind = kindLabel(dv.kind)
    val edge = if (dv.alert.isNotEmpty()) Palette.danger else accent
    val more = buildList {
        add("First heard" to "${clockOf(dv.firstMs)} · ${bleAgo(now - dv.firstMs)}")
        add("Last heard" to "${clockOf(dv.lastMs)} · ${bleAgo(now - dv.lastMs)}")
        if (dv.firstPos != null) add("Moved with you" to "${Math.round(dv.movedM)} m")
    }
    CardPanel(dv.name.ifEmpty { kind }, "${dv.maker.ifEmpty { "UNKNOWN MAKER" }} · ${kind.uppercase(Locale.US)}", accent, modifier, edge = edge, onClose = onClose) {
        if (dv.alert.isNotEmpty()) BleWarn("⚠ ${dv.alert}. Look for it in your bag, car or clothes, or check it with a tracker-finder app.")
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(dv.fields.map { it.name to it.value } + more, labelWidth = 112f, minColumn = 320f)
                PanelCaption("RAW ADVERTISEMENTS · newest first · ${dv.history.size} kept", accent)
                val narrow = d.widthDp < 560
                for (h in dv.history.asReversed()) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    Text(clockOf(h.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, modifier = Modifier.width(d.dp(if (narrow) 62f else 70f)))
                    Text("CH ${h.ch}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, modifier = Modifier.width(d.dp(36f)))
                    Text("${Math.round(h.db)} dB", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, modifier = Modifier.width(d.dp(42f)))
                    if (!narrow) Text(h.pduType, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, modifier = Modifier.width(d.dp(110f)))
                    Text(h.raw, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

// ---- ACARS: one card per aircraft, its messages in the panel, a link to the same aircraft in ADS-B ------------------

/** The same aircraft in the ADS-B list: by ICAO address (from a US registration), the registration looked up for an
 *  ADS-B aircraft, or the flight number against its callsign. */
private fun acarsAdsbMatch(p: AcarsPlane, aircraft: List<Aircraft>): Aircraft? {
    val reg = normReg(p.reg); val fl = p.flight.replace(Regex("\\s"), "").uppercase(Locale.US)
    return aircraft.firstOrNull { a ->
        (p.icao.isNotEmpty() && a.icao.uppercase(Locale.US) == p.icao) ||
            (reg.isNotEmpty() && normReg(AircraftInfo.get(a.icao)?.reg ?: "") == reg) ||
            (fl.isNotEmpty() && (a.flight ?: "").replace(Regex("\\s"), "").uppercase(Locale.US) == fl)
    }
}

/** ACARS: one card per aircraft (by registration, else flight); a tap opens every message it sent or got. */
@Composable
fun AcarsScreen(accent: Color) {
    val d = rememberDims()
    val shift = AcarsDecoder.LO_SHIFT
    val tick by Apps.acarsTick.collectAsState()
    val logCount by Apps.acarsLog.count.collectAsState()
    val snap by Apps.acarsLog.snapshot.collectAsState()
    val aircraft by AdsbStore.flow.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var held by remember { mutableStateOf<List<AcarsPlane>?>(null) }
    var heldLog by remember { mutableStateOf<List<String>?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(1000); value = System.currentTimeMillis() } }.value
    val live = remember(tick) { Apps.acarsPlaneList() }
    val planes = held ?: live
    val picked = live.firstOrNull { it.key == sel }

    PacketFrame(accent, Apps.acarsLog, tag = "ACARS", title = "AIRCRAFT DATALINK", roomy = true, shift = shift, emptyKey = "acars",
        lamp = { if (live.isNotEmpty()) Lamp("${live.size} AIRCRAFT", Palette.ok) else Lamp("LISTENING", Palette.accent2, blink = true) },
        controls = {
            PresetTiles(accent, listOf(Preset("131.550", "US", 131_550_000L), Preset("131.525", "EU", 131_525_000L), Preset("131.725", "EU 2", 131_725_000L),
                Preset("131.450", "JP", 131_450_000L), Preset("130.025", "US 2", 130_025_000L)), shift = shift)
        },
        body = {
            StageBar(listOf("AIRCRAFT ${live.size}", "LOG $logCount"), view, accent, held != null || heldLog != null, onView = { view = it },
                onPause = { if (held == null) { held = live; heldLog = snap.lines } else { held = null; heldLog = null } },
                onClear = { Apps.acarsClear(); sel = ""; if (held != null) { held = emptyList(); heldLog = emptyList() } })
            if (view == 1) {
                LogList(heldLog ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (heldLog == null) snap.total else null, accent = accent, emptyKey = "acars")
            } else Box(Modifier.fillMaxWidth().weight(1f)) {
                val note = "One card per aircraft (by registration, else flight), with every message it sent or got in its panel: registration, flight, label " +
                    "and text, CRC checked. ADS-B links to the same aircraft when ADS-B has seen it (by its ICAO address, its registration or its flight)."
                if (planes.isEmpty()) BoxWithConstraints(Modifier.fillMaxSize()) {
                    val stageH = maxHeight
                    // the empty state fills the stage, and keeps its room on a short phone (then the stage scrolls to the note)
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        EmptyState("acars", Modifier.fillMaxWidth().heightIn(min = stageH * 0.75f).panel(), accent)
                        AppNote(note)
                    }
                } else LazyVerticalGrid(GridCells.Adaptive(d.dp(250f)), Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    items(planes, key = { it.key }) { p -> AcarsCard(p, acarsAdsbMatch(p, aircraft) != null, accent, now, sel == p.key) { sel = if (sel == p.key) "" else p.key } }
                    item(key = "note", span = { GridItemSpan(maxLineSpan) }) { AppNote(note) }
                }
                if (picked != null) {
                    val ads = acarsAdsbMatch(picked, aircraft)
                    AcarsDetail(picked, ads, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                        onAdsb = if (ads != null) ({ Apps.adsbPick = ads.icao; Apps.open(MayhemApp.ADSB) }) else null) { sel = "" }
                }
            }
        })
}

@Composable
private fun AcarsCard(p: AcarsPlane, onAdsb: Boolean, accent: Color, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = now - p.lastMs
    val live = age < 120_000
    val flash = max(0f, 1 - age / 700f)
    val last = p.msgs.firstOrNull() ?: return
    val what = labelMeaning(last.label)
    val sub = listOfNotNull(p.icao.takeIf { it.isNotEmpty() }?.let { "ICAO $it" }, if (onAdsb) "ON ADS-B" else null).joinToString(" · ")
    Column(Modifier.liveCard(accent, flash, selected, false, live, d, onClick), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(p.reg.ifEmpty { p.flight }, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(if (p.flight.isNotEmpty() && p.reg.isNotEmpty()) "FLIGHT ${p.flight}" else if (p.reg.isNotEmpty()) "NO FLIGHT NUMBER" else "NO REGISTRATION",
                    color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (sub.isNotEmpty()) Text(sub, color = if (onAdsb) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            LiveDot(live, flash, bleAgo(age))
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${p.count}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("MESSAGE${if (p.count == 1) "" else "S"} · LAST ${last.label}${if (what.isNotEmpty()) " ${what.uppercase(Locale.US)}" else ""}", color = Palette.muted,
                fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text(last.mhz, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        Text(last.text.ifEmpty { "(no text)" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** An aircraft's fields, the ADS-B link when ADS-B has it, and every message newest first. */
@Composable
private fun AcarsDetail(p: AcarsPlane, ads: Aircraft?, accent: Color, modifier: Modifier, onAdsb: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val fields = listOf(
        "Registration" to p.reg.ifEmpty { "—" }, "Flight" to p.flight.ifEmpty { "—" }, "ICAO" to p.icao.ifEmpty { "—" }, "Messages" to p.count.toString(),
        "First heard" to clockOf(p.firstMs), "Last heard" to clockOf(p.lastMs),
        "ADS-B" to (ads?.let { a -> a.icao.uppercase(Locale.US) + (a.flight?.trim()?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "") + (a.altBaro?.let { " · $it ft" } ?: "") }
            ?: "not seen (open ADS-B to look for it)"),
    )
    val kind = listOfNotNull(p.flight.takeIf { it.isNotEmpty() }?.let { "FLIGHT $it" }, p.icao.takeIf { it.isNotEmpty() }?.let { "ICAO $it" }).joinToString(" · ").ifEmpty { "ACARS" }
    CardPanel(p.reg.ifEmpty { p.flight }, kind, accent, modifier,
        actions = if (onAdsb != null) ({ ToggleBox("ADS-B", false, accent, Modifier.fillMaxHeight()) { onAdsb() } }) else null, onClose = onClose) {
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(fields, labelWidth = 112f, minColumn = 320f)
                PanelCaption("MESSAGES · newest first", accent)
                for (m in p.msgs) Column(Modifier.fillMaxWidth().padding(top = d.dp(2f))) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
                    Row(Modifier.padding(top = d.dp(5f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text(clockOf(m.ms), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
                        val mean = labelMeaning(m.label)
                        Text("${if (m.down) "↓ from the aircraft" else "↑ to the aircraft"} · ${m.label}${if (mean.isNotEmpty()) " $mean" else ""} · blk ${m.blk}" +
                            (if (m.msn.isNotEmpty()) " · #${m.msn}" else "") + " · ${m.mhz}" + (if (m.crcOk) "" else " · CRC?"),
                            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                    if (m.text.isNotEmpty()) Text(m.text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(top = d.dp(3f)))
                }
            }
        }
    }
}
