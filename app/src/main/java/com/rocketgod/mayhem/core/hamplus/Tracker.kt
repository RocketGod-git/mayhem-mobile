package com.rocketgod.mayhem.core.hamplus

import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.math.sqrt

/*
 * HAM+ tracker: what the transmissions heard across the band add up to. No DSP; fed finished transmissions and the
 * channels open right now, it keeps:
 *  - stations: on a channel where the talkers' own carriers are heard (simplex, a repeater's input), transmissions are
 *    told apart by each radio's carrier frequency error and sub-audible tone, and lettered A, B, C as they appear;
 *  - repeater pairs: a channel at a band-plan offset from a repeater output, keyed at the same moment as it, again and
 *    again, is that repeater's input; the two become one tile and the input names the talker on the output;
 *  - linked channels: the same audio envelope on several channels at the same moment;
 *  - conversations: back-and-forth on a channel with no gap longer than [CONV_GAP_MS];
 *  - nets: one station coming back between check-ins from many others;
 *  - a 24-hour activity map per band, and per-channel activity for sparklines.
 */

const val CONV_GAP_MS = 45_000.0
/** A transmission shorter than this has too little carrier for its offset to count. */
const val OFFSET_MIN_MS = 600.0
/** Two transmissions this close in Hz (plus their own spread) are one radio. */
const val STATION_TOL_HZ = 60.0
const val STATION_TOL_MAX_HZ = 150.0
/** Repeater input and output keying together: starts this close, input not outlasting the output by more than this. */
const val PAIR_START_MS = 1_500.0
const val PAIR_END_MS = 700.0
const val PAIR_HITS = 2
/** Linked channels: transmissions starting and ending this close, envelopes correlating at least this well. */
const val LINK_EDGE_MS = 1_500.0
const val LINK_CORR = 0.8
const val LINK_HITS = 2
const val LINK_MIN_MS = 2_000.0
/** Envelope frame: 50 ms. A link may delay its audio up to [LINK_LAG] frames. */
const val ENV_MS = 50.0
const val LINK_LAG = 25
const val HEAT_SLOTS = 96
private const val MAX_TXS = 3_000
private const val SPARK_MIN = 30

/** A finished transmission, as the receiver measured it. */
class TxRec(
    val id: Int, val hz: Long, val startMs: Double, val endMs: Double,
    /** Peak SNR in dB. */
    val peakDb: Double,
    /** Carrier frequency error from the channel in Hz (the discriminator's mean), NaN when not measured. */
    val offsetHz: Double,
    /** Spread of the 100 ms means the offset is the average of (Hz). */
    val offsetSd: Double,
    val tone: Double, val dcs: Int,
    /** Morse heard on the carrier (a CW ID), or ''. */
    val cw: String,
    /** Audio envelope, one value a frame of [ENV_MS]. */
    val env: FloatArray,
    /** Demodulated and kept in the time machine. */
    val recorded: Boolean,
)

/** A channel open right now, as the receiver reports it. */
data class LiveRec(
    val id: Int, val hz: Long, val startMs: Double, val snrDb: Double, val levelDb: Double, val offsetHz: Double,
    val tone: Double, val dcs: Int, val recorded: Boolean,
)

class Station(
    val key: String, val letter: String, var offsetHz: Double, var n: Int, var m2: Double, var tone: Double, var dcs: Int,
    var callsign: String, val firstMs: Double, var lastMs: Double, var txs: Int, var talkMs: Double,
)

private class Chan(val hz: Long) {
    var firstMs = 0.0; var lastMs = 0.0; var talkMs = 0.0; var txs = 0; var unrecorded = 0
    var tone = 0.0; var dcs = 0; var callsign = ""; var callsignMs = 0.0
    val stations = ArrayList<Station>()
    /** Airtime (ms) per minute, keyed by the minute. */
    val minutes = LinkedHashMap<Long, Double>()
}

data class HpPrefs(val hold: String = "", val mute: List<String> = emptyList(), val prio: List<String> = emptyList())

fun chanKey(hz: Long): String = ((hz / 100.0).roundToLong() * 100).toString()

