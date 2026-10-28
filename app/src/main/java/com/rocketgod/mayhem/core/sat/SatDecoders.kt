package com.rocketgod.mayhem.core.sat

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.HdlcFramer
import com.rocketgod.mayhem.core.ham.FmTap
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Audio conditioning for discriminator decoders: a one-pole DC block (the carrier offset) and a 4th-order
 * Butterworth low-pass (two biquads) that takes the discriminator's rising high-frequency noise out before the
 * slicer sees it. Twin of DiscFilter in web/src/dsp/core.ts.
 */
class DiscFilter(cutoffHz: Double, rate: Double, dcHz: Double = 40.0) {
    private var dcX = 0.0; private var dcY = 0.0
    private val dcA = exp(-2 * PI * dcHz / rate)
    private val b0 = DoubleArray(2); private val b1 = DoubleArray(2); private val b2 = DoubleArray(2)
    private val a1 = DoubleArray(2); private val a2 = DoubleArray(2); private val z1 = DoubleArray(2); private val z2 = DoubleArray(2)

    init {
        for ((k, q) in doubleArrayOf(0.5412, 1.3066).withIndex()) {
            val w0 = 2 * PI * min(0.45 * rate, cutoffHz) / rate; val alpha = sin(w0) / (2 * q); val c = cos(w0); val a0 = 1 + alpha
            b0[k] = (1 - c) / 2 / a0; b1[k] = (1 - c) / a0; b2[k] = (1 - c) / 2 / a0; a1[k] = -2 * c / a0; a2[k] = (1 - alpha) / a0
        }
    }

    fun push(x: Float): Float {
        val y = x - dcX + dcA * dcY; dcX = x.toDouble(); dcY = y
        var v = y
        for (k in 0 until 2) { val o = b0[k] * v + z1[k]; z1[k] = b1[k] * v - a1[k] * o + z2[k]; z2[k] = b2[k] * v - a2[k] * o; v = o }
        return v.toFloat()
    }
}

// ================================================================================================== ORBCOMM

/** f = 137 000 000 + N × 2500. The channels that carry traffic; the rest of the plan is unused or gateway. */
val ORBCOMM_CHANNELS = longArrayOf(137_200_000, 137_225_000, 137_250_000, 137_287_500, 137_312_500, 137_440_000,
    137_460_000, 137_662_500, 137_687_500, 137_712_500, 137_737_500, 137_800_000)

/** What one ORBCOMM satellite has told us about itself. */
data class OrbcommSat(
    val id: Int, val lat: Double? = null, val lon: Double? = null, val altKm: Double? = null, val speedKms: Double? = null,
    val utc: Long? = null, val channelHz: Long = 0, val frames: Int = 0, val firstMs: Long = 0, val lastMs: Long = 0,
)

private const val ORB_BAUD = 4800.0
/** The 24-bit frame sync in arrival order (reversed within each byte it reads 65 A8 F9). */
private const val ASM = 0xa6159f
private const val ASM_INV = ASM xor 0xffffff
private const val FRAME_BITS = 4800
private const val FRAME_BYTES = FRAME_BITS / 8
private val REV = IntArray(256) { i -> var v = 0; for (b in 0 until 8) if ((i and (1 shl b)) != 0) v = v or (1 shl (7 - b)); v }
private const val MAX_R = 8_378_155.0
private const val MAX_V = 7700.0
private const val SPAN20 = 1_048_576.0
private val GPS_EPOCH = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply { clear(); set(1980, 0, 6) }.timeInMillis

/**
 * ORBCOMM subscriber downlink, 137.2–137.8 MHz. Twin of web/src/dsp/orbcomm.ts.
 *
 * The messages are encrypted, so this decodes everything around them — and the useful part is the satellite's
 * own position and velocity, broadcast every four seconds, so a satellite goes on the map from its own
 * transmission. SDPSK at 4800 symbols/s is the same thing as MSK at that rate, so an FM discriminator recovers it.
 * From the ORBCOMM System Overview A80TD0008 and Serial Interface Specification E80050015, checked against Frank
 * Bieberly's decoder and SatDump.
 */
