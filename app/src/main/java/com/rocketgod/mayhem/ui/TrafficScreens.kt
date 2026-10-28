package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.AdsbStore
import com.rocketgod.mayhem.core.AircraftInfo
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.AprsStation
import com.rocketgod.mayhem.core.apps.Vessel
import com.rocketgod.mayhem.core.apps.aprsSymbolName
import com.rocketgod.mayhem.core.apps.atonTypeName
import com.rocketgod.mayhem.core.apps.mmsiInfo
import com.rocketgod.mayhem.core.apps.navStatusName
import com.rocketgod.mayhem.core.apps.shipTypeName
import com.rocketgod.mayhem.core.ham.CallInfo
import com.rocketgod.mayhem.core.ham.latLonToGrid
import com.rocketgod.mayhem.core.ham.lookupCall
import com.rocketgod.mayhem.core.ham.parseCall
import com.rocketgod.mayhem.model.Aircraft
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

private enum class View { MAP, LIST, LOG }

/**
 * The three traffic receivers share a frame: readout and waterfall, then a count line with MAP / LIST / LOG, PAUSE
 * and CLEAR, the selected item's card, and the chosen view. PAUSE freezes the rows for reading while decoding goes on.
 */
@Composable
private fun TrafficFrame(
    accent: Color, tunable: Boolean, cardOpen: Boolean, head: String, views: List<View>, view: View, onView: (View) -> Unit,
    paused: Boolean, onPause: () -> Unit, onClear: () -> Unit, extra: @Composable ColumnScope.() -> Unit = {},
    body: @Composable ColumnScope.() -> Unit,
) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        // the card needs the room more than the waterfall does on a phone
        visualHeightNarrow = d.dp(if (cardOpen) 120f else 170f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 60, traceFrac = 0.35f, labels = centeredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = if (tunable) onPreview else null, onTapFrac = if (tunable) onTune else null)
            }
        }
    ) {
        Row(Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
            Text(head, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                for (v in views) Chip(v.name, selected = view == v, accent = accent) { onView(v) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip(if (paused) "RESUME" else "PAUSE", selected = paused, accent = accent, modifier = Modifier.weight(1f)) { onPause() }
            Chip("CLEAR", selected = false, accent = accent, modifier = Modifier.weight(1f)) { onClear() }
        }
        body()
        extra()
        GainRow(accent)
    }
}

@Composable
private fun EmptyPanel(text: String, modifier: Modifier) {
    val d = rememberDims()
    Box(modifier.panel()) { Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(10f))) }
}

