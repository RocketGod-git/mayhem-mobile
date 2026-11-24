package com.rocketgod.mayhem.core.hamid

/**
 * One transmission's identity in a few fields, for Repeaters: the mode, who is talking (the callsign the signal
 * carries, the radio ID, a talker alias), to whom (talkgroup, called radio, destination), through what (the repeater
 * and the network the signal names, the color code, NAC, RAN or DG-ID), and what else was heard (encryption, an
 * emergency, a message, a position, analog signaling). The directories (Resolve.kt) put names to the IDs. The same as
 * the web's dsp/hamid/ident.ts.
 */
data class HamIdent(
    /** "DMR", "D-STAR", "YSF", "P25", "P25P2", "NXDN", "dPMR", "M17", or "analog" for analog signaling alone. */
    val mode: String,
    var callsign: String = "", var radioId: Int = 0, var alias: String = "",
    var tg: Int = 0, var group: Boolean = true,
    var dest: String = "", var repeater: String = "", var network: String = "",
    var code: Int = -1, var slot: Int = 0,
    var encrypted: Boolean = false, var emergency: Boolean = false,
    /** "voice", "data", "idle" or "". */
    var activity: String = "",
    var text: String = "", var position: Position? = null,
    var signaling: List<String> = emptyList(),
)

val DIGITAL_MODES = listOf("DMR", "D-STAR", "YSF", "P25", "P25P2", "NXDN", "dPMR", "M17")
fun isDigital(mode: String) = mode in DIGITAL_MODES
/** How a mode is badged on screen. */
val MODE_BADGE = mapOf("DMR" to "DMR", "D-STAR" to "D-STAR", "YSF" to "FUSION", "P25" to "P25", "P25P2" to "P25 II", "NXDN" to "NXDN", "dPMR" to "DPMR", "M17" to "M17")
/** What a mode calls its [HamIdent.code]. */
val CODE_NAME = mapOf("DMR" to "CC", "P25" to "NAC", "P25P2" to "NAC", "NXDN" to "RAN", "dPMR" to "CC", "YSF" to "DG-ID")
fun codeText(mode: String, code: Int): String {
    val n = CODE_NAME[mode] ?: return ""
    if (code < 0) return ""
    return "$n " + if (mode == "P25" || mode == "P25P2") code.toString(16).uppercase().padStart(3, '0') else code.toString()
}

/** Analog signaling lines of the transmissions an analog decoder read, without what Repeaters already shows (CW ID, PL, DCS, tail). */
fun signalingLines(txs: List<AnalogTx>, dtmf: String): List<String> {
    val out = ArrayList<String>()
    for (tx in txs) for (l in analogSummary(tx)) {
        if (l.startsWith("CW ID") || l.startsWith("PL ") || l.startsWith("DCS ") || l.startsWith("Tail ")) continue
        if (l !in out) out.add(l)
    }
    if (dtmf.isNotEmpty()) out.add("DTMF $dtmf")
    return out
}

