package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.ham.ChannelDecimator
import com.rocketgod.mayhem.core.ham.ComplexFirDecimator
import com.rocketgod.mayhem.core.ham.lowpassTaps
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

// Not a port of a Mayhem processor: our own decoder for the 900 MHz smart-meter mesh networks (no Mayhem or
// rtl_433 counterpart). Kotlin twin of the iOS MeshDecoder.swift.

/** One frame pulled out of a burst. */
data class MeshFrame(
    val ms: Long,
    val hz: Long,
    val snrDb: Int,
    /** The network's 24-bit sync word (the bits right after the preamble), or GRIDSTREAM. */
    var sync: Int,
    val baud: Int,
    /** Whole bytes after the sync, MSB first (Gridstream: the UART-framed bytes, LSB first). */
    val bytes: List<Int>,
    val durMs: Double,
    /** Gridstream only: the CRC checked with a known utility seed. */
    var crcOk: Boolean = false,
    /** Gridstream only: the length field matches the bytes received (the CRC seed differs by utility). */
    var lenOk: Boolean = false,
)

/** Everything heard from one network (one sync word). */
data class MeshNet(
    val sync: Int,
    var frames: Int = 0,
    var types: Map<Int, Int> = emptyMap(),
    /** 25 kHz slots. */
    var channels: Set<Int> = emptySet(),
    var loHz: Long = Long.MAX_VALUE, var hiHz: Long = 0,
    var lastHex: String = "",
    var lastMs: Long = 0,
    var bestSnr: Int = 0,
    /** Gridstream LAN addresses with a good CRC. */
    var meters: Set<Long> = emptySet(),
)

data class MeshHop(val hz: Long, val ms: Long)

data class MeshField(val name: String, val value: String)

/** Two Gridstream meters heard talking (a routed frame from one, addressed to the other). */
data class MeshLink(val a: Long, val b: Long)

/**
 * One transmitter. On the networks heard so far the first byte after the sync word names the sender: each value
 * comes with its own signal level and its own free-running 16-bit clock in the next two bytes, counting down at
 * 128 a second (the node's hop clock, which lets neighbors predict its channel). Gridstream senders are keyed by the
 * LAN address in their beacons. Its collections are replaced, never changed in place, so a copy is a safe snapshot.
 */
data class MeshDevice(
    val net: Int,
    val id: Long,
    var frames: Int = 0,
    var firstMs: Long = 0, var lastMs: Long = 0,
    /** Recent hops, oldest first. */
    var hops: List<MeshHop> = emptyList(),
    /** Signal of recent frames, oldest first. */
    var snr: List<Int> = emptyList(),
    /** The 16-bit clock in bytes 1-2 of the last frame, and its rate in ticks a second (negative counts down). */
    var clock: Int = -1,
    var clockMs: Long = 0,
    var clockRate: Double = 0.0,
    var ckMs: List<Long> = emptyList(), var ckV: List<Int> = emptyList(),
    var pendMs: Long? = null, var pendV: Int = 0, var pendRun: Int = 0,
    var lastHex: String = "",
    var lengths: Set<Int> = emptySet(),
    /**
     * The node's 24-bit ID, from its long F0 frames ([index] F0 [ID 24] [clock 16] ... 01 00): the same ID comes
     * back with the same first byte across separate recordings. -1 until one is heard.
     */
    var address: Int = -1,
    var addressSeen: Int = 0,
    /** Gridstream: seconds since power-on, as of uptimeMs. */
    var uptimeS: Int = -1,
    var uptimeMs: Long = 0,
    /** Times the hop clock jumped to a new count (a resync). */
    var resyncs: Int = 0,
    /** ERT only: the packet kind, commodity, and consumption (first and latest). */
    var ertKind: String = "", var commodity: String = "",
    var consFirst: Long = -1, var cons: Long = -1,
    var consHistory: List<Long> = emptyList(),
    /** Gridstream: position from the WAN address (the most-heard one wins), its node color, and every decoded field. */
    var lat: Double? = null, var lon: Double? = null, var posColor: Int = 0,
    var wanVotes: Map<Long, Int> = emptyMap(),
    /** Name and value of every field decoded from this device's frames, in frame order, for the detail panel. */
    var fields: List<MeshField> = emptyList(),
    /** Fields kept per kind of frame (BEACON, ROUTED keep-alive ...), shown in the order first heard. */
    var fieldsBy: Map<String, List<MeshField>> = emptyMap(),
    var fieldOrder: List<String> = emptyList(),
    /** Gridstream: the other meters this one has addressed (LAN ids). */
    var talksTo: Set<Long> = emptySet(),
    /** Gridstream: how many frames from other meters were addressed to it. */
    var addressed: Int = 0,
) {
    val key: String get() = "$net/$id"
    val label: String get() = when (net) {
        MeshDecoder.ERT -> id.toString()
        MeshDecoder.GRIDSTREAM -> "%08X".format(id)
        else -> "%02X".format(id)
    }
    /** The clock now, run on from the last frame at its rate (16 bits, wrapping). */
    fun clockAt(ms: Long): Int {
        if (clock < 0) return -1
        val v = clock + MeshDecoder.rnd(clockRate * (ms - clockMs) / 1000).toInt()
        return if (net == MeshDecoder.GRIDSTREAM) ((v % 16_800) + 16_800) % 16_800 else v and 0xFFFF
    }
    /** Gridstream: seconds since power-on now. */
    fun uptimeAt(ms: Long): Int = if (uptimeS < 0) -1 else uptimeS + ((ms - uptimeMs) / 1000).toInt()
    /** Frames a second, over the last minute of hops. */
    fun perSecond(): Double {
        if (hops.size < 2) return 0.0
        val a = hops.first(); val b = hops.last()
        if (b.ms <= a.ms) return 0.0
        return (hops.size - 1) / ((b.ms - a.ms) / 1000.0)
    }
}

/**
 * A Gridstream WAN address as latitude and longitude: 48 bits of S (1), latitude (20), W (1), longitude (21) and a
 * node color (5) that tells apart nodes at one spot, with 90 degrees scaled to 2^21 and the angle counted from the
 * pole and the antimeridian. Layout from the MIT-licensed gpsdecode (github.com/beroset/gpsdecode), checked against
 * its worked example: 42:CB:BE:0E:55:E5 is 43.0342 N, 87.4801 W, color 5.
 */
object GridstreamWan {
    class Pos(val lat: Double, val lon: Double, val color: Int)

    fun decode(v: Long): Pos? {
        val k = 90.0 / 1_048_576.0
        val color = (v and 31).toInt()
        val lonBits = ((v shr 5) and 0x1F_FFFF).toDouble(); val west = (v shr 26) and 1L == 1L
        val latBits = ((v shr 27) and 0xF_FFFF).toDouble(); val south = (v shr 47) and 1L == 1L
        var lat = 90 - k * latBits; var lon = 180 - k * lonBits
        if (south) lat = -lat
        if (west) lon = -lon
        if (!(lat > -90 && lat < 90 && lon > -180 && lon < 180)) return null
        return Pos(lat, lon, color)
    }

    fun value(b: List<Int>, at: Int): Long { var v = 0L; for (i in 0 until 6) v = (v shl 8) or b[at + i].toLong(); return v }
}

