package com.rocketgod.mayhem.core.hd.hdc

import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// HDC (HD Radio audio) AAC LC core decoder: one packet in, 1024 samples per channel at 22050 Hz out.

class HdcSbrData(val buf: IntArray, val bitPos: Int, val bitEnd: Int)

class HdcCoreFrame(
    val stereo: Boolean,
    val blockType: Int,
    val pcm: List<FloatArray>,
    val sbr: HdcSbrData?,
    val error: String? = null,
    /** On a concealed frame: its energy against the last good frame (0 once faded out). */
    val conceal: Double = 0.0,
)

private const val LONG_START = 1
private const val EIGHT_SHORT = 2
private const val LONG_STOP = 3
private const val NOISE_HCB = 13
private const val INTENSITY_HCB2 = 14
private const val INTENSITY_HCB = 15
private const val ID_FIL = 6
private const val MAX_SFB = 64
private const val TNS_MAX_ORDER = 20
/** Concealment: lost frames played from the last good spectrum, 3 dB down each, signs scrambled from about 2.8 kHz. */
private const val CONCEAL_FRAMES = 5
private val CONCEAL_STEP = 10.0.pow(-3.0 / 20)
private const val SCRAMBLE_FROM = 256

private val POW43 = DoubleArray(8192) { it.toDouble().pow(4.0 / 3) }

private class Tns {
    var present = false
    val nFilt = IntArray(8)
    val coefRes = IntArray(8)
    val length = IntArray(32)
    val order = IntArray(32)
    val direction = IntArray(32)
    val compress = IntArray(32)
    val coef = IntArray(32 * 32)
}

private class Ics {
    var windowSequence = 0
    var windowShape = 0
    var maxSfb = 0
    var numWindows = 1
    var numGroups = 1
    val groupLen = IntArray(8)
    var swb: IntArray = SWB_LONG
    var numSwb = 47
    var msMask = 0
    val msUsed = IntArray(8 * MAX_SFB)
    var globalGain = 0
    val sfbCb = IntArray(8 * MAX_SFB)
    val sf = IntArray(8 * MAX_SFB)
    val q = IntArray(1024)
    val tns = Tns()

    fun copyHeader(o: Ics) {
        windowSequence = o.windowSequence; windowShape = o.windowShape; maxSfb = o.maxSfb
        numWindows = o.numWindows; numGroups = o.numGroups; o.groupLen.copyInto(groupLen)
        swb = o.swb; numSwb = o.numSwb; msMask = o.msMask; o.msUsed.copyInto(msUsed)
    }
}

private fun huff(b: Bits, h: Huff): Int {
    val t = h.tree
    var n = 0
    while (true) { val v = t[2 * n + b.bit()]; if (v < 0) return v.inv(); n = v }
}

private class ChannelState {
    val overlap = DoubleArray(1024)
    var prevShape = 0
    /** Spectrum of the last good frame as one long window, for concealment. */
    val last = DoubleArray(1024)
    val saved = DoubleArray(1024)
    val savedLast = DoubleArray(1024)
    var savedShape = 0
}

class HdcCore {
    private val ics = arrayOf(Ics(), Ics())
    private val ch = arrayOf(ChannelState(), ChannelState())
    private val spec = arrayOf(DoubleArray(1024), DoubleArray(1024))
    private val longT = Imdct(1024)
    private val shortT = Imdct(128)
    private val tbuf = DoubleArray(2048)
    private val wbuf = DoubleArray(2048)
    private val sbuf = DoubleArray(256)
    private var seed = 0x1f2e3d4c
    private var lastStereo = false
    private var haveLast = false
    private var lostRun = 0
    /** The last frame's window ended on a short slope (LONG_START or EIGHT_SHORT). */
    private var shortTail = false
    private val cIcs = Ics()
    private var undoable = false
    private var sStereo = false; private var sHaveLast = false; private var sLostRun = 0; private var sShortTail = false

