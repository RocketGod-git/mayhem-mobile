package com.rocketgod.mayhem.core.apps.ism

/** Nero Sketch remotes (Mayhem fprotos/s-nero_sketch.hpp). */
class SNeroSketch : FProto(Fam.REMOTE, S.NERO_SKETCH) {
    init { teShort = 330; teLong = 660; teDelta = 150; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULA -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta || dd(duration, teShort * 4) < teDelta) teLast = duration
                    else parserStep = STEP_RESET
                } else if (dd(duration, teShort) < teDelta) {
                    if (dd(teLast, teShort) < teDelta) { headerCount++; return }  // Found header
                    else if (dd(teLast, teShort * 4) < teDelta) {
                        // Found start bit
                        if (headerCount > 40) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> {
                if (level) {
                    if (duration >= teShort * 2 + teDelta * 2) {
                        // Found stop bit
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
