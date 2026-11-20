package com.rocketgod.mayhem.ui

import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.launch
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
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
import com.rocketgod.mayhem.core.Dispatch
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.fleet.CallRow
import com.rocketgod.mayhem.core.fleet.CarrierRow
import com.rocketgod.mayhem.core.fleet.DispatchView
import com.rocketgod.mayhem.core.fleet.Lock
import com.rocketgod.mayhem.core.fleet.TgPrefs
import com.rocketgod.mayhem.core.fleet.UnitRow
import com.rocketgod.mayhem.core.fleet.FleetProcessor
import com.rocketgod.mayhem.core.fleet.FleetSnap
import com.rocketgod.mayhem.core.fleet.GrantRow
import com.rocketgod.mayhem.core.fleet.Iden
import com.rocketgod.mayhem.core.fleet.SiteRow
import com.rocketgod.mayhem.core.fleet.SystemRow
import com.rocketgod.mayhem.core.fleet.TrailPt
import com.rocketgod.mayhem.core.fleet.hx
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

/** One color per system, used on the cards, the map, the feed and the frequency list. */
private val FLEET_COLORS = listOf(0xFF4C8DFF, 0xFFFFAF00, 0xFF3DDC84, 0xFFFF5BD2, 0xFF00D5FF, 0xFFFF7A45, 0xFFB18CFF, 0xFFE8E14A, 0xFFFF5B52, 0xFF52FFB8).map { Color(it) }
private val VIEWS = listOf("SYSTEMS", "CALLS", "MAP", "GRANTS", "FREQS", "LOG", "TALKGROUPS")
private const val V_SYSTEMS = 0
private const val V_CALLS = 1
private const val V_MAP = 2
private const val V_GRANTS = 3
private const val V_FREQS = 4
private const val V_LOG = 5
/** The talkgroup grid: ALL, and a tile per talkgroup that a tap follows. The first view. */
private const val V_TGS = 6
/** On a wide screen the map has the big pane, so it is not a tab. */
private val WIDE_VIEWS = listOf(V_TGS, V_SYSTEMS, V_CALLS, V_GRANTS, V_FREQS, V_LOG)

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
/** A call's length as m:ss. */
private fun flDur(ms: Long): String { val t = max(0L, Math.round(ms / 1000.0)); return "${t / 60}:${(t % 60).toString().padStart(2, '0')}" }
/** The talkgroup key the preferences use ("sys/tg", "sys/uN" for a unit). */
private fun dispatchKey(c: CallRow) = if (c.group) "${c.sys}/${c.tg}" else "${c.sys}/u${c.tg}"
/** What tapping a call's talkgroup opens. */
private fun dispatchSel(c: CallRow) = if (c.group) "tg:${dispatchKey(c)}" else "unit:${c.sys}/${c.tg}"
/** Why a call has no audio, in a few words, or "" when it has some. */
private fun dispatchAudioNote(c: CallRow, codecs: List<String>): String = when {
    c.encrypted -> "encrypted, no audio"
    c.audioMs > 0 -> ""
    c.decoded >= 10 && c.badFrames > 0.5 * c.decoded -> "weak signal"
    c.sec == "unknown" && c.voiceMs > 0 -> "no voice decoded yet"
    c.codec !in codecs -> if (c.codec == "imbe") "no audio yet, the P25 full-rate vocoder is not built" else if (c.codec == "tetra") "no audio yet, the TETRA codec is not built" else "no audio yet, the half-rate vocoder for ${if (c.proto == "DMR") "DMR" else "Phase 2"} is not built"
    c.voiceMs > 0 -> ""
    else -> "voice channel not heard"
}
/** The level of the call heard, 0 to 1, from the processor's level reports. */
private fun dispatchVuFrac(vu: FleetProcessor.VuLevel, key: String): Float = if (vu.key == key) ((vu.db + 60) / 54f).coerceIn(0f, 1f) else 0f