    fun decode(pkt: IntArray): HdcCoreFrame {
        var blockType = -1
        if (pkt.isEmpty()) return conceal(blockType, "lost")
        save()
        try {
            val b = Bits(pkt)
            blockType = b.read(3)
            val stereo = blockType == 2 || blockType == 7
            val n = if (stereo) 2 else 1
            val a = ics[0]; val c = ics[1]
            header(b, a, stereo)
            if (stereo) c.copyHeader(a)
            a.tns.present = b.bit() == 1
            if (a.tns.present) tnsData(b, a)
            if (stereo) { c.tns.present = b.bit() == 1; if (c.tns.present) tnsData(b, c) }
            for (i in 0 until n) {
                val s = ics[i]
                s.globalGain = b.read(8)
                sectionData(b, s)
                scaleFactors(b, s)
                spectralData(b, s)
            }
            var sbr: HdcSbrData? = null
            if (b.left >= 3 && b.peek(3) == ID_FIL) {
                b.skip(3)
                if (b.bit() == 1) sbr = HdcSbrData(pkt, b.pos, b.end)
            }
            for (i in 0 until n) dequant(i)
            if (stereo) { msStereo(); intensity() }
            if (!stereo && lastStereo) ch[1].overlap.fill(0.0)
            lastStereo = stereo
            val seq = ics[0].windowSequence
            // resuming on a short left slope after a long concealed tail: end that tail on the short slope too
            if (lostRun != 0 && !shortTail && (seq == EIGHT_SHORT || seq == LONG_STOP)) {
                for (i in 0 until n) {
                    val ov = ch[i].overlap; val w = WIN_SHORT[ch[i].prevShape]
                    for (k in 0 until 128) ov[448 + k] *= w[127 - k]
                    ov.fill(0.0, 576)
                }
            }
            val pcm = ArrayList<FloatArray>()
            for (i in 0 until n) {
                tnsDecode(ics[i], spec[i])
                pcm.add(synth(ics[i], spec[i], ch[i]))
                keep(ics[i], spec[i], ch[i].last)
            }
            haveLast = true; lostRun = 0; undoable = true
            shortTail = seq == EIGHT_SHORT || seq == LONG_START
            return HdcCoreFrame(stereo, blockType, pcm, sbr)
        } catch (e: Exception) {
            undoable = false
            return conceal(blockType, e.message ?: e.toString())
        }
    }

    /** Takes back the last good decode (its output was garbage) and conceals that frame instead. */
    fun undo(): HdcCoreFrame {
        if (undoable) {
            lastStereo = sStereo; haveLast = sHaveLast; lostRun = sLostRun; shortTail = sShortTail
            for (c in ch) { c.saved.copyInto(c.overlap); c.savedLast.copyInto(c.last); c.prevShape = c.savedShape }
            undoable = false
        }
        return conceal(-1, "undone")
    }

    private fun save() {
        sStereo = lastStereo; sHaveLast = haveLast; sLostRun = lostRun; sShortTail = shortTail
        for (c in ch) { c.overlap.copyInto(c.saved); c.last.copyInto(c.savedLast); c.savedShape = c.prevShape }
    }

    // The frame's spectrum as one long window (short windows interleaved, sqrt(8) for the same level).
    private fun keep(ics: Ics, spec: DoubleArray, last: DoubleArray) {
        if (ics.windowSequence != EIGHT_SHORT) { spec.copyInto(last); return }
        val g = sqrt(2.0) * 2
        for (w in 0 until 8) for (k in 0 until 128) last[8 * k + w] = spec[w * 128 + k] * g
    }

    // Bad or lost packet: the last good spectrum again, decaying, then silence; the window stays long.
    private fun conceal(blockType: Int, error: String): HdcCoreFrame {
        undoable = false
        val run = ++lostRun; val n = if (lastStereo) 2 else 1
        val g = if (haveLast && run <= CONCEAL_FRAMES) CONCEAL_STEP.pow(run - 1) else 0.0
        val ics = cIcs; val pcm = ArrayList<FloatArray>()
        ics.windowSequence = if (shortTail) LONG_STOP else 0
        for (k in 0 until 1024) {
            val sg = if (k >= SCRAMBLE_FROM && rand() < 0) -g else g
            for (i in 0 until n) spec[i][k] = ch[i].last[k] * sg
        }
        for (i in 0 until n) {
            ics.windowShape = ch[i].prevShape
            pcm.add(synth(ics, spec[i], ch[i]))
        }
        shortTail = false
        return HdcCoreFrame(lastStereo, blockType, pcm, null, error, g * g)
    }

