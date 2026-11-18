package com.rocketgod.mayhem.core.cell

/*
 * Minimal ASN.1 parser and unaligned PER (UPER) decoder, enough for the 36.331 BCCH-DL-SCH definitions.
 * 36.331 clause 8 names the basic production of unaligned PER (ITU-T X.691):
 *   SEQUENCE   [ext bit] + presence bitmap of OPTIONAL/DEFAULT root components + components; extension additions =
 *              normally small length of the addition bitmap, the bitmap, each present addition as an open type
 *              (length determinant + octets); a [[ ]] group is one addition, its members merged into the parent.
 *   CHOICE     [ext bit] + index in ceil(log2 n) bits; extension alternatives = normally small index + open type.
 *   ENUMERATED [ext bit] + index in ceil(log2 n) bits; extension values = normally small number.
 *   INTEGER    constrained lb..ub = offset in ceil(log2(ub-lb+1)) bits, [ext bit] if extensible.
 *   BIT/OCTET STRING, SEQUENCE OF: fixed size = no length, size range = offset in ceil(log2 range) bits,
 *              unconstrained = general length determinant. CONTAINING decodes the content recursively.
 * Values: SEQUENCE = ordered map, CHOICE = { alternative: value }, ENUMERATED = name, INTEGER = Long,
 * BIT STRING = "0101" string, OCTET STRING = lowercase hex, NULL = null.
 */

/** A bound: a number or the name of a value constant. */
class Bound(val n: Long?, val name: String?)
class Constraint(
    val range: Pair<Bound, Bound>? = null, val ext: Boolean = false, val size: Pair<Bound, Bound>? = null,
    val sizeExt: Boolean = false, val containing: String? = null,
) {
    /** The outer constraint's own keys replace the inner ones (a range brings its ext flag, a size its sizeExt). */
    fun merge(o: Constraint) = Constraint(
        if (o.range != null) o.range else range, if (o.range != null) o.ext else ext,
        if (o.size != null) o.size else size, if (o.size != null) o.sizeExt else sizeExt, o.containing ?: containing)
}
class Comp(val name: String, val t: AsnType, val opt: Boolean, val def: String? = null)
sealed class Add { class One(val c: Comp) : Add(); class Group(val group: List<Comp>) : Add() }
sealed class AsnType {
    class Seq(val root: List<Comp>, val adds: List<Add>, val ext: Boolean) : AsnType()
    class Choice(val root: List<Comp>, val adds: List<Add>, val ext: Boolean) : AsnType()
    class SeqOf(val el: AsnType, val size: Constraint?) : AsnType()
    class Enum(val root: List<String>, val extv: List<String>, val ext: Boolean) : AsnType()
    /** k: INT, BITS, OCTETS or STRING. */
    class Prim(val k: String, val c: Constraint) : AsnType()
    object Bool : AsnType()
    object Null : AsnType()
    class Ref(val name: String, val c: Constraint?) : AsnType()
}
class Asn1Schema(val types: Map<String, AsnType>, val values: Map<String, Long>, val failed: List<Pair<String, String>>)

private val TOK = Regex("""::=|\.\.\.|\.\.|\[\[|\]\]|[{}(),|<>\[\]]|-?\d+|[A-Za-z][A-Za-z0-9-]*""")

fun tokenize(text: String): List<String> {
    val clean = text.split('\n').joinToString("\n") { l -> val i = l.indexOf("--"); if (i < 0) l else l.substring(0, i) + " " }
    return TOK.findAll(clean).map { it.value }.toList()
}

private class P(val t: List<String>) {
    var i = 0
    fun peek(k: Int = 0): String? = t.getOrNull(i + k)
    fun take(exp: String? = null): String {
        val v = t.getOrNull(i) ?: throw IllegalStateException("unexpected end")
        if (exp != null && v != exp) throw IllegalStateException("expected $exp got $v near ${t.subList(maxOf(0, i - 8), minOf(t.size, i + 8)).joinToString(" ")}")
        i++
        return v
    }
}

