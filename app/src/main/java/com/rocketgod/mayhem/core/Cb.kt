package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.cb.CB_CENTER
import com.rocketgod.mayhem.core.cb.CbEngine
import com.rocketgod.mayhem.core.cb.CbMode
import com.rocketgod.mayhem.core.cb.CbPrefs
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpPrefs
import com.rocketgod.mayhem.core.hamplus.HpSaved
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * CB on the phone: what the screen shares around the [CbEngine]. The per-channel preferences (follow, mute, priority),
 * the mode set by hand and the SSB clarifier per channel, the talker names the listener gives, the listen mode and the
 * volume, and what is kept between sessions (channels, talkers and the activity map). One span hears all 40 channels:
 * 27.195 MHz at 2 MS/s on a HackRF, 2.4 MS/s on an RTL-SDR, so nothing moves the radio.
 */
object Cb {
    private const val PREFS = "mayhem"
    private const val K_PREFS = "cb.prefs"
    private const val K_LABELS = "cb.labels"
    private const val K_AUDIO = "cb.audio"
    private const val K_MODES = "cb.modes"
    /** The clarifier steps a tap moves it by, and how far it goes either way (Hz). */
    const val CLAR_STEP = 50
    const val CLAR_MAX = 1_500

    val engine = CbEngine()
    /** The frame's log (CB writes its lines to the debug log; this one stays empty). */
    val log = PacketLog()
    private var ctx: Context? = null
    private var knownFile: File? = null

    private val _prefs = MutableStateFlow(HpPrefs())
    val prefs: StateFlow<HpPrefs> = _prefs.asStateFlow()
    private val _labels = MutableStateFlow<Map<String, String>>(emptyMap())
    val labels: StateFlow<Map<String, String>> = _labels.asStateFlow()
    private val _cbPrefs = MutableStateFlow(CbPrefs())
    val cbPrefs: StateFlow<CbPrefs> = _cbPrefs.asStateFlow()
    private val _mode = MutableStateFlow(HpParams.Mode.MIX)
    val mode: StateFlow<HpParams.Mode> = _mode.asStateFlow()
    private val _audioOn = MutableStateFlow(true)
    val audioOn: StateFlow<Boolean> = _audioOn.asStateFlow()
    private val _gain = MutableStateFlow(1.0)
    val gain: StateFlow<Double> = _gain.asStateFlow()
    private var knownAt = 0L

    fun init(c: Context) {
        ctx = c.applicationContext
        knownFile = File(c.filesDir, "cb_known1.json")
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        runCatching { val v = JSONObject(p.getString(K_PREFS, null) ?: ""); _prefs.value = HpPrefs(v.optString("hold"), strs(v.optJSONArray("mute")), strs(v.optJSONArray("prio"))) }
        runCatching { val v = JSONObject(p.getString(K_LABELS, null) ?: ""); _labels.value = v.keys().asSequence().associateWith { v.optString(it) } }
        runCatching {
            val v = JSONObject(p.getString(K_AUDIO, null) ?: "")
            _audioOn.value = v.optBoolean("on", true); _gain.value = v.optDouble("gain", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0
            _mode.value = if (v.optString("mode") == "newest") HpParams.Mode.NEWEST else HpParams.Mode.MIX
        }
        runCatching {
            val v = JSONObject(p.getString(K_MODES, null) ?: "")
            val m = v.optJSONObject("modes"); val cl = v.optJSONObject("clar")
            _cbPrefs.value = CbPrefs(
                m?.keys()?.asSequence()?.mapNotNull { k -> CbMode.entries.firstOrNull { it.name == m.optString(k) }?.let { k to it } }?.toMap().orEmpty(),
                cl?.keys()?.asSequence()?.map { k -> k to cl.optInt(k) }?.filter { it.second != 0 }?.toMap().orEmpty())
        }
    }
    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
    private fun put(k: String, v: String?) { ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.apply { if (v == null) remove(k) else putString(k, v) }?.apply() }

    private fun pushPrefs() { engine.setPrefs(_prefs.value, _labels.value); engine.setCbPrefs(_cbPrefs.value) }
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
    /** A channel's mode set by hand, or null for AUTO (the mode measured on each transmission). */
    fun setChanMode(key: String, m: CbMode?) {
        val p = _cbPrefs.value
        _cbPrefs.value = p.copy(modes = if (m == null) p.modes - key else p.modes + (key to m))
        saveModes(); pushPrefs()
    }
    /** Moves a channel's SSB clarifier by [step] Hz (within ±[CLAR_MAX]); 0 centers it. */
    fun clarify(key: String, step: Int) {
        val p = _cbPrefs.value
        val v = if (step == 0) 0 else ((p.clar[key] ?: 0) + step).coerceIn(-CLAR_MAX, CLAR_MAX)
        _cbPrefs.value = p.copy(clar = if (v == 0) p.clar - key else p.clar + (key to v))
        saveModes(); pushPrefs()
    }
    private fun saveModes() {
        val p = _cbPrefs.value
        put(K_MODES, JSONObject().put("modes", JSONObject(p.modes.mapValues { it.value.name } as Map<*, *>)).put("clar", JSONObject(p.clar as Map<*, *>)).toString())
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

    /** One span hears all 40: an RTL-SDR at 2.4 MS/s, a HackRF at 2. */
    fun rate(): Int = if (Radio.kind.value == Radio.Kind.RTLSDR && Radio.canSample(Radio.limits, 2_400_000)) 2_400_000
        else if (Radio.canSample(Radio.limits, 2_000_000)) 2_000_000 else 2_400_000

    /** The app opened: the radio on 27.195 MHz, the prefs, the kept state, the audio. */
    fun open() {
        engine.centerHz = CB_CENTER
        SdrEngine.configure(SdrEngine.Mode.NONE, CB_CENTER, rate(), 32, 40, true, engine)
        pushPrefs(); pushParams()
        loadKnown()?.let { engine.restore(it) }
    }

    /** Every half second while CB is open: what was heard is kept now and then. */
    fun tick(now: Long) { if (now - knownAt > 15_000) { knownAt = now; saveKnown() } }

    fun saveKnown() {
        val file = knownFile ?: return
        val k = runCatching { engine.save() }.getOrNull() ?: return
        Thread { runCatching { val tmp = File(file.path + ".tmp"); tmp.writeText(k.toJson()); tmp.renameTo(file) } }.start()
    }
    private fun loadKnown(): HpSaved? = runCatching { knownFile?.takeIf { it.exists() }?.readText()?.let { HpSaved.fromJson(it) } }.getOrNull()
    /** CLEAR forgets what was heard, and what was kept. */
    fun clear() { engine.clear(); runCatching { knownFile?.delete() } }
}
