package com.rocketgod.mayhem.core.apps.ism

/** TX-8300 weather sensor (Mayhem fprotos/w-tx8300.hpp). */
class WTx8300 : FProto(Fam.WEATHER, W.TX_8300) {
    init { teShort = 1940; teLong = 3880; teDelta = 250; minCountBitForFound = 72 }

    private var package1 = 0L
    private var package2 = 0L

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 2) < teDelta) parserStep = STEP_CHECK_PREAMBLE
            STEP_CHECK_PREAMBLE -> {
                if (!level && (dd(duration, teShort * 2) < teDelta || dd(duration, teShort * 3) < teDelta)) {
                    parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 1; package1 = 0; package2 = 0
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teShort * 5) {
                        // Found syncPostfix
                        if (decodeCountBit == minCountBitForFound && checkCrc()) { decodeData = package1; hit() }
                        decodeData = 0; decodeCountBit = 1; parserStep = STEP_RESET
                        return
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET

                    if (decodeCountBit == PACKAGE_SIZE) { package1 = decodeData and 0xFFFFFFFFL; decodeData = 0 }
                    else if (decodeCountBit == PACKAGE_SIZE * 2) { package2 = decodeData and 0xFFFFFFFFL; decodeData = 0 }
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        if (package2 == 0L) return false
        if (package1 != (package2.inv() and 0xFFFFFFFFL)) return false
        var x = 0
        var y = 0
        for (i in 0 until 32 step 4) {
            x += ((package1 ushr i) and 0x0F).toInt()
            y += ((package1 ushr i) and 0x05).toInt()
        }
        val crc = (((x.inv() and 0xF) shl 4) or (y.inv() and 0xF)) and 0xff
        return crc == (decodeData and 0xFF).toInt()
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private const val PACKAGE_SIZE = 32
    }
}
