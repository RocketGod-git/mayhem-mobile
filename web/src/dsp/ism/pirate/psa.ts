/** Port of ProtoPirate protocols/psa.c (decoder and get_string; GPL-3.0). Twin of pirate/PPPsa.kt. */
import { PPDecoder, PPModulation, ppConst, hx, type PPHit } from './pp-base.js';
import { PPPsaCrypto } from './psa-crypto.js';

const STATE0 = 0, STATE1 = 1, STATE2 = 2, STATE3 = 3, STATE4 = 4;
const TE_SHORT125 = 0x7D, TE_LONG250 = 0xFA, TE_END1000 = 1000, TE_END500 = 500;
const TOLERANCE99 = 99, TOLERANCE100 = 100, TOLERANCE49 = 0x31, TOLERANCE50 = 0x32;
const PATTERN_THRESHOLD1 = 0x46, PATTERN_THRESHOLD2 = 0x45;
const MAX_BITS = 0x79, KEY1_BITS = 0x40, KEY2_BITS = 0x50, BUFFER_SIZE = 48;
const TE_LONG300 = 0x12C;

const absDiff = (a: number, b: number): number => (a < b ? b - a : a - b);

function directXorAllowedByKey2(key2HighByte: number): boolean {
  const lo = key2HighByte & 0xF;
  if (lo < 3) return true;
  if (lo < 7 && (key2HighByte & 0xC) !== 0) return true;
  return false;
}

function calculateChecksum(b: number[]): void {
  let checksum = 0;
  for (let i = 2; i < 8; i++) checksum += (b[i] & 0xF) + ((b[i] >>> 4) & 0xF);
  b[11] = (checksum * 0x10) & 0xFF;
}

function secondStageXorDecrypt(b: number[]): void {
  // psa_copy_reverse
  const t = [b[5], b[4], b[3], b[2], b[9], b[8], b[7], b[6]];
  b[2] = t[0] ^ t[6];
  b[3] = t[2] ^ t[0];
  b[4] = t[6] ^ t[3];
  b[5] = t[7] ^ t[1];
  b[6] = t[3] ^ t[1];
  b[7] = t[6] ^ t[4] ^ t[5];
}

/**
 * PSA (Peugeot / Citroen): Manchester, two variants. The 250 / 500 us one (states 1 and 2) has a run of 250 us
 * preamble pairs, a 500 us sync and a 1000 us end mark; the 125 / 250 us one (states 3 and 4) a run of 125 us pairs,
 * a 250 us sync and a 500 us end mark. 64 bits of Key1 then 16 of Key2. Type 0x23 frames decode with a plain XOR
 * stage (serial, button, counter, CRC); every other frame needs ProtoPirate's TEA brute force, which the C defers to a
 * separate plugin and never runs while decoding, so those show only Key1 and Key2, as in the C.
 * The 32-bit words are plain numbers held in 0..0xFFFFFFFF.
 */
export class PPPsa extends PPDecoder {
  // SubGhzProtocolDecoderPSA (the state lives in parserStep)
  private prevDuration = 0;
  private decodeDataLow = 0;
  private decodeDataHigh = 0;
  private countBit = 0;          // uint8
  private key1Low = 0;
  private key1High = 0;
  private key2Low = 0;
  private statusFlag = 0;
  private decrypted = 0;
  private modeSerialize = 0;
  private patternCounter = 0;    // uint16
  private decryptedButton = 0;
  private decryptedSerial = 0;
  private decryptedCounter = 0;
  private decryptedCrc = 0;
  private decryptedSeed = 0;
  private decryptedType = 0;

  constructor() { super('PSA', PPModulation.AM, ppConst(250, 500, 100, 128)); }

  private extractFieldsMode23(b: number[]): void {
    this.decryptedButton = b[8] & 0xF;
    this.decryptedSerial = (b[3] << 8) | (b[2] << 16) | b[4];
    this.decryptedCounter = b[6] | (b[5] << 8);
    this.decryptedCrc = b[7];
    this.decryptedType = 0x23;
    this.decryptedSeed = this.decryptedSerial;
  }

  private directXorDecrypt(b: number[]): boolean {
    calculateChecksum(b);
    const checksum = b[11];
    const key2High = b[8];
    if (((checksum ^ key2High) & 0xF0) === 0) {
      b[13] = b[9] ^ b[8];
      secondStageXorDecrypt(b);
      this.extractFieldsMode23(b);
      return true;
    }
    return false;
  }

