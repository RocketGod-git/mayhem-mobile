/**
 * Field extraction per remote type (Mayhem ui_subghzd.cpp SubGhzDRecentEntryDetailView::parseProtocol + update_data +
 * SubGhzDView::getSensorTypeName; twin of ism/RemoteFields.kt). Mayhem's serial / cnt are uint32 and btn is uint8, so
 * every assignment truncates the same way here; cnt is the 32-bit value reinterpreted as a signed int (as in Kotlin).
 */
import { FG, S } from './base.js';

/**
 * One decoded remote frame. `serial` is Mayhem's uint32 serial (0 when the protocol has none); `btn` / `cnt` are null when
 * Mayhem leaves them at SD_NO_BTN / SD_NO_CNT. `extra` holds the additional "key: value" lines the Mayhem detail view prints
 * for special protocols (restaurant pager station/pager/action, KeeLoq fix/encrypted/manufacturer, FAAC seed).
 */
export interface RemoteInfo { name: string; serial: bigint; btn: number | null; cnt: number | null; extra: string[] }

const NAMES: Record<number, string> = {
  [S.PRINCETON]: 'Princeton', [S.BETT]: 'Bett', [S.CAME]: 'Came', [S.PRASTEL]: 'Prastel', [S.AIRFORCE]: 'Airforce',
  [S.CAME_ATOMO]: 'Came Atomo', [S.CAME_TWEE]: 'Came Twee', [S.CHAMBCODE]: 'Chamb Code', [S.CLEMSA]: 'Clemsa', [S.DOITRAND]: 'Doitrand',
  [S.DOOYA]: 'Dooya', [S.FAAC]: 'Faac', [S.GATE_TX]: 'Gate TX', [S.HOLTEK]: 'Holtek', [S.HOLTEK_HT12X]: 'Holtek HT12X',
  [S.HONEYWELL]: 'Honeywell', [S.HONEYWELL_WDB]: 'Honeywell Wdb', [S.HORMANN]: 'Hormann', [S.IDO]: 'Ido 11x', [S.INTERTECHNO_V3]: 'Intertechno v3',
  [S.SUPERROLLO]: 'Superrollo', [S.KEELOQ]: 'KeeLoq', [S.KINGGATES_STYLO_4K]: 'Kinggate Stylo4K', [S.LINEAR]: 'Linear', [S.LINEAR_DELTA3]: 'Linear Delta3',
  [S.MAGELLAN]: 'Magellan', [S.MARANTEC]: 'Marantec', [S.MASTERCODE]: 'Mastercode', [S.MEGACODE]: 'Megacode', [S.NERO_RADIO]: 'Nero Radio',
  [S.NERO_SKETCH]: 'Nero Sketch', [S.NICE_FLO]: 'Nice Flo', [S.NICE_FLORS]: 'Nice Flor S', [S.PHOENIX_V2]: 'Phoenix V2', [S.POWER_SMART]: 'PowerSmart',
  [S.SECPLUS_V1]: 'SecPlus V1', [S.SECPLUS_V2]: 'SecPlus V2', [S.SMC5326]: 'SMC5326', [S.STARLINE]: 'Star Line', [S.X10]: 'X10',
  [S.LEGRAND]: 'Legrand', [S.SOMFY_KEYTIS]: 'Somfy Keytis', [S.SOMFY_TELIS]: 'Somfy Telis', [S.GANGQI]: 'GangQi', [S.MARANTEC24]: 'Marantec24',
  [S.HOLTEK_HT6P20B]: 'Holtek HT6P20B', [S.RESTAURANT_PAGER]: 'Rest. Pager',
};

export function remoteName(type: number): string { return NAMES[type] ?? 'Unknown'; }

const M32 = 0xFFFFFFFFn;
const u32 = (v: bigint): bigint => v & M32;
/** uint32 -> signed 32-bit number, matching Kotlin's Long.toInt(). */
const i32 = (v: bigint): number => Number(v & M32) | 0;
const hex8 = (v: bigint): string => (v & M32).toString(16).toUpperCase().padStart(8, '0');
const hex2 = (v: number): string => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');

