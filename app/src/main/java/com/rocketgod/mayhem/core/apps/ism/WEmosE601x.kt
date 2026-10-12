package com.rocketgod.mayhem.core.apps.ism

/** EMOS E601x weather station, 120-bit frame spread over decodeData + upperDecodeData (Mayhem fprotos/w-emose601x.hpp). */
class WEmosE601x : FProto(Fam.WEATHER, W.EMOS_E601X) {
    init { teShort = 260; teLong = 800; teDelta = 100; minCountBitForFound = 24 }
    private var upperDecodeData = 0L

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 7) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration }
            STEP_CHECK_PREAMBLE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort * 7) < teDelta * 2 && dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                    else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addTo128Bit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addTo128Bit(1); parserStep = STEP_SAVE }
                    else { parserStep = STEP_RESET; return }

                    /* Bail out if the header doesn't match */
                    if (decodeCountBit == minCountBitForFound) {
                        if (decodeData != MAGIC_HEADER) { parserStep = STEP_RESET; return }
                    }

                    if (decodeCountBit == 120) {
                        if (check()) hit()
                        return
                    }
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun addTo128Bit(bit: Int) {
        if (++decodeCountBit > 64) upperDecodeData = (upperDecodeData shl 1) or (decodeData ushr 63)
        decodeData = (decodeData shl 1) or bit.toLong()
    }

    private fun check(): Boolean {
        val msg = intArrayOf(
            ((upperDecodeData ushr 48) and 0xff).toInt(), ((upperDecodeData ushr 40) and 0xff).toInt(), ((upperDecodeData ushr 32) and 0xff).toInt(),
            ((upperDecodeData ushr 24) and 0xff).toInt(), ((upperDecodeData ushr 16) and 0xff).toInt(), ((upperDecodeData ushr 8) and 0xff).toInt(),
            (upperDecodeData and 0xff).toInt(),
            ((decodeData ushr 56) and 0xff).toInt(), ((decodeData ushr 48) and 0xff).toInt(), ((decodeData ushr 40) and 0xff).toInt(),
            ((decodeData ushr 32) and 0xff).toInt(), ((decodeData ushr 24) and 0xff).toInt(), ((decodeData ushr 16) and 0xff).toInt())
        val sum = FG.addBytes(msg, 13)
        return sum == ((decodeData ushr 8) and 0xff).toInt()
    }

    companion object {
        private const val MAGIC_HEADER = 0xaaa583L
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
    }
}
