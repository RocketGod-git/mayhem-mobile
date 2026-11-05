package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * ACARS receiver. The VHF channel is AM carrying 2400 bps MSK audio (1200 / 2400 Hz tones about 1800 Hz); the
 * framing and fields follow acarsdec.
 *
 * The tuned channel is cut out of the wide IQ (oscillator, two FIR stages to ~24 kHz) and its envelope taken, so
 * other airband signals in the span stay out of it and the channel need not sit on the radio's DC spike: the radio
 * is tuned [LO_SHIFT] above the channel and [offsetHz] says where the channel is. The audio is mixed against 1800 Hz
 * and filtered over one bit; at each bit the phase has turned a quarter turn one way or the other, which says which
 * tone was sent.
 *
 * How a tone maps to a data bit is read three ways at once: the tone as the bit, and the two differential readings
 * (a coherent MSK receiver like acarsdec's sees the bit repeat on one tone and flip on the other, depending on its
 * sign convention). Each reading hunts for SYN SYN SOH in both polarities; whichever finds it collects the frame.
 *
 * Like acarsdec, every known ACARS channel inside the span is decoded at once (the tuned one first, then the US
 * set, then the rest, up to [MAX_CHANNELS]), each by its own receiver, and every message says which channel it
 * came in on. The same receiver as the web app's (web/src/dsp/acars.ts).
 */
class AcarsDecoder(private val log: PacketLog) : IqProcessor {
    /** The span centre and the tuned channel; the app points these at the engine. */
    var centerOf: () -> Long = { 0L }
    var tunedOf: () -> Long = { 0L }
    /** Where decoded frames' readings and CRCs are reported (the diagnostics log). */
    var onNote: ((String) -> Unit)? = null
    private var key = ""
    private var rx = emptyList<AcarsChannel>()
    /** The channels decoded now. */
    fun channels(): List<Long> = rx.map { it.hz }

    override fun reset(rate: Int) { key = ""; rx = emptyList() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val center = centerOf(); val tuned = tunedOf()
        val k = "$center|$tuned|$rate"
        if (k != key) {
            key = k
            val reach = rate / 2 - 50_000
            val want = (listOf(tuned) + CHANNELS).distinct().filter { it > 0 && kotlin.math.abs(it - center) < reach }.take(MAX_CHANNELS)
            rx = want.map { hz -> rx.firstOrNull { it.hz == hz } ?: AcarsChannel(hz, log) { onNote?.invoke(it) } }
            for (r in rx) r.offsetHz = (r.hz - center).toInt()
            onNote?.invoke("ACARS: decoding ${rx.joinToString(", ") { "%.3f".format(it.hz / 1e6) }} MHz")
        }
        for (r in rx) r.onIq(iq, len, rate)
    }

    companion object {
        /** The radio sits this far from the tuned channel: with 131.550 tuned the span is centred on 130.8 MHz, so
         *  every US channel (130.025-131.550) is inside it and none is on the DC spike. */
        const val LO_SHIFT = -750_000L
        private const val MAX_CHANNELS = 6
        /** ACARS channels: the tuned one goes first, then these in order of preference. */
        val CHANNELS = listOf(131_550_000L, 130_025_000L, 130_425_000L, 130_450_000L, 131_125_000L,   // US
            131_525_000L, 131_725_000L, 131_825_000L, 136_900_000L, 136_750_000L,                     // Europe
            131_450_000L, 131_950_000L, 129_125_000L, 131_475_000L)                                   // Japan, others
    }
}

/** One ACARS channel's receiver. */
private class AcarsChannel(val hz: Long, private val log: PacketLog, private val note: (String) -> Unit) : IqProcessor {
    /** The channel's offset from the span centre. */
    @Volatile var offsetHz = 0

    private var rate = 0; private var lastOffset = Int.MIN_VALUE
    private var cr = 1.0; private var ci = 0.0; private var dr = 1.0; private var di = 0.0
    private var d1 = 1; private var d2 = 1; private var t1 = FloatArray(1); private var t2 = FloatArray(1)
    private var h1i = FloatArray(2); private var h1q = FloatArray(2); private var p1 = 0; private var c1 = 0
    private var h2i = FloatArray(2); private var h2q = FloatArray(2); private var p2 = 0; private var c2 = 0
    private var fs = 24_000.0; private var envDc = 0f
    private var ph = 0.0; private var phInc = 0.0
    private var mfI = FloatArray(10); private var mfQ = FloatArray(10); private var mfPos = 0; private var sI = 0f; private var sQ = 0f
    private var pI = 0f; private var pQ = 0f; private var bI = 0f; private var bQ = 0f
    private var clk = 0.0; private var clkInc = 0.0; private var lastF = 0f
    private var lanes = Array(3) { Lane(it) }

    /** One way of turning tones into bits, with its own sync search and frame. */
    private class Lane(val kind: Int) {
        var prev = 0; var window = 0; var collecting = false; var polarity = 0
        var byte = 0; var nBits = 0; var count = 0; var parityErrors = 0; var inCrc = false; var crcBytes = 0; var crcHi = 0; var crcLo = 0
        val raw = IntArray(320)
    }

