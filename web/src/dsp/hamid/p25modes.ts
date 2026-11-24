/**
 * The identity decoders for P25 Phase 1, P25 Phase 2, NXDN (48 and 96) and dPMR on one FM channel, behind one face
 * for HamIdChannel: the channel's 4800/s symbols go to P25 Phase 1 and NXDN96, this module's own 2400/s symbols (root
 * raised cosine, roll-off 0.2, as NXDN and dPMR specify) to NXDN48 and dPMR, the discriminator itself to Phase 2. The
 * mode named is the one whose checks passed last. No DOM.
 */
import { DiscSymbols } from './symbols.js';
import { P25Identity, type P25Id } from './p25id.js';
import { P25P2Identity, type P2Id } from './p25p2id.js';
import { NxdnIdentity, type NxdnId } from './nxdnid.js';
import { DpmrIdentity, type DpmrId } from './dpmr.js';
import type { Position } from './gps.js';

export type P25ModeName = 'P25' | 'P25P2' | 'NXDN' | 'dPMR';
export interface P25ModesSnap {
  mode: P25ModeName | '';
  p25: P25Id | null; p25p2: P2Id | null; nxdn: NxdnId | null; dpmr: DpmrId | null;
  station: string; repeater: string; position: Position | null;
}

export class P25Modes {
  /** Clear voice, 160 samples at 8 kHz a frame: the mode and the slot (Phase 2's logical channel, else 0). */
  onAudio: (mode: P25ModeName, slot: number, pcm: Float32Array) => void = () => undefined;
  readonly p25 = new P25Identity();
  readonly p25p2: P25P2Identity;
  readonly nxdn = new NxdnIdentity();
  readonly dpmr = new DpmrIdentity();
  private readonly s24: DiscSymbols;
  private samples = 0;
  /** The sample count when each mode's checks last moved, and the counts then. */
  private readonly last = new Map<P25ModeName, { at: number; n: number }>();

  constructor(readonly fs: number) {
    this.p25p2 = new P25P2Identity(fs);
    this.s24 = new DiscSymbols(fs, 2400);
    this.s24.onSymbol = s => { this.nxdn.pushSymbol24(s); this.dpmr.pushSymbol(s); };
    this.p25.onAudio = pcm => this.onAudio('P25', 0, pcm);
    this.p25p2.onAudio = (lch, pcm) => this.onAudio('P25P2', lch, pcm);
    this.nxdn.onAudio = pcm => this.onAudio('NXDN', 0, pcm);
    this.dpmr.onAudio = pcm => this.onAudio('dPMR', 0, pcm);
  }
  reset(): void { this.p25.reset(); this.p25p2.reset(); this.nxdn.reset(); this.dpmr.reset(); this.s24.reset(); this.samples = 0; this.last.clear(); }
  /** The channel's 4800/s symbols. */
  pushSymbol48(s: number): void { this.p25.pushSymbol(s); this.nxdn.pushSymbol48(s); }
  /** Discriminator samples, radians per sample. */
  push(disc: ArrayLike<number>, n: number): void {
    this.s24.push(disc, n); this.p25p2.push(disc, n); this.samples += n;
    const mark = (m: P25ModeName, c: number) => { const l = this.last.get(m); if (c > 0 && (!l || l.n !== c)) this.last.set(m, { at: this.samples, n: c }); };
    mark('P25', this.p25.checked); mark('P25P2', this.p25p2.checked); mark('NXDN', this.nxdn.checked); mark('dPMR', this.dpmr.checked);
  }
  /** The mode whose checks passed last, or '' when none has. */
  get mode(): P25ModeName | '' { let best: P25ModeName | '' = '', at = -1; for (const [m, l] of this.last) if (l.at > at) { at = l.at; best = m; } return best; }

  snapshot(): P25ModesSnap {
    const mode = this.mode;
    const s: P25ModesSnap = { mode, p25: null, p25p2: null, nxdn: null, dpmr: null, station: '', repeater: '', position: null };
    if (mode === 'P25') { const id = { ...this.p25.id }; s.p25 = id; if (id.src) s.station = String(id.src); }
    else if (mode === 'P25P2') {
      const id = { ...this.p25p2.id, slots: this.p25p2.id.slots.map(x => ({ ...x })) as P2Id['slots'] }; s.p25p2 = id;
      const live = id.slots.filter(x => x.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      if (live) s.station = String(live.src);
    } else if (mode === 'NXDN') { const id = { ...this.nxdn.id }; s.nxdn = id; if (id.src) s.station = id.typeD ? `${id.src >> 11}-${id.src & 0x7ff}` : String(id.src); }
    else if (mode === 'dPMR') { const id = { ...this.dpmr.id }; s.dpmr = id; s.station = id.ownText; s.position = id.position; }
    return s;
  }
}
