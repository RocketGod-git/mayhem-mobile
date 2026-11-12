package com.rocketgod.mayhem.core.analyzer

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/*
 * Naming the parts of a frame: what COMPARE shows once repeats are lined up.
 *
 * A field is a stretch of bits with a name and a kind (preamble, sync, ID, counter, CRC, data), counted from where
 * the frame's data starts: the first bit of the sync word (or the end of the preamble when there is none). Fields
 * are suggested from what lines up (fixed runs become sync and ID, a stretch that steps up from press to press
 * becomes a counter, a byte or two that a common CRC or checksum reproduces becomes the CRC) and the person can
 * drag out and name their own. A set of named fields with its sync word is a protocol: saved, it is recognized in
 * every later capture that carries the same sync word. Twin of web/src/dsp/analyzer/fields.ts and Fields.swift.
 */

enum class FieldKind(val key: String) {
    Preamble("preamble"), Sync("sync"), Id("id"), Counter("counter"), Crc("crc"), Data("data");
    companion object { fun of(key: String): FieldKind = entries.firstOrNull { it.key == key } ?: Data }
}
val FIELD_KINDS: List<FieldKind> = FieldKind.entries

/** A named stretch of bits [from, to), counted from the data start (the preamble's are negative). */
data class Field(val name: String, val kind: FieldKind, val from: Int, val to: Int) {
    fun toJson(): JSONObject = JSONObject().put("name", name).put("kind", kind.key).put("from", from).put("to", to)
    companion object {
        fun fromJson(o: JSONObject) = Field(o.optString("name"), FieldKind.of(o.optString("kind")), o.optInt("from"), o.optInt("to"))
    }
}

enum class CheckKind(val key: String) {
    Crc("crc"), Sum8("sum8"), Xor8("xor8"), NegSum8("negsum8"), Sum16("sum16");
    companion object { fun of(key: String): CheckKind = entries.firstOrNull { it.key == key } ?: Crc }
}

data class CheckSpec(
    val kind: CheckKind,
    val width: Int,
    val poly: Int,
    val init: Int,
    /** Reflected input and output (they go together in every common CRC). */
    val refl: Boolean,
    val xorout: Int,
) {
    fun toJson(): JSONObject = JSONObject().put("kind", kind.key).put("width", width).put("poly", poly).put("init", init).put("refl", refl).put("xorout", xorout)
    companion object {
        fun fromJson(o: JSONObject) = CheckSpec(CheckKind.of(o.optString("kind")), o.optInt("width", 8), o.optInt("poly"), o.optInt("init"), o.optBoolean("refl"), o.optInt("xorout"))
    }
}

/** A checksum that was found to hold: which one, over which bytes [from, to), and the byte it starts at (from the data start). */
data class CheckFound(
    /** A readable name: "CRC-16/XMODEM (poly 0x1021, init 0x0000)". */
    val name: String,
    val spec: CheckSpec,
    val from: Int,
    val to: Int,
    val at: Int,
    /** For a 16-bit value: true when the low byte comes first. */
    val little: Boolean,
) {
    fun toJson(): JSONObject = JSONObject().put("name", name).put("spec", spec.toJson()).put("from", from).put("to", to).put("at", at).put("little", little)
    companion object {
        fun fromJson(o: JSONObject) = CheckFound(o.optString("name"), CheckSpec.fromJson(o.optJSONObject("spec") ?: JSONObject()), o.optInt("from"), o.optInt("to"), o.optInt("at"), o.optBoolean("little"))
    }
}

data class Protocol(
    val name: String,
    /** The sync word as bits: a frame carrying it is this protocol. */
    val sync: String,
    val mod: String,
    val coding: String,
    val symUs: Double,
    val fields: List<Field>,
    val check: CheckFound? = null,
) {
    fun toJson(): JSONObject = JSONObject().put("name", name).put("sync", sync).put("mod", mod).put("coding", coding).put("symUs", symUs)
        .put("fields", JSONArray().also { a -> fields.forEach { a.put(it.toJson()) } }).also { o -> if (check != null) o.put("check", check.toJson()) }
    companion object {
        fun fromJson(o: JSONObject): Protocol {
            val fa = o.optJSONArray("fields") ?: JSONArray()
            return Protocol(o.optString("name"), o.optString("sync"), o.optString("mod"), o.optString("coding"), o.optDouble("symUs", 0.0),
                (0 until fa.length()).mapNotNull { fa.optJSONObject(it)?.let(Field::fromJson) }, o.optJSONObject("check")?.let(CheckFound::fromJson))
        }
    }
}

