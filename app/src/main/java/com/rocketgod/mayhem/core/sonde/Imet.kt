package com.rocketgod.mayhem.core.sonde

import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * InterMet iMet-1-RSB and iMet-4: Bell 202 AFSK (1200 baud, 1200 Hz = 1, 2200 Hz = 0) on the FM carrier, bytes as
 * 8N1 (start 0, 8 data bits least significant first, stop 1), the line idling on the mark tone. Once a second a burst
 * of packets, each [0x01 SOH, id, data, CRC16 big-endian]: PTU (0x01) or extended PTU (0x04) with the frame counter,
 * pressure, temperature, humidity and battery; GPS (0x02) or extended GPS (0x05, with velocities) with position,
 * satellites and time of day; extra data (0x03, ozone and other instruments). The CRC is CRC-16/AUG-CCITT (0x1021,
 * start 0x1D0F) from the SOH up to the CRC.
 *
 * The sonde sends no serial number. Like radiosonde_auto_rx, the ID is made from the power-on time (GPS time minus the
 * frame counter; the iMet-1 counts twice a second, the iMet-4 once, which two frames tell apart) and the frequency
 * rounded to 100 kHz: "IMET-" + the last 8 hex digits of SHA-256("YYYY-MM-DDTHH:MM:SSZ" + "402.000 MHz" + "SONDE").
 * The channel frequency comes from the receiver through [hz].
 *
 * Tone detection is a sliding one-bit DFT at the two tones on the discriminator output (a ring of one bit's
 * products), and each byte re-times itself on its start bit's falling edge. The Kotlin twin of web/src/dsp/sonde/imet.ts.
 */
object Imet {
    const val BAUD = 1200
    const val MARK = 1200
    const val SPACE = 2200
    const val PKT_PTU = 0x01
    const val PKT_GPS = 0x02
    const val PKT_XDATA = 0x03
    const val PKT_EPTU = 0x04
    const val PKT_EGPS = 0x05
    /** Packet length by id, SOH and CRC included (XDATA: 5 + N). */
    val PKT_LEN = intArrayOf(0, 14, 18, 0, 20, 30)

    /** CRC-16/AUG-CCITT over [len] bytes from [start]. */
    fun crc(b: IntArray, start: Int, len: Int): Int {
        var rem = 0x1d0f
        for (i in 0 until len) {
            rem = rem xor (b[start + i] shl 8)
            for (j in 0 until 8) rem = if (rem and 0x8000 != 0) ((rem shl 1) xor 0x1021) and 0xffff else (rem shl 1) and 0xffff
        }
        return rem
    }

    internal fun u16(b: IntArray, p: Int) = b[p] or (b[p + 1] shl 8)
    internal fun i16(b: IntArray, p: Int) = (u16(b, p) shl 16) shr 16
    internal fun f32(b: IntArray, p: Int): Double = Float.fromBits(b[p] or (b[p + 1] shl 8) or (b[p + 2] shl 16) or (b[p + 3] shl 24)).toDouble()

    /** The auto_rx date for a GPS time of day: today's UTC date, moved a day when the sonde and the clock straddle midnight. */
    fun dateTimeMs(timeS: Double, nowMs: Long): Long {
        val day = Math.floorDiv(nowMs, 86_400_000L) * 86_400_000L
        var t = day + floor(timeS).toLong() * 1000
        val nowH = (nowMs - day) / 3_600_000; val sondeH = floor(timeS / 3600).toLong()
        if (nowH == 0L && sondeH == 23L) t -= 86_400_000
        else if (nowH == 23L && sondeH == 0L) t += 86_400_000
        return t
    }

    /** "IMET-" + the last 8 hex digits of the SHA-256 of the text. */
    fun hashId(text: String): String {
        val m = ByteArray(text.length) { (text[it].code and 0x7f).toByte() }
        val h = MessageDigest.getInstance("SHA-256").digest(m)
        val s = StringBuilder("IMET-")
        for (i in 28 until 32) s.append("%02X".format(h[i].toInt() and 0xff))
        return s.toString()
    }

