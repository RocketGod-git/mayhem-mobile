/**
 * Who is on a P25 Phase 2 two-slot TDMA channel (TIA-102.BBAB physical layer, TIA-102.BBAC MAC layer), built on
 * Fleet's Phase 2 receiver (fleet/p2.ts: H-DQPSK at 6000 symbols a second, the S-ISCH pairs and the superframe, the
 * DUID, the scrambling, the MAC PDUs and their CRC and Reed-Solomon codes, the ESS). That receiver takes complex
 * samples and measures the phase step across each symbol; the discriminator is that phase step a sample at a time, so
 * its running sum is the carrier's phase, and a unit phasor at that phase is all the receiver needs. Per logical
 * channel (the two time slots):
 *
 *   · MAC_PTT (BBAC 8.2.1): the source unit, the talkgroup, the algorithm and key (0x80 is clear);
 *   · MAC_ACTIVE with GROUP VOICE CHANNEL USER (B1 B2 = 00, MCO 1): service options (emergency 0x80, protected 0x40),
 *     the talkgroup and the source; UNIT TO UNIT VOICE CHANNEL USER (MCO 2): the target and the source;
 *   · MAC_END_PTT (BBAC 8.2.2): the NAC; the call on that slot ends;
 *   · the ESS of each voice superframe: the algorithm and key;
 *   · the voice: four AMBE+2 half-rate frames in each 4V burst, two in each 2V, through the AMBE+2 decoder, unless
 *     encrypted.
 * Voice and most MAC PDUs are scrambled by a sequence seeded with the WACN, the system ID and the NAC (BBAC 7.2.5).
 * The receiver finds the seed among candidates: those set by the user ([setSeeds]) and any a NETWORK STATUS
 * BROADCAST (B1 B2 = 01, MCO 0x3B) carried in the clear names (its WACN, system ID and color code). Without the
 * seed, only clear MAC PDUs are read. No DOM.
 */
import { P2Rx, p2Messages, p2Ptt, p2EndPtt, type P2Seed } from '../fleet/p2.js';
import { AmbeStream } from './voice.js';

export interface P2Slot {
  /** Logical channel 0 or 1 (time slot 1 or 2). */
  lch: number; tg: number; src: number; group: boolean; emergency: boolean;
  encrypted: boolean; algId: number; keyId: number;
  /** 'voice' while a call is heard, '' idle; calls on this slot; AMBE+2 frames played. */
  activity: string; calls: number; voiceFrames: number; lastSym: number;
}
export interface P2Id {
  nac: number; wacn: number; sysId: number;
  /** The seed the voice descrambles with is known (and from where: 'set' or 'heard'). */
  seeded: string;
  slots: [P2Slot, P2Slot];
  /** S-ISCH pairs, MAC PDUs that passed their CRC. */
  pairs: number; macs: number;
}
/** Frames held while a call's encryption is unknown: one superframe of a logical channel. */
const HOLD = 18;
const blankSlot = (lch: number): P2Slot => ({ lch, tg: 0, src: 0, group: true, emergency: false, encrypted: false, algId: -1, keyId: 0, activity: '', calls: 0, voiceFrames: 0, lastSym: -1 });
const blank = (): P2Id => ({ nac: -1, wacn: -1, sysId: -1, seeded: '', slots: [blankSlot(0), blankSlot(1)], pairs: 0, macs: 0 });

/** NETWORK STATUS BROADCAST, abbreviated (11 octets): LRA, WACN (20 bits), system ID (12), channel (16), service class, color code (12). */
export function p2NetStatus(b: ArrayLike<number>): { wacn: number; sysId: number; nac: number } | null {
  if (b.length < 11) return null;
  return { wacn: (b[2] << 12) | (b[3] << 4) | (b[4] >> 4), sysId: ((b[4] & 15) << 8) | b[5], nac: ((b[9] & 15) << 8) | b[10] };
}

export class P25P2Identity {
  /** 160 samples at 8 kHz for each clear AMBE+2 frame, with its logical channel. */
  onAudio: (lch: number, pcm: Float32Array) => void = () => undefined;
  id: P2Id = blank();
  private rx: P2Rx;
  private readonly voice = [new AmbeStream(), new AmbeStream()];
  private user: P2Seed[] = []; private heard: P2Seed[] = [];
  private ph = 0; private re = new Float32Array(0); private im = new Float32Array(0);

