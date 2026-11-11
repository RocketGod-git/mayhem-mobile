// Port of ProtoPirate protocols/ford_v3.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Ford V3: FM, 240 / 480 µs, 13 bytes (104 bits) read two ways at once: a Manchester path after 30+ short
 * preamble pulses (the EU layout, counter sent inverted) and a cell path that splits every pulse into 240 µs cells
 * and pairs them (the US layout, header byte FF). A frame identical to the last one shown is not shown again.
 */
class PPFordV3 : PPDecoder("Ford V3", PPModulation.FM, PPConst(240, 480, 60, 104)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_DATA = 2
        private const val DATA_BITS = 104; private const val DATA_BYTES = 13; private const val PREAMBLE_MIN = 30
        private const val CELL_CAP = 320; private const val CELL_MIN = 200; private const val CELL_MIN_BITS = 100
        private const val BTN_LOCK = 0x01; private const val BTN_UNLOCK = 0x02
        private const val VARIANT_EU = 0; private const val VARIANT_US = 1
        /** subghz_protocol_ford_v3_cell_const: the same timings with a 120 µs tolerance. */
        private const val CELL_DELTA = 120

        // The C has separate US and EU tables; they are identical.
        private fun buttonName(b: Int): String = when (b) { BTN_LOCK -> "Lock"; BTN_UNLOCK -> "Unlock"; else -> "?" }

        private fun cellFrameValid(raw: IntArray): Boolean {
            if (raw[0] != 0xFF) return false
            val s = (raw[1].toLong() shl 24) or (raw[2].toLong() shl 16) or (raw[3].toLong() shl 8) or raw[4].toLong()
            if (s == 0L || s == M32) return false
            if (raw[6] != BTN_LOCK && raw[6] != BTN_UNLOCK) return false
            if (raw[5] and 0x80 == 0) return false
            return true
        }

        private fun cellDecode(cells: IntArray, cellCount: Int): IntArray? {
            for (phase in 0 until 2) {
                val frame = IntArray(13)
                var bitCount = 0
                var ok = true
                var i = phase
                while (i + 1 < cellCount && bitCount < DATA_BITS) {
                    val first = cells[i]; val second = cells[i + 1]
                    if (first == second) { ok = false; break }
                    if (first != 0) frame[bitCount shr 3] = frame[bitCount shr 3] or (1 shl (7 - (bitCount and 7)))
                    bitCount++
                    i += 2
                }
                if (!ok || bitCount < CELL_MIN_BITS) continue
                if (!cellFrameValid(frame)) continue
                return frame
            }
            return null
        }
    }

    private var manchesterRaw = IntArray(13)
    private var manchesterBitCount = 0
    private var preambleCount = 0   // uint16
    private val cells = IntArray(CELL_CAP)
    private var cellCount = 0
    private var rawBytes = IntArray(13)
    private var lastRawBytes = IntArray(13)
    private var lastRawValid = false
    private var variant = 0
    private var flag = 0
    private var fSerial = 0L
    private var counter = 0

    private fun resetManchester() {
        manchesterRaw = IntArray(13); manchesterBitCount = 0; preambleCount = 0
        manchesterAdvance(PPManchester.RESET)
    }

    override fun reset() {
        parserStep = STEP_RESET; resetManchester(); cellCount = 0; lastRawValid = false
    }

    private fun addManchesterBit(bit: Int) {
        if (manchesterBitCount >= DATA_BITS) return
        val byteIndex = manchesterBitCount / 8; val bitInByte = 7 - manchesterBitCount % 8
        if (bit != 0) manchesterRaw[byteIndex] = manchesterRaw[byteIndex] or (1 shl bitInByte)
        manchesterBitCount++
    }

    private fun parseFields() {
        val b = rawBytes
        fSerial = (b[1].toLong() shl 24) or (b[2].toLong() shl 16) or (b[3].toLong() shl 8) or b[4].toLong()
        serial = fSerial
        if (variant == VARIANT_US) {
            flag = b[5]; counter = (b[7] shl 8) or b[8]; btn = b[6]
        } else {
            flag = 0; counter = ((b[7].inv() and 0xFF) shl 8) or (b[8].inv() and 0xFF)
            btn = if (b[6] and 0x01 != 0) BTN_UNLOCK else BTN_LOCK
        }
        cnt = counter.toLong()
    }

    private fun commitFrame(raw: IntArray, v: Int) {
        if (lastRawValid && lastRawBytes.contentEquals(raw)) return
        rawBytes = raw.copyOf(); lastRawBytes = raw.copyOf(); lastRawValid = true
        variant = v; dataCountBit = DATA_BITS
        parseFields()
        emit()
    }

    private fun manchesterEmitIfReady() {
        if (manchesterBitCount < DATA_BITS) return
        commitFrame(manchesterRaw, VARIANT_EU)
    }

    private fun cellProcess() {
        if (cellCount < CELL_MIN) return
        val raw = cellDecode(cells, cellCount) ?: return
        commitFrame(raw, VARIANT_US)
    }

    private fun cellFeed(level: Boolean, duration: Int) {
        if (dd(duration, c.teShort) < CELL_DELTA) {
            if (cellCount < CELL_CAP) { cells[cellCount] = if (level) 1 else 0; cellCount++ }
        } else if (dd(duration, c.teLong) < CELL_DELTA) {
            if (cellCount + 2 <= CELL_CAP) {
                cells[cellCount] = if (level) 1 else 0; cellCount++
                cells[cellCount] = if (level) 1 else 0; cellCount++
            }
        } else {
            cellProcess()
            cellCount = 0
        }
    }

    private fun manchesterFeed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (isShort(duration)) { resetManchester(); preambleCount = 1; parserStep = STEP_PREAMBLE }
            STEP_PREAMBLE -> {
                if (isShort(duration)) {
                    preambleCount = (preambleCount + 1) and 0xFFFF
                } else if (preambleCount >= PREAMBLE_MIN && isLong(duration)) {
                    manchester = PPManchester.MID1
                    val bit = manchesterAdvance(if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW)
                    if (bit >= 0) addManchesterBit(bit)
                    parserStep = STEP_DATA
                } else {
                    parserStep = STEP_RESET
                }
            }
            STEP_DATA -> {
                if (!isShort(duration) && !isLong(duration)) {
                    manchesterEmitIfReady()
                    parserStep = STEP_RESET
                    // The C then re-checks pp_is_short here, which can never be true: dead code, left out.
                    return
                }
                val event = if (level) (if (isShort(duration)) PPManchester.SHORT_HIGH else PPManchester.LONG_HIGH)
                else (if (isShort(duration)) PPManchester.SHORT_LOW else PPManchester.LONG_LOW)
                val bit = manchesterAdvance(event)
                if (bit >= 0) {
                    addManchesterBit(bit)
                    if (manchesterBitCount >= DATA_BITS) { manchesterEmitIfReady(); parserStep = STEP_RESET }
                }
            }
        }
    }

    override fun feed(level: Boolean, duration: Int) {
        cellFeed(level, duration)
        manchesterFeed(level, duration)
    }

    override fun describe(): PPHit {
        val k = rawBytes
        val us = variant == VARIANT_US
        return PPHit(name, dataCountBit, k.joinToString("") { hx("%02X", it.toLong()) }, serial,
            hx("%02X ", btn.toLong()) + buttonName(btn), counter.toLong(),
            listOf(MeshField("Variant", if (us) "US" else "EU"),
                MeshField("Hop", (9..12).joinToString("") { hx("%02X", k[it].toLong()) })))
    }

    /** ford_v3.c get_string: "%s[ US] %dbit\r\nKey:%02X x13\r\nSn:%08lX Btn:%02X %s\r\nCnt:%04X Hop:%02X x4\r\n". */
    override fun cString(h: PPHit): String {
        val us = h.field("Variant") == "US"
        return "${h.name}${if (us) " US" else ""} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%08X", h.serial ?: 0) +
            " Btn:${h.btn ?: ""} | " + hx("Cnt:%04X", h.cnt ?: 0) + " Hop:${h.field("Hop")}"
    }
}
