package com.rocketgod.mayhem.core.ham

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.IqProcessor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The HAM channel receiver: one narrowband channel anywhere inside the HackRF's span, demodulated properly.
 * Twin of web/src/dsp/ham/demod.ts.
 *
 *   IQ ─ NCO (channel → DC) ─ [CIC above 3.84 Msps] ─ FIR/8 ─ FIR/b ─ [sinc resampler] → 48 k complex baseband
 *     USB / LSB / CW : complex band-pass (phasing method) → real audio
 *     AM             : channel low-pass → envelope → DC block
 *     NFM            : channel low-pass → discriminator → CTCSS/DCS tap → de-emphasis → 3 kHz low-pass, squelch
 *     WFM            : discriminated on the wide stage, boxcar to the audio rate, 75 µs de-emphasis
 *   then AGC (fast / slow / off) → noise reduction → auto-notch → level → 48 kHz audio.
 *
 * Unlike the packet decoders this processor owns the speaker: [producesAudio] tells [com.rocketgod.mayhem.core.SdrEngine]
 * to play what [drainAudio] hands back instead of running its own demodulator.
 *
 * Android runs the HackRF at 2 Msps (the rate a HackRF Pro is clean at) where the web app uses 1.92, so the
 * baseband comes out at 50 k and is resampled to exactly 48 k before any demodulator or decoder sees it: CW,
 * RTTY, PSK31, FT8, SSTV, DMR, APT and packet all count samples per symbol at 48 k. The wide stage is likewise
 * resampled to 240 k for [iqTaps].
 *
 * Settings arrive from the UI thread through [set] but every filter and phasor lives on the DSP thread, so a
 * change is parked in [pending] and applied at the top of the next buffer rather than rebuilt mid-stream.
 */
/** A consumer of the raw NFM discriminator (before de-emphasis) at 48 k: DMR, APT, packet. */
interface FmTap {
    fun onFm(samples: FloatArray, n: Int, rate: Double)
    /** The NFM channel half-width this tap needs (9600 baud packet wants more than voice). */
    val minHalf: Double get() = 0.0
}

/** A consumer of the 240 kHz complex baseband after the first decimator (wideband digital: LRPT). */
interface IqTap { fun onIq240(buf: FloatArray, n: Int) }

class HamDemod : IqProcessor {
    enum class Mode { USB, LSB, CW, AM, NFM, WFM }
    enum class AgcMode { OFF, FAST, SLOW }

    data class Params(
        val offsetHz: Double = 0.0,   // channel carrier relative to the LO
        val mode: Mode = Mode.USB,
        val lo: Double = 100.0,       // audio pass band, Hz (SSB: lo..hi; AM/NFM: hi is the half bandwidth)
        val hi: Double = 2800.0,
        val pitch: Double = 600.0,    // CW side tone
        val agc: AgcMode = AgcMode.SLOW,
        val nr: Boolean = false,
        val anf: Boolean = false,
        val squelchDb: Int = 0,       // NFM only: 0 = open
        val volume: Float = 1f,
    )

    /** What the S-meter and the status line show, refreshed about ten times a second. */
    data class Meter(
        val db: Float = -120f,
        val floor: Float = -120f,
        val open: Boolean = true,
        val tone: Double = 0.0,
        val toneDb: Double = 0.0,
        val dcs: Int = 0,
        val dcsInverted: Boolean = false,
        val agcGain: Float = 1f,
        val audioPeak: Float = 0f,
    ) {
        /** Something is on the channel, 6 dB over the tracked floor, whatever the squelch is set to. */
        val carrier: Boolean get() = db > floor + 6
    }

    override val producesAudio = true

    private val _meter = MutableStateFlow(Meter())
    val meter: StateFlow<Meter> = _meter.asStateFlow()

    @Volatile private var pending: Params? = null
    var params = Params(); private set

