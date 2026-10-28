package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.max

/*
 * Aftermarket tire pressure sensors: Jansite Solar, TY-468, TY588, iMars T240, EezTire, Airpuxem, Sefis M3.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): tpms_jansite_solar.c, tpms_sp372.c, tpms_jansite_ty588.c, tpms_eezrv.c,
 * tpms_airpuxem.c, tpms_sefis.c. Twin of web/src/dsp/r433/devices/tpms6.ts.
 */

private val BANDS = listOf(433_920_000L)
private const val WHAT = "tire pressure sensor"

/** The run-in `a6 a6 5a` is the sync word `dd33` once Manchester coded, so decoding starts at the run-in. */
private fun jansiteSolarDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos, packet, 88)
    packet.invert()
    if (packet.bitsPerRow[0] < 88) return DECODE_FAIL_SANITY
    val b = packet.bb[0]
    if (((b[0] shl 8) or b[1]) != 0xdd33) return DECODE_FAIL_SANITY
    if ((((b[9] shl 8) or b[10]) and 0xffff) != crc16(b, 7, 0x8005, 0x0000, 2)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Jansite-Solar", "type" to "TPMS", "id" to hexBytes(b, 3, 2), "flags" to b[5],
        "pressure_kPa" to jsRound(b[7] * 1.6), "temperature_C" to b[6] - 55, "code" to hexBytes(b, 9, 2), "mic" to "CRC"))
    return 1
}

private fun jansiteSolar(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xa6, 0xa6, 0x5a)
    var bitpos = 0; var events = 0; var ret = 0
    while (true) {
        bitpos = bits.search(0, bitpos, pre, 24)
        if (bitpos + 80 > bits.bitsPerRow[0]) break
        ret = jansiteSolarDecode(bits, ctx, 0, bitpos)
        if (ret > 0) events += ret
        bitpos += 2
    }
    return if (events > 0) events else ret
}

/**
 * No CRC: the tail repeats the head, the low nibbles of the first two bytes agree, and two bytes are affine in
 * the first so their sum is a per-unit constant. That constant is what keys the calibration tables.
 */
private fun sp372Frame(bits: BitBuffer): UBytes? {
    if (bits.numRows != 1) return null
    val len = bits.bitsPerRow[0]
    val pos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xaa), 24)
    if (pos >= len) return null
    if (len - pos < 160) return null
    val packet = BitBuffer()
    bits.manchesterDecode(0, pos + 32, packet, 64)
    packet.invert()
    if (packet.bitsPerRow[0] < 64) return null
    val b = packet.bb[0]
    if (b[7] != b[0]) return null
    if ((b[0] and 0x0f) != (b[1] and 0x0f)) return null
    return b
}

/** The two TY-468 units anyone has measured against a real gauge: temperature and pressure offsets. */
private val TY468_UNITS = mapOf(0xfb to intArrayOf(224, 273), 0x64 to intArrayOf(153, 201))

private fun ty468(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = sp372Frame(bits) ?: return DECODE_ABORT_EARLY
    val unit = TY468_UNITS[(b[3] + b[4]) and 0xff] ?: return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Jansite-TY468", "type" to "TPMS", "temperature_C" to unit[0] - ((b[2] + b[5]) and 0xff),
        "pressure_kPa" to round1((unit[1] - ((b[5] + b[6]) and 0xff)) * 2.5), "code" to hexBytes(b, 7), "mic" to "CHECKSUM"))
    return 1
}

/** The same frame, but nobody recorded what this one's display showed, so the readings are not interpreted. */
private fun imarsT240(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = sp372Frame(bits) ?: return DECODE_ABORT_EARLY
    val checksum = (b[3] + b[4]) and 0xff
    if (checksum != 0x41 && checksum != 0x3c) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "iMars-T240", "type" to "TPMS", "code" to hexBytes(b, 7), "mic" to "CHECKSUM"))
    return 1
}