    /** The frequency part of the ID: MHz rounded to 100 kHz, three decimals ("" when the channel frequency is unknown). */
    fun freqText(hz: Long): String = if (hz > 0) "%.3f MHz".format(Locale.US, Math.round(hz / 1e5) / 10.0) else ""

    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss", Locale.US).withZone(ZoneOffset.UTC)
    internal fun isoSeconds(ms: Long): String = ISO.format(Instant.ofEpochMilli(ms)) + "Z"

    /** auto_rx's iMet ID from the power-on time (ms since 1970) and the channel frequency. */
    fun uniqueId(powerOnMs: Long, hz: Long): String = hashId(isoSeconds(powerOnMs) + freqText(hz) + "SONDE")

    internal val INSTRUMENTS = mapOf(0x01 to "ozone (ECC)", 0x05 to "ozone (OIF411)", 0x08 to "frost-point hygrometer (CFH)", 0x19 to "aerosol (COBALD)")
}

class ImetDecoder(rate: Double, private val sink: SondeSink) : ChannelDecoder {
    override val name = "iMet"
    /** The channel's frequency, Hz, for the ID (set by the receiver; 0 = unknown). */
    override var hz: Long? = 0L
    /** Wall clock, ms (the date half of the GPS time; replaceable for tests). */
    var clock: () -> Long = { System.currentTimeMillis() }

    // tone detector: sliding DFT over one bit at the two tones
    private val l = max(4, Math.round(rate / Imet.BAUD).toInt())
    private val bitLen = rate / Imet.BAUD
    private val ring = DoubleArray(4 * l)
    private var rp = 0
    private var s1r = 0.0; private var s1i = 0.0; private var s2r = 0.0; private var s2i = 0.0
    private var o1r = 1.0; private var o1i = 0.0; private var o2r = 1.0; private var o2i = 0.0
    private val c1r: Double; private val c1i: Double; private val c2r: Double; private val c2i: Double
    private var dc = 0.0; private var amp = 0.0; private var n = 0L; private var prev = 0.0
    // UART
    private var inByte = false; private var nextAt = 0.0; private var bitIx = 0; private var cur = 0; private var lastByteAt = -1e9
    private val buf = IntArray(512); private var nb = 0
    // packets and identity
    private var gpsAt = -1e12; private var gLat = 0.0; private var gLon = 0.0; private var gAlt = 0; private var gSats = 0; private var gTime = -1
    private var gVel = false; private var gvE = 0.0; private var gvN = 0.0; private var gvU = 0.0
    private var model = ""
    private var prevFrame = -1; private var prevTime = -1
    private var id = ""; private var idPowerOn = 0L; private var idHz = 0L

    init {
        val w1 = 2 * PI * Imet.MARK / rate; val w2 = 2 * PI * Imet.SPACE / rate
        c1r = cos(w1); c1i = -sin(w1); c2r = cos(w2); c2i = -sin(w2)
    }

    private val myHz: Long get() = hz ?: 0L

