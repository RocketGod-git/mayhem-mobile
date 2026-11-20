package com.rocketgod.mayhem.core.hd

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.audio.HdDetector
import com.rocketgod.mayhem.core.audio.HdReport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

class HdCandidate(val hz: Long, val scoreDb: Double, val levelDb: Double)

/** Half a second of the HD Radio processor: the tuned station's data, the receiver's state and the hybrid channels in the span. */
class HdSnap(
    val hz: Long, val centerHz: Long, val rate: Int, val rx: RxStatus, val station: StationSnap, val cands: List<HdCandidate>,
    val det: HdReport?, val dropped: Int, val load: Double, val queued: Int,
)

/** A finished object, with the station it came from. */
class HdObjMsg(val hz: Long, val obj: HdObject)

/**
 * The HD Radio app's processor: the existing sideband detector for a fast presence and level reading, the Layer 1
 * receiver ([HdRx]), the FEC on a thread of its own so audio keeps flowing, and the station's data ([HdStation]).
 * Also a finder over the whole span: FM channels whose spectrum shows both digital sidebands.
 * The WFM audio of the same station plays from the engine's own demodulator alongside.
 */
class HdProcessor(private val log: PacketLog?) : IqProcessor {
    /** The span center and the station's offset from it, read each buffer. */
    @Volatile var centerOf: () -> Long = { 0L }
    /** AUTO's wide look is on: the span is not one to decode (nothing runs until it is back at the HD rate). */
    @Volatile var paused = false
    @Volatile var offsetOf: () -> Int = { 0 }
    /** Run the FEC on the caller's thread (tests). */
    @Volatile var inline = false
    @Volatile var onObject: (HdObjMsg) -> Unit = {}
    /** Each snapshot as it is posted (on the DSP thread). */
    @Volatile var onSnap: (HdSnap) -> Unit = {}
    /** The wall clock (tests step it). */
    @Volatile var clock: () -> Long = { System.currentTimeMillis() }

    private val _snap = MutableStateFlow<HdSnap?>(null)
    val snap: StateFlow<HdSnap?> = _snap.asStateFlow()

    private var rx = HdRx()
    private val stationLock = Any()
    private var station = HdStation()
    @Volatile private var gen = 0
    private val det: HdDetector
    @Volatile private var detReport: HdReport? = null
    private var tunedHz = 0L; private var rate = 0
    private val queue = ArrayBlockingQueue<Pair<Int, FrameSoft>>(2)
    @Volatile private var busy = false
    private var worker: Thread? = null
    private var lastSnap = 0L
    @Volatile private var framesDropped = 0
    private var cpuNs = 0L; private var cpuWin = 0L; private var cpuLoad = 0.0
    // finder
    private val fre = FloatArray(FIND_N); private val fim = FloatArray(FIND_N); private val pow = DoubleArray(FIND_N)
    private val win = FloatArray(FIND_N) { (0.5 - 0.5 * cos(2 * Math.PI * it / (FIND_N - 1))).toFloat() }
    private var pows = 0; private var findSince = 0L; private var findCenter = 0L; private var cands: List<HdCandidate> = emptyList()
    var centerHz = 0L; private set

    init {
        det = HdDetector { detReport = it }
        wire()
    }

    private fun wire() {
        rx.onFrame = { f ->
            if (inline) decodeFrame(gen, f)
            else { val item = gen to f; if (!queue.offer(item)) { queue.poll(); framesDropped++; queue.offer(item) }; ensureWorker() }
        }
        val g = gen
        station.clock = { clock() }
        station.onEvent = { line -> log?.add("${clockText(clock())} ${"%.1f".format(java.util.Locale.US, tunedHz / 1e6)} $line") }
        station.onObject = { o -> if (g == gen) onObject(HdObjMsg(tunedHz, o)) }
    }

