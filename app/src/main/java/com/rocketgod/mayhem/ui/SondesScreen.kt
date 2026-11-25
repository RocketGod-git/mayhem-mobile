package com.rocketgod.mayhem.ui

import com.rocketgod.mayhem.core.Units
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.lora.LoraHub
import com.rocketgod.mayhem.core.sonde.HubSite
import com.rocketgod.mayhem.core.sonde.SondeFront
import com.rocketgod.mayhem.core.sonde.SondeHub
import com.rocketgod.mayhem.core.sonde.SondePhase
import com.rocketgod.mayhem.core.sonde.SondeRow
import com.rocketgod.mayhem.core.sonde.SondeSnap
import kotlinx.coroutines.delay
import java.util.Locale
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Sondes: weather radiosondes, every type, the whole band. A card per sonde (height, climb, PTU, where it lands); MAP
 * draws each flight track, the burst and the predicted descent; LOG is one line per frame. A tap on a card or a pin
 * opens everything decoded from that sonde. The twin of the web app's renderSondes / refreshSondes.
 */
@Composable
fun SondesScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val snap by Apps.sondes.snap.collectAsState()
    val logSnap by Apps.sondesLog.snapshot.collectAsState()
    val fix by Geo.fix.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var full by remember { mutableStateOf(false) }
    var about by remember { mutableStateOf(false) }
    var focusKey by remember { mutableIntStateOf(0) }
    var bandId by remember { mutableStateOf(Apps.sondeBandId()) }
    var held by remember { mutableStateOf<List<SondeRow>?>(null) }
    var heldLog by remember { mutableStateOf<List<String>?>(null) }
    // where you are, for "from you" and the map (only when location is already allowed)
    LaunchedEffect(Unit) { Geo.start(ctx) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    val me = fix ?: Geo.lastKnownPos()
    // what SondeHub knows near you, refreshed every 30 s while Sondes is open
    val net by SondeHub.net.collectAsState()
    LaunchedEffect(Unit) { while (true) { (Geo.fix.value ?: Geo.lastKnownPos())?.let { SondeHub.poll(it.first, it.second) }; delay(1000) } }

    val live = snap?.sondes ?: emptyList()
    val sondes = held ?: live
    val withPos = sondes.filter { it.lat != null && it.lon != null }
    val picked = live.firstOrNull { it.serial == sel }
    // the cards and the map are only what our own radio decodes; SondeHub fills the launch sites panel
    val sites = nearSites(net.sites, me)
    // full screen has no LOG: it is the cards or the map
    if (full && view == 2) view = 0

    @Composable
    fun switcher(withLog: Boolean, modifier: Modifier) {
        val labels = listOf("SONDES ${sondes.size}", "MAP ${withPos.size}") + if (withLog) listOf("LOG") else emptyList()
        SegBar(labels, view, accent, modifier) { view = it }
    }

    @Composable
    fun stage(modifier: Modifier) {
        val grid = rememberLazyGridState()
        Box(modifier) {
            when (view) {
                0 -> SondeCards(sondes, sites, grid, accent, now, sel, me, full) { s -> sel = if (sel == s) "" else s }
                else -> {
                    val items = ArrayList<GeoItem>(); val paths = ArrayList<GeoPath>()
                    for (s in withPos) {
                        val mine = sel.isEmpty() || s.serial == sel
                        items.add(GeoItem(s.serial, s.lat!!, s.lon!!, s.serial + (s.alt?.let { " ${Units.fmtAltShort(it)}" } ?: ""), GeoItem.Kind.SONDE))
                        paths.add(GeoPath(s.track.map { it.lat to it.lon }, faint = !mine))
                        s.burst?.let { b -> items.add(GeoItem("burst:${s.serial}", b.lat, b.lon, "BURST", GeoItem.Kind.BURST)) }
                        val p = s.predict
                        if (p != null && mine) { paths.add(GeoPath(p.path, dashed = true)); items.add(GeoItem("land:${s.serial}", p.lat, p.lon, "${s.serial} lands", GeoItem.Kind.LANDING)) }
                    }
                    for ((x, _) in sites) items.add(GeoItem("site:${x.id}", x.lat, x.lon, x.name, GeoItem.Kind.STATION))
                    val pla = picked?.lat; val plo = picked?.lon
                    Box(Modifier.fillMaxSize()) {
                        GeoMapView(items, accent, Modifier.fillMaxSize().panel(), home = fix, selected = sel.ifEmpty { null }, layers = GeoLayers(paths = paths),
                            start = remember { mapStart(fix) }, focus = if (pla != null && plo != null) pla to plo else null, focusKey = focusKey) { id ->
                            val id2 = id.removePrefix("land:").removePrefix("burst:")
                            if (live.any { it.serial == id2 }) sel = id2
                        }
                        if (withPos.isEmpty() && sites.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                            modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
                    }
                }
            }
            if (picked != null) SondeDetail(picked, accent, me, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                onMap = if (picked.lat != null) ({ view = 1; focusKey++ }) else null,
                onCards = if (view != 0) ({ view = 0 }) else null) { sel = "" }
        }
    }

    // sondes transmit a frame a second, narrow and steady: a phone gives the waterfall's room to the cards
    val wf = waterfallOn(MayhemApp.SONDES, phoneDefault = false)
    PacketFrame(accent, Apps.sondesLog, tag = "BALLOONS", title = "WEATHER BALLOONS", tunable = false, emptyKey = "sondes", waterfall = wf,
        onWaterfall = { Apps.setWaterfall(MayhemApp.SONDES, !wf) },
        lamp = {
            if (live.isNotEmpty()) Lamp("${live.size} SONDE${if (live.size == 1) "" else "S"}", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("BAND")
                SegBar(SondeFront.BANDS.map { it.title }, SondeFront.BANDS.indexOfFirst { it.id == bandId }, accent, Modifier.weight(1f)) { i ->
                    val id = SondeFront.BANDS[i].id
                    if (id != bandId) { bandId = id; sel = ""; Apps.setSondeBand(id) }
                }
                if (live.isNotEmpty()) IconBox(InfoIcon, if (about) "Hide about" else "About Sondes") { about = !about }
            }
            SondeSummary(snap, bandId, accent)
            SondeChannels(snap, accent)
        },
        body = {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(8f), bottom = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
                verticalAlignment = Alignment.CenterVertically) {
                switcher(true, Modifier.weight(1f).fillMaxHeight())
                IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
                // an icon, not a word: on a phone the word squeezed the tabs
                IconBox(if (held != null) PlayIcon else PauseIcon, if (held != null) "Resume" else "Pause", Modifier.fillMaxHeight()) {
                    if (held == null) { held = live; heldLog = logSnap.lines } else { held = null; heldLog = null }
                }
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) {
                    Apps.sondesClear(); sel = ""
                    if (held != null) { held = emptyList(); heldLog = emptyList() }
                }
            }
            if (view == 2) LogList(heldLog ?: logSnap.lines, Modifier.fillMaxWidth().weight(1f), total = if (heldLog == null) logSnap.total else null,
                accent = accent, empty = "listening for sondes…")
            else stage(Modifier.fillMaxWidth().weight(1f))
            // the about panel is for an empty screen; once a balloon shows up it folds behind the info button
            if (live.isEmpty() || about) SondeAbout(accent)
        })
    if (full) FullscreenPanel(if (view == 0) "SONDES · ${sondes.size}" else "SONDES · MAP", accent, onClose = { full = false },
        actions = { switcher(false, Modifier.width(d.dp(260f))) }) {
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** What the hunt is doing: how many sondes, and the band watched or the window stepped to. */
@Composable
private fun SondeSummary(snap: SondeSnap?, bandId: String, accent: Color) {
    val d = rememberDims()
    val band = SondeFront.band(snap?.band ?: bandId)
    val win = snap?.window
    val hunt = when {
        snap == null -> "waiting for the radio"
        snap.wide -> "watching ${band.title}"
        else -> "stepping ${band.title} · window ${(win?.first ?: 0) + 1} of ${win?.second ?: 1}"
    }
    val n = snap?.sondes?.size ?: 0
    val ch = snap?.channels?.size ?: 0
    val text = if (n > 0) "$n SONDE${if (n == 1) "" else "S"} · $hunt"
        else hunt + if (ch > 0) " · trying $ch carrier${if (ch == 1) "" else "s"}" else ""
    Text(text, color = if (n > 0) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Each carrier with a channel: its frequency, lit with the type while it decodes, and its frame count. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SondeChannels(snap: SondeSnap?, accent: Color) {
    val chans = snap?.channels ?: return
    if (chans.isEmpty()) return
    val d = rememberDims()
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (c in chans) {
            val on = c.decoding.isNotEmpty()
            val shape = RoundedCornerShape(d.dp(6f))
            Text("%.3f".format(Locale.US, c.hz / 1e6) + (if (on) " · ${c.decoding}" else "") + (if (c.frames > 0) " · ${c.frames}" else ""),
                color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), maxLines = 1,
                modifier = Modifier.clip(shape).background(if (on) accent else Palette.panel).border(1.dp, if (on) accent else Palette.line, shape)
                    .padding(horizontal = d.dp(7f), vertical = d.dp(3f)))
        }
    }
}

/**
 * The cards, newest first, kept on the newest while the reader is at the top; scrolled down, "↑ N NEW" goes back. After
 * our own sondes come the ones others hear (SondeHub) and the launch sites near you, so the screen always says what is
 * up and where to listen.
 */
@Composable
private fun SondeCards(sondes: List<SondeRow>, sites: List<Pair<HubSite, Pair<Double, Double>>>, grid: LazyGridState, accent: Color,
                       now: Long, sel: String, me: Pair<Double, Double>?, full: Boolean, onPick: (String) -> Unit) {
    val d = rememberDims()
    if (sondes.isEmpty()) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val h = maxHeight
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                EmptyState("sondes", Modifier.fillMaxWidth().heightIn(min = h * (if (sites.isEmpty()) 0.9f else 0.55f)).panel(), accent)
                if (sites.isNotEmpty()) SondeSites(sites, accent, now)
            }
        }
        return
    }
    Box(Modifier.fillMaxSize()) {
        val follow = rememberFollowNewest(grid, sondes.firstOrNull()?.lastMs ?: 0L)
        LazyVerticalGrid(GridCells.Adaptive(d.dp(if (full) 300f else 250f)), Modifier.fillMaxSize(), state = grid,
            horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            items(sondes, key = { "${it.type}:${it.serial}" }) { s -> SondeCard(s, accent, now, sel == s.serial, me) { onPick(s.serial) } }
            if (sites.isNotEmpty()) item(key = "sites", span = { GridItemSpan(maxLineSpan) }) { SondeSites(sites, accent, now) }
        }
        NewestPill(follow, grid, sondes.count { it.lastMs > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
    }
}

/** The 6 launch sites nearest you within 600 km, each with its distance (km) and bearing from you. */
internal fun nearSites(sites: List<HubSite>, me: Pair<Double, Double>?): List<Pair<HubSite, Pair<Double, Double>>> {
    me ?: return emptyList()
    return sites.map { it to distBearing(me.first, me.second, it.lat, it.lon) }.filter { it.second.first < 600 }.sortedBy { it.second.first }.take(6)
}

/** A dashed rounded outline: the mark of a card our own radio hasn't heard. */
private fun Modifier.dashedBorder(color: Color, radius: Dp): Modifier = drawBehind {
    val w = 1.2.dp.toPx(); val r = radius.toPx()
    drawRoundRect(color, topLeft = Offset(w / 2, w / 2), size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w), cornerRadius = CornerRadius(r, r),
        style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))))
}

