/**
 * The helpers every rtl_433 device decoder is built from: bit reversal, the four checksum families, and the
 * linear-feedback digests several manufacturers use in place of a standard CRC.
 *
 * Ported from rtl_433's `src/bit_util.c` (GPL-2.0-or-later, Tommy Vestermark and contributors). These are exact
 * ports rather than re-derivations: a decoder that disagrees with the reference by one bit produces confident
 * nonsense rather than an obvious failure, so the arithmetic is kept identical and the tests check it against
 * known answers.
 */

/** Reverse the bits of a byte. */
export function reverse8(x: number): number {
  x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
  x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
  x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
  return x & 0xff;
}
/** Reverse the bits within each nibble. */
export function reflect4(x: number): number {
  x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
  x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
  return x & 0xff;
}
/**
 * Reverse all thirty-two bits.
 *
 * rtl_433 casts the word to a byte pointer and reads it in memory order, so on the little-endian machines it
 * actually runs on the least significant byte ends up in the most significant position — a whole-word bit
 * reversal, not a per-byte one. Its own `watchman_plus.c` says as much: "reverse32() reverses all 32 bits".
 *
 * Reversing each byte where it stands would turn 1 into 0x80 rather than 0x80000000, which would put the
 * rolling counter of every Security+ and Chamberlain remote out. Use `reflectBytes` for the per-byte kind.
 */
export function reverse32(x: number): number {
  return ((reverse8(x & 0xff) << 24) | (reverse8((x >>> 8) & 0xff) << 16)
    | (reverse8((x >>> 16) & 0xff) << 8) | reverse8(x >>> 24)) >>> 0;
}
/** Reverse the bits of every byte, in place. */
export function reflectBytes(m: Uint8Array, n = m.length): void { for (let i = 0; i < n; i++) m[i] = reverse8(m[i]); }
/** Reverse the bits within each nibble of every byte, in place. */
export function reflectNibbles(m: Uint8Array, n = m.length): void { for (let i = 0; i < n; i++) m[i] = reflect4(m[i]); }

/** Sum of bytes, modulo 256. */
export function addBytes(m: Uint8Array, n = m.length, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += m[at + i];
  return s & 0xff;
}
/** Sum of nibbles, modulo 256. */
export function addNibbles(m: Uint8Array, n = m.length, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += (m[at + i] >> 4) + (m[at + i] & 0x0f);
  return s & 0xff;
}
/** Exclusive-or of bytes. */
export function xorBytes(m: Uint8Array, n = m.length, at = 0): number {
  let s = 0;
  for (let i = 0; i < n; i++) s ^= m[at + i];
  return s & 0xff;
}
/** Parity of a byte: 1 when an odd number of bits are set. */
export function parity8(b: number): number { let x = (b ^ (b >> 4)) & 0x0f; return (0x6996 >> x) & 1; }
/** Parity across a run of bytes. */
export function parityBytes(m: Uint8Array, n = m.length, at = 0): number {
  let p = 0;
  for (let i = 0; i < n; i++) p ^= parity8(m[at + i]);
  return p;
}

/** Four-bit CRC, computed in the top of a byte and shifted down at the end. */
export function crc4(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let rem = (init << 4) & 0xff;
  const p = (poly << 4) & 0xff;
  for (let i = 0; i < n; i++) {
    rem ^= m[at + i];
    for (let bit = 0; bit < 8; bit++) rem = (rem & 0x80) ? (((rem << 1) ^ p) & 0xff) : ((rem << 1) & 0xff);
  }
  return (rem >> 4) & 0x0f;
}

/** Seven-bit CRC, likewise computed one bit high. */
export function crc7(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let rem = (init << 1) & 0xff;
  const p = (poly << 1) & 0xff;
  for (let i = 0; i < n; i++) {
    rem ^= m[at + i];
    for (let bit = 0; bit < 8; bit++) rem = (rem & 0x80) ? (((rem << 1) ^ p) & 0xff) : ((rem << 1) & 0xff);
  }
  return (rem >> 1) & 0x7f;
}

/** Most-significant-bit-first CRC-8. */
export function crc8(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let r = init & 0xff;
  for (let byte = 0; byte < n; byte++) {
    r ^= m[at + byte];
    for (let bit = 0; bit < 8; bit++) r = (r & 0x80) ? (((r << 1) ^ poly) & 0xff) : ((r << 1) & 0xff);
  }
  return r;
}
/** Least-significant-bit-first CRC-8: the polynomial and the starting value are both reversed. */
export function crc8le(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let r = reverse8(init);
  const p = reverse8(poly);
  for (let byte = 0; byte < n; byte++) {
    r ^= m[at + byte];
    for (let bit = 0; bit < 8; bit++) r = (r & 1) ? ((r >> 1) ^ p) : (r >> 1);
  }
  return r & 0xff;
}
/** Most-significant-bit-first CRC-16. */
export function crc16(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let r = init & 0xffff;
  for (let byte = 0; byte < n; byte++) {
    r ^= m[at + byte] << 8;
    for (let bit = 0; bit < 8; bit++) r = (r & 0x8000) ? (((r << 1) ^ poly) & 0xffff) : ((r << 1) & 0xffff);
  }
  return r & 0xffff;
}
/** Least-significant-bit-first CRC-16. */
export function crc16lsb(m: Uint8Array, n: number, poly: number, init: number, at = 0): number {
  let r = init & 0xffff;
  for (let byte = 0; byte < n; byte++) {
    r ^= m[at + byte];
    for (let bit = 0; bit < 8; bit++) r = (r & 1) ? ((r >> 1) ^ poly) & 0xffff : (r >> 1);
  }
  return r & 0xffff;
}

