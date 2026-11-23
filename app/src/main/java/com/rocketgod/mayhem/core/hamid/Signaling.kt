package com.rocketgod.mayhem.core.hamid

import kotlin.math.PI
import kotlin.math.cos

/**
 * Repeater signaling beyond the callsigns: D-STAR header flags (data or voice, repeater or direct, BREAK, control,
 * EMR, function), what a D-STAR URCALL asks for (CQ, a routed call, link, unlink, echo, info, the reflector named),
 * and DTMF digits in an FM channel's audio. The same as the web's dsp/hamid/signaling.ts.
 */
data class DStarFlags(val data: Boolean, val repeater: Boolean, val interrupted: Boolean, val control: Boolean, val urgent: Boolean, val func: String)
private val FUNCS = listOf("", "relay unavailable", "no reply", "ACK", "resend", "unused", "auto reply", "repeater control")
fun dstarFlags(flag1: Int) = DStarFlags((flag1 and 0x80) != 0, (flag1 and 0x40) != 0, (flag1 and 0x20) != 0, (flag1 and 0x10) != 0, (flag1 and 0x08) != 0, FUNCS[flag1 and 7])

data class UrCall(val kind: String, val target: String, val module: String)
private val LINK_RE = Regex("^(REF|XRF|XLX|DCS)(\\d{3})([A-Z])L$")
fun urcallCommand(ur: String): UrCall {
    val f = (ur + "        ").substring(0, 8); val last = f[7]; val head = f.substring(0, 7).trim(); val t = f.trim()
    if (t.isEmpty()) return UrCall("", "", "")
    if (t.startsWith("CQCQCQ")) return UrCall("cq", "", "")
    if (f[0] == '/') return UrCall("repeater", f.substring(1, 7).trim(), last.toString().trim())
    if (head.isEmpty() && last == 'U') return UrCall("unlink", "", "")
    if (head.isEmpty() && last == 'E') return UrCall("echo", "", "")
    if (head.isEmpty() && last == 'I') return UrCall("info", "", "")
    LINK_RE.find(t.replace(" ", ""))?.let { return UrCall("link", it.groupValues[1] + it.groupValues[2], it.groupValues[3]) }
    return UrCall("callsign", t, "")
}

class DtmfEvent(val digit: String, val atS: Double)

class DtmfDecoder(val fs: Double) {
    var onDigit: (DtmfEvent) -> Unit = {}
    val digits = ArrayList<DtmfEvent>()
    private val N = Math.round(fs * 0.02).toInt()
    private val coef = (ROWS + COLS).map { f -> 2 * cos(2 * PI * Math.round(f * N / fs) / N) }.toDoubleArray()
    private val s1 = DoubleArray(8); private val s2 = DoubleArray(8)
    private var n = 0; private var blocks = 0; private var energy = 0.0
    private var last = ""; private var run = 0; private var held = ""
    fun reset() { s1.fill(0.0); s2.fill(0.0); n = 0; blocks = 0; energy = 0.0; last = ""; run = 0; held = ""; digits.clear() }
    fun push(x: FloatArray, count: Int) {
        for (i in 0 until count) {
            val v = x[i].toDouble(); energy += v * v
            for (k in 0 until 8) { val s = v + coef[k] * s1[k] - s2[k]; s2[k] = s1[k]; s1[k] = s }
            if (++n >= N) block()
        }
    }
    private fun block() {
        val p = DoubleArray(8)
        for (k in 0 until 8) { p[k] = s1[k] * s1[k] + s2[k] * s2[k] - coef[k] * s1[k] * s2[k]; s1[k] = 0.0; s2[k] = 0.0 }
        val total = energy * N / 2; energy = 0.0; n = 0; blocks++
        var r = 0; var c = 4; for (k in 1 until 4) if (p[k] > p[r]) r = k; for (k in 5 until 8) if (p[k] > p[c]) c = k
        var key = ""
        val pr = p[r]; val pc = p[c]
        if (pr > 0 && pc > 0 && (pr + pc) > 0.6 * total && pr < 6.3 * pc && pc < 6.3 * pr) {
            var clear = true
            for (k in 0 until 4) if (k != r && p[k] * 10 > pr) clear = false
            for (k in 4 until 8) if (k != c && p[k] * 10 > pc) clear = false
            if (clear) key = KEYS[r][c - 4].toString()
        }
        if (key.isNotEmpty() && key == last) run++ else run = if (key.isNotEmpty()) 1 else 0
        last = key
        if (key.isEmpty()) { held = ""; return }
        if (run == 2 && held != key) { held = key; val e = DtmfEvent(key, (blocks - 2) * N / fs); digits.add(e); onDigit(e) }
    }
    val text: String get() = digits.joinToString("") { it.digit }
    private companion object {
        val ROWS = listOf(697.0, 770.0, 852.0, 941.0); val COLS = listOf(1209.0, 1336.0, 1477.0, 1633.0)
        val KEYS = listOf("123A", "456B", "789C", "*0#D")
    }
}
