package com.rocketgod.mayhem.core.hd

/**
 * Everything one HD station sends, built up frame by frame from its L2 PDUs and SIS PDUs: programs and what each is
 * playing (PSD), the fixed and opportunistic data bearers, AAS ports, the service directory, large objects and the
 * voted SIS fields.
 */
class HdSong(val ms: Long, val title: String, val artist: String, val album: String, val genre: String)
class Id3Row(val id: String, val text: String, val desc: String, val lang: String, val size: Int, val hex: String, val known: Boolean)
class HdCommercial(val price: String, val validUntil: String, val url: String, val receivedAs: Int, val seller: String, val description: String)
class HdUfid(val owner: String, val id: String)

class ProgramRow(
    val n: Int, var type: Int, var typeName: String, var codecMode: Int, var kbps: Double, var lastMs: Long, var firstMs: Long,
    var title: String = "", var artist: String = "", var album: String = "", var genre: String = "", var comment: String = "",
    /** The object id of this song's image (from XHDR), or null; [artFlush] when the station says there is none. */
    var artId: Int? = null, var artFlush: Boolean = false, var artMime: Long = 0,
    var songs: List<HdSong> = emptyList(), var psdFrames: Int = 0, var psdBad: Int = 0,
    /** Every ID3 frame of the newest tag, decoded where 1028s defines it, else as hex. */
    var id3: List<Id3Row> = emptyList(),
    /** The newest commercial (COMR) and unique file id (UFID) the station sent with a song. */
    var commercial: HdCommercial? = null, var ufid: HdUfid? = null,
    /** PSD packets that were not ID3 tags, and the ports PSD came on. */
    var psdOther: Int = 0, var psdOtherHex: String = "", var psdPorts: List<Int> = emptyList(),
) {
    fun copy(songCap: Int = 20) = ProgramRow(n, type, typeName, codecMode, kbps, lastMs, firstMs, title, artist, album, genre, comment, artId, artFlush, artMime,
        songs.take(songCap), psdFrames, psdBad, id3, commercial, ufid, psdOther, psdOtherHex, psdPorts)
}
class PortRow(val port: Int, val bearer: String, val packets: Int, val bytes: Int, val lastMs: Long, val firstMs: Long, val seqGaps: Int, val kind: String, val name: String)
class ObjectRow(
    val port: Int, val id: Int, val name: String, val size: Int, val mime: String, val kind: String, val ms: Long, val program: Int,
    /** The LOT header's MIME hash (and its name), expiry and version; what the file holds beyond its picture. */
    val mimeHash: Long = 0, val mimeName: String = "", val expires: String = "", val version: Long = 0, val width: Int? = null, val height: Int? = null,
    val text: List<TextChunk> = emptyList(), val embedded: List<Embedded> = emptyList(), val trailing: Int = 0, val chunks: List<String> = emptyList(),
    /** For a carved object: where it came from. */
    val from: String = "",
)
/** One L1 frame: PCI, raw bit error rate before the FEC, sideband SNR, and the HDLC frames (PSD and data) that passed
 *  and failed their FCS in it. */
class FrameStat(val ms: Long, val pci: Int, val pciErrors: Int, val ber: Double, val snrLoDb: Double, val snrHiDb: Double, var fcsGood: Int = 0, var fcsBad: Int = 0)
/** A finished object with what it is and which program it belongs to (-1: the station). */
class HdObject(val o: LotObject, val kind: String, val program: Int)
class HdUnknown(val where: String, val what: String)

