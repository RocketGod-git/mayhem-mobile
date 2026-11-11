/** Port of ProtoPirate protocols/honda_v2.c (decoder and get_string; GPL-3.0). Twin of pirate/PPHondaV2.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE_LOW = 1, STEP_PREAMBLE_HIGH = 2, STEP_SYNC_LOW = 3, STEP_DATA = 4;
const MIN_PREAMBLE_PAIRS = 64, SYNC_US = 750, SYNC_DELTA_US = 120;
const BTN_UNKNOWN = 0x00, BTN_LOCK = 0x02, BTN_UNLOCK = 0x04;
const SIG_UNLOCK = 0xA285E3, SIG_LOCK = 0xC20363;

const buttonFromSignature = (s: number): number => (s === SIG_UNLOCK ? BTN_UNLOCK : s === SIG_LOCK ? BTN_LOCK : BTN_UNKNOWN);
export function hondaV2ButtonName(b: number): string { return b === BTN_LOCK ? 'Lock' : b === BTN_UNLOCK ? 'Unlock' : 'Unknown'; }
/** c is the 9-bit counter. */
function calculateCheck(c: number): number {
  const c0 = ((c >>> 1) ^ (c >>> 2) ^ (c >>> 3) ^ (c >>> 4) ^ (c >>> 6)) & 1;
  const c1 = ((c >>> 0) ^ (c >>> 2) ^ (c >>> 3) ^ (c >>> 4) ^ (c >>> 5) ^ (c >>> 6) ^ 1) & 1;
  const c2 = ((c >>> 1) ^ (c >>> 3) ^ (c >>> 4) ^ (c >>> 5) ^ (c >>> 6)) & 1;
  return c0 | (c1 << 1) | (c2 << 2);
}
const calculateTail = (c: number): number => ((((c >>> 0) ^ (c >>> 2) ^ (c >>> 4) ^ (c >>> 5)) & 1) !== 0 ? 0xFFFF : 0x7FFF);

/**
 * Honda V2: FM, 250 / 500 us short-pair preamble (64+ pairs), a 750 us sync pair, then 81 bits in a differential
 * pulse code: a 24-bit command signature, 24-bit serial, 9-bit counter, a 3-bit check, a 16-bit tail and one extra bit.
 */
export class PPHondaV2 extends PPDecoder {
  private preambleCount = 0;
  private raw: number[] = new Array<number>(10).fill(0);
  private bitCount = 0;
  private extraBit = false;
  private previousBit = true;
  private boundaryPadSkipped = false;
  private pendingShort = false;
  private key = 0n;
  private tail = 0;
  private commandSignature = 0;
  private serialV2 = 0;
  private count = 0;
  private button = 0;
  private check = 0;
  private checkOk = false;
  private tailOk = false;

  constructor() { super('Honda V2', PPModulation.FM, ppConst(250, 500, 100, 81)); }

  private isSync(d: number): boolean { return this.dd(d, SYNC_US) < SYNC_DELTA_US; }

  private parseKeyFields(k: bigint): void {
    const b = PPMath.u64ToBytesBE(k);
    const sig = (b[0] << 16) | (b[1] << 8) | b[2];
    this.commandSignature = sig;
    this.serialV2 = (b[3] << 16) | (b[4] << 8) | b[5];
    this.count = (b[6] << 1) | ((b[7] >>> 7) & 1);
    this.button = buttonFromSignature(sig);
    this.check = b[7] & 0x07;
  }

  private validateFrame(k: bigint, t: number, extra: boolean): boolean {
    const b = PPMath.u64ToBytesBE(k);
    const c = (b[6] << 1) | ((b[7] >>> 7) & 1);
    this.checkOk = (b[7] & 0x78) === 0 && (b[7] & 0x07) === calculateCheck(c);
    this.tailOk = t === calculateTail(c) && extra;
    return this.checkOk && this.tailOk;
  }

  private addDecodedBit(bit: boolean): boolean {
    if (this.bitCount < 80) {
      if (bit) this.raw[this.bitCount >> 3] |= 1 << (7 - (this.bitCount & 7));
    } else if (this.bitCount === 80) {
      this.extraBit = bit;
    } else return false;
    this.bitCount++;
    return true;
  }

