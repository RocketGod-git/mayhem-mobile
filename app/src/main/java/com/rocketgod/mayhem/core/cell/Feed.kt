package com.rocketgod.mayhem.core.cell

import org.json.JSONObject
import java.util.Locale

/*
 * The message feed: one readable line per decoded MIB and SIB, with repeats folded. A message heard again unchanged
 * bumps the count and last-heard time of its row; a changed value starts a new row marked as a change. Fields that
 * move on every transmission (the hyper SFN, the CDMA2000 system time) do not count as changes.
 */
data class FeedRow(
    val id: Int, val cell: String, val hz: Long, val pci: Int, var op: String, val band: Int?,
    val name: String, val slot: String, var text: String, val alert: Boolean, val change: Boolean, val firstMs: Long, var lastMs: Long, var count: Int, val fp: String,
)

private val BW_MHZ = mapOf(6 to "1.4", 15 to "3", 25 to "5", 50 to "10", 75 to "15", 100 to "20")
private fun bwName(s: String): String = BW_MHZ[s.removePrefix("n").toIntOrNull()]?.let { "$it MHz" } ?: ""
/** 36.101 Table 5.7.3-1 uplink: band, F_UL_low (MHz), N_Offs-UL (FDD bands in US use). */
private val EUTRA_UL = mapOf(
    1 to (1920.0 to 18000), 2 to (1850.0 to 18600), 3 to (1710.0 to 19200), 4 to (1710.0 to 19950), 5 to (824.0 to 20400), 7 to (2500.0 to 20750), 12 to (699.0 to 23010), 13 to (777.0 to 23180),
    14 to (788.0 to 23280), 17 to (704.0 to 23730), 25 to (1850.0 to 26040), 26 to (814.0 to 26690), 30 to (2305.0 to 27660), 66 to (1710.0 to 131972), 70 to (1695.0 to 132972), 71 to (663.0 to 133122), 85 to (698.0 to 134002),
)
private fun mhz1(f: Double) = "%.1f".format(Locale.US, Math.round(f * 10) / 10.0)
private fun list(xs: List<String>, n: Int = 4) = xs.take(n).joinToString(", ") + if (xs.size > n) ", …" else ""
private fun cycle(rf: String): String { val n = rf.removePrefix("rf").toIntOrNull() ?: 0; return if (n > 0) "%.2f".format(Locale.US, n / 100.0).let { if (it.endsWith("0")) it.dropLast(1) else it } + " s" else rf }
private fun pl(n: Int) = if (n == 1) "" else "s"

/** Uplink carrier of a cell: from SIB2's ul-CarrierFreq, else the band's default spacing from the downlink. */
fun uplinkMhz(band: Int?, dlMhz: Double, ulEarfcn: Int?): Double? {
    if (band == null) return null
    val ul = EUTRA_UL[band] ?: return null
    if (ulEarfcn != null) return Math.round((ul.first + 0.1 * (ulEarfcn - ul.second)) * 10) / 10.0
    val dl = bandDlMhz(band) ?: return null
    return Math.round((ul.first + (dlMhz - dl.first)) * 10) / 10.0
}

fun mibLine(m: Mib): String =
    "${BW_MHZ[m.bandwidth] ?: m.bandwidth} MHz (${m.bandwidth} RBs), ${m.ports} antenna port${pl(m.ports)}, PHICH ${m.phichResource}${if (m.phichDuration == "extended") " extended" else ""}${if (m.sib1BR != 0) ", LTE-M SIB1 scheduled" else ""}"

fun sib1Line(s: Sib1Summary): String {
    val ops = s.plmns.joinToString(", ") { if (it.name.isNotEmpty()) "${it.name} ${it.id}" else it.id }
    val warn = listOf(if (s.warning.sib12) "WEA scheduled" else "", if (s.warning.sib10 || s.warning.sib11) "ETWS scheduled" else "").filter { it.isNotEmpty() }
    return "$ops · TAC ${s.tac} · cell ${s.enbId}/${s.cellId} · band ${s.band}${if (s.bands.size > 1) " (also ${s.bands.drop(1).joinToString(", ")})" else ""}${if (s.barred == "barred") " · BARRED" else ""} · ${s.schedule.size} SI message${pl(s.schedule.size)}${if (warn.isNotEmpty()) " · " + warn.joinToString(", ") else ""}"
}

