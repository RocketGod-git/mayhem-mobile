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
import androidx.compose.foundation.layout.widthIn
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
import com.rocketgod.mayhem.core.fleet.FleetProcessor
import com.rocketgod.mayhem.core.fleet.FleetSnap
import com.rocketgod.mayhem.core.fleet.GrantRow
import com.rocketgod.mayhem.core.fleet.Iden
import com.rocketgod.mayhem.core.fleet.SiteRow
import com.rocketgod.mayhem.core.fleet.SystemRow
import com.rocketgod.mayhem.core.fleet.hx
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

/** One color per system, used on the cards, the map, the feed and the frequency list. */
private val FLEET_COLORS = listOf(0xFF4C8DFF, 0xFFFFAF00, 0xFF3DDC84, 0xFFFF5BD2, 0xFF00D5FF, 0xFFFF7A45, 0xFFB18CFF, 0xFFE8E14A, 0xFFFF5B52, 0xFF52FFB8).map { Color(it) }
private val VIEWS = listOf("SYSTEMS", "CALLS", "MAP", "GRANTS", "FREQS", "LOG")
private const val V_SYSTEMS = 0
private const val V_CALLS = 1
private const val V_MAP = 2
private const val V_GRANTS = 3
private const val V_FREQS = 4
private const val V_LOG = 5
/** On a wide screen the map has the big pane, so it is not a tab. */
private val WIDE_VIEWS = listOf(V_SYSTEMS, V_CALLS, V_GRANTS, V_FREQS, V_LOG)

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
    c.codec !in codecs -> if (c.codec == "imbe") "no audio yet, the P25 full-rate vocoder is not built" else "no audio yet, the half-rate vocoder for ${if (c.proto == "DMR") "DMR" else "Phase 2"} is not built"
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
    var view by rememberSaveable { mutableIntStateOf(V_SYSTEMS) }
    /** What is open for its details: "unit:<key>", "tg:<key>", "sys:<key>" or "car:<key>". */
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var held by remember { mutableStateOf<FleetSnap?>(null) }
    var full by remember { mutableStateOf(false) }
    var focusKey by remember { mutableIntStateOf(0) }
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
    LaunchedEffect(wide) { if (wide) { if (view == V_MAP) view = V_SYSTEMS; full = false } }
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
        if (!wide) view = V_MAP
        if (unitKey.isNotEmpty() && s?.units?.any { it.key == unitKey } == true) sel = "unit:$unitKey"
        focusAt = lat to lon; focusKey++
    }
    fun lockFor(sys: String, site: String = "") { Dispatch.lockFor(sys, site)?.let { Dispatch.setLock(it) } }
    val acts = DispatchActs(::pick, { k, key -> Dispatch.pref(k, key) }, { Dispatch.replay(it) }, ::goTo, ::lockFor, { Dispatch.setLock(null) })

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        val counts = listOf("${s?.systems?.size ?: 0}", "${s?.calls?.size ?: 0}", "${pins.size}", "${s?.grants?.size ?: 0}", "${s?.let { liveCarriers(it, now).size } ?: 0}", "${logSnap.total}")
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.Top) {
            FlSeg(tabs.map { if (it == V_LOG) VIEWS[it] else "${VIEWS[it]} ${counts[it]}" }, tabs.indexOf(view), accent, Modifier.weight(1f)) { view = tabs[it] }
            ToggleBox("EXPORT", false, accent) { export() }
            ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent) { held = if (held == null) live else null }
            IconBox(ClearIcon, "Clear") { Apps.fleet.clear(); Apps.fleetLog.clear(); Dispatch.forget(); held = null; sel = null }
            if (withFull && !wide) IconBox(FullscreenIcon, "Full screen") { full = true }
        }
    }

    @Composable
    fun fleetMap(modifier: Modifier) {
        Box(modifier) {
            val pu = pins.firstOrNull { "unit:${it.key}" == sel }
            GeoMapView(mapItems, accent, Modifier.fillMaxSize().panel(), home = fix, selected = pu?.key, layers = GeoLayers(shapes = trails),
                start = remember { mapStart(Geo.fix.value) }, focus = focusAt ?: pu?.let { it.lat!! to it.lon!! }, focusKey = focusKey, steady = true, fitPins = true,
                fallback = { Geo.fix.value ?: Geo.lastKnownPos() ?: Geo.zoneGuess() },
                // unit reports carry only the low bits of a position: with no position of our own, the region on the map resolves them
                onDragEnd = { lat, lon -> if (Geo.fix.value == null && Geo.lastKnownPos() == null) Apps.fleet.setRef(lat, lon) }) { pick("unit:$it") }
            if (pins.isEmpty()) Text(if (s != null && s.units.any { it.posMs > 0 } && !s.ref) "unit positions need a region, drag the map to your area" else "no unit positions on the air yet",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
        }
    }

    @Composable
    fun detail(modifier: Modifier) {
        if (s != null && sel != null) {
            val det = fleetDetail(s, sel!!, now, if (wide) V_MAP else view)
            if (det != null) FleetDetailPanel(det, s, now, accent, prefs, me, colorOf, acts, modifier,
                onMap = if (det.mapKey != null) ({ if (!wide) view = V_MAP; focusAt = null; focusKey++ }) else null) { sel = null }
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
            fun modeRow() = ModeRow(lock, accent) { all -> if (all) Dispatch.setLock(null) else if (!Dispatch.lockSomething(sel?.takeIf { it.startsWith("sys:") }?.substringAfter(':')))
                Toast.makeText(ctx, "no system to lock on yet, wait for one to show or lock from its card", Toast.LENGTH_SHORT).show() }
            if (!wide && view == V_MAP) {
                // the phone map: right under the tabs, never below the fold. With anything on it, it fills the height there
                // is (360 dp at least); it stays compact only while no unit position has been heard. The rest scrolls under it.
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f))) {
                    val avail = maxHeight
                    val mapScroll = rememberScrollState()
                    LaunchedEffect(view) { mapScroll.scrollTo(0) }
                    val mapH = if (pins.isNotEmpty()) maxOf(avail - d.dp(48f), 360.dp) else minOf(maxOf(avail * 0.5f, d.dp(200f)), 360.dp)
                    Column(Modifier.fillMaxWidth().verticalScroll(mapScroll), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        switcher(true, Modifier.fillMaxWidth())
                        stage(Modifier.fillMaxWidth().height(mapH))
                        if (s != null && audioOn && s.codecs.isNotEmpty()) NowBar(s, now, lock, me, vu, colorOf, acts)
                        onAir(Modifier.fillMaxWidth())
                        FleetHead(s, scan, now, accent)
                        modeRow()
                        if (s != null && s.codecs.isNotEmpty()) AudioRow(audioOn, gain, accent)
                    }
                }
            } else Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                if (s != null && audioOn && s.codecs.isNotEmpty()) NowBar(s, now, lock, me, vu, colorOf, acts)
                FleetHead(s, scan, now, accent)
                switcher(true, Modifier.fillMaxWidth())
                modeRow()
                if (s != null && s.codecs.isNotEmpty()) AudioRow(audioOn, gain, accent)
                // a wide screen docks the details above the cards
                if (wide) detail(Modifier.fillMaxWidth())
                onAir(Modifier.fillMaxWidth())
                stage(Modifier.fillMaxWidth().weight(1f))
            }
        })
    if (full) FullscreenPanel("DISPATCH · ${VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        onAir(Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** What the cards and rows can do: open a detail, set a talkgroup preference, replay, show on the map, lock and unlock. */
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
        if (c.src != 0) Text("← ${c.src}", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
        val sys = s.systems.firstOrNull { it.key == c.sys }
        Text("${sys?.let { Dispatch.sysTitle(it) } ?: c.sys.ifEmpty { c.proto }}${if (c.site.isNotEmpty()) " · SITE ${c.site}" else ""} · ${mhz(c.hz)} MHz${c.pos?.let { " · ${DispatchView.posText(it, me)}" } ?: ""}",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        FlBar(dispatchVuFrac(vu, c.key), Palette.ok, Modifier.width(d.dp(70f)).height(d.dp(6f)))
        Text(flDur(now - c.startMs), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
    }
}

/** ALL hears every system; LOCK stays on one, shown with its name and a tap to unlock. */
@Composable
private fun ModeRow(lock: Lock?, accent: Color, onPick: (all: Boolean) -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        SegBar(listOf("ALL", "LOCK"), if (lock == null) 0 else 1, accent, Modifier.width(d.dp(150f))) { onPick(it == 0) }
        if (lock != null) {
            val shape = RoundedCornerShape(d.dp(9f))
            Row(Modifier.weight(1f).clip(shape).background(accent.copy(alpha = 0.14f)).border(1.dp, accent, shape).clickable { onPick(true) }.padding(horizontal = d.dp(9f), vertical = d.dp(6f)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text("LOCKED ON", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                Text(lock.label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("UNLOCK", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
            }
        } else Text("every system, first call to talk is heard", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, modifier = Modifier.weight(1f))
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
        for ((k, label, on) in listOf(Triple("mute", "MUTE", key in prefs.mute), Triple("hold", "HOLD", prefs.hold == key), Triple("prio", "PRIORITY", key in prefs.prio))) {
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
    val lp = if (c.lpcn >= 0) " · LPCN ${c.lpcn}" else ""
    val ch = if (c.hz > 0) "${mhz(c.hz)} MHz${if (c.tdma) " · TDMA S${c.slot + 1}" else if (c.proto == "DMR") " · TS${c.slot + 1}" else ""}$lp"
        else if (c.lpcn >= 0) "LPCN ${c.lpcn} · TS${c.slot + 1} · learning its frequency" else "channel not resolved"
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
                Text("UNIT", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                Text(if (c.src != 0) "${c.src}" else "-", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
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
        if (c.src != 0) Text("← ${c.src}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1)
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
                Text("${if (x.callsign.isNotEmpty()) "${x.callsign} · " else ""}${x.sites.size} site${if (x.sites.size == 1) "" else "s"} · ${x.units} units · ${x.tgs} talkgroups · ${x.grants} grants",
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
                val role = when (c.role) { "rest" -> "REST"; "control" -> if (sys.proto == "P25") "CONTROL" else "REPEATER"; else -> c.role.uppercase() }
                Column(Modifier.clip(RoundedCornerShape(d.dp(8f))).border(1.dp, col.copy(alpha = if (c.role == "rest") 1f else 0.5f), RoundedCornerShape(d.dp(8f)))
                    .background(col.copy(alpha = if (c.role == "rest") 0.18f else 0.06f)).clickable { acts.pick("car:${c.key}") }.padding(horizontal = d.dp(7f), vertical = d.dp(3f))) {
                    Text(mhz(c.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
                    Text(role + if (c.lcn.isNotEmpty()) " · LCN ${c.lcn}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
                }
            }
        }
        when (sys.proto) {
            "NXDN" -> FlKv(listOfNotNull("SITE" to "${site.site}", if (site.time.isNotEmpty()) "" to site.time.uppercase() else null, if (site.cls > 0) "VERSION" to "${site.cls}" else null))
            "TETRA" -> FlKv(listOfNotNull("COLOR CODE" to "${site.site}", if (site.time.isNotEmpty()) "" to site.time.uppercase() else null,
                if (site.cls >= 0) "CELL LOAD" to (listOf("LOW", "MEDIUM", "HIGH", "UNKNOWN").getOrNull(site.cls) ?: "${site.cls}") else null))
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
    val ch = if (g.hz > 0) mhz(g.hz) + (if (g.tdma) " · TDMA S${g.slot + 1}" else if (lp >= 0) " · TS${g.slot + 1} · LPCN $lp" else "")
        else g.ch + (if (lp >= 0) " · TS${g.slot + 1}" else if (g.tdma && g.slot >= 0) " · TS${g.slot + 1}" else "")
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

private class FleetDetail(val title: String, val kind: String, val fields: List<Pair<String, String>>, val chipsLabel: String = "", val chips: List<Pair<String, String>> = emptyList(),
                          val histLabel: String = "", val hist: List<Triple<String, String, String>> = emptyList(), val idens: List<Iden>? = null, val grants: List<GrantRow> = emptyList(),
                          val mapKey: String? = null, val color: Color? = null,
                          /** A talkgroup's preference key, and its recent calls. */ val tgKey: String? = null, val calls: List<CallRow> = emptyList(),
                          /** DMR logical channels placed on their carriers. */ val lpcns: List<Pair<String, String>> = emptyList())

/** Every field held for what is selected. */
private fun fleetDetail(s: FleetSnap, sel: String, now: Long, view: Int): FleetDetail? {
    val kind = sel.substringBefore(':'); val key = sel.substringAfter(':')
    fun sysLabel(k: String) = s.systems.firstOrNull { it.key == k }?.label ?: k
    when (kind) {
        "unit" -> {
            val u = s.units.firstOrNull { it.key == key } ?: return null
            val full = Apps.fleet.unitDetail(u.key)?.reports ?: u.reports
            val pos = if (u.lat != null && u.lon != null) "%.5f, %.5f".format(java.util.Locale.US, u.lat, u.lon)
                else if (u.posMs > 0) (if (s.ref) "-" else "needs your location to resolve") else "none on the air"
            val f = listOf("UNIT ID" to "${u.id} (0x${Integer.toHexString(u.id).uppercase()})", "SYSTEM" to sysLabel(u.sys), "SITE" to u.site.ifEmpty { "-" }, "POSITION" to pos,
                "LAST POSITION" to (if (u.posMs > 0) "${flClock(u.posMs)} · ${flAgoText(now - u.posMs)}" else "-"), "TALKGROUPS" to u.groups.joinToString(", ").ifEmpty { "-" },
                "GRANTS" to "${u.grants}", "HEARD ON" to u.carriers.joinToString(" · ") { k -> mhz(s.carriers.firstOrNull { it.key == k }?.hz ?: k) },
                "FIRST HEARD" to flClock(u.firstMs), "LAST HEARD" to "${flClock(u.lastMs)} · ${flAgoText(now - u.lastMs)}")
            val hist = full.reversed().map { r -> Triple(flClock(r.ms), "${r.kind} · ${mhz(r.hz)}" + (if (r.lat != null && r.lon != null) " · %.5f, %.5f".format(java.util.Locale.US, r.lat, r.lon) else "") + "\n${r.text}", r.hex) }
            return FleetDetail("${u.id}", "UNIT", f, histLabel = "EVERY REPORT", hist = hist, mapKey = if (u.lat != null && view != V_MAP) u.key else null)
        }
        "tg" -> {
            val t = s.tgs.firstOrNull { it.key == key }
            val tg = t?.tg ?: key.substringAfterLast('/').toIntOrNull() ?: return null
            val sys = t?.sys ?: key.substringBeforeLast('/')
            val f = if (t != null) listOf("TALKGROUP" to "${t.tg} (0x${Integer.toHexString(t.tg).uppercase()})", "SYSTEM" to sysLabel(t.sys), "GRANTS" to "${t.grants} · ${t.recent.size} in 10 min",
                "FIRST" to flClock(t.firstMs), "LAST" to "${flClock(t.lastMs)} · ${flAgoText(now - t.lastMs)}")
                else listOf("TALKGROUP" to "$tg (0x${Integer.toHexString(tg).uppercase()})", "SYSTEM" to sysLabel(sys))
            val calls = s.calls.filter { it.group && it.sys == sys && it.tg == tg }.take(12)
            return FleetDetail("TG $tg", "TALKGROUP", f, chipsLabel = "MEMBERS", chips = t?.members.orEmpty().map { "$it" to "unit:$sys/$it" }, histLabel = "HISTORY",
                grants = t?.history.orEmpty(), tgKey = key, calls = calls)
        }
        "sys" -> {
            val x = s.systems.firstOrNull { it.key == key } ?: return null
            val f = when (x.proto) {
                "NXDN" -> listOf("PROTOCOL" to "NXDN", "CATEGORY" to x.model, "SYSTEM CODE" to "${x.sysId}", "SITES" to x.sites.joinToString(", ") { "${it.site}" },
                    "CARRIERS" to x.sites.joinToString(", ") { mhz(it.ccHz.firstOrNull() ?: 0L) }, "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
                "TETRA" -> listOf("PROTOCOL" to "TETRA", "MCC" to "${x.wacn}", "MNC" to "${x.sysId}", "COLOR CODE" to "${x.cc}",
                    "CARRIERS" to x.sites.joinToString(", ") { mhz(it.ccHz.firstOrNull() ?: 0L) }, "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
                "P25" -> listOf("PROTOCOL" to "P25 Phase 1 control channel", "WACN" to hx(x.wacn, 5), "SYSTEM" to hx(x.sysId, 3), "SITES" to x.sites.joinToString(", ") { it.label },
                    "UNITS" to "${x.units}", "TALKGROUPS" to "${x.tgs}", "GRANTS" to "${x.grants}", "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
                else -> listOfNotNull("PROTOCOL" to "DMR", if (x.trunk.isNotEmpty()) "TRUNKING" to x.trunk else null, "COLOR CODE" to "${x.cc}",
                    "FEATURE SET" to (if (x.fid >= 0) "0x${hx(x.fid, 2)}" else "-"), "NETWORK" to (if (x.net >= 0) "${x.model} ${x.net}" else "not sent"),
                    "CALLSIGN" to x.callsign.ifEmpty { "no CW ID heard yet" }, "SITES" to x.sites.joinToString(", ") { it.label }, "UNITS" to "${x.units}",
                    "FIRST HEARD" to flClock(x.firstMs), "LAST HEARD" to flClock(x.lastMs))
            }
            return FleetDetail(x.proto, x.label, f, idens = if (x.proto == "P25") x.idens else null,
                lpcns = if (x.proto == "P25") emptyList() else x.lpcns.map { "LPCN ${it.lpcn}" to "${mhz(it.hz)} · ${it.votes} calls" })
        }
        else -> {
            val c = s.carriers.firstOrNull { "${it.key}" == key } ?: return null
            val f = listOf("FREQUENCY" to "${mhz(c.hz)} MHz", "CLASS" to c.cls.ifEmpty { "not classed yet" }, "ROLE" to c.role.ifEmpty { "-" }, "SYSTEM" to (if (c.sys.isNotEmpty()) sysLabel(c.sys) else "-"),
                "NAC" to (if (c.nac >= 0) hx(c.nac, 3) else "-"), "COLOR CODE" to (if (c.cc >= 0) "${c.cc}" else "-"),
                "LEVEL" to "%.1f dB over the floor (peak %.1f)".format(java.util.Locale.US, c.levelDb, c.peakDb), "ENVELOPE" to "%.2f (constant near 0, linear near 0.3)".format(java.util.Locale.US, c.envCv),
                "EYE" to "%.2f".format(java.util.Locale.US, c.eye), "FRAMES" to "${c.frames}", "BLOCKS" to "${c.blocks} · ${c.crcOk} passed CRC",
                "CW ID" to (if (c.callsign.isNotEmpty()) c.callsign + (if (c.callsignMs > 0) " · ${flClock(c.callsignMs)} · ${flAgoText(now - c.callsignMs)}" else "") else "-"),
                "LCN" to c.lcn.ifEmpty { "-" }, "ON AIR" to "${Math.round(c.onMs / 1000.0)} s", "FIRST HEARD" to flClock(c.firstMs), "LAST HEARD" to "${flClock(c.lastMs)} · ${flAgoText(now - c.lastMs)}")
            return FleetDetail(mhz(c.hz), "CARRIER", f)
        }
    }
}

/** The selected item's details over the stage: fields, then members, calls, history or the channel table. */
@Composable
private fun FleetDetailPanel(det: FleetDetail, s: FleetSnap, now: Long, accent: Color, prefs: TgPrefs, me: Pair<Double, Double>?, colorOf: (String) -> Color, acts: DispatchActs,
                             modifier: Modifier, onMap: (() -> Unit)?, onClose: () -> Unit) {
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
        if (det.tgKey != null) PrefButtons(det.tgKey, prefs, acts)
        SelectionContainer { FieldGrid(det.fields, labelWidth = 112f, minColumn = 320f) }
        if (det.chips.isNotEmpty()) FlChips(det.chipsLabel, det.chips.map { it.first to true }, accent) { i -> acts.pick(det.chips[i].second) }
        if (det.lpcns.isNotEmpty()) FlChips("LOGICAL CHANNELS", det.lpcns.map { "${it.first} ${it.second}" to true }, accent)
        if (det.idens != null) {
            Text("CHANNEL TABLE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
            IdenTable(det.idens)
        }
        if (det.calls.isNotEmpty()) {
            Text("CALLS", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
            for (c in det.calls) CallLine(c, now, me, if (c.sys.isNotEmpty()) colorOf(c.sys) else accent, acts)
        }
        if (det.hist.isNotEmpty() || det.grants.isNotEmpty()) Text(det.histLabel, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
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
