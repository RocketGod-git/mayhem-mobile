// De Bruijn "open sesame" gate opener: the sequence must contain EVERY n-bit code exactly once as a sliding
// window, or a real receiver keyed to a missing code would never match. Evidence is the sequence's own structure.
import { deBruijn } from '../dist/tx-apps.js';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; } else { fail++; console.log('  FAIL ' + what); } };

console.log('de Bruijn gate opener');
for (const n of [4, 8, 12]) {
  const seq = deBruijn(n);
  // Unwrapped form: 2^n distinct windows, length 2^n + (n-1).
  ok(seq.length === (1 << n) + (n - 1), `B(2,${n}) unwrapped length is 2^${n}+${n - 1} (got ${seq.length})`);
  ok(seq.every(b => b === 0 || b === 1), `B(2,${n}) is binary`);
  const windows = new Set();
  for (let i = 0; i + n <= seq.length; i++) windows.add(seq.slice(i, i + n).join(''));
  ok(windows.size === (1 << n), `B(2,${n}) covers all ${1 << n} codes exactly once (got ${windows.size})`);
  // The whole point vs brute force: far fewer symbols than sending every code in full.
  ok(seq.length < (1 << n) * n, `B(2,${n}) is shorter than the ${(1 << n) * n}-symbol brute force`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
