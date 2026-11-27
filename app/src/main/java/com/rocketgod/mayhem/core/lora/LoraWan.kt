package com.rocketgod.mayhem.core.lora

/**
 * Not a Mayhem port: LoRaWAN MAC frames (LoRaWAN 1.0.x / 1.1 frame layout): MHDR, then a join request with its EUIs,
 * or a data frame with its device address, frame counter, options and port. The application payload is encrypted
 * with the device's own session key, so only the header is readable. Kotlin twin of the iOS LoraWan.swift.
 */
class LoraWanPacket(val mtype: Int) {
    val fields = ArrayList<Pair<String, String>>()
    var devAddr: Long? = null
    var devEui: Long? = null; var joinEui: Long? = null
    var fcnt: Int? = null; var port: Int? = null
    val typeName: String get() = TYPE_NAMES[mtype]
    val uplink: Boolean get() = mtype == 0 || mtype == 2 || mtype == 4 || mtype == 6

    companion object {
        val TYPE_NAMES = listOf("JOIN REQUEST", "JOIN ACCEPT", "UPLINK", "DOWNLINK", "CONFIRMED UPLINK", "CONFIRMED DOWNLINK", "REJOIN REQUEST", "PROPRIETARY")
    }
}

object LoraWan {
    fun le(b: List<Int>, i: Int, n: Int): Long { var v = 0L; for (k in 0 until n) v = v or (b[i + k].toLong() shl (8 * k)); return v }

    /**
     * The NetID a device address belongs to (LoRaWAN Backend Interfaces, DevAddr assignment). The address opens with its
     * NetID type in unary (0, 10, 110 ... for types 0 to 7), then the NwkID, whose width grows with the type.
     */
    private val NWKID_BITS = intArrayOf(6, 6, 9, 11, 12, 13, 15, 17)
    fun netIdOf(devAddr: Long): Long {
        val a = devAddr and 0xFFFF_FFFFL
        var type = 0
        while (type < 7 && ((a ushr (31 - type)) and 1L) == 1L) type++
        val bits = NWKID_BITS[type]; val prefix = type + 1 + bits
        val nwkId = (a ushr (32 - prefix)) and ((1L shl bits) - 1)
        return ((type.toLong() shl 21) or nwkId) and 0xFFFF_FFFFL
    }

    /**
     * Public networks by NetID: The Things Network's copy of the LoRa Alliance NetID list
     * (thethingsnetwork.org/docs/lorawan/prefix-assignments) and Helium's own docs. An operator with several NetIDs has a
     * row for each; NetIDs not listed here show as a number.
     */
    val OPERATORS: Map<Long, String> = mapOf(
        0x000013L to "The Things Network", 0xc00058L to "The Things Network",
        0x00003cL to "Helium", 0x000024L to "Helium",
        0x000002L to "Actility", 0x600013L to "Actility", 0x000004L to "Swisscom", 0x000009L to "Senet", 0x600010L to "Senet",
        0x00000aL to "KPN", 0x60001fL to "KPN", 0x00000fL to "Orange", 0x000018L to "Loriot",
        0x000022L to "machineQ (Comcast)", 0x60001cL to "machineQ (Comcast)", 0x600002L to "Netmore", 0xc00012L to "Netmore",
        0x000038L to "Charter", 0x600028L to "Charter", 0x600020L to "Spectrum", 0xc0002eL to "Spectrum",
        0x000039L to "Amazon", 0x60002bL to "Amazon", 0x000003L to "Proximus", 0x000007L to "Bouygues", 0x60002aL to "Neptune", 0xc00050L to "Neptune",
    )

    /** The operator a device address belongs to, or its NetID when the network is not one listed. */
    fun networkOf(devAddr: Long): String {
        val id = netIdOf(devAddr)
        return OPERATORS[id] ?: "NetID %06X".format(id)
    }

    /**
     * The MAC commands carried in a data frame's FOpts (LoRaWAN 1.0.x sends them in the clear; 1.1 encrypts them, and
     * then they do not line up and null comes back). Each is named, with its values where it has any. Device status adds
     * the battery and the link margin as their own fields.
     */
    private val MAC_UP: Map<Int, Pair<String, Int>> = mapOf(0x02 to ("link check request" to 0), 0x03 to ("ADR answer" to 1), 0x04 to ("duty cycle answer" to 0),
        0x05 to ("RX setup answer" to 1), 0x06 to ("device status" to 2), 0x07 to ("new channel answer" to 1), 0x08 to ("RX timing answer" to 0),
        0x09 to ("TX setup answer" to 0), 0x0a to ("downlink channel answer" to 1), 0x0d to ("device time request" to 0))
    private val MAC_DOWN: Map<Int, Pair<String, Int>> = mapOf(0x02 to ("link check answer" to 2), 0x03 to ("ADR request" to 4), 0x04 to ("duty cycle request" to 1),
        0x05 to ("RX setup request" to 4), 0x06 to ("device status request" to 0), 0x07 to ("new channel request" to 5), 0x08 to ("RX timing request" to 1),
        0x09 to ("TX setup request" to 1), 0x0a to ("downlink channel request" to 4), 0x0d to ("device time answer" to 5))

    class MacCommands(val list: List<String>, val extra: List<Pair<String, String>>)

