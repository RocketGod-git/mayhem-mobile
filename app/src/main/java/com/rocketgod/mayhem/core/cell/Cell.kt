package com.rocketgod.mayhem.core.cell

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * Cell: LTE broadcast information and emergency alerts, receive only. Captures blocks of the downlink, finds cells
 * (PSS/SSS), reads the MIB from the central 6 RBs (any radio at 1.92 MS/s or more), and with the whole carrier in the
 * span decodes SI-RNTI traffic only: SIB1 and the SI messages (SIB2 to SIB24, ETWS and CMAS in SIB10/11/12).
 * The next block is placed on the next SI window still wanted, from the SFN timing of the last block.
 * Paging and every other RNTI are left alone.
 */
data class SibRec(val name: String, val si: Int, val ms: Long, val count: Int, val hex: String, val value: Obj)
data class SibSeen(val name: String, val si: Int, val ms: Long, val count: Int)
data class SiRow(val si: Int, val periodicity: Int, val sibs: List<String>, val ms: Long, val count: Int)
data class LogRow(val ms: Long, val hz: Long, val pci: Int, val kind: String, val text: String, val hex: String)
data class CellTime(val gpsIso: String, val utcIso: String)
data class CellRow(
    val key: String, val hz: Long, val pci: Int, val earfcn: Int?, val band: Int?, val tdd: Boolean,
    val firstMs: Long, val lastMs: Long, val mibMs: Long, val sib1Ms: Long,
    val mib: Mib?, val nrb: Int, val ports: Int, val sfn: Int,
    val snrDb: Double, val levelDb: Double, val cfoHz: Int, val pssScore: Double,
    val mibCount: Int, val sib1Count: Int, val dciCount: Int, val tbOk: Int, val tbFail: Int,
    val summary: Sib1Summary?, val sib2: Sib2Summary?, val sib3: Sib3Summary?, val neighbors: Neighbors?, val time: CellTime?,
    val sibs: List<SibSeen>, val si: List<SiRow>, val fullBand: Boolean, val complete: Boolean, val alerts: Int,
)
data class PssPeak(val nid2: Int, val score: Double)
class CellProfile(val lo: Double, val step: Int, val db: FloatArray)
data class CellSnap(
    val centerHz: Long, val rate: Int, val full: Boolean, val maxRb: Int,
    val lte: Boolean, val cpStrength: Double, val blocks: Int, val searching: Boolean, val lastBlockMs: Long, val nextMs: Long, val cpuMs: Long,
    val profile: CellProfile?, val floorDb: Double,
    val cells: List<CellRow>, val alerts: List<WarningMessage>, val log: List<LogRow>, val dci: Int, val tbOk: Int,
    val pss: List<PssPeak>,
    /** A cell found off the tuned center (its own center), for the scan to retune to. */
    val offCenter: OffCenter? = null,
)
data class OffCenter(val hz: Long, val pci: Int, val ms: Long)
data class CellDetail(val key: String, val mib: Mib?, val sib1: Obj?, val sib1Hex: String, val sibs: List<SibRec>)

private class Timing(val abs: Double, val sfn: Int)
private class PendingTb(val tb: TbDecoder, val g: Int, val epoch: Int)
private class SiGot(val ms: Long, val count: Int)
private class Cell(val key: String, val hz: Long, val pci: Int, var band: Int?, var earfcn: Int?, val tdd: Boolean, var firstMs: Long, var lastMs: Long) {
    var mibMs = 0L; var sib1Ms = 0L
    var mib: Mib? = null; var snrDb = 0.0; var levelDb = 0.0; var cfoHz = 0.0; var pssScore = 0.0
    var mibCount = 0; var sib1Count = 0; var dciCount = 0; var tbOk = 0; var tbFail = 0
    var sib1: Obj? = null; var sib1Hex = ""; var summary: Sib1Summary? = null
    val sibs = LinkedHashMap<String, SibRec>(); val siGot = LinkedHashMap<Int, SiGot>()
    /** Absolute sample index of the start of a frame and its SFN, at the current rate. */
    var timing: Timing? = null
    var ctl: List<ControlDecoder> = emptyList(); val pending = HashMap<String, PendingTb>()
}
private class Found(val cell: Cell, val map: List<HalfFrame>, val evenSf0: Boolean, val tdd: Boolean, val mibH: Int)
private class MibHit(val mib: Mib, val snr: Double, val level: Double, val h: Int)

private const val BLOCK_MS = 40
/** Raster offsets tried when nothing is found on the tuned center, nearest first. */
private val RASTER = intArrayOf(100_000, -100_000, 200_000, -200_000, 300_000, -300_000)
private fun duplexPss(num: Numerology, tdd: Boolean): Int { if (!tdd) return num.pssOffset; val (o, cp) = num.symbol(2); return num.subframe + o + cp }
private fun sssLag(num: Numerology, tdd: Boolean) = if (tdd) 3 * num.nfft + 2 * num.cpn + num.cp0 else num.nfft + num.cpn
private fun round1(x: Double) = Math.round(x * 10) / 10.0

class CellProcessor(private val packets: PacketLog? = null) : IqProcessor {
    @Volatile var centerHz = 0L
    /** Where the radio is tuned, read at every buffer (the engine's frequency). */
    var centerOf: (() -> Long)? = null
    var now: () -> Long = { System.currentTimeMillis() }
    /** Live radio: skip input in proportion to the CPU a block took. Off for recordings, which wait for the decoder. */
    var realtime = true
    private val cells = LinkedHashMap<String, Cell>()
    val warnings = WarningAssembler()
    private val log = ArrayList<LogRow>()
    /** Bumped whenever something worth keeping changes (the state is saved when it moves). */
    @Volatile var version = 0; private set
    /** Called with every new or completed warning message. */
    var onAlert: ((WarningMessage) -> Unit)? = null
    var onNote: ((String) -> Unit)? = null
    private val _snap = MutableStateFlow<CellSnap?>(null)
    val snap: StateFlow<CellSnap?> = _snap.asStateFlow()

