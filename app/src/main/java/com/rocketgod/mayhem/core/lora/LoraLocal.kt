package com.rocketgod.mayhem.core.lora

import android.content.Context
import android.content.SharedPreferences
import com.rocketgod.mayhem.core.Geo
import java.util.Locale
import kotlin.math.abs

/**
 * Not a port: which LoRa networks are local. MeshCore's community presets as its own app lists them (fetched from
 * api.meshcore.nz/api/v1/config, suggested_radio_settings, on 2026-11-13; see MeshCore docs/radio_presets.md), the
 * Meshtastic region each country uses, and the choice of where to listen: the user's own pick, else where the device
 * is (GPS, through the country it reverse-geocodes to), else the device's region setting. Nothing is assumed for
 * everyone: mesh users are worldwide. Kotlin twin of the iOS LoraLocal.swift.
 */
object LoraLocal {
    /** One of MeshCore's community presets. [area] is the country (ISO code), "EU" for Europe as a whole, or a part
     *  of a country ("US-SOCAL"). */
    class McPreset(val title: String, val hz: Long, val bw: Int, val sf: Int, val area: String)

    val MESHCORE: List<McPreset> = listOf(
        McPreset("Australia", 915_800_000, 250_000, 10, "AU"),
        McPreset("Australia (Narrow)", 916_575_000, 62_500, 7, "AU"),
        McPreset("Australia (Mid)", 915_075_000, 125_000, 9, "AU"),
        McPreset("Australia: SA, WA", 923_125_000, 62_500, 8, "AU-SAWA"),
        McPreset("Australia: QLD", 923_125_000, 62_500, 8, "AU-QLD"),
        McPreset("Brazil", 923_125_000, 62_500, 8, "BR"),
        McPreset("Canada", 910_525_000, 62_500, 7, "CA"),
        McPreset("Costa Rica", 910_525_000, 125_000, 11, "CR"),
        McPreset("EU/UK (Narrow)", 869_618_000, 62_500, 8, "EU"),
        McPreset("EU/UK (Deprecated)", 869_525_000, 250_000, 11, "EU"),
        McPreset("Czech Republic (Narrow)", 869_432_000, 62_500, 7, "CZ"),
        McPreset("EU 433MHz (Long Range)", 433_650_000, 250_000, 11, "EU"),
        McPreset("EU 433MHz (Narrow)", 433_650_000, 62_500, 8, "EU"),
        McPreset("Hungary", 869_618_000, 62_500, 7, "HU"),
        McPreset("Netherlands", 869_618_000, 62_500, 7, "NL"),
        McPreset("Netherlands (Limburg)", 869_618_000, 62_500, 8, "NL-LI"),
        McPreset("New Zealand (Narrow)", 917_375_000, 62_500, 7, "NZ"),
        McPreset("New Zealand (Gisborne)", 917_375_000, 250_000, 11, "NZ-GIS"),
        McPreset("Portugal 433", 433_375_000, 62_500, 9, "PT"),
        McPreset("Portugal 868", 869_618_000, 62_500, 7, "PT"),
        McPreset("Slovakia", 869_618_000, 62_500, 7, "SK"),
        McPreset("Switzerland", 869_618_000, 62_500, 8, "CH"),
        McPreset("Thailand", 921_000_000, 62_500, 7, "TH"),
        McPreset("USA", 910_525_000, 62_500, 7, "US"),
        McPreset("USA - Southern California", 927_875_000, 62_500, 7, "US-SOCAL"),
        McPreset("Vietnam (Narrow)", 920_250_000, 62_500, 8, "VN"),
        McPreset("Vietnam (Deprecated)", 920_250_000, 250_000, 11, "VN"),
    )

    /** Europe as MeshCore's "EU/UK" presets mean it. */
    val EUROPE: Set<String> = setOf("GB", "IE", "FR", "DE", "NL", "BE", "LU", "ES", "PT", "IT", "AT", "CH", "LI", "DK", "SE", "NO", "FI", "IS",
        "PL", "CZ", "SK", "HU", "SI", "HR", "RO", "BG", "GR", "CY", "MT", "EE", "LV", "LT", "RS", "BA", "ME", "MK",
        "AL", "MD", "UA", "MC", "SM", "AD", "VA", "GI", "XK", "FO")

    /** A rough box: latitude low and high, longitude low and high. */
    private class Box(val latLo: Double, val latHi: Double, val lonLo: Double, val lonHi: Double)

