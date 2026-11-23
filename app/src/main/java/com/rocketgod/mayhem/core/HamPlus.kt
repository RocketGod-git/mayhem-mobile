package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.fleet.AutoCall
import com.rocketgod.mayhem.core.fleet.AutoSaved
import com.rocketgod.mayhem.core.fleet.AutoView
import com.rocketgod.mayhem.core.fleet.FleetAuto
import com.rocketgod.mayhem.core.hamplus.HamPlusEngine
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpPrefs
import com.rocketgod.mayhem.core.hamplus.HpSaved
import com.rocketgod.mayhem.core.hamplus.HpAct
import com.rocketgod.mayhem.core.hamplus.HpScan
import com.rocketgod.mayhem.core.hamplus.hpAutoLabel
import com.rocketgod.mayhem.core.hamplus.HpWindow
import com.rocketgod.mayhem.core.hamplus.hpScanText
import com.rocketgod.mayhem.core.hamplus.hpWindows
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.max

/**
 * HAM+ on the phone: what the screen and the scan share around the [HamPlusEngine]. The per-channel preferences (follow,
 * mute, priority) and the station names the listener gives, the listen mode (every channel mixed or the newest) and
 * the volume, the band and span, AUTO's band choice (scored by the voice heard on each window, [FleetAuto]) and what is
 * kept on the phone between sessions (channels, repeater pairs, links and the activity map).
 */
object HamPlus {
    private const val PREFS = "mayhem"
    private const val K_PREFS = "hamplus.prefs"
    private const val K_LABELS = "hamplus.labels"
    private const val K_AUDIO = "hamplus.audio"
    private const val K_AUTO = "hamplus.auto2"
    private const val K_BAND = "hamplus.band"
    private const val K_SPAN = "hamplus.span"
    val SPANS = listOf(2_400_000 to "2.4 MHz", 8_000_000 to "8 MHz", 20_000_000 to "20 MHz")
    val BANDS = listOf("AUTO" to "AUTO", "2M" to "2 M", "125" to "1.25 M", "70CM" to "70 CM", "6M" to "6 M", "10M" to "10 M")

    val engine = HamPlusEngine()
    /** The frame's log (HAM+ writes its lines to the debug log; this one stays empty). */
    val log = PacketLog()
    private var ctx: Context? = null
    private var knownFile: File? = null

    private val _prefs = MutableStateFlow(HpPrefs())
    val prefs: StateFlow<HpPrefs> = _prefs.asStateFlow()
    private val _labels = MutableStateFlow<Map<String, String>>(emptyMap())
    val labels: StateFlow<Map<String, String>> = _labels.asStateFlow()
    private val _mode = MutableStateFlow(HpParams.Mode.MIX)
    val mode: StateFlow<HpParams.Mode> = _mode.asStateFlow()
    private val _audioOn = MutableStateFlow(true)
    val audioOn: StateFlow<Boolean> = _audioOn.asStateFlow()
    private val _gain = MutableStateFlow(1.0)
    val gain: StateFlow<Double> = _gain.asStateFlow()
    private val _band = MutableStateFlow("AUTO")
    val band: StateFlow<String> = _band.asStateFlow()
    private val _span = MutableStateFlow(8_000_000)
    val span: StateFlow<Int> = _span.asStateFlow()

    data class Scan(val windows: List<HpWindow> = emptyList(), val idx: Int = 0, val dwellEnd: Long = 0L, val mode: String = "")
    private val _scan = MutableStateFlow(Scan())
    val scan: StateFlow<Scan> = _scan.asStateFlow()
    @Volatile private var auto: FleetAuto? = null
    private val followScan = HpScan()
    private var autoSig = ""; private var autoSaved = 0L; private var knownAt = 0L

