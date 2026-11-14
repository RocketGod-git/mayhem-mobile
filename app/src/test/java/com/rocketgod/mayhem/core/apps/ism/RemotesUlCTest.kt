package com.rocketgod.mayhem.core.apps.ism

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Flipper Unleashed Sub-GHz remotes, group C: Keyfinder 2, Nord Ice, Proteco, Revers RB2, Roger, Telcoma Edge,
 * Treadmill37. Every pulse train is built the way the protocol's own encoder (get_upload in the .c) lays it out, fed
 * to a fresh decoder, and checked for the hit, the raw key and the fields Flipper's get_string shows. One pass of each
 * adds a few percent of timing jitter; where the decoder has a check (length, preamble, stop code, guard ratio), a
 * frame that breaks it must not be reported. Twin of web/test/remotes-ulC.mjs.
 */
class RemotesUlCTest {
    private class Hit(val data: Long, val bits: Int, val info: RemoteInfo?)
    private class Want(val data: Long, val bits: Int, val name: String, val serial: Long, val btn: Int?, val cnt: Int?, val extra: List<String>, val minHits: Int)

    private fun bit(v: Long, i: Int): Boolean = (v ushr i) and 1L != 0L

    /** Deterministic jitter: +-4 % on every duration (same generator as the web test). */
    private fun jitter(p: List<Pair<Boolean, Int>>): List<Pair<Boolean, Int>> {
        var s = 12345L
        return p.map { (l, d) ->
            s = (s * 1103515245L + 12345L) and 0x7fffffffL
            val f = 1 + ((s.toDouble() / 0x7fffffff) * 2 - 1) * 0.04
            l to Math.round(d * f).toInt()
        }
    }

    private fun merge(p: List<Pair<Boolean, Int>>): List<Pair<Boolean, Int>> {
        val out = ArrayList<Pair<Boolean, Int>>()
        for ((l, d) in p) { if (out.isNotEmpty() && out.last().first == l) out[out.size - 1] = l to (out.last().second + d) else out.add(l to d) }
        return out
    }

    private fun run(make: () -> FProto, p: List<Pair<Boolean, Int>>): List<Hit> {
        val d = make()
        val hits = ArrayList<Hit>()
        d.callback = { x -> hits.add(Hit(x.decodeData, x.dataCountBit, x.remoteInfo())) }
        for ((l, dur) in p) d.feed(l, dur)
        return hits
    }

    private fun check(label: String, make: () -> FProto, p: List<Pair<Boolean, Int>>, w: Want) {
        for ((tag, pulses) in listOf("clean" to p, "jitter" to jitter(p))) {
            val hits = run(make, pulses)
            val t = "$label ($tag)"
            assertTrue("$t hits: ${hits.size}", hits.size >= w.minHits)
            assertTrue("$t all hits agree", hits.all { it.data == hits[0].data })
            val h = hits[0]
            assertEquals("$t decodeData", w.data, h.data)
            assertEquals("$t dataCountBit", w.bits, h.bits)
            val info = h.info
            assertNotNull("$t remoteInfo", info)
            assertEquals("$t name", w.name, info!!.name)
            assertEquals("$t serial", w.serial, info.serial)
            assertEquals("$t btn", w.btn, info.btn)
            assertEquals("$t cnt", w.cnt, info.cnt)
            assertEquals("$t extra", w.extra, info.extra)
        }
    }

    private fun none(label: String, make: () -> FProto, p: List<Pair<Boolean, Int>>) = assertEquals("$label rejected", 0, run(make, p).size)

    // ---- Keyfinder 2 ----
    private fun kf2(data: Long, bits: Int = 11): List<Pair<Boolean, Int>> {
        val p = ArrayList<Pair<Boolean, Int>>()
        for (i in bits downTo 1) {
            val wide = i > bits - 3
            val s = if (wide) 1500 else 350; val l = if (wide) 2500 else 1020
            if (bit(data, i - 1)) { p.add(true to s); p.add(false to l) } else { p.add(true to l); p.add(false to s) }
        }
        return p
    }

    @Test fun keyfinder2() {
        val data = (5L shl 8) or (0b10011L shl 3) or 5L
        check("Keyfinder2", ::SKeyfinder2, listOf(false to 5000) + kf2(data) + kf2(data) + kf2(data),
            Want(data, 11, "Keyfinder 2", 0L, 5, null, listOf("Color: Green"), 3))
        val bad = kf2(data).map { (l, d) -> l to (if (d == 1020) 1400 else d) }
        none("Keyfinder2 bad narrow timing", ::SKeyfinder2, listOf(false to 5000) + bad)
    }

    // ---- Nord Ice ----
    private fun nord(data: Long, gap: Int, bits: Int = 33): List<Pair<Boolean, Int>> {
        val p = ArrayList<Pair<Boolean, Int>>()
        for (i in bits downTo 1) {
            val last = i == 1
            if (bit(data, i - 1)) { p.add(true to 760); p.add(false to (if (last) gap else 270)) } else { p.add(true to 270); p.add(false to (if (last) gap else 760)) }
        }
        return p
    }

    @Test fun nordIce() {
        val key = 0x09467288AL; val flag = 1L shl 14
        val p = listOf(false to 7440) + nord(key or flag, 8980) + nord(key, 7440) + nord(key or flag, 8980) + nord(key, 7440)
        val serial = ((key ushr 15) shl 9) or (key and 0x1FFL)
        check("Nord Ice", ::SNordIce, p, Want(key, 33, "Nord Ice", serial, 4, null, listOf("Yek: 0x" + "%08X".format(FG.reverseKey(key, 33))), 4))
        none("Nord Ice 32-bit frame", ::SNordIce, listOf(false to 7440) + nord(key, 7440, 32))
    }

