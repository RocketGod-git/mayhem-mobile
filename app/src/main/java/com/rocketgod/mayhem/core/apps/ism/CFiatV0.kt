package com.rocketgod.mayhem.core.apps.ism

/** Fiat key fob v0, Manchester coded (Mayhem fprotos/c-fiat_v0.hpp). */
class CFiatV0 : FProto(Fam.CAR, C.FIAT_V0) {
    init { teShort = 200; teLong = 400; teDelta = 100; minCountBitForFound = 64 }

    private val manchester = Manchester()
    private var decoderState = 0
    private var bitCount = 0
    private var endbyte = 0
    private var preambleCount = 0
    private var dataLow = 0 // uint32
    private var dataHigh = 0 // uint32
    private var hop = 0
    private var fix = 0

    override fun feed(level: Boolean, duration: Int) {
        var diff: Int
        when (decoderState) {
            STEP_RESET -> {
                if (!level) return
                diff = if (duration < teShort) teShort - duration else duration - teShort
                if (diff < teDelta) {
                    dataLow = 0; dataHigh = 0; decoderState = STEP_PREAMBLE; teLast = duration; preambleCount = 0; bitCount = 0
                    manchester.advance(Manchester.EVENT_RESET)
                }
            }
            STEP_PREAMBLE -> {
                if (level) return
                if (duration < teShort) {
                    diff = teShort - duration
                    if (diff < teDelta) {
                        preambleCount++; teLast = duration
                        if (preambleCount >= 0x96) {
                            diff = if (duration < GAP_THRESHOLD) GAP_THRESHOLD - duration else duration - GAP_THRESHOLD
                            if (diff < teDelta) { decoderState = STEP_DATA; preambleCount = 0; dataLow = 0; dataHigh = 0; bitCount = 0; teLast = duration; return }
                        }
                    } else {
                        decoderState = STEP_RESET
                        if (preambleCount >= 0x96) {
                            diff = if (duration < GAP_THRESHOLD) GAP_THRESHOLD - duration else duration - GAP_THRESHOLD
                            if (diff < teDelta) { decoderState = STEP_DATA; preambleCount = 0; dataLow = 0; dataHigh = 0; bitCount = 0; teLast = duration; return }
                        }
                    }
                } else {
                    diff = duration - teShort
                    if (diff < teDelta) { preambleCount++; teLast = duration } else decoderState = STEP_RESET
                    if (preambleCount >= 0x96) {
                        // upstream uses unsigned arithmetic here: duration == 799 wraps to a huge diff and never matches
                        diff = if (duration >= 799) duration - GAP_THRESHOLD else GAP_THRESHOLD - duration
                        if (diff >= 0 && diff < teDelta) { decoderState = STEP_DATA; preambleCount = 0; dataLow = 0; dataHigh = 0; bitCount = 0; teLast = duration; return }
                    }
                }
            }
            STEP_DATA -> {
                var event = Manchester.EVENT_RESET
                if (duration < teShort) {
                    diff = teShort - duration
                    if (diff < teDelta) event = if (level) Manchester.EVENT_SHORT_LOW else Manchester.EVENT_SHORT_HIGH
                } else {
                    diff = duration - teShort
                    if (diff < teDelta) event = if (level) Manchester.EVENT_SHORT_LOW else Manchester.EVENT_SHORT_HIGH
                    else {
                        diff = if (duration < teLong) teLong - duration else duration - teLong
                        if (diff < teDelta) event = if (level) Manchester.EVENT_LONG_LOW else Manchester.EVENT_LONG_HIGH
                    }
                }

                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) {
                        val newBit = if (manchester.data) 1 else 0
                        val carry = (dataLow ushr 31) and 1
                        dataLow = (dataLow shl 1) or newBit
                        dataHigh = (dataHigh shl 1) or carry
                        bitCount++
                        if (bitCount == 0x40) { fix = dataLow; hop = dataHigh; dataLow = 0; dataHigh = 0 }
                        if (bitCount > 0x46) {
                            endbyte = dataLow and 0xff
                            decodeData = (hop.toLong() shl 32) or (fix.toLong() and 0xFFFFFFFFL)
                            decodeData2 = endbyte.toLong()
                            dataCountBit = 64
                            hit()
                            dataLow = 0; dataHigh = 0; bitCount = 0; decoderState = STEP_RESET
                        }
                    }
                }
                teLast = duration
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_DATA = 2; private const val GAP_THRESHOLD = 800 }
}
