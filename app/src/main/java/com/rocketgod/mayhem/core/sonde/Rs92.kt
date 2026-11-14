package com.rocketgod.mayhem.core.sonde

import kotlin.math.max
import kotlin.math.min

/**
 * Vaisala RS92 (RS92-SGP at 400 MHz, RS92-NGP at 1680 MHz): 4800 baud, Manchester (0 = 10, 1 = 01), 8N1 bytes sent
 * least significant bit first, one 240-byte frame per second, no whitening. Six header bytes 2A 2A 2A 2A 2A 10, then
 * blocks [id, len/2, data, CRC16-CCITT LE] at fixed offsets (config, PTU, GPS, aux) and 24 bytes of RS(255,231).
 *
 * The RS92 sends raw GPS (pseudoranges and Doppler per channel), not a position: solving one needs the GPS orbits
 * (an ephemeris or almanac), which the sonde does not send. This decoder reports everything else: serial, frame,
 * reported frequency, burst timer, temperature, humidity and pressure (once the 32-row calibration table is in, about
 * 32 s), GPS time of week, the satellites tracked and the aux words. The NGP scrambles its calibration table and PTU
 * counts; both are unscrambled here. The Kotlin twin of web/src/dsp/sonde/rs92.ts.
 */
object Rs92 {
    const val BAUD = 4800
    /** 2A 2A 10 as 8N1 Manchester symbols: the last three of the six header bytes. */
    const val HEADER = "10100110011001101001" + "1010011001100110100110101010100110101001"
    val HEADER_BYTES = intArrayOf(0x2a, 0x2a, 0x2a, 0x2a, 0x2a, 0x10)
    const val LEN = 240
    /** Channel symbols after the header: 234 bytes of 20 symbols. */
    const val SYMS = (LEN - 6) * 20

    /** Calibration bytes 0x170..0x17F of every RS92-SGP; an NGP's differ (they key its scrambling). */
    val CALX170 = intArrayOf(0x36, 0x98, 0x92, 0x25, 0x6b, 0xb3, 0x99, 0xe1, 0x57, 0x05, 0x30, 0x9a, 0xfe, 0x51, 0xf4, 0xab)

    internal const val POS_CFG = 0x08
    internal const val POS_PTU = 0x2c
    internal const val POS_GPS = 0x48
    internal const val POS_AUX = 0xc6
    internal const val LEN_CFG = 32
    internal const val LEN_PTU = 24
    internal const val LEN_GPS = 122
    internal const val LEN_AUX = 10
    internal const val POS_PAR = 216
    internal const val MSG_LEN = 210

    internal fun u16(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8)
    internal fun u24(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16)
    internal fun u32(b: IntArray, p: Int): Long = (b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16) or (b[p + 3] shl 24)).toLong() and 0xffffffffL
    internal val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    /** The NGP's PTU scrambling key, from calibration bytes 0x24..0x2E (32-bit unsigned arithmetic). */
    fun ptuKey(cal: IntArray, out: IntArray) {
        val base = 0x24
        for (j in 0 until 8) {
            var tmp = 0x1d89
            for (k in 0 until 4) {
                var a = cal[base + j + k] + tmp; var c = a
                a = (a shl 10) + c; c = a
                a = (a ushr 6) xor c; tmp = a
            }
            var a = tmp; var c = a
            a = (a shl 3) + c; c = a
            a = (a ushr 11) xor c; c = a
            a = (a shl 15) + c
            out[2 * j] = a and 0xff
            out[2 * j + 1] = (a ushr 8) and 0xff
        }
    }

    private fun poly5(x: Double, f: DoubleArray, at: Int): Double =
        ((((f[at + 5] * x + f[at + 4]) * x + f[at + 3]) * x + f[at + 2]) * x + f[at + 1]) * x + f[at]

    /** One sensor through its calibration: x = 1 / (y0 - (ref1 - m) / (ref1 - ref)), value = poly5(x). NaN if invalid. */
    internal fun sensor(m: Int, ref1: Int, ref: Int, f: DoubleArray, at: Int, y0i: Int): Double {
        val t = (ref1 - m).toDouble(); val t0 = (ref1 - ref).toDouble()
        if (t <= 0 || t0 <= 0) return Double.NaN
        for (k in 0 until 6) if (!f[at + k].isFinite()) return Double.NaN
        val y0 = f[y0i]
        if (!y0.isFinite()) return Double.NaN
        val x = 1 / (y0 - t / t0)
        return poly5(x, f, at)
    }

    /** RS(255,231) parity for a frame being built (tests). */
    fun parity(fr: IntArray) {
        val cw = IntArray(255)
        for (i in 0 until MSG_LEN) cw[24 + i] = fr[6 + i]
        ReedSolomon.VAISALA.encode(cw)
        for (i in 0 until 24) fr[POS_PAR + i] = cw[i]
    }
}

