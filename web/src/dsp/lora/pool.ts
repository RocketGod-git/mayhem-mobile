/**
 * The LoRa standing channels on Web Workers of their own (see StandingPool in scanner.ts). Each worker gets a copy
 * of every raw buffer and a share of the channels, round robin; what they hear comes back here. At 20 Msps one
 * standing channel takes about 40 % of a core, and a US span holds nine of them, so the DSP worker alone could
 * never keep up with them inline.
 */
import type { LoraFrame } from './phy.js';
import { ChannelRunner, type StandingPool, type StandingSpec } from './scanner.js';

/** The worker name the pool's workers are started with: the DSP worker's own script, run as a pool worker. */
export const POOL_WORKER_NAME = 'lora-pool';

export class WorkerPool implements StandingPool {
  onHeard: ((id: number, f: LoraFrame, hz: number, inv: boolean, at: number) => void) | null = null;
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly where = new Map<number, number>();
  private readonly busyOf: number[] = [];
  private rate = 0;

  /** Set when a worker could not start (the standing channels then go back inline). */
  failed = false;

  /** `url`: the DSP worker's own script; started under POOL_WORKER_NAME it runs startPoolWorker instead. */
  constructor(url: string | URL, count: number) {
    for (let k = 0; k < count; k++) {
      const w = new Worker(url, { type: 'module', name: POOL_WORKER_NAME });
      w.onerror = () => { this.failed = true; };
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'heard') this.onHeard?.(m.id, m.frame as LoraFrame, m.hz, m.inv, m.at);
        else if (m.type === 'busy') this.busyOf[k] = m.busy;
      };
      this.workers.push(w); this.load.push(0); this.busyOf.push(0);
    }
  }

  get busy(): number { return Math.max(0, ...this.busyOf); }
  get size(): number { return this.workers.length; }

  feed(iq: Int8Array, start: number): void {
    if (this.where.size === 0) return;
    // only the workers with channels need the samples (each gets its own copy)
    for (let k = 0; k < this.workers.length; k++) if (this.load[k] > 0) this.workers[k].postMessage({ type: 'iq', iq, start, rate: this.rate });
  }

  add(spec: StandingSpec): void {
    this.rate = spec.rate;
    let k = 0;
    for (let j = 1; j < this.load.length; j++) if (this.load[j] < this.load[k]) k = j;
    this.load[k]++; this.where.set(spec.id, k);
    this.workers[k].postMessage({ type: 'add', spec });
  }

  drop(ids: number[]): void {
    const per = new Map<number, number[]>();
    for (const id of ids) { const k = this.where.get(id); if (k === undefined) continue; this.where.delete(id); this.load[k]--; per.set(k, [...(per.get(k) ?? []), id]); }
    for (const [k, list] of per) this.workers[k].postMessage({ type: 'drop', ids: list });
  }

  reset(): void {
    this.where.clear(); this.load.fill(0); this.busyOf.fill(0);
    for (const w of this.workers) w.postMessage({ type: 'reset' });
  }

  close(): void { for (const w of this.workers) w.terminate(); }
}

/** A pool worker: a share of the standing channels, run on its own copy of the raw samples (ChannelRunner). */
export function startPoolWorker(): void {
  const post = (self as unknown as { postMessage: (m: unknown) => void }).postMessage.bind(self);
  const runner = new ChannelRunner();
  runner.onHeard = (id, frame, hz, inv, at) => post({ type: 'heard', id, frame, hz, inv, at });
  let lastBusy = 0;
  self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    switch (m.type) {
      case 'iq': {
        runner.feed(m.iq as Int8Array, m.start as number, m.rate as number);
        const t = performance.now();
        if (t - lastBusy > 500) { lastBusy = t; post({ type: 'busy', busy: runner.busy }); }
        break;
      }
      case 'add': runner.add(m.spec as StandingSpec); break;
      case 'drop': runner.drop(m.ids as number[]); break;
      case 'reset': runner.reset(); break;
    }
  };
}
