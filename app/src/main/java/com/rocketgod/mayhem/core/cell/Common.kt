package com.rocketgod.mayhem.core.cell

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * LTE downlink basics (FDD, normal cyclic prefix, 15 kHz subcarriers).
 * 36.211: 6.2 resource grid and REGs, 6.10.1 CRS, 6.12 OFDM baseband, 6.3.4.3 transmit diversity, 7.1 modulation,
 * 7.2 pseudo-random sequence. 36.212 5.1.1 CRCs.
 * Complex vectors are split re/im arrays. A grid is [14 symbols][12 N_RB subcarriers], index l * K + k.
 */

const val NRB_MAX = 110
internal const val SQRT1_2 = 0.70710678118654752f

/** Sample-rate dependent timing: N_FFT = fs / 15 kHz, CP 160/144 Ts scaled. */
class Numerology(val fs: Int) {
    val nfft: Int = (fs / 15_000.0).roundToInt()
    private val s = nfft / 2048.0
    val cp0: Int = (160 * s).roundToInt()
    val cpn: Int = (144 * s).roundToInt()
    val slot: Int = (15_360 * s).roundToInt()
    val subframe: Int = 2 * slot
    val frame: Int = 10 * subframe
    val halfFrame: Int = 5 * subframe
    /** Start of OFDM symbol l (0..13, CP included) relative to the subframe start, and its CP length. */
    fun symbol(l: Int): Pair<Int, Int> {
        val sl = l / 7; val li = l % 7
        return (sl * slot + (if (li == 0) 0 else cp0 + nfft + (li - 1) * (cpn + nfft))) to (if (li == 0) cp0 else cpn)
    }
    /** Offset of the PSS useful part (symbol 6 of slot 0/10, after its CP) from the start of its subframe. */
    val pssOffset: Int get() { val (o, cp) = symbol(6); return o + cp }
}

/** FFT bin of each subcarrier k of an N_RB grid; DC is not part of the grid (36.211 6.12). */
fun scToBin(nrb: Int, nfft: Int): IntArray {
    val half = nrb * 6
    return IntArray(12 * nrb) { k -> (((if (k < half) k - half else k - half + 1) % nfft) + nfft) % nfft }
}

class Grid(val re: FloatArray, val im: FloatArray, val K: Int, val nsym: Int)
fun newGrid(nrb: Int, nsym: Int = 14): Grid = Grid(FloatArray(nsym * 12 * nrb), FloatArray(nsym * 12 * nrb), 12 * nrb, nsym)

private class FftBufs(n: Int) {
    val re = FloatArray(n); val im = FloatArray(n)
    val bins = HashMap<Int, IntArray>(); val ramp = HashMap<Int, Pair<FloatArray, FloatArray>>()
}
private val fftBufs = ThreadLocal.withInitial { HashMap<Int, FftBufs>() }

/**
 * FFT the symbols of the subframe starting at sample `start` of (xr, xi). The window sits `backoff` samples early,
 * inside the CP, and the resulting linear phase is removed. Returns null if the subframe runs past the buffer.
 */
fun ofdmDemod(xr: FloatArray, xi: FloatArray, start: Double, num: Numerology, nrb: Int, backoff: Int, syms: IntArray? = null, g: Grid = newGrid(nrb)): Grid? {
    val n = num.nfft
    val b = fftBufs.get().getOrPut(n) { FftBufs(n) }
    val bins = b.bins.getOrPut(nrb) { scToBin(nrb, n) }
    val ramp = b.ramp.getOrPut(backoff) {
        val r = FloatArray(n); val i = FloatArray(n)
        for (q in 0 until n) { val a = 2 * Math.PI * backoff * q / n; r[q] = cos(a).toFloat(); i[q] = sin(a).toFloat() }
        r to i
    }
    val k0 = 12 * nrb; val sc = (1 / sqrt(n.toDouble())).toFloat()
    val list = syms ?: IntArray(14) { it }
    val st = jsRound(start)
    for (l in list) {
        val (off, cp) = num.symbol(l)
        val s = st + off + cp - backoff
        if (s < 0 || s + n > xr.size) return null
        System.arraycopy(xr, s, b.re, 0, n); System.arraycopy(xi, s, b.im, 0, n)
        Dsp.fft(b.re, b.im)
        for (k in 0 until k0) {
            val j = bins[k]; val yr = b.re[j]; val yi = b.im[j]; val pr = ramp.first[j]; val pi = ramp.second[j]
            g.re[l * k0 + k] = (yr * pr - yi * pi) * sc; g.im[l * k0 + k] = (yr * pi + yi * pr) * sc
        }
    }
    return g
}

