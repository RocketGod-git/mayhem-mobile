package com.rocketgod.mayhem.core.trains

import com.rocketgod.mayhem.core.BitSync
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Railroad telemetry, worked out from raw recordings and the published field layouts:
 *
 * - EOT / HOT / DPU (end-of-train, head-of-train, distributed power) on 457.9375 / 452.9375 / 457.925 MHz: NBFM carrying
 *   1200 baud FFSK (mark 1200 Hz, space 1800 Hz). An EOT sends 69 bits of dotting, an 11-bit frame sync and a 63-bit block
 *   (45 data bits and an 18-bit BCH check XORed with a fixed key), twice. A HOT sends 456 bits of dotting, a 24-bit frame
 *   sync and one 64-bit block three times (30 data bits, 33 BCH, odd parity).
 * - PTC (I-ETMS / ITCnet) on 217-222 MHz: pi/4-DQPSK at 8000 symbols/s in 25 kHz channels, bursts of 17-25 ms. Every
 *   station opens with 9 preamble symbols and the same 30-symbol sync word; the rest is coded and whitened, so it is
 *   tracked (who, when, how often, has it changed) rather than read.
 */

/**
 * A down-converter: mixes a channel to DC, integrates and dumps by d1 (to about four times the output rate), then an FIR
 * low-pass decimating by d2. The boxcar's nulls land on every alias of a narrow channel, so the cheap first stage keeps
 * the neighbors out and the FIR does the real filtering at the low rate.
 */
internal class Ddc(private val cutHz: Double, private val wantRate: Double, private val taps: Int = 63) {
    var offsetHz = 0.0
    var outRate = 0.0; private set
    private var inRate = 0.0
    private var d1 = 1; private var d2 = 1
    private var h = FloatArray(1)
    private var bi = FloatArray(2); private var bq = FloatArray(2); private var bp = 0; private var bc = 0
    private var ai = 0.0; private var aq = 0.0; private var ac = 0
    private var cr = 1.0; private var ci = 0.0; private var dr = 1.0; private var di = 0.0; private var lastOff = Double.NaN

    fun reset(rate: Double) {
        inRate = rate
        d1 = max(1, (rate / (wantRate * 4)).roundToInt())
        val mid = rate / d1
        d2 = max(1, (mid / wantRate).roundToInt())
        outRate = mid / d2
        h = lowpass(taps, cutHz / mid)
        bi = FloatArray(2 * taps); bq = FloatArray(2 * taps); bp = 0; bc = 0
        ai = 0.0; aq = 0.0; ac = 0
        cr = 1.0; ci = 0.0; lastOff = Double.NaN
    }

    fun maxOut(n: Int) = n / (d1 * d2) + 2

    /** [n] complex samples in; the output goes to [oi]/[oq] from index 0, and the count comes back. */
    fun push(xi: FloatArray, xq: FloatArray, n: Int, oi: FloatArray, oq: FloatArray): Int {
        if (offsetHz != lastOff) { lastOff = offsetHz; val w = -2 * PI * offsetHz / inRate; dr = cos(w); di = sin(w) }
        var r = cr; var s = ci; var out = 0
        val len = taps; val inv = 1.0 / d1
        var sumI = ai; var sumQ = aq; var cnt = ac
        for (k in 0 until n) {
            val a = xi[k].toDouble(); val b = xq[k].toDouble()
            sumI += a * r - b * s; sumQ += a * s + b * r
            val nr = r * dr - s * di; s = r * di + s * dr; r = nr
            if (++cnt < d1) continue
            cnt = 0
            val yi = (sumI * inv).toFloat(); val yq = (sumQ * inv).toFloat(); sumI = 0.0; sumQ = 0.0
            bi[bp] = yi; bi[bp + len] = yi; bq[bp] = yq; bq[bp + len] = yq
            if (++bp >= len) bp = 0
            if (++bc < d2) continue
            bc = 0
            var si = 0f; var sq = 0f
            for (t in 0 until len) { si += bi[bp + t] * h[t]; sq += bq[bp + t] * h[t] }
            if (out < oi.size) { oi[out] = si; oq[out] = sq; out++ }
        }
        ai = sumI; aq = sumQ; ac = cnt
        val m = 1.0 / sqrt(r * r + s * s); cr = r * m; ci = s * m
        return out
    }

