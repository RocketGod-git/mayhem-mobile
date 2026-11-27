package com.rocketgod.mayhem.ui

import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.atsc.AtscApp
import com.rocketgod.mayhem.core.atsc.AtscDetail
import com.rocketgod.mayhem.core.atsc.AtscSnap
import com.rocketgod.mayhem.core.atsc.AtscStill
import com.rocketgod.mayhem.core.atsc.EventRec
import com.rocketgod.mayhem.core.atsc.LiveSignal
import com.rocketgod.mayhem.core.atsc.StationRow
import com.rocketgod.mayhem.core.atsc.SubRow
import com.rocketgod.mayhem.core.atsc.centerOf
import com.rocketgod.mayhem.core.atsc.tsidText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private val AT_VIEWS = listOf("CHANNELS", "SIGNAL", "GUIDE", "LOG")
private val AT_LV = intArrayOf(-7, -5, -3, -1, 1, 3, 5, 7)
private val AT_SERVICE = mapOf(0 to "not in the channel table", 1 to "analog TV", 2 to "digital TV", 3 to "audio only", 4 to "data only", 5 to "software download", 6 to "unassociated", 7 to "parameterized", 8 to "ATSC 3.0", 9 to "ATSC 3.0 audio")

private fun atMhz(hz: Double) = "%.0f".format(Locale.US, hz / 1e6)
private fun atAgo(ms: Long): String = when {
    ms < 5_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s ago"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    ms < 172_800_000 -> "${ms / 3_600_000} h ago"
    else -> "${ms / 86_400_000} d ago"
}
private fun atTime(ms: Long): String = java.text.SimpleDateFormat("h:mm a", Locale.US).format(java.util.Date(ms))
private fun atVc(x: SubRow) = if (x.major != 0) "${x.major}.${x.minor}" else "P${x.program}"
/** Station time: the device clock corrected by the station's STT when there is one. */
private fun atNow(s: StationRow?) = System.currentTimeMillis() + (s?.stt?.diffMs?.toLong() ?: 0L)
private fun atKbps(k: Double) = if (k >= 1000) "%.2f Mb/s".format(Locale.US, k / 1000) else "%.0f kb/s".format(Locale.US, k)
private fun atF(v: Double, d: Int) = "%.${d}f".format(Locale.US, v)
private fun atSigned(v: Double, d: Int) = (if (v >= 0) "+" else "") + atF(v, d)

/** What the connected radio can and cannot do here, said plainly; the tone is 2 ok, 1 amber, 0 none. */
private fun atCapability(kind: Radio.Kind): Pair<String, Int> = when (kind) {
    Radio.Kind.NONE -> "NO RADIO · a HackRF decodes channels, guide and pictures; an RTL-SDR finds stations by their pilot" to 0
    Radio.Kind.RTLSDR -> "RTL-SDR · finds stations by their pilot and shows level and offset · it cannot decode them, that needs 8 MS/s across the 6 MHz channel (a HackRF)" to 1
    else -> "HACKRF · 8 MS/s · the whole 6 MHz channel, decoded to channels, guide, station time and a picture of every subchannel" to 2
}

/**
 * ATSC TV: over-the-air digital TV stations, receive only. CHANNELS is the station wall (a picture, now and next for
 * every subchannel), SIGNAL the receiver's view of the tuned channel (pilot, SNR, slicer, eye, echoes, packets),
 * GUIDE the program guide of every station heard, LOG every event. A tap on a subchannel opens its guide, its streams
 * and the raw tables.
 */
