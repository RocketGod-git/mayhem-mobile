package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.sonde.SondeSynth.FlightPoint
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Test signals for the DFM, M10/M20 and MTS01 decoders: frames built the way each sonde builds them (Hamming and
 * column interleave, Meteomodem checksum, CRC), as channel symbols for the modulators. The Kotlin twin of
 * web/src/dsp/sonde/synth-a.ts.
 */
object SondeSynthA {
    /** The x (between lo and hi, on a log scale) where f(x) = want, for a monotonic f. */
    private fun solveLog(f: (Double) -> Double, want: Double, lo0: Double, hi0: Double): Double {
        var lo = lo0; var hi = hi0
        val up = f(hi) > f(lo)
        for (i in 0 until 100) { val mid = sqrt(lo * hi); if ((f(mid) < want) == up) lo = mid else hi = mid }
        return sqrt(lo * hi)
    }

    private fun utc(ms: Long) = Instant.ofEpochMilli(ms).atOffset(ZoneOffset.UTC)

    // ---------------------------------------------------------------- DFM

    enum class DfmKind { DFM06, DFM09, DFM09P, DFM17, PS15 }

    class DfmOptions(
        val kind: DfmKind,
        /** Decimal serial (DFM-09/17, PS-15) or the six BCD digits as a number like 0x123456 (DFM-06). */
        val serial: Long,
        val tempC: Double, val battV: Double = 3.1,
        /** UTC start, ms since 1970. */
        val startMs: Long,
        /** Position at second k of the flight. */
        val flight: (Int) -> FlightPoint,
        val sats: Int = 10, val frnr0: Int = 1,
        /** The config channel to start the cycle at (the serial channel is the last one). */
        val chStart: Int = 0,
    )

    /** A DFM transmitter: one 280-bit frame per call, data packets 0..8 two per frame, config channels in turn. */
    class DfmTx(private val o: DfmOptions) {
        private var pk = 0
        private var ch = o.chStart
        private val chans = channels()
        /** Config channels in one cycle. */
        val cycleLen: Int get() = chans.size

        /** The config channel values (index = channel number), the serial channel last, two halves alternating. */
        private fun channels(): IntArray {
            val k = o.kind
            fun fl(v: Double, p: Int): Int = (p shl 20) or Math.round(v * (1 shl p)).toInt()
            val r = solveLog(Dfm::tempFromR, o.tempC, 100.0, 1e7)
            val mv = Math.round(o.battV * 1000).toInt()
            if (k == DfmKind.DFM06) {
                val rs = 10e3; val rf = 220e3; val g = 1.0
                // 0..4 measurements, 5 = the null channel 0x5A, 6 = the serial
                return intArrayOf(fl(g * (r + rs), 2), fl(12345.0, 2), fl(23456.0, 2), fl(g * rs, 2), fl(g * rf, 2), 0xa00000, (o.serial and 0xffffff).toInt())
            }
            if (k == DfmKind.PS15) {
                // no PTU channels the decoder uses; 6 = null, 7 = the serial halves with a 0 second nibble
                return intArrayOf(fl(1000.0, 0), fl(2000.0, 0), fl(3000.0, 0), fl(4000.0, 0), fl(5000.0, 0), mv shl 4, 0, -1)
            }
            val pP = k == DfmKind.DFM09P
            val rf = if (k == DfmKind.DFM17) 332e3 else 220e3; val rs = 20e3; val g = if (pP) 0.5 else 1.0
            val p = if (pP) 3 else if (rf > 300e3) 1 else 2
            val v = ArrayList<Int>()
            for (c in 0..8) v.add(fl(10000.0 + 1000 * c, 2))
            val tf = if (pP) intArrayOf(1, 5, 6) else intArrayOf(0, 3, 4)
            v[tf[0]] = fl(g * (r + rs), p); v[tf[1]] = fl(g * rs, p); v[tf[2]] = fl(g * rf, p)
            val ofs = if (pP) 2 else 0
            v[5 + ofs] = mv shl 4
            v[6 + ofs] = Math.round((25 + 273.15) * 100).toInt() shl 4    // MCU temperature, 25 °C
            if (k == DfmKind.DFM17) v[7] = 4321 shl 4                     // the sonde's seconds counter
            val sub = when (k) { DfmKind.DFM09 -> 0xa; DfmKind.DFM17 -> 0xb; else -> 0xc }
            while (v.size < sub - 1) v.add(fl(5000.0, 0))
            v.add(0)    // the null channel, just below the serial channel
            v.add(-1)   // the serial channel, filled per cycle
            return v.toIntArray()
        }

