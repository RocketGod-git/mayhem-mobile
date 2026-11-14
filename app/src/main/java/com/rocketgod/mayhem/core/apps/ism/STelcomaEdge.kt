package com.rocketgod.mayhem.core.apps.ism

/**
 * Telcoma / Cardin EDGE remotes, 433.92 MHz AM, 32-bit Manchester fixed code (Flipper Unleashed
 * lib/subghz/protocols/telcoma_edge.c). Each pulse is split into half-bits (Te 1270 us), paired high-to-low = 1 and
 * low-to-high = 0, and any other duration ends the frame. The gate channel is 32 bits; the other channels carry a
 * one-hot marker that makes 33 bits (the extra trailing bit is dropped). A key must start with 0xFF; payload[23:3] is
 * the serial and payload[2:0] the one-hot channel. Receive only.
 */
class STelcomaEdge : FProto(Fam.REMOTE, S.TELCOMA_EDGE) {
    private var rx = 0L
    private var halfPending = false
    private var halfLevel = false
    init { teShort = 1270; teLong = 2540; teDelta = 520; minCountBitForFound = 32 }

    private fun addHalf(level: Boolean) {
        if (!halfPending) { halfPending = true; halfLevel = level; return }
        halfPending = false
        if (halfLevel && !level) addBit(1)
        else if (!halfLevel && level) addBit(0)
        // same-level pair: phase violation, no bit
    }

    override fun feed(level: Boolean, duration: Int) {
        if (dd(duration, teShort) < teDelta) addHalf(level)
        else if (dd(duration, teLong) < teDelta) { addHalf(level); addHalf(level) }
        else {
            // End of a burst: publish a complete frame.
            val count = decodeCountBit
            if (count == 32 || count == 33) {
                val key = (if (count == 33) decodeData ushr 1 else decodeData) and 0xFFFFFFFFL
                if ((key ushr 24) == 0xFFL) {
                    decodeData = key; dataCountBit = minCountBitForFound; rx = key
                    hit()
                }
            }
            decodeData = 0; decodeCountBit = 0; halfPending = false
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val payload = rx and 0xFFFFFFL
        return RemoteInfo(RemoteFields.name(sensorType), (payload ushr 3) and 0x1FFFFFL, (payload and 0x7L).toInt(), null, emptyList())
    }
}
