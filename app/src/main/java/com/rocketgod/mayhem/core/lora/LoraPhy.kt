package com.rocketgod.mayhem.core.lora

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// Not a Mayhem port: a LoRa receiver for complex baseband at the channel's own bandwidth (one sample a chip).
// Kotlin twin of the iOS LoraPhy.swift.

/** One LoRa frame as it came off the air. */
data class LoraFrame(
    val sf: Int,
    val bw: Int,
    val cr: Int,
    /** The payload (the CRC removed), and whether its CRC checked out (null: sent without one). */
    val payload: List<Int>,
    val crcOk: Boolean?,
    /** Frequency error in Hz, signal-to-noise of the dechirped peaks in dB, the two sync-word symbols. */
    val cfoHz: Double,
    val snrDb: Double,
    val sync: List<Int>,
)

/**
 * The bit-level steps of LoRa as the open receivers (gr-lora_sdr) document them, checked against real Meshtastic
 * packets: symbol = (FFT peak - 1) mod 2^SF, divided by 4 (rounded) in the header and in low-data-rate mode,
 * Gray coded s ^ (s >> 1), written into a diagonal interleaver (row (i - j - 1) mod sf_app), four data bits of each
 * Hamming codeword taken from bits 3, 2, 1, 0, nibbles low first, whitened with an LFSR that steps once a byte, and a
 * CRC-16/CCITT over all but the last two payload bytes, then folded with them.
 */
object LoraCodec {
    val whitening: IntArray = IntArray(256).also { out ->
        var s = 0xFF
        for (i in 0 until 256) {
            out[i] = s
            val b = ((s shr 7) xor (s shr 5) xor (s shr 4) xor (s shr 3)) and 1
            s = ((s shl 1) or b) and 0xFF
        }
    }

    class Header(val len: Int, val cr: Int, val crc: Boolean, val rest: IntArray)

    fun headerChecksum(n: IntArray): Int {
        fun bit(x: Int, i: Int) = (x shr i) and 1
        val a = n[0]; val b = n[1]; val c = n[2]
        val c4 = bit(a, 3) xor bit(a, 2) xor bit(a, 1) xor bit(a, 0)
        val c3 = bit(a, 3) xor bit(b, 3) xor bit(b, 2) xor bit(b, 1) xor bit(c, 0)
        val c2 = bit(a, 2) xor bit(b, 3) xor bit(b, 0) xor bit(c, 3) xor bit(c, 1)
        val c1 = bit(a, 1) xor bit(b, 2) xor bit(b, 0) xor bit(c, 2) xor bit(c, 1) xor bit(c, 0)
        val c0 = bit(a, 0) xor bit(b, 1) xor bit(c, 3) xor bit(c, 2) xor bit(c, 1) xor bit(c, 0)
        return (c4 shl 4) or (c3 shl 3) or (c2 shl 2) or (c1 shl 1) or c0
    }

    /** cwLen symbols of sfApp bits into sfApp nibbles. */
    fun block(syms: IntArray, from: Int, sfApp: Int, cwLen: Int): IntArray {
        val cw = Array(sfApp) { IntArray(cwLen) }
        for (i in 0 until cwLen) {
            val s = syms[from + i]
            val g = s xor (s shr 1)
            for (j in 0 until sfApp) {
                val bit = (g shr (sfApp - 1 - j)) and 1
                cw[((i - j - 1) % sfApp + sfApp) % sfApp][i] = bit
            }
        }
        return IntArray(sfApp) { (cw[it][3] shl 3) or (cw[it][2] shl 2) or (cw[it][1] shl 1) or cw[it][0] }
    }

    fun crc16(d: List<Int>, from: Int, to: Int): Int {
        var c = 0
        for (i in from until to) {
            c = c xor (d[i] shl 8)
            for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF
        }
        return c
    }

    /** Header fields from the first block's symbols (already reduced to sf-2 bits); null when the checksum fails. */
    fun header(syms: IntArray, sf: Int): Header? {
        val n = block(syms, 0, sf - 2, 8)
        val len = (n[0] shl 4) or n[1]; val cr = n[2] shr 1; val crc = n[2] and 1 == 1
        if (headerChecksum(n) != (((n[3] and 1) shl 4) or n[4]) || len == 0 || cr < 1 || cr > 4) return null
        return Header(len, cr, crc, n.copyOfRange(5, n.size))
    }