// ---- checksums ----------------------------------------------------------------------------------------------

private fun reflect(v: Int, w: Int): Int { var r = 0; for (i in 0 until w) if (v and (1 shl i) != 0) r = r or (1 shl (w - 1 - i)); return r }

/** A CRC or simple checksum over bytes [a, b). */
fun checkOf(spec: CheckSpec, bytes: IntArray, a: Int, b: Int): Int {
    when (spec.kind) {
        CheckKind.Sum8 -> { var s = 0; for (i in a until b) s += bytes[i]; return s and 0xff }
        CheckKind.NegSum8 -> { var s = 0; for (i in a until b) s += bytes[i]; return (-s) and 0xff }
        CheckKind.Xor8 -> { var s = 0; for (i in a until b) s = s xor bytes[i]; return s }
        CheckKind.Sum16 -> { var s = 0; for (i in a until b) s += bytes[i]; return s and 0xffff }
        CheckKind.Crc -> {}
    }
    val w = spec.width; val top = 1 shl (w - 1); val mask = if (w == 32) -1 else (1 shl w) - 1
    var crc = spec.init
    for (i in a until b) {
        val byte = if (spec.refl) reflect(bytes[i], 8) else bytes[i]
        crc = crc xor (byte shl (w - 8))
        for (k in 0 until 8) crc = (if (crc and top != 0) (crc shl 1) xor spec.poly else crc shl 1) and mask
    }
    if (spec.refl) crc = reflect(crc, w)
    return (crc xor spec.xorout) and mask
}

private val KNOWN = mapOf(
    "16/1021/0000/0/0000" to "CRC-16/XMODEM", "16/1021/ffff/0/0000" to "CRC-16/CCITT-FALSE", "16/1021/0000/1/0000" to "CRC-16/KERMIT",
    "16/1021/ffff/1/ffff" to "CRC-16/X-25", "16/1021/ffff/0/ffff" to "CRC-16/GENIBUS", "16/8005/0000/1/0000" to "CRC-16/ARC",
    "16/8005/ffff/1/0000" to "CRC-16/MODBUS", "16/8005/0000/0/0000" to "CRC-16/BUYPASS", "16/3d65/0000/1/ffff" to "CRC-16/EN-13757",
    "8/07/00/0/00" to "CRC-8/SMBUS", "8/31/00/1/00" to "CRC-8/MAXIM", "8/31/ff/0/00" to "CRC-8/NRSC-5", "8/1d/ff/0/ff" to "CRC-8/SAE-J1850",
    "8/9b/00/0/00" to "CRC-8/LTE", "8/07/00/0/55" to "CRC-8/I-432-1",
)

/** Every checksum tried: the common CRC-8 and CRC-16 polynomials at both usual starting values, both bit orders. */
fun checkSpecs(): List<CheckSpec> {
    val out = ArrayList<CheckSpec>()
    for (poly in intArrayOf(0x1021, 0x8005, 0x3d65, 0x8bb7, 0xc867, 0x0589, 0x6f63))
        for (init in intArrayOf(0, 0xffff)) for (refl in booleanArrayOf(false, true)) for (xorout in intArrayOf(0, 0xffff)) out.add(CheckSpec(CheckKind.Crc, 16, poly, init, refl, xorout))
    for (poly in intArrayOf(0x07, 0x31, 0x1d, 0x2f, 0x9b, 0x39, 0xd5))
        for (init in intArrayOf(0, 0xff)) for (refl in booleanArrayOf(false, true)) for (xorout in intArrayOf(0, 0xff, 0x55)) out.add(CheckSpec(CheckKind.Crc, 8, poly, init, refl, xorout))
    out.add(CheckSpec(CheckKind.Sum8, 8, 0, 0, false, 0)); out.add(CheckSpec(CheckKind.Xor8, 8, 0, 0, false, 0))
    out.add(CheckSpec(CheckKind.NegSum8, 8, 0, 0, false, 0)); out.add(CheckSpec(CheckKind.Sum16, 16, 0, 0, false, 0))
    return out
}

private fun hx(v: Int, w: Int) = "0x" + Integer.toHexString(v).uppercase(Locale.US).padStart(w / 4, '0')
private fun lh(v: Int, w: Int) = Integer.toHexString(v).padStart(w / 4, '0')

