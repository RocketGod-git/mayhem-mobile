package com.rocketgod.mayhem.core.apps.ism

/** Vauno EN8822C weather sensor (Mayhem fprotos/w-vauno_en8822.hpp). */
class WVaunoEn8822 : FProto(Fam.WEATHER, W.VAUNO_EN8822) {
    init { teShort = 500; teLong = 1940; teDelta = 150; minCountBitForFound = 42 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 4) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teLong * 2) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                        else if (dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                        else if (dd(duration, teLong * 4) < teDelta) {
                            parserStep = STEP_RESET
                            if (decodeCountBit == minCountBitForFound && check()) hit()
                            else if (decodeCountBit == 1) parserStep = STEP_SAVE
                            decodeData = 0; decodeCountBit = 0
                        } else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        if (decodeData == 0L) return false
        // The sum of all nibbles should match the last 6 bits
        var sum = 0
        for (i in 6..38 step 4) sum = (sum + ((decodeData ushr i) and 0x0f).toInt()) and 0xff
        return sum != 0 && (sum and 0x3f) == (decodeData and 0x3f).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
