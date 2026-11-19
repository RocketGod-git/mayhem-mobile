package com.rocketgod.mayhem.core.js8

import java.io.InputStream
import java.util.zip.GZIPInputStream
import kotlin.math.max
import kotlin.math.min

/**
 * The JS8 protocol's message layer: how callsigns, groups, grids, commands and text are packed into the 72 bits of
 * a frame, and how a typed line becomes frames. Formats and tables follow the JS8 protocol (JS8Call 2.x).
 * Twin of web/src/dsp/js8/varicode.ts.
 *
 * Bits are handled as lists of 0/1, most significant first. The 72 bits of a frame are the LDPC message's payload.
 */
object Js8Varicode {
    // ---- tables -----------------------------------------------------------------------------------------------------
    /** Directed commands as typed (with their leading space where JS8 has one) and their 5-bit codes. */
    val DIRECTED_CMDS: List<Pair<String, Int>> = listOf(
        " HEARTBEAT" to -1, " HB" to -1, " CQ" to -1,
        " SNR?" to 0, "?" to 0, " DIT DIT" to 1, " HEARING?" to 3, " GRID?" to 4, ">" to 5, " STATUS?" to 6, " STATUS" to 7,
        " HEARING" to 8, " MSG" to 9, " MSG TO:" to 10, " QUERY" to 11, " QUERY MSGS" to 12, " QUERY MSGS?" to 12,
        " QUERY CALL" to 13, " GRID" to 15, " INFO?" to 16, " INFO" to 17, " FB" to 18, " HW CPY?" to 19, " SK" to 20,
        " RR" to 21, " QSL?" to 22, " QSL" to 23, " CMD" to 24, " SNR" to 25, " NO" to 26, " YES" to 27, " 73" to 28,
        " NACK" to 2, " ACK" to 14, " HEARTBEAT SNR" to 29, " AGN?" to 30, "  " to 31, " " to 31,
    )
    private val CMD_CODE: Map<String, Int> = LinkedHashMap<String, Int>().apply { for ((k, v) in DIRECTED_CMDS) put(k, v) }
    /** The name a received code shows as. */
    val CMD_NAME: List<String> = listOf(
        " SNR?", " DIT DIT", " NACK", " HEARING?", " GRID?", ">", " STATUS?", " STATUS", " HEARING", " MSG", " MSG TO:",
        " QUERY", " QUERY MSGS", " QUERY CALL", " ACK", " GRID", " INFO?", " INFO", " FB", " HW CPY?", " SK", " RR", " QSL?",
        " QSL", " CMD", " SNR", " NO", " YES", " 73", " HEARTBEAT SNR", " AGN?", " ",
    )
    val BUFFERED_CMDS = setOf(5, 9, 10, 11, 12, 13, 15, 24)
    val CHECKSUM_CMDS = mapOf(5 to 16, 9 to 16, 10 to 16, 11 to 16, 12 to 16, 13 to 16, 15 to 0, 24 to 16)
    private val SNR_CMDS = setOf(25, 29)

    /** 37*36*10*27*27*27: callsign values at and above this are the fixed calls and groups below. */
    const val NBASECALL = 37 * 36 * 10 * 27 * 27 * 27
    private val BASECALL_NAMES = listOf(
        "<....>", "@ALLCALL", "@JS8NET", "@DX/NA", "@DX/SA", "@DX/EU", "@DX/AS", "@DX/AF", "@DX/OC", "@DX/AN",
        "@REGION/1", "@REGION/2", "@REGION/3", "@GROUP/0", "@GROUP/1", "@GROUP/2", "@GROUP/3", "@GROUP/4", "@GROUP/5",
        "@GROUP/6", "@GROUP/7", "@GROUP/8", "@GROUP/9", "@COMMAND", "@CONTROL", "@NET", "@NTS", "@RESERVE/0",
        "@RESERVE/1", "@RESERVE/2", "@RESERVE/3", "@RESERVE/4", "@APRSIS", "@RAGCHEW", "@JS8", "@EMCOMM", "@ARES", "@MARS",
        "@AMRRON", "@RACES", "@RAYNET", "@RADAR", "@SKYWARN", "@CQ", "@HB", "@QSO", "@QSOPARTY", "@CONTEST", "@FIELDDAY",
        "@SOTA", "@IOTA", "@POTA", "@QRP", "@QRO",
    )
    val BASECALLS: Map<String, Int> = LinkedHashMap<String, Int>().apply { BASECALL_NAMES.forEachIndexed { i, n -> put(n, NBASECALL + 1 + i) } }
    private val BASECALL_OF: Map<Int, String> = BASECALLS.entries.associate { (k, v) -> v to k }
    val CQS = listOf("CQ CQ CQ", "CQ DX", "CQ QRP", "CQ CONTEST", "CQ FIELD", "CQ FD", "CQ CQ", "CQ")
    private val HBS = listOf("HB", "HB", "HB", "HB", "HB", "HB", "HB", "HB")
    /** Groups that may not be used as a user group. */
    fun isGroupAllowed(g: String): Boolean = g != "@APRSIS" && g != "@JS8NET"

