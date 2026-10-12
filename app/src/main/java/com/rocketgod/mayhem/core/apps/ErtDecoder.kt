package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.sqrt

/**
 * ERT utility-meter receiver (Mayhem proc_ert + ert_packet.cpp, rtlamr): Itron SCM / SCM+ / IDM packets, OOK
 * Manchester at 32.768 kbaud around 915 MHz. Magnitude → adaptive slicer for symbol timing (Manchester edges land
 * on symbol boundaries and mid-symbol) → half-symbol energy comparison → bit stream → preamble match → BCH / CRC
 * check → fields.
 */
class ErtDecoder(private val log: PacketLog) : IqProcessor {
    private var spb = 61.0
    private var phase = 0.0
    private var hSum = 0f
    private var h1 = 0f
    private var envMax = 10f
    private var envMin = 0f
    private var lastAbove = false
    private var dcI = 127.4f; private var dcQ = 127.4f
    private var bits = 0L
    private var collecting = TYPE_NONE
    private var idmCandidate = false
    private val buf = ByteArray(704)
    private var count = 0

    override fun reset(rate: Int) {
        spb = rate / 32768.0
        phase = 0.0; hSum = 0f; h1 = 0f; envMax = 10f; envMin = 0f; lastAbove = false
        bits = 0L; collecting = TYPE_NONE; count = 0
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val nSamp = len / 2
        // DC offset: track the buffer mean slowly (Mayhem averages the same way).
        var sI = 0f; var sQ = 0f
        for (i in 0 until nSamp) { sI += (iq[2 * i].toInt() and 0xff); sQ += (iq[2 * i + 1].toInt() and 0xff) }
        dcI += 0.2f * (sI / nSamp - dcI); dcQ += 0.2f * (sQ / nSamp - dcQ)
        val inc = 1.0 / spb
        for (i in 0 until nSamp) {
            val iv = (iq[2 * i].toInt() and 0xff) - dcI
            val qv = (iq[2 * i + 1].toInt() and 0xff) - dcQ
            val mag = sqrt(iv * iv + qv * qv)
            if (mag > envMax) envMax = mag else envMax += (mag - envMax) * 0.0005f
            if (mag < envMin) envMin = mag else envMin += (mag - envMin) * 0.0005f
            val thr = (envMax + envMin) * 0.5f
            val above = mag > thr
            if (above != lastAbove) {
                // Edge: should sit on a symbol boundary (phase 0) or mid-symbol (0.5). Pull toward the nearest.
                val target = if (phase < 0.25 || phase >= 0.75) 0.0 else 0.5
                var err = phase - target
                if (err > 0.5) err -= 1.0
                phase -= err * 0.15
                if (phase < 0.0) phase += 1.0
            }
            lastAbove = above
            hSum += mag
            val before = phase
            phase += inc
            if (before < 0.5 && phase >= 0.5) { h1 = hSum; hSum = 0f }
            if (phase >= 1.0) {
                phase -= 1.0
                val h2 = hSum; hSum = 0f
                onSymbol(if (h1 > h2) 1 else 0)   // Manchester "10" = 1
            }
        }
    }

    private fun onSymbol(bit: Int) {
        if (collecting == TYPE_NONE) {
            bits = (bits shl 1) or bit.toLong()
            if ((bits and 0x1FFFFFL) == 0x1F2A60L) { collecting = TYPE_SCM; count = 0 }
            else if ((bits and 0xFFFFL) == 0x16A3L) { collecting = TYPE_PLUS; count = 0; idmCandidate = ((bits ushr 16) and 0xFFFFL) == 0x5555L }
            return
        }
        buf[count++] = bit.toByte()
        when (collecting) {
            TYPE_SCM -> if (count >= 75) { checkScm(); collecting = TYPE_NONE; bits = 0L }
            TYPE_PLUS -> {
                if (count == 112 && checkScmPlus()) { collecting = TYPE_NONE; bits = 0L }
                else if (count >= 704) { if (idmCandidate) checkIdm(); collecting = TYPE_NONE; bits = 0L }
            }
        }
    }

    private fun rd(start: Int, len: Int): Long {
        var v = 0L
        for (i in 0 until len) v = (v shl 1) or buf[start + i].toLong()
        return v
    }

    /** CRC over [n] bits, MSB-first, non-reflected. */
    private fun crc16(n: Int, poly: Int, init: Int): Int {
        var crc = init
        for (i in 0 until n) {
            val bit = buf[i].toInt()
            val msb = (crc shr 15) and 1
            crc = ((crc shl 1) and 0xFFFF) or 0
            if ((msb xor bit) != 0) crc = crc xor poly
        }
        return crc and 0xFFFF
    }

    private fun checkScm() {
        // BCH(255,239) poly 0x6F63 over the 5 trailing preamble zeros + 75 bits → leading zeros are a no-op.
        if (crc16(75, 0x6F63, 0) != 0) return
        val id = (rd(0, 2) shl 24) or rd(35, 24)
        val type = rd(5, 4).toInt()
        val consumption = rd(11, 24)
        val tamperPhy = rd(3, 2); val tamperEnc = rd(9, 2)
        log.add("SCM  ID %-10d %-8s cons %d tamper p%d/e%d".format(id, commodity(type), consumption, tamperPhy, tamperEnc))
    }

    private fun checkScmPlus(): Boolean {
        if (crc16(112, 0x1021, 0xFFFF) != 0x1D0F) return false
        val type = rd(12, 4).toInt()
        val id = rd(16, 32)
        val consumption = rd(48, 32)
        val tamper = rd(80, 16)
        log.add("SCM+ ID %-10d %-8s cons %d tamper 0x%04x".format(id, commodity(type), consumption, tamper))
        return true
    }

    private fun checkIdm() {
        if (crc16(704, 0x1021, 0xFFFF) != 0x1D0F) return
        val type = rd(36, 4).toInt()
        val id = rd(40, 32)
        val consumption = rd(200, 32)
        log.add("IDM  ID %-10d %-8s cons %d".format(id, commodity(type), consumption))
    }

    private fun commodity(t: Int): String = when (t) {
        4, 5, 7, 8 -> "electric"
        2, 9, 12 -> "gas"
        3, 11, 13 -> "water"
        else -> "type$t"
    }

    companion object {
        private const val TYPE_NONE = 0
        private const val TYPE_SCM = 1
        private const val TYPE_PLUS = 2
    }
}
