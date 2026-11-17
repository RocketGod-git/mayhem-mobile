package com.rocketgod.mayhem.core.fleet

/**
 * P25 trunking signaling blocks (TIA-102 outbound TSBK opcodes) to named fields, and the channel tables that turn a
 * 16-bit channel number into a frequency. Each block is 12 bytes: last-block and protected flags with the opcode,
 * the manufacturer ID, 64 bits of payload, CRC.
 */
data class Field(val k: String, val v: String)

data class Iden(
    val iden: Int, val base: Long, val spacing: Int, val txOffset: Long, val bw: Int, val tdma: Boolean, val slots: Int, val form: String, val raw: String,
)

class Tsbk(val op: Int, val mfid: Int, val last: Boolean, val prot: Boolean, val hex: String) {
    var name = ""
    val fields = ArrayList<Field>()
    /** Fields the station model uses. */
    var kind = "other"
    var sys: Int? = null; var wacn: Int? = null; var rfss: Int? = null; var site: Int? = null; var lra: Int? = null; var cls: Int? = null
    var ch: Int? = null; var ch2: Int? = null; var group: Int? = null; var group2: Int? = null; var src: Int? = null; var dst: Int? = null; var svc: Int? = null
    var iden: Iden? = null; var time: String? = null
}

data class Resolved(val hz: Long, val slot: Int, val tdma: Boolean)

/** Uppercase hex of [v], [w] digits. */
fun hx(v: Int, w: Int): String = Integer.toHexString(v).uppercase().padStart(w, '0')

object Tsbks {
    private val OPS = mapOf(
        0x00 to "GROUP VOICE GRANT", 0x02 to "GROUP VOICE GRANT UPDATE", 0x03 to "GROUP VOICE GRANT UPDATE (EXPLICIT)",
        0x04 to "UNIT TO UNIT VOICE GRANT", 0x05 to "UNIT TO UNIT ANSWER REQUEST", 0x06 to "UNIT TO UNIT VOICE GRANT UPDATE",
        0x08 to "TELEPHONE INTERCONNECT GRANT", 0x09 to "TELEPHONE INTERCONNECT GRANT UPDATE", 0x0a to "TELEPHONE INTERCONNECT ANSWER REQUEST",
        0x10 to "INDIVIDUAL DATA GRANT", 0x11 to "GROUP DATA GRANT", 0x12 to "GROUP DATA ANNOUNCEMENT", 0x13 to "GROUP DATA ANNOUNCEMENT (EXPLICIT)",
        0x14 to "SNDCP DATA CHANNEL GRANT", 0x15 to "SNDCP DATA PAGE REQUEST", 0x16 to "SNDCP DATA CHANNEL ANNOUNCEMENT",
        0x18 to "STATUS UPDATE", 0x1a to "STATUS QUERY", 0x1c to "MESSAGE UPDATE", 0x1d to "RADIO UNIT MONITOR", 0x1f to "CALL ALERT",
        0x20 to "ACKNOWLEDGE RESPONSE", 0x21 to "QUEUED RESPONSE", 0x24 to "EXTENDED FUNCTION COMMAND", 0x27 to "DENY RESPONSE",
        0x28 to "GROUP AFFILIATION RESPONSE", 0x29 to "SECONDARY CONTROL CHANNEL (EXPLICIT)", 0x2a to "GROUP AFFILIATION QUERY",
        0x2b to "LOCATION REGISTRATION RESPONSE", 0x2c to "UNIT REGISTRATION RESPONSE", 0x2d to "UNIT REGISTRATION COMMAND",
        0x2e to "AUTHENTICATION COMMAND", 0x2f to "UNIT DEREGISTRATION ACK", 0x30 to "SYNCHRONIZATION BROADCAST",
        0x33 to "IDENTIFIER UPDATE TDMA", 0x34 to "IDENTIFIER UPDATE VHF/UHF", 0x35 to "TIME AND DATE ANNOUNCEMENT",
        0x36 to "ROAMING ADDRESS COMMAND", 0x37 to "ROAMING ADDRESS UPDATE", 0x38 to "SYSTEM SERVICE BROADCAST",
        0x39 to "SECONDARY CONTROL CHANNEL", 0x3a to "RFSS STATUS", 0x3b to "NETWORK STATUS", 0x3c to "ADJACENT SITE STATUS",
        0x3d to "IDENTIFIER UPDATE",
    )

