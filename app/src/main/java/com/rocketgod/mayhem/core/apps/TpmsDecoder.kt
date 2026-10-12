package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * TPMS tyre-pressure receiver (Mayhem proc_tpms.cpp + tpms_packet.cpp): three Schrader-family signals on 315 /
 * 433.92 MHz — FSK 19.2 kchip/s (FLM 64/72/80-bit frames), OOK 8.192 kchip/s (Schrader 37-bit) and OOK 8.4 kchip/s
 * (GMC 96-bit). Raw IQ → 500 kHz: a discriminator feeds the FSK chip clock; the magnitude feeds two OOK chip
 * clocks. Chip streams are matched against Mayhem's preambles, Manchester-decoded and checked (CRC-8 / sums).
 */
class TpmsDecoder(private val log: PacketLog) : IqProcessor {
    private var dcI = 127.4f; private var dcQ = 127.4f
    private var dec = 4; private var accI = 0f; private var accQ = 0f; private var accN = 0
    private var prevI = 0f; private var prevQ = 0f
    private var fsk = BitSync(19200.0, 500_000.0)
    private var magAcc = 0f; private var magN = 0
    private val ook8192 = OokChips(125_000.0 / 8192.0)
    private val ook8400 = OokChips(125_000.0 / 8400.0)
    private val bFsk = ChipPacket(0b010101010101010101010101010110, 30, 160)
    private val bOok8192 = ChipPacket(0b010101010101010101011110, 24, 74)
    private val bOok8400 = ChipPacket(0b01010101010101010101010101100101, 32, 152)
    private val seen = HashMap<Long, Long>()

    override fun reset(rate: Int) {
        dec = (rate / 500_000).coerceAtLeast(1)
        val r1 = rate.toDouble() / dec
        fsk = BitSync(19200.0, r1)
        ook8192.spb = r1 / 4 / 8192.0; ook8400.spb = r1 / 4 / 8400.0
        accI = 0f; accQ = 0f; accN = 0; magAcc = 0f; magN = 0
        bFsk.reset(); bOok8192.reset(); bOok8400.reset()
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val nSamp = len / 2
        var sI = 0f; var sQ = 0f
        for (i in 0 until nSamp) { sI += (iq[2 * i].toInt() and 0xff); sQ += (iq[2 * i + 1].toInt() and 0xff) }
        dcI += 0.2f * (sI / nSamp - dcI); dcQ += 0.2f * (sQ / nSamp - dcQ)
        for (i in 0 until nSamp) {
            accI += (iq[2 * i].toInt() and 0xff) - dcI
            accQ += (iq[2 * i + 1].toInt() and 0xff) - dcQ
            if (++accN < dec) continue
            val ci = accI / accN; val cq = accQ / accN; accI = 0f; accQ = 0f; accN = 0
            // FSK: discriminator sign → 19.2 kchip/s clock
            val d = atan2(cq * prevI - ci * prevQ, ci * prevI + cq * prevQ); prevI = ci; prevQ = cq
            val chip = fsk.push(d)
            if (chip >= 0) bFsk.push(chip)?.let { readFsk(it) }
            // OOK: magnitude, averaged ×4 → two chip clocks
            magAcc += sqrt(ci * ci + cq * cq); magN++
            if (magN >= 4) {
                val m = magAcc / magN; magAcc = 0f; magN = 0
                ook8192.push(m)?.let { c -> bOok8192.push(c)?.let { readOok8192(it) } }
                ook8400.push(m)?.let { c -> bOok8400.push(c)?.let { readOok8400(it) } }
            }
        }
    }

