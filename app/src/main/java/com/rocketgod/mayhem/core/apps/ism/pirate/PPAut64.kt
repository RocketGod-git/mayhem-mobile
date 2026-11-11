// Port of ProtoPirate protocols/aut64.c (decrypt and unpack; GPL-3.0). AUT64, 12 rounds, 8-byte block
// (Garcia et al., USENIX Security 2016). Encrypt is encoder-only and does not ship.
package com.rocketgod.mayhem.core.apps.ism.pirate

class PPAut64Key {
    var index = 0
    val key = IntArray(8)
    val pbox = IntArray(8)
    val sbox = IntArray(16)
}

object PPAut64 {
    const val NUM_ROUNDS = 12; const val BLOCK_SIZE = 8; const val PACKED_KEY_SIZE = 16

    private val tableLn = arrayOf(
        intArrayOf(4, 5, 6, 7, 0, 1, 2, 3), intArrayOf(5, 4, 7, 6, 1, 0, 3, 2), intArrayOf(6, 7, 4, 5, 2, 3, 0, 1), intArrayOf(7, 6, 5, 4, 3, 2, 1, 0),
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7), intArrayOf(1, 0, 3, 2, 5, 4, 7, 6), intArrayOf(2, 3, 0, 1, 6, 7, 4, 5), intArrayOf(3, 2, 1, 0, 7, 6, 5, 4),
        intArrayOf(5, 4, 7, 6, 1, 0, 3, 2), intArrayOf(4, 5, 6, 7, 0, 1, 2, 3), intArrayOf(7, 6, 5, 4, 3, 2, 1, 0), intArrayOf(6, 7, 4, 5, 2, 3, 0, 1),
    )
    private val tableUn = arrayOf(
        intArrayOf(1, 0, 3, 2, 5, 4, 7, 6), intArrayOf(0, 1, 2, 3, 4, 5, 6, 7), intArrayOf(3, 2, 1, 0, 7, 6, 5, 4), intArrayOf(2, 3, 0, 1, 6, 7, 4, 5),
        intArrayOf(5, 4, 7, 6, 1, 0, 3, 2), intArrayOf(4, 5, 6, 7, 0, 1, 2, 3), intArrayOf(7, 6, 5, 4, 3, 2, 1, 0), intArrayOf(6, 7, 4, 5, 2, 3, 0, 1),
        intArrayOf(3, 2, 1, 0, 7, 6, 5, 4), intArrayOf(2, 3, 0, 1, 6, 7, 4, 5), intArrayOf(1, 0, 3, 2, 5, 4, 7, 6), intArrayOf(0, 1, 2, 3, 4, 5, 6, 7),
    )
    private val tableOffset = intArrayOf(0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
        0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF,
        0x0, 0x2, 0x4, 0x6, 0x8, 0xA, 0xC, 0xE, 0x3, 0x1, 0x7, 0x5, 0xB, 0x9, 0xF, 0xD,
        0x0, 0x3, 0x6, 0x5, 0xC, 0xF, 0xA, 0x9, 0xB, 0x8, 0xD, 0xE, 0x7, 0x4, 0x1, 0x2,
        0x0, 0x4, 0x8, 0xC, 0x3, 0x7, 0xB, 0xF, 0x6, 0x2, 0xE, 0xA, 0x5, 0x1, 0xD, 0x9,
        0x0, 0x5, 0xA, 0xF, 0x7, 0x2, 0xD, 0x8, 0xE, 0xB, 0x4, 0x1, 0x9, 0xC, 0x3, 0x6,
        0x0, 0x6, 0xC, 0xA, 0xB, 0xD, 0x7, 0x1, 0x5, 0x3, 0x9, 0xF, 0xE, 0x8, 0x2, 0x4,
        0x0, 0x7, 0xE, 0x9, 0xF, 0x8, 0x1, 0x6, 0xD, 0xA, 0x3, 0x4, 0x2, 0x5, 0xC, 0xB,
        0x0, 0x8, 0x3, 0xB, 0x6, 0xE, 0x5, 0xD, 0xC, 0x4, 0xF, 0x7, 0xA, 0x2, 0x9, 0x1,
        0x0, 0x9, 0x1, 0x8, 0x2, 0xB, 0x3, 0xA, 0x4, 0xD, 0x5, 0xC, 0x6, 0xF, 0x7, 0xE,
        0x0, 0xA, 0x7, 0xD, 0xE, 0x4, 0x9, 0x3, 0xF, 0x5, 0x8, 0x2, 0x1, 0xB, 0x6, 0xC,
        0x0, 0xB, 0x5, 0xE, 0xA, 0x1, 0xF, 0x4, 0x7, 0xC, 0x2, 0x9, 0xD, 0x6, 0x8, 0x3,
        0x0, 0xC, 0xB, 0x7, 0x5, 0x9, 0xE, 0x2, 0xA, 0x6, 0x1, 0xD, 0xF, 0x3, 0x4, 0x8,
        0x0, 0xD, 0x9, 0x4, 0x1, 0xC, 0x8, 0x5, 0x2, 0xF, 0xB, 0x6, 0x3, 0xE, 0xA, 0x7,
        0x0, 0xE, 0xF, 0x1, 0xD, 0x3, 0x2, 0xC, 0x9, 0x7, 0x6, 0x8, 0x4, 0xA, 0xB, 0x5,
        0x0, 0xF, 0xD, 0x2, 0x9, 0x6, 0x4, 0xB, 0x1, 0xE, 0xC, 0x3, 0x8, 0x7, 0x5, 0xA,)
    private val tableSub = intArrayOf(0x0, 0x1, 0x9, 0xE, 0xD, 0xB, 0x7, 0x6, 0xF, 0x2, 0xC, 0x5, 0xA, 0x4, 0x3, 0x8)

    // Key nibbles are masked to 0..15 where C indexes tables with them: the C has no bounds check (validations off),
    // but every key unpacked from nibbles is already in range, so the mask never changes a result.
    private fun keyNibble(k: PPAut64Key, nibble: Int, table: IntArray, iteration: Int): Int {
        val keyValue = k.key[table[iteration]]
        return tableOffset[((keyValue shl 4) and 0xFF) or nibble]
    }

    private fun roundKey(k: PPAut64Key, state: IntArray, r: Int): Int {
        var hi = 0; var lo = 0
        for (i in 0 until BLOCK_SIZE - 1) {
            hi = hi xor keyNibble(k, state[i] ushr 4, tableUn[r], i)
            lo = lo xor keyNibble(k, state[i] and 0x0F, tableLn[r], i)
        }
        return ((hi shl 4) or lo) and 0xFF
    }

    private fun finalByteNibble(k: PPAut64Key, table: IntArray): Int =
        (tableSub[k.key[table[BLOCK_SIZE - 1]] and 0x0F] shl 4) and 0xFF

    private fun decryptFinalByteNibble(k: PPAut64Key, nibble: Int, table: IntArray, result: Int): Int {
        val offset = finalByteNibble(k, table)
        return tableOffset[((result xor nibble) + offset) and 0xFF]
    }

    private fun decryptCompress(k: PPAut64Key, state: IntArray, r: Int): Int {
        val rk = roundKey(k, state, r)
        val hi = decryptFinalByteNibble(k, state[BLOCK_SIZE - 1] ushr 4, tableUn[r], rk ushr 4)
        val lo = decryptFinalByteNibble(k, state[BLOCK_SIZE - 1] and 0x0F, tableLn[r], rk and 0x0F)
        return ((hi shl 4) or lo) and 0xFF
    }

    private fun substitute(k: PPAut64Key, b: Int): Int =
        ((k.sbox[b ushr 4] shl 4) and 0xFF) or k.sbox[b and 0x0F]

    private fun permuteBytes(k: PPAut64Key, state: IntArray) {
        val result = IntArray(8)
        for (i in 0 until 8) result[k.pbox[i] and 7] = state[i]
        for (i in 0 until 8) state[i] = result[i]
    }

    private fun permuteBits(k: PPAut64Key, b: Int): Int {
        var result = 0
        for (i in 0 until 8) if (b and (1 shl i) != 0) result = result or (1 shl (k.pbox[i] and 7))
        return result
    }

    /** aut64_decrypt: one 8-byte block in place (message[0..7]). */
    fun decrypt(k: PPAut64Key, message: IntArray) {
        for (i in NUM_ROUNDS - 1 downTo 0) {
            message[BLOCK_SIZE - 1] = substitute(k, message[BLOCK_SIZE - 1])
            message[BLOCK_SIZE - 1] = permuteBits(k, message[BLOCK_SIZE - 1])
            message[BLOCK_SIZE - 1] = substitute(k, message[BLOCK_SIZE - 1])
            message[BLOCK_SIZE - 1] = decryptCompress(k, message, i)
            permuteBytes(k, message)
        }
    }

    /** aut64_unpack: a 16-byte packed key (index, 8 key nibbles, 8 x 3-bit pbox, 16 sbox nibbles). */
    fun unpack(src: IntArray): PPAut64Key {
        val d = PPAut64Key()
        d.index = src[0]
        for (i in 0 until 4) { d.key[i * 2] = src[i + 1] ushr 4; d.key[i * 2 + 1] = src[i + 1] and 0xF }
        var pbox = (src[5] shl 16) or (src[6] shl 8) or src[7]
        for (i in 7 downTo 0) { d.pbox[i] = pbox and 0x7; pbox = pbox ushr 3 }
        for (i in 0 until 8) { d.sbox[i * 2] = src[i + 8] ushr 4; d.sbox[i * 2 + 1] = src[i + 8] and 0xF }
        return d
    }
}
