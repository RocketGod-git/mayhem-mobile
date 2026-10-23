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
 * PURE-KOTLIN userspace driver for a HackRF talking to the board directly over Android [UsbDeviceConnection]
 * vendor control / bulk transfers — no native libhackrf. Lifted from Wardrive Go, where it is
 * field-proven on HackRF One and HackRF Pro. It streams raw 8-bit IQ to [SdrEngine], which does the
 * FFT waterfall, FM/AM demod → audio, and the Mode-S decode.
 *
 * Drives HackRF One (`1d50:6089`), Jawbreaker (`0x604b`), rad1o (`0xcc15`), HackRF One r9, and HackRF Pro /
 * "Praline" (board id 5, same PID as the One). This is the HackRF-DIRECT path: a PortaPack running Mayhem must be
 * put in its on-screen "HackRF" mode (it then enumerates as a plain HackRF); its Mayhem serial mode (`0x6018`) is a
 * different protocol, not handled here; [HackRfUsb.portapackToHackRf] switches a board out of it.
 *
 * The USB vendor protocol is ported VERBATIM from libhackrf (host/libhackrf/src/hackrf.c). Key facts:
 *  - vendor control transfers: bmRequestType IN=0xC0 / OUT=0x40, RECIPIENT_DEVICE; the request byte selects op.
 *  - SET_FREQ (16) and SAMPLE_RATE_SET (6) carry an 8-byte LITTLE-ENDIAN struct as the data stage.
 *  - BASEBAND_FILTER_BANDWIDTH_SET (7) puts the 32-bit bandwidth split across wValue (low16) / wIndex (high16).
 *  - LNA/VGA gain are IN transfers carrying the value in wIndex and returning a 1-byte ack; AMP and
 *    TRANSCEIVER_MODE are OUT with the value in wValue and no data stage.
 *  - HackRF streams SIGNED 8-bit IQ; [SdrEngine] wants offset-128 uint8, so we XOR each byte with 0x80.
 * The HackRF mixes to true baseband internally — IQ arrives centred on the tuned frequency, non-inverted.
 * Control (frequency / sample-rate / gain) is read from @Volatile fields the engine mutates; the RX loop applies
 * any pending change between buffers so the UI can retune live.
 */
object HackRfOne {
    @Volatile var running = false; private set
    @Volatile private var stop = false
    fun abort() { stop = true }

    // ---- Live control (set by SdrEngine; applied by the RX loop). Defaults match SdrEngine's WFM start-up. ----
    @Volatile var targetFreqHz = 92_300_000L      // default: FM broadcast demo station
    @Volatile var targetRateHz = 2_000_000        // 2 Msps — the Pro-clean rate (2.4 Msps gave all-zeros on the Pro)
    /** Total front-end gain in tenths of a dB; used only when no per-stage override is set. */
    @Volatile var targetGainTenthDb = 480
    // Explicit per-stage gain override (>=0 wins over the targetGainTenthDb split). The engine always sets these:
    // radio = user's amp/LNA/VGA (default LNA 24 / VGA 24 / amp OFF), ADS-B = Mayhem's proven LNA 32 / VGA 32 / amp ON.
    @Volatile var ovrLnaDb = 24
    @Volatile var ovrVgaDb = 24
    @Volatile var ovrAmp = 0                      // 1=on, 0=off, -1=derive from targetGainTenthDb

    /** Board id / firmware string read at bring-up, for the UI. */
    @Volatile var boardLabel = ""; private set

    /** A transmission: the driver leaves RX, streams signed-int8 IQ from [fill] (return bytes written, 0 = done)
     *  on the bulk-OUT pipe at [rateHz] / [freqHz] with TX VGA [txVgaDb] (0..47) and the amp, then brings RX back. */
    class TxJob(val label: String, val freqHz: Long, val rateHz: Int, val txVgaDb: Int, val amp: Boolean, val fill: (ByteArray) -> Int, val onDone: (String?) -> Unit)
    @Volatile private var txJob: TxJob? = null
    @Volatile private var txCancel = false
    @Volatile var txActive = false; private set
    /** Queue a transmission; the RX loop picks it up between buffers. False if the radio isn't running or busy. */
    fun transmit(job: TxJob): Boolean { if (!running || txJob != null || txActive) return false; txCancel = false; txJob = job; return true }
    fun abortTx() { txCancel = true }
    @Volatile var firmware = ""; private set

