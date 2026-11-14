package com.rocketgod.mayhem.core.sonde

import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Vaisala RS41 (SG, SGP, SGM, NG): 4800 baud GFSK, bytes sent least significant bit first, whitened with a 64-byte
 * mask, 8 sync bytes then 312 (or 510 with extra data) bytes protected by two interleaved RS(255,231) codewords.
 * The body is a chain of blocks [id, length, data, CRC16]: status (serial, frame, battery and one 16-byte slice of the
 * calibration table), PTU, GPS time, raw GPS, GPS position/velocity, aux. Temperature, humidity and pressure need the
 * calibration table, which arrives one slice per frame (51 slices, under a minute). Kotlin twin of rs41.ts.
 */
object Rs41 {
    const val BAUD = 4800
    const val HEADER = "0000100001101101010100111000100001000100011010010100100000011111"
    val HEADER_BYTES = intArrayOf(0x86, 0x35, 0xf4, 0x40, 0x93, 0xdf, 0x1a, 0x60)
    val MASK = intArrayOf(0x96, 0x83, 0x3E, 0x51, 0xB1, 0x49, 0x08, 0x98, 0x32, 0x05, 0x59, 0x0E, 0xF9, 0x44, 0xC6, 0x26,
        0x21, 0x60, 0xC2, 0xEA, 0x79, 0x5D, 0x6D, 0xA1, 0x54, 0x69, 0x47, 0x0C, 0xDC, 0xE8, 0x5C, 0xF1,
        0xF7, 0x76, 0x82, 0x7F, 0x07, 0x99, 0xA2, 0x2C, 0x93, 0x7C, 0x30, 0x63, 0xF5, 0x10, 0x2E, 0x61,
        0xD0, 0xBC, 0xB4, 0xB6, 0x06, 0xAA, 0xF4, 0x23, 0x78, 0x6E, 0x3B, 0xAE, 0xBF, 0x7B, 0x4C, 0xC1)
    const val LEN = 320
    const val XLEN = 518
    /** Channel symbols after the 64-bit header for the longest frame. */
    const val SYMS = (XLEN - 8) * 8

    internal fun u16(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8)
    internal fun i16(b: IntArray, p: Int) = (u16(b, p) shl 16) shr 16
    internal fun u24(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16)
    internal fun i32(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16) or (b[p + 3] shl 24)
    internal fun f32(b: IntArray, p: Int): Double = Float.fromBits(i32(b, p)).toDouble()

    /** Correct both interleaved codewords in place. Returns bytes fixed, or -1 when either is beyond repair. */
    fun ecc(fr: IntArray): Int {
        val r = 24; val k = 231; val msg = 56; val par = 8
        var total = 0
        for (w in 0 until 2) {
            val cw = IntArray(255)
            for (i in 0 until r) cw[i] = fr[par + w * r + i]
            for (i in 0 until k) { val p = msg + 2 * i + w; cw[r + i] = if (p < XLEN) fr[p] else 0 }
            val n = ReedSolomon.VAISALA.decode(cw)
            if (n < 0) return -1
            total += n
            for (i in 0 until r) fr[par + w * r + i] = cw[i]
            for (i in 0 until k) { val p = msg + 2 * i + w; if (p < XLEN) fr[p] = cw[r + i] }
        }
        return total
    }

    /** The two codewords' parity for a frame being built (tests). */
    fun parity(fr: IntArray) {
        val r = 24; val k = 231; val msg = 56; val par = 8
        for (w in 0 until 2) {
            val cw = IntArray(255)
            for (i in 0 until k) { val p = msg + 2 * i + w; cw[r + i] = if (p < XLEN) fr[p] else 0 }
            ReedSolomon.VAISALA.encode(cw)
            for (i in 0 until r) fr[par + w * r + i] = cw[i]
        }
    }

    /** Hyland-Wexler saturation vapor pressure, Pa. */
    internal fun vaporSat(tc: Double): Double {
        val t = tc + 273.15
        return exp(-5800.2206 / t + 1.3914993 + 6.5459673 * ln(t) - 4.8640239e-2 * t + 4.1764768e-5 * t * t - 1.4452093e-8 * t * t * t)
    }

    /** The standard atmosphere's pressure at a height, hPa. */
    fun stdPressure(h: Double): Double {
        val gMR = 9.80665 * 0.0289644 / 8.31446
        val (pb, tb, lb, hb) = when {
            h > 32000 -> doubleArrayOf(8.6802, 228.65, 0.0028, 32000.0)
            h > 20000 -> doubleArrayOf(54.7489, 216.65, 0.001, 20000.0)
            h > 11000 -> doubleArrayOf(226.321, 216.65, 0.0, 11000.0)
            else -> doubleArrayOf(1013.25, 288.15, -0.0065, 0.0)
        }
        return if (lb == 0.0) pb * exp(-gMR * (h - hb) / tb) else pb * (1 + lb * (h - hb) / tb).pow(-gMR / lb)
    }
}

