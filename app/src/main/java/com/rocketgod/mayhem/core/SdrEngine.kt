package com.rocketgod.mayhem.core

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.usb.HackRfOne
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ArrayBlockingQueue
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

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
    /** Latest spectrum: [SPEC_BINS] normalised magnitudes 0..1, low→high frequency (fftshifted). */
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

    const val SPEC_BINS = 256
    private const val FFT_N = 1024

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
    }

    /** Enter an app: audio mode, dial, IQ rate, gain preset and the baseband processor, all at once. */
    fun configure(mode: Mode, freqHz: Long, rateHz: Int, lna: Int, vga: Int, amp: Boolean, proc: IqProcessor?) {
        processor = null
        _mode.value = mode
        _rateHz.value = rateHz
        _radioLna.value = (lna.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP
        _radioVga.value = (vga.coerceIn(0, VGA_MAX) / VGA_STEP) * VGA_STEP
        _radioAmp.value = amp
        _freqHz.value = freqHz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        if (proc == null && mode != Mode.NONE) { radioFreqHz = _freqHz.value; radioMode = mode }
        syncDriver()
        processor = proc
    }

    fun tune(hz: Long) {
        val f = hz.coerceIn(FREQ_MIN_HZ, FREQ_MAX_HZ)
        _freqHz.value = f
        if (processor == null && _mode.value != Mode.NONE) radioFreqHz = f
        HackRfOne.targetFreqHz = f
    }
    fun nudge(deltaHz: Long) = tune(_freqHz.value + deltaHz)

    fun setRate(rate: Int) { _rateHz.value = rate; HackRfOne.targetRateHz = rate }

    fun setRadioLna(db: Int) { _radioLna.value = (db.coerceIn(0, LNA_MAX) / LNA_STEP) * LNA_STEP; syncDriver() }
    fun setRadioVga(db: Int) { _radioVga.value = (db.coerceIn(0, VGA_MAX) / VGA_STEP) * VGA_STEP; syncDriver() }
    fun toggleRadioAmp() { _radioAmp.value = !_radioAmp.value; syncDriver() }

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
        val powerDb = FloatArray(SPEC_BINS)
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

                // ---- spectrum (~20 fps) ----
                val now = System.currentTimeMillis()
                if (now - lastSpec > 50L) {
                    lastSpec = now
                    Dsp.loadIq(item, nSamp, fre, fim)
                    Dsp.fft(fre, fim)
                    Dsp.powerDb(fre, fim, powerDb)
                    emitSpectrum(powerDb)
                    if (now - lastDiag > 1000L) {
                        lastDiag = now
                        var sumI = 0.0; var sumQ = 0.0; var sumSq = 0.0
                        val nn = min(nSamp, 4096)
                        for (k in 0 until nn) {
                            val iv = (item[2 * k].toInt() and 0xff) - 127.4; val qv = (item[2 * k + 1].toInt() and 0xff) - 127.4
                            sumI += iv; sumQ += qv; sumSq += iv * iv + qv * qv
                        }
                        val rms = sqrt(sumSq / nn)
                        var peak = -999f; var peakIdx = 0; var sum = 0.0
                        for (k in 0 until SPEC_BINS) { val d = powerDb[k]; sum += d; if (d > peak) { peak = d; peakIdx = k } }
                        val binHz = rate.toDouble() / SPEC_BINS
                        val offKhz = (peakIdx - SPEC_BINS / 2) * binHz / 1000.0
                        val avg = (sum / SPEC_BINS).toFloat()
                        val health = "%s RX: iqRMS=%.1f dcI=%.1f dcQ=%.1f · peak %+.0f kHz %.0fdB vs avg %.0fdB (Δ%.0f)".format(
                            sourceLabel, rms, sumI / nn, sumQ / nn, offKhz, peak, avg, peak - avg)
                        Diag.log(health)
                        _rxHealth.value = health
                        _levelDb.value = peak - avg
                        if (m != Mode.NONE) Diag.log("SDR audio: peak=%d/32000 %s".format(
                            audioPeak, if (audioPeak > 2500) "— demod producing audio" else "— silent (no modulation / no signal)"))
                        audioPeak = 0
                    }
                }

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
                    var i = 0
                    while (i < nSamp) {
                        s1I += (item[2 * i].toInt() and 0xff) - 127.4f
                        s1Q += (item[2 * i + 1].toInt() and 0xff) - 127.4f
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
                                audioBuf[audioLen++] = if (sqOpen) sampI.toShort() else 0
                                if (audioLen >= audioBuf.size) { track?.write(audioBuf, 0, audioLen); audioLen = 0 }
                            }
                        }
                        i++
                    }
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
    private fun emitSpectrum(db: FloatArray) {
        // Auto-range: track the noise floor (EMA of the per-frame minimum) and scale a fixed 45 dB span above it.
        var minDb = Float.MAX_VALUE
        for (bin in 0 until SPEC_BINS) if (db[bin] < minDb) minDb = db[bin]
        floorEma = if (floorEma.isNaN()) minDb else floorEma + 0.05f * (minDb - floorEma)
        val out = FloatArray(SPEC_BINS)
        for (bin in 0 until SPEC_BINS) out[bin] = ((db[bin] - floorEma) / 45f).coerceIn(0f, 1f)
        _spectrum.value = out
    }
}
