package com.rocketgod.mayhem.core.sonde

import java.util.Locale
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/**
 * Meteomodem M10 (and M2K2, M10+) and M20: about 9600 baud 2-FSK, biphase-mark coded (two channel symbols per bit, the
 * level flips at every bit boundary and once more in the middle of a 1), so the FM polarity does not matter. A 32-symbol
 * sync, then the frame, bytes most significant bit first: [length - 1, type, data ..., checksum (big-endian)]. No FEC,
 * no whitening: the 16-bit Meteomodem checksum is the only integrity check, and nothing is reported without it.
 * M10 frames are 101 bytes (Trimble GPS, lat/lon in units of 360/2^32 degrees), M20 frames 70 bytes. The Kotlin twin of
 * web/src/dsp/sonde/m10.ts and M10.swift.
 */
object M10 {
    /** M10 at 9615 symbols/s, M20 (and the 2025 M10) at 9600: one slicer in the middle tracks both. */
    const val BAUD = 9608
    /** The sync as channel symbols (biphase-mark zeros, then the code violations). */
    const val HEADER = "11001100110011001010011001001100"
    /** The longest frame: the standard M10 frame plus 64 aux bytes. */
    const val MAX_BYTES = 0x64 + 64 + 1
    const val SYMS = MAX_BYTES * 16

    /** Type bytes (frame[1]): M2K2, M10 (Trimble), the M10 signal-level frame, M10+ (Gtop), M20. */
    internal const val T_M2K2 = 0x8f
    internal const val T_M10 = 0x9f
    internal const val T_M10DUB = 0x49
    internal const val T_M10PLUS = 0xaf
    internal const val T_M20 = 0x20

    /** One step of the Meteomodem checksum. */
    private fun updateCheck(c: Int, b0: Int): Int {
        val c1 = c and 0xff
        var b = ((b0 shr 1) or ((b0 and 1) shl 7)) and 0xff
        b = b xor ((b shr 2) and 0xff)
        val t6 = (c and 1) xor ((c shr 2) and 1) xor ((c shr 4) and 1)
        val t7 = ((c shr 1) and 1) xor ((c shr 3) and 1) xor ((c shr 5) and 1)
        val t = (c and 0x3f) or (t6 shl 6) or (t7 shl 7)
        var s = (c shr 7) and 0xff
        s = s xor ((s shr 2) and 0xff)
        val c0 = (b xor t xor s) and 0xff
        return ((c1 shl 8) or c0) and 0xffff
    }

    /** The checksum over msg[0 .. len-1]. */
    fun check(msg: IntArray, len: Int): Int {
        var cs = 0
        for (i in 0 until len) cs = updateCheck(cs, msg[i] and 0xff)
        return cs and 0xffff
    }

    internal fun be16(b: IntArray, p: Int) = (b[p] shl 8) or b[p + 1]
    internal fun bes16(b: IntArray, p: Int) = (be16(b, p) shl 16) shr 16
    internal fun be24(b: IntArray, p: Int) = (b[p] shl 16) or (b[p + 1] shl 8) or b[p + 2]
    internal fun be32(b: IntArray, p: Int): Long = bes32(b, p).toLong() and 0xffffffffL
    internal fun bes32(b: IntArray, p: Int) = (b[p] shl 24) or (b[p + 1] shl 16) or (b[p + 2] shl 8) or b[p + 3]
    internal fun le16(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8)
    internal fun le24(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16)

    // thermistor fit (both types) and the M10's three ranges: series and parallel resistors
    private const val TP0 = 1.07303516e-03
    private const val TP1 = 2.41296733e-04
    private const val TP2 = 2.26744154e-06
    private const val TP3 = 6.52855181e-08
    internal val RS = doubleArrayOf(12.1e3, 36.5e3, 475.0e3)
    internal val RP = doubleArrayOf(1e20, 330.0e3, 2000.0e3)

