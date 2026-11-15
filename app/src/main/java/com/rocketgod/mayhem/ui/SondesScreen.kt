package com.rocketgod.mayhem.ui

import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.Canvas
import com.rocketgod.mayhem.core.sonde.HubSample
import com.rocketgod.mayhem.core.sonde.HubFlight
import com.rocketgod.mayhem.core.sonde.HubPredict
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.buildAnnotatedString
import android.content.Intent
import android.net.Uri
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
import com.rocketgod.mayhem.core.sonde.HubDetail
import com.rocketgod.mayhem.core.sonde.HubSite
import com.rocketgod.mayhem.core.sonde.HubSonde
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
    val details by SondeHub.details.collectAsState()
    LaunchedEffect(Unit) { while (true) { (Geo.fix.value ?: Geo.lastKnownPos())?.let { SondeHub.poll(it.first, it.second) }; delay(1000) } }

    val live = snap?.sondes ?: emptyList()
    val sondes = held ?: live
    val withPos = sondes.filter { it.lat != null && it.lon != null }
    val picked = live.firstOrNull { it.serial == sel }
    val pickedNet = if (picked == null) net.air.firstOrNull { it.serial == sel } else null
    // a tapped SondeHub balloon fetches its whole flight and landing prediction, then every minute while it stays picked
    LaunchedEffect(pickedNet?.serial) { val s = pickedNet?.serial ?: return@LaunchedEffect; while (true) { SondeHub.detail(s); delay(5_000) } }
    // ours first; then what others are hearing that we aren't (yet); then the launch sites
    val air = net.air.filter { h -> sondes.none { it.serial == h.serial } }
    val airOnMap = net.air.filter { h -> withPos.none { it.serial == h.serial } }
    val sites = nearSites(net.sites, me)
    // full screen has no LOG: it is the cards or the map
    if (full && view == 2) view = 0

    @Composable
    fun switcher(withLog: Boolean, modifier: Modifier) {
        val labels = listOf("SONDES ${sondes.size + air.size}", "MAP ${withPos.size + airOnMap.size}") + if (withLog) listOf("LOG") else emptyList()
        SegBar(labels, view, accent, modifier) { view = it }
    }

    @Composable
    fun stage(modifier: Modifier) {
        val grid = rememberLazyGridState()
        Box(modifier) {
            when (view) {
                0 -> SondeCards(sondes, air, sites, grid, accent, now, sel, me, full,
                    hub = { s -> (net.preds[s] ?: details[s]?.predict) to (details[s]?.flight?.maxAlt ?: 0.0) }) { s -> sel = if (sel == s) "" else s }
                else -> {
                    val items = ArrayList<GeoItem>(); val paths = ArrayList<GeoPath>()
                    for (s in withPos) {
                        val mine = sel.isEmpty() || s.serial == sel
                        items.add(GeoItem(s.serial, s.lat!!, s.lon!!, s.serial + (s.alt?.let { " %.1f km".format(Locale.US, it / 1000) } ?: ""), GeoItem.Kind.SONDE))
                        paths.add(GeoPath(s.track.map { it.lat to it.lon }, faint = !mine))
                        s.burst?.let { b -> items.add(GeoItem("burst:${s.serial}", b.lat, b.lon, "BURST", GeoItem.Kind.BURST)) }
                        val p = s.predict
                        if (p != null && mine) { paths.add(GeoPath(p.path, dashed = true)); items.add(GeoItem("land:${s.serial}", p.lat, p.lon, "${s.serial} lands", GeoItem.Kind.LANDING)) }
                    }
                    for (h in airOnMap) {
                        items.add(GeoItem(h.serial, h.lat, h.lon,
                            h.serial + " %.1f km".format(Locale.US, h.alt / 1000) + (h.mhz?.let { " · %.3f".format(Locale.US, it) } ?: ""), GeoItem.Kind.SONDE))
                        val dx = details[h.serial]
                        dx?.flight?.track?.takeIf { it.size > 1 }?.let { paths.add(GeoPath(it + (h.lat to h.lon), faint = sel.isNotEmpty() && sel != h.serial)) }
                        val pr = dx?.predict
                        if (pr != null && sel == h.serial) {
                            paths.add(GeoPath(listOf(h.lat to h.lon) + pr.path, dashed = true))
                            items.add(GeoItem("land:${h.serial}", pr.lat, pr.lon, "${h.serial} ${if (pr.landed) "landed" else "lands"}", GeoItem.Kind.LANDING))
                        }
                    }
                    for ((x, _) in sites) items.add(GeoItem("site:${x.id}", x.lat, x.lon, x.name, GeoItem.Kind.STATION))
                    val pla = picked?.lat; val plo = picked?.lon
                    Box(Modifier.fillMaxSize()) {
                        GeoMapView(items, accent, Modifier.fillMaxSize().panel(), home = fix, selected = sel.ifEmpty { null }, layers = GeoLayers(paths = paths),
                            start = remember { mapStart(fix) }, focus = if (pla != null && plo != null) pla to plo else pickedNet?.let { it.lat to it.lon }, focusKey = focusKey) { id ->
                            val id2 = id.removePrefix("land:").removePrefix("burst:")
                            if (live.any { it.serial == id2 } || net.air.any { it.serial == id2 }) sel = id2
                        }
                        if (withPos.isEmpty() && airOnMap.isEmpty() && sites.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                            modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
                    }
                }
            }
            if (picked != null) SondeDetail(picked, accent, me, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                onMap = if (picked.lat != null) ({ view = 1; focusKey++ }) else null,
                onCards = if (view != 0) ({ view = 0 }) else null) { sel = "" }
            else if (pickedNet != null) SondeNetDetail(pickedNet, details[pickedNet.serial], net.preds[pickedNet.serial], net.sites, accent, me, now, snap?.wide == true, view == 1, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)),
                onMap = { view = 1; focusKey++ }, onCards = if (view != 0) ({ view = 0 }) else null,
                onTracker = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://sondehub.org/" + Uri.encode(pickedNet.serial)))) } }) { sel = "" }
        }
    }

    // sondes transmit a frame a second, narrow and steady: a phone gives the waterfall's room to the cards
    val wf = waterfallOn(MayhemApp.SONDES, phoneDefault = false)
    PacketFrame(accent, Apps.sondesLog, tag = "SONDES", title = "WEATHER BALLOONS", tunable = false, emptyKey = "sondes", waterfall = wf,
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
                if (live.isNotEmpty() || net.air.isNotEmpty()) IconBox(InfoIcon, if (about) "Hide about" else "About Sondes") { about = !about }
            }
            SondeSummary(snap, bandId, accent)
            SondeChannels(snap, accent)
        },
        body = {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(8f), bottom = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
                verticalAlignment = Alignment.CenterVertically) {
                switcher(true, Modifier.weight(1f).fillMaxHeight())
                WaterfallBox(wf, accent, Modifier.fillMaxHeight()) { Apps.setWaterfall(MayhemApp.SONDES, !wf) }
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
            if ((live.isEmpty() && net.air.isEmpty()) || about) SondeAbout(accent)
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
private fun SondeCards(sondes: List<SondeRow>, air: List<HubSonde>, sites: List<Pair<HubSite, Pair<Double, Double>>>, grid: LazyGridState, accent: Color,
                       now: Long, sel: String, me: Pair<Double, Double>?, full: Boolean, hub: (String) -> Pair<HubPredict?, Double>, onPick: (String) -> Unit) {
    val d = rememberDims()
    if (sondes.isEmpty() && air.isEmpty()) {
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
            items(air, key = { "hub:${it.serial}" }) { h -> val (pr, peak) = hub(h.serial); SondeAirCard(h, pr, peak, accent, now, me, sel == h.serial) { onPick(h.serial) } }
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

/** Where a SondeHub balloon is in its flight; a report over 10 minutes old with no landing means no station hears it now. */
internal fun hubPhase(h: HubSonde, pr: HubPredict?, now: Long): Pair<String, String> {
    if (pr?.landed == true) return "down" to "LANDED"
    if (now - h.ms > 600_000) return "lost" to "SIGNAL LOST"
    val c = h.climb ?: 0.0
    return when {
        c > 1 -> "up" to "▲ CLIMBING %.1f m/s".format(Locale.US, c)
        c < -1 -> "fall" to "▼ FALLING %.1f m/s".format(Locale.US, -c)
        else -> "float" to "FLOATING"
    }
}

/** A balloon someone else is hearing and our radio isn't (yet): what it is, where it is going, and where to listen. */
@Composable
private fun SondeAirCard(h: HubSonde, pr: HubPredict?, peak: Double, accent: Color, now: Long, me: Pair<Double, Double>?, selected: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val age = (now - h.ms) / 1000.0
    val live = age < 120
    val ago = when { age < 60 -> "${max(0, age.toInt())} s ago"; age < 3600 -> "${(age / 60).toInt()} min ago"; else -> "${(age / 3600).toInt()} h ago" }
    val (phKey, phText) = hubPhase(h, pr, now)
    val phColor = when (phKey) { "up" -> Palette.ok; "fall" -> Palette.accent2; "float" -> accent; else -> Palette.muted }
    val from = fromHere(me, h.lat, h.lon)
    val land = pr?.let { fromHere(me, it.lat, it.lon) } ?: ""
    val coming = pr != null && !pr.landed && pr.ms > now
    val fate = when {
        pr == null -> if (from.isNotEmpty()) "$from from you" else ""
        pr.landed -> "landed" + if (land.isNotEmpty()) " $land from you" else ""
        coming -> "lands in ${sondeMins((pr.ms - now) / 1000.0)}" + if (land.isNotEmpty()) " · $land from you" else ""
        else -> "down by now" + if (land.isNotEmpty()) " · $land from you" else ""
    }
    val drift = h.speedMs?.let { v -> "drifting %.0f km/h".format(Locale.US, v * 3.6) + (h.heading?.let { " ${compass(it)}" } ?: "") } ?: ""
    val top = maxOf(35_000.0, peak, h.alt)
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.85f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.06f), Palette.panel)))
        .then(if (selected) Modifier.border(2.5.dp, accent, shape) else Modifier.dashedBorder(accent.copy(alpha = 0.55f), d.dp(14f)))
        .clickable { onClick() }.padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(h.serial, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(if (h.serial.length > 8) 16f else 20f), maxLines = 1)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
                Text(h.type, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text("VIA SONDEHUB", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.size(d.dp(9f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(ago, color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        }
        val pill = RoundedCornerShape(50)
        Text(phText, color = phColor, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.5.sp, maxLines = 1,
            modifier = Modifier.clip(pill).background(phColor.copy(alpha = if (phKey == "up" || phKey == "fall") 0.12f else 0f)).border(1.dp, phColor, pill)
                .padding(horizontal = d.dp(8f), vertical = d.dp(2f)))
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("%,d".format(Locale.US, Math.round(h.alt)), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("METERS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.padding(bottom = d.dp(4f)))
            Text(drift, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, textAlign = TextAlign.End,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
        }
        // altitude against a 35 km burst, with the peak marked once the flight is known
        val accent2 = Palette.accent2; val okC = Palette.ok; val track = Palette.line
        Canvas(Modifier.fillMaxWidth().height(d.dp(9f))) {
            val y = size.height / 2; val hgt = 5.dp.toPx()
            drawRoundRect(track.copy(alpha = 0.7f), topLeft = Offset(0f, y - hgt / 2), size = androidx.compose.ui.geometry.Size(size.width, hgt), cornerRadius = CornerRadius(hgt / 2))
            val w = (size.width * (h.alt / top)).toFloat().coerceAtLeast(hgt)
            drawRoundRect(Brush.horizontalGradient(listOf(accent, okC)), topLeft = Offset(0f, y - hgt / 2), size = androidx.compose.ui.geometry.Size(w, hgt), cornerRadius = CornerRadius(hgt / 2))
            if (peak > h.alt + 50) { val x = (size.width * (peak / top)).toFloat(); drawRect(accent2, topLeft = Offset(x - 1.dp.toPx(), 0f), size = androidx.compose.ui.geometry.Size(2.dp.toPx(), size.height)) }
        }
        if (fate.isNotEmpty()) Text(fate, color = if (coming) Palette.accent2 else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        val ptu = listOfNotNull(h.tempC?.let { "%.1f °C".format(Locale.US, it) }, h.rh?.let { "${Math.round(it)}% RH" }, h.battV?.let { "%.1f V".format(Locale.US, it) }).joinToString(" · ")
        if (ptu.isNotEmpty()) Text(ptu, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text((h.mhz?.let { "%.3f MHz".format(Locale.US, it) } ?: "frequency not reported") + " · tap for the whole flight", color = Palette.muted, fontFamily = Mono,
            fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Altitude across the flight, with the burst marked and the latest point lit. */
@Composable
private fun HubAltChart(fl: HubFlight, h: HubSonde, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val pts = (fl.profile + HubSample(h.ms, h.alt, h.tempC)).filter { it.ms >= (fl.profile.firstOrNull()?.ms ?: h.ms) }
    if (pts.size < 2) return
    val t0 = pts.first().ms; val t1 = pts.last().ms
    val top = maxOf(1000.0, pts.maxOf { it.alt }) * 1.08
    val accent2 = Palette.accent2; val okC = Palette.ok
    HubChartFrame("ALTITUDE", LoraHub.clock(t0).take(5), "peak %.1f km".format(Locale.US, fl.maxAlt / 1000), LoraHub.clock(t1).take(5), accent, modifier) {
        Canvas(Modifier.fillMaxWidth().height(d.dp(64f))) {
            fun x(ms: Long) = (size.width * (ms - t0) / maxOf(1L, t1 - t0).toFloat())
            fun y(a: Double) = (size.height * (1 - a / top)).toFloat()
            val path = androidx.compose.ui.graphics.Path(); val fill = androidx.compose.ui.graphics.Path()
            fill.moveTo(x(t0), size.height)
            pts.forEachIndexed { i, p -> if (i == 0) path.moveTo(x(p.ms), y(p.alt)) else path.lineTo(x(p.ms), y(p.alt)); fill.lineTo(x(p.ms), y(p.alt)) }
            fill.lineTo(x(t1), size.height); fill.close()
            drawPath(fill, accent.copy(alpha = 0.14f))
            drawPath(path, accent, style = Stroke(width = 1.6.dp.toPx()))
            if (fl.maxAlt > 0) drawCircle(accent2, 3.dp.toPx(), Offset(x(fl.maxAltMs), y(fl.maxAlt)))
            drawCircle(okC, 3.5.dp.toPx(), Offset(x(pts.last().ms), y(pts.last().alt)))
        }
    }
}

/** Temperature by altitude on the way up: the atmosphere the sonde measured. */
@Composable
private fun HubTempChart(fl: HubFlight, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    // the climb only: on the way down the sensor trails the parachute and reads warm
    val upTo = fl.profile.indexOfFirst { it.ms >= fl.maxAltMs }
    val pts = (if (upTo < 0) fl.profile else fl.profile.take(upTo + 1)).filter { it.temp != null }
    if (pts.size < 5) return
    val lo = pts.minOf { it.temp!! }; val hi = pts.maxOf { it.temp!! }; val top = pts.maxOf { it.alt } * 1.05
    val accent2 = Palette.accent2; val muted = Palette.muted
    HubChartFrame("TEMPERATURE BY ALTITUDE", "%.0f °C".format(Locale.US, lo), "0–%.0f km".format(Locale.US, top / 1050), "%.0f °C".format(Locale.US, hi), accent, modifier) {
        Canvas(Modifier.fillMaxWidth().height(d.dp(64f))) {
            fun x(t: Double) = (size.width * (t - lo) / maxOf(1.0, hi - lo)).toFloat()
            fun y(a: Double) = (size.height * (1 - a / top)).toFloat()
            if (lo < 0 && hi > 0) drawLine(muted, Offset(x(0.0), 0f), Offset(x(0.0), size.height), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
            val path = androidx.compose.ui.graphics.Path()
            pts.forEachIndexed { i, p -> if (i == 0) path.moveTo(x(p.temp!!), y(p.alt)) else path.lineTo(x(p.temp!!), y(p.alt)) }
            drawPath(path, accent2, style = Stroke(width = 1.6.dp.toPx()))
        }
    }
}

@Composable
private fun HubChartFrame(title: String, left: String, mid: String, right: String, accent: Color, modifier: Modifier, chart: @Composable () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(modifier.clip(shape).background(Palette.paper.copy(alpha = 0.55f)).border(1.dp, accent.copy(alpha = 0.22f), shape).padding(horizontal = d.dp(8f), vertical = d.dp(6f))) {
        Text(title, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
        chart()
        Row(Modifier.fillMaxWidth()) {
            Text(left, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
            Text(mid, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Text(right, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
    }
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

/** A headline number on the SondeHub detail: label, value with its unit, and a quieter note under it. */
internal data class HubTile(val label: String, val value: String, val unit: String = "", val note: String = "")
/** A labeled row: the value, and a quieter note after it. */
internal data class HubRow(val name: String, val value: String, val note: String = "")
/** The SondeHub detail laid out: phase, headline tiles, titled sections, and the stations hearing it. */
internal data class HubDetailModel(val phase: String, val tiles: List<HubTile>, val sections: List<Pair<String, List<HubRow>>>, val stations: List<String>, val more: Int)

/** What the SondeHub detail says about [h], in the web app's order (sondeNetDetail in main.ts). */
internal fun hubDetailModel(h: HubSonde, dx: HubDetail?, shared: HubPredict?, sites: List<HubSite>, me: Pair<Double, Double>?, now: Long): HubDetailModel {
    val fl = dx?.flight; val pr = dx?.predict ?: shared
    val phKey = hubPhase(h, pr, now).first
    val phase = when (phKey) { "down" -> "LANDED"; "fall" -> "FALLING"; "up" -> "CLIMBING"; "lost" -> "SIGNAL LOST"; else -> "FLOATING" }
    val f = h.fields.toMap()
    fun m(v: Double) = "%,d".format(Locale.US, Math.round(v))
    val age = (now - h.ms) / 1000.0
    val fromNow = fromHere(me, h.lat, h.lon)
    val tiles = ArrayList<HubTile>()
    tiles.add(HubTile("ALTITUDE", m(h.alt), "m", if (fl != null && fl.maxAlt > h.alt + 50) "peak ${m(fl.maxAlt)} m" else ""))
    h.climb?.let { c -> tiles.add(HubTile((if (phKey == "lost") "WAS " else "") + if (c >= 0) "CLIMBING" else "FALLING", "%.1f".format(Locale.US, Math.abs(c)), "m/s",
        h.speedMs?.let { v -> "drifting %.0f km/h".format(Locale.US, v * 3.6) + (h.heading?.let { " ${compass(it)}" } ?: "") } ?: "")) }
    h.tempC?.let { t -> tiles.add(HubTile("AIR", "%.1f".format(Locale.US, t), "°C", h.rh?.let { "${Math.round(it)}% humidity" } ?: "")) }
    if (pr != null) {
        val land = fromHere(me, pr.lat, pr.lon)
        val down = pr.landed || pr.ms <= now
        tiles.add(HubTile(if (pr.landed) "LANDED" else "LANDS", if (down) land.ifEmpty { "down" } else "in ${sondeMins((pr.ms - now) / 1000.0)}", "",
            if (down) (if (land.isNotEmpty()) "from you" else "") else if (land.isNotEmpty()) "$land from you" else ""))
    } else tiles.add(HubTile("FROM YOU", fromNow.ifEmpty { "—" }))
    val flight = ArrayList<HubRow>()
    fun add(list: ArrayList<HubRow>, name: String, value: String?, note: String = "") { if (!value.isNullOrEmpty()) list.add(HubRow(name, value, note)) }
    val l = fl?.launch
    val site = l?.let { SondeHub.launchSite(sites, it.lat, it.lon) }
    add(flight, "Launched from", site?.name ?: l?.let { "%.4f, %.4f".format(Locale.US, it.lat, it.lon) }, if (site != null && site.id.isNotEmpty()) "station ${site.id}" else "")
    if (l != null) add(flight, "Went up", LoraHub.clock(l.ms), "${SondeHub.dur((h.ms - l.ms) / 1000.0)} in flight")
    if (fl != null && fl.maxAlt > 0) add(flight, if (fl.maxAlt > h.alt + 500) "Burst" else "Highest so far", "${m(fl.maxAlt)} m", "at ${LoraHub.clock(fl.maxAltMs)}")
    if (pr != null) {
        add(flight, if (pr.landed) "Landed at" else "Predicted landing", "%.4f, %.4f".format(Locale.US, pr.lat, pr.lon),
            fromHere(me, pr.lat, pr.lon) + if (!pr.landed && pr.ms > now) " · in ${sondeMins((pr.ms - now) / 1000.0)}" else "")
        if (!pr.descending && pr.burstAlt != null) add(flight, "Assumed burst", "${m(pr.burstAlt)} m")
        if (pr.ascent != null && pr.descent != null) add(flight, "Rates used", "up %.1f · down %.1f m/s".format(Locale.US, pr.ascent, pr.descent))
    }
    add(flight, "Position now", "%.5f, %.5f".format(Locale.US, h.lat, h.lon), if (fromNow.isNotEmpty()) "$fromNow from you" else "")
    val weather = ArrayList<HubRow>()
    add(weather, "Temperature", f["TEMPERATURE"]); add(weather, "Humidity", f["HUMIDITY"]); add(weather, "Pressure", f["PRESSURE"])
    val sonde = ArrayList<HubRow>()
    add(sonde, "Model", (f["MAKER"]?.let { "$it " } ?: "") + h.type)
    add(sonde, "Battery", f["BATTERY"])
    add(sonde, "GPS", f["SATELLITES"]?.let { "$it satellites" }, f["POSITION FROM"]?.takeIf { it != "GPS" }?.let { "position from $it" } ?: "")
    add(sonde, "Burst timer", f["BURST TIMER"], "left until it cuts the balloon free")
    add(sonde, "Mainboard", f["MAINBOARD"]); add(sonde, "DFM code", f["DFM CODE"]); add(sonde, "Frame", f["FRAME NUMBER"])
    val rx = ArrayList<HubRow>()
    val mhz = h.mhz?.let { "%.3f MHz".format(Locale.US, it) }
    add(rx, "Frequency", mhz, f["TX FREQUENCY"]?.takeIf { it != mhz }?.let { "set to $it" } ?: "")
    add(rx, "Last report", if (age < 60) "${max(0, age.toInt())} s ago" else "${sondeMins(age)} ago")
    add(rx, "Heard by", f["HEARD BY"], listOfNotNull(f["SIGNAL"], f["THEIR ANTENNA"]).joinToString(" · "))
    add(rx, "Their station", f["THEIR STATION"], f["THEIR SOFTWARE"] ?: "")
    if (fl != null) add(rx, "Frames online", "%,d".format(Locale.US, fl.frames),
        if (fl.stations.isNotEmpty()) "from ${fl.stations.size} station${if (fl.stations.size == 1) "" else "s"}" else "")
    val secs = listOf("FLIGHT" to flight, "WEATHER" to weather, "SONDE" to sonde, "RECEPTION" to rx).filter { it.second.isNotEmpty() }
    val st = fl?.stations ?: emptyList()
    return HubDetailModel(phase, tiles, secs, st.take(12).map { it.first }, max(0, st.size - 12))
}

/** The detail for a balloon only SondeHub reports: headline tiles, then the story in short labeled sections. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SondeNetDetail(h: HubSonde, dx: HubDetail?, shared: HubPredict?, sites: List<HubSite>, accent: Color, me: Pair<Double, Double>?, now: Long, wide: Boolean, onMapView: Boolean, modifier: Modifier,
                           onMap: () -> Unit, onCards: (() -> Unit)?, onTracker: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    val md = hubDetailModel(h, dx, shared, sites, me, now)
    // on the map the detail keeps the lower half, so the flight it describes stays in view
    Column((if (onMapView) modifier.fillMaxHeight(0.5f) else modifier).fillMaxWidth().clip(shape).background(Palette.paper).background(Palette.panel.copy(alpha = 0.95f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            // one line when it fits; on a phone the buttons drop under the name instead of cutting it off
            val narrow = maxWidth < 460.dp
            @Composable fun title(m: Modifier) = Row(m, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(h.serial, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(20f), maxLines = 1)
                Text("${h.type} · ${md.phase}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                    letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            @Composable fun buttons() {
                ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
                if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
                ToggleBox("TRACKER", false, accent, Modifier.fillMaxHeight()) { onTracker() }
                ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
            }
            if (narrow) Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                title(Modifier.fillMaxWidth())
                Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { buttons() }
            } else Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                title(Modifier.weight(1f)); buttons()
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val perRow = if (maxWidth < 420.dp) 2 else 4
            val gap = d.dp(6f)
            Column(verticalArrangement = Arrangement.spacedBy(gap)) {
                for (line in md.tiles.chunked(perRow)) Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (t in line) HubTileView(t, accent, Modifier.weight(1f))
                    repeat(perRow - line.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        dx?.flight?.let { fl ->
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val two = maxWidth >= 420.dp
                val gap = d.dp(6f)
                if (two) Row(horizontalArrangement = Arrangement.spacedBy(gap)) { HubAltChart(fl, h, accent, Modifier.weight(1f)); HubTempChart(fl, accent, Modifier.weight(1f)) }
                else Column(verticalArrangement = Arrangement.spacedBy(gap)) { HubAltChart(fl, h, accent, Modifier.fillMaxWidth()); HubTempChart(fl, accent, Modifier.fillMaxWidth()) }
            }
        }
        if (dx?.flight == null && dx?.busy == true) Text("loading the flight from SondeHub…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        else if (dx?.flight == null && !dx?.err.isNullOrEmpty()) Text(dx!!.err, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val cols = if (maxWidth >= 560.dp) 2 else 1
            val gap = d.dp(14f)
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    for (pair in md.sections.chunked(cols)) Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                        for ((title, rows) in pair) Column(Modifier.weight(1f)) {
                            Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
                            Box(Modifier.fillMaxWidth().padding(top = d.dp(3f), bottom = d.dp(3f)).height(1.dp).background(accent.copy(alpha = 0.3f)))
                            for (r in rows) HubRowView(r)
                            if (title == "RECEPTION" && md.stations.isNotEmpty()) FlowRow(Modifier.padding(top = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f)),
                                verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                                for (c in md.stations + if (md.more > 0) listOf("+${md.more}") else emptyList()) {
                                    val cs = RoundedCornerShape(d.dp(6f))
                                    Text(c, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1,
                                        modifier = Modifier.clip(cs).background(Palette.panel).border(1.dp, Palette.line, cs).padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
                                }
                            }
                        }
                        if (pair.size < cols) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
        Text("Reported online by SondeHub; your radio has not decoded it yet." + if (wide) "" else " Your radio steps across the band and stays on a sonde once it decodes.",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

@Composable
private fun HubTileView(t: HubTile, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(modifier.clip(shape).background(accent.copy(alpha = 0.09f)).border(1.dp, accent.copy(alpha = 0.28f), shape).padding(horizontal = d.dp(9f), vertical = d.dp(7f))) {
        Text(t.label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
        Text(buildAnnotatedString {
            append(t.value)
            if (t.unit.isNotEmpty()) withStyle(SpanStyle(color = Palette.muted, fontSize = d.sp(10f), fontWeight = FontWeight.Normal)) { append(" " + t.unit) }
        }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(19f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (t.note.isNotEmpty()) Text(t.note, color = accent, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun HubRowView(r: HubRow) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().padding(vertical = d.dp(2f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Text(r.name, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(104f)))
        Text(buildAnnotatedString {
            append(r.value)
            if (r.note.isNotEmpty()) withStyle(SpanStyle(color = Palette.muted, fontSize = d.sp(10f))) { append("  " + r.note) }
        }, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(1f))
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
                    Text("${Math.round(db.first)} km ${compass(db.second)} · ${x.types.joinToString(", ").ifEmpty { "sonde" }}", color = Palette.muted,
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
    val climb = s.climb?.let { "${if (it >= 0) "▲" else "▼"} ${"%.1f".format(Locale.US, kotlin.math.abs(it))} m/s" } ?: ""
    val ptu = listOfNotNull(s.tempC?.let { "%.1f °C".format(Locale.US, it) }, s.rh?.let { "${Math.round(it)}% RH" }, s.hPa?.let { "%.1f hPa".format(Locale.US, it) },
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
            Text(s.alt?.let { "%,d".format(Locale.US, Math.round(it)) } ?: "—", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text("METERS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.padding(bottom = d.dp(4f)))
            Text(climb, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
                modifier = Modifier.weight(1f).padding(bottom = d.dp(3f)))
        }
        val vh = s.vH
        Text("%.3f MHz · %d %s".format(Locale.US, s.hz / 1e6, s.frames, if (s.frames == 1) "frame" else "frames") +
            (if (vh != null) " · %.0f km/h %s".format(Locale.US, vh * 3.6, s.heading?.let { compass(it) } ?: "") else ""),
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
    f("ALTITUDE", s.alt?.let { "%,d m".format(Locale.US, Math.round(it)) }); f("HIGHEST", s.maxAlt?.let { "%,d m".format(Locale.US, Math.round(it)) })
    f("CLIMB", s.climb?.let { "${if (it >= 0) "+" else ""}${"%.1f".format(Locale.US, it)} m/s" })
    f("GROUND SPEED", s.vH?.let { "%.1f m/s (%.0f km/h)".format(Locale.US, it, it * 3.6) })
    f("HEADING", s.heading?.let { "${Math.round(it)}° ${compass(it)}" }); f("SATELLITES", s.sats?.toString())
    f("TEMPERATURE", s.tempC?.let { "%.1f °C".format(Locale.US, it) }); f("HUMIDITY", s.rh?.let { "%.0f %%".format(Locale.US, it) })
    f("PRESSURE", s.hPa?.let { "%.1f hPa".format(Locale.US, it) })
    f("BATTERY", s.battV?.let { "%.1f V".format(Locale.US, it) }); f("BURST TIMER", s.killS?.let { sondeMins(it.toDouble()) })
    f("BURST", s.burst?.let { "%,d m at %s".format(Locale.US, Math.round(it.alt), LoraHub.clock(it.ms)) })
    val p = s.predict
    f("PREDICTED LANDING", p?.let { "%.4f, %.4f in %s".format(Locale.US, it.lat, it.lon, sondeMins(it.inS.toDouble())) })
    f("LANDING FROM YOU", p?.let { fromHere(me, it.lat, it.lon) })
    f("ASSUMED BURST", if (p != null && s.phase == SondePhase.ASCENT) "%,d m".format(Locale.US, p.burstAlt) else null)
    f("ERRORS FIXED", if (s.fixed > 0) "${s.fixed}" else null)
    for (x in s.fields) out.add(x.name to x.value)
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

/** "12 km NE" from where you are, or "" without a position. */
internal fun fromHere(me: Pair<Double, Double>?, lat: Double, lon: Double): String {
    me ?: return ""
    val (km, brg) = distBearing(me.first, me.second, lat, lon)
    return "${if (km < 10) "%.1f".format(Locale.US, km) else "${Math.round(km)}"} km ${compass(brg)}"
}
