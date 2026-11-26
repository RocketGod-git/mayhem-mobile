package com.rocketgod.mayhem.core.hd

/** What each AAS port carries: sizes, a sample, entropy, TPEG frames (ISO/TS 18234-2) and images found inside. */
class TpegService(val sid: String, val text: String, val encId: Int, var frames: Int)
class TpegStats(
    var frames: Int = 0, var crcBad: Int = 0, val frameTypes: LinkedHashMap<String, Int> = LinkedHashMap(),
    /** Service ids (SID-A.B.C, and as text when printable) with their encryption indicator (0: in the clear). */
    var services: List<TpegService> = emptyList(),
    var lastHex: String = "",
) {
    fun copy() = TpegStats(frames, crcBad, LinkedHashMap(frameTypes), services.map { TpegService(it.sid, it.text, it.encId, it.frames) }, lastHex)
}
class PortInfo(
    val port: Int, val dtpf: List<Int>, val minLen: Int, val maxLen: Int, val firstHex: String, val lastHex: String,
    /** Over the last bytes sent: bits per byte (near 8 is compressed or encrypted) and the share that is text. */
    val entropy: Double, val printable: Double,
    /** What the bytes look like: "LOT objects", "TPEG stream", "images", "text", "random (encrypted or compressed)", "binary". */
    val content: String, val packets: Int, val lotHeaders: Int, val tpeg: TpegStats?, val images: Int,
)
/** Something found where it was not announced: an image inside a stream or a file, text inside an image, a PSD picture. */
class Finding(val where: String, val port: Int, val type: String, val offset: Int, val length: Int, val width: Int?, val height: Int?, val complete: Boolean, val note: String, val ms: Long)

class PortInventory {
    /** A whole image cut out of a stream. */
    var onCarved: (Int, Embedded, ByteArray) -> Unit = { _, _, _ -> }
    val findings = ArrayList<Finding>()
    /** The clock findings are stamped with (tests hold it still). */
    var clock: () -> Long = { System.currentTimeMillis() }

    private class PortState(val port: Int, val firstHex: String) {
        val dtpf = ArrayList<Int>(); var minLen = Int.MAX_VALUE; var maxLen = 0; var lastHex = ""
        var packets = 0; var lotHeaders = 0; var tpeg: TpegStats? = null; var images = 0
        var sample = ByteArray(SAMPLE); var sampleN = 0; var sampleW = 0
        val tbuf = ArrayList<Int>()
        var carve = ByteArray(0); var carveLen = 0; var carveBase = 0L
        var cands = ArrayList<Long>(); val seen = HashSet<Long>(); val uniq = HashSet<String>(); var lastSeq = -1
        val tsvc = LinkedHashMap<String, TpegService>()
        fun sampleBytes(): ByteArray = if (sampleN < SAMPLE) sample.copyOf(sampleN) else ByteArray(SAMPLE) { sample[(sampleW + it) % SAMPLE] }
    }
    private val ports = LinkedHashMap<Int, PortState>()

    /** One packet's payload; [aas] is the directory's transport for the port (3 LOT, 0 stream, 1 packet, -1 not listed). */
    fun add(port: Int, dtpf: Int, seq: Int, p: IntArray, aas: Int = -1) {
        val s = ports.getOrPut(port) { PortState(port, hex(p, 0, minOf(32, p.size))) }
        s.packets++
        if (dtpf !in s.dtpf) s.dtpf.add(dtpf)
        s.minLen = minOf(s.minLen, p.size); s.maxLen = maxOf(s.maxLen, p.size); s.lastHex = hex(p, 0, minOf(32, p.size))
        for (x in p) { s.sample[s.sampleW] = x.toByte(); s.sampleW = (s.sampleW + 1) % SAMPLE; if (s.sampleN < SAMPLE) s.sampleN++ }
        if (p.size >= 8 && p[0] >= 8 && p[0] <= p.size && (if ((p[4] or p[5] or p[6] or p[7]) == 0) p.size > 11 && p[8] == 1 && p[9] == 0 && p[10] == 0 && p[11] == 0 else p[0] == 8)) s.lotHeaders++
        val gap = s.lastSeq >= 0 && ((seq - s.lastSeq) and 0xFFFF) != 1
        s.lastSeq = seq
        if (gap) { s.tbuf.clear(); s.cands.clear() }
        for (x in p) s.tbuf.add(x)
        tpeg(s)
        // LOT ports are looked into file by file, once each is whole
        val lot = aas == 3 || (aas < 0 && s.lotHeaders >= 2 && s.lotHeaders >= 0.8 * s.packets)
        if (!lot) carve(s, p, gap)
    }

    /** TPEG transport frames in a port's byte stream. */
    private fun tpeg(s: PortState) {
        val b = s.tbuf
        var i = 0
        while (true) {
            while (i + 1 < b.size && !(b[i] == 0xFF && b[i + 1] == 0x0F)) i++
            if (i + 18 > b.size) break
            val len = (b[i + 2] shl 8) or b[i + 3]; val crc = (b[i + 4] shl 8) or b[i + 5]
            val h = IntArray(16) { if (it < 4) b[i + it] else b[i + 2 + it] }
            if ((ccitt(h) xor 0xFFFF) != crc) { s.tpeg?.let { it.crcBad++ }; i++; continue }
            if (i + 7 + len > b.size) break
            val t = s.tpeg ?: TpegStats().also { s.tpeg = it }
            val ft = b[i + 6]
            t.frames++; t.frameTypes[ft.toString()] = (t.frameTypes[ft.toString()] ?: 0) + 1; t.lastHex = hex(IntArray(minOf(32, b.size - i)) { b[i + it] })
            if (ft == 1) {
                val sid = "${b[i + 7]}.${b[i + 8]}.${b[i + 9]}"
                val txt = if (listOf(b[i + 7], b[i + 8], b[i + 9]).all { it in 32..126 }) String(charArrayOf(b[i + 7].toChar(), b[i + 8].toChar(), b[i + 9].toChar())) else ""
                val key = "$ft/$sid"; val e = s.tsvc[key]
                if (e != null) e.frames++ else s.tsvc[key] = TpegService(sid, txt, b[i + 10], 1)
                t.services = s.tsvc.values.toList()
            }
            i += 7 + len
        }
        val drop = maxOf(0, minOf(i, b.size - 1))
        if (drop > 0) b.subList(0, drop).clear()
        if (b.size > 65_536) b.subList(0, b.size - 65_536).clear()
    }

