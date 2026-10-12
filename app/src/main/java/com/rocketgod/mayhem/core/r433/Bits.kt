package com.rocketgod.mayhem.core.r433

/*
 * The rtl_433 port's foundations: an unsigned byte view, the two-dimensional bit buffer every device decoder reads
 * from, and the checksum / digest helpers they are built from. Twin of web/src/dsp/r433/bitbuffer.ts and
 * util.ts, which port rtl_433's bitbuffer.c and bit_util.c (GPL-2.0-or-later, Tommy Vestermark and contributors).
 */

/**
 * Bytes read and written as 0..255, as a view onto shared storage. Reads outside the view give 0 and writes
 * outside it are dropped, exactly as a typed array behaves — several decoders read a byte or two past what they
 * extracted and rely on that.
 */
class UBytes(val buf: ByteArray, val off: Int, val size: Int) {
    constructor(n: Int) : this(ByteArray(n), 0, n)

    val length: Int get() = size

    operator fun get(i: Int): Int = if (i < 0 || i >= size) 0 else buf[off + i].toInt() and 0xff
    operator fun set(i: Int, v: Int) { if (i in 0 until size) buf[off + i] = v.toByte() }

    /** A view (no copy), clamped to this one, like subarray. */
    fun sub(from: Int, to: Int = size): UBytes {
        val a = from.coerceIn(0, size); val b = to.coerceIn(a, size)
        return UBytes(buf, off + a, b - a)
    }

    /** A copy, clamped, like slice. */
    fun slice(from: Int = 0, to: Int = size): UBytes {
        val a = from.coerceIn(0, size); val b = to.coerceIn(a, size)
        return UBytes(buf.copyOfRange(off + a, off + b), 0, b - a)
    }

    fun fill(v: Int, from: Int = 0, to: Int = size) { for (i in from.coerceAtLeast(0) until to.coerceAtMost(size)) buf[off + i] = v.toByte() }

    /** Copy [src] in starting at [at], like TypedArray.set. */
    fun setAll(src: UBytes, at: Int = 0) { for (i in 0 until src.size) this[at + i] = src[i] }

    fun toIntArray(): IntArray = IntArray(size) { this[it] }

    fun hex(n: Int = size): String { val sb = StringBuilder(); for (i in 0 until n) sb.append("%02x".format(this[i])); return sb.toString() }

    companion object {
        fun of(vararg v: Int) = UBytes(ByteArray(v.size) { v[it].toByte() }, 0, v.size)
        fun fromHex(h: String) = UBytes(ByteArray(h.length / 2) { h.substring(2 * it, 2 * it + 2).toInt(16).toByte() }, 0, h.length / 2)
    }
}

const val BITBUF_COLS = 128
const val BITBUF_ROWS = 50
const val BITBUF_MAX_ROW_BITS = BITBUF_ROWS * BITBUF_COLS * 8

/** One bit of a byte array, counting from the most significant bit of byte zero. */
fun bitAt(bytes: UBytes, bit: Int): Int = (bytes[bit shr 3] shr (7 - (bit and 7))) and 1

/**
 * The bit buffer. One load-bearing detail from C: rows are views into one flat array, so a row that overruns its
 * 128 bytes spills into the next and a read past the end of a row reads on into the one after it.
 */
class BitBuffer {
    private val buf = ByteArray(BITBUF_ROWS * BITBUF_COLS + 8)
    val bb: Array<UBytes> = Array(BITBUF_ROWS) { UBytes(buf, it * BITBUF_COLS, buf.size - it * BITBUF_COLS) }
    val bitsPerRow = IntArray(BITBUF_ROWS)
    val syncsBeforeRow = IntArray(BITBUF_ROWS)
    var numRows = 0
    private var freeRow = 0

    fun clear() { buf.fill(0); bitsPerRow.fill(0); syncsBeforeRow.fill(0); numRows = 0; freeRow = 0 }

    fun addBit(bit: Int) {
        if (numRows == 0) { freeRow = 1; numRows = 1 }
        val r = numRows - 1
        if (bitsPerRow[r] == 0xffff) return
        val colIndex = bitsPerRow[r] shr 3; val bitIndex = bitsPerRow[r] and 7
        if (bitsPerRow[r] > 0 && bitsPerRow[r] % (BITBUF_COLS * 8) == 0) {
            if (freeRow < BITBUF_ROWS) freeRow++ else return
        }
        bb[r][colIndex] = bb[r][colIndex] or ((bit and 1) shl (7 - bitIndex))
        bitsPerRow[r]++
    }

