/**
 * Pager SINGLE: the tuned channel's discriminator into FLEX (with ReFLEX, the same family of frame) and POCSAG side
 * by side by default (what PDW does), or just one of them. Each ReFLEX frame goes on the packet list as a line.
 */
import type { Emit, IqProcessor } from './core.js';
import { FlexDecoder } from './flex.js';
import { PocsagDecoder } from './pocsag.js';
import { ReflexDecoder } from './reflex.js';

export type PagerWhich = 'flex' | 'pocsag' | 'both';

export class PagerSingle implements IqProcessor {
  readonly wantsFm = true;
  which: PagerWhich = 'both';
  private readonly flex: FlexDecoder; private readonly pocsag: PocsagDecoder; private readonly reflex: ReflexDecoder;
  constructor(emit: Emit) {
    this.flex = new FlexDecoder(emit); this.pocsag = new PocsagDecoder(emit);
    this.reflex = new ReflexDecoder((m) => { if (m.type === 'reflex') emit({ type: 'packet', line: m.line }); else emit(m); });
  }
  select(w: PagerWhich): void { this.which = w; this.reset(); }
  reset(): void { this.pocsag.reset(); this.flex.reset(); this.reflex.reset(); }
  onIq(): void {}
  onFm(sm: Float32Array, n: number, r: number): void {
    if (this.which !== 'pocsag') { this.flex.onFm(sm, n, r); this.reflex.onFm(sm, n, r); }
    if (this.which !== 'flex') this.pocsag.onFm(sm, n, r);
  }
}
