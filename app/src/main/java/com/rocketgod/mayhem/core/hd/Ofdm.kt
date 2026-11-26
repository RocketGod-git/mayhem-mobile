package com.rocketgod.mayhem.core.hd

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.math.sin

/**
 * NRSC-5 FM hybrid (MP1) Layer 1 receive front end, from SY_IDD_1011s rev H:
 *  - mix the station to 0 Hz, conjugate (14.2.2 up-converts with exp(-j2 pi fc t), so the RF spectrum is inverted
 *    against the subcarrier numbering), resample to 744187.5 Hz (3.5: 2048 points at 363.373 Hz spacing);
 *  - symbol timing and fractional carrier offset from the cyclic extension (13.2), on the primary sidebands only;
 *  - integer carrier offset from the DBPSK reference subcarriers (12.2.2, Table 12-24);
 *  - block sync and the system control word (11.2, 11.3, Table 11-1), BC and PSMI;
 *  - channel estimate from the known reference values (Table 12-18) and QPSK soft bits (Table 12-15) laid out as the
 *    512 x 720 PM matrix of one L1 frame.
 */
object HdOfdm {
    const val FS = 744_187.5
    const val NFFT = 2048; const val NCP = 112; const val NSYM = NFFT + NCP
    const val DF = FS / NFFT
    /** Subcarriers kept per symbol: -546..546. */
    const val NSC = 1093
    internal const val WIN_OFF = NCP shr 1

    /** MP1 reference subcarriers (Table 12-24) and their column of the reference matrix. */
    val REF_SC: IntArray; val REF_COL: IntArray
    /** The main sidebands' references come first; the extended partitions' (MP2, MP3, MP11) follow. */
    val NMAIN: Int
    init {
        val sc = ArrayList<Int>(); val col = ArrayList<Int>()
        var j = 0; var s = -546
        while (s <= -356) { sc.add(s); col.add(j); s += 19; j++ }
        j = 0; s = 356
        while (s <= 546) { sc.add(s); col.add(50 + j); s += 19; j++ }
        NMAIN = sc.size
        for (e in intArrayOf(-337, -318, 318, 337, -299, -280, 280, 299)) { sc.add(e); col.add(if (e < 0) (e + 546) / 19 else 50 + (e - 356) / 19) }
        REF_SC = sc.toIntArray(); REF_COL = col.toIntArray()
    }
    val NREF = REF_SC.size

    /** Extended partitions per sideband for a primary service mode indicator (Table 6-2): 0 MP1, 1 MP2, 2 MP3, 4 MP11. */
    fun extPartitions(psmi: Int): Int { val m = psmi and 3; return if (m == 2) 1 else if (m != 3) 0 else if ((psmi and 15) == 11) 4 else 2 }

    /** Table 11-1 fixed sync bits (bit number to value). */
    val SYNC_BITS = arrayOf(31 to 0, 30 to 1, 29 to 1, 28 to 0, 27 to 0, 26 to 1, 25 to 0, 22 to 1, 17 to 0, 10 to 1, 9 to 1)
    /** Table 11-3 reference subcarrier identification: [bit 21, bit 20] for a reference matrix column. */
    fun rsidForCol(c: Int): Pair<Int, Int> {
        val a = if (c <= 30) arrayOf(1 to 0, 0 to 1, 0 to 0, 1 to 1) else arrayOf(1 to 0, 1 to 1, 0 to 0, 0 to 1)
        return a[c % 4]
    }

    data class ScWord(val syncOk: Boolean, val p0: Boolean, val p1: Boolean, val p2: Boolean, val p3: Boolean, val bc: Int, val psmi: Int,
                      val sci: Int, val rsid: Int, val asm0: Int, val asm1: Int)
    /** b[0] is bit 31 (row 0 of the block) ... b[31] is bit 0. */
    fun decodeScWord(b: ByteArray): ScWord {
        fun bit(i: Int) = b[31 - i].toInt() and 1
        var psmi = 0; for (i in 0 until 6) psmi = psmi or (bit(1 + i) shl i)
        var p0 = 0; for (i in 0 until 9) p0 = p0 xor bit(i)
        return ScWord(
            syncOk = SYNC_BITS.all { (i, v) -> bit(i) == v },
            sci = bit(24), p3 = ((bit(24) + bit(23)) and 1) == 0,
            rsid = (bit(21) shl 1) or bit(20), asm1 = bit(19), p2 = ((bit(19) + bit(21) + bit(20) + bit(18)) and 1) == 0,
            bc = (bit(15) shl 3) or (bit(14) shl 2) or (bit(13) shl 1) or bit(12),
            p1 = ((bit(15) + bit(14) + bit(13) + bit(12) + bit(16) + bit(11)) and 1) == 0,
            asm0 = bit(8), psmi = psmi, p0 = p0 == 0,
        )
    }
}

