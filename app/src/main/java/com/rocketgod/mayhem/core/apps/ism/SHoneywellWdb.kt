package com.rocketgod.mayhem.core.apps.ism

/** Honeywell WDB wireless doorbells (Mayhem fprotos/s-honeywellwdb.hpp). */
class SHoneywellWdb : FProto(Fam.REMOTE, S.HONEYWELL_WDB) {
    init { teShort = 160; teLong = 320; teDelta = 61; minCountBitForFound = 48 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 3) < teDelta) { decodeCountBit = 0; decodeData = 0; parserStep = STEP_SAVE_DURATION }
            STEP_SAVE_DURATION -> {
                if (level) {
                    if (dd(duration, teShort * 3) < teDelta) {
                        if (decodeCountBit == minCountBitForFound &&
                            (decodeData and 0x01L).toInt() == FG.parity(decodeData ushr 1, minCountBitForFound - 1)) {
                            dataCountBit = decodeCountBit
                            hit()
                        }
                        parserStep = STEP_RESET
                        return
                    }
                    teLast = duration
                    parserStep = STEP_CHECK_DURATION
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