    /** The main thermistor's resistance to degrees C (Steinhart-Hart fit). NaN when out of range. */
    fun tempFromR(r: Double): Double {
        if (!(r > 0)) return Double.NaN
        val l = ln(r)
        return 1 / (TP0 + TP1 * l + TP2 * l * l + TP3 * l * l * l) - 273.15
    }

    /** ADC count (12 bits) and range index to degrees C. NaN when invalid. */
    fun tempFromAdc(adc: Int, scT: Int): Double {
        if (scT < 0 || scT > 2 || adc <= 0) return Double.NaN
        val x = (4095.0 - adc) / adc
        val r = RS[scT] / (x - RS[scT] / RP[scT])
        val t = tempFromR(r)
        return if (t < -120 || t > 60) Double.NaN else t
    }

    /** The M10 humidity sensor's own thermistor (SMD NTC, 22.1 k series). */
    fun tntcFromAdc(adc: Int): Double {
        if (adc <= 0 || adc >= 4095) return Double.NaN
        val x = (4095.0 - adc) / adc; val r = 22.1e3 / x; val l = ln(r)
        return 1 / (4.42606809e-03 - 6.58184309e-04 * l + 8.95735557e-05 * l * l - 2.84347503e-06 * l * l * l) - 273.15
    }

    /** The M20 humidity sensor's thermistor (Beta model). */
    fun m20TntcFromAdc(adc: Int): Double {
        if (adc <= 0 || adc >= 4095) return Double.NaN
        val x = (4095.0 - adc) / adc; val r = 22.1e3 / x
        return 1 / (1 / 298.15 + ln(r / 2.2e3) / 3650) - 273.15
    }

    /** M20 relative humidity from the raw count, its calibration word and the sensor temperature. NaN when invalid. */
    fun m20Humidity(humval: Int, rhCal: Int, tu: Double): Double {
        val cal = 6.4e8 / (rhCal + 80000)
        var x = (humval + 80000) * cal * (1 - 5.8e-4 * (tu - 25))
        x = 4.16e9 / x
        x = 10.087 * x * x * x - 211.62 * x * x + 1388.2 * x - 2797.0
        if (humval >= 48000 || !(x > -20 && x < 120)) return Double.NaN
        return max(0.0, min(100.0, x))
    }

    /** M10 serial "YMM-T-Nnnnn" from the five raw bytes at 0x5D. */
    fun m10Serial(f: IntArray, p: Int): String {
        val b2 = f[p + 2]
        val w = f[p + 3] or (f[p + 4] shl 8)
        return "%X%02d-%X-%d%04d".format(Locale.US, (b2 shr 4) and 0xf, b2 and 0xf, f[p] and 0xf, (w shr 13) and 7, w and 0x1fff)
    }

    /** M20 serial "YMM-T-Nnnnn" from the 24-bit little-endian word at 0x12 (all zeros: the counter offset is appended). */
    fun m20Serial(sn24: Int, diffcnt: Int): String {
        if (sn24 == 0) return "000-0-00000-%03d".format(Locale.US, diffcnt and 0xff)
        val ym = sn24 and 0x7f; val y = ym / 12; val m = (ym % 12) + 1
        return "%d%02d-%d-%d%04d".format(Locale.US, y, m, ((sn24 shr 7) and 7) + 1, (sn24 shr 23) and 1, (sn24 shr 10) and 0x1fff)
    }

    /** Heading in degrees true from east and north speed. */
    internal fun headingOf(vE: Double, vN: Double): Double {
        var d = atan2(vE, vN) * 180 / PI
        if (d < 0) d += 360
        return d
    }
}

class M10Decoder {
    private val bits = IntArray(M10.SYMS / 2)
    private val fr = IntArray(M10.MAX_BYTES)

