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
            // SoCal's mesh moved; LongFast and MediumFast are still widely used
            val names = ArrayList(if (rn == "US") listOf("LongTurbo", r.start, "MediumFast") else listOf(r.start))
            if (rn == "ANZ") names += listOf("LongTurbo", "MediumFast")
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

    /**
     * The wide span's center that holds the most local channels, the most local first: each is added while the
     * whole set still fits inside the radio's filter. Leftover room goes toward the channels that didn't fit (more of
     * the band they are in). Kept off the spike at the center.
     */
    fun wideCenter(area: String): Long? {
        val ch = channels(area)
        val first = ch.firstOrNull() ?: return null
        val half = LoraScanner.usableHalf(LoraScanner.RATE).toLong()
        var lo = first.hz - first.bw / 2; var hi = first.hz + first.bw / 2
        val out = ArrayList<Long>()
        for (c in ch.drop(1)) {
            val l = minOf(lo, c.hz - c.bw / 2); val h = maxOf(hi, c.hz + c.bw / 2)
            if (h - l <= 2 * half) { lo = l; hi = h } else out.add(c.hz)
        }
        var center = (lo + hi) / 2
        val slack = half - (hi - lo) / 2
        if (slack > 0 && out.isNotEmpty()) {
            val toward = out.sum() / out.size
            center += if (toward > center) slack else -slack
        }
        ch.firstOrNull { abs(it.hz - center) < it.bw }?.let { center = it.hz + it.bw + 100_000 }
        return center
    }

    /** One channel at a time (a 2 MHz radio): the most local one. */
    fun narrowChannel(area: String): Long? = channels(area).firstOrNull()?.hz

    /** Something the plan depends on changed: the scanner places its channels again. */
    @Volatile var onChange: (() -> Unit)? = null
    /** Counts the changes, so a screen showing the area or the user's channel redraws. */
    private val _version = kotlinx.coroutines.flow.MutableStateFlow(0)
    val version: kotlinx.coroutines.flow.StateFlow<Int> = _version
    private fun changed() { LoraPlan.invalidate(); _version.value = _version.value + 1; onChange?.invoke() }
}