/**
 * Dispatch: trunked radio systems and their calls, receive only. P25, DMR, TETRA and NXDN: every carrier in the span is
 * found and the live ones decoded at once. The calls on the air stack on top (emergencies first, then the call heard),
 * with the now-playing bar over them. SYSTEMS groups what is heard by trunk (each system in its own color everywhere),
 * CALLS is the log with replay, MAP puts the units that report a position where they say they are, GRANTS is the live
 * feed with per-talkgroup activity, FREQS every carrier in the span, LOG every decoded block. A tap opens all it carried.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
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
    val prefs by Dispatch.prefs.collectAsState()
    val lock by Dispatch.lock.collectAsState()
    val audioOn by Dispatch.audioOn.collectAsState()
    val gain by Dispatch.gain.collectAsState()
    val following by Dispatch.following.collectAsState()
    val vu by Apps.fleet.vu.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(V_TGS) }
    /** What is open for its details: "unit:<key>", "tg:<key>", "sys:<key>" or "car:<key>". */
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var held by remember { mutableStateOf<FleetSnap?>(null) }
    var full by remember { mutableStateOf(false) }
    var focusKey by remember { mutableIntStateOf(0) }
    /** Bumped when something asks for the map on a phone: the page scrolls to it. */
    var jumpMap by remember { mutableIntStateOf(0) }
    var focusAt by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { Geo.start(ctx) }
    LaunchedEffect(fix) { Apps.fleetRef(fix) }
    // the band scan, AUTO, the lock and the follow run while the screen is up
    LaunchedEffect(Unit) { while (true) { delay(500); Apps.fleetTick(System.currentTimeMillis()) } }
    // what was heard is kept on the phone when the screen goes
    DisposableEffect(Unit) { onDispose { Dispatch.saveKnown() } }
    val s = held ?: live
    val colorOf: (String) -> Color = { key -> s?.systems?.firstOrNull { it.key == key }?.let { FLEET_COLORS[it.color % FLEET_COLORS.size] } ?: Palette.muted }
    val me = fix ?: Geo.lastKnownPos()
    val pins = s?.units.orEmpty().filter { it.lat != null && it.lon != null }
    // the units of calls on the air pulse on the map while they talk; old positions fade
    val talking = s?.calls.orEmpty().filter { it.onAir && it.pos != null && !it.outside }.map { "${it.sys}/${it.pos!!.unit}" }.toSet()
    val mapItems = pins.map {
        val age = now - it.posMs
        GeoItem(it.key, it.lat!!, it.lon!!, "${it.id}", GeoItem.Kind.STATION, color = colorOf(it.sys).toArgb(), pulse = it.key in talking,
            alpha = if (it.key in talking) 1f else if (age > 3_600_000) 0.35f else if (age > 600_000) 0.6f else 1f)
    }
    val trails = s?.units.orEmpty().filter { it.trail.size > 1 }.map { u -> GeoShape(u.key, u.trail.map { it.lat to it.lon }, true, colorOf(u.sys).toArgb(), sel = sel == "unit:${u.key}") }
    val wf = waterfallOn(MayhemApp.FLEET, phoneDefault = false)
    val wide = d.wide
    LaunchedEffect(wide) { if (wide) { if (view == V_MAP) view = V_TGS; full = false } }
    val tiles = s?.let { DispatchView.tgTiles(it.tgs, it.calls, prefs, now) } ?: emptyList()
    val tabs = if (wide) WIDE_VIEWS else VIEWS.indices.toList()

    fun pick(k: String) { sel = if (sel == k) null else k }
    fun export() {
        val (csv, json) = Apps.fleet.exportAll(); val stamp = Saves.stamp()
        val a = Saves.toDownloads(ctx, "dispatch-log-$stamp.csv", "text/csv", csv.toByteArray())
        val b = Saves.toDownloads(ctx, "dispatch-tables-$stamp.json", "application/json", json.toByteArray())
        Toast.makeText(ctx, if (a != null && b != null) "saved $a and $b" else "could not save", Toast.LENGTH_LONG).show()
    }
    /** Shows a call's position on the map: the map view on a phone, centered there, the unit picked when there is one. */
    fun goTo(lat: Double, lon: Double, unitKey: String) {
        if (!wide) { view = V_MAP; jumpMap++ }
        if (unitKey.isNotEmpty() && s?.units?.any { it.key == unitKey } == true) sel = "unit:$unitKey"
        focusAt = lat to lon; focusKey++
    }
    fun lockFor(sys: String, site: String = "") { Dispatch.lockFor(sys, site)?.let { Dispatch.setLock(it) } }
    val acts = DispatchActs(::pick, { k, key -> Dispatch.pref(k, key) }, { Dispatch.replay(it) }, ::goTo, ::lockFor, { Dispatch.setLock(null) })

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier, onTab: () -> Unit = {}) {
        val counts = listOf("${s?.systems?.size ?: 0}", "${s?.calls?.size ?: 0}", "${pins.size}", "${s?.grants?.size ?: 0}", "${s?.let { liveCarriers(it, now).size } ?: 0}", "${logSnap.total}", "${tiles.size}")
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.Top) {
            FlSeg(tabs.map { if (it == V_LOG) VIEWS[it] else "${VIEWS[it]} ${counts[it]}" }, tabs.indexOf(view), accent, Modifier.weight(1f)) {
                view = tabs[it]
                // a tab is a new view: an open card closes, so what the tab shows is what is on screen
                if (wide) sel = null
                onTab()
            }
            ToggleBox("EXPORT", false, accent) { export() }
            ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent) { held = if (held == null) live else null }
            IconBox(ClearIcon, "Clear") { Apps.fleet.clear(); Apps.fleetLog.clear(); Dispatch.forget(); held = null; sel = null }
            if (withFull && !wide) IconBox(FullscreenIcon, "Full screen") { full = true }
        }
    }

    @Composable
    fun fleetMap(modifier: Modifier, page: androidx.compose.foundation.lazy.LazyListState? = null) {
        Box(modifier) {
            val pu = pins.firstOrNull { "unit:${it.key}" == sel }
            GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = fix, selected = pu?.key, layers = GeoLayers(shapes = trails),
                // on the phone page one finger scrolls past the map, two move it
                twoFinger = page != null,
                start = remember { mapStart(Geo.fix.value) }, focus = focusAt ?: pu?.let { it.lat!! to it.lon!! }, focusKey = focusKey, steady = true, fitPins = true, declutter = true,
                fallback = { Geo.fix.value ?: Geo.lastKnownPos() ?: Geo.zoneGuess() },
                // unit reports carry only the low bits of a position: with no position of our own, the region on the map resolves them
                onDragEnd = { lat, lon -> if (Geo.fix.value == null && Geo.lastKnownPos() == null) Apps.fleet.setRef(lat, lon) }) { pick("unit:$it") }
            if (pins.isEmpty()) Text(if (s != null && s.units.any { it.posMs > 0 } && !s.ref) "unit positions need a region, drag the map to your area" else "no unit positions on the air yet",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
        }
    }

    @Composable
    fun detail(modifier: Modifier, inline: Boolean = false) {
        if (s != null && sel != null) {
            FleetCard(s, sel!!, now, if (wide) V_MAP else view, wide, prefs, me, colorOf, acts, modifier, inline,
                onMap = { if (!wide) { view = V_MAP; jumpMap++ }; focusAt = null; focusKey++ }) { sel = null }
        }
    }

    @Composable
    fun onAir(modifier: Modifier) {
        if (s == null || view == V_LOG) return
        OnAirStack(s, now, if (view == V_MAP && !wide) 2 else 4, audioOn, following?.key, me, vu, prefs, lock, colorOf, acts, modifier)
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            val gap = Arrangement.spacedBy(d.dp(8f))
            when (view) {
                V_TGS -> LazyColumn(Modifier.fillMaxSize()) { item(key = "tgs") { TgGrid(tiles, s, prefs.hold, colorOf, accent, acts) } }
                V_SYSTEMS -> if (s == null || s.systems.isEmpty()) EmptyState("fleet", Modifier.fillMaxSize().panel(), accent)
                    // two to a row where the column holds them
                    else LazyVerticalGrid(GridCells.Adaptive(d.dp(if (wide) 330f else 600f)), Modifier.fillMaxSize(), verticalArrangement = gap, horizontalArrangement = gap) {
                        items(s.systems, key = { it.key }) { x -> SystemCard(x, s, now, sel == "sys:${x.key}", lock, colorOf, acts) }
                    }
                V_CALLS -> if (s == null) EmptyState("fleet", Modifier.fillMaxSize().panel(), accent) else CallsList(s, now, me, colorOf, acts, Modifier.fillMaxSize())
                V_MAP -> fleetMap(Modifier.fillMaxSize())
                V_GRANTS -> if (s == null) EmptyState("fleet", Modifier.fillMaxSize().panel(), accent) else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    item(key = "bars") { TgBars(s, now, colorOf, ::pick) }
                    if (s.grants.isEmpty()) item(key = "none") { FlDim("no grants yet · a quiet system may go minutes between calls") }
                    items(s.grants, key = { "${it.sys}|${it.tg}|${it.ch}|${it.ms}" }) { g -> GrantLine(g, now, colorOf(g.sys), ::pick) }
                }
                V_FREQS -> if (s == null || s.carriers.none { now - it.lastMs < 600_000 }) FlDim("no carriers found yet", Modifier.fillMaxSize())
                    else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                        items(s.carriers.filter { now - it.lastMs < 600_000 }, key = { it.key }) { c -> FreqLine(c, s, now, sel == "car:${c.key}", if (c.sys.isNotEmpty()) colorOf(c.sys) else Color.Transparent, ::pick) }
                    }
                else -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "watching for control channels…", total = logSnap.total, accent = accent)
            }
            if (!wide) detail(Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)))
        }
    }

    /** What the wide column's tab shows, as items of the column's one scroll. */
    fun LazyListScope.wideStage(s: FleetSnap?, view: Int, tiles: List<DispatchView.TgTile>, now: Long) {
        if (s == null) { item(key = "none") { EmptyState("fleet", Modifier.fillMaxWidth().height(d.dp(280f)).panel(), accent) }; return }
        when (view) {
            V_TGS -> item(key = "tgs") { TgGrid(tiles, s, prefs.hold, colorOf, accent, acts) }
            V_SYSTEMS -> if (s.systems.isEmpty()) item(key = "sys:none") { EmptyState("fleet", Modifier.fillMaxWidth().height(d.dp(280f)).panel(), accent) }
                else items(s.systems, key = { "sys:${it.key}" }) { x -> SystemCard(x, s, now, sel == "sys:${x.key}", lock, colorOf, acts) }
            V_CALLS -> if (s.calls.isEmpty()) item(key = "calls:none") { FlDim("no calls yet · each voice grant and each transmission heard is logged here") }
                else {
                    val ended = s.calls.filter { !it.onAir && it.kind == "call" }
                    item(key = "calls:sum") { FlDim("${ended.size} recent calls · ${flDur(ended.sumOf { it.endMs - it.startMs })} on the air${if (s.codecs.isNotEmpty()) " · audio kept in memory for replay, up to 2 min a call" else ""}") }
                    items(s.calls, key = { "calls:${it.key}" }) { c -> CallLine(c, now, me, if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.muted, acts) }
                }
            V_GRANTS -> {
                item(key = "grants:bars") { TgBars(s, now, colorOf, ::pick) }
                if (s.grants.isEmpty()) item(key = "grants:none") { FlDim("no grants yet · a quiet system may go minutes between calls") }
                else items(s.grants, key = { "grants:${it.sys}|${it.tg}|${it.ch}|${it.ms}" }) { g -> GrantLine(g, now, colorOf(g.sys), ::pick) }
            }
            V_FREQS -> {
                val cars = s.carriers.filter { now - it.lastMs < 600_000 }
                if (cars.isEmpty()) item(key = "freqs:none") { FlDim("no carriers found yet") }
                else items(cars, key = { "freqs:${it.key}" }) { c -> FreqLine(c, s, now, sel == "car:${c.key}", if (c.sys.isNotEmpty()) colorOf(c.sys) else Color.Transparent, ::pick) }
            }
            else -> logItems(logSnap.lines, logSnap.total, accent)
        }
    }

    val onAirNow = s?.calls.orEmpty().filter { it.onAir && it.kind == "call" && !it.outside }
    PacketFrame(accent, Apps.fleetLog, tag = "DISPATCH", title = "P25 · DMR TRUNKING", roomy = true, waterfall = wf,
        widePane = { m -> fleetMap(m) },
        onWaterfall = { Apps.setWaterfall(MayhemApp.FLEET, !wf) },
        lamp = {
            if (onAirNow.any { it.emergency }) Lamp("EMERGENCY", Palette.danger, blink = true)
            else if (onAirNow.isNotEmpty()) Lamp("${onAirNow.size} ON AIR", Palette.ok, blink = true)
            else if (s != null && s.systems.isNotEmpty()) Lamp("${s.systems.size} SYSTEM${if (s.systems.size == 1) "" else "S"}", Palette.ok)
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
            @Composable
            fun modeRow() = ListenRow(prefs.hold, lock, accent, onAll = { Dispatch.followTalkgroup("") }) { all -> if (all) Dispatch.setLock(null) else if (!Dispatch.lockSomething(sel?.takeIf { it.startsWith("sys:") }?.substringAfter(':')))
                Toast.makeText(ctx, "no system to lock on yet, wait for one to show or lock from its card", Toast.LENGTH_SHORT).show() }
            if (!wide) {
                // the phone: one page that scrolls, nothing hidden behind tabs. The section chips and the now-playing bar
                // stay pinned on top; a chip scrolls to its section, and the chip of the section on screen lights up.
                // The map is always the big size (70% of the screen, 320 to 560 dp)
                val list = rememberLazyListState()
                val scope = rememberCoroutineScope()
                val starts = remember { IntArray(FL_SECTIONS.size) }
                val mapH = (LocalConfiguration.current.screenHeightDp * 0.7f).coerceIn(320f, 560f).dp
                val th = with(LocalDensity.current) { d.dp(24f).roundToPx() }
                val counts = listOf(pins.size, tiles.size, s?.systems?.size ?: 0, s?.calls?.count { it.kind == "call" } ?: 0, s?.grants?.size ?: 0,
                    s?.let { liveCarriers(it, now).size } ?: 0, logSnap.total)
                LaunchedEffect(jumpMap) { if (jumpMap > 0) list.animateScrollToItem(starts[0]) }
                // a card opens at the top of the page, under the controls
                LaunchedEffect(sel) { if (sel != null) list.animateScrollToItem(1) }
                val active by remember { derivedStateOf {
                    val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.offset + it.size > th }
                    val k = (first?.key as? String)?.substringBefore(':') ?: "map"
                    if (!list.canScrollForward && list.canScrollBackward) FL_SECTIONS.size - 1 else FL_SECTIONS.indexOfFirst { it.first == k }.coerceAtLeast(0)
                } }
                Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f))) {
                    Column(Modifier.fillMaxWidth().background(Palette.paper).padding(bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        FlJump(counts, active, accent) { i -> scope.launch { list.animateScrollToItem(starts[i]) } }
                        if (s != null && audioOn && s.codecs.isNotEmpty()) NowBar(s, now, lock, me, vu, colorOf, acts)
                    }
                    Box(Modifier.fillMaxWidth().weight(1f)) {
                        LazyColumn(Modifier.fillMaxSize(), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                            var idx = 0
                            item(key = "map:top") {
                                Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                                    FleetHead(s, scan, now, accent)
                                    modeRow()
                                    if (s != null && s.codecs.isNotEmpty()) AudioRow(audioOn, gain, accent)
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f), Alignment.End)) {
                                        ToggleBox("EXPORT", false, accent) { export() }
                                        ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent) { held = if (held == null) live else null }
                                        IconBox(ClearIcon, "Clear") { Apps.fleet.clear(); Apps.fleetLog.clear(); Dispatch.forget(); held = null; sel = null }
                                    }
                                    if (s != null) OnAirStack(s, now, 4, audioOn, following?.key, me, vu, prefs, lock, colorOf, acts, Modifier.fillMaxWidth())
                                }
                            }
                            idx++
                            item(key = "map:card") { detail(Modifier.fillMaxWidth(), inline = true) }; idx++
                            starts[0] = idx; item(key = "map:head") { FlSecHead(FL_SECTIONS[0].second) }; idx++
                            item(key = "map:map") { fleetMap(Modifier.fillMaxWidth().height(mapH), list) }; idx++
                            starts[1] = idx; item(key = "tgs:head") { FlSecHead(FL_SECTIONS[1].second) }; idx++
                            item(key = "tgs:grid") { TgGrid(tiles, s, prefs.hold, colorOf, accent, acts) }; idx++
                            starts[2] = idx; item(key = "sys:head") { FlSecHead(FL_SECTIONS[2].second) }; idx++
                            if (s == null || s.systems.isEmpty()) { item(key = "sys:empty") { EmptyState("fleet", Modifier.fillMaxWidth().height(d.dp(280f)).panel(), accent) }; idx++ }
                            else { items(s.systems, key = { "sys:${it.key}" }) { x -> SystemCard(x, s, now, sel == "sys:${x.key}", lock, colorOf, acts) }; idx += s.systems.size }
                            starts[3] = idx; item(key = "calls:head") { FlSecHead(FL_SECTIONS[3].second) }; idx++
                            if (s == null || s.calls.isEmpty()) { item(key = "calls:none") { FlDim("no calls yet · each voice grant and each transmission heard is logged here") }; idx++ }
                            else {
                                val ended = s.calls.filter { !it.onAir && it.kind == "call" }
                                item(key = "calls:sum") { FlDim("${ended.size} recent calls · ${flDur(ended.sumOf { it.endMs - it.startMs })} on the air${if (s.codecs.isNotEmpty()) " · audio kept in memory for replay, up to 2 min a call" else ""}") }; idx++
                                items(s.calls, key = { "calls:${it.key}" }) { c -> CallLine(c, now, me, if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.muted, acts) }; idx += s.calls.size
                            }
                            starts[4] = idx; item(key = "grants:head") { FlSecHead(FL_SECTIONS[4].second) }; idx++
                            if (s != null) { item(key = "grants:bars") { TgBars(s, now, colorOf, ::pick) }; idx++ }
                            if (s == null || s.grants.isEmpty()) { item(key = "grants:none") { FlDim("no grants yet · a quiet system may go minutes between calls") }; idx++ }
                            else { items(s.grants, key = { "grants:${it.sys}|${it.tg}|${it.ch}|${it.ms}" }) { g -> GrantLine(g, now, colorOf(g.sys), ::pick) }; idx += s.grants.size }
                            starts[5] = idx; item(key = "freqs:head") { FlSecHead(FL_SECTIONS[5].second) }; idx++
                            val cars = s?.carriers.orEmpty().filter { now - it.lastMs < 600_000 }
                            if (s == null || cars.isEmpty()) { item(key = "freqs:none") { FlDim("no carriers found yet") }; idx++ }
                            else { items(cars, key = { "freqs:${it.key}" }) { c -> FreqLine(c, s, now, sel == "car:${c.key}", if (c.sys.isNotEmpty()) colorOf(c.sys) else Color.Transparent, ::pick) }; idx += cars.size }
                            starts[6] = idx; item(key = "log:head") { FlSecHead(FL_SECTIONS[6].second) }; idx++
                            // the log is part of the page's one scroll; it keeps its own short line when empty
                            logItems(logSnap.lines, logSnap.total, accent)
                        }
                    }
                }
            } else Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                // the web app's wide column: the live call stays on top, and everything else is one scroll with no
                // scroll inside it; the tabs stay pinned under the live call
                val list = rememberLazyListState()
                val scope = rememberCoroutineScope()
                if (s != null && audioOn && s.codecs.isNotEmpty()) NowBar(s, now, lock, me, vu, colorOf, acts)
                // a card opens under the tabs and comes into view there
                LaunchedEffect(sel) { if (sel != null) list.animateScrollToItem(1) }
                LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    item(key = "top") {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                            FleetHead(s, scan, now, accent)
                            modeRow()
                            if (s != null && s.codecs.isNotEmpty()) AudioRow(audioOn, gain, accent)
                            onAir(Modifier.fillMaxWidth())
                        }
                    }
                    stickyHeader(key = "tabs") {
                        switcher(true, Modifier.fillMaxWidth().background(Palette.paper).padding(vertical = d.dp(4f))) {
                            // what the tab shows comes into view under the tabs
                            scope.launch { if (list.firstVisibleItemIndex > 1) list.animateScrollToItem(1) }
                        }
                    }
                    if (s != null && sel != null) item(key = "card") { detail(Modifier.fillMaxWidth(), inline = true) }
                    wideStage(s, view, tiles, now)
                }
            }
        })
    if (full) FullscreenPanel("DISPATCH · ${VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        onAir(Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** What the cards and rows can do: open a detail, set a talkgroup preference, replay, show on the map, lock and unlock. */
/** The phone page's sections: the key its rows carry and the header. */
private val FL_SECTIONS = listOf("map" to "MAP", "tgs" to "TALKGROUPS", "sys" to "SYSTEMS", "calls" to "CALLS", "grants" to "GRANTS", "freqs" to "FREQUENCIES", "log" to "LOG")
private val FL_CHIPS = listOf("MAP", "TALKGROUPS", "SYSTEMS", "CALLS", "GRANTS", "FREQS", "LOG")

/** The Dispatch log as items of a page's own scroll (no scroll inside it), newest first, with its short line when empty. */
private fun LazyListScope.logItems(lines: List<String>, total: Int, accent: Color) {
    if (lines.isEmpty()) { item(key = "log:none") { FlDim("watching for control channels…") }; return }
    itemsIndexed(lines, key = { i, _ -> "log:${total - i}" }) { i, l -> LogLine(i, l, total - i, accent) }
}

/**
 * The talkgroup grid: ALL first (every talkgroup, the first to talk is heard), then a small tile per talkgroup with its
 * system, when it was last heard (or ON THE AIR) and its encryption. A tap follows the talkgroup, so only it is heard; a
 * tap on the followed tile, or on ALL, hears every talkgroup again. The i on a tile opens its card.
 */
@Composable
private fun TgGrid(tiles: List<DispatchView.TgTile>, s: FleetSnap?, hold: String, colorOf: (String) -> Color, accent: Color, acts: DispatchActs) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cols = max(2, (maxWidth / d.dp(132f)).toInt())
        val now = System.currentTimeMillis()
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val cells: List<DispatchView.TgTile?> = listOf<DispatchView.TgTile?>(null) + tiles
            for (row in cells.chunked(cols)) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (t in row) {
                        if (t == null) TgTileBox(Modifier.weight(1f).fillMaxHeight(), "ALL", "EVERY TALKGROUP", "first to talk is heard", false, "", hold.isEmpty(),
                            false, false, Palette.muted, accent, null) { Dispatch.followTalkgroup("") }
                        else {
                            val sys = s?.systems?.firstOrNull { it.key == t.sys }
                            TgTileBox(Modifier.weight(1f).fillMaxHeight(), "TG ${t.tg}", sys?.let { Dispatch.sysTitle(it) } ?: t.sys,
                                if (t.live) "ON THE AIR" else if (t.lastMs > 0) DispatchView.agoShort(now - t.lastMs).let { if (it == "now") it else "$it ago" } else "not heard yet",
                                t.live, t.sec, t.followed, t.muted, t.emergency, colorOf(t.sys), accent, { acts.pick("tg:${t.key}") }) { Dispatch.followTalkgroup(t.key) }
                        }
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (tiles.isEmpty()) FlDim("talkgroups show here as the control channels grant them and their calls are heard")
        }
    }
}

