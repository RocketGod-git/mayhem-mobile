/** Port of ProtoPirate protocols/ford_v1.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFordV1.kt. */
import { PPDecoder, PPModulation, ppConst, hx, ppField, PPMath, PPManchester, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_SYNC = 2, STEP_DATA = 3;
const DELTA_LONG = 40, DELTA_DATA_SYNC = 39;
const PREAMBLE_MIN = 50, DATA_BITS = 136, DATA_BYTES = 17;
const { SHORT_LOW, SHORT_HIGH, LONG_LOW, LONG_HIGH } = PPManchester;

const crc16 = (b: number[], from: number, to: number): number => PPMath.crc16(b.slice(from, to), 0x1021, 0x0000);

function buttonName(b: number): string {
  switch (b) { case 0: return 'Sync'; case 1: return 'Lock'; case 2: return 'Unlock'; case 4: return 'Trunk'; case 8: return 'Panic'; default: return '??'; }
}

function decodeWithFlag(raw: number[], flag: number): void {
  if (raw.length < 9) return;
  if (flag !== 0) {
    const x = raw[7];
    for (let i = 1; i < 7; i++) raw[i] ^= x;
  } else {
    const x = raw[6];
    for (let i = 1; i < 6; i++) raw[i] ^= x;
    raw[7] ^= x;
  }
  const b6 = raw[6], b7 = raw[7];
  raw[6] = (b6 & 0xAA) | (b7 & 0x55);
  raw[7] = (b7 & 0xAA) | (b6 & 0x55);
}

function decode(raw: number[]): void {
  if (raw.length < 9) return;
  const end = raw[8];
  let parity = 0, tmp = end;
  while (tmp !== 0) { parity ^= tmp & 1; tmp >>>= 1; }
  decodeWithFlag(raw, end !== 0 ? parity : 0);
}

function popcount8(v: number): number { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; }

function encodeInverseBlock(block: number[]): void {
  let sum = 0;
  for (let i = 1; i <= 7; i++) sum = (sum + block[i]) & 0xFF;
  const p6 = block[6], p7 = block[7];
  const post6 = (p6 & 0xAA) | (p7 & 0x55);
  const post7 = (p7 & 0xAA) | (p6 & 0x55);
  const xorv = post6 ^ post7;
  let x: number;
  if (popcount8(sum) & 1) { block[6] = xorv; block[7] = post7; x = post7; }
  else { block[6] = post6; block[7] = xorv; x = post6; }
  for (let i = 1; i <= 5; i++) block[i] ^= x;
}

function plainFromAir(air9: number[]): number[] | null {
  for (let flag = 0; flag < 2; flag++) {
    const cand = air9.slice();
    decodeWithFlag(cand, flag);
    const reair = cand.slice();
    encodeInverseBlock(reair);
    if (reair.length === air9.length && reair.every((v, i) => v === air9[i])) return cand;
  }
  return null;
}

/**
 * Ford V1: FM, Manchester at 65 / 130 us after 50+ long preamble pulses and a short sync; 17 bytes (136 bits)
 * with a CRC-16/XMODEM over bytes 3..14, sent either way up. Bytes 6..14 carry the XOR-scrambled serial, button and
 * 20-bit counter; when the scramble cannot be undone (an encrypted frame) only the device id is shown.
 */
export class PPFordV1 extends PPDecoder {
  private crcCalc = 0;
  private data2 = 0n;
  private rawBytes: number[] = new Array<number>(18).fill(0);
  private byteCount = 0;        // uint8
  private preambleCount = 0;    // uint16
  private syncEventIdx = 0;     // uint8
  private syncEventCount = 0;   // uint8
  private syncEvents: number[] = new Array<number>(8).fill(0);
  private encryptionSupported = 0;

  constructor() { super('Ford V1', PPModulation.FM, ppConst(65, 130, 39, 136)); }

  private processData(): boolean {
    const orig = this.rawBytes.slice(0, DATA_BYTES);
    let calc = crc16(this.rawBytes, 3, 15);
    let recv = (this.rawBytes[15] << 8) | this.rawBytes[16];
    if (recv !== calc) {
      for (let i = 0; i < DATA_BYTES; i++) this.rawBytes[i] = ~orig[i] & 0xFF;
      calc = crc16(this.rawBytes, 3, 15);
      recv = (this.rawBytes[15] << 8) | this.rawBytes[16];
    }
    if (recv !== calc) return false;

    const raw = this.rawBytes.slice();
    const air9 = raw.slice(6, 15);
    let decoded: number[];
    let strictOk = false;
    const b0 = air9.slice(); decodeWithFlag(b0, 0);
    const b1 = air9.slice(); decodeWithFlag(b1, 1);
    if (b0[3] === raw[5] && b0[4] === raw[6]) { decoded = b0; strictOk = true; }
    else if (b1[3] === raw[5] && b1[4] === raw[6]) { decoded = b1; strictOk = true; }
    else {
      const p = plainFromAir(air9);
      if (p !== null) decoded = p;   // rolling: fields not shown
      else { decoded = air9.slice(); decode(decoded); }
    }

    this.crcCalc = crc16(raw, 3, 15);
    let key1 = 0n;
    for (let i = 0; i < 7; i++) key1 = (key1 << 8n) | BigInt(raw[i]);
    let key2 = 0n;
    for (let i = 0; i < 8; i++) key2 = (key2 << 8n) | BigInt(raw[7 + i]);
    this.data = key1; this.data2 = key2; this.dataCountBit = DATA_BITS;

    if (strictOk) {
      this.serial = BigInt(((decoded[1] << 24) | (decoded[2] << 16) | (decoded[3] << 8) | decoded[0]) >>> 0);
      this.btn = (decoded[5] >>> 4) & 0x0F;
      this.cnt = BigInt(((decoded[5] & 0x0F) << 16) | (decoded[6] << 8) | decoded[7]);
      this.encryptionSupported = 1;
    } else {
      this.serial = BigInt(((raw[3] << 24) | (raw[4] << 16) | (raw[5] << 8) | raw[6]) >>> 0);
      this.btn = 0; this.cnt = 0n; this.encryptionSupported = 0;
    }
    this.emit();
    return true;
  }

  private tryLastByteVariants(): boolean {
    if (this.byteCount !== 16) { this.resetV1(); return false; }
    if (((this.decodeCountBit + 0x7A) & 0xFF) > 1) { this.resetV1(); return false; }
    const shift = (DATA_BITS - this.decodeCountBit) & 0xFF;
    const variants = shift >= 8 ? 0 : (1 << shift) & 0xFF;
    const saved = this.rawBytes.slice(0, 16);
    const partial = Number(this.decodeData & 0xFFn);
    let variant = 0;
    while (variant < variants) {
      for (let i = 0; i < 16; i++) this.rawBytes[i] = saved[i];
      this.rawBytes[16] = ((partial << shift) & 0xFF) | variant;
      if (this.processData()) { this.resetV1(); return true; }
      variant = (variant + 1) & 0xFF;
    }
    this.resetV1();
    return false;
  }

  private resetV1(): void {
    this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeCountBit = 0; this.byteCount = 0;
    this.rawBytes = new Array<number>(18).fill(0); this.preambleCount = 0; this.syncEventIdx = 0; this.syncEventCount = 0;
    this.syncEvents = new Array<number>(8).fill(0);
    this.manchesterAdvance(8);
  }

  override reset(): void { this.resetV1(); }

  private pushBit(bit: number): void {
    this.decodeData = (this.decodeData << 1n) | BigInt(bit);
    this.decodeCountBit++;
  }

  private takeBit(bit: number): void {
    this.pushBit(bit);
    if ((this.decodeCountBit & 7) === 0) {
      const b = Number(this.decodeData & 0xFFn);
      if (this.byteCount < DATA_BYTES) { this.rawBytes[this.byteCount] = b; this.byteCount++; }
      this.decodeData = 0n;
    }
  }

  feed(level: boolean, duration: number): void {
    const teShort = this.c.teShort, teLong = this.c.teLong;
    switch (this.parserStep) {
      case STEP_RESET:
        if (!level && this.dd(duration, teLong) < DELTA_LONG) {
          this.parserStep = STEP_PREAMBLE; this.preambleCount = 1; this.teLast = duration;
        }
        break;
      case STEP_PREAMBLE:
        if (this.dd(duration, teLong) < DELTA_LONG) {
          this.preambleCount = (this.preambleCount + 1) & 0xFFFF; this.teLast = duration;
        } else if (this.dd(duration, teShort) < DELTA_DATA_SYNC) {
          if (this.preambleCount >= PREAMBLE_MIN) {
            this.syncEventIdx = 0; this.syncEventCount = 1;
            this.syncEvents[0] = level ? SHORT_HIGH : SHORT_LOW;
            this.parserStep = STEP_SYNC;
          } else this.parserStep = STEP_RESET;
        } else {
          if (this.preambleCount < PREAMBLE_MIN) this.parserStep = STEP_RESET;
        }
        break;
      case STEP_SYNC: {
        let ev: number;
        let isShort = false;
        if (this.dd(duration, teShort) < DELTA_DATA_SYNC) {
          ev = level ? SHORT_HIGH : SHORT_LOW; isShort = true;
        } else if (this.dd(duration, teLong) < DELTA_DATA_SYNC) {
          ev = level ? LONG_HIGH : LONG_LOW;
        } else { this.parserStep = STEP_PREAMBLE; return; }

        this.syncEventIdx = (this.syncEventIdx + 1) & 0xFF;
        if (isShort) this.syncEventCount = (this.syncEventCount + 1) & 0xFF;
        if (this.syncEventIdx < 8) this.syncEvents[this.syncEventIdx] = ev;

        if (this.syncEventCount > 2) {
          this.decodeData = 0n; this.decodeCountBit = 0; this.byteCount = 0;
          this.rawBytes = new Array<number>(18).fill(0);
          this.manchesterAdvance(8);
          if (this.syncEvents[0] === SHORT_LOW) this.manchester = PPManchester.MID0;
          this.parserStep = STEP_DATA;
          for (let i = 0; i <= this.syncEventIdx && i < 8; i++) {
            const bit = this.manchesterAdvance(this.syncEvents[i]);
            if (bit >= 0) this.takeBit(bit);
          }
          return;
        }
        if (this.syncEventIdx >= 7) this.parserStep = STEP_PREAMBLE;
        break;
      }
      case STEP_DATA: {
        let event: number;
        if (this.dd(duration, teShort) < DELTA_DATA_SYNC) event = level ? SHORT_HIGH : SHORT_LOW;
        else if (this.dd(duration, teLong) < DELTA_DATA_SYNC) event = level ? LONG_HIGH : LONG_LOW;
        else { this.tryLastByteVariants(); return; }

        const bit = this.manchesterAdvance(event);
        if (bit >= 0) {
          this.takeBit(bit);
          if ((this.decodeCountBit & 7) === 0 && this.byteCount > 16) { this.processData(); this.resetV1(); }
        }
        this.teLast = duration;
        break;
      }
    }
  }

  /** ford_v1_raw14_from_internal_keys plus the CRC bytes, and the CRC check get_string does. */
  private rawFromKeys(): number[] {
    const raw = new Array<number>(DATA_BYTES).fill(0);
    for (let i = 0; i < 7; i++) raw[i] = Number((this.data >> BigInt(48 - i * 8)) & 0xFFn);
    for (let i = 0; i < 8; i++) raw[7 + i] = Number((this.data2 >> BigInt(56 - i * 8)) & 0xFFn);
    raw[15] = (this.crcCalc >>> 8) & 0xFF;
    raw[16] = this.crcCalc & 0xFF;
    return raw;
  }

  override describe(): PPHit {
    const c16 = this.crcCalc & 0xFFFF;
    const raw = this.rawFromKeys();
    const ok = crc16(raw, 3, 15) === c16;
    const line1 = hx('%014X%06X', this.data, this.data2 >> 40n);
    const line2 = hx('%010X%04X', this.data2 & 0xFFFFFFFFFFn, c16);
    const crcText = hx('%04X [', c16) + (ok ? 'OK' : 'ERR') + ']';
    if (this.encryptionSupported !== 0) {
      return { name: this.name, bits: this.dataCountBit, key: line1 + line2, serial: this.serial,
        btn: hx('%01X [', this.btn) + buttonName(this.btn) + ']', cnt: this.cnt,
        fields: [{ name: 'Key1', value: line1 }, { name: 'Key2', value: line2 }, { name: 'CRC', value: crcText }] };
    }
    const deviceId = BigInt(((raw[3] << 24) | (raw[4] << 16) | (raw[5] << 8) | raw[6]) >>> 0);
    return { name: this.name, bits: this.dataCountBit, key: line1 + line2, serial: deviceId, btn: null, cnt: null,
      fields: [{ name: 'Key1', value: line1 }, { name: 'Key2', value: line2 },
        { name: 'CRC', value: crcText }, { name: 'Note', value: 'Encryption not supported !' }] };
  }

  /**
   * ford_v1.c get_string: "%s %dbit\r\n%014llX%06llX\r\n%010llX%04lX\r\nSn:%08lX Bt:%01X [%s]\r\nCnt:%05lX CRC:%04lX [%s]\r\n",
   * or, without a plain frame, "...\r\nSn:%08lX\r\nCRC:%04lX [%s]\r\nEncryption not supported !\r\n".
   */
  override cString(h: PPHit): string {
    const head = `${h.name} ${h.bits}bit | ${ppField(h, 'Key1')} | ${ppField(h, 'Key2')} | ` + hx('Sn:%08X', h.serial ?? 0n);
    const b = h.btn, c = h.cnt;
    if (b !== null && c !== null) return head + ` Bt:${b} | ` + hx('Cnt:%05X', c) + ` CRC:${ppField(h, 'CRC')}`;
    return head + ` | CRC:${ppField(h, 'CRC')} | ${ppField(h, 'Note')}`;
  }
}
