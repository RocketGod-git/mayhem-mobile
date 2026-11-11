// Port of ProtoPirate protocols/kia_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V0: FM, PWM at 250 / 500 µs after a short-pair preamble. One decoder covers four families: Kia (61 bits,
 * CRC-8 poly 0x7F), Mitsubishi (the same frame repeated after a 72..88 pair preamble), Suzuki (64 bits, ended by two
 * ~2 ms gaps, CRC over shifted words) and Honda (61 wire bits, bit-reversed bytes, a table CRC; shown as 72 bits).
 */
class PPKiaV0 : PPDecoder("Kia V0", PPModulation.FM, PPConst(250, 500, 100, 61)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
        private const val TYPE_KIA = 1; private const val TYPE_SUZUKI = 2; private const val TYPE_HONDA = 3; private const val TYPE_MITSU = 4
        private const val BITS_KIA = 61; private const val BITS_SUZUKI = 64; private const val BITS_HONDA = 72
        private const val MITSU_PREAMBLE_MIN = 72; private const val MITSU_PREAMBLE_MAX = 88
        private val hondaCrcTable = intArrayOf(0x4A, 0x25, 0x96, 0x4B, 0xA1, 0xD4, 0x6A, 0x35,
            0x9E, 0x4F, 0xA3, 0xD5, 0xEE, 0x77, 0xBF, 0xDB)
        private val hondaButtonNames = arrayOf("Unlock", "Trunk", "Lock2", "Unlock2", "Trunk2", "Unlock3", "Trunk3")

        // ---- helpers ----
        private fun isKiaGap(d: Int) = d >= 700 && d - 700 <= 1000
        private fun isSuzukiGapStrict(d: Int) = d >= 2000 && d - 2000 <= 500
        private fun crc8poly(b: IntArray) = PPMath.crc8(b, 0x7F, 0x00)

        private fun suzukiShiftedCrcValid(key: Long): Boolean {
            val lo = key and M32; val hi = (key ushr 32) and M32
            val r3 = ((lo ushr 16) or (hi shl 16)) and M32 and 0x0FFFFFFFL
            val r2 = (lo ushr 12) and 0x0F
            var r1 = (hi ushr 12) and 0xFFFF
            val r4 = ((lo ushr 4) and 0xFF).toInt()
            r1 = ((r1 and 0xFF) shl 8) or ((r1 ushr 8) and 0xFF)
            val buf = intArrayOf((r1 and 0xFF).toInt(), ((r1 ushr 8) and 0xFF).toInt(), ((r3 ushr 20) and 0xFF).toInt(),
                ((r3 ushr 12) and 0xFF).toInt(), ((r3 ushr 4) and 0xFF).toInt(), (((r3 shl 4) or (r2 and 0x0F)) and 0xFF).toInt())
            return crc8poly(buf) == r4
        }

        private fun suzukiResolveShifted(d: Long): Long? {
            if (suzukiShiftedCrcValid(d)) return d
            val w = d shl 1
            if (suzukiShiftedCrcValid(w)) return w
            return null
        }

        private fun calculateCrcPoly(d: Long): Int =
            crc8poly(intArrayOf(48, 40, 32, 24, 16, 8).map { ((d ushr it) and 0xFF).toInt() }.toIntArray())
        private fun verifyCrcPoly(d: Long): Boolean = calculateCrcPoly(d) == (d and 0xFF).toInt()

        private fun hondaTransform(d: Long): Long = PPMath.bytesToU64BE(PPMath.u64ToBytesBE(d).map { PPMath.reverseBits8(it) }.toIntArray())

        private fun familyCrc(counter: Int, serial: Long, button: Int): Int {
            val b = intArrayOf((counter ushr 8) and 0xFF, counter and 0xFF,
                ((serial ushr 20) and 0xFF).toInt(), ((serial ushr 12) and 0xFF).toInt(),
                ((serial ushr 4) and 0xFF).toInt(), (((serial and 0x0F) shl 4) or (button and 0x0F).toLong()).toInt() and 0xFF)
            return PPMath.xorBytes(b)
        }

        private fun hondaCrc(header: Int, counter: Int): Int {
            var v = 0
            for (i in hondaCrcTable.indices) if ((counter ushr i) and 1 != 0) v = v xor hondaCrcTable[i]
            v = v xor when (header) { 0xAA -> 0xA5; 0x2A -> 0x21; 0x6A -> 0x15; 0xFA -> 0x73; else -> 0xC6 }
            return v
        }

        private fun hondaKeyValid(k: Long): Boolean = (k ushr 60) == 0x0FL && ((k ushr 56) and 0x0F) == 0L && ((k ushr 8) and 0x0F) == 0x0AL

        private fun protocolName(t: Int): String = when (t) { TYPE_SUZUKI -> "Suzuki V0"; TYPE_HONDA -> "Honda V0"; TYPE_MITSU -> "Mitsubishi V0"; else -> "Kia V0" }

        private fun buttonName(b: Int, t: Int): String {
            if (t == TYPE_HONDA) return if (b >= 1 && b <= hondaButtonNames.size) hondaButtonNames[b - 1] else "??"
            if (t == TYPE_SUZUKI) return when (b) { 3 -> "Lock"; 4 -> "Unlock"; 2 -> "Trunk"; else -> "??" }
            return when (b) { 1 -> "Lock"; 2 -> "Unlock"; 3 -> "Trunk"; else -> "??" }
        }
    }

    private class Fields { var serial = 0L; var counter = 0; var button = 0; var crc = 0; var type = 0; var crcValid = false }

    private var packetBitCount = 0
    private var preamblePairs = 0
    private var type = 0
    private var lastKiaData = 0L
    private var haveLastKia = false

    /** kia_v0_parse_data: fills the fields, the generic serial/cnt/btn and the bit count. */
    private fun parseData(): Fields {
        val f = Fields()
        val t = type
        if (t == TYPE_HONDA) {
            val b = PPMath.u64ToBytesBE(data)
            f.type = t
            f.serial = (b[3].toLong() shl 16) or (b[4].toLong() shl 8) or b[5].toLong()
            f.counter = (PPMath.reverseBits8(b[1]) shl 8) or PPMath.reverseBits8(b[2])
            f.button = b[6] ushr 5
            f.crc = b[7]
            f.crcValid = hondaCrc(b[6], f.counter) == f.crc
            dataCountBit = BITS_HONDA
        } else {
            val suz = t == TYPE_SUZUKI
            f.type = t
            f.serial = (data ushr (if (suz) 16 else 12)) and 0x0FFFFFFF
            f.button = ((data ushr (if (suz) 12 else 8)) and 0x0F).toInt()
            f.counter = ((data ushr (if (suz) 44 else 40)) and 0xFFFF).toInt()
            f.crc = (if (suz) (data ushr 4) and 0xFF else data and 0xFF).toInt()
            f.crcValid = if (suz) suzukiShiftedCrcValid(data) else familyCrc(f.counter, f.serial, f.button) == f.crc
            dataCountBit = if (suz) BITS_SUZUKI else BITS_KIA
            if (t == TYPE_KIA || t == TYPE_MITSU) f.crcValid = verifyCrcPoly(data)
        }
        serial = f.serial; cnt = f.counter.toLong(); btn = f.button
        packetBitCount = dataCountBit
        return f
    }

    private fun stateClear() { parserStep = STEP_RESET; teLast = 0; decodeData = 0; decodeCountBit = 0; preamblePairs = 0 }

    private fun commit(d: Long, t: Int, bits: Int) {
        type = t; packetBitCount = bits; data = d; dataCountBit = bits
        parseData()
        emit()
        stateClear()
    }

    private fun finishKiaOrHondaAtGap() {
        if (decodeCountBit != BITS_KIA) { stateClear(); return }
        val d = decodeData
        if (verifyCrcPoly(d)) {
            var t = TYPE_KIA
            if (haveLastKia && lastKiaData == d && preamblePairs >= MITSU_PREAMBLE_MIN && preamblePairs <= MITSU_PREAMBLE_MAX) t = TYPE_MITSU
            lastKiaData = d; haveLastKia = true
            commit(d, t, BITS_KIA)
            return
        }
        val key = hondaTransform(d and 0x0FFFFFFFFFFFFFFFL)
        if (hondaKeyValid(key)) { commit(key, TYPE_HONDA, BITS_HONDA); return }
        stateClear()
    }

    private fun tryHonda(): Boolean {
        if (decodeCountBit != BITS_KIA) return false
        if (verifyCrcPoly(decodeData)) return false
        val key = hondaTransform(decodeData and 0x0FFFFFFFFFFFFFFFL)
        if (!hondaKeyValid(key)) return false
        commit(key, TYPE_HONDA, BITS_HONDA)
        return true
    }

    override fun reset() { stateClear(); type = 0; haveLastKia = false; lastKiaData = 0 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                stateClear()
                if (!level) return
                if (!isShort(duration)) return
                parserStep = STEP_PREAMBLE; teLast = duration; preamblePairs = 0
            }
            STEP_PREAMBLE -> if (level) {
                if (isShort(duration) || isLong(duration)) teLast = duration else stateClear()
            } else if (isShort(duration) && isShort(teLast)) {
                preamblePairs++
            } else if (isLong(duration) && isLong(teLast)) {
                if (preamblePairs > 14) {
                    decodeData = 0; decodeCountBit = 0
                    addBit(1); addBit(1)
                    parserStep = STEP_SAVE_DURATION
                } else stateClear()
            } else stateClear()
            STEP_SAVE_DURATION -> {
                if (!level) { stateClear(); return }
                if (isKiaGap(duration)) { finishKiaOrHondaAtGap(); return }
                if (isSuzukiGapStrict(duration) && isSuzukiGapStrict(teLast)) {
                    val s = if (decodeCountBit == BITS_SUZUKI) suzukiResolveShifted(decodeData) else null
                    if (s != null) commit(s, TYPE_SUZUKI, BITS_SUZUKI) else stateClear()
                    return
                }
                if (isShort(duration) || isLong(duration)) { teLast = duration; parserStep = STEP_CHECK_DURATION } else stateClear()
            }
            STEP_CHECK_DURATION -> {
                if (level) { stateClear(); return }
                if (isShort(teLast) && isShort(duration)) {
                    addBit(0)
                    if (!tryHonda()) parserStep = STEP_SAVE_DURATION
                    return
                }
                if (isLong(teLast) && isLong(duration)) {
                    addBit(1)
                    if (!tryHonda()) parserStep = STEP_SAVE_DURATION
                    return
                }
                if (isSuzukiGapStrict(duration)) { teLast = duration; parserStep = STEP_SAVE_DURATION; return }
                if (!tryHonda()) stateClear()
            }
            else -> stateClear()
        }
    }

    override fun describe(): PPHit {
        val f = parseData()
        val honda = type == TYPE_HONDA
        return PPHit(protocolName(type), packetBitCount, hx("%016X", data),
            f.serial, hx("%01X [", f.button.toLong()) + buttonName(f.button, type) + "]", f.counter.toLong(),
            listOf(MeshField("Sn", hx(if (honda) "%06X" else "%07X", f.serial)),
                MeshField("CRC", hx("%02X [", f.crc.toLong()) + (if (f.crcValid) "OK" else "ERR") + "]")))
    }

    /**
     * kia_v0.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%07lX Btn:%01X [%s]\r\nCnt:%04X CRC:%02X [%s]\r\n"
     * (Sn:%06lX for Honda).
     */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Sn:${h.fields[0].value} Btn:${h.btn ?: ""} | " +
            hx("Cnt:%04X", h.cnt ?: 0) + " CRC:${h.fields[1].value}"
}