    override fun reset(rate: Int) {
        this.rate = rate; lastOffset = Int.MIN_VALUE
        d1 = maxOf(1, (rate / 240_000.0).roundToInt())
        val inter = rate.toDouble() / d1
        d2 = maxOf(1, (inter / 24_000.0).roundToInt())
        fs = inter / d2
        t1 = lowpass(5 * d1 + 1, 50_000.0 / rate)
        t2 = lowpass(127, 6_000.0 / inter)
        h1i = FloatArray(t1.size * 2); h1q = FloatArray(t1.size * 2); p1 = 0; c1 = 0
        h2i = FloatArray(t2.size * 2); h2q = FloatArray(t2.size * 2); p2 = 0; c2 = 0
        phInc = 2 * PI * 1800.0 / fs
        val mf = maxOf(2, (fs / 2400.0).roundToInt())
        mfI = FloatArray(mf); mfQ = FloatArray(mf); mfPos = 0; sI = 0f; sQ = 0f
        clkInc = 2400.0 / fs; clk = 0.0
        lanes = Array(3) { Lane(it) }
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        val off = offsetHz
        if (off != lastOffset) { lastOffset = off; val w = -2 * PI * off / rate; dr = cos(w); di = sin(w) }
        val n = len / 2; val L1 = t1.size; val L2 = t2.size
        var r = cr; var s = ci
        for (k in 0 until n) {
            val xi = ((iq[2 * k].toInt() and 0xff) - 127.4).toFloat(); val xq = ((iq[2 * k + 1].toInt() and 0xff) - 127.4).toFloat()
            val yi = (xi * r - xq * s).toFloat(); val yq = (xi * s + xq * r).toFloat()
            val nr = r * dr - s * di; s = r * di + s * dr; r = nr
            h1i[p1] = yi; h1i[p1 + L1] = yi; h1q[p1] = yq; h1q[p1 + L1] = yq
            if (++p1 >= L1) p1 = 0
            if (++c1 < d1) continue
            c1 = 0
            var ai = 0f; var aq = 0f
            for (t in 0 until L1) { ai += h1i[p1 + t] * t1[t]; aq += h1q[p1 + t] * t1[t] }
            h2i[p2] = ai; h2i[p2 + L2] = ai; h2q[p2] = aq; h2q[p2 + L2] = aq
            if (++p2 >= L2) p2 = 0
            if (++c2 < d2) continue
            c2 = 0
            var bi = 0f; var bq = 0f
            for (t in 0 until L2) { bi += h2i[p2 + t] * t2[t]; bq += h2q[p2 + t] * t2[t] }
            val env = sqrt(bi * bi + bq * bq)
            envDc += 0.001f * (env - envDc)
            audio(env - envDc)
        }
        // keep the oscillator on the unit circle
        val m = sqrt(r * r + s * s); cr = r / m; ci = s / m
    }

    private fun audio(a: Float) {
        ph += phInc; if (ph > 2 * PI) ph -= 2 * PI
        val mi = a * cos(ph).toFloat(); val mq = -a * sin(ph).toFloat()
        sI += mi - mfI[mfPos]; sQ += mq - mfQ[mfPos]; mfI[mfPos] = mi; mfQ[mfPos] = mq; if (++mfPos >= mfI.size) mfPos = 0
        // Instantaneous frequency about 1800 Hz: its sign changes where the tone does. The one-bit filter puts that
        // change half a bit after the edge, and the bit is read when the filter holds exactly one bit, half a bit
        // after that: so a sign change should land at half a clock.
        val f = sQ * pI - sI * pQ
        pI = sI; pQ = sQ
        if ((f > 0f) != (lastF > 0f)) clk -= 0.25 * (clk - 0.5)
        lastF = f
        clk += clkInc
        if (clk < 1.0) return
        clk -= 1.0
        // a quarter turn up over the bit is the 2400 Hz tone, down the 1200 Hz one
        val turn = sQ * bI - sI * bQ
        bI = sI; bQ = sQ
        val tone = if (turn > 0f) 1 else 0
        for (l in lanes) {
            val bit = when (l.kind) { 0 -> tone; 1 -> l.prev xor tone; else -> l.prev xor tone xor 1 }
            l.prev = bit
            onBit(l, bit)
        }
    }

    private fun onBit(l: Lane, raw: Int) {
        if (!l.collecting) {
            l.window = ((l.window shl 1) or raw) and 0xFFFFFF
            if (l.window == SYNC_WORD) start(l, 0)
            else if ((l.window.inv() and 0xFFFFFF) == SYNC_WORD) start(l, 1)
            return
        }
        l.byte = l.byte or ((raw xor l.polarity) shl l.nBits)
        if (++l.nBits < 8) return
        val b = l.byte; l.byte = 0; l.nBits = 0
        if (l.inCrc) {
            if (l.crcBytes == 0) { l.crcHi = b; l.crcBytes = 1; return }
            l.crcLo = b; finish(l); return
        }
        if (Integer.bitCount(b) % 2 == 0 && ++l.parityErrors > 4) { l.collecting = false; l.window = 0; return }
        l.raw[l.count++] = b
        val ch = b and 0x7f
        if (ch == ETX || ch == ETB) { l.inCrc = true; l.crcBytes = 0; return }
        if (l.count >= l.raw.size) { l.collecting = false; l.window = 0 }
    }

