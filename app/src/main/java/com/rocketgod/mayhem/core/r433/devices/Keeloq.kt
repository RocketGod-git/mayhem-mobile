package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Microchip KeeLoq hopping encoders: the chip inside most garage doors, gates and car alarms. A decode gives the
 * serial, the button, the battery flag and the repeat counter — never anything that would open the door: the
 * thirty-two bit hopping code is encrypted under a key that is not in the transmission, and is shown only so one
 * press can be told from a replay of it.
 *
 * Battery flag: the HCS200 sets it when the battery is LOW, the HCS361 when it is GOOD.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): hcs200.c, hcs361.c, hcs362.c, rainpoint_hcs012arf.c,
 * baldr_hcs528arf.c. Twin of web/src/dsp/r433/devices/keeloq.ts.
 */

private val BANDS = listOf(315_000_000L, 433_920_000L)

/** The button lines arrive as S3, S0, S1, S2; this puts them back. */
private fun buttonNumber(btn: Int) = (btn and 0x08) or ((btn and 0x01) shl 2) or (btn and 0x02) or ((btn and 0x04) shr 2)

/** Least-significant bit first on the air, so each byte is reversed before it means anything. */
private fun le32(b: UBytes, i: Int): Int = (reverse8(b[i + 3]) shl 24) or (reverse8(b[i + 2]) shl 16) or (reverse8(b[i + 1]) shl 8) or reverse8(b[i])

private fun serial28(b: UBytes): Int = (reverse8(b[7] and 0xf0) shl 24) or (reverse8(b[6]) shl 16) or (reverse8(b[5]) shl 8) or reverse8(b[4])

private fun allOnes(b: UBytes, from: Int, to: Int): Boolean { for (i in from..to) if (b[i] != 0xff) return false; return true }

/** The plain 66-bit frame, with no check of any kind: the preamble and the all-ones test are the only defence. */
private fun hcs200(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 12 || bits.bitsPerRow[1] != 66) return DECODE_ABORT_LENGTH
    val p = bits.bb[0]
    if (p[0] != 0xff || (p[1] and 0xf0) != 0xf0) return DECODE_ABORT_EARLY
    val b = bits.bb[1]
    if (allOnes(b, 1, 7)) return DECODE_FAIL_SANITY
    val btn = b[7] and 0x0f
    ctx.emit(data("model" to "Microchip-HCS200", "id" to hexUp(serial28(b), 7),
        "battery_ok" to if ((b[8] and 0x80) == 0x80) 0 else 1, "button" to buttonNumber(btn),
        "learn" to if (btn == 0x0f) 1 else 0, "repeat" to if ((b[8] and 0x40) == 0x40) 1 else 0,
        "encrypted" to hexUp(le32(b, 0), 8)))
    return 1
}

/** HCS361: a two-bit check over the first 65 bits; the check with the last bit inverted signals a low battery. */
private fun hcs361(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 2 || bits.bitsPerRow[1] != 67) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[0] == 6 && bits.bb[0][0] != 0xfc) return DECODE_FAIL_SANITY
    if (bits.bitsPerRow[0] == 7 && bits.bb[0][0] != 0xfe) return DECODE_FAIL_SANITY
    if (bits.bitsPerRow[0] == 12) {
        val pre = (bits.bb[0][0] shl 8) or bits.bb[0][1]
        if (pre != 0xaaa0 && pre != 0xfff0) return DECODE_FAIL_SANITY
    }
    val b = bits.bb[1]
    if (allOnes(b, 0, 7)) return DECODE_FAIL_SANITY
    var crc = 0; var crcBatLow = 0
    val actual = (b[8] shr 5) and 0x3
    for (i in 0 until 65) {
        val bit = b[i shr 3] shr (7 - (i % 8))
        val crcBit = ((crc shr 1) xor bit) and 0x1
        if (i == 64) {
            val low = ((crc shr 1) xor bit.inv()) and 0x1
            crcBatLow = low or (((low xor crc) shl 1) and 0x2)
        }
        crc = crcBit or (((crcBit xor crc) shl 1) and 0x2)
    }
    if (actual != crc && actual != crcBatLow) return DECODE_FAIL_MIC
    val serial = serial28(b)
    if (serial == 0) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Microchip-HCS361", "id" to hexUp(serial, 8), "battery_ok" to if ((b[8] and 0x80) == 0x80) 1 else 0,
        "button" to buttonNumber(b[7] and 0x0f), "encrypted" to hexUp(le32(b, 0), 8), "mic" to "CRC"))
    return 1
}

