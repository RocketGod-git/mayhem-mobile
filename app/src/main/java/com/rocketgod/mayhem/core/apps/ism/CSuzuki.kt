package com.rocketgod.mayhem.core.apps.ism

/** Suzuki key fob (Mayhem fprotos/c-suzuki.hpp). */
class CSuzuki : FProto(Fam.CAR, C.SUZUKI) {
    init { teShort = 250; teLong = 500; teDelta = 110; minCountBitForFound = 64 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                // Wait for HIGH pulse (~250µs) to start preamble
                if (!level) return
                if (dd(duration, teShort) > teDelta) return
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_COUNT_PREAMBLE; headerCount = 0
            }
            STEP_COUNT_PREAMBLE -> {
                if (level) { // HIGH pulse
                    if (headerCount >= 300) {
                        if (dd(duration, teLong) <= teDelta) { parserStep = STEP_DECODE_DATA; addBit(1) }
                    }
                } else {
                    if (dd(duration, teShort) <= teDelta) { teLast = duration; headerCount++ } else parserStep = STEP_RESET
                }
            }
            STEP_DECODE_DATA -> {
                if (level) {
                    // HIGH pulse - determines bit value
                    if (duration < teLong) {
                        val diffLong = 500 - duration
                        if (diffLong > 99) {
                            val diffShort = if (duration < 250) 250 - duration else duration - 250
                            if (diffShort <= 99) addBit(0)
                        } else addBit(1)
                    } else {
                        val diffLong = duration - 500
                        if (diffLong <= 99) addBit(1)
                    }
                } else {
                    // LOW pulse - check for gap (end of transmission)
                    val diffGap = if (duration < GAP_TIME) GAP_TIME - duration else duration - GAP_TIME
                    if (diffGap <= GAP_DELTA) {
                        if (decodeCountBit == 64) { dataCountBit = 64; hit() }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    }
                }
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_COUNT_PREAMBLE = 1; private const val STEP_DECODE_DATA = 2
        private const val GAP_TIME = 2000; private const val GAP_DELTA = 400
    }
}
