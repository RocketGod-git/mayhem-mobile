package com.rocketgod.mayhem.core.lora

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.MeshField
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One node the LoRa app has heard, with everything it has said about itself. Its lists are replaced, never changed in place. */
data class LoraNode(
    val key: String,
    val proto: String,
    var label: String,
    var name: String? = null,
    var kind: String = "",
    var lat: Double? = null, var lon: Double? = null,
    var firstMs: Long, var lastMs: Long,
    var packets: Int = 0,
    var snr: List<Int> = emptyList(),
    var fields: List<MeshField> = emptyList(),
    var last: String = "",
    var hz: Long = 0,
    var modem: String = "",
    var texts: List<String> = emptyList(),
) {
    fun put(name: String, value: String) {
        val i = fields.indexOfFirst { it.name == name }
        fields = if (i >= 0) fields.toMutableList().also { it[i] = MeshField(name, value) } else fields + MeshField(name, value)
    }
}

class LoraEvent(
    val id: Int,
    val ms: Long,
    val proto: String,
    val kind: String,
    val from: String?,
    val nodeKey: String?,
    val text: String?,
    val channel: String?,
    val line: String,
    val fields: List<MeshField>,
)

/**
 * Not a Mayhem port: the LoRa app's model. Each frame the scanner hears is read as Meshtastic, MeshCore or LoRaWAN
 * (the sync word says which network, the packet's own structure and checks confirm it), or kept as raw LoRa; the
 * nodes it names get a card each, with everything they have said about themselves. Kotlin twin of LoraHub.swift.
 */
class LoraHub(val log: PacketLog) {
    val scanner = LoraScanner()
    private val _nodes = MutableStateFlow<List<LoraNode>>(emptyList())
    val nodes: StateFlow<List<LoraNode>> = _nodes.asStateFlow()
    private val _events = MutableStateFlow<List<LoraEvent>>(emptyList())
    val events: StateFlow<List<LoraEvent>> = _events.asStateFlow()
    /** The span this device was stepped down to because it couldn't keep up with a wider one (0: never). */
    val narrowed = MutableStateFlow(0)
    private val _bursts = MutableStateFlow(0)
    /** Bursts that got a channel of their own. */
    val bursts: StateFlow<Int> = _bursts.asStateFlow()
    private val _frames = MutableStateFlow(0)
    /** Frames decoded. */
    val frames: StateFlow<Int> = _frames.asStateFlow()
    /** Every frame heard, for tests and tools. */
    var onHeard: ((LoraHeard, LoraEvent) -> Unit)? = null
    private val byKey = HashMap<String, LoraNode>()
    private val order = ArrayList<String>()
    private var count = 0
    private val lock = Any()
    /**
     * Meshtastic packets already shown, by sender and packet id, and when: a repeater's copy of a packet (its hop
     * fields rewritten) is the same packet and is counted, not shown again.
     */
    private val seenPackets = HashMap<Long, Long>()

    init {
        scanner.onHeard = { h -> heard(h) }
        scanner.onLora = { _, _ -> _bursts.value = _bursts.value + 1 }
    }

    fun clear() = synchronized(lock) {
        byKey.clear(); order.clear(); count = 0; _nodes.value = emptyList(); _events.value = emptyList(); _bursts.value = 0; _frames.value = 0
    }

    fun heard(h: LoraHeard) = synchronized(lock) { take(h) }

    private fun publishNodes() { _nodes.value = order.mapNotNull { byKey[it]?.copy() } }

