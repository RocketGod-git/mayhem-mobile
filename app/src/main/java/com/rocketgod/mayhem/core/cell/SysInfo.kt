package com.rocketgod.mayhem.core.cell

import kotlin.math.floor

/*
 * Plain summaries of decoded system information (36.331), frequency tables and operator names.
 *   cellIdentity (28 bits) = eNB ID (20 MSBs) + cell within the eNB (8 LSBs).
 *   E-UTRA downlink F_DL = F_DL_low + 0.1 (N_DL - N_Offs-DL)               36.101 Table 5.7.3-1
 *   NR F_REF = F_REF-Offs + dF_Global (N_REF - N_REF-Offs)                   38.104 Table 5.4.2.1-1
 *   SI window of the n-th SI message starts at x = (n - 1) w, in the frame with SFN mod T = floor(x / 10), subframe x mod 10 (36.331 5.2.3).
 */

/** A number the way JavaScript prints it: whole values without a decimal point. */
fun jsNum(d: Double): String = if (d == floor(d) && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()
private fun r1(x: Double) = Math.round(x * 10) / 10.0

/** 36.101 Table 5.7.3-1, downlink: band, F_DL_low (MHz), N_Offs-DL, last N_DL. */
private class Eutra(val band: Int, val low: Double, val off: Int, val last: Int)
private val EUTRA_DL = listOf(
    Eutra(1, 2110.0, 0, 599), Eutra(2, 1930.0, 600, 1199), Eutra(3, 1805.0, 1200, 1949), Eutra(4, 2110.0, 1950, 2399), Eutra(5, 869.0, 2400, 2649), Eutra(6, 875.0, 2650, 2749),
    Eutra(7, 2620.0, 2750, 3449), Eutra(8, 925.0, 3450, 3799), Eutra(9, 1844.9, 3800, 4149), Eutra(10, 2110.0, 4150, 4749), Eutra(11, 1475.9, 4750, 4949), Eutra(12, 729.0, 5010, 5179),
    Eutra(13, 746.0, 5180, 5279), Eutra(14, 758.0, 5280, 5379), Eutra(17, 734.0, 5730, 5849), Eutra(18, 860.0, 5850, 5999), Eutra(19, 875.0, 6000, 6149), Eutra(20, 791.0, 6150, 6449),
    Eutra(21, 1495.9, 6450, 6599), Eutra(22, 3510.0, 6600, 7399), Eutra(23, 2180.0, 7500, 7699), Eutra(24, 1525.0, 7700, 8039), Eutra(25, 1930.0, 8040, 8689), Eutra(26, 859.0, 8690, 9039),
    Eutra(27, 852.0, 9040, 9209), Eutra(28, 758.0, 9210, 9659), Eutra(29, 717.0, 9660, 9769), Eutra(30, 2350.0, 9770, 9869), Eutra(31, 462.5, 9870, 9919), Eutra(32, 1452.0, 9920, 10359),
    Eutra(33, 1900.0, 36000, 36199), Eutra(34, 2010.0, 36200, 36349), Eutra(35, 1850.0, 36350, 36949), Eutra(36, 1930.0, 36950, 37549), Eutra(37, 1910.0, 37550, 37749), Eutra(38, 2570.0, 37750, 38249),
    Eutra(39, 1880.0, 38250, 38649), Eutra(40, 2300.0, 38650, 39649), Eutra(41, 2496.0, 39650, 41589), Eutra(42, 3400.0, 41590, 43589), Eutra(43, 3600.0, 43590, 45589), Eutra(44, 703.0, 45590, 46589),
    Eutra(45, 1447.0, 46590, 46789), Eutra(46, 5150.0, 46790, 54539), Eutra(47, 5855.0, 54540, 55239), Eutra(48, 3550.0, 55240, 56739), Eutra(65, 2110.0, 65536, 66435), Eutra(66, 2110.0, 66436, 67335),
    Eutra(67, 738.0, 67336, 67535), Eutra(68, 753.0, 67536, 67835), Eutra(69, 2570.0, 67836, 68335), Eutra(70, 1995.0, 68336, 68585), Eutra(71, 617.0, 68586, 68935), Eutra(72, 461.0, 68936, 68985),
    Eutra(74, 1475.0, 69036, 69465), Eutra(75, 1432.0, 69466, 70315), Eutra(76, 1427.0, 70316, 70365), Eutra(85, 728.0, 70366, 70545),
)
val TDD_BANDS = setOf(33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48)

data class EarfcnInfo(val earfcn: Int, val band: Int?, val mhz: Double?, val tdd: Boolean)
fun earfcnDl(n: Int): EarfcnInfo {
    for (e in EUTRA_DL) if (n >= e.off && n <= e.last) return EarfcnInfo(n, e.band, r1(e.low + 0.1 * (n - e.off)), e.band in TDD_BANDS)
    return EarfcnInfo(n, null, null, false)
}
fun dlEarfcnForMhz(band: Int, mhz: Double): Int? {
    val r = EUTRA_DL.firstOrNull { it.band == band } ?: return null
    val n = Math.round((mhz - r.low) * 10).toInt() + r.off
    return if (n >= r.off && n <= r.last) n else null
}
/** Downlink edges of a band in MHz. */
fun bandDlMhz(band: Int): Pair<Double, Double>? {
    val r = EUTRA_DL.firstOrNull { it.band == band } ?: return null
    return r.low to r1(r.low + 0.1 * (r.last - r.off))
}
fun nrArfcnMhz(n: Long): Double {
    val f = if (n < 600000) 0.005 * n else if (n < 2016667) 3000 + 0.015 * (n - 600000) else 24250.08 + 0.06 * (n - 2016667)
    return Math.round(f * 1000) / 1000.0
}

/** Public MCC/MNC assignments (ITU-T E.212 lists and national registries). */
private val OPERATORS = mapOf(
    "310-150" to "AT&T", "310-170" to "AT&T", "310-280" to "AT&T", "310-380" to "AT&T", "310-410" to "AT&T", "310-560" to "AT&T",
    "310-680" to "AT&T", "311-180" to "AT&T", "313-100" to "FirstNet", "310-004" to "Verizon", "310-010" to "Verizon", "310-012" to "Verizon",
    "310-013" to "Verizon", "310-590" to "Verizon", "310-890" to "Verizon", "310-910" to "Verizon", "311-110" to "Verizon", "311-270" to "Verizon",
    "311-271" to "Verizon", "311-272" to "Verizon", "311-273" to "Verizon", "311-274" to "Verizon", "311-275" to "Verizon", "311-276" to "Verizon",
    "311-277" to "Verizon", "311-278" to "Verizon", "311-279" to "Verizon", "311-280" to "Verizon", "311-281" to "Verizon", "311-282" to "Verizon",
    "311-283" to "Verizon", "311-284" to "Verizon", "311-285" to "Verizon", "311-286" to "Verizon", "311-287" to "Verizon", "311-288" to "Verizon",
    "311-289" to "Verizon", "311-390" to "Verizon", "311-480" to "Verizon", "311-481" to "Verizon", "311-482" to "Verizon", "311-483" to "Verizon",
    "311-484" to "Verizon", "311-485" to "Verizon", "311-486" to "Verizon", "311-487" to "Verizon", "311-488" to "Verizon", "311-489" to "Verizon",
    "310-160" to "T-Mobile", "310-200" to "T-Mobile", "310-210" to "T-Mobile", "310-220" to "T-Mobile", "310-230" to "T-Mobile", "310-240" to "T-Mobile",
    "310-250" to "T-Mobile", "310-260" to "T-Mobile", "310-270" to "T-Mobile", "310-310" to "T-Mobile", "310-490" to "T-Mobile", "310-660" to "T-Mobile",
    "310-800" to "T-Mobile", "311-490" to "T-Mobile", "312-250" to "T-Mobile", "312-530" to "T-Mobile", "310-120" to "T-Mobile (Sprint)", "316-010" to "T-Mobile (Sprint)",
    "311-580" to "UScellular", "311-220" to "UScellular", "310-730" to "UScellular", "313-340" to "Boost Mobile", "311-230" to "C Spire", "310-320" to "Cellular One",
    "310-130" to "Carolina West", "310-450" to "Viaero", "310-370" to "Docomo Pacific", "310-140" to "GTA", "311-370" to "GCI", "315-010" to "CBRS shared network",
    "302-220" to "Telus", "302-221" to "Telus", "302-610" to "Bell", "302-640" to "Bell", "302-690" to "Bell", "302-660" to "Bell MTS",
    "302-720" to "Rogers", "302-370" to "Fido", "302-320" to "Rogers", "302-490" to "Freedom Mobile", "302-500" to "Videotron", "302-510" to "Videotron",
    "302-520" to "Videotron", "302-680" to "SaskTel", "302-780" to "SaskTel", "302-270" to "Eastlink", "302-620" to "ICE Wireless", "334-020" to "Telcel",
    "334-030" to "Movistar", "334-010" to "AT&T Mexico", "334-040" to "AT&T Mexico", "334-050" to "AT&T Mexico", "334-090" to "AT&T Mexico", "334-140" to "Altan Redes",
    "234-10" to "O2 UK", "234-15" to "Vodafone UK", "234-20" to "Three UK", "234-30" to "EE", "234-33" to "EE", "262-01" to "Telekom",
    "262-02" to "Vodafone DE", "262-03" to "O2 DE", "208-01" to "Orange FR", "208-10" to "SFR", "208-15" to "Free", "208-20" to "Bouygues",
    "222-01" to "TIM", "222-10" to "Vodafone IT", "222-88" to "WindTre", "214-01" to "Vodafone ES", "214-03" to "Orange ES", "214-07" to "Movistar ES",
    "440-10" to "NTT Docomo", "440-20" to "SoftBank", "440-50" to "KDDI au", "450-05" to "SK Telecom", "450-08" to "KT", "450-06" to "LG U+",
    "460-00" to "China Mobile", "460-01" to "China Unicom", "460-11" to "China Telecom", "505-01" to "Telstra", "505-02" to "Optus", "505-03" to "Vodafone AU",
    "530-01" to "One NZ", "724-05" to "Claro BR", "724-06" to "Vivo", "724-10" to "Vivo", "724-11" to "Vivo", "724-02" to "TIM BR",
    "732-101" to "Claro CO", "732-123" to "Movistar CO", "730-01" to "Entel", "730-03" to "Claro CL", "525-01" to "Singtel", "454-00" to "CSL",
    "466-92" to "Chunghwa", "655-01" to "Vodacom", "655-10" to "MTN ZA", "621-30" to "MTN NG", "286-01" to "Turkcell", "250-01" to "MTS",
    "250-02" to "MegaFon", "250-99" to "Beeline",
)
fun operatorName(plmn: String): String = OPERATORS[plmn] ?: ""

/** Every value under `key` anywhere in a decoded tree, depth first. */
fun walk(o: Any?, key: String): Sequence<Any?> = sequence {
    when (o) {
        is List<*> -> for (v in o) yieldAll(walk(v, key))
        is Map<*, *> -> for ((k, v) in o) { if (k == key) yield(v); yieldAll(walk(v, key)) }
    }
}
private fun first(o: Any?, key: String): Any? = walk(o, key).firstOrNull()
private fun num(v: Any?): Long? = v as? Long
private fun int(v: Any?): Int? = (v as? Long)?.toInt()
private fun str(v: Any?): String = when (v) { null -> ""; else -> v.toString() }
@Suppress("UNCHECKED_CAST") private fun obj(v: Any?): Obj? = v as? Obj
@Suppress("UNCHECKED_CAST") private fun list(v: Any?): List<Any?> = v as? List<Any?> ?: emptyList()
private fun objs(v: Any?): List<Obj> = list(v).mapNotNull { obj(it) }
private fun longs(v: Any?): List<Long> = list(v).mapNotNull { it as? Long }

fun plmnString(p: Obj, prevMcc: String = ""): String {
    val id = obj(p["plmn-Identity"])
    val mcc = (id?.get("mcc") as? List<*>)?.joinToString("") ?: prevMcc
    val mnc = (id?.get("mnc") as? List<*>)?.joinToString("") ?: ""
    return "$mcc-$mnc"
}

data class SiSchedule(val si: Int, val periodicity: Int, val sibs: List<String>, val windowStartSfnMod: Int, val windowStartSubframe: Int, val windowMs: Int)
data class Plmn(val id: String, val name: String)
data class Warn(val sib10: Boolean, val sib11: Boolean, val sib12: Boolean)
data class Sib1Summary(
    val plmns: List<Plmn>, val tac: Int, val cellIdentity: Long, val enbId: Long, val cellId: Int,
    val barred: String, val intraFreqReselection: String, val band: Int, val bands: List<Int>, val qRxLevMinDbm: Int?, val qQualMinDb: Int?,
    val pMax: Int?, val siWindowMs: Int, val valueTag: Int, val schedule: List<SiSchedule>, val warning: Warn,
    val hyperSfn: Int?, val imsEmergency: Boolean, val edrx: Boolean, val tdd: String?,
)

fun sib1Summary(s: Obj): Sib1Summary {
    val cai = obj(s["cellAccessRelatedInfo"]) ?: emptyMap()
    val plmns = ArrayList<Plmn>()
    var mcc = ""
    for (p in objs(cai["plmn-IdentityList"])) { val id = plmnString(p, mcc); mcc = id.substringBefore('-'); plmns.add(Plmn(id, operatorName(id))) }
    val cid = bitsNum(cai["cellIdentity"])
    var band = int(s["freqBandIndicator"]) ?: -1
    if (band == 64) { val v = int(first(s, "freqBandIndicator-v9e0")); if (v != null) band = v }
    val bands = arrayListOf(band)
    val mb = longs(first(s, "multiBandInfoList")); val mb9 = list(first(s, "multiBandInfoList-v9e0"))
    mb.forEachIndexed { i, b -> val v = if (b == 64L) int(obj(mb9.getOrNull(i))?.get("freqBandIndicator-v9e0")) else b.toInt(); if (v != null && v !in bands) bands.add(v) }
    val w = str(s["si-WindowLength"] ?: "ms0").drop(2).toIntOrNull() ?: 0
    val sched = ArrayList<Pair<String, List<String>>>()
    for (e in objs(s["schedulingInfoList"])) sched.add(str(e["si-Periodicity"]) to list(e["sib-MappingInfo"]).map { str(it) })
    for (ext in walk(s, "schedulingInfoListExt-r12")) for (e in objs(ext)) sched.add(str(e["si-Periodicity-r12"]) to list(e["sib-MappingInfo-r12"]).map { str(it) })
    val schedule = sched.mapIndexed { i, (per, sibs) ->
        val x = i * w
        SiSchedule(i + 1, per.drop(2).toIntOrNull() ?: 0, (if (i == 0) listOf("sibType2") else emptyList()) + sibs, x / 10, x % 10, w)
    }
    val all = schedule.flatMap { it.sibs }
    val csi = obj(s["cellSelectionInfo"])
    val qq = int(obj(first(s, "cellSelectionInfo-v920"))?.get("q-QualMin-r9"))
    val tdd = obj(s["tdd-Config"])
    val hs = bitsNum(first(s, "hyperSFN-r13"))
    return Sib1Summary(
        plmns, bitsNum(cai["trackingAreaCode"]).toInt(), cid, if (cid >= 0) cid ushr 8 else -1, if (cid >= 0) (cid and 0xff).toInt() else -1,
        str(cai["cellBarred"]), str(cai["intraFreqReselection"]), band, bands,
        (csi?.get("q-RxLevMin") as? Long)?.let { (2 * it).toInt() }, qq,
        int(s["p-Max"]), w, int(s["systemInfoValueTag"]) ?: -1, schedule,
        Warn("sibType10" in all, "sibType11" in all, all.any { it.startsWith("sibType12") }),
        if (hs >= 0) hs.toInt() else null, first(s, "ims-EmergencySupport-r9") == "true", first(s, "eDRX-Allowed-r13") == "true",
        if (tdd != null) "${str(tdd["subframeAssignment"])} ${str(tdd["specialSubframePatterns"])}" else null,
    )
}

/** Which SI message (1-based) a frame/subframe falls in, given the schedule; 0 when none. */
fun siWindowOf(schedule: List<SiSchedule>, sfn: Int, sf: Int): Int {
    for (t in schedule) {
        val start = t.windowStartSfnMod * 10 + t.windowStartSubframe; val pos = (sfn % t.periodicity) * 10 + sf
        if (pos >= start && pos < start + t.windowMs) return t.si
    }
    return 0
}

data class CellRef(val pci: Int, val offset: String)
data class InterFreq(val earfcn: Int, val band: Int?, val mhz: Double?, val bands: List<Int>, val priority: Int?, val threshHigh: Int?, val threshLow: Int?, val qRxLevMinDbm: Int?, val bandwidth: String, val cells: List<CellRef>, val excluded: List<String>)
data class NrFreq(val arfcn: Long, val mhz: Double, val bands: List<Int>, val scs: String, val priority: Int?, val subPriority: String, val threshHigh: Int?, val threshLow: Int?, val qRxLevMinDbm: Int?)
data class Utra(val kind: String, val uarfcn: Int, val priority: Int?)
data class Geran(val arfcns: List<Int>, val band: String, val priority: Int?)
data class Cdma(val bandClass: String, val arfcn: Int, val pns: List<Int>)
data class Neighbors(
    val intra: List<CellRef>, val intraExcluded: List<String>, val csgRange: String, val inter: List<InterFreq>,
    val utra: List<Utra>, val geran: List<Geran>, val cdma: List<Cdma>, val nr: List<NrFreq>, val tReselectionNr: Int?,
)
private fun rangeText(r: Obj) = if (r["range"] != null) "${str(r["start"])} (${str(r["range"])})" else str(r["start"])
private fun cellRefs(l: Any?): List<CellRef> = objs(l).map { CellRef(int(it["physCellId"]) ?: -1, str(it["q-OffsetCell"])) }

/** Neighbor relations from SIB4/5/6/7/8/24 (map of SIB name to decoded value). */
fun neighbors(sibs: Map<String, Obj>): Neighbors {
    var intra = emptyList<CellRef>(); var excl = emptyList<String>(); var csg = ""
    sibs["sib4"]?.let { s4 ->
        intra = cellRefs(s4["intraFreqNeighCellList"])
        excl = objs(s4["intraFreqExcludedCellList"]).map { rangeText(it) }
        obj(s4["csg-PhysCellIdRange"])?.let { csg = rangeText(it) }
    }
    var inter = emptyList<InterFreq>()
    sibs["sib5"]?.let { s5 ->
        val v8 = list(first(s5, "interFreqCarrierFreqList-v8h0")); val v9 = list(first(s5, "interFreqCarrierFreqList-v9e0"))
        inter = objs(s5["interFreqCarrierFreqList"]).mapIndexed { i, c ->
            var n = int(c["dl-CarrierFreq"]) ?: -1
            val v9i = obj(v9.getOrNull(i))
            if (n == 65535 && v9i?.get("dl-CarrierFreq-v9e0") is Long) n = int(v9i["dl-CarrierFreq-v9e0"])!!
            val f = earfcnDl(n)
            val bands = ArrayList<Int>()
            for (b in longs(obj(v8.getOrNull(i))?.get("multiBandInfoList"))) if (b != 64L) bands.add(b.toInt())
            for (b in objs(v9i?.get("multiBandInfoList-v9e0"))) int(b["freqBandIndicator-v9e0"])?.let { bands.add(it) }
            InterFreq(n, f.band, f.mhz, bands, int(c["cellReselectionPriority"]), int(c["threshX-High"]), int(c["threshX-Low"]),
                int(c["q-RxLevMin"])?.let { 2 * it }, str(c["allowedMeasBandwidth"]), cellRefs(c["interFreqNeighCellList"]), objs(c["interFreqExcludedCellList"]).map { rangeText(it) })
        }
    }
    val utra = ArrayList<Utra>()
    sibs["sib6"]?.let { s6 ->
        for (c in objs(s6["carrierFreqListUTRA-FDD"])) utra.add(Utra("UTRA FDD", int(c["carrierFreq"]) ?: -1, int(c["cellReselectionPriority"])))
        for (c in objs(s6["carrierFreqListUTRA-TDD"])) utra.add(Utra("UTRA TDD", int(c["carrierFreq"]) ?: -1, int(c["cellReselectionPriority"])))
    }
    val geran = ArrayList<Geran>()
    sibs["sib7"]?.let { s7 ->
        for (c in objs(s7["carrierFreqsInfoList"])) {
            val f = obj(c["carrierFreqs"]) ?: continue; val fol = obj(f["followingARFCNs"]) ?: emptyMap(); val arfcns = arrayListOf(int(f["startingARFCN"]) ?: -1)
            (fol["explicitListOfARFCNs"] as? List<*>)?.let { l -> arfcns.addAll(l.mapNotNull { (it as? Long)?.toInt() }) }
            obj(fol["equallySpacedARFCNs"])?.let { eq -> for (k in 1..(int(eq["numberOfFollowingARFCNs"]) ?: 0)) arfcns.add(arfcns[0] + k * (int(eq["arfcn-Spacing"]) ?: 0)) }
            geran.add(Geran(arfcns, str(f["bandIndicator"]), int(obj(c["commonInfo"])?.get("cellReselectionPriority"))))
        }
    }
    val cdma = ArrayList<Cdma>()
    sibs["sib8"]?.let { s8 ->
        for (nl in walk(s8, "neighCellList")) for (nc in objs(nl)) for (pf in objs(nc["neighCellsPerFreqList"]))
            cdma.add(Cdma(str(nc["bandClass"]), int(pf["arfcn"]) ?: -1, longs(pf["physCellIdList"]).map { it.toInt() }))
    }
    var nr = emptyList<NrFreq>(); var tNr: Int? = null
    sibs["sib24-v1530"]?.let { s24 ->
        tNr = int(s24["t-ReselectionNR-r15"])
        nr = objs(s24["carrierFreqListNR-r15"]).map { c ->
            val a = num(c["carrierFreq-r15"]) ?: -1
            NrFreq(a, nrArfcnMhz(a), longs(c["multiBandInfoList-r15"]).map { it.toInt() }, str(c["subcarrierSpacingSSB-r15"]), int(c["cellReselectionPriority-r15"]),
                str(c["cellReselectionSubPriority-r15"]), int(c["threshX-High-r15"]), int(c["threshX-Low-r15"]), int(c["q-RxLevMin-r15"])?.let { 2 * it })
        }
    }
    return Neighbors(intra, excl, csg, inter, utra, geran, cdma, nr, tNr)
}

data class Sib2Summary(
    val preambles: String, val prachConfigIndex: Int?, val rootSequence: Int?, val referenceSignalPowerDbm: Int?, val pB: Int?, val pagingCycle: String, val nB: String,
    val p0NominalPusch: Int?, val alpha: String, val ul64qam: Boolean, val mbsfn: Boolean, val additionalSpectrumEmission: Int?, val ulEarfcn: Int?, val ulBandwidth: String,
    val acBarring: String, val endcUpperLayer: List<Boolean>,
)
fun sib2Summary(s: Obj): Sib2Summary {
    val rr = obj(s["radioResourceConfigCommon"]) ?: emptyMap()
    fun g(k: String) = first(rr, k)
    val fi = obj(s["freqInfo"]) ?: emptyMap(); val acb = obj(s["ac-BarringInfo"])
    fun truthy(v: Any?) = v != null && v != false && v != 0L && v != ""
    return Sib2Summary(
        str(g("numberOfRA-Preambles")), int(g("prach-ConfigIndex")), int(g("rootSequenceIndex")),
        int(g("referenceSignalPower")), int(g("p-b")), str(g("defaultPagingCycle")), str(g("nB")),
        int(g("p0-NominalPUSCH")), str(g("alpha")), g("enable64QAM") == true || g("enable64QAM-v1270") == "true",
        s.containsKey("mbsfn-SubframeConfigList") && s["mbsfn-SubframeConfigList"] != null, int(fi["additionalSpectrumEmission"]), int(fi["ul-CarrierFreq"]), str(fi["ul-Bandwidth"]),
        if (acb != null) (if (truthy(acb["ac-BarringForMO-Data"]) || truthy(acb["ac-BarringForMO-Signalling"])) "barring set" else if (truthy(acb["ac-BarringForEmergency"])) "emergency barred" else "none") else "not sent",
        objs(s["plmn-InfoList-r15"]).map { it["upperLayerIndication-r15"] == "true" },
    )
}

data class Sib3Summary(val qHyst: String, val sNonIntraSearchDb: Int?, val threshServingLow: Int?, val priority: Int?, val qRxLevMinDbm: Int?, val sIntraSearchDb: Int?, val tReselection: Int?, val bandwidth: String)
fun sib3Summary(s: Obj): Sib3Summary {
    val c = obj(s["cellReselectionInfoCommon"]) ?: emptyMap(); val sv = obj(s["cellReselectionServingFreqInfo"]) ?: emptyMap(); val ia = obj(s["intraFreqCellReselectionInfo"]) ?: emptyMap()
    val sp = int(obj(s["s-IntraSearch-v920"])?.get("s-IntraSearchP-r9")) ?: int(ia["s-IntraSearch"])
    val sn = int(obj(s["s-NonIntraSearch-v920"])?.get("s-NonIntraSearchP-r9")) ?: int(sv["s-NonIntraSearch"])
    return Sib3Summary(str(c["q-Hyst"]), sn?.let { 2 * it }, int(sv["threshServingLow"]), int(sv["cellReselectionPriority"]),
        int(ia["q-RxLevMin"])?.let { 2 * it }, sp?.let { 2 * it }, int(ia["t-ReselectionEUTRA"]), str(ia["allowedMeasBandwidth"]))
}

data class Sib8Time(val cdma10ms: Long, val gpsIso: String, val utcIso: String, val synchronized: Boolean)
private const val GPS_EPOCH_MS = 315_964_800_000L
fun isoUtc(ms: Long): String = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(ms))
/** SIB8 CDMA2000 system time (39 bits, 10 ms units since the GPS epoch 1980-01-06). UTC assumes GPS minus 18 leap seconds. */
fun sib8Time(s: Obj): Sib8Time? {
    val st = first(s, "synchronousSystemTime") as? String ?: return null
    val v = st.toLong(2); val gps = GPS_EPOCH_MS + v * 10
    return Sib8Time(v, isoUtc(gps), isoUtc(gps - 18_000), first(s, "cdma-EUTRA-Synchronisation") == true)
}

