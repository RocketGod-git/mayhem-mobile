package com.rocketgod.mayhem.core.lora

import kotlin.math.abs

// Not a Mayhem port: MeshCore over the air, from its published packet format: the header byte (route type, payload
// type, version), transport codes, the path, then the payload. Adverts are signed but not encrypted, so every node's
// name, type and position can be read; group text on a channel whose key is known (the public channel) is AES-128
// ECB with a 2-byte HMAC-SHA256, which is checked before anything is believed. Kotlin twin of the iOS MeshCore.swift.

class MeshCorePacket(val route: Int, val type: Int, val version: Int, val transport: List<Int>, val hashSize: Int,
                     val path: List<List<Int>>, val payload: IntArray) {
    val fields = ArrayList<Pair<String, String>>()
    /** A node's identity (its public key, or the first bytes of it) when the packet carries one. */
    var nodeKey: IntArray? = null
    var name: String? = null; var nodeType: String? = null
    var lat: Double? = null; var lon: Double? = null
    var text: String? = null; var channel: String? = null
    var advertTime: Long? = null
    val typeName: String get() = TYPE_NAMES[type]

    companion object {
        val ROUTE_NAMES = listOf("transport flood", "flood", "direct", "transport direct")
        val TYPE_NAMES = listOf("REQUEST", "RESPONSE", "DIRECT MESSAGE", "ACK", "ADVERT", "GROUP TEXT", "GROUP DATA",
            "ANON REQUEST", "PATH", "TRACE", "MULTIPART", "CONTROL", "TYPE 12", "TYPE 13", "TYPE 14", "RAW CUSTOM")
    }
}

object MeshCore {
    /**
     * Group channels whose key is public: the default public channel, and hashtag channels (key = the first 16 bytes
     * of SHA-256 of the name with its '#').
     */
    val publicKey = intArrayOf(0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a, 0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72)
    val hashtags = listOf("#test", "#general", "#public", "#meshcore", "#emergency", "#weather", "#socal", "#la", "#ventura", "#california", "#usa", "#ping", "#bot", "#repeaters",
        "#socalmesh", "#socal-mesh", "#lamesh", "#losangeles", "#mesh", "#ham", "#chat", "#news", "#help", "#sos", "#offgrid", "#oc",
        "#orangecounty", "#sandiego", "#sd", "#inlandempire", "#ie", "#sfv", "#valley", "#simivalley", "#moorpark", "#thousandoaks",
        "#oxnard", "#santaclarita", "#pasadena", "#longbeach", "#hikers", "#radio", "#tech", "#random", "#traffic", "#fire", "#quake")

    class GroupChannel(val name: String, val key: IntArray, val hash: Int)

    val channels: List<GroupChannel> by lazy {
        val c = arrayListOf(GroupChannel("Public", publicKey, Sha256.hash(publicKey)[0]))
        for (h in hashtags) {
            val raw = h.toByteArray(Charsets.UTF_8)
            val k = Sha256.hash(IntArray(raw.size) { raw[it].toInt() and 0xff }).copyOf(16)
            c.add(GroupChannel(h, k, Sha256.hash(k)[0]))
        }
        c
    }

    fun u32(b: IntArray, i: Int): Long = b[i].toLong() or (b[i + 1].toLong() shl 8) or (b[i + 2].toLong() shl 16) or (b[i + 3].toLong() shl 24)

    fun parse(bl: List<Int>): MeshCorePacket? {
        val b = bl.toIntArray()
        if (b.size < 2) return null
        val h = b[0]
        val route = h and 3; val type = (h shr 2) and 0x0F; val version = h shr 6
        if (version != 0) return null
        var i = 1
        var transport = emptyList<Int>()
        if (route == 0 || route == 3) {
            if (b.size < i + 4) return null
            transport = listOf(b[i] or (b[i + 1] shl 8), b[i + 2] or (b[i + 3] shl 8)); i += 4
        }
        if (i >= b.size) return null
        val pl = b[i]; i++
        val hops = pl and 0x3F; val hs = (pl shr 6) + 1
        if (hs == 4 || i + hops * hs > b.size || hops * hs > 64) return null
        val path = (0 until hops).map { k -> (0 until hs).map { b[i + k * hs + it] } }
        i += hops * hs
        val p = MeshCorePacket(route, type, version, transport, hs, path, b.copyOfRange(i, b.size))
        p.fields.add("ROUTE" to MeshCorePacket.ROUTE_NAMES[route] + if (hops == 0) ", no hops yet" else ", $hops hop${if (hops == 1) "" else "s"}")
        if (path.isNotEmpty()) p.fields.add("PATH" to path.joinToString(" → ") { s -> s.joinToString("") { "%02x".format(it) } })
        if (transport.isNotEmpty()) p.fields.add("TRANSPORT" to "%04x %04x".format(transport[0], transport[1]))
        if (!payloadFits(p)) return null
        return p
    }

