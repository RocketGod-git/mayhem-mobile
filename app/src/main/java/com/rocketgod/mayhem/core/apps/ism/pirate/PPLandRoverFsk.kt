// Land Rover FSK: a receive-only decoder for a Land Rover key fob that ProtoPirate does not cover (its "Land Rover V0"
// is an alias of Honda V2, a different protocol). Worked out from recordings of a real fob at 315 MHz; not a port of
// any C source.
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * On air: 2-FSK, about ±23 kHz deviation, Manchester at 64 µs per half bit (7.8 kbit/s). One press sends each frame
 * on three channels about 318 kHz apart (around 314.69, 315.005 and 315.32 MHz), each after a 50 ms bare carrier.
 * A frame is a run of 1010 preamble bits, then 144 bits (18 bytes, MSB first, a half bit high then low = 1):
 *
 *   bytes 0..4   fixed (D3 68 3C 0E 24 on the fob this was built from)
 *   byte  5      channel << 3: 0 = 315.005, 1 = the lower channel, 2 = the upper channel
 *   bytes 6..7   fixed (A8 24)
 *   bytes 8..15  hop: 64 bits that change on every repeat; encrypted, shown as received, never decrypted
 *   bytes 16..17 CRC-16 (poly 0x1021, init 0) over bytes 4..15
 *
 * The frame starts on the first repeated bit after at least 8 alternating preamble bits. Whether bytes 0..4 are a
 * per-fob ID or a sync word shared by every fob of this type is not known, so no serial is claimed; no button or
 * counter is visible in the clear. The same hop heard again on another channel is not shown again.
 */
class PPLandRoverFsk : PPDecoder("Land Rover FSK", PPModulation.FM, PPConst(64, 128, 32, 144)) {
    companion object {
        private const val FRAME_BITS = 144; private const val FRAME_BYTES = 18
        private const val PREAMBLE_MIN = 8
        /** Half bits held for one frame: preamble (about 50 bits) plus 144 data bits, two half bits each, with room to spare. */
        private const val HALF_CAP = 512

        private fun hexBytes(k: IntArray, from: Int, to: Int): String = (from..to).joinToString("") { hx("%02X", k[it].toLong()) }
    }

    private val half = IntArray(HALF_CAP)
    private var halfCount = 0
    private var frame = IntArray(FRAME_BYTES)
    private var last = IntArray(FRAME_BYTES)
    private var lastValid = false

    override fun reset() { super.reset(); halfCount = 0; lastValid = false }

    /** Manchester pairs from one half-bit phase: 1 (high, low), 0 (low, high), -1 for a broken pair. */
    private fun pairs(phase: Int): IntArray {
        val n = maxOf(0, (halfCount - phase) shr 1)
        return IntArray(n) { j ->
            val a = half[phase + 2 * j]; val b = half[phase + 2 * j + 1]
            if (a == b) -1 else a
        }
    }

    /** The 18 bytes from bit [start], or null when a pair is broken, the channel byte is not one of the three, or the CRC fails. */
    private fun frameAt(bits: IntArray, start: Int): IntArray? {
        val f = IntArray(FRAME_BYTES)
        for (i in 0 until FRAME_BITS) {
            val b = bits[start + i]
            if (b < 0) return null
            if (b != 0) f[i shr 3] = f[i shr 3] or (0x80 ushr (i and 7))
        }
        if (f[5] and 0xE7 != 0 || (f[5] shr 3) > 2) return null
        if (PPMath.crc16(f.copyOfRange(4, 16), 0x1021, 0) != ((f[16] shl 8) or f[17])) return null
        return f
    }

    private fun process() {
        for (phase in 0 until 2) {
            val bits = pairs(phase)
            var run = 0
            var i = 1
            while (i + FRAME_BITS <= bits.size) {
                if (bits[i] < 0 || bits[i - 1] < 0) { run = 0; i++; continue }
                if (bits[i] != bits[i - 1]) { run++; i++; continue }
                val enough = run >= PREAMBLE_MIN
                run = 0
                if (enough) {
                    val f = frameAt(bits, i)
                    if (f != null) { commit(f); return }
                }
                i++
            }
        }
    }

    private fun commit(f: IntArray) {
        // The same frame on another channel differs only in byte 5 and the CRC.
        var same = lastValid
        var i = 0
        while (same && i < 16) { if (i != 5 && f[i] != last[i]) same = false; i++ }
        if (same) return
        frame = f; last = f.copyOf(); lastValid = true
        dataCountBit = FRAME_BITS
        emit()
    }

    override fun feed(level: Boolean, duration: Int) {
        val k = if (isShort(duration)) 1 else if (isLong(duration)) 2 else 0
        if (k == 0 || halfCount + k > HALF_CAP) {
            // A pulse longer than a long one at the end of a frame still starts with the last half bit.
            if (k == 0 && duration > c.teLong && halfCount < HALF_CAP) half[halfCount++] = if (level) 1 else 0
            if (halfCount >= 2 * FRAME_BITS) process()
            halfCount = 0
            if (k == 0) return
        }
        repeat(k) { half[halfCount++] = if (level) 1 else 0 }
    }

    override fun describe(): PPHit {
        val k = frame
        return PPHit(name, dataCountBit, hexBytes(k, 0, 17), null, null, null,
            listOf(MeshField("Fixed", hexBytes(k, 0, 4) + " " + hexBytes(k, 6, 7)), MeshField("Ch", (k[5] shr 3).toString()),
                MeshField("Hop", hexBytes(k, 8, 15)), MeshField("Crc", hexBytes(k, 16, 17))))
    }

    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Fixed:${h.field("Fixed")} Ch:${h.field("Ch")} | " +
            "Hop:${h.field("Hop")} Crc:${h.field("Crc")}"
}
