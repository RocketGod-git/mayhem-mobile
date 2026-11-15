package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.uat.Airports
import com.rocketgod.mayhem.core.uat.Metar
import com.rocketgod.mayhem.core.uat.UatProcessor
import kotlinx.coroutines.delay
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

/** Flight categories as colors: VFR green, MVFR blue, IFR red, LIFR magenta. */
private val CAT = mapOf("VFR" to Color(0xFF3DDC84), "MVFR" to Color(0xFF4AA3FF), "IFR" to Color(0xFFFF5B52), "LIFR" to Color(0xFFD562FF))
/** Radar intensity 2-7 (light to heavy); level 1 is not drawn: on the national product it marks coverage, not rain. */
private val RADAR = intArrayOf(0, 0, 0xFF3DDC84.toInt(), 0xFF1E9E4B.toInt(), 0xFFF2DF34.toInt(), 0xFFF39A1C.toInt(), 0xFFE5382B.toInt(), 0xFFC42597.toInt())
    .map { (it and 0x00FFFFFF) or (0xC8 shl 24) }.toIntArray().also { it[0] = 0; it[1] = 0 }

/**
 * UAT (978 MHz): the FAA ground towers' FIS-B weather and the aircraft that broadcast on 978. MAP draws the regional
 * and national radar, the airports colored by flight category, the towers and the traffic with its trails; WEATHER is
 * every airport report in plain words, nearest first; NOTICES the text products; PLANES the aircraft. A tap opens the
 * detail (an airport's report, forecast and notices; an aircraft's state). The twin of the web app's renderUat.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UatScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val version by Apps.uat.version.collectAsState()
    val logSnap by Apps.uatLog.snapshot.collectAsState()
    val airportsLoaded by Airports.loaded.collectAsState()
    val fix by Geo.fix.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var focusKey by remember { mutableIntStateOf(0) }
    var radar by rememberSaveable { mutableStateOf(true) }
    var national by rememberSaveable { mutableStateOf(true) }
    var traffic by rememberSaveable { mutableStateOf(true) }
    var airports by rememberSaveable { mutableStateOf(true) }
    LaunchedEffect(Unit) { Geo.start(ctx); Airports.load(ctx) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(1000); value = System.currentTimeMillis() } }.value
    val snap = remember(version, now / 2000, airportsLoaded) { Apps.uat.snapshot() }
    val me = fix ?: Geo.lastKnownPos()

    val metars = remember(snap, airportsLoaded) {
        snap.metars.entries.map { (id, e) ->
            val ap = Airports[id]
            val km = if (me != null && ap != null) distBearing(me.first, me.second, ap.lat, ap.lon).first else 1e9
            Triple(id, e, km)
        }.sortedWith(compareBy({ it.third }, { it.first }))
    }
    val planes = snap.planes.values.sortedByDescending { it.at }
    val texts = snap.texts.sortedByDescending { it.at }
    val radarCells = remember(snap.regional.size, snap.national.size, snap.radarTime, radar, national) {
        if (!radar) emptyList() else (if (national) snap.national else emptyList()).plus(snap.regional)
            .mapNotNull { b -> b.bins?.let { RadarCell(b.lat, b.lon, b.dLat, b.dLon, 32, 4, it) } }
    }

    val wf = waterfallOn(MayhemApp.UAT, phoneDefault = false)

    @Composable
    fun summary() {
        val mins = if (snap.firstAt > 0) max(1.0, (now - snap.firstAt) / 60000.0) else 1.0
        val towers = snap.towers.values.count { now - it.at < 120_000 }
        val text = if (snap.up > 0 || snap.down > 0)
            "$towers TOWER${if (towers == 1) "" else "S"} · ${Math.round(snap.up / mins)} UPLINKS/MIN · ${snap.metars.size} AIRPORTS · ${snap.planes.size} AIRCRAFT" +
                (if (snap.radarTime.isNotEmpty()) " · RADAR ${snap.radarTime}" else "")
        else "listening on 978 MHz for FIS-B towers and aircraft"
        Text(text, color = if (snap.up > 0 || snap.down > 0) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
            fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            when (view) {
                0 -> {
                    val items = ArrayList<GeoItem>(); val paths = ArrayList<GeoPath>()
                    for ((k, t) in snap.towers) items.add(GeoItem("tw:$k", t.lat, t.lon, "FIS-B", GeoItem.Kind.TOWER))
                    if (airports && airportsLoaded) for ((id, e) in snap.metars) {
                        val ap = Airports[id] ?: continue
                        items.add(GeoItem("wx:$id", ap.lat, ap.lon, id, GeoItem.Kind.AIRPORT, color = (CAT[e.first.category] ?: Palette.muted).toArgb()))
                    }
                    if (traffic) for (p in planes) {
                        val la = p.t.lat ?: continue; val lo = p.t.lon ?: continue
                        items.add(GeoItem("ac:${p.t.address}", la, lo, (p.t.callsign ?: p.t.address) + (p.t.altFt?.let { " ${it / 100}" } ?: ""), GeoItem.Kind.PLANE, p.t.trackDeg?.toDouble()))
                        if (p.track.size > 1) paths.add(GeoPath(p.track, faint = sel != "ac:${p.t.address}"))
                    }
                    val focus = when {
                        sel.startsWith("ac:") -> snap.planes[sel.drop(3)]?.let { p -> p.t.lat?.let { la -> p.t.lon?.let { la to it } } }
                        sel.startsWith("wx:") -> Airports[sel.drop(3)]?.let { it.lat to it.lon }
                        fix == null -> snap.towers.values.firstOrNull()?.let { it.lat to it.lon }
                        else -> null
                    }
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                            for ((label, on, set) in listOf(Triple("RADAR", radar) { v: Boolean -> radar = v }, Triple("NATIONAL", national) { v: Boolean -> national = v },
                                Triple("TRAFFIC", traffic) { v: Boolean -> traffic = v }, Triple("AIRPORTS", airports) { v: Boolean -> airports = v })) {
                                ToggleBox(label, on, accent) { set(!on) }
                            }
                            WaterfallBox(wf, accent) { Apps.setWaterfall(MayhemApp.UAT, !wf) }
                            IconBox(ClearIcon, "Clear") { Apps.uat.clear(); sel = "" }
                            Row(Modifier.align(Alignment.CenterVertically), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                                for (c in RADAR.drop(2)) Box(Modifier.size(d.dp(12f), d.dp(7f)).background(Color(c or (0xFF shl 24)), RoundedCornerShape(2.dp)))
                                Text(" light → heavy", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                            }
                        }
                        GeoMapView(items, accent, Modifier.fillMaxWidth().weight(1f).panel(), home = fix, selected = sel.ifEmpty { null },
                            layers = GeoLayers(paths = paths, radar = radarCells, radarColors = RADAR), start = remember { mapStart(fix) },
                            focus = focus, focusKey = focusKey + (if (fix == null && snap.towers.isNotEmpty()) 1000 else 0), autoFollow = false) { id -> sel = id }
                    }
                }
                1 -> CardGrid(metars, { it.first }) { (id, e, _) -> WxCard(id, e.first, e.second, now, sel == "wx:$id", me) { sel = if (sel == "wx:$id") "" else "wx:$id" } }
                2 -> CardGrid(texts, { it.text.take(64) }) { TextCard(it, now) }
                3 -> CardGrid(planes, { it.t.address }) { p -> PlaneCard(p, now, sel == "ac:${p.t.address}", me) { sel = if (sel == "ac:${p.t.address}") "" else "ac:${p.t.address}" } }
            }
            if (sel.isNotEmpty() && (view == 0 || (view == 1 && sel.startsWith("wx:")) || (view == 3 && sel.startsWith("ac:")))) UatDetail(sel, snap, now, me, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                onMap = if (view != 0) ({ view = 0; focusKey++ }) else null) { sel = "" }
        }
    }

    PacketFrame(accent, Apps.uatLog, tag = "UAT", title = "WEATHER & SMALL PLANES", tunable = false, emptyKey = "uat", waterfall = wf,
        lamp = {
            if (snap.up > 0 || snap.down > 0) Lamp("RECEIVING", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = { summary() },
        body = {
            SegBar(listOf("MAP", "WEATHER", "NOTICES", "PLANES", "LOG"), view, accent, Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(6f))) { view = it }
            if (view == 4) LogList(logSnap.lines, Modifier.fillMaxWidth().weight(1f), total = logSnap.total, accent = accent, empty = "listening for FIS-B…")
            else stage(Modifier.fillMaxWidth().weight(1f))
        })
}

@Composable
private fun <T> CardGrid(rows: List<T>, key: (T) -> Any, card: @Composable (T) -> Unit) {
    val d = rememberDims()
    if (rows.isEmpty()) { EmptyState("uat", Modifier.fillMaxSize().panel(), Palette.accent); return }
    LazyVerticalGrid(GridCells.Adaptive(d.dp(260f)), Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        items(rows, key = key) { card(it) }
    }
}

private fun ago(ms: Long, now: Long): String {
    val s = (now - ms) / 1000
    return if (s < 60) "${max(0, s)} s ago" else if (s < 3600) "${s / 60} min ago" else "${s / 3600} h ago"
}

private fun hhmm(h: Int?, m: Int?) = if (h != null && m != null) "%02d:%02dZ".format(Locale.US, h, m) else ""
private fun f(c: Int) = Math.round(c * 9 / 5.0 + 32).toInt()

/** A METAR as a line of plain words: wind, visibility, sky, weather. */
private fun plainWx(m: Metar): String = buildList {
    m.windKt?.let { add(if (it == 0) "calm" else "wind ${m.windDir?.let { d -> "%03d°".format(Locale.US, d) } ?: "variable"} $it kt" + (m.gustKt?.let { g -> " gusting $g" } ?: "")) }
    m.visSm?.let { add(if (it >= 10) "10+ mi" else "${if (it % 1.0 == 0.0) it.toInt().toString() else it.toString()} mi") }
    add(if (m.sky.isNotEmpty()) m.sky.joinToString(" · ").lowercase() else "sky not reported")
    if (m.wx.isNotEmpty()) add(m.wx.joinToString(" "))
}.joinToString(" · ")