/** The calibration table of one sonde, slice by slice. */
private class Rs41Cal {
    val bytes = IntArray(51 * 16)
    val have = IntArray(51)
    var count = 0
    var model = ""; var killS: Int? = null; var burstArmed: Boolean? = null; var txKHz = 0; var fw = 0
    fun set(i: Int, data: IntArray, p: Int) {
        if (i > 50) return
        for (k in 0 until 16) bytes[i * 16 + k] = data[p + k]
        if (have[i] == 0) { have[i] = 1; count++ }
    }
    fun all(vararg ix: Int): Boolean = ix.all { have[it] == 1 }
    fun f(p: Int): Double = Rs41.f32(bytes, p)
}

/** Packet ids (high byte of the block id word). */
private const val ID_STATUS = 0x79
private const val ID_PTU = 0x7a
private const val ID_GPSTIME = 0x7c
private const val ID_GPSRAW = 0x7d
private const val ID_GPSPOS = 0x7b
private const val ID_ZERO = 0x76
private const val ID_AUX = 0x7e
private const val ID_SGM_TU = 0x7f
private const val ID_CRYPT = 0x80
private const val ID_POSDATETIME = 0x82
private const val ID_SATS = 0x83

class Rs41Decoder {
    private val cals = LinkedHashMap<String, Rs41Cal>()

    /** Decode one frame's soft symbols (after the header). Returns null when nothing in it checks out. */
    fun decode(soft: FloatArray): SondeFrame? {
        val bits = IntArray(soft.size) { if (soft[it] > 0) 1 else 0 }
        val fr = IntArray(Rs41.XLEN)
        Rs41.HEADER_BYTES.copyInto(fr, 0)
        val body = bytesOf(bits, 0, Rs41.XLEN - 8, true)
        for (i in 8 until Rs41.XLEN) fr[i] = body[i - 8] xor Rs41.MASK[i % 64]
        return parse(fr)
    }