    fun addRow() {
        if (numRows == 0) { freeRow = 1; numRows = 1 }
        if (freeRow < BITBUF_ROWS) { freeRow++; numRows = freeRow }
        else bitsPerRow[numRows - 1] = 0
    }

    fun addSync() {
        if (numRows == 0) { freeRow = 1; numRows = 1 }
        if (bitsPerRow[numRows - 1] != 0) addRow()
        syncsBeforeRow[numRows - 1]++
    }

    fun setWidth(w0: Int) {
        if (numRows == 0) { freeRow = 1; numRows = 1 }
        val r = numRows - 1
        val remainingBits = (BITBUF_ROWS - numRows + 1) * BITBUF_COLS * 8
        val width = if (w0 > remainingBits) remainingBits else w0
        if (bitsPerRow[r] > width) {
            val b = bb[r]
            b.fill(0, (width + 7) shr 3, (bitsPerRow[r] + 7) shr 3)
            b[width shr 3] = b[width shr 3] and (0xff00 shr (width and 7))
        }
        bitsPerRow[r] = width
        freeRow = numRows + if (width == 0) 0 else (width - 1) / (BITBUF_COLS * 8)
    }

    fun invert() {
        for (row in 0 until numRows) {
            if (bitsPerRow[row] == 0) continue
            val b = bb[row]
            val lastCol = (bitsPerRow[row] - 1) shr 3; val lastBits = ((bitsPerRow[row] - 1) and 7) + 1
            for (col in 0..lastCol) b[col] = b[col].inv()
            b[lastCol] = b[lastCol] xor (0xff shr lastBits)
        }
    }

    fun nrzsDecode() {
        for (row in 0 until numRows) {
            if (bitsPerRow[row] == 0) continue
            val b = bb[row]
            val lastCol = (bitsPerRow[row] - 1) shr 3; val lastBits = ((bitsPerRow[row] - 1) and 7) + 1
            var prev = 0
            for (col in 0..lastCol) {
                val mask = ((prev shl 7) or (b[col] shr 1)) and 0xff
                prev = b[col]
                b[col] = b[col] xor mask.inv()
            }
            b[lastCol] = b[lastCol] and (0xff shl (8 - lastBits))
        }
    }

    fun nrzmDecode() {
        for (row in 0 until numRows) {
            if (bitsPerRow[row] == 0) continue
            val b = bb[row]
            val lastCol = (bitsPerRow[row] - 1) shr 3; val lastBits = ((bitsPerRow[row] - 1) and 7) + 1
            var prev = 0
            for (col in 0..lastCol) {
                val mask = ((prev shl 7) or (b[col] shr 1)) and 0xff
                prev = b[col]
                b[col] = b[col] xor mask
            }
            b[lastCol] = b[lastCol] and (0xff shl (8 - lastBits))
        }
    }

    /** Copy [len] bits out of a row from any bit position, left-aligned into [out]. */
    fun extractBytes(row: Int, pos: Int, out: UBytes, len: Int) {
        val bits = bb[row]
        if (len == 0) return
        if ((pos and 7) == 0) {
            val from = pos shr 3; val n = (len + 7) shr 3
            for (i in 0 until n) out[i] = bits[from + i]
        } else {
            val shift = 8 - (pos and 7)
            var bytes = (len + 7) shr 3
            var p = 0; var byteAt = pos shr 3
            var word = bits[byteAt]
            while (bytes-- > 0) {
                word = ((word shl 8) or bits[++byteAt]) and 0xffff
                out[p++] = word shr shift
            }
        }
        if ((len and 7) != 0) out[(len - 1) shr 3] = out[(len - 1) shr 3] and (0xff00 shr (len and 7))
    }

    fun bytes(row: Int, pos: Int, len: Int): UBytes { val out = UBytes((len + 7) shr 3); extractBytes(row, pos, out, len); return out }

    /** Bit position where [pattern] starts, or the row's length when it is absent. */
    fun search(row: Int, start: Int, pattern: UBytes, patternBitsLen: Int): Int {
        val bits = bb[row]; val len = bitsPerRow[row]
        var ipos = start; var ppos = 0
        while (ipos < len && ppos < patternBitsLen) {
            if (bitAt(bits, ipos) == bitAt(pattern, ppos)) {
                ppos++; ipos++
                if (ppos == patternBitsLen) return ipos - patternBitsLen
            } else { ipos -= ppos; ipos++; ppos = 0 }
        }
        return len
    }

