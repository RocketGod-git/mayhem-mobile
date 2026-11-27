package com.rocketgod.mayhem.ui

import com.rocketgod.mayhem.core.Units
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.text.TextStyle
import com.rocketgod.mayhem.core.hd.ObjectRow
import com.rocketgod.mayhem.core.hd.SisAlert
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
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
import com.rocketgod.mayhem.core.hd.HdScanPlan
import com.rocketgod.mayhem.core.hd.HdSis
import com.rocketgod.mayhem.core.hd.HdSnap
import com.rocketgod.mayhem.core.hd.HdStationRec
import com.rocketgod.mayhem.core.hd.ProgramRow
import com.rocketgod.mayhem.core.hd.SisSummary
import com.rocketgod.mayhem.core.hd.StationSnap
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private val HD_VIEWS = listOf("NOW", "STATIONS", "MAP", "DATA", "LOG")
/** On a wide screen NOW PLAYING and the map share the big pane, so they are not tabs. */
private val HD_WIDE_VIEWS = listOf(1, 3, 4)
private val HD_KIND = mapOf("art" to "ALBUM ART", "logo" to "LOGO", "traffic" to "TRAFFIC TILE", "traffic-info" to "TRAFFIC MAP INFO", "radar" to "WEATHER RADAR",
    "radar-info" to "RADAR INFO", "image" to "IMAGE", "text" to "TEXT", "file" to "FILE", "carved" to "FOUND INSIDE")
/** DATA's gallery filters: each object kind's group and its label. */
private val HD_GROUPS = listOf("art" to "ART", "logo" to "LOGOS", "traffic" to "TRAFFIC", "radar" to "RADAR", "other" to "FILES")
private fun hdGroup(o: HdObj) = if (o.kind == "art" || o.kind == "logo") o.kind else if (o.kind.startsWith("traffic")) "traffic" else if (o.kind.startsWith("radar")) "radar" else "other"
private fun hdIsText(mime: String) = mime.startsWith("text/") || mime == "application/json" || mime == "application/xml"
/** A number as the web prints it: 7.9, 8, 0.5. */
private fun hdNum(v: Double) = if (v == Math.floor(v) && abs(v) < 1e15) v.toLong().toString() else v.toString()
/** Signal quality from the raw BER, 0 (none) to 5 bars. */
private fun hdBars(st: StationSnap?): Int {
    if (st == null || st.frames == 0) return 0
    val b = st.ber
    return if (b < 0.002) 5 else if (b < 0.01) 4 else if (b < 0.03) 3 else if (b < 0.06) 2 else 1
}
/** Bytes as hex rows of 16 with their text. */
private fun hdHexDump(b: ByteArray, max: Int = 512): String {
    val sb = StringBuilder()
    var i = 0
    while (i < minOf(b.size, max)) {
        val e = minOf(i + 16, b.size)
        if (i > 0) sb.append('\n')
        sb.append("%06x  ".format(i))
        sb.append((i until e).joinToString(" ") { "%02x".format(b[it].toInt() and 255) }.padEnd(47)).append("  ")
        for (k in i until e) { val x = b[k].toInt() and 255; sb.append(if (x in 32..126) x.toChar() else '.') }
        i += 16
    }
    if (b.size > max) sb.append("\n… ${b.size - max} more bytes")
    return sb.toString()
}
private const val HD_NOTE = "HD Radio (NRSC-5) on hybrid FM stations, receive only. Layer 1 is decoded here from the standard: the station's name, ID, location, slogan and message (SIS, majority-voted: its checksum does not verify yet), each program's title, artist and album (PSD), and the data services: album art, station logos, traffic map tiles and weather radar placed on the map, every file shown in DATA. The digital audio of every program is decoded: HD1 plays the station's analog FM until its digital audio is ready, or when it drops out; the other programs are silent until then. The large-object and service-directory formats are derived from our recordings. AUTO first finds the stations across the band, then visits the strong ones from the bottom up and stays on each until it fills in. At the top it looks again."

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

/** The station's transmitter as sent: a place on the map, or why it is not one. */
private fun hdLocText(s: SisSummary, home: Pair<Double, Double>?): String {
    val lat = s.lat ?: return "-"; val lon = s.lon ?: return "-"
    val at = "%.5f, %.5f".format(java.util.Locale.US, lat, lon) + (s.altM?.let { " · ${Units.fmtAlt(it.toDouble())}" } ?: "")
    if (!HdSis.locationValid(lat, lon)) return "$at · not a valid location as sent, not placed on the map"
    val d = home?.let { com.rocketgod.mayhem.core.ham.distanceBearing(it.first, it.second, lat, lon) } ?: return at
    return at + " · " + Units.fmtDist(d.first) + " at %.0f°".format(java.util.Locale.US, d.second)
}
/** The station clock, checked against this device's: never used when it disagrees. */
private fun hdClockText(s: SisSummary): String {
    if (s.alfnMs == 0L) return "-"
    val c = HdSis.clockCheck(s.alfnMs, s.alfnLocalMs, s.timeLocked)
    val t = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(s.alfnMs)) + " UTC"
    if (c.trusted) return "$t · agrees with this device (%.1f s) · locked to GPS".format(java.util.Locale.US, c.offsetMs / 1000.0)
    val off = abs(c.offsetMs)
    val d = when { off < 120_000 -> "${off / 1000} s"; off < 7_200_000 -> "${off / 60_000} min"; off < 172_800_000 -> "%.1f h".format(java.util.Locale.US, off / 3_600_000.0); else -> "${off / 86_400_000} days" }
    return "$t · " + (if (s.alfnLocalMs != 0L) "$d ${if (c.offsetMs < 0) "behind" else "ahead of"} this device" else "not checked") + (if (s.timeLocked) "" else " · not locked to GPS") + " · not used"
}
/** SIS parameter 3 as a hint, marked unreliable when it disagrees with this device or does not hold steady. */
private fun hdTzText(s: SisSummary): String {
    val v = s.params[3] ?: return "-"
    val h = HdSis.localTimeHint(v); val (n, total) = s.paramVotes[3] ?: (0 to 0)
    val tz = java.util.TimeZone.getDefault(); val mine = tz.getOffset(System.currentTimeMillis()) / 60_000; val std = tz.rawOffset / 60_000
    val steady = total > 0 && n * 2 > total
    val agrees = steady && (h.offsetMin == mine || h.offsetMin == std)
    return HdSis.utcOffsetText(h.offsetMin) + (if (h.dstLocal) " · DST practiced" else "") + (if (h.dstNow) " · DST in effect" else "") + " · " +
        (if (agrees) "agrees with this device" else "unreliable (${if (steady) "this device is ${HdSis.utcOffsetText(mine)}" else "it changes from frame to frame"})")
}
/** The data services SIS lists (MSG 6 data descriptors), by type, with how many of each. */
private fun hdDataSvcText(s: SisSummary): String =
    s.data.groupingBy { it.type }.eachCount().entries.joinToString(" · ") { (t, n) -> "${HdSis.dataTypeName(t)} ($t)" + if (n > 1) " ×$n" else "" }.ifEmpty { "-" }
