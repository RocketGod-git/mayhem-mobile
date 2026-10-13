package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitReader
import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.DiscFilter
import com.rocketgod.mayhem.core.HdlcFramer
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sign

/** Everything heard from one station, merged across message types (newest value wins). */
data class Vessel(
    val mmsi: Int,
    /** A, B, base, AtoN or SAR: what the message types say it is. */
    var cls: String = "",
    var name: String? = null, var callsign: String? = null, var dest: String? = null, var imo: Int? = null, var vendor: String? = null,
    var shipType: Int? = null, var atonType: Int? = null, var virtualAton: Boolean = false, var navStatus: Int? = null,
    var lat: Double? = null, var lon: Double? = null, var accuracy: Boolean = false,
    /** Knots, degrees, degrees, degrees a minute (signed). */
    var sog: Double? = null, var cog: Double? = null, var hdg: Int? = null, var rot: Double? = null,
    var alt: Int? = null,
    /** To bow, stern, port and starboard, metres. */
    var dimA: Int? = null, var dimB: Int? = null, var dimC: Int? = null, var dimD: Int? = null,
    var draft: Double? = null,
    /** Month, day, hour, minute (UTC). */
    var eta: List<Int>? = null,
    var msgs: Int = 0, var firstMs: Long = 0, var lastMs: Long = 0,
)

/**
 * AIS receiver (Mayhem proc_ais + ais_packet.cpp): GMSK 9600 baud on 161.975 / 162.025 MHz from the NFM
 * discriminator, NRZI + HDLC framed and CRC-checked. Position, static and voyage, class B, SAR aircraft and aid to
 * navigation reports are merged into one record per MMSI.
 */
class AisDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true
    override val fmChannelHz: Int get() = 10_000      // 9600 baud GMSK wants the whole channel

    private var fmRate = 0
    private var sync = BitSync(9600.0, 48000.0)
    private var filt = DiscFilter(7200.0, 48000.0)
    private val framer = HdlcFramer(160) { onFrame(it) }
    private val vessels = HashMap<Int, Vessel>()
    private val _vessels = MutableStateFlow<List<Vessel>>(emptyList())
    /** Most recently heard first. */
    val table: StateFlow<List<Vessel>> = _vessels.asStateFlow()

    override fun reset(rate: Int) { fmRate = 0; framer.reset() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    fun clear() { synchronized(vessels) { vessels.clear() }; _vessels.value = emptyList() }

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) { fmRate = rate; sync = BitSync(9600.0, rate.toDouble()); filt = DiscFilter(7200.0, rate.toDouble()); framer.reset() }
        for (i in 0 until n) {
            val b = sync.push(filt.push(samples[i].toDouble()).toFloat())
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
        val line = synchronized(vessels) { digest(r, type, mmsi, dataBits, now) } ?: return
        log.add(line)
        publish(now)
    }

    private fun digest(r: BitReader, type: Int, mmsi: Int, dataBits: Int, now: Long): String? {
        val v = vessels.getOrPut(mmsi) { Vessel(mmsi, firstMs = now) }
        fun pos(lonAt: Int, latAt: Int) {
            val lon = r.readSigned(lonAt, 28) / 600000.0; val lat = r.readSigned(latAt, 27) / 600000.0
            if (abs(lon) <= 180 && abs(lat) <= 90) { v.lon = lon; v.lat = lat }
        }
        fun dims(at: Int) { v.dimA = r.read(at, 9); v.dimB = r.read(at + 9, 9); v.dimC = r.read(at + 18, 6); v.dimD = r.read(at + 24, 6) }
        fun hdg(at: Int) { val h = r.read(at, 9); v.hdg = if (h == 511) null else h }
        fun sog(at: Int, scale: Double) { val s = r.read(at, 10); v.sog = if (s == 1023) null else s / scale }
        fun cog(at: Int) { val c = r.read(at, 12); v.cog = if (c == 3600) null else c / 10.0 }
        val line = when (type) {
            1, 2, 3 -> {
                if (dataBits != 168) return null
                v.cls = "A"; v.navStatus = r.read(38, 4)
                val rot = r.readSigned(42, 8); v.rot = if (rot == -128) null else sign(rot.toDouble()) * (rot / 4.733).pow(2)
                sog(50, 10.0); v.accuracy = r.read(60, 1) == 1
                pos(61, 89); cog(116); hdg(128)
                "T$type MMSI $mmsi ${pos(v)} ${v.sog?.let { "%.1f".format(it) } ?: "?"}kn COG ${v.cog?.let { "%.0f".format(it) } ?: "?"} HDG ${v.hdg ?: "?"}"
            }
            4 -> {
                if (dataBits != 168) return null
                v.cls = "base"; pos(79, 107)
                "T4 base station MMSI $mmsi ${pos(v)}"
            }
            5 -> {
                if (dataBits != 424) return null
                v.cls = "A"; v.imo = r.read(40, 30).takeIf { it != 0 }; v.callsign = text(r, 70, 7); v.name = text(r, 112, 20); v.shipType = r.read(232, 8); dims(240)
                val month = r.read(274, 4)
                if (month != 0) v.eta = listOf(month, r.read(278, 5), r.read(283, 5), r.read(288, 6))
                val dr = r.read(294, 8); v.draft = if (dr != 0) dr / 10.0 else null; v.dest = text(r, 302, 20)
                "T5 MMSI $mmsi name '${v.name}' callsign '${v.callsign}' → '${v.dest}'"
            }
            9 -> {
                if (dataBits != 168) return null
                v.cls = "SAR"; val alt = r.read(38, 12); v.alt = if (alt == 4095) null else alt
                sog(50, 1.0); pos(61, 89); cog(116)
                "T9 SAR aircraft MMSI $mmsi ${pos(v)} ${v.alt ?: "?"} m"
            }
            18 -> {
                if (dataBits != 168) return null
                v.cls = "B"; sog(46, 10.0); v.accuracy = r.read(56, 1) == 1; pos(57, 85); cog(112); hdg(124)
                "T18 class B MMSI $mmsi ${pos(v)} ${v.sog?.let { "%.1f".format(it) } ?: "?"}kn COG ${v.cog?.let { "%.0f".format(it) } ?: "?"}"
            }
            19 -> {
                if (dataBits < 312) return null
                v.cls = "B"; sog(46, 10.0); pos(57, 85); cog(112); hdg(124)
                v.name = text(r, 143, 20); v.shipType = r.read(263, 8); dims(271)
                "T19 class B MMSI $mmsi '${v.name}' ${pos(v)}"
            }
            21 -> {
                if (dataBits < 272) return null
                v.cls = "AtoN"; v.atonType = r.read(38, 5); v.name = text(r, 43, 20); v.accuracy = r.read(163, 1) == 1; pos(164, 192); dims(219)
                v.virtualAton = r.read(269, 1) == 1
                "T21 AtoN MMSI $mmsi '${v.name}' ${pos(v)}"
            }
            24 -> {
                if (dataBits < 160) return null
                if (v.cls.isEmpty()) v.cls = "B"
                if (r.read(38, 2) == 0) { v.name = text(r, 40, 20); "T24A MMSI $mmsi name '${v.name}'" }
                else {
                    v.shipType = r.read(40, 8); v.vendor = text(r, 48, 3); v.callsign = text(r, 90, 7); if (dataBits >= 168) dims(132)
                    "T24B MMSI $mmsi callsign '${v.callsign}'"
                }
            }
            else -> "T$type MMSI $mmsi ($dataBits bits)"
        }
        v.lastMs = now; v.msgs++
        return line
    }

    private fun pos(v: Vessel): String {
        val la = v.lat; val lo = v.lon
        return if (la == null || lo == null) "no fix" else "%.4f,%.4f".format(la, lo)
    }

    /** AIS 6-bit ASCII; '@' (0) is padding. */
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
        _vessels.value = synchronized(vessels) {
            vessels.values.removeIf { now - it.lastMs > 30 * 60_000L }
            vessels.values.sortedByDescending { it.lastMs }.map { it.copy() }
        }
    }
}
