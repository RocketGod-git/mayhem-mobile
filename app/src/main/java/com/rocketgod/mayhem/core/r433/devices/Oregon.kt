package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Oregon Scientific, and the Owl energy monitors on the same air interface. Two generations share one decoder
 * because they share one modulation (Manchester with a hardcoded leading zero): v2.1 sends every bit twice behind
 * a sync found at one of eight offsets; v3 sends each bit once behind a fixed preamble. Both carry decimal digits
 * and check themselves with a nibble sum. A sixteen-bit code names the sensor.
 *
 * Ported from rtl_433's oregon_scientific.c (GPL-2.0-or-later). Twin of web/src/dsp/r433/devices/oregon.ts.
 */

private const val ID_THGR122N = 0x1d20
private const val ID_THGR968 = 0x1d30
private const val ID_BTHR918 = 0x5d50
private const val ID_BHTR968 = 0x5d60
private const val ID_RGR968 = 0x2d10
private const val ID_THR228N = 0xec40
private const val ID_THN132N = 0xec40
private const val ID_AWR129 = 0xec41
private const val ID_RTGN318 = 0x0cc3
private const val ID_RTGN129 = 0x0cc3
private const val ID_THGR810 = 0xf024
private const val ID_THGR810a = 0xf8b4
private const val ID_THN802 = 0xc844
private const val ID_PCR800 = 0x2914
private const val ID_PCR800a = 0x2d14
private const val ID_WGR800 = 0x1984
private const val ID_WGR800a = 0x1994
private const val ID_WGR968 = 0x3d00
private const val ID_UV800 = 0xd874
private const val ID_THN129 = 0xcc43
private const val ID_RTHN129 = 0x0cd3
private const val ID_BTHGN129 = 0x5d53
private const val ID_UVR128 = 0xec70
private const val ID_THGR328N = 0xcc23
private val ID_RTGR328N = intArrayOf(0xdcc3, 0xccc3, 0xbcc3, 0xacc3, 0x9cc3)
private val ID_RTGR328N_CLOCK = intArrayOf(0x8ce3, 0x8ae3)
private const val EXPECTED_NUM_BYTES = 44
private fun two(v: Int) = v.toString().padStart(2, '0')

private fun osTemperature(m: UBytes): Double {
    var t = (((m[5] shr 4) * 100) + ((m[4] and 0x0f) * 10) + ((m[4] shr 4) and 0x0f)) / 10.0
    t += (m[5] and 0x07) * 100
    return if ((m[5] and 0x08) != 0) -t else t
}
private fun osHumidity(m: UBytes) = ((m[6] and 0x0f) * 10) + (m[6] shr 4)
private fun osUv(m: UBytes) = ((m[4] and 0x0f) * 10) + (m[4] shr 4)
private fun osRainRate(m: UBytes) = (((m[5] and 0x0f) * 1000) + ((m[5] shr 4) * 100) + ((m[4] and 0x0f) * 10) + (m[4] shr 4)) / 100.0
private fun osTotalRain(m: UBytes): Double = (m[8] and 0x0f) * 100 + ((m[8] shr 4) and 0x0f) * 10 + (m[7] and 0x0f) +
    ((m[7] shr 4) and 0x0f) / 10.0 + (m[6] and 0x0f) / 100.0 + ((m[6] shr 4) and 0x0f) / 1000.0
private fun swapNibbles(b: Int) = (((b and 0x0f) shl 4) or (b shr 4)) and 0xff

/** Add every nibble before the stated position and compare with the two nibbles there. */
private fun osChecksumOk(m: UBytes, idx: Int): Boolean {
    var sum = 0
    var i = 0
    while (i < idx - 1) { val v = m[i shr 1]; sum += (v shr 4) + (v and 0x0f); i += 2 }
    val checksum: Int
    if ((idx and 1) != 0) {
        sum += m[idx shr 1] shr 4
        checksum = (m[idx shr 1] and 0x0f) or (m[(idx + 1) shr 1] and 0xf0)
    } else checksum = (m[idx shr 1] shr 4) or ((m[idx shr 1] and 0x0f) shl 4)
    return (sum and 0xff) == checksum
}

private fun osV2Ok(m: UBytes, expected: Int, got: Int, nibbles: Int) = expected == got && osChecksumOk(m, nibbles)
private fun digitsOk(vararg ns: Int) = ns.all { it <= 9 }