    // libhackrf vendor request codes (hackrf.h, enum hackrf_vendor_request)
    private const val REQ_SET_TRANSCEIVER_MODE = 1
    private const val REQ_SAMPLE_RATE_SET = 6
    private const val REQ_BASEBAND_FILTER_BW_SET = 7
    private const val REQ_BOARD_ID_READ = 14
    private const val REQ_VERSION_STRING_READ = 15
    private const val REQ_BOARD_REV_READ = 45
    private const val REQ_SET_FREQ = 16
    private const val REQ_AMP_ENABLE = 17
    private const val REQ_SET_LNA_GAIN = 19
    private const val REQ_SET_VGA_GAIN = 20
    private const val REQ_SET_HW_SYNC_MODE = 29
    private const val TRANSCEIVER_MODE_OFF = 0
    private const val TRANSCEIVER_MODE_RECEIVE = 1
    private const val TRANSCEIVER_MODE_TRANSMIT = 2
    private const val REQ_SET_TXVGA_GAIN = 21

    private const val CTRL_IN = 0xC0
    private const val CTRL_OUT = 0x40
    private const val CTRL_TIMEOUT = 300
    private const val FREQ_ONE_MHZ = 1_000_000L

    // MAX2837 baseband low-pass filter bandwidths the HackRF supports (Hz), ascending (hackrf.c).
    private val BB_FILTER_BW = intArrayOf(
        1_750_000, 2_500_000, 3_500_000, 5_000_000, 5_500_000, 6_000_000, 7_000_000, 8_000_000,
        9_000_000, 10_000_000, 12_000_000, 14_000_000, 15_000_000, 20_000_000, 24_000_000, 28_000_000
    )

    private lateinit var conn: UsbDeviceConnection
    /** The frequency the radio has actually been set to, so a sweep knows when its retune has landed. */
    @Volatile var appliedFreq = 0L; private set
    @Volatile private var appliedRate = 0
    @Volatile private var appliedGain = Int.MAX_VALUE
    @Volatile private var appliedOvrLna = Int.MIN_VALUE   // track the gain OVERRIDE too, so a mode switch that changes
    @Volatile private var appliedOvrVga = Int.MIN_VALUE   // only the override (ADS-B 32/32/amp-on) actually re-applies
    @Volatile private var appliedOvrAmp = Int.MIN_VALUE
    private var dbgBuffers = 0    // one-shot raw-buffer probe counter (first few RX buffers logged)
    private var zeroHintShown = false   // one-shot "all-zero RX" hint per connect

    /** Blocking: opens the device, brings the radio up and streams IQ until [abort] or an error. Run on a
     *  dedicated thread. [onStatus] receives short human-readable state lines for the UI. */
    fun run(ctx: Context, device: UsbDevice, onStatus: (String) -> Unit) {
        if (running) return
        running = true; stop = false
        appliedFreq = 0L; appliedRate = 0; appliedGain = Int.MAX_VALUE; dbgBuffers = 0; zeroHintShown = false
        appliedOvrLna = Int.MIN_VALUE; appliedOvrVga = Int.MIN_VALUE; appliedOvrAmp = Int.MIN_VALUE
        SdrEngine.syncDriver()   // pull the engine's current mode/freq/gain into our target fields before bring-up
        val mgr = ctx.getSystemService(Context.USB_SERVICE) as UsbManager
        val c = mgr.openDevice(device) ?: run { onStatus("HackRF: couldn't open device"); running = false; return }
        conn = c
        var epRx: UsbEndpoint? = null
        var epTx: UsbEndpoint? = null
        try {
            val intf = device.getInterface(0)
            c.claimInterface(intf, true)
            for (i in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(i)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_IN && epRx == null) epRx = ep
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT && epTx == null) epTx = ep
            }
            val rx = epRx ?: run { Diag.log("HackRF: no bulk-IN endpoint"); onStatus("HackRF: no IQ endpoint"); return }
            Diag.log("HackRF: RX endpoint=0x%02x interfaces=%d (expect ep 0x81)".format(rx.address, device.interfaceCount))
            // NOTE: no CLEAR_FEATURE(HALT) here — libhackrf never issues one; it only perturbs the endpoint.

