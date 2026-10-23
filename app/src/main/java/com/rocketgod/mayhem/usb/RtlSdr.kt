package com.rocketgod.mayhem.usb

import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.SdrEngine
import java.nio.ByteBuffer
import java.util.concurrent.TimeoutException

/**
 * RTL-SDR: an RTL2832U demodulator with a Rafael Micro R820T / R820T2 or R828D tuner, the twenty-dollar dongle
 * almost everyone owns. It cannot transmit and stops at about 1.766 GHz, but from 24 MHz up to there it hears
 * what a HackRF hears. A port of the web app's driver, itself from librtlsdr (`librtlsdr.c`, `tuner_r82xx.c`,
 * GPL-2.0-or-later). The details that each cost someone a day:
 *
 *  - Control transfers are vendor request 0 both ways; the register block goes in `index`, the address in
 *    `value`, and two-byte writes go out big-endian although reads come back little-endian.
 *  - Every demodulator write is followed by a dummy read of page 0x0a register 0x01, or the part works for a
 *    while and then quietly stops.
 *  - The R82xx hands its registers back bit-reversed.
 *  - The RTL2832U's I2C master carries eight bytes a transaction, one of them the register address, so the
 *    tuner's 27-byte init block goes in sevens. Sent whole it is truncated after register 0x0b with no error:
 *    the tuner answers, the PLL locks, and nothing downconverts.
 *  - The R828D (RTL-SDR Blog V4, Astrometa) sits at another I2C address, may run its PLL from a 16 MHz crystal
 *    or the RTL's 28.8 (measured, by which one locks), and has separate aerial inputs below and above 345 MHz.
 *
 * Samples arrive as offset binary, zero at 127.5, which is already what [SdrEngine] takes.
 */
object RtlSdr {
    /** Realtek generics and the rebadged sticks librtlsdr knows. */
    val IDS = setOf(0x0bda to 0x2832, 0x0bda to 0x2838, 0x0ccd to 0x00a9, 0x0ccd to 0x00b3, 0x1554 to 0x5020,
        0x185b to 0x0620, 0x185b to 0x0650, 0x1f4d to 0xb803, 0x1f4d to 0xc803)
    fun isRtlSdr(d: UsbDevice) = (d.vendorId to d.productId) in IDS

    const val MIN_HZ = 24_000_000L
    const val MAX_HZ = 1_766_000_000L
    /** The most the tuner's stages add up to, in dB (not the 49.6 librtlsdr's table claims). */
    const val MAX_GAIN_DB = 48.8

    @Volatile var running = false; private set
    @Volatile private var stop = false
    fun abort() { stop = true }

    @Volatile var targetFreqHz = 92_300_000L
    @Volatile var targetRateHz = 2_000_000
    /** Tuner gain in tenths of a dB. Near the top by default: too little gain reads as static. */
    @Volatile var targetGainTenthDb = 400

    /** What it turned out to be, for the screen. */
    @Volatile var label = "RTL-SDR"; private set
    @Volatile var tuner = ""; private set

    private const val DEMODB = 0; private const val USBB = 1; private const val SYSB = 2; private const val IICB = 6
    private const val USB_SYSCTL = 0x2000; private const val USB_EPA_CTL = 0x2148; private const val USB_EPA_MAXPKT = 0x2158
    private const val DEMOD_CTL = 0x3000; private const val DEMOD_CTL_1 = 0x300b
    /** The RTL2832U's general-purpose pins: output value, output enable, direction. */
    private const val GPO = 0x3001; private const val GPOE = 0x3003; private const val GPD = 0x3004
    /**
     * The RTL-SDR Blog V4L. The R828D went out of production and the V4L carries an R828S, which answers at the
     * R820T's address with the R820T's check value; only the USB strings tell it apart, as in librtlsdr.
     */
    private const val BLOG_MAKER = "RTLSDRBlog"; private const val BLOG_V4L = "Blog V4L"
    private const val RTL_XTAL = 28_800_000L
    /** Where the tuner puts the wanted signal: low-side injection, which the demodulator inverts back. */
    private const val IF_HZ = 3_570_000L
    private const val R820T_ADDR = 0x34; private const val R828D_ADDR = 0x74
    private const val R828D_XTAL = 16_000_000L
    private const val CHECK_VAL = 0x69
    private const val TIMEOUT = 300