/** Windowed-sinc polyphase resampler from any input rate to FS, complex. */
private class HdResampler {
    private var step = 1.0; private var taps = 0; private val P = 256
    private var table = FloatArray(0)
    private var inRe = FloatArray(0); private var inIm = FloatArray(0); private var inN = 0; private var t = 0.0
    var outRe = FloatArray(0); var outIm = FloatArray(0)
    fun configure(rate: Double) {
        step = rate / HdOfdm.FS
        // pass to 200 kHz, stop by 544 kHz (what folds back into the sidebands after resampling)
        val fc = 372_000 / rate; val trans = 344_000 / rate
        taps = max(8, 2 * ceil(5.5 / trans / 2).toInt())
        val T = taps
        table = FloatArray((P + 1) * T)
        for (p in 0..P) {
            val frac = p.toDouble() / P; var sum = 0.0
            val row = DoubleArray(T)
            for (m in 0 until T) {
                val x = frac - (m - T / 2 + 1)
                val sinc = if (x == 0.0) 2 * fc else sin(2 * PI * fc * x) / (PI * x)
                val u = x / T + 0.5
                val w = if (u <= 0 || u >= 1) 0.0 else 0.42 - 0.5 * cos(2 * PI * u) + 0.08 * cos(4 * PI * u)
                row[m] = sinc * w; sum += row[m]
            }
            for (m in 0 until T) table[p * T + m] = (row[m] / sum).toFloat()
        }
        inRe = FloatArray(1 shl 16); inIm = FloatArray(1 shl 16); inN = 0; t = (T / 2).toDouble()
    }
    /** Append input samples; returns how many outputs are in [outRe]/[outIm]. */
    fun push(re: FloatArray, im: FloatArray, n: Int): Int {
        if (inN + n > inRe.size) { val cap = max(inRe.size * 2, inN + n); inRe = inRe.copyOf(cap); inIm = inIm.copyOf(cap) }
        System.arraycopy(re, 0, inRe, inN, n); System.arraycopy(im, 0, inIm, inN, n); inN += n
        val need = ((inN + 2) / step).toInt() + 4
        if (outRe.size < need) { outRe = FloatArray(need); outIm = FloatArray(need) }
        val T = taps; val tab = table; val xr = inRe; val xi = inIm; val half = T / 2
        var tt = t; var o = 0
        while (floor(tt).toInt() + half < inN) {
            val i0 = floor(tt).toInt(); val p = ((tt - i0) * P).roundToInt(); val base = p * T; val j0 = i0 - half + 1
            var sr = 0f; var si = 0f
            for (m in 0 until T) { val h = tab[base + m]; sr += h * xr[j0 + m]; si += h * xi[j0 + m] }
            outRe[o] = sr; outIm[o] = si; o++
            tt += step
        }
        val drop = max(0, floor(tt).toInt() - half)
        if (drop > 0) { System.arraycopy(xr, drop, xr, 0, inN - drop); System.arraycopy(xi, drop, xi, 0, inN - drop); inN -= drop; tt -= drop }
        t = tt
        return o
    }
}

/** One L1 frame's demodulated content, ready for de-interleaving. */
class FrameSoft(
    /** 512 x 720 PM matrix of soft values, positive meaning 1. */
    val pm: FloatArray,
    /** 512 x (72 per extended partition pair) PX1 matrix (P3) in modes MP2, MP3 and MP11, else null. */
    val px: FloatArray?,
    /** 512 x 144 PX2 matrix (P4) in mode MP11, else null. */
    val px2: FloatArray?,
    val psmi: Int,
    /** Per-sideband SNR of the equalized data subcarriers, dB. */
    val snrLoDb: Double, val snrHiDb: Double,
    /** Absolute sample (at FS) where the frame starts. */
    val startSample: Double,
)

