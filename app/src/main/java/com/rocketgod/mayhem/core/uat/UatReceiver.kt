package com.rocketgod.mayhem.core.uat

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin

/**
 * UAT receiver (978 MHz, DO-282B): 1.041667 Mbit/s binary CPFSK, modulation index 0.6, so the phase turns about
 * +-108 degrees across each bit. Ground uplinks (FIS-B weather, TIS-B traffic) open with the 36-bit sync 0x153225B1D
 * and carry 4416 bits (six interleaved RS(92,72) blocks); aircraft downlinks open with its complement 0xEACDDA4E2 and
 * carry a basic (RS(30,18)) or long (RS(48,34)) ADS-B frame. The twin of the web app's dsp/uat/demod.ts.
 *
 * How. A wide span is first boxcar-decimated to about 2 Msps; the channel is low-passed to +-700 kHz; the result is
 * resampled (linear interpolation) to exactly 4 samples a bit. The bit decision is the sign of the phase change across
 * one whole bit, Im(x[n+4] conj(x[n])), which needs no arctangent and is far steadier than a sample-to-sample frequency
 * estimate. Each of the four sampling phases feeds a 36-bit shift register matched against both sync words (up to four
 * bit errors). A match schedules the frame; when its bits are in they are sliced at that phase and, if Reed-Solomon
 * fails, at the phases up to two samples either side.
 */
class UatReceiver(private val onUp: (ByteArray, Int) -> Unit, private val onDown: (ByteArray, Boolean, Int) -> Unit) {
    companion object {
        const val BITRATE = 1_041_666.667
        private const val SPS = 4
        private const val SYNC_UP = 0x153225B1DL
        private const val SYNC_DOWN = 0xEACDDA4E2L
        private const val UP_BITS = 4416
        private const val DOWN_LONG_BITS = 384
        private const val DOWN_BASIC_BITS = 240
        private const val MAX_SYNC_ERRS = 4
        private const val RING = 1 shl 16
        private const val MASK36 = (1L shl 36) - 1
    }

    private var rate = 0; private var dec = 1; private var accI = 0f; private var accQ = 0f; private var accN = 0
    private var lp = FloatArray(1); private var hI = FloatArray(1); private var hQ = FloatArray(1); private var hPos = 0
    private var step = 1.0; private var frac = 0.0; private var lastI = 0f; private var lastQ = 0f; private var haveLast = false
    private val yI = FloatArray(RING); private val yQ = FloatArray(RING); private val sgn = ByteArray(RING); private val pw = FloatArray(RING)
    private var n = 0L
    private val reg = LongArray(SPS)
    private data class Pending(val at: Long, val up: Boolean, val snr: Float)
    private val pending = ArrayDeque<Pending>()
    private var lastUpAt = -1_000_000_000L; private var lastDownAt = -1_000_000_000L
    private var floor = 1f
    var uplinks = 0; private set
    var downlinks = 0; private set
    var bad = 0; private set

    fun reset(rate: Int) {
        this.rate = rate
        dec = max(1, rate / 2_000_000)
        val r2 = rate.toDouble() / dec
        val taps = 15; val cut = 700_000.0 / r2; val m = taps - 1
        lp = FloatArray(taps)
        var sum = 0.0
        for (k in 0 until taps) {
            val x = k - m / 2.0
            val s = if (x == 0.0) 2 * cut else sin(2 * PI * cut * x) / (PI * x)
            lp[k] = (s * (0.54 - 0.46 * cos(2 * PI * k / m))).toFloat(); sum += lp[k]
        }
        for (k in 0 until taps) lp[k] = (lp[k] / sum).toFloat()
        hI = FloatArray(taps); hQ = FloatArray(taps); hPos = 0
        step = r2 / (SPS * BITRATE)
        frac = 0.0; haveLast = false; accI = 0f; accQ = 0f; accN = 0
        n = 0; reg.fill(0); pending.clear(); lastUpAt = -1_000_000_000L; lastDownAt = -1_000_000_000L; floor = 1f
    }

