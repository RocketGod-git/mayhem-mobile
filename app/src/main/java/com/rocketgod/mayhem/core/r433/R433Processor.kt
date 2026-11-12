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

/** One time a device was heard: when, what it said, and where. */
data class HeardReading(val at: Long, val data: R433Data, val offsetHz: Int, val hz: Long)

/** What we remember about one device we have heard. */
data class HeardDevice(
    val key: String, val model: String, val num: Int, val what: String, val count: Int,
    val firstSeen: Long, val lastSeen: Long, val data: R433Data, val fsk: Boolean,
    /** What kind of thing it is: "sensor" (rtl_433), "key" (a car key), "remote" (gate or garage) or "weather" (Mayhem's decoders). */
    val family: String = "sensor",
    /** Where it was heard, as an offset from the radio's center in hertz. */
    val offsetHz: Int = 0,
    /** Where it was heard, in hertz (the radio's center then, plus [offsetHz]). */
    val hz: Long = 0,
    /** Every time it was heard, oldest first, the newest 40. */
    val history: List<HeardReading> = emptyList(),
)

/** The once-a-second line: how the receiver is doing, not what it heard. */
data class R433Report(
    val bursts: Int = 0, val ook: Int = 0, val fsk: Int = 0, val decoded: Int = 0, val badChecksum: Int = 0,
    val near: Map<String, Int> = emptyMap(), val devices: Int = 0, val protocols: Int = 0, val noise: Int = 0,
    val trigger: Int = 0, val span: Int = 0,
    /** Bursts being followed right now, and how many have been since the start. */
    val channels: Int = 0, val followed: Int = 0,
)

/** One line about a protocol, for the list of everything the receiver can recognize. */
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
 * The Devices receiver: samples in, readings out. Every burst in the span is found and tuned to on its own
 * ([BurstChannels]); each channel is read by an rtl_433 pulse detector and by the car-key, remote and weather
 * decoders at once. Twin of web/src/dsp/r433/processor.ts.
 *
 * The channels, the pulse detectors and the key decoders run on the DSP thread; each rtl_433 burst is decoded on
 * the worker beside it, and so is every report, in the order the DSP thread sent them.
 */
class R433Processor : IqProcessor {
    /** One rtl_433 detector and one set of key decoders per channel slot, reused as bursts come and go. */
    private class Slot(val pd: PulseDetect) {
        lateinit var keys: KeyDecoders
        val pending = ArrayList<Pair<KeyReading, Double>>()
        /** Which channel this slot is following, so the worker can tell one burst's verdict from the next. */
        var gen = 0
    }
    private val channels: BurstChannels
    private val slots = ArrayList<Slot>()
    /** Which slot is being read right now. */
    private var curSlot = 0
    /** The offset of the channel being read right now, so a reading knows where it was heard. */
    private var curHz = 0.0
    private var gens = 0
    /** Milliseconds of radio time since the start, for telling a repeat from a new press. */
    private var airMs = 0.0
    @Volatile private var radio = R433()
    private var rate = 0
    private var lastStats = 0L
    /** The radio's center, so a reading can say which frequency it was heard on. */
    @Volatile var centerOf: () -> Long = { 0L }
    /** Called on the worker with every reading as it is reported, repeats of a device included (the tests listen here). */
    @Volatile var onReading: ((HeardDevice) -> Unit)? = null
    // worker side: the channels a checksum-verified sensor claimed
    private val verified = HashSet<Int>()
    private val lastPayload = HashMap<String, Pair<String, Double>>()
    /** Weak-check presses heard once, waiting for a second hearing. */
    private val unconfirmed = HashMap<String, Pair<String, Double>>()
    /** Key, remote and weather readings shown, for the decoded count beside rtl_433's. */
    @Volatile private var keysDecoded = 0
    private val unknownSeen = HashMap<String, Long>()
    private val heard = LinkedHashMap<String, HeardDevice>()
    private val _devices = MutableStateFlow<List<HeardDevice>>(emptyList())
    val devices: StateFlow<List<HeardDevice>> = _devices.asStateFlow()
    private val _report = MutableStateFlow(R433Report())
    val report: StateFlow<R433Report> = _report.asStateFlow()

