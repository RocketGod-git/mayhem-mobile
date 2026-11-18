package com.rocketgod.mayhem.core.r433

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Z-Wave (ITU-T G.9959) for Devices and the Analyzer. R1 9.6 kb/s Manchester and R2 40 kb/s NRZ on 908.42 MHz,
 * R3 100 kb/s on 916.00 MHz (US). FSK is read off the discriminator, sliced at each rate in both polarities, found by
 * its 0x55 preamble and 0xF0 start of frame, and kept only when its frame check passes: the 8-bit XOR checksum
 * seeded 0xFF for R1/R2, CRC-16-CCITT seeded 0x1D0F for R3. Twin of web/src/dsp/r433/zwave.ts.
 */
val ZW_BAUD = mapOf("R1" to 9600, "R2" to 40000, "R3" to 100000)

/** A US channel and the rates it carries. */
class ZwChannelDef(val hz: Long, val rates: List<String>)
val ZW_CHANNELS = listOf(ZwChannelDef(908_420_000L, listOf("R1", "R2")), ZwChannelDef(916_000_000L, listOf("R3")))

fun zwChecksum(b: IntArray, n: Int = b.size): Int {
    var c = 0xFF
    for (i in 0 until n) c = c xor b[i]
    return c
}

fun zwCrc16(b: IntArray, n: Int = b.size): Int {
    var c = 0x1D0F
    for (i in 0 until n) {
        c = c xor (b[i] shl 8)
        for (k in 0 until 8) c = if (c and 0x8000 != 0) ((c shl 1) xor 0x1021) and 0xFFFF else (c shl 1) and 0xFFFF
    }
    return c
}

class ZwFrame(
    val rate: String, val home: String, val src: Int, val dst: Int,
    /** The two frame control bytes. */
    val fc: Int,
    /** Header type: 1 singlecast, 2 multicast, 3 acknowledgment, 8 routed. */
    val type: Int,
    val ackReq: Boolean, val routed: Boolean, val lowPower: Boolean, val seq: Int, val len: Int,
    val payload: IntArray,
    /** The whole frame, check included. */
    val bytes: IntArray,
)

/** A frame as heard: where, how strong, and when in radio time (ms since the receiver started). */
class ZwHeard(val f: ZwFrame, val mhz: Double, val snr: Double, val t: Double)

private fun hex2(v: Int) = "%02X".format(v)

/** A frame from its bytes (home ID first), or null when the length or the check is wrong. */
fun zwParse(by: IntArray, rate: String): ZwFrame? {
    if (by.size < 10) return null
    val l = by[7]
    val crc = rate == "R3"
    if (l < (if (crc) 11 else 10) || l > by.size || l > 170) return null
    if (crc) { if (zwCrc16(by, l - 2) != ((by[l - 2] shl 8) or by[l - 1])) return null }
    else if (zwChecksum(by, l - 1) != by[l - 1]) return null
    val bytes = by.copyOf(l)
    val f0 = by[5]; val f1 = by[6]
    return ZwFrame(rate, hex2(by[0]) + hex2(by[1]) + hex2(by[2]) + hex2(by[3]), by[4], by[8],
        (f0 shl 8) or f1, f0 and 0x0F, f0 and 0x40 != 0, f0 and 0x80 != 0, f0 and 0x20 != 0, f1 and 0x0F,
        l, bytes.copyOfRange(9, l - (if (crc) 2 else 1)), bytes)
}

fun zwHex(b: IntArray): String = b.joinToString(" ") { hex2(it) }