        private fun serialValue(cycle: Int): Int {
            val hl = cycle and 1
            val half = (if (hl == 1) o.serial and 0xffff else (o.serial ushr 16) and 0xffff).toInt()
            val top = if (o.kind == DfmKind.PS15) 0x0 else 0xc
            return (top shl 20) or (half shl 4) or hl
        }

        /** Data packet [id] for flight second [sec]: 6 payload bytes. */
        private fun packet(id: Int, sec: Int): IntArray {
            val p = o.flight(sec)
            val ms = o.startMs + sec * 1000L; val d = utc(ms)
            val frnr = (o.frnr0 + sec) and 0xff
            val b = IntArray(6)
            fun s32(v: Int) { b[0] = (v ushr 24) and 255; b[1] = (v ushr 16) and 255; b[2] = (v ushr 8) and 255; b[3] = v and 255 }
            fun s16(v: Int) { b[4] = (v shr 8) and 255; b[5] = v and 255 }
            val vH = hypot(p.vN, p.vE)
            var hd = atan2(p.vE, p.vN) * 180 / PI; if (hd < 0) hd += 360
            when (id) {
                0 -> { b[2] = 2; b[3] = frnr }
                1 -> { s32(0x0f0f0f0f); s16(d.second * 1000 + (ms % 1000).toInt()) }
                2 -> { s32(Math.round(p.lat * 1e7).toInt()); s16(Math.round(vH * 100).toInt()) }
                3 -> { s32(Math.round(p.lon * 1e7).toInt()); s16(Math.round(hd * 100).toInt()) }
                4 -> { s32(Math.round(p.alt * 100).toInt()); s16(Math.round(p.vU * 100).toInt()) }
                5 -> { b[0] = (-3350 shr 8) and 255; b[1] = -3350 and 255 }   // MSL - ellipsoid = -33.5 m
                8 -> {
                    val y = d.year; val mo = d.monthValue; val dd = d.dayOfMonth; val h = d.hour; val mi = d.minute
                    b[0] = (y shr 4) and 255; b[1] = ((y and 15) shl 4) or mo; b[2] = (dd shl 3) or (h shr 2); b[3] = ((h and 3) shl 6) or mi; b[4] = o.sats
                }
            }
            return b
        }

        /** Nibbles of a block -> codewords -> column-wise bits. */
        private fun block(nibs: IntArray, out: ArrayList<Int>) {
            val cw = nibs.map { Dfm.hamming(it) }
            for (j in 0 until 8) for (i in nibs.indices) out.add((cw[i] shr (7 - j)) and 1)
        }

        /** The next 280-bit frame. */
        fun next(): IntArray {
            val bits = ArrayList<Int>()
            for (k in 0 until 16) bits.add((0x45cf shr (15 - k)) and 1)
            val nCh = chans.size; val cycle = ch / nCh; val c = ch % nCh
            var v = chans[c]
            if (v < 0) v = serialValue(cycle)
            ch++
            val conf = IntArray(7); conf[0] = c; for (k in 5 downTo 0) conf[6 - k] = (v shr (4 * k)) and 15
            block(conf, bits)
            for (d in 0 until 2) {
                val id = pk % 9; val sec = pk / 9
                pk++
                val by = packet(id, sec); val nib = IntArray(13)
                for (i in 0 until 6) { nib[2 * i] = by[i] shr 4; nib[2 * i + 1] = by[i] and 15 }
                nib[12] = id
                block(nib, bits)
            }
            return bits.toIntArray()
        }
    }

    /** DFM channel symbols: Manchester "01" = 1, "10" = 0; [invert] flips the FM polarity (DFM-06, DFM-17). */
    fun dfmSymbols(frames: List<IntArray>, invert: Boolean = false): IntArray {
        val out = ArrayList<Int>()
        for (f in frames) for (b in f) { val x = if (invert) 1 - b else b; out.add(1 - x); out.add(x) }
        return out.toIntArray()
    }

    // ---------------------------------------------------------------- M10 / M20

