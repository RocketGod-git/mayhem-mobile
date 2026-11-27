package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.fleet.AutoCall
import com.rocketgod.mayhem.core.fleet.AutoSaved
import com.rocketgod.mayhem.core.fleet.AutoView
import com.rocketgod.mayhem.core.fleet.FleetAuto
import com.rocketgod.mayhem.core.fleet.FleetProcessor
import com.rocketgod.mayhem.core.fleet.FleetSnap
import com.rocketgod.mayhem.core.fleet.KnownState
import com.rocketgod.mayhem.core.fleet.Lock
import com.rocketgod.mayhem.core.fleet.SystemRow
import com.rocketgod.mayhem.core.fleet.TgPrefs
import com.rocketgod.mayhem.core.fleet.hx
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Dispatch on the phone: what the screen and the scan share around the [FleetProcessor]. The talkgroup preferences
 * (mute, hold, priority) and the system lock, the live audio switch and level, AUTO's band choice (scored by the clear
 * voice heard on each window, [FleetAuto]), the short looks at bands where units report positions, following a call
 * outside the span on a one-channel receiver, and what is kept on the phone between sessions (systems, unit
 * positions, band scores). The storage keys keep the app's internal id, "fleet".
 */
object Dispatch {
    private const val PREFS = "mayhem"
    private const val K_PREFS = "fleet.tgprefs"
    private const val K_LOCK = "fleet.lock"
    /** A fresh key: audio is on by default, and a switch saved off under the old key does not carry over. */
    private const val K_AUDIO = "fleet.audio.v2"
    private const val K_AUTO = "fleet.auto"
    private var ctx: Context? = null
    private var knownFile: File? = null

    private val _prefs = MutableStateFlow(TgPrefs())
    /** Mute, hold and priority by talkgroup key ("sys/tg", "sys/uN" for a unit). */
    val prefs: StateFlow<TgPrefs> = _prefs.asStateFlow()
    private val _lock = MutableStateFlow<Lock?>(null)
    /** The system (or site) locked on; null is ALL. */
    val lock: StateFlow<Lock?> = _lock.asStateFlow()
    private val _audioOn = MutableStateFlow(true)
    val audioOn: StateFlow<Boolean> = _audioOn.asStateFlow()
    private val _gain = MutableStateFlow(0.8)
    val gain: StateFlow<Double> = _gain.asStateFlow()

    /** A call followed outside the span, the center to come back to, and the last resort to come back by. */
    data class Following(val key: String, val home: Long, val until: Long)
    private val _following = MutableStateFlow<Following?>(null)
    val following: StateFlow<Following?> = _following.asStateFlow()
    /** A short look at a band where a position-reporting system lives. */
    data class Visit(val home: Long, val until: Long, val sys: String)
    private val _visit = MutableStateFlow<Visit?>(null)
    val visit: StateFlow<Visit?> = _visit.asStateFlow()
    private var lastVisit = 0L
    private var knownAt = 0L

    /** AUTO's choice of window, and the windows it was made for. */
    @Volatile var auto: FleetAuto? = null; private set
    private var autoSig = ""; private var autoSaved = 0L