/** No identity at all: what looks like an id varies between transmissions, so the raw frame is reported. */
private fun ty588Decode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val packet = BitBuffer()
    bits.manchesterDecode(row, bitpos + 44, packet, 64)
    if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_LENGTH
    val b = packet.bb[0]
    if (b[7] != b[0]) return DECODE_FAIL_MIC
    if (((b[3] + b[4]) and 0xff) != 0x30 || (b[0] and 0x0f) != (b[1] and 0x0f)) return DECODE_FAIL_SANITY
    val temperature = ((b[2] + b[5]) and 0xff) - 139
    val pressureRaw = ((b[5] + b[6]) and 0xff) - 90
    if (pressureRaw < 0 || temperature < -40 || temperature > 120) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Jansite-TY588", "type" to "TPMS", "pressure_kPa" to round1(pressureRaw * 2.5),
        "temperature_C" to temperature, "code" to hexBytes(b, 7), "mic" to "CHECKSUM"))
    return 1
}

private fun ty588(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0x99, 0xaa, 0x5a)
    var bitpos = 0; var events = 0; var ret = 0
    while (true) {
        bitpos = bits.search(0, bitpos, pre, 24)
        if (bitpos + 172 > bits.bitsPerRow[0]) break
        ret = ty588Decode(bits, ctx, 0, bitpos)
        if (ret > 0) events += ret
        bitpos += 2
    }
    return if (events > 0) events else ret
}

/** When the byte sum overflows, the sensor sets the top bit of the result: the overflow is folded in, not dropped. */
private fun eezrv(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    bits.invert()
    val pos = bits.search(0, 0, UBytes.of(0xff, 0xff), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (pos > 0) return DECODE_ABORT_EARLY
    if (pos + 10 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val cc = bits.bytes(0, pos + 16, 8)
    val b = bits.bytes(0, pos + 24, 56)
    var computed = 0
    for (i in 0 until 7) computed += b[i]
    if (computed > 0xff) computed = computed or 0x80
    if ((computed and 0xff) != cc[0]) return DECODE_FAIL_MIC
    val flags1 = b[5]; val flags2 = b[6]
    val inflating = (flags1 and 0x20) shr 5
    ctx.emit(data("model" to "EezTire-E618", "type" to "TPMS", "id" to hexBytes(b, 3),
        "battery_ok" to if ((flags1 shr 7) != 0) 0 else 1,   // set below about 3.15 volts; it dies at 3.10
        "pressure_kPa" to jsRound((((flags2 and 0x01) shl 8) + b[3]) * 2.5), "temperature_C" to b[4] - 50,
        "flags" to hexOf(flags1) + hexOf(flags2), "fast_leak" to if ((flags1 and 0x10) != 0 && inflating == 0) 1 else 0,
        "inflate" to inflating, "mic" to "CHECKSUM"))
    return 1
}

/** The checksum is sent twice; the pressure's two high bits hide in the flags byte, one in each nibble. */
private fun airpuxemDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val dec = BitBuffer()
    bits.manchesterDecode(row, bitpos, dec, 354)
    if (dec.bitsPerRow[0] < 84) return DECODE_FAIL_SANITY
    val b = dec.bb[0]
    if ((b[0] shr 4) != 0x5) return DECODE_FAIL_SANITY
    val payload = dec.bytes(0, 4, 64)
    val crcs = dec.bytes(0, 4 + 64, 16)
    if (crcs[0] != crc8(payload, 8, 0x2f, 0xaa)) return DECODE_FAIL_MIC
    val f = dec.bytes(0, 4, 80)
    val pressure = (f[5] or (((f[4] shr 7) and 1) shl 8) or (((f[4] shr 3) and 1) shl 9)) - 100
    ctx.emit(data("model" to "Airpuxem-TYH11EU6ZQ", "type" to "TPMS", "id" to hexOf(u32be(f, 0), 8),
        "position" to (f[4] and 0x07),                   // which wheel the sensor believes it is on
        "flags" to ((f[4] shr 4) and 0x07), "pressure_kPa" to pressure, "temperature_C" to signed(f[6], 8),
        "battery_V" to round1(f[7] * 0.02), "code" to hexBytes(b, 11), "mic" to "CRC"))
    return 1
}

private fun airpuxem(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xaa, 0xaa, 0xa9)
    bits.invert()
    var events = 0; var ret = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, pre, 24)
            if (bitpos + 80 > bits.bitsPerRow[row]) break
            ret = airpuxemDecode(bits, ctx, row, bitpos + 24)
            if (ret > 0) events += ret
            bitpos += 2
        }
    }
    return if (events > 0) events else ret
}

