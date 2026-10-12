// Looking Glass / Search sweep: how many reads a step throws away after a retune, with and without the radio's
// acknowledgement. The evidence is synthetic - buffers are made here, loud before the retune lands and quiet
// after - so what is being checked is the bookkeeping, not the radio.
import { SweepProcessor } from '../dist/dsp/sweep.js';

let checks = 0, failed = 0;
const ok = (cond, what) => { checks++; if (!cond) { failed++; console.log('  FAIL ' + what); } };

const RATE = 8_000_000, SAMPLES = 32768;                 // one 64 KiB HackRF read
function buffer(amplitude, tone) {
  const iq = new Int8Array(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i++) {
    const ph = tone ? 2 * Math.PI * 0.1 * i : 0;
    iq[2 * i] = Math.round((tone ? Math.cos(ph) : (Math.random() * 2 - 1)) * amplitude);
    iq[2 * i + 1] = Math.round((tone ? Math.sin(ph) : (Math.random() * 2 - 1)) * amplitude);
  }
  return iq;
}
const LOUD = buffer(100, true), QUIET = buffer(2, false);

/** Drive one sweep step: feed `stale` loud reads, then (optionally) the ack, then quiet reads until the row lands.
 *  Returns how many reads the step consumed and the loudest bin of the row it produced. */
function step(ackAfter) {
  const events = [];
  const sp = new SweepProcessor(100e6, 100e6 + 1, 8e6, (m) => events.push(m));   // one step per sweep
  sp.reset();
  // the first step after reset settles on a short fixed count; run it out so the measurement below is a normal step
  while (!events.some(e => e.type === 'sweep')) sp.onIq(QUIET, RATE);
  events.length = 0;
  let fed = 0, ackSent = false;
  while (!events.some(e => e.type === 'sweep')) {
    if (ackAfter !== null && fed === ackAfter && !ackSent) { sp.tuned(); ackSent = true; }
    // everything up to the ack plus the reads already in flight is still on the old frequency
    const stale = ackAfter === null ? fed < 20 : fed < ackAfter + 8;
    sp.onIq(stale ? LOUD : QUIET, RATE); fed++;
  }
  const row = events.find(e => e.type === 'sweep').row;
  return { fed, peak: Math.max(...row) };
}

console.log('sweep: the retune acknowledgement');
const bufMs = SAMPLES * 1000 / RATE;
const fallback = Math.ceil(130 / bufMs);                 // SETTLE_MS in the processor
const slow = step(null);
ok(slow.fed === fallback + 1, `without an ack a step discards the fixed settle (${fallback}) then integrates one read (got ${slow.fed})`);

const quick = step(3);
ok(quick.fed === 3 + 9 + 1, `with the ack after 3 reads the step is 3 + 9 stale + 1 (got ${quick.fed})`);
ok(quick.fed < slow.fed, 'the ack makes the step shorter');

// the premise of the whole thing: the reads still in flight when the ack lands are stale, and none of them
// may reach the row - LOUD carries a 40 dB tone that would show as the peak
const quietPeak = step(null).peak;
ok(quick.peak < quietPeak + 6, `no stale read leaks into the row (peak ${quick.peak.toFixed(0)} vs quiet ${quietPeak.toFixed(0)} dB)`);

// an ack that arrives after the fixed settle already ran out (a slow radio) must not shorten the *next* step
{
  const events = [];
  const sp = new SweepProcessor(100e6, 100e6 + 1, 8e6, (m) => events.push(m));
  sp.reset();
  while (!events.some(e => e.type === 'sweep')) sp.onIq(QUIET, RATE);
  events.length = 0;
  let fed = 0;
  while (!events.some(e => e.type === 'sweep')) { sp.onIq(QUIET, RATE); fed++; }
  ok(fed === fallback + 1, 'a step with no ack runs the fallback');
  sp.tuned(); sp.tuned();                                // late, and twice
  events.length = 0; fed = 0;
  while (!events.some(e => e.type === 'sweep')) { sp.onIq(QUIET, RATE); fed++; }
  ok(fed === 9 + 1, `an ack is taken for the step it arrives in, once (got ${fed})`);
}

// the ack never lengthens a step: a radio that answers late, after most of the fallback, keeps what is left
{
  const late = step(fallback - 2);
  ok(late.fed <= fallback + 1, `a late ack does not add to the fallback (got ${late.fed})`);
}

console.log(`${checks - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