data class HpTxRow(
    val id: Int, val hz: Long, val heardHz: Long, val startMs: Double, val endMs: Double, val live: Boolean,
    val tone: Double, val dcs: Int, val offsetHz: Double, val peakDb: Double,
    val station: String, val stationLabel: String, val color: Int, val callsign: String,
    /** The talker's own carrier was heard on the repeater's input: they are near. */
    val direct: Boolean,
    var conv: Int, var recorded: Boolean, val cw: String,
    /** CB: the mode it was heard in (AM, FM, USB, LSB). HAM+ leaves it empty. */
    val mode: String = "",
)

data class HpTileStation(val key: String, val label: String, val letter: String, val color: Int, val callsign: String, val txs: Int, val offsetHz: Long)
data class HpNet(val control: String, val checkins: Int)

data class HpTile(
    val key: String, val hz: Long, val label: String, val use: String, val kind: String, val offset: String,
    val inputHz: Long, val nearMs: Double,
    val tone: Double, val dcs: Int, val live: Boolean, val snrDb: Double, val levelDb: Double, val openMs: Double, val lastMs: Double,
    val talkMs: Double, val txs: Int, val spark: List<Int>, val callsign: String,
    val stations: List<HpTileStation>,
    val net: HpNet?, val link: Int, val unrecorded: Int,
    val followed: Boolean, val muted: Boolean, val prio: Boolean,
)

data class HpConv(
    val id: Int, val key: String, val hz: Long, val startMs: Double, val endMs: Double, val live: Boolean,
    val txs: List<Int>, val stations: List<String>, val talkMs: Double, val net: Boolean,
)

class HpHeatBand(val id: String, val slots: DoubleArray)
class HpHeat(val bands: MutableList<HpHeatBand> = ArrayList(), val cover: DoubleArray = DoubleArray(HEAT_SLOTS)) {
    fun copy(): HpHeat = HpHeat(bands.mapTo(ArrayList()) { HpHeatBand(it.id, it.slots.copyOf()) }, cover.copyOf())
}

data class HpSavedChan(val hz: Long, val callsign: String, val tone: Double, val dcs: Int, val talkMs: Double, val txs: Int, val lastMs: Double, val firstMs: Double)

class HpSaved(val chans: List<HpSavedChan>, val pairs: List<Pair<Long, Long>>, val links: List<Pair<Long, Long>>, val heat: HpHeat?) {
    fun toJson(): String {
        val o = JSONObject()
        o.put("chans", JSONArray().apply {
            for (c in chans) put(JSONObject().put("hz", c.hz).put("callsign", c.callsign).put("tone", c.tone).put("dcs", c.dcs)
                .put("talkMs", c.talkMs).put("txs", c.txs).put("lastMs", c.lastMs).put("firstMs", c.firstMs))
        })
        o.put("pairs", JSONArray().apply { for ((a, b) in pairs) put(JSONArray().put(a).put(b)) })
        o.put("links", JSONArray().apply { for ((a, b) in links) put(JSONArray().put(a).put(b)) })
        if (heat != null) o.put("heat", JSONObject()
            .put("bands", JSONArray().apply { for (b in heat.bands) put(JSONObject().put("id", b.id).put("slots", JSONArray().apply { for (v in b.slots) put(v) })) })
            .put("cover", JSONArray().apply { for (v in heat.cover) put(v) }))
        return o.toString()
    }

    companion object {
        fun fromJson(s: String?): HpSaved? {
            if (s.isNullOrEmpty()) return null
            return try {
                val o = JSONObject(s)
                fun pairs(name: String): List<Pair<Long, Long>> {
                    val a = o.optJSONArray(name) ?: return emptyList()
                    return (0 until a.length()).mapNotNull { i -> a.optJSONArray(i)?.let { it.optLong(0) to it.optLong(1) } }
                }
                fun doubles(a: JSONArray?): DoubleArray = if (a == null) DoubleArray(0) else DoubleArray(a.length()) { a.optDouble(it, 0.0) }
                val ch = o.optJSONArray("chans")
                val chans = if (ch == null) emptyList() else (0 until ch.length()).mapNotNull { i ->
                    ch.optJSONObject(i)?.let {
                        HpSavedChan(it.optLong("hz"), it.optString("callsign", ""), it.optDouble("tone", 0.0), it.optInt("dcs", 0),
                            it.optDouble("talkMs", 0.0), it.optInt("txs", 0), it.optDouble("lastMs", 0.0), it.optDouble("firstMs", 0.0))
                    }
                }
                val h = o.optJSONObject("heat")
                val heat = if (h == null) null else {
                    val bs = h.optJSONArray("bands")
                    HpHeat((if (bs == null) emptyList() else (0 until bs.length()).mapNotNull { i ->
                        bs.optJSONObject(i)?.let { HpHeatBand(it.optString("id"), doubles(it.optJSONArray("slots"))) }
                    }).toMutableList(), doubles(h.optJSONArray("cover")))
                }
                HpSaved(chans, pairs("pairs"), pairs("links"), heat)
            } catch (e: Exception) { null }
        }
    }
}