    class M10Options(
        /** "YMM-T-Nnnnn" (no M10- prefix). */
        val serial: String,
        val counter: Int, val p: FlightPoint,
        val week: Int, val towMs: Long, val leap: Int = 18, val sats: Int = 9,
        val tempC: Double, val rh: Double, val tHumC: Double, val battV: Double,
        /** 0x9F (M10), 0x8F (M2K2), 0xAF (M10+ with the Gtop GPS). */
        val type: Int = 0x9f,
        /** Extra aux bytes (frame length 0x64 + aux). */
        val aux: Int = 0,
    ) {
        fun copy(type: Int = this.type, aux: Int = this.aux) = M10Options(serial, counter, p, week, towMs, leap, sats, tempC, rh, tHumC, battV, type, aux)
    }

    private fun be(b: IntArray, p: Int, v: Long, n: Int) { for (k in 0 until n) b[p + k] = ((v shr (8 * (n - 1 - k))) and 255).toInt() }
    private fun le(b: IntArray, p: Int, v: Long, n: Int) { for (k in 0 until n) b[p + k] = ((v shr (8 * k)) and 255).toInt() }

    /** The ADC count (and M10 range) that reads closest to a temperature. */
    private fun m10TempAdc(tempC: Double): Pair<Int, Int> {
        val r = solveLog(M10::tempFromR, tempC, 100.0, 1e8)
        var best = 2048 to 0; var err = Double.POSITIVE_INFINITY
        for (s in 0 until 3) {
            val x = M10.RS[s] / r + M10.RS[s] / M10.RP[s]; val adc = Math.round(4095 / (x + 1)).toInt()
            if (adc < 1 || adc > 4094) continue
            val e = abs(M10.tempFromAdc(adc, s) - tempC)
            if (e < err) { err = e; best = adc to s }
        }
        return best
    }

    private fun nearestAdc(f: (Int) -> Double, want: Double, lo: Int, hi: Int): Int {
        var best = lo; var err = Double.POSITIVE_INFINITY
        for (a in lo..hi) { val e = abs(f(a) - want); if (e < err) { err = e; best = a } }
        return best
    }

    private class SerialParts(val y: Int, val mm: Int, val t: Int, val d: Int, val n: Int)
    /** Parse "YMM-T-Nnnnn". */
    private fun serialParts(s: String): SerialParts {
        val (a, t, n) = s.split("-")
        return SerialParts(a.substring(0, 1).toInt(16), a.substring(1).toInt(), t.toInt(16), n.substring(0, 1).toInt(), n.substring(1).toInt())
    }

    fun m10Frame(o: M10Options): IntArray {
        val type = o.type; val flen = 0x64 + o.aux
        val f = IntArray(flen + 1)
        f[0] = flen; f[1] = type; f[2] = 0x20
        val p = o.p
        if (type == 0xaf) {
            be(f, 0x04, Math.round(p.lat * 1e6), 4); be(f, 0x08, Math.round(p.lon * 1e6), 4)
            be(f, 0x0c, Math.round(p.alt * 100) and 0xffffff, 3)
            be(f, 0x0f, Math.round(p.vE * 100), 2); be(f, 0x11, Math.round(p.vN * 100), 2); be(f, 0x13, Math.round(p.vU * 100), 2)
            val d = utc(315_964_800_000L + (o.week * 604800L + o.towMs / 1000 - o.leap) * 1000)
            be(f, 0x15, (d.hour * 10000 + d.minute * 100 + d.second).toLong(), 3)
            be(f, 0x18, (d.dayOfMonth * 10000 + d.monthValue * 100 + d.year % 100).toLong(), 3)
        } else {
            be(f, 0x04, Math.round(p.vE * 200), 2); be(f, 0x06, Math.round(p.vN * 200), 2); be(f, 0x08, Math.round(p.vU * 200), 2)
            be(f, 0x0a, o.towMs, 4)
            val b60b60 = (1 shl 30) / 90.0
            be(f, 0x0e, Math.round(p.lat * b60b60), 4); be(f, 0x12, Math.round(p.lon * b60b60), 4)
            be(f, 0x16, Math.round(p.alt * 1000), 4)
            f[0x1c] = 1; f[0x1d] = 0; f[0x1e] = o.sats; f[0x1f] = o.leap
            be(f, 0x20, o.week.toLong(), 2)
        }
        // humidity: count ratio 0.8955 + 0.002 RH (at or above 0 °C)
        val c55 = 8_000_000L
        le(f, 0x32, c55, 3); le(f, 0x35, Math.round(c55 * (0.8955 + 0.002 * o.rh)), 3)
        val (adc, scT) = m10TempAdc(o.tempC)
        f[0x3e] = scT; le(f, 0x3f, (adc + 0xa000).toLong(), 2)
        le(f, 0x45, Math.round(o.battV * 1023 / (2.709 * 2.5)), 2)
        le(f, 0x59, nearestAdc(M10::tntcFromAdc, o.tHumC, 1, 4094).toLong(), 2)
        val s = serialParts(o.serial)
        f[0x5d] = 0x40 or s.t; f[0x5e] = 0; f[0x5f] = (s.y shl 4) or s.mm; le(f, 0x60, ((s.d shl 13) or s.n).toLong(), 2)
        f[0x62] = o.counter and 255
        be(f, flen - 1, M10.check(f, flen - 1).toLong(), 2)
        return f
    }

