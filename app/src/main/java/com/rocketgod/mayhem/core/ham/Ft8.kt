package com.rocketgod.mayhem.core.ham

import java.math.BigInteger
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * FT8 decoder (a port of the approach in ft8_lib by Kārlis Goba, MIT) and encoder. Twin of web/src/dsp/ham/ft8.ts
 * and ft8-encode.ts. 48 kHz audio is resampled to 12.8 kHz and chopped into 15 s UTC slots; a half-symbol-step
 * 4096-point Hann FFT with half-tone (3.125 Hz) bins builds the log-power waterfall; the three 7-symbol Costas
 * arrays are searched across time and frequency for sync candidates; each candidate's 58 data symbols yield 174
 * soft bits (Gray-mapped 8-FSK), LDPC(174,91) is decoded by belief propagation, the CRC-14 is checked and the
 * 77-bit payload unpacked (standard, non-standard, free text, telemetry, RTTY contest) with a callsign hash table
 * for the <...> references.
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

data class Ft8Decode(val utc: String, val snr: Int, val dt: Double, val hz: Int, val text: String)

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
    private val mag = FloatArray(NUM_BLOCKS * BLOCK_STRIDE)
    private val win = FloatArray(NFFT) { (0.5 - 0.5 * cos(2 * PI * it / NFFT)).toFloat() }
    private val re = FloatArray(NFFT)
    private val im = FloatArray(NFFT)
    private val hashes = HashMap<Int, String>()
    private val slotBuf = FloatArray(FS * SLOT_S)

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
        System.arraycopy(buf, 0, slotBuf, 0, min(buf.size, slotBuf.size))
        buildWaterfall()
        val cands = findCandidates(120, 5f)
        val results = ArrayList<Ft8Decode>()
        val seen = HashSet<Int>()
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = slotStartMs }
        val utc = "%02d%02d%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND))
        for (cd in cands) {
            val r = decodeCandidate(cd) ?: continue
            if (!seen.add(r.hash)) continue
            val hz = (BIN_MIN + cd.freqOffset + cd.freqSub.toDouble() / FREQ_OSR) * TONE_HZ
            val dt = (cd.timeOffset + cd.timeSub.toDouble() / TIME_OSR) * SYMBOL - 0.5
            results += Ft8Decode(utc, r.snr, (dt * 10).roundToInt() / 10.0, hz.roundToInt(), r.text)
        }
        results.sortByDescending { it.snr }
        return results
    }

    private fun buildWaterfall() {
        val l = slotBuf.size
        for (blk in 0 until NUM_BLOCKS) {
            for (ts in 0 until TIME_OSR) {
                val off = blk * BLOCK + ts * SUBBLOCK
                for (i in 0 until NFFT) { val s = off + i; re[i] = if (s < l) slotBuf[s] * win[i] else 0f; im[i] = 0f }
                fftInPlace(re, im, false)
                for (fs in 0 until FREQ_OSR) {
                    val base = ((blk * TIME_OSR + ts) * FREQ_OSR + fs) * NUM_BINS
                    for (b in 0 until NUM_BINS) {
                        val src = (BIN_MIN + b) * FREQ_OSR + fs
                        val p = re[src] * re[src] + im[src] * im[src]
                        mag[base + b] = (10 * log10(p + 1e-12)).toFloat()
                    }
                }
            }
        }
    }

    private class Cand(val timeSub: Int, val freqSub: Int, val timeOffset: Int, val freqOffset: Int, var score: Float = 0f)

    private fun candMag(c: Cand) = ((c.timeOffset * TIME_OSR + c.timeSub) * FREQ_OSR + c.freqSub) * NUM_BINS + c.freqOffset

    private fun syncScore(c: Cand): Float {
        val base = candMag(c)
        var score = 0f; var num = 0
        for (m in 0 until 3) for (k in 0 until 7) {
            val block = 36 * m + k; val blockAbs = c.timeOffset + block
            if (blockAbs < 0) continue
            if (blockAbs >= NUM_BLOCKS) break
            val p = base + block * BLOCK_STRIDE; val sm = FT8_COSTAS[k]
            val v = mag[p + sm]
            if (sm > 0) { score += v - mag[p + sm - 1]; num++ }
            if (sm < 7) { score += v - mag[p + sm + 1]; num++ }
            if (k > 0 && blockAbs > 0) { score += v - mag[p + sm - BLOCK_STRIDE]; num++ }
            if (k + 1 < 7 && blockAbs + 1 < NUM_BLOCKS) { score += v - mag[p + sm + BLOCK_STRIDE]; num++ }
        }
        return if (num > 0) score / num else 0f
    }

    private fun findCandidates(maxN: Int, minScore: Float): List<Cand> {
        val heap = ArrayList<Cand>()
        for (ts in 0 until TIME_OSR) for (fs in 0 until FREQ_OSR) for (to in -10 until 20) {
            var fo = 0
            while (fo + 7 < NUM_BINS) {
                val c = Cand(ts, fs, to, fo)
                c.score = syncScore(c)
                fo++
                if (c.score < minScore) continue
                if (heap.size < maxN) { heap.add(c); if (heap.size == maxN) heap.sortBy { it.score } }
                else if (c.score > heap[0].score) {
                    heap[0] = c
                    var i = 0
                    while (i + 1 < heap.size && heap[i + 1].score < heap[i].score) { val t = heap[i]; heap[i] = heap[i + 1]; heap[i + 1] = t; i++ }
                }
            }
        }
        return heap.sortedByDescending { it.score }
    }

    private class Decoded(val text: String, val hash: Int, val snr: Int)

    private fun decodeCandidate(c: Cand): Decoded? {
        val log174 = FloatArray(N); val base = candMag(c)
        val s2 = FloatArray(8)
        for (k in 0 until ND) {
            val sym = k + if (k < 29) 7 else 14
            val block = c.timeOffset + sym; val bi = 3 * k
            if (block < 0 || block >= NUM_BLOCKS) { log174[bi] = 0f; log174[bi + 1] = 0f; log174[bi + 2] = 0f; continue }
            val p = base + sym * BLOCK_STRIDE
            for (j in 0 until 8) s2[j] = mag[p + FT8_GRAY[j]]
            log174[bi] = max4(s2[4], s2[5], s2[6], s2[7]) - max4(s2[0], s2[1], s2[2], s2[3])
            log174[bi + 1] = max4(s2[2], s2[3], s2[6], s2[7]) - max4(s2[0], s2[1], s2[4], s2[5])
            log174[bi + 2] = max4(s2[1], s2[3], s2[5], s2[7]) - max4(s2[0], s2[2], s2[4], s2[6])
        }
        // normalize to the experimentally found scale
        var sum = 0.0; var sum2 = 0.0
        for (i in 0 until N) { sum += log174[i]; sum2 += log174[i] * log174[i] }
        val variance = (sum2 - sum * sum / N) / N
        if (variance <= 0) return null
        val norm = sqrt(24 / variance).toFloat()
        for (i in 0 until N) log174[i] *= norm
        val plain = IntArray(N)
        if (bpDecode(log174, 20, plain) > 0) return null
        // the 91 payload+CRC bits; the CRC covers 82 bits (77 payload + 5 zeros)
        val a91 = IntArray(12)
        for (i in 0 until K) if (plain[i] != 0) a91[i shr 3] = a91[i shr 3] or (0x80 shr (i and 7))
        val crcExtracted = ((a91[9] and 0x07) shl 11) or (a91[10] shl 3) or (a91[11] shr 5)
        a91[9] = a91[9] and 0xF8; a91[10] = 0
        if (crc14(a91, 82) != crcExtracted) return null
        val text = unpack(a91.copyOfRange(0, 10)) ?: return null
        // SNR: Costas tone level over the slot's median, referenced to 2.5 kHz
        var sig = 0f; var cnt = 0
        for (m in 0 until 3) for (k in 0 until 7) {
            val block = 36 * m + k
            if (c.timeOffset + block < 0 || c.timeOffset + block >= NUM_BLOCKS) continue
            sig += mag[base + block * BLOCK_STRIDE + FT8_COSTAS[k]]; cnt++
        }
        val snr = (sig / max(1, cnt) - medianMag() - 26).roundToInt().coerceIn(-26, 40)
        return Decoded(text, crcExtracted, snr)
    }

    private fun medianMag(): Float {
        val s = ArrayList<Float>(mag.size / 97 + 1)
        var i = 0; while (i < mag.size) { s.add(mag[i]); i += 97 }
        s.sort(); return s[s.size shr 1]
    }

    // ---------------------------------------------------------------------------------------- unpacking
    private fun unpack(p: IntArray): String? {
        val i3 = (p[9] shr 3) and 7
        val n3 = ((p[8] shl 2) and 4) or ((p[9] shr 6) and 3)
        return when {
            i3 == 1 || i3 == 2 -> unpackStd(p, i3)
            i3 == 4 -> unpackNonStd(p)
            i3 == 0 && n3 == 0 -> unpackFree(p)
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
        save(call)
        return call
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
        if (decoded.length >= 3) save(decoded)
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

private fun max4(a: Float, b: Float, c: Float, d: Float) = max(max(a, b), max(c, d))

/** Belief-propagation LDPC decode; returns the number of failed parity checks (0 = codeword). */
private fun bpDecode(cw: FloatArray, maxIters: Int, plain: IntArray): Int {
    val tov = FloatArray(N * 3); val toc = FloatArray(M * 7)
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
                var t = 1f
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

private fun fastTanh(x: Float): Float {
    if (x < -4.97f) return -1f
    if (x > 4.97f) return 1f
    val x2 = x * x
    return x * (945 + x2 * (105 + x2)) / (945 + x2 * (420 + x2 * 15))
}

private fun fastAtanh(x: Float): Float {
    val x2 = x * x
    return x * (945 + x2 * (-735 + x2 * 64)) / (945 + x2 * (-1050 + x2 * 225))
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
