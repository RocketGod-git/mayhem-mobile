/**
 * Port of the building blocks ProtoPirate's car-key decoders stand on (RocketGod-git/ProtoPirate, GPL-3.0): the
 * Flipper Zero SubGhz decoder blocks (lib/subghz/blocks/decoder.c, math.c, generic.h), its Manchester state machine
 * (lib/toolbox/manchester_decoder.c), KeeLoq (lib/subghz/protocols/keeloq_common.c), and ProtoPirate's own helpers
 * (protocols/protocols_common.h). Receive only: no encoder ships in the app. Twin of pirate/PPBase.kt.
 *
 * Unsigned C types map to TypeScript like this: uint64_t (a Kotlin Long) is a bigint held in 0..2^64-1 (masked with
 * MASK64 after every shift left, add, subtract or multiply), uint32_t is a bigint held in 0..0xFFFFFFFF where the
 * Kotlin port used a Long, uint16_t / uint8_t are numbers holding 0..0xFFFF / 0..0xFF. Byte buffers are number[].
 */

/** Which demodulator a protocol listens behind (ProtoPirate's AM and FM registries). */
export const PPModulation = { AM: 0, FM: 1 } as const;
export type PPModulation = 0 | 1;

export interface PPField { name: string; value: string }

/** One decoded frame, the way ProtoPirate's get_string shows it. */
export interface PPHit {
  name: string;
  bits: number;
  /** The raw key (all the bits, hex), for display and de-duplication. */
  key: string;
  serial: bigint | null;
  btn: string | null;
  cnt: bigint | null;
  /** Every other line ProtoPirate prints, in order. */
  fields: PPField[];
}

/** The value of a named field ("" when absent), for the ports' cString overrides. */
export function ppField(h: PPHit, n: string): string { for (const f of h.fields) if (f.name === n) return f.value; return ''; }

/** Flipper's SubGhzBlockConst. */
export interface PPConst { teShort: number; teLong: number; teDelta: number; minBits: number }
export const ppConst = (teShort: number, teLong: number, teDelta: number, minBits: number): PPConst => ({ teShort, teLong, teDelta, minBits });

export const MASK64 = 0xFFFFFFFFFFFFFFFFn;
export const M32 = 0xFFFFFFFFn;
/** Kotlin Long.toInt(): the low 32 bits as a signed number. */
export const toInt = (v: bigint): number => Number(BigInt.asIntN(32, v));
/** The low 32 bits as an unsigned number. */
export const lo32 = (v: bigint): number => Number(v & M32);
/** Kotlin Int.toLong() (sign-extended), kept unsigned. */
export const L = (v: number): bigint => (v < 0 ? BigInt.asUintN(64, BigInt(v)) : BigInt(v));
/** Kotlin's arithmetic shift right on a Long. */
export const shr64 = (v: bigint, n: number): bigint => (BigInt.asIntN(64, v) >> BigInt(n)) & MASK64;

/**
 * C printf-style formatting of the Kotlin hx(): %[0][width][l|ll](X|x|d|u|s), %%. Numbers and bigints print as Java's
 * String.format prints a Long (a negative value is its 64-bit two's complement for %X).
 */
export function hx(fmt: string, ...v: (number | bigint | string)[]): string {
  let out = ''; let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; continue; }
    let zero = false; let minus = false;
    while (fmt[i] === '0' || fmt[i] === '-') { if (fmt[i] === '0') zero = true; else minus = true; i++; }
    let width = 0;
    while (fmt[i] >= '0' && fmt[i] <= '9') { width = width * 10 + (fmt.charCodeAt(i) - 48); i++; }
    while (fmt[i] === 'l' || fmt[i] === 'h') i++;
    const conv = fmt[i];
    const a = v[ai++];
    let s: string;
    if (conv === 's') s = String(a);
    else {
      const b = typeof a === 'bigint' ? a : BigInt(Math.trunc(Number(a)));
      if (conv === 'X' || conv === 'x') { s = BigInt.asUintN(64, b).toString(16); if (conv === 'X') s = s.toUpperCase(); }
      else if (conv === 'u') s = BigInt.asUintN(64, b).toString();
      else s = BigInt.asIntN(64, b).toString();
    }
    if (s.length < width) {
      if (minus) s = s.padEnd(width, ' ');
      else if (zero && conv !== 's') { const neg = s[0] === '-'; s = neg ? '-' + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0'); }
      else s = s.padStart(width, ' ');
    }
    out += s;
  }
  return out;
}

