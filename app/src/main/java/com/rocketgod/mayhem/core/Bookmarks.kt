package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.Diag
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.Timer
import java.util.TimerTask

/**
 * A saved channel. One saved with the star also remembers how it was heard: the app, the gain stages and AGC, the
 * squelch, and for HAM its own receiver ([ham], whatever the HAM screen chose to keep), so recalling it brings the
 * whole set-up back, not just the frequency.
 */
data class Bookmark(
    val name: String, val hz: Long, val mode: SdrEngine.Mode,
    val app: String? = null, val gains: List<Int>? = null, val squelch: Int? = null, val ham: JSONObject? = null,
)

/** Saved frequencies (Mayhem's frequency manager, the phone way): a JSON list in SharedPreferences. */
object Bookmarks {
    private val _list = MutableStateFlow<List<Bookmark>>(emptyList())
    val list: StateFlow<List<Bookmark>> = _list.asStateFlow()
    private var ctx: Context? = null

    fun load(context: Context) {
        ctx = context.applicationContext
        val raw = context.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getString("bookmarks", null) ?: return
        _list.value = runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Bookmark(o.getString("name"), o.getLong("hz"), runCatching { SdrEngine.Mode.valueOf(o.getString("mode")) }.getOrDefault(SdrEngine.Mode.NFM),
                    o.optString("app").ifEmpty { null },
                    o.optJSONArray("gains")?.let { g -> (0 until g.length()).map { g.getInt(it) } }?.takeIf { it.size == 4 },
                    if (o.has("squelch")) o.getInt("squelch") else null,
                    o.optJSONObject("ham"))
            }
        }.getOrDefault(emptyList())
    }

    private fun save() {
        val arr = JSONArray()
        for (b in _list.value) arr.put(JSONObject().put("name", b.name).put("hz", b.hz).put("mode", b.mode.name).apply {
            b.app?.let { put("app", it) }
            b.gains?.let { put("gains", JSONArray(it)) }
            b.squelch?.let { put("squelch", it) }
            b.ham?.let { put("ham", it) }
        })
        ctx?.getSharedPreferences("mayhem", Context.MODE_PRIVATE)?.edit()?.putString("bookmarks", arr.toString())?.apply()
    }

    fun add(name: String, hz: Long, mode: SdrEngine.Mode) {
        _list.value = _list.value.filter { it.hz != hz || it.mode != mode } + Bookmark(name.trim().ifEmpty { "%.4f %s".format(hz / 1e6, mode.name) }, hz, mode)
        save()
    }

    fun remove(b: Bookmark) { _list.value = _list.value.filter { it != b }; save() }

    /** The favourite at [hz], if there is one. */
    fun at(hz: Long): Bookmark? = _list.value.firstOrNull { kotlin.math.abs(it.hz - hz) < 50 }

    /** ★: save where you are and how you are listening, or drop it if it is already saved. */
    fun star(hz: Long, mode: SdrEngine.Mode, label: String = mode.name, ham: JSONObject? = null) {
        at(hz)?.let { remove(it); Diag.log("removed %.4f from favorites".format(hz / 1e6)); return }
        val app = Apps.playing() ?: MayhemApp.AUDIO
        val b = Bookmark("%.4f %s".format(hz / 1e6, if (mode == SdrEngine.Mode.NONE && ham == null) "" else label).trim(), hz, mode, app.name,
            listOf(SdrEngine.radioLna.value, SdrEngine.radioVga.value, if (SdrEngine.radioAmp.value) 1 else 0, if (SdrEngine.agc.value) 1 else 0),
            SdrEngine.squelchDb.value, ham)
        _list.value = _list.value.filter { kotlin.math.abs(it.hz - hz) >= 50 } + b
        save()
        Diag.log("saved ${b.name} to favorites")
    }

    /** Where the HAM screen restores its own part of a favourite; set by HAM, which owns those settings. */
    @Volatile var hamRecall: ((Bookmark) -> Unit)? = null

    /** Recall a favourite the way it was heard: the right app, its gain and squelch, then the frequency. */
    fun open(b: Bookmark) {
        val app = b.app?.let { runCatching { MayhemApp.valueOf(it) }.getOrNull() }
        if (app != null && app != Apps.current.value) Apps.open(app)
        b.gains?.let { g -> SdrEngine.applyGains(g[0], g[1], g[2] == 1, g[3] == 1) }
        if (app == MayhemApp.HAM && b.ham != null) { hamRecall?.invoke(b); return }
        b.squelch?.let { SdrEngine.setSquelch(it) }
        go(b)
    }

    fun go(b: Bookmark) { SdrEngine.setMode(b.mode); SdrEngine.tune(b.hz) }
}

/**
 * Scanner (Mayhem's Scanner app, on your bookmark list): hops through the bookmarks every few hundred ms, holding
 * on any channel where the squelch opens and moving on once it closes again. Forces a 12 dB squelch if none is set.
 */
object Scanner {
    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()
    private var timer: Timer? = null
    private var idx = 0
    private var hopAt = 0L

    fun toggle() = set(!_active.value)

    fun set(on: Boolean) {
        val list = Bookmarks.list.value
        if (on && list.size < 2) { Diag.log("scan needs at least two bookmarks — save some first"); stop(); return }
        if (!on) { stop(); return }
        if (_active.value) return
        if (SdrEngine.squelchDb.value == 0) SdrEngine.setSquelch(12)
        idx = list.indexOfFirst { it.hz == SdrEngine.freqHz.value }.coerceAtLeast(0)
        hopAt = System.currentTimeMillis()
        _active.value = true
        timer = Timer("scan", true).apply {
            schedule(object : TimerTask() {
                override fun run() {
                    if (Apps.current.value != MayhemApp.AUDIO) { stop(); return }
                    val now = System.currentTimeMillis()
                    if (now - hopAt < 250) return                       // let the tuner and the floor tracker settle
                    if (SdrEngine.squelchOpen.value) return             // busy channel: stay until it goes quiet
                    val l = Bookmarks.list.value
                    if (l.size < 2) { stop(); return }
                    idx = (idx + 1) % l.size
                    Bookmarks.go(l[idx]); hopAt = now
                }
            }, 100L, 100L)
        }
    }

    fun stop() {
        timer?.cancel(); timer = null
        _active.value = false
    }
}
