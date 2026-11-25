package com.rocketgod.mayhem.ui

import com.rocketgod.mayhem.core.Units
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import com.rocketgod.mayhem.core.uat.Fisb
import com.rocketgod.mayhem.core.uat.FisbTime
import com.rocketgod.mayhem.core.uat.Overlay
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
private fun argb(vararg c: Long, alpha: Int = 0xC8) = IntArray(c.size) { i -> if (c[i] == 0L) 0 else ((c[i].toInt() and 0x00FFFFFF) or (alpha shl 24)) }
/** Rain and snow 2-7 (light to heavy); level 1 is not drawn: on the national product it marks coverage, not rain. */
private val RADAR = argb(0, 0, 0xFF3DDC84, 0xFF1E9E4B, 0xFFF2DF34, 0xFFF39A1C, 0xFFE5382B, 0xFFC42597)
/** Icing by severity (trace to heavy). */
private val ICE = argb(0, 0xFF9FD9FF, 0xFF5FB4FF, 0xFF2F7DFF, 0xFF5A3DFF, 0xFFB04DFF, 0, 0)
/** Turbulence by level 2-14 (level 1 covers whole regions: smooth air, not drawn); 15 is no data. */
private val TURB = argb(0, 0, 0xFFF8C63C, 0xFFF8A33A, 0xFFF4793A, 0xFFEF4C3C, 0xFFE2304E, 0xFFD02A6E, 0xFFBD2C8E, 0xFFA63AA8, 0xFF8F4BC0, 0xFF7A5CD4, 0xFF6A6AE0, 0xFF5D75E8, 0xFF5D75E8, 0)
private val TOPS = argb(0, 0xFFD8E6FF, 0xFFC3D6FF, 0xFFADC6FF, 0xFF97B5FF, 0xFF81A4FF, 0xFF6C93FF, 0xFF5A82F4, 0xFF4D71E0, 0xFF4361CC, 0xFF3A52B8, 0xFF3245A4, 0xFF2B3990, 0xFF252F7C, 0xFF252F7C, 0)
private val LIGHTNING = argb(0, 0xFFFFF35C, 0xFFFFF35C, 0xFFFFE14A, 0xFFFFE14A, 0xFFFFCE38, 0xFFFFCE38, 0xFFFFBA26, 0xFFFFBA26, 0xFFFFA614, 0xFFFFA614, 0xFFFF9200, 0xFFFF9200, 0xFFFF7E00, 0xFFFF7E00, 0)
/** G-AIRMET kinds by element, with their colors. */
private val GAIRMET = mapOf(1 to ("TURBULENCE" to 0xFFF39A1C), 2 to ("LOW-LEVEL WIND SHEAR" to 0xFFFF7AD9), 3 to ("SURFACE WIND" to 0xFFA07CFF),
    4 to ("ICING" to 0xFF4AA3FF), 5 to ("FREEZING LEVEL" to 0xFF7FD6FF), 6 to ("IFR" to 0xFFFF5B52), 7 to ("MOUNTAIN OBSCURATION" to 0xFFD562FF))
private val ICE_WORD = listOf("none", "trace", "light", "moderate", "severe", "heavy", "", "")

private fun ftText(x: Int) = if (x >= 18000) "FL${x / 100}" else "%,d ft".format(Locale.US, x)
/** A G-AIRMET's altitudes or meaning in words. */
private fun altText(o: Overlay): String {
    val a = o.altsFt
    return when {
        o.element == 5 && o.line -> ftText(a.firstOrNull() ?: 0)
        o.element == 6 -> "ceiling below 1,000 ft or visibility below 3 mi"
        o.element == 7 -> "mountains hidden in cloud, haze or rain"
        o.element == 5 -> if (a.isEmpty() || a.last() == 0) "freezing at the surface" else "freezing level " + if (a.size > 1) "${ftText(a.first())} to ${ftText(a.last())}" else "up to ${ftText(a.first())}"
        a.isEmpty() || (a.size == 1 && a[0] == 0) -> "surface"
        a.size == 1 -> if (o.geometry == 4) "surface to ${ftText(a[0])} AGL" else "up to ${ftText(a[0])}"
        else -> "${ftText(a.first())} to ${ftText(a.last())}"
    }
}
private fun whenText(t: FisbTime) = "%d/%d %02d:%02dZ".format(Locale.US, t.month, t.day, t.hh, t.mm)
private fun validText(o: Overlay) = if (o.start == o.end) "for ${whenText(o.start)}" else "${whenText(o.start)} – ${whenText(o.end)}"
private fun ts(t: FisbTime): Long {
    val c = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
    var y = c.get(java.util.Calendar.YEAR); val m = c.get(java.util.Calendar.MONTH)
    if (t.month == 1 && m == 11) y++ else if (t.month == 12 && m == 0) y--
    c.clear(); c.set(y, t.month - 1, t.day, t.hh, t.mm); return c.timeInMillis
}
/** The G-AIRMETs for now: each kind's window covering now, else the latest one sent. */
private fun shapesNow(all: Collection<UatProcessor.Shape>, now: Long): List<UatProcessor.Shape> =
    all.groupBy { "${it.o.product}:${it.o.element}" }.values.flatMap { list ->
        val live = list.filter { ts(it.o.start) <= now && now < ts(it.o.end) }
        if (live.isNotEmpty()) live else { val latest = list.maxOf { ts(it.o.start) }; list.filter { ts(it.o.start) == latest } }
    }
