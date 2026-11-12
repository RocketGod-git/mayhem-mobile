package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.apps.ism.CarFields
import com.rocketgod.mayhem.core.apps.ism.FProto
import com.rocketgod.mayhem.core.apps.ism.Fam
import com.rocketgod.mayhem.core.apps.ism.IsmProtos
import com.rocketgod.mayhem.core.apps.ism.RemoteFields
import com.rocketgod.mayhem.core.apps.ism.WeatherFields
import com.rocketgod.mayhem.core.apps.ism.pirate.PPDecoder
import com.rocketgod.mayhem.core.apps.ism.pirate.PPHit
import com.rocketgod.mayhem.core.apps.ism.pirate.PPProtos
import java.util.Locale
import kotlin.math.min

/*
 * Car keys, gate and garage remotes, and Mayhem's weather sensors, read from one tuned channel. Twin of
 * web/src/dsp/r433/keys.ts.
 *
 * These decoders (Mayhem's subghzd protocols and ProtoPirate's car keys) want a plain list of levels and how long
 * each lasted. The slicer below makes two such lists from a channel's envelope and discriminator: one for the
 * carrier going on and off, one for the frequency going high and low while the carrier is up. Each decoder reads
 * the list that matches how its device transmits; the frequency-keyed car keys read both polarities, since which
 * tone a fob calls "high" varies.
 */

/** What a key, remote or sensor said, ready to list. */
data class KeyReading(
    /** "key", "remote" or "weather". */
    val family: String,
    val model: String,
    /** The transmitter's own identity, when it has one (serial, ID). Empty when it does not. */
    val id: String,
    /** Everything else decoded, in order, as label and value. */
    val fields: List<Pair<String, String>>,
    /** The frame as received, hex, for de-duplication and the detail card. */
    val raw: String,
    val bits: Int,
)

/**
 * A carrier's first samples are held back until both of its tones have shown up (or this many have gone by, 2 ms
 * at 250 kHz): only then is the middle between them known, and the held samples are read against it, so the
 * opening of the preamble is not lost however long its first symbol is.
 */
private const val SETTLE_MAX = 512
/** Less shift than this (in discriminator units, about 2 kHz at 250 kHz) is a plain carrier, not two tones. */
private const val MIN_SPREAD = 500
/** How many samples late the smoothed envelope says a carrier came up. */
private const val LAG = 5
private const val RECENT = 32

/** An unsigned value as upper-case hex, no padding. */
private fun hex(v: Long): String = java.lang.Long.toHexString(v).uppercase(Locale.US)

/**
 * Levels and durations from one channel. A carrier is present while the envelope stands about ten decibels over
 * the noise (seven to let go, so a dip does not chop a mark in two); while it is, the frequency is "high" above
 * its own running middle, which tracks wherever in the channel the transmitter actually sits.
 */
class KeySlicer(private val onOok: (Boolean, Int) -> Unit, private val onFsk: (Boolean, Int) -> Unit) {
    private var usPer = 4.0
    private var noise = 0.0; private var noiseN = 0
    private var on = false; private var fmHi = 0.0; private var fmLo = 0.0; private var bufHi = 0.0; private var away = 0; private var skip = 0
    private val recent = DoubleArray(RECENT); private var recentAt = 0
    private val settle = DoubleArray(SETTLE_MAX + RECENT); private var settleN = 0; private var settled = true
    private var ookLvl = false; private var ookRun = 0
    private var fmLvl = false; private var fmRun = 0

    private fun us(run: Int): Int = Math.round(run * usPer).toInt()

    fun reset(rate: Double) {
        usPer = 1e6 / rate
        noise = 0.0; noiseN = 0; on = false; fmHi = 0.0; fmLo = 0.0
        recent.fill(0.0); recentAt = 0; settleN = 0; settled = true
        ookLvl = false; ookRun = 0; fmLvl = false; fmRun = 0
    }

