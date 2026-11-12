package com.rocketgod.mayhem.core.analyzer

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.r433.Devices
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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

/** What the person has said about a burst: a name, a star, a note. */
data class BurstMeta(val name: String = "", val star: Boolean = false, val note: String = "")

/**
 * The Analyzer app: one capture on the radio, the bursts it kept (newest last, at most [MAX_KEPT]), what the person
 * named, starred, noted and set by hand on each, the saved protocols, the capture filter, imports and the status
 * line. All of it but the status survives a restart (the app's files dir, `analyzer/`). Twin of the web app's
 * AnalyzerUi state (web/src/analyzer-ui.ts).
 */
object Analyzer {
    /** Bursts kept: the oldest go first (starred ones last). */
    const val MAX_KEPT = 200
    /** The same band list as Devices: the Analyzer listens where the keys, remotes and sensors are. */
    val BANDS = Devices.BANDS
    /** A second CLEAR this soon after the first clears the starred bursts too. */
    private const val CLEAR_AGAIN_MS = 3000L

    private val _bursts = MutableStateFlow<List<AnBurst>>(emptyList())
    /** Every burst kept, oldest first. */
    val bursts: StateFlow<List<AnBurst>> = _bursts.asStateFlow()
    private val _meta = MutableStateFlow<Map<Int, BurstMeta>>(emptyMap())
    val meta: StateFlow<Map<Int, BurstMeta>> = _meta.asStateFlow()
    private val _over = MutableStateFlow<Map<Int, Overrides>>(emptyMap())
    /** The hand settings of each burst, by id (no selection in them: that is the screen's). */
    val over: StateFlow<Map<Int, Overrides>> = _over.asStateFlow()
    private val _protocols = MutableStateFlow<List<Protocol>>(emptyList())
    val protocols: StateFlow<List<Protocol>> = _protocols.asStateFlow()
    private val _filter = MutableStateFlow(DEFAULT_FILTER)
    val filter: StateFlow<CaptureFilter> = _filter.asStateFlow()
    private val _filtered = MutableStateFlow(0)
    /** Bursts the filter dropped since the app started. */
    val filtered: StateFlow<Int> = _filtered.asStateFlow()
    private val _stats = MutableStateFlow<AnalyzerStats?>(null)
    val stats: StateFlow<AnalyzerStats?> = _stats.asStateFlow()
    private val _capturing = MutableStateFlow(true)
    /** On: new bursts are kept. Off: the list is frozen, the front end keeps running. */
    val capturing: StateFlow<Boolean> = _capturing.asStateFlow()
    private val _note = MutableStateFlow("")
    /** The last import's outcome, for the status line. */
    val note: StateFlow<String> = _note.asStateFlow()

    /** Reading a burst, imports and the files run here, off the DSP thread, one at a time and in order. */
    private val work = Executors.newSingleThreadExecutor { r -> Thread(r, "analyzer").apply { isDaemon = true } }

    val proc = AnalyzerProcessor({ b -> val c = SdrEngine.freqHz.value; work.execute { arrive(b, c) } }, { _stats.value = it })

    /** Always open on 433.92 at 2 Msps with the Devices gains: that band carries most of what there is to read. */
    fun open() {
        proc.capture.paused = !_capturing.value
        SdrEngine.configure(SdrEngine.Mode.NONE, BANDS[0].second, SdrEngine.IQ_RATE, 32, 40, true, proc)
    }

    fun pickFreq(hz: Long) = SdrEngine.tune(hz)

    fun setCapturing(on: Boolean) { _capturing.value = on; proc.capture.paused = !on }

    private var lastClear = 0L