private fun center(pts: List<Pair<Double, Double>>) = pts.sumOf { it.first } / pts.size to pts.sumOf { it.second } / pts.size
/** The bin of a block at lat, lon (northern row first). */
private fun binAt(lat0: Double, lon0: Double, dLat: Double, dLon: Double, bins: ByteArray?, lat: Double, lon: Double): Int {
    if (bins == null || lat < lat0 || lat >= lat0 + dLat || lon < lon0 || lon >= lon0 + dLon) return -1
    val x = minOf(31, ((lon - lon0) / dLon * 32).toInt()); val y = minOf(3, 3 - ((lat - lat0) / dLat * 4).toInt())
    return bins[y * 32 + x].toInt() and 0xff
}

/**
 * UAT (978 MHz): the FAA ground towers' FIS-B weather and the aircraft that broadcast on 978. MAP draws rain and snow
 * (regional, with the coarse national picture only where the tower's own radar does not reach), cloud tops, icing and
 * turbulence at a chosen altitude, lightning, G-AIRMETs, the airports colored by flight category, the towers and the
 * traffic; a tap on open map reads every layer at that spot. WEATHER is every airport report in plain words, nearest
 * first; NOTICES the G-AIRMETs, airspace and text; PLANES the aircraft. The twin of the web app's renderUat.
 */
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
    var layers by rememberSaveable { mutableStateOf(setOf("radar", "national", "lightning", "gairmet", "traffic", "airports")) }
    var altFt by rememberSaveable { mutableIntStateOf(8000) }
    fun on(k: String) = k in layers
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
    // first heard first: a card keeps its place instead of jumping each time a plane reports
    val planes = snap.planes.values.sortedWith(compareBy({ it.first }, { it.t.address }))
    val shapes = remember(snap) { shapesNow(snap.shapes.values, now) }
    val notices: List<Any> = remember(snap) {
        val order = listOf(6, 7, 1, 4, 2, 3, 5)
        shapes.filter { !it.o.line }.sortedBy { order.indexOf(it.o.element) } + snap.texts.sortedByDescending { it.at }
    }
    val cells = remember(snap, layers, altFt) {
        val out = ArrayList<RadarCell>()
        if (on("radar")) {
            // the national picture is coarse (each block 5 or 9 times a regional one): where the tower's regional radar
            // reports, clear or not, the national bins under it are left out
            if (on("national")) for (b in snap.national) {
                val src = b.bins ?: continue
                val bins = src.copyOf()
                for (i in 0 until 128) {
                    if (bins[i].toInt() == 0) continue
                    val la = b.lat + b.dLat * (3 - (i shr 5) + 0.5) / 4; val lo = b.lon + b.dLon * ((i and 31) + 0.5) / 32
                    val row = Math.floor(la * 15).toInt(); val col = Math.floor(((lo + 360) % 360) / 0.8).toInt()
                    if ((row * 450 + col) in snap.regionalSeen) bins[i] = 0
                }
                if (bins.any { it >= 2 }) out.add(RadarCell(b.lat, b.lon, b.dLat, b.dLon, 32, 4, bins))
            }
            for (b in snap.regional) b.bins?.let { out.add(RadarCell(b.lat, b.lon, b.dLat, b.dLon, 32, 4, it)) }
        }
        fun grid(id: Int, colors: IntArray, level: Int?, map: ((Int) -> Int)? = null) {
            for (b in snap.hazards[id] ?: emptyList()) {
                val bins = b.bins ?: continue
                if (level != null && b.level != level) continue
                out.add(RadarCell(b.lat, b.lon, b.dLat, b.dLon, 32, 4, if (map == null) bins else ByteArray(128) { map(bins[it].toInt() and 0xff).toByte() }, colors))
            }
        }
        val low = altFt <= 16000; val lvl = if (low) altFt / 2000 - 1 else (altFt - 18000) / 2000
        if (on("tops")) grid(84, TOPS, null)
        if (on("ice")) grid(if (low) 70 else 71, ICE, lvl) { Fisb.icingSeverity(it) }
        if (on("turb")) grid(if (low) 90 else 91, TURB, lvl)
        if (on("lightning")) grid(103, LIGHTNING, null)
        out
    }
    val geoShapes = remember(shapes, layers, sel) {
        if (!on("gairmet")) emptyList() else shapes.map { s -> GeoShape("gm:${s.key}", s.o.pts, s.o.line, (GAIRMET[s.o.element]?.second ?: 0xFFFF5B52).toInt(), s.o.element == 5, sel == "gm:${s.key}") }
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
    fun layerRow() {
        val scroll = rememberScrollState()
        Row(Modifier.fillMaxWidth().scrollGlow(scroll, horizontal = true).horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
            verticalAlignment = Alignment.CenterVertically) {
            for ((k, label) in listOf("radar" to "RADAR", "national" to "NATIONAL", "tops" to "CLOUD TOPS", "turb" to "TURBULENCE", "ice" to "ICING",
                "lightning" to "LIGHTNING", "gairmet" to "G-AIRMET", "traffic" to "TRAFFIC", "airports" to "AIRPORTS")) {
                LayerPill(label, on(k), accent) { layers = if (on(k)) layers - k else layers + k }
            }
            if (on("ice") || on("turb")) AltPill(altFt, accent) { altFt = it }
        }
    }

    @Composable
    fun legend() {
        val ramps = buildList {
            if (on("radar")) add(Triple("RAIN / SNOW", RADAR.drop(2), "light → heavy"))
            if (on("tops")) add(Triple("TOPS", TOPS.slice(1..13 step 3), "low → high"))
            if (on("turb")) add(Triple("TURB ${ftText(altFt)}", TURB.slice(2..14 step 3), "light → severe"))
            if (on("ice")) add(Triple("ICE ${ftText(altFt)}", ICE.slice(1..5), "trace → heavy"))
        }
        if (ramps.isEmpty()) return
        val scroll = rememberScrollState()
        Row(Modifier.fillMaxWidth().horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(d.dp(12f)), verticalAlignment = Alignment.CenterVertically) {
            for ((name, cols, words) in ramps) Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("$name ", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp)
                for (c in cols) Box(Modifier.size(d.dp(12f), d.dp(7f)).background(Color(c or (0xFF shl 24)), RoundedCornerShape(2.dp)))
                Text(" $words", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
            }
        }
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            when (view) {
                0 -> {
                    val items = ArrayList<GeoItem>(); val paths = ArrayList<GeoPath>()
                    for ((k, t) in snap.towers) items.add(GeoItem("tw:$k", t.lat, t.lon, "FIS-B", GeoItem.Kind.TOWER))
                    if (on("airports") && airportsLoaded) for ((id, e) in snap.metars) {
                        val ap = Airports[id] ?: continue
                        items.add(GeoItem("wx:$id", ap.lat, ap.lon, id, GeoItem.Kind.AIRPORT, color = (CAT[e.first.category] ?: Palette.muted).toArgb()))
                    }
                    if (on("traffic")) for (p in planes) {
                        val la = p.t.lat ?: continue; val lo = p.t.lon ?: continue
                        items.add(GeoItem("ac:${p.t.address}", la, lo, (p.t.callsign ?: p.t.address) + (p.t.altFt?.let { " ${it / 100}" } ?: ""), GeoItem.Kind.PLANE, p.t.trackDeg?.toDouble()))
                        if (p.track.size > 1) paths.add(GeoPath(p.track, faint = sel != "ac:${p.t.address}"))
                    }
                    val focus = when {
                        sel.startsWith("ac:") -> snap.planes[sel.drop(3)]?.let { p -> p.t.lat?.let { la -> p.t.lon?.let { la to it } } }
                        sel.startsWith("wx:") -> Airports[sel.drop(3)]?.let { it.lat to it.lon }
                        sel.startsWith("gm:") -> snap.shapes[sel.drop(3)]?.let { center(it.o.pts) }
                        fix == null -> snap.towers.values.firstOrNull()?.let { it.lat to it.lon }
                        else -> null
                    }
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        layerRow()
                        legend()
                        GeoMapView(items, accent, Modifier.fillMaxWidth().weight(1f).panel(), home = fix, selected = sel.ifEmpty { null },
                            layers = GeoLayers(paths = paths, radar = cells, radarColors = RADAR, shapes = geoShapes), start = remember { mapStart(fix) },
                            focus = focus, focusKey = focusKey + (if (fix == null && snap.towers.isNotEmpty()) 1000 else 0), autoFollow = false,
                            onMapTap = { la, lo -> sel = "pt:%.4f,%.4f".format(Locale.US, la, lo) }) { id -> sel = id }
                    }
                }
                1 -> CardGrid(metars, { it.first }) { (id, e, _) -> WxCard(id, e.first, e.second, now, sel == "wx:$id", me) { sel = if (sel == "wx:$id") "" else "wx:$id" } }
                2 -> CardGrid(notices, { if (it is UatProcessor.Shape) "gm:${it.key}" else (it as UatProcessor.Text).text.take(64) }) { n ->
                    if (n is UatProcessor.Shape) ShapeCard(n, now, sel == "gm:${n.key}", me) { sel = if (sel == "gm:${n.key}") "" else "gm:${n.key}" }
                    else (n as UatProcessor.Text).let { t -> if (t.kind == "SUA") SuaCard(t, now) else TextCard(t, now) }
                }
                3 -> CardGrid(planes, { it.t.address }) { p -> PlaneCard(p, now, sel == "ac:${p.t.address}", me) { sel = if (sel == "ac:${p.t.address}") "" else "ac:${p.t.address}" } }
            }
            if (sel.isNotEmpty() && (view == 0 || (view == 1 && sel.startsWith("wx:")) || (view == 2 && sel.startsWith("gm:")) || (view == 3 && sel.startsWith("ac:"))))
                UatDetail(sel, snap, now, me, accent, altFt, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                    onMap = if (view != 0) ({ view = 0; focusKey++ }) else null) { sel = "" }
        }
    }

    PacketFrame(accent, Apps.uatLog, tag = "FLIGHT UAT", title = "FLIGHT WEATHER · SMALL PLANES", tunable = false, emptyKey = "uat", waterfall = wf,
        onWaterfall = { Apps.setWaterfall(MayhemApp.UAT, !wf) },
        lamp = {
            if (snap.up > 0 || snap.down > 0) Lamp("RECEIVING", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = { summary() },
        body = {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(8f), bottom = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
                verticalAlignment = Alignment.CenterVertically) {
                ScrollSeg(listOf("MAP", "WEATHER", "NOTICES", "PLANES", "LOG"), view, accent, Modifier.weight(1f)) { view = it }
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { Apps.uat.clear(); sel = "" }
            }
            if (view == 4) LogList(logSnap.lines, Modifier.fillMaxWidth().weight(1f), total = logSnap.total, accent = accent, empty = "listening for FIS-B…") { line ->
                // a log line opens what it was about
                val rest = line.substringAfter("AIRCRAFT ", "")
                when {
                    rest.isNotEmpty() -> snap.planes.values.firstOrNull { p -> rest.startsWith(p.t.callsign ?: p.t.address) || rest.startsWith(p.t.address) }?.let { sel = "ac:${it.t.address}"; view = 3 }
                    line.contains("METAR ") -> Regex("METAR (\\w{3,4})").find(line)?.groupValues?.get(1)?.takeIf { snap.metars.containsKey(it) }?.let { sel = "wx:$it"; view = 1 }
                    line.contains("TOWER") -> snap.towers.keys.firstOrNull()?.let { sel = "tw:$it"; view = 0 }
                    line.contains("FISB") -> view = 2
                }
            }
            else stage(Modifier.fillMaxWidth().weight(1f))
        })
}