    fun manchesterDecode(row: Int, start: Int, out: BitBuffer, max: Int): Int {
        val bits = bb[row]
        var len = bitsPerRow[row]
        var ipos = start
        if (max != 0 && len > start + max * 2) len = start + max * 2
        while (ipos < len) {
            val bit1 = bitAt(bits, ipos++); val bit2 = bitAt(bits, ipos++)
            if (bit1 == bit2) break
            out.addBit(bit2)
        }
        return ipos
    }

    fun differentialManchesterDecode(row: Int, start: Int, out: BitBuffer, max: Int): Int {
        val bits = bb[row]
        var len = bitsPerRow[row]
        var ipos = start
        var bit1: Int; var bit2 = 0
        if (max != 0 && len > start + max * 2) len = start + max * 2
        while (ipos < len) {
            bit1 = bitAt(bits, ipos++); bit2 = bitAt(bits, ipos++)
            val bit3 = bitAt(bits, ipos)
            if (bit1 != bit2) {
                if (bit2 != bit3) out.addBit(0)
                else { bit2 = bit1; ipos -= 1; break }
            } else { bit2 = 1 - bit1; ipos -= 2; break }
        }
        while (ipos < len) {
            bit1 = bitAt(bits, ipos++)
            if (bit1 == bit2) break
            bit2 = bitAt(bits, ipos++)
            out.addBit(if (bit1 == bit2) 1 else 0)
        }
        return ipos
    }

    fun compareRows(rowA: Int, rowB: Int, maxBits: Int): Boolean {
        val a = bb[rowA]; val b = bb[rowB]
        if (maxBits == 0 || bitsPerRow[rowA] < maxBits || bitsPerRow[rowB] < maxBits) {
            if (bitsPerRow[rowA] != bitsPerRow[rowB]) return false
            val n = (bitsPerRow[rowA] + 7) shr 3
            for (i in 0 until n) if (a[i] != b[i]) return false
            return true
        }
        val last = (maxBits - 1) shr 3; val mask = 0xff00 shr (maxBits and 7)
        for (i in 0 until (maxBits shr 3)) if (a[i] != b[i]) return false
        return (a[last] and mask) == (b[last] and mask)
    }

    fun countRepeats(row: Int, maxBits: Int): Int { var c = 0; for (i in 0 until numRows) if (compareRows(row, i, maxBits)) c++; return c }

    fun findRepeatedRow(minRepeats: Int, minBits: Int): Int {
        for (i in 0 until numRows) if (bitsPerRow[i] >= minBits && countRepeats(i, 0) >= minRepeats) return i
        return -1
    }

    fun findRepeatedPrefix(minRepeats: Int, minBits: Int): Int {
        for (i in 0 until numRows) if (bitsPerRow[i] >= minBits && countRepeats(i, minBits) >= minRepeats) return i
        return -1
    }

    fun rowHex(row: Int): String = bb[row].hex((bitsPerRow[row] + 7) shr 3)

    override fun toString(): String = (0 until numRows).joinToString(" / ") { "{${bitsPerRow[it]}}${rowHex(it)}" }

    companion object {
        /** rtl_433's `{n}hex/{n}hex` notation, as its test vectors and `-y` are written. */
        fun parse(code: String): BitBuffer {
            val bits = BitBuffer()
            var width = -1
            var i = 0
            while (i < code.length) {
                val c = code[i]
                if (c == ' ') { i++; continue }
                if (c == '0' && i + 1 < code.length && (code[i + 1] == 'x' || code[i + 1] == 'X')) { i += 2; continue }
                if (c == '{') {
                    if (width >= 0) bits.setWidth(width)
                    if (bits.numRows > 0) bits.addRow()
                    val close = code.indexOf('}', i)
                    val body = code.substring(i + 1, if (close < 0) code.length else close).trim()
                    width = (if (body.startsWith("0x") || body.startsWith("0X")) body.substring(2).toIntOrNull(16) else body.toIntOrNull()) ?: 0
                    if (width > BITBUF_MAX_ROW_BITS) width = BITBUF_MAX_ROW_BITS
                    if (close < 0) break
                    i = close + 1; continue
                }
                if (c == '/') { if (width >= 0) { bits.setWidth(width); width = -1 }; bits.addRow(); i++; continue }
                val data = c.digitToIntOrNull(16)
                if (data != null) { bits.addBit((data shr 3) and 1); bits.addBit((data shr 2) and 1); bits.addBit((data shr 1) and 1); bits.addBit(data and 1) }
                i++
            }
            if (width >= 0) bits.setWidth(width)
            return bits
        }
    }
}

