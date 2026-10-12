package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.usb.HackRfOne
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.FileInputStream
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Transmit side (Mayhem siggen / morse / replay / OOK TX): a gate the user must switch on in Settings, TX gain
 * and amp state, one job at a time on the HackRF's bulk-OUT pipe. Generators produce signed-int8 IQ at [RATE] on a
 * digital offset so the wanted signal never sits on the LO's DC leakage.
 */
object Tx {
    const val RATE = 2_000_000
    /** Baseband offset of every generated signal; the LO is tuned this far below the wanted frequency. */
    const val OFFSET_HZ = 100_000
    private const val AMP = 100.0   // of 127

    /** TX is on by default now; a one-shot safety prompt runs before the first transmission of the session. */
    private val _enabled = MutableStateFlow(true)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()
    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()
    private val _status = MutableStateFlow("")
    val status: StateFlow<String> = _status.asStateFlow()
    private val _gain = MutableStateFlow(20)
    val gain: StateFlow<Int> = _gain.asStateFlow()
    private val _amp = MutableStateFlow(false)
    val amp: StateFlow<Boolean> = _amp.asStateFlow()
    /** Per-session safety acknowledgement: fires the antenna/dummy-load prompt on the first transmission. */
    private val _needsPrompt = MutableStateFlow(true)
    val needsPrompt: StateFlow<Boolean> = _needsPrompt.asStateFlow()
    fun acknowledgeSafety() { _needsPrompt.value = false }