    /** Reads the payload by type; false when it can't be one of that type (a frame that only looked like MeshCore). */
    private fun payloadFits(p: MeshCorePacket): Boolean {
        val b = p.payload
        when (p.type) {
            4 -> {   // ADVERT: public key 32, timestamp 4, signature 64, app data
                if (b.size < 101) return false
                p.nodeKey = b.copyOfRange(0, 32)
                val at = u32(b, 32)
                p.advertTime = at
                val fl = b[100]
                var j = 101
                val types = mapOf(1 to "chat", 2 to "repeater", 3 to "room server", 4 to "sensor")
                val nt = types[fl and 0x0F] ?: "type ${fl and 0x0F}"
                p.nodeType = nt
                if (fl and 0x10 != 0) {
                    if (b.size < j + 8) return false
                    val la = u32(b, j).toInt(); val lo = u32(b, j + 4).toInt(); j += 8
                    if ((la != 0 || lo != 0) && abs(la) <= 90_000_000 && abs(lo) <= 180_000_000) { p.lat = la / 1e6; p.lon = lo / 1e6 }
                }
                if (fl and 0x20 != 0) j += 2
                if (fl and 0x40 != 0) j += 2
                if (fl and 0x80 != 0 && j < b.size) {
                    p.name = String(ByteArray(b.size - j) { b[j + it].toByte() }, Charsets.UTF_8).trim { it.isISOControl() }
                }
                p.fields.add("NODE" to nt)
                p.name?.let { p.fields.add("NAME" to it) }
                val la = p.lat; val lo = p.lon
                if (la != null && lo != null) p.fields.add("POSITION" to "%.5f, %.5f".format(la, lo))
                p.fields.add("PUBLIC KEY" to hexOf(b, 0, 32))
                p.fields.add("ADVERT TIME" to utcStamp(at))
            }
            5, 6 -> {   // GROUP TEXT / DATA: channel hash 1, MAC 2, ciphertext
                if (b.size < 3 + 16 || (b.size - 3) % 16 != 0) return b.size >= 3
                val ct = b.copyOfRange(3, b.size)
                p.fields.add("CHANNEL HASH" to "%02x".format(b[0]))
                for (c in channels) {
                    if (c.hash != b[0]) continue
                    val mac = Sha256.hmac(c.key + IntArray(16), ct)
                    if (mac[0] != b[1] || mac[1] != b[2]) continue
                    val plain = Aes128.ecbDecrypt(c.key, ct)
                    p.channel = c.name
                    p.fields.add("CHANNEL" to c.name)
                    p.fields.add("SENT" to utcStamp(u32(plain, 0)))
                    if (p.type == 5) {
                        var e = plain.size; while (e > 5 && plain[e - 1] == 0) e--
                        val t = String(ByteArray(e - 5) { plain[5 + it].toByte() }, Charsets.UTF_8)
                        p.text = t
                        p.fields.add("TEXT" to t)
                        val k = t.indexOf(": ")
                        if (k >= 0) p.name = t.substring(0, k)
                    } else {
                        p.fields.add("DATA TYPE" to "%02x%02x".format(plain[4], plain[5]))
                        p.fields.add("DATA" to hexOf(plain, 7, minOf(plain.size, 7 + plain[6])))
                    }
                    break
                }
                if (p.channel == null) p.fields.add("TEXT" to "encrypted (private channel)")
            }
            0, 1, 2, 8 -> {   // REQ / RESPONSE / TXT_MSG / PATH: dest hash, src hash, MAC 2, ciphertext
                if (b.size < 4) return false
                p.fields.add("FROM" to "%02x".format(b[1])); p.fields.add("TO" to "%02x".format(b[0]))
                p.fields.add("CONTENT" to "end-to-end encrypted, ${b.size - 4} bytes")
            }
            3 -> {   // ACK: CRC 4
                if (b.size < 4) return false
                p.fields.add("ACK" to hexOf(b, 0, 4))
            }
            7 -> {   // ANON_REQ: dest hash, sender key 32, MAC 2, ciphertext
                if (b.size < 35) return false
                p.nodeKey = b.copyOfRange(1, 33)
                p.fields.add("TO" to "%02x".format(b[0])); p.fields.add("FROM KEY" to hexOf(b, 1, 33))
            }
            9 -> {   // TRACE: tag 4, auth 4, flags 1, path hashes
                if (b.size < 9) return false
                p.fields.add("TAG" to hexOf(b, 0, 4))
                if (b.size > 9) p.fields.add("TRACE PATH" to (9 until b.size).joinToString(" → ") { "%02x".format(b[it]) })
            }
            11 -> {  // CONTROL: flags (sub-type in the top nibble)
                if (b.isEmpty()) return false
                val sub = b[0] shr 4
                p.fields.add("CONTROL" to when (sub) { 8 -> "discover request"; 9 -> "discover response"; else -> "sub-type $sub" })
                if (sub == 9 && b.size >= 14) {
                    p.fields.add("SNR" to "%.1f dB".format(b[1].toByte().toDouble() / 4))
                    p.nodeKey = b.copyOfRange(6, b.size)
                }
            }
            12, 13, 14 -> return false
            else -> p.fields.add("PAYLOAD" to hexOf(b, 0, minOf(48, b.size)))
        }
        return true
    }
}
