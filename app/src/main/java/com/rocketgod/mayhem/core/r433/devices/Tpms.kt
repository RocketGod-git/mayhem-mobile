package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Tire pressure monitors: four in every car sold in the US since 2007, each waking every minute or so with its
 * pressure, temperature and a serial number that never changes. Nearly all FSK, an alternating preamble, then
 * Manchester bytes ending in a checksum, so the work is per-maker field layout. US cars mostly on 315 MHz,
 * European ones on 433.92.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): tpms_toyota.c, tpms_ford.c, tpms_citroen.c, tpms_renault.c,
 * tpms_abarth124.c. Twin of web/src/dsp/r433/devices/tpms.ts.
 */

private val PRE_AA_A9 = UBytes.of(0xaa, 0xa9)
private val PRE_AA_AA_A9 = UBytes.of(0xaa, 0xaa, 0xa9)
private val PRE_A9_E0 = UBytes.of(0xa9, 0xe0)
private val B315_433 = listOf(315_000_000L, 433_920_000L)
private val B433 = listOf(433_920_000L)

private fun id32(b: UBytes, a: Int) = hexOf((b[a] shl 24) or (b[a + 1] shl 16) or (b[a + 2] shl 8) or b[a + 3], 8)

/** Toyota and the Pacific Industrial sensors: differential Manchester, pressure sent twice (once inverted). */
private fun toyota(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0; var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, PRE_A9_E0, 12)
        if (bitpos + 156 > bits.bitsPerRow[0]) break
        val start = bitpos + 11
        val packet = BitBuffer()
        val end = bits.differentialManchesterDecode(0, start, packet, 80)
        if (end - start >= 144) {
            val b = packet.bb[0]
            if (crc8(b, 8, 0x07, 0x80) == b[8]) {
                val p1 = ((b[4] and 0x7f) shl 1) or (b[5] shr 7); val p2 = b[7] xor 0xff
                if (p1 == p2) {
                    ctx.emit(data("model" to "Toyota", "type" to "TPMS", "id" to id32(b, 0),
                        "status" to ((b[4] and 0x80) or (b[6] and 0x7f)),
                        "pressure_PSI" to jsRound((p1 * 0.25 - 7) * 100) / 100,
                        "temperature_C" to ((((b[5] and 0x7f) shl 1) or (b[6] shr 7)) - 40), "mic" to "CRC"))
                    events++
                }
            }
        }
        bitpos += 2
    }
    return events
}

/** Ford / Continental: byte-sum check; the temperature byte means something else when its top bit is set. */
private fun ford(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var events = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, PRE_AA_A9, 16)
            if (bitpos + 144 > bits.bitsPerRow[row]) break
            val packet = BitBuffer()
            bits.manchesterDecode(row, bitpos + 16, packet, 160)
            if (packet.bitsPerRow[0] >= 64) {
                val b = packet.bb[0]
                if (((b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6]) and 0xff) == b[7]) {
                    var unknown = 0; var learn = 0; var moving = 0
                    when (b[6] and 0x4c) { 0x08 -> learn = 1; 0x04 -> {}; 0x44 -> moving = 1; else -> unknown = b[6] and 0x4c }
                    unknown = unknown or (b[6] and 0x90)
                    if (unknown == 0) {
                        val out = data("model" to "Ford", "type" to "TPMS", "id" to id32(b, 0),
                            "pressure_PSI" to jsRound((((b[6] and 0x20) shl 3) or b[4]) * 0.25 * 100) / 100,
                            "moving" to moving, "learn" to learn,
                            "code" to hexOf((b[4] shl 16) or (b[5] shl 8) or b[6], 6), "mic" to "CHECKSUM")
                        if ((b[5] and 0x80) == 0) out["temperature_C"] = (b[5] and 0x7f) - 56
                        ctx.emit(out)
                        events++
                    }
                }
            }
            bitpos += 15
        }
    }
    return events
}

