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
                p.fields += listOf("DEVICE ADDRESS" to "%08X".format(addr), "NETWORK" to "NwkID %02X".format(addr shr 25), "FRAME COUNT" to "${p.fcnt}")
                if (f.isNotEmpty()) p.fields.add("FLAGS" to f.joinToString(", "))
                if (nopt > 0) p.fields.add("MAC OPTIONS" to b.subList(8, 8 + nopt).joinToString("") { "%02x".format(it) })
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
