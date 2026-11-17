package com.rocketgod.mayhem.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.hd.HdApp
import com.rocketgod.mayhem.core.hd.HdLot
import com.rocketgod.mayhem.core.hd.HdObj
import com.rocketgod.mayhem.core.hd.HdSis
import com.rocketgod.mayhem.core.hd.HdSnap
import com.rocketgod.mayhem.core.hd.HdStationRec
import com.rocketgod.mayhem.core.hd.ProgramRow
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max

private val HD_VIEWS = listOf("NOW", "STATIONS", "MAP", "DATA", "LOG")
/** On a wide screen NOW PLAYING and the map share the big pane, so they are not tabs. */
private val HD_WIDE_VIEWS = listOf(1, 3, 4)
private val HD_KIND = mapOf("art" to "ALBUM ART", "logo" to "LOGO", "traffic" to "TRAFFIC TILE", "traffic-info" to "TRAFFIC MAP INFO", "radar" to "WEATHER RADAR",
    "radar-info" to "RADAR INFO", "image" to "IMAGE", "text" to "TEXT", "file" to "FILE")
private const val HD_NOTE = "HD Radio (NRSC-5) on hybrid FM stations, receive only. Layer 1 is decoded here from the standard: the station's name, ID, location, slogan and message (SIS, majority-voted: its checksum does not verify yet), each program's title, artist and album (PSD), and the data services: album art, station logos, traffic map tiles and weather radar placed on the map, every file shown in DATA. The digital audio codec is proprietary and not decoded: what plays is the station's analog FM under the digital sidebands. The large-object and service-directory formats are derived from our recordings. AUTO steps across the band, finds the stations with digital sidebands, and stays on each until it fills in."

private fun hdMhz(hz: Long) = "%.1f".format(java.util.Locale.US, hz / 1e6)
private fun hdAgo(ms: Long): String = when {
    ms < 2_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s ago"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    ms < 172_800_000 -> "${ms / 3_600_000} h ago"
    else -> "${ms / 86_400_000} days ago"
}
private fun hdClock(ms: Long) = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(ms))
private fun hdHex(v: Int, n: Int = 4) = "0x" + Integer.toHexString(v).uppercase().padStart(n, '0')
private fun hdSize(n: Int) = if (n < 1024) "$n B" else "%.1f KB".format(java.util.Locale.US, n / 1024.0)

/** Decoded pictures, made once: objects by key, traffic tiles with their background made see-through, logos by content. */
private object HdBitmaps {
    private val cache = object : LinkedHashMap<String, Bitmap?>(64, 0.75f, true) { override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap?>) = size > 200 }
    @Synchronized fun get(key: String, bytes: ByteArray, clearRgb: IntArray? = null): Bitmap? = cache.getOrPut(key) {
        val b = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull() ?: return@getOrPut null
        if (clearRgb == null) b else {
            val m = b.copy(Bitmap.Config.ARGB_8888, true) ?: return@getOrPut b
            val px = IntArray(m.width * m.height); m.getPixels(px, 0, m.width, 0, 0, m.width, m.height)
            for (i in px.indices) { val c = px[i]; if (abs(((c shr 16) and 255) - clearRgb[0]) < 10 && abs(((c shr 8) and 255) - clearRgb[1]) < 10 && abs((c and 255) - clearRgb[2]) < 10) px[i] = 0 }
            m.setPixels(px, 0, m.width, 0, 0, m.width, m.height); m
        }
    }
    @Synchronized fun clear() = cache.clear()
}
private fun hdObjBitmap(o: HdObj): Bitmap? {
    if (!o.mime.startsWith("image/")) return null
    if (o.kind == "traffic") {
        val t = HdLot.trafficTile(o.name); val bg = t?.let { HdApp.traffic()[it.map]?.background }
        return HdBitmaps.get("${o.key}/${bg?.joinToString(",")}", o.bytes, bg)
    }
    return HdBitmaps.get(o.key, o.bytes)
}

