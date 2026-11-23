package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.fleet.Codes
import com.rocketgod.mayhem.core.fleet.DmrEvent
import com.rocketgod.mayhem.core.fleet.DmrFramer
import com.rocketgod.mayhem.core.fleet.EmbLc
import com.rocketgod.mayhem.core.fleet.EmbLcAssembler
import com.rocketgod.mayhem.core.fleet.TalkerAlias
import com.rocketgod.mayhem.core.fleet.embBits
import com.rocketgod.mayhem.core.fleet.parseEmbLc
import com.rocketgod.mayhem.core.fleet.readEmb
import com.rocketgod.mayhem.core.fleet.rs129Ok
import kotlin.math.abs

/**
 * Who is on a DMR channel (ETSI TS 102 361-1 and -2), built on Fleet's DMR layers: per time slot the color code,
 * group or private call, talkgroup or called radio, the calling radio's ID, its talker alias, and its position from
 * the GPS Info LC (FLCO 8) or NMEA sentences in rate 1/2 packet data. The same as the web's dsp/hamid/dmrid.ts.
 */
class DmrSlotId(val slot: Int) {
    var cc = -1; var group = true; var tg = 0; var src = 0; var alias = ""
    var emergency = false; var privacy = false; var position: Position? = null; var posError = -1
    var activity = ""; var calls = 0; var lastSym = -1L
    fun copy(): DmrSlotId = DmrSlotId(slot).also { it.cc = cc; it.group = group; it.tg = tg; it.src = src; it.alias = alias; it.emergency = emergency; it.privacy = privacy; it.position = position; it.posError = posError; it.activity = activity; it.calls = calls; it.lastSym = lastSym }
}

class GpsLc(val pos: Position, val err: Int)
/** The GPS Info LC's position (FLCO 8), or null when it is not one or holds no position. */
fun gpsInfoLc(b: IntArray): GpsLc? {
    if ((b[0] and 0x3f) != 8 || b[1] != 0) return null
    val err = (b[2] shr 1) and 7
    var lon = ((b[2] and 1) shl 24) or (b[3] shl 16) or (b[4] shl 8) or b[5]
    var lat = (b[6] shl 16) or (b[7] shl 8) or b[8]
    if ((lon and 0x1000000) != 0) lon -= 0x2000000
    if ((lat and 0x800000) != 0) lat -= 0x1000000
    val pos = Position(lat * 180.0 / 16777216, lon * 360.0 / 33554432, "dmr-gps-lc")
    if (abs(pos.lat) > 90 || abs(pos.lon) > 180 || (lat == 0 && lon == 0)) return null
    return GpsLc(pos, err)
}

private val NMEA_RE = Regex("\\$[A-Z]{2}[A-Z]{3},[^$\\n]*\\*[0-9A-F]{2}")
/** NMEA sentences with good checksums anywhere in a byte payload; the last one with a position. */
fun nmeaInPayload(b: IntArray): Position? {
    val sb = StringBuilder(); for (v in b) { val c = v and 255; sb.append(if (c in 32..126) c.toChar() else '\n') }
    var found: Position? = null
    for (m in NMEA_RE.findAll(sb)) { val p = parseNmea(m.value); if (p != null) { p.source = "dmr-data"; found = p } }
    return found
}

class DmrIdentity {
    private class Pending(val blocks: Int, val confirmed: Boolean) { val got = ArrayList<IntArray>() }
    val framer = DmrFramer()
    val slots = arrayOf(DmrSlotId(1), DmrSlotId(2))
    private val emb = arrayOf(EmbLcAssembler(), EmbLcAssembler())
    private val alias = arrayOf(TalkerAlias(), TalkerAlias())
    private val pending = arrayOfNulls<Pending>(2)
    private var t = 0L
    var checked = 0
    /** Data bursts whose slot type came through Golay without a correction (an idle repeater sends only these). */
    var clean = 0
    private val ccVotes = IntArray(16)

