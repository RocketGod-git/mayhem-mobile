package com.rocketgod.mayhem.core.hd

import android.content.Context
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.SdrEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/** What one program of a remembered station played last. */
class HdProgRec(val n: Int, val type: Int, val typeName: String, val title: String, val artist: String)

/** A station heard, kept for good: what its SIS said, its programs and the data services it offers, its logos. */
class HdStationRec(
    val hz: Long, val call: String, val slogan: String, val longName: String, val message: String, val facility: Int, val country: String,
    val lat: Double?, val lon: Double?, val altM: Int?, val programs: List<HdProgRec>, val data: List<String>,
    val firstMs: Long, val lastMs: Long, val frames: Int,
    /** Logo bytes by program ("0" the station's own). */
    val logos: Map<String, ByteArray>,
)

/** A finished object kept for this session. */
class HdObj(val key: String, val hz: Long, val port: Int, val id: Int, val name: String, val size: Int, val mime: String, val kind: String, val program: Int, val ms: Long, val bytes: ByteArray)

/**
 * The HD Radio app's state around its processor: the stations heard (kept across runs), the objects of this session,
 * the traffic map and radar descriptions (kept), and AUTO, which steps across the FM band, finds the hybrid
 * channels in each window and dwells on each long enough to fill it in. The radio stays on WFM, so the analog audio
 * of the tuned station plays underneath.
 */
object HdApp {
    val log = PacketLog()
    val proc = HdProcessor(log)
    const val RATE = SdrEngine.RX_RATE
    /** Station center within this of the span center keeps the radio where it is; the HD sidebands reach 200 kHz out. */
    const val REACH = RATE / 2 - 260_000
    /** AUTO's windows over the FM band, each heard from its middle. */
    val WINDOWS: List<Long> = run {
        val out = ArrayList<Long>(); var c = 88_000_000L + REACH
        while (c - REACH < 108_000_000L) { out.add((c / 100_000.0).roundToLong() * 100_000); c += 2 * REACH - 100_000 }
        out
    }

    private val _stations = MutableStateFlow<Map<Long, HdStationRec>>(emptyMap())
    val stations: StateFlow<Map<Long, HdStationRec>> = _stations.asStateFlow()
    private val _objects = MutableStateFlow<List<HdObj>>(emptyList())
    val objects: StateFlow<List<HdObj>> = _objects.asStateFlow()
    /** Map and radar descriptions by map / area id, as their text. */
    private val _maps = MutableStateFlow<Pair<Map<String, String>, Map<String, String>>>(emptyMap<String, String>() to emptyMap())
    val maps: StateFlow<Pair<Map<String, String>, Map<String, String>>> = _maps.asStateFlow()
    fun traffic(): Map<String, HdLot.TrafficInfo> = _maps.value.first.mapNotNull { (k, v) -> HdLot.parseTrafficInfo(v)?.let { k to it } }.toMap()
    fun radar(): Map<String, HdLot.RadarInfo> = _maps.value.second.mapNotNull { (k, v) -> HdLot.parseRadarInfo(v)?.let { k to it } }.toMap()

    class Scan(val auto: Boolean = false, val win: Int = 0, val phase: String = "survey", val until: Long = 0, val queue: List<Long> = emptyList(), val locked: Long = 0, val cur: Long = 0)
    private val _scan = MutableStateFlow(Scan())
    val scan: StateFlow<Scan> = _scan.asStateFlow()

    private var file: File? = null
    private var objSeq = 0
    @Volatile private var saveAt = 0L

    fun key(hz: Long): Long = (hz / 100_000.0).roundToLong() * 100_000
    /** The tuned station: the radio's LO plus where the channel sits in the span. */
    fun tunedHz(): Long = SdrEngine.channelHz()
    /** A snapshot that is about the station tuned now. */
    fun mine(s: HdSnap?): HdSnap? = s?.takeIf { abs(it.hz - tunedHz()) < 2_000 }

    fun init(ctx: Context) {
        val f = File(ctx.filesDir, "hd_stations.json"); file = f
        runCatching { if (f.exists()) load(JSONObject(f.readText())) }.onFailure { com.rocketgod.mayhem.Diag.log("HD: stations not read: ${it.message}") }
        proc.onSnap = { record(it) }
        proc.onObject = { onObject(it) }
    }