    /**
     * CLEAR: every burst but the starred ones; a second CLEAR within 3 s clears those too. Returns what is left.
     */
    fun clear(): Int {
        val now = System.currentTimeMillis()
        val all = now - lastClear < CLEAR_AGAIN_MS
        lastClear = now
        val m = _meta.value
        val keep = if (all) emptyList() else _bursts.value.filter { m[it.b.id]?.star == true }
        val gone = _bursts.value.filter { k -> keep.none { it === k } }
        _bursts.value = keep
        val ids = keep.map { it.b.id }.toSet()
        _meta.value = m.filterKeys { it in ids }
        _over.value = _over.value.filterKeys { it in ids }
        _note.value = if (keep.isNotEmpty()) "${keep.size} STARRED KEPT · CLEAR AGAIN TO CLEAR ALL" else ""
        work.execute { for (g in gone) burstFile(g.b.id)?.delete(); saveSession() }
        return keep.size
    }

    fun setMeta(id: Int, f: (BurstMeta) -> BurstMeta) {
        val n = f(_meta.value[id] ?: BurstMeta())
        _meta.value = if (n == BurstMeta()) _meta.value - id else _meta.value + (id to n)
        persist()
    }

    fun setOver(id: Int, o: Overrides) {
        val clean = o.copy(from = null, to = null)
        _over.value = if (clean == Overrides()) _over.value - id else _over.value + (id to clean)
        persist()
    }

    fun setFilter(f: CaptureFilter) { _filter.value = f; persist() }

    // ---- protocols ------------------------------------------------------------------------------------------------

    /** Save a protocol; one of the same name is replaced. */
    fun saveProtocol(p: Protocol) { _protocols.value = _protocols.value.filter { it.name != p.name } + p; persist() }
    fun renameProtocol(old: String, name: String) {
        if (name.isBlank() || name == old) return
        _protocols.value = _protocols.value.filter { it.name != name }.map { if (it.name == old) it.copy(name = name) else it }
        persist()
    }
    fun deleteProtocol(name: String) { _protocols.value = _protocols.value.filter { it.name != name }; persist() }

    /** The saved protocol a burst's best frame carries, if any. */
    fun recognized(a: AnBurst, protocols: List<Protocol>): Recognized? =
        if (protocols.isEmpty() || a.best.isEmpty()) null else recognize(protocols, a.best, a.auto.mod.name, a.auto.coding.name)

    // ---- bursts in ------------------------------------------------------------------------------------------------

    /** A burst off the air: through the filter, then kept. */
    private fun arrive(b: Burst, center: Long) {
        if (!passes(_filter.value, b, center)) { _filtered.value++; return }
        val x = readBurst(b, center)
        if (_filter.value.dataOnly && !hasData(x.auto.frames, x.auto.baud, b.ms, b.matches)) { _filtered.value++; return }
        keep(x)
    }

    /** Read a burst with nothing set and keep it. */
    private fun add(b: Burst, center: Long, store: Boolean = true): AnBurst = keep(readBurst(b, center), store)

    private fun keep(x: AnBurst, store: Boolean = true): AnBurst {
        val next = ArrayList(_bursts.value)
        next.add(x)
        trim(next)
        _bursts.value = next
        if (store) { writeBurst(x); saveSession() }
        return x
    }

    private fun readBurst(b: Burst, center: Long): AnBurst {
        val auto = analyze(b.env, b.fm, b.n, b.rate)
        val best = auto.frames.fold("") { a, f -> if (f.bits.length > a.length) f.bits else a }
        return AnBurst(b, center, auto, best)
    }

    /** Past [MAX_KEPT], the oldest unstarred bursts go (then the oldest starred). */
    private fun trim(list: ArrayList<AnBurst>) {
        while (list.size > MAX_KEPT) {
            val m = _meta.value
            val i = list.indexOfFirst { m[it.b.id]?.star != true }.let { if (it < 0) 0 else it }
            val gone = list.removeAt(i)
            burstFile(gone.b.id)?.delete()
            _meta.value = _meta.value - gone.b.id
            _over.value = _over.value - gone.b.id
        }
    }

    /** Add bursts the tests or a preview made, without a radio. */
    fun addForPreview(b: Burst, center: Long) = add(b, center, store = false)

