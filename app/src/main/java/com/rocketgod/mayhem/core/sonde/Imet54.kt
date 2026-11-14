package com.rocketgod.mayhem.core.sonde

import java.util.Locale
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/**
 * InterMet iMet-54 (and the iMet-50, the same frame without the PTU sensors): 4800 baud GFSK in 8N1 groups (a 0
 * start bit, 8 data bits, a 1 stop bit; data most significant bit first). Preamble 10 x (0x00 0xAA), sync 0x24 0x24
 * 0x24 0x24 0x42, then 27 blocks of 64 data bits. A block is 8 Hamming(8,4) codewords interleaved 8 x 8 (codeword k
 * is bit k of each of the block's 8 groups) and carries 4 bytes, so a frame is 108 bytes, big-endian: serial, GPS
 * time (decimal HHMMSSmmm), latitude and longitude (NMEA ddmm.mmmm x 1e4), altitude, temperature, humidity and the
 * humidity sensor's temperature as floats, a status word. Two CRC32s check it: one over the whole frame (words at
 * bytes 100 and 106), one over bytes 0..0x33 (at 0x34, the newer firmware); either passing is enough.
 * The Kotlin twin of web/src/dsp/sonde/imet54.ts.
 */
object Imet54 {
    const val BAUD = 4800
    /** 0x00 0xAA 0x24 0x24 in 8N1. */
    const val HEADER = "0000000001010101010100010010010001001001"
    /** Channel symbols after the header: 220 8N1 groups (the rest of the sync, 216 data groups, one spare). */
    const val SYMS = 2200
    const val LEN = 108

    /** Codeword of each nibble (codeword bit j = bit j of the byte). */
    val HAM = intArrayOf(0x00, 0x87, 0x99, 0x1e, 0xaa, 0x2d, 0x33, 0xb4, 0x4b, 0xcc, 0xd2, 0x55, 0xe1, 0x66, 0x78, 0xff)
    /** Received byte to nibble (| 0x10 when one bit was repaired), -1 for two wrong bits. */
    internal val HAM_DEC = IntArray(256).also { t ->
        for (r in 0 until 256) {
            t[r] = -1
            for (m in 0 until 16) {
                val d = Integer.bitCount(r xor HAM[m])
                if (d == 0) { t[r] = m; break }
                if (d == 1) { t[r] = m or 0x10; break }
            }
        }
    }

    /** The whole-frame check: the two 16-bit halves of a CRC32 run over the frame word by word from the top. */
    fun stdCrc(b: IntArray): Long {
        val poly0 = 0x0edb; val poly1 = 0x8260
        var n = 104; var bit = 0; var c0 = 0x48eb; var c1 = 0x1aca; var crc0 = 0; var crc1 = 0
        while (n >= 0) {
            if (n < 100 || (n > 101 && n < 106)) {
                if ((b[n] shr bit) and 1 != 0) { crc0 = crc0 xor c0; crc1 = crc1 xor c1 }
            }
            var n0 = c0; var n1 = c1
            if (c1 and 0x8000 != 0) { n0 = n0 xor poly0; n1 = n1 xor poly1 }
            n0 = n0 shl 1; n1 = n1 shl 1
            if (c1 and 0x8000 != 0) n0 = n0 or 1
            if ((c1 xor c0) and 0x8000 != 0) n1 = n1 or 1
            c0 = n0 and 0xffff; c1 = n1
            if (bit < 7) bit++
            else { bit = 0; if (n % 4 == 3) n -= 7 else n += 1 }
        }
        return (((crc0 and 0xffff).toLong() shl 16) or (crc1 and 0xffff).toLong())
    }

    fun stdOk(b: IntArray): Boolean {
        val r = stdCrc(b)
        val c0 = (r ushr 16).toInt() xor ((b[100] shl 8) or b[101]) xor 0x5000
        val c1 = (r and 0xffff).toInt() xor ((b[106] shl 8) or b[107]) xor 0x1dad
        return c1 == 0 && (c0 and 0xf000) == 0
    }

    /** CRC-32 (0x04C11DB7, MSB first, out-XOR 0x63D60875) over bytes 0..0x33 with each 4-byte word reversed. */
    fun contCrc(b: IntArray): Long {
        var rem = 0
        for (i in 0 until 0x34) {
            rem = rem xor (b[(i and 3.inv()) + 3 - (i and 3)] shl 24)
            for (j in 0 until 8) rem = if (rem and Int.MIN_VALUE != 0) (rem shl 1) xor 0x04c11db7 else rem shl 1
        }
        return (rem xor 0x63d60875).toLong() and 0xffffffffL
    }

