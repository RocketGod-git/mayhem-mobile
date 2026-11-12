/**
 * The Devices front end end to end: raw IQ in, readings out, with the burst far off the dial.
 *
 * A Ford V3 key frame (ProtoPirate's own golden pulses, so no real key is in the repo) is frequency shift keyed
 * onto a carrier 335 kHz above the dial, as a real Ford key does, then sent again 327 kHz below it, the other
 * frequency the same key uses. Both must be found, tuned to and decoded, and nothing else may be reported.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { R433Processor } from '../dist/dsp/r433/processor.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; console.log('FAIL', what); } };

// the first train of the fixture: levels and durations in microseconds
const text = readFileSync(join(here, 'resources', 'pirate', 'ford_v3.txt'), 'utf8');
const train = [];
let n = 0;
for (const line of text.split('\n')) {
  if (line.startsWith('# train')) { if (++n > 1) break; continue; }
  if (!line || line[0] === '#' || line[0] === '=') continue;
  const [l, us] = line.split(' ');
  train.push([l !== '0', parseInt(us, 10)]);
}
check(train.length > 100, 'fixture train read');

const rate = 2_000_000;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const out = [];
let phase = 0;
/** Noise for `ms`, or the train shifted onto `hz` with ±`dev` Hz of shift. */
function emit(ms, hz = null, dev = 10_500, amp = 40) {
  const push = (i, q) => out.push(Math.max(-128, Math.min(127, Math.round(i + gauss() * 5))), Math.max(-128, Math.min(127, Math.round(q + gauss() * 5))));
  if (hz === null) { for (let k = 0; k < rate * ms / 1000; k++) push(0, 0); return; }
  for (const [level, us] of train.slice(1)) {
    const f = hz + (level ? dev : -dev);
    for (let k = 0; k < Math.round(us * rate / 1e6); k++) { phase += 2 * Math.PI * f / rate; push(amp * Math.cos(phase), amp * Math.sin(phase)); }
  }
}
emit(100);
emit(0, 335_000);
emit(1300);
emit(0, -327_000);
emit(200);

const readings = [];
const p = new R433Processor(m => { if (m.type === 'r433') readings.push(m); });
p.reset(rate);
const iq = Int8Array.from(out);
for (let i = 0; i < iq.length; i += 262144) p.onIq(iq.subarray(i, Math.min(iq.length, i + 262144)), rate);

const fords = readings.filter(r => r.model === 'Ford V3' && r.data.id === '2265B1F6');
check(fords.some(r => Math.abs(r.offsetHz - 335_000) < 20_000), `Ford found 335 kHz above the dial (got ${readings.map(r => `${r.model}@${r.offsetHz}`).join(', ') || 'nothing'})`);
check(fords.some(r => Math.abs(r.offsetHz + 327_000) < 20_000), 'Ford found 327 kHz below the dial');
check(fords.every(r => r.family === 'key' && r.data.button === '02 Unlock'), 'reads as an Unlock press');
check(readings.length === fords.length, `nothing else reported (${readings.filter(r => !fords.includes(r)).map(r => r.model).join(', ')})`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
