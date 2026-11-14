/**
 * Tesla charge port opener: a synthetic press built from the published bit sequence, checked twice.
 *
 * First at the pulse level, with mark widening and timing jitter like a cheap OOK receiver gives, against the
 * slicer and decoder alone. Then end to end: the same press keyed onto a carrier 150 kHz off the dial in noisy
 * IQ, through the Devices front end, which must find it, tune to it and report one Tesla charge port card.
 */
import { R433 } from '../dist/dsp/r433/runner.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';
import { R433Processor } from '../dist/dsp/r433/processor.js';

let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; console.log('FAIL', what); } };

// fredilarsen/TeslaChargeDoorOpener: 43 bytes sent MSB first, one bit per 400 us, five times 23 ms apart
const SEQ = [0x02, 0xAA, 0xAA, 0xAA, 0x2B, 0x2C, 0xCB, 0x33, 0x33, 0x2D, 0x34, 0xB5, 0x2B, 0x4D, 0x32, 0xAD, 0x2C,
  0x56, 0x59, 0x96, 0x66, 0x66, 0x5A, 0x69, 0x6A, 0x56, 0x9A, 0x65, 0x5A, 0x58, 0xAC, 0xB3, 0x2C, 0xCC, 0xCC, 0xB4,
  0xD2, 0xD4, 0xAD, 0x34, 0xCA, 0xB4, 0xA0];
const BIT_US = 400;

/** One message as [on, us] runs, leading zeros dropped; the trailing silence is the 23 ms to the next one. */
function message(seq = SEQ) {
  const bits = seq.flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (b >> i) & 1));
  const runs = [];
  for (const b of bits.slice(bits.indexOf(1))) {
    if (runs.length && runs[runs.length - 1][0] === b) runs[runs.length - 1][1] += BIT_US;
    else runs.push([b, BIT_US]);
  }
  if (runs[runs.length - 1][0] === 0) runs.pop();
  runs.push([0, 23000]);
  return runs;
}

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };

/** Runs to PulseData at `rate`, marks widened by `widen` us and every edge jittered by up to `jitter` us. */
function pulses(runs, rate, widen = 0, jitter = 0) {
  const pulse = [], gap = [];
  for (let i = 0; i < runs.length; i += 2) {
    const j = () => (rnd() * 2 - 1) * jitter;
    pulse.push(Math.round((runs[i][1] + widen + j()) * rate / 1e6));
    gap.push(Math.round((runs[i + 1][1] - widen + j()) * rate / 1e6));
  }
  return { pulse: Int32Array.from(pulse), gap: Int32Array.from(gap), numPulses: pulse.length, sampleRate: rate, fsk: false };
}

const tesla = REGISTRY.find(d => d.num === 1001);
check(!!tesla && tesla.name === 'Tesla charge port opener', 'registered as protocol 1001');
check(tesla?.bands.includes(315000000) && tesla?.bands.includes(433920000), 'listed for 315 and 433.92 MHz');

// ---- pulse level ----
for (const [widen, jitter] of [[0, 0], [60, 40], [-60, 40]]) {
  const got = new R433([tesla]).run(1, pulses(message(), 250_000, widen, jitter));
  check(got.length === 1 && got[0].data.model === 'Tesla-ChargePort' && got[0].data.frames === 3,
    `one message decodes, all three frames (widen ${widen}, jitter ${jitter}): ${JSON.stringify(got.map(r => r.data))}`);
}
// a single flipped half bit in every frame must not pass
{
  const bad = SEQ.slice(); bad[10] ^= 0x10; bad[22] ^= 0x10; bad[36] ^= 0x10;
  check(new R433([tesla]).run(1, pulses(message(bad), 250_000)).length === 0, 'a corrupted code is not claimed');
}
// nothing else in the registry claims it as its own
{
  const others = new R433(REGISTRY.filter(d => d !== tesla)).run(1, pulses(message(), 250_000)).filter(r => !r.dev.disabled);
  check(others.length === 0, `no other protocol claims it (${others.map(r => r.data.model).join(', ')})`);
}

// ---- end to end: raw IQ through the Devices front end ----
{
  const rate = 2_000_000, offset = 150_000, out = [];
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const push = (i, q) => out.push(Math.max(-128, Math.min(127, Math.round(i + gauss() * 5))), Math.max(-128, Math.min(127, Math.round(q + gauss() * 5))));
  let phase = 0;
  const key = (on, us) => {
    for (let k = 0; k < Math.round(us * rate / 1e6); k++) {
      phase += 2 * Math.PI * offset / rate;
      if (on) push(40 * Math.cos(phase), 40 * Math.sin(phase)); else push(0, 0);
    }
  };
  key(0, 100_000);
  for (let rep = 0; rep < 5; rep++) for (const [on, us] of message()) key(on, us);
  key(0, 200_000);

  const readings = [];
  const p = new R433Processor(m => { if (m.type === 'r433') readings.push(m); });
  p.reset(rate);
  const iq = Int8Array.from(out);
  for (let i = 0; i < iq.length; i += 262144) p.onIq(iq.subarray(i, Math.min(iq.length, i + 262144)), rate);

  const cards = new Set(readings.map(r => r.key));
  const t = readings.filter(r => r.model === 'Tesla-ChargePort');
  check(t.length > 0, `heard end to end (got ${readings.map(r => `${r.model}@${r.offsetHz}`).join(', ') || 'nothing'})`);
  check(t.every(r => r.num === 1001 && r.what === 'Tesla charge port opener' && r.family === 'sensor'), 'shown as a Tesla charge port opener card');
  check(t.every(r => Math.abs(r.offsetHz - offset) < 20_000), `found 150 kHz off the dial (${t.map(r => r.offsetHz).join(', ')})`);
  check(cards.size === 1, `one card, nothing else reported (${[...cards].join(', ')})`);
}

console.log(`tesla: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
