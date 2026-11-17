/**
 * Burst decoding on Web Workers of their own: the DSP worker captures a burst and hands it to a free pool worker,
 * which runs the receiver and the FEC and sends back the TS packets. Each burst is independent, so as many bursts
 * decode at once as there are workers.
 */
import { decodeBurst, type BurstOut } from './burst.js';
import type { BurstState } from './vsb.js';

export const ATSC_POOL_NAME = 'atsc-pool';

export class AtscPool {
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private readonly waiting = new Map<number, (r: { out: BurstOut; st: BurstState } | null) => void>();
  private seq = 0;
  failed = false;
  constructor(url: string | URL, count: number) {
    for (let k = 0; k < count; k++) {
      const w = new Worker(url, { type: 'module', name: ATSC_POOL_NAME });
      w.onerror = () => { this.failed = true; };
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type !== 'atscBurst') return;
        this.busy[k] = false;
        const cb = this.waiting.get(m.id); this.waiting.delete(m.id);
        cb?.(m.out ? { out: m.out as BurstOut, st: m.st as BurstState } : null);
      };
      this.workers.push(w); this.busy.push(false);
    }
  }
  get size(): number { return this.workers.length; }
  get free(): number { return this.busy.filter(b => !b).length; }
  /** Decodes a burst on a free worker (the samples are handed over, not copied). */
  run(iq: Int8Array, rate: number, st: BurstState): Promise<{ out: BurstOut; st: BurstState } | null> | null {
    const k = this.busy.indexOf(false);
    if (k < 0) return null;
    this.busy[k] = true;
    const id = ++this.seq;
    return new Promise(res => { this.waiting.set(id, res); this.workers[k].postMessage({ id, iq, rate, st }, [iq.buffer]); });
  }
  close(): void { for (const w of this.workers) w.terminate(); }
}

/** A pool worker: decodes each burst it is given. */
export function startAtscPoolWorker(): void {
  const post = (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage.bind(self);
  self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    try {
      const st = m.st as BurstState, out = decodeBurst(m.iq as Int8Array, m.rate as number, st);
      post({ type: 'atscBurst', id: m.id, out, st }, [out.ts.buffer]);
    } catch (err) {
      post({ type: 'atscBurst', id: m.id, out: null, error: (err as Error).message });
    }
  };
}
