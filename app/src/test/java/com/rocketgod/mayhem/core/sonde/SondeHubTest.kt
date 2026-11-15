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

    @Test fun parsesEveryFieldOfAFrame() {
        val v = org.json.JSONObject("""{"software_name":"radiosonde_auto_rx","software_version":"1.8.2","uploader_callsign":"W6SUN-Verdugo_Peak",
            "uploader_position":"34.2151,-118.28","uploader_antenna":"sleeve dipole","datetime":"2026-11-15T00:56:33.005000Z","manufacturer":"Vaisala",
            "type":"RS41","serial":"X2223653","subtype":"RS41-SG","frame":7118,"lat":34.61271,"lon":-119.72784,"alt":2110.71654,"temp":4.6,"humidity":66.0,
            "vel_v":-10.77289,"vel_h":1.36608,"heading":33.33778,"sats":9,"batt":2.7,"frequency":400.250875,"burst_timer":28961,"ref_position":"GPS",
            "rs41_mainboard":"RSM414","rs41_mainboard_fw":"20506","snr":7.5,"tx_frequency":400.25,"uploader_alt":952.0}""")
        val h = SondeHub.parseSonde("X2223653", v)!!
        assertEquals(4.6, h.tempC!!, 1e-9); assertEquals(66.0, h.rh!!, 1e-9); assertEquals(2.7, h.battV!!, 1e-9)
        val f = h.fields.toMap()
        assertEquals("Vaisala", f["MAKER"])
        assertEquals("8 h 02 min", f["BURST TIMER"])
        assertEquals("RSM414 · firmware 20506", f["MAINBOARD"])
        assertEquals("W6SUN-Verdugo_Peak", f["HEARD BY"])
        assertEquals("34.2151, -118.2800 · 952 m", f["THEIR STATION"])
        assertEquals("7.5 dB SNR", f["SIGNAL"])
        assertNull(f["PRESSURE"])
    }

    @Test fun parsesAFlightAndItsLaunchSite() {
        val fl = SondeHub.parseFlight(org.json.JSONObject("""{
            "2026-11-14T23:18:00.000Z":{"lat":34.7530,"lon":-120.5690,"alt":300,"uploaders":[{"uploader_callsign":"A"},{"uploader_callsign":"B"}]},
            "2026-11-14T23:17:59.000Z":{"lat":34.75262,"lon":-120.56882,"alt":237,"uploader_callsign":"A"},
            "2026-11-15T00:28:15.000Z":{"lat":34.70,"lon":-120.00,"alt":32225.2,"uploaders":[{"uploader_callsign":"A"}]},
            "2026-11-15T00:56:33.000Z":{"lat":34.61271,"lon":-119.72784,"alt":2110}}"""))
        assertEquals(4, fl.frames)
        assertEquals(ms("2026-11-14T23:17:59Z"), fl.launch!!.ms)
        assertEquals(32225.2, fl.maxAlt, 1e-9)
        assertEquals("A" to 3, fl.stations[0])
        val vbg = HubSite("72393", "Vandenberg Air Force Base", 34.75, -120.57, emptyList(), emptyList())
        val far = HubSite("x", "Far", 40.0, -100.0, emptyList(), emptyList())
        assertEquals(vbg, SondeHub.launchSite(listOf(far, vbg), fl.launch!!.lat, fl.launch!!.lon))
        assertNull(SondeHub.launchSite(listOf(far), fl.launch!!.lat, fl.launch!!.lon))
    }

    @Test fun parsesAPrediction() {
        val p = SondeHub.parsePredict(org.json.JSONObject("""{"vehicle":"X2223653","ascent_rate":5.1,"descent_rate":8.41,"burst_altitude":2110.77,"descending":1,
            "landed":0,"data":"[{\"time\": 1794704190, \"lat\": 34.6127, \"lon\": 240.2722, \"alt\": 2113.1}, {\"time\": 1794704278, \"lat\": 34.6130, \"lon\": 240.2710, \"alt\": 1315.5}]"}"""))!!
        assertEquals(34.6130, p.lat, 1e-9); assertEquals(-119.729, p.lon, 1e-6)
        assertEquals(1794704278000L, p.ms)
        assertTrue(p.descending); assertTrue(!p.landed)
        assertEquals(2, p.path.size)
    }
}
