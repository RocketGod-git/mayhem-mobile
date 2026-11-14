package com.rocketgod.mayhem.core.sonde

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SondeHubTest {
    private fun site(vararg times: String) = HubSite("x", "Test", 0.0, 0.0, emptyList(), times.toList())
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun typeNames() {
        assertEquals("RS41", SondeHub.hubTypeName("41"))
        assertEquals("LMS6-1680", SondeHub.hubTypeName("82"))
        assertEquals("M20", SondeHub.hubTypeName("87"))
        assertEquals("DFM-09", SondeHub.hubTypeName("09"))
        assertEquals("iMet", SondeHub.hubTypeName("iMet"))
    }

    @Test fun nextLaunchBeforeNominal() {
        val s = site("0:00:00", "0:12:00")
        // 05:00 UTC: next is the 12:00 flight, launched at 11:00
        assertEquals(ms("2026-11-14T11:00:00Z"), SondeHub.nextLaunchMs(s, ms("2026-11-14T05:00:00Z")))
        // 20:00 UTC: next is tomorrow's 00:00 flight, launched at 23:00 today
        assertEquals(ms("2026-11-14T23:00:00Z"), SondeHub.nextLaunchMs(s, ms("2026-11-14T20:00:00Z")))
    }

    @Test fun upNowFor90Minutes() {
        val s = site("0:00:00", "0:12:00")
        // 23:30 the day before is the 00:00 flight, already up 30 min
        assertEquals(ms("2026-11-13T23:00:00Z"), SondeHub.nextLaunchMs(s, ms("2026-11-13T23:30:00Z")))
        // 00:20 is still within 90 min of the 23:00 launch
        assertEquals(ms("2026-11-13T23:00:00Z"), SondeHub.nextLaunchMs(s, ms("2026-11-14T00:20:00Z")))
        // 00:31 is past it: the next is 11:00
        assertEquals(ms("2026-11-14T11:00:00Z"), SondeHub.nextLaunchMs(s, ms("2026-11-14T00:31:00Z")))
    }

    @Test fun minutesInTimes() {
        assertEquals(ms("2026-11-14T10:30:00Z"), SondeHub.nextLaunchMs(site("0:11:30"), ms("2026-11-14T06:00:00Z")))
    }

    @Test fun noScheduleOrIrregular() {
        assertNull(SondeHub.nextLaunchMs(site(), 0L))
        val irr = site("Irregular")
        assertNull(SondeHub.nextLaunchMs(irr, 0L))
        assertTrue(SondeHub.irregular(irr))
    }

    @Test fun parsesSitesAndSondes() {
        val sites = SondeHub.parseSites("""{"72393":{"station":"72393","station_name":"Vandenberg AFB (United States)","position":[-120.57,34.75],
            "rs_types":["41",["82","1680"]],"times":["0:00:00","0:12:00"]},"bad":{"station_name":"No position"}}""")
        assertEquals(1, sites.size)
        assertEquals("Vandenberg AFB", sites[0].name)
        assertEquals(34.75, sites[0].lat, 1e-9); assertEquals(-120.57, sites[0].lon, 1e-9)
        assertEquals(listOf("RS41", "LMS6-1680 1680 MHz"), sites[0].types)
        val air = SondeHub.parseSondes("""{"S1234567":{"type":"RS41","subtype":"RS41-SGP","frequency":403.5,"lat":34.1,"lon":-118.2,"alt":12000.5,
            "vel_v":5.2,"vel_h":10,"heading":90,"datetime":"2026-11-14T15:00:00.123Z"},"X":{"type":"DFM"}}""")
        assertEquals(1, air.size)
        assertEquals("RS41-SGP", air[0].type)
        assertEquals(403.5, air[0].mhz!!, 1e-9)
        assertEquals(ms("2026-11-14T15:00:00.123Z"), air[0].ms)
    }
}
