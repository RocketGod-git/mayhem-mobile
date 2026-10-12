package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitReader
import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.HdlcFramer
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * AIS receiver (Mayhem proc_ais + ais_packet.cpp): GMSK 9600 baud on 161.975 / 162.025 MHz, taken from the NFM
 * discriminator, NRZI + HDLC framed, CRC-checked, then message types 1/2/3/4/18/21 (positions), 5/24 (names)
 * decoded. Keeps a vessel table keyed by MMSI.
 */
class AisDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true

    private class Vessel(val mmsi: Int) {
        var name: String? = null; var callsign: String? = null; var dest: String? = null
        var lat: Double? = null; var lon: Double? = null; var sog: Double? = null; var cog: Double? = null
        var type = 0; var lastMs = 0L
    }

    private var fmRate = 0
    private var sync = BitSync(9600.0, 48000.0)
    private val framer = HdlcFramer(160) { onFrame(it) }
    private val vessels = HashMap<Int, Vessel>()
    private val _table = MutableStateFlow<List<String>>(emptyList())
    /** One line per vessel, most recently heard first. */
    val table: StateFlow<List<String>> = _table.asStateFlow()

    override fun reset(rate: Int) { fmRate = 0; framer.reset() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) { fmRate = rate; sync = BitSync(9600.0, rate.toDouble()); framer.reset() }
        for (i in 0 until n) {
            val b = sync.push(samples[i])
            if (b >= 0) framer.pushRaw(b)
        }
    }

    private fun onFrame(f: ByteArray) {
        if (f.size < 5 || !HdlcFramer.fcsOk(f)) return
        val r = BitReader(f)
        val dataBits = (f.size - 2) * 8
        val type = r.read(0, 6)
        val mmsi = r.read(8, 30)
        val now = System.currentTimeMillis()
        val v = vessels.getOrPut(mmsi) { Vessel(mmsi) }
        v.lastMs = now
        val line: String = when (type) {
            1, 2, 3 -> {
                if (dataBits != 168) return
                v.type = type
                v.sog = r.read(50, 10) / 10.0
                v.lon = r.readSigned(61, 28) / 600000.0
                v.lat = r.readSigned(89, 27) / 600000.0
                v.cog = r.read(116, 12) / 10.0
                val hdg = r.read(128, 9)
                "T$type MMSI $mmsi ${pos(v)} ${"%.1f".format(v.sog)}kn COG ${"%.0f".format(v.cog)} HDG $hdg"
            }
            4 -> {
                if (dataBits != 168) return
                v.lon = r.readSigned(79, 28) / 600000.0
                v.lat = r.readSigned(107, 27) / 600000.0
                "T4 base station MMSI $mmsi ${pos(v)}"
            }
            5 -> {
                if (dataBits != 424) return
                v.callsign = text(r, 70, 7)
                v.name = text(r, 112, 20)
                v.dest = text(r, 302, 20)
                "T5 MMSI $mmsi name '${v.name}' callsign '${v.callsign}' → '${v.dest}'"
            }
            18 -> {
                if (dataBits != 168) return
                v.type = 18
                v.sog = r.read(46, 10) / 10.0
                v.lon = r.readSigned(57, 28) / 600000.0
                v.lat = r.readSigned(85, 27) / 600000.0
                v.cog = r.read(112, 12) / 10.0
                "T18 class B MMSI $mmsi ${pos(v)} ${"%.1f".format(v.sog)}kn COG ${"%.0f".format(v.cog)}"
            }
            21 -> {
                if (dataBits < 272) return
                v.name = text(r, 43, 20)
                v.lon = r.readSigned(164, 28) / 600000.0
                v.lat = r.readSigned(192, 27) / 600000.0
                "T21 AtoN MMSI $mmsi '${v.name}' ${pos(v)}"
            }
            24 -> {
                if (dataBits < 160) return
                val part = r.read(38, 2)
                if (part == 0) { v.name = text(r, 40, 20); "T24A MMSI $mmsi name '${v.name}'" }
                else { v.callsign = text(r, 90, 7); "T24B MMSI $mmsi callsign '${v.callsign}'" }
            }
            else -> "T$type MMSI $mmsi (${dataBits} bits)"
        }
        log.add(line)
        publish(now)
    }

    private fun pos(v: Vessel): String {
        val la = v.lat; val lo = v.lon
        if (la == null || lo == null || la > 90.0 || lo > 180.0) return "no fix"
        return "%.4f,%.4f".format(la, lo)
    }

    /** AIS 6-bit ASCII. '@' (0) is padding. */
    private fun text(r: BitReader, start: Int, chars: Int): String {
        val sb = StringBuilder()
        for (i in 0 until chars) {
            val c = r.read(start + i * 6, 6)
            val ch = (if (c < 32) c + 64 else c).toChar()
            if (ch == '@') break
            sb.append(ch)
        }
        return sb.toString().trim()
    }

    private fun publish(now: Long) {
        val it = vessels.values.iterator()
        while (it.hasNext()) if (now - it.next().lastMs > 30 * 60_000L) it.remove()
        _table.value = vessels.values.sortedByDescending { it.lastMs }.map { v ->
            val sog = v.sog?.let { "%.1fkn".format(it) } ?: ""
            "${v.mmsi} ${v.name ?: ""} ${pos(v)} $sog".trim()
        }
    }
}