/** Citroen / Peugeot / VDO: exclusive-or check; byte zero carries state left out of the check. */
private fun citroen(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var events = 0; var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, PRE_AA_A9, 16)
        if (bitpos + 178 > bits.bitsPerRow[0]) break
        val packet = BitBuffer()
        bits.manchesterDecode(0, bitpos + 16, packet, 88)
        if (packet.bitsPerRow[0] >= 80) {
            val b = packet.bb[0]
            if (b[6] != 0 && b[7] != 0) {
                val crc = b[1] xor b[2] xor b[3] xor b[4] xor b[5] xor b[6] xor b[7] xor b[8] xor b[9]
                if (crc == 0) {
                    ctx.emit(data("model" to "Citroen", "type" to "TPMS", "id" to id32(b, 1), "state" to hexOf(b[0], 2),
                        "flags" to (b[5] shr 4), "repeat" to (b[5] and 0x0f), "pressure_kPa" to jsRound(b[6] * 1.364),
                        "temperature_C" to b[7] - 50, "maybe_battery" to b[8], "mic" to "CHECKSUM"))
                    events++
                }
            }
        }
        bitpos += 2
    }
    return events
}

/** Renault / Dacia: CRC, and the serial stored least significant byte first. */
private fun renault(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var events = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, PRE_AA_A9, 16)
            if (bitpos + 160 > bits.bitsPerRow[row]) break
            val packet = BitBuffer()
            bits.manchesterDecode(row, bitpos + 16, packet, 160)
            if (packet.bitsPerRow[0] >= 72) {
                val b = packet.bb[0]
                if (crc8(b, 8, 0x07, 0x00) == b[8]) {
                    ctx.emit(data("model" to "Renault", "type" to "TPMS", "id" to hexOf((b[5] shl 16) or (b[4] shl 8) or b[3], 6),
                        "flags" to hexOf(b[0] shr 2, 2), "pressure_kPa" to jsRound((((b[0] and 0x03) shl 8) or b[1]) * 0.75 * 10) / 10,
                        "temperature_C" to b[2] - 30, "mic" to "CRC"))
                    events++
                }
            }
            bitpos += 15
        }
    }
    return events
}

/** VDO TG1C (Abarth / Fiat 124, several Mazdas) and the Shenzhen Q85, told apart by burst length. */
private fun abarth124(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val n = bits.bitsPerRow[0]
    val q85 = n in 211..399
    if (!q85 && !(n > 150 && n < 210)) return DECODE_ABORT_LENGTH
    val dataLen = if (q85) 96 else 72
    var events = 0; var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, PRE_AA_AA_A9, 24)
        if (bitpos + 80 > bits.bitsPerRow[0]) break
        val packet = BitBuffer()
        bits.manchesterDecode(0, bitpos + 24, packet, dataLen)
        if (packet.bitsPerRow[0] >= dataLen) {
            val b = packet.bb[0]
            if (xorBytes(b, 9) == 0) {
                val tempC = if (q85) b[6] - 55 else b[6] - 50
                val tMin = if (q85) -20 else -50; val tMax = if (q85) 80 else 125
                if (tempC in tMin..tMax) {
                    val crcOk = !q85 || crc16(b, 10, 0x1021, 0xffff) == ((b[11] shl 8) or b[10])
                    if (crcOk) {
                        ctx.emit(data("model" to if (q85) "Shenzhen-EGQQ85" else "Abarth-124Spider", "type" to "TPMS", "id" to id32(b, 0),
                            "flags" to hexOf(b[4], 2), "pressure_kPa" to jsRound(if (q85) b[5] * 3.0 else b[5] * 1.38),
                            "temperature_C" to tempC, "status" to b[7], "mic" to if (q85) "CRC" else "CHECKSUM"))
                        events++
                    }
                }
            }
        }
        bitpos += 2
    }
    return events
}

internal val TPMS: List<RDevice> = listOf(
    dev(88, "Toyota TPMS", Mod.FSK_PCM, 52, 52, 150, bands = B315_433, what = "tire pressure sensor, also fitted to some Lexus, Subaru and Mazda", decode = ::toyota),
    dev(89, "Ford TPMS", Mod.FSK_PCM, 52, 52, 150, bands = B315_433, what = "tire pressure sensor: Fiesta, Focus, Kuga, Escape, Transit", decode = ::ford),
    dev(82, "Citroen TPMS", Mod.FSK_PCM, 52, 52, 150, bands = B433, what = "tire pressure sensor: Citroen, Peugeot, some Fiat and Mitsubishi", decode = ::citroen),
    dev(90, "Renault TPMS", Mod.FSK_PCM, 52, 52, 150, bands = B433, what = "tire pressure sensor: Clio, Captur, Zoe, Dacia Sandero", decode = ::renault),
    dev(156, "Abarth 124 Spider and Shenzhen EGQ Q85 TPMS", Mod.FSK_PCM, 52, 52, 150, bands = B433,
        what = "tire pressure sensor: VDO TG1C, and a common aftermarket sensor", decode = ::abarth124),
)
