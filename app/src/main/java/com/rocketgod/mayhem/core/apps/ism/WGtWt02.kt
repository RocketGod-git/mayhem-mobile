package com.rocketgod.mayhem.core.apps.ism

/** Globaltronics GT-WT-02 temperature/humidity sensor (Mayhem fprotos/w-gt-wt-02.hpp). */
class WGtWt02 : FProto(Fam.WEATHER, W.GT_WT02) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 37 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 18) < teDelta * 8) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teShort * 18) < teDelta * 8) {
                            parserStep = STEP_RESET
                            if (decodeCountBit == minCountBitForFound && check()) hit()
                            else if (decodeCountBit == 1) parserStep = STEP_SAVE
                            decodeData = 0; decodeCountBit = 0
                        } else if (dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                        else if (dd(duration, teLong * 2) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        if (decodeData == 0L) return false
        var sum = ((decodeData ushr 5) and 0xe).toInt()
        val tempData = decodeData ushr 9
        for (i in 0 until 7) sum = (sum + ((tempData ushr (i * 4)) and 0xF).toInt()) and 0xff
        return (decodeData and 0x3F).toInt() == (sum and 0x3F)
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
