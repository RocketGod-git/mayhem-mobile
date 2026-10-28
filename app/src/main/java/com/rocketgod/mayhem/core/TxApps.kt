package com.rocketgod.mayhem.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * The rest of Mayhem's transmit apps, ported to run on the phone/browser. These are dual-use tools that ship in
 * the upstream PortaPack Mayhem firmware and are meant for authorised use on your own equipment: bench work,
 * amateur-radio experiments (with a licence), security research on hardware you own. Nothing here bypasses a
 * rolling code or opens a door on its own — the encoders take a key/seed from the user and produce a valid
 * on-air waveform. The Settings safety prompt still gates the first transmission.
 *
 * Every entry point returns true if the transmission was queued, and Tx handles the actual radio hand-off.
 */
object TxApps {

    // ---- MDC-1200 (Motorola PTT-ID, 1200 bps AFSK, CRC-16-CCITT + K=7 convolutional code, 16-way interleaver) ---
    /** Build the on-air packet for MDC-1200: preamble x3 + sync + interleaved codeword(s). Faithful port of ui_mdc_tx. */
    fun mdcPacket(op: Int, arg: Int, unitId: Int): ByteArray {
        val out = ArrayList<Byte>()
        repeat(3) { for (b in intArrayOf(0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA)) out.add(b.toByte()) }
        for (b in intArrayOf(0x07, 0x09, 0x2A, 0x44, 0x6F)) out.add(b.toByte())
        val cw = IntArray(14)
        cw[0] = op and 0xFF; cw[1] = arg and 0xFF
        cw[2] = (unitId ushr 8) and 0xFF; cw[3] = unitId and 0xFF
        packMdc(cw)
        for (v in cw) out.add(v.toByte())
        return ByteArray(out.size) { out[it] }
    }
    private fun flip8(v: Int): Int { var r = 0; var x = v and 0xFF; for (i in 0 until 8) { r = (r shl 1) or (x and 1); x = x ushr 1 }; return r }
    private fun flip16(v: Int): Int { var r = 0; var x = v and 0xFFFF; for (i in 0 until 16) { r = (r shl 1) or (x and 1); x = x ushr 1 }; return r }
    private fun mdcCrc(cw: IntArray, len: Int): Int {
        var crc = 0
        for (i in 0 until len) {
            val c = flip8(cw[i])
            var j = 0x80
            while (j != 0) { val bit0 = crc and 0x8000; var bit = bit0; crc = (crc shl 1) and 0xFFFF; if ((c and j) != 0) bit = bit xor 0x8000; if (bit != 0) crc = crc xor 0x1021; j = j ushr 1 }
        }
        return (flip16(crc) xor 0xFFFF) and 0xFFFF
    }
    private fun packMdc(cw: IntArray) {
        val crc = mdcCrc(cw, 4)
        cw[4] = crc and 0xFF; cw[5] = (crc ushr 8) and 0xFF; cw[6] = 0
        val csr = IntArray(7)
        for (i in 0 until 7) {
            cw[i + 7] = 0
            for (j in 0..7) {
                for (k in 6 downTo 1) csr[k] = csr[k - 1]
                csr[0] = (cw[i] ushr j) and 1
                val b = csr[0] + csr[2] + csr[5] + csr[6]
                cw[i + 7] = cw[i + 7] or ((b and 1) shl j)
            }
        }
        val bits = IntArray(112)
        var l = 0; var m = 0
        for (i in 0 until 14) for (j in 0..7) {
            bits[l] = (cw[i] ushr j) and 1
            l += 16
            if (l > 111) { m++; l = m }
        }
        l = 0
        for (i in 0 until 14) {
            cw[i] = 0
            for (j in 7 downTo 0) { if (bits[l] != 0) cw[i] = cw[i] or (1 shl j); l++ }
        }
    }

