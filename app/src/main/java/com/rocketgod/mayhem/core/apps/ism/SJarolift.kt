package com.rocketgod.mayhem.core.apps.ism

/**
 * Jarolift 72-bit KeeLoq OOK shutter remotes (Flipper Unleashed lib/subghz/protocols/jarolift.c). Receive only.
 * The hopping part is KeeLoq-encrypted with a manufacturer key this app does not hold, so only the plain fixed part
 * (serial, button), the encrypted hop as opaque hex and the grouping byte are shown; no counter.
 */
class SJarolift : FProto(Fam.REMOTE, S.JAROLIFT) {
    /** Flipper's generic.data (first 64 bits) and generic.data_2 (grouping byte). */
    private var gData = 0L
    private var gData2 = 0L
    init { teShort = 400; teLong = 800; teDelta = 167; minCountBitForFound = 72 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_PREAMBLE; headerCount++ }
            STEP_PREAMBLE -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_RESET; return }
                if (!level && headerCount == 8 && dd(duration, teLong * 5) < teDelta * 6) {
                    // Found the gap after the header (4000 us)
                    parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0; headerCount = 0
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else { headerCount = 0; parserStep = STEP_RESET }
            STEP_CHECK -> {
                if (!level) {
                    if (decodeCountBit == 64) { gData = decodeData; decodeData = 0 }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else {
                        if (duration >= teLong * 3) {
                            // End bit, read from its high alone
                            if (dd(teLast, teLong) < teDelta) addBit(0)
                            else if (dd(teLast, teShort) < teDelta) addBit(1)
                            if (decodeCountBit == minCountBitForFound) {
                                gData2 = decodeData; dataCountBit = decodeCountBit
                                decodeData = gData; decodeData2 = gData2
                                hit()
                            }
                            parserStep = STEP_RESET; decodeData = 0; decodeData2 = 0; decodeCountBit = 0; headerCount = 0
                            return
                        }
                        parserStep = STEP_RESET; headerCount = 0
                    }
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val key = FG.reverseKey(gData, 64)
        val group = FG.reverseKey(gData2, 8)
        val btn = ((key ushr 60) and 0xFL).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), (key ushr 32) and 0xFFFFFFFL, btn, null,
            listOf("Button: " + buttonName(btn), "Hop: " + "%08X".format(key and 0xFFFFFFFFL) + " (encrypted)", "Group: " + "%02X".format(group)))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private fun buttonName(btn: Int): String = when (btn) { 0x1 -> "Learn"; 0x2 -> "Down"; 0x4 -> "Stop"; 0x8 -> "Up"; else -> "Unkn" }
    }
}
