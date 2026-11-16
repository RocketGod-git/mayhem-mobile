package com.rocketgod.mayhem.core.apps

import java.util.Locale
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * What an ACARS message says, in plain words: its kind (link test, out/off/on/in, position, weather, ATIS, free text,
 * engine or system data ...) from the label table and what the text shows, the airports it names (only codes that
 * are real airports), a position (only clear latitude/longitude forms, implausible ones dropped), the flight phase
 * from the out/off/on/in labels, and a route when two airports stand together. Also the airline from a flight
 * number, the VDL2 per-address tracker (every aircraft and ground station heard, not only ACARS) and the activity
 * counts the STATS view draws.
 *
 * Twin ports: web/src/acars-insight.ts and core/apps/AcarsInsight.swift (same names, same constants).
 */

/** An airport: ICAO ident, position, name. */
data class AcarsAirport(val ident: String, val lat: Double, val lon: Double, val name: String)
typealias AirportLookup = (String) -> AcarsAirport?
data class LatLon(val lat: Double, val lon: Double)

/** Message kinds: id to short label. */
val KINDS: Map<String, String> = linkedMapOf(
    "link" to "LINK TEST", "ack" to "ACK", "out" to "OUT", "off" to "OFF", "on" to "ON", "in" to "IN", "pos" to "POSITION", "wx" to "WEATHER",
    "atis" to "ATIS", "eta" to "ETA", "delay" to "DELAY", "text" to "FREE TEXT", "printer" to "PRINTER", "engine" to "ENGINE DATA",
    "fault" to "FAULT REPORT", "fms" to "FMS", "data" to "SYSTEM DATA", "media" to "MEDIA", "airline" to "AIRLINE", "request" to "REQUEST", "other" to "MESSAGE",
)
fun kindLabelOf(k: String): String = KINDS[k] ?: "MESSAGE"

/** The flight phases out/off/on/in give. */
val PHASES: Map<String, String> = mapOf("out" to "TAXIING", "off" to "AIRBORNE", "on" to "LANDED", "in" to "AT GATE")

data class MsgInsight(
    val kind: String,
    /** A short plain-English line. */
    val summary: String,
    /** Known airports named in the text, in order, no repeats. */
    val airports: List<String>,
    val pos: LatLon?,
    /** "" or a PHASES value. */
    val phase: String,
    val orig: String, val dest: String,
    /** What the text itself says of the flight (only from labeled values: FL350, ALT 12000, GS 450, HDG 270, FOB 18.4,
     *  ETA 0215); null or "" when it does not say. */
    val nums: FlightNums = FlightNums(),
)

data class FlightNums(val altFt: Int? = null, val kt: Int? = null, val mach: String = "", val hdg: Int? = null, val fuel: String = "", val eta: String = "") {
    val any: Boolean get() = altFt != null || kt != null || mach.isNotEmpty() || hdg != null || fuel.isNotEmpty() || eta.isNotEmpty()
}

/** Common words that are also airport idents: never read as airports. */
private val NOT_AIRPORTS = setOf("KIND", "KNEW", "KNOW", "PAST")
/** Positions further than this from home are not where a VHF-heard aircraft is. */
const val POS_MAX_KM = 1000.0

fun distKm(a: LatLon, b: LatLon): Double {
    val r = Math.PI / 180; val dLat = (b.lat - a.lat) * r; val dLon = (b.lon - a.lon) * r
    val h = sin(dLat / 2).let { it * it } + cos(a.lat * r) * cos(b.lat * r) * sin(dLon / 2).let { it * it }
    return 2 * 6371 * asin(min(1.0, sqrt(h)))
}

/** Degrees from a hemisphere letter and a digit group: DDMM, DDMMm, DDMMmm (minutes), or DD.ddd (with the point). */
private fun degOf(hemi: String, s: String, degDigits: Int): Double? {
    val neg = hemi == "S" || hemi == "W"
    val v: Double
    if (s.contains('.')) {
        val a = s.substringBefore('.'); val b = s.substringAfter('.')
        v = if (a.length == degDigits || a.length == degDigits - 1) "$a.$b".toDouble()                  // decimal degrees
        else if (a.length == degDigits + 2 || a.length == degDigits + 1) {                                // DDMM.m
            val d = a.substring(0, a.length - 2).toDouble(); val m = "${a.takeLast(2)}.$b".toDouble()
            if (m >= 60) return null
            d + m / 60
        } else return null
    } else {
        if (s.length < degDigits + 2 || s.length > degDigits + 4) return null
        val d = s.substring(0, degDigits).toDouble(); val mm = s.substring(degDigits)
        val m = mm.substring(0, 2).toDouble() + (if (mm.length > 2) "0.${mm.substring(2)}".toDouble() else 0.0)
        if (m >= 60) return null
        v = d + m / 60
    }
    return if (v.isFinite()) (if (neg) -v else v) else null
}