fun parseAsn1(text: String): Asn1Schema {
    val p = P(tokenize(text))
    val types = HashMap<String, AsnType>(); val values = HashMap<String, Long>(); val failed = ArrayList<Pair<String, String>>()
    while (p.peek() != null) {
        val tk = p.peek()!!
        if (tk == "IMPORTS" || tk == "EXPORTS") { while (p.peek() != null && p.take() != ";") { }; continue }
        if (tk == "DEFINITIONS") { p.take(); while (p.peek() != null && p.peek() != "BEGIN") p.take(); p.take(); continue }
        if (tk == "END" || tk == "BEGIN" || tk == "AUTOMATIC" || tk == "TAGS") { p.take(); continue }
        if (p.peek(1) == "INTEGER" && p.peek(2) == "::=") { val name = p.take(); p.take(); p.take(); values[name] = p.take().toLong(); continue }
        if (p.peek(1) == "::=") {
            val name = p.take(); p.take()
            try { types[name] = parseType(p) } catch (e: Exception) {
                failed.add(name to (e.message ?: "").take(160))
                while (p.peek() != null && p.peek(1) != "::=") p.take()
            }
            continue
        }
        p.take()
    }
    return Asn1Schema(types, values, failed)
}

private val NUM = Regex("^-?\\d+$")
private fun bound(x: String): Bound = if (NUM.matches(x)) Bound(x.toLong(), null) else Bound(null, x)

private fun range(buf: List<String>): Pair<Pair<Bound, Bound>, Boolean> {
    val ext = "..." in buf
    val b = buf.filter { it != "," && it != "..." }
    val j = b.indexOf("..")
    if (j >= 0) return (bound(b[j - 1]) to bound(b[j + 1])) to ext
    return (bound(b[0]) to bound(b[0])) to ext
}

private fun parseConstraint(p: P): Constraint {
    p.take("(")
    var depth = 1
    val buf = ArrayList<String>()
    while (true) {
        val tk = p.take()
        if (tk == "(") depth++
        else if (tk == ")") { depth--; if (depth == 0) break }
        buf.add(tk)
    }
    if (buf[0] == "SIZE") {
        val close = buf.indexOf(")")
        val inner = if (buf[1] == "(") buf.subList(2, if (close < 0) buf.size else close) else buf.subList(1, buf.size)
        val (size, sizeExt) = range(inner)
        return Constraint(size = size, sizeExt = sizeExt)
    }
    if (buf[0] == "CONTAINING") return Constraint(containing = buf[1])
    val (r, ext) = range(buf)
    return Constraint(range = r, ext = ext)
}

private fun parseType(p: P): AsnType {
    val tk = p.take()
    if (tk == "SEQUENCE" || tk == "SET") {
        if (p.peek() == "{") return parseComponents(p, true)
        val size = if (p.peek() == "(") parseConstraint(p) else null
        p.take("OF")
        return AsnType.SeqOf(parseType(p), size)
    }
    if (tk == "CHOICE") return parseComponents(p, false)
    if (tk == "ENUMERATED") {
        p.take("{")
        val root = ArrayList<String>(); val extv = ArrayList<String>()
        var isExt = false
        while (true) {
            val x = p.take()
            if (x == "}") break
            if (x == ",") continue
            if (x == "...") { isExt = true; continue }
            (if (isExt) extv else root).add(x)
        }
        return AsnType.Enum(root, extv, isExt)
    }
    if (tk == "INTEGER") return AsnType.Prim("INT", if (p.peek() == "(") parseConstraint(p) else Constraint())
    if (tk == "BOOLEAN") return AsnType.Bool
    if (tk == "NULL") return AsnType.Null
    if (tk == "BIT" || tk == "OCTET") {
        p.take("STRING")
        if (p.peek() == "{") while (p.take() != "}") { }
        return AsnType.Prim(if (tk == "BIT") "BITS" else "OCTETS", if (p.peek() == "(") parseConstraint(p) else Constraint())
    }
    if (tk == "VisibleString" || tk == "IA5String" || tk == "UTF8String" || tk == "PrintableString") return AsnType.Prim("STRING", if (p.peek() == "(") parseConstraint(p) else Constraint())
    val c = if (p.peek() == "(") parseConstraint(p) else null
    return AsnType.Ref(tk, c)
}

private fun parseComponents(p: P, seq: Boolean): AsnType {
    p.take("{")
    val root = ArrayList<Comp>(); val adds = ArrayList<Add>()
    var inExt = false; var extSeen = false
    while (true) {
        val x = p.peek()
        if (x == "}") { p.take(); break }
        if (x == ",") { p.take(); continue }
        if (x == "...") { p.take(); inExt = if (seq) !inExt else true; extSeen = true; continue }
        if (x == "[[") {
            p.take()
            val grp = ArrayList<Comp>()
            while (p.peek() != "]]") { if (p.peek() == ",") { p.take(); continue }; grp.add(parseComponent(p)) }
            p.take("]]")
            adds.add(Add.Group(grp))
            continue
        }
        val c = parseComponent(p)
        if (inExt) adds.add(Add.One(c)) else root.add(c)
    }
    return if (seq) AsnType.Seq(root, adds, extSeen) else AsnType.Choice(root, adds, extSeen)
}