    companion object {
        fun lowpass(taps: Int, cut: Double): FloatArray {
            val m = taps - 1; val h = DoubleArray(taps); var sum = 0.0
            for (k in 0 until taps) {
                val x = k - m / 2.0
                val sinc = if (x == 0.0) 2 * cut else sin(2 * PI * cut * x) / (PI * x)
                h[k] = sinc * (0.54 - 0.46 * cos(2 * PI * k / m)); sum += h[k]
            }
            return FloatArray(taps) { (h[it] / sum).toFloat() }
        }
    }
}

/**
 * 1200 baud FFSK on an NFM channel: FM discriminator, one-bit mark (1200 Hz) and space (1800 Hz) correlators, clock
 * recovery. Tones are audio frequencies, so the discriminator's sign and the deviation do not matter.
 */
internal class FfskRx(private val onBit: (Int) -> Unit) {
    var fs = 0.0; private set
    private var len = 20
    private var pi = 1f; private var pq = 0f
    private var mRe = FloatArray(1); private var mIm = FloatArray(1); private var sRe = FloatArray(1); private var sIm = FloatArray(1)
    private var pos = 0; private var smr = 0f; private var smi = 0f; private var ssr = 0f; private var ssi = 0f
    private var wm = 0.0; private var ws = 0.0; private var tN = 0L
    private var dc = 0f
    private var sync = BitSync(1200.0, 24_000.0)
    /** Channel power, smoothed (linear), and the slow noise floor under it. */
    var power = 0.0; private set
    var floor = 0.0; private set

    fun reset(rate: Double) {
        fs = rate; len = max(4, (rate / 1200).roundToInt())
        mRe = FloatArray(len); mIm = FloatArray(len); sRe = FloatArray(len); sIm = FloatArray(len)
        pos = 0; smr = 0f; smi = 0f; ssr = 0f; ssi = 0f
        wm = 2 * PI * 1200 / rate; ws = 2 * PI * 1800 / rate; tN = 0
        sync = BitSync(1200.0, rate, 0.2)
        pi = 1f; pq = 0f; dc = 0f; power = 0.0; floor = 0.0
    }

    fun push(zi: FloatArray, zq: FloatArray, n: Int) {
        for (k in 0 until n) {
            val i = zi[k]; val q = zq[k]
            val p = (i * i + q * q).toDouble()
            power += 0.01 * (p - power)
            floor = if (floor == 0.0) power else if (power < floor) floor + 0.02 * (power - floor) else floor + 0.00002 * (power - floor)
            // discriminator
            val re = i * pi + q * pq; val im = q * pi - i * pq
            pi = i; pq = q
            var a = atan2(im, re)
            dc += 0.002f * (a - dc); a -= dc
            // tone correlators over the last bit
            val t = (tN++ % 1_000_000L).toDouble()
            val cm = cos(wm * t).toFloat(); val snm = sin(wm * t).toFloat()
            val cs = cos(ws * t).toFloat(); val sns = sin(ws * t).toFloat()
            val nmr = a * cm; val nmi = -a * snm; val nsr = a * cs; val nsi = -a * sns
            smr += nmr - mRe[pos]; smi += nmi - mIm[pos]; ssr += nsr - sRe[pos]; ssi += nsi - sIm[pos]
            mRe[pos] = nmr; mIm[pos] = nmi; sRe[pos] = nsr; sIm[pos] = nsi
            if (++pos >= len) {
                pos = 0
                // re-sum now and then so float drift never builds up
                smr = mRe.sum(); smi = mIm.sum(); ssr = sRe.sum(); ssi = sIm.sum()
            }
            val d = sqrt(smr * smr + smi * smi) - sqrt(ssr * ssr + ssi * ssi)   // > 0: mark
            val bit = sync.push(d)
            if (bit >= 0) onBit(bit)
        }
    }

    /** Signal over the noise floor in dB, right now. */
    fun snrDb(): Int = if (floor <= 0) 0 else (10 * kotlin.math.log10(max(power, 1e-9) / floor)).roundToInt()
}

