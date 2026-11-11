/** Port of ProtoPirate protocols/kia_v6.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV6.kt. */
import { PPDecoder, PPModulation, PPManchester, PPMath, PPKeys, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_WAIT_FIRST_HIGH = 1, STEP_WAIT_LONG_HIGH = 2, STEP_DATA = 3;
const XOR_MASK_LOW = 0x84AF25FBn, XOR_MASK_HIGH = 0x638766ABn;

const sbox = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
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
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16];
const sboxInv = [0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d];
const rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

// ---- AES-128 decryption, as kia_v6.c writes it ----
const gfMul2 = (x: number): number => (((x >>> 7) * 0x1b) ^ (x << 1)) & 0xFF;

function subBytesInv(s: number[]): void { for (let i = 0; i < 16; i++) s[i] = sboxInv[s[i]]; }

function shiftRowsInv(s: number[]): void {
  let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
}

function mixColumnsInv(s: number[]): void {
  for (let i = 0; i < 4; i++) {
    const a = s[i * 4], b = s[i * 4 + 1], c = s[i * 4 + 2], d = s[i * 4 + 3];
    const a2 = gfMul2(a), a4 = gfMul2(a2), a8 = gfMul2(a4);
    const b2 = gfMul2(b), b4 = gfMul2(b2), b8 = gfMul2(b4);
    const c2 = gfMul2(c), c4 = gfMul2(c2), c8 = gfMul2(c4);
    const d2 = gfMul2(d), d4 = gfMul2(d2), d8 = gfMul2(d4);
    s[i * 4] = (a8 ^ a4 ^ a2) ^ (b8 ^ b2 ^ b) ^ (c8 ^ c4 ^ c) ^ (d8 ^ d);
    s[i * 4 + 1] = (a8 ^ a) ^ (b8 ^ b4 ^ b2) ^ (c8 ^ c2 ^ c) ^ (d8 ^ d4 ^ d);
    s[i * 4 + 2] = (a8 ^ a4 ^ a) ^ (b8 ^ b) ^ (c8 ^ c4 ^ c2) ^ (d8 ^ d2 ^ d);
    s[i * 4 + 3] = (a8 ^ a2 ^ a) ^ (b8 ^ b4 ^ b) ^ (c8 ^ c) ^ (d8 ^ d4 ^ d2);
  }
}

function addRoundKey(s: number[], k: number[], off: number): void { for (let i = 0; i < 16; i++) s[i] ^= k[off + i]; }

function keyExpansion(key: number[]): number[] {
  const rk = new Array<number>(176).fill(0);
  for (let i = 0; i < 16; i++) rk[i] = key[i];
  for (let i = 4; i < 44; i++) {
    const p = (i - 1) * 4;
    let b0 = rk[p], b1 = rk[p + 1], b2 = rk[p + 2], b3 = rk[p + 3];
    if (i % 4 === 0) {
      const n0 = sbox[b1] ^ rcon[i / 4 - 1], n1 = sbox[b2], n2 = sbox[b3], n3 = sbox[b0];
      b0 = n0; b1 = n1; b2 = n2; b3 = n3;
    }
    const q = (i - 4) * 4;
    b0 ^= rk[q]; b1 ^= rk[q + 1]; b2 ^= rk[q + 2]; b3 ^= rk[q + 3];
    rk[i * 4] = b0; rk[i * 4 + 1] = b1; rk[i * 4 + 2] = b2; rk[i * 4 + 3] = b3;
  }
  return rk;
}

function aes128Decrypt(ek: number[], data: number[]): number[] {
  const s = data.slice();
  addRoundKey(s, ek, 160);
  for (let round = 9; round >= 1; round--) { shiftRowsInv(s); subBytesInv(s); addRoundKey(s, ek, round * 16); mixColumnsInv(s); }
  shiftRowsInv(s); subBytesInv(s); addRoundKey(s, ek, 0);
  return s;
}

