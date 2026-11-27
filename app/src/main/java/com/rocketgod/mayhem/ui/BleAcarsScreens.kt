package com.rocketgod.mayhem.ui

import com.rocketgod.mayhem.core.Units
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
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import com.rocketgod.mayhem.core.apps.AcarsMsg
import com.rocketgod.mayhem.core.apps.LatLon
import com.rocketgod.mayhem.core.apps.MsgInsight
import com.rocketgod.mayhem.core.apps.PlaneInsight
import com.rocketgod.mayhem.core.apps.VDL2_CHANNELS
import com.rocketgod.mayhem.core.apps.VDL_LINK_MS
import com.rocketgod.mayhem.core.apps.VdlAircraft
import com.rocketgod.mayhem.core.apps.VdlStation
import com.rocketgod.mayhem.core.apps.acarsFor
import com.rocketgod.mayhem.core.apps.airlineOf
import com.rocketgod.mayhem.core.apps.kindLabelOf
import com.rocketgod.mayhem.core.apps.msgInsight
import com.rocketgod.mayhem.core.apps.planeInsight
import com.rocketgod.mayhem.core.apps.FlightNums
import com.rocketgod.mayhem.core.apps.numChips
import com.rocketgod.mayhem.core.apps.xidSummary
import com.rocketgod.mayhem.core.uat.Airports
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
private fun StageBar(labels: List<String>, view: Int, accent: Color, paused: Boolean, onView: (Int) -> Unit, onPause: () -> Unit, onClear: () -> Unit,
                     waterfall: Boolean? = null, onWaterfall: () -> Unit = {}) {
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

    // BLE advertisements are sub-millisecond hops across 2.4 GHz: a phone gives the waterfall's room to the cards
    val wf = waterfallOn(MayhemApp.BTLE, phoneDefault = false)
    PacketFrame(accent, Apps.btleLog, tag = "BLUETOOTH", title = "BLUETOOTH DEVICES", tunable = false, emptyKey = "btle", waterfall = wf,
        onWaterfall = { Apps.setWaterfall(MayhemApp.BTLE, !wf) },
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
                onClear = { Apps.bleClear(); sel = ""; if (held != null) { held = emptyList(); heldLog = emptyList() } },
            )
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
        if (dv.firstPos != null) add("Moved with you" to Units.fmtDist(dv.movedM / 1000))
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

// ---- ACARS and VDL2: one card per aircraft (VDL2: by ICAO address, ACARS or not), a map, the activity, the log ----

/** One aircraft as the cards, the map and the panel show it: an ACARS record, a VDL2 address, or both. */
private data class AcRow(val key: String, val reg: String, val flight: String, val icao: String, val firstMs: Long, val lastMs: Long,
                         val msgs: List<AcarsMsg>, val vdl: VdlAircraft?, val ins: PlaneInsight, val airline: String) {
    val title: String get() = reg.ifEmpty { flight.ifEmpty { icao } }
}

/** Each message's reading, kept until the airports or home change. */
private object AcReads {
    private val cache = HashMap<AcarsMsg, MsgInsight>()
    private var version = ""
    @Synchronized fun of(m: AcarsMsg, home: LatLon?, loaded: Boolean): MsgInsight {
        val v = "$loaded|${home?.let { "%.1f,%.1f".format(Locale.US, it.lat, it.lon) } ?: ""}"
        if (v != version || cache.size > 20_000) { cache.clear(); version = v }
        return cache.getOrPut(m) { msgInsight(m, if (loaded) Apps.airportLookup else null, home) }
    }
}

private fun acRows(vdl: Boolean, planes: List<AcarsPlane>, vdlAc: List<VdlAircraft>, read: (AcarsMsg) -> MsgInsight): List<AcRow> {
    fun mk(key: String, reg: String, flight: String, icao: String, first: Long, last: Long, msgs: List<AcarsMsg>, v: VdlAircraft?) =
        AcRow(key, reg, flight, icao, first, last, msgs, v, planeInsight(msgs, read), airlineOf(flight))
    if (!vdl) return planes.map { mk(it.key, it.reg, it.flight, it.icao, it.firstMs, it.lastMs, it.msgs, null) }
    val byKey = planes.associateBy { it.key }
    return vdlAc.map { a ->
        val p = acarsFor(a, byKey)
        mk("A:${a.addr}", a.reg.ifEmpty { p?.reg ?: "" }, a.flight.ifEmpty { p?.flight ?: "" }, a.addr, a.firstMs, a.lastMs, p?.msgs ?: emptyList(), a)
    }
}

/** The same aircraft in the ADS-B list: VDL2 by its own address; ACARS by the ICAO address a US registration gives,
 *  the registration looked up for an ADS-B aircraft, or the flight number against its callsign. */
private fun acarsAdsbMatch(r: AcRow, aircraft: List<Aircraft>): Aircraft? {
    if (r.vdl != null) return aircraft.firstOrNull { it.icao.uppercase(Locale.US) == r.icao }
    val reg = normReg(r.reg); val fl = r.flight.replace(Regex("\\s"), "").uppercase(Locale.US)
    return aircraft.firstOrNull { a ->
        (r.icao.isNotEmpty() && a.icao.uppercase(Locale.US) == r.icao) ||
            (reg.isNotEmpty() && normReg(AircraftInfo.get(a.icao)?.reg ?: "") == reg) ||
            (fl.isNotEmpty() && (a.flight ?: "").replace(Regex("\\s"), "").uppercase(Locale.US) == fl)
    }
}

private data class AcWhere(val lat: Double, val lon: Double, val ms: Long)

/** Where an aircraft is: only the newest position its own messages gave (the radio hears one band at a time, so
 *  nothing here comes from ADS-B). */
private fun acWhere(r: AcRow): AcWhere? = r.ins.pos?.let { AcWhere(it.lat, it.lon, r.ins.posMs) }
private fun acSnr(n: Int) = "${if (n >= 0) "+" else ""}$n dB"
private fun mhzOf(hz: Long) = "%.3f".format(Locale.US, hz / 1e6)

/** The ACARS channels the presets offer (counted even before anything is heard on them). */
private val ACARS_CHANNELS = listOf("131.550", "131.525", "131.725", "131.450", "130.025")

/** ACARS (and VDL2, which carries ACARS): one card per aircraft, a map, the activity and the log. VDL2 keys aircraft
 *  by their ICAO address (ACARS or not) and lists the ground stations. A tap opens every message, read into plain words. */
@Composable
fun AcarsScreen(accent: Color, vdl: Boolean = false) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val shift = if (vdl) 0L else AcarsDecoder.LO_SHIFT
    val app = if (vdl) MayhemApp.VDL2 else MayhemApp.ACARS
    val plog = if (vdl) Apps.vdl2Log else Apps.acarsLog
    val key = if (vdl) "vdl2" else "acars"
    val tick by (if (vdl) Apps.vdl2Tick else Apps.acarsTick).collectAsState()
    val logCount by plog.count.collectAsState()
    val snap by plog.snapshot.collectAsState()
    val aircraft by AdsbStore.flow.collectAsState()
    val fix by Geo.fix.collectAsState()
    val airportsLoaded by Airports.loaded.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var focusKey by remember { mutableIntStateOf(0) }
    var held by remember { mutableStateOf<List<AcRow>?>(null) }
    var heldLog by remember { mutableStateOf<List<String>?>(null) }
    // where you are (the map's home, and positions that cannot be this aircraft's), and the airport list
    LaunchedEffect(Unit) { Geo.start(ctx); Airports.load(ctx) }
    val home = fix?.let { LatLon(it.first, it.second) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(1000); value = System.currentTimeMillis() } }.value
    val stations = remember(tick, vdl, airportsLoaded) { if (vdl) Apps.vdl2Stations() else emptyList() }
    val live = remember(tick, vdl, airportsLoaded, home) {
        acRows(vdl, if (vdl) Apps.vdl2PlaneList() else Apps.acarsPlaneList(), if (vdl) Apps.vdl2Aircraft() else emptyList()) { AcReads.of(it, home, airportsLoaded) }
    }
    val rows = held ?: live
    val adsOf = remember(rows, aircraft) { rows.associate { it.key to acarsAdsbMatch(it, aircraft) } }
    val where = remember(rows) { rows.mapNotNull { r -> acWhere(r)?.let { r.key to it } }.toMap() }
    val placedStations = stations.filter { it.airport.isNotEmpty() && Apps.airportLookup(it.airport) != null }
    val pickedStation = if (sel.startsWith("G:")) stations.firstOrNull { "G:${it.addr}" == sel } else null
    val picked = if (pickedStation == null) live.firstOrNull { it.key == sel } else null

    val wf = waterfallOn(app, phoneDefault = true)
    PacketFrame(accent, plog, tag = "FLIGHT MSGS", title = "AIRLINE MESSAGES", roomy = true, shift = shift, emptyKey = key, waterfall = wf,
        onWaterfall = { Apps.setWaterfall(app, !wf) },
        lamp = { if (live.isNotEmpty()) Lamp("${live.size} AIRCRAFT", Palette.ok) else Lamp("LISTENING", Palette.accent2, blink = true) },
        controls = {
            SegBar(listOf("ACARS 131", "VDL2 136.975"), if (vdl) 1 else 0, accent) { i -> if ((i == 1) != vdl) Apps.open(if (i == 1) MayhemApp.VDL2 else MayhemApp.ACARS) }
            if (!vdl) PresetTiles(accent, listOf(Preset("131.550", "US", 131_550_000L), Preset("131.525", "EU", 131_525_000L), Preset("131.725", "EU 2", 131_725_000L),
                Preset("131.450", "JP", 131_450_000L), Preset("130.025", "US 2", 130_025_000L)), shift = shift)
        },
        body = {
            StageBar(listOf("AIRCRAFT ${live.size}", "MAP ${where.size + placedStations.size}", "STATS", "LOG $logCount"), view, accent, held != null || heldLog != null, onView = { view = it },
                onPause = { if (held == null) { held = live; heldLog = snap.lines } else { held = null; heldLog = null } },
                onClear = { if (vdl) Apps.vdl2Clear() else Apps.acarsClear(); sel = ""; if (held != null) { held = emptyList(); heldLog = emptyList() } },
            )
            if (view == 3) {
                LogList(heldLog ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (heldLog == null) snap.total else null, accent = accent, emptyKey = key)
            } else Box(Modifier.fillMaxWidth().weight(1f)) {
                val note = if (vdl) "VDL Mode 2, the digital link that carries most airline ACARS now: every channel from 136.10 to 136.975 MHz at once, " +
                    "each frame checked. One card per aircraft by its ICAO address (exact, so ADS-B links straight to it), ACARS or not, with its " +
                    "registration and flight once it sends ACARS; ground stations below, placed at the airport their XIDs name. MAP plots the aircraft " +
                    "where their own messages put them, with lines to the stations they work."
                else "One card per aircraft (by registration, else flight), each message read into plain words: out, off, on and in times, positions, " +
                    "weather, ATIS, free text, engine data. MAP plots them where their own messages put them. ADS-B links " +
                    "to the same aircraft when ADS-B has seen it (by its ICAO address, its registration or its flight)."
                when (view) {
                    1 -> AcarsMap(rows, stations, where, vdl, accent, fix, sel, focusKey, now) { id -> sel = if (sel == id.removePrefix("dest:")) "" else id.removePrefix("dest:") }
                    2 -> AcarsStatsView(vdl, rows.size, accent, now, tick)
                    else -> if (rows.isEmpty() && stations.isEmpty()) BoxWithConstraints(Modifier.fillMaxSize()) {
                        val stageH = maxHeight
                        // the empty state fills the stage, and keeps its room on a short phone (then the stage scrolls to the note)
                        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                            EmptyState(key, Modifier.fillMaxWidth().heightIn(min = stageH * 0.75f).panel(), accent)
                            AppNote(note)
                        }
                    } else LazyVerticalGrid(GridCells.Adaptive(d.dp(250f)), Modifier.fillMaxSize(),
                        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        items(rows, key = { it.key }) { r -> AcarsCard(r, adsOf[r.key], accent, now, sel == r.key) { sel = if (sel == r.key) "" else r.key } }
                        if (vdl) {
                            item(key = "gs-head", span = { GridItemSpan(maxLineSpan) }) {
                                Column { PanelCaption("GROUND STATIONS · ${stations.size}", Palette.accent2)
                                    if (stations.isEmpty()) Text("none heard yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f)) }
                            }
                            items(stations, key = { "G:${it.addr}" }) { g -> StationCard(g, now, sel == "G:${g.addr}") { sel = if (sel == "G:${g.addr}") "" else "G:${g.addr}" } }
                        }
                        item(key = "note", span = { GridItemSpan(maxLineSpan) }) { AppNote(note) }
                    }
                }
                val onMap: () -> Unit = { view = 1; focusKey++ }
                if (picked != null) {
                    val ads = adsOf[picked.key] ?: acarsAdsbMatch(picked, aircraft)
                    AcarsDetail(picked, ads, stations, accent, now, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                        onMap = if (acWhere(picked) != null && view != 1) onMap else null,
                        onAdsb = if (ads != null) ({ Apps.adsbPick = ads.icao; Apps.open(MayhemApp.ADSB) }) else null) { sel = "" }
                } else if (pickedStation != null) StationDetail(pickedStation, live, now, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                    onMap = if (placedStations.contains(pickedStation) && view != 1) onMap else null) { sel = "" }
            }
        })
}

