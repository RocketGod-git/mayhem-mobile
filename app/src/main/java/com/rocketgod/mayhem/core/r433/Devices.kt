package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.SdrEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Calendar
import kotlin.math.roundToInt

/** The Devices app: one receiver, the band walk, and how readings are put into words. Twin of the web app's renderR433. */
object Devices {
    /**
     * 433.92 first because most of the protocol set lives there; the four American frequencies are listed separately
     * because they are spread over fourteen megahertz, wider than one span, so hearing all of them means visiting each.
     */
    val BANDS = listOf("433.92" to 433_920_000L, "315.00" to 315_000_000L, "345.00" to 345_000_000L, "310.00" to 310_000_000L,
        "318.00" to 318_000_000L, "303.875" to 303_875_000L, "868.30" to 868_300_000L, "912.60" to 912_600_000L, "915.00" to 915_000_000L)
    /** Most of these sensors report every thirty to sixty seconds. */
    const val DWELL_MS = 20_000L

    val proc = R433Processor()
    val protocols: List<R433Protocol> by lazy { protocolList() }
    /** The protocols rtl_433 ships switched off for having no checksum: nothing in such a frame proves the reading. */
    val doubtful: Set<Int> by lazy { protocols.filter { it.doubtful }.map { it.num }.toSet() }

    private val _band = MutableStateFlow(0)
    val band: StateFlow<Int> = _band.asStateFlow()
    private val _hop = MutableStateFlow(false)
    val hop: StateFlow<Boolean> = _hop.asStateFlow()

    /**
     * Always open on 433.92, whatever the last visit left: that band carries most of the protocol set. Opened from
     * Spectrum, it opens on the frequency Spectrum handed over instead.
     */
    fun open() {
        val hz = com.rocketgod.mayhem.core.Apps.takeHandoff() ?: BANDS[0].second
        _band.value = BANDS.indexOfFirst { it.second == hz }.coerceAtLeast(0)
        proc.centerOf = { SdrEngine.freqHz.value }
        SdrEngine.configure(SdrEngine.Mode.NONE, hz, SdrEngine.IQ_RATE, 32, 40, true, proc)
    }

    fun pickBand(i: Int) { _band.value = i; SdrEngine.tune(BANDS[i].second) }
    fun pickFreq(hz: Long) { BANDS.indexOfFirst { it.second == hz }.takeIf { it >= 0 }?.let { _band.value = it }; SdrEngine.tune(hz) }
    fun nextBand() = pickBand((_band.value + 1) % BANDS.size)
    fun setHop(on: Boolean) { _hop.value = on }

    /** Units, so a number is never shown bare. */
    private val UNITS = mapOf(
        "temperature_C" to " °C", "temperature_1_C" to " °C", "temperature_F" to " °F", "humidity" to " %", "humidity_1" to " %",
        "moisture" to " %", "pressure_hPa" to " hPa", "pressure_kPa" to " kPa", "pressure_PSI" to " PSI", "wind_avg_km_h" to " km/h",
        "wind_max_km_h" to " km/h", "wind_avg_m_s" to " m/s", "wind_max_m_s" to " m/s", "wind_avg_mi_h" to " mph", "wind_dir_deg" to "°",
        "rain_mm" to " mm", "rain_in" to " in", "light_lux" to " lux", "battery_mV" to " mV", "pm2_5_ug_m3" to " µg/m³",
        "estimated_pm10_0_ug_m3" to " µg/m³", "storm_dist" to " km", "strike_distance" to " mi",
    )
    /** The fields that make the one-line summary, in the order a person would read them. */
    private val SUMMARY = listOf("temperature_C", "temperature_F", "humidity", "pressure_hPa", "pressure_PSI", "pressure_kPa", "moisture",
        "rain_mm", "rain_in", "wind_avg_km_h", "wind_avg_mi_h", "wind_avg_m_s", "leak_detected", "strike_count", "pm2_5_ug_m3", "light_lux")
    /** Bookkeeping the summary line does not need; it is all still shown under the row. */
    private val HIDDEN = setOf("model", "id", "channel", "subtype", "type", "mic", "exception", "message_type", "sequence_num", "unknown1",
        "family", "raw", "raw_msg", "protocol", "code")
    /** Fields too long for the wrapped list; each gets its own line. */
    val LONG = setOf("raw", "raw_msg", "code", "summary", "DifferentialConsumptionIntervals")

