package com.rocketgod.mayhem

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
import androidx.lifecycle.lifecycleScope
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Prowl
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.ui.Pip
import com.rocketgod.mayhem.ui.MayhemScreen
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.HackRfUsb
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Phase 0 — link up. Finds a HackRF on the USB-OTG port (hot-plug via the manifest USB_DEVICE_ATTACHED filter,
 * or already-attached at launch via enumeration + a permission request), then runs [HackRfOne] on its own
 * thread. Everything after "IQ is flowing" is [com.rocketgod.mayhem.core.SdrEngine] + the Compose screen.
 */
class MainActivity : ComponentActivity() {
    private val status = MutableStateFlow("no HackRF — plug one in via USB-OTG")
    private val connected = MutableStateFlow(false)
    private var rxThread: Thread? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val d = IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
            when (intent.action) {
                HackRfUsb.ACTION_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    Diag.log("USB permission ${if (granted) "granted" else "DENIED"} for ${d?.let { HackRfUsb.describe(it) } ?: "?"}")
                    if (d != null && granted && HackRfUsb.isHackRf(d)) engage(d)
                    else status.value = "USB permission denied — replug to retry"
                }
                ACTION_PIP_MUTE -> SdrEngine.toggleMute()
                ACTION_PIP_SKIP -> Prowl.skip()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> if (d != null && HackRfUsb.isHackRf(d)) {
                    Diag.log("USB detached: ${HackRfUsb.describe(d)}")
                    HackRfOne.abort()
                    connected.value = false
                    status.value = "HackRF detached"
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Apps.init(this)
        com.rocketgod.mayhem.ui.Skins.load(this)
        com.rocketgod.mayhem.core.Tx.load(this)
        com.rocketgod.mayhem.core.Station.load(this)
        com.rocketgod.mayhem.core.ham.Logbook.load(this)
        com.rocketgod.mayhem.core.sat.Tles.init(filesDir)
        if (savedInstanceState == null) {
            Diag.clear()
            Diag.log("Mayhem Android ${BuildConfig.VERSION_NAME} · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        }
        // ATTACHED arrives through the manifest intent-filter (onNewIntent / the launch intent) with permission
        // already granted. The runtime receiver only needs DETACHED and our own permission-result broadcast.
        // NOT_EXPORTED: an exported receiver would let any app forge a "permission granted" broadcast.
        val f = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(HackRfUsb.ACTION_PERMISSION)
            addAction(ACTION_PIP_MUTE)
            addAction(ACTION_PIP_SKIP)
        }
        ContextCompat.registerReceiver(this, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED)

        setContent {
            val st by status.collectAsState()
            val c by connected.collectAsState()
            MayhemScreen(status = st, connected = c)
        }

        // Keep the picture-in-picture offer in step with what is open, so leaving the app keeps a receiver on screen.
        lifecycleScope.launch {
            combine(Apps.current, SdrEngine.muted, connected, Prowl.view) { _, _, _, _ -> Unit }.collect { runCatching { setPictureInPictureParams(pipParams()) } }
        }

        if (!handleIntent(intent)) autoConnect()
        debugExtras(intent)
        Geo.request(this)
        AppUpdates.check(this)
    }

    /** A receiver is open and the radio is running: worth a floating window. Settings and Transmit are not. */
    private fun pipWanted(): Boolean {
        val a = Apps.current.value ?: return false
        return a != MayhemApp.SETTINGS && a != MayhemApp.TRANSMIT && connected.value
    }

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
        if (!BuildConfig.DEBUG || i == null) return
        if (i.getBooleanExtra("demo", false) && !HackRfOne.running) {
            com.rocketgod.mayhem.core.DemoIq.start()
            connected.value = true; status.value = "demo signal"
        }
        i.getStringExtra("open")?.let { name ->
            if (name == "HOME") Apps.home() else runCatching { Apps.open(MayhemApp.valueOf(name)) }
        }
    }

    /** USB_DEVICE_ATTACHED from the manifest filter: the device comes with permission for this attachment. */
    private fun handleIntent(i: Intent?): Boolean {
        if (i?.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return false
        val d = IntentCompat.getParcelableExtra(i, UsbManager.EXTRA_DEVICE, UsbDevice::class.java) ?: return false
        Diag.log("USB attached: ${HackRfUsb.describe(d)}")
        if (!HackRfUsb.isHackRf(d)) return false
        engage(d)
        return true
    }

    /** App launched with a HackRF already on the port: enumerate and ask for permission if we lack it. */
    private fun autoConnect() {
        if (HackRfOne.running) return
        Diag.log(HackRfUsb.scanLog(this))
        val d = HackRfUsb.find(this) ?: return
        if (HackRfUsb.hasPermission(this, d)) engage(d)
        else {
            status.value = "asking for USB permission…"
            HackRfUsb.requestPermission(this, d)
        }
    }

    private fun engage(d: UsbDevice) {
        if (HackRfOne.running) { Diag.log("engage: HackRF already running, ignoring"); return }
        status.value = "HackRF · opening ${HackRfUsb.describe(d)}"
        connected.value = true
        val appCtx = applicationContext
        rxThread = Thread({
            HackRfOne.run(appCtx, d) { s -> status.value = s }
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
        if (isFinishing) HackRfOne.abort()
    }
}