    /** One discriminator sample. */
    override fun push(x: Double) {
        dc += (x - dc) * 0.002
        var v = x - dc
        // FM clicks (a near-2π phase jump in a few samples) would ring in both tone filters: clip at 1.5 times the mean level
        amp += ((if (v < 0) -v else v) - amp) * 0.001
        val lim = 1.5 * amp
        if (v > lim) v = lim else if (v < -lim) v = -lim
        // turn the two oscillators, mix, slide the one-bit sums
        var a = o1r * c1r - o1i * c1i; o1i = o1r * c1i + o1i * c1r; o1r = a
        a = o2r * c2r - o2i * c2i; o2i = o2r * c2i + o2i * c2r; o2r = a
        val r = ring; val p = rp
        val z1r = v * o1r; val z1i = v * o1i; val z2r = v * o2r; val z2i = v * o2i
        s1r += z1r - r[p]; s1i += z1i - r[p + 1]; s2r += z2r - r[p + 2]; s2i += z2i - r[p + 3]
        r[p] = z1r; r[p + 1] = z1i; r[p + 2] = z2r; r[p + 3] = z2i
        rp = if (p + 4 == r.size) 0 else p + 4
        val nn = ++n
        if ((nn and 4095L) == 0L) renormalize()
        // mark energy minus space energy: > 0 is a 1
        val d = s1r * s1r + s1i * s1i - s2r * s2r - s2i * s2i
        if (!inByte) {
            if (prev >= 0 && d < 0) {
                // the window is half into the start bit now; it covers a whole bit half a bit later, and every bit after
                inByte = true; bitIx = 0; cur = 0; nextAt = nn + bitLen / 2
            } else if (nb > 0 && nn - lastByteAt > 25 * bitLen) flush()
        } else if (nn >= nextAt) {
            nextAt += bitLen
            val k = bitIx++
            if (k == 0) { if (d >= 0) inByte = false }
            else if (k <= 8) { if (d > 0) cur = cur or (1 shl (k - 1)) }
            else {
                inByte = false
                if (d > 0) {
                    if (nb == buf.size) flush()
                    buf[nb++] = cur; lastByteAt = nn.toDouble()
                } else flush()   // framing error: whatever came before is a burst of its own
            }
        }
        prev = d
    }

    private fun renormalize() {
        var m = sqrt(o1r * o1r + o1i * o1i); o1r /= m; o1i /= m
        m = sqrt(o2r * o2r + o2i * o2i); o2r /= m; o2i /= m
        // and re-add the sums so rounding never builds up
        var a = 0.0; var b = 0.0; var c = 0.0; var e = 0.0
        var i = 0
        while (i < ring.size) { a += ring[i]; b += ring[i + 1]; c += ring[i + 2]; e += ring[i + 3]; i += 4 }
        s1r = a; s1i = b; s2r = c; s2i = e
    }

    private fun flush() {
        val k = nb
        nb = 0
        if (k >= 14) parseBurst(buf, k)
    }