    private const val ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@"
    private const val B41 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?"
    const val NBASEGRID = 180 * 180
    const val NUSERGRID = NBASEGRID + 10
    const val NMAXGRID = (1 shl 15) - 1

    // ---- bits -------------------------------------------------------------------------------------------------------
    private fun put(p: MutableList<Int>, v: Long, n: Int) { for (i in n - 1 downTo 0) p.add(((v ushr i) and 1L).toInt()) }
    private fun put(p: MutableList<Int>, v: Int, n: Int) = put(p, v.toLong(), n)
    private fun get(p: ByteArray, at: Int, n: Int): Long { var v = 0L; for (i in 0 until n) v = (v shl 1) or (if (p[at + i].toInt() != 0) 1L else 0L); return v }
    private fun getL(p: List<Int>, at: Int, n: Int): Long { var v = 0L; for (i in 0 until n) v = (v shl 1) or (if (p[at + i] != 0) 1L else 0L); return v }
    private fun toFrame(bits: List<Int>, flags: Int): Frame { val p = ByteArray(72); for (i in 0 until 72) p[i] = (bits.getOrElse(i) { 0 }).toByte(); return Frame(p, flags) }

    // ---- callsigns: 28 bits -------------------------------------------------------------------------------------------
    private val PACK_CALL_RE = Regex("([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])")
    data class Packed(val v: Int, val portable: Boolean)
    /** A standard callsign or fixed group → 28 bits and its portable (/P) flag; 0 when it cannot be packed. */
    fun packCall28(value: String): Packed {
        var c = value.uppercase().trim(); var portable = false
        BASECALLS[c]?.let { return Packed(it, portable) }
        if (c.endsWith("/P")) { c = c.dropLast(2); portable = true }
        if (c.startsWith("3DA0")) c = "3D0" + c.substring(4)
        if (c.startsWith("3X") && c.length > 2 && c[2] in 'A'..'Z') c = "Q" + c.substring(2)
        val n = c.length; if (n < 2 || n > 6) return Packed(0, portable)
        val perms = mutableListOf(c)
        if (n == 2) perms += " $c   "
        if (n == 3) { perms += " $c  "; perms += "$c   " }
        if (n == 4) { perms += " $c "; perms += "$c  " }
        if (n == 5) { perms += " $c"; perms += "$c " }
        var m = ""
        for (p in perms) { val r = PACK_CALL_RE.find(p); if (r != null) m = r.value }
        if (m.length < 6) return Packed(0, portable)
        fun ix(k: Int) = ALNUM.indexOf(m[k])
        var v = ix(0); v = 36 * v + ix(1); v = 10 * v + ix(2); v = 27 * v + ix(3) - 10; v = 27 * v + ix(4) - 10; v = 27 * v + ix(5) - 10
        return Packed(v, portable)
    }
    fun unpackCall28(value: Int, portable: Boolean): String {
        BASECALL_OF[value]?.let { return it }
        val w = CharArray(6)
        var v = value
        w[5] = ALNUM[v % 27 + 10]; v /= 27
        w[4] = ALNUM[v % 27 + 10]; v /= 27
        w[3] = ALNUM[v % 27 + 10]; v /= 27
        w[2] = ALNUM[v % 10]; v /= 10
        w[1] = ALNUM[v % 36]; v /= 36
        w[0] = if (v in ALNUM.indices) ALNUM[v] else ' '
        var c = String(w)
        if (c.startsWith("3D0")) c = "3DA0" + c.substring(3)
        if (c.startsWith("Q") && c[1] in 'A'..'Z') c = "3X" + c.substring(1)
        if (portable) c = c.trim() + "/P"
        return c.trim()
    }

    // ---- compound callsigns and groups: 50 bits ----------------------------------------------------------------------
    fun pack50(value: String): Long {
        var w = value.replace(Regex("[^A-Z0-9 /@]"), "")
        if (w.length > 3 && w[3] != '/') w = w.substring(0, 3) + " " + w.substring(3)
        if (w.length > 7 && w[7] != '/') w = w.substring(0, 7) + " " + w.substring(7)
        w = w.padEnd(11, ' ')
        fun ix(k: Int) = max(0, ALNUM.indexOf(w[k])).toLong()
        var v = ix(0)
        v = v * 38 + ix(1); v = v * 38 + ix(2); v = v * 2 + (if (w[3] == '/') 1 else 0)
        v = v * 38 + ix(4); v = v * 38 + ix(5); v = v * 38 + ix(6); v = v * 2 + (if (w[7] == '/') 1 else 0)
        v = v * 38 + ix(8); v = v * 38 + ix(9); v = v * 38 + ix(10)
        return v
    }
    fun unpack50(packed: Long): String {
        val w = CharArray(11); var v = packed
        fun take(r: Long): Int { val d = v % r; v /= r; return d.toInt() }
        fun an(i: Int): Char = if (i in ALNUM.indices) ALNUM[i] else ' '
        w[10] = an(take(38)); w[9] = an(take(38)); w[8] = an(take(38)); w[7] = if (take(2) != 0) '/' else ' '
        w[6] = an(take(38)); w[5] = an(take(38)); w[4] = an(take(38)); w[3] = if (take(2) != 0) '/' else ' '
        w[2] = an(take(38)); w[1] = an(take(38)); w[0] = an(take(39))
        return String(w).replace(" ", "")
    }