    /** Payload bytes from all the symbols (header block first), given the header; and whether the CRC held. */
    fun payload(syms: IntArray, sf: Int, ldro: Boolean, h: Header): Pair<List<Int>, Boolean?>? {
        val nib = ArrayList<Int>(); for (x in h.rest) nib.add(x)
        val need = 2 * (h.len + if (h.crc) 2 else 0)
        val cwLen = 4 + h.cr; val sfApp = if (ldro) sf - 2 else sf
        var p = 8
        while (nib.size < need) {
            if (p + cwLen > syms.size) return null
            val blk = IntArray(cwLen) { val v = syms[p + it]; if (ldro) ((v + 2) / 4) % (1 shl (sf - 2)) else v }
            for (x in block(blk, 0, sfApp, cwLen)) nib.add(x)
            p += cwLen
        }
        val by = IntArray(need / 2) { nib[2 * it] or (nib[2 * it + 1] shl 4) }
        val data = List(h.len) { by[it] xor whitening[it % 256] }
        if (!h.crc) return data to null
        var c = crc16(data, 0, max(0, h.len - 2))
        if (h.len >= 2) c = c xor data[h.len - 1] xor (data[h.len - 2] shl 8)
        val rx = by[h.len] or (by[h.len + 1] shl 8)
        return data to (c == rx)
    }

    /** How many symbols a frame of this header takes (the header block included). */
    fun symbolCount(sf: Int, ldro: Boolean, h: Header): Int {
        val need = 2 * (h.len + if (h.crc) 2 else 0) - h.rest.size
        val perBlock = if (ldro) sf - 2 else sf
        val blocks = if (need <= 0) 0 else (need + perBlock - 1) / perBlock
        return 8 + blocks * (4 + h.cr)
    }
}

/**
 * A streaming LoRa receiver for one channel: complex samples at exactly the bandwidth (one per chip) go in, frames
 * come out. It dechirps window after window; a run of matching peaks is a preamble; the up-chirp peak and the
 * start-of-frame down-chirp peak, both read on the same window grid, give the timing (where the symbols really
 * start) and the frequency error; then the header, its length, and the payload.
 */
class LoraReceiver(val sf: Int, val bw: Int, ldro: Boolean? = null) {
    /** Low data rate optimization: on when a symbol lasts 16 ms or more. */
    val ldro: Boolean = ldro ?: ((1 shl sf).toDouble() / bw >= 0.016)
    private val n = 1 shl sf
    private val up = FloatArray(2 * n); private val down = FloatArray(2 * n)   // interleaved chirps
    private var buf = FloatArray(0); private var bufLen = 0                     // interleaved complex
    private var base = 0L                                                       // absolute index of buf[0] (in samples)
    private var grid = 0L                                                       // absolute position of the next window
    private val runPos = ArrayList<Long>(); private val runK = ArrayList<Int>()
    private val re = FloatArray(n); private val im = FloatArray(n)
    var onFrame: ((LoraFrame) -> Unit)? = null
    /** A LoRa preamble found and its timing solved: a real LoRa transmission, decodable or not. */
    var onAligned: (() -> Unit)? = null
    /** Debug: each stage of each frame attempt. */
    var trace: ((String) -> Unit)? = null

    private class Pending(val p: Long, val c: Double, val sfd: Long, val sync: List<Int>, val snr: Double)
    private var pending: Pending? = null

    init {
        for (i in 0 until n) {
            val ph = 2 * Math.PI * (i.toDouble() * i / (2.0 * n) - i / 2.0)
            up[2 * i] = cos(ph).toFloat(); up[2 * i + 1] = sin(ph).toFloat()
            down[2 * i] = cos(ph).toFloat(); down[2 * i + 1] = (-sin(ph)).toFloat()
        }
    }

    private var lastQ = 0f

    /** Peak bin of the window at absolute sample [at], times [chirp], with a frequency correction of [c] bins; its height over the mean in [lastQ]. */
    private fun peak(at: Long, chirp: FloatArray, c: Double = 0.0): Int {
        val o = ((at - base) * 2).toInt()
        val w = -2 * Math.PI * c / n
        for (i in 0 until n) {
            var xr = buf[o + 2 * i]; var xi = buf[o + 2 * i + 1]
            if (c != 0.0) { val cr = cos(w * i).toFloat(); val ci = sin(w * i).toFloat(); val t = xr * cr - xi * ci; xi = xr * ci + xi * cr; xr = t }
            re[i] = xr * chirp[2 * i] - xi * chirp[2 * i + 1]
            im[i] = xr * chirp[2 * i + 1] + xi * chirp[2 * i]
        }
        Dsp.fft(re, im)
        var best = 0; var bv = -1f; var sum = 0f
        for (i in 0 until n) { val m = re[i] * re[i] + im[i] * im[i]; sum += m; if (m > bv) { bv = m; best = i } }
        // over the mean of the other bins (the noise): a clean strong peak is N x the signal-to-noise ratio, not N
        lastQ = bv / max((sum - bv) / (n - 1), 1e-12f)
        return best
    }

