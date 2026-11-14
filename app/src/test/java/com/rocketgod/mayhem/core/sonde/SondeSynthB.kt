package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.sonde.SondeSynth.FlightPoint
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Test signals for the RS92, LMS6-403 / LMSX, LMS6-1680 and MRZ decoders: frames built the way each sonde builds them
 * (CRCs, Reed-Solomon parity, convolutional code, Manchester, 8N1) and their channel symbols for fskIq(). The Kotlin
 * twin of web/src/dsp/sonde/synth-b.ts.
 */
object SondeSynthB {
    private fun putLe16(b: IntArray, p: Int, v: Int) { b[p] = v and 255; b[p + 1] = (v shr 8) and 255 }
    private fun putLe24(b: IntArray, p: Int, v: Int) { b[p] = v and 255; b[p + 1] = (v shr 8) and 255; b[p + 2] = (v shr 16) and 255 }
    private fun putLe32(b: IntArray, p: Int, v: Long) { for (k in 0 until 4) b[p + k] = ((v shr (8 * k)) and 255).toInt() }
    private fun putBe16(b: IntArray, p: Int, v: Int) { b[p] = (v shr 8) and 255; b[p + 1] = v and 255 }
    private fun putBe24(b: IntArray, p: Int, v: Int) { b[p] = (v shr 16) and 255; b[p + 1] = (v shr 8) and 255; b[p + 2] = v and 255 }
    private fun putBe32(b: IntArray, p: Int, v: Long) { for (k in 0 until 4) b[p + k] = ((v shr (8 * (3 - k))) and 255).toInt() }
    private fun f32Bytes(v: Double): IntArray { val x = v.toFloat().toRawBits(); return IntArray(4) { (x shr (8 * it)) and 255 } }

    /** Bits to 8N1 symbols: start 0, data least significant first, stop 1. */
    fun uartBits(bytes: IntArray): IntArray {
        val out = IntArray(bytes.size * 10)
        for (i in bytes.indices) { out[10 * i] = 0; for (k in 0 until 8) out[10 * i + 1 + k] = (bytes[i] shr k) and 1; out[10 * i + 9] = 1 }
        return out
    }

    // ---------------------------------------------------------------- RS92

    /**
     * Test calibration: T = -80 + 50x, RH = 50x (both sensors), P = 500x, with y0 = 1.5 for each, where
     * x = 1 / (y0 - (ref1 - m) / (ref1 - ref)). In ascending index order (the order JavaScript lists them).
     */
    val RS92_TEST_COEF: List<Pair<Int, Double>> = listOf(
        10 to 0.0, 11 to 500.0, 12 to 0.0, 13 to 0.0, 14 to 0.0, 15 to 0.0, 17 to 1.5,
        30 to -80.0, 31 to 50.0, 32 to 0.0, 33 to 0.0, 34 to 0.0, 35 to 0.0, 37 to 1.5,
        40 to 0.0, 41 to 50.0, 42 to 0.0, 43 to 0.0, 44 to 0.0, 45 to 0.0, 47 to 1.5,
        50 to 0.0, 51 to 50.0, 52 to 0.0, 53 to 0.0, 54 to 0.0, 55 to 0.0, 57 to 1.5,
    )
    private const val RS92_REF1 = 1_000_000
    private const val RS92_REF3 = 700_000
    private const val RS92_REF4 = 600_000
    /** The NGP test key (any 16 bytes). */
    private val NGP_KEY = IntArray(16) { (0x5a + 37 * it) and 255 }
    /** Which CALX170 byte keys each key position. */
    private val NGP_PERM = intArrayOf(0, 1, 4, 2, 3, 5, 6, 9, 7, 8, 10, 11, 14, 12, 13, 15)

