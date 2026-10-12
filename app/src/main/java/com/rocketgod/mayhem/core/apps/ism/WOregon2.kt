package com.rocketgod.mayhem.core.apps.ism

/** Oregon Scientific v2.1 weather sensors (Mayhem fprotos/w-oregon2.hpp). Switches to [W.OREGON2B] for THGR122N. */
class WOregon2 : FProto(Fam.WEATHER, W.OREGON2) {
    init { teShort = 500; teLong = 1000; teDelta = 200; minCountBitForFound = 32 }

    private var data = 0L
    private var haveBit = false
    private var prevBit = false
    private var varBits = 0
    private var varData = 0L
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        // oregon v2.1 signal is inverted
        val event = levelAndDurationToEvent(!level, duration)

        // low-level bit sequence decoding
        if (event == Manchester.EVENT_RESET) { parserStep = STEP_RESET; haveBit = false; decodeData = 0; decodeCountBit = 0 }
        if (manchester.advance(event)) {
            val bitValue = manchester.data
            if (haveBit) {
                if (!prevBit && bitValue) addBit(1)
                else if (prevBit && !bitValue) addBit(0)
                else reset()
                haveBit = false
            } else { prevBit = bitValue; haveBit = true }
        }

        when (parserStep) {
            STEP_RESET -> {
                // waiting for fixed oregon2 preamble
                if (decodeCountBit >= PREAMBLE_BITS && (decodeData and PREAMBLE_MASK) == PREAMBLE) { parserStep = STEP_FOUND_PREAMBLE; decodeCountBit = 0; decodeData = 0 }
            }
            STEP_FOUND_PREAMBLE -> {
                // waiting for fixed oregon2 data
                if (decodeCountBit == 32) {
                    data = decodeData; decodeData = 0; decodeCountBit = 0
                    // reverse nibbles in decoded data
                    data = ((data and 0x55555555L) shl 1) or ((data and 0xAAAAAAAAL) ushr 1)
                    data = ((data and 0x33333333L) shl 2) or ((data and 0xCCCCCCCCL) ushr 2)
                    varBits = sensorIdVarBits(((data ushr 16) and 0xFFFF).toInt())
                    if (varBits == 0) parserStep = STEP_RESET // sensor is not supported, stop decoding
                    else parserStep = STEP_VAR_DATA
                }
            }
            STEP_VAR_DATA -> {
                // waiting for variable (sensor-specific data)
                if (decodeCountBit == varBits + CHECKSUM_BITS) {
                    varData = decodeData and 0xFFFFFFFFL
                    // reverse nibbles in var data
                    varData = ((varData and 0x55555555L) shl 1) or ((varData and 0xAAAAAAAAL) ushr 1)
                    varData = ((varData and 0x33333333L) shl 2) or ((varData and 0xCCCCCCCCL) ushr 2)
                    decodeData = varData ushr CHECKSUM_BITS
                    decodeData = decodeData or (data shl 32) // unique to portapack: the fixed part rides in the upper half
                    parserStep = STEP_RESET
                    hit()
                }
            }
        }
    }

    private fun reset() {
        parserStep = STEP_RESET
        decodeData = 0; decodeCountBit = 0
        manchester.advance(Manchester.EVENT_RESET)
        haveBit = false
        varData = 0; varBits = 0
    }

    private fun levelAndDurationToEvent(level: Boolean, duration: Int): Int {
        val isLong: Boolean
        if (dd(duration, teLong) < teDelta) isLong = true
        else if (dd(duration, teShort) < teDelta) isLong = false
        else return Manchester.EVENT_RESET
        return if (level) (if (isLong) Manchester.EVENT_LONG_HIGH else Manchester.EVENT_SHORT_HIGH)
        else (if (isLong) Manchester.EVENT_LONG_LOW else Manchester.EVENT_SHORT_LOW)
    }

    private fun sensorIdVarBits(sensorId: Int): Int = when (sensorId) {
        ID_THR228N, ID_RTHN129_1, ID_RTHN129_2, ID_RTHN129_3, ID_RTHN129_4, ID_RTHN129_5 -> { sensorType = W.OREGON2; 16 }
        ID_THGR122N -> { sensorType = W.OREGON2B; 24 }
        else -> 0
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_PREAMBLE = 1; private const val STEP_VAR_DATA = 2
        private const val PREAMBLE_BITS = 19
        private const val PREAMBLE_MASK = 0b1111111111111111111L
        private const val PREAMBLE = 0b1111111111111110101L // 15 ones + 0101 (inverted A)
        private const val CHECKSUM_BITS = 8
        private const val ID_THGR122N = 0x1d20
        private const val ID_THR228N = 0xec40
        private const val ID_RTHN129_1 = 0x9cd3
        private const val ID_RTHN129_2 = 0xacd3
        private const val ID_RTHN129_3 = 0xbcd3
        private const val ID_RTHN129_4 = 0xccd3
        private const val ID_RTHN129_5 = 0xdcd3
    }
}
