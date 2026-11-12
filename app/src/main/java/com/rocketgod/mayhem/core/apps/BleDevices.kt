package com.rocketgod.mayhem.core.apps

import java.util.Locale
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * BLE devices: one record per advertiser, built from the raw advertising PDUs the receiver hands over.
 *
 * parseAdv() reads a PDU (header, length, AdvA, AD structures) into its fields; classify() names the maker from the
 * Bluetooth SIG company identifier and the kind of device from what it advertises (Apple Continuity types, the
 * tracker services, Eddystone, Fast Pair, the GAP appearance, and last of all the name); BleTracker keeps one device
 * per address with its signal history, packet count and raw advertisements, and raises a tracker alert when a
 * tracker-type device stays with you for 20 minutes or is still there after you have moved.
 *
 * Twin ports: web/src/ble.ts and core/apps/BleDevices.swift (same names, same constants).
 */

private val PDU_TYPES = listOf("ADV_IND", "ADV_DIRECT_IND", "ADV_NONCONN_IND", "SCAN_REQ", "SCAN_RSP", "CONNECT_REQ", "ADV_SCAN_IND")

/** One service-data AD structure: its 16-bit UUID and the bytes after it. */
data class BleSvcData(val uuid: Int, val data: List<Int>)

/** One name and value shown for a device. */
data class BleField(val name: String, val value: String)

/** One advertisement, as read off the air. */
data class BleAdv(
    val pduType: String, val mac: String, val random: Boolean, val db: Double, val ch: Int,
    /** Complete or shortened local name ("" when none). */
    var name: String = "",
    /** Flags AD (-1 when none). */
    var flags: Int = -1,
    /** Company identifier of the manufacturer-specific data (-1 when none) and the bytes after it. */
    var mfr: Int = -1, var mfrData: List<Int> = emptyList(),
    val uuids16: MutableList<Int> = mutableListOf(), val svc: MutableList<BleSvcData> = mutableListOf(),
    /** TX power level in dBm (null when not sent). */
    var txPower: Int? = null,
    /** GAP appearance (-1 when not sent). */
    var appearance: Int = -1,
    /** The whole PDU in hex, header first. */
    val raw: String,
)

private fun hex2(v: Int) = "%02X".format(v and 0xFF)
private fun hex4(v: Int) = "%04X".format(v and 0xFFFF)

/**
 * Reads one advertising PDU: byte 0 the header (type in the low nibble, TxAdd in bit 6), byte 1 the payload length,
 * bytes 2..7 the advertiser's address (least significant byte first), then the AD structures for the PDU types that
 * carry them. Returns null for a PDU too short to hold an address.
 */
fun parseAdv(pdu: IntArray, db: Double, ch: Int): BleAdv? {
    if (pdu.size < 8) return null
    val p = IntArray(pdu.size) { pdu[it] and 0xFF }
    val type = p[0] and 0x0F
    val len = min(p[1] and 0x3F, p.size - 2)
    val end = 2 + len
    val a = BleAdv(
        pduType = PDU_TYPES.getOrElse(type) { "PDU$type" }, mac = intArrayOf(7, 6, 5, 4, 3, 2).joinToString(":") { hex2(p[it]) },
        random = (p[0] and 0x40) != 0, db = db, ch = ch,
        raw = (0 until end).joinToString("") { hex2(p[it]) },
    )
    if (type != 0 && type != 2 && type != 4 && type != 6) return a
    var q = 8
    while (q < end) {
        val l = p[q]
        if (l == 0 || q + 1 + l > end) break
        val ad = p[q + 1]; val ds = q + 2; val dl = l - 1
        val d = (ds until ds + dl).map { p[it] }
        when (ad) {
            0x01 -> if (dl >= 1) a.flags = d[0]
            0x02, 0x03 -> { var i = 0; while (i + 1 < dl) { a.uuids16.add(d[i] or (d[i + 1] shl 8)); i += 2 } }
            0x08, 0x09 -> a.name = String(d.filter { it in 0x20 until 0x7F }.map { it.toChar() }.toCharArray())
            0x0A -> if (dl >= 1) a.txPower = d[0].toByte().toInt()
            0x16 -> if (dl >= 2) a.svc.add(BleSvcData(d[0] or (d[1] shl 8), d.drop(2)))
            0x19 -> if (dl >= 2) a.appearance = d[0] or (d[1] shl 8)
            0xFF -> if (dl >= 2) { a.mfr = d[0] or (d[1] shl 8); a.mfrData = d.drop(2) }
        }
        q += 1 + l
    }
    return a
}

