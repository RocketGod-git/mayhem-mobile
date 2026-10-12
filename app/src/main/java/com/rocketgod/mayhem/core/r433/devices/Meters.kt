package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Itron ERT utility meters: SCM, SCM+, IDM and NetIDM. An IDM meter broadcasts the last several hours of a
 * household's consumption, one reading per interval, protected only by a CRC against interference.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): ert_scm.c, scmplus.c, ert_idm.c. Twin of
 * web/src/dsp/r433/devices/meters.ts.
 */

private val BANDS = listOf(912_600_000L, 915_000_000L)

/** The low nibble of the type byte; the values accumulated over decades of product lines in no order. */
private fun meterType(ertType: Int): String = when (ertType and 0x0f) {
    4, 5, 7, 8 -> "Electric"
    0, 1, 2, 9, 12 -> "Gas"
    3, 11, 13 -> "Water"
    else -> "unknown"
}

/** No sync word: identified purely by a CRC over ten bytes coming out right. */
private fun scm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 96) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    if (crc16(b, 10, 0x6f63, 0, 2) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ERT-SCM", "id" to (((b[2] and 0x06) shl 23) or (b[7] shl 16) or (b[8] shl 8) or b[9]),
        "physical_tamper" to ((b[3] and 0xc0) shr 6), "ert_type" to ((b[3] shr 2) and 0x0f), "encoder_tamper" to (b[3] and 0x03),
        // A register reading, not a unit of energy: the multiplier is held by the utility, not the meter.
        "consumption_data" to ((b[4] shl 16) or (b[5] shl 8) or b[6]), "mic" to "CRC"))
    return 1
}

private fun scmPlus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, UBytes.of(0x16, 0xa3, 0x1e), 24)
    if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] - at < 128) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 128)
    val crc = crc16(b, 12, 0x1021, 0x0971, 2)
    if (crc != ((b[14] shl 8) or b[15])) return DECODE_FAIL_MIC
    val endpointId = u32be(b, 4)
    ctx.emit(data("model" to "SCMplus", "id" to endpointId, "ProtocolID" to "0x" + hexUp(b[2]), "EndpointType" to "0x" + hexUp(b[3]),
        "EndpointID" to endpointId, "Consumption" to u32be(b, 8), "Tamper" to "0x" + hexUp((b[12] shl 8) or b[13], 4),
        "PacketCRC" to "0x" + hexUp(crc, 4), "MeterType" to meterType(b[3]), "mic" to "CRC"))
    return 1
}

/** Forty-seven nine-bit intervals, or for net meters twenty-seven fourteen-bit ones to make room for generation. */
private fun idm(bits: BitBuffer, ctx: DecodeCtx, net: Boolean): Int {
    if (bits.bitsPerRow[0] < 720) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, UBytes.of(0x16, 0xa3, 0x1c), 24)
    if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] - at < 720) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 720)
    val packetCrc = (b[88] shl 8) or b[89]
    if (crc16(b, 86, 0x1021, 0xd895, 2) != packetCrc) return DECODE_FAIL_MIC
    fun run(from: Int, count: Int) = "0x" + hexBytes(b, count, from).uppercase()

    val ertType = b[6]
    val serial = u32be(b, 7)
    val out = data("model" to if (net) "NETIDM" else "IDM", "id" to serial, "PacketTypeID" to "0x" + hexUp(b[2]), "PacketLength" to b[3],
        "ApplicationVersion" to b[5], "ERTType" to "0x" + hexUp(ertType), "ERTSerialNumber" to serial,
        "ConsumptionIntervalCount" to b[11], "ModuleProgrammingState" to b[12], "TamperCounters" to run(13, 6),
        "TransmitTimeOffset" to ((b[84] shl 8) or b[85]), "MeterIdCRC" to ((b[86] shl 8) or b[87]), "PacketCRC" to packetCrc,
        "MeterType" to meterType(ertType), "mic" to "CRC")
    val intervals = ArrayList<Int>()
    if (net) {
        var pos = at + 36 * 8
        repeat(27) { val buf = bits.bytes(0, pos, 14); intervals.add((buf[0] shl 6) or (buf[1] shr 2)); pos += 14 }
        out["Unknown_field_1"] = run(19, 7)
        out["LastGenerationCount"] = (b[26] shl 16) or (b[27] shl 8) or b[28]
        out["Unknown_field_2"] = run(29, 3)
        out["LastConsumptionNet"] = u32be(b, 32)
    } else {
        var pos = at + 31 * 8
        repeat(47) { val buf = bits.bytes(0, pos, 9); intervals.add((buf[0] shl 1) or (buf[1] shr 7)); pos += 9 }
        out["AsynchronousCounters"] = (b[19] shl 8) or b[20]
        out["PowerOutageFlags"] = run(21, 6)
        out["LastConsumptionCount"] = u32be(b, 27)
    }
    out["DifferentialConsumptionIntervals"] = intervals
    ctx.emit(out)
    return 1
}

internal val METERS: List<RDevice> = listOf(
    dev(149, "ERT standard consumption message (SCM)", Mod.OOK_MANCHESTER_ZEROBIT, 30, 0, 64, bands = BANDS,
        what = "electricity, gas and water meters", decode = ::scm),
    dev(154, "Standard consumption message plus (SCMplus)", Mod.OOK_MANCHESTER_ZEROBIT, 30, 0, 64, bands = BANDS,
        what = "electricity, gas and water meters, the newer message", decode = ::scmPlus),
    dev(160, "ERT interval data message (IDM)", Mod.OOK_MANCHESTER_ZEROBIT, 30, 0, 20000, gapLimit = 20000, bands = BANDS,
        what = "meters reporting several hours of consumption history at a time") { _, bits, ctx -> idm(bits, ctx, false) },
    dev(161, "ERT interval data message (IDM) for net meters", Mod.OOK_MANCHESTER_ZEROBIT, 30, 0, 20000, gapLimit = 20000, bands = BANDS,
        what = "meters that measure generation as well as consumption") { _, bits, ctx -> idm(bits, ctx, true) },
)
