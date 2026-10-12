package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Schrader's car sensors: the plain one, EG53MA4, SMD3MA4 / NIS315G3 and the BMW MRXBC5A4.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): schrader.c, schrader_mrxbc5a4.c. Twin of
 * web/src/dsp/r433/devices/tpms3.ts.
 */

/** American cars transmit at 315 MHz, European ones at 433.92. */
private val BANDS = listOf(315_000_000L, 433_920_000L)
private const val WHAT = "tire pressure sensor"

/** 1 fixed bit, 3 flags, 24 of identity, 8 of pressure, 2 of checksum. */
private const val SMD3MA4_DATA_BITS = 38
private const val SMD3MA4_MIN = 36 / 2 + 2 * SMD3MA4_DATA_BITS
private const val SMD3MA4_MAX = 36 + 2 * SMD3MA4_DATA_BITS + 8

private fun schrader(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 68) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 4, 64)
    if (b[7] != crc8(b, 7, 0x07, 0xf0)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Schrader", "type" to "TPMS",
        "id" to hexUp(((b[1] and 0x0f) shl 24) or (b[2] shl 16) or (b[3] shl 8) or b[4], 7),
        "flags" to hexOf(((b[0] and 0x0f) shl 4) or (b[1] shr 4), 2),
        // Sent in millibar, a step of 25 each.
        "pressure_kPa" to round1(b[5] * 25 * 0.1), "temperature_C" to b[6] - 50, "mic" to "CRC"))
    return 1
}

private fun eg53ma4(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 120) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 40, 80)
    if (b[1] == 0 && b[2] == 0 && b[4] == 0 && b[5] == 0 && b[7] == 0 && b[8] == 0) return DECODE_FAIL_SANITY
    if ((addBytes(b, 9) and 0xff) != b[9]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Schrader-EG53MA4", "type" to "TPMS", "id" to hexUp((b[4] shl 16) or (b[5] shl 8) or b[6], 6),
        "flags" to hexOf(u32be(b, 0), 8), "pressure_kPa" to round1(b[7] * 25 * 0.1),
        "temperature_F" to b[8], "mic" to "CHECKSUM"))
    return 1
}

/** Two bits of a running sum over every bit pair must come to one; weak, so the all-zero test does real work. */
private fun smd3ma4(bits: BitBuffer, ctx: DecodeCtx, scale: Double, model: String): Int {
    val n = bits.bitsPerRow[0]
    if (n < SMD3MA4_MIN || n >= SMD3MA4_MAX) return DECODE_ABORT_LENGTH
    // The run-in ends mid-byte, so the search lands two bits before the payload proper.
    val at = bits.search(0, 0, UBytes.of(0x55, 0x5e), 16) + 14
    if (at + SMD3MA4_DATA_BITS * 2 > n) return DECODE_ABORT_EARLY
    val decoded = BitBuffer()
    // A Manchester decode that stops early has hit a coding violation, which is this frame's real check.
    if (bits.manchesterDecode(0, at, decoded, SMD3MA4_DATA_BITS) != at + SMD3MA4_DATA_BITS * 2) return DECODE_FAIL_MIC
    decoded.invert()
    val b = decoded.bb[0]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    var sum = 0
    for (i in 0 until 5) sum += (b[i] and 0x3) + ((b[i] shr 2) and 0x3) + ((b[i] shr 4) and 0x3) + ((b[i] shr 6) and 0x3)
    if ((sum and 0x3) != 1) return DECODE_FAIL_MIC
    val flags = (b[0] and 0x70) shr 4
    val out = data("model" to model, "type" to "TPMS",
        "id" to hexUp(((b[0] and 0x0f) shl 20) or (b[1] shl 12) or (b[2] shl 4) or (b[3] shr 4), 6), "flags" to flags,
        "pressure_PSI" to round1((((b[3] and 0x0f) shl 4) or (b[4] shr 4)) * scale), "mic" to "PARITY")
    when (flags) { 0x0 -> out["learn"] = 1; 0x3 -> out["alarm"] = 1; 0x5 -> out["wakeup"] = 1 }
    ctx.emit(out)
    return 1
}

/** The check rejects only three random frames in four, so physical bounds act as a second, independent filter. */
private fun mrxbc5a4(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 61) return DECODE_ABORT_LENGTH
    if (bits.search(0, 0, UBytes.of(0x7f, 0xff), 16) != 0) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, 16, 46)
    val id = ((b[0] and 0x1f) shl 19) or (b[1] shl 11) or (b[2] shl 3) or (b[3] shr 5)
    if (id == 0 || id == 0xffffff) return DECODE_FAIL_SANITY
    var evenOnes = 0; var ones = 0
    for (i in 3 until 38) {
        if (((b[i shr 3] shr (7 - (i % 8))) and 1) != 0) { ones++; if ((i - 3) % 2 == 0) evenOnes++ }
    }
    val want = (evenOnes + 2 * ones - 1) and 0x3
    if (want != ((((b[4] shr 3) and 1) shl 1) or ((b[4] shr 2) and 1))) return DECODE_FAIL_MIC
    val pressure = ((b[3] and 0x1f) shl 4) or (b[4] shr 4)
    val tempC = (((b[4] and 0x03) shl 5) or (b[5] shr 3)) - 50
    if (pressure > 450 || tempC < -40 || tempC > 85) return DECODE_FAIL_SANITY
    val flags = (b[0] shr 5) and 0x7
    ctx.emit(data("model" to "Schrader-MRXBC5A4", "type" to "TPMS", "id" to hexUp(id, 6), "flags" to Integer.toHexString(flags),
        "pressure_kPa" to pressure, "temperature_C" to tempC, "sleep" to if (flags == 2) "True" else "False", "mic" to "PARITY"))
    return 1
}

internal val TPMS3: List<RDevice> = listOf(
    dev(60, "Schrader TPMS", Mod.OOK_MANCHESTER_ZEROBIT, 120, 0, 480, bands = BANDS, what = WHAT, decode = ::schrader),
    dev(95, "Schrader TPMS EG53MA4 (Saab, Opel, Vauxhall, Chevrolet)", Mod.OOK_MANCHESTER_ZEROBIT, 123, 0, 300, bands = BANDS, what = WHAT, decode = ::eg53ma4),
    dev(168, "Schrader TPMS SMD3MA4 (Subaru)", Mod.OOK_PCM, 120, 120, 480, bands = BANDS, what = WHAT) { _, bits, ctx ->
        smd3ma4(bits, ctx, 0.2, "Schrader-SMD3MA4") },
    // The same frame as the Subaru board, a quarter of a pound per step instead of a fifth.
    dev(352, "Schrader TPMS MRXNIS315G3 / 3039 (Infiniti, Nissan, Renault), Redi-Sensor SE10001HP", Mod.OOK_PCM, 120, 120, 480,
        bands = BANDS, what = WHAT) { _, bits, ctx -> smd3ma4(bits, ctx, 0.25, "Schrader-NIS315G3") },
    dev(328, "Schrader TPMS MRXBC5A4 (BMW)", Mod.OOK_MANCHESTER_ZEROBIT, 123, 0, 800, bands = BANDS, what = WHAT, decode = ::mrxbc5a4),
)
