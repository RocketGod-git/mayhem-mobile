package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * ACARS receiver (Mayhem proc_acars / acars_app, decoding after acarsdec): the VHF channel is AM, carrying a
 * 2400 bps MSK audio signal (1200 / 2400 Hz tones). Raw IQ → envelope → mix the audio against 1800 Hz → the
 * sign of the instantaneous frequency is the chip → 2400 baud clock → bytes LSB-first with odd parity →
 * SYN SYN SOH framing → mode / registration / label / block id / message number / flight / text, CRC-16 checked.
 */
class AcarsDecoder(private val log: PacketLog) : IqProcessor {
    private val dcI = 127.4f; private val dcQ = 127.4f
    private var dec1 = 41; private var accI = 0f; private var accQ = 0f; private var accN = 0
    private var envDc = 0f; private var env4 = 0f; private var env4n = 0
    private var fs = 12_195.0; private var ph = 0.0; private var phInc = 0.0
    private var lpI = 0f; private var lpQ = 0f; private var pI = 0f; private var pQ = 0f; private var bI = 0f; private var bQ = 0f
    private var mfI = FloatArray(5); private var mfQ = FloatArray(5); private var mfPos = 0; private var mfSumI = 0f; private var mfSumQ = 0f
    private var sync = BitSync(2400.0, fs)
    // framing
    private var window = 0L; private var collecting = false; private var polarity = 0
    private var byte = 0; private var nBits = 0
    private val bytes = IntArray(300); private var count = 0; private var parityErrors = 0
    private var crcBytes = 0; private var crcHi = 0; private var crcLo = 0; private var inCrc = false

    override fun reset(rate: Int) {
        dec1 = (rate / 48_000).coerceAtLeast(1)
        fs = rate.toDouble() / dec1 / 4
        phInc = 2 * Math.PI * 1800.0 / fs
        sync = BitSync(2400.0, fs)
        val mfLen = Math.round(fs / 2400.0).toInt().coerceAtLeast(2)
        mfI = FloatArray(mfLen); mfQ = FloatArray(mfLen); mfPos = 0; mfSumI = 0f; mfSumQ = 0f
        accI = 0f; accQ = 0f; accN = 0; env4 = 0f; env4n = 0; lpI = 0f; lpQ = 0f; pI = 0f; pQ = 0f
        collecting = false; window = 0L; nBits = 0; byte = 0; count = 0
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        // No DC tracking here: an AM carrier on the tuned frequency IS a DC term. The HackRF's own DC offset only
        // adds a constant to the envelope, which the envelope DC block removes.
        val nSamp = len / 2
        for (i in 0 until nSamp) {
            accI += (iq[2 * i].toInt() and 0xff) - dcI
            accQ += (iq[2 * i + 1].toInt() and 0xff) - dcQ
            if (++accN < dec1) continue
            val ci = accI / accN; val cq = accQ / accN; accI = 0f; accQ = 0f; accN = 0
            val env = sqrt(ci * ci + cq * cq)
            envDc += 0.002f * (env - envDc)
            env4 += env - envDc
            if (++env4n < 4) continue
            val a = env4 / 4; env4 = 0f; env4n = 0
            audio(a)
        }
    }

    private fun audio(a: Float) {
        ph += phInc; if (ph > 2 * Math.PI) ph -= 2 * Math.PI
        val mi = a * cos(ph).toFloat(); val mq = -a * sin(ph).toFloat()
        // one-bit moving average (matched filter): passes the ±600 Hz tones, nulls the mixing images near −3 / −4.2 kHz
        mfSumI += mi - mfI[mfPos]; mfSumQ += mq - mfQ[mfPos]; mfI[mfPos] = mi; mfQ[mfPos] = mq; if (++mfPos >= mfI.size) mfPos = 0
        lpI = mfSumI; lpQ = mfSumQ
        val f = lpQ * pI - lpI * pQ           // per-sample frequency sign (+ = 2400 Hz, − = 1200 Hz): drives the bit clock
        pI = lpI; pQ = lpQ
        if (sync.push(f) >= 0) {
            // Bit decision at the clock tick: MSK advances the phase ±90° per bit, so the sign of the phase step
            // between this bit's filter output and the previous one is the bit (acarsdec's differential decision).
            val step = lpQ * bI - lpI * bQ
            bI = lpI; bQ = lpQ
            onBit(if (step > 0f) 1 else 0)
        }
    }

