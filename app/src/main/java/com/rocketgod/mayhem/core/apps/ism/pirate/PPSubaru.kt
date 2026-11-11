// Port of ProtoPirate protocols/subaru.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

/**
 * Subaru: AM, 800 / 1600 µs PWM after a long-pair preamble and a 2800 µs gap + sync, 64 bits: button nibble, 24-bit
 * serial, and a 16-bit counter scrambled through the serial (unscrambled here exactly as the C does).
 */
class PPSubaru : PPDecoder("Subaru", PPModulation.AM, PPConst(800, 1600, 200, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_FOUND_GAP = 2
        private const val STEP_FOUND_SYNC = 3; private const val STEP_SAVE_DURATION = 4
        private const val GAP_US = 2800; private const val SYNC_US = 2800

        fun buttonName(b: Int): String = arrayOf("Lock", "Unlock", "Trunk", "Panic")[b and 0x03]

        /** Result of subaru_decode_fields_exact. */
        class Fields(val serial: Long, val btn: Int, val cnt: Int, val valid: Boolean)

        /** subaru_decode_fields_exact (its validity result is computed and ignored, as in the C). */
        fun decodeFields(kb: IntArray): Fields {
            val b0 = kb[0]; val b1 = kb[1]; val b2 = kb[2]; val b3 = kb[3]; val b4 = kb[4]; val b5 = kb[5]; val b6 = kb[6]; val b7 = kb[7]
            val btn = b0 and 0x0F
            val serial = (b1.toLong() shl 16) or (b2.toLong() shl 8) or b3.toLong()
            var lo = 0
            if (b4 and 0x40 == 0) lo = lo or 0x01
            if (b4 and 0x80 == 0) lo = lo or 0x02
            if (b5 and 0x01 == 0) lo = lo or 0x04
            if (b5 and 0x02 == 0) lo = lo or 0x08
            if (b6 and 0x01 == 0) lo = lo or 0x10
            if (b6 and 0x02 == 0) lo = lo or 0x20
            if (b5 and 0x40 == 0) lo = lo or 0x40
            if (b5 and 0x80 == 0) lo = lo or 0x80
            val regSh1 = ((b7 and 0x0F) shl 4) or (b5 and 0x0C) or ((b6 ushr 6) and 0x03)
            val regSh2 = ((b6 and 0x3C) shl 2) or ((b7 ushr 4) and 0x0F)
            // rotateLeft3 over (ser0, ser1, ser2) = (b3, b1, b2)
            var ser0 = b3; var ser1 = b1; var ser2 = b2
            repeat(4 + lo) {
                val t = ser0
                ser0 = ((ser0 shl 1) or (ser1 ushr 7)) and 0xFF
                ser1 = ((ser1 shl 1) or (ser2 ushr 7)) and 0xFF
                ser2 = ((ser2 shl 1) or (t ushr 7)) and 0xFF
            }
            val t1 = ser1 xor regSh1; val t2 = ser2 xor regSh2
            var hi = 0
            if (t1 and 0x10 == 0) hi = hi or 0x04
            if (t1 and 0x20 == 0) hi = hi or 0x08
            if (t2 and 0x80 == 0) hi = hi or 0x02
            if (t2 and 0x40 == 0) hi = hi or 0x01
            if (t1 and 0x01 == 0) hi = hi or 0x40
            if (t1 and 0x02 == 0) hi = hi or 0x80
            if (t2 and 0x08 == 0) hi = hi or 0x20
            if (t2 and 0x04 == 0) hi = hi or 0x10
            val local34 = ser0
            val x1 = b1 xor regSh1; val x2 = b2 xor regSh2
            val rhi = hi.inv() and 0xFF
            val nlo = lo.inv()   // C int promotion: ~lo is a negative int
            val e1 = ((x1 xor ((rhi shl 2) and 0xFF)) and 0x30) or ((x1 xor (rhi ushr 6)) and 0x03) or ((x1 xor ((nlo shl 2) and 0xFF)) and 0xCC)
            val e2 = ((x2 xor (rhi ushr 2)) and 0x0C) or ((x2 xor ((rhi shl 6) and 0xFF)) and 0xC0) or ((x2 xor ((nlo shr 2) and 0xFF)) and 0x33)
            val valid = ((b1 xor e1) or (b2 xor e2)) == 0 && (b0 xor local34) == lo
            return Fields(serial, btn, (hi shl 8) or lo, valid)
        }
    }

    private var key = 0L
    private var sSerial = 0L
    private var sBtn = 0
    private var sCnt = 0

    override fun feed(level: Boolean, duration: Int) {
        val teShort = c.teShort; val teLong = c.teLong; val teDelta = c.teDelta
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teLong) < teDelta) {
                decodeData = 0; decodeCountBit = 0; headerCount = 0; teLast = duration
                parserStep = STEP_CHECK_PREAMBLE
            }
            STEP_CHECK_PREAMBLE -> {
                if (level) return
                if (dd(duration, teLong) < teDelta && dd(teLast, teLong) < teDelta) { headerCount++; return }
                if (headerCount >= 0x15 && dd(duration, GAP_US) < 800) { teLast = duration; parserStep = STEP_FOUND_GAP }
                else parserStep = STEP_RESET
            }
            STEP_FOUND_GAP -> if (level && dd(duration, SYNC_US) < 800 && dd(teLast, GAP_US) < 800) parserStep = STEP_FOUND_SYNC
                else parserStep = STEP_RESET
            STEP_FOUND_SYNC -> if (!level && (dd(duration, teLong) < teDelta || dd(duration, teShort) < teDelta)) {
                teLast = duration; parserStep = STEP_SAVE_DURATION
            } else parserStep = STEP_RESET
            STEP_SAVE_DURATION -> {
                var nextStep = STEP_RESET
                var bit = 0; var valid = false
                if (level) {
                    if (dd(duration, teLong) < teDelta) {
                        if (dd(teLast, teShort) < teDelta) { bit = 0; valid = true }
                    } else if (dd(duration, teShort) < teDelta) {
                        if (dd(teLast, teLong) < teDelta) { bit = 1; valid = true }
                    }
                    if (valid) { addBit(bit); nextStep = STEP_FOUND_SYNC }
                }
                parserStep = nextStep
                if (decodeCountBit in 64..80) {
                    dataCountBit = decodeCountBit
                    data = decodeData
                    // subaru_process_data
                    key = decodeData
                    val f = decodeFields(PPMath.u64ToBytesBE(decodeData))
                    sSerial = f.serial; sBtn = f.btn; sCnt = f.cnt
                    serial = sSerial; btn = sBtn; cnt = sCnt.toLong()
                    emit()
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                }
            }
        }
    }

    override fun describe(): PPHit {
        val f = decodeFields(PPMath.u64ToBytesBE(data))
        sSerial = f.serial; sBtn = f.btn; sCnt = f.cnt
        key = data; serial = sSerial; btn = sBtn; cnt = sCnt.toLong()
        return PPHit(name, dataCountBit, hx("%016X", data), sSerial, hx("%01X [", sBtn.toLong()) + buttonName(sBtn) + "]", sCnt.toLong(), emptyList())
    }

    /** subaru.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%06lX Btn:%01X [%s]\r\nCnt:%04lX". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%06X", h.serial ?: 0) + " Btn:${h.btn ?: ""}" +
            " | " + hx("Cnt:%04X", h.cnt ?: 0)
}
