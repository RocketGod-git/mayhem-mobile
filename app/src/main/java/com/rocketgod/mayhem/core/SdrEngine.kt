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
    /**
     * The general-purpose receivers' base rate. 1.92 Msps rather than 2, because the audio path decimates by whole
     * numbers with no resampler: 1.92 M → 240 k → 48 k lands exactly on the 48 kHz output, where 2 M gives 50 k
     * for WFM (played 4 % fast and sharp, and faster than the output drains, so it backs up) and 48.78 k for NFM.
     * The fixed-purpose decoders keep [IQ_RATE]: their timing is built around it and they make no audio.
     */
    const val RX_RATE = 1_920_000
    /** The spans a receiver zooms through: every rung divides down to 48 kHz exactly. */
    val RX_RATES = intArrayOf(1_920_000, 3_840_000, 7_680_000, 15_360_000, 19_200_000)
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
    /**
     * The dial the receiver apps share, kept across launches. It records only what the user chose; a retune the
     * app makes on its own (the start-up pick of the strongest station) never becomes where the next app opens.
     */
    @Volatile var radioFreqHz = 92_300_000L; private set
    @Volatile var radioMode = Mode.WFM; private set
    /** Whether a dial was saved by an earlier session. */
    @Volatile var dialSaved = false; private set
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
        val dial = p.getLong("dial", 0L)
        if (dial in FREQ_MIN_HZ..FREQ_MAX_HZ) {
            radioFreqHz = dial; dialSaved = true
            radioMode = runCatching { Mode.valueOf(p.getString("dial_mode", null) ?: "") }.getOrDefault(radioMode)
        }
        rdsOn = p.getBoolean("rds", true); _rdsWanted.value = rdsOn
    }

    /** Remember where the receivers are tuned, for the other apps and the next launch. */
    fun setDial(hz: Long, mode: Mode) {
        radioFreqHz = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (mode != Mode.NONE) radioMode = mode
        dialSaved = true
        prefs?.edit()?.putLong("dial", radioFreqHz)?.putString("dial_mode", radioMode.name)?.apply()
    }
    private fun saveGains() {
        val g = intArrayOf(_radioLna.value, _radioVga.value, if (_radioAmp.value) 1 else 0, if (_agc.value) 1 else 0)
        gainPref = g
        prefs?.edit()?.putString("gains", g.joinToString(","))?.apply()
    }
    fun setAgc(on: Boolean) { _agc.value = on; agcLast = 0; saveGains() }
    /** AGC on without touching the saved gains: a screen that has no gain controls of its own rides it. */
    fun rideAgc() { if (gainPref == null && !_agc.value) { _agc.value = true; agcLast = 0 } }

    private fun isPro() = HackRfOne.boardLabel.contains("Pro", ignoreCase = true)
    /**
     * Per-app presets are written for a HackRF One. On a HackRF Pro the same settings leave the ADC under one count;
     * it needs about 28 dB more VGA for the same level, and LNA steps count for less, so the LNA is pinned at 40.
     */
    private fun boardGains(lna: Int, vga: Int, amp: Boolean): Triple<Int, Int, Boolean> =
        if (!isPro()) Triple(lna, vga, amp) else Triple(LNA_MAX, minOf(if (amp) 56 else VGA_MAX, vga + 28), amp)

    /** The open app's own gain preset, kept so a board found after it opened can be applied to the preset, not on top of it. */
    private var preset = Triple(24, 24, false)

    /**
     * Where an app's gain starts: the user's own if they have set one; otherwise the app's preset, raised for a
     * HackRF Pro, then floored at 32 on both stages with the front-end amp on (the web app's order), and the AGC
     * trims from there if a strong signal would clip.
     */
    private fun startGains(lna: Int, vga: Int, amp: Boolean): Triple<Int, Int, Boolean> {
        gainPref?.let { g -> return Triple(g[0], g[1], g[2] == 1) }
        val (l, v, _) = boardGains(lna, vga, amp)
        return Triple(maxOf(l, 32), maxOf(v, 32), true)
    }

    /** The board is known now: a Pro gets its stages raised unless the user has set them. */
    fun onBoard() {
        if (gainPref != null || !isPro()) return
        val (l, v, a) = startGains(preset.first, preset.second, preset.third)
        _radioLna.value = (l.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP; _radioVga.value = (v.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP; _radioAmp.value = a; syncDriver()
    }

    /** Wider spans hold proportionally more total power at the same per-signal level, so they may sit hotter. */
    private fun agcStep(rms: Double, now: Long) {
        // held for as long as Transmit is open, not just while it sends: the receive level there means nothing
        if (!_agc.value || HackRfOne.txActive || Apps.playing() == MayhemApp.TRANSMIT || now - agcLast < 900) return
        agcLast = now
        val scale = minOf(3.2, kotlin.math.sqrt(sampleRate / RX_RATE.toDouble()))
        val lo = minOf(24.0, 7 * scale); val hi = minOf(34.0, 22 * scale)
        val l = _radioLna.value; val v = _radioVga.value
        val vMax = vgaMax(); val hasLna = Radio.kind.value != Radio.Kind.RTLSDR
        if (rms < lo) {
            when {
                // far off moves in big steps, so a radio that starts deaf is listening within a few seconds
                v < vMax -> _radioVga.value = minOf(vMax, v + when { rms < 2 -> 8; rms < lo / 2 -> 6; else -> 2 })
                hasLna && l < LNA_MAX -> _radioLna.value = l + LNA_STEP
                _mode.value != Mode.NONE && now - agcSaidMax > 20_000 -> {
                    agcSaidMax = now
                    Diag.log("AGC is at maximum and the level is still %.1f counts — check the antenna, or set the gain by hand".format(rms))
                }
            }
        } else if (rms > hi) {
            when {
                v > 0 -> _radioVga.value = maxOf(0, v - when { rms > hi * 2 -> 8; rms > hi * 1.4 -> 4; else -> 2 })
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
    @Volatile private var rdsOn = true
    private val _rdsWanted = MutableStateFlow(true)
    val rdsWanted: StateFlow<Boolean> = _rdsWanted.asStateFlow()
    private val _rds = MutableStateFlow<RdsState?>(null)
    val rds: StateFlow<RdsState?> = _rds.asStateFlow()
    private val rdsDec = RdsDecoder { _rds.value = it }
    fun setRds(on: Boolean) { rdsOn = on; _rdsWanted.value = on; if (!on) _rds.value = null; prefs?.edit()?.putBoolean("rds", on)?.apply() }

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
    private val sameDec = SameDecoder { e ->
        if (e.event == "tone") return@SameDecoder
        _same.value = e
        e.header?.let { h -> Diag.log("SAME: ${h.eventName} from ${h.callsign}") }
    }
    fun dismissSame() { _same.value = null }

    fun listenForVoice(on: Boolean) { if (on != voiceOn) { voiceDet.reset(); _voice.value = null }; voiceOn = on }

    @Volatile private var sampleRate = IQ_RATE
    @Volatile var sourceLabel = "HackRF"
    @Volatile var processor: IqProcessor? = null; private set
    @Volatile private var worker: Thread? = null
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
        _rateHz.value = clampRate(rateHz)
        // Before the user has touched gain, no app starts below 32 on either stage and the front-end amp is on: AGC
        // (on by default) trims the stages if a strong signal would clip, so every app starts sensitive.
        preset = Triple(lna, vga, amp)
        val (l, v, a) = startGains(lna, vga, amp)
        _radioLna.value = (l.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP
        _radioVga.value = (v.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP
        _radioAmp.value = a
        _freqHz.value = freqHz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        syncDriver()
        processor = proc
        configured = true
    }

    /** Whether the open app is a plain receiver, whose channel can move inside the span with the radio left still. */
    private fun channelInSpan() = processor == null && _mode.value != Mode.NONE

    @Volatile private var configured = false
    /** A plain receiver is set up and playing, so a screen that only wants to listen can leave it exactly as it is. */
    fun listening() = configured && channelInSpan()
    /** A plain receiver is set up, playing or not (a launcher band with no voice mode is still one). */
    fun plain() = configured && processor == null

    /** Keep a tuned channel this far inside the span edge before the radio follows it. */
    private const val VIEW_GUARD = 100_000L

    /** The frequency being listened to: the radio's LO plus where the channel sits in the span. */
    fun channelHz(): Long = _freqHz.value + _offsetHz.value

    /**
     * Tune. A plain receiver moves its channel inside the span and the radio only follows when the channel leaves
     * it, so picking something already on the waterfall does not throw the waterfall sideways and wipe its
     * history. Everything else (decoders working on the raw samples) retunes the radio itself.
     */
    fun tune(hz: Long, silent: Boolean = false) {
        val f = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (!channelInSpan()) { tuneLo(f); if (!silent && plain() && _mode.value == Mode.NONE) radioFreqHz = f; return }
        val lo = _freqHz.value
        if (kotlin.math.abs(f - lo) > _rateHz.value / 2 - VIEW_GUARD) { tuneLo(f); _offsetHz.value = 0 }
        else _offsetHz.value = (f - lo).toInt()
        if (!silent) setDial(f, _mode.value)
    }

    /**
     * Point a plain receiver at a whole band: the span is the band's own width (as wide as this radio and screen
     * take in one shot) centred on its middle, heard in the band's mode.
     */
    fun viewBand(lo: Long, hi: Long, mode: Mode, cap: Int) {
        val widest = RX_RATES.filter { it <= cap && Radio.canSample(Radio.limits, it) }
        val want = (hi - lo).toInt()
        val rate = widest.firstOrNull { it >= want } ?: widest.lastOrNull() ?: RX_RATE
        _offsetHz.value = 0
        _mode.value = mode
        setRate(rate)
        tuneLo((lo + hi) / 2)
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


    /** Zoom past 1×: −1 widens the span a rung, +1 narrows it; false at either end of what this radio and screen allow. */
    fun stepSpan(dir: Int, cap: Int): Boolean {
        val ladder = RX_RATES.filter { it <= cap && Radio.canSample(Radio.limits, it) }
        if (ladder.isEmpty()) return false
        val cur = ladder.indexOfFirst { it >= _rateHz.value }.let { if (it < 0) ladder.size - 1 else it }
        val next = (cur - dir).coerceIn(0, ladder.size - 1)
        if (ladder[next] == _rateHz.value) return false
        setRate(ladder[next])
        // narrowed past the channel: bring the span back over it
        if (kotlin.math.abs(_offsetHz.value.toLong()) > _rateHz.value / 2 - VIEW_GUARD) recentre()
        return true
    }

    /** ⌖: bring the view back to the channel. */
    fun recentre() { val ch = channelHz(); _offsetHz.value = 0; tuneLo(ch) }

    fun setRate(rate: Int) { _rateHz.value = clampRate(rate); syncDriver() }

    private fun clampRate(rate: Int): Int {
        val r = Radio.nearestRate(Radio.limits, rate)
        if (r != rate && Radio.kind.value != Radio.Kind.NONE)
            Diag.log("%.2f Msps is out of range for this ${Radio.name} — using %.2f".format(rate / 1e6, r / 1e6))
        return r
    }

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

    /** Gain as a favourite saved it: with AGC it is only where the AGC starts; without, it is the user's own. */
    fun applyGains(lna: Int, vga: Int, amp: Boolean, agc: Boolean) {
        _radioLna.value = (lna.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP
        _radioVga.value = (vga.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP
        _radioAmp.value = amp; _agc.value = agc; agcLast = 0
        syncDriver()
        if (!agc) saveGains()
    }

    /** Audio mode switch (Audio app). */
    fun setMode(m: Mode, silent: Boolean = false) {
        _mode.value = m
        if (!silent && processor == null && m != Mode.NONE) setDial(channelHz(), m)
    }

    // A worker runs only while it is the current one, so a stop and a quick restart can never leave two of them
    // splitting the samples between them.
    private fun startWorker() {
        if (worker?.isAlive == true) return
        val t = Thread { workerLoop() }.apply { isDaemon = true; name = "sdr-dsp" }
        worker = t; t.start()
    }
    private fun stopWorker() {
        val t = worker; worker = null
        t?.interrupt()
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
        var dcFmI = 0f; var dcFmQ = 0f                  // NFM front-end DC tracker
        // NFM / AM channel filter: a 4th-order Butterworth low-pass (two biquads, I and Q) at the intermediate rate,
        // just before the detector. Without it the discriminator sees the whole ~48 kHz, and a packet with 10 dB of
        // SNR in its 12.5 kHz channel sits below the FM threshold.
        val bq = FloatArray(10); val bz = FloatArray(8); var bqKey = 0L
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
        var lastTrackTry = 0L; var lastErr = 0L
        // a write the output refuses means the system has taken it away; drop it and the next buffer opens another
        fun emit(buf: ShortArray, n: Int) {
            val t = track ?: return
            val r = try { t.write(buf, 0, n) } catch (e: Exception) { AudioTrack.ERROR_DEAD_OBJECT }
            if (r < 0) { Diag.log("audio output lost (code $r), reopening it"); runCatching { t.release() }; track = null }
        }
        try {
            val me = Thread.currentThread()
            while (worker === me) {
                val item = try { queue.take() } catch (e: InterruptedException) { break }
                try {
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
                    // One output for the life of the stream, paused while there is nothing to hear and resumed after rather
                    // than torn down and rebuilt, so moving between screens can never leave the receiver silent.
                    val wantTrack = m != Mode.NONE || p?.producesAudio == true
                    if (wantTrack && track == null && System.currentTimeMillis() - lastTrackTry > 1000L) {
                        lastTrackTry = System.currentTimeMillis()
                        track = runCatching { newTrack() }.onFailure { Diag.log("audio output unavailable: ${it.message}") }.getOrNull()
                        lastVol = -1f
                    }
                    val tk = track
                    if (tk != null) {
                        val vol = if (muteNow) 0f else 1f
                        if (vol != lastVol) { runCatching { tk.setVolume(vol) }; lastVol = vol }
                        val playing = tk.playState == AudioTrack.PLAYSTATE_PLAYING
                        if (wantTrack && !playing) {
                            if (runCatching { tk.play() }.isFailure || tk.playState != AudioTrack.PLAYSTATE_PLAYING) {
                                Diag.log("audio output would not resume, reopening it"); runCatching { tk.release() }; track = null
                            }
                        } else if (!wantTrack && playing) runCatching { tk.pause(); tk.flush() }
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
                            if (++specFrame % 3 == 0 && now >= clsQuietUntil) {
                                val sigs = runCatching { classifier.update(pdb, rate.toDouble(), lo.toDouble(), median.toDouble()) }.getOrElse { emptyList() }
                                _signals.value = sigs
                                runCatching { AutoPick.onSignals(sigs) }
                            }
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
                    if (m != Mode.NONE && abs(_offsetHz.value) < rate / 2 - 40_000) {     // a channel slid off the span is silent
                        // Two-stage decimation. Stage 1 is the channel filter (complex boxcar) down to an intermediate
                        // rate near the channel bandwidth: WFM → ~240 kHz, everything else → ~48 kHz. Stage 2 decimates
                        // the demodulated audio to 48 kHz.
                        val stage1 = if (m == Mode.WFM) max(1, rate / 240_000) else max(1, rate / AUDIO_RATE)
                        val interRate = rate / stage1
                        val stage2 = max(1, interRate / AUDIO_RATE)
                        val wantFm = p != null && p.wantsFm
                        val filtered = m == Mode.NFM || m == Mode.AM
                        if (filtered) {
                            val cut = when { (p?.fmChannelHz ?: 0) > 0 -> p!!.fmChannelHz; m == Mode.AM -> 5_000; else -> 6_500 }
                            val key = cut.toLong() * 100_000_000L + interRate
                            if (key != bqKey) {
                                bqKey = key; bz.fill(0f)
                                val w0 = 2.0 * Math.PI * minOf(0.45 * interRate, cut.toDouble()) / interRate
                                val c = cos(w0)
                                for ((k, q) in doubleArrayOf(0.5412, 1.3066).withIndex()) {
                                    val alpha = sin(w0) / (2 * q); val a0 = 1 + alpha
                                    bq[5 * k] = ((1 - c) / 2 / a0).toFloat(); bq[5 * k + 1] = ((1 - c) / a0).toFloat(); bq[5 * k + 2] = ((1 - c) / 2 / a0).toFloat()
                                    bq[5 * k + 3] = (-2 * c / a0).toFloat(); bq[5 * k + 4] = ((1 - alpha) / a0).toFloat()
                                }
                            }
                        }
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
                                var ci = s1I / s1n; var cq = s1Q / s1n; s1I = 0f; s1Q = 0f; s1n = 0
                                if (filtered) for (k in 0..1) {
                                    val o = 5 * k; val z = 4 * k
                                    val oi = bq[o] * ci + bz[z]; bz[z] = bq[o + 1] * ci - bq[o + 3] * oi + bz[z + 1]; bz[z + 1] = bq[o + 2] * ci - bq[o + 4] * oi
                                    val oq = bq[o] * cq + bz[z + 2]; bz[z + 2] = bq[o + 1] * cq - bq[o + 3] * oq + bz[z + 3]; bz[z + 3] = bq[o + 2] * cq - bq[o + 4] * oq
                                    ci = oi; cq = oq
                                }
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
                                        // A HackRF holds a steady DC on I/Q, and a narrowband decoder tuned to the
                                        // carrier puts its signal right on it, anchoring the phasor and shrinking the
                                        // deviation, so packet tones come out weak. A slow one-pole (~15 Hz) takes off
                                        // only the static offset; WFM is wide and strong and keeps the raw path.
                                        var fi = ci; var fq = cq
                                        if (m == Mode.NFM) { dcFmI += 2e-3f * (ci - dcFmI); dcFmQ += 2e-3f * (cq - dcFmQ); fi = ci - dcFmI; fq = cq - dcFmQ }
                                        val d = atan2(fq * prevI - fi * prevQ, fi * prevI + fq * prevQ)
                                        prevI = fi; prevQ = fq; d
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
                                    if (audioLen >= audioBuf.size) { emit(audioBuf, audioLen); audioLen = 0 }
                                }
                            }
                            i++
                        }
                        if (voiceOn && now - lastVoice > 250L) { lastVoice = now; _voice.value = voiceDet.read() }
                        if (wantFm && fmN > 0) { runCatching { p!!.onFm(fmBuf, fmN, interRate) }; fmN = 0 }
                        if (audioLen > 0) { emit(audioBuf, audioLen); audioLen = 0 }
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
                            emit(procPcm, k)
                        }
                    }
                    pool.offer(item)
                } catch (e: InterruptedException) {
                    break
                } catch (t: Throwable) {
                    pool.offer(item)
                    val n = System.currentTimeMillis()
                    if (n - lastErr > 1000L) { lastErr = n; Diag.log("SDR DSP error: ${t.message}") }
                }
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