    /** Soft symbols right after the sync. Returns null unless the checksum passes. */
    fun decode(soft: FloatArray): SondeFrame? {
        val nb = min(bits.size, soft.size shr 1)
        for (k in 0 until nb) { val a = soft[2 * k]; val b = soft[2 * k + 1]; bits[k] = if ((a > 0) != (b > 0)) 1 else 0 }
        val nBytes = nb shr 3
        for (i in 0 until nBytes) { var v = 0; for (k in 0 until 8) v = (v shl 1) or bits[8 * i + k]; fr[i] = v }
        for (i in nBytes until fr.size) fr[i] = 0
        return parse(fr, nBytes)
    }

    /** A frame's bytes ([nBytes] of them valid). */
    fun parse(fr: IntArray, nBytes: Int = fr.size): SondeFrame? {
        val type = fr[1]
        // only the type bytes sonde firmware sends (a 16-bit checksum alone lets through one random frame in 65536)
        if (type != M10.T_M10 && type != M10.T_M2K2 && type != M10.T_M10PLUS && type != M10.T_M10DUB && type != M10.T_M20) return null
        val std = if (type == M10.T_M20) 0x45 else 0x64
        val flen = fr[0]
        if (flen == 0) return null
        // the length byte must be one a sonde sends: the standard length, a short M20 (0x43) or an M10 with aux data
        if (type == M10.T_M20) { if (flen != 0x45 && flen != 0x43) return null }
        else if (flen < 0x64 || flen > std + 64) return null
        if (flen + 1 > nBytes) return null
        val posCheck = flen - 1
        if (M10.check(fr, posCheck) != M10.be16(fr, posCheck)) return null
        if (type == M10.T_M10DUB) return null      // signal-level frame: nothing for a card
        return if (type == M10.T_M20) m20(fr, flen) else m10(fr, type, flen)
    }

    private fun m10(f: IntArray, type: Int, flen: Int): SondeFrame {
        val out = SondeFrame(type = "M10", serial = "M10-" + M10.m10Serial(f, 0x5d), frame = f[0x62], fixed = 0)
        out.model = if (type == M10.T_M2K2) "M2K2" else if (type == M10.T_M10PLUS) "M10+" else "M10"
        if (flen > 0x64) out.put("AUX DATA", "${flen - 0x64} bytes")
        if (type == M10.T_M10PLUS) {
            // Gtop GPS
            out.lat = M10.bes32(f, 0x04) / 1e6; out.lon = M10.bes32(f, 0x08) / 1e6
            var a = M10.be24(f, 0x0c); if (a and 0x800000 != 0) a -= 0x1000000
            out.alt = a / 100.0
            val vE = M10.bes16(f, 0x0f) / 100.0; val vN = M10.bes16(f, 0x11) / 100.0
            out.vH = hypot(vE, vN); out.heading = M10.headingOf(vE, vN); out.climb = M10.bes16(f, 0x13) / 100.0
            val t = M10.be24(f, 0x15); val d = M10.be24(f, 0x18)
            out.timeS = ((t / 10000) * 3600 + ((t % 10000) / 100) * 60 + (t % 100)).toDouble()
            val y = 2000 + (d % 100); val mo = (d % 10000) / 100; val dd = d / 10000
            if (mo in 1..12 && dd in 1..31) out.date = "%d-%02d-%02d".format(Locale.US, y, mo, dd)
        } else {
            // Trimble GPS
            var week = M10.be16(f, 0x20)
            val towMs = M10.be32(f, 0x0a)
            val gpsSec = towMs / 1000
            val day = gpsSec / 86400
            if (week <= 4000 && day in 0..6) {
                if (week < 1304) week += 1024
                val b60b60 = (1 shl 30) / 90.0
                out.lat = M10.bes32(f, 0x0e) / b60b60; out.lon = M10.bes32(f, 0x12) / b60b60; out.alt = M10.bes32(f, 0x16) / 1000.0
                val vE = M10.bes16(f, 0x04) / 200.0; val vN = M10.bes16(f, 0x06) / 200.0
                out.vH = hypot(vE, vN); out.heading = M10.headingOf(vE, vN); out.climb = M10.bes16(f, 0x08) / 200.0
                out.sats = f[0x1e]
                val leap = f[0x1f]
                var utcWeek = week; var utc = gpsSec - leap
                if (utc < 0) { utcWeek -= 1; utc += 604800 }
                out.timeS = (utc % 86400) + (towMs % 1000) / 1000.0
                out.date = gpsDate(utcWeek, utc.toDouble())
                out.put("GPS WEEK", "$week")
                out.put("GPS FIX", if (f[0x1d] and 1 != 0) "none" else if (f[0x1d] and 4 != 0) "2D" else "3D")
            }
        }
        // PTU
        val scT = f[0x3e]; val adc = M10.le16(f, 0x3f) - 0xa000
        val t = M10.tempFromAdc(adc, scT)
        if (t.isFinite()) {
            out.tempC = t
            val c55 = M10.le24(f, 0x32) / 1000.0; val cRh = M10.le24(f, 0x35) / 1000.0
            if (c55 > 0) {
                var rh = (cRh / c55 - 0.8955) / 0.002
                if (t < 0) rh += 0 - t / 5.5
                if (t < -30) rh *= 1 + (-30 - t) / 75
                out.rh = max(0.0, min(100.0, rh))
            }
        }
        val tu = M10.tntcFromAdc(M10.le16(f, 0x59))
        if (tu.isFinite() && tu > -120 && tu < 80) out.tHumC = tu
        val bat = M10.le16(f, 0x45)
        out.battV = 2.709 * bat * 2.5 / 1023
        return out
    }

