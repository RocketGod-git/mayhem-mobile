/** Port of ProtoPirate protocols/vag.c (decoder and get_string; GPL-3.0). Twin of pirate/PPVag.kt. */
import { PPDecoder, PPModulation, ppConst, hx, ppField, type PPHit, type PPField } from './pp-base.js';
import { PPAut64, type PPAut64Key } from './aut64.js';

const STEP_RESET = 0, STEP_PREAMBLE1 = 1, STEP_DATA1 = 2, STEP_PREAMBLE2 = 3;
const STEP_SYNC2A = 4, STEP_SYNC2B = 5, STEP_SYNC2C = 6, STEP_DATA2 = 7;

const T12_TE_SHORT = 300, T12_TE_LONG = 600, T12_TE_DELTA = 100;
const T12_GAP_DELTA = 200, T12_PREAMBLE_MIN = 151;
const T34_TE_SHORT = 500, T34_TE_LONG = 1000, T34_TE_DELTA = 100, T34_LONG_DELTA = 200;
const T34_SYNC = 750, T34_SYNC_DELTA = 150, T34_PREAMBLE_MIN = 31, T34_SYNC_PAIRS = 3;
const DATA_GAP_MIN = 4001, TOTAL_BITS = 80, KEY1_BITS = 64;
const PREFIX_BITS = 15, BIT_LIMIT = 96;
const FRAME_PREFIX_T1 = 0x2F3F, FRAME_PREFIX_T2 = 0x2F1C;

const TEA_DELTA = -0x61C88647;   // 0x9E3779B9 as a signed 32-bit value
const TEA_ROUNDS = 32;
const teaKeySchedule = [0x0B46502D, 0x5E253718, 0x2BF93A19, 0x622C1206];

// ---- vag.c helpers ----
export function vagButtonName(btn: number): string {
  switch (btn) {
    case 0x1: case 0x10: return 'Unlock';
    case 0x2: case 0x20: return 'Lock';
    case 0x4: case 0x40: return 'Boot';
    default: return 'Unkn';
  }
}

/** 32-bit TEA decrypt on signed 32-bit numbers (wrapping like uint32_t). */
function teaDecrypt(v: number[], k: number[]): void {
  let v0 = v[0] | 0, v1 = v[1] | 0;
  let sum = Math.imul(TEA_DELTA, TEA_ROUNDS);
  for (let r = 0; r < TEA_ROUNDS; r++) {
    v1 = (v1 - (((((v0 << 4) ^ (v0 >>> 5)) + v0) | 0) ^ ((sum + k[(sum >>> 11) & 3]) | 0))) | 0;
    sum = (sum - TEA_DELTA) | 0;
    v0 = (v0 - (((((v1 << 4) ^ (v1 >>> 5)) + v1) | 0) ^ ((sum + k[sum & 3]) | 0))) | 0;
  }
  v[0] = v0; v[1] = v1;
}

const dispatchType12 = (d: number): boolean => d === 0x2A || d === 0x1C || d === 0x46;
const dispatchType34 = (d: number): boolean => d === 0x2B || d === 0x1D || d === 0x47;

function buttonValid(dec: number[]): boolean {
  const decBtn = (dec[7] >>> 4) & 0xF;
  if (decBtn === 1 || decBtn === 2 || decBtn === 4) return true;
  return dec[7] === 0;
}

function buttonMatches(dec: number[], dispatchByte: number): boolean {
  const expected = (dispatchByte >>> 4) & 0xF;
  if (((dec[7] >>> 4) & 0xF) === expected) return true;
  return dec[7] === 0 && expected === 2;
}

/** vag.c get_string's vehicle name, from Key1's top byte. */
export function vagVehicleName(typeByte: number): string {
  switch (typeByte) {
    case 0x00: return 'VW Passat';
    case 0xC0: return 'VW';
    case 0xC1: return 'Audi';
    case 0xC2: return 'Seat';
    case 0xC3: return 'Skoda';
    default: return 'VAG';
  }
}

/**
 * VAG (VW / Audi / Seat / Skoda): AM, Manchester, 80 bits (Key1 64 + Key2 16). Types 1 and 2 use 300 / 600 us with a
 * long 300 us preamble, an inverted payload and a 15-bit frame prefix (0x2F3F = type 1, 0x2F1C = type 2); types 3 and 4
 * use 500 / 1000 us with a 500 us preamble and three 750 us sync pairs. Type 2 decrypts with a fixed TEA key; types 1,
 * 3 and 4 need AUT64 keys from ProtoPirate's keystore file, which is not shipped, so those frames show as received
 * ("corrupted"), as the C does with no key file. The 32-bit words are plain numbers held in 0..0xFFFFFFFF.
 */