    // ---- grids: 15 bits -----------------------------------------------------------------------------------------------
    /** A 4-character locator → 15 bits (NMAXGRID when there is none). Longitude is counted west-positive, as JS8 does. */
    fun packGrid(value: String): Int {
        val g = value.trim().uppercase()
        if (g.length < 4) return NMAXGRID
        val dlong = 180 - 20 * (g[0].code - 65) - 2 * (g[2].code - 48) - (5 * (12 + 0.5)) / 60
        val dlat = -90 + 10 * (g[1].code - 65) + (g[3].code - 48) + (2.5 * (12 + 0.5)) / 60
        val ilong = dlong.toInt(); val ilat = (dlat + 90).toInt()
        return ((ilong + 180) / 2) * 180 + ilat
    }
    fun unpackGrid(value: Int): String {
        if (value > NBASEGRID) return ""
        val dlat = (value % 180) - 90
        var dlong = Math.floorDiv(value, 180) * 2 - 180 + 2
        if (dlong < -180) dlong += 360; if (dlong > 180) dlong -= 360
        val nlong = ((60.0 * (180 - dlong)) / 5).toInt()
        val n1 = nlong / 240; val n2 = (nlong - 240 * n1) / 24
        val nlat = ((60.0 * (dlat + 90)) / 2.5).toInt()
        val m1 = nlat / 240; val m2 = (nlat - 240 * m1) / 24
        return charArrayOf((65 + n1).toChar(), (65 + m1).toChar(), (48 + n2).toChar(), (48 + m2).toChar()).concatToString()
    }

    // ---- numbers and commands -------------------------------------------------------------------------------------------
    /** A number or SNR → 6 bits (0 means none). */
    fun packNum(num: String): Pair<Int, Boolean> {
        val t = num.trim(); if (t.isEmpty() || !Regex("^[-+]?\\d+$").matches(t)) return 0 to false
        val n = t.removePrefix("+").toLongOrNull() ?: return 0 to false
        return (max(-30L, min(n, 31L)).toInt() + 31) to true
    }
    fun formatSnr(snr: Int): String = if (snr < -60 || snr > 60) "" else "${if (snr >= 0) '+' else '-'}${kotlin.math.abs(snr).toString().padStart(2, '0')}"
    private fun packCmd(cmd: Int, num: Int): Int {
        if (cmd in SNR_CMDS) return ((2 or (if (cmd == 29) 1 else 0)) shl 6) + (num and 63)
        return cmd and 127
    }
    private fun unpackCmd(value: Int): Pair<Int, Int> {
        if (value and 128 != 0) return (if (value and 64 != 0) 29 else 25) to (value and 63)
        return (value and 127) to 0
    }

    // ---- checksums ------------------------------------------------------------------------------------------------------
    private fun latin1(s: String): IntArray = IntArray(s.length) { s[it].code and 0xFF }
    fun crc16Kermit(bytes: IntArray): Int {
        var crc = 0
        for (b in bytes) { crc = crc xor b; repeat(8) { crc = if (crc and 1 != 0) (crc ushr 1) xor 0x8408 else crc ushr 1 } }
        return crc and 0xFFFF
    }
    fun crc32Bzip2(bytes: IntArray): Long {
        var crc = 0xFFFFFFFF.toInt()
        for (b in bytes) { crc = crc xor (b shl 24); repeat(8) { crc = if (crc and 0x80000000.toInt() != 0) (crc shl 1) xor 0x04C11DB7 else crc shl 1 } }
        return crc.inv().toLong() and 0xFFFFFFFFL
    }
    private fun pack16(v: Int): String = "${B41[v / 1681]}${B41[(v % 1681) / 41]}${B41[v % 41]}"
    fun checksum16(text: String): String = pack16(crc16Kermit(latin1(text))).padEnd(3, ' ')
    fun checksum32(text: String): String { val c = crc32Bzip2(latin1(text)); return (pack16((c ushr 16).toInt()) + pack16((c and 0xFFFF).toInt())).padEnd(6, ' ') }