/** get_kia_v6_aes_key: both keystores (0 when absent) XORed with the fixed masks, big-endian. */
function aesKey(): number[] {
  const half = (ks: bigint): number[] => {
    const lo = (ks & M32) ^ XOR_MASK_LOW, hi = XOR_MASK_HIGH ^ ((ks >> 32n) & M32);
    return PPMath.u64ToBytesBE((hi << 32n) | lo);
  };
  return half(PPKeys.kiaV6A ?? 0n).concat(half(PPKeys.kiaV6B ?? 0n));
}

/**
 * Kia V6: FM, Manchester at 200 / 400 us (events mapped the other way round from pp_manchester_event) after a
 * preamble of 601+ short pairs and a long sync, 144 bits (stored inverted). The last 16 bytes are AES-128
 * encrypted with a key built from two manufacturer keystores; the plaintext holds serial, button, a 32-bit counter
 * and two CRC bytes. The 32-bit halves are held as unsigned numbers.
 */
export class PPKiaV6 extends PPDecoder {
  private dataPart1Low = 0;
  private dataPart1High = 0;
  private storedPart1Low = 0;
  private storedPart1High = 0;
  private storedPart2Low = 0;
  private storedPart2High = 0;
  private dataPart3 = 0;
  private bitCount = 0;
  private fxField = 0;
  private crc1Field = 0;
  private crc2Field = 0;

  constructor() { super('Kia V6', PPModulation.FM, ppConst(200, 400, 100, 144)); }

  /**
   * kia_v6_decrypt: fills Fx, serial, button, counter and the two CRC bytes (the CRC check result is unused, as
   * in the C).
   */
  private decrypt(): boolean {
    const p1h = this.storedPart1High, p1l = this.storedPart1Low, p2h = this.storedPart2High, p2l = this.storedPart2Low;
    const b = (v: number, s: number): number => (v >>> s) & 0xFF;
    const enc = [b(p1h, 8), b(p1h, 0), b(p1l, 24), b(p1l, 16), b(p1l, 8), b(p1l, 0),
      b(p2h, 24), b(p2h, 16), b(p2h, 8), b(p2h, 0), b(p2l, 24), b(p2l, 16), b(p2l, 8), b(p2l, 0),
      (this.dataPart3 >>> 8) & 0xFF, this.dataPart3 & 0xFF];
    const fx0 = b(p1h, 24), fx1 = b(p1h, 16);
    this.fxField = ((fx0 & 0xF) << 4) | (fx1 & 0xF);
    const dec = aes128Decrypt(keyExpansion(aesKey()), enc);
    const calc = PPMath.crc8(dec.slice(0, 15), 0x07, 0xFF);
    const stored = dec[15];
    this.serial = BigInt((dec[4] << 16) | (dec[5] << 8) | dec[6]);
    this.btn = dec[7];
    this.cnt = BigInt(((dec[8] << 24) | (dec[9] << 16) | (dec[10] << 8) | dec[11]) >>> 0);
    this.crc1Field = dec[12];
    this.crc2Field = dec[15];
    return (calc ^ stored) < 2;
  }

