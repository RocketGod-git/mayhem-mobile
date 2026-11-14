package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.sonde.SondeSynth.Prng
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Test signals for the iMet-1/iMet-4, iMet-54 and Meisei decoders: frames built the way each sonde builds them (CRCs,
 * Hamming code and interleave, BCH blocks, biphase-S, 8N1) and an AFSK-on-FM modulator for the iMet-1/iMet-4.
 * The Kotlin twin of web/src/dsp/sonde/synth-c.ts. IQ comes out offset-128.
 */
object SondeSynthC {
    // ---------------------------------------------------------------- iMet-1 / iMet-4

    data class ImetData(
        val frame: Int, val hPa: Double, val tempC: Double, val rh: Double, val battV: Double,
        val lat: Double, val lon: Double, val alt: Double, val sats: Int, val timeS: Double,
        val vE: Double? = null, val vN: Double? = null, val vU: Double? = null,
        /** Extended PTU: internal, pressure-sensor and humidity-sensor temperatures. */
        val ext: DoubleArray? = null,
        /** Extra-data payload (instrument id first). */
        val xdata: IntArray? = null,
    )

    private fun putF32le(b: ArrayList<Int>, v: Double) { val x = v.toFloat().toRawBits(); for (k in 0 until 4) b.add((x shr (8 * k)) and 255) }
    private fun crcTail(b: ArrayList<Int>, start: Int) { val c = Imet.crc(b.toIntArray(), start, b.size - start); b.add(c shr 8); b.add(c and 255) }

    /** One burst's bytes: GPS (or eGPS when velocities are given), PTU (or ePTU), and an XDATA packet if any. */
    fun imetBurst(d: ImetData): IntArray {
        val b = ArrayList<Int>()
        var s = b.size
        val eg = d.vE != null
        b.add(0x01); b.add(if (eg) Imet.PKT_EGPS else Imet.PKT_GPS)
        putF32le(b, d.lat); putF32le(b, d.lon)
        val a = Math.round(d.alt).toInt() + 5000; b.add(a and 255); b.add((a shr 8) and 255); b.add(d.sats)
        if (eg) { putF32le(b, d.vE!!); putF32le(b, d.vN!!); putF32le(b, d.vU!!) }
        val t = kotlin.math.floor(d.timeS).toInt()
        b.add((t / 3600) % 24); b.add((t / 60) % 60); b.add(t % 60)
        crcTail(b, s)
        s = b.size
        b.add(0x01); b.add(if (d.ext != null) Imet.PKT_EPTU else Imet.PKT_PTU); b.add(d.frame and 255); b.add((d.frame shr 8) and 255)
        val p = Math.round(d.hPa * 100).toInt(); b.add(p and 255); b.add((p shr 8) and 255); b.add((p shr 16) and 255)
        val tt = Math.round(d.tempC * 100).toInt() and 0xffff; b.add(tt and 255); b.add(tt shr 8)
        val u = Math.round(d.rh * 100).toInt(); b.add(u and 255); b.add(u shr 8)
        b.add(Math.round(d.battV * 10).toInt())
        d.ext?.let { for (v in it) { val x = Math.round(v * 100).toInt() and 0xffff; b.add(x and 255); b.add(x shr 8) } }
        crcTail(b, s)
        d.xdata?.let { xd ->
            s = b.size
            b.add(0x01); b.add(Imet.PKT_XDATA); b.add(xd.size); for (x in xd) b.add(x)
            crcTail(b, s)
        }
        return b.toIntArray()
    }

    /** The line bits of a burst: idle mark, then each byte as 8N1 (least significant bit first), then idle again. */
    fun imetLineBits(bytes: IntArray, idleBefore: Int = 24, idleAfter: Int = 12): ArrayList<Int> {
        val o = ArrayList<Int>()
        repeat(idleBefore) { o.add(1) }
        for (x in bytes) { o.add(0); for (k in 0 until 8) o.add((x shr k) and 1); o.add(1) }
        repeat(idleAfter) { o.add(1) }
        return o
    }

