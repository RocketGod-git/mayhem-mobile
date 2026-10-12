package com.rocketgod.mayhem.core.apps.ism

/** ThermoPro TX4 weather sensor (Mayhem fprotos/w-thermoprotx4.hpp). */
class WThermoproTx4 : FProto(Fam.WEATHER, W.THERMOPRO_TX4) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 37 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 18) < teDelta * 10) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 } // Found sync
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(duration, teShort * 18) < teDelta * 10) {
                        // Found sync
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound && check()) { hit(); parserStep = STEP_CHECK }
                        decodeData = 0; decodeCountBit = 0
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 2) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        val type = ((decodeData ushr 33) and 0xff).toInt()
        return type == TYPE_1 || type == TYPE_2
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2; private const val TYPE_1 = 0b1001; private const val TYPE_2 = 0b0110 }
}