    /** A de-whitened frame, header included ([Rs41.XLEN] bytes). */
    fun parse(fr: IntArray): SondeFrame? {
        // 0x0F: 320 bytes, 0xF0: 518 (with aux data); vote the nibbles in case of bit errors
        val b = fr[0x38]; var ft = 0; for (i in 0 until 4) ft += ((b shr i) and 1) - ((b shr (i + 4)) and 1)
        val len = if (ft >= 0) Rs41.LEN else Rs41.XLEN
        for (i in len until Rs41.XLEN) fr[i] = 0
        val fixed = Rs41.ecc(fr)
        val out = SondeFrame(type = "RS41", serial = "")
        if (fixed >= 0) out.fixed = fixed
        var pos = 0x39; var sawStatus = false; var cal: Rs41Cal? = null; var meas: IntArray? = null; var pTemp = 0; var encrypted = false
        var ecef: DoubleArray? = null
        while (pos + 4 <= len) {
            val id = fr[pos]; val bl = fr[pos + 1]
            if (pos + 2 + bl + 2 > len) break
            val crcOk = ReedSolomon.crc16ccitt(fr, pos + 2, bl) == Rs41.u16(fr, pos + 2 + bl)
            val d = pos + 2
            if (crcOk) {
                when (id) {
                    ID_STATUS -> {
                        val s = StringBuilder(); for (k in 0 until 8) { val c = fr[d + 2 + k]; if (c in 0x20 until 0x7f) s.append(c.toChar()) }
                        if (s.length < 8) return null
                        val serial = s.toString()
                        out.serial = serial; out.frame = Rs41.u16(fr, d)
                        out.battV = fr[d + 10] / 10.0
                        val c = cals[serial] ?: Rs41Cal()
                        if (!cals.containsKey(serial)) { cals[serial] = c; if (cals.size > 64) cals.remove(cals.keys.first()) }
                        cal = c
                        val sub = fr[d + 23]
                        c.set(sub, fr, d + 24)
                        subframe(c, sub, fr, d + 24)
                        sawStatus = true
                    }
                    ID_PTU -> { meas = IntArray(12) { Rs41.u24(fr, d + 3 * it) }; pTemp = if (bl >= 40) Rs41.i16(fr, d + 38) else 0 }
                    ID_SGM_TU -> meas = IntArray(bl / 3) { Rs41.u24(fr, d + 3 * it) }
                    ID_GPSTIME -> {
                        val week = Rs41.u16(fr, d); val tow = (Rs41.i32(fr, d + 2).toLong() and 0xffffffffL) / 1000.0
                        out.timeS = tow % 86400; out.date = gpsDate(week, tow)
                        out.put("GPS WEEK", "$week")
                    }
                    ID_GPSPOS -> {
                        ecef = posVel(fr, d)
                        out.sats = fr[d + 18]
                        out.put("POSITION ACCURACY", "${jsNum(fr[d + 19] / 10.0)} m")
                        out.put("PDOP", "%.1f".format(java.util.Locale.US, fr[d + 20] / 10.0))
                    }
                    ID_POSDATETIME -> if (bl >= 26) {
                        ecef = posVel(fr, d)
                        val y = Rs41.u16(fr, d + 18); val mo = fr[d + 20]; val dd = fr[d + 21]
                        out.date = "%d-%02d-%02d".format(java.util.Locale.US, y, mo, dd)
                        out.timeS = fr[d + 22] * 3600.0 + fr[d + 23] * 60 + fr[d + 24] + (if (fr[d + 25] < 100) fr[d + 25] / 100.0 else 0.0)
                    }
                    ID_CRYPT -> encrypted = true
                    ID_AUX -> {
                        val sb = StringBuilder(); for (k in 0 until bl) { val c = fr[d + k]; if (c > 0x1e && c < 0x7f) sb.append(c.toChar()) }
                        val s = sb.toString()
                        if (s.isNotEmpty()) out.put("AUX DATA", if (s.length > 40) s.substring(0, 40) + "…" else s)
                        if (Regex("^0[15]").containsMatchIn(s)) out.put("AUX", if (s.startsWith("01")) "ozone (OIF411)" else "ozone (ECC)")
                    }
                    ID_ZERO, ID_GPSRAW, ID_SATS -> {}
                }
            }
            pos += 2 + bl + 2
            if (id == ID_ZERO && !crcOk) break
        }
        if (!sawStatus) return null
        ecef?.let { e ->
            val g = ecefToGeo(e[0], e[1], e[2])
            if (g.alt > -1000 && g.alt < 80000 && (e[0] != 0.0 || e[1] != 0.0 || e[2] != 0.0)) {
                out.lat = g.lat; out.lon = g.lon; out.alt = g.alt
                val v = ecefVelToNeu(e[3], e[4], e[5], g.lat, g.lon)
                out.vH = v.vH; out.heading = v.heading; out.climb = v.climb
            }
        }
        val c = cal
        if (c != null) {
            out.model = c.model.ifEmpty { null }
            c.killS?.let { out.killS = it }
            if (c.txKHz != 0) out.txKHz = c.txKHz
            c.burstArmed?.let { out.put("BURST KILL", if (it) "armed" else "off") }
            if (c.fw != 0) out.put("FIRMWARE", "0x${Integer.toHexString(c.fw)}")
            out.put("CALIBRATION", "${c.count}/51")
            meas?.let { ptu(c, it, pTemp, out) }
        }
        if (encrypted) { out.model = "RS41-SGM"; out.put("ENCRYPTED", "yes (military): no position") }
        return out
    }

    private fun posVel(fr: IntArray, d: Int) = doubleArrayOf(Rs41.i32(fr, d) / 100.0, Rs41.i32(fr, d + 4) / 100.0, Rs41.i32(fr, d + 8) / 100.0,
        Rs41.i16(fr, d + 12) / 100.0, Rs41.i16(fr, d + 14) / 100.0, Rs41.i16(fr, d + 16) / 100.0)

    private fun subframe(cal: Rs41Cal, sub: Int, fr: IntArray, p: Int) {
        when (sub) {
            0x00 -> cal.txKHz = 400000 + 40 * fr[p + 3] + ((fr[p + 2] and 0xc0) * 10) / 64
            0x01 -> cal.fw = Rs41.u16(fr, p + 5)
            0x02 -> cal.burstArmed = fr[p + 11] != 0
            0x21, 0x22 -> {
                val c = cal.bytes; val t = StringBuilder()
                if (cal.have[0x21] == 0) return
                for (k in 0 until 8) { val ch = c[0x21 * 16 + 8 + k]; if (ch in 0x20 until 0x7f) t.append(ch.toChar()) else break }
                if (cal.have[0x22] == 1 && t.length == 8) { val ch = c[0x22 * 16]; if (ch in 0x20 until 0x7f) t.append(ch.toChar()) }
                val m = t.toString().trim()
                if (m.startsWith("RS41")) cal.model = m
            }
            0x32 -> { val cd = Rs41.u16(fr, p); cal.killS = if (cd != 0xffff) cd else null }
        }
    }

