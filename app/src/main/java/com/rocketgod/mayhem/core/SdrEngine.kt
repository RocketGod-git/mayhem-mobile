package com.rocketgod.mayhem.core

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.audio.HdDetector
import com.rocketgod.mayhem.core.audio.HdReport
import com.rocketgod.mayhem.core.audio.RdsDecoder
import com.rocketgod.mayhem.core.audio.RdsState
import com.rocketgod.mayhem.core.audio.SameDecoder
import com.rocketgod.mayhem.core.audio.SameEvent
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.RtlSdr
import java.util.concurrent.ArrayBlockingQueue
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The DSP + state hub — a mini Mayhem `receiver_model` + baseband in Kotlin. [HackRfOne] streams raw 8-bit IQ
 * here via [onIq]; a worker thread turns it into (a) an FFT spectrum for the waterfall ([spectrum]), (b) demodulated
 * audio (WFM / NFM / AM / USB / LSB — cf. proc_wfm_audio / proc_nfm_audio / proc_am_audio) to an [AudioTrack],
 * and (c) feeds the active app's [IqProcessor] (raw IQ, plus the NFM discriminator stream for FM-borne packet
 * modes). The UI observes the flows and drives tuning / mode / gain, forwarded to the driver via [syncDriver].
 */
object SdrEngine {
    enum class Mode { WFM, NFM, AM, USB, LSB, NONE }

    private const val AUDIO_RATE = 48_000
    /** Default IQ sample rate. 2.0 Msps is the Pro-clean rate: the HackRF Pro's FPGA decimation only resolves
     *  cleanly here (2.4 Msps gave all-zeros / intermittent static). Apps may pick others (Looking Glass, ERT). */
    const val IQ_RATE = 2_000_000
    const val FREQ_MIN_HZ = 1_000_000L
    const val FREQ_MAX_HZ = 6_000_000_000L

    // The HackRF's own three gain stages, exactly as libhackrf exposes them (MAX2837 + front-end amp; ranges
    // cross-checked against mayhem-firmware max283x.hpp): amp 0/1 (+14 dB), LNA 0..40 step 8, VGA 0..62 step 2.
    const val LNA_MAX = 40; const val LNA_STEP = 8
    const val VGA_MAX = 62; const val VGA_STEP = 2

    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()
    private val _freqHz = MutableStateFlow(92_300_000L)
    val freqHz: StateFlow<Long> = _freqHz.asStateFlow()
    private val _mode = MutableStateFlow(Mode.WFM)
    val mode: StateFlow<Mode> = _mode.asStateFlow()
    private val _rateHz = MutableStateFlow(IQ_RATE)
    val rateHz: StateFlow<Int> = _rateHz.asStateFlow()
    /** Last audio-receiver dial / mode, restored when the Audio app is reopened. */
    @Volatile var radioFreqHz = 92_300_000L; private set
    @Volatile var radioMode = Mode.WFM; private set
    private val _radioLna = MutableStateFlow(24)
    val radioLna: StateFlow<Int> = _radioLna.asStateFlow()
    private val _radioVga = MutableStateFlow(24)
    val radioVga: StateFlow<Int> = _radioVga.asStateFlow()
    private val _radioAmp = MutableStateFlow(false)
    val radioAmp: StateFlow<Boolean> = _radioAmp.asStateFlow()

    /**
     * Automatic gain, on by default: hold the ADC level (iqRMS, once a second) where the 8-bit converter has both
     * headroom and resolution — under ~2 counts the spectrum is quantisation mush, over ~40 it clips. VGA moves first,
     * 2 dB at a time (8 when far off), then the LNA. Touching LNA or VGA by hand hands the gain back to the user.
     */
    private val _agc = MutableStateFlow(true)
    val agc: StateFlow<Boolean> = _agc.asStateFlow()
    private var prefs: android.content.SharedPreferences? = null
    /** A gain the user set by hand outranks every app's own default until it is changed again. */
    private var gainPref: IntArray? = null
    private var agcLast = 0L; private var agcSaidMax = 0L

    fun loadGains(ctx: android.content.Context) {
        val p = ctx.getSharedPreferences("mayhem", android.content.Context.MODE_PRIVATE); prefs = p
        p.getString("gains", null)?.split(',')?.mapNotNull { it.toIntOrNull() }?.takeIf { it.size == 4 }?.let { g ->
            gainPref = g.toIntArray(); _agc.value = g[3] == 1
        }
    }
    private fun saveGains() {
        val g = intArrayOf(_radioLna.value, _radioVga.value, if (_radioAmp.value) 1 else 0, if (_agc.value) 1 else 0)
        gainPref = g
        prefs?.edit()?.putString("gains", g.joinToString(","))?.apply()
    }
    fun setAgc(on: Boolean) { _agc.value = on; agcLast = 0; saveGains() }

