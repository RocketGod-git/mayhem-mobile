package com.rocketgod.mayhem.core.hd.hdc

// Bit-serial decoding of the SBR and DRM PS prefix codes.

/** Prefix-code tree: node pairs, leaves stored as -(symbol index) - 1. */
class HuffTree(val tree: IntArray, val lav: Int)

fun buildHuff(s: SbrHuffSpec): HuffTree {
    val tree = ArrayList<Int>(); tree.add(0); tree.add(0)
    var next = 1
    s.lens.forEachIndexed { sym, len ->
        var node = 0
        for (b in len - 1 downTo 0) {
            val bit = (s.codes[sym] shr b) and 1; val at = node * 2 + bit
            if (b == 0) { tree[at] = -sym - 1; break }
            if (tree[at] <= 0) { tree[at] = next++; tree.add(0); tree.add(0) }
            node = tree[at]
        }
    }
    return HuffTree(tree.toIntArray(), s.lav)
}

fun huffDecode(b: Bits, h: HuffTree): Int {
    var node = 0
    while (true) {
        val v = h.tree[node * 2 + b.bit()]
        if (v < 0) return -v - 1 - h.lav
        if (v == 0) throw IllegalStateException("bad Huffman code")
        node = v
    }
}