private val POS_HEMI = Regex("(?<![A-Z0-9])(?:POS|POSN)?\\s?([NS])\\s?(\\d{2}(?:\\d{2}\\.\\d{1,3}|\\d{2,4}|\\.\\d{1,4}))[\\s,/]{0,2}([EW])\\s?(\\d{3}(?:\\d{2}\\.\\d{1,3}|\\d{2,4}|\\.\\d{1,4}))(?!\\d)")
private val POS_HEMI_TIGHT = Regex("(?<!\\d)([NS])(\\d{2}(?:\\d{2}\\.\\d{1,3}|\\d{2,4}|\\.\\d{1,4}))\\s?([EW])(\\d{3}(?:\\d{2}\\.\\d{1,3}|\\d{2,4}|\\.\\d{1,4}))(?!\\d)")
private val POS_SIGNED = Regex("(?<![\\d.])(-?\\d{1,2}\\.\\d{3,6}),\\s?(-?\\d{1,3}\\.\\d{3,6})(?![\\d.])")

/** Plausible: on the globe, not 0,0, and (when home is known) within POS_MAX_KM of it. */
fun plausible(p: LatLon, home: LatLon?): Boolean {
    if (!(abs(p.lat) <= 90 && abs(p.lon) <= 180)) return false
    if (abs(p.lat) < 0.01 && abs(p.lon) < 0.01) return false
    return home == null || distKm(p, home) <= POS_MAX_KM
}

/** Every clear latitude/longitude in [text] (N33456W118123, N3345.6 W11812.3, N33.456 W118.123, 33.456,-118.123). */
fun findPositions(text: String, home: LatLon? = null): List<LatLon> {
    val out = ArrayList<LatLon>()
    val t = text.uppercase(Locale.US)
    val seen = HashSet<String>()
    fun push(p: LatLon) { val k = "%.4f,%.4f".format(Locale.US, p.lat, p.lon); if (k !in seen && plausible(p, home)) { seen.add(k); out.add(p) } }
    for (re in listOf(POS_HEMI, POS_HEMI_TIGHT)) for (m in re.findAll(t)) {
        val g = m.groupValues
        val lat = degOf(g[1], g[2], 2); val lon = degOf(g[3], g[4], 3)
        if (lat != null && lon != null) push(LatLon(lat, lon))
    }
    for (m in POS_SIGNED.findAll(t)) push(LatLon(m.groupValues[1].toDouble(), m.groupValues[2].toDouble()))
    return out
}

private val LETTER_RUN = Regex("[A-Z]{4,}")

/** The known airports named in [text]: four-letter codes (alone, or two run together as in KLAXKSFO). */
fun findAirports(text: String, lookup: AirportLookup?): List<String> {
    if (lookup == null) return emptyList()
    val out = ArrayList<String>()
    for (m in LETTER_RUN.findAll(text.uppercase(Locale.US))) {
        val run = m.value
        val parts = if (run.length == 4) listOf(run) else if (run.length == 8) listOf(run.substring(0, 4), run.substring(4)) else emptyList()
        for (c in parts) if (c !in NOT_AIRPORTS && lookup(c) != null && c !in out) out.add(c)
    }
    return out
}

private val ROUTE = Regex("(?<![A-Z])([A-Z]{4})[\\s\\-/>]?([A-Z]{4})(?![A-Z])")

/** Origin and destination: two known airports side by side (KLAX KSFO, KLAX-KSFO, KLAX/KSFO, KLAXKSFO). */
fun findRoute(text: String, lookup: AirportLookup?): Pair<String, String>? {
    if (lookup == null) return null
    val t = text.uppercase(Locale.US)
    var from = 0
    while (from < t.length) {
        val m = ROUTE.find(t, from) ?: return null
        val a = m.groupValues[1]; val b = m.groupValues[2]
        if (a != b && a !in NOT_AIRPORTS && b !in NOT_AIRPORTS && lookup(a) != null && lookup(b) != null) return a to b
        from = m.range.first + 1
    }
    return null
}

private val CLOCK = Regex("(?<!\\d)([01]\\d|2[0-3])([0-5]\\d)(?!\\d)")
/** A clock time (HHMM, 24 h) in the text, as HH:MM; "" when none. */
private fun timeIn(text: String): String = CLOCK.find(text)?.let { "${it.groupValues[1]}:${it.groupValues[2]}" } ?: ""