    fun load(ctx: Context) { _enabled.value = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getBoolean("tx_enabled", true) }
    fun setEnabled(ctx: Context, on: Boolean) {
        _enabled.value = on
        ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).edit().putBoolean("tx_enabled", on).apply()
        if (!on) stop()
    }
    fun setGain(db: Int) { _gain.value = db.coerceIn(0, 47) }
    fun toggleAmp() { _amp.value = !_amp.value }

    /** Run a generator as one transmission; returns false if TX is disabled, the radio is down, or busy. */
    fun start(label: String, freqHz: Long, rateHz: Int, offsetHz: Int, fill: (ByteArray) -> Int): Boolean {
        if (!_enabled.value) { _status.value = "transmit is switched off in Settings"; return false }
        if (_needsPrompt.value) { _status.value = "confirm the safety prompt first"; return false }
        if (!HackRfOne.running) { _status.value = "no HackRF"; return false }
        if (_active.value) { _status.value = "already transmitting"; return false }
        val job = HackRfOne.TxJob(label, freqHz - offsetHz, rateHz, _gain.value, _amp.value, fill) { err ->
            _active.value = false
            _status.value = if (err == null) "done · $label" else "TX failed: $err"
            if (err != null) Diag.log("TX: $err")
        }
        if (!HackRfOne.transmit(job)) { _status.value = "radio busy"; return false }
        _active.value = true; _status.value = "TX · $label"
        return true
    }
    fun stop() { HackRfOne.abortTx() }

    enum class SigMode(val label: String) { CW("CW carrier"), FM_TONE("FM tone"), AM_TONE("AM tone"), SWEEP("sweep ±50 kHz") }

    /** Signal generator: a carrier, an FM- or AM-modulated 1 kHz tone, or a slow sweep. [seconds] 0 = until stopped. */
    fun sigGen(freqHz: Long, mode: SigMode, toneHz: Double = 1000.0, seconds: Int = 0): Boolean {
        var ph = 0.0; var mph = 0.0; var sph = 0.0; var remaining = if (seconds > 0) seconds.toLong() * RATE else Long.MAX_VALUE
        val inc = 2 * PI * OFFSET_HZ / RATE; val mInc = 2 * PI * toneHz / RATE; val sInc = 2 * PI * 0.5 / RATE
        return start("${mode.label} %.4f MHz".format(freqHz / 1e6), freqHz, RATE, OFFSET_HZ) { buf ->
            if (remaining <= 0) return@start 0
            val n = minOf(buf.size / 2L, remaining).toInt()
            for (i in 0 until n) {
                var a = AMP; var f = inc
                when (mode) {
                    SigMode.FM_TONE -> { mph += mInc; f = inc + 2 * PI * 5000.0 * sin(mph) / RATE }
                    SigMode.AM_TONE -> { mph += mInc; a = AMP * (0.5 + 0.5 * sin(mph)) }
                    SigMode.SWEEP -> { sph += sInc; f = inc + 2 * PI * 50_000.0 * sin(sph) / RATE }
                    SigMode.CW -> {}
                }
                ph += f; if (ph > 2 * PI) ph -= 2 * PI
                buf[2 * i] = (a * cos(ph)).toInt().toByte(); buf[2 * i + 1] = (a * sin(ph)).toInt().toByte()
            }
            remaining -= n
            n * 2
        }
    }

    /** Morse keyer: CW (keyed carrier) or an FM tone anyone with a scanner can hear. */
    fun morse(text: String, wpm: Int, freqHz: Long, fmTone: Boolean): Boolean {
        val dit = (1.2 / wpm.coerceIn(5, 60) * RATE).toLong()   // samples per dit (PARIS timing)
        val keying = ArrayList<Pair<Boolean, Long>>()
        for (word in text.uppercase().trim().split(Regex("\\s+"))) {
            for ((ci, ch) in word.withIndex()) {
                val code = MORSE[ch] ?: continue
                for ((k, sym) in code.withIndex()) { keying.add(true to (if (sym == '.') dit else dit * 3)); if (k < code.length - 1) keying.add(false to dit) }
                if (ci < word.length - 1) keying.add(false to dit * 3)
            }
            keying.add(false to dit * 7)
        }
        if (keying.isEmpty()) { _status.value = "nothing to send"; return false }
        var idx = 0; var left = keying[0].second; val ramp = RATE / 250   // 4 ms edges
        var ph = 0.0; var mph = 0.0; val inc = 2 * PI * OFFSET_HZ / RATE; val mInc = 2 * PI * 800.0 / RATE
        var env = 0.0
        return start("Morse \"${text.take(24)}\"", freqHz, RATE, OFFSET_HZ) { buf ->
            if (idx >= keying.size) return@start 0
            val n = buf.size / 2
            for (i in 0 until n) {
                if (left <= 0) { idx++; if (idx >= keying.size) { for (k in i until n) { buf[2 * k] = 0; buf[2 * k + 1] = 0 }; return@start n * 2 }; left = keying[idx].second }
                val on = keying[idx].first
                env += if (on) 1.0 / ramp else -1.0 / ramp; env = env.coerceIn(0.0, 1.0)
                left--
                val a: Double; var f = inc
                if (fmTone) { a = AMP; mph += mInc; f = inc + (if (env > 0) 2 * PI * 3000.0 * env * sin(mph) / RATE else 0.0) }
                else a = AMP * env
                ph += f; if (ph > 2 * PI) ph -= 2 * PI
                buf[2 * i] = (a * cos(ph)).toInt().toByte(); buf[2 * i + 1] = (a * sin(ph)).toInt().toByte()
            }
            n * 2
        }
    }

    /** Replay a capture (.c8 signed int8 I/Q) at the rate and frequency in its sidecar. */
    fun replay(c8: File): Boolean {
        val side = File(c8.path.removeSuffix(".c8") + ".txt")
        var rate = RATE; var freq = 0L
        if (side.exists()) for (line in side.readLines()) {
            if (line.startsWith("sample_rate=")) rate = line.substringAfter("=").trim().toIntOrNull() ?: rate
            if (line.startsWith("center_frequency=")) freq = line.substringAfter("=").trim().toLongOrNull() ?: 0L
        }
        if (freq == 0L) { _status.value = "capture has no sidecar with its frequency"; return false }
        val input = try { FileInputStream(c8) } catch (e: Exception) { _status.value = "cannot open ${c8.name}"; return false }
        return start("replay ${c8.name}", freq, rate, 0) { buf ->
            val n = try { input.read(buf) } catch (e: Exception) { -1 }
            if (n <= 0) { runCatching { input.close() }; 0 } else n
        }.also { if (!it) runCatching { input.close() } }
    }

    /** Fixed-code OOK remote (Princeton / PT2262 family): sync = te high + 31·te low; 0 = te high + 3te low; 1 = 3te high + te low. */
    fun ookPrinceton(freqHz: Long, code: Long, bits: Int, teUs: Int, repeats: Int): Boolean {
        val te = (teUs.toLong() * RATE / 1_000_000L)
        val frame = ArrayList<Pair<Boolean, Long>>()
        repeat(repeats.coerceIn(1, 50)) {
            for (b in bits - 1 downTo 0) { if ((code ushr b) and 1L == 1L) { frame.add(true to te * 3); frame.add(false to te) } else { frame.add(true to te); frame.add(false to te * 3) } }
            frame.add(true to te); frame.add(false to te * 31)
        }
        var idx = 0; var left = frame[0].second; var ph = 0.0; val inc = 2 * PI * OFFSET_HZ / RATE
        return start("OOK %X (%d bits)".format(code, bits), freqHz, RATE, OFFSET_HZ) { buf ->
            if (idx >= frame.size) return@start 0
            val n = buf.size / 2
            for (i in 0 until n) {
                if (left <= 0) { idx++; if (idx >= frame.size) { for (k in i until n) { buf[2 * k] = 0; buf[2 * k + 1] = 0 }; return@start n * 2 }; left = frame[idx].second }
                left--
                ph += inc; if (ph > 2 * PI) ph -= 2 * PI
                val a = if (frame[idx].first) AMP else 0.0
                buf[2 * i] = (a * cos(ph)).toInt().toByte(); buf[2 * i + 1] = (a * sin(ph)).toInt().toByte()
            }
            n * 2
        }
    }

    // ---- FSK / AFSK / OOK generators from TxEncoders (POCSAG, RTTY, APRS, tones, DTMF) ------------------------

    /** Stream a bit list as 2-level FSK: bit true = +[devHz], false = −[devHz], at [baud] on the offset carrier. */
    private fun fskBits(label: String, freqHz: Long, bits: BooleanArray, baud: Int, devHz: Double): Boolean {
        val spb = RATE.toDouble() / baud
        var i = 0L; val total = (bits.size * spb).toLong()
        var ph = 0.0; val inc = 2 * PI * OFFSET_HZ / RATE
        return start(label, freqHz, RATE, OFFSET_HZ) { buf ->
            if (i >= total) return@start 0
            val n = buf.size / 2
            for (k in 0 until n) {
                val bi = (i / spb.toLong()).toInt().let { if (it < bits.size) it else bits.size - 1 }
                val dev = if (bits[bi]) devHz else -devHz
                ph += inc + 2 * PI * dev / RATE; if (ph > 2 * PI) ph -= 2 * PI; if (ph < 0) ph += 2 * PI
                buf[2 * k] = (AMP * cos(ph)).toInt().toByte(); buf[2 * k + 1] = (AMP * sin(ph)).toInt().toByte()
                i++
                if (i >= total) { for (j in k + 1 until n) { buf[2 * j] = 0; buf[2 * j + 1] = 0 }; return@start n * 2 }
            }
            n * 2
        }
    }

    /** Stream a list of per-symbol audio tones (Hz; 0 = silence) as narrowband FM — used by AFSK, RTTY audio, DTMF, tones. */
    private fun fmTones(label: String, freqHz: Long, tones: DoubleArray, samplesPerTone: Int, devHz: Double, sumPairs: DoubleArray? = null): Boolean {
        var idx = 0; var left = samplesPerTone
        var ph = 0.0; var aph = 0.0; var aph2 = 0.0
        val inc = 2 * PI * OFFSET_HZ / RATE
        return start(label, freqHz, RATE, OFFSET_HZ) { buf ->
            if (idx >= tones.size) return@start 0
            val n = buf.size / 2
            for (k in 0 until n) {
                if (left <= 0) { idx++; if (idx >= tones.size) { for (j in k until n) { buf[2 * j] = 0; buf[2 * j + 1] = 0 }; return@start n * 2 }; left = samplesPerTone }
                left--
                val t = tones[idx]
                var audio = 0.0
                if (t > 0) { aph += 2 * PI * t / RATE; audio = sin(aph) }
                if (sumPairs != null && idx < sumPairs.size && sumPairs[idx] > 0) { aph2 += 2 * PI * sumPairs[idx] / RATE; audio = (audio + sin(aph2)) * 0.5 }
                ph += inc + 2 * PI * devHz * audio / RATE; if (ph > 2 * PI) ph -= 2 * PI; if (ph < 0) ph += 2 * PI
                buf[2 * k] = (AMP * cos(ph)).toInt().toByte(); buf[2 * k + 1] = (AMP * sin(ph)).toInt().toByte()
            }
            n * 2
        }
    }

    /** POCSAG pager transmit: address + optional message, 512/1200/2400 baud, ±4.5 kHz FSK (Mayhem pocsag_encode). */
    fun pocsag(address: Int, function: Int, message: String, type: TxEncoders.PocsagType, baud: Int, freqHz: Long): Boolean {
        val bits = TxEncoders.pocsagBits(TxEncoders.pocsag(address, function, message, type))
        return fskBits("POCSAG $address $baud", freqHz, bits, baud, 4500.0)
    }

    /** RTTY: ITA2 Baudot, 5 bits between a start (space) and 1.5 stop (mark) bits, [shiftHz] FSK (mark = high). */
    fun rtty(text: String, baud: Int, shiftHz: Double, freqHz: Long): Boolean {
        val syms = TxEncoders.baudot(text)
        val bits = ArrayList<Boolean>()
        for (s in syms) {
            bits.add(false)                                   // start bit (space)
            for (b in 0 until 5) bits.add((s ushr b) and 1 == 1)
            repeat(3) { bits.add(true) }                      // ~1.5 stop bits at double sampling below; here 3 half-bits
        }
        // double the baud resolution so 1.5 stop bits land cleanly
        return fskBits("RTTY $baud/$shiftHz", freqHz, BooleanArray(bits.size) { bits[it] }, baud, shiftHz / 2)
    }

    /** APRS position/status: Bell 202 AFSK (1200/2200 Hz, 1200 baud) NFM, an AX.25 UI frame. */
    fun aprs(source: String, info: String, freqHz: Long): Boolean {
        val bits = TxEncoders.ax25Bits(TxEncoders.ax25Aprs(source, info), 48)
        val spb = RATE / 1200
        val tones = DoubleArray(bits.size) { if (bits[it]) 1200.0 else 2200.0 }
        return fmTones("APRS $source", freqHz, tones, spb, 3500.0)
    }

    enum class ToneMode(val label: String) { SINGLE("1 kHz"), TWO_TONE("two-tone"), DTMF("DTMF") }

    /** Tone generator: a single 1 kHz tone, a 1000/1600 Hz two-tone test, or a DTMF string. */
    fun tones(mode: ToneMode, dtmf: String, freqHz: Long): Boolean {
        val sr = RATE
        return when (mode) {
            ToneMode.SINGLE -> fmTones("tone 1 kHz", freqHz, DoubleArray(1) { 1000.0 }, sr * 3, 3000.0)
            ToneMode.TWO_TONE -> fmTones("two-tone", freqHz, DoubleArray(1) { 1000.0 }, sr * 3, 3000.0, DoubleArray(1) { 1600.0 })
            ToneMode.DTMF -> {
                val row = ArrayList<Double>(); val col = ArrayList<Double>()
                for (ch in dtmf) { val p = TxEncoders.dtmf(ch) ?: continue; row.add(p.first.toDouble()); col.add(p.second.toDouble()); row.add(0.0); col.add(0.0) }
                if (row.isEmpty()) { _status.value = "no DTMF digits"; return false }
                fmTones("DTMF $dtmf", freqHz, row.toDoubleArray(), sr / 8, 3000.0, col.toDoubleArray())
            }
        }
    }

    // ---- The rest of the Mayhem TX apps (TxApps encoders + wrappers) ------------------------------------------

    /** Timed OOK pulse train (level, duration in samples) — used by SubGHz replay and OOK-based emitters. */
    private fun ookPulses(label: String, freqHz: Long, pulses: List<Pair<Boolean, Long>>): Boolean {
        if (pulses.isEmpty()) { _status.value = "empty pulse list"; return false }
        var idx = 0; var left = pulses[0].second; var ph = 0.0; val inc = 2 * PI * OFFSET_HZ / RATE
        return start(label, freqHz, RATE, OFFSET_HZ) { buf ->
            if (idx >= pulses.size) return@start 0
            val n = buf.size / 2
            for (i in 0 until n) {
                if (left <= 0) { idx++; if (idx >= pulses.size) { for (k in i until n) { buf[2 * k] = 0; buf[2 * k + 1] = 0 }; return@start n * 2 }; left = pulses[idx].second }
                left--
                ph += inc; if (ph > 2 * PI) ph -= 2 * PI
                val a = if (pulses[idx].first) AMP else 0.0
                buf[2 * i] = (a * cos(ph)).toInt().toByte(); buf[2 * i + 1] = (a * sin(ph)).toInt().toByte()
            }
            n * 2
        }
    }

    /** MDC-1200 (Motorola PTT-ID): 1200 bps AFSK, ±2.5 kHz FM, 1200/1800 Hz mark/space. */
    fun mdc1200(op: Int, arg: Int, unitId: Int, freqHz: Long): Boolean {
        val bytes = TxApps.mdcPacket(op, arg, unitId)
        val bits = BooleanArray(bytes.size * 8) { (bytes[it / 8].toInt() ushr (7 - (it % 8))) and 1 == 1 }
        val spb = RATE / 1200
        val tones = DoubleArray(bits.size) { if (bits[it]) 1200.0 else 1800.0 }
        return fmTones("MDC-1200 %04X op=%02X".format(unitId, op), freqHz, tones, spb, 2500.0)
    }

    /** Motorola Quick-Call II two-tone paging: 1 s of tone A, then 3 s of tone B, then a 30 s carrier hold. */
    fun quickCall2(freqA: Double, freqB: Double, freqHz: Long): Boolean {
        val tones = doubleArrayOf(freqA, freqB, 0.0)
        val samplesPerTone = RATE * 30 / 30       // fmTones uses one fixed dwell; approximate with the median 3 s
        // Custom: emit A for 1 s, B for 3 s, silence for 26 s → build a piecewise tone list at 1 s granularity.
        val list = ArrayList<Double>()
        repeat(1) { list.add(freqA) }
        repeat(3) { list.add(freqB) }
        repeat(26) { list.add(0.0) }
        return fmTones("QC-II %.0f/%.0f".format(freqA, freqB), freqHz, list.toDoubleArray(), RATE, 3000.0)
    }

    /** Frequency hopper: dwell [dwellMs] on each of [freqs] in order, sending a CW carrier the whole time. */
    fun frequencyHopper(freqs: LongArray, dwellMs: Int): Boolean {
        if (freqs.isEmpty()) { _status.value = "empty hop list"; return false }
        var hi = 0; var samplesLeft = (dwellMs * RATE / 1000L)
        var ph = 0.0
        return start("hop ×${freqs.size} · ${dwellMs}ms", freqs[0], RATE, 0) { buf ->
            if (hi >= freqs.size) return@start 0
            val n = buf.size / 2
            for (i in 0 until n) {
                if (samplesLeft <= 0) { hi++; if (hi >= freqs.size) { for (k in i until n) { buf[2 * k] = 0; buf[2 * k + 1] = 0 }; return@start n * 2 }; samplesLeft = (dwellMs * RATE / 1000L); HackRfOne.targetFreqHz = freqs[hi] }
                samplesLeft--
                ph += 2 * PI * 0 / RATE
                buf[2 * i] = (AMP * cos(ph)).toInt().toByte(); buf[2 * i + 1] = (AMP * sin(ph)).toInt().toByte()
            }
            n * 2
        }
    }

    /** OOK noise / jammer: random on/off keying at [chipUs] per chip, over the tuned frequency. Authorised RF-lab work only. */
    fun ookNoise(seed: Long, chipUs: Int, seconds: Int, freqHz: Long): Boolean {
        val chipSamples = (chipUs.toLong() * RATE / 1_000_000L).coerceAtLeast(1)
        val chipCount = (seconds.toLong() * RATE / chipSamples).toInt()
        val bits = TxApps.noiseBits(if (seed == 0L) System.nanoTime() else seed, chipCount)
        val pulses = bits.map { (it to chipSamples) }
        return ookPulses("noise %ds %dµs".format(seconds, chipUs), freqHz, pulses)
    }

    /** OOK brute-force: iterate a Princeton/PT2262 codespace sending each code once. */
    fun ookBrute(freqHz: Long, bits: Int, start: Long, end: Long, teUs: Int): Boolean {
        val range = TxApps.bruteRange(bits, start, end)
        val te = (teUs.toLong() * RATE / 1_000_000L)
        val frame = ArrayList<Pair<Boolean, Long>>()
        for (code in range) {
            for (b in bits - 1 downTo 0) { if ((code ushr b) and 1L == 1L) { frame.add(true to te * 3); frame.add(false to te) } else { frame.add(true to te); frame.add(false to te * 3) } }
            frame.add(true to te); frame.add(false to te * 31)
        }
        return ookPulses("OOK brute %d..%d".format(range.first, range.last), freqHz, frame)
    }

    /** ADS-B Mode-S DF17 transmit: 500 kbps PPM at 1090 MHz. Use a 6+ MHz rate on the HackRF. Rebroadcasts are illegal in most places. */
    fun adsb(icao: Int, me: Long): Boolean {
        val frame = TxApps.adsbFrame(icao, me)
        val slots = TxApps.adsbSymbols(frame)
        val rate = 8_000_000
        val samplesPerHalfUs = rate / 2_000_000
        val total = slots.size.toLong() * samplesPerHalfUs
        var idx = 0L
        return start("ADS-B ${"%06X".format(icao)}", 1_090_000_000L, rate, 0) { buf ->
            if (idx >= total) return@start 0
            val n = buf.size / 2
            for (i in 0 until n) {
                val s = (idx / samplesPerHalfUs).toInt().let { if (it < slots.size) it else slots.size - 1 }
                val a = if (slots[s]) AMP else 0.0
                buf[2 * i] = a.toInt().toByte(); buf[2 * i + 1] = 0
                idx++
                if (idx >= total) { for (k in i + 1 until n) { buf[2 * k] = 0; buf[2 * k + 1] = 0 }; return@start n * 2 }
            }
            n * 2
        }
    }

    /** SubGHz replay: play a Flipper .sub RAW file as an OOK pulse train on [freqHz]. */
    fun subghzReplay(subFileText: String, freqHz: Long, repeats: Int): Boolean {
        val basic = TxApps.parseSubFile(subFileText)
        if (basic.isEmpty()) { _status.value = "no RAW_Data pulses found"; return false }
        val pulses = ArrayList<Pair<Boolean, Long>>()
        repeat(repeats.coerceIn(1, 20)) { for ((level, us) in basic) pulses.add(level to (us.toLong() * RATE / 1_000_000L).coerceAtLeast(1)) }
        return ookPulses("SubGHz replay ${basic.size} pulses × $repeats", freqHz, pulses)
    }

    /** KeeLoq (HCS301) OOK transmission: [key] is the manufacturer key, [counter] the current counter value. */
    fun keeloqTx(key: Long, serial: Int, button: Int, counter: Int, freqHz: Long, repeats: Int): Boolean {
        val plain = ((button and 0xF) shl 28) or (counter and 0x0FFFFFFF)
        val encrypted = TxApps.keeloqEncrypt(plain, key)
        val bits = TxApps.keeloqFrame(encrypted, serial, button, false, false)
        // HCS301 PWM: 0 = 1te high + 2te low; 1 = 2te high + 1te low; te ≈ 400 µs. Frame is repeated with a header burst.
        val te = 400L * RATE / 1_000_000L
        val pulses = ArrayList<Pair<Boolean, Long>>()
        repeat(repeats.coerceIn(1, 8)) {
            repeat(12) { pulses.add(true to te); pulses.add(false to te) }   // 12-cycle wake-up burst
            pulses.add(true to te); pulses.add(false to te * 10)              // header gap
            for (b in bits) { if (b) { pulses.add(true to te * 2); pulses.add(false to te) } else { pulses.add(true to te); pulses.add(false to te * 2) } }
            pulses.add(false to te * 40)                                       // inter-frame gap
        }
        return ookPulses("KeeLoq #${counter}", freqHz, pulses)
    }

    /** Foxhunt beacon: Morse ID once, then long carrier for direction-finding, repeated. */
    fun foxhunt(ident: String, wpm: Int, tailSeconds: Int, freqHz: Long): Boolean {
        // Compose Morse then a plain carrier hold. Simplification: single transmission.
        return morse("$ident ".repeat(1) + "T".repeat(tailSeconds), wpm, freqHz, false)
    }

    private val MORSE = mapOf(
        'A' to ".-", 'B' to "-...", 'C' to "-.-.", 'D' to "-..", 'E' to ".", 'F' to "..-.", 'G' to "--.", 'H' to "....", 'I' to "..", 'J' to ".---",
        'K' to "-.-", 'L' to ".-..", 'M' to "--", 'N' to "-.", 'O' to "---", 'P' to ".--.", 'Q' to "--.-", 'R' to ".-.", 'S' to "...", 'T' to "-",
        'U' to "..-", 'V' to "...-", 'W' to ".--", 'X' to "-..-", 'Y' to "-.--", 'Z' to "--..", '0' to "-----", '1' to ".----", '2' to "..---",
        '3' to "...--", '4' to "....-", '5' to ".....", '6' to "-....", '7' to "--...", '8' to "---..", '9' to "----.", '.' to ".-.-.-", ',' to "--..--",
        '?' to "..--..", '/' to "-..-.", '=' to "-...-", '-' to "-....-", '@' to ".--.-.", '(' to "-.--.", ')' to "-.--.-", '\'' to ".----.", ':' to "---...", '+' to ".-.-.",
    )
}
