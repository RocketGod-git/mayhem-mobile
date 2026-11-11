// Port of ProtoPirate protocols/ford_v1.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Ford V1: FM, Manchester at 65 / 130 µs after 50+ long preamble pulses and a short sync; 17 bytes (136 bits)
 * with a CRC-16/XMODEM over bytes 3..14, sent either way up. Bytes 6..14 carry the XOR-scrambled serial, button and
 * 20-bit counter; when the scramble cannot be undone (an encrypted frame) only the device id is shown.
 */
class PPFordV1 : PPDecoder("Ford V1", PPModulation.FM, PPConst(65, 130, 39, 136)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_SYNC = 2; private const val STEP_DATA = 3
        private const val DELTA_LONG = 40; private const val DELTA_DATA_SYNC = 39; private const val SILENCE_LONG_MULT = 3
        private const val PREAMBLE_MIN = 50; private const val DATA_BITS = 136; private const val DATA_BYTES = 17

        private fun crc16(b: IntArray, from: Int, to: Int): Int = PPMath.crc16(b.copyOfRange(from, to), 0x1021, 0x0000)

        private fun buttonName(b: Int): String = when (b) { 0 -> "Sync"; 1 -> "Lock"; 2 -> "Unlock"; 4 -> "Trunk"; 8 -> "Panic"; else -> "??" }

        private fun decodeWithFlag(raw: IntArray, flag: Int) {
            if (raw.size < 9) return
            if (flag != 0) {
                val x = raw[7]
                for (i in 1 until 7) raw[i] = raw[i] xor x
            } else {
                val x = raw[6]
                for (i in 1 until 6) raw[i] = raw[i] xor x
                raw[7] = raw[7] xor x
            }
            val b6 = raw[6]; val b7 = raw[7]
            raw[6] = (b6 and 0xAA) or (b7 and 0x55)
            raw[7] = (b7 and 0xAA) or (b6 and 0x55)
        }

        private fun decode(raw: IntArray) {
            if (raw.size < 9) return
            val end = raw[8]
            var parity = 0; var tmp = end
            while (tmp != 0) { parity = parity xor (tmp and 1); tmp = tmp ushr 1 }
            decodeWithFlag(raw, if (end != 0) parity else 0)
        }

        private fun encodeInverseBlock(block: IntArray) {
            var sum = 0
            for (i in 1..7) sum = (sum + block[i]) and 0xFF
            val p6 = block[6]; val p7 = block[7]
            val post6 = (p6 and 0xAA) or (p7 and 0x55)
            val post7 = (p7 and 0xAA) or (p6 and 0x55)
            val xorv = post6 xor post7
            val x: Int
            if (Integer.bitCount(sum) and 1 != 0) { block[6] = xorv; block[7] = post7; x = post7 }
            else { block[6] = post6; block[7] = xorv; x = post6 }
            for (i in 1..5) block[i] = block[i] xor x
        }

        private fun plainFromAir(air9: IntArray): IntArray? {
            for (flag in 0 until 2) {
                val cand = air9.copyOf()
                decodeWithFlag(cand, flag)
                val reair = cand.copyOf()
                encodeInverseBlock(reair)
                if (reair.contentEquals(air9)) return cand
            }
            return null
        }
    }

    private var crcCalc = 0L
    private var data2 = 0L
    private var rawBytes = IntArray(18)
    private var byteCount = 0        // uint8
    private var preambleCount = 0    // uint16
    private var syncEventIdx = 0     // uint8
    private var syncEventCount = 0   // uint8
    private var syncEvents = IntArray(8)
    private var encryptionSupported = 0

    private fun processData(): Boolean {
        val orig = rawBytes.copyOfRange(0, DATA_BYTES)
        var calc = crc16(rawBytes, 3, 15)
        var recv = (rawBytes[15] shl 8) or rawBytes[16]
        if (recv != calc) {
            for (i in 0 until DATA_BYTES) rawBytes[i] = orig[i].inv() and 0xFF
            calc = crc16(rawBytes, 3, 15)
            recv = (rawBytes[15] shl 8) or rawBytes[16]
        }
        if (recv != calc) return false

        val raw = rawBytes.copyOf()
        val air9 = raw.copyOfRange(6, 15)
        val decoded: IntArray
        var strictOk = false
        val b0 = air9.copyOf(); decodeWithFlag(b0, 0)
        val b1 = air9.copyOf(); decodeWithFlag(b1, 1)
        val p: IntArray?
        if (b0[3] == raw[5] && b0[4] == raw[6]) { decoded = b0; strictOk = true }
        else if (b1[3] == raw[5] && b1[4] == raw[6]) { decoded = b1; strictOk = true }
        else {
            p = plainFromAir(air9)
            if (p != null) decoded = p   // rolling: fields not shown
            else { decoded = air9.copyOf(); decode(decoded) }
        }

        crcCalc = crc16(raw, 3, 15).toLong()
        var key1 = 0L
        for (i in 0 until 7) key1 = (key1 shl 8) or raw[i].toLong()
        var key2 = 0L
        for (i in 0 until 8) key2 = (key2 shl 8) or raw[7 + i].toLong()
        data = key1; data2 = key2; dataCountBit = DATA_BITS

        if (strictOk) {
            serial = (decoded[1].toLong() shl 24) or (decoded[2].toLong() shl 16) or (decoded[3].toLong() shl 8) or decoded[0].toLong()
            btn = (decoded[5] ushr 4) and 0x0F
            cnt = ((decoded[5] and 0x0F).toLong() shl 16) or (decoded[6].toLong() shl 8) or decoded[7].toLong()
            encryptionSupported = 1
        } else {
            serial = (raw[3].toLong() shl 24) or (raw[4].toLong() shl 16) or (raw[5].toLong() shl 8) or raw[6].toLong()
            btn = 0; cnt = 0; encryptionSupported = 0
        }
        emit()
        return true
    }

    private fun tryLastByteVariants(): Boolean {
        if (byteCount != 16) { resetV1(); return false }
        if (((decodeCountBit + 0x7A) and 0xFF) > 1) { resetV1(); return false }
        val shift = (DATA_BITS - decodeCountBit) and 0xFF
        val variants = if (shift >= 8) 0 else (1 shl shift) and 0xFF
        val saved = rawBytes.copyOfRange(0, 16)
        val partial = decodeData and M32
        var variant = 0
        while (variant < variants) {
            System.arraycopy(saved, 0, rawBytes, 0, 16)
            rawBytes[16] = ((((partial and 0xFF).toInt()) shl shift) and 0xFF) or variant
            if (processData()) { resetV1(); return true }
            variant = (variant + 1) and 0xFF
        }
        resetV1()
        return false
    }

    private fun resetV1() {
        parserStep = STEP_RESET; decodeData = 0; decodeCountBit = 0; byteCount = 0
        rawBytes = IntArray(18); preambleCount = 0; syncEventIdx = 0; syncEventCount = 0
        syncEvents = IntArray(8)
        manchesterAdvance(PPManchester.RESET)
    }

    override fun reset() { resetV1() }

    private fun pushBit(bit: Int) {
        decodeData = (decodeData shl 1) or bit.toLong()
        decodeCountBit++
    }

    override fun feed(level: Boolean, duration: Int) {
        val teShort = c.teShort; val teLong = c.teLong
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong) < DELTA_LONG) {
                parserStep = STEP_PREAMBLE; preambleCount = 1; teLast = duration
            }
            STEP_PREAMBLE -> {
                if (dd(duration, teLong) < DELTA_LONG) {
                    preambleCount = (preambleCount + 1) and 0xFFFF; teLast = duration
                } else if (dd(duration, teShort) < DELTA_DATA_SYNC) {
                    if (preambleCount >= PREAMBLE_MIN) {
                        syncEventIdx = 0; syncEventCount = 1
                        syncEvents[0] = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
                        parserStep = STEP_SYNC
                    } else parserStep = STEP_RESET
                } else {
                    if (preambleCount < PREAMBLE_MIN) parserStep = STEP_RESET
                }
            }
            STEP_SYNC -> {
                val ev: Int
                var isShort = false
                if (dd(duration, teShort) < DELTA_DATA_SYNC) {
                    ev = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW; isShort = true
                } else if (dd(duration, teLong) < DELTA_DATA_SYNC) {
                    ev = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
                } else { parserStep = STEP_PREAMBLE; return }

                syncEventIdx = (syncEventIdx + 1) and 0xFF
                if (isShort) syncEventCount = (syncEventCount + 1) and 0xFF
                if (syncEventIdx < 8) syncEvents[syncEventIdx] = ev

                if (syncEventCount > 2) {
                    decodeData = 0; decodeCountBit = 0; byteCount = 0
                    rawBytes = IntArray(18)
                    manchesterAdvance(PPManchester.RESET)
                    if (syncEvents[0] == PPManchester.SHORT_LOW) manchester = PPManchester.MID0
                    parserStep = STEP_DATA
                    var i = 0
                    while (i <= syncEventIdx && i < 8) {
                        val bit = manchesterAdvance(syncEvents[i])
                        if (bit >= 0) {
                            pushBit(bit)
                            if (decodeCountBit and 7 == 0) {
                                val b = (decodeData and 0xFF).toInt()
                                if (byteCount < DATA_BYTES) { rawBytes[byteCount] = b; byteCount++ }
                                decodeData = 0
                            }
                        }
                        i++
                    }
                    return
                }
                if (syncEventIdx >= 7) parserStep = STEP_PREAMBLE
            }
            STEP_DATA -> {
                val event: Int
                if (dd(duration, teShort) < DELTA_DATA_SYNC) event = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
                else if (dd(duration, teLong) < DELTA_DATA_SYNC) event = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
                else { tryLastByteVariants(); return }

                val bit = manchesterAdvance(event)
                if (bit >= 0) {
                    pushBit(bit)
                    if (decodeCountBit and 7 == 0) {
                        val b = (decodeData and 0xFF).toInt()
                        if (byteCount < DATA_BYTES) { rawBytes[byteCount] = b; byteCount++ }
                        decodeData = 0
                        if (byteCount > 16) { processData(); resetV1() }
                    }
                }
                teLast = duration
            }
        }
    }

    /** ford_v1_raw14_from_internal_keys plus the CRC bytes, and the CRC check get_string does. */
    private fun rawFromKeys(): IntArray {
        val raw = IntArray(DATA_BYTES)
        for (i in 0 until 7) raw[i] = ((data ushr (48 - i * 8)) and 0xFF).toInt()
        for (i in 0 until 8) raw[7 + i] = ((data2 ushr (56 - i * 8)) and 0xFF).toInt()
        raw[15] = ((crcCalc ushr 8) and 0xFF).toInt()
        raw[16] = (crcCalc and 0xFF).toInt()
        return raw
    }

    override fun describe(): PPHit {
        val crc16 = (crcCalc and 0xFFFF).toInt()
        val raw = rawFromKeys()
        val ok = crc16(raw, 3, 15) == crc16
        val line1 = hx("%014X%06X", data, data2 ushr 40)
        val line2 = hx("%010X%04X", data2 and 0xFF_FFFF_FFFFL, crc16.toLong())
        val crcText = hx("%04X [", crc16.toLong()) + (if (ok) "OK" else "ERR") + "]"
        if (encryptionSupported != 0) {
            return PPHit(name, dataCountBit, line1 + line2, serial, hx("%01X [", btn.toLong()) + buttonName(btn) + "]", cnt,
                listOf(MeshField("Key1", line1), MeshField("Key2", line2), MeshField("CRC", crcText)))
        }
        val deviceId = (raw[3].toLong() shl 24) or (raw[4].toLong() shl 16) or (raw[5].toLong() shl 8) or raw[6].toLong()
        return PPHit(name, dataCountBit, line1 + line2, deviceId, null, null,
            listOf(MeshField("Key1", line1), MeshField("Key2", line2),
                MeshField("CRC", crcText), MeshField("Note", "Encryption not supported !")))
    }

    /**
     * ford_v1.c get_string: "%s %dbit\r\n%014llX%06llX\r\n%010llX%04lX\r\nSn:%08lX Bt:%01X [%s]\r\nCnt:%05lX CRC:%04lX [%s]\r\n",
     * or, without a plain frame, "...\r\nSn:%08lX\r\nCRC:%04lX [%s]\r\nEncryption not supported !\r\n".
     */
    override fun cString(h: PPHit): String {
        val head = "${h.name} ${h.bits}bit | ${h.field("Key1")} | ${h.field("Key2")} | " + hx("Sn:%08X", h.serial ?: 0)
        val b = h.btn; val c = h.cnt
        if (b != null && c != null) return head + " Bt:$b | " + hx("Cnt:%05X", c) + " CRC:${h.field("CRC")}"
        return head + " | CRC:${h.field("CRC")} | ${h.field("Note")}"
    }
}
