/** Port of ProtoPirate protocols/renault_v1.c (decoder and get_string; GPL-3.0). Twin of pirate/PPRenaultV1.kt. */
import { PPDecoder, PPModulation, PPManchester, PPMath, ppConst, hx, M32, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_SYNC = 2, STEP_DATA = 3;
const HEADER_BITS = 16, KEY_END_BITS = 80, LONG_FRAME_BITS = 104, MIN_COUNT_BIT = 88;
const HEADER_LOW_MIN = 1150, HEADER_LOW_MAX = 2200, HEADER_HIGH_MIN = 800, HEADER_HIGH_MAX = 1150;
const DATA_IGNORE_US = 49, DATA_RESET_US = 520, TE_HIGH_INIT = 120, TE_LOW_INIT = 150;
const buttonNames = ['Sync', 'Lock', 'Unlock', '??', 'Trunk', '??', '??', '??', 'Panic'];

const buttonName = (b: number): string => (b < buttonNames.length ? buttonNames[b] : '??');
function packKeyBytes(key: bigint, key2: bigint): number[] {
  const b = PPMath.u64ToBytesBE(key);
  b.push(Number((key2 >> 16n) & 0xFFn), Number((key2 >> 8n) & 0xFFn), Number(key2 & 0xFFn));
  return b;
}
function frameXor(raw: number[]): number { let v = 0; for (let i = 0; i < 10; i++) v ^= raw[i]; return v; }
function dataThreshold(te: number): number {
  const triple = te * 3;
  if (triple < 300) return 150;
  if (triple >= 422) return 210;
  return Math.trunc(triple / 2);
}
function adaptTe(te: number, duration: number): number {
  const mixed = te * 7 + duration;
  if (mixed < 560) return 70;
  if (mixed >= 1488) return 185;
  return Math.trunc(mixed / 8) & 0xFFFF;
}
const isHeaderLow = (d: number): boolean => d >= HEADER_LOW_MIN && d <= HEADER_LOW_MAX;

/**
 * Renault V1 (Hitag2): a 1500 us low / 1000 us high sync, then inverted Manchester at ~125 us with adaptive short/long
 * thresholds (one per level); a 16-bit header (must read 1), 64 bits (32-bit UID, 4-bit button, 10-bit counter, the
 * top of a 32-bit hop), and a 24-bit Key2 (rest of the hop, 2 tail bits, an XOR byte). ProtoPirate registers it on
 * both the AM and FM routes (by preset modulation); it is listed here as AM. The live decoder never has a Hitag2 key
 * or a brute-forced seed, so it always shows Cnt/Hop and KEY:??, as the C does.
 */
export class PPRenaultV1 extends PPDecoder {
  private teHigh = 0;
  private teLow = 0;
  private header = 0;
  private hop = 0n;
  private tailBits = 0;
  private lastData = 0n;
  private lastData2 = 0n;
  private lastFrameValid = false;
  private data2 = 0n;

  constructor() { super('Renault V1', PPModulation.AM, ppConst(125, 250, 50, 88)); this.manchester = PPManchester.START1; }

  override reset(): void {
    this.parserStep = STEP_RESET;
    this.manchesterAdvance(PPManchester.RESET);
  }

  /** hitag2_unpack_frame (recovered = 0, so the counter is the frame's 10-bit counter). */
  private unpack(): void {
    const raw = packKeyBytes(this.data, this.data2);
    this.serial = (this.data >> 32n) & M32;
    this.btn = (raw[4] >>> 4) & 0x0F;
    this.cnt = BigInt(((raw[4] & 0x0F) << 6) | (raw[5] >>> 2));
    this.hop = BigInt((((raw[5] & 3) << 30) | (raw[6] << 22) | (raw[7] << 14) | (raw[8] << 6) | (raw[9] >>> 2)) >>> 0);
    this.tailBits = raw[9] & 3;
  }

  private acceptFrame(key2: bigint): boolean {
    if (this.header !== 1) return false;
    const raw = packKeyBytes(this.data, key2);
    if (frameXor(raw) !== raw[10]) return false;
    if (this.lastFrameValid && this.lastData === this.data && this.lastData2 === key2) return false;
    this.data2 = key2;
    this.dataCountBit = MIN_COUNT_BIT;
    this.unpack();
    this.lastData = this.data; this.lastData2 = key2; this.lastFrameValid = true;
    return true;
  }

  feed(level: boolean, duration: number): void {
    for (;;) {
      switch (this.parserStep) {
        case STEP_RESET:
          if (!level && isHeaderLow(duration)) { this.teLast = duration; this.parserStep = STEP_CHECK_SYNC; }
          return;
        case STEP_CHECK_SYNC:
          if (level) {
            if (duration < HEADER_HIGH_MIN || duration > HEADER_HIGH_MAX || this.teLast < HEADER_LOW_MIN || this.teLast > HEADER_LOW_MAX) {
              this.parserStep = STEP_RESET;
              return;
            }
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.manchester = PPManchester.START1;
            this.teHigh = TE_HIGH_INIT; this.teLow = TE_LOW_INIT;
            this.parserStep = STEP_DATA;
            return;
          }
          this.parserStep = STEP_RESET;
          if (isHeaderLow(duration)) { this.teLast = duration; this.parserStep = STEP_CHECK_SYNC; }
          return;
        case STEP_DATA: {
          if (duration <= DATA_IGNORE_US) return;
          if (duration > DATA_RESET_US) { this.parserStep = STEP_RESET; continue; }
          const te = level ? this.teHigh : this.teLow;
          let event: number;
          if (duration > dataThreshold(te)) {
            event = level ? PPManchester.LONG_HIGH : PPManchester.LONG_LOW;
          } else {
            event = level ? PPManchester.SHORT_HIGH : PPManchester.SHORT_LOW;
            if (level) this.teHigh = adaptTe(te, duration); else this.teLow = adaptTe(te, duration);
          }
          const bit = this.manchesterAdvance(event);
          if (bit < 0) return;
          this.decodeData = ((this.decodeData << 1n) | BigInt(bit)) & MASK64;
          this.decodeCountBit++;
          if (this.decodeCountBit === HEADER_BITS) {
            this.header = Number(~this.decodeData & 0xFFFFn);
            this.decodeData = 0n;
            return;
          }
          if (this.decodeCountBit === KEY_END_BITS) {
            this.data = ~this.decodeData & MASK64;
            this.decodeData = 0n;
            return;
          }
          if (this.decodeCountBit === LONG_FRAME_BITS) {
            const key2 = ~this.decodeData & 0xFFFFFFn;
            if (this.acceptFrame(key2)) this.emit();
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.parserStep = STEP_DATA;
          }
          return;
        }
        default:
          this.parserStep = STEP_RESET;
          return;
      }
    }
  }

  override describe(): PPHit {
    this.unpack();   // get_string runs renault_v1_check_remote_controller first
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hx('%02X', this.btn), cnt: this.cnt,
      fields: [
        { name: 'K2', value: hx('%06X', this.data2 & 0xFFFFFFn) },
        { name: 'Button', value: buttonName(this.btn) },
        { name: 'Hop', value: hx('%08X', this.hop) },
        { name: 'Tail', value: `${this.tailBits}` },
        { name: 'KEY', value: '??' },
      ] };
  }

  /**
   * renault_v1.c get_string (recovered = 0, no Hitag2 key): "%s\r\nK1:%016llX\r\nK2:%06llX Sn:%08lX\r\n
   * Btn:%02X [%s] %db" then "\r\nCnt:%03lX Hop:%08lX" and "\r\nKEY:??".
   */
  override cString(h: PPHit): string {
    const f = h.fields;
    return `${h.name} | K1:${h.key} | K2:${f[0].value} ` + hx('Sn:%08X', h.serial ?? 0n) +
      ` | Btn:${h.btn ?? ''} [${f[1].value}] ${h.bits}b | ` + hx('Cnt:%03X', (h.cnt ?? 0n) & 0x3FFn) +
      ` Hop:${f[2].value} | KEY:${f[4].value}`;
  }
}