    /** Parts of a country with their own preset, by rough bounds. */
    private val PARTS: List<Pair<String, List<Box>>> = listOf(
        "US-SOCAL" to listOf(Box(32.5, 35.8, -121.0, -114.1)),
        "AU-SAWA" to listOf(Box(-35.2, -13.7, 112.9, 129.0), Box(-38.1, -26.0, 129.0, 141.0)),
        "AU-QLD" to listOf(Box(-29.2, -10.0, 138.0, 153.6)),
        "NL-LI" to listOf(Box(50.75, 51.78, 5.56, 6.23)),
        "NZ-GIS" to listOf(Box(-39.0, -37.5, 177.0, 178.7)),
    )

    /** The Meshtastic region (LoraPlan.regions) each country uses. */
    fun meshtasticRegion(cc: String): String? = when (cc) {
        "US", "CA", "MX", "PR", "GU", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "JM", "TT", "BS", "CU" -> "US"
        "BR" -> "BR_902"
        "AU", "NZ" -> "ANZ"
        "JP" -> "JP"
        "KR" -> "KR"
        "TW" -> "TW"
        "TH" -> "TH"
        "IN" -> "IN"
        "MY" -> "MY_919"
        "SG" -> "SG_923"
        "PH" -> "PH_915"
        "CN" -> "CN"
        "RU" -> "RU"
        "KZ" -> "KZ_863"
        "NP" -> "NP_865"
        else -> if (cc in EUROPE || cc in setOf("ZA", "IL", "TR", "AE", "SA", "EG", "MA", "KE", "NG")) "EU_868" else null
    }

    // ---- where the user is ----

    /** An area someone can pick: "AUTO", a country, or a part of one. */
    class Area(val id: String, val title: String)

    @Volatile private var prefs: SharedPreferences? = null
    /** Without a context (unit tests) the values live here instead. */
    private val mem = HashMap<String, Any?>()

    fun init(ctx: Context) {
        if (prefs == null) prefs = ctx.applicationContext.getSharedPreferences("mayhem", Context.MODE_PRIVATE)
    }

    private fun str(k: String): String? = prefs?.getString(k, null) ?: synchronized(mem) { mem[k] as? String }
    private fun putStr(k: String, v: String?) { val p = prefs; if (p != null) p.edit().putString(k, v).apply() else synchronized(mem) { mem[k] = v } }
    private fun long(k: String): Long = prefs?.getLong(k, 0L) ?: synchronized(mem) { mem[k] as? Long } ?: 0L
    private fun int(k: String, def: Int): Int = prefs?.getInt(k, def) ?: synchronized(mem) { mem[k] as? Int } ?: def

    /** The user's own pick ("AUTO" when none). */
    var picked: String
        get() = str("lora_area") ?: "AUTO"
        set(v) { putStr("lora_area", v); changed() }

    /** The country the device's position reverse-geocoded to (the app sets it), kept between visits. */
    var gpsCountry: String?
        get() = str("geo_cc")
        set(v) { if (v != gpsCountry) { putStr("geo_cc", v); changed() } }

    /** The area in use: the user's pick, else the GPS country (and the part of it the position is in), else the device's
     *  region setting. */
    fun area(): String {
        val p = picked
        if (p != "AUTO") return p
        val cc = gpsCountry ?: Locale.getDefault().country.orEmpty()
        val pos = Geo.fix.value ?: Geo.lastKnownPos()
        if (pos != null) {
            for ((part, boxes) in PARTS) {
                if (!part.startsWith("$cc-")) continue
                if (boxes.any { pos.first >= it.latLo && pos.first <= it.latHi && pos.second >= it.lonLo && pos.second <= it.lonHi }) return part
            }
        }
        return cc
    }

    fun country(area: String): String = area.substringBefore('-')

    /** The MeshCore presets for an area, its own part's first, then its country's, then Europe's. */
    fun meshcore(area: String): List<McPreset> {
        val cc = country(area)
        return MESHCORE.filter { it.area == area && area.contains('-') } +
            MESHCORE.filter { it.area == cc } +
            (if (cc in EUROPE) MESHCORE.filter { it.area == "EU" } else emptyList())
    }

    /** One channel an area listens for. */
    data class Local(val hz: Long, val bw: Int, val sf: Int, val name: String)