/** Math.round of JavaScript: halves go up. */
internal fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

// ---- 36.211 7.2 Gold sequence -------------------------------------------------------------------------------------
private const val NC = 1600
@Volatile private var X1 = ByteArray(0)
@Synchronized private fun x1(n: Int): ByteArray {
    if (X1.size >= n + NC + 31) return X1
    val len = maxOf(n + NC + 31, 2 * X1.size, 70_000); val x = ByteArray(len)
    x[0] = 1
    var i = 0
    while (i + 31 < len) { x[i + 31] = (x[i + 3].toInt() xor x[i].toInt()).toByte(); i++ }
    X1 = x; return x
}
/** c(n), n = 0..len-1, for c_init (36.211 7.2). */
fun gold(cInit: Long, len: Int): ByteArray {
    val a = x1(len); val x2 = ByteArray(len + NC + 31); val out = ByteArray(len)
    for (b in 0 until 31) x2[b] = ((cInit shr b) and 1L).toByte()
    var i = 0
    while (i + 31 < x2.size) { x2[i + 31] = (x2[i + 3].toInt() xor x2[i + 2].toInt() xor x2[i + 1].toInt() xor x2[i].toInt()).toByte(); i++ }
    for (q in 0 until len) out[q] = (a[q + NC].toInt() xor x2[q + NC].toInt()).toByte()
    return out
}
fun gold(cInit: Int, len: Int): ByteArray = gold(cInit.toLong(), len)

// ---- 36.212 5.1.1 CRCs -------------------------------------------------------------------------------------------
val CRC24A = intArrayOf(24, 23, 18, 17, 14, 11, 10, 7, 6, 5, 4, 3, 1, 0)
val CRC24B = intArrayOf(24, 23, 6, 5, 1, 0)
val CRC16 = intArrayOf(16, 12, 5, 0)
val CRC8 = intArrayOf(8, 7, 4, 3, 1, 0)
/** Parity bits p_0..p_{L-1} (shift register from zero, MSB first). */
fun crcBits(bits: ByteArray, taps: IntArray, n: Int = bits.size, from: Int = 0): ByteArray {
    val l = taps[0]; var poly = 0L
    for (t in taps.drop(1)) poly = poly or (1L shl t)
    val mask = (1L shl l) - 1; val top = 1L shl (l - 1)
    var reg = 0L
    for (i in 0 until n) {
        val fb = (if (reg and top != 0L) 1 else 0) xor (bits[from + i].toInt() and 1)
        reg = (reg shl 1) and mask
        if (fb != 0) reg = reg xor poly
    }
    return ByteArray(l) { ((reg shr (l - 1 - it)) and 1L).toByte() }
}
fun bitsToInt(b: ByteArray, from: Int = 0, n: Int = b.size - from): Int {
    var v = 0L
    for (i in 0 until n) v = v * 2 + (b[from + i].toInt() and 1)
    return v.toInt()
}
fun intToBits(v: Long, n: Int): ByteArray = ByteArray(n) { ((v shr (n - 1 - it)) and 1L).toByte() }
fun bitsToBytes(b: ByteArray): ByteArray {
    val o = ByteArray((b.size + 7) / 8)
    for (i in b.indices) if (b[i].toInt() != 0) o[i shr 3] = (o[i shr 3].toInt() or (0x80 ushr (i and 7))).toByte()
    return o
}
fun hexOf(b: ByteArray): String { val sb = StringBuilder(b.size * 2); for (x in b) sb.append("%02x".format(x.toInt() and 0xff)); return sb.toString() }
fun hexToBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