    private fun clip(v: Double): Int = max(-127, min(127, Math.round(v).toInt()))

    /** Bell 202 AFSK (continuous audio phase) as FM on offset-128 IQ: [dev] Hz peak deviation, [lead] s of idle mark around it. */
    fun afskFmIq(bits: List<Int>, rate: Double, offsetHz: Double, dev: Double = 4000.0, snrDb: Double = 30.0, lead: Double = 0.05,
                 rng: Prng = Prng(7), amp: Double = 60.0): ByteArray {
        val sps = rate / Imet.BAUD; val leadN = Math.round(lead * rate).toInt()
        val n = kotlin.math.ceil(bits.size * sps).toInt() + 2 * leadN
        val out = ByteArray(2 * n)
        // noise over the FM channel bandwidth (dev + tones, both sides)
        val noise = amp * Math.pow(10.0, -snrDb / 20) * sqrt(rate / (2 * (dev + Imet.SPACE))) / sqrt(2.0)
        var ph = 0.0; var aph = 0.0
        for (i in 0 until n) {
            val k = kotlin.math.floor((i - leadN) / sps).toInt()
            val bit = if (k < 0 || k >= bits.size) 1 else bits[k]
            aph += 2 * PI * (if (bit != 0) Imet.MARK else Imet.SPACE) / rate
            if (aph > PI) aph -= 2 * PI
            ph += 2 * PI * (offsetHz + dev * sin(aph)) / rate
            if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
            out[2 * i] = (clip(amp * cos(ph) + noise * rng.gauss()) + 128).toByte()
            out[2 * i + 1] = (clip(amp * sin(ph) + noise * rng.gauss()) + 128).toByte()
        }
        return out
    }

    // ---------------------------------------------------------------- iMet-54

    data class Imet54Data(
        val serial: Long, val timeS: Double, val lat: Double, val lon: Double, val alt: Double,
        val tempC: Double? = null, val rh: Double? = null, val tRh: Double? = null,
        /** iMet-54 = 0x003E (GPS + PTU), iMet-50 = 0x0030. */
        val status: Int = 0x003e,
        /** Write the newer firmware's CRC over bytes 0..0x33 as well. */
        val cont: Boolean = false,
    )

    private fun put32be(b: IntArray, p: Int, v: Long) { b[p] = ((v ushr 24) and 255).toInt(); b[p + 1] = ((v ushr 16) and 255).toInt(); b[p + 2] = ((v ushr 8) and 255).toInt(); b[p + 3] = (v and 255).toInt() }
    private fun putF32be(b: IntArray, p: Int, v: Double) = put32be(b, p, v.toFloat().toRawBits().toLong() and 0xffffffffL)
    /** Degrees as NMEA ddmm.mmmm x 1e4. */
    fun toNmea(deg: Double): Long { val d = deg.toLong(); val m = (deg - d) * 60; return d * 1_000_000 + Math.round(m * 10_000) }

    fun imet54Frame(d: Imet54Data): IntArray {
        val b = IntArray(Imet54.LEN)
        put32be(b, 0, d.serial)
        val t = Math.round(d.timeS * 1000); val hh = t / 3_600_000; val mm = (t / 60_000) % 60; val ms = t % 60_000
        put32be(b, 4, hh * 10_000_000 + mm * 100_000 + ms)
        put32be(b, 8, toNmea(d.lat)); put32be(b, 12, toNmea(d.lon)); put32be(b, 16, Math.round(d.alt * 10))
        val absent = 1e9
        putF32be(b, 0x1c, d.tempC ?: absent); putF32be(b, 0x20, d.rh ?: absent); putF32be(b, 0x24, d.tRh ?: absent)
        b[0x2a] = d.status shr 8; b[0x2b] = d.status and 255
        if (d.cont) put32be(b, 0x34, Imet54.contCrc(b))
        imet54SetStd(b)
        return b
    }

