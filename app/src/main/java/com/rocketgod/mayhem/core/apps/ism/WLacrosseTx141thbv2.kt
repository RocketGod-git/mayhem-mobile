package com.rocketgod.mayhem.core.apps.ism

/** LaCrosse TX141TH-Bv2 weather sensor (Mayhem fprotos/w-lacrosse-tx141thbv2.hpp). */
class WLacrosseTx141thbv2 : FProto(Fam.WEATHER, W.LACROSSE_TX141THBV2) {
    init { teShort = 208; teLong = 417; teDelta = 120; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 4) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBLE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 4) < teDelta * 2 && dd(duration, teShort * 4) < teDelta * 2) headerCount++ // Found preambule
                    else if (headerCount == 4) {
                        if (tryAddBit(teLast, duration)) { decodeData = decodeData and 1; decodeCountBit = 1; parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort * 3) < teDelta * 2 && dd(duration, teShort * 4) < teDelta * 2) {
                        if (decodeCountBit == minCountBitForFound || decodeCountBit == BIT_COUNT) {
                            if (checkCrc()) {
                                if (decodeCountBit == BIT_COUNT) decodeData = decodeData ushr 1
                                hit()
                            }
                            decodeData = 0; decodeCountBit = 0; headerCount = 1; parserStep = STEP_CHECK_PREAMBLE
                        }
                    } else if (tryAddBit(teLast, duration)) parserStep = STEP_SAVE
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        if (decodeData == 0L) return false
        var data = decodeData
        if (decodeCountBit == BIT_COUNT) data = data ushr 1
        val msg = intArrayOf(((data ushr 32) and 0xff).toInt(), ((data ushr 24) and 0xff).toInt(), ((data ushr 16) and 0xff).toInt(), ((data ushr 8) and 0xff).toInt())
        val crc = FG.lfsrDigest8Reflect(msg, 4, 0x31, 0xF4)
        return crc == (data and 0xFF).toInt()
    }

    private fun tryAddBit(last: Int, current: Int): Boolean {
        var ret = false
        if (dd(last + current, teShort + teLong) < teDelta * 2) {
            if (last > current) addBit(1) else addBit(0)
            ret = true
        }
        return ret
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private const val BIT_COUNT = 41
    }
}
