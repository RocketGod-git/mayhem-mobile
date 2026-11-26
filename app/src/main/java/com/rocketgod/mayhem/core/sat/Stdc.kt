package com.rocketgod.mayhem.core.sat

import kotlin.math.abs

/**
 * Inmarsat-C NCS TDM: the common channel every Inmarsat-C ship terminal listens to, 1200 symbols a second BPSK, one
 * 10 368-symbol frame every 8.64 s (64 rows of 2 UW symbols and 160 coded ones: 639 data bytes and the flush byte;
 * see LbandFrame). A frame holds packets back to back, each with its descriptor and a two-byte Fletcher check:
 * - a descriptor under 0x80 is short, its low four bits the length less one (0x7D, the bulletin board, is 14 bytes);
 * - 0x80 to 0xBF is medium, the next byte the length less two; 0xC0 and up is long, a 16-bit length less three.
 * The bulletin board opens every frame with the frame number (0 to 9999, 8.64 s apart from midnight UTC).
 *
 * EGC (SafetyNET and FleetNET broadcasts) comes in 0xB1 (a message's first packet) and 0xB2 (the rest) packets:
 * service code, priority, message and packet numbers, the address the service calls for, then IA5 text. Text in any
 * other presentation is binary or encrypted: it is flagged, never shown.
 *
 * Twin of web/src/dsp/lband/stdc.ts.
 */
object Stdc {
    val LAYOUT = LbandFrame.Layout(LbandFrame.uwBits(0xFD07091BL, 0x2D7798A8L), 2, 160)
    const val SYMBOL_RATE = 1200
    const val DATA_BYTES = 639

    /** The NCS common channels, by ocean region. */
    val NCS_CHANNELS = listOf("AMER" to 1_537_700_000L, "AOR-E" to 1_541_450_000L, "IOR" to 1_537_100_000L, "POR" to 1_541_450_000L)

    val PRIORITY_NAMES = listOf("ROUTINE", "SAFETY", "URGENCY", "DISTRESS")

