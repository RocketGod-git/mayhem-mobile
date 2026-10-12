package com.rocketgod.mayhem.core

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.model.Aircraft
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Pure-Kotlin ADS-B (Mode S) decoder for RAW IQ at 2.0 Msps / 1090 MHz — the Kotlin counterpart of Mayhem's
 * proc_adsbrx. Ported from antirez's dump1090 (via Wardrive Go): magnitude lookup → preamble correlation →
 * Manchester bit extraction → CRC-24 → DF17/18 field decode (ICAO, callsign, altitude, airborne CPR position,
 * velocity). Decoded aircraft are pushed into [AdsbStore].
 *
 * [process] is fed one IQ buffer at a time by [SdrEngine] when in ADS-B mode; it carries the trailing samples
 * across buffers so a message straddling a buffer boundary still decodes. [refProvider] (the phone's GPS fix)
 * enables single-frame local CPR decode so a plane maps from ONE position frame instead of an even+odd pair.
 */
object AdsbDecoder : IqProcessor {
    override fun reset(rate: Int) { reset() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) { process(iq, len) }

    private const val PREAMBLE = 8
    private const val LONG_BITS = 112
    private const val SHORT_BITS = 56
    private const val FULL_LEN = PREAMBLE + LONG_BITS          // 120 "us" (samples at 2 Msps = 2/us → *2)

    private val maglut = IntArray(129 * 129)
    @Volatile private var lutReady = false
    private fun ensureLut() {
        if (lutReady) return
        for (i in 0..128) for (q in 0..128) maglut[i * 129 + q] = Math.round(sqrt((i * i + q * q).toDouble()) * 360.0).toInt()
        lutReady = true
    }

    private val carry = IntArray(FULL_LEN * 2 + 8)
    private var carryLen = 0

    private class Cpr { var evLat = 0; var evLon = 0; var odLat = 0; var odLon = 0; var evT = 0L; var odT = 0L; var haveEv = false; var haveOd = false }
    private val cprState = ConcurrentHashMap<String, Cpr>()

    // De-noise: a lone frame that passes the 24-bit CRC can be a ~2^-24 noise false-positive — on a dead/all-zero
    // front-end (e.g. a PortaPack HackRF that never handed the radio to the host) one occasionally slips through and
    // shows as a phantom aircraft (a bare ICAO, no callsign/position, that never gets a second frame). Real aircraft
    // emit several frames/sec, so we require MIN_CONFIRM frames for an ICAO before it's surfaced — a phantom
    // essentially never repeats the same random ICAO. Per-ICAO count; cleared in [reset]; size-capped as a backstop.
    private val icaoFrames = ConcurrentHashMap<String, Int>()
    private const val MIN_CONFIRM = 2
    // Decode-health diagnostic (logged once/sec): where does the chain break on a given source? preambles = quiet-
    // zone-validated preamble candidates; df = those decoding to a clean-bits DF17/18; crcOK/crcFail = of those,
    // how many passed the 24-bit CRC. preambles=0 → no Mode-S pulses in the IQ (antenna/gain/no traffic); many
    // preambles but crcOK=0 → signal present but mangled (over-gain/overload/format). Reset each interval.
    private var dbgPre = 0; private var dbgDf = 0; private var dbgCrcOk = 0; private var dbgCrcFail = 0
    private var dbgLast = 0L
    /** Phone GPS position (lat,lon) provider for LOCAL single-frame CPR decode. Set by the app once it has a GPS fix. When present, a plane can be placed from ONE position frame (dump1090
     *  decodeCPRrelative), instead of waiting for a matched even+odd pair — so aircraft map almost immediately. */
    @Volatile var refProvider: (() -> Pair<Double, Double>?)? = null

    fun reset() { carryLen = 0; cprState.clear(); icaoFrames.clear() }

    /** Decode one IQ buffer (uint8 I,Q interleaved). Emits any decoded aircraft into [AdsbStore]. */
    fun process(iq: ByteArray, len: Int) {
        ensureLut()
        val nSamp = len / 2
        if (nSamp < 8) return
        val m = IntArray(carryLen + nSamp)
        for (i in 0 until carryLen) m[i] = carry[i]
        for (i in 0 until nSamp) {
            var iv = (iq[2 * i].toInt() and 0xff) - 127; if (iv < 0) iv = -iv
            var qv = (iq[2 * i + 1].toInt() and 0xff) - 127; if (qv < 0) qv = -qv
            if (iv > 128) iv = 128; if (qv > 128) qv = 128
            m[carryLen + i] = maglut[iv * 129 + qv]
        }
        val mlen = m.size
        val batch = HashMap<String, Aircraft>()
        val nowTs = nowTs14()
        val nowMs = System.currentTimeMillis()
        val msg = IntArray(14)
        val bits = IntArray(LONG_BITS)

        var j = 0
        val limit = mlen - FULL_LEN * 2
        while (j < limit) {
            // --- preamble impulse test (samples 0,2,7,9 high) ---
            if (!(m[j] > m[j + 1] && m[j + 1] < m[j + 2] && m[j + 2] > m[j + 3] && m[j + 3] < m[j] &&
                    m[j + 4] < m[j] && m[j + 5] < m[j] && m[j + 6] < m[j] &&
                    m[j + 7] > m[j + 8] && m[j + 8] < m[j + 9] && m[j + 9] > m[j + 6])) { j++; continue }
            val high = (m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 6
            if (m[j + 4] >= high || m[j + 5] >= high) { j++; continue }
            if (m[j + 11] >= high || m[j + 12] >= high || m[j + 13] >= high || m[j + 14] >= high) { j++; continue }
            dbgPre++   // preamble + quiet-zone validated — a real Mode-S candidate

            // --- Manchester bit extraction (2 samples/bit, 112 bits) ---
            var errors = 0
            var i = 0
            while (i < LONG_BITS * 2) {
                val low = m[j + i + PREAMBLE * 2]
                val hi = m[j + i + PREAMBLE * 2 + 1]
                val delta = abs(low - hi)
                val b = when {
                    i > 0 && delta < 256 -> bits[i / 2 - 1]
                    low == hi -> { if (i < SHORT_BITS * 2) errors++; 2 }
                    low > hi -> 1
                    else -> 0
                }
                bits[i / 2] = b
                i += 2
            }
            // pack 8 bits/byte MSB first
            var k = 0
            while (k < LONG_BITS) {
                msg[k / 8] = (bits[k] shl 7) or (bits[k + 1] shl 6) or (bits[k + 2] shl 5) or (bits[k + 3] shl 4) or
                    (bits[k + 4] shl 3) or (bits[k + 5] shl 2) or (bits[k + 6] shl 1) or bits[k + 7]
                k += 8
            }
            val df = msg[0] shr 3
            if (errors > 0 || (df != 17 && df != 18)) { j++; continue }   // only ADS-B (DF17/18), clean bits
            dbgDf++
            val msgBits = LONG_BITS                                        // DF17/18 are always 112-bit
            if (checksum(msg, msgBits) != 0L) { dbgCrcFail++; j++; continue }   // CRC must be clean (ICAO in the clear)
            dbgCrcOk++

            AdsbStore.noteFrame()                                          // valid Mode-S frame — proof of ingestion
            decodeAdsb(msg, batch, nowTs)
            j += (msgBits + PREAMBLE) * 2                                  // skip past this message
        }

        // carry the trailing samples so a boundary-straddling message decodes next buffer
        val keep = min(FULL_LEN * 2, mlen)
        for (x in 0 until keep) carry[x] = m[mlen - keep + x]
        carryLen = keep

        if (batch.isNotEmpty()) AdsbStore.merge(batch, nowMs)

        // Once/sec decode-health line — the missing piece for "strong RX but no aircraft": it says whether the
        // decoder finds Mode-S preambles at all, and if they survive bit-decode + CRC.
        if (nowMs - dbgLast > 1000L) {
            dbgLast = nowMs
            Diag.log(
                "ADSB decode: preambles=$dbgPre df17/18=$dbgDf crcOK=$dbgCrcOk crcFAIL=$dbgCrcFail · frames=${AdsbStore.frames.value} aircraft=${AdsbStore.flow.value.size}")
            dbgPre = 0; dbgDf = 0; dbgCrcOk = 0; dbgCrcFail = 0
        }
    }

    // ---- DF17/18 field decode --------------------------------------------------------------------------------
    private val AIS = "?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????"

    private fun decodeAdsb(msg: IntArray, batch: HashMap<String, Aircraft>, nowTs: Long) {
        val icao = "%02x%02x%02x".format(msg[1], msg[2], msg[3])
        // Confirmation gate: don't surface an ICAO until we've heard it at least MIN_CONFIRM times, so a lone
        // CRC-passing noise frame can't create a phantom aircraft. (Backstop: clear the counter if it ever grows
        // past a busy-airspace worth of ICAOs so a long session can't leak memory here.)
        val seen = (icaoFrames[icao] ?: 0) + 1
        if (icaoFrames.size > 4096) icaoFrames.clear()
        icaoFrames[icao] = seen
        if (seen < MIN_CONFIRM) return
        val a = batch.getOrPut(icao) { Aircraft(icao) }
        a.lastTs = nowTs
        val tc = msg[4] shr 3
        when (tc) {
            in 1..4 -> {   // callsign
                val sb = StringBuilder(8)
                sb.append(AIS[msg[5] shr 2])
                sb.append(AIS[((msg[5] and 3) shl 4) or (msg[6] shr 4)])
                sb.append(AIS[((msg[6] and 15) shl 2) or (msg[7] shr 6)])
                sb.append(AIS[msg[7] and 63])
                sb.append(AIS[msg[8] shr 2])
                sb.append(AIS[((msg[8] and 3) shl 4) or (msg[9] shr 4)])
                sb.append(AIS[((msg[9] and 15) shl 2) or (msg[10] shr 6)])
                sb.append(AIS[msg[10] and 63])
                val cs = sb.toString().trim().trimEnd('?').replace("?", "")
                if (cs.isNotEmpty()) a.flight = cs
            }
            in 9..18, in 20..22 -> {   // airborne position (CPR)
                val alt = decodeAc12(msg); if (alt != null) a.altBaro = alt
                val odd = (msg[6] and (1 shl 2)) != 0
                val rawLat = ((msg[6] and 3) shl 15) or (msg[7] shl 7) or (msg[8] shr 1)
                val rawLon = ((msg[8] and 1) shl 16) or (msg[9] shl 8) or msg[10]
                val pos = cprUpdate(icao, odd, rawLat, rawLon)
                if (pos != null) { a.lat = pos.first; a.lon = pos.second }
            }
            19 -> {   // velocity
                val sub = msg[4] and 7
                if (sub == 1 || sub == 2) {
                    val ewDir = (msg[5] and 4) shr 2
                    val ewV = ((msg[5] and 3) shl 8) or msg[6]
                    val nsDir = (msg[7] and 0x80) shr 7
                    val nsV = ((msg[7] and 0x7f) shl 3) or ((msg[8] and 0xe0) shr 5)
                    val vrSign = (msg[8] and 0x8) shr 3
                    val vr = (((msg[8] and 7) shl 6) or ((msg[9] and 0xfc) shr 2))
                    if (ewV != 0 && nsV != 0) {
                        val ew = (ewV - 1) * (if (ewDir == 1) -1 else 1)
                        val ns = (nsV - 1) * (if (nsDir == 1) -1 else 1)
                        a.gs = Math.round(sqrt((ew * ew + ns * ns).toDouble())).toInt()
                        var hdg = Math.toDegrees(Math.atan2(ew.toDouble(), ns.toDouble())); if (hdg < 0) hdg += 360.0
                        a.track = hdg.toInt()
                    }
                    if (vr != 0) a.vertRate = (vr - 1) * 64 * (if (vrSign == 1) -1 else 1)
                }
            }
        }
    }

    /** ADS-B 12-bit altitude (Q-bit path) → feet, or null. */
    private fun decodeAc12(msg: IntArray): Int? {
        val q = msg[5] and 1
        if (q == 0) return null
        val n = ((msg[5] shr 1) shl 4) or ((msg[6] and 0xf0) shr 4)
        return n * 25 - 1000
    }

    // ---- CPR global (even/odd) position decode --------------------------------------------------------------
    private fun cprUpdate(icao: String, odd: Boolean, rawLat: Int, rawLon: Int): Pair<Double, Double>? {
        val st = cprState.getOrPut(icao) { Cpr() }
        val now = System.currentTimeMillis()
        if (odd) { st.odLat = rawLat; st.odLon = rawLon; st.odT = now; st.haveOd = true }
        else { st.evLat = rawLat; st.evLon = rawLon; st.evT = now; st.haveEv = true }
        // FAST PATH — local single-frame decode referenced to the phone's GPS: one position frame is enough, so a
        // plane maps immediately instead of waiting to catch a matched even+odd pair (the "N aircraft, 0 on map"
        // case on sparse reception). Only used when a fix is available and the result lands near us (in range).
        refProvider?.invoke()?.let { (rLat, rLon) ->
            cprLocal(rLat, rLon, odd, rawLat, rawLon)?.let { return it }
        }
        // FALLBACK — global even/odd pairing (no GPS fix, or the local result was out of plausible range).
        if (!st.haveEv || !st.haveOd) return null
        if (abs(st.evT - st.odT) > 10_000L) return null       // frames too far apart to pair
        return cprGlobal(st)
    }

    /** Positive floating-point modulo (dump1090 cprModDouble). */
    private fun cprModD(a: Double, b: Double): Double { val r = a % b; return if (r < 0) r + b else r }

    /** Local CPR decode (dump1090 decodeCPRrelative): place a plane from a SINGLE position frame using [refLat],
     *  [refLon] (the receiver's own position) as the reference. Unambiguous within ~180 NM of the reference; we
     *  reject a result that lands implausibly far (a wrong CPR cell) so a bad fix can't fling a plane worldwide. */
    private fun cprLocal(refLat: Double, refLon: Double, odd: Boolean, rawLat: Int, rawLon: Int): Pair<Double, Double>? {
        if (refLat.isNaN() || refLon.isNaN()) return null
        val airDlat = if (odd) 360.0 / 59.0 else 360.0 / 60.0
        val latFrac = rawLat / 131072.0
        val lonFrac = rawLon / 131072.0
        val j = floor(refLat / airDlat) + floor(0.5 + cprModD(refLat, airDlat) / airDlat - latFrac)
        var rlat = airDlat * (j + latFrac)
        if (rlat >= 270) rlat -= 360.0
        if (rlat < -90 || rlat > 90) return null
        val oddI = if (odd) 1 else 0
        val airDlon = cprDlon(rlat, oddI)
        val m = floor(refLon / airDlon) + floor(0.5 + cprModD(refLon, airDlon) / airDlon - lonFrac)
        var rlon = airDlon * (m + lonFrac)
        if (rlon > 180) rlon -= 360.0
        if (abs(rlon) > 180) return null
        // ~180 NM guard (≈3° lat; widen lon for high latitudes) — outside this the local cell is ambiguous.
        if (abs(rlat - refLat) > 3.0 || abs(rlon - refLon) > 5.0) return null
        return rlat to rlon
    }

    private fun cprMod(a: Int, b: Int): Int { var r = a % b; if (r < 0) r += b; return r }
    private fun cprNL(latIn: Double): Int {
        val lat = abs(latIn)
        if (lat < 10.47047130) return 59
        // exact dump1090 breakpoints
        val bp = doubleArrayOf(
            14.82817437, 18.18626357, 21.02939493, 23.54504487, 25.82924707, 27.93898710, 29.91135686,
            31.77209708, 33.53993436, 35.22899598, 36.85025108, 38.41241892, 39.92256684, 41.38651832,
            42.80914012, 44.19454951, 45.54626723, 46.86733252, 48.16039128, 49.42776439, 50.67150166,
            51.89342469, 53.09516153, 54.27817472, 55.44378444, 56.59318756, 57.72747354, 58.84763776,
            59.95459277, 61.04917774, 62.13216659, 63.20427479, 64.26616523, 65.31845310, 66.36171008,
            67.39646774, 68.42322022, 69.44242631, 70.45451075, 71.45986473, 72.45884545, 73.45177442,
            74.43893416, 75.42056257, 76.39684391, 77.36789461, 78.33374083, 79.29428225, 80.24923213,
            81.19801349, 82.13956981, 83.07199445, 83.99173563, 84.89166191, 85.75541621, 86.53536998,
            87.00000000
        )
        for (i in bp.indices) if (lat < bp[i]) return 58 - i
        return 1
    }
    private fun cprN(lat: Double, odd: Int): Int { val nl = cprNL(lat) - odd; return if (nl < 1) 1 else nl }
    private fun cprDlon(lat: Double, odd: Int): Double = 360.0 / cprN(lat, odd)

    private fun cprGlobal(st: Cpr): Pair<Double, Double>? {
        val airDlat0 = 360.0 / 60.0
        val airDlat1 = 360.0 / 59.0
        val lat0 = st.evLat.toDouble(); val lat1 = st.odLat.toDouble()
        val lon0 = st.evLon.toDouble(); val lon1 = st.odLon.toDouble()
        val j = floor(((59 * lat0 - 60 * lat1) / 131072.0) + 0.5)
        var rlat0 = airDlat0 * (cprMod(j.toInt(), 60) + lat0 / 131072.0)
        var rlat1 = airDlat1 * (cprMod(j.toInt(), 59) + lat1 / 131072.0)
        if (rlat0 >= 270) rlat0 -= 360.0
        if (rlat1 >= 270) rlat1 -= 360.0
        if (rlat0 < -90 || rlat0 > 90 || rlat1 < -90 || rlat1 > 90) return null
        if (cprNL(rlat0) != cprNL(rlat1)) return null
        val lat: Double; var lon: Double
        if (st.evT > st.odT) {
            val ni = cprN(rlat0, 0)
            val m = floor(((lon0 * (cprNL(rlat0) - 1) - lon1 * cprNL(rlat0)) / 131072.0) + 0.5)
            lon = cprDlon(rlat0, 0) * (cprMod(m.toInt(), ni) + lon0 / 131072.0)
            lat = rlat0
        } else {
            val ni = cprN(rlat1, 1)
            val m = floor(((lon0 * (cprNL(rlat1) - 1) - lon1 * cprNL(rlat1)) / 131072.0) + 0.5)
            lon = cprDlon(rlat1, 1) * (cprMod(m.toInt(), ni) + lon1 / 131072.0)
            lat = rlat1
        }
        if (lon > 180) lon -= 360.0
        if (lat < -90 || lat > 90 || abs(lon) > 180) return null
        return lat to lon
    }

    // ---- CRC-24 (Mode S) -------------------------------------------------------------------------------------
    private val CRC = longArrayOf(
        0x3935ea, 0x1c9af5, 0xf1b77e, 0x78dbbf, 0xc397db, 0x9e31e9, 0xb0e2f0, 0x587178,
        0x2c38bc, 0x161c5e, 0x0b0e2f, 0xfa7d13, 0x82c48d, 0xbe9842, 0x5f4c21, 0xd05c14,
        0x682e0a, 0x341705, 0xe5f186, 0x72f8c3, 0xc68665, 0x9cb936, 0x4e5c9b, 0xd8d449,
        0x939020, 0x49c810, 0x24e408, 0x127204, 0x093902, 0x049c81, 0xfdb444, 0x7eda22,
        0x3f6d11, 0xe04c8c, 0x702646, 0x381323, 0xe3f395, 0x8e03ce, 0x4701e7, 0xdc7af7,
        0x91c77f, 0xb719bb, 0xa476d9, 0xadc168, 0x56e0b4, 0x2b705a, 0x15b82d, 0xf52612,
        0x7a9309, 0xc2b380, 0x6159c0, 0x30ace0, 0x185670, 0x0c2b38, 0x06159c, 0x030ace,
        0x018567, 0xff38b7, 0x80665f, 0xbfc92b, 0xa01e91, 0xaff54c, 0x57faa6, 0x2bfd53,
        0xea04ad, 0x8af852, 0x457c29, 0xdd4410, 0x6ea208, 0x375104, 0x1ba882, 0x0dd441,
        0xf91024, 0x7c8812, 0x3e4409, 0xe0d800, 0x706c00, 0x383600, 0x1c1b00, 0x0e0d80,
        0x0706c0, 0x038360, 0x01c1b0, 0x00e0d8, 0x00706c, 0x003836, 0x001c1b, 0xfff409,
        0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
        0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
        0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000
    )
    /** Mode-S syndrome: 0 == valid (for DF17/18 the ICAO is in the clear, so a clean frame syndromes to 0). */
    private fun checksum(msg: IntArray, bits: Int): Long {
        var crc = 0L
        val offset = if (bits == LONG_BITS) 0 else LONG_BITS - SHORT_BITS
        for (jbit in 0 until bits - 24) {
            val bytev = msg[jbit / 8]
            if (bytev and (1 shl (7 - (jbit % 8))) != 0) crc = crc xor CRC[jbit + offset]
        }
        val rem = ((msg[bits / 8 - 3].toLong() shl 16) or (msg[bits / 8 - 2].toLong() shl 8) or msg[bits / 8 - 1].toLong())
        return (crc xor rem) and 0xFFFFFFL
    }

    private fun nowTs14(): Long {
        val fmt = java.text.SimpleDateFormat("yyyyMMddHHmmss", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date()).toLong()
    }
}
