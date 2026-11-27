package com.rocketgod.mayhem.usb

import android.content.Context
import android.hardware.usb.UsbDevice
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Which USB radio the app uses: every attached radio it can drive, the one running, the last one used (opened on its
 * own next time, by vendor:product:serial), and DISCONNECT, which keeps the radio off (no connecting on its own on
 * plug-in or at the next start of the activity) until CONNECT or USE. The activity does the opening and closing
 * through the hooks it sets here; the RADIO panel only asks.
 */
object RadioChoice {
    /** Set by DISCONNECT, cleared by CONNECT or USE. Lasts while the app runs, as on the web. */
    @Volatile var userOff = false
    /** The device running now (its deviceName), null when none is. */
    @Volatile var running: String? = null
        set(v) { field = v; changed() }
    private val _version = MutableStateFlow(0)
    /** Counts plug-ins, unplugs, permission answers and radio changes, so the panel redraws. */
    val version: StateFlow<Int> = _version.asStateFlow()
    fun changed() { _version.value = _version.value + 1 }

    /** Hooks the activity sets: switch to this device, stop the radio, connect as at start-up, ask for a device's permission. */
    @Volatile var onUse: ((UsbDevice) -> Unit)? = null
    @Volatile var onDisconnect: (() -> Unit)? = null
    @Volatile var onConnect: (() -> Unit)? = null
    @Volatile var onAdd: ((UsbDevice?) -> Unit)? = null

    private const val PREF = "radio_pref"

    /** One radio, the same across sessions: its USB ids and serial number (readable once the app may open it). */
    fun keyOf(d: UsbDevice): String = "%x:%x:%s".format(d.vendorId, d.productId, runCatching { d.serialNumber }.getOrNull().orEmpty())

    fun prefKey(ctx: Context): String = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getString(PREF, "") ?: ""
    fun remember(ctx: Context, d: UsbDevice) { ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).edit().putString(PREF, keyOf(d)).apply() }

    fun isListed(d: UsbDevice): Boolean = HackRfUsb.isRadio(d) || HackRfUsb.isMayhemSerial(d)

    /** The attached radios, the last one used first. */
    fun attached(ctx: Context): List<UsbDevice> {
        val pref = prefKey(ctx)
        val all = runCatching { HackRfUsb.manager(ctx).deviceList.values.filter { isListed(it) } }.getOrDefault(emptyList())
        return all.sortedWith(compareByDescending<UsbDevice> { keyOf(it) == pref }.thenByDescending { HackRfUsb.isHackRf(it) })
    }

    /** The radio to open on its own: the last one used if it is plugged in, otherwise the first HackRF, then RTL-SDR. */
    fun preferred(ctx: Context): UsbDevice? {
        val all = attached(ctx).filter { HackRfUsb.isRadio(it) }
        val pref = prefKey(ctx)
        return all.firstOrNull { pref.isNotEmpty() && keyOf(it) == pref } ?: all.firstOrNull { HackRfUsb.isHackRf(it) } ?: all.firstOrNull { RtlSdr.isRtlSdr(it) }
    }

    fun name(d: UsbDevice): String = when {
        HackRfUsb.isMayhemSerial(d) -> "PortaPack (Mayhem mode)"
        RtlSdr.isRtlSdr(d) -> d.productName?.takeIf { !it.startsWith("RTL", ignoreCase = true) }?.let { "RTL-SDR · $it" } ?: "RTL-SDR"
        else -> d.productName?.takeIf { it.isNotBlank() } ?: "HackRF"
    }
}