// ---- 36.211 6.10.1 cell-specific reference signals ---------------------------------------------------------------
private val crsCache = HashMap<Int, Pair<FloatArray, FloatArray>>()
/** r_{l,ns}(m), m = 0..2 N_RB^max - 1, normal CP. */
@Synchronized
fun crsSeq(ns: Int, l: Int, pci: Int): Pair<FloatArray, FloatArray> {
    val key = (ns * 8 + l) * 504 + pci
    crsCache[key]?.let { return it }
    val cInit = 1024L * (7 * (ns + 1) + l + 1) * (2 * pci + 1) + 2 * pci + 1
    val c = gold(cInit, 4 * NRB_MAX); val re = FloatArray(2 * NRB_MAX); val im = FloatArray(2 * NRB_MAX)
    for (m in 0 until 2 * NRB_MAX) { re[m] = (1 - 2 * c[2 * m]) * SQRT1_2; im[m] = (1 - 2 * c[2 * m + 1]) * SQRT1_2 }
    val r = re to im
    if (crsCache.size > 20_000) crsCache.clear()
    crsCache[key] = r
    return r
}
/** Subframe symbols carrying CRS of antenna port p. */
fun crsSymbols(port: Int): IntArray = if (port < 2) intArrayOf(0, 4, 7, 11) else intArrayOf(1, 8)
/** First subcarrier offset of port p's CRS in subframe symbol lSf; CRS sit at k = 6m + offset, m = 0..2 N_RB - 1. */
fun crsShift(port: Int, lSf: Int, pci: Int): Int {
    val l = lSf % 7; val slotPar = (lSf / 7) % 2
    val v = when (port) { 0 -> if (l == 0) 0 else 3; 1 -> if (l == 0) 3 else 0; 2 -> 3 * slotPar; else -> 3 + 3 * slotPar }
    return (v + pci % 6) % 6
}
/** CRS REs of ports 0..nports-1 as a [14 * K] mask. */
fun crsMask(pci: Int, nrb: Int, nports: Int): ByteArray {
    val k0 = 12 * nrb; val m = ByteArray(14 * k0)
    for (p in 0 until nports) for (l in crsSymbols(p)) { val s = crsShift(p, l, pci); var k = s; while (k < k0) { m[l * k0 + k] = 1; k += 6 } }
    return m
}

class Chan(val re: Array<FloatArray>, val im: Array<FloatArray>, val nv: Float, val snr: Double)
/** Least-squares CRS estimate per port, 3-tap smoothing, linear interpolation in frequency, then in time. */
fun chanEst(g: Grid, sf: Int, pci: Int, nrb: Int, nports: Int): Chan {
    val k0 = 12 * nrb
    var noise = 0.0; var nn = 0; var pow = 0.0
    val er = FloatArray(k0); val ei = FloatArray(k0)
    val re = Array(nports) { FloatArray(0) }; val im = Array(nports) { FloatArray(0) }
    for (p in 0 until nports) {
        val hr = FloatArray(14 * k0); val hi = FloatArray(14 * k0); val syms = crsSymbols(p)
        val ests = ArrayList<Pair<FloatArray, FloatArray>>()
        for (l in syms) {
            val ns = 2 * sf + l / 7; val (rr, ri) = crsSeq(ns, l % 7, pci); val s = crsShift(p, l, pci); val mm = 2 * nrb; val off = NRB_MAX - nrb
            val lr = FloatArray(mm); val li = FloatArray(mm)
            for (m in 0 until mm) {
                val k = 6 * m + s; val yr = g.re[l * k0 + k]; val yi = g.im[l * k0 + k]; val cr = rr[m + off]; val ci = ri[m + off]
                lr[m] = yr * cr + yi * ci; li[m] = yi * cr - yr * ci
            }
            val sr = FloatArray(mm); val si = FloatArray(mm)
            for (m in 0 until mm) {
                val a = if (m == 0) 1 else m - 1; val b = if (m == mm - 1) mm - 2 else m + 1
                sr[m] = (lr[a] + lr[m] + lr[b]) / 3; si[m] = (li[a] + li[m] + li[b]) / 3
                val dr = lr[m] - sr[m]; val di = li[m] - si[m]
                noise += dr * dr + di * di; nn++; pow += sr[m] * sr[m] + si[m] * si[m]
            }
            val outR = FloatArray(k0); val outI = FloatArray(k0)
            for (k in 0 until k0) {
                val x = (k - s) / 6.0
                if (x <= 0) { outR[k] = sr[0]; outI[k] = si[0]; continue }
                if (x >= mm - 1) { outR[k] = sr[mm - 1]; outI[k] = si[mm - 1]; continue }
                val i0 = floor(x).toInt(); val w = (x - i0).toFloat()
                outR[k] = sr[i0] * (1 - w) + sr[i0 + 1] * w; outI[k] = si[i0] * (1 - w) + si[i0 + 1] * w
            }
            ests.add(outR to outI)
        }
        for (l in 0 until 14) {
            var a = 0; var b = 0; var w = 0f
            if (l <= syms[0]) { a = 0; b = 0; w = 0f }
            else if (l >= syms[syms.size - 1]) { a = syms.size - 1; b = a; w = 0f }
            else for (i in 0 until syms.size - 1) if (syms[i] <= l && l <= syms[i + 1]) { a = i; b = i + 1; w = (l - syms[i]).toFloat() / (syms[i + 1] - syms[i]); break }
            val ea = ests[a]; val eb = ests[b]
            for (k in 0 until k0) { er[k] = ea.first[k] * (1 - w) + eb.first[k] * w; ei[k] = ea.second[k] * (1 - w) + eb.second[k] * w }
            System.arraycopy(er, 0, hr, l * k0, k0); System.arraycopy(ei, 0, hi, l * k0, k0)
        }
        re[p] = hr; im[p] = hi
    }
    val nv = if (nn > 0) max(1e-9, (noise / nn) * 3 / 2) else 1e-3
    return Chan(re, im, nv.toFloat(), if (nn > 0) pow / nn / nv else 0.0)
}

