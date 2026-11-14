// Flipper Unleashed Sub-GHz remotes, group B (elplast, faac_tm, feron, freezer, hay21, hollarm, jarolift, keyfinder).
// Each pulse train is built the way the protocol's own encoder in the .c lays it out, fed to a fresh decoder, and the hit,
// the raw key and the parsed fields are checked. Twins: web/test/remotes-ulB.mjs and RemotesUlBTest.swift.
package com.rocketgod.mayhem.core.apps.ism

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemotesUlBTest {
    private data class Hit(val data: Long, val data2: Long, val bits: Int, val info: RemoteInfo?)
    private class Train { val p = mutableListOf<Pair<Boolean, Int>>(); fun add(l: Boolean, d: Int) { p.add(l to d) } }

    private fun bit(v: Long, i: Int): Boolean = ((v ushr i) and 1L) != 0L
    private fun reverse(v: Long, n: Int): Long { var r = 0L; for (i in 0 until n) r = (r shl 1) or ((v ushr i) and 1L); return r }

    /** Deterministic timing jitter of up to 3 percent. `keep` leaves a pulse exact. */
    private val f = doubleArrayOf(1.03, 0.97, 1.02, 0.98, 1.01, 0.99)
    private fun jitter(p: List<Pair<Boolean, Int>>, keep: (Int) -> Boolean = { false }) =
        p.mapIndexed { i, (l, d) -> l to (if (keep(d)) d else Math.round(d * f[i % f.size]).toInt()) }

    private fun run(make: () -> FProto, pulses: List<Pair<Boolean, Int>>): List<Hit> {
        val p = make()
        val hits = mutableListOf<Hit>()
        p.callback = { q -> hits.add(Hit(q.decodeData, q.decodeData2, q.dataCountBit, q.remoteInfo())) }
        for ((l, d) in pulses) p.feed(l, d)
        return hits
    }

    private fun expectHit(name: String, make: () -> FProto, pulses: List<Pair<Boolean, Int>>, data: Long, bits: Int, serial: Long, btn: Int?, cnt: Int?,
                          extra: List<String>, data2: Long = 0L) {
        val trains = listOf("clean" to pulses, "jitter" to (if (name == "feron") jitter(pulses) { it == 500 } else jitter(pulses)))
        for ((tag, train) in trains) {
            val n = "$name $tag"
            val hits = run(make, train)
            assertTrue("$n hits", hits.isNotEmpty())
            val h = hits[0]
            assertEquals("$n data", data, h.data)
            assertEquals("$n data2", data2, h.data2)
            assertEquals("$n bits", bits, h.bits)
            val info = h.info
            assertNotNull("$n info", info)
            assertEquals("$n serial", serial, info!!.serial)
            assertEquals("$n btn", btn, info.btn)
            assertEquals("$n cnt", cnt, info.cnt)
            for (e in extra) if (tag == "clean" || !e.startsWith("Te: ")) assertTrue("$n extra $e ${info.extra}", info.extra.contains(e))
        }
    }

    // ---- encoders (from each protocol's get_upload) ----
    private fun elplast(data: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, 1550 * 8)
        for (i in 18 downTo 1) {
            if (bit(data, i - 1)) { t.add(true, 1550); t.add(false, if (i == 1) 1550 * 8 else 230) }
            else { t.add(true, 230); t.add(false, if (i == 1) 1550 * 8 else 1550) }
        }
        return t.p
    }
    private fun faacTm(data: Long, te: Int = 400): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, te * 35); t.add(true, te)
        for (i in 12 downTo 1) if (bit(data, i - 1)) { t.add(false, te); t.add(true, te * 2) } else { t.add(false, te * 2); t.add(true, te) }
        t.add(false, te * 35) // next repeat's header closes the frame
        return t.p
    }
    private fun feron(data: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, 750 * 6)
        for (i in 32 downTo 1) {
            t.add(true, if (bit(data, i - 1)) 750 else 350)
            if (i == 1) { t.add(false, 500); t.add(true, 500); t.add(false, 750 * 6) } else t.add(false, if (bit(data, i - 1)) 350 else 750)
        }
        return t.p
    }
    private fun freezerFrame(data: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(true, 250)
        for (i in 24 downTo 1) if (bit(data, i - 1)) { t.add(false, 250); t.add(true, 500) } else { t.add(false, 500); t.add(true, 250) }
        t.add(false, 250 * 36)
        return t.p
    }
    private fun hay21(data: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, 700 * 6)
        for (i in 21 downTo 1) {
            if (bit(data, i - 1)) { t.add(true, 700); t.add(false, if (i == 1) 4200 else 300) }
            else { t.add(true, 300); t.add(false, if (i == 1) 4200 else 700) }
        }
        return t.p
    }
    private fun hollarm(data: Long): List<Pair<Boolean, Int>> {
        val d = data shl 2
        val t = Train(); t.add(false, 200 * 12)
        for (i in 42 downTo 1) { t.add(true, 200); t.add(false, if (i == 1) 2400 else if (bit(d, i - 1)) 1600 else 1000) }
        return t.p
    }
    private fun jarolift(data: Long, group: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, 800 * 18); t.add(true, 1500); t.add(false, 400)
        for (i in 0 until 8) { t.add(true, 400); t.add(false, if (i == 7) 3800 else 400) }
        fun cell(b: Boolean) { if (b) { t.add(true, 400); t.add(false, 800) } else { t.add(true, 800); t.add(false, 400) } }
        for (i in 64 downTo 1) cell(bit(data, i - 1))
        for (i in 8 downTo 1) cell(bit(group, i - 1))
        val last = t.p.removeAt(t.p.size - 1)
        t.add(false, last.second + 800 * 18) // the last low runs into the next repeat's 14.4 ms lead-in
        return t.p
    }
    private fun keyfinder(data: Long): List<Pair<Boolean, Int>> {
        val t = Train(); t.add(false, 4000)
        for (i in 24 downTo 1) if (bit(data, i - 1)) { t.add(true, 400); t.add(false, 1200) } else { t.add(true, 1200); t.add(false, 400) }
        repeat(3) { t.add(true, 400); t.add(false, 400) }
        t.add(true, 400); t.add(false, 4000)
        return t.p
    }

    // ---- cases ----
    @Test fun elplast() = expectHit("elplast", { SElplast() }, elplast(0x32C0AL), 0x32C0AL, 18, 0L, null, null,
        listOf("Yek: 0x" + "%05X".format(reverse(0x32C0AL, 18))))

    @Test fun faacTm() = expectHit("faac_tm", { SFaacTm() }, faacTm(0xA5CL), 0xA5CL, 12, 0L, null, null, listOf("Te: 400us", "DIP: 101001011100"))

    @Test fun feron() = expectHit("feron", { SFeron() }, feron(0x6338857AL), 0x6338857AL, 32, 0x6338L, null, null, listOf("Command: 0x857A"))

    @Test fun freezer() {
        val key = 0xABCDE3L
        val twice = listOf(false to 9000) + freezerFrame(key) + freezerFrame(key)
        expectHit("freezer", { SFreezer() }, twice, key, 24, 0xABCDEL, 3, null, emptyList())
        assertEquals("freezer single frame not reported", 0, run({ SFreezer() }, listOf(false to 9000) + freezerFrame(key)).size)
        assertEquals("freezer two different frames not reported", 0, run({ SFreezer() }, listOf(false to 9000) + freezerFrame(key) + freezerFrame(key xor 0x10L)).size)
    }

    @Test fun hay21() = expectHit("hay21", { SHay21() }, hay21(0x1877B9L), 0x1877B9L, 21, 0xBDL, 0xC3, 0xC, listOf("Button: Mode"))

    @Test fun hollarm() {
        expectHit("hollarm", { SHollarm() }, hollarm(0xF0B93422FFL), 0xF0B93422FFL, 42, 0xF0B934L, 2, null, listOf("Sum: FF", "Button: Arm"))
        assertEquals("hollarm bad sum not reported", 0, run({ SHollarm() }, hollarm(0xF0B93422FEL)).size)
        assertEquals("hollarm flipped bit not reported", 0, run({ SHollarm() }, hollarm(0xF0B93522FFL)).size)
    }

    @Test fun jarolift() {
        // Reversed key = btn 8 (Up) | serial 0x1234567 | hop 0xDEADBEEF; reversed grouping byte 0x01
        val fixHop = java.lang.Long.parseUnsignedLong("81234567DEADBEEF", 16)
        val data = reverse(fixHop, 64); val group = reverse(0x01L, 8)
        expectHit("jarolift", { SJarolift() }, jarolift(data, group), data, 72, 0x1234567L, 8, null,
            listOf("Button: Up", "Hop: DEADBEEF (encrypted)", "Group: 01"), group)
    }

    @Test fun keyfinder() = expectHit("keyfinder", { SKeyfinder() }, keyfinder(0xC396FEL), 0xC396FEL, 24, 0xC396FL, 0xE, null,
        listOf("Yek: 0x" + "%06X".format(reverse(0xC396FEL, 24))))
}