/** Emergency alerts (SIS message 9): only one whose CRC-7 and control data CRC both verify is shown. */
private fun hdAlertText(s: SisSummary): String {
    s.alert?.let { return "${it.text} · ${hdAlertMeta(it)}" }
    return if (s.alerts > 0) "none verified · ${s.alerts} alert message${if (s.alerts == 1) "" else "s"}" + (if (s.alertsBad > 0) ", ${s.alertsBad} failed the alert CRC" else ", not complete yet") else "none"
}
private fun hdAlertMeta(a: SisAlert): String =
    "categories ${a.categories.first} / ${a.categories.second} · ${if (a.locations.isNotEmpty()) "${a.locationFormat} ${a.locations.joinToString(", ")}" else "no area codes"} · ${hdClock(a.ms)}"
/** A SIS exciter or importer: maker code, versions and status. */
private fun hdDeviceText(d: HdSis.Device?): String = if (d == null) "-" else
    "${d.maker} · core ${d.core} · maker ${d.makerVersion} · status ${if (d.coreStatus < 0) "?" else "${d.coreStatus}/${d.makerStatus}"}" +
        (d.importerConnected?.let { " · importer ${if (it) "connected" else "not connected"}" } ?: "")

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

/** Clean frames a station sends with no audio for a program before it is said not to send that program (about a minute). */
private const val HD_ABSENT_FRAMES = 40
/** Why a program plays nothing yet: no station locked, its audio not in yet, or the station not sending it. */
private fun hdNoAudioWhy(st: StationSnap?, n: Int): String {
    val name = "HD${n + 1}"
    if (st == null || st.framesGood == 0) return "WAITING FOR THE STATION"
    if (st.programs.any { it.n == n }) return "NO AUDIO FOR $name YET"
    // a program on the extra partitions (P3) needs their frames clean before its absence means anything
    val p3ok = st.p3.frames == 0 || st.p3.good >= HD_ABSENT_FRAMES / 2
    return if (st.framesGood >= HD_ABSENT_FRAMES && p3ok) "STATION NOT SENDING $name" else "NO AUDIO FOR $name YET"
}
/** What the selected program's audio is doing, in words and how it shows. */
private fun hdAudioText(m: HdSnap?, n: Int): Pair<String, Color?> {
    val a = m?.audio
    if (a == null || a.program != n) return (if (n == 0) "ANALOG" else "WAITING") to null
    if (a.state == "digital") return "DIGITAL" to Palette.ok
    val wait = if (a.good > 0 || a.bufferS > 0) "BUFFERING ${min(99, (a.bufferS / 2 * 100).roundToInt())}%" else "WAITING"
    if (n == 0) return "ANALOG · $wait" to Palette.accent2
    return (if (wait == "WAITING") "SILENT · ${hdNoAudioWhy(m.station, n)}" else "SILENT · $wait") to Palette.accent2
}

