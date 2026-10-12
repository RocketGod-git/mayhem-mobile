package com.rocketgod.mayhem.core.apps.ism

/** Linear MegaCode remotes (Mayhem fprotos/s-megacode.hpp). */
class SMegacode : FProto(Fam.REMOTE, S.MEGACODE) {
    init { teShort = 1000; teLong = 1000; teDelta = 200; minCountBitForFound = 24 }

    private var lastBit = 0

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 13) < teDelta * 17) parserStep = STEP_FOUND_START_BIT  // 10..16ms
            STEP_FOUND_START_BIT -> {
                if (level && dd(duration, teShort) < teDelta) {
                    // Found start bit MegaCode
                    parserStep = STEP_SAVE
                    decodeData = 0; decodeCountBit = 0
                    addBit(1)
                    lastBit = 1
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> {
                if (!level) {
                    if (duration >= teShort * 10) {
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    teLast = if (lastBit == 0) duration - teShort * 3 else duration
                    parserStep = STEP_CHECK
                } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (level) {
                    if (dd(teLast, teShort * 5) < teDelta * 5 && dd(duration, teShort) < teDelta) { addBit(1); lastBit = 1; parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort * 2) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(0); lastBit = 0; parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
