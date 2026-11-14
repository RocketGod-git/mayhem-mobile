package com.rocketgod.mayhem.core.sonde

import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/**
 * Meisei iMS-100 and RS-11G (Japan): 1200 bit/s biphase-S on FM (2400 half-symbols a second), sent continuously.
 * A frame is 600 bits (half a second): two 300-bit subframes, each a 24-bit header (0x049DCE, then 0xFB6230) and six
 * 46-bit blocks. A block is a BCH(63,51) codeword shortened to (46,34): two 16-bit words, each followed by an odd
 * parity bit (1 when the word has an even number of ones), then 12 check bits; the code repairs two bits a block.
 * Fields are most significant bit first. Word 7 of subframe 0 names the model (0x30C1/0x31C1 iMS-100, 0x30A2/0x31A2
 * RS-11G). The frame counter (subframe 0, word 0) counts half seconds; even and odd frames carry different data, so
 * a complete report takes an even frame and the odd one after it. A 64-slot configuration table arrives one float a
 * frame (serial number, transmit frequency, the temperature and humidity calibration).
 * The Kotlin twin of web/src/dsp/sonde/meisei.ts.
 */
object Meisei {
    const val BAUD = 2400
    /** The raw biphase-S half-symbols of the subframe 0 header 0x049DCE (one of the two line polarities). */
    const val HEADER = "101010101011010100101011001101001100101011001101"
    /** Half-symbols after the header: the rest of the 600-bit frame. */
    const val SYMS = 1152
    const val HDR0 = 0x049dce
    const val HDR1 = 0xfb6230

    /** x^12 + x^10 + x^8 + x^5 + x^4 + x^3 + 1 */
    private const val BCH_G = 0x1539
    /** The remainder mod g of the block bit at position p (block bit 0 is x^45, bit 45 is x^0). */
    val BCH_REM = IntArray(46).also { r ->
        var v = 1
        for (p in 45 downTo 0) { r[p] = v; v = v shl 1; if (v and 0x1000 != 0) v = v xor BCH_G }
    }
    /**
     * Syndrome to error pattern for every pattern of up to two bits inside the 46 (the code's distance is 5, so all of
     * them differ): 0 = clean, (p + 1) one bit, (p + 1) | (q + 1) << 8 two bits, -1 = beyond repair (or an error that
     * would land in the shortened-away positions).
     */
    private val BCH_FIX = IntArray(4096) { -1 }.also { t ->
        t[0] = 0
        for (p in 0 until 46) t[BCH_REM[p]] = p + 1
        for (p in 0 until 46) for (q in p + 1 until 46) t[BCH_REM[p] xor BCH_REM[q]] = (p + 1) or ((q + 1) shl 8)
    }

    /** Repair one 46-bit block in place. Returns bits fixed (0..2), or -1 when it is beyond repair or a parity bit fails. */
    fun blockFix(bits: IntArray, start: Int): Int {
        var s = 0
        for (p in 0 until 46) if (bits[start + p] != 0) s = s xor BCH_REM[p]
        val e = BCH_FIX[s]
        if (e < 0) return -1
        var fixed = 0
        if (e > 0) {
            bits[start + (e and 255) - 1] = bits[start + (e and 255) - 1] xor 1; fixed = 1
            val q = e shr 8
            if (q > 0) { bits[start + q - 1] = bits[start + q - 1] xor 1; fixed = 2 }
        }
        // each 16-bit word and its parity bit hold an odd number of ones
        var a = 0; var b = 0
        for (k in 0 until 17) { a += bits[start + k]; b += bits[start + 17 + k] }
        if ((a and 1) == 0 || (b and 1) == 0) return -1
        return fixed
    }

    /** Build a block from two words (the encoder; also used by the tests). */
    fun block(wa: Int, wb: Int, out: IntArray, pos: Int) {
        var pa = 1; var pb = 1
        for (k in 0 until 16) {
            val x = (wa shr (15 - k)) and 1; val y = (wb shr (15 - k)) and 1
            out[pos + k] = x; out[pos + 17 + k] = y; pa = pa xor x; pb = pb xor y
        }
        out[pos + 16] = pa; out[pos + 33] = pb
        var r = 0
        for (p in 0 until 34) if (out[pos + p] != 0) r = r xor BCH_REM[p]
        for (i in 0 until 12) out[pos + 34 + i] = (r shr (11 - i)) and 1
    }