    private fun isPro() = HackRfOne.boardLabel.contains("Pro", ignoreCase = true)
    /**
     * Per-app presets are written for a HackRF One. On a HackRF Pro the same settings leave the ADC under one count;
     * it needs about 28 dB more VGA for the same level, and LNA steps count for less, so the LNA is pinned at 40.
     */
    private fun boardGains(lna: Int, vga: Int, amp: Boolean): Triple<Int, Int, Boolean> =
        if (!isPro()) Triple(lna, vga, amp) else Triple(LNA_MAX, minOf(if (amp) 56 else VGA_MAX, vga + 28), amp)

    /** The board is known now: a Pro gets its stages raised unless the user has set them. */
    fun onBoard() {
        if (gainPref != null || !isPro()) return
        val (l, v, a) = boardGains(_radioLna.value, _radioVga.value, _radioAmp.value)
        _radioLna.value = l; _radioVga.value = (v / VGA_STEP) * VGA_STEP; _radioAmp.value = a; syncDriver()
    }

    /** Wider spans hold proportionally more total power at the same per-signal level, so they may sit hotter. */
    private fun agcStep(rms: Double, now: Long) {
        if (!_agc.value || HackRfOne.txActive || now - agcLast < 900) return
        agcLast = now
        val scale = minOf(3.2, kotlin.math.sqrt(sampleRate / 2_000_000.0))
        val lo = minOf(24.0, 7 * scale); val hi = minOf(34.0, 22 * scale)
        val l = _radioLna.value; val v = _radioVga.value
        val vMax = vgaMax(); val hasLna = Radio.kind.value != Radio.Kind.RTLSDR
        if (rms < lo) {
            when {
                v < vMax -> _radioVga.value = minOf(vMax, v + if (rms < 2) 8 else 2)
                hasLna && l < LNA_MAX -> _radioLna.value = l + LNA_STEP
                _mode.value != Mode.NONE && now - agcSaidMax > 20_000 -> {
                    agcSaidMax = now
                    Diag.log("AGC is at maximum and the level is still %.1f counts — check the antenna, or set the gain by hand".format(rms))
                }
            }
        } else if (rms > hi) {
            when {
                v > 0 -> _radioVga.value = maxOf(0, v - if (rms > hi * 2) 8 else 2)
                hasLna && l > 0 -> _radioLna.value = l - LNA_STEP
            }
        }
        if (_radioLna.value != l || _radioVga.value != v) syncDriver()
    }
    /**
     * Latest spectrum: [SPEC_BINS] normalised magnitudes 0..1, low→high frequency (fftshifted). Every sample that
     * arrives between frames is power-averaged through a 4096-point Hann FFT (about 2.4 M samples a second are
     * transformed whatever the rate), which pulls the noise spread down to a dB or two so a weak station stands out;
     * the floor is the median bin (robust to strong carriers) and the display covers [SPEC_RANGE_DB] above it.
     */
    private val _spectrum = MutableStateFlow(FloatArray(0))
    val spectrum: StateFlow<FloatArray> = _spectrum.asStateFlow()
    /** Once-per-second RX health line (iqRMS / DC / peak) for the UI. */
    private val _rxHealth = MutableStateFlow("")
    val rxHealth: StateFlow<String> = _rxHealth.asStateFlow()
    /** Peak-vs-average dB of the last diagnostic frame — a cheap "signal present" level meter. */
    private val _levelDb = MutableStateFlow(0f)
    val levelDb: StateFlow<Float> = _levelDb.asStateFlow()

    /** Squelch threshold in dB above the tracked channel noise floor; 0 = off. */
    private val _squelchDb = MutableStateFlow(0)
    val squelchDb: StateFlow<Int> = _squelchDb.asStateFlow()
    private val _squelchOpen = MutableStateFlow(true)
    val squelchOpen: StateFlow<Boolean> = _squelchOpen.asStateFlow()
    @Volatile private var sqOpen = true
    @Volatile private var sqFloor = Float.NaN

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()
    @Volatile private var muteNow = false
    fun toggleMute() { muteNow = !muteNow; _muted.value = muteNow }

    fun setSquelch(db: Int) {
        _squelchDb.value = db.coerceIn(0, 40)
        if (db <= 0) { sqOpen = true; _squelchOpen.value = true }
    }

