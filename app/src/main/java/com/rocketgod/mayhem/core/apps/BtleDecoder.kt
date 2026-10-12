package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.ln

/**
 * BLE advertising receiver (Mayhem proc_btlerx): GFSK 1 Mbit/s on channels 37 / 38 / 39, demodulated with the
 * per-sample I/Q cross product (the sign of the phase step), access-address hunt at every sample phase, PDU
 * de-whitening (LFSR verified against Mayhem's scramble table), CRC-24 check, and AD-structure parsing.
 */
class BtleDecoder(private val log: PacketLog) : IqProcessor {
    @Volatile var channel = 37

    private var sps = 2
    private var dcI = 127.4f; private var dcQ = 127.4f
    private var prevI = 0f; private var prevQ = 0f
    private var dRing = FloatArray(2); private var dIdx = 0; private var dSum = 0f
    private var regs = LongArray(2)
    private var state = 0                  // 0 hunting access address, 1 receiving PDU
    private var sampCount = 0
    private var acc = 0f
    private val pdu = ByteArray(48)
    private var byteIdx = 0; private var bitIdx = 0; private var need = 2
    private var lfsr = 0
    private var crcA = 0; private var crcB = 0
    private var pktMaxMag = 0f
    private var bufMaxMag = 0f

    override fun reset(rate: Int) {
        sps = (rate / 1_000_000).coerceAtLeast(1)
        dRing = FloatArray(sps); dIdx = 0; dSum = 0f
        regs = LongArray(sps)
        state = 0; sampCount = 0; acc = 0f
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val nSamp = len / 2
        var sI = 0f; var sQ = 0f; bufMaxMag = 0f
        for (i in 0 until nSamp) {
            val a = (iq[2 * i].toInt() and 0xff); val b = (iq[2 * i + 1].toInt() and 0xff)
            sI += a; sQ += b
            val ma = kotlin.math.abs(a - 127.4f); val mb = kotlin.math.abs(b - 127.4f)
            val mm = if (ma > mb) ma else mb
            if (mm > bufMaxMag) bufMaxMag = mm
        }
        dcI += 0.2f * (sI / nSamp - dcI); dcQ += 0.2f * (sQ / nSamp - dcQ)
        for (i in 0 until nSamp) {
            val iv = (iq[2 * i].toInt() and 0xff) - dcI
            val qv = (iq[2 * i + 1].toInt() and 0xff) - dcQ
            val d = qv * prevI - iv * prevQ          // sign of the phase step (cheap discriminator)
            prevI = iv; prevQ = qv
            if (state == 0) {
                // sliding one-symbol window of d, one shift register per sample phase
                dSum += d - dRing[dIdx]; dRing[dIdx] = d
                val bit = if (dSum > 0f) 1L else 0L
                regs[dIdx] = ((regs[dIdx] ushr 1) or (bit shl 31)) and 0xFFFFFFFFL
                if (regs[dIdx] == ACCESS_ADDRESS) {
                    state = 1; sampCount = 0; acc = 0f; byteIdx = 0; bitIdx = 0; need = 2
                    for (k in pdu.indices) pdu[k] = 0
                    lfsr = 0x40 or channel
                    crcA = 0x555555; crcB = 0xAAAAAA
                    pktMaxMag = bufMaxMag
                    for (k in regs.indices) regs[k] = 0L
                }
                dIdx = if (dIdx + 1 >= sps) 0 else dIdx + 1
            } else {
                acc += d; sampCount++
                if (sampCount >= sps) {
                    sampCount = 0
                    val raw = if (acc > 0f) 1 else 0
                    acc = 0f
                    onBit(raw xor whitenBit())
                }
            }
        }
    }

    private fun whitenBit(): Int {
        val o = lfsr and 1
        lfsr = (lfsr ushr 1) or (o shl 6)
        if (o == 1) lfsr = lfsr xor 0x04
        return o
    }

