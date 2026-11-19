package com.rocketgod.mayhem.core.js8

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.ham.DigitalDecoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * JS8 receiver: every speed, every signal in the passband, at once. Twin of web/src/dsp/js8/decoder.ts.
 *
 * 48 kHz USB audio is resampled to each speed's working rate (12.8 kHz for Slow and Normal, 10.24 kHz for Fast and
 * Turbo, so a symbol is a power-of-two number of samples). Each slot of each speed is cut from a ring by the device
 * clock, turned into a log-power grid (FFT two symbols long, bins half a tone apart, a quarter-symbol step), searched
 * for the three Costas blocks across time and offset, and each candidate's 58 data tones give 174 soft bits for the
 * (174,87) LDPC decoder and the CRC-12. A second pass runs with the decoded signals taken out of the grid.
 */
class Js8Decode(
    val mode: Js8Speed,
    /** Slot start, epoch ms. */
    val slotMs: Long,
    /** Audio offset of tone 0, Hz. */
    val hz: Double,
    val snr: Int,
    /** Start time against the nominal one, seconds. */
    val dt: Double,
    /** Frequency drift across the frame, Hz per minute. */
    val drift: Double,
    val raw: String,
    val flags: Int,
    val frame: Js8Frame,
    val tones: IntArray,
)

private const val IN_RATE = 48_000
private const val TIME_OSR = 4
private const val FREQ_OSR = 4
private const val F_LO = 100.0
private const val F_HI = 3100.0

/** Streaming rational resampler (windowed sinc, polyphase). */
class Js8Resampler(inRate: Int, outRate: Int, taps: Int = 48) {
    private val phases = ArrayList<FloatArray>()
    private val hist = FloatArray(taps)
    private var hpos = 0; private var acc = 0.0; private var phase = 0
    private val step = inRate.toDouble() / outRate
    init {
        var den = 1; while (den < 256 && abs(step * den - (step * den).roundToLong()) > 1e-9) den++
        val fc = 0.42 * outRate / inRate; val half = taps / 2
        for (ph in 0 until den) {
            val frac = (ph * step) % 1; val k = FloatArray(taps); var sum = 0.0
            for (t in 0 until taps) {
                val x = t - half + 1 - frac
                val s = if (abs(x) < 1e-9) 2 * fc else sin(2 * PI * fc * x) / (PI * x)
                val w = 0.42 - 0.5 * cos(2 * PI * (t + 0.5 - frac) / taps) + 0.08 * cos(4 * PI * (t + 0.5 - frac) / taps)
                k[t] = (s * w).toFloat(); sum += k[t]
            }
            for (t in 0 until taps) k[t] = (k[t] / sum).toFloat()
            phases += k
        }
    }
    fun reset() { hist.fill(0f); hpos = 0; acc = 0.0; phase = 0 }
    /** Resamples [n] samples of [inp]; outputs go to [out] (room for n / step + 2), returns how many. */
    fun process(inp: FloatArray, n: Int, out: FloatArray, inOff: Int = 0): Int {
        val taps = hist.size; var o = 0
        for (i in 0 until n) {
            hist[hpos] = inp[inOff + i]; hpos = (hpos + 1) % taps
            if (++acc >= step) {
                acc -= step
                val k = phases[phase]; phase = (phase + 1) % phases.size
                var y = 0.0; var idx = hpos
                for (t in 0 until taps) { y += k[t] * hist[idx]; if (++idx >= taps) idx = 0 }
                out[o++] = y.toFloat()
            }
        }
        return o
    }
}

/** Search window around the nominal start, seconds (early, late). */
fun js8DtRange(m: Js8Mode): Pair<Double, Double> = when (m.id) { Js8Speed.TURBO -> -0.6 to 1.2; Js8Speed.FAST -> -1.0 to 1.8; else -> -1.5 to 2.5 }

/** A data frame carries at least one character and ends with its 0 and 1s; anything else decoded is taken as is. */
private fun plausible(f: Frame): Boolean { val u = Js8Msg.unpackFrame(f); return u.kind != "data" || !u.text.isNullOrEmpty() }
private fun max4(a: Double, b: Double, c: Double, d: Double) = max(if (a > b) a else b, if (c > d) c else d)

