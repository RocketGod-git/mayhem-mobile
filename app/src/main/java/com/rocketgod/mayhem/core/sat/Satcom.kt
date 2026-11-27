package com.rocketgod.mayhem.core.sat

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs

/**
 * The Satcom app's processor: one L-band carrier, either the Inmarsat-C NCS (EGC broadcasts) or an Aero P-channel
 * (ACARS to aircraft), through the BPSK receiver into its decoder. A snapshot is published once a second and
 * whenever a message comes in; Aero's ACARS lines go to [log] and to [onAcars] (Flight Msgs).
 *
 * Twin of web/src/dsp/lband/satcom.ts.
 */
class SatcomProcessor(private val log: PacketLog) : IqProcessor {
    enum class Mode { EGC, AERO600, AERO1200 }

    data class Snap(val mode: Mode, val hz: Long, val carrierHz: Double, val lock: Double, val lineDb: Double,
                    val egc: Stdc.Stats, val aero: Aero.Stats?, val messages: List<Stdc.EgcMessage>)

    @Volatile var centerOf: () -> Long = { 0L }
    @Volatile var channelOf: () -> Long = { 0L }
    @Volatile var onNote: ((String) -> Unit)? = null
    /** Each Aero ACARS line, for Flight Msgs. */
    @Volatile var onAcars: ((String) -> Unit)? = null
    private val _snap = MutableStateFlow<Snap?>(null)
    val snap: StateFlow<Snap?> = _snap.asStateFlow()

    private val stdc = Stdc.Decoder()
    @Volatile private var aero: Aero.Decoder? = null
    @Volatile private var psk = PskReceiver(Stdc.SYMBOL_RATE) { stdc.push(it) }
    @Volatile var mode = Mode.EGC; private set
    private var lastSnap = 0L; @Volatile private var dirty = false; private var wasLocked = false

    init {
        stdc.onMessage = { m -> dirty = true; if (m.parts == 1) onNote?.invoke("EGC: ${m.priorityName} · ${m.serviceName}${if (m.area.isNotEmpty()) " · ${m.area}" else ""}") }
    }

    fun setMode(m: Mode) {
        if (m == mode) return
        mode = m
        if (m == Mode.EGC) { aero = null; psk = PskReceiver(Stdc.SYMBOL_RATE) { stdc.push(it) } }
        else {
            val a = Aero.Decoder(if (m == Mode.AERO600) 600 else 1200)
            a.onAcars = { line, aes -> log.add(line); onAcars?.invoke(line); onNote?.invoke("Aero: ACARS to AES ${Aero.aesHex(aes)}"); dirty = true }
            aero = a
            psk = PskReceiver(a.rate) { a.push(it) }
        }
        stdc.reset()
        _snap.value = null
    }

    fun clear() { stdc.clear(); log.clear(); dirty = true }
    override fun reset(rate: Int) { psk.reset(); stdc.reset(); aero?.reset() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val ch = channelOf(); val center = centerOf()
        aero?.hz = ch
        val p = psk
        p.onIq(iq, len, rate, ch - center)
        val locked = p.lock > 0.5
        if (locked != wasLocked) {
            wasLocked = locked
            onNote?.invoke(if (locked) "Satcom: locked to the carrier ${fmtHz(p.carrierHz)} from ${"%.3f".format(ch / 1e6)} MHz" else "Satcom: carrier lost")
        }
        val now = System.currentTimeMillis()
        if (dirty || now - lastSnap > 1000) { dirty = false; lastSnap = now; _snap.value = snapNow(ch) }
    }

    fun snapNow(ch: Long = channelOf()): Snap {
        val p = psk
        return Snap(mode, ch, p.carrierHz, p.lock, p.lineDb, stdc.stats, aero?.stats, stdc.messages())
    }

    private fun fmtHz(hz: Double) = if (hz.isNaN()) "" else "${if (hz >= 0) "+" else "−"}${"%.2f".format(abs(hz / 1000))} kHz"
}
