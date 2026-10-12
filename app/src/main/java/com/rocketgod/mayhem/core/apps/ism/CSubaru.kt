package com.rocketgod.mayhem.core.apps.ism

/** Subaru key fob (Mayhem fprotos/c-subaru.hpp). */
class CSubaru : FProto(Fam.CAR, C.SUBARU) {
    init { teShort = 800; teLong = 1600; teDelta = 260; minCountBitForFound = 64 }

    private val data = IntArray(8)
    private var bitCount = 0

    private fun subaruAddBit(bit: Boolean) {
        if (bitCount < 64) {
            val byteIdx = bitCount / 8
            val bitIdx = 7 - (bitCount % 8)
            if (bit) data[byteIdx] = data[byteIdx] or (1 shl bitIdx) else data[byteIdx] = data[byteIdx] and (1 shl bitIdx).inv()
            bitCount++
        }
    }

    private fun subaruProcessData(): Boolean {
        if (bitCount < 64) return false
        val b = data
        val key = (b[0].toLong() shl 56) or (b[1].toLong() shl 48) or (b[2].toLong() shl 40) or (b[3].toLong() shl 32) or
            (b[4].toLong() shl 24) or (b[5].toLong() shl 16) or (b[6].toLong() shl 8) or b[7].toLong()
        decodeData = key
        dataCountBit = bitCount
        hit()
        return true
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teLong) < teDelta) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 1 }
            STEP_CHECK_PREAMBLE -> {
                if (!level) {
                    if (dd(duration, teLong) < teDelta) headerCount++
                    else if (duration > 2000 && duration < 3500) { if (headerCount > 20) parserStep = STEP_FOUND_GAP else parserStep = STEP_RESET }
                    else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teLong) < teDelta) { teLast = duration; headerCount++ } else parserStep = STEP_RESET
                }
            }
            STEP_FOUND_GAP -> if (level && duration > 2000 && duration < 3500) parserStep = STEP_FOUND_SYNC else parserStep = STEP_RESET
            STEP_FOUND_SYNC -> {
                if (!level && dd(duration, teLong) < teDelta) { parserStep = STEP_SAVE_DURATION; bitCount = 0; data.fill(0) }
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (level) {
                    // HIGH pulse duration encodes the bit: short HIGH (~800µs) = 1, long HIGH (~1600µs) = 0
                    if (dd(duration, teShort) < teDelta) { subaruAddBit(true); teLast = duration; parserStep = STEP_CHECK_DURATION }
                    else if (dd(duration, teLong) < teDelta) { subaruAddBit(false); teLast = duration; parserStep = STEP_CHECK_DURATION }
                    else if (duration > 3000) {
                        // End of transmission
                        if (bitCount >= 64) subaruProcessData()
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    // LOW pulse - just validates timing, doesn't encode bit
                    if (dd(duration, teShort) < teDelta || dd(duration, teLong) < teDelta) parserStep = STEP_SAVE_DURATION
                    else if (duration > 3000) {
                        // Gap - end of packet
                        if (bitCount >= 64) subaruProcessData()
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_FOUND_GAP = 2
        private const val STEP_FOUND_SYNC = 3; private const val STEP_SAVE_DURATION = 4; private const val STEP_CHECK_DURATION = 5
    }
}