private val NUM_ALT_FL = Regex("(?<![A-Z0-9])FL\\s?(\\d{3})(?!\\d)"); private val NUM_ALT = Regex("(?<![A-Z0-9])ALT\\s?(\\d{4,5})(?!\\d)")
private val NUM_KT = Regex("(?<![A-Z0-9])(?:GS|SPD|TAS)\\s?(\\d{2,3})(?!\\d)"); private val NUM_MACH = Regex("(?<![A-Z0-9])(?:MACH\\s?\\.?|M\\.)(\\d{2,3})(?!\\d)")
private val NUM_HDG = Regex("(?<![A-Z0-9])(?:HDG|TRK)\\s?(\\d{3})(?!\\d)"); private val NUM_FUEL = Regex("(?<![A-Z0-9])(?:FOB|FUEL)\\s?(\\d{1,3}(?:\\.\\d{1,2})?)(?![\\d.])")
private val NUM_ETA = Regex("(?<![A-Z0-9])ETA\\s?([01]\\d|2[0-3])([0-5]\\d)(?!\\d)")

/** The flight numbers a message's text states, each only from its label and only when in range. */
fun flightNums(text: String): FlightNums {
    val t = text.uppercase(Locale.US)
    val fl = NUM_ALT_FL.find(t)?.groupValues?.get(1)?.toInt(); val alt = NUM_ALT.find(t)?.groupValues?.get(1)?.toInt()
    val altFt = if (fl != null && fl in 10..600) fl * 100 else if (alt != null && alt in 100..60000) alt else null
    val kt = NUM_KT.find(t)?.groupValues?.get(1)?.toInt()?.takeIf { it in 30..700 }
    val machD = NUM_MACH.find(t)?.groupValues?.get(1)
    val mach = if (machD != null && "0.$machD".toDouble().let { it >= 0.2 && it < 1 }) "M.$machD" else ""
    val hdg = NUM_HDG.find(t)?.groupValues?.get(1)?.toInt()?.takeIf { it <= 360 }?.let { it % 360 }
    val fuel = NUM_FUEL.find(t)?.groupValues?.get(1) ?: ""
    val eta = NUM_ETA.find(t)?.let { "${it.groupValues[1]}:${it.groupValues[2]}" } ?: ""
    return FlightNums(altFt, kt, mach, hdg, fuel, eta)
}

/** The numbers as short chips: FL350, 450 KT, M.78, HDG 270, FUEL 18.4, ETA 02:15. */
fun numChips(n: FlightNums): List<String> = buildList {
    n.altFt?.let { add(if (it >= 18000 && it % 100 == 0) "FL%03d".format(Locale.US, it / 100) else "%,d FT".format(Locale.US, it)) }
    n.kt?.let { add("$it KT") }
    if (n.mach.isNotEmpty()) add(n.mach)
    n.hdg?.let { add("HDG %03d".format(Locale.US, it)) }
    if (n.fuel.isNotEmpty()) add("FUEL ${n.fuel}")
    if (n.eta.isNotEmpty()) add("ETA ${n.eta}")
}

private val OOOI = mapOf("QA" to "out", "QE" to "out", "QB" to "off", "QF" to "off", "QC" to "on", "QD" to "in")
private val OOOI_WORDS = mapOf("out" to "Out of the gate", "off" to "Off the ground", "on" to "On the ground", "in" to "Into the gate")
private val POS_LABELS = setOf("10", "11", "12", "13", "14", "15", "16", "17", "2Z")
private val DIGITISH = Regex("[\\d\\s.\\-]")
private val SUB = Regex("^\\s*[#/]([A-Z0-9]{2})")
private val ATIS_WORD = Regex("\\bATIS\\b")
private val ATIS_INFO = Regex("\\bINFO(?:RMATION)?\\s+([A-Z])\\b")
private val WX_WORD = Regex("\\b(METAR|TAF|SPECI)\\b")
private val WX_WIND = Regex("\\b\\d{5}(G\\d{2,3})?KT\\b")
private val ETA = Regex("\\bETA\\s?(\\d{4})\\b")
private val WORDS = Regex("[A-Z]{3,}\\s[A-Z]{3,}")
private val SPACES = Regex("\\s+")
private val M_DIGIT = Regex("^M\\d$")

private fun clip(t: String) = t.replace(SPACES, " ").trim().take(80)