@Composable
fun AtscScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val liveSnap by AtscApp.proc.snap.collectAsState()
    val scan by AtscApp.scan.collectAsState()
    val stills by AtscApp.stills.collectAsState()
    val kind by Radio.kind.collectAsState()
    val logSnap by AtscApp.log.snapshot.collectAsState()
    // PAUSE holds the channels, the guide and the log still for reading; decoding carries on and RESUME catches up
    var paused by remember { mutableStateOf(false) }
    var heldSnap by remember { mutableStateOf<AtscSnap?>(null) }
    var heldLog by remember { mutableStateOf<List<String>>(emptyList()) }
    val s = if (paused) heldSnap else liveSnap
    val wide = d.wide
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf("") }
    var sigSel by rememberSaveable { mutableStateOf("") }
    var detail by remember { mutableStateOf<AtscDetail?>(null) }
    var rawOpen by remember { mutableStateOf(false) }
    var full by remember { mutableStateOf(false) }
    val guide = remember { mutableStateMapOf<String, List<EventRec>>() }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(500); value = System.currentTimeMillis() } }.value
    // AUTO runs while the screen is up
    LaunchedEffect(Unit) { while (true) { delay(300); AtscApp.tick(System.currentTimeMillis()) } }
    LaunchedEffect(wide) { if (wide && view == 0) view = 1 }
    LaunchedEffect(sel) {
        detail = null; rawOpen = false
        val k = sel.ifEmpty { return@LaunchedEffect }
        while (true) { detail = withContext(Dispatchers.Default) { AtscApp.proc.detail(k) }; detail?.let { guide[it.key] = it.events }; delay(5_000) }
    }
    // the guide shows more than now and next: each subchannel's whole list now and then
    LaunchedEffect(view) {
        while (view == 2) {
            val keys = AtscApp.proc.snap.value?.stations?.flatMap { st -> st.subs.filter { it.events > 2 }.map { it.key } } ?: emptyList()
            for (k in keys) withContext(Dispatchers.Default) { AtscApp.proc.detail(k) }?.let { guide[k] = it.events }
            delay(15_000)
        }
    }
    val wf = waterfallOn(MayhemApp.ATSC, phoneDefault = false)
    val tabs = if (wide) listOf(1, 2, 3) else AT_VIEWS.indices.toList()
    val subsN = s?.stations?.sumOf { it.subs.size } ?: 0

    fun pick(k: String) { sel = if (sel == k) "" else k }
    fun export() {
        scope.launch {
            val (csv, json) = withContext(Dispatchers.Default) { AtscApp.proc.exportAll() }; val stamp = Saves.stamp()
            val a = Saves.toDownloads(ctx, "atsc-log-$stamp.csv", "text/csv", csv.toByteArray())
            val b = Saves.toDownloads(ctx, "atsc-tables-$stamp.json", "application/json", json.toByteArray())
            Toast.makeText(ctx, if (a != null && b != null) "saved $a and $b" else "could not save", Toast.LENGTH_LONG).show()
        }
    }

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        val labels = listOf("CHANNELS $subsN", "SIGNAL", "GUIDE", "LOG")
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.Top) {
            AtSeg(tabs.map { labels[it] }, tabs.indexOf(view), accent, Modifier.weight(1f)) { view = tabs[it] }
            ToggleBox("EXPORT", false, accent) { export() }
            PauseClear(paused, accent, Modifier, onPause = { paused = !paused; heldSnap = liveSnap; heldLog = logSnap.lines }) {
                scope.launch(Dispatchers.Default) { AtscApp.clear() }; sel = ""; guide.clear(); heldSnap = null; heldLog = emptyList()
            }
            if (withFull && !wide) IconBox(FullscreenIcon, "Full screen") { full = true }
        }
    }

    @Composable
    fun wall(modifier: Modifier) {
        val snap = s
        if (snap == null || snap.stations.isEmpty()) { EmptyState("atsc", modifier.panel(), accent); return }
        val order = snap.stations.sortedWith(compareByDescending<StationRow> { it.ch == snap.ch }.thenByDescending { it.subs.isNotEmpty() }.thenBy { it.ch })
        LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            items(order, key = { it.key }) { st -> AtStation(st, snap, stills, sel, now, accent, { sigSel = st.key; view = 1 }, ::pick) }
        }
    }

    @Composable
    fun detailPanel(modifier: Modifier) {
        val snap = s ?: return
        if (sel.isEmpty()) return
        val st = snap.stations.firstOrNull { sel.startsWith(it.key + "/") } ?: return
        val x = st.subs.firstOrNull { it.key == sel } ?: return
        AtDetailPanel(st, x, detail?.takeIf { it.key == sel }, stills[sel], scan, rawOpen, accent, modifier, { rawOpen = !rawOpen }, { AtscApp.holdOn(st.ch) }, { sel = "" })
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            when (view) {
                0 -> wall(Modifier.fillMaxSize())
                1 -> AtSignal(s, sigSel, accent, Modifier.fillMaxSize(), { sigSel = it }, { AtscApp.holdOn(it) })
                2 -> AtGuide(s, guide, wide, accent, Modifier.fillMaxSize(), ::pick)
                else -> LogList(if (paused) heldLog else logSnap.lines, Modifier.fillMaxSize(), empty = "looking for stations…", total = if (paused) null else logSnap.total, accent = accent)
            }
            if (!wide && view != 3) detailPanel(Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)))
        }
    }

    PacketFrame(accent, AtscApp.log, tag = "TV", title = "DIGITAL TV", tunable = false, roomy = true, waterfall = wf,
        widePane = { m -> wall(m) },
        onWaterfall = { Apps.setWaterfall(MayhemApp.ATSC, !wf) },
        lamp = {
            when {
                subsN > 0 -> Lamp("$subsN CHANNEL${if (subsN == 1) "" else "S"}", Palette.ok)
                (s?.stations?.size ?: 0) > 0 -> Lamp("${s!!.stations.size} STATION${if (s!!.stations.size == 1) "" else "S"}", Palette.ok)
                kind == Radio.Kind.NONE -> Lamp("NO RADIO", Palette.muted)
                else -> Lamp("SCANNING", Palette.accent2, blink = true)
            }
        },
        controls = {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                val bands = listOf("AUTO" to "AUTO", "VHF" to "VHF 2–13", "UHF" to "UHF 14–36")
                AtSeg(bands.map { it.second }, bands.indexOfFirst { it.first == scan.band }, accent, Modifier.weight(1f)) { AtscApp.setBand(bands[it].first) }
                ToggleBox("◀", false, accent) { AtscApp.step(-1) }
                Text("CH ${s?.ch?.takeIf { it > 0 } ?: AtscApp.scanCh()}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
                ToggleBox("▶", false, accent) { AtscApp.step(1) }
            }
        }, body = {
            Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                AtHead(s, scan, stills, kind, now, accent)
                switcher(true, Modifier.fillMaxWidth())
                // a wide screen docks the details above the stage
                if (wide) detailPanel(Modifier.fillMaxWidth())
                stage(Modifier.fillMaxWidth().weight(1f))
            }
        })
    if (full) FullscreenPanel("ATSC · ${AT_VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** What the radio can do, the channel being watched with its pilot and sync, the scan state and the counters. */
@Composable
private fun AtHead(s: AtscSnap?, scan: AtscApp.Scan, stills: Map<String, AtscStill>, kind: Radio.Kind, now: Long, accent: Color) {
    val d = rememberDims()
    val (cap, tone) = atCapability(kind)
    val ch = s?.ch?.takeIf { it > 0 } ?: AtscApp.scanCh()
    val h = s?.here?.takeIf { it.ch == ch }
    val reading = h != null && (h.pilotOk || h.sync)
    val status = if (scan.band == "HOLD") "HOLDING CH $ch" else "${scan.band} · CH $ch · ${scan.idx + 1}/${scan.list.size} · ${if (reading) "READING" else "LOOKING"} ${max(0L, (now - scan.tunedMs) / 1000)} s"
    val info = when {
        h != null && h.pilotOk -> "${if (h.tsid >= 0) "TSID ${tsidText(h.tsid)} · " else ""}pilot +${atF(h.pilotDb, 0)} dB · channel +${atF(h.topDb, 0)} dB over the floor${if (h.sync) " · segment sync" else ""}${if (h.snrDb.isFinite()) " · SNR ${atF(h.snrDb, 1)} dB" else ""}"
        h != null && h.topDb.isFinite() -> "no 8VSB pilot · channel +${atF(h.topDb, 0)} dB over the floor"
        else -> "no 8VSB pilot yet"
    } + if (s?.capability == "decode") " · ${max(1, s.workers)} decoder${if (max(1, s.workers) == 1) "" else "s"}" else ""
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        val tc = when (tone) { 2 -> Palette.ok; 1 -> Palette.accent2; else -> Palette.muted }
        Text(cap, color = tc, fontFamily = Mono, fontSize = d.sp(9.5f), lineHeight = d.sp(13f),
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(d.dp(8f))).border(1.dp, tc.copy(alpha = 0.45f), RoundedCornerShape(d.dp(8f))).padding(horizontal = d.dp(8f), vertical = d.dp(5f)))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("CH $ch · ${atMhz(centerOf(ch))} MHz", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), letterSpacing = 2.sp, maxLines = 1)
            Text(info, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            val pc = if (reading) Palette.ok else Palette.muted
            Text(status, color = pc, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.5.sp, maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, pc.copy(alpha = if (reading) 1f else 0.4f), RoundedCornerShape(50)).padding(horizontal = d.dp(8f), vertical = d.dp(3f)))
        }
        val subs = s?.stations?.sumOf { it.subs.size } ?: 0
        val onAir = s?.stations?.sumOf { st -> st.subs.count { it.now != null } } ?: 0
        val pics = s?.stations?.sumOf { st -> st.subs.count { it.key in stills } } ?: 0
        val dec = if (s?.capability == "decode") "${atF(s.decodedPct, 0)}%" else "-"
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for ((n, l) in listOf("${s?.stations?.size ?: 0}" to "STATIONS", "$subs" to "CHANNELS", "$onAir" to "ON NOW", "$pics" to "PICTURES", dec to "DECODED")) {
                Column(Modifier.weight(1f).clip(RoundedCornerShape(d.dp(10f))).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.25f), RoundedCornerShape(d.dp(10f))).padding(vertical = d.dp(5f)),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun AtPicture(r: AtscStill?, modifier: Modifier) {
    if (r == null) return
    val ib = remember(r.bmp) { r.bmp.asImageBitmap() }
    Image(ib, null, modifier, contentScale = ContentScale.Crop)
}