class StationSnap(
    val frames: Int, val framesGood: Int, val lastFrameMs: Long, val firstFrameMs: Long, val pci: Int, val pciName: String,
    val ber: Double, val snrLoDb: Double, val snrHiDb: Double, val history: List<FrameStat>,
    val sis: SisSummary, val programs: List<ProgramRow>, val sig: List<HdLot.SigService>, val sigVerified: Boolean, val ports: List<PortRow>, val objects: List<ObjectRow>,
    val pending: List<LotPending>, val ccc: HdL2.Ccc?, val bbm: Int, val hdlcGood: Int, val hdlcBad: Int,
    /** The MPS blend control (1017s Table 5-4), voted over the last frames; -1 before any. */
    val blend: Int = -1,
    /** Every port as it looks on the air, the things found that nothing announced, and what is still not understood. */
    val portInfo: List<PortInfo> = emptyList(), val findings: List<Finding> = emptyList(), val unknowns: List<HdUnknown> = emptyList(),
    /** P3 and P4 transfer frames (modes MP2, MP3, MP11): received, with a clean header, and the channel bit error rate. */
    val p3: P3Stats = P3Stats(),
)
class P3Stats(val frames: Int = 0, val good: Int = 0, val ber: Double = 0.0)

class HdStation {
    var onObject: (HdObject) -> Unit = {}
    var onEvent: (String) -> Unit = {}
    /** Each frame's audio PDUs and the L2 PDU bytes they are in. */
    var onAudio: (IntArray, List<HdL2.AudioPdu>) -> Unit = { _, _ -> }
    /** The clock rows are stamped with (tests hold it still). */
    var clock: () -> Long = { System.currentTimeMillis() }
    private val fixed = HdL2.FixedTracker()
    private val subs = ArrayList<HdL2.HdlcStream?>()
    private val opp = HdL2.HdlcStream(true)
    private val psd = HashMap<Int, HdL2.HdlcStream>()
    private val progs = LinkedHashMap<Int, ProgramRow>()
    private class PortAcc(val port: Int, val bearer: String, var packets: Int, var bytes: Int, var lastMs: Long, val firstMs: Long, var seqGaps: Int, var kind: String, var lastSeq: Int)
    private val ports = LinkedHashMap<Int, PortAcc>()
    private val lot = LotAssembler()
    private val sisVoter = SisVoter()
    private var sig: List<HdLot.SigService> = emptyList(); private var sigSeen = 0
    private val objects = ArrayList<ObjectRow>()
    private val history = ArrayDeque<FrameStat>()
    private var frames = 0; private var framesGood = 0; private var lastFrameMs = 0L; private var firstFrameMs = 0L; private var lastPci = -1
    private val lastTitle = HashMap<Int, String>(); private var callLogged = ""
    private val inv = PortInventory()
    private var p3Frames = 0; private var p3Good = 0; private var p3Ber = 0.0
    private var carvedSeq = 0; private val apicSeen = HashSet<String>(); private var cccFrames = 0

    init {
        lot.clock = { clock() }
        sisVoter.clock = { clock() }
        inv.clock = { clock() }
        lot.onObject = { o ->
            val art = HashSet<Int>(); val logo = HashSet<Int>()
            componentPorts(art, logo)
            val kind = HdLot.lotKind(o.name, o.mime, o.port, art, logo)
            addObject(o, kind, programOfPort(o.port), HdLot.inspectFile(o.bytes, o.mime), "")
        }
        inv.onCarved = { port, e, bytes -> carved(port, e, bytes, "port ${hex4(port)} stream @${e.offset}") }
    }

