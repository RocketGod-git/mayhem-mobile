package com.rocketgod.mayhem.core.lora

// Not a Mayhem port: SHA-256 / HMAC-SHA256 (MeshCore names its group channels by the hash of their key and signs
// group messages with an HMAC) and AES-128 (Meshtastic channel traffic is AES-CTR, MeshCore's is AES-ECB). Bytes are
// carried as IntArray (0..255) throughout the LoRa layer. Kotlin twin of the iOS Sha256.swift / Aes128.swift.

object Sha256 {
    fun hash(msg: IntArray): IntArray {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        val out = md.digest(ByteArray(msg.size) { msg[it].toByte() })
        return IntArray(out.size) { out[it].toInt() and 0xff }
    }

    fun hmac(key: IntArray, msg: IntArray): IntArray {
        var k = if (key.size > 64) hash(key) else key
        k += IntArray(64 - k.size)
        return hash(IntArray(64) { k[it] xor 0x5c } + hash(IntArray(64) { k[it] xor 0x36 } + msg))
    }
}

/** AES-128 (FIPS-197): one block each way, and the ECB and counter modes on top. */
object Aes128 {
    private val sbox = intArrayOf(
        0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
        0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
        0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
        0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
        0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
        0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
        0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
        0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
        0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
        0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
        0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
        0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
        0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
        0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
        0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
        0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
    )
    private val inv = IntArray(256).also { t -> for (i in 0 until 256) t[sbox[i]] = i }

    private fun xtime(x: Int): Int = ((x shl 1) xor (if (x and 0x80 != 0) 0x1b else 0)) and 0xff

    private fun mul(a0: Int, b0: Int): Int {
        var a = a0; var b = b0; var p = 0
        while (b != 0) { if (b and 1 != 0) p = p xor a; a = xtime(a); b = b shr 1 }
        return p
    }

    /** The 11 round keys, 176 bytes. */
    fun expand(key: IntArray): IntArray {
        val w = ArrayList<Int>(176); for (b in key) w.add(b)
        var rcon = 1
        while (w.size < 176) {
            var t = intArrayOf(w[w.size - 4], w[w.size - 3], w[w.size - 2], w[w.size - 1])
            if (w.size % 16 == 0) {
                t = intArrayOf(sbox[t[1]] xor rcon, sbox[t[2]], sbox[t[3]], sbox[t[0]])
                rcon = xtime(rcon)
            }
            for (i in 0 until 4) w.add(w[w.size - 16] xor t[i])
        }
        return w.toIntArray()
    }

    fun encrypt(block: IntArray, rk: IntArray): IntArray {
        var s = IntArray(16) { block[it] xor rk[it] }
        for (round in 1..10) {
            for (i in 0 until 16) s[i] = sbox[s[i]]
            // shift rows (state is column-major: s[r + 4c])
            s = intArrayOf(s[0], s[5], s[10], s[15], s[4], s[9], s[14], s[3], s[8], s[13], s[2], s[7], s[12], s[1], s[6], s[11])
            if (round < 10) for (c in 0 until 4) {
                val a0 = s[4 * c]; val a1 = s[4 * c + 1]; val a2 = s[4 * c + 2]; val a3 = s[4 * c + 3]
                val all = a0 xor a1 xor a2 xor a3
                s[4 * c] = s[4 * c] xor all xor xtime(a0 xor a1)
                s[4 * c + 1] = s[4 * c + 1] xor all xor xtime(a1 xor a2)
                s[4 * c + 2] = s[4 * c + 2] xor all xor xtime(a2 xor a3)
                s[4 * c + 3] = s[4 * c + 3] xor all xor xtime(a3 xor a0)
            }
            for (i in 0 until 16) s[i] = s[i] xor rk[16 * round + i]
        }
        return s
    }

    /** The inverse cipher on one block (MeshCore encrypts with AES-128 in ECB mode). */
    fun decrypt(block: IntArray, rk: IntArray): IntArray {
        var s = IntArray(16) { block[it] xor rk[160 + it] }
        for (round in 9 downTo 0) {
            // inverse shift rows
            s = intArrayOf(s[0], s[13], s[10], s[7], s[4], s[1], s[14], s[11], s[8], s[5], s[2], s[15], s[12], s[9], s[6], s[3])
            for (i in 0 until 16) s[i] = inv[s[i]]
            for (i in 0 until 16) s[i] = s[i] xor rk[16 * round + i]
            if (round > 0) for (c in 0 until 4) {
                val a0 = s[4 * c]; val a1 = s[4 * c + 1]; val a2 = s[4 * c + 2]; val a3 = s[4 * c + 3]
                s[4 * c] = mul(a0, 14) xor mul(a1, 11) xor mul(a2, 13) xor mul(a3, 9)
                s[4 * c + 1] = mul(a0, 9) xor mul(a1, 14) xor mul(a2, 11) xor mul(a3, 13)
                s[4 * c + 2] = mul(a0, 13) xor mul(a1, 9) xor mul(a2, 14) xor mul(a3, 11)
                s[4 * c + 3] = mul(a0, 11) xor mul(a1, 13) xor mul(a2, 9) xor mul(a3, 14)
            }
        }
        return s
    }

    /** ECB decryption of whole blocks (a short tail is dropped). */
    fun ecbDecrypt(key: IntArray, data: IntArray): IntArray {
        val rk = expand(key)
        val out = ArrayList<Int>()
        var i = 0
        while (i + 16 <= data.size) { for (b in decrypt(data.copyOfRange(i, i + 16), rk)) out.add(b); i += 16 }
        return out.toIntArray()
    }

    /** Counter mode: the 16-byte counter block counts up big-endian from [iv]. */
    fun ctr(key: IntArray, iv: IntArray, data: IntArray): IntArray {
        val rk = expand(key)
        val c = iv.copyOf()
        val out = IntArray(data.size)
        var ks = IntArray(16)
        for (i in data.indices) {
            if (i % 16 == 0) {
                ks = encrypt(c, rk)
                var k = 15
                while (k >= 0) { c[k] = (c[k] + 1) and 0xff; if (c[k] != 0) break; k-- }
            }
            out[i] = data[i] xor ks[i % 16]
        }
        return out
    }
}

/** Lowercase hex of bytes. */
internal fun hexOf(b: IntArray, from: Int = 0, to: Int = b.size): String {
    val s = StringBuilder()
    for (i in from until to) s.append("%02x".format(b[i]))
    return s.toString()
}

/** UTF-8 text, or null when the bytes are not valid UTF-8 (as Swift's String(bytes:encoding:) reads them). */
internal fun utf8OrNull(b: IntArray): String? = try {
    java.nio.charset.StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        .decode(java.nio.ByteBuffer.wrap(ByteArray(b.size) { b[it].toByte() })).toString()
} catch (e: java.nio.charset.CharacterCodingException) { null }

/** A date the way the iOS app prints one (UTC). */
internal fun utcStamp(epochS: Long): String =
    java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(epochS * 1000))
