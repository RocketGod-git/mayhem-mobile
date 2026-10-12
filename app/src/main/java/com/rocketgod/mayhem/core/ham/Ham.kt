package com.rocketgod.mayhem.core.ham

import android.content.Context
import com.rocketgod.mayhem.core.Mic
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.HamDemod.AgcMode
import com.rocketgod.mayhem.core.ham.HamDemod.Mode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The HAM app's state and tuning model.
 *
 * It is a panadapter: the LO stays put while the channel moves around inside the span, so the waterfall does not
 * lurch with every step and the HackRF's DC spike stays off the channel. The LO is only moved when the channel
 * gets within [GUARD] of the span edge, or so close to the LO that the spike would land in it — and then it is
 * placed [LO_OFFSET] above the channel, leaving the band visible to both sides.
 *
 * MONITOR swaps the single receiver for [BandMonitor]: the LO sits on the band and every raster channel in the
 * span is watched at once.
 */
object Ham {
    const val GUARD = 120_000L
    const val LO_OFFSET = 250_000L
    private val rate get() = SdrEngine.IQ_RATE

    enum class Tab(val label: String) { RX("RECEIVE"), MONITOR("MONITOR"), DIGI("DIGITAL"), TX("TRANSMIT"), LOG("LOGBOOK") }

    val demod = HamDemod()
    val monitor = BandMonitor()

    data class State(
        val channel: Long = 146_520_000,
        val lo: Long = 146_520_000 + LO_OFFSET,
        val mode: Mode = Mode.NFM,
        val pbLo: Double = 0.0,      // pass band, Hz (see HamDemod.Params)
        val pbHi: Double = 6000.0,
        val shift: Double = 0.0,     // passband tuning, SSB only
        val pitch: Double = 600.0,
        val agc: AgcMode = AgcMode.SLOW,
        val nr: Boolean = false,
        val anf: Boolean = false,
        val squelch: Int = 6,
        val volume: Float = 1f,
        /** Listening on the repeater input; [back] is the output to return to. */
        val rev: Boolean = false,
        val back: Long = 0,
    ) {
        /** The width the filter chips select, in the same terms the chips are labelled. */
        val width: Double get() = when (mode) {
            Mode.USB, Mode.LSB, Mode.CW -> pbHi - pbLo
            else -> pbHi * 2
        }
    }

    data class MonitorUi(
        val spacing: Int = 12_500, val threshold: Int = 8, val listen: BandMonitor.Listen = BandMonitor.Listen.MIX, val lock: Int = -1,
        /** Activity log: "hh:mm:ss  145.2300 MHz", newest first. */
        val log: List<String> = emptyList(),
    )

    data class Ptt(val on: Boolean = false, val dev: Int = 5000, val tone: Double = 0.0)

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private val _tab = MutableStateFlow(Tab.RX)
    val tab: StateFlow<Tab> = _tab.asStateFlow()
    private val _mon = MutableStateFlow(MonitorUi())
    val mon: StateFlow<MonitorUi> = _mon.asStateFlow()
    private val _ptt = MutableStateFlow(Ptt())
    val ptt: StateFlow<Ptt> = _ptt.asStateFlow()
    /** Where the monitor's span is centred while MONITOR is up. */
    private var monCentre = 0L
    private var lastOpen = emptyList<Int>()

    /** Filter choices per mode, labelled as a radio would label them. */
    val WIDTHS: Map<Mode, List<Pair<String, Double>>> = mapOf(
        Mode.USB to listOf("1.8k" to 1800.0, "2.4k" to 2400.0, "2.7k" to 2700.0, "3.0k" to 3000.0, "3.5k" to 3500.0),
        Mode.LSB to listOf("1.8k" to 1800.0, "2.4k" to 2400.0, "2.7k" to 2700.0, "3.0k" to 3000.0, "3.5k" to 3500.0),
        Mode.CW to listOf("100" to 100.0, "250" to 250.0, "500" to 500.0, "1k" to 1000.0),
        Mode.AM to listOf("4k" to 4000.0, "6k" to 6000.0, "8k" to 8000.0, "10k" to 10000.0),
        Mode.NFM to listOf("8k" to 8000.0, "12.5k" to 12500.0, "16k" to 16000.0, "25k" to 25000.0),
        Mode.WFM to listOf("200k" to 200_000.0),   // broadcast FM is one width; hi is half of it
    )