/** One decoded EOT (rear unit) frame. The layout follows PyEOT by Eric Reuter, checked against off-air recordings. */
data class EotPacket(
    val unit: Int, val psig: Int, val batteryPct: Int, val batteryCond: String, val type: Int, val arm: String,
    val motion: Boolean, val markerLight: Boolean, val markerBattery: Boolean, val turbine: Boolean, val valve: Boolean,
    val confirm: Boolean, val bits: String,
)

/** Finds EOT frames in a bit stream: the end of the dotting and the frame sync, then the block, checked by its BCH. */
internal class EotParser(private val onPacket: (EotPacket) -> Unit) {
    private var shift = 0
    private var got = -1
    private val p = IntArray(74)

    fun push(bit: Int) {
        if (got >= 0) {
            p[11 + got] = bit
            if (++got == 63) { got = -1; decode(p)?.let(onPacket) }
        }
        shift = ((shift shl 1) or bit) and 0x1FFFF
        if (got < 0 && Integer.bitCount(shift xor SYNC17) <= 1) {
            for (k in 0 until 11) p[k] = (FSYNC11 shr (10 - k)) and 1
            got = 0
        }
    }

    companion object {
        /** The last 6 bits of the dotting and the 11-bit frame sync. */
        const val SYNC17 = 0b10101011100010010
        const val FSYNC11 = 0b11100010010
        private const val GEN = "1111001101000001111"
        private const val KEY = "101011011101110000"

        /** The 18 check bits of a 45-bit data block (as sent), XORed with the key, as sent. */
        fun check(data: IntArray): IntArray {
            val g = IntArray(GEN.length) { GEN[it] - '0' }
            val b = IntArray(45 + 18)
            for (i in 0 until 45) b[i] = data[44 - i]
            for (i in 0 until 45) if (b[i] == 1) for (j in g.indices) b[i + j] = b[i + j] xor g[j]
            return IntArray(18) { b[45 + it] xor (KEY[it] - '0') }
        }

        /** [p]: the 74 bits from the frame sync on. */
        fun decode(p: IntArray): EotPacket? {
            val data = IntArray(45) { p[11 + it] }
            val c = check(data)
            for (i in 0 until 18) if (c[i] != p[56 + i]) return null
            fun r(a: Int, b: Int): Int { var v = 0; for (i in a until b) v = v or (p[i] shl (i - a)); return v }
            val cond = when ("${p[14]}${p[13]}") { "11" -> "OK"; "10" -> "LOW"; "01" -> "VERY LOW"; else -> "NOT MONITORED" }
            val type = (p[15] shl 2) or (p[16] shl 1) or p[17]
            val arm = if (type == 7) (if (p[51] == 0) "ARMING" else "ARMED") else "NORMAL"
            return EotPacket(unit = r(18, 35), psig = r(35, 42), batteryPct = (r(42, 49) * 100 / 127.0).roundToInt(), batteryCond = cond,
                type = type, arm = arm, motion = p[53] == 1, markerLight = p[55] == 1, markerBattery = p[54] == 1, turbine = p[52] == 1,
                valve = p[50] == 1, confirm = p[51] == 1, bits = p.joinToString(""))
        }
    }
}

/** One HOT (head unit) transmission: its frame sync and the 64-bit block, voted from its three copies. */
data class HotFrame(val sync24: Int, val block: Long, val agree: Int, val parityOk: Boolean) {
    /** The 30 data bits ahead of the BCH. */
    val data: Int get() = ((block ushr 34) and 0x3FFF_FFFFL).toInt()
}

/**
 * Finds HOT transmissions: a long dotting (the HOT's is 456 bits, an EOT's 69), then a 24-bit frame sync and the block
 * three times. The sync value is not published, so the block boundary is found from the copies agreeing.
 */
internal class HotParser(private val onFrame: (HotFrame) -> Unit) {
    private var last = -1; private var run = 0
    private var got = -1
    private val buf = IntArray(8 + 24 + 192 + 8)

