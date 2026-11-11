// ProtoPirate car-key decoders, checked against the original C. The golden fixtures in resources/pirate/<slug>.txt
// come from the ppharness tool, which compiles ProtoPirate's C protocol files natively and records, for pulse trains
// that make each C decoder fire, exactly what its get_string printed on every callback. A Kotlin port passes when it
// prints the same lines, in the same order, on the same pulses.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test

/** One train of a golden fixture: its label, the C decoder's output lines, the pulses. */
class PPFixtureTrain(val label: String) {
    val expected = mutableListOf<String>()
    val levels = mutableListOf<Boolean>()
    val durations = mutableListOf<Int>()
}

object PPFixture {
    /**
     * Reads resources/pirate/<slug>.txt. Format: "# train <label>" starts a train, "= <text>" is one expected C
     * callback line, "<level> <us>" is one pulse; other "#" lines are comments.
     */
    fun load(slug: String): List<PPFixtureTrain> {
        val stream = PPFixture::class.java.classLoader!!.getResourceAsStream("pirate/$slug.txt")
        assertNotNull("missing fixture resources/pirate/$slug.txt", stream)
        val trains = mutableListOf<PPFixtureTrain>()
        stream!!.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (raw in lines) {
                val line = raw.trimEnd('\r')
                if (line.isEmpty()) continue
                if (line.startsWith("# train")) trains.add(PPFixtureTrain(line.substring(7).trim()))
                else if (line.startsWith("#") || trains.isEmpty()) continue
                else if (line.startsWith("= ")) trains.last().expected.add(line.substring(2))
                else {
                    val f = line.split(" ")
                    val l = f.getOrNull(0)?.toIntOrNull(); val d = f.getOrNull(1)?.toIntOrNull()
                    if (f.size == 2 && l != null && d != null) { trains.last().levels.add(l != 0); trains.last().durations.add(d) }
                }
            }
        }
        return trains
    }

    /** Runs every train through a fresh decoder from [make] and asserts its cString lines equal the C output. */
    fun check(slug: String, make: () -> PPDecoder) {
        val trains = load(slug)
        assertFalse("no trains in $slug.txt", trains.isEmpty())
        for ((i, t) in trains.withIndex()) {
            val dec = make()
            val got = mutableListOf<String>()
            dec.onHit = { got.add(dec.cString(it)) }
            for (j in t.levels.indices) dec.feed(t.levels[j], t.durations[j])
            assertEquals("$slug train $i (${t.label})", t.expected, got)
        }
    }
}

class PirateTests {
    @Test fun kiaV2() = PPFixture.check("kia_v2") { PPKiaV2() }
}
