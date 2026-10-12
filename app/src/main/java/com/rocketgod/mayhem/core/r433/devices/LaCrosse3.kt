package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * The older LaCrosse consoles and the ELV / Conrad system they grew out of: the WS-2310 (thirteen nibbles guarded
 * three ways at once), the WS7000 (stuffed nibbles, reflected), the TX31U and TX22U (variable lists of tagged
 * measurements — the TX22U's length is discovered by finding the count whose CRC closes) and the WS6868 pair.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): lacrossews.c, lacrosse_ws7000.c, lacrosse_tx31u.c,
 * lacrosse_tx22uit.c, lacrosse_ws6868.c. Twin of web/src/dsp/r433/devices/lacrosse3.ts.
 */

private val BANDS = listOf(433_920_000L, 868_300_000L, 915_000_000L)
private val B433 = listOf(433_920_000L)
private fun bf(y: Int, start: Int, len: Int) = (y shr start) and ((1 shl len) - 1)
private fun bit(y: Int, pos: Int) = (y shr pos) and 1
private val AA_2DD4 = UBytes.of(0xaa, 0xaa, 0x2d, 0xd4)

/** WS-2310 / WS-3600: a running sum, an odd parity over scattered bits, and two complemented nibbles. */
private fun lacrosseWs(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 52) continue
        val p = bits.bb[row]
        if (p[0] != 0x09 && p[0] != 0x06) continue
        val n = IntArray(13)
        var parity = 0
        for (i in 0 until 52) {
            val b = if ((p[i shr 3] and (1 shl (7 - (i % 8)))) != 0) 1 else 0
            n[i shr 2] = n[i shr 2] or (b shl (3 - (i % 4)))
            if (i == 9 || i in 27..39) parity += b
        }
        var sum = 0
        for (i in 0 until 12) sum += n[i]
        if (n[7] != (n[10] xor 0xf) || n[8] != (n[11] xor 0xf) || (parity and 1) != 1 || (sum and 0x0f) != n[12]) continue
        val wsId = (n[0] shl 4) + n[1]
        val type = ((n[2] shr 1) and 0x4) + (n[2] and 0x3)
        val model = if (wsId == 0x6) "LaCrosse-WS3600" else "LaCrosse-WS2310"
        val id = (n[3] shl 4) + n[4]
        val bcd = n[7] * 100 + n[8] * 10 + n[9]
        when (type) {
            0 -> { ctx.emit(data("model" to model, "id" to id, "temperature_C" to round1((bcd - (if (wsId == 0x6) 400 else 300)) * 0.1))); events++ }
            1 -> { if (n[7] == 0xa && n[8] == 0xa) continue; ctx.emit(data("model" to model, "id" to id, "humidity" to n[7] * 10 + n[8])); events++ }
            2 -> { ctx.emit(data("model" to model, "id" to id, "rain_mm" to round2(0.518 * (n[7] * 256 + n[8] * 16 + n[9])))); events++ }
            3, 7 -> {
                if (n[7] == 0xf && n[8] == 0xe) continue
                val speed = round1((n[7] * 16 + n[8]) * 0.1)
                val out = data("model" to model, "id" to id, "wind_dir_deg" to n[9] * 22.5)
                if (type == 3) out["wind_avg_m_s"] = speed else out["wind_max_m_s"] = speed
                ctx.emit(out); events++
            }
        }
    }
    return events
}

private val WS7000_SIZE = intArrayOf(3, 6, 3, 6, 10, 7)

/** ELV / Conrad WS7000 (LaCrosse WS2500): stuffed nibbles, reflected; xor to zero and sum + 5. */
private fun lacrosseWs7000(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val start = bits.search(0, 0, UBytes.of(0x01), 8) + 8
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = UBytes(14)
    val maxBits = min(14 * 5, bits.bitsPerRow[0] - start)
    val len = extractNibbles4b1s(bits.bb[0], start, maxBits, b)
    if (len < 7) return DECODE_ABORT_LENGTH
    reflectNibbles(b, len)
    val type = b[0]
    if (type > 5) return DECODE_ABORT_EARLY
    if (len < WS7000_SIZE[type]) return DECODE_ABORT_LENGTH
    if (xorBytes(b, len - 1) != 0) return DECODE_FAIL_MIC
    if (((addBytes(b, len - 1) + 5) and 0xf) != b[len - 1]) return DECODE_FAIL_MIC
    val addr = b[1] and 0x7
    val id = (type shl 4) or addr
    val sign = if ((b[1] and 0x8) != 0) -1 else 1
    fun temp() = round1((b[4] * 10 + b[3] + b[2] * 0.1) * sign)
    fun humid() = (b[7] * 10 + b[6] + b[5] * 0.1).toInt()
    val base = arrayOf("id" to id, "channel" to addr, "mic" to "CHECKSUM")
    when (type) {
        0 -> ctx.emit(data("model" to "LaCrosse-WS700027", *base, "temperature_C" to temp()))
        1 -> ctx.emit(data("model" to "LaCrosse-WS700022", *base, "temperature_C" to temp(), "humidity" to humid()))
        2 -> ctx.emit(data("model" to "LaCrosse-WS700016", *base, "rain_mm" to round1(((b[4] shl 8) or (b[3] shl 4) or b[2]) * 0.3)))
        3 -> ctx.emit(data("model" to "LaCrosse-WS700015", *base, "wind_avg_km_h" to round1(b[4] * 10 + b[3] + b[2] * 0.1),
            "wind_dir_deg" to (b[7] shr 2) * 100 + b[6] * 10 + b[5], "wind_dev_deg" to (b[7] and 0x3) * 22.5))
        4 -> ctx.emit(data("model" to "LaCrosse-WS700020", *base, "temperature_C" to temp(), "humidity" to humid(),
            "pressure_hPa" to b[10] * 100 + b[9] * 10 + b[8] + 200))
        else -> {
            var lux = (b[4] * 100 + b[3] * 10 + b[2]).toDouble()
            repeat(b[5]) { lux *= 10 }
            ctx.emit(data("model" to "LaCrosse-WS250019", *base, "light_lux" to lux, "exposure_mins" to b[8] * 100 + b[7] * 10 + b[6]))
        }
    }
    return 1
}

