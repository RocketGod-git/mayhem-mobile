package com.rocketgod.mayhem.core.apps.ism

/** Elplast / P-11B / 3BK / E.C.A 18-bit OOK remotes (Flipper Unleashed lib/subghz/protocols/elplast.c). Receive only. */
class SElplast : FProto(Fam.REMOTE, S.ELPLAST) {
    private var gData = 0L
    init { teShort = 230; teLong = 1550; teDelta = 160; minCountBitForFound = 18 }

    override fun feed(level: Boolean, duration: Int) {
        val gap = teLong * 8; val gapDelta = teDelta * 13
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, gap) < gapDelta) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(duration, gap) < gapDelta) {
                        // Next gap: the last bit is read from its high alone
                        if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (decodeCountBit == minCountBitForFound) { gData = decodeData; dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val yek = FG.reverseKey(gData, dataCountBit)
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("Yek: 0x" + "%05X".format(yek)))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
