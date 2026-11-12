package com.rocketgod.mayhem.core.apps

import java.util.Locale

/**
 * ACARS aircraft: the decoder's message lines grouped into one record per aircraft (by registration, else flight),
 * each with its messages, so the screen can show a card per aircraft and link it to the same aircraft in ADS-B.
 *
 * A US registration (N-number) maps to its ICAO 24-bit address by the FAA's allocation (nNumberToIcao), so an ACARS
 * aircraft can be matched to an ADS-B one even before any registration lookup.
 *
 * Twin ports: web/src/acars-planes.ts and core/apps/AcarsPlanes.swift (same names, same constants).
 */

/** One ACARS message, as the decoder's line gives it. */
data class AcarsMsg(
    val mhz: String, val down: Boolean, val reg: String, val label: String, val blk: String, val ack: String, val msn: String, val flight: String,
    val crcOk: Boolean, val mode: String, val text: String, val ms: Long,
)

/**
 * Reads one decoder line: `ACARS 131.550 ↓ N12345  H1  blk 3  ack NAK  #M01A UA1234  CRC?  mode 2` with the text on
 * the next line (the CRC and mode parts only when they say something). Null for any other line. The channel may come
 * with a decimal comma: the decoder's `%.3f` follows the device's locale.
 */
private val HEAD = Regex("^ACARS (\\d+[.,]\\d{3}) ([↓↑]) (.*?)  (..)  blk (.)  ack (NAK|.)(?:  #(.{4}) (\\S*))?(  CRC\\?)?(?:  mode (.))?$")

fun parseAcarsLine(line: String, ms: Long): AcarsMsg? {
    val nl = line.indexOf('\n')
    val head = if (nl >= 0) line.substring(0, nl) else line
    val text = if (nl >= 0) line.substring(nl + 1) else ""
    val m = HEAD.find(head) ?: return null
    val g = m.groups
    return AcarsMsg(
        mhz = g[1]!!.value.replace(',', '.'), down = g[2]!!.value == "↓", reg = g[3]!!.value.trim(), label = g[4]!!.value, blk = g[5]!!.value,
        ack = g[6]!!.value, msn = g[7]?.value ?: "", flight = (g[8]?.value ?: "").trim(), crcOk = g[9] == null, mode = g[10]?.value ?: "2",
        text = text, ms = ms,
    )
}

/** What the common message labels mean (ARINC 618/620). */
private val LABELS: List<Pair<String, String>> = listOf(
    "_d" to "no information", "H1" to "message to/from crew or system", "Q0" to "link test", "QA" to "out of gate",
    "QB" to "off the ground", "QC" to "on the ground", "QD" to "into the gate", "QE" to "out / fuel", "QF" to "off / destination",
    "10" to "position / ETA", "11" to "position", "12" to "position", "13" to "position", "14" to "position", "15" to "position",
    "16" to "position", "17" to "position", "20" to "delay", "2Z" to "progress report", "30" to "request", "33" to "ATIS request",
    "4T" to "weather", "5U" to "weather request", "5Z" to "airline designated", "80" to "airline designated", "8E" to "ETA",
    "AA" to "free text", "B9" to "ATIS", "C1" to "uplink to cockpit printer", "RA" to "uplink to cockpit printer", "SA" to "media advisory",
    "SQ" to "squitter (ground station)", "_j" to "no information",
)

/** A message label's meaning ("" when unknown). */
fun labelMeaning(label: String): String {
    for ((k, v) in LABELS) if (k == label) return v
    return ""
}

/** One aircraft heard on ACARS. */
data class AcarsPlane(
    var key: String, var reg: String, var flight: String, val firstMs: Long, var lastMs: Long, var count: Int,
    /** Newest first, capped at MSG_KEEP. */
    val msgs: MutableList<AcarsMsg>,
    /** Its ICAO address when the registration says it (US N-numbers), else "". */
    var icao: String,
) {
    /** A copy whose message list the tracker no longer writes to, for a screen to read while lines keep arriving. */
    fun snapshot(): AcarsPlane = copy(msgs = msgs.toMutableList())
}

const val MSG_KEEP = 100

/** The key an aircraft is kept under: its registration, else its flight; ground stations and empty headers "". */
fun planeKey(m: AcarsMsg): String {
    if (m.label == "SQ") return ""
    return if (m.reg.isNotEmpty()) "R:${m.reg}" else if (m.flight.isNotEmpty()) "F:${m.flight}" else ""
}

