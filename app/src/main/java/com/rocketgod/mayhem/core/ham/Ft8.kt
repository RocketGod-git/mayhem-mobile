package com.rocketgod.mayhem.core.ham

import java.math.BigInteger
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * FT8 decoder and encoder. Twin of web/src/dsp/ham/ft8.ts and ft8-encode.ts: the same steps in the same order, so
 * both decode the same audio to the same messages. 48 kHz audio is resampled to 12.8 kHz and cut into 15 s UTC
 * slots, each decoded in up to three passes:
 *  1. a half-symbol-step 4096-point Hann FFT with half-tone (3.125 Hz) bins builds the log-power waterfall, and the
 *     three 7-symbol Costas arrays are searched across time and frequency; each local peak of the sync score is a
 *     candidate (the search follows the approach in ft8_lib by Kārlis Goba, MIT);
 *  2. each candidate is mixed down to a 200 Hz complex baseband cut from one FFT of the whole slot, its start and
 *     frequency are refined against the Costas tones (5 ms, 0.125 Hz), and its 79 symbols are measured on their
 *     exact tones; the 58 data symbols give 174 soft bits, one symbol at a time (noncoherent) and three at a time
 *     (coherent: the tones keep their phase from symbol to symbol);
 *  3. LDPC(174,91) is decoded by belief propagation and, when that comes close, by ordered-statistics decoding; the
 *     CRC-14 is checked, and an OSD result must also sit close to the received bits and unpack to a plausible
 *     standard message;
 *  4. each decode is rebuilt (GFSK, BT 2), its amplitude and phase followed along the slot, and subtracted from the
 *     audio, so the next pass finds the weaker signals underneath. A pass that finds nothing new ends the slot.
 * Then the a-priori stage: a station heard in a recent slot of the same parity is looked for again near its
 * frequency with its two call fields pinned, and the rest of its message decoded from the signal.
 * The 77-bit payload is unpacked (standard, DXpedition, non-standard, free text, telemetry, RTTY contest) with a
 * callsign hash table for the <...> references.
 *
 * The slot decode runs on its own thread: a busy band is a few hundred milliseconds of work, which would
 * otherwise stall the IQ stream it was fed from.
 */

// 12.8 kHz: a symbol is exactly 2048 samples, so the half-symbol-step 4096-point FFT has bins of half a tone.
private const val FS = 12_800
private const val SYMBOL = 0.16
private const val BLOCK = 2048
private const val TIME_OSR = 2
private const val FREQ_OSR = 2
private const val NFFT = BLOCK * FREQ_OSR
private const val SUBBLOCK = BLOCK / TIME_OSR
private const val TONE_HZ = 1 / SYMBOL
private const val FMIN = 200.0
private const val FMAX = 3000.0
private val BIN_MIN = (FMIN / TONE_HZ).roundToInt()
private val NUM_BINS = ((FMAX - FMIN) / TONE_HZ).roundToInt()
private const val SLOT_S = 15
private const val NUM_BLOCKS = 93
private val BLOCK_STRIDE = TIME_OSR * FREQ_OSR * NUM_BINS
private const val ND = 58
private const val N = 174
private const val K = 91
private const val M = 83
private const val CRC_POLY = 0x2757
private const val NTOKENS = 2063592
private const val MAX22 = 4194304
private const val MAXGRID4 = 32400
// the candidate grid: start in half symbols from -20 (-1.6 s) to 39, tone 0 in half tones
private const val T_MIN = -20
private const val T_NUM = 60
private val F_NUM = 2 * (NUM_BINS - 7)
// the baseband: 200 Hz complex, 32 samples a symbol, cut from a 2^18-point FFT of the slot (0.049 Hz bins)
private const val BB_RATE = 200
private const val BB_SPS = 32
private const val NBIG = 1 shl 18
private const val NBB = NBIG * BB_RATE / FS
private const val BIG_HZ = FS.toDouble() / NBIG
// passband kept around tone 0 (Hz): flat over the eight tones and their skirts, a cosine taper outside
private const val BB_LO = -35.0
private const val BB_FLAT_LO = -10.0
private const val BB_FLAT_HI = 53.75
private const val BB_HI = 78.75
private const val BB_FROM = -16
private const val BB_SPAN = 79 * BB_SPS + 32           // refined starts within ±12 samples of the coarse one
private const val PASSES = 3
private val MAX_CANDS = intArrayOf(150, 100, 60)
private const val MIN_SYNC = 2.5
private const val BP_ITERS = 30
private const val LLR_VAR = 24.0
// OSD safeguards: a candidate's BP must have come this close, and the OSD codeword must disagree with at most this
// many hard decisions and a weighted distance at most this share of the total reliability
private const val OSD_MAX_BP_ERRORS = 20
private const val OSD_ORDER2 = 40
private const val OSD_MAX_FLIPS = 40
private const val OSD_MAX_DIST = 0.048
// subtraction: amplitude and phase averaged over one symbol
private const val SUB_WIN = BLOCK
// a candidate this close to a decode (Hz, s) is that decode again
private const val SKIP_HZ = 1.6
private const val SKIP_S = 0.06
// a-priori: a station decoded within the last two minutes in a slot of the same parity is looked for again
private const val AP_WINDOW_MS = 120_000L
private const val AP_MAX_DIST = 0.13
private const val AP_T_LO = -200
private const val AP_T_HI = 500
private const val AP_PIN = 30.0
private const val AP_SPAN = AP_T_HI - AP_T_LO + 79 * BB_SPS + 2
/** The known bits of a standard message: both call fields (with their /R or /P flags) and i3. */
private val AP_KNOWN = IntArray(77) { if (it < 58 || it >= 74) 1 else 0 }
/** The symbols those bits fix: the three sync arrays and data symbols 0-18 (bits 0-56). */
private val AP_SYMS = (IntArray(7) { it } + IntArray(7) { 36 + it } + IntArray(7) { 72 + it } + IntArray(19) { 7 + it }).sortedArray()

/** [ap]: found by the a-priori stage (its call fields pinned from a recent slot), not from the signal alone. */
data class Ft8Decode(val utc: String, val snr: Int, val dt: Double, val hz: Int, val text: String, val ap: Boolean = false)

/** Switches for the tests: passes, ordered-statistics decoding, subtraction, the a-priori stage. */
object Ft8Options { @JvmField var passes = PASSES; @JvmField var osd = true; @JvmField var subtract = true; @JvmField var ap = true }

class Ft8Decoder : DigitalDecoder {
    override val name = "FT8"
    @Volatile override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    /** Called from the decode thread with each slot's results, best SNR first. */
    var onDecodes: (List<Ft8Decode>, Long) -> Unit = { _, _ -> }

