/** Port of ProtoPirate protocols/fiat_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFiatV0.kt. */
import { PPDecoder, PPModulation, PPManchester, ppConst, hx, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_DATA = 2;
const PREAMBLE_PAIRS = 150, GAP_US = 800;

/**
 * Fiat V0: AM, Manchester at 200 / 400 us after 150+ short preamble pulses and an 800 us gap; 71 bits: a 32-bit
 * hop, a 32-bit fixed part (serial), and a 6-bit end byte (the button).
 */
export class PPFiatV0 extends PPDecoder {
  private preambleCount = 0;   // uint16
  private dataLow = 0;         // uint32
  private dataHigh = 0;        // uint32
  private bitCount = 0;        // uint8
  private hop = 0;
  private fix = 0;
  private endbyte = 0;

  constructor() { super('Fiat V0', PPModulation.AM, ppConst(200, 400, 100, 64)); }

  override reset(): void {
    super.reset();
    this.preambleCount = 0; this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.hop = 0; this.fix = 0; this.endbyte = 0;
  }

  private finishPacket(): void {
    this.data = ((BigInt(this.hop) << 32n) | BigInt(this.fix)) & MASK64;
    this.dataCountBit = 71;
    this.serial = BigInt(this.fix);
    this.btn = this.endbyte;
    this.cnt = BigInt(this.hop);
    this.decodeData = this.data;
    this.decodeCountBit = this.dataCountBit;
    this.emit();
    this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0;
    this.parserStep = STEP_RESET;
  }

  private startData(): void {
    this.parserStep = STEP_DATA;
    this.preambleCount = 0; this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0;
    this.manchesterAdvance(PPManchester.RESET);
  }

  feed(level: boolean, duration: number): void {
    const teShort = this.c.teShort, teLong = this.c.teLong, teDelta = this.c.teDelta;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level) return;
        if (this.dd(duration, teShort) < teDelta) {
          this.dataLow = 0; this.dataHigh = 0;
          this.parserStep = STEP_PREAMBLE;
          this.preambleCount = 0; this.bitCount = 0; this.decodeData = 0n; this.decodeCountBit = 0;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      case STEP_PREAMBLE:
        if (level) {
          if (this.dd(duration, teShort) < teDelta) this.preambleCount = (this.preambleCount + 1) & 0xFFFF; else this.parserStep = STEP_RESET;
          return;
        }
        if (this.dd(duration, teShort) < teDelta) {
          this.preambleCount = (this.preambleCount + 1) & 0xFFFF;
        } else {
          if (this.preambleCount >= PREAMBLE_PAIRS && this.dd(duration, GAP_US) < teDelta) { this.startData(); return; }
          this.parserStep = STEP_RESET;
        }
        if (this.preambleCount >= PREAMBLE_PAIRS && this.parserStep === STEP_PREAMBLE && this.dd(duration, GAP_US) < teDelta) {
          this.startData(); return;
        }
        break;
      case STEP_DATA: {
        let event = PPManchester.RESET;
        if (this.dd(duration, teShort) < teDelta) event = level ? PPManchester.SHORT_LOW : PPManchester.SHORT_HIGH;
        else if (duration >= teShort && this.dd(duration, teLong) < teDelta) event = level ? PPManchester.LONG_LOW : PPManchester.LONG_HIGH;
        if (event !== PPManchester.RESET) {
          const bit = this.manchesterAdvance(event);
          if (bit >= 0) {
            const carry = (this.dataLow >>> 31) & 1;
            this.dataLow = ((this.dataLow << 1) | bit) >>> 0;
            this.dataHigh = ((this.dataHigh << 1) | carry) >>> 0;
            this.bitCount = (this.bitCount + 1) & 0xFF;
            if (this.bitCount === 64) { this.fix = this.dataLow; this.hop = this.dataHigh; this.dataLow = 0; this.dataHigh = 0; }
            if (this.bitCount === 0x47) { this.endbyte = this.dataLow & 0x3F; this.finishPacket(); }
          }
        } else {
          if (this.bitCount === 0x47) { this.endbyte = this.dataLow & 0x3F; this.finishPacket(); }
          else if (this.bitCount < 64) this.parserStep = STEP_RESET;
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    const low = this.endbyte & 0x0F;
    const suffix = low >= 0x04 && low <= 0x07 ? 'Lock' : low >= 0x08 && low <= 0x0B ? 'Unlock' : '??';
    return { name: this.name, bits: this.dataCountBit, key: hx('%08X%08X', this.hop, this.fix), serial: BigInt(this.fix),
      btn: hx('%02X', this.endbyte & 0x3F), cnt: BigInt(this.hop),
      fields: [{ name: 'Hop', value: hx('%08X', this.hop) },
        { name: 'EndByte', value: hx('%02X', this.endbyte & 0x3F) },
        { name: 'Action', value: suffix }] };
  }

  /** fiat_v0.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nHop:%08lX\r\nSn:%08lX\r\nEndByte:%02X\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Hop:${h.fields[0].value} | ` + hx('Sn:%08X', h.serial ?? 0n) +
      ` | EndByte:${h.fields[1].value}`;
  }
}