    private fun header(b: Bits, ics: Ics, stereo: Boolean) {
        if (b.bit() != 0) throw IllegalStateException("reserved bit set")
        ics.windowShape = b.bit()
        ics.windowSequence = b.read(2)
        ics.groupLen.fill(0)
        if (ics.windowSequence == EIGHT_SHORT) {
            ics.maxSfb = b.read(4)
            val grouping = b.read(7)
            ics.numWindows = 8; ics.swb = SWB_SHORT; ics.numSwb = 15
            ics.numGroups = 1; ics.groupLen[0] = 1
            for (w in 1 until 8) {
                if ((grouping shr (7 - w)) and 1 != 0) ics.groupLen[ics.numGroups - 1]++
                else ics.groupLen[ics.numGroups++] = 1
            }
        } else {
            ics.maxSfb = b.read(6)
            ics.numWindows = 1; ics.swb = SWB_LONG; ics.numSwb = 47
            ics.numGroups = 1; ics.groupLen[0] = 1
        }
        if (ics.maxSfb > ics.numSwb) throw IllegalStateException("max_sfb out of range")
        ics.msMask = 0
        ics.msUsed.fill(0)
        if (stereo) {
            ics.msMask = b.read(2)
            if (ics.msMask == 3) throw IllegalStateException("ms_mask_present 3")
            if (ics.msMask == 1) {
                for (g in 0 until ics.numGroups) for (s in 0 until ics.maxSfb) ics.msUsed[g * MAX_SFB + s] = b.bit()
            }
        }
    }

    private fun tnsData(b: Bits, ics: Ics) {
        val t = ics.tns; val short = ics.windowSequence == EIGHT_SHORT
        val lenBits = if (short) 4 else 6; val ordBits = if (short) 3 else 5
        for (w in 0 until ics.numWindows) {
            t.nFilt[w] = if (short) b.bit() else 1
            if (t.nFilt[w] != 0) t.coefRes[w] = b.bit()
            for (f in 0 until t.nFilt[w]) {
                val k = w * 4 + f
                t.length[k] = b.read(lenBits)
                t.order[k] = b.read(ordBits)
                if (t.order[k] != 0) {
                    t.direction[k] = b.bit()
                    t.compress[k] = b.bit()
                    val bits = 3 + t.coefRes[w] - t.compress[k]
                    for (i in 0 until t.order[k]) t.coef[k * 32 + i] = b.read(bits)
                }
            }
        }
    }

    private fun sectionData(b: Bits, ics: Ics) {
        val short = ics.windowSequence == EIGHT_SHORT; val bits = if (short) 3 else 5; val esc = (1 shl bits) - 1
        ics.sfbCb.fill(0)
        for (g in 0 until ics.numGroups) {
            var k = 0; var sections = 0
            while (k < ics.maxSfb) {
                if (++sections > 120) throw IllegalStateException("too many sections")
                val cb = b.read(4)
                if (cb == 12) throw IllegalStateException("codebook 12")
                var len = 0; var inc: Int
                while (true) { inc = b.read(bits); if (inc != esc) break; len += inc }
                len += inc
                if (k + len > ics.maxSfb) throw IllegalStateException("section past max_sfb")
                for (s in k until k + len) ics.sfbCb[g * MAX_SFB + s] = cb
                k += len
            }
        }
    }

    private fun scaleFactors(b: Bits, ics: Ics) {
        var sf = ics.globalGain; var isPos = 0; var noise = ics.globalGain - 90; var firstNoise = true
        for (g in 0 until ics.numGroups) {
            for (s in 0 until ics.maxSfb) {
                val i = g * MAX_SFB + s; val cb = ics.sfbCb[i]
                if (cb == 0) { ics.sf[i] = 0; continue }
                if (cb == INTENSITY_HCB || cb == INTENSITY_HCB2) { isPos += huff(b, BOOK[0]) - 60; ics.sf[i] = isPos; continue }
                if (cb == NOISE_HCB) {
                    if (firstNoise) { firstNoise = false; noise += b.read(9) - 256 } else noise += huff(b, BOOK[0]) - 60
                    ics.sf[i] = noise; continue
                }
                sf += huff(b, BOOK[0]) - 60
                if (sf < 0 || sf > 255) throw IllegalStateException("scalefactor out of range")
                ics.sf[i] = sf
            }
        }
    }