private const val LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
private val CALL_RE = Regex("^[A-Z]{1,2}\\d[A-Z]{1,4}$|^[A-Z]{1,4}\\d{1,4}[A-Z]{0,4}$")
private fun looksLikeCall(s: String) = CALL_RE.containsMatchIn(s) && s.length >= 4 && s.any { it.isDigit() } && s.any { it in 'A'..'Z' }

/** The callsign in a CW ID ('DE W1AW/R', 'W1AW RPT'), or ''. */
fun cwCallsign(text: String): String {
    for (w in text.uppercase().split(Regex("\\s+"))) { val c = w.split('/')[0]; if (looksLikeCall(c)) return c }
    return ""
}

private fun localSlot(ms: Double): Int {
    val c = Calendar.getInstance(); c.timeInMillis = ms.toLong()
    return floor((c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)) / (1440.0 / HEAT_SLOTS)).toInt()
}

/** Normalized correlation of two envelopes at the best lag within ±[maxLag] frames (over their overlap). */
fun envCorr(a: FloatArray, b: FloatArray, startDiffFrames: Int, maxLag: Int = LINK_LAG): Double {
    var best = -1.0
    for (lag in -maxLag..maxLag) {
        // b[j] lines up with a[j + d]
        val d = startDiffFrames + lag
        val j0 = max(0, -d); val j1 = min(b.size, a.size - d)
        val n = j1 - j0
        if (n < 20) continue
        var sa = 0.0; var sb = 0.0
        for (j in j0 until j1) { sa += a[j + d]; sb += b[j] }
        val ma = sa / n; val mb = sb / n
        var num = 0.0; var da = 0.0; var db = 0.0
        for (j in j0 until j1) { val x = a[j + d] - ma; val y = b[j] - mb; num += x * y; da += x * x; db += y * y }
        if (da <= 0 || db <= 0) continue
        best = max(best, num / sqrt(da * db))
    }
    return best
}

private class Ev(var hits: Int, var misses: Int)

/**
 * What the tracker asks of a band plan: what a frequency is (its name, its use, its repeater offsets) and the row of
 * the activity map it counts in. HAM+ has the ARRL plans and a row per band; CB its channel names and a row a channel.
 */
interface TrackerPlan { fun info(hz: Long): PlanInfo; fun heatRow(hz: Long): String }
val HAM_TRACKER_PLAN: TrackerPlan = object : TrackerPlan {
    override fun info(hz: Long): PlanInfo = planInfo(hz)
    override fun heatRow(hz: Long): String = hpBandOf(hz)?.id ?: ""
}

class HamTracker(val plan: TrackerPlan = HAM_TRACKER_PLAN, val now: () -> Double = { System.currentTimeMillis().toDouble() }) {
    private val chans = LinkedHashMap<String, Chan>()
    private val txs = ArrayList<TxRec>()
    private val txStation = HashMap<Int, String>()
    private var live: List<LiveRec> = emptyList()
    /** Repeater pairs, output key to input hz, and the evidence for each candidate 'out|in'. */
    private val pairs = LinkedHashMap<String, Long>()
    private val pairEv = HashMap<String, Ev>()
    private val linkEv = HashMap<String, Int>()
    private val links = LinkedHashSet<String>()
    private val judged = HashSet<Int>()
    var heat = HpHeat()
    var prefs = HpPrefs()
    var labels: Map<String, String> = emptyMap()
    var spanLo = 0.0; private set
    var spanHi = 0.0; private set
    private var lastCover = 0.0