    internal fun bitsVal(bits: IntArray, pos: Int, n: Int): Int { var v = 0; for (k in 0 until n) v = (v shl 1) or bits[pos + k]; return v }
    /** Word j (0..11) of the subframe starting at [base]. */
    internal fun word(bits: IntArray, base: Int, j: Int): Int = bitsVal(bits, base + 24 + 46 * (j shr 1) + 17 * (j and 1), 16)
    internal fun i16(v: Int) = (v shl 16) shr 16
    internal fun swap16(v: Int) = ((v shr 8) and 0xff) or ((v and 0xff) shl 8)

    /** A 32-bit pattern as an IEEE float (iMS-100). */
    internal fun f32(bits32: Int): Double = Float.fromBits(bits32).toDouble()
    /** The RS-11G's own float: sign at bit 23, exponent in the top byte, and a factor 4. */
    fun f32e2(num: Int): Double {
        val v = ((num and 0x800000) shl 8) or ((num ushr 1) and 0x7f800000) or (num and 0x7fffff)
        return f32(v) / 4
    }
    /** The inverse of f32e2 (the encoder). */
    fun toF32e2(f: Double): Int {
        val v = (f * 4).toFloat().toRawBits()
        return (((v ushr 23) and 0xff) shl 24) or (((v ushr 31) and 1) shl 23) or (v and 0x7fffff)
    }

    /** The century-less year: the digit the iMS-100 sends, placed in the decade around the reference year. */
    internal fun estYear(y0: Int, refYear: Int): Int {
        var roll = 20; var off = 20
        if (refYear > 2003 && refYear < 2100) { roll = refYear - 2004; off = (roll / 10) * 10 }
        var y = (y0 % 10) + off
        if (y < roll) y += 10
        return 2000 + y
    }

    /** NMEA-style ddmm.mmmm x 1e4 (as an int) to degrees. */
    internal fun nmeaDeg(v: Int): Double {
        val deg = (v / 1e6).toLong().toDouble()
        return deg + (v / 1e6 - deg) * 100 / 60
    }

    internal fun pad2(n: Int) = (if (n < 10) "0" else "") + n
}

private class EvenPart(
    val c: Int, var ok: Boolean = false,
    var lat: Double = Double.NaN, var lon: Double = Double.NaN, var alt: Double = Double.NaN, var vH: Double = Double.NaN,
    var heading: Double = Double.NaN, var climb: Double = Double.NaN, var hasClimb: Boolean = false,
    var timeS: Double = Double.NaN, var date: String = "", var tempC: Double = Double.NaN, var rh: Double = Double.NaN,
)

class MeiseiDecoder {
    private val cfg = DoubleArray(64)
    private val have = IntArray(64)
    private var model = ""
    private var serial = 0L
    private var fRef = 0
    private var txKHz = 0
    private var pend: EvenPart? = null
    private val bits = IntArray(600)
    /** The year the iMS-100's single year digit is placed around. */
    var refYear = Instant.now().atOffset(ZoneOffset.UTC).year

    /** One frame's soft half-symbols after the header. */
    fun decode(soft: FloatArray): SondeFrame? {
        val b = bits
        for (k in 0 until 24) b[k] = (Meisei.HDR0 shr (23 - k)) and 1
        // biphase-S: two equal halves = 1, a mid-cell transition = 0 (either line polarity)
        for (j in 0 until 576) b[24 + j] = if (soft[2 * j] * soft[2 * j + 1] > 0) 1 else 0
        return parse(b)
    }

