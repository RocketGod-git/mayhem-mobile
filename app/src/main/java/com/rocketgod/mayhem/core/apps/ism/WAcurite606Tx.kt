package com.rocketgod.mayhem.core.apps.ism

/** Acurite 606TX temperature sensor (Mayhem fprotos/w-acurite606tx.hpp). */
class WAcurite606Tx : FProto(Fam.WEATHER, W.ACURITE_606TX) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 32 }

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
        val msg = intArrayOf(((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt(), ((decodeData ushr 8) and 0xff).toInt())
        val crc = FG.lfsrDigest8(msg, 3, 0x98, 0xF1)
        return crc == (decodeData and 0xff).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
