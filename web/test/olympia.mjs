/** Olympia Protect 9571 (rtl_433 386): frames built from the documented layout, sliced from FSK pulses. */
import { R433 } from '../dist/dsp/r433/runner.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const eq = (a, b, what) => { if (a === b) pass++; else { fail++; console.log(`FAIL ${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } };

/** id 24 bits, battery inserted, weak, class, type, state; checksum filled in unless `bad`. */
function frame(id, weak, cls, type, state, bad = false) {
  const b = [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff, 0x80 | 0x08 | 0x06, (weak << 7) | (cls << 4) | (type << 1) | state];
  b.push(((b.reduce((s, v) => s + v, 0)) + (bad ? 1 : 0)) & 0xff);
  return [0xaa, 0xaa, 0x2d, 0xd4, ...b];
}

/** Bytes to FSK PulseData at 366 us per bit: a mark is a run of ones, a gap a run of zeros. */
function pulses(bytes, rate = 1_000_000) {
  const bits = bytes.flatMap(v => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (v >> i) & 1));
  const runs = [];
  for (const b of bits) { if (runs.length && runs[runs.length - 1][0] === b) runs[runs.length - 1][1]++; else runs.push([b, 1]); }
  if (runs[0][0] === 0) runs.shift();
  if (runs[runs.length - 1][0] === 1) runs.push([0, 0]);
  const pulse = [], gap = [];
  for (let i = 0; i < runs.length; i += 2) {
    pulse.push(Math.round(runs[i][1] * 366 * rate / 1e6));
    gap.push(i + 1 === runs.length - 1 ? 10_000 * rate / 1e6 : Math.round(runs[i + 1][1] * 366 * rate / 1e6));
  }
  return { pulse: Int32Array.from(pulse), gap: Int32Array.from(gap), numPulses: pulse.length, sampleRate: rate, fsk: true };
}

const dev = REGISTRY.find(d => d.num === 386);
const run = (bytes) => new R433([dev]).run(2, pulses(bytes)).map(r => r.data);

let d = run(frame(0x12ab34, 0, 0, 4, 1))[0] ?? {};
eq(d.model, 'Olympia-9571', 'contact model'); eq(d.subtype, 'Contact', 'contact subtype'); eq(d.id, '12ab34', 'contact id');
eq(d.state, 'open', 'contact open'); eq(d.battery_ok, 1, 'battery ok');
d = run(frame(0x5a10ff, 1, 0, 7, 0))[0] ?? {};
eq(d.subtype, 'PIR-Motion', 'pir subtype'); eq(d.state, 'idle', 'pir idle'); eq(d.battery_ok, 0, 'battery weak');
d = run(frame(0xc0ffee, 0, 1, 7, 0))[0] ?? {};
eq(d.subtype, 'Keyfob', 'keyfob subtype'); eq(d.cmd, 'SOS', 'keyfob SOS'); eq(d.cmd_id, 7, 'keyfob cmd id');
eq(run(frame(0x12ab34, 0, 0, 4, 1, true)).length, 0, 'bad checksum is not reported');

console.log(`olympia: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