/** A subchannel's picture, or what stands in for it, with its virtual channel over it. */
@Composable
private fun AtStill(x: SubRow, r: AtscStill?, live: Boolean, now: Long) {
    val d = rememberDims()
    val vid = x.streams.firstOrNull { it.type == 0x02 || it.type == 0x1b }
    val empty = when {
        vid == null -> "NO VIDEO"; vid.type == 0x1b -> "H.264 · NO PICTURE"; AtscApp.rtl() -> "PICTURES NEED A HACKRF"; live -> "WAITING FOR A PICTURE"; else -> "NO PICTURE YET"
    }
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(d.dp(8f))).background(Color(0xFF05080A))) {
        if (r != null) AtPicture(r, Modifier.fillMaxSize())
        else Text(empty, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.align(Alignment.Center))
        Text(atVc(x), color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f),
            modifier = Modifier.align(Alignment.TopStart).padding(d.dp(4f)).clip(RoundedCornerShape(d.dp(5f))).background(Color(0xB3000000)).padding(horizontal = d.dp(5f), vertical = d.dp(1f)))
        if (live && r != null && now - r.ms < 20_000) Text("NEW", color = Color(0xFF05080A), fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8f),
            modifier = Modifier.align(Alignment.TopEnd).padding(d.dp(4f)).clip(RoundedCornerShape(d.dp(5f))).background(Palette.ok).padding(horizontal = d.dp(5f), vertical = d.dp(1f)))
    }
}