    private fun addObject(o: LotObject, kind: String, program: Int, ins: Inspect, from: String) {
        objects.add(0, ObjectRow(o.port, o.id, o.name, o.size, o.mime, kind, o.ms, program, o.mimeHash, HdSis.mimeName(o.mimeHash), o.expires, o.version,
            ins.width, ins.height, ins.text.toList(), ins.embedded, ins.trailing, ins.chunks.toList(), from))
        if (objects.size > 200) objects.subList(200, objects.size).clear()
        onObject(HdObject(o, kind, program))
        onEvent("object · port ${hex4(o.port)} · ${o.name.ifEmpty { "id ${hex4(o.id)}" }} · ${o.size} bytes · $kind")
        val where = "${o.name.ifEmpty { "object ${hex4(o.id)}" }} (port ${hex4(o.port)})"
        for (t in ins.text) inv.note(Finding(where, o.port, "text", 0, t.value.length, null, null, true, "${t.key}: ${t.value.take(200)}", o.ms))
        if (ins.trailing > 0) inv.note(Finding(where, o.port, "trailing bytes", o.size - ins.trailing, ins.trailing, null, null, true,
            "${ins.trailing} bytes after the image's end marker: ${PortInventory.hexB(o.bytes, o.size - ins.trailing, o.size - ins.trailing + 24)}", o.ms))
        for (e in ins.embedded) {
            inv.note(Finding(where, o.port, e.type, e.offset, e.length, e.width, e.height, e.complete, if (e.complete) "an image inside the file, cut out" else "an image start inside the file, cut short", o.ms))
            if (e.complete && from.isEmpty()) carved(o.port, e, o.bytes.copyOfRange(e.offset, e.offset + e.length), "inside ${o.name.ifEmpty { hex4(o.id) }} @${e.offset}")
        }
    }
    /** An image cut out of a stream, a file or a PSD frame, reported as an object of its own. */
    private fun carved(port: Int, e: Embedded, bytes: ByteArray, from: String) {
        val id = 0x10000 + (carvedSeq++ and 0xFFFF); val ext = e.type.substringAfter('/', "bin")
        val o = LotObject(port, id, "carved_${hex4(port).substring(2)}_$carvedSeq.${if (ext == "jpeg") "jpg" else ext}", bytes.size, bytes, e.type, clock())
        addObject(o, "carved", programOfPort(port), HdLot.inspectFile(bytes, e.type), from)
    }
    /** A port's transport by the directory: 0 stream, 1 packet, 3 LOT, -1 not listed. */
    private fun aasType(port: Int): Int {
        for (s in sig) for (c in s.components) if (c.port == port) return c.aasType
        return -1
    }
    /** The ports the directory lists as stream or packet services (no LOT framing on them). */
    private fun notLot(port: Int): Boolean { val t = aasType(port); return t == 0 || t == 1 }

    /** Ports the service directory names as image components: album art (the PSD's MIME) and logos (the rest). */
    private fun componentPorts(art: MutableSet<Int>, logo: MutableSet<Int>) {
        val artMime = HashSet<Long>()
        for (p in progs.values) if (p.artMime != 0L) artMime.add(p.artMime)
        for (s in sig) if (s.kind == "audio") for (c in s.components) (if (c.mime in artMime || "album art" in c.mimeName) art else logo).add(c.port)
    }
    /** The audio program a port belongs to by the directory, or -1. */
    private fun programOfPort(port: Int): Int {
        for (s in sig) if (s.kind == "audio" && s.components.any { it.port == port }) return s.program
        return -1
    }

    /** One decoded L1 frame: the L2 PDU from P1, the 16 SIS PDUs (L2 bit order) and the frame's quality. */
    fun addFrame(pdu: HdL2.Pdu, sis: List<ByteArray>, ber: Double, snrLoDb: Double, snrHiDb: Double) {
        val now = clock()
        frames++; lastFrameMs = now; if (firstFrameMs == 0L) firstFrameMs = now
        if (pdu.pciErrors <= 2) framesGood++
        val stat = FrameStat(now, pdu.pci, pdu.pciErrors, ber, snrLoDb, snrHiDb)
        history.addLast(stat)
        if (history.size > 120) history.removeFirst()
        lastPci = pdu.pci
        val adv = IntArray(sis.size)
        var allOk = sis.size == 16
        sis.forEachIndexed { i, b -> val p = HdSis.parse(b); sisVoter.add(p); adv[i] = p.advAlfn; allOk = allOk && p.crcOk }
        if (allOk) sisVoter.setAlfn(HdSis.alfnFromPairs(adv), now) else if (frames > 1) sisVoter.skipFrame()
        if (pdu.pciErrors > 4) return
        val (g0, b0) = fcsCounts()
        l2(pdu, now)
        val (g1, b1) = fcsCounts(); stat.fcsGood = g1 - g0; stat.fcsBad = b1 - b0
        val sm = sisVoter.summary(); val cs = sm.callsign
        if (cs.isNotEmpty() && cs != callLogged && sm.nameVotes.first >= 3) { callLogged = cs; onEvent("station · $cs") }
    }