data class RxStatus(val state: String, val cfoHz: Double, val cpLock: Double, val blocks: Int, val blocksBad: Int, val psmi: Int, val bc: Int)

/**
 * Raw IQ in, L1 frames out. Push offset-128 IQ with [push]; each complete, block-synchronized L1 frame is handed to
 * [onFrame] as its PM soft matrix.
 */
class HdRx {
    var onFrame: (FrameSoft) -> Unit = {}
    private companion object {
        const val RING = 1 shl 19; const val RMASK = RING - 1L
        const val ACQ_N = 1 shl 17
        const val SYMS = 640
    }
    private val FS = HdOfdm.FS; private val NFFT = HdOfdm.NFFT; private val NCP = HdOfdm.NCP; private val NSYM = HdOfdm.NSYM
    private val NSC = HdOfdm.NSC; private val WIN_OFF = HdOfdm.WIN_OFF; private val REF_SC = HdOfdm.REF_SC; private val NREF = HdOfdm.NREF; private val NMAIN = HdOfdm.NMAIN
    private val PM_ROWS = HdFec.PM_ROWS; private val PM_COLS = HdFec.PM_COLS
    private val rs = HdResampler()
    private var rate = 0; private var offset = Double.NaN
    private var stepRe = 1.0; private var stepIm = 0.0; private var phRe = 1.0; private var phIm = 0.0; private var phN = 0
    private var dec = 1; private var decN = 0; private var accRe = 0.0; private var accIm = 0.0
    private var bufRe = FloatArray(0); private var bufIm = FloatArray(0)
    private val yRe = FloatArray(RING); private val yIm = FloatArray(RING)
    private var pos = 0L
    // acquisition
    private var state = "search"
    private var lastAcqAt = 0L; private var cpLock = 0.0
    private var cfo = 0.0; private var nextStart = 0.0; private var rot = 0.0
    private var timingAt = 0L; private var timingMiss = 0
    // symbols
    private val symRe = FloatArray(SYMS * NSC); private val symIm = FloatArray(SYMS * NSC)
    private var symN = 0
    private val symStart = DoubleArray(SYMS)
    private val refBits = ByteArray(SYMS * NREF); private val maj = ByteArray(SYMS)
    private val fre = FloatArray(NFFT); private val fim = FloatArray(NFFT)
    private val winPh = FloatArray(2 * NSC)
    // block sync
    private var blockPhase = -1; private var blockMiss = 0; private var blocks = 0; private var blocksBad = 0
    private var lastBc = -1; private var lastPsmi = -1
    private var frameStart = -1; private var frameBc = -1
    private val blockWords = ByteArray(16 * 32 * NREF)
    private val rsidVotes = IntArray(NREF * 3)
    private val colSc = HdFec.pmSc; private val colIq = HdFec.pmIq
    private val acqRe = FloatArray(ACQ_N); private val acqIm = FloatArray(ACQ_N)

    init {
        for (k in -546..546) { val a = -2 * PI * k * WIN_OFF / NFFT; winPh[2 * (k + 546)] = cos(a).toFloat(); winPh[2 * (k + 546) + 1] = sin(a).toFloat() }
    }

    /** The carrier error is given as on the air (the receiver works on the inverted spectrum). */
    val status: RxStatus get() = RxStatus(state, -cfo, cpLock, blocks, blocksBad, lastPsmi, lastBc)

    fun reset() {
        pos = 0; state = "search"; lastAcqAt = 0; cpLock = 0.0; cfo = 0.0; symN = 0
        blockPhase = -1; blockMiss = 0; frameStart = -1; frameBc = -1; lastBc = -1; lastPsmi = -1
        blocks = 0; blocksBad = 0; rsidVotes.fill(0); decN = 0; accRe = 0.0; accIm = 0.0
        phRe = 1.0; phIm = 0.0
    }