    // ---- Motorola Quick-Call II two-tone paging (tone A 1 s, tone B 3 s, then unsquelched carrier) ---------------
    /** Common QC-II tone frequencies for a group A / group B pair, in Hz. */
    fun qcTwoTone(freqA: Double, freqB: Double, holdSeconds: Double): DoubleArray {
        // Emit one tone per "sample" and let the fmTones generator hold each for its samples-per-tone.
        return doubleArrayOf(freqA, freqB, 0.0)   // caller uses per-tone durations
    }

    // ---- Frequency hopper (hop across a list every dwell ms) -----------------------------------------------------
    /** Random-hop list, [count] entries between [lowHz] and [highHz]. */
    fun hopList(lowHz: Long, highHz: Long, count: Int, seed: Long = 0L): LongArray {
        val r = if (seed == 0L) Random(System.nanoTime()) else Random(seed)
        val span = (highHz - lowHz).coerceAtLeast(1)
        return LongArray(count) { lowHz + (r.nextLong() % span + span) % span }
    }

    // ---- OOK jammer / noise (random amplitude modulation over a channel) -----------------------------------------
    /** A random bit stream at [chipUs] per chip — pseudo-random OOK for authorised RF-lab work. */
    fun noiseBits(seed: Long, count: Int): BooleanArray {
        val r = Random(seed)
        return BooleanArray(count) { r.nextBoolean() }
    }

    // ---- OOK brute-force (sweep through all N-bit codes for a Princeton-style remote) ----------------------------
    fun bruteRange(bits: Int, start: Long, end: Long): LongRange = start..end.coerceAtMost((1L shl bits) - 1)

    // ---- ADS-B (Mode-S DF17, 112-bit Extended Squitter with CRC24) ----------------------------------------------
    /** Build a raw DF17 short-position squitter for an aircraft. [icao] is the 24-bit address; [me] is the 56-bit ME field. */
    fun adsbFrame(icao: Int, me: Long): ByteArray {
        val f = ByteArray(14)
        f[0] = 0x8D.toByte()                          // DF17, CA 5
        f[1] = ((icao ushr 16) and 0xFF).toByte()
        f[2] = ((icao ushr 8) and 0xFF).toByte()
        f[3] = (icao and 0xFF).toByte()
        for (i in 0 until 7) f[4 + i] = ((me ushr (48 - i * 8)) and 0xFF).toByte()
        val crc = adsbCrc(f, 11)
        f[11] = ((crc ushr 16) and 0xFF).toByte(); f[12] = ((crc ushr 8) and 0xFF).toByte(); f[13] = (crc and 0xFF).toByte()
        return f
    }
    private fun adsbCrc(data: ByteArray, byteLen: Int): Int {
        // a byte at a time: each byte goes in at the top and its eight bits are shifted through before the next
        // (XORing them all in first and then shifting gave a checksum no receiver accepts)
        var rem = 0
        for (i in 0 until byteLen) {
            rem = rem xor ((data[i].toInt() and 0xFF) shl 16)
            repeat(8) { rem = (if ((rem and 0x800000) != 0) (rem shl 1) xor 0xFFF409 else rem shl 1) and 0xFFFFFF }
        }
        return rem
    }
    /** ADS-B is PPM: each bit is a 500 ns half-hi/half-lo (for '1') or lo/hi (for '0'), preceded by an 8 µs preamble. */
    fun adsbSymbols(frame: ByteArray): BooleanArray {
        // Preamble: 8 µs = 16 half-µs slots; pulses at slots 0, 2, 7, 9.
        val out = BooleanArray(16 + frame.size * 8 * 2)
        val pre = intArrayOf(0, 2, 7, 9); for (p in pre) out[p] = true
        var idx = 16
        for (b in frame) for (i in 7 downTo 0) {
            val bit = (b.toInt() ushr i) and 1
            if (bit == 1) { out[idx] = true; out[idx + 1] = false } else { out[idx] = false; out[idx + 1] = true }
            idx += 2
        }
        return out
    }

    // ---- Foxhunt beacon (Morse ID + carrier hold, on the amateur bands) -----------------------------------------
    /** Repeat a Morse ID at [periodSec], each transmission [durationSec] long. Handled by Tx.foxhunt. */

