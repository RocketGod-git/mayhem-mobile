package com.rocketgod.mayhem.core.r433

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min

/*
 * What a device decoder is and what it produces, the pulse slicers that turn a burst into rows of bits, and the
 * runner that offers every burst to every protocol. Twin of web/src/dsp/r433/device.ts, slicers.ts and
 * runner.ts, which port rtl_433's r_device.h and pulse_slicer.c (GPL-2.0-or-later).
 *
 * rtl_433's design is what makes a bulk port tractable: a decoder is a pure function from a buffer of bits to a
 * reading. Finding a burst, measuring its pulses and slicing them happens once, in code every protocol shares.
 */

/** How the bits are carried; numbering matches rtl_433 so ported device tables read the same. */
object Mod {
    const val OOK_MANCHESTER_ZEROBIT = 3
    const val OOK_PCM = 4
    const val OOK_PPM = 5
    const val OOK_PWM = 6
    const val OOK_PIWM_RAW = 8
    const val OOK_DMC = 9
    const val OOK_PWM_OSV1 = 10
    const val OOK_PIWM_DC = 11
    const val OOK_NRZS = 12
    const val OOK_RZI = 13
    const val FSK_PCM = 16
    const val FSK_PWM = 17
    const val FSK_MANCHESTER_ZEROBIT = 18
}
const val FSK_DEMOD_MIN_VAL = 16

const val DECODE_FAIL_OTHER = 0
const val DECODE_ABORT_LENGTH = -1
const val DECODE_ABORT_EARLY = -2
/** Message integrity check: CRC, checksum or parity. */
const val DECODE_FAIL_MIC = -3
/** Decoded, but the values cannot be real. */
const val DECODE_FAIL_SANITY = -4

/** One reading: `model` names the device; everything else is whatever that device reports. Insertion-ordered. */
typealias R433Data = LinkedHashMap<String, Any?>

/** A reading from key/value pairs; nulls are left out, as an undefined field is in the web app's JSON. */
fun data(vararg kv: Pair<String, Any?>): R433Data {
    val m = R433Data()
    for ((k, v) in kv) if (v != null) m[k] = v
    return m
}

fun interface DecodeCtx {
    fun emit(d: R433Data)
}

typealias DecodeFn = (dev: RDevice, bits: BitBuffer, ctx: DecodeCtx) -> Int

/**
 * A protocol: timings in microseconds and the function that reads its bits. `shortWidth` / `longWidth` mean
 * different things per modulation — pulse widths for PWM, gap widths for PPM, bit periods for PCM — which is why
 * the slicers, not the devices, interpret them.
 */
class RDevice(
    val num: Int,
    val name: String,
    val modulation: Int,
    val shortWidth: Double,
    val longWidth: Double,
    val resetLimit: Double,
    val gapLimit: Double = 0.0,
    val syncWidth: Double = 0.0,
    val tolerance: Double = 0.0,
    /** Off by default in rtl_433 (no usable checksum); it runs here, and a lone match from it is held back. */
    val disabled: Boolean = false,
    /** Order among protocols that can read the same bits; lower runs earlier. */
    val priority: Int = 0,
    /** Which bands it is normally heard in, Hz. */
    val bands: List<Long> = emptyList(),
    /** One line for the UI: what the thing actually is. */
    val what: String? = null,
    val decode: DecodeFn,
)

// ================================================================================================ slicers

/** A burst as the front end measured it: alternating mark and space durations, in samples. */
class PulseData(cap: Int, var sampleRate: Double, val fsk: Boolean) {
    val pulse = IntArray(cap)
    val gap = IntArray(cap)
    var numPulses = 0
    fun clear() { pulse.fill(0); gap.fill(0); numPulses = 0 }
}

typealias Account = (BitBuffer) -> Int

private const val INT_MAX = 0x7fffffff

/** C's `(int)x`: truncation toward zero. */
private fun trunc(x: Double): Int = (if (x < 0) ceil(x) else floor(x)).toInt()

private class Widths(val sShort: Int, val sLong: Int, val sReset: Int, val sGap: Int, val sSync: Int, val sTol: Int)

private fun widths(p: PulseData, d: RDevice): Widths? {
    val spus = p.sampleRate / 1e6
    val w = Widths(trunc(d.shortWidth * spus), trunc(d.longWidth * spus), trunc(d.resetLimit * spus),
        trunc(d.gapLimit * spus), trunc(d.syncWidth * spus), trunc(d.tolerance * spus))
    // a timing that rounds away to nothing cannot be resolved at this sample rate
    if ((d.shortWidth > 0 && w.sShort <= 0) || (d.longWidth > 0 && w.sLong <= 0) || (d.resetLimit > 0 && w.sReset <= 0) ||
        (d.gapLimit > 0 && w.sGap <= 0) || (d.syncWidth > 0 && w.sSync <= 0) || (d.tolerance > 0 && w.sTol <= 0)) return null
    return w
}