    /** Offset-128 IQ at [rate]; the station sits [offsetHz] from the span center. */
    fun push(iq: ByteArray, n: Int, rate: Int, offsetHz: Double) {
        if (rate != this.rate) {
            this.rate = rate; dec = if (rate > 3_300_000) max(1, (rate / 2_000_000.0).roundToInt()) else 1
            rs.configure(rate.toDouble() / dec); reset()
        }
        if (offsetHz != offset) { offset = offsetHz; val w = -2 * PI * offsetHz / rate; stepRe = cos(w); stepIm = sin(w) }
        if (bufRe.size < n) { bufRe = FloatArray(n); bufIm = FloatArray(n) }
        val br = bufRe; val bi = bufIm; val d = dec
        var m = 0
        var pr = phRe; var pi = phIm; val sr = stepRe; val si = stepIm
        for (k in 0 until n) {
            val a = ((iq[2 * k].toInt() and 0xff) - 127.5) / 128; val b = ((iq[2 * k + 1].toInt() and 0xff) - 127.5) / 128
            val xr = a * pr - b * pi; val xi = a * pi + b * pr
            val nr = pr * sr - pi * si; pi = pr * si + pi * sr; pr = nr
            if (++phN >= 4096) { phN = 0; val g = 1 / hypot(pr, pi); pr *= g; pi *= g }
            if (d == 1) { br[m] = xr.toFloat(); bi[m] = (-xi).toFloat(); m++ }
            else { accRe += xr; accIm += xi; if (++decN >= d) { br[m] = (accRe / d).toFloat(); bi[m] = (-accIm / d).toFloat(); m++; accRe = 0.0; accIm = 0.0; decN = 0 } }
        }
        phRe = pr; phIm = pi
        val k = rs.push(br, bi, m)
        val orr = rs.outRe; val oi = rs.outIm
        for (j in 0 until k) { val p = (pos and RMASK).toInt(); yRe[p] = orr[j]; yIm[p] = oi[j]; pos++ }
        advance()
    }

    /** Complex samples already at FS (test hook and the replay path). */
    fun pushFs(re: FloatArray, im: FloatArray, from: Int = 0, to: Int = re.size) {
        for (k in from until to) { val p = (pos and RMASK).toInt(); yRe[p] = re[k]; yIm[p] = im[k]; pos++ }
        advance()
    }

    private fun advance() {
        if (state == "search") {
            if (pos >= ACQ_N + NSYM && pos - lastAcqAt >= 2L * ACQ_N) { lastAcqAt = pos; acquire() }
            if (state == "search") return
        }
        // OFDM found but no block sync within three seconds: start over
        if (state == "ofdm" && symN > 3 * FS / NSYM) { state = "search"; return }
        while (pos >= nextStart.roundToLong() + WIN_OFF + NFFT + 8) {
            if (pos - nextStart > RING - 4 * NSYM) { state = "search"; return }
            symbol()
            if (state == "search") return
        }
        if (pos - timingAt > 3 * FS) { timingAt = pos; retime() }
    }

    private class Fold(val d0: Int, val c: Double, val lock: Double, val foff: Double)

    /** The cyclic-extension correlation of the last ACQ_N samples, sidebands only, folded by absolute symbol phase. */
    private fun cpFold(): Fold {
        val re = acqRe; val im = acqIm; val base = pos - ACQ_N
        for (k in 0 until ACQ_N) { val p = ((base + k) and RMASK).toInt(); re[k] = yRe[p]; im[k] = yIm[p] }
        Dsp.fft(re, im)
        val binHz = FS / ACQ_N
        for (k in 0 until ACQ_N) {
            val f = abs((if (k < ACQ_N / 2) k else k - ACQ_N) * binHz)
            if (f < 125_000 || f > 202_000) { re[k] = 0f; im[k] = 0f }
        }
        for (k in 0 until ACQ_N) im[k] = -im[k]
        Dsp.fft(re, im)
        for (k in 0 until ACQ_N) { re[k] /= ACQ_N; im[k] = -im[k] / ACQ_N }
        val fr = DoubleArray(NSYM); val fi = DoubleArray(NSYM)
        var sr = 0.0; var si = 0.0
        val lim = ACQ_N - NFFT
        val base0 = Math.floorMod(base, NSYM.toLong()).toInt()
        for (n in 0 until lim) {
            val pr = re[n].toDouble() * re[n + NFFT] + im[n].toDouble() * im[n + NFFT]; val pi = im[n].toDouble() * re[n + NFFT] - re[n].toDouble() * im[n + NFFT]
            sr += pr; si += pi
            if (n >= NCP) { val o = n - NCP; val qr = re[o].toDouble() * re[o + NFFT] + im[o].toDouble() * im[o + NFFT]; val qi = im[o].toDouble() * re[o + NFFT] - re[o].toDouble() * im[o + NFFT]; sr -= qr; si -= qi }
            if (n >= NCP - 1) { val d = (base0 + n - NCP + 1) % NSYM; fr[d] += sr; fi[d] += si }
        }
        var best = 0.0; var d0 = 0; var sum = 0.0
        for (d in 0 until NSYM) { val v = hypot(fr[d], fi[d]); sum += v; if (v > best) { best = v; d0 = d } }
        val foff = -atan2(fi[d0], fr[d0]) * FS / (2 * PI * NFFT)
        return Fold(d0, best, if (sum > 0) best / (sum / NSYM) else 0.0, foff)
    }