    fun push(bit: Int) {
        if (got >= 0) {
            buf[got] = bit
            if (++got == buf.size) { got = -1; decode() }
            return
        }
        if (bit != last) run++ else {
            if (run >= 120) {
                // the dotting just ended: the 8 bits before this one are kept in case the sync starts inside it
                for (k in 0 until 8) buf[k] = if ((k and 1) == 0) last xor 1 else last
                buf[8] = bit; got = 9
                last = bit; run = 1
                return
            }
            run = 1
        }
        last = bit
    }

    private fun decode() {
        var best: HotFrame? = null
        for (o in 0..16) {
            val a = block(o + 24); val b = block(o + 24 + 64); val c = block(o + 24 + 128)
            val agree = (if (a == b) 1 else 0) + (if (a == c) 1 else 0) + (if (b == c) 1 else 0)
            if (agree == 0) continue
            val v = (a and b) or (a and c) or (b and c)
            val parity = java.lang.Long.bitCount(v) % 2 == 1
            var s = 0; for (k in 0 until 24) s = (s shl 1) or buf[o + k]
            val f = HotFrame(s, v, if (agree == 3) 3 else 2, parity)
            if (best == null || f.agree > best.agree || (f.agree == best.agree && f.parityOk && !best.parityOk)) best = f
        }
        best?.let(onFrame)
    }

    private fun block(at: Int): Long { var v = 0L; for (k in 0 until 64) v = (v shl 1) or buf[at + k].toLong(); return v }
}

/** One PTC burst, demodulated. */
class PtcBurst(
    val hz: Long, val ms: Long, val durMs: Double, val snrDb: Int,
    /** Sync symbols matched (of [PtcScanner.SYNC].length); a PTC burst matches at least 26. */
    val syncScore: Int,
    /** Symbols after the sync, in the sync's own labeling: 0 = +45°, 1 = +135°, 2 = -135°, 3 = -45°. */
    val payload: IntArray,
    /** Symbols in the whole burst. */
    val symbols: Int,
    /** The transmitter's carrier off its 12.5 kHz channel, Hz: each radio's own crystal, steady burst to burst. */
    val carrierHz: Double = 0.0,
) { val isPtc: Boolean get() = syncScore >= PtcScanner.MIN_SYNC }

/**
 * Watches a wide span for PTC bursts: an FFT every block finds bursts on any channel against a per-bin floor; when one
 * ends, its samples (kept in a ring) are mixed to DC, decimated to 8 samples a symbol, and demodulated as pi/4-DQPSK
 * at the clock phase with the cleanest constellation. The common sync word, matched in any rotation, says PTC.
 */
internal class PtcScanner(private val onBurst: (PtcBurst) -> Unit) {
    var centerOf: () -> Long = { 0L }
    var now: () -> Long = { System.currentTimeMillis() }
    private var rate = 0; private var nfft = 256
    private var re = FloatArray(1); private var im = FloatArray(1); private var win = FloatArray(1); private var floorP = FloatArray(1)
    /** Each bin's power over the last [AVG] blocks (a ring and its running sum): one block's noise is all over the place. */
    private var hist = Array(AVG) { FloatArray(1) }; private var sumP = FloatArray(1)
    /** Which 12.5 kHz slot each bin falls in (-1: off the band, on the spike at the center or at the span's edges), each
     *  slot's raster channel and bins, and each bin's frequency; worked out again when the tuning moves. */
    private var slotOf = IntArray(1); private var binFreq = DoubleArray(1); private var mapCenter = Long.MIN_VALUE
    private var slotCh = IntArray(0); private var slotLo = IntArray(0); private var slotHi = IntArray(0)
    private var slotP = DoubleArray(0); private var slotF = DoubleArray(0); private var slotFloor = DoubleArray(0)

