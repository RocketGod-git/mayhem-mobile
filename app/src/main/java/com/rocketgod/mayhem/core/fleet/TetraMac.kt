package com.rocketgod.mayhem.core.fleet

/**
 * TETRA downlink above the physical layer (ETSI EN 300 392-2), receive only.
 *
 *  - The AACH's ACCESS-ASSIGN PDU (21.4.7.2, Tables 21.82 and 21.83): what each downlink slot carries (common or
 *    assigned control, unallocated, or traffic with its usage marker).
 *  - Which logical channels a burst carries (9.5.1, Tables 9.13 and 9.28): a synchronization burst has the BSCH and
 *    an SCH/HD (or BNCH) in block 2; a normal burst with training sequence 1 is a full slot (SCH/F, or TCH on a slot
 *    the AACH marks traffic), with training sequence 2 two half slots (SCH/HD and SCH/HD or BNCH; on a traffic slot
 *    the STCH steals the first half, and the second half too when the first says so).
 *  - The MAC PDUs (21.4): MAC-RESOURCE (Table 21.55) with its address, encryption mode and channel allocation
 *    (21.5.2, Table 21.87), MAC-FRAG and MAC-END (Tables 21.57 and 21.59) with the fragments put back together per
 *    timeslot, SYSINFO (Table 21.65, with D-MLE-SYSINFO of 18.4.2.2 and the BS service details of 18.5.2.1) and
 *    ACCESS-DEFINE (Table 21.79). Several PDUs in one block (association, 23.4.2.3), fill bits taken off (23.4.3.2),
 *    lengths in octets on a pi/4-DQPSK channel (21.6, Table 21.98).
 *  - LLC basic link PDUs (21.2.1, Table 21.1; 21.2.2), the MLE protocol discriminator (18.5.21, Table 18.87).
 *  - CMCE (14.7.1, the elements of 14.8, encoded as annex E says): D-SETUP, D-CONNECT, D-TX GRANTED, D-TX CEASED,
 *    D-RELEASE, D-DISCONNECT, D-CALL RESTORE, D-SDS-DATA, D-STATUS and the rest by name; SDS-TL text messaging
 *    (29.4.2.4, 29.5.2, 29.5.3). MM by name (16.10.39), with the unit a location update accepts.
 *  - The security information of the extended services broadcast (EN 300 392-7 A.8.77, Table A.104) and the
 *    encryption mode of MAC-RESOURCE (EN 300 392-7 6.5.1): a TM-SDU whose encryption mode is not 00 is encrypted on
 *    the air interface and is not read.
 */
/** A cursor over bits (one per element, most significant first). Reading past the end throws. */
class TetraBits(val b: IntArray, var pos: Int = 0, var end: Int = b.size) {
    val left: Int get() = end - pos
    fun u(n: Int): Int { if (pos + n > end) throw IndexOutOfBoundsException("short"); var v = 0; for (i in 0 until n) v = v * 2 + (b[pos++] and 1); return v }
    /** A type 2 element: its presence bit, then its value (-1 when absent). */
    fun p(n: Int): Int = if (u(1) != 0) u(n) else -1
}
/** Fill bits taken off the end of a PDU (23.4.3.2): the last 1 and the zeros after it. */
fun tetraUnfill(b: IntArray, from: Int, to: Int): Int { var k = to - 1; while (k >= from && b[k] == 0) k--; return if (k >= from) k else from }

/** The channel allocation element (21.5.2, Table 21.87). [tn] is its lowest timeslot (1 to 4), 0 for "the MCCH". */
class TetraChanAlloc(val type: Int, val slots: Int, val tn: Int, val updown: Int, val clch: Int, val cellChange: Int, val carrier: Int,
                     val band: Int, val offset: Int, val duplex: Int, val reverse: Int, val monitoring: Int)
