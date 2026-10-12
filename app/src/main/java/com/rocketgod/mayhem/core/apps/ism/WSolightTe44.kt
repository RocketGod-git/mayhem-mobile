package com.rocketgod.mayhem.core.apps.ism

/** Solight TE44 weather sensor (Mayhem fprotos/w-solight_te44.hpp). */
class WSolightTe44 : FProto(Fam.WEATHER, W.SOLIGHT_TE44) {
    init { teShort = 490; teLong = 3000; teDelta = 150; minCountBitForFound = 36 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && duration >= teLong) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) {
                        if (decodeCountBit == minCountBitForFound && check()) hit()
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teShort * 2) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                        else if (dd(duration, teShort * 4) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        if (((decodeData ushr 8) and 0x0f) != 0x0fL) return false // const not 1111
        // Rubicson CRC check
        val msg = intArrayOf(
            ((decodeData ushr 28) and 0xff).toInt(),
            ((decodeData ushr 20) and 0xff).toInt(),
            ((decodeData ushr 12) and 0xff).toInt(),
            0xf0,
            ((decodeData and 0xf0) or (decodeData and 0x0f)).toInt())
        return FG.crc8(msg, 5, 0x31, 0x6c) == 0
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
