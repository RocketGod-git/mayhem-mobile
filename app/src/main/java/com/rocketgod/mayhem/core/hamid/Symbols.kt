package com.rocketgod.mayhem.core.hamid

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/** Root raised cosine, roll-off [a], [span] symbols each side, [sps] samples a symbol, unit gain at DC. */
fun rrcTaps(sps: Double, a: Double, span: Int): DoubleArray {
    val half = Math.round(span * sps).toInt(); val h = DoubleArray(2 * half + 1)
    var sum = 0.0
    for (k in -half..half) {
        val t = k / sps
        val v = if (abs(t) < 1e-9) 1 - a + 4 * a / PI
        else if (abs(abs(t) - 1 / (4 * a)) < 1e-9) a / sqrt(2.0) * ((1 + 2 / PI) * sin(PI / (4 * a)) + (1 - 2 / PI) * cos(PI / (4 * a)))
        else (sin(PI * t * (1 - a)) + 4 * a * t * cos(PI * t * (1 + a))) / (PI * t * (1 - (4 * a * t) * (4 * a * t)))
        h[k + half] = v; sum += v
    }
    for (i in h.indices) h[i] /= sum
    return h
}

/**
 * Symbols from an FM discriminator (radians per sample): the root raised cosine receive filter (roll-off 0.2), or the
 * discriminator summed over one symbol; symbol timing picked again every 240 symbols, the eye's outer quarters giving
 * its center and level, symbols out scaled so the outer levels sit near ±3. The same as the web's dsp/hamid/symbols.ts.
 */
class DiscSymbols(val fs: Double, val baud: Double, rrc: Boolean = true) {
    var onSymbol: (Double) -> Unit = {}
    val sps = fs / baud
    private val taps: DoubleArray? = if (rrc) rrcTaps(sps, 0.2, 4) else null
    private val D = taps?.size ?: max(1, Math.round(sps).toInt())
    private val ring = DoubleArray(D); private var rp = 0; private var acc = 0.0
    private var buf = DoubleArray(ceil(sps * BLOCK * 2).toInt() + 64); private var n = 0; private var base = 0.0; private var tNext = 0.0
    var center = 0.0; var level = 0.0; var eye = 1.0; var symbols = 0L

    fun reset() { ring.fill(0.0); rp = 0; acc = 0.0; n = 0; base = 0.0; tNext = 0.0; center = 0.0; level = 0.0; eye = 1.0; symbols = 0 }

    fun push(disc: FloatArray, count: Int) { for (k in 0 until count) add(disc[k].toDouble()); drain() }
    fun push(disc: DoubleArray, count: Int) { for (k in 0 until count) add(disc[k]); drain() }
    private fun add(x: Double) {
        val y: Double
        val h = taps
        if (h != null) {
            ring[rp] = x; if (++rp >= D) rp = 0
            var s = 0.0; var j = rp
            for (i in 0 until D) { s += h[i] * ring[j]; if (++j >= D) j = 0 }
            y = s
        } else {
            acc += x - ring[rp]; ring[rp] = x; if (++rp >= D) rp = 0
            y = acc
        }
        if (n >= buf.size) buf = buf.copyOf(buf.size * 2)
        buf[n++] = y
    }
    private fun drain() { val need = ceil(sps * (BLOCK + 2)).toInt() + 2; while (n >= need) block(BLOCK) }
    fun flush() { val k = floor(n / sps).toInt() - 2; if (k > 20) block(k) }

    private fun at(t: Double): Double {
        val i = floor(t).toInt(); val f = t - i
        val a = buf[i]; val b = buf[if (i + 1 < n) i + 1 else n - 1]
        return a * (1 - f) + b * f
    }
    private fun block(nsym: Int) {
        val T = sps; val len = nsym * T
        var best = 0.0; var bestE = -1.0; var sumE = 0.0
        for (p in 0 until 8) {
            val off = p * T / 8
            var e = 0.0
            for (k in 0 until nsym) { val x = at(off + k * T) - center; e += x * x }
            sumE += e
            if (e > bestE) { bestE = e; best = off }
        }
        eye = if (sumE > 0) bestE / (sumE / 8) else 1.0
        val t0 = tNext - base
        var k0 = ceil((t0 - T / 2 - best) / T).toInt(); if (k0 < 0) k0 = 0
        val vals = ArrayList<Double>()
        var t = best + k0 * T
        while (t < len) { vals.add(at(t)); t += T }
        tNext = base + t
        if (vals.isNotEmpty()) {
            val sorted = vals.sorted(); val q = max(1, sorted.size / 4)
            var lo = 0.0; var hi = 0.0; for (i in 0 until q) { lo += sorted[i]; hi += sorted[sorted.size - 1 - i] }; lo /= q; hi /= q
            val c = (hi + lo) / 2; val l = (hi - lo) / 2
            if (l > 1e-6) {
                center = if (level > 0) center + 0.5 * (c - center) else c
                level = if (level > 0) level + 0.5 * (l - level) else l
            }
        }
        val sc = if (level > 0) 3 / level else 1.0
        for (v in vals) { symbols++; onSymbol((v - center) * sc) }
        val used = floor(len).toInt()
        System.arraycopy(buf, used, buf, 0, n - used); n -= used; base += used
    }
    private companion object { const val BLOCK = 240 }
}
