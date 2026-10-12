package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.HdlcFramer
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * APRS receiver (Mayhem proc_aprsrx + aprs_packet.hpp): Bell 202 AFSK (1200 / 2200 Hz, 1200 baud) on the NFM
 * discriminator, demodulated with a sliding one-bit tone correlator, NRZI + AX.25 (HDLC) framed, FCS-checked,
 * addresses and the information field parsed, uncompressed positions decoded.
 */
class AprsDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true

    private var fmRate = 0
    private var spb = 40
    private var ring = FloatArray(40)
    private var ri = 0
    private var ph1 = 0.0; private var ph2 = 0.0
    private var w1 = 0.0; private var w2 = 0.0
    private var c1 = 0.0; private var s1 = 0.0; private var c2 = 0.0; private var s2 = 0.0
    private var sinceRecompute = 0
    private var sync = BitSync(1200.0, 48000.0)
    private val framer = HdlcFramer(400) { onFrame(it) }

    override fun reset(rate: Int) { fmRate = 0; framer.reset() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    private fun configure(rate: Int) {
        fmRate = rate
        spb = (rate / 1200.0).roundToInt().coerceAtLeast(4)
        ring = FloatArray(spb); ri = 0
        w1 = 2.0 * Math.PI * 1200.0 / rate; w2 = 2.0 * Math.PI * 2200.0 / rate
        ph1 = 0.0; ph2 = 0.0; c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0; sinceRecompute = 0
        sync = BitSync(1200.0, rate.toDouble())
        framer.reset()
    }

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) configure(rate)
        val twoPi = 2.0 * Math.PI
        for (i in 0 until n) {
            val x = samples[i]
            val old = ring[ri]
            ring[ri] = x
            ri = if (ri + 1 >= spb) 0 else ri + 1
            // phase of the sample leaving the window = current phase - spb*w (mod 2π)
            var o1 = ph1 - w1 * spb; while (o1 < 0) o1 += twoPi
            var o2 = ph2 - w2 * spb; while (o2 < 0) o2 += twoPi
            c1 += x * cos(ph1) - old * cos(o1); s1 += x * sin(ph1) - old * sin(o1)
            c2 += x * cos(ph2) - old * cos(o2); s2 += x * sin(ph2) - old * sin(o2)
            ph1 += w1; if (ph1 >= twoPi) ph1 -= twoPi
            ph2 += w2; if (ph2 >= twoPi) ph2 -= twoPi
            if (++sinceRecompute >= 4096) { sinceRecompute = 0; recompute() }
            val d = ((c1 * c1 + s1 * s1) - (c2 * c2 + s2 * s2)).toFloat()   // mark (1200) positive
            val b = sync.push(d)
            if (b >= 0) framer.pushRaw(b)
        }
    }

    /** Rebuild the running correlator sums from the ring to stop floating-point drift. */
    private fun recompute() {
        val twoPi = 2.0 * Math.PI
        c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0
        for (j in 0 until spb) {
            val v = ring[(ri + j) % spb]                 // oldest first
            var a1 = ph1 - w1 * (spb - j); while (a1 < 0) a1 += twoPi
            var a2 = ph2 - w2 * (spb - j); while (a2 < 0) a2 += twoPi
            c1 += v * cos(a1); s1 += v * sin(a1); c2 += v * cos(a2); s2 += v * sin(a2)
        }
    }

    private fun onFrame(f: ByteArray) {
        if (f.size < 18 || !HdlcFramer.fcsOk(f)) return
        // AX.25 addresses: 7 bytes each, chars shifted left 1; LSB of the last byte marks the final address.
        var p = 0
        val addrs = ArrayList<String>()
        var last = false
        while (!last && p + 7 <= f.size - 2 && addrs.size < 10) {
            val sb = StringBuilder()
            for (k in 0 until 6) { val ch = ((f[p + k].toInt() and 0xff) shr 1).toChar(); if (ch != ' ') sb.append(ch) }
            val ssidByte = f[p + 6].toInt() and 0xff
            val ssid = (ssidByte shr 1) and 0x0f
            if (ssid != 0) sb.append('-').append(ssid)
            if (addrs.size >= 2 && (ssidByte and 0x80) != 0) sb.append('*')   // digipeated
            last = (ssidByte and 1) != 0
            addrs.add(sb.toString())
            p += 7
        }
        if (addrs.size < 2 || p + 2 > f.size - 2) return
        p += 2   // control + PID
        val info = String(f, p, f.size - 2 - p, Charsets.ISO_8859_1)
        val dest = addrs[0]; val src = addrs[1]
        val path = if (addrs.size > 2) "," + addrs.subList(2, addrs.size).joinToString(",") else ""
        val position = parsePosition(info)
        log.add("$src>$dest$path:$info" + (position?.let { " [%.4f,%.4f]".format(it.first, it.second) } ?: ""))
    }

    /** Uncompressed position reports: !/=/@ + [7-char time] + DDMM.mmN/DDDMM.mmW. */
    private fun parsePosition(info: String): Pair<Double, Double>? {
        if (info.isEmpty()) return null
        var i = when (info[0]) { '!', '=' -> 1; '/', '@' -> 8; else -> return null }
        if (info.length < i + 19) return null
        val lat = info.substring(i, i + 8); val lon = info.substring(i + 9, i + 18)
        return try {
            val la = lat.substring(0, 2).toInt() + lat.substring(2, 7).toDouble() / 60.0
            val lo = lon.substring(0, 3).toInt() + lon.substring(3, 8).toDouble() / 60.0
            val laS = if (lat[7] == 'S') -la else la
            val loS = if (lon[8] == 'W') -lo else lo
            laS to loS
        } catch (e: Exception) { null }
    }
}
