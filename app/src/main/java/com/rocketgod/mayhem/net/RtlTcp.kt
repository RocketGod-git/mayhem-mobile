package com.rocketgod.mayhem.net

import android.content.Context
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.usb.RtlSdr
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * An RTL-SDR on the network: a dongle somewhere else (the garage, the roof) behind `rtl_tcp`, used as the radio in
 * place of one on USB. It is an RTL-SDR in every way the app cares about: the same kind, limits and controls, and the
 * engine gets the same bytes it gets from [RtlSdr], so every app works on it unchanged. The settings the app sets on
 * [RtlSdr] (frequency, rate, gain, AGCs, ppm, bias tee, direct sampling) are read from there and sent to the server.
 *
 * Picking it is the user's choice and is remembered: while it is on, a dongle or HackRF plugged into USB is left
 * alone, and turning it off hands the radio back to USB. A dropped link is retried on its own, backing off to 30 s.
 */
object RtlTcp {
    enum class Phase { OFF, CONNECTING, STREAMING, RETRYING }

    private val _phase = MutableStateFlow(Phase.OFF)
    val phase: StateFlow<Phase> = _phase.asStateFlow()
    private val _status = MutableStateFlow("")
    /** One line for the screen: connecting, connected and to what, or lost and when it tries again. */
    val status: StateFlow<String> = _status.asStateFlow()

    private val _host = MutableStateFlow("")
    val host: StateFlow<String> = _host.asStateFlow()
    private val _port = MutableStateFlow(RtlTcpLink.DEFAULT_PORT)
    val port: StateFlow<Int> = _port.asStateFlow()

    /** The user picked the network radio (remembered across launches). */
    @Volatile var wanted = false; private set
    /** The network radio is the app's radio: from the first connect attempt until it is turned off or the app closes. */
    @Volatile var active = false; private set
    @Volatile var label = "rtl_tcp"; private set
    @Volatile var tuner = ""; private set
    @Volatile var gainSteps = 0; private set
    @Volatile private var tunerType = 0
    @Volatile var appliedFreq = 0L; private set
    /** Direct sampling is offered on an R820T, as on USB. */
    val canDirectSample get() = RtlTcpLink.canDirectSample(tunerType)
    val hfReady get() = canDirectSample && RtlSdr.directSamplingAllowed

    /** Samples the server owed but never sent while connected (its own buffer overflowing, or the link too slow). */
    @Volatile var shortSamples = 0L; private set

    /** Set by the activity: stop a USB radio and wait for it (called on the network thread before connecting). */
    @Volatile var releaseUsb: (() -> Unit)? = null
    /** Set by the activity: the network radio was turned off, so USB may take over again. */
    @Volatile var onReleased: (() -> Unit)? = null

    private var prefs: android.content.SharedPreferences? = null
    private var app: Context? = null

    /** Android 17 drops an app's connections to the home network until it holds ACCESS_LOCAL_NETWORK. */
    const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    fun needsLocalNetwork(ctx: Context? = app): Boolean =
        android.os.Build.VERSION.SDK_INT >= 37 && ctx != null &&
            ctx.checkSelfPermission(LOCAL_NETWORK) != android.content.pm.PackageManager.PERMISSION_GRANTED

    /** The permission was refused: say so instead of retrying a connection Android will drop. */
    fun localNetworkRefused() {
        _phase.value = Phase.OFF; _status.value = "Needs permission to reach devices on your network"
    }
    @Volatile private var thread: Thread? = null
    @Volatile private var link: RtlTcpLink? = null
    @Volatile private var gen = 0

    private const val STALL_MS = 5_000L
    private const val MAX_BACKOFF_MS = 30_000L

    fun where(h: String = _host.value, p: Int = _port.value) = "$h:$p"

