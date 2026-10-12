package com.rocketgod.mayhem.core

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every singleton the apps touch, initialised. A table built out of range in a static initialiser takes the whole
 * class down with it, and Apps.open reaches most of these on every tap, so one bad index there breaks every app.
 */
class InitTest {
    private val singletons = listOf(
        "core.Apps", "core.SdrEngine", "core.Prowl", "core.Scanner", "core.Bookmarks", "core.AdsbDecoder", "core.AdsbStore",
        "core.Dsp", "core.Tx", "core.TxApps", "core.TxEncoders", "core.Station", "core.Saves", "core.Mic", "core.Geo",
        "core.sat.Sats", "core.sat.Tles", "core.ham.Ham", "core.ham.HamDigital", "core.ham.Logbook", "core.ham.Picture",
        "core.ham.Ft8Encode", "core.r433.Devices", "core.r433.R433Registry", "core.apps.ism.IsmProtos",
    )

    @Test fun everySingletonInitialises() {
        val failed = singletons.mapNotNull { n ->
            runCatching { Class.forName("com.rocketgod.mayhem.$n", true, javaClass.classLoader) }.exceptionOrNull()?.let { e ->
                var c: Throwable = e; while (c.cause != null) c = c.cause!!
                "$n: $c"
            }
        }
        assertTrue(failed.joinToString("\n"), failed.isEmpty())
    }

    @Test fun lrptDecoderBuilds() { com.rocketgod.mayhem.core.ham.LrptDecoder() }
}