class OrbcommDecoder : FmTap {
    override val minHalf = 9000.0
    @Volatile var channelHz = 0L
    private var fmRate = 0.0
    private var sync = BitSync(ORB_BAUD, 48_000.0)
    private var filt = DiscFilter(3600.0, 48_000.0)
    private var shift = 0
    private var inFrame = false
    private var inverted = false
    private var bitN = 0
    private val frame = IntArray(FRAME_BYTES)
    private var byteAcc = 0
    private val sats = LinkedHashMap<Int, OrbcommSat>()
    @Volatile var frames = 0; private set
    @Volatile var packets = 0; private set
    @Volatile var badPackets = 0; private set
    @Volatile var syncs = 0; private set
    private var lastReport = 0L
    private var lastId = -1
    /** Everything heard so far, published at most twice a second. */
    var onReport: (List<OrbcommSat>) -> Unit = {}

    fun reset() { fmRate = 0.0; shift = 0; inFrame = false; bitN = 0; lastId = -1; frames = 0; packets = 0; badPackets = 0; syncs = 0; sats.clear() }

    override fun onFm(samples: FloatArray, n: Int, rate: Double) {
        if (rate != fmRate) {
            fmRate = rate; sync = BitSync(ORB_BAUD, rate); filt = DiscFilter(3600.0, rate)
            shift = 0; inFrame = false; bitN = 0
        }
        for (i in 0 until n) { val b = sync.push(filt.push(samples[i])); if (b >= 0) pushBit(b) }
    }

    private fun pushBit(bit: Int) {
        if (inFrame) {
            byteAcc = (byteAcc shl 1) or (if (inverted) bit xor 1 else bit)
            if ((++bitN and 7) == 0) frame[(bitN shr 3) - 1] = REV[byteAcc and 0xff]
            if (bitN >= FRAME_BITS) { inFrame = false; onFrame() }
            return
        }
        shift = ((shift shl 1) or bit) and 0xffffff
        if (shift == ASM || shift == ASM_INV) {
            inverted = shift == ASM_INV
            syncs++
            inFrame = true; byteAcc = 0
            // the sync word is the first three bytes of the frame: plant it rather than skipping over it
            frame[0] = REV[(ASM shr 16) and 0xff]; frame[1] = REV[(ASM shr 8) and 0xff]; frame[2] = REV[ASM and 0xff]
            bitN = 24
        }
    }

    /** Fletcher-16 taken modulo 256: over the whole packet including its check bytes both sums come out zero. */
    private fun fletcherOk(at: Int, len: Int): Boolean {
        var s1 = 0; var s2 = 0
        for (i in 0 until len) { s1 = (s1 + frame[at + i]) and 0xff; s2 = (s2 + s1) and 0xff }
        return s1 == 0 && s2 == 0
    }

    /** One wrong bit is common and cheap to undo: ninety-six flips, and the check either comes right or not. */
    private fun fixOneBit(at: Int, len: Int): Boolean {
        for (i in 0 until len) for (b in 0 until 8) {
            frame[at + i] = frame[at + i] xor (1 shl b)
            if (fletcherOk(at, len)) return true
            frame[at + i] = frame[at + i] xor (1 shl b)
        }
        return false
    }

    /** One second of traffic: fifty packets back to back. */
    private fun onFrame() {
        frames++
        report(false)
        var at = 0
        while (at + 12 <= FRAME_BYTES) {
            val type = frame[at]
            val len = if (type == 0x1f && at + 24 <= FRAME_BYTES) 24 else 12
            packets++
            if (!fletcherOk(at, len) && !fixOneBit(at, len)) { badPackets++; at += len; continue }
            onPacket(type, at, len)
            at += len
        }
    }

    private fun sat(id: Int): OrbcommSat {
        val now = System.currentTimeMillis()
        val s = (sats[id] ?: OrbcommSat(id, firstMs = now)).copy(lastMs = now, channelHz = channelHz)
        sats[id] = s
        return s
    }

    private fun hex(at: Int, len: Int): String { val sb = StringBuilder(); for (i in 0 until len) sb.append("%02X".format(frame[at + i])); return sb.toString() }

    /** A 20-bit offset-binary field, nibble-packed and byte-swapped: done on the hex text exactly as the spec describes. */
    private fun field20(p: String, a: Int, b: Int): Int {
        val f = p.substring(a, b).reversed()
        return f.substring(0, 2).reversed().toInt(16) + 256 * f.substring(2, 4).reversed().toInt(16) + 65536 * f.substring(4, 5).toInt(16)
    }