    /** How a field is explained when it is not self-evident; tapping the field on a device row shows it. */
    val MEANING = mapOf(
        "raw" to "the frame exactly as it arrived, in the notation rtl_433 uses for its own test codes",
        "raw_msg" to "the decoded bytes, kept because this family still has bits nobody has explained",
        "protocol" to "rtl_433 protocol number — look this up against that project's documentation",
        "mic" to "which error check the reading passed",
        "exception" to "a bit was set that should not have been; the reading may still be right",
        "battery_mV" to "battery voltage as the sensor measures it",
        "ad_raw" to "the sensor's own reading before it was turned into a percentage",
        "storm_dist" to "the detector's estimate of how far off the leading edge of the storm is",
        "strike_count" to "a running total since the batteries went in, not a rate",
        "rfi" to "broadband interference, which stops the detector hearing strikes at all",
        "consumption_data" to "a meter register reading, not a unit of energy — the multiplier is the utility's",
        "DifferentialConsumptionIntervals" to "consumption in each recent interval, oldest first",
        "tristate" to "the solder links or switches inside the remote: 0 low, 1 high, Z floating",
        "counter" to "advances every button press, which is what stops a recording being replayed",
        "learn" to "the device is being taught to a receiver rather than reporting",
        "heartbeat" to "a periodic check-in, not an event",
    )

    fun value(k: String, v: Any?): String = when (k) {
        "battery_ok" -> when {
            v == 1 || v == true || (v is Number && v.toDouble() == 1.0) -> "battery ok"
            v is Number && v.toDouble() > 0 && v.toDouble() < 1 -> "battery ${(v.toDouble() * 100).roundToInt()}%"
            else -> "BATTERY LOW"
        }
        "leak_detected" -> if (v == 1 || v == true) "WET" else "dry"
        else -> fmtValue(v) + (UNITS[k] ?: "")
    }

    /** The two or three readings that say what a device is doing. */
    fun summary(d: R433Data): String {
        val parts = ArrayList<String>()
        for (k in SUMMARY) { if (!d.containsKey(k)) continue; parts.add(value(k, d[k])); if (parts.size == 3) break }
        if (parts.isEmpty()) for ((k, v) in d) { if (k in HIDDEN || parts.size == 3) continue; parts.add("${k.replace('_', ' ')} ${value(k, v)}") }
        return parts.joinToString(" · ")
    }

    /** `14:23:07`: what someone comparing a reading against the doorbell they just pressed wants to see. */
    fun clock(t: Long): String {
        val c = Calendar.getInstance().apply { timeInMillis = t }
        return "%02d:%02d:%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND))
    }

    fun spanLabel(hz: Int) = if (hz >= 1_000_000) "${fmtValue(hz / 1e6)} MHz" else "${(hz / 1e3).roundToInt()} kHz"

    /** What a card calls a thing heard. */
    enum class Kind(val label: String, val group: Filter) {
        CAR_KEY("CAR KEY", Filter.KEY), REMOTE("REMOTE", Filter.REMOTE), TIRE("TIRE SENSOR", Filter.SENSOR), WEATHER("WEATHER", Filter.SENSOR),
        SECURITY("SECURITY", Filter.SENSOR), METER("METER", Filter.SENSOR), SENSOR("SENSOR", Filter.SENSOR),
    }
    /** The filter row over the cards. */
    enum class Filter(val label: String) { ALL("ALL"), KEY("KEYS"), REMOTE("REMOTES"), SENSOR("SENSORS") }