    // ---- Mayhem tpms_packet.cpp readings ------------------------------------------------------------------
    private fun readFsk(bits: IntArray) {
        val len = crcValidLength(bits)
        when (len) {
            64 -> report("FLM_64", rd(bits, 0, 32), rd(bits, 32, 8).toInt() * 4 / 3, (rd(bits, 40, 8).toInt() and 0x7f) - 56, null)
            72 -> report("FLM_72", rd(bits, 0, 32), rd(bits, 40, 8).toInt() * 4 / 3, rd(bits, 48, 8).toInt() - 56, null)
            80 -> report("FLM_80", rd(bits, 8, 32), rd(bits, 48, 8).toInt() * 4 / 3, rd(bits, 56, 8).toInt() - 56, null)
        }
    }
    private fun readOok8192(bits: IntArray) {
        val flags = rd(bits, 0, 3).toInt(); val checksum = rd(bits, 35, 2).toInt()
        var calc = rd(bits, 0, 1).toInt()
        var i = 1
        while (i < 37) { calc += rd(bits, i, 2).toInt(); i += 2 }
        if ((calc and 3) == 3) report("Schrader", rd(bits, 3, 24), rd(bits, 27, 8).toInt() * 4 / 3, null, (flags shl 4) or checksum)
    }
    private fun readOok8400(bits: IntArray) {
        val id = rd(bits, 20, 32); val v0 = rd(bits, 52, 8).toInt(); val v1 = rd(bits, 60, 8).toInt(); val checksum = rd(bits, 68, 8).toInt()
        var calc = (0x4 shl 4) or rd(bits, 0, 4).toInt()
        var i = 4
        while (i < 68) { calc += rd(bits, i, 8).toInt(); i += 8 }
        if ((calc and 0xff) == checksum) report("GMC_96", id, v0 * 11 / 4, v1 - 61, null)
    }
    private fun crcValidLength(bits: IntArray): Int {
        val bytes = IntArray(10) { rd(bits, it * 8, 8).toInt() }
        var sum = 0; var crc72 = 0; var crc80 = 0
        for (i in 0 until 10) {
            val b = bytes[i]
            if (i < 7) sum += b
            if (i < 9) crc72 = crc8(crc72, b)
            if (i in 1..9) crc80 = crc8(crc80, b)
        }
        return if (crc80 == 0) 80 else if (crc72 == 0) 72 else if ((sum and 0xff) == bytes[7]) 64 else 0
    }
    /** CRC-8 with truncated polynomial 0x01, as Mayhem's CRC<8>{0x01, 0x00}. */
    private fun crc8(crcIn: Int, byte: Int): Int {
        var crc = crcIn xor byte
        for (k in 0 until 8) crc = if ((crc and 0x80) != 0) ((crc shl 1) xor 0x01) and 0xff else (crc shl 1) and 0xff
        return crc
    }
    private fun rd(bits: IntArray, start: Int, n: Int): Long { var v = 0L; for (i in start until start + n) v = (v shl 1) or (if (i < bits.size) bits[i].toLong() else 0L); return v }

    private fun report(type: String, id: Long, kPa: Int, degC: Int?, flags: Int?) {
        val now = System.currentTimeMillis()
        val key = id xor (type.hashCode().toLong() shl 40)
        val last = seen[key] ?: 0L
        if (now - last < 1500) return   // the same reading repeats several times per burst
        seen[key] = now
        val sb = StringBuilder("TPMS %-8s ID %-10d %08X".format(type, id, id))
        sb.append(" · %d kPa / %.1f psi".format(kPa, kPa * 0.145038))
        if (degC != null) sb.append(" · %d°C / %d°F".format(degC, degC * 9 / 5 + 32))
        if (flags != null) sb.append(" · flags %02X".format(flags))
        log.add(sb.toString())
    }
}

/** OOK chip slicer + clock: leaky peak threshold (Mayhem OOKSlicerMagSquaredInt) and an edge-pulled chip phase. */
class OokChips(var spb: Double) {
    private var phase = 0.0; private var sum = 0f; private var n = 0
    private var thr = 0f; private var lastAbove = false
    fun push(mag: Float): Int? {
        thr = if (mag > thr) mag else thr * (1f - 1f / (8f * spb.toFloat()))
        val above = mag > thr * 0.6f
        if (above != lastAbove) { var err = phase; if (err > 0.5) err -= 1.0; phase -= err * 0.2; if (phase < 0) phase += 1.0 }
        lastAbove = above
        if (above) sum += 1f; n++
        phase += 1.0 / spb
        if (phase >= 1.0) { phase -= 1.0; val chip = if (sum * 2 > n) 1 else 0; sum = 0f; n = 0; return chip }
        return null
    }
}

/** Mayhem PacketBuilder<BitPattern, NeverMatch, FixedLength>: match a chip preamble, collect [payload] chips, Manchester-decode (sense 0). */
class ChipPacket(private val pattern: Long, private val patternBits: Int, private val payload: Int) {
    private var shift = 0L; private var collecting = false; private var count = 0
    private val chips = IntArray(payload)
    private val mask = (1L shl patternBits) - 1
    fun reset() { shift = 0L; collecting = false; count = 0 }
    fun push(chip: Int): IntArray? {
        if (!collecting) {
            shift = ((shift shl 1) or chip.toLong()) and mask
            if (shift == pattern) { collecting = true; count = 0 }
            return null
        }
        chips[count++] = chip
        if (count < payload) return null
        collecting = false; shift = 0L
        val bits = IntArray(payload / 2)
        var errors = 0
        for (i in bits.indices) { bits[i] = chips[2 * i]; if (chips[2 * i] == chips[2 * i + 1]) errors++ }
        return if (errors > payload / 8) null else bits
    }
}