/** One speed's grid and search, on a buffer at the mode's working rate whose sample 0 is `t0` seconds into the slot. */
class Js8ModeDecoder(val mode: Js8Mode) {
    companion object { @JvmField var LLR_SCALE = 24.0; @JvmField var MIN_SCORE = 1.6 }
    private class Cand(val t: Int, val f: Int, val score: Float)
    val sym = symSamples(mode); val nfft = sym * FREQ_OSR; val step = sym / TIME_OSR
    val binHz = mode.fs.toDouble() / nfft; val bin0 = (F_LO / binHz).roundToInt(); val nBins = ((F_HI - F_LO) / binHz).roundToInt()
    private val re = FloatArray(nfft); private val im = FloatArray(nfft)
    private var grid = FloatArray(0); private var lin = FloatArray(0); private var nSteps = 0
    private val v8 = DoubleArray(8)
    private var floorCache = Double.NaN

    /** Decode a buffer whose sample 0 sits [t0] s after the slot boundary (t0 = delay + early edge of the DT search). */
    fun decode(buf: FloatArray, t0: Double, slotMs: Long, maxCands: Int = 160): List<Js8Decode> {
        buildGrid(buf)
        val out = ArrayList<Js8Decode>()
        val seen = HashSet<String>()
        for (pass in 0 until 2) {
            val cands = search(maxCands, if (pass > 0) MIN_SCORE * 0.75 else MIN_SCORE)
            var found = 0
            for (c in cands) {
                val (r, cc) = tryCand(c, t0, slotMs) ?: continue
                val key = "${r.raw}|${r.flags}|${(r.hz / (mode.spacing * 2)).roundToInt()}"
                if (key in seen || out.any { it.raw == r.raw && it.flags == r.flags && abs(it.hz - r.hz) < mode.spacing * 3 }) continue
                seen += key; out += r; found++
                subtract(cc, r.tones)
            }
            if (found == 0) break
        }
        return out.sortedBy { it.hz }
    }

    private fun buildGrid(buf: FloatArray) {
        val l = buf.size; val n = max(0, (l - nfft) / step + 1)
        nSteps = n
        if (grid.size < n * nBins) { grid = FloatArray(n * nBins); lin = FloatArray(n * nBins) }
        for (s in 0 until n) {
            val off = s * step
            for (i in 0 until nfft) { re[i] = if (i < sym) buf[off + i] else 0f; im[i] = 0f }
            Dsp.fft(re, im)
            val base = s * nBins
            for (b in 0 until nBins) { val k = bin0 + b; val p = re[k] * re[k] + im[k] * im[k]; lin[base + b] = p; grid[base + b] = (10 * log10(p + 1e-12)).toFloat() }
        }
    }
    private fun at(s: Int, b: Int): Float = if (s < 0 || s >= nSteps || b < 0 || b >= nBins) Float.NaN else grid[s * nBins + b]

    private fun sync(t: Int, f: Int): Float {
        // energy on the 21 sync tones against the mean of the other tones at the same symbols
        var on = 0.0; var off = 0.0; var cnt = 0
        val c = mode.costas; val g = lin
        for (blk in 0 until 3) for (k in 0 until 7) {
            val s = t + (36 * blk + k) * TIME_OSR
            if (s < 0 || s >= nSteps) continue
            val row = s * nBins + f; val tone = c[blk][k]
            var sum = 0.0; for (j in 0 until 8) sum += g[row + j * FREQ_OSR]
            val v = g[row + tone * FREQ_OSR].toDouble()
            on += v; off += (sum - v) / 7; cnt++
        }
        return if (cnt >= 14 && off > 0) (10 * log10(on / off)).toFloat() else -99f
    }
    private fun search(max: Int, minScore: Double): List<Cand> {
        val maxF = nBins - 7 * FREQ_OSR - 1; val maxT = nSteps - 1
        if (maxF < 0 || maxT < 0) return emptyList()
        val w = maxF + 1
        val scores = FloatArray((maxT + 1) * w) { -99f }
        val (early, late) = js8DtRange(mode)
        val tMax = ((late - early) * mode.fs / step).roundToInt()
        val tTop = min(tMax, maxT)
        for (t in 0..tTop) for (f in 0..maxF) scores[t * w + f] = sync(t, f)
        val list = ArrayList<Cand>()
        for (t in 0..tTop) for (f in 0..maxF) {
            val v = scores[t * w + f]
            if (v < minScore) continue
            // local maximum over ±1 bin and ±2 steps
            var peak = true
            var dt = -2
            while (dt <= 2 && peak) {
                for (df in -1..1) {
                    if (dt == 0 && df == 0) continue
                    val tt = t + dt; val ff = f + df; if (tt < 0 || tt > maxT || ff < 0 || ff > maxF) continue
                    if (scores[tt * w + ff] > v) { peak = false; break }
                }
                dt++
            }
            if (peak) list += Cand(t, f, v)
        }
        list.sortByDescending { it.score }
        return if (list.size > max) list.subList(0, max) else list
    }

