// Port of the building blocks ProtoPirate's car-key decoders stand on (RocketGod-git/ProtoPirate, GPL-3.0): the
// Flipper Zero SubGhz decoder blocks (lib/subghz/blocks/decoder.c, math.c, generic.h), its Manchester state machine
// (lib/toolbox/manchester_decoder.c), KeeLoq (lib/subghz/protocols/keeloq_common.c), and ProtoPirate's own helpers
// (protocols/protocols_common.h). Receive only: no encoder ships in the app.
//
// Unsigned C types map to Kotlin like this: uint64_t is a Long (always shifted right with ushr), uint32_t is a Long
// holding 0..0xFFFFFFFF, uint16_t / uint8_t are Ints holding 0..0xFFFF / 0..0xFF. Byte buffers are IntArrays of 0..255.
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/** Which demodulator a protocol listens behind (ProtoPirate's AM and FM registries). */
enum class PPModulation { AM, FM }

/** One decoded frame, the way ProtoPirate's get_string shows it. */
data class PPHit(
    val name: String,
    val bits: Int,
    /** The raw key (all the bits, hex), for display and de-duplication. */
    val key: String,
    val serial: Long?,
    val btn: String?,
    val cnt: Long?,
    /** Every other line ProtoPirate prints, in order. */
    val fields: List<MeshField>,
)

/** The value of a named field ("" when absent), for the ports' cString overrides. */
fun PPHit.field(n: String): String = fields.firstOrNull { it.name == n }?.value ?: ""

/** Flipper's SubGhzBlockConst. */
data class PPConst(val teShort: Int, val teLong: Int, val teDelta: Int, val minBits: Int)

const val M32 = 0xFFFFFFFFL

/** C printf-style hex formatting ("%08X" and friends) of an unsigned value held in a Long. */
fun hx(fmt: String, vararg v: Long): String = String.format(java.util.Locale.US, fmt, *v.toTypedArray())

/** Flipper's ManchesterState / ManchesterEvent and manchester_advance. */
object PPManchester {
    const val SHORT_LOW = 0; const val SHORT_HIGH = 2; const val LONG_LOW = 4; const val LONG_HIGH = 6; const val RESET = 8
    const val START1 = 0; const val MID1 = 1; const val MID0 = 2; const val START0 = 3
    private val transitions = intArrayOf(0b00000001, 0b10010001, 0b10011011, 0b11111011)

    /** Returns the next state in bits 0..7 and, when a bit completes, the bit in bit 8 with bit 9 set. */
    fun advance(state: Int, event: Int): Int {
        if (event == RESET) return MID1
        val ns = (transitions[state] ushr event) and 0x3
        if (ns == state) return MID1
        if (ns == MID0) return ns or 0x200
        if (ns == MID1) return ns or 0x300
        return ns
    }
}

/**
 * The base of every ported ProtoPirate decoder: Flipper's SubGhzBlockDecoder (parser step, last duration, the bits
 * so far) and SubGhzBlockGeneric (the decoded data, serial, button, counter), plus a header counter and a Manchester
 * state, which nearly all of them carry.
 */
abstract class PPDecoder(val name: String, val modulation: PPModulation, val c: PPConst) {
    var parserStep = 0
    var teLast = 0
    var headerCount = 0
    var decodeData = 0L
    var decodeCountBit = 0
    var manchester = PPManchester.MID1
    // SubGhzBlockGeneric
    var data = 0L
    var dataCountBit = 0
    var serial = 0L
    var btn = 0
    var cnt = 0L
    var onHit: ((PPHit) -> Unit)? = null

    /** One pulse: level high or low, its length in microseconds. */
    abstract fun feed(level: Boolean, duration: Int)
    open fun reset() { parserStep = 0; decodeData = 0; decodeCountBit = 0; headerCount = 0; manchester = PPManchester.MID1 }

    /** What get_string prints for the frame just decoded (called right after the decoder fills its fields). */
    open fun describe(): PPHit =
        PPHit(name, dataCountBit, hx("%016X", data), serial, hx("%X", btn.toLong()), cnt, emptyList())

    /**
     * ProtoPirate's get_string text for a hit, its lines joined with " | " (the form the golden fixtures from the
     * C harness use). Each port overrides this with its protocol's exact format; the default is only a fallback.
     */
    open fun cString(h: PPHit): String {
        val parts = mutableListOf("${h.name} ${h.bits}bit", "Key:${h.key}")
        h.serial?.let { parts.add(hx("Sn:%08X", it)) }
        h.btn?.let { parts.add("Btn:$it") }
        h.cnt?.let { parts.add(hx("Cnt:%X", it)) }
        for (f in h.fields) parts.add("${f.name}:${f.value}")
        return parts.joinToString(" | ")
    }