/** Two-line rows: the name in bold, the readings under it; the selected one in gold. */
@Composable
private fun <T> TwoLineList(items: List<T>, key: (T) -> String, selected: String?, modifier: Modifier, empty: String,
                            top: (T) -> String, bottom: (T) -> String, onPick: (T) -> Unit) {
    val d = rememberDims()
    val state = rememberLazyListState()
    if (items.isEmpty()) { EmptyPanel(empty, modifier); return }
    Box(modifier.panel()) {
        LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(4f), vertical = d.dp(2f)), state = state) {
            itemsIndexed(items, key = { _, it -> key(it) }) { i, it ->
                val on = key(it) == selected
                Column(Modifier.fillMaxWidth().background(if (i % 2 == 1) Palette.panel.copy(alpha = 0.5f) else Color.Transparent, RoundedCornerShape(3.dp))
                    .clickable { onPick(it) }.padding(vertical = d.dp(5f), horizontal = d.dp(4f))) {
                    Text(top(it), color = if (on) Palette.accent2 else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(bottom(it), color = if (on) Palette.accent2.copy(alpha = 0.85f) else Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** The packet log, frozen while paused. A tapped line selects whoever sent it, as the list and the map do. */
@Composable
private fun FrozenLog(log: PacketLog, paused: Boolean, modifier: Modifier, empty: String, onTap: ((String) -> Unit)? = null) {
    val lines by log.lines.collectAsState()
    var held by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(paused) { held = if (paused) lines else null }
    LogList(held ?: lines, modifier, empty = empty, onTap = onTap)
}

/** Recomposes once a second, for "heard 12 s ago". */
@Composable
private fun ticker(): Long = produceState(System.currentTimeMillis()) { while (true) { delay(1000); value = System.currentTimeMillis() } }.value

// ---- ADS-B ---------------------------------------------------------------------------------------------------------
@Composable
fun AdsbScreen(accent: Color) {
    val d = rememberDims()
    val live by AdsbStore.flow.collectAsState()
    val frames by AdsbStore.frames.collectAsState()
    val home by Geo.fix.collectAsState()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { Geo.start(ctx) }
    var view by rememberSaveable { mutableStateOf(View.MAP) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var frozen by remember { mutableStateOf<List<Aircraft>?>(null) }
    var focusKey by remember { mutableStateOf(0) }
    val planes = frozen ?: live
    val now = ticker()
    val a = live.firstOrNull { it.icao == sel } ?: planes.firstOrNull { it.icao == sel }
    TrafficFrame(accent, tunable = false, cardOpen = a != null, head = "✈ $frames FRAMES · ${planes.size} AIRCRAFT",
        views = listOf(View.MAP, View.LIST), view = view, onView = { view = it },
        paused = frozen != null, onPause = { frozen = if (frozen == null) live else null }, onClear = { AdsbStore.clear(); sel = null; if (frozen != null) frozen = emptyList() }) {
        if (a != null) AircraftCard(a, home, now, onMap = if (a.lat != null) ({ view = View.MAP; focusKey++ }) else null) { sel = null }
        val m = Modifier.fillMaxWidth().weight(1f)
        when (view) {
            View.MAP -> AdsbMap(planes, accent, home, sel, m.panel(), focus = a?.let { p -> p.lat?.let { la -> p.lon?.let { la to it } } }, focusKey = focusKey) { sel = it }
            else -> TwoLineList(planes.sortedByDescending { it.seenAtMs }, { it.icao }, sel, m, "listening on 1090 MHz…",
                top = { "${it.icao.uppercase()} ${it.flight?.trim() ?: ""}" },
                bottom = { p -> listOfNotNull(p.altBaro?.let { "%,d ft".format(it) }, p.gs?.let { "$it kt" }, p.track?.let { "$it°" },
                    if (p.lat != null && p.lon != null) "%.3f,%.3f".format(p.lat, p.lon) else "no pos").joinToString(" · ") }) { p ->
                sel = p.icao; if (p.lat != null) view = View.MAP
            }
        }
    }
}

@Composable
private fun AircraftCard(a: Aircraft, home: Pair<Double, Double>?, now: Long, onMap: (() -> Unit)?, onClose: () -> Unit) {
    LaunchedEffect(a.icao) { AircraftInfo.lookup(a.icao) }
    AircraftInfo.changed.collectAsState().value
    val info = AircraftInfo.get(a.icao)
    val call = a.flight?.trim().orEmpty()
    val lines = buildList {
        if (info?.reg != null || info?.typeIcao != null) add(listOfNotNull(info.reg, info.typeIcao).joinToString("  "))
        listOfNotNull(info?.maker, info?.type).joinToString(" ").takeIf { it.isNotEmpty() }?.let { add(it) }
        info?.owner?.let { add(it) }
        info?.country?.let { add(it) }
        a.squawk?.let { add("squawk $it" + when (it) { "7500" -> " · HIJACK"; "7600" -> " · RADIO FAILURE"; "7700" -> " · EMERGENCY"; else -> "" }) }
        if (isEmpty()) add(if (info == null || !info.done) "looking up the registry…" else "not in the registry")
    }
    DetailCard(
        call.ifEmpty { a.icao.uppercase() }, if (call.isNotEmpty()) a.icao.uppercase() else "no callsign yet", lines,
        listOf(
            "ALTITUDE" to (a.altBaro?.let { "%,d ft".format(it) } ?: "—"),
            "GROUND SPEED" to (a.gs?.let { "$it kt" } ?: "—"),
            "TRACK" to (a.track?.let { "$it°" } ?: "—"),
            "CLIMB" to (a.vertRate?.let { "${if (it > 0) "+" else ""}$it ft/min" } ?: "—"),
            "POSITION" to (if (a.lat != null && a.lon != null) "%.4f, %.4f".format(a.lat, a.lon) else "no position yet"),
            "FROM YOU" to fromYou(home, a.lat, a.lon),
            "HEARD" to ageText(now - a.seenAtMs),
            "FIRST HEARD" to "${ageText(now - a.firstSeenMs)} · ${clockOf(a.firstSeenMs)}",
        ),
        onMap, onClose, photo = info?.photo?.asImageBitmap(),
    )
}

// ---- AIS -----------------------------------------------------------------------------------------------------------
@Composable
fun AisScreen(accent: Color) {
    val live by Apps.ais.table.collectAsState()
    val count by Apps.aisLog.count.collectAsState()
    val home by Geo.fix.collectAsState()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { Geo.start(ctx) }
    var view by rememberSaveable { mutableStateOf(View.MAP) }
    var sel by rememberSaveable { mutableStateOf(0) }
    var frozen by remember { mutableStateOf<List<Vessel>?>(null) }
    var focusKey by remember { mutableStateOf(0) }
    val vessels = frozen ?: live
    val now = ticker()
    val v = live.firstOrNull { it.mmsi == sel } ?: vessels.firstOrNull { it.mmsi == sel }
    TrafficFrame(accent, tunable = true, cardOpen = v != null, head = "⚓ $count PACKETS · ${vessels.size} VESSELS",
        views = View.entries, view = view, onView = { view = it },
        paused = frozen != null, onPause = { frozen = if (frozen == null) live else null },
        onClear = { Apps.ais.clear(); Apps.aisLog.clear(); sel = 0; if (frozen != null) frozen = emptyList() },
        extra = { PresetRow(accent, listOf("AIS A 161.975" to 161_975_000L, "AIS B 162.025" to 162_025_000L), title = "CHANNEL") }) {
        if (v != null) VesselCard(v, home, now, onMap = if (v.lat != null) ({ view = View.MAP; focusKey++ }) else null) { sel = 0 }
        val m = Modifier.fillMaxWidth().weight(1f)
        when (view) {
            View.MAP -> GeoMapView(
                vessels.mapNotNull { x -> val la = x.lat; val lo = x.lon; if (la == null || lo == null) null else
                    GeoItem(x.mmsi.toString(), la, lo, x.name?.takeIf { it.isNotEmpty() } ?: x.mmsi.toString(),
                        when (x.cls) { "AtoN" -> GeoItem.Kind.ATON; "base" -> GeoItem.Kind.OBJECT; else -> GeoItem.Kind.SHIP },
                        heading = (x.hdg?.toDouble() ?: x.cog)?.takeIf { (x.sog ?: 0.0) > 0.3 || x.hdg != null }) },
                accent, m.panel(), home = home, selected = sel.toString(),
                focus = v?.let { x -> x.lat?.let { la -> x.lon?.let { la to it } } }, focusKey = focusKey) { sel = it.toIntOrNull() ?: 0 }
            View.LIST -> TwoLineList(vessels, { it.mmsi.toString() }, sel.toString(), m, "no vessels yet",
                top = { it.name?.takeIf { n -> n.isNotEmpty() } ?: it.mmsi.toString() },
                bottom = { x -> listOfNotNull(if (!x.name.isNullOrEmpty()) "${x.mmsi}" else null,
                    if (x.lat != null && x.lon != null) "%.3f,%.3f".format(x.lat, x.lon) else "no fix", x.sog?.let { "%.1f kn".format(it) },
                    shipTypeName(x.shipType).takeIf { it.isNotEmpty() }).joinToString(" · ") }) { x ->
                sel = x.mmsi; if (x.lat != null) view = View.MAP
            }
            View.LOG -> FrozenLog(Apps.aisLog, frozen != null, m, "listening on the AIS channel…") { l ->
                Regex("MMSI (\\d+)").find(l)?.groupValues?.get(1)?.toIntOrNull()?.let { sel = it }
            }
        }
    }
}

@Composable
private fun VesselCard(v: Vessel, home: Pair<Double, Double>?, now: Long, onMap: (() -> Unit)?, onClose: () -> Unit) {
    val (flag, whoKind) = mmsiInfo(v.mmsi)
    val kind = when (v.cls) {
        "A" -> "Class A"; "B" -> "Class B"; "base" -> "Base station"; "SAR" -> "SAR aircraft"
        "AtoN" -> if (v.virtualAton) "Virtual aid to navigation" else "Aid to navigation"
        else -> whoKind
    }
    val lines = buildList {
        listOfNotNull(v.callsign?.takeIf { it.isNotEmpty() }?.let { "call $it" }, v.imo?.let { "IMO $it" }).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { add(it) }
        add(listOf(kind, if (v.cls == "AtoN") atonTypeName(v.atonType) else shipTypeName(v.shipType)).filter { it.isNotEmpty() }.joinToString(" · "))
        navStatusName(v.navStatus).takeIf { it.isNotEmpty() }?.let { add(it) }
        v.dest?.takeIf { it.isNotEmpty() }?.let { dst -> add("→ $dst" + (v.eta?.let { e -> " · ETA %02d/%02d %02d:%02d UTC".format(e[1], e[0], e[2], e[3]) } ?: "")) }
        val len = if (v.dimA != null && v.dimB != null) v.dimA!! + v.dimB!! else 0
        val beam = if (v.dimC != null && v.dimD != null) v.dimC!! + v.dimD!! else 0
        listOfNotNull(if (len > 0) "$len m long" else null, if (beam > 0) "$beam m beam" else null, v.draft?.let { "draft %.1f m".format(it) })
            .joinToString(" · ").takeIf { it.isNotEmpty() }?.let { add(it) }
        flag?.let { add(it) }
        v.vendor?.takeIf { it.isNotEmpty() }?.let { add("transponder $it") }
    }
    DetailCard(
        v.name?.takeIf { it.isNotEmpty() } ?: "MMSI ${v.mmsi}", if (!v.name.isNullOrEmpty()) "MMSI ${v.mmsi}" else "no name yet", lines,
        listOf(
            "SPEED" to (v.sog?.let { "%.1f kn".format(it) } ?: "—"),
            "COURSE" to (v.cog?.let { "%.0f°".format(it) } ?: "—"),
            "HEADING" to (v.hdg?.let { "$it°" } ?: "—"),
            "TURN" to (v.rot?.let { if (abs(it) < 0.5) "steady" else "${if (it > 0) "→" else "←"} %.0f°/min".format(abs(it)) } ?: "—"),
            "POSITION" to (if (v.lat != null && v.lon != null) "%.4f, %.4f%s".format(v.lat, v.lon, if (v.accuracy) "" else " (≈)") else "no fix yet"),
            "FROM YOU" to fromYou(home, v.lat, v.lon),
            "HEARD" to ageText(now - v.lastMs),
            "FIRST HEARD" to "${ageText(now - v.firstMs)} · ${clockOf(v.firstMs)}",
            "MESSAGES" to v.msgs.toString(),
        ) + (v.alt?.let { listOf("ALTITUDE" to "$it m") } ?: emptyList()),
        onMap, onClose,
    )
}

// ---- APRS ----------------------------------------------------------------------------------------------------------
/** Who a callsign belongs to, looked up once per base call when its card opens. */
private object StationLookups {
    val cache = java.util.concurrent.ConcurrentHashMap<String, CallInfo?>()
    val changed = kotlinx.coroutines.flow.MutableStateFlow(0)
}

@Composable
fun AprsScreen(accent: Color) {
    val live by Apps.aprs.table.collectAsState()
    val count by Apps.aprsLog.count.collectAsState()
    val home by Geo.fix.collectAsState()
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { Geo.start(ctx) }
    var view by rememberSaveable { mutableStateOf(View.MAP) }
    var sel by rememberSaveable { mutableStateOf("") }
    var frozen by remember { mutableStateOf<List<AprsStation>?>(null) }
    var focusKey by remember { mutableStateOf(0) }
    val stations = frozen ?: live
    val now = ticker()
    val s = live.firstOrNull { it.call == sel } ?: stations.firstOrNull { it.call == sel }
    TrafficFrame(accent, tunable = true, cardOpen = s != null, head = "📡 $count PACKETS · ${stations.size} STATIONS",
        views = View.entries, view = view, onView = { view = it },
        paused = frozen != null, onPause = { frozen = if (frozen == null) live else null },
        onClear = { Apps.aprs.clear(); Apps.aprsLog.clear(); sel = ""; if (frozen != null) frozen = emptyList() },
        extra = { PresetRow(accent, listOf("NA 144.39" to 144_390_000L, "EU 144.80" to 144_800_000L, "AU 145.175" to 145_175_000L, "JP 144.64" to 144_640_000L), title = "REGION") }) {
        if (s != null) StationCard(s, home, now, onMap = if (s.lat != null) ({ view = View.MAP; focusKey++ }) else null) { sel = "" }
        val m = Modifier.fillMaxWidth().weight(1f)
        when (view) {
            View.MAP -> GeoMapView(
                stations.mapNotNull { x -> val la = x.lat; val lo = x.lon; if (la == null || lo == null) null else
                    GeoItem(x.call, la, lo, x.call, if (x.kind == "station") GeoItem.Kind.STATION else GeoItem.Kind.OBJECT, heading = x.course?.toDouble()) },
                accent, m.panel(), home = home, selected = sel,
                focus = s?.let { x -> x.lat?.let { la -> x.lon?.let { la to it } } }, focusKey = focusKey) { sel = it }
            View.LIST -> TwoLineList(stations, { it.call }, sel, m, "no stations yet",
                top = { x -> x.call + if (x.kind != "station") "  ${x.kind} by ${x.owner ?: "?"}" else "" },
                bottom = { x -> listOfNotNull(aprsSymbolName(x.table, x.symbol).takeIf { it.isNotEmpty() },
                    if (x.lat != null && x.lon != null) "%.3f,%.3f".format(x.lat, x.lon) else null,
                    x.speed?.takeIf { it > 0 }?.let { "%.0f kn".format(it) }).joinToString(" · ") }) { x ->
                sel = x.call; if (x.lat != null) view = View.MAP
            }
            View.LOG -> FrozenLog(Apps.aprsLog, frozen != null, m, "listening on the APRS frequency…") { l ->
                Regex("^([A-Za-z0-9-]+)>").find(l)?.let { sel = it.groupValues[1] }
            }
        }
    }
}

@Composable
private fun StationCard(s: AprsStation, home: Pair<Double, Double>?, now: Long, onMap: (() -> Unit)?, onClose: () -> Unit) {
    val base = parseCall(s.call.replace(Regex("-\\d+$"), "")).base
    StationLookups.changed.collectAsState().value
    LaunchedEffect(base) {
        if (s.kind == "station" && base.isNotEmpty() && !StationLookups.cache.containsKey(base)) {
            StationLookups.cache[base] = null
            val i = withContext(Dispatchers.IO) { runCatching { lookupCall(base) }.getOrNull() }
            if (i != null) StationLookups.cache[base] = i
            StationLookups.changed.value++
        }
    }
    val info = StationLookups.cache[base]
    val lines = buildList {
        add(listOf(when (s.kind) { "object" -> "Object from ${s.owner}"; "item" -> "Item from ${s.owner}"; else -> "" }, aprsSymbolName(s.table, s.symbol))
            .filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { "APRS station" })
        listOfNotNull(info?.name, info?.qth).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { add(it) }
        info?.country?.let { add(it + (info?.cls?.let { c -> " · $c" } ?: "")) }
        s.mice?.let { add("Mic-E: $it") }
        s.status?.takeIf { it.isNotEmpty() }?.let { add(it) }
        s.comment?.takeIf { it.isNotEmpty() }?.let { add(it) }
        s.lastMsg?.let { (to, text) -> add("→ $to: $text") }
        if (!s.path.isNullOrEmpty() || s.via != null) add(listOfNotNull(s.dest?.let { "to $it" }, if (!s.path.isNullOrEmpty()) "via ${s.path}" else "direct", s.via?.let { "relayed by $it" }).joinToString(" · "))
    }
    val hasPos = s.lat != null && s.lon != null
    val grid = buildList {
        add("POSITION" to (if (hasPos) "%.4f, %.4f".format(s.lat, s.lon) else "no position"))
        add("GRID" to (if (hasPos) latLonToGrid(s.lat!!, s.lon!!, 8) else "—"))
        add("FROM YOU" to fromYou(home, s.lat, s.lon, miles = true))
        add("COURSE" to (s.course?.let { "$it°" } ?: "—"))
        add("SPEED" to (s.speed?.let { "%d mph · %d kn".format((it * 1.15078).roundToInt(), it.roundToInt()) } ?: "—"))
        add("ALTITUDE" to (s.alt?.let { "%,d ft · %d m".format((it * 3.28084).roundToInt(), it.roundToInt()) } ?: "—"))
        s.wx?.let { w ->
            add("TEMP" to (w.tempF?.let { "$it °F · %.1f °C".format((it - 32) * 5 / 9.0) } ?: "—"))
            add("WIND" to (w.windMph?.let { "$it mph" + (w.windDir?.let { dd -> " from $dd°" } ?: "") } ?: "—"))
            add("GUST" to (w.gustMph?.let { "$it mph" } ?: "—"))
            add("HUMIDITY" to (w.humidity?.let { "$it %" } ?: "—"))
            add("PRESSURE" to (w.pressureMb?.let { "%.1f mb".format(it) } ?: "—"))
            add("RAIN 1H" to (w.rain1h?.let { "%.2f in".format(it / 100.0) } ?: "—"))
            add("RAIN 24H" to (w.rain24h?.let { "%.2f in".format(it / 100.0) } ?: "—"))
        }
        add("HEARD" to ageText(now - s.lastMs))
        add("FIRST HEARD" to "${ageText(now - s.firstMs)} · ${clockOf(s.firstMs)}")
        add("PACKETS" to s.packets.toString())
    }
    DetailCard(s.call, if (s.kind == "station") "APRS" else s.kind, lines, grid, onMap, onClose)
}
