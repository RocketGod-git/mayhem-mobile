package com.rocketgod.mayhem.core.sonde

import java.time.LocalDate
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Meteo-Radiy MRZ (MRZ-3MK / MP3-H1): 2400 baud, Manchester (1 = 10, 0 = 01), bits most significant first, integers
 * little-endian. A frame is AA BF 35, 45 bytes of payload (ECEF position and velocity, or latitude/longitude with
 * FF FF at bytes 30..31 and 42 bytes of payload), CRC16-MODBUS; every frame is sent six times. Each frame also carries
 * one 32-bit configuration word by slot (sensor coefficients, the sonde and sensor-boom serials, the date). The serial
 * is MRZ-<sonde>-<boom>, so nothing is reported until both serial slots have arrived (16 slots, a few seconds each).
 * The Kotlin twin of web/src/dsp/sonde/mrz.ts.
 */
object Mrz {
    const val BAUD = 2399
    /** The tail of AA AA and the first six bits of BF, as Manchester symbols. */
    const val HEADER = "100110011001100110011001100110011001" + "10101010"
    /** Frame bytes 0..49 (ECEF); the decoded bits start inside BF (the header ends 6 bits into it). */
    const val LEN = 50
    internal const val SHIFTS = 3
    /**
     * Symbols handed over after the header. The preamble repeats every bit, so the header also matches (at the allowed
     * two errors) one, two or three bits early; the decoder tries each alignment and the CRC picks the right one.
     */
    const val SYMS = 2 * (2 + (LEN - 2) * 8) + 2 * SHIFTS
    internal const val CRCLEN_ECEF = 45
    internal const val CRCLEN_LATLON = 42

    internal fun u16(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8)
    internal fun i16(b: IntArray, p: Int) = (u16(b, p) shl 16) shr 16
    internal fun i32(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16) or (b[p + 3] shl 24)
    internal fun u32(b: IntArray, p: Int): Long = i32(b, p).toLong() and 0xffffffffL

    /** CRC16-MODBUS (reflected 0x8005, init 0xFFFF). */
    fun crc16modbus(b: IntArray, start: Int, len: Int): Int {
        var c = 0xffff
        for (i in start until start + len) {
            c = c xor b[i]
            for (k in 0 until 8) c = if (c and 1 != 0) (c ushr 1) xor 0xa001 else c ushr 1
        }
        return c and 0xffff
    }

    /** 1980-01-06 as days since 1970. */
    private val GPS_EPOCH_DAY = LocalDate.of(1980, 1, 6).toEpochDay()
    internal fun gpsSecondsOf(yr: Int, mth: Int, day: Int): Long = (LocalDate.of(yr, mth, 1).toEpochDay() + day - 1 - GPS_EPOCH_DAY) * 86400
}

class MrzDecoder {
    private val fr = IntArray(Mrz.LEN)
    private val cfg = LongArray(16)
    private var have = 0
    private var lastTime = -1

    fun decode(soft: FloatArray): SondeFrame? {
        for (shift in 0..Mrz.SHIFTS) {
            val fr = bytesAt(soft, 2 * shift)
            if (crcOk(fr)) return parse(fr)
        }
        return null
    }

    private fun bytesAt(soft: FloatArray, at: Int): IntArray {
        val fr = fr
        fr[0] = 0xaa; fr[1] = 0xbf
        // bit k is the pair (2k, 2k+1): 1 when the first half is higher; bits 0..1 finish the BF
        for (i in 0 until Mrz.LEN - 2) {
            var v = 0
            for (k in 0 until 8) {
                val s = at + 2 * (2 + 8 * i + k)
                val bit = if (s + 1 < soft.size && soft[s] > soft[s + 1]) 1 else 0
                v = (v shl 1) or bit
            }
            fr[2 + i] = v
        }
        return fr
    }

    private fun crcOk(fr: IntArray): Boolean =
        Mrz.crc16modbus(fr, 3, Mrz.CRCLEN_ECEF) == Mrz.u16(fr, 3 + Mrz.CRCLEN_ECEF) || Mrz.crc16modbus(fr, 3, Mrz.CRCLEN_LATLON) == Mrz.u16(fr, 3 + Mrz.CRCLEN_LATLON)

