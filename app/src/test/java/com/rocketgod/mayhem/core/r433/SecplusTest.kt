package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.r433.devices.secplusClock
import com.rocketgod.mayhem.core.r433.devices.secplusResetCache
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Security+ pairs two halves across calls, so it is tested the way web/test/secplus.mjs tests it: frames built
 * digit by digit as a remote would send them, a driven clock to age the cache, and both halves in both orders.
 */
class SecplusTest {
    private var fakeNow = 1_000_000L
    private fun dev(num: Int) = R433Registry.all.first { it.num == num }
    private fun run(d: RDevice, bb: BitBuffer): List<R433Data> { val out = ArrayList<R433Data>(); d.decode(d, bb, DecodeCtx { out.add(it) }); return out }
    private fun rowBits(bits: List<Int>): BitBuffer { val bb = BitBuffer(); for (v in bits) bb.addBit(v); return bb }
    private fun pad(bits: List<Int>, n: Int) = bits + List(maxOf(0, n - bits.size)) { 0 }

    @Before fun setUp() { secplusClock = { fakeNow }; secplusResetCache() }
    @After fun tearDown() { secplusResetCache(); secplusClock = { System.currentTimeMillis() } }

    /** Each digit is a run of that many pulses plus one, then a gap; the half marker leads. */
    private fun v1Frame(marker: Int, payload: List<Int>): BitBuffer {
        val bits = ArrayList<Int>()
        for (d in listOf(marker) + payload) { repeat(d + 1) { bits.add(1) }; bits.add(0) }
        return rowBits(pad(bits, 100))
    }

    /** The transmit side of the digit interleave. */
    private fun v1Digits(rolling: List<Int>, fixed: List<Int>): List<Int> {
        val out = ArrayList<Int>(); var acc = 0
        for (i in 0 until 10) { val a = rolling[i]; out.add(a); acc += a; val b = fixed[i]; out.add((b + acc) % 3); acc += b }
        return out
    }

    @Test fun securityPlusV1() {
        val rollA = listOf(1, 0, 2, 1, 1, 0, 2, 2, 0, 1); val fixA = listOf(2, 1, 0, 0, 1, 2, 1, 0, 2, 1)
        val rollB = listOf(0, 2, 1, 1, 2, 0, 0, 1, 2, 2); val fixB = listOf(1, 0, 2, 1, 0, 1, 2, 2, 0, 0)
        val halfA = { v1Frame(0, v1Digits(rollA, fixA)) }
        val halfB = { v1Frame(2, v1Digits(rollB, fixB)) }
        var wantRolling = 0L; var wantFixed = 0L
        for (d in rollA + rollB) wantRolling = wantRolling * 3 + d
        for (d in fixA + fixB) wantFixed = wantFixed * 3 + d
        wantRolling = reverse32(wantRolling)
        val d178 = dev(178)

        assertEquals("a single half reports nothing", 0, run(d178, halfA()).size)
        val both = run(d178, halfB())
        assertEquals("the second half completes it", 1, both.size)
        assertEquals("Secplus-v1", both[0]["model"])
        assertEquals(wantFixed.toString(), both[0]["fixed"])
        assertEquals(wantRolling.toString(), both[0]["rolling"])
        assertEquals((wantFixed % 3).toInt(), both[0]["switch_id"])
        assertEquals(((wantFixed / 3) % 3).toInt(), both[0]["id0"])
        assertEquals(((wantFixed / 9) % 3).toInt(), both[0]["id1"])

        secplusResetCache()
        assertEquals("a half alone still says nothing afterwards", 0, run(d178, halfB()).size)
        secplusResetCache()
        assertEquals(0, run(d178, halfB()).size)
        val reversed = run(d178, halfA())
        assertEquals("either order", 1, reversed.size)
        assertEquals(wantFixed.toString(), reversed[0]["fixed"])

        secplusResetCache()
        run(d178, halfA()); fakeNow += 900
        assertEquals("a stale half is abandoned", 0, run(d178, halfB()).size)
        fakeNow += 1
        secplusResetCache()
        run(d178, halfA()); fakeNow += 50
        assertEquals("close halves pair", 1, run(d178, halfB()).size)

        secplusResetCache()
        assertEquals("a run of four is no digit", 0, run(d178, rowBits(pad(listOf(1, 1, 1, 1, 0, 1, 0, 1, 1, 0), 100))).size)
    }

