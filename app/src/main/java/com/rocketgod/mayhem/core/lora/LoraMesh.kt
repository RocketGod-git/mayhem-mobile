package com.rocketgod.mayhem.core.lora

import android.content.Context
import android.content.SharedPreferences
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Station
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.apps.MeshField
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs

/** One text message Mesh keeps: heard (id >= 0) or sent from here (id < 0). */
data class LoraMsg(val id: Long, val ms: Long, val proto: String, val from: String?, val nodeKey: String?, val text: String?, val channel: String?)

/** A message as the CHAT shows it: for one sent from here, how many times it was heard rebroadcast and how soon (s). */
data class LoraChatRow(val msg: LoraMsg, val relayed: Int = 0, val relayAfter: Int = 0)

/**
 * Everything Mesh has heard, kept on this device across launches, radio restarts and span changes: every text message
 * (sent and received), every node and the Mesh log. The decoder starts over each time it restarts; this merges what it
 * reports into what was already kept, so nothing heard disappears until CLEAR. Messages get their own lasting numbers,
 * and a message already kept is recognized by who sent it, what it said and when. Kotlin twin of the web app's loraHist.
 */
object LoraHistory {
    const val MAX_MSGS = 2000
    const val MAX_NODES = 1000
    const val MAX_LOG = 1000

    private val _msgs = MutableStateFlow<List<LoraMsg>>(emptyList())
    val msgs: StateFlow<List<LoraMsg>> = _msgs.asStateFlow()
    private val _nodes = MutableStateFlow<List<LoraNode>>(emptyList())
    val nodes: StateFlow<List<LoraNode>> = _nodes.asStateFlow()
    private var next = 1L
    private val lock = Any()
    private var file: File? = null
    private var log: PacketLog? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var saveJob: Job? = null

    fun init(ctx: Context, hub: LoraHub, log: PacketLog) {
        if (file != null) return
        this.log = log
        file = File(ctx.filesDir, "mesh-history.json")
        runCatching { load() }
        scope.launch { combine(hub.nodes, hub.events) { n, e -> n to e }.collect { (n, e) -> take(n, e) } }
        scope.launch { log.snapshot.collect { keep() } }
    }

    private fun key(m: LoraMsg) = "${m.proto}|${m.nodeKey ?: m.from ?: ""}|${m.text ?: ""}|${Math.round(m.ms / 1000.0)}"

    /** What the decoder reports, merged into what is kept. A node keeps every field it ever sent (the newest value of
     *  each), the larger of its counts, and its newest signal history. */
    fun take(hubNodes: List<LoraNode>, events: List<LoraEvent>) = synchronized(lock) {
        var changed = false
        val msgs = ArrayList(_msgs.value)
        val have = msgs.mapTo(HashSet()) { key(it) }
        for (e in events.asReversed()) {
            if (e.text == null) continue
            val m = LoraMsg(0, e.ms, e.proto, e.from, e.nodeKey, e.text, e.channel)
            if (!have.add(key(m))) continue
            msgs.add(m.copy(id = next++)); changed = true
        }
        if (msgs.size > MAX_MSGS) { msgs.sortByDescending { it.ms }; while (msgs.size > MAX_MSGS) msgs.removeAt(msgs.size - 1) }
        val byKey = LinkedHashMap<String, LoraNode>(); for (n in _nodes.value) byKey[n.key] = n
        var nodesChanged = false
        for (n in hubNodes) {
            val o = byKey[n.key]
            if (o != null && o.lastMs > n.lastMs) continue
            if (o != null && o.lastMs == n.lastMs && o.packets >= n.packets) continue
            val fields = if (o != null) o.fields.filter { f -> n.fields.none { it.name == f.name } } + n.fields else n.fields
            val texts = if (o != null) (o.texts + n.texts.filter { it !in o.texts }).takeLast(20) else n.texts
            byKey[n.key] = n.copy(fields = fields, texts = texts, firstMs = minOf(o?.firstMs ?: n.firstMs, n.firstMs), packets = maxOf(o?.packets ?: 0, n.packets),
                lat = n.lat ?: o?.lat, lon = n.lon ?: o?.lon, name = n.name ?: o?.name)
            nodesChanged = true
        }
        if (nodesChanged) {
            var list = byKey.values.sortedBy { it.firstMs }
            if (list.size > MAX_NODES) list = list.sortedByDescending { it.lastMs }.take(MAX_NODES)
            _nodes.value = list
        }
        if (changed) _msgs.value = msgs
        if (changed || nodesChanged) keep()
    }

