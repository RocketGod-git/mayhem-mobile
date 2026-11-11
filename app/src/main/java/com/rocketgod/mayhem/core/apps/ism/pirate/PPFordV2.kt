// Port of ProtoPirate protocols/ford_v2.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Ford V2: FM, Manchester at 200 / 400 µs (wide 260 µs tolerance) after 64+ short preamble pulses; the inverted
 * 16-bit sync 7F A7 opens 13 bytes (104 bits): serial, button, a 16-bit counter spread over bytes 7..9, and a 31-bit
 * tail. A frame is shown only when its structure checks out.
 */
class PPFordV2 : PPDecoder("Ford V2", PPModulation.FM, PPConst(200, 400, 260, 104)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_SYNC = 2; private const val STEP_DATA = 3
        private const val INTER_BURST_GAP = 15000; private const val PREAMBLE_MIN = 64; private const val DATA_BITS = 104; private const val DATA_BYTES = 13
        private const val SYNC0 = 0x7F; private const val SYNC1 = 0xA7
        private const val SYNC_BITS = 16; private const val POST_SYNC_DECODE_COUNT_BIT = 16; private const val PREAMBLE_COUNT_MAX = 0xFFFF
        private const val SYNC_SHIFT16_INV = ((SYNC0 shl 8) or SYNC1).inv() and 0xFFFF

        private fun buttonIsValid(b: Int) = b in intArrayOf(0x10, 0x11, 0x13, 0x14, 0x15)

        private fun buttonName(b: Int): String = when (b) {
            0x10 -> "Lock"; 0x11 -> "Unlock"; 0x13 -> "Trunk"; 0x14 -> "Panic"
            0x15 -> "RemoteStart"; else -> "Unknown"
        }
    }

    private var preambleCount = 0   // uint16
    private var rawBytes = IntArray(13)
    private var byteCount = 0
    private var syncShift = 0       // uint16
    private var syncBitCount = 0
    private var extraData = 0L
    private var counter16 = 0
    private var tail31 = 0L
    private var structureOk = false

    private fun resetState() {
        parserStep = STEP_RESET; decodeData = 0; decodeCountBit = 0; teLast = 0
        byteCount = 0; syncShift = 0; syncBitCount = 0; preambleCount = 0; counter16 = 0; tail31 = 0; structureOk = false
        rawBytes = IntArray(13)
        manchesterAdvance(PPManchester.RESET)
    }

    override fun reset() { resetState() }

    private fun extractFromRaw() {
        val k = rawBytes
        serial = (k[2].toLong() shl 24) or (k[3].toLong() shl 16) or (k[4].toLong() shl 8) or k[5].toLong()
        btn = k[6]
        counter16 = (((k[7] and 0x7F) shl 9) or (k[8] shl 1) or (k[9] ushr 7)) and 0xFFFF
        cnt = counter16.toLong()
        tail31 = ((k[9] and 0x7F).toLong() shl 24) or (k[10].toLong() shl 16) or (k[11].toLong() shl 8) or k[12].toLong()
        structureOk = true
        if (k[0] != SYNC0) structureOk = false
        if (k[1] != SYNC1) structureOk = false
        if (!buttonIsValid(k[6])) structureOk = false
        if ((k[7] and 0x7F) != ((counter16 ushr 9) and 0x7F)) structureOk = false
        if (k[8] != ((counter16 ushr 1) and 0xFF)) structureOk = false
        if (((k[9] ushr 7) and 1) != (counter16 and 1)) structureOk = false
        data = 0
        for (i in 0 until 8) data = (data shl 8) or k[i].toLong()
        dataCountBit = DATA_BITS
        extraData = 0
        for (i in 0 until 5) extraData = (extraData shl 8) or k[8 + i].toLong()
    }

    private fun commitFrame(): Boolean {
        if (rawBytes[0] != SYNC0 || rawBytes[1] != SYNC1) return false
        extractFromRaw()
        if (!structureOk) return false
        emit()
        return true
    }

    private fun syncEnterData() {
        rawBytes = IntArray(13)
        rawBytes[0] = SYNC0; rawBytes[1] = SYNC1
        byteCount = 2; parserStep = STEP_DATA; decodeData = 0; decodeCountBit = POST_SYNC_DECODE_COUNT_BIT
    }

    private fun syncFeedEvent(e: Int): Boolean {
        val bit = manchesterAdvance(e)
        if (bit < 0) return false
        syncShift = ((syncShift shl 1) or bit) and 0xFFFF
        if (syncBitCount < SYNC_BITS) syncBitCount++
        return syncBitCount >= SYNC_BITS && syncShift == SYNC_SHIFT16_INV
    }

    private fun manchesterFeedEvent(e: Int) {
        if (parserStep == STEP_SYNC) {
            if (syncFeedEvent(e)) syncEnterData()
            return
        }
        val b = manchesterAdvance(e)
        if (b < 0) return
        if (parserStep != STEP_DATA) return
        val bit = b xor 1
        decodeData = (decodeData shl 1) or bit.toLong()
        decodeCountBit = (decodeCountBit + 1) and 0xFF   // uint8_t decode_count_bit
        if (decodeCountBit and 7 == 0) {
            val v = (decodeData and 0xFF).toInt()
            if (byteCount < DATA_BYTES) { rawBytes[byteCount] = v; byteCount++ }
            decodeData = 0
            if (byteCount == DATA_BYTES) { commitFrame(); resetState() }
        }
    }

    private fun manchesterFeedPulse(level: Boolean, duration: Int): Boolean {
        if (isShort(duration)) { manchesterFeedEvent(if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW); return true }
        if (isLong(duration)) { manchesterFeedEvent(if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW); return true }
        return false
    }

    private fun enterSyncFromPreamble(level: Boolean, duration: Int) {
        parserStep = STEP_SYNC; decodeData = 0; decodeCountBit = 0; byteCount = 0; syncShift = 0; syncBitCount = 0
        rawBytes = IntArray(13)
        manchesterAdvance(PPManchester.RESET)
        if (isShort(duration)) {
            val ev = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
            if (ev == PPManchester.SHORT_LOW || ev == PPManchester.LONG_LOW) manchester = PPManchester.MID0
            manchesterFeedEvent(ev)
        } else if (isLong(duration)) {
            val ev = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
            if (ev == PPManchester.SHORT_LOW || ev == PPManchester.LONG_LOW) manchester = PPManchester.MID0
            manchesterFeedEvent(ev)
        } else resetState()
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (isShort(duration)) { preambleCount = 1; parserStep = STEP_PREAMBLE }
            STEP_PREAMBLE -> {
                if (isShort(duration)) {
                    if (preambleCount < PREAMBLE_COUNT_MAX) preambleCount++
                } else if (!level && isLong(duration)) {
                    if (preambleCount >= PREAMBLE_MIN) enterSyncFromPreamble(level, duration) else resetState()
                } else resetState()
            }
            STEP_SYNC, STEP_DATA -> {
                if (!manchesterFeedPulse(level, duration)) {
                    // Every branch of the C resets here (the gap checks only differ in their break).
                    resetState()
                    return
                }
                teLast = duration
            }
        }
    }

    override fun describe(): PPHit {
        val k = rawBytes
        val key = (2..12).joinToString("") { hx("%02X", k[it].toLong()) }
        return PPHit(name, dataCountBit, key, serial, hx("%02X [", btn.toLong()) + buttonName(btn) + "]", counter16.toLong(),
            listOf(MeshField("Struct", if (structureOk) "OK" else "BAD"),
                MeshField("Tail31", hx("%08X", tail31)),
                MeshField("TailRaw", (8..12).joinToString("") { hx("%02X", k[it].toLong()) })))
    }

    /**
     * ford_v2.c get_string: "%s %dbit\r\nKey:%02X x11\r\nSn:%08lX Btn:%02X [%s]\r\nCnt:%u Struct:%s\r\nTail31:%08lX\r\n
     * TailRaw:%02X x5\r\n".
     */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%08X", h.serial ?: 0) + " Btn:${h.btn ?: ""}" +
            " | Cnt:${h.cnt ?: 0} Struct:${h.field("Struct")} | Tail31:${h.field("Tail31")} | TailRaw:${h.field("TailRaw")}"
}