private fun parseComponent(p: P): Comp {
    val name = p.take()
    val t = parseType(p)
    if (p.peek() == "OPTIONAL") { p.take(); return Comp(name, t, true) }
    if (p.peek() == "DEFAULT") {
        p.take()
        val v = p.take()
        if (v == "{") while (p.take() != "}") { }
        return Comp(name, t, true, v)
    }
    return Comp(name, t, false)
}

class UperError(msg: String) : Exception(msg)

private class Bits(val b: String) {
    var pos = 0
    fun read(n: Int): Long {
        if (n == 0) return 0
        if (pos + n > b.length) throw UperError("read past end ($pos+$n>${b.length})")
        var v = 0L
        for (i in 0 until n) v = v * 2 + (b[pos + i].code and 1)
        pos += n
        return v
    }
    fun readBits(n: Int): String {
        if (n < 0 || pos + n > b.length) throw UperError("read past end ($pos+$n>${b.length})")
        val s = b.substring(pos, pos + n)
        pos += n
        return s
    }
    companion object {
        fun of(data: ByteArray): Bits { val sb = StringBuilder(data.size * 8); for (x in data) { val v = x.toInt() and 0xff; for (i in 7 downTo 0) sb.append(if ((v shr i) and 1 != 0) '1' else '0') }; return Bits(sb.toString()) }
    }
}

private fun nbits(r: Long): Int = if (r <= 1) 0 else 64 - java.lang.Long.numberOfLeadingZeros(r - 1)
private fun bitsToBytesS(s: String): ByteArray = ByteArray(s.length shr 3) { s.substring(8 * it, 8 * it + 8).toInt(2).toByte() }

class UperResult(val value: Any?, val bitsUsed: Int)

class Uper(val s: Asn1Schema) {
    fun decode(type: String, data: ByteArray): UperResult {
        val t = s.types[type] ?: throw UperError("unknown type $type")
        val b = Bits.of(data)
        return UperResult(dec(t, b), b.pos)
    }

    private fun v(x: Bound): Long {
        x.n?.let { return it }
        val name = x.name!!
        s.values[name]?.let { return it }
        val m = Regex("^(.+)-(\\d+)$").find(name)
        if (m != null && s.values.containsKey(m.groupValues[1])) return s.values.getValue(m.groupValues[1]) - m.groupValues[2].toLong()
        throw UperError("unknown constant $name")
    }
    private fun isMax(x: Bound) = x.name == "MAX"

    private fun glen(b: Bits): Int {
        if (b.read(1) == 0L) return b.read(7).toInt()
        if (b.read(1) == 0L) return b.read(14).toInt()
        throw UperError("fragmented length")
    }
    private fun nsnn(b: Bits): Long {
        if (b.read(1) == 0L) return b.read(6)
        return b.read(8 * glen(b))
    }

    private fun resolve(t0: AsnType): AsnType {
        var t = t0
        while (t is AsnType.Ref) {
            val inner = s.types[t.name] ?: throw UperError("unknown type ${t.name}")
            val c = t.c
            t = when {
                c != null && inner is AsnType.Prim -> AsnType.Prim(inner.k, inner.c.merge(c))
                c != null && inner is AsnType.Ref && inner.c != null -> AsnType.Ref(inner.name, inner.c.merge(c))
                else -> inner
            }
        }
        return t
    }

