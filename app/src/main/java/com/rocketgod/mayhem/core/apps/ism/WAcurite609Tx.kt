package com.rocketgod.mayhem.core.apps.ism

/** Acurite 609TXC temperature/humidity sensor (Mayhem fprotos/w-acurite609tx.hpp). */
class WAcurite609Tx : FProto(Fam.WEATHER, W.ACURITE_609TX) {
    init { teShort = 500; teLong = 1000; teDelta = 150; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 17) < teDelta * 8) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teShort) < teDelta || duration > teLong * 3) {
                            parserStep = STEP_RESET
                            if (decodeCountBit == minCountBitForFound && check()) hit()
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
        if (decodeData == 0L) return false
        val crc = (((decodeData ushr 32) and 0xff) + ((decodeData ushr 24) and 0xff) + ((decodeData ushr 16) and 0xff) + ((decodeData ushr 8) and 0xff)).toInt() and 0xff
        return crc == (decodeData and 0xff).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
