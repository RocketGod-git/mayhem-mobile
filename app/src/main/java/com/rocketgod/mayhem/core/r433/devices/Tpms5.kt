package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Tire pressure sensors: BMW Gen2-5 and the Audi pressure alert, TRW (Chrysler), SmarTire (Aston Martin),
 * Mercedes Sprinter, Jeep and Honda.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): tpms_bmw.c, tpms_bmwg3.c, tpms_trw.c, tpms_smartire.c,
 * tpms_mercedes_benz.c, tpms_jeep.c, tpms_honda.c. Twin of web/src/dsp/r433/devices/tpms5.ts.
 */

private val BANDS = listOf(315_000_000L, 433_920_000L)
private const val WHAT = "tire pressure sensor"

/**
 * Eleven bytes for a BMW sensor or eight for an Audi pressure alert, judged by how much survived the Manchester
 * decode; the CRC over the shorter length keeps a truncated BMW frame from passing as an Audi one.
 */
private fun bmw(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0xaa, 0x59), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    var lenMsg = 11
    val decoded = BitBuffer()
    bits.manchesterDecode(0, pos + 16, decoded, lenMsg * 8)
    if (decoded.bitsPerRow[0] < 88) { if (decoded.bitsPerRow[0] >= 64) lenMsg = 8 else return DECODE_ABORT_LENGTH }
    decoded.invert()
    val b = decoded.bb[0]
    if (crc8(b, lenMsg, 0x2f, 0xaa) != 0) return DECODE_FAIL_MIC
    val out = data("model" to if (lenMsg == 11) "BMW-GEN5" else "Audi-PressureAlert", "type" to "TPMS",
        "brand" to b[0],                                 // 0x00 Audi alert, 0x03 HUF/Beru, 0x23 Schrader, 0x80 Continental, 0x88 Audi
        "id" to hexBytes(b, 4, 1), "pressure_kPa" to round1(b[5] * 2.45), "temperature_C" to b[6] - 52,
        "msg" to hexBytes(b, lenMsg), "mic" to "CRC")
    if (lenMsg == 11) {
        out["flags1"] = b[7]                             // warning bits: battery, deflating fast
        out["flags2"] = b[8]                             // sequence number, not yet confirmed
        out["flags3"] = b[9]                             // target nominal pressure on the Beru sensor
    } else {
        out["alert"] = "Alert Pressure increase/decrease !"
    }
    ctx.emit(out)
    return 1
}

/** Differential Manchester; eighty-one bits is the second generation, eighty-nine the third. */
private fun bmwG3(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0xcc, 0xcd), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val decoded = BitBuffer()
    bits.differentialManchesterDecode(0, pos + 16, decoded, 88)
    val msgLen = decoded.bitsPerRow[0]
    val isGen2 = if (msgLen in 80..87) 1 else 0
    if (msgLen < 80) return DECODE_ABORT_LENGTH
    val b = decoded.bb[0]
    if (crc16(b, 11 - isGen2, 0x1021, 0x0000) != 0) return DECODE_FAIL_MIC
    val out = data("model" to if (isGen2 != 0) "BMW-GEN2" else "BMW-GEN3", "type" to "TPMS", "id" to u32be(b, 0).toString(),
        "pressure_kPa" to round1((b[4] - 43) * 2.5), "temperature_C" to b[5] - 40, "flags1" to b[6], "flags2" to b[7],
        "msg" to hexBytes(b, if (isGen2 != 0) 10 else 11), "mic" to "CRC")
    if (isGen2 == 0) out["flags3"] = b[8]
    ctx.emit(out)
    return 1
}

/** One frame sent twice, keyed and shifted; the trailing nibble says genuine part or copy. */
private fun trw(bits: BitBuffer, ctx: DecodeCtx, fsk: Boolean): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val msgLen = bits.bitsPerRow[0]
    if (msgLen > 98) return DECODE_ABORT_LENGTH
    val pre = if (fsk) UBytes.of(0x7f, 0xff) else UBytes.of(0x00, 0x01)
    var pos = bits.search(0, 0, pre, 16)
    if (pos >= msgLen) return DECODE_ABORT_EARLY
    if (pos + 8 * 11 > msgLen) return DECODE_ABORT_LENGTH
    pos += 16
    if (msgLen - pos < 81) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos, 88)
    if (crc8(b, 10, 0x07, 0x00) != 0) return DECODE_FAIL_MIC
    val flags = (b[5] and 0xf0) shr 4
    val motion = b[8]
    val oem = (b[10] and 0xf0) shr 4
    val out = data("model" to "TRW", "type" to "TPMS", "mode" to hexOf(b[0]), "id" to hexBytes(b, 4, 1), "flags" to hexOf(flags, 1),
        "seq_num" to (b[5] and 0x0f), "pressure_PSI" to round1(b[6] * 0.4), "temperature_C" to b[7] - 50,
        "motion_flags" to hexOf(motion), "motion_status" to if (motion == 0x0e) "Parked" else "Moving", "mic" to "CRC")
    if (flags == 0x6 || flags == 0x9) out["alert"] = "Pressure increase/decrease !"
    if (oem == 0x4) out["oem_model"] = "OEM" else if (oem == 0x0) out["oem_model"] = "Clone"
    ctx.emit(out)
    return 1
}