private fun hcs362Crc(b: UBytes): Int {
    var crc0 = 0; var crc1 = 0
    for (n in 0 until 65) {
        val dd = (b[n shr 3] shr (7 - (n % 8))) and 1
        val next1 = crc0 xor dd; val next0 = crc0 xor dd xor crc1
        crc0 = next0; crc1 = next1
    }
    return (crc1 shl 1) or crc0
}

/** HCS362: on-off keyed or Manchester; the registration's modulation says which, rather than guessing. */
private fun hcs362(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b: UBytes
    if (d.modulation == Mod.OOK_PCM) {
        val n0 = bits.bitsPerRow[0]
        if (n0 < 12 * 2 - 8 || n0 > 12 * 2 + 8) return DECODE_ABORT_LENGTH
        val p = bits.bb[0]
        if (p[0] != 0xaa || p[1] != 0xaa || p[2] != 0xaa) return DECODE_ABORT_EARLY
        val n1 = bits.bitsPerRow[1]
        if (n1 < 71 * 2 || n1 > 72 * 2 + 4) return DECODE_ABORT_LENGTH
        if ((bits.bb[1][0] and 0xc0) != 0x80) return DECODE_ABORT_EARLY
        val msg = BitBuffer()
        val len = bits.manchesterDecode(1, 2, msg, 72)
        if (len < 69 + 1) return DECODE_ABORT_LENGTH
        msg.invert()                                   // G. E. Thomas convention
        b = msg.bb[0]
    } else {
        if (bits.bitsPerRow[0] != 12 || bits.bitsPerRow[1] != 69) return DECODE_ABORT_LENGTH
        val p = bits.bb[0]
        if (p[0] != 0xff || (p[1] and 0xf0) != 0xf0) return DECODE_ABORT_EARLY
        b = bits.bb[1]
    }
    if (allOnes(b, 1, 7)) return DECODE_FAIL_SANITY
    val actual = ((b[8] shr 6) and 1) or (((b[8] shr 5) and 1) shl 1)
    if (actual != hcs362Crc(b)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Microchip-HCS362", "id" to hexUp(serial28(b), 7), "battery_ok" to if ((b[8] and 0x80) == 0x80) 0 else 1,
        "button" to buttonNumber(b[7] and 0x0f), "repeat" to (((b[8] shr 4) and 1) or (((b[8] shr 3) and 1) shl 1)),
        "encrypted" to hexUp(le32(b, 0), 8), "mic" to "CRC"))
    return 1
}

/** RainPoint HCS012ARF: Manchester, inverted, every byte reflected; the 0xa5 header confirms all three. */
private fun rainpoint(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 163)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 163) return DECODE_ABORT_LENGTH
    val msg = BitBuffer()
    bits.manchesterDecode(row, 0, msg, 10 * 2 * 8)
    msg.invert()
    val b = msg.bb[0]
    reflectBytes(b, 10)
    if (b[0] != 0xa5) return DECODE_ABORT_EARLY
    if ((addBytes(b, 8, 1) and 0xff) != b[9]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "RainPoint-HCS012ARF",
        "id" to ((b[4].toLong() shl 24) or (b[3].toLong() shl 16) or (b[2].toLong() shl 8) or b[1].toLong()),
        "flags1" to hexOf(b[5] shr 2, 2), "flags2" to hexOf(b[6], 2),
        "battery_ok" to if (((b[5] and 0x02) shr 1) != 0) 0 else 1,
        "rain_mm" to jsRound(((b[8] shl 8) or b[7]) * 0.1 * 10) / 10, "mic" to "CHECKSUM"))
    return 1
}