export class PPVag extends PPDecoder {
  /** The AUT64 keys from ProtoPirate's "vag" keystore file (up to 3, matched by their index byte). None ship. */
  static aut64Keys: PPAut64Key[] = [];

  // SubGhzProtocolDecoderVAG
  private dataLow = 0;
  private dataHigh = 0;
  private bitCount = 0;          // uint8
  private key1Low = 0;
  private key1High = 0;
  private key2Low = 0;
  private vagDataCountBit = 0;
  private vagType = 0;
  private vagHeaderCount = 0;    // uint16
  private midCount = 0;          // uint8
  private vSerial = 0;
  private vCnt = 0;
  private vBtn = 0;
  checkByte = 0;
  keyIdx = 0xFF;
  private decrypted = false;

  constructor() { super('VAG', PPModulation.AM, ppConst(500, 1000, 80, 80)); }

  /** vag_aut64_decrypt: key slot `keyIndex` is the keystore key whose index byte is keyIndex + 1. */
  private static aut64Decrypt(block: number[], keyIndex: number): boolean {
    const key = PPVag.aut64Keys.slice(0, 3).find((k) => k.index === keyIndex + 1);
    if (!key) return false;
    PPAut64.decrypt(key, block);
    return true;
  }

  private fillFromDecrypted(dec: number[], dispatchByte: number): void {
    const raw = (dec[0] | (dec[1] << 8) | (dec[2] << 16) | (dec[3] << 24)) >>> 0;
    this.vSerial = ((raw << 24) | ((raw & 0xFF00) << 8) | ((raw >>> 8) & 0xFF00) | (raw >>> 24)) >>> 0;
    this.vCnt = dec[4] | (dec[5] << 8) | (dec[6] << 16);
    this.vBtn = (dec[7] >>> 4) & 0xF;
    this.checkByte = dispatchByte;
    this.decrypted = true;
  }