    /** The peak's position to a fraction of a bin (Jacobsen's estimator on the complex bins around it), signed. */
    private fun peakFrac(at: Long, chirp: FloatArray, c: Double): Double {
        val k = peak(at, chirp, c)
        val a = (k - 1 + n) % n; val b = (k + 1) % n
        // (X[k-1] - X[k+1]) / (2 X[k] - X[k-1] - X[k+1]), real part
        val nr = re[a] - re[b]; val ni = im[a] - im[b]
        val dr = 2 * re[k] - re[a] - re[b]; val di = 2 * im[k] - im[a] - im[b]
        val den = dr * dr + di * di
        val d = if (den > 0) ((nr * dr + ni * di) / den).toDouble() else 0.0
        var v = k + max(-0.5, min(0.5, d))
        if (v > n / 2.0) v -= n
        return v
    }

    private val end: Long get() = base + bufLen / 2

    fun push(x: FloatArray, len: Int = x.size) {
        if (bufLen + len > buf.size) buf = buf.copyOf(max(2 * buf.size, bufLen + len))
        System.arraycopy(x, 0, buf, bufLen, len); bufLen += len
        work()
        // keep what an unfinished frame or the next look still needs
        val keepFrom = minOf(pending?.p ?: grid, runPos.firstOrNull() ?: grid, grid) - n
        val drop = keepFrom - base
        if (drop > 4 * n) {
            val d = (drop * 2).toInt()
            System.arraycopy(buf, d, buf, 0, bufLen - d); bufLen -= d; base += drop
        }
    }

    private fun work() {
        while (true) {
            val pd = pending
            if (pd != null) { if (!finish(pd)) return; continue }
            if (grid + n > end) return
            val k = peak(grid, down); val q = lastQ
            if (q > THRESH && runK.isNotEmpty() && near(k, runK.last(), 2)) {
                runPos.add(grid); runK.add(k)
            } else {
                if (runK.size >= 6) {
                    // the preamble has ended: wait until the start-of-frame is in, then solve it
                    if (runPos.last() + 8 * n > end) return
                    startFrame()
                    if (pending != null) continue
                }
                runPos.clear(); runK.clear()
                if (q > THRESH) { runPos.add(grid); runK.add(k) }
            }
            grid += n
        }
    }

    private fun near(a: Int, b: Int, t: Int): Boolean { val d = ((a - b) % n + n) % n; return min(d, n - d) <= t }

    /** A preamble just ended: find the down-chirps on the same grid, solve timing and frequency. */
    private fun startFrame() {
        val p0 = runPos[0]; val k1 = runK[runK.size / 2]
        val last = runPos.last()
        var bestQ = 0f; var k2 = -1
        for (m in 1..6) { val k = peak(last + m * n, up); if (lastQ > bestQ) { bestQ = lastQ; k2 = k } }
        runPos.clear(); runK.clear()
        Stats.preambles.incrementAndGet()
        trace?.invoke("preamble $p0 k1 $k1 k2 $k2 q2 $bestQ")
        if (bestQ < THRESH) return
        Stats.downChirps.incrementAndGet()
        var bestSol = Double.MAX_VALUE; var c = 0.0; var d = 0.0
        for (half in doubleArrayOf(0.0, n / 2.0)) {
            var cc = ((k1 + k2) / 2.0 + half).rem(n.toDouble()); if (cc > n / 2.0) cc -= n
            val dd = ((k2 - k1) / 2.0 + half).rem(n.toDouble())
            if (abs(cc) < bestSol) { bestSol = abs(cc); c = cc; d = if (dd < 0) dd + n else dd }
        }
        // which way round the delay goes: the one that puts the preamble on bin c
        var bestScore = -1; var bestP = 0L
        for (dd in doubleArrayOf(d, d - n)) {
            val p = p0 + rnd(dd)
            if (p - base < 0 || p + 6 * n > end) continue
            var score = 0
            for (m in 1..4) { val k = peak(p + m * n, down, c); if (near(k, 0, 1)) score++ }
            if (bestScore < 0 || score > bestScore) { bestScore = score; bestP = p }
        }
        trace?.invoke("align c $c d $d best $bestScore@$bestP")
        if (bestScore < 3) return
        Stats.aligned.incrementAndGet()
        onAligned?.invoke()
        val p = bestP
        // what is left once the whole bins are taken out: the frequency error's fraction and the timing's, which the
        // data symbols (up-chirps, like the preamble) carry exactly as the preamble does
        var r = 0.0
        for (m in 1..4) r += peakFrac(p + m * n, down, c)
        val cf = c + r / 4
        trace?.invoke("fraction ${r / 4}")
        // the start-of-frame: the first aligned window whose up-dechirp sits on bin 0
        var m = 1
        while (m < 30) {
            if (p + (m + 1) * n > end) return
            val k = peak(p + m * n, up, cf)
            if (lastQ > THRESH && near(k, 0, 2)) break
            m++
        }
        trace?.invoke("sfd m $m")
        if (m >= 30) return
        Stats.sfd.incrementAndGet()
        val sync = listOf(2, 1).map { j -> peak(p + (m - j) * n, down, cf) }
        // the dechirped peak over the noise bins is 1 + N x the signal-to-noise ratio (power, per sample)
        peak(p + 2 * n, down, cf)
        val pq = lastQ.toDouble()
        pending = Pending(p, cf, p + m * n, sync, 10 * log10(max(pq - 1, 1e-3) / n))
    }

