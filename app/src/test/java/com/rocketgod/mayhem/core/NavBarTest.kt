package com.rocketgod.mayhem.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** A saved app bar meeting an app added in an update: the new one takes its default place, not the end. */
class NavBarTest {
    @Test fun newAppGoesAfterItsDefaultPredecessor() {
        val def = listOf(MayhemApp.AIS, MayhemApp.ERT, MayhemApp.LORA, MayhemApp.BTLE, MayhemApp.SETTINGS)
        val saved = listOf(MayhemApp.BTLE, MayhemApp.ERT, MayhemApp.AIS)
        // LoRa follows Meters; Settings follows BLE RX, its nearest predecessor in the default order
        assertEquals(listOf(MayhemApp.BTLE, MayhemApp.SETTINGS, MayhemApp.ERT, MayhemApp.LORA, MayhemApp.AIS), NavBar.withNew(saved, def))
    }

    @Test fun newAppWithNoPredecessorGoesFirst() {
        val def = listOf(MayhemApp.LORA, MayhemApp.ERT)
        assertEquals(listOf(MayhemApp.LORA, MayhemApp.ERT), NavBar.withNew(listOf(MayhemApp.ERT), def))
    }
}
