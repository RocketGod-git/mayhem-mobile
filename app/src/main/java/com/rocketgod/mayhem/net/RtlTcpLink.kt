package com.rocketgod.mayhem.net

import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * One connection to an `rtl_tcp` server: an RTL-SDR on another machine, its samples carried over TCP. The protocol is
 * small. The server opens with twelve bytes, the magic "RTL0", the tuner type and the number of gain steps (each a
 * big-endian u32), then streams unsigned 8-bit interleaved I/Q, byte for byte what a dongle on USB hands over. The
 * client steers it with five-byte commands: one command byte and a big-endian u32 value.
 *
 * Plain JVM (no Android), so the protocol is tested against an in-process server.
 */
class RtlTcpLink(val host: String, val port: Int) : Closeable {
    /** What the server said about its dongle. */
    data class Info(val tunerType: Int, val gainCount: Int) {
        val tuner: String get() = tunerName(tunerType)
    }

    private var socket: Socket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    @Volatile var closed = false; private set
    /** Bytes of I/Q read since [open]. */
    @Volatile var bytesIn = 0L; private set

    /**
     * Connect and read the header. [readTimeoutMs] is how long a [read] waits before it returns 0, so the caller can
     * send pending commands even while nothing arrives. Throws on failure, [NotRtlTcp] when the far end answers with
     * something other than an rtl_tcp header.
     */
    fun open(connectTimeoutMs: Int = 5000, readTimeoutMs: Int = 250, headerTimeoutMs: Int = 5000): Info {
        val s = Socket()
        socket = s
        // large enough for about a second at 2.4 Msps, so a stall on the phone does not push back on the server
        runCatching { s.receiveBufferSize = RECV_BUFFER }
        s.tcpNoDelay = true
        s.keepAlive = true
        s.connect(InetSocketAddress(host, port), connectTimeoutMs)
        if (closed) throw java.io.IOException("closed")
        s.soTimeout = headerTimeoutMs
        val inp = s.getInputStream(); val out = s.getOutputStream()
        input = inp; output = out
        val h = ByteArray(HEADER_LEN)
        var got = 0
        while (got < HEADER_LEN) {
            val n = try { inp.read(h, got, HEADER_LEN - got) } catch (e: SocketTimeoutException) { throw NotRtlTcp("no header") }
            if (n < 0) throw NotRtlTcp("closed before the header")
            got += n
        }
        val info = parseHeader(h) ?: throw NotRtlTcp("wrong magic")
        s.soTimeout = readTimeoutMs
        return info
    }

    /** The receive buffer the system actually granted, for the log. */
    val receiveBuffer: Int get() = runCatching { socket?.receiveBufferSize ?: 0 }.getOrDefault(0)

    /** Read I/Q: the count read, 0 when nothing came within the read timeout, -1 when the server closed. */
    fun read(buf: ByteArray, off: Int, len: Int): Int {
        val inp = input ?: return -1
        return try {
            val n = inp.read(buf, off, len)
            if (n > 0) bytesIn += n
            n
        } catch (e: SocketTimeoutException) { 0 }
    }

    /** Send one command. */
    fun command(cmd: Int, value: Int) {
        val out = output ?: throw java.io.IOException("not connected")
        synchronized(this) { out.write(encode(cmd, value)); out.flush() }
    }

    fun setFrequency(hz: Long) = command(CMD_FREQ, hz.coerceIn(0L, 0xffff_ffffL).toInt())
    fun setSampleRate(hz: Int) = command(CMD_RATE, hz)
    /** Manual gain (true) or the tuner's own automatic gain (false). */
    fun setGainMode(manual: Boolean) = command(CMD_GAIN_MODE, if (manual) 1 else 0)
    /** Tuner gain in tenths of a dB; the server picks the nearest step the tuner has. */
    fun setGain(tenthDb: Int) = command(CMD_GAIN, tenthDb)
    /** Crystal correction in parts per million, negative values as two's complement. */
    fun setPpm(ppm: Int) = command(CMD_PPM, ppm)
    fun setRtlAgc(on: Boolean) = command(CMD_RTL_AGC, if (on) 1 else 0)
    /** 0 off, 1 the I branch, 2 the Q branch. */
    fun setDirectSampling(mode: Int) = command(CMD_DIRECT_SAMPLING, mode)
    fun setGainIndex(i: Int) = command(CMD_GAIN_INDEX, i)
    fun setBiasTee(on: Boolean) = command(CMD_BIAS_TEE, if (on) 1 else 0)

    /** Close the socket, which also wakes a [read] or an [open] blocked on another thread. */
    override fun close() {
        closed = true
        runCatching { socket?.close() }
    }

    class NotRtlTcp(why: String) : java.io.IOException(why)