    private fun start(l: Lane, polarity: Int) {
        l.collecting = true; l.polarity = polarity; l.nBits = 0; l.byte = 0; l.count = 0; l.parityErrors = 0; l.inCrc = false; l.crcBytes = 0
    }

    /** CRC-16 over mode … ETX: the reflected (0x8408) and plain (0x1021) forms, over the bytes with and without parity. */
    private fun crcOk(l: Lane): Boolean {
        val rx1 = (l.crcHi shl 8) or l.crcLo; val rx2 = (l.crcLo shl 8) or l.crcHi
        for (strip in booleanArrayOf(false, true)) {
            var a = 0; var b = 0
            for (i in 0 until l.count) {
                val v0 = if (strip) l.raw[i] and 0x7f else l.raw[i]
                a = a xor (v0 shl 8); for (k in 0 until 8) a = if ((a and 0x8000) != 0) ((a shl 1) xor 0x1021) and 0xffff else (a shl 1) and 0xffff
                var v = v0; for (k in 0 until 8) { val lsb = (b xor v) and 1; b = b ushr 1; if (lsb != 0) b = b xor 0x8408; v = v ushr 1 }
            }
            if (a == rx1 || a == rx2 || b == rx1 || b == rx2) return true
        }
        return false
    }

    private fun finish(l: Lane) {
        l.collecting = false; l.window = 0
        val n = l.count
        if (n < 13) return
        val ok = crcOk(l)
        // a reading that found a sync but whose frame is broken in parity as well as CRC is noise, not a message
        if (!ok && l.parityErrors > 1) return
        val bytes = IntArray(n) { l.raw[it] and 0x7f }
        fun ch(i: Int) = bytes[i].toChar()
        val mode = ch(0)
        val reg = (1..7).map { ch(it) }.joinToString("").trim('.', ' ')
        val ack = if (bytes[8] == 0x15) "NAK" else ch(8).toString()
        val label = "${ch(9)}${if (bytes[10] == DEL) 'd' else ch(10)}"
        val blk = ch(11)
        val down = blk in '0'..'9'
        var p = 12; var msn = ""; var flight = ""
        if (bytes[p] == STX) {
            p++
            if (down && n - p >= 11) { msn = (0 until 4).map { ch(p + it) }.joinToString(""); flight = (4 until 10).map { ch(p + it) }.joinToString("").trim(); p += 10 }
        }
        val text = StringBuilder()
        while (p < n) { val c = bytes[p++]; if (c == ETX || c == ETB) break; text.append(if (c in 0x20..0x7e) c.toChar() else if (c == 0x0a || c == 0x0d) ' ' else '·') }
        val head = "ACARS ${"%.3f".format(hz / 1e6)} ${if (down) "↓" else "↑"} $reg  $label  blk $blk  ack $ack${if (msn.isNotEmpty()) "  #$msn $flight" else ""}${if (ok) "" else "  CRC?"}${if (mode != '2') "  mode $mode" else ""}"
        val body = text.toString().trim()
        log.add(if (body.isEmpty()) head else "$head\n$body")
        note("ACARS ${"%.3f".format(hz / 1e6)}: frame read as ${LANE_NAMES[l.kind]}${if (l.polarity == 1) " (inverted)" else ""}, CRC ${if (ok) "good" else "bad"}, ${l.parityErrors} parity errors")
        // the other readings are not hunting this frame any more
        for (o in lanes) if (o !== l && o.collecting) { o.collecting = false; o.window = 0 }
    }

    companion object {
        private const val STX = 0x02; private const val ETX = 0x03; private const val ETB = 0x17; private const val DEL = 0x7f
        private val LANE_NAMES = arrayOf("tone", "diff-a", "diff-b")
        /** SYN SYN SOH as received, oldest bit first, each byte LSB first. */
        private val SYNC_WORD = intArrayOf(0x16, 0x16, 0x01).fold(0) { w, b -> (0 until 8).fold(w) { x, i -> (x shl 1) or ((b shr i) and 1) } }

        /** Hamming-windowed sinc, unity gain at DC; [cut] is the cutoff as a fraction of the sample rate. */
        private fun lowpass(taps: Int, cut: Double): FloatArray {
            val m = taps - 1; val h = DoubleArray(taps); var sum = 0.0
            for (k in 0 until taps) {
                val x = k - m / 2.0
                val sinc = if (x == 0.0) 2 * cut else sin(2 * PI * cut * x) / (PI * x)
                h[k] = sinc * (0.54 - 0.46 * cos(2 * PI * k / m)); sum += h[k]
            }
            return FloatArray(taps) { (h[it] / sum).toFloat() }
        }
    }
}