/** What Sondes hears and how, as a short labeled panel instead of a paragraph. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SondeAbout(accent: Color) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.7f)).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(11f), vertical = d.dp(9f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (t in listOf("RS41", "RS92", "DFM", "M10", "M20", "iMet-1", "iMet-4", "iMet-54", "LMS6", "Meisei", "MRZ", "MTS01")) {
                val cs = RoundedCornerShape(d.dp(6f))
                Text(t, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                    modifier = Modifier.clip(cs).background(accent.copy(alpha = 0.08f)).border(1.dp, accent.copy(alpha = 0.4f), cs).padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
            }
        }
        Text("all decoded on their own, no type to pick", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(4f)))
        for ((k, v) in listOf("WHEN" to "twice a day, about an hour before 00:00 and 12:00 UTC", "HACKRF" to "watches all of 400–406 MHz at once",
            "RTL-SDR" to "steps across the band and stays on a sonde once it decodes", "1680 MHz" to "the older US LMS6 band",
            "LANDING" to "bursts near 30 km, then drifts on the winds it measured going up")) {
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.5.sp, modifier = Modifier.width(d.dp(74f)).padding(top = d.dp(1f)))
                Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(1f))
            }
        }
    }
}

/** The launch sites near you, nearest first, each with its next launch where it lists a schedule. */
@Composable
private fun SondeSites(sites: List<Pair<HubSite, Pair<Double, Double>>>, accent: Color, now: Long) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Column(Modifier.fillMaxWidth().padding(top = d.dp(8f)).clip(shape)
        .background(Brush.radialGradient(listOf(accent.copy(alpha = 0.10f), Palette.panel), center = Offset.Zero, radius = 900f))
        .border(1.dp, Palette.line, shape).padding(horizontal = d.dp(10f), vertical = d.dp(8f))) {
        Text("LAUNCH SITES NEAR YOU", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp,
            modifier = Modifier.padding(bottom = d.dp(4f)))
        sites.forEachIndexed { i, (x, db) ->
            val next = SondeHub.nextLaunchMs(x, now)
            val up = next != null && next <= now
            val whenText = when {
                next == null -> if (SondeHub.irregular(x)) "launches irregularly" else "schedule not listed"
                up -> "up now · launched ${sondeMins((now - next) / 1000.0)} ago"
                else -> "next launch in ${sondeMins((next - now) / 1000.0)}"
            }
            if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line.copy(alpha = 0.6f)))
            Row(Modifier.fillMaxWidth().padding(vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                Column(Modifier.weight(1f)) {
                    Text(x.name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${Units.fmtDist(db.first)} ${compass(db.second)} · ${x.types.joinToString(", ").ifEmpty { "sonde" }}", color = Palette.muted,
                        fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Text(whenText, color = if (up) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = if (up) FontWeight.Bold else FontWeight.Normal,
                    fontSize = d.sp(10f), maxLines = 1)
            }
        }
    }
}