  override reset(): void { this.parserStep = STEP_RESET; this.manchesterAdvance(PPManchester.RESET); }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level) return;
        if (this.dd(duration, c.teShort) < c.teDelta) {
          this.parserStep = STEP_WAIT_FIRST_HIGH; this.teLast = duration; this.headerCount = 0;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      case STEP_WAIT_FIRST_HIGH: {
        if (level) return;
        const diffShort = this.dd(duration, c.teShort), diffLong = this.dd(duration, c.teLong);
        const diff = diffLong < diffShort ? diffLong : diffShort;
        if (diffLong < c.teDelta && diffLong < diffShort && this.headerCount >= 0x259) {
          this.headerCount = 0; this.teLast = duration; this.parserStep = STEP_WAIT_LONG_HIGH;
          return;
        }
        if (diff >= c.teDelta) { this.parserStep = STEP_RESET; return; }
        if (this.dd(this.teLast, c.teShort) < c.teDelta) {
          this.teLast = duration; this.headerCount = (this.headerCount + 1) & 0xFFFF;
        } else this.parserStep = STEP_RESET;
        break;
      }
      case STEP_WAIT_LONG_HIGH:
        if (!level) { this.parserStep = STEP_RESET; return; }
        if (this.dd(duration, c.teLong) >= c.teDelta && this.dd(duration, c.teShort) >= c.teDelta) { this.parserStep = STEP_RESET; return; }
        if (this.dd(this.teLast, c.teLong) >= c.teDelta) { this.parserStep = STEP_RESET; return; }
        this.decodeData = 0n; this.decodeCountBit = 0;
        this.addBit(1); this.addBit(1); this.addBit(0); this.addBit(1);
        this.dataPart1Low = Number(this.decodeData & M32);
        this.dataPart1High = Number((this.decodeData >> 32n) & M32);
        this.bitCount = this.decodeCountBit & 0xFF;
        this.parserStep = STEP_DATA;
        break;
      case STEP_DATA: {
        let ev: number;
        if (this.dd(duration, c.teShort) < c.teDelta) ev = level ? PPManchester.SHORT_HIGH : PPManchester.SHORT_LOW;
        else if (this.dd(duration, c.teLong) < c.teDelta) ev = level ? PPManchester.LONG_HIGH : PPManchester.LONG_LOW;
        else { this.parserStep = STEP_RESET; return; }
        const bit = this.manchesterAdvance(ev);
        if (bit >= 0) {
          const u4 = this.dataPart1Low;
          const u5 = ((u4 << 1) | bit) >>> 0;
          const carry = (u4 >>> 31) & 1;
          const hi = ((this.dataPart1High << 1) | carry) >>> 0;
          this.dataPart1Low = u5; this.dataPart1High = hi;
          // decodeData mirrors (hi << 32) | u5 in the C; nothing reads it, so it is not rebuilt here
          this.bitCount = (this.bitCount + 1) & 0xFF;
          if (this.bitCount === 0x40) {
            this.storedPart1Low = ~u5 >>> 0; this.storedPart1High = ~hi >>> 0; this.dataPart1Low = 0; this.dataPart1High = 0;
          } else if (this.bitCount === 0x80) {
            this.storedPart2Low = ~u5 >>> 0; this.storedPart2High = ~hi >>> 0; this.dataPart1Low = 0; this.dataPart1High = 0;
          }
        }
        this.teLast = duration;
        if (this.bitCount !== c.minBits) return;
        this.dataCountBit = c.minBits;
        this.dataPart3 = ~this.dataPart1Low & 0xFFFF;
        this.decrypt();
        this.emit();
        this.dataPart1Low = 0; this.dataPart1High = 0; this.bitCount = 0;
        this.parserStep = STEP_RESET;
        break;
      }
    }
  }

  override describe(): PPHit {
    this.decrypt();
    const key2Combined = ((this.storedPart2High << 16) | (this.storedPart2Low >>> 16)) >>> 0;
    const key2Second = (this.dataPart3 | (this.storedPart2Low << 16)) >>> 0;
    const line1 = hx('%08X%08X%04X', this.storedPart1High, this.storedPart1Low, this.storedPart2High >>> 16);
    const line2 = hx('%08X%08X', key2Combined, key2Second);
    return { name: this.name, bits: this.dataCountBit, key: line1 + line2, serial: this.serial & 0xFFFFFFn, btn: hx('%01X', this.btn & 0x0F), cnt: this.cnt,
      fields: [{ name: 'Key1', value: line1 }, { name: 'Key2', value: line2 },
        { name: 'Fx', value: hx('%02X', this.fxField) },
        { name: 'CRC1', value: hx('%02X', this.crc1Field) },
        { name: 'CRC2', value: hx('%02X', this.crc2Field) }] };
  }

  /**
   * kia_v6.c get_string: "%s %dbit\r\n%08lX%08lX%04lX\r\n%08lX%08lX Fx:%02X\r\nSer:%06lX Btn:%01X CRC1:%02X\r\n
   * Cnt:%08lX CRC2:%02X".
   */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | ${h.fields[0].value} | ${h.fields[1].value} Fx:${h.fields[2].value} | ` +
      hx('Ser:%06X', h.serial ?? 0n) + ` Btn:${h.btn ?? ''} CRC1:${h.fields[3].value} | ` +
      hx('Cnt:%08X', h.cnt ?? 0n) + ` CRC2:${h.fields[4].value}`;
  }
}
