package com.rocketgod.mayhem.core.audio

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

data class RdsState(
    val pi: Int?, val ps: String, val rt: String, val pty: Int?, val ptyName: String,
    val tp: Boolean, val ta: Boolean, val ms: Boolean, val groups: Int, val errors: Int, val synced: Boolean, val af: List<Double>,
)

/** RDS (European) programme type names, index 0..31. */
val PTY_NAMES = listOf(
    "None", "News", "Current Affairs", "Information", "Sport", "Education", "Drama", "Culture", "Science", "Varied",
    "Pop Music", "Rock Music", "Easy Listening", "Light Classical", "Serious Classical", "Other Music", "Weather",
    "Finance", "Children's", "Social Affairs", "Religion", "Phone In", "Travel", "Leisure", "Jazz Music",
    "Country Music", "National Music", "Oldies Music", "Folk Music", "Documentary", "Alarm Test", "Alarm",
)

const val OFFSET_A = 0x0fc
const val OFFSET_B = 0x198
const val OFFSET_C = 0x168
const val OFFSET_CP = 0x350
const val OFFSET_D = 0x1b4
private const val POLY = 0x5b9      // x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1

/** Remainder of a 26-bit block modulo the generator. For an undamaged block this is the block's offset word. */
fun rdsSyndrome(block: Int): Int {
    var r = 0
    for (i in 25 downTo 0) {
        r = (r shl 1) or ((block ushr i) and 1)
        if (r and 0x400 != 0) r = r xor POLY
    }
    return r
}

/** The 10-bit checkword that goes on [data] (16 bits) for a block carrying [offset]. */
fun rdsCheckword(data: Int, offset: Int): Int = rdsSyndrome((data and 0xffff) shl 10) xor offset

/** 6th-order Butterworth lowpass: three second-order sections. */
internal class Lowpass6(cutoffHz: Double, rate: Double) {
    private val b0 = DoubleArray(3); private val b1 = DoubleArray(3); private val b2 = DoubleArray(3)
    private val a1 = DoubleArray(3); private val a2 = DoubleArray(3)
    private val z1 = DoubleArray(3); private val z2 = DoubleArray(3)
    init {
        val w0 = 2 * Math.PI * min(0.45 * rate, cutoffHz) / rate; val c = cos(w0)
        for ((k, q) in doubleArrayOf(1.9319, 0.7071, 0.5176).withIndex()) {
            val alpha = sin(w0) / (2 * q); val a0 = 1 + alpha
            b0[k] = (1 - c) / 2 / a0; b1[k] = (1 - c) / a0; b2[k] = (1 - c) / 2 / a0; a1[k] = -2 * c / a0; a2[k] = (1 - alpha) / a0
        }
    }
    fun push(x0: Double): Double {
        var x = x0
        for (k in 0 until 3) {
            val y = b0[k] * x + z1[k]
            z1[k] = b1[k] * x - a1[k] * y + z2[k]
            z2[k] = b2[k] * x - a2[k] * y
            x = y
        }
        return x
    }
}

/**
 * RDS decoder, fed with the FM discriminator's composite signal.
 *
 * The 57 kHz subcarrier is brought to baseband by a fixed oscillator at the full rate, filtered to the ±2.4 kHz the
 * standard allots it and decimated to about 40 kHz; only there does a Costas loop take out the residual phase and
 * frequency error, where it costs nothing. The pilot is not used, so a mono station carrying RDS decodes the same.
 *
 * Symbol recovery works on half-symbols: biphase guarantees a crossing mid-bit, so a half-symbol integrate-and-dump
 * nudged by the crossings never starves for timing. Which half begins a bit is decided by scoring both pairings (the
 * right one has halves of opposite sign every bit); the halves are differenced and differentially decoded, which
 * makes the chain indifferent to polarity and to the loop's 180° ambiguity.
 *
 * Block sync uses the syndrome: the remainder of an undamaged block is its offset word, so a sliding window finds the
 * group boundary without knowing the data. Sync rides out about a second of bad blocks before it is dropped.
 */
class RdsDecoder(private val emit: (RdsState) -> Unit) {
    private var rate = 0

    private var rotRe = 1.0; private var rotIm = 0.0; private var stepRe = 1.0; private var stepIm = 0.0; private var rotCount = 0
    private var lpI = Lowpass6(2400.0, 250000.0); private var lpQ = Lowpass6(2400.0, 250000.0)
    private var decim = 1; private var decimCount = 0

    private var agc = 0.0; private var agcK = 0.0
    private var phase = 0.0; private var freq = 0.0; private var alpha = 0.0; private var beta = 0.0; private var maxFreq = 0.0