    private val v2Invert = mapOf(0x0 to listOf(true, true, false), 0x1 to listOf(false, true, false), 0x2 to listOf(false, false, true),
        0x4 to listOf(true, true, true), 0x5 to listOf(true, false, true), 0x6 to listOf(false, true, true),
        0x8 to listOf(true, false, false), 0x9 to listOf(false, false, false), 0xa to listOf(true, false, true))
    private val v2Order = mapOf(0x0 to listOf(0, 2, 1), 0x1 to listOf(2, 0, 1), 0x2 to listOf(0, 1, 2), 0x4 to listOf(1, 2, 0),
        0x5 to listOf(1, 0, 2), 0x6 to listOf(2, 1, 0), 0x8 to listOf(1, 2, 0), 0x9 to listOf(2, 1, 0), 0xa to listOf(0, 1, 2))

    /** Building the scrambling forwards is the real test of undoing it. */
    private fun v2Frame(isSecond: Boolean, order: Int, invert: Int, p0: Int, p1: Int, p2: Int): BitBuffer {
        val head = ((order and 0x0f) shl 4) or (invert and 0x0f)
        val inv = v2Invert[invert] ?: listOf(false, false, false)
        val g = intArrayOf(if (inv[0]) p0.inv() and 0x3ff else p0, if (inv[1]) p1.inv() and 0x3ff else p1, if (inv[2]) p2.inv() and 0x3ff else p2)
        val ord = v2Order[order] ?: listOf(0, 1, 2)
        val slot = IntArray(3)
        slot[ord.indexOf(0)] = g[0]; slot[ord.indexOf(1)] = g[1]; slot[ord.indexOf(2)] = g[2]
        var x = 0L
        for (i in 9 downTo 0) {
            x = x * 2 + ((slot[0] shr i) and 1); x = x * 2 + ((slot[1] shr i) and 1); x = x * 2 + ((slot[2] shr i) and 1)
        }
        val bits = ArrayList<Int>()
        bits.add(0); bits.add(if (isSecond) 1 else 0); bits.add(0); bits.add(0)
        for (i in 7 downTo 0) bits.add((head shr i) and 1)
        for (i in 29 downTo 0) bits.add(((x shr i) and 1L).toInt())
        while (bits.size < 42) bits.add(0)
        val preamble = ArrayList<Int>()
        for (b in intArrayOf(0xaa, 0xaa, 0x95, 0x60)) for (i in 7 downTo 0) preamble.add((b shr i) and 1)
        val mc = bits.flatMap { listOf(it xor 1, it) }
        return rowBits(pad(preamble.subList(0, 26) + mc, 200))
    }

    @Test fun securityPlusV2() {
        val first = { v2Frame(false, 0x2, 0x9, 0x2b5, 0x1c3, 0x155) }
        val second = { v2Frame(true, 0x6, 0x4, 0x33a, 0x145, 0x111) }
        val d164 = dev(164)

        assertEquals(0, run(d164, first()).size)
        val both = run(d164, second())
        assertEquals("the second half completes it", 1, both.size)
        assertEquals("Secplus-v2", both[0]["model"])
        assertTrue((both[0]["fixed"] as String).toLong() >= 0)
        assertTrue(both[0]["rolling"] is String)

        secplusResetCache()
        assertEquals(0, run(d164, second()).size)
        assertEquals("either order", 1, run(d164, first()).size)

        secplusResetCache()
        run(d164, first()); fakeNow += 900
        assertEquals("a stale half is abandoned", 0, run(d164, second()).size)
        fakeNow += 1

        secplusResetCache()
        assertEquals("an unknown inversion code is refused", 0, run(d164, v2Frame(false, 0x2, 0x3, 0x2b5, 0x1c3, 0x155)).size)
        secplusResetCache()
        assertEquals("an unknown order code is refused", 0, run(d164, v2Frame(false, 0x3, 0x9, 0x2b5, 0x1c3, 0x155)).size)
    }

    @Test fun noProtocolRegisteredTwice() {
        val nums = R433Registry.all.map { it.num }
        assertEquals(nums.toSet().size, nums.size)
    }
}
