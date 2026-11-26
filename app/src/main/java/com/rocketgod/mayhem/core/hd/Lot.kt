package com.rocketgod.mayhem.core.hd

/**
 * Large objects (files) carried on AAS ports, and the service directory port. Neither framing is in the NRSC-5-E
 * documents we work from; both were worked out from our own recordings and are marked as derived.
 *
 * Object packets: [0] the header length (where the file data starts in this packet), [1] a repeat count, [2..3]
 * object id, [4..7] fragment index (little endian), then the file data in 256-byte fragments. Fragment 0's header goes
 * on with 16 bytes of metadata ([8..11] always 01 00 00 00, [16..19] the file size, little endian) and the file name
 * in ASCII; fragment 0 is the one with index 0 and that word.
 *
 * Service directory (a TLV list, each length counting its own length byte): 0x40 an audio service and 0x41 a data
 * service (each followed by three header bytes), 0x69 a name (an encoding byte, then text), 0x66 audio service info
 * ([1] the program, [2] its type), 0x67 a component ([1..2] its AAS port, little endian, then four bytes ending in the
 * component's MIME hash), 0x60 a component detail.
 */
class LotObject(
    val port: Int, val id: Int, val name: String, val size: Int, val bytes: ByteArray, val mime: String, val ms: Long,
    /** From fragment 0's header: the format version, the MIME hash (little endian, as sent) and the expiry (UTC). */
    val version: Long = 0, val mimeHash: Long = 0, val expires: String = "",
)

class LotPending(val port: Int, val id: Int, val name: String, val have: Int, val need: Int)

/** Reassembles every object on every port; each finished object is reported once (repeats are dropped). */
class LotAssembler {
    var onObject: (LotObject) -> Unit = {}
    private class Part(var name: String, var size: Int, val frags: HashMap<Long, IntArray>, var have: Int, var need: Long, val first: Long,
                       var version: Long = 0, var mimeHash: Long = 0, var expires: String = "")
    private val parts = LinkedHashMap<String, Part>()
    private val done = HashMap<String, Int>()
    private val doneNames = LinkedHashSet<String>()
    var objects = 0; private set
    var fragments = 0; private set
    /** The clock objects are stamped with (tests hold it still). */
    var clock: () -> Long = { System.currentTimeMillis() }

    private fun le32(p: IntArray, o: Int) = p[o].toLong() or (p[o + 1].toLong() shl 8) or (p[o + 2].toLong() shl 16) or (p[o + 3].toLong() shl 24)

    fun add(port: Int, p: IntArray) {
        if (p.size < 8) return
        val id = p[2] or (p[3] shl 8); val idx = le32(p, 4)
        val key = "$port/$id"
        fragments++
        var o = parts[key]
        val hl = p[0]
        if (hl < 8 || hl > p.size) return
        if (idx == 0L) {
            // fragment 0 carries the metadata word 01 00 00 00 at bytes 8..11
            if (hl < 24 || p[8] != 1 || p[9] != 0 || p[10] != 0 || p[11] != 0) return
            val size = le32(p, 16)
            if (size == 0L || size > 4_000_000) return
            val name = String(CharArray(hl - 24) { p[24 + it].toChar() }).trimEnd('\u0000')
            val version = le32(p, 8); val mimeHash = le32(p, 20); val expires = HdLot.lotExpiry(p.copyOfRange(12, 16))
            if (done[key] == hashSig("$name/$size")) return
            if (o == null || (o.size > 0 && (o.name != name || o.size.toLong() != size))) { o = Part(name, size.toInt(), HashMap(), 0, (size + FRAG - 1) / FRAG, clock()); parts[key] = o }
            else if (o.size < 0) { o.name = name; o.size = size.toInt(); o.need = (size + FRAG - 1) / FRAG }
            o.version = version; o.mimeHash = mimeHash; o.expires = expires
            if (!o.frags.containsKey(0L)) { o.frags[0L] = p.copyOfRange(hl, p.size); o.have++ }
        } else {
            if (o == null) { o = Part("", -1, HashMap(), 0, Long.MAX_VALUE, clock()); parts[key] = o }
            if (!o.frags.containsKey(idx)) { o.frags[idx] = p.copyOfRange(hl, p.size); o.have++ }
        }
        if (o.size > 0 && o.have >= o.need) finish(port, id, key, o)
        if (parts.size > 400) { val oldest = parts.entries.minByOrNull { it.value.first }!!; parts.remove(oldest.key) }
    }