    private fun tryCand(c0: Cand, t0: Double, slotMs: Long): Pair<Js8Decode, Cand>? {
        // the peak and its time neighbors
        for (dt in intArrayOf(0, -1, 1)) {
            val c = Cand(c0.t + dt, c0.f, c0.score)
            val llr = FloatArray(174)
            for (k in 0 until 58) {
                val s = c.t + Js8Codec.dataSym(k) * TIME_OSR
                val v = v8
                for (j in 0 until 8) { val x = at(s, c.f + j * FREQ_OSR); v[j] = if (x.isNaN()) 0.0 else x.toDouble() }
                llr[3 * k] = (max4(v[4], v[5], v[6], v[7]) - max4(v[0], v[1], v[2], v[3])).toFloat()
                llr[3 * k + 1] = (max4(v[2], v[3], v[6], v[7]) - max4(v[0], v[1], v[4], v[5])).toFloat()
                llr[3 * k + 2] = (max4(v[1], v[3], v[5], v[7]) - max4(v[0], v[2], v[4], v[6])).toFloat()
            }
            var s1 = 0.0; var s2 = 0.0; for (i in 0 until 174) { s1 += llr[i]; s2 += llr[i].toDouble() * llr[i] }
            val varr = s2 / 174 - (s1 / 174) * (s1 / 174); if (varr <= 0) continue
            val norm = sqrt(LLR_SCALE / varr); for (i in 0 until 174) llr[i] = (llr[i] * norm).toFloat()
            val cw = Js8Codec.ldpcDecode(llr, 40) ?: continue
            val frame = Js8Codec.checkInfo(cw, 87) ?: continue
            if (!plausible(frame)) continue
            return result(c, frame, t0, slotMs) to c
        }
        return null
    }

    private fun result(c: Cand, frame: Frame, t0: Double, slotMs: Long): Js8Decode {
        val tones = Js8Codec.frameTones(frame, mode.costas)
        // SNR: power on the sent tones against the median bin power, scaled to 2500 Hz
        var ps = 0.0; var n = 0
        for (k in 0 until 79) { val s = c.t + k * TIME_OSR; if (s < 0 || s >= nSteps) continue; ps += lin[s * nBins + c.f + tones[k] * FREQ_OSR]; n++ }
        ps /= max(1, n)
        val noise = noiseFloor()
        val snr = (10 * log10(max(1e-6, (ps - noise) / noise)) + 10 * log10(mode.spacing / 2500)).roundToInt()
        // offset and drift: where each sync block's energy peaks, within a tone either side, to a fraction of a bin
        val blockHz = DoubleArray(3)
        for (blk in 0 until 3) {
            val e = DoubleArray(2 * FREQ_OSR + 1)
            for (d in -FREQ_OSR..FREQ_OSR) {
                var sum = 0.0
                for (k in 0 until 7) {
                    val s = c.t + (36 * blk + k) * TIME_OSR; val b = c.f + mode.costas[blk][k] * FREQ_OSR + d
                    if (s in 0 until nSteps && b in 0 until nBins) sum += lin[s * nBins + b]
                }
                e[d + FREQ_OSR] = sum
            }
            var i = 1; for (j in 1 until e.size - 1) if (e[j] > e[i]) i = j
            val den = e[i - 1] - 2 * e[i] + e[i + 1]; val frac = if (den < 0) 0.5 * (e[i - 1] - e[i + 1]) / den else 0.0
            blockHz[blk] = (i - FREQ_OSR + max(-0.5, min(0.5, frac))) * binHz
        }
        val hz = (bin0 + c.f) * binHz + (blockHz[0] + blockHz[1] + blockHz[2]) / 3
        val drift = (blockHz[2] - blockHz[0]) / (72 * mode.symbol) * 60
        val dt = t0 + c.t * step.toDouble() / mode.fs - mode.delay
        val f = Js8Msg.unpackFrame(frame)
        return Js8Decode(mode.id, slotMs, (hz * 10).roundToInt() / 10.0, max(-30, min(40, snr)), (dt * 100).roundToInt() / 100.0,
            (drift * 10).roundToInt() / 10.0, Js8Codec.payloadToText(frame.payload), frame.flags, f, tones)
    }

