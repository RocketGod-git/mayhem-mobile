package com.rocketgod.mayhem.core.apps.ism

/** VW key fob, Manchester coded with its own state machine (Mayhem fprotos/c-vw.hpp). */
class CVw : FProto(Fam.CAR, C.VW) {
    init { teShort = 500; teLong = 1000; teDelta = 130; minCountBitForFound = 80 }

    private var manchesterState = Manchester.MID1
    private var manchesterData = false

    private fun vwGetBitIndex(bit: Int): Int {
        var bitIndex = 0
        if (bit < 72 && bit >= 8) {
            // use decodeData (bytes 1-8)
            bitIndex = bit - 8
        } else {
            // use decodeData2
            if (bit >= 72) bitIndex = bit - 64 // byte 0 = type
            if (bit < 8) bitIndex = bit // byte 9 = check digit
            bitIndex = bitIndex or 0x80 // mark for decodeData2
        }
        return bitIndex
    }

    private fun vwAddBit(level: Boolean) {
        if (dataCountBit >= minCountBitForFound) return
        val bitIndexFull = minCountBitForFound - 1 - dataCountBit
        val bitIndexMasked = vwGetBitIndex(bitIndexFull)
        val bitIndex = bitIndexMasked and 0x7F
        if (bitIndexMasked and 0x80 != 0) {
            // use decodeData2
            decodeData2 = if (level) decodeData2 or (1L shl bitIndex) else decodeData2 and (1L shl bitIndex).inv()
        } else {
            // use decodeData
            decodeData = if (level) decodeData or (1L shl bitIndex) else decodeData and (1L shl bitIndex).inv()
        }
        dataCountBit++
        if (dataCountBit >= minCountBitForFound) hit()
    }

    private fun reset() { parserStep = STEP_RESET; dataCountBit = 0; decodeData = 0; decodeData2 = 0; manchesterState = Manchester.MID1 }

    /** VW's own Manchester step; returns true when a bit was produced (read it from [manchesterData]). */
    private fun vwManchesterAdvance(event: Int): Boolean {
        var result = false
        var newState = Manchester.MID1
        val state = manchesterState
        if (event == Manchester.EVENT_RESET) newState = Manchester.MID1
        else if (state == Manchester.MID0 || state == Manchester.MID1) {
            newState = if (event == Manchester.EVENT_SHORT_HIGH) Manchester.START1 else if (event == Manchester.EVENT_SHORT_LOW) Manchester.START0 else Manchester.MID1
        } else if (state == Manchester.START1) {
            if (event == Manchester.EVENT_SHORT_LOW) { newState = Manchester.MID1; result = true; manchesterData = true }
            else if (event == Manchester.EVENT_LONG_LOW) { newState = Manchester.START0; result = true; manchesterData = true }
            else newState = Manchester.MID1
        } else if (state == Manchester.START0) {
            if (event == Manchester.EVENT_SHORT_HIGH) { newState = Manchester.MID0; result = true; manchesterData = false }
            else if (event == Manchester.EVENT_LONG_HIGH) { newState = Manchester.START1; result = true; manchesterData = false }
            else newState = Manchester.MID1
        }
        manchesterState = newState
        return result
    }

    override fun feed(level: Boolean, duration: Int) {
        val teMed = (teLong + teShort) / 2
        val teEnd = teLong * 5
        var event = Manchester.EVENT_RESET

        when (parserStep) {
            STEP_RESET -> if (dd(duration, teShort) < teDelta) parserStep = STEP_FOUND_SYNC
            STEP_FOUND_SYNC -> {
                if (dd(duration, teShort) < teDelta) return // Stay - sync pattern repeats ~43 times
                if (level && dd(duration, teLong) < teDelta) { parserStep = STEP_FOUND_START1; return }
                parserStep = STEP_RESET
            }
            STEP_FOUND_START1 -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_FOUND_START2; return }
                parserStep = STEP_RESET
            }
            STEP_FOUND_START2 -> {
                if (level && dd(duration, teMed) < teDelta) { parserStep = STEP_FOUND_START3; return }
                parserStep = STEP_RESET
            }
            STEP_FOUND_START3 -> {
                if (dd(duration, teMed) < teDelta) return // Stay - med pattern repeats
                if (level && dd(duration, teShort) < teDelta) {
                    // Start data collection
                    vwManchesterAdvance(Manchester.EVENT_RESET)
                    vwManchesterAdvance(Manchester.EVENT_SHORT_HIGH)
                    dataCountBit = 0; decodeData = 0; decodeData2 = 0
                    parserStep = STEP_FOUND_DATA
                    return
                }
                parserStep = STEP_RESET
            }
            STEP_FOUND_DATA -> {
                if (dd(duration, teShort) < teDelta) event = if (level) Manchester.EVENT_SHORT_HIGH else Manchester.EVENT_SHORT_LOW
                if (dd(duration, teLong) < teDelta) event = if (level) Manchester.EVENT_LONG_HIGH else Manchester.EVENT_LONG_LOW
                // Last bit can be arbitrarily long
                if (dataCountBit == minCountBitForFound - 1 && !level && duration > teEnd) event = Manchester.EVENT_SHORT_LOW

                if (event == Manchester.EVENT_RESET) reset()
                else if (vwManchesterAdvance(event)) vwAddBit(manchesterData)
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_SYNC = 1; private const val STEP_FOUND_START1 = 2
        private const val STEP_FOUND_START2 = 3; private const val STEP_FOUND_START3 = 4; private const val STEP_FOUND_DATA = 5
    }
}
