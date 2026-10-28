package com.rocketgod.mayhem.core

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.rocketgod.mayhem.Diag
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The phone's own position: the CPR reference that lets ADS-B place an aircraft from a single position frame
 * (dump1090 decodeCPRrelative), and the spot the map centers on before any aircraft shows up. Coarse is enough.
 */
object Geo {
    private val _fix = MutableStateFlow<Pair<Double, Double>?>(null)
    val fix: StateFlow<Pair<Double, Double>?> = _fix.asStateFlow()
    private var listening = false

    private val listener = object : LocationListener {
        override fun onLocationChanged(l: Location) { set(l) }
        @Deprecated("Deprecated in Java") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private fun set(l: Location) {
        val first = _fix.value == null
        _fix.value = l.latitude to l.longitude
        if (first) Diag.log("GPS reference %.3f,%.3f for single-frame CPR".format(l.latitude, l.longitude))
    }

    fun granted(ctx: Context): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Ask once (the result comes back through [start] again from the activity). */
    fun request(activity: Activity) {
        if (granted(activity)) { start(activity); return }
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 7)
    }

    /** Use the last known fix right away and keep listening at a low rate. Safe to call repeatedly. */
    fun start(ctx: Context) {
        if (!granted(ctx)) return
        AdsbDecoder.refProvider = { _fix.value }
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
        try {
            var best: Location? = null
            for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
                val l = runCatching { lm.getLastKnownLocation(p) }.getOrNull() ?: continue
                if (best == null || l.time > best.time) best = l
            }
            best?.let { set(it) }
            if (!listening) {
                listening = true
                for (p in listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)) {
                    if (runCatching { lm.isProviderEnabled(p) }.getOrDefault(false))
                        runCatching { lm.requestLocationUpdates(p, 30_000L, 200f, listener, Looper.getMainLooper()) }
                }
            }
        } catch (e: SecurityException) {
            Diag.log("location: ${e.message}")
        }
        if (_fix.value == null) Diag.log("no GPS fix yet — ADS-B positions need even+odd frame pairs until one arrives")
    }
}
