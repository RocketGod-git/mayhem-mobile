/** Port of ProtoPirate protocols/chrysler_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPChryslerV0.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, MASK64, L, type PPField, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_SEEK = 1, STEP_DATA = 2;
const TE_SHORT_US = 0x12C, TE_DELTA_US = 0x96, TE_LONG_A = 0xD48;
const TE_LONG_B = 0xE74, TE_LONG_DELTA = 0x190;
const TE_GAP = 0x1F40, DECODE_BIT_COUNT = 0x50;
const xorTable = [0x0F, 0x02, 0x40, 0x0C, 0x30, 0x0E, 0x70, 0x08, 0x10, 0x0A, 0x50, 0xF4, 0x2F, 0xF6, 0x6F, 0xF0];

function reverse6(v0: number): number {
  let out = 0; let v = v0;
  for (let i = 0; i < 6; i++) { out = ((out << 1) | (v & 1)) & 0xFF; v >>>= 1; }
  return out;
}
function transform(input: number[], key: number, button: number): number[] {
  let mask = xorTable[key & 0x0F];
  if (button === 1) mask ^= (key & 1) !== 0 ? 0xF0 : 0x0F;
  return input.map((b) => b ^ mask);
}
const isShortD = (d: number): boolean => Math.abs(d - TE_SHORT_US) <= TE_DELTA_US;
const isLongMark = (d: number): boolean => Math.abs(d - TE_LONG_A) <= TE_LONG_DELTA || Math.abs(d - TE_LONG_B) <= TE_LONG_DELTA;
const buttonName = (b: number): string => (b === 1 ? 'Lock' : b === 2 ? 'Unlock' : '??');

/**
 * Chrysler V0: AM, PWM with a 300 us short mark and ~3400 / 3700 us long gaps, a preamble of 16+ short/long pairs,
 * 80 bits (64 + a 16-bit second key). A 6-bit seed from the first byte picks an XOR mask that unmasks either block A
 * (serial A) or block B (serial B); the decoder remembers both across frames, as the C does.
 */
export class PPChryslerV0 extends PPDecoder {
  private packetBitCount = 0;   // uint16
  private decodedButton = 0;
  private plainAPresent = false;
  private plainBPresent = false;
  private checkOk = false;
  private snB = 0n;
  private data2 = 0;            // uint16
  private seed = 0;

  constructor() { super('Chrysler V0', PPModulation.AM, ppConst(0x12C, 0xD48, 0x96, 0x50)); }

  override reset(): void {
    this.decodeData = 0n; this.data2 = 0; this.seed = 0; this.parserStep = STEP_RESET; this.decodeCountBit = 0;
    this.packetBitCount = 0; this.teLast = 0; this.plainAPresent = false; this.plainBPresent = false; this.snB = 0n;
  }

