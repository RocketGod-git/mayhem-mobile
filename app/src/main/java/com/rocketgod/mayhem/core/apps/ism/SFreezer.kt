package com.rocketgod.mayhem.core.apps.ism

/** Freezer 24-bit OOK remotes (Flipper Unleashed lib/subghz/protocols/freezer.c). Receive only. */
class SFreezer : FProto(Fam.REMOTE, S.FREEZER) {
    private var lastData = 0L
    private var gData = 0L
    init { teShort = 250; teLong = 500; teDelta = 120; minCountBitForFound = 24 }

    override fun feed(level: Boolean, duration: Int) {
        val gapMin = teShort * 30
        when (parserStep) {
            STEP_RESET -> if (!level && duration >= gapMin) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_START }
            STEP_START -> parserStep = if (level && isShort(duration)) STEP_SAVE else STEP_RESET
            STEP_SAVE -> { // a cell opens on the low
                if (level) { parserStep = STEP_RESET; return }
                if (duration >= gapMin) {
                    // Only a code that arrived twice running is reported
                    val full = decodeCountBit == minCountBitForFound
                    if (full && decodeData == lastData && lastData != 0L) { gData = decodeData; dataCountBit = decodeCountBit; hit() }
                    lastData = if (full) decodeData else 0L
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_START
                    return
                }
                teLast = duration; parserStep = STEP_CHECK
            }
            STEP_CHECK -> { // and closes on the high
                if (!level) { parserStep = STEP_RESET; return }
                if (isShort(teLast) && isLong(duration)) { addBit(1); parserStep = STEP_SAVE }
                else if (isLong(teLast) && isShort(duration)) { addBit(0); parserStep = STEP_SAVE }
                else { lastData = 0L; parserStep = STEP_RESET }
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), (gData ushr 4) and 0xFFFFFL, (gData and 0xFL).toInt(), null, emptyList())
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_START = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private const val SYMBOL_MIN = 120; private const val SYMBOL_SPLIT = 375; private const val SYMBOL_MAX = 700 // short at or under the split, long above
        private fun isShort(d: Int) = d >= SYMBOL_MIN && d <= SYMBOL_SPLIT
        private fun isLong(d: Int) = d > SYMBOL_SPLIT && d <= SYMBOL_MAX
    }
}