/** Command class names from the published Z-Wave command class specification. */
private val CC = mapOf(
    0x00 to "NOP", 0x20 to "BASIC", 0x25 to "SWITCH BINARY", 0x26 to "SWITCH MULTILEVEL", 0x27 to "SWITCH ALL", 0x2B to "SCENE ACTIVATION",
    0x30 to "SENSOR BINARY", 0x31 to "SENSOR MULTILEVEL", 0x32 to "METER", 0x40 to "THERMOSTAT MODE", 0x43 to "THERMOSTAT SETPOINT",
    0x5A to "DEVICE RESET LOCALLY", 0x5B to "CENTRAL SCENE", 0x5E to "ZWAVEPLUS INFO", 0x60 to "MULTI CHANNEL", 0x62 to "DOOR LOCK",
    0x6C to "SUPERVISION", 0x70 to "CONFIGURATION", 0x71 to "NOTIFICATION", 0x72 to "MANUFACTURER SPECIFIC", 0x73 to "POWERLEVEL",
    0x80 to "BATTERY", 0x84 to "WAKE UP", 0x85 to "ASSOCIATION", 0x86 to "VERSION", 0x8E to "MULTI CHANNEL ASSOCIATION",
    0x98 to "SECURITY", 0x9F to "SECURITY 2",
)
/** SET 1, GET 2, REPORT 3: the commands these classes share. */
private val SGR = mapOf(1 to "SET", 2 to "GET", 3 to "REPORT")
private val SGR_CC = setOf(0x20, 0x25, 0x26)

class ZwMeaning(val cc: String, val cmd: String, val value: Int?, val text: String)

fun zwValue(v: Int): String = if (v == 0) "off" else if (v == 0xFF) "on" else if (v <= 99) "level $v" else "0x%X".format(v)

/** What a frame says, in words. */
fun zwDescribe(f: ZwFrame): ZwMeaning {
    if (f.type == 3) return ZwMeaning("", "ACK", null, "ACK")
    val pre = if (f.type == 2) "multicast " else ""
    if (f.routed) return ZwMeaning("", "ROUTED", null, "${pre}routed frame")
    val p = f.payload
    if (p.isEmpty()) return ZwMeaning("", "", null, "${pre}no payload")
    val name = CC[p[0]] ?: "class 0x${hex2(p[0])}"
    if (p[0] == 0x00) return ZwMeaning("NOP", "", null, "${pre}NOP")
    if (p.size < 2) return ZwMeaning(name, "", null, pre + name)
    var cmd = "0x${hex2(p[1])}"; var value: Int? = null
    if (p[0] in SGR_CC && SGR[p[1]] != null) {
        cmd = SGR.getValue(p[1])
        if ((p[1] == 1 || p[1] == 3) && p.size >= 3) value = p[2]
    } else if (p[0] == 0x30 && (p[1] == 2 || p[1] == 3)) {
        cmd = SGR.getValue(p[1])
        if (p[1] == 3 && p.size >= 3) value = p[2]
    } else if (p[0] == 0x80 && (p[1] == 2 || p[1] == 3)) {
        cmd = SGR.getValue(p[1])
        if (p[1] == 3 && p.size >= 3) value = p[2]
    } else if (p[0] == 0x84 && p[1] == 7) cmd = "NOTIFICATION"
    else if (p[0] == 0x84 && p[1] == 8) cmd = "NO MORE INFORMATION"
    val vtext = if (value == null) "" else if (p[0] == 0x80) " ${if (value == 0xFF) "low" else "$value%"}" else " $value (${zwValue(value)})"
    return ZwMeaning(name, cmd, value, "$pre$name $cmd$vtext")
}

private fun median(v: FloatArray): Float {
    val s = v.copyOf(); s.sort()
    return if (s.isNotEmpty()) s[s.size shr 1] else 0f
}

/** Every frame start in [bits]: the bit index just past each preamble and 0xF0. */
private fun sofs(bits: IntArray, nb: Int): List<Int> {
    val out = ArrayList<Int>()
    var w = 0
    for (i in 0 until nb) {
        w = ((w shl 1) or bits[i]) and 0xFFFFFF
        if (i >= 23 && w == 0x5555F0) out.add(i + 1)
    }
    return out
}

private fun bytesAt(bits: IntArray, nb: Int, j0: Int): IntArray {
    val by = ArrayList<Int>()
    var j = j0
    while (j + 8 <= nb && by.size < 170) {
        var v = 0
        for (k in 0 until 8) v = (v shl 1) or bits[j + k]
        by.add(v); j += 8
    }
    return by.toIntArray()
}

