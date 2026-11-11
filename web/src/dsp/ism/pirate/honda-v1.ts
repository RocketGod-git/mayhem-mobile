/** Port of ProtoPirate protocols/honda_v1.c (decoder and get_string; GPL-3.0). Twin of pirate/PPHondaV1.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_DATA = 2;
const BIT_COUNT = 68, TE_SHORT = 1000, TE_LONG = 2000, TE_DELTA = 400;
const TE_SHORT_MIN = 600, TE_END = 3500;
const VALID_MAX = 0x4B;

const buttonValid = (b: number): boolean => b <= 10 && ((0x701 >>> b) & 1) !== 0;
export function hondaV1ButtonName(b: number): string {
  switch (b) { case 0: return 'Unlock'; case 8: return 'Lock'; case 9: return 'Trunk'; case 10: return 'Panic'; default: return 'Unknown'; }
}
const durationIs = (d: number, t: number): boolean => (d >= t ? d - t <= TE_DELTA : t - d <= TE_DELTA);

function crcFold(v: number): number {
  const lo = v & 0x0F;
  const hi = v >>> 4;
  const s = (hi & 1) !== 0 ? lo : -lo;
  let out = (s - hi) & 7;
  out |= ((v >>> 3) & 1) << 3;
  if (((v >>> 1) & 1) !== 0 && (((v >>> 4) ^ (v >>> 5)) & 1) !== 0) out ^= 0x04;
  return out & 0x0F;
}
function checksumBase(data: bigint): number {
  const a = crcFold(Number(data & 0xFFFFn));
  const b = crcFold(Number((data >> 40n) & 0xFFn));
  return (a ^ b ^ 1) & 0x0F;
}
function checksumAlternate(c: number): number {
  let mask = 0x09;
  if ((c & 1) === 0) mask = (c & 2) !== 0 ? 0x0B : 0x0F;
  return (c ^ mask) & 0x0F;
}
export function hondaV1CrcValid(data: bigint, crc: number): boolean {
  const c = checksumBase(data), o = checksumAlternate(c);
  const f = (c & 0x08) !== 0 ? o : c, s = (c & 0x08) !== 0 ? c : o;
  const k = crc & 0x0F;
  return k === f || k === s;
}

/**
 * Honda V1: AM, 1000 / 2000 us symbols after a preamble with at least one long, 68 bits ending on a gap over 3500 us:
 * 28-bit serial, button nibble, 16-bit counter, then a 4-bit CRC (one of two accepted values).
 */
export class PPHondaV1 extends PPDecoder {
  private preambleCount = 0;
  private preambleHasLong = false;
  private dataPending = false;
  private lastLevel = false;
  private bits: number[] = new Array<number>(12).fill(0);
  private bitCount = 0;
  private pending = 0;
  private pendingValid = false;
  private k2 = 0;

  constructor() { super('Honda V1', PPModulation.AM, ppConst(1000, 2000, 400, 68)); }

  private decodeFields(): void {
    const low = this.data & M32;
    this.serial = (this.data >> 36n) & 0x0FFFFFFFn;
    this.btn = Number((low >> 28n) & 0x0Fn);
    this.cnt = low & 0xFFFFn;
    this.dataCountBit = BIT_COUNT;
  }

  private stateReset(): void {
    this.parserStep = STEP_RESET;
    this.preambleCount = 0; this.preambleHasLong = false; this.dataPending = false; this.lastLevel = false;
    this.bitCount = 0;
    this.bits = new Array<number>(12).fill(0);
  }

  private addBitH(bit: boolean): void {
    if (this.bitCount > VALID_MAX) return;
    if (bit) this.bits[this.bitCount >> 3] |= 1 << (~this.bitCount & 0x07);
    this.bitCount++;
  }

  private commit(): boolean {
    if (this.bitCount < BIT_COUNT) return false;
    const aligned = this.bits.slice();
    let shiftCount = this.bitCount - BIT_COUNT;
    if (shiftCount < 1) shiftCount = 1;
    for (let r = 0; r < shiftCount; r++) {
      for (let i = 0; i < aligned.length - 1; i++) aligned[i] = ((aligned[i] << 1) | (aligned[i + 1] >>> 7)) & 0xFF;
      aligned[aligned.length - 1] = (aligned[aligned.length - 1] << 1) & 0xFF;
    }
    const button = aligned[4] >>> 4;
    if (!buttonValid(button)) return false;
    this.data = PPMath.bytesToU64BE(aligned);
    this.k2 = aligned[8] >>> 4;
    this.decodeFields();
    this.emit();
    return true;
  }

  private symbol(level: boolean, duration: number): void {
    const sh = durationIs(duration, TE_SHORT);
    const lg = durationIs(duration, TE_LONG);
    if (!sh && !lg) {
      if (!level && duration > TE_END && this.parserStep === STEP_DATA) this.commit();
      this.stateReset();
      return;
    }
    if (this.parserStep === STEP_RESET) {
      if (level) { this.parserStep = STEP_PREAMBLE; this.preambleCount = 1; this.lastLevel = level; }
      return;
    }
    if (this.parserStep === STEP_PREAMBLE) {
      if (lg) {
        if (this.preambleCount < 0xFF) this.preambleCount++;
        this.preambleHasLong = true; this.lastLevel = level;
        return;
      }
      if (sh) {
        if (this.preambleHasLong && this.preambleCount > 5) {
          this.parserStep = STEP_DATA;
          this.bitCount = 0;
          this.bits = new Array<number>(12).fill(0);
          this.dataPending = true; this.lastLevel = level;
          return;
        }
        if (this.preambleCount < 0xFF) this.preambleCount++;
        this.lastLevel = level;
        return;
      }
      this.stateReset();
      return;
    }
    if (sh) {
      if (this.dataPending) { this.addBitH(level); this.dataPending = false; this.lastLevel = level; return; }
      this.dataPending = true; this.lastLevel = level;
    } else {
      if (this.dataPending) this.addBitH(level); else this.addBitH(this.lastLevel);
      this.lastLevel = level;
    }
  }

  override reset(): void { super.reset(); this.pending = 0; this.pendingValid = false; this.stateReset(); }

  feed(level: boolean, duration: number): void {
    if (duration < TE_DELTA) { this.pending += duration; this.pendingValid = true; return; }
    if (this.pendingValid) {
      const p = this.pending;
      if (level) { this.pending = p + duration; this.pendingValid = true; return; }
      if (p >= TE_SHORT_MIN) this.symbol(true, p);
      this.pending = 0; this.pendingValid = false;
    }
    if (level) { this.pending = duration; this.pendingValid = true; return; }
    this.symbol(false, duration);
  }

  override describe(): PPHit {
    this.decodeFields();
    const k = this.k2 & 0x0F;
    const ok = hondaV1CrcValid(this.data, k);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hondaV1ButtonName(this.btn), cnt: this.cnt,
      fields: [{ name: 'Crc', value: hx('%X [', k) + (ok ? 'OK' : 'ERR') + ']' }] };
  }

  /** honda_v1.c get_string: "%s %dbit\r\nKey:%016llX\r\nBtn:%s\r\nSn:%07lX Cnt:%04lX\r\nCrc:%X [%s]". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Btn:${h.btn ?? ''} | ` + hx('Sn:%07X Cnt:%04X', h.serial ?? 0n, h.cnt ?? 0n) +
      ` | Crc:${h.fields[0]?.value ?? ''}`;
  }
}