    /** A 512-byte RS92 calibration table (32 rows) as the sonde sends it; scrambled the NGP way when [ngp]. */
    fun rs92CalTable(txKHz: Int = 402_150, killS: Int = 0x1234, ngp: Boolean = false, coef: List<Pair<Int, Double>> = RS92_TEST_COEF): IntArray {
        val c = IntArray(512)
        val code = Math.round((txKHz - (if (ngp) 1_600_000 else 400_000)) / 10.0).toInt()
        putLe16(c, 2, code); putLe16(c, 4, killS)
        for (i in 6 until 0x40) c[i] = (i * 29 + 7) and 255
        // records [index, float32] from 0x40, the first 40 slots (the last ones overlap the 0x170 key bytes)
        for ((r, kv) in coef.withIndex()) {
            val at = 0x40 + 5 * r; val fb = f32Bytes(kv.second)
            c[at] = kv.first
            if (ngp) { c[at + 1] = fb[2]; c[at + 2] = fb[0]; c[at + 3] = fb[1]; c[at + 4] = fb[3] }
            else { c[at + 1] = fb[0]; c[at + 2] = fb[1]; c[at + 3] = fb[2]; c[at + 4] = fb[3] }
        }
        for (i in 0 until 16) c[0x170 + i] = Rs92.CALX170[i]
        if (ngp) {
            for (j in 0 until 330) if (0x40 + j < 0x170 || 0x40 + j >= 0x180) c[0x40 + j] = c[0x40 + j] xor NGP_KEY[j % 16]
            for (i in 0 until 16) c[0x170 + i] = NGP_KEY[i] xor Rs92.CALX170[NGP_PERM[i]]
        }
        return c
    }

    /** PTU counts [temp, hum1, hum2, ref1, ref2, pres, ref3, ref4] that read back as these values with RS92_TEST_COEF. */
    fun rs92PtuCounts(tempC: Double, rh1: Double, rh2: Double, hPa: Double): IntArray {
        fun count(v: Double, a0: Double, a1: Double, ref: Int): Int {
            val x = (v - a0) / a1; val y = 1.5 - 1 / x
            return Math.round(RS92_REF1 - y * (RS92_REF1 - ref)).toInt()
        }
        return intArrayOf(count(tempC, -80.0, 50.0, RS92_REF4), count(rh1, 0.0, 50.0, RS92_REF3), count(rh2, 0.0, 50.0, RS92_REF3), RS92_REF1, 900_000,
            count(hPa, 0.0, 500.0, RS92_REF4), RS92_REF3, RS92_REF4)
    }

    class Rs92Opts(
        val serial: String, val frame: Int, val cal: IntArray, val ptu: IntArray, val towMs: Long,
        /** Satellites tracked (PRN 1..31), up to 12. */
        val prns: IntArray, val aux: IntArray = IntArray(4), val ngp: Boolean = false,
    )

    /** One 240-byte RS92 frame: blocks, CRCs, RS parity. */
    fun rs92Frame(o: Rs92Opts): IntArray {
        val fr = IntArray(240)
        Rs92.HEADER_BYTES.copyInto(fr, 0)
        fun block(pos: Int, id: Int, words: Int, fill: (Int) -> Unit) {
            fr[pos] = id; fr[pos + 1] = words; fill(pos + 2)
            putLe16(fr, pos + 2 + 2 * words, ReedSolomon.crc16ccitt(fr, pos + 2, 2 * words))
        }
        val row = o.frame % 32
        block(0x06, 0x65, 0x10) { d ->
            putLe16(fr, d, o.frame); fr[d + 2] = 0x20; fr[d + 3] = 0x20
            for (i in 0 until 8) fr[d + 4 + i] = o.serial[i].code
            fr[d + 15] = row
            for (i in 0 until 16) fr[d + 16 + i] = o.cal[row * 16 + i]
        }
        block(0x2a, 0x69, 0x0c) { d ->
            for (k in 0 until 8) putLe24(fr, d + 3 * k, o.ptu[k])
            if (o.ngp) {
                val key = IntArray(16); Rs92.ptuKey(o.cal, key)
                for (j in 0 until 24) fr[d + j] = fr[d + j] xor fr[0x08 + (j and 1)] xor key[j % 16]
            }
        }
        block(0x46, 0x67, 0x3d) { d ->
            putLe32(fr, d, o.towMs)
            for (w in 0 until 4) {
                var word = 0
                for (c in 0 until 3) { val ch = 3 * w + c; if (ch < o.prns.size) word = word or ((o.prns[ch] and 0x1f) shl (5 * c)) }
                putLe16(fr, d + 6 + 2 * w, word)
            }
            for (ch in 0 until 12) {
                fr[d + 14 + ch] = if (ch < o.prns.size) 0x0f else 0x00
                putLe32(fr, d + 26 + 8 * ch, if (ch < o.prns.size) 0x00200000L + ch * 0x1111 else 0x7fffffffL)
                putLe24(fr, d + 30 + 8 * ch, if (ch < o.prns.size) 0x001000 + ch else 0)
            }
        }
        block(0xc4, 0x68, 0x05) { d ->
            fr[d] = 3; fr[d + 1] = 3
            for (i in 0 until 4) putLe16(fr, d + 2 + 2 * i, o.aux[i])
        }
        intArrayOf(0xff, 0x02, 0x02, 0x00, 0x02, 0x00).copyInto(fr, 0xd2)
        Rs92.parity(fr)
        return fr
    }

