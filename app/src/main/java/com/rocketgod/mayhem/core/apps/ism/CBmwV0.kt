package com.rocketgod.mayhem.core.apps.ism

/** BMW key fob v0 (Mayhem fprotos/c-bmw_v0.hpp). */
class CBmwV0 : FProto(Fam.CAR, C.BMW_V0) {
    init { teShort = 350; teLong = 700; teDelta = 120; minCountBitForFound = 61 }

    private var crcType = 0

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0; decodeData = 0; decodeCountBit = 0 }
            STEP_CHECK_PREAMBULA -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta || dd(duration, teLong) < teDelta) teLast = duration else parserStep = STEP_RESET
                } else if (dd(duration, teShort) < teDelta && dd(teLast, teShort) < teDelta) headerCount++
                else if (dd(duration, teLong) < teDelta && dd(teLast, teLong) < teDelta) {
                    if (headerCount > 15) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0 } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (level) {
                    if (duration >= teLong + teDelta * 2) {
                        if (decodeCountBit >= minCountBitForFound) {
                            dataCountBit = decodeCountBit
                            // Perform CRC check with both CRC8 and CRC16 (over the little-endian bytes of decodeData)
                            val rawLen = (decodeCountBit + 7) / 8
                            val rawBytes = IntArray(rawLen) { if (it < 8) ((decodeData ushr (8 * it)) and 0xFF).toInt() else 0 }
                            val crc8 = bmwCrc8(rawBytes, rawLen - 1)
                            if (crc8 == rawBytes[rawLen - 1]) crcType = 8
                            else {
                                val crc16 = bmwCrc16(rawBytes, rawLen - 2)
                                val rxCrc16 = (rawBytes[rawLen - 2] shl 8) or rawBytes[rawLen - 1]
                                crcType = if (crc16 == rxCrc16) 16 else 0 // 0 = invalid
                            }
                            if (crcType != 0) hit()
                        }
                        resetInternal()
                    } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun bmwCrc8(data: IntArray, len: Int): Int {
        var crc = 0x00
        for (i in 0 until len) {
            crc = crc xor data[i]
            for (j in 0 until 8) crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x31) and 0xff else (crc shl 1) and 0xff
        }
        return crc
    }

    private fun bmwCrc16(data: IntArray, len: Int): Int {
        var crc = 0xFFFF
        for (i in 0 until len) {
            crc = crc xor ((data[i] shl 8) and 0xFFFF)
            for (j in 0 until 8) crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xFFFF else (crc shl 1) and 0xFFFF
        }
        return crc
    }

    private fun resetInternal() { decodeData = 0; decodeCountBit = 0; decodeData2 = 0; parserStep = STEP_RESET; headerCount = 0; crcType = 0 }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