private fun chanAlloc(r: TetraBits): TetraChanAlloc {
    val type = r.u(2); val slots = r.u(4); val updown = r.u(2); val clch = r.u(1); val cellChange = r.u(1); val carrier = r.u(12)
    var band = -1; var offset = -1; var duplex = -1; var reverse = -1
    if (r.u(1) != 0) { band = r.u(4); offset = r.u(2); duplex = r.u(3); reverse = r.u(1) }
    val monitoring = r.u(2)
    if (monitoring == 0) r.u(2)
    if (updown == 0) {
        // augmented channel allocation
        r.u(2); r.u(3); r.u(3); r.u(3); r.u(3); r.u(4); r.u(5)
        val nap = r.u(2); if (nap == 1) r.u(11)
        r.u(4); if (r.u(1) != 0) r.u(16); if (r.u(1) != 0) r.u(16); r.u(1)
    }
    val tn = if (slots == 0) 0 else (1..4).firstOrNull { (slots shr (4 - it)) and 1 != 0 } ?: 0
    return TetraChanAlloc(type, slots, tn, updown, clch, cellChange, carrier, band, offset, duplex, reverse, monitoring)
}
/** A carrier number to its downlink frequency (Hz): base = band x 100 MHz (TS 100 392-15), 25 kHz steps, offset. */
fun tetraCarrierHz(carrier: Int, band: Int, offset: Int): Double = band * 100e6 + carrier * 25e3 + intArrayOf(0, 6250, -6250, 12500)[offset and 3]

class TetraServices(val registration: Boolean, val deregistration: Boolean, val priority: Boolean, val minimumMode: Boolean, val migration: Boolean, val systemWide: Boolean,
                    val voice: Boolean, val data: Boolean, val sndcp: Boolean, val aie: Boolean, val advancedLink: Boolean)
class TetraSecurity(val auth: Boolean, val class1: Boolean, val class3: Boolean, val sckn: Int)
/** SYSINFO with its D-MLE-SYSINFO. */
class TetraSysinfo(
    val mainCarrier: Int, val band: Int, val offset: Int, val duplex: Int, val reverse: Int, val scch: Int,
    val msTxPwr: Int, val rxLevMin: Int, val accessParam: Int, val radioDlTimeout: Int,
    /** The hyperframe number, or the common cipher key identifier (or static cipher key version) when [cck]. */
    val cck: Boolean, val hyperframe: Int, val optFlag: Int,
    val la: Int, val subscriberClass: Int, val services: TetraServices,
    /** The security information of the extended services broadcast (when that option is sent). */
    val security: TetraSecurity?, val mainHz: Double,
)
private fun sysinfo(r: TetraBits): TetraSysinfo {
    val mainCarrier = r.u(12); val band = r.u(4); val offset = r.u(2); val duplex = r.u(3); val reverse = r.u(1); val scch = r.u(2); val msTxPwr = r.u(3); val rxLevMin = r.u(4); val accessParam = r.u(4); val radioDlTimeout = r.u(4)
    val cck = r.u(1) == 1; val hyperframe = r.u(16); val optFlag = r.u(2)
    var security: TetraSecurity? = null
    if (optFlag == 3) {
        val auth = r.u(1) == 1; val class1 = r.u(1) == 1; val class3 = r.u(1) == 1; val rest = r.u(5)
        security = TetraSecurity(auth, class1, class3, if (class3) -1 else rest)
        r.u(12)
    } else r.u(20)
    val la = r.u(14); val subscriberClass = r.u(16)
    val s = BooleanArray(12) { r.u(1) == 1 }
    return TetraSysinfo(mainCarrier, band, offset, duplex, reverse, scch, msTxPwr, rxLevMin, accessParam, radioDlTimeout, cck, hyperframe, optFlag, la, subscriberClass,
        TetraServices(s[0], s[1], s[2], !s[3], s[4], s[5], s[6], s[7], s[9], s[10], s[11]), security, if (band > 0) tetraCarrierHz(mainCarrier, band, offset) else 0.0)
}

