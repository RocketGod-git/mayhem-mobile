package com.rocketgod.mayhem.core.apps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * BLE devices, as web/test/ble.mjs (check for check, same names): advertising PDUs built byte by byte are read back
 * field by field, each maker and device type is recognized from what it advertises, and the tracker keeps one device
 * per address and raises its alert after 20 minutes or a move.
 */
class BleDevicesTest {
    private var pass = 0
    private val fails = mutableListOf<String>()
    private fun ok(c: Boolean, what: String, extra: String = "") { if (c) pass++ else fails.add("$what${if (extra.isNotEmpty()) " — $extra" else ""}") }
    private fun eq(a: Any?, b: Any?, what: String) = ok(a == b, what, "got $a, want $b")

    /** A PDU: header (type, TxAdd), length, the address (written MSB first here, sent LSB first), AD structures. */
    private fun pdu(type: Int, mac: String, ads: List<Pair<Int, List<Int>>>, random: Boolean = true): IntArray {
        val addr = mac.split(':').map { it.toInt(16) }.reversed()
        val body = addr + ads.flatMap { (t, d) -> listOf(d.size + 1, t) + d }
        return (listOf(type or (if (random) 0x40 else 0), body.size) + body).toIntArray()
    }
    private fun mfr(id: Int, d: List<Int>) = 0xFF to (listOf(id and 0xFF, id shr 8) + d)
    private fun svc(u: Int, d: List<Int>) = 0x16 to (listOf(u and 0xFF, u shr 8) + d)
    private fun uuids(vararg us: Int) = 0x03 to us.flatMap { listOf(it and 0xFF, it shr 8) }
    private fun name(s: String) = 0x09 to s.map { it.code }
    private fun flags(f: Int) = 0x01 to listOf(f)
    private fun appear(v: Int) = 0x19 to listOf(v and 0xFF, v shr 8)
    private fun zeros(n: Int) = List(n) { 0 }
    private fun kindOf(p: IntArray) = classify(parseAdv(p, -60.0, 37)!!)
    private fun seq(n: Int, from: Int = 0) = List(n) { it + from }