    /** Load the remembered server; true when the network radio was on when the app last closed. */
    fun load(ctx: Context): Boolean {
        app = ctx.applicationContext
        val p = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE); prefs = p
        _host.value = p.getString("rtltcp_host", "") ?: ""
        _port.value = p.getInt("rtltcp_port", RtlTcpLink.DEFAULT_PORT).takeIf { it in 1..65535 } ?: RtlTcpLink.DEFAULT_PORT
        return p.getBoolean("rtltcp_on", false) && _host.value.isNotBlank()
    }

    /** Remember the server without connecting (typed in the panel). */
    fun remember(h: String, p: Int) {
        _host.value = h.trim(); if (p in 1..65535) _port.value = p
        prefs?.edit()?.putString("rtltcp_host", _host.value)?.putInt("rtltcp_port", _port.value)?.apply()
    }

    /** Use the server at [h]:[p] as the radio. */
    fun connect(h: String = _host.value, p: Int = _port.value) {
        val hh = h.trim()
        if (hh.isEmpty() || p !in 1..65535) return
        remember(hh, p)
        prefs?.edit()?.putBoolean("rtltcp_on", true)?.apply()
        if (needsLocalNetwork()) { localNetworkRefused(); return }
        val old = thread
        if (wanted && old?.isAlive == true && link?.let { it.host == hh && it.port == p } == true) return
        stopThread()
        wanted = true
        val my = ++gen
        _phase.value = Phase.CONNECTING; _status.value = "Connecting to ${where()}…"
        thread = Thread({
            runCatching { old?.join(3000) }
            runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO) }
            run(my, hh, p)
        }, "rtltcp-rx").apply { isDaemon = true; start() }
    }

    /** Stop using the network radio (the user's choice, remembered) and hand the radio back to USB. */
    fun disconnect() {
        prefs?.edit()?.putBoolean("rtltcp_on", false)?.apply()
        val was = wanted || thread?.isAlive == true
        stopThread()
        _phase.value = Phase.OFF; _status.value = "Disconnected"
        if (was) Thread({ runCatching { thread?.join(3000) }; onReleased?.invoke() }, "rtltcp-release").apply { isDaemon = true; start() }
    }

    /** The app is closing: stop, but leave the choice remembered for next time. */
    fun shutdown() = stopThread()

    private fun stopThread() {
        wanted = false
        gen++
        link?.close()
        thread?.interrupt()
    }

    private fun targets() = RtlTcpTargets(
        freqHz = RtlSdr.targetFreqHz,
        rateHz = RtlSdr.targetRateHz,
        gainTenthDb = if (RtlSdr.tunerAgc) -1 else RtlSdr.targetGainTenthDb,
        rtlAgc = RtlSdr.rtlAgc,
        ppm = RtlSdr.ppm,
        biasTee = RtlSdr.targetBiasTee,
        directSamplingAllowed = RtlSdr.directSamplingAllowed,
    )

    private fun live(my: Int) = wanted && my == gen

    /** Why a connection failed, in a few words. */
    private fun why(e: Throwable): String = when (e) {
        is RtlTcpLink.NotRtlTcp -> "not an rtl_tcp server"
        is UnknownHostException -> "unknown host"
        is ConnectException -> if (e.message?.contains("ECONNREFUSED") == true || e.message?.contains("refused", true) == true) "refused" else "can't connect"
        is NoRouteToHostException -> "no route to host"
        is SocketTimeoutException -> "no answer"
        else -> e.message?.substringBefore('(')?.substringBefore(':')?.trim()?.takeIf { it.isNotEmpty() && it.length < 40 } ?: (e::class.simpleName ?: "error")
    }

    private fun run(my: Int, h: String, p: Int) {
        val at = where(h, p)
        try {
            // the user picked the network: a USB radio running now steps aside first
            releaseUsb?.invoke()
            if (!live(my)) return
            active = true; appliedFreq = 0L; shortSamples = 0; label = "rtl_tcp · $at"; tuner = ""; tunerType = 0
            SdrEngine.onRadio(Radio.Kind.RTLSDR)
            var backoff = 1_000L
            var attempts = 0
            var lastWhy = ""
            var everStreamed = false
            while (live(my)) {
                _phase.value = Phase.CONNECTING
                if (attempts == 0) _status.value = "Connecting to $at…"
                val l = RtlTcpLink(h, p); link = l
                if (!live(my)) { l.close(); break }
                var streamedMs = 0L
                var reason: String
                try {
                    val info = l.open()
                    tunerType = info.tunerType; tuner = info.tuner; gainSteps = info.gainCount
                    label = "rtl_tcp · $at" + if (info.tunerType != 0) " · ${info.tuner}" else ""
                    Diag.log("=== rtl_tcp bring-up === $at · tuner ${info.tuner} (type ${info.tunerType}) · ${info.gainCount} gain steps · receive buffer ${l.receiveBuffer / 1024} KB")
                    if (attempts > 0) Diag.log("rtl_tcp: back on $at after ${attempts} ${if (attempts == 1) "retry" else "retries"}")
                    attempts = 0; lastWhy = ""
                    SdrEngine.syncDriver()
                    // the socket fills the jitter buffer; its own thread feeds the engine at the sample rate
                    val pacer = RtlTcpPacer({ b, n -> runCatching { SdrEngine.onIq(b, n) } }, Diag::log)
                    val stream = RtlTcpStream(l, info, ::targets, pacer::write, Diag::log)
                    stream.applyPending()
                    pacer.reset(stream.appliedRate)
                    appliedFreq = stream.appliedFreq
                    SdrEngine.sourceLabel = label
                    SdrEngine.onSource(stream.appliedRate)
                    SdrEngine.setActive(true)
                    Diag.log("rtl_tcp: streaming %.3f MHz @ %.3f Msps".format(stream.appliedFreq / 1e6, stream.appliedRate / 1e6))
                    _phase.value = Phase.STREAMING; everStreamed = true
                    _status.value = "Connected to $at · ${info.tuner}"
                    val pace = Thread({
                        runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO) }
                        try { while (!l.closed) { pacer.tick(System.nanoTime()); Thread.sleep(3) } } catch (_: InterruptedException) { }
                    }, "rtltcp-pace").apply { isDaemon = true; start() }
                    try { reason = stream(my, l, stream, pacer) } finally { l.close(); pace.interrupt(); runCatching { pace.join(500) } }
                    if (pacer.rebuffers > 0 || pacer.overflowBytes > 0) Diag.log("rtl_tcp: jitter buffer ${pacer.rebuffers} rebuffers, ${pacer.overflowBytes} bytes overflowed this connection")
                    streamedMs = System.currentTimeMillis() - connectedAt
                } catch (e: IOException) {
                    reason = if (l.closed && !live(my)) "" else why(e)
                } finally {
                    l.close()
                    SdrEngine.setActive(false)
                }
                if (!live(my)) break
                if (streamedMs > 10_000L) backoff = 1_000L
                attempts++
                // the first failure, and each new kind of failure, goes in the log; the same one again does not
                if (reason != lastWhy) { Diag.log("rtl_tcp: $at $reason, retrying with backoff"); lastWhy = reason }
                val waitS = backoff / 1000
                _status.value = if (streamedMs > 0) "Lost $at, retrying in $waitS s"
                    else if (everStreamed) "Lost $at ($reason), retrying in $waitS s"
                    else "Can't reach $at ($reason), retrying in $waitS s"
                _phase.value = Phase.RETRYING
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { }
                backoff = minOf(backoff * 2, MAX_BACKOFF_MS)
            }
        } catch (t: Throwable) {
            Diag.log("rtl_tcp error: ${t.message}")
        } finally {
            // a newer connection (another server picked) takes over from here; otherwise the radio is gone
            if (my == gen || !wanted) {
                SdrEngine.setActive(false)
                if (active) SdrEngine.onRadio(Radio.Kind.NONE)
                active = false; appliedFreq = 0L
                _phase.value = Phase.OFF
                _status.value = if (wanted) "Stopped after an error" else "Disconnected"
                wanted = false
            }
            Diag.log("rtl_tcp: RX loop stopped")
        }
    }

    @Volatile private var connectedAt = 0L

    /** Stream until the link drops or the user stops it; returns why it ended. */
    private fun stream(my: Int, l: RtlTcpLink, s: RtlTcpStream, pacer: RtlTcpPacer): String {
        connectedAt = System.currentTimeMillis()
        var lastData = connectedAt
        var lastStatus = 0L
        // Delivery against what the rate says the server owes, over 10 s windows that start 2 s after a (re)tune of
        // the rate, so the burst a server sends on connect does not hide a shortfall. TCP itself loses nothing: a
        // shortfall is the server dropping buffers it could not send in time.
        var winStart = connectedAt + 2_000L; var winBytes0 = -1L
        var short = false; var shortSaid = 0L; var shortText = ""
        while (live(my)) {
            val f0 = s.appliedFreq
            if (s.applyPending()) { SdrEngine.onSource(s.appliedRate); pacer.reset(s.appliedRate); winStart = System.currentTimeMillis() + 2_000L; winBytes0 = -1L; short = false; shortText = "" }
            // samples buffered at the old frequency are not played at the new one
            else if (s.appliedFreq != f0) pacer.reset(s.appliedRate)
            appliedFreq = s.appliedFreq
            val n = s.pump()
            val now = System.currentTimeMillis()
            if (n < 0) return "closed by the server"
            if (n > 0) lastData = now else if (now - lastData > STALL_MS) return "sent nothing for ${STALL_MS / 1000} s"
            if (now >= winStart && winBytes0 < 0) winBytes0 = l.bytesIn
            if (winBytes0 >= 0 && now - winStart >= 10_000L) {
                val got = (l.bytesIn - winBytes0) / 2
                val owed = s.appliedRate.toLong() * (now - winStart) / 1000
                if (got < owed * 95 / 100) {
                    shortSamples += owed - got
                    if (!short || now - shortSaid >= 60_000L) {
                        Diag.log("rtl_tcp: received %.2f of %.2f Msps over the last %d s (%d samples short since connecting)".format(
                            got / ((now - winStart) / 1000.0) / 1e6, s.appliedRate / 1e6, (now - winStart) / 1000, shortSamples))
                        shortSaid = now
                    }
                    short = true
                    shortText = " · receiving %.2f of %.2f Msps".format(got / ((now - winStart) / 1000.0) / 1e6, s.appliedRate / 1e6)
                } else if (short) { Diag.log("rtl_tcp: full rate again (%.2f Msps)".format(got / ((now - winStart) / 1000.0) / 1e6)); short = false; shortText = "" }
                winStart = now; winBytes0 = l.bytesIn
            }
            if (now - lastStatus > 1000L) { lastStatus = now; _status.value = "Connected to ${l.host}:${l.port} · ${tuner.ifEmpty { "RTL-SDR" }} · %.3f MHz".format(s.appliedFreq / 1e6) + shortText +
                (if (pacer.rebuffers > 0) " · ${pacer.rebuffers} ${if (pacer.rebuffers == 1) "rebuffer" else "rebuffers"}" else "") }
        }
        return ""
    }
}