    /** Slots per carrier for an IDENTIFIER UPDATE TDMA channel type (TIA-102 channel type table). */
    private val TDMA_SLOTS = mapOf(0 to 1, 1 to 1, 2 to 1, 3 to 2, 4 to 4, 5 to 2)

    /** Bits [from, from+n) of the 64-bit payload (bytes 2..9), most significant first. */
    internal fun field(b: IntArray, from: Int, n: Int): Long {
        var v = 0L
        for (i in 0 until n) { val p = from + i; v = v * 2 + ((b[2 + (p shr 3)] shr (7 - (p and 7))) and 1) }
        return v
    }
    private fun chs(c: Int) = "${hx(c, 4)} (iden ${c shr 12}, ch ${c and 0xfff})"
    private fun svcText(s: Int) = listOf(if ((s and 0x80) != 0) "emergency" else "", if ((s and 0x40) != 0) "encrypted" else "", if ((s and 0x20) != 0) "duplex" else "",
        if ((s and 0x10) != 0) "packet" else "", "priority ${s and 7}").filter { it.isNotEmpty() }.joinToString(", ")
    fun emergency(s: Int) = (s and 0x80) != 0
    fun encrypted(s: Int) = (s and 0x40) != 0
    private fun pad2(v: Int) = v.toString().padStart(2, '0')
    private val RESP = arrayOf("accept", "fail", "deny", "refused")