    /** The channel symbols of a frame: 8N1, LSB first, each bit as Manchester 0 = 10, 1 = 01. */
    fun rs92Symbols(fr: IntArray): IntArray = SondeSynth.manchesterOf(uartBits(fr), false)

    // ---------------------------------------------------------------- LMS6-403 / LMSX

    private const val B60B60 = (1 shl 30) / 90.0

    class LmsOpts(val sn: Int, val frame: Int, val towMs: Long, val p: FlightPoint, val sub05: Boolean = false)

    /** One 223-byte LMS6-403 frame with its CRC. */
    fun lms6Frame(o: LmsOpts): IntArray {
        val fr = IntArray(Lms6.FRAME)
        intArrayOf(0x24, 0x54, 0x00, if (o.sub05) 0x05 else 0x00).copyInto(fr, 0)
        putBe32(fr, 4, (o.sn and 0xffffff).toLong())
        putBe16(fr, 8, o.frame)
        putBe32(fr, 10, o.towMs)
        putBe32(fr, 18, Math.round(o.p.lat * B60B60)); putBe32(fr, 22, Math.round(o.p.lon * B60B60))
        putBe32(fr, 26, Math.round(o.p.alt * 1000))
        putBe24(fr, 30, Math.round(o.p.vE * 1000).toInt() and 0xffffff)
        putBe24(fr, 33, Math.round(o.p.vN * 1000).toInt() and 0xffffff)
        putBe24(fr, 36, Math.round(o.p.vU * 1000).toInt() and 0xffffff)
        for (i in 39 until 221) fr[i] = (i * 7 + o.frame) and 0x3f
        putBe16(fr, 221, ReedSolomon.crc16ccitt(fr, 0, 221, 0))
        return fr
    }

    /** One 223-byte LMSX frame with its CRC. */
    fun lmsxFrame(o: LmsOpts): IntArray {
        val fr = IntArray(Lms6.FRAME)
        intArrayOf(0x24, 0x46, 0x05, 0x00).copyInto(fr, 0)
        putBe32(fr, 4, (o.sn and 0xffffff).toLong())
        putBe16(fr, 8, o.frame)
        val bits = (o.towMs / 1000.0).toRawBits()
        for (k in 0 until 4) { fr[14 + k] = ((bits shr (8 * (7 - k))) and 255).toInt(); fr[10 + k] = ((bits shr (8 * (3 - k))) and 255).toInt() }
        putBe32(fr, 18, Math.round(o.p.lat * 1e7)); putBe32(fr, 22, Math.round(o.p.lon * 1e7)); putBe32(fr, 26, Math.round(o.p.alt * 100))
        var hd = atan2(o.p.vE, o.p.vN) * 180 / PI; if (hd < 0) hd += 360
        putBe16(fr, 30, Math.round(hypot(o.p.vE, o.p.vN) * 100).toInt() and 0xffff)
        putBe16(fr, 32, Math.round(hd * 100).toInt() and 0xffff)
        putBe16(fr, 34, Math.round(o.p.vU * 100).toInt() and 0xffff)
        for (i in 36 until 221) fr[i] = (i * 5 + o.frame) and 0x3f
        putBe16(fr, 221, ReedSolomon.crc16ccitt(fr, 0, 221, 0))
        return fr
    }