/** The same, for the bytes the decoder hands over. */
fun parseAdv(pdu: ByteArray, db: Double, ch: Int): BleAdv? = parseAdv(IntArray(pdu.size) { pdu[it].toInt() and 0xFF }, db, ch)

/** Bluetooth SIG company identifiers seen most often in the wild. */
private val COMPANIES: List<Pair<Int, String>> = listOf(
    0x0000 to "Ericsson", 0x0002 to "Intel", 0x0006 to "Microsoft", 0x000A to "Qualcomm", 0x000D to "Texas Instruments",
    0x000F to "Broadcom", 0x001D to "Qualcomm", 0x0046 to "MediaTek", 0x004C to "Apple", 0x0057 to "Harman",
    0x0059 to "Nordic Semiconductor", 0x005D to "Realtek", 0x0075 to "Samsung", 0x0078 to "Nike", 0x0087 to "Garmin",
    0x009E to "Bose", 0x00C4 to "LG Electronics", 0x00E0 to "Google", 0x0131 to "Cypress", 0x0157 to "Huami (Amazfit)",
    0x0171 to "Amazon", 0x01DA to "Logitech", 0x027D to "Huawei", 0x02E5 to "Espressif", 0x038F to "Xiaomi",
    0x0499 to "Ruuvi", 0x05A7 to "Sonos",
)

/** The maker for a company identifier ("" when unknown). */
fun companyName(id: Int): String {
    for ((k, v) in COMPANIES) if (k == id) return v
    return ""
}

/** Service UUIDs that name their maker on their own. */
private val SERVICE_MAKERS: List<Pair<Int, String>> = listOf(
    0xFEAA to "Google", 0xFE2C to "Google", 0xFD5A to "Samsung", 0xFEED to "Tile", 0xFEEC to "Tile", 0xFD84 to "Tile",
    0xFE9F to "Google", 0xFD6F to "Exposure Notification",
)

enum class BleKind { AIRTAG, FINDMY, TILE, SMARTTAG, FINDHUB, PHONE, COMPUTER, EARBUDS, AUDIO, WATCH, IBEACON, EDDYSTONE, HID, TV, DEVICE }

/** What each kind is called on a card. */
val KIND_LABEL: Map<BleKind, String> = mapOf(
    BleKind.AIRTAG to "AirTag / Find My", BleKind.FINDMY to "Find My", BleKind.TILE to "Tile", BleKind.SMARTTAG to "SmartTag",
    BleKind.FINDHUB to "Find Hub tag", BleKind.PHONE to "Phone", BleKind.COMPUTER to "Computer", BleKind.EARBUDS to "Earbuds",
    BleKind.AUDIO to "Speaker", BleKind.WATCH to "Watch", BleKind.IBEACON to "iBeacon", BleKind.EDDYSTONE to "Eddystone",
    BleKind.HID to "Keyboard / mouse", BleKind.TV to "TV / AirPlay", BleKind.DEVICE to "Device",
)
fun kindLabel(k: BleKind): String = KIND_LABEL[k] ?: "Device"

/** The kinds that exist to be carried and found: the ones a tracker alert is raised for. */
val TRACKER_KINDS: List<BleKind> = listOf(BleKind.AIRTAG, BleKind.FINDMY, BleKind.TILE, BleKind.SMARTTAG, BleKind.FINDHUB)

data class BleClass(val maker: String, val kind: BleKind, val tracker: Boolean, /** One line on what gave it away. */ val why: String, val extra: List<BleField>)

private val EDDY_SCHEME = listOf("http://www.", "https://www.", "http://", "https://")
private val EDDY_TLD = listOf(".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/", ".com", ".org", ".edu", ".net", ".info", ".biz", ".gov")

/** An Eddystone-URL frame's URL (frame type 0x10: tx power, scheme, encoded text). */
fun eddystoneUrl(d: List<Int>): String {
    if (d.size < 3 || d[0] != 0x10) return ""
    val s = StringBuilder(EDDY_SCHEME.getOrElse(d[2]) { "" })
    for (i in 3 until d.size) s.append(if (d[i] < EDDY_TLD.size) EDDY_TLD[d[i]] else d[i].toChar().toString())
    return s.toString()
}