    private val cases: List<Triple<String, IntArray, Pair<BleKind, Boolean>>> by lazy { listOf(
        Triple("AirTag away from its owner", pdu(2, "D1:00:00:00:00:01", listOf(mfr(0x004C, listOf(0x12, 0x19, 0x10) + zeros(22) + listOf(0x01, 0x00)))), BleKind.AIRTAG to true),
        Triple("Find My near its owner", pdu(2, "D1:00:00:00:00:02", listOf(mfr(0x004C, listOf(0x12, 0x02, 0x24, 0x01)))), BleKind.FINDMY to true),
        Triple("iBeacon", pdu(2, "D1:00:00:00:00:03", listOf(flags(0x06), mfr(0x004C, listOf(0x02, 0x15) + seq(16) + listOf(0x00, 0x07, 0x01, 0x2C, 0xC5)))), BleKind.IBEACON to false),
        Triple("AirPods", pdu(0, "D1:00:00:00:00:04", listOf(mfr(0x004C, listOf(0x07, 0x19, 0x01, 0x0E, 0x20) + zeros(20)))), BleKind.EARBUDS to false),
        Triple("iPhone (Nearby Info)", pdu(0, "D1:00:00:00:00:05", listOf(flags(0x1A), mfr(0x004C, listOf(0x10, 0x05, 0x01, 0x18, 0x44, 0x00, 0x00)))), BleKind.PHONE to false),
        Triple("AirPlay target", pdu(0, "D1:00:00:00:00:06", listOf(mfr(0x004C, listOf(0x09, 0x06, 0x03, 0x00, 0xC0, 0xA8, 0x01, 0x02)))), BleKind.TV to false),
        Triple("Windows PC", pdu(2, "D1:00:00:00:00:07", listOf(mfr(0x0006, listOf(0x01, 0x09, 0x20, 0x02) + zeros(20)))), BleKind.COMPUTER to false),
        Triple("Tile", pdu(0, "D1:00:00:00:00:08", listOf(flags(0x06), uuids(0xFEED), svc(0xFEED, listOf(0x02, 0x00) + zeros(8)))), BleKind.TILE to true),
        Triple("Galaxy SmartTag", pdu(2, "D1:00:00:00:00:09", listOf(svc(0xFD5A, listOf(0x10) + zeros(15)))), BleKind.SMARTTAG to true),
        Triple("Google Find Hub tag", pdu(2, "D1:00:00:00:00:0A", listOf(svc(0xFEAA, listOf(0x41) + zeros(20)))), BleKind.FINDHUB to true),
        Triple("Eddystone-URL", pdu(2, "D1:00:00:00:00:0B", listOf(uuids(0xFEAA), svc(0xFEAA, listOf(0x10, 0xEB, 0x03) + "goo.gl/x".map { it.code }))), BleKind.EDDYSTONE to false),
        Triple("Eddystone-UID", pdu(2, "D1:00:00:00:00:0C", listOf(svc(0xFEAA, listOf(0x00, 0xEB) + seq(16, 1) + listOf(0, 0)))), BleKind.EDDYSTONE to false),
        Triple("Fast Pair earbuds", pdu(0, "D1:00:00:00:00:0D", listOf(svc(0xFE2C, listOf(0x00, 0x01, 0x02)))), BleKind.EARBUDS to false),
        Triple("watch by appearance", pdu(0, "D1:00:00:00:00:0E", listOf(appear(0x00C1), name("Unknown"))), BleKind.WATCH to false),
        Triple("phone by appearance", pdu(0, "D1:00:00:00:00:0F", listOf(appear(0x0040))), BleKind.PHONE to false),
        Triple("earbuds by appearance", pdu(0, "D1:00:00:00:00:10", listOf(appear(0x0941))), BleKind.EARBUDS to false),
        Triple("keyboard by appearance", pdu(0, "D1:00:00:00:00:11", listOf(appear(0x03C1))), BleKind.HID to false),
        Triple("watch by name", pdu(0, "D1:00:00:00:00:12", listOf(mfr(0x0087, listOf(0x01)), name("Forerunner 265"))), BleKind.WATCH to false),
        Triple("earbuds by name", pdu(0, "D1:00:00:00:00:13", listOf(name("Galaxy Buds2 Pro"))), BleKind.EARBUDS to false),
        Triple("phone by name", pdu(0, "D1:00:00:00:00:14", listOf(name("Jo's iPhone"))), BleKind.PHONE to false),
        Triple("plain device", pdu(0, "D1:00:00:00:00:15", listOf(mfr(0x0059, listOf(0x01, 0x02)))), BleKind.DEVICE to false),
    ) }