class ZwFound(val frame: ZwFrame, val at: Int)

/**
 * Every frame in a burst of complex samples at [fs], trying each rate in turn: the discriminator less its median,
 * a moving average 0.6 of a symbol long, six sampling phases, both polarities, and for R1 both Manchester pairings.
 * [ZwFound.at] is where each frame starts, in samples.
 */
fun zwSliceAll(re: FloatArray, im: FloatArray, n: Int, fs: Double, rates: List<String>): List<ZwFound> {
    val out = ArrayList<ZwFound>()
    if (n < 16) return out
    val seen = HashSet<String>()
    val d = FloatArray(n - 1)
    for (i in 0 until n - 1) {
        val a = re[i + 1].toDouble() * re[i] + im[i + 1].toDouble() * im[i]
        val b = im[i + 1].toDouble() * re[i] - re[i + 1].toDouble() * im[i]
        d[i] = atan2(b, a).toFloat()
    }
    val med = median(d)
    for (i in d.indices) d[i] = d[i] - med
    for (rate in rates) {
        val manch = rate == "R1"
        val sps = fs / ZW_BAUD.getValue(rate) * (if (manch) 0.5 else 1.0)
        if (sps < 1.2) continue
        val w = max(1, floor(sps * 0.6).toInt()); val h = (w - 1) shr 1
        val ds = FloatArray(d.size)
        for (i in d.indices) {
            var s = 0.0
            for (m in 0 until w) { val j = i + h - m; if (j >= 0 && j < d.size) s += d[j] }
            ds[i] = (s / w).toFloat()
        }
        val nChips = max(0, ceil((d.size - sps) / sps).toInt())
        val chips = IntArray(nChips); val bits = IntArray(nChips)
        for (k in 0 until 6) {
            val ph = k * sps / 6
            var nc = 0
            var t = 0.0
            while (t < d.size - sps) { if (nc < nChips) chips[nc] = if (ds[floor(ph + t).toInt()] > 0) 1 else 0; nc++; t += sps }
            nc = min(nc, nChips)
            val cands = ArrayList<Triple<IntArray, Int, Int>>()
            if (manch) {
                for (o in 0..1) {
                    val b = IntArray(nc shr 1)
                    var nb = 0
                    var i = o
                    while (i < nc - 1) { b[nb++] = if (chips[i] == 1 && chips[i + 1] == 0) 1 else 0; i += 2 }
                    cands.add(Triple(b, nb, o))
                }
            } else cands.add(Triple(chips.copyOf(nc), nc, 0))
            for ((b0, nb, o) in cands) {
                for (inv in 0..1) {
                    for (i in 0 until nb) bits[i] = b0[i] xor inv
                    for (j in sofs(bits, nb)) {
                        val f = zwParse(bytesAt(bits, nb, j), rate) ?: continue
                        val id = zwHex(f.bytes)
                        if (!seen.add(id)) continue
                        val at = Math.round(ph + (if (manch) 2 * (j - 24) + o else j - 24) * sps).toInt()
                        out.add(ZwFound(f, at))
                    }
                }
            }
        }
        if (out.isNotEmpty()) break
    }
    return out.sortedBy { it.at }
}

/** The first frame in a burst, or null. */
fun zwSlice(re: FloatArray, im: FloatArray, n: Int, fs: Double, rates: List<String>): ZwFrame? = zwSliceAll(re, im, n, fs, rates).firstOrNull()?.frame

/** Every Z-Wave frame in a captured burst (interleaved signed I/Q bytes at [rate]), at any of the three rates. */
fun zwMatches(iq: ByteArray, n: Int, rate: Double): List<ZwFrame> {
    if (rate < 150_000 || n < 64) return emptyList()
    val re = FloatArray(n); val im = FloatArray(n)
    for (i in 0 until n) { re[i] = iq[2 * i].toFloat(); im[i] = iq[2 * i + 1].toFloat() }
    return zwSliceAll(re, im, n, rate, listOf("R2", "R3", "R1")).map { it.frame }
}

