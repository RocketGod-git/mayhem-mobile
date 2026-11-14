package com.rocketgod.mayhem.core.sonde

import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.min

/**
 * Meteosis MTS01: 1200 baud NRZ 2-FSK ('1' = upper tone), header AA AA B4 2B, then 131 bytes most significant bit
 * first: one lead byte, a 128-byte comma-separated ASCII record (NUL padded) and a CRC-16 (polynomial 0x8005, init
 * 0xFFFF, result bit-reversed, stored little-endian) over the record. The slicer follows the header's polarity; the
 * CRC decides. The Kotlin twin of web/src/dsp/sonde/mts01.ts and Mts01.swift.
 */
object Mts01 {
    const val BAUD = 1200
    const val HEADER = "10101010101010101011010000101011"
    internal const val HDR = 0xaaaab42b.toInt()
    const val BYTES = 131
    const val SYMS = BYTES * 8
    internal const val DATLEN = 128

    /** CRC-16 0x8005 / 0xFFFF over bytes[off .. off+len-1], the result's 16 bits reversed. */
    fun crc(bytes: IntArray, off: Int, len: Int): Int {
        var rem = 0xffff
        for (i in 0 until len) {
            rem = rem xor ((bytes[off + i] and 0xff) shl 8)
            for (j in 0 until 8) rem = (if (rem and 0x8000 != 0) (rem shl 1) xor 0x8005 else rem shl 1) and 0xffff
        }
        var re = 0
        for (j in 0 until 16) if (rem and (1 shl (15 - j)) != 0) re = re or (1 shl j)
        return re
    }

    /** Degrees C from the thermistor reading (kilohms; Beta 3000 K, 15 k at 0 °C). */
    fun tempFromR(r: Double): Double {
        if (!(r > 0)) return Double.NaN
        return 1 / (1 / 273.15 + ln(r / 15.0) / 3000.0) - 273.15
    }

    /** A field as JavaScript's Number() reads it: NaN when it is not a number. */
    internal fun jsNumber(s: String): Double {
        val t = s.trim()
        if (t.isEmpty()) return 0.0
        return t.toDoubleOrNull()?.takeIf { !t.endsWith("d", true) && !t.endsWith("f", true) } ?: Double.NaN
    }
}

class Mts01Decoder {
    private val fb = IntArray(Mts01.BYTES)

    fun decode(soft: FloatArray): SondeFrame? {
        val n = min(Mts01.BYTES, soft.size shr 3)
        for (i in 0 until n) { var v = 0; for (k in 0 until 8) v = (v shl 1) or (if (soft[8 * i + k] > 0) 1 else 0); fb[i] = v }
        for (i in n until Mts01.BYTES) fb[i] = 0
        return parse(fb)
    }

    /** The 131 bytes after the header. */
    fun parse(fb: IntArray): SondeFrame? {
        val crc = (fb[130] shl 8) or fb[129]
        if (Mts01.crc(fb, 1, Mts01.DATLEN) != crc) return null
        // the record: printable ASCII up to the first NUL
        val sb = StringBuilder()
        for (i in 1..Mts01.DATLEN) {
            val c = fb[i]
            if (c == 0) break
            if (c < 0x20 || c > 0x7e) return null
            sb.append(c.toChar())
        }
        val fld = sb.toString().split(",")
        if (fld.size < 8) return null
        val id = fld[0].take(8).trim()
        if (id.isEmpty()) return null
        val out = SondeFrame(type = "MTS01", model = "MTS01", serial = "MTS01-$id", fixed = 0)
        fun num(k: Int): Double = if (k < fld.size && fld[k].trim().isNotEmpty()) Mts01.jsNumber(fld[k]) else Double.NaN
        val cnt = num(2)
        if (cnt.isFinite()) out.frame = cnt.toLong().toInt()
        val dt = fld.getOrNull(3) ?: ""
        if (Regex("^\\d{12}$").matches(dt)) {
            val yy = dt.substring(0, 2).toInt(); val mo = dt.substring(2, 4).toInt(); val dd = dt.substring(4, 6).toInt()
            val hh = dt.substring(6, 8).toInt(); val mi = dt.substring(8, 10).toInt(); val ss = dt.substring(10, 12).toInt()
            if (mo in 1..12 && dd in 1..31) out.date = "${2000 + yy}-${dt.substring(2, 4)}-${dt.substring(4, 6)}"
            if (hh < 24 && mi < 60 && ss < 61) out.timeS = (hh * 3600 + mi * 60 + ss).toDouble()
        }
        val batt = num(4)
        if (batt.isFinite() && batt > 0) out.battV = batt.toLong() / 1000.0
        val lat = num(5); val lon = num(6); val alt = num(7)
        if (lat.isFinite() && lon.isFinite() && abs(lat) <= 90 && abs(lon) <= 180) {
            out.lat = lat; out.lon = lon
            if (alt.isFinite()) out.alt = alt
        }
        val hd = num(8); val vH = num(9)
        if (hd.isFinite() && hd >= 0 && hd <= 360) out.heading = hd
        if (vH.isFinite()) out.vH = vH
        val t = Mts01.tempFromR(num(11))
        if (t.isFinite() && t > -120 && t < 80) out.tempC = t
        if (fld.size > 13 && fld[13].trim().isNotEmpty()) out.put("RAW HUMIDITY", fld[13].trim())
        return out
    }
}

/**
 * The MTS01 decoder on a channel. NRZ needs its own slicer: the record ends in dozens of NUL bytes (hundreds of zero
 * bits in a row), which would drag a running DC estimate onto the zero tone, so the estimate is held still from the
 * header to the end of the frame. Otherwise the same as FskFramer: a symbol clock nudged at every zero crossing, the
 * integrated discriminator per symbol, the 32-bit header in either FM polarity (up to 2 symbols wrong).
 */
class Mts01Channel(rate: Double, private val sink: SondeSink) : ChannelDecoder {
    override val name = "MTS01"
    private val inc = Mts01.BAUD / rate
    private var phase = 0.0; private var acc = 0.0; private var lastPos = false; private var first = true
    private var dc = 0.0
    private var sh = 0; private var shN = 0
    private var collecting = 0; private var inv = false
    private val buf = FloatArray(Mts01.SYMS); private var n = 0
    private val dec = Mts01Decoder()

    override fun push(x: Double) {
        if (collecting == 0) dc += (x - dc) * 0.0005
        val v = x - dc; val pos = v > 0
        if (!first && pos != lastPos) {
            val err = if (phase < 0.5) phase else phase - 1
            phase -= err * 0.2
        }
        first = false; lastPos = pos
        acc += v
        phase += inc
        if (phase < 1) return
        phase -= 1
        val s = acc; acc = 0.0
        if (collecting > 0) {
            buf[n++] = (if (inv) -s else s).toFloat()
            if (--collecting == 0) { val f = dec.decode(buf); if (f != null) sink(f) }
            return
        }
        sh = (sh shl 1) or (if (s > 0) 1 else 0)
        if (++shN < 32) return
        val e = Integer.bitCount(sh xor Mts01.HDR); val ei = Integer.bitCount((sh xor Mts01.HDR).inv())
        if (e <= 2 || ei <= 2) { inv = ei < e; collecting = Mts01.SYMS; n = 0; shN = 0 }
    }
}