/** What one message is, in plain words. */
fun msgInsight(m: AcarsMsg, lookup: AirportLookup? = null, home: LatLon? = null): MsgInsight {
    val t = m.text; val up = t.uppercase(Locale.US); val l = m.label
    val airports = findAirports(t, lookup)
    val pos = findPositions(t, home).firstOrNull()
    val route = findRoute(t, lookup)
    val apt = airports.firstOrNull() ?: ""
    var kind: String; var summary: String; var phase = ""
    val digits = DIGITISH.findAll(t).count()
    val sub = SUB.find(up)?.groupValues?.get(1) ?: ""
    val oooi = OOOI[l]
    when {
        oooi != null -> {
            kind = oooi; phase = PHASES.getValue(kind)
            val at = timeIn(t)
            summary = "${OOOI_WORDS.getValue(kind)}${if (apt.isNotEmpty()) " at $apt" else ""}${if (at.isNotEmpty()) " · $at" else ""}"
        }
        l == "Q0" -> { kind = "link"; summary = "Link test: the radio checking its datalink" }
        l == "_d" || l == "_j" -> { kind = "ack"; summary = "Acknowledgment, no text" }
        l == "B9" || l == "33" || ATIS_WORD.containsMatchIn(up) -> {
            kind = "atis"
            val info = ATIS_INFO.find(up)?.groupValues?.get(1)
            summary = "ATIS${if (apt.isNotEmpty()) " for $apt" else ""}${if (info != null) " · information $info" else ""}${if (l == "33") " request" else ""}"
        }
        l == "4T" || l == "5U" || WX_WORD.containsMatchIn(up) || WX_WIND.containsMatchIn(up) -> {
            kind = "wx"; summary = "Weather${if (apt.isNotEmpty()) " for ${airports.take(3).joinToString(", ")}" else ""}${if (l == "5U") " request" else ""}"
        }
        l in POS_LABELS || (pos != null && sub != "DF" && sub != "CF") -> {
            kind = "pos"; summary = if (pos != null) "Position %.2f, %.2f".format(Locale.US, pos.lat, pos.lon) else "Position report"
        }
        l == "8E" || ETA.containsMatchIn(up) -> {
            kind = "eta"; val at = ETA.find(up)?.groupValues?.get(1)
            summary = "ETA${if (apt.isNotEmpty()) " $apt" else ""}${if (at != null) " ${at.substring(0, 2)}:${at.substring(2)}" else ""}"
        }
        l == "20" -> { kind = "delay"; summary = "Delay report" }
        l == "C1" || l == "RA" -> { kind = "printer"; summary = "To the cockpit printer" }
        l == "SA" -> { kind = "media"; summary = "Media advisory: which datalinks are up" }
        l == "H1" && sub == "DF" -> { kind = "engine"; summary = "Engine and system readings for maintenance" }
        l == "H1" && sub == "CF" -> { kind = "fault"; summary = "Fault report from the maintenance computer" }
        l == "H1" && M_DIGIT.matches(sub) -> { kind = "fms"; summary = "Flight management computer data" }
        l == "AA" || (t.length >= 8 && WORDS.containsMatchIn(up) && digits < t.length * 0.5) -> { kind = "text"; summary = clip(t) }
        t.length >= 20 && digits > t.length * 0.6 -> { kind = "data"; summary = "System data (numbers for the airline)" }
        l == "5Z" || l == "80" -> { kind = "airline"; summary = "Airline message" }
        l == "30" -> { kind = "request"; summary = "Request" }
        else -> {
            kind = "other"; val mean = labelMeaning(l)
            summary = if (mean.isNotEmpty()) mean.replaceFirstChar { it.uppercase(Locale.US) } else if (t.isNotEmpty()) clip(t) else "Label $l"
        }
    }
    if (kind == "pos" && pos != null) summary = "Position %.2f, %.2f".format(Locale.US, pos.lat, pos.lon) + if (apt.isNotEmpty()) " · $apt" else ""
    return MsgInsight(kind, summary, airports, pos, phase, route?.first ?: "", route?.second ?: "", flightNums(t))
}

/** What a whole aircraft's messages add up to. */
data class PlaneInsight(
    /** Newest message's insight. */
    val last: MsgInsight?,
    /** The newest out/off/on/in phase, "" when none. */
    val phase: String, val phaseMs: Long,
    /** The newest decoded position and when. */
    val pos: LatLon?, val posMs: Long,
    val orig: String, val dest: String,
    val airports: List<String>,
    /** The newest of each number the messages stated, and the newest message that stated any. */
    val nums: FlightNums = FlightNums(), val numsMs: Long = 0,
    /** The heading stated in the same message as the position (for the map's arrow), else null. */
    val posHdg: Int? = null,
)

fun planeInsight(msgs: List<AcarsMsg>, of: (AcarsMsg) -> MsgInsight): PlaneInsight {
    var last: MsgInsight? = null; var phase = ""; var phaseMs = 0L; var pos: LatLon? = null; var posMs = 0L; var orig = ""; var dest = ""
    val airports = ArrayList<String>()
    var n = FlightNums(); var numsMs = 0L; var posHdg: Int? = null
    for (m in msgs) {                                        // newest first
        val i = of(m)
        if (last == null) last = i
        if (phase.isEmpty() && i.phase.isNotEmpty()) { phase = i.phase; phaseMs = m.ms }
        if (pos == null && i.pos != null) { pos = i.pos; posMs = m.ms; posHdg = i.nums.hdg }
        val x = i.nums
        if (x.any) numsMs = maxOf(numsMs, m.ms)
        n = FlightNums(n.altFt ?: x.altFt, n.kt ?: x.kt, n.mach.ifEmpty { x.mach }, n.hdg ?: x.hdg, n.fuel.ifEmpty { x.fuel }, n.eta.ifEmpty { x.eta })
        if (orig.isEmpty() && i.orig.isNotEmpty()) { orig = i.orig; dest = i.dest }
        for (a in i.airports) if (a !in airports && airports.size < 6) airports.add(a)
    }
    return PlaneInsight(last, phase, phaseMs, pos, posMs, orig, dest, airports, n, numsMs, posHdg)
}