/** What a MAC-RESOURCE (or a MAC-END completing one) said about the PDU it carries. */
class TetraMacInfo(
    /** 1 SSI, 2 event label, 3 USSI, 4 SMI, 5 SSI + event label, 6 SSI + usage marker, 7 SMI + event label. */
    val addrType: Int, val ssi: Int, val um: Int, val enc: Int, val chan: TetraChanAlloc?, val tn: Int, val fn: Int,
) { fun with(chan: TetraChanAlloc?) = TetraMacInfo(addrType, ssi, um, enc, chan, tn, fn) }
val TETRA_CMCE_NAMES = arrayOf("D-ALERT", "D-CALL PROCEEDING", "D-CONNECT", "D-CONNECT ACKNOWLEDGE", "D-DISCONNECT", "D-INFO", "D-RELEASE", "D-SETUP", "D-STATUS", "D-TX CEASED", "D-TX CONTINUE", "D-TX GRANTED", "D-TX WAIT", "D-TX INTERRUPT", "D-CALL RESTORE", "D-SDS-DATA", "D-FACILITY")
val TETRA_MM_NAMES = arrayOf("D-OTAR", "D-AUTHENTICATION", "D-CK CHANGE DEMAND", "D-DISABLE", "D-ENABLE", "D-LOCATION UPDATE ACCEPT", "D-LOCATION UPDATE COMMAND", "D-LOCATION UPDATE REJECT", "MM 8", "D-LOCATION UPDATE PROCEEDING", "D-ATTACH/DETACH GROUP IDENTITY", "D-ATTACH/DETACH GROUP IDENTITY ACK", "D-MM STATUS", "MM 13", "MM 14", "MM FUNCTION NOT SUPPORTED")
private val DISCONNECT = arrayOf("cause unknown", "user requested", "called party busy", "called party not reachable", "called party does not support encryption", "congestion", "traffic case not allowed", "incompatible traffic case",
    "service not available", "pre-emptive use of resource", "invalid call identifier", "call rejected", "no idle CC entity", "timer expired", "SwMI requested", "acknowledged service not completed", "unknown TETRA identity",
    "SS-specific", "unknown external subscriber", "call restoration failed", "called party requires encryption", "concurrent set-up not supported", "same DM-GATE", "non-call owner requested")