    private val ring = FloatArray(FS * 17)
    private var wpos = 0
    private var total = 0L
    private val rs = SincResampler(48_000.0, FS.toDouble(), 1, 48)
    private val rsIn = FloatArray(4096)
    private val rsOut = FloatArray(4096)
    private var t0 = 0.0
    private var lastSlot = -1L
    @Volatile private var slotBusy = false
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "ft8").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } }

    // decode-thread state
    private val mag = DoubleArray(NUM_BLOCKS * BLOCK_STRIDE)
    private val win = DoubleArray(NFFT) { 0.5 - 0.5 * cos(2 * PI * it / NFFT) }
    private val fftWf = Ft8Fft(NFFT)
    private val fftBig = Ft8Fft(NBIG)
    private val fftBb = Ft8Fft(NBB)
    private val re = DoubleArray(NFFT)
    private val im = DoubleArray(NFFT)
    private val bigRe = DoubleArray(NBIG)
    private val bigIm = DoubleArray(NBIG)
    private val bbRe = DoubleArray(NBB)
    private val bbIm = DoubleArray(NBB)
    private val zRe = DoubleArray(BB_SPAN)
    private val zIm = DoubleArray(BB_SPAN)
    private val pw = DoubleArray(79 * 8)
    private val cxr = DoubleArray(79 * 8)
    private val cxi = DoubleArray(79 * 8)
    private val cosT = DoubleArray(8 * BB_SPS) { cos(2 * PI * (it / BB_SPS) * (it % BB_SPS) / BB_SPS) }
    private val sinT = DoubleArray(8 * BB_SPS) { sin(2 * PI * (it / BB_SPS) * (it % BB_SPS) / BB_SPS) }
    private val taper = DoubleArray(NBB) {
        val hz = (if (it < NBB / 2) it else it - NBB) * BIG_HZ
        when {
            hz < BB_LO || hz > BB_HI -> 0.0
            hz < BB_FLAT_LO -> 0.5 - 0.5 * cos(PI * (hz - BB_LO) / (BB_FLAT_LO - BB_LO))
            hz > BB_FLAT_HI -> 0.5 + 0.5 * cos(PI * (hz - BB_FLAT_HI) / (BB_HI - BB_FLAT_HI))
            else -> 1.0
        }
    }
    private val pulse = gfskPulse()
    /** The slot being decoded, less what has been decoded so far. */
    private val x = DoubleArray(FS * SLOT_S)
    private val subRe = DoubleArray(79 * BLOCK)
    private val subIm = DoubleArray(79 * BLOCK)
    private val cumRe = DoubleArray(79 * BLOCK + 1)
    private val cumIm = DoubleArray(79 * BLOCK + 1)
    private val scores = DoubleArray(T_NUM * F_NUM)
    private val apRe = DoubleArray(AP_SPAN)
    private val apIm = DoubleArray(AP_SPAN)
    private val apPw = DoubleArray(8 * AP_SPAN)
    private val hashes = HashMap<Int, String>()
    private var pending = ArrayList<String>()
    private val history = ArrayList<Heard>()
    private var lastRe = 0.0
    private var lastIm = 0.0

    private class Cand(val t: Int, val f: Int, val score: Double)
    private class Found(val text: String, val snr: Int, val hz: Double, val t: Double, val tones: IntArray, val ap: Boolean, val bits: IntArray)
    private class Heard(val text: String, val tones: IntArray, val bits: IntArray, val hz: Double, val slot: Long)

    override fun reset() { wpos = 0; total = 0; rs.reset(); lastSlot = -1; confidence = 0f; t0 = 0.0 }

    override fun push(audio: FloatArray, n: Int) {
        var i = 0
        while (i < n) {
            val k = min(n - i, rsIn.size)
            System.arraycopy(audio, i, rsIn, 0, k)
            val o = rs.process(rsIn, k, rsOut)
            for (j in 0 until o) { ring[wpos] = rsOut[j]; wpos = (wpos + 1) % ring.size; total++ }
            i += k
        }
        // keep the wall clock of the stream: sample `total` was written now
        val now = System.currentTimeMillis()
        val est = now - total * 1000.0 / FS
        t0 = if (t0 == 0.0) est else t0 + 0.05 * (est - t0)
        val slot = now / (SLOT_S * 1000L)
        // decode the previous slot once we are 0.3 s into the next one (transmissions end at 13.2 s)
        if (slot != lastSlot && now - slot * SLOT_S * 1000 > 300 && total > FS * SLOT_S && !slotBusy) {
            lastSlot = slot
            val slotStart = (slot - 1) * SLOT_S * 1000
            val start = ((slotStart - t0) / 1000 * FS).roundToInt().toLong()
            if (start < total - ring.size || start + FS * SLOT_S > total) return
            val buf = FloatArray(FS * SLOT_S)
            val l = ring.size
            for (j in buf.indices) { val s = start + j; buf[j] = if (s >= 0) ring[(s % l).toInt()] else 0f }
            slotBusy = true
            worker.execute {
                try {
                    val results = decodeBuffer(buf, slotStart)
                    confidence = if (results.isNotEmpty()) 1f else max(0f, confidence - 0.3f)
                    for (r in results) onText("%s %3d %4.1f %4d ~  %s\n".format(r.utc, r.snr, r.dt, r.hz, r.text), "FT8")
                    onDecodes(results, slotStart)
                } catch (_: Throwable) {
                } finally { slotBusy = false }
            }
        }
    }

    /** Decode one 15 s slot of 12.8 kHz audio. */
    fun decodeBuffer(buf: FloatArray, slotStartMs: Long = 0): List<Ft8Decode> {
        val nb = min(buf.size, x.size)
        for (i in x.indices) x[i] = if (i < nb) buf[i].toDouble() else 0.0
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = slotStartMs }
        val utc = "%02d%02d%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND))
        val found = ArrayList<Found>()
        val texts = HashSet<String>()
        val o = Ft8Options
        for (pass in 0 until o.passes) {
            buildWaterfall()
            val cands = findCandidates(MAX_CANDS[min(pass, MAX_CANDS.size - 1)], MIN_SYNC)
            spectrum()
            var added = 0
            for (cd in cands) {
                // the 2-symbol waterfall window is centered half a symbol after its start
                val tc = (cd.t.toDouble() / TIME_OSR + 0.5) * SYMBOL
                val fc = (BIN_MIN + cd.f.toDouble() / FREQ_OSR) * TONE_HZ
                // a spot an earlier decode already explains
                if (found.any { abs(it.hz - fc) < SKIP_HZ && abs(it.t - tc) < SKIP_S }) continue
                val r = decodeCandidate(tc, fc) ?: continue
                if (!texts.add(r.text)) continue
                for (call in pending) save(call)
                found += r; added++
                if (o.subtract && (pass + 1 < o.passes || o.ap)) subtract(r)
            }
            if (added == 0) break
        }
        if (o.ap) apStage(found, texts, slotStartMs)
        // remember this slot's messages for the next slots
        val keep = history.filter { it.slot < slotStartMs && slotStartMs - it.slot <= AP_WINDOW_MS && it.text !in texts }
        history.clear(); history.addAll(keep)
        for (r in found) if (!r.ap && isStd(r.bits)) history += Heard(r.text, r.tones, r.bits, r.hz, slotStartMs)
        val results = found.map { Ft8Decode(utc, it.snr, jsRound((it.t - 0.5) * 10) / 10.0, jsRound(it.hz).toInt(), it.text, it.ap) }
        return results.sortedWith(Comparator { a, b ->
            if (a.snr != b.snr) b.snr - a.snr else if (a.hz != b.hz) a.hz - b.hz else a.text.compareTo(b.text)
        })
    }

    private fun buildWaterfall() {
        val l = x.size
        for (blk in 0 until NUM_BLOCKS) {
            for (ts in 0 until TIME_OSR) {
                val off = blk * BLOCK + ts * SUBBLOCK
                for (i in 0 until NFFT) { val s = off + i; re[i] = if (s < l) x[s] * win[i] else 0.0; im[i] = 0.0 }
                fftWf.run(re, im, false)
                for (fs in 0 until FREQ_OSR) {
                    val base = ((blk * TIME_OSR + ts) * FREQ_OSR + fs) * NUM_BINS
                    for (b in 0 until NUM_BINS) {
                        val src = (BIN_MIN + b) * FREQ_OSR + fs
                        val p = re[src] * re[src] + im[src] * im[src]
                        mag[base + b] = 10 * log10(p + 1e-12)
                    }
                }
            }
        }
    }

    /** Costas sync score (mean dB of each sync tone over its neighbors in time and frequency) at half-symbol start t, half-tone f. */
    private fun syncScore(t: Int, f: Int): Double {
        val timeOffset = Math.floorDiv(t, TIME_OSR); val timeSub = t - timeOffset * TIME_OSR
        val freqOffset = f shr 1; val freqSub = f and 1
        val base = ((timeOffset * TIME_OSR + timeSub) * FREQ_OSR + freqSub) * NUM_BINS + freqOffset
        var score = 0.0; var num = 0
        for (m in 0 until 3) for (k in 0 until 7) {
            val block = 36 * m + k; val blockAbs = timeOffset + block
            if (blockAbs < 0) continue
            if (blockAbs >= NUM_BLOCKS) break
            val p = base + block * BLOCK_STRIDE; val sm = FT8_COSTAS[k]
            val v = mag[p + sm]
            if (sm > 0) { score += v - mag[p + sm - 1]; num++ }
            if (sm < 7) { score += v - mag[p + sm + 1]; num++ }
            if (k > 0 && blockAbs > 0) { score += v - mag[p + sm - BLOCK_STRIDE]; num++ }
            if (k + 1 < 7 && blockAbs + 1 < NUM_BLOCKS) { score += v - mag[p + sm + BLOCK_STRIDE]; num++ }
        }
        return if (num > 0) score / num else 0.0
    }

    /** The strongest local peaks of the sync score. */
    private fun findCandidates(maxN: Int, minScore: Double): List<Cand> {
        val sc = scores
        for (ti in 0 until T_NUM) for (f in 0 until F_NUM) sc[ti * F_NUM + f] = syncScore(ti + T_MIN, f)
        val list = ArrayList<Cand>()
        for (ti in 0 until T_NUM) for (f in 0 until F_NUM) {
            val v = sc[ti * F_NUM + f]
            if (v < minScore) continue
            var peak = true
            loop@ for (dt in -1..1) for (df in -1..1) {
                if (dt == 0 && df == 0) continue
                val tt = ti + dt; val ff = f + df
                if (tt < 0 || tt >= T_NUM || ff < 0 || ff >= F_NUM) continue
                val w = sc[tt * F_NUM + ff]
                // ties go to the earlier grid point
                if (w > v || (w == v && (dt < 0 || (dt == 0 && df < 0)))) { peak = false; break@loop }
            }
            if (peak) list += Cand(ti + T_MIN, f, v)
        }
        list.sortWith(Comparator { a, b -> if (a.score != b.score) b.score.compareTo(a.score) else if (a.t != b.t) a.t - b.t else a.f - b.f })
        return if (list.size > maxN) list.subList(0, maxN) else list
    }

    /** One FFT of the whole slot (zero-padded to 2^18), for the baseband cuts. */
    private fun spectrum() {
        for (i in 0 until NBIG) { bigRe[i] = if (i < x.size) x[i] else 0.0; bigIm[i] = 0.0 }
        fftBig.run(bigRe, bigIm, false)
    }

    /** 200 Hz complex baseband with tone 0 near 0 Hz; returns the exact frequency of baseband 0 Hz. */
    private fun downconvert(f0: Double): Double {
        val k0 = jsRound(f0 / BIG_HZ).toInt()
        for (i in 0 until NBB) {
            val g = taper[i]
            if (g == 0.0) { bbRe[i] = 0.0; bbIm[i] = 0.0; continue }
            val k = k0 + (if (i < NBB / 2) i else i - NBB)
            bbRe[i] = bigRe[k] * g; bbIm[i] = bigIm[k] * g
        }
        fftBb.run(bbRe, bbIm, true)
        return k0 * BIG_HZ
    }

    /** The baseband from sample [from], shifted down by [hz], into zRe/zIm. */
    private fun rotate(from: Int, hz: Double) {
        val w = -2 * PI * hz / BB_RATE; val wr = cos(w); val wi = sin(w)
        var cr = cos(w * from); var ci = sin(w * from)
        for (i in 0 until BB_SPAN) {
            val n = from + i
            if (n in 0 until NBB) { zRe[i] = bbRe[n] * cr - bbIm[n] * ci; zIm[i] = bbRe[n] * ci + bbIm[n] * cr } else { zRe[i] = 0.0; zIm[i] = 0.0 }
            val t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
        }
    }

    /** Power of one symbol on one tone, the symbol starting at offset [at] of zRe/zIm (its complex value in lastRe/lastIm). */
    private fun tonePower(at: Int, tone: Int): Double {
        val o = tone * BB_SPS
        var a = 0.0; var b = 0.0
        for (n in 0 until BB_SPS) { val p = at + n; a += zRe[p] * cosT[o + n] + zIm[p] * sinT[o + n]; b += zIm[p] * cosT[o + n] - zRe[p] * sinT[o + n] }
        lastRe = a; lastIm = b
        return a * a + b * b
    }

    /** Costas energy with symbol 0 at offset [at] of zRe/zIm. */
    private fun costasEnergy(at: Int): Double {
        var e = 0.0
        for (m in 0 until 3) for (k in 0 until 7) e += tonePower(at + (36 * m + k) * BB_SPS, FT8_COSTAS[k])
        return e
    }

    private fun decodeCandidate(tc: Double, fc: Double): Found? {
        val base = downconvert(fc)
        val t0 = jsRound(tc * BB_RATE).toInt(); val from = t0 + BB_FROM
        // fine sync: 0.5 Hz and 10 ms, then 0.25 Hz and 5 ms, then 0.125 Hz
        var best = -1.0; var bdf = 0.0; var bdt = 0
        fun tryAt(df: Double, dtLo: Int, dtHi: Int, dtStep: Int) {
            rotate(from, fc - base + df)
            var dt = dtLo
            while (dt <= dtHi) { val e = costasEnergy(dt - BB_FROM); if (e > best) { best = e; bdf = df; bdt = dt }; dt += dtStep }
        }
        for (i in -3..3) tryAt(i * 0.5, -10, 10, 2)
        val c1 = bdf; val t1 = bdt
        tryAt(c1 - 0.25, t1 - 1, t1 + 1, 1); tryAt(c1, t1 - 1, t1 + 1, 1); tryAt(c1 + 0.25, t1 - 1, t1 + 1, 1)
        val c2 = bdf; val t2 = bdt
        tryAt(c2 - 0.125, t2, t2, 1); tryAt(c2 + 0.125, t2, t2, 1)
        // the symbols on the exact tones
        rotate(from, fc - base + bdf)
        val at0 = bdt - BB_FROM
        val eM = costasEnergy(at0 - 1); val eP = costasEnergy(at0 + 1); val e0 = costasEnergy(at0)
        val den = eM - 2 * e0 + eP
        val frac = if (den < 0) max(-0.5, min(0.5, 0.5 * (eM - eP) / den)) else 0.0
        measure(at0)
        // belief propagation on the one-symbol likelihoods, then on the three-symbol ones; OSD on the latter if BP came close
        val llr = DoubleArray(N); val plain = IntArray(N)
        var viaOsd = false
        softBits(llr)
        if (bpDecode(llr, BP_ITERS, plain) > 0) {
            coherentBits(llr)
            val errors = bpDecode(llr, BP_ITERS, plain)
            if (errors > 0) {
                if (!Ft8Options.osd || errors > OSD_MAX_BP_ERRORS || !osdDecode(llr, plain)) return null
                viaOsd = true
            }
        }
        return finish(plain, viaOsd, fc + bdf, (t0 + bdt + frac) / BB_RATE, false)
    }

    /**
     * A codeword to a decode: the CRC over the 77 payload bits (and 5 zeros), and for one from OSD or a-priori
     * decoding a plausible standard message with no unresolved hash; then the tones and the SNR.
     */
    private fun finish(plain: IntArray, strict: Boolean, hz: Double, t: Double, ap: Boolean): Found? {
        val a91 = IntArray(12)
        for (i in 0 until K) if (plain[i] != 0) a91[i shr 3] = a91[i shr 3] or (0x80 shr (i and 7))
        val crcExtracted = ((a91[9] and 0x07) shl 11) or (a91[10] shl 3) or (a91[11] shr 5)
        a91[9] = a91[9] and 0xF8; a91[10] = 0
        if (crc14(a91, 82) != crcExtracted) return null
        if (strict && !plausibleStd(a91)) return null
        pending = ArrayList()
        val text = unpack(a91.copyOfRange(0, 10)) ?: return null
        if (strict && (text.contains('<') || text.split(' ').any { it.isEmpty() })) return null
        val tones = IntArray(79)
        for (k in 0 until 7) { tones[k] = FT8_COSTAS[k]; tones[36 + k] = FT8_COSTAS[k]; tones[72 + k] = FT8_COSTAS[k] }
        for (k in 0 until ND) tones[k + (if (k < 29) 7 else 14)] = FT8_GRAY[(plain[3 * k] shl 2) or (plain[3 * k + 1] shl 1) or plain[3 * k + 2]]
        return Found(text, snrOf(tones), hz, t, tones, ap, plain.copyOfRange(0, 77))
    }

    /** SNR in 2500 Hz from the sent tones' power against the other seven tones' (noise) level. */
    private fun snrOf(tones: IntArray): Int {
        var sig = 0.0; val noise = DoubleArray(79 * 7); var n = 0
        for (s in 0 until 79) for (k in 0 until 8) { val v = pw[s * 8 + k]; if (k == tones[s]) sig += v else noise[n++] = v }
        noise.sort()
        val nf = noise[noise.size shr 1] / LN2; val ps = sig / 79 - nf
        return max(-28.0, min(40.0, jsRound(10 * log10(max(1e-9, ps / nf)) - 26.0206))).toInt()
    }

    /** The 79 symbols' tone powers and complex values from offset [at] of zRe/zIm, into pw, cxr and cxi. */
    private fun measure(at: Int) {
        for (s in 0 until 79) for (k in 0 until 8) { pw[s * 8 + k] = tonePower(at + s * BB_SPS, k); cxr[s * 8 + k] = lastRe; cxi[s * 8 + k] = lastIm }
    }

    /**
     * The a-priori stage. A station heard in a recent slot of this parity usually sends again with the same two call
     * fields (only the report, grid, RRR, RR73 or 73 changes). For each such call pair not decoded in this slot, the
     * signal is looked for near its last frequency by the energy on the tones those known bits fix (the sync and the
     * first 19 data symbols), and decoded with the known bits pinned: belief propagation, then OSD. The result still has
     * to be an LDPC codeword with a good CRC that unpacks to a plausible standard message, and the slot's own bits must
     * agree with it closely; so the report and the rest are read from the signal, never assumed.
     */
    private fun apStage(found: ArrayList<Found>, texts: HashSet<String>, slotMs: Long) {
        val seen = HashSet<String>(); val hyps = ArrayList<Heard>()
        for (i in history.indices.reversed()) {
            val h = history[i]
            if (h.slot >= slotMs || slotMs - h.slot > AP_WINDOW_MS || (slotMs - h.slot) % 30_000L != 0L) continue
            val key = callsKey(h.bits)
            if (!seen.add(key)) continue
            if (found.any { !it.ap && callsKey(it.bits) == key }) continue
            hyps += h
        }
        if (hyps.isEmpty()) return
        spectrum()
        val llr = DoubleArray(N); val raw = DoubleArray(N); val plain = IntArray(N)
        for (h in hyps) {
            if (found.any { abs(it.hz - h.hz) < 3 }) continue
            val base = downconvert(h.hz)
            var best = -1.0; var bdf = 0.0; var bt = 0
            for (i in -4..4) {
                val df = i * 0.5
                apEnergies(h.hz - base + df)
                var t = AP_T_LO
                while (t <= AP_T_HI) { val e = apAt(t, h.tones); if (e > best) { best = e; bdf = df; bt = t }; t += 2 }
            }
            val c1 = bdf; val t1 = bt
            for (df in doubleArrayOf(c1 - 0.25, c1, c1 + 0.25, c1 - 0.125, c1 + 0.125)) {
                apEnergies(h.hz - base + df)
                for (t in max(AP_T_LO, t1 - 2)..min(AP_T_HI, t1 + 2)) { val e = apAt(t, h.tones); if (e > best) { best = e; bdf = df; bt = t } }
            }
            if (found.any { abs(it.hz - (h.hz + bdf)) < SKIP_HZ && abs(it.t - bt.toDouble() / BB_RATE) < SKIP_S }) continue
            rotate(bt + BB_FROM, h.hz - base + bdf)
            measure(-BB_FROM)
            var r: Found? = null
            var m = 0
            while (m < 2 && r == null) {
                if (m == 0) softBits(raw) else coherentBits(raw)
                m++
                System.arraycopy(raw, 0, llr, 0, N)
                for (i in 0 until 77) if (AP_KNOWN[i] != 0) llr[i] = if (h.bits[i] != 0) AP_PIN else -AP_PIN
                var ok = bpDecode(llr, BP_ITERS, plain) == 0
                if (!ok && Ft8Options.osd) ok = osdDecode(llr, plain, true)
                if (!ok) continue
                var same = true
                for (i in 0 until 77) if (AP_KNOWN[i] != 0 && plain[i] != h.bits[i]) { same = false; break }
                if (!same) continue
                // the slot's own (unpinned) bits against the codeword
                var bad = 0.0; var tot = 0.0
                for (i in 0 until N) { tot += abs(raw[i]); if ((if (raw[i] > 0) 1 else 0) != plain[i]) bad += abs(raw[i]) }
                val dist = if (tot > 0) bad / tot else 1.0
                if (dist > AP_MAX_DIST) continue
                r = finish(plain, true, h.hz + bdf, bt.toDouble() / BB_RATE, true)
            }
            if (r == null || r.text in texts) continue
            texts += r.text
            for (call in pending) save(call)
            found += r
            if (Ft8Options.subtract) subtract(r)
        }
    }

    /** For a frequency shift, the baseband over the a-priori search span, and every 32-sample window's power on each tone (a sliding DFT). */
    private fun apEnergies(hz: Double) {
        val w = -2 * PI * hz / BB_RATE; val wr = cos(w); val wi = sin(w); val from = AP_T_LO
        var cr = cos(w * from); var ci = sin(w * from)
        for (i in 0 until AP_SPAN) {
            val n = from + i
            if (n in 0 until NBB) { apRe[i] = bbRe[n] * cr - bbIm[n] * ci; apIm[i] = bbRe[n] * ci + bbIm[n] * cr } else { apRe[i] = 0.0; apIm[i] = 0.0 }
            val t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
        }
        val l = AP_SPAN - BB_SPS
        for (k in 0 until 8) {
            val o = k * BB_SPS
            var a = 0.0; var b = 0.0
            for (n in 0 until BB_SPS) { a += apRe[n] * cosT[o + n] + apIm[n] * sinT[o + n]; b += apIm[n] * cosT[o + n] - apRe[n] * sinT[o + n] }
            val er = cosT[o + 1]; val ei = sinT[o + 1]
            for (n in 0 until l) {
                apPw[k * AP_SPAN + n] = a * a + b * b
                // slide one sample: drop z[n], add z[n + 32], turn by e^(j 2 pi k / 32)
                val ar = a - apRe[n] + apRe[n + BB_SPS]; val ai = b - apIm[n] + apIm[n + BB_SPS]
                a = ar * er - ai * ei; b = ar * ei + ai * er
            }
        }
    }

    /** Energy on the tones the known bits fix (AP_SYMS), symbol 0 at baseband sample t. */
    private fun apAt(t: Int, tones: IntArray): Double {
        val o = t - AP_T_LO; var e = 0.0
        for (s in AP_SYMS) e += apPw[tones[s] * AP_SPAN + o + s * BB_SPS]
        return e
    }

    /** 174 bit likelihoods from the 79 x 8 tone powers (noncoherent, one symbol at a time). */
    private fun softBits(llr: DoubleArray) {
        // noise per bin: the median of the bins that are not each symbol's strongest, as a mean (median = ln 2 x mean);
        // signal: the strongest bins' mean less that
        val rest = DoubleArray(ND * 7); var n = 0; var top = 0.0
        for (k in 0 until ND) {
            val s = k + if (k < 29) 7 else 14
            var mx = 0.0; var mi = 0
            for (j in 0 until 8) if (pw[s * 8 + j] > mx) { mx = pw[s * 8 + j]; mi = j }
            top += mx
            for (j in 0 until 8) if (j != mi) rest[n++] = pw[s * 8 + j]
        }
        rest.sort()
        val n0 = max(1e-30, rest[rest.size shr 1] / LN2)
        val es = max(n0 * 0.05, top / ND - n0)
        // each tone's log likelihood log I0(2 sqrt(Es P) / N0), summed over the tones of each bit value
        val l = DoubleArray(8)
        for (k in 0 until ND) {
            val s = k + (if (k < 29) 7 else 14); val bi = 3 * k
            for (j in 0 until 8) l[j] = logI0(2 * sqrt(es * pw[s * 8 + FT8_GRAY[j]]) / n0)
            llr[bi] = lse4(l[4], l[5], l[6], l[7]) - lse4(l[0], l[1], l[2], l[3])
            llr[bi + 1] = lse4(l[2], l[3], l[6], l[7]) - lse4(l[0], l[1], l[4], l[5])
            llr[bi + 2] = lse4(l[1], l[3], l[5], l[7]) - lse4(l[0], l[2], l[4], l[6])
        }
        normalize(llr)
    }

    /**
     * Bit likelihoods from three symbols at a time, added coherently (the tones keep their phase from symbol to
     * symbol): each data symbol's tone scored by the best sum with its neighbors' tones (known where they are sync).
     */
    private fun coherentBits(llr: DoubleArray) {
        val l = DoubleArray(8)
        for (k in 0 until ND) {
            val s = k + (if (k < 29) 7 else 14); val bi = 3 * k
            val ka = knownTone(s - 1); val kb = knownTone(s + 1)
            for (g in 0 until 8) {
                val j = FT8_GRAY[g]; val cr = cxr[s * 8 + j]; val ci = cxi[s * 8 + j]
                var best = 0.0
                for (a in (if (ka < 0) 0 else ka) until (if (ka < 0) 8 else ka + 1)) {
                    val ar = cr + cxr[(s - 1) * 8 + a]; val ai = ci + cxi[(s - 1) * 8 + a]
                    for (b in (if (kb < 0) 0 else kb) until (if (kb < 0) 8 else kb + 1)) {
                        val r = ar + cxr[(s + 1) * 8 + b]; val i = ai + cxi[(s + 1) * 8 + b]; val v = r * r + i * i
                        if (v > best) best = v
                    }
                }
                l[g] = sqrt(best)
            }
            llr[bi] = max4(l[4], l[5], l[6], l[7]) - max4(l[0], l[1], l[2], l[3])
            llr[bi + 1] = max4(l[2], l[3], l[6], l[7]) - max4(l[0], l[1], l[4], l[5])
            llr[bi + 2] = max4(l[1], l[3], l[5], l[7]) - max4(l[0], l[2], l[4], l[6])
        }
        normalize(llr)
    }

    /** The decoded signal's unit waveform (GFSK, BT 2) at 12.8 kHz from sample n0, into subRe/subIm; then the running sums of x * conj(it). */
    private fun reference(n0: Int, hz: Double, tones: IntArray) {
        val len = 79 * BLOCK
        val w0 = 2 * PI * hz / FS; val c0 = cos(w0); val s0 = sin(w0); val dk = 2 * PI * TONE_HZ / FS
        var cr = 1.0; var ci = 0.0
        for (i in 0 until len) {
            subRe[i] = cr; subIm[i] = ci
            val s = i / BLOCK; val q = i - s * BLOCK
            val g = tones[if (s > 0) s - 1 else 0] * pulse[q + 2 * BLOCK] + tones[s] * pulse[q + BLOCK] + tones[if (s < 78) s + 1 else 78] * pulse[q]
            // the step's rotation: the carrier's, times the small tone offset's from its series
            val d = dk * g; val d2 = d * d
            val ce = 1 - d2 / 2 + d2 * d2 / 24 - d2 * d2 * d2 / 720; val se = d * (1 - d2 / 6 + d2 * d2 / 120)
            val ar = c0 * ce - s0 * se; val ai = s0 * ce + c0 * se
            val t = cr * ar - ci * ai; ci = cr * ai + ci * ar; cr = t
            if (q == BLOCK - 1) { val m = 1 / sqrt(cr * cr + ci * ci); cr *= m; ci *= m }
        }
        cumRe[0] = 0.0; cumIm[0] = 0.0
        for (i in 0 until len) {
            val j = n0 + i; val v = if (j >= 0 && j < x.size) x[j] else 0.0
            cumRe[i + 1] = cumRe[i] + v * subRe[i]; cumIm[i + 1] = cumIm[i] - v * subIm[i]
        }
    }

    /**
     * Take a decoded signal out of the audio. Its start and frequency are first refined from the phase steps between
     * symbols (a late start turns the phase at each tone change in proportion to the change, a frequency error turns
     * it the same at every symbol), then its amplitude and phase are followed along the slot and the rebuilt signal
     * subtracted.
     */
    private fun subtract(r: Found) {
        val len = 79 * BLOCK; val tones = r.tones
        var t = r.t; var hz = r.hz
        for (it in 0 until 2) {
            val n0 = jsRound(t * FS).toInt()
            reference(n0, hz, tones)
            var sw = 0.0; var swu = 0.0; var swu2 = 0.0; var swy = 0.0; var swuy = 0.0
            var pr = 0.0; var pi = 0.0; var pOk = false
            for (s in 0 until 79) {
                val a = s * BLOCK + (BLOCK shr 2); val b = s * BLOCK + 3 * (BLOCK shr 2)
                val ok = n0 + a >= 0 && n0 + b <= x.size
                val qr = cumRe[b] - cumRe[a]; val qi = cumIm[b] - cumIm[a]
                if (ok && pOk) {
                    val vr = qr * pr + qi * pi; val vi = qi * pr - qr * pi; val w = sqrt(vr * vr + vi * vi)
                    if (w > 0) { val y = atan2(vi, vr); val u = (tones[s - 1] - tones[s]).toDouble(); sw += w; swu += w * u; swu2 += w * u * u; swy += w * y; swuy += w * u * y }
                }
                pr = qr; pi = qi; pOk = ok
            }
            val det = sw * swu2 - swu * swu
            if (!(det > 0)) break
            val delta = (swy * swu2 - swu * swuy) / det; val kappa = (sw * swuy - swu * swy) / det
            val tau = kappa / (2 * PI * TONE_HZ); val dHz = delta / (2 * PI * SYMBOL)
            if (abs(tau) > 0.004 || abs(dHz) > 0.4) break
            t += tau; hz += dHz
        }
        val n0 = jsRound(t * FS).toInt()
        reference(n0, hz, tones)
        val h = SUB_WIN shr 1; val lo = max(0, -n0); val hi = min(len, x.size - n0)
        for (i in lo until hi) {
            val a = max(lo, i - h); val b = min(hi, i + h + 1); val inv = 2.0 / (b - a)
            val ar = (cumRe[b] - cumRe[a]) * inv; val ai = (cumIm[b] - cumIm[a]) * inv
            x[n0 + i] -= ar * subRe[i] - ai * subIm[i]
        }
    }

    // ---------------------------------------------------------------------------------------- unpacking
    private fun unpack(p: IntArray): String? {
        val i3 = (p[9] shr 3) and 7
        val n3 = ((p[8] shl 2) and 4) or ((p[9] shr 6) and 3)
        return when {
            i3 == 1 || i3 == 2 -> unpackStd(p, i3)
            i3 == 4 -> unpackNonStd(p)
            i3 == 0 && n3 == 0 -> unpackFree(p)
            i3 == 0 && n3 == 1 -> unpackDxp(p)
            i3 == 0 && n3 == 5 -> unpackTelemetry(p)
            i3 == 3 -> unpackRtty(p)
            else -> null
        }
    }

    private fun unpackStd(p: IntArray, i3: Int): String? {
        val n29a = (p[0] shl 21) or (p[1] shl 13) or (p[2] shl 5) or (p[3] shr 3)
        val n29b = ((p[3] and 7) shl 26) or (p[4] shl 18) or (p[5] shl 10) or (p[6] shl 2) or (p[7] shr 6)
        val ir = (p[7] and 0x20) shr 5
        val igrid4 = ((p[7] and 0x1F) shl 10) or (p[8] shl 2) or (p[9] shr 6)
        val a = unpack28(n29a ushr 1, n29a and 1, i3) ?: return null
        val b = unpack28(n29b ushr 1, n29b and 1, i3) ?: return null
        val extra = unpackGrid(igrid4, ir)
        return if (extra.isNotEmpty()) "$a $b $extra" else "$a $b"
    }

    private fun unpack28(n28in: Int, ip: Int, i3: Int): String? {
        var n28 = n28in
        if (n28 < NTOKENS) {
            if (n28 <= 2) return listOf("DE", "QRZ", "CQ")[n28]
            if (n28 <= 1002) return "CQ %03d".format(n28 - 3)
            if (n28 <= 532443) {
                var n = n28 - 1003; var s = ""
                repeat(4) { s = charn(n % 27, Table.LS) + s; n /= 27 }
                return "CQ ${s.trim()}"
            }
            return null
        }
        n28 -= NTOKENS
        if (n28 < MAX22) return lookup(22, n28)
        var n = n28 - MAX22
        val cs = CharArray(6)
        cs[5] = charn(n % 27, Table.LS); n /= 27
        cs[4] = charn(n % 27, Table.LS); n /= 27
        cs[3] = charn(n % 27, Table.LS); n /= 27
        cs[2] = charn(n % 10, Table.N); n /= 10
        cs[1] = charn(n % 36, Table.AN); n /= 36
        cs[0] = charn(n % 37, Table.ANS)
        var call = String(cs)
        call = if (call.startsWith("3D0") && call[3] != ' ') "3DA0" + call.substring(3).trim()
        else if (call[0] == 'Q' && call[1] in 'A'..'Z') "3X" + call.substring(1).trim()
        else call.trim()
        if (call.length < 3) return null
        if (ip != 0) { call += when (i3) { 1 -> "/R"; 2 -> "/P"; else -> return null } }
        pending.add(call)
        return call
    }

    /** DXpedition: "K1ABC RR73; W9XYZ <KH1/KH7Z> -08" (28 + 28 + 10-bit hash + 5-bit report). */
    private fun unpackDxp(p: IntArray): String? {
        val a = unpack28(bitsAt(p, 0, 28), 0, 1) ?: return null
        val b = unpack28(bitsAt(p, 28, 28), 0, 1) ?: return null
        val r = 2 * bitsAt(p, 66, 5) - 30
        return "$a RR73; $b ${lookup(10, bitsAt(p, 56, 10))} ${if (r < 0) "-" else "+"}${"%02d".format(abs(r))}"
    }

    private fun unpackNonStd(p: IntArray): String {
        val n12 = (p[0] shl 4) or (p[1] shr 4)
        var n58 = (p[1] and 0x0F).toLong()
        for (b in intArrayOf(p[2], p[3], p[4], p[5], p[6], p[7])) n58 = (n58 shl 8) or b.toLong()
        n58 = (n58 shl 6) or (p[8] shr 2).toLong()
        val iflip = (p[8] shr 1) and 1
        val nrpt = ((p[8] and 1) shl 1) or (p[9] shr 7)
        val icq = (p[9] shr 6) and 1
        val c11 = StringBuilder()
        repeat(11) { c11.insert(0, charn((n58 % 38).toInt(), Table.ANSS)); n58 /= 38 }
        val decoded = c11.toString().trim()
        if (decoded.length >= 3) pending.add(decoded)
        val other = lookup(12, n12)
        val call1 = if (iflip != 0) decoded else other
        val call2 = if (iflip != 0) other else decoded
        if (icq != 0) return "CQ $call2"
        val extra = listOf("", "RRR", "RR73", "73")[nrpt]
        return if (extra.isNotEmpty()) "$call1 $call2 $extra" else "$call1 $call2"
    }

    private fun unpackRtty(p: IntArray): String? {
        val tu = p[0] shr 7
        val n28a = ((p[0] and 0x7F) shl 21) or (p[1] shl 13) or (p[2] shl 5) or (p[3] shr 3)
        val n28b = ((p[3] and 7) shl 25) or (p[4] shl 17) or (p[5] shl 9) or (p[6] shl 1) or (p[7] shr 7)
        val ir = (p[7] shr 6) and 1
        val irpt = (p[7] shr 3) and 7
        val nexch = ((p[7] and 7) shl 10) or (p[8] shl 2) or (p[9] shr 6)
        val a = unpack28(n28a, 0, 1) ?: return null
        val b = unpack28(n28b, 0, 1) ?: return null
        val rst = listOf("52", "53", "54", "55", "56", "57", "58", "59")[irpt]
        val exch = if (nexch < 8000) "%04d".format(nexch) else STATES.getOrNull(nexch - 8001) ?: ""
        return "${if (tu != 0) "TU; " else ""}$a $b ${if (ir != 0) "R " else ""}${rst}9 $exch"
    }

    private fun save(call: String) {
        hash22(call)?.let { hashes[it] = call }
    }

    private fun lookup(bits: Int, h: Int): String {
        for ((n22, call) in hashes) {
            val k = when (bits) { 22 -> n22; 12 -> n22 shr 10; else -> n22 shr 12 }
            if (k == h) return "<$call>"
        }
        return "<...>"
    }

    companion object {
        private val STATES = listOf("AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
            "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
            "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "NB", "NS", "QC", "ON", "MB", "SK", "AB", "BC", "NWT",
            "NF", "LB", "NU", "YT", "PEI", "DC", "DX")
    }
}