    /** Everything an area listens for first, most local first. */
    fun channels(area: String): List<Local> {
        val out = ArrayList<Local>()
        meshcore(area).mapTo(out) { Local(it.hz, it.bw, it.sf, "MeshCore ${it.title}") }
        val rn = meshtasticRegion(country(area))
        val r = rn?.let { n -> LoraPlan.regions.firstOrNull { it.name == n } }
        if (rn != null && r != null) {
            // LongTurbo is the US default from Meshtastic 2.8 (channel 0 resolves to slot 14, 908.75 MHz) and where
            // SoCal's mesh moved; MediumFast is widely used everywhere (many European meshes moved to it for airtime). A
            // region with room for one slot (EU_868) puts it on LongFast's frequency at another spreading factor
            val names = ArrayList(if (rn == "US") listOf("LongTurbo", r.start, "MediumFast") else listOf(r.start))
            if (rn == "ANZ") names += listOf("LongTurbo")
            if (rn != "US") names += "MediumFast"
            for (n in names) {
                val p = r.presets.firstOrNull { it.name == n } ?: continue
                val hz = LoraPlan.slotHz(r, p) ?: continue
                out.add(Local(hz, p.bw, p.sf, "Meshtastic ${p.name} $rn"))
            }
        }
        custom?.let { out.add(0, Local(it.hz, it.bw, it.sf, "Custom")) }
        return out
    }

    /** The areas offered to pick from: automatic, then every country or part with a preset of its own. */
    fun areas(): List<Area> {
        val ids = ArrayList<String>()
        for (p in MESHCORE) if (p.area != "EU" && p.area !in ids) ids.add(p.area)
        for (cc in listOf("GB", "DE", "FR", "IT", "ES", "JP", "KR", "TW", "IN", "MY", "SG", "PH", "CN", "RU", "KZ", "NP", "MX", "ZA")) if (cc !in ids) ids.add(cc)
        val named = ids.map { Area(it, title(it)) }.sortedBy { it.title }
        return listOf(Area("AUTO", "Automatic")) + named
    }

    private val PART_TITLES = mapOf("US-SOCAL" to "USA · Southern California", "AU-SAWA" to "Australia · SA, WA", "AU-QLD" to "Australia · QLD",
        "NL-LI" to "Netherlands · Limburg", "NZ-GIS" to "New Zealand · Gisborne")

    fun title(area: String): String {
        if (area == "AUTO") return "Automatic"
        PART_TITLES[area]?.let { return it }
        if (area.isEmpty()) return "Unknown"
        return Locale("", area).getDisplayCountry(Locale.US).ifEmpty { area }
    }

    // ---- a channel of the user's own ----

    class Custom(val hz: Long, val bw: Int, val sf: Int)

    var custom: Custom?
        get() {
            val hz = long("lora_custom_hz")
            return if (hz > 0) Custom(hz, int("lora_custom_bw", 125_000), int("lora_custom_sf", 7)) else null
        }
        set(c) {
            val p = prefs
            if (p != null) {
                val e = p.edit()
                if (c != null) e.putLong("lora_custom_hz", c.hz).putInt("lora_custom_bw", c.bw).putInt("lora_custom_sf", c.sf)
                else e.putLong("lora_custom_hz", 0L)
                e.apply()
            } else synchronized(mem) {
                if (c != null) { mem["lora_custom_hz"] = c.hz; mem["lora_custom_bw"] = c.bw; mem["lora_custom_sf"] = c.sf }
                else mem["lora_custom_hz"] = 0L
            }
            changed()
        }

    // ---- where to center ----

    /** The area's Meshtastic default channel: its region's starting preset (LongFast in most), the busiest Meshtastic
     *  channel almost everywhere. Null where no Meshtastic region is known. */
    fun meshtasticDefault(area: String): Local? {
        val rn = meshtasticRegion(country(area)) ?: return null
        val r = LoraPlan.regions.firstOrNull { it.name == rn } ?: return null
        val p = r.presets.firstOrNull { it.name == r.start } ?: return null
        val hz = LoraPlan.slotHz(r, p) ?: return null
        return Local(hz, p.bw, p.sf, "Meshtastic ${p.name} $rn")
    }

