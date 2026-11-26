package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.UnitSystem
import com.rocketgod.mayhem.core.Units
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * What Dispatch's views say about a call, worked out apart from the UI: the encryption algorithm by name, the
 * security line, distance and bearing from the listener, the order of the on-air stack (emergencies pinned on top,
 * then the call being heard), and what the now-playing bar names. The screen only lays these out.
 */
object DispatchView {
    /** P25 algorithm IDs (TIA-102.BAAC), the publicly documented ones. */
    val P25_ALGS: Map<Int, String> = mapOf(
        0x80 to "CLEAR", 0x81 to "DES-OFB", 0x82 to "2-KEY TRIPLE DES", 0x83 to "3-KEY TRIPLE DES", 0x84 to "AES-256", 0x85 to "AES-128",
        0x9f to "DES-XL", 0xa0 to "DVI-XL", 0xa1 to "DVP-XL", 0xaa to "ADP (RC4)",
    )
    private fun hx(v: Int, w: Int) = Integer.toHexString(v).uppercase().padStart(w, '0')
    fun algName(id: Int): String = if (id < 0) "" else P25_ALGS[id] ?: "ALGID 0x${hx(id, 2)}"

    /** The call's security in words: "CLEAR", "ENCRYPTED" with the algorithm and key when heard, or "" when unknown. */
    fun secText(c: CallRow): String {
        if (c.encrypted) {
            val parts = arrayListOf("ENCRYPTED")
            // DMR: the privacy header's algorithm by name (DMR Association IDs) and its key
            if (c.proto == "DMR") { if (c.pi.isNotEmpty() && c.algId >= 0) { parts.add(dmrAlgName(c.algId)); parts.add("KEY ${c.keyId}") } else if (c.pi.isNotEmpty()) parts.add("PRIVACY HEADER") }
            // NXDN: the cipher type of the VCALL (TS 1-A 6.5.27) and its 6-bit key ID
            else if (c.proto == "NXDN") { if (c.algId > 0) parts.add(NXDN_CIPHERS.getOrNull(c.algId) ?: "CIPHER ${c.algId}"); if (c.keyId > 0) parts.add("KEY ${c.keyId}") }
            else {
                if (c.algId >= 0 && c.algId != 0x80) parts.add(algName(c.algId))
                if (c.keyId > 0) parts.add("KEY 0x${hx(c.keyId, 4)}")
            }
            return parts.joinToString(" · ")
        }
        return if (c.sec == "clear") "CLEAR" else ""
    }
    /** Where the security came from, for the detail line. */
    val SEC_FROM: Map<String, String> = mapOf(
        "grant" to "grant service options", "LDU1" to "voice link control", "LDU2" to "encryption sync", "HDU" to "call header", "LC" to "voice link control",
        "EMB" to "voice burst privacy bit", "PI" to "privacy header", "assumed" to "nothing on the air marked it encrypted",
        "VCALL" to "voice call message", "SCCH" to "Type-D signaling channel", "MAC" to "Phase 2 push to talk", "ESS" to "Phase 2 encryption sync", "history" to "earlier calls of this talkgroup were encrypted, and no push to talk said otherwise",
        "analog" to "analog FM voice heard on the channel",
    )