    fun parse(b: IntArray): Tsbk {
        val op = b[0] and 0x3f; val mfid = b[1]
        fun f(from: Int, n: Int) = field(b, from, n).toInt()
        val t = Tsbk(op, mfid, (b[0] and 0x80) != 0, (b[0] and 0x40) != 0, Codes.hex(b, 0, 12))
        fun add(k: String, v: String) { t.fields.add(Field(k, v)) }
        if (t.prot) { t.name = "PROTECTED BLOCK OPCODE ${hx(op, 2)}"; add("PAYLOAD", Codes.hex(b, 2, 10)); return t }
        if (mfid != 0) { t.name = "MFID ${hx(mfid, 2)} OPCODE ${hx(op, 2)}"; t.kind = "vendor"; add("MANUFACTURER ID", hx(mfid, 2)); add("PAYLOAD", Codes.hex(b, 2, 10)); return t }
        t.name = OPS[op] ?: "OPCODE ${hx(op, 2)}"
        when (op) {
            0x00, 0x11 -> {
                t.kind = if (op == 0) "grant" else "datagrant"; val svc = f(0, 8); t.svc = svc; t.ch = f(8, 16); t.group = f(24, 16); t.src = f(40, 24)
                add("SERVICE OPTIONS", "${hx(svc, 2)} (${svcText(svc)})"); add("CHANNEL", chs(t.ch!!)); add("TALKGROUP", "${t.group}"); add("SOURCE", "${t.src}")
            }
            0x02 -> {
                t.kind = "update"; t.ch = f(0, 16); t.group = f(16, 16); t.ch2 = f(32, 16); t.group2 = f(48, 16)
                add("CHANNEL A", chs(t.ch!!)); add("TALKGROUP A", "${t.group}"); add("CHANNEL B", chs(t.ch2!!)); add("TALKGROUP B", "${t.group2}")
            }
            0x03 -> {
                t.kind = "update"; val svc = f(0, 8); t.svc = svc; t.ch = f(16, 16); t.ch2 = f(32, 16); t.group = f(48, 16)
                add("SERVICE OPTIONS", "${hx(svc, 2)} (${svcText(svc)})"); add("CHANNEL (TX)", chs(t.ch!!)); add("CHANNEL (RX)", chs(t.ch2!!)); add("TALKGROUP", "${t.group}")
            }
            0x04, 0x06, 0x10 -> {
                t.kind = if (op == 0x10) "datagrant" else "u2u"; t.ch = f(0, 16); t.dst = f(16, 24); t.src = f(40, 24)
                add("CHANNEL", chs(t.ch!!)); add("TARGET", "${t.dst}"); add("SOURCE", "${t.src}")
            }
            0x05 -> {
                t.kind = "u2u"; val svc = f(0, 8); t.svc = svc; t.dst = f(16, 24); t.src = f(40, 24)
                add("SERVICE OPTIONS", "${hx(svc, 2)} (${svcText(svc)})"); add("TARGET", "${t.dst}"); add("SOURCE", "${t.src}")
            }
            0x08, 0x09 -> {
                t.kind = "grant"; val svc = f(0, 8); t.svc = svc; t.ch = f(8, 16); t.dst = f(40, 24)
                add("SERVICE OPTIONS", "${hx(svc, 2)} (${svcText(svc)})"); add("CHANNEL", chs(t.ch!!)); add("CALL TIMER", "${f(24, 16)}"); add("TARGET", "${t.dst}")
            }
            0x12 -> {
                t.kind = "datagrant"; t.ch = f(0, 16); t.group = f(16, 16)
                add("CHANNEL A", chs(t.ch!!)); add("TALKGROUP A", "${t.group}"); add("CHANNEL B", chs(f(32, 16))); add("TALKGROUP B", "${f(48, 16)}")
            }
            0x14 -> {
                t.kind = "datagrant"; val svc = f(0, 8); t.svc = svc; t.ch = f(8, 16); t.ch2 = f(24, 16); t.dst = f(40, 24)
                add("SERVICE OPTIONS", hx(svc, 2)); add("CHANNEL (TX)", chs(t.ch!!)); add("CHANNEL (RX)", if (t.ch2 == 0xffff) "same" else chs(t.ch2!!)); add("TARGET", "${t.dst}")
            }
            0x16 -> {
                t.kind = "dataann"; val c = f(16, 16); if (c != 0xffff) t.ch = c
                add("FLAGS", hx(f(0, 16), 4)); add("CHANNEL (TX)", if (c == 0xffff) "none" else chs(c)); add("CHANNEL (RX)", if (f(32, 16) == 0xffff) "same" else chs(f(32, 16)))
                add("SYSTEM SERVICE CLASS", hx(f(48, 16), 4))
            }
            0x18, 0x1c, 0x1f, 0x1d, 0x1a, 0x15 -> {
                t.kind = "unit"; t.dst = f(16, 24); t.src = f(40, 24)
                add("INFO", hx(f(0, 16), 4)); add("TARGET", "${t.dst}"); add("SOURCE", "${t.src}")
            }
            0x20, 0x21, 0x27 -> {
                t.kind = "unit"; t.dst = f(40, 24)
                add("SERVICE TYPE", hx(f(2, 6), 2)); if (op != 0x20) add("REASON", hx(f(8, 8), 2))
                add("ADDITIONAL INFO", if (op == 0x20) hx(f(8, 32), 8) else hx(f(16, 24), 6)); add("TARGET", "${t.dst}")
            }
            0x28 -> {
                t.kind = "affil"; t.group = f(24, 16); t.dst = f(40, 24)
                add("RESPONSE", RESP[f(6, 2)]); add("ANNOUNCEMENT GROUP", "${f(8, 16)}"); add("TALKGROUP", "${t.group}"); add("TARGET", "${t.dst}")
            }
            0x2a -> {
                t.kind = "unit"; t.dst = f(16, 24); t.src = f(40, 24)
                add("TARGET", "${t.dst}"); add("SOURCE", hx(t.src!!, 6))
            }
            0x2b -> {
                t.kind = "affil"; t.group = f(8, 16); t.rfss = f(24, 8); t.site = f(32, 8); t.dst = f(40, 24)
                add("RESPONSE", RESP[f(6, 2)]); add("TALKGROUP", "${t.group}"); add("RFSS", "${t.rfss}"); add("SITE", "${t.site}"); add("TARGET", "${t.dst}")
            }
            0x2c -> {
                t.kind = "reg"; t.sys = f(4, 12); t.src = f(16, 24); t.dst = f(40, 24)
                add("RESPONSE", RESP[f(2, 2)]); add("SYSTEM", hx(t.sys!!, 3)); add("UNIT ID", "${t.src}"); add("ADDRESS", "${t.dst}")
            }
            0x2d -> {
                t.kind = "reg"; t.dst = f(16, 24); t.src = f(40, 24)
                add("TARGET", "${t.dst}"); add("SOURCE", hx(t.src!!, 6))
            }
            0x2f -> {
                t.kind = "dereg"; t.wacn = f(8, 20); t.sys = f(28, 12); t.src = f(40, 24)
                add("WACN", hx(t.wacn!!, 5)); add("SYSTEM", hx(t.sys!!, 3)); add("UNIT ID", "${t.src}")
            }
            0x30 -> {
                t.kind = "time"
                val y = 2000 + f(24, 7); val mo = f(31, 4); val d = f(35, 5); val hr = f(40, 5); val mi = f(45, 6); val us = f(51, 13)
                val sec = us * 0.0075
                t.time = "$y-${pad2(mo)}-${pad2(d)} ${pad2(hr)}:${pad2(mi)}:${String.format(java.util.Locale.US, "%.2f", sec).padStart(5, '0')} UTC"
                add("DATE AND TIME", t.time!!); add("MICROSLOTS", "$us (7.5 ms)"); add("HEADER BITS", hx(f(0, 24), 6))
            }
            0x35 -> {
                t.kind = "time"
                val mo = f(16, 4); val d = f(20, 5); val y = f(25, 13); val hr = f(40, 5); val mi = f(45, 6); val s = f(51, 6)
                t.time = "$y-${pad2(mo)}-${pad2(d)} ${pad2(hr)}:${pad2(mi)}:${pad2(s)}"
                add("DATE AND TIME", t.time!!); add("FLAGS AND OFFSET", hx(f(0, 16), 4))
            }
            0x29 -> {
                t.kind = "sccb"; t.rfss = f(0, 8); t.site = f(8, 8); t.ch = f(16, 16); t.ch2 = f(32, 16); t.cls = f(48, 8)
                add("RFSS", "${t.rfss}"); add("SITE", "${t.site}"); add("CHANNEL (TX)", chs(t.ch!!)); add("CHANNEL (RX)", chs(t.ch2!!)); add("SERVICE CLASS", hx(t.cls!!, 2))
            }
            0x39 -> {
                t.kind = "sccb"; t.rfss = f(0, 8); t.site = f(8, 8); t.ch = f(16, 16); t.cls = f(32, 8); t.ch2 = f(40, 16)
                add("RFSS", "${t.rfss}"); add("SITE", "${t.site}"); add("CHANNEL 1", chs(t.ch!!)); add("SERVICE CLASS 1", hx(t.cls!!, 2)); add("CHANNEL 2", chs(t.ch2!!))
                add("SERVICE CLASS 2", hx(f(56, 8), 2))
            }
            0x3a -> {
                t.kind = "rfss"; t.lra = f(0, 8); t.sys = f(12, 12); t.rfss = f(24, 8); t.site = f(32, 8); t.ch = f(40, 16); t.cls = f(56, 8)
                add("LRA", hx(t.lra!!, 2)); add("FLAGS", hx(f(8, 4), 1)); add("SYSTEM", hx(t.sys!!, 3)); add("RFSS", "${t.rfss}"); add("SITE", "${t.site}")
                add("CHANNEL", chs(t.ch!!)); add("SERVICE CLASS", hx(t.cls!!, 2))
            }
            0x3b -> {
                t.kind = "net"; t.lra = f(0, 8); t.wacn = f(8, 20); t.sys = f(28, 12); t.ch = f(40, 16); t.cls = f(56, 8)
                add("LRA", hx(t.lra!!, 2)); add("WACN", hx(t.wacn!!, 5)); add("SYSTEM", hx(t.sys!!, 3)); add("CHANNEL", chs(t.ch!!)); add("SERVICE CLASS", hx(t.cls!!, 2))
            }
            0x3c -> {
                t.kind = "adj"; t.lra = f(0, 8); t.sys = f(12, 12); t.rfss = f(24, 8); t.site = f(32, 8); t.ch = f(40, 16); t.cls = f(56, 8)
                add("LRA", hx(t.lra!!, 2)); add("FLAGS", hx(f(8, 4), 1)); add("SYSTEM", hx(t.sys!!, 3)); add("RFSS", "${t.rfss}"); add("SITE", "${t.site}")
                add("CHANNEL", chs(t.ch!!)); add("SERVICE CLASS", hx(t.cls!!, 2))
            }
            0x3d -> {
                val off = f(13, 9); val sp = f(22, 10) * 125
                t.kind = "iden"
                t.iden = Iden(f(0, 4), field(b, 32, 32) * 5, sp, (if ((off and 0x100) != 0) 1L else -1L) * (off and 0xff) * 250_000L, f(4, 9) * 125, false, 1, "FDMA", Codes.hex(b, 2, 10))
            }
            0x33 -> {
                val ty = f(4, 4); val off = f(8, 14); val sp = f(22, 10) * 125
                t.kind = "iden"
                t.iden = Iden(f(0, 4), field(b, 32, 32) * 5, sp, (if ((off and 0x2000) != 0) 1L else -1L) * (off and 0x1fff) * sp, 0, true, TDMA_SLOTS[ty] ?: 2, "TDMA type $ty", Codes.hex(b, 2, 10))
            }
            0x34 -> {
                val off = f(8, 14); val sp = f(22, 10) * 125
                t.kind = "iden"
                t.iden = Iden(f(0, 4), field(b, 32, 32) * 5, sp, (if ((off and 0x2000) != 0) 1L else -1L) * (off and 0x1fff) * sp, f(4, 4), false, 1, "VHF/UHF", Codes.hex(b, 2, 10))
            }
            else -> add("PAYLOAD", Codes.hex(b, 2, 10))
        }
        t.iden?.let { i ->
            add("IDENTIFIER", "${i.iden}"); add("FORM", i.form); add("BASE", "%.5f MHz".format(java.util.Locale.US, i.base / 1e6)); add("SPACING", "%.3f kHz".format(java.util.Locale.US, i.spacing / 1e3))
            add("TX OFFSET", "${if (i.txOffset >= 0) "+" else ""}${"%.4f".format(java.util.Locale.US, i.txOffset / 1e6)} MHz")
            if (i.tdma) add("SLOTS", "${i.slots}") else if (i.bw != 0) add("BANDWIDTH", if (i.form == "FDMA") "%.2f kHz".format(java.util.Locale.US, i.bw / 1e3) else "code ${i.bw}")
        }
        return t
    }

    /** A channel number through a site's identifier table: frequency, slot and whether it is a TDMA (Phase 2) channel. */
    fun resolve(ch: Int, tables: Map<Int, Iden>): Resolved? {
        val i = tables[ch shr 12] ?: return null
        if (i.spacing == 0) return null
        val n = ch and 0xfff; val s = if (i.tdma) maxOf(1, i.slots) else 1
        return Resolved(i.base + (n / s).toLong() * i.spacing, n % s, i.tdma && s > 1)
    }

    /** One line for the log: name and its fields. */
    fun line(t: Tsbk): String =
        t.name + if (t.fields.isNotEmpty()) " · " + t.fields.joinToString(" · ") { "${it.k.lowercase()} ${it.v}" } else ""
}
