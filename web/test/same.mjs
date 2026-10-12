/**
 * NOAA Weather Radio / EAS SAME decoder.
 *
 * The evidence here is synthetic: no off-air recording is used. Every burst is built from the transmit side by
 * a modulator written in this file from the published definition (520.83 baud, bytes least significant bit
 * first, mark 2083.33 Hz, space 1562.5 Hz, sixteen 0xAB preamble bytes, three copies of the header) and then
 * put through an FM modulator and the same atan2 discriminator the worker uses, so the decoder sees what it
 * will see on air: radians per sample, at whatever level the deviation happens to give.
 *
 * The modulator's premises are checked first — the bit order of a known byte, the cycles-per-bit of each tone,
 * that the discriminator gives back the audio at the expected scale — because a builder that is wrong in the
 * same way as the decoder proves nothing.
 */
import { SameDecoder, parseSameHeader, SAME_BAUD } from '../dist/dsp/same.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const deq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

console.log('NOAA Weather Radio / EAS SAME');

// ---------------------------------------------------------------------------------------------------------
// Transmit side, written from the definition and independent of the decoder.
// ---------------------------------------------------------------------------------------------------------
const BAUD = 520 + 5 / 6;
const MARK = 2083.33, SPACE = 1562.5;

const ascii = (s) => Uint8Array.from(s, ch => ch.charCodeAt(0));
/** A byte's eight bits, least significant first, as SAME sends them. */
const bitsLsb = (b) => { const o = []; for (let i = 0; i < 8; i++) o.push((b >> i) & 1); return o; };
const preamble = () => { const o = []; for (let i = 0; i < 16; i++) o.push(...bitsLsb(0xab)); return o; };
const burstBits = (text) => { const o = preamble(); for (const b of ascii(text)) o.push(...bitsLsb(b)); return o; };

/**
 * Phase-continuous AFSK: sample k belongs to bit floor(k * baud / rate), so the bit period is exact even where
 * it is not a whole number of samples. Returns audio in [-1, 1].
 */
const afsk = (bits, rate, baud = BAUD, mark = MARK, space = SPACE) => {
  const n = Math.ceil(bits.length * rate / baud);
  const out = new Float32Array(n);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const bit = bits[Math.min(bits.length - 1, Math.floor(k * baud / rate))];
    ph += 2 * Math.PI * (bit ? mark : space) / rate;
    out[k] = Math.sin(ph);
  }
  return out;
};
const tone = (freqs, seconds, rate) => {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let k = 0; k < out.length; k++) { let v = 0; for (const f of freqs) v += Math.sin(2 * Math.PI * f * k / rate); out[k] = v / freqs.length; }
  return out;
};
const silence = (seconds, rate) => new Float32Array(Math.round(seconds * rate));
const concat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Float32Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };

/** Deterministic Gaussian noise so a failure is repeatable. */
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/**
 * The conversion the decoder's input implies: FM-modulate the audio at `devHz` peak deviation into unit IQ,
 * optionally add complex Gaussian noise (rms `noise` relative to the unit carrier), then discriminate with the
 * worker's own formula, atan2 of the conjugate product of successive samples.
 */
const discriminate = (audio, rate, { devHz = 3000, noise = 0, seed = 1 } = {}) => {
  const out = new Float32Array(audio.length);
  const r = rng(seed);
  let ph = 0, pi = 1, pq = 0;
  for (let k = 0; k < audio.length; k++) {
    ph += 2 * Math.PI * devHz * audio[k] / rate;
    let i = Math.cos(ph), q = Math.sin(ph);
    if (noise) { i += noise * gauss(r) / Math.SQRT2; q += noise * gauss(r) / Math.SQRT2; }
    out[k] = Math.atan2(q * pi - i * pq, i * pi + q * pq);
    pi = i; pq = q;
  }
  return out;
};

/** A whole transmission: three copies of the header a second apart, the attention tone, three EOMs. */
const transmission = (header, rate, { copies = 3, eom = true, toneSec = 8, toneHz = [1050], gap = 1, baud = BAUD, corrupt = null } = {}) => {
  const parts = [silence(0.5, rate)];
  const headers = Array.isArray(header) ? header : Array(copies).fill(header);
  headers.forEach((h, i) => {
    const bits = burstBits(h);
    if (corrupt && corrupt.copy === i) { const at = 128 + corrupt.byte * 8; for (let b = 0; b < 8; b++) bits[at + b] ^= (corrupt.xor >> b) & 1; }
    parts.push(afsk(bits, rate, baud), silence(gap, rate));
  });
  if (toneSec > 0) parts.push(tone(toneHz, toneSec, rate), silence(gap, rate));
  if (eom) for (let i = 0; i < 3; i++) parts.push(afsk(burstBits('NNNN'), rate, baud), silence(gap, rate));
  parts.push(silence(3, rate));
  return concat(parts);
};

