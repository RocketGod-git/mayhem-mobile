// Port of ProtoPirate protocols/ford_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Ford V0: AM, Manchester at 250 / 500 µs after a short/long preamble and a 3.5 ms gap; 80 bits, sent inverted:
 * key1 (64 bits: header, XOR-obfuscated serial, button, 19-bit counter) and key2 (checksum byte + GF(2) matrix CRC).
 */
class PPFordV0 : PPDecoder("Ford V0", PPModulation.AM, PPConst(250, 500, 100, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_PREAMBLE_CHECK = 2
        private const val STEP_GAP = 3; private const val STEP_DATA = 4
        private const val GAP_THRESHOLD = 3500

        private val crcMatrix = intArrayOf(0xDA, 0xB5, 0x55, 0x6A, 0xAA, 0xAA, 0xAA, 0xD5, 0xB6, 0x6C, 0xCC, 0xD9, 0x99, 0x99, 0x99, 0xB3,
        0x71, 0xE3, 0xC3, 0xC7, 0x87, 0x87, 0x87, 0x8F, 0x0F, 0xE0, 0x3F, 0xC0, 0x7F, 0x80, 0x7F, 0x80,
        0x00, 0x1F, 0xFF, 0xC0, 0x00, 0x7F, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x3F, 0xFF, 0xFF, 0xFF, 0x80,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x23, 0x12, 0x94, 0x84, 0x35, 0xF4, 0x55, 0x84,)

        private fun calculateCrc(buf: IntArray): Int {
            var crc = 0
            for (row in 0 until 8) {
                var xorSum = 0
                for (col in 0 until 8) xorSum = xorSum xor (crcMatrix[row * 8 + col] and buf[col + 1])
                if (PPMath.parity8(xorSum) != 0) crc = crc or (1 shl row)
            }
            return crc
        }

        fun verifyCrc(key1: Long, key2: Int): Boolean {
            val buf = IntArray(16)
            for (i in 0 until 8) buf[i] = ((key1 ushr (56 - i * 8)) and 0xFF).toInt()
            buf[8] = (key2 ushr 8) and 0xFF
            val calculated = calculateCrc(buf)
            val received = (key2 and 0xFF) xor 0x80
            return (calculated and 0x7F) == (received and 0x7F)
        }

        /** decode_ford_v0: (serial, button, count) */
        fun decode(key1: Long, key2: Int): Triple<Long, Int, Long> {
            val buf = IntArray(13)
            for (i in 0 until 8) buf[i] = ((key1 ushr (56 - i * 8)) and 0xFF).toInt()
            buf[8] = (key2 ushr 8) and 0xFF
            buf[9] = key2 and 0xFF

            var tmp = buf[8]
            var parity = 0
            val parityAny = tmp != 0
            while (tmp != 0) { parity = parity xor (tmp and 1); tmp = tmp ushr 1 }
            buf[11] = if (parityAny) parity else 0

            val xorByte: Int; val limit: Int
            if (buf[11] != 0) { xorByte = buf[7]; limit = 7 } else { xorByte = buf[6]; limit = 6 }
            for (idx in 1 until limit) buf[idx] = buf[idx] xor xorByte
            if (buf[11] == 0) buf[7] = buf[7] xor xorByte

            val origB7 = buf[7]
            buf[7] = (origB7 and 0xAA) or (buf[6] and 0x55)
            val mixed = (buf[6] and 0xAA) or (origB7 and 0x55)
            buf[12] = mixed
            buf[6] = mixed

            val serialLE = buf[1].toLong() or (buf[2].toLong() shl 8) or (buf[3].toLong() shl 16) or (buf[4].toLong() shl 24)
            val serial = ((serialLE and 0xFF) shl 24) or (((serialLE ushr 8) and 0xFF) shl 16) or (((serialLE ushr 16) and 0xFF) shl 8) or ((serialLE ushr 24) and 0xFF)
            val button = (buf[5] ushr 3) and 0x0F
            val count = ((buf[5] and 0x07).toLong() shl 16) or (buf[6].toLong() shl 8) or buf[7].toLong()
            return Triple(serial, button, count)
        }

        private fun buttonName(b: Int): String = when (b) { 0x01 -> "Panic"; 0x02 -> "Lock"; 0x04 -> "Unlock"; 0x08 -> "Boot"; else -> "??" }
    }

    private var dataLow = 0L
    private var dataHigh = 0L
    private var bitCount = 0   // uint8
    private var key1 = 0L
    private var key2 = 0       // uint16
    private var fSerial = 0L
    private var button = 0
    private var count = 0L

    private fun addBitV0(bit: Int) {
        val low = dataLow and M32
        dataLow = (dataLow shl 1) or bit.toLong()
        dataHigh = (dataHigh shl 1) or ((low ushr 31) and 1)
        bitCount = (bitCount + 1) and 0xFF
    }

    private fun processData(): Boolean {
        if (bitCount == 64) {
            val combined = (dataHigh shl 32) or dataLow
            key1 = combined.inv()
            dataLow = 0; dataHigh = 0
            return false
        }
        if (bitCount == 80) {
            val raw = (dataLow and 0xFFFF).toInt()
            val k2 = raw.inv() and 0xFFFF
            val (s, b, n) = decode(key1, k2)
            fSerial = s; button = b; count = n
            key2 = k2
            return true
        }
        return false
    }

    override fun reset() {
        super.reset()
        teLast = 0; dataLow = 0; dataHigh = 0; bitCount = 0; key1 = 0; key2 = 0; fSerial = 0; button = 0; count = 0
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teShort) < c.teDelta) {
                dataLow = 0; dataHigh = 0; parserStep = STEP_PREAMBLE; teLast = duration; headerCount = 0; bitCount = 0
                manchesterAdvance(PPManchester.RESET)
            }
            STEP_PREAMBLE -> if (!level) {
                if (dd(duration, c.teLong) < c.teDelta) { teLast = duration; parserStep = STEP_PREAMBLE_CHECK }
                else parserStep = STEP_RESET
            }
            STEP_PREAMBLE_CHECK -> if (level) {
                if (dd(duration, c.teLong) < c.teDelta) { headerCount++; teLast = duration; parserStep = STEP_PREAMBLE }
                else if (dd(duration, c.teShort) < c.teDelta) parserStep = STEP_GAP
                else parserStep = STEP_RESET
            }
            STEP_GAP -> {
                if (!level && dd(duration, GAP_THRESHOLD) < 250) {
                    dataLow = 1; dataHigh = 0; bitCount = 1; parserStep = STEP_DATA
                } else if (!level && duration > GAP_THRESHOLD + 250) {
                    parserStep = STEP_RESET
                }
            }
            STEP_DATA -> {
                val ev = manchesterEvent(duration, level)
                if (ev == PPManchester.RESET) { parserStep = STEP_RESET; return }
                val bit = manchesterAdvance(ev)
                if (bit >= 0) {
                    addBitV0(bit)
                    if (processData()) {
                        data = key1; dataCountBit = 64; serial = fSerial; btn = button; cnt = count
                        emit()
                        dataLow = 0; dataHigh = 0; bitCount = 0; parserStep = STEP_RESET
                    }
                }
                teLast = duration
            }
        }
    }

    override fun describe(): PPHit {
        val ok = verifyCrc(key1, key2)
        return PPHit(name, dataCountBit, hx("%016X", key1), fSerial, hx("%02X - ", button.toLong()) + buttonName(button), count,
            listOf(MeshField("CRC", if (ok) "OK" else "BAD"),
                MeshField("Key2", hx("%04X", key2.toLong())),
                MeshField("Checksum", hx("%02X", ((key2 ushr 8) and 0xFF).toLong())),
                MeshField("CRC byte", hx("%02X", (key2 and 0xFF).toLong()))))
    }

    /**
     * ford_v0.c get_string: "%s %dbit CRC:%s\r\nKey1: %08lX%08lX\r\nKey2: %04X  Sn: %08lX\r\nCnt: %05lX  Checksum: %02X\r\n
     * Btn: %02X - %s  CRC: %02X".
     */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit CRC:${h.field("CRC")} | Key1: ${h.key} | Key2: ${h.field("Key2")}  Sn: " + hx("%08X", h.serial ?: 0) +
            " | " + hx("Cnt: %05X", h.cnt ?: 0) + "  Checksum: ${h.field("Checksum")} | Btn: ${h.btn ?: ""}  CRC: ${h.field("CRC byte")}"
}