/** Pressure and temperature alternate, five of each, so one transmission only ever half-describes the tire. */
private fun smartire(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0x32, 0xb4), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val decoded = BitBuffer()
    bits.differentialManchesterDecode(0, pos + 16, decoded, 6 * 8)
    // The last bit never arrives.
    if (decoded.bitsPerRow[0] < 6 * 8 - 1) return DECODE_ABORT_LENGTH
    val b = decoded.bb[0]
    if (crc7(b, 6, 0x45, 0x6f) != 0) return DECODE_FAIL_MIC
    val msgType = (b[1] and 0xc0) shr 6
    val value = b[0] - 40
    val out = data("model" to "SmarTire-AM", "type" to "TPMS", "id" to (((b[1] and 0x3f) shl 16) or (b[2] shl 8) or b[3]).toString(),
        "flags" to (b[4] and 0x7f), "mic" to "CRC")
    when (msgType) {
        0 -> out["pressure_kPa"] = round1(value * 2.5)
        1 -> out["temperature_C"] = value
        else -> return DECODE_ABORT_EARLY
    }
    if (((b[4] and 0x80) shr 7) != 0) out["inflate"] = 1    // the tire is being pumped up right now
    ctx.emit(out)
    return 1
}

private fun mercedes(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0x00, 0x20), 12)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 80) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos + 12, 80)
    if (crc8(b, 10, 0x2f, 0xaa) != 0) return DECODE_FAIL_MIC
    // Only two first bytes have ever been seen: parked, and moving.
    if (b[0] != 0x83 && b[0] != 0xa3) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "MercedesBenz-Sprinter", "type" to "TPMS", "id" to hexBytes(b, 4, 1), "pressure_PSI" to round1(b[5] / 2.75),
        "temperature_C" to b[6] - 51, "counter" to (b[7] and 0x1f), "flags1" to (b[7] shr 5), "flags2" to b[8], "mic" to "CRC"))
    return 1
}

private fun jeepDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos, packet, 88)
    if (packet.bitsPerRow[0] < 80) return DECODE_FAIL_SANITY
    val b = packet.bb[0]
    if (b[6] == 0 || b[7] == 0) return DECODE_ABORT_EARLY
    var chk = 0
    for (i in 1..9) chk = chk xor b[i]
    if (chk != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Jeep", "type" to "TPMS", "id" to hexOf(u32be(b, 1), 8),
        "state" to hexOf(b[0]),                          // not covered by the checksum
        "flags" to (b[5] shr 4), "repeat" to (b[5] and 0x0f), "pressure_kPa" to jsRound(b[6] * 2.728),
        "temperature_C" to b[7] - 50, "maybe_battery" to b[8], "mic" to "CHECKSUM"))
    return 1
}

/** Off by default: the same bits as the Citroen sensor at 82, at exactly double its pressure. */
private fun jeep(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xaa, 0xa9)
    bits.invert()
    var bitpos = 0; var events = 0; var ret = 0
    while (true) {
        bitpos = bits.search(0, bitpos, pre, 16)
        if (bitpos + 178 > bits.bitsPerRow[0]) break
        ret = jeepDecode(bits, ctx, 0, bitpos + 16)
        if (ret > 0) events += ret
        bitpos += 2
    }
    return if (events > 0) events else ret
}

/**
 * Every frame opens with a deliberate coding violation a Manchester decoder cannot produce, so the marker must
 * sit at the row's very start. The pressure bound stands aside for a different TRW board of the same shape.
 */
private fun honda(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.search(0, 0, UBytes.of(0xda, 0xe3, 0x54), 23) != 0) return DECODE_ABORT_EARLY
    if (23 + 128 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val packet = BitBuffer()
    bits.manchesterDecode(0, 23, packet, 64)
    if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_LENGTH
    val b = packet.bb[0]
    if (crc8(b, 7, 0x07, 0x00) != b[7]) return DECODE_FAIL_MIC
    if (b[0] in 1..49) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Honda-TRW", "type" to "TPMS", "id" to hexOf(u32be(b, 2), 8), "pressure_PSI" to round1(b[0] * 0.2),
        "temperature_C" to b[1] - 50, "flags" to hexOf(b[6]), "mic" to "CRC"))
    return 1
}

internal val TPMS5: List<RDevice> = listOf(
    dev(252, "BMW Gen4-Gen5 TPMS and Audi TPMS Pressure Alert (HUF/Beru, Continental, Schrader/Sensata, Audi)", Mod.FSK_PCM, 25, 25, 100,
        bands = BANDS, what = WHAT, decode = ::bmw),
    dev(257, "BMW Gen2 and Gen3 TPMS", Mod.FSK_PCM, 52, 52, 160, bands = BANDS, what = WHAT, decode = ::bmwG3),
    dev(298, "TRW TPMS OOK OEM and Clone models", Mod.OOK_MANCHESTER_ZEROBIT, 52, 52, 150, bands = BANDS,
        what = "tire pressure sensor: Chrysler") { _, bits, ctx -> trw(bits, ctx, false) },
    dev(299, "TRW TPMS FSK OEM and Clone models", Mod.FSK_MANCHESTER_ZEROBIT, 52, 52, 150, bands = BANDS,
        what = "tire pressure sensor: Chrysler") { _, bits, ctx -> trw(bits, ctx, true) },
    dev(343, "SmarTire TPMS sensor, Aston Martin/Vantage DB9 protocol", Mod.OOK_PCM, 167, 167, 1000, bands = BANDS, what = WHAT, decode = ::smartire),
    dev(365, "Mercedes Benz Sprinter 4500 TPMS sensor", Mod.FSK_MANCHESTER_ZEROBIT, 25, 25, 2000, bands = BANDS, what = WHAT, decode = ::mercedes),
    dev(380, "Jeep TPMS", Mod.FSK_PCM, 52, 52, 150, disabled = true, bands = BANDS, what = "tire pressure sensor: Grand Cherokee", decode = ::jeep),
    dev(381, "Honda (TRW PPA-GF33) TPMS", Mod.FSK_PCM, 50, 50, 200, bands = BANDS, what = WHAT, decode = ::honda),
)
