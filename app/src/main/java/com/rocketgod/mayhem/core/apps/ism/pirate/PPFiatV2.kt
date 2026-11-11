// Port of ProtoPirate protocols/fiat_v2.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Fiat V2: AM, Manchester cells at 210 / 420 µs in a sliding 224-cell window; 112 wire bits = 14 bytes: 00 01, a
 * 32-bit UID, a type nibble, the button byte (top two bits select the button), an inverted counter, and a 32-bit hop
 * (its position depends on whether the frame is the FCA type, nibble D).
 */
class PPFiatV2 : PPDecoder("Fiat V2", PPModulation.AM, PPConst(210, 420, 100, 112)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_DATA = 1
        private const val WIRE_BITS = 112; private const val WIRE_BYTES = 14; private const val WIRE_CELLS = 224; private const val LOGICAL_BITS = 112
        private const val BOUNDARY_MIN_US = 900

        fun buttonValid(b: Int): Boolean { val s = b ushr 6; return s == 0x2 || s == 0x3 || s == 0x1 }
        fun buttonName(b: Int): String = when (b ushr 6) { 0x2 -> "Lock"; 0x3 -> "Unlock"; 0x1 -> "Trunk"; else -> "Unknown" }
        fun uid(r: IntArray): Long = (r[2].toLong() shl 24) or (r[3].toLong() shl 16) or (r[4].toLong() shl 8) or r[5].toLong()
        fun isFca(r: IntArray): Boolean = r[6] and 0xF0 == 0xD0
        fun hop(r: IntArray): Long {
            if (isFca(r)) return (r[10].toLong() shl 24) or (r[11].toLong() shl 16) or (r[12].toLong() shl 8) or r[13].toLong()
            return (r[9].toLong() shl 24) or (r[10].toLong() shl 16) or (r[11].toLong() shl 8) or r[12].toLong()
        }
        fun counter(r: IntArray): Long {
            if (isFca(r)) { val raw = (r[8].toLong() shl 6) or (r[9] ushr 2).toLong(); return raw.inv() and 0x3FFF }
            val raw = ((r[7] and 0x3F).toLong() shl 5) or (r[8] ushr 3).toLong()
            return raw.inv() and 0x7FF
        }
        fun frameValid(r: IntArray): Boolean {
            if (r[0] != 0x00 || r[1] != 0x01) return false
            if (!buttonValid(r[7])) return false
            val u = uid(r)
            return u != 0L && u != M32
        }
    }

    private val cells = IntArray(WIRE_CELLS)
    private var cellCount = 0
    private var rawData = IntArray(14)
    private var lastRawData = IntArray(14)
    private var lastRawValid = false
    private var uid = 0L
    private var hop = 0L
    private var button = 0

    init { reset() }

    override fun reset() {
        rawData = IntArray(14); lastRawData = rawData.copyOf()
        parserStep = STEP_RESET; decodeData = 0; decodeCountBit = 0
        lastRawValid = false
        data = 0; dataCountBit = 0; serial = 0; btn = 0; cnt = 0
        uid = 0; hop = 0; button = 0
        clearCells()
    }

    private fun clearCells() { cellCount = 0; cells.fill(0) }

    private fun decodeFields() {
        uid = uid(rawData)
        button = rawData[7]
        hop = hop(rawData)
        serial = uid; btn = button; cnt = counter(rawData)
        data = (serial shl 32) or hop
        dataCountBit = LOGICAL_BITS
        decodeData = data; decodeCountBit = dataCountBit
    }

    private fun commit(raw: IntArray): Boolean {
        if (!frameValid(raw)) return false
        if (lastRawValid && lastRawData.contentEquals(raw)) return true
        rawData = raw.copyOf(); lastRawData = raw.copyOf(); lastRawValid = true
        decodeFields()
        emit()
        return true
    }

    private fun tryDecodeWindow(invert: Boolean): Boolean {
        if (cellCount != WIRE_CELLS) return false
        val raw = IntArray(WIRE_BYTES)
        for (bi in 0 until WIRE_BITS) {
            val first = cells[bi * 2]; val second = cells[bi * 2 + 1]
            if (first == second) return false
            var bit = first != 0
            if (invert) bit = !bit
            if (bit) raw[bi shr 3] = raw[bi shr 3] or (1 shl (7 - (bi and 7)))
        }
        return commit(raw)
    }

    private fun pushCell(level: Boolean) {
        if (cellCount < WIRE_CELLS) { cells[cellCount] = if (level) 1 else 0; cellCount++ }
        else { System.arraycopy(cells, 1, cells, 0, WIRE_CELLS - 1); cells[WIRE_CELLS - 1] = if (level) 1 else 0 }
        if (!tryDecodeWindow(false)) tryDecodeWindow(true)
    }

    private fun feedDataPulse(level: Boolean, duration: Int): Boolean {
        if (isShort(duration)) { pushCell(level); return true }
        if (isLong(duration)) { pushCell(level); pushCell(level); return true }
        if (!level && duration >= BOUNDARY_MIN_US) pushCell(false)
        clearCells()
        return false
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (isShort(duration) || isLong(duration)) {
                clearCells()
                parserStep = STEP_DATA
                feedDataPulse(level, duration)
            }
            STEP_DATA -> if (!feedDataPulse(level, duration)) parserStep = STEP_RESET
        }
    }

    override fun describe(): PPHit =
        PPHit(name, LOGICAL_BITS, rawData.joinToString("") { hx("%02X", it.toLong()) }, uid, hx("%02X", button.toLong()), cnt,
            listOf(MeshField("Hop", hx("%08X", hop)),
                MeshField("Type", hx("%01X", (rawData[6] ushr 4).toLong())),
                MeshField("Button", buttonName(button))))

    /** fiat_v2.c get_string: "%s %ubit\r\nUID:%08lX\r\nHop:%08lX Type:%01X\r\nBtn:%02X [%s] Cnt:%02lX\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | " + hx("UID:%08X", h.serial ?: 0) + " | Hop:${h.fields[0].value} Type:${h.fields[1].value}" +
            " | Btn:${h.btn ?: ""} [${h.fields[2].value}] " + hx("Cnt:%02X", h.cnt ?: 0)
}