  private newBuffer(): number[] {
    const b = new Array<number>(BUFFER_SIZE).fill(0);
    PPPsaCrypto.setupByteBuffer(b, this.key1Low, this.key1High, this.key2Low);
    return b;
  }

  private clearDecrypted(): void {
    this.decryptedType = 0; this.decryptedButton = 0; this.decryptedSerial = 0; this.decryptedCounter = 0; this.decryptedCrc = 0; this.decryptedSeed = 0;
  }

  private handleDecodedFrame(directXorMode: number): void {
    this.key2Low = this.decodeDataLow;
    this.clearDecrypted();
    this.decrypted = 0;
    this.modeSerialize = directXorAllowedByKey2((this.key2Low >>> 8) & 0xFF) ? directXorMode : 0x36;
    this.statusFlag = 0x80;
    const b = this.newBuffer();
    if (this.modeSerialize !== 0x36 && this.directXorDecrypt(b)) {
      this.modeSerialize = 0x23;
      this.decrypted = 0x50;
    } else {
      this.decrypted = 0;
      this.modeSerialize = 0x36;
    }
    this.emit();
    this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0;
  }

  private decryptRouter(): void {
    const b = this.newBuffer();
    const key2HighByte = b[8];
    let mode = this.modeSerialize;
    if (mode === 1 || mode === 2) {
      mode = !directXorAllowedByKey2(key2HighByte) ? 0x36 : this.directXorDecrypt(b) ? 0x23 : 0x36;
    }
    if (mode === 0x23) {
      if (this.directXorDecrypt(b)) { this.modeSerialize = 0x23; this.decrypted = 0x50; return; }
    } else if (mode === 0x36) {
      return;   // TEA brute force: deferred to ProtoPirate's plugin, never run here
    } else {
      if (directXorAllowedByKey2(key2HighByte) && this.directXorDecrypt(b)) { this.modeSerialize = 0x23; this.decrypted = 0x50; return; }
      this.modeSerialize = 0x36; this.decrypted = 0;
      return;
    }
    this.decrypted = 0;
  }

  private pushBit(bit: number): void {
    const carry = (this.decodeDataLow >>> 31) & 1;
    this.decodeDataLow = ((this.decodeDataLow << 1) | bit) >>> 0;
    this.decodeDataHigh = ((this.decodeDataHigh << 1) | carry) >>> 0;
    this.countBit = (this.countBit + 1) & 0xFF;
    if (this.countBit === KEY1_BITS) {
      this.key1Low = this.decodeDataLow; this.key1High = this.decodeDataHigh;
      this.decodeDataLow = 0; this.decodeDataHigh = 0;
    }
  }

  private manchesterStep(input: number): void {
    const bit = this.manchesterAdvance(input);
    if (bit >= 0) this.pushBit(bit);
  }

  override reset(): void {
    this.parserStep = 0; this.statusFlag = 0; this.modeSerialize = 0;
    this.key1Low = 0; this.key1High = 0; this.key2Low = 0;
    this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0; this.patternCounter = 0;
    this.manchester = 1;
    this.clearDecrypted();
  }

