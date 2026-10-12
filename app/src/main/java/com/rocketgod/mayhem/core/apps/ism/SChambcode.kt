package com.rocketgod.mayhem.core.apps.ism

/** Chamberlain code remotes (Mayhem fprotos/s-chambcode.hpp). */
class SChambcode : FProto(Fam.REMOTE, S.CHAMBCODE) {
    init { teShort = 1000; teLong = 3000; teDelta = 200; minCountBitForFound = 10 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 39) < teDelta * 20) parserStep = STEP_FOUND
            STEP_FOUND -> if (level && dd(duration, teShort) < teDelta) {
                decodeData = 0; decodeCountBit = 0
                decodeData = (decodeData shl 4) or CODE_BIT_STOP.toLong()
                decodeCountBit++
                parserStep = STEP_SAVE
            } else parserStep = STEP_RESET
            STEP_SAVE -> if (!level) {
                if (duration > teShort * 5) {
                    if (decodeCountBit >= minCountBitForFound) {
                        if (checkMaskAndParse()) { dataCountBit = decodeCountBit; hit() }
                    }
                    parserStep = STEP_RESET
                } else {
                    teLast = duration
                    parserStep = STEP_CHECK
                }
            } else parserStep = STEP_RESET
            STEP_CHECK -> if (level) {
                if (dd(teLast, teShort * 3) < teDelta && dd(duration, teShort) < teDelta) {
                    decodeData = (decodeData shl 4) or CODE_BIT_STOP.toLong(); decodeCountBit++; parserStep = STEP_SAVE
                } else if (dd(teLast, teShort * 2) < teDelta && dd(duration, teShort * 2) < teDelta) {
                    decodeData = (decodeData shl 4) or CODE_BIT_1.toLong(); decodeCountBit++; parserStep = STEP_SAVE
                } else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 3) < teDelta) {
                    decodeData = (decodeData shl 4) or CODE_BIT_0.toLong(); decodeCountBit++; parserStep = STEP_SAVE
                } else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    private fun checkMaskAndParse(): Boolean {
        if (decodeCountBit > minCountBitForFound + 1) return false
        if ((decodeData and MASK_7) == MASK_7_CHECK) {
            decodeCountBit = 7
            decodeData = decodeData and MASK_7.inv()
            decodeData = (decodeData ushr 12) or ((decodeData ushr 4) and 0xFL)
        } else if ((decodeData and MASK_8) == MASK_8_CHECK) {
            decodeCountBit = 8
            decodeData = decodeData and MASK_8.inv()
            decodeData = (decodeData ushr 4) or (CODE_BIT_0.toLong() shl 8)
        } else if ((decodeData and MASK_9) == MASK_9_CHECK) {
            decodeCountBit = 9
            decodeData = decodeData and MASK_9.inv()
            decodeData = decodeData ushr 4
        } else {
            return false
        }
        return toBit(decodeCountBit)
    }

    private fun toBit(size: Int): Boolean {
        var dataTmp = decodeData
        var dataRes = 0L
        for (i in 0 until size) {
            val nib = dataTmp and 0xFL
            when (nib) {
                CODE_BIT_0.toLong() -> { /* write 0 */ }
                CODE_BIT_1.toLong() -> dataRes = dataRes or (1L shl i)
                else -> return false
            }
            dataTmp = dataTmp ushr 4
        }
        decodeData = dataRes
        return true
    }

    companion object {
        private const val CODE_BIT_STOP = 0b0001; private const val CODE_BIT_1 = 0b0011; private const val CODE_BIT_0 = 0b0111
        private const val MASK_7 = 0xF000000FF0FL; private const val MASK_8 = 0xF00000F00FL; private const val MASK_9 = 0xF000000000FL
        private const val MASK_7_CHECK = 0x10000001101L; private const val MASK_8_CHECK = 0x1000001001L; private const val MASK_9_CHECK = 0x10000000001L
        private const val STEP_RESET = 0; private const val STEP_FOUND = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
    }
}