    private fun m20(f: IntArray, flen: Int): SondeFrame {
        val sn24 = M10.le24(f, 0x12)
        val cnt = f[0x15]
        var week = M10.be16(f, 0x1a)
        val tow = M10.be24(f, 0x0f)
        val out = SondeFrame(type = "M20", model = "M20", serial = "", frame = cnt, fixed = 0)
        if (week <= 4000 && tow < 604800) {
            if (week < 1304) week += 1024
            out.lat = M10.bes32(f, 0x1c) / 1e6; out.lon = M10.bes32(f, 0x20) / 1e6; out.alt = M10.be24(f, 0x08) / 100.0
            val vE = M10.bes16(f, 0x0b) / 100.0; val vN = M10.bes16(f, 0x0d) / 100.0
            out.vH = hypot(vE, vN); out.heading = M10.headingOf(vE, vN); out.climb = M10.bes16(f, 0x18) / 100.0
            out.timeS = (tow % 86400).toDouble()          // GPS time, as auto_rx reports it
            out.date = gpsDate(week, tow.toDouble())
            out.put("GPS WEEK", "$week")
        }
        out.serial = "M20-" + M10.m20Serial(sn24, (tow and 0xff) - cnt)
        var fw = f[flen - 2]; if (fw > 0x20) fw = 0
        out.put("FIRMWARE", "0x%02x".format(Locale.US, fw))
        // temperature: the range is coded in the ADC value
        var adc = M10.le16(f, 0x04); var scT = 0
        if (adc > 8191) { scT = 2; adc -= 8192 } else if (adc > 4095) { scT = 1; adc -= 4096 }
        val t = M10.tempFromAdc(adc, scT)
        if (t.isFinite()) out.tempC = t
        val tu = M10.m20TntcFromAdc(M10.le16(f, 0x06))
        if (tu.isFinite() && tu > -120 && tu < 80) {
            out.tHumC = tu
            val rh = M10.m20Humidity(M10.le16(f, 0x02), M10.le16(f, 0x2f), tu)
            if (rh.isFinite()) out.rh = rh
        }
        if (flen >= 0x45) {
            val p0 = if (fw >= 0x07) f[0x16] else 0
            val v = (M10.le16(f, 0x24) shl 8) or p0
            if (v > 0) { val hPa = v / 4096.0; if (hPa < 2560) out.hPa = hPa }
        }
        out.battV = f[0x26] * 3.3 / 255
        return out
    }
}