/** One record per aircraft. */
class AcarsPlanes {
    val planes = LinkedHashMap<String, AcarsPlane>()
    /** Every message, aircraft or not (for the LOG view's count). */
    var total = 0

    fun add(m: AcarsMsg): AcarsPlane? {
        total++
        val key = planeKey(m)
        if (key.isEmpty()) return null
        var p = planes[key]
        // a flight first heard without its registration joins the registration's record once both show up together
        if (p == null && m.reg.isNotEmpty() && m.flight.isNotEmpty()) {
            val byFlight = planes["F:${m.flight}"]
            if (byFlight != null) { planes.remove(byFlight.key); byFlight.key = key; planes[key] = byFlight; p = byFlight }
        }
        if (p == null) {
            p = AcarsPlane(key, "", "", m.ms, m.ms, 0, mutableListOf(), "")
            planes[key] = p
        }
        p.count++; p.lastMs = m.ms
        if (m.reg.isNotEmpty()) { p.reg = m.reg; p.icao = nNumberToIcao(m.reg) }
        if (m.flight.isNotEmpty()) p.flight = m.flight
        p.msgs.add(0, m); while (p.msgs.size > MSG_KEEP) p.msgs.removeAt(p.msgs.size - 1)
        return p
    }

    /** Most recently heard first (messages are minutes apart, so the order moves slowly). */
    fun list(): List<AcarsPlane> = planes.values.sortedWith(compareByDescending<AcarsPlane> { it.lastMs }.thenBy { it.key })

    fun clear() { planes.clear(); total = 0 }
}

// ---- US N-number to ICAO address (the FAA allocates A00001..ADF7C7 in N-number order) ----
private const val NN_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"            // no I or O
private const val NN_SUFFIX = 1 + 24 * (1 + 24)                       // 601: none, A..Z, AA..ZZ
private const val NN_B4 = 1 + 24 + 10                                 // 35
private const val NN_B3 = 10 * NN_B4 + NN_SUFFIX                      // 951
private const val NN_B2 = 10 * NN_B3 + NN_SUFFIX                      // 10111
private const val NN_B1 = 10 * NN_B2 + NN_SUFFIX                      // 101711

private fun nnSuffix(s: String): Int {
    if (s.isEmpty()) return 0
    var v = NN_LETTERS.indexOf(s[0]) * (NN_LETTERS.length + 1) + 1
    if (s.length == 2) v += NN_LETTERS.indexOf(s[1]) + 1
    return v
}

private val NN_FORM = Regex("^N[1-9][0-9]{0,4}$|^N[1-9][0-9]{0,3}[A-HJ-NP-Z]{1,2}$")

/** The ICAO address (6 hex digits, upper case) of a US registration like N628TS or N-628TS; "" when it is not one. */
fun nNumberToIcao(reg: String): String {
    val r = normReg(reg)
    if (!NN_FORM.matches(r) || r.length > 6) return ""
    val n = r.substring(1)
    var out = 0xA00001 + (n[0].digitToInt() - 1) * NN_B1
    fun isL(c: Char) = c in NN_LETTERS
    fun done() = "%06X".format(out)
    if (n.length == 1) return done()
    if (isL(n[1])) { out += nnSuffix(n.substring(1)); return done() }
    out += n[1].digitToInt() * NN_B2 + NN_SUFFIX
    if (n.length == 2) return done()
    if (isL(n[2])) { out += nnSuffix(n.substring(2)); return done() }
    out += n[2].digitToInt() * NN_B3 + NN_SUFFIX
    if (n.length == 3) return done()
    if (isL(n[3])) { out += nnSuffix(n.substring(3)); return done() }
    out += n[3].digitToInt() * NN_B4 + NN_SUFFIX
    if (n.length == 4) return done()
    if (isL(n[4])) { out += 1 + NN_LETTERS.indexOf(n[4]); return done() }
    out += 1 + NN_LETTERS.length + n[4].digitToInt()
    return done()
}

/** A registration without its dash or dots, for matching (N-628TS and N628TS are the same aircraft). */
fun normReg(r: String): String = r.uppercase(Locale.US).replace(Regex("[^A-Z0-9]"), "")