    init {
        framer.onBurst = { burst(it) }
        framer.onVoice = { slot, d, n -> voice(slot, d, n) }
    }
    val cc: Int get() { var b = -1; var v = 0; for (i in 0 until 16) if (ccVotes[i] > v) { v = ccVotes[i]; b = i }; return b }

    fun reset() {
        slots[0] = DmrSlotId(1); slots[1] = DmrSlotId(2)
        for (e in emb) e.reset(); for (a in alias) a.reset()
        pending[0] = null; pending[1] = null; t = 0; checked = 0; clean = 0; ccVotes.fill(0)
    }

    fun pushSymbol(s: Double) { t++; framer.push(s.toFloat()) }

    private fun burst(e: DmrEvent) {
        val b = e.burst; val k = b.slot and 1; val ts = slots[k]
        if (b.stErrs > 2) return
        if (b.stErrs == 0) {
            ccVotes[b.cc]++; clean++; ts.cc = b.cc
            if (b.dt == 9 && ts.activity.isEmpty()) ts.activity = "idle"
        }
        val y = b.bytes
        when (b.dt) {
            1, 2 -> {
                if (!rs129Ok(y, b.dt)) return
                checked++; ts.cc = b.cc; ts.lastSym = t
                lc(k, y, b.dt == 1)
                if (b.dt == 2) ts.activity = ""
            }
            6 -> {
                if (!Codes.crc12Ok(y, 0xcccc)) return
                checked++; ts.cc = b.cc; ts.lastSym = t
                val dpf = y[0] and 15
                val src = (y[5] shl 16) or (y[6] shl 8) or y[7]; val dst = (y[2] shl 16) or (y[3] shl 8) or y[4]
                ts.activity = "data"
                if (dpf == 2 || dpf == 3) pending[k] = Pending(y[8] and 0x7f, dpf == 3)
                if (src != 0 && src != ts.src) { ts.src = src; ts.alias = ""; alias[k].reset() }
                ts.tg = dst; ts.group = (y[0] and 0x80) != 0
            }
            7 -> {
                val p = pending[k] ?: return
                p.got.add(y)
                if (p.got.size >= p.blocks) {
                    pending[k] = null
                    val parts = ArrayList<Int>()
                    for (g in p.got) for (i in (if (p.confirmed) 2 else 0) until 12) parts.add(g[i])
                    val pos = nmeaInPayload(parts.subList(0, maxOf(0, parts.size - 4)).toIntArray())
                    if (pos != null) { ts.position = pos; ts.posError = -1 }
                }
            }
        }
    }

    private fun voice(slot: Int, d: IntArray, n: Int) {
        val k = slot and 1; val ts = slots[k]
        if (n < 1 || n > 4) return
        val e = readEmb(d)
        if (!e.ok) return
        // a voice sync alone can be chance: the slot is in a call once its embedded signaling checks
        if (ts.activity != "voice") { ts.activity = "voice"; ts.calls++ }
        ts.lastSym = t
        ts.cc = e.cc; ts.privacy = e.pi
        val l = emb[k].push(e.lcss, embBits(d))
        if (l != null) { checked++; lc(k, l, false) }
    }

    private fun lc(k: Int, b: IntArray, header: Boolean) {
        val ts = slots[k]
        val g = gpsInfoLc(b)
        if (g != null) { ts.position = g.pos; ts.posError = g.err; return }
        when (val e = parseEmbLc(b.copyOf(9))) {
            is EmbLc.Voice -> {
                if (e.lc.src != ts.src) { ts.alias = ""; alias[k].reset(); if (ts.position != null && ts.position?.source != "dmr-data") { ts.position = null; ts.posError = -1 } }
                ts.tg = e.lc.dst; ts.src = e.lc.src; ts.group = e.lc.group; ts.emergency = e.lc.emergency; ts.privacy = e.lc.privacy
                if (header && ts.activity != "voice") { ts.activity = "voice"; ts.calls++ }
            }
            is EmbLc.Alias -> { val name = alias[k].push(e.part, e.bytes); if (name.isNotEmpty()) ts.alias = name }
            null -> {}
        }
    }
}
