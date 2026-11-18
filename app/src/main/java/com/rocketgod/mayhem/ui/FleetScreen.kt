package com.rocketgod.mayhem.ui

import android.widget.Toast
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
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
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.fleet.CarrierRow
import com.rocketgod.mayhem.core.fleet.FleetProcessor
import com.rocketgod.mayhem.core.fleet.FleetSnap
import com.rocketgod.mayhem.core.fleet.GrantRow
import com.rocketgod.mayhem.core.fleet.Iden
import com.rocketgod.mayhem.core.fleet.SiteRow
import com.rocketgod.mayhem.core.fleet.SystemRow
import com.rocketgod.mayhem.core.fleet.hx
import kotlinx.coroutines.delay
import kotlin.math.max

/** One color per system, used on the cards, the map, the feed and the frequency list. */
private val FLEET_COLORS = listOf(0xFF4C8DFF, 0xFFFFAF00, 0xFF3DDC84, 0xFFFF5BD2, 0xFF00D5FF, 0xFFFF7A45, 0xFFB18CFF, 0xFFE8E14A, 0xFFFF5B52, 0xFF52FFB8).map { Color(it) }
private val VIEWS = listOf("SYSTEMS", "MAP", "GRANTS", "FREQS", "LOG")
/** On a wide screen the map has the big pane, so it is not a tab. */
private val WIDE_VIEWS = listOf(0, 2, 3, 4)

private fun mhz(hz: Long, d: Int = 5): String = if (hz > 0) "%.${d}f".format(java.util.Locale.US, hz / 1e6) else "-"
private fun mhz(hz: Double, d: Int = 5): String = if (hz > 0) "%.${d}f".format(java.util.Locale.US, hz / 1e6) else "-"
private fun flAgo(ms: Long): String = when {
    ms < 2_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s"
    ms < 3_600_000 -> "${ms / 60_000} min"
    else -> "${ms / 3_600_000} h"
}
private fun flAgoText(ms: Long): String = flAgo(ms).let { if (it == "now") it else "$it ago" }
private fun flClock(ms: Long): String = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(ms))
private fun liveCarriers(s: FleetSnap, now: Long) = s.carriers.filter { it.hz > s.spanLo && it.hz < s.spanHi && now - it.lastMs < 4_000 }

/**
 * Fleet: trunked radio systems from their control channels, receive only. P25 Phase 1 and DMR: every carrier in the
 * span is found and the live ones decoded at once. SYSTEMS groups what is heard by trunk (each system in its own
 * color everywhere), MAP puts the units that report a position where they say they are, GRANTS is the live feed with
 * per-talkgroup activity, FREQS every carrier in the span, LOG every decoded block. A tap opens all it carried.
 */
