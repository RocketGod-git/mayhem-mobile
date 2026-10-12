package com.rocketgod.mayhem

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.ui.MayhemScreen
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.HackRfUsb
import kotlinx.coroutines.flow.MutableStateFlow

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
        }
        ContextCompat.registerReceiver(this, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED)

        setContent {
            val st by status.collectAsState()
            val c by connected.collectAsState()
            MayhemScreen(status = st, connected = c)
        }

        if (!handleIntent(intent)) autoConnect()
        Geo.request(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7) Geo.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
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

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(receiver) }
        if (isFinishing) HackRfOne.abort()
    }
}