    /** Image starts in the stream; each is cut out once it ends, or noted as cut short when the stream breaks first. */
    private fun carve(s: PortState, p: IntArray, gap: Boolean) {
        if (gap) { s.carveBase += s.carveLen; s.carveLen = 0 }
        if (s.carve.size < s.carveLen + p.size) s.carve = s.carve.copyOf(maxOf(4096, (s.carveLen + p.size) * 2))
        val from = maxOf(0, s.carveLen - 32)
        for (k in p.indices) s.carve[s.carveLen + k] = p[k].toByte()
        s.carveLen += p.size
        val buf = s.carve; val n = s.carveLen
        for (e in HdLot.scanEmbedded(buf, from, 8, n)) { val abs = s.carveBase + e.offset; if (abs !in s.seen && abs !in s.cands) s.cands.add(abs) }
        val keep = ArrayList<Long>()
        for (abs in s.cands) {
            val off = (abs - s.carveBase).toInt(); if (off < 0) continue
            val e = HdLot.scanEmbedded(buf, off, 1, n).firstOrNull()
            if (e == null || e.offset != off) continue
            if (!e.complete) { if (n - off < CARVE) keep.add(abs); continue }
            s.seen.add(abs)
            // carousels repeat the same images; keep each once
            if (!s.uniq.add("${e.length}:${fnv(buf, off, off + e.length)}")) continue
            s.images++
            note(Finding("port ${hex4(s.port)} stream", s.port, e.type, abs.toInt(), e.length, e.width, e.height, true, "an image inside the byte stream, cut out whole", clock()))
            onCarved(s.port, e, buf.copyOfRange(off, off + e.length))
        }
        s.cands = keep
        if (s.carveLen > CARVE * 2) {
            val kp = if (s.cands.isNotEmpty()) (s.cands.min() - s.carveBase).toInt() else s.carveLen - 64
            val k = maxOf(0, minOf(kp, s.carveLen - 64))
            System.arraycopy(s.carve, k, s.carve, 0, s.carveLen - k); s.carveLen -= k; s.carveBase += k
        }
    }

    fun note(f: Finding) {
        if (findings.any { it.where == f.where && it.offset == f.offset && it.type == f.type }) return
        findings.add(0, f); if (findings.size > 200) findings.subList(200, findings.size).clear()
    }

    fun info(lotPorts: Set<Int>): List<PortInfo> = ports.values.map { s ->
        val smp = s.sampleBytes(); val h = HdLot.entropy(smp); val pr = HdLot.printable(smp)
        val tf = s.tpeg?.frames ?: 0
        val content = if (s.port in lotPorts || (s.lotHeaders >= 0.8 * s.packets && s.lotHeaders >= 2 && tf == 0)) "LOT objects" else if (tf > 0) "TPEG stream" else if (s.images > 0) "images" else if (pr > 0.95) "text" else if (h > 7.5) "random (encrypted or compressed)" else "binary"
        PortInfo(s.port, s.dtpf.toList(), if (s.minLen == Int.MAX_VALUE) 0 else s.minLen, s.maxLen, s.firstHex, s.lastHex, round2(h), round2(pr), content, s.packets, s.lotHeaders, s.tpeg?.copy(), s.images)
    }.sortedBy { it.port }
    /** A sample of a port's last bytes (for a hex view). */
    fun sample(port: Int, n: Int = 256): String { val s = ports[port] ?: return ""; val b = s.sampleBytes(); return hexB(b, maxOf(0, b.size - n), b.size) }

    companion object {
        private const val SAMPLE = 16_384
        private const val CARVE = 1 shl 20
        private fun round2(v: Double) = Math.round(v * 100) / 100.0
        fun hex(b: IntArray, from: Int = 0, to: Int = b.size): String { val sb = StringBuilder(); for (i in from until to) sb.append("%02x".format(b[i] and 0xFF)); return sb.toString() }
        fun hexB(b: ByteArray, from: Int = 0, to: Int = b.size): String { val sb = StringBuilder(); for (i in maxOf(0, from) until minOf(to, b.size)) sb.append("%02x".format(b[i].toInt() and 0xFF)); return sb.toString() }
        private fun fnv(b: ByteArray, from: Int, to: Int): Int { var h = -2128831035; for (i in from until to) { h = h xor (b[i].toInt() and 0xFF); h *= 16777619 }; return h }
        private fun hex4(v: Int) = "0x%04X".format(v)
        /** CRC-CCITT, x^16 + x^12 + x^5 + 1, from 0xFFFF, high bit first. */
        fun ccitt(b: IntArray): Int {
            var c = 0xFFFF
            for (x in b) { c = c xor (x shl 8); for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF }
            return c
        }
    }
}
