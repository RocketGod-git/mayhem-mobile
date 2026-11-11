package com.rocketgod.mayhem.core.lora

// Not a Mayhem port: Meshtastic over the air. The 16-byte header, the channel's AES-CTR (the public default key
// decrypts the default channel), and the protobuf messages inside, read field by field. Kotlin twin of the iOS
// Meshtastic.swift.

/** A protobuf message as (field number, value) pairs: varints and fixed ints as Long (64 bits), length-delimited as bytes. */
class Proto private constructor(val fields: List<Pair<Int, Any>>) {
    fun int(n: Int): Long? { for ((k, v) in fields) if (k == n && v is Long) return v; return null }
    fun bytes(n: Int): IntArray? { for ((k, v) in fields) if (k == n && v is IntArray) return v; return null }
    fun all(n: Int): List<Any> = fields.filter { it.first == n }.map { it.second }
    fun string(n: Int): String? = bytes(n)?.let { utf8OrNull(it) }
    fun float(n: Int): Float? = int(n)?.let { java.lang.Float.intBitsToFloat(it.toInt()) }
    fun sint32(n: Int): Int? = int(n)?.toInt()

    companion object {
        fun parse(b: IntArray): Proto? {
            val f = ArrayList<Pair<Int, Any>>()
            var i = 0
            fun varint(): Long? {
                var v = 0L; var shift = 0
                while (i < b.size) {
                    val x = b[i]; i++
                    v = v or ((x and 0x7F).toLong() shl shift)
                    if (x and 0x80 == 0) return v
                    shift += 7; if (shift > 63) return null
                }
                return null
            }
            while (i < b.size) {
                val key = varint() ?: return null
                val num = (key ushr 3).toInt()
                when ((key and 7).toInt()) {
                    0 -> { val v = varint() ?: return null; f.add(num to v) }
                    1 -> { if (i + 8 > b.size) return null; var v = 0L; for (k in 0 until 8) v = v or (b[i + k].toLong() shl (8 * k)); f.add(num to v); i += 8 }
                    5 -> { if (i + 4 > b.size) return null; var v = 0L; for (k in 0 until 4) v = v or (b[i + k].toLong() shl (8 * k)); f.add(num to v); i += 4 }
                    2 -> {
                        val l = varint() ?: return null
                        if (l < 0 || i + l > b.size) return null
                        f.add(num to b.copyOfRange(i, i + l.toInt())); i += l.toInt()
                    }
                    else -> return null
                }
            }
            if (f.any { it.first == 0 }) return null   // field 0 does not exist: not a protobuf
            return Proto(f)
        }
    }
}

/** One Meshtastic packet, decoded as far as it goes. Node numbers are unsigned 32-bit, held in a Long. */
class MeshtasticPacket(
    val dest: Long, val from: Long, val id: Long,
    val hopLimit: Int, val hopStart: Int, val wantAck: Boolean, val viaMqtt: Boolean,
    val channelHash: Int, val nextHop: Int, val relayNode: Int,
) {
    /** Decrypted with a known key (the default channel), else null and only the header is known. */
    var portnum: Int? = null
    val portName: String get() = portnum?.let { MeshtasticEnums.portnum[it] ?: "PORT_$it" } ?: "ENCRYPTED"
    /** Everything read from the message, in order. */
    val fields = ArrayList<Pair<String, String>>()
    // what the app keeps per node
    var longName: String? = null; var shortName: String? = null; var hwModel: String? = null; var role: String? = null
    var lat: Double? = null; var lon: Double? = null; var altitude: Int? = null
    var battery: Int? = null; var voltage: Float? = null; var channelUtil: Float? = null; var airUtilTx: Float? = null; var uptime: Int? = null
    var text: String? = null

    companion object {
        fun nodeName(n: Long): String = if (n == 0xFFFF_FFFFL) "everyone" else "!%08x".format(n)
    }
}

object Meshtastic {
    /** The public default key ("AQ==", the LongFast default channel). */
    val defaultKey = intArrayOf(0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01)
    /**
     * Keys to try, by channel hash (xor of the channel name's bytes and the key's bytes). The default channel of
     * every modem preset shares the default key; each preset's name gives its own hash.
     */
    val presetNames: List<String> get() = LoraPlan.allPresetNames + listOf("LongModerate", "VeryLongSlow", "VLongSlow")

    fun channelHash(name: String, key: IntArray): Int {
        var h = 0
        for (b in name.toByteArray(Charsets.UTF_8)) h = h xor (b.toInt() and 0xff)
        for (b in key) h = h xor b
        return h
    }