    /** A message sent from here, kept with the rest (its id is negative). */
    fun addMine(proto: String, from: String, text: String, channel: String) = synchronized(lock) {
        val now = System.currentTimeMillis()
        _msgs.value = _msgs.value + LoraMsg(-now, now, proto, from, null, text, channel)
        keep()
    }

    /** CLEAR: every message, node and log line kept. */
    fun clear() = synchronized(lock) {
        _msgs.value = emptyList(); _nodes.value = emptyList()
        saveJob?.cancel(); saveJob = null
        runCatching { file?.delete() }
    }

    /** Saved a few seconds after a change, so a burst of frames is one write. */
    private fun keep() {
        if (file == null || saveJob?.isActive == true) return
        saveJob = scope.launch { delay(3000); flush() }
    }

    /** Write what is kept now (the app going to the background). */
    fun flush() {
        val f = file ?: return
        val j = synchronized(lock) {
            JSONObject().put("next", next)
                .put("msgs", JSONArray().also { a -> for (m in _msgs.value) a.put(msgJson(m)) })
                .put("nodes", JSONArray().also { a -> for (n in _nodes.value) a.put(nodeJson(n)) })
        }
        log?.snapshot?.value?.let { s -> j.put("log", JSONArray(s.lines.take(MAX_LOG))).put("logCount", s.total) }
        runCatching { val tmp = File(f.path + ".tmp"); tmp.writeText(j.toString()); tmp.renameTo(f) || run { f.writeText(j.toString()); true } }
    }

    private fun load() {
        val f = file ?: return
        if (!f.exists()) return
        val j = JSONObject(f.readText())
        next = j.optLong("next", 1L)
        val ms = j.optJSONArray("msgs"); val ns = j.optJSONArray("nodes")
        if (ms != null) _msgs.value = (0 until ms.length()).mapNotNull { runCatching { msgFrom(ms.getJSONObject(it)) }.getOrNull() }
        if (ns != null) _nodes.value = (0 until ns.length()).mapNotNull { runCatching { nodeFrom(ns.getJSONObject(it)) }.getOrNull() }
        val lg = j.optJSONArray("log")
        if (lg != null) log?.restore((0 until lg.length()).map { lg.getString(it) }, j.optInt("logCount", lg.length()))
    }

    private fun JSONObject.optStr(k: String): String? = if (has(k) && !isNull(k)) getString(k) else null
    private fun JSONObject.optDbl(k: String): Double? = if (has(k) && !isNull(k)) getDouble(k) else null

    private fun msgJson(m: LoraMsg) = JSONObject().put("id", m.id).put("ms", m.ms).put("proto", m.proto).put("from", m.from ?: JSONObject.NULL)
        .put("nodeKey", m.nodeKey ?: JSONObject.NULL).put("text", m.text ?: JSONObject.NULL).put("channel", m.channel ?: JSONObject.NULL)
    private fun msgFrom(j: JSONObject) = LoraMsg(j.getLong("id"), j.getLong("ms"), j.getString("proto"), j.optStr("from"), j.optStr("nodeKey"), j.optStr("text"), j.optStr("channel"))

