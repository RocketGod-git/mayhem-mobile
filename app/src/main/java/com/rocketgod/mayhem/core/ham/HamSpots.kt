package com.rocketgod.mayhem.core.ham

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * Ham Map's FT8 and JS8 layers: every decode that carries a Maidenhead grid becomes a station at the center of its
 * square. The decoders feed this one store wherever they run (the Ham Radio DIGITAL tab, the JS8 app), so the map
 * shows what was heard while it was closed. Stations age out and are capped the way the APRS receiver keeps its own.
 * The same rules as the web app's ham-spots.ts.
 */
enum class SpotMode { FT8, JS8 }

data class HamSpot(
    /** "ft8:K1ABC": one entry per mode and callsign, so each layer can be switched on its own. */
    val id: String, val mode: SpotMode, val call: String,
    /** "EM23" or "FN42ab". */
    val grid: String, val lat: Double, val lon: Double,
    val snr: Int, val dial: Long, val offset: Double,
    val firstMs: Long, val lastMs: Long, val heard: Int,
    /** The decode that last carried the grid. */
    val text: String,
)
data class SpotLine(val ms: Long, val mode: SpotMode, val call: String, val text: String, val line: String)
data class HamLayers(val aprs: Boolean = true, val ft8: Boolean = true, val js8: Boolean = true) {
    fun shows(m: SpotMode) = if (m == SpotMode.FT8) ft8 else js8
}

object HamGrid {
    private val GRID = Regex("^[A-R]{2}\\d{2}([A-X]{2})?$")
    private val CALL = Regex("^(?=.*\\d)(?=.*[A-Z])[A-Z0-9/]{3,12}$")
    private val CQ_WORD = Regex("^([A-Z]{1,4}|\\d{3})$")
    private val GRID_WORD = Regex("(?:^|\\s)GRID\\s+([A-R]{2}\\d{2}(?:[A-X]{2})?)", RegexOption.IGNORE_CASE)

    /** A 4 or 6 character locator. RR73 has the shape of a square but is the FT8 sign-off, so it never counts. */
    fun isGrid(s: String): Boolean { val g = s.trim().uppercase(); return GRID.matches(g) && g != "RR73" }
    /** "fn42AB" to "FN42ab", the way logs write a locator. */
    fun norm(s: String): String { val g = s.trim(); return g.take(4).uppercase() + g.drop(4).take(2).lowercase() }
    /** A callsign as decoders print it; hashed "<...>" is unknown. */
    fun cleanCall(s: String): String {
        val c = s.trim().uppercase().removePrefix("<").removeSuffix(">")
        return if (CALL.matches(c) && !c.startsWith("/") && !c.endsWith("/")) c else ""
    }

    /** Sender and grid of an FT8 standard message ("CQ K1ABC FN42", "CQ DX K1ABC FN42", "W9XYZ K1ABC R FN42"). */
    fun ft8(text: String): Pair<String, String>? {
        val t = text.trim().uppercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (t.size < 3) return null
        var call: String; var rest: List<String>
        if (t[0] == "CQ" || t[0] == "QRZ") {
            if (t.size >= 4 && CQ_WORD.matches(t[1])) { call = t[2]; rest = t.drop(3) } else { call = t[1]; rest = t.drop(2) }
        } else { call = t[1]; rest = t.drop(2) }
        if (rest.size == 2 && rest[0] == "R") rest = rest.drop(1)
        if (rest.size != 1 || !isGrid(rest[0])) return null
        val c = cleanCall(call)
        return if (c.isEmpty()) null else c to norm(rest[0])
    }

    /** The sender's grid from a JS8 message: a heartbeat's or a CQ's, or the word after GRID ("@APRSIS GRID EM73TU"). */
    fun js8(kind: String, from: String, body: String, grid: String?): Pair<String, String>? {
        val call = cleanCall(from); if (call.isEmpty()) return null
        var g = if ((kind == "heartbeat" || kind == "cq") && grid != null) grid else ""
        if (g.isEmpty()) g = GRID_WORD.find(body)?.groupValues?.get(1) ?: ""
        g = g.take(6)
        return if (g.isNotEmpty() && isGrid(g)) call to norm(g) else null
    }

    /** South, west, north, east. 2° by 1° for a 4-character grid, 5' by 2.5' for 6. */
    fun box(grid: String): DoubleArray? {
        if (!isGrid(grid)) return null
        val (lat, lon) = gridToLatLon(grid) ?: return null
        val w = if (grid.length >= 6) 2.0 / 24 else 2.0; val h = if (grid.length >= 6) 1.0 / 24 else 1.0
        return doubleArrayOf(lat - h / 2, lon - w / 2, lat + h / 2, lon + w / 2)
    }
    /** The outline as a closed ring of (lat, lon). */
    fun ring(grid: String): List<Pair<Double, Double>> {
        val b = box(grid) ?: return emptyList()
        return listOf(b[0] to b[1], b[2] to b[1], b[2] to b[3], b[0] to b[3], b[0] to b[1])
    }
    /** "20 m" for a dial in the band, else the frequency in MHz. */
    fun bandLabel(hz: Long): String {
        val b = bandOf(hz)
        return if (b != null && b.id.endsWith("m")) b.name else if (hz > 0) "%.3f MHz".format(java.util.Locale.US, hz / 1e6) else ""
    }
    fun freqText(s: HamSpot): String = if (s.dial > 0) "%.4f MHz".format(java.util.Locale.US, (s.dial + s.offset) / 1e6) else "${s.offset.toInt()} Hz"
    fun snrText(n: Int): String = "${if (n > 0) "+" else ""}$n dB"
}

