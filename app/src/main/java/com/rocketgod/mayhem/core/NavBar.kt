package com.rocketgod.mayhem.core

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The bottom bar: every app in one order the user drags, and the ones they ticked, which are what the bar shows
 * after HOME. Also where Mayhem opens (Home, or the last app used). Kept in the same preferences as the skin.
 */
object NavBar {
    private const val PREFS = "mayhem"
    private const val KEY_ORDER = "nav_order"
    private const val KEY_CHECKED = "nav_checked"
    private const val KEY_OPENS_LAST = "nav_opens_last"
    private const val KEY_LAST = "nav_last"
    private const val KEY_BIAS_OK = "bias_ok"

    /** What a fresh install's bar holds: the receivers people reach for first. */
    val STARTER = listOf(MayhemApp.AUDIO, MayhemApp.PAGER, MayhemApp.ADSB, MayhemApp.HAM, MayhemApp.DEVICES, MayhemApp.LOOKING_GLASS)

    /** Every app the bar can hold: all of them but Settings (it has its own button), and Troll only where it ships. */
    fun all(): List<MayhemApp> = MayhemApp.entries.filter {
        it != MayhemApp.SETTINGS && (it != MayhemApp.TROLL || com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL)
    }

    private val _order = MutableStateFlow(defaultOrder())
    /** Every app, in the order the user set. */
    val order: StateFlow<List<MayhemApp>> = _order.asStateFlow()
    private val _checked = MutableStateFlow(STARTER.toSet())
    val checked: StateFlow<Set<MayhemApp>> = _checked.asStateFlow()
    private val _bar = MutableStateFlow(STARTER)
    /** The ticked apps, in order: what the bar shows after HOME. */
    val bar: StateFlow<List<MayhemApp>> = _bar.asStateFlow()
    private val _opensOnLast = MutableStateFlow(false)
    val opensOnLast: StateFlow<Boolean> = _opensOnLast.asStateFlow()
    /** The bias-tee warning has been read and accepted once; from then on the switch is just a switch. */
    @Volatile var biasOk = false; private set

    private var ctx: Context? = null

    private fun defaultOrder() = STARTER + all().filter { it !in STARTER }

    fun load(c: Context) {
        ctx = c.applicationContext
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val known = all()
        val saved = p.getString(KEY_ORDER, null)?.split(",")?.mapNotNull { n -> known.firstOrNull { it.name == n.trim() } }?.distinct()
        // an app added in an update, not yet in the saved order, keeps its default place at the end
        _order.value = if (saved.isNullOrEmpty()) defaultOrder() else saved + known.filter { it !in saved }
        p.getString(KEY_CHECKED, null)?.let { s -> _checked.value = s.split(",").mapNotNull { n -> known.firstOrNull { it.name == n.trim() } }.toSet() }
        _opensOnLast.value = p.getBoolean(KEY_OPENS_LAST, false)
        biasOk = p.getBoolean(KEY_BIAS_OK, false)
        sync(save = false)
    }

    fun toggle(app: MayhemApp) {
        if (app !in all()) return
        _checked.value = if (app in _checked.value) _checked.value - app else _checked.value + app
        sync()
    }

    fun move(from: Int, to: Int) {
        val l = _order.value.toMutableList()
        if (from !in l.indices || to !in l.indices || from == to) return
        l.add(to, l.removeAt(from))
        _order.value = l
        sync()
    }

    fun setOpensOnLast(on: Boolean) {
        _opensOnLast.value = on
        prefs()?.edit()?.putBoolean(KEY_OPENS_LAST, on)?.apply()
    }

    fun acceptBias() { biasOk = true; prefs()?.edit()?.putBoolean(KEY_BIAS_OK, true)?.apply() }

    /** Remember the app last opened, for "opens on: last app". Settings is never the one remembered. */
    fun noteOpened(app: MayhemApp) {
        if (app == MayhemApp.SETTINGS) return
        prefs()?.edit()?.putString(KEY_LAST, app.name)?.apply()
    }

    fun lastApp(): MayhemApp? = prefs()?.getString(KEY_LAST, null)?.let { n -> all().firstOrNull { it.name == n } }

    private fun prefs() = ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun sync(save: Boolean = true) {
        _bar.value = _order.value.filter { it in _checked.value }
        if (save) prefs()?.edit()
            ?.putString(KEY_ORDER, _order.value.joinToString(",") { it.name })
            ?.putString(KEY_CHECKED, _checked.value.joinToString(",") { it.name })
            ?.apply()
    }
}
