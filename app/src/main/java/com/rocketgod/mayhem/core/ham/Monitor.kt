package com.rocketgod.mayhem.core.ham

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlin.math.atan2

/*
 * Whole-band monitor: every channel of a raster inside the span at once. Twin of web/src/dsp/ham/monitor.ts.
 *
 * A 4096-point FFT per buffer gives the power in each channel's slot; a per-channel noise floor (min-hold, slow
 * rise) turns that into an SNR; channels over the threshold open with hysteresis. Up to maxDemods open channels
 * get their own NFM demodulator (NCO → FIR → FIR → ~48 k → discriminator → de-emphasis → 3 kHz) with a CTCSS / DCS
 * decoder each, and their audio is mixed, or the newest one wins, or one the user locked plays alone. Nothing is
 * scanned, so nothing is missed.
 */

private const val FFT_N = 4096
private const val AUDIO_RATE = 48_000.0

private class ChannelDemod(rate: Double, offsetHz: Double, nMax: Int, val interRate: Double, decA: Int, decB: Int) {
    val mixer = Mixer(rate, offsetHz)
    val a = ComplexFirDecimator(lowpassTaps(0.42 / decA, if (decA >= 16) 127 else 63), decA)
    val b = ComplexFirDecimator(lowpassTaps(6000 / (rate / decA), 63), decB)
    val lp = RealFir(lowpassTaps(3000 / interRate, 47))
    val sub = SubAudioDecoder(interRate)
    private var prevI = 0f; private var prevQ = 0f; private var deemph = 0f
    private val na = ceil(nMax.toDouble() / decA).toInt() + 8
    val bufA = FloatArray(2 * na); val buf48 = FloatArray(2 * na); val audio = FloatArray(na); val audio2 = FloatArray(na)
    private val de = (1 - exp(-1 / (interRate * 530e-6))).toFloat()

    fun process(iq: ByteArray, n: Int, tmp: FloatArray): Int {
        mixer.process(iq, n, tmp)
        val nA = a.process(tmp, n, bufA)
        val nB = b.process(bufA, nA, buf48)
        val c = buf48; val out = audio
        for (i in 0 until nB) {
            val ci = c[2 * i]; val cq = c[2 * i + 1]
            out[i] = atan2(cq * prevI - ci * prevQ, ci * prevI + cq * prevQ)
            prevI = ci; prevQ = cq
        }
        sub.push(out, nB)
        for (i in 0 until nB) { deemph += de * (out[i] - deemph); out[i] = deemph * 1.2f }
        lp.process(out, nB, audio2); System.arraycopy(audio2, 0, out, 0, nB)
        return nB
    }
}

class BandMonitor : IqProcessor {
    enum class Listen { MIX, LATEST, LOCK }

    data class Params(
        val spacingHz: Int = 12_500, val originHz: Long = 144_000_000, val thresholdDb: Int = 8,
        val mode: Listen = Listen.MIX, val lock: Int = -1, val maxDemods: Int = 2, val volume: Float = 1f, val centreHz: Long = 146_000_000,
    )

    /** What the channel grid shows, about five times a second. */
    data class Report(
        val first: Long = 0, val spacing: Int = 12_500, val count: Int = 0, val snr: FloatArray = FloatArray(0),
        val open: List<Int> = emptyList(), val listening: List<Int> = emptyList(), val tones: Map<Int, Double> = emptyMap(),
        val dcs: Map<Int, Int> = emptyMap(), val since: List<Long> = emptyList(),
    )

    override val producesAudio = true
    @Volatile private var pending: Params? = null
    var params = Params(); private set
    private val _report = MutableStateFlow(Report())
    val report: StateFlow<Report> = _report.asStateFlow()

    private var rate = 0
    private val re = FloatArray(FFT_N); private val im = FloatArray(FFT_N)
    private val acc = FloatArray(FFT_N); private val pdb = FloatArray(FFT_N)
    private val win = FloatArray(FFT_N) { (0.5 - 0.5 * kotlin.math.cos(2 * Math.PI * it / (FFT_N - 1))).toFloat() }
    private var frames = 0
    private var chanHz = LongArray(0)
    private var chFloor = FloatArray(0)
    private var snr = FloatArray(0)
    private var open = BooleanArray(0)
    private var openedAt = LongArray(0)
    private var tones = DoubleArray(0)
    private var dcs = IntArray(0)
    private val demods = LinkedHashMap<Int, ChannelDemod>()
    private val order = ArrayList<Int>()
    private var tmp = FloatArray(0)
    private var mix = FloatArray(0)
    private var lastReport = 0L; private var lastPlan = ""
    private var decA = 8; private var decB = 5; private var interRate = AUDIO_RATE
    private var rs: SincResampler? = null
    private var rsOut = FloatArray(0)
    private val out = FloatArray(48_000); private var outLen = 0

    fun set(p: Params) { pending = p }

    override fun reset(rate: Int) {
        this.rate = rate
        decA = if (rate >= 3_000_000) 16 else 8
        decB = max(1, (rate.toDouble() / decA / AUDIO_RATE).roundToInt())
        interRate = rate.toDouble() / decA / decB
        rs = if (abs(interRate - AUDIO_RATE) > 1) SincResampler(interRate, AUDIO_RATE, 1) else null
        demods.clear(); order.clear(); frames = 0; acc.fill(0f); lastPlan = ""; outLen = 0
        plan()
        Diag.log("MONITOR: %.2f Msps · %d channels @ %.1f kHz".format(rate / 1e6, chanHz.size, params.spacingHz / 1e3))
    }