@Composable
fun FleetScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val live by Apps.fleet.snap.collectAsState()
    val band by Apps.fleetBand.collectAsState()
    val scan by Apps.fleetScan.collectAsState()
    val logSnap by Apps.fleetLog.snapshot.collectAsState()
    val fix by Geo.fix.collectAsState()
    val kind by Radio.kind.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    /** What is open for its details: "unit:<key>", "tg:<key>", "sys:<key>" or "car:<key>". */
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var held by remember { mutableStateOf<FleetSnap?>(null) }
    var full by remember { mutableStateOf(false) }
    var focusKey by remember { mutableIntStateOf(0) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { Geo.start(ctx) }
    LaunchedEffect(fix) { Apps.fleetRef(fix) }
    // the band scan runs while the screen is up
    LaunchedEffect(Unit) { while (true) { delay(500); Apps.fleetTick(System.currentTimeMillis()) } }
    val s = held ?: live
    val colorOf: (String) -> Color = { key -> s?.systems?.firstOrNull { it.key == key }?.let { FLEET_COLORS[it.color % FLEET_COLORS.size] } ?: Palette.muted }
    val pins = s?.units.orEmpty().filter { it.lat != null && it.lon != null }
    val mapItems = pins.map { GeoItem(it.key, it.lat!!, it.lon!!, "${it.id}", GeoItem.Kind.STATION, color = colorOf(it.sys).toArgb()) }
    val trails = s?.units.orEmpty().filter { it.trail.size > 1 }.map { u -> GeoShape(u.key, u.trail.map { it.lat to it.lon }, true, colorOf(u.sys).toArgb(), sel = sel == "unit:${u.key}") }
    val wf = waterfallOn(MayhemApp.FLEET, phoneDefault = false)
    val wide = d.wide
    LaunchedEffect(wide) { if (wide) { if (view == 1) view = 0; full = false } }
    val tabs = if (wide) WIDE_VIEWS else VIEWS.indices.toList()

    fun pick(k: String) { sel = if (sel == k) null else k }
    fun export() {
        val (csv, json) = Apps.fleet.exportAll(); val stamp = Saves.stamp()
        val a = Saves.toDownloads(ctx, "fleet-log-$stamp.csv", "text/csv", csv.toByteArray())
        val b = Saves.toDownloads(ctx, "fleet-tables-$stamp.json", "application/json", json.toByteArray())
        Toast.makeText(ctx, if (a != null && b != null) "saved $a and $b" else "could not save", Toast.LENGTH_LONG).show()
    }

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        val counts = listOf("${s?.systems?.size ?: 0}", "${pins.size}", "${s?.grants?.size ?: 0}", "${s?.let { liveCarriers(it, now).size } ?: 0}", "${logSnap.total}")
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.Top) {
            FlSeg(tabs.map { "${VIEWS[it]} ${counts[it]}" }, tabs.indexOf(view), accent, Modifier.weight(1f)) { view = tabs[it] }
            ToggleBox("EXPORT", false, accent) { export() }
            ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent) { held = if (held == null) live else null }
            IconBox(ClearIcon, "Clear") { Apps.fleet.clear(); Apps.fleetLog.clear(); held = null; sel = null }
            if (withFull && !wide) IconBox(FullscreenIcon, "Full screen") { full = true }
        }
    }

    @Composable
    fun fleetMap(modifier: Modifier) {
        Box(modifier) {
            val pu = pins.firstOrNull { "unit:${it.key}" == sel }
            GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = fix, selected = pu?.key, layers = GeoLayers(shapes = trails),
                start = remember { mapStart(Geo.fix.value) }, focus = pu?.let { it.lat!! to it.lon!! }, focusKey = focusKey, steady = true, fitPins = true,
                // unit reports carry only the low bits of a position: with no position of our own, the region on the map resolves them
                onDragEnd = { lat, lon -> if (Geo.fix.value == null && Geo.lastKnownPos() == null) Apps.fleet.setRef(lat, lon) }) { pick("unit:$it") }
            if (pins.isEmpty()) Text(if (s != null && s.units.any { it.posMs > 0 } && !s.ref) "unit positions need a region: drag the map to your area" else "no unit positions on the air yet",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
        }
    }

    @Composable
    fun detail(modifier: Modifier) {
        if (s != null && sel != null) {
            val det = fleetDetail(s, sel!!, now, if (wide) 1 else view)
            if (det != null) FleetDetailPanel(det, accent, modifier, onMap = if (det.mapKey != null) ({ if (!wide) view = 1; focusKey++ }) else null, onPick = ::pick) { sel = null }
        }
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            val gap = Arrangement.spacedBy(d.dp(8f))
            when (view) {
                0 -> if (s == null || s.systems.isEmpty()) EmptyState("fleet", Modifier.fillMaxSize().panel(), accent)
                    // two to a row where the column holds them
                    else LazyVerticalGrid(GridCells.Adaptive(d.dp(if (wide) 330f else 600f)), Modifier.fillMaxSize(), verticalArrangement = gap, horizontalArrangement = gap) {
                        items(s.systems, key = { it.key }) { x -> SystemCard(x, s, now, sel == "sys:${x.key}", colorOf, ::pick) }
                    }
                1 -> fleetMap(Modifier.fillMaxSize())
                2 -> if (s == null) EmptyState("fleet", Modifier.fillMaxSize().panel(), accent) else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    item(key = "bars") { TgBars(s, now, colorOf, ::pick) }
                    if (s.grants.isEmpty()) item(key = "none") { FlDim("no grants yet · a quiet system may go minutes between calls") }
                    items(s.grants, key = { "${it.sys}|${it.tg}|${it.ch}|${it.ms}" }) { g -> GrantLine(g, now, colorOf(g.sys), ::pick) }
                }
                3 -> if (s == null || s.carriers.none { now - it.lastMs < 600_000 }) FlDim("no carriers found yet", Modifier.fillMaxSize())
                    else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                        items(s.carriers.filter { now - it.lastMs < 600_000 }, key = { it.key }) { c -> FreqLine(c, s, now, sel == "car:${c.key}", if (c.sys.isNotEmpty()) colorOf(c.sys) else Color.Transparent, ::pick) }
                    }
                else -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "watching for control channels…", total = logSnap.total, accent = accent)
            }
            if (!wide) detail(Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)))
        }
    }

    PacketFrame(accent, Apps.fleetLog, tag = "FLEET", title = "P25 · DMR TRUNKING", roomy = true, waterfall = wf,
        widePane = { m -> fleetMap(m) },
        onWaterfall = { Apps.setWaterfall(MayhemApp.FLEET, !wf) },
        lamp = {
            if (s != null && s.systems.isNotEmpty()) Lamp("${s.systems.size} SYSTEM${if (s.systems.size == 1) "" else "S"}", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = {
            FlSeg(listOf("AUTO") + FleetProcessor.BANDS.map { if (it.id == "TBAND") "T-BAND" else it.id }, (listOf("AUTO") + FleetProcessor.BANDS.map { it.id }).indexOf(band), accent, Modifier.fillMaxWidth()) {
                Apps.setFleetBand(if (it == 0) "AUTO" else FleetProcessor.BANDS[it - 1].id)
            }
            if (kind != Radio.Kind.RTLSDR) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("SPAN")
                val whys = FleetProcessor.SPANS.map { Radio.rateWhy(it.first) }
                SegBar(FleetProcessor.SPANS.map { it.second }, FleetProcessor.SPANS.indexOfFirst { it.first == rate }, accent, Modifier.weight(1f),
                    tints = whys.map { if (it.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null }) { i -> gated(whys[i]) { Apps.setFleetSpan(FleetProcessor.SPANS[i].first) }() }
            }
        }, body = {
            Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                FleetHead(s, scan, now, accent)
                switcher(true, Modifier.fillMaxWidth())
                // a wide screen docks the details above the cards
                if (wide) detail(Modifier.fillMaxWidth())
                stage(Modifier.fillMaxWidth().weight(1f))
            }
        })
    if (full) FullscreenPanel("FLEET · ${VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

@Composable
private fun FlDim(text: String, modifier: Modifier = Modifier) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = modifier.padding(d.dp(8f)))
}

