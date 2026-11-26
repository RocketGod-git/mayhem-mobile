package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.max
import kotlin.math.min

/** MSB-first bit reader over one HDC packet (bytes 0..255). */
class Bits(val buf: IntArray, val end: Int = buf.size * 8) {
    var pos = 0
    val left: Int get() = end - pos
    fun bit(): Int {
        if (pos >= end) throw IllegalStateException("HDC packet overrun")
        val b = (buf[pos shr 3] shr (7 - (pos and 7))) and 1; pos++; return b
    }
    fun read(n: Int): Int { var v = 0; for (i in 0 until n) v = (v shl 1) or bit(); return v }
    fun peek(n: Int): Int { val p = pos; val v = read(min(n, left)) shl max(0, n - left); pos = p; return v }
    fun skip(n: Int) { pos += n; if (pos > end) throw IllegalStateException("HDC packet overrun") }
}
