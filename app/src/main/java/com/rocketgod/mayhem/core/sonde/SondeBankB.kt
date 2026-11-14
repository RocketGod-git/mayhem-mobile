package com.rocketgod.mayhem.core.sonde

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The symbol clock bank B's decoders share (Vaisala RS92, Lockheed Martin LMS6-403 / LMSX, LMS6-1680, MRZ) and the
 * bank itself. The Kotlin twin of web/src/dsp/sonde/bank-b.ts.
 *
 * The symbol clock runs a one-symbol matched filter (a running sum) on the discriminator and takes its timing from the
 * filtered signal's zero crossings with a small loop gain, so noise crossings inside a symbol barely move it. Its DC
 * (the carrier's offset in the channel) follows the signal between frames and holds still inside one. This keeps the
 * slicer working down to the FM threshold, where a slicer on the raw discriminator would already be jittering.
 */
class SymbolClock(baud: Double, rate: Double, private val onSymbol: (Double) -> Unit, private val gain: Double = 0.05) {
    private val inc = baud / rate
    private val ring = FloatArray(max(2, Math.round(rate / baud).toInt()))
    private var rp = 0; private var sum = 0.0; private var sinceFix = 0
    private var phase = 0.0; private var lastPos = false
    private var dc = 0.0
    private val dcRate = min(0.05, baud / rate / 32)
    /** The clock phase at which the filtered signal crosses zero between unlike symbols: measured on clean signals for
     *  5 to 42 samples a symbol, the crossing sits half a symbol after the decision. */
    private val target = 0.5
    /** Hold the DC (inside a frame). */
    var hold = false
    /** Discriminator samples seen. */
    var samples = 0L

    fun push(x: Double) {
        samples++
        if (!hold) dc += (x - dc) * dcRate
        val v = x - dc
        val r = ring
        sum += v - r[rp]; r[rp] = v.toFloat()
        if (++rp == r.size) rp = 0
        // a running sum drifts with rounding: rebuild it now and then
        if (++sinceFix >= 8192) { sinceFix = 0; var s = 0.0; for (q in r) s += q; sum = s }
        val pos = sum > 0
        if (pos != lastPos) {
            var err = phase - target
            if (err > 0.5) err -= 1 else if (err < -0.5) err += 1
            phase -= err * gain
        }
        lastPos = pos
        phase += inc
        if (phase < 1) return
        phase -= 1
        onSymbol(sum)
    }
}

/**
 * A header search in both FM polarities on the symbol clock (up to 64 symbols); after a match it collects [frameSyms]
 * soft symbols (sign-corrected to the header's polarity) and hands them over with the sample count at the header.
 */
class SoftFramer(override val name: String, baud: Double, rate: Double, header: String, frameSyms: Int, private val maxErr: Int,
                 private val onFrame: (soft: FloatArray, atSample: Long) -> Unit) : ChannelDecoder {
    private val clock = SymbolClock(baud, rate, { s -> symbol(s) })
    private var sh = 0L; private var shN = 0
    private val hdrLen = header.length
    private val mask: Long = if (header.length >= 64) -1L else (1L shl header.length) - 1
    private val hdr: Long
    private var collecting = 0; private var inv = false; private var at = 0L
    private val buf = FloatArray(frameSyms)
    private var n = 0

    init {
        require(header.length <= 64) { "sync word over 64 symbols" }
        var h = 0L
        for (c in header) h = (h shl 1) or (if (c == '1') 1L else 0L)
        hdr = h and mask
    }

    override fun push(x: Double) = clock.push(x)

    private fun symbol(s: Double) {
        if (collecting > 0) {
            buf[n++] = (if (inv) -s else s).toFloat()
            if (--collecting == 0) { clock.hold = false; onFrame(buf, at) }
            return
        }
        sh = ((sh shl 1) or (if (s > 0) 1L else 0L)) and mask
        if (++shN < hdrLen) return
        val e = java.lang.Long.bitCount(sh xor hdr)
        val ei = hdrLen - e
        if (e <= maxErr || ei <= maxErr) {
            inv = ei < e
            collecting = buf.size; n = 0; shN = 0
            at = clock.samples
            clock.hold = true
        }
    }
}

/** LMS6-1680: the symbol clock into the variable-length subframe collector. */
private class Mk2aChannel(rate: Double, sink: SondeSink) : ChannelDecoder {
    override val name = "LMS6-1680"
    private val coll = Mk2aCollector(sink)
    private lateinit var clock: SymbolClock
    init { clock = SymbolClock(Mk2a.BAUD.toDouble(), rate, { s -> coll.symbol(s); clock.hold = coll.collecting }) }
    override fun push(x: Double) = clock.push(x)
}

private fun emit(sink: SondeSink, f: SondeFrame?) { if (f != null && f.serial.isNotEmpty()) sink(f) }

internal fun makeBankBDecoders(rate: Double, sink: SondeSink): List<ChannelDecoder> {
    val rs92 = Rs92Decoder(); val mrz = MrzDecoder(); val lms6 = Lms6Decoder(); val lmsx = LmsxDecoder()
    // LMS6-403 blocks follow each other without a gap: a frame may straddle two of them
    val period = Lms6.BLOCK * 16 / Lms6.BAUD * rate
    var lastBlock = -1e12
    return listOf(
        SoftFramer("RS92", Rs92.BAUD.toDouble(), rate, Rs92.HEADER, Rs92.SYMS, 3) { s, _ -> emit(sink, rs92.decode(s)) },
        SoftFramer("LMS6", Lms6.BAUD, rate, Lms6.HEADER, Lms6.SYMS, 8) { s, at ->
            val contiguous = abs(at - lastBlock - period) < 0.05 * period
            lastBlock = at.toDouble()
            for (f in lms6.decode(s, contiguous)) emit(sink, f)
        },
        SoftFramer("LMSX", Lms6.LMSX_BAUD, rate, Lms6.HEADER, Lms6.LMSX_SYMS, 8) { s, _ -> emit(sink, lmsx.decode(s)) },
        Mk2aChannel(rate, sink),
        SoftFramer("MRZ", Mrz.BAUD.toDouble(), rate, Mrz.HEADER, Mrz.SYMS, 2) { s, _ -> emit(sink, mrz.decode(s)) },
    )
}