    /** A P3 or P4 transfer frame (modes MP2, MP3, MP11): its audio and program data. */
    fun addP3(pdu: HdL2.Pdu, ber: Double) {
        p3Frames++; p3Ber = if (p3Frames > 1) p3Ber * 0.9 + ber * 0.1 else ber
        if (pdu.pciErrors > 4) return
        p3Good++
        l2(pdu, clock(), true)
    }

    private fun l2(pdu: HdL2.Pdu, now: Long, p3: Boolean = false) {
        val by = pdu.bytes; val pci = pdu.pci; val withFixed = !p3 && (pci == 2 || pci == 3 || pci == 4)
        var (pdus, end) = HdL2.parseAudioRegion(by, by.size)
        if (withFixed && fixed.ccc != null) {
            val fs = fixed.fixedStart(by.size)
            pdus = pdus.filter { it.end < fs }; end = if (pdus.isNotEmpty()) pdus.last().end + 1 else 0
        }
        onAudio(by, pdus)
        for (d in pdus) {
            var p = progs[d.program]
            if (p == null) {
                p = ProgramRow(d.program, -1, "", d.codecMode, 0.0, now, now)
                progs[d.program] = p
                onEvent("program · HD${d.program + 1} · codec mode ${d.codecMode}")
            }
            p.lastMs = now; p.codecMode = d.codecMode
            if (d.program == 0) { blends.addLast(d.blend); if (blends.size > 8) blends.removeFirst() }
            if (d.progType != null) { p.type = d.progType; p.typeName = HdSis.programTypeName(d.progType) }
            val kb = (d.end - d.off + 1) * 8 / (if (p3) FRAME_S / 8 else FRAME_S) / 1000; p.kbps = if (p.kbps != 0.0) p.kbps * 0.8 + kb * 0.2 else kb
            val s = psd.getOrPut(d.program) { HdL2.HdlcStream(false) }
            for (f in s.feed(d.psd)) {
                if (!f.ok) { p.psdBad++; continue }
                val pk = HdL2.parsePacket(f.frame) ?: continue
                p.psdFrames++
                if (pk.port !in p.psdPorts) p.psdPorts = p.psdPorts + pk.port
                val tag = HdL2.parseId3(pk.payload)
                if (tag != null) onTag(p, tag, now)
                else {
                    p.psdOther++; p.psdOtherHex = PortInventory.hex(pk.payload, 0, minOf(48, pk.payload.size))
                    val pb = ByteArray(pk.payload.size) { pk.payload[it].toByte() }
                    for (e in HdLot.scanEmbedded(pb, 0, 4)) if (e.complete) carved(pk.port, e, pb.copyOfRange(e.offset, e.offset + e.length), "HD${p.n + 1} PSD")
                }
            }
        }
        if (p3) return
        if (withFixed) {
            val (segs, start) = fixed.split(by, end)
            segs.forEachIndexed { i, seg ->
                while (subs.size <= i) subs.add(null)
                val st = subs[i] ?: HdL2.HdlcStream(true).also { subs[i] = it }
                feedBearer(st, seg, "fixed $i", now)
            }
            if (pci == 3) opportunistic(by, end, start, now)
        } else if (pci == 1) opportunistic(by, end, by.size, now)
    }

    /** 1019s 7.4: after the DDL, RS(255,223) codewords each behind a block boundary marker; the systematic bytes. */
    private fun opportunistic(by: IntArray, from: Int, to: Int, now: Long) {
        val k = find(by, DDL, from, to); if (k < 0) return
        val data = ArrayList<Int>()
        var q = k + 5
        while (true) { val j = find(by, HdL2.BBM, q, to); if (j < 0) break; for (i in j + 4 until minOf(to, j + 4 + 223)) data.add(by[i]); q = j + 4 + 255 }
        feedBearer(opp, data.toIntArray(), "opportunistic", now)
    }