    fun setSpan(lo: Double, hi: Double) { spanLo = lo; spanHi = hi }
    fun inSpan(hz: Long): Boolean = hz > spanLo && hz < spanHi

    private fun chan(hz: Long): Chan = chans.getOrPut(chanKey(hz)) { Chan(hz) }

    /** The output a channel is the heard input of, or 0. */
    fun outputOf(hz: Long): Long { for ((k, i) in pairs) if (abs(i - hz) < 1_250) return k.toLong(); return 0 }
    fun inputOf(hz: Long): Long = pairs[chanKey(hz)] ?: 0

    /** A repeater output: the band plan says so, a CW ID was heard on it, or its input was found. */
    fun repeaterLike(hz: Long): Boolean {
        val c = chans[chanKey(hz)]; val p = plan.info(hz)
        if (outputOf(hz) != 0L) return false
        return p.use == "output" || inputOf(hz) != 0L || (!c?.callsign.isNullOrEmpty() && p.use != "simplex")
    }

    /** The tile a channel shows on: its output when it is a repeater's heard input. */
    fun tileHz(hz: Long): Long = outputOf(hz).takeIf { it != 0L } ?: hz

    /** Clusters one transmission into a station of its channel. */
    private fun assign(c: Chan, offsetHz: Double, offsetSd: Double, tone: Double, dcs: Int, startMs: Double, endMs: Double, commit: Boolean): Station? {
        if (!offsetHz.isFinite() || endMs - startMs < OFFSET_MIN_MS) return null
        val tol = min(STATION_TOL_MAX_HZ, STATION_TOL_HZ + 2 * offsetSd)
        var best: Station? = null; var bd = Double.POSITIVE_INFINITY
        for (s in c.stations) {
            if (tone != 0.0 && s.tone != 0.0 && abs(tone - s.tone) > 0.5) continue
            if (dcs != 0 && s.dcs != 0 && dcs != s.dcs) continue
            if ((tone != 0.0 && s.dcs != 0) || (dcs != 0 && s.tone != 0.0)) continue
            val d = abs(offsetHz - s.offsetHz)
            if (d < tol && d < bd) { bd = d; best = s }
        }
        if (!commit) return best
        if (best == null) {
            if (c.stations.size >= LETTERS.length) return null
            val letter = LETTERS[c.stations.size].toString()
            best = Station("${chanKey(c.hz)}/$letter", letter, offsetHz, 0, 0.0, 0.0, 0, "", startMs, 0.0, 0, 0.0)
            c.stations.add(best)
        }
        // running mean of the station's offset (each transmission one vote)
        best.n++
        val d = offsetHz - best.offsetHz
        best.offsetHz += d / best.n; best.m2 += d * (offsetHz - best.offsetHz)
        if (tone != 0.0) best.tone = tone
        if (dcs != 0) best.dcs = dcs
        best.lastMs = max(best.lastMs, endMs); best.txs++; best.talkMs += endMs - startMs
        return best
    }

    /** A transmission ended. */
    fun addTx(t: TxRec) {
        txs.add(t)
        if (txs.size > MAX_TXS) {
            val old = txs.subList(0, txs.size - MAX_TXS)
            for (o in old) { txStation.remove(o.id); judged.remove(o.id) }
            old.clear()
        }
        val c = chan(t.hz); val dur = t.endMs - t.startMs
        if (c.firstMs == 0.0) c.firstMs = t.startMs
        c.lastMs = max(c.lastMs, t.endMs); c.talkMs += dur; c.txs++
        if (!t.recorded) c.unrecorded++
        if (t.tone != 0.0) { c.tone = t.tone; c.dcs = 0 } else if (t.dcs != 0) { c.dcs = t.dcs; c.tone = 0.0 }
        // airtime a minute, for the sparkline
        val m0 = floor(t.startMs / 60_000).toLong(); val m1 = floor(t.endMs / 60_000).toLong()
        for (m in m0..m1) {
            val a = max(t.startMs, m * 60_000.0); val b = min(t.endMs, (m + 1) * 60_000.0)
            if (b > a) c.minutes[m] = (c.minutes[m] ?: 0.0) + b - a
        }
        c.minutes.keys.removeAll { it < m1 - SPARK_MIN }
        val row = plan.heatRow(t.hz)
        if (row.isNotEmpty()) {
            val b = heat.bands.firstOrNull { it.id == row } ?: HpHeatBand(row, DoubleArray(HEAT_SLOTS)).also { heat.bands.add(it) }
            b.slots[localSlot(t.startMs)] += dur / 1000
        }
        val call = cwCallsign(t.cw)
        // every transmission is clustered; on a repeater output the clusters are the repeater's own carrier and go unused
        val s = assign(c, t.offsetHz, t.offsetSd, t.tone, t.dcs, t.startMs, t.endMs, true)
        if (s != null) txStation[t.id] = s.key
        if (call.isNotEmpty()) {
            val u = plan.info(t.hz).use
            if (s != null && (u == "simplex" || u == "input" || outputOf(t.hz) != 0L)) s.callsign = call
            else { c.callsign = call; c.callsignMs = t.endMs }
        }
        judge(now())
    }

