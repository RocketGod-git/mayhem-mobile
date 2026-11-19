package com.rocketgod.mayhem.core.fleet

/**
 * DMR control signaling blocks to named fields: the ETSI TS 102 361-2/-4 CSBKs (Tier III Aloha, broadcasts, grants,
 * acknowledgements) and, under feature set ID 0x10, the block formats derived from our own recordings (rest-channel
 * beacon, unit report header and unit report, with the vendor check).
 */
class Csbk(val op: Int, val fid: Int, val last: Boolean, val hex: String,
           /** Checked by its CRC; the derived unit-report formats have none known. */ val verified: Boolean) {
    var name = ""
    val fields = ArrayList<Field>()
    var kind = "other"
    var derived = false
    var sysCode: Int? = null; var net: Int? = null; var site: Int? = null; var model: String? = null
    var lpcn: Int? = null; var slot: Int? = null; var dst: Int? = null; var src: Int? = null; var group: Boolean? = null; var emergency: Boolean? = null
    var rest: Int? = null; var busy: List<Int>? = null; var beaconSlot: Int? = null; var unit: Int? = null; var lcn: Int? = null
    var lonLo: Int? = null; var latLo: Int? = null; var noFix: Boolean = false
}

data class SysCode(val model: String, val net: Int, val site: Int, val par: Int)

object Csbks {
    private val OPS = mapOf(
        0x04 to "UNIT TO UNIT VOICE REQUEST", 0x05 to "UNIT TO UNIT VOICE ANSWER", 0x07 to "CHANNEL TIMING", 0x19 to "ALOHA",
        0x1a to "UNIFIED DATA TRANSPORT HEADER", 0x1c to "AHOY", 0x1e to "ACKNOWLEDGE VITAL", 0x1f to "RANDOM ACCESS REQUEST",
        0x20 to "ACKNOWLEDGE", 0x21 to "ACKNOWLEDGE (TIER II)", 0x24 to "RADIO CHECK", 0x26 to "NEGATIVE ACKNOWLEDGE", 0x27 to "EMERGENCY",
        0x28 to "BROADCAST", 0x2a to "MAINTENANCE", 0x2e to "CLEAR", 0x2f to "PROTECT", 0x30 to "PRIVATE VOICE GRANT", 0x31 to "TALKGROUP VOICE GRANT",
        0x32 to "BROADCAST TALKGROUP VOICE GRANT", 0x33 to "PRIVATE DATA GRANT", 0x34 to "TALKGROUP DATA GRANT", 0x35 to "DUPLEX PRIVATE VOICE GRANT",
        0x36 to "DUPLEX PRIVATE DATA GRANT", 0x38 to "BS OUTBOUND ACTIVATION", 0x39 to "MOVE", 0x3d to "PREAMBLE",
    )
    private val BCAST = mapOf(
        0 to "ANNOUNCE/WITHDRAW CONTROL CHANNEL", 1 to "CALL TIMER PARAMETERS", 2 to "VOTE NOW", 3 to "LOCAL TIME", 4 to "MASS REGISTRATION",
        5 to "CHANNEL FREQUENCY", 6 to "ADJACENT SITE", 7 to "GENERAL SITE PARAMETERS",
    )
    private val MODELS = arrayOf("TINY", "SMALL", "LARGE", "HUGE")
    /** Network and site bits per system identity model (TS 102 361-4 C_SYScode). */
    private val NET_BITS = intArrayOf(9, 7, 4, 2)

    /** The 16-bit system identity code: model, network, site, partition. */
    fun sysCode(c: Int): SysCode {
        val m = c shr 14; val nb = NET_BITS[m]; val sb = 12 - nb
        return SysCode(MODELS[m], (c shr (2 + sb)) and ((1 shl nb) - 1), ((c shr 2) and ((1 shl sb) - 1)) + 1, c and 3)
    }