    private fun parsing() {
        val a = parseAdv(pdu(0, "C0:FF:EE:12:34:56", listOf(flags(0x06), name("Pixel 9"), 0x0A to listOf(0xF4), appear(0x0040), uuids(0x180F, 0xFE2C)), false), -51.6, 38)!!
        eq(a.pduType, "ADV_IND", "pdu type")
        eq(a.mac, "C0:FF:EE:12:34:56", "address read LSB first")
        eq(a.random, false, "public address")
        eq(a.name, "Pixel 9", "name")
        eq(a.flags, 0x06, "flags")
        eq(a.txPower, -12, "tx power is signed")
        eq(a.appearance, 0x0040, "appearance")
        eq(a.uuids16.joinToString(","), listOf(0x180F, 0xFE2C).joinToString(","), "service uuids")
        eq(a.ch, 38, "channel kept")
        eq(a.raw.substring(0, 4), "00" + "%02X".format(a.raw.length / 2 - 2), "raw hex starts with header and length")
        val n = parseAdv(pdu(2, "11:22:33:44:55:66", listOf(mfr(0x004C, listOf(0x12, 0x02, 0x00, 0x01)))), -70.0, 37)!!
        eq(n.pduType, "ADV_NONCONN_IND", "nonconnectable")
        eq(n.random, true, "random address")
        eq(n.mfr, 0x004C, "company id")
        eq(n.mfrData.joinToString(","), "18,2,0,1", "manufacturer data after the company id")
        eq(parseAdv(intArrayOf(0, 6, 1, 2, 3), -60.0, 37), null, "too short for an address")
        val bad = parseAdv(intArrayOf(0x40, 12, 1, 2, 3, 4, 5, 6, 9, 0x09, 0x41, 0x42), -60.0, 37)!!
        eq(bad.name, "", "an AD structure running past the end is dropped")
        val direct = parseAdv(pdu(1, "01:02:03:04:05:06", listOf(name("x"))), -60.0, 37)!!
        eq(direct.name, "", "ADV_DIRECT_IND carries no AD structures")
        val sr = parseAdv(pdu(4, "01:02:03:04:05:06", listOf(name("Galaxy Buds2"))), -60.0, 37)!!
        eq(sr.pduType, "SCAN_RSP", "scan response")
        eq(sr.name, "Galaxy Buds2", "scan response name")
        val sd = parseAdv(pdu(0, "01:02:03:04:05:06", listOf(svc(0xFEAA, listOf(0x20, 0x00, 0x0B, 0xB8)))), -60.0, 37)!!
        eq(sd.svc.size, 1, "service data")
        eq(sd.svc[0].uuid, 0xFEAA, "service data uuid")
        eq(sd.svc[0].data.joinToString(","), "32,0,11,184", "service data bytes")
    }

    private fun makers() {
        eq(companyName(0x004C), "Apple", "Apple")
        eq(companyName(0x0006), "Microsoft", "Microsoft")
        eq(companyName(0x0075), "Samsung", "Samsung")
        eq(companyName(0x00E0), "Google", "Google")
        eq(companyName(0x0087), "Garmin", "Garmin")
        eq(companyName(0x1234), "", "unknown company")
        eq(kindOf(pdu(0, "AA:BB:CC:00:00:01", listOf(mfr(0x0075, listOf(0x42, 0x09, 0x01))))).maker, "Samsung", "maker from manufacturer data")
        eq(kindOf(pdu(0, "AA:BB:CC:00:00:02", listOf(svc(0xFD5A, zeros(8))))).maker, "Samsung", "maker from a SmartTag service")
        eq(kindOf(pdu(0, "AA:BB:CC:00:00:03", listOf(uuids(0xFEED)))).maker, "Tile", "maker from a Tile service")
        eq(kindOf(pdu(0, "AA:BB:CC:00:00:04", listOf(name("thing")))).maker, "", "no maker")
    }

    private fun deviceTypes() {
        for ((what, p, want) in cases) {
            val c = kindOf(p)
            eq(c.kind, want.first, "type: $what")
            eq(c.tracker, want.second, "tracker: $what")
        }
        val c = kindOf(cases[2].second)
        eq(c.extra.firstOrNull { it.name == "UUID" }?.value, "00010203-0405-0607-0809-0A0B0C0D0E0F", "iBeacon UUID")
        eq(c.extra.firstOrNull { it.name == "Major" }?.value, "7", "iBeacon major")
        eq(c.extra.firstOrNull { it.name == "Minor" }?.value, "300", "iBeacon minor")
        eq(c.extra.firstOrNull { it.name == "Power at 1 m" }?.value, "-59 dBm", "iBeacon power")
        eq(kindOf(cases[10].second).extra.firstOrNull { it.name == "URL" }?.value, "https://goo.gl/x", "Eddystone URL")
        eq(eddystoneUrl(listOf(0x10, 0, 0x00, 0x61, 0x00)), "http://www.a.com/", "Eddystone URL expansion")
        eq(kindOf(cases[11].second).extra.firstOrNull { it.name == "Namespace" }?.value, "0102030405060708090A", "Eddystone namespace")
        eq(kindOf(cases[0].second).maker, "Apple", "AirTag maker")
        eq(kindOf(cases[9].second).maker, "Google", "Find Hub maker")
    }