/** One sonde's calibration table, row by row, and what it unlocks once complete. */
private class Rs92Cal {
    val bytes = IntArray(32 * 16)
    val have = IntArray(32)
    var count = 0
    /** Coefficients by index (NaN = not sent), built once all 32 rows are in. */
    var f: DoubleArray? = null
    var ngp = false
    val xptu = IntArray(16)

    fun set(row: Int, fr: IntArray, p: Int) {
        if (row >= 32 || have[row] != 0) return
        for (k in 0 until 16) bytes[row * 16 + k] = fr[p + k]
        have[row] = 1; count++
        if (count == 32) build()
    }

    private fun build() {
        val c = bytes
        var sgp = true
        for (i in 0 until 16) if (c[0x170 + i] != Rs92.CALX170[i]) { sgp = false; break }
        ngp = !sgp
        // the NGP key: the bytes at 0x170 against the SGP's, a few of them swapped
        val key = IntArray(16)
        if (ngp) {
            val p = 0x170; val q = Rs92.CALX170
            for (k in 0 until 3) {
                key[5 * k] = c[p + 5 * k] xor q[5 * k]
                key[5 * k + 1] = c[p + 5 * k + 1] xor q[5 * k + 1]
                key[5 * k + 3] = c[p + 5 * k + 3] xor q[5 * k + 2]
                key[5 * k + 4] = c[p + 5 * k + 4] xor q[5 * k + 3]
                key[5 * k + 2] = c[p + 5 * k + 2] xor q[5 * k + 4]
            }
            key[15] = c[p + 15] xor q[15]
            Rs92.ptuKey(bytes, xptu)
        }
        // 66 records [index, float32] from 0x40
        val f = DoubleArray(256) { Double.NaN }
        for (r in 0 until 66) {
            val j = 5 * r; val at = 0x40 + j
            val idx = c[at] xor key[j % 16]
            val d0 = c[at + 1] xor key[(j + 1) % 16]; val d1 = c[at + 2] xor key[(j + 2) % 16]
            val d2 = c[at + 3] xor key[(j + 3) % 16]; val d3 = c[at + 4] xor key[(j + 4) % 16]
            val bits = if (ngp) d1 or (d2 shl 8) or (d0 shl 16) or (d3 shl 24) else d0 or (d1 shl 8) or (d2 shl 16) or (d3 shl 24)
            f[idx] = Float.fromBits(bits).toDouble()
        }
        this.f = f
    }
}

class Rs92Decoder {
    private val cals = LinkedHashMap<String, Rs92Cal>()
    private val cw = IntArray(255)
    private val fr = IntArray(Rs92.LEN)
    private val ptu = IntArray(Rs92.LEN_PTU)

    /** One frame's soft symbols (after the header). */
    fun decode(soft: FloatArray): SondeFrame? {
        val fr = fr
        for (i in 0 until 6) fr[i] = Rs92.HEADER_BYTES[i]
        val n = min(Rs92.LEN - 6, soft.size / 20)
        for (i in 0 until n) {
            // symbols: start pair, 8 data pairs (LSB first), stop pair; a data pair (a, b) is 1 when b > a
            val b0 = 20 * i + 2
            var v = 0
            for (k in 0 until 8) if (soft[b0 + 2 * k + 1] > soft[b0 + 2 * k]) v = v or (1 shl k)
            fr[6 + i] = v
        }
        for (i in 6 + n until Rs92.LEN) fr[i] = 0
        return parse(fr)
    }