private const val LN2 = 0.6931471805599453

/** Round half up, as Math.round in the web twin (so both land on the same sample, bin and display value). */
private fun jsRound(v: Double): Double = floor(v + 0.5)

private fun max4(a: Double, b: Double, c: Double, d: Double): Double { val x = if (a > b) a else b; val y = if (c > d) c else d; return if (x > y) x else y }

/** Scale the bit likelihoods to the variance belief propagation was tuned for. */
private fun normalize(llr: DoubleArray) {
    var sum = 0.0; var sum2 = 0.0
    for (i in 0 until N) { sum += llr[i]; sum2 += llr[i] * llr[i] }
    val variance = (sum2 - sum * sum / N) / N
    val norm = if (variance > 0) sqrt(LLR_VAR / variance) else 0.0
    for (i in 0 until N) llr[i] *= norm
}

/** log(e^a + e^b + e^c + e^d) */
private fun lse4(a: Double, b: Double, c: Double, d: Double): Double {
    val m = max4(a, b, c, d)
    return m + ln(exp(a - m) + exp(b - m) + exp(c - m) + exp(d - m))
}

/** log I0(x), x >= 0 (Abramowitz and Stegun 9.8.1 and 9.8.2). */
private fun logI0(x: Double): Double {
    if (x < 3.75) {
        val t = (x / 3.75) * (x / 3.75)
        return ln(1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))))
    }
    val t = 3.75 / x
    return x - 0.5 * ln(x) + ln(0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 +
        t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377))))))))
}

