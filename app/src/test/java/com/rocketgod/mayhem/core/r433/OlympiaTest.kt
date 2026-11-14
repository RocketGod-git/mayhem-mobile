package com.rocketgod.mayhem.core.r433

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.roundToInt

/** Olympia Protect 9571 (rtl_433 386): frames built from the documented layout, sliced from FSK pulses. Twin of web/test/olympia.mjs. */
class OlympiaTest {
    private fun frame(id: Int, weak: Int, cls: Int, type: Int, state: Int, bad: Boolean = false): IntArray {
        val b = mutableListOf((id shr 16) and 0xff, (id shr 8) and 0xff, id and 0xff, 0x80 or 0x08 or 0x06, (weak shl 7) or (cls shl 4) or (type shl 1) or state)
        b.add((b.sum() + if (bad) 1 else 0) and 0xff)
        return (listOf(0xaa, 0xaa, 0x2d, 0xd4) + b).toIntArray()
    }

    private fun pulses(bytes: IntArray, rate: Double = 1_000_000.0): PulseData {
        val bits = bytes.flatMap { v -> (7 downTo 0).map { (v shr it) and 1 } }
        val runs = ArrayList<IntArray>()
        for (b in bits) if (runs.isNotEmpty() && runs.last()[0] == b) runs.last()[1]++ else runs.add(intArrayOf(b, 1))
        if (runs[0][0] == 0) runs.removeAt(0)
        if (runs.last()[0] == 1) runs.add(intArrayOf(0, 0))
        val p = PulseData(runs.size, rate, true)
        for (i in runs.indices step 2) {
            p.pulse[p.numPulses] = (runs[i][1] * 366 * rate / 1e6).roundToInt()
            p.gap[p.numPulses] = if (i + 1 == runs.size - 1) (10_000 * rate / 1e6).roundToInt() else (runs[i + 1][1] * 366 * rate / 1e6).roundToInt()
            p.numPulses++
        }
        return p
    }

    private val dev get() = R433Registry.all.first { it.num == 386 }
    private fun run(bytes: IntArray) = R433(listOf(dev)).run(true, pulses(bytes)).map { it.data }

    @Test fun contactMotionKeyfob() {
        var d = run(frame(0x12ab34, 0, 0, 4, 1)).first()
        assertEquals("Olympia-9571", d["model"]); assertEquals("Contact", d["subtype"]); assertEquals("12ab34", d["id"])
        assertEquals("open", d["state"]); assertEquals(1, d["battery_ok"])
        d = run(frame(0x5a10ff, 1, 0, 7, 0)).first()
        assertEquals("PIR-Motion", d["subtype"]); assertEquals("idle", d["state"]); assertEquals(0, d["battery_ok"])
        d = run(frame(0xc0ffee, 0, 1, 7, 0)).first()
        assertEquals("Keyfob", d["subtype"]); assertEquals("SOS", d["cmd"]); assertEquals(7, d["cmd_id"])
        assertEquals("bad checksum is not reported", 0, run(frame(0x12ab34, 0, 0, 4, 1, bad = true)).size)
    }
}