/** Baldr HCS528ARF pool thermometer: same board, reporting in Fahrenheit. */
private fun baldr(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 179)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 179) return DECODE_ABORT_LENGTH
    val msg = BitBuffer()
    bits.manchesterDecode(row, 0, msg, 11 * 2 * 8)
    msg.invert()
    val b = msg.bb[0]
    reflectBytes(b, 11)
    if (b[0] != 0xa5) return DECODE_ABORT_EARLY
    if ((addBytes(b, 9, 1) and 0xff) != b[10]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Baldr-HCS528ARF", "id" to hexOf((b[4] shl 24) or (b[3] shl 16) or (b[2] shl 8) or b[1], 8),
        "battery_ok" to if (((b[5] and 0x02) shr 1) != 0) 0 else 1,
        "temperature_F" to jsRound((((b[8] and 0x0f) shl 8) or b[7]) * 0.1 * 10) / 10, "mic" to "CHECKSUM"))
    return 1
}

private const val REMOTE = "garage, gate and alarm remote"

internal val KEELOQ: List<RDevice> = listOf(
    dev(131, "Microchip HCS200/HCS300 KeeLoq remote", Mod.OOK_PWM, 370, 772, 9000, gapLimit = 1500, tolerance = 152, bands = BANDS, what = REMOTE, decode = ::hcs200),
    dev(218, "Microchip HCS200/HCS300 KeeLoq remote, frequency shifted", Mod.FSK_PWM, 370, 772, 9000, gapLimit = 1500, tolerance = 152, bands = BANDS, what = REMOTE, decode = ::hcs200),
    dev(306, "Microchip HCS361 KeeLoq remote (sync, 833 bit/s)", Mod.OOK_PWM, 400, 800, 7200, gapLimit = 1200, tolerance = 140, syncWidth = 4000, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(307, "Microchip HCS361 KeeLoq remote (sync, 1667 bit/s)", Mod.OOK_PWM, 200, 400, 13600, gapLimit = 600, tolerance = 70, syncWidth = 2000, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(308, "Microchip HCS361 KeeLoq remote (no sync, 833 bit/s)", Mod.OOK_PWM, 200, 400, 6800, gapLimit = 1200, tolerance = 140, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(309, "Microchip HCS361 KeeLoq remote (no sync, 1667 bit/s)", Mod.OOK_PWM, 100, 200, 6600, gapLimit = 600, tolerance = 70, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(310, "Microchip HCS361 KeeLoq remote (PIWM, 2500 bit/s)", Mod.OOK_PIWM_DC, 400, 800, 45600, gapLimit = 4000, tolerance = 140, syncWidth = 4000, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(311, "Microchip HCS361 KeeLoq remote (PIWM, 5000 bit/s)", Mod.OOK_PIWM_DC, 200, 400, 45200, gapLimit = 2000, tolerance = 70, syncWidth = 2000, bands = BANDS, what = REMOTE, decode = ::hcs361),
    dev(329, "Microchip HCS362 KeeLoq remote, pulse width", Mod.OOK_PWM, 200, 400, 900, gapLimit = 550, tolerance = 50, bands = BANDS, what = REMOTE, decode = ::hcs362),
    dev(330, "Microchip HCS362 KeeLoq remote, Manchester", Mod.OOK_PCM, 214, 214, 900, gapLimit = 600, tolerance = 50, bands = BANDS, what = REMOTE, decode = ::hcs362),
    dev(276, "RainPoint HCS012ARF rain gauge", Mod.OOK_PCM, 320, 320, 1000, gapLimit = 700, bands = BANDS, what = "tipping-bucket rain gauge", decode = ::rainpoint),
    dev(360, "Baldr HCS528ARF pool thermometer", Mod.OOK_PCM, 320, 320, 1000, gapLimit = 700, bands = BANDS, what = "floating pool thermometer", decode = ::baldr),
)