/** TX31U: a list of tagged measurements; the header's count sets the frame length and the CRC's extent. */
private fun lacrosseTx31u(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    val start = bits.search(0, 0, AA_2DD4, 32)
    if (start >= n) return DECODE_ABORT_EARLY
    val msgBytes = (n - start) / 8
    if (msgBytes < 9 || msgBytes > 20) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, start, msgBytes * 8)
    val noExt = bit(msg[5], 4)
    val measurements = bf(msg[5], 0, 3)
    val expected = 6 + measurements * 2 + 1
    if (msgBytes < expected) return DECODE_ABORT_LENGTH
    if (msg[expected - 1] != crc8(msg, 2 + measurements * 2, 0x31, 0x00, 4)) return DECODE_FAIL_MIC
    val out = data("model" to "LaCrosse-TX31UIT", "id" to ((bf(msg[4], 0, 4) shl 2) or bf(msg[5], 6, 2)),
        "battery_ok" to if (bit(msg[5], 3) != 0) 0 else 1, "mic" to "CRC")
    for (m in 0 until measurements) {
        val tag = bf(msg[6 + m * 2], 4, 4)
        val n1 = bf(msg[6 + m * 2], 0, 4); val n2 = bf(msg[7 + m * 2], 4, 4); val n3 = bf(msg[7 + m * 2], 0, 4)
        when (tag) {
            0 -> out["temperature_C"] = round1(10 * n1 + n2 + 0.1 * n3 - 40)
            1 -> out["humidity"] = 100 * n1 + 10 * n2 + n3
            2 -> { val raw = (n1 shl 8) + (n2 shl 4) + n3; if (noExt == 0 && raw > 0) out["rain"] = hexOf(raw, 3) }
            3 -> if (noExt == 0) { out["wind_dir_deg"] = n1 * 22.5; out["wind_avg_km_h"] = round1(((n2 shl 4) + n3) * 0.1 * 3.6) }
            4 -> if (noExt == 0 && bit(n1, 0) == 0) out["wind_max_km_h"] = round1(((n2 shl 4) + n3) * 0.1 * 3.6)
        }
    }
    ctx.emit(out)
    return 1
}

/** TX22U: nothing says how many measurements follow, so each count from five down is tried until the CRC closes. */
private fun tx22uit(bits: BitBuffer, ctx: DecodeCtx): Int {
    val rowBits = bits.bitsPerRow[0]
    val at = bits.search(0, 0, AA_2DD4, 32)
    if (at >= rowBits) return DECODE_ABORT_EARLY
    val offset = at + 32
    val size = min(rowBits - offset, 64 * 8)
    val b = bits.bytes(0, offset, size)
    val bytes = size / 8
    var quartets = 0
    for (q in 5 downTo 1) {
        if (q == 4) continue
        val dataLen = 2 + 2 * q
        if (dataLen + 2 <= bytes && crc8(b, dataLen, 0x31, 0x00) == b[dataLen]) { quartets = q; break }
    }
    if (quartets == 0) return DECODE_FAIL_MIC
    val end = 2 + 2 * quartets
    val out = data("model" to "LaCrosse-TX22UIT", "id" to hexOf(b[0], 2), "flags" to hexOf(b[1], 2), "mic" to "CRC")
    var rawTemp = -1; var humidity = -1; var rawSpeed = -1; var direction = -1.0
    var rainMm = -1.0; var gust = -1.0; var recognized = 0
    var p = 2
    while (p < end) {
        val bcd3 = ((b[p] and 0x0f) * 100) + ((b[p + 1] shr 4) * 10) + (b[p + 1] and 0x0f)
        val nyb3 = ((b[p] and 0x0f) shl 8) or b[p + 1]
        when (b[p] shr 4) {
            0 -> { rawTemp = bcd3; recognized++ }
            1 -> { humidity = bcd3; recognized++ }
            2 -> { rainMm = 0.518 * nyb3; recognized++ }
            3 -> { direction = (b[p] and 0x0f) * 22.5; rawSpeed = b[p + 1]; recognized++ }
            4 -> { gust = nyb3 * 0.1; recognized++ }
        }
        p += 2
    }
    if (recognized == 0) return DECODE_FAIL_SANITY
    val tempC = (rawTemp - 400) * 0.1
    val speed = rawSpeed * 0.1
    if (rawTemp >= 0 && tempC > -40 && tempC <= 70) out["temperature_C"] = round1(tempC)
    if (humidity in 1..100) out["humidity"] = humidity
    if (rainMm >= 0 && rainMm <= 0xfff * 0.518) out["rain_mm"] = round2(rainMm)
    if (rawSpeed >= 0 && speed >= 0 && speed <= 200) out["wind_avg_km_h"] = round1(speed)
    if (gust >= 0 && gust <= 200) out["wind_gust_km_h"] = round1(gust)
    if (direction >= 0 && direction <= 360) out["wind_dir_deg"] = direction
    ctx.emit(out)
    return 1
}

