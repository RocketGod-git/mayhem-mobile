package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.r433.devices.resetBluelineId
import com.rocketgod.mayhem.core.r433.devices.resetSparsnasSensorId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/** What we remember about one device we have heard. */
data class HeardDevice(
    val key: String, val model: String, val num: Int, val what: String, val count: Int,
    val firstSeen: Long, val lastSeen: Long, val data: R433Data, val fsk: Boolean,
)

/** The once-a-second line: how the receiver is doing, not what it heard. */
data class R433Report(
    val bursts: Int = 0, val ook: Int = 0, val fsk: Int = 0, val decoded: Int = 0, val badChecksum: Int = 0,
    val near: Map<String, Int> = emptyMap(), val devices: Int = 0, val protocols: Int = 0, val noise: Int = 0,
    val trigger: Int = 0, val span: Int = 0,
)

/** One line about a protocol, for the list of everything the receiver can recognise. */
data class R433Protocol(val num: Int, val name: String, val what: String, val coding: String, val bands: List<Double>, val doubtful: Boolean)

private val CODING = mapOf(3 to "Manchester", 4 to "level per bit", 5 to "pulse position", 6 to "pulse width", 8 to "level per bit, raw",
    9 to "differential Manchester", 10 to "pulse width, Oregon v1", 11 to "level per bit, clocked", 12 to "NRZ-S", 13 to "return to zero, inverted",
    16 to "frequency shift, level per bit", 17 to "frequency shift, pulse width", 18 to "frequency shift, Manchester")

fun protocolList(): List<R433Protocol> = R433Registry.all.map { d ->
    R433Protocol(d.num, d.name, d.what ?: "", CODING[d.modulation] ?: d.modulation.toString(), d.bands.map { it / 1e6 }, d.disabled)
}.sortedBy { it.num }

private fun keyOf(model: String, d: R433Data): String =
    listOf(model, d["id"]?.let { fmtValue(it) } ?: "", d["channel"]?.let { fmtValue(it) } ?: "", d["subtype"]?.let { fmtValue(it) } ?: "")
        .filter { it.isNotEmpty() }.joinToString("/")