    /** Fill a frame's two whole-frame check words (bytes 100..101 and 106..107 do not feed the CRC). */
    fun imet54SetStd(b: IntArray) {
        val r = Imet54.stdCrc(b)
        val c0 = (r ushr 16).toInt() xor 0x5000; val c1 = (r and 0xffff).toInt() xor 0x1dad
        b[100] = c0 shr 8; b[101] = c0 and 255; b[106] = c1 shr 8; b[107] = c1 and 255
    }

    /** The channel symbols: preamble and sync as 8N1, then the Hamming-coded, interleaved frame, then two spare groups. */
    fun imet54Symbols(fr: IntArray): IntArray {
        val o = ArrayList<Int>()
        fun group(bits: IntArray) { o.add(0); for (k in 0 until 8) o.add(bits[k]); o.add(1) }
        fun byte(v: Int) = group(IntArray(8) { (v shr (7 - it)) and 1 })
        repeat(10) { byte(0x00); byte(0xaa) }
        for (v in intArrayOf(0x24, 0x24, 0x24, 0x24, 0x42)) byte(v)
        for (blk in 0 until 27) {
            val cw = IntArray(8) { k -> val by = fr[4 * blk + (k shr 1)]; Imet54.HAM[if (k and 1 != 0) by and 15 else by shr 4] }
            for (i in 0 until 8) group(IntArray(8) { j -> (cw[j] shr i) and 1 })
        }
        byte(0x00); byte(0x00)
        return o.toIntArray()
    }

    // ---------------------------------------------------------------- Meisei

    data class MeiseiData(
        val lat: Double, val lon: Double, val alt: Double, val vH: Double, val heading: Double, val climb: Double,
        /** UTC time of day, s. */
        val timeS: Double, val year: Int, val month: Int, val day: Int,
        val tRaw: Int, val uRaw: Int, val fRef: Int,
    )

    /** The 64-slot configuration table: serial, frequency, temperature points, resistances, polynomials. */
    fun meiseiCfg(model: String, serial: Int, txKHz: Int): FloatArray {
        val c = FloatArray(64)
        for (s in intArrayOf(0, 16, 32, 48)) c[s] = serial.toFloat()
        c[15] = ((txKHz - (if (model == "iMS-100") 400_000 else 403_700)) / 100.0).toFloat()
        val ims = model == "iMS-100"
        val n = if (ims) 12 else 11; val rLo = if (ims) 33 else 37; val poly = if (ims) 53 else 33
        for (i in 0 until n) { c[17 + i] = (40 - 10 * i).toFloat(); c[rLo + i] = (3 * exp(0.4 * i)).toFloat() }
        // R = c0 + c1 f + c2 f^2 - c3 with f = 1 / (4 t_raw / f_ref - 1): here just R = f
        c[poly] = 0f; c[poly + 1] = 1f; c[poly + 2] = 0f; c[poly + 3] = 0f
        // RH = 25 f, f = 4 u_raw / f_ref
        c[49] = 0f; c[50] = 25f; c[51] = 0f; c[52] = 0f
        return c
    }

    /** The raw temperature count that reads [tempC] with meiseiCfg's table (log-linear between the points). */
    fun meiseiTRaw(model: String, cfg: FloatArray, tempC: Double, fRef: Int): Int {
        val ims = model == "iMS-100"
        val n = if (ims) 12 else 11; val rLo = if (ims) 33 else 37
        var r = cfg[rLo].toDouble()
        for (j in 0 until n - 1) {
            if (tempC <= cfg[17 + j] && tempC >= cfg[18 + j]) {
                val g = (cfg[17 + j] - tempC) / (cfg[17 + j] - cfg[18 + j])
                r = exp(ln(cfg[rLo + j].toDouble()) + g * (ln(cfg[rLo + j + 1].toDouble()) - ln(cfg[rLo + j].toDouble())))
                break
            }
        }
        return Math.round(fRef * (1 + 1 / r) / 4).toInt()
    }

