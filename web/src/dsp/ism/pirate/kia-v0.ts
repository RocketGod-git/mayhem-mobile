/** Port of ProtoPirate protocols/kia_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV0.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, M32, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;
const TYPE_KIA = 1, TYPE_SUZUKI = 2, TYPE_HONDA = 3, TYPE_MITSU = 4;
const BITS_KIA = 61, BITS_SUZUKI = 64, BITS_HONDA = 72;
const MITSU_PREAMBLE_MIN = 72, MITSU_PREAMBLE_MAX = 88;
const hondaCrcTable = [0x4A, 0x25, 0x96, 0x4B, 0xA1, 0xD4, 0x6A, 0x35, 0x9E, 0x4F, 0xA3, 0xD5, 0xEE, 0x77, 0xBF, 0xDB];
const hondaButtonNames = ['Unlock', 'Trunk', 'Lock2', 'Unlock2', 'Trunk2', 'Unlock3', 'Trunk3'];
const LOW60 = 0x0FFFFFFFFFFFFFFFn;

// ---- helpers ----
const isKiaGap = (d: number): boolean => d >= 700 && d - 700 <= 1000;
const isSuzukiGapStrict = (d: number): boolean => d >= 2000 && d - 2000 <= 500;
const crc8poly = (b: number[]): number => PPMath.crc8(b, 0x7F, 0x00);

function suzukiShiftedCrcValid(key: bigint): boolean {
  const lo = Number(key & M32), hi = Number((key >> 32n) & M32);
  const r3 = ((lo >>> 16) | (hi << 16)) & 0x0FFFFFFF;
  const r2 = (lo >>> 12) & 0x0F;
  let r1 = (hi >>> 12) & 0xFFFF;
  const r4 = (lo >>> 4) & 0xFF;
  r1 = ((r1 & 0xFF) << 8) | ((r1 >>> 8) & 0xFF);
  const buf = [r1 & 0xFF, (r1 >>> 8) & 0xFF, (r3 >>> 20) & 0xFF, (r3 >>> 12) & 0xFF, (r3 >>> 4) & 0xFF, ((r3 << 4) | (r2 & 0x0F)) & 0xFF];
  return crc8poly(buf) === r4;
}

function suzukiResolveShifted(d: bigint): bigint | null {
  if (suzukiShiftedCrcValid(d)) return d;
  const w = (d << 1n) & 0xFFFFFFFFFFFFFFFFn;
  if (suzukiShiftedCrcValid(w)) return w;
  return null;
}

const calculateCrcPoly = (d: bigint): number => crc8poly([48, 40, 32, 24, 16, 8].map((s) => Number((d >> BigInt(s)) & 0xFFn)));
const verifyCrcPoly = (d: bigint): boolean => calculateCrcPoly(d) === Number(d & 0xFFn);

const hondaTransform = (d: bigint): bigint => PPMath.bytesToU64BE(PPMath.u64ToBytesBE(d).map((b) => PPMath.reverseBits8(b)));

function hondaCrc(header: number, counter: number): number {
  let v = 0;
  for (let i = 0; i < hondaCrcTable.length; i++) if ((counter >>> i) & 1) v ^= hondaCrcTable[i];
  v ^= header === 0xAA ? 0xA5 : header === 0x2A ? 0x21 : header === 0x6A ? 0x15 : header === 0xFA ? 0x73 : 0xC6;
  return v;
}

const hondaKeyValid = (k: bigint): boolean => (k >> 60n) === 0x0Fn && ((k >> 56n) & 0x0Fn) === 0n && ((k >> 8n) & 0x0Fn) === 0x0An;

const protocolName = (t: number): string => (t === TYPE_SUZUKI ? 'Suzuki V0' : t === TYPE_HONDA ? 'Honda V0' : t === TYPE_MITSU ? 'Mitsubishi V0' : 'Kia V0');

function buttonName(b: number, t: number): string {
  if (t === TYPE_HONDA) return b >= 1 && b <= hondaButtonNames.length ? hondaButtonNames[b - 1] : '??';
  if (t === TYPE_SUZUKI) return b === 3 ? 'Lock' : b === 4 ? 'Unlock' : b === 2 ? 'Trunk' : '??';
  return b === 1 ? 'Lock' : b === 2 ? 'Unlock' : b === 3 ? 'Trunk' : '??';
}

interface Fields { serial: bigint; counter: number; button: number; crc: number; type: number; crcValid: boolean }

/**
 * Kia V0: FM, PWM at 250 / 500 us after a short-pair preamble. One decoder covers four families: Kia (61 bits,
 * CRC-8 poly 0x7F), Mitsubishi (the same frame repeated after a 72..88 pair preamble), Suzuki (64 bits, ended by two
 * ~2 ms gaps, CRC over shifted words) and Honda (61 wire bits, bit-reversed bytes, a table CRC; shown as 72 bits).
 */
