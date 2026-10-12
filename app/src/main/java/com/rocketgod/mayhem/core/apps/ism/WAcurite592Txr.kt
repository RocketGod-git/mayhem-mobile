package com.rocketgod.mayhem.core.apps.ism

/** Acurite 592TXR weather sensor (Mayhem fprotos/w-acurite592txr.hpp). */
class WAcurite592Txr : FProto(Fam.WEATHER, W.ACURITE_592TXR) {
    init { teShort = 200; teLong = 400; teDelta = 90; minCountBitForFound = 56 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 3) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBULE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 3) < teDelta * 2 && dd(duration, teShort * 3) < teDelta * 2) headerCount++
                    else if (headerCount > 2 && headerCount < 5) {
                        if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { decodeData = 0; decodeCountBit = 0; addBit(0); parserStep = STEP_SAVE }
                        else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { decodeData = 0; decodeCountBit = 0; addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teShort * 5) {
                        if (decodeCountBit == minCountBitForFound && checkCrc()) hit()
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                        return
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        val msg = intArrayOf(
            ((decodeData ushr 48) and 0xff).toInt(), ((decodeData ushr 40) and 0xff).toInt(), ((decodeData ushr 32) and 0xff).toInt(),
            ((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt(), ((decodeData ushr 8) and 0xff).toInt())
        return FG.addBytes(msg, 6) == (decodeData and 0xff).toInt() && FG.parityBytes(msg.copyOfRange(2, 6), 4) == 0
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