    private fun nodeJson(n: LoraNode) = JSONObject().put("key", n.key).put("proto", n.proto).put("label", n.label).put("name", n.name ?: JSONObject.NULL)
        .put("kind", n.kind).put("lat", n.lat ?: JSONObject.NULL).put("lon", n.lon ?: JSONObject.NULL).put("firstMs", n.firstMs).put("lastMs", n.lastMs)
        .put("packets", n.packets).put("snr", JSONArray(n.snr)).put("last", n.last).put("hz", n.hz).put("modem", n.modem).put("texts", JSONArray(n.texts))
        .put("fields", JSONArray().also { a -> for (f in n.fields) a.put(JSONObject().put("name", f.name).put("value", f.value)) })
    private fun nodeFrom(j: JSONObject): LoraNode {
        val snr = j.optJSONArray("snr"); val texts = j.optJSONArray("texts"); val fields = j.optJSONArray("fields")
        return LoraNode(j.getString("key"), j.getString("proto"), j.getString("label"), j.optStr("name"), j.optString("kind"), j.optDbl("lat"), j.optDbl("lon"),
            j.getLong("firstMs"), j.getLong("lastMs"), j.optInt("packets"),
            if (snr == null) emptyList() else (0 until snr.length()).map { snr.getInt(it) },
            if (fields == null) emptyList() else (0 until fields.length()).map { val o = fields.getJSONObject(it); MeshField(o.getString("name"), o.getString("value")) },
            j.optString("last"), j.optLong("hz"), j.optString("modem"),
            if (texts == null) emptyList() else (0 until texts.length()).map { texts.getString(it) })
    }

    /**
     * The CHAT: newest first. A message sent from here heard back (Meshtastic: your own node id with the same text; MeshCore:
     * "yourname: text" on the channel) within two minutes is marked relayed, and the echo is not shown again as someone
     * else's. The same message heard twice through two repeaters within ten seconds is shown once.
     */
    fun chat(all: List<LoraMsg>, myKey: String, myName: String): List<LoraChatRow> {
        fun echoOf(r: LoraMsg, m: LoraMsg) = r.id >= 0 && m.id < 0 && r.proto == m.proto && r.ms >= m.ms && r.ms - m.ms < 120_000 &&
            (if (r.proto == "Meshtastic") r.nodeKey == myKey && r.text == m.text else r.text == "$myName: ${m.text}")
        val mine = all.filter { it.id < 0 }
        val heardBack = all.filter { r -> mine.any { echoOf(r, it) } }
        val sent = mine.map { m ->
            val back = heardBack.filter { echoOf(it, m) }
            if (back.isEmpty()) LoraChatRow(m) else LoraChatRow(m, back.size, Math.round((back.minOf { it.ms } - m.ms) / 1000.0).toInt())
        }
        val echoes = heardBack.mapTo(HashSet()) { it.id }
        fun twice(a: LoraMsg, b: LoraMsg) = a.proto == b.proto && a.from == b.from && a.text == b.text && a.channel == b.channel && abs(a.ms - b.ms) < 10_000
        val sorted = all.filter { it.id >= 0 && it.id !in echoes }.sortedBy { it.ms }
        val heard = sorted.filterIndexed { i, m -> sorted.subList(maxOf(0, i - 8), i).none { twice(it, m) } }.map { LoraChatRow(it) }
        return (sent + heard).sortedByDescending { it.msg.ms }
    }
}

/** Your own node, for sending: an id made up once and kept, the names it goes by, and licensed (ham) mode. */
object LoraMe {
    /** Your node's names, in bytes: MeshCore keeps 31 of a name (Meshtastic 39, the same name goes to both), Meshtastic 4 of a short name. */
    const val LONG_MAX = 31
    const val SHORT_MAX = 4

    data class Me(val id: Long, val long: String, val short: String, val licensed: Boolean) {
        val hex: String get() = "%08x".format(id)
        /** How the hub names this node when it hears it (your packets come back through repeaters). */
        val key: String get() = "MT/!$hex"
    }

    @Volatile private var prefs: SharedPreferences? = null
    private var mem: Me? = null
    private val _me = MutableStateFlow(Me(0x4d4d4d4dL, "Mayhem 4d4d", "4d4d", false))
    val me: StateFlow<Me> = _me.asStateFlow()

    fun init(ctx: Context) {
        if (prefs != null) return
        prefs = ctx.applicationContext.getSharedPreferences("mayhem", Context.MODE_PRIVATE)
        _me.value = read()
    }

