package com.rocketgod.mayhem.core.fleet

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
            // DMR algorithm IDs have no public table: shown by number
            if (c.proto == "DMR") { if (c.pi.isNotEmpty() && c.algId >= 0) { parts.add("ALGID 0x${hx(c.algId, 2)}"); parts.add("KEY ${c.keyId}") } else if (c.pi.isNotEmpty()) parts.add("PRIVACY HEADER") }
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
        "MAC" to "Phase 2 push to talk", "ESS" to "Phase 2 encryption sync", "history" to "earlier calls of this talkgroup were encrypted, and no push to talk said otherwise",
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
    /** "2.4 mi NE" (or feet under a tenth of a mile). */
    fun distText(d: DistBearing): String =
        if (d.mi < 0.1) "${(d.mi * 5280).roundToInt()} ft ${d.dir}" else "${if (d.mi < 10) String.format(java.util.Locale.US, "%.1f", d.mi) else d.mi.roundToInt().toString()} mi ${d.dir}"
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
}