/** GAP appearance category (the value's top 10 bits) to a kind, or null when it says nothing useful. */
private fun appearanceKind(app: Int): BleKind? = when (app shr 6) {
    1 -> BleKind.PHONE
    2 -> BleKind.COMPUTER
    3 -> BleKind.WATCH
    15 -> BleKind.HID
    33 -> BleKind.AUDIO
    37 -> BleKind.EARBUDS
    else -> null
}

private val NAME_KINDS: List<Pair<Regex, BleKind>> = listOf(
    Regex("airpods|buds|beats|earbud|headphone|headset|wh-1000|wf-1000|jabra") to BleKind.EARBUDS,
    Regex("watch|band \\d|fitbit|forerunner|fenix|venu|amazfit|mi band|whoop") to BleKind.WATCH,
    Regex("iphone|pixel|galaxy|oneplus|moto") to BleKind.PHONE,
    Regex("macbook|imac|laptop|desktop|-pc\\b|thinkpad") to BleKind.COMPUTER,
    Regex("keyboard|mouse|mx master|trackpad") to BleKind.HID,
    Regex("\\btv\\b|roku|chromecast|fire tv|bravia") to BleKind.TV,
    Regex("speaker|soundbar|sonos|jbl|bose|ue boom") to BleKind.AUDIO,
    Regex("^tile\\b") to BleKind.TILE,
)

/** Last resort: what the name says. */
private fun nameKind(name: String): BleKind? {
    val n = name.lowercase(Locale.US)
    if (n.isEmpty()) return null
    for ((re, k) in NAME_KINDS) if (re.containsMatchIn(n)) return k
    return null
}

/** The maker and kind of an advertiser, from everything in one advertisement. */
fun classify(a: BleAdv): BleClass {
    val extra = mutableListOf<BleField>()
    var maker = if (a.mfr >= 0) companyName(a.mfr) else ""
    if (maker.isEmpty()) for (s in a.svc.map { it.uuid } + a.uuids16) { val m = SERVICE_MAKERS.firstOrNull { it.first == s }; if (m != null) { maker = m.second; break } }
    fun make(kind: BleKind, why: String) = BleClass(maker, kind, kind in TRACKER_KINDS, why, extra)
    // Apple Continuity: the first byte after the company ID is the message type
    if (a.mfr == 0x004C && a.mfrData.size >= 2) {
        val d = a.mfrData; val t = d[0]; val l = d[1]
        when (t) {
            0x12 -> {
                extra.add(BleField("Find My status", "0x${hex2(d.getOrElse(2) { 0 })}"))
                return if (l >= 0x19) make(BleKind.AIRTAG, "Find My, away from its owner (full key)") else make(BleKind.FINDMY, "Find My, near its owner")
            }
            0x02 -> if (l == 0x15 && d.size >= 23) {
                val u = d.subList(2, 18).joinToString("") { hex2(it) }
                extra.add(BleField("UUID", "${u.substring(0, 8)}-${u.substring(8, 12)}-${u.substring(12, 16)}-${u.substring(16, 20)}-${u.substring(20)}"))
                extra.add(BleField("Major", ((d[18] shl 8) or d[19]).toString())); extra.add(BleField("Minor", ((d[20] shl 8) or d[21]).toString()))
                extra.add(BleField("Power at 1 m", "${d[22].toByte().toInt()} dBm"))
                return make(BleKind.IBEACON, "iBeacon")
            }
            0x07 -> return make(BleKind.EARBUDS, "Apple proximity pairing (AirPods / Beats)")
            0x10 -> return make(BleKind.PHONE, "Apple Nearby Info (iPhone, iPad or Mac)")
            0x0C -> return make(BleKind.PHONE, "Apple Handoff")
            0x0F -> return make(BleKind.PHONE, "Apple Nearby Action")
            0x05 -> return make(BleKind.PHONE, "AirDrop")
            0x09 -> return make(BleKind.TV, "AirPlay target")
        }
    }
    if (a.mfr == 0x0006 && a.mfrData.isNotEmpty()) {
        if (a.mfrData[0] == 0x01) return make(BleKind.COMPUTER, "Microsoft CDP beacon (Windows)")
        if (a.mfrData[0] == 0x03) return make(appearanceKind(a.appearance) ?: BleKind.HID, "Microsoft Swift Pair")
    }
    for (s in a.svc) {
        if (s.uuid == 0xFEAA && s.data.isNotEmpty()) {
            val f = s.data[0]
            if (f == 0x40 || f == 0x41) return make(BleKind.FINDHUB, "Google Find Hub network")
            if (f == 0x10) { val url = eddystoneUrl(s.data); if (url.isNotEmpty()) extra.add(BleField("URL", url)); return make(BleKind.EDDYSTONE, "Eddystone-URL") }
            if (f == 0x00 && s.data.size >= 18) {
                extra.add(BleField("Namespace", s.data.subList(2, 12).joinToString("") { hex2(it) }))
                extra.add(BleField("Instance", s.data.subList(12, 18).joinToString("") { hex2(it) }))
                return make(BleKind.EDDYSTONE, "Eddystone-UID")
            }
            if (f == 0x20) return make(BleKind.EDDYSTONE, "Eddystone-TLM")
            if (f == 0x30) return make(BleKind.EDDYSTONE, "Eddystone-EID")
        }
        if (s.uuid == 0xFD5A) return make(BleKind.SMARTTAG, "Samsung SmartTag")
        if (s.uuid == 0xFE2C) return make(appearanceKind(a.appearance) ?: BleKind.EARBUDS, "Google Fast Pair")
    }
    val all16 = a.uuids16 + a.svc.map { it.uuid }
    if (all16.any { it == 0xFEED || it == 0xFEEC || it == 0xFD84 }) return make(BleKind.TILE, "Tile service")
    if (0xFD5A in all16) return make(BleKind.SMARTTAG, "Samsung SmartTag")
    val ak = appearanceKind(a.appearance)
    if (ak != null) return make(ak, "appearance 0x${hex4(a.appearance)}")
    val nk = nameKind(a.name)
    if (nk != null) return make(nk, "by its name")
    return make(BleKind.DEVICE, if (maker.isNotEmpty()) "manufacturer data" else "nothing recognizable")
}