    /** Hands the radio to the HAM receiver (or the band monitor). The built-in demodulator is off: we own the audio. */
    fun open() {
        stopPtt()
        if (_tab.value == Tab.MONITOR) { openMonitor(); return }
        val d = HamDigital.settings.value.mode
        if (_tab.value == Tab.DIGI && d == HamDigital.Mode.FT8 && _state.value.mode != Mode.USB) setMode(Mode.USB)
        if (_tab.value == Tab.DIGI && (d == HamDigital.Mode.DMR || d == HamDigital.Mode.P25) && _state.value.mode != Mode.NFM) setMode(Mode.NFM)
        val s = _state.value.copy(lo = _state.value.channel + LO_OFFSET)
        _state.value = s
        SdrEngine.configure(SdrEngine.Mode.NONE, s.lo, rate, 32, 40, false, demod)
        push()
    }

    fun setTab(t: Tab) {
        if (t == _tab.value) return
        val wasMon = _tab.value == Tab.MONITOR
        _tab.value = t
        if (t == Tab.MONITOR || wasMon) open() else stopPtt()
    }

    fun tune(hzIn: Long) {
        val hz = hzIn.coerceIn(1_000_000L, 6_000_000_000L)
        if (_tab.value == Tab.MONITOR) {
            _state.value = _state.value.copy(channel = hz)
            // inside the monitored span: lock that channel; outside it: move the whole monitor there
            if (abs(hz - monCentre) > rate / 2 - GUARD) { openMonitor(); return }
            val r = monitor.report.value
            if (r.count > 0) {
                val k = ((hz - r.first).toDouble() / r.spacing).roundToInt()
                if (k in 0 until r.count) { _mon.value = _mon.value.copy(lock = k, listen = BandMonitor.Listen.LOCK); monitorSend() }
            }
            return
        }
        var s = _state.value.copy(channel = hz)
        val off = hz - s.lo
        if (abs(off) > rate / 2 - GUARD || abs(off) < 15_000) {
            s = s.copy(lo = hz + LO_OFFSET)
            SdrEngine.tune(s.lo)
        }
        _state.value = s
        push()
    }

    fun nudge(delta: Long) = tune(_state.value.channel + delta)

    /** Tuning steps for the current band: ±step and ±10×step. */
    fun steps(): LongArray {
        val st = bandOf(_state.value.channel)?.step ?: if (_state.value.channel < 30_000_000) 500L else 12_500L
        return longArrayOf(-st * 10, -st, st, st * 10)
    }

    fun setMode(m: Mode) {
        val (lo, hi) = when (m) {
            Mode.USB, Mode.LSB -> 100.0 to 2800.0
            Mode.CW -> 0.0 to 500.0
            Mode.AM -> 0.0 to 3000.0
            Mode.WFM -> 0.0 to 100_000.0   // ±100 kHz: the 200 kHz broadcast channel
            Mode.NFM -> 0.0 to 6000.0
        }
        update { it.copy(mode = m, pbLo = lo, pbHi = hi, shift = 0.0) }
    }

    fun setWidth(w: Double) = update {
        when (it.mode) {
            Mode.USB, Mode.LSB -> it.copy(pbLo = 100.0, pbHi = 100.0 + w)
            Mode.CW -> it.copy(pbLo = 0.0, pbHi = w)
            else -> it.copy(pbHi = w / 2)
        }
    }

    /** Wide pass band for a satellite image service (APT / LRPT want ±20 kHz). */
    fun setHalfWidth(hz: Double) = update { it.copy(pbLo = 0.0, pbHi = hz) }