/** What it is watching (band and span), the counters, and the scan state. */
@Composable
private fun FleetHead(s: FleetSnap?, scan: Apps.FleetScan, now: Long, accent: Color) {
    val d = rememberDims()
    val w = scan.windows.getOrNull(scan.idx); val c = s?.centerHz ?: w?.hz ?: 0L
    val band = FleetProcessor.BANDS.firstOrNull { c >= it.lo - 2_000_000 && c <= it.hi + 2_000_000 } ?: FleetProcessor.BANDS.firstOrNull { it.id == w?.band }
    val scanText = if (scan.windows.size > 1) "${if (Apps.fleetBand.value == "AUTO") "AUTO SCAN" else "SCAN"} · ${scan.idx + 1}/${scan.windows.size} · ${if (scan.found) "STAYING" else "NEXT"} ${max(0L, (scan.dwellEnd - now + 999) / 1000)} s" else "HOLDING"
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(band?.let { "${it.label} MHz" } ?: "", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1)
            Text(if (s != null) "${mhz(s.spanLo, 3)}–${mhz(s.spanHi, 3)} MHz · ${liveCarriers(s, now).size} carriers · ${s.slots} decoding" else "", color = Palette.muted, fontFamily = Mono,
                fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(scanText, color = if (scan.found) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val sites = s?.systems?.sumOf { it.sites.size } ?: 0
            for ((n, l) in listOf("${s?.systems?.size ?: 0}" to "SYSTEMS", "$sites" to "SITES", "${s?.units?.size ?: 0}" to "UNITS", "${s?.perMin ?: 0}" to "GRANTS/MIN", "${s?.blocks ?: 0}" to "BLOCKS")) {
                Column(Modifier.weight(1f).panel().padding(horizontal = d.dp(6f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun FlPill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, c.copy(alpha = 0.7f), RoundedCornerShape(50)).background(c.copy(alpha = 0.10f))
            .padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
}

/** A level bar, 0..1. */
@Composable
private fun FlBar(frac: Float, c: Color, modifier: Modifier) {
    val track = Palette.line
    Canvas(modifier) {
        drawRoundRect(track.copy(alpha = 0.6f), cornerRadius = CornerRadius(size.height / 2))
        drawRoundRect(c, size = Size(size.width * frac.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height / 2))
    }
}

private fun sysTitle(x: SystemRow) = when {
    x.proto == "P25" -> "WACN ${hx(x.wacn, 5)} · SYS ${hx(x.sysId, 3)}"
    x.net >= 0 -> "${x.model} NET ${x.net}"
    else -> "CC ${x.cc}${if (x.fid > 0) " · FID ${hx(x.fid, 2)}" else ""}"
}

/** One trunk: its identity, its sites with their control channels, channel tables and neighbors. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SystemCard(x: SystemRow, s: FleetSnap, now: Long, selected: Boolean, colorOf: (String) -> Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val col = colorOf(x.key); val age = now - x.lastMs; val flash = max(0f, 1 - age / 1500f); val live = age < 15_000
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.75f).clip(shape)
        .background(Brush.linearGradient(listOf(col.copy(alpha = 0.10f + 0.16f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, col.copy(alpha = if (selected) 1f else 0.35f + 0.6f * flash), shape).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Row(Modifier.fillMaxWidth().clickable { pick("sys:${x.key}") }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            FlPill(x.proto, col)
            Column(Modifier.weight(1f)) {
                Text(sysTitle(x), color = col, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${if (x.callsign.isNotEmpty()) "${x.callsign} · " else ""}${x.sites.size} site${if (x.sites.size == 1) "" else "s"} · ${x.units} units · ${x.tgs} talkgroups · ${x.grants} grants${if (x.derived) " · derived formats" else ""}",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                Box(Modifier.size(d.dp(8f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
                Text(if (live) "LIVE" else flAgo(age), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
            }
        }
        for (site in x.sites) SiteBlock(x, site, s, now, col, pick)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SiteBlock(sys: SystemRow, site: SiteRow, s: FleetSnap, now: Long, col: Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val age = now - site.lastMs; val live = age < 10_000
    val cars = site.carriers.mapNotNull { k -> s.carriers.firstOrNull { it.key == k } }
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.7f).panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(if (sys.proto == "P25") "SITE ${site.label}" else site.label.uppercase(), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            if (site.callsign.isNotEmpty() && sys.proto == "P25") Text(site.callsign, color = col, fontFamily = Mono, fontSize = d.sp(10f))
            FlBar((site.levelDb / 50).toFloat(), col, Modifier.weight(1f).height(d.dp(5f)))
            Text("%.0f dB · %s".format(java.util.Locale.US, site.levelDb, flAgo(age)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (c in cars) {
                val role = when (c.role) { "rest" -> "REST"; "control" -> if (sys.proto == "P25") "CONTROL" else "REPEATER"; else -> c.role.uppercase() }
                Column(Modifier.clip(RoundedCornerShape(d.dp(8f))).border(1.dp, col.copy(alpha = if (c.role == "rest") 1f else 0.5f), RoundedCornerShape(d.dp(8f)))
                    .background(col.copy(alpha = if (c.role == "rest") 0.18f else 0.06f)).clickable { pick("car:${c.key}") }.padding(horizontal = d.dp(7f), vertical = d.dp(3f))) {
                    Text(mhz(c.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
                    Text(role + if (c.lcn.isNotEmpty()) " · LCN ${c.lcn}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                }
            }
        }
        if (sys.proto == "P25") {
            FlKv(listOfNotNull("NAC" to (if (site.nac >= 0) hx(site.nac, 3) else "-"), "RFSS" to "${site.rfss}", "SITE" to "${site.site}", if (site.time.length >= 19) "CLOCK" to site.time.substring(11, 19) else null))
            if (site.neighbors.isNotEmpty()) FlChips("NEIGHBORS", site.neighbors.map { "${it.label} ${mhz(it.hz)}" to it.heard }, col)
            if (site.secondary.isNotEmpty()) FlChips("SECONDARY", site.secondary.map { mhz(it.first) to false }, col)
            IdenTable(site.idens)
        } else {
            if (site.lcns.isNotEmpty() || site.rest >= 0) {
                val chips = site.lcns.map { l -> "LCN ${l.lcn} ${mhz(l.hz)} TS${l.slot + 1}" to (l.lcn == site.rest) } +
                    (if (site.rest >= 0 && site.lcns.none { it.lcn == site.rest }) listOf("LCN ${site.rest} rest, not heard" to true) else emptyList()) +
                    site.busy.filter { n -> site.lcns.none { it.lcn == n } }.map { "LCN $it busy" to false }
                FlChips("CHANNELS", chips, col)
            }
            FlKv(listOfNotNull("UNITS" to "${site.units}", if (site.rest >= 0) "REST" to "LCN ${site.rest}" else null))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlKv(kv: List<Pair<String, String>>) {
    val d = rememberDims()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(12f))) {
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(v, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
        }
    }
}

/** A labeled row of chips; a lit one (heard, or the rest channel) in the system's color. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlChips(label: String, chips: List<Pair<String, Boolean>>, col: Color, onTap: ((Int) -> Unit)? = null) {
    val d = rememberDims()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
        chips.forEachIndexed { i, (t, lit) ->
            val m = Modifier.clip(RoundedCornerShape(50)).border(1.dp, if (lit) col else Palette.line, RoundedCornerShape(50)).background(if (lit) col.copy(alpha = 0.14f) else Color.Transparent)
            Text(t, color = if (lit) Palette.ink else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1,
                modifier = (if (onTap != null) m.clickable { onTap(i) } else m).padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
        }
    }
}

/** A channel table as heard: identifier, base, step, offset and kind. */
@Composable
private fun IdenTable(idens: List<Iden>) {
    val d = rememberDims()
    if (idens.isEmpty()) { Text("no channel table heard yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f)); return }
    val cols = listOf(0.12f, 0.28f, 0.2f, 0.2f, 0.2f)
    @Composable
    fun row(cells: List<String>, head: Boolean) = Row(Modifier.fillMaxWidth()) {
        cells.forEachIndexed { i, c -> Text(c, color = if (head) Palette.muted else Palette.ink, fontFamily = Mono, fontWeight = if (head) FontWeight.Bold else FontWeight.Normal,
            fontSize = d.sp(if (head) 8f else 9.5f), maxLines = 1, modifier = Modifier.weight(cols[i])) }
    }
    Column {
        row(listOf("ID", "BASE MHz", "STEP", "OFFSET", "KIND"), true)
        for (i in idens) row(listOf("${i.iden}", "%.5f".format(java.util.Locale.US, i.base / 1e6), "%.3fk".format(java.util.Locale.US, i.spacing / 1e3),
            (if (i.txOffset >= 0) "+" else "") + "%.3f".format(java.util.Locale.US, i.txOffset / 1e6), if (i.tdma) "TDMA ×${i.slots}" else i.form), false)
    }
}

/** Per-talkgroup activity over the last 10 minutes, busiest first. */
@Composable
private fun TgBars(s: FleetSnap, now: Long, colorOf: (String) -> Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val tgs = s.tgs.filter { it.recent.isNotEmpty() }.sortedWith(compareByDescending<com.rocketgod.mayhem.core.fleet.TgRow> { it.recent.size }.thenByDescending { it.lastMs }).take(14)
    if (tgs.isEmpty()) { FlDim("talkgroup activity over the last 10 minutes shows here"); return }
    val top = tgs.maxOf { it.recent.size }.coerceAtLeast(1)
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        for (t in tgs) Row(Modifier.fillMaxWidth().clickable { pick("tg:${t.key}") }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("TG ${t.tg}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(84f)), maxLines = 1)
            FlBar(t.recent.size.toFloat() / top, colorOf(t.sys), Modifier.weight(1f).height(d.dp(7f)))
            Text("${t.recent.size} · ${flAgo(now - t.lastMs)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
    }
}

/** One grant on the feed: talkgroup, source, channel in MHz, slot and flags; a fresh one flashes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GrantLine(g: GrantRow, now: Long, col: Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val flash = max(0f, 1 - (now - g.ms) / 1200f)
    val ch = if (g.hz > 0) mhz(g.hz) + (if (g.tdma) " · TDMA S${g.slot + 1}" else "") else g.ch + (if (g.tdma && g.slot >= 0) " · TS${g.slot + 1}" else "")
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(d.dp(8f))).background(Brush.horizontalGradient(listOf(col.copy(alpha = 0.06f + 0.25f * flash), Palette.panel)))
        .border(1.dp, if (g.emergency) Palette.danger else col.copy(alpha = 0.3f + 0.6f * flash), RoundedCornerShape(d.dp(8f)))
        .clickable(enabled = g.group) { pick("tg:${g.sys}/${g.tg}") }.padding(horizontal = d.dp(8f), vertical = d.dp(5f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Box(Modifier.size(d.dp(4f), d.dp(18f)).background(col, RoundedCornerShape(2.dp)))
        Text(flClock(g.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        Text(if (g.group) "TG ${g.tg}" else "UNIT ${g.tg}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
        Text(if (g.src != 0) "← ${g.src}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, modifier = Modifier.weight(1f))
        Text(ch, color = col, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
        if (g.emergency) FlPill("EMERG", Palette.danger)
        if (g.encrypted) FlPill("ENC", Palette.accent2)
        if (g.kind == "datagrant") FlPill("DATA", Palette.muted) else if (g.kind == "u2u") FlPill("PRIVATE", Palette.muted)
    }
}

/** One carrier in the span: class, role, level, identity and state. */
@Composable
private fun FreqLine(c: CarrierRow, s: FleetSnap, now: Long, selected: Boolean, col: Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val age = now - c.lastMs; val inSpan = c.hz > s.spanLo && c.hz < s.spanHi; val live = inSpan && age < 4_000
    val id = if (c.nac >= 0) "NAC ${hx(c.nac, 3)}" else if (c.cc >= 0) "CC ${c.cc}" else ""
    Row(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.6f).panel(if (selected) col else Palette.line).clickable { pick("car:${c.key}") }.padding(horizontal = d.dp(8f), vertical = d.dp(5f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Box(Modifier.size(d.dp(8f)).background(if (col == Color.Transparent) Palette.line else col, CircleShape))
        Text(mhz(c.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), modifier = Modifier.width(d.dp(78f)))
        Column(Modifier.weight(1f)) {
            Text((c.cls.ifEmpty { if (c.decoding) "LISTENING" else "NOT HEARD YET" }) + (if (c.callsign.isNotEmpty()) " · ${c.callsign}" else ""), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f))
            Text(listOf(c.role.uppercase() + if (c.tdma) " TDMA" else "", id).filter { it.isNotBlank() }.joinToString(" · "), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
        }
        FlBar((2 * c.levelDb / 100).toFloat(), if (live) Palette.ok else Palette.muted, Modifier.width(d.dp(40f)).height(d.dp(5f)))
        Text("%.0f dB".format(java.util.Locale.US, c.levelDb), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        Text(if (live) (if (c.decoding) "DECODING" else "LIVE") else if (inSpan) flAgo(age) else "OUT OF SPAN", color = if (c.decoding && live) Palette.ok else Palette.muted,
            fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1)
    }
}

private class FleetDetail(val title: String, val kind: String, val fields: List<Pair<String, String>>, val chipsLabel: String = "", val chips: List<Pair<String, String>> = emptyList(),
                          val histLabel: String = "", val hist: List<Triple<String, String, String>> = emptyList(), val idens: List<Iden>? = null, val grants: List<GrantRow> = emptyList(),
                          val mapKey: String? = null, val color: Color? = null)

/** Every field held for what is selected. */
private fun fleetDetail(s: FleetSnap, sel: String, now: Long, view: Int): FleetDetail? {
    val kind = sel.substringBefore(':'); val key = sel.substringAfter(':')
    fun sysLabel(k: String) = s.systems.firstOrNull { it.key == k }?.label ?: k
    when (kind) {
        "unit" -> {
            val u = s.units.firstOrNull { it.key == key } ?: return null
            val full = Apps.fleet.unitDetail(u.key)?.reports ?: u.reports
            val pos = if (u.lat != null && u.lon != null) "%.5f, %.5f".format(java.util.Locale.US, u.lat, u.lon) + (if (u.posVerified) "" else " · position (CRC unverified)")
                else if (u.posMs > 0) (if (s.ref) "-" else "needs your location to resolve") else "none on the air"
            val f = listOf("UNIT ID" to "${u.id} (0x${Integer.toHexString(u.id).uppercase()})", "SYSTEM" to sysLabel(u.sys), "SITE" to u.site.ifEmpty { "-" }, "POSITION" to pos,
                "LAST POSITION" to (if (u.posMs > 0) "${flClock(u.posMs)} · ${flAgoText(now - u.posMs)}" else "-"), "TALKGROUPS" to u.groups.joinToString(", ").ifEmpty { "-" },
                "GRANTS" to "${u.grants}", "HEARD ON" to u.carriers.joinToString(" · ") { k -> mhz(s.carriers.firstOrNull { it.key == k }?.hz ?: k) },
                "FIRST HEARD" to flClock(u.firstMs), "LAST HEARD" to "${flClock(u.lastMs)} · ${flAgoText(now - u.lastMs)}")
            val hist = full.reversed().map { r -> Triple(flClock(r.ms), "${r.kind} · ${mhz(r.hz)}" + (if (r.lat != null && r.lon != null) " · %.5f, %.5f".format(java.util.Locale.US, r.lat, r.lon) else "") + "\n${r.text}", r.hex) }
            return FleetDetail("${u.id}", "UNIT", f, histLabel = "EVERY REPORT", hist = hist, mapKey = if (u.lat != null && view != 1) u.key else null)
        }
        "tg" -> {
            val t = s.tgs.firstOrNull { it.key == key } ?: return null
            val f = listOf("TALKGROUP" to "${t.tg} (0x${Integer.toHexString(t.tg).uppercase()})", "SYSTEM" to sysLabel(t.sys), "GRANTS" to "${t.grants} · ${t.recent.size} in 10 min",
                "FIRST" to flClock(t.firstMs), "LAST" to "${flClock(t.lastMs)} · ${flAgoText(now - t.lastMs)}")
            return FleetDetail("TG ${t.tg}", "TALKGROUP", f, chipsLabel = "MEMBERS", chips = t.members.map { "$it" to "unit:${t.sys}/$it" }, histLabel = "HISTORY", grants = t.history)
        }
        "sys" -> {
            val x = s.systems.firstOrNull { it.key == key } ?: return null
            val f = if (x.proto == "P25") listOf("PROTOCOL" to "P25 Phase 1 control channel", "WACN" to hx(x.wacn, 5), "SYSTEM" to hx(x.sysId, 3), "SITES" to x.sites.joinToString(", ") { it.label },
                "UNITS" to "${x.units}", "TALKGROUPS" to "${x.tgs}", "GRANTS" to "${x.grants}", "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
            else listOf("PROTOCOL" to "DMR", "COLOR CODE" to "${x.cc}", "FEATURE SET" to (if (x.fid >= 0) "0x${hx(x.fid, 2)}" else "-"), "NETWORK" to (if (x.net >= 0) "${x.model} ${x.net}" else "not sent"),
                "CALLSIGN" to x.callsign.ifEmpty { "no CW ID heard yet" }, "SITES" to x.sites.joinToString(", ") { it.label }, "UNITS" to "${x.units}",
                "FORMATS" to (if (x.derived) "derived from recordings (rest-channel beacon on the CSBK CRC, unit reports on the vendor CRC)" else "ETSI TS 102 361"),
                "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
            return FleetDetail(x.proto, x.label, f, idens = if (x.proto == "P25") x.idens else null)
        }
        else -> {
            val c = s.carriers.firstOrNull { "${it.key}" == key } ?: return null
            val f = listOf("FREQUENCY" to "${mhz(c.hz)} MHz", "CLASS" to c.cls.ifEmpty { "not classed yet" }, "ROLE" to c.role.ifEmpty { "-" }, "SYSTEM" to (if (c.sys.isNotEmpty()) sysLabel(c.sys) else "-"),
                "NAC" to (if (c.nac >= 0) hx(c.nac, 3) else "-"), "COLOR CODE" to (if (c.cc >= 0) "${c.cc}" else "-"),
                "LEVEL" to "%.1f dB over the floor (peak %.1f)".format(java.util.Locale.US, c.levelDb, c.peakDb), "ENVELOPE" to "%.2f (constant near 0, linear near 0.3)".format(java.util.Locale.US, c.envCv),
                "EYE" to "%.2f".format(java.util.Locale.US, c.eye), "FRAMES" to "${c.frames}", "BLOCKS" to "${c.blocks} · ${c.crcOk} passed CRC", "CALLSIGN" to c.callsign.ifEmpty { "-" },
                "LCN" to c.lcn.ifEmpty { "-" }, "ON AIR" to "${Math.round(c.onMs / 1000.0)} s", "FIRST HEARD" to flClock(c.firstMs), "LAST HEARD" to "${flClock(c.lastMs)} · ${flAgoText(now - c.lastMs)}")
            return FleetDetail(mhz(c.hz), "CARRIER", f)
        }
    }
}

/** The selected item's details over the stage: fields, then members, history or the channel table. */
@Composable
private fun FleetDetailPanel(det: FleetDetail, accent: Color, modifier: Modifier, onMap: (() -> Unit)?, onPick: (String) -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().heightIn(max = d.dp(440f)).clip(shape).background(Palette.panel.copy(alpha = 0.95f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(det.title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(det.kind, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer { FieldGrid(det.fields, labelWidth = 112f, minColumn = 320f) }
        if (det.chips.isNotEmpty()) FlChips(det.chipsLabel, det.chips.map { it.first to true }, accent) { i -> onPick(det.chips[i].second) }
        if (det.idens != null) {
            Text("CHANNEL TABLE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
            IdenTable(det.idens)
        }
        if (det.hist.isNotEmpty() || det.grants.isNotEmpty()) Text(det.histLabel, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
        val now = System.currentTimeMillis()
        for (g in det.grants) GrantLine(g, now, accent) {}
        SelectionContainer {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                for ((t, v, hex) in det.hist) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text(t, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), modifier = Modifier.width(d.dp(64f)))
                    Column(Modifier.weight(1f)) {
                        Text(v, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
                        Text(hex, color = Palette.ink.copy(alpha = 0.6f), fontFamily = Mono, fontSize = d.sp(8.5f))
                    }
                }
            }
        }
    }
}

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(9f))
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Text(label, color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false,
                modifier = Modifier.clip(shape).background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape).clickable { onPick(i) }
                    .padding(horizontal = d.dp(10f), vertical = d.dp(7f)))
        }
    }
}