/** erf, Abramowitz and Stegun 7.1.26. */
private fun erf(x: Double): Double {
    val s = if (x < 0) -1.0 else 1.0; val a = abs(x); val t = 1 / (1 + 0.3275911 * a)
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a))
}

/** The GFSK (BT 2) frequency pulse of one symbol, over three symbols (in tones). */
private fun gfskPulse(): DoubleArray {
    val k = PI * sqrt(2 / LN2) * 2
    return DoubleArray(3 * BLOCK) { val t = (it + 0.5) / BLOCK - 1.5; 0.5 * (erf(k * (t + 0.5)) - erf(k * (t - 0.5))) }
}

/** The tone of a sync symbol, or -1 for a data symbol. */
private fun knownTone(s: Int): Int = when {
    s < 7 -> FT8_COSTAS[s]
    s in 36 until 43 -> FT8_COSTAS[s - 36]
    s >= 72 -> FT8_COSTAS[s - 72]
    else -> -1
}

/** A standard message (i3 1 or 2), from its 77 bits. */
private fun isStd(bits: IntArray): Boolean { val i3 = (bits[74] shl 2) or (bits[75] shl 1) or bits[76]; return i3 == 1 || i3 == 2 }

/** The two call fields and i3, as a key. */
private fun callsKey(bits: IntArray): String { val sb = StringBuilder(); for (i in 0 until 77) if (AP_KNOWN[i] != 0) sb.append(bits[i]); return sb.toString() }

