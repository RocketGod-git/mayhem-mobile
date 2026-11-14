package com.rocketgod.mayhem.core.sonde

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Test signals for the sonde decoders: frames built the way each sonde builds them, and an FSK modulator that puts
 * channel symbols on raw IQ. The Kotlin twin of web/src/dsp/sonde/synth.ts. IQ comes out offset-128 (the engine's format).
 */
object SondeSynth {
    /** A small deterministic generator (tests must repeat). */
    class Prng(seed: Long = 12345) {
        private var s = seed.toInt()
        /** mulberry32: an LCG's low bits repeat and put false carriers in the test noise. */
        fun next(): Double {
            s += 0x6d2b79f5
            var t = s
            t = (t xor (t ushr 15)) * (t or 1)
            t = t xor (t + (t xor (t ushr 7)) * (t or 61))
            return ((t xor (t ushr 14)).toLong() and 0xffffffffL) / 4294967296.0
        }
        fun gauss(): Double { val u = max(1e-12, next()); val v = next(); return sqrt(-2 * ln(u)) * cos(2 * PI * v) }
    }

    private fun clip(v: Double): Int = max(-127, min(127, Math.round(v).toInt()))

    /**
     * Channel symbols (0/1) as 2-FSK on offset-128 IQ: [dev] Hz either side of [offsetHz], a raised-cosine-smoothed
     * frequency (about GFSK BT 0.5), [snrDb] in the symbol bandwidth. [lead] seconds of carrier before and after.
     */
    fun fskIq(syms: IntArray, baud: Double, rate: Double, offsetHz: Double, dev: Double, snrDb: Double = 30.0, lead: Double = 0.05,
              rng: Prng = Prng(7), amp: Double = 60.0): ByteArray {
        val sps = rate / baud; val leadN = (lead * rate).roundToInt()
        val n = kotlin.math.ceil(syms.size * sps).toInt() + 2 * leadN
        val out = ByteArray(2 * n)
        val noise = amp * Math.pow(10.0, -snrDb / 20) * sqrt(rate / baud) / sqrt(2.0)
        var ph = 0.0
        val half = max(1, (sps / 2).roundToInt())
        // a running mean over half a symbol smooths the frequency steps
        val f = DoubleArray(n)
        for (i in 0 until n) {
            val k = kotlin.math.floor((i - leadN) / sps).toInt()
            f[i] = if (k < 0 || k >= syms.size) -1.0 else if (syms[k] != 0) 1.0 else -1.0
        }
        var acc = 0.0; val q = ArrayDeque<Double>()
        for (i in 0 until n) {
            q.addLast(f[i]); acc += f[i]; if (q.size > half) acc -= q.removeFirst()
            val fr = offsetHz + dev * acc / q.size
            ph += 2 * PI * fr / rate
            if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
            val i0 = amp * cos(ph) + noise * rng.gauss(); val q0 = amp * sin(ph) + noise * rng.gauss()
            out[2 * i] = (clip(i0) + 128).toByte()
            out[2 * i + 1] = (clip(q0) + 128).toByte()
        }
        return out
    }

    /** Plain noise IQ (a gap between transmissions). */
    fun noiseIq(n: Int, sigma: Double = 2.0, rng: Prng = Prng(9)): ByteArray = ByteArray(2 * n) { (clip(sigma * rng.gauss()) + 128).toByte() }

    /** Bits of bytes, least or most significant first. */
    fun bitsOf(bytes: IntArray, lsbFirst: Boolean): IntArray {
        val out = IntArray(bytes.size * 8)
        for (i in bytes.indices) for (k in 0 until 8) out[8 * i + k] = if (lsbFirst) (bytes[i] shr k) and 1 else (bytes[i] shr (7 - k)) and 1
        return out
    }

    fun manchesterOf(bits: IntArray, oneIsHighLow: Boolean = true): IntArray {
        val o = IntArray(bits.size * 2)
        for (i in bits.indices) { val b = if (bits[i] != 0) 1 else 0; o[2 * i] = if (oneIsHighLow) b else 1 - b; o[2 * i + 1] = if (oneIsHighLow) 1 - b else b }
        return o
    }

    data class FlightPoint(val lat: Double, val lon: Double, val alt: Double, val vN: Double, val vE: Double, val vU: Double)

    private fun put16(b: IntArray, p: Int, v: Int) { b[p] = v and 255; b[p + 1] = (v shr 8) and 255 }
    private fun put24(b: IntArray, p: Int, v: Int) { b[p] = v and 255; b[p + 1] = (v shr 8) and 255; b[p + 2] = (v shr 16) and 255 }
    private fun put32(b: IntArray, p: Int, v: Long) { b[p] = (v and 255).toInt(); b[p + 1] = ((v shr 8) and 255).toInt(); b[p + 2] = ((v shr 16) and 255).toInt(); b[p + 3] = ((v ushr 24) and 255).toInt() }
    private fun putF(b: IntArray, p: Int, v: Double) { val x = v.toFloat().toRawBits(); for (k in 0 until 4) b[p + k] = (x shr (8 * k)) and 255 }

    /** An RS41 calibration table whose sensors read the frame's temperature (and a fixed humidity reading), with a burst timer. */
    fun rs41CalTable(model: String = "RS41-SG", txKHz: Int = 403_000, killS: Int = 0x7788): IntArray {
        val c = IntArray(51 * 16)
        // subframe 0: frequency (40 kHz steps + quarter steps)
        val k = txKHz - 400_000; c[3] = k / 40; c[2] = (Math.round((k % 40) / 10.0).toInt() * 64) and 0xc0
        put16(c, 16 + 5, 0x5139)                 // subframe 1: firmware
        c[2 * 16 + 11] = 1                       // subframe 2: burst kill on
        putF(c, 61, 750.0); putF(c, 65, 1100.0)  // reference resistors
        putF(c, 77, -243.9108); putF(c, 81, 0.187654); putF(c, 85, 8.2e-6)   // PT1000 polynomial
        putF(c, 89, 1.0); putF(c, 93, 0.0); putF(c, 97, 0.0)
        putF(c, 117, 46.5); putF(c, 121, 0.0)
        putF(c, 293, -243.9108); putF(c, 297, 0.187654); putF(c, 301, 8.2e-6)
        putF(c, 305, 1.0); putF(c, 309, 0.0); putF(c, 313, 0.0)
        for (i in 0 until min(8, model.length)) c[0x21 * 16 + 8 + i] = model[i].code
        put16(c, 0x32 * 16, killS)
        return c
    }

    /** The measurement count a PT1000 at tempC gives with this table (gain 100 counts per ohm). */
    fun rs41TempCounts(tempC: Double): IntArray {
        // solve -243.9108 + 0.187654 R + 8.2e-6 R^2 = T
        val a = 8.2e-6; val b = 0.187654; val cc = -243.9108 - tempC; val r = (-b + sqrt(b * b - 4 * a * cc)) / (2 * a)
        return intArrayOf(Math.round(r * 100).toInt(), 75_000, 110_000)
    }

    /** One RS41 frame (320 bytes, de-whitened, parity filled). */
    fun rs41Frame(serial: String, frame: Int, p: FlightPoint, cal: IntArray, tempC: Double, week: Int, towMs: Long, battV: Double = 2.9): IntArray {
        val fr = IntArray(518)
        Rs41.HEADER_BYTES.copyInto(fr, 0)
        fr[0x38] = 0x0f
        fun block(pos: Int, id: Int, len: Int, fill: (Int) -> Unit) {
            fr[pos] = id; fr[pos + 1] = len; fill(pos + 2)
            put16(fr, pos + 2 + len, ReedSolomon.crc16ccitt(fr, pos + 2, len))
        }
        block(0x39, 0x79, 0x28) { d ->
            put16(fr, d, frame)
            for (i in 0 until 8) fr[d + 2 + i] = serial[i].code
            fr[d + 10] = Math.round(battV * 10).toInt()
            val sub = frame % 51; fr[d + 23] = sub
            for (i in 0 until 16) fr[d + 24 + i] = cal[sub * 16 + i]
        }
        block(0x65, 0x7a, 0x2a) { d ->
            val t = rs41TempCounts(tempC)
            put24(fr, d, t[0]); put24(fr, d + 3, t[1]); put24(fr, d + 6, t[2])
            put24(fr, d + 9, 520_000); put24(fr, d + 12, 500_000); put24(fr, d + 15, 600_000)
            val g = rs41TempCounts(tempC + 3)
            put24(fr, d + 18, g[0]); put24(fr, d + 21, g[1]); put24(fr, d + 24, g[2])
        }
        block(0x93, 0x7c, 0x1e) { d -> put16(fr, d, week); put32(fr, d + 2, towMs) }
        block(0xb5, 0x7d, 0x59) { }
        block(0x112, 0x7b, 0x15) { d ->
            val x = geoToEcef(p.lat, p.lon, p.alt); val v = neuToEcefVel(p.vN, p.vE, p.vU, p.lat, p.lon)
            put32(fr, d, Math.round(x[0] * 100)); put32(fr, d + 4, Math.round(x[1] * 100)); put32(fr, d + 8, Math.round(x[2] * 100))
            put16(fr, d + 12, Math.round(v[0] * 100).toInt()); put16(fr, d + 14, Math.round(v[1] * 100).toInt()); put16(fr, d + 16, Math.round(v[2] * 100).toInt())
            fr[d + 18] = 9; fr[d + 19] = 25; fr[d + 20] = 14
        }
        block(0x12b, 0x76, 0x11) { }
        Rs41.parity(fr)
        return fr.copyOf(320)
    }

    /** The channel symbols an RS41 sends for a frame: the header, then the whitened bytes, LSB first. */
    fun rs41Symbols(fr: IntArray): IntArray = bitsOf(IntArray(fr.size) { fr[it] xor Rs41.MASK[it % 64] }, true)
}
