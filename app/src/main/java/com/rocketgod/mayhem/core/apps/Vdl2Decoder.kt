package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.ham.ChannelDecimator
import com.rocketgod.mayhem.core.ham.ComplexFirDecimator
import com.rocketgod.mayhem.core.ham.lowpassTaps
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * VDL Mode 2 receiver (VHF Digital Link, 136 MHz): our own, from the public standard's structure (ETSI EN 301 841-1:
 * D8PSK at 10 500 symbols a second, 3 bits a symbol, raised cosine α 0.6; a training sequence of ramp-up, a 16-symbol
 * unique word, a reserved symbol, a 17-bit transmission length and a 5-bit header FEC; frames are AVLC, the HDLC of
 * aviation). The details the ETSI text leaves to ICAO were worked out on our own recordings of 136.975 and 136.10 MHz
 * (2026-11-14), where every burst passes its AVLC frame check with these:
 * - the unique word is 000 010 011 110 000 001 101 110 001 100 011 111 101 111 100 010, which fixes the Gray mapping of
 *   the eight phase steps (0, 1, 3, 2, 6, 7, 5, 4 π/4 for 000 ... 111);
 * - everything from the reserved symbol on is scrambled by x^15 + x + 1 from state 0x098D (output: the oldest stage);
 * - the frame bits after the header are bytes (first bit = least significant) in Reed-Solomon blocks of up to 249
 *   data bytes, the data bytes of all blocks interleaved column by column, the parity after (not used yet: a frame
 *   with a bit error fails its frame check and is counted, not shown);
 * - AVLC: flags 7E, zero-bit stuffing, CRC-16 X.25; each address is 4 octets of 7 bits (first sent = most
 *   significant): a flag bit, a 3-bit type (1 = aircraft, its 24-bit ICAO address) and the 24-bit address.
 *
 * Every VDL2 channel inside the span is decoded at once, each by its own receiver. ACARS carried in AVLC (FF FF 01,
 * then the ACARS block) comes out as the ACARS app's message lines with VDL2 in front, so the same cards read it.
 * Twin of the web dsp/vdl2.ts.
 */
class Vdl2Decoder(private val log: PacketLog) : IqProcessor {
    /** One decoded AVLC frame (for tests and tools). */
    data class Frame(val hz: Long, val snrDb: Int, val src: Int, val srcType: Int, val dst: Int, val dstType: Int, val ctrl: Int, val info: List<Int>)

    @Volatile var centerOf: () -> Long = { 0L }
    @Volatile var onNote: ((String) -> Unit)? = null
    /** Every AVLC frame that passed its check (tests and tools). */
    @Volatile var onFrame: ((Frame) -> Unit)? = null
    /** Transmissions found (unique word heard) and frames that failed their check. */
    @Volatile var bursts = 0; private set
    @Volatile var badFrames = 0; private set
    private var key = ""
    private var rx: List<Channel> = emptyList()

    fun channels(): List<Long> = rx.map { it.hz }

