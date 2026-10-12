package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * The later ThermoPro range: TX-2, TP211B, TP28b, TP828B, TP829B and the TempSpike XR.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): thermopro_tx2.c, thermopro_tp211b.c, thermopro_tp28b.c,
 * thermopro_tp82xb.c, thermopro_tp86xb.c. Twin of web/src/dsp/r433/devices/thermopro2.ts.
 */

private val BANDS = listOf(433_920_000L)
private val SYNC = UBytes.of(0x55, 0x2d, 0xd4)
private val SYNC_D2AA = UBytes.of(0xd2, 0xaa, 0x2d, 0xd4)
private val SYNC_D255 = UBytes.of(0xd2, 0x55, 0x2d, 0xd4)

private fun allSame(b: UBytes, n: Int, v: Int): Boolean { for (i in 0 until n) if (b[i] != v) return false; return true }

/** Four repeats rather than three, because the Auriol v2 frame is close enough that three would confuse them. */
private fun tx2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    // The Alecto and Auriol v2 boards open with eight sync bits, which would otherwise look like a tiny frame.
    if (bits.bitsPerRow[0] <= 8 && bits.bitsPerRow[0] != 0) return DECODE_ABORT_EARLY
    val row = bits.findRepeatedRow(4, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[0] and 0xf0) != 0x90 && (b[0] and 0xf0) != 0x50) return DECODE_FAIL_SANITY
    val humidity = ((b[3] and 0x0f) shl 4) or (b[4] shr 4)
    val out = data("model" to "Thermopro-TX2", "subtype" to (b[0] shr 4), "id" to (((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4)),
        "channel" to (b[1] and 0x03) + 1, "battery_ok" to if ((b[1] and 0x08) != 0) 0 else 1,
        "temperature_C" to round2((signed((b[2] shl 8) or (b[3] and 0xf0), 16) shr 4) * 0.1), "button" to ((b[1] and 0x04) shr 2))
    if (humidity != 0xcc) out["humidity"] = humidity     // 0xcc: no hygrometer on this board
    ctx.emit(out)
    return 1
}

/** One sixteen-bit constant per bit of the first six bytes, folded together for every set bit. Not a CRC. */
private val TP211B_XOR = intArrayOf(
    0xc881, 0xc441, 0xc221, 0xc111, 0xc089, 0xc045, 0xc023, 0xc010,
    0xc01f, 0xc00e, 0x6007, 0x9002, 0x4801, 0x8401, 0xe201, 0xd101,
    0xde01, 0xcf01, 0xc781, 0xc3c1, 0xc1e1, 0xc0f1, 0xc079, 0xc03d,
    0xc029, 0xc015, 0xc00b, 0xc004, 0x6002, 0x3001, 0xb801, 0xfc01,
    0xe801, 0xd401, 0xca01, 0xc501, 0xc281, 0xc141, 0xc0a1, 0xc051,
    0xc061, 0xc031, 0xc019, 0xc00d, 0xc007, 0xc002, 0x6001, 0x9001,
)

private fun tp211bChecksum(b: UBytes): Int {
    var sum = 0x411b
    for (n in 0 until 6) for (i in 0 until 8) if (((b[n] shl (i + 1)) and 0x100) != 0) sum = sum xor TP211B_XOR[n * 8 + i]
    return sum and 0xffff
}

private fun tp211b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    val at = bits.search(0, 0, SYNC, 24)
    if (at >= n) return DECODE_ABORT_EARLY
    if (n - at < 64) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 24, 64)
    if (b[5] != 0xaa) return DECODE_FAIL_SANITY
    if (allSame(b, 5, 0x00) || allSame(b, 5, 0xff)) return DECODE_FAIL_SANITY
    if (((b[6] shl 8) or b[7]) != tp211bChecksum(b)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ThermoPro-TP211B", "id" to hexOf((b[0] shl 16) or (b[1] shl 8) or b[2], 6),
        "battery_ok" to if (((b[3] and 0x80) shr 7) != 0) 0 else 1,
        "temperature_C" to round1(((((b[3] and 0x0f) shl 8) or b[4]) - 500) * 0.1), "mic" to "CHECKSUM"))
    return 1
}

