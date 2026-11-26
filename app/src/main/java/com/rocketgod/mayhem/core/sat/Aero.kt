package com.rocketgod.mayhem.core.sat

import java.util.Locale

/**
 * Inmarsat Aero P-channel (ground to aircraft, ARINC 741): A-BPSK at 600 or 1200 symbols a second, framed as in
 * LbandFrame with one UW symbol a row. A frame carries 4 (600) or 8 (1200) signal units of 12 bytes, each ten bytes
 * and a CRC-16 (CCITT, from 0xFFFF, sent high byte first). Signal units:
 * - 0x01 fill;
 * - 0x0A the GES's channel broadcast (its GES ID);
 * - 0x71 the first unit of a user data message: AES ID (the aircraft's 24-bit ICAO address), GES ID, reference
 *   number, how many units follow, then its first 3 data bytes;
 * - 0xC0 + n the units that follow (n from 1): the reference number and 8 data bytes each.
 * The data is an ACARS block (mode, registration, ack, label, block ID, STX, text, ETX), which comes out as the ACARS
 * app's message line with SAT in front, so Flight Msgs reads it as a satellite message.
 *
 * Twin of web/src/dsp/lband/aero.ts.
 */
object Aero {
    private val UW = LbandFrame.uwBits(0xD59BB49CL, 0x5E51841EL)
    fun layout(rate: Int) = LbandFrame.Layout(UW, 1, if (rate == 600) 13 else 25)
    fun units(rate: Int) = if (rate == 600) 4 else 8
    const val SU_BYTES = 12

    fun crc16Ccitt(b: IntArray, at: Int, n: Int): Int {
        var c = 0xFFFF
        for (i in 0 until n) {
            c = c xor (b[at + i] shl 8)
            for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF
        }
        return c
    }
    /** Transmitter side (tests, tools): ten bytes to a signal unit with its CRC. */
    fun signalUnit(b: List<Int>): IntArray {
        val u = IntArray(12); for (i in 0 until minOf(10, b.size)) u[i] = b[i]
        val c = crc16Ccitt(u, 0, 10); u[10] = c shr 8; u[11] = c and 0xFF
        return u
    }
    private fun oddParity(c: Int): Int { var n = 0; for (i in 0 until 7) n += (c shr i) and 1; return if (n % 2 == 0) c or 0x80 else c }
    /** An ACARS uplink block's signal units: the first, then the rest. */
    fun acarsUnits(aes: Int, ges: Int, ref: Int, reg: String, label: String, blk: String, text: String): List<IntArray> {
        val body = ("2" + reg.padStart(7, '.') + "\u0015" + label + blk + "\u0002" + text + "\u0003").map { oddParity(it.code) }
        val n = (maxOf(0, body.size - 3) + 7) / 8
        val out = ArrayList<IntArray>()
        out.add(signalUnit(listOf(0x71, aes shr 16, (aes shr 8) and 0xFF, aes and 0xFF, ges, ref, n) + body.take(3)))
        for (k in 1..n) out.add(signalUnit(listOf(0xC0 or k, ref) + body.subList(minOf(body.size, 3 + 8 * (k - 1)), minOf(body.size, 3 + 8 * k))))
        return out
    }

    /** An AES ID (ICAO address) as six hex digits. */
    fun aesHex(v: Int) = "%06X".format(v)

    private const val STX = 0x02; private const val ETX = 0x03; private const val ETB = 0x17; private const val DEL = 0x7F

    /** An ACARS block as the ACARS app's line (SAT in front); null when it is not one. */
    fun acarsLine(mhz: String, raw: List<Int>): String? {
        val b = raw.map { it and 0x7F }; val n = b.size
        if (n < 12 || b[0] < 0x20) return null
        fun ch(i: Int) = b[i].toChar()
        val mode = ch(0)
        val reg = (1..7).map { ch(it) }.joinToString("").trim('.', ' ')
        val ack = if (b[8] == 0x15) "NAK" else ch(8).toString()
        val label = "${ch(9)}${if (b[10] == DEL) 'd' else ch(10)}"
        val blk = ch(11)
        var p = 12
        if (b[p] == STX) p++
        val text = StringBuilder()
        while (p < n) {
            val c = b[p++]; if (c == ETX || c == ETB) break
            text.append(if (c in 0x20..0x7e) c.toChar() else if (c == 0x0a || c == 0x0d) ' ' else '·')
        }
        val head = "SAT $mhz ↑ $reg  $label  blk $blk  ack $ack${if (mode != '2') "  mode $mode" else ""}"
        val body = text.toString().trim()
        return if (body.isNotEmpty()) "$head\n$body" else head
    }

    data class Stats(val frames: Int = 0, val units: Int = 0, val badUnits: Int = 0, val messages: Int = 0, val ges: Int = -1, val score: Double = 0.0, val ber: Double = 0.0)

    /** Aero P-channel: soft symbols in, signal units and ACARS lines out. */
    class Decoder(val rate: Int) {
        /** The channel, for the lines. */
        @Volatile var hz = 0L
        /** An ACARS line, and the aircraft's ICAO address it was sent to. */
        var onAcars: ((String, Int) -> Unit)? = null
        @Volatile var stats = Stats(); private set
        private val sync = LbandFrame.Sync(layout(rate), { d, s, b -> frame(d, s, b) })
        private class Open(val aes: Int, val want: Int) { val parts = HashMap<Int, List<Int>>() }
        private val open = LinkedHashMap<Int, Open>()

        fun push(soft: Double) = sync.push(soft)
        fun reset() { sync.reset(); open.clear() }

        fun frame(d: IntArray, score: Double, ber: Double) {
            stats = stats.copy(frames = stats.frames + 1, score = score, ber = ber)
            for (u in 0 until units(rate)) {
                val at = u * SU_BYTES
                if (crc16Ccitt(d, at, 10) != ((d[at + 10] shl 8) or d[at + 11])) { stats = stats.copy(badUnits = stats.badUnits + 1); continue }
                stats = stats.copy(units = stats.units + 1)
                unit(d.copyOfRange(at, at + 10).toList())
            }
        }

        private fun unit(b: List<Int>) {
            val t = b[0]
            if (t == 0x0A) { stats = stats.copy(ges = b[1]); return }
            if (t == 0x71) {
                val aes = (b[1] shl 16) or (b[2] shl 8) or b[3]; val ref = b[5]
                stats = stats.copy(ges = b[4])
                val o = Open(aes, b[6]); o.parts[0] = b.subList(7, 10)
                open[ref] = o
                if (open.size > 32) open.remove(open.keys.first())
                check(ref)
                return
            }
            if (t and 0xC0 == 0xC0) {
                val o = open[b[1]] ?: return
                o.parts[t and 0x3F] = b.subList(2, 10); check(b[1])
            }
        }

        private fun check(ref: Int) {
            val o = open[ref] ?: return
            if (o.parts.size < o.want + 1) return
            open.remove(ref)
            val data = ArrayList<Int>()
            for (k in 0..o.want) data.addAll(o.parts[k] ?: return)
            val line = acarsLine(String.format(Locale.US, "%.3f", hz / 1e6), data) ?: return
            stats = stats.copy(messages = stats.messages + 1)
            onAcars?.invoke(line, o.aes)
        }
    }
}
