package com.rocketgod.mayhem.core.apps.ism

/** KeyFinder 24-bit OOK key-finder tags (Flipper Unleashed lib/subghz/protocols/keyfinder.c). Receive only. */
class SKeyfinder : FProto(Fam.REMOTE, S.KEYFINDER) {
    private var endCount = 0
    private var gData = 0L
    init { teShort = 400; teLong = 1200; teDelta = 150; minCountBitForFound = 24 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 10) < teDelta * 5) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> {
                if (decodeCountBit == minCountBitForFound) {
                    // Four short end pulses close the frame
                    if (level && dd(duration, teShort) < teDelta) {
                        endCount++
                        if (endCount == 4) { parserStep = STEP_FINISH; endCount = 0 }
                    } else if (!level && dd(duration, teShort) < teDelta) {
                        // the short lows between end pulses
                    } else { decodeData = 0; decodeCountBit = 0; endCount = 0; parserStep = STEP_RESET }
                    return
                }
                if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_FINISH -> {
                if (decodeCountBit == minCountBitForFound) { gData = decodeData; dataCountBit = decodeCountBit; hit() }
                decodeData = 0; decodeCountBit = 0; endCount = 0; parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val yek = FG.reverseKey(gData, dataCountBit) and 0xFFFFFFL
        return RemoteInfo(RemoteFields.name(sensorType), gData ushr 4, (gData and 0xFL).toInt(), null, listOf("Yek: 0x" + "%06X".format(yek)))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2; private const val STEP_FINISH = 3 }
}