/** Two decimal digits and a tenth, packed as BCD across a pair of bytes. */
private fun bcd2(lo: Int, hi: Int) = ((hi and 0xf0) shr 4) * 100 + (hi and 0x0f) * 10 + ((lo and 0xf0) shr 4) + (lo and 0x0f) * 0.1

private fun tp28b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    if (n < 240 || n > 451) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC_D2AA, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at + 32, 18 * 8)
    if ((((addBytes(b, 16) and 0xff) - b[16]) and 0xff) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ThermoPro-TP28b", "id" to hexOf((b[14] shl 8) or b[15], 4),
        "temperature_1_C" to round1(bcd2(b[0], b[1])), "alarm_high_1_C" to round1(bcd2(b[2], b[3])), "alarm_low_1_C" to round1(bcd2(b[4], b[5])),
        "temperature_2_C" to round1(bcd2(b[6], b[7])), "alarm_high_2_C" to round1(bcd2(b[8], b[9])), "alarm_low_2_C" to round1(bcd2(b[10], b[11])),
        "flags" to hexOf((b[12] shl 8) or b[13], 4), "mic" to "CHECKSUM"))
    return 1
}

/** The TP82xB pair digest their frame back to front. */
private fun reversedBytes(b: UBytes, n: Int): UBytes { val out = UBytes(n); for (i in 0 until n) out[i] = b[n - 1 - i]; return out }

/** 0xedd is an empty socket; 0xeaa a low alarm switched off. */
private const val NO_PROBE = 0xedd
private const val NO_ALARM = 0xeaa
private fun probeC(raw: Int) = round1((raw - 500) * 0.1)
/** How the base station displays these, not how they are sent. */
private fun displayUnit(v: Int) = when (v) { 0x2 -> "Fahrenheit"; 0x0 -> "Celsius"; else -> "" }

private fun tp828b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    if (n > 280) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC, 24)
    if (at >= n) return DECODE_ABORT_EARLY
    if (n - at < 96) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 24, 12 * 8)
    if ((lfsrDigest8(reversedBytes(b, 11), 11, 0x98, 0x16) xor 0xac) != b[11]) return DECODE_FAIL_MIC
    val p1 = (b[2] shl 4) or ((b[3] and 0xf0) shr 4)
    val p1lo = ((b[3] and 0x0f) shl 8) or b[4]
    val p1hi = (b[5] shl 4) or ((b[6] and 0xf0) shr 4)
    val p2 = ((b[6] and 0x0f) shl 8) or b[7]
    val p2lo = (b[8] shl 4) or ((b[9] and 0xf0) shr 4)
    val p2hi = ((b[9] and 0x0f) shl 8) or b[10]
    val out = data("model" to "ThermoPro-TP828b", "id" to hexOf(b[0]), "flags" to Integer.toHexString(b[1] and 0x0f),
        "temperature_1_HI_C" to probeC(p1hi), "temperature_2_HI_C" to probeC(p2hi), "mic" to "CHECKSUM")
    val unit = displayUnit((b[1] and 0xf0) shr 4)
    if (unit.isNotEmpty()) out["display_u"] = unit
    if (p1 != NO_PROBE) out["temperature_1_C"] = probeC(p1)
    if (p1lo != NO_ALARM) out["temperature_1_LO_C"] = probeC(p1lo)
    if (p2 != NO_PROBE) out["temperature_2_C"] = probeC(p2)
    if (p2lo != NO_ALARM) out["temperature_2_LO_C"] = probeC(p2lo)
    ctx.emit(out)
    return 1
}

