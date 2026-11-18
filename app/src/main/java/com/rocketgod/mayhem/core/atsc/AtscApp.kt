package com.rocketgod.mayhem.core.atsc

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A subchannel's picture as shown and kept: at its display aspect, 480 wide at most. */
class AtscStill(val bmp: Bitmap, val ms: Long, val complete: Boolean)

/**
 * The ATSC TV app around its processor: AUTO, which looks at every channel for an 8VSB pilot and stays on each
 * station until its channels, a picture of each subchannel and the guide are in; the stations and tables (kept
 * between runs); and the pictures, composited over the last one where a picture came out partial, kept as JPEGs.
 */
object AtscApp {
    val log = PacketLog()
    val proc = AtscProcessor(log)
    const val RATE = 8_000_000
    val BANDS = listOf("AUTO", "VHF", "UHF")

    class Scan(val band: String = "AUTO", val list: List<Int> = channels("AUTO"), val idx: Int = 0, val tunedMs: Long = 0, val stayCh: Int = 0)
    private val _scan = MutableStateFlow(Scan())
    val scan: StateFlow<Scan> = _scan.asStateFlow()
    private val _stills = MutableStateFlow<Map<String, AtscStill>>(emptyMap())
    val stills: StateFlow<Map<String, AtscStill>> = _stills.asStateFlow()

    private var file: File? = null; private var dir: File? = null
    @Volatile private var restored = false
    @Volatile private var saved = -1
    private var saver: java.util.Timer? = null
    private var pool: AtscPool? = null

    fun channels(band: String): List<Int> = ATSC_CHANNELS.map { it.ch }.filter { band != "VHF" || it <= 13 }.filter { band != "UHF" || it >= 14 }
    fun rtl() = Radio.kind.value == Radio.Kind.RTLSDR
    fun rate(): Int = if (rtl()) (if (Radio.canSample(Radio.limits, 2_400_000)) 2_400_000 else 2_048_000) else RATE
    /** Where a channel is tuned: its center for a full decode, beside the pilot for a narrow radio (off its DC spike). */
    fun hz(ch: Int): Long = Math.round(if (rtl()) pilotOf(ch) + 400_000 else centerOf(ch))
    /** The channel the scan is on (or holding). */
    fun scanCh(): Int { val s = _scan.value; return if (s.band == "HOLD" && s.stayCh > 0) s.stayCh else s.list.getOrElse(s.idx) { 14 } }

    fun init(ctx: Context) {
        file = File(ctx.filesDir, "atsc.json")
        dir = File(ctx.filesDir, "atsc_stills").also { it.mkdirs() }
        proc.onStill = { k, s -> runCatching { still(k, s) } }
        proc.onLog = { com.rocketgod.mayhem.Diag.log(it) }
    }

    fun start() {
        proc.centerOf = { SdrEngine.freqHz.value.toDouble() }
        if (rate() >= 6_400_000) {
            val p = pool ?: AtscPool(AtscPool.sized()).also { pool = it; com.rocketgod.mayhem.Diag.log("ATSC: ${it.size} burst decoder${if (it.size == 1) "" else "s"}") }
            proc.pool = p
        }
        val s = _scan.value
        val list = if (s.band == "HOLD") s.list else channels(s.band)
        val idx = if (s.idx < list.size) s.idx else 0
        _scan.value = Scan(s.band, list, idx, System.currentTimeMillis(), s.stayCh)
        SdrEngine.configure(SdrEngine.Mode.NONE, hz(scanCh()), rate(), 24, 24, false, proc)
        val f = file ?: return
        if (!restored) kotlin.concurrent.thread(isDaemon = true, name = "atsc-restore") {
            runCatching { if (f.exists()) proc.restore(f.readText()) }
            runCatching { loadStills() }
            saved = proc.version; restored = true
        }
        // the tables are written out every 5 s once they change
        if (saver == null) saver = kotlin.concurrent.fixedRateTimer("atsc-save", true, 5_000, 5_000) {
            val v = proc.version
            if (v != saved && restored) { saved = v; runCatching { val tmp = File(f.path + ".tmp"); tmp.writeText(proc.exportState()); if (!tmp.renameTo(f)) { f.writeText(tmp.readText()); tmp.delete() } } }
        }
    }

    private fun go(ch: Int) { _scan.value = Scan(_scan.value.band, _scan.value.list, _scan.value.idx, System.currentTimeMillis(), _scan.value.stayCh); SdrEngine.tune(hz(ch)) }