private const val FS_TARGET = 400_000.0
private const val HALF_BW = 150_000.0
private const val LIT = 12.0
private const val MIN_BURST_S = 0.0015
private const val ZW_MAX_BURST_S = 0.3
private const val QUIET_S = 0.0003
private const val PAD = 200

/** One Z-Wave channel inside the span: mixed down, filtered, decimated to about 400 kS/s and watched for bursts. */
private class ZwChannel(val hz: Long, off: Double, val rates: List<String>, rate: Int, private val onFrame: (ZwHeard) -> Unit, private val clock: () -> Double) {
    val fs: Double
    private val d1: Int = max(1, rate / 2_000_000)
    private val d2: Int
    private val taps: FloatArray
    private val hr: FloatArray; private val hi: FloatArray; private var hp = 0
    private var b1r = 0.0; private var b1i = 0.0; private var b1n = 0; private var c2 = 0
    private var cr = 1.0; private var ci = 0.0; private val sr: Double; private val si: Double; private var nco = 0
    private val ring: Int; private val rr: FloatArray; private val ri: FloatArray; private var w = 0
    private var ps = 0.0; private var floor = 0.0; private var warm = 0
    private var inBurst = false; private var start = 0; private var end = 0; private var quiet = 0; private var endAt = -1; private var sum = 0.0; private var cnt = 0

    init {
        val r1 = rate.toDouble() / d1
        d2 = max(1, Math.round(r1 / FS_TARGET).toInt())
        fs = r1 / d2
        val l = max(15, min(161, Math.round(3.3 * r1 / 100_000).toInt() or 1))
        taps = FloatArray(l)
        val fc = min(HALF_BW, 0.45 * fs) / r1
        var s = 0.0
        for (i in 0 until l) {
            val x = i - (l - 1) / 2.0
            val sinc = if (x == 0.0) 2 * fc else sin(2 * PI * fc * x) / (PI * x)
            taps[i] = (sinc * (0.54 - 0.46 * cos(2 * PI * i / (l - 1)))).toFloat()
            s += taps[i]
        }
        for (i in 0 until l) taps[i] = (taps[i] / s).toFloat()
        hr = FloatArray(2 * l); hi = FloatArray(2 * l)
        val step = -2 * PI * off / rate
        sr = cos(step); si = sin(step)
        ring = 1 shl ceil(ln(fs * (ZW_MAX_BURST_S + 0.05)) / ln(2.0)).toInt()
        rr = FloatArray(ring); ri = FloatArray(ring)
    }

    /** Offset-128 interleaved I/Q bytes, [len] of them. */
    fun process(iq: ByteArray, len: Int) {
        val l = taps.size; val taps = taps; val hr = hr; val hi = hi
        var k = 0
        while (k + 1 < len) {
            val i = ((iq[k].toInt() and 0xff) - 128).toDouble(); val q = ((iq[k + 1].toInt() and 0xff) - 128).toDouble()
            k += 2
            b1r += i * cr - q * ci; b1i += i * ci + q * cr
            val t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t
            if (++nco >= 4096) { nco = 0; val m = hypot(cr, ci); cr /= m; ci /= m }
            if (++b1n < d1) continue
            val xr = (b1r / d1).toFloat(); val xi = (b1i / d1).toFloat()
            b1r = 0.0; b1i = 0.0; b1n = 0
            hr[hp] = xr; hi[hp] = xi; hr[hp + l] = xr; hi[hp + l] = xi
            hp = (hp + 1) % l
            if (++c2 < d2) continue
            c2 = 0
            var yr = 0.0; var yi = 0.0
            var p = hp
            for (j in 0 until l) { yr += taps[j].toDouble() * hr[p]; yi += taps[j].toDouble() * hi[p]; p++ }
            sample(yr, yi)
        }
    }

