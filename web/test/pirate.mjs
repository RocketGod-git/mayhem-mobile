/**
 * ProtoPirate car-key decoders, checked against the original C. The golden fixtures in resources/pirate/<slug>.txt
 * come from the ppharness tool, which compiles ProtoPirate's C protocol files natively and records, for pulse trains
 * that make each C decoder fire, exactly what its get_string printed on every callback. A port passes when it prints
 * the same lines, in the same order, on the same pulses (the same check the iOS and Android ports run).
 *
 * `node test/pirate.mjs` runs all 26; `node test/pirate.mjs kia_v2 vag` runs only those slugs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** PIRATE_DIST=<dir> loads the decoders from another tsc outDir (the one holding dsp/ism/pirate/). */
const dist = process.env.PIRATE_DIST ? pathToFileURL(join(process.env.PIRATE_DIST, 'dsp', 'ism', 'pirate') + '/').href : new URL('../dist/dsp/ism/pirate/', import.meta.url).href;

/** fixture slug -> [module under dist/dsp/ism/pirate, class name] */
const SUITE = [
  ['chrysler_v0', 'chrysler-v0', 'PPChryslerV0'],
  ['fiat_v0', 'fiat-v0', 'PPFiatV0'],
  ['fiat_v1', 'fiat-v1', 'PPFiatV1'],
  ['fiat_v2', 'fiat-v2', 'PPFiatV2'],
  ['ford_v0', 'ford-v0', 'PPFordV0'],
  ['ford_v1', 'ford-v1', 'PPFordV1'],
  ['ford_v2', 'ford-v2', 'PPFordV2'],
  ['ford_v3', 'ford-v3', 'PPFordV3'],
  ['honda_static', 'honda-static', 'PPHondaStatic'],
  ['honda_v1', 'honda-v1', 'PPHondaV1'],
  ['honda_v2', 'honda-v2', 'PPHondaV2'],
  ['kia_v0', 'kia-v0', 'PPKiaV0'],
  ['kia_v1', 'kia-v1', 'PPKiaV1'],
  ['kia_v2', 'kia-v2', 'PPKiaV2'],
  ['kia_v3_v4', 'kia-v3v4', 'PPKiaV3V4'],
  ['kia_v5', 'kia-v5', 'PPKiaV5'],
  ['kia_v6', 'kia-v6', 'PPKiaV6'],
  ['kia_v7', 'kia-v7', 'PPKiaV7'],
  ['mazda_v0', 'mazda-v0', 'PPMazdaV0'],
  ['psa', 'psa', 'PPPsa'],
  ['renault_v0', 'renault-v0', 'PPRenaultV0'],
  ['renault_v1', 'renault-v1', 'PPRenaultV1'],
  ['scher_khan', 'scher-khan', 'PPScherKhan'],
  ['star_line', 'star-line', 'PPStarLine'],
  ['subaru', 'subaru', 'PPSubaru'],
  ['vag', 'vag', 'PPVag'],
];

/** "# train <label>" starts a train, "= <text>" is one expected C callback line, "<level> <us>" is one pulse. */
function load(slug) {
  const text = readFileSync(join(here, 'resources', 'pirate', `${slug}.txt`), 'utf8');
  const trains = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('# train')) trains.push({ label: line.slice(7).trim(), expected: [], levels: [], durs: [] });
    else if (line.startsWith('#') || !trains.length) continue;
    else if (line.startsWith('= ')) trains[trains.length - 1].expected.push(line.slice(2));
    else {
      const f = line.split(' ');
      if (f.length === 2 && /^-?\d+$/.test(f[0]) && /^-?\d+$/.test(f[1])) {
        const t = trains[trains.length - 1]; t.levels.push(f[0] !== '0'); t.durs.push(parseInt(f[1], 10));
      }
    }
  }
  return trains;
}

const only = process.argv.slice(2);
let pass = 0, fail = 0, protoFail = 0;
console.log('ProtoPirate car-key decoders vs the C golden fixtures');
for (const [slug, mod, cls] of SUITE) {
  if (only.length && !only.includes(slug)) continue;
  const Dec = (await import(`${dist}${mod}.js`))[cls];
  const trains = load(slug);
  let p = 0, f = 0, lines = 0, pulses = 0;
  const t0 = performance.now();
  for (let i = 0; i < trains.length; i++) {
    const t = trains[i];
    const dec = new Dec();
    const got = [];
    dec.onHit = (h) => got.push(dec.cString(h));
    for (let j = 0; j < t.levels.length; j++) dec.feed(t.levels[j], t.durs[j]);
    pulses += t.levels.length; lines += t.expected.length;
    const same = got.length === t.expected.length && got.every((g, k) => g === t.expected[k]);
    if (same) p++;
    else {
      f++;
      if (f <= 3) {
        console.log(`  FAIL ${slug} train ${i} (${t.label})`);
        const n = Math.max(got.length, t.expected.length);
        for (let k = 0; k < n; k++) if (got[k] !== t.expected[k]) { console.log(`    want: ${t.expected[k]}\n    got:  ${got[k]}`); break; }
        if (got.length !== t.expected.length) console.log(`    lines: want ${t.expected.length}, got ${got.length}`);
      }
    }
  }
  const ms = performance.now() - t0;
  if (!trains.length) { f++; console.log(`  FAIL ${slug}: no trains`); }
  console.log(`  ${f ? 'FAIL' : 'ok  '} ${slug.padEnd(13)} ${p}/${trains.length} trains, ${lines} lines, ${pulses} pulses, ${ms.toFixed(0)} ms`);
  pass += p; fail += f; if (f) protoFail++;
}
console.log(`${pass} trains passed, ${fail} failed${protoFail ? ` (${protoFail} decoders)` : ''}`);
if (fail) process.exit(1);
