package com.rocketgod.mayhem.core.analyzer

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.r433.Devices
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import java.util.concurrent.Executors

/** A captured burst as the screen keeps it: the capture's burst, where it was, and how it read with nothing set. */
class AnBurst(
    val b: Burst,
    /** The radio's center when it was heard (or the file's), Hz; 0 when a file did not say. */
    val center: Long,
    val auto: Analysis,
    /** The longest frame's bits, for the card and for comparing. */
    val best: String,
)

/**
 * The Analyzer app: one capture on the radio, the bursts it kept (newest last, at most [MAX_KEPT]), imports, and
 * the status line. Twin of the web app's AnalyzerUi state (web/src/analyzer-ui.ts).
 */
object Analyzer {
    /** Bursts kept: the oldest go first. */
    const val MAX_KEPT = 200
    /** The same band list as Devices: the Analyzer listens where the keys, remotes and sensors are. */
    val BANDS = Devices.BANDS

    private val _bursts = MutableStateFlow<List<AnBurst>>(emptyList())
    /** Every burst kept, oldest first. */
    val bursts: StateFlow<List<AnBurst>> = _bursts.asStateFlow()
    private val _stats = MutableStateFlow<AnalyzerStats?>(null)
    val stats: StateFlow<AnalyzerStats?> = _stats.asStateFlow()
    private val _capturing = MutableStateFlow(true)
    /** On: new bursts are kept. Off: the list is frozen, the front end keeps running. */
    val capturing: StateFlow<Boolean> = _capturing.asStateFlow()
    private val _note = MutableStateFlow("")
    /** The last import's outcome, for the status line. */
    val note: StateFlow<String> = _note.asStateFlow()

    /** Reading a burst and imports run here, off the DSP thread, one at a time and in order. */
    private val work = Executors.newSingleThreadExecutor { r -> Thread(r, "analyzer").apply { isDaemon = true } }

    val proc = AnalyzerProcessor({ b -> val c = SdrEngine.freqHz.value; work.execute { add(b, c) } }, { _stats.value = it })

    /** Always open on 433.92 at 2 Msps with the Devices gains: that band carries most of what there is to read. */
    fun open() {
        proc.capture.paused = !_capturing.value
        SdrEngine.configure(SdrEngine.Mode.NONE, BANDS[0].second, SdrEngine.IQ_RATE, 32, 40, true, proc)
    }

    fun pickFreq(hz: Long) = SdrEngine.tune(hz)

    fun setCapturing(on: Boolean) { _capturing.value = on; proc.capture.paused = !on }

    fun clear() { work.execute { _bursts.value = emptyList() } }

    /** Read a burst with nothing set and keep it. */
    private fun add(b: Burst, center: Long) {
        val auto = analyze(b.env, b.fm, b.n, b.rate)
        val best = auto.frames.fold("") { a, f -> if (f.bits.length > a.length) f.bits else a }
        val next = ArrayList(_bursts.value)
        next.add(AnBurst(b, center, auto, best))
        while (next.size > MAX_KEPT) next.removeAt(0)
        _bursts.value = next
    }

    /** Add bursts the tests or a preview made, without a radio. */
    fun addForPreview(b: Burst, center: Long) = add(b, center)

    /**
     * A file opened in the Analyzer: a recording (.cu8 .u8 .iq unsigned, .cs8 signed; the rate from its name, else
     * 2 Msps) or a Flipper .sub RAW file, turned back into samples. Every burst in it comes back as if heard off the air.
     */
    fun import(name: String, bytes: ByteArray) {
        _note.value = "READING $name…"
        work.execute {
            val center = freqFromName(name) ?: 0L
            val got = ArrayList<Burst>()
            var count = 0; var note = ""
            runCatching {
                if (name.endsWith(".sub", ignoreCase = true)) {
                    val sub = parseSub(String(bytes, Charsets.UTF_8))
                    if (sub == null) note = "not a RAW .sub file (a decoded .sub holds a key, not pulses)"
                    else count = captureFile(synthesize(sub.pulses, sub.fsk), 1_000_000, name) { got.add(it) }
                } else {
                    val rate = rateFromName(name) ?: 2_000_000.0
                    count = captureFile(fromIqFile(bytes, name), rate.toInt(), name) { got.add(it) }
                    note = if (rate % 1e6 != 0.0) String.format(Locale.US, "%.3f Msps", rate / 1e6) else String.format(Locale.US, "%.0f Msps", rate / 1e6)
                }
            }.onFailure { note = "could not read it: ${it.message}" }
            // a .sub says its own frequency
            val subHz = if (name.endsWith(".sub", ignoreCase = true)) parseSub(String(bytes, Charsets.UTF_8))?.freqHz?.toLong() else null
            for (b in got) add(b, if (center != 0L) center else subHz ?: 0L)
            val line = "$count burst${if (count == 1) "" else "s"} in $name${if (note.isNotEmpty()) " ($note)" else ""}"
            Diag.log("Analyzer: $line")
            _note.value = "${count} BURST${if (count == 1) "" else "S"} IN $name"
        }
    }

    // ---- export ---------------------------------------------------------------------------------------------------

    /** The burst's absolute frequency, or its offset alone when the center is not known. */
    fun freqOf(a: AnBurst): Double = a.center + a.b.hz

    fun nameFor(a: AnBurst, ext: String) = exportName(freqOf(a), a.b.rate, a.b.id, ext)

    fun cu8(a: AnBurst): ByteArray = toCu8(a.b.iq)
    fun cs8(a: AnBurst): ByteArray = toCs8(a.b.iq)
    /** A Flipper .sub of the burst as read now, at its absolute frequency (433.92 MHz when that is not known). */
    fun sub(a: AnBurst, r: Analysis): ByteArray =
        toSub(pulsesUs(r, a.b.rate), if (a.center != 0L) freqOf(a) else 433_920_000.0, r.mod == Mod.FSK, r.shiftHz).toByteArray(Charsets.UTF_8)
}
