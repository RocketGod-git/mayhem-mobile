/** Port of ProtoPirate protocols/kia_v7.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV7.kt. */
import { PPDecoder, PPModulation, PPManchester, PPMath, ppConst, hx, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_SYNC_LOW = 2, STEP_DATA = 3;
const HEADER = 0x4C;

const buttonName = (b: number): string => (b === 1 ? 'Lock' : b === 2 ? 'Unlock' : b === 3 || b === 8 ? 'Trunk' : '??');

/**
 * Kia V7: FM, Manchester at 250 / 500 us (events mapped the other way round from pp_manchester_event) after a
 * short-pair preamble and a long/short sync. 64 bits, stored inverted: a 0x4C header byte, a 16-bit counter, a
 * 28-bit serial, a button nibble and a CRC-8 (poly 0x7F, init 0x4C). Only frames with a good CRC are reported.
 */
export class PPKiaV7 extends PPDecoder {
  private preambleCount = 0;
  private decodedButton = 0;
  private crcCalculated = 0;
  private crcValid = false;

  constructor() { super('Kia V7', PPModulation.FM, ppConst(250, 500, 100, 64)); this.manchester = PPManchester.START1; }   // calloc'd state

  /** kia_v7_decode_key_common */
  private decodeKey(): void {
    const b = PPMath.u64ToBytesBE(this.data);
    const ser = (BigInt(b[3]) << 20n) | (BigInt(b[4]) << 12n) | (BigInt(b[5]) << 4n) | BigInt(b[6] >>> 4);
    const counter = (b[1] << 8) | b[2];
    const button = b[6] & 0x0F;
    const calc = PPMath.crc8(b.slice(0, 7), 0x7F, 0x4C);
    this.serial = ser & 0x0FFFFFFFn; this.btn = button; this.cnt = BigInt(counter); this.dataCountBit = 64;
    this.decodedButton = button; this.crcCalculated = calc; this.crcValid = calc === b[7];
  }

  override reset(): void {
    this.parserStep = STEP_RESET; this.teLast = 0; this.decodeData = 0n; this.decodeCountBit = 0; this.preambleCount = 0;
    this.manchesterAdvance(PPManchester.RESET);
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.isShort(duration)) {
          this.parserStep = STEP_PREAMBLE; this.teLast = duration; this.preambleCount = 0;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      case STEP_PREAMBLE:
        if (level) {
          if (this.isLong(duration) && this.isShort(this.teLast)) {
            if (this.preambleCount > 15) {
              this.decodeData = 0n; this.decodeCountBit = 0; this.preambleCount = 0;
              this.addBit(1); this.addBit(0); this.addBit(1); this.addBit(1);
              this.teLast = duration;
              this.parserStep = STEP_SYNC_LOW;
            } else this.parserStep = STEP_RESET;
          } else if (this.isShort(duration)) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        } else {
          if (this.isShort(duration) && this.isShort(this.teLast)) this.preambleCount = (this.preambleCount + 1) & 0xFFFF;
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SYNC_LOW:
        if (!level && this.isShort(duration) && this.isLong(this.teLast)) { this.teLast = duration; this.parserStep = STEP_DATA; }
        break;
      case STEP_DATA: {
        const sh = this.isShort(duration);
        if (sh || this.isLong(duration)) {
          const ev = sh ? (level ? PPManchester.SHORT_HIGH : PPManchester.SHORT_LOW) : (level ? PPManchester.LONG_HIGH : PPManchester.LONG_LOW);
          const bit = this.manchesterAdvance(ev);
          if (bit >= 0) this.addBit(bit);
        }
        if (this.decodeCountBit === 64) {
          const candidate = ~this.decodeData & MASK64;
          if (Number((candidate >> 56n) & 0xFFn) === HEADER) {
            this.data = candidate; this.dataCountBit = 64;
            this.decodeKey();
            if (this.crcValid) this.emit(); else { this.data = 0n; this.dataCountBit = 0; }
          }
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    this.decodeKey();
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial & 0x0FFFFFFFn,
      btn: hx('%01X [', this.decodedButton & 0x0F) + buttonName(this.decodedButton) + ']', cnt: this.cnt & 0xFFFFn,
      fields: [{ name: 'CRC', value: hx('%02X [', this.crcCalculated) + (this.crcValid ? 'OK' : 'ERR') + ']' }] };
  }

  /** kia_v7.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%07lX Cnt:%04lX\r\nBtn:%01X [%s] CRC:%02X [%s]". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%07X Cnt:%04X', h.serial ?? 0n, h.cnt ?? 0n) +
      ` | Btn:${h.btn ?? ''} CRC:${h.fields[0]?.value ?? ''}`;
  }
}