/** Belief-propagation LDPC decode; returns the fewest failed parity checks seen (0 = codeword in [plain]). */
private fun bpDecode(cw: DoubleArray, maxIters: Int, plain: IntArray): Int {
    val tov = DoubleArray(N * 3); val toc = DoubleArray(M * 7)
    var minErrors = M
    for (iter in 0 until maxIters) {
        var sum = 0
        for (n in 0 until N) { plain[n] = if (cw[n] + tov[n * 3] + tov[n * 3 + 1] + tov[n * 3 + 2] > 0) 1 else 0; sum += plain[n] }
        if (sum == 0) break
        val errors = ldpcCheck(plain)
        if (errors < minErrors) { minErrors = errors; if (errors == 0) break }
        for (m in 0 until M) {
            val rows = LDPC_NUM_ROWS[m]
            for (ni in 0 until rows) {
                val n = LDPC_NM[m * 7 + ni] - 1
                var t = cw[n]
                for (mi in 0 until 3) if (LDPC_MN[n * 3 + mi] - 1 != m) t += tov[n * 3 + mi]
                toc[m * 7 + ni] = fastTanh(-t / 2)
            }
        }
        for (n in 0 until N) {
            for (mi in 0 until 3) {
                val m = LDPC_MN[n * 3 + mi] - 1; val rows = LDPC_NUM_ROWS[m]
                var t = 1.0
                for (ni in 0 until rows) if (LDPC_NM[m * 7 + ni] - 1 != n) t *= toc[m * 7 + ni]
                tov[n * 3 + mi] = -2 * fastAtanh(t)
            }
        }
    }
    return minErrors
}