/** One plain line for a decoded SIB, given the cell's band and downlink MHz. */
fun feedSibLine(name: String, v: Obj, band: Int?, mhz: Double): String {
    try {
        val one = mapOf(name to v)
        when {
            name == "sib2" -> {
                val s = sib2Summary(v); val ul = uplinkMhz(band, mhz, s.ulEarfcn); val bw = if (s.ulBandwidth.isNotEmpty()) bwName(s.ulBandwidth) else ""
                val acb = if (s.acBarring == "not sent" || s.acBarring == "none") "access barring off" else "access barring on (${s.acBarring})"
                return listOf(acb, if (ul != null) "uplink ${mhz1(ul)} MHz${if (s.ulEarfcn == null) " (band default)" else ""}" else "", if (bw.isNotEmpty()) "$bw uplink" else "",
                    if (s.pagingCycle.isNotEmpty()) "paging cycle ${cycle(s.pagingCycle)}" else "", s.referenceSignalPowerDbm?.let { "reference signal $it dBm" } ?: "",
                    if (s.endcUpperLayer.any { it }) "5G (EN-DC) offered" else "").filter { it.isNotEmpty() }.joinToString(", ")
            }
            name == "sib3" -> {
                val s = sib3Summary(v)
                return listOf("reselection priority ${s.priority ?: "NaN"}", if (s.qHyst.isNotEmpty()) "hysteresis ${s.qHyst.replace("dB", "")} dB" else "",
                    s.sIntraSearchDb?.let { "searches its own frequency below $it dB margin" } ?: "", s.sNonIntraSearchDb?.let { "other carriers below $it dB" } ?: "",
                    s.qRxLevMinDbm?.let { "minimum level $it dBm" } ?: "").filter { it.isNotEmpty() }.joinToString(", ")
            }
            name == "sib4" -> {
                val n = neighbors(one)
                return "${n.intra.size} same-frequency neighbor${pl(n.intra.size)}${if (n.intra.isNotEmpty()) ": PCI " + list(n.intra.map { "${it.pci}" }, 8) else ""}${if (n.intraExcluded.isNotEmpty()) " · ${n.intraExcluded.size} excluded" else ""}"
            }
            name == "sib5" -> {
                val n = neighbors(one)
                return "${n.inter.size} other LTE carrier${pl(n.inter.size)}${if (n.inter.isNotEmpty()) ": " + list(n.inter.map { f -> "${if (f.mhz != null) mhz1(f.mhz) else "EARFCN ${f.earfcn}"}${if (f.band != null && f.band != 0) " B${f.band}" else ""} (prio ${f.priority ?: "-"})" }) else ""}"
            }
            name == "sib6" -> { val n = neighbors(one); return "${n.utra.size} UMTS carrier${pl(n.utra.size)}: ${list(n.utra.map { "UARFCN ${it.uarfcn}" })}" }
            name == "sib7" -> { val n = neighbors(one); return "GSM neighbors: ${list(n.geran.map { g -> "${g.band} ARFCN ${list(g.arfcns.map { "$it" }, 3)}" })}" }
            name == "sib8" -> {
                val t = sib8Time(v); val n = neighbors(one)
                return listOf(if (t != null) "CDMA2000 time ${t.utcIso.take(19).replace('T', ' ')} UTC (18 leap seconds assumed)${if (t.synchronized) ", frames GPS locked" else ""}" else "CDMA2000 parameters",
                    if (n.cdma.isNotEmpty()) "${n.cdma.size} CDMA2000 neighbor channel${pl(n.cdma.size)}" else "").filter { it.isNotEmpty() }.joinToString(", ")
            }
            name == "sib10" || name == "sib11" || name.startsWith("sib12") -> {
                val r9 = name.startsWith("sib12")
                fun f(k: String) = v[if (r9) "$k-r9" else k]
                val id = bitsNum(f("messageIdentifier")).toInt(); val c = cmasClass(id)
                if (name == "sib10") return "ETWS primary notification $id: ${category(id)}"
                val seg = (f("warningMessageSegmentNumber") as? Number)?.toInt() ?: -1; val last = f("warningMessageSegmentType") == "lastSegment"
                return "${c.kind.ifEmpty { "warning" }} ${c.label} $id (0x${Integer.toHexString(id).uppercase(Locale.US)}), segment ${seg + 1}${if (last) ", the last" else ""}${if (v["warningAreaCoordinatesSegment-r15"] != null) ", with alert area" else ""}"
            }
            name.startsWith("sib24") -> {
                val n = neighbors(one)
                return "${n.nr.size} 5G NR carrier${pl(n.nr.size)}: ${list(n.nr.map { f -> "${if (f.bands.isNotEmpty()) "n${f.bands[0]} " else ""}${jsNum(f.mhz)} MHz${if (f.priority != null) " (prio ${f.priority})" else ""}" })}"
            }
            name.startsWith("sib13") -> return "MBMS (broadcast TV and data) configuration"
            name.startsWith("sib14") -> return "extended access barring"
            name.startsWith("sib15") -> return "MBMS service areas"
            name.startsWith("sib16") -> return "time information (GPS and UTC)"
        }
    } catch (_: Exception) { }
    return "${v.size} field${pl(v.size)}"
}