  private parseData(): void {
    this.decrypted = false; this.vSerial = 0; this.vCnt = 0; this.vBtn = 0;
    const dispatchByte = this.key2Low & 0xFF;
    const key2HighByte = (this.key2Low >>> 8) & 0xFF;
    const hi = this.key1High, lo = this.key1Low;
    const block = [(hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF, (lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF, key2HighByte];

    switch (this.vagType) {
      case 1: {
        if (!dispatchType12(dispatchByte)) break;
        for (let ki = 0; ki < 3; ki++) {
          const copy = block.slice();
          if (!PPVag.aut64Decrypt(copy, ki)) continue;
          if (buttonValid(copy)) {
            this.vSerial = ((copy[0] << 24) | (copy[1] << 16) | (copy[2] << 8) | copy[3]) >>> 0;
            this.vCnt = copy[4] | (copy[5] << 8) | (copy[6] << 16);
            this.vBtn = copy[7];
            this.checkByte = dispatchByte;
            this.keyIdx = ki;
            this.decrypted = true;
            return;
          }
        }
        break;
      }
      case 2: {
        if (!dispatchType12(dispatchByte)) break;
        const v = [(block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3],
          (block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]];
        teaDecrypt(v, teaKeySchedule);
        const v0 = v[0], v1 = v[1];
        const dec = [(v0 >>> 24) & 0xFF, (v0 >>> 16) & 0xFF, (v0 >>> 8) & 0xFF, v0 & 0xFF,
          (v1 >>> 24) & 0xFF, (v1 >>> 16) & 0xFF, (v1 >>> 8) & 0xFF, v1 & 0xFF];
        if (!buttonMatches(dec, dispatchByte)) break;
        this.fillFromDecrypted(dec, dispatchByte);
        this.keyIdx = 0xFF;
        return;
      }
      case 3: {
        let copy = block.slice();
        if (PPVag.aut64Decrypt(copy, 2) && buttonValid(copy)) { this.vagType = 4; this.keyIdx = 2; this.fillFromDecrypted(copy, dispatchByte); return; }
        copy = block.slice();
        if (PPVag.aut64Decrypt(copy, 1) && buttonValid(copy)) { this.keyIdx = 1; this.fillFromDecrypted(copy, dispatchByte); return; }
        copy = block.slice();
        if (PPVag.aut64Decrypt(copy, 0) && buttonValid(copy)) { this.keyIdx = 0; this.fillFromDecrypted(copy, dispatchByte); return; }
        break;
      }
      case 4: {
        if (!dispatchType34(dispatchByte)) break;
        const copy = block.slice();
        if (!PPVag.aut64Decrypt(copy, 2)) break;
        if (!buttonMatches(copy, dispatchByte)) break;
        this.keyIdx = 2;
        this.fillFromDecrypted(copy, dispatchByte);
        return;
      }
      default: break;
    }
    this.decrypted = false; this.vSerial = 0; this.vCnt = 0; this.vBtn = 0; this.checkByte = 0;
  }

  private pushBit(bit: number): void {
    const carry = (this.dataLow >>> 31) & 1;
    this.dataLow = ((this.dataLow << 1) | bit) >>> 0;
    this.dataHigh = ((this.dataHigh << 1) | carry) >>> 0;
    this.bitCount = (this.bitCount + 1) & 0xFF;
  }

  override reset(): void {
    this.parserStep = STEP_RESET;
    this.decrypted = false;
    this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.vagDataCountBit = 0; this.vagType = 0; this.vagHeaderCount = 0; this.midCount = 0;
    this.manchesterAdvance(8);
    this.vSerial = 0; this.vCnt = 0; this.vBtn = 0; this.checkByte = 0; this.keyIdx = 0xFF;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level) return;
        if (this.dd(duration, T12_TE_SHORT) < T12_TE_DELTA) this.parserStep = STEP_PREAMBLE1;
        else if (this.dd(duration, T34_TE_SHORT) < T34_TE_DELTA) this.parserStep = STEP_PREAMBLE2;
        else return;
        this.dataLow = 0; this.dataHigh = 0; this.vagHeaderCount = 0; this.midCount = 0; this.bitCount = 0; this.vagType = 0;
        this.teLast = duration;
        this.manchesterAdvance(8);
        break;

      case STEP_PREAMBLE1:
        if (level) return;
        if (this.dd(duration, T12_TE_SHORT) < T12_TE_DELTA) {
          if (this.dd(this.teLast, T12_TE_SHORT) < T12_TE_DELTA) { this.teLast = duration; this.vagHeaderCount = (this.vagHeaderCount + 1) & 0xFFFF; }
          else this.parserStep = STEP_RESET;
          return;
        }
        this.parserStep = STEP_RESET;
        if (this.vagHeaderCount < T12_PREAMBLE_MIN) return;
        if (this.dd(duration, T12_TE_LONG) >= T12_GAP_DELTA) return;
        if (this.dd(this.teLast, T12_TE_SHORT) >= T12_TE_DELTA) return;
        this.parserStep = STEP_DATA1;
        break;

      case STEP_DATA1: {
        if (this.bitCount >= BIT_LIMIT) { this.parserStep = STEP_RESET; return; }
        let event = 8;
        let gotPulse = false;
        if (this.dd(duration, T12_TE_SHORT) < T12_TE_DELTA) {
          event = level ? 0 : 2; gotPulse = true;
        } else if (duration > T12_TE_SHORT + T12_TE_DELTA && this.dd(duration, T12_TE_LONG) < T12_GAP_DELTA) {
          event = level ? 4 : 6; gotPulse = true;
        }
        if (gotPulse && this.bitCount < BIT_LIMIT) {
          const bit = this.manchesterAdvance(event);
          if (bit >= 0) {
            this.pushBit(bit);
            if (this.bitCount === PREFIX_BITS) {
              if (this.dataLow === FRAME_PREFIX_T1 && this.dataHigh === 0) { this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.vagType = 1; }
              else if (this.dataLow === FRAME_PREFIX_T2 && this.dataHigh === 0) { this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0; this.vagType = 2; }
            } else if (this.bitCount === KEY1_BITS) {
              this.key1Low = ~this.dataLow >>> 0; this.key1High = ~this.dataHigh >>> 0;
              this.dataLow = 0; this.dataHigh = 0;
            }
          }
          return;
        }
        if (level) return;
        if (duration < DATA_GAP_MIN) return;
        if (this.bitCount === TOTAL_BITS) {
          this.key2Low = ~this.dataLow & 0xFFFF;
          this.vagDataCountBit = TOTAL_BITS;
          this.parseData();
          this.emit();
        }
        this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0;
        this.parserStep = STEP_RESET;
        break;
      }

      case STEP_PREAMBLE2:
        if (!level) {
          if (this.dd(duration, T34_TE_SHORT) < T34_TE_DELTA && this.dd(this.teLast, T34_TE_SHORT) < T34_TE_DELTA) {
            this.teLast = duration; this.vagHeaderCount = (this.vagHeaderCount + 1) & 0xFFFF;
          } else this.parserStep = STEP_RESET;
          return;
        }
        if (this.vagHeaderCount < T34_PREAMBLE_MIN) return;
        if (this.dd(duration, T34_TE_LONG) >= T34_LONG_DELTA) return;
        if (this.dd(this.teLast, T34_TE_SHORT) >= T34_TE_DELTA) return;
        this.teLast = duration;
        this.parserStep = STEP_SYNC2A;
        break;

      case STEP_SYNC2A:
        if (!level && this.dd(duration, T34_TE_SHORT) < T34_TE_DELTA && this.dd(this.teLast, T34_TE_LONG) < T34_LONG_DELTA) {
          this.teLast = duration; this.parserStep = STEP_SYNC2B;
        } else this.parserStep = STEP_RESET;
        break;

      case STEP_SYNC2B:
        if (level && this.dd(duration, T34_SYNC) < T34_SYNC_DELTA) { this.teLast = duration; this.parserStep = STEP_SYNC2C; }
        else this.parserStep = STEP_RESET;
        break;

      case STEP_SYNC2C:
        if (!level && this.dd(duration, T34_SYNC) < T34_SYNC_DELTA && this.dd(this.teLast, T34_SYNC) < T34_SYNC_DELTA) {
          this.midCount = (this.midCount + 1) & 0xFF;
          this.parserStep = STEP_SYNC2B;
          if (this.midCount === T34_SYNC_PAIRS) {
            this.dataLow = 1; this.dataHigh = 0; this.bitCount = 1;
            this.manchesterAdvance(8);
            this.parserStep = STEP_DATA2;
          }
        } else this.parserStep = STEP_RESET;
        break;

      case STEP_DATA2: {
        let event = 8;
        let gotPulse = false;
        if (this.dd(duration, T34_TE_SHORT) < T34_TE_DELTA) { event = level ? 0 : 2; gotPulse = true; }
        else if (this.dd(duration, T34_TE_LONG) < T34_LONG_DELTA) { event = level ? 4 : 6; gotPulse = true; }
        if (gotPulse) {
          const bit = this.manchesterAdvance(event);
          if (bit >= 0) {
            this.pushBit(bit);
            if (this.bitCount === KEY1_BITS) {
              this.key1Low = this.dataLow; this.key1High = this.dataHigh;
              this.dataLow = 0; this.dataHigh = 0;
            }
          }
        }
        if (this.bitCount !== TOTAL_BITS) return;
        this.key2Low = this.dataLow & 0xFFFF;
        this.vagDataCountBit = TOTAL_BITS;
        this.vagType = 3;
        this.parseData();
        this.emit();
        this.dataLow = 0; this.dataHigh = 0; this.bitCount = 0;
        this.parserStep = STEP_RESET;
        break;
      }

      default: this.parserStep = STEP_RESET;
    }
  }