/**
 * The digest several sensor makers use in place of a CRC: a shift register clocked once per message bit, its
 * current value exclusive-ored into the running sum wherever the message has a one. Message order is the only
 * difference between the three variants.
 */
export function lfsrDigest8(m: Uint8Array, bytes: number, gen: number, key: number, at = 0): number {
  let sum = 0, k = key & 0xff;
  for (let b = 0; b < bytes; b++) {
    const data = m[at + b];
    for (let i = 7; i >= 0; i--) {
      if ((data >> i) & 1) sum ^= k;
      k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : (k >> 1);
    }
  }
  return sum & 0xff;
}
/** As above, but walking the message from its last byte to its first. */
export function lfsrDigest8Reverse(m: Uint8Array, bytes: number, gen: number, key: number, at = 0): number {
  let sum = 0, k = key & 0xff;
  for (let b = bytes - 1; b >= 0; b--) {
    const data = m[at + b];
    for (let i = 7; i >= 0; i--) {
      if ((data >> i) & 1) sum ^= k;
      k = (k & 1) ? ((k >> 1) ^ gen) & 0xff : (k >> 1);
    }
  }
  return sum & 0xff;
}
/** As above, walking bytes backwards and bits forwards, with the register shifting the other way. */
export function lfsrDigest8Reflect(m: Uint8Array, bytes: number, gen: number, key: number, at = 0): number {
  let sum = 0, k = key & 0xff;
  for (let b = bytes - 1; b >= 0; b--) {
    const data = m[at + b];
    for (let i = 0; i < 8; i++) {
      if ((data >> i) & 1) sum ^= k;
      k = (k & 0x80) ? (((k << 1) ^ gen) & 0xff) : ((k << 1) & 0xff);
    }
  }
  return sum & 0xff;
}
/** The sixteen-bit form. */
export function lfsrDigest16(m: Uint8Array, bytes: number, gen: number, key: number, at = 0): number {
  let sum = 0, k = key & 0xffff;
  for (let b = 0; b < bytes; b++) {
    const data = m[at + b];
    for (let i = 7; i >= 0; i--) {
      if ((data >> i) & 1) sum ^= k;
      k = (k & 1) ? ((k >> 1) ^ gen) & 0xffff : (k >> 1);
    }
  }
  return sum & 0xffff;
}

/** Nibbles carried five bits at a time with a stuffing bit, as used by a few Bresser sensors. */
export function extractNibbles4b1s(m: Uint8Array, offsetBits: number, numBits: number, dst: Uint8Array): number {
  let ret = 0, off = offsetBits, n = numBits;
  while (n >= 5) {
    const bits = ((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (11 - (off % 8));
    if ((bits & 1) !== 1) break;                 // stuffing bit wrong: the run has ended
    dst[ret++] = (bits >> 1) & 0x0f;
    off += 5; n -= 5;
  }
  return ret;
}

/**
 * IBM data whitening, as the CC1101 and the radios built around it use it.
 *
 * A nine-bit shift register runs alongside the data and every byte is exclusive-ored with its lower half. That
 * breaks up long runs of identical bits so a receiver can keep its clock, and since it is only an
 * exclusive-or, the same call undoes it.
 */
export function ibmWhitening(m: Uint8Array, n = m.length): void {
  let msb = 0x01, lsb = 0xff;
  for (let i = 0; i < n; i++) {
    m[i] ^= lsb;
    for (let r = 0; r < 8; r++) {
      const prev = msb;
      msb = (lsb & 0x01) ^ ((lsb >> 5) & 0x01);
      lsb = ((lsb >> 1) & 0xff) | ((prev << 7) & 0x80);
    }
  }
}

/** Bytes carried as 8N1 serial, least significant bit first, as several weather stations send them. */
export function extractBytesUart8n1(m: Uint8Array, offsetBits: number, numBits: number, dst: Uint8Array): number {
  let ret = 0, off = offsetBits, n = numBits;
  while (n >= 10) {
    const startb = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    let datab = m[off >> 3];
    if (off % 8) datab = (((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8)));
    off += 8;
    const stopb = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    if ((startb & 1) !== 0) break;
    if ((stopb & 1) !== 1) break;
    dst[ret++] = reverse8(datab & 0xff);
    n -= 10;
  }
  return ret;
}

/**
 * Bytes carried as 8N2 serial, least significant bit first: a start bit, eight data bits, then *two* stop bits.
 *
 * The line idles high, so this first walks forward to the first start bit rather than assuming the caller
 * landed exactly on one — which is what lets a decoder point it just past a run of sync ones.
 */
export function extractBytesUart8n2(m: Uint8Array, offsetBits: number, numBits: number, dst: Uint8Array): number {
  let ret = 0, off = offsetBits, n = numBits;
  while (n > 11) {                                 // skip the idle ones ahead of the first start bit
    if (((m[off >> 3] >> (7 - (off % 8))) & 1) === 0) break;
    off += 1; n -= 1;
  }
  while (n >= 11) {
    const startb = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    let datab = m[off >> 3];
    if (off % 8) datab = (((m[off >> 3] << 8) | m[(off >> 3) + 1]) >> (8 - (off % 8)));
    off += 8;
    const stopb1 = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    const stopb2 = m[off >> 3] >> (7 - (off % 8));
    off += 1;
    if ((startb & 1) !== 0) break;                 // start-bit error
    if ((stopb1 & 1) !== 1) break;                 // stop-bit error
    if ((stopb2 & 1) !== 1) break;
    dst[ret++] = reverse8(datab & 0xff);
    n -= 11;
    if (ret >= dst.length) break;
  }
  return ret;
}
