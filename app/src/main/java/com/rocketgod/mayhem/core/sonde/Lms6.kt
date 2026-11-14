package com.rocketgod.mayhem.core.sonde

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Lockheed Martin LMS6-403 and LMSX (403 MHz): 4800 baud NRZ FSK (LMSX 4797.8), a rate-1/2 K=7 convolutional code
 * sent as (c0, NOT c1), info bits packed least significant bit first, CCSDS RS(255,223) blocks behind the sync
 * 00 58 F3 3F B8. Fields are big-endian.
 *
 * LMS6-403 sends a 260-byte block per header (5 sync + 255 RS). The 223-byte RS messages, laid end to end, carry a
 * stream of 223-byte data frames (sync 24 54 00 00, CRC16-XMODEM at the end) with fill between them, one frame per
 * second, so a frame usually straddles two blocks. LMSX sends one 300-byte unit per second: the sync, the codeword
 * whose message is the frame itself (sync 24 46 05 00) and 40 fill bytes. The Kotlin twin of web/src/dsp/sonde/lms6.ts.
 */
object Lms6 {
    const val BAUD = 4800.0
    const val LMSX_BAUD = 4797.8
    /** The on-air symbols of 58 F3 3F B8 (each code pair as c0, NOT c1): the header both types search for. */
    const val HEADER = "0101011000001000" + "0001110010010111" + "0001101010100111" + "0011110100111110"
    /** The block sync bytes. The leading 0x00 flushes the encoder, so the header above never depends on earlier data. */
    val SYNC = intArrayOf(0x00, 0x58, 0xf3, 0x3f, 0xb8)
    /** Code symbols of the sync, the block and the LMSX unit. */
    private const val SYNC_SYMS = 80
    const val BLOCK = 260
    const val LMSX_UNIT = 300
    /** Channel symbols the framer hands over after the header: the rest of one block (or unit). */
    const val SYMS = BLOCK * 16 - SYNC_SYMS
    const val LMSX_SYMS = LMSX_UNIT * 16 - SYNC_SYMS
    /** The LMSX frame sync. */
    internal val LMSX_SYNC = intArrayOf(0x24, 0x46, 0x05, 0x00)
    /** The frame (and RS message) length. */
    const val FRAME = 223

    /** CCSDS RS(255,223) in the plain polynomial basis: field 0x187, roots alpha^(11*(112+i)). */
    val RS_CCSDS = ReedSolomon(0x187, 112, 11, 32)

    /** Encoder state after the sync (both types). */
    val SYNC_STATE: Int = Conv.state(IntArray(SYNC.size * 8) { (SYNC[it / 8] shr (it % 8)) and 1 }, 0)

    /** 2^32 / 360: LMS6 latitude and longitude units. */
    private const val B60B60 = (1 shl 30) / 90.0

    internal fun be16(b: IntArray, p: Int) = (b[p] shl 8) or b[p + 1]
    internal fun be32(b: IntArray, p: Int) = (b[p] shl 24) or (b[p + 1] shl 16) or (b[p + 2] shl 8) or b[p + 3]
    internal fun be24s(b: IntArray, p: Int): Int { var v = (b[p] shl 16) or (b[p + 1] shl 8) or b[p + 2]; if (v > 0x7fffff) v -= 0x1000000; return v }
    internal fun be16s(b: IntArray, p: Int) = (be16(b, p) shl 16) shr 16
    private val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    /** The frame's CRC16-XMODEM over bytes 0..220, stored big-endian at 221..222. */
    fun crcOk(fr: IntArray, p: Int = 0): Boolean = ReedSolomon.crc16ccitt(fr, p, FRAME - 2, 0) == be16(fr, p + FRAME - 2)

    /** Correct one RS codeword whose first transmitted byte (the highest power) is at bytes[p]. -1 = beyond repair. */
    fun rsFix(bytes: IntArray, p: Int, cw: IntArray): Int {
        for (j in 0 until 255) cw[254 - j] = bytes[p + j]
        val n = RS_CCSDS.decode(cw)
        if (n < 0) return -1
        for (j in 0 until 255) bytes[p + j] = cw[254 - j]
        return n
    }