/** Flipper's ManchesterState / ManchesterEvent and manchester_advance. */
export const PPManchester = {
  SHORT_LOW: 0, SHORT_HIGH: 2, LONG_LOW: 4, LONG_HIGH: 6, RESET: 8,
  START1: 0, MID1: 1, MID0: 2, START0: 3,
  transitions: [0b00000001, 0b10010001, 0b10011011, 0b11111011],
  /** Returns the next state in bits 0..7 and, when a bit completes, the bit in bit 8 with bit 9 set. */
  advance(state: number, event: number): number {
    if (event === 8) return 1;
    const ns = (PPManchester.transitions[state] >>> event) & 0x3;
    if (ns === state) return 1;
    if (ns === 2) return ns | 0x200;
    if (ns === 1) return ns | 0x300;
    return ns;
  },
};

/**
 * The base of every ported ProtoPirate decoder: Flipper's SubGhzBlockDecoder (parser step, last duration, the bits
 * so far) and SubGhzBlockGeneric (the decoded data, serial, button, counter), plus a header counter and a Manchester
 * state, which nearly all of them carry.
 */
export abstract class PPDecoder {
  parserStep = 0;
  teLast = 0;
  headerCount = 0;
  decodeData = 0n;
  decodeCountBit = 0;
  manchester = PPManchester.MID1;
  // SubGhzBlockGeneric
  data = 0n;
  dataCountBit = 0;
  serial = 0n;
  btn = 0;
  cnt = 0n;
  onHit: ((h: PPHit) => void) | null = null;

  constructor(readonly name: string, readonly modulation: PPModulation, readonly c: PPConst) {}

  /** One pulse: level high or low, its length in microseconds. */
  abstract feed(level: boolean, duration: number): void;
  reset(): void { this.parserStep = 0; this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0; this.manchester = PPManchester.MID1; }

  /** What get_string prints for the frame just decoded (called right after the decoder fills its fields). */
  describe(): PPHit {
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hx('%X', this.btn), cnt: this.cnt, fields: [] };
  }

  /**
   * ProtoPirate's get_string text for a hit, its lines joined with " | " (the form the golden fixtures from the
   * C harness use). Each port overrides this with its protocol's exact format; the default is only a fallback.
   */
  cString(h: PPHit): string {
    const parts = [`${h.name} ${h.bits}bit`, `Key:${h.key}`];
    if (h.serial !== null) parts.push(hx('Sn:%08X', h.serial));
    if (h.btn !== null) parts.push(`Btn:${h.btn}`);
    if (h.cnt !== null) parts.push(hx('Cnt:%X', h.cnt));
    for (const f of h.fields) parts.push(`${f.name}:${f.value}`);
    return parts.join(' | ');
  }

  /** The decoder's callback (instance->base.callback). */
  emit(): void { const cb = this.onHit; if (cb) cb(this.describe()); }

  // ---- Flipper blocks ----
  dd(a: number, b: number): number { return a < b ? b - a : a - b; }   // DURATION_DIFF
  isShort(d: number): boolean { return this.dd(d, this.c.teShort) < this.c.teDelta; }   // pp_is_short
  isLong(d: number): boolean { return this.dd(d, this.c.teLong) < this.c.teDelta; }     // pp_is_long
  /** blocks_add_bit (a boolean counts as 1 / 0). */
  addBit(bit: number | boolean): void {
    this.decodeData = ((this.decodeData << 1n) | ((bit === true || (bit as number) & 1) ? 1n : 0n)) & MASK64;
    this.decodeCountBit++;
  }

  /** subghz_protocol_blocks_add_to_128_bit: the bit that falls off the top of decodeData moves into the head. */
  addBitTo128(bit: number, head: bigint): bigint {
    let h = head;
    this.decodeCountBit++;
    if (this.decodeCountBit > 64) h = ((h << 1n) | (this.decodeData >> 63n)) & MASK64;
    this.decodeData = ((this.decodeData << 1n) | (bit & 1 ? 1n : 0n)) & MASK64;
    return h;
  }

  /** pp_manchester_event: short/long by duration, the level picking Low/High (high pulse = ...Low event, as in C). */
  manchesterEvent(duration: number, level: boolean): number {
    if (this.isShort(duration)) return level ? PPManchester.SHORT_LOW : PPManchester.SHORT_HIGH;
    if (this.isLong(duration)) return level ? PPManchester.LONG_LOW : PPManchester.LONG_HIGH;
    return PPManchester.RESET;
  }

  /** manchester_advance on this decoder's own state: -1 when no bit completes, else the bit (0 or 1). */
  manchesterAdvance(e: number): number {
    const r = PPManchester.advance(this.manchester, e);
    this.manchester = r & 0xFF;
    return r & 0x200 ? (r >>> 8) & 1 : -1;
  }
}