    /**
     * A file opened in the Analyzer: a recording (.cu8 .u8 .iq unsigned, .cs8 signed; the rate from its name, else
     * 2 Msps), a Flipper .sub RAW file turned back into samples, or a session bundle (.mmanalyzer). Every burst in a
     * recording comes back as if heard off the air, through the capture filter; a bundle's come back as they were.
     */
    fun import(name: String, bytes: ByteArray) {
        _note.value = "READING $name…"
        work.execute {
            val bundle = decodeBundle(bytes)
            if (bundle != null || name.endsWith(".mmanalyzer", ignoreCase = true)) { importBundle(name, bundle); return@execute }
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
            var dropped = 0
            for (b in got) {
                val c = if (center != 0L) center else subHz ?: 0L
                if (passes(_filter.value, b, c)) add(b, c) else { dropped++; _filtered.value++ }
            }
            val line = "$count burst${if (count == 1) "" else "s"} in $name${if (note.isNotEmpty()) " ($note)" else ""}${if (dropped > 0) ", $dropped filtered out" else ""}"
            Diag.log("Analyzer: $line")
            _note.value = "$count BURST${if (count == 1) "" else "S"} IN $name" + if (dropped > 0) " · $dropped FILTERED OUT" else ""
        }
    }

    private fun importBundle(name: String, bundle: Bundle?) {
        if (bundle == null) { _note.value = "$name IS NOT AN ANALYZER SESSION"; return }
        val list = bundle.meta.optJSONArray("bursts") ?: JSONArray()
        var n = 0
        for (k in 0 until list.length()) {
            val o = list.optJSONObject(k) ?: continue
            val arr = bundle.arrays.getOrNull(k) ?: continue
            val b = burstFromJson(o, arr, newBurstId())
            val x = add(b, o.optLong("center", 0L), store = false)
            applyStored(x.b.id, o)
            writeBurst(x); n++
        }
        val ps = bundle.meta.optJSONArray("protocols") ?: JSONArray()
        var np = 0
        for (k in 0 until ps.length()) {
            val p = ps.optJSONObject(k)?.let { runCatching { Protocol.fromJson(it) }.getOrNull() } ?: continue
            if (p.name.isEmpty()) continue
            if (_protocols.value.none { it.name == p.name && it.sync == p.sync }) _protocols.value = _protocols.value + p
            np++
        }
        saveSession()
        _note.value = "$n BURST${if (n == 1) "" else "S"}${if (np > 0) " · $np PROTOCOL${if (np == 1) "" else "S"}" else ""} FROM $name"
        Diag.log("Analyzer: session $name, $n bursts, $np protocols")
    }

    // ---- export ---------------------------------------------------------------------------------------------------

    /** The burst's absolute frequency, or its offset alone when the center is not known. */
    fun freqOf(a: AnBurst): Double = a.center + a.b.hz

    fun nameFor(a: AnBurst, ext: String) = exportName(freqOf(a), a.b.rate, a.b.id, ext)

    fun cu8(a: AnBurst): ByteArray = toCu8(a.b.iq)
    fun cs8(a: AnBurst): ByteArray = toCs8(a.b.iq)
    /** A Flipper .sub of the burst as read now, at its absolute frequency (433.92 MHz when that is not known). */
    fun sub(a: AnBurst, r: Analysis): ByteArray = subText(a, r).toByteArray(Charsets.UTF_8)
    private fun subText(a: AnBurst, r: Analysis): String =
        toSub(pulsesUs(r, a.b.rate), if (a.center != 0L) freqOf(a) else 433_920_000.0, r.mod == Mod.FSK, r.shiftHz)

    /** Every kept burst and the saved protocols, as one `.mmanalyzer` file. */
    fun exportSession(): ByteArray {
        val list = _bursts.value
        val meta = JSONObject().put("version", 1).put("app", "Mayhem Android")
            .put("bursts", JSONArray().also { a -> for (x in list) a.put(burstJson(x)) })
            .put("protocols", JSONArray().also { a -> for (p in _protocols.value) a.put(p.toJson()) })
        return encodeBundle(meta, list.map { BundleArrays(it.b.env, it.b.fm, it.b.iq) })
    }

    fun sessionName(): String = "analyzer_session_${java.text.SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(java.util.Date())}.mmanalyzer"

