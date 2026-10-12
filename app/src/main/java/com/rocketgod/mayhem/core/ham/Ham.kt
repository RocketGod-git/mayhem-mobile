package com.rocketgod.mayhem.core.ham

import com.rocketgod.mayhem.core.SdrEngine
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
 */
object Ham {
    const val GUARD = 120_000L
    const val LO_OFFSET = 250_000L
    private val rate get() = SdrEngine.IQ_RATE

    val demod = HamDemod()

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

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** Filter choices per mode, labelled as a radio would label them. */
    val WIDTHS: Map<Mode, List<Pair<String, Double>>> = mapOf(
        Mode.USB to listOf("1.8k" to 1800.0, "2.4k" to 2400.0, "2.7k" to 2700.0, "3.0k" to 3000.0, "3.5k" to 3500.0),
        Mode.LSB to listOf("1.8k" to 1800.0, "2.4k" to 2400.0, "2.7k" to 2700.0, "3.0k" to 3000.0, "3.5k" to 3500.0),
        Mode.CW to listOf("100" to 100.0, "250" to 250.0, "500" to 500.0, "1k" to 1000.0),
        Mode.AM to listOf("4k" to 4000.0, "6k" to 6000.0, "8k" to 8000.0, "10k" to 10000.0),
        Mode.NFM to listOf("8k" to 8000.0, "12.5k" to 12500.0, "16k" to 16000.0, "25k" to 25000.0),
        Mode.WFM to listOf("200k" to 200_000.0),   // broadcast FM is one width; hi is half of it
    )

    /** Hands the radio to the HAM receiver. The built-in demodulator is switched off: [demod] owns the audio. */
    fun open() {
        val s = _state.value
        SdrEngine.configure(SdrEngine.Mode.NONE, s.lo, rate, 32, 40, false, demod)
        push()
    }

    fun tune(hzIn: Long) {
        val hz = hzIn.coerceIn(1_000_000L, 6_000_000_000L)
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

    fun setShift(hz: Double) = update { it.copy(shift = hz) }
    fun setPitch(hz: Double) = update { it.copy(pitch = hz) }
    fun setAgc(a: AgcMode) = update { it.copy(agc = a) }
    fun toggleNr() = update { it.copy(nr = !it.nr) }
    fun toggleAnf() = update { it.copy(anf = !it.anf) }
    fun setSquelch(db: Int) = update { it.copy(squelch = db) }
    fun setVolume(v: Float) = update { it.copy(volume = v) }

    /** Jump to a band's calling frequency in the mode it expects. */
    fun pickBand(b: Band) {
        update { it.copy(rev = false) }
        if (b.mode != _state.value.mode) setMode(b.mode)
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
