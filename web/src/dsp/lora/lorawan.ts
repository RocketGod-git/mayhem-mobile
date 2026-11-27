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

/**
 * The NetID a device address belongs to (LoRaWAN Backend Interfaces, DevAddr assignment). The address opens with its
 * NetID type in unary (0, 10, 110 ... for types 0 to 7), then the NwkID, whose width grows with the type.
 */
const NWKID_BITS = [6, 6, 9, 11, 12, 13, 15, 17];
export function netIdOf(devAddr: number): number {
  const a = devAddr >>> 0;
  let type = 0;
  while (type < 7 && ((a >>> (31 - type)) & 1) === 1) type++;
  const bits = NWKID_BITS[type], prefix = type + 1 + bits;
  const nwkId = (a >>> (32 - prefix)) & ((1 << bits) - 1);
  return ((type << 21) | nwkId) >>> 0;
}
/**
 * Public networks by NetID: The Things Network's copy of the LoRa Alliance NetID list
 * (thethingsnetwork.org/docs/lorawan/prefix-assignments) and Helium's own docs. An operator with several NetIDs has a
 * row for each; NetIDs not listed here show as a number.
 */
const OPERATORS: Record<number, string> = {
  0x000013: 'The Things Network', 0xc00058: 'The Things Network',
  0x00003c: 'Helium', 0x000024: 'Helium',
  0x000002: 'Actility', 0x600013: 'Actility', 0x000004: 'Swisscom', 0x000009: 'Senet', 0x600010: 'Senet',
  0x00000a: 'KPN', 0x60001f: 'KPN', 0x00000f: 'Orange', 0x000018: 'Loriot',
  0x000022: 'machineQ (Comcast)', 0x60001c: 'machineQ (Comcast)', 0x600002: 'Netmore', 0xc00012: 'Netmore',
  0x000038: 'Charter', 0x600028: 'Charter', 0x600020: 'Spectrum', 0xc0002e: 'Spectrum',
  0x000039: 'Amazon', 0x60002b: 'Amazon', 0x000003: 'Proximus', 0x000007: 'Bouygues', 0x60002a: 'Neptune', 0xc00050: 'Neptune',
};
/**
 * The MAC commands carried in a data frame's FOpts (LoRaWAN 1.0.x sends them in the clear; 1.1 encrypts them, and
 * then they do not line up and null comes back). Each is named, with its values where it has any. Device status adds
 * the battery and the link margin as their own fields.
 */
const MAC_UP: Record<number, [string, number]> = { 0x02: ['link check request', 0], 0x03: ['ADR answer', 1], 0x04: ['duty cycle answer', 0], 0x05: ['RX setup answer', 1], 0x06: ['device status', 2], 0x07: ['new channel answer', 1], 0x08: ['RX timing answer', 0], 0x09: ['TX setup answer', 0], 0x0a: ['downlink channel answer', 1], 0x0d: ['device time request', 0] };
const MAC_DOWN: Record<number, [string, number]> = { 0x02: ['link check answer', 2], 0x03: ['ADR request', 4], 0x04: ['duty cycle request', 1], 0x05: ['RX setup request', 4], 0x06: ['device status request', 0], 0x07: ['new channel request', 5], 0x08: ['RX timing request', 1], 0x09: ['TX setup request', 1], 0x0a: ['downlink channel request', 4], 0x0d: ['device time answer', 5] };
export function macCommands(o: Uint8Array, uplink: boolean): { list: string[]; extra: Field[] } | null {
  const table = uplink ? MAC_UP : MAC_DOWN, list: string[] = [], extra: Field[] = [];
  const acks = (s: number, names: string[]) => names.map((n, i) => `${n} ${(s >> i) & 1 ? 'ok' : 'refused'}`).join(', ');
  for (let i = 0; i < o.length;) {
    const cid = o[i], def = table[cid];
    if (!def || i + 1 + def[1] > o.length) return null;
    const a = o.subarray(i + 1, i + 1 + def[1]);
    let text = def[0];
    if (uplink && cid === 0x06) {
      const batt = a[0], margin = ((a[1] & 0x3f) ^ 0x20) - 0x20;
      const b = batt === 0 ? 'external power' : batt === 255 ? 'unknown' : `${Math.round(batt / 254 * 100)}%`;
      text += `: battery ${b}, margin ${margin} dB`;
      extra.push(['DEVICE BATTERY', b], ['LINK MARGIN', `${margin} dB`]);
    } else if (uplink && cid === 0x03) text += `: ${acks(a[0], ['power', 'data rate', 'channel mask'])}`;
    else if (uplink && (cid === 0x05 || cid === 0x07 || cid === 0x0a)) text += `: ${acks(a[0], cid === 0x05 ? ['RX1 offset', 'RX2 rate', 'channel'] : ['channel frequency', 'data rate range'])}`;
    else if (!uplink && cid === 0x02) { text += `: margin ${a[0]} dB, ${a[1]} gateway${a[1] === 1 ? '' : 's'}`; extra.push(['GATEWAYS HEARD', `${a[1]}`]); }
    else if (!uplink && cid === 0x03) text += `: data rate ${a[0] >> 4}, power index ${a[0] & 0x0f}, channel mask ${hexU(a[1] | (a[2] << 8), 4)}`;
    else if (!uplink && cid === 0x04) text += `: at most 1/${2 ** (a[0] & 0x0f)} of the time`;
    else if (!uplink && cid === 0x07) text += `: channel ${a[0]} at ${((a[1] | (a[2] << 8) | (a[3] << 16)) / 10_000).toFixed(4)} MHz`;
    else if (!uplink && cid === 0x08) text += `: ${Math.max(1, a[0] & 0x0f)} s`;
    list.push(text);
    i += 1 + def[1];
  }
  return { list, extra };
}

/** The operator a device address belongs to, or its NetID when the network is not one listed. */
export function networkOf(devAddr: number): string {
  const id = netIdOf(devAddr);
  return OPERATORS[id] ?? `NetID ${hexU(id, 6)}`;
}

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
      p.fields = [['DEVICE ADDRESS', hexU(p.devAddr, 8)], ['NETWORK', networkOf(p.devAddr)], ['FRAME COUNT', `${p.fcnt}`]];
      if (f.length > 0) p.fields.push(['FLAGS', f.join(', ')]);
      if (nopt > 0) {
        const mac = macCommands(b.subarray(8, 8 + nopt), p.uplink);
        if (mac) { p.fields.push(['MAC COMMANDS', mac.list.join('; ')]); p.fields.push(...mac.extra); }
        else p.fields.push(['MAC OPTIONS', `${hexBytes(b, 8, 8 + nopt)} (encrypted, LoRaWAN 1.1)`]);
      }
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