    /**
     * One burst of bytes: every packet whose CRC checks, wherever it starts. A report goes out for a good PTU packet,
     * with the GPS packet of the same second.
     */
    fun parseBurst(b: IntArray, n: Int): SondeFrame? {
        var ptu = false; var frame = 0; var hPa = 0.0; var tempC = 0.0; var rh = 0.0; var battV = 0.0
        var ext = false; var tInt = 0.0; var tPr = 0.0; var tU = 0.0
        var aux = ""; var auxName = ""
        var i = 0
        while (i + 5 <= n) {
            if (b[i] != 0x01 || b[i + 1] < 1 || b[i + 1] > 5) { i++; continue }
            val pid = b[i + 1]
            val len = if (pid == Imet.PKT_XDATA) 5 + b[i + 2] else Imet.PKT_LEN[pid]
            if (len <= 5 || i + len > n || Imet.crc(b, i, len - 2) != ((b[i + len - 2] shl 8) or b[i + len - 1])) { i++; continue }
            if (pid == Imet.PKT_PTU || pid == Imet.PKT_EPTU) {
                ptu = true
                frame = Imet.u16(b, i + 2)
                hPa = (b[i + 4] or (b[i + 5] shl 8) or (b[i + 6] shl 16)) / 100.0
                tempC = Imet.i16(b, i + 7) / 100.0
                rh = Imet.u16(b, i + 9) / 100.0
                battV = b[i + 11] / 10.0
                if (pid == Imet.PKT_EPTU) { ext = true; tInt = Imet.i16(b, i + 12) / 100.0; tPr = Imet.i16(b, i + 14) / 100.0; tU = Imet.i16(b, i + 16) / 100.0 }
            } else if (pid == Imet.PKT_GPS || pid == Imet.PKT_EGPS) {
                val t = if (pid == Imet.PKT_GPS) i + 13 else i + 25
                val hh = b[t]; val mm = b[t + 1]; val ss = b[t + 2]
                val lat = Imet.f32(b, i + 2); val lon = Imet.f32(b, i + 6); val alt = Imet.u16(b, i + 10) - 5000
                if (hh < 24 && mm < 60 && ss < 61 && lat > -91 && lat < 91 && lon > -181 && lon < 181) {
                    gpsAt = this.n.toDouble(); gLat = lat; gLon = lon; gAlt = alt; gSats = b[i + 12]
                    gTime = hh * 3600 + mm * 60 + ss
                    gVel = pid == Imet.PKT_EGPS
                    if (gVel) { gvE = Imet.f32(b, i + 13); gvN = Imet.f32(b, i + 17); gvU = Imet.f32(b, i + 21) }
                }
            } else {
                val nn = b[i + 2]
                val hex = StringBuilder()
                for (k in 0 until nn) hex.append("%02X".format(b[i + 3 + k]))
                aux += (if (aux.isNotEmpty()) "#" else "") + hex
                Imet.INSTRUMENTS[b[i + 3]]?.let { auxName = it }
            }
            i += len
        }
        if (!ptu) return null
        // GPS from this burst (or the one just before, if a framing error split them)
        val gpsFresh = this.n - gpsAt < 1.5 * Imet.BAUD * bitLen && gTime >= 0
        val locked = gpsFresh && gSats >= 4
        val out = SondeFrame(type = "iMet", serial = "", frame = frame, battV = battV)
        if (hPa > 0) out.hPa = hPa
        if (tempC > -100 && tempC < 60) out.tempC = tempC
        if (rh >= 0 && rh <= 100) out.rh = rh
        if (ext) { out.put("INTERNAL TEMPERATURE", "%.2f °C".format(Locale.US, tInt)); out.put("PRESSURE SENSOR", "%.2f °C".format(Locale.US, tPr)) }
        if (ext && tU > -100 && tU < 60) out.tHumC = tU
        if (aux.isNotEmpty()) { out.put("AUX DATA", if (aux.length > 40) aux.substring(0, 40) + "…" else aux); if (auxName.isNotEmpty()) out.put("AUX", auxName) }
        if (gpsFresh) {
            out.sats = gSats
            if (locked && gAlt > -1000 && gAlt < 80000) {
                out.lat = gLat; out.lon = gLon; out.alt = gAlt.toDouble(); out.timeS = gTime.toDouble()
                if (gVel) {
                    val vH = sqrt(gvE * gvE + gvN * gvN)
                    var hd = atan2(gvE, gvN) * 180 / PI; if (hd < 0) hd += 360
                    if (vH < 1000 && gvU > -1000 && gvU < 1000) { out.vH = vH; out.heading = hd; out.climb = gvU }
                }
            }
        }
        if (locked) {
            // iMet-1 or iMet-4: the frame counter against the clock over two frames (the first is held back for this)
            if (model.isEmpty()) {
                if (prevFrame < 0) { prevFrame = frame; prevTime = gTime; return null }
                var dt = gTime - prevTime; if (dt < -43200) dt += 86400
                val df = frame - prevFrame
                if (dt <= 0 || df <= 0 || dt > 600) { prevFrame = frame; prevTime = gTime; return null }
                model = if (dt == Math.floorDiv(df, 2)) "iMet-1-RSB" else "iMet-4"
            }
            out.model = model
            val frameS = if (model == "iMet-1-RSB") Math.floorDiv(frame, 2) else frame
            val powerOn = Imet.dateTimeMs(gTime.toDouble(), clock()) - frameS * 1000L
            // the same sonde gives the same power-on time to within the counter's phase against the GPS second
            if (id.isEmpty() || abs(powerOn - idPowerOn) > 2000 || Imet.freqText(myHz) != Imet.freqText(idHz)) {
                id = Imet.uniqueId(powerOn, myHz); idPowerOn = powerOn; idHz = myHz
            }
            out.serial = id
            out.put("POWER-ON", Imet.isoSeconds(powerOn))
        } else {
            // no GPS lock: keep the ID we had, or one from the frequency alone until the first fix
            out.serial = id.ifEmpty { Imet.hashId(Imet.freqText(myHz) + "SONDE") }
            if (model.isNotEmpty()) out.model = model
        }
        sink(out)
        return out
    }
}