/** A tracker-type device seen this long is worth a look. */
const val TRACKER_ALERT_MS = 20 * 60_000L
/** Or one still heard after you have moved this far. */
const val TRACKER_MOVE_M = 500.0
/** How many signal readings and raw advertisements each device keeps. */
const val RSSI_KEEP = 40
const val HISTORY_KEEP = 60

/** A position: latitude and longitude in degrees. */
data class BlePos(val lat: Double, val lon: Double)

data class BleHeard(val ms: Long, val ch: Int, val db: Double, val pduType: String, val raw: String)

data class BleDevice(
    val mac: String, val random: Boolean, var name: String, var maker: String, var kind: BleKind, var tracker: Boolean, var why: String,
    val firstMs: Long, var lastMs: Long, var count: Int,
    val rssi: MutableList<Int>, val history: MutableList<BleHeard>,
    /** Every field from the latest advertisement (and the name, which may come in a scan response). */
    var fields: List<BleField>,
    /** Where you were when it was first and last heard (null without a position). */
    var firstPos: BlePos?, var lastPos: BlePos?,
    /** The farthest you have been from firstPos while still hearing it, in meters. */
    var movedM: Double,
    /** Why it is flagged ("" when it is not). */
    var alert: String,
) {
    /** A copy whose lists the tracker no longer writes to, for a screen to read while packets keep arriving. */
    fun snapshot(): BleDevice = copy(rssi = rssi.toMutableList(), history = history.toMutableList())
}

/** Great-circle distance in meters. */
fun distM(a: BlePos, b: BlePos): Double {
    val r = PI / 180; val dLat = (b.lat - a.lat) * r; val dLon = (b.lon - a.lon) * r
    val h = sin(dLat / 2) * sin(dLat / 2) + cos(a.lat * r) * cos(b.lat * r) * sin(dLon / 2) * sin(dLon / 2)
    return 2 * 6_371_000 * asin(min(1.0, sqrt(h)))
}