  private finishFrame(): boolean {
    const k = PPMath.bytesToU64BE(this.raw);
    const t = (this.raw[8] << 8) | this.raw[9];
    if (!this.validateFrame(k, t, this.extraBit)) return false;
    this.key = k; this.tail = t;
    this.parseKeyFields(k);
    this.data = this.key;
    this.dataCountBit = this.c.minBits;
    this.serial = BigInt(this.serialV2); this.btn = this.button; this.cnt = BigInt(this.count);
    return true;
  }

  private processTransition(level: boolean, duration: number): boolean {
    if (!this.boundaryPadSkipped) {
      if (level && this.isShort(duration)) { this.boundaryPadSkipped = true; return true; }
      this.boundaryPadSkipped = true;
    }
    if (this.pendingShort) {
      if (!this.previousBit && !level && this.isShort(duration)) { this.pendingShort = false; return this.addDecodedBit(false); }
      else if (this.previousBit && level && this.isShort(duration)) { this.pendingShort = false; return this.addDecodedBit(true); }
      return false;
    }
    if (!this.previousBit) {
      if (level && this.isLong(duration)) { this.previousBit = true; return this.addDecodedBit(true); }
      else if (level && this.isShort(duration)) { this.pendingShort = true; return true; }
      return false;
    }
    if (!level && this.isLong(duration)) { this.previousBit = false; return this.addDecodedBit(false); }
    else if (!level && this.isShort(duration)) { this.pendingShort = true; return true; }
    return false;
  }

  private clearFrame(): void {
    this.raw = new Array<number>(10).fill(0); this.bitCount = 0; this.extraBit = false;
    this.previousBit = true; this.boundaryPadSkipped = false; this.pendingShort = false;
  }

  override reset(): void {
    super.reset();
    this.parserStep = STEP_RESET; this.teLast = 0; this.preambleCount = 0;
    this.clearFrame();
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.isShort(duration)) { this.preambleCount = 0; this.parserStep = STEP_PREAMBLE_LOW; }
        break;
      case STEP_PREAMBLE_LOW:
        if (!level && this.isShort(duration)) { this.preambleCount++; this.parserStep = STEP_PREAMBLE_HIGH; }
        else this.parserStep = STEP_RESET;
        break;
      case STEP_PREAMBLE_HIGH:
        if (level && this.isShort(duration)) this.parserStep = STEP_PREAMBLE_LOW;
        else if (level && this.isSync(duration) && this.preambleCount >= MIN_PREAMBLE_PAIRS) this.parserStep = STEP_SYNC_LOW;
        else this.parserStep = STEP_RESET;
        break;
      case STEP_SYNC_LOW:
        if (!level && this.isSync(duration)) {
          this.clearFrame();
          this.addDecodedBit(true);
          this.parserStep = STEP_DATA;
        } else this.parserStep = STEP_RESET;
        break;
      case STEP_DATA:
        if (!this.processTransition(level, duration)) this.parserStep = STEP_RESET;
        else if (this.bitCount === this.c.minBits) {
          if (this.finishFrame()) this.emit();
          this.parserStep = STEP_RESET;
        }
        break;
    }
    this.teLast = duration;
  }

  override describe(): PPHit {
    const tailShown = ((this.tail >>> 15) & 1) !== 0 ? 0x1FFFF : 0x0FFFF;
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.key), serial: BigInt(this.serialV2),
      btn: hx('%02X - ', this.button) + hondaV2ButtonName(this.button), cnt: BigInt(this.count),
      fields: [{ name: 'BtnSig', value: hx('%06X', this.commandSignature) },
        { name: 'Chk', value: hx('%02X [', this.check) + (this.checkOk ? 'OK' : 'BAD') + ']' },
        { name: 'Tail', value: hx('%05X [', tailShown) + (this.tailOk ? 'OK' : 'BAD') + ']' }] };
  }

  /**
   * honda_v2.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%06lX  Btn:%02X - %s\r\nBtnSig:%06lX\r\n
   * Cnt:%05lX  Chk:%02X [%s]  Tail:%05lX [%s]\r\n".
   */
  override cString(h: PPHit): string {
    const f = h.fields;
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%06X', h.serial ?? 0n) + `  Btn:${h.btn ?? ''}` +
      ` | BtnSig:${f[0].value} | ` + hx('Cnt:%05X', h.cnt ?? 0n) + `  Chk:${f[1].value}  Tail:${f[2].value}`;
  }
}
