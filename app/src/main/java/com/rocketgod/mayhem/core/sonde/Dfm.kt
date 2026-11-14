package com.rocketgod.mayhem.core.sonde

import java.util.Locale
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.min

/**
 * Graw DFM-06, DFM-09, DFM-17 (and the P variants, PS-15): 2500 baud 2-FSK, Manchester coded ("01" = 1, "10" = 0), so
 * 1250 bits/s in back-to-back 280-bit frames: the 16-bit header 0x45CF, a config block (7 Hamming(8,4) codewords) and
 * two GPS data blocks (13 codewords each), each block sent column-wise (bit 0 of every codeword, then bit 1 ...).
 * Every codeword corrects one bit error; a block with an uncorrectable codeword is dropped. There is no CRC.
 *
 * The data blocks are numbered 0..8 and cycle about once a second; the frame is reported when block 8 (date and time)
 * arrives and blocks 0..4 are fresh. The config block carries one channel per frame: PTU measurements (channels 0..8),
 * battery and MCU temperature, and the serial number, in two 16-bit halves on a channel whose number is the subtype.
 * That state lives in the decoder (one per channel). The Kotlin twin of web/src/dsp/sonde/dfm.ts and Dfm.swift.
 */
object Dfm {
    const val BAUD = 2500
    /** The header 0x45CF as Manchester channel symbols. */
    const val HEADER = "10011010100110010101101001010101"
    const val FRAME_BITS = 280
    /** Channel symbols after the 32-symbol header. */
    const val SYMS = (FRAME_BITS - 16) * 2
    internal const val HEADER_BITS = 0x45cf

    /** Hamming(8,4) codeword (bit 0 = most significant bit of the byte) for a nibble. */
    fun hamming(nib: Int): Int {
        val m0 = (nib shr 3) and 1; val m1 = (nib shr 2) and 1; val m2 = (nib shr 1) and 1; val m3 = nib and 1
        val p4 = m1 xor m2 xor m3; val p5 = m0 xor m2 xor m3; val p6 = m0 xor m1 xor m3; val p7 = m0 xor m1 xor m2
        return ((nib and 0xf) shl 4) or (p4 shl 3) or (p5 shl 2) or (p6 shl 1) or p7
    }

    /** Received byte -> nibble (or -1 when two or more bits are wrong), and whether one bit was corrected. */
    internal val HAM_NIB = IntArray(256)
    internal val HAM_FIX = IntArray(256)
    init {
        for (v in 0 until 256) {
            HAM_NIB[v] = -1
            for (n in 0 until 16) {
                val c = Integer.bitCount(v xor hamming(n))
                if (c <= 1) { HAM_NIB[v] = n; HAM_FIX[v] = c; break }
            }
        }
    }

    /** The DFM float24: a 4-bit exponent over a 20-bit mantissa. */
    fun fl24(d: Int): Double = (d and 0xfffff).toDouble() / (1 shl ((d shr 20) and 0xf))

    /** NTC (EPCOS B57540G0502) resistance, ohms, to degrees C. */
    fun tempFromR(r: Double): Double {
        if (!(r > 0)) return Double.NaN
        val l = ln(r)
        return 1 / (1.09698417e-03 + 2.39564629e-04 * l + 2.48821437e-06 * l * l + 5.84354921e-08 * l * l * l) - 273.15
    }

    /** Seconds since 1980-01-06 for a UTC date and time, as the reference decoder counts them (leap seconds ignored). */
    internal fun gpsSeconds(yy0: Int, mm0: Int, dd: Int, hr: Int, mi: Int, sec: Int): Long {
        var yy = yy0; var mm = mm0
        if (mm < 3) { yy -= 1; mm += 12 }
        val days = floor(365.25 * yy).toLong() + floor(30.6001 * (mm + 1)).toLong() + dd - 723263
        return days * 86400 + hr * 3600 + mi * 60 + sec
    }
}

class DfmDecoder {
    private val bits = IntArray(Dfm.FRAME_BITS)
    private val nib = IntArray(13)
    /** The latest data packet of each number: 6 payload bytes, the frame index it came in. */
    private val pck = IntArray(9 * 6)
    private val pckTs = IntArray(9) { -1000 }
    private var frmcnt = 0
    private var fixedAcc = 0
    // config channel state
    private val cfg = IntArray(16)
    private val val24 = IntArray(16)
    private val meas24 = DoubleArray(16)
    private var ptuOut = 0; private var sondeTyp = 0
    private var nulCh = 0; private var maxCh = 0; private var snCh = 0
    private var chX0 = 0; private var chX1 = 0; private var chXbit = 0; private var snX = 0L
    private var sn = 0L; private var sn6 = 0
    private var serial = ""
    // consistency
    private var lastDiff = -1; private var lastInv = -1