// ---- detail panel groups -----------------------------------------------------------------------------------------
private val GROUPS: List<Pair<String, Regex>> = listOf(
    "Warning" to Regex("messageIdentifier|serialNumber|warning|dataCodingScheme"),
    "Scheduling" to Regex("schedulingInfo|si-Periodicity|sib-Mapping|si-WindowLength|systemInfoValueTag|hyperSFN|modificationPeriod|pcch|defaultPagingCycle|\\bnB\\b"),
    "Access" to Regex("cellAccessRelatedInfo|plmn|trackingAreaCode|cellIdentity|cellBarred|csg-Indication|csg-Identity|cellReserved|ac-Barring|ssac|acdc|ims-Emergency|eDRX|eCall|upperLayer|voiceService|videoService|udt|intraFreqReselection"),
    "Neighbors NR" to Regex("NR-r15|NR-v|ReselectionNR|carrierFreq-r15|measTimingConfig|subcarrierSpacingSSB|deriveSSB"),
    "Neighbors intra-frequency" to Regex("intraFreqNeigh|intraFreqExcluded|csg-PhysCellIdRange"),
    "Neighbors inter-frequency" to Regex("interFreq|dl-CarrierFreq"),
    "Inter-RAT" to Regex("UTRA|GERAN|carrierFreqsInfo|cdma|CDMA2000|1XRTT|HRPD|systemTimeInfo|searchWindowSize|csfb"),
    "Reselection" to Regex("q-Hyst|s-IntraSearch|s-NonIntraSearch|threshServing|cellReselection|t-Reselection|speedState|mobilityState|threshX"),
    "Selection" to Regex("cellSelectionInfo|q-RxLevMin|q-QualMin|p-Max"),
    "Timers" to Regex("ue-TimersAndConstants|timeAlignment|\\bt3\\d\\d|\\bn3\\d\\d"),
    "Radio config" to Regex("radioResourceConfig|rach|prach|pdsch|pusch|pucch|soundingRS|uplinkPower|ul-Cyclic|freqInfo|mbsfn|tdd-Config|multiBandInfo|freqBand|additionalSpectrum|NS-Pmax", RegexOption.IGNORE_CASE),
)
private val NOISE = Regex("^(nonCriticalExtension|lateNonCriticalExtension|.*-IEs)$")
private val THRESH = Regex("^(s-IntraSearch|s-NonIntraSearch|threshServingLow|threshX-(High|Low))(P-r9|-r15)?$")
private fun fmt(v: Any?): String = when (v) { null -> "present"; is Boolean -> if (v) "true" else "false"; is List<*> -> v.joinToString(", ") { fmt(it) }; is Double -> jsNum(v); else -> v.toString() }
private fun isLeaf(v: Any?): Boolean = v == null || (v !is Map<*, *> && v !is List<*>) || (v is List<*> && v.all { it == null || (it !is Map<*, *> && it !is List<*>) })
private fun derived(k: String, v: Any?): String {
    if (v !is Long) return ""
    if (k.startsWith("q-RxLevMin")) return " (${2 * v} dBm)"
    if (THRESH.matches(k) || k == "s-IntraSearch" || k == "s-NonIntraSearch") return " (${2 * v} dB)"
    if (k == "referenceSignalPower") return " dBm"
    if (k == "dl-CarrierFreq" || k == "dl-CarrierFreq-v9e0" || k == "ul-CarrierFreq") { val f = earfcnDl(v.toInt()); return if (f.mhz != null) " (B${f.band}, ${jsNum(f.mhz)} MHz)" else "" }
    if (k == "carrierFreq-r15") return " (${jsNum(nrArfcnMhz(v))} MHz)"
    return ""
}
private fun compact(o: Map<*, *>): String? {
    if (o.isEmpty()) return "present"
    if (o.size > 6 || !o.values.all { isLeaf(it) }) return null
    return o.entries.joinToString(", ") { (k, v) -> "$k ${fmt(v)}${derived(k.toString(), v)}" }
}