    fun setShift(hz: Double) = update { it.copy(shift = hz) }
    fun setPitch(hz: Double) { update { it.copy(pitch = hz) }; HamDigital.pitchChanged(hz) }
    fun setAgc(a: AgcMode) = update { it.copy(agc = a) }
    fun toggleNr() = update { it.copy(nr = !it.nr) }
    fun toggleAnf() = update { it.copy(anf = !it.anf) }
    fun setSquelch(db: Int) = update { it.copy(squelch = db) }
    fun setVolume(v: Float) { update { it.copy(volume = v) }; if (_tab.value == Tab.MONITOR) monitorSend() }

    /** Jump to a band's calling frequency in the mode it expects. */
    fun pickBand(b: Band) {
        update { it.copy(rev = false) }
        if (b.mode != _state.value.mode) setMode(b.mode)
        if (_tab.value == Tab.MONITOR) {
            _state.value = _state.value.copy(channel = b.calling ?: b.lo)
            _mon.value = _mon.value.copy(lock = -1)
            openMonitor()
            return
        }
        tune(b.calling ?: b.lo)
    }

    /** Listen on the repeater input (to hear the station directly), and back again. */
    fun toggleReverse() {
        val s = _state.value
        if (!s.rev) {
            val input = repeaterInput(s.channel) ?: return
            _state.value = s.copy(rev = true, back = s.channel)
            tune(input)
        } else {
            _state.value = s.copy(rev = false)
            tune(if (s.back != 0L) s.back else s.channel)
        }
    }

    private fun update(f: (State) -> State) { _state.value = f(_state.value); push() }

    private fun push() {
        val s = _state.value
        val ssb = s.mode == Mode.USB || s.mode == Mode.LSB
        demod.set(
            HamDemod.Params(
                offsetHz = (s.channel - s.lo).toDouble(),
                mode = s.mode,
                lo = if (ssb) s.pbLo + s.shift else s.pbLo,
                hi = if (ssb) s.pbHi + s.shift else s.pbHi,
                pitch = s.pitch,
                agc = s.agc,
                nr = s.nr,
                anf = s.anf,
                squelchDb = if (s.mode == Mode.NFM) s.squelch else 0,
                volume = s.volume,
            )
        )
    }

    // ---- MONITOR -----------------------------------------------------------------------------------------
    /** The LO sits on the band (or the current channel) and every raster channel in the span is watched. */
    private fun openMonitor(at: Long? = null) {
        val s = _state.value; val band = bandOf(s.channel)
        val centre = at ?: if (band != null && band.hi - band.lo <= rate) (band.lo + band.hi) / 2 else s.channel + 10_000
        monCentre = centre
        SdrEngine.configure(SdrEngine.Mode.NONE, centre, rate, 32, 40, false, monitor)
        monitorSend()
    }

    /** Slide the monitored span (it re-plants the whole channel set). */
    fun monitorMove(centre: Long) { if (_tab.value == Tab.MONITOR) openMonitor(centre) }
    fun monitorCentre(): Long = monCentre

    private fun monitorSend() {
        val s = _state.value; val m = _mon.value; val band = bandOf(s.channel)
        monitor.set(BandMonitor.Params(m.spacing, band?.lo ?: (s.channel / 1_000_000 * 1_000_000), m.threshold, m.listen, m.lock, 2, s.volume, monCentre))
    }

    fun monitorListen(l: BandMonitor.Listen) { _mon.value = _mon.value.copy(listen = l, lock = if (l == BandMonitor.Listen.LOCK) _mon.value.lock else -1); monitorSend() }
    fun monitorSpacing(hz: Int) { _mon.value = _mon.value.copy(spacing = hz, lock = -1); monitorSend() }
    fun monitorThreshold(db: Int) { _mon.value = _mon.value.copy(threshold = db); monitorSend() }

    /** Tap a channel: lock it; tap it again: back to mixing everything open. */
    fun monitorLock(k: Int) {
        val m = _mon.value
        _mon.value = if (m.lock == k) m.copy(lock = -1, listen = BandMonitor.Listen.MIX) else m.copy(lock = k, listen = BandMonitor.Listen.LOCK)
        monitorSend()
    }