/** The lock, in words, and how it shows. */
private fun hdLock(m: HdSnap?, now: Long): Pair<String, Color?> {
    if (m == null) return "TUNING" to null
    val st = m.station; val fresh = st.lastFrameMs > 0 && now - st.lastFrameMs < 4_000
    if (fresh) return (if (st.ber < 0.05) "DIGITAL LOCK" else "DIGITAL · WEAK") to Palette.ok
    if (m.rx.state == "frames" || m.rx.state == "sync") return "SYNC" to Palette.accent2
    if (m.rx.state == "ofdm") return "OFDM FOUND" to Palette.accent2
    if (m.det?.present == true) return "SIDEBANDS" to Palette.accent2
    return "ANALOG ONLY" to null
}

/** The station's own logo for a program: one received this session, else the one kept with the station. */
private fun hdLogo(hz: Long, prog: Int, objs: List<HdObj>, rec: HdStationRec?): Bitmap? {
    val logos = HdApp.objectsOf(hz, objs).filter { it.kind == "logo" }
    val l = logos.firstOrNull { it.program == prog } ?: if (prog == 0) logos.firstOrNull { it.program < 0 } else null
    if (l != null) return hdObjBitmap(l)
    val b = rec?.logos?.get(prog.toString()) ?: (if (prog == 0) rec?.logos?.get("0") else null) ?: return null
    return HdBitmaps.get("logo/${rec?.hz}/$prog/${b.size}/${b.contentHashCode()}", b)
}

