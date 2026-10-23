package com.rocketgod.mayhem.usb

import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbRequest
import java.util.concurrent.TimeoutException

/**
 * Tear down a pool of queued UsbRequests without crashing the app.
 *
 * cancel() does not finish a request: the kernel still holds its URB until a later requestWait() reaps it. Closing
 * the request straight after cancel() frees the native struct while that URB is outstanding, and the next
 * requestWait() on the connection - the fresh pool after a rate change, say - hands the stale URB back and
 * dereferences freed memory: SIGSEGV in libusbhost usb_request_wait. That killed the app on an RTL-SDR the moment
 * ADS-B (a different sample rate) opened. So: cancel every request, reap each one, and only then close it.
 *
 * A request that does not come back in time is never closed - not even by the garbage collector, whose finalizer
 * would close it - so it is parked for the life of the process. A leaked request is a few bytes; a closed
 * in-flight one is a crash.
 */
internal object UsbRequests {
    private val parked = ArrayList<UsbRequest>()

    fun drainAndClose(c: UsbDeviceConnection, reqs: List<UsbRequest>, timeoutMs: Long = 500L) {
        if (reqs.isEmpty()) return
        reqs.forEach { runCatching { it.cancel() } }
        val left = reqs.toMutableSet()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (left.isNotEmpty() && System.currentTimeMillis() < deadline) {
            val r = try { c.requestWait(50L) } catch (e: TimeoutException) { null } catch (e: Exception) { break }
            if (r != null) left.remove(r)
        }
        reqs.forEach { if (it !in left) runCatching { it.close() } }
        if (left.isNotEmpty()) synchronized(parked) { parked.addAll(left) }
    }
}