/** Tabs that keep their full labels: as wide as the row when they fit, scrolling sideways when they do not. */
@Composable
private fun ScrollSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val outer = RoundedCornerShape(d.dp(12f)); val inner = RoundedCornerShape(d.dp(9f))
    val scroll = rememberScrollState()
    var widthPx by remember { mutableIntStateOf(0) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    // as wide as the row when the labels fit (measured, not intrinsic, so it can sit in an IntrinsicSize row)
    Box(modifier.background(Palette.surface, outer).border(1.dp, Palette.line, outer).padding(3.dp).onSizeChanged { widthPx = it.width }) {
        val minW = with(density) { ((widthPx.toDp() - 3.dp * (labels.size - 1)) / labels.size).coerceAtLeast(0.dp) }
        Row(Modifier.scrollGlow(scroll, horizontal = true).horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            labels.forEachIndexed { i, label ->
                val on = i == selected
                Box(Modifier.widthIn(min = minW).clip(inner).background(if (on) accent else Color.Transparent).clickable { onPick(i) }
                    .padding(horizontal = d.dp(10f), vertical = d.dp(8f)), contentAlignment = Alignment.Center) {
                    Text(label, color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
                        letterSpacing = 1.2.sp, maxLines = 1, softWrap = false)
                }
            }
        }
    }
}

