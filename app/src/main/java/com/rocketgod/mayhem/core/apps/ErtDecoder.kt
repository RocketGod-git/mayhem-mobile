package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sqrt

/**
 * ERT utility-meter receiver (Mayhem proc_ert + ert_packet.cpp, rtlamr): Itron SCM / SCM+ / IDM packets, OOK
 * Manchester around 912 MHz: 32768 chips a second, two chips a bit (16384 bits a second). Like Mayhem, it works on
 * chips: every edge sits on a chip boundary, so the clock has one place to lock (on bits, a run of equal bits has
 * edges at the boundary and mid-bit alike and the clock can sit half a bit off). The preambles are matched on chips
 * with one chip wrong allowed, then each chip pair is a bit (the louder chip first = 1). SCM and SCM+/IDM are hunted
 * at the same time, each with its own buffer. Neptune R900 water meters are hunted beside them.
 */
class ErtDecoder(private val log: PacketLog) : IqProcessor {
    /** Every reading that passed its check: (SCM, SCM+, IDM or R900, meter id, commodity, consumption, other fields). */
    var onReading: ((String, Long, String, Long, List<Pair<String, String>>) -> Unit)? = null

    private var spc = 61.0
    private var smoothK = 0.06f
    private var smooth = 0f
    private var phase = 0.0
    private var cSum = 0f
    private var cN = 0
    private var envMax = 10f
    private var envMin = 0f
    private var lastAbove = false
    private var dcI = 127.4f; private var dcQ = 127.4f
    /** The last 64 hard chips, newest in bit 0. */
    private var chips = 0L
    /** Chip energies since a preamble: SCM's and SCM+/IDM's, two a bit. */
    private val scmE = FloatArray(150); private var scmCount = -1
    private val plusE = FloatArray(1408); private var plusCount = -1
    private var idmCandidate = false
    private val scm = ByteArray(75)
    private val plus = ByteArray(704)
    private val r9E = FloatArray(168); private var r9Count = -1

    override fun reset(rate: Int) {
        spc = rate / CHIP_RATE
        smoothK = (1.0 / max(1.0, spc / 4.0)).toFloat()   // time constant a quarter of a chip
        smooth = 0f; phase = 0.0; cSum = 0f; cN = 0; envMax = 10f; envMin = 0f; lastAbove = false
        chips = 0L; scmCount = -1; plusCount = -1; r9Count = -1
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val nSamp = len / 2
        if (nSamp <= 0) return
        // DC offset: track the buffer mean slowly (Mayhem averages the same way).
        var sI = 0f; var sQ = 0f
        for (i in 0 until nSamp) { sI += (iq[2 * i].toInt() and 0xff); sQ += (iq[2 * i + 1].toInt() and 0xff) }
        dcI += 0.2f * (sI / nSamp - dcI); dcQ += 0.2f * (sQ / nSamp - dcQ)
        val inc = 1.0 / spc
        for (i in 0 until nSamp) {
            val iv = (iq[2 * i].toInt() and 0xff) - dcI
            val qv = (iq[2 * i + 1].toInt() and 0xff) - dcQ
            val mag = sqrt(iv * iv + qv * qv)
            smooth += (mag - smooth) * smoothK
            val above = smooth > (envMax + envMin) * 0.5f
            if (above != lastAbove) {
                // An edge sits on a chip boundary; the smoothing has delayed it about a quarter chip.
                var p = phase - 0.25
                if (p < 0) p += 1
                phase -= (p - floor(p + 0.5)) * 0.1
                if (phase < 0.0) phase += 1.0
            }
            lastAbove = above
            cSum += mag; cN++
            phase += inc
            if (phase >= 1.0) {
                phase -= 1.0
                val e = cSum / max(1, cN); cSum = 0f; cN = 0
                if (e > envMax) envMax = e else envMax += (e - envMax) * 0.002f
                if (e < envMin) envMin = e else envMin += (e - envMin) * 0.002f
                onChip(e, e > (envMax + envMin) * 0.5f)
            }
        }
    }

    private fun near(want: Long, nChips: Int): Boolean {
        val mask = if (nChips >= 64) -1L else (1L shl nChips) - 1
        return java.lang.Long.bitCount((chips xor want) and mask) <= 1
    }

