package com.rocketgod.mayhem.core

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.floor

/** Metric or Imperial. */
enum class UnitSystem { METRIC, IMPERIAL }

/**
 * Units: Metric or Imperial, one choice in Settings, used for every measurement that is not aviation or marine.
 * Twin of web/src/units.ts and Units.swift (same names, same rounding, same strings).
 *
 * Every value comes in metric (°C, km, m, m/s, km/h, mm, hPa, kPa) and is converted here, never just relabeled.
 * Aviation keeps feet, knots and nautical miles in Flights, UAT and Flight Msgs, and Ships keeps knots and
 * nautical miles: those screens do not call these helpers for them.
 *
 * Metric shows speeds in km/h (wind and vehicles alike), Imperial in mph. The choice is Compose snapshot state, so
 * every screen that formats a reading redraws the moment it changes.
 */
object Units {
    /** The countries that still measure in Imperial: the United States, Liberia and Myanmar. */
    val IMPERIAL_REGIONS: Set<String> = setOf("US", "LR", "MM")

    private val TWO_LETTERS = Regex("^[A-Za-z]{2}$")
    private val THREE_DIGITS = Regex("^\\d{3}$")

    /** The region of a BCP 47 tag ("en-US" → "US", "zh-Hant-TW" → "TW", "en_LR" → "LR"); "" when there is none. */
    fun regionOf(tag: String?): String {
        if (tag.isNullOrEmpty()) return ""
        val parts = tag.replace('_', '-').split('-').drop(1)
        // the region is the first later part that is two letters or three digits (a script is four letters)
        for (p in parts) if (TWO_LETTERS.matches(p) || THREE_DIGITS.matches(p)) return p.uppercase(Locale.US)
        return ""
    }

    /** The default for a locale: Imperial in the US, Liberia and Myanmar, Metric everywhere else (and when unknown). */
    fun unitsForLocale(tag: String?): UnitSystem = if (regionOf(tag) in IMPERIAL_REGIONS) UnitSystem.IMPERIAL else UnitSystem.METRIC

    private const val PREFS = "mayhem"
    private const val KEY = "units"

    /** The device's region, as a tag the rule above reads ("en-US"). */
    private fun deviceTag(): String = runCatching {
        val l = Locale.getDefault()
        if (l.country.isNotEmpty()) "${l.language}-${l.country}" else l.toLanguageTag()
    }.getOrDefault("")

    /** The units in use: the one picked in Settings, or the device's region until one is picked. */
    var current: UnitSystem by mutableStateOf(unitsForLocale(deviceTag()))
        private set
    private var ctx: Context? = null

    fun units(): UnitSystem = current

    /** Reads the remembered choice; until one is picked the device's region decides. */
    fun load(c: Context) {
        ctx = c.applicationContext
        val v = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        current = UnitSystem.entries.firstOrNull { it.name == v } ?: unitsForLocale(deviceTag())
    }

    fun setUnits(u: UnitSystem) {
        current = u
        ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(KEY, u.name)?.apply()
    }

    // ---- conversions ----------------------------------------------------------------------------------------------
    fun cToF(c: Double) = c * 9 / 5 + 32
    fun fToC(f: Double) = (f - 32) * 5 / 9
    const val KM_PER_MI = 1.609344
    const val M_PER_FT = 0.3048
    const val MM_PER_IN = 25.4
    const val HPA_PER_INHG = 33.8638866667
    const val KPA_PER_PSI = 6.894757293

    private val NEG_ZERO = Regex("^-0(\\.0+)?$")
    /** JavaScript's toFixed: half away from zero on the exact value, and never a negative zero. */
    private fun fix(v: Double, d: Int): String {
        if (!v.isFinite()) return v.toString()
        val s = BigDecimal(v).setScale(d, RoundingMode.HALF_UP).toPlainString()
        return if (NEG_ZERO.matches(s)) s.substring(1) else s
    }
    /** JavaScript's Math.round (half up), with US grouping: 1,234. */
    private fun grouped(v: Double): String = String.format(Locale.US, "%,d", floor(v + 0.5).toLong())