    private var rate = 0; private var dd = 0.0; private var num = Numerology(LOW_FS)
    private var abs = 0L; private var capStart = 0L; private var capN = 0; private var capLen = 0
    private var xr = FloatArray(0); private var xi = FloatArray(0)
    private var lastCenter = Long.MIN_VALUE; private var cfo = 0.0; private var cfoKnown = false
    private var blocks = 0; private var lastBlockMs = 0L; private var cpuMs = 0L; private var lte = false; private var cpStrength = 0.0; private var dci = 0; private var tbOkAll = 0
    private var offCenter: OffCenter? = null
    private var profile: CellProfile? = null; private var floorDb = 0.0; private var pss: List<PssPeak> = emptyList()
    private var lastPost = 0L; private var dirty = false; private var nextAbs = 0L
    private val specRe = FloatArray(1024); private val specIm = FloatArray(1024)
    private val win = FloatArray(1024) { (0.5 - 0.5 * cos(2 * Math.PI * it / 1023)).toFloat() }
    private val integerD get() = abs(dd - Math.rint(dd)) < 1e-9

    @Synchronized
    override fun reset(rate: Int) {
        this.rate = rate
        dd = rate.toDouble() / LOW_FS
        num = Numerology(if (integerD) rate else LOW_FS)
        capLen = Math.round(rate.toDouble() * BLOCK_MS / 1000).toInt()
        xr = FloatArray(capLen); xi = FloatArray(capLen)
        abs = 0; capN = 0; capStart = 0; nextAbs = 0
        for (c in cells.values) { c.timing = null; c.pending.clear() }
        post(true)
    }
    /** Absolute sample index where the next block starts (or the one being filled started), its length, and whether it is filling. */
    val capture: Triple<Long, Int, Boolean> @Synchronized get() = Triple(if (capN > 0) capStart else nextAbs, capLen, capN > 0)
    /** The widest carrier (RBs) the current rate holds with margin for the radio's filter edges. */
    val maxRb: Int get() { if (!integerD) return 0; val k = 0.9 * num.nfft; return intArrayOf(100, 75, 50, 25, 15, 6).firstOrNull { 12 * it <= k } ?: 0 }