/** A reading's value the way the web app prints it: whole numbers without a decimal point. */
fun fmtValue(v: Any?): String = when (v) {
    null -> ""
    is Double -> if (v.isFinite() && v == Math.rint(v) && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
    is Float -> fmtValue(v.toDouble())
    is IntArray -> v.joinToString(",")
    is List<*> -> v.joinToString(",") { fmtValue(it) }
    else -> v.toString()
}

/**
 * The Devices receiver: samples in, readings out. The whole sampled slice is watched at once — nothing is tuned to
 * a channel — and every burst is offered to every protocol. Twin of web/src/dsp/r433/processor.ts.
 */
class R433Processor : IqProcessor {
    private val baseband = Baseband()
    private var detect = PulseDetect(2_000_000.0)
    @Volatile private var radio = R433()
    private var rate = 0
    private var lastStats = 0L
    /** How wide a slice to listen across: narrower hears weaker devices, wider finds ones off the dial. */
    @Volatile private var wantSpan = 250_000
    @Volatile private var pendingReset = false
    private val lastPayload = HashMap<String, Pair<String, Long>>()
    private val unknownSeen = HashMap<String, Long>()
    private val heard = LinkedHashMap<String, HeardDevice>()
    private val _devices = MutableStateFlow<List<HeardDevice>>(emptyList())
    val devices: StateFlow<List<HeardDevice>> = _devices.asStateFlow()
    private val _report = MutableStateFlow(R433Report())
    val report: StateFlow<R433Report> = _report.asStateFlow()

    // Decoding runs beside the DSP thread; if it ever falls behind, bursts are dropped rather than queued forever.
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(16), { r -> Thread(r, "r433").apply { isDaemon = true } }, ThreadPoolExecutor.DiscardOldestPolicy())

    override fun reset(rate: Int) {
        this.rate = rate
        baseband.reset()
        var decim = 1
        while (rate / (decim * 2) >= wantSpan) decim *= 2
        baseband.decim = decim
        detect = PulseDetect((rate.toDouble() / decim).roundToInt().toDouble())
        lastStats = 0
    }

    fun setSpan(hz: Int) { wantSpan = hz; pendingReset = true }
    fun span(): Int = if (rate != 0) (rate.toDouble() / (if (baseband.decim == 0) 1 else baseband.decim)).roundToInt() else 0

    fun clear() { worker.execute { resetBluelineId(); resetSparsnasSensorId(); heard.clear(); lastPayload.clear(); unknownSeen.clear(); _devices.value = emptyList() } }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate || pendingReset) { pendingReset = false; reset(rate) }
        val n = baseband.process(iq, len)
        detect.process(baseband.env, baseband.fm, n) { fsk, pulses ->
            val copy = PulseData(pulses.numPulses + 1, pulses.sampleRate, pulses.fsk)
            System.arraycopy(pulses.pulse, 0, copy.pulse, 0, pulses.numPulses + 1)
            System.arraycopy(pulses.gap, 0, copy.gap, 0, pulses.numPulses + 1)
            copy.numPulses = pulses.numPulses
            worker.execute { handle(fsk, copy) }
        }
        val now = System.currentTimeMillis()
        if (now - lastStats >= 1000) {
            lastStats = now
            val (noise, trigger) = detect.levels()
            val s = radio.stats
            _report.value = R433Report(s.bursts, s.ook, s.fsk, s.decoded, s.badChecksum, HashMap(s.near), heard.size, radio.devices.size, noise, trigger, span())
        }
    }

    private fun handle(fsk: Boolean, pulses: PulseData) {
        val found = runCatching { radio.run(fsk, pulses) }.getOrElse { Diag.log("r433: ${it.message}"); emptyList() }
        // When a checksum-verified protocol has claimed this burst, drop the unverified (switched-off in rtl_433)
        // matches of the same burst rather than listing a phantom device next to the real one.
        val verified = found.any { !it.dev.disabled }
        for (r in found) { if (verified && r.dev.disabled) continue; report(r.dev, r.data, fsk) }
        if (found.isEmpty()) reportUnknown(pulses)
    }

    /** Unidentified bursts stay out of the list (mostly fragments and interference) and go to the log, once a second per shape. */
    private fun reportUnknown(p: PulseData) {
        if (p.numPulses < 8) return
        val shape = describeBurst(p)
        val key = "? ${shape.key}"
        val now = System.currentTimeMillis()
        if (now - (unknownSeen[key] ?: 0L) < 1000) return
        unknownSeen[key] = now
        Diag.log("r433 unidentified · ${if (shape.fsk) "FSK" else "OOK"} · ${shapeSummary(shape)} · ${shape.coding.ifEmpty { "coding unsettled" }}")
    }

    private fun report(dev: RDevice, d: R433Data, fsk: Boolean) {
        val model = d["model"]?.toString() ?: dev.name
        val key = keyOf(model, d)
        val now = System.currentTimeMillis()
        // a burst holds several repeats of one message and each can decode: report it once
        val sig = d.entries.joinToString("|") { "${it.key}=${fmtValue(it.value)}" }
        val last = lastPayload[key]
        if (last != null && last.first == sig && now - last.second < 1000) return
        lastPayload[key] = sig to now
        if (dev.disabled) { Diag.log("r433 unverified $model (protocol ${dev.num})"); return }
        val prev = heard[key]
        heard[key] = HeardDevice(key, model, dev.num, dev.what ?: dev.name, (prev?.count ?: 0) + 1, prev?.firstSeen ?: now, now, d, fsk)
        _devices.value = heard.values.sortedByDescending { it.lastSeen }
    }

    /** Narrow the protocols in use; null or empty means everything registered. */
    fun setProtocols(nums: Set<Int>?) {
        radio = R433(if (nums.isNullOrEmpty()) null else R433Registry.all.filter { it.num in nums })
    }
}