    private enum class Addr { NONE, RECT, CIRCLE, NAVAREA, COASTAL, ENID }
    private class Service(val code: Int, val name: String, val addr: Addr)
    private val SERVICES = listOf(
        Service(0x00, "General call", Addr.NONE),
        Service(0x02, "Group call (FleetNET)", Addr.ENID),
        Service(0x04, "NAV / MET / piracy warning, rectangular area", Addr.RECT),
        Service(0x11, "Inmarsat system message", Addr.NONE),
        Service(0x13, "NAV / MET / piracy warning, circular area", Addr.CIRCLE),
        Service(0x14, "Shore-to-ship distress alert, circular area", Addr.CIRCLE),
        Service(0x23, "EGC system message", Addr.NONE),
        Service(0x24, "Coastal warning", Addr.COASTAL),
        Service(0x31, "NAVAREA / METAREA warning or MET forecast", Addr.NAVAREA),
        Service(0x33, "Download group identity", Addr.ENID),
        Service(0x34, "SAR coordination, rectangular area", Addr.RECT),
        Service(0x44, "SAR coordination, circular area", Addr.CIRCLE),
        Service(0x72, "Chart correction service", Addr.NAVAREA),
    )
    fun serviceName(code: Int): String = SERVICES.firstOrNull { it.code == code }?.name ?: "service %02X".format(code)
    private fun addrKind(code: Int) = SERVICES.firstOrNull { it.code == code }?.addr ?: Addr.NONE
    private val NAVTEX_SUBJECTS = mapOf('A' to "navigational warning", 'B' to "meteorological warning", 'C' to "ice report", 'D' to "search and rescue, piracy",
        'E' to "meteorological forecast", 'F' to "pilot service", 'G' to "AIS", 'H' to "LORAN", 'J' to "GNSS", 'K' to "other navaid", 'L' to "navigational warning", 'Z' to "no messages")
    private val ROMAN = listOf("", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI")

    private fun s8(v: Int) = if (v and 0x80 != 0) v - 256 else v
    private fun s16(v: Int) = if (v and 0x8000 != 0) v - 65536 else v
    private fun latText(d: Int) = "${abs(d)}°${if (d < 0) 'S' else 'N'}"
    private fun lonText(d: Int) = "${abs(d)}°${if (d < 0) 'W' else 'E'}"
    private fun navarea(n: Int) = "NAVAREA ${ROMAN.getOrNull(n) ?: n.toString()}"

    /** The area an EGC address names, as text. */
    fun areaText(service: Int, a: List<Int>): String = when (addrKind(service)) {
        Addr.RECT -> if (a.size >= 5) "${latText(s8(a[0]))} ${lonText(s16((a[1] shl 8) or a[2]))}, ${a[3]}° north by ${a[4]}° east" else ""
        Addr.CIRCLE -> if (a.size >= 5) "${latText(s8(a[0]))} ${lonText(s16((a[1] shl 8) or a[2]))}, radius ${(a[3] shl 8) or a[4]} nm" else ""
        Addr.NAVAREA -> if (a.isNotEmpty()) navarea(a[0]) else ""
        Addr.COASTAL -> if (a.size >= 3) {
            val st = (a[1] and 0x7F).toChar(); val sub = (a[2] and 0x7F).toChar()
            "${navarea(a[0])}, station $st, ${NAVTEX_SUBJECTS[sub] ?: "subject $sub"}"
        } else ""
        Addr.ENID -> if (a.size >= 2) "ENID ${(a[0] shl 8) or a[1]}" else ""
        Addr.NONE -> a.joinToString(" ") { "%02X".format(it) }
    }

    /** Fletcher (mod 255) over a packet with its two check bytes last: true when it checks. */
    fun fletcherOk(b: IntArray, at: Int, n: Int): Boolean {
        var c0 = 0; var c1 = 0
        for (i in 0 until n) { c0 = (c0 + b[at + i]) % 255; c1 = (c1 + c0) % 255 }
        return c0 == 0 && c1 == 0
    }
    /** The two check bytes that make a packet check (the last two of [b], which are overwritten). */
    fun fletcherSet(b: IntArray): IntArray {
        val n = b.size
        b[n - 2] = 0; b[n - 1] = 0
        var c0 = 0; var c1 = 0
        for (i in 0 until n) { c0 = (c0 + b[i]) % 255; c1 = (c1 + c0) % 255 }
        var x = ((c0 - c1) % 255 + 255) % 255; var y = ((c1 - 2 * c0) % 255 + 510) % 255
        if (x == 0) x = 255; if (y == 0) y = 255
        b[n - 2] = x; b[n - 1] = y
        return b
    }

    /** A packet's whole length from its descriptor (0 when it cannot be one). */
    fun packetLength(f: IntArray, pos: Int, end: Int): Int {
        val b = f[pos]
        if (b < 0x80) return (b and 0x0F) + 1
        if (b < 0xC0) return if (pos + 1 < end) f[pos + 1] + 2 else 0
        return if (pos + 2 < end) ((f[pos + 1] shl 8) or f[pos + 2]) + 3 else 0
    }

    /** Transmitter side (tests, tools): a medium packet of [type] around [body], check bytes added. */
    fun mediumPacket(type: Int, body: List<Int>): IntArray = fletcherSet((listOf(type, body.size + 2) + body + listOf(0, 0)).toIntArray())
    /** The bulletin board for frame [frameNo]. */
    fun bulletinBoard(frameNo: Int): IntArray = fletcherSet(intArrayOf(0x7D, 0x01, frameNo shr 8, frameNo and 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    /** An EGC message's packets (text in pieces of up to [chunk] bytes). */
    fun egcPackets(service: Int, priority: Int, seq: Int, address: List<Int>, text: String, chunk: Int = 120, presentation: Int = 0): List<IntArray> {
        val t = text.map { it.code and 0x7F }; val out = ArrayList<IntArray>()
        var p = 0; var k = 0
        while (k == 0 || p < t.size) {
            val part = t.subList(minOf(p, t.size), minOf(p + chunk, t.size)); p += chunk
            val last = if (p >= t.size) 0x80 else 0
            if (k == 0) out.add(mediumPacket(0xB1, listOf(service, (priority shl 6) or presentation, seq shr 8, seq and 0xFF, k or last, address.size) + address + part))
            else out.add(mediumPacket(0xB2, listOf(seq shr 8, seq and 0xFF, service, k or last) + part))
            k++
        }
        return out
    }
    /** Packets into one frame's data bytes (zeros after them). */
    fun frameData(packets: List<IntArray>): IntArray {
        val d = IntArray(DATA_BYTES); var p = 0
        for (k in packets) { k.copyInto(d, p); p += k.size }
        return d
    }

    /** One EGC broadcast, as far as it has come in. */
    data class EgcMessage(
        val key: String, val service: Int, val serviceName: String, val priority: Int, val priorityName: String, val area: String, val seq: Int,
        val text: String, val parts: Int, val complete: Boolean, val encrypted: Boolean, val firstMs: Long, val lastMs: Long, val repeats: Int, val frame: Int,
    )

    data class Stats(val frames: Int = 0, val packets: Int = 0, val badPackets: Int = 0, val egc: Int = 0, val other: Int = 0, val frameNo: Int = -1, val score: Double = 0.0, val ber: Double = 0.0)

    /** STD-C NCS TDM: soft symbols in, frames, packets and EGC messages out. */
    class Decoder {
        var now: () -> Long = { System.currentTimeMillis() }
        var onMessage: ((EgcMessage) -> Unit)? = null
        @Volatile var stats = Stats(); private set
        private val sync = LbandFrame.Sync(LAYOUT, { d, s, b -> frame(d, s, b) })
        private class Building(val key: String, val service: Int, val seq: Int, val firstMs: Long, val frame: Int) {
            var priority = 0; var area = ""; var encrypted = false; var lastMs = firstMs; var repeats = 0; var lastPart = -1
            val pieces = HashMap<Int, String>()
        }
        private val msgs = LinkedHashMap<String, Building>()

        fun push(soft: Double) = sync.push(soft)
        fun reset() = sync.reset()
        @Synchronized fun clear() = msgs.clear()

        /** Newest first. */
        @Synchronized fun messages(): List<EgcMessage> = msgs.values.sortedByDescending { it.lastMs }.map { out(it) }

        /** One frame's data bytes (tests and tools can call this directly). */
        fun frame(d: IntArray, score: Double, ber: Double) {
            var st = stats.copy(frames = stats.frames + 1, score = score, ber = ber)
            var pos = 0
            while (pos < d.size) {
                if (d[pos] == 0) break
                val len = packetLength(d, pos, d.size)
                if (len < 3 || pos + len > d.size) { st = st.copy(badPackets = st.badPackets + 1); break }
                if (!fletcherOk(d, pos, len)) { st = st.copy(badPackets = st.badPackets + 1); pos += len; continue }
                st = st.copy(packets = st.packets + 1)
                val p = d.copyOfRange(pos, pos + len)
                when (p[0]) {
                    0x7D -> st = st.copy(frameNo = (p[2] shl 8) or p[3])
                    0xB1, 0xB2 -> { st = st.copy(egc = st.egc + 1); stats = st; egc(p) }
                    else -> st = st.copy(other = st.other + 1)
                }
                pos += len
            }
            stats = st
        }

        private fun egc(p: IntArray) {
            val end = p.size - 2
            val service: Int; val seq: Int; val part: Int; val text: List<Int>
            var priority = -1; var presentation = 0; var address: List<Int> = emptyList()
            if (p[0] == 0xB1) {
                if (end < 8) return
                service = p[2]; seq = (p[4] shl 8) or p[5]; part = p[6]
                val al = p[7]
                if (8 + al > end) return
                priority = p[3] shr 6; presentation = p[3] and 0x3F; address = p.slice(8 until 8 + al)
                text = p.slice(8 + al until end)
            } else {
                if (end < 6) return
                seq = (p[2] shl 8) or p[3]; service = p[4]; part = p[5]
                text = p.slice(6 until end)
            }
            val key = "$service:$seq"; val now = now()
            val m = synchronized(this) {
                val b = msgs.getOrPut(key) { Building(key, service, seq, now, stats.frameNo) }
                if (msgs.size > 200) msgs.values.minByOrNull { it.lastMs }?.let { msgs.remove(it.key) }
                b.lastMs = now
                if (priority >= 0) { b.priority = priority; b.area = areaText(service, address); b.encrypted = presentation != 0 }
                val k = part and 0x7F
                // a broadcast is sent again a few minutes later: a part already held is a repeat
                if (b.pieces.containsKey(k)) { if (k == 0) b.repeats++ }
                else b.pieces[k] = buildString { for (c in text) { val x = c and 0x7F; if (x == 0x0A || x == 0x0D || (x in 0x20 until 0x7F)) append(x.toChar()) } }
                if (part and 0x80 != 0) b.lastPart = k
                out(b)
            }
            onMessage?.invoke(m)
        }

        private fun out(b: Building): EgcMessage {
            val complete = b.lastPart >= 0 && b.pieces.size == b.lastPart + 1
            val text = if (b.encrypted) "" else b.pieces.keys.sorted().joinToString("") { b.pieces[it]!! }.replace("\r\n", "\n").replace('\r', '\n').trim()
            return EgcMessage(b.key, b.service, serviceName(b.service), b.priority, PRIORITY_NAMES[b.priority], b.area, b.seq, text, b.pieces.size, complete,
                b.encrypted, b.firstMs, b.lastMs, b.repeats, b.frame)
        }
    }
}