    fun process(env: ShortArray, fm: ShortArray, n: Int) {
        val recent = recent
        for (i in 0 until n) {
            val e = env[i].toDouble(); val f = fm[i].toDouble()
            recent[recentAt] = f; recentAt = (recentAt + 1) and (RECENT - 1)
            if (!on) {
                // the noise level, settled quickly at first and slowly after
                noiseN++
                noise += (e - noise) / (if (noiseN < 256) noiseN else 256)
            }
            if (!on && noiseN > 64 && e > noise * 3.2) {
                on = true
                // The envelope is smoothed, so it crosses the line a few samples after the carrier really came up: those
                // samples belong to the mark, in both streams, and they start the frequency's settling.
                val back = min(LAG, min(if (ookLvl) 0 else ookRun - 1, fmRun - 1))
                if (ookRun - back > 0) onOok(false, us(ookRun - back))
                ookLvl = true; ookRun = back
                fmRun -= back
                settleN = 0; bufHi = 0.0; away = 0
                for (k in back downTo 1) settle[settleN++] = recent[(recentAt - 1 - k + RECENT * 2) and (RECENT - 1)]
                skip = settleN + 3
                settled = false
            } else if (on && e < noise * 2.2) on = false
            val up = on
            if (up == ookLvl) ookRun++
            else { onOok(ookLvl, us(ookRun)); ookLvl = up; ookRun = 1 }
            // The first few samples of a carrier only settle the middle and the size of the shift; once they have, they
            // are read with the rest, so none of the mark is lost to it.
            if (up && !settled) {
                hold(f)
                if (settleN >= SETTLE_MAX || away >= 4) release()
                continue
            }
            if (!up && !settled && settleN > 0) release()
            fsk(f, up)
        }
    }

    private fun hold(f: Double) {
        settle[settleN++] = f
        // Skipping the backdated samples and the first few after them, while the discriminator swings in from the
        // noise: the first tone is the running average of what is held; the second has arrived once the frequency
        // has stood well away from it for several samples running.
        val k = settleN - skip
        if (k <= 0) return
        if (k <= 8) { bufHi += (f - bufHi) / k; return }
        if (kotlin.math.abs(f - bufHi) > MIN_SPREAD * 2) away++
        else { away = 0; bufHi += (f - bufHi) / k }
    }

    /** Both tones are in (or it is a plain carrier): set the extremes from the held samples, then read them in order. */
    private fun release() {
        val s = settle; val len = settleN
        // the two tones: the average of the held samples on each side of the middle between the first tone and the
        // newest samples (a plain carrier has only the one)
        val from = min(skip, len - 1)
        val second = if (away >= 4) (s[len - 1] + s[len - 2] + s[len - 3] + s[len - 4]) / 4 else bufHi
        val t = (bufHi + second) / 2
        var hi = 0.0; var nh = 0; var lo = 0.0; var nl = 0
        for (i in from until len) { if (s[i] > t) { hi += s[i]; nh++ } else { lo += s[i]; nl++ } }
        fmHi = if (nh != 0) hi / nh else t; fmLo = if (nl != 0) lo / nl else t
        away = 0; bufHi = 0.0
        // the backdated and first few samples are the carrier coming up through the noise: they read as the first clean one
        for (i in 0 until from) s[i] = s[from]
        settled = true
        for (i in 0 until len) fsk(s[i], true)
        settleN = 0
    }

    /**
     * One sample of the frequency stream. The two tones are tracked as a high and a low that jump quickly to a new
     * extreme and relax slowly; the level is high above the middle between them, and flips only once the
     * frequency is well past it, so noise riding on one tone cannot flicker it.
     */
    private fun fsk(f: Double, on: Boolean) {
        var l = false
        if (on) {
            fmHi += (f - fmHi) * (if (f > fmHi) 0.25 else 1.0 / 256)
            fmLo += (f - fmLo) * (if (f < fmLo) 0.25 else 1.0 / 256)
            val spread = fmHi - fmLo; val mid = (fmHi + fmLo) / 2; val h = spread * 0.15
            l = if (spread < MIN_SPREAD) false else if (f > mid + h) true else if (f < mid - h) false else fmLvl
        }
        if (l == fmLvl) fmRun++
        else { onFsk(fmLvl, us(fmRun)); fmLvl = l; fmRun = 1 }
    }

    /** End whatever is in flight with a long silence, so every decoder finishes its frame. */
    fun flush() {
        if (ookRun != 0) onOok(ookLvl, us(ookRun))
        if (fmRun != 0) onFsk(fmLvl, us(fmRun))
        onOok(false, 50_000); onFsk(false, 50_000)
        ookLvl = false; ookRun = 0; fmLvl = false; fmRun = 0; on = false
    }
}

