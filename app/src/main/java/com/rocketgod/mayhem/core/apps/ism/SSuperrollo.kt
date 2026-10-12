package com.rocketgod.mayhem.core.apps.ism

/** Superrollo GW60 (HCS361) 67-bit OOK remotes (Mayhem fprotos/s-superrollo.hpp). */
class SSuperrollo : FProto(Fam.REMOTE, S.SUPERROLLO) {
    init { teShort = 450; teLong = 900; teDelta = 200; minCountBitForFound = 64 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) { headerCount++; parserStep = STEP_PREAMBLE_LOW }
                    else if (headerCount >= 4 && dd(duration, teShort * 10) < teDelta * 10) parserStep = STEP_SYNC_LOW
                    else headerCount = 0
                } else headerCount = 0
            }
            STEP_PREAMBLE_LOW -> if (!level && dd(duration, teLong) < teDelta) parserStep = STEP_RESET else { parserStep = STEP_RESET; headerCount = 0 }
            STEP_SYNC_LOW -> if (!level && dd(duration, teShort * 10) < teDelta * 10) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 } else { parserStep = STEP_RESET; headerCount = 0 }
            STEP_SAVE -> {
                if (level) { teLast = duration; parserStep = STEP_CHECK }
                else if (duration >= teShort * 12) endFrame()
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) {
                        if (decodeCountBit < minCountBitForFound) addBit(1) else decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) {
                        if (decodeCountBit < minCountBitForFound) addBit(0) else decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (duration >= teShort * 12) endFrame()
                    else { parserStep = STEP_RESET; headerCount = 0 }
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
        }
    }

    private fun endFrame() {
        if (decodeCountBit >= minCountBitForFound && decodeCountBit <= minCountBitForFound + 3) { dataCountBit = minCountBitForFound; hit() }
        parserStep = STEP_RESET
        decodeData = 0; decodeCountBit = 0
        headerCount = 0
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_PREAMBLE_LOW = 1; private const val STEP_SYNC_LOW = 2; private const val STEP_SAVE = 3; private const val STEP_CHECK = 4 }
}