/** A small outlined word: a message kind, a phase, an airport. */
@Composable
private fun AcChip(text: String, c: Color = Palette.ink, edge: Color = Palette.line) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.border(1.dp, edge, RoundedCornerShape(6.dp)).padding(horizontal = d.dp(5f), vertical = d.dp(2f)))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AcChips(chips: List<Pair<String, Int>>, accent: Color) {
    val d = rememberDims()
    if (chips.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for ((t, k) in chips) when (k) {
            1 -> AcChip(t, accent, accent.copy(alpha = 0.7f))
            2 -> AcChip(t, Palette.accent2, Palette.accent2.copy(alpha = 0.7f))
            else -> AcChip(t)
        }
    }
}

@Composable
private fun AcarsCard(r: AcRow, ads: Aircraft?, accent: Color, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = now - r.lastMs
    val live = age < 120_000
    val flash = max(0f, 1 - age / 700f)
    val last = r.msgs.firstOrNull(); val v = r.vdl; val li = r.ins.last; val nums = numChips(r.ins.nums)
    val head = when {
        r.airline.isNotEmpty() -> r.airline.uppercase(Locale.US) + if (r.flight.isNotEmpty()) " · ${r.flight}" else ""
        r.flight.isNotEmpty() && (r.reg.isNotEmpty() || v != null) -> "FLIGHT ${r.flight}"
        r.reg.isNotEmpty() -> "NO FLIGHT NUMBER"
        v != null -> "NO ACARS YET"
        else -> "NO REGISTRATION"
    }
    val sub = listOfNotNull(r.ins.orig.takeIf { it.isNotEmpty() }?.let { "$it → ${r.ins.dest}" }, r.icao.takeIf { it.isNotEmpty() }?.let { "ICAO $it" }, if (ads != null) "ON ADS-B" else null).joinToString(" · ")
    val count = v?.frames ?: r.msgs.size
    val what = if (v != null) "FRAME${if (count == 1) "" else "S"} · ${v.acars} ACARS · ${acSnr(v.snr)}" else "MESSAGE${if (count == 1) "" else "S"} · LAST ${last?.label ?: ""}"
    val chips = buildList {
        if (li != null) add(kindLabelOf(li.kind) to 1)
        if (r.ins.phase.isNotEmpty()) add(r.ins.phase to 2)
        if (r.ins.pos != null) add("POS ${bleAgo(now - r.ins.posMs)}" to 0)
        if (v != null && v.station.isNotEmpty()) add("GS ${v.station}" to 0)
        for (a in r.ins.airports.filter { it != r.ins.orig && it != r.ins.dest }.take(3)) add(a to 0)
    }
    Column(Modifier.liveCard(accent, flash, selected, false, live, d, onClick), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(r.title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(head, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (sub.isNotEmpty()) Text(sub, color = if (ads != null) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            LiveDot(live, flash, bleAgo(age))
        }
        if (nums.isNotEmpty()) Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(nums.joinToString(" · "), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(bleAgo(now - r.ins.numsMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("$count", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(what, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text(if (v != null) mhzOf(v.hz) else last?.mhz ?: "", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        AcChips(chips, accent)
        Text(li?.summary ?: (if (v != null) "link frames with ${v.stations.size} ground station${if (v.stations.size == 1) "" else "s"}" else ""),
            color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(if (last != null) last.text.ifEmpty { "(no text)" } else v?.events?.firstOrNull()?.text ?: "(no ACARS text)", color = Palette.muted, fontFamily = Mono,
            fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun StationCard(g: VdlStation, now: Long, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val c = Palette.accent2
    val age = now - g.lastMs
    val live = age < 120_000
    val flash = max(0f, 1 - age / 700f)
    val apt = if (g.airport.isNotEmpty()) Apps.airportLookup(g.airport) else null
    Column(Modifier.liveCard(c, flash, selected, false, live, d, onClick), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(g.addr, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(apt?.name?.uppercase(Locale.US) ?: "AIRPORT NOT NAMED YET", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f),
                    letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (g.airport.isNotEmpty()) "${g.airport} · ${if (g.airportOwn) "from its own XID" else "from an aircraft's XID"}" else "ground station",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            LiveDot(live, flash, bleAgo(age))
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${g.frames}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("FRAME${if (g.frames == 1) "" else "S"} · ${g.aircraft.size} AIRCRAFT", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
            Text(mhzOf(g.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(3f)))
        }
        Text(g.snr?.let { "heard itself at ${acSnr(it)}" } ?: "not heard itself yet (only aircraft talking to it)", color = Palette.muted, fontFamily = Mono,
            fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A timed line in a panel: a link event, an aircraft working a station. */
@Composable
private fun AcEvent(ms: Long?, text: String, accent: Color) {
    val d = rememberDims()
    Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        if (ms != null) Text(clockOf(ms), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
        Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
    }
}

/** An aircraft's fields, the ADS-B link when ADS-B has it, its link events (VDL2) and every message newest first,
 *  each read into plain words with its raw text under it. */
@Composable
private fun AcarsDetail(r: AcRow, ads: Aircraft?, stations: List<VdlStation>, accent: Color, now: Long, modifier: Modifier, onMap: (() -> Unit)?, onAdsb: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val v = r.vdl; val i = r.ins
    val fields = buildList {
        add("Registration" to r.reg.ifEmpty { "—" }); add("Flight" to r.flight.ifEmpty { "—" }); add("Airline" to r.airline.ifEmpty { "—" })
        add("ICAO" to r.icao.ifEmpty { "—" }); add("Messages" to r.msgs.size.toString())
        if (v != null) {
            add("Frames" to "${v.frames} · ${v.acars} ACARS"); add("Last SNR" to acSnr(v.snr))
            add("Ground stations" to v.stations.keys.joinToString(", ") { g -> stations.firstOrNull { it.addr == g }?.airport?.takeIf { it.isNotEmpty() }?.let { "$g ($it)" } ?: g }.ifEmpty { "—" })
            add("Channel" to "${mhzOf(v.hz)} MHz")
        }
        add("Phase" to if (i.phase.isNotEmpty()) "${i.phase} · ${bleAgo(now - i.phaseMs)}" else "—")
        add("Route" to if (i.orig.isNotEmpty()) "${i.orig} → ${i.dest}" else "—")
        add("Position" to (i.pos?.let { "%.3f, %.3f · from a message %s".format(Locale.US, it.lat, it.lon, bleAgo(now - i.posMs)) } ?: "—"))
        add("Stated" to numChips(i.nums).joinToString(" · ").let { if (it.isEmpty()) "—" else "$it · ${bleAgo(now - i.numsMs)}" })
        add("Airports named" to i.airports.joinToString(", ").ifEmpty { "—" })
        add("First heard" to clockOf(r.firstMs)); add("Last heard" to clockOf(r.lastMs))
        if (v != null) add("XID" to v.xid.ifEmpty { "—" })
        add("ADS-B" to (ads?.let { a -> a.icao.uppercase(Locale.US) + (a.flight?.trim()?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "") + (a.altBaro?.let { " · $it ft" } ?: "") }
            ?: "not seen (open ADS-B to look for it)"))
    }
    val kind = listOfNotNull(r.airline.takeIf { it.isNotEmpty() }?.uppercase(Locale.US), r.flight.takeIf { it.isNotEmpty() }?.let { "FLIGHT $it" }, r.icao.takeIf { it.isNotEmpty() }?.let { "ICAO $it" })
        .joinToString(" · ").ifEmpty { if (v != null) "VDL2" else "ACARS" }
    CardPanel(r.title, kind, accent, modifier,
        actions = if (onMap != null || onAdsb != null) ({
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            if (onAdsb != null) ToggleBox("ADS-B", false, accent, Modifier.fillMaxHeight()) { onAdsb() }
        }) else null, onClose = onClose) {
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(fields, labelWidth = 112f, minColumn = 320f)
                if (v != null) {
                    PanelCaption("LINK EVENTS · newest first · ${v.events.size}", accent)
                    if (v.events.isEmpty()) AcEvent(null, "no XID handoffs heard yet", accent)
                    for (e in v.events) AcEvent(e.ms, e.text, accent)
                }
                PanelCaption("MESSAGES · newest first · ${r.msgs.size}", accent)
                if (r.msgs.isEmpty()) AcEvent(null, "no ACARS messages from it yet", accent)
                for (m in r.msgs) Column(Modifier.fillMaxWidth().padding(top = d.dp(2f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                    val x = AcReads.of(m, Geo.fix.value?.let { LatLon(it.first, it.second) }, Airports.loaded.value)
                    Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
                    Row(Modifier.padding(top = d.dp(2f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text(clockOf(m.ms), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
                        val mean = labelMeaning(m.label)
                        Text("${if (m.down) "↓ from the aircraft" else "↑ to the aircraft"} · ${m.label}${if (mean.isNotEmpty()) " $mean" else ""} · blk ${m.blk}" +
                            (if (m.msn.isNotEmpty()) " · #${m.msn}" else "") + " · ${m.mhz}" + (if (m.sat) " · SATCOM" else "") + (if (m.crcOk) "" else " · CRC?"),
                            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                    AcChips(buildList {
                        add(kindLabelOf(x.kind) to 1)
                        if (x.phase.isNotEmpty()) add(x.phase to 2)
                        x.pos?.let { add("%.3f, %.3f".format(Locale.US, it.lat, it.lon) to 0) }
                        for (c in numChips(x.nums)) add(c to 0)
                        for (a in x.airports) add(a to 0)
                    }, accent)
                    Text(x.summary, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                    if (m.text.isNotEmpty()) Text(m.text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                }
            }
        }
    }
}

@Composable
private fun StationDetail(g: VdlStation, rows: List<AcRow>, now: Long, modifier: Modifier, onMap: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val c = Palette.accent2
    val apt = if (g.airport.isNotEmpty()) Apps.airportLookup(g.airport) else null
    val fields = listOf("Address" to g.addr, "Airport" to (apt?.let { "${g.airport} · ${it.name}" } ?: "—"),
        "Placed by" to if (g.airport.isEmpty()) "—" else if (g.airportOwn) "its own XID" else "an aircraft's XID to it",
        "Frames" to g.frames.toString(), "SNR" to (g.snr?.let { acSnr(it) } ?: "not heard itself yet"), "Channel" to "${mhzOf(g.hz)} MHz",
        "First heard" to clockOf(g.firstMs), "Last heard" to "${clockOf(g.lastMs)} · ${bleAgo(now - g.lastMs)}",
        "Its XID" to xidSummary(g.xidOwn).ifEmpty { "—" }, "XID to it" to xidSummary(g.xidHeard).ifEmpty { "—" })
    CardPanel(g.addr, "GROUND STATION${if (g.airport.isNotEmpty()) " · ${g.airport}" else ""}", c, Modifier.then(modifier),
        actions = if (onMap != null) ({ ToggleBox("MAP", false, c, Modifier.fillMaxHeight()) { onMap() } }) else null, onClose = onClose) {
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(fields, labelWidth = 112f, minColumn = 320f)
                PanelCaption("AIRCRAFT WORKING IT · ${g.aircraft.size}", c)
                for ((k, t) in g.aircraft.entries.sortedByDescending { it.value }) {
                    val r = rows.firstOrNull { it.icao == k }
                    AcEvent(t, listOfNotNull(r?.reg?.takeIf { it.isNotEmpty() }, r?.flight?.takeIf { it.isNotEmpty() }, k).joinToString(" · "), c)
                }
            }
        }
    }
}

/** The map: aircraft where their own messages put them (with the age of that fix and any altitude and heading they
 *  stated), VDL2 ground stations at the airport their XIDs name, a line from each aircraft to the stations it worked
 *  in the last ten minutes, the picked aircraft's destination; the aircraft with no position listed under it. */
@Composable
private fun AcarsMap(rows: List<AcRow>, stations: List<VdlStation>, where: Map<String, AcWhere>, vdl: Boolean, accent: Color, fix: Pair<Double, Double>?,
                     sel: String, focusKey: Int, now: Long, onPick: (String) -> Unit) {
    val items = ArrayList<GeoItem>(); val at = HashMap<String, Pair<Double, Double>>(); val paths = ArrayList<GeoPath>()
    for (g in stations) {
        val apt = (if (g.airport.isNotEmpty()) Apps.airportLookup(g.airport) else null) ?: continue
        items.add(GeoItem("G:${g.addr}", apt.lat, apt.lon, "GS ${g.addr} · ${g.airport}", GeoItem.Kind.TOWER)); at[g.addr] = apt.lat to apt.lon
    }
    for (r in rows) {
        val w = where[r.key] ?: continue
        val alt = r.ins.nums.altFt?.let { numChips(FlightNums(altFt = it)).first() }
        items.add(GeoItem(r.key, w.lat, w.lon, "${r.title}${alt?.let { " · $it" } ?: ""} · ${bleAgo(now - w.ms)}", GeoItem.Kind.PLANE, heading = r.ins.posHdg?.toDouble()))
        at[r.key] = w.lat to w.lon
        // the picked aircraft's destination, dashed (only then, so the view stays on what is heard here)
        val dest = if (r.ins.dest.isNotEmpty() && sel == r.key) Apps.airportLookup(r.ins.dest) else null
        if (dest != null) { paths.add(GeoPath(listOf(w.lat to w.lon, dest.lat to dest.lon), dashed = true)); items.add(GeoItem("dest:${r.key}", dest.lat, dest.lon, r.ins.dest, GeoItem.Kind.AIRPORT)) }
    }
    val lines = ArrayList<Pair<Pair<Double, Double>, Pair<Double, Double>>>()
    if (vdl) for (r in rows) { val v = r.vdl ?: continue; val p = at[r.key] ?: continue; for ((g, t) in v.stations) if (now - t <= VDL_LINK_MS) at[g]?.let { lines.add(p to it) } }
    val focus = (if (sel.startsWith("G:")) at[sel.removePrefix("G:")] else at[sel])
    val none = rows.filter { it.key !in where }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(rememberDims().dp(6f))) {
        GeoMapView(items, accent, Modifier.fillMaxWidth().weight(1f).panel(), home = fix, selected = sel.ifEmpty { null }, layers = GeoLayers(lines = lines, paths = paths),
            start = remember { mapStart(fix) }, focus = focus, focusKey = focusKey,
            emptyTitle = if (items.isEmpty()) "NO POSITIONS YET" else "", emptySub = mapEmptySub("Aircraft that send their position show up here", fix), onPick = onPick)
        NoPositionList(none, sel, accent, onPick)
    }
}

/** Under the map: the aircraft heard that have not sent a position, a tap opens one. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NoPositionList(none: List<AcRow>, sel: String, accent: Color, onPick: (String) -> Unit) {
    val d = rememberDims()
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        PanelCaption("NO POSITION YET · ${none.size}", accent)
        FlowRow(Modifier.heightIn(max = d.dp(64f)).verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            if (none.isEmpty()) AcChip("every aircraft heard is on the map", Palette.muted)
            for (r in none) Box(Modifier.clickable { onPick(r.key) }) {
                if (sel == r.key) AcChip(r.title, accent, accent.copy(alpha = 0.7f)) else AcChip(r.title)
            }
        }
    }
}

/** STATS: totals, messages a minute over the last 30 minutes, and bars by channel, airline and message kind. */
@Composable
private fun AcarsStatsView(vdl: Boolean, aircraft: Int, accent: Color, now: Long, tick: Long) {
    val d = rememberDims()
    val stats = remember(tick, vdl, now / 10_000) { if (vdl) Apps.vdl2StatsSnap() else Apps.acarsStatsSnap() }
    val chans = remember(tick, vdl) { if (vdl) Apps.vdl2Chans() else emptyMap() }
    val stations = remember(tick, vdl) { if (vdl) Apps.vdl2Stations().size else 0 }
    val per = stats.minutes(now); val peak = per.max(); val sum = per.sum()
    val tiles = buildList {
        add("MESSAGES" to stats.total); add("AIRCRAFT" to aircraft); add("LAST 30 MIN" to sum); add("PEAK / MIN" to peak)
        if (vdl) { add("FRAMES" to chans.values.sum()); add("GROUND STATIONS" to stations) }
    }
    val chanRows = if (vdl) VDL2_CHANNELS.sorted().map { mhzOf(it) to (chans[it] ?: 0) }
    else (ACARS_CHANNELS + stats.chans.keys).distinct().sorted().map { it to (stats.chans[it] ?: 0) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val cols = max(2, (maxWidth / d.dp(120f)).toInt())
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (row in tiles.chunked(cols)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (i in 0 until cols) {
                        val t = row.getOrNull(i)
                        Column(Modifier.weight(1f).then(if (t != null) Modifier.clip(RoundedCornerShape(d.dp(12f)))
                            .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f), Palette.panel))).border(1.dp, accent.copy(alpha = 0.22f), RoundedCornerShape(d.dp(12f)))
                            .padding(horizontal = d.dp(10f), vertical = d.dp(8f)) else Modifier)) {
                            if (t != null) {
                                Text("${t.second}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f), maxLines = 1)
                                Text(t.first, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
        PanelCaption("MESSAGES A MINUTE · last 30 min", accent)
        Box(Modifier.fillMaxWidth().height(d.dp(70f)).clip(RoundedCornerShape(d.dp(10f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(10f))).padding(d.dp(4f))) {
            Canvas(Modifier.fillMaxSize().padding(bottom = d.dp(10f))) {
                val w = size.width; val h = size.height
                val pts = per.mapIndexed { k, n -> Offset(w * k / (per.size - 1), h - 2 - (h - 6) * n / max(1, peak).toFloat()) }
                val line = Path().apply { moveTo(pts[0].x, pts[0].y); for (p in pts.drop(1)) lineTo(p.x, p.y) }
                val fill = Path().apply { addPath(line); lineTo(w, h); lineTo(0f, h); close() }
                drawPath(fill, accent.copy(alpha = 0.18f))
                drawPath(line, accent, style = Stroke(1.5.dp.toPx()))
            }
            Text("$peak", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.align(Alignment.TopEnd))
            Text("30 min ago", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), modifier = Modifier.align(Alignment.BottomStart))
            Text("now", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), modifier = Modifier.align(Alignment.BottomEnd))
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val wide = maxWidth > d.dp(720f)
            val blocks: List<Triple<String, List<Pair<String, Int>>, String>> = listOf(
                Triple(if (vdl) "FRAMES BY CHANNEL · MHz" else "MESSAGES BY CHANNEL · MHz", chanRows, ""),
                Triple("TOP AIRLINES · aircraft", stats.topAirlines(), "none named yet (by flight number)"),
                Triple("MESSAGE KINDS", stats.kindList().map { kindLabelOf(it.first) to it.second }, "no messages yet"),
            )
            if (wide) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(14f))) { for (b in blocks) Column(Modifier.weight(1f)) { AcBars(b.first, b.second, b.third, accent) } }
            else Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { for (b in blocks) AcBars(b.first, b.second, b.third, accent) }
        }
    }
}

/** A caption, then a bar per row as long as its share of the biggest, with its count. */
@Composable
private fun AcBars(title: String, rows: List<Pair<String, Int>>, empty: String, accent: Color) {
    val d = rememberDims()
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        PanelCaption(title, accent)
        if (rows.isEmpty()) Text(empty, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        val top = max(1, rows.maxOfOrNull { it.second } ?: 1)
        for ((k, n) in rows) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(k, color = if (n > 0) Palette.ink else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(d.dp(104f)))
            Box(Modifier.weight(1f).height(d.dp(8f)).clip(RoundedCornerShape(4.dp)).background(Palette.line.copy(alpha = 0.6f))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(n / top.toFloat()).clip(RoundedCornerShape(4.dp)).background(accent))
            }
            Text("$n", color = if (n > 0) Palette.ink else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, modifier = Modifier.width(d.dp(36f)))
        }
    }
}