    /** A 240-byte frame, header included (repaired in place). */
    fun parse(fr: IntArray): SondeFrame? {
        val fixed = ecc(fr)
        if (ReedSolomon.crc16ccitt(fr, Rs92.POS_CFG, Rs92.LEN_CFG) != Rs92.u16(fr, Rs92.POS_CFG + Rs92.LEN_CFG)) return null
        val sb = StringBuilder()
        for (k in 0 until 8) {
            val c = fr[0x0c + k]
            if (c < 0x20 || c > 0x7e) return null
            sb.append(c.toChar())
        }
        val serial = sb.toString()
        val out = SondeFrame(type = "RS92", serial = serial, frame = Rs92.u16(fr, Rs92.POS_CFG))
        if (fixed >= 0) out.fixed = fixed
        var cal = cals[serial]
        if (cal == null) {
            cal = Rs92Cal(); cals[serial] = cal
            if (cals.size > 64) cals.remove(cals.keys.first())
        }
        val row = fr[0x17]
        cal.set(row, fr, 0x18)
        val extra = linkedMapOf("POSITION" to "raw GPS only (needs an ephemeris)", "CALIBRATION" to "${cal.count}/32")
        // row 0: the reported frequency and the burst timer
        val code = if (cal.have[0] != 0) Rs92.u16(cal.bytes, 2) else -1; val kill = if (cal.have[0] != 0) Rs92.u16(cal.bytes, 4) else -1
        val cf = cal.f
        val ngp = if (cf != null) cal.ngp else code > 1000
        if (cf != null) out.model = if (cal.ngp) "RS92-NGP" else "RS92-SGP"
        if (code >= 0) out.txKHz = (if (ngp) 1_600_000 else 400_000) + 10 * code
        if (kill in 0 until 0xffff) out.killS = kill
        // PTU
        if (cf != null && ReedSolomon.crc16ccitt(fr, Rs92.POS_PTU, Rs92.LEN_PTU) == Rs92.u16(fr, Rs92.POS_PTU + Rs92.LEN_PTU)) {
            val m = ptu
            for (j in 0 until Rs92.LEN_PTU) {
                var b = fr[Rs92.POS_PTU + j]
                if (cal.ngp) b = b xor fr[Rs92.POS_CFG + (j and 1)] xor cal.xptu[j % 16]
                m[j] = b
            }
            val temp = Rs92.u24(m, 0); val hum1 = Rs92.u24(m, 3); val hum2 = Rs92.u24(m, 6); val ref1 = Rs92.u24(m, 9)
            val pres = Rs92.u24(m, 15); val ref3 = Rs92.u24(m, 18); val ref4 = Rs92.u24(m, 21)
            val t = Rs92.sensor(temp, ref1, ref4, cf, 30, 37)
            if (t.isFinite() && t > -120 && t < 80) out.tempC = t
            val u1 = Rs92.sensor(hum1, ref1, ref3, cf, 40, 47); val u2 = Rs92.sensor(hum2, ref1, ref3, cf, 50, 57)
            val u = if (u1.isFinite() && u2.isFinite()) max(u1, u2) else if (u1.isFinite()) u1 else u2
            if (u.isFinite()) out.rh = max(0.0, min(100.0, u))
            val p = Rs92.sensor(pres, ref1, ref4, cf, 10, 17)
            if (p.isFinite() && p > 0 && p < 2000) out.hPa = p
        }
        // GPS: time of week and the channels tracking a satellite
        if (ReedSolomon.crc16ccitt(fr, Rs92.POS_GPS, Rs92.LEN_GPS) == Rs92.u16(fr, Rs92.POS_GPS + Rs92.LEN_GPS)) {
            val tow = Rs92.u32(fr, Rs92.POS_GPS) / 1000.0
            out.timeS = tow % 86400
            extra["GPS WEEKDAY"] = Rs92.WEEKDAYS[(tow / 86400).toLong().toInt() % 7]
            val prns = ArrayList<Int>()
            var sats = 0; var clearNext = false
            for (w in 0 until 4) {
                val word = Rs92.u16(fr, 0x4e + 2 * w)
                for (c in 0 until 3) {
                    val ch = 3 * w + c; val st = fr[0x56 + ch]
                    var prn = (word shr (5 * c)) and 0x1f
                    if (clearNext) { prn = prn and 0x1e; clearNext = false }
                    if (prn == 0 && (st and 0x0f) != 0) {
                        if (c == 2) { if (word and 0x8000 != 0) prn = 32 }
                        else if ((word shr (5 * (c + 1))) and 1 != 0) { prn = 32; clearNext = true }
                    }
                    if ((st and 0x0f) == 0x0f) { sats++; if (prn != 0) prns.add(prn) }
                }
            }
            out.sats = sats
            if (prns.isNotEmpty()) extra["PRN"] = prns.joinToString(" ")
        }
        // aux words (ozone and other add-on sensors)
        if (ReedSolomon.crc16ccitt(fr, Rs92.POS_AUX, Rs92.LEN_AUX) == Rs92.u16(fr, Rs92.POS_AUX + Rs92.LEN_AUX)) {
            var any = 0; val s = StringBuilder()
            for (i in 0 until 4) { val v = Rs92.u16(fr, 0xc8 + 2 * i); any = any or v; s.append("%04x".format(v)) }
            if (any != 0) extra["AUX"] = s.toString()
        }
        out.extra = extra
        return out
    }

    /** RS(255,231): frame[216+i] is X^i, frame[6+i] is X^(24+i). Bytes fixed, or -1 beyond repair. */
    private fun ecc(fr: IntArray): Int {
        val cw = cw
        cw.fill(0)
        for (i in 0 until 24) cw[i] = fr[Rs92.POS_PAR + i]
        for (i in 0 until Rs92.MSG_LEN) cw[24 + i] = fr[6 + i]
        val n = ReedSolomon.VAISALA.decode(cw)
        if (n < 0) return -1
        for (i in 0 until 24) fr[Rs92.POS_PAR + i] = cw[i]
        for (i in 0 until Rs92.MSG_LEN) fr[6 + i] = cw[24 + i]
        return n
    }

    fun forget(serial: String) { cals.remove(serial) }
}