fun tetraDisconnectCause(c: Int): String = DISCONNECT.getOrNull(c) ?: "cause $c"
/** Basic service information (14.8.2): circuit mode type, end-to-end encryption flag, communication type. */
class TetraBasic(val mode: Int, val e2ee: Boolean, val comm: Int, val speech: Int)
private fun basic(v: Int) = TetraBasic(v shr 5, (v shr 4) and 1 == 1, (v shr 2) and 3, v and 3)
class TetraSds(val from: Int, var kind: String, var text: String, val hex: String, val status: Int, var protocol: Int)
/** One CMCE PDU, its fields as far as they apply (-1 where not sent). */
class TetraCmce(val type: Int, val name: String) {
    var callId = -1; var grant = -1; var reqPerm = -1; var basic: TetraBasic? = null; var prio = -1
    var calling = -1; var talker = -1; var cause = -1; var newCallId = -1; var encCtl = -1; var timeout = -1; var duplex = -1; var sds: TetraSds? = null
}
private val GRANTS = arrayOf("granted", "not granted", "queued", "granted to another")
fun tetraGrantName(g: Int): String = GRANTS.getOrNull(g) ?: ""
private val COMM = arrayOf("individual", "group", "group acknowledged", "broadcast")
fun tetraCommName(c: Int): String = COMM.getOrNull(c) ?: ""
/** Text in one of the SDS-TL text coding schemes (29.5.4.1): 8-bit Latin alphabets read as Latin 1, UCS-2, 7-bit GSM. */
private fun sdsText(r: TetraBits, scheme: Int): String {
    val n = r.left; val sb = StringBuilder()
    if (scheme == 0) {
        // the 7-bit alphabet (29.5.4.3), its printable characters read as ASCII
        var i = 0
        while (i + 7 <= n) { val c = r.u(7); sb.append(when { c == 0 -> '@'; c == 2 -> '$'; c in 32..126 -> c.toChar(); c == 10 || c == 13 -> ' '; else -> '?' }); i += 7 }
        return sb.toString().trim()
    }
    if (scheme == 26) { var i = 0; while (i + 16 <= n) { sb.append(r.u(16).toChar()); i += 16 }; return sb.toString().trim() }
    var i = 0
    while (i + 8 <= n) { val c = r.u(8); if (c >= 32 && c != 127) sb.append(c.toChar()) else if (c == 10 || c == 13) sb.append(' '); i += 8 }
    return sb.toString().trim()
}
/** The user defined data of a D-SDS-DATA (its type 4 data): text messaging read, the rest kept as hex. */
private fun sdsData(r: TetraBits, bits: Int, from: Int): TetraSds {
    val start = r.pos; val end = minOf(r.end, start + bits)
    val hex = StringBuilder(); run { val q = TetraBits(r.b, start, end); while (q.left >= 4) hex.append(Integer.toHexString(q.u(4))) }
    val out = TetraSds(from, "data", "", hex.toString().uppercase(), -1, -1)
    if (bits < 8) return out
    val q = TetraBits(r.b, start, end); val pid = q.u(8); out.protocol = pid
    try {
        if (pid == 0x02 || pid == 0x09) { q.u(1); val tcs = q.u(7); out.kind = "text"; out.text = sdsText(q, tcs) }
        else if (pid == 0x82 || pid == 0x89) {
            val mt = q.u(4)
            if (mt != 0) { out.kind = "report"; return out }
            q.u(2); q.u(1); val store = q.u(1); q.u(8)
            if (store != 0) {
                q.u(5); val fat = q.u(3)
                when (fat) { 0 -> q.u(8); 1 -> q.u(24); 2 -> { q.u(24); q.u(24) }; 3 -> { val d = q.u(8); repeat(d + (d and 1)) { q.u(4) } } }
            }
            val ts = q.u(1); val tcs = q.u(7); if (ts != 0) q.u(24)
            out.kind = "text"; out.text = sdsText(q, tcs)
        } else out.kind = "protocol $pid"
    } catch (_: IndexOutOfBoundsException) { /* a short PDU: what was read stays */ }
    return out
}
private fun cmce(r: TetraBits): TetraCmce {
    val type = r.u(5)
    val c = TetraCmce(type, TETRA_CMCE_NAMES.getOrNull(type) ?: "CMCE $type")
    fun party(): Int { val t = r.p(2); if (t == 1 || t == 2) { val ssi = r.u(24); if (t == 2) r.u(24); return ssi }; return -1 }
    try {
        when (type) {
            0 -> { c.callId = r.u(14); r.u(3); r.u(1); c.duplex = r.u(1); r.u(1); if (r.u(1) != 0) { val b = r.p(8); if (b >= 0) c.basic = basic(b) } }
            1 -> { c.callId = r.u(14); r.u(3); r.u(1); c.duplex = r.u(1); if (r.u(1) != 0) { val b = r.p(8); if (b >= 0) c.basic = basic(b) } }
            2 -> {
                c.callId = r.u(14); c.timeout = r.u(4); r.u(1); c.duplex = r.u(1); c.grant = r.u(2); c.reqPerm = r.u(1); r.u(1)
                if (r.u(1) != 0) { c.prio = r.p(4); val b = r.p(8); if (b >= 0) c.basic = basic(b); r.p(24); r.p(6) }
            }
            3 -> { c.callId = r.u(14); c.timeout = r.u(4); c.grant = r.u(2); c.reqPerm = r.u(1) }
            4, 6 -> { c.callId = r.u(14); c.cause = r.u(5) }
            5 -> c.callId = r.u(14)
            7 -> {
                c.callId = r.u(14); c.timeout = r.u(4); r.u(1); c.duplex = r.u(1); c.basic = basic(r.u(8)); c.grant = r.u(2); c.reqPerm = r.u(1); c.prio = r.u(4)
                if (r.u(1) != 0) { r.p(6); r.p(24); c.calling = party() }
            }
            8, 15 -> {
                val t = r.u(2); var from = -1; if (t == 1 || t == 2) { from = r.u(24); if (t == 2) r.u(24) }
                c.calling = from
                if (type == 8) { val st = r.u(16); c.sds = TetraSds(from, "status", "", Integer.toHexString(st).uppercase().padStart(4, '0'), st, -1) }
                else { val sdti = r.u(2); val len = if (sdti == 3) r.u(11) else intArrayOf(16, 32, 64)[sdti]; c.sds = sdsData(r, len, from) }
            }
            9 -> { c.callId = r.u(14); c.reqPerm = r.u(1) }
            10 -> { c.callId = r.u(14); r.u(1); c.reqPerm = r.u(1) }
            11, 13 -> {
                c.callId = r.u(14); c.grant = r.u(2); c.reqPerm = r.u(1); c.encCtl = r.u(1); r.u(1)
                if (r.u(1) != 0) { r.p(6); c.talker = party() }
            }
            12 -> { c.callId = r.u(14); c.reqPerm = r.u(1) }
            14 -> {
                c.callId = r.u(14); c.grant = r.u(2); c.reqPerm = r.u(1); r.u(1)
                if (r.u(1) != 0) { c.newCallId = r.p(14); c.timeout = r.p(4); r.p(3); r.p(9); r.p(6) }
            }
        }
    } catch (_: IndexOutOfBoundsException) { /* a PDU cut short: the fields read so far stand */ }
    return c
}

