package com.rocketgod.mayhem.core.hd

/**
 * Everything one HD station sends, built up frame by frame from its L2 PDUs and SIS PDUs: programs and what each is
 * playing (PSD), the fixed and opportunistic data bearers, AAS ports, the service directory, large objects and the
 * voted SIS fields.
 */
class HdSong(val ms: Long, val title: String, val artist: String, val album: String, val genre: String)

class ProgramRow(
    val n: Int, var type: Int, var typeName: String, var codecMode: Int, var kbps: Double, var lastMs: Long, val firstMs: Long,
    var title: String = "", var artist: String = "", var album: String = "", var genre: String = "", var comment: String = "",
    /** The object id of this song's image (from XHDR), or null; [artFlush] when the station says there is none. */
    var artId: Int? = null, var artFlush: Boolean = false, var artMime: Long = 0,
    var songs: List<HdSong> = emptyList(), var psdFrames: Int = 0, var psdBad: Int = 0,
) {
    fun copy(songCap: Int = 20) = ProgramRow(n, type, typeName, codecMode, kbps, lastMs, firstMs, title, artist, album, genre, comment, artId, artFlush, artMime, songs.take(songCap), psdFrames, psdBad)
}
class PortRow(val port: Int, val bearer: String, val packets: Int, val bytes: Int, val lastMs: Long, val firstMs: Long, val seqGaps: Int, val kind: String, val name: String)
class ObjectRow(val port: Int, val id: Int, val name: String, val size: Int, val mime: String, val kind: String, val ms: Long, val program: Int)
class FrameStat(val ms: Long, val pci: Int, val pciErrors: Int, val ber: Double, val snrLoDb: Double, val snrHiDb: Double)
/** A finished object with what it is and which program it belongs to (-1: the station). */
class HdObject(val o: LotObject, val kind: String, val program: Int)

class StationSnap(
    val frames: Int, val framesGood: Int, val lastFrameMs: Long, val firstFrameMs: Long, val pci: Int, val pciName: String,
    val ber: Double, val snrLoDb: Double, val snrHiDb: Double, val history: List<FrameStat>,
    val sis: SisSummary, val programs: List<ProgramRow>, val sig: List<HdLot.SigService>, val sigVerified: Boolean, val ports: List<PortRow>, val objects: List<ObjectRow>,
    val pending: List<LotPending>, val ccc: HdL2.Ccc?, val bbm: Int, val hdlcGood: Int, val hdlcBad: Int,
)

class HdStation {
    var onObject: (HdObject) -> Unit = {}
    var onEvent: (String) -> Unit = {}
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

    init {
        lot.clock = { clock() }
        lot.onObject = { o ->
            val art = HashSet<Int>(); val logo = HashSet<Int>()
            componentPorts(art, logo)
            val kind = HdLot.lotKind(o.name, o.mime, o.port, art, logo)
            val program = programOfPort(o.port)
            objects.add(0, ObjectRow(o.port, o.id, o.name, o.size, o.mime, kind, o.ms, program)); if (objects.size > 200) objects.subList(200, objects.size).clear()
            onObject(HdObject(o, kind, program))
            onEvent("object · port ${hex4(o.port)} · ${o.name.ifEmpty { "id ${hex4(o.id)}" }} · ${o.size} bytes · $kind")
        }
    }

    /** Ports the service directory names as image components: album art (the PSD's MIME) and logos (the rest). */
    private fun componentPorts(art: MutableSet<Int>, logo: MutableSet<Int>) {
        val artMime = HashSet<Long>()
        for (p in progs.values) if (p.artMime != 0L) artMime.add(p.artMime)
        for (s in sig) if (s.kind == "audio") for (c in s.components) (if (c.mime in artMime) art else logo).add(c.port)
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
        history.addLast(FrameStat(now, pdu.pci, pdu.pciErrors, ber, snrLoDb, snrHiDb))
        if (history.size > 120) history.removeFirst()
        lastPci = pdu.pci
        val adv = IntArray(sis.size)
        sis.forEachIndexed { i, b -> val p = HdSis.parse(b); sisVoter.add(p); adv[i] = p.advAlfn }
        if (adv.size == 16) sisVoter.setAlfn(HdSis.alfnFromPairs(adv))
        if (pdu.pciErrors > 4) return
        l2(pdu, now)
        val sm = sisVoter.summary(); val cs = sm.callsign
        if (cs.isNotEmpty() && cs != callLogged && sm.nameVotes.first >= 3) { callLogged = cs; onEvent("station · $cs") }
    }