    /** Meshtastic's simple public keys: PSK index 1 is the default key, 2-10 the default key with its last byte stepped up by one each. */
    val simpleKeys: List<IntArray> = (0 until 10).map { i -> defaultKey.copyOf().also { it[15] = (it[15] + i) and 0xff } }

    val knownChannels: Map<Int, Pair<String, IntArray>> by lazy {
        val m = HashMap<Int, Pair<String, IntArray>>()
        for (n in presetNames) m[channelHash(n, defaultKey)] = n to defaultKey
        m
    }

    fun parse(b: List<Int>): MeshtasticPacket? {
        if (b.size < 16) return null
        fun u32(i: Int): Long = b[i].toLong() or (b[i + 1].toLong() shl 8) or (b[i + 2].toLong() shl 16) or (b[i + 3].toLong() shl 24)
        val flags = b[12]
        val p = MeshtasticPacket(u32(0), u32(4), u32(8), flags and 7, flags shr 5, flags and 8 != 0, flags and 16 != 0, b[13], b[14], b[15])
        val nonce = IntArray(16)
        for (k in 0 until 4) { nonce[k] = b[8 + k]; nonce[8 + k] = b[4 + k] }
        // the preset's own channel first; then every public key on any channel name: a channel's hash only says
        // which name and key it is, and any name on a public key decrypts with that key
        val tries = ArrayList<Pair<String, IntArray>>()
        knownChannels[p.channelHash]?.let { tries.add(it) }
        for ((i, key) in simpleKeys.withIndex()) {
            if (tries.none { it.second.contentEquals(key) }) tries.add("public key %d · hash %02X".format(i + 1, p.channelHash) to key)
        }
        val body = IntArray(b.size - 16) { b[16 + it] }
        var found: Triple<String, Proto, Long>? = null
        for ((chan, key) in tries) {
            val plain = Aes128.ctr(key, nonce, body)
            // a wrong key gives noise: only a message that reads cleanly, on a port that exists, counts
            val data = Proto.parse(plain) ?: continue
            val port = data.int(1) ?: continue
            if (port > 0 && port < 512 && MeshtasticEnums.portnum[port.toInt()] != null && data.bytes(2) != null) { found = Triple(chan, data, port); break }
        }
        val (chan, data, port) = found ?: return p
        p.portnum = port.toInt()
        p.fields.add("CHANNEL" to chan)
        val payload = data.bytes(2) ?: IntArray(0)
        data.int(6)?.let { p.fields.add("REPLY TO" to "%08x".format(it and 0xFFFF_FFFFL)) }
        decode(p, port.toInt(), payload)
        return p
    }

    private fun fmtF(v: Float?, unit: String, d: Int = 1): String? = v?.let { "%.${d}f%s".format(it, unit) }