    fun start() {
        proc.centerOf = { SdrEngine.freqHz.value }
        proc.offsetOf = { SdrEngine.offsetHz.value }
        val known = _stations.value.values.maxByOrNull { it.lastMs }
        val dial = SdrEngine.channelHz().takeIf { it in 87_900_000L..107_900_000L }
        val f = dial ?: known?.hz ?: WINDOWS[0]
        SdrEngine.configure(SdrEngine.Mode.WFM, f, RATE, 24, 24, false, proc)
        _scan.value = Scan()
        if (dial == null && known == null) setAuto(true)
    }

    /** Tune a station: the channel moves inside the span; the radio follows only when the sidebands would leave it. */
    fun tune(hz: Long, recenter: Boolean = false) {
        val f = (hz.coerceIn(87_900_000L, 107_900_000L) / 100_000.0).roundToLong() * 100_000
        val lo = SdrEngine.freqHz.value
        if (recenter || abs(f - lo) > REACH) { SdrEngine.tuneLo(f); SdrEngine.setOffset(0) }
        else SdrEngine.setOffset((f - lo).toInt())
    }
    /** A tune by hand stops AUTO. */
    fun pick(hz: Long) { if (_scan.value.auto) setAuto(false); tune(hz) }

    fun setAuto(on: Boolean) {
        if (!on) { _scan.value = Scan(); return }
        val now = System.currentTimeMillis()
        val w = max(0, WINDOWS.indexOfFirst { abs(it - tunedHz()) <= REACH })
        survey(w, now)
    }
    private fun survey(w: Int, now: Long) {
        val c = WINDOWS[w % WINDOWS.size]
        _scan.value = Scan(true, w % WINDOWS.size, "survey", now + 2_600, emptyList(), 0, c)
        tune(c, recenter = true)
    }
    private fun nextCandidate(s: Scan, queue: List<Long>, now: Long) {
        val next = queue.firstOrNull()
        if (next == null) { survey(s.win + 1, now); return }
        _scan.value = Scan(true, s.win, "dwell", now + 6_000, queue.drop(1), 0, next)
        tune(next)
    }
    /** AUTO, every half second while the screen is up: look at a window's spectrum for hybrid channels, then dwell on
     *  each long enough to fill it in. */
    fun scanTick(now: Long) {
        var s = _scan.value
        if (!s.auto) return
        val m = proc.snap.value
        if (s.phase == "survey") {
            if (now >= s.until) {
                val lo = SdrEngine.freqHz.value
                val q = (if (m != null && abs(m.centerHz - lo) < 5_000) m.cands else emptyList()).filter { abs(it.hz - lo) <= REACH }.sortedByDescending { it.scoreDb }.map { it.hz }
                if (q.isEmpty()) survey(s.win + 1, now) else nextCandidate(s, q, now)
            }
        } else {
            val st = m?.takeIf { abs(it.hz - s.cur) < 2_000 }
            val digital = st != null && (st.station.frames > 0 || st.rx.state == "sync" || st.rx.state == "frames")
            if (digital && s.locked == 0L) { s = Scan(true, s.win, s.phase, now + 45_000, s.queue, now, s.cur); _scan.value = s }
            val filled = st != null && st.station.sis.callsign.isNotEmpty() && now - s.locked > 20_000 && st.station.programs.all { it.title.isNotEmpty() || it.lastMs == 0L }
            if (now >= s.until || (s.locked != 0L && filled)) nextCandidate(s, s.queue, now)
        }
    }
    /** Step to the next or previous station already heard. */
    fun step(dir: Int) {
        val list = _stations.value.keys.sorted()
        val cur = tunedHz()
        if (list.isEmpty()) { tune(cur + dir * 200_000L); return }
        val next = if (dir > 0) list.firstOrNull { it > cur + 50_000 } ?: list.first() else list.lastOrNull { it < cur - 50_000 } ?: list.last()
        setAuto(false); tune(next)
    }