// ---- airlines: designators (IATA two-character and ICAO three-letter), public data ----
private val AIRLINES: List<Triple<String, String, String>> = listOf(
    // US mainline, low-cost and regional
    Triple("AA", "AAL", "American"), Triple("UA", "UAL", "United"), Triple("DL", "DAL", "Delta"), Triple("WN", "SWA", "Southwest"), Triple("AS", "ASA", "Alaska"),
    Triple("B6", "JBU", "JetBlue"), Triple("NK", "NKS", "Spirit"), Triple("F9", "FFT", "Frontier"), Triple("G4", "AAY", "Allegiant"), Triple("HA", "HAL", "Hawaiian"),
    Triple("SY", "SCX", "Sun Country"), Triple("MX", "MXY", "Breeze"), Triple("XP", "VXP", "Avelo"), Triple("QX", "QXE", "Horizon"), Triple("OO", "SKW", "SkyWest"),
    Triple("YX", "RPA", "Republic"), Triple("MQ", "ENY", "Envoy"), Triple("9E", "EDV", "Endeavor"), Triple("OH", "JIA", "PSA"), Triple("YV", "ASH", "Mesa"),
    Triple("PT", "PDT", "Piedmont"), Triple("ZW", "AWI", "Air Wisconsin"), Triple("G7", "GJS", "GoJet"), Triple("C5", "UCA", "CommutAir"), Triple("KS", "PEN", "PenAir"),
    // US cargo
    Triple("FX", "FDX", "FedEx"), Triple("5X", "UPS", "UPS"), Triple("5Y", "GTI", "Atlas Air"), Triple("K4", "CKS", "Kalitta"), Triple("PO", "PAC", "Polar"),
    Triple("GB", "ABX", "ABX Air"), Triple("8C", "ATN", "ATI"), Triple("NC", "NAC", "Northern Air Cargo"), Triple("KH", "AAH", "Aloha Air Cargo"),
    // Canada, Mexico, Latin America
    Triple("AC", "ACA", "Air Canada"), Triple("WS", "WJA", "WestJet"), Triple("TS", "TSC", "Air Transat"), Triple("PD", "POE", "Porter"), Triple("F8", "FLE", "Flair"),
    Triple("WG", "SWG", "Sunwing"), Triple("AM", "AMX", "Aeromexico"), Triple("Y4", "VOI", "Volaris"), Triple("VB", "VIV", "Viva Aerobus"), Triple("CM", "CMP", "Copa"),
    Triple("AV", "AVA", "Avianca"), Triple("LA", "LAN", "LATAM"), Triple("JJ", "TAM", "LATAM Brasil"), Triple("AR", "ARG", "Aerolineas Argentinas"), Triple("G3", "GLO", "Gol"),
    Triple("AD", "AZU", "Azul"),
    // Europe, Middle East, Africa
    Triple("BA", "BAW", "British Airways"), Triple("VS", "VIR", "Virgin Atlantic"), Triple("AF", "AFR", "Air France"), Triple("KL", "KLM", "KLM"), Triple("LH", "DLH", "Lufthansa"),
    Triple("LX", "SWR", "Swiss"), Triple("OS", "AUA", "Austrian"), Triple("SN", "BEL", "Brussels"), Triple("EI", "EIN", "Aer Lingus"), Triple("IB", "IBE", "Iberia"),
    Triple("AZ", "ITY", "ITA Airways"), Triple("TP", "TAP", "TAP Air Portugal"), Triple("SK", "SAS", "SAS"), Triple("AY", "FIN", "Finnair"), Triple("LO", "LOT", "LOT"),
    Triple("TK", "THY", "Turkish"), Triple("EK", "UAE", "Emirates"), Triple("QR", "QTR", "Qatar"), Triple("EY", "ETD", "Etihad"), Triple("SV", "SVA", "Saudia"),
    Triple("LY", "ELY", "El Al"), Triple("MS", "MSR", "EgyptAir"), Triple("ET", "ETH", "Ethiopian"), Triple("CV", "CLX", "Cargolux"),
    // Asia and the Pacific
    Triple("NH", "ANA", "ANA"), Triple("JL", "JAL", "Japan Airlines"), Triple("ZG", "TZP", "ZIPAIR"), Triple("KE", "KAL", "Korean Air"), Triple("OZ", "AAR", "Asiana"),
    Triple("CX", "CPA", "Cathay Pacific"), Triple("CI", "CAL", "China Airlines"), Triple("BR", "EVA", "EVA Air"), Triple("CA", "CCA", "Air China"),
    Triple("MU", "CES", "China Eastern"), Triple("CZ", "CSN", "China Southern"), Triple("HU", "CHH", "Hainan"), Triple("SQ", "SIA", "Singapore"),
    Triple("PR", "PAL", "Philippine"), Triple("5J", "CEB", "Cebu Pacific"), Triple("VN", "HVN", "Vietnam Airlines"), Triple("TG", "THA", "Thai"), Triple("AI", "AIC", "Air India"),
    Triple("QF", "QFA", "Qantas"), Triple("NZ", "ANZ", "Air New Zealand"), Triple("FJ", "FJI", "Fiji Airways"),
)
private val BY_IATA = AIRLINES.associate { it.first to it.third }
private val BY_ICAO = AIRLINES.associate { it.second to it.third }
private val ICAO_FL = Regex("^([A-Z]{3})\\d")
private val IATA_FL = Regex("^([A-Z0-9]{2})\\d")