    private fun acquire() {
        val r = cpFold()
        cpLock = r.lock
        if (r.lock < 4.5) { state = "search"; return }
        cfo = r.foff
        // integer offset: the DBPSK reference subcarriers keep cos(2 dphi) near 1, QPSK data averages near 0
        val base = pos - ACQ_N
        val first = base + Math.floorMod(r.d0 - Math.floorMod(base, NSYM.toLong()), NSYM.toLong())
        val nsym = ((pos - first - NSYM) / NSYM).toInt()
        val scRe = DoubleArray(NFFT); val scIm = DoubleArray(NFFT)
        var pr: FloatArray? = null; var pi: FloatArray? = null
        for (s in 0 until nsym) {
            val st = first + s.toLong() * NSYM + WIN_OFF
            for (m in 0 until NFFT) {
                val p = ((st + m) and RMASK).toInt(); val a = -2 * PI * cfo * (st + m) / FS; val c = cos(a); val sn = sin(a)
                fre[m] = (yRe[p] * c - yIm[p] * sn).toFloat(); fim[m] = (yRe[p] * sn + yIm[p] * c).toFloat()
            }
            Dsp.fft(fre, fim)
            if (pr != null && pi != null) for (b in 0 until NFFT) {
                val dr = fre[b].toDouble() * pr[b] + fim[b].toDouble() * pi[b]; val di = fim[b].toDouble() * pr[b] - fre[b].toDouble() * pi[b]
                val m2 = dr * dr + di * di; if (m2 > 0) { scRe[b] += (dr * dr - di * di) / m2; scIm[b] += 2 * dr * di / m2 }
            }
            pr = fre.copyOf(); pi = fim.copyOf()
        }
        // a carrier s whole bins off turns by 2 pi s NSYM / NFFT from one symbol to the next: undo that per candidate
        var bestS = 0; var bestV = Double.NEGATIVE_INFINITY
        for (s in -40..40) {
            var vr = 0.0; var vi = 0.0; for (j in 0 until NMAIN) { val b = (REF_SC[j] + s + 2 * NFFT) % NFFT; vr += scRe[b]; vi += scIm[b] }
            val a = -4 * PI * s * NSYM / NFFT; val v = vr * cos(a) - vi * sin(a)
            if (v > bestV) { bestV = v; bestS = s }
        }
        cfo += bestS * HdOfdm.DF
        state = "ofdm"
        // start on the first whole symbol of the acquisition window, so sync can be found from data already here
        nextStart = first.toDouble(); rot = 0.0; symN = 0; blockPhase = -1; frameStart = -1
        timingAt = pos
    }

    /** Every few seconds: compare the tracked symbol timing with the cyclic extension and pull it back on. */
    private fun retime() {
        if (pos < ACQ_N) return
        val r = cpFold()
        cpLock = r.lock
        if (r.lock < 4.5) { if (++timingMiss >= 3) { state = "search"; timingMiss = 0 }; return }
        val cur = Math.floorMod(nextStart.roundToLong(), NSYM.toLong()).toInt()
        var delta = r.d0 - cur; if (delta > NSYM / 2) delta -= NSYM; if (delta < -NSYM / 2) delta += NSYM
        if (abs(delta) <= 60) { timingMiss = 0; if (abs(delta) >= 2) { nextStart += delta; shiftHeld(delta) } }
        else if (++timingMiss >= 3) { state = "search"; timingMiss = 0 }
    }