    /** Soft symbols after the header; [inv] = the signal came in with the opposite FM polarity to the header. */
    fun decodeSoft(soft: FloatArray, inv: Boolean = false): SondeFrame? {
        val b = bits
        for (k in 0 until 16) b[k] = (Dfm.HEADER_BITS shr (15 - k)) and 1
        val n = min(Dfm.FRAME_BITS - 16, soft.size shr 1)
        for (k in 0 until n) b[16 + k] = if (soft[2 * k + 1] - soft[2 * k] >= 0) 1 else 0
        for (k in 16 + n until Dfm.FRAME_BITS) b[k] = 0
        return frame(b, inv)
    }

    /** One 280-bit frame (header included). */
    fun frame(bits: IntArray, inv: Boolean = false): SondeFrame? {
        frmcnt++
        var out: SondeFrame? = null
        val ec = block(bits, 16, 7)
        if (ec >= 0) { fixedAcc += ec; conf(ec) }
        for (d in 0 until 2) {
            val e = block(bits, 72 + 104 * d, 13)
            if (e < 0 || e > 4) continue
            fixedAcc += e
            val id = nib[12]
            if (id > 8) continue
            for (k in 0 until 6) pck[id * 6 + k] = (nib[2 * k] shl 4) or nib[2 * k + 1]
            pckTs[id] = frmcnt
            if (id == 8) { val r = output(inv); if (r != null) out = r }
        }
        return out
    }

    /** Deinterleave and correct one block into [nib]. Returns codewords corrected, or -1. */
    private fun block(bits: IntArray, start: Int, l: Int): Int {
        var fixed = 0
        for (i in 0 until l) {
            var v = 0
            for (j in 0 until 8) v = (v shl 1) or bits[start + l * j + i]
            val nb = Dfm.HAM_NIB[v]
            if (nb < 0) return -1
            nib[i] = nb; fixed += Dfm.HAM_FIX[v]
        }
        return fixed
    }

    private fun resetCfg() { cfg.fill(0); ptuOut = 0; serial = "" }
    private fun resetAll() {
        resetCfg(); sondeTyp = 0; chXbit = 0; chX0 = 0; chX1 = 0; snX = 0; sn6 = 0
        nulCh = 0; maxCh = 0; snCh = 0; sn = 0; lastDiff = -1
    }

    /** The config block in nib[0..6]: channel number, then a 24-bit value. */
    private fun conf(ec: Int) {
        val id = nib[0]
        var v24 = 0
        for (k in 1..6) v24 = (v24 shl 4) or nib[k]
        if (ec == 0) { cfg[id] = 1; val24[id] = v24; meas24[id] = Dfm.fl24(v24) }
        // the "null channel": the first channel above 4 with its low 20 bits zero
        if (id > 4 && (v24 and 0xfffff) == 0) nulCh = (id shl 4) or (v24 shr 20)
        val dfm6 = (nulCh and 0xf0) == 0x50 && (nulCh and 0x0f) != 0
        if (dfm6) ptuOut = 6
        if (dfm6 && (sondeTyp and 0xf) > 6) { sondeTyp = 0; maxCh = id; resetCfg() }
        if (id > 5 && id > maxCh && ec == 0 && ((v24 shr 20) and 0xf) == 0xc) maxCh = id
        if (!(id > 5 && (id == (nulCh shr 4) + 1 || id == maxCh))) return
        val sn2 = (id shl 4) or (v24 shr 20); val snChNow = id
        if ((nulCh and 0x58) == 0x58) {
            // DFM-06: the whole value is the serial (BCD, shown as hex), sent twice alike
            if (v24 == sn6 && v24 != 0) {
                sondeTyp = 0x100 or snChNow; ptuOut = 6
                serial = Integer.toHexString(v24).uppercase(Locale.US)
            } else { sondeTyp = 0; resetCfg() }
            sn6 = v24
        } else if ((sn2 and 0xf) == 0xc || (sn2 and 0xf) == 0) {
            // DFM-09/17, PS-15: the serial in two halves, the last nibble says which
            val v = v24 and 0xfffff; val hl = v and 0xf
            if (hl >= 2) return
            if (snCh != snChNow) { chXbit = 0; chX0 = 0; chX1 = 0; resetCfg() }
            snCh = snChNow
            if (hl == 0) chX0 = (v shr 4) and 0xffff else chX1 = (v shr 4) and 0xffff
            chXbit = chXbit or (1 shl hl)
            if (chXbit == 3) {
                val s = (chX0.toLong() shl 16) or chX1.toLong()
                if (s == snX || snX == 0L) {
                    sondeTyp = 0x100 or snChNow; sn = s
                    ptuOut = if (snChNow in 0xa..0xd) snChNow else 0
                    if (sn6 == 0 || (sondeTyp and 0xf) >= 0xa) serial = "$s"
                } else { sondeTyp = 0; resetCfg() }
                snX = s; chXbit = 0
            }
        }
    }

