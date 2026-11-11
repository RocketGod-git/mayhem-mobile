/** Port of ProtoPirate protocols/kia_v2.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV2.kt. */
import { PPDecoder, PPModulation, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_COLLECT_RAW_BITS = 2;

function crc(data: bigint): number {
  const d = data >> 4n;
  let c = 0;
  for (let i = 0; i < 6; i++) { const b = Number((d >> BigInt(8 * i)) & 0xFFn); c ^= (b & 0x0F) ^ (b >>> 4); }
  return (c + 1) & 0x0F;
}

/**
 * Kia V2: AM, Manchester at 500 / 1000 us, a long header of 1000 us pairs, 53 bits: serial, button, a 12-bit counter
 * stored nibble-swapped, and a CRC nibble.
 */
export class PPKiaV2 extends PPDecoder {
  constructor() { super('Kia V2', PPModulation.AM, ppConst(500, 1000, 150, 53)); }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, c.teLong) < c.teDelta) {
          this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 0;
          this.manchesterAdvance(8);
        }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) {
          if (this.dd(duration, c.teLong) < c.teDelta) { this.teLast = duration; this.headerCount++; }
          else if (this.dd(duration, c.teShort) < c.teDelta) {
            if (this.headerCount >= 100) {
              this.headerCount = 0; this.decodeData = 0n; this.decodeCountBit = 1; this.parserStep = STEP_COLLECT_RAW_BITS;
              this.addBit(1);
            } else this.teLast = duration;
          } else this.parserStep = STEP_RESET;
        } else {
          if (this.dd(duration, c.teLong) < c.teDelta) { this.headerCount++; this.teLast = duration; }
          else if (this.dd(duration, c.teShort) < c.teDelta) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_COLLECT_RAW_BITS: {
        const ev = this.manchesterEvent(duration, level);
        if (ev === 8) { this.parserStep = STEP_RESET; return; }
        const bit = this.manchesterAdvance(ev);
        if (bit >= 0) {
          this.decodeData = (this.decodeData << 1n) | BigInt(bit);
          this.decodeCountBit++;
          if (this.decodeCountBit === 53) {
            this.data = this.decodeData; this.dataCountBit = this.decodeCountBit;
            this.serial = (this.data >> 20n) & M32;
            this.btn = Number((this.data >> 16n) & 0x0Fn);
            const raw = Number((this.data >> 4n) & 0xFFFn);
            this.cnt = BigInt(((raw >>> 4) | (raw << 8)) & 0xFFF);
            this.emit();
            this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0; this.parserStep = STEP_RESET;
          }
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    const k = Number(this.data & 0x0Fn);
    const ok = k === crc(this.data);
    return { name: this.name, bits: this.dataCountBit, key: hx('%013X', this.data), serial: this.serial, btn: hx('%X', this.btn), cnt: this.cnt,
      fields: [{ name: 'CRC', value: hx('%X', k) + ' - ' + (ok ? 'OK' : 'BAD') }] };
  }

  /** kia_v2.c get_string: "%s %dbit\r\nKey:%013llX\r\nSn:%08lX Btn:%X\r\nCnt:%03lX CRC:%X - %s\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%08X', h.serial ?? 0n) + ` Btn:${h.btn ?? ''}` +
      ' | ' + hx('Cnt:%03X', h.cnt ?? 0n) + ` CRC:${h.fields[0]?.value ?? ''}`;
  }
}
