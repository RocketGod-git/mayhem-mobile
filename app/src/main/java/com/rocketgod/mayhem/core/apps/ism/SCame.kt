package com.rocketgod.mayhem.core.apps.ism

/** CAME remotes; switches to PRASTEL / AIRFORCE by bit count (Mayhem fprotos/s-came.hpp). */
class SCame : FProto(Fam.REMOTE, S.CAME) {
    init { teShort = 320; teLong = 640; teDelta = 150; minCountBitForFound = 12 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 56) < teDelta * 47) parserStep = STEP_FOUND
            STEP_FOUND -> if (level) {
                if (dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_SAVE -> if (!level) {
                if (duration >= teShort * 4) {
                    parserStep = STEP_FOUND
                    if (decodeCountBit == minCountBitForFound || decodeCountBit == AIRFORCE_COUNT_BIT ||
                        decodeCountBit == PRASTEL_COUNT_BIT || decodeCountBit == CAME_24_COUNT_BIT) {
                        dataCountBit = decodeCountBit
                        sensorType = S.CAME
                        if (decodeCountBit == PRASTEL_COUNT_BIT) sensorType = S.PRASTEL
                        if (decodeCountBit == AIRFORCE_COUNT_BIT) sensorType = S.AIRFORCE
                        hit()
                    }
                    return
                }
                teLast = duration
                parserStep = STEP_CHECK
            } else parserStep = STEP_RESET
            STEP_CHECK -> if (level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object {
        private const val CAME_24_COUNT_BIT = 24; private const val PRASTEL_COUNT_BIT = 25; private const val AIRFORCE_COUNT_BIT = 18
        private const val STEP_RESET = 0; private const val STEP_FOUND = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
    }
}
