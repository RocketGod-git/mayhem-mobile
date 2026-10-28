package com.rocketgod.mayhem.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The ADS-B transmit encoder has to produce a checksum receivers accept. The reference is a real squitter,
 * 8D4840D6202CC371C32CE0576098 (the worked example in "The 1090 MHz Riddle"), rebuilt from its address and ME
 * field. Twin of web/test/adsb-tx.mjs.
 */
class AdsbTxTest {
    @Test fun knownSquitterRebuiltExactly() {
        val f = TxApps.adsbFrame(0x4840D6, 0x202CC371C32CE0L)
        assertEquals("8D4840D6202CC371C32CE0576098", f.joinToString("") { "%02X".format(it.toInt() and 0xFF) })
    }
}