    const val SPEC_BINS = 1024
    private const val FFT_N = 4096
    const val SPEC_RANGE_DB = 40f
    private const val SPEC_FLOOR_PAD_DB = 4f
    /** The dB the 0..1 spectrum is scaled against: (floor, range), for the spectrum's grid labels. */
    private val _specScale = MutableStateFlow(Float.NaN to SPEC_RANGE_DB)
    val specScale: StateFlow<Pair<Float, Float>> = _specScale.asStateFlow()

    /** Where the demodulator listens relative to the LO, so a channel can be heard without parking it on the DC spike. */
    private val _offsetHz = MutableStateFlow(0)
    val offsetHz: StateFlow<Int> = _offsetHz.asStateFlow()
    fun setOffset(hz: Int) { _offsetHz.value = hz }

    /** The signals in view with their modulation, refreshed ten times a second while [watchSignals] is on. */
    @Volatile var watchSignals = true
    private val _signals = MutableStateFlow<List<Signal>>(emptyList())
    val signals: StateFlow<List<Signal>> = _signals.asStateFlow()
    private val classifier = Classifier()

    /** Speech score of the demodulated audio, four times a second while [listenForVoice] is on. */
    @Volatile private var voiceOn = false
    private val voiceDet = VoiceDetector()
    private val _voice = MutableStateFlow<VoiceScore?>(null)
    val voice: StateFlow<VoiceScore?> = _voice.asStateFlow()
    /** RDS, from the WFM composite: station name, programme type, RadioText, alternative frequencies. */
    @Volatile private var rdsOn = false
    private val _rdsWanted = MutableStateFlow(false)
    val rdsWanted: StateFlow<Boolean> = _rdsWanted.asStateFlow()
    private val _rds = MutableStateFlow<RdsState?>(null)
    val rds: StateFlow<RdsState?> = _rds.asStateFlow()
    private val rdsDec = RdsDecoder { _rds.value = it }
    fun setRds(on: Boolean) { rdsOn = on; _rdsWanted.value = on; if (!on) _rds.value = null }

    /** Whether a WFM station carries HD Radio sidebands; detection only, the codec is proprietary. */
    @Volatile private var hdOn = false
    private val _hdWanted = MutableStateFlow(false)
    val hdWanted: StateFlow<Boolean> = _hdWanted.asStateFlow()
    private val _hd = MutableStateFlow<HdReport?>(null)
    val hd: StateFlow<HdReport?> = _hd.asStateFlow()
    private val hdDet = HdDetector { _hd.value = it }
    fun setHd(on: Boolean) { hdOn = on; _hdWanted.value = on; if (!on) _hd.value = null }

    /** NOAA Weather Radio / EAS alerts, watched on NFM while the Audio app is open. */
    @Volatile var sameOn = false
    private val _same = MutableStateFlow<SameEvent?>(null)
    val same: StateFlow<SameEvent?> = _same.asStateFlow()
    private val sameDec = SameDecoder { if (it.event != "tone") _same.value = it }
    fun dismissSame() { _same.value = null }

    fun listenForVoice(on: Boolean) { if (on != voiceOn) { voiceDet.reset(); _voice.value = null }; voiceOn = on }

    @Volatile private var sampleRate = IQ_RATE
    @Volatile var sourceLabel = "HackRF"
    @Volatile var processor: IqProcessor? = null; private set
    @Volatile private var worker: Thread? = null
    @Volatile private var stopWorker = false
    private val queue = ArrayBlockingQueue<ByteArray>(8)
    private val pool = ArrayBlockingQueue<ByteArray>(8)

    fun setActive(on: Boolean) {
        _active.value = on
        if (on) startWorker()
        else {
            stopWorker()
            _spectrum.value = FloatArray(0)
            _rxHealth.value = ""
        }
    }

    /** Called by the driver at start and after every sample-rate change. */
    fun onSource(rate: Int) { sampleRate = rate }

    /** Raw IQ from the USB thread (uint8 I,Q interleaved). Copies into an exact-size pooled buffer and enqueues;
     *  drops oldest on overrun to stay near-real-time. */
    fun onIq(buf: ByteArray, len: Int) {
        val dst = pool.poll()?.takeIf { it.size == len } ?: ByteArray(len)
        System.arraycopy(buf, 0, dst, 0, len)
        if (!queue.offer(dst)) {
            queue.poll()?.let { pool.offer(it) }
            queue.offer(dst)
        }
    }

    fun currentRate(): Int = sampleRate