    /** A 223-byte message as the 255-byte codeword the sonde sends: message first, then the 32 parity bytes. */
    fun lmsCodeword(msg: IntArray): IntArray {
        val cw = IntArray(255)
        for (j in 0 until Lms6.FRAME) cw[254 - j] = msg[j]
        Lms6.RS_CCSDS.encode(cw)
        return IntArray(255) { cw[254 - it] }
    }

    /**
     * LMS6-403 bytes on air: the frames laid end to end with [fill] bytes of 0xCA between them, cut into 223-byte RS
     * messages, each sent as a 260-byte block (sync, message, parity).
     */
    fun lms6Blocks(frames: List<IntArray>, fill: Int = 34): IntArray {
        val stream = ArrayList<Int>()
        for (f in frames) { for (b in f) stream.add(b); repeat(fill) { stream.add(0xca) } }
        while (stream.size % Lms6.FRAME != 0) stream.add(0xca)
        val nb = stream.size / Lms6.FRAME; val out = IntArray(nb * 260)
        for (k in 0 until nb) {
            Lms6.SYNC.copyInto(out, 260 * k)
            lmsCodeword(stream.subList(k * Lms6.FRAME, (k + 1) * Lms6.FRAME).toIntArray()).copyInto(out, 260 * k + 5)
        }
        return out
    }

    /** LMSX bytes on air: per frame (one a second) the sync, the codeword, 40 fill bytes. */
    fun lmsxUnits(frames: List<IntArray>): IntArray {
        val out = IntArray(frames.size * 300)
        for (k in frames.indices) {
            Lms6.SYNC.copyInto(out, 300 * k)
            lmsCodeword(frames[k]).copyInto(out, 300 * k + 5)
            for (i in 260 until 300) out[300 * k + i] = 0xca
        }
        return out
    }

    /** Bytes to LMS channel symbols: bits LSB first, convolutional code from the zero state, sent as (c0, NOT c1). */
    fun lmsSymbols(bytes: IntArray): IntArray {
        val bits = SondeSynth.bitsOf(bytes, true); val code = IntArray(2 * bits.size)
        Conv.encode(bits, 0, code, 0)
        return IntArray(code.size) { if (it and 1 != 0) 1 - code[it] else code[it] }
    }

    // ---------------------------------------------------------------- LMS6-1680 (Mk2a)

    /** A 0x54 (GPS) subframe: 172 data bytes and the CRC. */
    fun mk2aGps(id: Int, frame: Int, towMs: Long, p: FlightPoint, rep: Int = 0x32): IntArray {
        val b = IntArray(174)
        intArrayOf(0x24, 0x52, 0x54, rep).copyInto(b, 0)
        putBe16(b, 4, id and 0xffff); putBe16(b, 6, frame); b[8] = 0x00; b[9] = 0xa2
        putBe32(b, 10, towMs)
        putBe32(b, 18, Math.round(p.lat * 0xb60b60)); putBe32(b, 22, Math.round(p.lon * 0xb60b60))
        putBe32(b, 26, Math.round(p.alt * 1000))
        putBe24(b, 30, Math.round(p.vE * 1000).toInt() and 0xffffff); putBe24(b, 33, Math.round(p.vN * 1000).toInt() and 0xffffff)
        putBe24(b, 36, Math.round(p.vU * 1000).toInt() and 0xffffff)
        for (i in 39 until 172) b[i] = (i * 11 + frame) and 0x7f
        putBe16(b, 172, ReedSolomon.crc16ccitt(b, 0, 172, 0))
        return b
    }

    /** A 0x4D (config) subframe carrying the full serial: 66 data bytes and the CRC. */
    fun mk2aConfig(id: Int, frame: Int, rep: Int = 0x31): IntArray {
        val b = IntArray(68)
        intArrayOf(0x24, 0x52, 0x4d, rep).copyInto(b, 0)
        putBe16(b, 4, id and 0xffff); putBe16(b, 6, frame)
        for (i in 8 until 50) b[i] = (i * 3) and 0x7f
        b[50] = (id shr 8) and 255; b[51] = id and 255; b[52] = (id ushr 24) and 255; b[53] = (id shr 16) and 255
        for (i in 54 until 66) b[i] = 0x0f
        putBe16(b, 66, ReedSolomon.crc16ccitt(b, 0, 66, 0))
        return b
    }

