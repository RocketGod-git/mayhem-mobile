package com.rocketgod.mayhem.core.apps.ism

/** Oregon Scientific v3.0 weather sensors (Mayhem fprotos/w-oregon3.hpp). */
class WOregon3 : FProto(Fam.WEATHER, W.OREGON3) {
    init { teShort = 500; teLong = 1100; teDelta = 300; minCountBitForFound = 32 }

    private var data = 0L
    private var varBits = 0
    private var varData = 0L
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        val event = levelAndDurationToEvent(!level, duration)

        // low-level bit sequence decoding
        if (event == Manchester.EVENT_RESET) { parserStep = STEP_RESET; decodeData = 0; decodeCountBit = 0 }
        if (manchester.advance(event)) addBit(if (manchester.data) 1 else 0)

        when (parserStep) {
            STEP_RESET -> {
                // waiting for fixed oregon3 preamble
                if (decodeCountBit >= PREAMBLE_BITS && (decodeData and PREAMBLE_MASK) == PREAMBLE) { parserStep = STEP_FOUND_PREAMBLE; decodeCountBit = 0; decodeData = 0 }
            }
            STEP_FOUND_PREAMBLE -> {
                // waiting for fixed oregon3 data
                if (decodeCountBit == FIXED_PART_BITS) {
                    data = decodeData; decodeData = 0; decodeCountBit = 0
                    // reverse nibbles in decoded data as oregon v3.0 is LSB first
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
                    varData = decodeData
                    // reverse nibbles in var data
                    varData = ((varData and 0x5555555555555555L) shl 1) or ((varData and MASK_A) ushr 1)
                    varData = ((varData and 0x3333333333333333L) shl 2) or ((varData and MASK_C) ushr 2)
                    decodeData = varData ushr CHECKSUM_BITS
                    parserStep = STEP_RESET
                    hit()
                }
            }
        }
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
        ID_THGR221 -> (4 + 2 + 1) * 4 // nibbles: temp + hum + '0'
        else -> 0
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_PREAMBLE = 1; private const val STEP_VAR_DATA = 2
        private const val PREAMBLE_BITS = 28
        private const val PREAMBLE_MASK = 0b1111111111111111111111111111L
        private const val PREAMBLE = 0b1111111111111111111111110101L // 24 ones + 0101 (inverted A)
        private const val FIXED_PART_BITS = 16 + 4 + 8 + 4 // sensor type, channel, id, battery
        private const val CHECKSUM_BITS = 8
        private const val ID_THGR221 = 0xf824
        private val MASK_A = 0xAAAAAAAAAAAAAAAAuL.toLong()
        private val MASK_C = 0xCCCCCCCCCCCCCCCCuL.toLong()
    }
}