/** The airline of a flight number (UA2282, UAL2282, AS 1310): its name, "" when not in the table. */
fun airlineOf(flight: String): String {
    val f = flight.uppercase(Locale.US).replace(SPACES, "")
    ICAO_FL.find(f)?.groupValues?.get(1)?.let { c -> BY_ICAO[c]?.let { return it } }
    val iata = IATA_FL.find(f)?.groupValues?.get(1) ?: return ""
    if (iata.none { it in 'A'..'Z' }) return ""
    return BY_IATA[iata] ?: ""
}

// ---- VDL2: every aircraft and ground station heard, by their 24-bit AVLC addresses ----
data class VdlEvent(val ms: Long, val text: String)

class VdlAircraft(
    val addr: String, val firstMs: Long, var lastMs: Long, var frames: Int, var snr: Int, val snrs: MutableList<Int>,
    var reg: String, var flight: String, var acars: Int,
    /** Ground stations it worked, by address, last heard. */
    val stations: LinkedHashMap<String, Long>,
    /** The station it last talked to. */
    var station: String,
    var hz: Long, val events: MutableList<VdlEvent>,
    /** The parameters of the newest XID it sent ("" when none). */
    var xid: String = "",
) {
    fun snapshot() = VdlAircraft(addr, firstMs, lastMs, frames, snr, snrs.toMutableList(), reg, flight, acars, LinkedHashMap(stations), station, hz, events.toMutableList(), xid)
}

class VdlStation(
    val addr: String, val firstMs: Long, var lastMs: Long, var frames: Int,
    /** SNR of what it sent; null when it has not been heard itself. */
    var snr: Int?,
    /** The airport its XIDs name, and whether the station itself said it (else an aircraft did). */
    var airport: String, var airportOwn: Boolean,
    /** The newest XID it sent, and the newest an aircraft sent it (info octets; the airport is read from these). */
    var xidOwn: List<Int>, var xidHeard: List<Int>,
    val aircraft: LinkedHashMap<String, Long>, var hz: Long,
) {
    fun snapshot() = VdlStation(addr, firstMs, lastMs, frames, snr, airport, airportOwn, xidOwn, xidHeard, LinkedHashMap(aircraft), hz)
}

const val VDL_EVENT_KEEP = 20
const val VDL_LINK_MS = 10 * 60_000L
/** The VDL2 channels, for the per-channel counts (the decoder's list). */
val VDL2_CHANNELS: List<Long> = Vdl2Decoder.CHANNELS

private fun h6(n: Int) = "%06X".format(n)
private fun isGround(t: Int) = t == 4 || t == 5

/** I, S, XID, UI or U from the AVLC control octet. */
fun frameKind(ctrl: Int): String = when {
    ctrl and 1 == 0 -> "I"
    ctrl and 3 == 1 -> "S"
    ctrl and 0xEF == 0xAF -> "XID"
    ctrl and 0xEF == 0x03 -> "UI"
    else -> "U"
}

/** Registration and flight of ACARS carried in a frame (FF FF 01, then the ACARS block); null when it is not ACARS. */
fun frameAcars(info: List<Int>, down: Boolean): Pair<String, String>? {
    if (info.size < 16 || info[0] != 0xFF || info[1] != 0xFF || info[2] != 0x01) return null
    val b = info.subList(3, info.size).map { it and 0x7F }
    val reg = (1..7).joinToString("") { b[it].toChar().toString() }.trim('.', ' ')
    var flight = ""
    if (down && b[12] == 0x02 && b.size - 13 >= 11) flight = (17 until 23).joinToString("") { b[it].toChar().toString() }.trim()
    return reg to flight
}