    private fun fresh(id: Int): Boolean = pckTs[8] - pckTs[id] < 6
    private fun u8(id: Int, k: Int): Int = pck[id * 6 + k]
    private fun s32(id: Int, k: Int): Int { val p = id * 6 + k; val b = pck; return (b[p] shl 24) or (b[p + 1] shl 16) or (b[p + 2] shl 8) or b[p + 3] }
    private fun u16(id: Int, k: Int): Int { val p = id * 6 + k; return (pck[p] shl 8) or pck[p + 1] }
    private fun s16(id: Int, k: Int): Int = (u16(id, k) shl 16) shr 16

    /** Block 8 just arrived: put the second together. */
    private fun output(inv: Boolean): SondeFrame? {
        if (!fresh(0)) return null
        var mode = u8(0, 2)
        if (mode != 2 && mode != 3 && mode != 4) mode = 2
        val need = if (mode == 2) intArrayOf(1, 2, 3, 4) else intArrayOf(1, 2, 3)
        for (id in need) if (!fresh(id)) return null
        val frnr = u8(0, 3)
        if (frnr == 0) return null
        // date and time
        val b0 = u8(8, 0); val b1 = u8(8, 1); val b2 = u8(8, 2); val b3 = u8(8, 3)
        val year = (b0 shl 4) or (b1 shr 4); val month = b1 and 0xf; val day = b2 shr 3; val hour = ((b2 and 7) shl 2) or (b3 shr 6); val minute = b3 and 0x3f
        val ms = if (mode == 2) u16(1, 4) else u16(0, 0)
        val sek = ms / 1000.0
        if (sek >= 60 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
        // the polarity must not change under a sonde
        val invN = if (inv) 1 else 0
        if (lastInv >= 0 && invN != lastInv) { resetAll(); lastInv = invN; return null }
        lastInv = invN
        val secGps = Dfm.gpsSeconds(year, month, day, hour, minute, floor(sek + 0.5).toInt())
        val diff = (((secGps and 0xff).toInt()) - frnr) and 0xff
        if (lastDiff >= 0 && diff != lastDiff) {
            // the counter slipped against the clock: a decoding error, or a different sonde
            resetAll(); lastDiff = diff; return null
        }
        lastDiff = diff
        if (serial.isEmpty()) return null

        val out = SondeFrame(type = "DFM", serial = "DFM-$serial", frame = frnr, fixed = fixedAcc)
        fixedAcc = 0
        out.timeS = hour * 3600.0 + minute * 60 + sek
        out.date = "%d-%02d-%02d".format(Locale.US, year, month, day)
        val extra = LinkedHashMap<String, String>()
        if (mode == 2) {
            out.lat = s32(2, 0) / 1e7; out.vH = s16(2, 4) / 100.0
            out.lon = s32(3, 0) / 1e7; out.heading = u16(3, 4) / 100.0
            out.alt = s32(4, 0) / 100.0; out.climb = s16(4, 4) / 100.0
            val nPrn = Integer.bitCount(s32(1, 0))
            val nSv = u8(8, 4)
            out.sats = if (nSv != 0) nSv else nPrn
            if (fresh(5)) extra["GEOID HEIGHT"] = "%.1f m".format(Locale.US, -s16(5, 0) / 100.0)
        } else {
            out.vH = s16(0, 4) / 100.0
            out.lat = s32(1, 0) / 1e7; out.heading = u16(1, 4) / 100.0
            out.lon = s32(2, 0) / 1e7; out.climb = s16(2, 4) / 100.0
            out.alt = s32(3, 0) / 100.0
            out.sats = u8(8, 4).takeIf { it != 0 }
            extra["ALTITUDE"] = "above mean sea level"
            if (mode == 4 && u8(3, 4) != 0) {
                val hex = StringBuilder()
                for (k in 4 until 6) hex.append("%02x".format(u8(3, k)))
                for (id in 4..7) for (k in 0 until 6) hex.append("%02x".format(u8(id, k)))
                extra["AUX DATA"] = hex.toString().uppercase(Locale.US)
            }
        }
        val la = out.lat; val lo = out.lon
        if (la != null && (kotlin.math.abs(la) > 90 || kotlin.math.abs(lo!!) > 180)) return null

        // PTU: the channels the subtype says it sends, all received clean
        val c = cfg
        var cfgchk = 0
        if (ptuOut >= 5) cfgchk = c[0] and c[1] and c[2] and c[3] and c[4] and c[5]
        if (ptuOut >= 7) cfgchk = cfgchk and c[6] and c[7]
        if (ptuOut >= 8) cfgchk = cfgchk and c[8]
        val dfm17A = sn >= 23000000 && inv
        var sensor = 'T'; var rf = 220e3
        if (cfgchk != 0) {
            if (ptuOut >= 0xd || (ptuOut >= 0xc && meas24[6] < 220e3)) sensor = 'P'
            if (((ptuOut == 0xb || ptuOut == 0xc) && sensor == 'T') || ptuOut >= 0xd) rf = 332e3
            if (ptuOut == 0xa && sensor == 'T' && dfm17A) rf = 332e3
            if (ptuOut == 6 && (sondeTyp and 0xf) == 8) sensor = 'P'
        }
        var t = Double.NaN
        if (cfgchk != 0 && ptuOut != 0) {
            val m = meas24
            val f = if (sensor == 'P') m[1] else m[0]; val f1 = if (sensor == 'P') m[5] else m[3]; val f2 = if (sensor == 'P') m[6] else m[4]
            if (f * f1 * f2 != 0.0) {
                val g = f2 / rf; val r = (f - f1) / g
                t = Dfm.tempFromR(r)
            }
            if (t.isFinite() && t > -120 && t < 60) out.tempC = t else t = Double.NaN
        }
        if (ptuOut >= 0xa) {
            val ofs = if (sensor == 'P') 2 else 0
            if (c[5 + ofs] != 0) { val v = ((val24[5 + ofs] shr 4) and 0xffff) / 1000.0; if (v > 0) out.battV = v }
            if (c[6 + ofs] != 0) extra["MCU TEMPERATURE"] = "%.1f °C".format(Locale.US, ((val24[6 + ofs] shr 4) and 0xffff) / 100.0 - 273.15)
            if (rf > 300e3 && c[7 + ofs] != 0) extra["SONDE CLOCK"] = "${(val24[7 + ofs] shr 4) and 0xffff} s"
        }
        val sub = sondeTyp and 0xf
        var model = when (sub) {
            0x6 -> "DFM-06"
            0x7, 0x8 -> if (sn6 != 0) "DFM-06P" else "PS-15"
            0xa -> if (dfm17A) "DFM-17" else "DFM-09"
            0xb -> "DFM-17"
            0xc -> if (sensor == 'P') "DFM-09P" else "DFM-17"
            0xd -> "DFM-17P"
            else -> "DFM"
        }
        if ((sub == 0x8 || sub == 0xc) && cfgchk != 0 && !t.isFinite()) model = "DFM"
        out.model = model
        extra["SUBTYPE"] = "0x${Integer.toHexString(sub).uppercase(Locale.US)}"
        out.extra = extra
        return out
    }
}

/** The DFM decoder on a channel: the framer, plus the FM polarity (a DFM-17 hint). */
class DfmChannel(rate: Double, sink: SondeSink) : ChannelDecoder {
    override val name = "DFM"
    private val dec = DfmDecoder()
    private val ring = FloatArray(1024)
    private var ri = 0
    private val sps = rate / Dfm.BAUD
    private val fr = FskFramer(Dfm.BAUD.toDouble(), rate, Dfm.HEADER, Dfm.SYMS, 2, { soft, _ ->
        val f = dec.decodeSoft(soft, inverted(soft))
        if (f != null && f.serial.isNotEmpty()) sink(f)
    })

    override fun push(x: Double) {
        ring[ri] = x.toFloat(); ri = (ri + 1) and 1023
        fr.push(x)
    }

    /** Whether the framer flipped the symbols: the last 16 soft symbols against the raw discriminator under them. */
    private fun inverted(soft: FloatArray): Boolean {
        val nSym = 16; val total = min(1000, Math.round(nSym * sps).toInt())
        var mean = 0.0
        for (t in 1..total) mean += ring[(ri - t) and 1023]
        mean /= total
        var corr = 0.0
        for (j in 0 until nSym) {
            val a = Math.round(j * sps).toInt() + 1; val b = Math.round((j + 1) * sps).toInt()
            var s = 0.0
            for (t in a..b) s += ring[(ri - t) and 1023] - mean
            corr += soft[soft.size - 1 - j] * s
        }
        return corr < 0
    }
}
