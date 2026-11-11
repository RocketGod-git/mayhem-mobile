/** Port of ProtoPirate protocols/renault_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPRenaultV0.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, M32, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_DATA = 1;
const MIN_BITS = 0x52, BIT_LIMIT = 0x6D, SYNC_MIN_US = 0x320, DECODED_BITS_MAX = 0x70;
const TE_SHORT_US = 0x7D, TE_LONG_US = 0xFA, TE_DELTA_US = 0x45;
const stateTable = [0x01, 0x91, 0x9B, 0xFB];
/** (low, high) pairs. */
const matrix = [
  0x00000001, 0x00000000, 0x04000029, 0x00000000, 0x0000001B, 0x00000000,
  0x00000000, 0x00000000, 0x00000001, 0x00000000, 0x05220124, 0x00000000,
  0x00000001, 0x00000000, 0x00088410, 0x00000000, 0x60132D1D, 0x00000000,
  0x60170F87, 0x00001004, 0x00000000, 0x00000000, 0x002000A9, 0x00000000,
  0x20863E01, 0x0000100C, 0x24BB3755, 0x00000004, 0x640199A4, 0x00000004,
  0x24225C43, 0x00001004, 0x607886F1, 0x0000100C, 0x6007A101, 0x0000000C,
  0x66672A10, 0x00000004, 0x4651623F, 0x00001008, 0x43380BBF, 0x00001008,
  0x20237F84, 0x00001000, 0x4245755E, 0x00001008, 0x60AAF581, 0x00000004,
  0x22722DAD, 0x0000000C, 0x27C617F7, 0x00000000, 0x46DE8F1B, 0x0000000C,
  0x231DEC51, 0x00000000, 0x03ACAA0B, 0x00000008, 0x22D2BF81, 0x00000004,
  0x626EF6AE, 0x0000100C, 0x40441F95, 0x0000000C, 0x00000001, 0x00000000,
  0x00000000, 0x00000000, 0x20B9A590, 0x00000008, 0x656C8E86, 0x00001008,
  0x60129F96, 0x0000000C, 0x2368F667, 0x00001000, 0x442A1A5C, 0x00000000,
  0x04C43242, 0x0000100C, 0x22198640, 0x00001000, 0x23D6B958, 0x00001008,
];

const buttonValid = (b: number): boolean => b === 0x05 || b === 0x06 || b === 0x0A;
const buttonName = (b: number): string => (b === 0x05 ? 'Trunk' : b === 0x06 ? 'Lock' : b === 0x0A ? 'Unlock' : '?');
function checksum(data: bigint, key2: bigint): number {
  const bytes = PPMath.u64ToBytesBE(data);
  bytes.push(Number((key2 >> 10n) & 0xFFn), Number((key2 >> 2n) & 0xFFn));
  return PPMath.xorBytes(bytes);
}
function parity32(v0: number): number {
  let v = v0 >>> 0; v ^= v >>> 16; v ^= v >>> 8; v ^= v >>> 4; v ^= v >>> 2; v ^= v >>> 1;
  return v & 1;
}
/** [data, key2] */
function buildKey(serial: bigint, button: number, counter: number): [bigint, bigint] {
  const vars = new Array<number>(7).fill(0);
  vars[0] = button === 0x0A ? 1 : 0;
  for (let bit = 0; bit < 6; bit++) vars[bit + 1] = (counter >>> bit) & 1;
  let mask = 1n;   // the split low/high 32-bit masks as one 64-bit value
  let maskBit = 1;
  for (let i = 0; i < 7; i++) { if (vars[i]) mask |= 1n << BigInt(maskBit); maskBit++; }
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 7; j++) { if (vars[i] & vars[j]) mask |= 1n << BigInt(maskBit); maskBit++; }
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 7; j++) {
    for (let k = j + 1; k < 7; k++) { if (vars[i] & vars[j] & vars[k]) mask |= 1n << BigInt(maskBit); maskBit++; }
  }
  mask &= MASK64;
  const maskLow = Number(mask & M32), maskHigh = Number((mask >> 32n) & M32);
  const parity = new Array<number>(matrix.length / 2);
  for (let i = 0; i < parity.length; i++) parity[i] = parity32((matrix[2 * i] & maskLow) ^ (matrix[2 * i + 1] & maskHigh));
  if (counter & 0x40) parity[41] ^= 1;
  if ((counter >>> 7) !== 0) parity[40] ^= 1;
  let dataLow = counter * 0x1000000;
  const dataHigh = ((serial << 8n) | BigInt(button)) & M32;
  for (let i = 0; i < 24; i++) if (parity[i]) dataLow += 1 << (23 - i);
  let k2 = 0;
  for (let i = 24; i < 42; i++) if (parity[i]) k2 |= 1 << (41 - i);
  return [((dataHigh << 32n) | BigInt(dataLow)) & MASK64, BigInt(k2)];
}
function type13Valid(data: bigint, key2: bigint): boolean {
  const button = Number((data >> 32n) & 0xFFn);
  const cs = checksum(data, key2);
  if ((cs & 0x3F) !== 0x13) return false;
  if (Number(key2 & 0x03n) !== cs >>> 6) return false;
  return buttonValid(button);
}

/** -1 when the duration fits neither cell. */
function classify(duration: number, level: boolean): number {
  const lv = level ? 1 : 0;
  if (duration <= TE_SHORT_US - 1) {
    if (TE_SHORT_US - duration > TE_DELTA_US) return -1;
    return (lv ^ 1) << 1;
  }
  if (duration <= TE_LONG_US - 1) {
    const shortDelta = duration - TE_SHORT_US, longInv = TE_LONG_US - duration;
    if (shortDelta <= TE_DELTA_US) return longInv > TE_DELTA_US ? (lv ^ 1) << 1 : (level ? 4 : 6);
    if (longInv <= TE_DELTA_US) return level ? 4 : 6;
    return -1;
  }
  if (duration - TE_LONG_US > TE_DELTA_US) return -1;
  return level ? 4 : 6;
}

