package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.UnitSystem
import com.rocketgod.mayhem.core.Units
import kotlin.math.roundToInt

/**
 * How Devices writes a sensor's readings, on its card and in its detail alike, in the units picked in Settings
 * (twin of web/src/devices-fmt.ts and the Devices formatting in DevicesScreen.swift). The card's big line and the
 * detail's fields go through the same helpers, so the two can never disagree on °C and °F or kPa and psi.
 */
object DevicesFmt {
    /** Units for the readings that are not measurements this setting converts, so a number is never shown bare. */
    val R433_UNITS = mapOf(
        "humidity" to " %", "humidity_1" to " %", "moisture" to " %", "wind_dir_deg" to "°",
        "light_lux" to " lux", "battery_mV" to " mV", "pm2_5_ug_m3" to " µg/m³", "estimated_pm10_0_ug_m3" to " µg/m³",
    )

    fun r433Num(v: Any?): Double? = Units.num(v)

    /** One field of a reading, as the detail shows it. */
    fun r433Value(k: String, v: Any?, u: UnitSystem = Units.current): String = when (k) {
        "battery_ok" -> when {
            v == 1 || v == true || (v is Number && v.toDouble() == 1.0) -> "battery ok"
            v is Number && v.toDouble() > 0 && v.toDouble() < 1 -> "battery ${(v.toDouble() * 100).roundToInt()}%"
            else -> "BATTERY LOW"
        }
        "leak_detected" -> if (v == 1 || v == true || (v is Number && v.toDouble() != 0.0)) "WET" else "dry"
        // a measurement in the chosen units; a reading a decoder wrote out in metric ("19.1 °C") is converted too
        else -> Units.fmtField(k, v, u) ?: (v as? String)?.let { Units.fmtText(it, u) } ?: (fmtValue(v) + (R433_UNITS[k] ?: ""))
    }

    /** The temperature a reading carries, in °C, whichever unit the sensor sent it in; null when it has none. */
    fun r433TempC(v: R433Data): Double? = r433Num(v["temperature_C"]) ?: r433Num(v["temperature_F"])?.let { Units.fToC(it) }

    /**
     * The big line and the line under it on a tire or weather sensor's card, or null for anything else. A tire shows
     * its pressure and temperature, a weather sensor its temperature and humidity.
     */
    fun r433Measure(v: R433Data, tire: Boolean, u: UnitSystem = Units.current): Pair<String, String>? {
        val tc = r433TempC(v)
        if (tire) {
            val kpa = r433Num(v["pressure_kPa"]) ?: r433Num(v["pressure_PSI"])?.let { it * Units.KPA_PER_PSI } ?: r433Num(v["pressure_bar"])?.let { it * 100 }
            return (kpa?.let { Units.fmtTire(it, u) } ?: "TIRE") to (tc?.let { Units.fmtTemp(it, 0, u) } ?: "")
        }
        if (tc != null) return Units.fmtTemp(tc, 1, u) to (v["humidity"]?.let { "${fmtValue(it)}% humidity" } ?: "")
        val temp = v["temperature"]
        if (temp is String) return Units.fmtText(temp, u) to (v["humidity"]?.let { "${fmtValue(it)} humidity" } ?: "")
        return null
    }
}
