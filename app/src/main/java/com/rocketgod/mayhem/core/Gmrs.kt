package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.gmrs.GMRS_RATE
import com.rocketgod.mayhem.core.gmrs.GmrsBand
import com.rocketgod.mayhem.core.gmrs.GmrsEngine
import com.rocketgod.mayhem.core.gmrs.MURS_RATE
import com.rocketgod.mayhem.core.gmrs.NARROW_RATE
import com.rocketgod.mayhem.core.gmrs.centerOf
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpPrefs
import com.rocketgod.mayhem.core.hamplus.HpSaved
import com.rocketgod.mayhem.core.hamplus.hpPrefsRestored
import com.rocketgod.mayhem.core.hamplus.hpPrefsSaved
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * GMRS on the phone: what the screen shares around the two [GmrsEngine]s, GMRS / FRS and MURS. The band shown, the
 * per-channel preferences (follow, mute, priority), the talker names the listener gives, the listen mode and the
 * volume, and what is kept between sessions, a file a band. Receive only. One span hears a whole band: GMRS from
 * 465.140625 MHz at 8 MS/s and MURS from 153.000 at 4 on a HackRF; an RTL-SDR at 2.4 MS/s hears the 15 GMRS channels at
 * 462 MHz, or the three MURS ones at 151.
 */
object Gmrs {
    private const val PREFS = "mayhem"
    private const val K_PREFS = "gmrs.prefs"
    private const val K_LABELS = "gmrs.labels"
    private const val K_AUDIO = "gmrs.audio"
    private const val K_BAND = "gmrs.band"

    val gmrs = GmrsEngine(GmrsBand.GMRS)
    val murs = GmrsEngine(GmrsBand.MURS)
    fun engineOf(b: GmrsBand): GmrsEngine = if (b == GmrsBand.MURS) murs else gmrs
    val engine: GmrsEngine get() = engineOf(_band.value)
    /** The frame's log (GMRS writes its lines to the debug log; this one stays empty). */
    val log = PacketLog()
    private var ctx: Context? = null
    private var dir: File? = null

    private val _band = MutableStateFlow(GmrsBand.GMRS)
    val band: StateFlow<GmrsBand> = _band.asStateFlow()
    private val _prefs = MutableStateFlow(HpPrefs())
    val prefs: StateFlow<HpPrefs> = _prefs.asStateFlow()
    private val _labels = MutableStateFlow<Map<String, String>>(emptyMap())
    val labels: StateFlow<Map<String, String>> = _labels.asStateFlow()
    private val _mode = MutableStateFlow(HpParams.Mode.NEWEST)
    val mode: StateFlow<HpParams.Mode> = _mode.asStateFlow()
    private val _audioOn = MutableStateFlow(true)
    val audioOn: StateFlow<Boolean> = _audioOn.asStateFlow()
    private val _gain = MutableStateFlow(1.0)
    val gain: StateFlow<Double> = _gain.asStateFlow()
    private var knownAt = 0L

