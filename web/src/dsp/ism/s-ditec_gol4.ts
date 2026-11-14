/**
 * Ditec GOL4 rolling-code remotes, 54-bit OOK PWM (Flipper Unleashed lib/subghz/protocols/ditec_gol4.c; twin of
 * ism/SDitecGol4.kt). Receive only. The hop is only obfuscated (bit rotation + a fixed LCG, no manufacturer key), so
 * serial, button and 16-bit counter are recovered exactly as Flipper does.
 */
import { FProto, Fam, S, FG } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_START_BIT = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

function bitReverse8(b: number): number { let r = 0; b &= 0xFF; for (let i = 0; i < 8; i++) { r = ((r << 1) | (b & 1)) & 0xFF; b >>>= 1; } return r; }
function lcgStep(seed: number, steps: number): number { let x = seed & 0xFF; steps &= 0xFF; for (let i = 0; i < steps; i++) x = (21 * x + 1) & 0xFF; return x; }
function lcgInverse(target: number, steps: number): number { steps &= 0xFF; return steps === 0 ? target & 0xFF : lcgStep(target, (256 - steps) & 0xFF); }

/** Undo the GOL4 obfuscation in place on the 7 raw bytes (gol4_rolling_decode). */
function gol4Decode(raw: number[]): void {
  let carry = 0;
  for (let r = 0; r < 3; r++) {
    for (let i = 2; i < 7; i++) { const nc = raw[i] & 1; raw[i] = ((raw[i] >>> 1) | (carry << 7)) & 0xFF; carry = nc; }
  }
  raw[0] = bitReverse8(raw[0]); raw[1] = bitReverse8(raw[1]); raw[3] = bitReverse8(raw[3]); raw[4] = bitReverse8(raw[4]);
  let b2 = raw[2] & 0xDF;
  b2 = ((b2 << 4) | (b2 >>> 4)) & 0xFF;
  b2 = ~b2 & 0xFF;
  raw[2] = bitReverse8(b2);
  raw[5] = bitReverse8(raw[5]); raw[6] = bitReverse8(raw[6]);
  if (raw[6] & 0x80) raw[5] ^= 1;
  raw[5] = lcgInverse(raw[5], 0xFE);
  raw[6] = lcgInverse(raw[6], raw[5]);
  raw[5] ^= 0xA7; raw[6] ^= 0x69;
}

export class SDitecGol4 extends FProto {
  constructor() { super(Fam.REMOTE, S.DITEC_GOL4); this.teShort = 400; this.teLong = 1100; this.teDelta = 200; this.minCountBitForFound = 54; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, this.teLong * 22) < this.teLong * 4) { this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_START_BIT; }
        break;
      case STEP_START_BIT:
        if (level && this.dd(duration, this.teShort * 2) < this.teDelta) this.parserStep = STEP_SAVE_DURATION;
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SAVE_DURATION:
        if (!level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_CHECK_DURATION:
        if (level) {
          if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta) { this.addBit(1); this.parserStep = STEP_SAVE_DURATION; }
          else if (this.dd(this.teLast, this.teLong) < this.teDelta && this.dd(duration, this.teShort) < this.teDelta) { this.addBit(0); this.parserStep = STEP_SAVE_DURATION; }
        } else if (this.dd(this.teLast, this.teLong * 20) < this.teLong * 3) {
          // The space before was the inter-frame gap
          if (this.decodeCountBit === this.minCountBitForFound) { this.dataCountBit = this.minCountBitForFound; this.hit(); }
          this.decodeData = 0n; this.decodeCountBit = 0; this.parserStep = STEP_RESET;
        } else this.parserStep = STEP_RESET;
        break;
    }
  }

  /** Serial, button and counter of a 54-bit GOL4 key. */
  static decodeKey(key: bigint): { serial: bigint; btn: number; cnt: number } {
    const raw = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 54; i++) if (FG.bitRead(key, 53 - i)) raw[i >>> 3] |= 1 << (7 - (i & 7));
    gol4Decode(raw);
    const serial = (BigInt(raw[0]) << 24n) | (BigInt(raw[4]) << 16n) | (BigInt(raw[1]) << 8n) | BigInt(raw[3]);
    return { serial, btn: raw[2] & 0x0F, cnt: (raw[5] | (raw[6] << 8)) & 0xFFFF };
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const k = SDitecGol4.decodeKey(this.decodeData);
    return { name: remoteName(this.sensorType), serial: k.serial, btn: k.btn, cnt: k.cnt, extra: k.btn === 0 ? ['Prog mode'] : [] };
  }
}
