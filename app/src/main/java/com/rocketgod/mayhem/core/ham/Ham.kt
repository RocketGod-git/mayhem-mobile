package com.rocketgod.mayhem.core.ham

import android.content.Context
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Bookmark
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Mic
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Signal
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.HamDemod.AgcMode
import com.rocketgod.mayhem.core.ham.HamDemod.Mode
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

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
    /** The spans HAM zooms out through: multiples of 1.92 Msps keep the 48 k audio chain exact. Phones stop at 3.84. */
    private val RATES = intArrayOf(1_920_000, 3_840_000, 7_680_000, 15_360_000, 19_200_000)
    private const val MON_WIDE = 3_840_000
    private var rateIdx = 0
    private val rate get() = RATES[rateIdx]
    /** The screen has room for the wide spans and the wide monitor (and its four voices); set by the HAM screens. */
    @Volatile var wideScreen = false
        set(v) { if (v == field) return; field = v; if (monitoring) monitorSend() }

    /** Which app is driving the receiver: HAM itself, or Satellites (which never uses the band monitor). */
    enum class Host { HAM, SAT }
    @Volatile var host = Host.HAM; private set

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
        /** Watch 3.84 MHz instead of 1.92 (wide screens only). */
        val wide: Boolean = false,
        /** Activity log: "hh:mm:ss  145.2300 MHz", newest first. */
        val log: List<String> = emptyList(),
    )

    data class Ptt(val on: Boolean = false, val dev: Int = 2500, val tone: Double = 0.0)

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

    /**
     * Opening the HAM app. HAM keeps its own last frequency, except arriving from the launcher, where a tap is an
     * explicit "go here": then it starts on the shared dial, provided the user has ever set one. Coming from Audio
     * it must not be dropped onto a broadcast station.
     */
    fun open() {
        if (Apps.cameFrom == null && SdrEngine.dialSaved)
            _state.value = _state.value.copy(channel = SdrEngine.radioFreqHz.coerceIn(1_000_000L, 6_000_000_000L), rev = false)
        start()
    }

    init { Bookmarks.hamRecall = { recall(it) } }

    /** HAM's part of a favourite: its own receiver, saved beside the gains the favourite already holds. */
    fun favourite(): JSONObject {
        val s = _state.value
        return JSONObject().put("mode", s.mode.name).put("lo", s.pbLo).put("hi", s.pbHi).put("squelch", s.squelch)
            .put("agc", s.agc.name).put("nr", s.nr).put("anf", s.anf).put("digi", HamDigital.settings.value.mode.name)
    }

    private fun recall(b: Bookmark) {
        val h = b.ham ?: return
        runCatching { Mode.valueOf(h.getString("mode")) }.getOrNull()?.let { if (it != _state.value.mode) setMode(it) }
        update { s ->
            s.copy(pbLo = h.optDouble("lo", s.pbLo), pbHi = h.optDouble("hi", s.pbHi), shift = 0.0, squelch = h.optInt("squelch", s.squelch),
                agc = runCatching { AgcMode.valueOf(h.getString("agc")) }.getOrDefault(s.agc), nr = h.optBoolean("nr", s.nr), anf = h.optBoolean("anf", s.anf))
        }
        runCatching { HamDigital.Mode.valueOf(h.getString("digi")) }.getOrNull()?.let { d -> HamDigital.update { it.copy(mode = d) } }
        tune(b.hz)
    }

    /** Hands the radio to the HAM receiver (or the band monitor). The built-in demodulator is off: we own the audio. */
    private fun start() {
        host = Host.HAM
        stopPtt()
        if (_tab.value == Tab.MONITOR) { openMonitor(); return }
        val d = HamDigital.settings.value.mode
        if (_tab.value == Tab.DIGI && d == HamDigital.Mode.FT8 && _state.value.mode != Mode.USB) setMode(Mode.USB)
        if (_tab.value == Tab.DIGI && (d == HamDigital.Mode.DMR || d == HamDigital.Mode.P25) && _state.value.mode != Mode.NFM) setMode(Mode.NFM)
        openReceiver()
    }

    /** The channel receiver on the LO placed for the current channel. */
    private fun openReceiver() {
        val s = _state.value.copy(lo = _state.value.channel + LO_OFFSET)
        _state.value = s
        SdrEngine.configure(SdrEngine.Mode.NONE, s.lo, rate, 32, 40, false, demod)
        push()
    }

    /** The Satellites app takes the receiver, tuned to [channel]. */
    fun openSat(channel: Long) {
        host = Host.SAT
        stopPtt()
        _state.value = _state.value.copy(channel = channel, rev = false)
        openReceiver()
    }

    /** True while the band monitor, not the channel receiver, has the radio. */
    val monitoring: Boolean get() = host == Host.HAM && _tab.value == Tab.MONITOR

    fun setTab(t: Tab) {
        if (t == _tab.value) return
        val wasMon = _tab.value == Tab.MONITOR
        _tab.value = t
        if (t == Tab.MONITOR || wasMon) start() else stopPtt()
    }

    /** The span on air: a rung of [RATES], or the monitor's. */
    private fun span() = SdrEngine.rateHz.value

    fun tune(hzIn: Long) {
        val hz = hzIn.coerceIn(1_000_000L, 6_000_000_000L)
        if (monitoring) {
            _state.value = _state.value.copy(channel = hz)
            // inside the monitored span: lock that channel; outside it: move the whole monitor there
            if (abs(hz - monCentre) > span() / 2 - GUARD) { openMonitor(); return }
            val r = monitor.report.value
            if (r.count > 0) {
                val k = ((hz - r.first).toDouble() / r.spacing).roundToInt()
                if (k in 0 until r.count) { _mon.value = _mon.value.copy(lock = k, listen = BandMonitor.Listen.LOCK); monitorSend() }
            }
            return
        }
        var s = _state.value.copy(channel = hz)
        val off = hz - s.lo
        if (abs(off) > span() / 2 - GUARD || abs(off) < 15_000) {
            s = s.copy(lo = hz + LO_OFFSET)
            SdrEngine.tune(s.lo)
        }
        _state.value = s
        if (host == Host.HAM) SdrEngine.setDial(hz, dialMode(s.mode))
        push()
    }

    /** The receiver mode the other apps would hear this HAM mode in. */
    private fun dialMode(m: Mode): SdrEngine.Mode = when (m) {
        Mode.USB, Mode.CW -> SdrEngine.Mode.USB
        Mode.LSB -> SdrEngine.Mode.LSB
        Mode.AM -> SdrEngine.Mode.AM
        Mode.NFM -> SdrEngine.Mode.NFM
        Mode.WFM -> SdrEngine.Mode.WFM
    }

    fun nudge(delta: Long) = tune(_state.value.channel + delta)

    /** The channel raster under the dial: the band plan's step, else 500 Hz on HF and 12.5 kHz above. */
    fun raster(): Long = bandOf(_state.value.channel)?.step ?: if (_state.value.channel < 30_000_000) 500L else 12_500L

    /** Tuning steps for the current band: ±step and ±10×step. */
    fun steps(): LongArray {
        val st = raster()
        return longArrayOf(-st * 10, -st, st, st * 10)
    }

    /**
     * Slide the span: the LO moves to [centreHz] in whole raster steps while the channel keeps its frequency (it goes
     * quiet while outside the span). The monitor instead re-plants its whole channel set on the new centre.
     */
    fun slide(centreHz: Long) {
        val c = centreHz.coerceIn(1_000_000L, 6_000_000_000L); val st = raster()
        if (monitoring) {
            val d = Math.round((c - monCentre).toDouble() / st) * st
            if (d != 0L) monitorMove(monCentre + d)
            return
        }
        val s = _state.value
        val d = Math.round((c - s.lo).toDouble() / st) * st
        if (d == 0L) return
        _state.value = s.copy(lo = s.lo + d)
        SdrEngine.tuneLo(s.lo + d)
        push()
    }

    /** ⌖: the LO back to its place beside the channel; the monitor back over the band. */
    fun recentre() {
        if (monitoring) { openMonitor(); return }
        val s = _state.value; val lo = s.channel + LO_OFFSET
        if (lo == s.lo) return
        _state.value = s.copy(lo = lo)
        SdrEngine.tuneLo(lo)
        push()
    }

    /**
     * Zoom past 1×: −1 widens the span a rung of [RATES], +1 narrows it; false when there is no rung that way on this
     * radio and screen. The monitor has two spans, 1.92 and (on a wide screen) 3.84 MHz.
     */
    fun spanStep(dir: Int): Boolean {
        if (monitoring) {
            val wide = dir < 0
            if (!wideScreen || _mon.value.wide == wide || (wide && !Radio.canSample(Radio.limits, MON_WIDE))) return false
            monitorWide(wide)
            return true
        }
        val top = (0..(if (wideScreen) RATES.lastIndex else 1)).lastOrNull { Radio.canSample(Radio.limits, RATES[it]) } ?: 0
        val i = (rateIdx - dir).coerceIn(0, top)
        if (i == rateIdx) return false
        rateIdx = i
        SdrEngine.setRate(rate)
        // narrowed past the channel: put the LO back beside it
        val s = _state.value
        if (abs(s.channel - s.lo) > rate / 2 - GUARD) { _state.value = s.copy(lo = s.channel + LO_OFFSET); SdrEngine.tuneLo(s.channel + LO_OFFSET) }
        push()
        return true
    }

    /**
     * A tapped signal: open the filter to just cover it, and switch mode only when the shape is clear. A wide hump goes
     * to NFM, a confident label picks its mode, a doubtful one leaves the mode alone (but an AM filter on a doubtful
     * 5+ kHz hump is not it, so that goes to NFM).
     */
    fun fitSignal(sig: Signal) {
        val bw = sig.bw6 * 1.15                                           // −6 dB width plus a little shoulder
        val wide = sig.cls == "WFM" || sig.cls == "WIDE" || sig.bw6 > 60_000 || (sig.hz > 87_500_000 && sig.hz < 108_000_000)
        val ssb = sig.cls == "USB" || sig.cls == "LSB" || sig.cls == "SSB"
        val cur = _state.value.mode
        val want = when {
            wide -> Mode.NFM
            sig.conf >= 0.6 -> when {
                sig.cls == "CW" -> Mode.CW
                sig.cls == "AM" -> Mode.AM
                ssb -> if (sig.cls == "LSB" || (sig.cls == "SSB" && sig.hz < 10_000_000)) Mode.LSB else Mode.USB
                else -> Mode.NFM
            }
            cur == Mode.AM && sig.bw6 > 4500 -> Mode.NFM
            else -> cur
        }
        if (want != cur) setMode(want)
        setWidth(when (want) {
            Mode.CW -> if (bw < 180) 100.0 else if (bw < 400) 250.0 else if (bw < 800) 500.0 else 1000.0
            Mode.USB, Mode.LSB -> ((bw / 100).roundToInt() * 100.0).coerceIn(1800.0, 3500.0)
            Mode.AM -> (ceil(bw / 1000) * 1000).coerceIn(4000.0, 10_000.0)
            else -> if (bw <= 8500) 8000.0 else if (bw <= 13_000) 12_500.0 else if (bw <= 17_000) 16_000.0 else if (bw <= 26_000) 25_000.0 else min(48_000.0, ceil(bw / 1000) * 1000)
        })
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
    /** A filter edge dragged on the waterfall: the pass band as it now stands, Hz from the carrier. */
    fun setPassband(lo: Double, hi: Double) = update { it.copy(pbLo = lo, pbHi = hi, shift = 0.0) }

    fun setShift(hz: Double) = update { it.copy(shift = hz) }
    fun setPitch(hz: Double) { update { it.copy(pitch = hz) }; HamDigital.pitchChanged(hz) }
    fun setAgc(a: AgcMode) = update { it.copy(agc = a) }
    fun toggleNr() = update { it.copy(nr = !it.nr) }
    fun toggleAnf() = update { it.copy(anf = !it.anf) }
    fun setSquelch(db: Int) = update { it.copy(squelch = db) }
    fun setVolume(v: Float) { update { it.copy(volume = v) }; if (monitoring) monitorSend() }

    /** Jump to a band's calling frequency in the mode it expects. */
    fun pickBand(b: Band) {
        update { it.copy(rev = false) }
        if (b.mode != _state.value.mode) setMode(b.mode)
        if (monitoring) {
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
        val r = if (_mon.value.wide && wideScreen && Radio.canSample(Radio.limits, MON_WIDE)) MON_WIDE else RATES[0]
        val centre = at ?: if (band != null && band.hi - band.lo <= r) (band.lo + band.hi) / 2 else s.channel + 10_000
        monCentre = centre
        SdrEngine.configure(SdrEngine.Mode.NONE, centre, r, 32, 40, false, monitor)
        monitorSend()
    }

    /** Slide the monitored span (it re-plants the whole channel set). */
    fun monitorMove(centre: Long) { if (monitoring) openMonitor(centre) }
    fun monitorCentre(): Long = monCentre

    private fun monitorSend() {
        val s = _state.value; val m = _mon.value; val band = bandOf(s.channel)
        monitor.set(BandMonitor.Params(m.spacing, band?.lo ?: (s.channel / 1_000_000 * 1_000_000), m.threshold, m.listen, m.lock, if (wideScreen) 4 else 2, s.volume, monCentre))
    }

    fun monitorListen(l: BandMonitor.Listen) { _mon.value = _mon.value.copy(listen = l, lock = if (l == BandMonitor.Listen.LOCK) _mon.value.lock else -1); monitorSend() }
    fun monitorSpacing(hz: Int) { _mon.value = _mon.value.copy(spacing = hz, lock = -1); monitorSend() }
    fun monitorThreshold(db: Int) { _mon.value = _mon.value.copy(threshold = db); monitorSend() }
    fun monitorWide(on: Boolean) { _mon.value = _mon.value.copy(wide = on); if (monitoring) openMonitor() }

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