  feed(level: boolean, duration: number): void {
    let tolerance: number;
    let newState = this.parserStep;
    const prevDur = this.prevDuration;
    const teShort = this.c.teShort, teLong = this.c.teLong;
    const lv = level ? 1 : 0;

    // `break` is the C's `break` out of the switch (falls through to the state write-back below);
    // `return` is the C's `return`.
    switch (this.parserStep) {
      case STATE0: {
        if (!level) return;
        if (duration < teShort) {
          tolerance = teShort - duration;
          if (tolerance > TOLERANCE99) {
            tolerance = duration < TE_SHORT125 ? TE_SHORT125 - duration : duration - TE_SHORT125;
            if (tolerance > 40) return;
            if (duration > 180) return;
            newState = STATE3;
          } else newState = STATE1;
        } else {
          tolerance = duration - teShort;
          if (tolerance > TOLERANCE99) return;
          newState = STATE1;
        }
        this.decodeDataLow = 0; this.decodeDataHigh = 0; this.patternCounter = 0; this.countBit = 0; this.modeSerialize = 0;
        this.prevDuration = duration;
        this.clearDecrypted();
        this.decrypted = 0;
        this.manchesterAdvance(8);
        break;
      }

      case STATE1: {
        if (level) return;
        if (duration < teShort) {
          tolerance = teShort - duration;
          if (tolerance < TOLERANCE100) {
            if (absDiff(prevDur, teShort) <= TOLERANCE99) this.patternCounter = (this.patternCounter + 1) & 0xFFFF;
            this.prevDuration = duration;
            return;
          }
        } else {
          tolerance = duration - teShort;
          if (tolerance < TOLERANCE100) {
            if (absDiff(prevDur, teShort) <= TOLERANCE99) this.patternCounter = (this.patternCounter + 1) & 0xFFFF;
            this.prevDuration = duration;
            return;
          } else {
            const longDiff = duration < teLong ? teLong - duration : duration - teLong;
            if (longDiff < 100) {
              if (this.patternCounter > PATTERN_THRESHOLD1) {
                newState = STATE2;
                this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0;
                this.manchesterAdvance(8);
                this.parserStep = newState;
              }
              this.patternCounter = 0;
              this.prevDuration = duration;
              return;
            }
          }
        }
        newState = STATE0;
        this.patternCounter = 0;
        break;
      }

      case STATE2: {
        if (this.countBit >= MAX_BITS) { newState = STATE0; break; }

        if (level && this.countBit === KEY2_BITS) {
          if (duration >= 800) {
            const endDiff = duration < TE_END1000 ? TE_END1000 - duration : duration - TE_END1000;
            if (endDiff <= 199) {
              if (((this.key1High >>> 16) & 0xF) !== 0xA) {
                this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0;
                this.parserStep = STATE0;
                return;
              }
              this.handleDecodedFrame(1);
              this.parserStep = STATE0;
              return;
            }
          }
        }

        let manchesterInput = 0;
        let shouldProcess = false;
        if (duration < teShort) {
          tolerance = teShort - duration;
          if (tolerance >= TOLERANCE100) return;
          manchesterInput = ((lv ^ 1) & 0x7F) << 1;
          shouldProcess = true;
        } else {
          tolerance = duration - teShort;
          if (tolerance < TOLERANCE100) {
            manchesterInput = ((lv ^ 1) & 0x7F) << 1;
            shouldProcess = true;
          } else if (duration < teLong) {
            const diffFrom250 = duration - teShort;
            const diffFrom500 = teLong - duration;
            if (diffFrom500 < 150 || diffFrom250 > diffFrom500) {
              manchesterInput = lv === 0 ? 6 : 4;
              shouldProcess = true;
            } else if (diffFrom250 < 150) {
              manchesterInput = ((lv ^ 1) & 0x7F) << 1;
              shouldProcess = true;
            } else {
              // psa.c: new_state is set but never written back before the return (C quirk, kept).
              if (duration > 10000) { this.patternCounter = 0; return; }
              if (duration >= 350 && duration <= 400) {
                manchesterInput = lv === 0 ? 6 : 4;
                shouldProcess = true;
              } else return;
            }
          } else {
            const longDiff = duration - teLong;
            if (longDiff < 100) {
              manchesterInput = lv === 0 ? 6 : 4;
              shouldProcess = true;
            } else {
              if (!level) {
                // psa.c: a low over 10 ms clears the pattern counter but the state is not written back
                // (new_state is dropped by the return), so the decoder stays in state 2. Kept as in C.
                if (duration > 10000) { this.patternCounter = 0; return; }
                return;
              }
              shouldProcess = false;
            }
          }
        }

        if (shouldProcess && this.countBit < KEY2_BITS) this.manchesterStep(manchesterInput);

        if (!level) return;

        if (!shouldProcess) {
          const endDiff = duration < TE_END1000 ? TE_END1000 - duration : duration - TE_END1000;
          if (endDiff <= 199) {
            if (this.countBit !== KEY2_BITS) return;
            if (((this.key1High >>> 16) & 0xF) === 0xA) {
              this.handleDecodedFrame(1);
              this.parserStep = STATE0;
              return;
            }
            return;
          }
          return;
        }
        break;
      }

      case STATE3: {
        if (duration >= 250) {
          if (duration >= TE_LONG250 && duration < TE_LONG300) {
            if (this.patternCounter > PATTERN_THRESHOLD2) {
              newState = STATE4;
              this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0;
              this.manchesterAdvance(8);
              this.parserStep = newState;
              this.patternCounter = 0;
              this.prevDuration = duration;
              return;
            }
          }
          newState = STATE0;
          this.patternCounter = 0;
          break;
        }
        tolerance = duration < TE_SHORT125 ? TE_SHORT125 - duration : duration - TE_SHORT125;
        if (tolerance < TOLERANCE50) {
          if (absDiff(prevDur, TE_SHORT125) <= TOLERANCE49) this.patternCounter = (this.patternCounter + 1) & 0xFFFF; else this.patternCounter = 0;
          this.prevDuration = duration;
          return;
        }
        newState = STATE0;
        this.patternCounter = 0;
        break;
      }

      case STATE4: {
        if (this.countBit >= MAX_BITS) { newState = STATE0; break; }
        if (!level) {
          let manchesterInput: number;
          if (duration < TE_SHORT125) {
            tolerance = TE_SHORT125 - duration;
            if (tolerance > TOLERANCE49) return;
            manchesterInput = ((lv ^ 1) & 0x7F) << 1;
          } else {
            tolerance = duration - TE_SHORT125;
            if (tolerance < TOLERANCE50) manchesterInput = ((lv ^ 1) & 0x7F) << 1;
            else if (duration >= TE_LONG250 && duration < TE_LONG300) manchesterInput = lv === 0 ? 6 : 4;
            else return;
          }
          this.manchesterStep(manchesterInput);
        } else {
          const endDiff = duration < TE_END500 ? TE_END500 - duration : duration - TE_END500;
          if (endDiff <= 99) {
            if (this.countBit !== KEY2_BITS) return;
            if (((this.key1High >>> 16) & 0xF) !== 0xA) {
              this.decodeDataLow = 0; this.decodeDataHigh = 0; this.countBit = 0;
              this.parserStep = STATE0;
              return;
            }
            this.handleDecodedFrame(2);
            this.parserStep = STATE0;
            return;
          }
          return;
        }
        break;
      }
      default: break;
    }

    this.parserStep = newState;
    this.prevDuration = duration;
  }

