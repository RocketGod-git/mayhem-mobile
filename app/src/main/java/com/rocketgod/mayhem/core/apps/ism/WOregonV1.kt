package com.rocketgod.mayhem.core.apps.ism

/** Oregon Scientific v1 weather sensors (Mayhem fprotos/w-oregonv1.hpp). */
class WOregonV1 : FProto(Fam.WEATHER, W.OREGON_V1) {
    init { teShort = 1465; teLong = 2930; teDelta = 350; minCountBitForFound = 32 }

    private var firstBit = 0
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_FOUND_PREAMBLE; teLast = duration; headerCount = 0 }
            STEP_FOUND_PREAMBLE -> {
                if (level) {
                    // keep high levels, if they suit our durations
                    if (dd(duration, teShort) < teDelta || dd(duration, teShort * 4) < teDelta) teLast = duration else parserStep = STEP_RESET
                } else if (dd(duration, teShort) < teDelta && dd(teLast, teShort) < teDelta) {
                    // Found header
                    headerCount++
                } else if (dd(duration, teShort * 3) < teDelta && dd(teLast, teShort) < teDelta) {
                    // check header
                    if (headerCount > 7) headerCount = HEADER_OK
                } else if (headerCount == HEADER_OK && dd(teLast, teShort * 4) < teDelta) {
                    // found all the necessary patterns
                    decodeData = 0; decodeCountBit = 1
                    manchester.advance(Manchester.EVENT_RESET)
                    parserStep = STEP_PARSE
                    firstBit = if (duration < teShort * 4) 1 else 0
                } else parserStep = STEP_RESET
            }
            STEP_PARSE -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong * 2) {
                        if (decodeCountBit == minCountBitForFound) {
                            if (firstBit != 0) decodeData = decodeData.inv() or (1L shl 31)
                            if (check()) hit()
                        }
                        decodeData = 0; decodeCountBit = 0
                        manchester.advance(Manchester.EVENT_RESET)
                    } else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) { decodeData = (decodeData shl 1) or (if (manchester.data) 0L else 1L); decodeCountBit++ }
                }
            }
        }
    }

    private fun check(): Boolean {
        if (decodeData == 0L) return false
        val data = FG.reverseKey(decodeData, 32)
        var crc = ((data and 0xff) + ((data ushr 8) and 0xff) + ((data ushr 16) and 0xff)).toInt()
        crc = (crc and 0xff) + ((crc ushr 8) and 0xff)
        return crc == ((data ushr 24) and 0xFF).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_PREAMBLE = 1; private const val STEP_PARSE = 2; private const val HEADER_OK = 0xFF }
}