    // Decoding runs beside the DSP thread; if it ever falls behind, the oldest work is dropped rather than queued forever.
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(64), { r -> Thread(r, "r433").apply { isDaemon = true } }, ThreadPoolExecutor.DiscardOldestPolicy())

    /** A completed rtl_433 burst from the channel being read: copied (the buffer is reused) and decoded on the worker. */
    private val sink: BurstFn = { fsk, pulses ->
        val copy = PulseData(pulses.numPulses + 1, pulses.sampleRate, pulses.fsk)
        System.arraycopy(pulses.pulse, 0, copy.pulse, 0, pulses.numPulses + 1)
        System.arraycopy(pulses.gap, 0, copy.gap, 0, pulses.numPulses + 1)
        copy.numPulses = pulses.numPulses
        val gen = slots[curSlot].gen; val hz = curHz
        worker.execute { handle(fsk, copy, gen, hz) }
    }

    init {
        channels = BurstChannels({ ch, env, fm, n -> onChannel(ch, env, fm, n) }, { ch -> onChannelEnd(ch) })
        for (i in 0 until MAX_CHANNELS) {
            val slot = Slot(PulseDetect(250_000.0))
            slot.keys = KeyDecoders { r -> slot.pending.add(r to curHz) }
            slots.add(slot)
        }
    }

    override fun reset(rate: Int) {
        this.rate = rate
        channels.reset(rate)
        lastStats = 0
    }

    /** Every burst in the span is tuned to on its own, so the span watched is all of it. */
    fun span(): Int = rate

    fun clear() { worker.execute { resetBluelineId(); resetSparsnasSensorId(); heard.clear(); lastPayload.clear(); unconfirmed.clear(); unknownSeen.clear(); _devices.value = emptyList() } }

    /** Waits until the worker has decoded and reported everything sent to it so far (for the tests). */
    fun settle() { worker.submit {}.get() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        channels.process(iq, len)
        airMs += (len shr 1).toDouble() / rate * 1000
        val now = System.currentTimeMillis()
        if (now - lastStats >= 1000) {
            lastStats = now
            val (noise, trigger) = slots[0].pd.levels()
            val s = radio.stats
            _report.value = R433Report(s.bursts, s.ook, s.fsk, s.decoded + keysDecoded, s.badChecksum, HashMap(s.near), heard.size, radio.devices.size, noise, trigger, span(),
                channels.active(), channels.opened)
        }
    }

    private fun onChannel(ch: BurstChannel, env: ShortArray, fm: ShortArray, n: Int) {
        val s = slots[ch.slot]
        if (ch.fresh) {
            s.pd.setSampleRate(ch.rate); s.pd.reset(); s.keys.slicer.reset(ch.rate); s.keys.slicer.flush(); s.keys.reset(); s.pending.clear()
            s.gen = ++gens
        }
        curHz = ch.hz; curSlot = ch.slot
        s.pd.process(env, fm, n, sink)
        s.keys.slicer.process(env, fm, n)
    }

    private fun onChannelEnd(ch: BurstChannel) {
        val s = slots[ch.slot]
        curHz = ch.hz; curSlot = ch.slot
        s.pd.flush(sink)
        s.keys.slicer.flush()
        // Keys and remotes carry little or no checksum, so a sensor's burst can read as one by chance. When a
        // checksum-verified sensor claimed this burst, what the key decoders made of it is noise.
        val keys = ArrayList(s.pending); s.pending.clear()
        val gen = s.gen; val air = airMs
        worker.execute {
            if (!verified.remove(gen)) for ((r, hz) in keys) reportKey(r, hz, air)
        }
    }

    private fun handle(fsk: Boolean, pulses: PulseData, gen: Int, hz: Double) {
        val found = runCatching { radio.run(fsk, pulses) }.getOrElse { Diag.log("r433: ${it.message}"); emptyList() }
        // When a checksum-verified protocol has claimed this burst, drop the unverified (switched-off in rtl_433)
        // matches of the same burst rather than listing a phantom device next to the real one.
        val ok = found.any { !it.dev.disabled }
        if (ok) verified.add(gen)
        for (r in found) { if (ok && r.dev.disabled) continue; report(r.dev, r.data, fsk, hz) }
        if (found.isEmpty()) reportUnknown(pulses)
    }

    /** Files a reading under its device, adds it to the device's history, and publishes the list. */
    private fun put(entry: HeardDevice, prev: HeardDevice?) {
        val hist = ArrayList<HeardReading>(prev?.history ?: emptyList())
        hist.add(HeardReading(entry.lastSeen, entry.data, entry.offsetHz, entry.hz))
        while (hist.size > 40) hist.removeAt(0)
        val e = entry.copy(history = hist)
        heard[e.key] = e
        _devices.value = heard.values.sortedByDescending { it.lastSeen }
        onReading?.invoke(e)
    }

    /** A car key, remote or weather sensor read by Mayhem's and ProtoPirate's decoders. */
    private fun reportKey(r: KeyReading, hz: Double, air: Double) {
        // A key with no serial of its own is known by the part of its frame that never changes, when the decoder
        // names one; and one press is known by its rolling code, which stays the same when a key repeats the press
        // on another of its channels (the channel byte changes the rest of the frame).
        fun field(n: String) = r.fields.firstOrNull { it.first == n }?.second ?: ""
        val id = r.id.ifEmpty { field("FIXED") }
        val press = field("HOP").ifEmpty { field("COUNTER") }.ifEmpty { r.raw }
        val key = "${r.family}/${r.model}/${id.ifEmpty { r.raw }}"
        val now = System.currentTimeMillis()
        // Decoders with little or no integrity check (Honda Static's reversed path never compares its checksum, and
        // fixed-code remotes have none) can read noise as a key. A real fob repeats every press several times, so
        // these are shown only once the same press has been heard twice within a second and a half.
        if (r.family == "remote" || r.model in WEAK_KEYS) {
            val seen = unconfirmed[key]
            if (seen == null || seen.first != press || air - seen.second > 1500) {
                unconfirmed[key] = press to air
                if (unconfirmed.size > 500) unconfirmed.clear()
                return
            }
        }
        // one press sends the same frame several times: within 1.2 s of radio time it is the same press
        val last = lastPayload[key]
        if (last != null && last.first == press && air - last.second < 1200) return
        lastPayload[key] = press to air
        keysDecoded++
        val data = R433Data()
        data["model"] = r.model
        if (id.isNotEmpty()) data["id"] = id
        for ((k, v) in r.fields) data[k.lowercase().replace(NON_WORD, "_")] = v
        data["code"] = r.raw; data["bits"] = r.bits
        val prev = heard[key]
        val off = hz.roundToInt()
        val what = when (r.family) { "key" -> "car key"; "remote" -> "gate or garage remote"; else -> "weather sensor" }
        put(HeardDevice(key, r.model, 0, what, (prev?.count ?: 0) + 1, prev?.firstSeen ?: now, now, data, false, r.family, off, centerOf() + off), prev)
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

    private fun report(dev: RDevice, d: R433Data, fsk: Boolean, hz: Double) {
        val model = d["model"]?.toString() ?: dev.name
        val key = keyOf(model, d)
        val now = System.currentTimeMillis()
        // a burst holds several repeats of one message and each can decode: report it once
        val sig = d.entries.joinToString("|") { "${it.key}=${fmtValue(it.value)}" }
        val last = lastPayload[key]
        if (last != null && last.first == sig && now - last.second < 1000) return
        lastPayload[key] = sig to now.toDouble()
        if (dev.disabled) { Diag.log("r433 unverified $model (protocol ${dev.num})"); return }
        val prev = heard[key]
        val off = hz.roundToInt()
        put(HeardDevice(key, model, dev.num, dev.what ?: dev.name, (prev?.count ?: 0) + 1, prev?.firstSeen ?: now, now, d, fsk, "sensor", off, centerOf() + off), prev)
    }

    /** Narrow the protocols in use; null or empty means everything registered. */
    fun setProtocols(nums: Set<Int>?) {
        radio = R433(if (nums.isNullOrEmpty()) null else R433Registry.all.filter { it.num in nums })
    }
}

private val NON_WORD = Regex("[^a-z0-9]+")

/** Car-key decoders whose frames carry too little checking to trust a single one. */
private val WEAK_KEYS = setOf("Honda Static")
