// Port of ProtoPirate protocols/renault_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Renault V0: AM, a sync mark of 800+ µs, then Manchester at 125 / 250 µs; a run of preamble 1 bits, then 64 bits
 * (24-bit serial, button byte, counter byte, 24 parity bits) and an 18-bit Key2. Accepted when the XOR checksum and
 * button are valid (C1/C2); IC rebuilds the parity bits from the 42-row matrix and compares.
 */
class PPRenaultV0 : PPDecoder("Renault V0", PPModulation.AM, PPConst(0x7D, 0xFA, 0x45, 0x52)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_DATA = 1
        private const val MIN_BITS = 0x52; private const val BIT_LIMIT = 0x6D; private const val SYNC_MIN_US = 0x320; private const val DECODED_BITS_MAX = 0x70
        private const val TE_SHORT_US = 0x7D; private const val TE_LONG_US = 0xFA; private const val TE_DELTA_US = 0x45
        private val stateTable = intArrayOf(0x01, 0x91, 0x9B, 0xFB)
        /** (low, high) pairs. */
        private val matrix = longArrayOf(
            0x00000001, 0x00000000, 0x04000029, 0x00000000, 0x0000001B, 0x00000000,
            0x00000000, 0x00000000, 0x00000001, 0x00000000, 0x05220124, 0x00000000,
            0x00000001, 0x00000000, 0x00088410, 0x00000000, 0x60132D1D, 0x00000000,
            0x60170F87, 0x00001004, 0x00000000, 0x00000000, 0x002000A9, 0x00000000,
            0x20863E01, 0x0000100C, 0x24BB3755, 0x00000004, 0x640199A4, 0x00000004,
            0x24225C43, 0x00001004, 0x607886F1, 0x0000100C, 0x6007A101, 0x0000000C,
            0x66672A10, 0x00000004, 0x4651623F, 0x00001008, 0x43380BBF, 0x00001008,
            0x20237F84, 0x00001000, 0x4245755E, 0x00001008, 0x60AAF581, 0x00000004,
            0x22722DAD, 0x0000000C, 0x27C617F7, 0x00000000, 0x46DE8F1B, 0x0000000C,
            0x231DEC51, 0x00000000, 0x03ACAA0B, 0x00000008, 0x22D2BF81, 0x00000004,
            0x626EF6AE, 0x0000100C, 0x40441F95, 0x0000000C, 0x00000001, 0x00000000,
            0x00000000, 0x00000000, 0x20B9A590, 0x00000008, 0x656C8E86, 0x00001008,
            0x60129F96, 0x0000000C, 0x2368F667, 0x00001000, 0x442A1A5C, 0x00000000,
            0x04C43242, 0x0000100C, 0x22198640, 0x00001000, 0x23D6B958, 0x00001008,
        )

        /** (serial, button, counter) */
        fun parseFields(data: Long): Triple<Long, Int, Int> =
            Triple((data ushr 40) and M32, ((data ushr 32) and 0xFF).toInt(), (((data and M32) ushr 24) and 0xFF).toInt())
        fun buttonValid(b: Int) = b == 0x05 || b == 0x06 || b == 0x0A
        fun buttonName(b: Int): String = when (b) { 0x05 -> "Trunk"; 0x06 -> "Lock"; 0x0A -> "Unlock"; else -> "?" }
        fun checksum(data: Long, key2: Long): Int {
            val bytes = PPMath.u64ToBytesBE(data) + intArrayOf(((key2 ushr 10) and 0xFF).toInt(), ((key2 ushr 2) and 0xFF).toInt())
            return PPMath.xorBytes(bytes)
        }
        private fun parity32(v0: Long): Int {
            var v = v0 and M32; v = v xor (v ushr 16); v = v xor (v ushr 8); v = v xor (v ushr 4); v = v xor (v ushr 2); v = v xor (v ushr 1)
            return (v and 1).toInt()
        }
        /** (data, key2) */
        fun buildKey(serial: Long, button: Int, counter: Int): Pair<Long, Long> {
            val vars = IntArray(7)
            vars[0] = if (button == 0x0A) 1 else 0
            for (bit in 0 until 6) vars[bit + 1] = (counter ushr bit) and 1
            var mask = 1L   // the split low/high 32-bit masks as one 64-bit value
            var maskBit = 1
            for (i in 0 until 7) { if (vars[i] != 0) mask = mask or (1L shl maskBit); maskBit++ }
            for (i in 0 until 6) for (j in i + 1 until 7) { if (vars[i] and vars[j] != 0) mask = mask or (1L shl maskBit); maskBit++ }
            for (i in 0 until 6) for (j in i + 1 until 7) {
                var k = j + 1
                while (k < 7) { if (vars[i] and vars[j] and vars[k] != 0) mask = mask or (1L shl maskBit); k++; maskBit++ }
            }
            val maskLow = mask and M32; val maskHigh = (mask ushr 32) and M32
            val parity = IntArray(matrix.size / 2) { parity32((matrix[2 * it] and maskLow) xor (matrix[2 * it + 1] and maskHigh)) }
            if (counter and 0x40 != 0) parity[41] = parity[41] xor 1
            if ((counter ushr 7) != 0) parity[40] = parity[40] xor 1
            var dataLow = counter.toLong() shl 24
            val dataHigh = ((serial shl 8) or button.toLong()) and M32
            for (i in 0 until 24) if (parity[i] != 0) dataLow = dataLow or (1L shl (23 - i))
            var k2 = 0L
            for (i in 24 until 42) if (parity[i] != 0) k2 = k2 or (1L shl (41 - i))
            return Pair((dataHigh shl 32) or dataLow, k2)
        }
        fun type13Valid(data: Long, key2: Long): Boolean {
            val button = ((data ushr 32) and 0xFF).toInt()
            val cs = checksum(data, key2)
            if (cs and 0x3F != 0x13) return false
            if ((key2 and 0x03) != (cs ushr 6).toLong()) return false
            return buttonValid(button)
        }

        /** -1 when the duration fits neither cell. */
        private fun classify(duration: Int, level: Boolean): Int {
            val lv = if (level) 1 else 0
            if (duration <= TE_SHORT_US - 1) {
                if (TE_SHORT_US - duration > TE_DELTA_US) return -1
                return (lv xor 1) shl 1
            }
            if (duration <= TE_LONG_US - 1) {
                val shortDelta = duration - TE_SHORT_US; val longInv = TE_LONG_US - duration
                if (shortDelta <= TE_DELTA_US) return if (longInv > TE_DELTA_US) (lv xor 1) shl 1 else (if (level) 4 else 6)
                if (longInv <= TE_DELTA_US) return if (level) 4 else 6
                return -1
            }
            if (duration - TE_LONG_US > TE_DELTA_US) return -1
            return if (level) 4 else 6
        }
    }

    private var packetBitCount = 0
    private var checkC1 = 0
    private var checkC2 = 0
    private var checkIc = 0
    private var key2 = 0L
    private var mState = 1
    private val decodedBits = IntArray(DECODED_BITS_MAX)
    private var decodedBitCount = 0   // uint8

    override fun reset() { parserStep = STEP_RESET; mState = 1; decodedBitCount = 0; key2 = 0 }

    private fun decodeCandidate() {
        val bitCount = decodedBitCount
        if (bitCount <= 0x51) return
        var preamble = 0
        while (preamble < bitCount && decodedBits[preamble] == 1) preamble++
        if (preamble <= 9) return
        if (((bitCount - preamble) and 0xFF) <= 0x51) return
        val p = preamble
        var d = 0L
        for (i in 0 until 64) d = (d shl 1) or (decodedBits[p + i] and 1).toLong()
        var k2 = 0L
        for (i in 0 until 18) k2 = (k2 shl 1) or (decodedBits[p + 64 + i] and 1).toLong()
        if (!type13Valid(d, k2)) { packetBitCount = 0; dataCountBit = 0; return }
        val (fs, fb, fc) = parseFields(d)
        data = d; decodeData = d; decodeCountBit = MIN_BITS
        packetBitCount = MIN_BITS; dataCountBit = MIN_BITS
        key2 = k2; serial = fs; btn = fb; cnt = fc.toLong()
        val cs = checksum(d, k2)
        checkC1 = if (cs and 0x3F == 0x13) 0 else 1
        checkC2 = if ((k2 and 0x03) == (cs ushr 6).toLong()) 0 else 1
        val rebuilt = buildKey(fs, fb, fc)
        checkIc = if (rebuilt.first == d && rebuilt.second == k2) 0 else 1
        emit()
    }

    override fun feed(level: Boolean, duration: Int) {
        if (parserStep == STEP_RESET) {
            if (level && duration >= SYNC_MIN_US) { parserStep = STEP_DATA; decodedBitCount = 0; mState = 1 }
            return
        }
        if (decodedBitCount > BIT_LIMIT) {
            decodeCandidate(); parserStep = STEP_RESET; return
        }
        val ev = classify(duration, level)
        if (ev < 0) {
            decodeCandidate()
            if (level && duration >= SYNC_MIN_US) { parserStep = STEP_DATA; decodedBitCount = 0; mState = 1 }
            else parserStep = STEP_RESET
            return
        }
        val state = mState and 0x03
        val next = (stateTable[state] ushr ev) and 0x03
        if (next == state) return   // the C keeps its state here (Flipper's manchester_advance would reset to Mid1)
        mState = next
        if (next == 1 || next == 2) {
            decodedBits[decodedBitCount] = if (next == 1) 1 else 0
            decodedBitCount = (decodedBitCount + 1) and 0xFF
        }
    }

    override fun describe(): PPHit =
        PPHit(name, packetBitCount, hx("%016X", data), serial, hx("%01X", btn.toLong()), cnt,
            listOf(MeshField("Key2", hx("%05X", key2)),
                MeshField("Button", buttonName(btn)),
                MeshField("C1", if (checkC1 != 0) "ERR" else "OK"),
                MeshField("C2", if (checkC2 != 0) "ERR" else "OK"),
                MeshField("IC", if (checkIc != 0) "ERR" else "OK")))

    /**
     * renault_v0.c get_string: "%s %ubit\r\n" then "Key:%016llX\r\nKey2:%05lX Sn:%06lX\r\nBtn:%01X [%s] Cnt:%02lX\r\n
     * C1:[%s] C2:[%s] IC:[%s]".
     */
    override fun cString(h: PPHit): String {
        val f = h.fields
        return "${h.name} ${h.bits}bit | Key:${h.key} | Key2:${f[0].value} " + hx("Sn:%06X", h.serial ?: 0) +
            " | Btn:${h.btn ?: ""} [${f[1].value}] " + hx("Cnt:%02X", h.cnt ?: 0) +
            " | C1:[${f[2].value}] C2:[${f[3].value}] IC:[${f[4].value}]"
    }
}