    /** Decode the frame once enough samples are in; false while waiting. */
    private fun finish(pd: Pending): Boolean {
        val start = pd.sfd + (9 * n) / 4
        if (start + 8 * n > end) return false
        // the frequency estimate first, then a little either side of it: the frame's own CRC says which was right
        // (a strong or clipped signal can leave the estimate a quarter or half a bin out)
        var fallback: LoraFrame? = null
        var consumed = start
        var hdr = false
        for (dc in doubleArrayOf(0.0, -0.5, 0.5, -0.25, 0.25)) {
            val c = pd.c + dc
            fun sym(i: Int): Int = ((peak(start + i.toLong() * n, down, c) - 1) % n + n) % n
            // reduced to sf-2 bits by rounding, not truncating: a fraction of a bin of timing or frequency error puts
            // a peak one bin either side of its multiple of 4
            val hs = IntArray(8) { ((sym(it) + 2) / 4) % (n / 4) }
            if (dc == 0.0) trace?.invoke("header syms ${hs.toList()}")
            val h = LoraCodec.header(hs, sf) ?: continue
            hdr = true
            val total = LoraCodec.symbolCount(sf, ldro, h)
            if (start + total.toLong() * n > end) {
                if (dc == 0.0) trace?.invoke("waiting for ${start + total.toLong() * n - end} of $total symbols, base $base buf ${bufLen / 2}")
                return false
            }
            val syms = IntArray(total) { if (it < 8) hs[it] else sym(it) }
            val (data, ok) = LoraCodec.payload(syms, sf, ldro, h) ?: continue
            consumed = max(consumed, start + total.toLong() * n)
            val f = LoraFrame(sf, bw, h.cr, data, ok, c * bw / n, pd.snr, pd.sync)
            if (ok != false) {
                Stats.headers.incrementAndGet(); Stats.good.incrementAndGet()
                trace?.invoke("frame at correction $dc")
                pending = null; grid = max(grid, start + total.toLong() * n)
                onFrame?.invoke(f)
                return true
            }
            if (fallback == null) fallback = f
        }
        pending = null
        grid = max(grid, consumed)
        if (hdr) Stats.headers.incrementAndGet()
        if (fallback != null) Stats.crcFailed.incrementAndGet()
        fallback?.let { onFrame?.invoke(it) }
        return true
    }

    /**
     * How far the receivers get, summed over all of them (diagnostics): preamble runs ended, down-chirps found after
     * them, timing aligned, start-of-frame found, a header that checks, a CRC that holds, and frames whose CRC failed.
     */
    object Stats {
        val preambles = java.util.concurrent.atomic.AtomicLong(); val downChirps = java.util.concurrent.atomic.AtomicLong()
        val aligned = java.util.concurrent.atomic.AtomicLong(); val sfd = java.util.concurrent.atomic.AtomicLong()
        val headers = java.util.concurrent.atomic.AtomicLong(); val good = java.util.concurrent.atomic.AtomicLong()
        val crcFailed = java.util.concurrent.atomic.AtomicLong()
        fun line() = "preambles %d · down-chirps %d · aligned %d · start-of-frame %d · header ok %d · CRC ok %d · CRC failed %d".format(
            preambles.get(), downChirps.get(), aligned.get(), sfd.get(), headers.get(), good.get(), crcFailed.get())
    }

    companion object {
        private const val THRESH = 12f
        /** Swift's rounding (half away from zero). */
        private fun rnd(x: Double): Long = if (x >= 0) kotlin.math.floor(x + 0.5).toLong() else -kotlin.math.floor(-x + 0.5).toLong()
    }
}