    private fun finish(port: Int, id: Int, key: String, o: Part) {
        for (i in 0 until o.need) if (!o.frags.containsKey(i)) return
        val bytes = ByteArray(o.size)
        var at = 0
        var i = 0L
        while (i < o.need && at < o.size) { val f = o.frags[i]!!; val k = minOf(f.size, o.size - at); for (j in 0 until k) bytes[at + j] = f[j].toByte(); at += f.size; i++ }
        parts.remove(key)
        done[key] = hashSig("${o.name}/${o.size}")
        // the same file sent again under a new id
        val same = "$port/${o.name}/${o.size}"
        if (o.name.isNotEmpty() && same in doneNames) return
        doneNames.add(same); if (doneNames.size > 500) doneNames.remove(doneNames.first())
        objects++
        onObject(LotObject(port, id, o.name, o.size, bytes, HdLot.sniffMime(bytes, o.name, o.mimeHash), clock(), o.version, o.mimeHash, o.expires))
    }

    /** Objects still being collected: port, id, name, fragments in hand and needed. */
    fun pending(): List<LotPending> = parts.entries.filter { it.value.size > 0 }.map { (k, o) ->
        val (port, id) = k.split('/').map { it.toInt() }; LotPending(port, id, o.name, o.have, o.need.toInt())
    }
    fun clear() { parts.clear(); done.clear(); doneNames.clear(); objects = 0; fragments = 0 }

    private companion object { const val FRAG = 256L }
}

private fun hashSig(s: String): Int { var h = 0x811C9DC5.toInt(); for (c in s) { h = h xor (c.code and 0xFFFF); h *= 16777619 }; return h }

/** An image or file start found inside a byte run: where, how long (to its end marker when it has one) and its size. */
class Embedded(val type: String, val offset: Int, val length: Int, val complete: Boolean, val width: Int? = null, val height: Int? = null)
class TextChunk(val key: String, val value: String)
/** What a file holds beyond its picture: text chunks, its segment list, images inside it and bytes past its end. */
class Inspect(var width: Int? = null, var height: Int? = null, val text: MutableList<TextChunk> = ArrayList(), var embedded: List<Embedded> = emptyList(), var trailing: Int = 0, val chunks: MutableList<String> = ArrayList())

object HdLot {
    /** The LOT expiry word (bytes 12..15, little endian): minute, hour, day, month and year packed low bits first. */
    fun lotExpiry(b: IntArray): String {
        val v = b[0].toLong() or (b[1].toLong() shl 8) or (b[2].toLong() shl 16) or (b[3].toLong() shl 24)
        val min = (v and 63).toInt(); val hour = ((v ushr 6) and 31).toInt(); val day = ((v ushr 11) and 31).toInt(); val mon = ((v ushr 16) and 15).toInt(); val year = (v ushr 20).toInt()
        if (v == 0L || mon == 0 || mon > 12 || day == 0 || hour > 23 || min > 59 || year < 1990 || year > 2200) return ""
        return "%d-%02d-%02d %02d:%02d".format(year, mon, day, hour, min)
    }

