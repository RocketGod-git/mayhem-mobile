package com.rocketgod.mayhem.core

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * What the public registry knows about an ICAO address: registration, type, maker, owner, country and a photo
 * thumbnail, from the free adsbdb mirror. Looked up once per aircraft, only when its card is opened.
 */
object AircraftInfo {
    data class Info(
        val done: Boolean = false, val reg: String? = null, val type: String? = null, val typeIcao: String? = null,
        val maker: String? = null, val owner: String? = null, val country: String? = null, val photo: Bitmap? = null,
    )

    private val cache = ConcurrentHashMap<String, Info>()
    private val pool = Executors.newFixedThreadPool(2)
    private val _changed = MutableStateFlow(0)
    /** Bumped whenever a lookup finishes, so the card redraws. */
    val changed: StateFlow<Int> = _changed.asStateFlow()

    fun get(icao: String): Info? = cache[icao.uppercase()]

    fun lookup(icao: String) {
        val key = icao.uppercase()
        if (cache.putIfAbsent(key, Info()) != null) return
        pool.execute {
            var info = Info(done = true)
            runCatching {
                val x = JSONObject(fetch("https://api.adsbdb.com/v0/aircraft/$key")).optJSONObject("response")?.optJSONObject("aircraft")
                if (x != null) {
                    fun s(k: String) = x.optString(k).takeIf { it.isNotEmpty() && it != "null" }
                    info = info.copy(reg = s("registration"), type = s("type"), typeIcao = s("icao_type"), maker = s("manufacturer"),
                        owner = s("registered_owner"), country = s("registered_owner_country_name"))
                    s("url_photo_thumbnail")?.let { u -> info = info.copy(photo = runCatching { image(u) }.getOrNull()) }
                }
            }
            cache[key] = info
            _changed.value = _changed.value + 1
        }
    }

    private fun open(url: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 7000; readTimeout = 7000; setRequestProperty("User-Agent", "MayhemMobile")
    }
    private fun fetch(url: String): String {
        val c = open(url)
        try {
            if (c.responseCode !in 200..299) throw IllegalStateException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }
    private fun image(url: String): Bitmap? {
        val c = open(url)
        try { return c.inputStream.use { BitmapFactory.decodeStream(it) } } finally { c.disconnect() }
    }
}
