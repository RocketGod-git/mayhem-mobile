package com.rocketgod.mayhem.core.apps.ism

/** Nexus-TH weather sensor (Mayhem fprotos/w-nexus-th.hpp). */
class WNexusTh : FProto(Fam.WEATHER, W.NEXUS_TH) {
    init { teShort = 490; teLong = 1980; teDelta = 150; minCountBitForFound = 36 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 8) < teDelta * 4) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(duration, teShort * 8) < teDelta * 4) {
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound && check()) { hit(); parserStep = STEP_CHECK }
                        decodeData = 0; decodeCountBit = 0
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 2) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 4) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        val type = ((decodeData ushr 8) and 0x0F).toInt()
        return type == CONST_DATA && (decodeData ushr 4) != 0xffffffffL
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2; private const val CONST_DATA = 0b1111 }
}