    /** AUTO: a moment on every channel for its pilot; a station keeps the radio until its channels, a picture of each
     *  subchannel and the guide are in (a minute and a half at most), then the scan moves on. */
    fun tick(now: Long) {
        val sc = _scan.value
        if (sc.band == "HOLD" || sc.list.isEmpty()) return
        val s = proc.snap.value; val e = now - sc.tunedMs
        val ch = sc.list[sc.idx % sc.list.size]
        val h = s?.here?.takeIf { it.ch == ch && it.since >= sc.tunedMs - 400 }
        val pilot = h?.pilotOk == true
        var next = false
        // no 8VSB pilot: gone in two seconds; a pilot with no segment sync after a few bursts: gone; a station keeps
        // the radio until its channels, a picture of each and the guide are in (a minute and a half at most)
        if (e > 2_000 && !pilot && h?.sync != true) next = true
        else if (pilot && s.capability == "pilot" && e > 3_500) next = true
        else if (s?.capability == "decode" && h != null) {
            val done = h.vct && h.eit && h.stills >= max(1, h.videoSubs)
            if (!h.sync && (h.bursts >= 3 || e > 15_000)) next = true
            else if (h.sync && ((done && e > 10_000) || e > 90_000 || (e > 45_000 && !h.vct))) next = true
        }
        if (next) { val idx = (sc.idx + 1) % sc.list.size; _scan.value = Scan(sc.band, sc.list, idx, now, sc.stayCh); go(sc.list[idx]) }
    }

    fun setBand(b: String) {
        val sc = _scan.value
        if (b == "HOLD") { _scan.value = Scan("HOLD", sc.list, sc.idx, sc.tunedMs, proc.snap.value?.ch?.takeIf { it > 0 } ?: sc.list.getOrElse(sc.idx) { 14 }); return }
        val list = channels(b); _scan.value = Scan(b, list, 0, System.currentTimeMillis(), sc.stayCh); go(list[0])
    }
    fun step(d: Int) {
        val all = ATSC_CHANNELS.map { it.ch }; val cur = proc.snap.value?.ch?.takeIf { it > 0 } ?: _scan.value.stayCh.takeIf { it > 0 } ?: 14
        val i = max(0, all.indexOf(cur)); holdOn(all[(i + d + all.size) % all.size])
    }
    fun holdOn(ch: Int) { val sc = _scan.value; _scan.value = Scan("HOLD", sc.list, sc.idx, System.currentTimeMillis(), ch); SdrEngine.tune(hz(ch)) }

    // ---- pictures ----
    private fun fileOf(key: String) = File(dir, key.replace('/', '_') + ".jpg")
    private val index = HashMap<String, Pair<Long, Boolean>>()
    private fun indexFile() = File(dir, "index.json")

    private fun loadStills() {
        val d = dir ?: return
        val idx = runCatching { JSONObject(indexFile().readText()) }.getOrNull() ?: return
        val out = HashMap<String, AtscStill>()
        for (k in idx.keys()) {
            val o = idx.getJSONObject(k); val f = fileOf(k); if (!f.exists()) continue
            val b = BitmapFactory.decodeFile(f.path) ?: continue
            out[k] = AtscStill(b, o.optLong("ms"), o.optBoolean("complete")); synchronized(index) { index[k] = o.optLong("ms") to o.optBoolean("complete") }
        }
        if (d.exists()) _stills.value = out + _stills.value
    }

    /** A picture with macroblocks never decoded (slices lost to uncorrectable packets) keeps the last still there.
     *  Runs on the picture thread. */
    private fun still(key: String, s: Still) {
        val w = s.width; val h = s.height; val dar = if (s.dar > 0) s.dar else w.toDouble() / h
        val px = IntArray(w * h)
        for (i in 0 until w * h) { val o = 4 * i; px[i] = (0xff shl 24) or ((s.rgba[o].toInt() and 0xff) shl 16) or ((s.rgba[o + 1].toInt() and 0xff) shl 8) or (s.rgba[o + 2].toInt() and 0xff) }
        val prev = _stills.value[key]
        var complete = s.filled
        if (!complete && prev != null && s.mbw > 0 && s.mbPx > 0) {
            val old = Bitmap.createScaledBitmap(prev.bmp, w, h, true); val od = IntArray(w * h); old.getPixels(od, 0, w, 0, 0, w, h)
            val rows = s.have.size / s.mbw; val vpx = if (h > rows * s.mbPx) 2 * s.mbPx else s.mbPx
            for (k in s.have.indices) {
                if (s.have[k].toInt() != 0) continue
                val x0 = (k % s.mbw) * s.mbPx; val y0 = (k / s.mbw) * vpx
                for (y in y0 until min(h, y0 + vpx)) for (x in x0 until min(w, x0 + s.mbPx)) px[y * w + x] = od[y * w + x]
            }
            complete = prev.complete
        }
        val src = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
        val ow = min(480, max(w.toDouble(), h * dar).roundToInt()); val oh = (ow / dar).roundToInt()
        val out = Bitmap.createScaledBitmap(src, ow, oh, true)
        val ms = System.currentTimeMillis()
        _stills.value = _stills.value + (key to AtscStill(out, ms, complete))
        val d = dir ?: return
        runCatching {
            fileOf(key).outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 82, it) }
            val j = synchronized(index) { index[key] = ms to complete; JSONObject().also { o -> for ((k, v) in index) o.put(k, JSONObject().put("ms", v.first).put("complete", v.second)) } }
            File(d, "index.json").writeText(j.toString())
        }
    }

    fun clear() {
        proc.clear(); log.clear(); _stills.value = emptyMap()
        synchronized(index) { index.clear() }
        kotlin.concurrent.thread(isDaemon = true, name = "atsc-clear") { dir?.listFiles()?.forEach { it.delete() }; file?.delete() }
    }
}
