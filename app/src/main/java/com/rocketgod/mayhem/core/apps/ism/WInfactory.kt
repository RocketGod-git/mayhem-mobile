package com.rocketgod.mayhem.core.apps.ism

/** inFactory weather sensor (Mayhem fprotos/w-infactory.hpp). */
class WInfactory : FProto(Fam.WEATHER, W.INFACTORY) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 2) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBLE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 2) < teDelta * 2 && dd(duration, teShort * 2) < teDelta * 2) headerCount++ // Found preambule
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 16) < teDelta * 8) {
                        // Found syncPrefix
                        if (headerCount > 3) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teShort * 30) {
                        // Found syncPostfix
                        if (decodeCountBit == minCountBitForFound && checkCrc()) hit()
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 2) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        val msg = intArrayOf(
            ((decodeData ushr 32) and 0xff).toInt(),
            ((((decodeData ushr 24) and 0x0F) or ((decodeData and 0x0F) shl 4)) and 0xff).toInt(),
            ((decodeData ushr 16) and 0xff).toInt(),
            ((decodeData ushr 8) and 0xff).toInt(),
            (decodeData and 0xff).toInt())
        var crc = FG.crc4(msg, 4, 0x13, 0) // Koopmann 0x9, CCITT-4; FP-4; ITU-T G.704
        crc = crc xor (msg[4] ushr 4)      // last nibble is only XORed
        return crc == ((decodeData ushr 28) and 0x0F).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