data class FieldGroup(val name: String, val rows: List<Pair<String, String>>)
/** Every decoded field of one SIB as named groups of [label, value] rows. */
fun fieldGroups(sibName: String, value: Any?): List<FieldGroup> {
    val rows = ArrayList<Triple<String, String, String>>()
    fun visit(v: Any?, path: List<String>, key: String) {
        val label = path.filter { !NOISE.matches(it) }.joinToString(" / ")
        if (isLeaf(v)) { rows.add(Triple(label, fmt(v) + derived(key, v), path.joinToString("/"))); return }
        if (v is List<*>) {
            v.forEachIndexed { i, x ->
                val c = if (x is Map<*, *>) compact(x) else null
                if (c != null) rows.add(Triple("$label [${i + 1}]", c, path.joinToString("/")))
                else visit(x, path.dropLast(1) + "${path.lastOrNull() ?: sibName} [${i + 1}]", key)
            }
            return
        }
        val o = v as Map<*, *>
        if (o.isEmpty()) { if (!NOISE.matches(key)) rows.add(Triple(label, "present", path.joinToString("/"))); return }
        for ((k, x) in o) visit(x, path + k.toString(), k.toString())
    }
    visit(value, emptyList(), sibName)
    val groups = LinkedHashMap<String, ArrayList<Pair<String, String>>>()
    for ((label, v, raw) in rows) {
        val g = GROUPS.firstOrNull { it.second.containsMatchIn(raw) }?.first ?: "Other"
        groups.getOrPut(g) { ArrayList() }.add(label.ifEmpty { sibName } to v)
    }
    val order = GROUPS.map { it.first } + "Other"
    return order.filter { it in groups }.map { FieldGroup(it, groups.getValue(it)) }
}