/** The identity of what a channel carried, from its snapshot; null when it names nothing (plain analog voice). */
fun identOf(s: HamIdSnap): HamIdent? {
    val sig = signalingLines(s.analog?.txs ?: emptyList(), s.dtmf)
    if (!isDigital(s.mode) || !s.verified) {
        if (sig.isEmpty()) return null
        val id = HamIdent("analog", signaling = sig)
        val tx = (s.analog?.txs ?: emptyList()).firstOrNull { it.mdc.isNotEmpty() || it.fleetsync.isNotEmpty() }
        if (tx != null && tx.mdc.isNotEmpty()) { id.alias = "MDC ${tx.mdc[0].unit}"; id.emergency = tx.mdc.any { it.emergency } }
        else if (tx != null) { val f = tx.fleetsync[0]; id.alias = "FleetSync ${if (f.fromFleet < 0) "all" else f.fromFleet}-${if (f.fromUnit < 0) "all" else f.fromUnit}" }
        return id
    }
    val id = HamIdent(s.mode, signaling = sig, position = s.position)
    when (s.mode) {
        "DMR" -> {
            id.code = s.dmrCc
            val slots = s.dmrSlots ?: emptyList()
            val act = slots.map { it.activity }
            id.activity = if ("voice" in act) "voice" else if ("data" in act) "data" else if ("idle" in act) "idle" else ""
            val live = slots.filter { it.src > 0 }.maxByOrNull { it.lastSym }
            if (live != null) {
                id.slot = live.slot; id.radioId = live.src; id.alias = live.alias; id.tg = live.tg; id.group = live.group
                id.encrypted = live.privacy; id.emergency = live.emergency; id.position = live.position ?: id.position
                id.callsign = lookupKey(live.alias)
                if (live.activity.isNotEmpty()) id.activity = live.activity
            }
        }
        "D-STAR" -> {
            val h = s.dstar?.header ?: s.dd?.header
            if (h != null) {
                id.callsign = h.my.trim(); id.alias = h.suffix.trim(); id.dest = h.ur.trim()
                // RPT2 ending in G is the gateway: the call goes out to the Internet (a reflector or another repeater)
                if (h.rpt2.trimEnd().endsWith("G")) id.network = s.urcall?.let { u -> if (u.kind == "link" && u.target.isNotEmpty()) "${u.target}${if (u.module.isNotEmpty()) " " + u.module else ""}".trim() else null } ?: "D-STAR gateway"
            }
            id.repeater = s.repeater; id.text = s.dstar?.message?.trim() ?: ""
            id.activity = "voice"
        }
        "YSF" -> {
            val y = s.ysf
            if (y != null) {
                id.callsign = y.src.trim(); id.dest = y.dest.trim(); id.repeater = y.down.trim(); id.code = y.dgid
                s.internet?.let { (node, nid) -> id.network = "WIRES-X $node${if (nid.isNotEmpty()) " $nid" else ""}".trim() }
                y.wires?.let { w -> if (w.room.isNotEmpty()) id.network = "WIRES-X ${w.room}"; id.text = w.name.ifEmpty { w.description } }
                id.activity = "voice"
            }
        }
        "P25" -> s.p25?.let { p ->
            id.code = p.nac; id.radioId = p.src; id.tg = p.tg; id.group = p.group; id.encrypted = p.encrypted; id.emergency = p.emergency
            id.activity = if (p.voiceFrames > 0 || p.encrypted) "voice" else "data"
        }
        "P25P2" -> s.p25p2?.let { p ->
            id.code = p.nac
            val live = p.slots.filter { it.src > 0 }.maxByOrNull { it.lastSym }
            if (live != null) { id.slot = live.lch + 1; id.radioId = live.src; id.tg = live.tg; id.group = live.group; id.encrypted = live.encrypted; id.emergency = live.emergency; id.activity = live.activity.ifEmpty { "voice" } }
        }
        "NXDN" -> s.nxdn?.let { x ->
            id.code = x.ran; id.radioId = x.src; id.tg = x.dst; id.group = x.group; id.encrypted = x.cipher > 0; id.emergency = x.emergency
            if (x.typeD) id.alias = "${x.src shr 11}-${x.src and 0x7ff}"
            id.activity = x.activity.ifEmpty { if (x.voiceFrames > 0) "voice" else "" }
        }
        "dPMR" -> s.dpmr?.let { x ->
            id.code = x.cc; id.radioId = if (x.own >= 0) x.own else 0; id.alias = x.ownText; id.dest = x.calledText; id.group = x.group
            id.activity = x.activity.ifEmpty { if (x.voiceFrames > 0) "voice" else "" }
        }
        "M17" -> s.m17?.let { m ->
            id.callsign = m.originator.ifEmpty { m.src }.trim(); id.dest = m.dst.trim(); id.code = m.can
            id.repeater = s.repeater; id.network = if (m.reflector.isNotEmpty()) m.reflector + if (m.module.isNotEmpty()) " " + m.module else "" else ""
            id.encrypted = m.encryption.isNotEmpty(); id.text = m.text.ifEmpty { m.packetText }
            id.activity = if (m.kind.startsWith("voice")) "voice" else if (m.kind.isNotEmpty()) "data" else ""
        }
    }
    return id
}

/** Who is talking, as the signal says it: the callsign, else the alias, else the radio ID; "" when unknown. */
fun identWho(id: HamIdent): String = id.callsign.ifEmpty { id.alias.ifEmpty { if (id.radioId != 0) id.radioId.toString() else "" } }