class Equalized(val xr: FloatArray, val xi: FloatArray, val gain: FloatArray)
/**
 * Undo transmit diversity (6.3.4.3) over a list of REs in mapping order. idx: grid indices.
 * Returns the equalized symbols and an SNR weight per symbol.
 */
fun tdDecode(g: Grid, h: Chan, idx: IntArray, nports: Int): Equalized {
    val m = idx.size; val xr = FloatArray(m); val xi = FloatArray(m); val gain = FloatArray(m)
    if (nports == 1) {
        for (i in 0 until m) {
            val j = idx[i]; val hr = h.re[0][j]; val hi = h.im[0][j]; val yr = g.re[j]; val yi = g.im[j]; val p = max(hr * hr + hi * hi, 1e-12f)
            xr[i] = (yr * hr + yi * hi) / p; xi[i] = (yi * hr - yr * hi) / p; gain[i] = p
        }
        return Equalized(xr, xi, gain)
    }
    fun pair(i0: Int, i1: Int, pa: Int, pb: Int) {
        val j0 = idx[i0]; val j1 = idx[i1]
        val h0r = (h.re[pa][j0] + h.re[pa][j1]) / 2; val h0i = (h.im[pa][j0] + h.im[pa][j1]) / 2
        val h1r = (h.re[pb][j0] + h.re[pb][j1]) / 2; val h1i = (h.im[pb][j0] + h.im[pb][j1]) / 2
        val r0r = g.re[j0]; val r0i = g.im[j0]; val r1r = g.re[j1]; val r1i = g.im[j1]
        val n = max((h0r * h0r + h0i * h0i + h1r * h1r + h1i * h1i) / 2, 1e-12f)
        // x0 = (conj(h0) r0 + h1 conj(r1)) / sqrt2, x1 = (conj(h0) r1 - h1 conj(r0)) / sqrt2
        val a = SQRT1_2 / n
        xr[i0] = ((h0r * r0r + h0i * r0i) + (h1r * r1r + h1i * r1i)) * a
        xi[i0] = ((h0r * r0i - h0i * r0r) + (h1i * r1r - h1r * r1i)) * a
        xr[i1] = ((h0r * r1r + h0i * r1i) - (h1r * r0r + h1i * r0i)) * a
        xi[i1] = ((h0r * r1i - h0i * r1r) - (h1i * r0r - h1r * r0i)) * a
        gain[i0] = n; gain[i1] = n
    }
    if (nports == 2) { var i = 0; while (i + 1 < m) { pair(i, i + 1, 0, 1); i += 2 }; return Equalized(xr, xi, gain) }
    var i = 0
    while (i + 3 < m) { pair(i, i + 1, 0, 2); pair(i + 2, i + 3, 1, 3); i += 4 }
    return Equalized(xr, xi, gain)
}

/** QPSK soft bits (7.1.2: bit 0 maps to +1/sqrt2). Positive means 0. */
fun qpskLlr(x: Equalized, nv: Float, out: FloatArray = FloatArray(2 * x.xr.size)): FloatArray {
    val s = (2 * Math.sqrt(2.0) / max(nv.toDouble(), 1e-9)).toFloat()
    for (i in x.xr.indices) { out[2 * i] = x.xr[i] * x.gain[i] * s; out[2 * i + 1] = x.xi[i] * x.gain[i] * s }
    return out
}
/** Multiplies soft bits by (1 - 2 c(n)). */
fun descramble(llr: FloatArray, c: ByteArray) { for (i in llr.indices) if (c[i].toInt() != 0) llr[i] = -llr[i] }
