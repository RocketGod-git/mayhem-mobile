// Port of ProtoPirate protocols/honda_static.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Honda Static: FM (Honda1 route), a symbol stream of ~63 µs elements (short 28..98 µs = one symbol, long 61..191 µs =
 * two), parsed on the first other pulse: an alternating preamble, then 64 Manchester bits (button nibble, 28-bit serial,
 * 24-bit counter, XOR checksum byte), tried inverted first, then plain, then bit-reversed.
 */
class PPHondaStatic : PPDecoder("Honda Static", PPModulation.FM, PPConst(63, 126, 35, 64)) {
    companion object {
        private const val BIT_COUNT = 64; private const val MIN_SYMBOLS = 36
        private const val SHORT_BASE = 28; private const val SHORT_SPAN = 70; private const val LONG_BASE = 61; private const val LONG_SPAN = 130
        private const val SYMBOL_CAPACITY = 512; private const val PREAMBLE_MAX_TRANSITIONS = 19
        private val buttonNames = arrayOf("Lock", "Unlock", "Unknown", "Trunk", "Remote Start", "Unknown", "Unknown", "Panic", "Lock x2")

        private fun getBits(data: IntArray, start: Int, count: Int): Long {
            var value = 0L
            for (i in 0 until count) {
                val bitIndex = (start + i) and 0xFF
                val byte = data[bitIndex ushr 3]
                val shift = bitIndex.inv() and 0x07
                value = ((value shl 1) or ((byte ushr shift) and 1).toLong()) and M32
            }
            return value
        }

        private fun isValidButton(b: Int) = b <= 9 && ((0x336 ushr b) and 1) != 0
        private fun isValidSerial(s: Long) = s != 0L && s != 0x0FFFFFFFL

        fun buttonName(b: Int): String = if (b >= 1 && b <= buttonNames.size) buttonNames[b - 1] else "Unknown"

        private fun compactChecksum(c: IntArray): Int {
            val canonical = intArrayOf(((c[0] shl 4) or (c[1] ushr 4)) and 0xFF, ((c[1] shl 4) or (c[2] ushr 4)) and 0xFF,
                ((c[2] shl 4) or (c[3] ushr 4)) and 0xFF, ((c[3] shl 4) or (c[4] ushr 4)) and 0xFF, c[5], c[6], c[7])
            return PPMath.xorBytes(canonical)
        }

        private fun unpackCompact(key: Long): Fields {
            val c = PPMath.u64ToBytesBE(key)
            val f = Fields()
            f.button = c[0] and 0x0F
            f.serial = (c[1].toLong() shl 20) or (c[2].toLong() shl 12) or (c[3].toLong() shl 4) or (c[4].toLong() ushr 4)
            f.counter = (c[5].toLong() shl 16) or (c[6].toLong() shl 8) or c[7].toLong()
            f.checksum = compactChecksum(c)
            return f
        }

        private fun packCompact(f: Fields): Long {
            val c = intArrayOf(f.button and 0x0F, ((f.serial ushr 20) and 0xFF).toInt(), ((f.serial ushr 12) and 0xFF).toInt(),
                ((f.serial ushr 4) and 0xFF).toInt(), ((f.serial shl 4) and 0xFF).toInt(),
                ((f.counter ushr 16) and 0xFF).toInt(), ((f.counter ushr 8) and 0xFF).toInt(), (f.counter and 0xFF).toInt())
            return PPMath.bytesToU64BE(c)
        }

        private fun validateForward(packet: IntArray): Fields? {
            val button = (getBits(packet, 0, 4) and 0xFF).toInt()
            val serial = getBits(packet, 4, 28)
            val counter = getBits(packet, 32, 24)
            val checksum = (getBits(packet, 56, 8) and 0xFF).toInt()
            val calc = PPMath.xorBytes(packet.copyOfRange(0, 7))
            if (checksum != calc || !isValidButton(button) || !isValidSerial(serial)) return null
            return Fields(serial, counter, button, checksum)
        }

        /** The reverse path computes its checksum but never compares it (as in the C). */
        private fun validateReverse(packet: IntArray): Fields? {
            val reversed = IntArray(packet.size) { PPMath.reverseBits8(packet[it]) }
            val button = (getBits(reversed, 0, 4) and 0xFF).toInt()
            val serial = getBits(reversed, 4, 28)
            val counter = getBits(reversed, 32, 24)
            val checksum = PPMath.xorBytes(reversed.copyOfRange(0, 7))
            if (!isValidButton(button) || !isValidSerial(serial)) return null
            return Fields(serial, counter, button, checksum)
        }
    }