/** Run a decoder over discriminator samples in worker-sized chunks; returns everything it emitted. */
const decode = (disc, rate, chunk = 4096) => {
  const out = [];
  const d = new SameDecoder(m => out.push(m));
  d.reset(rate);
  for (let at = 0; at < disc.length; at += chunk) {
    const n = Math.min(chunk, disc.length - at);
    d.onFm(disc.subarray(at, at + n), n, rate);
  }
  return out;
};
const headers = (out) => out.filter(m => m.type === 'same' && m.event === 'header');
const eoms = (out) => out.filter(m => m.type === 'same' && m.event === 'eom');
const tones = (out) => out.filter(m => m.type === 'same' && m.event === 'tone');

const HDR = 'ZCZC-WXR-TOR-020103-020209+0030-1051700-KCLE/NWS-';
const RATE = 48000;

// ---- Premises of the modulator ----
{
  deq(bitsLsb(0xab), [1, 1, 0, 1, 0, 1, 0, 1], 'the preamble byte 0xAB goes out least significant bit first (premise)');
  deq(bitsLsb(0x5a), [0, 1, 0, 1, 1, 0, 1, 0], "and so does 'Z' (0x5A)");
  eq(preamble().length, 128, 'sixteen preamble bytes are 128 bits');
  ok(Math.abs(1 / BAUD - 0.00192) < 1e-9, 'the bit period is 1.92 ms (premise)');
  ok(Math.abs(MARK / BAUD - 4) < 1e-3, 'mark is four cycles per bit');
  ok(Math.abs(SPACE / BAUD - 3) < 1e-9, 'space is three cycles per bit');
  eq(SAME_BAUD, BAUD, "the decoder's baud constant is the same number");

  // The FM/discriminator round trip has to give the audio back at 2*pi*dev/rate radians per sample, or the
  // level the decoder is tested at means nothing.
  const a = tone([1000], 0.1, RATE);
  const d = discriminate(a, RATE, { devHz: 3000 });
  let peak = 0, err = 0;
  for (let k = 1; k < a.length; k++) { peak = Math.max(peak, Math.abs(d[k])); err = Math.max(err, Math.abs(d[k] - 2 * Math.PI * 3000 * a[k] / RATE)); }
  ok(Math.abs(peak - 2 * Math.PI * 3000 / RATE) < 1e-3, 'the discriminator returns the audio at 2*pi*dev/rate rad/sample (premise)', `peak ${peak}`);
  ok(err < 1e-3, 'sample for sample', `max error ${err}`);
  eq(afsk(burstBits('NNNN'), RATE).length, Math.ceil(160 * RATE / BAUD), 'an EOM burst is 160 bits long');
}

// ---- The realistic header, three copies, tone, EOM ----
{
  const out = decode(discriminate(transmission(HDR, RATE), RATE), RATE);
  const h = headers(out);
  eq(h.length, 1, 'one header event for three copies');
  const m = h[0] ?? {};
  eq(m.type, 'same', 'emit type');
  eq(m.raw, HDR, 'raw header text');
  eq(m.repeats, 3, 'all three copies contributed');
  const p = m.header ?? {};
  eq(p.originator, 'WXR', 'originator code');
  eq(p.originatorName, 'National Weather Service', 'originator name');
  eq(p.event, 'TOR', 'event code');
  eq(p.eventName, 'Tornado Warning', 'event name');
  deq(p.locations, [
    { code: '020103', portion: 0, state: '20', county: '103' },
    { code: '020209', portion: 0, state: '20', county: '209' },
  ], 'location codes split into portion, state FIPS, county FIPS');
  deq(p.duration, { hours: 0, minutes: 30 }, 'duration 0030 is 0 h 30 min');
  deq(p.issued, { day: 105, hour: 17, minute: 0 }, 'issued 1051700 is day 105 at 17:00 UTC');
  eq(p.callsign, 'KCLE/NWS', 'callsign');

  const t = tones(out);
  eq(t.length, 1, 'the 1050 Hz attention tone is reported once');
  eq(t[0]?.raw, '1050 Hz', 'as 1050 Hz');
  const e = eoms(out);
  eq(e.length, 1, 'one EOM event for three NNNN bursts');
  eq(e[0]?.raw, 'NNNN', 'EOM raw');
  eq(e[0]?.repeats, 3, 'EOM repeats');
  deq(out.map(x => x.event), ['header', 'tone', 'eom'], 'events arrive in transmission order and nothing else is emitted');
}