    /** What one snapshot adds to the station's record (kept once the digital side has decoded). */
    private fun record(m: HdSnap) {
        val st = m.station; val sis = st.sis; val hz = key(m.hz)
        if (st.frames == 0) return
        val now = System.currentTimeMillis()
        val r = _stations.value[hz]
        val programs = (r?.programs ?: emptyList()).associateBy { it.n }.toMutableMap()
        for (p in st.programs) {
            val old = programs[p.n]
            programs[p.n] = HdProgRec(p.n, if (p.type >= 0) p.type else old?.type ?: p.type, if (p.type >= 0) p.typeName else old?.typeName ?: p.typeName,
                if (p.title.isNotEmpty()) p.title else old?.title ?: "", if (p.title.isNotEmpty()) p.artist else old?.artist ?: "")
        }
        val data = (st.sig.filter { it.kind == "data" && it.name.isNotEmpty() }.map { it.name } + sis.data.map { HdSis.dataTypeName(it.type) }).distinct()
        val pos = sis.lat != null && sis.lon != null && abs(sis.lat) <= 90 && abs(sis.lon) <= 180
        val rec = HdStationRec(
            hz, if (sis.callsign.isNotEmpty() && sis.nameVotes.first >= 3) sis.callsign else r?.call ?: "",
            sis.slogan.ifEmpty { r?.slogan ?: "" }, sis.longName.ifEmpty { r?.longName ?: "" }, sis.message.ifEmpty { r?.message ?: "" },
            if (sis.facility >= 0) sis.facility else r?.facility ?: -1, if (sis.facility >= 0) sis.country else r?.country ?: "",
            if (pos) sis.lat else r?.lat, if (pos) sis.lon else r?.lon, if (pos) sis.altM else r?.altM,
            programs.values.sortedBy { it.n }, data.ifEmpty { r?.data ?: emptyList() }, r?.firstMs ?: now, now, max(r?.frames ?: 0, st.frames), r?.logos ?: emptyMap(),
        )
        _stations.value = _stations.value + (hz to rec)
        save()
    }

    /** A finished object: kept for this session; logos, map and radar descriptions kept for good. */
    private fun onObject(m: HdObjMsg) {
        val o = m.obj.o; val hz = key(m.hz); val kind = m.obj.kind
        if (_objects.value.any { it.hz == hz && it.port == o.port && it.name == o.name && it.size == o.size }) return
        val obj = HdObj("o${++objSeq}", hz, o.port, o.id, o.name, o.size, o.mime, kind, m.obj.program, o.ms, o.bytes)
        _objects.value = (listOf(obj) + _objects.value).take(160)
        val text = { String(o.bytes, Charsets.ISO_8859_1) }
        when (kind) {
            "traffic-info" -> HdLot.parseTrafficInfo(text())?.let { t -> _maps.value = (_maps.value.first + (t.map to text())) to _maps.value.second; save() }
            "radar-info" -> HdLot.parseRadarInfo(text())?.let { r -> _maps.value = _maps.value.first to (_maps.value.second + (r.area to text())); save() }
            "logo" -> if (o.bytes.size < 60_000) _stations.value[hz]?.let { rec ->
                _stations.value = _stations.value + (hz to HdStationRec(rec.hz, rec.call, rec.slogan, rec.longName, rec.message, rec.facility, rec.country, rec.lat, rec.lon, rec.altM,
                    rec.programs, rec.data, rec.firstMs, rec.lastMs, rec.frames, rec.logos + (max(0, m.obj.program).toString() to o.bytes)))
                save()
            }
        }
    }

    /** The objects of [hz]'s station. */
    fun objectsOf(hz: Long = tunedHz(), all: List<HdObj> = _objects.value): List<HdObj> { val k = key(hz); return all.filter { it.hz == k } }

    fun clear() {
        proc.clear(); log.clear(); _objects.value = emptyList()
    }

    // ---- persistence ----
    private fun save() {
        val f = file ?: return
        val due = System.currentTimeMillis() + 800
        if (saveAt > 0) { saveAt = due; return }
        saveAt = due
        kotlin.concurrent.thread(isDaemon = true, name = "hd-save") {
            while (System.currentTimeMillis() < saveAt) Thread.sleep(100)
            saveAt = 0
            runCatching { val tmp = File(f.path + ".tmp"); tmp.writeText(toJson(true).toString()); tmp.renameTo(f) || run { f.writeText(tmp.readText()); tmp.delete() } }
        }
    }

