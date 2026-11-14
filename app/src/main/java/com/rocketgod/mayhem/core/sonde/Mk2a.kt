package com.rocketgod.mayhem.core.sonde

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.floor
import kotlin.math.hypot

/**
 * Lockheed Martin LMS6-1680 (and the Sippican Mk2a it grew from): 9616 baud NRZ FSK at 1680 MHz, 8N1 bytes sent least
 * significant bit first, no forward error correction. Between subframes the sonde sends CA bytes; a subframe is
 * CA CA CA 24 52 <type> ... <CRC16-XMODEM, big-endian>, variable length (the CRC finds the end). Type 0x54 carries
 * GPS (time of week, position, velocity), type 0x4D the full 32-bit serial; every subframe is sent twice. Only the
 * low 16 bits of the serial ride in every subframe, so nothing is reported until a 0x4D has given the rest.
 * The Kotlin twin of web/src/dsp/sonde/mk2a.ts.
 */
object Mk2a {
    const val BAUD = 9616
    /** CA CA CA 24 52 as 8N1 symbols (start 0, data LSB first, stop 1). */
    const val HEADER = "0010100111" + "0010100111" + "0010100111" + "0001001001" + "0010010101"
    const val MAX = 176

    /** 0xB60B60 (integer): LMS6-1680 latitude and longitude units, as the reference decoder uses them. */
    internal const val DEG = 0xb60b60.toDouble()
    internal fun be16(b: IntArray, p: Int) = (b[p] shl 8) or b[p + 1]
    internal fun be32(b: IntArray, p: Int) = (b[p] shl 24) or (b[p + 1] shl 16) or (b[p + 2] shl 8) or b[p + 3]
    internal fun be24s(b: IntArray, p: Int): Int { var v = (b[p] shl 16) or (b[p + 1] shl 8) or b[p + 2]; if (v > 0x7fffff) v -= 0x1000000; return v }
    internal val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    /** Candidate bits the CRC repair tries (any one or two of them flipped). */
    internal const val REPAIR_BITS = 16
    /** The data length (CRC excluded) of the subframe types seen on air: 0x54 = 172, 0x4D = 66; 0 = unknown. */
    fun knownLen(type: Int): Int = if (type == 0x54) 172 else if (type == 0x4d) 66 else 0
    /** The shortest data length (CRC excluded) a subframe of this type can have, so a chance CRC match comes later. */
    fun minLen(type: Int): Int = if (type == 0x54) 41 else if (type == 0x4d) 56 else 8

    internal fun crcStep(c0: Int, byte: Int): Int {
        var c = c0 xor (byte shl 8)
        for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xffff else (c shl 1) and 0xffff
        return c
    }

    /**
     * The data length (CRC excluded) of the subframe in b[0 .. n-1]: the first length whose CRC matches the two bytes
     * after it. -1 when none does.
     */
    fun length(b: IntArray, n: Int): Int {
        val min = if (n > 2) minLen(b[2]) else 8
        var c = 0
        var len = 0
        while (len + 2 <= n) {
            if (len >= min && c == be16(b, len)) return len
            c = crcStep(c, b[len]); len++
        }
        return -1
    }
}

class Mk2aDecoder {
    /** Short serial (low 16 bits) to the full serial, from the 0x4D subframes. */
    private val ids = LinkedHashMap<Int, Long>()
    private val lastFrame = LinkedHashMap<Int, Int>()

