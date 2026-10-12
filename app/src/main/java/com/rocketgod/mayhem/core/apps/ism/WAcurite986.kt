package com.rocketgod.mayhem.core.apps.ism

/** Acurite 986 fridge/freezer sensor (Mayhem fprotos/w-acurite986.hpp). */
class WAcurite986 : FProto(Fam.WEATHER, W.ACURITE_986) {
    init { teShort = 800; teLong = 1750; teDelta = 50; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong) < teDelta * 15) { parserStep = STEP_SYNC1; decodeData = 0; decodeCountBit = 0 }
            STEP_SYNC1 -> if (dd(duration, teLong) < teDelta * 15) { if (!level) parserStep = STEP_SYNC2 } else parserStep = STEP_RESET
            STEP_SYNC2 -> if (dd(duration, teLong) < teDelta * 15) { if (!level) parserStep = STEP_SYNC3 } else parserStep = STEP_RESET
            STEP_SYNC3 -> if (dd(duration, teLong) < teDelta * 15) { if (!level) parserStep = STEP_SAVE } else parserStep = STEP_RESET
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta * 10) {
                        if (duration < teShort) { addBit(0); parserStep = STEP_SAVE }
                        else { addBit(1); parserStep = STEP_SAVE }
                    } else {
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound && check()) hit()
                        decodeData = 0; decodeCountBit = 0
                    }
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        if (decodeData == 0L) return false
        val msg = intArrayOf(((decodeData ushr 32) and 0xff).toInt(), ((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt(), ((decodeData ushr 8) and 0xff).toInt())
        val crc = FG.crc8(msg, 4, 0x07, 0x00)
        return crc == (decodeData and 0xff).toInt()
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SYNC1 = 1; private const val STEP_SYNC2 = 2; private const val STEP_SYNC3 = 3
        private const val STEP_SAVE = 4; private const val STEP_CHECK = 5
    }
}