    fun init(c: Context) {
        ctx = c.applicationContext
        dir = c.filesDir
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _band.value = if (p.getString(K_BAND, null) == "murs") GmrsBand.MURS else GmrsBand.GMRS
        runCatching { val v = JSONObject(p.getString(K_PREFS, null) ?: ""); _prefs.value = hpPrefsRestored(strs(v.optJSONArray("mute")), strs(v.optJSONArray("prio"))) }
        runCatching { val v = JSONObject(p.getString(K_LABELS, null) ?: ""); _labels.value = v.keys().asSequence().associateWith { v.optString(it) } }
        runCatching {
            val v = JSONObject(p.getString(K_AUDIO, null) ?: "")
            _audioOn.value = v.optBoolean("on", true); _gain.value = v.optDouble("gain", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0
            _mode.value = if (v.optString("mode") == "mix") HpParams.Mode.MIX else HpParams.Mode.NEWEST
        }
    }
    private fun knownFile(b: GmrsBand): File? = dir?.let { File(it, if (b == GmrsBand.MURS) "murs_known1.json" else "gmrs_known1.json") }
    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
    private fun put(k: String, v: String?) { ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.apply { if (v == null) remove(k) else putString(k, v) }?.apply() }

    private fun pushPrefs() { engine.setPrefs(_prefs.value, _labels.value) }
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
        hpPrefsSaved(next).let { sv -> put(K_PREFS, JSONObject().put("mute", JSONArray(sv.mute)).put("prio", JSONArray(sv.prio)).toString()) }
        pushPrefs()
    }
    /** A tap on a channel: follow it (only it is heard), or back to ALL with "" or a second tap. */
    fun follow(key: String) {
        val cur = _prefs.value.hold
        val next = if (key.isEmpty() || key == cur) "" else key
        if (next == cur) return
        pref("hold", if (next.isEmpty()) cur else next)
    }
    /** A name the listener gives a talker (empty: back to its letter). */
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

    /** GMRS / FRS or MURS: what was heard on the band left is kept, and the radio moves to the other. */
    fun setBand(b: GmrsBand) {
        if (b == _band.value) return
        saveKnown()
        _band.value = b; put(K_BAND, if (b == GmrsBand.MURS) "murs" else "gmrs")
        if (Apps.playing() == MayhemApp.GMRS) open()
    }

    /** A short line the live bar shows for a few seconds (a tap on the timeline with nothing to replay), and until when. */
    private val _note = MutableStateFlow("" to 0L)
    val note: StateFlow<Pair<String, Long>> = _note
    fun note(text: String) { _note.value = text to System.currentTimeMillis() + 3_500 }
    fun replayTx(ids: List<Int>, label: String, kind: String): Boolean = engine.replayTx(ids, label, kind).also { if (!it) note("That audio is no longer kept") }
    fun replayFrom(ms: Double): Boolean = engine.replayFrom(ms).also { if (!it) note("Nothing recorded yet") }
    fun stopReplay() = engine.stopReplay()

    /** The whole band in one span: a HackRF at 8 MS/s (GMRS) or 4 (MURS); an RTL-SDR at 2.4, the part it can. */
    fun wide(): Boolean = Radio.kind.value != Radio.Kind.RTLSDR && Radio.canSample(Radio.limits, if (_band.value == GmrsBand.MURS) MURS_RATE else GMRS_RATE)
    fun rate(): Int = if (wide()) (if (_band.value == GmrsBand.MURS) MURS_RATE else GMRS_RATE) else NARROW_RATE

    /** The app opened (or the band changed): the radio on the band's center, the prefs, the kept state, the audio. */
    fun open() {
        val e = engine; val hz = centerOf(_band.value, wide())
        e.centerHz = hz
        SdrEngine.configure(SdrEngine.Mode.NONE, hz, rate(), 32, 40, true, e)
        pushPrefs(); pushParams()
        loadKnown(_band.value)?.let { e.restore(it) }
    }

    /** Every half second while GMRS is open: what was heard is kept now and then. */
    fun tick(now: Long) { if (now - knownAt > 15_000) { knownAt = now; saveKnown() } }

    fun saveKnown() {
        val b = _band.value; val file = knownFile(b) ?: return
        val k = runCatching { engineOf(b).save() }.getOrNull() ?: return
        Thread { runCatching { val tmp = File(file.path + ".tmp"); tmp.writeText(k.toJson()); tmp.renameTo(file) } }.start()
    }
    private fun loadKnown(b: GmrsBand): HpSaved? = runCatching { knownFile(b)?.takeIf { it.exists() }?.readText()?.let { HpSaved.fromJson(it) } }.getOrNull()
    /** CLEAR forgets what was heard on the band shown, and what was kept of it. */
    fun clear() { engine.clear(); runCatching { knownFile(_band.value)?.delete() } }
}
