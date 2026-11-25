package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.ham.hamSyncSigns
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * The cheap first look Repeaters takes at every open channel, so a plain analog channel costs about what it did before
 * the identity layer: symbols at 4800/s from the discriminator summed over one symbol ([LightSymbols]), and the 2400/s
 * ones as each pair of them (both pairings watched), each sync word held as its signs (and, for the syncs sent on the
 * outer levels only, those too) in a 32-bit register, matched by XOR. A mode wakes the channel's full decoders once its
 * sync came twice a whole number of frames apart (Framing.kt), three times for the syncs matched on their signs alone
 * (Fusion, D-STAR's data sync, NXDN) and M17's short one, or once for the long syncs no other signal carries by chance
 * (the D-STAR header's frame sync after its preamble, the dPMR header's FS1). P25 Phase 2 has no sync here. The same as
 * the web's dsp/hamid/sniffer.ts.
 */

/** Takes each symbol (an interface, not a function type: a (Double) -> Unit boxes every symbol on Android). */
fun interface SymbolSink { fun symbol(s: Double) }

/** Symbols for sync matching only: summed over one symbol, nearest sample, timing of four picked a block, mean levels. */
class LightSymbols(val fs: Double, val baud: Double) {
    var onSymbol: SymbolSink = SymbolSink { }
    private val sps = fs / baud; private val L = max(1, sps.roundToInt()); private val ring = DoubleArray(L); private var rp = 0; private var acc = 0.0
    private var buf = DoubleArray(ceil(sps * 244).toInt() + 8); private var n = 0; private var base = 0L; private var tNext = 0.0
    private var center = 0.0; private var level = 0.0
    fun reset() { ring.fill(0.0); rp = 0; acc = 0.0; n = 0; base = 0; tNext = 0.0; center = 0.0; level = 0.0 }
    fun push(x: FloatArray, count: Int) {
        val need = ceil(sps * 242).toInt() + 2
        for (k in 0 until count) {
            val v = x[k].toDouble(); acc += v - ring[rp]; ring[rp] = v; if (++rp >= L) rp = 0
            buf[n++] = acc
            if (n >= need) block()
        }
    }
    private fun block() {
        val T = sps; val nsym = 240; val b = buf
        var best = 0.0; var bestE = -1.0
        for (p in 0 until 4) {
            val off = p * T / 4; var e = 0.0
            for (k in 0 until nsym) { val y = b[(off + k * T).roundToInt()] - center; e += y * y }
            if (e > bestE) { bestE = e; best = off }
        }
        val t0 = tNext - base; var k0 = ceil((t0 - T / 2 - best) / T).toInt(); if (k0 < 0) k0 = 0
        var t = best + k0 * T; var sum = 0.0; var cnt = 0
        val len = nsym * T
        var u = t; while (u < len) { sum += b[u.roundToInt()]; cnt++; u += T }
        val c = if (cnt > 0) sum / cnt else 0.0; var dev = 0.0
        u = t; while (u < len) { dev += abs(b[u.roundToInt()] - c); u += T }
        dev = if (cnt > 0) dev / cnt else 0.0
        if (dev > 1e-9) { center = if (level > 0) center + 0.5 * (c - center) else c; level = if (level > 0) level + 0.5 * (dev - level) else dev }
        // a 4FSK symbol's mean distance from the center is two (levels ±1 and ±3)
        val sc = if (level > 0) 2 / level else 1.0
        val sink = onSymbol
        while (t < len) { sink.symbol((b[t.roundToInt()] - center) * sc); t += T }
        tNext = base + t
        val used = len.toInt()
        System.arraycopy(b, used, b, 0, n - used); n -= used; base += used
    }
}

private class SnPat(val mode: String, val sign: Int, val mask: Int, val outer: Boolean, val n: Int, val tol: Int, val both: Boolean, val single: Boolean, val need: Int)
private fun snPat(mode: String, v: DoubleArray, outer: Boolean = false, tol: Int = 1, both: Boolean = false, single: Boolean = false, need: Int = if (outer) 2 else 3): SnPat {
    var sign = 0; for (x in v) sign = (sign shl 1) or (if (x > 0) 1 else 0)
    val n = v.size; val mask = if (n >= 32) -1 else (1 shl n) - 1
    return SnPat(mode, sign, mask, outer, n, tol, both, single, need)
}
private fun ints(a: IntArray) = DoubleArray(a.size) { a[it].toDouble() }
private fun floats(a: FloatArray) = DoubleArray(a.size) { a[it].toDouble() }
private fun snSigns(s: String) = DoubleArray(s.length) { if (s[it] == '1') 1.0 else -1.0 }

/** A pattern list arranged for speed: outer-level groups by mask, exact sign patterns in maps, the rest one by one. */
private class Matcher(list: List<SnPat>) {
    class Outer(val mask: Int, val need: Int, val pats: ArrayList<SnPat> = ArrayList())
    /** Exact sign patterns of one mask: their signs and patterns side by side (a map would box every lookup). */
    class Exact(val mask: Int) { var signs = IntArray(0); val pats = ArrayList<SnPat>(); fun put(sign: Int, p: SnPat) { signs += sign; pats.add(p) } }
    val outer = ArrayList<Outer>(); val exact = ArrayList<Exact>(); val loose = ArrayList<SnPat>()
    init {
        for (p in list) {
            if (p.outer) (outer.firstOrNull { it.mask == p.mask } ?: Outer(p.mask, p.n - if (p.n >= 16) 2 else 0).also { outer.add(it) }).pats.add(p)
            else if (p.tol == 0) { val g = exact.firstOrNull { it.mask == p.mask } ?: Exact(p.mask).also { exact.add(it) }; g.put(p.sign, p); if (p.both) g.put(p.sign.inv() and p.mask, p) }
            else loose.add(p)
        }
    }
}

private val PERIOD = mapOf("DMR" to 144, "D-STAR" to 2016, "YSF" to 480, "P25" to 72, "NXDN" to 192, "M17" to 192, "dPMR" to 384)
private val P48 = Matcher(
    hamSyncSigns("DMR").map { snPat("DMR", ints(it), outer = true) } +
        listOf(snPat("P25", ints(hamSyncSigns("P25")[0]), outer = true, both = true), snPat("YSF", YSF_SYNC, both = true),
            snPat("D-STAR", snSigns("1010101010101010$DSTAR_FS"), both = true, single = true), snPat("D-STAR", snSigns(DSTAR_DSYNC), both = true)) +
        listOf(M17_SYNC_LSF, M17_SYNC_STREAM, M17_SYNC_PACKET).map { snPat("M17", m17SyncSymbols(it), outer = true, tol = 0, both = true, need = 3) } +
        hamSyncSigns("NXDN").map { snPat("NXDN", ints(it), both = true, tol = 0) })
private val P24 = Matcher(
    hamSyncSigns("NXDN").map { snPat("NXDN", ints(it), both = true, tol = 0) } +
        listOf(snPat("dPMR", floats(DPMR_FS1), outer = true, both = true, single = true), snPat("dPMR", floats(DPMR_FS2), outer = true, both = true)))

class SyncSniffer(val fs: Double) {
    private val s48 = LightSymbols(fs, 4800.0)
    private var sg48 = 0; private var ou48 = 0; private var t48 = 0L; private var prev = 0.0
    private val sg24 = IntArray(2); private val ou24 = IntArray(2)
    private val last = HashMap<String, Long>(); private val run = HashMap<String, Int>()
    /** The mode that woke the channel, "" until one has. */
    var woke = ""; private set
    init {
        s48.onSymbol = SymbolSink { s ->
            val t = ++t48
            sg48 = (sg48 shl 1) or (if (s > 0) 1 else 0); ou48 = (ou48 shl 1) or (if (s > 2 || s < -2) 1 else 0)
            look(P48, sg48, ou48, t)
            // a 2400/s symbol is two of these summed (half the level each): the pairing ending on odd and on even ones
            val k = (t and 1).toInt(); val v = (s + prev) / 2; prev = s
            sg24[k] = (sg24[k] shl 1) or (if (v > 0) 1 else 0); ou24[k] = (ou24[k] shl 1) or (if (v > 2 || v < -2) 1 else 0)
            look(P24, sg24[k], ou24[k], t)
        }
    }
    fun reset() { s48.reset(); sg48 = 0; ou48 = 0; t48 = 0; prev = 0.0; sg24.fill(0); ou24.fill(0); last.clear(); run.clear(); woke = "" }
    fun push(disc: FloatArray, n: Int) = s48.push(disc, n)
    private fun look(m: Matcher, sg: Int, ou: Int, t: Long) {
        val O = m.outer; for (i in O.indices) { val g = O[i]; if (Integer.bitCount(ou and g.mask) < g.need) continue; val ps = g.pats; for (j in ps.indices) tryPat(ps[j], sg, t) }
        val E = m.exact
        for (i in E.indices) { val g = E[i]; val v = sg and g.mask; val sgs = g.signs; for (j in sgs.indices) if (sgs[j] == v) { hit(g.pats[j], t); break } }
        val L = m.loose; for (i in L.indices) tryPat(L[i], sg, t)
    }
    /** No bits wrong, or one when the pattern allows it, either polarity when it may be inverted. */
    private fun tryPat(p: SnPat, sg: Int, t: Long) {
        val x = (sg xor p.sign) and p.mask
        if (x == 0 || (p.tol > 0 && (x and (x - 1)) == 0)) { hit(p, t); return }
        if (!p.both) return
        val y = (sg.inv() xor p.sign) and p.mask
        if (y == 0 || (p.tol > 0 && (y and (y - 1)) == 0)) hit(p, t)
    }
    private fun hit(p: SnPat, t: Long) {
        val prevT = last[p.mode]
        if (prevT != null && t - prevT < 8) return
        last[p.mode] = t
        val r = if (prevT != null && onGrid(t - prevT, PERIOD.getValue(p.mode))) (run[p.mode] ?: 1) + 1 else 1
        run[p.mode] = r
        if (woke.isEmpty() && (p.single || r >= p.need)) woke = p.mode
    }
}
