package com.rocketgod.mayhem.core.apps.ism

/** Auriol AHFL temperature/humidity sensor (Mayhem fprotos/w-auriol-ahfl.hpp). */
class WAuriolAhfl : FProto(Fam.WEATHER, W.AURIOL_AHFL) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 42 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 18) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teShort * 18) < teDelta * 8) {
                            parserStep = STEP_RESET
                            if (decodeCountBit == minCountBitForFound && check()) hit()
                            else if (decodeCountBit == 1) parserStep = STEP_SAVE
                            decodeData = 0; decodeCountBit = 0
                        } else if (dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                        else if (dd(duration, teLong * 2) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        val type = ((decodeData ushr 6) and 0x0F).toInt()
        if (type != CONST_DATA) return false
        val payload = decodeData ushr 6
        val checksumReceived = (decodeData and 0x3F).toInt()
        var checksumCalculated = 0
        for (i in 0 until 9) checksumCalculated = (checksumCalculated + ((payload ushr (i * 4)) and 0xF).toInt()) and 0xff
        return checksumReceived == checksumCalculated
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2; private const val CONST_DATA = 0b0100 }
}