/**
 * NRZ and RZ: the level is the bit, held one bit period. The period is measured from a run of alternating bits
 * (a preamble, or every bit that already looks right) and sliced with that rather than the nominal value.
 */
private fun slicerPcm(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val sShort = w.sShort; val sLong = w.sLong; val sReset = w.sReset
    var sTol = w.sTol
    var fShort = if (d.shortWidth > 0) 1 / (d.shortWidth * (p.sampleRate / 1e6)) else 0.0
    var fLong = if (d.longWidth > 0) 1 / (d.longWidth * (p.sampleRate / 1e6)) else 0.0
    var events = 0
    val bits = BitBuffer()
    val gapLimit = if (w.sGap != 0) w.sGap else sReset
    val maxZeros = trunc(gapLimit.toDouble() / sLong)
    if (sTol <= 0) sTol = trunc(sLong / 4.0)
    var minCount = if (sShort == sLong) 12 else 4
    var preambleLen = 0

    var n = 0
    while (sShort != sLong && n < p.numPulses) {
        var swidth = 0; var lwidth = 0; var count = 0
        while (n < p.numPulses && p.pulse[n] >= sShort - sTol && p.pulse[n] <= sShort + sTol &&
            p.pulse[n] + p.gap[n] >= sLong - sTol && p.pulse[n] + p.gap[n] <= sLong + sTol) {
            swidth += p.pulse[n]; lwidth += p.pulse[n] + p.gap[n]; count += 1; n++
        }
        if (count >= minCount) { fLong = count.toDouble() / lwidth; fShort = count.toDouble() / swidth; minCount = count; preambleLen = count }
        n++
    }
    var rzsWidth = 0; var rzlWidth = 0; var rzCount = 0
    n = 0
    while (preambleLen == 0 && sShort != sLong && n < p.numPulses) {
        if (p.pulse[n] >= sShort - sTol && p.pulse[n] <= sShort + sTol && p.pulse[n] + p.gap[n] >= sLong - sTol && p.pulse[n] + p.gap[n] <= sLong + sTol) {
            rzsWidth += p.pulse[n]; rzlWidth += p.pulse[n] + p.gap[n]; rzCount += 1
        }
        n++
    }
    if (rzCount > 8) { fLong = rzCount.toDouble() / rzlWidth; fShort = rzCount.toDouble() / rzsWidth }

    n = 0
    while (sShort == sLong && n < p.numPulses) {
        var width = 0; var count = 0
        while (n < p.numPulses && trunc(p.pulse[n] * fShort + 0.5) == 1 && trunc(p.gap[n] * fLong + 0.5) == 1) {
            width += p.pulse[n] + p.gap[n]; count += 2; n++
        }
        if (count >= minCount) { fShort = count.toDouble() / width; fLong = fShort; minCount = count; preambleLen = count }
        n++
    }
    var nrzWidth = 0; var nrzCount = 0
    n = 0
    while (preambleLen == 0 && sShort == sLong && n < p.numPulses) {
        if (p.pulse[n] >= sShort - sTol && p.pulse[n] <= sShort + sTol) { nrzWidth += p.pulse[n]; nrzCount += 1 }
        if (p.pulse[n] >= 2 * sShort - sTol && p.pulse[n] <= 2 * sShort + sTol) { nrzWidth += p.pulse[n]; nrzCount += 2 }
        if (p.gap[n] >= sLong - sTol && p.gap[n] <= sLong + sTol) { nrzWidth += p.gap[n]; nrzCount += 1 }
        if (p.gap[n] >= 2 * sLong - sTol && p.gap[n] <= 2 * sLong + sTol) { nrzWidth += p.gap[n]; nrzCount += 2 }
        n++
    }
    if (nrzCount > 20) { fShort = nrzCount.toDouble() / nrzWidth; fLong = fShort }

    for (i in 0 until p.numPulses) {
        val highs = trunc(p.pulse[i] * fShort + 0.5)
        // for return-to-zero the nominal gap belongs to the bit itself
        var lows = trunc((p.gap[i] + sShort - sLong) * fLong + 0.5)
        repeat(highs.coerceAtLeast(0)) { bits.addBit(1) }
        lows = min(lows, maxZeros)
        repeat(lows.coerceAtLeast(0)) { bits.addBit(0) }
        if (sShort != sLong && abs(p.pulse[i] - sShort) > sTol) bits.clear()
        else if (p.gap[i] > gapLimit && p.gap[i] <= sReset) bits.addRow()
        if ((i == p.numPulses - 1 || p.gap[i] > sReset) && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) events += account(bits)
    }
    return events
}