// ================================================================================================ helpers

fun reverse8(x0: Int): Int {
    var x = x0
    x = ((x and 0xf0) shr 4) or ((x and 0x0f) shl 4)
    x = ((x and 0xcc) shr 2) or ((x and 0x33) shl 2)
    x = ((x and 0xaa) shr 1) or ((x and 0x55) shl 1)
    return x and 0xff
}

fun reflect4(x0: Int): Int {
    var x = x0
    x = ((x and 0xcc) shr 2) or ((x and 0x33) shl 2)
    x = ((x and 0xaa) shr 1) or ((x and 0x55) shl 1)
    return x and 0xff
}

/** All thirty-two bits reversed, as rtl_433's reverse32 does on the little-endian machines it runs on. */
fun reverse32(x: Long): Long =
    ((reverse8((x and 0xff).toInt()).toLong() shl 24) or (reverse8(((x ushr 8) and 0xff).toInt()).toLong() shl 16) or
        (reverse8(((x ushr 16) and 0xff).toInt()).toLong() shl 8) or reverse8(((x ushr 24) and 0xff).toInt()).toLong()) and 0xffffffffL

fun reflectBytes(m: UBytes, n: Int = m.length) { for (i in 0 until n) m[i] = reverse8(m[i]) }
fun reflectNibbles(m: UBytes, n: Int = m.length) { for (i in 0 until n) m[i] = reflect4(m[i]) }

fun addBytes(m: UBytes, n: Int = m.length, at: Int = 0): Int { var s = 0; for (i in 0 until n) s += m[at + i]; return s and 0xff }
fun addNibbles(m: UBytes, n: Int = m.length, at: Int = 0): Int { var s = 0; for (i in 0 until n) s += (m[at + i] shr 4) + (m[at + i] and 0x0f); return s and 0xff }
fun xorBytes(m: UBytes, n: Int = m.length, at: Int = 0): Int { var s = 0; for (i in 0 until n) s = s xor m[at + i]; return s and 0xff }
fun parity8(b: Int): Int { val x = (b xor (b shr 4)) and 0x0f; return (0x6996 shr x) and 1 }
fun parityBytes(m: UBytes, n: Int = m.length, at: Int = 0): Int { var p = 0; for (i in 0 until n) p = p xor parity8(m[at + i]); return p }

fun crc4(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var rem = (init shl 4) and 0xff; val p = (poly shl 4) and 0xff
    for (i in 0 until n) { rem = rem xor m[at + i]; repeat(8) { rem = if ((rem and 0x80) != 0) ((rem shl 1) xor p) and 0xff else (rem shl 1) and 0xff } }
    return (rem shr 4) and 0x0f
}

fun crc7(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var rem = (init shl 1) and 0xff; val p = (poly shl 1) and 0xff
    for (i in 0 until n) { rem = rem xor m[at + i]; repeat(8) { rem = if ((rem and 0x80) != 0) ((rem shl 1) xor p) and 0xff else (rem shl 1) and 0xff } }
    return (rem shr 1) and 0x7f
}

fun crc8(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var r = init and 0xff
    for (byte in 0 until n) { r = r xor m[at + byte]; repeat(8) { r = if ((r and 0x80) != 0) ((r shl 1) xor poly) and 0xff else (r shl 1) and 0xff } }
    return r
}

fun crc8le(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var r = reverse8(init); val p = reverse8(poly)
    for (byte in 0 until n) { r = r xor m[at + byte]; repeat(8) { r = if ((r and 1) != 0) (r shr 1) xor p else r shr 1 } }
    return r and 0xff
}

fun crc16(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var r = init and 0xffff
    for (byte in 0 until n) { r = r xor (m[at + byte] shl 8); repeat(8) { r = if ((r and 0x8000) != 0) ((r shl 1) xor poly) and 0xffff else (r shl 1) and 0xffff } }
    return r and 0xffff
}

fun crc16lsb(m: UBytes, n: Int, poly: Int, init: Int, at: Int = 0): Int {
    var r = init and 0xffff
    for (byte in 0 until n) { r = r xor m[at + byte]; repeat(8) { r = if ((r and 1) != 0) ((r shr 1) xor poly) and 0xffff else r shr 1 } }
    return r and 0xffff
}

fun lfsrDigest8(m: UBytes, bytes: Int, gen: Int, key: Int, at: Int = 0): Int {
    var sum = 0; var k = key and 0xff
    for (b in 0 until bytes) {
        val data = m[at + b]
        for (i in 7 downTo 0) { if (((data shr i) and 1) != 0) sum = sum xor k; k = if ((k and 1) != 0) ((k shr 1) xor gen) and 0xff else k shr 1 }
    }
    return sum and 0xff
}

