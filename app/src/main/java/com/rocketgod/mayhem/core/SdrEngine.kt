package com.rocketgod.mayhem.core

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.audio.AudioPlan
import com.rocketgod.mayhem.core.audio.AudioRateConverter
import com.rocketgod.mayhem.core.audio.DriftResampler
import com.rocketgod.mayhem.core.audio.HdDetector
import com.rocketgod.mayhem.core.audio.HdReport
import com.rocketgod.mayhem.core.audio.RdsDecoder
import com.rocketgod.mayhem.core.audio.RdsState
import com.rocketgod.mayhem.core.audio.SameDecoder
import com.rocketgod.mayhem.core.audio.SameEvent
import com.rocketgod.mayhem.core.hd.HdAudio
import com.rocketgod.mayhem.core.hd.HdProcessor
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.RtlSdr
import com.rocketgod.mayhem.core.ham.ChannelDecimator
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
     * numbers: 1.92 M → 240 k → 48 k lands exactly on the 48 kHz output and needs no conversion, where 2 M gives 50 k,
     * which [AudioRateConverter] has to bring to 48 k (see [AudioPlan]).
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
     * DC out the antenna port for an inline LNA: an RTL-SDR Blog bias tee (GPIO0, 4.5 V) or a HackRF's antenna power
     * (ANTENNA_ENABLE, 3.3 V). Off at every connect; the UI gates the first enable behind a warning.
     */
    private val _biasTee = MutableStateFlow(false)
    val biasTee: StateFlow<Boolean> = _biasTee.asStateFlow()
    fun setBiasTee(on: Boolean) { _biasTee.value = on; RtlSdr.targetBiasTee = on; HackRfOne.biasT = on }

    // ---- The rest of what the RADIO panel sets: each lands on the driver, which applies it between buffers ----
    /** The R82xx tuner's own automatic gain. It and the app's AGC cannot both drive one knob, so each turns the other off. */
    private val _tunerAgc = MutableStateFlow(false)
    val tunerAgc: StateFlow<Boolean> = _tunerAgc.asStateFlow()
    fun setTunerAgc(on: Boolean) {
        _tunerAgc.value = on; RtlSdr.tunerAgc = on
        // Two automatic gains fighting over one knob would hunt, so the tuner's takes over from the app's.
        if (on && _agc.value) { _agc.value = false; agcLast = 0; saveGains(); Diag.log("tuner AGC on, so the app's AGC is off") }
    }
    private fun tunerAgcOff(why: String?) {
        if (!_tunerAgc.value) return
        _tunerAgc.value = false; RtlSdr.tunerAgc = false
        if (why != null) Diag.log(why)
    }
    /** The RTL2832U's digital AGC. */
    private val _rtlAgc = MutableStateFlow(false)
    val rtlAgc: StateFlow<Boolean> = _rtlAgc.asStateFlow()
    fun setRtlAgc(on: Boolean) { _rtlAgc.value = on; RtlSdr.rtlAgc = on }
    /** An RTL-SDR's crystal correction in parts per million, remembered across launches. */
    private val _ppm = MutableStateFlow(0)
    val ppm: StateFlow<Int> = _ppm.asStateFlow()
    fun setPpm(v: Int) {
        val p = v.coerceIn(-200, 200)
        _ppm.value = p; RtlSdr.ppm = p
        prefs?.edit()?.putInt("rtl_ppm", p)?.apply()
    }
    /** Whether an R820T/R820T2 may drop into direct sampling below 24 MHz. */
    private val _directSampling = MutableStateFlow(true)
    val directSampling: StateFlow<Boolean> = _directSampling.asStateFlow()
    fun setDirectSampling(on: Boolean) { _directSampling.value = on; RtlSdr.setDirectSampling(on) }
    /** A HackRF's baseband filter in hertz, or 0 for AUTO (the largest under the sample rate). */
    private val _bbFilterHz = MutableStateFlow(0)
    val bbFilterHz: StateFlow<Int> = _bbFilterHz.asStateFlow()
    fun setBbFilter(hz: Int) { _bbFilterHz.value = hz; HackRfOne.bbFilterHz = hz }

    /**
     * Automatic gain, on by default: hold the ADC level (iqRMS, once a second) where the 8-bit converter has both
     * headroom and resolution — under ~2 counts the spectrum is quantisation mush, over ~40 it clips. VGA moves first,
     * 2 dB at a time (8 when far off), then the LNA. Touching LNA or VGA by hand hands the gain back to the user.
     */
    private val _agc = MutableStateFlow(true)
    val agc: StateFlow<Boolean> = _agc.asStateFlow()
    private var prefs: android.content.SharedPreferences? = null
    /**
     * A gain the user set by hand outranks every app's own default until it is changed again. Kept per board family:
     * a Pro needs about 28 dB more VGA than a One for the same level, so one shared setting left a Pro flat.
     */
    private var gainPrefOne: IntArray? = null
    private var gainPrefPro: IntArray? = null
    private val gainPref: IntArray? get() = if (isPro()) gainPrefPro else gainPrefOne
    private fun gainKey() = if (isPro()) "gains_pro" else "gains"
    private var agcLast = 0L; private var agcSaidMax = 0L
    /** The sweep pass the AGC last stepped on. */
    private var agcPass = -1
    /** The pager's levels over the last [PAGER_HOLD_MS] (time, rms) and when its gain last stepped down. */
    private val pagerLevels = ArrayDeque<Pair<Long, Double>>(); private var pagerDown = 0L
    private const val PAGER_HOLD_MS = 12_000L

    fun loadGains(ctx: android.content.Context) {
        val p = ctx.getSharedPreferences("mayhem", android.content.Context.MODE_PRIVATE); prefs = p
        fun read(k: String) = p.getString(k, null)?.split(',')?.mapNotNull { it.toIntOrNull() }?.takeIf { it.size == 4 }?.toIntArray()
        gainPrefOne = read("gains"); gainPrefPro = read("gains_pro")
        gainPrefOne?.let { _agc.value = it[3] == 1 }
        // the app always opens on broadcast FM in WFM, where Home and Audio pick the strongest station: a dial saved
        // anywhere else (a 6 m or NOAA listen) is not brought back at launch
        val dial = p.getLong("dial", 0L)
        if (dial in 76_000_000L..108_000_000L) { radioFreqHz = dial; dialSaved = true }
        rdsOn = p.getBoolean("rds", true); _rdsWanted.value = rdsOn
        _ppm.value = p.getInt("rtl_ppm", 0).coerceIn(-200, 200); RtlSdr.ppm = _ppm.value
        hdSurroundOn = p.getBoolean("hd_surround", false); _hdSurround.value = hdSurroundOn
        watchOutputs(ctx)
    }

    /** HD Radio audio upmixed to 5.1; it plays so only on an output with 6 or more channels. */
    @Volatile private var hdSurroundOn = false
    private val _hdSurround = MutableStateFlow(false)
    val hdSurround: StateFlow<Boolean> = _hdSurround.asStateFlow()
    @Volatile private var surroundRefused = false
    fun setHdSurround(on: Boolean) { hdSurroundOn = on; surroundRefused = false; _hdSurround.value = on; prefs?.edit()?.putBoolean("hd_surround", on)?.apply() }
    private val _outputChannels = MutableStateFlow(2)
    /** The most channels an output of this device reports (built-in ones aside), 2 when none says. */
    val outputChannels: Int get() = _outputChannels.value
    val outputChannelsFlow: StateFlow<Int> = _outputChannels.asStateFlow()
    private var outputsWatched = false
    private fun watchOutputs(ctx: android.content.Context) {
        if (outputsWatched) return
        val am = ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager ?: return
        outputsWatched = true
        val builtIn = setOf(android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            android.media.AudioDeviceInfo.TYPE_TELEPHONY, android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        fun read() {
            _outputChannels.value = runCatching {
                am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).filter { it.type !in builtIn }.maxOfOrNull { it.channelCounts.maxOrNull() ?: 2 } ?: 2
            }.getOrDefault(2).coerceAtLeast(2)
        }
        read()
        runCatching {
            am.registerAudioDeviceCallback(object : android.media.AudioDeviceCallback() {
                override fun onAudioDevicesAdded(addedDevices: Array<out android.media.AudioDeviceInfo>?) = read()
                override fun onAudioDevicesRemoved(removedDevices: Array<out android.media.AudioDeviceInfo>?) = read()
            }, android.os.Handler(android.os.Looper.getMainLooper()))
        }
    }

    /** Remember where the receivers are tuned, for the other apps and the next launch. */
    fun setDial(hz: Long, mode: Mode) {
        radioFreqHz = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (mode != Mode.NONE) radioMode = mode
        dialSaved = true
        prefs?.edit()?.putLong("dial", radioFreqHz)?.putString("dial_mode", radioMode.name)?.apply()
    }
    /** A number an app keeps across launches (the LoRa app's span, say); 0 when never set. */
    fun savedLong(k: String): Long = prefs?.getLong(k, 0L) ?: 0L
    fun saveLong(k: String, v: Long) { prefs?.edit()?.putLong(k, v)?.apply() }

    private fun saveGains() {
        val g = intArrayOf(_radioLna.value, _radioVga.value, if (_radioAmp.value) 1 else 0, if (_agc.value) 1 else 0)
        if (isPro()) gainPrefPro = g else gainPrefOne = g
        prefs?.edit()?.putString(gainKey(), g.joinToString(","))?.apply()
    }
    /** The app's AGC and the tuner's own cannot both drive one knob: handing it to the app takes it from the tuner. */
    fun setAgc(on: Boolean) { if (on) tunerAgcOff(null); _agc.value = on; agcLast = 0; saveGains() }
    /** AGC on without touching the saved gains: a screen that has no gain controls of its own rides it. The tuner's
     *  own AGC, when the user turned it on, is left alone. */
    fun rideAgc() { if (gainPref == null && !_agc.value && !_tunerAgc.value) { _agc.value = true; agcLast = 0 } }

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

    /** The board is known now: a Pro gets its own saved gain, or its stages raised if none was saved on a Pro. */
    fun onBoard() {
        if (!isPro()) return
        _agc.value = gainPrefPro?.let { it[3] == 1 } ?: true; agcLast = 0
        val (l, v, a) = startGains(preset.first, preset.second, preset.third)
        _radioLna.value = (l.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP; _radioVga.value = (v.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP; _radioAmp.value = a; syncDriver()
        // the gain LoRa kept is per board: only now is it known which one to start from
        if (Apps.playing() == MayhemApp.LORA) loraRecall()
    }

    /** Wider spans hold proportionally more total power at the same per-signal level, so they may sit hotter. */
    /** LoRa's last few one-second levels, for [agcStep]. */
    private val burstLevels = ArrayDeque<Double>()

    // ---- LoRa's gain ----
    /** The LoRa scanner's strongest sample (counts from center) and clipped share over the last second. */
    @Volatile private var loraLevel: Pair<Double, Double>? = null
    /** The strongest sample of each second since the gain last moved: (ms, counts). */
    private val loraPeaks = ArrayList<Pair<Long, Double>>()
    /** When a burst last clipped, and how long the gain then waits before it climbs again. */
    private var loraClipAt = 0L; private var loraHold = 0L; private var loraOverSince = 0L
    /** The LoRa gain control's latest reasoning, for the diagnostic log. */
    @Volatile var loraGainNote = "LoRa gain not started"; private set
    /** When it last tried a stage up past what the headroom says, and since when the gain has held still. */
    private var loraProbeAt = 0L; private var loraStillSince = 0L
    /** The start with no gain kept for this radio and band: 8 dB steps down while the converter is pinned. */
    private var loraCoarse = true

    /**
     * Where the gain settles depends on the antenna and the place (a big antenna beside a node clips at a gain a small
     * one needs), so what held still for two minutes is kept per board and per 10 MHz of band, and the next LoRa
     * session there starts from it instead of finding it again.
     */
    private fun loraGainKey() = "lora_gain2_${if (isPro()) "pro" else if (Radio.kind.value == Radio.Kind.RTLSDR) "rtl" else "one"}_${_freqHz.value / 10_000_000}"
    fun loraRecall() {
        loraCoarse = true
        if (!_agc.value) return
        val g = savedLong(loraGainKey())
        if (g <= 0) return
        loraCoarse = false
        _radioAmp.value = g / 1_000_000 == 1L || Radio.kind.value != Radio.Kind.RTLSDR; _radioLna.value = (g / 1000 % 1000).toInt().coerceIn(0, LNA_MAX); _radioVga.value = (g % 1000).toInt().coerceIn(0, vgaMax())
        loraPeaks.clear(); loraStillSince = 0
        Diag.log("LoRa gain: starting where it settled last time here (amp %s LNA %d VGA %d)".format(if (_radioAmp.value) "on" else "off", _radioLna.value, _radioVga.value))
        syncDriver()
    }

    /**
     * LoRa decodes below the noise, so the average level says little: what matters is the strongest burst. A node
     * close by (a good antenna in the same house) clips the converter, which LoRa rides through, while far nodes need
     * the front end's gain. So the gain comes down a stage under sustained overload (a nearby node clipping costs nothing) (the LNA first, then the VGA;
     * the front-end amp stays on, as LoRa hears nothing without it) and climbs back, one stage at a time, only once the strongest burst of the last stretch
     * would still fit after the step. After a clip it waits [LORA_HOLD_MS] before climbing (doubling each time a step
     * up clips again, up to 30 minutes), so a nearby node that only speaks every few minutes is not clipped again on
     * each of its packets.
     */
    private const val LORA_HOLD_MS = 120_000L
    /** Counts from center the strongest burst may reach after a step up (the converter tops out at 127). */
    private const val LORA_CEIL = 90.0

    private fun loraAgc(rms: Double, now: Long, lo: Double, hi: Double) {
        val lv = loraLevel ?: return
        val peakNow = lv.first; val clipShare = lv.second
        val l = _radioLna.value; val v = _radioVga.value; val a = _radioAmp.value
        val vMax = vgaMax(); val rtl = Radio.kind.value == Radio.Kind.RTLSDR
        val hasLna = !rtl; val hasAmp = !rtl
        loraPeaks.add(now to peakNow); loraPeaks.removeAll { now - it.first > 60_000 }
        // The band's meters burst every second and some clip; a clip lasts only their burst and costs only them, while
        // stepping down for it left far nodes under the noise (it sat at LNA 0). So it backs off only for a clip while
        // a LoRa frame is being received (a node close by), or for sustained overload (over 1% of samples).
        val anyClip = clipShare > 1e-4 || peakNow >= 126.5
        val loraNow = (processor as? com.rocketgod.mayhem.core.lora.LoraScanner)?.let { System.currentTimeMillis() - it.loraAtMs < 1500 } ?: false
        // A clip from a node close by costs it nothing: measured with a T114 beside the antenna clipping the converter,
        // 6 of 6 frames at LNA 40, 24 and 0 alike, while stepping down for it sank the far nodes. Only overload that
        // outlasts any packet (over 1% of samples clipped for 8 seconds running) brings the front end down.
        if (clipShare > 0.01) { if (loraOverSince == 0L) loraOverSince = now } else loraOverSince = 0L
        val clipped = loraOverSince > 0L && now - loraOverSince >= 8_000
        // the big steps last until the first second the converter isn't pinned; then 2 dB steps as before
        if (peakNow < 126.5) loraCoarse = false
        val why: String
        if (hasAmp && !a) {
            // the front-end amp stays on for LoRa: measured on a HackRF Pro, 43 and 14 frames in 4 minutes with it on,
            // none with it off (the VGA cannot make up what the front end loses)
            _radioAmp.value = true; why = "front-end amp back on: LoRa hears nothing without it"
        } else if (clipped) {
            // a step up that clips within a minute doubles the wait before the next try; any other clip (the first
            // seconds of stepping down from a gain set by hand, a node keying up) waits the usual time
            loraHold = if (now - loraProbeAt < 60_000) minOf(1_800_000L, maxOf(LORA_HOLD_MS, loraHold * 2)) else LORA_HOLD_MS
            loraClipAt = now
            why = when {
                hasLna && l > 0 -> { _radioLna.value = l - LNA_STEP; "clipped: LNA down" }
                v > 0 -> { _radioVga.value = maxOf(0, v - 6); "clipped: VGA down" }
                else -> "clipped at the lowest gain (a transmitter right beside the antenna)"
            }
            loraPeaks.clear()
        } else if (loraCoarse && (v > 0 || (hasLna && l > 0))) {
            // opened pinned (at the start, with no gain kept here): 2 dB a second spent about 12 s clipped
            if (v > 0) { _radioVga.value = maxOf(0, v - 8); why = "pinned at the start: VGA down 8 dB" }
            else { _radioLna.value = l - LNA_STEP; why = "pinned at the start: LNA down" }
        } else if (anyClip && !loraNow && v > vMax / 2 && rms > lo) {
            // a meter's burst clipped: the VGA alone gives a little back, the front end stays where far nodes need it
            _radioVga.value = maxOf(0, v - 2); why = "clip outside LoRa: VGA down a step"
        } else if (rms > hi && v > 0) {
            _radioVga.value = maxOf(0, v - 2); why = "noise high: VGA down"
        } else {
            val span = if (loraPeaks.size >= 10) (now - (loraPeaks.firstOrNull()?.first ?: now)).toDouble() else 0.0
            val peak = loraPeaks.maxOfOrNull { it.second } ?: 128.0
            val waiting = now - loraClipAt < loraHold
            // step factors: amp about 11 dB, an LNA step 8 dB, a VGA step 2 dB
            val probeDue = now - maxOf(loraProbeAt, loraClipAt) > maxOf(LORA_HOLD_MS, loraHold)
            why = when {
                span < 9_000 -> "watching the level"
                waiting -> {
                    // only the VGA's small steps while it waits, and only for a quiet radio
                    if (rms < lo && v < vMax && peak * 1.26 < LORA_CEIL) { _radioVga.value = minOf(vMax, v + 2); "quiet: VGA up (holding the front end after a clip)" }
                    else "holding %.0f s after a clip".format((loraHold - (now - loraClipAt)) / 1000.0)
                }
                hasAmp && !a && peak * 3.55 < LORA_CEIL -> { _radioAmp.value = true; "room: front-end amp on" }
                hasLna && l < LNA_MAX && peak * 2.5 < LORA_CEIL -> { _radioLna.value = minOf(LNA_MAX, l + LNA_STEP); "room: LNA up" }
                v < vMax && rms * 1.26 < hi && peak * 1.26 < LORA_CEIL -> { _radioVga.value = minOf(vMax, v + 2); "room: VGA up" }
                // No room by the strongest burst (often a meter, not a node): now and then it tries one stage up anyway.
                // A clip brings it straight back down and makes the next try wait twice as long, so it settles at the
                // most gain this antenna and place can take.
                probeDue && hasAmp && !a -> { _radioAmp.value = true; loraProbeAt = now; "trying: front-end amp on" }
                probeDue && hasLna && l < LNA_MAX -> { _radioLna.value = minOf(LNA_MAX, l + LNA_STEP); loraProbeAt = now; "trying: LNA up" }
                else -> "settled"
            }
            if (_radioLna.value != l || _radioAmp.value != a) loraPeaks.clear()
        }
        loraGainNote = "%s · peak %.0f counts, clipped %.4f%%, noise %.1f counts".format(why, peakNow, clipShare * 100, rms)
        val moved = _radioLna.value != l || _radioVga.value != v || _radioAmp.value != a
        if (moved) loraStillSince = now
        else if (loraStillSince == 0L) loraStillSince = now
        else if (now - loraStillSince > 120_000 && now - loraClipAt > 600_000) {
            val g = (if (_radioAmp.value) 1L else 0L) * 1_000_000 + _radioLna.value * 1000L + _radioVga.value
            if (savedLong(loraGainKey()) != g) {
                saveLong(loraGainKey(), g)
                Diag.log("LoRa gain: kept amp %s LNA %d VGA %d for this radio and band".format(if (_radioAmp.value) "on" else "off", _radioLna.value, _radioVga.value))
            }
        }
        if (moved) {
            Diag.log("LoRa gain: %s (amp %s LNA %d VGA %d → amp %s LNA %d VGA %d; strongest %.0f counts)".format(why, if (a) "on" else "off", l, v,
                if (_radioAmp.value) "on" else "off", _radioLna.value, _radioVga.value, peakNow))
            syncDriver()
        }
    }

    private fun agcStep(sampled: Double, now: Long) {
        // held for as long as Transmit is open, not just while it sends: the receive level there means nothing
        if (!_agc.value || HackRfOne.txActive || Apps.playing() == MayhemApp.TRANSMIT || now - agcLast < 900) return
        // Spectrum holds the gain set in RADIO: a gain step under a measurement would move every level on the screen
        if (Apps.playing() == MayhemApp.SPECTRUM) return
        // A sweep's slices take turns being loud and quiet, and the once-a-second sample lands on whichever is
        // current: steering by it put part of every pass at another gain, dark bands across Looking Glass. So a
        // sweep's gain moves once a pass, by its loudest slice, and every slice of a pass shares one gain.
        var rms = sampled
        Apps.sweep.value?.let { sw ->
            val pass = sw.sweeps.value
            if (pass == agcPass || sw.passPeakRms <= 0.0) return
            agcPass = pass; rms = sw.passPeakRms
        }
        agcLast = now
        val scale = minOf(3.2, kotlin.math.sqrt(sampleRate / RX_RATE.toDouble()))
        val lo = minOf(24.0, 7 * scale); val hi = minOf(34.0, 22 * scale)
        val l = _radioLna.value; val v = _radioVga.value
        val vMax = vgaMax(); val hasLna = Radio.kind.value != Radio.Kind.RTLSDR
        // Pager transmitters key up for a burst and drop again, so the one-second level swings by tens of dB, and
        // stepping on each second pumped the gain: every step shifts the whole waterfall, and a step up just before
        // the next key-up clips the front end across the span. The pager steps down at once when a burst is too
        // strong, and up only when nothing in the last [PAGER_HOLD_MS] has come near the target.
        if (Apps.playing() == MayhemApp.PAGER) {
            pagerLevels.addLast(now to rms); while (pagerLevels.isNotEmpty() && now - pagerLevels.first().first >= PAGER_HOLD_MS) pagerLevels.removeFirst()
            if (rms > hi) {
                pagerDown = now
                when {
                    v > 0 -> _radioVga.value = maxOf(0, v - when { rms > hi * 2 -> 8; rms > hi * 1.4 -> 4; else -> 2 })
                    hasLna && l > 0 -> _radioLna.value = l - LNA_STEP
                }
            } else if (now - pagerDown > PAGER_HOLD_MS && pagerLevels.size >= 10 && pagerLevels.maxOf { it.second } < lo) {
                when {
                    v < vMax -> _radioVga.value = minOf(vMax, v + 2)
                    hasLna && l < LNA_MAX -> _radioLna.value = l + LNA_STEP
                }
                pagerLevels.clear()
            }
            if (_radioLna.value != l || _radioVga.value != v) {
                Diag.log("AGC: LNA %d / VGA %d → LNA %d / VGA %d (level %.1f counts)".format(l, v, _radioLna.value, _radioVga.value, rms))
                syncDriver()
            }
            return
        }
        // LoRa's 20 MHz is full of short strong bursts (meters, every second): a single second's level is whichever
        // burst it caught, 5 counts one second and 90 the next, and stepping on it moved the gain 6-10 dB nearly every
        // second (dark bands across the waterfall, weak frames pushed under). It steers by the middle of the last few
        // seconds instead, in small steps.
        val bursty = Apps.playing() == MayhemApp.LORA
        if (bursty) {
            burstLevels.addLast(rms); while (burstLevels.size > 8) burstLevels.removeFirst()
            if (burstLevels.size < 4 && !(loraCoarse && (loraLevel?.first ?: 0.0) >= 126.5)) return
            rms = burstLevels.sorted()[burstLevels.size / 2]
            loraAgc(rms, now, lo, hi)
            return
        } else burstLevels.clear()
        if (rms < lo) {
            when {
                // far off moves in big steps, so a radio that starts deaf is listening within a few seconds
                v < vMax -> _radioVga.value = minOf(vMax, v + when { rms < 2 -> 8; bursty -> 2; rms < lo / 2 -> 6; else -> 2 })
                hasLna && l < LNA_MAX -> _radioLna.value = l + LNA_STEP
                _mode.value != Mode.NONE && now - agcSaidMax > 20_000 -> {
                    agcSaidMax = now
                    Diag.log("AGC is at maximum and the level is still %.1f counts — check the antenna, or set the gain by hand".format(rms))
                }
            }
        } else if (rms > hi) {
            when {
                // too hot: step down by how far over it is (up to 16 dB at once), so a radio that opens overloaded settles in a step or two
                v > 0 -> _radioVga.value = maxOf(0, v - if (bursty && rms < 2 * hi) 2 else ((20 * kotlin.math.log10(rms / hi) + 2) / 2).toInt().times(2).coerceIn(2, 16))
                hasLna && l > 0 -> _radioLna.value = l - LNA_STEP
            }
        }
        if (_radioLna.value != l || _radioVga.value != v) syncDriver()
    }
    /**
     * Latest spectrum: [SPEC_BINS] (or [specBinsWanted]) normalised magnitudes 0..1, low→high frequency (fftshifted).
     * Every sample that arrives between frames is power-averaged through a 4096..16384-point Hann FFT (about 2.4 M
     * samples a second are transformed whatever the rate), which pulls the noise spread down to a dB or two so a weak
     * station stands out; the floor is the median bin (robust to strong carriers) and the display covers
     * [SPEC_RANGE_DB] above it.
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

    /** Spectrum bins while no waterfall asks for more ([specBinsWanted]); a [spectrum] array may be any of 256..8192. */
    const val SPEC_BINS = 1024
    /** The smallest transform; finer bins get a larger one, up to [FFT_MAX]. Power is scaled to an FFT_N-point
     *  transform's whatever the size, so the floor and its dB labels hold still while zooming. */
    private const val FFT_N = 4096
    private const val FFT_MAX = 16384
    const val SPEC_RANGE_DB = 40f
    private const val SPEC_FLOOR_PAD_DB = 4f
    /** Bins the waterfall on screen wants: its columns × its zoom, so a zoomed view is drawn from real resolution. */
    @Volatile var specBinsWanted = SPEC_BINS
    /** [n] rounded up to a bin count the spectrum comes in: a power of two, 256..8192. */
    fun specBinsFor(n: Int): Int { var b = 256; while (b < n && b < 8192) b = b shl 1; return b }
    private fun hann(n: Int) = FloatArray(n) { (0.5 - 0.5 * cos(2.0 * Math.PI * it / n)).toFloat() }
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

    /** Whether a WFM station carries HD Radio sidebands; detection only, the HD Radio screen plays the audio. */
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
    /** HD AUTO's wide look is on: the demodulator rests (the span is many times the channel; only the spectrum is wanted). */
    @Volatile var holdDemod = false
    @Volatile private var worker: Thread? = null
    // Room for about 0.2 s of samples (onIq caps it by time): eight buffers held only 3 ms at 19.2 Msps, while a
    // LoRa frame's channel catching up from its start takes 60-80 ms now and then and USB delivers in bursts.
    private val queue = ArrayBlockingQueue<ByteArray>(512)
    private val pool = ArrayBlockingQueue<ByteArray>(512)

    fun setActive(on: Boolean) {
        _active.value = on
        if (on) startWorker()
        else {
            stopWorker()
            streamStart(0, 0, 1)
            _spectrum.value = FloatArray(0)
            _rxHealth.value = ""
        }
    }

    /** Called by the driver at start and after every sample-rate change. */
    fun onSource(rate: Int) { sampleRate = rate }

    /** The radio's samples come over a network (rtl_tcp), off the phone's clock: its audio is resampled to fit. */
    @Volatile var driftAudio = false

    /** Raw IQ from the USB thread (uint8 I,Q interleaved). Copies into an exact-size pooled buffer and enqueues;
     *  drops oldest on overrun to stay near-real-time. */
    fun onIq(buf: ByteArray, len: Int) {
        bufTotal++
        val gap = synchronized(delivery) { delivery.push((len / 2).toLong(), DeliveryMeter.nowMs()) }
        val dst = pool.poll()?.takeIf { it.size == len } ?: ByteArray(len)
        System.arraycopy(buf, 0, dst, 0, len)
        // at most about 0.2 s of samples waits, whatever the buffer size and rate: a deeper backlog (a phone's first
        // seconds, before the code is warm) would leave the waterfall and the decoders that far behind
        val cap = if (deepQueue) (QUEUE_SECONDS * sampleRate * 2 / maxOf(len, 1)).toInt().coerceIn(8, 512) else 8
        while (queue.size >= cap) { val old = queue.poll() ?: break; dropped(old) }
        if (!queue.offer(dst)) {
            queue.poll()?.let { dropped(it) }
            queue.offer(dst)
        }
        // LoRa places the gap: an empty array rides the queue right behind the buffers before it
        if (gap != null && processor is com.rocketgod.mayhem.core.lora.LoraScanner) {
            val mark = ByteArray(0)
            gapAt[mark] = gap
            if (!queue.offer(mark)) gapAt.remove(mark)
        }
    }

    /** A queued buffer thrown away: for LoRa that is a gap right where the next one starts. */
    private fun dropped(b: ByteArray) {
        if (b.isEmpty()) { gapAt.remove(b); return }
        pool.offer(b); dropTotal++; dropGap = true
    }

    /** Samples delivered against wall time (DeliveryMeter), for every app: the drivers restart it with [streamStart]. */
    val delivery = DeliveryMeter()
    /** The gaps found, by the empty array that stands in for each in the queue. */
    private val gapAt = java.util.concurrent.ConcurrentHashMap<ByteArray, Gap>()
    @Volatile private var dropGap = false

    /** From the drivers: streaming (again) at [rate], with [inflightSamples] of reads queued and buffers of [bufSamples],
     *  at the start, after a rate change, and after a retune that pauses the stream (not lost samples). */
    fun streamStart(rate: Int, inflightSamples: Int, bufSamples: Int) {
        synchronized(delivery) { delivery.restart(rate, DeliveryMeter.nowMs(), inflightSamples.toLong(), bufSamples.toLong()) }
    }

    /** What the radio lost lately, for a screen ("" while nothing). */
    fun deliveryNote(): String = synchronized(delivery) { delivery.note(DeliveryMeter.nowMs()) }
    /** The radio losing samples at the rate it streams now (watched 5 s at least). */
    fun deliveryLosing(): Boolean = synchronized(delivery) { delivery.losing(DeliveryMeter.nowMs()) }

    /**
     * Buffers in from the radio, and those thrown away because processing fell behind. A drop is silent otherwise, and
     * it tears a hole in anything long being received (a LoRa frame is hundreds of milliseconds), so the health line says.
     */
    @Volatile private var bufTotal = 0L
    @Volatile private var dropTotal = 0L
    private var bufSeen = 0L
    private var dropSeen = 0L
    private var skipSeen = 0L

    private const val QUEUE_SECONDS = 0.2

    /** Only LoRa queues deeper (about 0.2 s; its channels catch up from a frame's start in bursts, and a retune
     *  throws the old tuning's samples away). Every other app keeps the original 8 buffers, dropping the oldest. */
    @Volatile var deepQueue = false

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
        RtlSdr.targetRateHz = if (wideScan) WIDE_SCAN_RTL else Radio.nearestRate(Radio.RTLSDR, _rateHz.value)
        RtlSdr.targetFreqHz = _freqHz.value
        RtlSdr.targetGainTenthDb = (_radioVga.value * 10).coerceIn(0, (RtlSdr.MAX_GAIN_DB * 10).toInt())
    }

    /** The top of the VGA knob for the radio attached: a dongle's tuner stops at 48.8 dB. */
    fun vgaMax(): Int = if (Radio.kind.value == Radio.Kind.RTLSDR) 48 else VGA_MAX

    /** A radio arrived or left: hold the rate and gain to what it can do, so the screen never shows what it is not doing. */
    fun onRadio(kind: Radio.Kind) {
        Radio.attached(kind)
        wideScan = false
        _rateHz.value = Radio.nearestRate(Radio.limits, _rateHz.value)
        _radioVga.value = minOf(_radioVga.value, vgaMax())
        // antenna power is off at every connect (a dongle powers up with its tee off); keep it that way until asked
        _biasTee.value = false; RtlSdr.targetBiasTee = false; HackRfOne.biasT = false
        syncDriver()
    }

    /** Enter an app: audio mode, dial, IQ rate, gain preset and the baseband processor, all at once. */
    fun configure(mode: Mode, freqHz: Long, rateHz: Int, lna: Int, vga: Int, amp: Boolean, proc: IqProcessor?) {
        processor = null
        holdDemod = false
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
    /** Whether what is running makes sound: a demod mode, or a processor that hands audio back (the pager hunter). */
    val audible: Boolean get() = _mode.value != Mode.NONE || processor?.producesAudio == true

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
    /**
     * [keepDial]: the start-up view leaves the dial on the station the app came back to (when it is in view), so the
     * pick can see it is already on a good one; a band chip puts the dial at the band's middle.
     */
    fun viewBand(lo: Long, hi: Long, mode: Mode, cap: Int, keepDial: Boolean = false) {
        val widest = RX_RATES.filter { it <= cap && Radio.canSample(Radio.limits, it) }
        val want = (hi - lo).toInt()
        val rate = widest.firstOrNull { it >= want } ?: widest.lastOrNull() ?: RX_RATE
        val ch = channelHz(); val mid = (lo + hi) / 2
        _offsetHz.value = 0
        _mode.value = mode
        setRate(rate)
        tuneLo(mid)
        if (keepDial && kotlin.math.abs(ch - mid) <= rate / 2 - VIEW_GUARD) _offsetHz.value = (ch - mid).toInt()
    }
    fun nudge(deltaHz: Long) = tune(channelHz() + deltaHz)

    /** Move the radio itself, leaving the channel offset alone. */
    fun tuneLo(hz: Long) {
        val f = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (deepQueue && f != _freqHz.value) dropQueued()
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
    /** The span was widened or narrowed by hand this run (− / +): the start-up pick leaves it alone. */
    @Volatile var spanByHand = false

    /** [dry]: only say whether there is a rung that way (for dimming the button), change nothing. */
    fun stepSpan(dir: Int, cap: Int, dry: Boolean = false): Boolean {
        // an RTL-SDR zooms 1.92 → 2.4 MHz; 2.4 is where it opens for the start-up pick
        val rtl = Radio.kind.value == Radio.Kind.RTLSDR
        val ladder = if (rtl) listOf(1_920_000, WIDE_SCAN_RTL)
                     else RX_RATES.filter { it <= cap && Radio.canSample(Radio.limits, it) }
        if (ladder.isEmpty()) return false
        val cur = ladder.indexOfFirst { it >= _rateHz.value }.let { if (it < 0) ladder.size - 1 else it }
        val next = (cur - dir).coerceIn(0, ladder.size - 1)
        if (ladder[next] == _rateHz.value) return false
        if (dry) return true
        spanByHand = true
        if (rtl && ladder[next] == WIDE_SCAN_RTL) setWideScan(true) else setRate(ladder[next])
        // narrowed past the channel: bring the span back over it
        if (kotlin.math.abs(_offsetHz.value.toLong()) > _rateHz.value / 2 - VIEW_GUARD) recentre()
        return true
    }

    /** ⌖: bring the view back to the channel. */
    fun recentre() { val ch = channelHz(); _offsetHz.value = 0; tuneLo(ch) }

    fun setRate(rate: Int) {
        val r = clampRate(rate)
        if (deepQueue && r != _rateHz.value) dropQueued()
        _rateHz.value = r; syncDriver()
    }

    /**
     * Everything still queued was taken on the old tuning: a sweep's next slice, or the signal finder, must never
     * read it as the new one (the queue is deep enough to hold a fifth of a second).
     */
    private fun dropQueued() {
        while (true) { val b = queue.poll() ?: break; if (b.isEmpty()) gapAt.remove(b) else pool.offer(b) }
    }

    /**
     * An RTL-SDR opens at 2.4 Msps for the start-up pick and listens there too; the zoom steps back to 1.92 by hand.
     * Not 3.2: there a Blog V4's edges fall outside the tuner's filter (a black strip down one side of the
     * waterfall, a fade down the other) and the USB link drops buffers. Any other rate ends this view.
     */
    const val WIDE_SCAN_RTL = 2_400_000
    @Volatile var wideScan = false; private set
    /** The rate before the start-up view, for [endWideScan]. */
    @Volatile private var wideScanFrom = 0
    fun setWideScan(on: Boolean) {
        if (on == wideScan) return
        if (on) {
            if (Radio.kind.value != Radio.Kind.RTLSDR) return
            wideScanFrom = _rateHz.value
            wideScan = true; _rateHz.value = WIDE_SCAN_RTL; syncDriver()
        } else { wideScan = false; setRate(2_400_000) }
    }

    /** Back to the rate the radio had before the start-up view (2.4 Msps if unknown), the channel in the middle. */
    fun endWideScan() {
        if (!wideScan) return
        val to = if (wideScanFrom in 1 until WIDE_SCAN_RTL) wideScanFrom else 2_400_000
        Diag.log("start-up: the network radio leaves the start-up view, %.2f Msps".format(to / 1e6))
        setRate(to)
        recentre()
    }

    private fun clampRate(rate: Int): Int {
        wideScan = false        // any ordinary rate (an app's, a zoom step) ends the RTL-SDR's start-up view
        val r = Radio.nearestRate(Radio.limits, rate)
        if (r != rate && Radio.kind.value != Radio.Kind.NONE)
            Diag.log("%.2f Msps is out of range for this ${Radio.name} — using %.2f".format(rate / 1e6, r / 1e6))
        return r
    }

    /** A hand on the LNA or VGA switches the AGC off so the setting sticks, and is remembered for every app. */
    fun setRadioLna(db: Int) {
        if (_agc.value) Diag.log("gain set by hand, so the automatic gain is off — tap AGC to hand it back")
        tunerAgcOff("gain set by hand, so the tuner AGC is off")
        _agc.value = false; _radioLna.value = (db.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP; syncDriver(); saveGains()
    }
    fun setRadioVga(db: Int) {
        if (_agc.value) Diag.log("gain set by hand, so the automatic gain is off — tap AGC to hand it back")
        tunerAgcOff("gain set by hand, so the tuner AGC is off")
        _agc.value = false; _radioVga.value = (db.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP; syncDriver(); saveGains()
    }
    fun toggleRadioAmp() { _radioAmp.value = !_radioAmp.value; syncDriver(); saveGains() }

    /** Gain as a favourite saved it: with AGC it is only where the AGC starts; without, it is the user's own. */
    fun applyGains(lna: Int, vga: Int, amp: Boolean, agc: Boolean) {
        _radioLna.value = (lna.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP
        _radioVga.value = (vga.coerceIn(0, vgaMax()) / VGA_STEP) * VGA_STEP
        _radioAmp.value = amp; _agc.value = agc; agcLast = 0
        tunerAgcOff(null)   // a favorite's gain, automatic or not, is the app's
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
        // ahead of every decoder's own threads: a buffer this thread can't take in time is thrown away
        runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO) }
        var track: AudioTrack? = null
        // the open output's channels: 2, or 6 (5.1) while HD Radio plays its upmix
        var trackCh = 2
        var fftN = FFT_N; var specBins = SPEC_BINS
        var fre = FloatArray(fftN); var fim = FloatArray(fftN); var win = hann(fftN)
        var acc = DoubleArray(fftN); var frames = 0
        // pdb is always FFT_N bins (the classifier's and the health line's); pdbN is the transform's own resolution
        val pdb = FloatArray(FFT_N); var pdbN = FloatArray(fftN); var sorted = FloatArray(fftN)
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
        var s1I = 0f; var s1Q = 0f; var s1n = 0        // stage-1 WFM average accumulator
        var chanDec: ChannelDecimator? = null; var chanKey = 0   // stage-1 for the narrow modes, rebuilt with the rate
        var audioComb: HfComb? = null   // the plain receiver's HF comb notch, made for its channel rate
        var mixBuf = FloatArray(0); var chanBuf = FloatArray(0)
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
        // Where the DSP thread's time goes, per stage (ns), and the audio it hands the speaker, logged once a second:
        // a thread that falls behind the radio says which stage holds it up.
        var stSpec = 0L; var stHd = 0L; var stDemod = 0L; var stEmit = 0L; var stProc = 0L; var stWait = 0L; var stAll = 0L
        var stWithheld = 0L
        var stItems = 0; var stAudio = 0L; var stBytes = 0L; var stDropped = 0L; var stLast = System.nanoTime()
        // the output's play position, to tell one that stopped playing (still "playing", taking nothing) from a full one
        var headLast = -1; var headStuckSince = 0L
        var underrunLast = 0
        fun underruns(): Int { val u = track?.let { runCatching { it.underrunCount }.getOrDefault(0) } ?: 0; val d = u - underrunLast; underrunLast = u; return maxOf(0, d) }
        // frames written to the output since it opened or was flushed, for the room a paced processor's audio may fill
        var written = 0; var writtenTo: AudioTrack? = null
        fun room(t: AudioTrack): Int {
            if (writtenTo !== t) { writtenTo = t; written = 0 }
            val size = runCatching { t.bufferSizeInFrames }.getOrDefault(AUDIO_RATE / 2)
            val queued = written - runCatching { t.playbackHeadPosition }.getOrDefault(written)
            return (size - queued).coerceIn(0, size)
        }
        // n frames of trackCh channels interleaved
        fun emitFrames(buf: ShortArray, n: Int) {
            val t = track ?: return
            val e0 = System.nanoTime(); val ch = trackCh
            // never waits on the speaker: an output that stops taking audio (a route or focus change on some phones)
            // blocked this thread a second per write and froze the waterfall; what it cannot take now is dropped
            val r = try { t.write(buf, 0, ch * n, AudioTrack.WRITE_NON_BLOCKING) } catch (e: Exception) { AudioTrack.ERROR_DEAD_OBJECT }
            val f = if (r > 0) r / ch else r
            stEmit += System.nanoTime() - e0; if (f > 0) { stAudio += f; if (writtenTo !== t) { writtenTo = t; written = 0 }; written += f }
            if (f in 0 until n) stDropped += n - f
            if (r < 0) { Diag.log("audio output lost (code $r), reopening it"); runCatching { t.release() }; track = null }
        }
        // a mono block plays on the front left and right
        var stereoOut = ShortArray(0)
        fun emit(buf: ShortArray, n: Int) {
            if (track == null) return
            val ch = trackCh
            if (stereoOut.size < ch * n) stereoOut = ShortArray(ch * n)
            if (ch > 2) stereoOut.fill(0, 0, ch * n)
            for (i in 0 until n) { val v = buf[i]; stereoOut[ch * i] = v; stereoOut[ch * i + 1] = v }
            emitFrames(stereoOut, n)
        }
        // A network radio's audio is not on the phone's clock (see DriftResampler): it is stretched or squeezed to
        // keep the output's queue level, so it neither drops nor underruns. A USB radio's goes out untouched.
        // one per output channel, all steered alike so they stay in step
        val drifts = Array(6) { DriftResampler(AUDIO_RATE) }; val drift = drifts[0]
        val driftOuts = Array(6) { ShortArray(0) }; var driftOut = ShortArray(0); var driftTrack: AudioTrack? = null; var driftWas = false
        fun driftSteer(t: AudioTrack, n: Int) {
            if (t !== driftTrack || !driftWas || writtenTo !== t) { for (d in drifts) d.reset(); driftTrack = t; driftWas = true }
            val queued = if (writtenTo === t) written - runCatching { t.playbackHeadPosition }.getOrDefault(written) else 0
            for (d in drifts) d.steer(queued.coerceAtLeast(0), n)
            if (driftOut.size < drift.maxOut(n)) { driftOut = ShortArray(drift.maxOut(n)); for (c in 0 until 6) driftOuts[c] = ShortArray(drift.maxOut(n)) }
        }
        // HD Radio: the analog with the selected program's digital audio mixed in, in stereo or upmixed to 5.1
        var hdMix: HdAudio? = null
        var hdA = FloatArray(0); val hdCh = Array(6) { ShortArray(0) }; var hdOut = ShortArray(0)
        fun pcm16(v: Float): Short = (v * 32768f).toInt().coerceIn(-32768, 32767).toShort()
        fun emitHd(hm: HdAudio, buf: ShortArray, n: Int) {
            if (hdA.size < n) { hdA = FloatArray(n); for (c in 0 until 6) hdCh[c] = ShortArray(n) }
            for (i in 0 until n) hdA[i] = buf[i] / 32768f
            val o = hm.output(hdA, n)
            val ch = trackCh; val nc = minOf(ch, o.size)
            for (c in 0 until nc) { val src = o[c]; val dst = hdCh[c]; for (i in 0 until n) dst[i] = pcm16(src[i]) }
            val t = track
            val srcs: Array<ShortArray>; var k = n
            if (driftAudio && t != null) {
                driftSteer(t, n)
                for (c in 0 until nc) k = minOf(k, drifts[c].process(hdCh[c], n, driftOuts[c]))
                srcs = driftOuts
            } else { driftWas = false; srcs = hdCh }
            if (hdOut.size < ch * k) hdOut = ShortArray(ch * k)
            for (i in 0 until k) for (c in 0 until ch) hdOut[ch * i + c] = if (c < nc) srcs[c][i] else 0
            emitFrames(hdOut, k)
        }
        fun emitAudio(buf: ShortArray, n: Int) {
            val hm = hdMix
            if (hm != null && n > 0) { emitHd(hm, buf, n); return }
            val t = track
            if (!driftAudio || t == null || n <= 0) { driftWas = false; emit(buf, n); return }
            driftSteer(t, n)
            emit(driftOut, drift.process(buf, n, driftOut))
        }
        // The demodulator's own audio at a rate that is not 48 kHz (see AudioPlan) is converted to exactly 48 kHz here,
        // before it is clipped, gated and played; a network radio's drift is taken up after, by the drift resampler.
        var audioRs: AudioRateConverter? = null; var audioRsRate = 0.0
        val rsIn = FloatArray(4096); var rsN = 0; var rsOut = FloatArray(0)
        fun audioRsFlush(c: AudioRateConverter) {
            if (rsOut.size < c.maxOut(rsN)) rsOut = FloatArray(c.maxOut(rsN))
            val k = c.process(rsIn, rsN, rsOut); rsN = 0
            for (i in 0 until k) {
                val sampI = rsOut[i].coerceIn(-32000f, 32000f).toInt()
                val am = if (sampI < 0) -sampI else sampI; if (am > audioPeak) audioPeak = am
                if (voiceOn) voiceDet.push(sampI / 32768f)      // judged before the squelch gates it
                audioBuf[audioLen++] = if (sqOpen) sampI.toShort() else 0
                if (audioLen >= audioBuf.size) { emitAudio(audioBuf, audioLen); audioLen = 0 }
            }
        }
        try {
            val me = Thread.currentThread()
            while (worker === me) {
                val w0 = System.nanoTime()
                val item = try { queue.take() } catch (e: InterruptedException) { break }
                val i0 = System.nanoTime(); stWait += i0 - w0; stItems++; stBytes += item.size
                if (item.isEmpty()) {
                    // a gap the meter found: everything before it has gone to the processor
                    gapAt.remove(item)?.let { g -> (processor as? com.rocketgod.mayhem.core.lora.LoraScanner)?.gap(g.back, g.slack) }
                    continue
                }
                if (dropGap) { dropGap = false; (processor as? com.rocketgod.mayhem.core.lora.LoraScanner)?.gap(0, (item.size / 2).toLong()) }
                try {
                    val len = item.size
                    val nSamp = len / 2
                    if (nSamp < 4) { pool.offer(item); continue }
                    val m = _mode.value
                    val rate = sampleRate
                    val p = processor
                    hdMix = (p as? HdProcessor)?.audio
                    val want6 = hdMix != null && hdSurroundOn && !surroundRefused && _outputChannels.value >= 6
                    hdMix?.let { it.setSurround(want6); it.muted = muteNow }
                    val wantCh = if (want6) 6 else 2
                    track?.let { if (trackCh != wantCh) { runCatching { it.release() }; track = null; lastTrackTry = 0L; written = 0 } }
                    if (p != null && (p !== lastProc || rate != lastProcRate)) {
                        runCatching { p.reset(rate) }.onFailure { Diag.log("processor reset failed: ${it.message}") }
                        lastProc = p; lastProcRate = rate
                    } else if (p == null) lastProc = null
                    if (m != prevMode) {
                        prevI = 0f; prevQ = 0f; deemph = 0f; amDc = 0f; wph = 0.0
                        lpI1 = 0f; lpI2 = 0f; lpQ1 = 0f; lpQ2 = 0f
                        decAcc = 0f; decCnt = 0; s1I = 0f; s1Q = 0f; s1n = 0; audioLen = 0; chanDec = null; rsN = 0; audioRs = null
                        rdsN = 0; sameN = 0
                        if (m != Mode.WFM) { rdsDec.reset(); hdDet.reset(); _rds.value = null; _hd.value = null }
                        prevMode = m
                    }
                    // One output for the life of the stream, paused while there is nothing to hear and resumed after rather
                    // than torn down and rebuilt, so moving between screens can never leave the receiver silent.
                    val wantTrack = m != Mode.NONE || p?.producesAudio == true
                    if (wantTrack && track == null && System.currentTimeMillis() - lastTrackTry > 1000L) {
                        lastTrackTry = System.currentTimeMillis()
                        track = runCatching { newTrack(wantCh) }.onFailure { Diag.log("audio output unavailable: ${it.message}") }.getOrNull()
                        if (track == null && wantCh == 6) { surroundRefused = true; Diag.log("the output refused 5.1, HD Radio plays in stereo") }
                        trackCh = wantCh
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
                        } else if (!wantTrack && playing) { runCatching { tk.pause(); tk.flush() }; written = 0 }
                    }

                    val sp0 = System.nanoTime()
                    // ---- spectrum (~25 fps): every whole FFT frame in this buffer is accumulated (a short buffer gives one
                    // zero-padded frame); wide spans skip frames so about 2.4 M samples a second are transformed, the
                    // widest (a phone at 20 Msps, where this thread also feeds every decoder) about 1.2 M ----
                    val now = System.currentTimeMillis()
                    val skip = max(1, Math.round(rate / (if (rate > 8_000_000) 1_200_000.0 else 2_400_000.0)).toInt())
                    val wantBins = specBinsFor(specBinsWanted)
                    if (wantBins != specBins) {
                        // twice as many transform points as bins, never fewer than FFT_N
                        specBins = wantBins; prevOut = FloatArray(0)
                        val n = (2 * wantBins).coerceIn(FFT_N, FFT_MAX)
                        if (n != fftN) {
                            fftN = n; fre = FloatArray(n); fim = FloatArray(n); win = hann(n)
                            acc = DoubleArray(n); pdbN = FloatArray(n); sorted = FloatArray(n); frames = 0
                        }
                    }
                    if (nSamp >= fftN) {
                        var off = 0
                        while (off + fftN <= nSamp) {
                            for (k in 0 until fftN) {
                                val j = 2 * (off + k)
                                fre[k] = ((item[j].toInt() and 0xff) - 127.4f) * win[k]
                                fim[k] = ((item[j + 1].toInt() and 0xff) - 127.4f) * win[k]
                            }
                            Dsp.fft(fre, fim)
                            for (k in 0 until fftN) acc[k] += (fre[k] * fre[k] + fim[k] * fim[k]).toDouble()
                            frames++
                            off += fftN * skip
                        }
                    } else if (frames == 0) {
                        for (k in 0 until fftN) {
                            if (k < nSamp) { fre[k] = ((item[2 * k].toInt() and 0xff) - 127.4f) * win[k]; fim[k] = ((item[2 * k + 1].toInt() and 0xff) - 127.4f) * win[k] }
                            else { fre[k] = 0f; fim[k] = 0f }
                        }
                        Dsp.fft(fre, fim)
                        for (k in 0 until fftN) acc[k] += (fre[k] * fre[k] + fim[k] * fim[k]).toDouble()
                        frames = 1
                    }
                    if (now - lastSpec > 40L && frames > 0) {
                        lastSpec = now
                        val nAvg = frames
                        val norm = FFT_N.toDouble() / fftN / nAvg
                        val half = fftN / 2
                        for (k in 0 until fftN) pdbN[k] = (10.0 * Math.log10(acc[(k + half) % fftN] * norm + 1e-12)).toFloat()
                        // a larger transform's bins are power-averaged down to FFT_N, so the classifier always sees the same scale
                        val g = fftN / FFT_N
                        if (g == 1) System.arraycopy(pdbN, 0, pdb, 0, FFT_N)
                        else for (k in 0 until FFT_N) {
                            var s = 0.0
                            for (j in 0 until g) s += acc[(k * g + j + half) % fftN]
                            pdb[k] = (10.0 * Math.log10(s / g * norm + 1e-12)).toFloat()
                        }
                        acc.fill(0.0); frames = 0
                        System.arraycopy(pdbN, 0, sorted, 0, fftN); sorted.sort()
                        val median = sorted[fftN / 2]
                        floorEma = if (floorEma.isNaN()) median else floorEma + 0.2f * (median - floorEma)
                        val base = floorEma - SPEC_FLOOR_PAD_DB
                        // peak-downsampled so a narrow carrier never falls between columns; a frame that averaged only a
                        // few transforms is blended with the last so the noise stays flat
                        val group = fftN / specBins
                        val keep = if (prevOut.size == specBins) maxOf(0f, 0.6f - nAvg * 0.05f) else 0f
                        val out = FloatArray(specBins)
                        for (bin in 0 until specBins) {
                            var pk = -999f
                            for (j in 0 until group) { val v = pdbN[bin * group + j]; if (v > pk) pk = v }
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
                                runCatching { AutoPick.onSignals(sigs, pdb, median) }
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
                            val lost = deliveryNote()
                            val health = "%s RX: iqRMS=%.1f dcI=%.1f dcQ=%.1f · peak %+.0f kHz %.0fdB vs floor %.0fdB (Δ%.0f)".format(
                                sourceLabel, rms, sumI / nn, sumQ / nn, offKhz, peak, median, peak - median) + (if (lost.isEmpty()) "" else " · $lost")
                            val nb = bufTotal - bufSeen; val nd = dropTotal - dropSeen; bufSeen += nb; dropSeen += nd
                            val ls = p as? com.rocketgod.mayhem.core.lora.LoraScanner
                            val sk = (ls?.skipped ?: 0L) - skipSeen; skipSeen += sk
                            ls?.load(if (nb > 0) nd.toDouble() / nb else 0.0, sk.toDouble() / rate)
                            if (ls != null && deliveryLosing()) ls.onLosing?.invoke(rate)
                            Diag.log(health + (if (nd > 0) " · DROPPED %d of %d buffers (falling behind)".format(nd, nb) else "") +
                                (if (ls != null) " · LoRa scanner %.0f%% of real time".format(ls.busy * 100) else "") +
                                (if (sk > 0) " · LoRa channels SKIPPED %.0f ms (fell behind)".format(sk * 1000.0 / rate) else ""))
                            _rxHealth.value = health
                            _levelDb.value = peak - median
                            loraLevel = ls?.takeLevel()
                            agcStep(rms, now)
                            if (m != Mode.NONE) Diag.log("SDR audio: peak=%d/32000 %s".format(
                                audioPeak, if (audioPeak > 2500) "— demod producing audio" else "— silent (no modulation / no signal)"))
                            audioPeak = 0
                        }
                    }

                    stSpec += System.nanoTime() - sp0
                    val wantRds = rdsOn && m == Mode.WFM
                    val tuned = _freqHz.value
                    if (wantRds != rdsWas || (wantRds && tuned != rdsFreq)) { rdsDec.reset(); rdsN = 0; rdsWas = wantRds; rdsFreq = tuned; if (wantRds) _rds.value = null }
                    val wantSame = sameOn && m == Mode.NFM
                    if (wantSame != sameWas) { sameDec.reset(0); sameN = 0; sameWas = wantSame }
                    val wantHd = hdOn && m == Mode.WFM
                    if (wantHd != hdWas) { hdDet.reset(); hdWas = wantHd }
                    val hd0 = System.nanoTime()
                    if (wantHd && abs(_offsetHz.value) < rate / 2 - 240_000) runCatching { hdDet.push(item, nSamp, rate, _offsetHz.value.toDouble()) }
                    val dm0 = System.nanoTime(); stHd += dm0 - hd0; val em0 = stEmit

                    // ---- demod → audio (+ FM tap for packet processors) ----
                    // (and nothing is demodulated while HD AUTO looks across the band at a wide rate: only the spectrum runs then)
                    if (m != Mode.NONE && !holdDemod && abs(_offsetHz.value) < rate / 2 - 40_000) {     // a channel slid off the span is silent
                        // Two-stage decimation. Stage 1 brings the IQ down to an intermediate rate near the channel: WFM ->
                        // ~240 kHz by a plain average, everything else -> ~48 kHz through a CIC + FIR (ChannelDecimator)
                        // that keeps neighbors from folding onto the channel. Stage 2 decimates the audio to 48 kHz.
                        if (m != Mode.WFM && (chanDec == null || chanKey != rate)) { chanDec = ChannelDecimator(max(1, rate / AUDIO_RATE)); chanKey = rate }
                        val plan = AudioPlan.of(rate, m == Mode.WFM)
                        val stage1 = plan.stage1
                        val interRate = rate / stage1
                        val stage2 = plan.stage2
                        // the demodulator's audio is at rate / stage1 / stage2; a rate that is not 48 kHz times both
                        // (1.8 Msps gives 50 kHz for NFM) is converted to exactly 48 kHz, an exact one goes out untouched
                        if (plan.exact) audioRs = null
                        else if (audioRs == null || audioRsRate != plan.audioRate) { audioRs = AudioRateConverter(plan.audioRate); audioRsRate = plan.audioRate; rsN = 0 }
                        val ars = audioRs
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
                        // the channel mixed to DC
                        if (mixBuf.size < 2 * nSamp) mixBuf = FloatArray(2 * nSamp)
                        for (i in 0 until nSamp) {
                            val iv = (item[2 * i].toInt() and 0xff) - 127.4f
                            val qv = (item[2 * i + 1].toInt() and 0xff) - 127.4f
                            if (off != 0) {
                                mixBuf[2 * i] = iv * ncoR - qv * ncoI; mixBuf[2 * i + 1] = iv * ncoI + qv * ncoR
                                val nr = ncoR * stepR - ncoI * stepI; ncoI = ncoR * stepI + ncoI * stepR; ncoR = nr
                                if (++ncoN >= 4096) { ncoN = 0; val g = 1f / sqrt(ncoR * ncoR + ncoI * ncoI); ncoR *= g; ncoI *= g }
                            } else { mixBuf[2 * i] = iv; mixBuf[2 * i + 1] = qv }
                        }
                        var nChan = 0
                        if (m == Mode.WFM) {
                            if (chanBuf.size < 2 * (nSamp / stage1 + 2)) chanBuf = FloatArray(2 * (nSamp / stage1 + 2))
                            for (i in 0 until nSamp) {
                                s1I += mixBuf[2 * i]; s1Q += mixBuf[2 * i + 1]; s1n++
                                if (s1n >= stage1) { chanBuf[2 * nChan] = s1I / s1n; chanBuf[2 * nChan + 1] = s1Q / s1n; nChan++; s1I = 0f; s1Q = 0f; s1n = 0 }
                            }
                        } else {
                            val cd = chanDec!!
                            if (chanBuf.size < cd.outSize(nSamp)) chanBuf = FloatArray(cd.outSize(nSamp))
                            nChan = cd.process(mixBuf, nSamp, chanBuf)
                            // below 30 MHz the HF comb's lines that are really there come out of the channel before it is demodulated
                            val lo = _freqHz.value
                            if (lo + off < HfComb.TOP_HZ + 8_000) {
                                val cmb = audioComb?.takeIf { it.fs == interRate.toDouble() } ?: HfComb(interRate.toDouble(), 8_000.0, Diag::log).also { audioComb = it }
                                cmb.tune(lo.toDouble(), off.toDouble()); cmb.processInterleaved(chanBuf, nChan)
                            }
                        }
                        for (j in 0 until nChan) {
                            run {
                                var ci = chanBuf[2 * j]; var cq = chanBuf[2 * j + 1]
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
                                    if (ars != null) { rsIn[rsN++] = v; if (rsN >= rsIn.size) audioRsFlush(ars) }
                                    else {
                                        val sampI = v.coerceIn(-32000f, 32000f).toInt()
                                        val am = if (sampI < 0) -sampI else sampI; if (am > audioPeak) audioPeak = am
                                        if (voiceOn) voiceDet.push(sampI / 32768f)      // judged before the squelch gates it
                                        audioBuf[audioLen++] = if (sqOpen) sampI.toShort() else 0
                                        if (audioLen >= audioBuf.size) { emitAudio(audioBuf, audioLen); audioLen = 0 }
                                    }
                                }
                            }
                        }
                        if (ars != null && rsN > 0) audioRsFlush(ars)
                        if (voiceOn && now - lastVoice > 250L) { lastVoice = now; _voice.value = voiceDet.read() }
                        if (wantFm && fmN > 0) { runCatching { p!!.onFm(fmBuf, fmN, interRate) }; fmN = 0 }
                        if (audioLen > 0) { emitAudio(audioBuf, audioLen); audioLen = 0 }
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
                    val pr0 = System.nanoTime(); stDemod += pr0 - dm0 - (stEmit - em0)
                    if (p != null) runCatching { p.onIq(item, len, rate) }.onFailure { Diag.log("processor error: ${it.message}") }
                    stProc += System.nanoTime() - pr0
                    val t = track
                    if (p != null && p.producesAudio && t != null) {
                        // a paced processor keeps what the output has no room for (nothing dropped); a full output that
                        // stops playing still reads as refusing audio, for the stuck-output check below
                        val max = if (p.pacedAudio) room(t).coerceAtMost(procAudio.size) else procAudio.size
                        if (p.pacedAudio && max == 0) stWithheld++
                        val k = if (max > 0) p.drainAudio(procAudio, max) else 0
                        if (k > 0) {
                            for (i in 0 until k) {
                                val v = (procAudio[i] * 32000f).toInt().coerceIn(-32767, 32767)
                                procPcm[i] = v.toShort()
                                val a = if (v < 0) -v else v
                                if (a > audioPeak) audioPeak = a
                            }
                            if (p.pacedAudio) emit(procPcm, k) else emitAudio(procPcm, k)
                        }
                    }
                    pool.offer(item)
                    val i1 = System.nanoTime(); stAll += i1 - i0
                    if (i1 - stLast >= 1_000_000_000L) {
                        val sec = (i1 - stLast) / 1e9; fun ms(v: Long) = v / 1e6 / sec
                        Diag.log("DSP per s: %d bufs (%.0f KB) · busy %.0f ms · spectrum %.0f · HD %.0f · demod %.0f · audio write %.0f (%d samples, want %d, dropped %d, underruns %d) · %s %.0f · idle %.0f".format(
                            (stItems / sec).toInt(), stBytes / 1024.0 / sec, ms(stAll), ms(stSpec), ms(stHd), ms(stDemod), ms(stEmit), (stAudio / sec).toLong(), AUDIO_RATE,
                            (stDropped / sec).toLong(), underruns(), p?.javaClass?.simpleName ?: "no processor", ms(stProc), ms(stWait)))
                        // an output that says it plays but whose position has not moved for 2 s while audio was refused
                        // has stopped: it is opened again (the next buffer does it)
                        val tk = track
                        if (tk != null && tk.playState == AudioTrack.PLAYSTATE_PLAYING) {
                            val head = runCatching { tk.playbackHeadPosition }.getOrDefault(-1)
                            val nowMs = System.currentTimeMillis()
                            if (head != headLast || (stDropped == 0L && stWithheld == 0L)) { headLast = head; headStuckSince = nowMs }
                            else if (nowMs - headStuckSince >= 2000L) {
                                Diag.log("audio output stopped playing (position stuck at $head for 2 s), reopening it")
                                runCatching { tk.release() }; track = null; headLast = -1; headStuckSince = nowMs
                            }
                        } else { headLast = -1; headStuckSince = System.currentTimeMillis() }
                        stSpec = 0; stHd = 0; stDemod = 0; stEmit = 0; stProc = 0; stWait = 0; stAll = 0; stItems = 0; stAudio = 0; stBytes = 0; stDropped = 0; stWithheld = 0; stLast = i1
                    }
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

    private fun newTrack(ch: Int = 2): AudioTrack {
        val mask = if (ch == 6) AudioFormat.CHANNEL_OUT_5POINT1 else AudioFormat.CHANNEL_OUT_STEREO
        val minBuf = AudioTrack.getMinBufferSize(AUDIO_RATE, mask, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(AUDIO_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(mask).build())
            .setBufferSizeInBytes(max(minBuf, AUDIO_RATE / 2 * 2 * ch))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        // writes never wait (the radio thread must not), so the output keeps its own cushion instead: it starts, and
        // resumes after running dry, only with 0.2 s queued (an empty one stuttered on every late buffer)
        runCatching { t.setStartThresholdInFrames(AUDIO_RATE / 5) }
        runCatching { t.play() }
        return t
    }

    private var floorEma = Float.NaN
}