    /** Digital decoders fed with the demodulated audio (after AGC, before NR / notch / volume). */
    @Volatile var digital: List<DigitalDecoder> = emptyList()
    @Volatile var iqTaps: List<IqTap> = emptyList()
    @Volatile private var fmTaps: List<FmTap> = emptyList()
    @Volatile private var minHalf = 0.0
    /** Mute the analog audio: a digital voice decoder is supplying the audio instead, through [inject]. */
    @Volatile var analogMute = false

    fun setFmTaps(taps: List<FmTap>) {
        fmTaps = taps
        minHalf = taps.maxOfOrNull { it.minHalf } ?: 0.0
    }

    /** Something is on the channel (6 dB over the tracked floor), regardless of the squelch setting. */
    val carrier: Boolean get() = lastDb > floorDb + 6
    /** CTCSS tone being received (0 = none): a sure sign of an analog voice channel. */
    val tone: Double get() = sub.tone

    private var rate = 0
    private val mixer = Mixer(1_920_000.0)
    private var pre: Cic3Decimator? = null
    private var stageA = ComplexFirDecimator(lowpassTaps(0.45 / 8, 63), 8)
    private var stageB = ComplexFirDecimator(lowpassTaps(0.42, 63), 1)
    private var interRate = AUDIO_RATE
    private var chan = ComplexFirDecimator(lowpassTaps(0.1, 127), 1)
    private var ssb = ComplexBandpassToReal(complexBandpassTaps(100.0, 2800.0, AUDIO_RATE, 255))
    private var audioLp = RealFir(lowpassTaps(3000.0 / AUDIO_RATE, 63))
    private var narrowRs: SincResampler? = null
    private var wideRs: SincResampler? = null
    private var narrowRate = AUDIO_RATE
    private var wideRate = 240_000.0
    private val agc = Agc(AUDIO_RATE)
    private val nr = NoiseReducer()
    private val anf = AutoNotch()
    private val dcAudio = DcBlock(0.995f)
    private val sub = SubAudioDecoder(AUDIO_RATE)

    private var tmp = FloatArray(0)
    private var bufPre = FloatArray(0)
    private var bufA = FloatArray(0)
    private var buf48 = FloatArray(0)
    private var bufC = FloatArray(0)
    private var bufR = FloatArray(0)
    private var bufW = FloatArray(0)
    private var audio = FloatArray(0)
    private var audio2 = FloatArray(0)

    /** The channel sits outside the sampled span: nothing to demodulate. */
    private var offRange = false
    private var prevI = 0f; private var prevQ = 0f; private var deemph = 0f
    private var wfmDecim = 1; private var wfmDeCoef = 0.25f
    private var wfmRs: SincResampler? = null
    private var wfmAcc = 0f; private var wfmCnt = 0; private var wfmDeemph = 0f
    private var audioPeak = 0f
    private var chPow = 0.0; private var chN = 0
    @Volatile private var floorDb = Float.NaN; private var sqOpen = true; private var lastMeter = 0L
    @Volatile private var lastDb = -200f
    private var filterKey = ""

    // Finished 48 kHz audio waiting for SdrEngine to play it. Sized for several buffers of slack.
    private val out = FloatArray(48_000)
    private var outLen = 0

    /** Called from any thread; takes effect at the start of the next IQ buffer. */
    fun set(p: Params) { pending = p }

    private val jobs = java.util.concurrent.ConcurrentLinkedQueue<() -> Unit>()
    /** Run [job] on the DSP thread before the next buffer: decoder resets and swaps never land mid-buffer. */
    fun onDsp(job: () -> Unit) { jobs.add(job) }

    private fun apply(p: Params) {
        val agcChanged = p.agc != params.agc
        params = p
        offRange = rate > 0 && abs(p.offsetHz) > rate / 2.0 - 40_000
        mixer.setFreq(p.offsetHz - if (p.mode == Mode.CW) p.pitch else 0.0)
        rebuildFilters()
        if (agcChanged || p.agc != AgcMode.OFF) setAgcSpeed(p.agc)
    }

