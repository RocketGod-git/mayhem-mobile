package com.rocketgod.mayhem.core.apps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ACARS aircraft, as web/test/acars-planes.mjs (check for check, same names): decoder lines read back into messages,
 * grouped into one record per aircraft, and US registrations turned into ICAO addresses for the ADS-B link.
 */
class AcarsPlanesTest {
    private var pass = 0
    private val fails = mutableListOf<String>()
    private fun ok(c: Boolean, what: String, extra: String = "") { if (c) pass++ else fails.add("$what${if (extra.isNotEmpty()) " — $extra" else ""}") }
    private fun eq(a: Any?, b: Any?, what: String) = ok(a == b, what, "got $a, want $b")

    /** A line exactly as AcarsDecoder.finish() writes it. */
    private fun line(mhz: String = "131.550", down: Boolean = true, reg: String = "N12345", label: String = "H1", blk: String = "3", ack: String = "NAK",
                     msn: String = "M01A", flight: String = "UA1234", ok: Boolean = true, mode: String = "2", text: String = ""): String {
        val head = "ACARS $mhz ${if (down) "↓" else "↑"} $reg  $label  blk $blk  ack $ack${if (msn.isNotEmpty()) "  #$msn $flight" else ""}${if (ok) "" else "  CRC?"}${if (mode != "2") "  mode $mode" else ""}"
        return if (text.isNotEmpty()) "$head\n$text" else head
    }

    private fun messages() {
        val m = parseAcarsLine(line(text = "POS N3412W11824"), 1000)!!
        eq(m.mhz, "131.550", "channel")
        eq(m.down, true, "downlink")
        eq(m.reg, "N12345", "registration")
        eq(m.label, "H1", "label")
        eq(m.blk, "3", "block")
        eq(m.ack, "NAK", "ack")
        eq(m.msn, "M01A", "message number")
        eq(m.flight, "UA1234", "flight")
        eq(m.crcOk, true, "CRC good")
        eq(m.mode, "2", "mode")
        eq(m.text, "POS N3412W11824", "text")
        eq(m.ms, 1000L, "time")
        val u = parseAcarsLine(line(down = false, reg = "", label = "_d", blk = "A", ack = "1", msn = "", ok = false, mode = "X"), 5)!!
        eq(u.down, false, "uplink")
        eq(u.reg, "", "no registration")
        eq(u.label, "_d", "DEL label")
        eq(u.msn, "", "no message number on an uplink")
        eq(u.crcOk, false, "CRC bad")
        eq(u.mode, "X", "other mode")
        eq(u.text, "", "no text")
        val sp = parseAcarsLine(line(msn = "M02B", flight = ""), 5)!!
        eq(sp.flight, "", "message number without a flight")
        eq(parseAcarsLine(line(mhz = "131,550"), 0)?.mhz, "131.550", "a decimal comma (a device locale) reads the same")
        eq(parseAcarsLine("ACARS: decoding 131.550 MHz", 0), null, "not a message line")
        eq(parseAcarsLine("POCSAG 1200 …", 0), null, "another decoder line")
    }

    private fun aircraft() {
        val p = AcarsPlanes()
        p.add(parseAcarsLine(line(reg = "N12345", flight = "UA1234", text = "one"), 1000)!!)
        p.add(parseAcarsLine(line(reg = "N12345", flight = "UA1234", text = "two"), 2000)!!)
        p.add(parseAcarsLine(line(reg = "G-EUUA", flight = "BA0123", text = "three"), 1500)!!)
        p.add(parseAcarsLine(line(down = false, reg = "", label = "SQ", msn = ""), 1600)!!)
        eq(p.planes.size, 2, "one record per aircraft, ground squitter left out")
        eq(p.total, 4, "every message counted")
        val a = p.planes["R:N12345"]!!
        eq(a.count, 2, "messages per aircraft")
        eq(a.msgs[0].text, "two", "newest message first")
        eq(a.firstMs, 1000L, "first heard")
        eq(a.lastMs, 2000L, "last heard")
        eq(a.icao, nNumberToIcao("N12345"), "ICAO from the N-number")
        eq(p.planes["R:G-EUUA"]!!.icao, "", "no ICAO from a foreign registration")
        eq(p.list()[0].reg, "N12345", "most recent first")
        // a flight heard first without its registration joins it later
        p.add(parseAcarsLine(line(reg = "", flight = "DL0042", text = "a"), 3000)!!)
        eq(p.planes.containsKey("F:DL0042"), true, "kept by flight when there is no registration")
        p.add(parseAcarsLine(line(reg = "N301DV", flight = "DL0042", text = "b"), 4000)!!)
        eq(p.planes.containsKey("F:DL0042"), false, "the flight record moves to the registration")
        eq(p.planes["R:N301DV"]!!.count, 2, "its messages come along")
        for (i in 0 until MSG_KEEP + 5) p.add(parseAcarsLine(line(reg = "N1"), 5000L + i)!!)
        eq(p.planes["R:N1"]!!.msgs.size, MSG_KEEP, "messages capped")
        eq(p.planes["R:N1"]!!.count, MSG_KEEP + 5, "count keeps going")
        eq(planeKey(parseAcarsLine(line(reg = "", flight = "", msn = ""), 0)!!), "", "nothing to key on")
        p.clear(); eq(p.planes.size, 0, "clear")
    }

    private fun nNumbers() {
        eq(nNumberToIcao("N1"), "A00001", "N1")
        eq(nNumberToIcao("N628TS"), "A835AF", "N628TS")
        eq(nNumberToIcao("n-628ts"), "A835AF", "lower case with a dash")
        eq(nNumberToIcao("N99999"), "ADF7C7", "N99999 is the last")
        eq(nNumberToIcao("N1A"), "A00002", "N1A")
        eq(nNumberToIcao("N1AA"), "A00003", "N1AA")
        eq(nNumberToIcao("N10"), "A0025A", "N10")
        eq(nNumberToIcao("G-EUUA"), "", "not a US registration")
        eq(nNumberToIcao("N0123"), "", "no leading zero")
        eq(nNumberToIcao("N1I"), "", "no letter I")
        eq(nNumberToIcao("N123456"), "", "too long")
        eq(normReg("N-628TS"), "N628TS", "registration normalized")
        eq(labelMeaning("Q0"), "link test", "label meaning")
        eq(labelMeaning("ZZ"), "", "unknown label")
    }

    @Test fun everyCheck() {
        messages(); aircraft(); nNumbers()
        println("ACARS aircraft: $pass passed, ${fails.size} failed")
        assertTrue("failed:\n" + fails.joinToString("\n"), fails.isEmpty())
        assertEquals("the web test's 53 checks, one for one", 53, pass)
    }
}
