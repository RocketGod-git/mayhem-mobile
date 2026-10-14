package com.rocketgod.mayhem.core

/**
 * TRANSMIT encoder for a spoofed 433.92 MHz weather sensor — a harmless novelty transmitter for the "Troll"
 * app, of the kind Mayhem / Flipper firmware ship. It builds a valid OOK frame that the app's OWN rtl_433
 * decoder (r433 Acurite device) reads back as a real reading, so an indoor weather display tuned to that
 * sensor shows a phantom channel with whatever temperature and humidity you pick.
 *
 * Faithful port of web/src/dsp/tx-weather.ts. Targets the Acurite 592TXR / "Acurite-Tower" temp+humidity
 * sensor — rtl_433 protocol number 40, message type 0x04: seven bytes, a plain byte-sum check in the last
 * byte, even parity in the top bit of each data byte. No LFSR digest, no CRC, no bit reversal.
 *
 * This object does NOT import from the decoder. The two integrity primitives it needs (a byte sum and a byte
 * parity) are duplicated here; the sibling web round-trip test guards against drift between encoder/decoder.
 */
object TxWeather {

    /** The rtl_433 model string this encoder targets, as the decoder emits it. */
    const val WEATHER_MODEL = "Acurite-Tower"
    /** Its rtl_433 protocol number. */
    const val WEATHER_PROTOCOL = 40
    /** The band the sensor family lives on. */
    const val WEATHER_FREQ_HZ = 433_920_000L

    // --- Encoding limits, from the r433 Acurite decoder (towerDecode + txrCheck). ---
    private const val TEMP_MIN_C = -40.0   // towerDecode rejects below this
    private const val TEMP_MAX_C = 70.0    // ...or above this
    private const val TEMP_OFFSET = 1000   // tempC = (raw - 1000) * 0.1, so raw = round(tempC * 10) + 1000
    private const val TEMP_STEP = 10       // tenths of a degree per count
    private const val HUM_MAX = 100        // humidity > 100 is rejected unless it is exactly 127
    private const val HUM_NONE = 127       // 127 means "no humidity element"; the decoder omits humidity then
    private const val MSG_TOWER = 0x04     // message type in the low six bits of byte 2
    private const val BATTERY_OK = 0x40    // byte 2 bit 6 set = battery good

    /** Two-bit channel selector in the top of byte 0. Decoder table is ['C','E','B','A']; 01 ('E') is an error. */
    private val CHANNEL_CODE = mapOf(1 to 0b11 /* A */, 2 to 0b10 /* B */, 3 to 0b00 /* C */)

    private fun clamp(v: Double, lo: Double, hi: Double) = if (v < lo) lo else if (v > hi) hi else v
    private fun clampI(v: Int, lo: Int, hi: Int) = if (v < lo) lo else if (v > hi) hi else v

    /** Parity of a byte: 1 when an odd number of bits are set. Mirrors r433 util.parity8. */
    private fun parity8(b: Int): Int {
        val x = (b xor (b shr 4)) and 0x0f
        return (0x6996 shr x) and 1
    }

    /**
     * Build the seven message bytes (checksum and parity included) exactly as towerDecode reads them back.
     * Temperature is offset so every in-range value is a positive count; -40..70 °C all fit.
     */
    fun weatherFrame(tempC: Double, humidity: Int? = null, id: Int = 0x0abc, channel: Int = 1, battery: Boolean = true): IntArray {
        val idc = clampI(id, 0, 0x3fff)
        val chan = CHANNEL_CODE[channel] ?: CHANNEL_CODE[1]!!

        val tc = clamp(tempC, TEMP_MIN_C, TEMP_MAX_C)
        val tempRaw = Math.round(tc * TEMP_STEP).toInt() + TEMP_OFFSET   // 14-bit count, split 7 + 7 across bytes 4,5

        val hum = if (humidity == null) HUM_NONE else clampI(humidity, 0, HUM_MAX)
        val bat = if (battery) BATTERY_OK else 0

        val bb = intArrayOf(
            (chan shl 6) or ((idc shr 8) and 0x3f),
            idc and 0xff,
            bat or MSG_TOWER,
            hum and 0x7f,
            (tempRaw shr 7) and 0x7f,
            tempRaw and 0x7f,
            0,
        )

        // Even parity in the top bit of each data byte (2..5), then the byte-sum check over bytes 0..5.
        for (i in 2..5) if (parity8(bb[i]) == 1) bb[i] = bb[i] or 0x80
        var sum = 0
        for (i in 0 until 6) sum += bb[i]
        bb[6] = sum and 0xff
        return bb
    }

    // --- OOK pulse timing, from the r433 acuriteTxr device. A logical 1 is the LONG mark, 0 the SHORT mark. ---
    private const val SYNC_MARK_US = 620
    private const val SYNC_GAP_US = 596
    private const val SHORT_MARK_US = 220   // logical 0
    private const val LONG_MARK_US = 408    // logical 1
    private const val SHORT_GAP_US = 204    // the gap after a long mark
    private const val LONG_GAP_US = 392     // the gap after a short mark
    private const val INTER_FRAME_GAP_US = 2192
    private const val NUM_SYNC = 4
    private const val REPEATS = 3           // the real sensor repeats; a receiver needs only one clean copy

    /**
     * The frame as OOK pulses for Tx.ookPulses: [carrier-on, samples] pairs timed for `rate` samples/s. The
     * frame is sent REPEATS times, each copy opened by four sync marks and closed by a long inter-frame gap.
     */
    fun weatherPulses(tempC: Double, humidity: Int?, rate: Int): List<Pair<Boolean, Long>> {
        fun us(t: Int): Long = Math.round(t.toDouble() * rate / 1e6)
        val bytes = weatherFrame(tempC, humidity)

        val bits = ArrayList<Int>(bytes.size * 8)
        for (b in bytes) for (i in 7 downTo 0) bits.add((b shr i) and 1)

        val out = ArrayList<Pair<Boolean, Long>>()
        repeat(REPEATS) {
            repeat(NUM_SYNC) {
                out.add(true to us(SYNC_MARK_US))
                out.add(false to us(SYNC_GAP_US))
            }
            for (bit in bits) {
                if (bit == 1) { out.add(true to us(LONG_MARK_US)); out.add(false to us(SHORT_GAP_US)) }
                else { out.add(true to us(SHORT_MARK_US)); out.add(false to us(LONG_GAP_US)) }
            }
            out.add(false to us(INTER_FRAME_GAP_US))   // separates this copy from the next
        }
        return out
    }
}
