package com.rocketgod.mayhem.core.hd

/**
 * Large objects (files) carried on AAS ports, and the service directory port. Neither framing is in the NRSC-5-E
 * documents we work from; both were worked out from our own recordings and are marked as derived.
 *
 * Object packets: [0] the header length (where the file data starts in this packet), [1] a repeat count, [2..3]
 * object id, [4..7] fragment index (little endian), then the file data in 256-byte fragments. Fragment 0's header goes
 * on with 16 bytes of metadata ([16..19] the file size, little endian) and the file name in ASCII.
 *
 * Service directory (a TLV list, each length counting its own length byte): 0x40 an audio service and 0x41 a data
 * service (each followed by three header bytes), 0x69 a name (an encoding byte, then text), 0x66 audio service info
 * ([1] the program, [2] its type), 0x67 a component ([1..2] its AAS port, little endian, then four bytes ending in the
 * component's MIME hash), 0x60 a component detail.
 */
class LotObject(val port: Int, val id: Int, val name: String, val size: Int, val bytes: ByteArray, val mime: String, val ms: Long)

class LotPending(val port: Int, val id: Int, val name: String, val have: Int, val need: Int)

/** Reassembles every object on every port; each finished object is reported once (repeats are dropped). */
class LotAssembler {
    var onObject: (LotObject) -> Unit = {}
    private class Part(var name: String, var size: Int, val frags: HashMap<Long, IntArray>, var have: Int, var need: Long, val first: Long)
    private val parts = LinkedHashMap<String, Part>()
    private val done = HashMap<String, Int>()
    private val doneNames = LinkedHashSet<String>()
    var objects = 0; private set
    var fragments = 0; private set
    /** The clock objects are stamped with (tests hold it still). */
    var clock: () -> Long = { System.currentTimeMillis() }

    fun add(port: Int, p: IntArray) {
        if (p.size < 8) return
        val id = p[2] or (p[3] shl 8); val idx = (p[4].toLong() or (p[5].toLong() shl 8) or (p[6].toLong() shl 16) or (p[7].toLong() shl 24))
        val key = "$port/$id"
        fragments++
        var o = parts[key]
        val hl = p[0]
        if (hl < 8 || hl > p.size) return
        if (idx == 0L) {
            if (hl < 24) return
            val size = (p[16].toLong() or (p[17].toLong() shl 8) or (p[18].toLong() shl 16) or (p[19].toLong() shl 24))
            if (size == 0L || size > 4_000_000) return
            val name = String(CharArray(hl - 24) { p[24 + it].toChar() }).trimEnd('\u0000')
            if (done[key] == hashSig("$name/$size")) return
            if (o == null || (o.size > 0 && (o.name != name || o.size.toLong() != size))) { o = Part(name, size.toInt(), HashMap(), 0, (size + FRAG - 1) / FRAG, clock()); parts[key] = o }
            else if (o.size < 0) { o.name = name; o.size = size.toInt(); o.need = (size + FRAG - 1) / FRAG }
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
        onObject(LotObject(port, id, o.name, o.size, bytes, sniffMime(bytes, o.name), clock()))
    }

    /** Objects still being collected: port, id, name, fragments in hand and needed. */
    fun pending(): List<LotPending> = parts.entries.filter { it.value.size > 0 }.map { (k, o) ->
        val (port, id) = k.split('/').map { it.toInt() }; LotPending(port, id, o.name, o.have, o.need.toInt())
    }
    fun clear() { parts.clear(); done.clear(); doneNames.clear(); objects = 0; fragments = 0 }

    private companion object { const val FRAG = 256L }
}

private fun hashSig(s: String): Int { var h = 0x811C9DC5.toInt(); for (c in s) { h = h xor (c.code and 0xFFFF); h *= 16777619 }; return h }

object HdLot {
    fun sniffMime(b: ByteArray, name: String): String {
        fun u(i: Int) = if (i < b.size) b[i].toInt() and 0xff else -1
        if (u(0) == 0xFF && u(1) == 0xD8 && u(2) == 0xFF) return "image/jpeg"
        if (u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47) return "image/png"
        if (u(0) == 0x47 && u(1) == 0x49 && u(2) == 0x46) return "image/gif"
        if (name.endsWith(".txt", ignoreCase = true)) return "text/plain"
        return "application/octet-stream"
    }

    /** What an object is, from its name and content: art, logo, traffic, traffic-info, radar, radar-info, image, text, file. */
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
        if (mime == "text/plain") return "text"
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

    class SigComponent(val index: Int, val port: Int, val mime: Long, val mimeHex: String)
    class SigService(val kind: String, val id: Int, var name: String, var program: Int, var progType: Int, val components: MutableList<SigComponent>)
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
                else if (tag == 0x66 && vl >= 3) { c.program = p[a + 1]; c.progType = p[a + 2] }
                else if (tag == 0x67 && vl >= 7) {
                    val mime = (p[b - 4].toLong() shl 24) or (p[b - 3].toLong() shl 16) or (p[b - 2].toLong() shl 8) or p[b - 1].toLong()
                    c.components.add(SigComponent(p[a], p[a + 1] or (p[a + 2] shl 8), mime, "%08x".format(mime)))
                }
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

internal fun sniffMime(b: ByteArray, name: String) = HdLot.sniffMime(b, name)
