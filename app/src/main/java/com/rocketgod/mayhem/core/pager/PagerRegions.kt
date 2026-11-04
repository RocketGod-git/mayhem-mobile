package com.rocketgod.mayhem.core.pager

import java.util.Locale

/**
 * Pager band plans by region. Paging sits on different frequencies around the world, so the hunter surveys a
 * region's windows instead of a hard-wired US list. The region is auto-picked from the device locale and can be
 * overridden in the UI. Each window is a center the hunter tunes to and surveys the span around.
 */
object PagerRegions {
    data class Window(val label: String, val centerHz: Long)
    data class Region(val id: String, val label: String, val windows: List<Window>)

    val REGIONS: List<Region> = listOf(
        Region("US", "US / North America", listOf(
            Window("929 MHz", 929_800_000L),
            Window("931 MHz", 931_300_000L),
            Window("152 MHz", 152_500_000L),
            Window("158 MHz", 158_000_000L),
            Window("466 MHz", 466_100_000L),
        )),
        Region("EU", "Europe / NL", listOf(
            Window("P2000 169.65", 169_650_000L),   // NL emergency-services FLEX; EU harmonised paging 169.4-169.8
            Window("DAPNET 439.99", 439_987_500L),  // amateur POCSAG network across the EU
            Window("466 on-site", 466_050_000L),    // commercial on-site POCSAG
            Window("153 MHz", 153_350_000L),
        )),
        Region("UK", "United Kingdom", listOf(
            Window("153 MHz", 153_350_000L),
            Window("466 on-site", 466_075_000L),
            Window("DAPNET 439.99", 439_987_500L),
        )),
    )

    fun byId(id: String?): Region = REGIONS.firstOrNull { it.id == id } ?: REGIONS[0]

    /** ISO-3166 country (e.g. Locale.getDefault().country) → region. US/CA/MX → US, GB → UK, anything else → EU. */
    fun forCountry(country: String?): Region = when (country?.uppercase(Locale.ROOT)) {
        "US", "CA", "MX", "", null -> byId("US")
        "GB" -> byId("UK")
        else -> byId("EU")
    }

    fun auto(): Region = forCountry(runCatching { Locale.getDefault().country }.getOrNull())
}