    // ---- JSC dense coding -------------------------------------------------------------------------------------------------
    /** The JS8 dictionary: words in index order, the prefix-sorted list, and the few entries whose code covers fewer characters. */
    class Jsc(val words: Array<String>, val mapSize: Map<Int, Int>, val list: IntArray, val listSize: Map<Int, Int>, val prefix: List<Triple<String, Int, Int>>)
    @Volatile private var jsc: Jsc? = null
    private val loadLock = Any()

    /** For tests and the app's loader: hand the dictionary in directly. */
    fun setJsc(d: Jsc) { jsc = d }
    fun jscReady(): Boolean = jsc != null
    /**
     * The dictionary is large (262,144 entries): it is read once, the first time JS8 needs it, from the JSON the web
     * app uses (gzipped when [gzip]). Blocking; call it off the main thread.
     */
    fun loadJsc(open: () -> InputStream, gzip: Boolean = true) {
        if (jsc != null) return
        synchronized(loadLock) {
            if (jsc != null) return
            val text = open().use { raw -> (if (gzip) GZIPInputStream(raw, 1 shl 16) else raw).bufferedReader(Charsets.UTF_8).readText() }
            jsc = parseJsc(text)
        }
    }
    /** The dictionary's JSON: {"words": [...], "mapSize": {i: n}, "list": [...], "listSize": {li: n}, "prefix": [[ch, count, start], ...]}. */
    fun parseJsc(text: String): Jsc {
        @Suppress("UNCHECKED_CAST")
        val o = MiniJson(text).value() as Map<String, Any?>
        val words = (o["words"] as List<*>).map { it as String }.toTypedArray()
        val list = (o["list"] as List<*>).let { l -> IntArray(l.size) { (l[it] as Number).toInt() } }
        fun sizes(k: String): Map<Int, Int> = (o[k] as? Map<*, *>)?.entries?.associate { (a, b) -> (a as String).toInt() to (b as Number).toInt() } ?: emptyMap()
        val prefix = (o["prefix"] as List<*>).map { e -> val t = e as List<*>; Triple(t[0] as String, (t[1] as Number).toInt(), (t[2] as Number).toInt()) }
        return Jsc(words, sizes("mapSize"), list, sizes("listSize"), prefix)
    }

    private fun mapSize(d: Jsc, i: Int): Int = d.mapSize[i] ?: d.words[i].length
    private fun listSize(d: Jsc, li: Int): Int = d.listSize[li] ?: d.words[d.list[li]].length
    private const val JB = 4
    private const val JS = 7
    private const val JC = 16 - JS
    private fun lookup(d: Jsc, w: String): Int {
        for ((ch, count, start) in d.prefix) {
            if (w.isEmpty() || w[0].toString() != ch) continue
            if (count == 1) return d.list[start]
            for (li in start until start + count) {
                val n = listSize(d, li); val s = d.words[d.list[li]].take(n)
                if (w.startsWith(s)) return d.list[li]
            }
            return -1
        }
        return -1
    }
    private fun codeword(index: Int, sep: Boolean): List<Int> {
        val groups = ArrayDeque<List<Int>>()
        val last = ArrayList<Int>(); put(last, ((index % JS) shl 1) + (if (sep) 1 else 0), JB + 1); groups.addFirst(last)
        var x = index / JS
        while (x > 0) { x -= 1; val g = ArrayList<Int>(); put(g, (x % JC) + JS, JB); groups.addFirst(g); x /= JC }
        return groups.flatten()
    }
    class Code(val bits: List<Int>, val chars: Int)
    /** Text → codewords, each with how many characters it covers. */
    fun jscCompress(text: String): List<Code> {
        val d = jsc ?: return emptyList()
        val out = ArrayList<Code>()
        val words = text.split(' ')
        for (i in words.indices) {
            var w = words[i]; val isLastWord = i == words.size - 1; var isSpace = false
            if (w.isEmpty() && !isLastWord) { w = " "; isSpace = true }
            while (w.isNotEmpty()) {
                val idx = lookup(d, w); if (idx < 0) break
                w = w.drop(mapSize(d, idx))
                val isLast = w.isEmpty(); val sep = isLast && !isSpace && !isLastWord
                out += Code(codeword(idx, sep), mapSize(d, idx) + (if (sep) 1 else 0))
            }
        }
        return out
    }
    fun jscDecompress(bits: List<Int>): String = jscDecompress(ByteArray(bits.size) { bits[it].toByte() }, 0, bits.size)
    fun jscDecompress(bits: ByteArray, from: Int, to: Int): String {
        val d = jsc ?: return ""
        val base = LongArray(8); var pw = 1L
        for (k in 1 until 8) { base[k] = base[k - 1] + JS * pw; pw *= JC }
        val bytes = ArrayList<Int>(); val seps = ArrayDeque<Int>()
        var i = from
        while (i < to) {
            if (to - i < JB) break
            val b = get(bits, i, JB).toInt(); bytes += b; i += JB
            if (b < JS) { if (to - i > 0 && bits[i].toInt() != 0) seps.addLast(bytes.size - 1); i += 1 }
        }
        val out = StringBuilder()
        var start = 0
        while (start < bytes.size) {
            var k = 0; var j = 0L
            while (start + k < bytes.size && bytes[start + k] >= JS) { j = j * JC + (bytes[start + k] - JS); k++; if (j > Int.MAX_VALUE) break }
            if (j >= d.words.size || start + k >= bytes.size || k >= 8) break
            j = j * JS + bytes[start + k] + base[k]
            if (j >= d.words.size) break
            out.append(d.words[j.toInt()])
            if (seps.isNotEmpty() && seps.first() == start + k) { out.append(' '); seps.removeFirst() }
            start += k + 1
        }
        return out.toString()
    }

