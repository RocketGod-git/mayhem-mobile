package com.rocketgod.mayhem.core.apps.ism

/**
 * Alutech AT-4N rolling-code remotes, 72-bit OOK PWM: 64-bit encrypted hop + 8-bit CRC (Flipper Unleashed
 * lib/subghz/protocols/alutech_at_4n.c). Receive only. Serial, button and counter sit inside the encrypted part, which
 * needs the manufacturer's rainbow table, so only the raw hop and CRC are shown. A frame whose CRC (computed over the
 * encrypted part, no key needed) does not match is dropped.
 */
class SAlutechAt4n : FProto(Fam.REMOTE, S.ALUTECH_AT_4N) {
    /** generic.data in Flipper: the last reported hop, so an identical repeat is not reported twice. */
    private var lastData = 0L
    private var crc = 0
    /** First 64 bits of the frame being received. */
    private var hop = 0L

    init { teShort = 400; teLong = 800; teDelta = 140; minCountBitForFound = 72 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; headerCount++ }
            STEP_CHECK_PREAMBULA -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_RESET; return }
                if (headerCount > 9 && dd(duration, teShort * 10) < teDelta * 10) {
                    // Found header
                    parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (duration >= teShort * 2 + teDelta) {
                        // Add the last bit, read from its mark alone
                        if (dd(teLast, teShort) < teDelta) addBit(1)
                        else if (dd(teLast, teLong) < teDelta * 2) addBit(0)
                        // Found end TX
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound) {
                            val c = (decodeData and 0xFFL).toInt()
                            if (hop != lastData && crcOk(hop, c)) {
                                lastData = hop
                                crc = c
                                dataCountBit = decodeCountBit
                                // Report the hop as decodeData and the CRC as decodeData2
                                decodeData = hop; decodeData2 = c.toLong()
                                hit()
                            }
                            decodeData = 0; decodeCountBit = 0; headerCount = 0
                        }
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) {
                        addBit(1)
                        if (decodeCountBit == 64) { hop = decodeData; decodeData = 0 }
                        parserStep = STEP_SAVE_DURATION
                    } else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) {
                        addBit(0)
                        if (decodeCountBit == 64) { hop = decodeData; decodeData = 0 }
                        parserStep = STEP_SAVE_DURATION
                    } else { parserStep = STEP_RESET; headerCount = 0 }
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("CRC: " + "%02X".format(crc), "Hop: encrypted"))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3

        /** CRC-8 (poly 0x31, init 0xFF) over the 8 bytes of a uint64 in little-endian memory order. */
        private fun alutechCrc(data: Long): Int {
            var crc = 0xFF
            for (y in 0 until 8) {
                crc = crc xor ((data ushr (y * 8)) and 0xFFL).toInt()
                for (i in 0 until 8) crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x31) and 0xFF else (crc shl 1) and 0xFF
            }
            return crc
        }

        /** Received CRC matches the CRC of the (bit-reversed) 64-bit hop. */
        fun crcOk(data: Long, crc: Int): Boolean = FG.reverseKey((crc and 0xFF).toLong(), 8).toInt() == alutechCrc(FG.reverseKey(data, 64))
    }
}