    /** Subframes on air: idle CA bytes, then each subframe after CA CA CA, with [gap] CA bytes after it. */
    fun mk2aSymbols(subs: List<IntArray>, gap: Int = 10): IntArray {
        val bytes = ArrayList<Int>()
        repeat(6) { bytes.add(0xca) }
        for (s in subs) { repeat(3) { bytes.add(0xca) }; for (b in s) bytes.add(b); repeat(gap) { bytes.add(0xca) } }
        return uartBits(bytes.toIntArray())
    }

    // ---------------------------------------------------------------- MRZ

    class MrzOpts(val slot: Int, val word: Long, val h: Int, val m: Int, val s: Int, val p: FlightPoint, val sats: Int, val tempC: Double, val rh: Double,
                  val latlon: Boolean = false)

    /** One MRZ frame (50 bytes ECEF, 47 lat/lon), CRC filled. */
    fun mrzFrame(o: MrzOpts): IntArray {
        val ll = o.latlon; val b = IntArray(if (ll) 47 else 50); val x = if (ll) -3 else 0
        b[0] = 0xaa; b[1] = 0xbf; b[2] = 0x35; b[3] = 0x80 or (o.slot and 0x0f)
        b[4] = o.h; b[5] = o.m; b[6] = o.s
        if (ll) {
            putLe32(b, 7, Math.round(o.p.lat * 1e6)); putLe32(b, 11, Math.round(o.p.lon * 1e6)); putLe32(b, 15, Math.round(o.p.alt * 100))
            var hd = atan2(o.p.vE, o.p.vN) * 180 / PI; if (hd < 0) hd += 360
            putLe16(b, 19, Math.round(hypot(o.p.vE, o.p.vN) * 100).toInt()); putLe16(b, 21, Math.round(hd * 100).toInt())
            b[30] = 0xff; b[31] = 0xff
        } else {
            val e = geoToEcef(o.p.lat, o.p.lon, o.p.alt); val v = neuToEcefVel(o.p.vN, o.p.vE, o.p.vU, o.p.lat, o.p.lon)
            putLe32(b, 8, Math.round(e[0] * 100)); putLe32(b, 12, Math.round(e[1] * 100)); putLe32(b, 16, Math.round(e[2] * 100))
            putLe16(b, 20, Math.round(v[0] * 100).toInt()); putLe16(b, 22, Math.round(v[1] * 100).toInt()); putLe16(b, 24, Math.round(v[2] * 100).toInt())
        }
        b[26 + x] = o.sats
        putLe16(b, 29 + x, Math.round(o.tempC * 100).toInt()); putLe16(b, 31 + x, Math.round(o.rh * 100).toInt())
        putLe32(b, 35 + x, 1_234_500L); putLe32(b, 39 + x, 2_345_600L)
        b[43 + x] = (o.slot + 1) and 0xff
        putLe32(b, 44 + x, o.word and 0xffffffffL)
        val n = if (ll) 42 else 45
        putLe16(b, 3 + n, Mrz.crc16modbus(b, 3, n))
        return b
    }

    /** Frames on air, each [repeats] times: AA AA, the frame (from its own AA), AA AA after. Manchester 1 = 10, MSB first. */
    fun mrzSymbols(frames: List<IntArray>, repeats: Int = 6): IntArray {
        val bytes = arrayListOf(0xaa, 0xaa)
        for (f in frames) for (r in 0 until repeats) {
            bytes.add(0xaa); for (v in f) bytes.add(v)
            if (r == repeats - 1) { bytes.add(0x00); bytes.add(0x00) } else { bytes.add(0xaa); bytes.add(0xaa) }
        }
        return SondeSynth.manchesterOf(SondeSynth.bitsOf(bytes.toIntArray(), false), true)
    }
}