    /** The channels open now. */
    fun setLive(live: List<LiveRec>) {
        this.live = live
        val n = now()
        // listening time per slot of the day, so a quiet hour and an hour not heard look different
        if (lastCover != 0.0 && n - lastCover < 5_000) heat.cover[localSlot(n)] += (n - lastCover) / 1000
        lastCover = n
    }

    /** Pairs and links, worked out on transmissions that ended a few seconds ago (their partners have ended too). */
    fun judge(now: Double) {
        for (t in txs) {
            if (t.id in judged || now - t.endMs < 4_000) continue
            judged.add(t.id)
            // as a repeater input: an output at a plan offset keyed with it
            for (c in chans.values) {
                val off = t.hz - c.hz; val p = plan.info(c.hz)
                if (p.offsets.none { abs(it - off) < 1_250 }) continue
                val k = "${chanKey(c.hz)}|${chanKey(t.hz)}"
                val ev = pairEv[k] ?: Ev(0, 0)
                val hit = txs.any { o -> o.hz == c.hz && abs(o.startMs - t.startMs) <= PAIR_START_MS && o.endMs >= t.endMs - PAIR_END_MS }
                if (hit) ev.hits++ else if (inSpan(c.hz)) ev.misses++ else continue
                pairEv[k] = ev
                if (ev.hits >= PAIR_HITS && ev.hits >= 2 * ev.misses) pairs[chanKey(c.hz)] = t.hz
                else if (pairs[chanKey(c.hz)] == t.hz && ev.misses > ev.hits) pairs.remove(chanKey(c.hz))
            }
            // linked: the same audio on another channel at the same moment
            if (t.endMs - t.startMs < LINK_MIN_MS || t.env.size < 20) continue
            for (o in txs) {
                if (o.id >= t.id || o.hz == t.hz || abs(o.hz - t.hz) < 50_000 || o.env.size < 20) continue
                if (abs(o.startMs - t.startMs) > LINK_EDGE_MS || abs(o.endMs - t.endMs) > LINK_EDGE_MS) continue
                if (pairedTogether(o.hz, t.hz)) continue
                val r = envCorr(o.env, t.env, ((t.startMs - o.startMs) / ENV_MS).roundToInt())
                if (r < LINK_CORR) continue
                val ks = listOf(chanKey(tileHz(o.hz)), chanKey(tileHz(t.hz))).sorted()
                if (ks[0] == ks[1]) continue
                val k = ks.joinToString("|")
                val n = (linkEv[k] ?: 0) + 1; linkEv[k] = n
                if (n >= LINK_HITS) links.add(k)
            }
        }
    }

    private fun pairedTogether(a: Long, b: Long): Boolean =
        abs(inputOf(a) - b) < 1_250 || abs(inputOf(b) - a) < 1_250 ||
            (plan.info(a).offsets.any { abs(b - a - it) < 1_250 } && pairEv.containsKey("${chanKey(a)}|${chanKey(b)}")) ||
            (plan.info(b).offsets.any { abs(a - b - it) < 1_250 } && pairEv.containsKey("${chanKey(b)}|${chanKey(a)}"))