/** A map layer switch: lit when the layer is drawn. */
@Composable
private fun LayerPill(label: String, on: Boolean, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(50)
    Text(label, color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(shape).background(if (on) accent else Color.Transparent).border(1.dp, if (on) accent else Palette.line, shape)
            .clickable { onClick() }.padding(horizontal = d.dp(11f), vertical = d.dp(5f)))
}

/** The altitude icing and turbulence are drawn at, 2,000 to 24,000 ft. */
@Composable
private fun AltPill(altFt: Int, accent: Color, onPick: (Int) -> Unit) {
    val d = rememberDims()
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(50)
    Box {
        Text("%,d FT ▾".format(Locale.US, altFt), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1,
            modifier = Modifier.clip(shape).border(1.dp, accent, shape).clickable { open = true }.padding(horizontal = d.dp(11f), vertical = d.dp(5f)))
        DropdownMenu(open, { open = false }, containerColor = Palette.surface) {
            for (a in 2000..24000 step 2000) DropdownMenuItem(text = { Text("%,d ft".format(Locale.US, a), color = if (a == altFt) accent else Palette.ink, fontFamily = Mono, fontSize = d.sp(12f)) },
                onClick = { onPick(a); open = false })
        }
    }
}

@Composable
private fun ShapeCard(s: UatProcessor.Shape, now: Long, selected: Boolean, me: Pair<Double, Double>?, onClick: () -> Unit) {
    val d = rememberDims()
    val (name, col) = GAIRMET[s.o.element] ?: ("AREA" to 0xFFFF5B52)
    val color = Color(col)
    val (la, lo) = center(s.o.pts)
    val from = fromHere(me, la, lo)
    val live = ts(s.o.start) <= now && now < ts(s.o.end)
    CardBox(selected, color, onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(if (s.o.product == 14) "G-AIRMET" else "AREA", color = color, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
            Column(Modifier.weight(1f)) {
                Text(name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(validText(s.o) + if (live) " · NOW" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
            }
        }
        Text(altText(s.o), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
        Text("${s.o.pts.size} points" + if (from.isNotEmpty()) " · centered $from from you" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

@Composable
private fun SuaCard(t: UatProcessor.Text, now: Long) {
    val d = rememberDims()
    val s = Fisb.sua(t.text) ?: return TextCard(t, now)
    fun ft(x: Int?) = when { x == null -> ""; x == 0 -> "surface"; else -> ftText(x) }
    CardBox(false, Palette.accent, onClick = null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text("SUA", color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f))
            Text(s.name.ifEmpty { "special use airspace" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.weight(1f), maxLines = 1)
            Text(ago(t.at, now), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
        Text(listOf(ft(s.bottomFt), ft(s.topFt)).filter { it.isNotEmpty() }.joinToString(" to "), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
        Text(listOfNotNull(s.from, s.to).joinToString(" – "), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
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
/** A METAR temperature for the big clock face, in the units picked in Settings: "19°" or "66°". */
private fun f(c: Int) = Units.tempNumber(c.toDouble())

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
            Text(m.tempC?.let { f(it) } ?: "—", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(Units.tempUnit() + (m.dewC?.let { " · dew ${f(it)}" } ?: ""), color = Palette.muted, fontFamily = Mono,
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
private fun UatDetail(sel: String, snap: UatProcessor.Snapshot, now: Long, me: Pair<Double, Double>?, accent: Color, altFt: Int, modifier: Modifier, onMap: (() -> Unit)?, onClose: () -> Unit) {
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
            m.tempC?.let { rows.add("Temperature" to Units.fmtTemp(it.toDouble(), 0)) }
            m.dewC?.let { rows.add("Dew point" to Units.fmtTemp(it.toDouble(), 0)) }
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
        "gm" -> {
            val s = snap.shapes[id] ?: return
            val (name, _) = GAIRMET[s.o.element] ?: ("AREA" to 0L)
            val (la, lo) = center(s.o.pts)
            title = if (s.o.product == 14) "G-AIRMET" else "AREA"; sub = name
            rows.add("Valid" to validText(s.o))
            rows.add((if (s.o.element == 5 && s.o.line) "Freezing level" else if (s.o.element >= 5) "What" else "Altitude") to altText(s.o))
            rows.add("Shape" to "${if (s.o.line) "line" else "area"} · ${s.o.pts.size} points")
            rows.add("Center" to "%.3f, %.3f".format(Locale.US, la, lo))
            fromHere(me, la, lo).takeIf { it.isNotEmpty() }?.let { rows.add("From you" to it) }
            if (s.o.report != 0) rows.add("Report" to "#${s.o.report}")
            rows.add("Heard" to ago(s.at, now))
        }
        "pt" -> {
            val (la, lo) = id.split(',').map { it.toDouble() }.let { it[0] to it[1] }
            title = "HERE"; sub = "%.3f, %.3f".format(Locale.US, la, lo) + fromHere(me, la, lo).let { if (it.isNotEmpty()) " · $it from you" else "" }
            val rain = (snap.regional + snap.national).maxOfOrNull { binAt(it.lat, it.lon, it.dLat, it.dLon, it.bins, la, lo) } ?: -1
            rows.add("Rain / snow" to if (rain >= 2) "${listOf("", "", "light", "light", "moderate", "moderate", "heavy", "extreme")[rain]} (level $rain)" else "nothing falling")
            fun at(pid: Int, level: Int? = null) = (snap.hazards[pid] ?: emptyList()).filter { level == null || it.level == level }
                .map { binAt(it.lat, it.lon, it.dLat, it.dLon, it.bins, la, lo) }.firstOrNull { it >= 0 }
            if (snap.hazards.containsKey(84)) rows.add("Cloud tops" to (at(84)?.takeIf { it in 1..14 }?.let { "level $it of 14" } ?: "clear"))
            if (snap.hazards.containsKey(103)) rows.add("Lightning" to (at(103)?.takeIf { it in 1..14 }?.let { "level $it" } ?: "none"))
            for (sh in shapesNow(snap.shapes.values, now)) if (!sh.o.line && inPoly(la, lo, sh.o.pts)) rows.add("G-AIRMET" to "${GAIRMET[sh.o.element]?.first ?: "AREA"} · ${altText(sh.o)}")
            for (a in 2000..24000 step 2000) {
                val low = a <= 16000; val lvl = if (low) a / 2000 - 1 else (a - 18000) / 2000
                val ice = at(if (low) 70 else 71, lvl)?.let { Fisb.icingSeverity(it) }?.takeIf { it in 1..5 }
                val turb = at(if (low) 90 else 91, lvl)?.takeIf { it in 1..14 }
                val parts = listOfNotNull(ice?.let { "icing ${ICE_WORD[it]}" }, turb?.let { "turbulence $it/14" })
                if (parts.isNotEmpty()) rows.add(ftText(a).uppercase() to parts.joinToString(" · "))
            }
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
            if (onMap != null && kind != "tw" && kind != "pt") ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer { FieldGrid(rows, labelWidth = 110f, minColumn = 260f) }
        for ((k, v) in extra) SelectionContainer {
            Text(if (k.isEmpty() || v.startsWith(k)) v else "$k  $v", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f))
        }
    }
}