    private val LNA_STEPS = intArrayOf(0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13)
    private val MIX_STEPS = intArrayOf(0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8)
    private val FIR_DEFAULT = intArrayOf(-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421)
    private val REV4 = intArrayOf(0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf)
    private fun bitrev(b: Int) = (REV4[b and 0xf] shl 4) or REV4[(b shr 4) and 0xf]

    /** Tracking filter and mixer settings by band (MHz): mhz, openD, rfMux, tfC, cap0p. Nothing works below ~24 MHz. */
    private val FREQ_RANGES = arrayOf(
        intArrayOf(0, 0x08, 0x02, 0xdf, 0x00), intArrayOf(50, 0x08, 0x02, 0xbe, 0x00), intArrayOf(55, 0x08, 0x02, 0x8b, 0x00),
        intArrayOf(60, 0x08, 0x02, 0x7b, 0x00), intArrayOf(65, 0x08, 0x02, 0x69, 0x00), intArrayOf(70, 0x08, 0x02, 0x58, 0x00),
        intArrayOf(75, 0x00, 0x02, 0x44, 0x00), intArrayOf(80, 0x00, 0x02, 0x44, 0x00), intArrayOf(90, 0x00, 0x02, 0x34, 0x00),
        intArrayOf(100, 0x00, 0x02, 0x34, 0x00), intArrayOf(110, 0x00, 0x02, 0x24, 0x00), intArrayOf(120, 0x00, 0x02, 0x24, 0x00),
        intArrayOf(140, 0x00, 0x02, 0x14, 0x00), intArrayOf(180, 0x00, 0x02, 0x13, 0x00), intArrayOf(220, 0x00, 0x02, 0x13, 0x00),
        intArrayOf(250, 0x00, 0x02, 0x11, 0x00), intArrayOf(280, 0x00, 0x02, 0x00, 0x00), intArrayOf(310, 0x00, 0x41, 0x00, 0x00),
        intArrayOf(450, 0x00, 0x41, 0x00, 0x00), intArrayOf(588, 0x00, 0x40, 0x00, 0x00), intArrayOf(650, 0x00, 0x40, 0x00, 0x00),
    )
    /** The tuner's power-on registers 0x05..0x1f. */
    private val R82XX_INIT = intArrayOf(0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80,
        0x31, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40)

    /** The channel filter as the demodulator wants it: eight signed bytes, then eight 12-bit values packed in threes. */
    fun firBytes(): IntArray {
        val fir = IntArray(20)
        for (i in 0 until 8) fir[i] = FIR_DEFAULT[i] and 0xff
        var i = 0
        while (i < 8) {
            val v0 = FIR_DEFAULT[8 + i]; val v1 = FIR_DEFAULT[8 + i + 1]
            val at = 8 + ((i * 3) shr 1)
            fir[at] = (v0 shr 4) and 0xff
            fir[at + 1] = ((v0 shl 4) or ((v1 shr 8) and 0x0f)) and 0xff
            fir[at + 2] = v1 and 0xff
            i += 2
        }
        return fir
    }

    data class PllPlan(val mixDiv: Int, val divNum: Int, val nint: Int, val sdm: Int, val ok: Boolean)

    /**
     * Synthesizer settings for one LO frequency: a divider bringing the 1.77–3.54 GHz VCO into range, then a
     * fractional-N division of the reference. [vcoPowerRef] is 2 on an R820T and 1 on an R828D and sets how far
     * the integer part may go; held to the R820T's limit, an R828D would refuse everything above ~250 MHz.
     */
    fun pllPlan(freqHz: Long, pllRef: Long, fine: Int, vcoPowerRef: Int = 2): PllPlan {
        val vcoMinKhz = 1_770_000L; val vcoMaxKhz = vcoMinKhz * 2
        val freqKhz = (freqHz + 500) / 1000
        var mixDiv = 2; var divNum = 0
        while (mixDiv <= 64) {
            if (freqKhz * mixDiv >= vcoMinKhz && freqKhz * mixDiv < vcoMaxKhz) {
                var db = mixDiv
                while (db > 2) { db = db shr 1; divNum++ }
                break
            }
            mixDiv = mixDiv shl 1
        }
        if (fine > vcoPowerRef) divNum -= 1 else if (fine < vcoPowerRef) divNum += 1
        val vcoFreq = freqHz * mixDiv
        val vcoDiv = (pllRef + 65536L * vcoFreq) / (2 * pllRef)
        val nint = (vcoDiv / 65536).toInt()
        val sdm = (vcoDiv % 65536).toInt()
        return PllPlan(mixDiv, divNum, nint, sdm, nint <= (128 / vcoPowerRef) - 1)
    }

