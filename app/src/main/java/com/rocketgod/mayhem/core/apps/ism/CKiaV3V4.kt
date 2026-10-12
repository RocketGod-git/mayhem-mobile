package com.rocketgod.mayhem.core.apps.ism

/** Kia key fob v3 / v4 (Mayhem fprotos/c-kia_v3v4.hpp). */
class CKiaV3V4 : FProto(Fam.CAR, C.KIA_V3V4) {
    init { teShort = 400; teLong = 800; teDelta = 150; minCountBitForFound = 68 }

    private var isV3Sync = false // true = V3 (long LOW sync), false = V4 (long HIGH sync)
    private val rawBits = IntArray(32)
    private var rawBitCount = 0

    private fun reverse8(b: Int): Int {
        var byte = b and 0xff
        byte = ((byte and 0xF0) ushr 4) or ((byte and 0x0F) shl 4)
        byte = ((byte and 0xCC) ushr 2) or ((byte and 0x33) shl 2)
        byte = ((byte and 0xAA) ushr 1) or ((byte and 0x55) shl 1)
        return byte
    }

    private fun kiaV3V4AddRawBit(bit: Boolean) {
        if (rawBitCount < 256) {
            val byteIdx = rawBitCount / 8
            val bitIdx = 7 - (rawBitCount % 8)
            if (bit) rawBits[byteIdx] = rawBits[byteIdx] or (1 shl bitIdx) else rawBits[byteIdx] = rawBits[byteIdx] and (1 shl bitIdx).inv()
            rawBitCount++
        }
    }

    private fun kiaV3V4ProcessBuffer(): Boolean {
        if (rawBitCount < 68) return false
        val b = rawBits

        // For V3-style (long LOW sync), data is inverted
        if (isV3Sync) {
            val numBytes = (rawBitCount + 7) / 8
            for (i in 0 until numBytes) b[i] = b[i].inv() and 0xff
        }

        // Extract fields
        val serial = (reverse8(b[7] and 0xF0).toLong() shl 24) or (reverse8(b[6]).toLong() shl 16) or (reverse8(b[5]).toLong() shl 8) or reverse8(b[4]).toLong()
        val btn = (reverse8(b[7]) and 0xF0) ushr 4
        decodeData = serial
        decodeCountBit = 68
        decodeData2 = btn.toLong()
        dataCountBit = decodeCountBit
        hit()
        return true
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 1 }
            STEP_CHECK_PREAMBLE -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) teLast = duration
                    else if (duration > 1000 && duration < 1500) {
                        // V4 style: Sync is LONG HIGH
                        if (headerCount >= 8) { parserStep = STEP_COLLECT_RAW_BITS; rawBitCount = 0; isV3Sync = false; rawBits.fill(0) }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else {
                    if (duration > 1000 && duration < 1500) {
                        // V3 style: Sync is LONG LOW
                        if (headerCount >= 8) { parserStep = STEP_COLLECT_RAW_BITS; rawBitCount = 0; isV3Sync = true; rawBits.fill(0) }
                        else parserStep = STEP_RESET
                    } else if (dd(duration, teShort) < teDelta && dd(teLast, teShort) < teDelta) headerCount++
                    else if (duration > 1500) parserStep = STEP_RESET
                }
            }
            STEP_COLLECT_RAW_BITS -> {
                if (level) {
                    if (duration > 1000 && duration < 1500) {
                        // Next sync pulse (V4 style) - end this packet
                        kiaV3V4ProcessBuffer()
                        parserStep = STEP_RESET
                    } else if (dd(duration, teShort) < teDelta) kiaV3V4AddRawBit(false)
                    else if (dd(duration, teLong) < teDelta) kiaV3V4AddRawBit(true)
                    else parserStep = STEP_RESET
                } else {
                    if (duration > 1000 && duration < 1500) {
                        // Next sync pulse (V3 style) - end this packet
                        kiaV3V4ProcessBuffer()
                        parserStep = STEP_RESET
                    } else if (duration > 1500) {
                        // Long gap - end of transmission
                        kiaV3V4ProcessBuffer()
                        parserStep = STEP_RESET
                    }
                }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_COLLECT_RAW_BITS = 2 }
}