    private val TIRE = Regex("tpms|tire|tyre")
    private val WEATHERISH = Regex("weather|thermo|temperature|humidity|rain|wind|lightning|hygro|soil|pool|bbq|meat|grill")
    private val SECURITYISH = Regex("door|window|motion|pir|smoke|alarm|security|leak|water|glass|siren|contact")
    private val METERISH = Regex("meter|energy|power|gas|current|consumption|ert")
    private val REMOTEISH = Regex("remote|switch|button|doorbell|bell|keyfob|key fob|gate|garage|blind|shutter|outlet|plug|dimmer")

    /** What a card calls the thing, from who decoded it and what its protocol says it is. */
    fun kind(h: HeardDevice): Kind {
        when (h.family) { "key" -> return Kind.CAR_KEY; "remote" -> return Kind.REMOTE; "weather" -> return Kind.WEATHER }
        val t = "${h.model} ${h.what} ${h.data["type"]?.let { fmtValue(it) } ?: ""}".lowercase()
        return when {
            TIRE.containsMatchIn(t) -> Kind.TIRE
            WEATHERISH.containsMatchIn(t) -> Kind.WEATHER
            SECURITYISH.containsMatchIn(t) -> Kind.SECURITY
            METERISH.containsMatchIn(t) -> Kind.METER
            REMOTEISH.containsMatchIn(t) -> Kind.REMOTE
            else -> Kind.SENSOR
        }
    }

    fun shows(f: Filter, h: HeardDevice) = f == Filter.ALL || kind(h).group == f

    /** How long a device counts as live: a key or remote is a press, a sensor reports every half minute or so. */
    fun liveMs(k: Kind): Long = if (k == Kind.CAR_KEY || k == Kind.REMOTE) 15_000L else 120_000L

    fun ago(ms: Long): String {
        val s = maxOf(0L, (ms / 1000.0).roundToInt().toLong())
        return if (s < 60) "${s}s ago" else if (s < 3600) "${s / 60}m ago" else "${s / 3600}h ${s / 60 % 60}m ago"
    }

    fun mhz(hz: Long) = "%.3f MHz".format(java.util.Locale.US, hz / 1e6)

    private fun num(v: Any?): Double? = when (v) {
        is Number -> v.toDouble()
        is String -> v.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull()
        else -> null
    }

    /** The big line on a card, and the small one under it: what this thing just said, in the fewest words. */
    fun headline(h: HeardDevice, k: Kind = kind(h)): Pair<String, String> {
        val v = h.data
        if (k == Kind.CAR_KEY || k == Kind.REMOTE) {
            val big = (v["button"] ?: v["btn"] ?: v["cmd"] ?: v["state"])?.let { fmtValue(it) } ?: "PRESS"
            return big to (v["counter"]?.let { "counter ${fmtValue(it)}" } ?: v["hop"]?.let { "code ${fmtValue(it).take(8)}" } ?: "")
        }
        val kpa = num(v["pressure_kPa"]); val psiRaw = num(v["pressure_PSI"]); val bar = num(v["pressure_bar"])
        val tcRaw = num(v["temperature_C"]); val tf = num(v["temperature_F"])
        val tc = tcRaw ?: tf?.let { (it - 32) * 5 / 9 }
        if (k == Kind.TIRE) {
            val psi = psiRaw ?: kpa?.let { it * 0.1450377 } ?: bar?.let { it * 14.50377 }
            return (psi?.let { "%.1f psi".format(java.util.Locale.US, it) } ?: "TIRE") to (tc?.let { "%.0f °F".format(java.util.Locale.US, it * 9 / 5 + 32) } ?: "")
        }
        if (tc != null) return "%.1f °F".format(java.util.Locale.US, tc * 9 / 5 + 32) to (v["humidity"]?.let { "${fmtValue(it)}% humidity" } ?: "")
        val temp = v["temperature"]
        if (temp is String) return temp.split(" · ").last() to (v["humidity"]?.let { "${fmtValue(it)} humidity" } ?: "")
        val sum = summary(v).split(" · ")
        return sum[0].ifEmpty { k.label } to sum.drop(1).joinToString(" · ")
    }

    /** One line per reading, for the history in the detail panel. */
    fun historyLine(h: HeardDevice, data: R433Data): String {
        val (a, b) = headline(h.copy(data = data))
        return listOf(a, b).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { summary(data) }
    }
}