    // ---- App / UI control ------------------------------------------------------------------------------------
    /** Push the current state into the driver's live-control fields (read at bring-up and between buffers). */
    fun syncDriver() {
        HackRfOne.targetRateHz = _rateHz.value
        HackRfOne.ovrLnaDb = _radioLna.value
        HackRfOne.ovrVgaDb = _radioVga.value
        HackRfOne.ovrAmp = if (_radioAmp.value) 1 else 0
        HackRfOne.targetFreqHz = _freqHz.value
        // A dongle has one tuner gain where a HackRF has three stages; the VGA is that knob, which is also the one
        // the AGC moves first, so the automatic gain drives a dongle with no special case.
        RtlSdr.targetRateHz = Radio.nearestRate(Radio.RTLSDR, _rateHz.value)
        RtlSdr.targetFreqHz = _freqHz.value
        RtlSdr.targetGainTenthDb = (_radioVga.value * 10).coerceIn(0, (RtlSdr.MAX_GAIN_DB * 10).toInt())
    }

    /** The top of the VGA knob for the radio attached: a dongle's tuner stops at 48.8 dB. */
    fun vgaMax(): Int = if (Radio.kind.value == Radio.Kind.RTLSDR) 48 else VGA_MAX

    /** A radio arrived or left: hold the rate and gain to what it can do, so the screen never shows what it is not doing. */
    fun onRadio(kind: Radio.Kind) {
        Radio.attached(kind)
        _rateHz.value = Radio.nearestRate(Radio.limits, _rateHz.value)
        _radioVga.value = minOf(_radioVga.value, vgaMax())
        syncDriver()
    }