    /** The frequency a plan actually produces, which is what makes it checkable. */
    fun pllFreq(p: PllPlan, pllRef: Long): Double = 2.0 * pllRef * (p.nint + p.sdm / 65536.0) / p.mixDiv

    /** LNA and mixer steps, walked alternately as librtlsdr does, to the first total that reaches [tenthDb]. */
    fun gainSteps(tenthDb: Int): Triple<Int, Int, Int> {
        var total = 0; var lna = 0; var mix = 0
        for (i in 0 until 15) {
            if (total >= tenthDb) break
            total += LNA_STEPS[++lna]
            if (total >= tenthDb) break
            total += MIX_STEPS[++mix]
        }
        return Triple(lna, mix, total)
    }

    private lateinit var conn: UsbDeviceConnection
    private val tunerRegs = IntArray(32)
    private var tunerAddr = R820T_ADDR
    private var tunerXtal = RTL_XTAL
    private var vcoPowerRef = 2
    private var device: UsbDevice? = null
    /** The frequency the radio has actually been set to, so a sweep knows when its retune has landed. */
    @Volatile var appliedFreq = 0L; private set
    @Volatile private var appliedRate = 0
    @Volatile private var appliedGain = Int.MAX_VALUE
    private var dbgBuffers = 0

    /** Blocking: opens the dongle, brings it up and streams until [abort] or an error. Run on its own thread. */
    fun run(ctx: Context, device: UsbDevice, onStatus: (String) -> Unit) {
        if (running) return
        running = true; stop = false
        appliedFreq = 0L; appliedRate = 0; appliedGain = Int.MAX_VALUE; dbgBuffers = 0
        quietRetune = false; needQuietRetune = false; retuneAfter = 0L
        SdrEngine.syncDriver()
        val mgr = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
        val c = mgr.openDevice(device) ?: run { onStatus("RTL-SDR: couldn't open device"); running = false; return }
        conn = c
        this.device = device
        try {
            val intf = device.getInterface(0)
            c.claimInterface(intf, true)
            var rx: UsbEndpoint? = null
            for (i in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(i)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_IN) { rx = ep; break }
            }
            val ep = rx ?: run { Diag.log("RTL-SDR: no bulk-IN endpoint"); onStatus("RTL-SDR: no IQ endpoint"); return }
            // a dongle another app left streaming can have its endpoint halted; clear it before touching anything
            runCatching { c.controlTransfer(0x02, 0x01, 0x00, ep.address, null, 0, 500) }
            Diag.log("=== RTL-SDR bring-up (RTL2832U + R82xx) === RX endpoint=0x%02x".format(ep.address))
            onStatus("RTL-SDR · initializing…")
            initBaseband()
            initTuner()
            setSampleRate(targetRateHz); appliedRate = targetRateHz
            setCenterFreq(targetFreqHz); appliedFreq = targetFreqHz
            applyGain(targetGainTenthDb); appliedGain = targetGainTenthDb
            resetBuffer()
            SdrEngine.sourceLabel = label
            SdrEngine.onSource(targetRateHz)
            SdrEngine.setActive(true)
            Diag.log("RTL-SDR: streaming %.3f MHz @ %.3f Msps".format(targetFreqHz / 1e6, targetRateHz / 1e6))
            onStatus("$label · %.3f MHz".format(targetFreqHz / 1e6))
            while (!stop) {
                streamUntilRateChange(c, ep, onStatus)
                if (stop) break
                // Nothing is in flight here, so this is where a retune that failed live gets its second try.
                if (needQuietRetune) {
                    needQuietRetune = false
                    val ok = applyPending()
                    runCatching { resetBuffer() }
                    if (!ok) retuneAfter = System.currentTimeMillis() + 1000
                    else if (!quietRetune) {
                        quietRetune = true
                        Diag.log("RTL-SDR: this USB stack rejects retunes during streaming — retuning between drained reads from now on")
                    }
                }
                // A rate change resets the bulk FIFO, so it waits until nothing is in flight.
                if (targetRateHz != appliedRate) {
                    runCatching { setSampleRate(targetRateHz); resetBuffer(); SdrEngine.onSource(targetRateHz) }
                        .onFailure { Diag.log("RTL-SDR: rate change failed — ${it.message}") }
                    appliedRate = targetRateHz
                }
            }
        } catch (t: Throwable) {
            Diag.log("RTL-SDR error: ${t.message}")
            onStatus("RTL-SDR stopped: ${t.message}")
        } finally {
            SdrEngine.setActive(false)
            runCatching { c.close() }
            running = false
            Diag.log("RTL-SDR: RX loop stopped")
        }
    }

    /** Stream with a pool of requests in flight; returns when the rate must change (or on stop). */
    private fun streamUntilRateChange(c: UsbDeviceConnection, rx: UsbEndpoint, onStatus: (String) -> Unit) {
        val nbuf = 12; val bufSz = 16384
        val buffers = Array(nbuf) { ByteBuffer.allocateDirect(bufSz) }
        val reqs = ArrayList<UsbRequest>(nbuf)
        for (i in 0 until nbuf) {
            val r = UsbRequest()
            if (!r.initialize(c, rx)) break
            r.clientData = i; buffers[i].clear()
            if (!r.queue(buffers[i])) { r.close(); break }
            reqs.add(r)
        }
        if (reqs.isEmpty()) { streamSync(c, rx, onStatus); return }
        val scratch = ByteArray(bufSz)
        var lastStatus = 0L
        // A dongle pulled out without a detach arriving fails every wait and every requeue at once, forever;
        // a run of failures means it is gone, not that one transfer was unlucky.
        var fails = 0; var failSince = 0L
        fun failed(what: String): Boolean {
            val now = System.currentTimeMillis()
            if (fails++ == 0) failSince = now
            if (fails >= 200 || now - failSince >= 3000) { Diag.log("RTL-SDR: $fails failures in a row ($what) — dongle gone, stopping"); stop = true; return true }
            return false
        }
        try {
            while (!stop && targetRateHz == appliedRate) {
                // Retune live first; where this USB stack has shown it rejects that, or it just failed, leave the
                // loop so run() cancels every request and retunes with nothing in flight.
                if (pending() && System.currentTimeMillis() >= retuneAfter) {
                    if (quietRetune || !applyPending()) { needQuietRetune = true; break }
                }
                val req = try { c.requestWait(100L) } catch (e: TimeoutException) { continue }
                if (req == null) { if (failed("wait")) break; Thread.sleep(2); continue }
                val idx = req.clientData as? Int ?: continue
                val b = buffers[idx]
                val n = b.position()
                if (n in 1..bufSz) {
                    b.rewind(); b.get(scratch, 0, n)
                    probe(scratch, n, onStatus)
                    runCatching { SdrEngine.onIq(scratch, n) }
                }
                b.clear()
                var requeued = runCatching { req.queue(b) }.getOrDefault(false)
                if (!requeued) {
                    runCatching { req.close() }
                    val nr = UsbRequest()
                    if (runCatching { nr.initialize(c, rx) }.getOrDefault(false)) {
                        nr.clientData = idx
                        if (runCatching { nr.queue(b) }.getOrDefault(false)) { reqs[idx] = nr; requeued = true }
                    }
                }
                if (!requeued) { if (failed("requeue")) break } else fails = 0
                val now = System.currentTimeMillis()
                if (now - lastStatus > 1000L) { lastStatus = now; onStatus("$label · %.3f MHz".format(appliedFreq / 1e6)) }
            }
        } finally {
            reqs.forEach { runCatching { it.cancel() }; runCatching { it.close() } }
        }
    }

    private fun streamSync(c: UsbDeviceConnection, rx: UsbEndpoint, onStatus: (String) -> Unit) {
        Diag.log("RTL-SDR: async RX unavailable — synchronous fallback")
        val buf = ByteArray(16384)
        var fails = 0
        while (!stop && targetRateHz == appliedRate) {
            applyPending()
            val n = c.bulkTransfer(rx, buf, buf.size, 500)
            if (n > 0) { fails = 0; probe(buf, n, onStatus); runCatching { SdrEngine.onIq(buf, n) } }
            else if (n < 0 && ++fails >= 200) { Diag.log("RTL-SDR: bulk reads keep failing — dongle gone, stopping"); stop = true }
            else if (n < 0) Thread.sleep(2)
        }
    }

    /** The first few buffers, logged: a dongle delivering nothing reads as a flat line, not as zeros. */
    private fun probe(b: ByteArray, n: Int, onStatus: (String) -> Unit) {
        if (dbgBuffers >= 3) return
        dbgBuffers++
        var mn = 255; var mx = 0
        for (k in 0 until n) { val v = b[k].toInt() and 0xff; if (v < mn) mn = v; if (v > mx) mx = v }
        Diag.log("RTL-SDR raw: n=$n min=$mn max=$mx")
        if (mx - mn < 3) { Diag.log("RTL-SDR: the samples barely move — check the aerial and try another USB port"); onStatus("RTL-SDR: no signal — check aerial / cable") }
    }

    private fun pending() = targetFreqHz != appliedFreq || targetGainTenthDb != appliedGain

    /**
     * Apply a pending frequency and gain, between buffers. True when both landed. Marked applied only once it
     * lands: Android's controlTransfer reports failure as a negative length rather than throwing, so a retune
     * whose writes were refused used to "succeed" and leave the dongle parked on the old frequency with the new
     * app deaf. Failed writes are counted, and any during the retune make it a failure.
     */
    private fun applyPending(): Boolean {
        var ok = true
        if (targetFreqHz != appliedFreq) {
            val f = targetFreqHz; val before = writeFails
            runCatching { setCenterFreq(f); check(writeFails == before) { "control transfer refused" } }
                .onSuccess { appliedFreq = f }.onFailure { retuneFailed(it); ok = false }
        }
        if (targetGainTenthDb != appliedGain) {
            val g = targetGainTenthDb; val before = writeFails
            runCatching { applyGain(g); check(writeFails == before) { "control transfer refused" } }
                .onSuccess { appliedGain = g }.onFailure { retuneFailed(it); ok = false }
        }
        if (ok) retuneError = null
        return ok
    }

    /** Control writes the dongle refused (Android returns a negative length rather than throwing). */
    @Volatile private var writeFails = 0
    /** Set once a retune failed live and then landed with nothing in flight: retune that way from then on. */
    @Volatile private var quietRetune = false
    @Volatile private var needQuietRetune = false
    /** No retune before this time: set after one fails even with nothing in flight. */
    @Volatile private var retuneAfter = 0L

    private var retuneError: String? = null
    private fun retuneFailed(t: Throwable) {
        if (t.message != retuneError) Diag.log("RTL-SDR: retune failed, retrying — ${t.message}")
        retuneError = t.message
    }

    // ---- RTL2832U registers -----------------------------------------------------------------------------------
    private fun out(value: Int, index: Int, data: ByteArray): Int =
        conn.controlTransfer(0x40, 0, value, index, data, data.size, TIMEOUT).also { if (it < 0) writeFails++ }
    private fun be(v: Int, len: Int) = if (len == 1) byteArrayOf(v.toByte()) else byteArrayOf((v shr 8).toByte(), v.toByte())

    private fun writeReg(block: Int, addr: Int, v: Int, len: Int) { out(addr, (block shl 8) or 0x10, be(v, len)) }

    private fun demodWrite(page: Int, addr: Int, v: Int, len: Int) {
        out((addr shl 8) or 0x20, 0x10 or page, be(v, len))
        demodRead(0x0a, 0x01, 1)     // required after every demodulator write
    }

    private fun demodRead(page: Int, addr: Int, len: Int): Int {
        val b = ByteArray(len)
        val r = conn.controlTransfer(0xC0, 0, (addr shl 8) or 0x20, page, b, len, TIMEOUT)
        if (r != len) return 0
        return if (len == 1) b[0].toInt() and 0xff else ((b[1].toInt() and 0xff) shl 8) or (b[0].toInt() and 0xff)
    }

    /** Block register read, one byte. */
    private fun readReg(block: Int, addr: Int): Int {
        val b = ByteArray(1)
        return if (conn.controlTransfer(0xC0, 0, addr, block shl 8, b, 1, TIMEOUT) == 1) b[0].toInt() and 0xff else 0
    }

    /** Drive one of the RTL2832U's GPIO pins as an output (librtlsdr rtlsdr_set_gpio_output + _set_gpio_bit). */
    private fun setGpio(pin: Int, on: Boolean) {
        val bit = 1 shl pin
        writeReg(SYSB, GPD, readReg(SYSB, GPD) and bit.inv(), 1)
        writeReg(SYSB, GPOE, readReg(SYSB, GPOE) or bit, 1)
        val v = readReg(SYSB, GPO)
        writeReg(SYSB, GPO, if (on) v or bit else v and bit.inv(), 1)
    }

    private fun initBaseband() {
        writeReg(USBB, USB_SYSCTL, 0x09, 1)
        writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2)
        writeReg(USBB, USB_EPA_CTL, 0x1002, 2)
        writeReg(SYSB, DEMOD_CTL_1, 0x22, 1)
        writeReg(SYSB, DEMOD_CTL, 0xe8, 1)
        demodWrite(1, 0x01, 0x14, 1); demodWrite(1, 0x01, 0x10, 1)           // soft reset
        demodWrite(1, 0x15, 0x00, 1); demodWrite(1, 0x16, 0x0000, 2)
        for (i in 0 until 6) demodWrite(1, 0x16 + i, 0x00, 1)                  // DDC shift and IF cleared
        val fir = firBytes()
        for (j in 0 until 20) demodWrite(1, 0x1c + j, fir[j], 1)
        demodWrite(0, 0x19, 0x05, 1)                                            // SDR mode, digital AGC off
        demodWrite(1, 0x93, 0xf0, 1); demodWrite(1, 0x94, 0x0f, 1)
        demodWrite(1, 0x11, 0x00, 1)                                            // AGC off
        demodWrite(1, 0x04, 0x00, 1)                                            // RF and IF AGC loops off
        demodWrite(DEMODB, 0x61, 0x60, 1)                                       // no PID filter
        demodWrite(DEMODB, 0x06, 0x80, 1)                                       // plain ADC I/Q datapath
        demodWrite(1, 0xb1, 0x1b, 1)                                            // zero-IF, DC cancel, IQ compensation
        demodWrite(DEMODB, 0x0d, 0x83, 1)                                       // no clock on TP_CK0
    }

    private fun setIfFreq(freqHz: Long) {
        val ifFreq = -((freqHz * 0x400000L) / RTL_XTAL).toInt()
        demodWrite(1, 0x19, (ifFreq shr 16) and 0x3f, 1)
        demodWrite(1, 0x1a, (ifFreq shr 8) and 0xff, 1)
        demodWrite(1, 0x1b, ifFreq and 0xff, 1)
    }

    private fun setSampleRate(rate: Int) {
        val rsamp = ((RTL_XTAL * 0x400000L) / rate).toInt() and 0x0ffffffc
        demodWrite(1, 0x9f, (rsamp shr 16) and 0xffff, 2)
        demodWrite(1, 0xa1, rsamp and 0xffff, 2)
        demodWrite(1, 0x3e, 0, 1); demodWrite(1, 0x3f, 0, 1)                   // no crystal correction
        demodWrite(1, 0x01, 0x14, 1); demodWrite(1, 0x01, 0x10, 1)
    }

    private fun i2cRepeater(on: Boolean) = demodWrite(1, 0x01, if (on) 0x18 else 0x10, 1)

    private fun resetBuffer() { writeReg(USBB, USB_EPA_CTL, 0x1002, 2); writeReg(USBB, USB_EPA_CTL, 0x0000, 2) }

    private fun setCenterFreq(freqHz: Long) { i2cRepeater(true); r82xxSetFreq(freqHz); i2cRepeater(false) }

    // ---- I2C to the tuner -------------------------------------------------------------------------------------
    /** Raw read from the tuner's address. Nothing at the address stalls rather than answering: that is an answer. */
    private fun i2cReadRaw(len: Int): IntArray {
        val b = ByteArray(len)
        val r = conn.controlTransfer(0xC0, 0, tunerAddr, IICB shl 8, b, len, TIMEOUT)
        return if (r <= 0) IntArray(0) else IntArray(minOf(r, len)) { b[it].toInt() and 0xff }
    }
    private fun r82xxRead(len: Int): IntArray { val raw = i2cReadRaw(len); return IntArray(len) { if (it < raw.size) bitrev(raw[it]) else 0 } }

    /** Consecutive tuner registers, seven data bytes per I2C transaction. */
    private fun tunerWrite(startReg: Int, vals: IntArray) {
        var pos = 0
        while (pos < vals.size) {
            val size = minOf(7, vals.size - pos)
            val b = ByteArray(size + 1)
            b[0] = (startReg + pos).toByte()
            for (i in 0 until size) {
                b[i + 1] = vals[pos + i].toByte()
                val reg = startReg + pos + i
                if (reg in 5 until 32) tunerRegs[reg] = vals[pos + i] and 0xff
            }
            out(tunerAddr, (IICB shl 8) or 0x10, b)
            pos += size
        }
    }
    private fun tunerWriteReg(reg: Int, v: Int) = tunerWrite(reg, intArrayOf(v and 0xff))
    private fun tunerWriteMask(reg: Int, v: Int, mask: Int) = tunerWriteReg(reg, (tunerRegs[reg] and mask.inv()) or (v and mask))

    // ---- R820T / R820T2 / R828D -------------------------------------------------------------------------------
    private fun initTuner() {
        demodWrite(1, 0xb1, 0x1a, 1)            // R82xx: no zero-IF, in-phase ADC only
        demodWrite(DEMODB, 0x08, 0x4d, 1)
        setIfFreq(IF_HZ)
        demodWrite(1, 0x15, 0x01, 1)            // spectrum inverted back
        i2cRepeater(true)
        var found = false
        for ((addr, xtal, ref, name) in listOf(Quad(R820T_ADDR, RTL_XTAL, 2, "R820T/R820T2"), Quad(R828D_ADDR, R828D_XTAL, 1, "R828D"))) {
            tunerAddr = addr
            val probe = i2cReadRaw(1)
            if (probe.isNotEmpty() && probe[0] == CHECK_VAL) {
                tunerXtal = xtal; vcoPowerRef = ref; tuner = name; found = true
                Diag.log("RTL-SDR: tuner $name at I2C 0x%02x".format(addr))
                break
            }
        }
        if (!found) {
            tunerAddr = R820T_ADDR; tunerXtal = RTL_XTAL; vcoPowerRef = 2; tuner = "unknown"
            Diag.log("RTL-SDR: no R82xx answered. An E4000 or FC0012 dongle is not supported yet — expect static.")
        }
        // A V4L's R828S passes for an R820T on the bus. It runs from the RTL's 28.8 MHz like one, but wants the
        // R828D's VCO power reference of one (librtlsdr r82xx_set_pll).
        val dev = device
        if (found && tunerAddr == R820T_ADDR && dev != null &&
            usbString(dev.manufacturerName) == BLOG_MAKER && usbString(dev.productName) == BLOG_V4L) {
            tuner = "R828S"; vcoPowerRef = 1
            Diag.log("RTL-SDR: RTL-SDR Blog V4L (R828S)")
        }
        label = if (tuner == "R828S") "RTL-SDR Blog V4L" else "RTL-SDR · $tuner"
        for (i in R82XX_INIT.indices) tunerRegs[5 + i] = R82XX_INIT[i]
        tunerWrite(0x05, R82XX_INIT)
        if (found && tuner == "R828D") pickR828dReference()
        setTvStandard()
        sysFreqSel()
        i2cRepeater(false)
        // Newer V4L batches switch the antenna through an upconverter on GPIO5: high is the direct path used from
        // 24 MHz up, low is the HF upconverter. HF is not tuned here, so it is set once.
        if (tuner == "R828S") setGpio(5, true)
    }

    private fun usbString(s: String?) = (s ?: "").replace("\u0000", "").trim()

    private data class Quad(val a: Int, val b: Long, val c: Int, val d: String)

    /** Which clock this R828D's PLL runs from, found by which one locks: 16 MHz on Astrometa, 28.8 on a Blog V4. */
    private fun pickR828dReference() {
        for (cand in longArrayOf(R828D_XTAL, RTL_XTAL)) {
            tunerXtal = cand
            if (setPll(100_000_000L, quiet = true)) { Diag.log("RTL-SDR: R828D locks against %.1f MHz".format(cand / 1e6)); return }
        }
        tunerXtal = R828D_XTAL
        Diag.log("RTL-SDR: R828D would not lock against either reference — expect a weak, mistuned front end.")
    }

    /** Calibrate the channel filter, twice if the first lands on a reserved value. */
    private fun setTvStandard() {
        val filtQ = 0x10
        var filCal = 0
        for (i in 0 until 2) {
            tunerWriteMask(0x0f, 0x04, 0x04)
            setPll(56_000_000L)
            tunerWriteMask(0x0b, 0x10, 0x10)
            tunerWriteMask(0x0b, 0x00, 0x10)
            tunerWriteMask(0x0f, 0x00, 0x04)
            filCal = r82xxRead(5)[4] and 0x0f
            if (filCal != 0 && filCal != 0x0f) break
        }
        if (filCal == 0x0f) filCal = 0
        tunerWriteMask(0x0a, filtQ or filCal, 0x1f)
    }

    private fun sysFreqSel() {
        tunerWriteMask(0x05, 0x00, 0x60); tunerWriteMask(0x06, 0x00, 0x08); tunerWriteMask(0x1d, 0x00, 0x38)
        tunerWriteMask(0x06, 0x00, 0x40); tunerWriteMask(0x1a, 0x30, 0x30); tunerWriteMask(0x1d, 0x18, 0x38)
        tunerWriteMask(0x1a, 0x20, 0x30)
    }

    private fun setMux(loHz: Long) {
        val mhz = (loHz / 1_000_000).toInt()
        var r = FREQ_RANGES[0]
        for (fr in FREQ_RANGES) { if (mhz >= fr[0]) r = fr else break }
        tunerWriteMask(0x17, r[1], 0x08); tunerWriteMask(0x1a, r[2], 0xc3); tunerWriteReg(0x1b, r[3])
        tunerWriteMask(0x10, r[4], 0x0b); tunerWriteMask(0x08, 0x00, 0x3f); tunerWriteMask(0x09, 0x00, 0x3f)
    }

    /** The fractional-N synthesizer; false when it will not lock. */
    private fun setPll(freqHz: Long, quiet: Boolean = false): Boolean {
        tunerWriteMask(0x10, 0x00, 0x10)        // reference divider of one
        tunerWriteMask(0x1a, 0x00, 0x0c)        // 128 kHz autotune while settling
        tunerWriteMask(0x12, 0x80, 0xe0)        // VCO current minimum
        val fine = (r82xxRead(5)[4] and 0x30) shr 4
        val plan = pllPlan(freqHz, tunerXtal, fine, vcoPowerRef)
        tunerWriteMask(0x10, plan.divNum shl 5, 0xe0)
        if (!plan.ok) { if (!quiet) Diag.log("RTL-SDR: PLL integer out of range at %.3f MHz".format(freqHz / 1e6)); return false }
        val ni = (plan.nint - 13) / 4
        val si = plan.nint - 4 * ni - 13
        tunerWriteReg(0x14, ni + (si shl 6))
        tunerWriteMask(0x12, if (plan.sdm == 0) 0x08 else 0x00, 0x18)
        tunerWriteReg(0x16, plan.sdm shr 8)
        tunerWriteReg(0x15, plan.sdm and 0xff)
        var locked = false; var saw = IntArray(0)
        for (i in 0 until 2) {
            saw = r82xxRead(3)
            if (saw[2] and 0x40 != 0) { locked = true; break }
            if (i == 0) tunerWriteMask(0x12, 0x60, 0xe0)   // more VCO current, try again
        }
        if (!locked) {
            if (!quiet) Diag.log("RTL-SDR: PLL lock bit clear — status %s, nint %d sdm %d mixDiv %d".format(saw.joinToString(" ") { "%02x".format(it) }, plan.nint, plan.sdm, plan.mixDiv))
            return false
        }
        tunerWriteMask(0x1a, 0x08, 0x08)        // back to 8 kHz autotune
        return true
    }

    private fun r82xxSetFreq(rfHz: Long) {
        val lo = rfHz + IF_HZ
        setMux(lo)
        // the R828D's aerial is on the air input below ~345 MHz and the cable input above; the init leaves cable
        if (tuner == "R828D") tunerWriteMask(0x05, if (rfHz > 345_000_000L) 0x00 else 0x60, 0x60)
        // the V4L's R828S has cable-1 for HF (bit 6) and the air-in (enabled by clearing bit 5) for the rest
        if (tuner == "R828S") tunerWriteMask(0x05, 0x00, 0x60)
        if (!setPll(lo)) Diag.log("RTL-SDR: PLL did not lock at %.3f MHz".format(rfHz / 1e6))
    }

    /** Two uneven 16-step stages walked to the asked total; the tuner's own auto mode is not used (it parks near minimum). */
    private fun applyGain(tenthDb: Int) {
        i2cRepeater(true)
        val (lna, mix, _) = gainSteps(tenthDb)
        tunerWriteMask(0x05, 0x10, 0x10)        // LNA manual
        tunerWriteMask(0x07, 0x00, 0x10)        // mixer manual
        tunerWriteMask(0x05, lna, 0x0f)
        tunerWriteMask(0x07, mix, 0x0f)
        tunerWriteMask(0x0c, 0x08, 0x9f)        // output stage fixed at about 13.5 dB
        i2cRepeater(false)
    }
}
