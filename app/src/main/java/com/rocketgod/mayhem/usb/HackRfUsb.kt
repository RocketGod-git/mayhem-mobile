package com.rocketgod.mayhem.usb

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import com.rocketgod.mayhem.Diag

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

    fun isMayhemSerial(d: UsbDevice): Boolean = d.vendorId == VID && d.productId == PID_MAYHEM_SERIAL

    /** Either radio the app drives: a HackRF, or an RTL-SDR dongle (receive only). */
    fun isRadio(d: UsbDevice): Boolean = isHackRf(d) || RtlSdr.isRtlSdr(d)

    fun manager(ctx: Context): UsbManager = ctx.getSystemService(Context.USB_SERVICE) as UsbManager

    /** The attached radio, a HackRF first if both are plugged in, or null. */
    fun find(ctx: Context): UsbDevice? = manager(ctx).deviceList.values.let { all -> all.firstOrNull { isHackRf(it) } ?: all.firstOrNull { RtlSdr.isRtlSdr(it) } }

    fun hasPermission(ctx: Context, d: UsbDevice): Boolean = manager(ctx).hasPermission(d)

    /** A PortaPack on the port in Mayhem serial mode, or null. */
    fun findMayhemSerial(ctx: Context): UsbDevice? = manager(ctx).deviceList.values.firstOrNull { isMayhemSerial(it) }

    /**
     * If a PortaPack is on the port in Mayhem serial mode, switch it to HackRF mode: straight away when this app may
     * open it (on a worker thread), otherwise after the permission dialog, whose [ACTION_PERMISSION] answer should
     * call [portapackToHackRf]. True when there was one.
     */
    fun switchPortaPack(ctx: Context): Boolean {
        val d = findMayhemSerial(ctx) ?: return false
        Diag.log("That is a PortaPack in Mayhem serial mode: ${describe(d)}")
        if (hasPermission(ctx, d)) { val app = ctx.applicationContext; Thread({ portapackToHackRf(app, d) }, "portapack-switch").start() }
        else requestPermission(ctx, d)
        return true
    }

    /**
     * Put a PortaPack running Mayhem into HackRF mode by typing `hackrf` into its USB serial shell, as the web app
     * does over Web Serial. The port is set up the way Web Serial opens it (115200 8N1, DTR and RTS up). The board
     * reboots and comes back as 0x6089, which arrives as an ordinary attach. The shell can wedge, so this sends the
     * command once and logs what happened; it does not retry. Blocking; needs permission for [d].
     */
    fun portapackToHackRf(ctx: Context, d: UsbDevice): Boolean {
        var data: UsbInterface? = null
        var comm: UsbInterface? = null
        for (i in 0 until d.interfaceCount) {
            val f = d.getInterface(i)
            if (f.interfaceClass == UsbConstants.USB_CLASS_CDC_DATA && data == null) data = f
            if (f.interfaceClass == UsbConstants.USB_CLASS_COMM && comm == null) comm = f
        }
        val dataIf = data ?: run { Diag.log("PortaPack: no serial data interface on ${describe(d)} — tap HackRF on its screen"); return false }
        val out = (0 until dataIf.endpointCount).map { dataIf.getEndpoint(it) }
            .firstOrNull { it.type == UsbConstants.USB_ENDPOINT_XFER_BULK && it.direction == UsbConstants.USB_DIR_OUT }
            ?: run { Diag.log("PortaPack: no serial OUT endpoint — tap HackRF on its screen"); return false }
        val c = manager(ctx).openDevice(d) ?: run { Diag.log("PortaPack: could not open ${describe(d)} — tap HackRF on its screen"); return false }
        try {
            if (!c.claimInterface(dataIf, true)) { Diag.log("PortaPack: could not claim its serial interface — tap HackRF on its screen"); return false }
            comm?.let { ci ->
                c.claimInterface(ci, true)
                // CDC SET_LINE_CODING: 115200 baud little-endian, 1 stop bit, no parity, 8 data bits
                val coding = byteArrayOf(0x00, 0xC2.toByte(), 0x01, 0x00, 0, 0, 8)
                val rcLine = c.controlTransfer(0x21, 0x20, 0, ci.id, coding, coding.size, 500)
                // CDC SET_CONTROL_LINE_STATE: DTR | RTS
                val rcState = c.controlTransfer(0x21, 0x22, 0x03, ci.id, null, 0, 500)
                Diag.log("PortaPack: serial line coding rc=$rcLine, line state rc=$rcState")
            }
            val cmd = "hackrf\r\n".toByteArray(Charsets.US_ASCII)
            val n = c.bulkTransfer(out, cmd, cmd.size, 1000)
            return if (n == cmd.size) {
                Diag.log("PortaPack: sent \"hackrf\" — it is rebooting into HackRF mode and should come back as a HackRF in a few seconds")
                true
            } else {
                Diag.log("PortaPack: the \"hackrf\" command did not go out (rc=$n) — its serial shell may be wedged; tap HackRF on its screen")
                false
            }
        } catch (t: Throwable) {
            Diag.log("PortaPack switch: ${t.message}")
            return false
        } finally {
            runCatching { c.close() }
        }
    }

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
        if (devs.isEmpty()) return "USB scan: no devices enumerated — nothing on the OTG port, a charge-only cable, or the phone's OTG switch is off (OnePlus, OPPO and realme turn it off after ten idle minutes: Settings › Additional settings › OTG)"
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
