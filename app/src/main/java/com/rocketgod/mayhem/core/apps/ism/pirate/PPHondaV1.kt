// Port of ProtoPirate protocols/honda_v1.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Honda V1: AM, 1000 / 2000 µs symbols after a preamble with at least one long, 68 bits ending on a gap over 3500 µs:
 * 28-bit serial, button nibble, 16-bit counter, then a 4-bit CRC (one of two accepted values).
 */
class PPHondaV1 : PPDecoder("Honda V1", PPModulation.AM, PPConst(1000, 2000, 400, 68)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_DATA = 2
        private const val BIT_COUNT = 68; private const val TE_SHORT = 1000; private const val TE_LONG = 2000; private const val TE_DELTA = 400
        private const val TE_SHORT_MIN = 600; private const val TE_END = 3500
        private const val VALID_MAX = 0x4B

        private fun buttonValid(b: Int) = b <= 10 && ((0x701 ushr b) and 1) != 0
        fun buttonName(b: Int): String = when (b) { 0 -> "Unlock"; 8 -> "Lock"; 9 -> "Trunk"; 10 -> "Panic"; else -> "Unknown" }
        private fun durationIs(d: Int, t: Int) = if (d >= t) d - t <= TE_DELTA else t - d <= TE_DELTA

        private fun crcFold(v: Int): Int {
            val lo = v and 0x0F
            val hi = v ushr 4
            val s = if ((hi and 1) != 0) lo else -lo
            var out = (s - hi) and 7
            out = out or (((v ushr 3) and 1) shl 3)
            if (((v ushr 1) and 1) != 0 && (((v ushr 4) xor (v ushr 5)) and 1) != 0) out = out xor 0x04
            return out and 0x0F
        }
        private fun checksumBase(data: Long): Int {
            val a = crcFold((data and 0xFFFF).toInt())
            val b = crcFold(((data ushr 40) and 0xFF).toInt())
            return (a xor b xor 1) and 0x0F
        }
        private fun checksumAlternate(c: Int): Int {
            var mask = 0x09
            if (c and 1 == 0) mask = if ((c and 2) != 0) 0x0B else 0x0F
            return (c xor mask) and 0x0F
        }
        fun crcValid(data: Long, crc: Int): Boolean {
            val c = checksumBase(data); val o = checksumAlternate(c)
            val f = if ((c and 0x08) != 0) o else c; val s = if ((c and 0x08) != 0) c else o
            val k = crc and 0x0F
            return k == f || k == s
        }
    }

    private var preambleCount = 0
    private var preambleHasLong = false
    private var dataPending = false
    private var lastLevel = false
    private var bits = IntArray(12)
    private var bitCount = 0
    private var pending = 0
    private var pendingValid = false
    private var k2 = 0

    private fun decodeFields() {
        val low = data and M32
        serial = (data ushr 36) and 0x0FFFFFFF
        btn = ((low ushr 28) and 0x0F).toInt()
        cnt = low and 0xFFFF
        dataCountBit = BIT_COUNT
    }

    private fun stateReset() {
        parserStep = STEP_RESET
        preambleCount = 0; preambleHasLong = false; dataPending = false; lastLevel = false
        bitCount = 0
        bits = IntArray(12)
    }

    private fun addBitH(bit: Boolean) {
        if (bitCount > VALID_MAX) return
        if (bit) bits[bitCount shr 3] = bits[bitCount shr 3] or (1 shl (bitCount.inv() and 0x07))
        bitCount++
    }

    private fun commit(): Boolean {
        if (bitCount < BIT_COUNT) return false
        val aligned = bits.copyOf()
        var shiftCount = bitCount - BIT_COUNT
        if (shiftCount < 1) shiftCount = 1
        repeat(shiftCount) {
            for (i in 0 until aligned.size - 1) aligned[i] = ((aligned[i] shl 1) or (aligned[i + 1] ushr 7)) and 0xFF
            aligned[aligned.size - 1] = (aligned[aligned.size - 1] shl 1) and 0xFF
        }
        val button = aligned[4] ushr 4
        if (!buttonValid(button)) return false
        data = PPMath.bytesToU64BE(aligned)
        k2 = aligned[8] ushr 4
        decodeFields()
        emit()
        return true
    }

    private fun symbol(level: Boolean, duration: Int) {
        val sh = durationIs(duration, TE_SHORT)
        val lg = durationIs(duration, TE_LONG)
        if (!sh && !lg) {
            if (!level && duration > TE_END && parserStep == STEP_DATA) commit()
            stateReset()
            return
        }
        if (parserStep == STEP_RESET) {
            if (level) { parserStep = STEP_PREAMBLE; preambleCount = 1; lastLevel = level }
            return
        }
        if (parserStep == STEP_PREAMBLE) {
            if (lg) {
                if (preambleCount < 0xFF) preambleCount++
                preambleHasLong = true; lastLevel = level
                return
            }
            if (sh) {
                if (preambleHasLong && preambleCount > 5) {
                    parserStep = STEP_DATA
                    bitCount = 0
                    bits = IntArray(12)
                    dataPending = true; lastLevel = level
                    return
                }
                if (preambleCount < 0xFF) preambleCount++
                lastLevel = level
                return
            }
            stateReset()
            return
        }
        if (sh) {
            if (dataPending) { addBitH(level); dataPending = false; lastLevel = level; return }
            dataPending = true; lastLevel = level
        } else {
            if (dataPending) addBitH(level) else addBitH(lastLevel)
            lastLevel = level
        }
    }

    override fun reset() { super.reset(); pending = 0; pendingValid = false; stateReset() }

    override fun feed(level: Boolean, duration: Int) {
        if (duration < TE_DELTA) { pending += duration; pendingValid = true; return }
        if (pendingValid) {
            val p = pending
            if (level) { pending = p + duration; pendingValid = true; return }
            if (p >= TE_SHORT_MIN) symbol(true, p)
            pending = 0; pendingValid = false
        }
        if (level) { pending = duration; pendingValid = true; return }
        symbol(false, duration)
    }

    override fun describe(): PPHit {
        decodeFields()
        val k = k2 and 0x0F
        val ok = crcValid(data, k)
        return PPHit(name, dataCountBit, hx("%016X", data), serial, buttonName(btn), cnt,
            listOf(MeshField("Crc", hx("%X [", k.toLong()) + (if (ok) "OK" else "ERR") + "]")))
    }

    /** honda_v1.c get_string: "%s %dbit\r\nKey:%016llX\r\nBtn:%s\r\nSn:%07lX Cnt:%04lX\r\nCrc:%X [%s]". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Btn:${h.btn ?: ""} | " + hx("Sn:%07X Cnt:%04X", h.serial ?: 0, h.cnt ?: 0) +
            " | Crc:${h.fields.firstOrNull()?.value ?: ""}"
}