private val VOLATILE = Regex("hyperSFN|SystemTime|systemTimeInfo|timeInfo")
/** The value as JSON with the fields that change on every transmission taken out. */
fun fingerprint(v: Any?): String = StringBuilder().also { fp(v, it) }.toString()
private fun fp(v: Any?, sb: StringBuilder) {
    when (v) {
        null -> sb.append("null")
        is Map<*, *> -> {
            sb.append('{'); var first = true
            for ((k, x) in v) { val key = k.toString(); if (VOLATILE.containsMatchIn(key)) continue; if (!first) sb.append(','); first = false; sb.append(JSONObject.quote(key)).append(':'); fp(x, sb) }
            sb.append('}')
        }
        is List<*> -> { sb.append('['); v.forEachIndexed { i, x -> if (i > 0) sb.append(','); fp(x, sb) }; sb.append(']') }
        is String -> sb.append(JSONObject.quote(v))
        else -> sb.append(v.toString())
    }
}

/** Rows newest first; the latest row of each cell and message folds identical repeats. */
class MessageFeed(val max: Int = 1500) {
    private val list = ArrayList<FeedRow>()
    private var next = 1
    val rows: List<FeedRow> @Synchronized get() = list.map { it.copy() }
    /** slot: what a repeat must match besides the message name (a warning's message ID and segment). */
    @Synchronized
    fun add(cell: String, hz: Long, pci: Int, op: String, band: Int?, name: String, text: String, alert: Boolean, fp: String, ms: Long, slot: String = ""): FeedRow {
        val prev = list.firstOrNull { it.cell == cell && it.name == name && it.slot == slot }
        if (prev != null && prev.fp == fp) { prev.lastMs = maxOf(prev.lastMs, ms); prev.count++; prev.text = text; prev.op = op.ifEmpty { prev.op }; return prev.copy() }
        val row = FeedRow(next++, cell, hz, pci, op, band, name, slot, text, alert, prev != null, ms, ms, 1, fp)
        list.add(0, row)
        if (list.size > max) list.subList(max, list.size).clear()
        return row.copy()
    }
    @Synchronized
    fun restore(rows: List<FeedRow>) {
        if (list.isNotEmpty()) return
        list.addAll(rows.take(max))
        next = (list.maxOfOrNull { it.id } ?: 0) + 1
    }
    @Synchronized fun clear() = list.clear()
    @Synchronized fun take(n: Int): List<FeedRow> = list.take(n).map { it.copy() }

    companion object {
        fun json(r: FeedRow): JSONObject = JSONObject().put("id", r.id).put("cell", r.cell).put("hz", r.hz).put("pci", r.pci).put("op", r.op).put("band", r.band ?: JSONObject.NULL)
            .put("name", r.name).put("slot", r.slot).put("text", r.text).put("alert", r.alert).put("change", r.change).put("firstMs", r.firstMs).put("lastMs", r.lastMs).put("count", r.count).put("fp", r.fp)
        fun of(o: JSONObject): FeedRow = FeedRow(o.getInt("id"), o.getString("cell"), o.getLong("hz"), o.getInt("pci"), o.optString("op"), if (o.isNull("band")) null else o.optInt("band"),
            o.getString("name"), o.optString("slot"), o.optString("text"), o.optBoolean("alert"), o.optBoolean("change"), o.optLong("firstMs"), o.optLong("lastMs"), o.optInt("count", 1), o.optString("fp"))
    }
}

/** The repeat slot of a warning SIB: message ID, serial and segment. */
fun warningSlot(name: String, v: Obj): String {
    val r9 = name.startsWith("sib12")
    fun f(k: String) = v[if (r9) "$k-r9" else k]
    return "${bitsNum(f("messageIdentifier"))}/${bitsNum(f("serialNumber"))}/${f("warningMessageSegmentNumber") ?: ""}"
}
