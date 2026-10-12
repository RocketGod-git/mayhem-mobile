package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Ultrasonic oil tank monitors: Watchman Sonic / Apollo / Beckett Rocket, the Standard and Smart sensors, and the
 * Watchman Sonic Advanced.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): oil_watchman.c, oil_standard.c, oil_watchman_advanced.c, oil_smart.c.
 * Twin of web/src/dsp/r433/devices/oil.ts.
 */

private val BAND_433 = listOf(433_920_000L)
/** The Beckett Rocket TEK377A is the American build, keyed on and off at 915 MHz. */
private val BAND_915 = listOf(915_000_000L)
private const val WHAT = "oil tank level monitor"

private val WATCHMAN_PRE = UBytes.of(0xe0)
private val WATCHMAN_POST = UBytes.of(0x00, 0xc0)

/**
 * The postamble is the last level held two more bit times, so which pattern to expect depends on the last data
 * bit: a frame decoded wrong usually fails to produce the matching tail. The temperature is upstream's guess
 * from a field that varies inversely with warmth, so the raw field goes out too.
 */
private fun watchman(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var bitpos = 0
    var events = 0
    while (true) {
        bitpos = bits.search(0, bitpos, WATCHMAN_PRE, 6)
        if (bitpos + 136 > bits.bitsPerRow[0]) break
        bitpos += 6
        val databits = BitBuffer()
        bitpos = bits.manchesterDecode(0, bitpos, databits, 64)
        if (databits.bitsPerRow[0] != 64) continue
        val b = databits.bb[0]
        if (bits.search(0, bitpos, WATCHMAN_POST.sub(b[7] and 1), 2) != bitpos) continue
        if (b[7] != crc8le(b, 7, 0x31, 0)) continue
        val flags = b[4]
        val maybetemp = b[5] shr 2
        // Binding and reading share two bytes; the rebind flag says which arrived.
        var depth = 0; var bindingCountdown = 0
        if ((flags and 1) != 0) bindingCountdown = b[6] else depth = ((b[5] and 3) shl 8) or b[6]
        ctx.emit(data("model" to "Oil-SonicSmart", "type" to "Oil", "id" to u32be(b, 0), "flags" to flags, "maybetemp" to maybetemp,
            "temperature_C" to (145.0 - 5.0 * maybetemp) / 3.0, "binding_countdown" to bindingCountdown, "depth_cm" to depth))
        events++
    }
    return events
}

private val SMART_PREAMBLE = UBytes.of(0x55, 0x55, 0x58)

/**
 * A Smart run-in contains a valid Standard sync ten bits in, and with no checksum here that fragment would be
 * accepted with a wrong depth; so Smart packets are refused first.
 */
private fun oilStandardOne(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    if (bitpos >= 24 && bits.search(row, bitpos - 24, SMART_PREAMBLE, 24) == bitpos - 24) return 0
    val databits = BitBuffer()
    bits.manchesterDecode(row, bitpos, databits, 41)
    val n = databits.bitsPerRow[0]
    val b = databits.bb[0]
    if (n < 32 || n > 40 || (b[4] and 0xfe) != 0) return 0
    val flags = b[2] and 0xf5
    val alarm = (b[2] and 0x08) shr 3
    var depth = 0; var bindingCountdown = 0
    if ((flags and 1) != 0) {
        bindingCountdown = b[3]
    } else {
        depth = ((b[2] and 0x02) shl 7) or b[3]
        // The field is nine bits but the sensor only reaches about 305 cm: real work with no checksum.
        if (depth > 305) return 0
    }
    ctx.emit(data("model" to "Oil-SonicStd", "type" to "Oil", "id" to ((b[0] shl 8) or b[1]), "flags" to flags, "alarm" to alarm,
        "binding_countdown" to bindingCountdown, "depth_cm" to depth))
    return 1
}

/** Both sync words, each across the whole row, because a burst can carry several frames. */
private fun oilStandard(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (pattern in listOf(UBytes.of(0x55, 0x5d), UBytes.of(0x55, 0x62))) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(0, bitpos, pattern, 16)
            if (bitpos + 78 > bits.bitsPerRow[0]) break
            events += oilStandardOne(bits, ctx, 0, bitpos + 14)
            bitpos += 2
        }
    }
    return events
}