/** The station's own logo for a program: one received this session, else the one kept with the station. */
private fun hdLogo(hz: Long, prog: Int, objs: List<HdObj>, rec: HdStationRec?): Bitmap? {
    val logos = HdApp.objectsOf(hz, objs).filter { it.kind == "logo" }
    val l = logos.firstOrNull { it.program == prog } ?: if (prog == 0) logos.firstOrNull { it.program < 0 } else null
    if (l != null) return hdObjBitmap(l)
    val b = rec?.logos?.get(prog.toString()) ?: (if (prog == 0) rec?.logos?.get("0") else null) ?: return null
    return HdBitmaps.get("logo/${rec?.hz}/$prog/${b.size}/${b.contentHashCode()}", b)
}
/** The picture for a program: its song's album art, else its logo, else the station's logo; true when it is art. */
private fun hdArt(p: ProgramRow?, hz: Long, here: List<HdObj>, objs: List<HdObj>, rec: HdStationRec?): Pair<Bitmap, Boolean>? {
    val id = p?.artId
    if (id != null) here.firstOrNull { it.id == id && it.mime.startsWith("image/") }?.let { o -> hdObjBitmap(o)?.let { return it to true } }
    return hdLogo(hz, p?.n ?: 0, objs, rec)?.let { it to false }
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
    var kind by rememberSaveable { mutableStateOf("all") }
    var tech by rememberSaveable { mutableStateOf(false) }
    val outCh by SdrEngine.outputChannelsFlow.collectAsState()
    val surround by SdrEngine.hdSurround.collectAsState()
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
    val playN = selProg?.n ?: prog
    LaunchedEffect(playN) { HdApp.setProgram(playN) }
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
                emptyTitle = if (pins.isEmpty() && imgs.isEmpty()) "No map data yet" else "", emptySub = "Transmitters show here from each station's SIS. Where a station sends traffic and weather radar, both come in about 1 to 1.5 minutes after tuning") { id ->
                if (id.startsWith("st:")) id.substring(3).toLongOrNull()?.let { pick(it) }
            }
            if (imgs.isNotEmpty()) HdLegend(tiles.size, traffic.values.firstOrNull(), radars.entries.lastOrNull()?.let { radar[it.key] to it.value.second.stamp })
        }
    }

    @Composable
    fun hero(modifier: Modifier) {
        val scroll = rememberScrollState()
        Column(modifier.verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            HdHero(m, now, tuned, call, rec, selProg, here, objs, lock, accent, fix ?: Geo.lastKnownPos(),
                surround = if (outCh >= 6) surround else null, onSurround = { SdrEngine.setHdSurround(!surround) }) { prog = it }
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
                3 -> HdData(m, here, now, sel, accent, fix ?: Geo.lastKnownPos(), kind, tech, onKind = { kind = it }, onTech = { tech = !tech },
                    onSel = { k -> sel = if (sel == k) null else k }, onSave = ::save, Modifier.fillMaxSize())
                else -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "listening for HD Radio…", total = logSnap.total, accent = accent, emptyKey = "hd")
            }
            val o = objs.firstOrNull { it.key == sel }
            // the station's view of the file: header fields, what is inside it and where a carved one came from
            val row = st?.objects?.firstOrNull { o != null && it.port == o.port && it.id == o.id && it.name == o.name }
            if (o != null) HdDetail(o, row, now, accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)), onSave = { save(o) }) { sel = null }
        }
    }

    val wf = waterfallOn(MayhemApp.HD, phoneDefault = false)
    PacketFrame(accent, HdApp.log, tag = "HD RADIO", title = if (call.isNotEmpty()) "$call${selProg?.let { " · HD${it.n + 1}" } ?: ""}" else "STATION DATA · ART · TRAFFIC",
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
            VolumeMuteCard("hd", accent)
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
        val alert = st?.sis?.alert
        if (alert != null) {
            val ash = RoundedCornerShape(d.dp(10f))
            Row(Modifier.fillMaxWidth().clip(ash).background(Palette.danger.copy(alpha = 0.14f)).border(1.dp, Palette.danger, ash)
                .drawBehind { drawRect(Palette.danger, size = Size(6.dp.toPx(), size.height)) }.padding(start = d.dp(14f), end = d.dp(10f), top = d.dp(8f), bottom = d.dp(8f)),
                horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalAlignment = Alignment.CenterVertically) {
                Text("EMERGENCY ALERT", color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9.5f), letterSpacing = 2.sp, maxLines = 1,
                    modifier = Modifier.background(Palette.danger, RoundedCornerShape(4.dp)).padding(horizontal = d.dp(7f), vertical = d.dp(3f)))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                    Text(alert.text.ifEmpty { "no text" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
                    Text(hdAlertMeta(alert), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                }
            }
        }
        val msg = st?.sis?.message.orEmpty()
        if (msg.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Box(Modifier.width(2.dp).height(d.dp(14f)).background(if (st!!.sis.messagePriority) Palette.accent2 else accent))
            if (st!!.sis.messagePriority) HdPill("PRIORITY", Palette.accent2)
            Text(msg, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false, modifier = Modifier.weight(1f).basicMarquee(iterations = Int.MAX_VALUE))
        }
        if (scan.auto) {
            val text = if (scan.phase == "rest") "AUTO · NO HD HEARD · LOOKING AGAIN SOON" else if (scan.phase != "dwell") "AUTO · FINDING STATIONS ${hdMhz(HdScanPlan.BAND_LO)}–${(HdScanPlan.BAND_HI / 1e6).roundToInt()}"
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

/** The art behind NOW PLAYING: shrunk to a few pixels and stretched back, a blur that works on every Android version. */
@Composable
private fun HdBackdrop(bmp: Bitmap, modifier: Modifier) {
    val small = remember(bmp) { runCatching { Bitmap.createScaledBitmap(bmp, 12, 12, true).asImageBitmap() }.getOrNull() } ?: return
    Image(small, null, modifier.alpha(0.42f), contentScale = ContentScale.Crop, filterQuality = FilterQuality.High)
}

/** The output level, left and right, as the meter moves each frame. */
@Composable
private fun HdVu(modifier: Modifier) {
    val d = rememberDims()
    var lv by remember { mutableStateOf(floatArrayOf(0f, 0f)) }
    LaunchedEffect(Unit) { while (true) { withFrameMillis { }; lv = HdApp.proc.audio.levels() } }
    val ok = Palette.ok; val warn = Palette.accent2; val bad = Palette.danger; val track = Palette.muted.copy(alpha = 0.18f)
    Column(modifier.widthIn(max = d.dp(320f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        for ((i, label) in listOf("L", "R").withIndex()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(label, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f))
            Canvas(Modifier.weight(1f).height(d.dp(6f))) {
                val r = CornerRadius(size.height / 2)
                drawRoundRect(track, cornerRadius = r)
                val w = size.width * lv.getOrElse(i) { 0f }.coerceIn(0f, 1f)
                if (w > 0f) clipRect(right = w) {
                    drawRoundRect(Brush.horizontalGradient(0f to ok, 0.65f to ok, 0.8f to warn, 1f to bad, endX = size.width), cornerRadius = r)
                }
            }
        }
    }
}

/** What the audio is doing, as a pill in its color. */
@Composable
private fun HdMode(text: String, c: Color?) {
    val d = rememberDims()
    val col = c ?: Palette.muted
    val sh = RoundedCornerShape(50)
    Text(text, color = col, fontFamily = Mono, fontWeight = FontWeight.ExtraBold, fontSize = d.sp(10f), letterSpacing = 1.8.sp, maxLines = 1,
        modifier = Modifier.clip(sh).background(col.copy(alpha = if (c == Palette.ok) 0.14f else 0.08f)).border(1.dp, if (c != null) col else col.copy(alpha = 0.45f), sh)
            .padding(horizontal = d.dp(10f), vertical = d.dp(4f)))
}

/** Signal quality bars from the raw BER, and the BER. */
@Composable
private fun HdQuality(st: StationSnap?) {
    val d = rememberDims()
    val bars = hdBars(st); val on = Palette.ok; val off = Palette.muted.copy(alpha = 0.3f)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Canvas(Modifier.width(d.dp(28f)).height(d.dp(16f))) {
            val bw = 4.dp.toPx(); val gap = (size.width - 5 * bw) / 4
            for (k in 1..5) { val h = size.height * k / 5f; drawRoundRect(if (k <= bars) on else off, topLeft = Offset((k - 1) * (bw + gap), size.height - h), size = Size(bw, h), cornerRadius = CornerRadius(1.dp.toPx())) }
        }
        Text(if (st != null && st.frames > 0) "BER %.2f%%".format(java.util.Locale.US, st.ber * 100) else "NO DIGITAL", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
    }
}

@Composable
private fun HdCard(cap: String, accent: Color, content: @Composable () -> Unit) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel(shape = RoundedCornerShape(d.dp(12f))).padding(horizontal = d.dp(12f), vertical = d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Text(cap, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
        content()
    }
}

/** One sideband's SNR as a bar, and how far over the noise the detector reads it. */
@Composable
private fun HdSideband(label: String, snr: Double?, sb: Double?, ref: Double?) {
    val d = rememberDims()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.width(d.dp(52f)))
        val v = if (snr == null || snr < -50) 0f else (snr / 25).toFloat().coerceIn(0f, 1f)
        HdBar(v, if (v > 0.4f) Palette.ok else Palette.accent2, Modifier.weight(1f).height(d.dp(7f)))
        Text((if (snr == null || snr < -50) "-" else "%.1f dB SNR".format(java.util.Locale.US, snr)) +
            (if (sb != null && ref != null) " · %.0f dB over noise".format(java.util.Locale.US, sb - ref) else ""),
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
    }
}

/** NOW PLAYING: art, song, audio state and level, program tiles, then the STATION and SIGNAL cards and recent songs. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdHero(m: HdSnap?, now: Long, tuned: Long, call: String, rec: HdStationRec?, sel: ProgramRow?, here: List<HdObj>, objs: List<HdObj>, lock: String, accent: Color,
                   home: Pair<Double, Double>?, surround: Boolean?, onSurround: () -> Unit, onProg: (Int) -> Unit) {
    val d = rememberDims()
    val st = m?.station
    val progs = st?.programs ?: emptyList()
    val n = sel?.n ?: 0
    val art = hdArt(sel, tuned, here, objs, rec)
    val logo = hdLogo(tuned, n, objs, rec)
    val name = call.ifEmpty { hdMhz(tuned) }
    val (aText, aTone) = if (sel != null) hdAudioText(m, n) else "ANALOG FM" to null
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val boxW = maxWidth
        val narrow = boxW < 520.dp
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            // the hero: art beside the song, or above it on a phone
            val shape = RoundedCornerShape(d.dp(16f))
            Box(Modifier.fillMaxWidth().clip(shape).background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel))).border(1.dp, accent.copy(alpha = 0.35f), shape)) {
                if (art != null && art.second) HdBackdrop(art.first, Modifier.matchParentSize())
                Box(Modifier.matchParentSize().background(Brush.horizontalGradient(0.3f to Color.Transparent, 1f to Palette.paper.copy(alpha = 0.55f))))
                val artBox: @Composable (Modifier) -> Unit = { mod ->
                    val ash = RoundedCornerShape(d.dp(12f))
                    Box(mod.aspectRatio(1f).clip(ash).background(if (art != null && !art.second) Color.White else Palette.surface).border(1.dp, Palette.ink.copy(alpha = 0.12f), ash), contentAlignment = Alignment.Center) {
                        if (art != null) HdPicture(art.first, Modifier.fillMaxSize().padding(if (art.second) 0.dp else d.dp(14f)), crop = art.second)
                        else Column(Modifier.fillMaxSize().background(Brush.radialGradient(listOf(accent.copy(alpha = 0.3f), Color.Transparent))), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                            AppGlyph(MayhemApp.HD, accent, Modifier.size(d.dp(54f)))
                            Text(name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), letterSpacing = 2.sp, maxLines = 2, modifier = Modifier.padding(horizontal = d.dp(6f)))
                        }
                        Text("HD${n + 1}", color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), letterSpacing = 1.5.sp,
                            modifier = Modifier.align(Alignment.TopStart).padding(d.dp(8f)).background(accent, RoundedCornerShape(6.dp)).padding(horizontal = d.dp(7f), vertical = d.dp(3f)))
                    }
                }
                val meta: @Composable (Modifier) -> Unit = { mod ->
                    Column(mod, verticalArrangement = Arrangement.spacedBy(d.dp(6f), Alignment.CenterVertically)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                            if (logo != null) Box(Modifier.size(d.dp(42f)).clip(RoundedCornerShape(d.dp(8f))).background(Color.White)) { HdPicture(logo, Modifier.fillMaxSize()) }
                            Column {
                                Text(name, color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(16f), letterSpacing = 3.sp, maxLines = 2)
                                val typeName = sel?.typeName?.ifEmpty { null } ?: rec?.programs?.firstOrNull { it.n == n }?.typeName?.ifEmpty { null }
                                Text("${hdMhz(tuned)} MHz${typeName?.let { " · $it" } ?: ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp)
                            }
                        }
                        val waiting = if (st == null || st.frames == 0) (if (lock == "ANALOG ONLY") "No digital sidebands on this station: the analog audio plays" else "Waiting for the digital side") else "Waiting for this program's song data"
                        val title = sel?.title.orEmpty()
                        Text(title.ifEmpty { waiting }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.ExtraBold,
                            fontSize = d.sp(if (narrow) 20f else if (d.wide) 24f else 22f), lineHeight = d.sp(if (narrow) 23f else 27f),
                            style = TextStyle(shadow = Shadow(Color.Black.copy(alpha = 0.5f), blurRadius = 14f)))
                        if (!sel?.artist.isNullOrEmpty()) Text(sel.artist, color = Palette.ink.copy(alpha = 0.88f), fontFamily = Mono, fontSize = d.sp(16f))
                        // TCON is left out: stations send their brand in it rather than a genre
                        val album = sel?.album.orEmpty()
                        if (album.isNotEmpty()) Text(album, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                            HdMode(aText, aTone)
                            HdQuality(st)
                            if (surround != null) ToggleBox("5.1 SURROUND", surround, accent) { onSurround() }
                        }
                        HdVu(Modifier.fillMaxWidth())
                    }
                }
                if (narrow) Column(Modifier.fillMaxWidth().padding(d.dp(12f)), verticalArrangement = Arrangement.spacedBy(d.dp(12f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    artBox(Modifier.fillMaxWidth().widthIn(max = d.dp(320f)))
                    meta(Modifier.fillMaxWidth())
                } else Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(d.dp(14f)), horizontalArrangement = Arrangement.spacedBy(d.dp(18f))) {
                    artBox(Modifier.width(minOf(d.dp(if (d.wide) 320f else 240f), boxW * 0.38f)))
                    meta(Modifier.weight(1f).fillMaxHeight())
                }
            }
            // a tile per program, with its own art or logo
            if (progs.isNotEmpty()) {
                val gap = d.dp(if (narrow) 6f else 8f)
                val cols = if (narrow) 2 else max(1, ((boxW + gap) / (d.dp(190f) + gap)).toInt())
                Column(verticalArrangement = Arrangement.spacedBy(gap)) {
                    for (row in progs.chunked(cols)) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(gap)) {
                        for (p in row) HdProgTile(p, p.n == sel?.n, now, m, hdArt(p, tuned, here, objs, rec), narrow, accent, Modifier.weight(1f).fillMaxHeight()) { onProg(p.n) }
                        repeat(cols - row.size) { Box(Modifier.weight(1f)) }
                    }
                }
            }
            val s = st?.takeIf { it.frames > 0 }?.sis
            val f = if (s != null) listOf("CALL SIGN" to s.callsign, "NAME" to s.longName, "SLOGAN" to s.slogan, "MESSAGE" to s.message, "FACILITY" to (if (s.facility >= 0) "${s.country} ${s.facility}" else ""),
                "TRANSMITTER" to (if (s.lat != null) hdLocText(s, home) else ""), "CLOCK" to (if (s.alfnMs != 0L) hdClockText(s) else ""), "DATA" to (if (s.data.isNotEmpty()) hdDataSvcText(s) else ""))
            else if (rec != null) listOf("CALL SIGN" to rec.call, "NAME" to rec.longName, "SLOGAN" to rec.slogan, "MESSAGE" to rec.message,
                "FACILITY" to (if (rec.facility >= 0) "${rec.country} ${rec.facility}" else ""), "DATA" to rec.data.joinToString(", "))
            else emptyList()
            val rows = f.filter { it.second.isNotEmpty() }
            if (rows.isNotEmpty()) HdCard("STATION", accent) { SelectionContainer { FieldGrid(rows, labelWidth = if (narrow) 80f else 92f, minColumn = 240f) } }
            val det = m?.det
            HdCard("SIGNAL", accent) {
                HdSideband("LOWER", st?.takeIf { it.frames > 0 }?.snrLoDb, det?.sbLoDb, det?.refDb)
                HdSideband("UPPER", st?.takeIf { it.frames > 0 }?.snrHiDb, det?.sbHiDb, det?.refDb)
                HdKv(listOfNotNull("LOCK" to lock,
                    if (st != null && st.frames > 0) "RAW BER" to "%.2f%%".format(java.util.Locale.US, st.ber * 100) else null,
                    if (st != null && st.frames > 0) "PCI" to st.pciName else null,
                    if (m != null) "CARRIER" to "%+.0f Hz".format(java.util.Locale.US, m.rx.cfoHz) else null,
                    if (st != null && st.blend >= 0) "BLEND" to HdSis.BLEND_NAMES[st.blend].uppercase() else null,
                    "AUDIO" to (if (sel != null) "HD${sel.n + 1} $aText" else "ANALOG FM")))
                if (st != null && st.frames > 0) HdFrames(st)
            }
            if (sel != null && sel.songs.size > 1) HdCard("EARLIER ON HD${sel.n + 1}", accent) {
                for (song in sel.songs.drop(1).take(7)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text(hdClock(song.ms), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
                    Text("${song.title}${if (song.artist.isNotEmpty()) " · ${song.artist}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** One program's tile: its picture, number, type, song and, when it is the one playing, what its audio is doing. */
@Composable
private fun HdProgTile(p: ProgramRow, on: Boolean, now: Long, m: HdSnap?, pic: Pair<Bitmap, Boolean>?, narrow: Boolean, accent: Color, modifier: Modifier, onTap: () -> Unit) {
    val d = rememberDims()
    val liveP = p.lastMs > 0 && now - p.lastMs < 10_000
    val ps = RoundedCornerShape(d.dp(12f))
    val thumb: @Composable (Modifier) -> Unit = { mod ->
        Box(mod.clip(RoundedCornerShape(d.dp(8f))).background(if (pic != null && !pic.second) Color.White else Palette.panel).border(1.dp, Palette.line, RoundedCornerShape(d.dp(8f))), contentAlignment = Alignment.Center) {
            if (pic != null) HdPicture(pic.first, Modifier.fillMaxSize().padding(if (pic.second) 0.dp else d.dp(4f)), crop = pic.second)
            else Text("HD${p.n + 1}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), letterSpacing = 1.sp)
        }
    }
    val text: @Composable (Modifier) -> Unit = { mod ->
        Column(mod, verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(7f))) {
                Text("HD${p.n + 1}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), letterSpacing = 1.5.sp)
                if (liveP) Box(Modifier.size(d.dp(7f)).background(Palette.ok, CircleShape))
            }
            Text(p.typeName.ifEmpty { "program" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
            Text(if (p.title.isNotEmpty()) "${p.title}${if (p.artist.isNotEmpty()) " · ${p.artist}" else ""}" else if (p.lastMs > 0) "on air" else "listed in SIS",
                color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(13f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (on) { val (at, ac) = hdAudioText(m, p.n); Box(Modifier.padding(top = d.dp(3f))) { HdPill(at, ac ?: Palette.muted) } }
        }
    }
    val base = modifier.clip(ps).background(if (on) accent.copy(alpha = 0.13f) else Palette.surface).border(if (on) 2.dp else 1.dp, if (on) accent else Palette.line, ps).clickable { onTap() }.padding(d.dp(7f))
    if (narrow) Column(base, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { thumb(Modifier.fillMaxWidth().aspectRatio(2.2f)); text(Modifier.fillMaxWidth()) }
    else Row(base, horizontalArrangement = Arrangement.spacedBy(d.dp(9f))) { thumb(Modifier.size(d.dp(54f))); text(Modifier.weight(1f)) }
}

/** The last frames, each as its raw BER (bar height) and the FCS results of the packets it carried (red: a failure). */
@Composable
private fun HdFrames(st: StationSnap) {
    val d = rememberDims()
    val h = st.history.takeLast(30); val last = h.lastOrNull() ?: return
    val ok = Palette.ok; val weak = Palette.accent2; val bad = Palette.danger
    Canvas(Modifier.fillMaxWidth().height(d.dp(22f))) {
        val w = minOf(size.width / 30f, 8.dp.toPx() + 2.dp.toPx())
        h.forEachIndexed { i, f ->
            val v = (f.ber * 10).coerceIn(0.08, 1.0).toFloat()
            drawRoundRect(if (f.fcsBad > 0) bad else if (f.ber >= 0.05) weak else ok, topLeft = androidx.compose.ui.geometry.Offset(i * w, size.height * (1 - v)),
                size = Size(w - 2.dp.toPx(), size.height * v), cornerRadius = CornerRadius(1.dp.toPx()), alpha = 0.8f)
        }
    }
    HdKv(listOf("LAST FRAME" to "BER %.2f%% · FCS ${last.fcsGood} good".format(java.util.Locale.US, last.ber * 100) + (if (last.fcsBad > 0) " · ${last.fcsBad} failed" else ""),
        "FRAMES" to "${st.framesGood} of ${st.frames} with a clean PCI"))
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
                if (r.lat != null && r.lon != null) "TX" to "%.4f, %.4f".format(java.util.Locale.US, r.lat, r.lon) + (r.altM?.let { " · ${Units.fmtAlt(it.toDouble())}" } ?: "") else null,
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

/** A checkerboard under a picture, so see-through parts show as such. */
private fun Modifier.hdChecker(): Modifier = drawBehind {
    val c = 6.dp.toPx(); val a = Color(0xFF2A3348); val b = Color(0xFF1A2130)
    drawRect(b)
    var y = 0f; var r = 0
    while (y < size.height) { var x = if (r % 2 == 0) 0f else c; while (x < size.width) { drawRect(a, Offset(x, y), Size(c, c)); x += 2 * c }; y += c; r++ }
}

/** DATA: a gallery of the station's pictures by kind, the other files, then TECH folded away. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HdData(m: HdSnap?, all: List<HdObj>, now: Long, sel: String?, accent: Color, home: Pair<Double, Double>?, kind: String, tech: Boolean,
                   onKind: (String) -> Unit, onTech: () -> Unit, onSel: (String) -> Unit, onSave: (HdObj) -> Unit, modifier: Modifier) {
    val d = rememberDims()
    val st = m?.station
    val counts = all.groupingBy { hdGroup(it) }.eachCount()
    val k = if (kind != "all" && (counts[kind] ?: 0) == 0) "all" else kind
    val objs = if (k == "all") all else all.filter { hdGroup(it) == k }
    val imgs = objs.filter { it.mime.startsWith("image/") }; val files = objs.filter { !it.mime.startsWith("image/") }
    val sections = hdTech(st, home, accent)
    BoxWithConstraints(modifier) {
        val gap = d.dp(8f)
        val cols = max(1, ((maxWidth + gap) / (d.dp(112f) + gap)).toInt())
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
            if (all.isNotEmpty()) item(key = "kinds") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                    for (g in listOf("all") + HD_GROUPS.map { it.first }.filter { (counts[it] ?: 0) > 0 }) {
                        val on = k == g; val sh = RoundedCornerShape(50)
                        Row(Modifier.clip(sh).background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, sh).clickable { onKind(g) }
                            .padding(horizontal = d.dp(10f), vertical = d.dp(5f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                            Text(if (g == "all") "ALL" else HD_GROUPS.first { it.first == g }.second, color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
                            Text("${if (g == "all") all.size else counts[g]}", color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
                        }
                    }
                }
            }
            if (all.isEmpty()) item(key = "none") { HdDim("no files yet · logos and album art take a minute or two to come in whole") }
            items(imgs.chunked(cols), key = { r -> "g:" + r.first().key }) { r ->
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (o in r) {
                        val on = sel == o.key; val sh = RoundedCornerShape(d.dp(10f))
                        Column(Modifier.weight(1f).fillMaxHeight().clip(sh).background(Palette.surface).border(if (on) 2.dp else 1.dp, if (on) accent else Palette.line, sh).clickable { onSel(o.key) }.padding(d.dp(5f)),
                            verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                            Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(d.dp(6f))).hdChecker(), contentAlignment = Alignment.Center) {
                                val b = hdObjBitmap(o)
                                if (b != null) HdPicture(b, Modifier.fillMaxSize(), crop = o.kind == "art")
                                else Text(o.mime.substringAfter('/').uppercase(), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
                            }
                            Text(HD_KIND[o.kind] ?: o.kind, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.padding(top = d.dp(2f)))
                            Text("${if (o.program >= 0) "HD${o.program + 1} · " else ""}${hdSize(o.size)} · ${hdAgo(now - o.ms)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
                        }
                    }
                    repeat(cols - r.size) { Box(Modifier.weight(1f)) }
                }
            }
            items(files, key = { it.key }) { o ->
                Row(Modifier.fillMaxWidth().panel(if (sel == o.key) accent else Palette.line).clickable { onSel(o.key) }.padding(horizontal = d.dp(8f), vertical = d.dp(5f)),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Box(Modifier.size(d.dp(40f)).clip(RoundedCornerShape(d.dp(6f))).background(Palette.panel), contentAlignment = Alignment.Center) {
                        Text(if (o.mime.startsWith("text/")) "TXT" else "BIN", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
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
            if (sections.isNotEmpty()) {
                item(key = "techbtn") {
                    val sh = RoundedCornerShape(d.dp(10f))
                    Row(Modifier.fillMaxWidth().clip(sh).background(Palette.surface).border(1.dp, if (tech) accent else Palette.line, sh).clickable { onTech() }.padding(horizontal = d.dp(12f), vertical = d.dp(9f)),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                        Text("TECH", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
                        Text("${sections.size} sections · SIS, ports, service directory", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f))
                        Text(if (tech) "▾" else "▸", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
                    }
                }
                if (tech) for ((i, sec) in sections.withIndex()) item(key = "tech$i") { sec() }
            }
            item(key = "note") { AppNote(HD_NOTE) }
        }
    }
}

/** A row of the TECH lists: a bold name, a line, and smaller detail lines. */
@Composable
private fun HdSvc(name: String, line: String, detail: List<String>) {
    val d = rememberDims()
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
        Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
            if (line.isNotEmpty()) Text(line, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f, fill = false))
        }
        if (detail.isNotEmpty()) Text(detail.joinToString("\n"), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f))
    }
}

/** TECH's sections, each only when it has something: SIS, PSD, the service directory, ports, found inside, not decoded. */
private fun hdTech(st: StationSnap?, home: Pair<Double, Double>?, accent: Color): List<@Composable () -> Unit> {
    if (st == null) return emptyList()
    val out = ArrayList<@Composable () -> Unit>()
    if (st.frames > 0) {
        val s = st.sis
        val leap = s.leap
        val f = listOf(
            "CALL SIGN" to (if (s.callsign.isNotEmpty()) "${s.callsign} (${s.nameVotes.first} of ${s.nameVotes.second} votes)" else "-"),
            "LONG NAME" to s.longName.ifEmpty { "-" }, "UNIVERSAL NAME" to s.universal.ifEmpty { "-" }, "SLOGAN" to s.slogan.ifEmpty { "-" },
            "MESSAGE" to (if (s.message.isNotEmpty()) s.message + (if (s.messagePriority) " (priority)" else "") + (if (s.messageChecksumOk) "" else " (checksum not verified yet)") else "-"),
            "FACILITY" to (if (s.facility >= 0) "${s.country} ${s.facility}" else "-"),
            "TRANSMITTER" to hdLocText(s, home), "STATION CLOCK" to hdClockText(s), "TIME ZONE HINT" to hdTzText(s),
            "LEAP SECONDS" to (if (leap != null) "${leap.current} s now${if (leap.pendingAlfn != 0L && leap.pending != leap.current) " · ${leap.pending} s from ALFN ${leap.pendingAlfn}" else ""} (the clock uses 18 s)"
                else s.params[0]?.let { "${it and 255} s as sent (the clock uses 18 s)" } ?: "-"),
            "EMERGENCY ALERTS" to hdAlertText(s), "EXCITER" to hdDeviceText(s.exciter), "IMPORTER" to hdDeviceText(s.importer),
            "AUDIO SERVICES" to s.audio.joinToString(" · ") { "HD${it.program + 1} ${HdSis.programTypeName(it.type)}${if (it.access != 0) " (restricted)" else ""}${if (it.soundExp != 0) " · sound ${it.soundExp}" else ""}" }.ifEmpty { "-" },
            "DATA SERVICES" to s.data.joinToString(" · ") { "${HdSis.dataTypeName(it.type)} (${it.mimeName.ifEmpty { "MIME ${it.mime12}" }})" }.ifEmpty { "-" },
            "FIXED BEARER" to (st.ccc?.subs?.joinToString(" + ") { "${it.length} B/frame" } ?: "-"),
            "PACKETS" to "${st.hdlcGood} good · ${st.hdlcBad} failed FCS",
            "SIS PDUS" to "${s.pdus} · CRC verified ${s.crcGood} (${if (s.pdus > 0) (100.0 * s.crcGood / s.pdus).roundToInt() else 0}%)${if (s.llds > 0) " · ${s.llds} low latency data" else ""}")
        out.add { HdSection("STATION INFORMATION (SIS, CRC checked)", accent) { SelectionContainer { FieldGrid(f, labelWidth = 120f, minColumn = 320f) } } }
    }
    val withId3 = st.programs.filter { it.id3.isNotEmpty() }
    if (withId3.isNotEmpty()) out.add {
        HdSection("PROGRAM DATA (ID3)", accent) {
            for (p in withId3) {
                val c = p.commercial
                HdSvc("HD${p.n + 1}", "${p.psdFrames} tags · ${p.psdBad} failed FCS${if (p.psdOther > 0) " · ${p.psdOther} not ID3" else ""}",
                    p.id3.map { "${it.id}${if (it.desc.isNotEmpty()) " [${it.desc}]" else ""} ${it.text.ifEmpty { it.hex }}" } +
                        listOfNotNull(c?.let { "COMMERCIAL " + listOf(it.price, it.seller, it.description, it.url, it.validUntil).filter { x -> x.isNotEmpty() }.joinToString(" · ") },
                            p.ufid?.let { "UFID ${it.owner} ${it.id}" }))
            }
        }
    }
    if (st.sig.isNotEmpty()) out.add {
        HdSection("SERVICE DIRECTORY (format derived from recordings)", accent) {
            for (s in st.sig) HdSvc(s.name.ifEmpty { if (s.kind == "audio") "HD${s.program + 1}" else "data" },
                if (s.kind == "audio") "HD${s.program + 1} · ${HdSis.programTypeName(s.progType)}" else "data service ${s.id}",
                s.components.map { c -> "port ${hdHex(c.port)} · ${c.mimeName.ifEmpty { "MIME ${c.mimeHex}" }} · ${c.aasTypeName} · ${HdSis.dataTypeName(c.dataType)}" } +
                    s.extra.filter { it.text.isNotEmpty() }.map { "tag ${hdHex(it.tag, 2)} · ${it.text}" })
        }
    }
    if (st.ports.isNotEmpty()) out.add {
        val d = rememberDims()
        val pinfo = st.portInfo.associateBy { it.port }
        val now = System.currentTimeMillis()
        HdSection("PORTS", accent) {
            val cols = listOf(0.12f, 0.24f, 0.30f, 0.10f, 0.11f, 0.13f)
            @Composable
            fun row(cells: List<String>, head: Boolean) = Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                cells.forEachIndexed { i, c -> Text(c, color = if (head) Palette.muted else Palette.ink, fontFamily = Mono, fontWeight = if (head) FontWeight.Bold else FontWeight.Normal,
                    fontSize = d.sp(if (head) 8f else 9f), maxLines = if (i == 2) 3 else 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(cols[i])) }
            }
            row(listOf("PORT", "WHAT", "CONTENT", "PACKETS", "BYTES", "LAST"), true)
            for (p in st.ports) {
                val i = pinfo[p.port]
                row(listOf(hdHex(p.port), listOf(p.kind, p.name).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { p.bearer },
                    if (i != null) "${i.content}${if ((i.tpeg?.frames ?: 0) > 0) " · ${i.tpeg!!.frames} frames" else ""} · ${hdNum(i.entropy)} bits/B · ${i.minLen}..${i.maxLen} B" else "-",
                    "${p.packets}", hdSize(p.bytes), hdAgo(now - p.lastMs)), false)
            }
        }
    }
    if (st.findings.isNotEmpty()) out.add {
        HdSection("FOUND INSIDE (not announced)", accent) {
            for (f in st.findings) HdSvc(f.type, "${f.where} · @${f.offset} · ${hdSize(f.length)}${if (f.width != null && f.width != 0) " · ${f.width}×${f.height}" else ""}", listOf(f.note))
        }
    }
    if (st.unknowns.isNotEmpty()) out.add {
        HdSection("NOT DECODED", accent) { for (u in st.unknowns) HdSvc(u.where, "", listOf(u.what)) }
    }
    return out
}

@Composable
private fun HdSection(title: String, accent: Color, content: @Composable () -> Unit) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
        content()
    }
}

/** The selected file: the picture, the text or a hex dump, and every field, with what the station's view adds. */
@Composable
private fun HdDetail(o: HdObj, row: ObjectRow?, now: Long, accent: Color, modifier: Modifier, onSave: () -> Unit, onClose: () -> Unit) {
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
        val img = o.mime.startsWith("image/")
        val b = hdObjBitmap(o)
        if (b != null) Box(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(d.dp(8f))).padding(d.dp(6f)), contentAlignment = Alignment.Center) {
            HdPicture(b, Modifier.fillMaxWidth().heightIn(max = d.dp(260f)))
        }
        val text = if (hdIsText(o.mime)) String(o.bytes, Charsets.ISO_8859_1) else if (!img) hdHexDump(o.bytes) else ""
        if (text.isNotEmpty()) SelectionContainer {
            Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(d.dp(8f))).padding(d.dp(8f)))
        }
        val f = mutableListOf("NAME" to o.name.ifEmpty { "-" }, "KIND" to (HD_KIND[o.kind] ?: o.kind), "PORT" to hdHex(o.port), "OBJECT ID" to hdHex(o.id), "SIZE" to "${o.size} bytes", "TYPE" to o.mime,
            "PROGRAM" to (if (o.program >= 0) "HD${o.program + 1}" else "-"), "STATION" to "${hdMhz(o.hz)} MHz", "RECEIVED" to "${hdClock(o.ms)} · ${hdAgo(now - o.ms)}")
        if (row != null) {
            if ((row.width ?: 0) != 0) f.add("PICTURE" to "${row.width} × ${row.height}")
            if (row.mimeHash != 0L) f.add("MIME HASH" to "%08x".format(row.mimeHash) + (if (row.mimeName.isNotEmpty()) " · ${row.mimeName}" else ""))
            if (row.expires.isNotEmpty()) f.add("EXPIRES" to "${row.expires} UTC")
            if (row.from.isNotEmpty()) f.add("FOUND" to row.from)
            if (row.chunks.isNotEmpty()) f.add("SEGMENTS" to row.chunks.joinToString(" · "))
            for (t in row.text) f.add(t.key.uppercase() to t.value)
            if (row.trailing > 0) f.add("AFTER THE END" to "${row.trailing} bytes past the end marker")
            for (e in row.embedded) f.add("INSIDE" to "${e.type} at byte ${e.offset}, ${e.length} bytes${if (e.complete) "" else ", cut short"}")
        }
        SelectionContainer { FieldGrid(f, labelWidth = 96f, minColumn = 300f) }
    }
}