fun lfsrDigest8Reverse(m: UBytes, bytes: Int, gen: Int, key: Int, at: Int = 0): Int {
    var sum = 0; var k = key and 0xff
    for (b in bytes - 1 downTo 0) {
        val data = m[at + b]
        for (i in 7 downTo 0) { if (((data shr i) and 1) != 0) sum = sum xor k; k = if ((k and 1) != 0) ((k shr 1) xor gen) and 0xff else k shr 1 }
    }
    return sum and 0xff
}

fun lfsrDigest8Reflect(m: UBytes, bytes: Int, gen: Int, key: Int, at: Int = 0): Int {
    var sum = 0; var k = key and 0xff
    for (b in bytes - 1 downTo 0) {
        val data = m[at + b]
        for (i in 0 until 8) { if (((data shr i) and 1) != 0) sum = sum xor k; k = if ((k and 0x80) != 0) ((k shl 1) xor gen) and 0xff else (k shl 1) and 0xff }
    }
    return sum and 0xff
}

fun lfsrDigest16(m: UBytes, bytes: Int, gen: Int, key: Int, at: Int = 0): Int {
    var sum = 0; var k = key and 0xffff
    for (b in 0 until bytes) {
        val data = m[at + b]
        for (i in 7 downTo 0) { if (((data shr i) and 1) != 0) sum = sum xor k; k = if ((k and 1) != 0) ((k shr 1) xor gen) and 0xffff else k shr 1 }
    }
    return sum and 0xffff
}

fun extractNibbles4b1s(m: UBytes, offsetBits: Int, numBits: Int, dst: UBytes): Int {
    var ret = 0; var off = offsetBits; var n = numBits
    while (n >= 5) {
        val bits = ((m[off shr 3] shl 8) or m[(off shr 3) + 1]) shr (11 - (off % 8))
        if ((bits and 1) != 1) break
        dst[ret++] = (bits shr 1) and 0x0f
        off += 5; n -= 5
    }
    return ret
}

/** IBM data whitening (CC1101): a nine-bit register exclusive-ored over the data; the same call undoes it. */
fun ibmWhitening(m: UBytes, n: Int = m.length) {
    var msb = 0x01; var lsb = 0xff
    for (i in 0 until n) {
        m[i] = m[i] xor lsb
        repeat(8) { val prev = msb; msb = (lsb and 0x01) xor ((lsb shr 5) and 0x01); lsb = ((lsb shr 1) and 0xff) or ((prev shl 7) and 0x80) }
    }
}

fun extractBytesUart8n1(m: UBytes, offsetBits: Int, numBits: Int, dst: UBytes): Int {
    var ret = 0; var off = offsetBits; var n = numBits
    while (n >= 10) {
        val startb = m[off shr 3] shr (7 - (off % 8)); off += 1
        var datab = m[off shr 3]
        if (off % 8 != 0) datab = ((m[off shr 3] shl 8) or m[(off shr 3) + 1]) shr (8 - (off % 8))
        off += 8
        val stopb = m[off shr 3] shr (7 - (off % 8)); off += 1
        if ((startb and 1) != 0) break
        if ((stopb and 1) != 1) break
        dst[ret++] = reverse8(datab and 0xff)
        n -= 10
    }
    return ret
}

fun extractBytesUart8n2(m: UBytes, offsetBits: Int, numBits: Int, dst: UBytes): Int {
    var ret = 0; var off = offsetBits; var n = numBits
    while (n > 11) { if (((m[off shr 3] shr (7 - (off % 8))) and 1) == 0) break; off += 1; n -= 1 }
    while (n >= 11) {
        val startb = m[off shr 3] shr (7 - (off % 8)); off += 1
        var datab = m[off shr 3]
        if (off % 8 != 0) datab = ((m[off shr 3] shl 8) or m[(off shr 3) + 1]) shr (8 - (off % 8))
        off += 8
        val stopb1 = m[off shr 3] shr (7 - (off % 8)); off += 1
        val stopb2 = m[off shr 3] shr (7 - (off % 8)); off += 1
        if ((startb and 1) != 0) break
        if ((stopb1 and 1) != 1) break
        if ((stopb2 and 1) != 1) break
        dst[ret++] = reverse8(datab and 0xff)
        n -= 11
        if (ret >= dst.length) break
    }
    return ret
}