/** What the MAC layer passes up. */
sealed class TetraEvent {
    class Sysinfo(val info: TetraSysinfo, val tn: Int) : TetraEvent()
    class Access(val text: String) : TetraEvent()
    class Cmce(val pdu: TetraCmce, val mac: TetraMacInfo) : TetraEvent()
    class Mm(val name: String, val type: Int, val mac: TetraMacInfo) : TetraEvent()
    class Other(val name: String, val mac: TetraMacInfo) : TetraEvent()
    /** A TM-SDU encrypted on the air interface (encryption mode not 00): not readable. */
    class Encrypted(val mac: TetraMacInfo) : TetraEvent()
    /** A MAC-RESOURCE that allocates a channel or a usage marker and carries nothing else. */
    class Alloc(val mac: TetraMacInfo) : TetraEvent()
    /** Speech frames of a traffic slot (137 bits each; an empty frame is a bad or stolen one). */
    class Voice(val tn: Int, val um: Int, val frames: List<IntArray>) : TetraEvent()
    class Aach(val tn: Int, val fn: Int, val usage: Int) : TetraEvent()
}

private val LLC_FCS = setOf(4, 5, 6, 7)
private val AL_NAMES = arrayOf("AL-SETUP", "AL-DATA", "AL-UDATA", "AL-ACK", "AL-RECONNECT", "AL SUPPLEMENTARY", "LAYER 2 SIGNALLING", "AL-DISC")

/**
 * The MAC of one carrier: the receiver's bursts in, what they carry out. The color code comes from the carrier's own
 * synchronization bursts, or from the cell it belongs to ([setCell]).
 */
