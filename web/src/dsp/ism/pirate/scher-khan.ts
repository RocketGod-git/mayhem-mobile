/** Port of ProtoPirate protocols/scher_khan.c (decoder and get_string; GPL-3.0). Twin of pirate/PPScherKhan.kt. */
import { PPDecoder, PPModulation, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

/**
 * Scher-Khan (Magic Code / Magicar): FM, 750 / 1100 us PWM after a 1500 us header, 35 bits or more ended by a long
 * high pulse; the bit count names the variant, and only the 51-bit dynamic one carries serial, button and counter.
 */
export class PPScherKhan extends PPDecoder {
  private protocolName = '';

  constructor() { super('Scher-Khan', PPModulation.FM, ppConst(750, 1100, 160, 35)); }

  feed(level: boolean, duration: number): void {
    const teShort = this.c.teShort, teLong = this.c.teLong, teDelta = this.c.teDelta;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, teShort * 2) < teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.teLast = duration; this.headerCount = 0; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (level) {
          if (this.dd(duration, teShort * 2) < teDelta || this.dd(duration, teShort) < teDelta) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        } else if (this.dd(duration, teShort * 2) < teDelta || this.dd(duration, teShort) < teDelta) {
          if (this.dd(this.teLast, teShort * 2) < teDelta) {
            this.headerCount++;   // found header
          } else if (this.dd(this.teLast, teShort) < teDelta) {
            // found start bit
            if (this.headerCount >= 2) { this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 1; }
            else this.parserStep = STEP_RESET;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (level) {
          if (duration >= teDelta * 2 + teLong) {
            // found stop bit
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit >= this.c.minBits) {
              this.data = this.decodeData; this.dataCountBit = this.decodeCountBit;
              this.emit();
            }
            this.decodeData = 0n; this.decodeCountBit = 0;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (this.dd(this.teLast, teShort) < teDelta && this.dd(duration, teShort) < teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, teLong) < teDelta && this.dd(duration, teLong) < teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  /** subghz_protocol_scher_khan_check_remote_controller. */
  private checkRemoteController(): void {
    this.serial = 0n; this.btn = 0; this.cnt = 0n;
    const data = this.data;
    switch (this.dataCountBit) {
      case 35: this.protocolName = 'MAGIC CODE, Static'; break;
      case 51:
        this.protocolName = 'MAGIC CODE, Dynamic';
        this.serial = (((data >> 24n) & 0xFFFFFF0n) | ((data >> 20n) & 0x0Fn)) & M32;
        this.btn = Number((data >> 24n) & 0x0Fn);
        this.cnt = data & 0xFFFFn;
        break;
      case 57: this.protocolName = 'MAGIC CODE PRO/PRO2'; break;
      case 63: this.protocolName = 'MAGIC CODE, Response'; break;
      case 64: this.protocolName = 'MAGICAR, Response'; break;
      case 81: case 82: this.protocolName = 'MAGIC CODE PRO,\n Response'; break;
      default: this.protocolName = 'Unknown';
    }
  }

  override describe(): PPHit {
    this.checkRemoteController();
    const key = hx('0x%X%08X', (this.data >> 32n) & M32, this.data & M32);
    return { name: this.name, bits: this.dataCountBit, key, serial: this.serial, btn: hx('%X', this.btn), cnt: this.cnt,
      fields: [{ name: 'Pt', value: this.protocolName }] };
  }

  /**
   * scher_khan.c get_string: "%s %dbit\r\nKey:0x%lX%08lX\r\nSn:%07lX Btn:%X\r\nCntr:%04lX\r\nPt: %s\r\n".
   * The 81/82-bit name holds a bare "\n", which the harness also turns into " | ".
   */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%07X', h.serial ?? 0n) + ` Btn:${h.btn ?? ''}` +
      ' | ' + hx('Cntr:%04X', h.cnt ?? 0n) +
      ` | Pt: ${(h.fields[0]?.value ?? '').split('\n').join(' | ')}`;
  }
}