    /** [verified]: the block passed its CRC. */
    fun parse(b: IntArray, verified: Boolean): Csbk {
        val op = b[0] and 0x3f; val fid = b[1]
        fun f(from: Int, n: Int) = Tsbks.field(b, from, n).toInt()
        val c = Csbk(op, fid, (b[0] and 0x80) != 0, Codes.hex(b, 0, 12), verified)
        fun add(k: String, v: String) { c.fields.add(Field(k, v)) }
        fun sysF(v: Int) { val s = sysCode(v); c.sysCode = v; c.net = s.net; c.site = s.site; c.model = s.model; add("SYSTEM CODE", "${hx(v, 4)} (${s.model} net ${s.net} site ${s.site})") }
        if (fid == 0x10) return vendor10(b, c, ::add)
        if (fid != 0) { c.name = "FID ${hx(fid, 2)} CSBK ${hx(op, 2)}"; c.kind = "vendor"; add("PAYLOAD", Codes.hex(b, 2, 10)); return c }
        c.name = OPS[op] ?: "CSBK ${hx(op, 2)}"
        when (op) {
            0x19 -> {
                c.kind = "aloha"
                add("SITE TS SYNC", "${f(2, 1)}"); add("VERSION", "${f(3, 3)}"); add("ACTIVE CONNECTION", "${f(7, 1)}"); add("MASK", "${f(8, 5)}")
                add("SERVICE FUNCTION", "${f(13, 2)}"); add("NRAND WAIT", "${f(15, 4)}"); add("REGISTRATION REQUIRED", if (f(19, 1) != 0) "yes" else "no"); add("BACKOFF", "${f(20, 4)}")
                sysF(f(24, 16)); val ms = f(40, 24); if (ms != 0) { c.dst = ms; add("MS ADDRESS", "$ms") }
            }
            0x28 -> {
                c.kind = "bcast"; val ty = f(0, 5)
                c.name = "BROADCAST · ${BCAST[ty] ?: "TYPE $ty"}"
                add("PARAMETERS 1", hx(f(5, 14), 4)); add("REGISTRATION REQUIRED", if (f(19, 1) != 0) "yes" else "no"); add("BACKOFF", "${f(20, 4)}"); sysF(f(24, 16)); add("PARAMETERS 2", hx(f(40, 24), 6))
            }
            0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36 -> {
                c.kind = "grant"; c.lpcn = f(0, 12); c.slot = f(12, 1); c.emergency = f(14, 1) == 1; c.dst = f(16, 24); c.src = f(40, 24)
                c.group = op == 0x31 || op == 0x32 || op == 0x34
                add("CHANNEL", "LPCN ${c.lpcn} slot ${c.slot!! + 1}"); add("LATE ENTRY", "${f(13, 1)}"); add("EMERGENCY", if (c.emergency == true) "yes" else "no")
                add(if (c.group == true) "TALKGROUP" else "TARGET", "${c.dst}"); add("SOURCE", "${c.src}")
            }
            0x20, 0x1e -> {
                c.kind = "ack"; c.dst = f(16, 24); c.src = f(40, 24)
                add("RESPONSE INFO", hx(f(0, 7), 2)); add("REASON", hx(f(7, 8), 2)); add("TARGET", "${c.dst}"); add("ADDITIONAL", "${c.src}")
            }
            0x1c, 0x2e, 0x2f, 0x39, 0x04, 0x05, 0x24, 0x26, 0x27, 0x38, 0x3d -> {
                c.kind = "unit"; c.dst = f(16, 24); c.src = f(40, 24)
                add("INFO", hx(f(0, 16), 4)); add("TARGET", "${c.dst}"); add("SOURCE", "${c.src}")
            }
            else -> add("PAYLOAD", Codes.hex(b, 2, 10))
        }
        return c
    }