    private fun mapSlots(center: Long) {
        mapCenter = center
        val binHz = rate.toDouble() / nfft
        slotOf = IntArray(nfft) { -1 }; binFreq = DoubleArray(nfft)
        val chs = ArrayList<Int>(); val los = ArrayList<Int>(); val his = ArrayList<Int>()
        for (b in 0 until nfft) {
            val off = (b - nfft / 2) * binHz
            val hz = center + off
            binFreq[b] = hz
            if (abs(off) < 12_000 || abs(off) > rate * 0.45 || hz < BAND_LO || hz > BAND_HI) continue
            val ch = (hz / 12_500).roundToInt()
            if (chs.isEmpty() || chs.last() != ch) { chs.add(ch); los.add(b); his.add(b) } else his[his.size - 1] = b
            slotOf[b] = chs.size - 1
        }
        slotCh = chs.toIntArray(); slotLo = los.toIntArray(); slotHi = his.toIntArray()
        slotP = DoubleArray(chs.size); slotF = DoubleArray(chs.size); slotFloor = DoubleArray(chs.size)
    }
    private var bufI = FloatArray(1); private var bufQ = FloatArray(1); private var fill = 0
    private var ringI = FloatArray(1); private var ringQ = FloatArray(1); private var abs0 = 0L
    private var blk = 0L
    /** A burst being heard: the raster slots it spans, its power-weighted frequency, its peak against the floor there. */
    private class Open(var startBlk: Long, var lastBlk: Long, var lo: Int, var hi: Int, var pw: Double = 0.0, var fw: Double = 0.0,
                       var peak: Double = 0.0, var peakFloor: Double = 1.0, var lit: Int = 0)
    /** Blocks averaged into the floor before anything is called a burst (one block's noise power is all over the place). */
    private var warm = 0
    private val open = ArrayList<Open>()
    private var ringAt = 0
    /** Bursts heard on the span that were not PTC, for the screen. */
    var others = 0; private set
    var bursts = 0; private set
    /** Debug: each burst's detection, for tests and tools. */
    var trace: ((String) -> Unit)? = null

    fun reset(rate: Int) {
        this.rate = rate
        nfft = Integer.highestOneBit(max(64, rate / 6000)) * 2
        if (nfft > 4096) nfft = 4096
        re = FloatArray(nfft); im = FloatArray(nfft); floorP = FloatArray(nfft)
        hist = Array(AVG) { FloatArray(nfft) }; sumP = FloatArray(nfft); mapCenter = Long.MIN_VALUE
        win = FloatArray(nfft) { (0.5 - 0.5 * cos(2 * PI * it / (nfft - 1))).toFloat() }
        bufI = FloatArray(nfft); bufQ = FloatArray(nfft); fill = 0
        val ring = max(nfft * 4, (rate * 0.09).toInt())
        ringI = FloatArray(ring); ringQ = FloatArray(ring); abs0 = 0; ringAt = 0
        blk = 0; open.clear(); warm = 0
    }

    fun push(xi: FloatArray, xq: FloatArray, n: Int) {
        val rl = ringI.size
        var ix = ringAt
        for (k in 0 until n) {
            ringI[ix] = xi[k]; ringQ[ix] = xq[k]
            if (++ix == rl) ix = 0
            bufI[fill] = xi[k]; bufQ[fill] = xq[k]
            if (++fill == nfft) { fill = 0; ringAt = ix; block(abs0 + k + 1) }
        }
        ringAt = ix
        abs0 += n
    }