    private fun sample(yr: Double, yi: Double) {
        val m = ring - 1; val idx = w
        rr[idx and m] = yr.toFloat(); ri[idx and m] = yi.toFloat(); w++
        val p = yr * yr + yi * yi
        ps += (p - ps) / 32
        if (warm < 2000) {
            if (++warm > 64) floor = if (floor != 0.0) floor + (ps - floor) / 64 else ps
            if (floor < 1e-6) floor = 1e-6
            return
        }
        if (endAt >= 0) {
            if (idx >= endAt) finish(idx)
            else return
        }
        if (!inBurst) {
            if (ps > floor * LIT) { inBurst = true; start = idx; quiet = 0; sum = 0.0; cnt = 0 }
            else floor += (ps - floor) / (if (ps < floor) 64 else 4096)
            if (floor < 1e-6) floor = 1e-6
        }
        if (inBurst) {
            sum += p; cnt++
            if (ps < floor * LIT * 0.5) { if (++quiet > fs * QUIET_S) { inBurst = false; endAt = idx + PAD; end = idx - quiet } }
            else quiet = 0
            if (inBurst && idx - start > fs * ZW_MAX_BURST_S) { inBurst = false; floor = ps }
        }
    }

    private fun finish(idx: Int) {
        endAt = -1
        val a = start; val b = end
        if ((b - a) < fs * MIN_BURST_S) return
        val from = max(max(a - PAD, idx - ring + 1), 0); val n = idx - from
        val re = FloatArray(n); val im = FloatArray(n); val m = ring - 1
        for (i in 0 until n) { re[i] = rr[(from + i) and m]; im[i] = ri[(from + i) and m] }
        val found = zwSliceAll(re, im, n, fs, rates)
        if (found.isEmpty()) return
        val snr = 10 * log10(max(1e-9, sum / max(1, cnt)) / floor)
        for (x in found) onFrame(ZwHeard(x.frame, hz / 1e6, Math.round(snr * 10) / 10.0, clock()))
    }
}

/** Every US Z-Wave channel that falls inside the span, listened to at once. */
class ZWaveRx(private val onFrame: (ZwHeard) -> Unit) {
    private var chans: List<ZwChannel> = emptyList()
    private var rate = 0; private var center = 0L
    private var samples = 0L
    var frames = 0
        private set

    /** Radio time in ms since the receiver started. */
    fun airMs(): Double = if (rate != 0) samples.toDouble() / rate * 1000 else 0.0

    fun configure(rate: Int, center: Long) {
        if (rate == this.rate && center == this.center) return
        this.rate = rate; this.center = center
        chans = emptyList()
        if (rate == 0 || center == 0L) return
        val out = ArrayList<ZwChannel>()
        for (c in ZW_CHANNELS) {
            val off = (c.hz - center).toDouble()
            if (abs(off) + HALF_BW < rate / 2.0) out.add(ZwChannel(c.hz, off, c.rates, rate, { f -> frames++; onFrame(f) }, { airMs() }))
        }
        chans = out
    }

    /** Which channels are being listened to, MHz. */
    fun listening(): List<Double> = chans.map { it.hz / 1e6 }

    /** Offset-128 interleaved I/Q bytes, [len] of them. */
    fun process(iq: ByteArray, len: Int) {
        for (c in chans) c.process(iq, len)
        samples += len shr 1
    }
}

class ZwNode(
    val id: Int, val controller: Boolean,
    /** The rate and channel of its latest frame, and every rate it has been heard on. */
    val rate: String, val mhz: Double, val rates: List<String>,
    val lastSeen: Long,
    /** SNR of the node's own last frame, dB; null when only frames sent to it were heard. */
    val snr: Double?,
    val sent: Int, val got: Int,
    /** Seconds between polls, measured from repeats; null until two have been heard. */
    val poll: Double?,
    val last: String,
    /** The last BASIC (or switch) value it reported, or was set to. */
    val value: Int?,
)
class ZwLink(val from: Int, val to: Int, val frames: Int, val last: String)
class ZwNet(val home: String, val nodes: List<ZwNode>, val links: List<ZwLink>, val frames: Int, val channels: List<Double>)