    private fun noiseFloor(): Double {
        if (!floorCache.isNaN()) return floorCache
        val l = nSteps * nBins; val stride = max(1, l / 4000)
        val s = FloatArray((l + stride - 1) / stride); var k = 0
        var i = 0; while (i < l) { s[k++] = lin[i]; i += stride }
        val a = s.copyOf(k); a.sort()
        // the median of exponential power is ln 2 of its mean
        floorCache = if (k > 0) a[k shr 1] / LN_2 else 1e-12
        return floorCache
    }

    /** Take a decoded signal out of the grid so weaker ones beside and under it can be found. */
    private fun subtract(c: Cand, tones: IntArray) {
        val fl = noiseFloor() * LN_2
        val floorDb = (10 * log10(fl + 1e-12)).toFloat()
        for (k in 0 until 79) for (d in -TIME_OSR..TIME_OSR) {
            val s = c.t + k * TIME_OSR + d; if (s < 0 || s >= nSteps) continue
            for (db in -1..1) { val b = c.f + tones[k] * FREQ_OSR + db; if (b < 0 || b >= nBins) continue; grid[s * nBins + b] = floorDb; lin[s * nBins + b] = fl.toFloat() }
        }
    }
    /** Call before each slot so the noise floor is measured afresh. */
    fun resetFloor() { floorCache = Double.NaN }
}

/**
 * Streaming JS8 receiver over all four speeds. Audio in at 48 kHz (the HAM receiver's USB audio), decodes out per
 * slot. The slot buffers are cut on the audio thread; the search runs on its own low-priority thread, like FT8's.
 */
class Js8Decoder : DigitalDecoder {
    override val name = "JS8"
    @Volatile override var confidence = 0f; private set
    override var onText: (String, String?) -> Unit = { _, _ -> }
    /** Each slot's decodes, called from the decode thread. */
    var onDecodes: (List<Js8Decode>, Js8Speed, Long) -> Unit = { _, _, _ -> }
    /** A waterfall row of the audio passband (0-3200 Hz, 6.25 Hz bins, dB) every quarter second. */
    var onWaterfall: (FloatArray, Long) -> Unit = { _, _ -> }
    @Volatile var enabled: Map<Js8Speed, Boolean> = Js8Speed.entries.associateWith { true }
    /** The device clock; replaceable for tests. */
    var now: () -> Long = { System.currentTimeMillis() }
    /** Where a slot's search runs; tests run it in place. */
    var exec: (Runnable) -> Unit = { r -> if (pending.get() < 8) { pending.incrementAndGet(); worker.execute { try { r.run() } finally { pending.decrementAndGet() } } } }
    /** CPU spent on the last slot of each speed, ms (thread time). */
    val cpuMs = java.util.concurrent.ConcurrentHashMap<Js8Speed, Double>()

