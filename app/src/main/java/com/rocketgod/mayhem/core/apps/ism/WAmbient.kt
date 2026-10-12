package com.rocketgod.mayhem.core.apps.ism

/** Ambient Weather F007TH-style sensor, Manchester coded (Mayhem fprotos/w-ambient.hpp). */
class WAmbient : FProto(Fam.WEATHER, W.AMBIENT) {
    init { teShort = 500; teLong = 1000; teDelta = 120; minCountBitForFound = 48 }
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        if (!level) {
            if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
            else if (dd(duration, teLong) < teDelta * 2) event = Manchester.EVENT_LONG_LOW
        } else {
            if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
            else if (dd(duration, teLong) < teDelta * 2) event = Manchester.EVENT_LONG_HIGH
        }
        if (event != Manchester.EVENT_RESET) {
            if (manchester.advance(event)) decodeData = (decodeData shl 1) or (if (manchester.data) 0L else 1L)
            if ((decodeData and PACKET_HEADER_MASK) == PACKET_HEADER_1 || (decodeData and PACKET_HEADER_MASK) == PACKET_HEADER_2) {
                if (checkCrc()) { hit(); decodeData = 0; decodeCountBit = 0 }
            }
        } else {
            decodeData = 0; decodeCountBit = 0
            manchester.advance(Manchester.EVENT_RESET)
        }
    }

    private fun checkCrc(): Boolean {
        val msg = intArrayOf(
            ((decodeData ushr 40) and 0xff).toInt(), ((decodeData ushr 32) and 0xff).toInt(), ((decodeData ushr 24) and 0xff).toInt(),
            ((decodeData ushr 16) and 0xff).toInt(), ((decodeData ushr 8) and 0xff).toInt())
        val crc = FG.lfsrDigest8(msg, 5, 0x98, 0x3e) xor 0x64
        return crc == (decodeData and 0xff).toInt()
    }

    companion object {
        private const val PACKET_HEADER_1 = 0xFFD440000000000L  // 0xffd45 .. 0xffd46
        private const val PACKET_HEADER_2 = 0x001440000000000L  // 0x00145 .. 0x00146
        private const val PACKET_HEADER_MASK = 0xFFFFC0000000000L
    }
}