    // ---- Huffman text -------------------------------------------------------------------------------------------------
    private val HUFF_KEYS: List<String> = JS8_HUFFMAN.keys.sortedWith { a, b -> if (b.length != a.length) b.length - a.length else if (b < a) -1 else 1 }
    private fun huffEncode(text: String): List<Code> {
        val out = ArrayList<Code>()
        var i = 0
        while (i < text.length) {
            val k = HUFF_KEYS.firstOrNull { text.startsWith(it, i) }
            if (k == null) { i++; continue }
            out += Code(JS8_HUFFMAN.getValue(k).map { if (it == '1') 1 else 0 }, k.length); i += k.length
        }
        return out
    }
    private class HNode { var c: String? = null; val k = arrayOfNulls<HNode>(2) }
    private val HUFF_ROOT = HNode().also { root ->
        for ((ch, code) in JS8_HUFFMAN) { var n = root; for (b in code) { val x = if (b == '1') 1 else 0; n = n.k[x] ?: HNode().also { n.k[x] = it } }; n.c = ch }
    }
    private fun huffDecode(bits: ByteArray, from: Int, to: Int): String {
        val s = StringBuilder(); var n: HNode? = HUFF_ROOT
        for (i in from until to) { n = n?.k?.get(if (bits[i].toInt() != 0) 1 else 0); if (n == null) break; n.c?.let { s.append(it); n = HUFF_ROOT } }
        return s.toString()
    }

    // ---- data frames ------------------------------------------------------------------------------------------------------
    private fun fill(prefix: List<Int>, codes: List<Code>): Code {
        val bits = ArrayList(prefix); var chars = 0
        for (c in codes) { if (bits.size + c.bits.size < 72) { bits.addAll(c.bits); chars += c.chars; continue }; break }
        if (bits.size < 72) { bits.add(0); while (bits.size < 72) bits.add(1) }
        return Code(bits, chars)
    }
    /** Normal speed: Huffman or dictionary, whichever carries more characters (a tie goes to the dictionary). */
    private fun packData(text: String): Code {
        val huffOk = text.uppercase().all { JS8_HUFFMAN.containsKey(it.toString()) }
        val huff = if (huffOk) fill(listOf(1, 0), huffEncode(text)) else Code(emptyList(), 0)
        val comp = fill(listOf(1, 1), jscCompress(text))
        return if (huff.chars > comp.chars) huff else comp
    }
    /** Fast, Turbo and Slow: the whole frame is dictionary code (the frame is flagged as data). */
    private fun packFastData(text: String): Code = fill(emptyList(), jscCompress(text))
    private fun unpad(bits: ByteArray, from: Int): Int { var n = bits.size - 1; while (n >= from && bits[n].toInt() != 0) n--; return n }

    // ---- frames -----------------------------------------------------------------------------------------------------------
    const val FRAME_HEARTBEAT = 0
    const val FRAME_COMPOUND = 1
    const val FRAME_COMPOUND_DIRECTED = 2
    const val FRAME_DIRECTED = 3
    private fun compoundFrame(call: String, type: Int, num: Int, bits3: Int): List<Int>? {
        val pc = pack50(call); if (pc == 0L) return null
        val b = ArrayList<Int>()
        put(b, type, 3); put(b, pc, 50); put(b, (num shr 5) and 0x7FF, 11); put(b, num and 31, 5); put(b, bits3 and 7, 3)
        return b
    }

    /** One received frame, read: the text JS8 shows for it and what it carries. */
    data class Decoded(val kind: String, val text: String, val from: String? = null, val to: String? = null, val cmd: String? = null,
                       val snr: Int? = null, val grid: String? = null, val cq: String? = null)

