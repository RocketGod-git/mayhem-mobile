package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.floor
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

// SBR frequency band tables (ISO/IEC 14496-3 4.6.18.3) at the 44.1 kHz SBR rate used by HDC.

data class SbrHeader(
    var ampRes: Int = 1, var startFreq: Int = 5, var stopFreq: Int = 0, var xoverBand: Int = 0,
    var freqScale: Int = 2, var alterScale: Int = 1, var noiseBands: Int = 2,
    var limiterBands: Int = 2, var limiterGains: Int = 2, var interpolFreq: Int = 1, var smoothingMode: Int = 1,
)

class SbrTables(
    val k0: Int, val k2: Int, val kx: Int, val m: Int,
    val master: IntArray, val high: IntArray, val low: IntArray, val noise: IntArray,
    val nHigh: Int, val nLow: Int, val nQ: Int,
    var patchStart: IntArray = IntArray(0), var patchCount: IntArray = IntArray(0),
    var lim: IntArray = IntArray(0),
)

private const val FS = 44100
private val START_MIN = floor(4000.0 * 128 / FS + 0.5).toInt()
private val STOP_MIN = floor(8000.0 * 128 / FS + 0.5).toInt()
private val START_OFFSET = intArrayOf(-4, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 16, 20)
private fun round(x: Double): Int = floor(x + 0.5).toInt()

fun startChannel(startFreq: Int): Int = START_MIN + START_OFFSET[startFreq]

fun stopChannel(stopFreq: Int, k0: Int): Int {
    if (stopFreq == 15) return min(64, 3 * k0)
    if (stopFreq == 14) return min(64, 2 * k0)
    val t = IntArray(14) { round(STOP_MIN * (64.0 / STOP_MIN).pow(it / 13.0)) }
    val dk = IntArray(13) { t[it + 1] - t[it] }.sorted()
    var k2 = STOP_MIN
    for (i in 0 until stopFreq) k2 += dk[i]
    return min(64, k2)
}

private fun bandDeltas(a: Int, b: Int, n: Int): IntArray {
    val d = IntArray(n) { k -> round(a * (b.toDouble() / a).pow((k + 1).toDouble() / n)) - round(a * (b.toDouble() / a).pow(k.toDouble() / n)) }
    d.sort()
    return d
}

fun masterTable(k0: Int, k2: Int, freqScale: Int, alterScale: Int): IntArray? {
    if (k2 <= k0) return null
    if (freqScale == 0) {
        val dk = if (alterScale != 0) 2 else 1
        val n = if (alterScale != 0) 2 * round((k2 - k0) / 4.0) else 2 * floor((k2 - k0) / 2.0).toInt()
        if (n <= 0) return null
        val vDk = IntArray(n) { dk }
        var diff = k2 - (k0 + n * dk)
        if (diff != 0) {
            val incr = if (diff > 0) -1 else 1
            var k = if (diff > 0) n - 1 else 0
            while (diff != 0 && k >= 0 && k < n) { vDk[k] -= incr; k += incr; diff += incr }
        }
        val f = IntArray(n + 1); f[0] = k0
        for (k in 0 until n) { if (vDk[k] <= 0) return null; f[k + 1] = f[k] + vDk[k] }
        return f
    }
    val bands = intArrayOf(12, 10, 8)[freqScale - 1]
    val two = k2.toDouble() / k0 > 2.2449
    val k1 = if (two) 2 * k0 else k2
    val n0 = 2 * round(bands * log2(k1.toDouble() / k0) / 2)
    if (n0 <= 0) return null
    val d0 = bandDeltas(k0, k1, n0)
    if (d0[0] <= 0) return null
    val f = ArrayList<Int>(); f.add(k0)
    for (d in d0) f.add(f[f.size - 1] + d)
    if (!two) return f.toIntArray()
    val warp = if (alterScale != 0) 1.3 else 1.0
    val n1 = 2 * round(bands * log2(k2.toDouble() / k1) / (2 * warp))
    if (n1 <= 0) return null
    val d1 = bandDeltas(k1, k2, n1)
    if (d1[0] < d0[n0 - 1]) {
        val change = d0[n0 - 1] - d1[0]
        d1[0] = d0[n0 - 1]
        d1[n1 - 1] -= change
        d1.sort()
    }
    if (d1[0] <= 0) return null
    for (d in d1) f.add(f[f.size - 1] + d)
    return f.toIntArray()
}

