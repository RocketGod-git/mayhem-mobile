package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.max
import kotlin.math.min

/*
 * The rest of the modern Fine Offset range: soil, leak, lightning, probe temperature and the WS80 array — the
 * same `2d d4` sync and family-code arrangement as the WH25 family, kept as separate registrations as rtl_433
 * keeps them. Ecowitt and Ambient Weather sell this hardware under their own names.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): fineoffset_wh55.c, _wn34.c, _wh52.c, _wh31l.c, _ws80.c. Twin of
 * web/src/dsp/r433/devices/fineoffset2.ts.
 */

private val PREAMBLE = UBytes.of(0xaa, 0x2d, 0xd4)
private fun payloadStart(bits: BitBuffer) = bits.search(0, 0, PREAMBLE, 24) + 24
private val BANDS = listOf(433_920_000L, 868_300_000L, 915_000_000L)

/** WH55 leak sensor: the raw value is a resistance across the probe, reported as it arrives. */
private fun wh55(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val at = bits.search(0, 0, UBytes.of(0xaa, 0x2d, 0xd4, 0x55), 32) + 24
    if (at + 9 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at, 12 * 8)
    if (crc8(b, 9, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Fineoffset-WH55", "id" to hexOf((b[2] shl 8) or b[3], 5), "channel" to (b[1] shr 4) + 1,
        "battery_ok" to b[4] * 0.2, "raw_value" to ((b[5] shl 8) or b[6]), "sensitivity" to ((b[7] shr 7) and 1),
        "alarm" to ((b[7] shr 6) and 1), "mic" to "CRC"))
    return 1
}

/** WN34 / WN38 probe thermometers: sub-type 4 (WN34D) carries no forty-degree offset. */
private fun wn34(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = payloadStart(bits)
    if (at + 9 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 9 * 8)
    if (b[0] != 0x34 && b[0] != 0x38) return DECODE_ABORT_EARLY
    if (crc8(b, 7, 0x31, 0x00) != b[7] || (addBytes(b, 8) and 0xff) != b[8]) return DECODE_FAIL_MIC
    val subType = (b[4] and 0xf0) shr 4
    val raw = signed(((b[4] and 0x0f) shl 12) or (b[5] shl 4), 16)
    val tempC = if (subType == 4) (raw shr 4) * 0.1 else (raw shr 4) * 0.1 - 40
    val batteryMv = (b[6] and 0x7f) * 20
    val bars = when { batteryMv > 1440 -> 5; batteryMv > 1380 -> 4; batteryMv > 1300 -> 3; batteryMv > 1200 -> 2; else -> 1 }
    ctx.emit(data("model" to if (b[0] == 0x38) "Fineoffset-WN38" else if (subType == 4) "Fineoffset-WN34D" else "Fineoffset-WN34",
        "id" to Integer.toHexString((b[1] shl 16) or (b[2] shl 8) or b[3]), "battery_ok" to (bars - 1) * 0.25,
        "battery_mV" to batteryMv, "temperature_C" to jsRound(tempC * 10) / 10, "mic" to "CRC"))
    return 1
}

/** WH52 soil moisture, temperature and conductivity (the conductivity scaling is empirical). */
private fun wh52(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 200) return DECODE_ABORT_LENGTH
    val at = payloadStart(bits)
    if (at + 24 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 24 * 8)
    if (b[0] != 0xa2) return DECODE_ABORT_EARLY
    if ((addBytes(b, 23) and 0xff) != b[23]) return DECODE_FAIL_MIC
    if (crc8(b, 22, 0x31, 0x00) != b[22]) return DECODE_FAIL_MIC
    val batteryMv = b[20] * 20
    val level = max(0.0, min(1.0, (batteryMv - 1300) / 300.0))
    ctx.emit(data("model" to "Fineoffset-WH52", "id" to hexOf(b[1]) + hexOf(b[2]) + hexOf(b[3]),
        "temperature_C" to jsRound(((((b[4] and 0x1f) shl 8) or b[5]) * 0.1 - 40) * 10) / 10, "moisture" to b[6],
        "conductivity_uS_cm" to jsRound((((b[8] and 0x0f) shl 16) or (b[9] shl 8) or b[10]) / 25.6),
        "battery_ok" to jsRound(level * 100) / 100, "battery_mV" to batteryMv, "boost" to ((b[4] and 0xe0) shr 5), "mic" to "CRC"))
    return 1
}

