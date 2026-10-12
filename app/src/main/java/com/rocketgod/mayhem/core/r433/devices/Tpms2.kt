package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * More tire pressure sensors: Schrader motorcycle, GM aftermarket, Jansite, Hyundai/Kia and truck sensors.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): schrader.c (motorcycle), tpms_gm.c, tpms_jansite.c,
 * tpms_elantra2012.c, tpms_truck.c. Twin of web/src/dsp/r433/devices/tpms2.ts.
 */

private val PRE_AA_AA_A9 = UBytes.of(0xaa, 0xaa, 0xa9)

/** On-off keyed rather than frequency shifted, unlike almost every car sensor. */
private fun schraderMotorcycle(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val len = bits.bitsPerRow[0]
    var pos = bits.search(0, 0, UBytes.of(0x7f, 0xf8), 13)
    if (pos >= len) return DECODE_ABORT_EARLY
    pos += 13
    if (len - pos < 56) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos, 56)
    if (crc8(b, 7, 0x07, 0xe0) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Schrader-Motorcycle", "type" to "TPMS",
        "id" to (((b[0] and 0x03) shl 22) or (b[1] shl 14) or (b[2] shl 6) or (b[3] shr 2)),
        "pressure_kPa" to (((b[3] and 0x03) shl 8) or b[4]) * 0.5, "temperature_C" to b[5] - 50, "mic" to "CRC"))
    return 1
}

/** Forty bits of identity, wider than most, because these are programmed rather than factory-assigned. */
private fun gm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 130) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 0, 130)
    for (i in 0 until 6) if (b[i] != 0x00) return DECODE_ABORT_EARLY
    var sum = 0
    var allZero = true
    for (i in 6 until 15) { sum += b[i]; allZero = allZero && b[i] == 0 }
    if ((sum and 0xff) != b[15]) return DECODE_FAIL_MIC
    if (allZero && b[15] == 0) return DECODE_FAIL_SANITY
    val flags = (b[6] shl 8) or b[7]
    ctx.emit(data("model" to "GM-Aftermarket", "type" to "TPMS",
        "id" to ((b[8].toLong() shl 32) + (b[9].toLong() shl 24) + (b[10] shl 16) + (b[11] shl 8) + b[12]), "flags" to flags,
        // All three of these bits clear means the sensor is waiting to be taught to a vehicle.
        "learn_mode" to if (((flags shr 8) and 1) == 0 && ((flags shr 1) and 1) == 0 && (flags and 1) == 0) 1 else 0,
        "battery_ok" to if (((flags shr 5) and 1) != 0) 0 else 1, "pressure_kPa" to round2(b[13] * 2.75),
        "temperature_C" to b[14] - 60, "mic" to "CHECKSUM"))
    return 1
}

/** Off by default: nobody knows what the last byte is, so a damaged frame cannot be rejected. */
private fun jansite(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var events = 0
    var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)
        if (bitpos + 80 > bits.bitsPerRow[0]) break
        val packet = BitBuffer()
        bits.manchesterDecode(0, bitpos + 24, packet, 56)
        if (packet.bitsPerRow[0] >= 56) {
            val b = packet.bb[0]
            ctx.emit(data("model" to "Jansite", "type" to "TPMS",
                "id" to hexOf((b[0] shl 20) or (b[1] shl 12) or (b[2] shl 4) or (b[3] shr 4), 7), "flags" to (b[3] and 0x0f),
                "pressure_kPa" to round1(b[4] * 1.7), "temperature_C" to b[5] - 50, "code" to hexBytes(b, 7)))
            events++
        }
        bitpos += 2
    }
    return events
}

private fun elantra2012(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val preamble = UBytes.of(0x71, 0x55)
    var events = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, preamble, 16)
            if (bitpos + 128 > bits.bitsPerRow[row]) break
            val packet = BitBuffer()
            bits.manchesterDecode(row, bitpos + 16, packet, 64)
            if (packet.bitsPerRow[0] >= 64) {
                val b = packet.bb[0]
                if (crc8(b, 8, 0x07, 0x00) == 0) {
                    ctx.emit(data("model" to "Elantra2012", "type" to "TPMS", "id" to hexOf(u32be(b, 2), 8),
                        "pressure_kPa" to b[0] + 60, "temperature_C" to b[1] - 50,
                        "battery_ok" to if (((b[6] and 0x02) shr 1) != 0) 0 else 1,
                        "triggered" to (b[6] and 0x01),            // woken by the workshop's low-frequency tool
                        "storage" to ((b[6] and 0x04) shr 2),      // shipped in a box rather than fitted to a wheel
                        "flags" to hexOf(b[6], 1), "mic" to "CRC"))
                    events++
                }
            }
            bitpos += 15
        }
    }
    return events
}

/** A rig has far more than four wheels, so the position is reported alongside the reading. */
private fun truck(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var events = 0
    var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)
        if (bitpos + 160 > bits.bitsPerRow[0]) break
        val packet = BitBuffer()
        bits.manchesterDecode(0, bitpos + 24, packet, 76)
        if (packet.bitsPerRow[0] >= 76) {
            val b = packet.bytes(0, 4, 72)               // four bits of leader before the payload proper
            if ((b[0] != 0 || b[1] != 0 || b[2] != 0 || b[3] != 0) && xorBytes(b, 9) == 0) {
                val flags = b[5] shr 4
                val out = data("model" to "Truck", "type" to "TPMS", "id" to hexOf(u32be(b, 0), 8), "wheel" to b[4],
                    "pressure_kPa" to (((b[5] and 0x0f) shl 8) or b[6]), "temperature_C" to b[7],
                    "battery_ok" to if ((flags and 0x3) == 0x3) 1 else 0, "flags" to flags, "mic" to "CHECKSUM")
                if ((flags and 0x4) == 0x4) out["pressure_alert"] = 1
                ctx.emit(out)
                events++
            }
        }
        bitpos += 2
    }
    return events
}

private const val TPMS_WHAT = "tire pressure sensor: Hyundai and Kia"

internal val TPMS2: List<RDevice> = listOf(
    dev(321, "Schrader motorcycle TPMS sensor", Mod.OOK_MANCHESTER_ZEROBIT, 122, 122, 375, bands = listOf(433_920_000L),
        what = "motorcycle tire pressure sensor", decode = ::schraderMotorcycle),
    dev(275, "GM aftermarket TPMS", Mod.OOK_MANCHESTER_ZEROBIT, 120, 0, 15600, bands = listOf(315_000_000L),
        what = "aftermarket tire pressure sensors for older GM vehicles", decode = ::gm),
    dev(123, "Jansite TPMS model TY02S", Mod.FSK_PCM, 52, 52, 150, disabled = true, bands = listOf(433_920_000L),
        what = "aftermarket tire pressure sensor", decode = ::jansite),
    dev(140, "Elantra 2012 TPMS", Mod.FSK_PCM, 49, 49, 200, bands = listOf(433_920_000L, 315_000_000L), what = TPMS_WHAT, decode = ::elantra2012),
    dev(201, "Unbranded solar TPMS for trucks", Mod.FSK_PCM, 52, 52, 150, bands = listOf(433_920_000L),
        what = "truck and trailer tire pressure sensors", decode = ::truck),
)