    /** One checked 223-byte frame (LMS6-403 when [x] is false, LMSX when true). Null when the CRC fails. */
    fun parse(fr: IntArray, x: Boolean, p: Int = 0): SondeFrame? {
        if (!crcOk(fr, p)) return null
        if (x) { if (fr[p] != 0x24 || fr[p + 1] != 0x46 || fr[p + 2] != 0x05 || fr[p + 3] != 0x00) return null }
        else if (fr[p] != 0x24 || fr[p + 1] != 0x54 || fr[p + 2] != 0x00 || (fr[p + 3] != 0x00 && fr[p + 3] != 0x05)) return null
        if (fr[p + 5] == 0) return null
        val sn = (fr[p + 5] shl 16) or (fr[p + 6] shl 8) or fr[p + 7]
        val out = SondeFrame(type = "LMS6", model = if (x) "LMSX" else if (fr[p + 3] == 0x05) "LMS6-403-2" else "LMS6-403",
            serial = "${if (x) "LMSX" else "LMS6"}-$sn", frame = be16(fr, p + 8))
        val towS: Double = if (x) {
            // an IEEE-754 double in seconds: two big-endian words, the low word first
            var bits = 0L
            for (k in 0 until 4) bits = (bits shl 8) or fr[p + 14 + k].toLong()
            for (k in 0 until 4) bits = (bits shl 8) or fr[p + 10 + k].toLong()
            Double.fromBits(bits)
        } else be32(fr, p + 10) / 1000.0
        if (towS.isFinite() && towS >= 0 && towS < 7 * 86400) {
            out.timeS = towS % 86400
            out.put("GPS WEEKDAY", WEEKDAYS[floor(towS / 86400).toInt()])
        }
        val lat: Double; val lon: Double; val alt: Double
        if (x) { lat = be32(fr, p + 18) / 1e7; lon = be32(fr, p + 22) / 1e7; alt = be32(fr, p + 26) / 100.0 }
        else { lat = be32(fr, p + 18) / B60B60; lon = be32(fr, p + 22) / B60B60; alt = be32(fr, p + 26) / 1000.0 }
        if (alt >= -200 && alt <= 60000 && abs(lat) <= 90 && abs(lon) <= 180) {
            out.lat = lat; out.lon = lon; out.alt = alt
            if (x) {
                out.vH = be16s(fr, p + 30) / 100.0
                out.heading = be16(fr, p + 32) / 100.0
                out.climb = be16s(fr, p + 34) / 100.0
            } else {
                val vE = be24s(fr, p + 30) / 1e3; val vN = be24s(fr, p + 33) / 1e3; val vU = be24s(fr, p + 36) / 1e3
                out.vH = hypot(vE, vN)
                var h = atan2(vE, vN) * 180 / PI; if (h < 0) h += 360
                out.heading = h; out.climb = vU
            }
        }
        return out
    }
}

/** Soft symbols after the header to info bytes: undo the inverted c1, Viterbi, pack LSB first. */
private class LmsInner(val blockBytes: Int) {
    private val nBits = (blockBytes - Lms6.SYNC.size) * 8
    private val vit = Viterbi(nBits)
    private val pairs = FloatArray(2 * nBits)
    private val bits = IntArray(nBits)
    /** The whole block, sync included, as bytes. */
    val block = IntArray(blockBytes)
    var lastVitFixed = 0

    /** Fill [block] from soft symbols (polarity already matched to the header). */
    fun run(soft: FloatArray) {
        val n = min(soft.size shr 1, nBits)
        for (k in 0 until n) { pairs[2 * k] = soft[2 * k]; pairs[2 * k + 1] = -soft[2 * k + 1] }
        for (k in 2 * n until 2 * nBits) pairs[k] = 0f
        lastVitFixed = vit.decode(pairs, 0, nBits, Lms6.SYNC_STATE, bits)
        for (i in Lms6.SYNC.indices) block[i] = Lms6.SYNC[i]
        for (i in 0 until blockBytes - Lms6.SYNC.size) {
            var v = 0
            for (k in 0 until 8) v = v or (bits[8 * i + k] shl k)
            block[Lms6.SYNC.size + i] = v
        }
    }
}