fun buildTables(h: SbrHeader): SbrTables? {
    val k0 = startChannel(h.startFreq); val k2 = stopChannel(h.stopFreq, k0)
    if (k2 - k0 > 45) return null
    val master = masterTable(k0, k2, h.freqScale, h.alterScale)
    if (master == null || master.size - 1 > 64) return null
    val nMaster = master.size - 1
    if (h.xoverBand >= nMaster) return null
    val nHigh = nMaster - h.xoverBand; val nLow = (nHigh + 1) shr 1
    val high = master.copyOfRange(h.xoverBand, master.size)
    val kx = high[0]; val m = high[nHigh] - kx
    if (kx > 32 || kx + m > 64 || m <= 0) return null
    val odd = nHigh and 1; val low = IntArray(nLow + 1); low[0] = high[0]
    for (k in 1..nLow) low[k] = high[2 * k - odd]
    val nQ = max(1, round(h.noiseBands * log2(k2.toDouble() / kx)))
    if (nQ > 5) return null
    val noise = IntArray(nQ + 1); noise[0] = low[0]
    var i = 0
    for (k in 1..nQ) { i += floor((nLow - i).toDouble() / (nQ + 1 - k)).toInt(); noise[k] = low[i] }
    val t = SbrTables(k0, k2, kx, m, master, high, low, noise, nHigh, nLow, nQ)
    if (!patches(t)) return null
    t.lim = limiterTable(t, h.limiterBands)
    return t
}

private fun patches(t: SbrTables): Boolean {
    val k0 = t.k0; val kx = t.kx; val m = t.m; val master = t.master; val nMaster = master.size - 1
    val goal = round(2.048e6 / FS)
    var msb = k0; var usb = kx; var k = nMaster; var sb: Int; var guard = 0
    if (goal < kx + m) { k = 0; while (master[k] < goal) k++ }
    val start = ArrayList<Int>(); val count = ArrayList<Int>()
    do {
        if (++guard > 16) return false
        var j = k + 1; var odd: Int
        do { j--; sb = master[j]; odd = (sb - 2 + k0) and 1 } while (j > 0 && sb > k0 - 1 + msb - odd)
        val n = max(sb - usb, 0)
        if (n > 0) {
            if (count.size >= 6) return false
            count.add(n); start.add(k0 - odd - n)
            usb = sb; msb = sb
        } else msb = kx
        if (master[k] - sb < 3) k = nMaster
    } while (sb != kx + m)
    if (count.size > 1 && count[count.size - 1] < 3) { count.removeAt(count.size - 1); start.removeAt(start.size - 1) }
    t.patchStart = start.toIntArray(); t.patchCount = count.toIntArray()
    if (count.isEmpty()) return false
    for (s in start) if (s < 0) return false
    return true
}

/** Limiter band borders (absolute QMF bands) for bs_limiter_bands. */
fun limiterTable(t: SbrTables, limiterBands: Int): IntArray {
    if (limiterBands == 0) return intArrayOf(t.low[0], t.low[t.nLow])
    val per = doubleArrayOf(1.2, 2.0, 3.0)[limiterBands - 1]
    val borders = ArrayList<Int>(); borders.add(t.kx)
    for (n in t.patchCount) borders.add(borders[borders.size - 1] + n)
    val lim = (t.low.toList() + borders.subList(1, max(1, borders.size - 1))).sorted().toMutableList()
    fun isBorder(v: Int) = borders.contains(v)
    var k = 1
    while (k < lim.size) {
        val oct = if (lim[k - 1] != 0) log2(lim[k].toDouble() / lim[k - 1]) else 0.0
        if (oct * per < 0.49) {
            if (lim[k] == lim[k - 1]) { lim.removeAt(k); continue }
            if (isBorder(lim[k])) {
                if (isBorder(lim[k - 1])) { k++; continue }
                lim.removeAt(k - 1); continue
            }
            lim.removeAt(k); continue
        }
        k++
    }
    return lim.toIntArray()
}
