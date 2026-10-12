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
    val SPANS = listOf("250 kHz" to 250_000, "500 kHz" to 500_000, "1 MHz" to 1_000_000, "2 MHz" to 2_000_000)

    val proc = R433Processor()
    val protocols: List<R433Protocol> by lazy { protocolList() }
    /** The protocols rtl_433 ships switched off for having no checksum: nothing in such a frame proves the reading. */
    val doubtful: Set<Int> by lazy { protocols.filter { it.doubtful }.map { it.num }.toSet() }

    private val _band = MutableStateFlow(0)
    val band: StateFlow<Int> = _band.asStateFlow()
    private val _span = MutableStateFlow(250_000)
    val span: StateFlow<Int> = _span.asStateFlow()
    private val _hop = MutableStateFlow(false)
    val hop: StateFlow<Boolean> = _hop.asStateFlow()

    /** Always open on 433.92, whatever the last visit left: that band carries most of the protocol set. */
    fun open() {
        _band.value = 0
        proc.setSpan(_span.value)
        SdrEngine.configure(SdrEngine.Mode.NONE, BANDS[0].second, SdrEngine.IQ_RATE, 32, 40, true, proc)
    }

    fun pickBand(i: Int) { _band.value = i; SdrEngine.tune(BANDS[i].second) }
    fun pickFreq(hz: Long) { BANDS.indexOfFirst { it.second == hz }.takeIf { it >= 0 }?.let { _band.value = it }; SdrEngine.tune(hz) }
    fun nextBand() = pickBand((_band.value + 1) % BANDS.size)
    fun setSpan(hz: Int) { _span.value = hz; proc.setSpan(hz) }
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

    /** How a field is explained when it is not self-evident. */
    val MEANING = mapOf(
        "raw" to "the frame exactly as it arrived, in the notation rtl_433 uses for its own test codes",
        "raw_msg" to "the decoded bytes, kept because this family still has bits nobody has explained",
        "mic" to "which error check the reading passed",
        "exception" to "a bit was set that should not have been; the reading may still be right",
        "battery_mV" to "battery voltage as the sensor measures it",
        "storm_dist" to "the detector's estimate of how far off the leading edge of the storm is",
        "strike_count" to "a running total since the batteries went in, not a rate",
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
}