    private fun dec(t0: AsnType, b: Bits): Any? {
        val t = resolve(t0)
        when (t) {
            is AsnType.Seq -> return decSeq(t.root, t.adds, t.ext, b)
            is AsnType.Choice -> return decChoice(t, b)
            is AsnType.Enum -> {
                if (t.ext && b.read(1) != 0L) { val i = nsnn(b).toInt(); return if (i < t.extv.size) t.extv[i] else "ext-value-$i" }
                val i = b.read(nbits(t.root.size.toLong())).toInt()
                return if (i < t.root.size) t.root[i] else "invalid-$i"
            }
            AsnType.Bool -> return b.read(1) == 1L
            AsnType.Null -> return null
            is AsnType.Prim -> {
                val c = t.c
                if (t.k == "INT") {
                    if (c.ext && b.read(1) != 0L) { val n = glen(b); return b.read(8 * n) }
                    if (c.range != null) {
                        val lo = v(c.range.first)
                        if (isMax(c.range.second)) { val n = glen(b); return lo + b.read(8 * n) }
                        return lo + b.read(nbits(v(c.range.second) - lo + 1))
                    }
                    val n = glen(b)
                    var x = b.read(8 * n)
                    if (n in 1..7 && x >= (1L shl (8 * n - 1))) x -= (1L shl (8 * n))
                    return x
                }
                val unit = if (t.k == "BITS") 1 else 8
                val n: Int = if ((c.ext || c.sizeExt) && b.read(1) != 0L) glen(b)
                    else if (c.size != null) { val lo = v(c.size.first); val hi = v(c.size.second); (if (hi != lo) lo + b.read(nbits(hi - lo + 1)) else lo).toInt() }
                    else glen(b)
                val str = b.readBits(n * unit)
                if (t.k == "BITS") {
                    if (c.containing != null) return linkedMapOf<String, Any?>("containing" to dec(typeOf(c.containing), Bits(str)))
                    return str
                }
                val raw = bitsToBytesS(str)
                if (c.containing != null) {
                    return try { linkedMapOf<String, Any?>(c.containing to dec(typeOf(c.containing), Bits(str))) }
                    catch (e: Exception) { linkedMapOf<String, Any?>("hex" to hexOf(raw), "containing_error" to (e.message ?: "")) }
                }
                if (t.k == "STRING") return String(CharArray(raw.size) { (raw[it].toInt() and 0xff).toChar() })
                return hexOf(raw)
            }
            is AsnType.SeqOf -> {
                val c = t.size ?: Constraint()
                val n: Int = if ((c.ext || c.sizeExt) && b.read(1) != 0L) glen(b)
                    else if (c.size != null) { val lo = v(c.size.first); val hi = v(c.size.second); (if (hi != lo) lo + b.read(nbits(hi - lo + 1)) else lo).toInt() }
                    else glen(b)
                val out = ArrayList<Any?>(n)
                for (i in 0 until n) out.add(dec(t.el, b))
                return out
            }
            is AsnType.Ref -> {}
        }
        throw UperError("unsupported type")
    }

    private fun typeOf(name: String): AsnType = s.types[name] ?: throw UperError("unknown type $name")

    private fun decSeq(root: List<Comp>, adds: List<Add>, extensible: Boolean, b: Bits): LinkedHashMap<String, Any?> {
        val ext = extensible && b.read(1) == 1L
        val opts = root.filter { it.opt }
        val bm = if (opts.isNotEmpty()) b.readBits(opts.size) else ""
        val pres = HashMap<String, Char>()
        opts.forEachIndexed { i, c -> pres[c.name] = bm[i] }
        val out = LinkedHashMap<String, Any?>()
        for (c in root) {
            if (c.opt && pres[c.name] == '0') continue
            out[c.name] = dec(c.t, b)
        }
        if (ext) {
            val n = (nsnn(b) + 1).toInt()
            val bmp = b.readBits(n)
            for (i in 0 until n) {
                if (bmp[i] == '0') continue
                val chunk = b.readBits(8 * glen(b))
                val a = adds.getOrNull(i)
                if (a == null) { out["unknown_ext_$i"] = chunk; continue }
                try {
                    when (a) {
                        is Add.Group -> out.putAll(decSeq(a.group, emptyList(), false, Bits(chunk)))
                        is Add.One -> out[a.c.name] = dec(a.c.t, Bits(chunk))
                    }
                } catch (e: Exception) { out["ext${i}_error"] = "${e.message} ($chunk)" }
            }
        }
        return out
    }

    private fun decChoice(t: AsnType.Choice, b: Bits): LinkedHashMap<String, Any?> {
        if (t.ext && b.read(1) != 0L) {
            val i = nsnn(b).toInt()
            val chunk = b.readBits(8 * glen(b))
            val a = t.adds.getOrNull(i)
            if (a is Add.One) {
                return try { linkedMapOf(a.c.name to dec(a.c.t, Bits(chunk))) }
                catch (e: Exception) { linkedMapOf<String, Any?>(a.c.name to linkedMapOf<String, Any?>("hex" to hexOf(bitsToBytesS(chunk)), "error" to (e.message ?: ""))) }
            }
            return linkedMapOf("unknown_ext_alt_$i" to chunk)
        }
        val i = b.read(nbits(t.root.size.toLong())).toInt()
        val a = t.root.getOrNull(i) ?: throw UperError("choice index $i out of range")
        return linkedMapOf(a.name to dec(a.t, b))
    }
}
