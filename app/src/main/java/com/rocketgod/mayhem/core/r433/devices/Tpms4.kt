package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Tire pressure sensors: Toyota PMV-107J, Hyundai VDO, Porsche, AVE, Renault 0435R, TyreGuard 400, Kia, Nissan.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): tpms_pmv107j.c, tpms_hyundai_vdo.c, tpms_porsche.c, tpms_ave.c,
 * tpms_renault_0435r.c, tpms_tyreguard400.c, tpms_kia.c, tpms_nissan.c. Twin of web/src/dsp/r433/devices/tpms4.ts.
 */

private val BANDS = listOf(315_000_000L, 433_920_000L)
private const val WHAT = "tire pressure sensor"

/** A search-and-decode loop over row zero, as most of these sensors use. */
private inline fun scan0(bits: BitBuffer, pre: UBytes, preBits: Int, need: Int, step: Int, decode: (Int) -> Int): Int {
    var bitpos = 0; var events = 0; var ret = 0
    while (true) {
        bitpos = bits.search(0, bitpos, pre, preBits)
        if (bitpos + need > bits.bitsPerRow[0]) break
        ret = decode(bitpos + preBits)
        if (ret > 0) events += ret
        bitpos += step
    }
    return if (events > 0) events else ret
}

/** Pressure is sent twice, the second copy bit-flipped: the frame must pass the CRC and agree with its mirror. */
private fun pmv107jDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    val startPos = bits.differentialManchesterDecode(row, bitpos, packet, 70)
    if (startPos - bitpos < 67 * 2) return 0
    val b = UBytes(9)
    b[0] = packet.bb[0][0] shr 6
    packet.extractBytes(0, 2, b.sub(1), 64)
    if (crc8(b, 8, 0x13, 0x00) != b[8]) return 0
    val pressure1 = b[5]
    if (pressure1 != (b[6] xor 0xff)) return 0
    val id = (b[0] shl 26) or (b[1] shl 18) or (b[2] shl 10) or (b[3] shl 2) or (b[4] shr 6)
    ctx.emit(data("model" to "PMV-107J", "type" to "TPMS", "id" to hexOf(id, 8), "status" to (b[4] and 0x3f),
        "battery_ok" to if (((b[4] and 0x20) shr 5) != 0) 0 else 1, "counter" to ((b[4] and 0x18) shr 3),
        "rapid_change" to ((b[4] and 0x02) shr 1), "failed" to if ((b[4] and 0x01) != 0) "FAIL" else "OK",
        "pressure_kPa" to round1((pressure1 - 40) * 2.48), "temperature_C" to b[7] - 40, "mic" to "CRC"))
    return 1
}

private fun pmv107j(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int =
    scan0(bits, UBytes.of(0xf8), 6, 67 * 2, 2) { pmv107jDecode(bits, ctx, 0, it) }

private fun hyundaiVdoDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos, packet, 80)
    if (packet.bitsPerRow[0] < 80) return DECODE_FAIL_SANITY
    val b = packet.bb[0]
    if (crc8(b, 9, 0x07, 0xaa) != b[9]) return 0
    ctx.emit(data("model" to "Hyundai-VDO", "type" to "TPMS", "id" to hexOf(u32be(b, 1), 8), "state" to b[0], "flags" to (b[5] shr 4),
        "repeat" to (b[5] and 0x0f), "pressure_kPa" to jsRound(b[6] * 1.375), "temperature_C" to b[7] - 50, "maybe_battery" to b[8], "mic" to "CRC"))
    return 1
}

private fun hyundaiVdo(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    return scan0(bits, UBytes.of(0xaa, 0xaa, 0xaa, 0xa9), 32, 80, 2) { hyundaiVdoDecode(bits, ctx, 0, it) }
}

private fun porscheDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.differentialManchesterDecode(row, bitpos, packet, 80)
    if (packet.bitsPerRow[0] < 80) return 0
    val b = packet.bb[0]
    if (crc16(b, 10, 0x1021, 0xffff) != 0) return 0
    ctx.emit(data("model" to "Porsche", "type" to "TPMS", "id" to hexOf(u32be(b, 0), 8), "pressure_kPa" to b[4] * 5 / 2 - 100,
        "temperature_C" to b[5] - 40, "flags" to hexOf((b[6] shl 8) or b[7], 4), "mic" to "CRC"))
    return 1
}

/**
 * The run-in is accepted either way up: differential Manchester reads the same in both polarities but a
 * preamble search does not, and rtl_433's own sample for this sensor is the opposite way up from its pattern.
 */
private fun porsche(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (pre in listOf(UBytes.of(0x33, 0x33, 0x20), UBytes.of(0xcc, 0xcc, 0xd0))) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(0, bitpos, pre, 20)
            if (bitpos + 100 > bits.bitsPerRow[0]) break
            events += porscheDecode(bits, ctx, 0, bitpos + 20)
            bitpos += 2
        }
    }
    return events
}

