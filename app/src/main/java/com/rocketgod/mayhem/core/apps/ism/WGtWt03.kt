package com.rocketgod.mayhem.core.apps.ism

/** Globaltronics GT-WT-03 temperature/humidity sensor (Mayhem fprotos/w-gt-wt-03.hpp). */
class WGtWt03 : FProto(Fam.WEATHER, W.GT_WT03) {
    init { teShort = 285; teLong = 570; teDelta = 120; minCountBitForFound = 41 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 3) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBULE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 3) < teDelta * 2 && dd(duration, teShort * 3) < teDelta * 2) headerCount++
                    else if (headerCount == 4) {
                        if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { decodeData = 0; decodeCountBit = 0; addBit(0); parserStep = STEP_SAVE }
                        else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { decodeData = 0; decodeCountBit = 0; addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort * 3) < teDelta * 2 && dd(duration, teShort * 3) < teDelta * 2) {
                        if (decodeCountBit == minCountBitForFound && checkCrc()) hit()
                        decodeData = 0; decodeCountBit = 0
                        headerCount = 1
                        parserStep = STEP_CHECK_PREAMBULE
                        return
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        val msg = intArrayOf(((decodeData ushr 33) and 0xff).toInt(), ((decodeData ushr 25) and 0xff).toInt(), ((decodeData ushr 17) and 0xff).toInt(), ((decodeData ushr 9) and 0xff).toInt())
        var sum = 0
        for (k in msg.indices) {
            val data = msg[k]
            var key = 0x3100
            for (i in 7 downTo 0) {
                if ((data ushr i) and 1 != 0) sum = sum xor (key and 0xff)
                key = key ushr 1
            }
        }
        return (sum xor ((decodeData ushr 1) and 0xFF).toInt()) == 0x2D
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