    /** One subframe, [len] data bytes (b[len], b[len+1] = its CRC). Null for config subframes and repeats. */
    fun parse(b: IntArray, len: Int): SondeFrame? {
        if (len < 6 || b[0] != 0x24 || b[1] != 0x52) return null
        if (ReedSolomon.crc16ccitt(b, 0, len, 0) != Mk2a.be16(b, len)) return null
        val type = b[2]; val short = Mk2a.be16(b, 4)
        if (type == 0x4d) {
            if (len > 54 && b[50] == b[4] && b[51] == b[5]) {
                val id = ((b[52] shl 24) or (b[53] shl 16) or (b[50] shl 8) or b[51]).toLong() and 0xffffffffL
                if (id and 0xffff0000L != 0L) {
                    ids[short] = id
                    if (ids.size > 64) ids.remove(ids.keys.first())
                }
            }
            return null
        }
        if (type != 0x54 || len < 39) return null
        val id = ids[short] ?: return null
        val frame = Mk2a.be16(b, 6)
        if (lastFrame[short] == frame) return null
        lastFrame[short] = frame
        if (lastFrame.size > 64) lastFrame.remove(lastFrame.keys.first())
        val out = SondeFrame(type = "LMS6", model = "LMS6-1680", serial = "LMS6-$id", frame = frame, fixed = 0)
        val tow = (Mk2a.be32(b, 10).toLong() and 0xffffffffL) / 1000.0
        if (tow < 7 * 86400) { out.timeS = tow % 86400; out.put("GPS WEEKDAY", Mk2a.WEEKDAYS[floor(tow / 86400).toInt()]) }
        val lat = Mk2a.be32(b, 18) / Mk2a.DEG; val lon = Mk2a.be32(b, 22) / Mk2a.DEG; val alt = Mk2a.be32(b, 26) / 1000.0
        if (alt >= -100 && alt <= 60000 && abs(lat) <= 90 && abs(lon) <= 180) {
            out.lat = lat; out.lon = lon; out.alt = alt
            val vE = Mk2a.be24s(b, 30) / 1e3; val vN = Mk2a.be24s(b, 33) / 1e3; val vU = Mk2a.be24s(b, 36) / 1e3
            out.vH = hypot(vE, vN)
            var h = atan2(vE, vN) * 180 / PI; if (h < 0) h += 360
            out.heading = h; out.climb = vU
        }
        return out
    }
}

/**
 * Subframes out of channel symbols (from the bank's symbol clock): a 50-symbol header search in both FM polarities,
 * then 8N1 bytes until the CRC closes the subframe (or 176 bytes, or four CA bytes in a row).
 */
class Mk2aCollector(private val sink: SondeSink, private val maxErr: Int = 2) {
    /** The last 50 hard symbols (bit 0 the newest). */
    private var sh = 0L; private var shN = 0
    private val hdr: Long
    private val mask = (1L shl Mk2a.HEADER.length) - 1
    var collecting = false
    private var inv = false
    private val bytes = IntArray(Mk2a.MAX + 2)
    /** crcs[k] = the CRC of bytes 0 .. k-1 of the subframe being collected. */
    private val crcs = IntArray(Mk2a.MAX + 3)
    private var len = 0; private var bitN = 0; private var cur = 0
    /** The soft value of every data bit collected (byte * 8 + bit, positive = 1), and its reliability. */
    private val sv = FloatArray((Mk2a.MAX + 2) * 8)
    private val rel = FloatArray((Mk2a.MAX + 2) * 8)
    /** The last copy that failed its CRC: every subframe is sent twice, so two bad copies can be added up. */
    private val prevSv = FloatArray((Mk2a.MAX + 2) * 8)
    private var prevType = -1; private var prevEnd = -1e9; private var nSym = 0L
    private val cand = IntArray(Mk2a.REPAIR_BITS)
    private val syn = IntArray(Mk2a.REPAIR_BITS)
    private val dec = Mk2aDecoder()

    init {
        var h = 0L
        for (c in Mk2a.HEADER) h = (h shl 1) or (if (c == '1') 1L else 0L)
        hdr = h
    }

    /** One channel symbol (soft: positive = 1). */
    fun symbol(s: Double) {
        val bit = if (s > 0) 1 else 0
        nSym++
        if (collecting) { collect(if (inv) 1 - bit else bit, (if (inv) -s else s).toFloat()); return }
        sh = ((sh shl 1) or bit.toLong()) and mask
        if (++shN < Mk2a.HEADER.length) return
        val e = java.lang.Long.bitCount(sh xor hdr)
        val ei = Mk2a.HEADER.length - e
        if (e <= maxErr || ei <= maxErr) {
            inv = ei < e
            collecting = true; shN = 0
            bytes[0] = 0x24; bytes[1] = 0x52; len = 2
            crcs[0] = 0; crcs[1] = Mk2a.crcStep(0, 0x24); crcs[2] = Mk2a.crcStep(crcs[1], 0x52)
            bitN = 0; cur = 0
        }
    }