/** WH31L / WH57 lightning: strike, interference or noise; a distance of 63 means "heard but could not place". */
private fun wh31l(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val start = bits.search(0, 0, PREAMBLE, 24)
    if (start == bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, start + 24, 9 * 8)
    if (b[0] != 0x57) return DECODE_ABORT_EARLY
    if (crc8(b, 8, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    if (((addBytes(b, 8) - b[8]) and 0xff) != 0) return DECODE_FAIL_MIC
    val state = b[1] shr 4
    val dist = b[5] and 0x3f
    val out = data("model" to "Fineoffset-WH31L", "id" to (((b[1] and 0x0f) shl 16) or (b[2] shl 8) or b[3]),
        "battery_ok" to ((b[4] and 0x06) shr 1) * 0.5,
        "state" to when (state) { 0 -> "reset"; 1 -> "interference"; 4 -> "noise"; 8 -> "strike"; else -> "unknown" },
        "flags" to hexOf((state shl 12) or (b[4] shl 4) or (b[5] shr 4), 4), "strike_count" to b[6], "mic" to "CRC")
    if (dist != 63) out["storm_dist"] = dist
    ctx.emit(out)
    return 1
}

/** WS80 array: all-ones sentinels mean "not measured", and wind takes its top bits from the flags byte. */
private fun ws80(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 168 || n > 240) return DECODE_ABORT_LENGTH
    val at = payloadStart(bits)
    if (at + 18 * 8 > n) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 18 * 8)
    if (b[0] != 0x80) return DECODE_ABORT_EARLY
    if (crc8(b, 17, 0x31, 0x00) != 0 || (addBytes(b, 17) and 0xff) != b[17]) return DECODE_FAIL_MIC
    val flags = b[7]
    val lightRaw = (b[4] shl 8) or b[5]
    val batteryMv = b[6] * 20
    val tempRaw = ((flags and 0x03) shl 8) or b[8]
    val windAvg = ((flags and 0x10) shl 4) or b[10]
    val windDir = ((flags and 0x20) shl 3) or b[11]
    val windMax = ((flags and 0x40) shl 2) or b[12]
    val unknown = (b[14] shl 8) or b[15]
    val out = data("model" to "Fineoffset-WS80", "id" to hexOf((b[1] shl 16) or (b[2] shl 8) or b[3], 6),
        "battery_ok" to (if (batteryMv < 1400) 0 else (batteryMv - 1400) / 16) * 0.01, "battery_mV" to batteryMv,
        "flags" to hexOf(flags, 2), "mic" to "CRC")
    if (tempRaw != 0x3ff) out["temperature_C"] = jsRound((tempRaw - 400) * 0.1 * 10) / 10
    if (b[9] != 0xff) out["humidity"] = b[9]
    if (windDir != 0x1ff) out["wind_dir_deg"] = windDir
    if (windAvg != 0x1ff) out["wind_avg_m_s"] = jsRound(windAvg * 0.1 * 10) / 10
    if (windMax != 0x1ff) out["wind_max_m_s"] = jsRound(windMax * 0.1 * 10) / 10
    if (b[13] != 0xff) out["uvi"] = jsRound(b[13] * 0.1 * 10) / 10
    if (lightRaw != 0xffff) out["light_lux"] = lightRaw * 10
    if (unknown != 0x3fff) out["unknown1"] = unknown
    ctx.emit(out)
    return 1
}

internal val FINEOFFSET2: List<RDevice> = listOf(
    dev(251, "Fine Offset / Ecowitt WH55 water leak sensor", Mod.FSK_PCM, 60, 60, 2500, bands = BANDS, what = "water leak detector", decode = ::wh55),
    dev(221, "Fine Offset WN34S/L/D, WN38, Froggit DP150/D35 temperature sensor", Mod.FSK_PCM, 58, 58, 2500, bands = BANDS,
        what = "probe thermometer for a pool, a fridge or a compost heap", decode = ::wn34),
    dev(353, "Fine Offset / Ecowitt WH52 soil moisture, temperature and conductivity sensor", Mod.FSK_PCM, 58, 58, 5000, bands = BANDS, what = "soil probe", decode = ::wh52),
    dev(190, "Ambient Weather WH31L / Fine Offset WH57 lightning sensor", Mod.FSK_PCM, 56, 56, 1000, bands = BANDS, what = "lightning detector", decode = ::wh31l),
    dev(213, "Fine Offset Electronics WS80 weather station", Mod.FSK_PCM, 58, 58, 1500, bands = BANDS,
        what = "outdoor array: wind, temperature, humidity, light and ultraviolet", decode = ::ws80),
)