    fun contOk(b: IntArray): Boolean = contCrc(b) == u32(b, 0x34)

    internal fun u32(b: IntArray, p: Int): Long = i32(b, p).toLong() and 0xffffffffL
    internal fun i32(b: IntArray, p: Int) = (b[p] shl 24) or (b[p + 1] shl 16) or (b[p + 2] shl 8) or b[p + 3]
    internal fun f32(b: IntArray, p: Int): Double = Float.fromBits(i32(b, p)).toDouble()
    /** The "no sensor" float, 1e9. */
    internal const val ABSENT = 0x4e6e6b28L

    /** Hyland-Wexler saturation vapor pressure, Pa. */
    internal fun vaporSat(tc: Double): Double {
        val t = tc + 273.15
        return exp(-5800.2206 / t + 1.3914993 + 6.5459673 * ln(t) - 4.8640239e-2 * t + 4.1764768e-5 * t * t - 1.4452093e-8 * t * t * t)
    }

    internal fun nmeaDeg(v: Int): Double {
        val deg = (v / 1e6).toLong().toDouble()
        return deg + (v / 1e6 - deg) * 100 / 60
    }

    /** 0x24 0x24 0x42 as 8N1 symbols (30 bits, the first in bit 29). */
    internal val SYNC_TAIL: Int = run {
        var v = 0
        for (b in intArrayOf(0x24, 0x24, 0x42)) { v = v shl 1; for (k in 7 downTo 0) v = (v shl 1) or ((b shr k) and 1); v = (v shl 1) or 1 }
        v
    }
}

class Imet54Decoder {
    private val data = IntArray(1760)
    private val frame = IntArray(Imet54.LEN)

    /** One frame's soft symbols after the header (the 2200 symbols FskFramer would collect). */
    fun decode(soft: FloatArray): SondeFrame? {
        // strip the start and stop bits
        val d = data
        var m = 0
        for (n in 0 until Imet54.SYMS) { val k = n % 10; if (k > 0 && k < 9) d[m++] = if (soft[n] > 0) 1 else 0 }
        // the 3 sync bytes still to come, then the blocks
        return decodeData(d, 24)
    }

    /** 27 x 64 data bits (8N1 framing removed) from [ofs]: de-interleave, Hamming, parse. */
    fun decodeData(d: IntArray, ofs: Int): SondeFrame? {
        val fr = frame
        var fixed = 0; var bad = 0
        for (blk in 0 until 27) {
            for (k in 0 until 8) {
                var cw = 0
                for (i in 0 until 8) cw = cw or (d[ofs + 64 * blk + 8 * i + k] shl i)
                var nib = Imet54.HAM_DEC[cw]
                if (nib < 0) { bad++; nib = 0 } else if (nib and 0x10 != 0) { fixed++; nib = nib and 15 }
                val at = 4 * blk + (k shr 1)
                fr[at] = if (k and 1 != 0) (fr[at] and 0xf0) or nib else nib shl 4
            }
        }
        val out = parse(fr)
        if (out != null) { out.fixed = fixed; if (bad != 0) out.put("UNREPAIRED NIBBLES", "$bad") }
        return out
    }

    /** A 108-byte frame (after the Hamming code). Null unless a CRC passes and the status says GPS and PTU are in. */
    fun parse(fr: IntArray): SondeFrame? {
        val std = Imet54.stdOk(fr); val cont = Imet54.contOk(fr)
        if (!std && !cont) return null
        val status = (fr[0x2a] shl 8) or fr[0x2b]
        if ((status and 0x30) != 0x30) return null
        val t = Imet54.i32(fr, 4)
        if (t < 0 || t > 235959999) return null
        val hh = t / 10000000; val mm = (t / 100000) % 100; val ss = (t % 100000) / 1000.0
        if (hh > 23 || mm > 59 || ss >= 61) return null
        val lat = Imet54.nmeaDeg(Imet54.i32(fr, 8)); val lon = Imet54.nmeaDeg(Imet54.i32(fr, 12)); val alt = Imet54.i32(fr, 16) / 10.0
        if (!(lat > -90 && lat < 90 && lon > -180 && lon < 180 && alt > -400 && alt < 60000)) return null
        val sn = Imet54.u32(fr, 0)
        val timeS = hh * 3600 + mm * 60 + ss
        val out = SondeFrame(type = "iMet-54", model = "iMet-54", serial = "$sn", frame = kotlin.math.floor(timeS + 0.5).toInt(), timeS = timeS, lat = lat, lon = lon, alt = alt)
        var absent = 0
        val tt = if (Imet54.u32(fr, 0x1c) == Imet54.ABSENT) { absent++; Double.NaN } else Imet54.f32(fr, 0x1c)
        val rh = if (Imet54.u32(fr, 0x20) == Imet54.ABSENT) { absent++; Double.NaN } else Imet54.f32(fr, 0x20)
        val trh = if (Imet54.u32(fr, 0x24) == Imet54.ABSENT) { absent++; Double.NaN } else Imet54.f32(fr, 0x24)
        var aux = 0
        for (i in 0x2c until 0x52) aux += fr[i]
        if (aux == 0 && (status and 0xf0f) == 0 && absent == 3) out.model = "iMet-50"
        if (tt > -120 && tt < 80) out.tempC = tt
        if (trh > -120 && trh < 80) out.tHumC = trh
        if (out.tempC != null && out.tHumC != null && rh.isFinite()) out.rh = max(0.0, min(100.0, rh * Imet54.vaporSat(trh) / Imet54.vaporSat(tt)))
        out.extra = linkedMapOf("STATUS" to "0x%04x".format(Locale.US, status), "CRC" to if (std && cont) "both" else if (std) "frame" else "first 52 bytes")
        return out
    }
}