    private fun l2(pdu: HdL2.Pdu, now: Long) {
        val by = pdu.bytes; val pci = pdu.pci; val withFixed = pci == 2 || pci == 3 || pci == 4
        var (pdus, end) = HdL2.parseAudioRegion(by, by.size)
        if (withFixed && fixed.ccc != null) {
            val fs = fixed.fixedStart(by.size)
            pdus = pdus.filter { it.end < fs }; end = if (pdus.isNotEmpty()) pdus.last().end + 1 else 0
        }
        for (d in pdus) {
            var p = progs[d.program]
            if (p == null) {
                p = ProgramRow(d.program, -1, "", d.codecMode, 0.0, now, now)
                progs[d.program] = p
                onEvent("program · HD${d.program + 1} · codec mode ${d.codecMode}")
            }
            p.lastMs = now; p.codecMode = d.codecMode
            if (d.progType != null) { p.type = d.progType; p.typeName = HdSis.programTypeName(d.progType) }
            val kb = (d.end - d.off + 1) * 8 / FRAME_S / 1000; p.kbps = if (p.kbps != 0.0) p.kbps * 0.8 + kb * 0.2 else kb
            val s = psd.getOrPut(d.program) { HdL2.HdlcStream(false) }
            for (f in s.feed(d.psd)) {
                if (!f.ok) { p.psdBad++; continue }
                val pk = HdL2.parsePacket(f.frame) ?: continue
                p.psdFrames++
                val tag = HdL2.parseId3(pk.payload)
                if (tag != null) onTag(p, tag, now)
            }
        }
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
            val r = ports.getOrPut(pk.port) { PortAcc(pk.port, bearer, 0, 0, now, now, 0, "", -1) }
            if (r.lastSeq >= 0 && ((pk.seq - r.lastSeq) and 0xFFFF) != 1) r.seqGaps++
            r.lastSeq = pk.seq; r.packets++; r.bytes += pk.payload.size; r.lastMs = now
            if (pk.port == SIG_PORT) { val s2 = HdLot.parseSig(pk.payload); if (s2.isNotEmpty()) { sig = s2; sigSeen++ }; r.kind = "directory"; continue }
            lot.add(pk.port, pk.payload)
        }
    }

    private fun onTag(p: ProgramRow, tag: List<HdL2.Id3Frame>, now: Long) {
        var title = ""; var artist = ""; var album = ""; var genre = ""; var comment = ""
        for (f in tag) when (f.id) {
            "TIT2" -> title = f.text ?: ""
            "TPE1" -> artist = f.text ?: ""
            "TALB" -> album = f.text ?: ""
            "TCON" -> genre = f.text ?: ""
            "COMM" -> comment = f.text ?: ""
            "XHDR" -> HdLot.parseXhdr(f.bytes)?.let { x -> p.artMime = x.mime; p.artId = x.objectId; p.artFlush = x.flush && x.objectId == null }
        }
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
        return StationSnap(
            frames, framesGood, lastFrameMs, firstFrameMs, lastPci, if (lastPci >= 0) HdL2.PCI_CONTENT[lastPci] else "",
            last?.ber ?: 1.0, last?.snrLoDb ?: -99.0, last?.snrHiDb ?: -99.0, history.toList().takeLast(60),
            sis, out, sig, false, portRows, objects.take(120), lot.pending().take(40), fixed.ccc,
            sb.sumOf { it.bbm } + opp.bbm, sb.sumOf { it.good } + opp.good, sb.sumOf { it.bad } + opp.bad,
        )
    }

    /** A missed frame breaks the byte streams: drop the partial frames. */
    fun gap() { for (s in subs) s?.clear(); opp.clear(); for (s in psd.values) s.clear() }

    companion object {
        const val SIG_PORT = 0x0020
        private const val FRAME_S = 65536.0 / 44100
        private val DDL = intArrayOf(0x9D, 0x2F, 0x39, 0x05, 0xD8)
        fun hex4(v: Int) = "0x%04X".format(v)
        private fun find(by: IntArray, pat: IntArray, from: Int, to: Int): Int {
            var i = maxOf(0, from)
            outer@ while (i + pat.size <= to) { for (j in pat.indices) if (by[i + j] != pat[j]) { i++; continue@outer }; return i }
            return -1
        }
    }
}