    private fun scale(t: Int, max: Double) = (2 * t * max) / SPAN20 - max

    private fun onPacket(type: Int, at: Int, len: Int) {
        if (type == 0x65) { lastId = frame[at + 3]; val s = sat(lastId); sats[lastId] = s.copy(frames = s.frames + 1); return }
        if (type != 0x1f) { if (type == 0x1a) Diag.log("ORBCOMM message packet, payload encrypted: ${hex(at + 2, 8)}"); return }
        // ephemeris: the satellite's own clock, then velocity and position in Earth-centered coordinates
        val p = hex(at + 2, len - 2)
        val week = p.substring(0, 4).toInt(16); val tow = p.substring(4, 10).toInt(16)
        val vz = scale(field20(p, 10, 15), MAX_V); val vy = scale(field20(p, 15, 20), MAX_V); val vx = scale(field20(p, 20, 25), MAX_V)
        val z = scale(field20(p, 25, 30), MAX_R); val y = scale(field20(p, 30, 35), MAX_R); val x = scale(field20(p, 35, 40), MAX_R)
        // WGS-84 by Bowring's method
        val a = 6_378_137.0; val f = 1 / 298.257223563; val b = a * (1 - f)
        val e2 = f * (2 - f); val ep2 = (a * a - b * b) / (b * b)
        val pp = hypot(x, y); val th = atan2(a * z, b * pp)
        val lat = atan2(z + ep2 * b * sin(th).pow(3), pp - e2 * a * cos(th).pow(3))
        val nn = a / sqrt(1 - e2 * sin(lat).pow(2))
        val latD = lat * 180 / PI; val lonD = atan2(y, x) * 180 / PI; val altKm = (pp / cos(lat) - nn) / 1000
        if (latD.isNaN() || kotlin.math.abs(latD) > 90 || altKm < 400 || altKm > 1400) return
        val id = if (frame[at + 1] != 0) frame[at + 1] else lastId
        if (id < 0) return
        val s = sat(id)
        sats[id] = s.copy(lat = latD, lon = lonD, altKm = altKm, speedKms = sqrt(vx * vx + vy * vy + vz * vz) / 1000,
            utc = GPS_EPOCH + week * 604_800_000L + tow * 1000L)
        report(true)
    }

    private fun report(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - lastReport < 500) return
        lastReport = now
        onReport(sats.values.toList())
    }
}

// ================================================================================================== G3RUH

/** One packet heard, decoded as far as the addresses go. */
data class PacketFrame(val at: Long, val from: String, val to: String, val via: List<String>, val payload: ByteArray, val text: String, val hex: String)

/** AX.25 address: six characters shifted up one bit, then the SSID. */
private fun callsign(f: ByteArray, at: Int): String {
    val sb = StringBuilder()
    for (i in 0 until 6) { val c = (f[at + i].toInt() and 0xff) shr 1; if (c != 0x20) sb.append(c.toChar()) }
    val ssid = ((f[at + 6].toInt() and 0xff) shr 1) and 0x0f
    return if (ssid != 0) "$sb-$ssid" else sb.toString()
}

/** Printable if it is mostly text; cubesat telemetry usually is not, and saying so is better than mojibake. */
private fun asText(b: ByteArray): String {
    if (b.isEmpty()) return ""
    var printable = 0; val sb = StringBuilder()
    for (x in b) { val c = x.toInt() and 0xff; if (c == 9 || c == 10 || c == 13 || c in 32..126) { printable++; sb.append(c.toChar()) } else sb.append('.') }
    return if (printable.toDouble() / b.size > 0.85) sb.toString() else ""
}

/**
 * 9600 baud G3RUH packet, the way most cubesats send their telemetry: direct FSK through an ordinary FM receiver,
 * NRZI, James Miller's x^17 + x^12 + 1 scrambler, then plain AX.25. The order — NRZI, then descramble, then the
 * framer — is taken from gr-satellites. Twin of web/src/dsp/g3ruh.ts.
 */
