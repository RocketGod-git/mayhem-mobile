/** Bit-serial decoding of the SBR and DRM PS prefix codes. */
import type { Bits } from './bits.js';
import type { SbrHuffSpec } from './sbr-tables.js';

/** Prefix-code tree: node pairs, leaves stored as -(symbol index) - 1. */
export interface HuffTree { tree: Int32Array; lav: number }

export function buildHuff(s: SbrHuffSpec): HuffTree {
  const tree: number[] = [0, 0];
  let next = 1;
  s.lens.forEach((len, sym) => {
    let node = 0;
    for (let b = len - 1; b >= 0; b--) {
      const bit = (s.codes[sym] >> b) & 1, at = node * 2 + bit;
      if (b === 0) { tree[at] = -sym - 1; break; }
      if (tree[at] <= 0) { tree[at] = next++; tree.push(0, 0); }
      node = tree[at];
    }
  });
  return { tree: Int32Array.from(tree), lav: s.lav };
}

export function huffDecode(b: Bits, h: HuffTree): number {
  let node = 0;
  for (;;) {
    const v = h.tree[node * 2 + b.bit()];
    if (v < 0) return -v - 1 - h.lav;
    if (v === 0) throw new RangeError('bad Huffman code');
    node = v;
  }
}