    companion object {
        const val DEFAULT_PORT = 1234
        const val HEADER_LEN = 12
        const val RECV_BUFFER = 4 shl 20

        const val CMD_FREQ = 0x01
        const val CMD_RATE = 0x02
        const val CMD_GAIN_MODE = 0x03
        const val CMD_GAIN = 0x04
        const val CMD_PPM = 0x05
        const val CMD_RTL_AGC = 0x08
        const val CMD_DIRECT_SAMPLING = 0x09
        const val CMD_GAIN_INDEX = 0x0d
        const val CMD_BIAS_TEE = 0x0e

        /** librtlsdr's tuner numbering, as rtl_tcp sends it. */
        val TUNERS = listOf("unknown", "E4000", "FC0012", "FC0013", "FC2580", "R820T", "R828D")
        fun tunerName(t: Int): String = TUNERS.getOrNull(t) ?: "tuner $t"
        /** The tuners that can sample HF straight off the ADC the way the USB driver does it. */
        fun canDirectSample(t: Int) = t == 5

        fun encode(cmd: Int, value: Int): ByteArray = byteArrayOf(cmd.toByte(),
            (value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte())

        private fun u32(b: ByteArray, at: Int): Long =
            ((b[at].toLong() and 0xff) shl 24) or ((b[at + 1].toLong() and 0xff) shl 16) or ((b[at + 2].toLong() and 0xff) shl 8) or (b[at + 3].toLong() and 0xff)

        /** The header, or null when it does not start with "RTL0". */
        fun parseHeader(h: ByteArray): Info? {
            if (h.size < HEADER_LEN || h[0] != 'R'.code.toByte() || h[1] != 'T'.code.toByte() || h[2] != 'L'.code.toByte() || h[3] != '0'.code.toByte()) return null
            return Info(u32(h, 4).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), u32(h, 8).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
        }
    }
}

/**
 * The settings the server should be running, read from wherever the app keeps them. [gainTenthDb] below zero hands
 * the gain to the tuner's own automatic gain.
 */
data class RtlTcpTargets(
    val freqHz: Long,
    val rateHz: Int,
    val gainTenthDb: Int,
    val rtlAgc: Boolean,
    val ppm: Int,
    val biasTee: Boolean,
    val directSamplingAllowed: Boolean,
)

/**
 * Streams one [RtlTcpLink]: sends what changed in [targets] and hands the I/Q to [sink] in whole I/Q pairs, in
 * chunks of [chunk] bytes (the size a USB dongle's reads come in), or what has arrived when the server goes quiet.
 * Every setting is sent once at the start, so a server that restarted is put back where the app was.
 */
class RtlTcpStream(
    private val link: RtlTcpLink,
    private val info: RtlTcpLink.Info,
    private val targets: () -> RtlTcpTargets,
    private val sink: (ByteArray, Int) -> Unit,
    private val log: (String) -> Unit = {},
    chunk: Int = 65536,
) {
    private val buf = ByteArray(chunk)
    private var fill = 0

    @Volatile var appliedFreq = 0L; private set
    @Volatile var appliedRate = 0; private set
    private var appliedGain = Int.MIN_VALUE
    private var appliedRtlAgc: Boolean? = null
    private var appliedPpm: Int? = null
    private var appliedBias: Boolean? = null
    private var appliedDs = -1

    /** Send whatever differs from what the server was last told; returns true when the sample rate changed. */
    fun applyPending(): Boolean {
        val t = targets()
        var rateChanged = false
        if (t.ppm != appliedPpm) { link.setPpm(t.ppm); if (appliedPpm != null) log("rtl_tcp: frequency correction %+d ppm".format(t.ppm)); appliedPpm = t.ppm }
        if (t.rateHz != appliedRate) { link.setSampleRate(t.rateHz); appliedRate = t.rateHz; rateChanged = true }
        // HF on an R820T the way the USB driver reaches it: the ADC's Q branch read straight, the tuner bypassed
        val ds = if (RtlTcpLink.canDirectSample(info.tunerType) && t.directSamplingAllowed && t.freqHz < HF_MAX_HZ) 2 else 0
        if (ds != appliedDs) {
            // the server starts with it off, so there is nothing to say until it is wanted
            if (appliedDs != -1 || ds != 0) { link.setDirectSampling(ds); log(if (ds != 0) "rtl_tcp: direct sampling (Q branch) for HF" else "rtl_tcp: direct sampling off") }
            appliedDs = ds; appliedFreq = 0L
        }
        if (t.freqHz != appliedFreq) { link.setFrequency(t.freqHz); appliedFreq = t.freqHz }
        val g = if (t.gainTenthDb < 0) -1 else t.gainTenthDb
        if (g != appliedGain) {
            if (g < 0) link.setGainMode(false)
            else { if (appliedGain < 0) link.setGainMode(true); link.setGain(g) }
            appliedGain = g
        }
        if (t.rtlAgc != appliedRtlAgc) { link.setRtlAgc(t.rtlAgc); appliedRtlAgc = t.rtlAgc }
        if (t.biasTee != appliedBias) {
            // off is the server's own start, so off is only sent to turn it back off
            if (appliedBias != null || t.biasTee) { link.setBiasTee(t.biasTee); log("rtl_tcp: bias tee ${if (t.biasTee) "on" else "off"}") }
            appliedBias = t.biasTee
        }
        return rateChanged
    }

    /**
     * Read once. Hands a full chunk to the sink, or what is buffered when the read timed out (whole I/Q pairs only;
     * an odd byte waits for its partner). Returns the bytes read (0 on a quiet timeout) or -1 when the server closed.
     */
    fun pump(): Int {
        val n = link.read(buf, fill, buf.size - fill)
        if (n < 0) { if (fill >= 2) sink(buf, fill and 1.inv()); fill = 0; return -1 }
        fill += n
        if (fill == buf.size || (n == 0 && fill >= 2)) {
            val even = fill and 1.inv()
            sink(buf, even)
            if (fill > even) { buf[0] = buf[even]; fill = 1 } else fill = 0
        }
        return n
    }

    companion object {
        /** Below this the R82xx tracking filter runs out (as in the USB driver). */
        const val HF_MAX_HZ = 24_000_000L
    }
}
