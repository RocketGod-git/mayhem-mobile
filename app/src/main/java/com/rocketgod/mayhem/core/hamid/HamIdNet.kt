package com.rocketgod.mayhem.core.hamid

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * The Android side of the HAM+ identity directories: downloads into the app's files, refreshed weekly, read offline
 * otherwise. Blocking: call from a background thread.
 *
 *   · DMR radio IDs: radioid.net's user list (about 17 MB, 4.5 MB as sent compressed), kept compressed on disk and
 *     parsed into the compact table on first use;
 *   · talkgroups: Brandmeister's list (45 KB);
 *   · repeaters: HearHam's directory (10 MB, 1.1 MB compressed) and Brandmeister's devices (the DMR repeaters);
 *   · callsigns heard on the air: callook.info, one at a time, kept 30 days (a miss for a day).
 */
object HamIdNet {
    const val BM_TALKGROUPS_URL = "https://api.brandmeister.network/v2/talkgroup"
    const val RADIOID_USERS_URL = "https://radioid.net/static/user.csv"
    const val BM_DEVICES_URL = "https://api.brandmeister.network/v2/device"
    const val HEARHAM_URL = "https://hearham.com/api/repeaters/v1"
    fun callookUrl(call: String) = "https://callook.info/${URLEncoder.encode(call, "UTF-8")}/json"
    private const val DAY = 86_400_000L; private const val WEEK = 7 * DAY; private const val MONTH = 30 * DAY

    private fun get(url: String, timeoutMs: Int = 15_000): ByteArray {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs * 4
        c.setRequestProperty("Accept-Encoding", "gzip"); c.setRequestProperty("User-Agent", "MayhemMobile")
        try {
            if (c.responseCode != 200) throw java.io.IOException("HTTP ${c.responseCode}")
            val ins = if (c.contentEncoding == "gzip") GZIPInputStream(c.inputStream) else c.inputStream
            return ins.use { it.readBytes() }
        } finally { c.disconnect() }
    }
    /** A cached download: the file while it is younger than [maxAge], else a fresh copy (the old one if that fails). */
    private fun cached(file: File, url: String, maxAge: Long, gzip: Boolean = false): String? {
        val fresh = file.exists() && System.currentTimeMillis() - file.lastModified() < maxAge
        if (!fresh) {
            try {
                val b = get(url)
                file.parentFile?.mkdirs()
                val tmp = File(file.path + ".part")
                if (gzip) GZIPOutputStream(tmp.outputStream()).use { it.write(b) } else tmp.writeBytes(b)
                tmp.renameTo(file)
            } catch (_: Exception) { /* offline: use what is on disk */ }
        }
        if (!file.exists()) return null
        return if (gzip) GZIPInputStream(file.inputStream()).use { String(it.readBytes(), Charsets.UTF_8) } else file.readText()
    }

    fun loadRadioIds(res: HamIdResolver, dir: File): Int {
        val t = cached(File(dir, "hamid/radioid-users.csv.gz"), RADIOID_USERS_URL, WEEK, gzip = true) ?: return 0
        val table = RadioIdTable.fromCsv(t); if (table.size > 0) res.users = table
        return table.size
    }
    fun loadTalkgroups(res: HamIdResolver, dir: File): Int {
        val t = cached(File(dir, "hamid/bm-talkgroups.json"), BM_TALKGROUPS_URL, WEEK) ?: return 0
        return try { res.talkgroups.addBrandmeister(t) } catch (_: Exception) { 0 }
    }
    fun loadHearHam(res: HamIdResolver, dir: File): Int {
        val t = cached(File(dir, "hamid/hearham.json.gz"), HEARHAM_URL, WEEK, gzip = true) ?: return 0
        return try { parseHearHam(t).also { res.repeaters.add(it) }.size } catch (_: Exception) { 0 }
    }
    fun loadBrandmeisterRepeaters(res: HamIdResolver, dir: File): Int {
        val t = cached(File(dir, "hamid/bm-devices.json.gz"), BM_DEVICES_URL, WEEK, gzip = true) ?: return 0
        return try { parseBrandmeisterDevices(t).also { res.repeaters.add(it) }.size } catch (_: Exception) { 0 }
    }
    /** Looks up to [max] of the callsigns the resolver has queued. */
    fun lookupWanted(res: HamIdResolver, dir: File, max: Int = 2): Int {
        var n = 0
        for (call in res.wanted.toList().take(max)) {
            val f = File(dir, "hamid/calls/$call.json")
            if (f.exists()) {
                val text = f.readText(); val age = System.currentTimeMillis() - f.lastModified()
                if (age < if (text.isNotEmpty()) MONTH else DAY) { val r = if (text.isNotEmpty()) runCatching { parseCallook(text) }.getOrNull() else null; if (r != null) res.addCall(r) else res.wanted.remove(call); continue }
            }
            try {
                val text = String(get(callookUrl(call)), Charsets.UTF_8)
                val r = parseCallook(text)
                f.parentFile?.mkdirs(); f.writeText(if (r != null) text else "")
                if (r != null) { res.addCall(r); n++ } else res.wanted.remove(call)
            } catch (_: Exception) { /* offline: try again later */ }
        }
        return n
    }
}
