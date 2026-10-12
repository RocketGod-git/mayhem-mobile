package com.rocketgod.mayhem.core.ham

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * The HAM receiver's DIGITAL tab: which decoders listen to the receiver, AUTO's arbitration between them, and
 * what they have produced. Twin of the digital section of web/src/dsp.worker.ts.
 *
 * AUTO runs the three audio modems together and shows whichever is making sense, and keeps the 4FSK receiver
 * looking for DMR / P25 until an analog voice channel is evident (a CTCSS tone, or 2.5 s of carrier with no
 * checked DMR data); then it goes back to plain audio until the carrier drops.
 */
object HamDigital {
    enum class Mode { AUTO, CW, RTTY, PSK31, FT8, SSTV, DMR, P25, OFF }

    data class Settings(
        val mode: Mode = Mode.OFF, val pskHz: Double = 1000.0, val rttyBaud: Double = 45.45, val rttyShift: Double = 170.0,
        val rttyRev: Boolean = false, val dmrSlot: Int = 0,
    )

    data class Status(val conf: List<Pair<String, Int>> = emptyList(), val winner: String = "", val wpm: Int = 0)

    private val demod get() = Ham.demod
    val cw = CwDecoder(600.0)
    val rtty = RttyDecoder()
    val psk = Psk31Decoder(1000.0)
    val ft8 = Ft8Decoder()
    val sstv = SstvDecoder()
    val dmr = DmrDecoder()
    private val all: List<DigitalDecoder> = listOf(cw, rtty, psk, ft8, sstv)

    private val _settings = MutableStateFlow(Settings())
    val settings: StateFlow<Settings> = _settings.asStateFlow()
    private val _text = MutableStateFlow("")
    val text: StateFlow<String> = _text.asStateFlow()
    private val _ft8 = MutableStateFlow<List<Ft8Decode>>(emptyList())
    val ft8List: StateFlow<List<Ft8Decode>> = _ft8.asStateFlow()
    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()
    private val _dmr = MutableStateFlow<DmrStatus?>(null)
    val dmrStatus: StateFlow<DmrStatus?> = _dmr.asStateFlow()
    private val _p25 = MutableStateFlow<P25Status?>(null)
    val p25Status: StateFlow<P25Status?> = _p25.asStateFlow()

    /** FM taps other screens hang on the receiver (the Satellites app's packet / APT decoders). */
    @Volatile var satTaps: List<FmTap> = emptyList()
        set(v) { field = v; applyTaps() }
    /** A satellite service that supplies its own picture and wants the analog audio muted (LRPT). */
    @Volatile var satMute = false
        set(v) { field = v; demod.analogMute = dmrOnly() || v }

    @Volatile private var winner = ""
    @Volatile private var autoSettled = false
    private var autoCarrierSince = 0L
    private val textBuf = StringBuilder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ticker: Job? = null

    init {
        for (d in all) d.onText = { t, _ ->
            val m = _settings.value.mode
            if (m.name == d.name || (m == Mode.AUTO && (winner == d.name || d.name == "FT8" || d.name == "SSTV"))) append(t)
        }
        ft8.onDecodes = { list, _ -> _ft8.value = (list + _ft8.value).take(200) }
        sstv.onImage = { Picture.onSstv(it) }
        dmr.onLog = { if (dvMode()) append("$it\n") }
        dmr.p25.onLog = { if (dvMode()) append("$it\n") }
        dmr.onAudio = { pcm, n -> demod.inject(pcm, n) }
    }

    private fun append(t: String) {
        synchronized(textBuf) {
            textBuf.append(t)
            if (textBuf.length > 8000) textBuf.delete(0, textBuf.length - 6000)
            _text.value = textBuf.toString()
        }
    }

    fun clear() { synchronized(textBuf) { textBuf.clear(); _text.value = "" }; _ft8.value = emptyList() }

    private fun dvMode() = _settings.value.mode.let { it == Mode.DMR || it == Mode.P25 || it == Mode.AUTO }
    private fun dmrOnly() = _settings.value.mode.let { it == Mode.DMR || it == Mode.P25 }

    private fun applyTaps() {
        val m = _settings.value.mode
        val wantDmr = m == Mode.DMR || m == Mode.P25 || (m == Mode.AUTO && !autoSettled)
        demod.setFmTaps((if (wantDmr) listOf<FmTap>(dmr) else emptyList()) + satTaps)
    }