/**
 * The iMet-54 on a channel. A symbol clock on the discriminator's level changes (found on a short running mean, so
 * noise makes few false ones; integrate and dump over each symbol), sliced at the midpoint of the 0 and 1 levels the
 * decisions themselves track (the frame's long runs of zeros would drag a running mean off), then the last three sync
 * bytes 0x24 0x24 0x42 as 30 8N1 symbols in either polarity, then 216 groups of data.
 */
class Imet54Channel(rate: Double, private val sink: SondeSink) : ChannelDecoder {
    override val name = "iMet-54"
    private val dec = Imet54Decoder()
    private val inc = Imet54.BAUD / rate
    private val ring = DoubleArray(max(1, Math.round(rate / Imet54.BAUD / 3).toInt())); private var rp = 0; private var rs = 0.0
    private var phase = 0.0; private var acc = 0.0; private var cnt = 0; private var lastPos = false
    private var mean = 0.0; private var lvl0 = 0.0; private var lvl1 = 0.0; private var started = false
    private var sh = 0
    private var collecting = 0; private var inv = false
    private val soft = FloatArray(2160); private var ns = 0
    private val bits = IntArray(1728)
    /** Timing-loop gain per level change. */
    var gain = 0.05
    /** Level changes counted only this close to a boundary, in symbols. */
    var gate = 0.35

    override fun push(x: Double) {
        val m = ring.size
        rs += x - ring[rp]; ring[rp] = x; rp = if (rp + 1 == m) 0 else rp + 1
        val v = rs / m
        if (!started) { mean = v; lvl0 = v; lvl1 = v; started = true }
        val thr = (lvl0 + lvl1) / 2
        val pos = v > thr
        if (pos != lastPos) {
            // level changes far from a symbol boundary are noise; leave them out
            val err = if (phase < 0.5) phase else phase - 1
            if (err < gate && err > -gate) phase -= err * gain
        }
        lastPos = pos
        acc += v; cnt++
        phase += inc
        if (phase < 1) return
        phase -= 1
        val s = acc / cnt; acc = 0.0; cnt = 0
        symbol(s, thr)
    }

    private fun symbol(s: Double, thr: Double) {
        // the levels follow the decisions; outside a frame they also drift with the carrier (the slow mean)
        if (s > thr) lvl1 += (s - lvl1) * 0.02 else lvl0 += (s - lvl0) * 0.02
        if (collecting == 0) {
            mean += (s - mean) * 0.01
            val mid = (lvl0 + lvl1) / 2; val pull = (mean - mid) * 0.002
            lvl0 += pull; lvl1 += pull
        }
        if (collecting > 0) {
            soft[ns++] = (if (inv) thr - s else s - thr).toFloat()
            if (--collecting == 0) frame()
            return
        }
        sh = ((sh shl 1) or (if (s > thr) 1 else 0)) and 0x3fffffff
        val e = Integer.bitCount(sh xor Imet54.SYNC_TAIL)
        val ei = Integer.bitCount((sh xor Imet54.SYNC_TAIL.inv()) and 0x3fffffff)
        if (e <= 2 || ei <= 2) { inv = ei < e; collecting = 2160; ns = 0; sh = 0 }
    }

    private fun frame() {
        var m = 0
        for (n in 0 until 2160) { val k = n % 10; if (k > 0 && k < 9) bits[m++] = if (soft[n] > 0) 1 else 0 }
        val f = dec.decodeData(bits, 0)
        if (f != null && f.serial.isNotEmpty()) sink(f)
    }
}