    /** A 600-bit frame (both subframes, headers included). Repaired in place. */
    fun parse(b: IntArray): SondeFrame? {
        val errs = IntArray(12)
        var bad0 = 0; var bad1 = 0; var fixed = 0; var worst0 = 0; var worst1 = 0
        for (s in 0 until 2) {
            for (k in 0 until 6) {
                val e = Meisei.blockFix(b, 300 * s + 24 + 46 * k)
                errs[6 * s + k] = e
                if (e < 0) { if (s == 0) bad0++ else bad1++; continue }
                fixed += e
                if (s == 0 && e > worst0) worst0 = e
                if (s == 1 && e > worst1) worst1 = e
            }
        }
        if (bad0 > 0) return null
        // the second header should read 0xFB6230; more than a few wrong bits means subframe 1 is not where we think
        val hdrErr = Integer.bitCount(Meisei.bitsVal(b, 300, 24) xor Meisei.HDR1)
        val sub1 = bad1 == 0 && hdrErr <= 4

        val c = Meisei.word(b, 0, 0)
        val flag = Meisei.word(b, 0, 7)
        if ((flag and 0xfe00) != 0x3000 || ((flag shr 8) and 1) != (c and 1)) return null
        val model = if ((flag and 0xff) >= 0xc0) "iMS-100" else "RS-11G"
        if (model != this.model) { reset(); this.model = model }
        val ims = model == "iMS-100"

        // configuration slot c % 64
        var w2 = Meisei.word(b, 0, 2); var w3 = Meisei.word(b, 0, 3)
        val cfgOk: Boolean
        val fw: Double
        if (ims) {
            cfgOk = errs[0] < 2 && errs[1] < 2
            fw = Meisei.f32((w3 shl 16) or w2)
        } else {
            // RS-11G: no checksum anywhere, so only blocks needing at most one repaired bit are trusted
            cfgOk = worst0 <= 1
            w2 = Meisei.swap16(w2); w3 = Meisei.swap16(w3)
            fw = Meisei.f32e2((w3 shl 16) or w2)
        }
        val slot = c % 64
        // a serial slot whose blocks needed two repairs still counts when it reads as a whole number (a wrong repair
        // would hardly give one), and agrees with the serial we have, if any
        if (!cfgOk && slot % 16 == 0 && fw > 0 && fw < 1e9 && fw == Math.round(fw).toDouble() && (serial == 0L || fw == serial.toDouble())) {
            if (serial == 0L) { this.model = model; serial = fw.toLong() }
        }
        if (cfgOk && fw.isFinite()) {
            if (slot % 16 == 0 && fw > 0 && fw < 1e9) {
                val sn = Math.round(fw)
                if (serial != 0L && sn != serial) reset()
                this.model = model; serial = sn
            }
            cfg[slot] = fw; have[slot] = 1
            if (slot == 15) txKHz = Math.round((if (ims) 400_000 else 403_700) + fw * 100).toInt()
            if (c % 4 == 0) fRef = Meisei.word(b, 0, 1)
            if (ims && c % 4 == 3) fRef = Meisei.word(b, 0, 6)
        }

        if (c % 2 == 0) {
            val p = EvenPart(c)
            if (ims) {
                val ms = Meisei.word(b, 0, 10); val hm = Meisei.word(b, 0, 11); val hh = hm shr 8; val mm = hm and 0xff
                if (hh < 24 && mm < 60 && ms < 60000) p.timeS = hh * 3600 + mm * 60 + ms / 1000.0
            }
            ptu(b, ims, p)
            if (sub1) {
                if (ims) {
                    var sum = Meisei.word(b, 0, 10) + Meisei.word(b, 0, 11)
                    for (j in 0 until 11) sum += Meisei.word(b, 300, j)
                    if ((sum and 0xffff) == Meisei.word(b, 300, 11)) {
                        val d = Meisei.word(b, 300, 0)
                        val day = d / 1000; val mon = (d / 10) % 100
                        if (day in 1..31 && mon in 1..12) p.date = "${Meisei.estYear(d % 10, refYear)}-${Meisei.pad2(mon)}-${Meisei.pad2(day)}"
                        val lat = (Meisei.word(b, 300, 1) shl 16) or Meisei.word(b, 300, 2); val lon = (Meisei.word(b, 300, 3) shl 16) or Meisei.word(b, 300, 4)
                        p.lat = Meisei.nmeaDeg(lat); p.lon = Meisei.nmeaDeg(lon)
                        p.alt = ((Meisei.word(b, 300, 5) shl 8) or (Meisei.word(b, 300, 6) shr 8)) / 100.0
                        p.heading = Meisei.word(b, 300, 9) / 100.0
                        p.vH = Meisei.word(b, 300, 10) / 194.384
                        p.ok = true
                    }
                } else {
                    p.lat = ((Meisei.word(b, 300, 1) shl 16) or Meisei.word(b, 300, 2)) / 1e7
                    p.lon = ((Meisei.word(b, 300, 3) shl 16) or Meisei.word(b, 300, 4)) / 1e7
                    p.alt = ((Meisei.word(b, 300, 5) shl 16) or Meisei.word(b, 300, 6)) / 100.0
                    p.vH = Meisei.word(b, 300, 7) / 100.0
                    p.heading = Meisei.word(b, 300, 8) / 100.0
                    p.climb = Meisei.i16(Meisei.word(b, 300, 9)) / 100.0; p.hasClimb = true
                    val yy = (Meisei.word(b, 300, 10) and 0xff) + 0x700; val md = Meisei.word(b, 300, 11); val mon = md shr 8; val day = md and 0xff
                    if (yy > 1980 && mon in 1..12 && day in 1..31) p.date = "$yy-${Meisei.pad2(mon)}-${Meisei.pad2(day)}"
                    p.ok = worst1 <= 1
                }
            }
            pend = p
            return null
        }

        // odd frame: completes the even one before it
        val p = pend
        pend = null
        if (p == null || p.c != c - 1 || !p.ok) return null
        if (ims) {
            if (sub1) {
                var sum = Meisei.word(b, 0, 10) + Meisei.word(b, 0, 11)
                for (j in 0 until 11) sum += Meisei.word(b, 300, j)
                val vu = Meisei.i16(Meisei.word(b, 300, 1))
                if ((sum and 0xffff) == Meisei.word(b, 300, 11) && vu != 0) { p.climb = vu / 19.4384; p.hasClimb = true }
            }
        } else {
            val ms = Meisei.swap16(Meisei.word(b, 0, 10)); val hm = Meisei.word(b, 0, 11); val hh = hm shr 8; val mm = hm and 0xff
            if (hh < 24 && mm < 60 && ms < 60000) p.timeS = hh * 3600 + mm * 60 + ms / 1000.0
        }
        if (serial == 0L) return null
        val out = SondeFrame(type = "MEISEI", model = model, serial = "$serial", frame = p.c, fixed = fixed)
        if (p.timeS.isFinite()) out.timeS = p.timeS
        if (p.date.isNotEmpty()) out.date = p.date
        if (p.lat > -90 && p.lat < 90 && p.lon > -180 && p.lon < 180 && p.alt > -1000 && p.alt < 80000 && (p.lat != 0.0 || p.lon != 0.0)) {
            out.lat = p.lat; out.lon = p.lon; out.alt = p.alt
            if (p.vH >= 0 && p.vH < 1000) out.vH = p.vH
            if (p.heading >= 0 && p.heading <= 360) out.heading = p.heading
            if (p.hasClimb && abs(p.climb) < 1000) out.climb = p.climb
        }
        if (p.tempC.isFinite()) out.tempC = p.tempC
        if (p.rh.isFinite()) out.rh = p.rh
        if (txKHz != 0) out.txKHz = txKHz
        out.put("CALIBRATION", "${have.sum()}/64")
        return out
    }

