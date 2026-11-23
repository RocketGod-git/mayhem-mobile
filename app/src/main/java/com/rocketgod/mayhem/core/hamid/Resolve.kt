package com.rocketgod.mayhem.core.hamid

/**
 * A channel's identity snapshot turned into what HAM+ shows: the station, the talkgroup or the radio called, the
 * repeater (as the signal names it, and as a directory lists it at this frequency with its site and network) and the
 * position. Callsigns heard that no offline table knows are queued in [wanted]. The same as the web's
 * dsp/hamid/resolve.ts.
 */
class Station {
    var callsign = ""; var radioId = 0; var alias = ""; var name = ""; var city = ""; var state = ""; var country = ""; var source = ""
}
class Resolved(val mode: String) {
    var station: Station? = null
    var talkgroup = ""; var tgId = 0; var group = true; var called: Station? = null
    var repeater = ""; var listed = ""; var repeaterSite = ""; var network = ""
    var dgid = -1; var colorCode = -1; var slot = 0
    var position: Position? = null
}
class ChannelContext(val hz: Long, val tone: String? = null, val cwId: String? = null, val lat: Double? = null, val lon: Double? = null)

class HamIdResolver(seedPapa: Boolean = true) {
    var users: RadioIdTable? = null
    /** radioid.net's NXDN ID list (the same columns as the DMR list; IDs of 16 bits). */
    var nxdnUsers: RadioIdTable? = null
    val talkgroups = TalkgroupTable()
    val repeaters = RepeaterDirectory()
    val calls = HashMap<String, CallRecord>()
    val wanted = LinkedHashSet<String>()

    init { if (seedPapa) { repeaters.add(parsePapaCsv(PAPA_ANALOG_CSV, "analog")); repeaters.add(parsePapaCsv(PAPA_DMR_CSV, "dmr")) } }
    fun addCall(r: CallRecord) { calls[r.callsign] = r; wanted.remove(r.callsign) }

    private fun fromUser(st: Station, u: RadioIdUser) {
        if (st.callsign.isEmpty()) st.callsign = u.callsign
        if (st.radioId == 0) st.radioId = u.id
        st.name = u.name; st.city = u.city; st.state = u.state; st.country = u.country; st.source = "radioid.net"
    }
    private fun fill(st: Station) {
        val us = users
        if (st.radioId != 0 && us != null) { us.byId(st.radioId)?.let { fromUser(st, it); return } }
        val key = lookupKey(st.callsign)
        if (key.isEmpty()) return
        calls[key]?.let { st.name = it.name; st.city = it.city; st.state = it.state; if (st.country.isEmpty()) st.country = "United States"; st.source = it.source; return }
        if (us != null) { us.byCallsign(key)?.let { val id = st.radioId; fromUser(st, it); st.radioId = id; return } }
        wanted.add(key)
    }

    /**
     * A P25 or NXDN unit ID as a station: P25 hams mostly key up with their DMR ID (seven digits, radioid.net's list),
     * NXDN hams with an NXDN ID from radioid.net's NXDN list. Other IDs stay numbers.
     */
    private fun unit(id: Int, nxdn: Boolean): Station {
        val st = Station(); st.radioId = id
        val u = if (nxdn) nxdnUsers?.byId(id) else if (id in 1_000_000..9_999_999) users?.byId(id) else null
        if (u != null) { fromUser(st, u); if (nxdn) st.source = "radioid.net NXDN" }
        return st
    }

    fun resolve(snap: HamIdSnap, ctx: ChannelContext): Resolved {
        val out = Resolved(snap.mode); out.position = snap.position
        var rep: Repeater? = null
        if (snap.mode == "DMR" && snap.dmrSlots != null) {
            out.colorCode = snap.dmrCc
            rep = repeaters.at(ctx.hz, cc = snap.dmrCc, mode = "DMR", lat = ctx.lat, lon = ctx.lon).firstOrNull()
            val live = snap.dmrSlots.filter { it.src > 0 }.maxByOrNull { it.lastSym }
            if (live != null) {
                out.slot = live.slot
                val st = Station(); st.radioId = live.src; st.alias = live.alias
                val aliasCall = lookupKey(live.alias); if (aliasCall.isNotEmpty()) st.callsign = aliasCall
                fill(st); out.station = st
                out.group = live.group; out.tgId = live.tg
                if (live.group) out.talkgroup = talkgroups.lookup(live.tg, rep?.network ?: "")?.name ?: ""
                else { val c = Station(); c.radioId = live.tg; fill(c); out.called = c }
                out.position = live.position
            }
        } else if (snap.mode == "D-STAR" && snap.dstar?.header != null) {
            val h = snap.dstar.header!!; val st = Station(); st.callsign = h.my; st.alias = h.suffix; fill(st); out.station = st
            out.talkgroup = h.ur; out.repeater = snap.repeater
        } else if (snap.mode == "YSF" && snap.ysf != null) {
            val st = Station(); st.callsign = snap.ysf.src; fill(st); out.station = st
            out.talkgroup = snap.ysf.dest; out.dgid = snap.ysf.dgid; out.repeater = snap.ysf.down
        } else if (snap.mode == "P25" && snap.p25 != null && snap.p25.src != 0) {
            val p = snap.p25; out.station = unit(p.src, false); out.group = p.group; out.tgId = p.tg
            if (!p.group) out.called = unit(p.tg, false)
            out.colorCode = p.nac
        } else if (snap.mode == "P25P2" && snap.p25p2 != null) {
            val live = snap.p25p2.slots.filter { it.src > 0 }.maxByOrNull { it.lastSym }
            if (live != null) { out.slot = live.lch + 1; out.station = unit(live.src, false); out.group = live.group; out.tgId = live.tg; if (!live.group) out.called = unit(live.tg, false) }
        } else if (snap.mode == "NXDN" && snap.nxdn != null && snap.nxdn.src != 0) {
            val x = snap.nxdn
            out.station = if (x.typeD) Station().also { it.radioId = x.src; it.alias = "${x.src shr 11}-${x.src and 0x7ff}" } else unit(x.src, true)
            out.group = x.group; out.tgId = x.dst; if (!x.group && !x.typeD) out.called = unit(x.dst, true)
            out.colorCode = x.ran
        } else if (snap.mode == "dPMR" && snap.dpmr != null && snap.dpmr.own >= 0) {
            val d = snap.dpmr; val st = Station(); st.radioId = d.own; st.alias = d.ownText; out.station = st
            out.group = d.group; out.tgId = d.called; out.talkgroup = d.calledText; out.colorCode = d.cc
        }
        if (rep == null && snap.mode != "DMR") rep = repeaters.at(ctx.hz, tone = ctx.tone, mode = if (snap.mode == "analog" || snap.mode.isEmpty()) "FM" else snap.mode, lat = ctx.lat, lon = ctx.lon).firstOrNull()
        if (out.repeater.isEmpty() && !ctx.cwId.isNullOrEmpty()) out.repeater = ctx.cwId
        if (rep != null) { out.listed = rep.name.ifEmpty { rep.call }; out.repeaterSite = rep.site.ifEmpty { rep.city }; out.network = rep.network }
        return out
    }
}