    private var hPhase = 0.0; private var hInc = 0.0; private var hAcc = 0.0; private var lastPos = false; private var hFirst = true
    private var prevHalf = 0.0; private var halfParity = 0
    private var align = 0; private val score = DoubleArray(2); private var flipCount = 0
    private var prevSym = 0

    private var shift = 0; private var bitsSince = 0; private var expect = 0; private var badRun = 0
    private val blocks = IntArray(4)
    private val good = BooleanArray(4)
    private var cPrime = false

    private var pi: Int? = null; private var piCandidate = -1
    private var pty: Int? = null; private var tp = false; private var ta = false; private var ms = false
    private val psChars = IntArray(8)
    private val rtChars = IntArray(64)
    // PS is assembled a whole frame at a time: stations scroll titles through the name a frame a second, so writing
    // segments as they land would show a blend of two frames. A name that keeps changing is a scroll and is hidden.
    private val psBuild = IntArray(8); private var psMask = 0; private var psAny = false
    private val psLast = IntArray(8); private var psHaveLast = false
    private var psStreak = 0; private var psChanges = 0; private var psScrolls = false
    private var rtWidth = 4

    private sealed class Pending {
        class Ps(val seg: Int, val key: Int) : Pending()
        class Rt(val seg: Int, val width: Int, val key: Int, val ab: Int) : Pending()
    }
    /** The text of the group that proposed a new PI, applied once a second group confirms the station. */
    private var pending: Pending? = null
    private var ps = "        "; private var rt = ""; private var abFlag = -1
    private val af = ArrayList<Double>()
    private var groups = 0; private var errors = 0; private var synced = false

    private var dirty = false; private var sinceEmit = 0; private var emitEvery = 0

    init { clearText() }

    fun reset() {
        rate = 0
        dropSync()
        pi = null; piCandidate = -1; pty = null; tp = false; ta = false; ms = false
        abFlag = -1; clearText(); af.clear(); pending = null
        groups = 0; errors = 0
        dirty = false; sinceEmit = 0
    }

    val state: RdsState get() = RdsState(pi, ps, rt, pty, pty?.let { PTY_NAMES[it] } ?: "", tp, ta, ms, groups, errors, synced, af.toList())

    /** FM-discriminator composite (MPX) samples at [rate] Hz. Amplitude is arbitrary. */
    fun push(mpx: FloatArray, n: Int, rate: Int) {
        if (rate != this.rate) configure(rate)
        for (k in 0 until n) {
            val x = mpx[k].toDouble()
            val i = x * rotRe; val q = -x * rotIm
            val re = rotRe * stepRe - rotIm * stepIm
            val im = rotRe * stepIm + rotIm * stepRe
            rotRe = re; rotIm = im
            if (++rotCount >= 4096) { rotCount = 0; val g = 1 / sqrt(re * re + im * im); rotRe *= g; rotIm *= g }
            val fi = lpI.push(i); val fq = lpQ.push(q)
            if (++decimCount >= decim) { decimCount = 0; baseband(fi, fq) }
            sinceEmit++
        }
        if (dirty && sinceEmit >= emitEvery) flush()
    }

    private fun configure(rate: Int) {
        this.rate = rate
        val w = 2 * Math.PI * 57000 / rate
        stepRe = cos(w); stepIm = sin(w); rotRe = 1.0; rotIm = 0.0; rotCount = 0
        lpI = Lowpass6(2400.0, rate.toDouble()); lpQ = Lowpass6(2400.0, rate.toDouble())
        // A little under 40 kHz: about 16 samples per half-symbol, enough for the timing loop to steer by.
        decim = max(1, floor(rate / 38000.0).toInt()); decimCount = 0
        val decRate = rate.toDouble() / decim
        agc = 0.0; agcK = 1 / (0.05 * decRate)
        // Second-order loop, critically damped, sized for the Costas detector's gain of A²/2 at unit amplitude.
        val zeta = 0.707; val theta = (LOOP_BW / decRate) / (zeta + 1 / (4 * zeta))
        val denom = 1 + 2 * zeta * theta + theta * theta; val kp = 0.5
        alpha = (4 * zeta * theta / denom) / kp
        beta = (4 * theta * theta / denom) / kp
        maxFreq = 2 * Math.PI * 400 / decRate
        phase = 0.0; freq = 0.0
        hInc = 2 * BAUD / decRate; hPhase = 0.0; hAcc = 0.0; hFirst = true
        prevHalf = 0.0; halfParity = 0; align = 0; score[0] = 0.0; score[1] = 0.0; flipCount = 0
        prevSym = 0
        emitEvery = rate / 4
        dropSync()
    }