            Diag.log("=== HackRF bring-up (raw SDR, userspace libhackrf port) ===")
            onStatus("HackRF · initializing…")
            // Presence probe: BOARD_ID_READ answers a small board id on a genuine HackRF (see boardName). This
            // is how a HackRF Pro (board id 5 "Praline") is identified — it shares the HackRF One USB PID (0x6089)
            // and the same libhackrf command set, so this one driver handles One / One r9 / Pro / Jawbreaker / rad1o.
            val boardId = readBoardId()
            boardLabel = boardName(boardId)
            SdrEngine.onBoard()
            Diag.log("HackRF: board id = $boardId ($boardLabel)")
            // Read-backs prove the control plane round-trips AND pin the exact firmware. A non-empty version string
            // here = host↔device control works, so any RX failure is downstream in the RF/mixer path, not transport.
            firmware = readVersionString()
            Diag.log("HackRF: fw='$firmware' boardRev=${readBoardRev()}")

            while (!stop) {
                bringUpRx(onStatus)
                streamLoop(c, rx, onStatus)
                val job = txJob ?: break
                txJob = null
                if (stop) break
                doTransmit(c, epTx, job, onStatus)
            }
        } catch (t: Throwable) {
            Diag.log("HackRF error: ${t.message}")
            onStatus("HackRF stopped: ${t.message}")
        } finally {
            SdrEngine.setActive(false)
            runCatching { setTransceiverMode(TRANSCEIVER_MODE_OFF) }
            runCatching { c.close() }
            running = false
            Diag.log("HackRF: RX loop stopped")
        }
    }

    /** RX bring-up: clean slate, configure, RECEIVE, then the Pro's cache-busting re-tune. Re-run after every TX. */
    private fun bringUpRx(onStatus: (String) -> Unit) {
        // Clean slate BEFORE configuring: force transceiver OFF, then clear hardware-sync. A HackRF left in a
        // stale RECEIVE (a crashed prior session) makes a second RECEIVE a firmware NO-OP that never re-runs the
        // RX front-end/clock bring-up → it ACKs + streams but delivers ALL ZEROS. And if HW-sync was left
        // enabled, the firmware waits for an external trigger and streams zeros. Both are one-shot fixes;
        // libhackrf is never in these states because it forces OFF on close.
        setTransceiverMode(TRANSCEIVER_MODE_OFF); Thread.sleep(100)   // Pro/Praline FPGA needs longer settle
        setHwSyncMode(false)

        // Config, capturing each control-transfer return code. A negative rc = the transfer FAILED — if the
        // front-end config doesn't land, the ADC streams near-zero IQ (the "all-zeros, iqRMS≈0.85, gain has no
        // effect" symptom).
        val rcSr = setSampleRate(targetRateHz); appliedRate = targetRateHz
        val rcBb = setBasebandFilter(bbFilterRoundDownLt(targetRateHz))
        val rcFq = setCenterFreq(targetFreqHz); appliedFreq = targetFreqHz
        val (rcAmp, rcLna, rcVga) = applyGainStages(targetGainTenthDb); appliedGain = targetGainTenthDb
        val rcRx = setTransceiverMode(TRANSCEIVER_MODE_RECEIVE)
        // ★ THE PRO FIX — cache-busting post-RECEIVE re-tune. Source-confirmed against Mayhem radio.cpp
        // (set_tuning_frequency, PRALINE path): the Pro is NOT zero-IF. It tunes the analog passband off-centre
        // by Fs/4 and the iCE40 FPGA rotates it back to DC (the "quarter shift", FPGA_REG_RX_PSTEP). Entering RX
        // (set_direction) CLEARS the quarter shift, and ONLY set_tuning_frequency re-applies it — tuning
        // off-centre without the rotation puts the signal outside the decimation filter's passband and it
        // disappears entirely (== all-zeros). The firmware's tuning path caches the frequency, so an unchanged
        // re-tune is a NO-OP → write an off-target freq FIRST to bust the cache, THEN the real target. Also
        // re-apply gains (entering RX can reset them on the Pro). Harmless on a standard zero-IF HackRF.
        Thread.sleep(40)
        setCenterFreq(targetFreqHz + 1_000_000L)   // cache-bust: make the real target below differ from the cached freq
        val rcFq2 = setCenterFreq(targetFreqHz)     // real target → re-runs tuning AFTER RX → re-programs the FPGA quarter shift
        val (rcAmp2, rcLna2, rcVga2) = applyGainStages(targetGainTenthDb)
        appliedOvrLna = ovrLnaDb; appliedOvrVga = ovrVgaDb; appliedOvrAmp = ovrAmp
        Thread.sleep(60)   // RFFC5072 LO relock + FPGA quarter-shift/decim recompute settle before RX reads
        Diag.log("HackRF cfg rc (>=0 ok, <0 FAILED): sampleRate=$rcSr basebandFilter=$rcBb setFreq=$rcFq amp=$rcAmp lna=$rcLna vga=$rcVga rxMode=$rcRx · post-RX cachebust+reassert(freq=$rcFq2 amp=$rcAmp2 lna=$rcLna2 vga=$rcVga2)")
        SdrEngine.sourceLabel = boardLabel
        SdrEngine.onSource(targetRateHz)
        SdrEngine.setActive(true)
        Diag.log("HackRF: streaming IQ @ %.3f MHz, %.2f Msps".format(targetFreqHz / 1e6, targetRateHz / 1e6))
        onStatus("$boardLabel · %.3f MHz".format(targetFreqHz / 1e6))

    }

    /** Transmit one job on the bulk-OUT pipe, then leave the radio OFF for the caller to bring RX back. */
    private fun doTransmit(c: UsbDeviceConnection, epTx: UsbEndpoint?, job: TxJob, onStatus: (String) -> Unit) {
        if (epTx == null) { job.onDone("no bulk-OUT endpoint"); return }
        txActive = true
        SdrEngine.setActive(false)
        var err: String? = null
        try {
            Diag.log("HackRF TX: ${job.label} @ %.4f MHz, %.2f Msps, txvga=%d amp=%s".format(job.freqHz / 1e6, job.rateHz / 1e6, job.txVgaDb, job.amp))
            onStatus("TX · ${job.label}")
            setTransceiverMode(TRANSCEIVER_MODE_OFF); Thread.sleep(50)
            setSampleRate(job.rateHz); setBasebandFilter(bbFilterRoundDownLt(job.rateHz))
            setCenterFreq(job.freqHz + 1_000_000L); setCenterFreq(job.freqHz)
            setAmp(job.amp); setTxVgaGain(job.txVgaDb.coerceIn(0, 47))
            Thread.sleep(40)
            setTransceiverMode(TRANSCEIVER_MODE_TRANSMIT)
            val buf = ByteArray(16384)
            var sent = 0L
            while (!stop && !txCancel) {
                val n = job.fill(buf)
                if (n <= 0) break
                val rc = c.bulkTransfer(epTx, buf, n, 1000)
                if (rc < 0) { err = "bulk OUT failed ($rc)"; break }
                sent += rc
            }
            java.util.Arrays.fill(buf, 0)
            repeat(2) { c.bulkTransfer(epTx, buf, buf.size, 500) }
            Diag.log("HackRF TX: done, %.1f MB sent%s".format(sent / 1e6, if (txCancel) " (stopped)" else ""))
        } catch (t: Throwable) {
            err = t.message
        } finally {
            runCatching { setTransceiverMode(TRANSCEIVER_MODE_OFF) }
            runCatching { setAmp(false) }
            Thread.sleep(60)
            txActive = false
            appliedFreq = 0L; appliedRate = 0; appliedGain = Int.MAX_VALUE
            job.onDone(err)
        }
    }

    // ---- IQ streaming (async UsbRequest pool) ----------------------------------------------------------------
    private fun streamLoop(c: UsbDeviceConnection, rx: UsbEndpoint, onStatus: (String) -> Unit) {
        val nbuf = 12; val bufSz = 16384                 // 12 × 16 KB in flight
        val buffers = Array(nbuf) { ByteBuffer.allocateDirect(bufSz) }
        val reqs = ArrayList<UsbRequest>(nbuf)
        var ok = true
        for (i in 0 until nbuf) {
            val r = UsbRequest()
            if (!r.initialize(c, rx)) { ok = false; break }
            r.clientData = i; buffers[i].clear()
            if (!r.queue(buffers[i])) { ok = false; break }
            reqs.add(r)
        }
        if (!ok) {
            UsbRequests.drainAndClose(c, reqs)
            streamLoopSync(c, rx, onStatus); return
        }
        val scratch = ByteArray(bufSz)
        var lastStatus = 0L
        try {
            while (!stop && txJob == null) {
                applyPendingRetune(onStatus)
                val req = try { c.requestWait(100L) } catch (e: TimeoutException) { null } ?: continue
                val idx = req.clientData as? Int ?: -1
                if (idx in 0 until nbuf) {
                    val b = buffers[idx]
                    val n = b.position()
                    var len = 0
                    if (n in 1..bufSz) {
                        b.rewind(); b.get(scratch, 0, n); len = n
                        // One-shot raw-buffer probe on the RAW signed samples (before conversion): are they literal
                        // zeros (RX/clock not sampling) or real data we're misreading? Logs the first few buffers.
                        if (dbgBuffers < 3) {
                            dbgBuffers++
                            var nz = 0; var mn = 127; var mx = -128
                            val hex = StringBuilder()
                            for (k in 0 until n) { val v = scratch[k].toInt(); if (v != 0) nz++; if (v < mn) mn = v; if (v > mx) mx = v }
                            for (k in 0 until minOf(16, n)) hex.append("%02x ".format(scratch[k].toInt() and 0xff))
                            Diag.log("HackRF raw: n=$n nonZero=$nz/$n min=$mn max=$mx first16=[$hex]")
                            if (!zeroHintShown && nz * 50 < n) {
                                zeroHintShown = true
                                Diag.log("HackRF: RX is all-zero samples — front-end delivering nothing. Check the antenna and a data-capable OTG cable / powered hub. (A HackRF Pro inside a PortaPack running Mayhem streams zeros to a raw-SDR host until the device is put in on-screen 'HackRF' mode.)")
                                onStatus("HackRF: no signal — check antenna / cable / PortaPack mode")
                            }
                        }
                        for (k in 0 until n) scratch[k] = (scratch[k].toInt() xor 0x80).toByte()   // signed int8 → offset-128 uint8
                    }
                    b.clear()
                    if (!runCatching { req.queue(b) }.getOrDefault(false)) {
                        runCatching { req.close() }
                        val nr = UsbRequest()
                        if (runCatching { nr.initialize(c, rx) }.getOrDefault(false)) {
                            nr.clientData = idx; b.clear(); if (runCatching { nr.queue(b) }.getOrDefault(false)) reqs[idx] = nr
                        }
                    }
                    if (len > 0) runCatching { SdrEngine.onIq(scratch, len) }
                    val now = System.currentTimeMillis()
                    if (now - lastStatus > 1000L) { lastStatus = now; onStatus("$boardLabel · %.3f MHz".format(appliedFreq / 1e6)) }
                }
            }
        } finally {
            UsbRequests.drainAndClose(c, reqs)
        }
    }

    private fun streamLoopSync(c: UsbDeviceConnection, rx: UsbEndpoint, onStatus: (String) -> Unit) {
        Diag.log("HackRF: async RX unavailable — synchronous fallback")
        val buf = ByteArray(16384)
        while (!stop && txJob == null) {
            applyPendingRetune(onStatus)
            val n = c.bulkTransfer(rx, buf, buf.size, 500)
            if (n > 0) {
                for (k in 0 until n) buf[k] = (buf[k].toInt() xor 0x80).toByte()
                runCatching { SdrEngine.onIq(buf, n) }
            }
        }
    }

    /** Apply any freq / rate / gain change the engine requested since the last buffer (retune between buffers so
     *  IQ never straddles a tune). */
    private fun applyPendingRetune(onStatus: (String) -> Unit) {
        val rateChanged = targetRateHz != appliedRate
        val freqChanged = targetFreqHz != appliedFreq
        val gainChanged = targetGainTenthDb != appliedGain ||
            ovrLnaDb != appliedOvrLna || ovrVgaDb != appliedOvrVga || ovrAmp != appliedOvrAmp
        if (!rateChanged && !freqChanged && !gainChanged) return
        if (rateChanged) {
            runCatching { setSampleRate(targetRateHz); setBasebandFilter(bbFilterRoundDownLt(targetRateHz)); SdrEngine.onSource(targetRateHz) }
            appliedRate = targetRateHz
        }
        // Any freq or rate change → CACHE-BUST re-tune (off-target then target) so the Pro's FPGA quarter-shift is
        // re-programmed. Without this a mid-stream mode switch (e.g. radio→ADS-B) retunes to 1090 but leaves the
        // quarter-shift stale → no aircraft. Same trick as bring-up; here it also covers a plain rate change.
        if (freqChanged || rateChanged) {
            runCatching { setCenterFreq(targetFreqHz + 1_000_000L); setCenterFreq(targetFreqHz) }
            appliedFreq = targetFreqHz
            Thread.sleep(50)   // let the RFFC5072 LO relock + FPGA quarter-shift/decim settle before the next read
            onStatus("$boardLabel · %.3f MHz".format(appliedFreq / 1e6))
        }
        if (gainChanged) {
            runCatching { applyGainStages(targetGainTenthDb) }
            appliedGain = targetGainTenthDb; appliedOvrLna = ovrLnaDb; appliedOvrVga = ovrVgaDb; appliedOvrAmp = ovrAmp
        }
    }

    // ================= HackRF vendor protocol (libhackrf hackrf.c) =================

    private fun readBoardId(): Int {
        val b = ByteArray(1)
        val r = conn.controlTransfer(CTRL_IN, REQ_BOARD_ID_READ, 0, 0, b, 1, CTRL_TIMEOUT)
        return if (r == 1) b[0].toInt() and 0xff else -1
    }
    // libhackrf hackrf_board_id enum: 0 Jellybean, 1 Jawbreaker, 2 HackRF One (OG), 3 rad1o, 4 HackRF One r9,
    // 5 Praline = HackRF Pro. All speak the same vendor protocol, so this driver drives them all.
    private fun boardName(id: Int) = when (id) {
        0 -> "Jellybean"; 1 -> "Jawbreaker"; 2 -> "HackRF One"; 3 -> "rad1o"; 4 -> "HackRF One r9"; 5 -> "HackRF Pro"; else -> "HackRF?"
    }

    /** Firmware version string (VERSION_STRING_READ) — proves control round-trips + identifies the firmware. */
    private fun readVersionString(): String {
        val b = ByteArray(255)
        val r = runCatching { conn.controlTransfer(CTRL_IN, REQ_VERSION_STRING_READ, 0, 0, b, b.size, CTRL_TIMEOUT) }.getOrDefault(-1)
        return if (r > 0) String(b, 0, r, Charsets.US_ASCII).trim() else "?(rc=$r)"
    }
    /** Board revision byte (BOARD_REV_READ); -1 if the request isn't supported by this firmware. */
    private fun readBoardRev(): Int {
        val b = ByteArray(1)
        val r = runCatching { conn.controlTransfer(CTRL_IN, REQ_BOARD_REV_READ, 0, 0, b, 1, CTRL_TIMEOUT) }.getOrDefault(-1)
        return if (r == 1) b[0].toInt() and 0xff else -1
    }

    private fun setTransceiverMode(mode: Int): Int =
        ctrl(CTRL_OUT, REQ_SET_TRANSCEIVER_MODE, mode, 0, null, 0, "TRXMODE")

    /** Hardware-sync (external trigger) mode. We always disable it — if a prior app left it on, the firmware
     *  waits for a trigger and streams zeros. */
    private fun setHwSyncMode(on: Boolean): Int =
        ctrl(CTRL_OUT, REQ_SET_HW_SYNC_MODE, if (on) 1 else 0, 0, null, 0, "HWSYNC")

    /** Control-transfer wrapper: logs the EXACT request/wValue/wIndex/data/rc of every RF-config transfer so a
     *  diag capture shows precisely what the host sent (to diff against libhackrf when RX comes up all-zero).
     *  Volume is low — config transfers only happen at bring-up + on a user retune, never per IQ buffer. */
    private fun ctrl(dir: Int, req: Int, wValue: Int, wIndex: Int, data: ByteArray?, len: Int, tag: String): Int {
        val rc = conn.controlTransfer(dir, req, wValue, wIndex, data, len, CTRL_TIMEOUT)
        val hex = if (data != null && len > 0) " data=[" + (0 until minOf(len, 8)).joinToString(" ") { "%02x".format(data[it].toInt() and 0xff) } + "]" else ""
        Diag.log("HackRF tx %-9s %s req=%d wV=0x%04x wI=0x%04x len=%d rc=%d%s".format(
            tag, if (dir == CTRL_IN) "IN " else "OUT", req, wValue, wIndex, len, rc, hex))
        return rc
    }

    /** SAMPLE_RATE_SET carries {uint32 freq_hz, uint32 divider} little-endian; we use divider=1. The baseband
     *  filter is set separately by the caller (so each return code can be checked independently). */
    private fun setSampleRate(rate: Int): Int {
        val d = ByteArray(8)
        putLe32(d, 0, rate); putLe32(d, 4, 1)
        return ctrl(CTRL_OUT, REQ_SAMPLE_RATE_SET, 0, 0, d, 8, "SAMPLERATE")
    }

    private fun setBasebandFilter(bwHz: Int): Int =
        ctrl(CTRL_OUT, REQ_BASEBAND_FILTER_BW_SET, bwHz and 0xffff, (bwHz shr 16) and 0xffff, null, 0, "BBFILTER")
    /** Largest supported baseband bandwidth strictly less than [rate] (falls back to the smallest). */
    private fun bbFilterRoundDownLt(rate: Int): Int {
        var chosen = BB_FILTER_BW[0]
        for (bw in BB_FILTER_BW) { if (bw < rate) chosen = bw else break }
        return chosen
    }

    /** SET_FREQ carries {uint32 freq_mhz, uint32 freq_hz} little-endian (freq = mhz*1e6 + hz). */
    private fun setCenterFreq(freqHz: Long): Int {
        val mhz = (freqHz / FREQ_ONE_MHZ)
        val hz = (freqHz - mhz * FREQ_ONE_MHZ)
        val d = ByteArray(8)
        putLe32(d, 0, mhz.toInt()); putLe32(d, 4, hz.toInt())
        return ctrl(CTRL_OUT, REQ_SET_FREQ, 0, 0, d, 8, "SETFREQ")
    }

    // ---- Gain: amp(0/14) + LNA(0..40/8) + VGA(0..62/2) — the MAX2837 stages Mayhem's receiver_model surfaces ----
    /** Returns (ampRc, lnaRc, vgaRc) — the three control-transfer results, for the config diagnostic. */
    private fun applyGainStages(tenthDb: Int): Triple<Int, Int, Int> {
        // Explicit per-stage override — the normal path (the engine always sets all three).
        if (ovrLnaDb >= 0) {
            val lna = ovrLnaDb.coerceIn(0, 40) and 0x07.inv()
            val vga = ovrVgaDb.coerceIn(0, 62) and 0x01.inv()
            return Triple(setAmp(ovrAmp > 0), setLnaGain(lna), setVgaGain(vga))
        }
        // Fallback split of a single total across LNA + VGA, amp OFF: the +14 dB amp overloads strong FM
        // broadcast (ADC rails → silence/static), so it is never switched on implicitly.
        val total = (tenthDb / 10).coerceIn(0, 40 + 62)
        val lna = (total / 2).coerceIn(0, 40) and 0x07.inv()
        val vga = (total - lna).coerceIn(0, 62) and 0x01.inv()
        return Triple(setAmp(false), setLnaGain(lna), setVgaGain(vga))
    }
    private fun setAmp(on: Boolean): Int =
        ctrl(CTRL_OUT, REQ_AMP_ENABLE, if (on) 1 else 0, 0, null, 0, "AMP")
    private fun setLnaGain(db: Int): Int =
        ctrl(CTRL_IN, REQ_SET_LNA_GAIN, 0, db and 0xffff, ByteArray(1), 1, "LNA")   // RF LNA (IN, 1-byte ack)
    private fun setVgaGain(db: Int): Int =
        ctrl(CTRL_IN, REQ_SET_VGA_GAIN, 0, db and 0xffff, ByteArray(1), 1, "VGA")   // baseband VGA (IN, 1-byte ack)
    private fun setTxVgaGain(db: Int): Int =
        ctrl(CTRL_IN, REQ_SET_TXVGA_GAIN, 0, db and 0xffff, ByteArray(1), 1, "TXVGA")   // TX IF gain 0..47 (IN, 1-byte ack)

    private fun putLe32(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xff).toByte()
        b[off + 1] = ((v shr 8) and 0xff).toByte()
        b[off + 2] = ((v shr 16) and 0xff).toByte()
        b[off + 3] = ((v shr 24) and 0xff).toByte()
    }
}
