package com.rocketgod.mayhem.usb

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager

/**
 * USB enumeration / permission helpers. Everything the activity needs to find a HackRF or an RTL-SDR on the OTG
 * port and get permission to open it; the radio-level work is in [HackRfOne] and [RtlSdr].
 */
object HackRfUsb {
    /** Great Scott Gadgets / OpenMoko vendor id shared by every HackRF board. */
    const val VID = 0x1d50
    /** HackRF One / One r9 / HackRF Pro ("Praline") = 0x6089, Jawbreaker = 0x604b, rad1o = 0xcc15. */
    val PIDS = setOf(0x6089, 0x604b, 0xcc15)
    /** A PortaPack running Mayhem in its USB-CDC serial mode — NOT a HackRF-direct target (see usb_device_filter). */
    const val PID_MAYHEM_SERIAL = 0x6018

    const val ACTION_PERMISSION = "com.rocketgod.mayhem.USB_PERMISSION"

    fun isHackRf(d: UsbDevice): Boolean = d.vendorId == VID && d.productId in PIDS

    /** Either radio the app drives: a HackRF, or an RTL-SDR dongle (receive only). */
    fun isRadio(d: UsbDevice): Boolean = isHackRf(d) || RtlSdr.isRtlSdr(d)

    fun manager(ctx: Context): UsbManager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager

    /** The attached radio, a HackRF first if both are plugged in, or null. */
    fun find(ctx: Context): UsbDevice? = manager(ctx).deviceList.values.let { all -> all.firstOrNull { isHackRf(it) } ?: all.firstOrNull { RtlSdr.isRtlSdr(it) } }

    fun hasPermission(ctx: Context, d: UsbDevice): Boolean = manager(ctx).hasPermission(d)

    /** Fire the system "Allow Mayhem to access …?" dialog; the answer arrives as an [ACTION_PERMISSION] broadcast. */
    fun requestPermission(ctx: Context, d: UsbDevice) {
        val intent = Intent(ACTION_PERMISSION).setPackage(ctx.packageName)
        val pi = PendingIntent.getBroadcast(ctx, 0, intent, PendingIntent.FLAG_MUTABLE)
        runCatching { manager(ctx).requestPermission(d, pi) }
    }

    fun describe(d: UsbDevice): String =
        "%04x:%04x %s".format(d.vendorId, d.productId, d.productName ?: d.deviceName ?: "").trim()

    /** One line per USB device the phone enumerates — recognised or not — so a board that came up under an
     *  unexpected PID (e.g. a PortaPack still in Mayhem serial mode) is visible in the log. */
    fun scanLog(ctx: Context): String {
        val devs = manager(ctx).deviceList.values
        if (devs.isEmpty()) return "USB scan: no devices enumerated (nothing on the OTG port, or the cable is charge-only)"
        return "USB scan: " + devs.joinToString(" · ") { d ->
            val tag = when {
                isHackRf(d) -> "HackRF ✔"
                RtlSdr.isRtlSdr(d) -> "RTL-SDR ✔ (receive only)"
                d.vendorId == VID && d.productId == PID_MAYHEM_SERIAL -> "PortaPack/Mayhem SERIAL mode — switch it to HackRF mode"
                else -> "ignored"
            }
            "${describe(d)} [$tag]"
        }
    }
}