    /** Temperature (a resistance looked up in the calibrated table) and humidity, from an even frame. */
    private fun ptu(b: IntArray, ims: Boolean, p: EvenPart) {
        if (fRef == 0) return
        val c = cfg; val h = have
        val rLo = if (ims) 33 else 37; val nPts = if (ims) 12 else 11; val poly = if (ims) 53 else 33
        var tOk = true
        for (i in 0 until nPts) if (h[17 + i] == 0 || h[rLo + i] == 0) tOk = false
        for (i in 0 until 4) if (h[poly + i] == 0) tOk = false
        // sanity: resistances rise, temperatures fall
        var i = 1
        while (tOk && i < nPts) { if (!(c[rLo + i] > c[rLo + i - 1]) || !(c[17 + i] < c[17 + i - 1])) tOk = false; i++ }
        if (tOk && c[rLo] <= 0) tOk = false
        if (tOk) {
            var f = Meisei.word(b, 0, 5).toDouble() / fRef * 4
            if (f > 1) {
                f = 1 / (f - 1)
                val r = c[poly] + c[poly + 1] * f + c[poly + 2] * f * f - c[poly + 3]
                var t = Double.NaN
                if (r <= c[rLo]) t = c[17]
                else if (r >= c[rLo + nPts - 1]) t = c[17 + nPts - 1]
                else {
                    for (j in 0 until nPts - 1) {
                        if (r < c[rLo + j + 1]) {
                            val g = (ln(r) - ln(c[rLo + j])) / (ln(c[rLo + j + 1]) - ln(c[rLo + j]))
                            t = c[17 + j] - g * (c[17 + j] - c[18 + j])
                            break
                        }
                    }
                }
                if (t > -120 && t < 70) p.tempC = t
            }
        }
        if (h[49] != 0 && h[50] != 0 && h[51] != 0 && h[52] != 0) {
            val f = Meisei.word(b, 0, 6).toDouble() / fRef * 4
            val rh = c[49] + c[50] * f + c[51] * f * f + c[52] * f * f * f
            if (rh.isFinite()) p.rh = max(0.0, min(100.0, rh))
        }
    }