@Composable
private fun TgTileBox(modifier: Modifier, title: String, sub: String, whenText: String, live: Boolean, sec: String, followed: Boolean, muted: Boolean, emergency: Boolean,
                      col: Color, accent: Color, onInfo: (() -> Unit)?, onTap: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    val edge = if (emergency) Palette.danger else if (followed) accent else col
    val border = if (followed) accent else if (emergency) Palette.danger else if (live) Palette.ok.copy(alpha = 0.6f) else Palette.line
    Box(modifier.alpha(if (muted) 0.5f else 1f).clip(shape).background(if (followed) accent.copy(alpha = 0.16f) else Palette.surface).border(1.dp, border, shape)
        .drawBehind { drawRect(edge, size = Size(3.dp.toPx(), size.height)) }.clickable { onTap() }) {
        Column(Modifier.fillMaxWidth().padding(start = d.dp(11f), end = d.dp(9f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(title, color = if (onInfo == null) accent else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(14f), maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = d.dp(18f)))
            Text(sub, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                if (onInfo != null) Box(Modifier.size(d.dp(6f)).background(if (live) Palette.ok else Palette.line, CircleShape))
                Text(whenText, color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = if (live) FontWeight.Bold else FontWeight.Normal, fontSize = d.sp(10f), maxLines = 2)
            }
            if (sec.isNotEmpty()) Text(sec, color = if (sec == "CLEAR") Palette.ok else Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp)
            if (onInfo != null && (followed || muted)) Text(if (followed) "FOLLOWING" else "MUTED", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8f), letterSpacing = 1.5.sp)
        }
        if (onInfo != null) Box(Modifier.align(Alignment.TopEnd).padding(d.dp(5f)).size(d.dp(18f)).clip(CircleShape).border(1.dp, Palette.line, CircleShape).clickable { onInfo() },
            contentAlignment = Alignment.Center) { Text("i", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f)) }
    }
}

/**
 * What is heard: ALL (every talkgroup, the first to talk is heard) or the one talkgroup followed (only it plays), with a
 * tap back to ALL; and the system lock beside it (LOCK SYSTEM stays on one system, LOCKED ON taps to unlock).
 */
@Composable
private fun ListenRow(hold: String, lock: Lock?, accent: Color, onAll: () -> Unit, onLock: (all: Boolean) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        val on = hold.isNotEmpty()
        Row(Modifier.weight(1f).clip(shape).background(if (on) accent.copy(alpha = 0.14f) else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape)
            .padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(if (on) "FOLLOWING" else "HEARING", color = if (on) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8f), letterSpacing = 1.5.sp)
            Text(if (on) "TG ${hold.substringAfterLast('/')}" else "ALL", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
            Text(DispatchView.listenText(hold, lock), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, modifier = Modifier.weight(1f))
            if (on) ToggleBox("BACK TO ALL", false, accent) { onAll() }
        }
        if (lock != null) {
            Row(Modifier.clip(shape).background(accent.copy(alpha = 0.14f)).border(1.dp, accent, shape).clickable { onLock(true) }.padding(horizontal = d.dp(9f), vertical = d.dp(6f)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text("LOCKED ON", color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                Text(lock.label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = d.dp(180f)))
                Text("UNLOCK", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
            }
        } else ToggleBox("LOCK SYSTEM", false, accent) { onLock(false) }
    }
}

/** A section's small header on the phone page. */
@Composable
private fun FlSecHead(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 2.sp,
        modifier = Modifier.padding(top = d.dp(10f), start = d.dp(2f), bottom = d.dp(2f)))
}

/** The section chips: one row that scrolls sideways, a count on each (none at 0), the section on screen lit. */
@Composable
private fun FlJump(counts: List<Int>, active: Int, accent: Color, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(50)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = d.dp(4f), horizontal = d.dp(2f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically) {
        FL_CHIPS.forEachIndexed { i, label ->
            val on = i == active
            Row(Modifier.then(if (on) Modifier.shadow(d.dp(8f), shape, ambientColor = accent, spotColor = accent) else Modifier).clip(shape)
                .background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape).clickable { onPick(i) }
                .padding(horizontal = d.dp(12f), vertical = d.dp(7f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text(label, color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
                val n = counts.getOrElse(i) { 0 }
                if (n > 0) Text(if (n > 999) "999+" else "$n", color = if (on) accent else Palette.paper, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), maxLines = 1,
                    modifier = Modifier.clip(shape).background(if (on) inkOn(accent) else Palette.muted).padding(horizontal = d.dp(5f), vertical = d.dp(1f)))
            }
        }
    }
}

private class DispatchActs(val pick: (String) -> Unit, val pref: (String, String) -> Unit, val replay: (String) -> Unit,
                           val goTo: (Double, Double, String) -> Unit, val lock: (String, String) -> Unit, val unlock: () -> Unit)

@Composable
private fun FlDim(text: String, modifier: Modifier = Modifier) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = modifier.padding(d.dp(8f)))
}