class G3ruhDecoder : FmTap {
    override val minHalf = 10_000.0
    private var fmRate = 0.0
    @Volatile var baud = 9600.0
    private var sync = BitSync(9600.0, 48_000.0)
    private var filt = DiscFilter(7200.0, 48_000.0)
    private var reg = 0
    private var last = 0
    private val framer = HdlcFramer(512) { onFrame(it) }
    private val frames = ArrayList<PacketFrame>()
    @Volatile var heard = 0; private set
    @Volatile var bad = 0; private set
    var onFrames: (List<PacketFrame>) -> Unit = {}

    fun reset() { fmRate = 0.0; framer.reset(); reg = 0; last = 0; heard = 0; bad = 0; frames.clear() }
    fun clear() { heard = 0; bad = 0; frames.clear(); onFrames(emptyList()) }

    /** Self-synchronizing: the output is the tapped register's parity xor the input, and the input is fed back. */
    private fun descramble(bit: Int): Int {
        val out = (Integer.bitCount(reg and 0x21) and 1) xor (bit and 1)
        reg = (reg ushr 1) or ((bit and 1) shl 16)
        return out
    }

    override fun onFm(samples: FloatArray, n: Int, rate: Double) {
        if (rate != fmRate) {
            fmRate = rate; sync = BitSync(baud, rate); filt = DiscFilter(min(0.45 * rate, baud * 0.75), rate)
            framer.reset(); reg = 0
        }
        for (i in 0 until n) {
            val b = sync.push(filt.push(samples[i]))
            if (b < 0) continue
            val nrzi = if (b == last) 1 else 0                 // a one is no transition, exactly as in APRS
            last = b
            framer.pushDecoded(descramble(nrzi))
        }
    }

    private fun onFrame(f: ByteArray) {
        if (f.size < 16 || !HdlcFramer.fcsOk(f)) { bad++; return }
        val to = callsign(f, 0); val from = callsign(f, 7)
        val via = ArrayList<String>()
        var at = 14
        if ((f[13].toInt() and 1) == 0) {
            while (at + 7 <= f.size && via.size < 8) { via.add(callsign(f, at)); val end = f[at + 6].toInt() and 1; at += 7; if (end != 0) break }
        }
        at += 2                                              // control and protocol identifier
        if (at >= f.size - 2) return
        val payload = f.copyOfRange(at, f.size - 2)
        heard++
        frames.add(0, PacketFrame(System.currentTimeMillis(), from, to, via, payload, asText(payload),
            payload.take(64).joinToString(" ") { "%02x".format(it.toInt() and 0xff) }))
        if (frames.size > 100) frames.removeAt(frames.size - 1)
        onFrames(frames.take(40))
    }
}

// ================================================================================================== Geoscan

/** The Geoscan birds launched together in July 2025 that are alive, with their downlinks. */
val GEOSCAN_SATS: List<Triple<Int, Long, String>> = listOf(
    Triple(64880, 435_970_000L, "Geoscan-1"), Triple(64890, 436_040_000L, "Geoscan-2"), Triple(64893, 436_110_000L, "Geoscan-3"),
    Triple(64892, 436_180_000L, "Geoscan-4"), Triple(64891, 436_250_000L, "Geoscan-5"), Triple(64879, 436_320_000L, "Geoscan-6"),
)

private const val GEO_SYNC = 0x930b51de.toInt()
private const val GEO_FRAME = 74
private const val CMD_START = 0x0901
private const val CMD_FRAME = 0x0905

/**
 * Geoscan: photographs of the Earth as ordinary 9600 baud FSK. A TI transceiver's framing: 32-bit sync, fixed
 * length, the chip's PN9 scrambler and checksum; the picture arrives as JPEG fragments each carrying the offset it
 * belongs at. The header inside a frame is found by its own shape (marker, a length that fits, one of the two
 * message types) after the frame has passed its checksum. Twin of web/src/dsp/geoscan.ts (constants from
 * gr-satellites and GNU Radio).
 */
class GeoscanDecoder : FmTap {
    override val minHalf = 10_000.0
    private var fmRate = 0.0
    private var sync = BitSync(9600.0, 48_000.0)
    private var filt = DiscFilter(7200.0, 48_000.0)
    private var shift = 0
    private var inFrame = false
    private var bitN = 0
    private var acc = 0
    private val frame = IntArray(GEO_FRAME)
    private var base = -1
    @Volatile var frames = 0; private set
    @Volatile var bad = 0; private set
    @Volatile var fragments = 0; private set
    @Volatile var high = 0; private set
    @Volatile var complete = false; private set
    private var image: ByteArray? = null
    private var sentAt = 0L; private var sentHigh = 0
    /** The picture so far as JPEG bytes, when it has grown enough to be worth redrawing. */
    var onJpeg: (ByteArray) -> Unit = {}
    var onStats: () -> Unit = {}

