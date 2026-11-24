/**
 * Who is on a DMR channel (ETSI TS 102 361-1 and -2), built on Fleet's DMR layers (the burst framer, slot type,
 * BPTC, Reed-Solomon and embedded-LC assembly, talker alias): per time slot the color code, group or private call,
 * talkgroup or called radio, the calling radio's ID, its talker alias, and its position when it sends one:
 *
 *   · the GPS Info LC (FLCO 8, feature set 0) in the embedded signaling: 4 reserved bits, a 3-bit position error,
 *     25 bits of longitude (two's complement, 360 / 2^25 degrees) and 24 of latitude (180 / 2^24 degrees);
 *   · NMEA sentences carried in rate 1/2 packet data (a data header with its CRC, then the blocks it announces,
 *     unconfirmed 12 bytes or confirmed 10 bytes each, the last 4 bytes of the last block being the packet CRC);
 *     a sentence counts only when its own checksum checks; rate 3/4 data blocks the same way (dmrdata.ts);
 *   · ETSI LIP short location reports, in UDP to port 5017 inside that packet data, or in a USBD poll response;
 *     Motorola LRRP reports in UDP on port 4001. Rate 1 data and Hytera's location protocol are not read here.
 *
 * Voice bursts hand their three 72-bit AMBE+2 frames on ([onVoiceFrame]), each with the symbol time it was sent.
 *
 * Fed soft symbols at 4800/s, outer levels near ±3. A mobile heard directly (MS sync, no CACH) reads as slot 1. No DOM.
 */
import { DmrFramer, type DmrEvent } from '../fleet/rx.js';
import { readEmb, embBits, EmbLcAssembler, parseEmbLc, TalkerAlias, rs129Ok, voiceFrames } from '../fleet/lc.js';
import { crc12Ok } from '../fleet/codes.js';
import { parseNmea, type Position } from './gps.js';
import { rate34Decode, lipInIp, lrrpInIp, usbdLip, type LipReport } from './dmrdata.js';
import type { HamVoiceFrame } from './voice.js';

export interface DmrSlotId {
  slot: number; cc: number; group: boolean; tg: number; src: number; alias: string;
  emergency: boolean; privacy: boolean; position: Position | null; posError: number;
  /** From a LIP report: speed (km/h, -1 unknown) and heading (degrees); -1 when the position came some other way. */
  speedKmh: number; heading: number;
  /** 'voice' while a call is heard on the slot, 'data' after a data header, 'idle' when only idle bursts came, '' nothing. */
  activity: string; calls: number; lastSym: number;
}