    private fun collect(bit: Int, soft: Float) {
        // symbol 0 = start bit, 1..8 = data LSB first, 9 = stop bit
        if (bitN in 1..8) { cur = cur or (bit shl (bitN - 1)); sv[len * 8 + bitN - 1] = soft }
        if (++bitN < 10) return
        val b = cur; bitN = 0; cur = 0
        val n = len; val by = bytes
        by[n] = b; len = n + 1
        crcs[n + 1] = Mk2a.crcStep(crcs[n], b)
        // bytes n-1, n as the CRC of bytes 0 .. n-2
        val dataLen = n - 1
        if (dataLen >= Mk2a.minLen(by[2]) && crcs[dataLen] == ((by[n - 1] shl 8) or b)) {
            collecting = false
            dec.parse(by, dataLen)?.let { sink(it) }
            return
        }
        // a subframe of a known length that missed its CRC: try flipping its least reliable bits
        val known = Mk2a.knownLen(by[2])
        if (known > 0 && len == known + 2) {
            collecting = false
            recover(known)
            return
        }
        if (len >= Mk2a.MAX || (n >= 5 && b == 0xca && by[n - 1] == 0xca && by[n - 2] == 0xca && by[n - 3] == 0xca)) collecting = false
    }

    /** A subframe of a known length whose CRC failed: Chase repair, then the sum with a failed copy just before it. */
    private fun recover(len: Int) {
        val nb = (len + 2) * 8; val by = bytes
        for (i in 16 until nb) rel[i] = abs(sv[i])
        var fixed = repair(len)
        if (fixed == 0 && prevType == by[2] && nSym - prevEnd < 600) {
            val type = by[2]
            for (i in 16 until nb) {
                val v = sv[i] + prevSv[i]
                rel[i] = abs(v)
                val byte = i shr 3; val m = 1 shl (i and 7)
                if (v > 0) by[byte] = by[byte] or m else by[byte] = by[byte] and m.inv()
            }
            by[2] = type
            var c = 0
            for (i in 0 until len) c = Mk2a.crcStep(c, by[i])
            fixed = if (c == ((by[len] shl 8) or by[len + 1])) 1 else repair(len)
            prevType = -1
            if (fixed > 0) { val f = dec.parse(by, len); if (f != null) { f.fixed = fixed; f.put("REPAIR", "two copies combined"); sink(f) } }
            return
        }
        if (fixed > 0) { val f = dec.parse(by, len); if (f != null) { f.fixed = fixed; sink(f) }; return }
        sv.copyInto(prevSv, 0, 0, nb)
        prevType = by[2]; prevEnd = nSym.toDouble()
    }

    /**
     * Chase repair of bytes[0 .. len+1] (data and CRC): the REPAIR_BITS least reliable bits (the 24 52 sync excluded),
     * any one or two of them flipped, accepted when the CRC then matches. The CRC is linear, so each flip's effect on
     * the check is worked out once. Returns the bits flipped, or 0 when no pattern fits.
     */
    private fun repair(len: Int): Int {
        val by = bytes; val k0 = Mk2a.REPAIR_BITS
        var m = 0
        for (i in 16 until (len + 2) * 8) {
            // keep the K smallest, an insertion into a short sorted list
            if (m < k0) cand[m++] = i else if (rel[i] < rel[cand[k0 - 1]]) cand[k0 - 1] = i else continue
            var j = m - 1
            while (j > 0 && rel[cand[j]] < rel[cand[j - 1]]) { val t = cand[j]; cand[j] = cand[j - 1]; cand[j - 1] = t; j-- }
        }
        // the residual: the CRC of the data against the stored CRC
        var c = 0
        for (i in 0 until len) c = Mk2a.crcStep(c, by[i])
        val r = c xor ((by[len] shl 8) or by[len + 1])
        for (k in 0 until m) {
            val byte = cand[k] shr 3; val bitv = 1 shl (cand[k] and 7)
            if (byte >= len) {
                // a bit of the stored CRC (high byte first)
                syn[k] = if (byte == len) bitv shl 8 else bitv
            } else {
                var e = Mk2a.crcStep(0, bitv)
                for (i in byte + 1 until len) e = Mk2a.crcStep(e, 0)
                syn[k] = e
            }
        }
        for (a in 0 until m) {
            if (syn[a] == r) { flip(cand[a]); return 1 }
            for (b in a + 1 until m) if ((syn[a] xor syn[b]) == r) { flip(cand[a]); flip(cand[b]); return 2 }
        }
        return 0
    }

    private fun flip(bit: Int) { bytes[bit shr 3] = bytes[bit shr 3] xor (1 shl (bit and 7)) }
}