// ---- Repeats and voting ----
{
  // A wrong digit in a county code of the second copy still passes the structure check on its own, so only
  // the vote can put it right. Byte 25 of the text is the '9' of 020209 (index counted from 'Z').
  eq(HDR[25], '9', 'the corrupted byte is the last digit of the second county (premise)');
  const out = decode(discriminate(transmission(HDR, RATE, { corrupt: { copy: 1, byte: 25, xor: 0x01 } }), RATE), RATE);
  eq(headers(out).length, 1, 'a corrupted digit in one copy still yields one header');
  eq(headers(out)[0]?.raw, HDR, 'and the other two copies outvote it');
  eq(headers(out)[0]?.repeats, 3, 'with all three copies counted');
  eq(headers(out)[0]?.header?.locations?.[1]?.county, '209', 'the county is the one two copies agree on');
  // The same hit in the FIRST copy: that copy is still well-formed, so nothing but a real majority can
  // prefer the two later copies over it.
  const out0 = decode(discriminate(transmission(HDR, RATE, { corrupt: { copy: 0, byte: 25, xor: 0x01 } }), RATE), RATE);
  eq(out0.length && headers(out0)[0]?.raw, HDR, 'a well-formed but wrong first copy is outvoted by the two after it');
  eq(headers(out0)[0]?.repeats, 3, 'three copies counted');
}
{
  // The '+' of the first copy is hit (becomes '-'): that copy never matches the structure and is closed by the
  // silence after it, yet its characters still vote.
  const plus = HDR.indexOf('+');
  eq(plus, 26, "'+' is byte 26 of the text (premise)");
  const out = decode(discriminate(transmission(HDR, RATE, { corrupt: { copy: 0, byte: plus, xor: 0x2b ^ 0x2d } }), RATE), RATE);
  eq(headers(out).length, 1, "a copy with its '+' hit is outvoted");
  eq(headers(out)[0]?.raw, HDR, 'and the voted header is the clean one');
  eq(headers(out)[0]?.repeats, 3, 'three copies counted');
}
{
  // Two copies that disagree with no third to settle it: the damaged copy is sent FIRST, so a vote that simply
  // kept the earliest character would keep the damage. The rule is that a copy which was well-formed on its
  // own is the better witness and wins the tie.
  const bad = HDR.replace('+', '-');
  const out = decode(discriminate(transmission([bad, HDR], RATE, { toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 1, 'two copies produce one header');
  eq(headers(out)[0]?.repeats, 2, 'repeats is two');
  eq(headers(out)[0]?.raw, HDR, 'a tie goes to the copy that was well-formed on its own');
}
{
  const out = decode(discriminate(transmission(HDR, RATE, { copies: 1, toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 1, 'a single copy is still reported once the others are overdue');
  eq(headers(out)[0]?.repeats, 1, 'with repeats 1');
}
{
  const out = decode(discriminate(transmission(HDR, RATE, { copies: 2, toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out)[0]?.repeats, 2, 'two clean copies report repeats 2');
  eq(eoms(out).length, 0, 'and no EOM when none was sent');
}

// ---- Rejections ----
{
  const noPlus = HDR.replace('+', '-');
  const out = decode(discriminate(transmission(noPlus, RATE), RATE), RATE);
  eq(headers(out).length, 0, "a header without its '+' is rejected in all three copies");
  eq(eoms(out).length, 1, 'the EOM that follows still decodes');
}
{
  const bits = preamble();
  const out = decode(discriminate(concat([silence(0.5, RATE), afsk(bits, RATE), silence(3, RATE)]), RATE), RATE);
  eq(out.length, 0, 'the preamble alone produces nothing');
}
{
  const out = decode(discriminate(silence(6, RATE), RATE, { noise: 0.5 }), RATE);
  eq(out.length, 0, 'noise alone produces nothing');
}
{
  const out = decode(discriminate(transmission('ZCZC-WXR-TOR+0030-1051700-KCLE/NWS-', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 0, 'a header with no location code is rejected');
}
{
  const out = decode(discriminate(transmission('ZCZC-WXR-TOR-02010+0030-1051700-KCLE/NWS-', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 0, 'a five-digit location code is rejected');
}
{
  const out = decode(discriminate(transmission('ZCZC-WXR-TOR-020103+0030-1051700-KCLE/NW-', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 0, 'a seven-character callsign is rejected');
}
{
  const out = decode(discriminate(transmission('ZCZC-WXR-TOR-020103+0030-1052500-KCLE/NWS-', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  eq(headers(out).length, 0, 'an issue hour of 25 is rejected rather than shown');
}
{
  const out = decode(discriminate(transmission('ZCZC-WXR-TOR-020103+0030-1051700-KCLE/NWS-', RATE, { toneSec: 0, eom: false, gap: 0.2 }), RATE), RATE);
  eq(headers(out).length, 1, 'copies only 200 ms apart are still one header');
}

// ---- Fields and tables ----
{
  const out = decode(discriminate(transmission('ZCZC-EAS-RWT-039001-039003-139005+0130-2600715-WXYZ/FM -', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  const p = headers(out)[0]?.header ?? {};
  eq(p.originatorName, 'Broadcast station', 'EAS is a broadcast station');
  eq(p.eventName, 'Required Weekly Test', 'RWT is the weekly test');
  eq(p.locations?.length, 3, 'three location codes');
  eq(p.locations?.[2]?.portion, 1, 'the portion digit is reported');
  eq(p.locations?.[2]?.state, '39', 'state FIPS');
  eq(p.locations?.[2]?.county, '005', 'county FIPS keeps its leading zeros');
  deq(p.duration, { hours: 1, minutes: 30 }, 'duration 0130 is 1 h 30 min');
  deq(p.issued, { day: 260, hour: 7, minute: 15 }, 'issued 2600715');
  eq(p.callsign, 'WXYZ/FM', 'a space-padded callsign is trimmed');
}
{
  const out = decode(discriminate(transmission('ZCZC-QQQ-XYZ-020103+0030-1051700-KCLE/NWS-', RATE, { toneSec: 0, eom: false }), RATE), RATE);
  const p = headers(out)[0]?.header ?? {};
  eq(p.event, 'XYZ', 'an unknown event code is reported raw');
  eq(p.eventName, 'XYZ', 'and its name is the code, not an invention');
  eq(p.originator, 'QQQ', 'an unknown originator is reported raw');
  eq(p.originatorName, 'QQQ', 'with the code as its name');
}
{
  const names = { RMT: 'Required Monthly Test', TOA: 'Tornado Watch', SVR: 'Severe Thunderstorm Warning', SVA: 'Severe Thunderstorm Watch',
    FFW: 'Flash Flood Warning', FFA: 'Flash Flood Watch', FLW: 'Flood Warning', FLA: 'Flood Watch', WSW: 'Winter Storm Warning',
    WSA: 'Winter Storm Watch', BZW: 'Blizzard Warning', HWW: 'High Wind Warning', HWA: 'High Wind Watch', HUW: 'Hurricane Warning',
    HUA: 'Hurricane Watch', TRW: 'Tropical Storm Warning', TRA: 'Tropical Storm Watch', EWW: 'Extreme Wind Warning',
    SMW: 'Special Marine Warning', CFW: 'Coastal Flood Warning', CFA: 'Coastal Flood Watch', EVI: 'Evacuation Immediate',
    CEM: 'Civil Emergency Message', CAE: 'Child Abduction Emergency', EAN: 'Emergency Action Notification',
    NPT: 'National Periodic Test', ADR: 'Administrative Message', DMO: 'Practice/Demo' };
  for (const [code, name] of Object.entries(names)) eq(parseSameHeader(`ZCZC-PEP-${code}-000000+0015-0010000-TEST    -`)?.eventName, name, `${code} is ${name}`);
  eq(parseSameHeader('ZCZC-PEP-EAN-000000+0015-0010000-TEST    -')?.originatorName, 'Primary Entry Point', 'PEP');
  eq(parseSameHeader('ZCZC-CIV-CEM-000000+0015-0010000-TEST    -')?.originatorName, 'Civil authorities', 'CIV');
  eq(parseSameHeader('ZCZC-WXR-TOR-020103+0030-1051700-KCLE/NWS-junk')?.callsign, 'KCLE/NWS', 'trailing junk after the final dash is ignored');
  eq(parseSameHeader('ZCZC-WXR-TOR-020103+0030-1051700-KCLE/NWS'), null, 'but the final dash itself is required');
}

// ---- Tolerances ----
for (const [label, opts] of [
  ['5% low', { devHz: 2850 }], ['5% high', { devHz: 3150 }],
  ['a quarter of the level', { devHz: 750 }], ['four times the level', { devHz: 12000 }],
]) {
  const out = decode(discriminate(transmission(HDR, RATE), RATE, opts), RATE);
  eq(headers(out)[0]?.raw, HDR, `decodes at ${label}`);
  eq(eoms(out).length, 1, `EOM at ${label}`);
}
for (const [label, baud] of [['1% slow', BAUD * 0.99], ['1% fast', BAUD * 1.01]]) {
  const out = decode(discriminate(transmission(HDR, RATE, { baud }), RATE), RATE);
  eq(headers(out)[0]?.raw, HDR, `decodes ${label}`);
  eq(headers(out)[0]?.repeats, 3, `all three copies ${label}`);
}
{
  // Complex noise at the unit carrier: rms 0.35 is about 9 dB carrier-to-noise in the channel.
  const out = decode(discriminate(transmission(HDR, RATE), RATE, { noise: 0.35, seed: 7 }), RATE);
  eq(headers(out)[0]?.raw, HDR, 'decodes through 9 dB C/N noise on the IQ');
  eq(eoms(out).length, 1, 'EOM through the same noise');
}
{
  const disc = discriminate(transmission(HDR, RATE), RATE);
  const r = rng(3);
  for (let k = 0; k < disc.length; k++) disc[k] += 0.15 * gauss(r);
  const out = decode(disc, RATE);
  eq(headers(out)[0]?.raw, HDR, 'decodes with white noise added after the discriminator');
}
for (const rate of [24000, 96000]) {
  const out = decode(discriminate(transmission(HDR, rate), rate), rate);
  eq(headers(out)[0]?.raw, HDR, `decodes at ${rate / 1000} kHz`);
  eq(tones(out).length, 1, `tone at ${rate / 1000} kHz`);
  eq(eoms(out).length, 1, `EOM at ${rate / 1000} kHz`);
}
{
  // Chunk boundaries must not matter; the worker's chunk size is whatever the USB transfer was.
  const disc = discriminate(transmission(HDR, RATE), RATE);
  eq(headers(decode(disc, RATE, 333))[0]?.raw, HDR, 'decodes in 333-sample chunks');
  eq(headers(decode(disc, RATE, 65536))[0]?.raw, HDR, 'decodes in 65536-sample chunks');
}

// ---- Attention tone ----
{
  const out = decode(discriminate(transmission(HDR, RATE, { toneHz: [853, 960] }), RATE), RATE);
  eq(tones(out).length, 1, 'the EAS dual tone is reported once');
  eq(tones(out)[0]?.raw, '853+960 Hz', 'as 853+960 Hz');
}
{
  const out = decode(discriminate(transmission(HDR, RATE, { toneSec: 0 }), RATE), RATE);
  eq(tones(out).length, 0, 'no tone event when no tone was sent: the AFSK bursts do not look like one');
}
{
  const out = decode(discriminate(concat([tone([1050], 0.3, RATE), silence(2, RATE)]), RATE), RATE);
  eq(tones(out).length, 0, 'a 300 ms blip at 1050 Hz is not an attention tone');
}
{
  const out = decode(discriminate(concat([tone([1400], 8, RATE), silence(2, RATE)]), RATE), RATE);
  eq(tones(out).length, 0, 'a steady tone at another frequency is not reported');
}
{
  // The EAS signal is the pair; either tone on its own is just a tone.
  const out = decode(discriminate(concat([tone([853], 8, RATE), silence(2, RATE)]), RATE), RATE);
  eq(tones(out).length, 0, '853 Hz alone is not the EAS attention signal');
  const out2 = decode(discriminate(concat([tone([960], 8, RATE), silence(2, RATE)]), RATE), RATE);
  eq(tones(out2).length, 0, 'nor is 960 Hz alone');
}

// ---- Reset ----
{
  const out = [];
  const d = new SameDecoder(m => out.push(m));
  d.reset(RATE);
  const disc = discriminate(transmission(HDR, RATE, { toneSec: 0, eom: false }), RATE);
  d.onFm(disc, disc.length, RATE);
  d.reset(RATE);
  const disc2 = discriminate(transmission(HDR.replace('TOR', 'SVR'), RATE, { toneSec: 0, eom: false }), RATE);
  d.onFm(disc2, disc2.length, RATE);
  eq(headers(out).length, 2, 'a decoder keeps working after reset');
  eq(headers(out)[1]?.header?.event, 'SVR', 'and decodes the new message');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
