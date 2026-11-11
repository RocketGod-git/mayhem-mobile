// Port of ProtoPirate protocols/chrysler_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Chrysler V0: AM, PWM with a 300 µs short mark and ~3400 / 3700 µs long gaps, a preamble of 16+ short/long pairs,
 * 80 bits (64 + a 16-bit second key). A 6-bit seed from the first byte picks an XOR mask that unmasks either block A
 * (serial A) or block B (serial B); the decoder remembers both across frames, as the C does.
 */
class PPChryslerV0 : PPDecoder("Chrysler V0", PPModulation.AM, PPConst(0x12C, 0xD48, 0x96, 0x50)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_SEEK = 1; private const val STEP_DATA = 2
        private const val TE_SHORT_US = 0x12C; private const val TE_DELTA_US = 0x96; private const val TE_LONG_A = 0xD48
        private const val TE_LONG_B = 0xE74; private const val TE_LONG_DELTA = 0x190
        private const val TE_GAP = 0x1F40; private const val DECODE_BIT_COUNT = 0x50
        private val xorTable = intArrayOf(0x0F, 0x02, 0x40, 0x0C, 0x30, 0x0E, 0x70, 0x08,
            0x10, 0x0A, 0x50, 0xF4, 0x2F, 0xF6, 0x6F, 0xF0)

        private fun reverse6(v0: Int): Int {
            var out = 0; var v = v0
            repeat(6) { out = ((out shl 1) or (v and 1)) and 0xFF; v = v ushr 1 }
            return out
        }
        private fun transform(input: IntArray, key: Int, button: Int): IntArray {
            var mask = xorTable[key and 0x0F]
            if (button == 1) mask = mask xor (if ((key and 1) != 0) 0xF0 else 0x0F)
            return IntArray(input.size) { input[it] xor mask }
        }
        private fun isShortD(d: Int) = kotlin.math.abs(d - TE_SHORT_US) <= TE_DELTA_US
        private fun isLongMark(d: Int) = kotlin.math.abs(d - TE_LONG_A) <= TE_LONG_DELTA || kotlin.math.abs(d - TE_LONG_B) <= TE_LONG_DELTA
        fun buttonName(b: Int): String = if (b == 1) "Lock" else if (b == 2) "Unlock" else "??"
    }

    private var packetBitCount = 0   // uint16
    private var decodedButton = 0
    private var plainA = IntArray(9)
    private var plainB = IntArray(9)
    private var plainAPresent = false
    private var plainBPresent = false
    private var checkOk = false
    private var snB = 0L
    private var data2 = 0            // uint16
    private var seed = 0

    override fun reset() {
        decodeData = 0; data2 = 0; seed = 0; parserStep = STEP_RESET; decodeCountBit = 0
        packetBitCount = 0; teLast = 0; plainAPresent = false; plainBPresent = false; snB = 0
    }

    private fun decodePacket() {
        val key2 = data2
        val key = PPMath.u64ToBytesBE(data)
        seed = reverse6(key[0] ushr 2)
        val b1xb6 = key[6] xor key[1]
        if (key[0] and 0x80 != 0) {
            val key2Low = key2 and 0xFF
            checkOk = key[1] == key[5] && b1xb6 == 0x62
            decodedButton = if ((key2Low xor key[4]) == 0x10) 2 else 1
        } else {
            checkOk = false
            decodedButton = 1
            if ((key[1] xor 0xC3) == key[5]) {
                if (b1xb6 == 0x04) checkOk = true
                else { checkOk = b1xb6 == 0x08; if (b1xb6 == 0x08) decodedButton = 2 }
            } else if (b1xb6 == 0x08) decodedButton = 2
        }
        val encoded = intArrayOf(key[1], key[2], key[3], key[4], key[5], key[6], key[7], (key2 ushr 8) and 0xFF, key2 and 0xFF)
        val decoded = transform(encoded, seed, decodedButton)
        if (seed and 1 != 0) {
            plainB = decoded; plainBPresent = true
            snB = (decoded[0].toLong() shl 24) or (decoded[1].toLong() shl 16) or (decoded[2].toLong() shl 8) or decoded[7].toLong()
        } else {
            plainA = decoded; plainAPresent = true
            cnt = (decoded[0].toLong() shl 24) or (decoded[1].toLong() shl 16) or (decoded[2].toLong() shl 8) or decoded[3].toLong()
        }
        btn = decodedButton
    }

    private fun commit() {
        packetBitCount = DECODE_BIT_COUNT
        decodeCountBit = DECODE_BIT_COUNT
        dataCountBit = DECODE_BIT_COUNT
        decodePacket()
        if (checkOk) emit()
    }

    private fun endFrame(count: Int) {
        if (count > 0x4F) { data = decodeData; commit() }
        parserStep = STEP_RESET
        packetBitCount = 0
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && isShortD(duration)) {
                packetBitCount = 0; teLast = duration; parserStep = STEP_SEEK
            }
            STEP_SEEK -> {
                if (level) { teLast = duration; return }
                if (isLongMark(duration)) {
                    if (isShortD(teLast)) packetBitCount = (packetBitCount + 1) and 0xFFFF
                    else if (packetBitCount > 0x0F) {
                        data2 = 0; parserStep = STEP_DATA; decodeData = 1; decodeCountBit = 1
                    } else { packetBitCount = 0; parserStep = STEP_SEEK }
                    return
                }
                if (duration > TE_GAP && packetBitCount > 0x0F) {
                    decodeData = 0; data2 = 0; decodeCountBit = 0; parserStep = STEP_DATA
                    return
                }
                parserStep = STEP_RESET
                packetBitCount = 0
            }
            STEP_DATA -> {
                if (level) { teLast = duration; return }
                val count = decodeCountBit and 0xFF
                if (duration > TE_GAP) { endFrame(count); return }
                var bitValue: Int
                if (teLast < TE_SHORT_US) {
                    if (!isShortD(teLast) || !isLongMark(duration)) { endFrame(count); return }
                    bitValue = 1
                } else {
                    if (teLast > 0x2EE || !isLongMark(duration)) { endFrame(count); return }
                    bitValue = if (isShortD(teLast)) 1 else 0
                }
                val bit = bitValue xor 1
                val newCount = (count + 1) and 0xFF
                if (count <= 0x3F) {
                    decodeData = (decodeData shl 1) or bit.toLong()
                    decodeCountBit = newCount
                    return
                }
                data2 = ((data2 shl 1) or bit) and 0xFFFF
                decodeCountBit = newCount
                if (newCount != DECODE_BIT_COUNT) return
                data = decodeData
                commit()
                decodeData = 0; data2 = 0; decodeCountBit = 0
                parserStep = STEP_RESET
                packetBitCount = 0
            }
            else -> parserStep = STEP_RESET
        }
    }

    override fun describe(): PPHit {
        val f = mutableListOf<MeshField>()
        if (plainAPresent) f.add(MeshField("SnA", hx("%08X", cnt)))
        if (plainBPresent) f.add(MeshField("SnB", hx("%08X", snB)))
        f.add(MeshField("Button", buttonName(decodedButton)))
        f.add(MeshField("Cnt", hx("%02X", seed.toLong())))
        f.add(MeshField("Chk", if (checkOk) "OK" else "ERR"))
        return PPHit(name, packetBitCount, hx("%016X%04X", data, data2.toLong()),
            if (plainBPresent) snB else cnt, hx("%02X", decodedButton.toLong()), seed.toLong(), f)
    }

    /**
     * chrysler_v0.c get_string: "%s %dbit\r\n%016llX%04X\r\n", then "SnA:%08lX\r\n" and/or "SnB:%08lX\r\n" for the
     * blocks seen so far, then "Btn:%02X [%s] Cnt:%02X\r\nChk:%s".
     */
    override fun cString(h: PPHit): String {
        val parts = mutableListOf("${h.name} ${h.bits}bit", h.key)
        for (fl in h.fields) if (fl.name == "SnA" || fl.name == "SnB") parts.add("${fl.name}:${fl.value}")
        val v = HashMap<String, String>()
        for (fl in h.fields) v.putIfAbsent(fl.name, fl.value)
        parts.add("Btn:${h.btn ?: ""} [${v["Button"]}] Cnt:${v["Cnt"]}")
        parts.add("Chk:${v["Chk"]}")
        return parts.joinToString(" | ")
    }
}