    fun update(f: (Settings) -> Settings) = apply(f(_settings.value))

    private fun apply(s: Settings) {
        val prev = _settings.value
        _settings.value = s
        val m = s.mode
        demod.onDsp {
            val dvWanted = m == Mode.DMR || m == Mode.P25 || m == Mode.AUTO
            val dvWas = prev.mode == Mode.DMR || prev.mode == Mode.P25 || prev.mode == Mode.AUTO
            if (dvWanted && !dvWas) dmr.reset()
            dmr.p25On = m == Mode.P25 || m == Mode.AUTO
            dmr.slotSel = s.dmrSlot
            autoSettled = false; autoCarrierSince = 0
            cw.setPitch(Ham.state.value.pitch)
            if (s.pskHz != psk.center) psk.setCenter(s.pskHz)
            if (s.rttyBaud != rtty.baud || s.rttyShift != rtty.shift || s.rttyRev != rtty.reverse) rtty.configure(2125.0, s.rttyShift, s.rttyBaud, s.rttyRev)
            val wanted = when (m) {
                Mode.OFF, Mode.DMR, Mode.P25 -> emptyList()
                Mode.AUTO -> all
                else -> all.filter { it.name == m.name }
            }
            for (d in wanted) if (d !in demod.digital) d.reset()
            demod.digital = wanted
        }
        demod.analogMute = m == Mode.DMR || m == Mode.P25 || satMute
        applyTaps()
        if (m == Mode.OFF) { ticker?.cancel(); ticker = null; _status.value = Status() }
        else if (ticker == null) ticker = scope.launch { while (isActive) { delay(700); tick() } }
    }

    /** Keep the CW decoder on the receiver's pitch when it changes. */
    fun pitchChanged(hz: Double) { demod.onDsp { cw.setPitch(hz) } }

    private fun tick() {
        val m = _settings.value.mode
        val dv = if (dvMode()) dmr.status() else null
        _dmr.value = dv
        if (dvMode()) _p25.value = dmr.p25.status(dmr.samples)
        if (m == Mode.AUTO) {
            val strong = dv != null && dv.locked && dv.strong
            demod.analogMute = strong || satMute
            val was = autoSettled
            if (!demod.carrier) { autoCarrierSince = 0; autoSettled = false }
            else if (!strong) {
                if (autoCarrierSince == 0L) autoCarrierSince = System.currentTimeMillis()
                if (demod.tone > 0 || System.currentTimeMillis() - autoCarrierSince > 2500) autoSettled = true
            } else { autoSettled = false; autoCarrierSince = 0 }
            if (autoSettled != was) { applyTaps(); if (!autoSettled) demod.onDsp { dmr.reset() } }
        } else { autoSettled = false; autoCarrierSince = 0 }
        val ds = demod.digital
        if (ds.isEmpty() && dv == null) return
        var best: DigitalDecoder? = ds.firstOrNull()
        for (d in ds) if (d.name != "FT8" && d.confidence > (best?.confidence ?: 0f)) best = d
        if (m == Mode.AUTO) winner = if (dv?.locked == true) "DMR" else if (best != null && best.confidence > 0.35f) best.name else ""
        val conf = ds.map { it.name to (it.confidence * 100).roundToInt() }.toMutableList()
        if (dv != null) conf += "DMR" to (if (dv.locked) 100 else 0)
        _status.value = Status(conf, if (m == Mode.AUTO) (if (autoSettled) "ANALOG VOICE" else winner) else m.name, cw.wpm)
    }

    /** The mode a contact should be logged under right now. */
    fun logMode(rx: HamDemod.Mode): String {
        val d = _settings.value.mode
        val ssb = rx == HamDemod.Mode.USB || rx == HamDemod.Mode.LSB || rx == HamDemod.Mode.CW
        if (ssb && d in setOf(Mode.CW, Mode.RTTY, Mode.PSK31, Mode.FT8, Mode.SSTV)) return d.name
        if (rx == HamDemod.Mode.NFM && (d == Mode.DMR || (d == Mode.AUTO && winner == "DMR"))) return "DMR"
        if (ssb && d == Mode.AUTO && winner.isNotEmpty() && winner != "ANALOG VOICE") return winner
        return if (rx == HamDemod.Mode.NFM) "FM" else rx.name
    }
}
