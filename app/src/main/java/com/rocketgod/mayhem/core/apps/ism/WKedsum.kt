package com.rocketgod.mayhem.core.apps.ism

/** Kedsum TH weather sensor (Mayhem fprotos/w-kedsum.hpp). */
class WKedsum : FProto(Fam.WEATHER, W.KEDSUM) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 42 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBLE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 4) < teDelta * 4) headerCount++ // Found preambule
                    else if (dd(teLast, teShort) < teDelta && duration < (teLong * 2 + teDelta * 2)) {
                        // Found syncPrefix
                        if (headerCount > 0) {
                            parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0
                            if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                            else if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 2) < teDelta * 4) { addBit(1); parserStep = STEP_SAVE }
                            else parserStep = STEP_RESET
                        }
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(duration, teLong * 4) < teDelta * 4) {
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
            ((decodeData ushr 24) and 0xff).toInt(),
            ((decodeData ushr 16) and 0xff).toInt(),
            ((decodeData ushr 8) and 0xff).toInt(),
            (decodeData and 0xff).toInt())
        var crc = FG.crc4(msg, 4, 0x03, 0) // CRC-4 poly 0x3 init 0x0 xor last 4 bits
        crc = crc xor (msg[4] ushr 4)      // last nibble is only XORed
        return crc == (msg[4] and 0x0F)
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