    private fun tracker() {
        val t = BleTracker()
        val tag = cases[0].second; val buds = cases[3].second
        val t0 = 1_700_000_000_000L
        for (i in 0 until 10) t.add(parseAdv(tag, -60.0 - i, 37 + (i % 3))!!, t0 + i * 1000L)
        t.add(parseAdv(buds, -40.0, 37)!!, t0 + 500)
        eq(t.devices.size, 2, "one device per address")
        val d = t.devices["D1:00:00:00:00:01"]!!
        eq(d.count, 10, "packet count")
        eq(d.rssi.size, 10, "signal history")
        eq(d.rssi[9], -69, "latest signal")
        eq(d.history[3].ch, 37, "raw history keeps the channel")
        eq(d.lastMs - d.firstMs, 9000L, "first and last heard")
        eq(d.alert, "", "no alert after nine seconds")
        eq(d.fields.firstOrNull { it.name == "Maker" }?.value, "Apple", "maker field")
        eq(d.fields.firstOrNull { it.name == "Packets" }?.value, "10", "packets field")
        t.add(parseAdv(tag, -61.0, 37)!!, t0 + TRACKER_ALERT_MS)
        ok(d.alert.contains("NEAR YOU FOR 20 MIN"), "alert after 20 minutes", d.alert)
        eq(t.list()[0].mac, d.mac, "the alerted device leads the list")
        val b = t.devices["D1:00:00:00:00:04"]!!
        t.add(parseAdv(buds, -40.0, 37)!!, t0 + TRACKER_ALERT_MS * 2)
        eq(b.alert, "", "earbuds never raise a tracker alert")
        for (i in 0 until RSSI_KEEP + HISTORY_KEEP) t.add(parseAdv(buds, -40.0, 37)!!, t0 + i)
        eq(b.rssi.size, RSSI_KEEP, "signal history is capped")
        eq(b.history.size, HISTORY_KEEP, "raw history is capped")

        val m = BleTracker(); val tile = cases[7].second
        m.add(parseAdv(tile, -60.0, 37)!!, t0, BlePos(34.0, -118.0))
        m.add(parseAdv(tile, -60.0, 37)!!, t0 + 60_000, BlePos(34.002, -118.0))
        eq(m.list()[0].alert, "", "no alert after 220 m")
        m.add(parseAdv(tile, -60.0, 37)!!, t0 + 120_000, BlePos(34.01, -118.0))
        ok(m.list()[0].alert.contains("MOVING WITH YOU"), "alert after a move", m.list()[0].alert)
        ok(abs(distM(BlePos(0.0, 0.0), BlePos(1.0, 0.0)) - 111_195) < 50, "one degree of latitude")

        // a name in a scan response sticks; a bare advertisement does not undo a recognized type
        val n = BleTracker()
        n.add(parseAdv(pdu(0, "E1:00:00:00:00:01", listOf(appear(0x0941))), -60.0, 37)!!, t0)
        n.add(parseAdv(pdu(4, "E1:00:00:00:00:01", listOf(name("Buds Live"))), -60.0, 37)!!, t0 + 10)
        n.add(parseAdv(pdu(0, "E1:00:00:00:00:01", listOf(flags(0x06))), -60.0, 37)!!, t0 + 20)
        val e = n.devices["E1:00:00:00:00:01"]!!
        eq(e.name, "Buds Live", "name from the scan response")
        eq(e.kind, BleKind.EARBUDS, "type kept")
        n.clear(); eq(n.devices.size, 0, "clear")
    }

    @Test fun everyCheck() {
        parsing(); makers(); deviceTypes(); tracker()
        println("BLE devices: $pass passed, ${fails.size} failed")
        assertTrue("failed:\n" + fails.joinToString("\n"), fails.isEmpty())
        assertEquals("the web test's 103 checks, one for one", 103, pass)
    }
}