/** One full set of decoders, fed by one slicer. */
class KeyDecoders(private val onReading: (KeyReading) -> Unit) {
    private val protos: List<FProto> = IsmProtos.all()
    private val pirAm: List<PPDecoder>
    private val pirFm: List<PPDecoder>
    private val pirFmInv: List<PPDecoder>
    val slicer: KeySlicer

    init {
        for (p in protos) p.callback = { q -> onHit(q) }
        val pp = PPProtos.all()
        pirAm = pp.first; pirFm = pp.second; pirFmInv = PPProtos.all().second
        for (p in pirAm + pirFm + pirFmInv) p.onHit = { h -> onPirate(h) }
        slicer = KeySlicer(
            { l, us -> for (p in protos) p.feed(l, us); for (p in pirAm) p.feed(l, us) },
            { l, us -> for (p in pirFm) p.feed(l, us); for (p in pirFmInv) p.feed(!l, us) })
    }

    /**
     * A new burst on a fresh channel: every car-key decoder starts clean. ProtoPirate's own "same frame as last
     * time" filter is for repeats within one transmission; across bursts, repeats are merged by the receiver.
     */
    fun reset() { for (p in pirAm) p.reset(); for (p in pirFm) p.reset(); for (p in pirFmInv) p.reset() }

    private fun onPirate(h: PPHit) {
        val fields = ArrayList<Pair<String, String>>()
        if (!h.btn.isNullOrEmpty()) fields.add("BUTTON" to h.btn)
        if (h.cnt != null) fields.add("COUNTER" to h.cnt.toString())
        for (f in h.fields) fields.add(f.name.uppercase(Locale.US) to f.value)
        onReading(KeyReading("key", h.name, h.serial?.let { hex(it) } ?: "", fields, h.key, h.bits))
    }

    /** "LABEL value" notes from the field decoders become label and value; anything else is a NOTE. */
    private fun extra(fields: MutableList<Pair<String, String>>, extra: List<String>) {
        for (e in extra) { val i = e.indexOf(' '); fields.add(if (i > 0) e.substring(0, i).uppercase(Locale.US) to e.substring(i + 1) else "NOTE" to e) }
    }

    private fun onHit(p: FProto) {
        val raw = hex(p.decodeData) + (if (p.decodeData2 != 0L) hex(p.decodeData2) else "")
        when (p.family) {
            Fam.WEATHER -> {
                val w = WeatherFields.parse(p.sensorType, p.decodeData)
                val fields = ArrayList<Pair<String, String>>()
                w.temp?.let { t -> fields.add("TEMPERATURE" to String.format(Locale.US, "%.1f °C · %.1f °F", t.toDouble(), t.toDouble() * 9 / 5 + 32)) }
                w.humidity?.let { fields.add("HUMIDITY" to "$it%") }
                w.channel?.let { fields.add("CHANNEL" to it.toString()) }
                w.batteryLow?.let { fields.add("BATTERY" to if (it) "low" else "OK") }
                onReading(KeyReading("weather", w.name, w.id.toString(), fields, raw, p.dataCountBit))
            }
            Fam.REMOTE -> {
                val r = RemoteFields.parse(p.sensorType, p.decodeData, p.dataCountBit)
                val fields = ArrayList<Pair<String, String>>()
                r.btn?.let { fields.add("BUTTON" to it.toString()) }
                r.cnt?.let { fields.add("COUNTER" to it.toString()) }
                extra(fields, r.extra)
                onReading(KeyReading("remote", r.name, if (r.serial != 0L) hex(r.serial) else "", fields, raw, p.dataCountBit))
            }
            else -> {
                val c = CarFields.parse(p.sensorType, p.decodeData, p.decodeData2, p.dataCountBit)
                val fields = ArrayList<Pair<String, String>>()
                if (c.btn.isNotEmpty()) fields.add("BUTTON" to c.btn)
                c.cnt?.let { fields.add("COUNTER" to it.toString()) }
                extra(fields, c.extra)
                onReading(KeyReading("key", c.name, hex(c.serial), fields, raw, p.dataCountBit))
            }
        }
    }
}
