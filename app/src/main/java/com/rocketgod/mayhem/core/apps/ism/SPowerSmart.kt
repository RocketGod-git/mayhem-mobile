package com.rocketgod.mayhem.core.apps.ism

/** Power Smart remotes (Mayhem fprotos/s-power_smart.hpp). */
class SPowerSmart : FProto(Fam.REMOTE, S.POWER_SMART) {
    init { teShort = 225; teLong = 450; teDelta = 100; minCountBitForFound = 64 }

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
            if ((decodeData and PACKET_HEADER_MASK) == PACKET_HEADER) {
                if (checkValid(decodeData)) {
                    dataCountBit = minCountBitForFound
                    hit()
                    decodeData = 0; decodeCountBit = 0
                }
            }
        } else {
            decodeData = 0; decodeCountBit = 0
            manchester.advance(Manchester.EVENT_RESET)
        }
    }

    private fun checkValid(packet: Long): Boolean {
        val data1 = ((packet ushr 40) and 0xFFFF).toInt()
        val data2 = ((packet.inv() ushr 8) and 0xFFFF).toInt()
        val data3 = ((packet ushr 32) and 0xFF).toInt()
        val data4 = ((packet.inv() and 0xFF).toInt() - 1) and 0xFF
        return data1 == data2 && data3 == data4
    }

    companion object {
        private val PACKET_HEADER = 0xFD000000AA000000uL.toLong()
        private val PACKET_HEADER_MASK = 0xFF000000FF000000uL.toLong()
    }
}