    /**
     * The wide span's center at [rate]. The user's own channel and the area's Meshtastic default channel are always in
     * view; then, from each channel in turn (most local first), every other one that still fits inside the radio's
     * filter is taken, most local first; the window holding the most wins, the more local start breaking a tie
     * (Portugal's 868 channels outnumber its 433). Leftover room goes toward the channels that didn't fit but are in
     * reach of the band (433 MHz presets never pull an 868 MHz view). Kept off the spike at the center.
     */
    fun wideCenter(area: String, rate: Int = LoraPlan.WIDE_RATE): Long? {
        val ch = channels(area)
        if (ch.isEmpty()) return null
        val half = LoraScanner.usableHalf(rate).toLong()
        // what must be in view: the user's own channel (first in the list), then the Meshtastic default if both fit
        val must = ArrayList<Int>()
        if (custom != null) must.add(0)
        val md = meshtasticDefault(area)
        val mi = if (md == null) -1 else ch.indexOfFirst { it.hz == md.hz && it.bw == md.bw }
        if (mi >= 0 && mi !in must) {
            val set = must + mi
            val lo = set.minOf { ch[it].hz - ch[it].bw / 2 }; val hi = set.maxOf { ch[it].hz + ch[it].bw / 2 }
            if (hi - lo <= 2 * half) must.add(mi)
        }
        var bestLo = 0L; var bestHi = 0L; var bestN = -1; var bestOut: List<Long> = emptyList(); var bestHeld: List<Int> = emptyList()
        for (start in -1 until ch.size) {
            if (start < 0 && must.isEmpty()) continue
            var lo = Long.MAX_VALUE; var hi = Long.MIN_VALUE
            val held = ArrayList<Int>(); val out = ArrayList<Long>()
            fun take(i: Int): Boolean {
                val l = minOf(lo, ch[i].hz - ch[i].bw / 2); val h = maxOf(hi, ch[i].hz + ch[i].bw / 2)
                if (h - l > 2 * half) return false
                lo = l; hi = h; held.add(i)
                return true
            }
            for (i in must) take(i)
            if (start >= 0 && start !in held && !take(start)) continue
            for ((i, c) in ch.withIndex()) {
                if (i in held || take(i)) continue
                if (abs(c.hz - (lo + hi) / 2) < 3 * half) out.add(c.hz)
            }
            if (held.size > bestN) { bestLo = lo; bestHi = hi; bestN = held.size; bestOut = out; bestHeld = held }
        }
        val lo = bestLo; val hi = bestHi; val out = bestOut
        var center = (lo + hi) / 2
        val slack = half - (hi - lo) / 2
        if (slack > 0 && out.isNotEmpty()) {
            val toward = out.sum() / out.size
            center += if (toward > center) slack else -slack
        }
        // off the spike, to whichever side keeps every held channel in view
        ch.firstOrNull { abs(it.hz - center) < it.bw }?.let { near ->
            fun fits(x: Long) = bestHeld.all { abs(ch[it].hz - x) + ch[it].bw / 2 <= half }
            listOf(near.hz + near.bw + 100_000, near.hz - near.bw - 100_000).firstOrNull { fits(it) }?.let { center = it }
        }
        return center
    }

    /** One channel at a time (a 2 MHz radio): the user's own, else the area's Meshtastic default, else the most local. */
    fun narrowChannel(area: String): Long? {
        if (custom != null) return channels(area).firstOrNull()?.hz
        return meshtasticDefault(area)?.hz ?: channels(area).firstOrNull()?.hz
    }

    /** Every area this object knows a Meshtastic region or MeshCore preset for (for tests and tools). */
    fun knownAreas(): List<String> {
        val ids = LinkedHashSet<String>()
        ids += listOf("US", "CA", "MX", "PR", "GU", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "JM", "TT", "BS", "CU",
            "BR", "AU", "NZ", "JP", "KR", "TW", "TH", "IN", "MY", "SG", "PH", "CN", "RU", "KZ", "NP", "ZA", "IL", "TR", "AE", "SA", "EG", "MA", "KE", "NG")
        ids += EUROPE
        PARTS.mapTo(ids) { it.first }
        for (p in MESHCORE) if (p.area != "EU") ids.add(p.area)
        for (a in areas()) if (a.id != "AUTO") ids.add(a.id)
        return ids.toList()
    }

    /** Something the plan depends on changed: the scanner places its channels again. */
    @Volatile var onChange: (() -> Unit)? = null
    /** Counts the changes, so a screen showing the area or the user's channel redraws. */
    private val _version = kotlinx.coroutines.flow.MutableStateFlow(0)
    val version: kotlinx.coroutines.flow.StateFlow<Int> = _version
    private fun changed() { LoraPlan.invalidate(); _version.value = _version.value + 1; onChange?.invoke() }
}