    private fun ensureWorker() {
        if (worker?.isAlive == true) return
        worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                val item = try { queue.poll(5, TimeUnit.SECONDS) } catch (_: InterruptedException) { break } ?: continue
                busy = true
                try { decodeFrame(item.first, item.second) } catch (e: Throwable) { com.rocketgod.mayhem.Diag.log("HD frame decode failed: ${e.message}") }
                busy = false
            }
        }, "hd-fec").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1; start() }
    }

    @Synchronized override fun reset(rate: Int) {
        this.rate = rate; rx.reset(); det.reset(); detReport = null; queue.clear()
        pow.fill(0.0); pows = 0; cands = emptyList()
    }

    /** A new station: everything starts over. */
    @Synchronized fun clear() {
        gen++
        queue.clear()
        rx = HdRx()
        synchronized(stationLock) { station = HdStation() }
        wire(); det.reset(); detReport = null; framesDropped = 0
    }

    @Synchronized override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (paused) return
        val t0 = System.nanoTime()
        val n = len / 2
        centerHz = centerOf()
        val offsetHz = offsetOf()
        val hz = centerHz + offsetHz
        if (hz != tunedHz) { if (tunedHz != 0L) clear(); tunedHz = hz }
        if (centerHz != findCenter) { findCenter = centerHz; pow.fill(0.0); pows = 0; cands = emptyList() }
        if (abs(offsetHz) < rate / 2 - 240_000) {
            rx.push(iq, n, rate, offsetHz.toDouble())
            det.push(iq, n, rate, offsetHz.toDouble())
        }
        find(iq, n, rate)
        val now = clock()
        cpuNs += System.nanoTime() - t0
        if (now - lastSnap >= SNAP_MS) {
            val span = now - (if (cpuWin != 0L) cpuWin else now - SNAP_MS); cpuLoad = if (span > 0) cpuNs / 1e6 / span else 0.0; cpuNs = 0; cpuWin = now
            lastSnap = now; publish()
        }
    }

    private fun decodeFrame(g: Int, f: FrameSoft) {
        val idx = HdFec.p1Index; val soft = FloatArray(HdFec.N_P1)
        for (i in 0 until HdFec.N_P1) soft[i] = f.pm[idx[i]]
        val llr = HdFec.depuncture25(soft, HdFec.P1_BITS)
        val bits = HdFec.viterbiTb(llr, HdFec.P1_BITS)
        val ber = HdFec.reencodeBer(bits, soft)
        val sis = ArrayList<ByteArray>(16)
        for (bc in 0 until 16) {
            val pi = HdFec.pidsIndex(bc); val s = FloatArray(HdFec.N_PIDS)
            for (i in 0 until HdFec.N_PIDS) s[i] = f.pm[pi[i]]
            sis.add(HdL2.l1ToL2(HdFec.descramble(HdFec.viterbiTb(HdFec.depuncture25(s, HdFec.PIDS_BITS), HdFec.PIDS_BITS, 40))))
        }
        val pdu = HdL2.pduFromFrame(HdFec.descramble(bits))
        synchronized(stationLock) { if (g == gen) station.addFrame(pdu, sis, ber, f.snrLoDb, f.snrHiDb) }
    }

    /** Power spectrum of the whole span; every second, the FM channels that show both digital sidebands. */
    private fun find(iq: ByteArray, n: Int, rate: Int) {
        val now = clock()
        var f = 0
        while (f < 4 && (f + 1) * FIND_N <= n) {
            val o = f * (n / 4)
            for (k in 0 until FIND_N) { fre[k] = ((iq[2 * (o + k)].toInt() and 0xff) - 127.5f) * win[k]; fim[k] = ((iq[2 * (o + k) + 1].toInt() and 0xff) - 127.5f) * win[k] }
            Dsp.fft(fre, fim)
            for (k in 0 until FIND_N) pow[k] += (fre[k] * fre[k] + fim[k] * fim[k]).toDouble()
            pows++; f++
        }
        if (pows < 24 || now - findSince < 1000) return
        findSince = now
        val binHz = rate.toDouble() / FIND_N
        fun db(lo: Double, hi: Double): Double {
            var a = Math.round(lo / binHz).toInt(); var b = Math.round(hi / binHz).toInt(); if (a > b) { val t = a; a = b; b = t }
            var s = 0.0; var c = 0; for (k in a until b) { val i = Math.floorMod(k, FIND_N); s += pow[i]; c++ }
            return 10 * log10(s / max(1, c) / pows + 1e-12)
        }
        val out = ArrayList<HdCandidate>()
        val lo = centerHz - rate / 2 + 240_000; val hi = centerHz + rate / 2 - 240_000
        var ch = ceil((lo - 87_900_000) / 200_000.0).toLong() * 200_000 + 87_900_000
        while (ch <= hi) {
            if (ch in 87_900_000..107_900_000) {
                val o = (ch - centerHz).toDouble()
                val sbL = db(o - 198_000, o - 130_000); val sbH = db(o + 130_000, o + 198_000)
                val outL = db(o - 230_000, o - 206_000); val outH = db(o + 206_000, o + 230_000)
                val gapL = db(o - 125_000, o - 112_000); val gapH = db(o + 112_000, o + 125_000)
                val analog = db(o - 50_000, o + 50_000)
                val edge = min(sbL - outL, sbH - outH); val flat = abs(sbL - sbH)
                if (edge >= 4 && flat < 8 && analog > max(sbL, sbH) && min(sbL - gapL, sbH - gapH) > -6) out.add(HdCandidate(ch, edge, max(sbL, sbH)))
            }
            ch += 200_000
        }
        cands = out
        pow.fill(0.0); pows = 0
    }

    /** Post a snapshot now (the processor posts one every half second of its own). */
    fun publish() {
        val st = synchronized(stationLock) { station.snapshot() }
        val s = HdSnap(tunedHz, centerHz, rate, rx.status, st, cands, detReport, framesDropped, cpuLoad, queue.size + (if (busy) 1 else 0))
        _snap.value = s
        onSnap(s)
    }

    /** Frames still waiting for the FEC. */
    val pendingFrames: Int get() = queue.size + (if (busy) 1 else 0)

    companion object {
        const val SNAP_MS = 500L
        private const val FIND_N = 4096
        private val CLOCK = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
        @Synchronized fun clockText(ms: Long): String = CLOCK.format(java.util.Date(ms))
    }
}