    // Quantized values in bitstream order (per group: band, window, bin).
    private fun spectralData(b: Bits, ics: Ics) {
        val q = ics.q; val swb = ics.swb
        q.fill(0)
        var base = 0
        for (g in 0 until ics.numGroups) {
            val L = ics.groupLen[g]
            for (s in 0 until ics.maxSfb) {
                val cb = ics.sfbCb[g * MAX_SFB + s]
                if (cb == 0 || cb > 11) continue
                val h = BOOK[cb]; val dim = BOOK_DIM[cb]; val signed = BOOK_SIGNED[cb]; val lav = BOOK_LAV[cb]
                val start = base + swb[s] * L; val end = base + swb[s + 1] * L
                var k = start
                while (k < end) {
                    var sym = huff(b, h)
                    if (dim == 4) {
                        val off = if (signed) 1 else 0
                        q[k + 3] = (sym % 3) - off; sym /= 3
                        q[k + 2] = (sym % 3) - off; sym /= 3
                        q[k + 1] = (sym % 3) - off
                        q[k] = (sym / 3) - off
                    } else {
                        val mod = if (signed) 2 * lav + 1 else lav + 1; val off = if (signed) lav else 0
                        q[k + 1] = (sym % mod) - off
                        q[k] = (sym / mod) - off
                    }
                    if (!signed) {
                        for (j in 0 until dim) if (q[k + j] != 0 && b.bit() != 0) q[k + j] = -q[k + j]
                        if (cb == 11) {
                            for (j in 0 until 2) {
                                val v = q[k + j]
                                if (v == 16 || v == -16) {
                                    var n = 0
                                    while (b.bit() != 0) if (++n > 8) throw IllegalStateException("escape too long")
                                    val m = (1 shl (n + 4)) + b.read(n + 4)
                                    q[k + j] = if (v < 0) -m else m
                                }
                            }
                        }
                    }
                    k += dim
                }
            }
            base += 128 * L
        }
    }

    private fun rand(): Double {
        seed = seed * 1664525 + 1013904223
        return seed / 2147483648.0
    }

    // Inverse quantization, deinterleaving into window order, and noise substitution.
    private fun dequant(c: Int) {
        val ics = ics[c]; val spec = spec[c]; val q = ics.q; val swb = ics.swb
        spec.fill(0.0)
        var win = 0; var base = 0
        for (g in 0 until ics.numGroups) {
            val L = ics.groupLen[g]
            for (s in 0 until ics.maxSfb) {
                val i = g * MAX_SFB + s; val cb = ics.sfbCb[i]; val w0 = swb[s]; val width = swb[s + 1] - w0
                if (cb == NOISE_HCB) {
                    val shared = c == 1 && this.ics[0].sfbCb[i] == NOISE_HCB && (ics.msMask == 2 || ics.msUsed[i] != 0)
                    val gain = 2.0.pow(0.25 * ics.sf[i])
                    for (w in 0 until L) {
                        val o = (win + w) * 128 + w0
                        var e = 0.0
                        for (k in 0 until width) { val v = if (shared) this.spec[0][o + k] else rand(); spec[o + k] = v; e += v * v }
                        val sc = if (e > 0) gain / sqrt(e) else 0.0
                        for (k in 0 until width) spec[o + k] *= sc
                    }
                    continue
                }
                if (cb == 0 || cb > 11) continue
                val gain = 2.0.pow(0.25 * (ics.sf[i] - 100))
                for (w in 0 until L) {
                    val src = base + w0 * L + w * width; val dst = (win + w) * 128 + w0
                    for (k in 0 until width) {
                        val v = q[src + k]
                        if (v == 0) continue
                        spec[dst + k] = if (v > 0) POW43[v] * gain else -POW43[-v] * gain
                    }
                }
            }
            win += L; base += 128 * L
        }
    }

    private fun msStereo() {
        val a = ics[0]; val c = ics[1]; val l = spec[0]; val r = spec[1]
        if (a.msMask == 0) return
        var win = 0
        for (g in 0 until a.numGroups) {
            val L = a.groupLen[g]
            for (s in 0 until a.maxSfb) {
                val i = g * MAX_SFB + s; val cb1 = a.sfbCb[i]; val cb2 = c.sfbCb[i]
                if (!(a.msMask == 2 || a.msUsed[i] != 0)) continue
                if (cb2 == INTENSITY_HCB || cb2 == INTENSITY_HCB2 || cb1 == NOISE_HCB || cb2 == NOISE_HCB) continue
                for (w in 0 until L) {
                    val o = (win + w) * 128
                    for (k in a.swb[s] until a.swb[s + 1]) { val m = l[o + k]; val d = r[o + k]; l[o + k] = m + d; r[o + k] = m - d }
                }
            }
            win += L
        }
    }

    private fun intensity() {
        val a = ics[0]; val c = ics[1]; val l = spec[0]; val r = spec[1]
        var win = 0
        for (g in 0 until c.numGroups) {
            val L = c.groupLen[g]
            for (s in 0 until c.maxSfb) {
                val i = g * MAX_SFB + s; val cb = c.sfbCb[i]
                if (cb != INTENSITY_HCB && cb != INTENSITY_HCB2) continue
                var sign = if (cb == INTENSITY_HCB) 1 else -1
                if (a.msMask == 1 && a.msUsed[i] != 0) sign = -sign
                val sc = sign * 2.0.pow(-0.25 * c.sf[i])
                for (w in 0 until L) {
                    val o = (win + w) * 128
                    for (k in c.swb[s] until c.swb[s + 1]) r[o + k] = l[o + k] * sc
                }
            }
            win += L
        }
    }