/**
 * LMS6-403: block by block, the RS messages joined into a byte stream, frames found in it by their sync and CRC.
 * [decode]'s `contiguous` says whether this block followed the previous one without a gap (else the stream starts over).
 */
class Lms6Decoder {
    private val inner = LmsInner(Lms6.BLOCK)
    private val cw = IntArray(255)
    private val stream = IntArray(3 * Lms6.FRAME)
    private var len = 0
    private var fixedRun = 0

    /** Decode one block's soft symbols (after the header). Returns the frames it completed. */
    fun decode(soft: FloatArray, contiguous: Boolean): List<SondeFrame> {
        inner.run(soft)
        return blockBytes(inner.block, contiguous)
    }

    /** One 260-byte block, sync included (tests feed these directly). */
    fun blockBytes(block: IntArray, contiguous: Boolean): List<SondeFrame> {
        val out = ArrayList<SondeFrame>()
        val fixed = Lms6.rsFix(block, Lms6.SYNC.size, cw)
        if (fixed < 0) { len = 0; return out }
        if (!contiguous) len = 0
        if (len + Lms6.FRAME > stream.size) len = 0
        for (i in 0 until Lms6.FRAME) stream[len + i] = block[Lms6.SYNC.size + i]
        len += Lms6.FRAME
        val fixedHere = fixed
        var p = 0; var keep = -1
        while (p + 4 <= len) {
            val s = stream
            if (s[p] == 0x24 && s[p + 1] == 0x54 && s[p + 2] == 0x00 && (s[p + 3] == 0x00 || s[p + 3] == 0x05)) {
                if (p + Lms6.FRAME > len) { keep = p; break }
                val f = Lms6.parse(s, false, p)
                if (f != null) {
                    f.fixed = fixedRun + fixedHere
                    if (inner.lastVitFixed != 0) f.put("VITERBI FIXED", "${inner.lastVitFixed} symbols")
                    out.add(f)
                    p += Lms6.FRAME
                    continue
                }
            }
            p++
        }
        // keep a frame in progress, or the last 3 bytes (a sync split across blocks)
        val from = if (keep >= 0) keep else max(p, len - 3)
        stream.copyInto(stream, 0, from, len)
        len -= from
        fixedRun = if (keep >= 0) fixedHere else 0
        return out
    }
}

/** LMSX: one unit per second, the frame is the RS message of the codeword at block byte 5 (or 40, 45). */
class LmsxDecoder {
    private val inner = LmsInner(Lms6.LMSX_UNIT)
    private val cw = IntArray(255)
    private val tmp = IntArray(Lms6.LMSX_UNIT)

    fun decode(soft: FloatArray): SondeFrame? {
        inner.run(soft)
        return unit(inner.block, inner.lastVitFixed)
    }

    /** One 300-byte unit, sync included. */
    fun unit(block: IntArray, vitFixed: Int = 0): SondeFrame? {
        val at = intArrayOf(5, 40, 45)
        for (a in at.indices) {
            val pos = at[a]
            if (pos + 255 > block.size) continue
            // a quick look first: the frame sync within two bytes' worth of errors, or the first position always
            var m = 0
            for (j in 0 until 4) if (block[pos + j] == Lms6.LMSX_SYNC[j]) m++
            if (m < 2 && a > 0) continue
            block.copyInto(tmp)
            val fixed = Lms6.rsFix(tmp, pos, cw)
            if (fixed < 0) continue
            val f = Lms6.parse(tmp, true, pos) ?: continue
            f.fixed = fixed
            if (vitFixed != 0) f.put("VITERBI FIXED", "$vitFixed symbols")
            return f
        }
        return null
    }
}
