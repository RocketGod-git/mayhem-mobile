/** Port of ProtoPirate protocols/star_line.c (decoder and get_string; GPL-3.0). Twin of pirate/PPStarLine.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

/**
 * Star Line: AM, 250 / 500 us PWM after a 1000 us preamble, 64 bits sent LSB first: a 32-bit fix (button byte +
 * 24-bit serial) and a 32-bit KeeLoq hop. No manufacturer keys ship, so the hop is never decrypted: the C finds no
 * key, names the manufacturer "Unknown" and leaves the counter at 0.
 */
export class PPStarLine extends PPDecoder {
  /** The keystore's mfname: "" after reset, "Unknown" once a frame found no key (it then skips the key search). */
  private keystoreMfname = '';
  private manufactureName = '';

  constructor() { super('Star Line', PPModulation.AM, ppConst(250, 500, 120, 64)); }

  override reset(): void { this.parserStep = STEP_RESET; this.keystoreMfname = ''; }

  feed(level: boolean, duration: number): void {
    const teShort = this.c.teShort, teLong = this.c.teLong, teDelta = this.c.teDelta, minBits = this.c.minBits;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level) {
          if (this.dd(duration, teLong * 2) < teDelta * 2) { this.parserStep = STEP_CHECK_PREAMBULA; this.headerCount++; }
          else if (this.headerCount > 4) {
            this.decodeData = 0n; this.decodeCountBit = 0; this.teLast = duration; this.parserStep = STEP_CHECK_DURATION;
          }
        } else this.headerCount = 0;
        break;
      case STEP_CHECK_PREAMBULA:
        if (!level && this.dd(duration, teLong * 2) < teDelta * 2) this.parserStep = STEP_RESET;   // found preambula
        else { this.headerCount = 0; this.parserStep = STEP_RESET; }
        break;
      case STEP_SAVE_DURATION:
        if (level) {
          if (duration >= teLong + teDelta) {
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit >= minBits && this.decodeCountBit <= minBits + 2) {
              if (this.data !== this.decodeData) {
                this.data = this.decodeData; this.dataCountBit = minBits;
                this.emit();
              }
            }
            this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0;
          } else { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (this.dd(this.teLast, teShort) < teDelta && this.dd(duration, teShort) < teDelta) {
            if (this.decodeCountBit < minBits) this.addBit(0); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE_DURATION;
          } else if (this.dd(this.teLast, teLong) < teDelta && this.dd(duration, teLong) < teDelta) {
            if (this.decodeCountBit < minBits) this.addBit(1); else this.decodeCountBit++;
            this.parserStep = STEP_SAVE_DURATION;
          } else this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  /** subghz_protocol_star_line_check_remote_controller with an empty keystore: the selector's key loop never runs. */
  private checkRemoteController(): void {
    const key = PPMath.reverseKey(this.data, this.dataCountBit);
    const fix = (key >> 32n) & M32;
    if (this.keystoreMfname !== 'Unknown') {
      // "" (not set) or a name: no key matches, so the C falls through to "Unknown" and clears the counter.
      this.manufactureName = 'Unknown'; this.keystoreMfname = 'Unknown'; this.cnt = 0n;
    }
    this.serial = fix & 0x00FFFFFFn;
    this.btn = Number((fix >> 24n) & 0xFFn);
  }

  override describe(): PPHit {
    this.checkRemoteController();
    const rev = PPMath.reverseKey(this.data, this.dataCountBit);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hx('%02X', this.btn), cnt: this.cnt,
      fields: [
        { name: 'Fix', value: hx('0x%08X', (rev >> 32n) & M32) },
        { name: 'Hop', value: hx('0x%08X', rev & M32) },
        { name: 'MF', value: this.manufactureName },
      ] };
  }

  /** star_line.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nFix:0x%08lX    Cnt:%04lX\r\nHop:0x%08lX    Btn:%02X\r\nMF:%s\r\n". */
  override cString(h: PPHit): string {
    const f = h.fields;
    return `${h.name} ${h.bits}bit | Key:${h.key} | Fix:${f[0].value}    ` + hx('Cnt:%04X', h.cnt ?? 0n) +
      ` | Hop:${f[1].value}    Btn:${h.btn ?? ''} | MF:${f[2].value}`;
  }
}