/**
 * Smart-meter mesh receiver, worked out from recordings rather than a spec. Meter networks in 902-928 MHz hop a
 * 2-FSK carrier (9600 baud is the common rate) across dozens of channels, a burst of 5-25 ms per hop, so no single
 * channel decoder catches them. This one watches the whole span instead:
 *
 * 1. A 512-point FFT every 2048 samples (half a millisecond at 4.19 Msps) against a per-bin noise floor finds every
 *    burst and its center, wherever it hops.
 * 2. When a burst ends, its samples (kept in a ring) are mixed to DC, filtered to ±45 kHz and decimated, FM
 *    discriminated, centered (the carrier's error sits between the two tones) and sliced at the clock phase with
 *    the widest eye.
 * 3. The alternating preamble is found and the 24 bits after it are the network's sync word. Every network is
 *    learned that way, whoever made it: frames group by sync word, and a polarity rule (the preamble ends on a 1)
 *    makes the same network read the same on every radio.
 * 4. Landis+Gyr Gridstream (sync of 0xAA bytes, then UART-framed 00 FF) is recognized as such: bytes deframed and the
 *    CRC-16/CCITT checked with the published utility seeds, and a beacon's meter LAN address read out.
 */
class MeshDecoder(private val log: PacketLog) : IqProcessor {
    /** Where the radio is tuned (for the frequencies shown); set by the app. */
    @Volatile var centerOf: () -> Long = { 0L }
    var now: () -> Long = { System.currentTimeMillis() }

    private val _nets = MutableStateFlow<List<MeshNet>>(emptyList())
    /** Networks heard, busiest first. */
    val nets: StateFlow<List<MeshNet>> = _nets.asStateFlow()
    private val _bursts = MutableStateFlow(0)
    /** FSK bursts seen, decoded or not. */
    val bursts: StateFlow<Int> = _bursts.asStateFlow()
    private val netMap = LinkedHashMap<Int, MeshNet>()
    private val devMap = LinkedHashMap<String, MeshDevice>()
    private var linkSet = LinkedHashSet<MeshLink>()
    /** Gridstream power usage reports heard (sender not in the clear). */
    var dcwReports = 0; private set
    private val _links = MutableStateFlow<List<MeshLink>>(emptyList())
    /** Gridstream meters heard addressing each other: the mesh's own links. */
    val links: StateFlow<List<MeshLink>> = _links.asStateFlow()
    private val _devices = MutableStateFlow<List<MeshDevice>>(emptyList())
    /** Every transmitter heard, most recently heard first. */
    val devices: StateFlow<List<MeshDevice>> = _devices.asStateFlow()
    private val lastLog = HashMap<Int, Long>()
    private val kinds = HashSet<String>()
    /** Sync words of the networks with enough frames to be sure of. */
    private val established = ArrayList<Int>()
    /** Each network's first two payload bytes, counted: the most common pair follows its sync on the air. */
    private val heads = HashMap<Int, HashMap<Int, Int>>()
    /** Frames thrown away as a slipped read of an established network (see [slipOf]). */
    var slips = 0; private set
    private var lastPublish = 0L
    /** Every decoded frame, for tests and tools. */
    var onFrame: ((MeshFrame) -> Unit)? = null

    // ---- detection ----
    /** FFT size and step, set with the rate: bins of about 8 kHz, a look every half millisecond or so. */
    private var N = 512; private var HOP = 2048
    private var rate = RATE
    private var win = FloatArray(512)
    private var re = FloatArray(512); private var im = FloatArray(512)
    private var floorP = FloatArray(512)
    /** Bin width in Hz. */
    private val binHz: Double get() = rate.toDouble() / N
    private var frames = 0
    private var ring = ByteArray(0)
    private var ringMask = 0
    private var written = 0L          // samples seen
    private var nextFrame = 0L

    private class Burst(var start: Long, var last: Long, var wSum: Double, var w: Double, var peak: Float, var bin: Double)
    private val active = ArrayList<Burst>()
    private var count = 0

    override fun reset(rate: Int) {
        this.rate = rate
        // bins of 8-20 kHz (a burst is 40 kHz wide) and a look every half millisecond (bursts last 5-25 ms): at
        // 19.2 Msps a finer grid and a look every 0.1 ms cost ten times this and fell behind the radio
        N = 512; while (rate.toDouble() / N > 20_000) N = N shl 1
        HOP = maxOf(N, 2048, rate / 2000)
        re = FloatArray(N); im = FloatArray(N)
        val n = N
        win = FloatArray(n) { (0.5 - 0.5 * cos(2 * Math.PI * it / n)).toFloat() }
        floorP = FloatArray(n); frames = 0
        // a ring long enough for the longest burst seen (25 ms) with margin, at any rate
        var size = 1
        while (size < (rate * 0.08).toInt()) size = size shl 1
        ring = ByteArray(2 * size) { 128.toByte() }; ringMask = size - 1
        written = 0; nextFrame = n.toLong(); active.clear()
    }

    @Volatile private var pendingClear = false

    /** Forget everything heard. Safe from any thread: the tables are emptied on the DSP thread at its next buffer. */
    fun clear() {
        pendingClear = true
        _links.value = emptyList(); _devices.value = emptyList(); _nets.value = emptyList(); _bursts.value = 0
    }

    private fun doClear() {
        established.clear(); slipCache.clear(); syncFrames = 0; netMap.clear(); devMap.clear(); linkSet = LinkedHashSet(); lastLog.clear(); kinds.clear(); count = 0
        _links.value = emptyList(); _devices.value = emptyList(); _nets.value = emptyList(); _bursts.value = 0
    }

