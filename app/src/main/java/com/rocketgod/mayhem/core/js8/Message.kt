package com.rocketgod.mayhem.core.js8

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The JS8 message layer: what a frame's 72 bits carry, how frames make a transmission, and what the assembled
 * text means. Twin of web/src/dsp/js8/message.ts.
 *
 * Frame types (first bits of the 72): 000 heartbeat, 001 compound callsign, 010 compound directed, 011 directed,
 * 10 data (character code of the User Guide's Appendix A), 11 dictionary-compressed data.
 * Directed frame: type(3) from(28) to(28) command(5) extra(8). Callsigns use the 28-bit packing of the EME 2000
 * paper (JT65). Data frames end with a 0 and then 1s to the end of the frame, so 69 bits carry characters.
 */
data class Js8Frame(
    /** heartbeat, compound, compoundDirected, directed, data or compressed. */
    val kind: String,
    val flags: Int,
    val from: String? = null,
    val to: String? = null,
    val cmd: Int? = null,
    val extra: Int? = null,
    /** SNR carried in a directed frame, dB. */
    val snr: Int? = null,
    /** Characters a data frame carries; for a directed frame, its rendered head ("K1ABC: W9XYZ HEARTBEAT SNR -12"). */
    val text: String? = null,
)

/** What an assembled message means. */
data class Js8Meaning(
    /** heartbeat, hbsnr, cq, allcall, group, directed, snr, query, msg, msgto, querymsgs, querymsg, ack, relay or text. */
    val kind: String,
    val from: String,
    /** A callsign, @ALLCALL, @HB or @GROUP, or "" for plain text. */
    val to: String,
    val body: String,
    val snr: Int? = null,
    val grid: String? = null,
    /** Relay hops after the first addressee, in order. */
    val path: List<String>? = null,
    /** Final addressee of a MSG TO: or a relay. */
    val dest: String? = null,
    val msgId: Int? = null,
    val command: String? = null,
    /** For checksummed commands: whether the text's checksum matched (null when none was sent). */
    val checked: Boolean? = null,
)

class FramePart(val frame: Js8Frame, val mode: Js8Speed, val hz: Double, val slotMs: Long, val snr: Int, val dt: Double)
data class Js8Message(
    val id: String, val mode: Js8Speed, val hz: Int, val startMs: Long, val endMs: Long, val snr: Int, val dt: Double,
    val frames: Int, val text: String, val complete: Boolean, val meaning: Js8Meaning,
)

object Js8Msg {
    /** Directed commands whose 5-bit codes are established. */
    const val CMD_TEXT = 31
    const val CMD_HB_SNR = 29

    // ---- bits ---------------------------------------------------------------------------------------------------------
    private fun getBits(p: ByteArray, at: Int, n: Int): Int { var v = 0; for (i in 0 until n) v = v * 2 + p[at + i]; return v }
    private fun putBits(p: ByteArray, at: Int, n: Int, v0: Int) { var v = v0; for (i in n - 1 downTo 0) { p[at + i] = (v % 2).toByte(); v /= 2 } }

    // ---- callsigns (28 bits) -------------------------------------------------------------------------------------------
    private const val A37 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ "
    private const val A36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val A27 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ "
    const val NBASE = 37 * 36 * 10 * 27 * 27 * 27
    private val STD1 = Regex("^[A-Z0-9][A-Z0-9][0-9][A-Z]{0,3}$")
    private val STD2 = Regex("^[A-Z][0-9][A-Z]{0,3}$")
    /** A standard callsign (one or two characters, a digit, up to three letters) → 28 bits, or -1. */
    fun packCall(raw: String): Int {
        val c = raw.trim().uppercase()
        val s = when {
            STD1.matches(c) -> c.padEnd(6)
            STD2.matches(c) -> (" $c").padEnd(6)
            else -> return -1
        }
        val i0 = A37.indexOf(s[0]); val i1 = A36.indexOf(s[1]); val i2 = s[2] - '0'; val i3 = A27.indexOf(s[3]); val i4 = A27.indexOf(s[4]); val i5 = A27.indexOf(s[5])
        if (i0 < 0 || i1 < 0 || i3 < 0 || i4 < 0 || i5 < 0) return -1
        return ((((i0 * 36 + i1) * 10 + i2) * 27 + i3) * 27 + i4) * 27 + i5
    }
    /** 28 bits → the callsign, or `#n` above the standard range (groups and other special values). */
    fun unpackCall(n0: Int): String {
        if (n0 >= NBASE) return "#${n0 - NBASE}"
        var n = n0; val c = CharArray(6)
        c[5] = A27[n % 27]; n /= 27; c[4] = A27[n % 27]; n /= 27; c[3] = A27[n % 27]; n /= 27
        c[2] = '0' + n % 10; n /= 10; c[1] = A36[n % 36]; n /= 36; c[0] = A37[n]
        return String(c).trim()
    }
    fun isStandardCall(c: String): Boolean = packCall(c) >= 0

    // ---- SNR in the extra byte -------------------------------------------------------------------------------------------
    /** The low 6 bits hold SNR + 31 (0 = no number), -30..+30 dB. */
    fun snrToExtra(snr: Double): Int = max(-30, min(30, snr.roundToInt())) + 31
    fun snrToExtra(snr: Int): Int = snrToExtra(snr.toDouble())
    fun extraToSnr(x: Int): Int? { val v = x and 63; return if (v == 0) null else v - 31 }

    // ---- character code ---------------------------------------------------------------------------------------------------
    fun encodable(ch: Char): Boolean = JS8_HUFFMAN.containsKey(ch.toString())
    private val WS = Regex("\\s+")
    /** Text as the data frames would carry it: upper case, characters the code has. */
    fun cleanText(t: String): String = t.uppercase().replace(WS, " ").filter { encodable(it) }
    const val DATA_BITS = 69
    fun codeBits(t: String): Int = t.sumOf { JS8_HUFFMAN[it.toString()]?.length ?: 0 }

    // ---- frames ---------------------------------------------------------------------------------------------------------
    fun unpackFrame(f: Frame): Js8Frame {
        // Every frame type is read by the protocol layer; its text is what JS8 shows for that frame.
        val d = Js8Varicode.decodeFrame(f) ?: return Js8Frame("data", f.flags, text = "")
        val p = f.payload
        val directed = d.kind == "directed"
        return Js8Frame(d.kind, f.flags, d.from, d.to, if (directed) getBits(p, 59, 5) else null, if (directed) getBits(p, 64, 8) else null, d.snr, d.text)
    }

    fun packDirected(from: String, to: String, cmd: Int, extra: Int, flags: Int): Frame? {
        val a = packCall(from); val b = packCall(to)
        if (a < 0 || b < 0 || cmd < 0 || cmd > 31) return null
        val p = ByteArray(72)
        putBits(p, 0, 3, 3); putBits(p, 3, 28, a); putBits(p, 31, 28, b); putBits(p, 59, 5, cmd); putBits(p, 64, 8, extra and 0xFF)
        return Frame(p, flags)
    }
    class Packed(val frame: Frame, val used: Int)
    /** As many characters of [t] as fit one data frame; returns the frame and how many characters it took. */
    fun packData(t: String, flags: Int): Packed {
        val p = ByteArray(72); p[0] = 1; p[1] = 0
        var at = 2; var used = 0
        for (ch in t) {
            val c = JS8_HUFFMAN[ch.toString()]
            if (c == null) { used++; continue }
            if (at + c.length > 2 + DATA_BITS) break
            for (b in c) p[at++] = if (b == '1') 1 else 0
            used++
        }
        p[at++] = 0; while (at < 72) p[at++] = 1
        return Packed(Frame(p, flags), used)
    }
    /** Text → data frames (flags not set). */
    fun dataFrames(t: String): List<Frame> {
        val out = ArrayList<Frame>(); var rest = cleanText(t)
        while (rest.isNotEmpty()) { val pk = packData(rest, 0); out += pk.frame; rest = rest.drop(max(1, pk.used)) }
        return out
    }

    sealed class Compose {
        class Directed(val from: String, val to: String, val text: String) : Compose()
        class HbSnr(val from: String, val to: String, val snr: Int) : Compose()
        class Text(val text: String) : Compose()
    }
    /** A message → its frames in order, the first and last flagged. Null when a callsign cannot be sent this way. */
    fun buildFrames(c: Compose): List<Frame>? {
        val frames: List<Frame> = when (c) {
            is Compose.HbSnr -> listOf(packDirected(c.from, c.to, CMD_HB_SNR, snrToExtra(c.snr), 0) ?: return null)
            is Compose.Directed -> listOf(packDirected(c.from, c.to, CMD_TEXT, 0, 0) ?: return null) + dataFrames(c.text)
            is Compose.Text -> dataFrames(c.text).ifEmpty { return null }
        }
        frames[0].flags = frames[0].flags or Js8Codec.FLAG_FIRST; frames[frames.size - 1].flags = frames[frames.size - 1].flags or Js8Codec.FLAG_LAST
        return frames
    }

    // ---- assembled text: what a message means --------------------------------------------------------------------------
    /** Buffered commands carry a checksum after their text: a 16-bit one as 3 characters, a 32-bit one as 6. */
    private val CHECKSUM_TAIL = Regex("^(.*\\S)\\s+(\\S{3}|\\S{6})$", RegexOption.DOT_MATCHES_ALL)
    private fun stripChecksum(body: String): Pair<String, Boolean?> {
        val m = CHECKSUM_TAIL.find(body) ?: return body to null
        val text = m.groupValues[1]; val sum = m.groupValues[2]
        if (sum.length == 3 && Js8Varicode.checksum16(text) == sum) return text to true
        if (sum.length == 6 && Js8Varicode.checksum32(text) == sum) return text to true
        return body to null
    }
    private val QUERIES = listOf("SNR?", "GRID?", "INFO?", "STATUS?", "HEARING?", "AGN?", "QSL?", "HW CPY?")
    private val GRID_RE = Regex("^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$", RegexOption.IGNORE_CASE)
    private val HEAD_RE = Regex("^([A-Z0-9/]+):\\s*(.*)$", RegexOption.DOT_MATCHES_ALL)
    private val RELAY_RE = Regex("^([A-Z0-9/@]+)>((?:[A-Z0-9/@]+>)*)(.*)$", RegexOption.DOT_MATCHES_ALL)
    private val WORD_SPACE = Regex("^\\S+\\s")
    private val CQ_RE = Regex("^CQ\\b")
    private val TO_RE = Regex("^@?[A-Z0-9/]+$")
    private val HBSNR_RE = Regex("^HEARTBEAT SNR\\b")
    private val HBSNR_NUM = Regex("HEARTBEAT SNR ([+-]\\d+)")
    private val MSGID = Regex("\\bMSG (\\d+)")
    private val HEARTBEAT_RE = Regex("^HEARTBEAT\\b")
    private val HB_RE = Regex("^HB\\b")
    private val MSGTO = Regex("^MSG TO:\\s*([A-Z0-9/]+)\\s*(.*)$", RegexOption.DOT_MATCHES_ALL)
    private val MSG = Regex("^MSG\\s+(.*)$", RegexOption.DOT_MATCHES_ALL)
    private val QMSGS = Regex("^QUERY MSGS\\b")
    private val QMSG = Regex("^QUERY MSG\\s+(\\d+)")
    private val ACK = Regex("^ACK\\b")
    private val SNR = Regex("^SNR\\s+([+-]?\\d+)")
    private val GT_SPACE = Regex(">\\s+")
    private fun num(s: String): Int = s.removePrefix("+").toInt()

    /**
     * Reads an assembled message the way the User Guide writes them: "FROM: TO COMMAND ..." for directed traffic,
     * "FROM: @GROUP ...", heartbeats "FROM: @HB HEARTBEAT GRID", relays "FROM: HOP>HOP>TEXT", the inbox commands
     * MSG, MSG TO:CALL, QUERY MSGS, QUERY MSG n, and ACK.
     */
    fun parseMessage(text: String): Js8Meaning {
        val t = text.replace("♢", "").replace(GT_SPACE, ">").trim()
        val m = HEAD_RE.find(t) ?: return Js8Meaning("text", "", "", t)
        val from = m.groupValues[1]; var rest = m.groupValues[2].trim()
        var out = Js8Meaning("text", from, "", rest)
        // relay: HOP>HOP>TEXT
        val rl = RELAY_RE.find(rest)
        if (rl != null && !WORD_SPACE.containsMatchIn(rest.substring(0, rest.indexOf('>')))) {
            val hops = rl.groupValues[2].split('>').filter { it.isNotEmpty() }
            return Js8Meaning("relay", from, rl.groupValues[1], rl.groupValues[3].trim(), path = hops, dest = if (hops.isNotEmpty()) hops.last() else rl.groupValues[1])
        }
        val sp = rest.indexOf(' ')
        val first = if (sp < 0) rest else rest.substring(0, sp); val after = if (sp < 0) "" else rest.substring(sp + 1).trim()
        if (CQ_RE.containsMatchIn(rest)) { val g = rest.split(WS).firstOrNull { GRID_RE.matches(it) }; return Js8Meaning("cq", from, "@CQ", rest, grid = g) }
        if (!TO_RE.matches(first)) return out
        rest = after
        out = out.copy(to = first, body = rest)
        val words = rest.split(WS).filter { it.isNotEmpty() }
        val grid = words.firstOrNull { GRID_RE.matches(it) }
        if (HBSNR_RE.containsMatchIn(rest)) {
            val s = HBSNR_NUM.find(rest); val id = MSGID.find(rest)
            return out.copy(kind = "hbsnr", snr = s?.let { num(it.groupValues[1]) }, msgId = id?.let { it.groupValues[1].toInt() }, command = "HEARTBEAT SNR")
        }
        if (first == "@HB" || HEARTBEAT_RE.containsMatchIn(rest) || HB_RE.containsMatchIn(rest)) return out.copy(kind = "heartbeat", grid = grid, command = "HEARTBEAT")
        MSGTO.find(rest)?.let { mm -> val (b, ok) = stripChecksum(mm.groupValues[2].trim()); return out.copy(kind = "msgto", dest = mm.groupValues[1], body = b, checked = ok, command = "MSG TO:") }
        MSG.find(rest)?.let { mm -> val (b, ok) = stripChecksum(mm.groupValues[1].trim()); return out.copy(kind = "msg", body = b, checked = ok, command = "MSG") }
        if (QMSGS.containsMatchIn(rest)) return out.copy(kind = "querymsgs", body = "", command = "QUERY MSGS")
        QMSG.find(rest)?.let { mm -> return out.copy(kind = "querymsg", msgId = mm.groupValues[1].toInt(), body = "", command = "QUERY MSG") }
        if (ACK.containsMatchIn(rest)) return out.copy(kind = "ack", command = "ACK")
        SNR.find(rest)?.let { mm -> return out.copy(kind = "snr", snr = num(mm.groupValues[1]), command = "SNR") }
        val q = QUERIES.firstOrNull { rest == it || rest.startsWith("$it ") }
        if (q != null) return out.copy(kind = "query", command = q)
        if (first == "@ALLCALL" && CQ_RE.containsMatchIn(rest)) return out.copy(kind = "cq", to = "@CQ", grid = grid)
        if (first == "@ALLCALL") return out.copy(kind = "allcall", grid = grid)
        if (first.startsWith("@")) return out.copy(kind = "group", grid = grid)
        return out.copy(kind = "directed", grid = grid)
    }
}

/**
 * Joins frames into transmissions: the same speed, within a few tones of the same offset, in consecutive slots,
 * from a first-flagged frame to a last-flagged one. A transmission with no frame for a minute is closed as it is.
 */
class Js8Assembler {
    private class Open(val id: String, val mode: Js8Speed, var hz: Double, val startMs: Long, var lastMs: Long, val period: Int,
                       val snr: ArrayList<Int> = ArrayList(), val dt: ArrayList<Double> = ArrayList(), var body: StringBuilder = StringBuilder(), var frames: Int = 0)
    private val open = ArrayList<Open>()
    private var seq = 0
    var onMessage: (Js8Message) -> Unit = {}
    fun push(p: FramePart, periodS: Int, toneHz: Double) {
        val f = p.frame
        var o = open.firstOrNull { it.mode == p.mode && kotlin.math.abs(it.hz - p.hz) <= 4 * toneHz && p.slotMs > it.lastMs && p.slotMs - it.lastMs <= 2 * periodS * 1000L + 500 }
        if (o != null && (f.flags and Js8Codec.FLAG_FIRST) != 0) { close(o, false); o = null }
        if (o == null) {
            o = Open("${p.mode.id}-${p.slotMs}-${p.hz.roundToInt()}-${seq++}", p.mode, p.hz, p.slotMs, p.slotMs, periodS)
            open += o
        }
        o.lastMs = p.slotMs; o.frames++; o.snr += p.snr; o.dt += p.dt; o.hz = (o.hz * (o.frames - 1) + p.hz) / o.frames
        o.body.append(f.text ?: "")
        if ((f.flags and Js8Codec.FLAG_LAST) != 0) close(o, true)
        else emit(o, false)
    }
    /** Close transmissions that have gone quiet. */
    fun tick(nowMs: Long) { for (o in open.toList()) if (nowMs - o.lastMs > max(60_000L, 3L * o.period * 1000)) close(o, false) }
    private val ws = Regex("\\s+")
    private fun text(o: Open): String = o.body.toString().replace(ws, " ").trim()
    private fun emit(o: Open, complete: Boolean) {
        val text = text(o)
        val snr = o.snr.sum().toDouble() / max(1, o.snr.size); val dt = o.dt.sum() / max(1, o.dt.size)
        onMessage(Js8Message(o.id, o.mode, o.hz.roundToInt(), o.startMs, o.lastMs, snr.roundToInt(), (dt * 10).roundToInt() / 10.0, o.frames, text, complete, Js8Msg.parseMessage(text)))
    }
    private fun close(o: Open, complete: Boolean) { open.remove(o); emit(o, complete) }
}