    private fun u(b: ByteArray, i: Int) = if (i in b.indices) b[i].toInt() and 0xFF else -1
    private fun at(b: ByteArray, o: Int, vararg sig: Int): Boolean { for (i in sig.indices) if (u(b, o + i) != sig[i]) return false; return true }
    // past the end reads as 0 in arithmetic, as JS reads undefined
    private fun z(b: ByteArray, i: Int) = if (i in b.indices) b[i].toInt() and 0xFF else 0
    private fun be32(b: ByteArray, o: Int): Long = (z(b, o).toLong() shl 24) or (z(b, o + 1).toLong() shl 16) or (z(b, o + 2).toLong() shl 8) or z(b, o + 3).toLong()
    private fun le32(b: ByteArray, o: Int): Long = z(b, o).toLong() or (z(b, o + 1).toLong() shl 8) or (z(b, o + 2).toLong() shl 16) or (z(b, o + 3).toLong() shl 24)
    private fun latin(b: ByteArray, from: Int, to: Int): String { val sb = StringBuilder(); for (i in maxOf(0, from) until minOf(b.size, to)) sb.append((b[i].toInt() and 0xFF).toChar()); return sb.toString() }
    private fun indexOf0(b: ByteArray, from: Int, to: Int): Int { for (i in from until minOf(to, b.size)) if (b[i].toInt() == 0) return i - from; return -1 }