    /** The decoder's callback (instance->base.callback). */
    fun emit() { onHit?.invoke(describe()) }

    // ---- Flipper blocks ----
    fun dd(a: Int, b: Int): Int = kotlin.math.abs(a - b)   // DURATION_DIFF
    fun isShort(d: Int): Boolean = dd(d, c.teShort) < c.teDelta   // pp_is_short
    fun isLong(d: Int): Boolean = dd(d, c.teLong) < c.teDelta     // pp_is_long
    fun addBit(bit: Int) { decodeData = (decodeData shl 1) or (bit.toLong() and 1L); decodeCountBit++ }   // blocks_add_bit
    fun addBit(bit: Boolean) = addBit(if (bit) 1 else 0)

    /** subghz_protocol_blocks_add_to_128_bit: the bit that falls off the top of decodeData moves into the head. */
    fun addBitTo128(bit: Int, head: Long): Long {
        var h = head
        decodeCountBit++
        if (decodeCountBit > 64) h = (h shl 1) or (decodeData ushr 63)
        decodeData = (decodeData shl 1) or (bit.toLong() and 1L)
        return h
    }

    /** pp_manchester_event: short/long by duration, the level picking Low/High (high pulse = ...Low event, as in C). */
    fun manchesterEvent(duration: Int, level: Boolean): Int {
        if (isShort(duration)) return if (level) PPManchester.SHORT_LOW else PPManchester.SHORT_HIGH
        if (isLong(duration)) return if (level) PPManchester.LONG_LOW else PPManchester.LONG_HIGH
        return PPManchester.RESET
    }

    /** manchester_advance on this decoder's own state: -1 when no bit completes, else the bit (0 or 1). */
    fun manchesterAdvance(e: Int): Int {
        val r = PPManchester.advance(manchester, e)
        manchester = r and 0xFF
        return if (r and 0x200 != 0) (r ushr 8) and 1 else -1
    }
}

/** lib/subghz/blocks/math.c and ProtoPirate's byte helpers. */
object PPMath {
    fun bitRead(v: Long, i: Int): Long = (v ushr i) and 1L
    fun reverseKey(key: Long, bitCount: Int): Long {
        var r = 0L
        for (i in 0 until bitCount) r = (r shl 1) or bitRead(key, i)
        return r
    }
    fun parity(key: Long, bitCount: Int): Int {
        var p = 0
        for (i in 0 until bitCount) p += bitRead(key, i).toInt()
        return p and 1
    }
    fun crc4(m: IntArray, poly: Int, initial: Int): Int {
        var r = (initial shl 4) and 0xFF; val p = (poly shl 4) and 0xFF
        for (b in m) { r = r xor b; repeat(8) { r = if (r and 0x80 != 0) ((r shl 1) xor p) and 0xFF else (r shl 1) and 0xFF } }
        return (r ushr 4) and 0x0F
    }
    fun crc7(m: IntArray, poly: Int, initial: Int): Int {
        var r = (initial shl 1) and 0xFF; val p = (poly shl 1) and 0xFF
        for (b in m) { r = r xor b; repeat(8) { r = if (r and 0x80 != 0) ((r shl 1) xor p) and 0xFF else (r shl 1) and 0xFF } }
        return (r ushr 1) and 0x7F
    }
    fun crc8(m: IntArray, poly: Int, initial: Int): Int {
        var r = initial and 0xFF
        for (b in m) { r = r xor b; repeat(8) { r = if (r and 0x80 != 0) ((r shl 1) xor poly) and 0xFF else (r shl 1) and 0xFF } }
        return r
    }
    fun crc8le(m: IntArray, poly: Int, initial: Int): Int {
        var r = reverseBits8(initial); val p = reverseBits8(poly)
        for (b in m) { r = r xor b; repeat(8) { r = if (r and 1 != 0) (r ushr 1) xor p else r ushr 1 } }
        return r
    }
    fun crc16lsb(m: IntArray, poly: Int, initial: Int): Int {
        var r = initial and 0xFFFF
        for (b in m) { r = r xor b; repeat(8) { r = if (r and 1 != 0) (r ushr 1) xor poly else r ushr 1 } }
        return r
    }
    fun crc16(m: IntArray, poly: Int, initial: Int): Int {
        var r = initial and 0xFFFF
        for (b in m) { r = r xor (b shl 8); repeat(8) { r = if (r and 0x8000 != 0) ((r shl 1) xor poly) and 0xFFFF else (r shl 1) and 0xFFFF } }
        return r
    }
    fun lfsrDigest8(m: IntArray, gen: Int, key0: Int): Int {
        var sum = 0; var key = key0
        for (d in m) for (i in 7 downTo 0) { if ((d ushr i) and 1 != 0) sum = sum xor key; key = if (key and 1 != 0) (key ushr 1) xor gen else key ushr 1 }
        return sum and 0xFF
    }
    fun lfsrDigest8Reflect(m: IntArray, gen: Int, key0: Int): Int {
        var sum = 0; var key = key0
        for (j in m.indices.reversed()) { val d = m[j]; for (i in 0 until 8) { if ((d ushr i) and 1 != 0) sum = sum xor key; key = if (key and 0x80 != 0) ((key shl 1) xor gen) and 0xFF else (key shl 1) and 0xFF } }
        return sum and 0xFF
    }
    fun lfsrDigest16(m: IntArray, gen: Int, key0: Int): Int {
        var sum = 0; var key = key0
        for (d in m) for (i in 7 downTo 0) { if ((d ushr i) and 1 != 0) sum = sum xor key; key = if (key and 1 != 0) (key ushr 1) xor gen else key ushr 1 }
        return sum and 0xFFFF
    }
    fun addBytes(m: IntArray): Int = m.sum() and 0xFF
    fun parity8(b0: Int): Int { var b = b0 xor (b0 ushr 4); b = b and 0xF; return (0x6996 ushr b) and 1 }
    fun parityBytes(m: IntArray): Int = m.fold(0) { a, b -> a xor parity8(b) }
    fun xorBytes(m: IntArray): Int = m.fold(0) { a, b -> a xor b }
    /** pp_reverse_bits8, pp_u64_to_bytes_be, pp_bytes_to_u64_be */
    fun reverseBits8(v: Int): Int = reverseKey(v.toLong() and 0xFF, 8).toInt()
    fun u64ToBytesBE(v: Long): IntArray = IntArray(8) { ((v ushr (56 - 8 * it)) and 0xFF).toInt() }
    fun bytesToU64BE(b: IntArray): Long { var r = 0L; for (i in 0 until minOf(8, b.size)) r = (r shl 8) or (b[i].toLong() and 0xFF); return r }
}