    fun macCommands(o: List<Int>, uplink: Boolean): MacCommands? {
        val table = if (uplink) MAC_UP else MAC_DOWN
        val list = ArrayList<String>(); val extra = ArrayList<Pair<String, String>>()
        fun acks(s: Int, names: List<String>) = names.mapIndexed { i, n -> "$n ${if ((s shr i) and 1 != 0) "ok" else "refused"}" }.joinToString(", ")
        var i = 0
        while (i < o.size) {
            val cid = o[i]; val def = table[cid] ?: return null
            if (i + 1 + def.second > o.size) return null
            val a = o.subList(i + 1, i + 1 + def.second)
            var text = def.first
            if (uplink && cid == 0x06) {
                val batt = a[0]; val margin = ((a[1] and 0x3f) xor 0x20) - 0x20
                val b = if (batt == 0) "external power" else if (batt == 255) "unknown" else "${Math.round(batt / 254.0 * 100)}%"
                text += ": battery $b, margin $margin dB"
                extra += "DEVICE BATTERY" to b; extra += "LINK MARGIN" to "$margin dB"
            } else if (uplink && cid == 0x03) text += ": ${acks(a[0], listOf("power", "data rate", "channel mask"))}"
            else if (uplink && (cid == 0x05 || cid == 0x07 || cid == 0x0a)) text += ": ${acks(a[0], if (cid == 0x05) listOf("RX1 offset", "RX2 rate", "channel") else listOf("channel frequency", "data rate range"))}"
            else if (!uplink && cid == 0x02) { text += ": margin ${a[0]} dB, ${a[1]} gateway${if (a[1] == 1) "" else "s"}"; extra += "GATEWAYS HEARD" to "${a[1]}" }
            else if (!uplink && cid == 0x03) text += ": data rate ${a[0] shr 4}, power index ${a[0] and 0x0f}, channel mask ${"%04X".format(a[1] or (a[2] shl 8))}"
            else if (!uplink && cid == 0x04) text += ": at most 1/${1 shl (a[0] and 0x0f)} of the time"
            else if (!uplink && cid == 0x07) text += ": channel ${a[0]} at ${java.math.BigDecimal((a[1] or (a[2] shl 8) or (a[3] shl 16)) / 10_000.0).setScale(4, java.math.RoundingMode.HALF_UP).toPlainString()} MHz"
            else if (!uplink && cid == 0x08) text += ": ${maxOf(1, a[0] and 0x0f)} s"
            list += text
            i += 1 + def.second
        }
        return MacCommands(list, extra)
    }

    fun parse(b: List<Int>): LoraWanPacket? {
        if (b.size < 12) return null
        val mt = b[0] shr 5
        if (b[0] and 0x1C != 0 && mt != 7) return null      // RFU bits are zero
        val p = LoraWanPacket(mt)
        val mic = b.takeLast(4).joinToString("") { "%02x".format(it) }
        when (mt) {
            0 -> {
                if (b.size != 23) return null
                p.joinEui = le(b, 1, 8); p.devEui = le(b, 9, 8)
                p.fields += listOf("JOIN EUI" to "%016X".format(p.joinEui), "DEVICE EUI" to "%016X".format(p.devEui),
                    "DEV NONCE" to "%04X".format(le(b, 17, 2)), "MIC" to mic)
            }
            1 -> {
                if (b.size != 17 && b.size != 33) return null
                p.fields += listOf("CONTENT" to "encrypted with the device's root key", "MIC" to mic)
            }
            2, 3, 4, 5 -> {
                val fctrl = b[5]; val nopt = fctrl and 0x0F
                if (b.size < 12 + nopt) return null
                val addr = le(b, 1, 4)
                p.devAddr = addr; p.fcnt = le(b, 6, 2).toInt()
                val f = ArrayList<String>()
                if (fctrl and 0x80 != 0) f.add("ADR")
                if (fctrl and 0x40 != 0 && p.uplink) f.add("ADR ack request")
                if (fctrl and 0x20 != 0) f.add("ACK")
                if (fctrl and 0x10 != 0) f.add(if (p.uplink) "class B" else "more pending")
                p.fields += listOf("DEVICE ADDRESS" to "%08X".format(addr), "NETWORK" to networkOf(addr), "FRAME COUNT" to "${p.fcnt}")
                if (f.isNotEmpty()) p.fields.add("FLAGS" to f.joinToString(", "))
                if (nopt > 0) {
                    val mac = macCommands(b.subList(8, 8 + nopt), p.uplink)
                    if (mac != null) { p.fields.add("MAC COMMANDS" to mac.list.joinToString("; ")); p.fields.addAll(mac.extra) }
                    else p.fields.add("MAC OPTIONS" to b.subList(8, 8 + nopt).joinToString("") { "%02x".format(it) } + " (encrypted, LoRaWAN 1.1)")
                }
                val rest = b.size - 4 - (8 + nopt)
                if (rest > 0) {
                    val port = b[8 + nopt]
                    p.port = port
                    p.fields.add("PORT" to if (port == 0) "0 (MAC commands)" else "$port")
                    p.fields.add("PAYLOAD" to "${rest - 1} bytes, encrypted")
                }
                p.fields.add("MIC" to mic)
            }
            6 -> p.fields += listOf("CONTENT" to "rejoin request", "MIC" to mic)
            else -> p.fields.add("CONTENT" to "proprietary, ${b.size} bytes")
        }
        return p
    }
}