/** One XID parameter: its group (0x80 public, 0xF0 VDL private), id and value octets. */
data class XidParam(val group: Int, val id: Int, val value: List<Int>)

/**
 * An XID frame's parameters (ISO 8885 layout, as on our recordings): format 0x82, then groups of an id, a 2-octet
 * length and parameters of id, 1-octet length, value. Null when the octets do not hold together that way.
 */
fun xidParams(info: List<Int>): List<XidParam>? {
    if (info.size < 4 || info[0] != 0x82) return null
    val out = ArrayList<XidParam>()
    var p = 1
    while (p < info.size) {
        if (p + 3 > info.size) return null
        val group = info[p]; val len = (info[p + 1] shl 8) or info[p + 2]; val end = p + 3 + len
        if (end > info.size) return null
        var q = p + 3
        while (q < end) {
            if (q + 2 > end) return null
            val id = info[q]; val n = info[q + 1]
            if (q + 2 + n > end) return null
            out.add(XidParam(group, id, info.subList(q + 2, q + 2 + n).toList()))
            q += 2 + n
        }
        p = end
    }
    return out
}

/** The airports an XID names: parameter values that are four letters and a known airport (else, when the frame does
 *  not parse as parameters, four-letter codes in its text). */
fun xidAirports(info: List<Int>, lookup: AirportLookup?): List<String> {
    val ps = xidParams(info) ?: return findAirports(frameText(info), lookup)
    val out = ArrayList<String>()
    for (x in ps) {
        if (x.value.size != 4 || !x.value.all { it in 0x41..0x5A }) continue
        val c = x.value.joinToString("") { it.toChar().toString() }
        if (c !in NOT_AIRPORTS && lookup?.invoke(c) != null && c !in out) out.add(c)
    }
    return out
}

/** The parameters as a short line for the panel: 80/01 8885:1993 · F0/83 KLGB · F0/04 25 ... */
fun xidSummary(info: List<Int>): String {
    val ps = xidParams(info) ?: return ""
    return ps.joinToString(" · ") { x ->
        val txt = x.value.size >= 2 && x.value.all { it in 0x20..0x7E }
        "%X/%02X ".format(x.group, x.id) + if (txt) x.value.joinToString("") { it.toChar().toString() } else x.value.joinToString("") { "%02X".format(it) }
    }
}

/** The printable text of a frame's info field. */
fun frameText(info: List<Int>): String = info.joinToString("") { val c = it and 0x7F; if (c in 0x20..0x7E) c.toChar().toString() else " " }

class Vdl2Tracker(@Volatile var lookup: AirportLookup? = null) {
    val aircraft = LinkedHashMap<String, VdlAircraft>()
    val stations = LinkedHashMap<String, VdlStation>()
    /** Frames by channel (Hz). */
    val chans = LinkedHashMap<Long, Int>()
    var frames = 0; private set

    fun add(f: Vdl2Decoder.Frame, ms: Long) {
        frames++
        chans[f.hz] = (chans[f.hz] ?: 0) + 1
        val down = f.srcType == 1; val upl = f.dstType == 1 && isGround(f.srcType)
        val acAddr = if (down) f.src else if (upl) f.dst else -1
        val gsAddr = if (down && isGround(f.dstType)) f.dst else if (isGround(f.srcType)) f.src else -1
        val kind = frameKind(f.ctrl)
        var gs: VdlStation? = null
        if (gsAddr >= 0) {
            val k = h6(gsAddr)
            gs = stations.getOrPut(k) { VdlStation(k, ms, ms, 0, null, "", false, emptyList(), emptyList(), LinkedHashMap(), f.hz) }
            gs.frames++; gs.lastMs = ms; gs.hz = f.hz
            if (isGround(f.srcType)) gs.snr = f.snrDb
            if (kind == "XID") { if (isGround(f.srcType)) gs.xidOwn = f.info.toList() else gs.xidHeard = f.info.toList() }
            placeStation(gs)
        }
        if (acAddr < 0) return
        val k = h6(acAddr)
        val a = aircraft.getOrPut(k) { VdlAircraft(k, ms, ms, 0, 0, mutableListOf(), "", "", 0, LinkedHashMap(), "", f.hz, mutableListOf()) }
        a.lastMs = ms; a.hz = f.hz
        a.frames++
        if (down) { a.snr = f.snrDb; a.snrs.add(f.snrDb); if (a.snrs.size > 30) a.snrs.removeAt(0) }
        val ac = frameAcars(f.info, down)
        if (ac != null) { a.acars++; if (ac.first.isNotEmpty()) a.reg = ac.first; if (ac.second.isNotEmpty()) a.flight = ac.second }
        if (kind == "XID" && down) a.xid = xidSummary(f.info).ifEmpty { a.xid }
        if (gs != null) {
            gs.aircraft[k] = ms
            if (kind == "XID") {
                val where = if (gs.airport.isNotEmpty()) " (${gs.airport})" else ""
                val text = if (a.station.isNotEmpty() && a.station != gs.addr) "handoff ${a.station} → ${gs.addr}$where" else "link with ${gs.addr}$where"
                val top = a.events.firstOrNull()
                if (top == null || top.text != text || ms - top.ms > 60_000) { a.events.add(0, VdlEvent(ms, text)); while (a.events.size > VDL_EVENT_KEEP) a.events.removeAt(a.events.size - 1) }
            }
            a.stations[gs.addr] = ms; a.station = gs.addr
        }
    }