/** lib/subghz/protocols/keeloq_common.c (32-bit values held in Longs, 0..0xFFFFFFFF). */
object KeeLoq {
    private const val NLF = 0x3A5C742E
    private fun bit(x: Int, n: Int): Int = (x ushr n) and 1
    private fun bit64(x: Long, n: Int): Int = ((x ushr n) and 1L).toInt()
    private fun g5(x: Int, a: Int, b: Int, c: Int, d: Int, e: Int): Int =
        bit(x, a) + bit(x, b) * 2 + bit(x, c) * 4 + bit(x, d) * 8 + bit(x, e) * 16

    fun encrypt(data: Long, key: Long): Long {
        var x = data.toInt()
        for (r in 0 until 528) x = (x ushr 1) xor ((bit(x, 0) xor bit(x, 16) xor bit64(key, r and 63) xor bit(NLF, g5(x, 1, 9, 20, 26, 31))) shl 31)
        return x.toLong() and M32
    }
    fun decrypt(data: Long, key: Long): Long {
        var x = data.toInt()
        for (r in 0 until 528) x = (x shl 1) xor bit(x, 31) xor bit(x, 15) xor bit64(key, (15 - r) and 63) xor bit(NLF, g5(x, 0, 8, 19, 25, 30))
        return x.toLong() and M32
    }
    fun normalLearning(data0: Long, key: Long): Long {
        var d = (data0 and 0x0FFFFFFF) or 0x20000000
        val k1 = decrypt(d, key)
        d = (d and 0x0FFFFFFF) or 0x60000000
        val k2 = decrypt(d, key)
        return (k2 shl 32) or k1
    }
    fun secureLearning(data: Long, seed: Long, key: Long): Long {
        val k1 = decrypt(data and 0x0FFFFFFF, key); val k2 = decrypt(seed and M32, key)
        return (k1 shl 32) or k2
    }
}

/**
 * Manufacturer keys. ProtoPirate reads them from the Flipper's own keystore; none are shipped. A decoder that needs
 * one shows the frame as received (encrypted) when it is absent.
 */
object PPKeys {
    @JvmStatic var kiaMf: Long? = null
    @JvmStatic var kiaV6A: Long? = null
    @JvmStatic var kiaV6B: Long? = null
    @JvmStatic var kiaV5: Long? = null
}