    private fun onBit(raw: Int) {
        if (!collecting) {
            window = ((window shl 1) or raw.toLong()) and 0xFFFFFF
            val v = window.toInt()
            if (lsbFirst3(v) == SYNC) { collecting = true; polarity = 0; nBits = 0; byte = 0; count = 0; parityErrors = 0; inCrc = false; crcBytes = 0 }
            else if (lsbFirst3(v.inv() and 0xFFFFFF) == SYNC) { collecting = true; polarity = 1; nBits = 0; byte = 0; count = 0; parityErrors = 0; inCrc = false; crcBytes = 0 }
            return
        }
        val bit = raw xor polarity
        byte = byte or (bit shl nBits)
        if (++nBits < 8) return
        val b = byte; byte = 0; nBits = 0
        if (inCrc) {
            if (crcBytes == 0) { crcHi = b; crcBytes = 1; return }
            crcLo = b; finish(); return
        }
        if (Integer.bitCount(b) % 2 == 0) { if (++parityErrors > 4) { collecting = false; window = 0L; return } }
        val ch = b and 0x7f
        bytes[count++] = ch
        if (ch == ETX || ch == ETB) { inCrc = true; crcBytes = 0; return }
        if (count >= bytes.size) { collecting = false; window = 0L }
    }

    /** Three bytes received LSB-first from a 24-bit window: value of (first byte, second, third). */
    private fun lsbFirst3(w: Int): Int {
        var out = 0
        for (k in 0 until 3) {
            var b = 0
            for (i in 0 until 8) b = b or (((w ushr (23 - (k * 8 + i))) and 1) shl i)
            out = (out shl 8) or b
        }
        return out
    }

    private fun finish() {
        collecting = false; window = 0L
        val n = count
        val ok = crcOk(n)
        val text = StringBuilder()
        val mode = bytes[0].toChar()
        if (n < 13) return
        val reg = (1..7).map { bytes[it].toChar() }.joinToString("").trim('.', ' ')
        val ack = bytes[8].toChar()
        val label = "%c%c".format(bytes[9].toChar(), if (bytes[10] == 0x7f) 'd' else bytes[10].toChar())
        val blk = bytes[11].toChar()
        var p = 12
        val down = blk in '0'..'9'
        var msn = ""; var flight = ""
        if (bytes[p] == STX) {
            p++
            if (down && n - p >= 11) { msn = (0 until 4).map { bytes[p + it].toChar() }.joinToString(""); flight = (4 until 10).map { bytes[p + it].toChar() }.joinToString("").trim(); p += 10 }
        }
        while (p < n) { val c = bytes[p++]; if (c == ETX || c == ETB) break; text.append(if (c in 0x20..0x7e) c.toChar() else if (c == 0x0a || c == 0x0d) ' ' else '·') }
        val arrow = if (down) "↓" else "↑"
        val head = "ACARS $arrow $reg  $label  blk $blk  ack ${if (ack == 0x15.toChar()) "NAK" else ack.toString()}${if (msn.isNotEmpty()) "  #$msn $flight" else ""}${if (ok) "" else "  CRC?"}${if (mode != '2') "  mode $mode" else ""}"
        val body = text.toString().trim()
        log.add(if (body.isEmpty()) head else "$head\n$body")
    }

    /** CRC-16/CCITT over mode … ETX. Accepts either bit order and either CRC byte order (implementations differ). */
    private fun crcOk(n: Int): Boolean {
        var crc = 0
        for (i in 0 until n) {
            crc = crc xor (bytes[i] shl 8)
            for (k in 0 until 8) crc = if ((crc and 0x8000) != 0) ((crc shl 1) xor 0x1021) and 0xffff else (crc shl 1) and 0xffff
        }
        val rx1 = (crcHi shl 8) or crcLo; val rx2 = (crcLo shl 8) or crcHi
        if (crc == rx1 || crc == rx2) return true
        var r = 0
        for (i in 0 until n) { var v = bytes[i]; for (k in 0 until 8) { val lsb = (r xor v) and 1; r = r ushr 1; if (lsb != 0) r = r xor 0x8408; v = v ushr 1 } }
        return r == rx1 || r == rx2
    }

    companion object {
        private const val SYNC = 0x161601
        private const val STX = 0x02; private const val ETX = 0x03; private const val ETB = 0x17
    }
}