    fun decodeFrame(f: Frame): Decoded? {
        val p = f.payload
        if (f.flags and Js8Codec.FLAG_RESERVED != 0) {
            if (jsc == null) return Decoded("compressed", "")
            return Decoded("compressed", unescape(jscDecompress(p, 0, unpad(p, 0))))
        }
        if (p[0].toInt() == 1) {
            val n = unpad(p, 2)
            if (p[1].toInt() == 1) return Decoded("compressed", if (jsc != null) unescape(jscDecompress(p, 2, n)) else "")
            return Decoded("data", unescape(huffDecode(p, 2, n)))
        }
        val type = get(p, 0, 3).toInt()
        if (type == FRAME_DIRECTED) {
            val extra = get(p, 64, 8).toInt()
            val from = unpackCall28(get(p, 3, 28).toInt(), extra and 128 != 0); val to = unpackCall28(get(p, 31, 28).toInt(), extra and 64 != 0)
            val code = get(p, 59, 5).toInt(); val cmd = CMD_NAME[code % 32]; val x = extra % 64
            val numStr = if (x == 0) "" else if (code in SNR_CMDS) formatSnr(x - 31) else (x - 31).toString()
            return Decoded("directed", "$from: $to$cmd${if (numStr.isNotEmpty()) " $numStr" else ""} ", from, to, cmd.trim(),
                if (numStr.isNotEmpty() && code in SNR_CMDS) x - 31 else null)
        }
        val call = unpack50(get(p, 3, 50))
        val num = (get(p, 53, 11).toInt() shl 5) or get(p, 64, 5).toInt()
        val bits3 = get(p, 69, 3).toInt()
        if (type == FRAME_HEARTBEAT) {
            val alt = num and 0x8000 != 0; val grid = unpackGrid(num and 0x7FFF)
            if (alt) { val cq = CQS.getOrElse(bits3) { "CQ" }; return Decoded("heartbeat", "$call: @ALLCALL $cq $grid ", call, "@ALLCALL", grid = grid.ifEmpty { null }, cq = cq) }
            val hb = HBS.getOrElse(bits3) { "HB" }
            return Decoded("heartbeat", "$call: @HB ${if (hb == "HB") "HEARTBEAT" else hb} $grid ", call, "@HB", grid = grid.ifEmpty { null })
        }
        if (type == FRAME_COMPOUND) {
            val grid = if (num <= NBASEGRID) unpackGrid(num) else ""
            return Decoded("compound", "$call: ", call, grid = grid.ifEmpty { null })
        }
        if (type == FRAME_COMPOUND_DIRECTED) {
            var extra = ""; var snr: Int? = null; var cmdName: String? = null
            if (num <= NBASEGRID) extra = " " + unpackGrid(num)
            else if (num >= NUSERGRID && num < NMAXGRID) {
                val (cmd, n) = unpackCmd(num - NUSERGRID)
                cmdName = CMD_NAME.getOrElse(cmd) { "" }
                extra = cmdName
                if (cmd in SNR_CMDS) { snr = n - 31; extra += " " + formatSnr(snr) }
            }
            return Decoded("compoundDirected", "$call$extra ", to = call, cmd = cmdName?.trim(), snr = snr)
        }
        return null
    }
    private val UNESC = Regex("(?:[uU]\\+|\\\\[uU])([0-9a-fA-F]{4})")
    fun unescape(t: String): String = UNESC.replace(t) { it.groupValues[1].toInt(16).toChar().toString() }

    // ---- callsign tests -------------------------------------------------------------------------------------------------
    private val BASE_CALL_RE = Regex("^(?:[0-9A-Z])?[0-9A-Z][0-9][A-Z]?[A-Z]?[A-Z]?(?:/P)?$")
    private val COMPOUND_RE = Regex("^@?[A-Z0-9/@][A-Z0-9/]{0,2}/?[A-Z0-9/]{0,3}/?[A-Z0-9/]{0,3}$")
    private val LETTER_DIGIT = Regex("[0-9][A-Z]|[A-Z][0-9]")
    private fun validCompound(c: String): Boolean {
        if (c.length - c.count { it == '/' } > 9) return false
        val i = c.indexOf('/'); if (i >= 0) return !BASECALLS.containsKey(c.substring(0, i))
        if (c.startsWith("@")) return true
        return c.length > 2 && LETTER_DIGIT.containsMatchIn(c)
    }
    data class CallCheck(val valid: Boolean, val compound: Boolean)
    fun isValidCallsign(c: String): CallCheck {
        if (BASECALLS.containsKey(c)) return CallCheck(true, false)
        if (BASE_CALL_RE.matches(c)) return CallCheck(c.length > 2 && LETTER_DIGIT.containsMatchIn(c), false)
        if (COMPOUND_RE.matches(c)) { val v = validCompound(c); return CallCheck(v, v) }
        return CallCheck(false, false)
    }
    fun isCompoundCallsign(c: String): Boolean {
        if (BASECALLS.containsKey(c) && !c.startsWith("@")) return false
        if (BASE_CALL_RE.matches(c)) return false
        return COMPOUND_RE.matches(c) && validCompound(c)
    }