    /** One 600-bit frame (both subframes) for counter [c]. */
    fun meiseiFrame(model: String, c: Int, d: MeiseiData, cfg: FloatArray): IntArray {
        val ims = model == "iMS-100"
        val w0 = IntArray(12); val w1 = IntArray(12)
        val even = c % 2 == 0
        val t = Math.round(d.timeS * 1000).toInt(); val hh = t / 3_600_000; val mm = (t / 60_000) % 60; val ms = t % 60_000
        w0[0] = c and 0xffff
        if (c % 4 == 0) w0[1] = d.fRef
        val slot = c % 64
        if (ims) { val v = cfg[slot].toRawBits(); w0[2] = v and 0xffff; w0[3] = v ushr 16 }
        else { val v = Meisei.toF32e2(cfg[slot].toDouble()); w0[2] = Meisei.swap16(v and 0xffff); w0[3] = Meisei.swap16(v ushr 16) }
        w0[5] = d.tRaw
        w0[6] = if (ims && c % 4 == 3) d.fRef else d.uRaw
        w0[7] = (if (even) 0x3000 else 0x3100) or (if (ims) 0xc1 else 0xa2)
        if (ims && even) { w0[10] = ms; w0[11] = (hh shl 8) or mm }
        if (!ims && !even) { w0[10] = Meisei.swap16(ms); w0[11] = (hh shl 8) or mm }
        if (ims) {
            if (even) {
                w1[0] = d.day * 1000 + d.month * 10 + (d.year % 10)
                val la = toNmea(d.lat).toInt(); val lo = toNmea(d.lon).toInt(); val al = Math.round(d.alt * 100).toInt()
                w1[1] = la ushr 16; w1[2] = la and 0xffff; w1[3] = lo ushr 16; w1[4] = lo and 0xffff
                w1[5] = (al shr 8) and 0xffff; w1[6] = (al and 0xff) shl 8
                w1[9] = Math.round(d.heading * 100).toInt(); w1[10] = Math.round(d.vH * 194.384).toInt()
            } else {
                w1[1] = Math.round(d.climb * 19.4384).toInt() and 0xffff
            }
            var sum = w0[10] + w0[11]
            for (j in 0 until 11) sum += w1[j]
            w1[11] = sum and 0xffff
        } else if (even) {
            val la = Math.round(d.lat * 1e7).toInt(); val lo = Math.round(d.lon * 1e7).toInt(); val al = Math.round(d.alt * 100).toInt()
            w1[1] = la ushr 16; w1[2] = la and 0xffff; w1[3] = lo ushr 16; w1[4] = lo and 0xffff; w1[5] = al ushr 16; w1[6] = al and 0xffff
            w1[7] = Math.round(d.vH * 100).toInt(); w1[8] = Math.round(d.heading * 100).toInt(); w1[9] = Math.round(d.climb * 100).toInt() and 0xffff
            w1[10] = (d.year - 0x700) and 0xff; w1[11] = (d.month shl 8) or d.day
        }
        val b = IntArray(600)
        for (s in 0 until 2) {
            val h = if (s == 0) Meisei.HDR0 else Meisei.HDR1; val w = if (s == 0) w0 else w1
            for (k in 0 until 24) b[300 * s + k] = (h shr (23 - k)) and 1
            for (k in 0 until 6) Meisei.block(w[2 * k], w[2 * k + 1], b, 300 * s + 24 + 46 * k)
        }
        return b
    }

    /** Biphase-S line coding with the level carried from one frame to the next: a transition every cell, one more mid-cell for a 0. */
    class BiphaseS {
        private var level = 0
        fun encode(bits: IntArray): IntArray {
            val o = IntArray(2 * bits.size)
            for (i in bits.indices) {
                level = level xor 1; o[2 * i] = level
                if (bits[i] == 0) level = level xor 1
                o[2 * i + 1] = level
            }
            return o
        }
    }
}