    private const val R_MI = 3958.8
    data class DistBearing(val mi: Double, val deg: Double, val dir: String)
    /** Great-circle distance in miles and the initial bearing in degrees, from [a] to [b] (lat, lon). */
    fun distBearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): DistBearing {
        val r = Math.PI / 180; val p1 = aLat * r; val p2 = bLat * r; val dp = (bLat - aLat) * r; val dl = (bLon - aLon) * r
        val h = sin(dp / 2).let { it * it } + cos(p1) * cos(p2) * sin(dl / 2).let { it * it }
        val mi = 2 * R_MI * asin(min(1.0, sqrt(h)))
        val y = sin(dl) * cos(p2); val x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
        val deg = (atan2(y, x) / r + 360) % 360
        return DistBearing(mi, deg, listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")[(deg / 45).roundToInt() % 8])
    }
    /** "2.4 mi NE" or "3.9 km NE" (feet or meters when close), in the units picked in Settings. */
    fun distText(d: DistBearing, u: UnitSystem = Units.current): String = "${Units.fmtDist(d.mi * Units.KM_PER_MI, u)} ${d.dir}"
    /** The position line of a call: distance and bearing from the listener when known, then the coordinates. */
    fun posText(p: CallPos, me: Pair<Double, Double>?): String {
        val at = String.format(java.util.Locale.US, "%.5f, %.5f", p.lat, p.lon)
        return if (me != null) "${distText(distBearing(me.first, me.second, p.lat, p.lon))} · $at" else at
    }

    /** Emergencies stay pinned on top this long after they end. */
    const val EMERGENCY_PIN_MS = 60_000L
    /**
     * The on-air stack: emergencies first (and for a minute after they end), then the call being heard, then the rest in
     * the order the receiver ranks them. Calls outside the lock go last.
     */
    fun onAirOrder(calls: List<CallRow>, playing: String, now: Long): List<CallRow> {
        val shown = calls.filter { it.kind == "call" && (it.onAir || (it.emergency && now - it.endMs < EMERGENCY_PIN_MS)) }
        fun rank(c: CallRow) = if (c.outside) 4 else if (c.emergency) 0 else if (c.key == playing) 1 else if (c.onAir) 2 else 3
        return shown.withIndex().sortedWith { a, b ->
            val r = rank(a.value).compareTo(rank(b.value))
            if (r != 0) r else if (a.value.emergency && b.value.emergency) b.value.startMs.compareTo(a.value.startMs) else a.index.compareTo(b.index)
        }.map { it.value }
    }
    /**
     * A card with nothing to hear or name: no talkgroup read and no audio, not the call being heard and not an emergency.
     * These fold into one line under the stack, like the encrypted calls, so they never push a call with audio out.
     */
    fun unnamedQuiet(c: CallRow, playing: String): Boolean = !c.encrypted && c.tg == 0 && c.audioMs <= 0 && c.key != playing && !c.emergency
    /** What the now-playing bar names, or null when nothing is heard. */
    fun nowPlaying(calls: List<CallRow>, playing: String): CallRow? = if (playing.isNotEmpty()) calls.firstOrNull { it.key == playing && it.onAir } else null
    /** The talkgroup or unit a call is to, as the cards name it. */
    fun callWho(c: CallRow): String = if (c.tg != 0) "${if (c.group) "TG" else "UNIT"} ${c.tg}" else "UNKNOWN TALKGROUP"

    // ------------------------------------------------------------------------------------------------ detail cards
    /** What a unit's track says: reports placed, time span, distance covered, the latest speed and course, moving or not. */
    data class TrackStats(val fixes: Int, val spanMs: Long, val mi: Double, val mph: Double?, val course: Int?, val dir: String, val moving: Boolean, val lastMs: Long)
    /** Speed and course come from the last two fixes (at least 20 s apart); a unit doing under 3 mph is stopped. */
    fun trackStats(trail: List<TrailPt>): TrackStats {
        val n = trail.size
        var mi = 0.0
        for (i in 1 until n) mi += distBearing(trail[i - 1].lat, trail[i - 1].lon, trail[i].lat, trail[i].lon).mi
        var mph: Double? = null; var course: Int? = null; var dir = ""; var moving = false
        for (i in n - 1 downTo 1) {
            val a = trail[i - 1]; val b = trail[n - 1]; val dt = (b.ms - a.ms) / 3_600_000.0
            if (dt * 3600 < 20) continue
            val d = distBearing(a.lat, a.lon, b.lat, b.lon)
            val v = d.mi / dt; mph = v; moving = v >= 3
            if (moving) { course = d.deg.roundToInt(); dir = d.dir }
            break
        }
        return TrackStats(n, if (n > 1) trail[n - 1].ms - trail[0].ms else 0L, mi, mph, course, dir, moving, if (n > 0) trail[n - 1].ms else 0L)
    }
    /** Counts of [times] in [n] equal buckets over the [spanMs] up to [now] (oldest first). */
    fun activityBuckets(times: List<Long>, now: Long, spanMs: Long, n: Int): IntArray {
        val b = IntArray(n); val w = spanMs.toDouble() / n
        for (t in times) { val i = kotlin.math.floor((t - (now - spanMs)) / w).toInt(); if (i in 0 until n) b[i]++ }
        return b
    }
    /** A small map of positions fitted to a box: the track, the other units, the listener, and a round scale bar. */
    data class TrackFit(val track: List<Pair<Float, Float>>, val others: List<Pair<Float, Float>>, val me: Pair<Float, Float>?, val barPx: Float, val barLabel: String)
    /**
     * An equirectangular fit of [trail], [others] and [me] into [w] by [h] with a margin, at least 600 m across so one
     * fix is not a single point blown up; the scale bar is a round distance near a quarter of the width. Null with nothing to draw.
     */
    fun trackFit(trail: List<TrailPt>, others: List<Pair<Double, Double>>, me: Pair<Double, Double>?, w: Float, h: Float, pad: Float = 14f): TrackFit? {
        val pts = ArrayList<Pair<Double, Double>>(); trail.forEach { pts.add(it.lat to it.lon) }; pts.addAll(others); if (me != null) pts.add(me)
        if (pts.isEmpty() || w <= 2 * pad || h <= 2 * pad) return null
        var la0 = pts.minOf { it.first }; var la1 = pts.maxOf { it.first }; var lo0 = pts.minOf { it.second }; var lo1 = pts.maxOf { it.second }
        val k = cos((la0 + la1) / 2 * Math.PI / 180)
        val minDeg = 0.0055
        if (la1 - la0 < minDeg) { val c = (la0 + la1) / 2; la0 = c - minDeg / 2; la1 = c + minDeg / 2 }
        if ((lo1 - lo0) * k < minDeg) { val c = (lo0 + lo1) / 2; lo0 = c - minDeg / k / 2; lo1 = c + minDeg / k / 2 }
        val s = min((w - 2 * pad) / ((lo1 - lo0) * k), (h - 2 * pad) / (la1 - la0))
        val cx = (lo0 + lo1) / 2; val cy = (la0 + la1) / 2
        fun xy(lat: Double, lon: Double) = (w / 2 + (lon - cx) * k * s).toFloat() to (h / 2 - (lat - cy) * s).toFloat()
        val kmPerPx = 111.32 / s; val want = kmPerPx * w / 4
        val km = listOf(0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0).firstOrNull { it >= want } ?: want
        val label = Units.fmtDist(km)
        return TrackFit(trail.map { xy(it.lat, it.lon) }, others.map { xy(it.first, it.second) }, me?.let { xy(it.first, it.second) }, (km / kmPerPx).toFloat(), label)
    }
    /** Encrypted share of a set of calls: encrypted, total (calls only, not CW IDs). */
    fun encShare(calls: List<CallRow>): Pair<Int, Int> { val v = calls.filter { it.kind == "call" }; return v.count { it.encrypted } to v.size }
    /** The security of a set of calls in a word: "CLEAR", "ENCRYPTED" or "n% ENCRYPTED", or "" with no calls. */
    fun encWord(calls: List<CallRow>): String {
        val (e, n) = encShare(calls)
        return if (n == 0) "" else if (e == 0) "CLEAR" else if (e == n) "ENCRYPTED" else "${(100.0 * e / n).roundToInt()}% ENCRYPTED"
    }
    /** How long ago, short: "now", "42 s", "7 min", "3 h", "2 d". */
    fun agoShort(ms: Long): String = when {
        ms < 5_000 -> "now"; ms < 60_000 -> "${ms / 1000} s"; ms < 3_600_000 -> "${ms / 60_000} min"; ms < 86_400_000 -> "${ms / 3_600_000} h"; else -> "${ms / 86_400_000} d"
    }
    /** A span of time, short: "45 s", "12 min", "3.5 h". */
    fun spanShort(ms: Long): String = if (ms < 60_000) "${(ms / 1000.0).roundToInt()} s" else if (ms < 3_600_000) "${(ms / 60_000.0).roundToInt()} min"
        else String.format(java.util.Locale.US, "%.1f h", ms / 3_600_000.0)

    /** A talkgroup as a tile on the Dispatch grid: who it is, how lately it was heard, whether it is encrypted, followed. */
    data class TgTile(val key: String, val sys: String, val tg: Int, val live: Boolean, val lastMs: Long, val sec: String, val calls: Int, val grants: Int,
                      val followed: Boolean, val muted: Boolean, val emergency: Boolean)
    /**
     * The talkgroup tiles, from the talkgroups the control channels granted and the group calls heard (a conventional DMR
     * or NXDN talkgroup has calls and no grants). The followed one leads, then emergencies, then the ones on the air,
     * then the most lately heard; [max] keeps the grid short.
     */
    fun tgTiles(tgs: List<TgRow>, calls: List<CallRow>, prefs: TgPrefs, now: Long, max: Int = 200): List<TgTile> {
        class T(val sys: String, val tg: Int) { var live = false; var lastMs = 0L; var calls = 0; var grants = 0; var emergency = false; var enc = 0 }
        val by = LinkedHashMap<String, T>()
        fun tile(sys: String, tg: Int) = by.getOrPut("$sys/$tg") { T(sys, tg) }
        for (g in tgs) { val t = tile(g.sys, g.tg); t.grants = g.grants; t.lastMs = maxOf(t.lastMs, g.lastMs) }
        for (c in calls) {
            if (c.kind != "call" || !c.group || c.tg == 0) continue
            val t = tile(c.sys, c.tg)
            t.calls++; t.live = t.live || c.onAir; t.lastMs = maxOf(t.lastMs, if (c.onAir) now else if (c.endMs != 0L) c.endMs else c.startMs)
            if (c.emergency && (c.onAir || now - c.endMs < EMERGENCY_PIN_MS)) t.emergency = true
            if (c.encrypted) t.enc++
        }
        // a followed talkgroup stays on the grid even before it is heard again
        if (prefs.hold.isNotEmpty() && !by.containsKey(prefs.hold)) {
            val i = prefs.hold.lastIndexOf('/'); val tg = prefs.hold.substring(i + 1).toIntOrNull() ?: 0
            if (i > 0 && tg > 0) tile(prefs.hold.substring(0, i), tg)
        }
        val out = by.map { (k, t) ->
            val sec = if (t.calls == 0) "" else if (t.enc == 0) "CLEAR" else if (t.enc == t.calls) "ENCRYPTED" else "${(100.0 * t.enc / t.calls).roundToInt()}% ENCRYPTED"
            TgTile(k, t.sys, t.tg, t.live, t.lastMs, sec, t.calls, t.grants, prefs.hold == k, k in prefs.mute, t.emergency)
        }
        fun rank(t: TgTile) = if (t.followed) 0 else if (t.emergency) 1 else if (t.live) 2 else 3
        return out.sortedWith(compareBy<TgTile>({ rank(it) }, { -it.lastMs }, { it.key })).take(max)
    }
    /** What a tap on the talkgroup grid does to the follow (the HOLD preference): ALL ("") hears every talkgroup again,
     *  a tile follows that talkgroup, and a tap on the followed tile goes back to ALL. */
    fun followTap(hold: String, key: String): String = if (key.isEmpty() || hold == key) "" else key
    /** What the listen line says: every talkgroup, or only the followed one (and on which system lock). */
    fun listenText(hold: String, lock: Lock?): String {
        if (hold.isNotEmpty()) return "only TG ${hold.substring(hold.lastIndexOf('/') + 1)} is heard${if (lock != null) ", locked on ${lock.label}" else ""}"
        return if (lock != null) "every talkgroup on ${lock.label}, first to talk is heard" else "every talkgroup, first to talk is heard"
    }
    /** A call's or system's protocol as its badge says it: P25, P25 P2 (a Phase 2 TDMA call), DMR, NXDN, TETRA, TYPE II. */
    fun protoLabel(proto: String, tdma: Boolean = false): String = if (proto == "SMARTNET") "TYPE II" else if (proto == "P25" && tdma) "P25 P2" else proto
}