    /**
     * The symbol window moved by [delta] samples: turn the symbols already held by the matching phase slope, as if
     * they had been taken with the new timing, so the differential reference and the frame's channel estimate do not
     * see a step across the subcarriers.
     */
    private fun shiftHeld(delta: Int) {
        for (k in -546..546) {
            val a = 2 * PI * k * delta / NFFT; val c = cos(a).toFloat(); val s = sin(a).toFloat(); val i = k + 546
            var off = i
            for (slot in 0 until SYMS) { val r = symRe[off]; val q = symIm[off]; symRe[off] = r * c - q * s; symIm[off] = r * s + q * c; off += NSC }
        }
    }

    private fun symbol() {
        val S = nextStart.roundToLong(); val st = S + WIN_OFF
        val w = -2 * PI * cfo / FS
        val ph = rot + w * WIN_OFF
        var cr = cos(ph); var ci = sin(ph)
        val sr = cos(w); val si = sin(w)
        for (m in 0 until NFFT) {
            val p = ((st + m) and RMASK).toInt(); val xr = yRe[p]; val xi = yIm[p]
            fre[m] = (xr * cr - xi * ci).toFloat(); fim[m] = (xr * ci + xi * cr).toFloat()
            val nr = cr * sr - ci * si; ci = cr * si + ci * sr; cr = nr
        }
        Dsp.fft(fre, fim)
        val slot = symN % SYMS; val off = slot * NSC
        for (k in -546..546) {
            val b = (k + NFFT) % NFFT; val i = k + 546; val c = winPh[2 * i]; val s = winPh[2 * i + 1]
            symRe[off + i] = fre[b] * c - fim[b] * s; symIm[off + i] = fre[b] * s + fim[b] * c
        }
        symStart[slot] = S.toDouble()
        // reference bits, differential against the previous symbol, plus the residual carrier offset they show
        if (symN > 0) {
            val prev = ((symN - 1) % SYMS) * NSC
            var n = 0; var qr = 0.0; var qi = 0.0
            for (j in 0 until NREF) {
                val i = REF_SC[j] + 546; val ar = symRe[off + i].toDouble(); val ai = symIm[off + i].toDouble(); val br = symRe[prev + i].toDouble(); val bi = symIm[prev + i].toDouble()
                val dr = ar * br + ai * bi; val di = ai * br - ar * bi
                val bit = if (dr < 0) 1 else 0; refBits[slot * NREF + j] = bit.toByte()
                if (j >= NMAIN) continue
                n += bit
                val mm = hypot(dr, di).let { if (it == 0.0) 1.0 else it }; qr += (dr * dr - di * di) / mm; qi += 2 * dr * di / mm
            }
            maj[slot] = if (n * 2 > NMAIN) 1 else 0
            val dphi = atan2(qi, qr) / 2
            cfo += 0.02 * dphi / (2 * PI * NSYM / FS)
        }
        rot += w * NSYM; rot %= 2 * PI
        nextStart += NSYM
        symN++
        blockSync()
    }

    private fun blockSync() {
        val n = symN
        if (blockPhase < 0) {
            if (n < 97 || n % 32 != 0) return
            var bestP = -1; var bestV = -1.0
            val from = n - minOf(n - 1, 4 * 32)
            for (p in 0 until 32) {
                var v = 0; var cnt = 0
                var st = from + Math.floorMod(p - from, 32)
                while (st + 32 <= n) {
                    cnt++
                    for ((b, value) in HdOfdm.SYNC_BITS) if (maj[(st + 31 - b) % SYMS].toInt() == value) v++
                    st += 32
                }
                if (cnt > 0 && v.toDouble() / cnt > bestV) { bestV = v.toDouble() / cnt; bestP = p }
            }
            if (bestV >= HdOfdm.SYNC_BITS.size - 1) {
                blockPhase = bestP; state = "sync"; blockMiss = 0; frameStart = -1
                // the blocks already in hand, oldest first: a frame that began before sync is not lost
                var st = from + Math.floorMod(bestP - from, 32)
                while (st + 32 <= n) { if (st >= 1 && blockPhase >= 0) decodeBlock(st); st += 32 }
            }
            return
        }
        if ((n - blockPhase) % 32 != 0) return
        val st = n - 32
        if (st < 1) return
        decodeBlock(st)
    }

