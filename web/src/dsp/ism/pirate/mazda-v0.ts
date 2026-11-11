/** Port of ProtoPirate protocols/mazda_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPMazdaV0.kt. */
import { PPDecoder, PPModulation, PPManchester, PPMath, ppConst, hx, MASK64, ppField, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 5, STEP_DATA = 6;
const SYNC_BYTE = 0xD7, PREAMBLE_ONES = 16;

export function mazdaChecksum(serial: bigint, button: number, counter0: bigint): number {
  const s = Number(serial & 0xFFFFFFFFn) >>> 0;
  const counter = Number(counter0 & 0xFFFFFn);
  const sum = ((s >>> 24) & 0xFF) + ((s >>> 16) & 0xFF) + ((s >>> 8) & 0xFF) + (s & 0xFF) +
    ((counter >>> 8) & 0xFF) + (counter & 0xFF) + ((((counter >>> 16) & 0x0F) | ((button & 0x0F) << 4)) & 0xFF);
  return sum & 0xFF;
}

const buttonName = (b: number): string => (b === 0x01 ? 'Lock' : b === 0x02 ? 'Unlock' : b === 0x04 ? 'Trunk' : b === 0x08 ? 'Remote' : '??');

/**
 * Mazda V0: Manchester at 250 / 500 us (120 us tolerance); 16+ preamble ones and the sync byte D7, then 64 bits sent
 * inverted: an XOR-obfuscated serial, button and 20-bit counter, and a sum checksum. ProtoPirate registers it behind
 * both demodulators (AM and FM routes); FM is the one listed here.
 */
export class PPMazdaV0 extends PPDecoder {
  private preambleCount = 0;     // uint16
  private preamblePattern = 0;   // uint8

  constructor() { super('Mazda V0', PPModulation.FM, ppConst(250, 500, 100, 64)); this.manchester = PPManchester.START1; }

  /** -1 when the duration fits neither. */
  private getEvent(duration: number, level: boolean): number {
    const tol = this.c.teDelta + 20;
    if (this.dd(duration, this.c.teShort) < tol) return level ? PPManchester.SHORT_LOW : PPManchester.SHORT_HIGH;
    if (this.dd(duration, this.c.teLong) < tol) return level ? PPManchester.LONG_LOW : PPManchester.LONG_HIGH;
    return -1;
  }

  /** mazda_v0_decode_key: fills serial, btn and cnt from data. */
  private decodeKey(): void {
    const d = PPMath.u64ToBytesBE(this.data);
    const parity = PPMath.parity8(d[7]) !== 0;
    const limit = parity ? 6 : 5;
    const mask = d[limit];
    for (let i = 0; i < limit; i++) d[i] ^= mask;
    if (!parity) d[6] ^= mask;
    const counterLo = (d[5] & 0x55) | (d[6] & 0xAA);
    const counterMid = (d[6] & 0x55) | (d[5] & 0xAA);
    this.serial = BigInt(((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0);
    this.btn = (d[4] >>> 4) & 0x0F;
    this.cnt = BigInt(((d[4] & 0x0F) << 16) | (counterMid << 8) | counterLo);
    this.dataCountBit = this.c.minBits;
  }

  override reset(): void {
    this.parserStep = STEP_RESET; this.teLast = 0; this.decodeData = 0n; this.decodeCountBit = 0;
    this.manchester = PPManchester.START1; this.preambleCount = 0; this.preamblePattern = 0;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.c.teShort) < this.c.teDelta + 20) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_PREAMBLE;
          this.manchester = PPManchester.MID1; this.preambleCount = 0; this.preamblePattern = 0;
        }
        break;
      case STEP_PREAMBLE: {
        const ev = this.getEvent(duration, level);
        if (ev < 0) { this.parserStep = STEP_RESET; return; }
        const bit = this.manchesterAdvance(ev);
        if (bit >= 0) {
          this.preamblePattern = ((this.preamblePattern << 1) | bit) & 0xFF;
          if (bit === 1) this.preambleCount = (this.preambleCount + 1) & 0xFFFF;
          else if (this.preambleCount <= PREAMBLE_ONES - 1) { this.preambleCount = 0; this.preamblePattern = 0; return; }
          if (this.preamblePattern === SYNC_BYTE && this.preambleCount > PREAMBLE_ONES - 1) {
            this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_DATA;
          }
        }
        break;
      }
      case STEP_DATA: {
        const ev = this.getEvent(duration, level);
        if (ev < 0) { this.parserStep = STEP_RESET; return; }
        const bit = this.manchesterAdvance(ev);
        if (bit >= 0) {
          this.addBit(bit);
          this.decodeCountBit &= 0xFF;   // uint8_t decode_count_bit
          if (this.decodeCountBit === this.c.minBits) {
            this.data = ~this.decodeData & MASK64;
            this.decodeKey();
            if (mazdaChecksum(this.serial, this.btn, this.cnt) === Number(this.data & 0xFFn)) this.emit();
            this.decodeData = 0n; this.decodeCountBit = 0; this.preambleCount = 0; this.preamblePattern = 0;
            this.manchester = PPManchester.START1; this.teLast = 0; this.parserStep = STEP_RESET;
          }
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    // get_string re-runs mazda_v0_decode_key on data first; the fields are already the decoded ones.
    this.decodeKey();
    const rawCrc = Number(this.data & 0xFFn);
    const calc = mazdaChecksum(this.serial, this.btn, this.cnt);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial,
      btn: hx('%02X - ', this.btn) + buttonName(this.btn), cnt: this.cnt & 0xFFFFFn,
      fields: [{ name: 'CRC', value: rawCrc === calc ? 'OK' : 'BAD' }, { name: 'Chk', value: hx('%02X', rawCrc) }] };
  }

  /** mazda_v0.c get_string: "%s %dbit CRC:%s\r\nKey: %016llX\r\nSn: %08lX  Btn: %02X - %s\r\nCnt: %05lX  Chk: %02X\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit CRC:${ppField(h, 'CRC')} | Key: ${h.key} | ` + hx('Sn: %08X', h.serial ?? 0n) +
      `  Btn: ${h.btn ?? ''} | ` + hx('Cnt: %05X', h.cnt ?? 0n) + `  Chk: ${ppField(h, 'Chk')}`;
  }
}