/** lib/subghz/blocks/math.c and ProtoPirate's byte helpers. */
export const PPMath = {
  bitRead(v: bigint, i: number): bigint { return (v >> BigInt(i)) & 1n; },
  reverseKey(key: bigint, bitCount: number): bigint {
    let r = 0n;
    for (let i = 0; i < bitCount; i++) r = ((r << 1n) | ((key >> BigInt(i)) & 1n)) & MASK64;
    return r;
  },
  parity(key: bigint, bitCount: number): number {
    let p = 0;
    for (let i = 0; i < bitCount; i++) p += Number((key >> BigInt(i)) & 1n);
    return p & 1;
  },
  crc4(m: number[], poly: number, initial: number): number {
    let r = (initial << 4) & 0xFF; const p = (poly << 4) & 0xFF;
    for (const b of m) { r ^= b; for (let k = 0; k < 8; k++) r = r & 0x80 ? ((r << 1) ^ p) & 0xFF : (r << 1) & 0xFF; }
    return (r >>> 4) & 0x0F;
  },
  crc7(m: number[], poly: number, initial: number): number {
    let r = (initial << 1) & 0xFF; const p = (poly << 1) & 0xFF;
    for (const b of m) { r ^= b; for (let k = 0; k < 8; k++) r = r & 0x80 ? ((r << 1) ^ p) & 0xFF : (r << 1) & 0xFF; }
    return (r >>> 1) & 0x7F;
  },
  crc8(m: number[], poly: number, initial: number): number {
    let r = initial & 0xFF;
    for (const b of m) { r ^= b; for (let k = 0; k < 8; k++) r = r & 0x80 ? ((r << 1) ^ poly) & 0xFF : (r << 1) & 0xFF; }
    return r;
  },
  crc8le(m: number[], poly: number, initial: number): number {
    let r = PPMath.reverseBits8(initial); const p = PPMath.reverseBits8(poly);
    for (const b of m) { r ^= b; for (let k = 0; k < 8; k++) r = r & 1 ? (r >>> 1) ^ p : r >>> 1; }
    return r;
  },
  crc16lsb(m: number[], poly: number, initial: number): number {
    let r = initial & 0xFFFF;
    for (const b of m) { r ^= b; for (let k = 0; k < 8; k++) r = r & 1 ? (r >>> 1) ^ poly : r >>> 1; }
    return r;
  },
  crc16(m: number[], poly: number, initial: number): number {
    let r = initial & 0xFFFF;
    for (const b of m) { r ^= b << 8; for (let k = 0; k < 8; k++) r = r & 0x8000 ? ((r << 1) ^ poly) & 0xFFFF : (r << 1) & 0xFFFF; }
    return r;
  },
  lfsrDigest8(m: number[], gen: number, key0: number): number {
    let sum = 0; let key = key0;
    for (const d of m) for (let i = 7; i >= 0; i--) { if ((d >>> i) & 1) sum ^= key; key = key & 1 ? (key >>> 1) ^ gen : key >>> 1; }
    return sum & 0xFF;
  },
  lfsrDigest8Reflect(m: number[], gen: number, key0: number): number {
    let sum = 0; let key = key0;
    for (let j = m.length - 1; j >= 0; j--) { const d = m[j]; for (let i = 0; i < 8; i++) { if ((d >>> i) & 1) sum ^= key; key = key & 0x80 ? ((key << 1) ^ gen) & 0xFF : (key << 1) & 0xFF; } }
    return sum & 0xFF;
  },
  lfsrDigest16(m: number[], gen: number, key0: number): number {
    let sum = 0; let key = key0;
    for (const d of m) for (let i = 7; i >= 0; i--) { if ((d >>> i) & 1) sum ^= key; key = key & 1 ? (key >>> 1) ^ gen : key >>> 1; }
    return sum & 0xFFFF;
  },
  addBytes(m: number[]): number { let s = 0; for (const b of m) s += b; return s & 0xFF; },
  parity8(b0: number): number { let b = b0 ^ (b0 >>> 4); b &= 0xF; return (0x6996 >>> b) & 1; },
  parityBytes(m: number[]): number { let a = 0; for (const b of m) a ^= PPMath.parity8(b); return a; },
  xorBytes(m: number[]): number { let a = 0; for (const b of m) a ^= b; return a; },
  /** pp_reverse_bits8, pp_u64_to_bytes_be, pp_bytes_to_u64_be */
  reverseBits8(v: number): number { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((v >>> i) & 1); return r; },
  u64ToBytesBE(v: bigint): number[] { const o = new Array<number>(8); for (let i = 0; i < 8; i++) o[i] = Number((v >> BigInt(56 - 8 * i)) & 0xFFn); return o; },
  bytesToU64BE(b: number[]): bigint { let r = 0n; const n = Math.min(8, b.length); for (let i = 0; i < n; i++) r = ((r << 8n) | BigInt(b[i] & 0xFF)) & MASK64; return r; },
};