    /** Offset-128 interleaved I,Q bytes (the engine's format). */
    fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        val taps = lp.size
        var k = 0
        while (k + 1 < len) {
            accI += (iq[k].toInt() and 0xff) - 127.5f; accQ += (iq[k + 1].toInt() and 0xff) - 127.5f
            k += 2
            if (++accN < dec) continue
            val xi = accI; val xq = accQ
            accI = 0f; accQ = 0f; accN = 0
            hI[hPos] = xi; hQ[hPos] = xq
            var fi = 0f; var fq = 0f; var p = hPos
            for (t in 0 until taps) { fi += lp[t] * hI[p]; fq += lp[t] * hQ[p]; p = if (p == 0) taps - 1 else p - 1 }
            hPos = if (hPos + 1 == taps) 0 else hPos + 1
            if (!haveLast) { lastI = fi; lastQ = fq; haveLast = true; continue }
            while (frac < 1.0) {
                val a = frac.toFloat()
                push(lastI + (fi - lastI) * a, lastQ + (fq - lastQ) * a)
                frac += step
            }
            frac -= 1.0
            lastI = fi; lastQ = fq
        }
    }

    private fun push(i: Float, q: Float) {
        val nn = n; val w = (nn and (RING - 1).toLong()).toInt()
        yI[w] = i; yQ[w] = q
        val p = i * i + q * q
        pw[w] = p
        n = nn + 1
        if (nn < SPS) { sgn[w] = 0; return }
        val b = ((nn - SPS) and (RING - 1).toLong()).toInt()
        val im = q * yI[b] - i * yQ[b]
        val bit = if (im > 0) 1L else 0L
        sgn[w] = if (bit == 1L) 1 else -1
        floor = if (p < floor) floor * 0.99f + p * 0.01f else floor * 0.99999f + p * 0.00001f
        val ph = (nn and (SPS - 1).toLong()).toInt()
        val r = ((reg[ph] shl 1) or bit) and MASK36
        reg[ph] = r
        if (java.lang.Long.bitCount(r xor SYNC_UP) <= MAX_SYNC_ERRS && nn - lastUpAt > 8 * SPS) {
            lastUpAt = nn; pending.addLast(Pending(nn, true, snr(nn)))
        } else if (java.lang.Long.bitCount(r xor SYNC_DOWN) <= MAX_SYNC_ERRS && nn - lastDownAt > 8 * SPS) {
            lastDownAt = nn; pending.addLast(Pending(nn, false, snr(nn)))
        }
        val due = pending.firstOrNull() ?: return
        val need = if (due.up) UP_BITS else DOWN_LONG_BITS
        if (nn >= due.at + need * SPS + 2) { pending.removeFirst(); finish(due) }
    }

    private fun snr(nn: Long): Float {
        var s = 0f
        for (k in 0 until 36 * SPS) s += pw[((nn - k) and (RING - 1).toLong()).toInt()]
        return (10 * log10(s / (36 * SPS) / max(1e-9f, floor))).toFloat()
    }

    private fun bits(at: Long, nbits: Int, off: Int): IntArray {
        val out = IntArray(nbits shr 3)
        for (k in 0 until nbits) {
            val s = sgn[((at + off + (k + 1) * SPS) and (RING - 1).toLong()).toInt()]
            if (s > 0) out[k shr 3] = out[k shr 3] or (0x80 ushr (k and 7))
        }
        return out
    }

    private fun finish(f: Pending) {
        for (off in intArrayOf(0, -1, 1, -2, 2)) {
            if (f.up) {
                val r = UatRs.uplinkMessage(bits(f.at, UP_BITS, off))
                if (r != null) { uplinks++; onUp(r.first, r.second); return }
            } else {
                val long = bits(f.at, DOWN_LONG_BITS, off)
                val nl = UatRs.correct(long, 14)
                if (nl >= 0) { downlinks++; onDown(ByteArray(34) { long[it].toByte() }, true, nl); return }
                val basic = bits(f.at, DOWN_BASIC_BITS, off)
                val nb = UatRs.correct(basic, 12)
                if (nb >= 0) { downlinks++; onDown(ByteArray(18) { basic[it].toByte() }, false, nb); return }
            }
        }
        bad++
    }
}

