/** Port of ProtoPirate protocols/subaru.c (decoder and get_string; GPL-3.0). Twin of pirate/PPSubaru.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_FOUND_GAP = 2, STEP_FOUND_SYNC = 3, STEP_SAVE_DURATION = 4;
const GAP_US = 2800, SYNC_US = 2800;
const BUTTONS = ['Lock', 'Unlock', 'Trunk', 'Panic'];
const buttonName = (b: number): string => BUTTONS[b & 0x03];

/** Result of subaru_decode_fields_exact. */
interface SubaruFields { serial: bigint; btn: number; cnt: number; valid: boolean }

/** subaru_decode_fields_exact (its validity result is computed and ignored, as in the C). */
function decodeFields(kb: number[]): SubaruFields {
  const [b0, b1, b2, b3, b4, b5, b6, b7] = kb;
  const btn = b0 & 0x0F;
  const serial = BigInt((b1 << 16) | (b2 << 8) | b3);
  let lo = 0;
  if ((b4 & 0x40) === 0) lo |= 0x01;
  if ((b4 & 0x80) === 0) lo |= 0x02;
  if ((b5 & 0x01) === 0) lo |= 0x04;
  if ((b5 & 0x02) === 0) lo |= 0x08;
  if ((b6 & 0x01) === 0) lo |= 0x10;
  if ((b6 & 0x02) === 0) lo |= 0x20;
  if ((b5 & 0x40) === 0) lo |= 0x40;
  if ((b5 & 0x80) === 0) lo |= 0x80;
  const regSh1 = ((b7 & 0x0F) << 4) | (b5 & 0x0C) | ((b6 >>> 6) & 0x03);
  const regSh2 = ((b6 & 0x3C) << 2) | ((b7 >>> 4) & 0x0F);
  // rotateLeft3 over (ser0, ser1, ser2) = (b3, b1, b2)
  let ser0 = b3, ser1 = b1, ser2 = b2;
  for (let r = 0; r < 4 + lo; r++) {
    const t = ser0;
    ser0 = ((ser0 << 1) | (ser1 >>> 7)) & 0xFF;
    ser1 = ((ser1 << 1) | (ser2 >>> 7)) & 0xFF;
    ser2 = ((ser2 << 1) | (t >>> 7)) & 0xFF;
  }
  const t1 = ser1 ^ regSh1, t2 = ser2 ^ regSh2;
  let hi = 0;
  if ((t1 & 0x10) === 0) hi |= 0x04;
  if ((t1 & 0x20) === 0) hi |= 0x08;
  if ((t2 & 0x80) === 0) hi |= 0x02;
  if ((t2 & 0x40) === 0) hi |= 0x01;
  if ((t1 & 0x01) === 0) hi |= 0x40;
  if ((t1 & 0x02) === 0) hi |= 0x80;
  if ((t2 & 0x08) === 0) hi |= 0x20;
  if ((t2 & 0x04) === 0) hi |= 0x10;
  const local34 = ser0;
  const x1 = b1 ^ regSh1, x2 = b2 ^ regSh2;
  const rhi = ~hi & 0xFF;
  const nlo = ~lo;   // C int promotion: ~lo is a negative int
  const e1 = ((x1 ^ ((rhi << 2) & 0xFF)) & 0x30) | ((x1 ^ (rhi >>> 6)) & 0x03) | ((x1 ^ ((nlo << 2) & 0xFF)) & 0xCC);
  const e2 = ((x2 ^ (rhi >>> 2)) & 0x0C) | ((x2 ^ ((rhi << 6) & 0xFF)) & 0xC0) | ((x2 ^ ((nlo >> 2) & 0xFF)) & 0x33);
  const valid = ((b1 ^ e1) | (b2 ^ e2)) === 0 && (b0 ^ local34) === lo;
  return { serial, btn, cnt: (hi << 8) | lo, valid };
}

/**
 * Subaru: AM, 800 / 1600 us PWM after a long-pair preamble and a 2800 us gap + sync, 64 bits: button nibble, 24-bit
 * serial, and a 16-bit counter scrambled through the serial (unscrambled here exactly as the C does).
 */
export class PPSubaru extends PPDecoder {
  constructor() { super('Subaru', PPModulation.AM, ppConst(800, 1600, 200, 64)); }

  feed(level: boolean, duration: number): void {
    const teShort = this.c.teShort, teLong = this.c.teLong, teDelta = this.c.teDelta;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, teLong) < teDelta) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0; this.teLast = duration;
          this.parserStep = STEP_CHECK_PREAMBLE;
        }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) return;
        if (this.dd(duration, teLong) < teDelta && this.dd(this.teLast, teLong) < teDelta) { this.headerCount++; return; }
        if (this.headerCount >= 0x15 && this.dd(duration, GAP_US) < 800) { this.teLast = duration; this.parserStep = STEP_FOUND_GAP; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_GAP:
        if (level && this.dd(duration, SYNC_US) < 800 && this.dd(this.teLast, GAP_US) < 800) this.parserStep = STEP_FOUND_SYNC;
        else this.parserStep = STEP_RESET;
        break;
      case STEP_FOUND_SYNC:
        if (!level && (this.dd(duration, teLong) < teDelta || this.dd(duration, teShort) < teDelta)) {
          this.teLast = duration; this.parserStep = STEP_SAVE_DURATION;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION: {
        let nextStep = STEP_RESET;
        let bit = 0, valid = false;
        if (level) {
          if (this.dd(duration, teLong) < teDelta) {
            if (this.dd(this.teLast, teShort) < teDelta) { bit = 0; valid = true; }
          } else if (this.dd(duration, teShort) < teDelta) {
            if (this.dd(this.teLast, teLong) < teDelta) { bit = 1; valid = true; }
          }
          if (valid) { this.addBit(bit); nextStep = STEP_FOUND_SYNC; }
        }
        this.parserStep = nextStep;
        if (this.decodeCountBit >= 64 && this.decodeCountBit <= 80) {
          this.dataCountBit = this.decodeCountBit;
          this.data = this.decodeData;
          // subaru_process_data
          const f = decodeFields(PPMath.u64ToBytesBE(this.decodeData));
          this.serial = f.serial; this.btn = f.btn; this.cnt = BigInt(f.cnt);
          this.emit();
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
        }
        break;
      }
    }
  }

  override describe(): PPHit {
    const f = decodeFields(PPMath.u64ToBytesBE(this.data));
    this.serial = f.serial; this.btn = f.btn; this.cnt = BigInt(f.cnt);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: f.serial,
      btn: hx('%01X [', f.btn) + buttonName(f.btn) + ']', cnt: BigInt(f.cnt), fields: [] };
  }

  /** subaru.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%06lX Btn:%01X [%s]\r\nCnt:%04lX". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%06X', h.serial ?? 0n) + ` Btn:${h.btn ?? ''}` +
      ' | ' + hx('Cnt:%04X', h.cnt ?? 0n);
  }
}