const CAME_TWEE_MAGIC_NUMBERS_XOR = [
  0x0E0E0E00n, 0x1D1D1D11n, 0x2C2C2C22n, 0x3B3B3B33n, 0x4A4A4A44n, 0x59595955n, 0x68686866n, 0x77777777n,
  0x86868688n, 0x95959599n, 0xA4A4A4AAn, 0xB3B3B3BBn, 0xC2C2C2CCn, 0xD1D1D1DDn, 0xE0E0E0EEn,
];

function atomoDecrypt(buff: number[]): void {
  buff[0] = (buff[0] ^ 5) & 0x7F;
  let tmpB = (-buff[0]) & 0x7F;
  let bitCnt = 8;
  while (bitCnt < 59) {
    tmpB = ((tmpB & 0x18) && (((tmpB >>> 3) & 3) !== 3)) ? ((tmpB << 1) & 0xFF) | 1 : (tmpB << 1) & 0xFF;
    if (tmpB & 0x80) buff[bitCnt >>> 3] ^= (0x80 >>> (bitCnt & 7));
    bitCnt++;
  }
}

export function parseRemote(type: number, data: bigint, bits: number): RemoteInfo {
  const name = remoteName(type);
  let serial = 0n; let btn: number | null = null; let cnt: number | null = null;
  const extra: string[] = [];
  switch (type) {
    case S.CAME_ATOMO: {
      const d = ((data ^ 0xFFFFFFFFFFFFFFFFn) << 4n) & 0xFFFFFFFFFFFFFFFFn;
      const pack: number[] = [];
      for (let i = 0; i < 8; i++) pack.push(FG.bits(d, 56 - i * 8, 0xFF));
      atomoDecrypt(pack);
      cnt = (pack[1] << 8) | pack[2];
      serial = u32((BigInt(pack[3]) << 24n) | (BigInt(pack[4]) << 16n) | (BigInt(pack[5]) << 8n) | BigInt(pack[6]));
      switch (pack[7] >>> 4) { case 0x0: btn = 0x1; break; case 0x2: btn = 0x2; break; case 0x4: btn = 0x3; break; case 0x6: btn = 0x4; break; }
      break;
    }
    case S.CAME_TWEE: {
      const cntParcel = Number(data & 0xFn);
      // Mayhem indexes the 15-entry table unguarded (UB for parcel 15); the protocol never emits it, so yield nothing.
      if (cntParcel >= CAME_TWEE_MAGIC_NUMBERS_XOR.length) break;
      let d = u32(data) ^ CAME_TWEE_MAGIC_NUMBERS_XOR[cntParcel];
      serial = d;
      d /= 4n;
      btn = FG.bits(d, 4, 0x0F);
      d >>= 16n;
      d = FG.reverseKey(d, 16) & 0xFFFFn;
      cnt = Number(d >> 6n);
      break;
    }
    case S.CLEMSA: serial = (data >> 2n) & 0xFFFFn; btn = Number(data & 0x03n); break;
    case S.DOITRAND: cnt = i32((data >> 24n) | ((data >> 15n) & 0x1n)); btn = FG.bits(data, 18, 0x3); break;
    case S.DOOYA:
      serial = u32(data >> 16n);
      cnt = ((data >> 12n) & 0x0Fn) !== 0n ? FG.bits(data, 8, 0x0F) : 0xff;
      btn = Number(data & 0xFFn);
      break;
    case S.FAAC: {
      const codeFix = u32(data >> 32n); const codeHop = u32(data);
      const p = [
        Number(codeHop & 0xFFn), Number((codeHop >> 8n) & 0xFFn), Number((codeHop >> 16n) & 0xFFn), Number(codeHop >> 24n),
        Number(codeFix & 0xFFn), Number((codeFix >> 8n) & 0xFFn), Number((codeFix >> 16n) & 0xFFn), Number(codeFix >> 24n),
      ];
      if (p[7] === 0x52 && p[6] === 0x0F && p[0] === 0x00) {
        for (let i = p[1] & 0xF; i !== 0; i--) {
          const tmp = p[2];
          p[2] = (p[2] >>> 1) | ((p[3] & 1) << 7);
          p[3] = (p[3] >>> 1) | ((p[4] & 1) << 7);
          p[4] = (p[4] >>> 1) | ((p[5] & 1) << 7);
          p[5] = (p[5] >>> 1) | ((tmp & 1) << 7);
        }
        p[2] ^= p[1]; p[3] ^= p[1]; p[4] ^= p[1]; p[5] ^= p[1];
        const seed = (BigInt(p[5]) << 24n) | (BigInt(p[4]) << 16n) | (BigInt(p[3]) << 8n) | BigInt(p[2]);
        cnt = p[1];
        extra.push('Seed: ' + hex8(seed));
      } else if (codeFix !== 0n) { serial = codeFix >> 4n; btn = Number(codeFix & 0xFn); }
      break;
    }
    case S.GATE_TX: {
      const r = u32(FG.reverseKey(data, bits));
      serial = u32(((r & 0xFFn) << 12n) | (((r >> 8n) & 0xFFn) << 4n) | ((r >> 20n) & 0x0Fn));
      btn = FG.bits(r, 16, 0x0F);
      break;
    }
    case S.HOLTEK:
      if ((data & 0xF000000000n) === 0x5000000000n) {
        serial = u32(FG.reverseKey((data >> 16n) & 0xFFFFFn, 20));
        const b = Number(data & 0xFFFFn);
        if ((b & 0xf) !== 0xA) btn = (0x1 << 4) | (b & 0xF);
        else if (((b >>> 4) & 0xF) !== 0xA) btn = (0x2 << 4) | ((b >>> 4) & 0xF);
        else if (((b >>> 8) & 0xF) !== 0xA) btn = (0x3 << 4) | ((b >>> 8) & 0xF);
        else if (((b >>> 12) & 0xF) !== 0xA) btn = (0x4 << 4) | ((b >>> 12) & 0xF);
        else btn = 0;
      } else { serial = 0n; btn = 0; cnt = 0; }
      break;
    case S.HOLTEK_HT12X: btn = Number(data & 0x0Fn); cnt = FG.bits(data, 4, 0xFF); break;
    case S.HONEYWELL: serial = (data >> 24n) & 0xFFFFFn; btn = FG.bits(data, 16, 0xFF); cnt = FG.bits(data, 44, 0xF); break;
    case S.HONEYWELL_WDB: serial = (data >> 28n) & 0xFFFFFn; break;
    case S.HORMANN: btn = FG.bits(data, 8, 0xF); break;
    case S.IDO: {
      const codeFix = FG.reverseKey(data, bits) & 0xFFFFFFn;
      serial = codeFix & 0xFFFFFn; btn = FG.bits(codeFix, 20, 0x0F);
      break;
    }
    case S.INTERTECHNO_V3:
      if (bits === 32) {
        serial = (data >> 6n) & 0x3FFFFFFn;
        cnt = ((data >> 5n) & 0x1n) !== 0n ? 1 << 5 : Number(~data & 0xFn);
        btn = FG.bits(data, 4, 0x1);
      } else if (bits === 36) {
        serial = (data >> 10n) & 0x3FFFFFFn;
        cnt = ((data >> 9n) & 0x1n) !== 0n ? 1 << 5 : Number(~(data >> 4n) & 0xFn);
        btn = Number(data & 0xFn);
      } else { serial = 0n; cnt = 0; btn = 0; }
      break;
    case S.KEELOQ: case S.SUPERROLLO: {
      // No manufacturer keystore here: raw fix/hop split only, cnt stays absent and manufacturer is unknown.
      const rev = FG.reverseKey(data, 64);
      btn = Number(rev >> 60n);
      serial = (rev >> 32n) & 0xFFFFFFFn;
      const fix = u32(rev >> 32n); const encrypted = u32(rev);
      extra.push('Fix: ' + hex8(fix), 'Encrypted: ' + hex8(encrypted), 'Manufacturer: Unknown');
      break;
    }
    case S.KINGGATES_STYLO_4K: {
      const fix = FG.reverseKey(data, 53);
      btn = FG.bits(fix, 17, 0x0F);
      serial = u32(((fix >> 5n) & 0xFFFF0000n) | (fix & 0xFFFFn));
      break;
    }
    case S.MAGELLAN: { const rev = FG.reverseKey(data >> 8n, 24); serial = rev & 0xFFFFn; btn = FG.bits(rev, 16, 0xFF); break; }
    case S.MARANTEC: btn = FG.bits(data, 16, 0xF); serial = u32(((data >> 12n) & 0xFFFFFF00n) | ((data >> 8n) & 0xFFn)); break;
    case S.MASTERCODE: serial = (data >> 4n) & 0xFFFFn; btn = FG.bits(data, 2, 0x03); break;
    case S.MEGACODE:
      if ((data >> 23n) === 1n) { serial = (data >> 3n) & 0xFFFFn; btn = Number(data & 0b111n); cnt = FG.bits(data, 19, 0b1111); }
      else { serial = 0n; btn = 0; cnt = 0; }
      break;
    case S.PHOENIX_V2: {
      // Mayhem reverses bits + 4 (52-bit frames -> 56); clamp to 64 so an oversized bit count stays defined.
      const rev = FG.reverseKey(data, Math.min(bits + 4, 64));
      serial = u32(rev); cnt = FG.bits(rev, 40, 0xFFFF); btn = FG.bits(rev, 32, 0xF);
      break;
    }
    case S.POWER_SMART:
      btn = Number(((data >> 54n) & 0x02n) | ((data >> 40n) & 0x1n));
      serial = ((data >> 33n) & 0x3FFF00n) | ((data >> 32n) & 0xFFn);
      cnt = FG.bits(data, 49, 0x3F);
      break;
    case S.PRINCETON: serial = u32(data >> 4n); btn = Number(data & 0xFn); break;
    case S.SECPLUS_V1: {
      const fixed = u32(data >> 32n);
      cnt = i32(data);
      btn = Number(fixed % 3n);
      const id1 = (fixed / 9n) % 3n;
      serial = id1 === 0n ? (fixed / 27n) % 2187n : fixed / 27n;
      break;
    }
    case S.STARLINE: {
      const keyFix = u32(FG.reverseKey(data, bits) >> 32n);
      serial = keyFix & 0x00FFFFFFn; btn = Number(keyFix >> 24n);
      break;
    }
    case S.X10:
      serial = (data & 0xF0000000n) >> BigInt(24 + 4);
      btn = Number(((data & 0x07000000n) >> 24n) | ((data & 0xF800n) >> 8n)) & 0xFF;
      break;
    case S.SOMFY_KEYTIS: {
      const d = data ^ (data >> 8n);
      btn = FG.bits(d, 48, 0xF); cnt = FG.bits(d, 24, 0xFFFF); serial = d & 0xFFFFFFn;
      break;
    }
    case S.SOMFY_TELIS: {
      const d = data ^ (data >> 8n);
      btn = FG.bits(d, 44, 0xF); cnt = FG.bits(d, 24, 0xFFFF); serial = d & 0xFFFFFFn;
      break;
    }
    case S.GANGQI: btn = 0; cnt = FG.bits(data, 32, 0xFF); serial = u32(data); break;
    case S.MARANTEC24: serial = u32(data >> 4n); btn = Number(data & 0xfn); break;
    case S.HOLTEK_HT6P20B: serial = u32(data >> 8n); btn = FG.bits(data, 4, 0xF); break;
    case S.RESTAURANT_PAGER: {
      // 25-bit EV1527-variant: [sysid:16][pager:4][func:4][stop:1]
      serial = (data >> 9n) & 0xFFFFn;
      const pagerAddr = FG.bits(data, 5, 0x0F);
      const funcCode = FG.bits(data, 1, 0x0F);
      extra.push('Station: 0x' + hex8(serial) + ' (' + serial.toString() + ')');
      extra.push('Pager: ' + pagerAddr);
      extra.push(funcCode === 0x0D ? 'Action: Buzz' : funcCode === 0x0F ? 'Action: Sync' : 'Action: 0x' + hex2(funcCode));
      break;
    }
    // BETT, CAME/PRASTEL/AIRFORCE, CHAMBCODE, LEGRAND, LINEAR(_DELTA3), NERO_*, NICE_FLO(RS), SECPLUS_V2, SMC5326: nothing in Mayhem.
    default: break;
  }
  return { name, serial, btn, cnt, extra };
}