private val ADV_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xaa, 0x2d, 0xd4, 0x0e)

/**
 * Some units emit the CRC shifted one bit left, so it is also tried reassembled from one extra bit past the
 * message. The half-degree temperature is divided as an integer, as upstream does.
 */
private fun watchmanAdvanced(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var bitpos = 0
    var events = 0
    while (true) {
        bitpos = bits.search(0, bitpos, ADV_PREAMBLE, 48)
        if (bitpos + 129 > bits.bitsPerRow[0]) break
        bitpos += 40
        val msg = bits.bytes(0, bitpos, 137)
        bitpos += 136
        val crcCalc = crc16(msg, 15, 0x8005, 0)
        if (crcCalc != ((msg[15] shl 8) or msg[16])) {
            val crcShifted = ((msg[15] shl 9) or (msg[16] shl 1) or (msg[17] shr 7)) and 0xffff
            if (crcCalc != crcShifted) return DECODE_FAIL_MIC
        }
        val mcode = (msg[1] shl 8) or msg[2]
        if (mcode != 0x0401 && mcode != 0x0106 && mcode != 0x0101) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to "Oil-SonicAdv", "type" to "Oil",
            "id" to ((msg[3] shl 16) or (msg[4] shl 8) or msg[5]),   // the serial on the sensor's label
            "version" to "${msg[11] and 0x0f}.${msg[12] and 0x0f}.${msg[13] and 0x0f}.${msg[14] and 0x0f}",
            "temperature_C" to (msg[7] - 0x48) / 2, "depth_cm" to (((msg[9] and 0x0f) shl 8) or msg[10]), "status" to msg[6], "mic" to "CRC"))
        events++
    }
    return events
}

/** The Standard's frame with a checksum, so it can be trusted; the two temperature bits agreeing means too cold to read. */
private fun oilSmartOne(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val databits = BitBuffer()
    bits.manchesterDecode(row, bitpos, databits, 64)
    if (databits.bitsPerRow[0] < 64) return 0
    val b = databits.bb[0]
    if (crc8le(b, 8, 0x31, 0x00) != 0) return 0
    ctx.emit(data("model" to "Oil-Ultrasonic", "type" to "Oil", "id" to u32be(b, 0),
        "depth_cm" to ((b[5] and 0x01) shl 8) + b[6], "txstatus" to if ((b[4] and 0x40) != 0) "Rapid" else "Normal",
        "temp_ok" to if ((b[4] and 0x10) == (b[4] and 0x20)) 0 else 1, "battery_ok" to ((b[4] and 0x04) shr 2), "sensor" to (b[4] and 0x03),
        "counter" to ((b[5] and 0xf0) shr 4), "unknown" to ((b[5] and 0x0d) shr 1), "mic" to "CRC"))
    return 1
}

private val SMART_SYNC = UBytes.of(0x55, 0x58)

private fun oilSmart(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var bitpos = 0
    var events = 0
    while (true) {
        bitpos = bits.search(0, bitpos, SMART_SYNC, 16)
        if (bitpos + 128 > bits.bitsPerRow[0]) break
        events += oilSmartOne(bits, ctx, 0, bitpos + 16)
        bitpos += 2
    }
    return events
}

internal val OIL: List<RDevice> = listOf(
    dev(43, "Watchman Sonic / Apollo Ultrasonic / Beckett Rocket oil tank monitor", Mod.FSK_PCM, 1000, 1000, 4000, bands = BAND_433, what = WHAT, decode = ::watchman),
    dev(81, "Oil Ultrasonic STANDARD FSK", Mod.FSK_PCM, 500, 500, 2000, bands = BAND_433, what = WHAT, decode = ::oilStandard),
    dev(83, "Oil Ultrasonic STANDARD ASK", Mod.OOK_PCM, 500, 500, 2000, bands = BAND_915, what = WHAT, decode = ::oilStandard),
    dev(234, "Watchman Sonic Advanced / Plus, Tekelek", Mod.FSK_PCM, 500, 500, 12500, bands = BAND_433, what = WHAT, decode = ::watchmanAdvanced),
    dev(235, "Oil Ultrasonic SMART FSK", Mod.FSK_PCM, 500, 500, 9000, gapLimit = 2000, bands = BAND_433, what = WHAT, decode = ::oilSmart),
)
