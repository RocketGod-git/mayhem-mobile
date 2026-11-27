package com.rocketgod.mayhem.core.cell

/*
 * LTE paging (PCCH on PDSCH, P-RNTI 0xFFFE). 36.331 Paging: the paging records (S-TMSI or IMSI with the CN domain,
 * the Rel-15 5G S-TMSI and full I-RNTI) and the systemInfoModification, ETWS and CMAS flags. 36.304 7.1/7.2 paging
 * frames and occasions from SIB2's PCCH-Config: every UE_ID is covered, so every PF and PO of the cell is read.
 */
const val P_RNTI = 0xfffe

data class PageRecord(val type: String, val id: String, val domain: String)
data class PagingMessage(val records: List<PageRecord>, val sysInfoMod: Boolean, val etws: Boolean, val cmas: Boolean, val eab: Boolean)
class PagingResult(val msg: PagingMessage?, val error: String? = null)

private val BIT_RE = Regex("^[01]+$")
private fun hexBits(bits: Any?, n: Int): String = if (bits is String && BIT_RE.matches(bits)) java.lang.Long.toHexString(bits.toLong(2)).uppercase().padStart(n, '0') else "?"

/** One PCCH transport block; msg null when it is not a Paging message. */
fun decodePaging(bytes: ByteArray): PagingResult {
    val v = try { rrcDecoder().decode("PCCH-Message", bytes).value as? Obj } catch (e: Exception) { return PagingResult(null, e.message ?: e.javaClass.simpleName) } catch (e: StackOverflowError) { return PagingResult(null, "too deep") }
    val p = ((v?.get("message") as? Obj)?.get("c1") as? Obj)?.get("paging") as? Obj ?: return PagingResult(null, "not a Paging message")
    val records = ((p["pagingRecordList"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { it as? Obj }.map { r ->
        val u = r["ue-Identity"] as? Obj ?: emptyMap(); val domain = if (r["cn-Domain"] == "cs") "CS" else "PS"
        val s = u["s-TMSI"] as? Obj
        when {
            s != null -> PageRecord("S-TMSI", "${hexBits(s["mmec"], 2)}:${hexBits(s["m-TMSI"], 8)}", domain)
            u["imsi"] is List<*> -> PageRecord("IMSI", (u["imsi"] as List<*>).joinToString(""), domain)
            u["ng-5G-S-TMSI-r15"] != null -> PageRecord("5G-S-TMSI", hexBits(u["ng-5G-S-TMSI-r15"], 12), domain)
            u["fullI-RNTI-r15"] != null -> PageRecord("I-RNTI", hexBits(u["fullI-RNTI-r15"], 10), domain)
            else -> PageRecord("OTHER", u.keys.firstOrNull() ?: "?", domain)
        }
    }
    // the Rel-9 and Rel-11 flags sit two and three nonCriticalExtension levels down
    val v920 = (p["nonCriticalExtension"] as? Obj)?.get("nonCriticalExtension") as? Obj; val v1130 = v920?.get("nonCriticalExtension") as? Obj
    return PagingResult(PagingMessage(records, p["systemInfoModification"] == "true", p["etws-Indication"] == "true", v920?.get("cmas-Indication-r9") == "true", v1130?.get("eab-ParamModification-r11") == "true"))
}

/** PFs (SFN mod every = 0) and the PO subframes of a cell, from defaultPagingCycle and nB. */
data class PagingConfig(val every: Int, val sfs: List<Int>)
private val NB = mapOf("fourT" to 4.0, "twoT" to 2.0, "oneT" to 1.0, "halfT" to 0.5, "quarterT" to 0.25, "oneEighthT" to 0.125, "oneSixteenthT" to 1 / 16.0, "oneThirtySecondT" to 1 / 32.0)
fun pagingConfig(cycle: String, nB: String, tdd: Boolean = false): PagingConfig? {
    val t = cycle.removePrefix("rf").toIntOrNull() ?: return null; val k = NB[nB] ?: return null
    if (t <= 0) return null
    val n = minOf(t.toDouble(), k * t); val ns = maxOf(1, k.toInt())
    val sfs = if (tdd) mapOf(1 to listOf(0), 2 to listOf(0, 5), 4 to listOf(0, 1, 5, 6)) else mapOf(1 to listOf(9), 2 to listOf(4, 9), 4 to listOf(0, 4, 5, 9))
    return PagingConfig(Math.round(t / n).toInt(), sfs.getValue(ns))
}
fun isPagingSf(c: PagingConfig, sfn: Int, sf: Int) = sfn % c.every == 0 && sf in c.sfs

/** A paging record or a flag as heard: flags of one cell fold into one row while they repeat. */
data class PageRow(val ms: Long, var lastMs: Long, val cell: String, val hz: Long, val pci: Int, val type: String, val id: String, val domain: String, var count: Int)
data class PageId(val type: String, val id: String, var domain: String, var count: Int, val firstMs: Long, var lastMs: Long, val cells: MutableList<String>)
data class PagingFlags(val sysInfoMod: Int, val etws: Int, val cmas: Int, val eab: Int)
data class PagingSnap(val total: Int, val rows: List<PageRow>, val ids: List<PageId>, val flags: PagingFlags)

class PagingLog(val max: Int = 2000) {
    private val rows = ArrayList<PageRow>()
    private val ids = LinkedHashMap<String, PageId>()
    var total = 0; private set
    private val flags = IntArray(4)

    /** Adds one decoded message; returns the flags that started a new row (for the log). */
    fun add(m: PagingMessage, cell: String, hz: Long, pci: Int, ms: Long): List<String> {
        for (r in m.records) {
            total++
            rows.add(0, PageRow(ms, ms, cell, hz, pci, r.type, r.id, r.domain, 1))
            val o = ids["${r.type}|${r.id}"]
            if (o != null) { o.count++; o.lastMs = ms; o.domain = r.domain; if (cell !in o.cells) o.cells.add(cell) }
            else ids["${r.type}|${r.id}"] = PageId(r.type, r.id, r.domain, 1, ms, ms, mutableListOf(cell))
        }
        val fresh = ArrayList<String>()
        for ((i, on, label) in listOf(Triple(0, m.sysInfoMod, "SI CHANGE"), Triple(1, m.etws, "ETWS"), Triple(2, m.cmas, "CMAS"), Triple(3, m.eab, "EAB CHANGE"))) {
            if (!on) continue
            flags[i]++
            val prev = rows.firstOrNull { it.cell == cell && it.type == label }
            if (prev != null && ms - prev.lastMs < 10_000) { prev.lastMs = ms; prev.count++; continue }
            rows.add(0, PageRow(ms, ms, cell, hz, pci, label, "", "", 1))
            fresh.add(label)
        }
        if (rows.size > max) rows.subList(max, rows.size).clear()
        if (ids.size > max) ids.entries.sortedBy { it.value.lastMs }.take(ids.size - max).map { it.key }.forEach { ids.remove(it) }
        return fresh
    }
    fun snapshot(nRows: Int = 300, nIds: Int = 200): PagingSnap = PagingSnap(
        total, rows.take(nRows).map { it.copy() },
        ids.values.sortedWith(compareByDescending<PageId> { it.count }.thenByDescending { it.lastMs }).take(nIds).map { it.copy(cells = it.cells.toMutableList()) },
        PagingFlags(flags[0], flags[1], flags[2], flags[3]),
    )
    fun clear() { rows.clear(); ids.clear(); total = 0; flags.fill(0) }
}
