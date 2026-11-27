package com.rocketgod.mayhem

import com.rocketgod.mayhem.core.Units
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Prowl
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.ui.MayhemScreen
import com.rocketgod.mayhem.ui.Pip
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.HackRfUsb
import com.rocketgod.mayhem.usb.RtlSdr
import com.rocketgod.mayhem.net.RtlTcp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Phase 0 — link up. Finds a HackRF or an RTL-SDR on the USB-OTG port (hot-plug via the manifest USB_DEVICE_ATTACHED filter,
 * or already-attached at launch via enumeration + a permission request), then runs [HackRfOne] on its own
 * thread. Everything after "IQ is flowing" is [com.rocketgod.mayhem.core.SdrEngine] + the Compose screen.
 */
class MainActivity : ComponentActivity() {
    private val status = MutableStateFlow("no radio, plug in a HackRF or an RTL-SDR via USB-OTG, or connect one on your network in RADIO")
    private val connected = MutableStateFlow(false)
    private var rxThread: Thread? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val d = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
            when (intent.action) {
                HackRfUsb.ACTION_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    askingPermission = false
                    Diag.log("USB permission ${if (granted) "granted" else "DENIED"} for ${d?.let { HackRfUsb.describe(it) } ?: "?"}")
                    if (d != null && granted && HackRfUsb.isRadio(d)) engage(d)
                    else if (d != null && granted && HackRfUsb.isMayhemSerial(d)) {
                        Thread({ HackRfUsb.portapackToHackRf(applicationContext, d) }, "portapack-switch").start()
                        status.value = "PortaPack switching to HackRF mode…"
                    }
                    else status.value = "USB permission denied, replug to retry"
                }
                ACTION_PIP_MUTE -> SdrEngine.toggleMute()
                ACTION_PIP_SKIP -> Prowl.skip()
                // Plugged in while the app is open. The system also offers this to whichever app is the default for the
                // device, and another SDR app set as default meant this one never heard of the dongle; listening for the
                // broadcast as well means it always does.
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> if (d != null) {
                    Diag.log("USB attached: ${HackRfUsb.describe(d)}${if (HackRfUsb.isRadio(d)) "" else " (not a radio this app drives)"}")
                    if ((HackRfUsb.isRadio(d) || HackRfUsb.isMayhemSerial(d)) && !radioRunning()) autoConnect()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> if (d != null && HackRfUsb.isRadio(d)) {
                    Diag.log("USB detached: ${HackRfUsb.describe(d)}")
                    // the network radio is in use: a USB radio leaving changes nothing
                    if (RtlTcp.wanted || RtlTcp.active) return
                    HackRfOne.abort(); RtlSdr.abort()
                    connected.value = false
                    status.value = "${if (RtlSdr.isRtlSdr(d)) "RTL-SDR" else "HackRF"} detached"
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // first, so a crash anywhere after this leaves a report for the next launch
        CrashReport.install(this)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        hideStatusBar()
        // the auto-pick shows the whole listening band the dial is in, as wide as the band chips show it on this
        // screen, before it picks
        com.rocketgod.mayhem.core.AutoPick.viewWholeBand = viewWholeBand@{
            val b = com.rocketgod.mayhem.ui.bandAt(SdrEngine.channelHz()) ?: return@viewWholeBand
            // a span the user set by hand stays as it is: the pick looks across what they chose to see
            if (SdrEngine.spanByHand) return@viewWholeBand
            // A radio that sees most of the band in one span (a HackRF: 19.2 of FM's 20 MHz) shows it, as wide as
            // the band chips show it on this screen. A much narrower one (an RTL-SDR) opens on the dial at 2.4 Msps
            // and looks across the rest of the band a view at a time.
            val widest = SdrEngine.RX_RATES.filter { com.rocketgod.mayhem.core.Radio.canSample(com.rocketgod.mayhem.core.Radio.limits, it) }.maxOrNull() ?: SdrEngine.RX_RATE
            if (widest.toLong() * 2 >= b.hi - b.lo) {
                val cap = if (resources.configuration.screenWidthDp >= 600) 19_200_000 else 7_680_000
                SdrEngine.viewBand(b.lo, b.hi, b.mode, cap, keepDial = true)
            } else {
                // the hunt looks at 2.4 MHz at a time, the view at the dial first, then across the rest of the band
                SdrEngine.setWideScan(true); SdrEngine.recentre()
                if (b.mode == SdrEngine.Mode.WFM) com.rocketgod.mayhem.core.AutoPick.armThenSweep(b.lo, b.hi)
            }
        }
        Apps.init(this)
        com.rocketgod.mayhem.ui.Skins.load(this)
        com.rocketgod.mayhem.core.Units.load(this)
        SdrEngine.loadGains(this)
        val netOn = RtlTcp.load(this)
        // Picking the network radio stops a USB radio first; turning it off lets USB take over again.
        RtlTcp.releaseUsb = {
            if (radioUsbRunning() || rxThread?.isAlive == true) {
                Diag.log("rtl_tcp picked: stopping the USB radio")
                HackRfOne.abort(); RtlSdr.abort()
                runCatching { rxThread?.join(3000) }
            }
        }
        RtlTcp.onReleased = { runOnUiThread { if (!isDestroyed) { status.value = "network radio disconnected"; autoConnect() } } }
        com.rocketgod.mayhem.ui.Waterfalls.load(this)
        com.rocketgod.mayhem.core.Tx.load(this)
        com.rocketgod.mayhem.core.NavBar.load(this)
        com.rocketgod.mayhem.core.Station.load(this)
        com.rocketgod.mayhem.core.js8.Js8.init(this)
        com.rocketgod.mayhem.core.ham.Logbook.load(this)
        com.rocketgod.mayhem.core.sat.Tles.init(filesDir)
        com.rocketgod.mayhem.core.sonde.SondeHub.init(filesDir)
        Apps.cellFile = java.io.File(filesDir, "cell.json")
        com.rocketgod.mayhem.core.Dispatch.init(this)
        com.rocketgod.mayhem.core.AppVolume.init(this)
        com.rocketgod.mayhem.core.HamPlus.init(this)
        com.rocketgod.mayhem.core.Cb.init(this)
        com.rocketgod.mayhem.core.Gmrs.init(this)
        com.rocketgod.mayhem.core.ham.HamSpots.init(this)
        com.rocketgod.mayhem.core.analyzer.Analyzer.init(filesDir)
        if (savedInstanceState == null) {
            // Land on the launcher (the front door), not Audio, and arm the auto-pick so it tunes the strongest
            // signal in view the moment the radio delivers one — the landing comes up alive, like Audio does.
            if (Apps.current.value == null) {
                // Home is the front door, unless the user asked to come back to the app they last used
                val last = if (com.rocketgod.mayhem.core.NavBar.opensOnLast.value) com.rocketgod.mayhem.core.NavBar.lastApp() else null
                if (last != null && com.rocketgod.mayhem.core.Radio.blockedBecause(last).isEmpty() && !com.rocketgod.mayhem.core.AppVisibility.hidden(last)) Apps.open(last)
                else { Apps.home(); com.rocketgod.mayhem.core.AutoPick.armBand() }
            }
            Diag.clear()
            Diag.log("Mayhem Android ${BuildConfig.VERSION_NAME} · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        }
        // ATTACHED arrives through the manifest intent-filter (onNewIntent / the launch intent) with permission
        // already granted. The runtime receiver only needs DETACHED and our own permission-result broadcast.
        // NOT_EXPORTED: an exported receiver would let any app forge a "permission granted" broadcast.
        val f = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(HackRfUsb.ACTION_PERMISSION)
            addAction(ACTION_PIP_MUTE)
            addAction(ACTION_PIP_SKIP)
        }
        ContextCompat.registerReceiver(this, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED)

        // a crash since the last launch: offer to send the report to the developer or save it
        val crash = MutableStateFlow(CrashReport.pending(this))
        setContent {
            val st by status.collectAsState()
            val c by connected.collectAsState()
            MayhemScreen(status = st, connected = c)
            val report by crash.collectAsState()
            report?.let { r ->
                com.rocketgod.mayhem.ui.CrashDialog(CrashReport.headline(r),
                    onSend = {
                        runCatching { startActivity(CrashReport.sendIntent(this, r)) }
                            .onFailure { android.widget.Toast.makeText(this, "No email app found. Saved instead: ${CrashReport.save(this, r) ?: "could not save"}", android.widget.Toast.LENGTH_LONG).show() }
                        CrashReport.clear(this); crash.value = null
                    },
                    onSave = {
                        val where = CrashReport.save(this, r)
                        android.widget.Toast.makeText(this, if (where != null) "Saved to $where" else "Could not save the report", android.widget.Toast.LENGTH_LONG).show()
                        CrashReport.clear(this); crash.value = null
                    },
                    onDismiss = { CrashReport.clear(this); crash.value = null })
            }
        }

        // Keep the picture-in-picture offer in step with what is open, so leaving the app keeps a receiver on screen.
        lifecycleScope.launch {
            combine(Apps.current, SdrEngine.muted, connected, Prowl.view) { _, _, _, _ -> Unit }.collect { runCatching { setPictureInPictureParams(pipParams()) } }
        }

        // the network radio's state is the app's radio state while it is in use
        lifecycleScope.launch {
            var drove = false
            combine(RtlTcp.phase, RtlTcp.status) { p, t -> p to t }.collect { (p, t) ->
                if (p == RtlTcp.Phase.OFF) { if (drove && !radioUsbRunning()) connected.value = false; drove = false; return@collect }
                drove = true
                status.value = t
                connected.value = p == RtlTcp.Phase.STREAMING
            }
        }
        if (netOn && !RtlTcp.wanted) RtlTcp.connect()
        if (!handleIntent(intent)) autoConnect()
        debugExtras(intent)
        Geo.request(this)
        AppUpdates.check(this)
    }

    /** The radio is running, so something is being heard (the launcher listens too): worth a floating window. Transmit is not. */
    private fun pipWanted(): Boolean = connected.value && Apps.playing() != MayhemApp.TRANSMIT

    private fun pipAction(icon: Int, title: String, action: String, code: Int) = RemoteAction(
        Icon.createWithResource(this, icon), title, title,
        PendingIntent.getBroadcast(this, code, Intent(action).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))

    private fun pipParams(): PictureInPictureParams {
        val actions = mutableListOf(
            if (SdrEngine.muted.value) pipAction(R.drawable.ic_pip_mute, "Unmute", ACTION_PIP_MUTE, 1)
            else pipAction(R.drawable.ic_pip_sound, "Mute", ACTION_PIP_MUTE, 1))
        if (Apps.current.value == MayhemApp.PROWL && Prowl.view.value.on) actions.add(pipAction(R.drawable.ic_pip_skip, "Skip", ACTION_PIP_SKIP, 2))
        return PictureInPictureParams.Builder().setAspectRatio(Rational(16, 10)).setActions(actions).apply {
            if (Build.VERSION.SDK_INT >= 31) { setAutoEnterEnabled(pipWanted()); setSeamlessResizeEnabled(true) }
        }.build()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Android 12 and later enter on their own (autoEnter); before that the home button has to ask.
        if (Build.VERSION.SDK_INT < 31 && pipWanted()) runCatching { enterPictureInPictureMode(pipParams()) }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        Pip.active.value = isInPictureInPictureMode
    }

    /** Back in front: a radio plugged in while the app was away (or whose intent went to another app) is picked up now. */
    override fun onResume() {
        super.onResume()
        hideStatusBar()
        if (!radioRunning() && !askingPermission) autoConnect(quiet = true)
    }

    /** Full screen: the status bar stays hidden, and a swipe down from the top shows it for a moment. The system brings
     *  it back after a dialog or the shade, so it is hidden again whenever the window has focus. */
    private fun hideStatusBar() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.statusBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideStatusBar()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7) Geo.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
        debugExtras(intent)
    }

