// Port of ProtoPirate protocols/renault_v1.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Renault V1 (Hitag2): a 1500 µs low / 1000 µs high sync, then inverted Manchester at ~125 µs with adaptive short/long
 * thresholds (one per level); a 16-bit header (must read 1), 64 bits (32-bit UID, 4-bit button, 10-bit counter, the
 * top of a 32-bit hop), and a 24-bit Key2 (rest of the hop, 2 tail bits, an XOR byte). ProtoPirate registers it on
 * both the AM and FM routes (by preset modulation); it is listed here as AM. The live decoder never has a Hitag2 key
 * or a brute-forced seed, so it always shows Cnt/Hop and KEY:??, as the C does.
 */
class PPRenaultV1 : PPDecoder("Renault V1", PPModulation.AM, PPConst(125, 250, 50, 88)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_SYNC = 2; private const val STEP_DATA = 3
        private const val HEADER_BITS = 16; private const val KEY_END_BITS = 80; private const val LONG_FRAME_BITS = 104; private const val MIN_COUNT_BIT = 88
        private const val HEADER_LOW_MIN = 1150; private const val HEADER_LOW_MAX = 2200; private const val HEADER_HIGH_MIN = 800; private const val HEADER_HIGH_MAX = 1150
        private const val DATA_IGNORE_US = 49; private const val DATA_RESET_US = 520; private const val TE_HIGH_INIT = 120; private const val TE_LOW_INIT = 150
        private val buttonNames = arrayOf("Sync", "Lock", "Unlock", "??", "Trunk", "??", "??", "??", "Panic")

        fun buttonName(b: Int): String = if (b < buttonNames.size) buttonNames[b] else "??"

        private fun packKeyBytes(key: Long, key2: Long): IntArray =
            PPMath.u64ToBytesBE(key) + intArrayOf(((key2 ushr 16) and 0xFF).toInt(), ((key2 ushr 8) and 0xFF).toInt(), (key2 and 0xFF).toInt())
        private fun frameXor(raw: IntArray): Int { var v = 0; for (i in 0 until 10) v = v xor raw[i]; return v }

        private fun dataThreshold(te: Int): Int {
            val triple = te * 3
            if (triple < 300) return 150
            if (triple >= 422) return 210
            return triple / 2
        }
        private fun adaptTe(te: Int, duration: Int): Int {
            val mixed = te * 7 + duration
            if (mixed < 560) return 70
            if (mixed >= 1488) return 185
            return (mixed / 8) and 0xFFFF
        }
        private fun isHeaderLow(d: Int) = d >= HEADER_LOW_MIN && d <= HEADER_LOW_MAX
    }

    private var teHigh = 0
    private var teLow = 0
    private var header = 0
    private var hop = 0L
    private var tailBits = 0
    private var lastData = 0L
    private var lastData2 = 0L
    private var lastFrameValid = false
    private var data2 = 0L

    init { manchester = PPManchester.START1 }   // calloc'd state

    override fun reset() {
        parserStep = STEP_RESET
        manchesterAdvance(PPManchester.RESET)
    }

    /** hitag2_unpack_frame (recovered = 0, so the counter is the frame's 10-bit counter). */
    private fun unpack() {
        val raw = packKeyBytes(data, data2)
        serial = (data ushr 32) and M32
        btn = (raw[4] ushr 4) and 0x0F
        cnt = (((raw[4] and 0x0F) shl 6) or (raw[5] ushr 2)).toLong()
        hop = ((raw[5] and 3).toLong() shl 30) or (raw[6].toLong() shl 22) or (raw[7].toLong() shl 14) or (raw[8].toLong() shl 6) or (raw[9] ushr 2).toLong()
        tailBits = raw[9] and 3
    }

    private fun acceptFrame(key2: Long): Boolean {
        if (header != 1) return false
        val raw = packKeyBytes(data, key2)
        if (frameXor(raw) != raw[10]) return false
        if (lastFrameValid && lastData == data && lastData2 == key2) return false
        data2 = key2
        dataCountBit = MIN_COUNT_BIT
        unpack()
        lastData = data; lastData2 = key2; lastFrameValid = true
        return true
    }

    override fun feed(level: Boolean, duration: Int) {
        while (true) {
            when (parserStep) {
                STEP_RESET -> {
                    if (!level && isHeaderLow(duration)) { teLast = duration; parserStep = STEP_CHECK_SYNC }
                    return
                }
                STEP_CHECK_SYNC -> {
                    if (level) {
                        if (duration < HEADER_HIGH_MIN || duration > HEADER_HIGH_MAX || teLast < HEADER_LOW_MIN || teLast > HEADER_LOW_MAX) {
                            parserStep = STEP_RESET
                            return
                        }
                        decodeData = 0; decodeCountBit = 0
                        manchester = PPManchester.START1
                        teHigh = TE_HIGH_INIT; teLow = TE_LOW_INIT
                        parserStep = STEP_DATA
                        return
                    }
                    parserStep = STEP_RESET
                    if (isHeaderLow(duration)) { teLast = duration; parserStep = STEP_CHECK_SYNC }
                    return
                }
                STEP_DATA -> {
                    if (duration <= DATA_IGNORE_US) return
                    if (duration > DATA_RESET_US) { parserStep = STEP_RESET; continue }
                    val te = if (level) teHigh else teLow
                    val event: Int
                    if (duration > dataThreshold(te)) {
                        event = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
                    } else {
                        event = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
                        if (level) teHigh = adaptTe(te, duration) else teLow = adaptTe(te, duration)
                    }
                    val bit = manchesterAdvance(event)
                    if (bit < 0) return
                    decodeData = (decodeData shl 1) or bit.toLong()
                    decodeCountBit++
                    if (decodeCountBit == HEADER_BITS) {
                        header = (decodeData.inv() and 0xFFFF).toInt()
                        decodeData = 0
                        return
                    }
                    if (decodeCountBit == KEY_END_BITS) {
                        data = decodeData.inv()
                        decodeData = 0
                        return
                    }
                    if (decodeCountBit == LONG_FRAME_BITS) {
                        val key2 = decodeData.inv() and 0xFFFFFF
                        if (acceptFrame(key2)) emit()
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_DATA
                    }
                    return
                }
                else -> {
                    parserStep = STEP_RESET
                    return
                }
            }
        }
    }

    override fun describe(): PPHit {
        unpack()   // get_string runs renault_v1_check_remote_controller first
        return PPHit(name, dataCountBit, hx("%016X", data), serial, hx("%02X", btn.toLong()), cnt,
            listOf(MeshField("K2", hx("%06X", data2 and 0xFFFFFF)),
                MeshField("Button", buttonName(btn)),
                MeshField("Hop", hx("%08X", hop)),
                MeshField("Tail", "$tailBits"),
                MeshField("KEY", "??")))
    }

    /**
     * renault_v1.c get_string (recovered = 0, no Hitag2 key): "%s\r\nK1:%016llX\r\nK2:%06llX Sn:%08lX\r\n
     * Btn:%02X [%s] %db" then "\r\nCnt:%03lX Hop:%08lX" and "\r\nKEY:??".
     */
    override fun cString(h: PPHit): String {
        val f = h.fields
        return "${h.name} | K1:${h.key} | K2:${f[0].value} " + hx("Sn:%08X", h.serial ?: 0) +
            " | Btn:${h.btn ?: ""} [${f[1].value}] ${h.bits}b | " + hx("Cnt:%03X", (h.cnt ?: 0) and 0x3FF) +
            " Hop:${f[2].value} | KEY:${f[4].value}"
    }
}