    fun init(c: Context) {
        ctx = c.applicationContext
        knownFile = File(c.filesDir, "fleet_known.json")
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        runCatching {
            val v = JSONObject(p.getString(K_PREFS, null) ?: "")
            _prefs.value = TgPrefs(strs(v.optJSONArray("mute")), v.optString("hold"), strs(v.optJSONArray("prio")))
        }
        runCatching {
            val v = JSONObject(p.getString(K_LOCK, null) ?: "")
            val sys = v.optString("sys")
            if (sys.isNotEmpty()) _lock.value = Lock(sys, v.optString("site"), v.optString("label", sys), v.optLong("hz"))
        }
        runCatching {
            val v = JSONObject(p.getString(K_AUDIO, null) ?: "")
            _audioOn.value = v.optBoolean("on", true); _gain.value = v.optDouble("gain", 0.8).takeIf { it.isFinite() && it > 0 } ?: 0.8
        }
    }
    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }
    private fun put(k: String, v: String?) { ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.apply { if (v == null) remove(k) else putString(k, v) }?.apply() }

    /** What the processor is told: the talkgroup preferences and the lock. */
    private fun prefsMsg() = _prefs.value.copy(lock = _lock.value)
    private fun pushPrefs(f: FleetProcessor) = f.setPrefs(prefsMsg())

    /** Toggles mute or priority on a talkgroup, or holds it (one at a time). */
    fun pref(kind: String, key: String) {
        val p = _prefs.value
        val next = when (kind) {
            "hold" -> p.copy(hold = if (p.hold == key) "" else key)
            "mute" -> p.copy(mute = if (key in p.mute) p.mute - key else p.mute + key)
            else -> p.copy(prio = if (key in p.prio) p.prio - key else p.prio + key)
        }
        _prefs.value = next
        put(K_PREFS, JSONObject().put("mute", JSONArray(next.mute)).put("hold", next.hold).put("prio", JSONArray(next.prio)).toString())
        pushPrefs(Apps.fleet)
    }
    /** A tap on the talkgroup grid: follow that talkgroup (only it is heard), or back to ALL with "". The follow is the hold. */
    fun followTalkgroup(key: String) {
        val next = com.rocketgod.mayhem.core.fleet.DispatchView.followTap(_prefs.value.hold, key)
        if (next != _prefs.value.hold) pref("hold", if (next.isEmpty()) _prefs.value.hold else next)
    }
    fun setAudio(on: Boolean, gain: Double = _gain.value) {
        _audioOn.value = on; _gain.value = gain.coerceIn(0.0, 1.5)
        put(K_AUDIO, JSONObject().put("on", on).put("gain", _gain.value).toString())
        Apps.fleet.setAudio(on, _gain.value)
    }
    /** Plays a call's kept audio again. */
    fun replay(key: String) { Thread { Apps.fleet.replay(key) { out.push(it) } }.start() }

    /** The short system title, the way its card names it. */
    fun sysTitle(x: SystemRow): String = when {
        x.proto == "DPMR" -> "dPMR CC ${x.cc}"
        x.proto == "SMARTNET" -> "TYPE II SYS ${hx(x.sysId, 4)}"
        x.proto == "NXDN" && x.trunk == "CONVENTIONAL" -> "NXDN RAN ${x.sysId}"
        x.proto == "NXDN" && x.trunk == "TYPE-D" -> "TYPE-D SITE ${x.sysId}"
        x.proto == "NXDN" -> "${x.model} SYS ${x.sysId}"
        x.proto == "TETRA" -> "MCC ${x.wacn} · MNC ${x.sysId}"
        x.proto == "P25" -> "WACN ${hx(x.wacn, 5)} · SYS ${hx(x.sysId, 3)}"
        x.net >= 0 -> "${x.model} NET ${x.net}"
        x.trunk == "CAPACITY PLUS" -> "CAP+ CC ${x.cc}"
        else -> "CC ${x.cc}${if (x.fid > 0) " · FID ${hx(x.fid, 2)}" else ""}"
    }
    /** A lock for a system (and a site), named the way its card names it, with its control channel to come back to. */
    fun lockFor(sysKey: String, siteLabel: String = ""): Lock? {
        val x = Apps.fleet.snap.value?.systems?.firstOrNull { it.key == sysKey } ?: return null
        val site = if (siteLabel.isNotEmpty()) x.sites.firstOrNull { it.label == siteLabel } else x.sites.firstOrNull()
        val hz = site?.ccHz?.firstOrNull() ?: x.sites.firstOrNull { it.ccHz.isNotEmpty() }?.ccHz?.firstOrNull() ?: 0L
        return Lock(x.key, siteLabel, "${sysTitle(x)}${if (siteLabel.isNotEmpty()) " · SITE $siteLabel" else ""}", hz)
    }
    /** Lock on one system (or one of its sites), or back to ALL with null. Tunes to the locked system when it is out of the span. */
    fun setLock(l: Lock?) {
        _lock.value = l
        put(K_LOCK, l?.let { JSONObject().put("sys", it.sys).put("site", it.site).put("label", it.label).put("hz", it.hz).toString() })
        pushPrefs(Apps.fleet)
        if (l != null) tuneLock()
        dwell()
    }
    /** LOCK from the mode switch: the system picked, else the one being heard, else one on the air, else the busiest. */
    fun lockSomething(selectedSys: String?): Boolean {
        if (_lock.value != null) return true
        val s = Apps.fleet.snap.value; val now = System.currentTimeMillis()
        val playing = s?.calls?.firstOrNull { it.key == s.playing }
        val sys = selectedSys?.takeIf { it.isNotEmpty() } ?: playing?.sys?.takeIf { it.isNotEmpty() } ?: s?.calls?.firstOrNull { it.onAir && it.sys.isNotEmpty() }?.sys
            ?: s?.systems?.filter { now - it.lastMs < 15_000 }?.maxByOrNull { it.grants }?.key ?: ""
        val l = if (sys.isNotEmpty()) lockFor(sys) else null
        if (l != null) setLock(l)
        return l != null
    }

    // ------------------------------------------------------------------------------------------------ the scan
    data class Scan(val windows: List<FleetProcessor.Window> = emptyList(), val idx: Int = 0, val dwellEnd: Long = 0L, val found: Boolean = false)
    private val _scan = MutableStateFlow(Scan())
    val scan: StateFlow<Scan> = _scan.asStateFlow()

    /** The Dispatch app opened (or its band or span changed): the windows, the prefs, the kept state, the lock, the audio. */
    fun open(windows: List<FleetProcessor.Window>, rate: Int, restore: Boolean) {
        val f = Apps.fleet
        _scan.value = Scan(windows, 0, System.currentTimeMillis() + 6_000, false)
        _following.value = null
        pushPrefs(f)
        if (restore) loadKnown()?.let { f.restore(it) }
        _visit.value = null; lastVisit = System.currentTimeMillis() - 60_000
        // a saved lock starts on the window holding the locked system's control channel
        val lk = _lock.value
        if (lk != null && lk.hz != 0L) { val half = rate * 0.4; val i = windows.indexOfFirst { abs(it.hz - lk.hz) < half }; if (i > 0) { _scan.value = _scan.value.copy(idx = i); SdrEngine.tune(windows[i].hz) } }
        f.audioOut = { out.push(it) }
        f.setAudio(_audioOn.value, _gain.value)
        dwell()
    }
    /** Steps to window [idx] (a band picked anew starts at 0). */
    fun restart(windows: List<FleetProcessor.Window>) {
        _scan.value = Scan(windows, 0, System.currentTimeMillis() + 6_000, false)
        if (windows.isNotEmpty()) SdrEngine.tune(windows[0].hz)
        dwell()
    }
    private fun sig(windows: List<FleetProcessor.Window>) = "${Apps.fleetBand.value}|${windows.joinToString(",") { "${it.hz}" }}"
    /** AUTO for these windows: kept when they are the same, else made anew from the saved scores. */
    private fun dwell() {
        val sc = _scan.value; val now = System.currentTimeMillis()
        _scan.value = sc.copy(found = false, dwellEnd = now + 6_000)
        val sig = sig(sc.windows)
        val a = auto
        if (a == null || autoSig != sig) {
            autoSig = sig
            val na = FleetAuto(sc.windows.size, now, sc.idx, loadAuto(sig)); auto = na
            // a reload with a known best band starts on it
            if (_lock.value == null && na.idx != sc.idx && na.idx in sc.windows.indices) { _scan.value = _scan.value.copy(idx = na.idx); SdrEngine.tune(sc.windows[na.idx].hz) }
        } else a.moved(sc.idx, now)
    }
    private fun tune(hz: Long) = SdrEngine.tune(hz)
    /** Brings the locked system's control channel into the span, if it is not there. */
    private fun tuneLock() {
        val l = _lock.value ?: return; if (l.hz == 0L) return
        val s = Apps.fleet.snap.value
        if (s != null && l.hz > s.spanLo + 20_000 && l.hz < s.spanHi - 20_000) return
        val half = Apps.fleetRate() * 0.4; val sc = _scan.value
        val w = sc.windows.withIndex().map { it.index to abs(it.value.hz - l.hz) }.filter { it.second < half }.minByOrNull { it.second }
        _following.value = null
        if (w != null) { _scan.value = sc.copy(idx = w.first); tune(sc.windows[w.first].hz) } else tune(l.hz)
    }
    /**
     * Every two minutes in AUTO, a look of 18 s at a band where a system with unit positions was heard and the span does
     * not reach, so its positions stay fresh; never on a band the listener picked, never while locked, and never while the
     * call being heard is on the air.
     */
    private fun visitDue(s: FleetSnap, now: Long): Boolean {
        // only AUTO leaves its band to check positions: a band the listener tapped holds, and LOCK never leaves its system
        if (_lock.value != null || Apps.fleetBand.value != "AUTO" || now - lastVisit < 120_000) return false
        if (_audioOn.value && s.calls.any { it.key == s.playing && it.onAir }) return false
        // a look away only when nothing clear has played for a while
        val a = auto; if (a != null && now - a.lastClear < 15_000) return false
        fun out(hz: Long) = hz < s.spanLo + 20_000 || hz > s.spanHi - 20_000
        val target = s.systems.filter { it.positions && it.heardHz.isNotEmpty() && it.heardHz.all { h -> out(h) } }.minByOrNull { it.lastMs }
        if (target == null) { lastVisit = now; return false }
        val span = s.spanHi - s.spanLo
        _visit.value = Visit(s.centerHz, now + 18_000, target.key)
        tune((target.heardHz[0] + span * 0.2).roundToLong())
        return true
    }
    /** One receiver, one channel: a call outside the span is followed there, and the radio comes back when it ends. */
    private fun follow(s: FleetSnap, now: Long) {
        val f = _following.value
        if (f != null) {
            val c = s.calls.firstOrNull { it.key == f.key }
            if (c == null || !c.onAir || now > f.until) { _following.value = null; tune(f.home) }
            return
        }
        val t = s.follow ?: return
        if (!_audioOn.value) return
        val span = s.spanHi - s.spanLo; val home = s.centerHz; val lk = _lock.value
        val cc = s.carriers.firstOrNull { it.role == "control" && it.hz > s.spanLo && it.hz < s.spanHi && (lk == null || it.sys == lk.sys) }
        val center = if (cc != null && abs(t.hz - cc.hz) < span * 0.8) (t.hz + cc.hz) / 2 else (t.hz + span * 0.2).roundToLong()
        // the radio stays with the call as long as it is on the air (its own end of transmission brings it back), with ten
        // minutes as a last resort
        _following.value = Following(t.key, home, now + 600_000)
        tune(center)
    }

    /** Every half second while Dispatch is open: following, visits, the lock, AUTO, and keeping what was heard. */
    fun tick(now: Long) {
        val f = Apps.fleet; val s = f.snap.value
        if (now - knownAt > 15_000) { knownAt = now; saveKnown() }
        if (s != null) follow(s, now)
        val sc = _scan.value
        if (_following.value != null) { _scan.value = sc.copy(dwellEnd = max(sc.dwellEnd, now + 6_000)); return }
        // a look at a band where units report positions: back home when it is over
        val v = _visit.value
        if (v != null) { if (now >= v.until) { tune(v.home); _visit.value = null; lastVisit = now; _scan.value = sc.copy(dwellEnd = max(sc.dwellEnd, now + 6_000)) }; return }
        if (s != null && visitDue(s, now)) return
        // locked: the receiver stays with the locked system (and goes back to it if something moved it)
        val lk = _lock.value
        if (lk != null) {
            _scan.value = sc.copy(found = true, dwellEnd = now + 6_000)
            if (s != null && lk.hz != 0L && (lk.hz < s.spanLo || lk.hz > s.spanHi)) tuneLock()
            return
        }
        val live = s != null && s.carriers.any { (it.role == "control" || it.role == "rest") && it.hz > s.spanLo && it.hz < s.spanHi && now - it.lastDecodeMs < 5_000 }
        // AUTO holds the window where clear voice is heard, looks elsewhere now and then, and scans while nothing has earned it
        val a = auto
        if (a != null && s != null) {
            val to = a.step(AutoView(now, s.calls.map { AutoCall(it.key, it.onAir, it.encrypted, it.tg, it.audioMs) }, if (_audioOn.value) s.playing else "", live, s.systems.size))
            var next = sc.copy(found = a.mode != "scan" || a.found, dwellEnd = if (a.mode == "hold") now + 6_000 else a.until)
            if (to != null && to != next.idx && to in next.windows.indices) { next = next.copy(idx = to); tune(next.windows[to].hz) }
            _scan.value = next
            saveAuto(now)
        }
    }
    /** What the head line says the scan is doing. */
    fun scanText(now: Long): String {
        val sc = _scan.value; val v = _visit.value; val a = auto
        fun left(t: Long) = max(0L, (t - now + 999) / 1000)
        val autoBand = Apps.fleetBand.value == "AUTO"
        return when {
            v != null -> "CHECKING POSITIONS · BACK IN ${left(v.until)} s"
            _lock.value != null -> "LOCKED"
            sc.windows.size > 1 -> when (a?.mode) {
                "hold" -> "${if (autoBand) "AUTO" else "SCAN"} · HOLDING WHERE THE VOICE IS"
                "survey" -> "AUTO · FIRST PASS · ${sc.idx + 1}/${sc.windows.size} · NEXT ${left(sc.dwellEnd)} s"
                "look" -> "LOOKING AROUND · BACK IN ${left(sc.dwellEnd)} s"
                else -> "${if (autoBand) "AUTO SCAN" else "SCAN"} · ${sc.idx + 1}/${sc.windows.size} · ${if (sc.found) "STAYING" else "NEXT"} ${left(sc.dwellEnd)} s"
            }
            else -> "HOLDING"
        }
    }

    // ------------------------------------------------------------------------------------------------ kept on the phone
    /** Systems and unit positions: every position ever decoded stays on the map. */
    fun saveKnown() {
        val file = knownFile ?: return
        val k = runCatching { Apps.fleet.known() }.getOrNull() ?: return
        if (k.systems.isEmpty() && k.units.isEmpty()) return
        Thread { runCatching { val tmp = File(file.path + ".tmp"); tmp.writeText(k.toJson().toString()); tmp.renameTo(file) } }.start()
    }
    private fun loadKnown(): KnownState? = runCatching { knownFile?.takeIf { it.exists() }?.readText()?.let { KnownState.fromJson(JSONObject(it)) } }.getOrNull()
    /** CLEAR forgets what was kept too. */
    fun forget() { runCatching { knownFile?.delete() } }
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

    // ------------------------------------------------------------------------------------------------ the speaker
    /** Dispatch's audio to the radio's own speaker path: 48 kHz mono, handed over after each buffer. */
    val out = AudioRing(48_000 * 4)
    class AudioRing(cap: Int) {
        private val buf = FloatArray(cap); private var r = 0; private var w = 0; private var n = 0
        @Synchronized fun push(x: FloatArray) {
            for (v in x) { buf[w] = v; w = (w + 1) % buf.size; if (n < buf.size) n++ else r = (r + 1) % buf.size }
        }
        @Synchronized fun drain(dst: FloatArray, max: Int): Int {
            val k = minOf(max, n, dst.size)
            for (i in 0 until k) { dst[i] = buf[r]; r = (r + 1) % buf.size }
            n -= k; return k
        }
        @Synchronized fun clear() { r = 0; w = 0; n = 0 }
    }
    /** The processor the radio runs for Dispatch: the [FleetProcessor] with its audio on the speaker. */
    class WithSpeaker(private val f: FleetProcessor) : IqProcessor by f {
        override val producesAudio: Boolean get() = true
        override fun drainAudio(dst: FloatArray, max: Int): Int = out.drain(dst, max)
        override val pacedAudio: Boolean get() = true
    }
}