    private val SVG = Regex("^<svg|^<\\?xml[^>]*>\\s*<svg", RegexOption.IGNORE_CASE)
    private val XML = Regex("^<\\?xml", RegexOption.IGNORE_CASE)
    private val HTML = Regex("^<!doctype html|^<html", RegexOption.IGNORE_CASE)
    /** The file type from its first bytes, then its name, then the LOT MIME hash. */
    fun sniffMime(b: ByteArray, name: String, hash: Long = 0): String {
        if (at(b, 0, 0xFF, 0xD8, 0xFF)) return "image/jpeg"
        if (at(b, 0, 0x89, 0x50, 0x4E, 0x47)) return "image/png"
        if (at(b, 0, 0x47, 0x49, 0x46, 0x38)) return "image/gif"
        if (at(b, 0, 0x52, 0x49, 0x46, 0x46) && at(b, 8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
        if (at(b, 0, 0x42, 0x4D) && b.size > 26 && le32(b, 2) == b.size.toLong()) return "image/bmp"
        if (at(b, 0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf"
        if (at(b, 0, 0x50, 0x4B, 0x03, 0x04)) return "application/zip"
        if (at(b, 0, 0x1F, 0x8B)) return "application/gzip"
        if (at(b, 0, 0x49, 0x44, 0x33)) return "audio/mpeg"
        val head = latin(b, 0, 512).trimStart()
        if (SVG.containsMatchIn(head)) return "image/svg+xml"
        if (XML.containsMatchIn(head)) return "application/xml"
        if (HTML.containsMatchIn(head)) return "text/html"
        val n = name.lowercase()
        if (n.endsWith(".txt") || hash == 0xBB492AACL) return "text/plain"
        if (n.endsWith(".jpg") || n.endsWith(".jpeg") || hash == 0x1E653E9CL) return "image/jpeg"
        if (n.endsWith(".png") || hash == 0x4F328CA0L) return "image/png"
        if (b.isNotEmpty() && printable(b) > 0.97) return if (head.startsWith("[") || head.startsWith("{")) "application/json" else "text/plain"
        return "application/octet-stream"
    }
    /** The share of bytes that are text: tab, line ends, 0x20..0x7E and Latin-1 letters. */
    fun printable(b: ByteArray): Double {
        var n = 0; val m = minOf(b.size, 4096)
        for (i in 0 until m) { val c = b[i].toInt() and 0xFF; if (c == 9 || c == 10 || c == 13 || c in 32..126 || c >= 0xA0) n++ }
        return if (m > 0) n.toDouble() / m else 0.0
    }
    /** Shannon entropy of a sample in bits per byte (near 8: compressed or encrypted). */
    fun entropy(b: ByteArray): Double {
        val c = IntArray(256); for (x in b) c[x.toInt() and 0xFF]++
        val n = b.size; var h = 0.0
        for (x in c) if (x > 0) { val p = x.toDouble() / n; h -= p * (Math.log(p) / Math.log(2.0)) }
        return h
    }

    /** Every image signature in [b] from [from], each checked past its magic so random bytes rarely pass. */
    fun scanEmbedded(b: ByteArray, from: Int = 0, limit: Int = 32, size: Int = b.size): List<Embedded> {
        val out = ArrayList<Embedded>()
        val len = minOf(size, b.size)
        var i = maxOf(0, from)
        while (i + 30 < len && out.size < limit) {
            val x = u(b, i)
            if (x == 0xFF && u(b, i + 1) == 0xD8 && u(b, i + 2) == 0xFF && u(b, i + 3) >= 0xC0 && u(b, i + 3) != 0xFF) {
                val m = u(b, i + 3); val seg = (z(b, i + 4) shl 8) or z(b, i + 5)
                val bad = seg < 2 || (m == 0xE0 && !at(b, i + 6, 0x4A, 0x46, 0x49, 0x46)) || (m == 0xE1 && !at(b, i + 6, 0x45, 0x78, 0x69, 0x66) && !at(b, i + 6, 0x68, 0x74, 0x74, 0x70))
                if (!bad && (m == 0xE0 || m == 0xE1 || m == 0xDB || m == 0xEE || m == 0xED || m == 0xE2 || m == 0xC0 || m == 0xC4)) {
                    val end = jpegEnd(b, i, len)
                    val sz = jpegSize(b, i, if (end > 0) end else len)
                    out.add(Embedded("image/jpeg", i, if (end > 0) end - i else len - i, end > 0, sz?.first, sz?.second))
                    if (end > 0) i = end - 1
                }
            } else if (x == 0x89 && at(b, i, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) && at(b, i + 12, 0x49, 0x48, 0x44, 0x52)) {
                val end = pngEnd(b, i, len)
                out.add(Embedded("image/png", i, if (end > 0) end - i else len - i, end > 0, be32(b, i + 16).toInt(), be32(b, i + 20).toInt()))
                if (end > 0) i = end - 1
            } else if (x == 0x47 && (at(b, i, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61) || at(b, i, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61))) {
                val w = z(b, i + 6) or (z(b, i + 7) shl 8); val h = z(b, i + 8) or (z(b, i + 9) shl 8)
                if (w != 0 && h != 0 && w < 8192 && h < 8192) out.add(Embedded("image/gif", i, len - i, false, w, h))
            } else if (x == 0x42 && u(b, i + 1) == 0x4D) {
                val sz = le32(b, i + 2); val off = le32(b, i + 10); val hdr = le32(b, i + 14)
                if (u(b, i + 6) == 0 && u(b, i + 7) == 0 && u(b, i + 8) == 0 && u(b, i + 9) == 0 && (hdr == 40L || hdr == 12L || hdr == 108L || hdr == 124L) && off >= 14 + hdr && off < 2000 && sz > off && sz < 20_000_000)
                    out.add(Embedded("image/bmp", i, minOf(sz, (len - i).toLong()).toInt(), i + sz <= len, le32(b, i + 18).toInt(), kotlin.math.abs(le32(b, i + 22).toInt())))
            } else if (x == 0x52 && at(b, i, 0x52, 0x49, 0x46, 0x46) && at(b, i + 8, 0x57, 0x45, 0x42, 0x50)) {
                val sz = le32(b, i + 4) + 8
                out.add(Embedded("image/webp", i, minOf(sz, (len - i).toLong()).toInt(), i + sz <= len))
            }
            i++
        }
        return out
    }
    /** Where a JPEG starting at [s] ends (just past its EOI), walking its marker segments and entropy-coded data, or -1. */
    private fun jpegEnd(b: ByteArray, s: Int, len: Int = b.size): Int {
        var i = s + 2
        while (i + 4 <= len) {
            if (u(b, i) != 0xFF) return -1
            val m = u(b, i + 1)
            if (m == 0xD9) return i + 2
            if (m == 0xFF) { i++; continue }
            if (m == 0x01 || m in 0xD0..0xD7) { i += 2; continue }
            val l = (z(b, i + 2) shl 8) or z(b, i + 3); if (l < 2) return -1
            i += 2 + l
            if (m == 0xDA) while (i + 1 < len && !(u(b, i) == 0xFF && u(b, i + 1) != 0 && u(b, i + 1) !in 0xD0..0xD7)) i++
        }
        return -1
    }
    private fun jpegSize(b: ByteArray, s: Int, e: Int): Pair<Int, Int>? {
        var i = s + 2
        while (i + 9 < e && u(b, i) == 0xFF) {
            val m = u(b, i + 1); val l = (z(b, i + 2) shl 8) or z(b, i + 3)
            if (m in 0xC0..0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) return ((z(b, i + 7) shl 8) or z(b, i + 8)) to ((z(b, i + 5) shl 8) or z(b, i + 6))
            if (m == 0xDA || l < 2) break
            i += 2 + l
        }
        return null
    }
    /** Where a PNG starting at [s] ends (just past IEND), walking its chunks, or -1. */
    private fun pngEnd(b: ByteArray, s: Int, len: Int = b.size): Int {
        var i = s + 8L
        while (i + 12 <= len) { val n = be32(b, i.toInt()); if (n > 0x7FFFFFFF) return -1; val t = be32(b, i.toInt() + 4); i += 12 + n; if (t == 0x49454E44L) return if (i <= len) i.toInt() else -1 }
        return -1
    }

    fun inspectFile(b: ByteArray, mime: String): Inspect {
        val out = Inspect()
        if (mime == "image/png" && at(b, 0, 0x89, 0x50, 0x4E, 0x47)) {
            out.width = be32(b, 16).toInt(); out.height = be32(b, 20).toInt()
            var i = 8L
            while (i + 12 <= b.size) {
                val ii = i.toInt(); val n = be32(b, ii); val t = latin(b, ii + 4, ii + 8)
                val dA = ii + 8; val dB = minOf(b.size.toLong(), i + 8 + n).toInt()
                if (t !in out.chunks) out.chunks.add(t)
                if (t == "tEXt" || t == "iTXt" || t == "zTXt") {
                    val z = indexOf0(b, dA, dB)
                    val v = if (t == "zTXt") "(compressed, ${dB - dA} bytes)" else latin(b, dA + z + 1, dB).replace(Regex("^[\\x00-\\x02]+"), "").take(2000)
                    out.text.add(TextChunk("$t ${latin(b, dA, dA + maxOf(0, z))}", v))
                } else if (t == "eXIf") out.text.add(TextChunk("eXIf", "${dB - dA} bytes"))
                i += 12 + n
                if (t == "IEND") break
            }
            out.trailing = maxOf(0L, b.size - i).toInt()
        } else if (mime == "image/jpeg") {
            val end = jpegEnd(b, 0); jpegSize(b, 0, if (end > 0) end else b.size)?.let { out.width = it.first; out.height = it.second }
            var i = 2
            while (i + 4 <= b.size && u(b, i) == 0xFF) {
                val m = u(b, i + 1); val l = (z(b, i + 2) shl 8) or z(b, i + 3)
                if (m == 0xDA || m == 0xD9 || l < 2) break
                val dA = i + 4; val dB = minOf(b.size, i + 2 + l)
                if (m in 0xE0..0xEF) {
                    val id = latin(b, dA, dA + maxOf(0, indexOf0(b, dA, dB))).take(40); val name = "APP${m - 0xE0} $id".trim()
                    if (name !in out.chunks) out.chunks.add(name)
                    if (id.startsWith("http://ns.adobe.com/xap")) out.text.add(TextChunk("XMP", latin(b, dA + id.length + 1, dB).take(4000)))
                }
                if (m == 0xFE) out.text.add(TextChunk("COM", latin(b, dA, dB).take(2000)))
                i += 2 + l
            }
            out.trailing = if (end > 0) b.size - end else 0
        } else if (mime == "image/gif") {
            out.width = z(b, 6) or (z(b, 7) shl 8); out.height = z(b, 8) or (z(b, 9) shl 8)
            var i = 13
            while (i + 3 < b.size) {
                if (u(b, i) == 0x21 && u(b, i + 1) == 0xFE) {
                    val sb = StringBuilder(); var k = i + 2
                    while (k < b.size && b[k].toInt() != 0) { val n = u(b, k); sb.append(latin(b, k + 1, k + 1 + n)); k += 1 + n }
                    out.text.add(TextChunk("GIF comment", sb.toString().take(2000))); break
                }
                i++
            }
        }
        out.embedded = scanEmbedded(b, 1, 16)
        return out
    }

    /** What an object is, from its name and content. */
    fun lotKind(name: String, mime: String, port: Int, artPorts: Set<Int>, logoPorts: Set<Int>): String {
        val n = name.uppercase()
        if (n.startsWith("TMT_")) return "traffic"
        if (n.startsWith("TMI_")) return "traffic-info"
        if (n.startsWith("DWRO_")) return "radar"
        if (n.startsWith("DWRI_")) return "radar-info"
        val img = mime.startsWith("image/")
        if (img && port in artPorts) return "art"
        if (img && port in logoPorts) return "logo"
        if (img && n.startsWith("SL")) return "logo"
        if (img) return "image"
        if (mime.startsWith("text/") || mime == "application/json" || mime == "application/xml") return "text"
        return "file"
    }

    class Tile(val map: String, val row: Int, val col: Int, val stamp: String)
    private val TILE = Regex("^TMT_([^_]+)_(\\d+)_(\\d+)_(\\d{8})_(\\d{4})", RegexOption.IGNORE_CASE)
    /** A traffic tile name: TMT_<map>_<row>_<column>_<yyyymmdd>_<hhmm>_<id>. */
    fun trafficTile(name: String): Tile? = TILE.find(name)?.groupValues?.let { Tile(it[1], it[2].toInt(), it[3].toInt(), "${it[4]}_${it[5]}") }
    class Radar(val area: String, val stamp: String)
    private val RADAR = Regex("^DWRO_([^_]+)_.*?(\\d{8})_(\\d{4})", RegexOption.IGNORE_CASE)
    /** A radar image name: DWRO_<area>_..._<yyyymmdd>_<hhmm>_<id>. */
    fun radarImage(name: String): Radar? = RADAR.find(name)?.groupValues?.let { Radar(it[1], "${it[2]}_${it[3]}") }

    /** key="value" pairs of the map description files; values keep their inner quoting. */
    private fun kv(text: String): LinkedHashMap<String, String> {
        val m = LinkedHashMap<String, String>()
        for (line in text.split(Regex("\\r?\\n"))) { val i = line.indexOf('='); if (i > 0) m[line.substring(0, i).trim()] = line.substring(i + 1).trim().removePrefix("\"").removeSuffix("\"") }
        return m
    }
    private val COORD = Regex("\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\)")
    private fun coords(s: String) = COORD.findAll(s).map { it.groupValues[1].toDouble() to it.groupValues[2].toDouble() }.toList()
    private val RGB = Regex("(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)")
    private fun rgb(s: String?) = s?.let { RGB.find(it) }?.groupValues?.let { intArrayOf(it[1].toInt(), it[2].toInt(), it[3].toInt()) }
    private val NAMES = Regex("\\(\\s*[^,()]*,\\s*([^()]*?)\\s*\\)")
    private fun coords2(s: String) = NAMES.findAll(s).map { it.groupValues[1] }.toList()

    class TrafficInfo(val map: String, val rows: Int, val cols: Int, val north: Double, val south: Double, val west: Double, val east: Double,
                      val background: IntArray?, val stations: List<String>, val copyright: String)
    /** The traffic map description (TMI): the tile grid and the corners of the whole map. */
    fun parseTrafficInfo(text: String): TrafficInfo? {
        val m = kv(text); val rows = m["NumRows"]?.toIntOrNull() ?: 0; val cols = m["NumColumns"]?.toIntOrNull() ?: 0
        val pts = m.entries.filter { it.key.startsWith("CoordinatesRow", ignoreCase = true) }.flatMap { coords(it.value) }
        if (rows == 0 || cols == 0 || pts.isEmpty()) return null
        return TrafficInfo(m["TrafficMapID"] ?: "", rows, cols, pts.maxOf { it.first }, pts.minOf { it.first }, pts.minOf { it.second }, pts.maxOf { it.second },
            rgb(m["BackgroundRGBColor"]), coords2(m["StationList"] ?: ""), m["CopyrightNotice"] ?: "")
    }
    class Bounds(val north: Double, val south: Double, val west: Double, val east: Double)
    /** A tile's corners in a traffic map. */
    fun tileBounds(t: TrafficInfo, row: Int, col: Int): Bounds {
        val dLat = (t.north - t.south) / t.rows; val dLon = (t.east - t.west) / t.cols
        return Bounds(t.north - (row - 1) * dLat, t.north - row * dLat, t.west + (col - 1) * dLon, t.west + col * dLon)
    }

    class Legend(val name: String, val colors: List<Pair<Int, IntArray>>)
    class RadarInfo(val area: String, val north: Double, val south: Double, val west: Double, val east: Double, val legends: List<Legend>, val stations: List<String>, val copyright: String)
    private val LEGEND = Regex("\\(\\s*(\\d+)\\s*,\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)\\s*\\)")
    /** The weather radar description (DWRI): the image's corners and its color legends. */
    fun parseRadarInfo(text: String): RadarInfo? {
        val m = kv(text); val pts = coords(m["Coordinates"] ?: "")
        if (pts.size < 2) return null
        val legends = m.entries.filter { it.key.startsWith("Legend_", ignoreCase = true) }.map { (k, v) ->
            Legend(k.substring(7).replace(Regex("([a-z])([A-Z])"), "$1 $2"),
                LEGEND.findAll(v).map { x -> x.groupValues[1].toInt() to intArrayOf(x.groupValues[2].toInt(), x.groupValues[3].toInt(), x.groupValues[4].toInt()) }.toList())
        }
        return RadarInfo(m["DWR_Area_ID"] ?: "", maxOf(pts[0].first, pts[1].first), minOf(pts[0].first, pts[1].first), minOf(pts[0].second, pts[1].second), maxOf(pts[0].second, pts[1].second),
            legends, coords2(m["StationList"] ?: ""), m["CopyrightNotice"] ?: "")
    }

    /** A data component (tag 0x67); [mime] is high byte first, the standard hash that word byte-reversed ([mimeName]). */
    class SigComponent(val index: Int, val port: Int, val mime: Long, val mimeHex: String, val mimeName: String = "", val dataType: Int = -1, val aasType: Int = -1, val aasTypeName: String = "")
    class SigExtra(val tag: Int, val hex: String, val text: String)
    /** A service; [extra] keeps every other tag (the audio component 0x66 and any not decoded) as hex. */
    class SigService(val kind: String, val id: Int, var name: String, var program: Int, var progType: Int, val components: MutableList<SigComponent>, val extra: MutableList<SigExtra> = ArrayList())
    val AAS_TYPES = mapOf(0 to "stream", 1 to "packet", 3 to "LOT")
    private fun swap32(v: Long): Long = ((v and 255) shl 24) or (((v shr 8) and 255) shl 16) or (((v shr 16) and 255) shl 8) or ((v ushr 24) and 255)
    /** The standard name of a high-byte-first MIME word (as [SigComponent.mimeHex], XHDR mime). */
    fun mimeNameBe(be: Long): String = HdSis.mimeName(swap32(be))
    private fun hexOf(p: IntArray, a: Int, b: Int): String { val sb = StringBuilder(); for (i in a until b) sb.append("%02x".format(p[i])); return sb.toString() }
    /** A tag value that starts with a four-character code: the code, then the rest as a little-endian number ("CCU1 40"). */
    private fun asciiHead(p: IntArray, a: Int, b: Int): String {
        if (b - a < 4) return ""
        for (i in a until a + 4) { val c = p[i]; if (!(c in 0x30..0x39 || c in 0x41..0x5A || c in 0x61..0x7A)) return "" }
        var n = 0.0; for (i in b - 1 downTo a + 4) n = n * 256 + p[i]
        val num = if (n == Math.floor(n) && kotlin.math.abs(n) < 1e15) n.toLong().toString() else n.toString()
        return "${String(CharArray(4) { p[a + it].toChar() })} $num"
    }
    /** The service directory (derived): audio and data services, their names and their component ports. */
    fun parseSig(p: IntArray): List<SigService> {
        val out = ArrayList<SigService>()
        var cur: SigService? = null; var i = 0
        while (i < p.size) {
            val tag = p[i]
            if (tag == 0x40 || tag == 0x41) {
                if (i + 4 > p.size) break
                cur = SigService(if (tag == 0x40) "audio" else "data", p[i + 1] or (p[i + 2] shl 8), "", -1, -1, ArrayList())
                out.add(cur); i += 4; continue
            }
            if (i + 1 >= p.size) break
            val len = p[i + 1]
            if (len < 1 || i + 1 + len > p.size) break
            val a = i + 2; val b = i + 1 + len; val vl = b - a
            val c = cur
            if (c != null) {
                if (tag == 0x69 && vl >= 1) c.name = String(CharArray(vl - 1) { p[a + 1 + it].toChar() }).trimEnd('\u0000').trim()
                else if (tag == 0x66 && vl >= 3) {
                    c.program = p[a + 1]; c.progType = p[a + 2]
                    val mime = if (vl >= 11) (p[a + 7].toLong() shl 24) or (p[a + 8].toLong() shl 16) or (p[a + 9].toLong() shl 8) or p[a + 10].toLong() else 0L
                    c.extra.add(SigExtra(tag, hexOf(p, a, b), if (mime != 0L) "audio component, program ${p[a + 1]}, MIME ${mimeNameBe(mime).ifEmpty { "%08x".format(mime) }}" else ""))
                }
                else if (tag == 0x67 && vl >= 7) {
                    val mime = (p[b - 4].toLong() shl 24) or (p[b - 3].toLong() shl 16) or (p[b - 2].toLong() shl 8) or p[b - 1].toLong()
                    val aasType = if (vl >= 6) p[a + 5] else -1
                    c.components.add(SigComponent(p[a], p[a + 1] or (p[a + 2] shl 8), mime, "%08x".format(mime), mimeNameBe(mime),
                        if (vl >= 5) p[a + 3] or (p[a + 4] shl 8) else -1, aasType, AAS_TYPES[aasType] ?: "type $aasType"))
                }
                else c.extra.add(SigExtra(tag, hexOf(p, a, b), asciiHead(p, a, b)))
            }
            i += 1 + len
        }
        return out.filter { it.name.isNotEmpty() || it.components.isNotEmpty() }
    }

    class Xhdr(val mime: Long, val objectId: Int?, val flush: Boolean)
    /** The PSD XHDR frame (derived): a MIME hash, then parameter / length / value triples; parameter 0 names the object
     *  id of the image for this song, parameter 1 (no value) says there is none. */
    fun parseXhdr(b: IntArray): Xhdr? {
        if (b.size < 5) return null
        val mime = (b[0].toLong() shl 24) or (b[1].toLong() shl 16) or (b[2].toLong() shl 8) or b[3].toLong()
        var objectId: Int? = null; var flush = false; var i = 4
        while (i + 1 < b.size) {
            val param = b[i]; val len = b[i + 1]; val vl = minOf(len, b.size - (i + 2))
            if (param == 0 && vl >= 2) objectId = b[i + 2] or (b[i + 3] shl 8)
            if (param == 1) flush = true
            i += 2 + len
        }
        return Xhdr(mime, objectId, flush)
    }
}
