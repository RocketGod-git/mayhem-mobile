/**
 * One FM channel's identity: its discriminator goes through the mode detector, and the detector's 4800/s symbol
 * stream through the DMR, D-STAR and Fusion decoders at once (each rejects what is not its own by its checks). A
 * decoder whose checks pass names the mode before the sync count does. The snapshot says who is talking, through
 * which repeater, and where they are when they send it. No DOM.
 */
import { ModeDetector, type HamMode } from './mode.js';
import { DmrIdentity, type DmrSlotId } from './dmrid.js';
import { DStarReceiver, repeaterOf, type DStarId } from './dstar.js';
import { YsfReceiver, type YsfId } from './ysf.js';
import type { Position } from './gps.js';

export interface HamIdSnap {
  mode: HamMode;
  hits: Record<string, number>;
  /** DMR: the color code and both slots (a slot that has carried nothing has src 0). */
  dmr: { cc: number; slots: DmrSlotId[] } | null;
  dstar: DStarId | null;
  ysf: YsfId | null;
  /** The talking station: a callsign (D-STAR MY, Fusion source) or a DMR radio ID; '' when none is known. */
  station: string;
  /** The repeater the signal names: D-STAR RPT1 (with its module), the Fusion downlink callsign. */
  repeater: string;
  position: Position | null;
}

export class HamIdChannel {
  readonly mode: ModeDetector;
  readonly dmr = new DmrIdentity();
  readonly dstar = new DStarReceiver();
  readonly ysf = new YsfReceiver();
  constructor(readonly fs: number) {
    this.mode = new ModeDetector(fs);
    this.mode.onSymbol48 = s => { this.dmr.pushSymbol(s); this.dstar.pushSymbol(s); this.ysf.pushSymbol(s); };
  }
  reset(): void { this.mode.reset(); this.dmr.reset(); this.dstar.reset(); this.ysf.reset(); }
  /** Discriminator samples, radians per sample, at [fs]. */
  push(disc: ArrayLike<number>, n: number): void { this.mode.push(disc, n); }

  snapshot(): HamIdSnap {
    const r = this.mode.result();
    let mode: HamMode = r.mode;
    if (this.ysf.id.frames > 0) mode = 'YSF';
    else if (this.dstar.id.headers > 0 || this.dstar.id.frames >= 20) mode = 'D-STAR';
    else if (this.dmr.checked > 0) mode = 'DMR';
    const snap: HamIdSnap = { mode, hits: r.hits, dmr: null, dstar: null, ysf: null, station: '', repeater: '', position: null };
    if (mode === 'DMR') {
      const slots = this.dmr.slots.map(s => ({ ...s }));
      snap.dmr = { cc: this.dmr.cc, slots };
      const live = slots.filter(s => s.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      if (live) { snap.station = live.alias || String(live.src); snap.position = live.position; }
    } else if (mode === 'D-STAR') {
      const id = { ...this.dstar.id }; snap.dstar = id;
      if (id.header) {
        snap.station = id.header.my + (id.header.suffix ? '/' + id.header.suffix : '');
        const rp = repeaterOf(id.header.rpt1);
        if (rp.call && rp.call !== 'DIRECT') snap.repeater = rp.call + (rp.module ? ' ' + rp.module : '');
      }
      snap.position = id.position;
    } else if (mode === 'YSF') {
      const id = { ...this.ysf.id, rem: [...this.ysf.id.rem] as [string, string, string, string] }; snap.ysf = id;
      snap.station = id.src; snap.repeater = id.down; snap.position = id.position;
    }
    return snap;
  }
}