    fun decode(p: MeshtasticPacket, port: Int, b: IntArray) {
        when (port) {
            1 -> {   // TEXT_MESSAGE_APP
                val t = utf8OrNull(b) ?: hexOf(b)
                p.text = t
                p.fields.add("TEXT" to t)
            }
            3 -> {   // POSITION_APP
                val m = Proto.parse(b) ?: return
                val la = m.sint32(1); val lo = m.sint32(2)
                if (la != null && lo != null && (la != 0 || lo != 0)) { p.lat = la / 1e7; p.lon = lo / 1e7 }
                m.int(3)?.let { p.altitude = it.toInt() }
                val pla = p.lat; val plo = p.lon
                if (pla != null && plo != null) p.fields.add("POSITION" to "%.5f, %.5f".format(pla, plo))
                p.altitude?.let { p.fields.add("ALTITUDE" to "$it m") }
                m.int(4)?.let { p.fields.add("GPS TIME" to utcStamp(it)) }
                m.int(15)?.let { p.fields.add("SPEED" to "$it m/s") }
                m.int(19)?.let { p.fields.add("SATELLITES" to "$it") }
                m.int(23)?.let { p.fields.add("PRECISION" to "$it bits") }
            }
            4 -> {   // NODEINFO_APP
                val m = Proto.parse(b) ?: return
                p.longName = m.string(2); p.shortName = m.string(3)
                p.hwModel = m.int(5)?.let { MeshtasticEnums.hwModel[it.toInt()] ?: "MODEL_$it" }
                p.role = m.int(7)?.let { MeshtasticEnums.role[it.toInt()] ?: "ROLE_$it" } ?: "CLIENT"
                m.string(1)?.let { p.fields.add("NODE ID" to it) }
                p.longName?.let { p.fields.add("NAME" to it) }
                p.shortName?.let { p.fields.add("SHORT" to it) }
                p.hwModel?.let { p.fields.add("HARDWARE" to it) }
                p.role?.let { p.fields.add("ROLE" to it) }
                if (m.int(6) == 1L) p.fields.add("LICENSED" to "ham")
                m.bytes(8)?.let { k -> if (k.isNotEmpty()) p.fields.add("PUBLIC KEY" to hexOf(k, 0, minOf(8, k.size)) + "…") }
            }
            67 -> {  // TELEMETRY_APP
                val m = Proto.parse(b) ?: return
                m.bytes(2)?.let { Proto.parse(it) }?.let { dm ->
                    p.battery = dm.int(1)?.toInt(); p.voltage = dm.float(2); p.channelUtil = dm.float(3); p.airUtilTx = dm.float(4); p.uptime = dm.int(5)?.toInt()
                    p.battery?.let { v -> p.fields.add("BATTERY" to if (v > 100) "powered" else "$v%") }
                    fmtF(p.voltage, " V", 2)?.let { p.fields.add("VOLTAGE" to it) }
                    fmtF(p.channelUtil, "%")?.let { p.fields.add("CHANNEL USE" to it) }
                    fmtF(p.airUtilTx, "%", 2)?.let { p.fields.add("AIRTIME TX" to it) }
                    p.uptime?.let { v -> p.fields.add("UPTIME" to "${v / 86400}d ${v / 3600 % 24}h ${v / 60 % 60}m") }
                }
                m.bytes(3)?.let { Proto.parse(it) }?.let { em ->
                    fmtF(em.float(1), " °C")?.let { p.fields.add("TEMPERATURE" to it) }
                    fmtF(em.float(2), " %")?.let { p.fields.add("HUMIDITY" to it) }
                    fmtF(em.float(3), " hPa")?.let { p.fields.add("PRESSURE" to it) }
                    fmtF(em.float(9), " lx", 0)?.let { p.fields.add("LIGHT" to it) }
                    fmtF(em.float(14), " m/s")?.let { p.fields.add("WIND" to it) }
                }
                if (m.bytes(5) != null) p.fields.add("POWER" to "power metrics")
                m.bytes(6)?.let { Proto.parse(it) }?.let { ls ->
                    ls.int(5)?.let { p.fields.add("NODES ONLINE" to "$it") }
                    ls.int(3)?.let { p.fields.add("PACKETS TX" to "$it") }
                    ls.int(4)?.let { p.fields.add("PACKETS RX" to "$it") }
                }
            }
            70 -> {  // TRACEROUTE_APP
                val m = Proto.parse(b) ?: return
                val hops = m.all(1).mapNotNull { (it as? Long)?.let { v -> MeshtasticPacket.nodeName(v and 0xFFFF_FFFFL) } }
                p.fields.add("ROUTE" to if (hops.isEmpty()) "direct" else hops.joinToString(" → "))
            }
            71 -> {  // NEIGHBORINFO_APP
                val m = Proto.parse(b) ?: return
                val ns = m.all(4).mapNotNull { x ->
                    val n = (x as? IntArray)?.let { Proto.parse(it) } ?: return@mapNotNull null
                    val id = n.int(1) ?: return@mapNotNull null
                    MeshtasticPacket.nodeName(id and 0xFFFF_FFFFL) + (n.float(2)?.let { " %.1f dB".format(it) } ?: "")
                }
                p.fields.add("NEIGHBORS" to if (ns.isEmpty()) "none" else ns.joinToString(", "))
            }
            73 -> {  // MAP_REPORT_APP
                val m = Proto.parse(b) ?: return
                p.longName = m.string(1); p.shortName = m.string(2)
                p.hwModel = m.int(4)?.let { MeshtasticEnums.hwModel[it.toInt()] ?: "MODEL_$it" }
                val la = m.sint32(9); val lo = m.sint32(10)
                if (la != null && lo != null && (la != 0 || lo != 0)) { p.lat = la / 1e7; p.lon = lo / 1e7 }
                p.longName?.let { p.fields.add("NAME" to it) }
                m.string(5)?.let { p.fields.add("FIRMWARE" to it) }
                m.int(13)?.let { p.fields.add("NODES ONLINE" to "$it") }
            }
            5 -> {   // ROUTING_APP
                val e = Proto.parse(b)?.int(3)
                if (e != null) p.fields.add("ROUTING" to if (e == 0L) "ack" else "error $e")
            }
            else -> p.fields.add("PAYLOAD" to hexOf(b, 0, minOf(32, b.size)))
        }
    }
}
