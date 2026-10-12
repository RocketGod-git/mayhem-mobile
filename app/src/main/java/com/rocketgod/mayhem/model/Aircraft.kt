package com.rocketgod.mayhem.model

/** One ADS-B aircraft as decoded from Mode-S frames (dump1090-style fields). Mutable: newest field values win. */
class Aircraft(val icao: String) {
    var flight: String? = null
    var lat: Double? = null
    var lon: Double? = null
    var altBaro: Int? = null
    var gs: Int? = null
    var track: Int? = null
    var vertRate: Int? = null
    var squawk: String? = null
    /** UTC timestamp of the newest frame, as 14-digit YYYYMMDDHHMMSS. */
    var lastTs: Long = 0L
    /** Wall-clock (System.currentTimeMillis) when we last heard it — drives ageing out of the live list. */
    var seenAtMs: Long = 0L
    /** Wall-clock when first added — a STABLE list-sort key so rows don't reshuffle every frame. */
    var firstSeenMs: Long = 0L
}
