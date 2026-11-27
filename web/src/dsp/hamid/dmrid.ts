/**
 * Who is on a DMR channel (ETSI TS 102 361-1 and -2), built on Fleet's DMR layers (the burst framer, slot type,
 * BPTC, Reed-Solomon and embedded-LC assembly, talker alias): per time slot the color code, group or private call,
 * talkgroup or called radio, the calling radio's ID, its talker alias, and its position when it sends one:
 *
 *   · the GPS Info LC (FLCO 8, feature set 0) in the embedded signaling: 4 reserved bits, a 3-bit position error,
 *     25 bits of longitude (two's complement, 360 / 2^25 degrees) and 24 of latitude (180 / 2^24 degrees);
 *   · packet data put back together by dmrpdu.ts (the data header, then its rate 1/2, 3/4 or 1 blocks and the
 *     message CRC): NMEA sentences that pass their own checksum, ETSI LIP short location reports in UDP to port 5017,
 *     Motorola LRRP in UDP on port 4001, and text messages (Motorola TMS on UDP port 4007, ETSI defined short data
 *     and UDT text) with the sending unit and where it went;
 *   · LIP in a USBD poll response. Hytera's location protocol is not read here.
 *
 * Voice bursts hand their three 72-bit AMBE+2 frames on ([onVoiceFrame]), each with the symbol time it was sent.
 *
 * Fed soft symbols at 4800/s, outer levels near ±3. A mobile heard directly (MS sync, no CACH) reads as slot 1. No DOM.
 */
import { DmrFramer, type DmrEvent } from '../fleet/rx.js';
import { readEmb, embBits, EmbLcAssembler, parseEmbLc, TalkerAlias, rs129Ok, voiceFrames, gpsInfoLc } from '../fleet/lc.js';
import { crc12Ok } from '../fleet/codes.js';
import type { Position } from './gps.js';
import { rate34Decode, usbdLip, type LipReport } from './dmrdata.js';
import { DmrPduAssembler, dmrPduContent, dmrPayloadBits, rate1Bytes } from './dmrpdu.js';
export { nmeaInPayload } from './dmrpdu.js';
export { gpsInfoLc } from '../fleet/lc.js';
import type { HamVoiceFrame } from './voice.js';

export interface DmrSlotId {
  slot: number; cc: number; group: boolean; tg: number; src: number; alias: string;
  emergency: boolean; privacy: boolean; position: Position | null; posError: number;
  /** From a LIP report: speed (km/h, -1 unknown) and heading (degrees); -1 when the position came some other way. */
  speedKmh: number; heading: number;
  /** 'voice' while a call is heard on the slot, 'data' after a data header, 'idle' when only idle bursts came, '' nothing. */
  activity: string; calls: number; lastSym: number;
  /** The last text message on the slot: who sent it, where it went (a talkgroup when [group]), how it came, the text. */
  message: DmrText | null;
}
export interface DmrText { src: number; dst: number; group: boolean; via: string; text: string }

export class DmrIdentity {
  readonly framer = new DmrFramer();
  /** Each 72-bit vocoder frame of a voice burst, stream 'dmr1' or 'dmr2'. */
  onVoiceFrame: (f: HamVoiceFrame) => void = () => undefined;
  readonly slots: [DmrSlotId, DmrSlotId] = [DmrIdentity.blank(1), DmrIdentity.blank(2)];
  private readonly emb = [new EmbLcAssembler(), new EmbLcAssembler()];
  private readonly alias = [new TalkerAlias(), new TalkerAlias()];
  private readonly pdu = [new DmrPduAssembler(), new DmrPduAssembler()];
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
  private static blank(slot: number): DmrSlotId { return { slot, cc: -1, group: true, tg: 0, src: 0, alias: '', emergency: false, privacy: false, position: null, posError: -1, speedKmh: -1, heading: -1, activity: '', calls: 0, lastSym: -1, message: null }; }

  /** The system's color code: the most common among bursts that came through clean, or -1. */
  get cc(): number { let b = -1, v = 0; for (let i = 0; i < 16; i++) if (this.ccVotes[i] > v) { v = this.ccVotes[i]; b = i; } return b; }

  reset(): void {
    this.slots[0] = DmrIdentity.blank(1); this.slots[1] = DmrIdentity.blank(2);
    for (const e of this.emb) e.reset(); for (const a of this.alias) a.reset();
    this.pdu[0].reset(); this.pdu[1].reset(); this.t = 0; this.checked = 0; this.clean = 0; this.ccVotes.fill(0);
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
      const h = this.pdu[k].header(b.bytes);
      ts.activity = 'data';
      if (!h) return;
      if (h.src && h.src !== ts.src) { ts.src = h.src; ts.alias = ''; this.alias[k].reset(); }
      ts.tg = h.dst; ts.group = h.group;
    } else if (b.dt === 7 || b.dt === 8 || b.dt === 10) {
      if (!this.pdu[k].open) return;
      const p = this.pdu[k].block(b.dt === 7 ? b.bytes : b.dt === 8 ? rate34Decode(dmrPayloadBits(e.dibits)).bytes : rate1Bytes(dmrPayloadBits(e.dibits)));
      const x = p && dmrPduContent(p);
      if (!p || !x) return;
      if (x.pos) { ts.position = x.pos; ts.posError = x.posError; ts.speedKmh = x.speedKmh; ts.heading = x.heading; }
      if (x.kind === 'text') ts.message = { src: p.hdr.src, dst: p.hdr.dst, group: p.hdr.group, via: x.via, text: x.text };
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