/** A gap longer than this between frames for one node starts a new exchange. */
private const val EXCHANGE_GAP_MS = 5000.0

/** The Z-Wave networks heard: each home ID, its nodes, and who talks to whom. */
class ZWaveNets {
    private class Node(val id: Int, var rate: String, var mhz: Double, var lastSeen: Long) {
        var controller = false; val rates = ArrayList<String>(); var snr: Double? = null; var sent = 0; var got = 0
        var poll: Double? = null; var last = ""; var value: Int? = null; val starts = ArrayList<Double>(); var lastT = Double.NEGATIVE_INFINITY
    }
    private class Link(val from: Int, val to: Int) { var frames = 0; var last = "" }
    private class Net {
        val nodes = LinkedHashMap<Int, Node>(); val links = LinkedHashMap<String, Link>(); var frames = 0
        val channels = LinkedHashSet<Double>(); val requesters = HashSet<Int>()
    }
    private val nets = HashMap<String, Net>()

    fun clear() = nets.clear()
    val size: Int get() = nets.size

    /** Add one frame; [wall] is when it was heard (ms, for the screen), its radio time (ms) times the intervals. */
    fun add(h: ZwHeard, wall: Long): ZwNet {
        val f = h.f
        val n = nets.getOrPut(f.home) { Net() }
        n.frames++; n.channels.add(h.mhz)
        val m = zwDescribe(f)
        fun node(id: Int): Node = n.nodes.getOrPut(id) { Node(id, f.rate, h.mhz, wall) }
        fun seenOn(x: Node) { x.rate = f.rate; x.mhz = h.mhz; x.lastSeen = wall; if (f.rate !in x.rates) { x.rates.add(f.rate); x.rates.sort() } }
        val s = node(f.src)
        s.sent++; s.snr = h.snr; seenOn(s)
        if (f.type != 3 && (m.cmd == "GET" || m.cmd == "SET")) n.requesters.add(f.src)
        if (f.type != 3 && m.cmd != "GET") s.last = m.text
        if (m.cmd == "REPORT" && m.value != null) s.value = m.value
        if (f.dst != 0xFF && f.type != 2) {
            val d = node(f.dst)
            d.got++; seenOn(d)
            if (m.cmd == "SET" && m.value != null) d.value = m.value
            if (f.type != 3 && f.payload.isNotEmpty() && f.src in n.requesters) {
                if (h.t - d.lastT > EXCHANGE_GAP_MS) { d.starts.add(h.t); if (d.starts.size > 16) d.starts.removeAt(0) }
                d.lastT = h.t
            }
            val l = n.links.getOrPut("${f.src}>${f.dst}") { Link(f.src, f.dst) }
            l.frames++; l.last = m.text
        }
        for (x in n.nodes.values) {
            x.controller = if (n.requesters.isNotEmpty()) x.id in n.requesters else x.id == 1
            if (x.starts.size >= 2 && !x.controller) {
                val g = (1 until x.starts.size).map { x.starts[it] - x.starts[it - 1] }.sorted()
                val mid = if (g.size and 1 == 1) g[g.size shr 1] else (g[g.size / 2 - 1] + g[g.size / 2]) / 2
                x.poll = Math.round(mid / 100) / 10.0
            }
        }
        return snapshot(f.home)!!
    }

    fun snapshot(home: String): ZwNet? {
        val n = nets[home] ?: return null
        val nodes = n.nodes.values.map { x -> ZwNode(x.id, x.controller, x.rate, x.mhz, x.rates.toList(), x.lastSeen, x.snr, x.sent, x.got, x.poll, x.last, x.value) }
            .sortedWith(compareBy<ZwNode>({ if (it.controller) 0 else 1 }, { it.id }))
        return ZwNet(home, nodes, n.links.values.map { ZwLink(it.from, it.to, it.frames, it.last) }, n.frames, n.channels.sorted())
    }
}