    /** The system control word of the block starting at symbol [st], then frame tracking. */
    private fun decodeBlock(st: Int) {
        // decode the block's system control word on every reference subcarrier
        val words = arrayOfNulls<HdOfdm.ScWord>(NREF)
        val good = ArrayList<Int>()
        val bits = ByteArray(32)
        for (j in 0 until NREF) {
            for (r in 0 until 32) bits[r] = refBits[((st + r) % SYMS) * NREF + j]
            val w = HdOfdm.decodeScWord(bits); words[j] = w
            if (w.syncOk && w.p0 && w.p1) good.add(j)
        }
        blocks++
        if (good.isEmpty()) {
            blocksBad++
            if (++blockMiss >= 3) { blockPhase = -1; state = "ofdm"; frameStart = -1 }
            return
        }
        blockMiss = 0
        fun vote(f: (HdOfdm.ScWord) -> Int): Int {
            val c = LinkedHashMap<Int, Int>(); for (j in good) { val v = f(words[j]!!); c[v] = (c[v] ?: 0) + 1 }
            var b = 0; var bn = -1; for ((v, k) in c) if (k > bn) { bn = k; b = v }; return b
        }
        val bc = vote { it.bc }; val psmi = vote { it.psmi }
        lastBc = bc; lastPsmi = psmi
        if (state == "sync" || state == "frames") state = if (frameStart >= 0 || state == "frames") "frames" else "sync"
        // the clean word per subcarrier: the majority, with each subcarrier's own identification bits
        val cons = ByteArray(32)
        for (r in 0 until 32) { var c = 0; for (j in good) c += refBits[((st + r) % SYMS) * NREF + j]; cons[r] = if (c * 2 > good.size) 1 else 0 }
        cons[0] = 0
        val slotWords = bc * 32 * NREF
        for (j in 0 until NREF) {
            val wj = words[j]!!
            val own = wj.syncOk && wj.p0 && wj.p1 && wj.p2
            if (own) {
                for ((k, b) in arrayOf(0 to 21, 1 to 20, 2 to 18)) rsidVotes[j * 3 + k] += if (refBits[((st + 31 - b) % SYMS) * NREF + j].toInt() != 0) 1 else -1
            }
            for (r in 0 until 32) {
                var v = if (own) refBits[((st + r) % SYMS) * NREF + j] else cons[r]
                if (!own) {
                    val bit = 31 - r; val k = if (bit == 21) 0 else if (bit == 20) 1 else if (bit == 18) 2 else -1
                    if (k >= 0 && rsidVotes[j * 3 + k] != 0) v = if (rsidVotes[j * 3 + k] > 0) 1 else 0
                }
                blockWords[slotWords + r * NREF + j] = if (r == 0) 0 else v
            }
        }
        // frame tracking: BC 0 opens a frame, 1..15 must follow in order
        if (bc == 0) { frameStart = st; frameBc = 0; state = "frames" }
        else if (frameStart >= 0) {
            if (bc != frameBc + 1) { frameStart = -1; return }
            frameBc = bc
            if (bc == 15) { val fs = frameStart; frameStart = -1; emitFrame(fs) }
        }
    }