    @Synchronized
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        centerOf?.let { centerHz = it() }
        if (centerHz != lastCenter) {
            lastCenter = centerHz; capN = 0; nextAbs = abs; cfoKnown = false
            for (c in cells.values) { c.timing = null; c.pending.clear() }
        }
        val n = len shr 1
        var k = 0
        while (k < n) {
            if (capN == 0 && abs + (n - k) <= nextAbs) { abs += n - k; break }
            if (capN == 0) { val skip = max(0L, nextAbs - abs).toInt(); k += skip; abs += skip; capStart = abs }
            val take = minOf(n - k, capLen - capN)
            for (i in 0 until take) { xr[capN + i] = (iq[2 * (k + i)].toInt() and 0xff) - 127.5f; xi[capN + i] = (iq[2 * (k + i) + 1].toInt() and 0xff) - 127.5f }
            capN += take; k += take; abs += take
            if (capN == capLen) {
                capN = 0
                val t0 = System.nanoTime()
                try { block(capStart) } catch (e: Exception) { onNote?.invoke("cell: ${e.message}") }
                cpuMs = (System.nanoTime() - t0) / 1_000_000
                // never take more of the stream than this device keeps up with
                if (realtime) nextAbs = max(nextAbs, abs + Math.round(this.rate * cpuMs / 1000.0 * 1.25))
            }
        }
        if (dirty || now() - lastPost > 1000) post()
    }

    // ---- one captured block ---------------------------------------------------------------------------------------
    private fun block(start: Long) {
        val now = now(); val fs = rate
        blocks++; lastBlockMs = now; dirty = true
        spectrum(xr, xi)
        if (!integerD) { nextAbs = abs + fs; return }
        var (yr, yi) = decimate(xr, xi, fs)
        if (yr === xr) { yr = xr.copyOf(); yi = xi.copyOf() }
        val (cpHz, cpStr) = cpCfo(yr, yi, LOW_FS)
        cpStrength = cpStr
        val frac = if (cfoKnown) cfo + (((((cpHz - cfo + 7500) % 15000) + 15000) % 15000) - 7500) else cpHz
        rotate(yr, yi, frac, LOW_FS)
        val hits = pssSearch(yr, yi, 0, if (cfoKnown) doubleArrayOf(0.0) else doubleArrayOf(0.0, -15_000.0, 15_000.0)).filter { it.score > 5.5 }
        pss = hits.take(6).map { PssPeak(it.nid2, Math.round(it.score * 10) / 10.0) }
        lte = hits.isNotEmpty()
        val found = ArrayList<Found>()
        val tried = HashSet<Int>()
        for (h in hits.take(6)) {
            if (h.cfo != 0.0) rotate(yr, yi, h.cfo, LOW_FS)
            val map = halfFrameMap(yr, yi, h.nid2, h.pos)
            if (map.size >= 3) {
                for (tdd in booleanArrayOf(false, true)) {
                    for ((pci, evenSf0) in pciCandidates(yr, yi, h.nid2, map, tdd)) {
                        if (!tried.add(pci * 2 + (if (tdd) 1 else 0))) continue
                        val r = readMib(yr, yi, pci, map, evenSf0, tdd, cells.containsKey("${Math.round(centerHz / 1e5)}:$pci")) ?: continue
                        val cell = cellFor(pci, tdd, now)
                        cell.mib = r.mib; cell.mibMs = now; cell.lastMs = now; cell.mibCount++; cell.snrDb = r.snr; cell.levelDb = r.level; cell.cfoHz = frac + h.cfo; cell.pssScore = h.score
                        found.add(Found(cell, map, evenSf0, tdd, r.h))
                        cfo = frac + h.cfo; cfoKnown = true
                    }
                    if (found.any { it.map === map }) break
                }
            }
            if (h.cfo != 0.0) rotate(yr, yi, -h.cfo, LOW_FS)
        }
        if (found.isEmpty()) { cfoKnown = false; rasterSearch(xr, xi, cpHz, now); nextAbs = abs + Math.round(fs * 0.04); return }
        // the whole carrier in the span: SI-RNTI traffic
        rotate(xr, xi, cfo, fs)
        for (f in found) {
            val m = f.cell.mib!!
            if (m.bandwidth > maxRb) continue
            readSi(f.cell, f.map, f.evenSf0, f.tdd, f.mibH, start, now)
        }
        schedule(found.map { it.cell })
    }

    private fun pciCandidates(yr: FloatArray, yi: FloatArray, nid2: Int, map: List<HalfFrame>, tdd: Boolean): List<Pair<Int, Boolean>> {
        val sc = sssIdentify(yr, yi, nid2, map, 40, sssLag(LOW, tdd)); val out = ArrayList<Pair<Int, Boolean>>()
        for (s in sc.take(3)) out.add(3 * s.nid1 + nid2 to s.evenSf0)
        for (c in cells.values) if (c.hz == centerHz && c.pci % 3 == nid2 && c.tdd == tdd && out.none { it.first == c.pci }) {
            val s0 = sc.firstOrNull { it.nid1 == c.pci / 3 && it.evenSf0 }; val s1 = sc.firstOrNull { it.nid1 == c.pci / 3 && !it.evenSf0 }
            out.add(c.pci to ((s0?.score ?: 0.0) >= (s1?.score ?: 0.0)))
        }
        return out
    }

    /** CRS coherence and residual delay (samples) of ports 0/1, used to place the FFT on this PCI's own timing. */
    private fun crsTiming(g: Grid, sf: Int, pci: Int, nrb: Int, nfft: Int): Triple<Double, Double, Double> {
        var sr = 0.0; var si = 0.0; var den = 0.0; var cnt = 0
        val kk = 12 * nrb
        for (p in 0..1) for (l in intArrayOf(0, 4, 7, 11)) {
            val (rr, ri) = crsSeq(2 * sf + l / 7, l % 7, pci); val s = crsShift(p, l, pci); val mm = 2 * nrb; val off = NRB_MAX - nrb
            var pr = 0.0; var pi = 0.0
            for (m in 0 until mm) {
                val k = 6 * m + s; val yr = g.re[l * kk + k].toDouble(); val yi = g.im[l * kk + k].toDouble(); val cr = rr[m + off]; val ci = ri[m + off]
                val ar = yr * cr + yi * ci; val ai = yi * cr - yr * ci
                if (m > 0) { sr += ar * pr + ai * pi; si += ai * pr - ar * pi }
                den += ar * ar + ai * ai; cnt++; pr = ar; pi = ai
            }
        }
        return Triple(hypot(sr, si) / max(den, 1e-12), -atan2(si, sr) / (2 * Math.PI * 6 / nfft), den / max(cnt, 1))
    }
    private fun demodAligned(xr: FloatArray, xi: FloatArray, startF: Double, num: Numerology, nrb: Int, sf: Int, pci: Int, backoff: Int): Pair<Grid, Double>? {
        var g = ofdmDemod(xr, xi, startF, num, nrb, backoff) ?: return null
        var t = crsTiming(g, sf, pci, nrb, num.nfft)
        if (abs(t.second) > 0.5) {
            val g2 = ofdmDemod(xr, xi, startF + Math.round(t.second), num, nrb, backoff)
            if (g2 != null) { val t2 = crsTiming(g2, sf, pci, nrb, num.nfft); if (t2.first >= t.first * 0.98) { g = g2; t = t2 } }
        }
        return g to t.third
    }

    /**
     * MIB from the sf0 half-frames of the map. A cell not heard before needs two frames that agree (bandwidth, ports
     * and SFN one frame apart per frame): a single 16-bit CRC pass among the many PCI hypotheses is not proof.
     */
    private fun readMib(yr: FloatArray, yi: FloatArray, pci: Int, map: List<HalfFrame>, evenSf0: Boolean, tdd: Boolean, known: Boolean): MibHit? {
        val off = duplexPss(LOW, tdd); val hits = ArrayList<MibHit>()
        var tries = 0
        for (hf in map) {
            if ((hf.h % 2 == 0) != evenSf0) continue
            if (++tries > 4) break
            val d = demodAligned(yr, yi, hf.pos - off, LOW, 6, 0, pci, 1) ?: continue
            val r = decodeMib(d.first, pci, 6)
            if (r == null) { if (!known && tries >= 2 && hits.isEmpty()) break; continue }
            val hit = MibHit(r.first, 10 * log10(max(r.second, 1e-6)), 10 * log10(max(d.second, 1e-12) / (128.0 * 128)), hf.h)
            if (known) return hit
            val prev = hits.firstOrNull { x -> x.mib.bandwidth == r.first.bandwidth && x.mib.ports == r.first.ports && (x.mib.sfn + (hf.h - x.h) / 2) % 1024 == r.first.sfn }
            if (prev != null) return prev
            hits.add(hit)
        }
        return null
    }

    /**
     * No cell on the tuned center: the carrier may sit a few 100 kHz raster steps away (a center guessed from the
     * power profile). Each raster offset up to 300 kHz is mixed to DC and searched on two half-frames; a PSS that
     * leads to two agreeing MIB frames registers the cell at its own center, which is then offered as offCenter so
     * the scan retunes there.
     */
    private fun rasterSearch(xr: FloatArray, xi: FloatArray, cpHz: Double, now: Long) {
        val fs = rate; val d0 = Math.round(dd).toInt(); val taps = 16 * d0 + 1; val shortN = (2 * 9600 + 128) * d0 + taps
        if (xr.size < shortN) return
        for (d in RASTER) {
            val shift = cpHz + Math.round((d - cpHz) / 15_000) * 15_000.0
            val sr = xr.copyOfRange(0, shortN); val si = xi.copyOfRange(0, shortN)
            rotate(sr, si, shift, fs)
            val (ar, ai) = decimate(sr, si, fs)
            val hit = pssSearch(ar, ai, 0, doubleArrayOf(0.0)).firstOrNull { it.score > 6 } ?: continue
            val fr = xr.copyOf(); val fi = xi.copyOf()
            rotate(fr, fi, shift, fs)
            val (yr, yi) = decimate(fr, fi, fs); val map = halfFrameMap(yr, yi, hit.nid2, hit.pos)
            if (map.size < 3) continue
            val hz = Math.round((centerHz + shift) / 100_000) * 100_000
            for (tdd in booleanArrayOf(false, true)) for ((pci, evenSf0) in pciCandidates(yr, yi, hit.nid2, map, tdd)) {
                val r = readMib(yr, yi, pci, map, evenSf0, tdd, false) ?: continue
                val cell = cellFor(pci, tdd, now, hz)
                cell.mib = r.mib; cell.mibMs = now; cell.lastMs = now; cell.mibCount++; cell.snrDb = r.snr; cell.levelDb = r.level; cell.cfoHz = centerHz + shift - hz; cell.pssScore = hit.score
                offCenter = OffCenter(hz, pci, now)
                addLog(now, hz, pci, "CELL", "found ${Math.round((hz - centerHz) / 1e3)} kHz from the tuned center", "")
                return
            }
        }
    }

    private fun cellFor(pci: Int, tdd: Boolean, now: Long, hz: Long = centerHz): Cell {
        val key = "${Math.round(hz / 1e5)}:$pci"
        return cells.getOrPut(key) {
            val b = bandOf(hz)
            val c = Cell(key, hz, pci, b?.bands?.get(0), null, tdd, now, now)
            if (c.band != null) c.earfcn = dlEarfcnForMhz(c.band!!, hz / 1e6)
            addLog(now, hz, pci, "CELL", "new cell PCI $pci${if (tdd) " (TDD)" else ""}", "")
            c
        }
    }

    /** SIB1 occasions and the wanted SI windows inside this block, for one cell whose MIB just decoded. */
    private fun readSi(cell: Cell, map: List<HalfFrame>, evenSf0: Boolean, tdd: Boolean, mibH: Int, blockAbs: Long, now: Long) {
        val mib = cell.mib!!; val nrb = mib.bandwidth; val off = duplexPss(num, tdd); val delay = decimDelay(rate)
        if (cell.ctl.isEmpty() || cell.ctl[0].nrb != nrb || cell.ctl[0].nports != mib.ports)
            cell.ctl = (if (tdd) listOf(0, 1, 2) else listOf(1)).map { ControlDecoder(cell.pci, nrb, mib.ports, mib.phichResource, tdd, it) }
        // SFN of each mapped half-frame from the frame whose MIB was read
        val sf0 = map.filter { (it.h % 2 == 0) == evenSf0 }
        if (sf0.isEmpty()) return
        val ref = sf0.firstOrNull { it.h == mibH } ?: sf0[0]; val refSfn = mib.sfn
        cell.timing = Timing(blockAbs + ref.pos * dd + delay - off, refSfn)
        val sched = cell.summary?.schedule ?: emptyList()
        for (hf in map) {
            val isSf0 = (hf.h % 2 == 0) == evenSf0
            val frames = Math.floorDiv(hf.h - ref.h - (if (isSf0) 0 else 1), 2); val sfn = ((refSfn + frames) % 1024 + 1024) % 1024
            val base = hf.pos * dd + delay - off
            for (j in 0 until 5) {
                val sf = (if (isSf0) 0 else 5) + j; val sib1 = sf == 5 && sfn % 2 == 0
                var si = 0
                if (!sib1) for (t in sched) {
                    val st = t.windowStartSfnMod * 10 + t.windowStartSubframe; val pos = (sfn % t.periodicity) * 10 + sf
                    if (pos >= st && pos < st + t.windowMs && wanted(cell, t.si, now)) { si = t.si; break }
                }
                if (!sib1 && si == 0) continue
                if (sib1 && cell.sib1Ms > 0 && now - cell.sib1Ms < 2000 && sched.isNotEmpty()) continue
                if (tdd && !sib1) continue
                val startF = base + j * num.subframe
                val d = demodAligned(xr, xi, startF, num, nrb, sf, cell.pci, max(1, Math.round(num.nfft / 128.0).toInt())) ?: continue
                subframe(cell, d.first, sf, sfn, sib1, si, hf.h * 5 + j, now, tdd)
            }
        }
    }

    private fun wanted(cell: Cell, si: Int, now: Long): Boolean {
        val got = cell.siGot[si]; val sibs = cell.summary?.schedule?.firstOrNull { it.si == si }?.sibs ?: emptyList()
        if (sibs.any { it.startsWith("sibType10") || it.startsWith("sibType11") || it.startsWith("sibType12") }) return true
        return got == null || now - got.ms > 30_000
    }

    private fun subframe(cell: Cell, g: Grid, sf: Int, sfn: Int, sib1: Boolean, si: Int, gIdx: Int, now: Long, tdd: Boolean) {
        val ctl0 = cell.ctl[0]; val nrb = ctl0.nrb; val h = chanEst(g, sf, cell.pci, nrb, ctl0.nports)
        val cfi = ctl0.cfi(g, h, sf).first; val nl = if (nrb > 10) cfi else cfi + 1
        var hits: List<DciHit> = emptyList(); var ctl = ctl0
        for (c in cell.ctl) { hits = c.search(g, h, sf, nl); ctl = c; if (hits.isNotEmpty()) break }
        for (hit in hits) {
            cell.dciCount++; dci++
            val a = tbsSi(hit.dci) ?: continue
            val (p0, p1) = allocation(hit.dci, nrb)
            if (p0.isEmpty() || (p0 + p1).max() >= nrb) continue
            val llr = pdschLlr(g, h, cell.pci, nrb, ctl.nports, sf, cfi, p0, p1, 0xffff, tdd)
            // DCI 1C carries no RV: SIB1 follows 36.321 5.3.1 (k = SFN/2 mod 4), other SI may be any of the four
            val d = hit.dci
            val rvs = if (d is Dci1A) listOf(d.rv) else if (sib1) listOf(Math.ceil(1.5 * ((sfn shr 1) % 4)).toInt() % 4) else listOf(0, 2, 3, 1)
            var bits: ByteArray? = null
            for (rv in rvs) { val tb = TbDecoder(a); tb.add(llr, rv); bits = tb.decode(); if (bits != null) break }
            val kind = if (sib1) "SIB1" else "SI"; val pkey = "$kind:$a"
            if (bits == null && rvs.size == 1) {
                var p = cell.pending[pkey]
                val epoch = if (sib1) sfn shr 3 else gIdx
                if (p == null || (if (sib1) p.epoch != epoch else gIdx - p.g > 40)) { p = PendingTb(TbDecoder(a), gIdx, epoch); cell.pending[pkey] = p }
                p.tb.add(llr, rvs[0])
                if (p.tb.n >= 2) { bits = p.tb.decode(); if (bits != null) cell.pending.remove(pkey) }
            } else if (bits != null) cell.pending.remove(pkey)
            if (bits == null) { cell.tbFail++; continue }
            cell.tbOk++; tbOkAll++
            message(cell, bitsToBytes(bits), sib1, si, now)
        }
    }

    /** One BCCH-DL-SCH transport block that passed CRC-24A. Also the entry point for recorded blocks. */
    private fun message(cell: Cell, bytes: ByteArray, sib1Hint: Boolean, si: Int, now: Long) {
        val hex = hexOf(bytes); val r = decodeBcchDlSch(bytes)
        cell.lastMs = now; dirty = true
        if (r.value == null) { addLog(now, cell.hz, cell.pci, "SI", "undecodable ${if (sib1Hint) "SIB1" else "SI"} (${r.error ?: "error"})", hex); return }
        val parts = messageParts(r.value)
        val s1 = parts.sib1
        if (s1 != null) {
            val changed = hex != cell.sib1Hex
            cell.sib1 = s1; cell.sib1Ms = now; cell.sib1Count++
            if (changed) {
                cell.sib1Hex = hex
                try {
                    val sm = sib1Summary(s1)
                    cell.summary = sm
                    if (sm.band > 0) { cell.band = sm.band; cell.earfcn = dlEarfcnForMhz(sm.band, cell.hz / 1e6) }
                } catch (_: Exception) { }
                val s = cell.summary
                addLog(now, cell.hz, cell.pci, "SIB1", if (s != null) "PLMN ${s.plmns.joinToString(", ") { it.id + (if (it.name.isNotEmpty()) " ${it.name}" else "") }} · TAC ${s.tac} · eNB ${s.enbId}/${s.cellId} · band ${s.band} · ${s.schedule.size} SI" else "SIB1", hex)
            }
            return
        }
        var siIdx = si
        for ((name, value) in parts.sibs) {
            if (siIdx == 0) cell.summary?.let { sm -> siIdx = sm.schedule.firstOrNull { t -> t.sibs.any { x -> x.replace("sibType", "sib") == name || name.startsWith(x.replace("sibType", "sib")) } }?.si ?: 0 }
            val old = cell.sibs[name]; val fresh = old == null || old.hex != hex
            cell.sibs[name] = SibRec(name, siIdx, now, (old?.count ?: 0) + 1, hex, value)
            if (fresh) addLog(now, cell.hz, cell.pci, name.uppercase().replace(Regex("-.*"), ""), sibLine(name, value), hex)
            if (name == "sib10" || name == "sib11" || name.startsWith("sib12")) {
                val m = warnings.add(if (name.startsWith("sib12")) "sib12-v920" else name, value, cell.key, now)
                if (m != null) {
                    if (m.complete) addLog(now, cell.hz, cell.pci, "ALERT", "${m.cls} ${m.id} serial 0x${Integer.toHexString(m.serial).uppercase()}${if (m.language != null) " ${m.language}" else ""}: ${m.text.ifEmpty { m.binaryHex }}", "")
                    else version++
                    onAlert?.invoke(m)
                }
            }
        }
        if (siIdx != 0) { val g = cell.siGot[siIdx]; cell.siGot[siIdx] = SiGot(now, (g?.count ?: 0) + 1) }
    }

    /** Next capture: just before the earliest wanted SI window of the cells heard (or right away). */
    private fun schedule(cs: List<Cell>) {
        val fs = rate.toDouble(); val frame = fs / 100; val now = now(); val lead = Math.round(fs * 0.012); val from = abs + (if (realtime) Math.round(fs * cpuMs / 1000 * 1.25) else 0)
        var best = Double.POSITIVE_INFINITY
        for (c in cs) {
            val tm = c.timing ?: continue; val sm = c.summary ?: continue
            if (c.mib != null && c.mib!!.bandwidth > maxRb) continue
            for (t in sm.schedule) {
                if (!wanted(c, t.si, now)) continue
                val cur = floor((abs - tm.abs) / frame).toInt()
                for (f in cur until cur + 1024) {
                    val sfn = (((tm.sfn + f) % 1024) + 1024) % 1024
                    if (sfn % t.periodicity != t.windowStartSfnMod) continue
                    val at = tm.abs + f * frame + t.windowStartSubframe * frame / 10 - lead
                    if (at >= from && at < best) best = at
                    if (at >= from) break
                }
            }
        }
        nextAbs = if (best.isFinite() && best - abs < fs * 6) Math.round(best) else from
    }

    private fun spectrum(xr: FloatArray, xi: FloatArray) {
        val n = 1024; val acc = DoubleArray(n); val segs = minOf(24, xr.size / n)
        for (s in 0 until segs) {
            val o = floor(s * (xr.size - n).toDouble() / max(1, segs - 1)).toInt()
            for (i in 0 until n) { specRe[i] = xr[o + i] * win[i]; specIm[i] = xi[o + i] * win[i] }
            Dsp.fft(specRe, specIm)
            for (i in 0 until n) acc[i] += (specRe[i] * specRe[i] + specIm[i] * specIm[i]).toDouble()
        }
        val fs = rate.toDouble(); val binHz = fs / n; val step = 50_000; val usable = 0.85 * fs; val pts = floor(usable / step).toInt()
        val db = FloatArray(pts)
        for (p in 0 until pts) {
            val f = -usable / 2 + p * step; val b0 = Math.round(f / binHz).toInt(); val b1 = max(b0 + 1, Math.round((f + step) / binHz).toInt())
            var s = 0.0
            for (b in b0 until b1) s += acc[((b % n) + n) % n]
            db[p] = (Math.round(10 * log10(s / (b1 - b0) / max(1, segs) / (n.toDouble() * n) + 1e-12) * 10) / 10.0).toFloat()
        }
        val sorted = db.sorted()
        floorDb = sorted.getOrNull((sorted.size * 0.15).toInt())?.toDouble() ?: 0.0
        profile = CellProfile(centerHz - usable / 2, step, db)
    }

    private fun addLog(ms: Long, hz: Long, pci: Int, kind: String, text: String, hex: String) {
        log.add(LogRow(ms, hz, pci, kind, text, hex))
        version++
        if (log.size > 2000) log.subList(0, log.size - 2000).clear()
        packets?.add("${CLOCK.get().format(java.util.Date(ms))} ${"%.1f".format(java.util.Locale.US, hz / 1e6)} PCI $pci $kind $text")
        dirty = true
    }

    // ---- outputs --------------------------------------------------------------------------------------------------
    private fun row(c: Cell): CellRow {
        val sibs = c.sibs.values.associate { it.name to it.value }
        val nb = runCatching { neighbors(sibs) }.getOrNull()
        val s2 = runCatching { sibs["sib2"]?.let { sib2Summary(it) } }.getOrNull()
        val s3 = runCatching { sibs["sib3"]?.let { sib3Summary(it) } }.getOrNull()
        val time = runCatching { sibs["sib8"]?.let { sib8Time(it) }?.let { CellTime(it.gpsIso, it.utcIso) } }.getOrNull()
        val sched = c.summary?.schedule ?: emptyList()
        val e = c.earfcn?.let { earfcnDl(it) }
        return CellRow(
            c.key, c.hz, c.pci, c.earfcn, c.band ?: e?.band, c.tdd, c.firstMs, c.lastMs, c.mibMs, c.sib1Ms,
            c.mib, c.mib?.bandwidth ?: 0, c.mib?.ports ?: 0, c.mib?.sfn ?: -1, round1(c.snrDb), round1(c.levelDb), Math.round(c.cfoHz).toInt(), round1(c.pssScore),
            c.mibCount, c.sib1Count, c.dciCount, c.tbOk, c.tbFail,
            c.summary, s2, s3, nb, time,
            c.sibs.values.map { SibSeen(it.name, it.si, it.ms, it.count) },
            sched.map { t -> SiRow(t.si, t.periodicity, t.sibs, c.siGot[t.si]?.ms ?: 0, c.siGot[t.si]?.count ?: 0) },
            c.mib != null && c.mib!!.bandwidth <= maxRb && c.hz == centerHz,
            c.summary != null && sched.all { c.siGot.containsKey(it.si) },
            warnings.messages().count { c.key in it.cells },
        )
    }
    @Synchronized
    fun snapshot(): CellSnap = CellSnap(
        centerHz, rate, maxRb >= 25, maxRb, lte, Math.round(cpStrength * 1000) / 1000.0, blocks, !cfoKnown, lastBlockMs,
        if (nextAbs > abs && rate > 0) Math.round((nextAbs - abs).toDouble() / rate * 1000) else 0, cpuMs,
        profile, floorDb,
        cells.values.sortedByDescending { it.lastMs }.map { row(it) }, warnings.messages(), log.takeLast(300).toList(), dci, tbOkAll, pss, offCenter,
    )
    /** Every decoded field of one cell, for its detail view. */
    @Synchronized
    fun detail(key: String): CellDetail? { val c = cells[key] ?: return null; return CellDetail(key, c.mib, c.sib1, c.sib1Hex, c.sibs.values.toList()) }
    private fun post(force: Boolean = false) {
        val t = now()
        if (!force && t - lastPost < 500) return
        lastPost = t; dirty = false
        _snap.value = snapshot()
    }
    @Synchronized
    fun flush() = post(true)

    /** A recorded transport block heard from a cell (tests, fixtures, the e2e hook). */
    @Synchronized
    fun feedBlock(hz: Long, pci: Int, hex: String, sib1: Boolean, ms: Long = now()) {
        val c = cellFor(pci, false, ms, hz)
        c.lastMs = max(c.lastMs, ms)
        message(c, hexToBytes(hex), sib1, 0, ms)
    }
    @Synchronized
    fun feedMib(hz: Long, pci: Int, mib: Mib, ms: Long = now()) {
        val c = cellFor(pci, false, ms, hz)
        c.mib = mib; c.mibMs = ms; c.mibCount++; c.lastMs = max(c.lastMs, ms)
    }

    /** What was heard, as JSON: the cells with their transport blocks, the alerts and the recent log. */
    @Synchronized
    fun exportState(): String {
        val cs = JSONArray()
        for (c in cells.values) cs.put(JSONObject().put("key", c.key).put("hz", c.hz).put("pci", c.pci).put("band", c.band ?: JSONObject.NULL).put("earfcn", c.earfcn ?: JSONObject.NULL)
            .put("tdd", c.tdd).put("firstMs", c.firstMs).put("lastMs", c.lastMs).put("mibMs", c.mibMs).put("sib1Ms", c.sib1Ms).put("mib", c.mib?.let { mibJson(it) } ?: JSONObject.NULL)
            .put("snrDb", c.snrDb).put("levelDb", c.levelDb).put("cfoHz", c.cfoHz).put("pssScore", c.pssScore).put("mibCount", c.mibCount).put("sib1Count", c.sib1Count)
            .put("dciCount", c.dciCount).put("tbOk", c.tbOk).put("tbFail", c.tbFail).put("sib1Hex", c.sib1Hex)
            .put("sibs", JSONArray(c.sibs.values.map { JSONObject().put("name", it.name).put("si", it.si).put("ms", it.ms).put("count", it.count).put("hex", it.hex) }))
            .put("siGot", JSONArray(c.siGot.entries.map { JSONArray().put(it.key).put(JSONObject().put("ms", it.value.ms).put("count", it.value.count)) })))
        val logs = JSONArray(log.takeLast(500).map { JSONObject().put("ms", it.ms).put("hz", it.hz).put("pci", it.pci).put("kind", it.kind).put("text", it.text).put("hex", it.hex) })
        return JSONObject().put("v", 1).put("cells", cs).put("alerts", JSONArray(warnings.messages().map { warningJson(it) })).put("log", logs).toString()
    }
    /** Brings back what an earlier session heard; decoded values are rebuilt from the kept transport blocks. */
    @Synchronized
    fun restore(text: String?) {
        if (text.isNullOrEmpty()) return
        val s = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (s.optInt("v") != 1) return
        val cs = s.optJSONArray("cells") ?: JSONArray()
        for (i in 0 until cs.length()) runCatching {
            val o = cs.getJSONObject(i); val key = o.getString("key")
            if (cells.containsKey(key)) return@runCatching
            val c = Cell(key, o.getLong("hz"), o.getInt("pci"), o.optNullInt("band"), o.optNullInt("earfcn"), o.optBoolean("tdd"), o.optLong("firstMs"), o.optLong("lastMs"))
            c.mibMs = o.optLong("mibMs"); c.sib1Ms = o.optLong("sib1Ms"); c.mib = o.optJSONObject("mib")?.let { mibOf(it) }
            c.snrDb = o.optDouble("snrDb", 0.0); c.levelDb = o.optDouble("levelDb", 0.0); c.cfoHz = o.optDouble("cfoHz", 0.0); c.pssScore = o.optDouble("pssScore", 0.0)
            c.mibCount = o.optInt("mibCount"); c.sib1Count = o.optInt("sib1Count"); c.dciCount = o.optInt("dciCount"); c.tbOk = o.optInt("tbOk"); c.tbFail = o.optInt("tbFail")
            val sg = o.optJSONArray("siGot") ?: JSONArray()
            for (j in 0 until sg.length()) { val e = sg.getJSONArray(j); val v = e.getJSONObject(1); c.siGot[e.getInt(0)] = SiGot(v.optLong("ms"), v.optInt("count")) }
            val hex1 = o.optString("sib1Hex")
            if (hex1.isNotEmpty()) {
                val p = messageParts(decodeBcchDlSch(hexToBytes(hex1)).value)
                p.sib1?.let { s1 -> c.sib1 = s1; c.sib1Hex = hex1; c.summary = runCatching { sib1Summary(s1) }.getOrNull() }
            }
            val sl = o.optJSONArray("sibs") ?: JSONArray()
            for (j in 0 until sl.length()) {
                val r = sl.getJSONObject(j); val name = r.getString("name"); val hex = r.getString("hex")
                val v = messageParts(decodeBcchDlSch(hexToBytes(hex)).value).sibs.firstOrNull { it.first == name } ?: continue
                c.sibs[name] = SibRec(name, r.optInt("si"), r.optLong("ms"), r.optInt("count"), hex, v.second)
            }
            cells[key] = c
        }
        val al = s.optJSONArray("alerts") ?: JSONArray()
        warnings.restore((0 until al.length()).mapNotNull { runCatching { warningOf(al.getJSONObject(it)) }.getOrNull() })
        val lg = s.optJSONArray("log") ?: JSONArray()
        if (log.isEmpty()) for (i in 0 until lg.length()) runCatching { val o = lg.getJSONObject(i); log.add(LogRow(o.getLong("ms"), o.getLong("hz"), o.getInt("pci"), o.getString("kind"), o.getString("text"), o.optString("hex"))) }
        post(true)
    }
    /** The log as CSV and every decoded field as JSON. */
    @Synchronized
    fun exportAll(): Pair<String, String> {
        fun q(v: String) = "\"${v.replace("\"", "\"\"")}\""
        val csv = StringBuilder("utc,mhz,pci,kind,text,hex\n")
        for (r in log) csv.append(listOf(isoUtc(r.ms), "%.1f".format(java.util.Locale.US, r.hz / 1e6), "${r.pci}", r.kind, q(r.text), r.hex).joinToString(",")).append('\n')
        val s = snapshot()
        val cs = JSONArray()
        for (c in s.cells) {
            val d = detail(c.key)
            cs.put(JSONObject().put("key", c.key).put("hz", c.hz).put("pci", c.pci).put("earfcn", c.earfcn ?: JSONObject.NULL).put("band", c.band ?: JSONObject.NULL).put("tdd", c.tdd)
                .put("firstMs", c.firstMs).put("lastMs", c.lastMs).put("nrb", c.nrb).put("ports", c.ports).put("snrDb", c.snrDb).put("levelDb", c.levelDb).put("cfoHz", c.cfoHz)
                .put("mibCount", c.mibCount).put("sib1Count", c.sib1Count).put("dciCount", c.dciCount).put("tbOk", c.tbOk).put("tbFail", c.tbFail)
                .put("summary", c.summary?.let { sm -> JSONObject().put("plmns", JSONArray(sm.plmns.map { JSONObject().put("id", it.id).put("name", it.name) })).put("tac", sm.tac)
                    .put("cellIdentity", sm.cellIdentity).put("enbId", sm.enbId).put("cellId", sm.cellId).put("band", sm.band).put("bands", JSONArray(sm.bands)).put("barred", sm.barred)
                    .put("siWindowMs", sm.siWindowMs).put("valueTag", sm.valueTag).put("schedule", JSONArray(sm.schedule.map { JSONObject().put("si", it.si).put("periodicity", it.periodicity).put("sibs", JSONArray(it.sibs)) })) } ?: JSONObject.NULL)
                .put("decoded", if (d == null) JSONObject.NULL else JSONObject().put("mib", d.mib?.let { mibJson(it) } ?: JSONObject.NULL).put("sib1", jsonOf(d.sib1)).put("sib1Hex", d.sib1Hex)
                    .put("sibs", JSONArray(d.sibs.map { JSONObject().put("name", it.name).put("si", it.si).put("ms", it.ms).put("count", it.count).put("hex", it.hex).put("value", jsonOf(it.value)) }))))
        }
        val json = JSONObject().put("exported", isoUtc(now())).put("cells", cs).put("alerts", JSONArray(s.alerts.map { warningJson(it) })).toString(1)
        return csv.toString() to json
    }
    /** Forgets the cells and the log; the alerts stay until clearAlerts(). */
    @Synchronized
    fun clear() { cells.clear(); log.clear(); dci = 0; tbOkAll = 0; version++; packets?.clear(); post(true) }
    @Synchronized
    fun clearAlerts() { warnings.clear(); version++; post(true) }

    companion object {
        private val CLOCK = ThreadLocal.withInitial { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US) }
        /** A decoded tree as org.json values. */
        fun jsonOf(v: Any?): Any = when (v) {
            null -> JSONObject.NULL
            is Map<*, *> -> JSONObject().also { o -> for ((k, x) in v) o.put(k.toString(), jsonOf(x)) }
            is List<*> -> JSONArray().also { a -> for (x in v) a.put(jsonOf(x)) }
            else -> v
        }
        fun mibJson(m: Mib): JSONObject = JSONObject().put("bandwidth", m.bandwidth).put("phichDuration", m.phichDuration).put("phichResource", m.phichResource).put("sfn", m.sfn)
            .put("sib1BR", m.sib1BR).put("unchangedBR", m.unchangedBR).put("ports", m.ports).put("bits", m.bits)
        fun mibOf(o: JSONObject): Mib = Mib(o.getInt("bandwidth"), o.optString("phichDuration"), o.optString("phichResource"), o.optInt("sfn"), o.optInt("sib1BR"), o.optBoolean("unchangedBR"), o.optInt("ports"), o.optString("bits"))
        fun warningJson(m: WarningMessage): JSONObject = JSONObject().put("key", m.key).put("kind", m.kind).put("source", m.source).put("id", m.id).put("serial", m.serial).put("scope", m.scope)
            .put("messageCode", m.messageCode).put("updateNumber", m.updateNumber).put("category", m.category).put("cls", m.cls).put("rank", m.rank).put("additionalLanguage", m.additionalLanguage)
            .put("warningType", m.warningType?.let { JSONObject().put("type", it.type).put("userAlert", it.userAlert).put("popup", it.popup) } ?: JSONObject.NULL)
            .put("complete", m.complete).put("segments", JSONArray(m.segments)).put("lastSegment", m.lastSegment).put("dcs", m.dcs).put("alphabet", m.alphabet).put("language", m.language ?: JSONObject.NULL)
            .put("pages", m.pages).put("text", m.text).put("binaryHex", m.binaryHex).put("areaHex", m.areaHex).put("cells", JSONArray(m.cells)).put("firstMs", m.firstMs).put("lastMs", m.lastMs).put("receptions", m.receptions)
        fun warningOf(o: JSONObject): WarningMessage {
            val seg = o.optJSONArray("segments") ?: JSONArray(); val cs = o.optJSONArray("cells") ?: JSONArray()
            return WarningMessage(o.getString("key"), o.optString("kind"), o.optString("source"), o.getInt("id"), o.getInt("serial"), o.optString("scope"), o.optInt("messageCode"), o.optInt("updateNumber"),
                o.optString("category"), o.optString("cls"), o.optInt("rank"), o.optBoolean("additionalLanguage"),
                o.optJSONObject("warningType")?.let { WarningType(it.optString("type"), it.optBoolean("userAlert"), it.optBoolean("popup")) },
                o.optBoolean("complete"), (0 until seg.length()).map { seg.getInt(it) }, o.optInt("lastSegment", -1), o.optInt("dcs", -1), o.optString("alphabet"),
                if (o.isNull("language")) null else o.optString("language"), o.optInt("pages"), o.optString("text"), o.optString("binaryHex"), o.optString("areaHex"),
                (0 until cs.length()).map { cs.getString(it) }.toMutableList(), o.optLong("firstMs"), o.optLong("lastMs"), o.optInt("receptions"))
        }
        private fun JSONObject.optNullInt(k: String): Int? = if (isNull(k)) null else optInt(k)
    }
}

private fun sibLine(name: String, v: Obj): String {
    try {
        if (name == "sib4") return "${(v["intraFreqNeighCellList"] as? List<*>)?.size ?: 0} intra-frequency neighbors"
        if (name == "sib5") return "${(v["interFreqCarrierFreqList"] as? List<*>)?.size ?: 0} inter-frequency carriers"
        if (name.startsWith("sib24")) return "${(v["carrierFreqListNR-r15"] as? List<*>)?.size ?: 0} NR carriers"
        if (name.startsWith("sib12")) return "CMAS segment ${v["warningMessageSegmentNumber-r9"]} of message ${bitsNum(v["messageIdentifier-r9"])}"
        if (name == "sib10") return "ETWS primary ${bitsNum(v["messageIdentifier"])}"
        if (name == "sib11") return "ETWS segment ${v["warningMessageSegmentNumber"]}"
    } catch (_: Exception) { }
    return name
}
