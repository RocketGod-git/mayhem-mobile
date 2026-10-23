import { fft, hann, loadIqAt, accumulatePower, powerDbFrom } from '../fft.js';
export const SWEEP_BINS = 512;
const KEEP0 = 52, KEEP1 = 460;
export const SWEEP_KEEP = KEEP1 - KEEP0;
const SETTLE_MS = 130;
const INFLIGHT_STALE = 9;
export class SweepProcessor {
    constructor(startHz, endHz, sliceHz, emit) {
        this.startHz = startHz;
        this.endHz = endHz;
        this.sliceHz = sliceHz;
        this.emit = emit;
        this.re = new Float32Array(1024);
        this.im = new Float32Array(1024);
        this.acc = new Float32Array(1024);
        this.win = hann(1024);
        this.slice = new Float32Array(SWEEP_BINS);
        this.step = 0;
        this.settle = 0;
        this.awaitingTune = false;
        this.sweeps = 0;
        this.stepHz = sliceHz * SWEEP_KEEP / SWEEP_BINS;
        this.binHz = sliceHz / SWEEP_BINS;
        this.steps = Math.max(1, Math.ceil((endHz - startHz) / this.stepHz));
        this.work = new Float32Array(this.steps * SWEEP_KEEP);
    }
    centerOf(i) { return this.startHz + this.stepHz / 2 + i * this.stepHz; }
    freqOfBin(idx) { return this.startHz + idx * this.binHz; }
    reset() { this.step = 0; this.settle = 8; this.awaitingTune = true; this.emit({ type: 'tune', hz: this.centerOf(0) }); }
    tuned() { if (!this.awaitingTune)
        return; this.awaitingTune = false; this.settle = Math.min(this.settle, INFLIGHT_STALE); }
    onIq(iq, rate) {
        if (this.settle > 0) {
            this.settle--;
            return;
        }
        const nSamp = iq.length >> 1;
        this.acc.fill(0);
        let frames = 0;
        for (let off = 0; off + 1024 <= nSamp; off += 1024) {
            loadIqAt(iq, off, this.re, this.im, this.win);
            fft(this.re, this.im);
            accumulatePower(this.re, this.im, this.acc);
            frames++;
        }
        if (frames === 0)
            return;
        powerDbFrom(this.acc, frames, this.slice);
        const c = SWEEP_BINS / 2;
        this.slice[c] = (this.slice[c - 2] + this.slice[c + 2]) * 0.5;
        this.slice[c - 1] = this.slice[c - 2];
        this.slice[c + 1] = this.slice[c + 2];
        this.work.set(this.slice.subarray(KEEP0, KEEP1), this.step * SWEEP_KEEP);
        const live = this.slice.slice(KEEP0, KEEP1);
        this.emit({ type: 'sweepLive', slice: live, step: this.step, steps: this.steps }, [live.buffer]);
        this.step++;
        if (this.step >= this.steps) {
            this.step = 0;
            this.sweeps++;
            const row = this.work.slice();
            this.emit({ type: 'sweep', row, steps: this.steps, sweeps: this.sweeps, startHz: this.startHz, endHz: this.startHz + this.steps * this.stepHz, binHz: this.binHz, progress: 0 }, [row.buffer]);
        }
        else
            this.emit({ type: 'sweepProgress', progress: this.step, steps: this.steps, sweeps: this.sweeps });
        this.emit({ type: 'tune', hz: this.centerOf(this.step) });
        const bufMs = nSamp * 1000 / rate;
        this.settle = Math.min(500, Math.max(2, Math.ceil(SETTLE_MS / bufMs)));
        this.awaitingTune = true;
    }
}
