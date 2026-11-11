package com.rocketgod.mayhem.core.lora

import java.util.Locale

/**
 * A channel with a known modem. [standing]: listened to all the time while inside the span (a far node's packet is
 * below the noise in any one bin and never shows up as a burst, but its own channel's receivers still decode it:
 * LoRa works under the noise).
 */
data class LoraChannel(val hz: Long, val bw: Int, val sf: Int?, val name: String, val standing: Boolean = false)

/**
 * Not a Mayhem port: where LoRa networks sit, worldwide. Meshtastic's regions, presets and frequency-slot rule as its
 * firmware defines them (src/mesh/RadioInterface.cpp, MeshRadio.h, DisplayFormatters.cpp), MeshCore's regional
 * presets, and the LoRaWAN channel plans. Kotlin twin of the iOS LoraPlan.swift.
 */
object LoraPlan {
    /** A Meshtastic preset: its display name (also the default channel's name), bandwidth, spreading factor. */
    class Preset(val name: String, val bw: Int, val sf: Int)

    val STD = listOf(Preset("LongFast", 250_000, 11), Preset("LongSlow", 125_000, 12),
        Preset("MediumSlow", 250_000, 10), Preset("MediumFast", 250_000, 9),
        Preset("ShortSlow", 250_000, 8), Preset("ShortFast", 250_000, 7),
        Preset("LongMod", 125_000, 11), Preset("ShortTurbo", 500_000, 7),
        Preset("LongTurbo", 500_000, 11), Preset("MediumTurbo", 500_000, 9))
    val LITE = listOf(Preset("LiteFast", 125_000, 9), Preset("LiteSlow", 125_000, 10))
    val NARROW = listOf(Preset("NarrowFast", 62_500, 7), Preset("NarrowSlow", 62_500, 8))
    val allPresetNames: List<String> get() = (STD + LITE + NARROW).map { it.name }

    /**
     * A Meshtastic region: band edges (MHz), its presets, slot spacing and padding (MHz), a fixed slot (1-based, 0 =
     * by the channel name's hash), and the preset a new node starts on.
     */
    class Region(val name: String, val lo: Double, val hi: Double, val presets: List<Preset>, val spacing: Double, val padding: Double, val slot: Int, val start: String)

    val regions: List<Region> = run {
        fun std(n: String, lo: Double, hi: Double) = Region(n, lo, hi, STD, 0.0, 0.0, 0, "LongFast")
        listOf(std("US", 902.0, 928.0), std("EU_433", 433.0, 434.0),
            Region("EU_868", 869.4, 869.65, STD.take(7), 0.0, 0.0, 0, "LongFast"),
            Region("EU_866", 865.6, 867.6, LITE, 0.4, 0.0375, 0, "LiteFast"),
            Region("EU_N_868", 869.4, 869.65, NARROW, 0.0, 0.0104, 1, "NarrowSlow"),
            std("CN", 470.0, 510.0), std("JP", 920.5, 923.5), std("ANZ", 915.0, 928.0), std("ANZ_433", 433.05, 434.79),
            std("RU", 868.7, 869.2), std("KR", 920.0, 923.0), std("TW", 920.0, 925.0), std("IN", 865.0, 867.0), std("NZ_865", 864.0, 868.0),
            std("TH", 920.0, 925.0), std("UA_433", 433.0, 434.7), std("MY_433", 433.0, 435.0), std("MY_919", 919.0, 924.0),
            std("SG_923", 917.0, 925.0), std("PH_433", 433.0, 434.7), std("PH_868", 868.0, 869.4), std("PH_915", 915.0, 918.0),
            std("KZ_433", 433.075, 434.775), std("KZ_863", 863.0, 868.0), std("NP_865", 865.0, 868.0), std("BR_902", 902.0, 907.5))
    }

    fun djb2(s: String): Long { var h = 5381L; for (c in s.toByteArray(Charsets.UTF_8)) h = (h * 33 + (c.toInt() and 0xff)) and 0xFFFF_FFFFL; return h }

    /** The default (unnamed) channel of a preset in a region: Hz, or null when the preset does not fit. */
    fun slotHz(r: Region, p: Preset): Long? {
        val bw = p.bw / 1e6
        val width = r.spacing + 2 * r.padding + bw
        val n = Math.round((r.hi - r.lo + r.spacing) / width).toInt()
        if (n <= 0) return null
        val slot = if (r.slot > 0) min(r.slot, n) - 1 else (djb2(p.name) % n).toInt()
        return Math.round((r.lo + bw / 2 + r.padding + slot * width) * 1e6)
    }

    private fun min(a: Int, b: Int) = if (a < b) a else b

