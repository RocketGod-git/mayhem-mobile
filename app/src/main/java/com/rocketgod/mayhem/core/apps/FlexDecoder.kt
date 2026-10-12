package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs

/**
 * FLEX pager decoder — port of Mayhem's proc_flex.cpp (multimon-ng lineage): 1600/3200 bps, 2- and 4-level FSK,
 * sync + FIW + block-interleaved BCH(31,21) phases, BIW / address / vector parsing for alphanumeric, numeric
 * (standard, special, numbered), short-message, tone, hex and instruction pages. Rides on the NFM discriminator
 * next to [PocsagDecoder] so one channel decodes both, the way PDW does.
 */
class FlexDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true

    private var fmRate = 0
    // demodulator
    private var sampleFreq = 24000; private var sampleLast = 0f; private var locked = 0; private var phase = 0.0
    private var envelopeSum = 0.0; private var envelopeCount = 0; private var lockBuf = 0L; private val symcount = IntArray(4)
    private var timeout = 0; private var nonconsec = 0; private var baud = 1600
    private var envelope = 0.0; private var zero = 0.0
    // frame state
    private var st = SYNC1; private var sync2Count = 0; private var dataCount = 0; private var fiwCount = 0
    private var sync2Shift = 0; private var sync2CPos = -1; private var sync2CinvPos = -1
    private var syncBaud = 0; private var syncLevels = 0; private var polarity = 0; private var syncBuf = 0L
    private var fiwRaw = 0; private var cycleNo = 0; private var frameNo = 0
    private val ph = Array(4) { IntArray(88) }
    private val idle = IntArray(4)
    private var phaseToggle = 0; private var dataBitCounter = 0
    // decode
    private var dType = 5; private var longAddress = 0; private var capcode = 0L; private var addrType = 0; private var isPriority = 0
    private val ecc = PocsagEcc()
    private var frames = 0; private var lastStat = 0L

    override fun reset(rate: Int) { fmRate = 0; locked = 0; st = SYNC1 }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) { fmRate = rate; sampleFreq = rate; locked = 0; st = SYNC1; zero = 0.0; phase = 0.0 }
        for (i in 0 until n) demodulate(samples[i])
        val now = System.currentTimeMillis()
        if (now - lastStat > 5000 && frames > 0) { lastStat = now; Diag.log("FLEX: $frames frames decoded, locked=$locked") }
    }

    private fun demodulate(sample: Float) {
        if (buildSymbol(sample) != 1) return
        nonconsec = 0
        var decmax = 0; var modal = 0
        for (j in 0 until 4) if (symcount[j] > decmax) { modal = j; decmax = symcount[j] }
        symcount.fill(0)
        if (locked != 0) flexSym(modal)
        else {
            lockBuf = (lockBuf shl 2) or (modal xor 1).toLong()
            val pat = lockBuf xor LOCK_PATTERN
            if ((pat and LOCK_MASK) == 0L || (pat.inv() and LOCK_MASK) == 0L) { locked = 1; lockBuf = 0L }
        }
        if (++timeout > DEMOD_TIMEOUT) locked = 0
    }

    private fun buildSymbol(sampleIn: Float): Int {
        val phaseMax = 100.0 * sampleFreq
        val phaseRate = 100.0 * baud
        val pct = 100.0 * phase / phaseMax
        var sample = sampleIn.toDouble()
        if (st == SYNC1) { val k = sampleFreq * DC_OFFSET_FILTER; zero = (zero * k + sample) / (k + 1) }
        sample -= zero
        if (locked != 0) {
            if (st == SYNC1) { envelopeSum += abs(sample); envelopeCount++; envelope = envelopeSum / envelopeCount }
        } else {
            envelope = 0.0; envelopeSum = 0.0; envelopeCount = 0; baud = 1600; timeout = 0; nonconsec = 0; st = SYNC1
        }
        if (pct > 10 && pct < 90) {
            if (sample > 0) { if (sample > envelope * SLICE_THRESHOLD) symcount[3]++ else symcount[2]++ }
            else { if (sample < -envelope * SLICE_THRESHOLD) symcount[0]++ else symcount[1]++ }
        }
        if ((sampleLast < 0 && sample >= 0) || (sampleLast >= 0 && sample < 0)) {
            val err = if (pct < 50) phase else phase - phaseMax
            phase -= err * (if (locked != 0) PHASE_LOCKED_RATE else PHASE_UNLOCKED_RATE)
            if (pct > 10 && pct < 90) { if (++nonconsec > 20 && locked != 0) locked = 0 } else nonconsec = 0
            timeout = 0
        }
        sampleLast = sample.toFloat()
        phase += phaseRate
        if (phase > phaseMax) { phase -= phaseMax; return 1 }
        return 0
    }

    private fun syncCheck(buf: Long): Int {
        val marker = ((buf ushr 16) and 0xFFFFFFFFL).toInt()
        val codehigh = ((buf ushr 48) and 0xFFFFL).toInt()
        val codelow = (buf and 0xFFFFL).toInt().inv() and 0xFFFF
        return if (Integer.bitCount(marker xor FLEX_SYNC_MARKER) < 4 && Integer.bitCount(codelow xor codehigh) < 4) codehigh else 0
    }
    private fun flexSync(sym: Int): Int {
        syncBuf = (syncBuf shl 1) or (if (sym < 2) 1L else 0L)
        var r = syncCheck(syncBuf)
        if (r != 0) { polarity = 0; return r }
        r = syncCheck(syncBuf.inv())
        if (r != 0) polarity = 1
        return r
    }
    private fun decodeMode(code: Int) {
        for (m in MODES) if (Integer.bitCount(m[0] xor code) < 4) { syncBaud = m[1]; syncLevels = m[2]; return }
        syncBaud = 1600; syncLevels = 2
    }
    /** BCH-fix a received word (bit 0 first on air): returns the corrected value or null when uncorrectable. */
    private fun bchFix(v: Int): Int? {
        val rev = Integer.reverse(v)
        val e = ecc.correct(rev)
        return if (e <= 2) Integer.reverse(ecc.out) else null
    }
    private fun decodeFiw(): Boolean {
        val f = bchFix(fiwRaw) ?: return false
        cycleNo = (f ushr 4) and 0xF; frameNo = (f ushr 8) and 0x7F
        val cs = (f and 0xF) + ((f ushr 4) and 0xF) + ((f ushr 8) and 0xF) + ((f ushr 12) and 0xF) + ((f ushr 16) and 0xF) + ((f ushr 20) and 1)
        return (cs and 0xF) == 0xF
    }

    private fun readData(sym: Int): Boolean {
        val bitA = if (sym > 1) 1 else 0
        val bitB = if (syncLevels == 4 && (sym == 1 || sym == 2)) 1 else 0
        if (syncBaud == 1600) phaseToggle = 0
        val idx = ((dataBitCounter ushr 5) and 0xFFF8) or (dataBitCounter and 7)
        if (idx >= 88) return false
        val a = ph[0]; val b = ph[1]; val c = ph[2]; val d = ph[3]
        if (phaseToggle == 0) {
            a[idx] = (a[idx] ushr 1) or (if (bitA != 0) Int.MIN_VALUE else 0)
            b[idx] = (b[idx] ushr 1) or (if (bitB != 0) Int.MIN_VALUE else 0)
            phaseToggle = 1
            if ((dataBitCounter and 0xFF) == 0xFF) {
                if (a[idx] == 0 || a[idx] == -1) idle[0]++
                if (b[idx] == 0 || b[idx] == -1) idle[1]++
            }
        } else {
            c[idx] = (c[idx] ushr 1) or (if (bitA != 0) Int.MIN_VALUE else 0)
            d[idx] = (d[idx] ushr 1) or (if (bitB != 0) Int.MIN_VALUE else 0)
            phaseToggle = 0
            if ((dataBitCounter and 0xFF) == 0xFF) {
                if (c[idx] == 0 || c[idx] == -1) idle[2]++
                if (d[idx] == 0 || d[idx] == -1) idle[3]++
            }
        }
        if (syncBaud == 1600 || phaseToggle == 0) dataBitCounter++
        val t = IDLE_THRESHOLD
        return if (syncBaud == 1600) (if (syncLevels == 2) idle[0] > t else (idle[0] > t && idle[1] > t))
        else (if (syncLevels == 2) (idle[0] > t && idle[2] > t) else (idle[0] > t && idle[1] > t && idle[2] > t && idle[3] > t))
    }

    private fun flexSym(sym: Int) {
        val rect = if (polarity != 0) 3 - sym else sym
        when (st) {
            SYNC1 -> {
                val code = flexSync(sym)
                if (code != 0) { decodeMode(code); st = FIW } else st = SYNC1
                fiwCount = 0; fiwRaw = 0
            }
            FIW -> {
                fiwCount++
                if (fiwCount >= 16) fiwRaw = (fiwRaw ushr 1) or (if (rect > 1) Int.MIN_VALUE else 0)
                if (fiwCount == 48) {
                    if (decodeFiw()) { sync2Count = 0; sync2Shift = 0; sync2CPos = -1; sync2CinvPos = -1; baud = syncBaud; st = SYNC2 }
                    else st = SYNC1
                }
            }
            SYNC2 -> {
                val bitA = if (rect > 1) 1 else 0
                sync2Shift = ((sync2Shift shl 1) or bitA) and 0xFFFF
                sync2Count++
                if (sync2Count >= 16) {
                    if (Integer.bitCount(sync2Shift xor 0xED84) <= 2 && sync2CPos < 0) sync2CPos = sync2Count
                    if (Integer.bitCount(sync2Shift xor 0x127B) <= 2 && sync2CinvPos < 0) sync2CinvPos = sync2Count
                }
                val nominal = syncBaud * 25 / 1000
                var end = nominal
                if (sync2CinvPos > 0) { val diff = sync2CinvPos - nominal; if (diff in -1..1) end = sync2CinvPos }
                if (sync2Count == end) {
                    for (p in ph) p.fill(0)
                    idle.fill(0); phaseToggle = 0; dataBitCounter = 0; dataCount = 0
                    sync2Shift = 0; sync2CPos = -1; sync2CinvPos = -1
                    st = DATA
                }
                if (sync2Count > nominal + 1) { sync2Shift = 0; sync2CPos = -1; sync2CinvPos = -1; st = SYNC1 }
            }
            DATA -> {
                val isIdle = readData(rect)
                if (++dataCount == syncBaud * 1760 / 1000 || isIdle) {
                    decodeData()
                    baud = 1600; st = SYNC1; dataCount = 0
                }
            }
        }
    }

    private fun decodeData() {
        frames++
        if (syncBaud == 1600) { decodePhase(0); if (syncLevels == 4) decodePhase(1) }
        else if (syncLevels == 2) { decodePhase(0); decodePhase(2) }
        else for (p in 0 until 4) decodePhase(p)
    }

    private fun packet(type: Int, message: String, extra: String = "") {
        val bitrate = syncBaud * (if (syncLevels == 4) 2 else 1)
        val cap = "%010d".format(capcode)
        val at = if (ADDR_NAMES[addrType].isNotEmpty()) " ${ADDR_NAMES[addrType]}" else ""
        val pri = if (isPriority != 0) " PRI" else ""
        log.add("FLEX $bitrate/${syncLevels}L C${cycleNo}F${"%03d".format(frameNo)} CAP $cap$at$pri ${TYPE_NAMES[type]}$extra${if (message.isNotEmpty()) ": $message" else ""}")
    }

    private fun checksumOk(w: Int): Boolean {
        val cs = (w and 0xF) + ((w ushr 4) and 0xF) + ((w ushr 8) and 0xF) + ((w ushr 12) and 0xF) + ((w ushr 16) and 0xF) + ((w ushr 20) and 1)
        return (cs and 0xF) == 0xF
    }

    private fun decodePhase(pi: Int) {
        val p = ph[pi]
        val phaseNo = "ABCD"[pi]
        var allIdle = true
        for (i in 0 until 88) if (p[i] != -1 && p[i] != 0) { allIdle = false; break }
        if (allIdle) return
        val bad = BooleanArray(88)
        for (i in 0 until 88) {
            val r = bchFix(p[i])
            if (r == null) { bad[i] = true; p[i] = 0 } else p[i] = r
            p[i] = p[i] and 0x001FFFFF
        }
        if (bad[0]) return
        val biw = p[0]
        if (biw == 0 || biw == 0x001FFFFF) return
        val voffset = (biw ushr 10) and 0x3f
        val aoffset = ((biw ushr 8) and 3) + 1
        val prioCount = (biw ushr 4) and 0xF
        if (voffset < aoffset || voffset >= 88) return
        var bw = 1
        while (bw < aoffset && bw < 88) {
            if (!bad[bw]) {
                val w = p[bw]; val bt = (w ushr 4) and 7
                if (bt == 1) Diag.log("FLEX system date %d-%02d-%02d (phase %c)".format(((w ushr 7) and 0x1F) + 1994, (w ushr 17) and 0xF, (w ushr 12) and 0x1F, phaseNo))
                else if (bt == 2) Diag.log("FLEX system time %02d:%02d (phase %c)".format((w ushr 7) and 0x1F, (w ushr 12) and 0x3F, phaseNo))
            }
            bw++
        }
        var nValidVecs = 0
        for (vi in 0 until voffset - aoffset) {
            val wi = voffset + vi; if (wi >= 88) break
            if (checksumOk(p[wi])) nValidVecs = vi + 1
        }
        if (voffset <= aoffset) return
        var vecCount = 0; var addrCount = 0
        var i = aoffset
        while (i < voffset) {
            var j = voffset + vecCount
            if (j >= 88) break
            if (p[i] == 0 || p[i] == 0x001FFFFF) { i++; continue }
            isPriority = if (addrCount < prioCount) 1 else 0
            parseCapcode(p[i])
            addrCount++
            if (longAddress != 0) {
                if (i + 1 >= voffset) break
                val aw1 = p[i].toLong(); val aw2 = p[i + 1].toLong()
                if (aw2 == 0L || aw2 == 0x001FFFFFL) { i += 2; addrCount++; vecCount += 2; continue }
                val cap: Long = when {
                    aw1 in 1..0x8000 && aw2 in 0x1F7FFF..0x1FFFFE -> aw1 + (0x1FFFFF - aw2) * 32768 + 2068480
                    aw1 in 1..0x8000 && aw2 in 0x1E0001..0x1F0000 -> aw1 + (aw2 - 1933312) * 32768 + 2068480
                    aw1 in 0x1F7FFF..0x1FFFFE && aw2 in 0x1E0001..0x1F0000 -> (aw1 - 2064383) + (aw2 - 1867776) * 32768 + 2068479
                    else -> { i += 2; addrCount++; vecCount += 2; continue }
                }
                capcode = cap
                i++; addrCount++
                vecCount += 2
                j = voffset + vecCount - 2
            } else {
                if (capcode > 4297068542L || capcode <= 0) { i++; continue }
                if (vecCount >= nValidVecs) { if (capcode != 1L) packet(2, ""); i++; continue }
                vecCount++
            }
            val viw = p[j]
            val typeVal = (viw ushr 4) and 7
            dType = typeVal
            val mw1 = (viw ushr 7) and 0x7F
            val len = if (typeVal == 3 || typeVal == 4 || typeVal == 7) ((viw ushr 14) and 7) + 1 else (viw ushr 14) and 0x7F
            val mw2 = mw1 + (len - 1)
            if (mw1 == 0 && mw2 == 0) { i++; continue }
            when (dType) {
                PT_ALPHANUMERIC, PT_SECURE -> {
                    if (mw1 <= 87 && mw2 <= 87) { if (longAddress != 0) parseAlpha(p, bad, mw1 - 1, mw2 - 1) else parseAlpha(p, bad, mw1, mw2) }
                }
                PT_STANDARD_NUMERIC, PT_SPECIAL_NUMERIC, PT_NUMBERED_NUMERIC -> parseNumeric(p, bad, j)
                PT_TONE -> {
                    val t = (viw ushr 7) and 3; val dd = (viw ushr 9) and 0xFFF
                    val msg: String = if (t == 0 && dd == 0xCCC && (longAddress == 0 || j + 1 >= 88 || (p[j + 1] and 0xFFFFF) == 0xCCCCC)) "TONE"
                    else if (t == 0) {
                        val sb = StringBuilder("NUM ").append(FLEX_BCD[dd and 0xF]).append(FLEX_BCD[(dd ushr 4) and 0xF]).append(FLEX_BCD[(dd ushr 8) and 0xF])
                        if (longAddress != 0 && j + 1 < 88) { val vy = p[j + 1]; var s = 0; while (s < 20) { sb.append(FLEX_BCD[(vy ushr s) and 0xF]); s += 4 } }
                        sb.toString()
                    } else if (t == 1) "SRC ${dd and 7}"
                    else if (t == 2) "SRC ${dd and 7} N=${(dd ushr 3) and 0x3F} R=${(dd ushr 9) and 1}"
                    else "RESERVED %03X".format(dd)
                    packet(8, msg)
                }
                PT_BINARY -> {
                    if (mw1 <= 87 && mw2 <= 87) {
                        var f = 0; var dataStart = mw1 + 1
                        if (!bad[mw1]) f = (p[mw1] ushr 13) and 3
                        if (f == 3 && mw1 + 1 <= mw2 && !bad[mw1 + 1]) dataStart = mw1 + 2
                        val parts = ArrayList<String>()
                        for (w in dataStart..mw2) parts.add(if (bad[w]) "??????" else "%06X".format(p[w] and 0x1FFFFF))
                        packet(6, parts.joinToString(" "))
                    }
                }
                PT_SHORT_INSTRUCTION -> {
                    val dd = (viw ushr 7) and 0x3FFF; val it = dd and 7
                    val msg = when (it) {
                        0 -> "i=temp|slot=${(dd ushr 10) and 0xF}|target=${(dd ushr 3) and 0x7F}"
                        1 -> "i=event|flags=%03X".format((dd ushr 3) and 0x7FF)
                        else -> "i=rsvd|type=$it|raw=%04X".format(dd)
                    }
                    packet(1, msg)
                }
            }
            i++
        }
    }

    private fun parseCapcode(aw1: Int) {
        longAddress = 0; addrType = 0
        if (aw1 in 1..0x8000 || aw1 in 0x1E0001..0x1F0000 || aw1 in 0x1F7FFF..0x1FFFFE) { longAddress = 1; addrType = 1 }
        else if (aw1 in 0x1F7800..0x1F780F) addrType = 2
        else if (aw1 in 0x1F7810..0x1F781F) addrType = 3
        else if (aw1 in 0x1F6800..0x1F77FF) addrType = 4
        else if (aw1 in 0x1F2800..0x1F67FF) addrType = 5
        else if (aw1 in 0x1F0001..0x1F27FF || aw1 in 0x1F7820..0x1F7FFE) addrType = 6
        else if (aw1 in 0x8001..0x1E0000) addrType = 0
        else addrType = 7
        capcode = (aw1 - 0x8000).toLong()
    }

    private fun parseAlpha(p: IntArray, bad: BooleanArray, mw1In: Int, mw2: Int) {
        var mw1 = mw1In
        var frag = -1; var more = 0; var seq = 0
        if (mw1 in 0..87 && !bad[mw1]) { val h = p[mw1]; more = (h ushr 10) and 1; frag = (h ushr 11) and 3; seq = (h ushr 13) and 0x3F }
        mw1++
        val chars = ArrayList<Int>()
        fun put(ch: Int, isBad: Boolean) { if (isBad) chars.add(63) else if (ch >= 0x20 || ch == 0x0A || ch == 0x0D) chars.add(ch) else if (ch == 3 || ch == 0) chars.add(3) }
        for (i in mw1..mw2) {
            val isBad = i !in 0..87 || bad[i]
            val dw = if (isBad) 0 else p[i]
            if (i > mw1) put(dw and 0x7F, isBad)
            put((dw ushr 7) and 0x7F, isBad)
            put((dw ushr 14) and 0x7F, isBad)
        }
        var last = -1
        for (k in chars.indices) if (chars[k] != 3) last = k
        val sb = StringBuilder()
        for (k in 0..last) sb.append(if (chars[k] == 3) '?' else chars[k].toChar())
        val flags = if (frag >= 0) (if (frag == 3) (if (more != 0) " (1/… #$seq)" else "") else " (cont $frag #$seq${if (more != 0) " …" else ""})") else ""
        packet(if (dType == PT_SECURE) 0 else 5, sb.toString(), flags)
    }

    private fun parseNumeric(p: IntArray, bad: BooleanArray, j: Int) {
        val isNnum = dType == PT_NUMBERED_NUMERIC
        var w1 = p[j] ushr 7
        var w2 = w1 ushr 7
        w1 = w1 and 0x7F
        val nField = w2 and 7
        w2 = nField + w1
        if (w1 > 87) return
        if (w2 > 87) w2 = 87
        val body0 = if (longAddress != 0 && nField > 0) j + 1 else w1
        if (body0 !in 0..87) return
        var dw = p[body0]
        var digit = 0; var count = 4 + (if (isNnum) 10 else 2)
        val sb = StringBuilder()
        if (bad[body0]) { var lost = (21 - (count - 4)) / 4; while (lost-- > 0) sb.append('?'); count = 4; digit = 0 }
        else {
            for (k in 0 until 21) {
                digit = (digit ushr 1) and 0xF; if ((dw and 1) != 0) digit = digit xor 8; dw = dw ushr 1
                if (--count == 0) { sb.append(FLEX_BCD[digit]); count = 4 }
            }
        }
        val start = if (longAddress != 0) w1 else w1 + 1
        val end = if (longAddress != 0) w1 + nField - 1 else w2
        var i = start
        while (i <= end && i < 88) {
            if (bad[i]) { sb.append("?????"); count = 4; digit = 0; i++; continue }
            dw = p[i]
            for (k in 0 until 21) {
                digit = (digit ushr 1) and 0xF; if ((dw and 1) != 0) digit = digit xor 8; dw = dw ushr 1
                if (--count == 0) { sb.append(FLEX_BCD[digit]); count = 4 }
            }
            i++
        }
        packet(if (dType == PT_SPECIAL_NUMERIC) 4 else if (isNnum) 7 else 3, sb.toString().trimEnd(' '))
    }

    companion object {
        private const val DC_OFFSET_FILTER = 0.010; private const val PHASE_LOCKED_RATE = 0.045; private const val PHASE_UNLOCKED_RATE = 0.050
        private const val LOCK_LEN = 24; private const val IDLE_THRESHOLD = 0; private const val DEMOD_TIMEOUT = 100
        private const val FLEX_SYNC_MARKER = -0x59395556   // 0xA6C6AAAA
        private const val SLICE_THRESHOLD = 0.667
        private const val FLEX_BCD = "0123456789.U -]["
        private const val LOCK_MASK = 0xFFFFFFFFFFFFL   // 2 * LOCK_LEN bits
        private const val LOCK_PATTERN = 0x6666666666666666L
        private val TYPE_NAMES = arrayOf("SEC", "INS", "TONE", "NUM", "SNUM", "ALN", "HEX", "NNUM", "SHORT", "BIW")
        private val ADDR_NAMES = arrayOf("", "long", "temp", "oper", "net", "info", "rsvd", "unk")
        private val MODES = arrayOf(intArrayOf(0x870C, 1600, 2), intArrayOf(0xB068, 1600, 4), intArrayOf(0x7B18, 3200, 2), intArrayOf(0xDEA0, 3200, 4), intArrayOf(0x4C7C, 3200, 4))
        private const val SYNC1 = 0; private const val FIW = 1; private const val SYNC2 = 2; private const val DATA = 3
        private const val PT_SECURE = 0; private const val PT_SHORT_INSTRUCTION = 1; private const val PT_TONE = 2; private const val PT_STANDARD_NUMERIC = 3
        private const val PT_SPECIAL_NUMERIC = 4; private const val PT_ALPHANUMERIC = 5; private const val PT_BINARY = 6; private const val PT_NUMBERED_NUMERIC = 7
    }
}

/** Pager RX: FLEX by default, POCSAG optionally alongside on the same discriminator stream (what PDW does on a PC). */
class PagerDecoder(log: PacketLog) : IqProcessor {
    enum class Which(val label: String) { FLEX("FLEX"), POCSAG("POCSAG"), BOTH("FLEX + POCSAG") }
    val pocsag = PocsagDecoder(log)
    val flex = FlexDecoder(log)
    private val _which = MutableStateFlow(Which.FLEX)
    val which: StateFlow<Which> = _which.asStateFlow()
    fun select(w: Which) { _which.value = w }
    override val wantsFm: Boolean get() = true
    override fun reset(rate: Int) { pocsag.reset(rate); flex.reset(rate) }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}
    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        val w = _which.value
        if (w != Which.POCSAG) flex.onFm(samples, n, rate)
        if (w != Which.FLEX) pocsag.onFm(samples, n, rate)
    }
}