    /**
     * Debug builds only, for laying screens out on an emulator: `--ez demo true` feeds a synthetic signal and
     * `--es open AUDIO` opens an app, so every screen can be reached and photographed from adb.
     */
    private fun debugExtras(i: Intent?) {
        if ((!BuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "qa") || i == null) return
        if (i.getBooleanExtra("demo", false) && !radioRunning()) {
            com.rocketgod.mayhem.core.DemoIq.start()
            connected.value = true; status.value = "demo signal"
        }
        // `--ez aprsdemo true` adds one made-up APRS station (with a position and weather), to test its card and map dot
        if (i.getBooleanExtra("aprsdemo", false)) {
            val now = System.currentTimeMillis()
            Apps.aprs.injectForTest(com.rocketgod.mayhem.core.apps.AprsStation("N0CALL-9", lat = 34.2694, lon = -118.7815, symbol = '>', table = '/',
                course = 270, speed = 32.0, alt = 300.0, comment = "test station", packets = 3, firstMs = now - 600_000, lastMs = now,
                wx = com.rocketgod.mayhem.core.apps.AprsWx(windDir = 250, windMph = 6, tempF = 64, humidity = 55, pressureMb = 1013.2)))
        }
        // `--ez adsbdemo true` adds two made-up aircraft with no position yet, to test the Flights list
        if (i.getBooleanExtra("adsbdemo", false)) {
            val now = System.currentTimeMillis()
            repeat(43) { com.rocketgod.mayhem.core.AdsbStore.noteFrame() }
            com.rocketgod.mayhem.core.AdsbStore.merge(mapOf(
                "a1b2c3" to com.rocketgod.mayhem.model.Aircraft("a1b2c3").apply { flight = "DEMO101 "; altBaro = 34000; gs = 450 },
                "d4e5f6" to com.rocketgod.mayhem.model.Aircraft("d4e5f6").apply { flight = "DEMO202 "; altBaro = 12500; gs = 310; vertRate = 1200 },
            ), now)
        }
        // `--ez devicesdemo true` adds one made-up weather sensor (19.1 °C, 41%), to test its card and detail in both units
        if (i.getBooleanExtra("devicesdemo", false)) {
            val now = System.currentTimeMillis()
            val data = com.rocketgod.mayhem.core.r433.R433Data().apply { put("model", "Auriol-HG02832"); put("id", "186"); put("temperature", "19.1 °C"); put("humidity", "41%"); put("channel", "1"); put("battery", "OK") }
            com.rocketgod.mayhem.core.r433.Devices.proc.injectForTest(com.rocketgod.mayhem.core.r433.HeardDevice("weather:Auriol-HG02832:186", "Auriol-HG02832", 0, "weather sensors", 3,
                now - 60_000, now, data, false, family = "weather", hz = 433_920_000L, history = listOf(com.rocketgod.mayhem.core.r433.HeardReading(now, data, 0, 433_920_000L))))
        }
        // `--es units METRIC` or `IMPERIAL` picks the units, as the Settings choice does
        i.getStringExtra("units")?.let { u -> runCatching { com.rocketgod.mayhem.core.Units.setUnits(com.rocketgod.mayhem.core.UnitSystem.valueOf(u)) } }
        // `--es hamspots name.txt` replays FT8 and JS8 decodes into Ham Map's grid layers from the app's external files
        // folder, one per line as MODE|dial Hz|SNR|offset Hz|seconds ago|text (screens with stations, no radio)
        i.getStringExtra("hamspots")?.let { name ->
            val f = java.io.File(getExternalFilesDir(null), name)
            if (f.exists()) {
                val now = System.currentTimeMillis()
                for (l in f.readLines()) {
                    val p = l.split('|'); if (p.size < 6) continue
                    val dial = p[1].toLongOrNull() ?: continue; val snr = p[2].toIntOrNull() ?: 0; val hz = p[3].toIntOrNull() ?: 0
                    val at = now - (p[4].toLongOrNull() ?: 0L) * 1000
                    if (p[0] == "FT8") com.rocketgod.mayhem.core.ham.HamSpots.ft8(com.rocketgod.mayhem.core.ham.Ft8Decode("", snr, 0.0, hz, p[5]), dial, at)
                    else { val m = com.rocketgod.mayhem.core.js8.Js8Msg.parseMessage(p[5]); com.rocketgod.mayhem.core.ham.HamSpots.js8(m.kind, m.from, m.body, m.grid, snr, hz.toDouble(), at, p[5], dial) }
                }
            }
        }
        // `--es uatreplay name.cs8` feeds a 2 MS/s signed-IQ recording from the app's external files folder into UAT
        i.getStringExtra("uatreplay")?.let { name ->
            Thread({
                val f = java.io.File(getExternalFilesDir(null), name)
                if (!f.exists()) return@Thread
                Apps.uat.reset(2_000_000)
                val buf = ByteArray(262_144)
                f.inputStream().buffered().use { s ->
                    while (true) {
                        val n = s.read(buf); if (n <= 0) break
                        for (k in 0 until n) buf[k] = (buf[k] + 128).toByte()
                        Apps.uat.onIq(buf, n and 1.inv(), 2_000_000)
                    }
                }
            }, "uatreplay").start()
        }
        // `--es uatmsgs name.json` feeds decoded uplink messages (a JSON list of hex strings) into UAT, every weather product
        i.getStringExtra("uatmsgs")?.let { name ->
            Thread({
                val f = java.io.File(getExternalFilesDir(null), name)
                if (!f.exists()) return@Thread
                val a = org.json.JSONArray(f.readText())
                for (k in 0 until a.length()) { val h = a.getString(k); Apps.uat.onUp(ByteArray(h.length / 2) { j -> h.substring(j * 2, j * 2 + 2).toInt(16).toByte() }) }
            }, "uatmsgs").start()
        }
        // `--es cbreplay name.cs8 --el cbcenter 27095000` opens CB and plays a 2 MS/s signed-IQ recording from the app's
        // external files folder into it, looped, at the pace it was recorded (screens with real traffic, no radio)
        i.getStringExtra("cbreplay")?.let { name ->
            val center = i.getLongExtra("cbcenter", com.rocketgod.mayhem.core.cb.CB_CENTER)
            Apps.open(MayhemApp.CB)
            connected.value = true; status.value = "CB Radio replay"
            Thread({
                val f = java.io.File(getExternalFilesDir(null), name)
                if (!f.exists()) return@Thread
                val buf = ByteArray(1 shl 17); val t0 = System.nanoTime(); var sent = 0L
                Thread.sleep(500)
                com.rocketgod.mayhem.core.Cb.engine.centerHz = center
                while (Apps.playing() == MayhemApp.CB) {
                    f.inputStream().buffered(1 shl 20).use { s ->
                        while (Apps.playing() == MayhemApp.CB) {
                            val n = s.readNBytes(buf, 0, buf.size); if (n < buf.size) break
                            for (k in 0 until n) buf[k] = (buf[k] + 128).toByte()
                            com.rocketgod.mayhem.core.Cb.engine.onIq(buf, n, 2_000_000)
                            sent += n / 2
                            val ahead = sent * 1000 / 2_000_000 - (System.nanoTime() - t0) / 1_000_000
                            if (ahead > 0) Thread.sleep(ahead)
                        }
                    }
                }
            }, "cbreplay").start()
        }
        // `--es hpreplay name.cs8 --el hpcenter 446775000 --ei hprate 125000` feeds a signed-IQ recording from the app's
        // external files folder into Repeaters at its own pace, looped, centered where it was recorded (the Repeaters
        // air fixtures: home's P25 and DMR, and the synthetic digital scenes)
        // `--ei hpiq 10` records the next 10 s of Repeaters' IQ (unsigned 8-bit, as the radio sends it) to hpiq-<center>-<rate>.cu8
        // in the app's external files folder; `--ez hpdump true` writes the log as Repeaters exports it to hp-log.csv there
        i.getIntExtra("hpiq", 0).takeIf { it > 0 }?.let { secs ->
            val e = com.rocketgod.mayhem.core.HamPlus.engine; var out: java.io.OutputStream? = null; var left = 0L
            e.iqTap = { b, n, rate, center ->
                if (out == null) { left = 2L * rate * secs; out = java.io.File(getExternalFilesDir(null), "hpiq-$center-$rate.cu8").outputStream().buffered(1 shl 20); Diag.log("hpiq: recording $secs s at $center") }
                val o = out!!; val k = minOf(n.toLong(), left).toInt(); o.write(b, 0, k); left -= k
                if (left <= 0) { o.close(); e.iqTap = null; Diag.log("hpiq: done") }
            }
        }
        if (i.getBooleanExtra("hpdump", false)) {
            runCatching { java.io.File(getExternalFilesDir(null), "hp-log.csv").writeText(com.rocketgod.mayhem.core.HamPlus.exportCsv()); Diag.log("hpdump: written") }
        }
        i.getStringExtra("hpreplay")?.let { name ->
            val center = i.getLongExtra("hpcenter", 446_775_000L); val rate = i.getIntExtra("hprate", 125_000)
            Apps.open(MayhemApp.HAMPLUS)
            connected.value = true; status.value = "Repeaters replay"
            Thread({
                val f = java.io.File(getExternalFilesDir(null), name)
                if (!f.exists()) { Diag.log("hpreplay: $name not found in ${getExternalFilesDir(null)}"); return@Thread }
                val buf = ByteArray(2 * 16_384); val t0 = System.nanoTime(); var sent = 0L
                Thread.sleep(500)
                val e = com.rocketgod.mayhem.core.HamPlus.engine
                while (Apps.playing() == MayhemApp.HAMPLUS) {
                    f.inputStream().buffered(1 shl 20).use { s ->
                        while (Apps.playing() == MayhemApp.HAMPLUS) {
                            val n = s.readNBytes(buf, 0, buf.size); if (n < buf.size) break
                            for (k in 0 until n) buf[k] = (buf[k] + 128).toByte()
                            e.centerHz = center
                            e.onIq(buf, n, rate)
                            sent += n / 2
                            val ahead = sent * 1000 / rate - (System.nanoTime() - t0) / 1_000_000
                            if (ahead > 0) Thread.sleep(ahead)
                        }
                    }
                }
            }, "hpreplay").start()
        }
        // `--ez crashtest true` crashes on purpose a moment later, to test the crash report on the next launch
        if (i.getBooleanExtra("crashtest", false)) {
            android.os.Handler(mainLooper).postDelayed({ throw IllegalStateException("crash report test (QA build, --ez crashtest)") }, 1500)
        }
        // `--es radio RTLSDR` dresses the demo as a dongle, to see the receive-only screens
        i.getStringExtra("radio")?.let { k -> runCatching { SdrEngine.onRadio(com.rocketgod.mayhem.core.Radio.Kind.valueOf(k)) } }
        i.getStringExtra("open")?.let { name ->
            runCatching { if (name == "HOME") Apps.home() else Apps.open(MayhemApp.byName(name) ?: MayhemApp.valueOf(name)) }
                .onFailure { android.util.Log.e("Mayhem", "debug open $name failed", it); Diag.log("debug open $name failed: $it") }
        }
    }