/** The GPS Info LC's position (FLCO 8), or null when it is not one or holds no position. */
export function gpsInfoLc(b: ArrayLike<number>): { pos: Position; err: number } | null {
  if ((b[0] & 0x3f) !== 8 || b[1] !== 0) return null;
  const err = (b[2] >> 1) & 7;
  let lon = ((b[2] & 1) << 24) | (b[3] << 16) | (b[4] << 8) | b[5];
  let lat = (b[6] << 16) | (b[7] << 8) | b[8];
  if (lon & 0x1000000) lon -= 0x2000000;
  if (lat & 0x800000) lat -= 0x1000000;
  const pos: Position = { lat: lat * 180 / 16777216, lon: lon * 360 / 33554432, source: 'dmr-gps-lc' };
  if (Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { pos, err };
}

/** NMEA sentences with good checksums anywhere in a byte payload; the last one with a position. */
export function nmeaInPayload(b: ArrayLike<number>): Position | null {
  let s = ''; for (let i = 0; i < b.length; i++) { const c = b[i] & 255; s += c >= 32 && c < 127 ? String.fromCharCode(c) : '\n'; }
  let found: Position | null = null;
  for (const m of s.match(/\$[A-Z]{2}[A-Z]{3},[^$\n]*\*[0-9A-F]{2}/g) ?? []) { const p = parseNmea(m); if (p) { p.source = 'dmr-data'; found = p; } }
  return found;
}

interface Pending { blocks: number; confirmed: boolean; src: number; dst: number; group: boolean; got: Uint8Array[]; dt: number }

/** The 196 payload bits of a data burst's dibits (before and after the center field). */
function payloadBits(d: ArrayLike<number>): Uint8Array {
  const raw = new Uint8Array(196); let p = 0;
  for (let i = 12; i <= 60; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  for (let i = 95; i <= 143; i++) { raw[p++] = d[i] >> 1; raw[p++] = d[i] & 1; }
  return raw;
}

export class DmrIdentity {
  readonly framer = new DmrFramer();
  /** Each 72-bit vocoder frame of a voice burst, stream 'dmr1' or 'dmr2'. */
  onVoiceFrame: (f: HamVoiceFrame) => void = () => undefined;
  readonly slots: [DmrSlotId, DmrSlotId] = [DmrIdentity.blank(1), DmrIdentity.blank(2)];
  private readonly emb = [new EmbLcAssembler(), new EmbLcAssembler()];
  private readonly alias = [new TalkerAlias(), new TalkerAlias()];
  private readonly pending: (Pending | null)[] = [null, null];
  private t = 0;
  /** Bursts whose check (RS, CRC or embedded LC checksum) passed. */
  checked = 0;
  /** Data bursts whose slot type came through Golay without a correction (an idle repeater sends only these). */
  clean = 0;
  private readonly ccVotes = new Int32Array(16);

  constructor() {
    this.framer.onBurst = e => this.burst(e);
    this.framer.onVoice = (slot, d, n) => this.voice(slot, d, n);
  }
  private static blank(slot: number): DmrSlotId { return { slot, cc: -1, group: true, tg: 0, src: 0, alias: '', emergency: false, privacy: false, position: null, posError: -1, speedKmh: -1, heading: -1, activity: '', calls: 0, lastSym: -1 }; }

  /** The system's color code: the most common among bursts that came through clean, or -1. */
  get cc(): number { let b = -1, v = 0; for (let i = 0; i < 16; i++) if (this.ccVotes[i] > v) { v = this.ccVotes[i]; b = i; } return b; }

  reset(): void {
    this.slots[0] = DmrIdentity.blank(1); this.slots[1] = DmrIdentity.blank(2);
    for (const e of this.emb) e.reset(); for (const a of this.alias) a.reset();
    this.pending[0] = this.pending[1] = null; this.t = 0; this.checked = 0; this.clean = 0; this.ccVotes.fill(0);
  }

  pushSymbol(s: number): void { this.t++; this.framer.push(s); }

  private burst(e: DmrEvent): void {
    const b = e.burst, ts = this.slots[b.slot & 1], k = b.slot & 1;
    if (b.stErrs > 2) return;
    if (b.stErrs === 0) {
      this.ccVotes[b.cc]++; this.clean++; ts.cc = b.cc;
      if (b.dt === 9 && ts.activity === '') ts.activity = 'idle';
    }
    if (b.dt === 1 || b.dt === 2) {
      if (!rs129Ok(b.bytes, b.dt)) return;
      this.checked++; ts.cc = b.cc; ts.lastSym = this.t;
      this.lc(k, b.bytes, b.dt === 1);
      if (b.dt === 2) ts.activity = '';
    } else if (b.dt === 6) {
      if (!crc12Ok(b.bytes, 0xcccc)) return;
      this.checked++; ts.cc = b.cc; ts.lastSym = this.t;
      const dpf = b.bytes[0] & 15;
      const src = (b.bytes[5] << 16) | (b.bytes[6] << 8) | b.bytes[7], dst = (b.bytes[2] << 16) | (b.bytes[3] << 8) | b.bytes[4];
      ts.activity = 'data';
      if (dpf === 2 || dpf === 3) this.pending[k] = { blocks: b.bytes[8] & 0x7f, confirmed: dpf === 3, src, dst, group: (b.bytes[0] & 0x80) !== 0, got: [], dt: 0 };
      if (src && src !== ts.src) { ts.src = src; ts.alias = ''; this.alias[k].reset(); }
      ts.tg = dst; ts.group = (b.bytes[0] & 0x80) !== 0;
    } else if (b.dt === 7 || b.dt === 8) {
      const p = this.pending[k]; if (!p || (p.dt && p.dt !== b.dt)) return;
      p.dt = b.dt;
      p.got.push(b.dt === 7 ? b.bytes : rate34Decode(payloadBits(e.dibits)).bytes);
      if (p.got.length >= p.blocks) {
        this.pending[k] = null;
        const parts: number[] = [];
        p.got.forEach(g => { for (let i = p.confirmed ? 2 : 0; i < g.length; i++) parts.push(g[i]); });
        const body = parts.slice(0, Math.max(0, parts.length - 4));
        const lip = lipInIp(body), lrrp = lip ? null : lrrpInIp(body);
        const pos = lip || lrrp ? null : nmeaInPayload(body);
        if (lip) this.lip(ts, lip);
        else if (lrrp) { ts.position = { lat: lrrp.lat, lon: lrrp.lon, source: lrrp.source }; ts.posError = -1; ts.speedKmh = -1; ts.heading = lrrp.heading; }
        else if (pos) { ts.position = pos; ts.posError = -1; ts.speedKmh = -1; ts.heading = -1; }
      }
    } else if (b.dt === 11) {
      if (!crc12Ok(b.bytes, 0x3333)) return;
      this.checked++; ts.cc = b.cc; ts.lastSym = this.t;
      const lip = usbdLip(b.bytes);
      if (lip) this.lip(ts, lip);
    }
  }
  private lip(ts: DmrSlotId, r: LipReport): void {
    ts.position = { lat: r.lat, lon: r.lon, source: r.source }; ts.posError = r.posError; ts.speedKmh = r.speedKmh; ts.heading = r.heading;
  }

  private voice(slot: number, d: Uint8Array, n: number): void {
    const k = slot & 1, ts = this.slots[k];
    voiceFrames(d).forEach((bits, j) => this.onVoiceFrame({ stream: 'dmr' + (k + 1), codec: 'ambe2', bits, atSym: this.t - 132 + 36 * j, errs: 0 }));
    if (n < 1 || n > 4) return;
    const emb = readEmb(d);
    if (!emb.ok) return;
    // a voice sync alone can be chance: the slot is in a call once its embedded signaling checks
    if (ts.activity !== 'voice') { ts.activity = 'voice'; ts.calls++; }
    ts.lastSym = this.t;
    ts.cc = emb.cc; ts.privacy = emb.pi;
    const lc = this.emb[k].push(emb.lcss, embBits(d));
    if (lc) { this.checked++; this.lc(k, lc, false); }
  }

  /** Link control from a voice header or terminator (12 bytes) or the embedded signaling (9). */
  private lc(k: number, b: ArrayLike<number>, header: boolean): void {
    const ts = this.slots[k];
    const g = gpsInfoLc(b);
    if (g) { ts.position = g.pos; ts.posError = g.err; ts.speedKmh = -1; ts.heading = -1; return; }
    const e = parseEmbLc(Uint8Array.from(Array.from({ length: 9 }, (_, i) => b[i])));
    if (!e) return;
    if (e.kind === 'voice') {
      if (e.lc.src !== ts.src) { ts.alias = ''; this.alias[k].reset(); if (ts.position && ts.position.source === 'dmr-gps-lc') { ts.position = null; ts.posError = -1; } }
      ts.tg = e.lc.dst; ts.src = e.lc.src; ts.group = e.lc.group; ts.emergency = e.lc.emergency; ts.privacy = e.lc.privacy;
      if (header && ts.activity !== 'voice') { ts.activity = 'voice'; ts.calls++; }
    } else {
      const name = this.alias[k].push(e.part, e.bytes);
      if (name) ts.alias = name;
    }
  }
}
