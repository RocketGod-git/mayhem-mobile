/**
 * LoRaWAN MAC frames (LoRaWAN 1.0.x / 1.1 frame layout). Port of core/lora/LoraWan.swift: MHDR, then a join request
 * with its EUIs, or a data frame with its device address, frame counter, options and port. The application payload
 * is encrypted with the device's own session key, so only the header is readable.
 */
import { hexBytes, type Field } from './meshtastic.js';

export const LW_TYPE_NAMES = ['JOIN REQUEST', 'JOIN ACCEPT', 'UPLINK', 'DOWNLINK', 'CONFIRMED UPLINK', 'CONFIRMED DOWNLINK', 'REJOIN REQUEST', 'PROPRIETARY'];

export interface LoraWanPacket {
  mtype: number;
  fields: Field[];
  devAddr: number | null;
  devEui: bigint | null; joinEui: bigint | null;
  fcnt: number | null; port: number | null;
  typeName: string;
  uplink: boolean;
}

const leBig = (b: Uint8Array, i: number, n: number): bigint => { let v = 0n; for (let k = 0; k < n; k++) v |= BigInt(b[i + k]) << BigInt(8 * k); return v; };
const le = (b: Uint8Array, i: number, n: number): number => Number(leBig(b, i, n));
const hexU = (v: number | bigint, w: number): string => v.toString(16).toUpperCase().padStart(w, '0');

export function parse(b: Uint8Array): LoraWanPacket | null {
  if (b.length < 12) return null;
  const mt = b[0] >> 5;
  if ((b[0] & 0x1c) !== 0 && mt !== 7) return null;      // RFU bits are zero
  const p: LoraWanPacket = { mtype: mt, fields: [], devAddr: null, devEui: null, joinEui: null, fcnt: null, port: null,
    typeName: LW_TYPE_NAMES[mt], uplink: mt === 0 || mt === 2 || mt === 4 || mt === 6 };
  const mic = hexBytes(b, b.length - 4);
  switch (mt) {
    case 0:
      if (b.length !== 23) return null;
      p.joinEui = leBig(b, 1, 8); p.devEui = leBig(b, 9, 8);
      p.fields = [['JOIN EUI', hexU(p.joinEui, 16)], ['DEVICE EUI', hexU(p.devEui, 16)], ['DEV NONCE', hexU(le(b, 17, 2), 4)], ['MIC', mic]];
      break;
    case 1:
      if (b.length !== 17 && b.length !== 33) return null;
      p.fields = [['CONTENT', "encrypted with the device's root key"], ['MIC', mic]];
      break;
    case 2: case 3: case 4: case 5: {
      const fctrl = b[5], nopt = fctrl & 0x0f;
      if (b.length < 12 + nopt) return null;
      p.devAddr = le(b, 1, 4); p.fcnt = le(b, 6, 2);
      const f: string[] = [];
      if (fctrl & 0x80) f.push('ADR');
      if ((fctrl & 0x40) && p.uplink) f.push('ADR ack request');
      if (fctrl & 0x20) f.push('ACK');
      if (fctrl & 0x10) f.push(p.uplink ? 'class B' : 'more pending');
      p.fields = [['DEVICE ADDRESS', hexU(p.devAddr, 8)], ['NETWORK', `NwkID ${hexU(p.devAddr >>> 25, 2)}`], ['FRAME COUNT', `${p.fcnt}`]];
      if (f.length > 0) p.fields.push(['FLAGS', f.join(', ')]);
      if (nopt > 0) p.fields.push(['MAC OPTIONS', hexBytes(b, 8, 8 + nopt)]);
      const rest = b.length - 4 - (8 + nopt);
      if (rest > 0) {
        p.port = b[8 + nopt];
        p.fields.push(['PORT', p.port === 0 ? '0 (MAC commands)' : `${p.port}`]);
        p.fields.push(['PAYLOAD', `${rest - 1} bytes, encrypted`]);
      }
      p.fields.push(['MIC', mic]);
      break;
    }
    case 6:
      p.fields = [['CONTENT', 'rejoin request'], ['MIC', mic]];
      break;
    default:
      p.fields = [['CONTENT', `proprietary, ${b.length} bytes`]];
  }
  return p;
}

export const LoraWan = { parse };