    private class Fields(var serial: Long = 0, var counter: Long = 0, var button: Int = 0, var checksum: Int = 0)

    private var symbolsCount = 0
    private val symbols = IntArray((512 + 7) / 8)

    private fun symbolSet(index: Int, v: Int) {
        val byteIndex = (index ushr 3) and 0xFF
        val mask = 1 shl (index.inv() and 0x07)
        if (v != 0) symbols[byteIndex] = symbols[byteIndex] or mask else symbols[byteIndex] = symbols[byteIndex] and mask.inv() and 0xFF
    }

    private fun symbolGet(index: Int): Int {
        val byteIndex = (index ushr 3) and 0xFF
        return (symbols[byteIndex] ushr (index.inv() and 0x07)) and 1
    }

    private fun manchesterPack64(count: Int, startPos: Int, inverted: Boolean): IntArray? {
        val packet = IntArray(9)
        var pos = startPos; var bitCount = 0
        while (pos + 1 < count) {
            if (bitCount >= BIT_COUNT) break
            val a = symbolGet(pos); val b = symbolGet(pos + 1)
            if (a == b) { pos++; continue }
            val bit = if (inverted) (a == 0 && b == 1) else (a == 1 && b == 0)
            if (bit) packet[bitCount shr 3] = packet[bitCount shr 3] or (1 shl (bitCount.inv() and 0x07))
            bitCount++
            pos += 2
        }
        return if (bitCount >= BIT_COUNT) packet else null
    }

    private fun parseSymbols(inverted: Boolean): Boolean {
        val count = symbolsCount
        var index = 1; var transitions = 0
        while (index < count) {
            if (symbolGet(index) != symbolGet(index - 1)) transitions++
            else {
                if (transitions > PREAMBLE_MAX_TRANSITIONS) break
                transitions = 0
            }
            index++
        }
        if (index >= count) return false
        while (index + 1 < count && symbolGet(index) == symbolGet(index + 1)) index++
        val packet = manchesterPack64(count, index, inverted) ?: return false
        validateForward(packet)?.let { commit(it); return true }
        if (inverted) return false
        validateReverse(packet)?.let { commit(it); return true }
        return false
    }

    private fun commit(d: Fields) {
        dataCountBit = BIT_COUNT
        data = packCompact(d)
        serial = d.serial
        cnt = d.counter
        btn = d.button
        emit()
    }

    override fun reset() { super.reset(); symbolsCount = 0 }

    override fun feed(level: Boolean, duration: Int) {
        val sym = if (level) 1 else 0
        if (duration >= SHORT_BASE && duration - SHORT_BASE <= SHORT_SPAN) {
            if (symbolsCount < SYMBOL_CAPACITY) { symbolSet(symbolsCount, sym); symbolsCount++ }
            return
        }
        if (duration >= LONG_BASE && duration - LONG_BASE <= LONG_SPAN) {
            if (symbolsCount + 2 <= SYMBOL_CAPACITY) {
                symbolSet(symbolsCount, sym); symbolsCount++
                symbolSet(symbolsCount, sym); symbolsCount++
            }
            return
        }
        if (symbolsCount >= MIN_SYMBOLS) {
            if (!parseSymbols(true)) parseSymbols(false)
        }
        symbolsCount = 0
    }

    override fun describe(): PPHit {
        val d = unpackCompact(data)
        return PPHit(name, dataCountBit, hx("%016X", data), d.serial, buttonName(d.button), d.counter,
            listOf(MeshField("Checksum", hx("%02X", d.checksum.toLong()))))
    }

    /** honda_static.c get_string: "%s\r\nKey:%016llX\r\nBtn:%s\r\nSer:%07lX Cnt:%06lX". */
    override fun cString(h: PPHit): String =
        "${h.name} | Key:${h.key} | Btn:${h.btn ?: ""} | " + hx("Ser:%07X Cnt:%06X", h.serial ?: 0, h.cnt ?: 0)
}