    private fun feedBearer(s: HdL2.HdlcStream, seg: IntArray, bearer: String, now: Long) {
        for (f in s.feed(seg)) {
            if (!f.ok) continue
            val pk = HdL2.parsePacket(f.frame) ?: continue
            // the fixed bearer's CCC (1019s 7.5) is HDLC framed too: it reads as port 0 with a zero DTPF
            if (pk.dtpf == 0 && pk.port == 0) { cccFrames++; continue }
            val r = ports.getOrPut(pk.port) { PortAcc(pk.port, bearer, 0, 0, now, now, 0, "", -1) }
            if (r.lastSeq >= 0 && ((pk.seq - r.lastSeq) and 0xFFFF) != 1) r.seqGaps++
            r.lastSeq = pk.seq; r.packets++; r.bytes += pk.payload.size; r.lastMs = now
            inv.add(pk.port, pk.dtpf, pk.seq, pk.payload, aasType(pk.port))
            if (pk.port == SIG_PORT) { val s2 = HdLot.parseSig(pk.payload); if (s2.isNotEmpty()) { sig = s2; sigSeen++ }; r.kind = "directory"; continue }
            if (!notLot(pk.port)) lot.add(pk.port, pk.payload)
        }
    }

    private fun onTag(p: ProgramRow, tag: List<HdL2.Id3Frame>, now: Long) {
        var title = ""; var artist = ""; var album = ""; var genre = ""; var comment = ""
        for (f in tag) {
            when (f.id) {
                "TIT2" -> title = f.text ?: ""
                "TPE1" -> artist = f.text ?: ""
                "TALB" -> album = f.text ?: ""
                "TCON" -> genre = f.text ?: ""
                "COMM" -> comment = f.text ?: ""
                "XHDR" -> HdLot.parseXhdr(f.bytes)?.let { x -> p.artMime = x.mime; p.artId = x.objectId; p.artFlush = x.flush && x.objectId == null }
                "COMR" -> f.commercial?.let { c -> p.commercial = HdCommercial(c.price, c.validUntil, c.url, c.receivedAs, c.seller, c.description) }
                "UFID" -> p.ufid = HdUfid(f.desc ?: "", f.text?.ifEmpty { null } ?: PortInventory.hex(f.data ?: IntArray(0)))
            }
            val pic = when {
                f.id == "APIC" && (f.data?.size ?: 0) > 0 -> f.data
                f.id == "COMR" && (f.commercial?.logo?.size ?: 0) > 0 -> f.commercial?.logo
                f.id == "GEOB" && (f.data?.size ?: 0) > 0 -> f.data
                else -> null
            }
            if (pic != null) {
                val key = "${p.n}/${pic.size}/${PortInventory.hex(pic, 0, minOf(16, pic.size))}"
                if (apicSeen.add(key)) {
                    val pb = ByteArray(pic.size) { pic[it].toByte() }
                    val e = HdLot.scanEmbedded(pb, 0, 1).firstOrNull()
                    val type = if (e?.offset == 0) e.type else f.mime?.ifEmpty { null } ?: f.commercial?.logoMime?.ifEmpty { null } ?: "application/octet-stream"
                    carved(0x5100 + p.n, Embedded(type, 0, pb.size, true, e?.width, e?.height), pb,
                        "HD${p.n + 1} PSD ${f.id}${if (!f.desc.isNullOrEmpty()) " \"${f.desc}\"" else ""}")
                }
            }
        }
        p.id3 = tag.map { f -> Id3Row(f.id, f.text ?: "", f.desc ?: "", f.lang ?: "", f.bytes.size, PortInventory.hex(f.bytes, 0, minOf(64, f.bytes.size)), KNOWN_ID3.matches(f.id)) }
        p.title = title; p.artist = artist; p.album = album; p.genre = genre; p.comment = comment
        val key = "$title\u0001$artist"
        if (title.isNotEmpty() && lastTitle[p.n] != key) {
            lastTitle[p.n] = key
            p.songs = (listOf(HdSong(now, title, artist, album, genre)) + p.songs).take(50)
            onEvent("HD${p.n + 1} · $title${if (artist.isNotEmpty()) " · $artist" else ""}${if (album.isNotEmpty()) " · $album" else ""}")
        }
    }