    /** Enter an app: audio mode, dial, IQ rate, gain preset and the baseband processor, all at once. */
    fun configure(mode: Mode, freqHz: Long, rateHz: Int, lna: Int, vga: Int, amp: Boolean, proc: IqProcessor?) {
        processor = null
        _offsetHz.value = 0
        _mode.value = mode
        _rateHz.value = Radio.nearestRate(Radio.limits, rateHz)
        // Before the user has touched gain, no app starts below 32 on either stage and the front-end amp is on: AGC
        // (on by default) trims the stages if a strong signal would clip, so every app starts sensitive.
        val g = gainPref
        val (l, v, a) = boardGains(
            g?.get(0) ?: maxOf(lna, 32), g?.get(1) ?: maxOf(vga, 32), if (g != null) g[2] == 1 else true)
        _radioLna.value = (l.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP
        _radioVga.value = (v.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP
        _radioAmp.value = a
        _freqHz.value = freqHz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (proc == null && mode != Mode.NONE) { radioFreqHz = _freqHz.value; radioMode = mode }
        syncDriver()
        processor = proc
    }

    /** Whether the open app is a plain receiver, whose channel can move inside the span with the radio left still. */
    private fun channelInSpan() = processor == null && _mode.value != Mode.NONE

    /** Keep a tuned channel this far inside the span edge before the radio follows it. */
    private const val VIEW_GUARD = 100_000L

    /** The frequency being listened to: the radio's LO plus where the channel sits in the span. */
    fun channelHz(): Long = _freqHz.value + _offsetHz.value

    /**
     * Tune. A plain receiver moves its channel inside the span and the radio only follows when the channel leaves
     * it, so picking something already on the waterfall does not throw the waterfall sideways and wipe its
     * history. Everything else (decoders working on the raw samples) retunes the radio itself.
     */
    fun tune(hz: Long) {
        val f = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (!channelInSpan()) { tuneLo(f); return }
        val lo = _freqHz.value
        if (kotlin.math.abs(f - lo) > _rateHz.value / 2 - VIEW_GUARD) { tuneLo(f); _offsetHz.value = 0 }
        else _offsetHz.value = (f - lo).toInt()
        radioFreqHz = f
    }
    fun nudge(deltaHz: Long) = tune(channelHz() + deltaHz)

    /** Move the radio itself, leaving the channel offset alone. */
    fun tuneLo(hz: Long) {
        val f = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        _freqHz.value = f
        HackRfOne.targetFreqHz = f
        RtlSdr.targetFreqHz = f
    }

    /**
     * Slide the span: the radio's LO goes to [lo] while the channel keeps its frequency, so you can look further
     * along the band than the screen shows. It keeps playing while it is inside the span and goes quiet outside.
     */
    fun slideSpan(lo: Long) {
        if (!channelInSpan()) { tune(lo); return }
        val ch = channelHz()
        tuneLo(lo)
        _offsetHz.value = (ch - _freqHz.value).coerceIn(-(Int.MAX_VALUE.toLong()), Int.MAX_VALUE.toLong()).toInt()
    }

    /** ⌖: bring the view back to the channel. */
    fun recentre() { val ch = channelHz(); _offsetHz.value = 0; tuneLo(ch) }

    /** Where the Audio app opens next: set from the launcher, where a tap means "listen here". */
    fun setDial(hz: Long, mode: Mode) { radioFreqHz = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ); radioMode = mode }

    fun setRate(rate: Int) { _rateHz.value = Radio.nearestRate(Radio.limits, rate); syncDriver() }

    /** A hand on the LNA or VGA switches the AGC off so the setting sticks, and is remembered for every app. */
    fun setRadioLna(db: Int) {
        if (_agc.value) Diag.log("gain set by hand, so the automatic gain is off — tap AGC to hand it back")
        _agc.value = false; _radioLna.value = (db.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP; syncDriver(); saveGains()
    }
    fun setRadioVga(db: Int) {
        if (_agc.value) Diag.log("gain set by hand, so the automatic gain is off — tap AGC to hand it back")
        _agc.value = false; _radioVga.value = (db.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP; syncDriver(); saveGains()
    }
    fun toggleRadioAmp() { _radioAmp.value = !_radioAmp.value; syncDriver(); saveGains() }

    /** Audio mode switch (Audio app). */
    fun setMode(m: Mode) {
        _mode.value = m
        if (processor == null && m != Mode.NONE) radioMode = m
    }

    private fun startWorker() {
        if (worker != null) return
        stopWorker = false
        worker = Thread { workerLoop() }.apply { isDaemon = true; name = "sdr-dsp"; start() }
    }
    private fun stopWorker() {
        stopWorker = true
        worker?.interrupt(); worker = null
        queue.clear(); pool.clear()
    }

    // ---- DSP worker ---------------------------------------------------------------------------------------
    private fun workerLoop() {
        var track: AudioTrack? = null
        val fre = FloatArray(FFT_N); val fim = FloatArray(FFT_N)
        val win = FloatArray(FFT_N) { (0.5 - 0.5 * cos(2.0 * Math.PI * it / FFT_N)).toFloat() }
        val acc = DoubleArray(FFT_N); var frames = 0
        val pdb = FloatArray(FFT_N); val sorted = FloatArray(FFT_N)
        var prevOut = FloatArray(0); var specFrame = 0
        var clsRate = 0; var clsFreq = 0L; var clsQuietUntil = 0L
        var prevI = 0f; var prevQ = 0f                 // FM discriminator memory
        var deemph = 0f                                 // WFM de-emphasis one-pole memory
        var amDc = 0f                                   // AM DC blocker memory
        var wph = 0.0                                   // SSB (Weaver) BFO phase
        var lpI1 = 0f; var lpI2 = 0f; var lpQ1 = 0f; var lpQ2 = 0f   // SSB low-pass memories
        var decAcc = 0f; var decCnt = 0                 // stage-2 (audio) decimator accumulator
        var s1I = 0f; var s1Q = 0f; var s1n = 0        // stage-1 complex channel-filter (boxcar) accumulator
        val audioBuf = ShortArray(8192); var audioLen = 0
        val fmBuf = FloatArray(4096); var fmN = 0
        var lastSpec = 0L; var lastDiag = 0L
        var audioPeak = 0
        var prevMode: Mode? = null
        var lastProc: IqProcessor? = null; var lastProcRate = 0
        var chPow = 0.0; var chN = 0                     // channel power for the squelch
        var lastVol = -1f
        val procAudio = FloatArray(16384); val procPcm = ShortArray(16384)
        var ncoR = 1f; var ncoI = 0f; var ncoN = 0                 // channel-offset oscillator
        var lastVoice = 0L
        val rdsBuf = FloatArray(8192); var rdsN = 0; var rdsWas = false; var rdsFreq = 0L
        val sameBuf = FloatArray(4096); var sameN = 0; var sameWas = false
        var hdWas = false
        try {
            while (!stopWorker) {
                val item = try { queue.take() } catch (e: InterruptedException) { break }
                val len = item.size
                val nSamp = len / 2
                if (nSamp < 4) { pool.offer(item); continue }
                val m = _mode.value
                val rate = sampleRate
                val p = processor
                if (p != null && (p !== lastProc || rate != lastProcRate)) {
                    runCatching { p.reset(rate) }.onFailure { Diag.log("processor reset failed: ${it.message}") }
                    lastProc = p; lastProcRate = rate
                } else if (p == null) lastProc = null
                if (m != prevMode) {
                    prevI = 0f; prevQ = 0f; deemph = 0f; amDc = 0f; wph = 0.0
                    lpI1 = 0f; lpI2 = 0f; lpQ1 = 0f; lpQ2 = 0f
                    decAcc = 0f; decCnt = 0; s1I = 0f; s1Q = 0f; s1n = 0; audioLen = 0
                    rdsN = 0; sameN = 0
                    if (m != Mode.WFM) { rdsDec.reset(); hdDet.reset(); _rds.value = null; _hd.value = null }
                    prevMode = m
                }
                val wantTrack = m != Mode.NONE || p?.producesAudio == true
                if (wantTrack && track == null) { track = newTrack(); lastVol = -1f }
                val vol = if (muteNow) 0f else 1f
                if (track != null && vol != lastVol) { runCatching { track?.setVolume(vol) }; lastVol = vol }
                if (!wantTrack && track != null) {
                    val t = track
                    runCatching { t?.stop() }; runCatching { t?.release() }
                    track = null
                }

                // ---- spectrum (~25 fps): every whole FFT frame in this buffer is accumulated (a short buffer gives one
                // zero-padded frame); wide spans skip frames so about 2.4 M samples a second are transformed ----
                val now = System.currentTimeMillis()
                val skip = max(1, Math.round(rate / 2_400_000.0).toInt())
                if (nSamp >= FFT_N) {
                    var off = 0
                    while (off + FFT_N <= nSamp) {
                        for (k in 0 until FFT_N) {
                            val j = 2 * (off + k)
                            fre[k] = ((item[j].toInt() and 0xff) - 127.4f) * win[k]
                            fim[k] = ((item[j + 1].toInt() and 0xff) - 127.4f) * win[k]
                        }
                        Dsp.fft(fre, fim)
                        for (k in 0 until FFT_N) acc[k] += (fre[k] * fre[k] + fim[k] * fim[k]).toDouble()
                        frames++
                        off += FFT_N * skip
                    }
                } else if (frames == 0) {
                    for (k in 0 until FFT_N) {
                        if (k < nSamp) { fre[k] = ((item[2 * k].toInt() and 0xff) - 127.4f) * win[k]; fim[k] = ((item[2 * k + 1].toInt() and 0xff) - 127.4f) * win[k] }
                        else { fre[k] = 0f; fim[k] = 0f }
                    }
                    Dsp.fft(fre, fim)
                    for (k in 0 until FFT_N) acc[k] += (fre[k] * fre[k] + fim[k] * fim[k]).toDouble()
                    frames = 1
                }
                if (now - lastSpec > 40L && frames > 0) {
                    lastSpec = now
                    val nAvg = frames
                    for (k in 0 until FFT_N) pdb[k] = (10.0 * Math.log10(acc[(k + FFT_N / 2) % FFT_N] / nAvg + 1e-12)).toFloat()
                    acc.fill(0.0); frames = 0
                    System.arraycopy(pdb, 0, sorted, 0, FFT_N); sorted.sort()
                    val median = sorted[FFT_N / 2]
                    floorEma = if (floorEma.isNaN()) median else floorEma + 0.2f * (median - floorEma)
                    val base = floorEma - SPEC_FLOOR_PAD_DB
                    // peak-downsampled so a narrow carrier never falls between columns; a frame that averaged only a
                    // few transforms is blended with the last so the noise stays flat
                    val group = FFT_N / SPEC_BINS
                    val keep = if (prevOut.size == SPEC_BINS) maxOf(0f, 0.6f - nAvg * 0.05f) else 0f
                    val out = FloatArray(SPEC_BINS)
                    for (bin in 0 until SPEC_BINS) {
                        var pk = -999f
                        for (j in 0 until group) { val v = pdb[bin * group + j]; if (v > pk) pk = v }
                        val v = ((pk - base) / SPEC_RANGE_DB).coerceIn(0f, 1f)
                        out[bin] = if (keep > 0f) v * (1 - keep) + prevOut[bin] * keep else v
                    }
                    prevOut = out.copyOf()
                    _spectrum.value = out
                    _specScale.value = base to SPEC_RANGE_DB

                    // the signal finder works on the same averaged spectrum, every third frame (~8 a second)
                    if (watchSignals) {
                        val lo = _freqHz.value
                        if (rate != clsRate || lo != clsFreq) {
                            // buffers already queued were taken on the old tuning; let them drain before trusting any
                            clsRate = rate; clsFreq = lo; classifier.reset(); clsQuietUntil = now + 300; _signals.value = emptyList()
                        }
                        if (++specFrame % 3 == 0 && now >= clsQuietUntil)
                            _signals.value = runCatching { classifier.update(pdb, rate.toDouble(), lo.toDouble(), median.toDouble()) }.getOrElse { emptyList() }
                    } else if (clsRate != 0) { clsRate = 0; _signals.value = emptyList() }

                    if (now - lastDiag > 1000L) {
                        lastDiag = now
                        var sumI = 0.0; var sumQ = 0.0; var sumSq = 0.0
                        val nn = min(nSamp, 4096)
                        for (k in 0 until nn) {
                            val iv = (item[2 * k].toInt() and 0xff) - 127.4; val qv = (item[2 * k + 1].toInt() and 0xff) - 127.4
                            sumI += iv; sumQ += qv; sumSq += iv * iv + qv * qv
                        }
                        val rms = sqrt(sumSq / nn)
                        var peak = -999f; var peakIdx = 0
                        for (k in 0 until FFT_N) { val dv = pdb[k]; if (dv > peak) { peak = dv; peakIdx = k } }
                        val offKhz = (peakIdx - FFT_N / 2) * (rate.toDouble() / FFT_N) / 1000.0
                        val health = "%s RX: iqRMS=%.1f dcI=%.1f dcQ=%.1f · peak %+.0f kHz %.0fdB vs floor %.0fdB (Δ%.0f)".format(
                            sourceLabel, rms, sumI / nn, sumQ / nn, offKhz, peak, median, peak - median)
                        Diag.log(health)
                        _rxHealth.value = health
                        _levelDb.value = peak - median
                        agcStep(rms, now)
                        if (m != Mode.NONE) Diag.log("SDR audio: peak=%d/32000 %s".format(
                            audioPeak, if (audioPeak > 2500) "— demod producing audio" else "— silent (no modulation / no signal)"))
                        audioPeak = 0
                    }
                }

                val wantRds = rdsOn && m == Mode.WFM
                val tuned = _freqHz.value
                if (wantRds != rdsWas || (wantRds && tuned != rdsFreq)) { rdsDec.reset(); rdsN = 0; rdsWas = wantRds; rdsFreq = tuned; if (wantRds) _rds.value = null }
                val wantSame = sameOn && m == Mode.NFM
                if (wantSame != sameWas) { sameDec.reset(0); sameN = 0; sameWas = wantSame }
                val wantHd = hdOn && m == Mode.WFM
                if (wantHd != hdWas) { hdDet.reset(); hdWas = wantHd }
                if (wantHd && abs(_offsetHz.value) < rate / 2 - 240_000) runCatching { hdDet.push(item, nSamp, rate, _offsetHz.value.toDouble()) }

                // ---- demod → audio (+ FM tap for packet processors) ----
                if (m != Mode.NONE) {
                    // Two-stage decimation. Stage 1 is the channel filter (complex boxcar) down to an intermediate
                    // rate near the channel bandwidth: WFM → ~240 kHz, everything else → ~48 kHz. Stage 2 decimates
                    // the demodulated audio to 48 kHz.
                    val stage1 = if (m == Mode.WFM) max(1, rate / 240_000) else max(1, rate / AUDIO_RATE)
                    val interRate = rate / stage1
                    val stage2 = max(1, interRate / AUDIO_RATE)
                    val wantFm = p != null && p.wantsFm
                    val wInc = 2.0 * Math.PI * 1500.0 / interRate
                    val off = _offsetHz.value
                    val stepR = cos(-2.0 * Math.PI * off / rate).toFloat(); val stepI = sin(-2.0 * Math.PI * off / rate).toFloat()
                    var i = 0
                    while (i < nSamp) {
                        val iv = (item[2 * i].toInt() and 0xff) - 127.4f
                        val qv = (item[2 * i + 1].toInt() and 0xff) - 127.4f
                        if (off != 0) {
                            s1I += iv * ncoR - qv * ncoI; s1Q += iv * ncoI + qv * ncoR
                            val nr = ncoR * stepR - ncoI * stepI; ncoI = ncoR * stepI + ncoI * stepR; ncoR = nr
                            if (++ncoN >= 4096) { ncoN = 0; val g = 1f / sqrt(ncoR * ncoR + ncoI * ncoI); ncoR *= g; ncoI *= g }
                        } else { s1I += iv; s1Q += qv }
                        s1n++
                        if (s1n >= stage1) {
                            val ci = s1I / s1n; val cq = s1Q / s1n; s1I = 0f; s1Q = 0f; s1n = 0
                            chPow += (ci * ci + cq * cq).toDouble(); chN++
                            val s: Float = when (m) {
                                Mode.AM -> { val env = sqrt(ci * ci + cq * cq); amDc += 0.001f * (env - amDc); env - amDc }
                                Mode.USB, Mode.LSB -> {
                                    // Weaver SSB: shift the wanted sideband's centre (±1.5 kHz) to DC, low-pass
                                    // ±1.5 kHz, shift back, take the real part.
                                    wph += if (m == Mode.USB) -wInc else wInc
                                    if (wph > 2.0 * Math.PI) wph -= 2.0 * Math.PI else if (wph < 0.0) wph += 2.0 * Math.PI
                                    val c = cos(wph).toFloat(); val sn = sin(wph).toFloat()
                                    val ri = ci * c - cq * sn; val rq = ci * sn + cq * c
                                    lpI1 += 0.18f * (ri - lpI1); lpI2 += 0.18f * (lpI1 - lpI2)
                                    lpQ1 += 0.18f * (rq - lpQ1); lpQ2 += 0.18f * (lpQ1 - lpQ2)
                                    lpI2 * c + lpQ2 * sn
                                }
                                else -> {   // FM discriminator: angle(cur * conj(prev)) at the intermediate rate
                                    val d = atan2(cq * prevI - ci * prevQ, ci * prevI + cq * prevQ)
                                    prevI = ci; prevQ = cq; d
                                }
                            }
                            if (wantRds) { rdsBuf[rdsN++] = s; if (rdsN >= rdsBuf.size) { runCatching { rdsDec.push(rdsBuf, rdsN, interRate) }; rdsN = 0 } }
                            if (wantSame) { sameBuf[sameN++] = s; if (sameN >= sameBuf.size) { runCatching { sameDec.onFm(sameBuf, sameN, interRate) }; sameN = 0 } }
                            if (wantFm) {
                                fmBuf[fmN++] = s
                                if (fmN >= fmBuf.size) { runCatching { p!!.onFm(fmBuf, fmN, interRate) }; fmN = 0 }
                            }
                            decAcc += s; decCnt++
                            if (decCnt >= stage2) {
                                var v = decAcc / decCnt; decAcc = 0f; decCnt = 0
                                when (m) {
                                    Mode.WFM -> { deemph += 0.28f * (v - deemph); v = deemph * 9000f }   // 75µs de-emphasis + gain
                                    Mode.NFM -> v *= 16000f
                                    Mode.AM -> v *= 60f
                                    Mode.USB, Mode.LSB -> v *= 150f
                                    else -> {}
                                }
                                val sampI = v.coerceIn(-32000f, 32000f).toInt()
                                val am = if (sampI < 0) -sampI else sampI; if (am > audioPeak) audioPeak = am
                                if (voiceOn) voiceDet.push(sampI / 32768f)      // judged before the squelch gates it
                                audioBuf[audioLen++] = if (sqOpen) sampI.toShort() else 0
                                if (audioLen >= audioBuf.size) { track?.write(audioBuf, 0, audioLen); audioLen = 0 }
                            }
                        }
                        i++
                    }
                    if (voiceOn && now - lastVoice > 250L) { lastVoice = now; _voice.value = voiceDet.read() }
                    if (wantFm && fmN > 0) { runCatching { p!!.onFm(fmBuf, fmN, interRate) }; fmN = 0 }
                    if (audioLen > 0) { track?.write(audioBuf, 0, audioLen); audioLen = 0 }
                    if (chN > 0) {
                        // Squelch: channel power vs a floor that follows dips quickly and rises only slowly, so a
                        // carrier that stays up doesn't get absorbed into the floor.
                        val db = (10.0 * Math.log10(chPow / chN + 1e-9)).toFloat(); chPow = 0.0; chN = 0
                        sqFloor = if (sqFloor.isNaN()) db else if (db < sqFloor) sqFloor + 0.2f * (db - sqFloor) else sqFloor + 0.002f * (db - sqFloor)
                        val thr = _squelchDb.value
                        val open = thr == 0 || db > sqFloor + thr
                        if (open != sqOpen) { sqOpen = open; _squelchOpen.value = open }
                    }
                }
                if (p != null) runCatching { p.onIq(item, len, rate) }.onFailure { Diag.log("processor error: ${it.message}") }
                val t = track
                if (p != null && p.producesAudio && t != null) {
                    val k = p.drainAudio(procAudio, procAudio.size)
                    if (k > 0) {
                        for (i in 0 until k) {
                            val v = (procAudio[i] * 32000f).toInt().coerceIn(-32767, 32767)
                            procPcm[i] = v.toShort()
                            val a = if (v < 0) -v else v
                            if (a > audioPeak) audioPeak = a
                        }
                        runCatching { t.write(procPcm, 0, k) }
                    }
                }
                pool.offer(item)
            }
        } catch (t: Throwable) {
            Diag.log("SDR DSP error: ${t.message}")
        } finally {
            track?.let { runCatching { it.stop() }; runCatching { it.release() } }
        }
    }

    private fun newTrack(): AudioTrack {
        val minBuf = AudioTrack.getMinBufferSize(AUDIO_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(AUDIO_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(max(minBuf, AUDIO_RATE / 4 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        runCatching { t.play() }
        return t
    }

    private var floorEma = Float.NaN
}