private fun ldpcCheck(cw: IntArray): Int {
    var errors = 0
    for (m in 0 until M) {
        var x = 0
        for (i in 0 until LDPC_NUM_ROWS[m]) x = x xor cw[LDPC_NM[m * 7 + i] - 1]
        if (x != 0) errors++
    }
    return errors
}

private fun fastTanh(x: Double): Double {
    if (x < -4.97) return -1.0
    if (x > 4.97) return 1.0
    val x2 = x * x
    return x * (945 + x2 * (105 + x2)) / (945 + x2 * (420 + x2 * 15))
}

private fun fastAtanh(x: Double): Double {
    val x2 = x * x
    return x * (945 + x2 * (-735 + x2 * 64)) / (945 + x2 * (-1050 + x2 * 225))
}

/** Generator rows: for each of the 91 message bits, the 174-bit codeword it adds (6 words of 32 bits). */
private const val OSD_W = 6
private val GEN_ROWS: IntArray = IntArray(K * OSD_W).also { g ->
    for (j in 0 until K) {
        g[j * OSD_W + (j shr 5)] = g[j * OSD_W + (j shr 5)] or (1 shl (j and 31))
        for (i in 0 until M) if ((LDPC_GENERATOR[i * 12 + (j shr 3)] shr (7 - (j and 7))) and 1 != 0) {
            val c = K + i; g[j * OSD_W + (c shr 5)] = g[j * OSD_W + (c shr 5)] or (1 shl (c and 31))
        }
    }
}

/**
 * Ordered-statistics decoding, order 1 and order 2 over the least reliable OSD_ORDER2 of the most reliable basis.
 * Writes the closest codeword to [plain] and returns true only if it passes the distance safeguards (not applied when
 * [pinned]: the a-priori stage has its own).
 */
