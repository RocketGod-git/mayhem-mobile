/** The Sub-GHz family chips show ISM_COUNTS: check them against the decoders the worker actually runs. */
const r = await import('../dist/dsp/ism/registry.js');
const b = await import('../dist/dsp/ism/base.js');
const p = await import('../dist/dsp/ism/pirate/protos.js');
const { ISM_COUNTS } = await import('../dist/dsp/ism/counts.js');
const all = r.allProtos();
const n = (f) => all.filter((x) => x.family === f).length;
const pp = p.ppAll();
const pirate = new Set([...pp.am, ...pp.fm].map((d) => d.constructor.name)).size;
const real = { weather: n(b.Fam.WEATHER), remotes: n(b.Fam.REMOTE), cars: n(b.Fam.CAR) + pirate };
for (const k of Object.keys(real)) if (real[k] !== ISM_COUNTS[k]) { console.error(`ISM_COUNTS.${k} = ${ISM_COUNTS[k]}, registry has ${real[k]}`); process.exit(1); }
console.log('ism-counts ok', JSON.stringify(real));