    private fun block(endAbs: Long) {
        for (k in 0 until nfft) { re[k] = bufI[k] * win[k]; im[k] = bufQ[k] * win[k] }
        com.rocketgod.mayhem.core.Dsp.fft(re, im)
        val center = centerOf()
        if (center != mapCenter) mapSlots(center)
        // Each 12.5 kHz slot's power, summed over its bins and averaged over the last few blocks, against the same sum of
        // the bins' floors: a weak burst (an RTL-SDR on a short antenna) is a few dB over the noise in any one bin and
        // block, but clearly over it across its channel and a millisecond.
        val h = hist[(blk % AVG).toInt()]
        val ns = slotCh.size
        java.util.Arrays.fill(slotP, 0.0); java.util.Arrays.fill(slotF, 0.0); java.util.Arrays.fill(slotFloor, 0.0)
        val ready = blk >= AVG
        for (b in 0 until nfft) {
            val idx = (b + nfft / 2) % nfft
            val p = re[idx] * re[idx] + im[idx] * im[idx]
            sumP[b] += p - h[b]; h[b] = p
            if (!ready) continue
            val avg = sumP[b] / AVG
            if (warm < WARM) { floorP[b] += (avg - floorP[b]) / (warm + 1); continue }
            val sl = slotOf[b]
            if (sl < 0) continue
            slotP[sl] += avg; slotF[sl] += avg * binFreq[b]; slotFloor[sl] += floorP[b]
        }
        if (ready && warm < WARM) { warm++; blk++; return }
        if (!ready) { blk++; return }
        // lit slots: power, power x frequency, peak, the floor under the peak
        val seen = java.util.TreeMap<Int, DoubleArray>()
        for (sl in 0 until ns) {
            if (slotP[sl] <= 0) continue
            val active = slotP[sl] > slotFloor[sl] * THRESHOLD
            // the floor is a mean of the quiet blocks; a slot lit for long (a carrier, not a burst) joins it slowly
            // (by a fixed ratio: a step toward a burst's own power would swallow it within a few milliseconds)
            for (b in slotLo[sl]..slotHi[sl]) floorP[b] = if (active) floorP[b] * 1.003f else floorP[b] + 0.02f * (sumP[b] / AVG - floorP[b])
            if (active) seen[slotCh[sl]] = doubleArrayOf(slotP[sl], slotF[sl], slotP[sl], slotFloor[sl])
        }
        // runs of neighboring lit slots are one signal (a 9 kHz burst lights two or three 12.5 kHz slots); each run joins
        // the burst it overlaps, or starts one
        var runLo = Int.MIN_VALUE; var runHi = 0; val acc = DoubleArray(4)
        fun flush() {
            if (runLo == Int.MIN_VALUE) return
            val o = open.firstOrNull { runLo <= it.hi + 1 && runHi >= it.lo - 1 } ?: Open(blk, blk, runLo, runHi).also { open.add(it) }
            if (o.lastBlk != blk || o.lit == 0) o.lit++
            o.lastBlk = blk; o.lo = minOf(o.lo, runLo); o.hi = maxOf(o.hi, runHi)
            o.pw += acc[0]; o.fw += acc[1]
            if (acc[2] > o.peak) { o.peak = acc[2]; o.peakFloor = acc[3] }
            runLo = Int.MIN_VALUE; acc.fill(0.0)
        }
        for ((ch, a) in seen) {
            if (runLo != Int.MIN_VALUE && ch > runHi + 1) flush()
            if (runLo == Int.MIN_VALUE) runLo = ch
            runHi = ch
            acc[0] += a[0]; acc[1] += a[1]; if (a[2] > acc[2]) { acc[2] = a[2]; acc[3] = a[3] }
        }
        flush()
        val done = open.filter { blk - it.lastBlk >= 2 }
        for (o in done) {
            open.remove(o)
            val nb = o.lastBlk - o.startBlk + 1
            val dur = nb * nfft / rate.toDouble()
            if (dur < 0.006 || dur > 0.07) continue
            // a PTC channel is 25 kHz (two or three slots): wider and weak is noise lighting up, not a burst (a strong
            // burst's skirts light the slots around it, so width alone says nothing)
            if (o.hi - o.lo > 3 && o.peak < o.peakFloor * 100) continue
            // a burst is lit nearly all the way through; noise speckle that happens to chain up is not
            if (o.lit < nb * 0.7) continue
            // the averaging lights a burst up to AVG blocks late and holds it as long after: start that much earlier
            val startAbs = endAbs - (blk - o.startBlk + 1 + AVG) * nfft - (rate * 0.0007).toLong()
            val endBurst = endAbs - (blk - o.lastBlk) * nfft + (rate * 0.0007).toLong()
            if (endAbs - startAbs >= ringI.size) continue
            val hz = o.fw / o.pw
            trace?.invoke("burst %.4f MHz blocks %d lit %d dur %.1f ms slots %d..%d".format(hz / 1e6, nb, o.lit, dur * 1000, o.lo, o.hi))
            extract(startAbs, endBurst, hz, center, dur, (10 * kotlin.math.log10(o.peak / max(o.peakFloor, 1e-9))).roundToInt())
        }
        blk++
    }