private fun osdDecode(llr: DoubleArray, plain: IntArray, pinned: Boolean = false): Boolean {
    val rel = DoubleArray(N) { abs(llr[it]) }
    val perm = (0 until N).sortedWith(Comparator { a, b -> if (rel[a] != rel[b]) rel[b].compareTo(rel[a]) else a - b }).toIntArray()
    // generator columns in reliability order
    val rows = IntArray(K * OSD_W)
    for (j in 0 until K) for (c in 0 until N) {
        val src = perm[c]
        if ((GEN_ROWS[j * OSD_W + (src shr 5)] ushr (src and 31)) and 1 != 0) rows[j * OSD_W + (c shr 5)] = rows[j * OSD_W + (c shr 5)] or (1 shl (c and 31))
    }
    // Gaussian elimination: the first 91 independent columns become the basis
    val pivot = IntArray(K); var r = 0
    var c = 0
    while (c < N && r < K) {
        val w = c shr 5; val bit = 1 shl (c and 31)
        var p = -1
        for (i in r until K) if (rows[i * OSD_W + w] and bit != 0) { p = i; break }
        if (p >= 0) {
            if (p != r) for (q in 0 until OSD_W) { val t = rows[p * OSD_W + q]; rows[p * OSD_W + q] = rows[r * OSD_W + q]; rows[r * OSD_W + q] = t }
            for (i in 0 until K) if (i != r && rows[i * OSD_W + w] and bit != 0) for (q in 0 until OSD_W) rows[i * OSD_W + q] = rows[i * OSD_W + q] xor rows[r * OSD_W + q]
            pivot[r++] = c
        }
        c++
    }
    if (r < K) return false
    // hard decisions in reliability order, and the codeword through the basis decisions
    val hd = IntArray(OSD_W); val wt = DoubleArray(N)
    for (cc in 0 until N) { wt[cc] = rel[perm[cc]]; if (llr[perm[cc]] > 0) hd[cc shr 5] = hd[cc shr 5] or (1 shl (cc and 31)) }
    val base = IntArray(OSD_W)
    for (i in 0 until K) if ((hd[pivot[i] shr 5] ushr (pivot[i] and 31)) and 1 != 0) for (q in 0 until OSD_W) base[q] = base[q] xor rows[i * OSD_W + q]
    fun cost(cw: IntArray, limit: Double): Double {
        var d = 0.0
        for (q in 0 until OSD_W) {
            var v = cw[q] xor hd[q]
            while (v != 0) { val b = Integer.numberOfTrailingZeros(v); d += wt[q * 32 + b]; v = v and (v - 1) }
            if (d >= limit) return d
        }
        return d
    }
    val best = base.copyOf(); val cand = IntArray(OSD_W)
    var bestD = cost(base, Double.POSITIVE_INFINITY)
    for (i in 0 until K) {
        for (q in 0 until OSD_W) cand[q] = base[q] xor rows[i * OSD_W + q]
        val d = cost(cand, bestD); if (d < bestD) { bestD = d; System.arraycopy(cand, 0, best, 0, OSD_W) }
    }
    for (i in K - OSD_ORDER2 until K) for (j in i + 1 until K) {
        for (q in 0 until OSD_W) cand[q] = base[q] xor rows[i * OSD_W + q] xor rows[j * OSD_W + q]
        val d = cost(cand, bestD); if (d < bestD) { bestD = d; System.arraycopy(cand, 0, best, 0, OSD_W) }
    }
    // safeguards: few disagreements with the hard decisions, and a small share of the total reliability
    var flips = 0; var total = 0.0
    for (cc in 0 until N) { total += wt[cc]; if (((best[cc shr 5] xor hd[cc shr 5]) ushr (cc and 31)) and 1 != 0) flips++ }
    if (!pinned && (flips > OSD_MAX_FLIPS || bestD > OSD_MAX_DIST * total)) return false
    for (cc in 0 until N) plain[perm[cc]] = (best[cc shr 5] ushr (cc and 31)) and 1
    return ldpcCheck(plain) == 0
}

/** An OSD result is only kept as a standard message whose report or grid field is a real one. */
private fun plausibleStd(a: IntArray): Boolean {
    val i3 = (a[9] shr 3) and 7
    if (i3 != 1 && i3 != 2) return false
    val n29b = ((a[3] and 7) shl 26) or (a[4] shl 18) or (a[5] shl 10) or (a[6] shl 2) or (a[7] shr 6)
    if ((n29b ushr 1) < NTOKENS) return false                 // the second call is never DE, QRZ or CQ
    val igrid4 = ((a[7] and 0x1F) shl 10) or (a[8] shl 2) or (a[9] shr 6)
    if (igrid4 <= MAXGRID4) return true
    val irpt = igrid4 - MAXGRID4
    return irpt <= 4 || (irpt - 35 >= -50 && irpt - 35 <= 49)
}

/** [len] bits (at most 31) of the payload from bit [start], first bit most significant. */
private fun bitsAt(p: IntArray, start: Int, len: Int): Int {
    var v = 0
    for (i in start until start + len) v = v * 2 + ((p[i shr 3] shr (7 - (i and 7))) and 1)
    return v
}

/** In-place radix-2 complex FFT of one size, with its tables (forward e^-j, inverse e^+j, no scaling). */
private class Ft8Fft(val n: Int) {
    private val cosT = DoubleArray(n shr 1) { cos(2 * PI * it / n) }
    private val sinT = DoubleArray(n shr 1) { sin(2 * PI * it / n) }
    private val rev = IntArray(n)
    init {
        var bits = 0; while ((1 shl bits) < n) bits++
        for (i in 0 until n) { var r = 0; for (b in 0 until bits) r = r or (((i shr b) and 1) shl (bits - 1 - b)); rev[i] = r }
    }
    fun run(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        val sg = if (inverse) 1.0 else -1.0
        for (i in 0 until n) { val j = rev[i]; if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t } }
        var len = 2
        while (len <= n) {
            val half = len shr 1; val step = n / len
            var i = 0
            while (i < n) {
                for (k in 0 until half) {
                    val wr = cosT[k * step]; val wi = sg * sinT[k * step]; val a = i + k; val b = a + half
                    val tr = wr * re[b] - wi * im[b]; val ti = wr * im[b] + wi * re[b]
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
                }
                i += len
            }
            len = len shl 1
        }
    }
}

private fun crc14(msg: IntArray, numBits: Int): Int {
    var rem = 0; var idx = 0
    for (b in 0 until numBits) {
        if (b % 8 == 0) rem = rem xor (msg[idx++] shl 6)
        rem = if ((rem and 0x2000) != 0) (rem shl 1) xor CRC_POLY else rem shl 1
    }
    return rem and 0x3FFF
}

private enum class Table { FULL, ANS, AN, LS, N, ANSS }

private fun charn(cIn: Int, table: Table): Char {
    var c = cIn
    if (table != Table.AN && table != Table.N) { if (c == 0) return ' '; c -= 1 }
    if (table != Table.LS) { if (c < 10) return '0' + c; c -= 10 }
    if (table != Table.N) { if (c < 26) return 'A' + c; c -= 26 }
    if (table == Table.FULL && c < 5) return "+-./?"[c]
    if (table == Table.ANSS && c == 0) return '/'
    return '_'
}

private fun nchar(ch: Char, table: Table): Int {
    var n = 0
    if (table != Table.AN && table != Table.N) { if (ch == ' ') return 0; n += 1 }
    if (table != Table.LS) { if (ch in '0'..'9') return n + (ch - '0'); n += 10 }
    if (table != Table.N) { if (ch in 'A'..'Z') return n + (ch - 'A'); n += 26 }
    if (table == Table.FULL) { val i = "+-./?".indexOf(ch); return if (i >= 0) n + i else -1 }
    if (table == Table.ANSS && ch == '/') return n
    return -1
}

private fun unpackGrid(igrid4: Int, ir: Int): String {
    if (igrid4 <= MAXGRID4) {
        var n = igrid4
        val d3 = n % 10; n /= 10
        val d2 = n % 10; n /= 10
        val d1 = 'A' + n % 18; n /= 18
        val d0 = 'A' + n % 18
        return (if (ir != 0) "R " else "") + "$d0$d1$d2$d3"
    }
    return when (val irpt = igrid4 - MAXGRID4) {
        1 -> ""; 2 -> "RRR"; 3 -> "RR73"; 4 -> "73"
        else -> { val v = irpt - 35; "${if (ir != 0) "R" else ""}${if (v < 0) "-" else "+"}%02d".format(abs(v)) }
    }
}

private fun telemetry71(p: IntArray): IntArray {
    val b = IntArray(9); var carry = 0
    for (i in 0 until 9) { b[i] = ((carry shl 7) or (p[i] shr 1)) and 0xFF; carry = p[i] and 1 }
    return b
}

private fun unpackFree(p: IntArray): String {
    val b71 = telemetry71(p); val c = CharArray(13)
    for (idx in 12 downTo 0) {
        var rem = 0
        for (i in 0 until 9) { rem = (rem shl 8) or b71[i]; b71[i] = rem / 42; rem %= 42 }
        c[idx] = charn(rem, Table.FULL)
    }
    return String(c).trim()
}

private fun unpackTelemetry(p: IntArray): String = telemetry71(p).joinToString("") { "%02X".format(it) }

private val HASH_MUL = BigInteger.valueOf(47055833459L)

/** The 22-bit callsign hash FT8 uses for <...> references, or null if the call has characters outside the set. */
private fun hash22(call: String): Int? {
    var n58 = 0L
    for (i in 0 until 11) {
        val c = if (i < call.length) call[i] else ' '
        val j = nchar(c, Table.ANSS); if (j < 0) return null
        n58 = n58 * 38 + j
    }
    return HASH_MUL.multiply(BigInteger.valueOf(n58)).shiftRight(42).toInt() and 0x3FFFFF
}