    private fun setAgcSpeed(a: AgcMode) {
        if (a == AgcMode.FAST) agc.setSpeed(120.0, 60.0) else agc.setSpeed(600.0, 300.0)
    }

    override fun reset(rate: Int) {
        this.rate = rate
        offRange = abs(params.offsetHz) > rate / 2.0 - 40_000
        mixer.setRate(rate.toDouble())
        mixer.setFreq(params.offsetHz - if (params.mode == Mode.CW) params.pitch else 0.0)
        // wide spans first come down to 1.92 M through a cheap third-order CIC
        val preD = if (rate > 3_840_000) max(2, (rate / 1_920_000.0).roundToInt()) else 1
        pre = if (preD > 1) Cic3Decimator(preD) else null
        val base = rate.toDouble() / preD
        // base → ~48 k in two stages: /8 then /(rest); 1.92 M → 240 k → 48 k exactly, 2 M → 250 k → 50 k → resampled
        val a = 8
        val b = max(1, (base / a / AUDIO_RATE).roundToInt())
        stageA = ComplexFirDecimator(lowpassTaps(0.45 / a, 63), a)
        stageB = ComplexFirDecimator(lowpassTaps(0.42 / b, 63), b)
        wideRate = base / a
        narrowRate = base / a / b
        interRate = AUDIO_RATE
        wfmDecim = b   // the wide stage box-averages by b down to narrowRate
        wfmDeCoef = (1 - exp(-1 / (narrowRate * 75e-6))).toFloat()
        val exact = abs(narrowRate - AUDIO_RATE) < 1
        narrowRs = if (exact) null else SincResampler(narrowRate, AUDIO_RATE, 2)
        wfmRs = if (exact) null else SincResampler(narrowRate, AUDIO_RATE, 1)
        wideRs = if (abs(wideRate - 240_000.0) < 1) null else SincResampler(wideRate, 240_000.0, 2, 24)
        filterKey = ""; rebuildFilters()
        audioLp = RealFir(lowpassTaps(3000.0 / interRate, 63))
        setAgcSpeed(params.agc)
        nr.reset(); anf.reset(); sub.reset(interRate)
        prevI = 0f; prevQ = 0f; deemph = 0f; wfmAcc = 0f; wfmCnt = 0; wfmDeemph = 0f
        chPow = 0.0; chN = 0; floorDb = Float.NaN; outLen = 0
        Diag.log("HAM: %.2f Msps%s → %.0f Hz baseband%s".format(
            rate / 1e6, if (pre != null) " → CIC/$preD" else "", narrowRate,
            if (narrowRs != null) " (resampled to 48 k)" else ""))
    }

    private fun rebuildFilters() {
        val p = params; val r = interRate
        val mh = minHalf
        val key = "${p.mode}|${p.lo}|${p.hi}|${p.pitch}|$r|$mh"
        if (key == filterKey) return
        filterKey = key
        // WFM never touches the 48 kHz channel filters: its 100 kHz half-width is past that rate's Nyquist and
        // it is demodulated on the wide stage instead, so leave the narrow filters as they were.
        if (p.mode == Mode.WFM) return
        val taps = 255
        when (p.mode) {
            Mode.USB -> ssb = ComplexBandpassToReal(complexBandpassTaps(p.lo, p.hi, r, taps))
            Mode.LSB -> ssb = ComplexBandpassToReal(complexBandpassTaps(-p.hi, -p.lo, r, taps))
            Mode.CW -> {
                val w = max(50.0, p.hi - p.lo)
                ssb = ComplexBandpassToReal(complexBandpassTaps(p.pitch - w / 2, p.pitch + w / 2, r, taps))
            }
            else -> {}
        }
        val half = if (p.mode == Mode.NFM) maxOf(4000.0, p.hi, mh) else max(2000.0, p.hi)
        chan = ComplexFirDecimator(lowpassTaps(half / r, 127), 1)
    }

