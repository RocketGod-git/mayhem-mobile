package com.rocketgod.mayhem.core.apps.ism

/**
 * BelKorn rolling-code remotes, 118-bit OOK, one bit per pulse on marks and spaces alike (Flipper Unleashed
 * lib/subghz/protocols/belkorn.c). Receive only. The frame is not encrypted: the 36-bit serial, 6-bit button and
 * 16-bit press counter are read straight out of it. Bits 0..63 are kept in decodeData and bits 64..117 in
 * decodeData2, MSB first.
 */
class SBelkorn : FProto(Fam.REMOTE, S.BELKORN) {
    private var dataHi = 0L

    init { teShort = 481; teLong = 962; teDelta = 180; minCountBitForFound = 118 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && duration >= GAP_MIN) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_DATA }
            STEP_DATA -> {
                // Bits alternate mark and space, so a level out of turn means the frame was broken
                if (level != ((decodeCountBit and 1) == 0)) { parserStep = STEP_RESET; return }
                if (dd(duration, teShort) < teDelta) addBit(0)
                else if (dd(duration, teLong) < teDelta) addBit(1)
                else { parserStep = STEP_RESET; return }
                if (decodeCountBit == 64) { dataHi = decodeData; decodeData = 0 }
                else if (decodeCountBit == minCountBitForFound) {
                    val lo = decodeData
                    parserStep = STEP_RESET
                    if (frameValid(dataHi, lo)) {
                        decodeData = dataHi; decodeData2 = lo; dataCountBit = decodeCountBit
                        hit()
                    }
                }
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val d = decodeData; val d2 = decodeData2
        if (!frameValid(d, d2)) return null
        val serial = (get(d, d2, 12, 4) shl 32) or get(d, d2, 16, 32)
        val b5 = get(d, d2, 88, 8).toInt(); val b6 = get(d, d2, 96, 8).toInt(); val c = get(d, d2, 104, 8).toInt()
        val cnt = ((if (c and 1 != 0) b5 else b6) shl 8) or c
        return RemoteInfo(RemoteFields.name(sensorType), serial, get(d, d2, 112, 6).toInt(), cnt, listOf("Key2: " + java.lang.Long.toHexString(d2).uppercase()))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_DATA = 1
        private const val GAP_MIN = 2500
        private const val SYNC = 0x801L

        /** Field [len] bits wide at bit [pos] (MSB first) of the 118-bit frame, unsigned. */
        fun get(data: Long, data2: Long, pos: Int, len: Int): Long {
            val mask = (1L shl len) - 1
            return if (pos + len <= 64) (data ushr (64 - pos - len)) and mask else (data2 ushr (118 - pos - len)) and mask
        }

        /** The sync word is right and exactly one button bit is set. */
        fun frameValid(data: Long, data2: Long): Boolean {
            val btn = (data2 and 0x3FL).toInt()
            return (data ushr 52) == SYNC && btn != 0 && (btn and (btn - 1)) == 0
        }
    }
}
