/**
 * Who is on a P25 Phase 1 channel (TIA-102.BAAA common air interface, TIA-102.AABF link control), built on the HAM
 * decoder's P25 framer (ham/p25.ts: the Network ID's BCH code, the LDU link control's Hamming and Reed-Solomon codes,
 * the encryption sync, the header). Fed the 4800/s symbols (outer levels near ±3); the 24-symbol frame sync is found in
 * either polarity and the framer takes the dibits from there:
 *
 *   · the NAC from every Network ID;
 *   · the link control of each LDU1: its format, the manufacturer, the service options (emergency, protected), the
 *     talkgroup and the source unit (group voice, LCF 0), or the target and the source (unit to unit, LCF 3), and the
 *     nine octets as received;
 *   · encryption: the protect bit of the link control, and the algorithm and key of the header or of an LDU2's
 *     encryption sync (algorithm 0x80 is clear);
 *   · the voice: the nine IMBE frames of each LDU, through the IMBE decoder, unless the call is encrypted.
 *
 * Positions: the Phase 1 voice channel carries none in its link control; packet data (and with it LRRP and NMEA) is
 * not read here. No DOM.
 */
import { P25Decoder } from '../ham/p25.js';
import { SYNCS } from '../ham/dmr.js';
import { ImbeStream } from './voice.js';

export interface P25Id {
  nac: number; tg: number; src: number; group: boolean; emergency: boolean;
  /** Encrypted: the link control's protect bit, or a header or LDU2 naming an algorithm other than 0x80. */
  encrypted: boolean; algId: number; keyId: number;
  /** The last link control: format, manufacturer, and its nine octets in hex. */
  lcf: number; mfid: number; lc: string;
  /** Frames read (Network ID passed), link controls read, IMBE frames played, calls (headers or a new talker). */
  frames: number; lcs: number; voiceFrames: number; calls: number;
  inverted: boolean; lastSym: number;
}
const blank = (): P25Id => ({ nac: -1, tg: 0, src: 0, group: true, emergency: false, encrypted: false, algId: -1, keyId: 0, lcf: -1, mfid: 0, lc: '', frames: 0, lcs: 0, voiceFrames: 0, calls: 0, inverted: false, lastSym: -1 });
const P25_SYNC = SYNCS.find(s => s.proto === 'P25' && s.src === '')!.s;
const hex = (b: ArrayLike<number>) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

export class P25Identity {
  /** 160 samples at 8 kHz for each clear IMBE frame. */
  onAudio: (pcm: Float32Array) => void = () => undefined;
  id: P25Id = blank();
  private readonly dec = new P25Decoder();
  private readonly voice = new ImbeStream();
  private readonly ring = new Float32Array(24); private rp = 0;
  private t = 0; /** Polarity times the level correction of the last sync. */ private sign = 1; private framesSeen = 0; private open = false;

  constructor() {
    this.dec.onVoice = bits => {
      if (this.id.encrypted) return;
      this.id.voiceFrames++;
      this.onAudio(this.voice.decode(bits));
    };
    this.dec.onLc = lc => this.lc(lc);
    this.dec.onHdu = h => {
      const id = this.id; this.open = false; this.start(); id.src = 0; id.algId = h.algId; id.keyId = h.keyId; id.mfid = h.mfid;
      if (h.tg) id.tg = h.tg;
      id.encrypted = h.algId !== 0x80 && h.algId !== 0; id.lastSym = this.t;
      this.voice.reset();
    };
    this.dec.onEs = es => { const id = this.id; id.algId = es.algId; id.keyId = es.keyId; id.encrypted = es.algId !== 0x80 && es.algId !== 0; };
  }
  reset(): void { this.id = blank(); this.dec.reset(); this.voice.reset(); this.ring.fill(0); this.rp = 0; this.t = 0; this.sign = 1; this.framesSeen = 0; this.open = false; }
  /** A new call: what the last one was is cleared. */
  private start(): void { if (!this.open) { this.open = true; const id = this.id; id.calls++; id.encrypted = false; id.algId = -1; id.keyId = 0; id.emergency = false; } }
  /** Frames whose Network ID passed: the mode is named by these. */
  get checked(): number { return this.id.frames; }

  pushSymbol(s: number): void {
    this.t++;
    this.ring[this.rp] = s; this.rp = (this.rp + 1) % 24;
    // the sync (all outer symbols) also sets the level the dibits are sliced at, the symbol recovery's own estimate being
    // slow to settle at the start of a transmission; it is looked for even while a frame is being read: the framer steps over the next frame's sync on its own
    // count, and a sync seen puts it right where that count has slipped
    let c = 0, a = 0;
    for (let k = 0; k < 24; k++) { const x = this.ring[(this.rp + k) % 24]; c += x * P25_SYNC[k]; a += Math.abs(x); }
    if (a > 24 * 1.8 && Math.abs(c) / a > 0.86) { this.sign = (c > 0 ? 1 : -1) * 3 * 24 / a; this.dec.sync(this.t); return; }
    if (!this.dec.status(this.t).locked) return;
    const x = s * this.sign;
    this.dec.push(x > 2 ? 1 : x > 0 ? 0 : x > -2 ? 2 : 3, this.t);
    const now = this.dec.status(this.t);
    if (now.frames !== this.framesSeen) {
      this.framesSeen = now.frames;
      const id = this.id; id.frames = now.frames; id.nac = now.nac; id.inverted = this.sign < 0; id.lastSym = this.t;
      // a terminator ends the call (what it was stays shown until the next one starts)
      if (now.duid === 0x3 || now.duid === 0xf) { this.voice.reset(); this.open = false; }
    }
  }

  private lc(b: Uint8Array): void {
    const id = this.id, lcf = b[0] & 0x3f, svc = b[2];
    if (lcf === 0x00 || lcf === 0x03) {
      const src = (b[6] << 16) | (b[7] << 8) | b[8];
      if (id.src && src !== id.src) this.open = false;
      this.start();
    }
    id.lcs++; id.lcf = lcf; id.mfid = b[1]; id.lc = hex(b); id.lastSym = this.t;
    if ((b[0] & 0x80) !== 0) id.encrypted = true;
    // the service options of a standard voice LC (format 0 and 3): emergency 0x80, protected 0x40
    if (lcf === 0x00 || lcf === 0x03) {
      id.emergency = (svc & 0x80) !== 0;
      if (svc & 0x40) id.encrypted = true;
      const src = (b[6] << 16) | (b[7] << 8) | b[8];
      const tg = lcf === 0 ? (b[4] << 8) | b[5] : (b[3] << 16) | (b[4] << 8) | b[5];
      id.src = src; id.tg = tg; id.group = lcf === 0;
    }
  }
}