    /** Temperature, humidity and pressure from the measurement block and whatever calibration has arrived. */
    private fun ptu(c: Rs41Cal, m: IntArray, pTemp: Int, out: SondeFrame) {
        val rf1 = c.f(61); val rf2 = c.f(65)
        fun temp(f: Double, f1: Double, f2: Double, co: Int, ct: Int): Double {
            val g = (f2 - f1) / (rf2 - rf1); val rb = (f1 * rf2 - f2 * rf1) / (f2 - f1); val rc = f / g - rb; val r = rc * c.f(ct)
            return (c.f(co) + c.f(co + 4) * r + c.f(co + 8) * r * r + c.f(ct + 4)) * (1 + c.f(ct + 8))
        }
        var t = Double.NaN; var th = Double.NaN; var p = Double.NaN
        if (c.all(3, 4, 5, 6) && m[2] != m[1]) t = temp(m[0].toDouble(), m[1].toDouble(), m[2].toDouble(), 77, 89)
        if (c.all(3, 4, 0x12, 0x13) && m[8] != m[7]) th = temp(m[6].toDouble(), m[7].toDouble(), m[8].toDouble(), 293, 305)
        if (t.isFinite() && t > -120 && t < 70) out.tempC = t
        if (th.isFinite() && th > -120 && th < 70) out.tHumC = th
        // pressure: the optional sensor (RS41-SGP), a 6x4 polynomial
        if (m.size >= 12 && c.all(0x21, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a) && c.bytes[0x21f] == 0x50 && m[11] != m[10] && m[9] != m[10]) {
            val calP = DoubleArray(25)
            val at = intArrayOf(606, 610, 614, 618, 622, 626, 630, 634, 638, 642, 646, 650, 654, 658, 662, 666, 670, 674)
            val ix = intArrayOf(0, 4, 8, 12, 16, 20, 24, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11)
            for (k in at.indices) calP[ix[k]] = c.f(at[k])
            val a0 = calP[24] / ((m[9] - m[10]).toDouble() / (m[11] - m[10])); val a1 = pTemp * 0.01
            var pp = 0.0; var a0j = 1.0
            for (j in 0 until 6) { var a1k = 1.0; for (k in 0 until 4) { pp += a0j * a1k * calP[j * 4 + k]; a1k *= a1 }; a0j *= a0 }
            if (pp > 0 && pp < 1100) { p = pp; out.hPa = pp }
            if (out.model == null || out.model == "RS41-SG") out.model = "RS41-SGP"
        }
        if (!t.isFinite()) return
        // humidity: the full capacitance model once its tables are in, the simple one before
        val fh = (m[3] - m[4]).toDouble() / (m[5] - m[4])
        val tablesH = c.all(7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e)
        var rh = Double.NaN
        if (tablesH && th.isFinite()) {
            val alt = out.alt
            val pa = if (p.isFinite()) p else if (alt != null) Rs41.stdPressure(alt) else -1.0
            val cap = c.f(69) + (c.f(73) - c.f(69)) * fh
            var cp = (cap / c.f(117) - 1) * c.f(121)
            val tp = (th - 20) / 180; val bk = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, 0.0); for (k in 1 until 6) bk[k] = bk[k - 1] * tp
            if (pa > 0) {
                val pb = pa / 1000; var cpj = 1.0; var corr = 0.0
                for (j in 0 until 3) {
                    val h = c.f(678 + 4 * j); val bp = h * (pb / (1 + h * pb) - cpj / (1 + h))
                    var bt = 0.0; for (k in 0 until 4) bt += c.f(698 + 4 * (4 * j + k)) * bk[k]
                    corr += bp * bt; cpj *= cp
                }
                cp -= corr
            }
            var r = 0.0; var aj = 1.0
            for (j in 0 until 7) { for (k in 0 until 6) r += aj * bk[k] * c.f(125 + 4 * (6 * j + k)); aj *= cp }
            if (pa <= 0 && t < -40) r += (t + 40) / 12
            rh = r * Rs41.vaporSat(th) / Rs41.vaporSat(t)
        } else if (c.all(7)) {
            rh = 100 * ((350 / c.f(117)) * fh - 7.5)
            rh += -t / 5.5
            if (t < -20) rh *= 1 + (-20 - t) / 100
            if (t < -40) rh *= 1 + (-40 - t) / 120
        }
        if (rh.isFinite()) out.rh = max(0.0, min(100.0, rh))
    }

    fun forget(serial: String) { cals.remove(serial) }
}

/** A number the way JavaScript prints it: no ".0" on whole values. */
internal fun jsNum(v: Double): String = if (v == Math.rint(v) && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