    /** A temperature given in °C: "19.1 °C" or "66.4 °F". */
    fun fmtTemp(c: Double, digits: Int = 1, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(cToF(c), digits)} °F" else "${fix(c, digits)} °C"
    /** Just the number and degree sign, for a big clock face: "19°" or "66°"; [tempUnit] says C or F. */
    fun tempNumber(c: Double, digits: Int = 0, u: UnitSystem = current): String = "${fix(if (u == UnitSystem.IMPERIAL) cToF(c) else c, digits)}°"
    fun tempUnit(u: UnitSystem = current): String = if (u == UnitSystem.IMPERIAL) "F" else "C"
    /** A speed given in km/h: "12 km/h" or "7 mph". */
    fun fmtSpeedKmh(kmh: Double, digits: Int = 0, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(kmh / KM_PER_MI, digits)} mph" else "${fix(kmh, digits)} km/h"
    /** A speed given in m/s: shown in km/h or mph. */
    fun fmtSpeedMs(ms: Double, digits: Int = 0, u: UnitSystem = current): String = fmtSpeedKmh(ms * 3.6, digits, u)
    /** A vertical speed given in m/s: "+4.8 m/s" or "+945 ft/min". */
    fun fmtClimb(ms: Double, sign: Boolean = true, u: UnitSystem = current): String {
        val s = if (sign && ms >= 0) "+" else ""
        return if (u == UnitSystem.IMPERIAL) "$s${grouped(ms / M_PER_FT * 60)} ft/min" else "$s${fix(ms, 1)} m/s"
    }
    /** Rain given in mm: "3.2 mm" or "0.13 in". */
    fun fmtRain(mm: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(mm / MM_PER_IN, 2)} in" else "${fix(mm, 1)} mm"
    /** A rain rate given in mm/h. */
    fun fmtRainRate(mmh: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(mmh / MM_PER_IN, 2)} in/h" else "${fix(mmh, 1)} mm/h"
    /** Air pressure given in hPa: "1013.2 hPa" or "29.92 inHg". */
    fun fmtPressure(hPa: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(hPa / HPA_PER_INHG, 2)} inHg" else "${fix(hPa, 1)} hPa"
    /** A tire or line pressure given in kPa: "220 kPa" or "31.9 psi". */
    fun fmtTire(kPa: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(kPa / KPA_PER_PSI, 1)} psi" else "${fix(kPa, 0)} kPa"
    /** A gauge pressure given in psig (a train's brake pipe): "90 psig" or "621 kPa". */
    fun fmtPsig(psig: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${jsRound(psig)} psig" else "${jsRound(psig * KPA_PER_PSI)} kPa"
    /** The same for a gauge face: its number and its unit word. */
    fun psigNumber(psig: Double, u: UnitSystem = current): String = jsRound(if (u == UnitSystem.IMPERIAL) psig else psig * KPA_PER_PSI).toString()
    fun psigWord(u: UnitSystem = current): String = if (u == UnitSystem.IMPERIAL) "PSIG" else "KPA"
    /** A ground distance given in km: "850 m" / "2.4 km" / "37 km", or "600 ft" / "1.5 mi" / "23 mi". */
    fun fmtDist(km: Double, u: UnitSystem = current): String {
        if (u == UnitSystem.IMPERIAL) {
            val mi = km / KM_PER_MI
            return if (mi < 0.1) "${grouped(mi * 5280)} ft" else "${if (mi < 10) fix(mi, 1) else grouped(mi)} mi"
        }
        return if (km < 1) "${grouped(km * 1000)} m" else "${if (km < 10) fix(km, 1) else grouped(km)} km"
    }
    /** A height or short length given in m: "1,234 m" or "4,049 ft". */
    fun fmtAlt(m: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${grouped(m / M_PER_FT)} ft" else "${grouped(m)} m"
    /** A high altitude given in m, for a map label: "23.4 km" or "76,800 ft". */
    fun fmtAltShort(m: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${String.format(Locale.US, "%,d", jsRound(m / M_PER_FT / 100) * 100)} ft" else "${fix(m / 1000, 1)} km"
    /** Just the altitude number for a big clock face, and its unit word. */
    fun altNumber(m: Double, u: UnitSystem = current): String = grouped(if (u == UnitSystem.IMPERIAL) m / M_PER_FT else m)
    fun altWord(u: UnitSystem = current): String = if (u == UnitSystem.IMPERIAL) "FEET" else "METERS"
    /** A depth or small length given in cm: "12 cm" or "4.7 in". */
    fun fmtCm(cm: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(cm / 2.54, 1)} in" else "${fix(cm, 0)} cm"
    /** An area given in km²: "3.2 km²" or "1.2 sq mi". */
    fun fmtArea(km2: Double, u: UnitSystem = current): String =
        if (u == UnitSystem.IMPERIAL) "${fix(km2 / (KM_PER_MI * KM_PER_MI), 1)} sq mi" else "${fix(km2, 1)} km²"

    private fun jsRound(v: Double): Long = floor(v + 0.5).toLong()

    private val TEMP_WORDS = "(^|_)(temperature|setpoint|ambient|alarm|floor_limit|temp)\\w*"
    private val T_C = Regex("${TEMP_WORDS}_c$"); private val T_C2 = Regex("^temperature\\d*_c$")
    private val T_F = Regex("${TEMP_WORDS}_f$"); private val T_F2 = Regex("^temperature\\d*_f$")
    private val KMH = Regex("_km_h$|_kmh$|_kph$"); private val MS = Regex("_m_s$"); private val MPH = Regex("_mi_h$|_mph$")
    private val RAIN_MMH = Regex("rain\\w*_mm_h$"); private val RAIN_INH = Regex("rain\\w*_in_h$")
    private val RAIN_MM = Regex("rain\\w*_mm$"); private val RAIN_IN = Regex("rain\\w*_in$")
    private val P_HPA = Regex("pressure\\w*_hpa$"); private val P_KPA = Regex("pressure\\w*_kpa$")
    private val P_PSI = Regex("pressure\\w*_psi$"); private val P_BAR = Regex("pressure\\w*_bar$")
    private val CM = Regex("_cm$"); private val KM = Regex("_km$"); private val MI = Regex("_mi$")

    /** A number, or a string that is one; null for anything else. */
    fun num(raw: Any?): Double? = when (raw) {
        is Number -> raw.toDouble()
        is String -> if (raw.isNotBlank()) raw.trim().toDoubleOrNull() else null
        else -> null
    }

    /**
     * One reading from a sensor decoder, by its field name's unit suffix (temperature_C, wind_avg_m_s, rain_in,
     * pressure_kPa...). Returns null for a field that is not a measurement this setting covers.
     */
    fun fmtField(key: String, raw: Any?, u: UnitSystem = current): String? {
        val v = num(raw) ?: return null
        if (!v.isFinite()) return null
        val k = key.lowercase(Locale.US)
        fun has(r: Regex) = r.containsMatchIn(k)
        return when {
            has(T_C) || has(T_C2) -> fmtTemp(v, 1, u)
            has(T_F) || has(T_F2) -> fmtTemp(fToC(v), 1, u)
            has(KMH) -> fmtSpeedKmh(v, 1, u)
            has(MS) -> fmtSpeedMs(v, 1, u)
            has(MPH) -> fmtSpeedKmh(v * KM_PER_MI, 1, u)
            has(RAIN_MMH) -> fmtRainRate(v, u)
            has(RAIN_INH) -> fmtRainRate(v * MM_PER_IN, u)
            has(RAIN_MM) -> fmtRain(v, u)
            has(RAIN_IN) -> fmtRain(v * MM_PER_IN, u)
            has(P_HPA) -> fmtPressure(v, u)
            has(P_KPA) -> fmtTire(v, u)
            has(P_PSI) -> fmtTire(v * KPA_PER_PSI, u)
            has(P_BAR) -> fmtTire(v * 100, u)
            has(CM) -> fmtCm(v, u)
            k == "storm_dist" || has(KM) -> fmtDist(v, u)
            k == "strike_distance" || has(MI) -> fmtDist(v * KM_PER_MI, u)
            else -> null
        }
    }

    private val METRIC_TEXT = Regex("^\\s*(-?\\d+(?:\\.\\d+)?)\\s*(°C|°F|hPa|kPa|m/s|km/h|mm|km|m)\\s*$")

    /**
     * A reading a decoder already wrote out in metric, such as "21.4 °C", "1012.6 hPa", "3.1 m/s" or "125 m", shown in
     * the chosen units. Anything else (a count, a percentage, a voltage) comes back as it was.
     */
    fun fmtText(s: String, u: UnitSystem = current): String {
        val m = METRIC_TEXT.find(s) ?: return s
        val n = m.groupValues[1]; val v = n.toDouble(); val d = n.substringAfter('.', "").length
        return when (m.groupValues[2]) {
            "°C" -> fmtTemp(v, d, u)
            "°F" -> fmtTemp(fToC(v), d, u)
            "hPa" -> fmtPressure(v, u)
            "kPa" -> fmtTire(v, u)
            "m/s" -> fmtSpeedMs(v, 1, u)
            "km/h" -> fmtSpeedKmh(v, 0, u)
            "mm" -> fmtRain(v, u)
            "km" -> fmtDist(v, u)
            else -> fmtAlt(v, u)
        }
    }
}