    /**
     * SEND TO TX: the burst's pulses as a Flipper .sub, handed to the Transmit app's SubGHz replay at the burst's
     * frequency. Transmit asks its own safety question before anything goes out, and nothing is sent until REPLAY
     * is pressed there. Returns a reason when it cannot.
     */
    fun sendToTx(a: AnBurst, r: Analysis): String? {
        val pulses = pulsesUs(r, a.b.rate)
        if (pulses.isEmpty()) return "nothing to send: no marks in this reading"
        val hz = if (a.center != 0L) Math.round(freqOf(a)) else 0L
        val notes = ArrayList<String>()
        if (r.mod == Mod.FSK) notes.add("this burst is FSK: the replay keys it as OOK")
        if (hz == 0L) notes.add("the recording did not say its frequency: set it on the dial")
        Tx.handOff(Tx.SubHandoff(subText(a, r), hz, "from Analyzer burst ${a.b.id}" + (if (notes.isNotEmpty()) " · " + notes.joinToString(" · ") else "")))
        Apps.open(MayhemApp.TRANSMIT)
        return null
    }

    // ---- the files ------------------------------------------------------------------------------------------------

    private var dir: File? = null
    @Volatile private var loaded = false

    /** Where the session lives; loads what was kept last time (once). */
    fun init(filesDir: File) {
        if (dir != null) return
        val d = File(filesDir, "analyzer").also { it.mkdirs() }
        dir = d
        work.execute { load(d); loaded = true }
    }

    private fun burstFile(id: Int): File? = dir?.let { File(it, "b$id.bin") }

    private fun overJson(o: Overrides): JSONObject = JSONObject().also { j ->
        o.mod?.let { j.put("mod", it.name) }; o.symUs?.let { j.put("symUs", it) }; o.thr?.let { j.put("thr", it) }
        o.coding?.let { j.put("coding", it.name) }; if (o.invert) j.put("invert", true)
    }
    private fun overOf(j: JSONObject?): Overrides? {
        if (j == null) return null
        return Overrides(
            mod = j.optString("mod").takeIf { it.isNotEmpty() }?.let { m -> Mod.entries.firstOrNull { it.name == m } },
            symUs = if (j.has("symUs")) j.optDouble("symUs") else null,
            thr = if (j.has("thr")) j.optDouble("thr") else null,
            coding = j.optString("coding").takeIf { it.isNotEmpty() }?.let { c -> Coding.entries.firstOrNull { it.name == c } },
            invert = j.optBoolean("invert"),
        ).takeIf { it != Overrides() }
    }

    /** A burst as the bundle's JSON holds it: what was captured, where, and what the person said about it. */
    private fun burstJson(x: AnBurst): JSONObject {
        val b = x.b
        val j = JSONObject().put("id", b.id).put("t", b.t).put("wall", b.wall).put("hz", b.hz).put("rate", b.rate).put("n", b.n)
            .put("ms", b.ms).put("dbfs", b.dbfs).put("snr", b.snr).put("matches", JSONArray(b.matches)).put("center", x.center)
        b.src?.let { j.put("src", it) }
        _meta.value[b.id]?.let { m -> if (m.name.isNotEmpty()) j.put("name", m.name); if (m.star) j.put("star", true); if (m.note.isNotEmpty()) j.put("note", m.note) }
        _over.value[b.id]?.let { j.put("over", overJson(it)) }
        return j
    }

    private fun burstFromJson(o: JSONObject, a: BundleArrays, id: Int): Burst {
        val ms = o.optJSONArray("matches") ?: JSONArray()
        return Burst(id, o.optDouble("t", 0.0), o.optLong("wall", System.currentTimeMillis()), o.optDouble("hz", 0.0), o.optDouble("rate", 250_000.0),
            a.env.size, a.env, a.fm, a.iq, o.optDouble("ms", 0.0), o.optDouble("dbfs", 0.0), o.optDouble("snr", 0.0),
            (0 until ms.length()).map { ms.optString(it) }, if (o.has("src")) o.optString("src") else null)
    }

