package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Motorola Type II (SmartNet, SmartZone) control channels: the outbound signaling words (OSWs) a site sends without a
 * break, 3600 bits a second, two-level FSK. The same as the web app's smartnet.ts.
 *
 * Each OSW is 84 bits: the sync 0xAC, then 76 bits interleaved 19 by 4, which carry a rate 1/2 convolutional code
 * (each data bit, then that bit added to the one before it) of 38 bits: 27 data bits (a 16-bit address, a flag, a
 * 10-bit command), a 10-bit check (the data times x^10 modulo x^10 + x^6 + x^3 + x + 1, plus 0x06C) and a zero tail.
 * The address and command are read through masks (0xCC38 and 0x0D5: the data bits inverted, then 0x33C7 and 0x32A)
 * and the flag as received. The check polynomial, its constant and the masks were confirmed on our own recording
 * (2026-11-20 roof, 939.475 MHz): every word that passed its convolutional code without a correction agrees with them.
 *
 * Words read here, and only these:
 *  - 0x308 then 0x30B whose address is 0x28xx: the system ID (the first word's address) and the control channel's
 *    number (the second word's low 10 bits).
 *  - 0x308 then a channel number (0 to 0x2F7): a grant, from the first word's unit to the second word's talkgroup.
 *  - a channel number alone: the update of a call already on that channel.
 *  - 0x2F8: idle.
 * Everything else is shown as its raw address, flag and command.
 */
data class Osw(val addr: Int, val flag: Int, val cmd: Int)

object SmartNet {
    const val SYNC = 0xac
    const val BITS = 84
    const val BAUD = 3600
    private const val ADDR_MASK = 0xcc38
    private const val CMD_MASK = 0x0d5

    /** Talkgroup words carry flag 0: every talkgroup granted in our recording did, several radios taking turns on each. */
    fun group(o: Osw): Boolean = o.flag == 0
    /** The talkgroup of a group address (its low four bits are status bits), and those status bits. */
    fun tgOf(addr: Int): Int = addr and 0xfff0
    fun tgStatus(addr: Int): Int = addr and 0xf
    /** A channel number, not a command. [upper800]: also the channel numbers above 0x2F7 that 800 MHz plans use (0x32F-0x33F, 0x3BE, 0x3C1-0x3FE): on other bands those are commands. Live traffic puts the commands in the gaps between them (0x308-0x32E, 0x340, 0x3A0, 0x3BF, 0x3C0). */
    fun isChannel(cmd: Int, upper800: Boolean = false): Boolean = cmd < 0x2f8 || (upper800 && (cmd in 0x32f..0x33f || cmd == 0x3be || cmd in 0x3c1..0x3fe))

    /** The 10-bit check of 27 data bits (as sent: before the inversion is undone). */
    fun crc(v: Int): Int {
        var r = 0
        for (b in 26 downTo 0) { val fb = ((v ushr b) and 1) xor ((r shr 9) and 1); r = (r shl 1) and 0x3ff; if (fb != 0) r = r xor 0x04b }
        return r xor 0x06c
    }

    /**
     * One frame's 76 soft bits (positive is a 1, polarity already applied) to an OSW, or null when its check fails. The
     * convolutional code is decoded by a two-state Viterbi on the soft values, ending on the zero tail.
     */
    fun decode(soft: FloatArray): Osw? {
        val d = FloatArray(76)
        for (i in 0 until 19) for (j in 0 until 4) d[i * 4 + j] = soft[j * 19 + i]
        var m0 = 0.0; var m1 = -1e9; val from = IntArray(38 * 2)
        for (k in 0 until 38) {
            val s0 = d[2 * k].toDouble(); val s1 = d[2 * k + 1].toDouble()
            var n0 = -1e18; var n1 = -1e18
            for (p in 0 until 2) {
                val mp = if (p == 1) m1 else m0
                for (b in 0 until 2) {
                    val mm = mp + (if (b == 1) s0 else -s0) + (if ((b xor p) == 1) s1 else -s1)
                    if (b == 0) { if (mm > n0) { n0 = mm; from[2 * k] = p } } else if (mm > n1) { n1 = mm; from[2 * k + 1] = p }
                }
            }
            m0 = n0; m1 = n1
        }
        val bits = IntArray(38); var st = 0
        for (k in 37 downTo 0) { bits[k] = st; st = from[2 * k + st] }
        var v = 0; var c = 0
        for (k in 0 until 27) v = v * 2 + bits[k]
        for (k in 27 until 37) c = c * 2 + bits[k]
        if (crc(v) != c) return null
        return Osw((v ushr 11) xor ADDR_MASK, (v ushr 10) and 1, (v and 0x3ff) xor CMD_MASK)
    }

    /** The air side of an OSW (for the tests' transmitter): the 84 bits as sent, sync first. */
    fun encode(o: Osw): IntArray {
        val v = (((o.addr xor ADDR_MASK) and 0xffff) shl 11) or ((o.flag and 1) shl 10) or ((o.cmd xor CMD_MASK) and 0x3ff); val c = crc(v)
        val data = IntArray(38)
        for (k in 0 until 27) data[k] = (v ushr (26 - k)) and 1
        for (k in 0 until 10) data[27 + k] = (c shr (9 - k)) and 1
        val code = IntArray(76); var p = 0
        for (k in 0 until 38) { code[2 * k] = data[k]; code[2 * k + 1] = data[k] xor p; p = data[k] }
        val out = IntArray(84)
        for (b in 0 until 8) out[b] = (SYNC shr (7 - b)) and 1
        for (i in 0 until 19) for (j in 0 until 4) out[8 + j * 19 + i] = code[i * 4 + j]
        return out
    }

    private fun hx(v: Int, n: Int) = v.toString(16).uppercase().padStart(n, '0')
    fun wordText(o: Osw): String = "${hx(o.addr, 4)} ${o.flag} ${hx(o.cmd, 3)}"
    fun hex(words: List<Osw>): String = words.joinToString(" / ") { wordText(it) }

    /** The channel plans a Type II channel number can be on, by band. */
    class Plan(val id: String, val label: String, val hz: (Int) -> Long)
    /** Channel ranges (first, last, Hz of the first, step): a later range wins where two overlap. */
    private class Range(val a: Int, val b: Int, val base: Long, val step: Long)
    private fun table(rs: List<Range>): (Int) -> Long = { ch ->
        var out = 0L
        for (i in rs.indices.reversed()) { val r = rs[i]; if (ch >= r.a && ch <= r.b) { out = r.base + r.step * (ch - r.a); break } }
        out
    }
    /** The ranges every 800 MHz plan shares, over its own (trunk-recorder's smartnet_parser get_freq). */
    private val TOP_800 = listOf(Range(0x2d0, 0x2f7, 866_000_000L, 25_000L), Range(0x32f, 0x33f, 867_000_000L, 25_000L), Range(0x3c1, 0x3fe, 867_425_000L, 25_000L), Range(0x3be, 0x3be, 868_975_000L, 0L))
    val PLANS = listOf(
        Plan("900", "900 MHz", table(listOf(Range(0, 0x1df, 935_012_500L, 12_500L)))),
        Plan("800", "800 MHz standard", table(listOf(Range(0, 0x2cf, 851_012_500L, 25_000L)) + TOP_800)),
        Plan("800S", "800 MHz splinter", table(listOf(Range(0, 0x257, 851_000_000L, 25_000L), Range(0x258, 0x2cf, 866_012_500L, 25_000L)) + TOP_800)),
        Plan("800R", "800 MHz rebanded", table(listOf(Range(0, 0x1b7, 851_012_500L, 25_000L), Range(0x1b8, 0x22f, 851_025_000L, 25_000L)) + TOP_800)),
    )
    /**
     * How far a control channel may be heard from where a plan puts it and still prove that plan: a radio's own frequency
     * error is a few kHz, and the two closest plans (800 standard and splinter) are 12.5 kHz apart.
     */
    const val PLAN_TOL_HZ = 5_000L
    class Fit(val plan: Plan, val offset: Long)
    /**
     * The plan a control channel proves: the one that puts the channel number the site announces for its own control
     * channel nearest the frequency it is heard on, within [PLAN_TOL_HZ], and the radio's error there (heard minus plan).
     * Plans that put the number on the same frequency agree (the first listed stands); two at the same distance on
     * different frequencies prove nothing. Null when none fits, and grants are shown by channel number.
     */
    fun fitPlan(ccNumber: Int, heardHz: Long, plans: List<Plan> = PLANS): Fit? {
        class Hit(val plan: Plan, val hz: Long, val d: Long)
        val hits = ArrayList<Hit>()
        for (p in plans) {
            val hz = p.hz(ccNumber); val d = abs(heardHz - hz)
            if (hz > 0 && d <= PLAN_TOL_HZ && hits.none { it.hz == hz }) hits.add(Hit(p, hz, d))
        }
        if (hits.isEmpty()) return null
        hits.sortBy { it.d }
        if (hits.size > 1 && hits[1].d == hits[0].d) return null
        return Fit(hits[0].plan, heardHz - hits[0].hz)
    }
    fun provePlan(ccNumber: Int, heardHz: Long): Plan? = fitPlan(ccNumber, heardHz)?.plan

    /** Frequency text: MHz to four places, five when the fifth is not zero (6.25 kHz steps). */
    fun mhz(hz: Long): String { val s = String.format(java.util.Locale.US, "%.5f", Math.round(hz / 10.0) / 1e5); return if (s.endsWith("0")) s.dropLast(1) else s }
    /** kHz text with no trailing zeros: 12.5, 6.25, 25. */
    fun khz(hz: Long): String { val s = String.format(java.util.Locale.US, "%.3f", hz / 1000.0).trimEnd('0'); return s.trimEnd('.') }
    /**
     * A plan given by hand or learned from the air, like trunk-recorder's 400_custom: channels [first] to
     * [first] + (high - base) / step are base + step * (channel - first). Learned plans start at channel 0 and cover all.
     */
    data class Custom(val kind: String, val base: Long, val high: Long, val step: Long, val first: Int)
    fun customPlan(x: Custom): Plan {
        val n = Math.floor((x.high - x.base).toDouble() / x.step + 1e-6).toLong()
        return Plan(x.kind, "${x.kind}: ${mhz(x.base)} + ${khz(x.step)} kHz") { ch -> if (ch >= x.first && ch <= x.first + n) x.base + x.step * (ch - x.first) else 0L }
    }
    /** The highest channel number a Type II word carries (ten bits). */
    const val MAX_CH = 0x3ff
    /**
     * A plan typed in (base MHz, high MHz, spacing kHz, first channel), or null when a number is out of range: base and
     * high 25 to 1300 MHz with high at or above base, spacing 1 to 100 kHz, the first channel a whole number and the last
     * no higher than [MAX_CH].
     */
    fun enteredPlan(baseMhz: Double, highMhz: Double, spacingKhz: Double, first: Double): Custom? {
        if (!listOf(baseMhz, highMhz, spacingKhz, first).all { it.isFinite() }) return null
        if (baseMhz < 25 || baseMhz > 1300 || highMhz < baseMhz || highMhz > 1300 || spacingKhz < 1 || spacingKhz > 100) return null
        if (first < 0 || Math.floor(first) != first) return null
        val base = Math.round(baseMhz * 1e6); val high = Math.round(highMhz * 1e6); val step = Math.round(spacingKhz * 1000)
        if (first + Math.floor((high - base).toDouble() / step + 1e-6) > MAX_CH) return null
        return Custom("entered", base, high, step, first.toInt())
    }
    /** The radio's error as text ('' under 0.1 kHz): "radio 2.1 kHz high". */
    fun offsetText(offset: Long): String {
        val k = Math.round(abs(offset) / 100.0) / 10.0
        return if (k < 0.1) "" else "radio ${String.format(java.util.Locale.US, "%.1f", k)} kHz ${if (offset > 0) "high" else "low"}"
    }
}

/** A grant and a carrier keying up within this long are one call's start. */
const val LEARN_WINDOW_MS = 1_500L
/** Sightings of a channel on one frequency before it counts. */
const val LEARN_SIGHTINGS = 3
/** The channel steps a learned plan may have, and how close the one measured must come. */
val LEARN_STEPS = longArrayOf(5_000, 6_250, 7_500, 12_500, 25_000)
private const val LEARN_STEP_TOL = 300.0

/**
 * A Type II system's channel plan learned from the air, for a control channel no published plan fits (VHF and UHF
 * systems): a grant for channel N followed within [LEARN_WINDOW_MS] by a carrier keying up in the span is a sighting
 * of N there. A channel seen [LEARN_SIGHTINGS] times on the same frequency (within [SmartNet.PLAN_TOL_HZ]) is trusted;
 * two trusted channels give the step (one of [LEARN_STEPS]) and with it every channel. A trusted channel that gives no
 * such step with any other is dropped. The same as the web app's OswLearner.
 */
class OswLearner {
    private class Grant(val ch: Int, val ms: Long)
    class Pin(var hz: Double, var n: Int)
    class Trusted(val ch: Int, val hz: Double, val n: Int)
    class Learned(val base: Long, val step: Long)
    private var grants = ArrayList<Grant>()
    /** Sightings per channel: frequencies (averaged) and how many times each. */
    val pins = LinkedHashMap<Int, MutableList<Pin>>()
    /** Hz of channel 0 and the step, once learned. */
    var plan: Learned? = null; private set
    fun grant(ch: Int, ms: Long) {
        if (plan != null) return
        grants = ArrayList(grants.filter { ms - it.ms <= LEARN_WINDOW_MS && it.ch != ch })
        grants.add(Grant(ch, ms))
    }
    /** A carrier keyed up at [hz]: true when that taught the plan. */
    fun keyUp(hz: Double, ms: Long): Boolean {
        if (plan != null) return false
        val g = grants.filter { ms >= it.ms && ms - it.ms <= LEARN_WINDOW_MS }
        // two channels granted together: which one keyed up is not known
        if (g.size != 1) return false
        grants.remove(g[0])
        return sight(g[0].ch, hz)
    }
    fun sight(ch: Int, hz: Double): Boolean {
        if (plan != null) return false
        val list = pins.getOrPut(ch) { ArrayList() }
        var p = list.find { abs(it.hz - hz) <= SmartNet.PLAN_TOL_HZ }
        if (p != null) { p.hz = (p.hz * p.n + hz) / (p.n + 1); p.n++ } else { p = Pin(hz, 1); list.add(p) }
        return if (p.n == LEARN_SIGHTINGS) solve(ch, p) else false
    }
    /** Each channel's most seen frequency, once seen [LEARN_SIGHTINGS] times. */
    fun trusted(): List<Trusted> {
        val out = ArrayList<Trusted>()
        for ((ch, list) in pins) { val b = list.maxByOrNull { it.n }; if (b != null && b.n >= LEARN_SIGHTINGS) out.add(Trusted(ch, b.hz, b.n)) }
        return out.sortedWith(compareBy<Trusted>({ -it.n }, { it.ch }))
    }
    private fun solve(ch: Int, p: Pin): Boolean {
        val all = trusted(); val others = all.filter { it.ch != ch }
        if (others.isEmpty()) return false
        for (o in others) {
            val raw = (p.hz - o.hz) / (ch - o.ch); val step = LEARN_STEPS.firstOrNull { abs(raw - it) <= LEARN_STEP_TOL } ?: continue
            val base = ((p.hz - step * ch) + (o.hz - step * o.ch)) / 2
            if (base <= 0 || !all.all { abs(base + step * it.ch - it.hz) <= SmartNet.PLAN_TOL_HZ }) continue
            plan = Learned(Math.round(base), step)
            return true
        }
        pins[ch]?.remove(p)
        return false
    }
    /** The plan learned, as a plan over every channel number. */
    fun custom(): SmartNet.Custom? = plan?.let { SmartNet.Custom("learned", it.base, it.base + it.step * SmartNet.MAX_CH, it.step, 0) }
}

/**
 * The OSW receiver on a channel's complex baseband at [fs]: an FM discriminator, a moving average a symbol long,
 * the bit clock pulled to the zero crossings, and every bit position tried for the sync (either polarity). A frame
 * that passes its check holds the search off until its end, so the sync's pattern inside its data does not count.
 */
class OswRx(val fs: Double) {
    /** A word that passed its check, and how many frames on from the last one (1: the very next frame). */
    var onOsw: (o: Osw, gap: Int) -> Unit = { _, _ -> }
    /** Frames that passed their check, and the frames the bit count since the first says were sent. */
    var good = 0; private set
    var expected = 0; private set
    private var pi = 0.0; private var pq = 0.0; private var dc = 0.0; private var ph = 0.0; private var last = 0; private var center = 0.0
    private val sps = fs / SmartNet.BAUD
    private val hist = DoubleArray(max(2, (sps * 0.75).roundToInt())); private var hp = 0; private var hs = 0.0
    private val ring = FloatArray(128); private var n = 0L; private var hold = 0L; private var lastGood = -1L
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        val len = hist.size; val half = sps / 2
        for (k in 0 until m) {
            val i = zi[k].toDouble(); val q = zq[k].toDouble()
            val f = atan2(q * pi - i * pq, i * pi + q * pq); pi = i; pq = q
            hs += f - hist[hp]; hist[hp] = f; if (++hp >= len) hp = 0
            val v = hs / len; dc += (v - dc) / (sps * 200); val x = v - dc
            val sg = if (x > 0) 1 else -1
            if (sg != last) { var e = ph; if (e > half) e -= sps; ph -= 0.08 * e; last = sg }
            val was = ph; ph += 1
            if (was < half && ph >= half) center = x
            if (ph >= sps) { ph -= sps; bit(center) }
        }
    }
    private fun bit(x: Double) {
        val r = ring.size; ring[(n % r).toInt()] = x.toFloat(); n++
        if (n < SmartNet.BITS || n - SmartNet.BITS < hold) return
        val s0 = n - SmartNet.BITS
        var sync = 0; for (b in 0 until 8) sync = (sync shl 1) or (if (ring[((s0 + b) % r).toInt()] > 0) 1 else 0)
        val pol = if (sync == SmartNet.SYNC) 1 else if (sync == (SmartNet.SYNC.inv() and 0xff)) -1 else 0
        if (pol == 0) return
        var e = 0.0; for (b in 8 until SmartNet.BITS) e += abs(ring[((s0 + b) % r).toInt()])
        val sc = pol * 76 / max(e, 1e-9); val soft = FloatArray(76)
        for (b in 0 until 76) soft[b] = (ring[((s0 + 8 + b) % r).toInt()] * sc).toFloat()
        val o = SmartNet.decode(soft) ?: return
        hold = n - 2
        val gap = if (lastGood < 0) 0 else max(1, Math.round((s0 - lastGood).toDouble() / SmartNet.BITS).toInt())
        expected += max(1, gap); good++; lastGood = s0
        onOsw(o, gap)
    }
}

/** A message the OSWs make. [kind]: sysid, grant, update, idle or other. */
class OswEvent(val kind: String, val words: List<Osw>, val sys: Int = 0, val cc: Int = 0, val src: Int = 0, val tg: Int = 0, val group: Boolean = true, val ch: Int = 0)

/** OSWs in the order sent to messages: a 0x308 waits for the word after it. A failed frame between breaks a pair. */
class OswParser {
    /** The control channel proved an 800 MHz plan: its upper channel numbers are channels. */
    var upper800 = false
    private var first: Osw? = null
    /** A frame failed its check: a 0x308 waiting for its second word is dropped. */
    fun lost(): MutableList<OswEvent> { val f = first; first = null; return if (f != null) mutableListOf(OswEvent("other", listOf(f))) else mutableListOf() }
    fun push(o: Osw): List<OswEvent> {
        val out = ArrayList<OswEvent>()
        if (o.cmd == 0x308) { first?.let { out.add(OswEvent("other", listOf(it))) }; first = o; return out }
        val f = first; first = null
        if (f != null) {
            if (o.cmd == 0x30b && (o.addr and 0xfc00) == 0x2800) out.add(OswEvent("sysid", listOf(f, o), sys = f.addr, cc = o.addr and 0x3ff))
            else if (SmartNet.isChannel(o.cmd, upper800)) out.add(OswEvent("grant", listOf(f, o), src = f.addr, tg = o.addr, group = SmartNet.group(o), ch = o.cmd))
            else out.add(OswEvent("other", listOf(f, o)))
            return out
        }
        if (SmartNet.isChannel(o.cmd, upper800)) out.add(OswEvent("update", listOf(o), tg = o.addr, group = SmartNet.group(o), ch = o.cmd))
        else if (o.cmd == 0x2f8) out.add(OswEvent("idle", listOf(o)))
        else out.add(OswEvent("other", listOf(o)))
        return out
    }
}

/**
 * The squelch opens on a block whose noise is under [SQ_OPEN] and stays open [SQ_HANG_BLOCKS] blocks (300 ms) past the
 * last such block, closing at once on a block of bare noise ([SQ_SHUT]: a channel with no carrier reads about 0.3). Loud
 * syllables lift the noise reading too (a clean call has one block in twenty over 0.12), and a block-by-block decision
 * dropped those 20 ms blocks from the middle of words.
 */
const val SQ_OPEN = 0.12
const val SQ_SHUT = 0.25
const val SQ_HANG_BLOCKS = 15

/**
 * Analog FM voice on a channel's complex baseband at [fs] (a Type II voice channel): the discriminator, a 3.4 kHz
 * low-pass, down to 8 kHz, the sub-audible signaling taken out below 300 Hz, and the 6 dB an octave pre-emphasis taken
 * back. 20 ms blocks come out with [open]: the noise above the voice band says whether a carrier is there.
 */
class FmVoice(val fs: Double) {
    var onPcm: (pcm: FloatArray, open: Boolean) -> Unit = { _, _ -> }
    private var pi = 0.0; private var pq = 0.0; private val dec = max(1, Math.round(fs / 8000).toInt())
    private val lp: DoubleArray; private val hist: DoubleArray; private var hp = 0; private var ph = 0
    private var hpX = 0.0; private var hpY = 0.0; private var hpX2 = 0.0; private var hpY2 = 0.0; private var de = 0.0; private var nz = 0.0; private var np = 0; private var prev = 0.0
    private val out = FloatArray(160); private var on = 0; private var hang = 0
    init {
        val taps = 8 * dec + 1; val fc = 3400 / fs; val mid = (taps - 1) / 2.0; lp = DoubleArray(taps); var s = 0.0
        for (i in 0 until taps) { val x = i - mid; val w = 0.54 - 0.46 * cos(2 * PI * i / (taps - 1)); lp[i] = (if (x == 0.0) 2 * fc else sin(2 * PI * fc * x) / (PI * x)) * w; s += lp[i] }
        for (i in 0 until taps) lp[i] /= s
        hist = DoubleArray(taps)
    }
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        val t = lp.size; val toHz = fs / (2 * PI)
        for (k in 0 until m) {
            val i = zi[k].toDouble(); val q = zq[k].toDouble()
            val f = atan2(q * pi - i * pq, i * pi + q * pq) * toHz; pi = i; pq = q
            // the noise squelch: what is left after the voice band (a first difference twice, above about 4 kHz)
            val d = f - prev; prev = f; nz += d * d; np++
            hist[hp] = f; if (++hp >= t) hp = 0
            if (++ph < dec) continue
            ph = 0
            var y = 0.0; var j = hp; for (x in 0 until t) { y += lp[x] * hist[j]; if (++j >= t) j = 0 }
            // 300 Hz high-pass (two poles), then the de-emphasis (a 300 Hz pole), scaled so 2.5 kHz of deviation at 1 kHz is about 0.2
            val hp1 = 0.81 * (hpY + y - hpX); hpX = y; hpY = hp1
            val hpv = 0.81 * (hpY2 + hp1 - hpX2); hpX2 = hp1; hpY2 = hpv
            de += 0.21 * (hpv - de)
            out[on++] = (de / 2000).toFloat()
            if (on == 160) {
                val noise = sqrt(nz / max(1, np)) / (fs / 2)
                // a carrier quiets the discriminator: unmodulated noise there sits near a third of the sample rate
                hang = if (noise < SQ_OPEN) SQ_HANG_BLOCKS else if (noise >= SQ_SHUT) 0 else max(0, hang - 1)
                onPcm(out.copyOf(), hang > 0)
                on = 0; nz = 0.0; np = 0
            }
        }
    }
}