export class PPKiaV0 extends PPDecoder {
  private packetBitCount = 0;
  private preamblePairs = 0;
  private type = 0;
  private lastKiaData = 0n;
  private haveLastKia = false;

  constructor() { super('Kia V0', PPModulation.FM, ppConst(250, 500, 100, 61)); }

  /** kia_v0_parse_data: fills the fields, the generic serial/cnt/btn and the bit count. */
  private parseData(): Fields {
    const f: Fields = { serial: 0n, counter: 0, button: 0, crc: 0, type: 0, crcValid: false };
    const t = this.type;
    const data = this.data;
    if (t === TYPE_HONDA) {
      const b = PPMath.u64ToBytesBE(data);
      f.type = t;
      f.serial = BigInt((b[3] << 16) | (b[4] << 8) | b[5]);
      f.counter = (PPMath.reverseBits8(b[1]) << 8) | PPMath.reverseBits8(b[2]);
      f.button = b[6] >>> 5;
      f.crc = b[7];
      f.crcValid = hondaCrc(b[6], f.counter) === f.crc;
      this.dataCountBit = BITS_HONDA;
    } else {
      const suz = t === TYPE_SUZUKI;
      f.type = t;
      f.serial = (data >> (suz ? 16n : 12n)) & 0x0FFFFFFFn;
      f.button = Number((data >> (suz ? 12n : 8n)) & 0x0Fn);
      f.counter = Number((data >> (suz ? 44n : 40n)) & 0xFFFFn);
      f.crc = Number(suz ? (data >> 4n) & 0xFFn : data & 0xFFn);
      if (suz) f.crcValid = suzukiShiftedCrcValid(data);
      else {
        const s = Number(f.serial);
        const b = [(f.counter >>> 8) & 0xFF, f.counter & 0xFF, (s >>> 20) & 0xFF, (s >>> 12) & 0xFF, (s >>> 4) & 0xFF, (((s & 0x0F) << 4) | (f.button & 0x0F)) & 0xFF];
        f.crcValid = PPMath.xorBytes(b) === f.crc;
      }
      this.dataCountBit = suz ? BITS_SUZUKI : BITS_KIA;
      if (t === TYPE_KIA || t === TYPE_MITSU) f.crcValid = verifyCrcPoly(data);
    }
    this.serial = f.serial; this.cnt = BigInt(f.counter); this.btn = f.button;
    this.packetBitCount = this.dataCountBit;
    return f;
  }

  private stateClear(): void { this.parserStep = STEP_RESET; this.teLast = 0; this.decodeData = 0n; this.decodeCountBit = 0; this.preamblePairs = 0; }

  private commit(d: bigint, t: number, bits: number): void {
    this.type = t; this.packetBitCount = bits; this.data = d; this.dataCountBit = bits;
    this.parseData();
    this.emit();
    this.stateClear();
  }

  private finishKiaOrHondaAtGap(): void {
    if (this.decodeCountBit !== BITS_KIA) { this.stateClear(); return; }
    const d = this.decodeData;
    if (verifyCrcPoly(d)) {
      let t = TYPE_KIA;
      if (this.haveLastKia && this.lastKiaData === d && this.preamblePairs >= MITSU_PREAMBLE_MIN && this.preamblePairs <= MITSU_PREAMBLE_MAX) t = TYPE_MITSU;
      this.lastKiaData = d; this.haveLastKia = true;
      this.commit(d, t, BITS_KIA);
      return;
    }
    const key = hondaTransform(d & LOW60);
    if (hondaKeyValid(key)) { this.commit(key, TYPE_HONDA, BITS_HONDA); return; }
    this.stateClear();
  }

