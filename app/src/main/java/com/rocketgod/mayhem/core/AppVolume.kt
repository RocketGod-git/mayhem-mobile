package com.rocketgod.mayhem.core

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * The per-app output volume and mute for the apps that play the built-in demod straight to the speaker: Audio, HD
 * Radio and Home. Each keeps its own volume (0 to 150 %) and mute, saved on the phone. The active app's effective
 * gain is pushed to [SdrEngine.setAppGain]; the other apps drive their own level in their processor, so opening one
 * sets the gain back to 1. The top-bar MUTE is separate and still works on top of this.
 */
object AppVolume {
    private const val PREFS = "mayhem"
    private const val KEY = "appvol"
    private var ctx: Context? = null

    data class Vol(val vol: Float = 1f, val muted: Boolean = false)

    private val _audio = MutableStateFlow(Vol())
    val audio: StateFlow<Vol> = _audio.asStateFlow()
    private val _hd = MutableStateFlow(Vol())
    val hd: StateFlow<Vol> = _hd.asStateFlow()
    private val _home = MutableStateFlow(Vol())
    val home: StateFlow<Vol> = _home.asStateFlow()

    /** The app whose volume is live, so a slider or mute change pushes the gain right away. */
    @Volatile private var active: String? = null

    fun init(c: Context) {
        ctx = c.applicationContext
        runCatching {
            val v = JSONObject(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: "")
            _audio.value = read(v, "audio"); _hd.value = read(v, "hd"); _home.value = read(v, "home")
        }
    }
    private fun read(v: JSONObject, k: String): Vol {
        val o = v.optJSONObject(k) ?: return Vol()
        return Vol(o.optDouble("vol", 1.0).toFloat().coerceIn(0f, 1.5f), o.optBoolean("muted", false))
    }
    private fun flow(key: String) = when (key) { "audio" -> _audio; "hd" -> _hd; else -> _home }

    /** The gain the engine should use for this app: 0 when muted, else its volume. */
    private fun gainOf(v: Vol) = if (v.muted) 0f else v.vol

    /** Mark the app whose card is on screen and push its gain now; null (any other app) hands the engine 1. */
    fun activate(key: String?) {
        active = key
        SdrEngine.setAppGain(if (key == null) 1f else gainOf(flow(key).value))
    }

    fun setVolume(key: String, vol: Float) = update(key, flow(key).value.copy(vol = vol.coerceIn(0f, 1.5f)))
    fun toggleMute(key: String) = update(key, flow(key).value.copy(muted = !flow(key).value.muted))

    private fun update(key: String, v: Vol) {
        flow(key).value = v
        if (active == key) SdrEngine.setAppGain(gainOf(v))
        save()
    }
    private fun save() {
        val v = JSONObject()
        for (k in listOf("audio", "hd", "home")) { val f = flow(k).value; v.put(k, JSONObject().put("vol", f.vol.toDouble()).put("muted", f.muted)) }
        runCatching { ctx?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(KEY, v.toString())?.apply() }
    }
}