    /**
     * Feature set 0x10, formats derived from our recordings: 0x3E is a rest-channel beacon (CRC verified), 0x3D with
     * 0x09 after it is a unit report (the vendor check below), 0x3B a periodic broadcast, 0x08 a call
     * announcement. Anything else is shown as hex.
     */
    private fun vendor10(b: IntArray, c: Csbk, add: (String, String) -> Unit): Csbk {
        val op = c.op
        fun w(i: Int) = (b[i] shl 8) or b[i + 1]
        c.derived = true
        when (op) {
            0x3e -> {
                c.kind = "beacon"; c.name = "REST-CHANNEL BEACON"
                c.beaconSlot = (b[2] shr 5) and 1; c.rest = b[2] and 15
                val busy = ArrayList<Int>(); if ((b[5] and 0x80) != 0) for (n in 1..8) if ((b[6] and (0x80 shr (n - 1))) != 0) busy.add(n)
                c.busy = busy
                val id = w(7)
                add("SLOT", "${c.beaconSlot!! + 1}"); add("REST CHANNEL", "LCN ${c.rest}"); add("BUSY", if (busy.isNotEmpty()) busy.joinToString(", ") { "LCN $it" } else "none")
                if (id != 0xffff && (b[5] and 0x80) != 0) { c.unit = id; add("ID ON BUSY CHANNEL", "$id (${hx(id, 4)})") }
                add("FLAGS", "${hx(b[2], 2)} ${hx(b[3], 2)}")
            }
            0x3d -> {
                c.kind = "unithdr"; c.name = "UNIT REPORT HEADER"
                if (b[2] == 0x88) { val u = w(8); c.unit = u; c.lcn = b[7]; add("UNIT", "$u (${hx(u, 4)})"); add("LCN", "${c.lcn}") }
                else { val u = w(5); c.unit = u; c.name = "DATA HEADER TOWARD UNIT"; add("UNIT", "$u (${hx(u, 4)})"); add("VALUE", hx(b[7], 2)) }
                add("FORM", hx(b[2], 2))
            }
            0x09 -> {
                c.kind = "unitrpt"; c.name = "UNIT REPORT"
                val u = w(4); c.unit = u
                c.noFix = b[6] == 0x02 && b[7] == 0 && b[8] == 0 && b[9] == 0
                add("UNIT", "$u (${hx(u, 4)})")
                if (!c.noFix) { c.lonLo = w(6); c.latLo = w(8); add("LON LOW 16", hx(c.lonLo!!, 4)); add("LAT LOW 16", hx(c.latLo!!, 4)) }
                else add("POSITION", "no fix")
                add("STATUS", hx(b[2], 2))
            }
            0x3b -> { c.kind = "sysbcast"; c.name = "PERIODIC SYSTEM BROADCAST"; add("PAYLOAD", Codes.hex(b, 2, 10)) }
            0x08 -> {
                c.kind = "callann"; c.name = "CALL ANNOUNCEMENT"
                val a = w(3); val z = w(6); add("ID A", if (a == 0xffff) "all" else "$a"); add("ID B", if (z == 0xffff) "all" else "$z")
                if (a != 0xffff) c.unit = a
            }
            else -> { c.derived = false; c.kind = "vendor"; c.name = "FID 10 CSBK ${hx(op, 2)}"; add("PAYLOAD", Codes.hex(b, 2, 10)) }
        }
        return c
    }