  constructor(readonly fs: number) { this.rx = this.make(); }
  private make(): P2Rx {
    const rx = new P2Rx(this.fs);
    rx.onSync = paired => { if (paired) this.id.pairs++; };
    rx.onSeed = s => { this.id.seeded = s.sys; this.id.wacn = s.wacn; this.id.sysId = s.sysId; this.id.nac = s.nac; };
    rx.onVoice = (lch, f) => {
      const sl = this.id.slots[lch & 1];
      // the receiver fills a lost burst of a call with erasures: they never start one
      if (sl.activity !== 'voice') { if (!f.length) return; this.start(lch & 1); }
      sl.lastSym = rx.symbols;
      if (sl.encrypted) return;
      // until the ESS or a MAC PDU says the call is clear, its frames wait (a superframe at most, then they play)
      const held = this.held[lch & 1];
      if (sl.algId < 0) { held.push(f.slice()); if (held.length < HOLD) return; }
      this.play(lch & 1);
      if (sl.algId >= 0) this.frame(lch & 1, f);
    };
    rx.onEss = (lch, e) => { const sl = this.id.slots[lch & 1]; sl.algId = e.algId; sl.keyId = e.keyId; sl.encrypted = e.algId !== 0x80 && e.algId !== 0; this.settle(lch & 1); };
    rx.onMac = m => {
      const id = this.id, sl = id.slots[m.lch & 1]; id.macs++; sl.lastSym = rx.symbols;
      if (m.opcode === 1) {
        const p = p2Ptt(m.bytes);
        if (sl.activity !== 'voice') this.start(m.lch & 1);
        sl.src = p.src; sl.tg = p.group; sl.group = true; sl.algId = p.algId; sl.keyId = p.keyId; sl.encrypted = p.algId !== 0x80 && p.algId !== 0;
        this.settle(m.lch & 1);
      } else if (m.opcode === 2) {
        const e = p2EndPtt(m.bytes);
        id.nac = e.nac; sl.activity = ''; this.held[m.lch & 1] = [];
        if (e.src && e.src !== 0xffffff) sl.src = e.src;
      } else for (const x of p2Messages(m.bytes)) {
        const b = x.bytes;
        if (x.b === 0 && (x.mco === 1 || x.mco === 2) && m.opcode === 4) {
          const so = b[1];
          sl.emergency = (so & 0x80) !== 0; if (so & 0x40) { sl.encrypted = true; this.settle(m.lch & 1); }
          if (x.mco === 1 && b.length >= 7) { sl.group = true; sl.tg = (b[2] << 8) | b[3]; sl.src = (b[4] << 16) | (b[5] << 8) | b[6]; }
          if (x.mco === 2 && b.length >= 8) { sl.group = false; sl.tg = (b[2] << 16) | (b[3] << 8) | b[4]; sl.src = (b[5] << 16) | (b[6] << 8) | b[7]; }
        } else if (x.b === 1 && x.mco === 0x3b) {
          const n = p2NetStatus(b);
          if (n && !this.heard.some(s => s.wacn === n.wacn && s.sysId === n.sysId && s.nac === n.nac)) {
            this.heard.push({ ...n, sys: 'heard' });
            if (id.wacn < 0) { id.wacn = n.wacn; id.sysId = n.sysId; id.nac = n.nac; }
            this.rx.setSeeds([...this.user, ...this.heard]);
          }
        }
      }
    };
    rx.setSeeds([...this.user, ...this.heard]);
    return rx;
  }
  private readonly held: Uint8Array[][] = [[], []];
  /** A call starts on a slot: what the last one was is cleared. */
  private start(lch: number): void { const sl = this.id.slots[lch]; sl.activity = 'voice'; sl.calls++; sl.algId = -1; sl.keyId = 0; sl.encrypted = false; sl.emergency = false; this.voice[lch].reset(); this.held[lch] = []; }
  private frame(lch: number, f: Uint8Array): void { const sl = this.id.slots[lch]; if (f.length) sl.voiceFrames++; this.onAudio(lch, this.voice[lch].decode(f)); }
  /** Held frames play (the call is clear, or no word came in time) or go (it is encrypted). */
  private play(lch: number): void { const h = this.held[lch]; this.held[lch] = []; if (!this.id.slots[lch].encrypted) for (const f of h) this.frame(lch, f); }
  private settle(lch: number): void { if (this.id.slots[lch].encrypted) this.held[lch] = []; else this.play(lch); }
  /** Seeds the user knows for this channel (WACN, system ID, NAC), tried before any heard. */
  setSeeds(seeds: { wacn: number; sysId: number; nac: number }[]): void { this.user = seeds.map(s => ({ ...s, sys: 'set' })); this.rx.setSeeds([...this.user, ...this.heard]); }
  reset(): void { this.id = blank(); this.heard = []; this.rx = this.make(); this.voice.forEach(v => v.reset()); this.ph = 0; this.held[0] = []; this.held[1] = []; }
  /** Bursts read: the mode is named by these (MAC PDUs that passed their CRC, voice once the seed is known). */
  get checked(): number { return this.id.macs + (this.id.seeded ? 1 : 0); }

  /** Discriminator samples (radians per sample). */
  push(disc: ArrayLike<number>, n: number): void {
    if (this.re.length < n) { this.re = new Float32Array(n); this.im = new Float32Array(n); }
    let ph = this.ph;
    for (let k = 0; k < n; k++) { ph += disc[k]; if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI; this.re[k] = Math.cos(ph); this.im[k] = Math.sin(ph); }
    this.ph = ph;
    this.rx.push(this.re, this.im, n);
  }
}
