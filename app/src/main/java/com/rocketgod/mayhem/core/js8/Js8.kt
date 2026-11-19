package com.rocketgod.mayhem.core.js8

import android.content.Context
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Station as Operator
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.distanceBearing
import com.rocketgod.mayhem.core.ham.gridToLatLon
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The JS8 app's model: conversations, groups, stations heard, the band activity waterfall, the inbox, and sending
 * through the licensed transmit path. Decodes come from [decoder] on the HAM receiver's USB audio. Twin of the
 * state and logic of web/src/js8-ui.ts (the screen is ui/Js8Screen.kt).
 */
object Js8 {
    /** Groups every station has: @ALLCALL and @HB, and @TPP, followed from the start. */
    val BUILTIN_GROUPS = listOf("@ALLCALL", "@HB", "@TPP")
    private val DEFAULT_FOLLOW = listOf("@TPP")

    data class Station(
        val call: String, val firstMs: Long, val lastMs: Long, val snr: Int, val hz: Double, val mode: Js8Speed, val grid: String,
        val dt: Double, val dtAvg: Double, val drift: Double, val heard: Int,
    )
    data class Entry(
        val id: String, val ms: Long, val mode: Js8Speed, val hz: Int, val snr: Int, val dt: Double, val text: String, val complete: Boolean,
        val frames: Int, val mine: Boolean = false, /** queued, sending, sent or failed */ val state: String? = null, val meaning: Js8Meaning,
    )
    data class Activity(val ms: Long, val mode: Js8Speed, val snr: Int, val dt: Double, val hz: Double, val drift: Double, val text: String, val kind: String)
    data class Mark(val ms: Long, val hz: Double, val label: String, val mode: Js8Speed)
    data class Room(val key: String, val last: Long, val n: Int, val unread: Int)

    data class State(
        val dial: Long = 7_078_000L,
        val speeds: Map<Js8Speed, Boolean> = Js8Speed.entries.associateWith { true },
        val txSpeed: Js8Speed = Js8Speed.NORMAL, val txHz: Double = 1500.0,
        val groups: List<String> = BUILTIN_GROUPS, val follow: List<String> = DEFAULT_FOLLOW,
        /** Most recently heard last. */
        val stations: Map<String, Station> = emptyMap(),
        val entries: List<Entry> = emptyList(),
        /** Newest first. */
        val activity: List<Activity> = emptyList(),
        val read: Map<String, Long> = emptyMap(),
        val marks: List<Mark> = emptyList(),
        val room: String = "", val target: String = "", val draft: String = "",
        val status: String = "",
        /** Bumped when [draft] is set from outside the text field (DELIVER, a sent message clearing it). */
        val draftRev: Int = 0,
        /** The dictionary has loaded (compressed text reads and sends from then on). */
        val dict: Boolean = false,
    )

    private val _st = MutableStateFlow(State())
    val state: StateFlow<State> = _st.asStateFlow()
    private val lock = Any()
    private fun mutate(f: (State) -> State) { synchronized(lock) { _st.value = f(_st.value) } }

