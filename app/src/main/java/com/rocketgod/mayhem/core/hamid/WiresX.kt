package com.rocketgod.mayhem.core.hamid

/**
 * WIRES-X replies a node sends to a radio over Fusion (not in Yaesu's published specification; the layout is from
 * the YSFClients gateway): in data full rate frames, the data units after CSD3 hold a sequence number, 5D xx 5F 26
 * (51 the node, 41 connected or disconnected, 46 a list), the node's ID (5), callsign (10), name (14), two status
 * characters, and when connected the room's ID (5), name (16), count (3, byte 57) and description (14, byte 70); a
 * 0x03 ends it and the next byte is the sum of all before. The same as the web's dsp/hamid/wiresx.ts.
 */
data class WiresX(val kind: String, val nodeId: String, val node: String, val name: String, val roomId: String, val room: String, val count: String, val description: String)

fun wiresxReply(b: IntArray): WiresX? {
    if (b.size < 36 || b[1] != 0x5d || b[3] != 0x5f || b[4] != 0x26) return null
    val cmd = b[2]
    if (cmd != 0x51 && cmd != 0x41 && cmd != 0x46) return null
    var sum = 0; for (i in 0 until 36) sum += b[i] and 255
    var ok = false; var e = 36
    while (e + 1 < b.size) { sum += b[e] and 255; if ((b[e] and 255) == 0x03 && (sum and 255) == (b[e + 1] and 255)) { ok = true; break }; e++ }
    if (!ok) return null
    val inRoom = b[35] == 0x33 && b.size >= 84
    val kind = if (cmd == 0x51) "node" else if (cmd == 0x46) "list" else if (inRoom) "connect" else "disconnect"
    return WiresX(kind, Fec.asciiField(b, 5, 5), Fec.asciiField(b, 10, 10), Fec.asciiField(b, 20, 14),
        if (inRoom) Fec.asciiField(b, 36, 5) else "", if (inRoom) Fec.asciiField(b, 41, 16) else "", if (inRoom) Fec.asciiField(b, 57, 3) else "", if (inRoom) Fec.asciiField(b, 70, 14) else "")
}