private fun tp829b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    if (n > 260) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC, 24)
    if (at >= n) return DECODE_ABORT_EARLY
    if (n - at < 96) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 24, 9 * 8)
    // The idle frame a base station sends when nothing is paired to it.
    if (b[5] == 0xaa && b[6] == 0x55 && b[7] == 0xaa && b[8] == 0) return DECODE_ABORT_EARLY
    if (lfsrDigest8(reversedBytes(b, 8), 8, 0x98, 0x55) != b[8]) return DECODE_FAIL_MIC
    val raw = intArrayOf((b[2] shl 4) or ((b[3] and 0xf0) shr 4), ((b[3] and 0x0f) shl 8) or b[4],
        (b[5] shl 4) or ((b[6] and 0xf0) shr 4), ((b[6] and 0x0f) shl 8) or b[7])
    val out = data("model" to "ThermoPro-TP829b", "id" to hexOf(b[0]), "flags" to Integer.toHexString(b[1] and 0x0f), "mic" to "CHECKSUM")
    val unit = displayUnit((b[1] and 0xf0) shr 4)
    if (unit.isNotEmpty()) out["display_u"] = unit
    for (i in 0 until 4) if (raw[i] != NO_PROBE) out["temperature_${i + 1}_C"] = probeC(raw[i])
    ctx.emit(out)
    return 1
}

/** A CRC-8 with a private final xor, and the next byte must share no set bit with it: a free second opinion. */
private fun tp86xb(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    if (n < 165 || n > 173) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC_D255, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    if (n - (at + 32) < 72) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 32, 9 * 8)
    if ((b[7] and b[8]) != 0) return DECODE_FAIL_MIC
    if ((crc8(b, 7, 0x07, 0x00) xor 0xdb) != b[7]) return DECODE_FAIL_MIC
    val isProbe = (b[6] and 0x0c) == 0x0c
    val isBooster = (b[5] and 0xc0) == 0xc0
    val isDocked = (b[1] and 0x40) shr 6
    val out = data("model" to "ThermoPro-TempSpikeXR", "id" to hexOf(b[0]), "color" to if (((b[1] and 0x10) shr 4) != 0) "white" else "black",
        "temperature_int_C" to probeC((b[2] shl 4) or (b[3] shr 4)), "temperature_amb_C" to probeC(((b[3] and 0x0f) shl 8) or b[4]), "mic" to "CRC")
    if (isDocked != 0) out["is_docked"] = isDocked
    if (isProbe) { out["is_probe"] = 1; out["probe_battery"] = (b[6] and 0x30) shr 4 }
    if (isBooster) { out["is_booster"] = 1; out["booster_battery"] = b[6] and 0x03 }
    ctx.emit(out)
    return 1
}

private const val BBQ = "barbecue thermometer"

internal val THERMOPRO2: List<RDevice> = listOf(
    dev(162, "ThermoPro TX-2 temperature sensor", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 7000, bands = BANDS, what = "outdoor thermometer", decode = ::tx2),
    dev(297, "ThermoPro TP211B thermometer", Mod.FSK_PCM, 105, 105, 1500, bands = BANDS, what = "probe thermometer", decode = ::tp211b),
    dev(256, "ThermoPro TP28b long-range meat thermometer", Mod.FSK_PCM, 105, 105, 5500, bands = BANDS,
        what = "smoker thermometer, two probes with alarms", decode = ::tp28b),
    dev(267, "ThermoPro TP828B meat thermometer, two probes with high and low targets", Mod.FSK_PCM, 102, 102, 1500, bands = BANDS, what = BBQ, decode = ::tp828b),
    dev(259, "ThermoPro TP829B meat thermometer, four probes", Mod.FSK_PCM, 102, 102, 1500, bands = BANDS, what = BBQ, decode = ::tp829b),
    dev(294, "ThermoPro TempSpike XR TP862b / TP863b dual-probe meat thermometer", Mod.FSK_PCM, 104, 104, 2000, bands = BANDS,
        what = "wireless meat probe with a booster", decode = ::tp86xb),
)