// ================================================================================================== encoder

private fun packBasecall(call: String): Int {
    if (call.length <= 2) return -1
    var c6 = "      "
    if (call.startsWith("3DA0") && call.length in 5..7) c6 = ("3D0" + call.substring(4)).padEnd(6)
    else if (call.startsWith("3X") && call[2] in 'A'..'Z' && call.length <= 7) c6 = ("Q" + call.substring(2)).padEnd(6)
    else if (call[2] in '0'..'9' && call.length <= 6) c6 = call.padEnd(6)
    else if (call[1] in '0'..'9' && call.length <= 5) c6 = (" $call").padEnd(6)
    val i = intArrayOf(nchar(c6[0], Table.ANS), nchar(c6[1], Table.AN), nchar(c6[2], Table.N),
        nchar(c6[3], Table.LS), nchar(c6[4], Table.LS), nchar(c6[5], Table.LS))
    if (i.any { it < 0 }) return -1
    return ((((i[0] * 36 + i[1]) * 10 + i[2]) * 27 + i[3]) * 27 + i[4]) * 27 + i[5]
}

/** [n28, ip] or null. */
private fun pack28(call: String): IntArray? {
    when (call) { "DE" -> return intArrayOf(0, 0); "QRZ" -> return intArrayOf(1, 0); "CQ" -> return intArrayOf(2, 0) }
    if (call.startsWith("CQ ") && call.length < 8) {
        val arg = call.substring(3)
        if (Regex("^\\d{3}$").matches(arg)) return intArrayOf(3 + arg.toInt(), 0)
        if (Regex("^[A-Z]{1,4}$").matches(arg)) { var m = 0; for (ch in arg) m = 27 * m + (ch - '@'); return intArrayOf(3 + 1000 + m, 0) }
        return null
    }
    var ip = 0; var base = call
    if (call.endsWith("/P") || call.endsWith("/R")) { ip = 1; base = call.dropLast(2) }
    val n = packBasecall(base)
    if (n >= 0) return intArrayOf(NTOKENS + MAX22 + n, ip)
    if (call.length in 3..11) { val h = hash22(call) ?: return null; return intArrayOf(NTOKENS + h, 0) }
    return null
}

private fun packGrid(extra: String): Int {
    if (extra.isEmpty()) return MAXGRID4 + 1
    when (extra) { "RRR" -> return MAXGRID4 + 2; "RR73" -> return MAXGRID4 + 3; "73" -> return MAXGRID4 + 4 }
    if (Regex("^[A-R]{2}[0-9]{2}$").matches(extra))
        return (((extra[0] - 'A') * 18 + (extra[1] - 'A')) * 10 + (extra[2] - '0')) * 10 + (extra[3] - '0')
    val m = Regex("^(R?)([+-]?\\d{1,2})$").find(extra)
    if (m != null) return (MAXGRID4 + 35 + m.groupValues[2].toInt()) or (if (m.groupValues[1].isNotEmpty()) 0x8000 else 0)
    return MAXGRID4 + 1
}

object Ft8Encode {
    /** A standard message ("CQ K1ABC FN42", "K1ABC W9XYZ -10", "... RR73") as 10 payload bytes, or null. */
    fun packStandard(text: String): IntArray? {
        val t = text.trim().uppercase().replace(Regex("\\s+"), " ")
        val parts = t.split(' ')
        val callTo: String; val callDe: String; val extra: String
        if (parts[0] == "CQ" && parts.size == 4 && (Regex("^\\d{3}$").matches(parts[1]) || Regex("^[A-Z]{1,4}$").matches(parts[1])) &&
            !Regex("^[A-R]{2}\\d{2}$").matches(parts[1])) {
            callTo = "CQ ${parts[1]}"; callDe = parts[2]; extra = parts.getOrElse(3) { "" }
        } else {
            if (parts.size < 2 || parts.size > 3) return null
            callTo = parts[0]; callDe = parts[1]; extra = parts.getOrElse(2) { "" }
        }
        val a = pack28(callTo) ?: return null
        val b = pack28(callDe) ?: return null
        val i3 = if (callTo.endsWith("/P") || callDe.endsWith("/P")) 2 else 1
        val g = packGrid(extra)
        val igrid4 = g and 0x7FFF; val ir = g shr 15
        val n29a = a[0] * 2 + a[1]; val n29b = b[0] * 2 + b[1]
        val p = IntArray(10)
        p[0] = n29a ushr 21; p[1] = (n29a ushr 13) and 0xFF; p[2] = (n29a ushr 5) and 0xFF; p[3] = ((n29a shl 3) and 0xFF) or (n29b ushr 26)
        p[4] = (n29b ushr 18) and 0xFF; p[5] = (n29b ushr 10) and 0xFF; p[6] = (n29b ushr 2) and 0xFF
        p[7] = ((n29b shl 6) and 0xFF) or (ir shl 5) or (igrid4 ushr 10)
        p[8] = (igrid4 ushr 2) and 0xFF; p[9] = ((igrid4 shl 6) and 0xFF) or (i3 shl 3)
        return p
    }

    /** Up to 13 characters of free text (A-Z 0-9 +-./? and space). */
    fun packFree(text: String): IntArray {
        val t = text.uppercase().take(13).padStart(13, ' ')
        var n = BigInteger.ZERO
        val b42 = BigInteger.valueOf(42)
        for (ch in t) { val v = nchar(ch, Table.FULL); n = n.multiply(b42).add(BigInteger.valueOf(max(0, v).toLong())) }
        n = n.shiftLeft(1)
        val p = IntArray(10)
        for (i in 8 downTo 0) { p[i] = n.and(BigInteger.valueOf(0xFF)).toInt(); n = n.shiftRight(8) }
        return p
    }

    /** 77-bit payload → 79 tone indices (S7 D29 S7 D29 S7). */
    fun tones(payload: IntArray): IntArray {
        val a91 = IntArray(12); System.arraycopy(payload, 0, a91, 0, 10)
        a91[9] = a91[9] and 0xF8; a91[10] = 0
        val crc = crc14(a91, 82)
        a91[9] = a91[9] or (crc shr 11); a91[10] = (crc shr 3) and 0xFF; a91[11] = (crc shl 5) and 0xFF
        val cw = IntArray(22); for (j in 0 until 12) cw[j] = a91[j]
        var colMask = 0x80 shr (91 % 8); var colIdx = 11
        for (i in 0 until 83) {
            var nsum = 0
            for (j in 0 until 12) {
                var bits = a91[j] and LDPC_GENERATOR[i * 12 + j]
                bits = bits xor (bits shr 4); bits = bits xor (bits shr 2); bits = bits xor (bits shr 1); nsum = nsum xor (bits and 1)
            }
            if (nsum != 0) cw[colIdx] = cw[colIdx] or colMask
            colMask = colMask shr 1; if (colMask == 0) { colMask = 0x80; colIdx++ }
        }
        val tones = IntArray(79)
        for (k in 0 until 7) { tones[k] = FT8_COSTAS[k]; tones[36 + k] = FT8_COSTAS[k]; tones[72 + k] = FT8_COSTAS[k] }
        var bit = 0
        for (k in 0 until 58) {
            val sym = k + if (k < 29) 7 else 14
            var v = 0
            for (b in 0 until 3) { v = (v shl 1) or ((cw[bit shr 3] shr (7 - (bit and 7))) and 1); bit++ }
            tones[sym] = FT8_GRAY[v]
        }
        return tones
    }

    /** Real audio at [rate]: 79 symbols of 0.16 s, tone 0 at [baseHz], 6.25 Hz spacing, smoothed frequency steps. */
    fun audio(tones: IntArray, baseHz: Double, rate: Int, amplitude: Float = 0.5f): FloatArray {
        val symLen = (rate * 0.16).roundToInt(); val n = symLen * 79; val out = FloatArray(n)
        var ph = 0.0
        for (i in 0 until n) {
            val s = min(78, i / symLen); val frac = (i % symLen).toDouble() / symLen
            var tone = tones[s].toDouble()
            if (frac < 0.1 && s > 0) tone = tones[s - 1] + (tones[s] - tones[s - 1]) * (0.5 + frac * 5)
            else if (frac > 0.9 && s < 78) tone = tones[s] + (tones[s + 1] - tones[s]) * ((frac - 0.9) * 5)
            ph += 2 * PI * (baseHz + tone * 6.25) / rate; if (ph > 2 * PI) ph -= 2 * PI
            out[i] = (amplitude * sin(ph)).toFloat()
        }
        return out
    }
}
