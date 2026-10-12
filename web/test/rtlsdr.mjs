/**
 * What can be checked about the RTL-SDR driver without a dongle plugged in.
 *
 * Not much of a USB driver is testable off the hardware, but the parts that are wrong-and-silent all are: the
 * synthesizer arithmetic that decides what frequency the thing actually tunes, the filter coefficients that
 * decide how well it hears, the gain walk, and the limits the app uses to decide whether to bother. A radio
 * that is quietly two megahertz off, or running a mis-packed filter, looks exactly like a radio in a bad spot.
 *
 * Run with `npm run test:rtl` after `npm run build`.
 */
import { firBytes, gainSteps, pllPlan, pllFreq, RTL_LIMITS, RTL_MAX_GAIN_DB } from '../dist/rtlsdr.js';
import { HACKRF_LIMITS } from '../dist/hackrf.js';
import { APP_NEEDS, blockedBecause, canSample, canTune, nearestRate, whyNot } from '../dist/radio.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${a}, want ${b}`);
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ±${tol}`);

const RTL_XTAL = 28_800_000, R828D_XTAL = 16_000_000;
const IF = 3_570_000;

console.log('synthesizer: the frequency it plans is the frequency it was asked for');
{
  // Every band the app actually uses, plus the edges. The tuner is asked for the wanted frequency plus the
  // 3.57 MHz intermediate, and what comes back has to land there — a fractional-N divider with a sixteen-bit
  // fraction should be good to well under a kilohertz anywhere in range.
  const bands = [
    [24_000_000, 'the bottom of the tuner'],
    [88_500_000, 'broadcast FM'],
    [131_550_000, 'ACARS'],
    [137_100_000, 'weather satellites'],
    [144_390_000, 'APRS'],
    [161_975_000, 'AIS'],
    [315_000_000, 'American ISM'],
    [433_920_000, 'European ISM'],
    [868_300_000, 'European ISM high'],
    [911_600_000, 'utility meters'],
    [929_612_500, 'pagers'],
    [1_090_000_000, 'ADS-B'],
    [1_575_420_000, 'GPS L1'],
    [1_760_000_000, 'the top of the tuner'],
  ];
  for (const [rf, what] of bands) {
    const lo = rf + IF;
    const plan = pllPlan(lo, RTL_XTAL, 2);            // fine-tune reading of 2 leaves the divider alone
    ok(plan.ok, `${what}: the synthesizer will reach ${(rf / 1e6).toFixed(3)} MHz`);
    if (plan.ok) {
      const got = pllFreq(plan, RTL_XTAL);
      near(got, lo, 500, `  ${what}: lands within 500 Hz`);
      // The VCO itself has to be inside its own window or the part will not lock however good the numbers are.
      const vco = got * plan.mixDiv;
      ok(vco >= 1.77e9 && vco < 3.54e9, `  ${what}: VCO inside 1.77–3.54 GHz`, `${(vco / 1e9).toFixed(3)} GHz`);
    }
  }

  // An R828D — the RTL-SDR Blog V4 and most of what is sold now — runs its synthesizer from a sixteen
  // megahertz crystal rather than the RTL's 28.8. Using the wrong one is the mistake that puts a V4 exactly
  // 1.8× off frequency, so it is worth a test of its own.
  for (const rf of [433_920_000, 1_090_000_000]) {
    const lo = rf + IF;
    const plan = pllPlan(lo, R828D_XTAL, 1, 1);
    ok(plan.ok, `R828D at ${(rf / 1e6).toFixed(2)} MHz: reachable`);
    near(pllFreq(plan, R828D_XTAL), lo, 500, `R828D at ${(rf / 1e6).toFixed(2)} MHz: lands within 500 Hz`);
  }

  // The fine-tune reading shifts the divider, which must not silently move the frequency.
  const a = pllPlan(437_490_000, RTL_XTAL, 1), b = pllPlan(437_490_000, RTL_XTAL, 3);
  eq(a.divNum, b.divNum + 2, 'the VCO fine-tune reading moves the divider either way');
}

console.log('channel filter: the coefficients pack the way librtlsdr packs them');
{
  const fir = firBytes();
  eq(fir.length, 20, 'twenty bytes go to the demodulator');
  // The first eight are signed bytes taken as-is.
  const signed = [-54, -36, -41, -40, -32, -14, 14, 53];
  for (let i = 0; i < 8; i++) eq(fir[i], signed[i] & 0xff, `  coefficient ${i} is its own signed byte`);
  // The last eight are twelve-bit, two packed into every three bytes. Unpack and compare.
  const twelve = [101, 156, 215, 273, 327, 372, 404, 421];
  for (let i = 0; i < 8; i += 2) {
    const at = 8 + ((i * 3) >> 1);
    const v0 = (fir[at] << 4) | (fir[at + 1] >> 4);
    const v1 = ((fir[at + 1] & 0x0f) << 8) | fir[at + 2];
    eq(v0, twelve[i], `  coefficient ${8 + i} survives the twelve-bit packing`);
    eq(v1, twelve[i + 1], `  coefficient ${9 + i} survives the twelve-bit packing`);
  }
  ok(fir.every(b => b >= 0 && b <= 255), 'every byte fits in a byte');
}

console.log('gain: the steps reach what they claim to');
{
  eq(gainSteps(0).total, 0, 'nothing asked for is nothing given');
  const max = gainSteps(9999);
  eq(max.total, Math.round(RTL_MAX_GAIN_DB * 10), 'every step together is 48.8 dB, not the 49.6 usually quoted');
  ok(max.lna <= 15 && max.mix <= 15, 'neither stage runs off the end of its table', `lna ${max.lna} mix ${max.mix}`);
  // Asking for a gain must never hand back less than it, up to the maximum: that is the whole contract, and
  // the reason the walk alternates rather than filling one stage first.
  for (let want = 0; want <= 496; want += 8) {
    const g = gainSteps(want);
    ok(g.total >= want, `asking for ${want / 10} dB gives at least that`, `got ${g.total / 10} dB`);
  }
  // Monotonic: more asked for is never less given.
  let prev = -1;
  let mono = true;
  for (let want = 0; want <= 496; want += 4) { const t = gainSteps(want).total; if (t < prev) mono = false; prev = t; }
  ok(mono, 'asking for more never gives less');
}

console.log('limits: what each radio will and will not do');
{
  ok(canTune(RTL_LIMITS, 433_920_000), 'a dongle tunes the ISM band');
  ok(canTune(RTL_LIMITS, 1_090_000_000), 'a dongle tunes ADS-B');
  ok(!canTune(RTL_LIMITS, 2_402_000_000), 'a dongle does not reach Bluetooth');
  ok(!canTune(RTL_LIMITS, 7_074_000), 'a dongle does not reach the forty metre band');
  ok(canTune(HACKRF_LIMITS, 2_402_000_000), 'a HackRF does reach Bluetooth');

  ok(canSample(RTL_LIMITS, 2_000_000), 'a dongle samples at 2 Msps');
  ok(canSample(RTL_LIMITS, 250_000), 'a dongle samples at 250 kHz — which a HackRF cannot');
  ok(!canSample(HACKRF_LIMITS, 250_000), '  and a HackRF indeed cannot');
  ok(!canSample(RTL_LIMITS, 4_000_000), 'a dongle does not sample at 4 Msps');
  ok(!canSample(RTL_LIMITS, 600_000), 'nor anywhere in the hole between 300 and 900 kHz');

  eq(nearestRate(RTL_LIMITS, 2_000_000), 2_000_000, 'a rate it can do is left alone');
  eq(nearestRate(RTL_LIMITS, 4_000_000), 2_400_000, 'a rate too high is pulled down to the ceiling');
  eq(nearestRate(RTL_LIMITS, 19_200_000), 2_400_000, "HAM's fastest setting clamps rather than failing");
  eq(nearestRate(RTL_LIMITS, 250_000), 250_000, 'the Devices span is native');

  eq(whyNot(RTL_LIMITS, 433_920_000, 2_000_000), '', 'Devices works on a dongle');
  eq(whyNot(RTL_LIMITS, 1_090_000_000, 2_000_000), '', 'ADS-B works on a dongle');
  ok(whyNot(RTL_LIMITS, 2_402_000_000, 2_000_000).includes('outside'), 'Bluetooth explains itself');
  ok(whyNot(RTL_LIMITS, 433_920_000, 4_000_000).includes('above'), 'a too-fast sweep explains itself');
  eq(RTL_LIMITS.canTransmit, false, 'a dongle cannot transmit');
  eq(HACKRF_LIMITS.canTransmit, true, 'a HackRF can');
}

console.log('a HackRF is untouched by any of this');
{
  // The standing rule: adding a second radio must not change what a HackRF session does. Every one of these
  // would be a behaviour change on hardware that was working before, so they are asserted rather than assumed.

  // Nothing dims. If an app ever declares a need a HackRF cannot meet, this fails and names it.
  for (const [id, needs] of Object.entries(APP_NEEDS)) {
    eq(blockedBecause(needs, HACKRF_LIMITS), '', `${id} is not dimmed on a HackRF`);
  }

  // No sample rate any app asks for is clamped: the common 2 Msps, the whole HAM ladder, every sweep slice,
  // and the ERT fast option.
  for (const r of [2_000_000, 1_920_000, 3_840_000, 7_680_000, 15_360_000, 19_200_000,
    4_000_000, 8_000_000, 4_194_304]) {
    eq(nearestRate(HACKRF_LIMITS, r), r, `a HackRF is not clamped at ${(r / 1e6).toFixed(3)} Msps`);
  }

  // And no app reports a reason it cannot run, frequency and rate together.
  const everyApp = [
    ['audio', 88_500_000, 2_000_000], ['sat', 137_100_000, 2_000_000],
    ['adsb', 1_090_000_000, 2_000_000], ['ais', 161_975_000, 2_000_000],
    ['aprs', 144_390_000, 2_000_000], ['pager', 929_612_500, 2_000_000],
    ['ert', 911_600_000, 4_194_304], ['btle', 2_402_000_000, 2_000_000],
    ['tpms', 315_000_000, 2_000_000], ['acars', 131_550_000, 2_000_000],
    ['subghz', 433_920_000, 2_000_000], ['devices', 433_920_000, 2_000_000],
    ['ham', 14_074_000, 19_200_000], ['lookingglass', 98_000_000, 8_000_000],
    ['search', 435_000_000, 4_000_000], ['capture', 433_920_000, 2_000_000],
  ];
  for (const [id, f, r] of everyApp) eq(whyNot(HACKRF_LIMITS, f, r), '', `${id} runs on a HackRF`);
  eq(HACKRF_LIMITS.canTransmit, true, 'a HackRF still transmits');
}

console.log('a dongle dims exactly what it should, and nothing else');
{
  const dimmed = Object.keys(APP_NEEDS).filter(id => blockedBecause(APP_NEEDS[id], RTL_LIMITS));
  eq(dimmed.sort().join(','), 'btle,ham,transmit', 'HAM, Bluetooth and Transmit dim on a dongle');
  // The other half of being useful: everything else stays bright.
  for (const id of ['audio', 'sat', 'adsb', 'ais', 'aprs', 'pager', 'ert', 'tpms', 'acars', 'subghz',
    'devices', 'lookingglass', 'search', 'capture', 'settings', 'prowl']) {
    eq(blockedBecause(APP_NEEDS[id], RTL_LIMITS), '', `${id} stays bright on a dongle`);
  }
  ok(blockedBecause(APP_NEEDS.transmit, RTL_LIMITS).includes('receives only'), 'Transmit says why');
  ok(blockedBecause(APP_NEEDS.ham, RTL_LIMITS).includes('14.074'), 'HAM names the band it is missing');
  // A sweep slice a dongle cannot sample is pulled to one it can, rather than leaving unswept gaps.
  eq(nearestRate(RTL_LIMITS, 4_000_000), 2_400_000, 'a 4 MHz sweep slice comes down');
  eq(nearestRate(RTL_LIMITS, 2_000_000), 2_000_000, 'a 2 MHz slice is already fine');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