    private val b64e = java.util.Base64.getEncoder(); private val b64d = java.util.Base64.getDecoder()
    fun stationJson(r: HdStationRec, logos: Boolean): JSONObject = JSONObject().apply {
        put("hz", r.hz); put("call", r.call); put("slogan", r.slogan); put("longName", r.longName); put("message", r.message); put("facility", r.facility); put("country", r.country)
        put("lat", r.lat ?: JSONObject.NULL); put("lon", r.lon ?: JSONObject.NULL); put("altM", r.altM ?: JSONObject.NULL)
        put("programs", JSONArray(r.programs.map { JSONObject().put("n", it.n).put("type", it.type).put("typeName", it.typeName).put("title", it.title).put("artist", it.artist) }))
        put("data", JSONArray(r.data)); put("firstMs", r.firstMs); put("lastMs", r.lastMs); put("frames", r.frames)
        if (logos) put("logos", JSONObject().also { o -> for ((k, v) in r.logos) o.put(k, b64e.encodeToString(v)) })
    }
    private fun toJson(logos: Boolean) = JSONObject().apply {
        put("stations", JSONArray(_stations.value.values.map { stationJson(it, logos) }))
        put("traffic", JSONObject(_maps.value.first)); put("radar", JSONObject(_maps.value.second))
    }
    private fun load(j: JSONObject) {
        val st = HashMap<Long, HdStationRec>()
        val a = j.optJSONArray("stations") ?: JSONArray()
        for (i in 0 until a.length()) {
            val o = a.getJSONObject(i); val hz = o.optLong("hz"); if (hz <= 0) continue
            val pa = o.optJSONArray("programs") ?: JSONArray(); val da = o.optJSONArray("data") ?: JSONArray(); val lo = o.optJSONObject("logos") ?: JSONObject()
            fun d(k: String) = if (o.isNull(k)) null else o.optDouble(k).takeIf { !it.isNaN() }
            st[hz] = HdStationRec(hz, o.optString("call"), o.optString("slogan"), o.optString("longName"), o.optString("message"), o.optInt("facility", -1), o.optString("country"),
                d("lat"), d("lon"), if (o.isNull("altM")) null else o.optInt("altM"),
                (0 until pa.length()).map { pa.getJSONObject(it) }.map { HdProgRec(it.optInt("n"), it.optInt("type", -1), it.optString("typeName"), it.optString("title"), it.optString("artist")) },
                (0 until da.length()).map { da.getString(it) }, o.optLong("firstMs"), o.optLong("lastMs"), o.optInt("frames"),
                lo.keys().asSequence().associateWith { b64d.decode(lo.getString(it)) })
        }
        fun strings(o: JSONObject?) = o?.keys()?.asSequence()?.associateWith { o.getString(it) } ?: emptyMap()
        _stations.value = st
        _maps.value = strings(j.optJSONObject("traffic")) to strings(j.optJSONObject("radar"))
    }

    /** The log as CSV, and the stations, this session's objects (without their bytes), the maps and the tuned station's data as JSON. */
    fun exportAll(): Pair<String, String> {
        val csv = "line\n" + log.lines.value.reversed().joinToString("\n") { "\"" + it.replace("\"", "\"\"") + "\"" }
        val j = toJson(false)
        j.put("objects", JSONArray(_objects.value.map { o -> JSONObject().put("key", o.key).put("hz", o.hz).put("port", o.port).put("id", o.id).put("name", o.name).put("size", o.size)
            .put("mime", o.mime).put("kind", o.kind).put("program", o.program).put("ms", o.ms) }))
        mine(proc.snap.value)?.station?.let { s ->
            val sis = s.sis
            j.put("station", JSONObject().put("frames", s.frames).put("ber", s.ber).put("pci", s.pciName).put("callsign", sis.callsign).put("facility", sis.facility).put("country", sis.country)
                .put("longName", sis.longName).put("slogan", sis.slogan).put("message", sis.message).put("lat", sis.lat ?: JSONObject.NULL).put("lon", sis.lon ?: JSONObject.NULL)
                .put("programs", JSONArray(s.programs.map { JSONObject().put("n", it.n).put("type", it.typeName).put("title", it.title).put("artist", it.artist).put("album", it.album) }))
                .put("ports", JSONArray(s.ports.map { JSONObject().put("port", it.port).put("kind", it.kind).put("name", it.name).put("packets", it.packets).put("bytes", it.bytes) })))
        }
        return csv to j.toString(1)
    }

}
