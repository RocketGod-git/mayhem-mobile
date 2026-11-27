package com.rocketgod.mayhem.core.lora

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Not a Mayhem port: the LoRa transmit side. A modulator that is the exact inverse of [LoraReceiver] and [LoraCodec],
 * and packet builders for Meshtastic text and node info and MeshCore public channel text, the inverse of [Meshtastic]
 * and [MeshCore]. Kotlin twin of the web app's dsp/lora/tx.ts.
 *
 * Every builder sends as the node the caller names (the user's own node). Nothing here builds packets for other
 * nodes, positions, alerts or emergency messages.
 */
object LoraTx {
    /** Sync words: Meshtastic's, MeshCore's (RadioLib's private one). */
    const val MESHTASTIC_SYNC = 0x2b
    const val MESHCORE_SYNC = 0x12

    /**
     * A frame's modem. [cr] is the coding rate 1..4 (4/5 to 4/8); [preamble] the up-chirps (16, what Meshtastic sends);
     * [ldro] low data rate optimization, by default on when a symbol lasts 16 ms or more, as the receiver assumes.
     * Always explicit header, always CRC.
     */
    data class Opts(val sf: Int, val bw: Int, val cr: Int, val syncWord: Int, val preamble: Int = 16, val ldro: Boolean? = null)

    /** The inverse of Gray coding: g = v ^ (v >> 1) gives back v. */
    private fun unGray(g: Int): Int {
        var v = g
        var s = g shr 1
        while (s > 0) { v = v xor s; s = s shr 1 }
        return v
    }

    /** Hamming codeword bits for one nibble, in the order the receiver reads them: data bits 0..3, then parity. */
    private fun codeword(nib: Int, cwLen: Int): IntArray {
        val b0 = nib and 1; val b1 = (nib shr 1) and 1; val b2 = (nib shr 2) and 1; val b3 = (nib shr 3) and 1
        if (cwLen == 5) return intArrayOf(b0, b1, b2, b3, b0 xor b1 xor b2 xor b3)
        val p = intArrayOf(b0 xor b1 xor b2, b1 xor b2 xor b3, b0 xor b1 xor b3, b0 xor b2 xor b3)
        return intArrayOf(b0, b1, b2, b3) + p.copyOfRange(0, cwLen - 4)
    }

    /** sfApp nibbles into cwLen Gray-coded symbol values of sfApp bits: the inverse of LoraCodec.block. */
    private fun interleave(nibs: List<Int>, sfApp: Int, cwLen: Int): IntArray {
        val cw = nibs.map { codeword(it, cwLen) }
        return IntArray(cwLen) { i ->
            var g = 0
            for (j in 0 until sfApp) {
                val r = ((i - j - 1) % sfApp + sfApp) % sfApp
                g = g or (cw[r][i] shl (sfApp - 1 - j))
            }
            g
        }
    }

    /**
     * The chirp shifts of a frame's data symbols (header block first), each the cyclic shift of an up-chirp. Exposed for
     * tests; [modulate] adds the preamble, sync word and start-of-frame.
     */
    fun symbols(payload: IntArray, opts: Opts): IntArray {
        val sf = opts.sf; val cr = opts.cr
        require(sf in 7..12) { "spreading factor must be 7 to 12" }
        require(cr in 1..4) { "coding rate must be 1 to 4" }
        require(payload.size in 1..255) { "payload must be 1 to 255 bytes" }
        val n = 1 shl sf
        val ldro = opts.ldro ?: (n.toDouble() / opts.bw >= 0.016)
        val len = payload.size
        // whitened payload, then the CRC as the receiver checks it (sent as is, low byte first)
        val by = ArrayList<Int>()
        for (i in 0 until len) by.add(payload[i] xor LoraCodec.whitening[i % 256])
        val list = payload.asList()
        var c = LoraCodec.crc16(list, 0, maxOf(0, len - 2))
        if (len >= 2) c = c xor payload[len - 1] xor (payload[len - 2] shl 8)
        by.add(c and 0xff); by.add((c shr 8) and 0xff)
        val nibs = ArrayList<Int>()
        for (b in by) { nibs.add(b and 0x0f); nibs.add(b shr 4) }
        // header: length, coding rate and CRC flag, checksum
        val h = intArrayOf(len shr 4, len and 0x0f, (cr shl 1) or 1)
        val chk = LoraCodec.headerChecksum(h)
        val syms = ArrayList<Int>()
        // the first block: always 4/8, sf-2 bits a symbol, the header and the first payload nibbles
        val first = ArrayList<Int>(listOf(h[0], h[1], h[2], (chk shr 4) and 1, chk and 0x0f))
        val take = minOf(nibs.size, maxOf(0, sf - 2 - 5))
        first.addAll(nibs.subList(0, take)); repeat(take) { nibs.removeAt(0) }
        while (first.size < sf - 2) first.add(0)
        for (g in interleave(first, sf - 2, 8)) syms.add(4 * unGray(g) + 1)
        val sfApp = if (ldro) sf - 2 else sf; val cwLen = 4 + cr
        var at = 0
        while (at < nibs.size) {
            val blk = ArrayList<Int>(nibs.subList(at, minOf(nibs.size, at + sfApp)))
            at += sfApp
            while (blk.size < sfApp) blk.add(0)
            for (g in interleave(blk, sfApp, cwLen)) syms.add(((if (ldro) 4 * unGray(g) else unGray(g)) + 1) % n)
        }
        return syms.toIntArray()
    }

    /**
     * One LoRa frame as complex baseband at [rate] samples a second, centered on the channel: interleaved I/Q at unit
     * amplitude, continuous phase. Preamble, the two sync-word symbols, two and a quarter down-chirps, then the symbols.
     */
    fun modulate(payload: IntArray, opts: Opts, rate: Int): FloatArray {
        val sf = opts.sf; val bw = opts.bw
        val n = 1 shl sf
        require(rate >= bw) { "sample rate must be at least the bandwidth" }
        val data = symbols(payload, opts)
        // segments: up (true) or down, shift, length in chips
        class Seg(val up: Boolean, val shift: Int, val len: Double)
        val seg = ArrayList<Seg>()
        repeat(opts.preamble) { seg.add(Seg(true, 0, n.toDouble())) }
        seg.add(Seg(true, ((opts.syncWord shr 4) and 0x0f) shl 3, n.toDouble())); seg.add(Seg(true, (opts.syncWord and 0x0f) shl 3, n.toDouble()))
        seg.add(Seg(false, 0, n.toDouble())); seg.add(Seg(false, 0, n.toDouble())); seg.add(Seg(false, 0, n / 4.0))
        for (s in data) seg.add(Seg(true, s, n.toDouble()))
        val chips = seg.sumOf { it.len }
        val total = Math.round(chips * rate / bw).toInt()
        val out = FloatArray(2 * total)
        val step = bw.toDouble() / rate          // chips a sample
        var ph = 0.0; var si = 0; var segStart = 0.0
        for (k in 0 until total) {
            val u = (k + 0.5) * step                // the middle of the sample, in chips from the frame start
            while (si < seg.size - 1 && u >= segStart + seg[si].len) { segStart += seg[si].len; si++ }
            val sg = seg[si]
            val x = u - segStart
            // frequency in units of the bandwidth, from -1/2 to 1/2
            val f = if (sg.up) (((x + sg.shift) % n) / n) - 0.5 else 0.5 - ((x % n) / n)
            out[2 * k] = cos(ph).toFloat(); out[2 * k + 1] = sin(ph).toFloat()
            ph += 2 * PI * f * step
            if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
        }
        return out
    }

    // ---- Meshtastic ----

    private fun utf8(s: String): IntArray { val b = s.toByteArray(Charsets.UTF_8); return IntArray(b.size) { b[it].toInt() and 0xff } }

    private fun varint(v: Long, out: MutableList<Int>) {
        var x = v and 0xFFFF_FFFFL
        while (x >= 0x80) { out.add(((x and 0x7f) or 0x80).toInt()); x = x ushr 7 }
        out.add(x.toInt())
    }
    private fun pbVarint(field: Int, v: Long, out: MutableList<Int>) { varint((field shl 3).toLong(), out); varint(v, out) }
    private fun pbBytes(field: Int, b: IntArray, out: MutableList<Int>) {
        varint(((field shl 3) or 2).toLong(), out); varint(b.size.toLong(), out)
        for (x in b) out.add(x)
    }

    private fun randomId(): Long {
        val v = java.security.SecureRandom().nextInt().toLong() and 0xFFFF_FFFFL
        return if (v == 0L) 1L else v
    }

    private fun u32le(v: Long): List<Int> = listOf((v and 0xff).toInt(), ((v ushr 8) and 0xff).toInt(), ((v ushr 16) and 0xff).toInt(), ((v ushr 24) and 0xff).toInt())

    /** A broadcast Meshtastic packet: the 16-byte header, then the Data message, encrypted with the default key unless
     *  licensed (ham mode sends it in the clear, on the channel hash of the name alone). */
    private fun meshtasticPacket(from0: Long, channelName: String, hopLimit: Int, licensed: Boolean, id0: Long?, port: Int, inner: IntArray): IntArray {
        val from = from0 and 0xFFFF_FFFFL
        require(from != 0L && from != 0xFFFF_FFFFL) { "not a node id" }
        val id = (id0 ?: randomId()) and 0xFFFF_FFFFL
        val hop = hopLimit.coerceIn(0, 7)
        val data = ArrayList<Int>()
        pbVarint(1, port.toLong(), data)
        pbBytes(2, inner, data)
        val key = if (licensed) IntArray(0) else Meshtastic.defaultKey
        val hdr = u32le(0xFFFF_FFFFL) + u32le(from) + u32le(id) + listOf((hop shl 5) or hop, Meshtastic.channelHash(channelName, key), 0, (from and 0xff).toInt())
        var body = data.toIntArray()
        if (!licensed) {
            val nonce = IntArray(16)
            for (k in 0 until 4) { nonce[k] = hdr[8 + k]; nonce[8 + k] = hdr[4 + k] }
            body = Aes128.ctr(Meshtastic.defaultKey, nonce, body)
        }
        require(16 + body.size <= 255) { "message too long for one packet" }
        return hdr.toIntArray() + body
    }

    /** A text message to everyone on the channel, from the caller's own node. */
    fun meshtasticText(from: Long, text: String, channelName: String, hopLimit: Int = 3, licensed: Boolean = false, id: Long? = null): IntArray {
        val t = utf8(text)
        require(t.isNotEmpty()) { "empty message" }
        require(t.size <= 200) { "message too long (200 bytes at most)" }
        return meshtasticPacket(from, channelName, hopLimit, licensed, id, 1, t)
    }

    /** The caller's own node info (its User message): id, long name, short name, and the licensed flag. */
    fun meshtasticNodeInfo(from: Long, longName: String, shortName: String, channelName: String, licensed: Boolean = false, hopLimit: Int = 3, id: Long? = null): IntArray {
        val u = ArrayList<Int>()
        pbBytes(1, utf8("!%08x".format(from and 0xFFFF_FFFFL)), u)
        pbBytes(2, utf8(longName), u)
        pbBytes(3, utf8(shortName), u)
        if (licensed) pbVarint(6, 1, u)
        return meshtasticPacket(from, channelName, hopLimit, licensed, id, 4, u.toIntArray())
    }

    // ---- MeshCore ----

    /** A message on MeshCore's public channel: flood route, no hops yet, group text encrypted with the public key
     *  (AES-128 ECB, zero padded) behind its 2-byte HMAC-SHA256, the text sent as "name: text". */
    fun meshcorePublicText(senderName: String, text: String, timestamp: Long = System.currentTimeMillis() / 1000): IntArray {
        val ts = timestamp and 0xFFFF_FFFFL
        val msg = utf8("$senderName: $text")
        require(text.isNotEmpty()) { "empty message" }
        val plain = ArrayList<Int>(u32le(ts)); plain.add(0); for (b in msg) plain.add(b)
        while (plain.size % 16 != 0) plain.add(0)
        require(plain.size <= 176) { "message too long for one packet" }
        val rk = Aes128.expand(MeshCore.publicKey)
        val p = plain.toIntArray()
        val ct = IntArray(p.size)
        var i = 0
        while (i < p.size) { Aes128.encrypt(p.copyOfRange(i, i + 16), rk).copyInto(ct, i); i += 16 }
        val mk = IntArray(32); MeshCore.publicKey.copyInto(mk)
        val mac = Sha256.hmac(mk, ct)
        // flood, group text, version 0; no path
        return intArrayOf(0x15, 0x00, Sha256.hash(MeshCore.publicKey)[0], mac[0], mac[1]) + ct
    }
}