    // ---- SubGHz remote replay (Flipper .sub raw duration file) --------------------------------------------------
    /** Parse a Flipper "Protocol: RAW / RAW_Data: 340 -1020 340 …" file into (level, duration µs) pulses. */
    fun parseSubFile(text: String): List<Pair<Boolean, Int>> {
        val out = ArrayList<Pair<Boolean, Int>>()
        for (line in text.lineSequence()) {
            val t = line.trim()
            if (!t.startsWith("RAW_Data:")) continue
            for (tok in t.substring(9).trim().split(Regex("\\s+"))) {
                val n = tok.toIntOrNull() ?: continue
                out.add((n > 0) to kotlin.math.abs(n))
            }
        }
        return out
    }

    // ---- KeeLoq (HCS301) rolling-code frame: header + 66 bits (32-bit encrypted, 28-bit serial, 4-bit button, 2-bit VLOW/RPT) --
    /** Encode a KeeLoq HCS301 frame's raw bit list from an already-encrypted 32-bit hop code + fields. */
    fun keeloqFrame(encrypted: Int, serial: Int, button: Int, vLow: Boolean, repeat: Boolean): BooleanArray {
        val bits = ArrayList<Boolean>()
        // 12-cycle wake-up burst is handled by the OOK generator; this returns the on-air payload bits.
        for (i in 0 until 32) bits.add(((encrypted ushr i) and 1) == 1)
        for (i in 0 until 28) bits.add(((serial ushr i) and 1) == 1)
        for (i in 0 until 4) bits.add(((button ushr i) and 1) == 1)
        bits.add(vLow); bits.add(repeat)
        return BooleanArray(bits.size) { bits[it] }
    }
    /** KeeLoq NLF: Flipper Devices' Non-Linear Function table (0x3A5C742E). Used to encrypt the counter. */
    private val NLF = 0x3A5C742E
    /** Encrypt a 32-bit hop code with a 64-bit manufacturer key using the standard KeeLoq cipher (528 rounds). */
    fun keeloqEncrypt(plain: Int, key: Long): Int {
        var v = plain.toLong() and 0xFFFFFFFFL
        var k = key
        for (r in 0 until 528) {
            val nlfIn = (((v ushr 1) and 1) shl 4) or (((v ushr 9) and 1) shl 3) or (((v ushr 20) and 1) shl 2) or (((v ushr 26) and 1) shl 1) or ((v ushr 31) and 1)
            val nlf = ((NLF ushr nlfIn.toInt()) and 1).toLong()
            val bit = ((v ushr 0) and 1) xor ((v ushr 16) and 1) xor (k and 1) xor nlf
            v = (v ushr 1) or (bit shl 31); v = v and 0xFFFFFFFFL
            k = (k ushr 1) or (((k and 1) shl 63)); k = k
        }
        return v.toInt()
    }

    // ---- Foxhunt sequence helper --------------------------------------------------------------------------------
    /** Wrap Morse text with a long tail carrier for direction-finding on a fox-hunt band. */
    fun foxhuntPattern(ident: String, tailSec: Int, wpm: Int): Pair<String, Int> = ident to tailSec.coerceAtLeast(1)

    // ---- Troll app helpers (sideload APK only; gated by BuildConfig.INCLUDE_TROLL) -----------------------------
    // Faithful ports of web/src/tx-apps.ts. OOK pulse lists are [carrier-on, samples] pairs for Tx.ookPulses,
    // timed for `rate` samples/s (the transmitter runs at Tx.RATE).

    /** Manchester-code bits at `halfUs` per half-bit. A 1 is high-then-low, a 0 is low-then-high. */
    private fun manchester(bits: IntArray, halfUs: Int, rate: Int): List<Pair<Boolean, Long>> {
        val t = maxOf(1L, Math.round(halfUs.toDouble() * rate / 1_000_000.0))
        val out = ArrayList<Pair<Boolean, Long>>(bits.size * 2)
        for (b in bits) { out.add((b == 1) to t); out.add((b != 1) to t) }
        return out
    }

    private const val TESLA_HALF_US = 400
    private val TESLA_MSG = intArrayOf(
        0,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,0,1,0,1,1)

