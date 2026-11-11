/** Port of ProtoPirate protocols/kia_v1.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV1.kt. */
import { PPDecoder, PPModulation, PPManchester, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_DECODE_DATA = 2;

function crc4(bytes: number[], offset: number): number {
  let crc = 0;
  for (const b of bytes) crc ^= (b & 0x0F) ^ (b >>> 4);
  return (crc + offset) & 0x0F;
}

const buttonName = (b: number): string => (b === 1 ? 'Close' : b === 2 ? 'Open' : b === 3 ? 'Boot' : '??');

/**
 * Kia V1: AM, Manchester at 800 / 1600 us after a long-pair header, 57 bits: a 32-bit serial, an 8-bit button, a
 * 12-bit counter and a CRC nibble.
 */
export class PPKiaV1 extends PPDecoder {
  private crc = 0;
  private crcCheck = false;

  constructor() { super('Kia V1', PPModulation.AM, ppConst(800, 1600, 200, 57)); this.manchester = PPManchester.START1; }   // calloc'd state

  /** kia_v1_check_remote_controller */
  private checkRemoteController(): void {
    const d = this.data;
    this.serial = (d >> 24n) & M32;
    this.btn = Number((d >> 16n) & 0xFFn);
    this.cnt = (((d >> 4n) & 0xFn) << 8n) | ((d >> 8n) & 0xFFn);
    const cntHigh = Number((this.cnt >> 8n) & 0xFn);
    const s = Number(this.serial);
    const bytes = [(s >>> 24) & 0xFF, (s >>> 16) & 0xFF, (s >>> 8) & 0xFF, s & 0xFF, this.btn, Number(this.cnt & 0xFFn), cntHigh];
    this.crc = crc4(bytes, 1);
    this.crcCheck = this.crc === Number(d & 0xFn);
  }

  override reset(): void { this.parserStep = STEP_RESET; }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, c.teLong) < c.teDelta) {
          this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 0;
          this.decodeData = 0n; this.decodeCountBit = 0;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      case STEP_CHECK_PREAMBLE:
        if (!level) {
          if (this.dd(duration, c.teLong) < c.teDelta && this.dd(this.teLast, c.teLong) < c.teDelta) {
            this.headerCount = (this.headerCount + 1) & 0xFFFF; this.teLast = duration;
          } else this.parserStep = STEP_RESET;
        }
        if (this.headerCount > 70) {
          if (!level && this.dd(duration, c.teShort) < c.teDelta && this.dd(this.teLast, c.teLong) < c.teDelta) {
            this.decodeCountBit = 1;
            this.addBit(1);
            this.headerCount = 0;
            this.parserStep = STEP_DECODE_DATA;
          }
        }
        break;
      case STEP_DECODE_DATA: {
        const ev = this.manchesterEvent(duration, level);
        if (ev !== PPManchester.RESET) {
          const bit = this.manchesterAdvance(ev);
          if (bit >= 0) this.addBit(bit);
        }
        if (this.decodeCountBit === c.minBits) {
          this.data = this.decodeData; this.dataCountBit = this.decodeCountBit;
          this.emit();
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    this.checkRemoteController();
    const hi = (this.data >> 32n) & M32, lo = this.data & M32;
    return { name: this.name, bits: this.dataCountBit, key: hx('%06X%08X', hi, lo), serial: this.serial, btn: hx('%02X:', this.btn) + buttonName(this.btn), cnt: this.cnt,
      fields: [{ name: 'CRC', value: hx('%01X ', this.crc) + (this.crcCheck ? 'OK' : 'WRONG') }] };
  }

  /** kia_v1.c get_string: "%s %dbit\r\nKey:%06lX%08lX\r\nSerial:%08lX\r\nCnt:%03lX CRC:%01X %s\r\nBtn:%02X:%s\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Serial:%08X', h.serial ?? 0n) + ' | ' +
      hx('Cnt:%03X', h.cnt ?? 0n) + ` CRC:${h.fields[0]?.value ?? ''} | Btn:${h.btn ?? ''}`;
  }
}
