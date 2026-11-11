/** Port of ProtoPirate protocols/kia_v5.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV5.kt. */
import { PPDecoder, PPModulation, PPManchester, PPMath, PPKeys, ppConst, hx, M32, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_DATA = 2;

/** mixer_decode, with the keystore built from the V5 manufacturer key (0 when absent). */
export function kiaV5MixerDecode(encrypted: bigint): number {
  const e = Number(encrypted & M32);
  let s0 = e & 0xFF, s1 = (e >>> 8) & 0xFF, s2 = (e >>> 16) & 0xFF, s3 = (e >>> 24) & 0xFF;
  const mf = PPKeys.kiaV5 ?? 0n;
  const ks: number[] = [];
  for (let i = 0; i < 8; i++) ks.push(Number((mf >> BigInt((7 - i) * 8)) & 0xFFn));
  let roundIndex = 1;
  for (let k = 0; k < 18; k++) {
    let r = ks[roundIndex];
    for (let j = 0; j < 8; j++) {
      let base = (s3 & 0x40) === 0 ? ((s3 & 0x02) === 0 ? 0x74 : 0x2E) : ((s3 & 0x02) === 0 ? 0x3A : 0x5C);
      if (s2 & 0x08) base = ((base >>> 4) & 0x0F) | ((base & 0x0F) << 4);
      if (s1 & 0x01) base = ((base & 0x3F) << 2) & 0xFF;
      if (s0 & 0x01) base = (base << 1) & 0xFF;
      const temp = s3 ^ s1;
      s3 = (s3 & 0x7F) << 1; if (s2 & 0x80) s3 |= 0x01;
      s2 = (s2 & 0x7F) << 1; if (s1 & 0x80) s2 |= 0x01;
      s1 = (s1 & 0x7F) << 1; if (s0 & 0x80) s1 |= 0x01;
      s0 = (s0 & 0x7F) << 1;
      const chk = base ^ (r ^ temp);
      if (chk & 0x80) s0 |= 0x01;
      r = (r & 0x7F) << 1;
    }
    roundIndex = (roundIndex - 1) & 0x7;
  }
  return s0 | (s1 << 8);
}

/**
 * Kia V5: FM, Manchester at 400 / 800 us (events mapped the other way round from pp_manchester_event) after a
 * short-pair preamble. 64 key bits plus a 3-bit CRC; the bit-reversed key ("Yek") holds the button, a 28-bit serial
 * and a counter scrambled by a keyed mixer.
 */
export class PPKiaV5 extends PPDecoder {
  private decodedData = 0n;
  private savedKey = 0n;
  private bitCount = 0;
  private yek = 0n;
  private crc = 0;

  constructor() { super('Kia V5', PPModulation.FM, ppConst(400, 800, 150, 64)); }

  override reset(): void {
    this.parserStep = STEP_RESET; this.headerCount = 0; this.bitCount = 0; this.decodedData = 0n; this.savedKey = 0n; this.yek = 0n; this.crc = 0;
    this.manchester = PPManchester.MID1;
  }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, c.teShort) < c.teDelta) {
          this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 1; this.bitCount = 0; this.decodedData = 0n;
          this.manchesterAdvance(PPManchester.RESET);
        }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) {
          if (this.dd(duration, c.teLong) < c.teDelta) {
            if (this.headerCount > 40) {
              this.parserStep = STEP_DATA; this.bitCount = 0; this.decodedData = 0n; this.savedKey = 0n; this.headerCount = 0;
            } else this.teLast = duration;
          } else if (this.dd(duration, c.teShort) < c.teDelta) this.teLast = duration;
          else this.parserStep = STEP_RESET;
        } else {
          if (this.dd(duration, c.teShort) < c.teDelta && this.dd(this.teLast, c.teShort) < c.teDelta) this.headerCount = (this.headerCount + 1) & 0xFFFF;
          else if (this.dd(duration, c.teLong) < c.teDelta && this.dd(this.teLast, c.teShort) < c.teDelta) this.headerCount = (this.headerCount + 1) & 0xFFFF;
          else if (this.dd(this.teLast, c.teLong) < c.teDelta) this.headerCount = (this.headerCount + 1) & 0xFFFF;
          else this.parserStep = STEP_RESET;
          this.teLast = duration;
        }
        break;
      case STEP_DATA: {
        let ev: number;
        if (this.dd(duration, c.teShort) < c.teDelta) ev = level ? PPManchester.SHORT_HIGH : PPManchester.SHORT_LOW;
        else if (this.dd(duration, c.teLong) < c.teDelta) ev = level ? PPManchester.LONG_HIGH : PPManchester.LONG_LOW;
        else {
          if (this.bitCount >= c.minBits) {
            this.data = this.savedKey;
            this.dataCountBit = this.bitCount > 67 ? 67 : this.bitCount;
            this.crc = Number(this.decodedData & 0x07n);
            let yek = 0n;
            for (let i = 0; i < 8; i++) {
              const byte = Number((this.data >> BigInt(i * 8)) & 0xFFn);
              yek |= BigInt(PPMath.reverseBits8(byte)) << BigInt((7 - i) * 8);
            }
            this.yek = yek;
            this.serial = (yek >> 32n) & 0x0FFFFFFFn;
            this.btn = Number((yek >> 60n) & 0x0Fn);
            this.cnt = BigInt(kiaV5MixerDecode(yek & M32));
            this.emit();
          }
          this.parserStep = STEP_RESET;
          return;
        }
        if (this.bitCount <= 66) {
          const bit = this.manchesterAdvance(ev);
          if (bit >= 0) {
            this.decodedData = ((this.decodedData << 1n) | BigInt(bit)) & MASK64;
            this.bitCount++;
            if (this.bitCount === 64) { this.savedKey = this.decodedData; this.decodedData = 0n; }
          }
        }
        this.teLast = duration;
        break;
      }
    }
  }

  override describe(): PPHit {
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hx('%X', this.btn), cnt: this.cnt,
      fields: [{ name: 'Yek', value: hx('%016X', this.yek) }, { name: 'CRC', value: hx('%X', this.crc) }] };
  }

  /** kia_v5.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nYek:%08lX%08lX\r\nSn:%07lX Btn:%X Cnt:%04lX\r\nCRC:%X\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Yek:${h.fields[0].value} | ` + hx('Sn:%07X', h.serial ?? 0n) +
      ` Btn:${h.btn ?? ''} ` + hx('Cnt:%04X', h.cnt ?? 0n) + ` | CRC:${h.fields[1].value}`;
  }
}