    private fun take(h: LoraHeard) {
        val f = h.frame
        val ms = h.timeMs
        val nib = syncNibble(f)
        val modem = "SF${f.sf} · ${bwName(f.bw)} · CR 4/${4 + f.cr}"
        val common = listOf(MeshField("FREQUENCY", mhz(h.hz)), MeshField("MODEM", modem + if (h.inverted) " · downlink (inverted)" else ""),
            MeshField("SNR", "%+.1f dB".format(f.snrDb)), MeshField("LENGTH", "${f.payload.size} bytes"),
            MeshField("CRC", when (f.crcOk) { null -> "none sent"; true -> "ok"; false -> "failed" }))
        var proto = "LoRa"; var kind = "FRAME"; var from: String? = null; var key: String? = null; var text: String? = null; var chan: String? = null
        var fields: List<MeshField> = emptyList()
        val good = f.crcOk != false
        var node: ((LoraNode) -> Unit)? = null

        val mt = if (good) Meshtastic.parse(f.payload)?.takeIf { it.portnum != null || nib == 2 } else null
        val mc = if (good && mt == null) MeshCore.parse(f.payload)?.takeIf { nib == 1 || it.channel != null || (it.type == 4 && it.name != null) } else null
        val lw = if (good && mt == null && mc == null && nib == 3) LoraWan.parse(f.payload) else null
        if (mt != null) {
            val pk = (mt.from shl 32) or mt.id
            seenPackets.entries.removeAll { ms - it.value >= 600_000 }
            if (seenPackets[pk] != null) {
                // a repeat: the node's card keeps its count of copies heard, nothing else changes
                val nk = "MT/" + MeshtasticPacket.nodeName(mt.from)
                val n = byKey[nk]
                if (n != null) {
                    val before = n.fields.firstOrNull { it.name == "REPEATS HEARD" }?.value?.toIntOrNull() ?: 0
                    n.put("REPEATS HEARD", (before + 1).toString())
                    publishNodes()
                }
                return
            }
            seenPackets[pk] = ms
            proto = "Meshtastic"; kind = mt.portName
            val id = MeshtasticPacket.nodeName(mt.from)
            from = mt.shortName ?: id; key = "MT/$id"; text = mt.text
            chan = mt.fields.firstOrNull { it.first == "CHANNEL" }?.second
            val fl = arrayListOf(MeshField("FROM", id), MeshField("TO", MeshtasticPacket.nodeName(mt.dest)),
                MeshField("PACKET ID", "%08x".format(mt.id)),
                MeshField("HOPS", if (mt.hopStart > 0) "${mt.hopStart - mt.hopLimit} of ${mt.hopStart} used" else "limit ${mt.hopLimit}"))
            if (mt.relayNode != 0) fl.add(MeshField("RELAYED BY", "…%02x".format(mt.relayNode)))
            if (mt.wantAck) fl.add(MeshField("WANTS ACK", "yes"))
            if (mt.viaMqtt) fl.add(MeshField("VIA MQTT", "yes"))
            if (mt.portnum == null) fl.add(MeshField("CONTENT", "encrypted, channel hash %02x".format(mt.channelHash)))
            fl += mt.fields.map { MeshField(it.first, it.second) }
            fields = fl
            node = { n ->
                n.kind = listOfNotNull(mt.hwModel, mt.role).joinToString(" · ").ifEmpty { n.kind.ifEmpty { "MESHTASTIC NODE" } }
                mt.shortName?.let { n.label = it }
                mt.longName?.let { n.name = it }
                val la = mt.lat; val lo = mt.lon
                if (la != null && lo != null) { n.lat = la; n.lon = lo }
                for ((k, v) in mt.fields) if (k != "TEXT" && k != "REPLY TO") n.put(k, v)
                if (mt.portnum == null) n.put("CHANNEL", "private (hash %02x)".format(mt.channelHash))
            }
        } else if (mc != null) {
            proto = "MeshCore"; kind = mc.typeName; text = mc.text; chan = mc.channel
            fields = mc.fields.map { MeshField(it.first, it.second) }
            val k = mc.nodeKey
            if (k != null) {
                key = "MC/" + hexOf(k, 0, minOf(6, k.size))
                from = mc.name ?: hexOf(k, 0, minOf(2, k.size))
            } else if (mc.name != null) {
                from = mc.name
                key = byKey.values.firstOrNull { it.proto == "MeshCore" && it.name == mc.name }?.key
            }
            node = { n ->
                mc.name?.let { n.name = it; n.label = it.take(10) }
                mc.nodeType?.let { n.kind = it.uppercase() }
                if (n.kind.isEmpty()) n.kind = "MESHCORE NODE"
                val la = mc.lat; val lo = mc.lon
                if (la != null && lo != null) { n.lat = la; n.lon = lo }
                for ((fk, v) in mc.fields) if (fk != "TEXT" && fk != "ROUTE" && fk != "PATH" && fk != "SENT") n.put(fk, v)
            }
        } else if (lw != null) {
            proto = "LoRaWAN"; kind = lw.typeName
            fields = lw.fields.map { MeshField(it.first, it.second) }
            val a = lw.devAddr; val e = lw.devEui
            if (a != null) { key = "LW/%08X".format(a); from = "%08X".format(a) }
            else if (e != null) { key = "LW/%016X".format(e); from = "%016X".format(e) }
            node = { n ->
                n.kind = if (lw.uplink) "END DEVICE" else "FROM GATEWAY"
                for ((fk, v) in lw.fields) if (fk != "MIC") n.put(fk, v)
            }
        } else {
            kind = if (good) "RAW FRAME" else "CRC FAILED"
            fields = listOf(MeshField("SYNC", "word 0x%X? (symbols %d, %d)".format(nib, f.sync.firstOrNull() ?: 0, if (f.sync.size > 1) f.sync[1] else 0)),
                MeshField("PAYLOAD", f.payload.take(64).joinToString("") { "%02x".format(it) } + if (f.payload.size > 64) "…" else ""))
        }
        fields = fields + common
        count++
        val t = clock(ms)
        val who = from?.let { " $it" } ?: ""
        val what = text?.let { " “$it”" } ?: ""
        val line = "$t ${proto.uppercase()}$who $kind$what · ${"%.3f".format(h.hz / 1e6)} SF${f.sf}/${f.bw / 1000}k ${"%+.0f".format(f.snrDb)} dB"
        val ev = LoraEvent(count, ms, proto, kind, from, key, text, chan, line, fields)
        log.add(line)
        _events.value = (listOf(ev) + _events.value).take(400)
        _frames.value = count

        val k = key; val upd = node
        if (k != null && upd != null) {
            val existing = byKey[k]
            val n = existing ?: LoraNode(k, proto, from ?: k, firstMs = ms, lastMs = ms)
            if (existing == null) order.add(k)
            n.lastMs = ms; n.packets++
            n.snr = (n.snr + Math.round(f.snrDb).toInt()).takeLast(24)
            n.hz = h.hz; n.modem = modem
            n.last = "$kind$what"
            if (text != null) n.texts = (n.texts + text).takeLast(20)
            upd(n)
            byKey[k] = n
            publishNodes()
        }
        onHeard?.invoke(h, ev)
    }

    companion object {
        fun mhz(hz: Long): String = "%.4f MHz".format(hz / 1e6)
        fun bwName(bw: Int): String = if (bw == 62_500) "62.5 kHz" else "${bw / 1000} kHz"

        /** The network a sync word names, from its high nibble (the first sync symbol is that nibble times 8). */
        fun syncNibble(f: LoraFrame): Int = (((f.sync.firstOrNull() ?: 0) + 4) / 8) and 0x0F

        fun clock(ms: Long): String = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(ms))
    }
}