    private fun read(): Me {
        val p = prefs
        var id = p?.getLong("lora_me_id", 0L) ?: (mem?.id ?: 0L)
        if (id == 0L || id == 0xFFFF_FFFFL) {
            id = java.security.SecureRandom().nextInt().toLong() and 0xFFFF_FFFFL
            if (id == 0L || id == 0xFFFF_FFFFL) id = 0x4d4d4d4dL
        }
        val hex = "%08x".format(id)
        val long = (p?.getString("lora_me_long", null) ?: mem?.long)?.trim().orEmpty().ifEmpty { "Mayhem ${hex.takeLast(4)}" }
        val short = (p?.getString("lora_me_short", null) ?: mem?.short)?.trim().orEmpty().ifEmpty { hex.takeLast(4) }
        val m = Me(id, clipBytes(long, LONG_MAX), clipBytes(short, SHORT_MAX), p?.getBoolean("lora_me_licensed", false) ?: (mem?.licensed ?: false))
        save(m)
        return m
    }

    fun save(m: Me) {
        val c = m.copy(long = clipBytes(m.long.trim(), LONG_MAX), short = clipBytes(m.short.trim(), SHORT_MAX))
        val p = prefs
        if (p != null) p.edit().putLong("lora_me_id", c.id).putString("lora_me_long", c.long).putString("lora_me_short", c.short).putBoolean("lora_me_licensed", c.licensed).apply()
        else mem = c
        _me.value = c
    }

    fun bytes(s: String): Int = s.toByteArray(Charsets.UTF_8).size

    /** The longest start of [s] that fits in [max] UTF-8 bytes, never cutting an emoji or accented letter in half. */
    fun clipBytes(s: String, max: Int): String {
        if (bytes(s) <= max) return s
        val it = java.text.BreakIterator.getCharacterInstance(java.util.Locale.US)
        it.setText(s)
        var end = 0
        var b = it.next()
        while (b != java.text.BreakIterator.DONE) {
            if (bytes(s.substring(0, b)) > max) break
            end = b; b = it.next()
        }
        return s.substring(0, end)
    }

    /** The name a licensed node goes by: the station's callsign from Settings when there is one. */
    fun name(m: Me = _me.value): String {
        val call = Station.info.value.call.trim()
        return if (m.licensed && call.isNotEmpty()) call.uppercase() else m.long
    }
}

/**
 * Sending on the mesh from your own node: where a message can go (the area's own Meshtastic presets, each one's default
 * channel, and MeshCore's public channel), how much one packet carries, and the transmit gate every send goes through
 * (TX switched on in Settings, the safety prompt once, a HackRF). Kotlin twin of the web app's loraTxChannels/loraSend.
 */
object LoraSend {
    /** Meshtastic's slow presets use coding rate 4/8, the rest 4/5 (a receiver reads it from the packet's header either way). */
    private val CR8 = setOf("LongTurbo", "LongModerate", "LongMod", "LongSlow", "VeryLongSlow")
    const val NARROW_SHIFT = 300_000L

    data class Channel(val key: String, val net: String, val label: String, val preset: String, val hz: Long, val bw: Int, val sf: Int, val cr: Int)

    /** The emoji under the send bar's smiley: the ones people use on the mesh. */
    val EMOJI = listOf("👍", "👋", "✅", "❌", "🙏", "😀", "😂", "😎", "🤔", "👀", "❤️", "🔥", "🎉", "📡", "📶", "🔋", "📍", "🗺️", "🏠", "🚗", "🚲", "⛰️", "🌲", "☀️", "🌧️", "❄️", "⚡", "🌊", "🤖", "💬", "🆗", "⚠️")

    fun channels(area: String = LoraLocal.area()): List<Channel> =
        LoraLocal.listening(area).filter { it.name.startsWith("Meshtastic ") || it.name.startsWith("MeshCore ") }.map { c ->
            val net = if (c.name.startsWith("Meshtastic")) "Meshtastic" else "MeshCore"
            val preset = if (net == "Meshtastic") c.name.split(' ')[1] else "Public"
            Channel("${c.hz}/${c.sf}", net, if (net == "Meshtastic") "Meshtastic $preset · ${"%.3f".format(java.util.Locale.US, c.hz / 1e6)}" else "MeshCore public · ${"%.3f".format(java.util.Locale.US, c.hz / 1e6)}",
                preset, c.hz, c.bw, c.sf, if (net == "Meshtastic" && preset in CR8) 4 else 1)
        }