/** v2.1: every bit sent twice; the sync may start at any of eight bit offsets. */
private fun decodeV21(bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = bits.bb[0]
    if ((b[1] != 0x55 || b[2] != 0x55) && (b[1] != 0xaa || b[2] != 0xaa)) return DECODE_ABORT_EARLY
    val databits = BitBuffer()
    val syncTest = u32be(b, 3)
    for (shift in 0 until 8) {
        val mask = 0xffff0000L ushr shift
        val pattern = 0x55990000L ushr shift
        val pattern2 = 0xaa990000L ushr shift
        if ((syncTest and mask) != pattern && (syncTest and mask) != pattern2) continue
        bits.manchesterDecode(0, shift + 40, databits, 173)
        reflectNibbles(databits.bb[0], (databits.bitsPerRow[0] + 7) shr 3)
        break
    }
    val msg = databits.bb[0]
    val n = databits.bitsPerRow[0]
    val sensorId = (msg[0] shl 8) or msg[1]
    val channel = (msg[2] shr 4) and 0x0f
    val deviceId = (msg[2] and 0x0f) or (msg[3] and 0xf0)
    val batteryOk = if (((msg[3] shr 2) and 0x01) != 0) 0 else 1
    val base = arrayOf("id" to deviceId, "channel" to channel, "battery_ok" to batteryOk)
    fun th(model: String) = data("model" to model, *base, "temperature_C" to round2(osTemperature(msg)), "humidity" to osHumidity(msg))

    if (sensorId == ID_THGR122N || sensorId == ID_THGR968) {
        if (!osV2Ok(msg, 68, n, 15) && !osV2Ok(msg, 76, n, 15)) return 0
        ctx.emit(th(if (sensorId == ID_THGR968) "Oregon-THGR968" else if (n == 68) "Oregon-THGR228N" else "Oregon-THGR122N"))
        return 1
    }
    if (sensorId == ID_WGR968) {
        if (!osV2Ok(msg, 94, n, 17)) return 0
        ctx.emit(data("model" to "Oregon-WGR968", *base,
            "wind_max_m_s" to round1((msg[5] and 0x0f) / 10.0 + ((msg[6] shr 4) and 0x0f) + (msg[6] and 0x0f) / 10.0),
            "wind_avg_m_s" to round1(((msg[7] shr 4) and 0x0f) / 10.0 + (msg[7] and 0x0f) + ((msg[8] shr 4) and 0x0f) / 10.0),
            "wind_dir_deg" to round1(((msg[4] and 0x0f) * 10 + ((msg[4] shr 4) and 0x0f) + ((msg[5] shr 4) and 0x0f) * 100).toDouble())))
        return 1
    }
    if (sensorId == ID_BHTR968) {
        if (!osV2Ok(msg, 92, n, 19)) return 0
        val o = th("Oregon-BHTR968"); o["pressure_hPa"] = ((msg[7] and 0x0f) or (msg[8] and 0xf0)) + 856; ctx.emit(o)
        return 1
    }
    if (sensorId == ID_BTHR918) {
        if (!osV2Ok(msg, 84, n, 19)) return 0
        val o = th("Oregon-BTHR918"); o["pressure_hPa"] = ((msg[7] and 0x0f) or (msg[8] and 0xf0)) + 795; ctx.emit(o)
        return 1
    }
    if (sensorId == ID_RGR968) {
        if (!osV2Ok(msg, 80, n, 16)) return 0
        ctx.emit(data("model" to "Oregon-RGR968", *base,
            "rain_rate_mm_h" to round1(((msg[4] and 0x0f) * 100 + (msg[4] shr 4) * 10 + ((msg[5] shr 4) and 0x0f)) / 10.0),
            "rain_mm" to round1(((msg[7] and 0x0f) * 10000 + (msg[7] shr 4) * 1000 + (msg[6] and 0x0f) * 100 + (msg[6] shr 4) * 10 + (msg[5] and 0x0f)) / 10.0)))
        return 1
    }
    if ((sensorId == ID_THR228N || sensorId == ID_AWR129) && n == 76) {
        if (!osV2Ok(msg, 76, n, 12)) return 0
        ctx.emit(data("model" to "Oregon-THR228N", *base, "temperature_C" to round2(osTemperature(msg))))
        return 1
    }
    if (sensorId == ID_THN132N && n == 64) {
        if (!osV2Ok(msg, 64, n, 12)) return 0
        if (!digitsOk((msg[5] shr 4) and 0x0f, msg[4] and 0x0f, (msg[4] shr 4) and 0x0f)) return DECODE_FAIL_SANITY
        val t = osTemperature(msg)
        if (t > 70 || t < -50) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to "Oregon-THN132N", *base, "temperature_C" to round2(t)))
        return 1
    }
    if ((sensorId and 0x0fff) == ID_RTGN129 && n == 80) {
        if (!osV2Ok(msg, 80, n, 15)) return 0
        ctx.emit(th("Oregon-RTGN129")); return 1
    }
    if (sensorId in ID_RTGR328N && n == 173) {
        if (!osV2Ok(msg, 173, n, 15)) return 0
        ctx.emit(th("Oregon-RTGR328N")); return 1
    }
    if (sensorId in ID_RTGR328N_CLOCK) {
        if (!osV2Ok(msg, 100, n, 21)) return 0
        val year = ((msg[9] and 0x0f) * 10) + ((msg[9] and 0xf0) shr 4) + 2000
        ctx.emit(data("model" to "Oregon-RTGR328N", *base,
            "radio_clock" to "$year-${two((msg[8] and 0xf0) shr 4)}-${two(((msg[7] and 0x0f) * 10) + ((msg[7] and 0xf0) shr 4))}" +
                "T${two(((msg[6] and 0x0f) * 10) + ((msg[6] and 0xf0) shr 4))}:${two(((msg[5] and 0x0f) * 10) + ((msg[5] and 0xf0) shr 4))}" +
                ":${two(((msg[4] and 0x0f) * 10) + ((msg[4] and 0xf0) shr 4))}"))
        return 1
    }
    if ((sensorId and 0x0fff) == ID_RTGN318 && n == 76 && osV2Ok(msg, 76, n, 15)) { ctx.emit(th("Oregon-RTGN318")); return 1 }
    if ((sensorId == ID_THN129 || (sensorId and 0x0fff) == ID_RTHN129) && osV2Ok(msg, 68, n, 12)) {
        ctx.emit(data("model" to "Oregon-THN129", *base, "temperature_C" to round2(osTemperature(msg)))); return 1
    }
    if (sensorId == ID_BTHGN129) {
        if (!osV2Ok(msg, 92, n, 19)) return 0
        val o = th("Oregon-BTHGN129"); o["pressure_hPa"] = ((msg[7] and 0x0f) or (msg[8] and 0xf0)) * 2 + (msg[8] and 0x01) + 600; ctx.emit(o)
        return 1
    }
    if (sensorId == ID_UVR128 && n == 148) {
        if (!osV2Ok(msg, 148, n, 12)) return 0
        if (!digitsOk((msg[4] shr 4) and 0x0f, msg[4] and 0x0f)) return DECODE_FAIL_SANITY
        val uv = osUv(msg)
        if (uv < 0 || uv > 25) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to "Oregon-UVR128", "id" to deviceId, "battery_ok" to batteryOk, "uvi" to uv))
        return 1
    }
    if (sensorId == ID_THGR328N) {
        if (!osV2Ok(msg, 173, n, 15)) return 0
        ctx.emit(th("Oregon-THGR328N")); return 1
    }
    return 0
}