    private fun reset() {
        cfg.fill(0.0); have.fill(0)
        serial = 0; fRef = 0; txKHz = 0; pend = null; model = ""
    }
}

/**
 * Meisei on a channel: a half-symbol clock on the discriminator's transitions (integrate and dump), then the cell
 * alignment found from the cell boundaries themselves (biphase-S always changes level there, so a leaky count of the
 * level changes at even and at odd half-symbol boundaries shows which is which, and a clock slip only costs a few
 * bits), then the 24-bit header 0x049DCE in the decoded bits (biphase-S bits do not depend on the FM polarity) and
 * the rest of the 600-bit frame.
 */
class MeiseiChannel(rate: Double, private val sink: SondeSink) : ChannelDecoder {
    override val name = "MEISEI"
    private val dec = MeiseiDecoder()
    private val inc = Meisei.BAUD / rate
    private var phase = 0.0; private var acc = 0.0; private var dc = 0.0; private var amp = 0.0; private var lastPos = false
    private var h1 = 0.0                       // the previous half-symbol
    private var k = 0L                         // half-symbols so far
    private var score = 0.0                    // > 0: cells start on even half-symbols
    private var cellPar = 0
    private var sh = 0                         // the last 24 bits
    private var collecting = 0
    private val bits = IntArray(600)
    private var nb = 0
    private val ring = DoubleArray(max(1, Math.round(rate / Meisei.BAUD / 4).toInt())); private var rp = 0; private var rs = 0.0
    /** Timing-loop gain per level change. */
    var gain = 0.05
    /** Level changes counted only this close to a boundary, in half-symbols. */
    var gate = 0.35

    override fun push(x: Double) {
        dc += (x - dc) * 0.0005
        var v = x - dc
        // FM clicks (a near-2π phase jump in a few samples) would swamp a half-symbol's sum: clip at 1.5 times the mean level
        val a = if (v < 0) -v else v
        amp += (a - amp) * 0.001
        val lim = 1.5 * amp
        if (v > lim) v = lim else if (v < -lim) v = -lim
        // a short running mean (a quarter of a half-symbol) before the slicer, so noise makes fewer false crossings
        val m = ring.size
        rs += v - ring[rp]; ring[rp] = v; rp = if (rp + 1 == m) 0 else rp + 1
        v = rs / m
        val pos = v > 0
        if (pos != lastPos) {
            // level changes far from a boundary are noise; leave them out
            val err = if (phase < 0.5) phase else phase - 1
            if (err < gate && err > -gate) phase -= err * gain
        }
        lastPos = pos
        acc += v
        phase += inc
        if (phase < 1) return
        phase -= 1
        val h = acc; acc = 0.0
        half(h)
    }

    private fun half(h: Double) {
        val kk = k++
        // a level change between half-symbols k-1 and k: a cell boundary when k has the cells' parity
        val change = h * h1 < 0
        if ((kk and 1L) == 0L) score += ((if (change) 1 else -1) - score) * 0.05
        else score -= ((if (change) 1 else -1) + score) * 0.05
        val par = if (score >= 0) 0 else 1
        // a cell ends at k when k + 1 has the cells' parity; while collecting, keep the parity we had
        if (collecting == 0) cellPar = par
        if (((kk + 1) and 1L).toInt() == cellPar) bit(if (h * h1 > 0) 1 else 0)
        h1 = h
    }

    private fun bit(b: Int) {
        if (collecting > 0) {
            bits[nb++] = b
            if (--collecting == 0) { val f = dec.parse(bits); if (f != null && f.serial.isNotEmpty()) sink(f) }
            return
        }
        sh = ((sh shl 1) or b) and 0xffffff
        if (Integer.bitCount(sh xor Meisei.HDR0) <= 2) {
            for (j in 0 until 24) bits[j] = (Meisei.HDR0 shr (23 - j)) and 1
            nb = 24; collecting = 576; sh = 0
        }
    }
}