    private fun tnsDecode(ics: Ics, spec: DoubleArray) {
        val t = ics.tns
        if (!t.present) return
        val short = ics.windowSequence == EIGHT_SHORT; val tmax = if (short) TNS_MAX_SFB_SHORT else TNS_MAX_SFB_LONG
        val lpc = DoubleArray(TNS_MAX_ORDER + 1); val tmp = DoubleArray(TNS_MAX_ORDER + 1); val st = DoubleArray(TNS_MAX_ORDER)
        for (w in 0 until ics.numWindows) {
            var bottom = ics.numSwb
            for (f in 0 until t.nFilt[w]) {
                val k = w * 4 + f; val top = bottom
                bottom = max(top - t.length[k], 0)
                val order = min(t.order[k], TNS_MAX_ORDER)
                if (order == 0) continue
                val resBits = 3 + t.coefRes[w]; val bits = resBits - t.compress[k]
                val iq = ((1 shl (resBits - 1)) - 0.5) / (PI / 2); val iqm = ((1 shl (resBits - 1)) + 0.5) / (PI / 2)
                lpc.fill(0.0); lpc[0] = 1.0
                for (m in 1..order) {
                    var v = t.coef[k * 32 + m - 1]
                    if (v and (1 shl (bits - 1)) != 0) v -= 1 shl bits
                    val rc = sin(v / (if (v >= 0) iq else iqm))
                    for (i in 1 until m) tmp[i] = lpc[i] + rc * lpc[m - i]
                    for (i in 1 until m) lpc[i] = tmp[i]
                    lpc[m] = rc
                }
                val start = ics.swb[minOf(bottom, tmax, ics.maxSfb)]; val end = ics.swb[minOf(top, tmax, ics.maxSfb)]
                val size = end - start
                if (size <= 0) continue
                val inc = if (t.direction[k] != 0) -1 else 1; val o = w * 128
                var p = o + (if (t.direction[k] != 0) end - 1 else start)
                st.fill(0.0)
                for (n in 0 until size) {
                    var y = spec[p]
                    for (j in 0 until order) y -= lpc[j + 1] * st[j]
                    for (j in order - 1 downTo 1) st[j] = st[j - 1]
                    st[0] = y; spec[p] = y
                    p += inc
                }
            }
        }
    }

    // IMDCT, windowing with shape switching, overlap-add.
    private fun synth(ics: Ics, spec: DoubleArray, ch: ChannelState): FloatArray {
        val seq = ics.windowSequence; val buf = wbuf; val t = tbuf
        val lp = WIN_LONG[ch.prevShape]; val lc = WIN_LONG[ics.windowShape]
        val sp = WIN_SHORT[ch.prevShape]; val sc = WIN_SHORT[ics.windowShape]
        if (seq == EIGHT_SHORT) {
            buf.fill(0.0)
            val s = sbuf
            for (w in 0 until 8) {
                shortT.run(spec, w * 128, s)
                val rise = if (w == 0) sp else sc; val o = 448 + 128 * w
                for (n in 0 until 128) { buf[o + n] += s[n] * rise[n]; buf[o + 128 + n] += s[128 + n] * sc[127 - n] }
            }
        } else {
            longT.run(spec, 0, t)
            if (seq == LONG_STOP) {
                for (n in 0 until 448) buf[n] = 0.0
                for (n in 0 until 128) buf[448 + n] = t[448 + n] * sp[n]
                for (n in 576 until 1024) buf[n] = t[n]
            } else {
                for (n in 0 until 1024) buf[n] = t[n] * lp[n]
            }
            if (seq == LONG_START) {
                for (n in 1024 until 1472) buf[n] = t[n]
                for (n in 0 until 128) buf[1472 + n] = t[1472 + n] * sc[127 - n]
                for (n in 1600 until 2048) buf[n] = 0.0
            } else {
                for (n in 0 until 1024) buf[1024 + n] = t[1024 + n] * lc[1023 - n]
            }
        }
        val out = FloatArray(1024); val ov = ch.overlap
        for (n in 0 until 1024) { out[n] = ((ov[n] + buf[n]) / 32768).toFloat(); ov[n] = buf[1024 + n] }
        ch.prevShape = ics.windowShape
        return out
    }
}
