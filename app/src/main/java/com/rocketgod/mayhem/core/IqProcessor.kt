package com.rocketgod.mayhem.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A Mayhem-style baseband processor (the Kotlin counterpart of a `proc_*.cpp`). [SdrEngine] calls it on the DSP
 * thread: [onIq] with every raw buffer, and — when [wantsFm] — [onFm] with the NFM discriminator output at the
 * intermediate (~48 kHz) rate, for the packet modes that ride on FM (POCSAG, AIS, APRS). All methods run on the
 * single DSP thread, so processors need no locking of their own state; publish results through StateFlows.
 */
interface IqProcessor {
    val wantsFm: Boolean get() = false
    /** Called on the DSP thread before the first buffer and whenever the IQ sample rate changes. */
    fun reset(rate: Int)
    /** Offset-128 interleaved I,Q bytes; [len] bytes valid. */
    fun onIq(iq: ByteArray, len: Int, rate: Int)
    /** FM discriminator samples (radians/sample, ±π) at [rate] Hz. Only if [wantsFm]. */
    fun onFm(samples: FloatArray, n: Int, rate: Int) {}
}

/** Newest-first text log a decoder publishes to its screen. */
class PacketLog(private val cap: Int = 300) {
    private val _lines = MutableStateFlow<List<String>>(emptyList())
    val lines: StateFlow<List<String>> = _lines.asStateFlow()
    private val _count = MutableStateFlow(0)
    val count: StateFlow<Int> = _count.asStateFlow()

    fun add(s: String) {
        val cur = _lines.value
        _lines.value = if (cur.size >= cap) listOf(s) + cur.subList(0, cap - 1) else listOf(s) + cur
        _count.value = _count.value + 1
    }
    fun clear() { _lines.value = emptyList(); _count.value = 0 }
}

/**
 * Symbol-clock recovery for a baseband bit stream: integrate-and-dump at [baud] with the dump instant pulled
 * toward zero-crossings of the input (transitions happen on bit boundaries). Feed one sample at a time; a
 * completed bit comes back as 0/1, otherwise -1.
 */
class BitSync(baud: Double, rate: Double) {
    private val inc = baud / rate
    private var phase = 0.0
    private var acc = 0f
    private var lastPos = false
    private var first = true

    fun push(x: Float): Int {
        val pos = x > 0f
        if (!first && pos != lastPos) {
            val err = if (phase < 0.5) phase else phase - 1.0   // distance from the nearest bit boundary
            phase -= err * 0.25
        }
        first = false
        lastPos = pos
        acc += x
        phase += inc
        if (phase >= 1.0) {
            phase -= 1.0
            val bit = if (acc > 0f) 1 else 0
            acc = 0f
            return bit
        }
        return -1
    }

    fun reset() { phase = 0.0; acc = 0f; first = true }
}

/** Big-endian bit reader over a byte array whose bits are stored LSB-first per byte (HDLC transmission order). */
class BitReader(private val b: ByteArray) {
    val bitCount: Int get() = b.size * 8
    fun read(start: Int, len: Int): Int {
        var v = 0
        for (i in 0 until len) {
            val k = start + i
            val bit = if (k < bitCount) (b[k shr 3].toInt() shr (k and 7)) and 1 else 0
            v = (v shl 1) or bit
        }
        return v
    }
    fun readSigned(start: Int, len: Int): Int {
        val v = read(start, len)
        return if (v and (1 shl (len - 1)) != 0) v - (1 shl len) else v
    }
}

/**
 * HDLC / AX.25 deframer: NRZI decode, bit-unstuffing, 0x7E flags, bytes assembled LSB-first. Frames (data + FCS)
 * are handed to [onFrame]; check them with [fcsOk]. Shared by AIS and APRS (ported from Mayhem proc_aprsrx).
 */
class HdlcFramer(private val maxBytes: Int, private val onFrame: (ByteArray) -> Unit) {
    private var lastBit = 0
    private var ones = 0
    private var cur = 0
    private var bitIdx = 0
    private val buf = ByteArray(maxBytes)
    private var size = 0
    private var inFrame = false

    fun reset() { lastBit = 0; abort() }

    /** Raw channel bit (before NRZI): a transition is a 0, no transition a 1. */
    fun pushRaw(bit: Int) {
        val dec = if (bit == lastBit) 1 else 0
        lastBit = bit
        pushDecoded(dec)
    }

    fun pushDecoded(bit: Int) {
        if (bit == 1) {
            if (ones < 8) ones++
        } else {
            if (ones > 6) { abort(); return }            // 7+ ones: abort sequence / idle
            if (ones == 6) {                              // 01111110 flag
                if (inFrame && size >= 3) onFrame(buf.copyOf(size))
                inFrame = true; size = 0; cur = 0; bitIdx = 0; ones = 0
                return
            }
            if (ones == 5) { ones = 0; return }          // stuffed zero: drop it
            ones = 0
        }
        if (!inFrame) return
        cur = (cur shr 1) or (bit shl 7)
        bitIdx++
        if (bitIdx >= 8) {
            bitIdx = 0
            if (size >= maxBytes) { abort(); return }
            buf[size++] = cur.toByte()
            cur = 0
        }
    }

    private fun abort() { inFrame = false; size = 0; cur = 0; bitIdx = 0; ones = 0 }

    companion object {
        /** HDLC FCS: CRC-16-CCITT (reflected, init 0xFFFF) over data+FCS leaves the residue 0xF0B8. */
        fun fcsOk(f: ByteArray): Boolean {
            var crc = 0xFFFF
            for (x in f) {
                crc = crc xor (x.toInt() and 0xff)
                for (i in 0 until 8) crc = if (crc and 1 != 0) (crc ushr 1) xor 0x8408 else crc ushr 1
            }
            return crc == 0xF0B8
        }
    }
}