    private fun onChip(e: Float, on: Boolean) {
        chips = (chips shl 1) or (if (on) 1L else 0L)
        if (scmCount >= 0) {
            scmE[scmCount++] = e
            if (scmCount >= 150) { for (k in 0 until 75) scm[k] = if (scmE[2 * k] > scmE[2 * k + 1]) 1 else 0; checkScm(); scmCount = -1 }
        } else if (near(SCM_SYNC, 32)) scmCount = 0
        if (plusCount >= 0) {
            plusE[plusCount++] = e
            if (plusCount == 224 || plusCount == 1408) {
                for (k in (if (plusCount == 224) 0 else 112) until plusCount / 2) plus[k] = if (plusE[2 * k] > plusE[2 * k + 1]) 1 else 0
                if (plusCount == 224) { if (checkScmPlus()) plusCount = -1 }
                else { if (idmCandidate) checkIdm(); plusCount = -1 }
            }
        } else if (near(PLUS_SYNC, 32)) { plusCount = 0; idmCandidate = near(IDM_SYNC, 48) }
        if (r9Count >= 0) {
            r9E[r9Count++] = e
            if (r9Count >= 168) { checkR900(); r9Count = -1 }
        } else if (near(R900_SYNC, 32)) r9Count = 0
    }

    private fun rd(buf: ByteArray, start: Int, len: Int): Long {
        var v = 0L
        for (i in 0 until len) v = (v shl 1) or buf[start + i].toLong()
        return v
    }

    private fun checkScm() {
        // BCH(255,239) poly 0x6F63 over the 5 trailing preamble zeros + 75 bits → leading zeros are a no-op.
        if (crc16(scm, 75, 0x6F63, 0) != 0) return
        val id = (rd(scm, 0, 2) shl 24) or rd(scm, 35, 24)
        val type = rd(scm, 5, 4).toInt()
        val consumption = rd(scm, 11, 24)
        val tamperPhy = rd(scm, 3, 2); val tamperEnc = rd(scm, 9, 2)
        log.add("SCM  ID %-10d %-8s cons %d tamper p%d/e%d".format(id, commodity(type), consumption, tamperPhy, tamperEnc))
        onReading?.invoke("SCM", id, commodity(type), consumption, listOf("TAMPER" to "physical $tamperPhy · encoder $tamperEnc", "ERT TYPE" to "$type"))
    }

    private fun checkScmPlus(): Boolean {
        if (crc16(plus, 112, 0x1021, 0xFFFF) != 0x1D0F) return false
        val type = rd(plus, 12, 4).toInt()
        val id = rd(plus, 16, 32)
        val consumption = rd(plus, 48, 32)
        val tamper = rd(plus, 80, 16)
        log.add("SCM+ ID %-10d %-8s cons %d tamper 0x%04x".format(id, commodity(type), consumption, tamper))
        onReading?.invoke("SCM+", id, commodity(type), consumption, listOf("TAMPER" to "%04X".format(tamper), "ERT TYPE" to "$type"))
        return true
    }

    private fun checkIdm() {
        if (crc16(plus, 704, 0x1021, 0xFFFF) != 0x1D0F) return
        val type = rd(plus, 36, 4).toInt()
        val id = rd(plus, 40, 32)
        val consumption = rd(plus, 200, 32)
        log.add("IDM  ID %-10d %-8s cons %d".format(id, commodity(type), consumption))
        onReading?.invoke("IDM", id, commodity(type), consumption, listOf("ERT TYPE" to "$type"))
    }

    private fun checkR900() {
        val r = decodeR900(r9E) ?: return
        log.add(r.line); onReading?.invoke("R900", r.id, "water", r.cons, r.extra)
    }

    private fun commodity(t: Int): String = when (t) {
        4, 5, 7, 8 -> "electric"
        2, 9, 12 -> "gas"
        3, 11, 13 -> "water"
        else -> "type$t"
    }

    /** A decoded R900 packet: meter id, consumption, the other fields and its log line. */
    class R900(val id: Long, val cons: Long, val extra: List<Pair<String, String>>, val line: String)