    /**
     * The check on the feature set 0x10 unit report (0x89) and its header (0xBD), derived from our recordings: CRC-CCITT
     * (0x11021) over the data bits in a fixed vendor order, given here as a table (data bit, MSB first from byte 0, to the
     * exponent of its column x^e mod 0x11021). c = tail XOR the columns of every set mapped bit; a block passes when c
     * equals its family's constant. The constant depends on the bits outside the table, so it is kept per family key (the
     * block with the mapped bits and the tail cleared): two are known from our recordings, others are learned when the same
     * c repeats on one system.
     */
    private val VENDOR_MAP = intArrayOf(
        16, 34, 18, 39, 19, 16, 20, 35, 34, 77, 35, 47, 36, 17, 37, 67, 38, 40, 39, 32, 40, 90, 41, 74, 42, 112,
        43, 104, 44, 72, 45, 30, 46, 73, 47, 115, 48, 82, 49, 98, 50, 80, 51, 100, 52, 41, 53, 59, 54, 78, 55, 20,
        56, 99, 57, 42, 58, 107, 59, 36, 60, 26, 61, 52, 62, 102, 63, 88, 64, 28, 65, 92, 66, 24, 67, 65, 68, 75,
        69, 69, 70, 106, 71, 45, 72, 117, 73, 61, 74, 29, 75, 62, 76, 116, 77, 23, 78, 44, 79, 76,
    )
    private fun xpow(e: Int): Int { var x = 1; repeat(e) { x = if ((x and 0x8000) != 0) ((x shl 1) xor 0x11021) and 0xffff else (x shl 1) and 0xffff }; return x }
    private val VENDOR_COL = IntArray(VENDOR_MAP.size / 2) { xpow(VENDOR_MAP[2 * it + 1]) }
    /** The block's family key (mapped bits and tail cleared) and its check value c. */
    fun vendorCheckValue(b: IntArray): Pair<String, Int> {
        val k = IntArray(10) { b[it] and 255 }
        var c = ((b[10] shl 8) or b[11]) and 0xffff
        for (i in VENDOR_COL.indices) { val p = VENDOR_MAP[2 * i]; val m = 0x80 shr (p and 7); if ((b[p shr 3] and m) != 0) c = c xor VENDOR_COL[i]; k[p shr 3] = k[p shr 3] and m.inv() }
        return Codes.hex(k) to c
    }
    /** Family keys and constants from our recordings. */
    private val VENDOR_KNOWN: Map<String, Int> by lazy { mapOf(
        vendorCheckValue(intArrayOf(0x89, 0x10, 0x11, 0x00, 0x0e, 0x7d, 0xe4, 0x9a, 0x18, 0x09, 0xcc, 0x92)).first to 0x06da,
        vendorCheckValue(intArrayOf(0xbd, 0x10, 0x88, 0x02, 0x00, 0xff, 0xff, 0x06, 0x0a, 0x8f, 0xb1, 0x61)).first to 0x4616,
    ) }
    fun vendorKnown(key: String): Int? = VENDOR_KNOWN[key]

    /** Degrees × 2^22/360: the unit report carries the low 16 bits of each. */
    const val POS_SCALE = 4194304.0 / 360.0
    /** The full coordinate from its low 16 bits: the wrap nearest the reference (valid within about 300 km). */
    fun unwrap16(lo16: Int, refDeg: Double): Double {
        val r = Math.round(refDeg * POS_SCALE)
        val d = Math.floorMod(lo16 - (r and 0xffffL) + 32768L, 65536L) - 32768L
        return (r + d) / POS_SCALE
    }

    fun line(c: Csbk): String =
        c.name + (if (c.fields.isNotEmpty()) " · " + c.fields.joinToString(" · ") { "${it.k.lowercase()} ${it.v}" } else "")
}

/** Checks 0x89 / 0xBD blocks; the constants for other systems' fixed bytes are learned from repeats. */
class VendorCheck {
    private val learned = HashMap<String, Int>()
    private val votes = HashMap<String, HashMap<Int, Int>>()
    /** [scope] separates systems: a learned constant holds for the system it was learned on. */
    fun check(b: IntArray, scope: String = ""): Boolean {
        val (key, c) = Csbks.vendorCheckValue(b)
        Csbks.vendorKnown(key)?.let { return c == it }
        val sk = "$scope|$key"
        learned[sk]?.let { return c == it }
        val v = votes.getOrPut(sk) { HashMap() }; v[c] = (v[c] ?: 0) + 1
        if (votes.size > 2000) votes.clear()
        if ((v[c] ?: 0) >= 4) { learned[sk] = c; return true }
        return false
    }
}