  /** vag.c get_string, including its side effect: an undecrypted 80-bit frame is parsed again. */
  override describe(): PPHit {
    if (!this.decrypted && this.vagDataCountBit >= 80) this.parseData();
    const key = hx('%08X%08X', this.key1High, this.key1Low);
    const key2 = this.key2Low & 0xFFFF;
    const fields: PPField[] = [
      { name: 'Vehicle', value: vagVehicleName((this.key1High >>> 24) & 0xFF) },
      { name: 'Key2', value: hx('%04X', key2) },
      { name: 'Type', value: `${this.vagType}` },
    ];
    if (this.decrypted) {
      fields.push({ name: 'Button', value: vagButtonName(this.vBtn) });
      return { name: this.name, bits: this.vagDataCountBit, key, serial: BigInt(this.vSerial), btn: hx('%X', this.vBtn), cnt: BigInt(this.vCnt), fields };
    }
    return { name: this.name, bits: this.vagDataCountBit, key, serial: null, btn: null, cnt: null, fields };
  }

  /**
   * vag.c get_string: "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X Btn:%0X - %s\r\nSer:%08lX Cnt:%06lX\r\n" when
   * decrypted, else "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X (corrupted)\r\n"; %s is the vehicle name.
   */
  override cString(h: PPHit): string {
    const head = `${ppField(h, 'Vehicle')} ${h.bits}bit | Key1:${h.key} | Key2:${ppField(h, 'Key2')}`;
    if (h.btn !== null) return head + ` Btn:${h.btn} - ${ppField(h, 'Button')} | ` + hx('Ser:%08X Cnt:%06X', h.serial ?? 0n, h.cnt ?? 0n);
    return head + ' (corrupted)';
  }
}