/** What it is watching (band and span), the counters, and the scan state. */
@Composable
private fun FleetHead(s: FleetSnap?, scan: Dispatch.Scan, now: Long, accent: Color) {
    val d = rememberDims()
    val w = scan.windows.getOrNull(scan.idx); val c = s?.centerHz ?: w?.hz ?: 0L
    val band = FleetProcessor.BANDS.firstOrNull { c >= it.lo - 2_000_000 && c <= it.hi + 2_000_000 } ?: FleetProcessor.BANDS.firstOrNull { it.id == w?.band }
    val scanText = Dispatch.scanText(now)
    val onAir = s?.calls?.count { it.onAir && it.kind == "call" && !it.outside } ?: 0
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(band?.let { "${it.label} MHz" } ?: "", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1)
            Text(if (s != null) "${mhz(s.spanLo, 3)}–${mhz(s.spanHi, 3)} MHz · ${liveCarriers(s, now).size} carriers · ${s.slots} decoding" else "", color = Palette.muted, fontFamily = Mono,
                fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(scanText, color = if (scan.found) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val sites = s?.systems?.sumOf { it.sites.size } ?: 0
            for ((n, l) in listOf("${s?.systems?.size ?: 0}" to "SYSTEMS", "$sites" to "SITES", "${s?.units?.size ?: 0}" to "UNITS", "$onAir" to "ON AIR", "${s?.perMin ?: 0}" to "GRANTS/MIN", "${s?.blocks ?: 0}" to "BLOCKS")) {
                val air = l == "ON AIR" && onAir > 0
                Column(Modifier.weight(1f).panel(if (air) Palette.ok else Palette.line).padding(horizontal = d.dp(4f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = if (air) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1)
                }
            }
        }
    }
}

/** The now-playing bar: what is heard right now, with its level; tapping it opens the talkgroup. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NowBar(s: FleetSnap, now: Long, lock: Lock?, me: Pair<Double, Double>?, vu: FleetProcessor.VuLevel, colorOf: (String) -> Color, acts: DispatchActs) {
    val d = rememberDims()
    val c = DispatchView.nowPlaying(s.calls, s.playing)
    val col = if (c == null) Palette.line else if (c.emergency) Palette.danger else if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.accent
    val shape = RoundedCornerShape(d.dp(12f))
    FlowRow(Modifier.fillMaxWidth().clip(shape).background(Brush.horizontalGradient(listOf(col.copy(alpha = if (c != null) 0.24f else 0.05f), Palette.surface)))
        .border(1.dp, col.copy(alpha = if (c != null) 0.9f else 0.6f), shape).clickable(enabled = c != null) { c?.let { acts.pick(dispatchSel(it)) } }
        .padding(horizontal = d.dp(10f), vertical = d.dp(7f)),
        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f)), itemVerticalAlignment = Alignment.CenterVertically) {
        if (c == null) {
            Text("LISTENING", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp)
            Text("nothing clear on the air${if (lock != null) " · locked on ${lock.label}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
            return@FlowRow
        }
        val blink = (now / 500) % 2 == 0L
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Box(Modifier.size(d.dp(8f)).alpha(if (blink) 1f else 0.35f).background(Palette.ok, CircleShape))
            Text("NOW PLAYING", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp)
        }
        Text(DispatchView.callWho(c), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1)
        if (c.src != 0 || c.alias.isNotEmpty()) Text(listOf(if (c.src != 0) "← ${c.src}" else "", c.alias).filter { it.isNotEmpty() }.joinToString(" "), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
        val sys = s.systems.firstOrNull { it.key == c.sys }
        Text("${sys?.let { Dispatch.sysTitle(it) } ?: c.sys.ifEmpty { c.proto }}${if (c.site.isNotEmpty()) " · SITE ${c.site}" else ""} · ${mhz(c.hz)} MHz${c.pos?.let { " · ${DispatchView.posText(it, me)}" } ?: ""}",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        FlBar(dispatchVuFrac(vu, c.key), Palette.ok, Modifier.width(d.dp(70f)).height(d.dp(6f)))
        Text(flDur(now - c.startMs), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
    }
}

/** The audio switch and the volume (0 to 150 %). */
@Composable
private fun AudioRow(on: Boolean, gain: Double, accent: Color) {
    val d = rememberDims()
    var dragging by remember { mutableStateOf<Float?>(null) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        ToggleBox(if (on) "AUDIO ON" else "AUDIO OFF", on, accent) { Dispatch.setAudio(!on) }
        RowLabel("VOLUME")
        Slider(value = dragging ?: (gain * 100).toFloat(), onValueChange = { dragging = it; Dispatch.setAudio(on, it / 100.0) }, onValueChangeFinished = { dragging = null },
            valueRange = 0f..150f, colors = SliderDefaults.colors(thumbColor = accent, activeTrackColor = accent, inactiveTrackColor = Palette.line), modifier = Modifier.weight(1f))
        Text("${((dragging ?: (gain * 100).toFloat())).toInt()}%", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

/**
 * The calls on the air: emergencies pinned on top (and for a minute after they end), then the call being heard, then
 * the rest. Encrypted calls and calls with no talkgroup or audio fold into one line each under the cards, so they
 * never push a clear call out; calls outside the lock are left out and counted.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OnAirStack(s: FleetSnap, now: Long, max: Int, audioOn: Boolean, following: String?, me: Pair<Double, Double>?, vu: FleetProcessor.VuLevel,
                       prefs: TgPrefs, lock: Lock?, colorOf: (String) -> Color, acts: DispatchActs, modifier: Modifier) {
    val d = rememberDims()
    val all = DispatchView.onAirOrder(s.calls, s.playing, now).filter { !it.outside }
    val quiet = all.filter { it.onAir && DispatchView.unnamedQuiet(it, s.playing) }
    val stack = all.filter { !it.encrypted && it !in quiet }; val locked = all.filter { it.encrypted && it.onAir }
    val others = s.calls.count { it.onAir && it.kind == "call" && it.outside }
    if (stack.isEmpty() && others == 0 && locked.isEmpty() && quiet.isEmpty()) return
    Column(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        for (c in stack.take(max)) androidx.compose.runtime.key(c.key) { OnAirCard(c, s, now, audioOn, following == c.key, me, vu, prefs, lock, colorOf, acts) }
        if (stack.size > max) FlDim("${stack.size - max} more on the air")
        if (locked.isNotEmpty()) FlowRow(Modifier.fillMaxWidth().panel(Palette.accent2.copy(alpha = 0.5f)).padding(d.dp(7f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
            verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Text("ENCRYPTED ON THE AIR", color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            for (c in locked) Text("${DispatchView.callWho(c)} · ${DispatchView.secText(c).removePrefix("ENCRYPTED").removePrefix(" · ").ifEmpty { "encrypted" }}",
                color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, Palette.accent2.copy(alpha = 0.6f), RoundedCornerShape(50)).clickable { acts.pick(dispatchSel(c)) }
                    .padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
        }
        if (quiet.isNotEmpty()) FlDim("${quiet.size} more with no talkgroup or audio yet (${quiet.map { it.proto }.distinct().joinToString(", ")})")
        if (others > 0) FlDim("$others on other systems, not heard while locked")
    }
}

/** A CW ID chip: the callsign, and how long ago it was keyed. */
@Composable
private fun IdChip(id: String, ago: Long) {
    val d = rememberDims()
    Row(Modifier.clip(RoundedCornerShape(50)).border(1.dp, Palette.accent2.copy(alpha = 0.7f), RoundedCornerShape(50)).background(Palette.accent2.copy(alpha = 0.08f))
        .padding(horizontal = d.dp(7f), vertical = d.dp(2f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Text("ID", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp)
        Text(id, color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), maxLines = 1)
        Text(flAgo(ago), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1)
    }
}

/** A call's position as a button that shows it on the map. */
@Composable
private fun PosChip(c: CallRow, long: Boolean, me: Pair<Double, Double>?, now: Long, acts: DispatchActs) {
    val p = c.pos ?: return
    val d = rememberDims()
    val col = if (c.onAir) Palette.ok else Palette.muted
    Row(Modifier.clip(RoundedCornerShape(d.dp(8f))).border(1.dp, col.copy(alpha = 0.7f), RoundedCornerShape(d.dp(8f))).clickable { acts.goTo(p.lat, p.lon, "${c.sys}/${p.unit}") }
        .padding(horizontal = d.dp(7f), vertical = d.dp(3f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Text(if (long) "HEARD FROM" else "AT", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp)
        Text(DispatchView.posText(p, me), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (long) Text("${if (p.via == "unit") "UNIT" else "TG MEMBER"} ${p.unit} · ${flAgoText(now - p.ms)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1)
    }
}

/** MUTE, HOLD and PRIORITY for one talkgroup. */
@Composable
private fun PrefButtons(key: String, prefs: TgPrefs, acts: DispatchActs) {
    val d = rememberDims()
    Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for ((k, label, on) in listOf(Triple("mute", "MUTE", key in prefs.mute), Triple("hold", "FOLLOW", prefs.hold == key), Triple("prio", "PRIORITY", key in prefs.prio))) {
            val c = if (on) (if (k == "mute") Palette.muted else if (k == "prio") Palette.accent2 else Palette.ok) else Palette.line
            Text(label, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(d.dp(6f))).border(1.dp, c, RoundedCornerShape(d.dp(6f))).background(if (on) c.copy(alpha = 0.18f) else Color.Transparent)
                    .clickable { acts.pref(k, key) }.padding(horizontal = d.dp(7f), vertical = d.dp(3f)))
        }
    }
}

/** Security as the call itself states it: PROTECTED? while only a grant or link control said so, else the state. */
@Composable
private fun SecPill(c: CallRow) {
    val t = DispatchView.secText(c)
    if (c.protectedHint && !c.encrypted) FlPill("PROTECTED?", Palette.muted)
    else if (t.isNotEmpty()) FlPill(t, if (c.encrypted) Palette.accent2 else Palette.ok)
}

/** One call on the air: who, where, its channel, security, position, level, and its talkgroup's controls. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OnAirCard(c: CallRow, s: FleetSnap, now: Long, audioOn: Boolean, following: Boolean, me: Pair<Double, Double>?, vu: FleetProcessor.VuLevel,
                      prefs: TgPrefs, lock: Lock?, colorOf: (String) -> Color, acts: DispatchActs) {
    val d = rememberDims()
    val col = if (c.emergency) Palette.danger else if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.accent
    val sys = s.systems.firstOrNull { it.key == c.sys }
    val playing = s.playing == c.key && audioOn; val ended = !c.onAir
    val badge = if (ended) "ENDED" else if (c.emergency) "EMERGENCY" else if (c.outside) "OTHER SYSTEM" else if (c.muted) "MUTED" else if (playing) "PLAYING" else "ON AIR"
    val lpName = if (c.proto == "NXDN" || c.proto == "SMARTNET") "CH" else "LPCN"; val lp = if (c.lpcn >= 0) " · $lpName ${c.lpcn}" else ""
    val ch = if (c.hz > 0) "${mhz(c.hz)} MHz${if (c.tdma) " · TDMA S${c.slot + 1}" else if (c.proto == "DMR" || c.proto == "TETRA") " · TS${c.slot + 1}" else ""}$lp"
        else if (c.lpcn >= 0) "$lpName ${c.lpcn}${if (c.proto == "DMR") " · TS${c.slot + 1}" else ""} · ${if (c.proto == "SMARTNET") "channel plan not proved" else "learning its frequency"}" else "channel not resolved"
    val car = if (c.hz > 0) s.carriers.firstOrNull { abs(it.hz - c.hz) < 3_200 && it.callsign.isNotEmpty() } else null
    val note = dispatchAudioNote(c, s.codecs)
    val blink = (now / 500) % 2 == 1L
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (c.muted || ended) 0.6f else 1f).clip(shape)
        .background(Brush.linearGradient(listOf(col.copy(alpha = if (playing) 0.26f else 0.14f), Palette.panel)))
        .border(if (playing || c.emergency) 2.dp else 1.dp, col.copy(alpha = if (c.emergency && blink) 1f else 0.75f), shape).padding(d.dp(10f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                Box(Modifier.size(d.dp(8f)).alpha(if (ended || blink) 0.4f else 1f).background(if (c.emergency) Palette.danger else if (ended) Palette.muted else Palette.ok, CircleShape))
                Text(badge, color = if (c.emergency) Palette.danger else if (ended) Palette.muted else Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8.5f), letterSpacing = 1.5.sp)
            }
            FlPill(c.proto, col)
            Text(DispatchView.callWho(c), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1, modifier = Modifier.clickable { acts.pick(dispatchSel(c)) })
            if (c.emergency && ended) FlPill("EMERGENCY · ${flAgoText(now - c.endMs)}", Palette.danger)
            SecPill(c)
            Text(flDur((if (ended) c.endMs else now) - c.startMs), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(4f)),
                modifier = if (c.src != 0) Modifier.clickable { acts.pick("unit:${c.sys}/${c.src}") } else Modifier) {
                // the talker alias the radio sent names the unit; with no unit ID heard, the alias stands in for it
                Text(if (c.alias.isNotEmpty()) (if (c.src != 0) c.alias.uppercase() else "TALKER") else "UNIT", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = d.dp(160f)))
                Text(if (c.src != 0) "${c.src}" else c.alias.ifEmpty { "-" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            }
            Column(Modifier.widthIn(min = d.dp(140f))) {
                Text("${sys?.label ?: c.sys.ifEmpty { "no control channel" }}${if (c.site.isNotEmpty()) " · SITE ${c.site}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(ch + if (following) " · FOLLOWING" else "", color = col, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
            }
            if (car != null) IdChip(car.callsign, now - car.callsignMs)
            if (lock == null && c.sys.isNotEmpty()) ToggleBox("LOCK", false, col) { acts.lock(c.sys, "") }
        }
        PosChip(c, true, me, now, acts)
        if (c.encrypted) {
            val bits = listOfNotNull(c.mi.takeIf { it.isNotEmpty() }?.let { "MI ${it.uppercase()}" }, c.pi.takeIf { it.isNotEmpty() }?.let { "PRIVACY HEADER ${it.uppercase()}" },
                c.secFrom.takeIf { it.isNotEmpty() }?.let { "from the ${DispatchView.SEC_FROM[it] ?: it}" })
            if (bits.isNotEmpty()) Text(bits.joinToString(" · "), color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(8.5f))
        }
        if (playing) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("AUDIO", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            FlBar(dispatchVuFrac(vu, c.key), Palette.ok, Modifier.weight(1f).height(d.dp(6f)))
        }
        // the signal as a segmented meter, the top three hot
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            val segs = 16; val lit = Math.round((c.levelDb / 40).coerceIn(0.0, 1.0) * segs).toInt()
            for (i in 0 until segs) Box(Modifier.weight(1f).height(d.dp(5f)).background(if (i < lit) (if (i >= segs - 3) Palette.danger else Palette.ok) else Palette.line, RoundedCornerShape(1.dp)))
            Text(if (c.levelDb > 0) "%.0f dB".format(java.util.Locale.US, c.levelDb) else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), modifier = Modifier.padding(start = d.dp(4f)))
        }
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(listOf(if (c.voiceMs > 0) "VOICE %.1f s".format(java.util.Locale.US, c.voiceMs / 1000.0) else if (c.granted) "GRANTED" else "", note).filter { it.isNotEmpty() }.joinToString(" · "),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
            PrefButtons(dispatchKey(c), prefs, acts)
        }
    }
}

/** The call log: every call and CW ID, newest first, with replay where audio was kept. */
@Composable
private fun CallsList(s: FleetSnap, now: Long, me: Pair<Double, Double>?, colorOf: (String) -> Color, acts: DispatchActs, modifier: Modifier) {
    val d = rememberDims()
    if (s.calls.isEmpty()) { FlDim("no calls yet · each voice grant and each transmission heard is logged here", modifier); return }
    val ended = s.calls.filter { !it.onAir && it.kind == "call" }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        item(key = "sum") { FlDim("${ended.size} recent calls · ${flDur(ended.sumOf { it.endMs - it.startMs })} on the air${if (s.codecs.isNotEmpty()) " · audio kept in memory for replay, up to 2 min a call" else ""}") }
        items(s.calls, key = { it.key }) { c -> CallLine(c, now, me, if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.muted, acts) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CallLine(c: CallRow, now: Long, me: Pair<Double, Double>?, col: Color, acts: DispatchActs) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    FlowRow(Modifier.fillMaxWidth().alpha(if (c.outside) 0.55f else 1f).clip(shape).background(Brush.horizontalGradient(listOf(col.copy(alpha = if (c.onAir) 0.18f else 0.06f), Palette.panel)))
        .border(1.dp, if (c.emergency) Palette.danger else col.copy(alpha = 0.35f), shape).padding(horizontal = d.dp(8f), vertical = d.dp(5f)),
        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f)), itemVerticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(d.dp(4f), d.dp(16f)).background(col, RoundedCornerShape(2.dp)))
        Text(flClock(c.startMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        if (c.kind == "id") {
            IdChip(c.cwId, now - c.startMs)
            Text("CW ID · ${mhz(c.hz)} MHz", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
            return@FlowRow
        }
        Text(DispatchView.callWho(c), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, modifier = Modifier.clickable { acts.pick(dispatchSel(c)) })
        if (c.src != 0 || c.alias.isNotEmpty()) Text(listOf(if (c.src != 0) "← ${c.src}" else "", c.alias).filter { it.isNotEmpty() }.joinToString(" "), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1)
        Text(flDur((if (c.onAir) now else c.endMs) - c.startMs) + if (c.voiceMs > 0) " · voice %.1f s".format(java.util.Locale.US, c.voiceMs / 1000.0) else "", color = col, fontFamily = Mono, fontSize = d.sp(9.5f))
        if (c.onAir) FlPill("ON AIR", Palette.ok)
        if (c.emergency) FlPill("EMERG", Palette.danger)
        if (c.encrypted) FlPill(DispatchView.secText(c).replaceFirst("ENCRYPTED", "ENC"), Palette.accent2)
        if (c.cwId.isNotEmpty()) IdChip(c.cwId, now - c.endMs)
        if (c.audioMs > 0) ToggleBox("▶", false, col) { acts.replay(c.key) }
        PosChip(c, false, me, now, acts)
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

/**
 * One trunk: its identity, its sites with their control channels, channel tables and neighbors. On a narrow screen the
 * header's name keeps its width and the CW ID, LOCK and status wrap under it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SystemCard(x: SystemRow, s: FleetSnap, now: Long, selected: Boolean, lock: Lock?, colorOf: (String) -> Color, acts: DispatchActs) {
    val d = rememberDims()
    val col = colorOf(x.key); val age = now - x.lastMs; val flash = max(0f, 1 - age / 1500f); val live = age < 15_000
    val out = lock != null && lock.sys != x.key; val lockedHere = lock?.sys == x.key && lock.site.isEmpty()
    val away = x.heardHz.isNotEmpty() && x.heardHz.all { it < s.spanLo || it > s.spanHi }
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live && !out) 1f else 0.75f).clip(shape)
        .background(Brush.linearGradient(listOf(col.copy(alpha = 0.10f + 0.16f * flash), Palette.panel)))
        .border(if (selected || lock?.sys == x.key) 2.5.dp else (1 + 1.4f * flash).dp, col.copy(alpha = if (selected || lock?.sys == x.key) 1f else 0.35f + 0.6f * flash), shape).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        FlowRow(Modifier.fillMaxWidth().clickable { acts.pick("sys:${x.key}") }, horizontalArrangement = Arrangement.spacedBy(d.dp(10f)),
            verticalArrangement = Arrangement.spacedBy(d.dp(6f)), itemVerticalAlignment = Alignment.CenterVertically) {
            FlPill(x.proto, col)
            Column(Modifier.widthIn(min = d.dp(160f)).weight(1f)) {
                Text(Dispatch.sysTitle(x), color = col, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${if (x.security.isNotEmpty()) "${x.security} · " else ""}${if (x.callsign.isNotEmpty()) "${x.callsign} · " else ""}${x.sites.size} site${if (x.sites.size == 1) "" else "s"} · ${x.units} units · ${x.tgs} talkgroups · ${x.grants} grants",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2)
            }
            if (x.cwId.isNotEmpty()) IdChip(x.cwId, now - x.cwIdMs)
            ToggleBox(if (lockedHere) "LOCKED" else "LOCK", lockedHere, col) { if (lockedHere) acts.unlock() else acts.lock(x.key, "") }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                Box(Modifier.size(d.dp(8f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
                Text(if (live) "LIVE" else if (away) "NOT IN SPAN · LAST HEARD ${flAgoText(age).uppercase()}" else flAgo(age), color = if (live) Palette.ok else Palette.muted,
                    fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
            }
        }
        for (site in x.sites) SiteBlock(x, site, s, now, col, lock, acts)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SiteBlock(sys: SystemRow, site: SiteRow, s: FleetSnap, now: Long, col: Color, lock: Lock?, acts: DispatchActs) {
    val d = rememberDims()
    val age = now - site.lastMs; val live = age < 10_000
    val cars = site.carriers.mapNotNull { k -> s.carriers.firstOrNull { it.key == k } }
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.7f).panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(if (sys.proto == "P25") "SITE ${site.label}" else site.label.uppercase(), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            if (site.callsign.isNotEmpty() && sys.proto == "P25") Text(site.callsign, color = col, fontFamily = Mono, fontSize = d.sp(10f))
            if (sys.proto == "P25") {
                val here = lock?.sys == sys.key && lock.site == site.label
                ToggleBox(if (here) "LOCKED" else "LOCK SITE", here, col) { if (here) acts.unlock() else acts.lock(sys.key, site.label) }
            }
            FlBar((site.levelDb / 50).toFloat(), col, Modifier.width(d.dp(80f)).height(d.dp(5f)))
            Text("%.0f dB · %s".format(java.util.Locale.US, site.levelDb, flAgo(age)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (c in cars) {
                val role = when (c.role) { "rest" -> "REST"; "control" -> if (sys.proto == "P25" || sys.proto == "TETRA" || sys.proto == "SMARTNET") "CONTROL" else "REPEATER"; else -> c.role.uppercase() }
                Column(Modifier.clip(RoundedCornerShape(d.dp(8f))).border(1.dp, col.copy(alpha = if (c.role == "rest") 1f else 0.5f), RoundedCornerShape(d.dp(8f)))
                    .background(col.copy(alpha = if (c.role == "rest") 0.18f else 0.06f)).clickable { acts.pick("car:${c.key}") }.padding(horizontal = d.dp(7f), vertical = d.dp(3f))) {
                    Text(mhz(c.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
                    Text(role + if (c.lcn.isNotEmpty()) " · LCN ${c.lcn}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                }
            }
        }
        when (sys.proto) {
            "SMARTNET" -> {
                FlKv(listOfNotNull(if (site.site >= 0) "CONTROL CHANNEL" to "${site.site}" else null, if (site.time.isNotEmpty()) "" to site.time.uppercase() else null))
                if (site.lcns.isNotEmpty()) FlChips("CHANNELS", site.lcns.map { "CH ${it.lcn} ${mhz(it.hz)}" to false }, col)
            }
            "NXDN" -> {
                FlKv(listOfNotNull((if (sys.trunk == "CONVENTIONAL") "RAN" else "SITE") to "${site.site}", if (site.nac >= 0 && sys.trunk == "TYPE-C") "RAN" to "${site.nac}" else null,
                    if (site.time.isNotEmpty()) "" to site.time.uppercase() else null, if (site.cls > 0) "VERSION" to "${site.cls}" else null))
                if (site.neighbors.isNotEmpty()) FlChips("ADJACENT", site.neighbors.map { "${it.label.uppercase()} ${if (it.hz > 0) mhz(it.hz) else it.ch}" to it.heard }, col)
                if (site.lcns.isNotEmpty()) FlChips("CHANNELS", site.lcns.map { "${if (sys.trunk == "TYPE-D") "REPEATER" else "CH"} ${it.lcn} ${mhz(it.hz)}" to false }, col)
            }
            "TETRA" -> {
                FlKv(listOfNotNull(if (site.lra >= 0) "LA" to "${site.lra}" else null, "COLOR CODE" to "${site.site}", if (site.time.isNotEmpty()) "" to site.time.uppercase() else null,
                    if (site.cls >= 0) "CELL LOAD" to (listOf("LOW", "MEDIUM", "HIGH", "UNKNOWN").getOrNull(site.cls) ?: "${site.cls}") else null, if (sys.security.isNotEmpty()) "" to sys.security else null))
                if (site.secondary.isNotEmpty()) FlChips("CARRIERS", site.secondary.map { (if (it.second.isNotEmpty()) "${mhz(it.first)} ${it.second.uppercase()}" else mhz(it.first)) to false }, col)
            }
            "P25" -> {
                FlKv(listOfNotNull("NAC" to (if (site.nac >= 0) hx(site.nac, 3) else "-"), "RFSS" to "${site.rfss}", "SITE" to "${site.site}", if (site.time.length >= 19) "CLOCK" to site.time.substring(11, 19) else null))
                if (site.neighbors.isNotEmpty()) FlChips("NEIGHBORS", site.neighbors.map { "${it.label} ${mhz(it.hz)}" to it.heard }, col)
                if (site.secondary.isNotEmpty()) FlChips("SECONDARY", site.secondary.map { mhz(it.first) to false }, col)
                IdenTable(site.idens)
            }
            else -> {
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
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlKv(kv: List<Pair<String, String>>) {
    val d = rememberDims()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(12f))) {
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            if (k.isNotEmpty()) Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
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
    val lp = g.lpcn ?: -1
    val nx = g.sys.startsWith("NXDN") || g.sys.startsWith("SMARTNET")
    val ch = if (g.hz > 0) mhz(g.hz) + (if (g.tdma) " · TDMA S${g.slot + 1}" else if (nx) " · ${g.ch}" else if (lp >= 0) " · TS${g.slot + 1} · LPCN $lp" else "")
        else g.ch + (if (nx) "" else if (lp >= 0) " · TS${g.slot + 1}" else if (g.tdma && g.slot >= 0) " · TS${g.slot + 1}" else "")
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text(c.cls.ifEmpty { if (c.decoding) "LISTENING" else "NOT HEARD YET" }, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f))
                if (c.callsign.isNotEmpty()) IdChip(c.callsign, now - c.callsignMs)
            }
            Text(listOf(c.role.uppercase() + if (c.tdma) " TDMA" else "", id).filter { it.isNotBlank() }.joinToString(" · "), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
        }
        FlBar((2 * c.levelDb / 100).toFloat(), if (live) Palette.ok else Palette.muted, Modifier.width(d.dp(40f)).height(d.dp(5f)))
        Text("%.0f dB".format(java.util.Locale.US, c.levelDb), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        Text(if (live) (if (c.decoding) "DECODING" else "LIVE") else if (inSpan) flAgo(age) else "OUT OF SPAN", color = if (c.decoding && live) Palette.ok else Palette.muted,
            fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1)
    }
}

// ------------------------------------------------------------------------------------------------ detail cards
/** A status chip on a card's header: its tone, and whether it pulses (something live). */
private enum class ChipTone { PLAIN, OK, RED, ACC }
private class CardChip(val text: String, val tone: ChipTone = ChipTone.PLAIN, val live: Boolean = false)
/** One section of a card: a narrow one sits beside another on a wide screen, a wide one takes the row. */
private class CardSec(val title: String, val wide: Boolean = false, val body: @Composable () -> Unit)

/** What kind of system it is, as the cards name it. */
private fun sysType(x: SystemRow, s: FleetSnap): String = when (x.proto) {
    "P25" -> if (s.carriers.any { it.sys == x.key && it.tdma } || s.calls.any { it.sys == x.key && it.tdma }) "P25 PHASE 1 AND 2" else "P25 PHASE 1"
    "DMR" -> when (x.trunk) { "CAPACITY PLUS" -> "DMR CAPACITY PLUS"; "TIER III" -> "DMR TIER III"; else -> "DMR" }
    "NXDN" -> if (x.trunk.isNotEmpty()) "NXDN ${x.trunk}" else "NXDN"
    "SMARTNET" -> "MOTOROLA TYPE II"
    else -> x.proto
}
/** Only what has data: a field with no value is left out, never shown as a dash. */
private fun kvOf(vararg f: Pair<String, String?>): List<Pair<String, String>> = f.mapNotNull { (k, v) -> if (v.isNullOrEmpty()) null else k to v }
private fun hex(v: Int) = Integer.toHexString(v).uppercase()
private fun seenChip(ms: Long, now: Long) = if (now - ms < 15_000) CardChip("LIVE", ChipTone.OK) else CardChip("HEARD ${DispatchView.agoShort(now - ms).uppercase()} AGO")
private fun encChip(calls: List<CallRow>): CardChip? = DispatchView.encWord(calls).takeIf { it.isNotEmpty() }?.let { CardChip(it, if (calls.any { c -> c.encrypted }) ChipTone.ACC else ChipTone.OK) }

/** The selected unit, talkgroup, system or carrier as a card: a header with its status, then every section that has data. */
@Composable
private fun FleetCard(s: FleetSnap, sel: String, now: Long, view: Int, wide: Boolean, prefs: TgPrefs, me: Pair<Double, Double>?, colorOf: (String) -> Color, acts: DispatchActs,
                      modifier: Modifier, inline: Boolean, onMap: () -> Unit, onClose: () -> Unit) {
    val kind = sel.substringBefore(':'); val key = sel.substringAfter(':')
    val secs = ArrayList<CardSec>()
    val id: String; val kindLabel: String; val label: String; val col: Color; val chips = ArrayList<CardChip>()
    var mapBtn = false; var tgKey: String? = null
    when (kind) {
        "unit" -> {
            val u = s.units.firstOrNull { it.key == key } ?: return
            val sys = s.systems.firstOrNull { it.key == u.sys }; val dmr = sys?.proto == "DMR"
            col = colorOf(u.sys)
            val full = Apps.fleet.unitDetail(u.key)
            val reports = full?.reports ?: u.reports; val trail = full?.trail ?: u.trail
            val calls = s.calls.filter { it.kind == "call" && it.sys == u.sys && (it.src == u.id || u.id in it.srcs || (!it.group && it.tg == u.id)) }
            val talking = calls.firstOrNull { it.onAir && (it.src == u.id || it.pos?.unit == u.id) }
            val alias = u.alias.ifEmpty { calls.firstOrNull { it.alias.isNotEmpty() }?.alias ?: "" }
            id = "${u.id}"; kindLabel = "UNIT"; label = listOf(alias, sys?.let { Dispatch.sysTitle(it) } ?: u.sys).filter { it.isNotEmpty() }.joinToString(" · ")
            chips.add(seenChip(u.lastMs, now))
            if (talking != null) chips.add(CardChip("TALKING NOW", ChipTone.OK, true))
            if (calls.any { it.emergency && (it.onAir || now - it.endMs < 600_000) }) chips.add(CardChip("EMERGENCY", ChipTone.RED))
            encChip(calls)?.let { chips.add(it) }
            mapBtn = u.lat != null && view != V_MAP
            // where: the track over the rest of the system's units, and what it gives
            val tr = trail.ifEmpty { if (u.lat != null && u.lon != null) listOf(TrailPt(u.lat, u.lon, u.posMs)) else emptyList() }
            val off = full?.offArea ?: u.offArea
            if (tr.isNotEmpty() || off > 0 || u.posMs > 0) secs.add(CardSec("WHERE", true) {
                if (tr.isNotEmpty()) {
                    val last = tr.last()
                    val others = s.units.filter { it.sys == u.sys && it.key != u.key && it.lat != null && it.lon != null && abs(it.lat - last.lat) < 0.6 && abs(it.lon - last.lon) < 0.8 }
                    val st = DispatchView.trackStats(tr); val dist = me?.let { DispatchView.distBearing(it.first, it.second, last.lat, last.lon) }
                    // a real map, the main map's tiles: the unit and its track over the rest of its system's units (dimmed),
                    // framed on the track and you; the others show where they fall in that view
                    val c = col.toArgb()
                    CardMap("unit:${u.key}", others.map { GeoItem(it.key, it.lat!!, it.lon!!, "${it.id}", GeoItem.Kind.STATION, color = c, alpha = 0.55f) } +
                        GeoItem(u.key, last.lat, last.lon, "${u.id}", GeoItem.Kind.STATION, color = c, pulse = talking != null),
                        u.key, if (tr.size > 1) listOf(GeoShape(u.key, tr.map { it.lat to it.lon }, true, c, sel = true)) else emptyList(),
                        if (dist != null && dist.mi < 60) me else null, tr.map { it.lat to it.lon }, acts)
                    StatTiles(listOfNotNull(
                        dist?.let { DispatchView.distText(it) to "FROM YOU · ${Math.round(it.deg)}°" },
                        st.mph?.let { v -> if (st.moving) "${Math.round(v)} mph" to "HEADING ${st.dir} · ${st.course}°" else "STOPPED" to "NOT MOVING" },
                        "${st.fixes}" to (if (st.fixes == 1) "POSITION FIX" else if (st.spanMs > 0) "FIXES OVER ${DispatchView.spanShort(st.spanMs)}" else "FIXES"),
                        DispatchView.agoShort(now - last.ms) to "SINCE LAST FIX",
                        if (st.mi >= 0.05) (if (st.mi < 10) "%.1f mi".format(java.util.Locale.US, st.mi) else "${Math.round(st.mi)} mi") to "TRAVELED" else null))
                    CardKv(kvOf("POSITION" to "%.5f, %.5f".format(java.util.Locale.US, last.lat, last.lon), "LAST FIX" to "${flClock(last.ms)}${if (u.posVerified) " · checked" else ""}"))
                }
                if (off > 0) CardNote("$off position ${if (off == 1) "report" else "reports"} outside the system's area, not placed")
                else if (tr.isEmpty()) CardNote(if (s.ref) "position reports outside the system's area, not placed" else "position reports waiting for your location to resolve")
            })
            if (calls.isNotEmpty()) secs.add(CardSec("CALLS") { CardCalls(calls, 10, now, me, colorOf, acts) })
            if (u.tgCounts.isNotEmpty()) secs.add(CardSec("TALKGROUPS") { CardTags(u.tgCounts.take(16).map { (tg, n) -> Triple("TG $tg", "$n", "tg:${u.sys}/$tg") }, col, acts) })
            val site = u.site.ifEmpty { calls.firstOrNull { it.site.isNotEmpty() }?.site ?: "" }
            val slots = calls.filter { it.proto == "DMR" || it.proto == "TETRA" || it.tdma }.map { it.slot + 1 }.distinct()
            val freqs = (u.carriers.map { k -> s.carriers.firstOrNull { it.key == k }?.hz ?: k } + calls.map { it.hz }.filter { it > 0 }).distinct().sorted()
            val rest = if (dmr) (sys.sites.firstOrNull { it.label == site } ?: sys.sites.firstOrNull()) else null
            val dbs = reports.mapNotNull { it.db }
            secs.add(CardSec("RADIO") {
                CardKv(kvOf("UNIT ID" to "${u.id} · 0x${hex(u.id)}", "TALKER ALIAS" to alias, "SYSTEM" to (sys?.let { "${Dispatch.sysTitle(it)} · ${sysType(it, s)}" } ?: u.sys),
                    "SITE" to site, "COLOR CODE" to (if (dmr && sys.cc >= 0) "${sys.cc}" else null), "SLOT" to slots.joinToString(", ") { "TS$it" },
                    "REST CHANNEL" to (if (rest != null && rest.rest >= 0) "LCN ${rest.rest}" else null),
                    "WACN · SYSTEM" to (if (sys?.proto == "P25") "${hx(sys.wacn, 5)} · ${hx(sys.sysId, 3)}" else null),
                    "HEARD ON" to freqs.joinToString(" · ") { mhz(it) }, "GRANTS" to (if (u.grants > 0) "${u.grants}" else null), "CW ID" to sys?.callsign,
                    "FIRST HEARD" to "${flClock(u.firstMs)} · ${DispatchView.agoShort(now - u.firstMs)} ago", "LAST HEARD" to "${flClock(u.lastMs)} · ${DispatchView.agoShort(now - u.lastMs)} ago"))
                if (dbs.size >= 3 && dbs.max() - dbs.min() >= 1) Spark("SIGNAL · ${Math.round(dbs.min())} to ${Math.round(dbs.max())} dB", dbs.takeLast(40).map { max(1.0, it).toFloat() }, col)
            })
            activitySec(reports.map { it.ms } + calls.map { it.startMs }, now, col)?.let { secs.add(it) }
            if (reports.isNotEmpty()) secs.add(CardSec("EVERY REPORT · ${reports.size}", true) { CardReports(reports) })
        }
        "tg" -> {
            val t = s.tgs.firstOrNull { it.key == key }
            val tg = t?.tg ?: key.substringAfterLast('/').toIntOrNull() ?: return
            val sysKey = t?.sys ?: key.substringBeforeLast('/')
            val sys = s.systems.firstOrNull { it.key == sysKey }
            col = colorOf(sysKey); tgKey = key
            val calls = s.calls.filter { it.kind == "call" && it.group && it.sys == sysKey && it.tg == tg }
            val onAir = calls.firstOrNull { it.onAir }
            id = "TG $tg"; kindLabel = "TALKGROUP"; label = sys?.let { Dispatch.sysTitle(it) } ?: sysKey
            chips.add(seenChip(max(t?.lastMs ?: 0L, calls.maxOfOrNull { if (it.onAir) now else it.endMs } ?: 0L), now))
            if (onAir != null) chips.add(CardChip(if (s.playing == onAir.key) "PLAYING" else "ON THE AIR", ChipTone.OK, true))
            if (calls.any { it.emergency }) chips.add(CardChip("EMERGENCY", ChipTone.RED))
            encChip(calls)?.let { chips.add(it) }
            val units = s.units.filter { it.sys == sysKey && (t?.members?.contains(it.id) == true || tg in it.groups) }.sortedByDescending { it.lastMs }
            val placed = units.filter { it.lat != null && it.lon != null }
            secs.add(CardSec("NOW", true) {
                StatTiles(listOf("${t?.grants ?: 0}" to "GRANTS", "${t?.recent?.size ?: 0}" to "IN 10 MIN", "${calls.size}" to "CALLS KEPT", "${units.size}" to "UNITS"))
                CardKv(kvOf("TALKGROUP" to "$tg · 0x${hex(tg)}", "SYSTEM" to sys?.let { "${Dispatch.sysTitle(it)} · ${sysType(it, s)}" },
                    "FIRST HEARD" to t?.let { flClock(it.firstMs) }, "LAST HEARD" to t?.let { "${flClock(it.lastMs)} · ${DispatchView.agoShort(now - it.lastMs)} ago" }))
            })
            if (calls.isNotEmpty()) secs.add(CardSec("RECENT CALLS") { CardCalls(calls, 14, now, me, colorOf, acts) })
            if (units.isNotEmpty()) secs.add(CardSec("UNITS · ${units.size}") {
                if (placed.isNotEmpty()) CardUnitsMap("tg:$key", placed, col, me, acts)
                CardTags(units.take(40).map { Triple("${it.id}", DispatchView.agoShort(now - it.lastMs), "unit:${it.key}") }, col, acts)
            })
            activitySec(t?.history.orEmpty().map { it.ms } + t?.recent.orEmpty() + calls.map { it.startMs }, now, col)?.let { secs.add(it) }
            if (t != null && t.history.isNotEmpty()) secs.add(CardSec("GRANTS", true) { Column(verticalArrangement = Arrangement.spacedBy(3.dp)) { for (g in t.history) GrantLine(g, now, col) {} } })
        }
        "sys" -> {
            val x = s.systems.firstOrNull { it.key == key } ?: return
            col = colorOf(x.key)
            val calls = s.calls.filter { it.kind == "call" && it.sys == x.key }
            val units = s.units.filter { it.sys == x.key }; val placed = units.filter { it.lat != null && it.lon != null }
            id = Dispatch.sysTitle(x); kindLabel = "SYSTEM"; label = x.label
            chips.add(if (s.carriers.any { it.sys == x.key && now - it.lastDecodeMs < 10_000 }) CardChip("LIVE", ChipTone.OK) else seenChip(x.lastMs, now))
            chips.add(CardChip(sysType(x, s)))
            encChip(calls)?.let { chips.add(it) }
            calls.count { it.onAir }.takeIf { it > 0 }?.let { chips.add(CardChip("$it ON THE AIR", ChipTone.OK, true)) }
            val tgs = s.tgs.filter { it.sys == x.key }.sortedWith(compareByDescending<com.rocketgod.mayhem.core.fleet.TgRow> { it.grants }.thenByDescending { it.lastMs })
            val busiest = if (tgs.isNotEmpty()) tgs.take(12).map { it.tg to it.grants }
                else calls.filter { it.group && it.tg != 0 }.groupingBy { it.tg }.eachCount().entries.sortedByDescending { it.value }.take(12).map { it.key to it.value }
            val (enc, n) = DispatchView.encShare(calls)
            secs.add(CardSec("OVERVIEW", true) {
                StatTiles(listOfNotNull("${x.sites.size}" to "SITES", "${units.size}" to "UNITS", "${if (x.tgs > 0) x.tgs else tgs.size}" to "TALKGROUPS", "${x.grants}" to "GRANTS",
                    if (n > 0) "${Math.round(100.0 * enc / n)}%" to "ENCRYPTED" else null))
                val ids = when (x.proto) {
                    "SMARTNET" -> arrayOf<Pair<String, String?>>("SYSTEM ID" to hx(x.sysId, 4), "CHANNEL PLAN" to x.sites.firstOrNull { it.time.isNotEmpty() }?.time)
                    "NXDN" -> when (x.trunk) {
                        "CONVENTIONAL" -> arrayOf<Pair<String, String?>>("RAN" to "${x.sysId}")
                        "TYPE-D" -> arrayOf<Pair<String, String?>>("SITE CODE" to "${x.sysId}")
                        else -> arrayOf<Pair<String, String?>>("CATEGORY" to x.model, "SYSTEM CODE" to "${x.sysId}")
                    }
                    "TETRA" -> arrayOf<Pair<String, String?>>("MCC" to "${x.wacn}", "MNC" to "${x.sysId}", "COLOR CODE" to "${x.cc}", "AIR INTERFACE" to x.security.ifEmpty { null })
                    "P25" -> arrayOf<Pair<String, String?>>("WACN" to hx(x.wacn, 5), "SYSTEM" to hx(x.sysId, 3))
                    else -> arrayOf<Pair<String, String?>>("COLOR CODE" to "${x.cc}", "FEATURE SET" to (if (x.fid >= 0) "0x${hx(x.fid, 2)}" else null), "NETWORK" to (if (x.net >= 0) "${x.model} ${x.net}" else null))
                }
                CardKv(kvOf("TYPE" to sysType(x, s), *ids, "CW ID" to x.callsign, "FIRST HEARD" to "${flClock(x.firstMs)} · ${DispatchView.agoShort(now - x.firstMs)} ago",
                    "LAST HEARD" to "${flClock(x.lastMs)} · ${DispatchView.agoShort(now - x.lastMs)} ago", "ENCRYPTION" to (if (n > 0) "$enc of $n calls" else null)))
            })
            if (x.sites.isNotEmpty() || x.lpcns.isNotEmpty()) secs.add(CardSec("SITES AND CHANNELS") {
                for (st in x.sites) CardSite(x, st, col)
                if (x.lpcns.isNotEmpty()) {
                    if (x.proto == "NXDN") FlChips("CHANNELS", x.lpcns.map { "${if (x.trunk == "TYPE-D") "REPEATER" else "CH"} ${it.lpcn} ${mhz(it.hz)} · ${it.votes} heard" to true }, col)
                    else FlChips("LOGICAL CHANNELS", x.lpcns.map { "LPCN ${it.lpcn} ${mhz(it.hz)} · ${it.votes} calls" to true }, col)
                }
            })
            if (busiest.isNotEmpty()) secs.add(CardSec("BUSIEST TALKGROUPS") { CardTags(busiest.map { (tg, c) -> Triple("TG $tg", "$c", "tg:${x.key}/$tg") }, col, acts) })
            if (placed.isNotEmpty()) secs.add(CardSec("COVERAGE") {
                CardUnitsMap("sys:${x.key}", placed, col, me, acts)
                val la0 = placed.minOf { it.lat!! }; val la1 = placed.maxOf { it.lat!! }; val lo0 = placed.minOf { it.lon!! }; val lo1 = placed.maxOf { it.lon!! }
                val h = DispatchView.distBearing(la0, lo0, la0, lo1).mi; val v = DispatchView.distBearing(la0, lo0, la1, lo0).mi
                CardKv(kvOf("UNITS PLACED" to "${placed.size} of ${units.size}", "AREA" to "%.1f × %.1f mi".format(java.util.Locale.US, max(0.1, h), max(0.1, v))))
            })
            if (units.isNotEmpty()) secs.add(CardSec("UNITS · ${units.size}") {
                CardTags(units.sortedByDescending { it.lastMs }.take(40).map { Triple("${it.id}", DispatchView.agoShort(now - it.lastMs), "unit:${it.key}") }, col, acts)
                if (units.size > 40) CardNote("${units.size - 40} more")
            })
            activitySec(s.grants.filter { it.sys == x.key }.map { it.ms } + calls.map { it.startMs }, now, col)?.let { secs.add(it) }
            if (calls.isNotEmpty()) secs.add(CardSec("RECENT CALLS") { CardCalls(calls, 8, now, me, colorOf, acts) })
            if (x.proto == "P25" && x.idens.isNotEmpty()) secs.add(CardSec("CHANNEL TABLE", true) { IdenTable(x.idens) })
        }
        else -> {
            val c = s.carriers.firstOrNull { "${it.key}" == key } ?: return
            val sys = if (c.sys.isNotEmpty()) s.systems.firstOrNull { it.key == c.sys } else null
            col = if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.muted
            val calls = s.calls.filter { it.kind == "call" && abs(it.hz - c.hz) < 3_200 }
            id = mhz(c.hz); kindLabel = "CARRIER"; label = sys?.let { Dispatch.sysTitle(it) } ?: c.cls.ifEmpty { "not classed yet" }
            chips.add(if (now - c.lastDecodeMs < 10_000) CardChip("DECODING", ChipTone.OK) else if (now - c.lastMs < 4_000) CardChip("ON THE AIR", ChipTone.OK) else seenChip(c.lastMs, now))
            if (c.cls.isNotEmpty()) chips.add(CardChip(c.cls))
            if (c.role.isNotEmpty()) chips.add(CardChip(c.role.uppercase(), ChipTone.ACC))
            secs.add(CardSec("SIGNAL", true) {
                StatTiles(listOfNotNull("%.0f dB".format(java.util.Locale.US, c.levelDb) to "LEVEL · PEAK %.0f".format(java.util.Locale.US, c.peakDb),
                    if (c.blocks > 0) "${Math.round(100.0 * c.crcOk / max(1, c.blocks))}%" to "BLOCKS PASSING · ${c.crcOk}/${c.blocks}" else null,
                    if (c.frames > 0) "${c.frames}" to "FRAMES" else null, if (c.onMs > 0) DispatchView.spanShort(c.onMs) to "ON THE AIR" else null))
                CardKv(kvOf("FREQUENCY" to "${mhz(c.hz)} MHz", "SYSTEM" to sys?.let { "${Dispatch.sysTitle(it)} · ${sysType(it, s)}" },
                    "NAC" to (if (c.nac >= 0) hx(c.nac, 3) else null), "COLOR CODE" to (if (c.cc >= 0) "${c.cc}" else null), "LCN" to c.lcn,
                    "CW ID" to (if (c.callsign.isNotEmpty()) c.callsign + (if (c.callsignMs > 0) " · ${flClock(c.callsignMs)}" else "") else null),
                    "ENVELOPE" to "%.2f (constant near 0, linear near 0.3)".format(java.util.Locale.US, c.envCv), "EYE" to "%.2f".format(java.util.Locale.US, c.eye),
                    "FIRST HEARD" to flClock(c.firstMs), "LAST HEARD" to "${flClock(c.lastMs)} · ${DispatchView.agoShort(now - c.lastMs)} ago"))
            })
            if (calls.isNotEmpty()) secs.add(CardSec("CALLS ON THIS CHANNEL") { CardCalls(calls, 8, now, me, colorOf, acts) })
            activitySec(calls.map { it.startMs }, now, col)?.let { secs.add(it) }
        }
    }
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().then(if (inline) Modifier else Modifier.heightIn(max = d.dp(if (wide) 560f else 460f))).clip(shape).background(Palette.panel.copy(alpha = 0.97f))
        .border(1.5.dp, col.copy(alpha = 0.8f), shape).then(if (inline) Modifier else Modifier.scrollGlow(scroll).verticalScroll(scroll)).padding(d.dp(10f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
        CardHead(id, kindLabel, label, col, chips, now, wide, if (mapBtn) onMap else null, onClose)
        if (tgKey != null) PrefButtons(tgKey, prefs, acts)
        CardGrid(secs)
    }
}

/** The activity section: calls and reports in the last hour (30 bars) and the last day (24), when there were any. */
private fun activitySec(times: List<Long>, now: Long, col: Color): CardSec? {
    if (times.isEmpty()) return null
    val hr = DispatchView.activityBuckets(times, now, 3_600_000, 30); val day = DispatchView.activityBuckets(times, now, 86_400_000, 24)
    val inHour = hr.sum(); val inDay = day.sum()
    if (inHour == 0 && inDay <= inHour) return null
    return CardSec("ACTIVITY") {
        if (inHour > 0) Spark("LAST HOUR · $inHour", hr.map { it.toFloat() }, col)
        if (inDay > inHour) Spark("LAST DAY · $inDay", day.map { it.toFloat() }, col)
    }
}

/** The card's header: a big ID, what it is, its system, the status chips, and MAP and close. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardHead(id: String, kind: String, label: String, col: Color, chips: List<CardChip>, now: Long, wide: Boolean, onMap: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Row(Modifier.fillMaxWidth().clip(shape).background(Brush.linearGradient(listOf(col.copy(alpha = 0.24f), col.copy(alpha = 0.04f))))
        .border(1.dp, col.copy(alpha = 0.45f), shape).padding(horizontal = d.dp(11f), vertical = d.dp(9f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(if (wide) 14f else 10f))) {
        Column(Modifier.widthIn(max = d.dp(if (wide) 360f else 190f))) {
            val big = if (id.length > 12) (if (wide) 24f else 19f) else if (wide) 34f else 28f
            Text(id, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(big), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = androidx.compose.ui.text.TextStyle(shadow = androidx.compose.ui.graphics.Shadow(col.copy(alpha = 0.55f), blurRadius = 18f)))
            Text(kind, color = col, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 3.sp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            if (label.isNotEmpty()) Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) { for (c in chips) StatusChip(c, now) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(5f)), horizontalAlignment = Alignment.End) {
            ToggleBox("✕", false, col) { onClose() }
            if (onMap != null) ToggleBox("MAP", false, col) { onMap() }
        }
    }
}

@Composable
private fun StatusChip(c: CardChip, now: Long) {
    val d = rememberDims()
    val tone = when (c.tone) { ChipTone.OK -> Palette.ok; ChipTone.RED -> Palette.danger; ChipTone.ACC -> Palette.accent2; ChipTone.PLAIN -> Palette.muted }
    val filled = c.tone == ChipTone.RED
    Row(Modifier.clip(RoundedCornerShape(50)).background(if (filled) tone else Color.Transparent).border(1.dp, tone.copy(alpha = if (c.tone == ChipTone.PLAIN) 0.4f else 0.6f), RoundedCornerShape(50))
        .padding(horizontal = d.dp(8f), vertical = d.dp(3f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        if (c.live) Box(Modifier.size(d.dp(6f)).alpha(if ((now / 500) % 2 == 1L) 0.25f else 1f).background(tone, CircleShape))
        Text(c.text, color = if (filled) Color.White else tone, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8.5f), letterSpacing = 1.2.sp, maxLines = 1)
    }
}

/** The sections: one column on a phone, two side by side where the card is wide enough; a wide section takes the row. */
@Composable
private fun CardGrid(secs: List<CardSec>) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val two = maxWidth >= d.dp(600f)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            if (!two) for (x in secs) SecBox(x, Modifier.fillMaxWidth())
            else {
                var i = 0
                while (i < secs.size) {
                    val a = secs[i]
                    if (a.wide) { SecBox(a, Modifier.fillMaxWidth()); i++; continue }
                    val b = secs.getOrNull(i + 1)?.takeIf { !it.wide }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalAlignment = Alignment.Top) {
                        SecBox(a, Modifier.weight(1f))
                        if (b != null) SecBox(b, Modifier.weight(1f)) else Spacer(Modifier.weight(1f))
                    }
                    i += if (b != null) 2 else 1
                }
            }
        }
    }
}

@Composable
private fun SecBox(x: CardSec, modifier: Modifier) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(modifier.clip(shape).background(Palette.surface.copy(alpha = 0.55f)).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(11f), vertical = d.dp(10f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Text(x.title, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp)
        x.body()
    }
}

@Composable
private fun CardKv(kv: List<Pair<String, String>>) {
    if (kv.isEmpty()) return
    SelectionContainer { FieldGrid(kv, labelWidth = 104f, minColumn = 260f) }
}

@Composable
private fun CardNote(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
}

/** Big numbers: a value and what it is. A zero is left out, never shown as a tile. */
@Composable
private fun StatTiles(stats: List<Pair<String, String>>) {
    val shown = stats.filter { it.first != "0" && it.first != "0%" }
    if (shown.isEmpty()) return
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = d.dp(6f)
        val cols = ((maxWidth + gap) / (d.dp(104f) + gap)).toInt().coerceIn(1, shown.size)
        Column(verticalArrangement = Arrangement.spacedBy(gap)) {
            for (row in shown.chunked(cols)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (i in 0 until cols) {
                    val t = row.getOrNull(i)
                    if (t == null) { Spacer(Modifier.weight(1f)); continue }
                    val shape = RoundedCornerShape(d.dp(8f))
                    Column(Modifier.weight(1f).clip(shape).background(Palette.panel).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(8f), vertical = d.dp(7f)),
                        verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                        Text(t.first, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(17f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(t.second, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.2.sp, maxLines = 2)
                    }
                }
            }
        }
    }
}

/**
 * The map on a detail card: the main map's tiles and markers at a fixed height, so the rest of the card stays in reach.
 * Framed on [fit] and you; one finger scrolls the card past it, two move it. A new card ([key]) starts a new view.
 */
@Composable
private fun CardMap(key: String, items: List<GeoItem>, selected: String?, shapes: List<GeoShape>, me: Pair<Double, Double>?, fit: List<Pair<Double, Double>>, acts: DispatchActs) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    androidx.compose.runtime.key(key) {
        GeoMapView(items, Palette.accent, Modifier.fillMaxWidth().height(d.dp(220f)).clip(shape).border(1.dp, Palette.line, shape),
            home = me, selected = selected, layers = GeoLayers(shapes = shapes), fitPts = fit + listOfNotNull(me), fitPins = true, steady = true,
            twoFinger = true, declutter = true, fitItems = false) { if (it != selected) acts.pick("unit:$it") }
    }
}

/** A talkgroup's or system's placed units on the card map, labeled, you with them when you are within 60 miles. */
@Composable
private fun CardUnitsMap(key: String, placed: List<UnitRow>, col: Color, me: Pair<Double, Double>?, acts: DispatchActs) {
    val c = col.toArgb()
    val near = me?.takeIf { m -> placed.any { DispatchView.distBearing(m.first, m.second, it.lat!!, it.lon!!).mi < 60 } }
    CardMap(key, placed.map { GeoItem(it.key, it.lat!!, it.lon!!, "${it.id}", GeoItem.Kind.STATION, color = c) }, null, emptyList(), near,
        placed.map { it.lat!! to it.lon!! }, acts)
}

/** A bar sparkline under its label: empty buckets as a thin baseline. */
@Composable
private fun Spark(label: String, b: List<Float>, col: Color) {
    if (b.isEmpty()) return
    val d = rememberDims()
    val line = Palette.line
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.2.sp)
        Canvas(Modifier.fillMaxWidth().height(d.dp(34f))) {
            val top = max(1f, b.max()); val bw = size.width / b.size; val hh = size.height
            b.forEachIndexed { i, v ->
                val x = i * bw + 0.5f; val wd = max(1f, bw - 1f)
                if (v > 0) { val bh = (hh - 4f) * v / top + 2f; drawRoundRect(col, Offset(x, hh - bh), Size(wd, bh), CornerRadius(1.5f)) }
                else drawRect(line, Offset(x, hh - 2f), Size(wd, 2f))
            }
        }
    }
}

/** Tappable tags: a name and a count or age; a tap opens that unit or talkgroup. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardTags(tags: List<Triple<String, String, String>>, col: Color, acts: DispatchActs) {
    val d = rememberDims()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        for ((name, sub, sel) in tags) {
            val shape = RoundedCornerShape(d.dp(7f))
            Row(Modifier.clip(shape).background(Palette.panel).border(1.dp, col.copy(alpha = 0.45f), shape).clickable { acts.pick(sel) }.padding(horizontal = d.dp(8f), vertical = d.dp(4f)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text(name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
                if (sub.isNotEmpty()) Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
            }
        }
    }
}

/** Calls, newest first, each with its replay where audio was kept. */
@Composable
private fun CardCalls(calls: List<CallRow>, n: Int, now: Long, me: Pair<Double, Double>?, colorOf: (String) -> Color, acts: DispatchActs) {
    val d = rememberDims()
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        for (c in calls.take(n)) CallLine(c, now, me, if (c.sys.isNotEmpty()) colorOf(c.sys) else Palette.muted, acts)
        if (calls.size > n) CardNote("${calls.size - n} more")
    }
}

/** A system's site: its channels, the logical channels with the rest one lit, its CW ID and neighbors. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardSite(x: SystemRow, st: SiteRow, col: Color) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.panel).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(8f), vertical = d.dp(6f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f)), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(if (x.proto == "P25") "SITE ${st.label}" else st.label.uppercase(), color = col, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp)
            val chs = st.ccHz.joinToString(" · ") { mhz(it) } + if (st.callsign.isNotEmpty()) " · ${st.callsign}" else ""
            if (chs.isNotEmpty()) Text(chs, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
            if (st.neighbors.isNotEmpty()) Text("${st.neighbors.size} neighbor${if (st.neighbors.size > 1) "s" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
        if (st.lcns.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (l in st.lcns) {
                val c = if (l.lcn == st.rest) Palette.ok else if (l.lcn in st.busy) Palette.accent2 else Palette.muted
                Text("LCN ${l.lcn} ${mhz(l.hz)}", color = c, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(d.dp(5f))).border(1.dp, if (c == Palette.muted) Palette.line else c, RoundedCornerShape(d.dp(5f))).padding(horizontal = d.dp(6f), vertical = d.dp(1f)))
            }
        }
    }
}

/** Every report a unit sent, newest first: time, what and where, the decoded line, the block as sent. */
@Composable
private fun CardReports(reports: List<com.rocketgod.mayhem.core.fleet.UnitReport>) {
    val d = rememberDims()
    val scroll = rememberScrollState()
    SelectionContainer {
        Column(Modifier.heightIn(max = d.dp(280f)).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
            for (r in reports.reversed().take(40)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(flClock(r.ms), color = if (r.verified) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), modifier = Modifier.width(d.dp(64f)))
                Column(Modifier.weight(1f)) {
                    Text("${r.kind} · ${mhz(r.hz)}" + (if (r.lat != null && r.lon != null) " · %.5f, %.5f".format(java.util.Locale.US, r.lat, r.lon) else ""), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f))
                    Text(r.text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                    Text(r.hex, color = Palette.ink.copy(alpha = 0.55f), fontFamily = Mono, fontSize = d.sp(8.5f))
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