    private fun baseband(i0: Double, q0: Double) {
        val mag = sqrt(i0 * i0 + q0 * q0)
        if (agc == 0.0) agc = mag else agc += (mag - agc) * agcK
        val g = 1 / max(agc, 1e-12)
        val i = i0 * g; val q = q0 * g
        val c = cos(phase); val s = sin(phase)
        val ii = i * c + q * s; val qq = q * c - i * s
        val e = (ii * qq).coerceIn(-1.0, 1.0)
        freq = (freq + beta * e).coerceIn(-maxFreq, maxFreq)
        phase += freq + alpha * e
        if (phase > Math.PI) phase -= 2 * Math.PI else if (phase < -Math.PI) phase += 2 * Math.PI

        val pos = ii > 0
        if (!hFirst && pos != lastPos) {
            val err = if (hPhase < 0.5) hPhase else hPhase - 1
            hPhase -= err * HALF_GAIN
        }
        hFirst = false; lastPos = pos
        hAcc += ii
        hPhase += hInc
        if (hPhase >= 1) { hPhase -= 1; val h = hAcc; hAcc = 0.0; onHalf(h) }
    }

    private fun onHalf(h: Double) {
        val prev = prevHalf; prevHalf = h
        val a = halfParity; halfParity = halfParity xor 1
        score[a] = score[a] * 0.95 + (abs(prev - h) - abs(prev + h))
        if (a != align) return
        val sym = if (prev - h > 0) 1 else 0
        val bit = sym xor prevSym
        prevSym = sym
        onBit(bit)
        if (score[a xor 1] > score[a]) {
            if (++flipCount >= ALIGN_FLIP) { align = align xor 1; flipCount = 0 }
        } else flipCount = 0
    }

    private fun wanted(slot: Int, s: Int) = when (slot) {
        0 -> s == OFFSET_A
        1 -> s == OFFSET_B
        2 -> s == OFFSET_C || s == OFFSET_CP
        else -> s == OFFSET_D
    }

    private fun onBit(bit: Int) {
        shift = ((shift shl 1) or bit) and 0x3ffffff
        bitsSince++
        if (!synced) {
            if (expect == 0) {
                if (rdsSyndrome(shift) == OFFSET_A) { blocks[0] = shift ushr 10; expect = 1; bitsSince = 0 }
                return
            }
            if (bitsSince < 26) return
            bitsSince = 0
            val s = rdsSyndrome(shift)
            if (wanted(expect, s)) {
                blocks[expect] = shift ushr 10
                if (expect == 2) cPrime = s == OFFSET_CP
                if (++expect == 4) {
                    expect = 0; synced = true; badRun = 0
                    good.fill(true)
                    processGroup()
                    flush()
                }
            } else if (s == OFFSET_A) { blocks[0] = shift ushr 10; expect = 1 }
            else expect = 0
            return
        }
        if (bitsSince < 26) return
        bitsSince = 0
        val s = rdsSyndrome(shift)
        val ok = wanted(expect, s)
        good[expect] = ok
        blocks[expect] = shift ushr 10
        if (expect == 2) cPrime = s == OFFSET_CP
        if (ok) badRun = 0
        else {
            errors++
            if (++badRun >= SYNC_LOSS) { dropSync(); flush(); return }
        }
        if (++expect == 4) { expect = 0; processGroup() }
    }

    private fun dropSync() { synced = false; expect = 0; bitsSince = 0; badRun = 0; shift = 0; good.fill(false) }

    private fun processGroup() {
        val a = blocks[0]; val b = blocks[1]; val c = blocks[2]; val d = blocks[3]
        if (good[0] && good[1] && good[2] && good[3]) groups++
        // A group naming another station must not write into this one's texts; one whose PI block failed is far more
        // likely this station in a fade, so it is still used. The group that first proposes a new PI is kept aside and
        // applied once a second confirms it, so the first thing heard after a retune is not thrown away.
        if (good[0]) {
            val adopted = observePi(a)
            if (a != pi) { pending = if (good[1]) textOf(b, c, d) else null; return }
            if (adopted) pending?.let { applyText(it) }
            pending = null
        } else if (pi == null) return
        if (!good[1]) return

        val type = b shr 12; val versionB = (b shr 11) and 1; val tp = ((b shr 10) and 1) == 1; val pty = (b shr 5) and 0x1f
        if (tp != this.tp) { this.tp = tp; dirty = true }
        if (pty != this.pty) { this.pty = pty; dirty = true }
        if (type == 0) {
            val ta = ((b shr 4) and 1) == 1; val ms = ((b shr 3) and 1) == 1
            if (ta != this.ta) { this.ta = ta; dirty = true }
            if (ms != this.ms) { this.ms = ms; dirty = true }
            if (versionB == 0 && good[2] && !cPrime) observeAf(c shr 8, c and 0xff)
        }
        textOf(b, c, d)?.let { applyText(it) }
    }