  /** psa.c get_string, including its side effect: with a fresh frame not yet decrypted it runs the decrypt router. */
  override describe(): PPHit {
    if (this.statusFlag === 0x80 && (this.key1Low !== 0 || this.key1High !== 0) && this.decryptedType === 0) this.decryptRouter();
    const key2Value = this.key2Low & 0xFFFF;
    const key = hx('%08X%08X', this.key1High, this.key1Low);
    if (this.decrypted === 0x50 && (this.decryptedType === 0x23 || this.decryptedType === 0x36)) {
      const t23 = this.decryptedType === 0x23;
      return { name: this.name, bits: 128, key, serial: BigInt(this.decryptedSerial), btn: hx(t23 ? '%01X' : '%02X', this.decryptedButton),
        cnt: BigInt(this.decryptedCounter),
        fields: [
          { name: 'Key2', value: hx('%04X', key2Value) },
          { name: 'Ser', value: hx('%06X', this.decryptedSerial) },
          { name: 'Cnt', value: hx(t23 ? '%04X' : '%X', this.decryptedCounter) },
          { name: 'CRC', value: hx('%02X', this.decryptedCrc) },
          { name: 'Type', value: hx('%02X', this.decryptedType) },
          { name: 'Sd', value: hx('%06X', this.decryptedSeed) },
        ] };
    }
    return { name: this.name, bits: 128, key, serial: null, btn: null, cnt: null, fields: [{ name: 'Key2', value: hx('%X', key2Value) }] };
  }

  /**
   * psa.c get_string: "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X\r\nBtn:%01X\r\nSer:%06lX\r\nCnt:%04lX\r\nCRC:%02X\r\n
   * Type:%02X\r\nSd:%06lX" for a decrypted frame (Btn %02X, Cnt %lX for type 0x36), else "%s %dbit\r\nKey1:...\r\nKey2:%X".
   */
  override cString(h: PPHit): string {
    const parts = [`${h.name} ${h.bits}bit`, `Key1:${h.key}`];
    for (const f of h.fields) {
      parts.push(`${f.name}:${f.value}`);
      if (f.name === 'Key2' && h.btn !== null) parts.push(`Btn:${h.btn}`);
    }
    return parts.join(' | ');
  }
}