    val decoder = Js8Decoder()
    private val asm = Js8Assembler()
    private val newMsgs = ArrayList<Js8Message>()
    private class Queued(val at: Long, val label: String, val tones: IntArray, val speed: Js8Speed, val entry: String, val last: Boolean, val hz: Double)
    private val queue = ArrayList<Queued>()
    private var ctx: Context? = null
    private var loaded = false
    private var saveAt = 0L
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "js8-io").apply { isDaemon = true } }

    /** The passband waterfall: up to 480 rows of 512 bins (0-3200 Hz), each 0..255 against its own median. */
    class Wf(val ms: Long, val row: ByteArray)
    private val wfRows = ArrayDeque<Wf>()
    private val _wfTick = MutableStateFlow(0L)
    val wfTick: StateFlow<Long> = _wfTick.asStateFlow()
    fun wfSnapshot(): List<Wf> = synchronized(wfRows) { wfRows.toList() }

    init {
        asm.onMessage = { newMsgs += it }
        decoder.onDecodes = { list, speed, slot -> onDecodes(list, speed, slot) }
        decoder.onWaterfall = { row, ms -> onWaterfall(row, ms) }
    }

    /** Remembers the app context; what was heard is read the first time JS8 opens. */
    fun init(c: Context) { ctx = c.applicationContext }

    // ---- the receiver -------------------------------------------------------------------------------------------------
    /** Opening the app: the HAM receiver in USB on the dial, its audio feeding the JS8 receiver; the dictionary loads. */
    fun open() {
        load()
        loadDictionary()
        decoder.enabled = _st.value.speeds
        Ham.openJs8(_st.value.dial, decoder)
    }

    /** Compressed text needs the JS8 dictionary; it is read once, the first time JS8 runs. */
    fun loadDictionary(onReady: () -> Unit = {}) {
        if (Js8Varicode.jscReady()) { if (!_st.value.dict) mutate { it.copy(dict = true) }; onReady(); return }
        val c = ctx ?: return
        io.execute {
            runCatching { Js8Varicode.loadJsc({ c.assets.open("js8-jsc.json.gz") }) }
                .onFailure { com.rocketgod.mayhem.Diag.log("JS8: dictionary did not load: ${it.message}") }
            if (Js8Varicode.jscReady()) mutate { it.copy(dict = true) }
            onReady()
        }
    }

    fun tune(hzIn: Long) {
        val hz = hzIn.coerceIn(1_000_000L, 6_000_000_000L)
        mutate { it.copy(dial = hz) }
        save(force = true)
        Ham.js8Tune(hz)
    }

    fun toggleSpeed(id: Js8Speed) {
        mutate { s ->
            val sp = s.speeds.toMutableMap(); sp[id] = !(sp[id] ?: true)
            if (sp.values.none { it }) sp[id] = true
            s.copy(speeds = sp)
        }
        decoder.enabled = _st.value.speeds
        save(force = true)
    }

    // ---- receiving ------------------------------------------------------------------------------------------------------
    private fun onDecodes(list: List<Js8Decode>, speed: Js8Speed, slotMs: Long) {
        val m = js8Mode(speed)
        synchronized(lock) {
            var s = _st.value
            val act = ArrayList<Activity>(list.size + s.activity.size)
            val stations = LinkedHashMap(s.stations)
            val marks = ArrayList(s.marks)
            for (d in list.asReversed()) act += Activity(slotMs, speed, d.snr, d.dt, d.hz, d.drift, d.frame.text ?: frameLabel(d.frame.kind), d.frame.kind)
            act.addAll(s.activity)
            for (d in list) {
                asm.push(FramePart(d.frame, speed, d.hz, slotMs, d.snr, d.dt), m.period, m.spacing)
                val call = d.frame.from?.takeIf { Js8Msg.isStandardCall(it) } ?: ""
                if (call.isNotEmpty()) heardStation(stations, call, slotMs, d)
                marks += Mark(slotMs + ((m.delay + d.dt) * 1000).toLong(), d.hz, call.ifEmpty { frameLabel(d.frame.kind) }, speed)
            }
            asm.tick(slotMs)
            s = s.copy(activity = act.take(400), stations = stations, marks = marks.takeLast(200))
            _st.value = s
            applyMessages()
        }
        save()
    }

    private fun frameLabel(kind: String): String = when (kind) {
        "heartbeat" -> "HEARTBEAT FRAME"; "compound" -> "COMPOUND CALL FRAME"; "compoundDirected" -> "COMPOUND DIRECTED FRAME"
        "compressed" -> "COMPRESSED TEXT FRAME"; else -> kind.uppercase()
    }

    private fun heardStation(map: LinkedHashMap<String, Station>, call: String, ms: Long, d: Js8Decode) {
        val old = map[call]
        val heard = (old?.heard ?: 0) + 1
        val s = Station(call, old?.firstMs ?: ms, max(old?.lastMs ?: ms, ms), d.snr, d.hz, d.mode, old?.grid ?: "", d.dt,
            if (heard == 1) d.dt else (old!!.dtAvg + 0.2 * (d.dt - old.dtAvg)), d.drift, heard)
        map.remove(call); map[call] = s
    }

    /** The messages the assembler produced since the last call, into the entries (under [lock]). */
    private fun applyMessages() {
        if (newMsgs.isEmpty()) return
        var s = _st.value
        val entries = ArrayList(s.entries); val stations = LinkedHashMap(s.stations)
        for (m in newMsgs) {
            val e = Entry(m.id, m.startMs, m.mode, m.hz, m.snr, m.dt, m.text, m.complete, m.frames, meaning = m.meaning)
            val i = entries.indexOfFirst { it.id == m.id }
            if (i >= 0) entries[i] = e else entries += e
            val mm = m.meaning
            if (mm.from.isNotEmpty() && Js8Msg.isStandardCall(mm.from)) {
                val st = stations[mm.from]
                if (st != null && mm.grid != null) stations[mm.from] = st.copy(grid = mm.grid.uppercase())
            }
        }
        newMsgs.clear()
        s = s.copy(entries = entries.takeLast(600), stations = stations)
        _st.value = s
    }

    /** Feed for the demo and tests: complete messages as if assembled from the air. */
    fun inject(m: Js8Message, station: Station? = null) {
        synchronized(lock) {
            newMsgs += m; applyMessages()
            if (station != null) _st.value = _st.value.let { it.copy(stations = LinkedHashMap(it.stations).apply { put(station.call, station) }) }
        }
    }

    private fun onWaterfall(row: FloatArray, ms: Long) {
        if (ms - lastWf < 240) return
        lastWf = ms
        // each row against its own median, so the picture holds steady whatever the gain
        val sorted = row.copyOf().also { it.sort() }; val med = sorted[sorted.size shr 1]
        val b = ByteArray(row.size) { i -> ((row[i] - med + 6) * 9).roundToInt().coerceIn(0, 255).toByte() }
        synchronized(wfRows) { wfRows.addLast(Wf(ms, b)); while (wfRows.size > 480) wfRows.removeFirst() }
        _wfTick.value = ms
    }
    @Volatile private var lastWf = 0L

    // ---- conversations ----------------------------------------------------------------------------------------------------
    fun me(): String = Operator.info.value.call.trim().uppercase()
    fun grid4(): String = Operator.grid().take(4).uppercase()
    /** Group names are not case-sensitive on the air: one spelling, upper case with its @. */
    fun normGroup(g: String): String {
        val t = g.trim().uppercase().let { if (it.startsWith("@")) it else "@$it" }
        return if (Regex("^@[A-Z0-9/]{1,9}$").matches(t)) t else ""
    }
    fun isGroup(k: String) = k.startsWith("@")
    fun followed(s: State, g: String) = g in s.follow

    /** Which room an entry belongs to: the group, @ALLCALL, the other station, or BAND for text with no address. */
    fun roomOf(e: Entry, my: String = me()): String {
        val m = e.meaning
        if (m.to.isNotEmpty() && isGroup(m.to)) return normGroup(m.to).ifEmpty { m.to }
        if (m.kind == "cq") return "@CQ"
        if (m.from.isNotEmpty() && m.to.isNotEmpty()) return if (m.from == my) m.to else if (m.to == my) m.from else listOf(m.from, m.to).sorted().joinToString("|")
        if (m.from.isNotEmpty()) return if (m.from == my) "BAND" else m.from
        return "BAND"
    }
    fun rooms(s: State): List<Room> {
        val my = me()
        val map = LinkedHashMap<String, Room>()
        for (g in s.follow) map[g] = Room(g, 0, 0, 0)
        for (e in s.entries) {
            val k = roomOf(e, my)
            val r = map[k] ?: Room(k, 0, 0, 0)
            map[k] = r.copy(last = max(r.last, e.ms), n = r.n + 1, unread = r.unread + if (!e.mine && e.ms > (s.read[k] ?: 0)) 1 else 0)
        }
        return map.values.sortedWith(compareByDescending<Room> { if (followed(s, it.key)) 1 else 0 }.thenByDescending { it.last })
    }
    fun roomTitle(k: String): String = if (k.contains('|')) k.replace("|", " · ") else if (k == "BAND") "BAND TEXT" else k
    fun forMe(e: Entry): Boolean { val my = me(); return my.isNotEmpty() && (e.meaning.to == my || e.meaning.dest == my) }

    /** Opening a room marks it read and makes it the compose target (BAND for a pair of others or CQ). */
    fun openRoom(k: String) {
        mutate { s ->
            val target = if (!isGroup(k) && k != "BAND" && !k.contains('|') && k != "@CQ") k else if (isGroup(k)) k else "BAND"
            s.copy(room = k, read = s.read + (k to System.currentTimeMillis()), target = target)
        }
        save(force = true)
    }
    fun allRooms() = mutate { it.copy(room = "") }
    fun chatWith(call: String) = mutate { it.copy(room = call, target = call, read = it.read + (call to System.currentTimeMillis())) }
    fun setTarget(t: String) = mutate { it.copy(target = t) }
    fun setDraft(t: String) = mutate { it.copy(draft = t) }
    fun setTxSpeed(sp: Js8Speed) { mutate { it.copy(txSpeed = sp) }; save(force = true) }
    fun setTxHz(hz: Double) { mutate { it.copy(txHz = hz.coerceIn(JS8_TX_MIN_HZ.toDouble(), JS8_TX_MAX_HZ.toDouble())) }; save(force = true) }
    fun nudgeTx(d: Int) = setTxHz(_st.value.txHz + d)
    fun clearActivity() { mutate { it.copy(activity = emptyList()) }; save(force = true) }
    fun toggleFollow(g: String) { mutate { s -> s.copy(follow = if (g in s.follow) s.follow - g else s.follow + g) }; save(force = true) }
    fun removeGroup(g: String) {
        if (g in BUILTIN_GROUPS) return
        mutate { s -> s.copy(groups = s.groups - g, follow = s.follow - g) }; save(force = true)
    }
    /** Adds a group and follows it; false when the name is not a group JS8 can carry. */
    fun addGroup(v: String): Boolean {
        val g = normGroup(v)
        if (g.isEmpty()) { status("a group is @ and up to 9 letters or digits"); return false }
        mutate { s -> s.copy(groups = if (g in s.groups) s.groups else s.groups + g, follow = if (g in s.follow) s.follow else s.follow + g) }
        save(force = true)
        return true
    }
    /** A message kept for another station: the compose line set up to pass it on. */
    fun deliver(id: String) {
        val e = _st.value.entries.firstOrNull { it.id == id } ?: return
        val dest = e.meaning.dest ?: return
        mutate { it.copy(room = dest, target = dest, draft = "MSG FROM ${e.meaning.from} ${e.meaning.body}", draftRev = it.draftRev + 1) }
    }
    fun status(s: String) = mutate { it.copy(status = s) }

    fun inbox(s: State): List<Entry> = s.entries.filter { !it.mine && forMe(it) }
    /** MSG TO: another station, heard here: kept so it can be passed on. */
    fun keptForOthers(s: State): List<Entry> { val my = me(); return s.entries.filter { it.meaning.kind == "msgto" && !it.mine && it.meaning.dest != null && it.meaning.dest != my } }

    /** Distance (km) and bearing (degrees) from you to a grid. */
    fun where(grid: String): Pair<Double, Double>? {
        val p = gridToLatLon(grid) ?: return null
        val h = home() ?: return null
        return distanceBearing(h.first, h.second, p.first, p.second)
    }
    fun home(): Pair<Double, Double>? = Geo.fix.value ?: Operator.latLon()

    // ---- sending ------------------------------------------------------------------------------------------------------------
    fun nextSlot(speed: Js8Speed, now: Long = System.currentTimeMillis()): Long { val p = js8Mode(speed).period * 1000L; return ceil((now + 300).toDouble() / p).toLong() * p }

    class Plan(val frames: List<Frame>?, val why: String, val line: String)
    /** What SEND would do with the target and text now, or why it cannot. */
    fun plan(target: String, text: String, speed: Js8Speed = _st.value.txSpeed): Plan {
        val call = me()
        if (call.isEmpty()) return Plan(null, "set your callsign in Settings, STATION", "")
        if (!Js8Varicode.isValidCallsign(call).valid) return Plan(null, "$call is not a callsign JS8 can send", "")
        if (!Js8Varicode.jscReady()) { loadDictionary(); return Plan(null, "loading the JS8 dictionary", "") }
        val body = text.uppercase().replace(Regex("\\s+"), " ").trim()
        val line: String
        when {
            target == "HB" -> line = "@HB HEARTBEAT ${grid4()}".trim()
            target == "CQ" -> line = "CQ CQ CQ ${grid4()}".trim()
            target == "HB SNR" -> return Plan(null, "", "")
            target.isEmpty() || target == "BAND" -> {
                if (body.isEmpty()) return Plan(null, "", "")
                line = if (Regex("\\bDE [A-Z0-9/]+$").containsMatchIn(body) || body.contains(call)) body else "$body DE $call"
            }
            else -> {
                if (!Js8Varicode.isValidCallsign(target).valid) return Plan(null, "$target is not a callsign or group", "")
                line = "$target $body".trim()
            }
        }
        val frames = Js8Varicode.buildMessageFrames(call, grid4(), "", line, speed)
        return if (frames.isNotEmpty()) Plan(frames, "", line) else Plan(null, "nothing JS8 can send in that", line)
    }
    /** How a frame list reads on the air, exactly as a receiver shows it. */
    fun asShown(frames: List<Frame>): String = frames.joinToString("") { Js8Msg.unpackFrame(it).text ?: "" }.replace(Regex("\\s+"), " ").trim()

    /** Why sending cannot start right now, or "" when it can. */
    fun txReady(): String = when {
        !Tx.enabled.value -> "transmit is switched off in Settings"
        Radio.kind.value != Radio.Kind.HACKRF || !Radio.canTransmit -> "sending needs a HackRF"
        Operator.info.value.call.isBlank() -> "set your callsign in Settings, STATION"
        else -> ""
    }

    enum class Sent { QUEUED, PROMPT, REFUSED }
    /** Queues a message for the next slot boundaries: [kind] text, hbsnr, hb or cq. */
    fun send(kind: String, target: String, text: String, snr: Int = 0, now: Long = System.currentTimeMillis(), ready: String = txReady()): Sent {
        if (ready.isNotEmpty()) { status(ready); return Sent.REFUSED }
        if (Tx.needsPrompt.value) return Sent.PROMPT
        val p = when (kind) {
            "hbsnr" -> plan(target, "HEARTBEAT SNR ${if (snr < 0) "-" else "+"}${abs(snr).toString().padStart(2, '0')}")
            "hb" -> plan("HB", ""); "cq" -> plan("CQ", ""); else -> plan(target, text)
        }
        val frames = p.frames
        if (frames == null) { status(p.why.ifEmpty { "nothing to send" }); return Sent.REFUSED }
        val speed = _st.value.txSpeed; val m = js8Mode(speed)
        val first = nextSlot(speed, now)
        val id = "tx-$first"
        // heartbeats and CQs go in the heartbeat part of the passband, the way JS8 stations listen for them
        val hz = if (kind == "hb" || kind == "cq") JS8_HB_LO_HZ + Math.random() * (JS8_HB_HI_HZ - JS8_HB_LO_HZ) else _st.value.txHz
        val shown = asShown(frames)
        synchronized(lock) {
            frames.forEachIndexed { k, f ->
                queue += Queued(first + k * m.period * 1000L + (m.delay * 1000).toLong(), "JS8 ${m.label} ${k + 1}/${frames.size}", Js8Codec.frameTones(f, m.costas), speed, id, k == frames.size - 1, hz)
            }
            _st.value = _st.value.let { s ->
                s.copy(entries = (s.entries + Entry(id, first, speed, hz.roundToInt(), 0, 0.0, shown, true, frames.size, mine = true, state = "queued", meaning = Js8Msg.parseMessage(shown))).takeLast(600),
                    draft = if (kind == "text") "" else s.draft, draftRev = if (kind == "text") s.draftRev + 1 else s.draftRev,
                    status = "${frames.size} frame${if (frames.size > 1) "s" else ""} · ${m.label} · ${hz.roundToInt()} Hz · starts ${utc(first)} UTC")
            }
        }
        save(force = true)
        return Sent.QUEUED
    }

    /** Whether anything is waiting for its slot. */
    fun queued(): Boolean = synchronized(lock) { queue.isNotEmpty() }

    /**
     * Sends the next frame when its slot comes (called every 100 ms while the screen is up). A frame that missed its
     * slot moves the rest of its message on by whole slots.
     */
    fun pump(now: Long = System.currentTimeMillis(), tx: (String, Long, FloatArray, Int, Int) -> Boolean = { l, f, t, r, s -> Tx.js8(l, f, t, r, s) }) {
        val q0: Queued
        synchronized(lock) {
            if (queue.isEmpty()) return
            val q = queue[0]
            if (now < q.at - 40) return
            queue.removeAt(0)
            if (now > q.at + 1500) {
                val p = js8Mode(q.speed).period * 1000L; val late = ceil((now - q.at).toDouble() / p).toLong() * p
                val moved = queue.map { if (it.entry == q.entry) Queued(it.at + late, it.label, it.tones, it.speed, it.entry, it.last, it.hz) else it }
                queue.clear(); queue += Queued(q.at + late, q.label, q.tones, q.speed, q.entry, q.last, q.hz); queue += moved
                return
            }
            q0 = q
        }
        val m = js8Mode(q0.speed); val rate = 12_000
        val ok = tx(q0.label, _st.value.dial + q0.hz.roundToInt(), Js8Synth.toneTrack(q0.tones, m, rate), rate, (m.symbol * rate).roundToInt())
        synchronized(lock) {
            if (!ok) queue.removeAll { it.entry == q0.entry }
            _st.value = _st.value.let { s -> s.copy(entries = s.entries.map { if (it.id == q0.entry) it.copy(state = if (ok) (if (q0.last) "sent" else "sending") else "failed") else it },
                status = if (!ok) Tx.status.value.ifEmpty { s.status } else s.status) }
        }
    }
    /** Everything queued is dropped (leaving the app, a stop). */
    fun stop() {
        synchronized(lock) {
            queue.clear()
            _st.value = _st.value.let { s -> s.copy(entries = s.entries.map { if (it.mine && (it.state == "queued" || it.state == "sending")) it.copy(state = "failed") else it }) }
        }
    }

    /** Frames a text takes at a speed, for the compose line and tests. */
    fun frameCount(target: String, text: String): Int = plan(target, text).frames?.size ?: 0

    fun utc(ms: Long): String = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(ms))

    // ---- persistence ----------------------------------------------------------------------------------------------------------
    private fun file(): File? = ctx?.filesDir?.let { File(it, "js8.json") }

    private fun load() {
        if (loaded) return
        val f = file() ?: return
        loaded = true
        val text = runCatching { f.takeIf { it.exists() }?.readText() }.getOrNull() ?: return
        runCatching { fromJson(JSONObject(text)) }.onFailure { com.rocketgod.mayhem.Diag.log("JS8: saved state not read: ${it.message}") }
    }

    /** Saves the stations, messages, groups and follows (at most every 1.5 s unless [force]). */
    fun save(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - saveAt < 1500) return
        saveAt = now
        val f = file() ?: return
        val s = _st.value
        io.execute { runCatching { val tmp = File(f.path + ".tmp"); tmp.writeText(toJson(s).toString()); tmp.renameTo(f) } }
    }

    fun toJson(s: State): JSONObject {
        val o = JSONObject()
        o.put("dial", s.dial).put("txSpeed", s.txSpeed.id).put("txHz", s.txHz)
        o.put("speeds", JSONObject().also { j -> for ((k, v) in s.speeds) j.put(k.id, v) })
        o.put("groups", JSONArray(s.groups)).put("follow", JSONArray(s.follow))
        o.put("stations", JSONArray().also { a -> for (x in s.stations.values.sortedByDescending { it.lastMs }.take(500)) a.put(JSONObject()
            .put("call", x.call).put("firstMs", x.firstMs).put("lastMs", x.lastMs).put("snr", x.snr).put("hz", x.hz).put("mode", x.mode.id)
            .put("grid", x.grid).put("dt", x.dt).put("dtAvg", x.dtAvg).put("drift", x.drift).put("heard", x.heard)) })
        o.put("entries", JSONArray().also { a -> for (e in s.entries.takeLast(600)) a.put(JSONObject()
            .put("id", e.id).put("ms", e.ms).put("mode", e.mode.id).put("hz", e.hz).put("snr", e.snr).put("dt", e.dt).put("text", e.text)
            .put("complete", e.complete).put("frames", e.frames).put("mine", e.mine).also { if (e.state != null) it.put("state", e.state) }) })
        o.put("activity", JSONArray().also { a -> for (x in s.activity.take(400)) a.put(JSONObject()
            .put("ms", x.ms).put("mode", x.mode.id).put("snr", x.snr).put("dt", x.dt).put("hz", x.hz).put("drift", x.drift).put("text", x.text).put("kind", x.kind)) })
        o.put("read", JSONObject().also { j -> for ((k, v) in s.read) j.put(k, v) })
        return o
    }

    fun fromJson(o: JSONObject) {
        fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else List(a.length()) { a.optString(it) }
        mutate { s0 ->
            var s = s0
            if (o.optLong("dial") > 0) s = s.copy(dial = o.optLong("dial"))
            o.optJSONObject("speeds")?.let { j -> s = s.copy(speeds = Js8Speed.entries.associateWith { j.optBoolean(it.id, s.speeds[it] ?: true) }) }
            Js8Speed.of(o.optString("txSpeed"))?.let { s = s.copy(txSpeed = it) }
            if (o.optDouble("txHz", 0.0) > 0) s = s.copy(txHz = o.optDouble("txHz"))
            o.optJSONArray("groups")?.let { a -> s = s.copy(groups = (BUILTIN_GROUPS + strs(a).map(::normGroup).filter { it.isNotEmpty() }).distinct()) }
            o.optJSONArray("follow")?.let { a -> s = s.copy(follow = strs(a).map(::normGroup).filter { it.isNotEmpty() }.distinct()) }
            o.optJSONArray("stations")?.let { a ->
                val m = LinkedHashMap<String, Station>()
                val list = List(a.length()) { a.getJSONObject(it) }.mapNotNull { x ->
                    runCatching { Station(x.getString("call"), x.optLong("firstMs"), x.optLong("lastMs"), x.optInt("snr"), x.optDouble("hz"), Js8Speed.of(x.optString("mode")) ?: Js8Speed.NORMAL,
                        x.optString("grid"), x.optDouble("dt"), x.optDouble("dtAvg"), x.optDouble("drift"), x.optInt("heard")) }.getOrNull()
                }.sortedBy { it.lastMs }
                for (x in list) m[x.call] = x
                s = s.copy(stations = m)
            }
            o.optJSONArray("entries")?.let { a ->
                s = s.copy(entries = List(a.length()) { a.getJSONObject(it) }.mapNotNull { x ->
                    runCatching { val text = x.getString("text")
                        Entry(x.getString("id"), x.optLong("ms"), Js8Speed.of(x.optString("mode")) ?: Js8Speed.NORMAL, x.optInt("hz"), x.optInt("snr"), x.optDouble("dt"), text,
                            x.optBoolean("complete"), x.optInt("frames"), x.optBoolean("mine"), x.optString("state").ifEmpty { null }?.let { if (it == "queued" || it == "sending") "failed" else it },
                            Js8Msg.parseMessage(text)) }.getOrNull()
                }.takeLast(600))
            }
            o.optJSONArray("activity")?.let { a ->
                s = s.copy(activity = List(a.length()) { a.getJSONObject(it) }.mapNotNull { x ->
                    runCatching { Activity(x.optLong("ms"), Js8Speed.of(x.optString("mode")) ?: Js8Speed.NORMAL, x.optInt("snr"), x.optDouble("dt"), x.optDouble("hz"), x.optDouble("drift"), x.optString("text"), x.optString("kind")) }.getOrNull()
                }.take(400))
            }
            o.optJSONObject("read")?.let { j -> s = s.copy(read = j.keys().asSequence().associateWith { j.optLong(it) }) }
            s
        }
    }

    /** Forgets what was heard (stations, messages, activity); groups and follows stay. */
    fun forget() { mutate { it.copy(stations = emptyMap(), entries = emptyList(), activity = emptyList(), read = emptyMap(), marks = emptyList()) }; save(force = true) }

    /** The compass point of a bearing. */
    fun compass(d: Double): String = listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")[((d / 45).roundToInt()) % 8]
    fun fmtSnr(s: Int): String = "${if (s >= 0) "+" else ""}$s"
    fun ago(ms: Long, now: Long): String { val s = max(0L, ((now - ms) / 1000.0).roundToInt().toLong()); return if (s < 60) "$s s" else if (s < 3600) "${(s / 60.0).roundToInt()} min" else if (s < 86400) "${(s / 3600.0).roundToInt()} h" else "${(s / 86400.0).roundToInt()} d" }
}
