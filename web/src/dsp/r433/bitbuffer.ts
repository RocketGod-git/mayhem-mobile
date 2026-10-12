/**
 * The two-dimensional bit buffer every rtl_433 device decoder reads from.
 *
 * A slicer turns a burst of pulses into rows of bits — one row per transmission, or per repeat of the same
 * transmission — and hands the buffer to each decoder in turn. Everything a decoder does (searching for a
 * preamble, pulling bytes out at a bit offset, finding the row that repeated often enough to be trusted) is a
 * method here.
 *
 * Ported from rtl_433's `src/bitbuffer.c` (GPL-2.0-or-later, Tommy Vestermark and contributors).
 *
 * One implementation detail is load-bearing. In C the rows are a single contiguous array, and the code leans on
 * that: a row that overruns its 128 bytes spills into the next row rather than being truncated, and reading bytes
 * near the end of a row reads on into the one after it. So the rows here are views into one flat array, with a
 * few bytes of slack at the end so that a read just past the last row sees zeroes instead of running off.
 */

export const BITBUF_COLS = 128;                    // bytes per row
export const BITBUF_ROWS = 50;
export const BITBUF_MAX_ROW_BITS = BITBUF_ROWS * BITBUF_COLS * 8;

/** One bit of a byte array, counting from the most significant bit of byte zero. */
export function bitAt(bytes: Uint8Array, bit: number): number {
  return (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
}

export class BitBuffer {
  /** All rows, back to back, exactly as C lays them out. Eight bytes of slack guard the reads that run past. */
  private readonly buf = new Uint8Array(BITBUF_ROWS * BITBUF_COLS + 8);
  /** Row `i` as a view starting at its first byte and running to the end of the buffer, so spill still works. */
  readonly bb: Uint8Array[] = [];
  readonly bitsPerRow = new Uint16Array(BITBUF_ROWS);
  readonly syncsBeforeRow = new Uint16Array(BITBUF_ROWS);
  numRows = 0;
  /** The next row not yet claimed. Differs from numRows only while a long row is spilling into the rows above. */
  private freeRow = 0;

  constructor() {
    for (let i = 0; i < BITBUF_ROWS; i++) this.bb.push(this.buf.subarray(i * BITBUF_COLS));
  }

  clear(): void {
    this.buf.fill(0);
    this.bitsPerRow.fill(0);
    this.syncsBeforeRow.fill(0);
    this.numRows = 0;
    this.freeRow = 0;
  }

  addBit(bit: number): void {
    if (this.numRows === 0) this.freeRow = this.numRows = 1;
    const r = this.numRows - 1;
    if (this.bitsPerRow[r] === 0xffff) return;

    const colIndex = this.bitsPerRow[r] >> 3;
    const bitIndex = this.bitsPerRow[r] & 7;
    if (this.bitsPerRow[r] > 0 && this.bitsPerRow[r] % (BITBUF_COLS * 8) === 0) {
      // The row has filled its own columns and is about to write into the next row's storage. Claim that row so
      // nothing else uses it, but keep writing to the same row: the bits stay one continuous run.
      if (this.freeRow < BITBUF_ROWS) this.freeRow++;
      else return;
    }
    this.bb[r][colIndex] |= bit << (7 - bitIndex);
    this.bitsPerRow[r]++;
  }

  addRow(): void {
    if (this.numRows === 0) this.freeRow = this.numRows = 1;
    if (this.freeRow < BITBUF_ROWS) {
      this.freeRow++;
      this.numRows = this.freeRow;
    } else {
      this.bitsPerRow[this.numRows - 1] = 0;         // out of rows: drop the last one rather than corrupt it
    }
  }

  /** Record that a sync word preceded the row about to be filled. A few decoders count these. */
  addSync(): void {
    if (this.numRows === 0) this.freeRow = this.numRows = 1;
    if (this.bitsPerRow[this.numRows - 1]) this.addRow();
    this.syncsBeforeRow[this.numRows - 1]++;
  }

  /** Grow or trim the current row to an exact width, clearing anything trimmed away. */
  setWidth(width: number): void {
    if (this.numRows === 0) this.freeRow = this.numRows = 1;
    const r = this.numRows - 1;
    const remainingBits = (BITBUF_ROWS - this.numRows + 1) * BITBUF_COLS * 8;
    if (width > remainingBits) width = remainingBits;

    if (this.bitsPerRow[r] > width) {
      const b = this.bb[r];
      const clrFrom = (width + 7) >> 3;
      const clrEnd = (this.bitsPerRow[r] + 7) >> 3;
      b.fill(0, clrFrom, clrEnd);
      b[width >> 3] &= 0xff00 >> (width & 7);
    }
    this.bitsPerRow[r] = width;
    this.freeRow = this.numRows + (width === 0 ? 0 : ((width - 1) / (BITBUF_COLS * 8)) | 0);
  }

  /** Flip every bit, leaving the unused tail of the last byte at zero. */
  invert(): void {
    for (let row = 0; row < this.numRows; row++) {
      if (this.bitsPerRow[row] === 0) continue;
      const b = this.bb[row];
      const lastCol = (this.bitsPerRow[row] - 1) >> 3;
      const lastBits = ((this.bitsPerRow[row] - 1) & 7) + 1;
      for (let col = 0; col <= lastCol; col++) b[col] = ~b[col];
      b[lastCol] ^= 0xff >> lastBits;
    }
  }

  /** Undo NRZ-S: a zero in the line means the level changed. */
  nrzsDecode(): void {
    for (let row = 0; row < this.numRows; row++) {
      if (this.bitsPerRow[row] === 0) continue;
      const b = this.bb[row];
      const lastCol = (this.bitsPerRow[row] - 1) >> 3;
      const lastBits = ((this.bitsPerRow[row] - 1) & 7) + 1;
      let prev = 0;
      for (let col = 0; col <= lastCol; col++) {
        const mask = ((prev << 7) | (b[col] >> 1)) & 0xff;
        prev = b[col];
        b[col] = b[col] ^ ~mask;
      }
      b[lastCol] &= 0xff << (8 - lastBits);
    }
  }

  /** Undo NRZ-M: a one in the line means the level changed. */
  nrzmDecode(): void {
    for (let row = 0; row < this.numRows; row++) {
      if (this.bitsPerRow[row] === 0) continue;
      const b = this.bb[row];
      const lastCol = (this.bitsPerRow[row] - 1) >> 3;
      const lastBits = ((this.bitsPerRow[row] - 1) & 7) + 1;
      let prev = 0;
      for (let col = 0; col <= lastCol; col++) {
        const mask = ((prev << 7) | (b[col] >> 1)) & 0xff;
        prev = b[col];
        b[col] = b[col] ^ mask;
      }
      b[lastCol] &= 0xff << (8 - lastBits);
    }
  }

  /**
   * Copy `len` bits out of a row starting at an arbitrary bit position, left-aligned into `out`.
   * This is how nearly every decoder reads its payload once it has found the preamble.
   */
  extractBytes(row: number, pos: number, out: Uint8Array, len: number): void {
    const bits = this.bb[row];
    if (len === 0) return;
    if ((pos & 7) === 0) {
      out.set(bits.subarray(pos >> 3, (pos >> 3) + ((len + 7) >> 3)));
    } else {
      const shift = 8 - (pos & 7);
      let bytes = (len + 7) >> 3;
      let p = 0;
      let byteAt = pos >> 3;
      let word = bits[byteAt];
      while (bytes--) {
        word = ((word << 8) | bits[++byteAt]) & 0xffff;
        out[p++] = word >> shift;
      }
    }
    if (len & 7) out[(len - 1) >> 3] &= 0xff00 >> (len & 7);
  }

  /** Convenience wrapper: the same extraction, into a fresh array. */
  bytes(row: number, pos: number, len: number): Uint8Array {
    const out = new Uint8Array((len + 7) >> 3);
    this.extractBytes(row, pos, out, len);
    return out;
  }

  /**
   * Find a bit pattern in a row. Returns the bit position it starts at, or the row's length when it is absent —
   * so the usual test is `pos < bits.bitsPerRow[row]`, and the usual next step is to extract from `pos`.
   */
  search(row: number, start: number, pattern: Uint8Array, patternBitsLen: number): number {
    const bits = this.bb[row];
    const len = this.bitsPerRow[row];
    let ipos = start, ppos = 0;
    while (ipos < len && ppos < patternBitsLen) {
      if (bitAt(bits, ipos) === bitAt(pattern, ppos)) {
        ppos++; ipos++;
        if (ppos === patternBitsLen) return ipos - patternBitsLen;
      } else {
        ipos -= ppos; ipos++; ppos = 0;
      }
    }
    return len;
  }

  /**
   * Read Manchester-coded bits out of one row into another buffer, stopping at the first pair that does not
   * change level. Returns where it stopped. `max` limits the output in bits, zero for no limit.
   */
  manchesterDecode(row: number, start: number, out: BitBuffer, max: number): number {
    const bits = this.bb[row];
    let len = this.bitsPerRow[row];
    let ipos = start;
    if (max && len > start + max * 2) len = start + max * 2;
    while (ipos < len) {
      const bit1 = bitAt(bits, ipos++);
      const bit2 = bitAt(bits, ipos++);
      if (bit1 === bit2) break;
      out.addBit(bit2);
    }
    return ipos;
  }

  /** Differential Manchester: the bit is whether the level held across the middle of the symbol. */
  differentialManchesterDecode(row: number, start: number, out: BitBuffer, max: number): number {
    const bits = this.bb[row];
    let len = this.bitsPerRow[row];
    let ipos = start;
    let bit1: number, bit2 = 0;
    if (max && len > start + max * 2) len = start + max * 2;

    // Find the clock: the first long pulse settles it, skipping a short one if that is what it takes.
    while (ipos < len) {
      bit1 = bitAt(bits, ipos++);
      bit2 = bitAt(bits, ipos++);
      const bit3 = bitAt(bits, ipos);
      if (bit1 !== bit2) {
        if (bit2 !== bit3) out.addBit(0);
        else { bit2 = bit1; ipos -= 1; break; }
      } else { bit2 = 1 - bit1; ipos -= 2; break; }
    }

    while (ipos < len) {
      bit1 = bitAt(bits, ipos++);
      if (bit1 === bit2) break;                      // clock missing, give up
      bit2 = bitAt(bits, ipos++);
      out.addBit(bit1 === bit2 ? 1 : 0);
    }
    return ipos;
  }

  /** Whether two rows hold the same bits, either entirely or across their first `maxBits`. */
  compareRows(rowA: number, rowB: number, maxBits: number): boolean {
    const a = this.bb[rowA], b = this.bb[rowB];
    if (maxBits === 0 || this.bitsPerRow[rowA] < maxBits || this.bitsPerRow[rowB] < maxBits) {
      if (this.bitsPerRow[rowA] !== this.bitsPerRow[rowB]) return false;
      const n = (this.bitsPerRow[rowA] + 7) >> 3;
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    const last = (maxBits - 1) >> 3;
    const mask = 0xff00 >> (maxBits & 7);
    for (let i = 0; i < (maxBits >> 3); i++) if (a[i] !== b[i]) return false;
    return (a[last] & mask) === (b[last] & mask);
  }

  /** How many rows match this one. A transmitter that repeats its message gives its rows a count above one. */
  countRepeats(row: number, maxBits: number): number {
    let cnt = 0;
    for (let i = 0; i < this.numRows; i++) if (this.compareRows(row, i, maxBits)) cnt++;
    return cnt;
  }

  /**
   * The first row long enough and repeated often enough to be believed, or -1.
   * Repetition is most decoders' only error check, so this is the usual first line of a decode.
   */
  findRepeatedRow(minRepeats: number, minBits: number): number {
    for (let i = 0; i < this.numRows; i++) {
      if (this.bitsPerRow[i] >= minBits && this.countRepeats(i, 0) >= minRepeats) return i;
    }
    return -1;
  }

  /** As above, but rows only have to agree across their first `minBits` — for transmitters with ragged tails. */
  findRepeatedPrefix(minRepeats: number, minBits: number): number {
    for (let i = 0; i < this.numRows; i++) {
      if (this.bitsPerRow[i] >= minBits && this.countRepeats(i, minBits) >= minRepeats) return i;
    }
    return -1;
  }

  /** One row as hex, the form rtl_433 prints and its test vectors are written in. */
  rowHex(row: number): string {
    let s = '';
    for (let i = 0; i < (this.bitsPerRow[row] + 7) >> 3; i++) s += this.bb[row][i].toString(16).padStart(2, '0');
    return s;
  }

  toString(): string {
    const out: string[] = [];
    for (let r = 0; r < this.numRows; r++) out.push(`{${this.bitsPerRow[r]}}${this.rowHex(r)}`);
    return out.join(' / ');
  }

  /**
   * Read the `{n}hex/{n}hex` notation rtl_433 uses for test vectors and for `-y` on the command line.
   * Having this means a decoder can be checked against the project's own recorded codes without any radio.
   */
  static parse(code: string): BitBuffer {
    const bits = new BitBuffer();
    let width = -1;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (c === ' ') continue;
      if (c === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) { i++; continue; }
      if (c === '{') {
        if (width >= 0) bits.setWidth(width);
        if (bits.numRows > 0) bits.addRow();
        const close = code.indexOf('}', i);
        const body = code.slice(i + 1, close < 0 ? code.length : close).trim();
        width = body.startsWith('0x') || body.startsWith('0X') ? parseInt(body, 16) : parseInt(body, 10);
        if (!isFinite(width)) width = 0;
        if (width > BITBUF_MAX_ROW_BITS) width = BITBUF_MAX_ROW_BITS;
        if (close < 0) break;
        i = close;
        continue;
      }
      if (c === '/') {
        if (width >= 0) { bits.setWidth(width); width = -1; }
        bits.addRow();
        continue;
      }
      const data = parseInt(c, 16);
      if (isNaN(data)) continue;
      bits.addBit((data >> 3) & 1);
      bits.addBit((data >> 2) & 1);
      bits.addBit((data >> 1) & 1);
      bits.addBit(data & 1);
    }
    if (width >= 0) bits.setWidth(width);
    return bits;
  }
}