    /**
     * Every channel with a known modem, worldwide. standing: listened to all the time once inside the span (each
     * region's starting preset, the newer US default LongTurbo and the popular MediumFast, MeshCore's presets).
     */
    val channels: List<LoraChannel> = run {
        val c = ArrayList<LoraChannel>()
        val index = HashMap<String, Int>()
        fun add(hz: Long, bw: Int, sf: Int?, name: String, standing: Boolean) {
            val k = "$hz/$bw/${sf ?: 0}"
            val i = index[k]
            if (i != null) {
                if (standing && !c[i].standing) c[i] = c[i].copy(standing = true)
                return
            }
            index[k] = c.size
            c.add(LoraChannel(hz, bw, sf, name, standing))
        }
        for (r in regions) for (p in r.presets) {
            val hz = slotHz(r, p) ?: continue
            val standing = p.name == r.start || ((r.name == "US" || r.name == "ANZ") && (p.name == "LongTurbo" || p.name == "MediumFast"))
            add(hz, p.bw, p.sf, "Meshtastic ${p.name} ${r.name}", standing)
        }
        // MeshCore's regional presets
        add(910_525_000, 62_500, 7, "MeshCore US", true)
        add(927_875_000, 62_500, 7, "MeshCore US 927.875", true)
        add(869_618_000, 62_500, 8, "MeshCore EU/UK narrow", true)
        add(869_525_000, 250_000, 11, "MeshCore EU/UK long range", true)
        add(916_575_000, 62_500, 7, "MeshCore ANZ", true)
        // LoRaWAN: US915 / AU915 uplinks (125 kHz every 200 kHz, 500 kHz every 1.6 MHz) and downlinks (500 kHz every 600 kHz)
        for ((base, name) in listOf(902_300_000L to "US915", 915_200_000L to "AU915")) {
            for (k in 0 until 64) add(base + k * 200_000L, 125_000, null, "LoRaWAN $name uplink $k", false)
            for (k in 0 until 8) add(base + 700_000 + k * 1_600_000L, 500_000, null, "LoRaWAN $name uplink ${64 + k}", false)
        }
        for (k in 0 until 8) add(923_300_000L + k * 600_000L, 500_000, null, "LoRaWAN US915/AU915 downlink $k", false)
        // EU868 (the three join channels, the common 867.1-867.9 set, RX2), AS923, KR920, IN865, CN470
        for (f in longArrayOf(868_100_000, 868_300_000, 868_500_000, 867_100_000, 867_300_000, 867_500_000, 867_700_000, 867_900_000)) add(f, 125_000, null, "LoRaWAN EU868", false)
        add(869_525_000, 125_000, 9, "LoRaWAN EU868 RX2", false)
        for (f in longArrayOf(923_200_000, 923_400_000, 922_200_000, 922_400_000, 922_600_000, 922_800_000, 923_000_000, 922_000_000)) add(f, 125_000, null, "LoRaWAN AS923", false)
        for (f in longArrayOf(922_100_000, 922_300_000, 922_500_000)) add(f, 125_000, null, "LoRaWAN KR920", false)
        for (f in longArrayOf(865_062_500, 865_402_500, 865_985_000)) add(f, 125_000, null, "LoRaWAN IN865", false)
        for (k in 0 until 96) add(470_300_000L + k * 200_000L, 125_000, null, "LoRaWAN CN470 uplink $k", false)
        c
    }

    /**
     * The wide-span views: center, title, what is in it. A radio that can't sample wide gets a 2 MHz window on
     * [narrow] (the band's main channel) instead.
     */
    class Band(val title: String, val sub: String, val center: Long, val narrow: Long)

    val bands = listOf(
        Band("903–923", "US · Americas", 913_000_000, 906_875_000),
        Band("908–928", "US upper", 918_000_000, 910_525_000),
        Band("859–879", "Europe · India", 869_000_000, 869_525_000),
        Band("912–932", "ANZ · Asia", 922_000_000, 916_575_000),
        Band("424–444", "433 MHz", 434_000_000, 433_875_000),
        Band("470–490", "China", 480_000_000, 470_300_000),
    )

    /** Where to start: the band for the device's own region setting (not its location). */
    fun homeBand(): Band {
        val cc = Locale.getDefault().country.ifEmpty { "US" }
        val eu = setOf("GB", "IE", "FR", "DE", "NL", "BE", "LU", "ES", "PT", "IT", "AT", "CH", "DK", "SE", "NO", "FI", "IS", "PL", "CZ",
            "SK", "HU", "SI", "HR", "RO", "BG", "GR", "CY", "MT", "EE", "LV", "LT", "RU", "UA", "BY", "RS", "BA", "ME", "MK",
            "AL", "MD", "TR", "IL", "ZA", "IN", "NP", "KZ", "AE", "SA", "EG", "MA", "NG", "KE")
        val asia = setOf("AU", "NZ", "JP", "KR", "TW", "TH", "SG", "MY", "PH", "ID", "VN", "HK")
        if (cc == "CN") return bands[5]
        if (cc in eu) return bands[2]
        if (cc in asia) return bands[3]
        return bands[0]
    }
}