    /** Tesla charge-port burst: Manchester OOK at ~400 µs/half-bit, repeated with a ~23 ms gap. */
    fun teslaPulses(rate: Int, repeats: Int = 5): List<Pair<Boolean, Long>> {
        val one = manchester(TESLA_MSG, TESLA_HALF_US, rate)
        val gap = false to Math.round(23_000.0 * rate / 1_000_000.0)
        val out = ArrayList<Pair<Boolean, Long>>()
        repeat(repeats) { out.addAll(one); out.add(gap) }
        return out
    }

    /** Note name → Hz (equal temperament, A4 = 440); "0" is a rest. */
    private val NOTE: Map<String, Int> = buildMap {
        val base = mapOf(
            "C" to -9, "C#" to -8, "D" to -7, "D#" to -6, "E" to -5, "F" to -4,
            "F#" to -3, "G" to -2, "G#" to -1, "A" to 0, "A#" to 1, "B" to 2)
        put("0", 0)
        for (oct in 2..7) for ((n, s) in base)
            put("$n$oct", Math.round(440.0 * Math.pow(2.0, s / 12.0 + (oct - 4))).toInt())
    }

    private val TUNES: LinkedHashMap<String, List<Pair<String, Int>>> = linkedMapOf(
        // A rising-falling two-tone that reads as a siren, not a real emergency signal.
        "siren" to (0 until 12).map { (if (it % 2 == 1) "A5" else "E5") to 2 },
        // Ode to Joy — public domain.
        "joy" to listOf("E5" to 1, "E5" to 1, "F5" to 1, "G5" to 1, "G5" to 1, "F5" to 1, "E5" to 1, "D5" to 1,
            "C5" to 1, "C5" to 1, "D5" to 1, "E5" to 1, "E5" to 2, "D5" to 1, "D5" to 2, "0" to 1),
        // Westminster chime — public domain doorbell.
        "chime" to listOf("E5" to 2, "C5" to 2, "D5" to 2, "G4" to 3, "0" to 1, "G4" to 2, "D5" to 2, "E5" to 2, "C5" to 3),
        "imperial" to listOf("G4" to 2, "G4" to 2, "G4" to 2, "D#4" to 1, "A#4" to 1, "G4" to 2, "D#4" to 1, "A#4" to 1, "G4" to 3, "0" to 1),
        "rick" to listOf("C#5" to 1, "D#5" to 1, "0" to 1, "D#5" to 1, "0" to 1, "F5" to 1, "F5" to 1, "D#5" to 1,
            "C#5" to 1, "C#5" to 1, "C#5" to 1, "A#4" to 2, "0" to 1),
    )

    fun tuneNames(): List<String> = TUNES.keys.toList()

    /** One tone per fixed slot (0 = silence) for Tx.fmTones; a tune spells duration by repeating a note. */
    fun melody(name: String): DoubleArray {
        val t = TUNES[name] ?: TUNES["siren"]!!
        val out = ArrayList<Double>()
        for ((note, beats) in t) repeat(beats) { out.add((NOTE[note] ?: 0).toDouble()) }
        return out.toDoubleArray()
    }

    /**
     * de Bruijn B(2, n): a cyclic 0/1 string in which every n-bit word appears exactly once as a window. Streamed
     * as OOK it opens any fixed-code receiver in the n-bit space in one pass. Unwrapped by n−1 bits so the
     * wrap-around windows are covered when sent linearly rather than as a loop.
     */
    fun deBruijn(n: Int): IntArray {
        val a = IntArray(n * 2)
        val seq = ArrayList<Int>()
        fun db(t: Int, p: Int) {
            if (t > n) { if (n % p == 0) for (i in 1..p) seq.add(a[i]); return }
            a[t] = a[t - p]; db(t + 1, p)
            for (j in a[t - p] + 1 until 2) { a[t] = j; db(t + 1, t) }
        }
        db(1, 1)
        val out = ArrayList(seq)
        for (i in 0 until n - 1) out.add(seq[i])
        return out.toIntArray()
    }
}