/** Now and next on the station's own clock, with how far into the program it is. */
@Composable
private fun AtNowNext(st: StationRow, x: SubRow) {
    val d = rememberDims()
    val now = atNow(st); val e = x.now; val n = x.next
    if (e == null && n == null) { Text(if (x.events > 0) "nothing on now in the guide" else "no guide yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f)); return }
    if (e != null) {
        val pct = ((now - e.startMs).toFloat() / (e.seconds * 1000f)).coerceIn(0f, 1f)
        Text(e.title.ifEmpty { "untitled" }, color = Palette.ink, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("${atTime(e.startMs)}–${atTime(e.startMs + e.seconds * 1000L)}${if (e.rating.isNotEmpty()) " · ${e.rating}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1)
        Box(Modifier.fillMaxWidth().height(d.dp(3f)).clip(RoundedCornerShape(2.dp)).background(Palette.line)) { Box(Modifier.fillMaxWidth(pct).height(d.dp(3f)).background(Palette.accent)) }
    }
    if (n != null) Text("NEXT ${atTime(n.startMs)} ${n.title.ifEmpty { "untitled" }}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** One station: its RF channel and name, and a tile for every subchannel. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AtStation(st: StationRow, s: AtscSnap, stills: Map<String, AtscStill>, sel: String, now: Long, accent: Color, onSignal: () -> Unit, pick: (String) -> Unit) {
    val d = rememberDims()
    val live = s.ch == st.ch && now - st.pilotMs < 4_000
    val name = st.subs.firstOrNull { it.longName.isNotEmpty() }?.longName ?: st.tvName
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, if (live) accent.copy(alpha = 0.6f) else Palette.line, shape).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Column(Modifier.clip(RoundedCornerShape(d.dp(8f))).background(accent.copy(alpha = 0.15f)).padding(horizontal = d.dp(8f), vertical = d.dp(3f)), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("${st.ch}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(16f))
                Text("RF", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7f), letterSpacing = 1.sp)
            }
            Column(Modifier.weight(1f)) {
                Text(name.ifEmpty { if (st.tsid >= 0) "TSID ${tsidText(st.tsid)}" else "PILOT ONLY" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${atMhz(st.centerHz)} MHz${if (st.tsid >= 0) " · TSID ${tsidText(st.tsid)}" else ""} · pilot +${atF(st.pilotDb, 0)} dB${if (st.snrDb.isFinite()) " · SNR ${atF(st.snrDb, 1)} dB" else ""} · ${st.subs.size} channel${if (st.subs.size == 1) "" else "s"}",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 2)
            }
            val lc = if (live) Palette.ok else Palette.muted
            Text(if (live) "● LIVE" else atAgo(now - st.lastMs).uppercase(Locale.US), color = lc, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp,
                modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, lc.copy(alpha = 0.6f), RoundedCornerShape(50)).clickable { onSignal() }.padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
        }
        if (st.subs.isEmpty()) {
            Text(if (s.capability == "pilot") "a station is on this channel: decoding it needs a HackRF at 8 MS/s" else if (live) "reading the channel list…" else "channel list not decoded yet",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
            return@Column
        }
        val cols = if (d.widthDp >= 700) 3 else 2
        for (row in st.subs.chunked(cols)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            for (x in row) {
                val on = sel == x.key
                Column(Modifier.weight(1f).clip(RoundedCornerShape(d.dp(10f))).background(if (on) accent.copy(alpha = 0.14f) else Palette.panel)
                    .border(if (on) 2.dp else 1.dp, if (on) accent else Palette.line, RoundedCornerShape(d.dp(10f))).clickable { pick(x.key) }.padding(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                    AtStill(x, stills[x.key], live, now)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), itemVerticalAlignment = Alignment.CenterVertically) {
                        Text(x.name.ifEmpty { "program ${x.program}" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
                        if (x.access) AtPill("PAY", Palette.accent2)
                        if (x.hidden) AtPill("HIDDEN", Palette.muted)
                    }
                    AtNowNext(st, x)
                    val audio = x.streams.filter { it.type == 0x81 || it.type == 0x87 }.joinToString("") { " · ${it.lang.ifEmpty { "audio" }}" }
                    Text(x.video.ifEmpty { x.streams.joinToString(" · ") { it.typeName } } + audio + if (x.streams.any { it.captions.isNotEmpty() }) " · CC" else "",
                        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            repeat(cols - row.size) { Box(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun AtPill(t: String, c: Color) {
    val d = rememberDims()
    Text(t, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(7.5f), letterSpacing = 1.sp,
        modifier = Modifier.clip(RoundedCornerShape(d.dp(4f))).border(1.dp, c.copy(alpha = 0.6f), RoundedCornerShape(d.dp(4f))).padding(horizontal = d.dp(4f), vertical = d.dp(1f)))
}

@Composable
private fun AtTile(v: String, l: String, tone: Color?, modifier: Modifier) {
    val d = rememberDims()
    Column(modifier.clip(RoundedCornerShape(d.dp(10f))).background(Palette.surface).border(1.dp, (tone ?: Palette.line).copy(alpha = if (tone != null) 0.7f else 1f), RoundedCornerShape(d.dp(10f))).padding(vertical = d.dp(5f), horizontal = d.dp(4f)),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(v, color = tone ?: Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f), maxLines = 1)
        Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7f), letterSpacing = 0.8.sp, maxLines = 2, lineHeight = d.sp(9f))
    }
}

/** The receiver's view of a station: pilot, SNR, uncorrectable packets, then the live slicer, eye, echoes, history and PIDs. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AtSignal(s: AtscSnap?, sigSel: String, accent: Color, modifier: Modifier, onSel: (String) -> Unit, onTune: (Int) -> Unit) {
    val d = rememberDims()
    if (s == null) { EmptyState("atsc", modifier.panel(), accent); return }
    val key = sigSel.ifEmpty { if (s.ch > 0) "ch${s.ch}" else s.stations.firstOrNull()?.key ?: "" }
    val st = s.stations.firstOrNull { it.key == key }
    val live = s.live?.takeIf { st != null && it.ch == st.ch }
    Column(modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        if (s.stations.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
            for (x in s.stations) ToggleBox("CH ${x.ch}", x.key == key, accent) { onSel(x.key) }
        }
        if (st == null) {
            EmptyState("atsc", Modifier.fillMaxWidth().height(d.dp(240f)).panel(), accent, title = if (s.stations.isEmpty()) "No station yet" else null,
                tips = if (s.stations.isEmpty()) listOf("Each channel takes a moment, AUTO looks at every one for its pilot", "An antenna up high, or outside, hears stations 60+ miles away") else null)
            return@Column
        }
        val tot = st.rs.total; val fail = if (tot > 0) 100.0 * st.rs.failed / tot else 0.0
        val head = if (live == null) (if (s.ch == st.ch) (if (s.capability == "pilot") "pilot and level only on this radio" else "waiting for the first burst…") else "last heard ${atAgo(System.currentTimeMillis() - st.lastMs)} · tune here for the live equalizer, echoes and packets")
            else if (live.ok) "${live.fields} fields in the last burst · ${live.syncs} field syncs · segment sync ${atF(live.segPeak, 0)}× · clock ${atSigned(live.eps * 1e6, 2)} ppm · ${atF(live.cpuMs, 0)} ms CPU · ${atF(s.decodedPct, 0)}% of the air time decoded"
            else live.reason.ifEmpty { "no lock" }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Column(Modifier.weight(1f)) {
                Text("CH ${st.ch} · ${atMhz(st.centerHz)} MHz${if (live != null) " · LIVE" else ""}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.5.sp)
                Text(head, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
            }
            if (live == null && s.ch != st.ch) ToggleBox("TUNE", false, accent) { onTune(st.ch) }
        }
        val snrTone = if (st.snrDb.isFinite()) (if (st.snrDb >= 16) Palette.ok else if (st.snrDb >= 14.5) Palette.accent2 else Palette.danger) else null
        val failTone = if (tot > 0) (if (fail < 1) Palette.ok else if (fail < 10) Palette.accent2 else Palette.danger) else null
        val tiles = listOf(Triple("+${atF(st.pilotDb, 1)}", "PILOT dB", null), Triple(atSigned(st.pilotHz, 0), "PILOT OFFSET Hz", null),
            Triple(if (st.snrDb.isFinite()) atF(st.snrDb, 1) else "-", "EQUALIZER SNR dB", snrTone), Triple(if (tot > 0) "${atF(fail, if (fail < 1) 2 else 0)}%" else "-", "UNCORRECTABLE", failTone),
            Triple(if (tot > 0) "${atF(100.0 * st.rs.corrected / tot, 0)}%" else "-", "RS CORRECTED", null), Triple(if (st.topDb.isFinite()) "+${atF(st.topDb, 0)}" else "-", "CHANNEL OVER FLOOR dB", null))
        for (row in tiles.chunked(if (d.widthDp >= 700) 6 else 3)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for ((v, l, t) in row) AtTile(v, l, t, Modifier.weight(1f))
        }
        if (live == null) return@Column
        AtPlot("SLICER · the eight 8VSB levels after the equalizer${if (live.sliceSnrDb.isFinite()) " · ${atF(live.sliceSnrDb, 1)} dB to the nearest level" else ""}") { drawHist(live, accent) }
        AtPlot("EYE · equalized symbols over the last field") { drawEye(live, accent) }
        AtPlot("ECHOES · the channel from the field sync (PN511): the main path and its ghosts by delay") { drawEcho(live, accent, d.sp(9f).toPx()) }
        val rt = live.rs.total
        AtPlot("HISTORY · SNR per burst (line), share of packets lost (bars) · last burst $rt packets, ${live.rs.corrected} corrected (${live.rs.bytes} bytes), ${live.rs.failed} lost") { drawHistory(live, d.sp(9f).toPx()) }
        Text("TRANSPORT STREAM · ${"%,d".format(Locale.US, st.packets)} packets · ${"%,d".format(Locale.US, st.badPackets)} lost", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp)
        val mx = max(0.01, live.pids.maxOfOrNull { it.share } ?: 0.01)
        AtTable(listOf("PID", "CARRIES", "RATE", "CC", "PCR"), live.pids.map { p ->
            listOf("0x%04X".format(p.pid), p.role.ifEmpty { "?" }, atKbps(p.kbps), if (p.ccErrors > 0) "${p.ccErrors}" else "", if (p.pcrs > 0) "${atF(p.pcrIntervalMs, 0)} ms · ${atSigned(p.pcrPpm, 1)} ppm" else "")
        }, bars = live.pids.map { (it.share / mx).toFloat() }, barCol = 2, accent = accent)
    }
}

@Composable
private fun AtPlot(label: String, draw: DrawScope.() -> Unit) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 0.5.sp)
        Canvas(Modifier.fillMaxWidth().height(d.dp(120f))) { draw() }
    }
}

private fun DrawScope.label(t: String, x: Float, y: Float, c: Color, px: Float) {
    val p = android.graphics.Paint().apply { color = c.toArgb(); textSize = px; isAntiAlias = true; typeface = android.graphics.Typeface.MONOSPACE }
    drawContext.canvas.nativeCanvas.drawText(t, x, y, p)
}

/** Slicer histogram: the eight levels as peaks. */
private fun DrawScope.drawHist(l: LiveSignal, acc: Color) {
    val w = size.width; val h = size.height; val hh = l.hist; val mx = max(1, hh.maxOrNull() ?: 1)
    fun xs(v: Float) = (v + 10.5f) / 21f * w
    for (lv in AT_LV) drawLine(Palette.muted.copy(alpha = 0.35f), Offset(xs(lv.toFloat()), 0f), Offset(xs(lv.toFloat()), h - 14f))
    val path = Path(); path.moveTo(0f, h - 14f)
    hh.forEachIndexed { i, v -> path.lineTo(i.toFloat() / hh.size * w, h - 14f - (h - 18f) * sqrt(v.toFloat() / mx)) }
    path.lineTo(w, h - 14f); path.close()
    drawPath(path, Brush.verticalGradient(listOf(acc, Color.Transparent)))
    for (lv in AT_LV) label("${if (lv > 0) "+" else ""}$lv", xs(lv.toFloat()) - 10f, h - 1f, Palette.muted, 22f)
}

/** The eye: equalized symbols over time against the eight levels. */
private fun DrawScope.drawEye(l: LiveSignal, acc: Color) {
    val w = size.width; val h = size.height
    fun ys(v: Float) = h / 2 - v / 9f * (h / 2 - 4f)
    for (lv in AT_LV) drawLine(Palette.muted.copy(alpha = 0.3f), Offset(0f, ys(lv.toFloat())), Offset(w, ys(lv.toFloat())))
    val e = l.eye; if (e.isEmpty()) return
    val c = acc.copy(alpha = 0.7f); val dot = Size(3f, 3f)
    for (i in e.indices) drawRect(c, Offset(i.toFloat() / e.size * w, ys(e[i]) - 1.5f), dot)
}

/** The echo profile ("ghosts"): delay in microseconds against level re the main path, echoes over -25 dB labeled. */
private fun DrawScope.drawEcho(l: LiveSignal, acc: Color, px: Float) {
    val e = l.echo; if (e.isEmpty()) return
    val w = size.width; val h = size.height
    fun us(i: Int) = (i / 2f - 32f) / 10.762237762f
    val umin = us(0); val umax = us(e.size - 1)
    fun xs(u: Float) = (u - umin) / (umax - umin) * w
    fun ys(db: Float) = 4f + (min(0f, max(-40f, db)) / -40f) * (h - 18f)
    for (db in listOf(-10f, -20f, -30f)) drawLine(Palette.muted.copy(alpha = 0.3f), Offset(0f, ys(db)), Offset(w, ys(db)))
    var u = 0f; while (u <= umax) { label("${u.toInt()} µs", xs(u) + 2f, h - 2f, Palette.muted, px); u += 10f }
    label("-20 dB", 2f, ys(-20f) - 2f, Palette.muted, px)
    val path = Path()
    e.forEachIndexed { i, v -> val x = xs(us(i)); val y = ys(v); if (i == 0) path.moveTo(x, y) else path.lineTo(x, y) }
    drawPath(path, acc, style = Stroke(width = 2.4f))
    val sorted = e.copyOfRange(min(e.size, 2 * 72), e.size).sorted(); val floor = sorted.getOrNull(sorted.size shr 1) ?: -30f
    var last = -99f
    for (i in 2 until e.size - 2) {
        val uu = us(i)
        if (kotlin.math.abs(uu) < 1.2f || e[i] < max(-25f, floor + 6) || e[i] < e[i - 1] || e[i] < e[i + 1] || uu - last < 3) continue
        last = uu; drawCircle(Palette.accent2, 6f, Offset(xs(uu), ys(e[i])))
        label("${atF(uu.toDouble(), 1)} µs ${atF(e[i].toDouble(), 0)} dB", min(w - 9 * px, xs(uu) + 8f), ys(e[i]) - 6f, Palette.accent2, px)
    }
    label("MAIN", xs(0f) + 6f, px + 4f, Palette.ok, px)
}

/** SNR per burst (line) and the share of packets lost (bars). */
private fun DrawScope.drawHistory(l: LiveSignal, px: Float) {
    val w = size.width; val h = size.height; val sn = l.snrHistory; val rs = l.rsHistory; val n = max(sn.size, 2)
    fun ys(db: Double) = (h - 4f - ((db - 10) / 25).coerceIn(0.0, 1.0) * (h - 8f)).toFloat()
    drawLine(Palette.muted.copy(alpha = 0.3f), Offset(0f, ys(15.0)), Offset(w, ys(15.0)))
    label("15 dB", 2f, ys(15.0) - 2f, Palette.muted, px)
    rs.forEachIndexed { i, v -> val bh = (v * (h - 8f)).toFloat(); drawRect(Palette.accent2, Offset(i.toFloat() / n * w, h - 4f - bh), Size(max(2f, w / n - 2f), bh)) }
    val path = Path()
    sn.forEachIndexed { i, v -> val x = (i + 0.5f) / n * w; if (i == 0) path.moveTo(x, ys(v)) else path.lineTo(x, ys(v)) }
    drawPath(path, Palette.ok, style = Stroke(width = 3f))
}

/** A small table that scrolls sideways when it is wider than the screen; [bars] draw a level under column [barCol]. */
@Composable
private fun AtTable(head: List<String>, rows: List<List<String>>, bars: List<Float>? = null, barCol: Int = -1, accent: Color = Palette.accent) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row { head.forEachIndexed { i, t -> Text(t, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, modifier = Modifier.width(d.dp(atColW(i, head.size))).padding(d.dp(3f))) } }
        rows.forEachIndexed { r, row ->
            Row(Modifier.background(if (r % 2 == 0) Palette.surface else Color.Transparent)) {
                row.forEachIndexed { i, t ->
                    Box(Modifier.width(d.dp(atColW(i, head.size))).padding(d.dp(3f))) {
                        if (i == barCol && bars != null) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(bars[r].coerceIn(0f, 1f)).height(d.dp(2f)).background(accent.copy(alpha = 0.6f)))
                        Text(t, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2)
                    }
                }
            }
        }
    }
}
private fun atColW(i: Int, n: Int): Float = if (n == 5 && i == 1) 190f else if (i == 0) 64f else 104f

/** The guide: every subchannel's programs on one time line, five hours from half an hour back. */
@Composable
private fun AtGuide(s: AtscSnap?, guide: Map<String, List<EventRec>>, wide: Boolean, accent: Color, modifier: Modifier, pick: (String) -> Unit) {
    val d = rememberDims()
    val rows = s?.stations?.flatMap { st -> st.subs.filter { !it.hideGuide && it.sourceId >= 0 }.map { st to it } } ?: emptyList()
    if (s == null || rows.isEmpty()) {
        EmptyState("atsc", modifier.panel(), accent, title = "No guide yet", tips = listOf("Stations send the guide every few seconds, and it fills in once a station has been decoded", "Each station carries its own subchannels' next few hours"))
        return
    }
    val now = atNow(s.stations.firstOrNull { it.ch == s.ch } ?: s.stations[0])
    val t0 = now / 1_800_000 * 1_800_000 - 1_800_000; val span = 5 * 3_600_000L; val ppm = if (wide) 4f else 3f; val wPx = span / 60_000f * ppm
    fun xs(ms: Long) = (ms - t0) / 60_000f * ppm
    val lab = 84f
    Box(modifier.panel()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState())) {
            Box(Modifier.width(d.dp(lab + wPx)).height(d.dp(18f))) {
                var t = t0
                while (t <= t0 + span) { Text(atTime(t), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), modifier = Modifier.offset(x = d.dp(lab + xs(t)))); t += 1_800_000 }
            }
            for ((_, x) in rows) {
                val evs = (guide[x.key] ?: listOfNotNull(x.now, x.next)).filter { it.startMs + it.seconds * 1000L > t0 && it.startMs < t0 + span }
                Box(Modifier.width(d.dp(lab + wPx)).height(d.dp(38f)).clickable { pick(x.key) }) {
                    Column(Modifier.width(d.dp(lab)).padding(d.dp(3f))) {
                        Text(atVc(x), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
                        Text(x.name, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1)
                    }
                    for (e in evs) {
                        val a = max(0f, xs(e.startMs)); val b = min(wPx, xs(e.startMs + e.seconds * 1000L)); val on = e.startMs <= now && e.startMs + e.seconds * 1000L > now
                        Column(Modifier.offset(x = d.dp(lab + a)).width(d.dp(max(2f, b - a - 2))).height(d.dp(36f)).clip(RoundedCornerShape(d.dp(5f)))
                            .background(if (on) accent.copy(alpha = 0.25f) else Palette.surface).border(1.dp, if (on) accent else Palette.line, RoundedCornerShape(d.dp(5f))).padding(horizontal = d.dp(4f), vertical = d.dp(2f))) {
                            Text(e.title.ifEmpty { "untitled" }, color = Palette.ink, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(atTime(e.startMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1)
                        }
                    }
                    Box(Modifier.offset(x = d.dp(lab + xs(now))).width(2.dp).height(d.dp(38f)).background(Palette.danger))
                }
            }
        }
    }
}

/** Everything about one subchannel: its picture, its guide with the descriptions, the fields, streams and raw tables. */
@Composable
private fun AtDetailPanel(st: StationRow, x: SubRow, det: AtscDetail?, pic: AtscStill?, scan: AtscApp.Scan, rawOpen: Boolean, accent: Color, modifier: Modifier,
                          onRaw: () -> Unit, onHold: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val now = atNow(st)
    val shape = RoundedCornerShape(d.dp(14f))
    Column(modifier.fillMaxWidth().height(d.dp(if (d.wide) 300f else 420f)).clip(shape).background(Palette.panel).border(1.dp, accent.copy(alpha = 0.6f), shape)) {
        Row(Modifier.fillMaxWidth().padding(d.dp(8f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${atVc(x)} ${x.name}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(13f), maxLines = 1)
            Text(x.longName.ifEmpty { "RF ${st.ch} · program ${x.program}" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ToggleBox(if (scan.band == "HOLD" && scan.stayCh == st.ch) "HOLDING" else "HOLD HERE", scan.band == "HOLD" && scan.stayCh == st.ch, accent) { onHold() }
            ToggleBox("✕", false, accent) { onClose() }
        }
        SelectionContainer(Modifier.weight(1f)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = d.dp(10f)).padding(bottom = d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                if (pic != null) Column {
                    AtPicture(pic, Modifier.fillMaxWidth().aspectRatio(pic.bmp.width.toFloat() / max(1, pic.bmp.height)).clip(RoundedCornerShape(d.dp(8f))))
                    Text("${if (pic.complete) "whole picture" else "part of a picture"} · ${atAgo(System.currentTimeMillis() - pic.ms)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                }
                AtHeadline("PROGRAM GUIDE")
                if (!det?.chanText.isNullOrEmpty()) Text(det.chanText, color = Palette.muted, fontSize = d.sp(10f))
                val evs = (det?.events ?: listOfNotNull(x.now, x.next)).filter { it.startMs + it.seconds * 1000L > now - 3_600_000 }
                if (evs.isEmpty()) Text("no guide for this channel yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
                for (e in evs) {
                    val on = e.startMs <= now && e.startMs + e.seconds * 1000L > now
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(d.dp(6f))).background(if (on) accent.copy(alpha = 0.14f) else Color.Transparent).padding(d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text(atTime(e.startMs), color = if (on) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), modifier = Modifier.width(d.dp(62f)))
                        Column(Modifier.weight(1f)) {
                            Text(e.title.ifEmpty { "untitled" }, color = Palette.ink, fontWeight = FontWeight.Bold, fontSize = d.sp(11.5f))
                            Text("${Math.round(e.seconds / 60.0)} min${if (e.rating.isNotEmpty()) " · ${e.rating}" else ""}${if (e.captions.isNotEmpty()) " · ${e.captions}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                            if (e.text.isNotEmpty()) Text(e.text, color = Palette.ink.copy(alpha = 0.8f), fontStyle = FontStyle.Italic, fontSize = d.sp(10f))
                        }
                    }
                }
                val vinfo = det?.video?.firstOrNull { v -> x.streams.any { it.pid == v.pid } }
                val fields = listOf("VIRTUAL CHANNEL" to "${atVc(x)}${if (x.name.isNotEmpty()) " ${x.name}" else ""}", "RF CHANNEL" to "${st.ch} · ${atMhz(st.centerHz)} MHz", "TSID" to if (st.tsid >= 0) tsidText(st.tsid) else "-",
                    "PROGRAM" to "${x.program}", "SOURCE ID" to if (x.sourceId >= 0) "${x.sourceId}" else "-", "SERVICE" to (AT_SERVICE[x.serviceType] ?: "type ${x.serviceType}"), "VIDEO" to x.video.ifEmpty { "-" },
                    "PICTURES" to if (vinfo != null) "${vinfo.pictures} seen, ${vinfo.iPictures} intra · ${vinfo.gop.takeLast(15)}" else "-",
                    "STATION CLOCK" to (st.stt?.let { "${java.time.Instant.ofEpochMilli(now).toString().substring(11, 19)} UTC · ${atSigned(it.diffMs / 1000, 1)} s from this device" } ?: "-"), "TABLES" to st.tables.joinToString(" "))
                for (row in fields.chunked(2)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    for ((k, v) in row) Column(Modifier.weight(1f)) {
                        Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp)
                        Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                    if (row.size == 1) Box(Modifier.weight(1f))
                }
                AtHeadline("STREAMS")
                AtTable(listOf("PID", "STREAM", "LANG", "DETAIL", "RATE"), x.streams.map { y -> listOf("0x%04X".format(y.pid), y.typeName, y.lang, listOf(y.info, y.captions).filter { it.isNotEmpty() }.joinToString(" · "), atKbps(y.kbps)) })
                if (det == null) Text("loading the tables…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                else {
                    Text("RAW TABLES · ${det.raw.size} sections ${if (rawOpen) "▾" else "▸"}", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.clickable { onRaw() })
                    if (rawOpen) for (t in det.raw) Column {
                        Text(t.table, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
                        Text(t.hex.chunked(64).joinToString(" "), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                    }
                }
            }
        }
    }
}

@Composable
private fun AtHeadline(t: String) { val d = rememberDims(); Text(t, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.5.sp) }

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AtSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
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