/** Four calibrations chosen by two bits: the same reading means four different pressures. */
private val AVE_RATIO = doubleArrayOf(2.352, 2.352, 5.491, 5.491)
private val AVE_OFFSET = doubleArrayOf(47.0, 0.0, 18.2, 0.0)

private fun aveDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.differentialManchesterDecode(row, bitpos, packet, 160)
    // Upstream indexes the decoded packet by the source row; only row zero is filled, so later rows bail here.
    if (packet.bitsPerRow[row] < 64) return DECODE_ABORT_LENGTH
    val b = packet.bb[row]
    if (crc8(b, 8, 0x31, 0xff) != 0) return DECODE_FAIL_MIC
    val mode = (b[6] shr 6) and 0x3
    val batteryRaw = (b[6] shr 3) and 0x7
    val batteryPct = when (batteryRaw) { 6 -> 75; 7 -> 25; else -> 100 }
    ctx.emit(data("model" to "AVE", "type" to "TPMS", "id" to hexOf(u32be(b, 0), 8), "mode" to "M$mode",
        "pressure_kPa" to round1((b[4] - AVE_OFFSET[mode]) * AVE_RATIO[mode]), "temperature_C" to b[5] - 50,
        "battery_ok" to if (batteryRaw != 7) 1 else 0, "battery_pct" to batteryPct, "flags" to hexOf(b[6] and 0x7, 1), "mic" to "CRC"))
    return 1
}

private fun ave(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xcc, 0xcc, 0xcc, 0xcd)
    var events = 0; var ret = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(0, bitpos, pre, 32)
            if (bitpos + 132 > bits.bitsPerRow[0]) break
            ret = aveDecode(bits, ctx, row, bitpos + 32)
            if (ret > 0) { events += ret; bitpos += 132 }
            bitpos += 31
        }
    }
    return if (events > 0) events else ret
}

private fun renaultDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos, packet, 160)
    if (packet.bitsPerRow[0] < 72) return DECODE_ABORT_EARLY
    val b = packet.bb[0]
    if (xorBytes(b, 9) != 0) return DECODE_FAIL_MIC
    val tick = b[8] and 0x7f
    val hasTick = b[8] shr 7
    if (b[8] != 0 && (hasTick == 0 || tick > 30)) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Renault-0435R", "type" to "TPMS", "id" to hexBytes(b, 3), "flags" to hexOf(b[3]),
        "pressure_kPa" to round1(b[4] / 0.75), "temperature_C" to b[5] - 50,
        "centrifugal_acc" to b[6] * 5,                   // how hard the wheel throws it outward: the car is moving
        "has_tick" to hasTick, "tick" to tick - 0x80 * (1 - hasTick), "mic" to "CHECKSUM"))
    return 1
}

private fun renault(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xaa, 0xa9)
    bits.invert()
    var events = 0; var ret = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, pre, 16)
            if (bitpos + 160 > bits.bitsPerRow[row]) break
            ret = renaultDecode(bits, ctx, row, bitpos + 16)
            if (ret > 0) events += ret
            bitpos += 15
        }
    }
    return if (events > 0) events else ret
}

private const val TYREGUARD400_BITS = 88

/** The sync word is inside the checked range, so a good frame checks out to zero. */
private fun tyreguardDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val b = bits.bytes(row, bitpos, TYREGUARD400_BITS)
    if (crc8(b, 11, 0x31, 0xdd) != 0) return DECODE_FAIL_MIC
    val flags = b[9]
    val id = ((b[3] and 0x0f) shl 24) or (b[4] shl 16) or (b[5] shl 8) or b[6]
    ctx.emit(data("model" to "TyreGuard400", "type" to "TPMS", "id" to hexOf(id, 7),
        "pressure_kPa" to (b[7] or ((flags and 0x70) shl 4)), "temperature_C" to b[8] - 40,
        "peering_request" to (flags and 0x3), "leaking" to (flags and 0x3), "ack_leaking" to (flags and 0x8), "mic" to "CRC"))
    return 1
}

private fun tyreguard(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val sync = UBytes.of(0xfd, 0x5f, 0xd5, 0xf0)
    var events = 0; var ret = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < TYREGUARD400_BITS) continue
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, sync, 28)
            if (bitpos + TYREGUARD400_BITS > bits.bitsPerRow[row]) break
            ret = tyreguardDecode(bits, ctx, row, bitpos)
            if (ret > 0) events += ret
            bitpos += TYREGUARD400_BITS
        }
    }
    return if (events > 0) events else ret
}

