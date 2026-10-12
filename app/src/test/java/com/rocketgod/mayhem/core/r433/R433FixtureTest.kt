package com.rocketgod.mayhem.core.r433

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max

/** Decoders that carry state between calls, so a lone captured frame cannot be replayed blind. */
private val STATEFUL = setOf(164, 178)

/**
 * Every protocol against the web app's own decodes: each fixture is a bit buffer exactly as a decoder received it
 * while web/test ran, with what that decoder emitted. The Kotlin decoder must produce the same readings, field
 * for field, and reject what the web one rejected.
 */
class R433FixtureTest {
    private fun same(a: Any?, b: Any?): Boolean = when {
        a is Number && b is Number -> { val x = a.toDouble(); val y = b.toDouble(); x == y || abs(x - y) <= 1e-9 * max(abs(x), abs(y)) }
        a is Boolean && b is Number -> (if (a) 1.0 else 0.0) == b.toDouble()
        a is Number && b is Boolean -> same(b, a)
        a is JSONArray -> {
            val list = when (b) { is IntArray -> b.toList(); is List<*> -> b; is DoubleArray -> b.toList(); is LongArray -> b.toList(); else -> null }
            list != null && list.size == a.length() && (0 until a.length()).all { same(a.get(it), list[it]) }
        }
        a is JSONObject -> b is Map<*, *> && a.length() == b.size && a.keys().asSequence().all { same(a.get(it), b[it]) }
        a == JSONObject.NULL -> b == null
        else -> a.toString() == b.toString()
    }

    private fun matches(want: JSONObject, got: R433Data): Boolean {
        val keys = want.keySet()
        if (keys != got.keys) return false
        return keys.all { same(want.get(it), got[it]) }
    }

    @Test
    fun decodersMatchTheWebApp() {
        val text = javaClass.classLoader!!.getResource("r433-fixtures.json").readText()
        val fixtures = JSONArray(text)
        val byNum = R433Registry.all.associateBy { it.num }
        val failures = LinkedHashMap<String, MutableList<String>>()
        var run = 0; var skipped = 0
        for (i in 0 until fixtures.length()) {
            val f = fixtures.getJSONObject(i)
            val dev = byNum[f.getInt("num")]
            // Security+ pairs two halves across calls, and the capture holds only the completing half; SecplusTest covers it.
            if (dev == null || dev.num in STATEFUL) { skipped++; continue }
            run++
            val bits = BitBuffer()
            val rows = f.getJSONArray("rows")
            for (r in 0 until rows.length()) {
                val row = rows.getJSONObject(r)
                if (r > 0) bits.addRow()
                val hex = row.getString("hex"); val n = row.getInt("n")
                for (k in 0 until n) bits.addBit((hex.substring((k / 8) * 2, (k / 8) * 2 + 2).toInt(16) shr (7 - k % 8)) and 1)
                if (n == 0 && bits.numRows == 0) bits.setWidth(0)
                bits.syncsBeforeRow[bits.numRows - 1] = row.optInt("s")
            }
            if (rows.length() == 0) bits.clear()
            val got = ArrayList<R433Data>()
            val ret = try { dev.decode(dev, bits, DecodeCtx { got.add(it) }) } catch (e: Throwable) { -99 }
            val want = f.getJSONArray("out")
            val wantRet = f.getInt("ret")
            val ok = got.size == want.length() && (0 until want.length()).all { matches(want.getJSONObject(it), got[it]) } &&
                (ret > 0) == (wantRet > 0)
            if (!ok) failures.getOrPut("${dev.num} ${dev.name}") { mutableListOf() }.add(
                "rows=${rows} ret=$ret want=$wantRet got=$got want=$want")
        }
        val report = StringBuilder("ran $run fixtures, skipped $skipped (protocol not ported)\n")
        for ((k, v) in failures) report.append("FAIL $k (${v.size})\n  ${v.first().take(1500)}\n")
        println(report)
        assertTrue(report.toString(), failures.isEmpty())
    }
}