    fun snapshot(): StationSnap {
        val last = history.lastOrNull()
        val sis = sisVoter.summary()
        val programs = progs.values.sortedBy { it.n }.toMutableList()
        for (p in programs) if (p.type < 0) sis.audio.firstOrNull { it.program == p.n }?.let { a -> p.type = a.type; p.typeName = HdSis.programTypeName(a.type) }
        val out = programs.map { it.copy() }.toMutableList()
        for (a in sis.audio) if (!progs.containsKey(a.program)) out.add(ProgramRow(a.program, a.type, HdSis.programTypeName(a.type), -1, 0.0, 0, 0))
        out.sortBy { it.n }
        val comps = sig.flatMap { s -> s.components.map { s to it } }
        val portRows = ports.values.map { r ->
            val comp = comps.firstOrNull { it.second.port == r.port }
            PortRow(r.port, r.bearer, r.packets, r.bytes, r.lastMs, r.firstMs, r.seqGaps,
                r.kind.ifEmpty { if (comp != null) (if (comp.first.kind == "audio") "HD${comp.first.program + 1}" else "data") else "" }, comp?.first?.name ?: "")
        }.sortedBy { it.port }
        val sb = subs.filterNotNull()
        val lotP = lotPorts()
        return StationSnap(
            frames, framesGood, lastFrameMs, firstFrameMs, lastPci, if (lastPci >= 0) HdL2.PCI_CONTENT[lastPci] else "",
            last?.ber ?: 1.0, last?.snrLoDb ?: -99.0, last?.snrHiDb ?: -99.0, history.toList().takeLast(60),
            sis, out, sig, false, portRows, objects.take(120), lot.pending().take(40), fixed.ccc,
            sb.sumOf { it.bbm } + opp.bbm, sb.sumOf { it.good } + opp.good, sb.sumOf { it.bad } + opp.bad, blend(),
            inv.info(lotP), inv.findings.take(80), unknowns(sis, portRows, lotP), P3Stats(p3Frames, p3Good, p3Ber),
        )
    }