    /** The name, star, note and hand settings a stored burst carries. */
    private fun applyStored(id: Int, o: JSONObject) {
        val m = BurstMeta(o.optString("name", ""), o.optBoolean("star"), o.optString("note", ""))
        if (m != BurstMeta()) _meta.value = _meta.value + (id to m)
        overOf(o.optJSONObject("over"))?.let { _over.value = _over.value + (id to it) }
    }

    /** One burst's samples, written once when it is kept: a one-burst bundle. */
    private fun writeBurst(x: AnBurst) {
        val f = burstFile(x.b.id) ?: return
        runCatching {
            val meta = JSONObject().put("version", 1).put("bursts", JSONArray().put(burstJson(x)))
            f.writeBytes(encodeBundle(meta, listOf(BundleArrays(x.b.env, x.b.fm, x.b.iq))))
        }.onFailure { Diag.log("Analyzer: could not keep burst ${x.b.id}: ${it.message}") }
    }

    private fun persist() { work.execute { saveSession() } }

    /** The small part: which bursts, in order, what the person said about each, the protocols and the filter. */
    private fun saveSession() {
        val d = dir ?: return
        if (!loaded) return
        val f = _filter.value
        val j = JSONObject().put("version", 1)
            .put("bursts", JSONArray().also { a -> for (x in _bursts.value) a.put(burstJson(x)) })
            .put("protocols", JSONArray().also { a -> for (p in _protocols.value) a.put(p.toJson()) })
            .put("filter", JSONObject().put("loHz", f.loHz).put("hiHz", f.hiHz).put("minSnr", f.minSnr).put("minMs", f.minMs).put("maxMs", f.maxMs).put("unknownOnly", f.unknownOnly).put("dataOnly", f.dataOnly))
        runCatching {
            val tmp = File(d, "session.json.tmp")
            tmp.writeText(j.toString(), Charsets.UTF_8)
            val dst = File(d, "session.json")
            if (!tmp.renameTo(dst)) { dst.delete(); tmp.renameTo(dst) }
        }.onFailure { Diag.log("Analyzer: could not save the session: ${it.message}") }
    }

    private fun load(d: File) {
        val f = File(d, "session.json")
        val j = runCatching { JSONObject(f.readText(Charsets.UTF_8)) }.getOrNull()
        if (j == null) { d.listFiles()?.forEach { if (it.name.endsWith(".bin")) it.delete() }; return }
        j.optJSONObject("filter")?.let { o ->
            _filter.value = CaptureFilter(o.optDouble("loHz", 0.0), o.optDouble("hiHz", 0.0), o.optDouble("minSnr", 0.0), o.optDouble("minMs", 0.0), o.optDouble("maxMs", 0.0), o.optBoolean("unknownOnly"), o.optBoolean("dataOnly", true))
        }
        val ps = j.optJSONArray("protocols") ?: JSONArray()
        _protocols.value = (0 until ps.length()).mapNotNull { k -> ps.optJSONObject(k)?.let { runCatching { Protocol.fromJson(it) }.getOrNull() } }
        val list = j.optJSONArray("bursts") ?: JSONArray()
        val keep = HashSet<String>()
        val restored = ArrayList<AnBurst>()
        var maxId = 0
        for (k in 0 until list.length()) {
            val o = list.optJSONObject(k) ?: continue
            val id = o.optInt("id", -1)
            val bf = File(d, "b$id.bin")
            val arr = runCatching { decodeBundle(bf.readBytes()) }.getOrNull()?.arrays?.firstOrNull() ?: continue
            val b = burstFromJson(o, arr, id)
            restored.add(readBurst(b, o.optLong("center", 0L)))
            applyStored(id, o)
            keep.add(bf.name)
            if (id > maxId) maxId = id
        }
        reserveBurstIds(maxId)
        // whatever is on file and not in the list was left by a session that stopped half way
        d.listFiles()?.forEach { if (it.name.endsWith(".bin") && it.name !in keep) it.delete() }
        // anything heard while this was loading stays, after what was kept
        _bursts.value = restored + _bursts.value
        Diag.log("Analyzer: ${restored.size} bursts and ${_protocols.value.size} protocols from the last session")
    }
}