    /** The airport a station's XIDs name: its own XID says where it is; one an aircraft sent it only hints. Read again
     *  whenever asked, so the airports arriving after the frames still place it. */
    fun placeStation(gs: VdlStation) {
        val own = xidAirports(gs.xidOwn, lookup).firstOrNull(); val heard = xidAirports(gs.xidHeard, lookup).firstOrNull()
        gs.airport = own ?: heard ?: ""; gs.airportOwn = own != null
    }

    /** Most recently heard first. */
    fun list(): List<VdlAircraft> = aircraft.values.sortedWith(compareByDescending<VdlAircraft> { it.lastMs }.thenBy { it.addr })
    fun stationList(): List<VdlStation> = stations.values.onEach { placeStation(it) }.sortedWith(compareByDescending<VdlStation> { it.lastMs }.thenBy { it.addr })
    /** Aircraft to station pairs heard within [ms] of [now]. */
    fun links(now: Long, ms: Long = VDL_LINK_MS): List<Pair<String, String>> =
        aircraft.values.flatMap { a -> a.stations.filter { now - it.value <= ms }.map { a.addr to it.key } }
    fun clear() { aircraft.clear(); stations.clear(); chans.clear(); frames = 0 }
}

/** The ACARS record of a VDL2 aircraft: by its registration, else its flight. */
fun acarsFor(a: VdlAircraft, planes: Map<String, AcarsPlane>): AcarsPlane? =
    (if (a.reg.isNotEmpty()) planes["R:${a.reg}"] else null) ?: (if (a.flight.isNotEmpty()) planes["F:${a.flight}"] else null)

// ---- activity: messages a minute, by channel, by kind, by airline ----
const val STATS_MINUTES = 30

class AcarsStats {
    /** Messages per minute (keyed by minute since the epoch). */
    val perMin = HashMap<Long, Int>()
    val chans = LinkedHashMap<String, Int>()
    val kinds = LinkedHashMap<String, Int>()
    /** Airline to aircraft keys heard. */
    val airlines = LinkedHashMap<String, MutableSet<String>>()
    var total = 0; private set

    fun add(ms: Long, mhz: String, kind: String, airline: String, planeKey: String) {
        total++
        val min = ms / 60_000
        perMin[min] = (perMin[min] ?: 0) + 1
        perMin.keys.removeAll { it < min - STATS_MINUTES * 2 }
        chans[mhz] = (chans[mhz] ?: 0) + 1
        kinds[kind] = (kinds[kind] ?: 0) + 1
        if (airline.isNotEmpty() && planeKey.isNotEmpty()) airlines.getOrPut(airline) { HashSet() }.add(planeKey)
    }
    /** The last STATS_MINUTES minutes' counts, oldest first, ending at [now]'s minute. */
    fun minutes(now: Long): List<Int> { val end = now / 60_000; return (end - STATS_MINUTES + 1..end).map { perMin[it] ?: 0 } }
    fun topAirlines(n: Int = 6): List<Pair<String, Int>> = airlines.map { it.key to it.value.size }.sortedWith(compareByDescending<Pair<String, Int>> { it.second }.thenBy { it.first }).take(n)
    fun kindList(): List<Pair<String, Int>> = kinds.map { it.key to it.value }.sortedWith(compareByDescending<Pair<String, Int>> { it.second }.thenBy { it.first })
    fun clear() { perMin.clear(); chans.clear(); kinds.clear(); airlines.clear(); total = 0 }
    /** A copy the screen can read while messages keep arriving. */
    fun snapshot(): AcarsStats = AcarsStats().also { c ->
        c.perMin.putAll(perMin); c.chans.putAll(chans); c.kinds.putAll(kinds); for ((k, v) in airlines) c.airlines[k] = HashSet(v); c.total = total
    }
}
