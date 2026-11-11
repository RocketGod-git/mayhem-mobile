// Port of ProtoPirate protocols/kia_v5.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V5: FM, Manchester at 400 / 800 µs (events mapped the other way round from pp_manchester_event) after a
 * short-pair preamble. 64 key bits plus a 3-bit CRC; the bit-reversed key ("Yek") holds the button, a 28-bit serial
 * and a counter scrambled by a keyed mixer.
 */
class PPKiaV5 : PPDecoder("Kia V5", PPModulation.FM, PPConst(400, 800, 150, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_DATA = 2

        /** mixer_decode, with the keystore built from the V5 manufacturer key (0 when absent). */
        fun mixerDecode(encrypted: Long): Int {
            var s0 = (encrypted and 0xFF).toInt(); var s1 = ((encrypted ushr 8) and 0xFF).toInt()
            var s2 = ((encrypted ushr 16) and 0xFF).toInt(); var s3 = ((encrypted ushr 24) and 0xFF).toInt()
            val mf = PPKeys.kiaV5 ?: 0L
            val ks = IntArray(8) { ((mf ushr ((7 - it) * 8)) and 0xFF).toInt() }
            var roundIndex = 1
            repeat(18) {
                var r = ks[roundIndex]
                repeat(8) {
                    var base: Int = if (s3 and 0x40 == 0) (if (s3 and 0x02 == 0) 0x74 else 0x2E) else (if (s3 and 0x02 == 0) 0x3A else 0x5C)
                    if (s2 and 0x08 != 0) base = ((base ushr 4) and 0x0F) or ((base and 0x0F) shl 4)
                    if (s1 and 0x01 != 0) base = ((base and 0x3F) shl 2) and 0xFF
                    if (s0 and 0x01 != 0) base = (base shl 1) and 0xFF
                    val temp = s3 xor s1
                    s3 = ((s3 and 0x7F) shl 1); if (s2 and 0x80 != 0) s3 = s3 or 0x01
                    s2 = ((s2 and 0x7F) shl 1); if (s1 and 0x80 != 0) s2 = s2 or 0x01
                    s1 = ((s1 and 0x7F) shl 1); if (s0 and 0x80 != 0) s1 = s1 or 0x01
                    s0 = ((s0 and 0x7F) shl 1)
                    val chk = base xor (r xor temp)
                    if (chk and 0x80 != 0) s0 = s0 or 0x01
                    r = (r and 0x7F) shl 1
                }
                roundIndex = (roundIndex - 1) and 0x7
            }
            return s0 or (s1 shl 8)
        }
    }

    private var decodedData = 0L
    private var savedKey = 0L
    private var bitCount = 0
    private var yek = 0L
    private var crc = 0

    override fun reset() {
        parserStep = STEP_RESET; headerCount = 0; bitCount = 0; decodedData = 0; savedKey = 0; yek = 0; crc = 0
        manchester = PPManchester.MID1
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teShort) < c.teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 1; bitCount = 0; decodedData = 0
                manchesterAdvance(PPManchester.RESET)
            }
            STEP_CHECK_PREAMBLE -> if (level) {
                if (dd(duration, c.teLong) < c.teDelta) {
                    if (headerCount > 40) {
                        parserStep = STEP_DATA; bitCount = 0; decodedData = 0; savedKey = 0; headerCount = 0
                    } else teLast = duration
                } else if (dd(duration, c.teShort) < c.teDelta) teLast = duration
                else parserStep = STEP_RESET
            } else {
                if (dd(duration, c.teShort) < c.teDelta && dd(teLast, c.teShort) < c.teDelta) headerCount = (headerCount + 1) and 0xFFFF
                else if (dd(duration, c.teLong) < c.teDelta && dd(teLast, c.teShort) < c.teDelta) headerCount = (headerCount + 1) and 0xFFFF
                else if (dd(teLast, c.teLong) < c.teDelta) headerCount = (headerCount + 1) and 0xFFFF
                else parserStep = STEP_RESET
                teLast = duration
            }
            STEP_DATA -> {
                val ev: Int
                if (dd(duration, c.teShort) < c.teDelta) ev = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
                else if (dd(duration, c.teLong) < c.teDelta) ev = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
                else {
                    if (bitCount >= c.minBits) {
                        data = savedKey
                        dataCountBit = if (bitCount > 67) 67 else bitCount
                        crc = (decodedData and 0x07).toInt()
                        yek = 0
                        for (i in 0 until 8) {
                            val byte = ((data ushr (i * 8)) and 0xFF).toInt()
                            yek = yek or (PPMath.reverseBits8(byte).toLong() shl ((7 - i) * 8))
                        }
                        serial = (yek ushr 32) and 0x0FFFFFFF
                        btn = ((yek ushr 60) and 0x0F).toInt()
                        cnt = mixerDecode(yek and M32).toLong()
                        emit()
                    }
                    parserStep = STEP_RESET
                    return
                }
                if (bitCount <= 66) {
                    val bit = manchesterAdvance(ev)
                    if (bit >= 0) {
                        decodedData = (decodedData shl 1) or bit.toLong()
                        bitCount++
                        if (bitCount == 64) { savedKey = decodedData; decodedData = 0 }
                    }
                }
                teLast = duration
            }
        }
    }

    override fun describe(): PPHit =
        PPHit(name, dataCountBit, hx("%016X", data), serial, hx("%X", btn.toLong()), cnt,
            listOf(MeshField("Yek", hx("%016X", yek)), MeshField("CRC", hx("%X", crc.toLong()))))

    /** kia_v5.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nYek:%08lX%08lX\r\nSn:%07lX Btn:%X Cnt:%04lX\r\nCRC:%X\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Yek:${h.fields[0].value} | " + hx("Sn:%07X", h.serial ?: 0) +
            " Btn:${h.btn ?: ""} " + hx("Cnt:%04X", h.cnt ?: 0) + " | CRC:${h.fields[1].value}"
}