/** lib/subghz/protocols/keeloq_common.c (32-bit values held in bigints, 0..0xFFFFFFFF). */
const NLF = 0x3A5C742E;
const kbit = (x: number, n: number): number => (x >>> n) & 1;
const g5 = (x: number, a: number, b: number, c: number, d: number, e: number): number =>
  kbit(x, a) + kbit(x, b) * 2 + kbit(x, c) * 4 + kbit(x, d) * 8 + kbit(x, e) * 16;
const keyBit = (lo: number, hi: number, n: number): number => (n < 32 ? (lo >>> n) & 1 : (hi >>> (n - 32)) & 1);

export const KeeLoq = {
  encrypt(data: bigint, key: bigint): bigint {
    let x = toInt(data); const lo = lo32(key), hi = lo32(key >> 32n);
    for (let r = 0; r < 528; r++) x = (x >>> 1) ^ ((kbit(x, 0) ^ kbit(x, 16) ^ keyBit(lo, hi, r & 63) ^ kbit(NLF, g5(x, 1, 9, 20, 26, 31))) << 31);
    return BigInt(x >>> 0);
  },
  decrypt(data: bigint, key: bigint): bigint {
    let x = toInt(data); const lo = lo32(key), hi = lo32(key >> 32n);
    for (let r = 0; r < 528; r++) x = (x << 1) ^ kbit(x, 31) ^ kbit(x, 15) ^ keyBit(lo, hi, (15 - r) & 63) ^ kbit(NLF, g5(x, 0, 8, 19, 25, 30));
    return BigInt(x >>> 0);
  },
  normalLearning(data0: bigint, key: bigint): bigint {
    let d = (data0 & 0x0FFFFFFFn) | 0x20000000n;
    const k1 = KeeLoq.decrypt(d, key);
    d = (d & 0x0FFFFFFFn) | 0x60000000n;
    const k2 = KeeLoq.decrypt(d, key);
    return ((k2 << 32n) | k1) & MASK64;
  },
  secureLearning(data: bigint, seed: bigint, key: bigint): bigint {
    const k1 = KeeLoq.decrypt(data & 0x0FFFFFFFn, key); const k2 = KeeLoq.decrypt(seed & M32, key);
    return ((k1 << 32n) | k2) & MASK64;
  },
};

/**
 * Manufacturer keys. ProtoPirate reads them from the Flipper's own keystore; none are shipped. A decoder that needs
 * one shows the frame as received (encrypted) when it is absent.
 */
export const PPKeys: { kiaMf: bigint | null; kiaV6A: bigint | null; kiaV6B: bigint | null; kiaV5: bigint | null } = {
  kiaMf: null, kiaV6A: null, kiaV6B: null, kiaV5: null,
};