    // ---- building frames from a typed line --------------------------------------------------------------------------------
    private const val CMD_ALT = """(?<cmd>\s?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]|QUERY MSGS[?]|HEARING[?]|(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|$))|[?> ]))?"""
    private const val NUM_ALT = """(?<num>(?<=SNR)\s?[-+]?(?:3[01]|[0-2]?[0-9]))?"""
    private val DIRECTED_RE = Regex("""^(?<callsign>[@]?[A-Z0-9/]+)""" + CMD_ALT + NUM_ALT)
    private val HEARTBEAT_RE = Regex("""^\s*(?<callsign>[@](?:ALLCALL|HB)\s+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!\s+SNR))(?:\s(?<grid>[A-R]{2}[0-9]{2}))?\b""")
    private val COMPOUND_MSG_RE = Regex("""^\s*[`](?<callsign>[@]?[A-Z0-9/]+)(?<extra>(?<grid>\s?[A-R]{2}[0-9]{2})?""" + CMD_ALT + NUM_ALT + ")")

    private class Built(val bits: List<Int>, val n: Int)
    private fun MatchResult.g(name: String): String? = runCatching { groups[name]?.value }.getOrNull()

    private fun heartbeatFrame(text: String, call: String): Built? {
        val m = HEARTBEAT_RE.find(text) ?: return null; if (call.isEmpty()) return null
        val type = m.g("type")!!; val alt = type.startsWith("CQ"); val grid = m.g("grid") ?: ""
        var extra = if (grid.length == 4) packGrid(grid) else NMAXGRID
        var n3 = max(0, HBS.indexOf(type))
        if (alt) { extra = extra or 0x8000; n3 = max(0, CQS.indexOf(type)) }
        val b = compoundFrame(call, FRAME_HEARTBEAT, extra, n3) ?: return null
        return Built(b, m.value.length)
    }
    private fun compoundMessage(text: String): Built? {
        val m = COMPOUND_MSG_RE.find(text) ?: return null
        val call = m.g("callsign"); val grid = (m.g("grid") ?: "").trim(); val cmd = m.g("cmd") ?: ""; val num = (m.g("num") ?: "").trim()
        if (call.isNullOrEmpty()) return null
        var type = FRAME_COMPOUND; var extra = NMAXGRID
        val code = CMD_CODE[cmd]
        if (cmd.isNotEmpty() && code != null && code >= 0) { extra = NUSERGRID + packCmd(code, packNum(num).first); type = FRAME_COMPOUND_DIRECTED }
        else if (grid.isNotEmpty()) extra = packGrid(grid)
        val b = compoundFrame(call, type, extra, 0) ?: return null
        return Built(b, m.value.length)
    }
    private class Directed(val bits: List<Int>, val n: Int, val to: String, val toCompound: Boolean, val cmd: String, val num: String)
    private fun directedMessage(text: String, mycall: String): Directed? {
        val m = DIRECTED_RE.find(text) ?: return null
        var to = m.g("callsign")!!; val cmd = m.g("cmd") ?: ""; val num = m.g("num") ?: ""
        if (cmd.isEmpty()) return null
        val from = if (isCompoundCallsign(mycall)) "<....>" else mycall
        val v = isValidCallsign(to); if (to == mycall || !v.valid) return null
        val toCompound = v.compound; val realTo = to
        if (toCompound) to = "<....>"
        val code = CMD_CODE[cmd] ?: CMD_CODE[cmd.trim()]
        if (code == null || code < 0) return null
        val pn = packNum(num.trim())
        val f = packCall28(from); val t = packCall28(to)
        if (f.v == 0 || t.v == 0) return null
        val b = ArrayList<Int>()
        put(b, FRAME_DIRECTED, 3); put(b, f.v, 28); put(b, t.v, 28); put(b, code % 32, 5)
        put(b, ((if (f.portable) 1 else 0) shl 7) + ((if (t.portable) 1 else 0) shl 6) + pn.first, 8)
        return Directed(b, m.value.length, realTo, toCompound, if (CMD_CODE.containsKey(cmd)) cmd else cmd.trim(), num)
    }