fun specName(s: CheckSpec): String {
    when (s.kind) {
        CheckKind.Sum8 -> return "SUM-8"
        CheckKind.Xor8 -> return "XOR-8"
        CheckKind.NegSum8 -> return "SUM-8, negated"
        CheckKind.Sum16 -> return "SUM-16"
        CheckKind.Crc -> {}
    }
    val key = "${s.width}/${lh(s.poly, s.width)}/${lh(s.init, s.width)}/${if (s.refl) 1 else 0}/${lh(s.xorout, s.width)}"
    val base = "poly ${hx(s.poly, s.width)}, init ${hx(s.init, s.width)}${if (s.refl) ", reflected" else ""}${if (s.xorout != 0) ", xor ${hx(s.xorout, s.width)}" else ""}"
    return "${KNOWN[key] ?: "CRC-${s.width}"} ($base)"
}

/** Bits to bytes, eight at a time from the first bit; a short last byte is dropped. */
fun bytesOf(bits: String): IntArray = IntArray(bits.length shr 3) { bits.substring(8 * it, 8 * it + 8).toInt(2) }

/**
 * Look for a checksum that every frame agrees with: a CRC-8/16 (common polynomials) or a sum or XOR of a run of
 * bytes, stored in one or two bytes after them. `frames` are the frames' bits from their data start, all lined
 * up. The value must change from frame to frame (a constant byte "matches" anything constant), and at least two
 * frames are needed. The check nearest the end and the longest run of bytes win, the order a protocol is usually
 * built in.
 */
fun findCheck(frames: List<String>): CheckFound? {
    if (frames.size < 2) return null
    val n = frames.minOf { it.length shr 3 }
    if (n < 3) return null
    val rows = frames.map(::bytesOf)
    val specs = checkSpecs()
    for (at in n - 1 downTo 1) {
        for (a in 0 until at) {
            for (spec in specs) {
                val wb = spec.width shr 3
                if (at + wb > n || (spec.width == 16 && at - a < 2)) continue
                for (little in if (wb == 2) booleanArrayOf(false, true) else booleanArrayOf(false)) {
                    fun stored(r: IntArray) = if (wb == 1) r[at] else if (little) r[at] or (r[at + 1] shl 8) else (r[at] shl 8) or r[at + 1]
                    val s0 = stored(rows[0])
                    if (rows.all { stored(it) == s0 }) continue
                    if (rows.all { checkOf(spec, it, a, at) == stored(it) }) return CheckFound(specName(spec), spec, a, at, at, little)
                }
            }
        }
    }
    return null
}

// ---- counters ---------------------------------------------------------------------------------------------------

private fun valueOf(bits: String, lsbFirst: Boolean): Long = (if (lsbFirst) bits.reversed() else bits).toLong(2)

/** Whether the stretch [s, s+w) counts up across the rows: never down, up at least twice, never by more than `step`. */
private fun counts(rows: List<String>, s: Int, w: Int, lsbFirst: Boolean, step: Int): Boolean {
    if (s < 0) return false
    var ups = 0
    for (i in 1 until rows.size) {
        if (rows[i].length < s + w || rows[i - 1].length < s + w) return false
        val d = valueOf(rows[i].substring(s, s + w), lsbFirst) - valueOf(rows[i - 1].substring(s, s + w), lsbFirst)
        if (d < 0 || d > step) return false
        if (d > 0) ups++
    }
    return ups >= 2
}

/** A counter found: bits [from, to) from the data start, and its bit order. */
data class CounterFound(val from: Int, val to: Int, val lsbFirst: Boolean)

/**
 * A stretch that counts: read as a number (either bit order) in the frames' order in time, it never goes down and
 * goes up at least twice (repeats of one press share a value). Whole bytes that take in a changing stretch are
 * tried first (a counter is nearly always a byte or a few), steps up to 16 allowed for presses missed; then any
 * stretch of 4 to 32 bits inside the changing ones, steps up to 4, longest first. `rows` are bits from the data
 * start, in time order.
 */
fun findCounter(rows: List<String>, segments: List<Segment>): CounterFound? {
    if (rows.size < 3) return null
    for (w in intArrayOf(32, 24, 16, 8)) {
        for (seg in segments) {
            var s = Math.floorDiv(seg.from, 8) * 8
            while (s < seg.to) {
                if (!(s + w < seg.to && w > 8)) {
                    for (lsbFirst in booleanArrayOf(false, true)) if (counts(rows, s, w, lsbFirst, 16)) return CounterFound(s, s + w, lsbFirst)
                }
                s += 8
            }
        }
    }
    for (seg in segments) {
        for (w in min(32, seg.to - seg.from) downTo 4) {
            for (s in seg.from..seg.to - w) {
                for (lsbFirst in booleanArrayOf(false, true)) if (counts(rows, s, w, lsbFirst, 4)) return CounterFound(s, s + w, lsbFirst)
            }
        }
    }
    return null
}