    /**
     * How much of real time this decoder is taking (smoothed): above 0.5 only the strongest bursts are demodulated,
     * above 0.8 none are, so a busy band at a wide span can never starve the waterfall or stall the radio.
     */
    var busy = 0.0; private set
    private var shed = 0
    /** Off for replays and tests, which run at their own pace (a slow debug build is not behind any radio). */
    var shedding = true

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (pendingClear) { pendingClear = false; doClear() }
        if (ring.isEmpty() || rate != this.rate) reset(rate)
        val t0 = System.nanoTime()
        val n = len / 2
        for (k in 0 until n) {
            val p = (written and ringMask.toLong()).toInt() * 2
            ring[p] = iq[2 * k]; ring[p + 1] = iq[2 * k + 1]
            written++
            if (written == nextFrame) { detect(); nextFrame += HOP }
        }
        val used = (System.nanoTime() - t0) / 1e9; val air = n.toDouble() / rate
        if (air > 0) busy += 0.1 * (used / air - busy)
    }

    private fun sampleI(s: Long): Float = (ring[(s and ringMask.toLong()).toInt() * 2].toInt() and 0xff) - 127.4f
    private fun sampleQ(s: Long): Float = (ring[(s and ringMask.toLong()).toInt() * 2 + 1].toInt() and 0xff) - 127.4f

    private fun detect() {
        val n = N
        val s0 = written - n
        for (k in 0 until n) { re[k] = sampleI(s0 + k) * win[k]; im[k] = sampleQ(s0 + k) * win[k] }
        Dsp.fft(re, im)
        frames++
        val hotB = ArrayList<Int>(); val hotR = ArrayList<Float>()   // (shifted bin, power over floor)
        for (k in 0 until n) {
            val b = (k + n / 2) % n                 // 0 = lowest frequency
            val p = re[k] * re[k] + im[k] * im[k]
            var f = floorP[b]
            if (frames <= 8) f = if (frames == 1) p else f + 0.3f * (p - f)
            else if (p < f * 4) f += 0.02f * (p - f) else f += 0.0005f * (p - f)
            floorP[b] = f
            if (frames > 8 && abs(b - n / 2) * binHz > 20_000 && p > f * 25) { hotB.add(b); hotR.add(p / max(f, 1e-3f)) }
        }
        // bins come out in FFT order, two runs each in order: put them in frequency order
        val order = hotB.indices.sortedBy { hotB[it] }
        // clusters of hot bins (a 2-FSK burst lights both tones, ±20 kHz is ±2.5 bins at 8 kHz)
        var i = 0
        while (i < order.size) {
            var j = i; var w = 0.0; var ws = 0.0; var pk = 0f
            while (j < order.size && (j == i || (hotB[order[j]] - hotB[order[j - 1]]) * binHz <= 26_000)) {
                val r = hotR[order[j]].toDouble(); w += r; ws += r * hotB[order[j]]; pk = max(pk, hotR[order[j]]); j++
            }
            val cBin = ws / w
            val k = active.indexOfFirst { abs(it.bin - cBin) * binHz <= 57_000 }
            if (k >= 0) {
                val a = active[k]
                a.last = written; a.wSum += cBin * w; a.w += w; a.peak = max(a.peak, pk)
                a.bin = a.wSum / a.w
            } else active.add(Burst(s0, written, cBin * w, w, pk, cBin))
            i = j
        }
        // a burst that has gone quiet for 3 frames is done
        val quiet = max(3 * HOP, rate / 650).toLong()
        val done = ArrayList<Burst>()
        active.removeAll { b ->
            if (written - b.last > quiet) { done.add(b); true }
            else written - b.start > rate * 0.06   // a carrier, not a burst
        }
        // a strong burst splashes into neighbors: keep the strongest of those that ended together
        done.sortByDescending { it.peak }
        val kept = ArrayList<Burst>()
        for (b in done) if (kept.none { abs(it.bin - b.bin) * rate / n < 200_000 && abs(it.last - b.last) < rate / 500 }) kept.add(b)
        for (b in kept) {
            // over budget: keep up with the radio first, decode what the time allows (strong bursts first)
            if (shedding && (busy > 0.8 || (busy > 0.5 && b.peak < 60))) { shed++; continue }
            demod(b)
        }
    }

    // ---- demodulation ----
    private fun demod(b: Burst) {
        val dur = (b.last - b.start).toDouble() / rate
        if (dur < 0.002) return
        count++
        val n = N
        val offHz = (b.bin - n / 2) * rate / n
        val edge = max(HOP, rate / 2000).toLong()
        val from = max(b.start - edge, written - ringMask + 1)
        val to = min(written, b.last + edge)
        val len = (to - from).toInt()
        if (len < 256) return
        // mix the burst to DC
        val mixed = FloatArray(2 * len)
        val wv = -2 * Math.PI * offHz / rate
        val sr = cos(wv); val si = sin(wv)
        var cr = 1.0; var ci = 0.0
        for (k in 0 until len) {
            val iv = sampleI(from + k).toDouble(); val qv = sampleQ(from + k).toDouble()
            mixed[2 * k] = (iv * cr - qv * ci).toFloat(); mixed[2 * k + 1] = (iv * ci + qv * cr).toFloat()
            val t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t
            if (k and 1023 == 0) { val g = 1 / sqrt(cr * cr + ci * ci); cr *= g; ci *= g }
        }
        // down to about 262 kHz through a CIC and a short FIR (cheap at 20 Msps), then a ±45 kHz channel filter
        val chan = ChannelDecimator(max(1, rate / 262_144))
        val dec = chan.total
        val z0 = FloatArray(chan.outSize(len))
        val m0 = chan.process(mixed, len, z0)
        val fs = rate.toDouble() / dec
        val lp = ComplexFirDecimator(lowpassTaps(45_000 / fs, 33), 1)
        val z = FloatArray(2 * (m0 + 2))
        val m = lp.process(z0, m0, z)
        if (m < 2) return
        // where the burst actually is (the detector's edges are half a millisecond coarse)
        val pw = FloatArray(m) { z[2 * it] * z[2 * it] + z[2 * it + 1] * z[2 * it + 1] }
        val top = pw.sortedArray()[min(m - 1, (m * 0.995).toInt())]
        val a = pw.indexOfFirst { it > 0.2f * top }; val e = pw.indexOfLast { it > 0.2f * top }
        if (a < 0 || e - a <= 64) return
        val fm = FloatArray(e - a)
        for (k in a + 1..e) {
            val i0 = z[2 * (k - 1)]; val q0 = z[2 * (k - 1) + 1]; val i1 = z[2 * k]; val q1 = z[2 * k + 1]
            fm[k - a - 1] = atan2(q1 * i0 - i1 * q0, i1 * i0 + q1 * q0)
        }
        val srt = fm.sortedArray()
        val mid = (srt[(srt.size * 0.95).toInt()] + srt[(srt.size * 0.05).toInt()]) / 2
        for (k in fm.indices) fm[k] -= mid
        val hz = centerOf() + (offHz + mid * fs / (2 * Math.PI)).toLong()
        val snr = rnd(10 * log10(b.peak.toDouble())).toInt()
        for (baud in BAUDS) {
            val bits = slice(fm, fs / baud)
            extraFrames.clear()
            val f = parse(bits, baud, hz, snr, dur)
            if (f != null) { publish(f); for (x in extraFrames.toList()) publish(x); extraFrames.clear(); return }
        }
        // not FSK: try it as on-off keying at 32768 chips a second (Neptune R900 water meters)
        ook(z, a, e, fs, centerOf() + offHz.toLong(), snr)
    }

    /**
     * An on-off burst in its own channel: the envelope, chips at 32768 a second at the phase with the widest swing,
     * the R900 preamble looked for in them (a chip or two wrong allowed), and the 168 chips after it decoded.
     */
    private fun ook(z: FloatArray, a: Int, e: Int, fs: Double, hz: Long, snr: Int) {
        val spc = fs / 32768.0
        if (spc < 3) return
        val env = FloatArray(e - a + 1) { sqrt(z[2 * (a + it)] * z[2 * (a + it)] + z[2 * (a + it) + 1] * z[2 * (a + it) + 1]) }
        val n = (env.size / spc).toInt() - 1
        if (n < 200) return
        val sorted = env.sortedArray(); val thr = (sorted[sorted.size / 20] + sorted[sorted.size * 19 / 20]) / 2
        var bestPh = 0.0; var bestSwing = -1f
        for (p in 0 until 8) {
            val ph = spc * p / 8
            var sw = 0f
            for (k in 0 until n) { val c = chipEnergy(env, ph + k * spc, spc); sw += abs(c - thr) }
            if (sw > bestSwing) { bestSwing = sw; bestPh = if (p == 0) 0.0 else spc * p / 8 }
        }
        var chips = 0L
        for (k in 0 until n) {
            val en = chipEnergy(env, bestPh + k * spc, spc) - thr
            chips = (chips shl 1) or (if (en > 0) 1L else 0L)
            if (k >= 31 && k + 168 < n && java.lang.Long.bitCount((chips xor R900_SYNC) and 0xFFFF_FFFFL) <= 2) {
                val p = FloatArray(168) { chipEnergy(env, bestPh + (k + 1 + it) * spc, spc) }
                val r = ErtDecoder.decodeR900(p)
                if (r != null) {
                    log.add("%.3f +%d dB ".format(hz / 1e6, snr) + r.line)
                    ertReading("R900", r.id, "water", r.cons, r.extra + listOf("FREQUENCY" to "%.4f MHz".format(hz / 1e6), "SIGNAL" to "+$snr dB"))
                    return
                }
            }
        }
    }

    private fun chipEnergy(env: FloatArray, start: Double, spc: Double): Float {
        val a = start.toInt(); val b = min(env.size, (start + spc).toInt())
        if (b <= a) return 0f
        var s = 0f
        for (i in a until b) s += env[i]
        return s / (b - a)
    }

    /** Hard bits at the clock phase with the widest eye (a burst is short enough for one phase to hold). */
    private fun slice(fm: FloatArray, sps: Double): IntArray {
        var best = -1f; var bestPh = 0.0
        val count = (fm.size / sps).toInt() - 1
        if (count < 16) return IntArray(0)
        for (p in 0 until 16) {
            val ph = sps * p / 16
            var s = 0f
            for (k in 0 until count) s += abs(fm[(ph + k * sps).toInt()])
            if (s > best) { best = s; bestPh = ph }
        }
        return IntArray(count) { if (fm[(bestPh + it * sps).toInt()] > 0) 1 else 0 }
    }

    // ---- framing ----
    fun parse(raw: IntArray, baud: Int, hz: Long, snr: Int, dur: Double): MeshFrame? {
        for (inv in booleanArrayOf(false, true)) {
            val bits = if (inv) IntArray(raw.size) { 1 - raw[it] } else raw
            val p = gridstreamStart(bits) ?: continue
            var bytes = ArrayList<Int>()
            var q = p
            // the header strictly framed; once the length field is in, that many bytes are read even through a
            // start or stop bit or two gone wrong (one flipped bit used to end the frame, and its position with it)
            var slips = 0
            while (q + 10 <= bits.size && bytes.size < 300) {
                val framed = bits[q + 9] == 1 && (q == p + 10 || bits[q] == 0)
                if (!framed) {
                    if (bytes.size < 6) break
                    val want = 6 + ((bytes[4] shl 8) or bytes[5])
                    slips++
                    if (bytes.size >= want || slips > max(2, want / 12)) break
                } else if (bytes.size >= 6 && bytes.size >= 6 + ((bytes[4] shl 8) or bytes[5])) break
                var v = 0
                for (k in 0 until 8) v = v or (bits[q + 1 + k] shl k)   // UART: LSB first
                bytes.add(v); q += 10
            }
            if (bytes.size < 6) trace?.invoke("GS short baud $baud inv $inv ${bytes.size}B bits " + (p until min(bits.size, p + 90)).joinToString("") { bits[it].toString() })
            // the 24-bit start turns up by chance in a busy band: a real frame carries at least its 6-byte header
            if (bytes.size < 6) continue
            var ok = false; var lenOk = false
            if (bytes.size >= 8) {
                val ln = (bytes[4] shl 8) or bytes[5]
                if (ln >= 4 && bytes.size >= 6 + ln) {
                    ok = GS_SEEDS.any { crcCcitt(bytes, 2, 6 + ln, it) == 0 || crcCcitt(bytes, 6, 6 + ln, it) == 0 }
                    bytes = ArrayList(bytes.subList(0, 6 + ln)); lenOk = true
                }
            }
            return MeshFrame(now(), hz, snr, GRIDSTREAM, baud, bytes, dur * 1000, crcOk = ok, lenOk = lenOk)
        }
        // any other network: an alternating preamble of 16+ bits, then its sync word
        // the first alternating run of 16+ bits (noise ahead of the burst makes short ones)
        var k = 0; var j = -1
        while (k + 1 < raw.size && k < 160) {
            var e = k
            while (e + 1 < raw.size && raw[e] != raw[e + 1]) e++
            if (e - k >= 16) { j = e; break }
            k = e + 1
        }
        if (j < 0 || j + 1 + 24 + 8 > raw.size) return null
        // polarity: the preamble ends on a 1
        var bits = if (raw[j] == 1) raw else IntArray(raw.size) { 1 - raw[it] }
        var start = j + 1
        // an established network's sync word a few bits either side (the preamble's end is read a bit or two off
        // when noise or the ramp-up blurs it) wins over the bits that happen to sit there
        found@ for (net in established) {
            for (inv in booleanArrayOf(false, true)) {
                val bb = if (inv) IntArray(bits.size) { 1 - bits[it] } else bits
                for (st in max(0, j - 8)..min(bb.size - 32, j + 48)) {
                    var v = 0
                    for (x in st until st + 24) v = (v shl 1) or bb[x]
                    if (Integer.bitCount(v xor net) <= 1) { bits = bb; start = st; break@found }
                }
            }
        }
        var sync = 0
        for (x in start until start + 24) sync = (sync shl 1) or bits[x]
        // a burst can hold several frames back to back (a poll and the reply in the same slot): every later copy of
        // the sync word starts a frame of its own, and the alternating preamble before it is not part of the last one
        val starts = arrayListOf(start)
        var s2 = start + 48
        while (s2 + 24 <= bits.size) {
            var v = 0
            for (x in s2 until s2 + 24) v = (v shl 1) or bits[x]
            if (Integer.bitCount(v xor sync) <= 1) { starts.add(s2); s2 += 48 } else s2++
        }
        val bf = bits
        fun bytesOf(from: Int, to: Int): List<Int> {
            // the next frame's preamble is at least 16 bits: stop short of it, then drop whole 55 / AA bytes left over
            val end = if (to < bf.size) max(from, to - 16) else to
            val out = ArrayList<Int>()
            var q = from
            while (q + 8 <= end) {
                var v = 0
                for (x in q until q + 8) v = (v shl 1) or bf[x]
                out.add(v); q += 8
            }
            if (to < bf.size) while (out.isNotEmpty() && (out.last() == 0x55 || out.last() == 0xAA)) out.removeAt(out.size - 1)
            return out
        }
        for (s in starts.indices) {
            val from = starts[s] + 24; val to = if (s + 1 < starts.size) starts[s + 1] else bits.size
            val bytes = bytesOf(from, to)
            if (s > 0 && bytes.isNotEmpty()) extraFrames.add(MeshFrame(now(), hz, snr, sync, baud, bytes, dur * 1000))
        }
        return MeshFrame(now(), hz, snr, sync, baud, bytesOf(start + 24, if (starts.size > 1) starts[1] else bits.size), dur * 1000)
    }

    /** Frames after the first in the same burst, published right after it. */
    private val extraFrames = ArrayList<MeshFrame>()

    // ---- results ----
    /** Every decoded frame comes through here (internal so tests can feed frames directly). */
    internal fun publish(frame: MeshFrame) {
        if (isPreamble(frame.sync)) return
        val f = frame.copy()
        // a sync word a bit or two off an established network's is that network with bit errors
        if (f.sync != GRIDSTREAM && (netMap[f.sync]?.frames ?: 0) < MIN_FRAMES) {
            val near = netMap.values.filter { it.sync != GRIDSTREAM && it.frames >= 5 && Integer.bitCount(it.sync xor f.sync) <= 2 }.maxByOrNull { it.frames }
            if (near != null) f.sync = near.sync
            // not a few flipped bits but a slipped one: the sync search locked a bit or two early or late (or on
            // the preamble's tail), so the word read is a window of an established network's own bit stream, and
            // the bytes after it are misaligned too. One busy network turned into thousands of "networks" this way.
            else if (slipOf(f.sync) != null) { slips++; return }
        }
        onFrame?.invoke(f)
        if (f.sync != GRIDSTREAM) syncFrames++
        val net = netMap[f.sync] ?: MeshNet(f.sync)
        net.frames++
        f.bytes.firstOrNull()?.let { t -> net.types = net.types + (t to (net.types[t] ?: 0) + 1) }
        net.channels = net.channels + rnd(f.hz / 25_000.0).toInt()
        net.loHz = min(net.loHz, f.hz); net.hiHz = max(net.hiHz, f.hz)
        net.lastHex = f.bytes.take(24).joinToString(" ") { "%02X".format(it) }
        net.lastMs = f.ms; net.bestSnr = max(net.bestSnr, f.snrDb)
        if (f.sync == GRIDSTREAM && f.crcOk && f.bytes.size >= 30 && f.bytes[2] == 0x2A && f.bytes[3] == 0x55) net.meters = net.meters + u32(f.bytes, 26)
        netMap[f.sync] = net
        if (f.sync != GRIDSTREAM && f.bytes.size >= 2) heads.getOrPut(f.sync) { HashMap() }.merge((f.bytes[0] shl 8) or f.bytes[1], 1, Int::plus)
        if (net.frames == 20 && f.sync != GRIDSTREAM && !established.contains(f.sync)) established.add(f.sync)
        if (net.frames >= MIN_FRAMES || f.sync == GRIDSTREAM) track(f)
        // the debug log gets each new kind of frame (network, first byte, length), and every long one: readings
        // arrive rarely and in longer frames than the hop beacons
        val kind = "${syncName(f.sync)} ${"%02X".format(f.bytes.firstOrNull() ?: 0)} ${f.bytes.size}B"
        if (net.frames >= MIN_FRAMES && (f.bytes.size >= 10 || !kinds.contains(kind))) { kinds.add(kind); Diag.log("MESH ${line(f)}") }
        // the log: every Gridstream frame, else at most one line a second per network and frame type
        val key = f.sync * 257 + (f.bytes.firstOrNull() ?: 0)
        if (f.sync == GRIDSTREAM || (net.frames >= MIN_FRAMES && f.ms - (lastLog[key] ?: 0L) >= 1000)) {
            lastLog[key] = f.ms
            log.add(line(f))
        }
        if (f.ms - lastPublish >= 250) {
            lastPublish = f.ms
            flush()
        }
    }

    /**
     * The dominant network [sync] is a slipped read of, if any. Only a network carrying at least 1% of all frames is
     * a candidate: the ghosts come from the busy one, and each extra candidate is another chance to swallow a real
     * small network (checked against all networks with 5+ frames, 10 of 60 injected random networks vanished; against
     * the dominant ones only, none). [sync] is that network's slip when, for one of its 16 commonest two-byte heads,
     * it is within 2 bit errors of a 24-bit window of its preamble's tail, sync and head (shifted -8 to +16), or
     * exactly a one-bit slip of sync and head, or within edit distance 2 of that whole stretch. Replayed over 1.59 M
     * real frames: 97 listed networks without this, 49 with it.
     */
    private fun slipOf(sync: Int): Int? {
        val p = IntArray(24) { (sync shr (23 - it)) and 1 }
        for (net in netMap.values) {
            val e = net.sync
            if (e == GRIDSTREAM || e == sync || net.frames < 5 || net.frames < 0.01 * syncFrames) continue
            val hs = heads[e]?.entries?.sortedByDescending { it.value }?.take(16)?.map { it.key } ?: emptyList()
            val w = slipWords(e, net.frames, hs)
            for (x in w) if (Integer.bitCount(x xor sync) <= 2) return e
            for (h in hs) {
                val ctx = ArrayList<Int>(56)
                for (i in 15 downTo 0) ctx.add((0x5555 shr i) and 1)
                for (i in 23 downTo 0) ctx.add((e shr i) and 1)
                for (i in 15 downTo 0) ctx.add((h shr i) and 1)
                if (editIn(p, ctx) <= 2) return e
            }
        }
        return null
    }

    /** Frames of every network but Gridstream, for the 1% share [slipOf] asks of a candidate. */
    private var syncFrames = 0L
    /** Per network: the slip words of its preamble, sync and heads, and the frame count they were worked out at. */
    private val slipCache = HashMap<Int, Pair<Int, IntArray>>()

    private fun slipWords(e: Int, frames: Int, hs: List<Int>): IntArray {
        slipCache[e]?.let { (at, w) -> if (frames < 2 * at) return w }
        val out = HashSet<Int>()
        fun word(b: IntArray, from: Int): Int { var v = 0; for (i in 0 until 24) v = (v shl 1) or b[from + i]; return v }
        for (h in hs) {
            val s = IntArray(56)
            for (i in 0 until 16) s[i] = (0x5555 shr (15 - i)) and 1
            for (i in 0 until 24) s[16 + i] = (e shr (23 - i)) and 1
            for (i in 0 until 16) s[40 + i] = (h shr (15 - i)) and 1
            for (sh in -8..16) out.add(word(s, 16 + sh))
            val sb = s.copyOfRange(16, 56)
            for (k in 0 until 24) {
                // a bit lost at k, or one gained there (either value)
                out.add(word(sb.copyOfRange(0, k) + sb.copyOfRange(k + 1, sb.size), 0))
                for (x in 0..1) out.add(word(sb.copyOfRange(0, k) + intArrayOf(x) + sb.copyOfRange(k, sb.size), 0))
            }
        }
        val w = out.toIntArray()
        slipCache[e] = maxOf(1, frames) to w
        return w
    }

    /**
     * Gridstream, laid out as on the RECESSIM wiki. A 2A 55 beacon carries the meter's LAN id (on its sticker), its
     * uptime, its WAN address (a position), status, descriptor and hop clock. A 2A D5 frame is routed: destination
     * and source LAN ids, and for registration (opcode 51 / 55) the network time, uptime and the source's WAN address.
     */
    private fun trackGridstream(f: MeshFrame) {
        val b = f.bytes
        // a power usage report (types 00-03, subtype 81 / 85): no sender in the clear, so it is counted for the network
        if (b.size >= 6 && b[2] <= 3 && (b[3] == 0x81 || b[3] == 0x85)) { dcwReports++; return }
        if (!(f.crcOk || f.lenOk) || b.size < 15 || b[2] != 0x2A) return
        // an id a bit or two off a meter already heard twice is that meter with bit errors
        fun canon(id: Long): Long {
            if (devMap["$GRIDSTREAM/$id"] != null) return id
            val near = devMap.values.filter { it.net == GRIDSTREAM && it.frames >= 2 && java.lang.Long.bitCount(it.id xor id) <= 2 }.maxByOrNull { it.frames }
            return near?.id ?: id
        }
        fun dev(id: Long): MeshDevice { val c = canon(id); return devMap["$GRIDSTREAM/$c"] ?: MeshDevice(GRIDSTREAM, c, firstMs = f.ms) }
        fun put(d: MeshDevice) { devMap["$GRIDSTREAM/${d.id}"] = d }
        fun heard(d: MeshDevice) {
            d.frames++; d.lastMs = f.ms
            d.hops = (d.hops + MeshHop(f.hz, f.ms)).takeLast(48)
            d.snr = (d.snr + f.snrDb).takeLast(60)
            d.lengths = d.lengths + b.size
            d.lastHex = b.take(16).joinToString(" ") { "%02X".format(it) }
        }
        // the fields from each kind of frame are kept side by side: a beacon's position stays when a routed frame comes
        fun setFields(d: MeshDevice, kind: String, fl: List<MeshField>) {
            d.fieldsBy = d.fieldsBy + (kind to fl)
            if (!d.fieldOrder.contains(kind)) d.fieldOrder = d.fieldOrder + kind
            d.fields = d.fieldOrder.flatMap { k -> listOf(MeshField("──", k)) + (d.fieldsBy[k] ?: emptyList()) }
        }
        fun position(d: MeshDevice, wan: Long) {
            d.wanVotes = d.wanVotes + (wan to (d.wanVotes[wan] ?: 0) + 1)
            // a position is shown once two beacons agree on it, or while it is the only one heard
            val best = d.wanVotes.maxByOrNull { it.value }
            val p = if (best != null && (best.value >= 2 || d.wanVotes.size == 1)) GridstreamWan.decode(best.key) else null
            if (p != null) { d.lat = p.lat; d.lon = p.lon; d.posColor = p.color } else { d.lat = null; d.lon = null }
        }
        if (b[3] == 0x55 && b.size >= 37 && b[6] == 0x30) {
            val d = dev(u32(b, 26))
            heard(d)
            d.uptimeS = u32(b, 20).toInt(); d.uptimeMs = f.ms
            d.clock = (b[35] shl 8) or b[36]; d.clockMs = f.ms; d.clockRate = 100.0   // hundredths into the 168 s cycle
            position(d, GridstreamWan.value(b, 13))
            val up = d.uptimeS
            val la = d.lat; val lo = d.lon
            setFields(d, "BEACON", listOf(
                MeshField("FRAME", "beacon 2A 55, sync opcode 30, ${b.size} bytes"),
                MeshField("METER ID", "%08X (%d)".format(d.id, d.id)),
                MeshField("POSITION", if (la != null && lo != null) "%.5f, %.5f".format(la, lo) else "-"),
                MeshField("NODE COLOR", d.posColor.toString()),
                MeshField("WAN ADDRESS", hex(b, 13, 19)),
                MeshField("DESTINATION", hex(b, 7, 13)),
                MeshField("UPTIME", "%d s (%dd %02dh %02dm)".format(up, up / 86400, up / 3600 % 24, up / 60 % 60)),
                MeshField("COUNTER", "%02X (%d, steps by 2)".format(b[19], b[19])),
                MeshField("STATUS", statusWord(b[24], b[25])),
                MeshField("FORMAT", hex(b, 30, 32) + if (b[30] == 0x01) " (record marker)" else ""),
                MeshField("DEVICE", descriptor(b[32], b[33], b[34])),
                MeshField("HOP CLOCK", "%.2f s into the 168 s cycle · channel slot %d of 240".format(d.clock / 100.0, d.clock / 70 % 240)),
                MeshField("TX FLAGS", if (b.size >= 39) "%s (transmit status %X)".format(hex(b, 37, 39), b[38] and 0x0F) else "-"),
                MeshField("TRAILER", if (b.size > 41) hex(b, 39, b.size - 2) else "-"),
                MeshField("CRC", hex(b, b.size - 2, b.size) + if (f.crcOk) " · ok (known seed)" else " · length ok, utility seed unknown"),
            ))
            put(d)
        } else if (b[3] == 0xD5 && b.size >= 15) {
            val dst = canon(u32(b, 7)); val src = canon(u32(b, 11))
            val d = dev(src)
            heard(d)
            d.talksTo = d.talksTo + dst
            if (dst != 0xFFFF_FFFFL && dst != src) linkSet.add(MeshLink(min(src, dst), max(src, dst)))
            val n = b.size
            val fl = arrayListOf(
                MeshField("FRAME", "routed 2A D5 · %s (opcode %02X) · %d bytes".format(opcode(b[6]), b[6], n)),
                MeshField("METER ID", "%08X (%d)".format(src, src)),
                MeshField("TO", if (dst == 0xFFFF_FFFFL) "everyone (broadcast)" else "%08X (%d)".format(dst, dst)),
                MeshField("FRAME ID", if (b.size > 15) "%02X".format(b[15]) else "-"))
            // the tail of every routed frame: hop clock, status / flags, CRC
            if (n >= 24) {
                val hc = (b[n - 6] shl 8) or b[n - 5]
                if (hc < 16_800) {
                    fl.add(MeshField("HOP CLOCK", "%.2f s into the 168 s cycle".format(hc / 100.0)))
                    d.clock = hc; d.clockMs = f.ms; d.clockRate = 100.0
                }
                fl.add(MeshField("TX FLAGS", hex(b, n - 4, n - 2)))
                fl.add(MeshField("CRC", hex(b, n - 2, n)))
            }
            if ((b[6] == 0x51 || b[6] == 0x55) && b.size >= 42) {
                val epoch = u32(b, 16); val up = u32(b, 24).toInt()
                d.uptimeS = up; d.uptimeMs = f.ms
                position(d, GridstreamWan.value(b, 32))
                val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
                val terr = u32(b, 20).toInt()
                val wan = GridstreamWan.decode(GridstreamWan.value(b, 32))
                val own = u32(b, 38)
                fl += listOf(
                    MeshField("NETWORK TIME", fmt.format(Date(epoch * 1000)) + " UTC"),
                    MeshField("CLOCK ERROR", "%d (%s)".format(terr, hex(b, 20, 24))),
                    MeshField("UPTIME", "%d s (%dd %02dh)".format(up, up / 86400, up / 3600 % 24)),
                    MeshField("STATUS", statusWord(b[28], b[29])),
                    MeshField("SEQUENCE", "threshold %d · number %d".format(b[30], b[31])),
                    MeshField("POSITION", if (wan != null) "%.5f, %.5f (node color %d)".format(wan.lat, wan.lon, wan.color) else "-"),
                    MeshField("WAN ADDRESS", hex(b, 32, 38)),
                    MeshField("OWN ID", "%08X%s".format(own, if (own == src) " (matches sender)" else "")))
                if (n > 48) {
                    fl.add(MeshField("DEVICE", descriptor(b[42], b[43], b[44])))
                    fl.add(MeshField("LINK QUALITY", hex(b, 45, n - 6)))
                }
            } else if (n > 22) {
                val p = b[16]
                fl.add(MeshField("PAYLOAD TYPE", "%02X%s".format(p, if (p and 0x80 != 0) " · routed" else " · direct")))
                fl.add(MeshField("PAYLOAD", hex(b, 17, n - 6)))
            }
            setFields(d, "ROUTED %s".format(opcode(b[6])), fl)
            put(d)
            // the addressed meter exists too, even before its own beacon
            if (dst != 0xFFFF_FFFFL && dst != src) {
                val t = devMap["$GRIDSTREAM/$dst"]
                if (t != null) { t.addressed++; put(t) }
                else {
                    val nt = dev(dst); nt.firstMs = f.ms; nt.lastMs = 0; nt.addressed = 1
                    nt.fields = listOf(MeshField("METER ID", "%08X (%d)".format(dst, dst)), MeshField("HEARD", "only addressed by others"))
                    put(nt)
                }
            }
        }
    }

    private fun track(f: MeshFrame) {
        if (f.sync == GRIDSTREAM) { trackGridstream(f); return }
        val first = f.bytes.firstOrNull() ?: return
        var id = first.toLong()
        var key = "${f.sync}/$id"
        val c16 = if (f.bytes.size >= 3) (f.bytes[1] shl 8) or f.bytes[2] else -1
        // an id a bit off an established device whose clock this frame fits is that device with a bit error
        if ((devMap[key]?.frames ?: 0) < 3) {
            val near = devMap.values.firstOrNull { v -> v.net == f.sync && v.frames >= 5 && java.lang.Long.bitCount(v.id xor id) == 1 &&
                c16 >= 0 && v.clock >= 0 && wrap16(c16 - v.clockAt(f.ms)) < 80 }
            if (near != null) { id = near.id; key = "${f.sync}/$id" }
        }
        val d = devMap[key] ?: MeshDevice(f.sync, id, firstMs = f.ms)
        d.frames++; d.lastMs = f.ms
        d.hops = (d.hops + MeshHop(f.hz, f.ms)).takeLast(48)
        d.snr = (d.snr + f.snrDb).takeLast(60)
        d.lengths = d.lengths + f.bytes.size
        d.lastHex = f.bytes.take(16).joinToString(" ") { "%02X".format(it) }
        // a long F0 frame names the node: F0, its 24-bit ID, then a clock of its own. A short one (5 bytes or so) is
        // only a beacon whose clock happens to read F0xx, and goes on to the clock like any other.
        if (f.bytes.size >= 9 && f.bytes[1] == 0xF0) {
            val a = (f.bytes[2] shl 16) or (f.bytes[3] shl 8) or f.bytes[4]
            if (a == d.address) d.addressSeen++ else { d.address = a; d.addressSeen = 1 }
            devMap[key] = d
            return
        }
        d.fields = listOf(
            MeshField("NETWORK", syncName(f.sync) + " · %d baud 2-FSK".format(f.baud)),
            MeshField("DEVICE", "%02X (first byte of every frame)".format(id)),
            MeshField("LAST FRAME", f.bytes.joinToString(" ") { "%02X".format(it) }),
            MeshField("FREQUENCY", "%.4f MHz".format(f.hz / 1e6)),
            MeshField("SIGNAL", "+${f.snrDb} dB"),
            MeshField("LENGTHS", d.lengths.sorted().joinToString(", ") + " bytes"),
            MeshField("NODE ID", if (d.address >= 0) "%06X (%d), heard %d×".format(d.address, d.address, d.addressSeen) else "not announced yet"),
            MeshField("FRAME LAYOUT", "index · clock (128/s) · check — ID frames: index · F0 · ID · clock · … 01 00"))
        if (c16 >= 0) {
            // once the clock is known, a value that does not fit it (a bit error, another kind of frame) is left out
            val fits = d.ckV.size < 3 || wrap16(c16 - d.clockAt(f.ms)) < 80
            if (fits) {
                d.ckMs = (d.ckMs + f.ms).takeLast(12); d.ckV = (d.ckV + c16).takeLast(12)
                val slopes = ArrayList<Double>()
                for (k in 1 until d.ckV.size) {
                    if (d.ckMs[k] - d.ckMs[k - 1] < 25) continue
                    var dv = (d.ckV[k] - d.ckV[k - 1]) and 0xFFFF; if (dv >= 32768) dv -= 65536
                    val r = dv / ((d.ckMs[k] - d.ckMs[k - 1]) / 1000.0)
                    if (abs(r) <= 1000) slopes.add(r)   // the clocks seen tick 64 or 128 a second
                }
                if (slopes.size >= 2 || (d.clockRate == 0.0 && slopes.isNotEmpty())) { slopes.sort(); d.clockRate = slopes[slopes.size / 2] }
                d.clock = c16; d.clockMs = f.ms
            } else {
                // frames on another clock line (another sender with the same index, or another kind of frame) are
                // left out; the card moves to a new line only once it has clearly taken over, 5 frames running
                val pm = d.pendMs
                if (pm != null && f.ms - pm >= 25 && wrap16(c16 - (d.pendV + (d.clockRate * (f.ms - pm) / 1000).toInt())) < 40) {
                    d.pendRun++; d.pendMs = f.ms; d.pendV = c16
                    if (d.pendRun >= 5) { d.ckMs = listOf(f.ms); d.ckV = listOf(c16); d.clock = c16; d.clockMs = f.ms; d.resyncs++; d.pendMs = null; d.pendRun = 0 }
                } else { d.pendMs = f.ms; d.pendV = c16; d.pendRun = 1 }
            }
        }
        devMap[key] = d
    }

    /** An ERT reading from ErtDecoder: the meter joins the device list with its consumption. */
    fun ertReading(kind: String, id: Long, commodity: String, cons: Long, extra: List<Pair<String, String>> = emptyList()) {
        if (pendingClear) { pendingClear = false; doClear() }
        val ms = now()
        val uid = id and 0xFFFF_FFFFL
        val key = "$ERT/$uid"
        val d = devMap[key] ?: MeshDevice(ERT, uid, firstMs = ms)
        d.frames++; d.lastMs = ms
        d.ertKind = kind; d.commodity = commodity
        if (d.consFirst < 0) d.consFirst = cons
        d.cons = cons
        if (d.consHistory.lastOrNull() != cons) d.consHistory = (d.consHistory + cons).takeLast(60)
        d.fields = listOf(MeshField("PROTOCOL", if (kind == "R900") "Neptune R900" else "Itron ERT $kind"), MeshField("METER ID", "$id"),
            MeshField("COMMODITY", commodity), MeshField("CONSUMPTION", "$cons"),
            MeshField("SINCE FIRST HEARD", "+${cons - d.consFirst}"), MeshField("READINGS", "${d.frames}")) +
            extra.map { MeshField(it.first, it.second) }
        d.hops = (d.hops + MeshHop(0, ms)).takeLast(48)
        devMap[key] = d
        flush()
    }

    /**
     * A Gridstream id heard once, a bit or two off a meter heard three times or more, is a bit-error copy of it and is
     * folded in (two real meters can differ by a bit, so an id heard more than once stays its own).
     */
    private fun foldGridstream() {
        val gs = devMap.values.filter { it.net == GRIDSTREAM }.sortedByDescending { it.frames }
        for (small in gs.reversed()) {
            if (small.frames > 1) continue
            val big = gs.firstOrNull { it.id != small.id && it.frames >= 3 && java.lang.Long.bitCount(it.id xor small.id) <= 2 } ?: continue
            val keep = devMap["$GRIDSTREAM/${big.id}"] ?: continue
            if (devMap["$GRIDSTREAM/${small.id}"] == null) continue
            keep.frames += small.frames
            keep.talksTo = keep.talksTo + small.talksTo
            keep.addressed += small.addressed
            keep.firstMs = min(keep.firstMs, small.firstMs)
            val votes = keep.wanVotes.toMutableMap()
            for ((k, v) in small.wanVotes) votes[k] = (votes[k] ?: 0) + v
            keep.wanVotes = votes
            devMap["$GRIDSTREAM/${big.id}"] = keep
            devMap.remove("$GRIDSTREAM/${small.id}")
            linkSet = LinkedHashSet(linkSet.map { l ->
                val a = if (l.a == small.id) big.id else l.a; val b = if (l.b == small.id) big.id else l.b
                MeshLink(min(a, b), max(a, b))
            }.filter { it.a != it.b })
        }
    }

    /** Publish the tables now (they otherwise refresh at most four times a second). */
    fun flush() {
        foldGridstream()
        // a network needs a real share of the traffic: a few frames of the busy one read off by a bit or two are not one
        val top = netMap.values.maxOfOrNull { it.frames } ?: 0
        val nets = netMap.values.filter { it.sync == GRIDSTREAM || it.frames >= 20 || (it.frames >= MIN_FRAMES && it.frames * 50 >= top) }
            .sortedByDescending { it.frames }.map { it.copy() }
        _nets.value = nets
        _bursts.value = count
        _links.value = linkSet.toList()
        // a card for: every ERT meter; a Gridstream meter heard twice, or addressed by others three times (one
        // reference alone is as likely a bit error in an id); a device of a network that is really there
        val shown = nets.map { it.sync }.toSet()
        _devices.value = devMap.values.filter { d ->
            when (d.net) {
                ERT -> true
                GRIDSTREAM -> d.frames >= 2 || d.addressed >= 3
                else -> d.frames >= 5 && shown.contains(d.net)
            }
        }.sortedWith(compareByDescending<MeshDevice> { it.lastMs }.thenBy { it.id }).map { it.copy() }
    }

    companion object {
        const val RATE = 4_194_304
        /** The wide span Meters opens at where the radio can take it. */
        const val WIDE = 19_200_000
        val BAUDS = intArrayOf(9600, 19200, 38400)
        const val GRIDSTREAM = -1
        /** Debug: where Gridstream frames that end early are described (tests and tools). */
        @Volatile var trace: ((String) -> Unit)? = null
        /** ERT meters (Itron SCM / SCM+ / IDM) share the device list, decoded by ErtDecoder on the same samples. */
        const val ERT = -2
        /** Utility seeds for Gridstream's CRC (CoServ, Oncor), from the RECESSIM wiki. */
        val GS_SEEDS = intArrayOf(0x45F8, 0x5FD6)
        private const val R900_SYNC = 0b00000000000000001110010101100100L
        /** Networks shown once they have this many frames; fewer is most likely a burst with bit errors. */
        const val MIN_FRAMES = 3

        /** Swift's rounding (half away from zero). */
        fun rnd(x: Double): Double = if (x >= 0) kotlin.math.floor(x + 0.5) else -kotlin.math.floor(-x + 0.5)

        fun gridstreamStart(bits: IntArray): Int? {
            // 0x00 then 0xFF, each as start 0 + 8 bits + stop 1 (v5 breaks the second start bit to a 1)
            val v4 = intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1)
            val v5 = intArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
            if (bits.size < 40) return null
            for (p in 8 until bits.size - 20) {
                // right after the 0xAA preamble, which ends on a 0
                if (bits[p - 1] != 0 || bits[p - 2] != 1 || bits[p - 3] != 0 || bits[p - 4] != 1) continue
                var m4 = true; var m5 = true
                for (k in 0 until 20) { if (bits[p + k] != v4[k]) m4 = false; if (bits[p + k] != v5[k]) m5 = false; if (!m4 && !m5) break }
                if (m4 || m5) return p
            }
            return null
        }

        /** CRC-16/CCITT over data[from, to). */
        fun crcCcitt(data: List<Int>, from: Int, to: Int, seed: Int): Int {
            var c = seed and 0xFFFF
            for (i in from until to) {
                c = c xor ((data[i] and 0xFF) shl 8)
                for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF
            }
            return c
        }

        fun syncName(s: Int): String = if (s == GRIDSTREAM) "Gridstream" else "%06X".format(s)

        /** The least edit distance between [p] and any stretch of [t] (Sellers' approximate substring match). */
        fun editIn(p: IntArray, t: List<Int>): Int {
            var prev = IntArray(t.size + 1)
            for (i in 1..p.size) {
                val cur = IntArray(t.size + 1); cur[0] = i
                for (j in 1..t.size) cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (p[i - 1] == t[j - 1]) 0 else 1)
                prev = cur
            }
            return prev.min()
        }
        /** A "sync word" that is mostly alternating bits is the preamble read a few bits late, not a network. */
        fun isPreamble(sync: Int): Boolean = sync >= 0 && Integer.bitCount((sync xor (sync shr 1)) and 0x7F_FFFF) >= 18

        /** Gridstream LPP opcodes, as the wiki names them (2X tickle / keep-alive, 3X sync, 51 / 55 link info). */
        fun opcode(o: Int): String = when (o) {
            0x51 -> "link info"
            0x55 -> "link info request"
            0x22, 0x52 -> "route record"
            in 0x20..0x2F -> "keep-alive"
            in 0x30..0x3F -> "sync"
            else -> "opcode"
        }

        /** The node status word: a483 on every meter seen so far (network-wide), so anything else is worth a look. */
        fun statusWord(a: Int, b: Int): String {
            val v = (a shl 8) or b
            return "%04X".format(v) + when {
                v == 0xA483 -> " (network normal)"
                v and 0xFF00 == 0xA400 -> " (network A4 · node flags %02X)".format(b)
                else -> ""
            }
        }

        /** The device / firmware descriptor, the XX 32 0Y group the wiki sees on every meter. */
        fun descriptor(x: Int, y: Int, z: Int): String = "%02X %02X %02X (class %02X · model %02X · rev %d)".format(x, y, z, x, y, z)

        private fun u32(b: List<Int>, at: Int): Long { var v = 0L; for (i in 0 until 4) v = (v shl 8) or b[at + i].toLong(); return v }
        private fun hex(b: List<Int>, from: Int, to: Int): String { val s = StringBuilder(); for (i in from until to) s.append("%02X".format(b[i])); return s.toString() }

        /** Distance between two 16-bit clock values, either way round. */
        fun wrap16(d: Int): Int { val m = d and 0xFFFF; return min(m, 65536 - m) }

        /** The log line: the frame decoded as far as its layout is known, raw hex only for what is not. */
        fun line(f: MeshFrame): String {
            val b = f.bytes
            fun hx(from: Int, n: Int = Int.MAX_VALUE): String = b.drop(from).take(n).joinToString(" ") { "%02X".format(it) }
            val head = "%.3f +%d dB ".format(f.hz / 1e6, f.snrDb)
            if (f.sync == GRIDSTREAM) {
                if (b.size >= 37 && b[2] == 0x2A && b[3] == 0x55 && b[6] == 0x30) {
                    val id = u32(b, 26)
                    val up = u32(b, 20).toInt()
                    val pos = GridstreamWan.decode(GridstreamWan.value(b, 13))?.let { " · %.5f, %.5f".format(it.lat, it.lon) } ?: ""
                    return head + "GRIDSTREAM beacon %08X · up %dd %02dh".format(id, up / 86400, up / 3600 % 24) + pos
                }
                if (b.size >= 15 && b[2] == 0x2A && b[3] == 0xD5) {
                    val dst = u32(b, 7); val src = u32(b, 11)
                    return head + "GRIDSTREAM %08X → %08X · op %02X · ".format(src, dst, b[6]) + hx(min(b.size, 15), 10)
                }
                if (b.size >= 6 && b[2] <= 3 && (b[3] == 0x81 || b[3] == 0x85)) {
                    return head + "GRIDSTREAM power usage report (DCW) · type %02X/%02X · seq %02X · ".format(b[2], b[3], b[4]) + hx(5, 24)
                }
                if (b.size >= 6 && b[2] == 0x2A && b[3] == 0xD2) {
                    return head + "GRIDSTREAM link frame D2 · len %d · ".format(b[4]) + hx(5, 20)
                }
                return head + "GRIDSTREAM " + hx(0, 16)
            }
            if (f.sync == 0xF6E56B && b.size >= 9 && b[1] == 0xF0) {
                return head + "%s node %02X · ID %02X%02X%02X · clock %02X%02X · ".format(syncName(f.sync), b[0], b[2], b[3], b[4], b[5], b[6]) + hx(7)
            }
            if (f.sync == 0xF6E56B && b.size >= 4) {
                return head + "%s node %02X · clock %02X%02X · check %02X".format(syncName(f.sync), b[0], b[1], b[2], b[3]) + if (b.size > 4) " · " + hx(4) else ""
            }
            return head + syncName(f.sync) + " · " + hx(0, 20) + if (b.size > 20) " …" else ""
        }
    }
}