/** Pulse position: every mark is the same, and the gap after it says whether the bit was a one. */
private fun slicerPpm(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    var events = 0
    val bits = BitBuffer()
    val zeroL: Int; val zeroU: Int; val oneL: Int; val oneU: Int; var syncL = 0; var syncU = 0
    if (w.sTol > 0) {
        zeroL = w.sShort - w.sTol; zeroU = w.sShort + w.sTol
        oneL = w.sLong - w.sTol; oneU = w.sLong + w.sTol
        if (w.sSync > 0) { syncL = w.sSync - w.sTol; syncU = w.sSync + w.sTol }
    } else {
        zeroL = 0; zeroU = trunc((w.sShort + w.sLong) / 2.0) + 1
        oneL = zeroU - 1; oneU = if (w.sGap != 0) w.sGap else w.sReset
    }
    for (n in 0 until p.numPulses) {
        val g = p.gap[n]
        if (g > zeroL && g < zeroU) bits.addBit(0)
        else if (g > oneL && g < oneU) bits.addBit(1)
        else if (g > syncL && g < syncU) bits.addSync()
        else if (g < w.sReset) bits.addRow()
        if ((n == p.numPulses - 1 || g >= w.sReset) && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) events += account(bits)
    }
    return events
}

/** Pulse width: gaps all the same, the mark length is the bit (short is a one), with a sync that may sit anywhere. */
private fun slicerPwm(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val sShort = w.sShort; val sLong = w.sLong; val sSync = w.sSync; val sTol = w.sTol
    var events = 0
    val bits = BitBuffer()
    var oneL: Int; var oneU: Int; var zeroL: Int; var zeroU: Int; var syncL = 0; var syncU = 0
    if (sTol > 0) {
        oneL = sShort - sTol; oneU = sShort + sTol; zeroL = sLong - sTol; zeroU = sLong + sTol
        if (sSync > 0) { syncL = sSync - sTol; syncU = sSync + sTol }
    } else if (sSync <= 0) {
        oneL = 0; oneU = trunc((sShort + sLong) / 2.0) + 1; zeroL = oneU - 1; zeroU = INT_MAX
    } else if (sSync < sShort) {
        syncL = 0; syncU = trunc((sSync + sShort) / 2.0) + 1
        oneL = syncU - 1; oneU = trunc((sShort + sLong) / 2.0) + 1
        zeroL = oneU - 1; zeroU = INT_MAX
    } else if (sSync < sLong) {
        oneL = 0; oneU = trunc((sShort + sSync) / 2.0) + 1
        syncL = oneU - 1; syncU = trunc((sSync + sLong) / 2.0) + 1
        zeroL = syncU - 1; zeroU = INT_MAX
    } else {
        oneL = 0; oneU = trunc((sShort + sLong) / 2.0) + 1
        zeroL = oneU - 1; zeroU = trunc((sLong + sSync) / 2.0) + 1
        syncL = zeroU - 1; syncU = INT_MAX
    }
    for (n in 0 until p.numPulses) {
        val x = p.pulse[n]
        if (x > oneL && x < oneU) bits.addBit(1)
        else if (x > zeroL && x < zeroU) bits.addBit(0)
        else if (x > syncL && x < syncU) bits.addSync()
        else if (x <= oneL) { /* a spurious short mark: ignore it rather than break the row */ }
        else bits.addRow()
        if ((n == p.numPulses - 1 || p.gap[n] > w.sReset) && bits.numRows > 0) events += account(bits)
        else if (w.sGap > 0 && p.gap[n] > w.sGap && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow()
    }
    return events
}

/** Manchester with a hardcoded leading zero: a falling mid-period edge is a one, rising a zero. */
private fun slicerManchesterZerobit(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val sShort = w.sShort; val sTol = w.sTol
    var events = 0; var timeSinceLast = 0
    val bits = BitBuffer()
    bits.addBit(0)
    for (n in 0 until p.numPulses) {
        if (sTol > 0 && (p.pulse[n] < sShort - sTol || p.pulse[n] > sShort * 2 + sTol || p.gap[n] < sShort - sTol || p.gap[n] > sShort * 2 + sTol)) {
            if (p.pulse[n] > sShort * 1.5 && p.pulse[n] <= sShort * 2 + sTol) bits.addBit(1)
            bits.addRow(); bits.addBit(0); timeSinceLast = 0
        } else if (p.pulse[n] + timeSinceLast > sShort * 1.5) { bits.addBit(1); timeSinceLast = 0 }
        else timeSinceLast += p.pulse[n]

        if ((n == p.numPulses - 1 || p.gap[n] > w.sReset) && bits.numRows > 0) { events += account(bits); bits.addBit(0); timeSinceLast = 0 }
        else if (p.gap[n] + timeSinceLast > sShort * 1.5) { bits.addBit(0); timeSinceLast = 0 }
        else timeSinceLast += p.gap[n]
    }
    return events
}

private fun symbolAt(p: PulseData, n: Int): Int = if (n % 2 == 0) p.pulse[n shr 1] else p.gap[n shr 1]

/** Differential Manchester: a short symbol is half a one and needs its partner; a long symbol is a zero. */
private fun slicerDmc(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val bits = BitBuffer()
    var events = 0
    val total = p.numPulses * 2
    var n = 0
    while (n < total) {
        var symbol = symbolAt(p, n)
        if (abs(symbol - w.sShort) < w.sTol) {
            bits.addBit(1)
            symbol = if (n + 1 < total) symbolAt(p, ++n) else 0
            if (abs(symbol - w.sShort) > w.sTol) {
                if (symbol >= w.sReset - w.sTol) n--
                else if (bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow()
            }
        } else if (abs(symbol - w.sLong) < w.sTol) bits.addBit(0)
        else if (symbol >= w.sReset - w.sTol && bits.numRows > 0) events += account(bits)
        n++
    }
    return events
}

/** Pulse interval width, raw: the level flips every bit and the interval says how many of that bit. */
private fun slicerPiwmRaw(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val fShort = if (d.shortWidth > 0) 1 / (d.shortWidth * (p.sampleRate / 1e6)) else 0.0
    val bits = BitBuffer()
    var events = 0
    val total = p.numPulses * 2
    for (n in 0 until total) {
        val symbol = symbolAt(p, n)
        var count = trunc(symbol * fShort + 0.5)
        if (symbol > w.sLong) bits.addRow()
        else if (abs(symbol - count * w.sShort) < w.sTol) { while (count > 0) { bits.addBit(1 - (n % 2)); count-- } }
        else if (symbol < w.sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow()
        if ((n == total - 1 || symbol > w.sReset) && bits.numRows > 0) events += account(bits)
    }
    return events
}

/** Pulse interval width with a distinct clock: a short interval is a one, a long one a zero. */
private fun slicerPiwmDc(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val bits = BitBuffer()
    var events = 0
    val total = p.numPulses * 2
    for (n in 0 until total) {
        val symbol = symbolAt(p, n)
        if (abs(symbol - w.sShort) < w.sTol) bits.addBit(1)
        else if (abs(symbol - w.sLong) < w.sTol) bits.addBit(0)
        else if (symbol < w.sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) bits.addRow()
        if ((n == total - 1 || symbol > w.sReset) && bits.numRows > 0) events += account(bits)
    }
    return events
}

/** NRZ-S: the mark length counts ones, and every mark is closed by a zero. */
private fun slicerNrzs(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val limit = w.sShort
    var events = 0
    val bits = BitBuffer()
    for (n in 0 until p.numPulses) {
        if (p.pulse[n] > limit) { repeat(trunc(p.pulse[n].toDouble() / limit)) { bits.addBit(1) }; bits.addBit(0) }
        else if (p.pulse[n] < limit) bits.addBit(0)
        if (n == p.numPulses - 1 || p.gap[n] >= w.sReset) events += account(bits)
    }
    return events
}

/** Return to zero, inverted: the carrier sits high and a brief dip marks a zero; runs of ones are counted by length. */
private fun slicerRzi(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val sBase = w.sLong - w.sShort; val half = trunc(w.sLong / 2.0)
    var events = 0
    val bits = BitBuffer()
    var atStart = true
    for (n in 0 until p.numPulses) {
        val high = p.pulse[n]
        var ones = if (atStart) trunc((high + half).toDouble() / w.sLong) else trunc((high - sBase + half).toDouble() / w.sLong)
        atStart = false
        if (ones < 0) ones = 0
        repeat(ones) { bits.addBit(1) }
        if (p.gap[n] > w.sReset || n == p.numPulses - 1) {
            if (bits.bitsPerRow[0] > 0) events += account(bits)
            atStart = true
            continue
        }
        bits.addBit(0)
    }
    return events
}

/** Oregon Scientific v1: exactly twelve preamble pulses, a long sync, then Manchester counted rather than clocked. */
private fun slicerOsv1(p: PulseData, d: RDevice, account: Account): Int {
    val w = widths(p, d) ?: return 0
    val halfbitMin = trunc(w.sShort / 2.0); val halfbitMax = trunc(w.sShort * 3 / 2.0); val syncMin = 2 * halfbitMax
    var events = 0; var manbit = 0
    val bits = BitBuffer()
    var n = 0; var preamble = 0
    while (n < p.numPulses) {
        if (p.pulse[n] > halfbitMin && p.gap[n] > halfbitMin) { preamble++; if (p.gap[n] > halfbitMax) break }
        else return events
        n++
    }
    if (preamble != 12) return events
    ++n
    if (n >= p.numPulses || p.pulse[n] < syncMin || p.gap[n] < syncMin) return events
    if (p.gap[n] > p.pulse[n]) { manbit = manbit xor 1; if (manbit != 0) bits.addBit(0) }
    n++
    while (n < p.numPulses) {
        manbit = manbit xor 1; if (manbit != 0) bits.addBit(1)
        if (p.pulse[n] > halfbitMax) { manbit = manbit xor 1; if (manbit != 0) bits.addBit(1) }
        if ((n == p.numPulses - 1 || p.gap[n] > w.sReset) && bits.numRows > 0) { events += account(bits); return events }
        manbit = manbit xor 1; if (manbit != 0) bits.addBit(0)
        if (p.gap[n] > halfbitMax) { manbit = manbit xor 1; if (manbit != 0) bits.addBit(0) }
        n++
    }
    return events
}

/** Run the slicer this protocol asks for. */
fun slice(p: PulseData, d: RDevice, account: Account): Int = when (d.modulation) {
    Mod.OOK_PCM, Mod.FSK_PCM -> slicerPcm(p, d, account)
    Mod.OOK_PPM -> slicerPpm(p, d, account)
    Mod.OOK_PWM, Mod.FSK_PWM -> slicerPwm(p, d, account)
    Mod.OOK_MANCHESTER_ZEROBIT, Mod.FSK_MANCHESTER_ZEROBIT -> slicerManchesterZerobit(p, d, account)
    Mod.OOK_DMC -> slicerDmc(p, d, account)
    Mod.OOK_PIWM_RAW -> slicerPiwmRaw(p, d, account)
    Mod.OOK_PIWM_DC -> slicerPiwmDc(p, d, account)
    Mod.OOK_NRZS -> slicerNrzs(p, d, account)
    Mod.OOK_RZI -> slicerRzi(p, d, account)
    Mod.OOK_PWM_OSV1 -> slicerOsv1(p, d, account)
    else -> 0
}

// ================================================================================================ runner

class R433Result(val dev: RDevice, val data: R433Data)

/** Why bursts that looked real were thrown away, for the "almost heard something" line. */
class R433Stats {
    var bursts = 0; var ook = 0; var fsk = 0; var decoded = 0
    /** Transmissions a decoder claimed but whose checksum failed: a device in range, too weak to read. */
    var badChecksum = 0
    /** Which protocols those near misses belonged to, and how many each. */
    val near = LinkedHashMap<String, Int>()
}

/** Every protocol, in turn, slices the burst with its own timings and offers the bits to its own decoder. */
class R433(devices: List<RDevice>? = null) {
    val stats = R433Stats()
    val devices: List<RDevice> = (devices ?: R433Registry.all).sortedBy { it.priority }

    fun run(fskBurst: Boolean, pulses: PulseData): List<R433Result> {
        val out = ArrayList<R433Result>()
        stats.bursts++
        if (fskBurst) stats.fsk++ else stats.ook++
        for (dev in devices) {
            if ((dev.modulation >= FSK_DEMOD_MIN_VAL) != fskBurst) continue
            var raw = ""
            val ctx = DecodeCtx { d -> out.add(R433Result(dev, R433Data(d).also { it["raw"] = raw; it["protocol"] = dev.num })) }
            slice(pulses, dev) { bits ->
                // the bits as they came off the air, before a decoder inverts or unmasks them in place
                raw = (0 until bits.numRows).filter { bits.bitsPerRow[it] != 0 }.joinToString("/") { "{${bits.bitsPerRow[it]}}${bits.rowHex(it)}" }
                val n = try { dev.decode(dev, bits, ctx) } catch (_: Throwable) { 0 }   // a decoder that throws must not take the receiver with it
                if (n == DECODE_FAIL_MIC) { stats.badChecksum++; stats.near[dev.name] = (stats.near[dev.name] ?: 0) + 1 }
                bits.clear()
                if (n > 0) n else 0
            }
        }
        stats.decoded += out.size
        return out
    }
}
