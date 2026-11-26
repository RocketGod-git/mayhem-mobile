/**
 * Who is on an NXDN channel (NXDN TS 1-A Common Air Interface, TS 1-E Type-D), built on Fleet's NXDN framer
 * (fleet/nxdn.ts: the frame sync, the scrambler, the LICH, the SACCH superframe, the FACCH1, the Type-D SCCH, layer 3).
 * NXDN48 (2400 symbols a second) and NXDN96 (4800) are both read, each from the channel's symbols at its rate:
 *
 *   · the RAN (the radio access number, 6 bits) of the SACCH;
 *   · VCALL (in the SACCH superframe or a FACCH1): call type, group or unit, the source and destination IDs (16 bits),
 *     emergency, the cipher (0 clear, 1 scramble, 2 DES, 3 AES) and key, the voice option (EHR or EFR);
 *   · Type-D (IDAS) SCCH: INFO3 names the source, INFO4 and INFO2 the destination, each a 5-bit prefix and an 11-bit ID;
 *   · TX_REL and DISC end the call;
 *   · the voice: each 72-bit VCH (EHR) through the AMBE+2 decoder, or each 144-bit VCH of a 9600 EFR call through the
 *     IMBE decoder, unless the call is ciphered.
 * Data (fleet/nxdndata.ts): a data call's GPS position (NMEA or Kenwood's) or short message, a status, the Kenwood
 * talker alias. No DOM.
 */
import { NxdnFramer, type NxdnTraffic } from '../fleet/nxdn.js';
import type { Position } from './gps.js';
import { AmbeStream, ImbeStream } from './voice.js';

export interface NxdnId {
  /** 2400 (NXDN48) or 4800 (NXDN96) symbols a second, 0 before anything decodes. */
  baud: number;
  ran: number;
  /** 'conventional' (RDCH), 'trunked' (RTCH), 'Type-D' (RTCH2). */
  kind: string;
  src: number; dst: number; group: boolean; callType: number; emergency: boolean;
  cipher: number; keyId: number; voiceOpt: number;
  /** Type-D: IDs as prefix-ID. */
  typeD: boolean;
  activity: string; calls: number; voiceFrames: number; lastSym: number;
  /** Frames that passed a check of 12 bits or more (or a whole SACCH superframe, or a Type-D INFO1 to INFO4 run). */
  checked: number;
  /** The source's talker alias; the last position, status and short message a unit sent, and which unit. */
  alias: string; position: Position | null; status: number; text: string; dataUnit: number;
}
const blank = (): NxdnId => ({ baud: 0, ran: -1, kind: '', src: 0, dst: 0, group: true, callType: -1, emergency: false, cipher: 0, keyId: 0, voiceOpt: 0, typeD: false, activity: '', calls: 0, voiceFrames: 0, lastSym: -1, checked: 0, alias: '', position: null, status: -1, text: '', dataUnit: 0 });

const FSW = [-3, 1, -3, 3, -3, -3, 3, 3, -1, 3];
/**
 * One baud rate's framer. Each frame sync found also sets the level the frame after it is read at (the sync's mean
 * size is 2.6): the symbol recovery's own level is slow to settle at the start of a transmission, and the framer slices
 * at fixed levels.
 */
class Rate {
  readonly framer = new NxdnFramer();
  readonly ambe = new AmbeStream(); readonly imbe = new ImbeStream();
  checked = 0; t = 0;
  private readonly ring = new Float32Array(10); private rp = 0; private g = 1;
  constructor(readonly baud: number) {}
  push(s: number): void {
    this.t++;
    this.ring[this.rp] = s; this.rp = (this.rp + 1) % 10;
    let c = 0, a = 0; for (let k = 0; k < 10; k++) { const x = this.ring[(this.rp + k) % 10]; c += x * FSW[k]; a += Math.abs(x); }
    const fsw = a > 0 && c / (3 * a) > 0.85;
    this.framer.push(fsw ? s : s * this.g);
    if (fsw) this.g = 26 / a;
  }
}

export class NxdnIdentity {
  onAudio: (pcm: Float32Array) => void = () => undefined;
  id: NxdnId = blank();
  private r48!: Rate; private r96!: Rate;
  constructor() { this.build(); }
  private build(): void {
    this.r48 = new Rate(2400); this.r96 = new Rate(4800);
    for (const r of [this.r48, this.r96]) r.framer.onTraffic = t => this.traffic(r, t);
  }
  reset(): void { this.id = blank(); this.build(); }
  get checked(): number { return this.id.checked; }
  /** The 2400/s symbols (outer levels near ±3): NXDN48. */
  pushSymbol24(s: number): void { this.r48.push(s); }
  /** The 4800/s symbols the channel already recovers: NXDN96. */
  pushSymbol48(s: number): void { this.r96.push(s); }

  private traffic(r: Rate, t: NxdnTraffic): void {
    const id = this.id;
    if (!r.framer.locked) return;
    if (id.baud !== r.baud) { if (id.baud && r.checked < 2) return; id.baud = r.baud; }
    r.checked++; id.checked++; id.lastSym = r.t * (4800 / r.baud);
    if (t.ran >= 0) id.ran = t.ran;
    id.kind = t.typeD ? 'Type-D' : t.rf === 2 ? 'conventional' : 'trunked';
    if (t.scch) {
      const x = t.scch; id.typeD = true;
      if (x.info === 3 && x.src !== undefined) { if (x.src !== id.src) this.start(r); id.src = x.src; }
      if ((x.info === 4 || x.info === 2) && x.kind === 'busy' && x.dst !== undefined) { id.dst = x.dst; id.group = !!x.group; }
      if (x.info === 1 && x.cipher !== undefined) { id.cipher = x.cipher; id.keyId = x.keyId ?? 0; }
    }
    for (const m of t.msgs) {
      if (m.type === 0x01 && m.dst !== undefined) {
        if (m.src !== id.src || id.activity !== 'voice') this.start(r);
        id.src = m.src ?? 0; id.dst = m.dst; id.group = !!m.group; id.callType = m.callType ?? -1; id.emergency = !!m.emergency;
        id.cipher = m.cipher ?? 0; id.keyId = m.keyId ?? 0; id.voiceOpt = m.voiceOpt ?? 0; id.typeD = !!m.typeD || t.typeD;
      } else if (m.type === 0x08 || m.type === 0x07 || m.type === 0x11) id.activity = '';
    }
    for (const d of t.data) {
      if (d.alias) { if (d.unit === id.src) id.alias = d.alias; continue; }
      id.dataUnit = d.unit; if (id.activity !== 'voice') id.activity = 'data';
      if (d.position) id.position = d.position;
      if (d.status !== undefined) id.status = d.status;
      if (d.message) id.text = d.message;
    }
    const halves = t.halves.filter((x): x is Uint8Array => !!x);
    if (!halves.length) return;
    if (id.activity !== 'voice') this.start(r);
    if (id.cipher) return;
    const efr = (id.voiceOpt & 7) === 3;
    for (const h of halves) {
      if (efr) { id.voiceFrames++; this.onAudio(r.imbe.decode(h)); }
      else for (const f of [h.subarray(0, 72), h.subarray(72)]) { id.voiceFrames++; this.onAudio(r.ambe.decode(f)); }
    }
  }
  private start(r: Rate): void { this.id.activity = 'voice'; this.id.calls++; this.id.alias = ''; r.ambe.reset(); r.imbe.reset(); }
}
