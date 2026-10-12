package com.rocketgod.mayhem.core.apps.ism

/** Ford key fob v0, Manchester coded (Mayhem fprotos/c-ford_v0.hpp). */
class CFordV0 : FProto(Fam.CAR, C.FORD_V0) {
    init { teShort = 250; teLong = 500; teDelta = 100; minCountBitForFound = 64 }

    private val manchester = Manchester()
    private var dataLow = 0L
    private var dataHigh = 0L
    private var bitCount = 0
    private var key1 = 0L
    private var key2 = 0

    private fun fordV0AddBit(bit: Boolean) {
        val low = dataLow.toInt() // uint32 view
        dataLow = (dataLow shl 1) or (if (bit) 1L else 0L)
        dataHigh = (dataHigh shl 1) or ((low ushr 31) and 1).toLong()
        bitCount++
    }

    private fun fordV0ProcessData(): Boolean {
        if (bitCount == 64) {
            val combined = (dataHigh shl 32) or dataLow
            key1 = combined.inv()
            dataLow = 0; dataHigh = 0
            return false
        }
        if (bitCount == 80) {
            val key2Raw = (dataLow and 0xFFFF).toInt()
            key2 = key2Raw.inv() and 0xFFFF
            decodeData = key1
            decodeData2 = key2.toLong()
            return true
        }
        return false
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) {
                dataLow = 0; dataHigh = 0; parserStep = STEP_PREAMBLE; teLast = duration; headerCount = 0; bitCount = 0
                manchester.advance(Manchester.EVENT_RESET)
            }
            STEP_PREAMBLE -> if (!level) {
                if (dd(duration, teLong) < teDelta) { teLast = duration; parserStep = STEP_PREAMBLE_CHECK } else parserStep = STEP_RESET
            }
            STEP_PREAMBLE_CHECK -> if (level) {
                if (dd(duration, teLong) < teDelta) { headerCount++; teLast = duration; parserStep = STEP_PREAMBLE }
                else if (dd(duration, teShort) < teDelta) parserStep = STEP_GAP
                else parserStep = STEP_RESET
            }
            STEP_GAP -> {
                if (!level && dd(duration, GAP_THRESHOLD) < 250) { dataLow = 1; dataHigh = 0; bitCount = 1; parserStep = STEP_DATA }
                else if (!level && duration > GAP_THRESHOLD + 250) parserStep = STEP_RESET
            }
            STEP_DATA -> {
                val event: Int
                if (dd(duration, teShort) < teDelta) event = if (level) Manchester.EVENT_SHORT_LOW else Manchester.EVENT_SHORT_HIGH
                else if (dd(duration, teLong) < teDelta) event = if (level) Manchester.EVENT_LONG_LOW else Manchester.EVENT_LONG_HIGH
                else { parserStep = STEP_RESET; return }

                if (manchester.advance(event)) {
                    fordV0AddBit(manchester.data)
                    if (fordV0ProcessData()) {
                        dataCountBit = 64
                        hit()
                        dataLow = 0; dataHigh = 0; bitCount = 0; parserStep = STEP_RESET
                    }
                }
                teLast = duration
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_PREAMBLE_CHECK = 2; private const val STEP_GAP = 3; private const val STEP_DATA = 4
        private const val GAP_THRESHOLD = 3500
    }
}
