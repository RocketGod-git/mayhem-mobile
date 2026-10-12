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

data class Bookmark(val name: String, val hz: Long, val mode: SdrEngine.Mode)

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
                Bookmark(o.getString("name"), o.getLong("hz"), runCatching { SdrEngine.Mode.valueOf(o.getString("mode")) }.getOrDefault(SdrEngine.Mode.NFM))
            }
        }.getOrDefault(emptyList())
    }

    private fun save() {
        val arr = JSONArray()
        for (b in _list.value) arr.put(JSONObject().put("name", b.name).put("hz", b.hz).put("mode", b.mode.name))
        ctx?.getSharedPreferences("mayhem", Context.MODE_PRIVATE)?.edit()?.putString("bookmarks", arr.toString())?.apply()
    }

    fun add(name: String, hz: Long, mode: SdrEngine.Mode) {
        _list.value = _list.value.filter { it.hz != hz || it.mode != mode } + Bookmark(name.trim().ifEmpty { "%.4f %s".format(hz / 1e6, mode.name) }, hz, mode)
        save()
    }

    fun remove(b: Bookmark) { _list.value = _list.value.filter { it != b }; save() }

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