    fun init(c: Context) {
        ctx = c.applicationContext
        knownFile = File(c.filesDir, "hamplus_known2.json")  // 2: 0.9.59 learned false channels from a gain step
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        runCatching { val v = JSONObject(p.getString(K_PREFS, null) ?: ""); _prefs.value = HpPrefs(v.optString("hold"), strs(v.optJSONArray("mute")), strs(v.optJSONArray("prio"))) }
        runCatching { val v = JSONObject(p.getString(K_LABELS, null) ?: ""); _labels.value = v.keys().asSequence().associateWith { v.optString(it) } }
        runCatching {
            val v = JSONObject(p.getString(K_AUDIO, null) ?: "")
            _audioOn.value = v.optBoolean("on", true); _gain.value = v.optDouble("gain", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0
            _mode.value = if (v.optString("mode") == "newest") HpParams.Mode.NEWEST else HpParams.Mode.MIX
        }
        p.getString(K_BAND, null)?.let { b -> if (BANDS.any { it.first == b }) _band.value = b }
        p.getInt(K_SPAN, 0).takeIf { s -> SPANS.any { it.first == s } }?.let { _span.value = it }
    }
    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
    private fun put(k: String, v: String?) { ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.apply { if (v == null) remove(k) else putString(k, v) }?.apply() }

    private fun pushPrefs() = engine.setPrefs(_prefs.value, _labels.value)
    private fun pushParams() = engine.setParams(HpParams(engine.params.thresholdDb, _mode.value, if (_audioOn.value) _gain.value else 0.0))

    /** Toggles mute or priority on a channel, or follows it (one at a time). */
    fun pref(kind: String, key: String) {
        val p = _prefs.value
        val next = when (kind) {
            "hold" -> p.copy(hold = if (p.hold == key) "" else key)
            "mute" -> p.copy(mute = if (key in p.mute) p.mute - key else p.mute + key)
            else -> p.copy(prio = if (key in p.prio) p.prio - key else p.prio + key)
        }
        _prefs.value = next
        put(K_PREFS, JSONObject().put("hold", next.hold).put("mute", JSONArray(next.mute)).put("prio", JSONArray(next.prio)).toString())
        pushPrefs()
    }
    /** A tap on a channel tile: follow it (only it is heard), or back to ALL with "" or a second tap. */
    fun follow(key: String) {
        val cur = _prefs.value.hold
        val next = if (key.isEmpty() || key == cur) "" else key
        if (next == cur) return
        pref("hold", if (next.isEmpty()) cur else next)
        // the scan pauses (or resumes) at once, not on the next half second
        if (Apps.playing() == com.rocketgod.mayhem.core.MayhemApp.HAMPLUS) tick(System.currentTimeMillis())
    }
    /** A name the listener gives a station (empty: back to its letter or callsign). */
    fun label(stationKey: String, name: String) {
        val m = _labels.value.toMutableMap(); val n = name.trim().uppercase()
        if (n.isEmpty()) m.remove(stationKey) else m[stationKey] = n
        _labels.value = m
        put(K_LABELS, JSONObject(m as Map<*, *>).toString())
        pushPrefs()
    }
    fun setMode(m: HpParams.Mode) { _mode.value = m; saveAudio(); pushParams() }
    fun setAudio(on: Boolean, gain: Double = _gain.value) { _audioOn.value = on; _gain.value = gain.coerceIn(0.0, 1.5); saveAudio(); pushParams() }
    private fun saveAudio() = put(K_AUDIO, JSONObject().put("on", _audioOn.value).put("gain", _gain.value).put("mode", if (_mode.value == HpParams.Mode.NEWEST) "newest" else "mix").toString())

    /** A short line the live bar shows for a few seconds (a tap on the timeline with nothing to replay), and until when. */
    private val _note = MutableStateFlow("" to 0L)
    val note: StateFlow<Pair<String, Long>> = _note
    fun note(text: String) { _note.value = text to System.currentTimeMillis() + 3_500 }
    fun replayTx(ids: List<Int>, label: String, kind: String): Boolean = engine.replayTx(ids, label, kind).also { if (!it) note("That audio is no longer kept") }
    fun replayFrom(ms: Double): Boolean = engine.replayFrom(ms).also { if (!it) note("Nothing recorded yet") }
    fun stopReplay() = engine.stopReplay()

    /** The sample rate HAM+ asks for: the chosen span where the radio takes it, else as wide as it goes up to 2.4 MHz. */
    fun rate(): Int {
        val want = _span.value
        if (Radio.canSample(Radio.limits, want)) return want
        return if (Radio.canSample(Radio.limits, 2_400_000)) 2_400_000 else 2_000_000
    }
    fun windows(): List<HpWindow> = hpWindows(_band.value, rate().toDouble())

    /** The app opened: the windows, the prefs, the kept state, the audio. */
    fun open() {
        val w = windows()
        engine.centerHz = w[0].hz
        SdrEngine.configure(SdrEngine.Mode.NONE, w[0].hz, rate(), 32, 40, true, engine)
        pushPrefs(); pushParams()
        loadKnown()?.let { engine.restore(it) }
        _scan.value = Scan(w, 0, System.currentTimeMillis() + 8_000)
        dwell()
    }
    fun setBand(b: String) { _band.value = b; ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(K_BAND, b)?.apply(); if (Apps.playing() == com.rocketgod.mayhem.core.MayhemApp.HAMPLUS) restart() }
    fun setSpan(r: Int) {
        _span.value = r; ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putInt(K_SPAN, r)?.apply()
        if (Apps.playing() != com.rocketgod.mayhem.core.MayhemApp.HAMPLUS) return
        SdrEngine.setRate(rate()); restart()
    }
    private fun restart() {
        val w = windows()
        _scan.value = Scan(w, 0, System.currentTimeMillis() + 8_000)
        tune(w[0].hz)
        dwell()
    }
    private fun tune(hz: Long) { engine.centerHz = hz; SdrEngine.tune(hz) }
    private fun sig(w: List<HpWindow>) = "${_band.value}|${w.joinToString(",") { "${it.hz}" }}"
    private fun dwell() {
        val sc = _scan.value; val now = System.currentTimeMillis(); val s = sig(sc.windows)
        val a = auto
        if (a == null || autoSig != s) {
            autoSig = s
            val na = FleetAuto(sc.windows.size, now, sc.idx, loadAuto(s)); auto = na
            if (na.idx != sc.idx && na.idx in sc.windows.indices) { _scan.value = sc.copy(idx = na.idx); tune(sc.windows[na.idx].hz) }
        } else a.moved(sc.idx, now)
    }

    /**
     * Every half second while HAM+ is open: AUTO holds the window where voice is heard (each transmission scores its
     * seconds, plus two for the transmission), looks at the others now and then, and steps through them while nothing has
     * earned the receiver; and what was heard is kept.
     */
    fun tick(now: Long) {
        if (now - knownAt > 15_000) { knownAt = now; saveKnown() }
        val s = engine.snap.value ?: return
        val a = auto ?: return
        val playingRow = s.rows.firstOrNull { it.live && it.hz.toString() in s.playing }
        val calls = s.rows.map { AutoCall(it.id.toString(), it.live, false, 1, ((if (it.live) s.now else it.endMs) - it.startMs).toLong().coerceAtLeast(0)) }
        val view = AutoView(now, calls, playingRow?.id?.toString() ?: s.rows.firstOrNull { it.live }?.id?.toString() ?: "", false, s.tiles.size)
        // a followed channel pins its window; traffic in the window, and the conversation's hang, keep AUTO and SCAN on it
        val acts = s.rows.map { HpAct(it.id, it.hz, it.startMs.toLong(), it.endMs.toLong(), it.live) }
        val to = followScan.step(a, view, acts, _scan.value.windows.map { it.hz }, rate().toDouble(), _scan.value.idx, _prefs.value)
        var sc = _scan.value.copy(dwellEnd = if (a.mode == "hold") now + 8_000 else a.until, mode = a.mode)
        if (to != null && to != sc.idx && to in sc.windows.indices) { sc = sc.copy(idx = to); tune(sc.windows[to].hz) }
        _scan.value = sc
        saveAuto(now)
    }
    fun scanText(now: Long): String {
        val sc = _scan.value
        val f = followScan
        return hpScanText(sc.windows.size, _band.value == "AUTO", sc.mode, sc.idx, max(0L, (sc.dwellEnd - now + 999) / 1000), f.phase, f.hz, max(0L, (f.until - now + 999) / 1000))
    }
    /** The AUTO control's label: AUTO, KEEP SCANNING while the scan stays for traffic, RESUME SCAN while a channel is followed. */
    fun autoLabel(): String = hpAutoLabel(_scan.value.windows.size, followScan.phase)
    /** A tap on the AUTO control: KEEP SCANNING moves off the busy window, RESUME SCAN unfollows, else the AUTO band. */
    fun autoTap() {
        when (autoLabel()) {
            "KEEP SCANNING" -> skip()
            "RESUME SCAN" -> follow("")
            else -> setBand("AUTO")
        }
    }
    /** KEEP SCANNING: off the busy window at once; it waits a while before AUTO comes back, unless a followed or priority channel is in it. */
    fun skip() {
        val a = auto ?: return
        val sc = _scan.value; val now = System.currentTimeMillis()
        val to = followScan.skip(a, now, sc.windows.map { it.hz }, rate().toDouble(), sc.idx, (listOf(_prefs.value.hold) + _prefs.value.prio).filter { it.isNotEmpty() })
        if (to != null && to != sc.idx && to in sc.windows.indices) { _scan.value = sc.copy(idx = to, mode = a.mode, dwellEnd = a.until); tune(sc.windows[to].hz) }
    }

    fun saveKnown() {
        val file = knownFile ?: return
        val k = runCatching { engine.save() }.getOrNull() ?: return
        Thread { runCatching { val tmp = File(file.path + ".tmp"); tmp.writeText(k.toJson()); tmp.renameTo(file) } }.start()
    }
    private fun loadKnown(): HpSaved? = runCatching { knownFile?.takeIf { it.exists() }?.readText()?.let { HpSaved.fromJson(it) } }.getOrNull()
    /** CLEAR forgets what was heard, and what was kept. */
    fun clear() { engine.clear(); runCatching { knownFile?.delete() } }
    private fun loadAuto(sig: String): AutoSaved? = runCatching {
        val v = JSONObject(ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.getString(K_AUTO, null) ?: return null)
        if (v.optString("sig") != sig) return null
        val sv = v.getJSONObject("saved")
        AutoSaved(sv.getJSONArray("scores").let { a -> (0 until a.length()).map { a.optDouble(it) } }, sv.optJSONArray("listen")?.let { a -> (0 until a.length()).map { a.optDouble(it) } }, sv.optLong("ms"))
    }.getOrNull()
    private fun saveAuto(now: Long) {
        val a = auto ?: return
        if (now - autoSaved < 10_000) return
        autoSaved = now
        val sv = a.save(now)
        put(K_AUTO, JSONObject().put("sig", autoSig).put("saved", JSONObject().put("scores", JSONArray(sv.scores)).put("listen", JSONArray(sv.listen ?: emptyList<Double>())).put("ms", sv.ms)).toString())
    }
}
