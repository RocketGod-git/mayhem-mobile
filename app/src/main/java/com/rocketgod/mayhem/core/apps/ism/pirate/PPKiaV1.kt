// Port of ProtoPirate protocols/kia_v1.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V1: AM, Manchester at 800 / 1600 µs after a long-pair header, 57 bits: a 32-bit serial, an 8-bit button, a
 * 12-bit counter and a CRC nibble.
 */
class PPKiaV1 : PPDecoder("Kia V1", PPModulation.AM, PPConst(800, 1600, 200, 57)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_DECODE_DATA = 2

        private fun crc4(bytes: IntArray, offset: Int): Int {
            var crc = 0
            for (b in bytes) crc = crc xor ((b and 0x0F) xor (b ushr 4))
            return (crc + offset) and 0x0F
        }

        private fun buttonName(b: Int): String = when (b) { 1 -> "Close"; 2 -> "Open"; 3 -> "Boot"; else -> "??" }
    }

    private var crc = 0
    private var crcCheck = false

    init { manchester = PPManchester.START1 }   // calloc'd state

    /** kia_v1_check_remote_controller */
    private fun checkRemoteController() {
        serial = (data ushr 24) and M32
        btn = ((data ushr 16) and 0xFF).toInt()
        cnt = (((data ushr 4) and 0xF) shl 8) or ((data ushr 8) and 0xFF)
        val cntHigh = ((cnt ushr 8) and 0xF).toInt()
        val bytes = intArrayOf(((serial ushr 24) and 0xFF).toInt(), ((serial ushr 16) and 0xFF).toInt(), ((serial ushr 8) and 0xFF).toInt(),
            (serial and 0xFF).toInt(), btn, (cnt and 0xFF).toInt(), cntHigh)
        crc = crc4(bytes, 1)
        crcCheck = crc == (data and 0xF).toInt()
    }

    override fun reset() { parserStep = STEP_RESET }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teLong) < c.teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0
                decodeData = 0; decodeCountBit = 0
                manchesterAdvance(PPManchester.RESET)
            }
            STEP_CHECK_PREAMBLE -> {
                if (!level) {
                    if (dd(duration, c.teLong) < c.teDelta && dd(teLast, c.teLong) < c.teDelta) {
                        headerCount = (headerCount + 1) and 0xFFFF; teLast = duration
                    } else parserStep = STEP_RESET
                }
                if (headerCount > 70) {
                    if (!level && dd(duration, c.teShort) < c.teDelta && dd(teLast, c.teLong) < c.teDelta) {
                        decodeCountBit = 1
                        addBit(1)
                        headerCount = 0
                        parserStep = STEP_DECODE_DATA
                    }
                }
            }
            STEP_DECODE_DATA -> {
                val ev = manchesterEvent(duration, level)
                if (ev != PPManchester.RESET) {
                    val bit = manchesterAdvance(ev)
                    if (bit >= 0) { decodeData = (decodeData shl 1) or bit.toLong(); decodeCountBit++ }
                }
                if (decodeCountBit == c.minBits) {
                    data = decodeData; dataCountBit = decodeCountBit
                    emit()
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                }
            }
        }
    }

    override fun describe(): PPHit {
        checkRemoteController()
        val hi = (data ushr 32) and M32; val lo = data and M32
        return PPHit(name, dataCountBit, hx("%06X%08X", hi, lo), serial, hx("%02X:", btn.toLong()) + buttonName(btn), cnt,
            listOf(MeshField("CRC", hx("%01X ", crc.toLong()) + if (crcCheck) "OK" else "WRONG")))
    }

    /** kia_v1.c get_string: "%s %dbit\r\nKey:%06lX%08lX\r\nSerial:%08lX\r\nCnt:%03lX CRC:%01X %s\r\nBtn:%02X:%s\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Serial:%08X", h.serial ?: 0) + " | " +
            hx("Cnt:%03X", h.cnt ?: 0) + " CRC:${h.fields.firstOrNull()?.value ?: ""} | Btn:${h.btn ?: ""}"
}