    /**
     * Broadcast FM on the wide stage: [buf] is the complex baseband after the first decimator (240 kHz at
     * 1.92 Msps, 250 kHz at 2 — always enough for ±75 kHz deviation). Discriminate every sample, box-average
     * [wfmDecim] of them to the narrow rate (the boxcar's first null sits exactly on that rate, so it is also the
     * anti-alias), then 75 µs de-emphasis. Returns audio samples written, at the narrow rate.
     */
    private fun demodWfm(buf: FloatArray, n: Int, dst: FloatArray): Int {
        var m = 0
        for (i in 0 until n) {
            val ci = buf[2 * i]; val cq = buf[2 * i + 1]
            val d = atan2(cq * prevI - ci * prevQ, ci * prevI + cq * prevQ)
            prevI = ci; prevQ = cq
            chPow += (ci * ci + cq * cq).toDouble(); chN++
            wfmAcc += d
            if (++wfmCnt >= wfmDecim) {
                val v = wfmAcc / wfmCnt; wfmAcc = 0f; wfmCnt = 0
                wfmDeemph += wfmDeCoef * (v - wfmDeemph)
                // Full broadcast deviation is ~2 rad/sample at 240 k; programme material after de-emphasis sits
                // well under that, so this lands it around half scale with headroom for the AGC or volume.
                dst[m++] = wfmDeemph * 1.6f
            }
        }
        return m
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        while (true) { val j = jobs.poll() ?: break; runCatching { j() } }
        pending?.let { pending = null; apply(it) }
        if (rate != this.rate) reset(rate)
        rebuildFilters()                      // picks up a tap's channel width; a no-op when nothing changed
        if (offRange) return
        val n = len / 2
        if (tmp.size < 2 * n) {
            tmp = FloatArray(2 * n)
            bufPre = FloatArray(2 * ceil(n / 2.0).toInt() + 8)
            bufA = FloatArray(2 * ceil(n / 8.0).toInt() + 8)
            buf48 = FloatArray(bufA.size); bufC = FloatArray(bufA.size); bufR = FloatArray(bufA.size)
            bufW = FloatArray(bufA.size + 64)
            audio = FloatArray(bufA.size); audio2 = FloatArray(bufA.size)
        }
        mixer.process(iq, n, tmp)
        var src = tmp; var nPre = n
        pre?.let { nPre = it.process(tmp, n, bufPre); src = bufPre }
        val nA = stageA.process(src, nPre, bufA)
        val taps = iqTaps
        if (taps.isNotEmpty()) {
            val w = wideRs
            if (w == null) for (t in taps) t.onIq240(bufA, nA)
            else { val k = w.process(bufA, nA, bufW); for (t in taps) t.onIq240(bufW, k) }
        }
        val p = params
        val o = audio
        var m: Int
        if (p.mode == Mode.WFM) {
            m = demodWfm(bufA, nA, o)
            wfmRs?.let { m = it.process(o, m, audio2); System.arraycopy(audio2, 0, o, 0, m) }
            if (m == 0) return
        } else {
            var nB = stageB.process(bufA, nA, buf48)
            var x = buf48
            narrowRs?.let { nB = it.process(buf48, nB, bufR); x = bufR }
            if (nB == 0) return
            m = nB
            if (p.mode == Mode.USB || p.mode == Mode.LSB || p.mode == Mode.CW) {
                ssb.process(x, nB, o)
                var pw = 0.0; for (i in 0 until nB) pw += o[i] * o[i]
                chPow += pw; chN += nB
            } else {
                chan.process(x, nB, bufC)
                val c = bufC
                var pw = 0.0; for (i in 0 until nB) pw += c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1]
                chPow += pw; chN += nB
                if (p.mode == Mode.AM) {
                    for (i in 0 until nB) o[i] = sqrt(c[2 * i] * c[2 * i] + c[2 * i + 1] * c[2 * i + 1])
                    dcAudio.process(o, nB)
                } else { // NFM
                    for (i in 0 until nB) {
                        val ci = c[2 * i]; val cq = c[2 * i + 1]
                        o[i] = atan2(cq * prevI - ci * prevQ, ci * prevI + cq * prevQ)
                        prevI = ci; prevQ = cq
                    }
                    sub.push(o, nB)
                    for (tap in fmTaps) tap.onFm(o, nB, interRate)
                    val a = (1 - exp(-1 / (interRate * 530e-6))).toFloat()
                    for (i in 0 until nB) { deemph += a * (o[i] - deemph); o[i] = deemph * 0.6f }
                    audioLp.process(o, nB, audio2); System.arraycopy(audio2, 0, o, 0, nB)
                }
            }
        }