    class M20Options(
        /** "YMM-T-Nnnnn" (no M20- prefix). */
        val serial: String,
        val counter: Int, val p: FlightPoint, val week: Int, val towS: Int,
        val tempC: Double, val rh: Double, val tHumC: Double, val battV: Double, val hPa: Double = 0.0, val fw: Int = 0x07,
    )

    fun m20Frame(o: M20Options): IntArray {
        val f = IntArray(0x46)
        f[0] = 0x45; f[1] = 0x20
        val p = o.p
        val tu = M10.m20TntcFromAdc(nearestAdc(M10::m20TntcFromAdc, o.tHumC, 1, 4094))
        val rhCal = 20000
        le(f, 0x02, nearestAdc({ h -> M10.m20Humidity(h, rhCal, tu) }, o.rh, 0, 47999).toLong(), 2)
        val (adc, scT) = m10TempAdc(o.tempC)
        le(f, 0x04, (adc + 4096 * scT).toLong(), 2)
        le(f, 0x06, nearestAdc(M10::m20TntcFromAdc, o.tHumC, 1, 4094).toLong(), 2)
        be(f, 0x08, Math.round(p.alt * 100), 3)
        be(f, 0x0b, Math.round(p.vE * 100), 2); be(f, 0x0d, Math.round(p.vN * 100), 2)
        be(f, 0x0f, o.towS.toLong(), 3)
        val s = serialParts(o.serial)
        // ym = years*12 + month-1; the type digit is stored minus one; the 5-digit number's first digit is the top bit
        val sn24 = (s.y * 12 + s.mm - 1) or ((s.t - 1) shl 7) or (s.n shl 10) or (s.d shl 23)
        le(f, 0x12, sn24.toLong(), 3)
        f[0x15] = o.counter and 255
        be(f, 0x18, Math.round(p.vU * 100), 2)
        be(f, 0x1a, o.week.toLong(), 2)
        be(f, 0x1c, Math.round(p.lat * 1e6), 4); be(f, 0x20, Math.round(p.lon * 1e6), 4)
        if (o.hPa != 0.0) { val v = Math.round(o.hPa * 4096); f[0x16] = (v and 255).toInt(); le(f, 0x24, v ushr 8, 2) }
        f[0x26] = Math.round(o.battV * 255 / 3.3).toInt()
        le(f, 0x2f, rhCal.toLong(), 2)
        f[0x43] = o.fw
        be(f, 0x44, M10.check(f, 0x44).toLong(), 2)
        return f
    }

    /** M10/M20 channel symbols: a preamble of biphase-mark zeros, the sync, then the frame biphase-mark coded. */
    fun m10Symbols(frame: IntArray, invert: Boolean = false, preamble: Int = 24): IntArray {
        val out = ArrayList<Int>()
        for (i in 0 until preamble) { out.add(1); out.add(1); out.add(0); out.add(0) }
        for (c in M10.HEADER) out.add(if (c == '1') 1 else 0)
        var prev = 0
        for (i in frame.indices) for (k in 7 downTo 0) {
            val bit = (frame[i] shr k) and 1; val level = 1 - prev
            out.add(level); out.add(if (bit != 0) 1 - level else level)
            prev = out[out.size - 1]
        }
        return IntArray(out.size) { if (invert) 1 - out[it] else out[it] }
    }

    // ---------------------------------------------------------------- MTS01

    class Mts01Options(
        val id: String, val counter: Int, val startMs: Long, val battMv: Int,
        val lat: Double, val lon: Double, val alt: Double, val heading: Double, val speed: Double,
        /** Thermistor reading, kilohms. */
        val rawT: Double, val rawRh: Int = 512,
    )

