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
    private const val KEY_KNOWN = "nav_known"
    private const val KEY_REORDERED = "nav_order_0958"
    /** Apps added after the bar first saved its choices (a bar saved before this list existed knew all but these). */
    private val ADDED = listOf(MayhemApp.LORA)
    /**
     * The bar's default order before the apps were regrouped by what people listen for, by name. A saved order
     * still in exactly this order was never dragged, so it moves to the new default; one the user arranged stays theirs.
     */
    private val OLD_DEFAULT = listOf("HAM", "JS8", "AUDIO", "HD", "DEVICES", "SAT", "ADSB", "UAT", "AIS", "APRS", "PAGER", "ERT",
        "LORA", "BTLE", "VDL2", "ACARS", "TRAINS", "FLEET", "CELL", "ATSC", "SONDES", "PROWL", "SPECTRUM", "ANALYZER", "LOOKING_GLASS",
        "SEARCH", "TRANSMIT", "TROLL", "CAPTURE")

    /** The default order of 0.9.39 to 0.9.41, before the flight apps were grouped (a bar still in it takes the new one). */
    private val PREV_DEFAULT = listOf("AUDIO", "HD", "FLEET", "PAGER", "LORA", "ADSB", "CELL", "DEVICES", "UAT", "JS8", "HAM", "APRS", "ERT",
        "TRAINS", "BTLE", "ACARS", "VDL2", "AIS", "SAT", "SONDES", "ATSC", "PROWL", "SPECTRUM", "ANALYZER", "LOOKING_GLASS", "SEARCH",
        "TRANSMIT", "TROLL", "CAPTURE")

    /** True when [saved] is the old default order (or the part of it this build knows), so it was never rearranged. */
    fun neverDragged(saved: List<MayhemApp>): Boolean {
        val names = saved.map { it.name }
        return names.isNotEmpty() && (names == OLD_DEFAULT.filter { it in names } || names == PREV_DEFAULT.filter { it in names })
    }

    /** Every app the bar can hold: all of them but Settings (it has its own button), and Troll only where it ships. */
    fun all(): List<MayhemApp> = MayhemApp.entries.filter {
        it != MayhemApp.SETTINGS && it != MayhemApp.VDL2 && (it != MayhemApp.TROLL || com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL)
    }

    private val _order = MutableStateFlow(defaultOrder())
    /** Every app, in the order the user set. */
    val order: StateFlow<List<MayhemApp>> = _order.asStateFlow()
    // a fresh install has every app in the bar; Settings › Bar unticks the ones you don't use
    private val _checked = MutableStateFlow(all().toSet())
    val checked: StateFlow<Set<MayhemApp>> = _checked.asStateFlow()
    private val _bar = MutableStateFlow(defaultOrder())
    /** The ticked apps, in order: what the bar shows after HOME. */
    val bar: StateFlow<List<MayhemApp>> = _bar.asStateFlow()
    private val _opensOnLast = MutableStateFlow(false)
    val opensOnLast: StateFlow<Boolean> = _opensOnLast.asStateFlow()
    /** The bias-tee warning has been read and accepted once; from then on the switch is just a switch. */
    @Volatile var biasOk = false; private set

    private var ctx: Context? = null

    /** A fresh install's bar matches the home screen: Receive, Analyze, Transmit, Tools, each in app order. */
    private fun defaultOrder() = listOf("Receive", "Analyze", "Transmit", "Tools").flatMap { c -> all().filter { it.category == c } }

    /**
     * The saved order with each app it lacks placed right after its nearest predecessor in the default order (first
     * if it has none there).
     */
    fun withNew(saved: List<MayhemApp>, def: List<MayhemApp>): List<MayhemApp> {
        val out = saved.toMutableList()
        for ((i, a) in def.withIndex()) {
            if (a in out) continue
            val prev = def.subList(0, i).lastOrNull { it in out }
            if (prev != null) out.add(out.indexOf(prev) + 1, a) else out.add(0, a)
        }
        return out
    }

    fun load(c: Context) {
        ctx = c.applicationContext
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val known = all()
        var saved = p.getString(KEY_ORDER, null)?.split(",")?.mapNotNull { n -> known.firstOrNull { it.name == n.trim() } }?.distinct()
        // once: LoRa went in at the end of saved orders before new apps took their default place; move it there
        if (!p.getBoolean("nav_lora_placed", false)) {
            saved = saved?.filter { it != MayhemApp.LORA }
            p.edit().putBoolean("nav_lora_placed", true).apply()
        }
        // once: a bar still in the old default order takes the new one (apps grouped by what people listen for)
        if (!p.getBoolean("nav_regrouped", false)) {
            if (saved != null && neverDragged(saved)) saved = null
            p.edit().putBoolean("nav_regrouped", true).apply()
        }
        // once more (0.9.42): the flight apps grouped together. VDL2 left the bar for the band switch in Flight
        // Messages, so the saved order is compared by its raw names (VDL2 included) before unknown names drop out
        if (!p.getBoolean("nav_flights_grouped", false)) {
            val raw = p.getString(KEY_ORDER, null)?.split(",")?.mapNotNull { n -> MayhemApp.entries.firstOrNull { it.name == n.trim() } }?.distinct()
            if (raw != null && neverDragged(raw)) saved = null
            p.edit().putBoolean("nav_flights_grouped", true).apply()
        }
        // once more (0.9.58): every bar takes the grouped order, the same as the web and Mac apps, even one arranged
        // by hand before the regrouping (the earlier passes moved only bars still in an old default). The ticks stay.
        if (!p.getBoolean(KEY_REORDERED, false)) {
            saved = null
            p.edit().putBoolean(KEY_REORDERED, true).apply()
        }
        // an app added in an update, not yet in the saved order, goes in after the app it follows by default (LoRa
        // after Meters, with the other receivers), not at the end
        _order.value = if (saved.isNullOrEmpty()) defaultOrder() else withNew(saved, defaultOrder())
        p.getString(KEY_CHECKED, null)?.let { s ->
            val ch = s.split(",").mapNotNull { n -> known.firstOrNull { it.name == n.trim() } }.toMutableSet()
            // an app new since the bar was saved starts ticked, as it would on a fresh install
            val seen = p.getString(KEY_KNOWN, null)?.split(",")?.map { it.trim() }?.toSet() ?: known.filter { it !in ADDED }.map { it.name }.toSet()
            for (a in known) if (a.name !in seen) ch.add(a)
            _checked.value = ch
        }
        _opensOnLast.value = p.getBoolean(KEY_OPENS_LAST, false)
        biasOk = p.getBoolean(KEY_BIAS_OK, false)
        sync(save = true)
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

    fun lastApp(): MayhemApp? = prefs()?.getString(KEY_LAST, null)?.let { n -> MayhemApp.byName(n)?.takeIf { it.barKey() in all() } }

    /** The band Flight Messages was last on: true for VDL2 (136.975), false for ACARS (131). */
    fun flightBandVdl(): Boolean = prefs()?.getBoolean("flight_band_vdl", false) ?: false
    fun setFlightBandVdl(vdl: Boolean) { prefs()?.edit()?.putBoolean("flight_band_vdl", vdl)?.apply() }

    private fun prefs() = ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun sync(save: Boolean = true) {
        _bar.value = _order.value.filter { it in _checked.value }
        if (save) prefs()?.edit()
            ?.putString(KEY_ORDER, _order.value.joinToString(",") { it.name })
            ?.putString(KEY_CHECKED, _checked.value.joinToString(",") { it.name })
            ?.putString(KEY_KNOWN, all().joinToString(",") { it.name })
            ?.apply()
    }
}