    private val CQ_START = Regex("^\\s*CQ\\b")
    private val HB_START = Regex("^\\s*(?:HB|HEARTBEAT)\\b")
    /**
     * A typed line → frames, the way JS8 sends it: heartbeats and CQs, compound callsigns and groups, directed commands
     * with their checksums, then text. The first frame is flagged first and the last flagged last.
     */
    fun buildMessageFrames(mycall: String, mygrid: String, selectedCall: String, text: String, speed: Js8Speed): List<Frame> {
        class Fr(val bits: List<Int>, var flags: Int)
        val frames = ArrayList<Fr>()
        var line = text.uppercase()
        if (line.startsWith("$mycall:") || line.startsWith("$mycall ")) line = line.substring(mycall.length + 1).trimStart()
        if (selectedCall.isNotEmpty() && !line.startsWith(selectedCall) && !line.startsWith("`")) {
            val startsBase = line.startsWith("@ALLCALL") || CQ_START.containsMatchIn(line) || HB_START.containsMatchIn(line)
            val firstWord = line.split(Regex("\\s+")).firstOrNull() ?: ""
            val startsCall = firstWord.length > 3 && isValidCallsign(firstWord).valid
            if (!startsBase && !startsCall) line = "$selectedCall${if (line.startsWith(" ")) "" else " "}$line"
        }
        val mycallCompound = isCompoundCallsign(mycall)
        var hasDirected = false; var hasData = false; var guard = 0
        while (line.isNotEmpty() && guard++ < 200) {
            val hb = if (!hasDirected && !hasData) heartbeatFrame(line, mycall) else null
            val cmp = if (!hasDirected && !hasData && hb == null) compoundMessage(line) else null
            val dir = if (!hasDirected && !hasData && hb == null && cmp == null) directedMessage(line, mycall) else null
            if (hb != null) { frames += Fr(hb.bits, 0); line = line.drop(hb.n); continue }
            if (cmp != null) { frames += Fr(cmp.bits, 0); line = line.drop(cmp.n); continue }
            if (dir != null) {
                hasDirected = true
                if (mycallCompound || dir.toCompound) {
                    compoundMessage("`$mycall $mygrid")?.let { frames += Fr(it.bits, 0) }
                    compoundMessage("`${dir.to}${dir.cmd}${dir.num}")?.let { frames += Fr(it.bits, 0) }
                } else frames += Fr(dir.bits, 0)
                line = line.drop(dir.n)
                val code = CMD_CODE[dir.cmd] ?: CMD_CODE[dir.cmd.trim()] ?: -1
                if (code in BUFFERED_CMDS && line.isNotEmpty()) {
                    line = line.trimStart()
                    val size = CHECKSUM_CMDS[code] ?: 0
                    if (size == 32) line = "$line ${checksum32(line)}"
                    else if (size == 16) line = "$line ${checksum16(line)}"
                }
                continue
            }
            val d = if (speed == Js8Speed.NORMAL) packData(line) else packFastData(line)
            if (d.chars <= 0) break
            hasData = true
            frames += Fr(d.bits, if (speed == Js8Speed.NORMAL) 0 else Js8Codec.FLAG_RESERVED)
            line = line.drop(d.chars)
        }
        if (frames.isEmpty()) return emptyList()
        frames[0].flags = frames[0].flags or Js8Codec.FLAG_FIRST; frames[frames.size - 1].flags = frames[frames.size - 1].flags or Js8Codec.FLAG_LAST
        return frames.map { toFrame(it.bits, it.flags) }
    }
}

/** A small JSON reader for the dictionary file: objects, arrays, strings, numbers, true, false, null. */
internal class MiniJson(private val s: String) {
    private var i = 0
    private fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }
    fun value(): Any? {
        ws()
        return when (val c = s[i]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            't' -> { i += 4; true }
            'f' -> { i += 5; false }
            'n' -> { i += 4; null }
            else -> if (c == '-' || c.isDigit()) num() else error("JSON: unexpected '$c' at $i")
        }
    }
    private fun obj(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>(); i++; ws()
        if (s[i] == '}') { i++; return m }
        while (true) {
            ws(); val k = str(); ws(); i++ // ':'
            m[k] = value(); ws()
            if (s[i] == ',') { i++; continue }
            i++; return m
        }
    }
    private fun arr(): List<Any?> {
        val a = ArrayList<Any?>(); i++; ws()
        if (s[i] == ']') { i++; return a }
        while (true) {
            a.add(value()); ws()
            if (s[i] == ',') { i++; continue }
            i++; return a
        }
    }
    private fun str(): String {
        i++
        val start = i
        while (s[i] != '"' && s[i] != '\\') i++
        if (s[i] == '"') { val r = s.substring(start, i); i++; return r }
        val sb = StringBuilder().append(s, start, i)
        while (true) {
            val c = s[i++]
            when (c) {
                '"' -> return sb.toString()
                '\\' -> when (val e = s[i++]) {
                    'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r'); 'b' -> sb.append('\b'); 'f' -> sb.append('\u000C')
                    'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                    else -> sb.append(e)
                }
                else -> sb.append(c)
            }
        }
    }
    private fun num(): Number {
        val start = i
        while (i < s.length && (s[i].isDigit() || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++
        val t = s.substring(start, i)
        return t.toLongOrNull()?.let { if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else it } ?: t.toDouble()
    }
}