/**
 * HD Radio: the digital side of hybrid FM stations, with the analog audio playing under it (receive only). NOW
 * PLAYING is the hero: art, the station's logo, each program's song, signal per sideband and the lock. STATIONS
 * holds every HD station heard (kept); MAP puts the transmitters, traffic tiles and radar on the map; DATA every
 * file received; LOG every event.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HdScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val live by HdApp.proc.snap.collectAsState()
    val stations by HdApp.stations.collectAsState()
    val liveObjs by HdApp.objects.collectAsState()
    val maps by HdApp.maps.collectAsState()
    val scan by HdApp.scan.collectAsState()
    val logSnap by HdApp.log.snapshot.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val fix by Geo.fix.collectAsState()
    val tuned = lo + offset
    var view by rememberSaveable { mutableIntStateOf(0) }
    var left by rememberSaveable { mutableIntStateOf(0) }
    var prog by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var held by remember { mutableStateOf<Pair<HdSnap?, List<HdObj>>?>(null) }
    var full by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(500); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { Geo.start(ctx) }
    LaunchedEffect(Unit) { while (true) { delay(500); HdApp.scanTick(System.currentTimeMillis()) } }
    val wide = d.wide
    LaunchedEffect(wide) { if (wide && (view == 0 || view == 2)) { view = 1 }; if (wide) full = false }
    val m = (held?.first ?: live)?.takeIf { abs(it.hz - tuned) < 2_000 }
    val objs = held?.second ?: liveObjs
    val here = HdApp.objectsOf(tuned, objs)
    val rec = stations[HdApp.key(tuned)]
    val st = m?.station
    val call = st?.sis?.callsign?.takeIf { it.isNotEmpty() && st.sis.nameVotes.first >= 3 } ?: rec?.call ?: ""
    val progs = st?.programs ?: emptyList()
    val selProg = progs.firstOrNull { it.n == prog } ?: progs.firstOrNull()
    val (lock, tone) = hdLock(m, now)
    val tabs = if (wide) HD_WIDE_VIEWS else HD_VIEWS.indices.toList()

    fun pick(hz: Long) { HdApp.pick(hz); if (wide) left = 0 else view = 0 }
    fun save(o: HdObj) {
        val name = o.name.replace(Regex("[^A-Za-z0-9._$-]"), "_").ifEmpty { "hd-${hdHex(o.port)}-${hdHex(o.id)}.bin" }
        val r = Saves.toDownloads(ctx, name, o.mime, o.bytes, pictures = o.mime.startsWith("image/"))
        Toast.makeText(ctx, if (r != null) "saved $r" else "could not save", Toast.LENGTH_LONG).show()
    }
    fun export() {
        val (csv, json) = HdApp.exportAll(); val stamp = Saves.stamp()
        val a = Saves.toDownloads(ctx, "hd-log-$stamp.csv", "text/csv", csv.toByteArray())
        val b = Saves.toDownloads(ctx, "hd-stations-$stamp.json", "application/json", json.toByteArray())
        Toast.makeText(ctx, if (a != null && b != null) "saved $a and $b" else "could not save", Toast.LENGTH_LONG).show()
    }

    @Composable
    fun switcher(modifier: Modifier = Modifier) {
        val labels = tabs.map { i -> when (i) { 1 -> "STATIONS ${stations.size}"; 3 -> "DATA ${here.size}"; else -> HD_VIEWS[i] } }
        HdSeg(labels, tabs.indexOf(view), accent, modifier) { view = tabs[it]; sel = null }
    }

    @Composable
    fun hdMap(modifier: Modifier) {
        val traffic = remember(maps) { HdApp.traffic() }; val radar = remember(maps) { HdApp.radar() }
        val pins = stations.values.filter { it.lat != null && it.lon != null }.map { r -> GeoItem("st:${r.hz}", r.lat!!, r.lon!!, "${r.call.ifEmpty { hdMhz(r.hz) }} ${hdMhz(r.hz)}", GeoItem.Kind.TOWER) }
        // the newest tile of each place in the grid, the newest radar image of each area
        val tiles = LinkedHashMap<String, Pair<HdObj, HdLot.Tile>>()
        for (o in objs) { if (o.kind != "traffic") continue; val t = HdLot.trafficTile(o.name) ?: continue; if (traffic[t.map] == null) continue
            val k = "${t.map}/${t.row}/${t.col}"; val cur = tiles[k]; if (cur == null || cur.second.stamp < t.stamp) tiles[k] = o to t }
        val radars = LinkedHashMap<String, Pair<HdObj, HdLot.Radar>>()
        for (o in objs) { if (o.kind != "radar") continue; val r = HdLot.radarImage(o.name) ?: continue; if (radar[r.area] == null) continue
            val cur = radars[r.area]; if (cur == null || cur.second.stamp < r.stamp) radars[r.area] = o to r }
        val imgs = ArrayList<GeoImage>()
        for ((area, p) in radars) { val info = radar[area]!!; hdObjBitmap(p.first)?.let { imgs.add(GeoImage("radar:$area", it, info.north, info.south, info.west, info.east, 0.7f)) } }
        for ((k, p) in tiles) { val b = HdLot.tileBounds(traffic[p.second.map]!!, p.second.row, p.second.col); hdObjBitmap(p.first)?.let { imgs.add(GeoImage("tile:$k", it, b.north, b.south, b.west, b.east, 0.9f)) } }
        val layers = remember(imgs.map { it.id + it.bitmap.hashCode() }) { GeoLayers(images = imgs) }
        Column(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            GeoMapView(pins, accent, Modifier.fillMaxWidth().weight(1f).panel(), home = fix, selected = "st:${HdApp.key(tuned)}", layers = layers,
                start = remember { mapStart(Geo.fix.value) },
                emptyTitle = if (pins.isEmpty() && imgs.isEmpty()) "No map data yet" else "", emptySub = "Transmitters show here from each station's SIS; traffic tiles and weather radar where a station sends them") { id ->
                if (id.startsWith("st:")) id.substring(3).toLongOrNull()?.let { pick(it) }
            }
            if (imgs.isNotEmpty()) HdLegend(tiles.size, traffic.values.firstOrNull(), radars.entries.lastOrNull()?.let { radar[it.key] to it.value.second.stamp })
        }
    }

    @Composable
    fun hero(modifier: Modifier) {
        val scroll = rememberScrollState()
        Column(modifier.verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            HdHero(m, now, tuned, call, rec, selProg, here, objs, lock, accent) { prog = it }
            AppNote(HD_NOTE)
        }
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            when (view) {
                0 -> hero(Modifier.fillMaxSize())
                1 -> if (stations.isEmpty()) EmptyState("hd", Modifier.fillMaxSize().panel(), accent)
                    else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        items(stations.values.sortedBy { it.hz }, key = { it.hz }) { r -> HdStationCard(r, r.hz == HdApp.key(tuned), now, objs, accent) { pick(r.hz) } }
                    }
                2 -> hdMap(Modifier.fillMaxSize())
                3 -> HdData(m, here, now, sel, accent, onSel = { k -> sel = if (sel == k) null else k }, onSave = ::save, Modifier.fillMaxSize())
                else -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "listening for HD Radio…", total = logSnap.total, accent = accent, emptyKey = "hd")
            }
            val o = objs.firstOrNull { it.key == sel }
            if (o != null) HdDetail(o, now, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)), onSave = { save(o) }) { sel = null }
        }
    }

    val wf = waterfallOn(MayhemApp.HD, phoneDefault = false)
    PacketFrame(accent, HdApp.log, tag = "HD RADIO", title = if (call.isNotEmpty()) "$call${selProg?.let { " · HD${it.n + 1}" } ?: ""}" else "NRSC-5 · FM HYBRID",
        roomy = true, waterfall = wf, shift = -offset.toLong(), retune = { HdApp.pick(it) },
        widePane = { mod ->
            Column(mod, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                HdSeg(listOf("NOW PLAYING", "MAP"), left, accent, Modifier.fillMaxWidth()) { left = it }
                if (left == 0) hero(Modifier.fillMaxWidth().weight(1f)) else hdMap(Modifier.fillMaxWidth().weight(1f))
            }
        },
        onWaterfall = { Apps.setWaterfall(MayhemApp.HD, !wf) },
        lamp = { Lamp(lock, tone ?: Palette.muted, blink = tone == Palette.accent2) },
        controls = {
            HdHead(m, tuned, call, rec, scan, stations.size, here.size, now, lock, tone, accent)
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
                ToggleBox("AUTO", scan.auto, accent, Modifier.fillMaxHeight()) { HdApp.setAuto(!scan.auto) }
                ToggleBox("◀", false, accent, Modifier.fillMaxHeight()) { HdApp.step(-1) }
                ToggleBox("▶", false, accent, Modifier.fillMaxHeight()) { HdApp.step(1) }
                Box(Modifier.weight(1f))
                ToggleBox("EXPORT", false, accent, Modifier.fillMaxHeight()) { export() }
                ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent, Modifier.fillMaxHeight()) { held = if (held == null) live to liveObjs else null }
                IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { HdApp.clear(); HdBitmaps.clear(); held = null; sel = null }
                if (!wide) IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
            }
        }, body = {
            Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                switcher(Modifier.fillMaxWidth())
                stage(Modifier.fillMaxWidth().weight(1f))
            }
        })
    if (full) FullscreenPanel("HD RADIO · ${HD_VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
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

@Composable
private fun HdDim(text: String, modifier: Modifier = Modifier) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = modifier.padding(d.dp(8f)))
}

@Composable
private fun HdPill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, c.copy(alpha = 0.7f), RoundedCornerShape(50)).background(c.copy(alpha = 0.10f))
            .padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
}

/** A level bar, 0..1. */
@Composable
private fun HdBar(frac: Float, c: Color, modifier: Modifier) {
    val track = Palette.line
    Canvas(modifier) {
        drawRoundRect(track.copy(alpha = 0.6f), cornerRadius = CornerRadius(size.height / 2))
        drawRoundRect(c, size = Size(size.width * frac.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height / 2))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdKv(kv: List<Pair<String, String>>) {
    val d = rememberDims()
    FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(12f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(v, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
        }
    }
}

/** The station watched (frequency, call sign, slogan, lock), what AUTO is doing, and the counters. */
@Composable
private fun HdHead(m: HdSnap?, tuned: Long, call: String, rec: HdStationRec?, scan: HdApp.Scan, nStations: Int, nObjects: Int, now: Long, lock: String, tone: Color?, accent: Color) {
    val d = rememberDims()
    val st = m?.station
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${hdMhz(tuned)} MHz", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp, maxLines = 1)
            if (call.isNotEmpty()) Text(call, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
            Text(st?.sis?.slogan?.ifEmpty { null } ?: rec?.slogan?.ifEmpty { null } ?: (if ((st?.frames ?: 0) > 0) "" else "no digital data yet"),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            HdPill(lock, tone ?: Palette.muted)
        }
        if (scan.auto) {
            val text = if (scan.phase == "survey") "AUTO · LOOKING ${hdMhz(scan.cur - HdApp.REACH)}–${hdMhz(scan.cur + HdApp.REACH)}"
                else "AUTO · ${if (scan.locked != 0L) "FILLING IN" else "CHECKING"} ${max(0L, (scan.until - now + 999) / 1000)} s · ${scan.queue.size} NEXT"
            Text(text, color = if (scan.locked != 0L) Palette.ok else Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val progs = st?.programs?.count { it.lastMs > 0 } ?: rec?.programs?.size ?: 0
            val ber = if (st != null && st.frames > 0) "%.2f%%".format(java.util.Locale.US, st.ber * 100) else "-"
            for ((n, l) in listOf("$progs" to "PROGRAMS", "$nStations" to "STATIONS", "$nObjects" to "OBJECTS", "${st?.frames ?: 0}" to "FRAMES", ber to "RAW BER")) {
                Column(Modifier.weight(1f).panel().padding(horizontal = d.dp(6f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun HdPicture(bmp: Bitmap?, modifier: Modifier, crop: Boolean = false) {
    if (bmp == null) return
    val ib = remember(bmp) { bmp.asImageBitmap() }
    Image(ib, null, modifier, contentScale = if (crop) ContentScale.Crop else ContentScale.Fit)
}

/** NOW PLAYING: the art, the station, the song, the program tabs, the signal per sideband and the songs before. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdHero(m: HdSnap?, now: Long, tuned: Long, call: String, rec: HdStationRec?, sel: ProgramRow?, here: List<HdObj>, objs: List<HdObj>, lock: String, accent: Color, onProg: (Int) -> Unit) {
    val d = rememberDims()
    val st = m?.station
    val progs = st?.programs ?: emptyList()
    val n = sel?.n ?: 0
    val artObj = sel?.artId?.let { id -> here.firstOrNull { it.id == id && it.mime.startsWith("image/") } }
    val logo = hdLogo(tuned, n, objs, rec)
    val art = artObj?.let { hdObjBitmap(it) }
    val name = call.ifEmpty { hdMhz(tuned) }
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Brush.linearGradient(listOf(accent.copy(alpha = 0.14f), Palette.panel))).border(1.dp, accent.copy(alpha = 0.4f), shape).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
        Row(horizontalArrangement = Arrangement.spacedBy(d.dp(12f))) {
            Box(Modifier.width(d.dp(if (d.wide) 190f else 132f)).aspectRatio(1f).clip(RoundedCornerShape(d.dp(12f))).background(Palette.surface).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f))),
                contentAlignment = Alignment.Center) {
                val pic = art ?: logo
                if (pic != null) HdPicture(pic, Modifier.fillMaxSize().padding(if (art != null) 0.dp else d.dp(10f)), crop = art != null)
                else Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    AppGlyph(MayhemApp.HD, accent, Modifier.size(d.dp(54f)))
                    Text(name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
                    Text("HD${n + 1}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    if (logo != null) HdPicture(logo, Modifier.size(d.dp(26f)).clip(RoundedCornerShape(d.dp(4f))))
                    Text(name, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f), maxLines = 1)
                }
                val typeName = sel?.typeName?.ifEmpty { null } ?: rec?.programs?.firstOrNull { it.n == n }?.typeName?.ifEmpty { null }
                Text("${hdMhz(tuned)} MHz${if (sel != null) " · HD${sel.n + 1}" else ""}${typeName?.let { " · $it" } ?: ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1)
                val waiting = if (st == null || st.frames == 0) (if (lock == "ANALOG ONLY") "No digital sidebands on this station: the analog audio plays" else "Waiting for the digital side") else "Waiting for this program's song data"
                val title = sel?.title.orEmpty()
                Text(title.ifEmpty { waiting }, color = if (title.isNotEmpty()) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                    fontSize = d.sp(if (title.isNotEmpty()) 19f else 12f), maxLines = 3, overflow = TextOverflow.Ellipsis)
                if (!sel?.artist.isNullOrEmpty()) Text(sel!!.artist, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(13f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                val album = listOf(sel?.album.orEmpty(), sel?.genre.orEmpty()).filter { it.isNotEmpty() }.joinToString(" · ")
                if (album.isNotEmpty()) Text(album, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (!st?.sis?.message.isNullOrEmpty()) Text(st!!.sis.message, color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
        if (progs.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for (p in progs) {
                val on = p.n == sel?.n; val liveP = p.lastMs > 0 && now - p.lastMs < 10_000
                val ps = RoundedCornerShape(d.dp(10f))
                Column(Modifier.widthIn(min = d.dp(110f), max = d.dp(200f)).clip(ps).background(if (on) accent.copy(alpha = 0.18f) else Palette.surface)
                    .border(if (on) 1.5.dp else 1.dp, if (on) accent else Palette.line, ps).clickable { onProg(p.n) }.padding(horizontal = d.dp(9f), vertical = d.dp(6f))) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                        Text("HD${p.n + 1}", color = if (on) accent else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
                        if (liveP) Box(Modifier.size(d.dp(6f)).background(Palette.ok, CircleShape))
                        Text(p.typeName.ifEmpty { "program" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1)
                    }
                    Text(if (p.title.isNotEmpty()) "${p.title}${if (p.artist.isNotEmpty()) " · ${p.artist}" else ""}" else if (p.lastMs > 0) "on air" else "listed in SIS",
                        color = Palette.ink.copy(alpha = 0.8f), fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        // signal quality per sideband, then the lock and what plays
        val det = m?.det
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
            for ((label, snr, sb) in listOf(Triple("LOWER", st?.takeIf { it.frames > 0 }?.snrLoDb, det?.sbLoDb), Triple("UPPER", st?.takeIf { it.frames > 0 }?.snrHiDb, det?.sbHiDb))) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(52f)))
                    val v = if (snr == null || snr < -50) 0f else (snr / 25).toFloat()
                    HdBar(v, if (v > 0.4f) Palette.ok else Palette.accent2, Modifier.weight(1f).height(d.dp(7f)))
                    Text((if (snr == null || snr < -50) "-" else "%.1f dB SNR".format(java.util.Locale.US, snr)) +
                        (if (sb != null && det != null) " · %.0f dB over noise".format(java.util.Locale.US, sb - det.refDb) else ""),
                        color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
                }
            }
            HdKv(listOfNotNull("LOCK" to lock,
                if (st != null && st.frames > 0) "RAW BER" to "%.2f%%".format(java.util.Locale.US, st.ber * 100) else null,
                if (st != null && st.frames > 0) "PCI" to st.pciName else null,
                if (m != null) "CARRIER" to "%+.0f Hz".format(java.util.Locale.US, m.rx.cfoHz) else null,
                "AUDIO" to "ANALOG FM"))
        }
        if (sel != null && sel.songs.size > 1) Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
            Text("EARLIER ON HD${sel.n + 1}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
            for (s in sel.songs.drop(1).take(7)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(hdClock(s.ms), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
                Text("${s.title}${if (s.artist.isNotEmpty()) " · ${s.artist}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** One station heard: logo, call sign, frequency, slogan, programs, facility, transmitter, data services. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdStationCard(r: HdStationRec, here: Boolean, now: Long, objs: List<HdObj>, accent: Color, onTap: () -> Unit) {
    val d = rememberDims()
    val liveR = here && now - r.lastMs < 5_000
    val logo = hdLogo(r.hz, 0, objs, r) ?: r.logos.values.firstOrNull()?.let { HdBitmaps.get("logo/${r.hz}/any/${it.size}/${it.contentHashCode()}", it) }
    Row(Modifier.fillMaxWidth().panel(if (here) accent else Palette.line).clickable { onTap() }.padding(d.dp(9f)), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
        Box(Modifier.size(d.dp(52f)).clip(RoundedCornerShape(d.dp(8f))).background(Palette.surface), contentAlignment = Alignment.Center) {
            if (logo != null) HdPicture(logo, Modifier.fillMaxSize().padding(d.dp(3f))) else AppGlyph(MayhemApp.HD, Palette.muted, Modifier.size(d.dp(30f)))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(r.call.ifEmpty { "name not heard yet" }, color = if (r.call.isNotEmpty()) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
                Text("${hdMhz(r.hz)} MHz", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, modifier = Modifier.weight(1f))
                Text(if (liveR) "LIVE" else hdAgo(now - r.lastMs), color = if (liveR) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
            }
            val sub = r.slogan.ifEmpty { r.longName }
            if (sub.isNotEmpty()) Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (r.programs.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                for (p in r.programs) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    Text("HD${p.n + 1}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f))
                    Text(p.typeName + if (p.title.isNotEmpty()) " ${p.title}${if (p.artist.isNotEmpty()) " · ${p.artist}" else ""}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            HdKv(listOfNotNull(
                if (r.facility >= 0) "FACILITY" to "${r.facility}" else null,
                if (r.country.isNotEmpty()) "COUNTRY" to r.country else null,
                if (r.lat != null && r.lon != null) "TX" to "%.4f, %.4f".format(java.util.Locale.US, r.lat, r.lon) + (r.altM?.let { " · $it m" } ?: "") else null,
                if (r.data.isNotEmpty()) "DATA" to r.data.joinToString(", ") else null,
                "FIRST" to java.text.DateFormat.getDateInstance(java.text.DateFormat.SHORT, java.util.Locale.US).format(java.util.Date(r.firstMs))))
        }
    }
}

/** Under the map: how many traffic tiles, the radar's time and its color legends, and whose they are. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdLegend(tiles: Int, traffic: HdLot.TrafficInfo?, radar: Pair<HdLot.RadarInfo?, String>?) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        if (tiles > 0) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("TRAFFIC", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f))
            Text("$tiles tiles${traffic?.copyright?.ifEmpty { null }?.let { " · $it" } ?: ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2)
        }
        val info = radar?.first
        if (info != null) {
            Text("RADAR ${radar.second.replace('_', ' ')} UTC", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                for (l in info.legends) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                    Text(l.name.uppercase(), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), modifier = Modifier.padding(end = d.dp(3f)))
                    for ((_, c) in l.colors) Box(Modifier.size(d.dp(10f), d.dp(8f)).background(Color(c[0], c[1], c[2])))
                }
            }
            if (info.copyright.isNotEmpty()) Text(info.copyright, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 2)
        }
    }
}

/** DATA: every file this station sent, what is still coming in, the voted SIS, the service directory and the ports. */
@Composable
private fun HdData(m: HdSnap?, objs: List<HdObj>, now: Long, sel: String?, accent: Color, onSel: (String) -> Unit, onSave: (HdObj) -> Unit, modifier: Modifier) {
    val d = rememberDims()
    val st = m?.station
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        if (objs.isEmpty()) item(key = "none") { HdDim("no files yet · logos and album art take a minute or two to come in whole") }
        items(objs, key = { it.key }) { o ->
            Row(Modifier.fillMaxWidth().panel(if (sel == o.key) accent else Palette.line).clickable { onSel(o.key) }.padding(horizontal = d.dp(8f), vertical = d.dp(5f)),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Box(Modifier.size(d.dp(40f)).clip(RoundedCornerShape(d.dp(6f))).background(Palette.surface), contentAlignment = Alignment.Center) {
                    val b = hdObjBitmap(o)
                    if (b != null) HdPicture(b, Modifier.fillMaxSize())
                    else Text(if (o.mime == "text/plain") "TXT" else "BIN", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
                }
                Column(Modifier.weight(1f)) {
                    Text(o.name.ifEmpty { "object ${hdHex(o.id)}" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${HD_KIND[o.kind] ?: o.kind} · port ${hdHex(o.port)} · ${hdSize(o.size)} · ${o.mime} · ${hdAgo(now - o.ms)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 2)
                }
                ToggleBox("SAVE", false, accent) { onSave(o) }
            }
        }
        val pend = st?.pending?.filter { it.need < 10_000 }.orEmpty()
        if (pend.isNotEmpty()) item(key = "pend") {
            HdSection("COMING IN", accent) {
                for (p in pend) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text(p.name.ifEmpty { "object ${hdHex(p.id)}" }, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    HdBar(p.have.toFloat() / p.need, accent, Modifier.width(d.dp(70f)).height(d.dp(6f)))
                    Text("${p.have}/${p.need} · port ${hdHex(p.port)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1)
                }
            }
        }
        if (st != null && st.frames > 0) item(key = "sis") {
            val s = st.sis
            val f = listOf(
                "CALL SIGN" to (if (s.callsign.isNotEmpty()) "${s.callsign} (${s.nameVotes.first} of ${s.nameVotes.second} votes)" else "-"),
                "LONG NAME" to s.longName.ifEmpty { "-" }, "UNIVERSAL NAME" to s.universal.ifEmpty { "-" }, "SLOGAN" to s.slogan.ifEmpty { "-" }, "MESSAGE" to s.message.ifEmpty { "-" },
                "FACILITY" to (if (s.facility >= 0) "${s.country} ${s.facility}" else "-"),
                "TRANSMITTER" to (if (s.lat != null && s.lon != null) "%.5f, %.5f".format(java.util.Locale.US, s.lat, s.lon) + (s.altM?.let { " · $it m" } ?: "") else "-"),
                "STATION CLOCK" to (if (s.alfnMs != 0L) java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(s.alfnMs)) + " UTC" + (if (s.timeLocked) " · locked to GPS" else "") else "-"),
                "AUDIO SERVICES" to s.audio.joinToString(" · ") { "HD${it.program + 1} ${HdSis.programTypeName(it.type)}" }.ifEmpty { "-" },
                "DATA SERVICES" to s.data.joinToString(" · ") { "${HdSis.dataTypeName(it.type)} (MIME ${it.mime12})" }.ifEmpty { "-" },
                "FIXED BEARER" to (st.ccc?.subs?.joinToString(" + ") { "${it.length} B/frame" } ?: "-"),
                "PACKETS" to "${st.hdlcGood} good · ${st.hdlcBad} failed FCS", "SIS PDUS" to "${s.pdus} (${s.llds} other)")
            HdSection("STATION INFORMATION (SIS, voted)", accent) { SelectionContainer { FieldGrid(f, labelWidth = 120f, minColumn = 320f) } }
        }
        if (st != null && st.sig.isNotEmpty()) item(key = "sig") {
            HdSection("SERVICE DIRECTORY (format derived from recordings)", accent) {
                for (s in st.sig) Column {
                    Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text(s.name.ifEmpty { if (s.kind == "audio") "HD${s.program + 1}" else "data" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
                        Text(if (s.kind == "audio") "HD${s.program + 1} · ${HdSis.programTypeName(s.progType)}" else "data service", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                    }
                    Text(s.components.joinToString(" · ") { "port ${hdHex(it.port)} · MIME ${it.mimeHex}" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                }
            }
        }
        if (st != null && st.ports.isNotEmpty()) item(key = "ports") {
            HdSection("PORTS", accent) {
                val cols = listOf(0.16f, 0.38f, 0.14f, 0.14f, 0.18f)
                @Composable
                fun row(cells: List<String>, head: Boolean) = Row(Modifier.fillMaxWidth()) {
                    cells.forEachIndexed { i, c -> Text(c, color = if (head) Palette.muted else Palette.ink, fontFamily = Mono, fontWeight = if (head) FontWeight.Bold else FontWeight.Normal,
                        fontSize = d.sp(if (head) 8f else 9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(cols[i])) }
                }
                row(listOf("PORT", "WHAT", "PACKETS", "BYTES", "LAST"), true)
                for (p in st.ports) row(listOf(hdHex(p.port), listOf(p.kind, p.name).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { p.bearer }, "${p.packets}", hdSize(p.bytes), hdAgo(now - p.lastMs)), false)
            }
        }
        item(key = "note") { AppNote(HD_NOTE) }
    }
}

@Composable
private fun HdSection(title: String, accent: Color, content: @Composable () -> Unit) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
        content()
    }
}

/** The selected file: the picture or the text, and every field. */
@Composable
private fun HdDetail(o: HdObj, now: Long, accent: Color, modifier: Modifier, onSave: () -> Unit, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().heightIn(max = d.dp(460f)).clip(shape).background(Palette.panel.copy(alpha = 0.96f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(HD_KIND[o.kind] ?: "FILE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), letterSpacing = 1.sp, modifier = Modifier.weight(1f), maxLines = 1)
            ToggleBox("SAVE", false, accent, Modifier.fillMaxHeight()) { onSave() }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        val b = hdObjBitmap(o)
        if (b != null) Box(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(d.dp(8f))).padding(d.dp(6f)), contentAlignment = Alignment.Center) {
            HdPicture(b, Modifier.fillMaxWidth().heightIn(max = d.dp(260f)))
        }
        if (o.mime == "text/plain") SelectionContainer {
            Text(String(o.bytes, Charsets.ISO_8859_1), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(d.dp(8f))).padding(d.dp(8f)))
        }
        val f = listOf("NAME" to o.name.ifEmpty { "-" }, "KIND" to (HD_KIND[o.kind] ?: o.kind), "PORT" to hdHex(o.port), "OBJECT ID" to hdHex(o.id), "SIZE" to "${o.size} bytes", "TYPE" to o.mime,
            "PROGRAM" to (if (o.program >= 0) "HD${o.program + 1}" else "-"), "STATION" to "${hdMhz(o.hz)} MHz", "RECEIVED" to "${hdClock(o.ms)} · ${hdAgo(now - o.ms)}")
        SelectionContainer { FieldGrid(f, labelWidth = 96f, minColumn = 300f) }
    }
}