    private class Stream(val fs: Int) { val rs = Js8Resampler(IN_RATE, fs); val ring = FloatArray(fs * (if (fs == 12_800) 36 else 16)); var total = 0L; var t0 = 0.0 }
    private class ModeRx(val m: Js8Mode, val dec: Js8ModeDecoder, var last: Long, val stream: Int)
    private val streams = listOf(Stream(12_800), Stream(10_240))
    private val modes = JS8_MODES.map { ModeRx(it, Js8ModeDecoder(it), -1, if (it.fs == 12_800) 0 else 1) }
    private var wfAcc = 0L
    private val wfRe = FloatArray(2048); private val wfIm = FloatArray(2048)
    private val wfWin = FloatArray(2048) { (0.5 - 0.5 * cos(2 * PI * it / 2048)).toFloat() }
    private val rsOut = FloatArray(4096)
    private val pending = AtomicInteger(0)
    private val worker by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "js8").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } } }

    override fun reset() {
        for (s in streams) { s.rs.reset(); s.total = 0; s.t0 = 0.0; s.ring.fill(0f) }
        for (m in modes) m.last = -1
        confidence = 0f
    }

    override fun push(audio: FloatArray, n: Int) {
        val now = now()
        for (s in streams) {
            val l = s.ring.size
            var i = 0
            while (i < n) {
                val k = min(n - i, 4096)
                val o = s.rs.process(audio, k, rsOut, i)
                for (j in 0 until o) { s.ring[(s.total % l).toInt()] = rsOut[j]; s.total++ }
                i += k
            }
            val est = now - s.total.toDouble() / s.fs * 1000
            s.t0 = if (s.t0 == 0.0) est else s.t0 + 0.02 * (est - s.t0)
        }
        waterfall(now)
        for (md in modes) {
            if (enabled[md.m.id] == false) continue
            val p = md.m.period * 1000L; val late = js8DtRange(md.m).second
            val lag = (md.m.delay + frameSeconds(md.m) + late + 0.15) * 1000 + md.dec.nfft.toDouble() / md.m.fs * 1000
            val slot = floor((now - lag) / p).toLong() * p
            if (slot <= md.last) continue
            val first = md.last < 0; md.last = slot
            if (first) continue          // the slot in progress when audio started is partial
            decodeSlot(md, slot)
        }
    }

    private fun decodeSlot(md: ModeRx, slotMs: Long) {
        val s = streams[md.stream]; val m = md.m; val (early, late) = js8DtRange(m)
        val startMs = slotMs + (m.delay + early) * 1000
        val len = ((frameSeconds(m) + late - early) * m.fs).roundToInt() + md.dec.nfft
        val start = ((startMs - s.t0) / 1000 * s.fs).roundToLong()
        if (start < s.total - s.ring.size || start + len > s.total) return
        val buf = FloatArray(len); val l = s.ring.size
        for (i in 0 until len) { val k = start + i; buf[i] = if (k >= 0) s.ring[(k % l).toInt()] else 0f }
        exec(Runnable {
            try {
                val t = threadCpuNs()
                md.dec.resetFloor()
                val list = md.dec.decode(buf, m.delay + early, slotMs)
                cpuMs[m.id] = (threadCpuNs() - t) / 1e6
                confidence = if (list.isNotEmpty()) 1f else max(0f, confidence - 0.2f)
                for (r in list) onText("%s %3d %4.1f %4d  %s\n".format(java.util.Locale.US, m.label, r.snr, r.dt, r.hz.roundToInt(), r.frame.text ?: r.frame.kind), "JS8")
                onDecodes(list, m.id, slotMs)
            } catch (_: Throwable) {}
        })
    }

    private fun threadCpuNs(): Long = runCatching { android.os.Debug.threadCpuTimeNanos() }.getOrNull()?.takeIf { it > 0 } ?: System.nanoTime()

    private fun waterfall(now: Long) {
        val s = streams[0]
        if (s.total < 2048) return
        if (now - wfAcc < 250) return
        wfAcc = now
        val l = s.ring.size; val end = s.total
        for (i in 0 until 2048) { wfRe[i] = s.ring[((end - 2048 + i) % l).toInt()] * wfWin[i]; wfIm[i] = 0f }
        Dsp.fft(wfRe, wfIm)
        val row = FloatArray(512) { b -> (10 * log10(wfRe[b] * wfRe[b] + wfIm[b] * wfIm[b] + 1e-12)).toFloat() }
        onWaterfall(row, now)
    }

    companion object {
        /** Decode a whole slot of one speed from 48 kHz audio whose sample 0 is the slot boundary (tests, files). */
        fun decodeSlotAudio(audio48: FloatArray, speed: Js8Speed, slotMs: Long = 0): List<Js8Decode> {
            val m = js8Mode(speed)
            val rs = Js8Resampler(IN_RATE, m.fs)
            val all = FloatArray((audio48.size * m.fs.toDouble() / IN_RATE).toInt() + 8)
            var n = 0; var i = 0; val tmp = FloatArray(4096)
            while (i < audio48.size) { val k = min(4096, audio48.size - i); val o = rs.process(audio48, k, tmp, i); System.arraycopy(tmp, 0, all, n, o); n += o; i += k }
            val groupDelay = 24.0 / IN_RATE                     // half the resampler's taps
            val (early, late) = js8DtRange(m)
            val dec = Js8ModeDecoder(m)
            val start = ((m.delay + early + groupDelay) * m.fs).roundToInt()
            val len = ((frameSeconds(m) + late - early) * m.fs).roundToInt() + dec.nfft
            val buf = FloatArray(len)
            for (j in 0 until len) { val k = start + j; buf[j] = if (k in 0 until n) all[k] else 0f }
            return dec.decode(buf, m.delay + early, slotMs)
        }
    }
}
