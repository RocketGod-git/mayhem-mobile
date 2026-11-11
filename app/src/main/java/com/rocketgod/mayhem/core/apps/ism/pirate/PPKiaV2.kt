// Port of ProtoPirate protocols/kia_v2.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V2: AM, Manchester at 500 / 1000 µs, a long header of 1000 µs pairs, 53 bits: serial, button, a 12-bit counter
 * stored nibble-swapped, and a CRC nibble.
 */
class PPKiaV2 : PPDecoder("Kia V2", PPModulation.AM, PPConst(500, 1000, 150, 53)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_COLLECT_RAW_BITS = 2

        fun crc(data: Long): Int {
            val d = data ushr 4
            var crc = 0
            for (i in 0 until 6) { val b = ((d ushr (8 * i)) and 0xFF).toInt(); crc = crc xor ((b and 0x0F) xor (b ushr 4)) }
            return (crc + 1) and 0x0F
        }
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teLong) < c.teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0
                manchesterAdvance(PPManchester.RESET)
            }
            STEP_CHECK_PREAMBLE -> if (level) {
                if (dd(duration, c.teLong) < c.teDelta) { teLast = duration; headerCount++ }
                else if (dd(duration, c.teShort) < c.teDelta) {
                    if (headerCount >= 100) {
                        headerCount = 0; decodeData = 0; decodeCountBit = 1; parserStep = STEP_COLLECT_RAW_BITS
                        addBit(1)
                    } else teLast = duration
                } else parserStep = STEP_RESET
            } else {
                if (dd(duration, c.teLong) < c.teDelta) { headerCount++; teLast = duration }
                else if (dd(duration, c.teShort) < c.teDelta) teLast = duration
                else parserStep = STEP_RESET
            }
            STEP_COLLECT_RAW_BITS -> {
                val ev = manchesterEvent(duration, level)
                if (ev == PPManchester.RESET) { parserStep = STEP_RESET; return }
                val bit = manchesterAdvance(ev)
                if (bit >= 0) {
                    decodeData = (decodeData shl 1) or bit.toLong()
                    decodeCountBit++
                    if (decodeCountBit == 53) {
                        data = decodeData; dataCountBit = decodeCountBit
                        serial = (data ushr 20) and M32
                        btn = ((data ushr 16) and 0x0F).toInt()
                        val raw = ((data ushr 4) and 0xFFF).toInt()
                        cnt = (((raw ushr 4) or (raw shl 8)) and 0xFFF).toLong()
                        emit()
                        decodeData = 0; decodeCountBit = 0; headerCount = 0; parserStep = STEP_RESET
                    }
                }
            }
        }
    }

    override fun describe(): PPHit {
        val crc = (data and 0x0F).toInt()
        val ok = crc == crc(data)
        return PPHit(name, dataCountBit, hx("%013X", data), serial, hx("%X", btn.toLong()), cnt,
            listOf(MeshField("CRC", hx("%X", crc.toLong()) + " - " + if (ok) "OK" else "BAD")))
    }

    /** kia_v2.c get_string: "%s %dbit\r\nKey:%013llX\r\nSn:%08lX Btn:%X\r\nCnt:%03lX CRC:%X - %s\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%08X", h.serial ?: 0) + " Btn:${h.btn ?: ""}" +
            " | " + hx("Cnt:%03X", h.cnt ?: 0) + " CRC:${h.fields.firstOrNull()?.value ?: ""}"
}