    private fun extract(a: Long, b: Long, hz: Double, center: Long, dur: Double, snr: Int) {
        val n = (b - a).toInt(); if (n <= 0) return
        val xi = FloatArray(n); val xq = FloatArray(n); val rl = ringI.size
        for (k in 0 until n) { val ix = (((a + k) % rl + rl) % rl).toInt(); xi[k] = ringI[ix]; xq[k] = ringQ[ix] }
        // wide first (the coarse centroid can be a bin off), then the carrier measured and the channel cut tight
        val ddc = Ddc(14_000.0, 64_000.0, 63)
        ddc.reset(rate.toDouble()); ddc.offsetHz = hz - center
        val wi = FloatArray(ddc.maxOut(n)); val wq = FloatArray(wi.size)
        val m = ddc.push(xi, xq, n, wi, wq)
        val fs = ddc.outRate
        val fo = carrier(wi, wq, m, fs)
        val tight = Ddc(5_500.0, fs, 97)
        tight.reset(fs); tight.offsetHz = fo
        val oi = FloatArray(tight.maxOut(m)); val oq = FloatArray(oi.size)
        val k = tight.push(wi, wq, m, oi, oq)
        bursts++
        val f = hz + fo
        trace?.invoke("  in %d samples -> %d at %.0f Hz, carrier %+.0f Hz".format(n, k, tight.outRate, fo))
        val d = demod(oi, oq, k, tight.outRate)
        val burst = if (d == null) PtcBurst(snapHz(f), now(), dur * 1000, snr, 0, IntArray(0), 0, f - snapHz(f))
            else PtcBurst(snapHz(f), now(), dur * 1000, snr, d.first, d.second, d.third, f - snapHz(f))
        if (!burst.isPtc) others++
        onBurst(burst)
    }

