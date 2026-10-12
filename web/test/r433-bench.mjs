/**
 * How much of a processor the sensors receiver costs.
 *
 * Two figures matter and they scale differently. The baseband stage runs on every sample whether anything is
 * transmitting or not, so its cost is fixed by the sample rate. The decoding runs once per burst against every
 * protocol at once, so its cost grows with how busy the band is and with how many protocols are ported — which
 * is the number worth watching as this port fills out.
 *
 * Run with `npm run bench` after `npm run build`. On a phone expect four to six times these numbers.
 */
import { PulseDetect } from '../dist/dsp/r433/detect.js';
import { R433 } from '../dist/dsp/r433/runner.js';
import { Baseband } from '../dist/dsp/r433/baseband.js';
import '../dist/dsp/r433/devices/index.js';

const rate = 2_000_000;
const n = rate;                                      // one second
const iq = new Int8Array(n * 2);

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 20;
for (let i = 0; i < n * 2; i++) iq[i] = (rnd() & 7) - 4;        // a noise floor to work against

// A keyed burst in the middle of the second, so the detector has something real to find.
for (let k = 0; k < 200; k++) {
  const on = (k & 1) === 0;
  for (let s = 0; s < 800; s++) {
    const i = 400_000 + k * 800 + s;
    iq[2 * i] = on ? 100 : (rnd() & 7) - 4;
    iq[2 * i + 1] = on ? 40 : (rnd() & 7) - 4;
  }
}

const bb = new Baseband();
// Listen across the same quarter-megahertz the app defaults to, so the figures below are the ones that
// actually apply rather than the worst case.
const SPAN = 250_000;
while (rate / (bb.decim * 2) >= SPAN) bb.decim *= 2;
const det = new PulseDetect(Math.round(rate / bb.decim));
const radio = new R433();
const CHUNK = 65536 * 2;
const REPS = 3;

let t0 = performance.now();
for (let rep = 0; rep < REPS; rep++) {
  det.reset(); bb.reset();
  for (let off = 0; off < iq.length; off += CHUNK) {
    const { env, fm, n: cnt } = bb.process(iq.subarray(off, Math.min(off + CHUNK, iq.length)));
    det.process(env, fm, cnt, (kind, p) => { radio.run(kind, p); });
  }
}
const wholeMs = (performance.now() - t0) / REPS;

t0 = performance.now();
for (let rep = 0; rep < REPS; rep++) {
  bb.reset();
  for (let off = 0; off < iq.length; off += CHUNK) bb.process(iq.subarray(off, Math.min(off + CHUNK, iq.length)));
}
const basebandMs = (performance.now() - t0) / REPS;

// Capture the bursts once, then run them through every protocol enough times to time it.
const bursts = [];
det.reset(); bb.reset();
for (let off = 0; off < iq.length; off += CHUNK) {
  const { env, fm, n: cnt } = bb.process(iq.subarray(off, Math.min(off + CHUNK, iq.length)));
  det.process(env, fm, cnt, (kind, p) => bursts.push({
    kind,
    p: { pulse: p.pulse.slice(), gap: p.gap.slice(), numPulses: p.numPulses, sampleRate: p.sampleRate, fsk: p.fsk },
  }));
}
const BURST_REPS = 300;
t0 = performance.now();
for (let i = 0; i < BURST_REPS; i++) for (const b of bursts) radio.run(b.kind, b.p);
const perBurst = (performance.now() - t0) / (BURST_REPS * bursts.length);

console.log(`protocols running: ${radio.devices.length}`);
console.log(`one second of 2 Msps: ${wholeMs.toFixed(1)} ms — ${(wholeMs / 10).toFixed(1)}% of real time`);
console.log(`  of which baseband: ${basebandMs.toFixed(1)} ms (fixed, whatever is on the air)`);
console.log(`one burst through every protocol: ${perBurst.toFixed(2)} ms (${bursts[0].p.numPulses} pulses)`);
console.log(`  a band busy enough for fifty bursts a second would add ${(perBurst * 50).toFixed(0)} ms`);