    /** A segment counts only when every block carrying it was good: half a segment is not a sighting. */
    private fun textOf(b: Int, c: Int, d: Int): Pending? {
        val type = b shr 12; val versionB = ((b shr 11) and 1) == 1
        if (type == 0) return if (good[3]) Pending.Ps(b and 3, d) else null
        if (type != 2) return null
        val seg = b and 0xf; val ab = (b shr 4) and 1
        if (versionB) return if (good[3]) Pending.Rt(seg, 2, d, ab) else null
        return if (good[2] && good[3]) Pending.Rt(seg, 4, (c shl 16) or d, ab) else null
    }

    private fun applyText(t: Pending) {
        when (t) {
            is Pending.Ps -> seePs(t.seg, t.key)
            is Pending.Rt -> {
                // A toggled flag says the text that follows is unrelated; the old text stays until the new is in.
                if (t.ab != abFlag) { if (abFlag >= 0) clearRt(); abFlag = t.ab }
                seeRt(t.seg, t.width, t.key)
            }
        }
    }

    /** A wrong PI would wipe the texts, so a new one has to arrive twice running before it is believed. */
    private fun observePi(p: Int): Boolean {
        if (p == pi) { piCandidate = -1; return false }
        if (p != piCandidate) { piCandidate = p; return false }
        pi = p; piCandidate = -1
        clearText(); af.clear(); abFlag = -1
        dirty = true
        return true
    }

    private fun observeAf(hi: Int, lo: Int) {
        if (hi == 250) return                // announces one LF/MF frequency, not a VHF code
        addAf(hi); addAf(lo)
    }

    private fun addAf(code: Int) {
        if (code < 1 || code > 204) return   // 1..204 are VHF channels; the rest are filler, counts or unassigned
        val f = (875 + code) / 10.0
        if (f in af || af.size >= 25) return
        af.add(f); af.sort()
        dirty = true
    }

    private fun seePs(seg: Int, key: Int) {
        val bit = 1 shl seg
        if (psMask and bit != 0) { psMask = 0; psBuild.fill(0x20) }
        psBuild[2 * seg] = (key shr 8) and 0xff; psBuild[2 * seg + 1] = key and 0xff
        psMask = psMask or bit
        if (psMask != 0b1111) return
        psMask = 0
        var same = psHaveLast
        for (i in 0 until 8) if (same && psBuild[i] != psLast[i]) same = false
        if (psHaveLast && !same) { psStreak = 0; if (++psChanges >= 3) psScrolls = true }
        else if (++psStreak >= 4) psChanges = 0
        psBuild.copyInto(psLast); psHaveLast = true
        if (psScrolls) {
            if (psAny) { psAny = false; psChars.fill(0x20); refreshPs() }
            psBuild.fill(0x20); return
        }
        if (psStreak >= 2) {
            var changed = !psAny
            for (i in 0 until 8) if (psChars[i] != psBuild[i]) { psChars[i] = psBuild[i]; changed = true }
            psAny = true
            if (changed) refreshPs()
        }
        psBuild.fill(0x20)
    }

    private fun seeRt(seg: Int, width: Int, key: Int) {
        if (width != rtWidth) { clearRt(); rtWidth = width }
        val base = seg * width
        if (base + width > 64) return
        if (width == 4) {
            rtChars[base] = (key ushr 24) and 0xff; rtChars[base + 1] = (key ushr 16) and 0xff
            rtChars[base + 2] = (key ushr 8) and 0xff; rtChars[base + 3] = key and 0xff
        } else { rtChars[base] = (key shr 8) and 0xff; rtChars[base + 1] = key and 0xff }
        refreshRt()
    }
    private fun clearRt() = rtChars.fill(0x20)
    private fun clearText() {
        psChars.fill(0x20); psBuild.fill(0x20); psMask = 0; psAny = false; psLast.fill(0x20); psHaveLast = false
        psStreak = 0; psChanges = 0; psScrolls = false
        clearRt(); rtWidth = 4
        ps = "        "; rt = ""
    }

    private fun charOf(c: Int) = if (c in 0x20..0x7e) c.toChar() else ' '
    private fun refreshPs() {
        val s = buildString { for (i in 0 until 8) append(charOf(psChars[i])) }
        if (s != ps) { ps = s; dirty = true }
    }
    private fun refreshRt() {
        val s = buildString { for (i in 0 until 64) { val c = rtChars[i]; if (c == 0x0d) break; append(charOf(c)) } }.trimEnd()
        if (s != rt) { rt = s; dirty = true }
    }

    private fun flush() { dirty = false; sinceEmit = 0; emit(state) }

    private companion object {
        const val BAUD = 1187.5
        const val SYNC_LOSS = 50
        const val HALF_GAIN = 0.1
        const val LOOP_BW = 40.0
        const val ALIGN_FLIP = 8
    }
}