    private fun crcStep(crc: Int, bit: Int): Int {
        val fb = ((crc shr 23) and 1) xor bit
        var c = (crc shl 1) and 0xFFFFFF
        if (fb == 1) c = c xor 0x00065B
        return c
    }

    private fun onBit(bit: Int) {
        crcA = crcStep(crcA, bit); crcB = crcStep(crcB, bit)
        pdu[byteIdx] = (pdu[byteIdx].toInt() or (bit shl bitIdx)).toByte()
        bitIdx++
        if (bitIdx < 8) return
        bitIdx = 0; byteIdx++
        if (byteIdx == 2) {
            val payloadLen = pdu[1].toInt() and 0x3F
            if (payloadLen < 6 || payloadLen > 37) { state = 0; return }
            need = 2 + payloadLen + 3
        }
        if (byteIdx >= need) {
            if (crcA == 0 || crcB == 0) emit(need - 5)
            state = 0
        }
    }

    private fun emit(payloadLen: Int) {
        val type = pdu[0].toInt() and 0x0F
        val txAdd = (pdu[0].toInt() and 0x40) != 0
        val mac = "%02X:%02X:%02X:%02X:%02X:%02X".format(
            pdu[7].toInt() and 0xff, pdu[6].toInt() and 0xff, pdu[5].toInt() and 0xff,
            pdu[4].toInt() and 0xff, pdu[3].toInt() and 0xff, pdu[2].toInt() and 0xff)
        val db = 20.0 * ln((pktMaxMag / 128.0) + 1e-6) / ln(10.0)
        val sb = StringBuilder()
        sb.append("%-15s %s %s %4.0fdB".format(PDU_TYPES.getOrElse(type) { "PDU$type" }, mac, if (txAdd) "rnd" else "pub", db))
        // AD structures: len, type, data
        var p = 8
        val end = 2 + payloadLen
        if (type == 0 || type == 2 || type == 4 || type == 6) {
            while (p < end) {
                val l = pdu[p].toInt() and 0xff
                if (l == 0 || p + 1 + l > end) break
                val adType = pdu[p + 1].toInt() and 0xff
                val dataStart = p + 2; val dataLen = l - 1
                when (adType) {
                    0x08, 0x09 -> sb.append(" name '").append(String(pdu, dataStart, dataLen, Charsets.ISO_8859_1)).append('\'')
                    0x01 -> sb.append(" flags 0x%02x".format(pdu[dataStart].toInt() and 0xff))
                    0xFF -> if (dataLen >= 2) sb.append(" mfr 0x%04x".format(((pdu[dataStart + 1].toInt() and 0xff) shl 8) or (pdu[dataStart].toInt() and 0xff)))
                    0x02, 0x03 -> if (dataLen >= 2) sb.append(" uuid16 0x%04x".format(((pdu[dataStart + 1].toInt() and 0xff) shl 8) or (pdu[dataStart].toInt() and 0xff)))
                    0x16 -> if (dataLen >= 2) sb.append(" svc 0x%04x".format(((pdu[dataStart + 1].toInt() and 0xff) shl 8) or (pdu[dataStart].toInt() and 0xff)))
                    0x0A -> if (dataLen >= 1) sb.append(" tx ${pdu[dataStart].toInt()}dBm")
                    else -> sb.append(" ad%02x[%d]".format(adType, dataLen))
                }
                p += 1 + l
            }
        }
        log.add(sb.toString())
    }

    companion object {
        const val ACCESS_ADDRESS = 0x8E89BED6L
        val PDU_TYPES = listOf("ADV_IND", "ADV_DIRECT_IND", "ADV_NONCONN_IND", "SCAN_REQ", "SCAN_RSP", "CONNECT_REQ", "ADV_SCAN_IND")
        fun channelFreq(ch: Int): Long = when (ch) { 37 -> 2_402_000_000L; 38 -> 2_426_000_000L; else -> 2_480_000_000L }
    }
}