/** v3 and the Owl meters: one bit per symbol behind a preamble that names the family. */
private fun decodeV3(bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = bits.bb[0]
    if (((b[0] and 0x0f) != 0x0f || b[1] != 0xff || (b[2] and 0xc0) != 0xc0) &&
        ((b[0] and 0x0f) != 0x00 || b[1] != 0x00 || (b[2] and 0xc0) != 0x00)) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    val osPos = bits.search(0, 0, UBytes.of(0x00, 0x05), 16) + 16
    val cm180Pos = bits.search(0, 0, UBytes.of(0x00, 0x46), 16) + 8
    val cm180iPos = bits.search(0, 0, UBytes.of(0x00, 0x4a), 16) + 8
    val cm130Pos = bits.search(0, 0, UBytes.of(0x00, 0x00, 0x00, 0x60), 32) + 24
    val altPos = bits.search(0, 0, UBytes.of(0xff, 0xf5), 16) + 16
    var pos = 0; var len = 0
    if (rowBits - osPos >= 7 * 8) { pos = osPos; len = rowBits - osPos }
    else if (rowBits - cm180Pos >= 52) { pos = cm180Pos; len = rowBits - cm180Pos }
    else if (rowBits - cm180iPos >= 84) { pos = cm180iPos; len = rowBits - cm180iPos }
    else if (rowBits - cm130Pos >= 96) { pos = cm130Pos; len = rowBits - cm130Pos }
    else if (rowBits - altPos >= 7 * 8) { pos = altPos; len = rowBits - altPos }
    if (len == 0 || len > EXPECTED_NUM_BYTES * 8) return DECODE_ABORT_EARLY
    val msg = UBytes(EXPECTED_NUM_BYTES)
    bits.extractBytes(0, pos, msg, len)
    reflectNibbles(msg, (len + 7) shr 3)
    val sensorId = (msg[0] shl 8) or msg[1]
    val channel = (msg[2] shr 4) and 0x0f
    val deviceId = (msg[2] and 0x0f) or (msg[3] and 0xf0)
    val batteryOk = if (((msg[3] shr 2) and 0x01) != 0) 0 else 1
    val base = arrayOf("id" to deviceId, "channel" to channel, "battery_ok" to batteryOk)

    if ((sensorId and 0xf0ff) == ID_THGR810 || sensorId == ID_THGR810a) {
        if (!osChecksumOk(msg, 15)) return DECODE_FAIL_MIC
        if (!digitsOk((msg[5] shr 4) and 0x0f, msg[4] and 0x0f, (msg[4] shr 4) and 0x0f, msg[6] and 0x0f, (msg[6] shr 4) and 0x0f)) return DECODE_FAIL_SANITY
        val t = osTemperature(msg)
        if (t > 70 || t < -50) return DECODE_FAIL_SANITY
        val out = data("model" to "Oregon-THGR810", *base, "temperature_C" to round2(t), "humidity" to osHumidity(msg))
        val button = msg[0] and 1
        if (button != 0) out["button"] = button
        ctx.emit(out)
        return 1
    }
    if (sensorId == ID_THN802) {
        if (!osChecksumOk(msg, 12)) return DECODE_FAIL_MIC
        ctx.emit(data("model" to "Oregon-THN802", *base, "temperature_C" to round2(osTemperature(msg)))); return 1
    }
    if (sensorId == ID_UV800) {
        if (!osChecksumOk(msg, 13)) return DECODE_FAIL_MIC
        ctx.emit(data("model" to "Oregon-UV800", *base, "uvi" to osUv(msg))); return 1
    }
    if (sensorId == ID_PCR800 || sensorId == ID_PCR800a) {
        if (!osChecksumOk(msg, 18)) return DECODE_FAIL_MIC
        if (sensorId == ID_PCR800 && !digitsOk(msg[8] and 0x0f, (msg[8] shr 4) and 0x0f, msg[7] and 0x0f, (msg[7] shr 4) and 0x0f, msg[6] and 0x0f,
                (msg[6] shr 4) and 0x0f, msg[5] and 0x0f, (msg[5] shr 4) and 0x0f, msg[4] and 0x0f, (msg[4] shr 4) and 0x0f)) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to if (sensorId == ID_PCR800) "Oregon-PCR800" else "Oregon-PCR800a", *base,
            "rain_rate_in_h" to round2(osRainRate(msg)), "rain_in" to jsRound(osTotalRain(msg) * 1000) / 1000))
        return 1
    }
    if (sensorId == ID_WGR800 || sensorId == ID_WGR800a) {
        if (!osChecksumOk(msg, 17)) return DECODE_FAIL_MIC
        if (!digitsOk(msg[5] and 0x0f, (msg[6] shr 4) and 0x0f, msg[6] and 0x0f, (msg[7] shr 4) and 0x0f, msg[7] and 0x0f, (msg[8] shr 4) and 0x0f)) return DECODE_FAIL_SANITY
        val gust = (msg[5] and 0x0f) / 10.0 + ((msg[6] shr 4) and 0x0f) + (msg[6] and 0x0f) * 10
        val avg = ((msg[7] shr 4) and 0x0f) / 10.0 + (msg[7] and 0x0f) + ((msg[8] shr 4) and 0x0f) * 10
        if (gust < 0 || gust > 56 || avg < 0 || avg > 56) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to "Oregon-WGR800", *base, "wind_max_m_s" to round1(gust), "wind_avg_m_s" to round1(avg),
            "wind_dir_deg" to round1(((msg[4] shr 4) and 0x0f) * 22.5)))
        return 1
    }
    // the Owl energy monitors: the house supply rather than the weather, assuming 230 V
    if (msg[0] in 0x20..0x24) {
        msg[0] = msg[0] and 0x0f
        if (!osChecksumOk(msg, 22)) return DECODE_FAIL_MIC
        val amps = swapNibbles(msg[3]) or ((msg[4] shr 4) shl 8)
        val totalAmps = swapNibbles(msg[10]) * 68719476736.0 + swapNibbles(msg[9]) * 268435456.0 +
            (swapNibbles(msg[8]) shl 20) + (swapNibbles(msg[7]) shl 12) + (swapNibbles(msg[6]) shl 4) + (msg[5] and 0x0f)
        ctx.emit(data("model" to "Oregon-CM160", "id" to (msg[1] and 0x0f), "power_W" to round2(amps * 0.07 * 230),
            "energy_kWh" to round2(totalAmps * 230 / 3600 / 1000 * 1.12)))
        return 1
    }
    if (msg[0] == 0x26) {
        msg[0] = msg[0] and 0x0f
        if (!osChecksumOk(msg, 23)) return DECODE_FAIL_MIC
        for (k in 0 until EXPECTED_NUM_BYTES) msg[k] = swapNibbles(msg[k])
        val total = if ((msg[1] and 0x0f) == 0) msg[10] * 1099511627776.0 + msg[9] * 4294967296.0 + msg[8] * 16777216.0 +
            (msg[7] shl 16) + (msg[6] shl 8) + msg[5] else 0.0
        val out = data("model" to "Oregon-CM180", "id" to ((msg[2] shl 8) or (msg[1] and 0xf0)), "battery_ok" to if ((msg[3] and 0x01) != 0) 0 else 1,
            "power_W" to jsRound(((msg[4] shl 8) or (msg[3] and 0xf0)) * 1.00625), "sequence" to (msg[1] and 0x0f))
        if (total != 0.0) out["energy_kWh"] = round2(total / 3600 / 1000)
        ctx.emit(out)
        return 1
    }
    if (msg[0] == 0x25) {
        msg[0] = msg[0] and 0x0f
        for (k in 0 until EXPECTED_NUM_BYTES) msg[k] = swapNibbles(msg[k])
        fun power(o: Int) = jsRound(((msg[4 + o * 2] shl 8) or (msg[3 + o * 2] and 0xf0)) * 1.00625)
        val total = if (len >= 140 && (msg[1] and 0x0f) == 0) msg[14] * 1099511627776.0 + msg[13] * 4294967296.0 + msg[12] * 16777216.0 +
            (msg[11] shl 16) + (msg[10] shl 8) + msg[9] else 0.0
        val out = data("model" to "Oregon-CM180i", "id" to ((msg[2] shl 8) or (msg[1] and 0xf0)), "battery_ok" to if ((msg[3] and 0x40) != 0) 0 else 1,
            "power1_W" to power(0), "power2_W" to power(1), "power3_W" to power(2), "sequence" to (msg[1] and 0x0f))
        if (total != 0.0) out["energy_kWh"] = round2(total / 3600 / 1000)
        ctx.emit(out)
        return 1
    }
    if (msg[0] == 0x60) {
        if (crc8(msg, 10, 0x07, 0x00, 1) != swapNibbles(msg[11])) return DECODE_FAIL_MIC
        for (k in 0 until 12) msg[k] = swapNibbles(msg[k])
        val energy = msg[6] or (msg[7] shl 8) or (msg[8] shl 16) or (msg[9] shl 24)   // JavaScript's | wraps to 32 bits
        ctx.emit(data("model" to "Oregon-CM130", "id" to msg[2], "power_W" to ((msg[4] shl 8) or msg[3]) * 16,
            "energy_kWh" to round2(energy / 8192.0), "mic" to "CRC"))
        return 1
    }
    return DECODE_FAIL_SANITY
}

internal val OREGON: List<RDevice> = listOf(
    dev(12, "Oregon Scientific weather sensor", Mod.OOK_MANCHESTER_ZEROBIT, 440, 0, 2400, bands = listOf(433_920_000L),
        what = "thermometers, rain gauges, anemometers, and the Owl household energy monitors") { _, bits, ctx ->
        val ret = decodeV21(bits, ctx)
        if (ret > 0) ret else decodeV3(bits, ctx)
    },
)