    override fun reset(rate: Int) { key = ""; rx = emptyList(); bursts = 0; badFrames = 0 }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val center = centerOf()
        val k = "$center|$rate"
        if (k != key) {
            key = k
            val reach = rate / 2 - 30_000
            rx = CHANNELS.filter { abs(it - center) < reach && abs(it - center) > 15_000 }.take(MAX_CHANNELS).map { Channel(it, it - center, rate) }
            onNote?.invoke("VDL2: decoding ${rx.joinToString(", ") { "%.3f".format(it.hz / 1e6) }} MHz")
        }
        for (c in rx) c.onIq(iq, len)
    }

    /** A burst's symbols are in: frames out. */
    internal fun transmission(hz: Long, steps: IntArray, snrDb: Int) {
        var at = -1; var best = 3
        var i = 0
        while (i + 16 <= steps.size && i < 120) {
            var e = 0; var k = 0
            while (k < 16 && e < best) { if (steps[i + k] != UW[k]) e++; k++ }
            if (e < best) { best = e; at = i; if (e == 0) break }
            i++
        }
        if (at < 0) return
        bursts++
        val n = steps.size - at - 16
        val bits = IntArray(n * 3)
        for (q in 0 until n) { val t = TRI[steps[at + 16 + q]]; bits[3 * q] = t[0]; bits[3 * q + 1] = t[1]; bits[3 * q + 2] = t[2] }
        val r = transmissionFrames(bits, bits.size) ?: return
        badFrames += r.bad
        if (r.bad > 0 && r.frames.isEmpty()) onNote?.invoke("VDL2 %.3f: a %d-bit transmission failed its frame check".format(hz / 1e6, r.len))
        for (f in r.frames) frame(hz, f, snrDb)
    }

    private fun frame(hz: Long, b: List<Int>, snrDb: Int) {
        if (b.size < 9) return
        val dst = avlcAddress(b, 0); val src = avlcAddress(b, 4); val ctrl = b[8]; val info = b.subList(9, b.size)
        onFrame?.invoke(Frame(hz, snrDb, src.addr, src.type, dst.addr, dst.type, ctrl, info))
        val mhz = "%.3f".format(hz / 1e6)
        val down = src.type == 1
        val who = "${TYPE_NAMES[src.type]} %06X → ${TYPE_NAMES[dst.type]} %06X".format(src.addr, dst.addr)
        val kind = when {
            ctrl and 1 == 0 -> "I"
            ctrl and 3 == 1 -> "S"
            ctrl and 0xEF == 0xAF -> "XID"
            ctrl and 0xEF == 0x03 -> "UI"
            else -> "U %02X".format(ctrl)
        }
        val acars = if (info.size >= 16 && info[0] == 0xFF && info[1] == 0xFF && info[2] == 0x01) acarsLine(mhz, down, info.subList(3, info.size)) else null
        if (acars != null) {
            log.add(acars)
            onNote?.invoke("VDL2 $mhz: $who · $kind · ACARS · +$snrDb dB")
            return
        }
        val text = info.joinToString("") { val c = it and 0x7F; if (c in 0x20..0x7E) c.toChar().toString() else "·" }
        val words = Regex("[A-Z0-9]{4,}").findAll(text).joinToString(" ") { it.value }
        onNote?.invoke("VDL2 $mhz ${if (down) "↓" else "↑"} $who · $kind · ${info.size} bytes${if (words.isNotEmpty()) " · $words" else ""} · +$snrDb dB")
    }

    /** An ACARS block (mode, registration, ack, label, block ID, then STX and text) as an ACARS message line. */
    private fun acarsLine(mhz: String, down: Boolean, raw: List<Int>): String? {
        val b = raw.map { it and 0x7F }; val n = b.size
        if (n < 13) return null
        fun ch(i: Int) = b[i].toChar()
        val mode = ch(0)
        val reg = (1..7).joinToString("") { ch(it).toString() }.trim('.', ' ')
        val ack = if (b[8] == 0x15) "NAK" else ch(8).toString()
        val label = "${ch(9)}${if (b[10] == 0x7F) 'd' else ch(10)}"
        val blk = ch(11)
        var p = 12; var msn = ""; var flight = ""
        if (b[p] == 0x02) {
            p++
            if (down && n - p >= 11) { msn = (0 until 4).joinToString("") { ch(p + it).toString() }; flight = (4 until 10).joinToString("") { ch(p + it).toString() }.trim(); p += 10 }
        }
        val text = StringBuilder()
        while (p < n) {
            val c = b[p++]
            if (c == 0x03 || c == 0x17) break
            text.append(if (c in 0x20..0x7E) c.toChar() else if (c == 0x0A || c == 0x0D) ' ' else '·')
        }
        val head = "VDL2 $mhz ${if (down) "↓" else "↑"} $reg  $label  blk $blk  ack $ack${if (msn.isNotEmpty()) "  #$msn $flight" else ""}${if (mode != '2') "  mode $mode" else ""}"
        val body = text.toString().trim()
        return if (body.isNotEmpty()) "$head\n$body" else head
    }

    /** One VDL2 channel: oscillator, CIC + FIR down to about 105 kHz, a ±10 kHz channel filter, bursts out of the
     *  power, then D8PSK: the carrier from the 8th power, the symbol clock, the phase steps. */
    private inner class Channel(val hz: Long, offsetHz: Long, rate: Int) {
        private var cr = 1.0; private var ci = 0.0
        private val dr: Double; private val di: Double
        private val chan = ChannelDecimator(max(1, rate / 105_000))
        private val lp: ComplexFirDecimator
        val fs: Double = rate.toDouble() / chan.total
        private var floor = 0.0; private var on = false; private var quiet = 0; private var seen = 0L
        private var buf = FloatArray(2 * 8192); private var n = 0; private var peak = 0.0
        private var mixed = FloatArray(0); private var mid = FloatArray(0); private var flt = FloatArray(0)

        init {
            val w = -2 * PI * offsetHz / rate; dr = cos(w); di = sin(w)
            lp = ComplexFirDecimator(lowpassTaps(10_000 / fs, 41), 1)
        }

        fun onIq(iq: ByteArray, len: Int) {
            val m = len / 2
            if (mixed.size < 2 * m) mixed = FloatArray(2 * m)
            var r = cr; var s = ci
            for (k in 0 until m) {
                val xi = (iq[2 * k].toInt() and 0xFF) - 128.0; val xq = (iq[2 * k + 1].toInt() and 0xFF) - 128.0
                mixed[2 * k] = (xi * r - xq * s).toFloat(); mixed[2 * k + 1] = (xi * s + xq * r).toFloat()
                val t = r * dr - s * di; s = r * di + s * dr; r = t
                if (k and 1023 == 0) { val g = 1 / sqrt(r * r + s * s); r *= g; s *= g }
            }
            cr = r; ci = s
            if (mid.size < chan.outSize(m)) mid = FloatArray(chan.outSize(m))
            val o = chan.process(mixed, m, mid)
            if (flt.size < 2 * (o + 2)) flt = FloatArray(2 * (o + 2))
            val c = lp.process(mid, o, flt)
            for (k in 0 until c) {
                val p = (flt[2 * k] * flt[2 * k] + flt[2 * k + 1] * flt[2 * k + 1]).toDouble()
                seen++
                // the floor: a slow average of the quiet samples (bursts do not pull it up)
                if (floor == 0.0) floor = p + 1e-3
                if (!on) {
                    if (p < floor * 4 || seen < fs * 0.05) floor += (p - floor) * 0.0005
                    if (seen > fs * 0.05 && p > floor * 20) { on = true; n = 0; quiet = 0; peak = 0.0 }
                }
                if (on) {
                    if (2 * n + 2 > buf.size) {
                        if (buf.size >= 2 * fs * 0.7) { on = false; continue }
                        buf = buf.copyOf(buf.size * 2)
                    }
                    buf[2 * n] = flt[2 * k]; buf[2 * n + 1] = flt[2 * k + 1]; n++
                    if (p > peak) peak = p
                    if (p < floor * 6) quiet++ else quiet = 0
                    if (quiet > fs * 0.0015) { on = false; burst(n - quiet) }
                }
            }
        }

        private fun burst(n: Int) {
            val sps = fs / SYMBOL_RATE
            if (n < sps * 40) return
            val x = buf
            // the carrier: the 8th power's line, over up to 16384 samples. The plain power, not the phase alone: on the
            // phase alone the lines a symbol rate either side (from the pulse shape) can win, 1.3 kHz off on our recordings.
            var nn = 1; while (nn < min(n, 16384)) nn = nn shl 1
            val re = FloatArray(nn); val im = FloatArray(nn); val m = min(n, nn)
            var pw = 0.0; for (k in 0 until m) pw += (x[2 * k] * x[2 * k] + x[2 * k + 1] * x[2 * k + 1]).toDouble()
            val g = 1 / sqrt(pw / m + 1e-20)
            for (k in 0 until m) {
                var a = x[2 * k] * g; var b = x[2 * k + 1] * g
                repeat(3) { val t = a * a - b * b; b = 2 * a * b; a = t }
                re[k] = a.toFloat(); im[k] = b.toFloat()
            }
            Dsp.fft(re, im)
            var bi = 0; var bv = -1.0
            for (k in 0 until nn) { val v = (re[k] * re[k] + im[k] * im[k]).toDouble(); if (v > bv) { bv = v; bi = k } }
            val f8 = (if (bi < nn / 2) bi else bi - nn) * fs / nn
            val w = -2 * PI * (f8 / 8) / fs
            val y = FloatArray(2 * n)
            for (k in 0 until n) { val c = cos(w * k); val s = sin(w * k); y[2 * k] = (x[2 * k] * c - x[2 * k + 1] * s).toFloat(); y[2 * k + 1] = (x[2 * k] * s + x[2 * k + 1] * c).toFloat() }
            // the symbol clock: the phase (of 16) where the steps sit closest to whole multiples of π/4
            fun at(t: Double, out: DoubleArray) {
                val i = t.toInt(); val f = t - i
                if (i + 1 >= n) { out[0] = y[2 * i].toDouble(); out[1] = y[2 * i + 1].toDouble(); return }
                out[0] = y[2 * i] * (1 - f) + y[2 * i + 2] * f; out[1] = y[2 * i + 1] * (1 - f) + y[2 * i + 3] * f
            }
            val count = ((n - 2) / sps).toInt() - 1
            if (count < 2) return
            val pv = DoubleArray(2); val cv = DoubleArray(2)
            var bestPh = 0.0; var bestE = Double.MAX_VALUE
            for (p in 0 until 16) {
                val ph = sps * p / 16
                var e = 0.0
                at(ph, pv)
                for (k in 1 until count) {
                    at(ph + k * sps, cv)
                    val q = atan2(cv[1] * pv[0] - cv[0] * pv[1], cv[0] * pv[0] + cv[1] * pv[1]) / (PI / 4)
                    e += abs(q - q.roundToInt()); pv[0] = cv[0]; pv[1] = cv[1]
                }
                if (e < bestE) { bestE = e; bestPh = ph }
            }
            val steps = IntArray(count - 1)
            at(bestPh, pv)
            for (k in 1 until count) {
                at(bestPh + k * sps, cv)
                val q = (atan2(cv[1] * pv[0] - cv[0] * pv[1], cv[0] * pv[0] + cv[1] * pv[1]) / (PI / 4)).roundToInt()
                steps[k - 1] = ((q % 8) + 8) % 8; pv[0] = cv[0]; pv[1] = cv[1]
            }
            val snr = (10 * log10(peak / floor)).roundToInt()
            transmission(hz, steps, snr)
        }
    }

    data class Address(val type: Int, val addr: Int, val flag: Int)
    data class Transmission(val frames: List<List<Int>>, val bad: Int, val len: Int)

    companion object {
        /** VDL Mode 2 channels: 136.975 (the common signaling channel) first, then the other US and European ones and
         *  136.10 (busy at our home station). */
        val CHANNELS = listOf(136_975_000L, 136_650_000L, 136_700_000L, 136_725_000L, 136_775_000L, 136_800_000L, 136_825_000L,
            136_875_000L, 136_900_000L, 136_925_000L, 136_950_000L, 136_100_000L)
        /** 2 MHz centered here holds 136.10 to 136.975 (every VDL2 channel), with no channel on the radio's center. */
        const val SPAN_HZ = 136_550_000L
        const val SYMBOL_RATE = 10_500
        private const val MAX_CHANNELS = 12
        /** The unique word as phase steps (π/4 each). */
        private val UW = intArrayOf(0, 3, 2, 4, 0, 1, 6, 4, 1, 7, 2, 5, 6, 5, 7, 3)
        /** A phase step (π/4 units) → its three bits, in the order sent. */
        private val TRI = arrayOf(intArrayOf(0, 0, 0), intArrayOf(0, 0, 1), intArrayOf(0, 1, 1), intArrayOf(0, 1, 0),
            intArrayOf(1, 1, 0), intArrayOf(1, 1, 1), intArrayOf(1, 0, 1), intArrayOf(1, 0, 0))
        private const val SCRAMBLER_SEED = 0x098D
        private val TYPE_NAMES = listOf("type 0", "aircraft", "type 2", "type 3", "ground station", "ground station", "type 6", "all stations")

        fun crcX25(b: List<Int>, n: Int = b.size): Int {
            var c = 0xFFFF
            for (i in 0 until n) {
                c = c xor b[i]
                repeat(8) { c = if (c and 1 != 0) (c ushr 1) xor 0x8408 else c ushr 1 }
            }
            return c
        }

        /** HDLC: frames between flags, zero bits after five ones dropped, bytes first bit least significant. Only frames
         *  whose CRC-16 X.25 checks are returned (without the FCS); `bad` counts the others. */
        fun hdlcFrames(bits: IntArray, n: Int = bits.size): Pair<List<List<Int>>, Int> {
            val frames = ArrayList<List<Int>>()
            var bad = 0; var sh = 0; var have = false; var ones = 0
            var cur = ArrayList<Int>(); var byte = 0; var nb = 0
            for (i in 0 until n) {
                val b = bits[i]
                sh = ((sh shl 1) or b) and 0xFF
                if (sh == 0x7E) {
                    // the flag's own seven bits went into cur already: drop them
                    if (have) {
                        val total = cur.size * 8 + nb - 7
                        if (total >= 8 * 12 && total % 8 == 0) {
                            val by = cur.subList(0, total / 8).toList()
                            if (crcX25(by) == 0xF0B8) frames.add(by.dropLast(2)) else bad++
                        }
                    }
                    have = true; cur = ArrayList(); byte = 0; nb = 0; ones = 0
                    continue
                }
                if (!have) continue
                if (b == 1) { ones++; if (ones > 6) { have = false; continue } }
                else { if (ones == 5) { ones = 0; continue }; ones = 0 }
                byte = byte or (b shl nb); nb++
                if (nb == 8) { cur.add(byte); byte = 0; nb = 0; if (cur.size > 2100) have = false }
            }
            return frames to bad
        }

        /** An address field: 4 octets, 7 bits each after the extension bit, first sent = most significant. */
        fun avlcAddress(b: List<Int>, at: Int): Address {
            var v = 0L
            for (k in 0 until 4) {
                val x = b[at + k] shr 1
                var r = 0; for (i in 0 until 7) r = r or (((x shr i) and 1) shl (6 - i))
                v = v * 128 + r
            }
            return Address(((v shr 24) and 7).toInt(), (v and 0xFFFFFF).toInt(), ((v shr 27) and 1).toInt())
        }

        /** The frames of one transmission's bits (after the unique word): descrambled, header, de-interleaved, HDLC. */
        fun transmissionFrames(raw: IntArray, n: Int): Transmission? {
            if (n < 25 + 8 * 13) return null
            val bits = IntArray(n)
            var st = SCRAMBLER_SEED
            for (i in 0 until n) {
                val out = (st shr 14) and 1; val fb = (st xor (st shr 14)) and 1
                st = ((st shl 1) or fb) and 0x7FFF
                bits[i] = raw[i] xor out
            }
            if (bits[0] != 0 || bits[1] != 0 || bits[2] != 0) return null   // the reserved symbol is 000
            var len = 0
            for (i in 0 until 17) len = len or (bits[3 + i] shl i)
            val nby = (len + 7) shr 3
            if (len < 8 * 13 || 25 + 8 * nby > n) return null
            val have = (n - 25) / 8
            val by = IntArray(have) { q -> var v = 0; for (i in 0 until 8) v = v or (bits[25 + 8 * q + i] shl i); v }
            val sizes = ArrayList<Int>(); var left = nby
            while (left > 0) { sizes.add(min(249, left)); left -= 249 }
            val blocks = sizes.map { IntArray(it) }
            var pos = 0
            for (i in 0 until 249) for (j in sizes.indices) if (i < sizes[j]) blocks[j][i] = by[pos++]
            val data = blocks.flatMap { it.toList() }
            val fb = IntArray(len) { (data[it shr 3] shr (it and 7)) and 1 }
            val (frames, bad) = hdlcFrames(fb, len)
            return Transmission(frames, bad, len)
        }
    }
}