/** The pressure's page bits are scrambled: codes 7, 4, 5, 2 mean pages nought to three, learned from a deflating tire. */
private val SEFIS_PAGE = mapOf(7 to 0, 4 to 1, 5 to 2, 2 to 3)

private fun sefisM3(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    // The sync word as it arrives, before the Manchester decode inverts it into 0x5a9d.
    var pos = bits.search(0, 0, UBytes.of(0x66, 0x99, 0x96, 0xa6), 32)
    if (pos == bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (pos + 32 + 72 * 2 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    pos += 32
    val packet = BitBuffer()
    bits.manchesterDecode(0, pos, packet, 72)
    if (packet.bitsPerRow[0] < 72) return DECODE_ABORT_LENGTH
    val b = UBytes(9)
    for (i in 0 until 9) b[i] = packet.bb[0][i] xor 0xff
    if (crc16(b, 7, 0x1021, 0x0000) != (((b[7] shl 8) or b[8]) and 0xffff)) return DECODE_FAIL_MIC
    val out = data("model" to "Sefis-M3", "type" to "TPMS", "temperature_C" to 14 + (((b[2] + b[5]) and 0xff) and 0x0f),
        "code" to hexBytes(b, 7), "mic" to "CRC")
    val page = SEFIS_PAGE[b[4] shr 5]
    if (page != null) {
        val code = (page shl 13) or ((b[4] and 0x1f) shl 8) or b[5]
        out["pressure_kPa"] = max(0.0, jsRound((code - 0x0e00) / 102.4))
    }
    ctx.emit(out)
    return 1
}

internal val TPMS6: List<RDevice> = listOf(
    // A long reset limit, so the three repeats merge into one row.
    dev(180, "Jansite TPMS Model Solar", Mod.FSK_PCM, 51, 51, 5000, bands = BANDS, what = WHAT, decode = ::jansiteSolar),
    dev(355, "Jansite TPMS TY-468-eu2 / KKMOON TPMS", Mod.OOK_PCM, 50, 50, 200, bands = BANDS, what = WHAT, decode = ::ty468),
    dev(354, "iMars T240 TPMS", Mod.OOK_PCM, 50, 50, 200, bands = BANDS, what = WHAT, decode = ::imarsT240),
    dev(362, "Jansite TPMS TY588-EU2", Mod.FSK_PCM, 51, 51, 5000, bands = BANDS, what = WHAT, decode = ::ty588),
    dev(241, "EezTire E618, Carchet TPMS, TST-507 TPMS", Mod.OOK_MANCHESTER_ZEROBIT, 50, 50, 120, bands = BANDS,
        what = "tire pressure sensor: caravan and trailer monitor", decode = ::eezrv),
    dev(295, "Airpuxem TPMS TYH11_EU6_ZQ", Mod.FSK_PCM, 52, 52, 150, bands = BANDS, what = WHAT, decode = ::airpuxem),
    dev(378, "Sefis M3 / Careud / Sykik SRTP300 TPMS", Mod.FSK_PCM, 52, 52, 5000, bands = BANDS, what = WHAT, decode = ::sefisM3),
)