    /** Link groups: each tile key in a linked network mapped to a group number from 1. */
    fun linkGroups(): Map<String, Int> {
        val parent = HashMap<String, String>()
        fun find(x: String): String { var p = parent[x] ?: x; if (p != x) { p = find(p); parent[x] = p }; return p }
        for (k in links) { val (a, b) = k.split('|'); parent[find(a)] = find(b) }
        val roots = HashMap<String, Int>(); val out = HashMap<String, Int>()
        for (k in links.sorted()) for (x in k.split('|')) { val r = find(x); if (r !in roots) roots[r] = roots.size + 1; out[x] = roots[r]!! }
        return out
    }

    private fun findStation(key: String?): Station? {
        if (key == null) return null
        val c = chans[key.substring(0, key.indexOf('/'))]
        return c?.stations?.firstOrNull { it.key == key }
    }

    /** The station a transmission came from (on an output with its input heard, the input's), and whether direct. */
    private fun stationOf(id: Int, hz: Long, startMs: Double, endMs: Double): Pair<Station?, Boolean> {
        val k = txStation[id]
        if (!repeaterLike(hz)) return findStation(k) to false
        val inHz = inputOf(hz)
        if (inHz == 0L) return null to false
        // the input transmission keyed with this one
        val i = txs.firstOrNull { o -> abs(o.hz - inHz) < 1_250 && abs(o.startMs - startMs) <= PAIR_START_MS && (endMs == 0.0 || o.endMs <= endMs + PAIR_END_MS) }
        if (i != null) return findStation(txStation[i.id]) to true
        val l = live.firstOrNull { o -> abs(o.hz - inHz) < 1_250 && abs(o.startMs - startMs) <= PAIR_START_MS }
        if (l != null) {
            val c = chans[chanKey(inHz)]
            val s = if (c != null) assign(c, l.offsetHz, 30.0, l.tone, l.dcs, l.startMs, now(), false) else null
            return s to true
        }
        return null to false
    }

    private fun stationLabel(s: Station?): String = if (s == null) "" else labels[s.key]?.takeIf { it.isNotEmpty() } ?: s.callsign.ifEmpty { s.letter }

    /** Rows for the log and the conversations: finished transmissions and the ones on the air, newest first. */
    fun rows(now: Double, max: Int = 400): List<HpTxRow> {
        val out = ArrayList<HpTxRow>()
        fun add(id: Int, hz: Long, startMs: Double, endMs: Double, tone: Double, dcs: Int, offsetHz: Double, peakDb: Double, recorded: Boolean, cw: String, live: Boolean) {
            var st: Station? = null; var direct = false
            if (live && !repeaterLike(hz)) {
                val c = chans[chanKey(hz)]
                st = if (c != null) assign(c, offsetHz, 30.0, tone, dcs, startMs, now, false) else null
            } else { val r = stationOf(id, hz, startMs, endMs); st = r.first; direct = r.second }
            val tile = tileHz(hz)
            out.add(HpTxRow(id, tile, hz, startMs, if (live) 0.0 else endMs, live, tone, dcs, offsetHz, peakDb,
                st?.key ?: "", stationLabel(st), if (st != null) LETTERS.indexOf(st.letter) else -1, st?.callsign ?: "", direct, 0, recorded, cw))
        }
        for (l in live) add(l.id, l.hz, l.startMs, 0.0, l.tone, l.dcs, l.offsetHz, l.snrDb, l.recorded, "", true)
        var i = txs.size - 1
        while (i >= 0 && out.size < max) { val t = txs[i]; add(t.id, t.hz, t.startMs, t.endMs, t.tone, t.dcs, t.offsetHz, t.peakDb, t.recorded, t.cw, false); i-- }
        // an input transmission shows as the talker on its output: the output's row carries it, the input's row goes
        val shown = out.filter { r -> r.hz == r.heardHz || out.none { o -> o.heardHz == r.hz && abs(o.startMs - r.startMs) <= PAIR_START_MS } }
        // conversations: per tile, transmissions with no gap longer than CONV_GAP_MS
        val byTile = LinkedHashMap<Long, MutableList<HpTxRow>>()
        for (r in shown) byTile.getOrPut((r.hz / 100.0).roundToLong()) { ArrayList() }.add(r)
        for (list in byTile.values) {
            list.sortBy { it.startMs }
            var conv = 0; var end = Double.NEGATIVE_INFINITY
            for (r in list) { if (r.startMs - end > CONV_GAP_MS) conv = r.id; r.conv = conv; end = max(end, if (r.live) now else r.endMs) }
        }
        return shown.sortedByDescending { it.startMs }
    }