    /** Channel estimate from the pilots, then the PM matrix of soft values. */
    private fun emitFrame(fs: Int) {
        if (symN - fs > SYMS) return
        // pilots: Href[sym][j] = X / R, R from the differentially encoded block word
        val H = FloatArray(PM_ROWS * NREF * 2)
        for (blk in 0 until 16) for (j in 0 until NREF) {
            var R = 0
            for (r in 0 until 32) {
                R = R xor blockWords[blk * 32 * NREF + r * NREF + j].toInt()
                val n = blk * 32 + r; val off = ((fs + n) % SYMS) * NSC + REF_SC[j] + 546
                val s = if (R != 0) 1 else -1                          // R = 1 -> +1+j, 0 -> -1-j; X / (s(1+j)) = X (1-j) s / 2
                val xr = symRe[off]; val xi = symIm[off]
                H[(n * NREF + j) * 2] = s * (xr + xi) / 2; H[(n * NREF + j) * 2 + 1] = s * (xi - xr) / 2
            }
        }
        // smooth over five symbols
        val Hs = FloatArray(H.size)
        for (n in 0 until PM_ROWS) for (j in 0 until NREF) {
            var r = 0f; var i = 0f; var c = 0
            for (d in -2..2) { val m = n + d; if (m < 0 || m >= PM_ROWS) continue; r += H[(m * NREF + j) * 2]; i += H[(m * NREF + j) * 2 + 1]; c++ }
            Hs[(n * NREF + j) * 2] = r / c; Hs[(n * NREF + j) * 2 + 1] = i / c
        }
        // interpolate magnitude and unwrapped phase across each sideband, then soft bits
        val pm = FloatArray(PM_ROWS * PM_COLS)
        val hr = FloatArray(NSC); val hi = FloatArray(NSC)
        val mag = DoubleArray(NREF); val ph = DoubleArray(NREF)
        // references in frequency order per sideband, the extended ones only where the mode lights them
        val ext = HdOfdm.extPartitions(lastPsmi); val N = NMAIN
        val chains = arrayOf(
            IntArray(11) { it } + intArrayOf(N, N + 1, N + 4, N + 5).copyOfRange(0, ext),
            intArrayOf(N + 6, N + 7, N + 2, N + 3).copyOfRange(4 - ext, 4) + IntArray(11) { 11 + it },
        )
        val pxCols = if (ext != 0) HdP3.pxColumns(minOf(ext, 2)) else null; val px = pxCols?.let { FloatArray(PM_ROWS * it.sc.size) }
        val px2Cols = if (ext == 4) HdP3.px2Columns() else null; val px2 = px2Cols?.let { FloatArray(PM_ROWS * it.sc.size) }
        var eLo = 0.0; var vLo = 0.0; var nLo = 0; var eHi = 0.0; var vHi = 0.0; var nHi = 0
        for (n in 0 until PM_ROWS) {
            for (j in 0 until NREF) { val r = Hs[(n * NREF + j) * 2].toDouble(); val i = Hs[(n * NREF + j) * 2 + 1].toDouble(); mag[j] = hypot(r, i); ph[j] = atan2(i, r) }
            for (ch in chains) {
                for (q in 1 until ch.size) { val j = ch[q]; var d = ph[j] - ph[ch[q - 1]]; while (d > PI) { ph[j] -= 2 * PI; d -= 2 * PI }; while (d < -PI) { ph[j] += 2 * PI; d += 2 * PI } }
                for (q in 0 until ch.size - 1) {
                    val j0 = ch[q]; val j1 = ch[q + 1]; val k0 = REF_SC[j0]; val k1 = REF_SC[j1]
                    for (k in k0..k1) {
                        val t = (k - k0).toDouble() / (k1 - k0); val m = mag[j0] + t * (mag[j1] - mag[j0]); val p = ph[j0] + t * (ph[j1] - ph[j0])
                        hr[k + 546] = (m * cos(p)).toFloat(); hi[k + 546] = (m * sin(p)).toFloat()
                    }
                }
            }
            val off = ((fs + n) % SYMS) * NSC
            for (c in 0 until PM_COLS) {
                val k = colSc[c] + 546; val xr = symRe[off + k]; val xi = symIm[off + k]; val a = hr[k]; val b = hi[k]
                val zr = xr * a + xi * b; val zi = xi * a - xr * b            // X conj(H)
                val v = if (colIq[c] != 0) zi else zr
                pm[n * PM_COLS + c] = v
                val h2 = (a * a + b * b).toDouble(); if (h2 <= 0) continue
                val e = abs(v) / h2                                             // equalized amplitude on this rail
                if (k < 546) { eLo += e; vLo += e * e; nLo++ } else { eHi += e; vHi += e * e; nHi++ }
            }
            for ((m, cs) in arrayOf(px to pxCols, px2 to px2Cols)) if (m != null && cs != null) for (c in cs.sc.indices) {
                val k = cs.sc[c] + 546; val xr = symRe[off + k]; val xi = symIm[off + k]; val a = hr[k]; val b = hi[k]
                m[n * cs.sc.size + c] = if (cs.iq[c] != 0) xi * a - xr * b else xr * a + xi * b
            }
        }
        fun snr(s: Double, s2: Double, n: Int): Double { if (n == 0) return -99.0; val m = s / n; val v = s2 / n - m * m; return 10 * log10(m * m / max(v, 1e-9)) }
        onFrame(FrameSoft(pm, px, px2, lastPsmi, snr(eLo, vLo, nLo), snr(eHi, vHi, nHi), symStart[fs % SYMS]))
    }
}