    /** Lay the channel raster over the current span. */
    private fun plan() {
        if (rate == 0) return
        val p = params; val half = rate / 2.0 - 40_000
        val key = "${p.centreHz}|$rate|${p.spacingHz}|${p.originHz}"
        if (key == lastPlan) return
        lastPlan = key
        val first = ceil((p.centreHz - half - p.originHz) / p.spacingHz).toLong()
        val last = floor((p.centreHz + half - p.originHz) / p.spacingHz).toLong()
        val n = max(0, (last - first + 1).toInt())
        chanHz = LongArray(n) { p.originHz + (first + it) * p.spacingHz }
        chFloor = FloatArray(n) { Float.NaN }; snr = FloatArray(n)
        open = BooleanArray(n); openedAt = LongArray(n); tones = DoubleArray(n); dcs = IntArray(n)
        demods.clear(); order.clear()
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        pending?.let { pending = null; params = it; plan() }
        if (rate != this.rate) reset(rate)
        val n = len / 2
        if (tmp.size < 2 * n) { tmp = FloatArray(2 * n); mix = FloatArray(n / 8 + 16); rsOut = FloatArray(n / 8 + 64) }
        // spectrum for the channel powers
        var off = 0
        while (off + FFT_N <= n && frames < 64) {
            var s = 2 * off
            for (k in 0 until FFT_N) {
                re[k] = ((iq[s].toInt() and 0xff) - 127.4f) * win[k]; im[k] = ((iq[s + 1].toInt() and 0xff) - 127.4f) * win[k]; s += 2
            }
            Dsp.fft(re, im)
            for (k in 0 until FFT_N) { val sh = (k + FFT_N / 2) % FFT_N; acc[k] += re[sh] * re[sh] + im[sh] * im[sh] }
            frames++; off += FFT_N
        }
        val now = System.currentTimeMillis()
        if (now - lastReport > 200 && frames > 0) {
            for (k in 0 until FFT_N) pdb[k] = (10 * log10(acc[k] / frames + 1e-12)).toFloat()
            acc.fill(0f); frames = 0
            measure(now)
            lastReport = now
            report(now)
        }
        // audio for the open channels
        val p = params
        val listening: List<Int> = when {
            p.mode == Listen.LOCK && p.lock >= 0 -> listOf(p.lock)
            p.mode == Listen.LATEST -> if (order.isNotEmpty()) listOf(order.last()) else emptyList()
            else -> order.takeLast(p.maxDemods)
        }.filter { it in chanHz.indices }
        for (k in listening) if (k !in demods) demods[k] = ChannelDemod(rate.toDouble(), (chanHz[k] - p.centreHz).toDouble(), n, interRate, decA, decB)
        for (k in demods.keys.toList()) if (k !in listening && !(open.getOrElse(k) { false } && demods.size <= p.maxDemods)) demods.remove(k)
        var m = 0; var voices = 0
        for (k in listening) {
            val d = demods[k] ?: continue
            val cnt = d.process(iq, n, tmp)
            tones[k] = d.sub.tone; dcs[k] = d.sub.dcs
            if (voices == 0) { System.arraycopy(d.audio, 0, mix, 0, cnt); m = cnt } else for (i in 0 until min(m, cnt)) mix[i] += d.audio[i]
            voices++
        }
        if (voices == 0) return
        val g = p.volume / sqrt(voices.toFloat())
        for (i in 0 until m) { val v = mix[i] * g; mix[i] = if (v > 1) 1f else if (v < -1) -1f else v }
        var src = mix
        rs?.let { m = it.process(mix, m, rsOut); src = rsOut }
        if (outLen + m > out.size) outLen = 0
        System.arraycopy(src, 0, out, outLen, m); outLen += m
    }

    override fun drainAudio(dst: FloatArray, max: Int): Int {
        val k = min(max, outLen)
        System.arraycopy(out, 0, dst, 0, k)
        if (k < outLen) System.arraycopy(out, k, out, 0, outLen - k)
        outLen -= k
        return k
    }

    /** Channel powers from the spectrum, floors, SNRs and open / close with hysteresis. */
    private fun measure(now: Long) {
        val n = chanHz.size; val binHz = rate.toDouble() / FFT_N; val p = params
        val halfBins = max(1, floor(p.spacingHz * 0.4 / binHz).toInt())
        for (k in 0 until n) {
            val c = ((chanHz[k] - p.centreHz) / binHz).roundToInt() + FFT_N / 2
            var s = 0.0; var cnt = 0
            for (b in max(1, c - halfBins)..min(FFT_N - 2, c + halfBins)) { s += 10.0.pow(pdb[b] / 10.0); cnt++ }
            val db = (10 * log10(s / max(1, cnt) + 1e-12)).toFloat()
            val f = chFloor[k]
            chFloor[k] = if (f.isNaN()) db else if (db < f) f + 0.3f * (db - f) else f + 0.004f * (db - f)
            snr[k] = db - chFloor[k]
            val was = open[k]
            val isOpen = if (was) snr[k] > p.thresholdDb - 3 else snr[k] > p.thresholdDb
            if (isOpen && !was) { open[k] = true; openedAt[k] = now; order.add(k) }
            else if (!isOpen && was) { open[k] = false; order.remove(k); tones[k] = 0.0; dcs[k] = 0 }
        }
    }

    private fun report(now: Long) {
        val openIdx = open.indices.filter { open[it] }
        _report.value = Report(
            chanHz.firstOrNull() ?: 0, params.spacingHz, chanHz.size, snr.copyOf(), openIdx, demods.keys.toList(),
            openIdx.filter { tones[it] > 0 }.associateWith { tones[it] }, openIdx.filter { dcs[it] != 0 }.associateWith { dcs[it] },
            openIdx.map { now - openedAt[it] },
        )
    }
}