    fun convs(rows: List<HpTxRow>, now: Double): List<HpConv> {
        class B(val id: Int, val key: String, val hz: Long, val startMs: Double) {
            var endMs = 0.0; var live = false; val txs = ArrayList<Int>(); val stations = ArrayList<String>(); var talkMs = 0.0
        }
        val by = LinkedHashMap<Int, B>()
        for (r in rows.asReversed()) {
            val c = by.getOrPut(r.conv) { B(r.conv, chanKey(r.hz), r.hz, r.startMs) }
            c.txs.add(r.id); c.live = c.live || r.live
            val e = if (r.live) now else r.endMs
            c.endMs = max(c.endMs, e); c.talkMs += e - r.startMs
            if (r.station.isNotEmpty() && r.station !in c.stations) c.stations.add(r.station)
        }
        return by.values.sortedByDescending { it.endMs }.map { c ->
            val net = netOf(rows.filter { it.conv == c.id }.sortedBy { it.startMs }.map { it.station }) != null
            HpConv(c.id, c.key, c.hz, c.startMs, c.endMs, c.live, c.txs.toList(), c.stations.toList(), c.talkMs, net)
        }
    }

    fun tiles(now: Double, rows: List<HpTxRow>, max: Int = 80): List<HpTile> {
        val groups = linkGroups(); val out = ArrayList<HpTile>(); val seen = HashSet<String>()
        val nowMin = floor(now / 60_000).toLong()
        val keys = LinkedHashSet<String>(chans.keys); for (l in live) keys.add(chanKey(l.hz))
        if (prefs.hold.isNotEmpty()) keys.add(prefs.hold)
        for (k0 in keys) {
            val hz0 = k0.toLongOrNull() ?: continue
            val tileHz = tileHz(hz0); val k = chanKey(tileHz)
            if (!seen.add(k)) continue
            val c = chans[k] ?: chan(tileHz)
            val inHz = inputOf(tileHz); val ci = if (inHz != 0L) chans[chanKey(inHz)] else null
            val lv = live.filter { abs(it.hz - tileHz) < 1_250 || (inHz != 0L && abs(it.hz - inHz) < 1_250) }
            val lo = lv.firstOrNull { abs(it.hz - tileHz) < 1_250 } ?: lv.firstOrNull()
            val p = plan.info(tileHz); val rep = repeaterLike(tileHz)
            val spark = IntArray(SPARK_MIN) { i -> (((c.minutes[nowMin - SPARK_MIN + 1 + i]) ?: 0.0) / 1000).roundToInt() }
            if (lo != null) { val a = max(lo.startMs, nowMin * 60_000.0); spark[SPARK_MIN - 1] += ((now - a) / 1000).roundToInt() }
            val sts: List<Station> = if (rep) ci?.stations ?: emptyList() else c.stations
            val tr = rows.filter { it.hz == tileHz }
            val lastConv = if (tr.isNotEmpty()) tr[0].conv else 0
            val net = netOf(tr.filter { it.conv == lastConv }.sortedBy { it.startMs }.map { it.station })
            val st = if (net != null) sts.firstOrNull { it.key == net.control } else null
            val kind = if (rep) "REPEATER" else when (p.use) { "simplex" -> "SIMPLEX"; "input" -> "INPUT"; "satellite" -> "SATELLITE"; else -> "" }
            out.add(HpTile(
                key = k, hz = tileHz, label = p.label, use = p.use, kind = kind,
                offset = if (rep || p.use == "output") offsetText(if (inHz != 0L) listOf(inHz - tileHz) else p.offsets) else "",
                inputHz = inHz, nearMs = ci?.lastMs ?: 0.0,
                tone = lo?.tone?.takeIf { it != 0.0 } ?: c.tone.takeIf { it != 0.0 } ?: ci?.tone ?: 0.0,
                dcs = lo?.dcs?.takeIf { it != 0 } ?: c.dcs,
                live = lo != null, snrDb = lo?.snrDb ?: 0.0, levelDb = lo?.levelDb ?: -90.0, openMs = if (lo != null) now - lo.startMs else 0.0,
                lastMs = if (lo != null) now else max(c.lastMs, ci?.lastMs ?: 0.0),
                talkMs = c.talkMs + (if (lo != null) now - lo.startMs else 0.0), txs = c.txs + (if (lo != null) 1 else 0), spark = spark.toList(), callsign = c.callsign,
                stations = sts.map { HpTileStation(it.key, stationLabel(it), it.letter, LETTERS.indexOf(it.letter), it.callsign, it.txs, it.offsetHz.roundToLong()) },
                net = if (net != null) HpNet(stationLabel(st).ifEmpty { net.control }, net.checkins) else null, link = groups[k] ?: 0,
                unrecorded = c.unrecorded + (ci?.unrecorded ?: 0) + lv.count { !it.recorded },
                followed = prefs.hold == k, muted = k in prefs.mute, prio = k in prefs.prio,
            ))
        }
        fun rank(t: HpTile) = if (t.followed) 0 else if (t.live) 1 else 2
        return out.filter { it.followed || it.live || it.txs > 0 }
            .sortedWith(compareBy<HpTile> { rank(it) }.thenByDescending { it.lastMs }.thenBy { it.hz }).take(max)
    }