    fun mts01Frame(o: Mts01Options): IntArray {
        val d = utc(o.startMs)
        val dt = "%02d%02d%02d%02d%02d%02d".format(java.util.Locale.US, d.year % 100, d.monthValue, d.dayOfMonth, d.hour, d.minute, d.second)
        fun fx(v: Double, n: Int) = "%.${n}f".format(java.util.Locale.US, v)
        val text = listOf(o.id, "1", "${o.counter}", dt, "${o.battMv}", fx(o.lat, 6), fx(o.lon, 6), fx(o.alt, 1),
            fx(o.heading, 1), fx(o.speed, 2), "0", fx(o.rawT, 4), fx(o.rawT, 4), "${o.rawRh}", "0", "0").joinToString(",")
        val fb = IntArray(131)
        fb[0] = 0x80
        for (i in 0 until min(text.length, 128)) fb[1 + i] = text[i].code
        val crc = Mts01.crc(fb, 1, 128)
        fb[129] = crc and 255; fb[130] = crc shr 8
        return fb
    }

    /** MTS01 channel symbols: AA preamble, the header, the frame; NRZ, most significant bit first, '1' = upper tone. */
    fun mts01Symbols(frame: IntArray, invert: Boolean = false, preamble: Int = 6): IntArray {
        val bytes = IntArray(preamble) { 0xaa } + intArrayOf(0xaa, 0xaa, 0xb4, 0x2b) + frame
        val out = IntArray(bytes.size * 8)
        for (i in bytes.indices) for (k in 7 downTo 0) out[8 * i + 7 - k] = (bytes[i] shr k) and 1
        return if (invert) IntArray(out.size) { 1 - out[it] } else out
    }

    // ---------------------------------------------------------------- IQ

    class FskSignal(val syms: IntArray, val baud: Double, val offsetHz: Double, val dev: Double, val amp: Double)

    /**
     * Several 2-FSK signals on one offset-128 IQ stream, with Gaussian noise of [sigma] per component, made a chunk at a
     * time (a whole recording would not fit the test heap). Each signal's frequency is smoothed by a running mean over
     * half a symbol (about GFSK BT 0.5); a signal is plain carrier (symbol 0's tone) once its symbols run out. The
     * streaming twin of synth-a.ts fskMix().
     */
    class FskMix(private val rate: Double, private val sigs: List<FskSignal>, private val sigma: Double, seed: Long = 11) {
        private class St(val sps: Double, val half: Int) { val ring = FloatArray(half); var sum = 0.0; var cnt = 0; var ph = 0.0 }
        private val st = sigs.map { val sps = rate / it.baud; St(sps, max(1, Math.round(sps / 2).toInt())) }
        private var i = 0L
        private var seed = seed and 0xffffffffL
        private fun uni(): Double { seed = (seed * 1103515245L + 12345L) and 0xffffffffL; return seed / 4294967296.0 }

        /** The next [n] samples. */
        fun next(n: Int): ByteArray {
            val acc = DoubleArray(2 * n)
            for ((si, s) in sigs.withIndex()) {
                val t = st[si]
                for (j in 0 until n) {
                    val ii = i + j
                    val k = (ii / t.sps).toLong()
                    val v = if (k < s.syms.size && s.syms[k.toInt()] != 0) 1f else -1f
                    val slot = (ii % t.half).toInt()
                    if (t.cnt == t.half) t.sum -= t.ring[slot] else t.cnt++
                    t.ring[slot] = v; t.sum += v
                    t.ph += 2 * PI * (s.offsetHz + s.dev * t.sum / t.cnt) / rate
                    if (t.ph > PI) t.ph -= 2 * PI else if (t.ph < -PI) t.ph += 2 * PI
                    acc[2 * j] += s.amp * cos(t.ph); acc[2 * j + 1] += s.amp * sin(t.ph)
                }
            }
            i += n
            val out = ByteArray(2 * n)
            var j = 0
            while (j < 2 * n) {
                val u = max(1e-12, uni()); val w = uni(); val r = sqrt(-2 * ln(u)) * sigma
                val a = acc[j] + r * cos(2 * PI * w); val b = acc[j + 1] + r * sin(2 * PI * w)
                out[j] = (max(-127, min(127, Math.round(a).toInt())) + 128).toByte()
                out[j + 1] = (max(-127, min(127, Math.round(b).toInt())) + 128).toByte()
                j += 2
            }
            return out
        }
    }
}