/** 154 bits, not a whole number of bytes: the last three checked bits fall off the end and count as zero. */
private fun kiaDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    val startPos = bits.manchesterDecode(row, bitpos, packet, 154 - 16)
    if (startPos - bitpos < 154 - 16) return DECODE_ABORT_LENGTH
    val b = packet.bb[0]
    if (crc8(b, 8, 0x07, 0x76) != (b[8] and 0x07.inv() and 0xff)) return DECODE_FAIL_MIC
    val pressure = ((b[0] shl 4) or (b[1] shr 4)) and 0xff
    val temperature = ((b[1] shl 4) or (b[2] shr 4)) and 0xff
    val id = (b[2] shl 28) or (b[3] shl 20) or (b[4] shl 12) or (b[5] shl 4) or (b[6] shr 4)
    ctx.emit(data("model" to "Kia", "type" to "TPMS", "id" to hexOf(id, 8), "unknown1" to hexOf(b[0] shr 4, 2),
        // Upstream holds this in a single byte, so the high half is dropped there too.
        "unknown2" to hexOf(((b[6] shl 8) or b[7]) and 0xff, 3), "pressure_PSI" to round1(pressure / 5.0),
        "temperature_C" to temperature - 50, "raw" to hexBytes(b, 9), "mic" to "CRC"))
    return 1
}

private fun kia(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int =
    scan0(bits, UBytes.of(0xed, 0x71), 16, 154, 2) { kiaDecode(bits, ctx, 0, it) }

/** Two check bits built from overlapping shifts of each byte, so every bit lands in the sum more than once. */
private fun nissanChecksum(b: UBytes): Int {
    var chk = 0
    for (i in 0 until 4) {
        chk = (chk + (b[i] shr 7)) and 0xff
        chk = (chk + (b[i] shr 5)) and 0xff
        chk = (chk + (b[i] shr 3)) and 0xff
        chk = (chk + (b[i] shr 1)) and 0xff
        chk = (chk + ((b[i] shl 1) and 0xff)) and 0xff
    }
    chk = (chk + (b[4] shr 7)) and 0xff
    chk = (chk + (b[4] shr 5)) and 0xff
    chk = (chk + (b[4] shr 3)) and 0xff
    return chk.inv() and 0x03
}

private fun nissanDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos, packet, 113)
    if (packet.bitsPerRow[0] < 37) return DECODE_FAIL_SANITY
    packet.invert()                                      // G. E. Thomas convention, not IEEE 802.3
    val b = packet.bb[0]
    if (nissanChecksum(b) != 0) return DECODE_FAIL_MIC
    val id = ((b[0] and 0x1f) shl 19) or (b[1] shl 11) or (b[2] shl 3) or (b[3] shr 5)
    val pressureRaw = ((b[3] and 0x1f) shl 3) or (b[4] shr 5)
    ctx.emit(data("model" to "Nissan", "type" to "TPMS", "id" to hexOf(id, 6), "mode" to (b[0] shr 5),
        "pressure_PSI" to round1(pressureRaw / 4.0 - 3), "unknown" to ((b[4] and 0x1f) shr 3), "mic" to "CHECKSUM"))
    return 1
}

private fun nissan(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int =
    scan0(bits, UBytes.of(0xf5, 0x55, 0x55, 0x55, 0xe0), 36, 77, 1) { nissanDecode(bits, ctx, 0, it) }

internal val TPMS4: List<RDevice> = listOf(
    dev(110, "PMV-107J (Toyota) TPMS", Mod.FSK_PCM, 100, 100, 250, bands = BANDS, what = WHAT, decode = ::pmv107j),
    dev(186, "Hyundai TPMS (VDO)", Mod.FSK_PCM, 52, 52, 150, bands = BANDS, what = WHAT, decode = ::hyundaiVdo),
    dev(203, "Porsche Boxster/Cayman TPMS", Mod.FSK_PCM, 52, 52, 150, bands = BANDS, what = WHAT, decode = ::porsche),
    dev(208, "AVE TPMS", Mod.FSK_PCM, 100, 100, 400, tolerance = 15, bands = BANDS, what = WHAT, decode = ::ave),
    dev(212, "Renault 0435R TPMS", Mod.FSK_PCM, 52, 52, 150, bands = BANDS, what = WHAT, decode = ::renault),
    dev(225, "TyreGuard 400 TPMS", Mod.OOK_MANCHESTER_ZEROBIT, 100, 100, 500, bands = BANDS,
        what = "tire pressure sensor: caravan and trailer monitor", decode = ::tyreguard),
    dev(226, "Kia TPMS", Mod.FSK_PCM, 50, 50, 200, bands = BANDS, what = "tire pressure sensor: Kia Rio and some Hyundai", decode = ::kia),
    dev(248, "Nissan TPMS", Mod.FSK_PCM, 120, 120, 250, bands = BANDS, what = WHAT, decode = ::nissan),
)