  private tryHonda(): boolean {
    if (this.decodeCountBit !== BITS_KIA) return false;
    if (verifyCrcPoly(this.decodeData)) return false;
    const key = hondaTransform(this.decodeData & LOW60);
    if (!hondaKeyValid(key)) return false;
    this.commit(key, TYPE_HONDA, BITS_HONDA);
    return true;
  }

  override reset(): void { this.stateClear(); this.type = 0; this.haveLastKia = false; this.lastKiaData = 0n; }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        this.stateClear();
        if (!level) return;
        if (!this.isShort(duration)) return;
        this.parserStep = STEP_PREAMBLE; this.teLast = duration; this.preamblePairs = 0;
        break;
      case STEP_PREAMBLE:
        if (level) {
          if (this.isShort(duration) || this.isLong(duration)) this.teLast = duration; else this.stateClear();
        } else if (this.isShort(duration) && this.isShort(this.teLast)) {
          this.preamblePairs++;
        } else if (this.isLong(duration) && this.isLong(this.teLast)) {
          if (this.preamblePairs > 14) {
            this.decodeData = 0n; this.decodeCountBit = 0;
            this.addBit(1); this.addBit(1);
            this.parserStep = STEP_SAVE_DURATION;
          } else this.stateClear();
        } else this.stateClear();
        break;
      case STEP_SAVE_DURATION:
        if (!level) { this.stateClear(); return; }
        if (isKiaGap(duration)) { this.finishKiaOrHondaAtGap(); return; }
        if (isSuzukiGapStrict(duration) && isSuzukiGapStrict(this.teLast)) {
          const s = this.decodeCountBit === BITS_SUZUKI ? suzukiResolveShifted(this.decodeData) : null;
          if (s !== null) this.commit(s, TYPE_SUZUKI, BITS_SUZUKI); else this.stateClear();
          return;
        }
        if (this.isShort(duration) || this.isLong(duration)) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; } else this.stateClear();
        break;
      case STEP_CHECK_DURATION:
        if (level) { this.stateClear(); return; }
        if (this.isShort(this.teLast) && this.isShort(duration)) {
          this.addBit(0);
          if (!this.tryHonda()) this.parserStep = STEP_SAVE_DURATION;
          return;
        }
        if (this.isLong(this.teLast) && this.isLong(duration)) {
          this.addBit(1);
          if (!this.tryHonda()) this.parserStep = STEP_SAVE_DURATION;
          return;
        }
        if (isSuzukiGapStrict(duration)) { this.teLast = duration; this.parserStep = STEP_SAVE_DURATION; return; }
        if (!this.tryHonda()) this.stateClear();
        break;
      default:
        this.stateClear();
    }
  }

  override describe(): PPHit {
    const f = this.parseData();
    const honda = this.type === TYPE_HONDA;
    return { name: protocolName(this.type), bits: this.packetBitCount, key: hx('%016X', this.data),
      serial: f.serial, btn: hx('%01X [', f.button) + buttonName(f.button, this.type) + ']', cnt: BigInt(f.counter),
      fields: [{ name: 'Sn', value: hx(honda ? '%06X' : '%07X', f.serial) },
        { name: 'CRC', value: hx('%02X [', f.crc) + (f.crcValid ? 'OK' : 'ERR') + ']' }] };
  }

  /**
   * kia_v0.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%07lX Btn:%01X [%s]\r\nCnt:%04X CRC:%02X [%s]\r\n"
   * (Sn:%06lX for Honda).
   */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Sn:${h.fields[0].value} Btn:${h.btn ?? ''} | ` +
      hx('Cnt:%04X', h.cnt ?? 0n) + ` CRC:${h.fields[1].value}`;
  }
}