  private decodePacket(): void {
    const key2 = this.data2;
    const key = PPMath.u64ToBytesBE(this.data);
    this.seed = reverse6(key[0] >>> 2);
    const b1xb6 = key[6] ^ key[1];
    if (key[0] & 0x80) {
      const key2Low = key2 & 0xFF;
      this.checkOk = key[1] === key[5] && b1xb6 === 0x62;
      this.decodedButton = (key2Low ^ key[4]) === 0x10 ? 2 : 1;
    } else {
      this.checkOk = false;
      this.decodedButton = 1;
      if ((key[1] ^ 0xC3) === key[5]) {
        if (b1xb6 === 0x04) this.checkOk = true;
        else { this.checkOk = b1xb6 === 0x08; if (b1xb6 === 0x08) this.decodedButton = 2; }
      } else if (b1xb6 === 0x08) this.decodedButton = 2;
    }
    const encoded = [key[1], key[2], key[3], key[4], key[5], key[6], key[7], (key2 >>> 8) & 0xFF, key2 & 0xFF];
    const d = transform(encoded, this.seed, this.decodedButton);
    if (this.seed & 1) {
      this.plainBPresent = true;
      this.snB = BigInt(((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[7]) >>> 0);
    } else {
      this.plainAPresent = true;
      this.cnt = BigInt(((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0);
    }
    this.btn = this.decodedButton;
  }

  private commit(): void {
    this.packetBitCount = DECODE_BIT_COUNT;
    this.decodeCountBit = DECODE_BIT_COUNT;
    this.dataCountBit = DECODE_BIT_COUNT;
    this.decodePacket();
    if (this.checkOk) this.emit();
  }

  private endFrame(count: number): void {
    if (count > 0x4F) { this.data = this.decodeData; this.commit(); }
    this.parserStep = STEP_RESET;
    this.packetBitCount = 0;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && isShortD(duration)) { this.packetBitCount = 0; this.teLast = duration; this.parserStep = STEP_SEEK; }
        break;
      case STEP_SEEK:
        if (level) { this.teLast = duration; return; }
        if (isLongMark(duration)) {
          if (isShortD(this.teLast)) this.packetBitCount = (this.packetBitCount + 1) & 0xFFFF;
          else if (this.packetBitCount > 0x0F) {
            this.data2 = 0; this.parserStep = STEP_DATA; this.decodeData = 1n; this.decodeCountBit = 1;
          } else { this.packetBitCount = 0; this.parserStep = STEP_SEEK; }
          return;
        }
        if (duration > TE_GAP && this.packetBitCount > 0x0F) {
          this.decodeData = 0n; this.data2 = 0; this.decodeCountBit = 0; this.parserStep = STEP_DATA;
          return;
        }
        this.parserStep = STEP_RESET;
        this.packetBitCount = 0;
        break;
      case STEP_DATA: {
        if (level) { this.teLast = duration; return; }
        const count = this.decodeCountBit & 0xFF;
        if (duration > TE_GAP) { this.endFrame(count); return; }
        let bitValue: number;
        if (this.teLast < TE_SHORT_US) {
          if (!isShortD(this.teLast) || !isLongMark(duration)) { this.endFrame(count); return; }
          bitValue = 1;
        } else {
          if (this.teLast > 0x2EE || !isLongMark(duration)) { this.endFrame(count); return; }
          bitValue = isShortD(this.teLast) ? 1 : 0;
        }
        const bit = bitValue ^ 1;
        const newCount = (count + 1) & 0xFF;
        if (count <= 0x3F) {
          this.decodeData = ((this.decodeData << 1n) | BigInt(bit)) & MASK64;
          this.decodeCountBit = newCount;
          return;
        }
        this.data2 = ((this.data2 << 1) | bit) & 0xFFFF;
        this.decodeCountBit = newCount;
        if (newCount !== DECODE_BIT_COUNT) return;
        this.data = this.decodeData;
        this.commit();
        this.decodeData = 0n; this.data2 = 0; this.decodeCountBit = 0;
        this.parserStep = STEP_RESET;
        this.packetBitCount = 0;
        break;
      }
      default: this.parserStep = STEP_RESET;
    }
  }

  override describe(): PPHit {
    const f: PPField[] = [];
    if (this.plainAPresent) f.push({ name: 'SnA', value: hx('%08X', this.cnt) });
    if (this.plainBPresent) f.push({ name: 'SnB', value: hx('%08X', this.snB) });
    f.push({ name: 'Button', value: buttonName(this.decodedButton) });
    f.push({ name: 'Cnt', value: hx('%02X', this.seed) });
    f.push({ name: 'Chk', value: this.checkOk ? 'OK' : 'ERR' });
    return { name: this.name, bits: this.packetBitCount, key: hx('%016X%04X', this.data, this.data2),
      serial: this.plainBPresent ? this.snB : this.cnt, btn: hx('%02X', this.decodedButton), cnt: L(this.seed), fields: f };
  }

  /**
   * chrysler_v0.c get_string: "%s %dbit\r\n%016llX%04X\r\n", then "SnA:%08lX\r\n" and/or "SnB:%08lX\r\n" for the
   * blocks seen so far, then "Btn:%02X [%s] Cnt:%02X\r\nChk:%s".
   */
  override cString(h: PPHit): string {
    const parts = [`${h.name} ${h.bits}bit`, h.key];
    for (const fl of h.fields) if (fl.name === 'SnA' || fl.name === 'SnB') parts.push(`${fl.name}:${fl.value}`);
    const v = new Map<string, string>();
    for (const fl of h.fields) if (!v.has(fl.name)) v.set(fl.name, fl.value);
    parts.push(`Btn:${h.btn ?? ''} [${v.get('Button')}] Cnt:${v.get('Cnt')}`);
    parts.push(`Chk:${v.get('Chk')}`);
    return parts.join(' | ');
  }
}
