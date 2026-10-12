package com.rocketgod.mayhem.core.apps.ism

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog

/**
 * Sub-GHz OOK receiver (Mayhem proc_weather / proc_subghzd / proc_subcar, rtl_433 style): raw IQ → 500 kHz →
 * magnitude² → adaptive high/low level estimators with hysteresis → (level, duration µs) pulses → every protocol
 * state machine at once. Hits are turned into readings by the weather / remote / car field decoders.
 */
class IsmDecoder(private val log: PacketLog) : IqProcessor {
    @Volatile var weather = true
    @Volatile var remotes = true
    @Volatile var cars = true

    private val protos: List<FProto> = IsmProtos.all().onEach { it.callback = { p -> onHit(p) } }
    private var dcI = 127.4f; private var dcQ = 127.4f
    private var dec = 4; private var accI = 0f; private var accQ = 0f; private var accN = 0
    private var nsPerSamp = 2000L
    private var state = STATE_IDLE
    private var lowEstimate = 10f; private var highEstimate = 1000f
    private var numg = 0
    private var currentDurationNs = 0L; private var currentHiLow = false
    private val seen = HashMap<String, Long>()
    private var hits = 0

    override fun reset(rate: Int) {
        dec = (rate / 500_000).coerceAtLeast(1)
        nsPerSamp = (1_000_000_000L / (rate / dec)).toLong()
        accI = 0f; accQ = 0f; accN = 0; state = STATE_IDLE; lowEstimate = 10f; highEstimate = 1000f; numg = 0
        currentDurationNs = 0L; currentHiLow = false
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val nSamp = len / 2
        var sI = 0f; var sQ = 0f
        for (i in 0 until nSamp) { sI += (iq[2 * i].toInt() and 0xff); sQ += (iq[2 * i + 1].toInt() and 0xff) }
        dcI += 0.2f * (sI / nSamp - dcI); dcQ += 0.2f * (sQ / nSamp - dcQ)
        for (i in 0 until nSamp) {
            accI += (iq[2 * i].toInt() and 0xff) - dcI
            accQ += (iq[2 * i + 1].toInt() and 0xff) - dcQ
            if (++accN < dec) continue
            val ci = accI / accN; val cq = accQ / accN; accI = 0f; accQ = 0f; accN = 0
            sample(ci * ci + cq * cq)
        }
    }

    /** Mayhem's OOK level tracker, one decimated sample at a time. */
    private fun sample(mag: Float) {
        val threshold = (lowEstimate + highEstimate) / 2
        val hysteresis = threshold / 8
        var meashl = currentHiLow
        when (state) {
            STATE_IDLE -> if (mag > threshold + hysteresis) { meashl = true; state = STATE_PULSE; numg = 0 }
            else {
                meashl = false
                val delta = mag - lowEstimate
                lowEstimate += delta / 5f
                lowEstimate += if (delta > 0) 0.01f else -0.01f
                if (lowEstimate < 0.5f) lowEstimate = 0.5f
                highEstimate = (1.35f * lowEstimate).coerceIn(MIN_HIGH, MAX_HIGH)
            }
            STATE_PULSE -> {
                if (++numg > 100) numg = 100
                if (mag < threshold - hysteresis) {
                    if (numg < 3) state = STATE_GAP else { numg = 0; state = STATE_GAP_START }
                    meashl = false
                } else {
                    highEstimate += mag / 3f - highEstimate / 3f
                    highEstimate = highEstimate.coerceIn(MIN_HIGH, MAX_HIGH)
                    meashl = true
                }
            }
            STATE_GAP_START -> {
                ++numg
                if (mag > threshold + hysteresis) { state = STATE_PULSE; meashl = true }
                else if (numg >= 3) { state = STATE_GAP; meashl = false }
            }
            STATE_GAP -> {
                ++numg
                if (mag > threshold + hysteresis) { numg = 0; state = STATE_PULSE; meashl = true } else meashl = false
            }
        }
        if (meashl == currentHiLow && currentDurationNs < 30_000_000L) currentDurationNs += nsPerSamp
        else {
            if (currentDurationNs >= 30_000_000L) state = STATE_IDLE
            feed(currentHiLow, (currentDurationNs / 1000L).toInt())
            currentDurationNs = nsPerSamp
            currentHiLow = meashl
        }
    }

    private fun feed(level: Boolean, durationUs: Int) {
        for (p in protos) {
            val on = when (p.family) { Fam.WEATHER -> weather; Fam.REMOTE -> remotes; else -> cars }
            if (on) p.feed(level, durationUs)
        }
    }

    private fun onHit(p: FProto) {
        val key = "${p.family}:${p.sensorType}:${p.decodeData}:${p.decodeData2}"
        val now = System.currentTimeMillis()
        if (now - (seen[key] ?: 0L) < 1200) return
        seen[key] = now
        if (seen.size > 500) seen.clear()
        hits++
        val line = when (p.family) {
            Fam.WEATHER -> {
                val w = WeatherFields.parse(p.sensorType, p.decodeData)
                val sb = StringBuilder("WX %-20s id %d".format(w.name, w.id))
                w.channel?.let { sb.append("  ch $it") }
                w.temp?.let { sb.append("  %.1f°C / %.1f°F".format(it, it * 9 / 5 + 32)) }
                w.humidity?.let { sb.append("  $it%") }
                w.batteryLow?.let { sb.append(if (it) "  batt LOW" else "  batt OK") }
                sb.toString()
            }
            Fam.REMOTE -> {
                val r = RemoteFields.parse(p.sensorType, p.decodeData, p.dataCountBit)
                val sb = StringBuilder("REMOTE %-16s key %s (%d bits)".format(r.name, java.lang.Long.toHexString(p.decodeData).uppercase().padStart(8, '0'), p.dataCountBit))
                if (r.serial != 0L) sb.append("  serial %X".format(r.serial))
                r.btn?.let { sb.append("  btn $it") }
                r.cnt?.let { sb.append("  cnt $it") }
                for (e in r.extra) sb.append("  ").append(e)
                sb.toString()
            }
            else -> {
                val c = CarFields.parse(p.sensorType, p.decodeData, p.decodeData2, p.dataCountBit)
                val sb = StringBuilder("CAR %-12s serial %X".format(c.name, c.serial))
                if (c.btn.isNotEmpty()) sb.append("  btn ${c.btn}")
                c.cnt?.let { sb.append("  cnt $it") }
                sb.append("  data %X".format(p.decodeData)); if (p.decodeData2 != 0L) sb.append(" %X".format(p.decodeData2))
                for (e in c.extra) sb.append("  ").append(e)
                sb.toString()
            }
        }
        log.add(line)
    }

    companion object {
        private const val STATE_IDLE = 0; private const val STATE_PULSE = 1; private const val STATE_GAP_START = 2; private const val STATE_GAP = 3
        private const val MIN_HIGH = 4f; private const val MAX_HIGH = 60000f
    }
}