    companion object {
        const val BAND_LO = 216_000_000.0
        const val BAND_HI = 222_500_000.0
        /** The sync word every station sends after its 9 preamble symbols (0 = +45°, 1 = +135°, 2 = -135°, 3 = -45°). */
        val SYNC = "020212232332130212131300131203".map { it - '0' }.toIntArray()
        /** Sync symbols that must match: a random burst matches about 8 of 30, and 22 is still out of its reach. */
        const val MIN_SYNC = 22
        private const val WARM = 8
        /** Blocks each bin is averaged over (about a millisecond at 2-8 Msps), and the slot's power over its floor to light. */
        private const val AVG = 4
        private const val THRESHOLD = 3.0

        /**
         * The burst's carrier offset from DC: the power-weighted mean of its spectrum (pi/4-DQPSK is symmetric about
         * its carrier), over the part of the burst that is on.
         */
        fun carrier(zi: FloatArray, zq: FloatArray, n: Int, fs: Double): Double {
            var nf = 256; while (nf < n && nf < 4096) nf *= 2
            val re = FloatArray(nf); val im = FloatArray(nf)
            for (k in 0 until min(n, nf)) { re[k] = zi[k]; im[k] = zq[k] }
            com.rocketgod.mayhem.core.Dsp.fft(re, im)
            var pw = 0.0; var fw = 0.0
            for (b in 0 until nf) {
                val f = (if (b < nf / 2) b else b - nf) * fs / nf
                if (abs(f) > 12_000) continue
                val p = (re[b] * re[b] + im[b] * im[b]).toDouble()
                pw += p; fw += p * f
            }
            return if (pw > 0) fw / pw else 0.0
        }

        /** Symbols as bits (Gray coded: +45° 00, +135° 01, -135° 11, -45° 10), packed into hex. */
        fun symHex(sym: IntArray, from: Int = 0, count: Int = sym.size - from): String {
            val sb = StringBuilder(); var acc = 0; var n = 0
            for (i in from until minOf(sym.size, from + count)) {
                acc = (acc shl 2) or when (sym[i] and 3) { 0 -> 0; 1 -> 1; 2 -> 3; else -> 2 }
                n += 2
                if (n == 8) { sb.append("%02X".format(acc)); acc = 0; n = 0 }
            }
            if (n > 0) sb.append("%02X".format(acc shl (8 - n)))
            return sb.toString()
        }

        /** On the 12.5 kHz raster. */
        fun snapHz(hz: Double): Long = ((hz / 12_500).roundToInt() * 12_500L)

        /**
         * pi/4-DQPSK at 8000 symbols/s from complex samples at [fs]: the clock phase with the tightest constellation,
         * the carrier's error off the 4th power, then the sync word searched in any rotation (and mirrored, for a radio
         * that swaps I and Q). Returns (sync symbols matched, payload, burst symbols).
         */
        fun demod(zi: FloatArray, zq: FloatArray, n: Int, fs: Double): Triple<Int, IntArray, Int>? {
            val sps = fs / 8000.0
            if (n < sps * 50) return null
            // trim to where the burst is on
            var pk = 0f; for (k in 0 until n) pk = max(pk, zi[k] * zi[k] + zq[k] * zq[k])
            var s0 = 0; while (s0 < n && zi[s0] * zi[s0] + zq[s0] * zq[s0] < pk * 0.05f) s0++
            var s1 = n - 1; while (s1 > s0 && zi[s1] * zi[s1] + zq[s1] * zq[s1] < pk * 0.05f) s1--
            var bestM = -1.0; var bestD: Pair<DoubleArray, DoubleArray>? = null
            for (ph in 0 until 8) {
                val t0 = s0 + ph * sps / 8
                val cnt = floor((s1 - t0) / sps).toInt()
                if (cnt < 40) continue
                val sr = DoubleArray(cnt); val si = DoubleArray(cnt)
                for (k in 0 until cnt) {
                    val t = t0 + k * sps; val i0 = t.toInt(); val fr = t - i0; val i1 = min(i0 + 1, n - 1)
                    sr[k] = zi[i0] * (1 - fr) + zi[i1] * fr; si[k] = zq[i0] * (1 - fr) + zq[i1] * fr
                }
                val dr = DoubleArray(cnt - 1); val di = DoubleArray(cnt - 1)
                var ar = 0.0; var aI = 0.0
                for (k in 1 until cnt) {
                    val r = sr[k] * sr[k - 1] + si[k] * si[k - 1]; val i = si[k] * sr[k - 1] - sr[k] * si[k - 1]
                    val mag = sqrt(r * r + i * i) + 1e-12
                    val ur = r / mag; val ui = i / mag
                    dr[k - 1] = ur; di[k - 1] = ui
                    // 4th power
                    val r2 = ur * ur - ui * ui; val i2 = 2 * ur * ui
                    ar += r2 * r2 - i2 * i2; aI += 2 * r2 * i2
                }
                val metric = sqrt(ar * ar + aI * aI) / (cnt - 1)
                if (metric > bestM) { bestM = metric; bestD = dr to di }
            }
            val (dr, di) = bestD ?: return null
            // d^4 of the ideal constellation is -1: the rest is the carrier's error
            var ar = 0.0; var aI = 0.0
            for (k in dr.indices) { val r2 = dr[k] * dr[k] - di[k] * di[k]; val i2 = 2 * dr[k] * di[k]; ar += r2 * r2 - i2 * i2; aI += 2 * r2 * i2 }
            val off = atan2(-aI, -ar) / 4
            val q = IntArray(dr.size) {
                var a = Math.toDegrees(atan2(di[it], dr[it]) - off)
                a = ((a + 540) % 360) - 180
                Math.floorMod(((a - 45) / 90).roundToInt(), 4)
            }
            var best = 0; var bo = 0; var bmir = false; var brot = 0
            for (mir in booleanArrayOf(false, true)) for (o in 0..min(60, q.size - SYNC.size)) for (rot in 0 until 4) {
                var c = 0
                for (i in SYNC.indices) { val v = if (mir) 3 - q[o + i] else q[o + i]; if ((v + rot) % 4 == SYNC[i]) c++ }
                if (c > best) { best = c; bo = o; bmir = mir; brot = rot }
            }
            val start = bo + SYNC.size
            val tail = max(0, q.size - start - 3)
            val payload = IntArray(tail) { val v = if (bmir) 3 - q[start + it] else q[start + it]; (v + brot) % 4 }
            return Triple(best, payload, q.size + 1)
        }
    }
}
