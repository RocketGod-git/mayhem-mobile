package com.rocketgod.mayhem.core.apps.ism

/** Magellan alarm sensors (Mayhem fprotos/s-magellan.hpp). */
class SMagellan : FProto(Fam.REMOTE, S.MAGELLAN) {
    init { teShort = 200; teLong = 400; teDelta = 100; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULA -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) headerCount++
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2 && headerCount > 10) parserStep = STEP_FOUND_PREAMBULA
                    else parserStep = STEP_RESET
                }
            }
            STEP_FOUND_PREAMBULA -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 6) < teDelta * 3 && dd(duration, teLong) < teDelta * 2) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                    else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (duration >= teLong * 3) {
                        // Found stop bit
                        if (decodeCountBit == minCountBitForFound && checkCrc()) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        val data = intArrayOf(((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt(), ((decodeData ushr 8) and 0xff).toInt())
        return (decodeData and 0xff).toInt() == crc8(data, data.size)
    }

    private fun crc8(data: IntArray, len: Int): Int {
        var crc = 0
        for (i in 0 until len) {
            crc = crc xor data[i]
            for (j in 0 until 8) crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x31) and 0xff else (crc shl 1) and 0xff
        }
        return crc
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_FOUND_PREAMBULA = 2
        private const val STEP_SAVE = 3; private const val STEP_CHECK = 4
    }
}