    /** USB_DEVICE_ATTACHED from the manifest filter: the device comes with permission for this attachment. */
    private fun handleIntent(i: Intent?): Boolean {
        if (i?.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return false
        val d = IntentCompat.getParcelableExtra(i, UsbManager.EXTRA_DEVICE, UsbDevice::class.java) ?: return false
        Diag.log("USB attached: ${HackRfUsb.describe(d)}")
        if (!HackRfUsb.isRadio(d)) return false
        if (RtlTcp.wanted) { Diag.log("USB radio attached, staying on the network radio (Disconnect it in RADIO to use USB)"); return true }
        engage(d)
        return true
    }

    /** App launched with a radio already on the port: enumerate and ask for permission if we lack it. */
    private fun autoConnect(quiet: Boolean = false) {
        if (radioRunning()) return
        // the user picked the network radio: USB waits until it is turned off
        if (RtlTcp.wanted || RtlTcp.active) return
        val d = HackRfUsb.find(this)
        if (!quiet || d != null) Diag.log(HackRfUsb.scanLog(this))
        // a PortaPack in its Mayhem serial mode is asked to become a HackRF; it comes back as an ordinary attach
        if (d == null) { HackRfUsb.switchPortaPack(this); return }
        if (HackRfUsb.hasPermission(this, d)) engage(d)
        else if (!askingPermission) {
            askingPermission = true
            status.value = "asking for USB permission…"
            HackRfUsb.requestPermission(this, d)
        }
    }

    private fun engage(d: UsbDevice) {
        // the launch intent and onResume's check can both land here before the first radio thread has set its running
        // flag: one radio thread at a time, or the loser returns at once and marks the app disconnected while the
        // winner streams (the "no radio" banner over a working radio)
        if (radioRunning() || rxThread?.isAlive == true) { Diag.log("engage: a radio is already running, ignoring"); return }
        if (RtlTcp.wanted || RtlTcp.active) { Diag.log("engage: the network radio is in use, leaving USB alone"); return }
        val rtl = RtlSdr.isRtlSdr(d)
        SdrEngine.onRadio(if (rtl) com.rocketgod.mayhem.core.Radio.Kind.RTLSDR else com.rocketgod.mayhem.core.Radio.Kind.HACKRF)
        status.value = "${if (rtl) "RTL-SDR" else "HackRF"} · opening ${HackRfUsb.describe(d)}"
        connected.value = true
        val appCtx = applicationContext
        rxThread = Thread({
            // the USB reads come first: a late one is a lost buffer, whatever the decoders are doing
            runCatching { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO) }
            if (rtl) RtlSdr.run(appCtx, d) { s -> status.value = s } else HackRfOne.run(appCtx, d) { s -> status.value = s }
            SdrEngine.onRadio(com.rocketgod.mayhem.core.Radio.Kind.NONE)
            connected.value = false
        }, "hackrf-rx").apply { isDaemon = true; start() }
    }

    private companion object {
        const val ACTION_PIP_MUTE = "com.rocketgod.mayhem.PIP_MUTE"
        const val ACTION_PIP_SKIP = "com.rocketgod.mayhem.PIP_SKIP"
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(receiver) }
        if (isFinishing) { HackRfOne.abort(); RtlSdr.abort(); RtlTcp.shutdown() }
    }

    private fun radioUsbRunning() = HackRfOne.running || RtlSdr.running
    private fun radioRunning() = radioUsbRunning() || RtlTcp.wanted || RtlTcp.active
    /** The permission dialog is up; asking again from onResume would stack a second one. */
    private var askingPermission = false
}
