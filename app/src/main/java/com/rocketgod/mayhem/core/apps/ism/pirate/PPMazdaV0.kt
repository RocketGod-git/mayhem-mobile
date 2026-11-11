// Port of ProtoPirate protocols/mazda_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Mazda V0: Manchester at 250 / 500 µs (120 µs tolerance); 16+ preamble ones and the sync byte D7, then 64 bits sent
 * inverted: an XOR-obfuscated serial, button and 20-bit counter, and a sum checksum. ProtoPirate registers it behind
 * both demodulators (AM and FM routes); FM is the one listed here.
 */
class PPMazdaV0 : PPDecoder("Mazda V0", PPModulation.FM, PPConst(250, 500, 100, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 5; private const val STEP_DATA = 6
        private const val SYNC_BYTE = 0xD7; private const val PREAMBLE_ONES = 16

        fun checksum(serial: Long, button: Int, counter0: Long): Int {
            val counter = counter0 and 0xFFFFF
            val s = ((serial ushr 24) and 0xFF) + ((serial ushr 16) and 0xFF) + ((serial ushr 8) and 0xFF) + (serial and 0xFF) +
                ((counter ushr 8) and 0xFF) + (counter and 0xFF) + ((((counter ushr 16) and 0x0F) or ((button and 0x0F).toLong() shl 4)) and 0xFF)
            return (s and 0xFF).toInt()
        }

        private fun buttonName(b: Int): String = when (b) { 0x01 -> "Lock"; 0x02 -> "Unlock"; 0x04 -> "Trunk"; 0x08 -> "Remote"; else -> "??" }
    }

    private var preambleCount = 0     // uint16
    private var preamblePattern = 0   // uint8
    private var button = 0
    private var count = 0L

    init { manchester = PPManchester.START1 }   // calloc: ManchesterStateStart1

    /** -1 when the duration fits neither. */
    private fun getEvent(duration: Int, level: Boolean): Int {
        val tol = c.teDelta + 20
        if (dd(duration, c.teShort) < tol) return if (level) PPManchester.SHORT_LOW else PPManchester.SHORT_HIGH
        if (dd(duration, c.teLong) < tol) return if (level) PPManchester.LONG_LOW else PPManchester.LONG_HIGH
        return -1
    }

    /** mazda_v0_decode_key: fills serial, btn and cnt from data. */
    private fun decodeKey() {
        val d = PPMath.u64ToBytesBE(data)
        val parity = PPMath.parity8(d[7]) != 0
        val limit = if (parity) 6 else 5
        val mask = d[limit]
        for (i in 0 until limit) d[i] = d[i] xor mask
        if (!parity) d[6] = d[6] xor mask
        val counterLo = (d[5] and 0x55) or (d[6] and 0xAA)
        val counterMid = (d[6] and 0x55) or (d[5] and 0xAA)
        serial = (d[0].toLong() shl 24) or (d[1].toLong() shl 16) or (d[2].toLong() shl 8) or d[3].toLong()
        btn = (d[4] ushr 4) and 0x0F
        cnt = ((d[4] and 0x0F).toLong() shl 16) or (counterMid.toLong() shl 8) or counterLo.toLong()
        dataCountBit = c.minBits
    }

    override fun reset() {
        parserStep = STEP_RESET; teLast = 0; decodeData = 0; decodeCountBit = 0
        manchester = PPManchester.START1; preambleCount = 0; preamblePattern = 0
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teShort) < c.teDelta + 20) {
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_PREAMBLE
                manchester = PPManchester.MID1; preambleCount = 0; preamblePattern = 0
            }
            STEP_PREAMBLE -> {
                val ev = getEvent(duration, level)
                if (ev < 0) { parserStep = STEP_RESET; return }
                val bit = manchesterAdvance(ev)
                if (bit >= 0) {
                    preamblePattern = ((preamblePattern shl 1) or bit) and 0xFF
                    if (bit == 1) {
                        preambleCount = (preambleCount + 1) and 0xFFFF
                    } else if (preambleCount <= PREAMBLE_ONES - 1) {
                        preambleCount = 0; preamblePattern = 0
                        return
                    }
                    if (preamblePattern == SYNC_BYTE && preambleCount > PREAMBLE_ONES - 1) {
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_DATA
                    }
                }
            }
            STEP_DATA -> {
                val ev = getEvent(duration, level)
                if (ev < 0) { parserStep = STEP_RESET; return }
                val bit = manchesterAdvance(ev)
                if (bit >= 0) {
                    addBit(bit)
                    decodeCountBit = decodeCountBit and 0xFF   // uint8_t decode_count_bit
                    if (decodeCountBit == c.minBits) {
                        data = decodeData.inv()
                        decodeKey()
                        if (checksum(serial, btn, cnt) == (data and 0xFF).toInt()) {
                            button = btn; count = cnt
                            emit()
                        }
                        decodeData = 0; decodeCountBit = 0; preambleCount = 0; preamblePattern = 0
                        manchester = PPManchester.START1; teLast = 0; parserStep = STEP_RESET
                    }
                }
            }
        }
    }

    override fun describe(): PPHit {
        // get_string re-runs mazda_v0_decode_key on data first; the fields are already the decoded ones.
        decodeKey()
        val rawCrc = (data and 0xFF).toInt()
        val calc = checksum(serial, btn, cnt)
        return PPHit(name, dataCountBit, hx("%016X", data), serial, hx("%02X - ", btn.toLong()) + buttonName(btn), cnt and 0xFFFFF,
            listOf(MeshField("CRC", if (rawCrc == calc) "OK" else "BAD"), MeshField("Chk", hx("%02X", rawCrc.toLong()))))
    }

    /** mazda_v0.c get_string: "%s %dbit CRC:%s\r\nKey: %016llX\r\nSn: %08lX  Btn: %02X - %s\r\nCnt: %05lX  Chk: %02X\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit CRC:${h.field("CRC")} | Key: ${h.key} | " + hx("Sn: %08X", h.serial ?: 0) +
            "  Btn: ${h.btn ?: ""} | " + hx("Cnt: %05X", h.cnt ?: 0) + "  Chk: ${h.field("Chk")}"
}
