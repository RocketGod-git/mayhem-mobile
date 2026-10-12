package com.rocketgod.mayhem.core.apps.ism

/** Legrand remotes (Mayhem fprotos/s-legrand.hpp). */
class SLegrand : FProto(Fam.REMOTE, S.LEGRAND) {
    init { teShort = 375; teLong = 1125; teDelta = 150; minCountBitForFound = 18 }

    private var te = 0

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 16) < teDelta * 8) { parserStep = STEP_FIRST_BIT; decodeData = 0; decodeCountBit = 0; te = 0 }
            STEP_FIRST_BIT -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) {
                        addBit(0)
                        te += duration * 4 // long low that is part of sync, then short high
                    }
                    if (dd(duration, teLong) < teDelta * 3) {
                        addBit(1)
                        te += duration / 3 * 4 // short low that is part of sync, then long high
                    }
                    if (decodeCountBit > 0) {
                        // advance to the next step if either short or long is found
                        parserStep = STEP_SAVE_DURATION
                        return
                    }
                }
                parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (!level) {
                    teLast = duration
                    te += duration
                    parserStep = STEP_CHECK_DURATION
                    return
                }
                parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (level) {
                    var found = false
                    if (dd(teLast, teLong) < teDelta * 3 && dd(duration, teShort) < teDelta) { found = true; addBit(0) }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { found = true; addBit(1) }
                    if (found) {
                        te += duration
                        if (decodeCountBit < minCountBitForFound) { parserStep = STEP_SAVE_DURATION; return }
                        // enough bits for a packet found
                        te /= decodeCountBit * 4
                        dataCountBit = decodeCountBit
                        hit()
                        // fallthrough to reset, the next bit is expected to be a sync
                    }
                }
                parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FIRST_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