    companion object {
        /** Mayhem's rate: 128 samples a chip. A radio that cannot take it (RTL-SDR) runs the engine's 2 Msps. */
        const val RATE = 4_194_304
        const val CHIP_RATE = 32_768.0

        /** Bits as Manchester chips (1 -> 10, 0 -> 01), oldest first in the high bits. */
        private fun manchester(v: Int, nBits: Int): Long {
            var c = 0L
            for (k in 0 until nBits) { val b = (v shr (nBits - 1 - k)) and 1; c = (c shl 2) or (if (b == 1) 0b10L else 0b01L) }
            return c
        }
        // Mayhem's: the tail of SCM's 0x1F2A60 (32 chips), SCM+'s 0x16A3 (32), IDM's 0x5516A3 (48)
        private val SCM_SYNC = manchester(0x2A60, 16)
        private val PLUS_SYNC = manchester(0x16A3, 16)
        private val IDM_SYNC = manchester(0x5516A3, 24)
        /** Neptune R900 (water): 32 chips of preamble, sent as chips (on = 1), at the same 32768 chips a second as ERT. */
        private const val R900_SYNC = 0b00000000000000001110010101100100L

        /** CRC over the first [n] bits, MSB-first, non-reflected. */
        fun crc16(buf: ByteArray, n: Int, poly: Int, init: Int): Int {
            var crc = init
            for (i in 0 until n) {
                val bit = buf[i].toInt()
                val msb = (crc shr 15) and 1
                crc = (crc shl 1) and 0xFFFF
                if ((msb xor bit) != 0) crc = crc xor poly
            }
            return crc and 0xFFFF
        }

        // ---- Neptune R900 (rtlamr's layout): 42 base-6 digits, each a balanced 4-chip word, two digits a 5-bit
        // symbol, 16 data symbols and 5 Reed-Solomon parity symbols over GF(32) (x^5 + x^2 + 1, roots a^29..a^33) ----
        private val gfExp = IntArray(64).also { e ->
            var x = 1
            for (i in 0 until 31) { e[i] = x; x = x shl 1; if (x and 32 != 0) x = x xor 37 }
            for (i in 31 until 64) e[i] = e[i - 31]
        }
        private val gfLog = IntArray(32).also { l -> for (i in 0 until 31) l[gfExp[i]] = i }
        private fun gfMul(a: Int, b: Int): Int = if (a == 0 || b == 0) 0 else gfExp[(gfLog[a] + gfLog[b]) % 31]

        /** The 31-symbol codeword (16 data, 10 zeros, 5 parity) has a zero syndrome at a^29..a^33, read either way round. */
        fun r900Valid(sym: List<Int>): Boolean {
            val cw = IntArray(31)
            for (i in 0 until 16) cw[i] = sym[i]
            for (i in 0 until 5) cw[26 + i] = sym[16 + i]
            for (rev in booleanArrayOf(false, true)) {
                var ok = true
                for (j in 0 until 5) {
                    val root = gfExp[(29 + j) % 31]
                    var s = 0
                    for (i in 0 until 31) s = gfMul(s, root) xor (if (rev) cw[30 - i] else cw[i])   // Horner: highest power first
                    if (s != 0) { ok = false; break }
                }
                if (ok) return true
            }
            return false
        }

        /** Digits from chip energies: each 4-chip word against 1100, 1010, 1001 (and their inverses by sign). */
        fun r900Symbols(e: FloatArray): List<Int>? {
            val digits = IntArray(42)
            for (k in 0 until 42) {
                val c0 = e[4 * k]; val c1 = e[4 * k + 1]; val c2 = e[4 * k + 2]; val c3 = e[4 * k + 3]
                val a = floatArrayOf(c0 + c1 - c2 - c3, c0 - c1 + c2 - c3, c0 - c1 - c2 + c3)
                var best = 0
                for (i in 1 until 3) if (abs(a[i]) > abs(a[best])) best = i
                digits[k] = best + if (a[best] > 0) 3 else 0
            }
            val sym = ArrayList<Int>(21)
            for (i in 0 until 21) {
                val v = digits[2 * i] * 6 + digits[2 * i + 1]
                if (v > 31) return null
                sym.add(v)
            }
            return sym
        }

        /** A decoded R900 packet, or null if the chips do not check out. */
        fun decodeR900(e: FloatArray): R900? {
            val sym = r900Symbols(e) ?: return null
            if (!r900Valid(sym)) return null
            val bits = IntArray(80)
            var n = 0
            for (s in sym.take(16)) for (b in 4 downTo 0) bits[n++] = (s shr b) and 1
            fun f(a: Int, len: Int): Long { var v = 0L; for (i in a until a + len) v = (v shl 1) or bits[i].toLong(); return v }
            val id = f(0, 32); val unkn1 = f(32, 8); val noUse = f(40, 6); val backflow = f(46, 2); val cons = f(48, 24)
            val unkn3 = f(72, 2); val leak = f(74, 4); val leakNow = f(78, 2)
            val line = "R900 ID %-10d water    cons %d leak %d now %d backflow %d no-use %d".format(id, cons, leak, leakNow, backflow, noUse)
            return R900(id, cons, listOf(
                "LEAK" to r900Leak(leak) + " (code $leak)",
                "LEAKING NOW" to if (leakNow == 0L) "no" else "yes ($leakNow)",
                "BACKFLOW" to when (backflow) { 0L -> "none"; 1L -> "low"; else -> "high ($backflow)" },
                "NO USE" to if (noUse == 0L) "used recently" else "no-use code $noUse (longer without use as it rises)",
                "UNKNOWN" to "%02X · %d".format(unkn1, unkn3),
            ), line)
        }

        /** The leak code: 0 is none; higher codes mean longer runs of continuous flow (Neptune does not publish the scale). */
        fun r900Leak(v: Long): String = if (v == 0L) "none" else "continuous flow, level $v of 15"
    }
}