/** One sonde, live: serial, type and flight phase, its height and climb, where it is heading, PTU, and where it lands. */
@Composable
private fun SondeCard(s: SondeRow, accent: Color, now: Long, selected: Boolean, me: Pair<Double, Double>?, onClick: () -> Unit) {
    val d = rememberDims()
    val age = (now - s.lastMs) / 1000.0
    val flash = max(0.0, 1 - age / 0.9).toFloat()
    val live = age < 60
    val ago = when { age < 60 -> "${max(0, age.toInt())} s ago"; age < 3600 -> "${(age / 60).toInt()} min ago"; else -> "${(age / 3600).toInt()} h ago" }
    val climb = s.climb?.let { "${if (it >= 0) "▲" else "▼"} ${Units.fmtClimb(kotlin.math.abs(it), false)}" } ?: ""
    val ptu = listOfNotNull(s.tempC?.let { Units.fmtTemp(it) }, s.rh?.let { "${Math.round(it)}% RH" }, s.hPa?.let { Units.fmtPressure(it) },
        s.battV?.let { "%.1f V".format(Locale.US, it) }).joinToString(" · ")
    val p = s.predict
    val sla = s.lat; val slo = s.lon
    val landFrom = if (p != null) fromHere(me, p.lat, p.lon) else if (sla != null && slo != null) fromHere(me, sla, slo) else ""
    val land = when {
        p != null -> "lands in ${sondeMins(p.inS.toDouble())}" + if (landFrom.isNotEmpty()) " · $landFrom from you" else ""
        s.phase == SondePhase.LANDED -> "down" + if (landFrom.isNotEmpty()) " · $landFrom from you" else ""
        else -> ""
    }
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.8f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f + 0.14f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, accent.copy(alpha = if (selected) 1f else 0.22f + 0.7f * flash), shape)
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(s.serial, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (s.serial.length > 8) 16f else 20f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(s.model ?: s.type, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text(s.phase.label + if (s.burst != null) " · BURST" else "", color = if (s.lat != null) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.size(d.dp(9f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(ago, color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(s.alt?.let { Units.altNumber(it) } ?: "—", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(Units.altWord(), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.padding(bottom = d.dp(4f)))
            Text(climb, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
        }
        val vh = s.vH
        Text("%.3f MHz · %d %s".format(Locale.US, s.hz / 1e6, s.frames, if (s.frames == 1) "frame" else "frames") +
            (if (vh != null) " · ${Units.fmtSpeedMs(vh)} ${s.heading?.let { compass(it) } ?: ""}" else ""),
            color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (ptu.isNotEmpty()) Text(ptu, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (land.isNotEmpty()) Text(land, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** Everything decoded from one sonde, field by field, with MAP when it has a position and CARDS from the map. */
@Composable
private fun SondeDetail(s: SondeRow, accent: Color, me: Pair<Double, Double>?, modifier: Modifier, onMap: (() -> Unit)?, onCards: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.paper).background(Palette.panel.copy(alpha = 0.95f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(s.serial, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f), maxLines = 1)
            Text("${s.model ?: s.type} · ${s.phase.label}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
            if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer { FieldGrid(sondeFields(s, me), labelWidth = 120f, minColumn = 300f) }
    }
}

/** The detail card's rows, in the web app's order; a field with nothing to say is left out. */
internal fun sondeFields(s: SondeRow, me: Pair<Double, Double>?): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    fun f(name: String, value: String?) { if (!value.isNullOrEmpty()) out.add(name to value) }
    val la = s.lat; val lo = s.lon
    val fix = la != null && lo != null
    val ts = s.timeS
    val t = if (ts != null) "%02d:%02d:%02d UTC".format(Locale.US, (ts / 3600).toLong() % 24, (ts / 60).toLong() % 60, (ts % 60).toLong()) else null
    f("TYPE", s.model ?: s.type); f("FREQUENCY", "%.4f MHz".format(Locale.US, s.hz / 1e6)); f("SIGNAL", "+${Math.round(s.level)} dB")
    f("FIRST HEARD", LoraHub.clock(s.firstMs)); f("LAST HEARD", LoraHub.clock(s.lastMs)); f("FRAMES", "${s.frames}"); f("FRAME NUMBER", s.frame?.toString())
    f("GPS TIME", t?.let { if (s.date != null) "${s.date} $it" else it }); f("FLIGHT", s.phase.label)
    f("POSITION", if (fix) "%.5f, %.5f".format(Locale.US, la, lo) else null); f("FROM YOU", if (fix) fromHere(me, la!!, lo!!) else null)
    f("ALTITUDE", s.alt?.let { Units.fmtAlt(it) }); f("HIGHEST", s.maxAlt?.let { Units.fmtAlt(it) })
    f("CLIMB", s.climb?.let { Units.fmtClimb(it) })
    f("GROUND SPEED", s.vH?.let { Units.fmtSpeedMs(it) })
    f("HEADING", s.heading?.let { "${Math.round(it)}° ${compass(it)}" }); f("SATELLITES", s.sats?.toString())
    f("TEMPERATURE", s.tempC?.let { Units.fmtTemp(it) }); f("HUMIDITY", s.rh?.let { "%.0f %%".format(Locale.US, it) })
    f("PRESSURE", s.hPa?.let { Units.fmtPressure(it) })
    f("BATTERY", s.battV?.let { "%.1f V".format(Locale.US, it) }); f("BURST TIMER", s.killS?.let { sondeMins(it.toDouble()) })
    f("BURST", s.burst?.let { "${Units.fmtAlt(it.alt)} at ${LoraHub.clock(it.ms)}" })
    val p = s.predict
    f("PREDICTED LANDING", p?.let { "%.4f, %.4f in %s".format(Locale.US, it.lat, it.lon, sondeMins(it.inS.toDouble())) })
    f("LANDING FROM YOU", p?.let { fromHere(me, it.lat, it.lon) })
    f("ASSUMED BURST", if (p != null && s.phase == SondePhase.ASCENT) Units.fmtAlt(p.burstAlt.toDouble()) else null)
    f("ERRORS FIXED", if (s.fixed > 0) "${s.fixed}" else null)
    for (x in s.fields) out.add(x.name to Units.fmtText(x.value))
    return out
}

private val COMPASS = listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")
internal fun compass(deg: Double): String = COMPASS[(Math.round(deg / 45) % 8).toInt()]

internal fun sondeMins(s: Double): String = when {
    s < 90 -> "${max(0L, Math.round(s))} s"
    s < 5400 -> "${Math.round(s / 60)} min"
    else -> "%.1f h".format(Locale.US, s / 3600)
}

/** Great-circle distance (km) and initial bearing (degrees) from a to b. */
internal fun distBearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Pair<Double, Double> {
    val r = PI / 180; val dLat = (bLat - aLat) * r; val dLon = (bLon - aLon) * r
    val h = sin(dLat / 2) * sin(dLat / 2) + cos(aLat * r) * cos(bLat * r) * sin(dLon / 2) * sin(dLon / 2)
    val km = 12742 * asin(min(1.0, sqrt(h)))
    val y = sin(dLon) * cos(bLat * r); val x = cos(aLat * r) * sin(bLat * r) - sin(aLat * r) * cos(bLat * r) * cos(dLon)
    return km to (atan2(y, x) / r + 360) % 360
}

/** "12 km NE" or "7.5 mi NE" from where you are, in the units picked in Settings, or "" without a position. */
internal fun fromHere(me: Pair<Double, Double>?, lat: Double, lon: Double): String {
    me ?: return ""
    val (km, brg) = distBearing(me.first, me.second, lat, lon)
    return "${Units.fmtDist(km)} ${compass(brg)}"
}
