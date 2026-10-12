package com.rocketgod.mayhem.core.apps.ism

/** Acurite 5-in-1 weather station (Mayhem fprotos/w-acurite5in1.hpp). */
class WAcurite5in1 : FProto(Fam.WEATHER, W.ACURITE_5IN1) {
    init { teShort = 200; teLong = 400; teDelta = 90; minCountBitForFound = 64 }

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
                        if (decodeCountBit == minCountBitForFound && checkCrc() && checkMessageType()) hit()
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

    private fun checkMessageType(): Boolean = ((decodeData ushr 40) and 0x3F).toInt() == 0x38

    private fun checkCrc(): Boolean {
        val msg = intArrayOf(
            ((decodeData ushr 56) and 0xff).toInt(), ((decodeData ushr 48) and 0xff).toInt(), ((decodeData ushr 40) and 0xff).toInt(),
            ((decodeData ushr 32) and 0xff).toInt(), ((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt(),
            ((decodeData ushr 8) and 0xff).toInt())
        return FG.addBytes(msg, 7) == (decodeData and 0xff).toInt() && FG.parityBytes(msg.copyOfRange(2, 7), 5) == 0
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