/**
 * Renault V0: AM, a sync mark of 800+ us, then Manchester at 125 / 250 us; a run of preamble 1 bits, then 64 bits
 * (24-bit serial, button byte, counter byte, 24 parity bits) and an 18-bit Key2. Accepted when the XOR checksum and
 * button are valid (C1/C2); IC rebuilds the parity bits from the 42-row matrix and compares.
 */
export class PPRenaultV0 extends PPDecoder {
  private packetBitCount = 0;
  private checkC1 = 0;
  private checkC2 = 0;
  private checkIc = 0;
  private key2 = 0n;
  private mState = 1;
  private readonly decodedBits = new Uint8Array(DECODED_BITS_MAX);
  private decodedBitCount = 0;   // uint8

  constructor() { super('Renault V0', PPModulation.AM, ppConst(0x7D, 0xFA, 0x45, 0x52)); }

  override reset(): void { this.parserStep = STEP_RESET; this.mState = 1; this.decodedBitCount = 0; this.key2 = 0n; }

  private decodeCandidate(): void {
    const bitCount = this.decodedBitCount;
    if (bitCount <= 0x51) return;
    const bits = this.decodedBits;
    let preamble = 0;
    while (preamble < bitCount && bits[preamble] === 1) preamble++;
    if (preamble <= 9) return;
    if (((bitCount - preamble) & 0xFF) <= 0x51) return;
    const p = preamble;
    let d = 0n;
    for (let i = 0; i < 64; i++) d = (d << 1n) | BigInt(bits[p + i] & 1);
    let k2 = 0n;
    for (let i = 0; i < 18; i++) k2 = (k2 << 1n) | BigInt(bits[p + 64 + i] & 1);
    if (!type13Valid(d, k2)) { this.packetBitCount = 0; this.dataCountBit = 0; return; }
    const fs = (d >> 40n) & M32, fb = Number((d >> 32n) & 0xFFn), fc = Number(((d & M32) >> 24n) & 0xFFn);
    this.data = d; this.decodeData = d; this.decodeCountBit = MIN_BITS;
    this.packetBitCount = MIN_BITS; this.dataCountBit = MIN_BITS;
    this.key2 = k2; this.serial = fs; this.btn = fb; this.cnt = BigInt(fc);
    const cs = checksum(d, k2);
    this.checkC1 = (cs & 0x3F) === 0x13 ? 0 : 1;
    this.checkC2 = Number(k2 & 0x03n) === cs >>> 6 ? 0 : 1;
    const rebuilt = buildKey(fs, fb, fc);
    this.checkIc = rebuilt[0] === d && rebuilt[1] === k2 ? 0 : 1;
    this.emit();
  }

  feed(level: boolean, duration: number): void {
    if (this.parserStep === STEP_RESET) {
      if (level && duration >= SYNC_MIN_US) { this.parserStep = STEP_DATA; this.decodedBitCount = 0; this.mState = 1; }
      return;
    }
    if (this.decodedBitCount > BIT_LIMIT) { this.decodeCandidate(); this.parserStep = STEP_RESET; return; }
    const ev = classify(duration, level);
    if (ev < 0) {
      this.decodeCandidate();
      if (level && duration >= SYNC_MIN_US) { this.parserStep = STEP_DATA; this.decodedBitCount = 0; this.mState = 1; }
      else this.parserStep = STEP_RESET;
      return;
    }
    const state = this.mState & 0x03;
    const next = (stateTable[state] >>> ev) & 0x03;
    if (next === state) return;   // the C keeps its state here (Flipper's manchester_advance would reset to Mid1)
    this.mState = next;
    if (next === 1 || next === 2) {
      this.decodedBits[this.decodedBitCount] = next === 1 ? 1 : 0;
      this.decodedBitCount = (this.decodedBitCount + 1) & 0xFF;
    }
  }

  override describe(): PPHit {
    return { name: this.name, bits: this.packetBitCount, key: hx('%016X', this.data), serial: this.serial, btn: hx('%01X', this.btn), cnt: this.cnt,
      fields: [
        { name: 'Key2', value: hx('%05X', this.key2) },
        { name: 'Button', value: buttonName(this.btn) },
        { name: 'C1', value: this.checkC1 ? 'ERR' : 'OK' },
        { name: 'C2', value: this.checkC2 ? 'ERR' : 'OK' },
        { name: 'IC', value: this.checkIc ? 'ERR' : 'OK' },
      ] };
  }

  /**
   * renault_v0.c get_string: "%s %ubit\r\n" then "Key:%016llX\r\nKey2:%05lX Sn:%06lX\r\nBtn:%01X [%s] Cnt:%02lX\r\n
   * C1:[%s] C2:[%s] IC:[%s]".
   */
  override cString(h: PPHit): string {
    const f = h.fields;
    return `${h.name} ${h.bits}bit | Key:${h.key} | Key2:${f[0].value} ` + hx('Sn:%06X', h.serial ?? 0n) +
      ` | Btn:${h.btn ?? ''} [${f[1].value}] ` + hx('Cnt:%02X', h.cnt ?? 0n) +
      ` | C1:[${f[2].value}] C2:[${f[3].value}] IC:[${f[4].value}]`;
  }
}