    /** Whether the span holds this channel: only then is it heard, and only then can a send be heard back. */
    fun inSpan(hz: Long, bw: Int, freq: Long, rate: Int): Boolean =
        if (rate > 2_400_000) abs(hz - freq) + bw / 2.0 < rate * 0.44 else abs(hz - (freq - NARROW_SHIFT)) < 1000

    /** How many bytes [text] takes of what one packet can carry on [ch]: MeshCore sends "name: text" after a 5-byte
     *  header, in 16-byte blocks, 176 at most. */
    fun limit(text: String, ch: Channel?): Pair<Int, Int> {
        val used = LoraMe.bytes(text.trim())
        return if (ch?.net == "MeshCore") used to (171 - LoraMe.bytes("${LoraMe.name()}: ")) else used to 200
    }

    sealed class Result {
        object Sent : Result()
        /** The safety prompt has to be answered first; nothing was sent. */
        object Prompt : Result()
        class Refused(val why: String) : Result()
    }

    /** Why sending cannot start right now, or "" when it can. */
    fun ready(): String = when {
        Radio.kind.value != Radio.Kind.HACKRF || !Radio.canTransmit -> "sending needs a HackRF; this radio only receives"
        !Tx.enabled.value -> "transmit is switched off in Settings"
        else -> ""
    }

    /** One packet on the air from your node, through the app's transmit gate. */
    fun transmit(payload: IntArray, ch: Channel, what: String): Result {
        val r = ready(); if (r.isNotEmpty()) return Result.Refused(r)
        if (Tx.needsPrompt.value) return Result.Prompt
        val rate = 2_000_000
        val iq = LoraTx.modulate(payload, LoraTx.Opts(ch.sf, ch.bw, ch.cr, if (ch.net == "Meshtastic") LoraTx.MESHTASTIC_SYNC else LoraTx.MESHCORE_SYNC,
            preamble = if (ch.net == "Meshtastic") 16 else 8), rate)
        return if (Tx.loraBurst(ch.hz, iq, rate, "$what · ${ch.label}")) Result.Sent else Result.Refused(Tx.status.value.ifEmpty { "radio busy" })
    }

    /** A text message from your node on [ch], refused out of the span or too long for one packet. */
    fun send(text0: String, ch: Channel?, freq: Long, rate: Int): Result {
        val text = text0.trim()
        if (text.isEmpty()) return Result.Refused("type a message first")
        val (used, max) = limit(text, ch)
        if (used > max) return Result.Refused("too long for one packet: $used bytes of $max (an emoji takes 4)")
        if (ch == null) return Result.Refused("pick where to send it")
        if (!inSpan(ch.hz, ch.bw, freq, rate)) return Result.Refused("${ch.label} is outside the span: tap its pill above to move there, so the mesh relaying it can be heard")
        val me = LoraMe.me.value
        val payload = try {
            if (ch.net == "Meshtastic") LoraTx.meshtasticText(me.id, text, ch.preset, licensed = me.licensed) else LoraTx.meshcorePublicText(LoraMe.name(me), text)
        } catch (e: IllegalArgumentException) { return Result.Refused(e.message ?: "cannot send that") }
        val r = transmit(payload, ch, "message")
        if (r is Result.Sent) LoraHistory.addMine(ch.net, "${me.short} (you)", text, ch.preset)
        return r
    }

    /** ANNOUNCE: your node's names on the mesh (Meshtastic node info), so others list you by name. */
    fun announce(picked: Channel?): Result {
        val chans = channels().filter { it.net == "Meshtastic" }
        val ch = chans.firstOrNull { it.key == picked?.key } ?: chans.firstOrNull() ?: return Result.Refused("no Meshtastic channel in this area to announce on")
        val me = LoraMe.me.value
        return try { transmit(LoraTx.meshtasticNodeInfo(me.id, LoraMe.name(me), me.short, ch.preset, licensed = me.licensed), ch, "node info") }
        catch (e: IllegalArgumentException) { Result.Refused(e.message ?: "cannot announce") }
    }
}