    // ---- Proteco ----
    private fun proteco(data: Long, guard: Int = 440 * 41 / 2): List<Pair<Boolean, Int>> {
        val p = arrayListOf(false to guard, true to 440)
        for (i in 24 downTo 1) { if (bit(data, i - 1)) { p.add(false to 880); p.add(true to 440) } else { p.add(false to 440); p.add(true to 880) } }
        return p
    }

    @Test fun proteco() {
        val key = 0xA5C3E1L
        check("Proteco", ::SProteco, proteco(key) + proteco(key) + listOf(false to 9020),
            Want(key, 24, "Proteco", (key ushr 2) and 0x3FFFFFL, 3, null, emptyList(), 2))
        none("Proteco guard off ratio", ::SProteco, proteco(key, 6000) + listOf(false to 6000))
    }

    // ---- Revers RB2 ----
    private fun rb2Frame(k: Long): List<Pair<Boolean, Int>> {
        val h = ArrayList<Pair<Boolean, Int>>()
        for (i in 63 downTo 0) { if (bit(k, i)) { h.add(false to 250); h.add(true to 250) } else { h.add(true to 250); h.add(false to 250) } }
        return h
    }

    @Test fun reversRb2() {
        // The decoder stands four header half-bits in for 0xF, one bit more than they span: transmit (want << 1).
        val want = 0xFFFF123456789A00uL.toLong()
        val tx = want shl 1
        val gap = listOf(false to 320)
        val p = merge(gap + rb2Frame(tx) + gap + rb2Frame(tx) + gap + rb2Frame(tx) + gap)
        check("Revers RB2", ::SReversRb2, p, Want(want, 64, "Revers RB2", ((want and 0xFFFFFFFFFFFFL) ushr 10) and 0xFFFFFFFFL, null, null, emptyList(), 1))
        val badTx = (want xor 0x100L) shl 1
        none("Revers RB2 bad stop code", ::SReversRb2, merge(gap + rb2Frame(badTx) + gap + rb2Frame(badTx) + gap))
        val badPre = (want xor (0x01L shl 48)) shl 1
        none("Revers RB2 bad preamble", ::SReversRb2, merge(gap + rb2Frame(badPre) + gap))
    }

    // ---- Roger ----
    private fun roger(data: Long, bits: Int = 28): List<Pair<Boolean, Int>> {
        val p = ArrayList<Pair<Boolean, Int>>()
        for (i in bits downTo 1) {
            val last = i == 1
            if (bit(data, i - 1)) { p.add(true to 1000); p.add(false to (if (last) 9500 else 500)) } else { p.add(true to 500); p.add(false to (if (last) 9500 else 1000)) }
        }
        return p
    }

    @Test fun roger() {
        val key = 0x23F9120L
        check("Roger", ::SRoger, listOf(false to 9500) + roger(key) + roger(key) + roger(key),
            Want(key, 28, "Roger", 0x23F9L, 1, null, listOf("End: 0x20"), 2))
        none("Roger 27-bit frame", ::SRoger, listOf(false to 9500) + roger(key, 27))
    }

    // ---- Telcoma Edge ----
    private fun telcoma(key: Long): List<Pair<Boolean, Int>> {
        val ch = (key and 7L).toInt()
        val value = if (ch == 0) key else key shl 1
        val n = if (ch == 0) 32 else 33
        val h = ArrayList<Pair<Boolean, Int>>()
        for (i in n - 1 downTo 0) { if (bit(value, i)) { h.add(true to 1270); h.add(false to 1270) } else { h.add(false to 1270); h.add(true to 1270) } }
        if (ch == 0) h.add(true to 1270)
        return h
    }

    @Test fun telcomaEdge() {
        val gap = listOf(false to 20000)
        for (key in longArrayOf(0xFF309FC0L, 0xFF309FC1L, 0xFF309FC4L)) {
            val payload = key and 0xFFFFFFL
            check("Telcoma Edge %08X".format(key), ::STelcomaEdge, merge(gap + telcoma(key) + gap + telcoma(key) + gap),
                Want(key, 32, "Telcoma Edge", (payload ushr 3) and 0x1FFFFFL, (payload and 7L).toInt(), null, emptyList(), 2))
        }
        none("Telcoma Edge no 0xFF preamble", ::STelcomaEdge, merge(gap + telcoma(0xFE309FC0L) + gap))
    }

    // ---- Treadmill37 ----
    private fun treadmill(data: Long, bits: Int = 37): List<Pair<Boolean, Int>> {
        val p = ArrayList<Pair<Boolean, Int>>()
        for (i in bits downTo 1) {
            val last = i == 1
            if (bit(data, i - 1)) { p.add(true to 900); p.add(false to (if (last) 6000 else 300)) } else { p.add(true to 300); p.add(false to (if (last) 6000 else 900)) }
        }
        return p
    }

    @Test fun treadmill37() {
        val key = 0x1800001830L
        check("Treadmill37", ::STreadmill37, listOf(false to 6000) + treadmill(key) + treadmill(key) + treadmill(key),
            Want(key, 37, "Treadmill37", 0xC0000L, 0x0C18, null, listOf("Yek: 0x" + "%08X".format(FG.reverseKey(key, 37))), 2))
        none("Treadmill37 36-bit frame", ::STreadmill37, listOf(false to 6000) + treadmill(key ushr 1, 36))
    }
}