        // metering + squelch on the channel power
        val now = System.currentTimeMillis()
        if (now - lastMeter > 100 && chN > 0) {
            lastMeter = now
            val db = (10 * log10(chPow / chN / (127.0 * 127.0) + 1e-12)).toFloat()
            chPow = 0.0; chN = 0; lastDb = db
            floorDb = if (floorDb.isNaN()) db else if (db < floorDb) floorDb + 0.2f * (db - floorDb) else floorDb + 0.003f * (db - floorDb)
            val open = p.squelchDb == 0 || p.mode != Mode.NFM || db > floorDb + p.squelchDb
            sqOpen = open
            _meter.value = Meter(db, floorDb, open, sub.tone, sub.toneDb, sub.dcs, sub.dcsInverted, agc.gain, audioPeak)
            audioPeak = 0f
        }

        if (p.mode != Mode.NFM) dcAudio.process(o, m)
        if (p.agc != AgcMode.OFF) agc.process(o, m)
        else { val k = if (p.mode == Mode.NFM || p.mode == Mode.WFM) 1f else 1f / 64; for (i in 0 until m) o[i] *= k }
        for (d in digital) d.push(o, m)
        if (p.nr) nr.process(o, m)
        if (p.anf) anf.process(o, m)
        val g = (if (sqOpen && !analogMute) 1f else 0f) * p.volume
        for (i in 0 until m) {
            val v = o[i] * g
            val c = if (v > 1f) 1f else if (v < -1f) -1f else v
            o[i] = c
            val av = if (c < 0) -c else c
            if (av > audioPeak) audioPeak = av
        }
        // A digital voice mode owns the audio through inject(): writing silence here as well would fill the
        // buffer at twice real time and the overflow rule would throw away whole chunks of decoded speech.
        if (analogMute) return
        write(o, m)
    }

    /** Decoded digital voice (DMR / P25) at 48 kHz, played in place of the analog audio. Same thread as onIq. */
    fun inject(pcm: FloatArray, n: Int) {
        val v = params.volume
        var i = 0
        while (i < n) {
            val k = minOf(n - i, injBuf.size)
            for (j in 0 until k) injBuf[j] = (pcm[i + j] * v).coerceIn(-1f, 1f)
            write(injBuf, k); i += k
        }
    }
    private val injBuf = FloatArray(2048)

    private fun write(src: FloatArray, m: Int) {
        // Overrun means SdrEngine fell behind; drop the oldest rather than block the DSP thread.
        if (outLen + m > out.size) outLen = 0
        System.arraycopy(src, 0, out, outLen, m); outLen += m
    }

    override fun drainAudio(dst: FloatArray, max: Int): Int {
        val k = minOf(max, outLen)
        System.arraycopy(out, 0, dst, 0, k)
        if (k < outLen) System.arraycopy(out, k, out, 0, outLen - k)
        outLen -= k
        return k
    }

    companion object { const val AUDIO_RATE = 48_000.0 }
}