    /** Ports that carry objects: the directory says LOT, or an object came or is coming on them. */
    private fun lotPorts(): Set<Int> {
        val s = HashSet<Int>()
        for (v in sig) for (c in v.components) if (c.aasType == 3) s.add(c.port)
        for (o in objects) if (o.from.isEmpty()) s.add(o.port)
        for (p in lot.pending()) s.add(p.port)
        return s
    }
    /** What the station sends that is not decoded, each with what could be told about it. */
    private fun unknowns(sis: SisSummary, ports: List<PortRow>, lot: Set<Int>): List<HdUnknown> {
        val out = ArrayList<HdUnknown>()
        val comps = sig.flatMap { s -> s.components.map { s to it } }
        for (pi in inv.info(lot)) {
            if (pi.port == SIG_PORT || pi.content == "LOT objects" || pi.content == "images") continue
            val comp = comps.firstOrNull { it.second.port == pi.port }
            val named = if (comp != null) "${comp.first.name.ifEmpty { "unnamed service" }} · ${comp.second.mimeName.ifEmpty { "MIME ${comp.second.mimeHex}" }} · ${comp.second.aasTypeName} · ${HdSis.dataTypeName(comp.second.dataType)}" else "not in the service directory"
            val t = pi.tpeg
            val body = if (t != null && t.frames > 0) {
                val types = t.frameTypes.entries.joinToString(", ") { (k, n) -> "$k${if (k == "1") "" else " (not a TPEG type)"} ×$n" }
                val svc = if (t.services.isNotEmpty()) "; service ${t.services.joinToString(", ") { s -> "${s.text.ifEmpty { s.sid }} with encryption indicator ${if (s.encId == 0) "0 (clear)" else "0x${Integer.toHexString(s.encId)}"}" }}" else ""
                "TPEG transport frames (${t.frames}, header CRC verified; frame types $types$svc): the service frame contents are scrambled (a subscription service), so they are not decoded"
            } else "${pi.content}, ${fmtNum(pi.entropy)} bits/byte, ${pi.minLen}..${pi.maxLen} B packets, starts ${pi.firstHex.take(24)}"
            out.add(HdUnknown("port ${hex4(pi.port)} (${ports.firstOrNull { it.port == pi.port }?.bearer ?: ""})", "$named: $body"))
        }
        for (s in sig) for (e in s.extra) if (e.tag != 0x66 && e.text.isEmpty()) out.add(HdUnknown("service directory ${s.name.ifEmpty { s.id.toString() }}", "tag 0x${Integer.toHexString(e.tag)}: ${e.hex}"))
        for (s in sig) for (c in s.components) if (ports.none { it.port == c.port })
            out.add(HdUnknown("port ${hex4(c.port)}", "listed in the directory (${s.name.ifEmpty { s.id.toString() }} · ${c.mimeName.ifEmpty { "MIME ${c.mimeHex}" }} · ${c.aasTypeName}) but nothing heard on it yet"))
        for (o in sis.other) out.add(HdUnknown("SIS message ${o.id}", "${o.n} PDUs with a message id the standard reserves: ${o.bits}"))
        if (sis.llds > 0) out.add(HdUnknown("SIS LLDS", "${sis.llds} low latency data PDUs (${sis.lldsDistinct} distinct), not in the documents: ${sis.lldsLast}"))
        if (sis.alertsBad > 0) out.add(HdUnknown("SIS emergency alert", "${sis.alertsBad} alerts whose CRC failed"))
        for (p in progs.values) {
            if (p.psdOther > 0) out.add(HdUnknown("HD${p.n + 1} PSD", "${p.psdOther} packets that are not ID3: ${p.psdOtherHex}"))
            for (f in p.id3) if (!f.known) out.add(HdUnknown("HD${p.n + 1} ID3 ${f.id}", "${f.size} bytes: ${f.hex}"))
        }
        val c = fixed.ccc
        if (c != null && c.subs.any { it.parity != 0 || it.interleave != 0 })
            out.add(HdUnknown("fixed data", "sub-channels with RS parity or interleaving (${c.subs.joinToString(",", "[", "]") { "{\"parity\":${it.parity},\"interleave\":${it.interleave},\"length\":${it.length}}" }}), not undone"))
        return out
    }

    private val blends = ArrayDeque<Int>()
    /** HDLC frames so far that passed and failed their FCS, every stream. */
    private fun fcsCounts(): Pair<Int, Int> {
        var g = opp.good; var b = opp.bad
        for (s in subs) if (s != null) { g += s.good; b += s.bad }
        for (s in psd.values) { g += s.good; b += s.bad }
        return g to b
    }
    private fun blend(): Int {
        if (blends.isEmpty()) return -1
        val c = IntArray(4); for (b in blends) c[b and 3]++
        return c.indices.maxByOrNull { c[it] }!!
    }

    /** A missed frame breaks the byte streams: drop the partial frames. */
    fun gap() { for (s in subs) s?.clear(); opp.clear(); for (s in psd.values) s.clear() }

    companion object {
        const val SIG_PORT = 0x0020
        private const val FRAME_S = 65536.0 / 44100
        private val DDL = intArrayOf(0x9D, 0x2F, 0x39, 0x05, 0xD8)
        /** ID3 frames 1028s gives a meaning to, and the ones every tag reader knows. */
        private val KNOWN_ID3 = Regex("^(T[A-Z0-9]{3}|COMM|COMR|UFID|XHDR|APIC|GEOB|PRIV|USLT|W[A-Z0-9]{3})$")
        fun hex4(v: Int) = "0x%04X".format(v)
        /** A number as the web prints it: no trailing .0. */
        private fun fmtNum(v: Double) = if (v == Math.floor(v)) v.toLong().toString() else v.toString()
        private fun find(by: IntArray, pat: IntArray, from: Int, to: Int): Int {
            var i = maxOf(0, from)
            outer@ while (i + pat.size <= to) { for (j in pat.indices) if (by[i + j] != pat[j]) { i++; continue@outer }; return i }
            return -1
        }
    }
}