// ---- suggestions and protocols ----------------------------------------------------------------------------------

/** Where the data starts in an alignment: the sync word, or the end of the preamble, or the first shared column. */
fun dataStart(al: Alignment): Int {
    al.sync?.let { return it.from }
    al.preamble?.let { return it.second }
    var c = 0; while (c < al.width && al.state[c] == 2) c++
    return c
}

/** Each row's bits from the data start (rows that start later are padded with nothing: they are simply shorter). */
fun fromStart(al: Alignment, start: Int): List<String> = al.rows.map { r -> r.bits.substring(min(r.bits.length, max(0, start - r.shift))) }

/** Suggested fields and the checksum found, if any. */
class Suggestion(val fields: List<Field>, val check: CheckFound?)

/**
 * Fields suggested from lined-up frames: the preamble, the sync word, fixed stretches after it as ID, a counter,
 * and a checksum. Rows are taken in the order passed to align(), which is their order in time.
 */
fun suggest(al: Alignment): Suggestion {
    val start = dataStart(al)
    val fields = ArrayList<Field>()
    al.preamble?.let { fields.add(Field("preamble", FieldKind.Preamble, it.first - start, it.second - start)) }
    al.sync?.let { fields.add(Field("sync", FieldKind.Sync, it.from - start, it.to - start)) }
    val syncEnd = al.sync?.to ?: start
    val rows = fromStart(al, start)
    val check = findCheck(rows)
    val checkFrom = if (check != null) check.at * 8 else Int.MAX_VALUE
    val checkTo = if (check != null) (check.at + (check.spec.width shr 3)) * 8 else Int.MIN_VALUE
    var ids = 0
    val changing = ArrayList<Segment>()
    for (s in al.segments) {
        val a = max(s.from, syncEnd) - start; val b = s.to - start
        if (b <= a || (a >= checkFrom && b <= checkTo)) continue
        if (s.fixed && b - a >= 8) { fields.add(Field(if (ids++ != 0) "fixed $ids" else "ID / fixed", FieldKind.Id, a, b)) }
        if (!s.fixed) changing.add(Segment(a, min(b, a + 64), false))
    }
    val counter = findCounter(rows, changing.filter { !(it.from >= checkFrom && it.to <= checkTo) })
    if (counter != null) fields.add(Field(if (counter.lsbFirst) "counter (LSB first)" else "counter", FieldKind.Counter, counter.from, counter.to))
    if (check != null) fields.add(Field(check.name.substringBefore(" ("), FieldKind.Crc, checkFrom, checkTo))
    return Suggestion(fields.sortedBy { it.from }, check)
}

/** A protocol recognized in a frame, and where the frame's data starts. */
class Recognized(val protocol: Protocol, val start: Int)

/** The saved protocol a frame belongs to, if any: same modulation and coding, and its sync word in the frame. */
fun recognize(protocols: List<Protocol>, bits: String, mod: String, coding: String): Recognized? {
    for (p in protocols) {
        if (p.sync.length < 8 || p.mod != mod || p.coding != coding) continue
        val i = bits.indexOf(p.sync)
        if (i >= 0) return Recognized(p, i)
    }
    return null
}

/** A field's bits in a frame whose data starts at `start`, as hex (and binary when short). */
fun fieldValue(bits: String, start: Int, f: Field): String {
    val a = start + f.from; val b = start + f.to
    if (a < 0 || b > bits.length) return "—"
    val v = bits.substring(a, b)
    val hex = StringBuilder()
    var i = 0
    while (i < v.length) { hex.append(Integer.toHexString(v.substring(i, min(v.length, i + 4)).padEnd(4, '0').toInt(2)).uppercase(Locale.US)); i += 4 }
    return if (v.length <= 8) "$hex ($v)" else hex.toString()
}

/** Whether a protocol's checksum holds for a frame. Null when the protocol has none or the frame is too short. */
fun checkHolds(p: Protocol, bits: String, start: Int): Boolean? {
    val c = p.check ?: return null
    val bytes = bytesOf(bits.substring(min(bits.length, start)))
    val wb = c.spec.width shr 3
    if (c.at + wb > bytes.size) return null
    val stored = if (wb == 1) bytes[c.at] else if (c.little) bytes[c.at] or (bytes[c.at + 1] shl 8) else (bytes[c.at] shl 8) or bytes[c.at + 1]
    return checkOf(c.spec, bytes, c.from, c.to) == stored
}