class TetraMac(rx: TetraRx?) {
    var onEvent: (TetraEvent) -> Unit = {}
    private var e: IntArray? = null
    /** Per timeslot: the downlink usage marker last read on its AACH (-1 unknown) and the slot count then. */
    private val usage = IntArray(5) { -1 }; private val usageAt = IntArray(5)
    private class Frag(val mac: TetraMacInfo, val bits: ArrayList<Int>)
    private val frag = HashMap<Int, Frag>()
    private var slots = 0
    class Stats { var blocks = 0; var crcOk = 0; var voice = 0; var aachOk = 0 }
    val stats = Stats()
    init { if (rx != null) rx.onBurst = { burst(it) } }
    fun setCell(mcc: Int, mnc: Int, cc: Int) { e = tetraColorBits(mcc, mnc, cc) }
    val cellKnown: Boolean get() = e != null
    fun burst(b: TetraBurst) {
        slots++
        b.sync?.let { setCell(it.mcc, it.mnc, it.colorCode) }
        val e = this.e ?: return
        val s = b.soft; val tn = b.tn; val fn = b.fn
        // the AACH: 30 bits of the broadcast block
        val bb = if (b.kind == "sync") s.copyOfRange(252, 282) else s.copyOfRange(230, 244) + s.copyOfRange(266, 282)
        val acc = tetraAach(bb, e)
        if (acc != null) {
            stats.aachOk++
            val hdr = acc shr 12; val f1 = (acc shr 6) and 63
            // frames 1 to 17 say what the downlink slot carries; frame 18 is the control frame
            val use = if (fn == 18) 2 else if (hdr == 0) 2 else f1
            usage[tn] = use; usageAt[tn] = slots
            onEvent(TetraEvent.Aach(tn, fn, use))
        }
        val recent = slots - usageAt[tn] < 72
        val traffic = fn != 18 && recent && usage[tn] >= 4; val um = if (traffic) usage[tn] else -1
        if (b.kind == "sync") { block(s.copyOfRange(282, 498), "hd", tn, fn); return }
        if (b.kind == "n1") {
            val full = s.copyOfRange(14, 230) + s.copyOfRange(282, 498)
            if (traffic) { voice(tn, um, TetraSpeech.full(tetraDescramble(full, e)), false); return }
            block(full, "f", tn, fn)
            return
        }
        // two half slots: on a traffic slot the first is stolen for signalling, and the second too when the first says so
        val stolen2 = block(s.copyOfRange(14, 230), if (traffic) "stch" else "hd", tn, fn)
        if (traffic && !stolen2) {
            val h = TetraSpeech.half(tetraDescramble(s.copyOfRange(282, 498), e))
            voice(tn, um, TetraSpeech.Result(listOf(IntArray(0), h.frames[0]), h.bfi), true)
        } else block(s.copyOfRange(282, 498), if (traffic) "stch" else "hd", tn, fn)
    }
    private fun voice(tn: Int, um: Int, sp: TetraSpeech.Result, half: Boolean) {
        stats.voice++
        val frames = sp.frames.mapIndexed { i, f -> if (sp.bfi && (!half || i == 1)) IntArray(0) else f }
        onEvent(TetraEvent.Voice(tn, um, frames))
    }
    /** One MAC block: decoded, then every PDU in it. Returns whether an STCH block says the second half slot is stolen too. */
    private fun block(soft: FloatArray, ch: String, tn: Int, fn: Int): Boolean {
        stats.blocks++
        val bits = (if (ch == "f") tetraSchF(soft, e!!) else tetraSchHd(soft, e!!)) ?: return false
        stats.crcOk++
        return pdus(bits, tn, fn)
    }
    /** The PDUs of a decoded MAC block (exposed for the tests). */
    fun pdus(bits: IntArray, tn: Int, fn: Int): Boolean {
        val n = bits.size; val r = TetraBits(bits)
        var stolen = false
        try {
            while (r.left >= 16) {
                val start = r.pos; val type = r.u(2)
                if (type == 0) {
                    val fill = r.u(1); r.u(1); val enc = r.u(2); r.u(1); val li = r.u(6); val at = r.u(3)
                    if (at == 0) break
                    var ssi = -1; var um = -1
                    when (at) { 1, 3, 4 -> ssi = r.u(24); 2 -> r.u(10); 5, 7 -> { ssi = r.u(24); r.u(10) }; 6 -> { ssi = r.u(24); um = r.u(6) } }
                    if (r.u(1) != 0) r.u(4)
                    if (r.u(1) != 0) r.u(8)
                    val chan = if (r.u(1) != 0) chanAlloc(r) else null
                    val mac = TetraMacInfo(at, ssi, um, enc, chan, tn, fn)
                    val end = if (li in 1..58) minOf(n, start + 8 * li) else n
                    if (li == 62) stolen = true
                    val sduEnd = if (fill != 0) tetraUnfill(bits, r.pos, end) else end
                    val sdu = ArrayList<Int>(); for (i in r.pos until sduEnd) sdu.add(bits[i])
                    if (li == 63) { frag[tn] = Frag(mac, sdu); break }
                    sdu(mac, sdu)
                    if (end >= n) break
                    r.pos = end
                } else if (type == 1) {
                    if (r.u(1) == 0) {
                        // MAC-FRAG: the rest of the block continues the TM-SDU being put together on this timeslot
                        val fill = r.u(1); val sduEnd = if (fill != 0) tetraUnfill(bits, r.pos, n) else n
                        frag[tn]?.let { f -> for (i in r.pos until sduEnd) f.bits.add(bits[i]) }
                        break
                    }
                    // MAC-END: its last part, and maybe a channel allocation for the whole
                    val fill = r.u(1); r.u(1); val li = r.u(6)
                    if (r.u(1) != 0) r.u(8)
                    val chan = if (r.u(1) != 0) chanAlloc(r) else null
                    val end = if (li in 1..58) minOf(n, start + 8 * li) else n
                    val sduEnd = if (fill != 0) tetraUnfill(bits, r.pos, end) else end
                    val f = frag.remove(tn)
                    if (f != null) { for (i in r.pos until sduEnd) f.bits.add(bits[i]); sdu(f.mac.with(chan ?: f.mac.chan), f.bits) }
                    if (end >= n) break
                    r.pos = end
                } else if (type == 2) {
                    val bt = r.u(2)
                    if (bt == 0) onEvent(TetraEvent.Sysinfo(sysinfo(r), tn))
                    else if (bt == 1) {
                        val common = r.u(1); val code = r.u(2); val imm = r.u(4); val wt = r.u(4); val nu = r.u(4); val flf = r.u(1); val tsp = r.u(4); val pri = r.u(3)
                        onEvent(TetraEvent.Access("ACCESS-DEFINE · ${if (common != 0) "assigned" else "common"} control · access code ${"ABCD"[code]} · IMM $imm · WT $wt · Nu $nu · frame-length x${if (flf != 0) 4 else 1} · timeslots $tsp · minimum priority $pri"))
                    }
                    break
                } else break   // MAC-U-SIGNAL and MAC-D-BLCK carry nothing read here
            }
        } catch (_: IndexOutOfBoundsException) { /* a block that ended mid-PDU */ }
        return stolen
    }
    /** A whole TM-SDU: LLC, then MLE, then CMCE or MM. Encrypted ones go no further. */
    private fun sdu(mac: TetraMacInfo, sdu: List<Int>) {
        if (mac.enc != 0) { onEvent(TetraEvent.Encrypted(mac)); return }
        if (sdu.size < 4) { if (mac.chan != null || mac.um >= 0) onEvent(TetraEvent.Alloc(mac)); return }
        val r = TetraBits(sdu.toIntArray())
        try {
            val llc = r.u(4)
            if (llc >= 8) { onEvent(TetraEvent.Other(AL_NAMES[llc - 8], mac)); return }
            if (llc == 0 || llc == 4) r.u(2) else if (llc == 1 || llc == 5 || llc == 3 || llc == 7) r.u(1)
            if (llc in LLC_FCS) r.end = maxOf(r.pos, r.end - 32)
            if (r.left < 3) { if (mac.chan != null) onEvent(TetraEvent.Alloc(mac)); return }
            when (val pd = r.u(3)) {
                2 -> onEvent(TetraEvent.Cmce(cmce(r), mac))
                1 -> { val t = r.u(4); onEvent(TetraEvent.Mm(TETRA_MM_NAMES[t], t, mac)) }
                else -> onEvent(TetraEvent.Other(arrayOf("", "MM", "CMCE", "MLE 3", "SNDCP", "MLE", "TETRA MANAGEMENT", "TEST")[pd].ifEmpty { "MLE $pd" }, mac))
            }
        } catch (_: IndexOutOfBoundsException) { /* too short to say */ }
    }
}