private fun ws6868Header(b: UBytes): R433Data = data("model" to "", "id" to hexOf((b[0] shl 16) or (b[1] shl 8) or b[2], 6),
    "channel" to ((b[3] shr 4) and 3) + 1, "battery_ok" to if (((b[3] shr 7) and 1) != 0) 0 else 1,
    "test" to ((b[3] shr 6) and 1), "counter" to ((b[3] shr 1) and 7))

private fun ws6868Start(bits: BitBuffer): Int {
    if (bits.numRows != 1) return -1
    val at = bits.search(0, 0, UBytes.of(0xd2, 0xaa, 0x2d, 0xd4), 32)
    return if (at >= bits.bitsPerRow[0]) -1 else at + 32
}

private fun ws6868Th(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = ws6868Start(bits)
    if (at < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] - at < 64) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 64)
    if (crc8(b, 7, 0x31, 0x00) != b[7]) return DECODE_FAIL_MIC
    val out = ws6868Header(b)
    out["model"] = "LaCrosse-TX232TH"
    out["temperature_C"] = round1((((b[4] shl 4) or (b[5] shr 4)) - 500) * 0.1)
    out["humidity"] = ((b[5] and 0x0f) shl 8) or b[6]
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

private fun ws6868Rw(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = ws6868Start(bits)
    if (at < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] - at < 96) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 96)
    if (crc8(b, 10, 0x31, 0x00) != b[10] || (addBytes(b, 11) and 0xff) != b[11]) return DECODE_FAIL_MIC
    val out = ws6868Header(b)
    out["model"] = "LaCrosse-TX231RW"
    out["data_raw"] = hexBytes(b, 6, 4)
    out["mic"] = "CHECKSUM"
    ctx.emit(out)
    return 1
}

private const val CONSOLE = "outdoor console sensor with optional rain and wind"

internal val LACROSSE3: List<RDevice> = listOf(
    dev(34, "LaCrosse WS-2310 / WS-3600 weather station", Mod.OOK_PWM, 368, 1464, 8000, bands = B433, what = "outdoor sensors: temperature, humidity, rain and wind", decode = ::lacrosseWs),
    dev(124, "LaCrosse / ELV / Conrad WS7000 and WS2500 weather sensors", Mod.OOK_PWM, 400, 800, 1100, bands = B433,
        what = "temperature, humidity, rain, wind, pressure and brightness sensors", decode = ::lacrosseWs7000),
    dev(240, "LaCrosse TX31U-IT, The Weather Channel WS-1910TWC-IT", Mod.FSK_PCM, 116, 116, 20000, bands = BANDS, what = CONSOLE, decode = ::lacrosseTx31u),
    dev(323, "LaCrosse TX22U-IT", Mod.FSK_PCM, 116, 116, 5900, bands = BANDS, what = CONSOLE) { _, bits, ctx -> tx22uit(bits, ctx) },
    dev(324, "LaCrosse TX22U-IT, on-off keyed", Mod.OOK_PCM, 120, 120, 5000, bands = BANDS, what = CONSOLE) { _, bits, ctx -> bits.invert(); tx22uit(bits, ctx) },
    dev(374, "LaCrosse WS6868 TX232TH-LCD temperature and humidity sensor", Mod.FSK_PCM, 58, 58, 2000, bands = BANDS, what = "outdoor thermometer and hygrometer", decode = ::ws6868Th),
    dev(375, "LaCrosse WS6868 TX231RW wind and rain sensor", Mod.FSK_PCM, 58, 58, 2000, bands = BANDS, what = "wind and rain sensor", decode = ::ws6868Rw),
)