    fun reset() {
        fmRate = 0.0; shift = 0; inFrame = false; bitN = 0
        frames = 0; bad = 0; fragments = 0; high = 0; complete = false; image = null; base = -1; sentAt = 0; sentHigh = 0
    }

    override fun onFm(samples: FloatArray, n: Int, rate: Double) {
        if (rate != fmRate) {
            fmRate = rate; sync = BitSync(9600.0, rate); filt = DiscFilter(min(0.45 * rate, 7200.0), rate)
            shift = 0; inFrame = false; bitN = 0
        }
        for (i in 0 until n) {
            val b = sync.push(filt.push(samples[i]))
            if (b < 0) continue
            if (inFrame) {
                acc = ((acc shl 1) or b) and 0xff
                if ((++bitN and 7) == 0) frame[(bitN shr 3) - 1] = acc
                if (bitN >= GEO_FRAME * 8) { inFrame = false; onFrame() }
                continue
            }
            shift = (shift shl 1) or b
            // four wrong bits in the sync word are tolerated, the reference decoder's allowance
            if (Integer.bitCount(shift xor GEO_SYNC) <= 4) { inFrame = true; bitN = 0; acc = 0 }
        }
    }

    private fun onFrame() {
        val f = frame
        // the transceiver's PN9 scrambler, x^9 + x^5 + 1, reset per packet, a byte at a time LSB first
        var reg = 0x1ff
        for (i in 0 until GEO_FRAME) {
            var sb = 0
            for (k in 0 until 8) { sb = sb or ((reg and 1) shl k); val p = Integer.bitCount(reg and 0x21) and 1; reg = (reg ushr 1) or (p shl 8) }
            f[i] = f[i] xor sb
        }
        var crc = 0xffff
        for (i in 0 until GEO_FRAME - 2) { crc = crc xor (f[i] shl 8); repeat(8) { crc = if ((crc and 0x8000) != 0) ((crc shl 1) xor 0x8005) and 0xffff else (crc shl 1) and 0xffff } }
        if (crc != ((f[GEO_FRAME - 2] shl 8) or f[GEO_FRAME - 1])) { bad++; onStats(); return }
        frames++
        picture(f)
        val now = System.currentTimeMillis()
        if (image != null && high > sentHigh + 512 && (now - sentAt > 2000 || complete)) {
            sentAt = now; sentHigh = high
            if (high > 2) onJpeg(image!!.copyOf(high))
        }
        onStats()
    }

    private fun start() { image = ByteArray(256 * 1024); high = 0; complete = false; fragments = 0 }

    private fun picture(f: IntArray) {
        var at = 0
        while (at + 8 <= GEO_FRAME - 2) {
            if (f[at] != 0x01 || f[at + 1] != 0x00) { at++; continue }
            val dlen = f[at + 2]; val mtype = f[at + 3] or (f[at + 4] shl 8); val off = f[at + 5] or (f[at + 6] shl 8)
            if (dlen < 7 || dlen > 70 || at + 2 + dlen > GEO_FRAME - 2) { at++; continue }
            if (mtype != CMD_START && mtype != CMD_FRAME) { at++; continue }
            val dataStart = at + 8; val dataEnd = at + 2 + dlen
            if (dataEnd <= dataStart) { at++; continue }
            val soi = f[dataStart] == 0xff && dataStart + 1 < dataEnd && f[dataStart + 1] == 0xd8
            if (mtype == CMD_START || (soi && base < 0)) { base = off; if (image == null || complete) start() }
            if (image == null) start()
            var put = off - base
            if (put < 0) { start(); base = off; put = 0 }
            val img = image!!
            val len = dataEnd - dataStart
            if (put + len > img.size) return
            for (k in 0 until len) img[put + k] = f[dataStart + k].toByte()
            high = maxOf(high, put + len)
            fragments++
            for (k in 0 until len - 1) if (f[dataStart + k] == 0xff && f[dataStart + k + 1] == 0xd9) complete = true
            return
        }
    }
}
