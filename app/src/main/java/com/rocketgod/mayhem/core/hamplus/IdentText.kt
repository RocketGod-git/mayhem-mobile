package com.rocketgod.mayhem.core.hamplus

import com.rocketgod.mayhem.core.hamid.ChannelContext
import com.rocketgod.mayhem.core.hamid.HamIdResolver
import com.rocketgod.mayhem.core.hamid.HamIdent
import com.rocketgod.mayhem.core.hamid.MODE_BADGE
import com.rocketgod.mayhem.core.hamid.Resolved
import com.rocketgod.mayhem.core.hamid.codeText
import com.rocketgod.mayhem.core.hamid.identWho
import com.rocketgod.mayhem.core.hamid.isDigital
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

/*
 * How Repeaters writes a transmission's identity: the same lines as the web's hamplus-ui.ts (hpIdentLine and the rest)
 * and the iOS screen, from a [HamIdent] and what the directories say about it ([HamIdResolver.resolveIdent]).
 */

/** What the directories say about a transmission's identity (null without a resolver or an identity). */
fun hpResolve(res: HamIdResolver?, id: HamIdent?, hz: Long): Resolved? = if (res != null && id != null) res.resolveIdent(id, ChannelContext(hz)) else null

/** A talker as a line names them: the callsign (with the radio ID when both are known), else the alias, else the ID. */
fun hpIdentWho(id: HamIdent, r: Resolved? = null): String {
    val call = r?.station?.callsign?.ifEmpty { null } ?: id.callsign
    if (call.isNotEmpty()) return if (id.radioId != 0 && id.radioId.toString() != call) "$call ${id.radioId}" else call
    return identWho(id)
}

/** Where a call goes: the talkgroup with its name, the radio called, or the destination the signal names. */
fun hpIdentTarget(id: HamIdent, r: Resolved? = null): String {
    if (id.mode == "DMR" || id.mode == "P25" || id.mode == "P25P2" || id.mode == "NXDN") {
        if (id.tg == 0) return ""
        if (id.group) return "TG ${id.tg}" + (r?.talkgroup?.takeIf { it.isNotEmpty() }?.let { " $it" } ?: "")
        val c = r?.called?.callsign.orEmpty()
        return "TO " + if (c.isNotEmpty()) "$c ${id.tg}" else id.tg.toString()
    }
    val d = id.dest.trim()
    return if (d.isNotEmpty() && !Regex("^(CQCQCQ|ALL|\\*+)$", RegexOption.IGNORE_CASE).matches(d)) "TO $d" else ""
}

/** A transmission's identity in one line, for the bubble, the live bar and the log (the web's hpIdentLine). */
fun hpIdentLine(id: HamIdent, r: Resolved? = null): String {
    val parts = ArrayList<String>()
    if (isDigital(id.mode)) parts.add(MODE_BADGE[id.mode] ?: id.mode)
    val who = hpIdentWho(id, r); if (who.isNotEmpty()) parts.add(who)
    val st = r?.station
    if (st != null && st.name.isNotEmpty()) parts.add(listOf(st.name, st.city, st.state).filter { it.isNotEmpty() }.joinToString(", "))
    hpIdentTarget(id, r).let { if (it.isNotEmpty()) parts.add(it) }
    if (id.mode == "DMR" && id.slot != 0) parts.add("TS ${id.slot}")
    codeText(id.mode, id.code).let { if (it.isNotEmpty()) parts.add(it) }
    if (id.repeater.isNotEmpty()) parts.add("VIA ${id.repeater}")
    if (id.network.isNotEmpty()) parts.add(id.network) else if (!r?.network.isNullOrEmpty()) parts.add(r!!.network)
    if (id.encrypted) parts.add("ENCRYPTED")
    if (id.emergency) parts.add("EMERGENCY")
    if (who.isEmpty() && id.activity == "idle") parts.add("IDLE") else if (who.isEmpty() && id.activity == "data") parts.add("DATA")
    if (id.text.isNotEmpty()) parts.add("\"${id.text}\"")
    parts.addAll(id.signaling)
    return parts.joinToString(" · ")
}

/** The mode badge and code a tile shows ("" for analog). */
fun hpModeText(t: HpTile): String = if (t.mode.isEmpty()) "" else listOf(MODE_BADGE[t.mode] ?: t.mode, codeText(t.mode, t.code)).filter { it.isNotEmpty() }.joinToString(" · ")

private fun csvCell(v: Any): String { val t = v.toString(); return if (t.contains(',') || t.contains('"') || t.contains('\n') || t.contains('\r')) "\"" + t.replace("\"", "\"\"") + "\"" else t }
private fun toneText(tone: Double, dcs: Int): String = if (tone > 0) "PL %.1f".format(Locale.US, tone) else if (dcs > 0) "DCS ${dcs.toString().padStart(3, '0')}" else ""

/** The log as CSV, oldest first, one row a transmission: the same columns as the web's hpExportCsv. */
fun hpExportCsv(s: HpSnap?, res: HamIdResolver? = null): String {
    val head = listOf("time", "mhz", "seconds", "mode", "callsign", "radio_id", "alias", "name", "place", "talkgroup", "talkgroup_name", "called", "slot", "code", "repeater", "network", "encrypted", "emergency", "tone", "offset_hz", "cw_id", "signaling", "station")
    val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    val rows = s?.rows.orEmpty().filter { !it.live }.sortedBy { it.startMs }.map { r ->
        val id = r.ident; val rr = hpResolve(res, id, r.hz); val st = rr?.station
        val digital = id != null && isDigital(id.mode)
        listOf(iso.format(Date(r.startMs.toLong())), "%.5f".format(Locale.US, r.hz / 1e6), "%.1f".format(Locale.US, (r.endMs - r.startMs) / 1000), if (digital) id!!.mode else "FM",
            st?.callsign?.ifEmpty { null } ?: id?.callsign.orEmpty(), if (id != null && id.radioId != 0) id.radioId else "", id?.alias.orEmpty(), st?.name.orEmpty(),
            listOf(st?.city.orEmpty(), st?.state.orEmpty(), st?.country.orEmpty()).filter { it.isNotEmpty() }.joinToString(", "),
            if (id != null && id.group && id.tg != 0) id.tg else "", rr?.talkgroup?.ifEmpty { null } ?: if (id != null && !id.group) "" else id?.dest.orEmpty(),
            if (id != null && !id.group) (rr?.called?.callsign?.ifEmpty { null } ?: if (id.tg != 0) id.tg.toString() else id.dest) else "",
            if (id != null && id.slot != 0) id.slot else "", if (id != null) codeText(id.mode, id.code).substringAfter(' ', "") else "",
            id?.repeater?.ifEmpty { null } ?: rr?.listed.orEmpty(), id?.network?.ifEmpty { null } ?: rr?.network.orEmpty(),
            if (id?.encrypted == true) "yes" else "", if (id?.emergency == true) "yes" else "", toneText(r.tone, r.dcs),
            if (r.offsetHz.isFinite()) r.offsetHz.roundToInt() else "", cwCallsign(r.cw), id?.signaling.orEmpty().joinToString("; "), r.stationLabel,
        ).joinToString(",") { csvCell(it) }
    }
    return (listOf(head.joinToString(",")) + rows).joinToString("\n") + "\n"
}