    /** What to keep between sessions. */
    fun save(): HpSaved {
        val cs = chans.values.filter { it.txs > 0 }.sortedByDescending { it.lastMs }.take(200)
            .map { HpSavedChan(it.hz, it.callsign, it.tone, it.dcs, it.talkMs, it.txs, it.lastMs, it.firstMs) }
        return HpSaved(cs, pairs.map { (k, v) -> k.toLong() to v }, links.map { k -> val (a, b) = k.split('|'); a.toLong() to b.toLong() }, heat.copy())
    }

    fun restore(s: HpSaved?) {
        if (s == null) return
        for (x in s.chans) {
            val c = chan(x.hz)
            if (c.callsign.isEmpty()) c.callsign = x.callsign
            if (c.tone == 0.0) c.tone = x.tone
            if (c.dcs == 0) c.dcs = x.dcs
            c.talkMs += x.talkMs; c.txs += x.txs; c.lastMs = max(c.lastMs, x.lastMs)
            if (c.firstMs == 0.0) c.firstMs = x.firstMs
        }
        for ((o, i) in s.pairs) { pairs[chanKey(o)] = i; pairEv["${chanKey(o)}|${chanKey(i)}"] = Ev(PAIR_HITS, 0) }
        for ((a, b) in s.links) { val k = listOf(chanKey(a), chanKey(b)).sorted().joinToString("|"); links.add(k); linkEv[k] = LINK_HITS }
        val h = s.heat
        if (h != null && h.cover.size == HEAT_SLOTS) heat = HpHeat(h.bands.filter { it.slots.size == HEAT_SLOTS }.toMutableList(), h.cover.copyOf())
    }

    fun clear() { chans.clear(); txs.clear(); txStation.clear(); pairs.clear(); pairEv.clear(); links.clear(); linkEv.clear(); judged.clear() }
    fun tx(id: Int): TxRec? = txs.firstOrNull { it.id == id }
    val stationCount: Int get() = chans.values.sumOf { it.stations.size }
}

/**
 * A net in a run of transmissions (station keys in time order, '' unknown): one station keeps coming back between
 * check-ins from at least four others, and takes at least half of all the turns after another station's.
 */
fun netOf(seq: List<String>): HpNet? {
    val known = seq.filter { it.isNotEmpty() }
    if (known.size < 8) return null
    val count = LinkedHashMap<String, Int>(); for (s in known) count[s] = (count[s] ?: 0) + 1
    val top = count.entries.maxByOrNull { it.value }!!.key
    val others = known.filter { it != top }.toSet()
    if (others.size < 4 || (count[top] ?: 0) < 4) return null
    var after = 0; var otherTurns = 0
    for (i in 0 until known.size - 1) if (known[i] != top) { otherTurns++; if (known[i + 1] == top) after++ }
    return if (otherTurns > 0 && after.toDouble() / otherTurns >= 0.5) HpNet(top, others.size) else null
}