/** The store; [HamSpots] is the one every decoder writes and Ham Map reads. */
open class HamSpotStore(val maxAgeMs: Long = MAX_AGE_MS, val cap: Int = CAP) {
    companion object {
        /** The APRS receiver forgets a station an hour after its last packet; the grid layers do the same. */
        const val MAX_AGE_MS = 60 * 60_000L
        const val CAP = 300
        const val LOG_CAP = 300
    }
    private val lock = Any()
    private val spots = LinkedHashMap<String, HamSpot>()
    private val logLines = ArrayList<SpotLine>()
    private val _list = MutableStateFlow<List<HamSpot>>(emptyList())
    /** Newest first. */
    val list: StateFlow<List<HamSpot>> = _list.asStateFlow()
    private val _log = MutableStateFlow<List<SpotLine>>(emptyList())
    /** Newest first. */
    val log: StateFlow<List<SpotLine>> = _log.asStateFlow()

    fun add(mode: SpotMode, call: String, grid: String, snr: Int, dial: Long, offset: Double, ms: Long, text: String): HamSpot? {
        val c = HamGrid.cleanCall(call); if (c.isEmpty() || !HamGrid.isGrid(grid)) return null
        val g = HamGrid.norm(grid); val (lat, lon) = gridToLatLon(g) ?: return null
        val id = "${mode.name.lowercase()}:$c"
        synchronized(lock) {
            val old = spots[id]
            var s = HamSpot(id, mode, c, g, lat, lon, snr, dial, offset, minOf(old?.firstMs ?: ms, ms), maxOf(old?.lastMs ?: ms, ms), (old?.heard ?: 0) + 1, text)
            // a newer grid wins; an older decode arriving late only counts
            if (old != null && ms < old.lastMs) s = s.copy(grid = old.grid, lat = old.lat, lon = old.lon, snr = old.snr, dial = old.dial, offset = old.offset, text = old.text)
            spots.remove(id); spots[id] = s
            val band = HamGrid.bandLabel(dial)
            logLines.add(0, SpotLine(ms, mode, c, text, "${mode.name} $c $g · ${listOf(band, HamGrid.snrText(snr)).filter { it.isNotEmpty() }.joinToString(" · ")} · $text"))
            while (logLines.size > LOG_CAP) logLines.removeAt(logLines.size - 1)
            trim(ms); publish(ms)
            return s
        }
    }
    /** One FT8 slot's decode at [dial] (the USB dial, Hz); [hz] is its audio offset. */
    fun ft8(d: Ft8Decode, dial: Long, ms: Long): HamSpot? = HamGrid.ft8(d.text)?.let { (c, g) -> add(SpotMode.FT8, c, g, d.snr, dial, d.hz.toDouble(), ms, d.text) }
    /** A JS8 message as the message layer assembled it. */
    fun js8(kind: String, from: String, body: String, grid: String?, snr: Int, hz: Double, ms: Long, text: String, dial: Long): HamSpot? =
        HamGrid.js8(kind, from, body, grid)?.let { (c, g) -> add(SpotMode.JS8, c, g, snr, dial, hz, ms, text) }

    /** Newest first, without the aged ones. */
    fun current(now: Long = System.currentTimeMillis()): List<HamSpot> = synchronized(lock) { trim(now); publish(now); _list.value }
    fun logNow(now: Long = System.currentTimeMillis()): List<SpotLine> = _log.value.filter { now - it.ms <= maxAgeMs }
    operator fun get(id: String): HamSpot? = synchronized(lock) { spots[id] }
    val size: Int get() = synchronized(lock) { spots.size }
    fun clear() = synchronized(lock) { spots.clear(); logLines.clear(); _list.value = emptyList(); _log.value = emptyList() }

    private fun trim(now: Long) {
        spots.values.removeAll { now - it.lastMs > maxAgeMs }
        if (spots.size > cap) spots.values.sortedBy { it.lastMs }.take(spots.size - cap).forEach { spots.remove(it.id) }
    }
    private fun publish(now: Long) {
        val l = spots.values.sortedByDescending { it.lastMs }
        if (l != _list.value) _list.value = l
        val lg = logLines.filter { now - it.ms <= maxAgeMs }
        if (lg != _log.value) _log.value = lg
    }
}

object HamSpots : HamSpotStore() {
    private const val PREFS = "mayhem.hammap"
    private const val K_LAYERS = "layers"
    private var ctx: Context? = null
    private val _layers = MutableStateFlow(HamLayers())
    /** The layer chips on Ham Map, remembered. */
    val layers: StateFlow<HamLayers> = _layers.asStateFlow()

    fun init(c: Context) {
        ctx = c.applicationContext
        _layers.value = layersFrom(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(K_LAYERS, null))
    }
    fun setLayers(l: HamLayers) {
        _layers.value = l
        ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(K_LAYERS, layersJson(l))?.apply()
    }
    fun layersJson(l: HamLayers): String = JSONObject().put("aprs", l.aprs).put("ft8", l.ft8).put("js8", l.js8).toString()
    /** Anything unreadable falls back to every layer on. */
    fun layersFrom(s: String?): HamLayers = runCatching { val o = JSONObject(s ?: ""); HamLayers(o.optBoolean("aprs", true), o.optBoolean("ft8", true), o.optBoolean("js8", true)) }.getOrDefault(HamLayers())
}