/** The tracker alert for a device as of now ("" when none). */
fun trackerAlert(d: BleDevice): String {
    if (!d.tracker) return ""
    val mins = floor((d.lastMs - d.firstMs) / 60_000.0).toLong()
    val label = kindLabel(d.kind).uppercase(Locale.US)
    if (d.movedM >= TRACKER_MOVE_M) return "$label MOVING WITH YOU · ${String.format(Locale.US, "%.1f", d.movedM / 1000)} km · $mins min"
    if (d.lastMs - d.firstMs >= TRACKER_ALERT_MS) return "$label NEAR YOU FOR $mins MIN"
    return ""
}

/** One device per advertiser address. */
class BleTracker {
    val devices = LinkedHashMap<String, BleDevice>()

    /** Adds an advertisement heard at nowMs (pos: where you are, when known); returns its device. */
    fun add(a: BleAdv, nowMs: Long, pos: BlePos? = null): BleDevice {
        val c = classify(a)
        val d = devices.getOrPut(a.mac) {
            BleDevice(a.mac, a.random, "", "", BleKind.DEVICE, false, "", nowMs, nowMs, 0, mutableListOf(), mutableListOf(), emptyList(), pos, pos, 0.0, "")
        }
        d.count++; d.lastMs = nowMs
        if (a.name.isNotEmpty()) d.name = a.name
        // a scan response or a bare advertisement says less than the one before it: keep what was learned
        if (c.maker.isNotEmpty()) d.maker = c.maker
        if (c.kind != BleKind.DEVICE || d.kind == BleKind.DEVICE) { d.kind = c.kind; d.tracker = c.tracker; d.why = c.why }
        d.rssi.add(Math.round(a.db).toInt()); if (d.rssi.size > RSSI_KEEP) d.rssi.removeAt(0)
        d.history.add(BleHeard(nowMs, a.ch, a.db, a.pduType, a.raw)); if (d.history.size > HISTORY_KEEP) d.history.removeAt(0)
        if (pos != null) {
            val first = d.firstPos ?: pos.also { d.firstPos = it }
            d.lastPos = pos
            d.movedM = max(d.movedM, distM(first, pos))
        }
        d.fields = advFields(a, c, d)
        d.alert = trackerAlert(d)
        return d
    }

    /** Devices in a steady order (cards do not jump about as packets arrive): the ones with an alert first, then in the
     *  order they were first heard. */
    fun list(): List<BleDevice> = devices.values.sortedWith(
        compareByDescending<BleDevice> { if (it.alert.isNotEmpty()) 1 else 0 }.thenBy { it.firstMs }.thenBy { it.mac })

    fun clear() { devices.clear() }
}

/** Every field worth showing for one device. */
private fun advFields(a: BleAdv, c: BleClass, d: BleDevice): List<BleField> {
    val f = mutableListOf<BleField>()
    f.add(BleField("Address", "${a.mac} · ${if (a.random) "random" else "public"}"))
    if (d.name.isNotEmpty()) f.add(BleField("Name", d.name))
    f.add(BleField("Maker", d.maker.ifEmpty { "unknown" }))
    f.add(BleField("Type", "${kindLabel(d.kind)} · ${d.why}"))
    f.add(BleField("Last PDU", "${a.pduType} · channel ${a.ch}"))
    f.add(BleField("Signal", "${Math.round(a.db)} dB"))
    if (a.flags >= 0) f.add(BleField("Flags", "0x${hex2(a.flags)}${if (a.flags and 0x04 != 0) " · BLE only" else ""}${if (a.flags and 0x02 != 0) " · discoverable" else ""}"))
    a.txPower?.let { f.add(BleField("TX power", "$it dBm")) }
    if (a.appearance >= 0) f.add(BleField("Appearance", "0x${hex4(a.appearance)}"))
    if (a.mfr >= 0) f.add(BleField("Manufacturer data", "0x${hex4(a.mfr)}${companyName(a.mfr).let { if (it.isNotEmpty()) " $it" else "" }} · ${a.mfrData.joinToString(" ") { hex2(it) }}"))
    if (a.uuids16.isNotEmpty()) f.add(BleField("Services", a.uuids16.joinToString(" ") { "0x${hex4(it)}" }))
    for (s in a.svc) f.add(BleField("Service data 0x${hex4(s.uuid)}", s.data.joinToString(" ") { hex2(it) }.ifEmpty { "—" }))
    f.addAll(c.extra)
    f.add(BleField("Packets", d.count.toString()))
    return f
}