    /** Frame bytes 0..49 (a lat/lon frame uses 0..46). */
    fun parse(fr: IntArray): SondeFrame? {
        val ecefOk = Mrz.crc16modbus(fr, 3, Mrz.CRCLEN_ECEF) == Mrz.u16(fr, 3 + Mrz.CRCLEN_ECEF)
        val llOk = Mrz.crc16modbus(fr, 3, Mrz.CRCLEN_LATLON) == Mrz.u16(fr, 3 + Mrz.CRCLEN_LATLON)
        val marked = fr[30] == 0xff && fr[31] == 0xff
        val latlon: Boolean = if (marked && llOk) true else if (ecefOk) false else return null
        val o = if (latlon) -3 else 0
        // the configuration word for this frame's slot
        val slot = fr[3] and 0x0f; val word = Mrz.u32(fr, 44 + o)
        if (slot == 0x0c || slot == 0x0d) {
            if ((have shr slot) and 1 != 0 && cfg[slot] != word) { have = 0; lastTime = -1 }
        }
        cfg[slot] = word; have = have or (1 shl slot)
        val snC = if ((have shr 0xc) and 1 != 0) cfg[0xc] else 0L; val snD = if ((have shr 0xd) and 1 != 0) cfg[0xd] else 0L
        if (snC == 0L || snD == 0L) return null
        val hh = fr[4]; val mm = fr[5]; val ss = fr[6]
        val timeOk = hh < 24 && mm < 60 && ss < 60
        val tod = hh * 3600 + mm * 60 + ss
        // six copies of every frame: report each time of day once
        if (timeOk && tod == lastTime) return null
        if (timeOk) lastTime = tod
        val out = SondeFrame(type = "MRZ", serial = "MRZ-$snC-$snD", fixed = 0)
        val extra = linkedMapOf("SONDE SERIAL" to "$snC", "SENSOR SERIAL" to "$snD")
        if (timeOk) out.timeS = tod.toDouble()
        if ((have shr 0xf) and 1 != 0) {
            var v = cfg[0xf]
            val yr = (v % 100).toInt() + 2000; v /= 100
            val mth = (v % 100).toInt(); v /= 100
            val day = (v % 100).toInt()
            if (mth in 1..12 && day in 1..31) {
                out.date = "%d-%02d-%02d".format(Locale.US, yr, mth, day)
                if (timeOk) out.frame = (Mrz.gpsSecondsOf(yr, mth, day) + tod).toInt()
            }
        }
        if ((have shr 0xe) and 1 != 0) extra["CALIBRATION DATE"] = "%06d".format(Locale.US, cfg[0xe])
        if (latlon) {
            val lat = Mrz.i32(fr, 7) * 1e-6; val lon = Mrz.i32(fr, 11) * 1e-6; val alt = Mrz.i32(fr, 15) * 1e-2
            if (alt > -1000 && alt < 80000 && abs(lat) <= 90 && abs(lon) <= 180) {
                out.lat = lat; out.lon = lon; out.alt = alt
                out.vH = Mrz.i16(fr, 19) / 100.0; out.heading = Mrz.u16(fr, 21) / 100.0
                extra["ALTITUDE"] = "mean sea level"
            }
        } else {
            val x = Mrz.i32(fr, 8) / 100.0; val y = Mrz.i32(fr, 12) / 100.0; val z = Mrz.i32(fr, 16) / 100.0
            val g = ecefToGeo(x, y, z)
            if ((x != 0.0 || y != 0.0 || z != 0.0) && g.alt > -1000 && g.alt < 80000) {
                out.lat = g.lat; out.lon = g.lon; out.alt = g.alt
                val v = ecefVelToNeu(Mrz.i16(fr, 20) / 100.0, Mrz.i16(fr, 22) / 100.0, Mrz.i16(fr, 24) / 100.0, g.lat, g.lon)
                out.vH = v.vH; out.heading = v.heading; out.climb = v.climb
            }
        }
        out.sats = fr[26 + o]
        val t = Mrz.i16(fr, 29 + o) / 100.0; val rh = Mrz.i16(fr, 31 + o) / 100.0
        if (t > -120 && t < 80) out.tempC = t
        if (rh > -10 && rh < 120) out.rh = max(0.0, min(100.0, rh))
        out.extra = extra
        return out
    }
}