@Composable
private fun CardBox(selected: Boolean, edge: Color, dim: Boolean = false, onClick: (() -> Unit)?, content: @Composable () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (dim) 0.8f else 1f).clip(shape)
        .background(Brush.linearGradient(listOf(edge.copy(alpha = 0.10f), Palette.panel)))
        .border(if (selected) 2.5.dp else 1.dp, if (selected) Palette.accent else edge.copy(alpha = 0.5f), shape)
        .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(5f))) { content() }
}

@Composable
private fun WxCard(id: String, m: Metar, at: Long, now: Long, selected: Boolean, me: Pair<Double, Double>?, onClick: () -> Unit) {
    val d = rememberDims()
    val ap = Airports[id]
    val cat = CAT[m.category] ?: Palette.muted
    val from = ap?.let { fromHere(me, it.lat, it.lon) } ?: ""
    CardBox(selected, cat, onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(id, color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
            Column(Modifier.weight(1f)) {
                Text(ap?.name ?: "", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOf(hhmm(m.hh, m.mm), ago(at, now), from).filter { it.isNotEmpty() }.joinToString(" · "), color = Palette.muted, fontFamily = Mono,
                    fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (m.category != null) Text(m.category, color = Color(0xFF05080A), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                modifier = Modifier.clip(RoundedCornerShape(50)).background(cat).padding(horizontal = d.dp(8f), vertical = d.dp(2f)))
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(m.tempC?.let { "${f(it)}°" } ?: "—", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("F" + (m.tempC?.let { " · $it°C" } ?: "") + (m.dewC?.let { " · dew ${f(it)}°" } ?: ""), color = Palette.muted, fontFamily = Mono,
                fontSize = d.sp(9f), modifier = Modifier.weight(1f).padding(bottom = d.dp(4f)))
            m.altimInHg?.let { Text("%.2f inHg".format(Locale.US, it), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(4f))) }
        }
        Text(plainWx(m), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(m.raw, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun TextCard(t: UatProcessor.Text, now: Long) {
    val d = rememberDims()
    CardBox(false, Palette.accent, onClick = null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(t.kind, color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
            Text(t.station, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.weight(1f), maxLines = 1)
            Text(ago(t.at, now), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
        SelectionContainer { Text(t.text.replace('\n', ' '), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f), lineHeight = d.sp(15f)) }
    }
}

@Composable
private fun PlaneCard(p: UatProcessor.Plane, now: Long, selected: Boolean, me: Pair<Double, Double>?, onClick: () -> Unit) {
    val d = rememberDims()
    val live = now - p.at < 30_000
    val t = p.t
    val from = if (t.lat != null && t.lon != null) fromHere(me, t.lat, t.lon) else ""
    CardBox(selected, Palette.accent, dim = !live, onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(t.callsign ?: t.address, color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
            Column(Modifier.weight(1f)) {
                Text(UatProcessor.source(t.qualifier), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
                Text(t.address, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
            }
            Box(Modifier.size(d.dp(9f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(ago(p.at, now), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(t.altFt?.let { "%,d".format(Locale.US, it) } ?: "—", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("FT" + if (t.onGround) " · ON THE GROUND" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f).padding(bottom = d.dp(4f)))
            Text(t.vertFpm?.let { "${if (it > 0) "▲" else "▼"} %,d ft/min".format(Locale.US, abs(it)) } ?: "level", color = Palette.accent, fontFamily = Mono,
                fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(4f)))
        }
        Text((t.speedKt?.let { "$it kt" } ?: "speed —") + (t.trackDeg?.let { " · heading $it° ${compass(it.toDouble())}" } ?: ""), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
        if (from.isNotEmpty()) Text("$from from you", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

@Composable
private fun UatDetail(sel: String, snap: UatProcessor.Snapshot, now: Long, me: Pair<Double, Double>?, accent: Color, modifier: Modifier, onMap: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    val kind = sel.take(2); val id = sel.drop(3)
    val title: String; val sub: String; val rows = ArrayList<Pair<String, String>>(); val extra = ArrayList<Pair<String, String>>()
    when (kind) {
        "wx" -> {
            val e = snap.metars[id] ?: return
            val m = e.first; val ap = Airports[id]
            title = id; sub = listOfNotNull(ap?.name, m.category).joinToString(" · ")
            rows.add("Observed" to listOf(hhmm(m.hh, m.mm), ago(e.second, now)).filter { it.isNotEmpty() }.joinToString(" · "))
            m.windKt?.let { rows.add("Wind" to if (it == 0) "calm" else "${m.windDir?.let { w -> "$w°" } ?: "variable"} at $it kt" + (m.gustKt?.let { g -> ", gusts $g" } ?: "")) }
            m.visSm?.let { rows.add("Visibility" to "${if (it % 1.0 == 0.0) it.toInt().toString() else it.toString()}${if (it >= 10) "+" else ""} statute miles") }
            if (m.sky.isNotEmpty()) rows.add("Sky" to m.sky.joinToString(", "))
            if (m.wx.isNotEmpty()) rows.add("Weather" to m.wx.joinToString(" "))
            m.tempC?.let { rows.add("Temperature" to "$it °C · ${f(it)} °F") }
            m.dewC?.let { rows.add("Dew point" to "$it °C") }
            m.altimInHg?.let { rows.add("Altimeter" to "%.2f inHg".format(Locale.US, it)) }
            ap?.let { a -> fromHere(me, a.lat, a.lon).takeIf { it.isNotEmpty() }?.let { rows.add("From you" to it) } }
            extra.add("" to m.raw)
            snap.texts.filter { it.kind == "TAF" && it.text.contains(id) }.forEach { extra.add("TAF" to it.text) }
            snap.texts.filter { it.kind.startsWith("NOTAM") && it.station == id.drop(1) }.take(8).forEach { extra.add(it.kind to it.text) }
        }
        "ac" -> {
            val p = snap.planes[id] ?: return
            val t = p.t
            title = t.callsign ?: t.address; sub = "${UatProcessor.source(t.qualifier)} · ${t.address}"
            t.altFt?.let { rows.add("Altitude" to "%,d ft (%s)".format(Locale.US, it, if (t.altGeo) "GPS" else "pressure")) }
            t.speedKt?.let { rows.add("Speed" to "$it kt") }
            t.trackDeg?.let { rows.add("Heading" to "$it° ${compass(it.toDouble())}") }
            t.vertFpm?.let { rows.add("Vertical" to "%+,d ft/min".format(Locale.US, it)) }
            if (t.lat != null && t.lon != null) {
                rows.add("Position" to "%.4f, %.4f".format(Locale.US, t.lat, t.lon))
                fromHere(me, t.lat, t.lon).takeIf { it.isNotEmpty() }?.let { rows.add("From you" to it) }
            }
            rows.add("First heard" to com.rocketgod.mayhem.core.lora.LoraHub.clock(p.first)); rows.add("Frames" to "${p.frames}")
        }
        "tw" -> {
            val t = snap.towers[id] ?: return
            title = "FIS-B"; sub = "ground station"
            rows.add("Position" to "%.4f, %.4f".format(Locale.US, t.lat, t.lon))
            fromHere(me, t.lat, t.lon).takeIf { it.isNotEmpty() }?.let { rows.add("From you" to it) }
            rows.add("Frames" to "${t.frames}"); rows.add("Last heard" to ago(t.at, now))
            snap.products.entries.sortedByDescending { it.value }.forEach { (pid, c) -> rows.add((UatProcessor.PRODUCT[pid] ?: "product $pid") to "$c") }
        }
        else -> return
    }
    Column(modifier.fillMaxWidth().heightIn(max = d.dp(440f)).clip(shape).background(Palette.paper).background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).verticalScroll(scroll).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(20f), maxLines = 1)
            Text(sub, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null && kind != "tw") ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer { FieldGrid(rows, labelWidth = 110f, minColumn = 260f) }
        for ((k, v) in extra) SelectionContainer {
            Text(if (k.isEmpty() || v.startsWith(k)) v else "$k  $v", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f))
        }
    }
}