    /** Called by the screen on each monitor report: newly opened channels go into the activity log. */
    fun monitorActivity(r: BandMonitor.Report) {
        val newly = r.open.filter { it !in lastOpen }
        lastOpen = r.open
        if (newly.isEmpty()) return
        val c = java.util.Calendar.getInstance()
        val t = "%02d:%02d:%02d".format(c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE), c.get(java.util.Calendar.SECOND))
        _mon.value = _mon.value.copy(log = (newly.map { "$t  %.4f MHz".format((r.first + it.toLong() * r.spacing) / 1e6) } + _mon.value.log).take(60))
    }

    // ---- PTT ---------------------------------------------------------------------------------------------
    fun setDeviation(hz: Int) { _ptt.value = _ptt.value.copy(dev = hz) }
    fun setTone(hz: Double) { _ptt.value = _ptt.value.copy(tone = hz) }

    /** The frequency a key-up goes out on: the repeater input when listening to an output. */
    fun txFreq(): Long { val s = _state.value; return if (s.rev) s.channel else repeaterInput(s.channel) ?: s.channel }

    /** Key up: the microphone goes out as FM on [freq] (default [txFreq]) with the CTCSS tone, until [stopPtt]. */
    fun startPtt(ctx: Context, freq: Long? = null, tone: Double? = null): String? {
        if (_ptt.value.on) return null
        if (!Mic.start(ctx)) return "no microphone"
        val f = freq ?: txFreq()
        if (!Tx.fmVoice(f, _ptt.value.dev.toDouble(), tone ?: _ptt.value.tone) { Mic.read() }) { Mic.stop(); return Tx.status.value }
        _ptt.value = _ptt.value.copy(on = true)
        return null
    }

    fun stopPtt() {
        if (!_ptt.value.on) return
        Tx.stop(); Mic.stop()
        _ptt.value = _ptt.value.copy(on = false)
    }

    // ---- S-meter -----------------------------------------------------------------------------------------
    /** Rough dBm from dBFS: the HackRF's ADC clips near −5 dBm at zero gain, less whatever gain is dialled in. */
    fun dbm(meterDb: Float): Float {
        val gain = SdrEngine.radioLna.value + SdrEngine.radioVga.value + if (SdrEngine.radioAmp.value) 14 else 0
        return meterDb - 5 - gain
    }

    /** S9 is −73 dBm below 30 MHz and −93 dBm above; one S-unit is 6 dB. */
    fun s9(hz: Long) = if (hz >= 30_000_000L) -93f else -73f

    fun sUnits(dbm: Float, hz: Long): String {
        val s9 = s9(hz)
        if (dbm >= s9) return "S9+${(dbm - s9).roundToInt()}"
        return "S${min(9, max(0, (9 + (dbm - s9) / 6).roundToInt()))}"
    }

    /** 0..1 position on a bar spanning S0 (S9 − 54 dB) to S9 + 60. */
    fun meterFrac(dbm: Float, hz: Long): Float = ((dbm - (s9(hz) - 54)) / 114f).coerceIn(0f, 1f)

    /** The line under the S-meter: squelch and tones for NFM, the AGC's gain for everything else. */
    fun statusLine(m: HamDemod.Meter, s: State): String {
        val parts = mutableListOf<String>()
        if (s.mode == Mode.NFM) {
            parts += if (m.open) "OPEN" else "SQL"
            if (m.tone > 0) parts += "CTCSS %.1f".format(m.tone)
            if (m.dcs != 0) parts += "DCS %03d%s".format(m.dcs, if (m.dcsInverted) "I" else "")
            if (m.tone == 0.0 && m.dcs == 0 && m.open) parts += "no tone"
        } else {
            parts += if (s.agc == AgcMode.OFF) "AGC off"
                     else "AGC ${if (m.agcGain >= 1000) "60" else (20 * log10(max(1f, m.agcGain))).roundToInt().toString()} dB"
        }
        return parts.joinToString(" · ")
    }
}
