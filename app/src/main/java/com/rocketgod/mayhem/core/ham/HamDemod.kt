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
 *   IQ ─ NCO (channel → DC) ─ [CIC above 3.84 Msps] ─ FIR/8 ─ FIR/b → ~48 k complex baseband
 *     USB / LSB / CW : complex band-pass (phasing method) → real audio
 *     AM             : channel low-pass → envelope → DC block
 *     NFM            : channel low-pass → discriminator → CTCSS/DCS tap → de-emphasis → 3 kHz low-pass, squelch
 *     WFM            : discriminated on the wide stage, boxcar to the audio rate, 75 µs de-emphasis
 *   then AGC (fast / slow / off) → noise reduction → auto-notch → level → 48 kHz audio.
 *
 * Unlike the packet decoders this processor owns the speaker: [producesAudio] tells [com.rocketgod.mayhem.core.SdrEngine]
 * to play what [drainAudio] hands back instead of running its own demodulator.
 *
 * Settings arrive from the UI thread through [set] but every filter and phasor lives on the DSP thread, so a
 * change is parked in [pending] and applied at the top of the next buffer rather than rebuilt mid-stream.
 */
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

    private var rate = 0
    private val mixer = Mixer(1_920_000.0)
    private var pre: Cic3Decimator? = null
    private var stageA = ComplexFirDecimator(lowpassTaps(0.45 / 8, 63), 8)
    private var stageB = ComplexFirDecimator(lowpassTaps(0.42, 63), 1)
    private var interRate = AUDIO_RATE
    private var chan = ComplexFirDecimator(lowpassTaps(0.1, 127), 1)
    private var ssb = ComplexBandpassToReal(complexBandpassTaps(100.0, 2800.0, AUDIO_RATE, 255))
    private var audioLp = RealFir(lowpassTaps(3000.0 / AUDIO_RATE, 63))
    private var resampler: Resampler? = null
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
    private var audio = FloatArray(0)
    private var audio2 = FloatArray(0)

    /** The channel sits outside the sampled span: nothing to demodulate. */
    private var offRange = false
    private var prevI = 0f; private var prevQ = 0f; private var deemph = 0f
    private var wfmDecim = 1; private var wfmDeCoef = 0.25f
    private var wfmAcc = 0f; private var wfmCnt = 0; private var wfmDeemph = 0f
    private var audioPeak = 0f
    private var chPow = 0.0; private var chN = 0
    private var floorDb = Float.NaN; private var sqOpen = true; private var lastMeter = 0L
    private var filterKey = ""

    // Finished 48 kHz audio waiting for SdrEngine to play it. Sized for several buffers of slack.
    private val out = FloatArray(48_000)
    private var outLen = 0

    /** Called from any thread; takes effect at the start of the next IQ buffer. */
    fun set(p: Params) { pending = p }

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
        // base → ~48 k in two stages: /8 then /(rest); 1.92 M → 240 k → 48 k exactly, 2 M → 250 k → 50 k + resample
        val a = 8
        val b = max(1, (base / a / AUDIO_RATE).roundToInt())
        stageA = ComplexFirDecimator(lowpassTaps(0.45 / a, 63), a)
        stageB = ComplexFirDecimator(lowpassTaps(0.42 / b, 63), b)
        interRate = base / a / b
        wfmDecim = b   // the wide stage (base / a) box-averages by b down to interRate
        wfmDeCoef = (1 - exp(-1 / (interRate * 75e-6))).toFloat()
        resampler = if (abs(interRate - AUDIO_RATE) > 1) Resampler(AUDIO_RATE / interRate) else null
        filterKey = ""; rebuildFilters()
        audioLp = RealFir(lowpassTaps(3000.0 / interRate, 63))
        setAgcSpeed(params.agc)
        nr.reset(); anf.reset(); sub.reset(interRate)
        prevI = 0f; prevQ = 0f; deemph = 0f; wfmAcc = 0f; wfmCnt = 0; wfmDeemph = 0f
        chPow = 0.0; chN = 0; floorDb = Float.NaN; outLen = 0
        Diag.log("HAM: %.2f Msps%s → %.0f Hz baseband%s".format(
            rate / 1e6, if (pre != null) " → CIC/$preD" else "", interRate,
            if (resampler != null) " (resampled to 48 k)" else ""))
    }

    private fun rebuildFilters() {
        val p = params; val r = interRate
        val key = "${p.mode}|${p.lo}|${p.hi}|${p.pitch}|$r"
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
        val half = if (p.mode == Mode.NFM) max(4000.0, p.hi) else max(2000.0, p.hi)
        chan = ComplexFirDecimator(lowpassTaps(half / r, 127), 1)
    }

    /**
     * Broadcast FM on the wide stage: [buf] is the complex baseband after the first decimator (240 kHz at
     * 1.92 Msps — always enough for ±75 kHz deviation). Discriminate every sample, box-average [wfmDecim] of them
     * to the audio rate (the boxcar's first null sits exactly on that rate, so it is also the anti-alias), then
     * 75 µs de-emphasis. Returns audio samples written, at [interRate].
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
        pending?.let { pending = null; apply(it) }
        if (rate != this.rate) reset(rate)
        if (offRange) return
        val n = len / 2
        if (tmp.size < 2 * n) {
            tmp = FloatArray(2 * n)
            bufPre = FloatArray(2 * ceil(n / 2.0).toInt() + 8)
            bufA = FloatArray(2 * ceil(n / 8.0).toInt() + 8)
            buf48 = FloatArray(bufA.size); bufC = FloatArray(bufA.size)
            audio = FloatArray(bufA.size); audio2 = FloatArray(bufA.size * 2)
        }
        mixer.process(iq, n, tmp)
        var src = tmp; var nPre = n
        pre?.let { nPre = it.process(tmp, n, bufPre); src = bufPre }
        val nA = stageA.process(src, nPre, bufA)
        val p = params
        val o = audio
        var m: Int
        if (p.mode == Mode.WFM) {
            m = demodWfm(bufA, nA, o)
            if (m == 0) return
        } else {
            val nB = stageB.process(bufA, nA, buf48)
            if (nB == 0) return
            m = nB
            if (p.mode == Mode.USB || p.mode == Mode.LSB || p.mode == Mode.CW) {
                ssb.process(buf48, nB, o)
                var pw = 0.0; for (i in 0 until nB) pw += o[i] * o[i]
                chPow += pw; chN += nB
            } else {
                chan.process(buf48, nB, bufC)
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
            chPow = 0.0; chN = 0
            floorDb = if (floorDb.isNaN()) db else if (db < floorDb) floorDb + 0.2f * (db - floorDb) else floorDb + 0.003f * (db - floorDb)
            val open = p.squelchDb == 0 || p.mode != Mode.NFM || db > floorDb + p.squelchDb
            sqOpen = open
            _meter.value = Meter(db, floorDb, open, sub.tone, sub.toneDb, sub.dcs, sub.dcsInverted, agc.gain, audioPeak)
            audioPeak = 0f
        }

        if (p.mode != Mode.NFM) dcAudio.process(o, m)
        if (p.agc != AgcMode.OFF) agc.process(o, m)
        else { val k = if (p.mode == Mode.NFM || p.mode == Mode.WFM) 1f else 1f / 64; for (i in 0 until m) o[i] *= k }
        if (p.nr) nr.process(o, m)
        if (p.anf) anf.process(o, m)
        val g = (if (sqOpen) 1f else 0f) * p.volume
        for (i in 0 until m) {
            val v = o[i] * g
            val c = if (v > 1f) 1f else if (v < -1f) -1f else v
            o[i] = c
            val av = if (c < 0) -c else c
            if (av > audioPeak) audioPeak = av
        }
        val r = resampler
        if (r != null) { m = r.process(o, m, audio2); System.arraycopy(audio2, 0, o, 0, m) }
        // Overrun means SdrEngine fell behind; drop the oldest rather than block the DSP thread.
        if (outLen + m > out.size) outLen = 0
        System.arraycopy(o, 0, out, outLen, m); outLen += m
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
