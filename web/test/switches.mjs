/**
 * Mains switches, doorbells and cheap OOK remotes: eleven protocols with almost no integrity checks between
 * them, which changes what a test has to do.
 *
 * Where there is a checksum, a frame that decodes is largely self-proving. Here there is nearly nothing to
 * verify against, so every frame is built from the transmit side — the encoder pins laid out as the chip sends
 * them, then packed into the wire's bit order — and the rejections matter more than the acceptances. A decoder
 * that accepts its own frame proves very little when the only thing it checks is a bit pattern; what has to be
 * shown is that it refuses everything nearby.
 *
 * Two pieces of real evidence anchor the batch. RF-tech ships six captured frames, one of them documented as
 * taken with fresh batteries and the button held — and the two flag bits in that frame are exactly the ones
 * that say so, which pins the whole upper byte independently. Elro publishes one example code. Everything else
 * is constructed.
 *
 * Three cross-protocol facts are asserted rather than smoothed over, because all three are properties of the
 * products and not of this port:
 *
 *   - KlikAanKlikUit (15), Nexa (96) and Proove (51) all decode the same clean frame, and all three are right.
 *   - Blyss (58) and Elro (62) both claim a Blyss transmission.
 *   - Waveman (4) claims a slice of Brennenstuhl (24) traffic. Upstream guards against one specific Brennenstuhl
 *     frame; the real overlap is elsewhere and is measured here exactly.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

const bytesToBits = (bytes) => {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
};
const bitsFromHex = (hex, n) => {
  const bits = [];
  for (const ch of hex.replace(/[^0-9a-fA-F]/g, '')) { const v = parseInt(ch, 16); for (let i = 3; i >= 0; i--) bits.push((v >> i) & 1); }
  return n === undefined ? bits : bits.slice(0, n);
};
const bitsFromBinary = (s) => [...s.replace(/[^01]/g, '')].map(Number);

const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
const rowsOf = (rows) => {
  const bb = new BitBuffer();
  rows.forEach((bits, i) => { if (i) bb.addRow(); for (const v of bits) bb.addBit(v); });
  return bb;
};
/** A row preceded by sync marks, which is what the ternary switches key off. */
const syncRowOf = (bits, syncs = 1) => {
  const bb = new BitBuffer();
  for (let i = 0; i < syncs; i++) bb.addSync();
  for (const v of bits) bb.addBit(v);
  return bb;
};
/** Our Manchester decoder emits the second half of each pair, so a one is sent as (0,1). */
const manchester = (bits) => { const out = []; for (const b of bits) out.push(b ^ 1, b); return out; };

console.log('Switches, doorbells and OOK remotes');

// ---------------------------------------------------------------------------
// Waveman (4)
// ---------------------------------------------------------------------------

/**
 * Build a Waveman frame from the three nibbles the encoder is strapped to.
 *
 * Each nibble goes out bit-reversed and inverted: weight 1 lands on mask 0x40, weight 8 on mask 0x01, and a
 * set bit means the pin is *not* pulled. The bits between them are all ones, which is the frame's only
 * structural check.
 */
const wavemanByte = (nb) => 0xaa
  | ((nb & 0x01) ? 0 : 0x40)
  | ((nb & 0x02) ? 0 : 0x10)
  | ((nb & 0x04) ? 0 : 0x04)
  | ((nb & 0x08) ? 0 : 0x01);
const wavemanBits = (nb0, nb1, nb2) =>
  [...bytesToBits([wavemanByte(nb0), wavemanByte(nb1), wavemanByte(nb2)]), 1];

{
  const d = dev(4);
  const frame = (a, b, c) => rowOf(wavemanBits(a, b, c));

  // The 0xaa structure is the premise every rejection below rests on: these frames are well formed.
  {
    const bytes = [wavemanByte(0), wavemanByte(9), wavemanByte(0xe)];
    ok(bytes.every(v => (v & 0xaa) === 0xaa), 'a built Waveman frame really has every other bit set (premise)');
  }

  const on = run(d, frame(0, 9, 0xe));
  eq(on.length, 1, 'Waveman decodes a well-formed frame');
  eq(on[0]?.model, 'Waveman-Switch', '  Waveman model');
  eq(on[0]?.id, 'A', '  Waveman house letter A for nibble zero');
  eq(on[0]?.channel, 3, '  Waveman channel is the top half of the middle nibble');
  eq(on[0]?.button, 2, '  Waveman button is the bottom half');
  eq(on[0]?.state, 'ON', '  Waveman ON state');
  ok(on[0]?.mic === undefined, '  Waveman claims no integrity check, having none');

  eq(run(d, frame(15, 0, 6))[0]?.id, 'P', 'Waveman house letter P for nibble fifteen');
  eq(run(d, frame(15, 0, 6))[0]?.state, 'OFF', '  and the OFF state');
  eq(run(d, frame(0, 15, 0xe))[0]?.channel, 4, 'Waveman highest channel');
  eq(run(d, frame(0, 15, 0xe))[0]?.button, 4, '  and highest button');

  /*
   * The plausibility test on the state nibble. Before it existed, fourteen of these sixteen frames decoded and
   * were reported as "OFF" — so this is the difference between reading a switch and inventing one. Each frame
   * is otherwise perfectly formed, which the premise above establishes.
   */
  {
    let accepted = 0;
    for (let nb2 = 0; nb2 < 16; nb2++) if (run(d, frame(3, 5, nb2)).length) accepted++;
    eq(accepted, 2, 'Waveman accepts exactly two of the sixteen possible state nibbles');
  }

  /*
   * The all-ones frame, and a piece of upstream archaeology worth pinning rather than papering over.
   *
   * Waveman carries an explicit special case for a frame of all ones, added because other transmitters send
   * one — the comment names the Brennenstuhl. That guard is now dead code: an all-ones frame drives every
   * nibble to zero, and the state-nibble test added later refuses a zero state on its own. Deleting the guard
   * and re-running this file leaves it green, which is how the redundancy was established rather than guessed.
   *
   * So what is asserted below is deliberately not "the guard works" — it cannot be, with two rules refusing the
   * same frame. It is *why* each of them refuses it, so the guard is not mistaken for load-bearing later. The
   * port keeps it because upstream has it.
   */
  {
    const allOnes = new Array(25).fill(1);
    ok((0xff & 0xaa) === 0xaa, 'an all-ones frame passes the structural test, which is why a guard was added');
    const nb2 = ((0xff & 0x40) ? 0 : 1) | ((0xff & 0x10) ? 0 : 2) | ((0xff & 0x04) ? 0 : 4) | ((0xff & 0x01) ? 0 : 8);
    eq(nb2, 0, '  but it also drives the state nibble to zero, which the later plausibility test refuses');
    eq(run(d, rowOf(allOnes)).length, 0, '  so Waveman refuses it, and either rule alone would be enough');
  }

  // Length, and a single even bit knocked out.
  eq(run(d, rowOf(wavemanBits(0, 9, 0xe).slice(0, 24))).length, 0, 'Waveman refuses a 24-bit row');
  eq(run(d, rowOf([...wavemanBits(0, 9, 0xe), 0])).length, 0, 'Waveman refuses a 26-bit row');
  {
    const bits = wavemanBits(0, 9, 0xe);
    ok(bits[8] === 1, 'the bit about to be cleared really is one of the structural ones (premise)');
    bits[8] = 0;
    eq(run(d, rowOf(bits)).length, 0, 'Waveman refuses a frame missing one of its structural bits');
  }
}

// ---------------------------------------------------------------------------
// Brennenstuhl RCS 2044 (24), and what it shares with the Waveman
// ---------------------------------------------------------------------------

/**
 * Build an RCS 2044 frame from the address switches, the key bit and the ON/OFF column.
 *
 * The twelve settings are spread across the odd bit positions in no tidy order, so this places each one by the
 * mask the decoder reads it from rather than by shifting a word into place.
 */
const brennenstuhlBits = (systemCode, controlKey, onOff, lastByte = 0x80) => {
  let b0 = 0xaa, b1 = 0xaa, b2 = 0xaa;
  if (systemCode & 0x10) b0 |= 0x40;
  if (systemCode & 0x08) b0 |= 0x10;
  if (systemCode & 0x04) b0 |= 0x04;
  if (systemCode & 0x02) b0 |= 0x01;
  if (systemCode & 0x01) b1 |= 0x40;
  if (controlKey & 0x10) b1 |= 0x10;
  if (controlKey & 0x08) b1 |= 0x04;
  if (controlKey & 0x04) b1 |= 0x01;
  if (controlKey & 0x02) b2 |= 0x40;
  if (controlKey & 0x01) b2 |= 0x10;
  if (onOff & 0x02) b2 |= 0x04;
  if (onOff & 0x01) b2 |= 0x01;
  return { bytes: [b0, b1, b2], bits: [...bytesToBits([b0, b1, b2]), lastByte === 0x80 ? 1 : 0] };
};

{
  const d = dev(24);
  const frame = (sc, ck, oo, last) => rowOf(brennenstuhlBits(sc, ck, oo, last).bits);

  const out = run(d, frame(22, 0x10, 0x02));
  eq(out.length, 1, 'Brennenstuhl decodes a well-formed frame');
  eq(out[0]?.model, 'Brennenstuhl-RCS2044', '  Brennenstuhl model');
  eq(out[0]?.id, 22, '  Brennenstuhl address switches');
  eq(out[0]?.key, 'A', '  Brennenstuhl key A');
  eq(out[0]?.state, 'ON', '  Brennenstuhl ON state');

  // Every address the five switches can be set to survives the round trip.
  {
    let wrong = 0;
    for (let sc = 0; sc < 32; sc++) if (run(d, frame(sc, 0x08, 0x01))[0]?.id !== sc) wrong++;
    eq(wrong, 0, 'Brennenstuhl reads all thirty-two address settings back correctly');
  }

  for (const [ck, key] of [[0x10, 'A'], [0x08, 'B'], [0x04, 'C'], [0x02, 'D'], [0x01, 'E']]) {
    eq(run(d, frame(7, ck, 0x01))[0]?.key, key, `Brennenstuhl key ${key}`);
  }
  eq(run(d, frame(7, 0x04, 0x01))[0]?.state, 'OFF', 'Brennenstuhl OFF state');

  /*
   * The only thing resembling an integrity check this protocol has: since each button owns a bit, a frame
   * naming two of them is far more likely to be noise than a command. Each rejection is paired with the
   * single-key frame it was derived from, so the refusal is the rule and not a malformed frame.
   */
  eq(run(d, frame(7, 0x10, 0x02)).length, 1, 'the single-key frame decodes (premise for the multi-key rules)');
  eq(run(d, frame(7, 0x18, 0x02)).length, 0, 'Brennenstuhl refuses two keys held at once');
  eq(run(d, frame(7, 0x1f, 0x02)).length, 0, '  and refuses every key at once');
  eq(run(d, frame(7, 0x00, 0x02)).length, 0, '  and refuses a frame naming no key at all');
  eq(run(d, frame(7, 0x10, 0x03)).length, 0, 'Brennenstuhl refuses ON and OFF together');
  eq(run(d, frame(7, 0x10, 0x00)).length, 0, '  and refuses neither column');

  // The closing bit, and the length.
  eq(run(d, frame(7, 0x10, 0x02, 0x00)).length, 0, 'Brennenstuhl refuses a frame whose closing bit is clear');
  eq(run(d, rowOf(brennenstuhlBits(7, 0x10, 0x02).bits.slice(0, 24))).length, 0,
    'Brennenstuhl refuses a 24-bit row');

  // It walks every row and counts them, unlike most of this family.
  {
    const two = rowsOf([brennenstuhlBits(7, 0x10, 0x02).bits, brennenstuhlBits(9, 0x04, 0x01).bits]);
    const both = run(d, two);
    eq(both.length, 2, 'Brennenstuhl reports every good row in a burst');
    eq(both[1]?.key, 'C', '  including the second one');
  }
  // A junk row alongside a good one must not stop the good one being read.
  eq(run(d, rowsOf([new Array(25).fill(0), brennenstuhlBits(7, 0x10, 0x02).bits])).length, 1,
    'Brennenstuhl skips a junk row and reads the good one behind it');
}

{
  /*
   * Where Waveman and Brennenstuhl genuinely collide.
   *
   * Upstream's Waveman guards against one specific Brennenstuhl-shaped frame, the all-ones one. That is not
   * where the overlap actually is: every valid RCS 2044 command passes Waveman's structural test, because the
   * two protocols use the same 0xaa bit pattern. What separates them is the state-nibble check — and it does
   * not separate them completely. The exact residue is measured rather than asserted by eye.
   */
  const waveman = dev(4);
  let structural = 0, claimed = 0, claimedNotKeyD = 0, claimedNotOff = 0;
  const keys = [[0x10, 'A'], [0x08, 'B'], [0x04, 'C'], [0x02, 'D'], [0x01, 'E']];

  for (let sc = 0; sc < 32; sc++) {
    for (const [ck, key] of keys) {
      for (const oo of [0x02, 0x01]) {
        const { bytes, bits } = brennenstuhlBits(sc, ck, oo);
        if (bytes.every(v => (v & 0xaa) === 0xaa)) structural++;
        const got = run(waveman, rowOf(bits));
        if (got.length) {
          claimed++;
          if (key !== 'D') claimedNotKeyD++;
          if (oo !== 0x01) claimedNotOff++;
        }
      }
    }
  }

  eq(structural, 320, 'every one of the 320 Brennenstuhl commands passes Waveman\'s structural test (premise)');
  eq(claimed, 32, '  and Waveman still claims exactly 32 of them');
  eq(claimedNotKeyD, 0, '  all of which are key D');
  eq(claimedNotOff, 0, '  and all of which are the OFF column');
  // The 288 it refuses are refused by the state nibble, which is the check upstream added.
  eq(320 - claimed, 288, '  leaving 288 refused by the state-nibble test alone');
}

// ---------------------------------------------------------------------------
// The ternary family: KlikAanKlikUit (15), Nexa (96), and Proove (51) alongside them
// ---------------------------------------------------------------------------

/**
 * Build a ternary frame from its payload bits.
 *
 * A data bit goes out as a pair: the bit, then its complement. Our Manchester decoder keeps the second half and
 * the decoders invert afterwards, so that round trips. `dimAt` replaces one pair with the third symbol — two
 * ones — which is the pair the Manchester decoder cannot represent and which means "dim".
 */
const ternaryBits = (dataBits, dimAt = -1) => {
  const out = [];
  dataBits.forEach((d, i) => { if (i === dimAt) out.push(1, 1); else out.push(d, d ^ 1); });
  return out;
};

{
  const kaku = dev(15), nx = dev(96), proove = dev(51);

  // b3 is packed so every field it carries is distinguishable: id low bits 11, group 1, on 1, channel 01,
  // unit 10. The channel and unit are stored inverted, which is the one place Nexa and KlikAanKlikUit differ.
  const B = [0x12, 0x34, 0x56, 0xf6];
  const data = bytesToBits(B);
  const wire = ternaryBits(data);
  eq(wire.length, 64, 'a 32-bit payload makes a 64-bit ternary row (premise)');

  const k = run(kaku, syncRowOf(wire));
  eq(k.length, 1, 'KlikAanKlikUit decodes a well-formed frame');
  eq(k[0]?.model, 'KlikAanKlikUit-Switch', '  KlikAanKlikUit model');
  eq(k[0]?.id, 4772187, '  KlikAanKlikUit 26-bit address');
  eq(k[0]?.unit, 6, '  KlikAanKlikUit unit is the low nibble, uninverted');
  eq(k[0]?.group_call, 'Yes', '  KlikAanKlikUit group call');
  eq(k[0]?.command, 'On', '  KlikAanKlikUit command');
  eq(k[0]?.dim, 'No', '  and no dim on an ordinary frame');
  eq(k[0]?.dim_value, 0, '  with no dim level either');

  const n = run(nx, syncRowOf(wire));
  eq(n.length, 1, 'Nexa decodes the same frame');
  eq(n[0]?.model, 'Nexa-Security', '  Nexa model');
  eq(n[0]?.id, 4772187, '  Nexa reads the same address');
  eq(n[0]?.channel, 2, '  Nexa channel, stored inverted');
  eq(n[0]?.unit, 1, '  Nexa unit, likewise');
  eq(n[0]?.state, 'ON', '  Nexa state');
  eq(n[0]?.group, 1, '  Nexa group bit');

  /*
   * The triple decode, pinned. These are one Scandinavian design sold under three names, and on a clean frame
   * all three decoders are correct. Upstream registers the three with no priority between them; nothing in the
   * bits justifies one, so neither does this port.
   */
  {
    const p = run(proove, syncRowOf(wire));
    eq(p.length, 1, 'Proove decodes it as well: three decoders, one transmission');
    eq(p[0]?.id, n[0]?.id, '  and Proove and Nexa agree on the address');
    eq(p[0]?.channel, n[0]?.channel, '  and on the channel');
    eq(p[0]?.state, n[0]?.state, '  and on the state');
  }

  // Seventy-two bits: thirty-six payload bits, the last four a dim level.
  {
    const long = ternaryBits([...data, 1, 0, 1, 1]);
    eq(long.length, 72, 'a 36-bit payload makes a 72-bit row (premise)');
    eq(run(kaku, syncRowOf(long)).length, 1, 'KlikAanKlikUit takes a 72-bit row');
    eq(run(nx, syncRowOf(long)).length, 1, '  and so does Nexa');
    eq(run(proove, syncRowOf(long)).length, 0, '  while Proove takes only 64, which is how the three differ');
  }

  /*
   * Dimming. The command pair becomes the third symbol, which the Manchester decoder stops dead on — so
   * KlikAanKlikUit rewrites it to ON before decoding and remembers that it did. The other two have no such
   * step and must refuse the frame; that they do is the premise for the rewrite being necessary at all.
   */
  {
    const dimWire = ternaryBits(data, 27);           // data bit 27 is the command bit
    eq(dimWire.length, 64, 'the dim frame is still 64 bits (premise)');
    ok(dimWire[54] === 1 && dimWire[55] === 1, '  and its command pair really is the third symbol (premise)');

    const dk = run(kaku, syncRowOf(dimWire));
    eq(dk.length, 1, 'KlikAanKlikUit decodes a dim command');
    eq(dk[0]?.dim, 'Yes', '  and says it was a dim');
    eq(dk[0]?.command, 'On', '  reporting it as ON, which is what the rewrite makes it');
    eq(dk[0]?.id, 4772187, '  with the address unharmed');
    eq(dk[0]?.dim_value, 0, '  and no level, this frame being too short to carry one');

    eq(run(nx, syncRowOf(dimWire)).length, 0, 'Nexa refuses a dim frame, having no rewrite');
    eq(run(proove, syncRowOf(dimWire)).length, 0, '  and so does Proove');

    // With four more bits the level is real, which shows dim_value is read rather than defaulted.
    const dimLong = ternaryBits([...data, 1, 0, 1, 1], 27);
    const dl = run(kaku, syncRowOf(dimLong));
    eq(dl.length, 1, 'KlikAanKlikUit decodes a 72-bit dim command');
    eq(dl[0]?.dim_value, 0b1011, '  and reads the level out of the extra nibble');
  }

  // The rewrite must not reach the shared buffer: in rtl_433 it does, and the next decoder sees it.
  {
    const bb = syncRowOf(ternaryBits(data, 27));
    const before = Uint8Array.from(bb.bb[0].subarray(0, 16));
    run(kaku, bb);
    ok(before.every((v, i) => v === bb.bb[0][i]),
      'the dim rewrite leaves the shared buffer untouched, unlike upstream');
  }

  // Exactly one sync mark, and an exact length.
  eq(run(kaku, rowOf(wire)).length, 0, 'KlikAanKlikUit refuses a row with no sync mark');
  eq(run(kaku, syncRowOf(wire, 2)).length, 0, '  and refuses two sync marks');
  eq(run(nx, rowOf(wire)).length, 0, 'Nexa refuses a row with no sync mark');
  eq(run(kaku, syncRowOf(wire.slice(0, 62))).length, 0, 'KlikAanKlikUit refuses a 62-bit row');
  eq(run(kaku, syncRowOf([...wire, 0, 0])).length, 0, '  and a 66-bit row');

  // A coding violation part way in: the row is still the right length, so length is not what refuses it.
  {
    const broken = [...wire];
    ok(broken[20] !== broken[21], 'the pair about to be broken is a legal one (premise)');
    broken[21] = broken[20];
    eq(broken.length, 64, '  and breaking it leaves the row 64 bits long (premise)');
    eq(run(kaku, syncRowOf(broken)).length, 0, 'KlikAanKlikUit refuses a frame with a coding violation');
    eq(run(nx, syncRowOf(broken)).length, 0, '  and so does Nexa');
  }
}

// ---------------------------------------------------------------------------
// HT680 (46)
// ---------------------------------------------------------------------------

/** Five sync bits then thirty-six payload bits, the payload given as the five bytes the encoder strapped. */
const ht680Bits = (payload, sync = [1, 0, 1, 0, 1]) => [...sync, ...bytesToBits(payload).slice(0, 36)];

{
  const d = dev(46);
  // The four pins every HT680 leaves open are set correctly here: b1 top nibble a, b2 bits 0x0c = 08,
  // b3 bits 0x30 = 20, b4 top nibble a.
  const GOOD = [0x3c, 0xa5, 0xdb, 0xe3, 0xa0];

  const out = run(d, rowOf(ht680Bits(GOOD)));
  eq(out.length, 1, 'HT680 decodes a well-formed frame');
  eq(out[0]?.model, 'HT680-Remote', '  HT680 model');
  eq(out[0]?.id, '0x03CA5D', '  HT680 twenty-bit address');
  eq(out[0]?.tristate, '0110ZZXX1XZ11Z01ZZ', '  HT680 tri-state string, eighteen pins');
  eq(out[0]?.tristate.length, 18, '  and it is eighteen symbols, not the twenty the buffer holds');
  eq(out[0]?.button1, 'PRESSED', '  HT680 button 1');
  eq(out[0]?.button2, '', '  HT680 button 2 is not down');
  eq(out[0]?.button3, 'PRESSED', '  HT680 button 3');
  eq(out[0]?.button4, 'PRESSED', '  HT680 button 4');
  ok(out[0]?.mic === undefined, '  HT680 claims no integrity check, having none');

  // Only "11" counts as a press; the floating and invalid pairs must not.
  for (const [v, label] of [[0, 'grounded'], [1, 'invalid'], [2, 'floating']]) {
    const p = [...GOOD]; p[3] = (GOOD[3] & 0xfc) | v;
    eq(run(d, rowOf(ht680Bits(p)))[0]?.button1, '', `HT680 does not call a ${label} pin a press`);
  }

  /*
   * The four fixed pins, broken one at a time. Upstream once joined these with `&&`, so a row was refused only
   * when all four failed together; breaking them individually is the only way to notice that. Each case is
   * paired with the premise that the frame is otherwise the one that just decoded.
   */
  const breaks = [
    [1, 0x10, 'A4/A5'],
    [2, 0x04, 'AD10'],
    [3, 0x10, 'AD13'],
    [4, 0x10, 'AD16/AD17'],
  ];
  for (const [idx, bit, label] of breaks) {
    const p = [...GOOD]; p[idx] ^= bit;
    ok(p[idx] !== GOOD[idx], `the ${label} frame really differs from the good one (premise)`);
    eq(run(d, rowOf(ht680Bits(p))).length, 0, `HT680 refuses a frame whose ${label} pin is not open`);
  }

  // Length and sync.
  eq(run(d, rowOf(ht680Bits(GOOD).slice(0, 40))).length, 0, 'HT680 refuses a 40-bit row');
  eq(run(d, rowOf([...ht680Bits(GOOD), 0])).length, 0, '  and a 42-bit row');
  eq(run(d, rowOf(ht680Bits(GOOD, [0, 0, 1, 0, 1]))).length, 0, 'HT680 refuses a frame with the wrong sync');

  // It reports the first good row and stops, so a junk row ahead of it must not hide it.
  {
    const two = rowsOf([new Array(41).fill(0), ht680Bits(GOOD)]);
    eq(run(d, two).length, 1, 'HT680 finds a good row behind a junk one');
  }
}

// ---------------------------------------------------------------------------
// Akhan 100F14 (48)
// ---------------------------------------------------------------------------

/** The frame goes out complemented, so the transmit side builds the bytes and inverts them. */
const akhanBits = (id, cmd, lastBit = 0) => {
  const b = [(id >> 12) & 0xff, (id >> 4) & 0xff, ((id & 0x0f) << 4) | (cmd & 0x0f)];
  return [...bytesToBits(b.map(v => ~v & 0xff)), lastBit];
};

{
  const d = dev(48);
  const out = run(d, rowOf(akhanBits(0xabcde, 0x2)));
  eq(out.length, 1, 'Akhan decodes a well-formed frame');
  eq(out[0]?.model, 'Akhan-100F14', '  Akhan model');
  eq(out[0]?.id, '0xabcde', '  Akhan twenty-bit identity');
  eq(out[0]?.data, '0x2 (Unlock)', '  Akhan unlock command');
  ok(out[0]?.mic === undefined, '  Akhan claims no integrity check, having none');

  for (const [cmd, str] of [[0x1, '0x1 (Lock)'], [0x2, '0x2 (Unlock)'], [0x4, '0x4 (Mute)'], [0x8, '0x8 (Alarm)']]) {
    eq(run(d, rowOf(akhanBits(0x12345, cmd)))[0]?.data, str, `Akhan reads command ${str}`);
  }

  /*
   * The command is one-hot, so twelve of the sixteen nibbles cannot occur and a frame carrying one is thrown
   * away rather than reported with an unknown command. That is the whole of this protocol's defense.
   */
  {
    let accepted = 0;
    for (let cmd = 0; cmd < 16; cmd++) if (run(d, rowOf(akhanBits(0xabcde, cmd))).length) accepted++;
    eq(accepted, 4, 'Akhan accepts exactly the four one-hot commands');
    eq(run(d, rowOf(akhanBits(0xabcde, 0x3))).length, 0, '  and refuses two buttons at once rather than guessing');
  }

  // The identity really is read from the complemented bits, not the raw ones.
  eq(run(d, rowOf(akhanBits(0x00001, 0x1)))[0]?.id, '0x1', 'Akhan reads a near-zero identity');
  eq(run(d, rowOf(akhanBits(0xfffff, 0x8)))[0]?.id, '0xfffff', '  and an all-ones one');

  eq(run(d, rowOf(akhanBits(0xabcde, 0x2).slice(0, 24))).length, 0, 'Akhan refuses a 24-bit row');
  eq(run(d, rowOf([...akhanBits(0xabcde, 0x2), 0])).length, 0, '  and a 26-bit row');
}

// ---------------------------------------------------------------------------
// Quhwa (49)
// ---------------------------------------------------------------------------

/** Eighteen bits, sent complemented: two whole bytes and two more bits that must both read as ones. */
const quhwaBits = (b0, b1, tail = [0, 0]) => [...bytesToBits([~b0 & 0xff, ~b1 & 0xff]), ...tail];
const repeat = (bits, n) => rowsOf(new Array(n).fill(bits));

{
  const d = dev(49);
  const GOOD = quhwaBits(0x9c, 0x53);
  eq(GOOD.length, 18, 'a Quhwa frame is eighteen bits (premise)');

  const out = run(d, repeat(GOOD, 5));
  eq(out.length, 1, 'Quhwa decodes five matching rows');
  eq(out[0]?.model, 'Quhwa-Doorbell', '  Quhwa model');
  eq(out[0]?.id, 0x9c53, '  Quhwa identity');
  ok(out[0]?.mic === undefined, '  Quhwa claims no integrity check, having none');

  /*
   * Repetition is the whole integrity story, so the count matters. The premise is checked directly against the
   * bit buffer: four rows really are four matching rows, they are simply one short of what will be believed.
   */
  {
    const four = repeat(GOOD, 4);
    eq(four.numRows, 4, 'four rows really are present (premise)');
    eq(four.findRepeatedRow(4, 18), 0, '  and they do all match each other (premise)');
    eq(four.findRepeatedRow(5, 18), -1, '  but five of them are not (premise)');
    eq(run(d, four).length, 0, 'Quhwa refuses four repeats where five are required');
  }
  eq(run(d, repeat(GOOD, 14)).length, 1, 'Quhwa accepts a longer burst');

  // Rows that disagree are not repeats at all.
  eq(run(d, rowsOf([GOOD, quhwaBits(0x9c, 0x57), GOOD, GOOD, GOOD])).length, 0,
    'Quhwa refuses a burst whose rows disagree');

  /*
   * Silence read as data. The all-zero test runs before the complement, so what it catches is a wire carrying
   * all ones — and the all-zero wire, which is the other half of the same failure, is caught by the constant
   * fields instead. Both are checked, since they take different paths through the decoder.
   */
  {
    const allOnes = repeat(new Array(18).fill(1), 5);
    eq(allOnes.findRepeatedRow(5, 18), 0, 'the all-ones burst is five matching rows (premise)');
    eq(run(d, allOnes).length, 0, 'Quhwa refuses an all-ones wire');

    const allZero = repeat(new Array(18).fill(0), 5);
    eq(allZero.findRepeatedRow(5, 18), 0, 'the all-zero burst is five matching rows too (premise)');
    eq(run(d, allZero).length, 0, '  and Quhwa refuses an all-zero wire as well');
  }

  // The four constant bits, broken one field at a time.
  {
    eq(run(d, repeat(quhwaBits(0x9c, 0x51), 5)).length, 0, 'Quhwa refuses a frame whose low constant pair is wrong');
    eq(run(d, repeat(quhwaBits(0x9c, 0x53, [1, 0]), 5)).length, 0, '  and one whose trailing pair is wrong');
    eq(run(d, repeat(quhwaBits(0x9c, 0x53, [0, 1]), 5)).length, 0, '  in either bit');
  }

  // A twenty-bit row is found as a repeat and then refused on its length.
  {
    const long = repeat([...GOOD, 0, 0], 5);
    eq(long.findRepeatedRow(5, 18), 0, 'a 20-bit burst is still found as a repeat (premise)');
    eq(run(d, long).length, 0, 'Quhwa refuses it on its length');
  }
}

// ---------------------------------------------------------------------------
// Blyss (58) and Elro DB286A (62): the same frame, two decoders
// ---------------------------------------------------------------------------

{
  const blyss = dev(58), elro = dev(62);
  const CODE_A = bitsFromHex('ce8e2a6c80', 33);
  const CODE_B = bitsFromHex('e7377a2c80', 33);
  const ELRO_EXAMPLE = bitsFromHex('37f62a6c80', 33);   // the one code rtl_433 publishes for the Elro

  eq(CODE_A.length, 33, 'a Blyss frame is thirty-three bits (premise)');
  ok(CODE_A.join('') !== CODE_B.join(''), 'the two Blyss codes really are different (premise)');

  const a = run(blyss, rowOf(CODE_A));
  eq(a.length, 1, 'Blyss decodes its first known handset');
  eq(a[0]?.model, 'Blyss-DC5ukwh', '  Blyss model');
  eq(a[0]?.id, 'ce8e2a6c', '  Blyss identity, the trailing bit dropped');
  eq(run(blyss, rowOf(CODE_B))[0]?.id, 'e7377a2c', 'Blyss decodes its second known handset');

  // It recognizes those two and nothing else, which is exactly what upstream claims for it.
  eq(run(blyss, rowOf(ELRO_EXAMPLE)).length, 0, 'Blyss refuses a 33-bit code it does not know');
  /*
   * The 32-bit row. Upstream tests the length before matching the code, but the two cannot disagree: the code
   * table's fifth byte is 0x80, which *is* the thirty-third bit, so a truncated row reads byte four as zero and
   * can never match. Loosening the length test leaves the decoder behaving identically — established by doing
   * exactly that and watching this file stay green. The reason is asserted alongside the refusal so this does
   * not read as the length test doing work it is not doing.
   */
  {
    const truncated = rowOf(CODE_A.slice(0, 32));
    eq(truncated.bb[0][4], 0x00, 'a 32-bit row reads its fifth byte as zero, not the 0x80 the code table wants');
    eq(run(blyss, truncated).length, 0, '  so Blyss refuses it, on the code match as much as on the length');
  }
  {
    const near = [...CODE_A];
    ok(near[7] === 0, 'the bit about to be flipped is clear in the real code (premise)');
    near[7] = 1;
    eq(run(blyss, rowOf(near)).length, 0, 'Blyss refuses a code one bit away from one it knows');
  }
  // The last row of a burst is 32 bits; the good one behind it must still be found.
  eq(run(blyss, rowsOf([CODE_A.slice(0, 32), CODE_A])).length, 1, 'Blyss looks past a short row for a good one');

  const e = run(elro, repeat(ELRO_EXAMPLE, 5));
  eq(e.length, 1, 'Elro decodes the code rtl_433 publishes for it');
  eq(e[0]?.model, 'Elro-DB286A', '  Elro model');
  eq(e[0]?.id, '37f62a6c', '  Elro identity from the published example');
  ok(e[0]?.mic === undefined, '  Elro claims no integrity check, having none');

  eq(run(elro, repeat(ELRO_EXAMPLE, 4)).length, 0, 'Elro refuses four repeats where five are required');
  eq(run(elro, repeat(ELRO_EXAMPLE.slice(0, 32), 5)).length, 0, 'Elro refuses 32-bit rows');
  eq(run(elro, rowsOf([ELRO_EXAMPLE, CODE_A, ELRO_EXAMPLE, ELRO_EXAMPLE, ELRO_EXAMPLE])).length, 0,
    'Elro refuses a burst whose rows disagree');

  /*
   * The overlap, pinned. Elro checks nothing but length and repetition, so it claims the Blyss codes too —
   * both decoders fire on one transmission and both are behaving as their authors wrote them. Upstream ships
   * the Elro switched off, which is precisely what marks its reading as the doubtful one; the flags are
   * asserted alongside the overlap so the pair is read together.
   */
  {
    const burst = repeat(CODE_A, 5);
    const fromBlyss = run(blyss, burst);
    const fromElro = run(elro, burst);
    eq(fromBlyss.length, 1, 'a Blyss burst decodes as Blyss');
    eq(fromElro.length, 1, '  and as an Elro doorbell at the same time');
    eq(fromElro[0]?.id, fromBlyss[0]?.id, '  reporting the same bytes under a different name');
    ok(elro.disabled === true, '  the Elro being the one upstream marks doubtful');
    ok(!blyss.disabled, '  while the Blyss, which matches a literal code, is not');
  }
}

// ---------------------------------------------------------------------------
// RF-tech / INFRA 217S34 (72): six captures rtl_433 ships
// ---------------------------------------------------------------------------

{
  const d = dev(72);
  const three = (bits) => repeat(bits, 3);

  // The first is published as binary, the rest as spaced hex. Both forms are read straight from the file.
  const CAPTURES = [
    { bits: bitsFromBinary('01001001 00011010 00000100'), id: 0x49, tenths: 264, batt: 0, btn: 0 },
    { bits: bitsFromHex('ad1809', 24), id: 0xad, tenths: 249, batt: 0, btn: 0 },
    { bits: bitsFromHex('3e1709', 24), id: 0x3e, tenths: 239, batt: 0, btn: 0 },
    { bits: bitsFromHex('701703', 24), id: 0x70, tenths: 233, batt: 0, btn: 0 },
    { bits: bitsFromHex('091701', 24), id: 0x09, tenths: 231, batt: 0, btn: 0 },
    { bits: bitsFromHex('c516c5', 24), id: 0xc5, tenths: 225, batt: 1, btn: 1 },
  ];

  CAPTURES.forEach((c, i) => {
    const out = run(d, three(c.bits));
    eq(out.length, 1, `RF-tech decodes capture ${i + 1}`);
    eq(out[0]?.model, 'RF-tech', `  capture ${i + 1} model`);
    eq(out[0]?.id, c.id, `  capture ${i + 1} sensor id`);
    eq(Math.round(out[0]?.temperature_C * 10), c.tenths, `  capture ${i + 1} temperature`);
    eq(out[0]?.battery_ok, c.batt, `  capture ${i + 1} battery`);
    eq(out[0]?.button, c.btn, `  capture ${i + 1} button`);
  });

  /*
   * The strongest evidence in this file. rtl_433 documents the last capture as taken with fresh batteries and
   * the button held, and it is the only one of the six with either flag — so the two bits in the upper byte
   * are pinned by something outside the code, rather than by reading the code back to itself.
   */
  {
    const flagged = CAPTURES.filter(c => c.batt || c.btn);
    eq(flagged.length, 1, 'exactly one of the six captures carries a flag (premise)');
    eq(flagged[0].id, 0xc5, '  and it is the one documented as fresh batteries with the button held');
  }

  // The sign bit, which none of the captures exercises.
  {
    const cold = run(d, three(bitsFromHex('499a04', 24)));
    eq(Math.round(cold[0]?.temperature_C * 10), -264, 'RF-tech reads a negative temperature');
    eq(cold[0]?.id, 0x49, '  without disturbing the identity');
    eq(run(d, three(bitsFromHex('491a04', 24)))[0]?.temperature_C > 0, true,
      '  and the same frame without the sign bit is positive (premise)');
  }

  // Three repeats, not two.
  {
    const two = repeat(bitsFromHex('ad1809', 24), 2);
    eq(two.findRepeatedRow(2, 24), 0, 'two rows really do match each other (premise)');
    eq(two.findRepeatedRow(3, 24), -1, '  but three of them are not present (premise)');
    eq(run(d, two).length, 0, 'RF-tech refuses two repeats where three are required');
  }
  // A 25-bit burst is found as a repeat and then refused on its length.
  {
    const long = repeat([...bitsFromHex('ad1809', 24), 0], 3);
    eq(long.findRepeatedRow(3, 24), 0, 'a 25-bit burst is still found as a repeat (premise)');
    eq(run(d, long).length, 0, 'RF-tech refuses it on its length');
  }
}

// ---------------------------------------------------------------------------
// Jasco / GE Choice Alert (204): the one real checksum in the file
// ---------------------------------------------------------------------------

/** Sixteen bits of run-in, then four Manchester-coded bytes, the last of which balances the other three. */
const jascoBits = (b0, b1, b2, { chk, lead = [], trail = [] } = {}) => {
  const b3 = chk === undefined ? (b0 ^ b1 ^ b2) : chk;
  return [...lead, ...bytesToBits([0xfc, 0x0c]), ...manchester(bytesToBits([b0, b1, b2, b3])), ...trail];
};

{
  const d = dev(204);
  const base = jascoBits(0x12, 0x34, 0xef);
  eq(base.length, 80, 'a Jasco frame is eighty bits (premise)');

  const out = run(d, rowOf(base));
  eq(out.length, 1, 'Jasco decodes a well-formed frame');
  eq(out[0]?.model, 'Jasco-Security', '  Jasco model');
  eq(out[0]?.id, 0x1234, '  Jasco sensor id');
  eq(out[0]?.status, 1, '  Jasco reports the sensor closed');
  eq(out[0]?.mic, 'CHECKSUM', '  Jasco claims its check, being the only device here with one');

  eq(run(d, rowOf(jascoBits(0x12, 0x34, 0x6f)))[0]?.status, 0, 'Jasco reports the sensor open');
  eq(run(d, rowOf(jascoBits(0xab, 0xcd, 0xff)))[0]?.id, 0xabcd, 'Jasco reads another identity');
  eq(run(d, rowOf(jascoBits(0xab, 0xcd, 0xff)))[0]?.status, 1, '  whose status byte also reads closed');

  /*
   * The checksum. It is a plain exclusive-or, so it catches a single bad byte and not two that cancel — which
   * is worth stating rather than implying, since it is the only integrity claim anywhere in this file.
   */
  {
    const bad = jascoBits(0x12, 0x34, 0xef, { chk: 0x00 });
    ok(bad.join('') !== base.join(''), 'the bad-checksum frame really differs from the good one (premise)');
    eq(bad.length, base.length, '  and is the same length, so length is not what refuses it (premise)');
    eq(run(d, rowOf(bad)).length, 0, 'Jasco refuses a frame whose bytes do not balance');

    // A bit corrupted inside the coded payload, rather than a byte swapped wholesale.
    const flipped = [...base];
    ok(flipped[40] !== undefined, 'the bit about to be corrupted is inside the row (premise)');
    flipped[40] ^= 1; flipped[41] ^= 1;              // both halves of one pair, keeping the coding legal
    ok(flipped.join('') !== base.join(''), '  and the corrupted frame really differs (premise)');
    eq(run(d, rowOf(flipped)).length, 0, 'Jasco refuses a frame with a corrupted payload bit');

    // Two errors that cancel do get through, which is the honest limit of an exclusive-or.
    eq(run(d, rowOf(jascoBits(0x12 ^ 0x40, 0x34 ^ 0x40, 0xef))).length, 1,
      '  while two canceling errors pass, which is what an exclusive-or cannot see');
  }

  // The run-in has to be found, not assumed to be at the start.
  {
    const offset = jascoBits(0x12, 0x34, 0xef, { lead: [0, 0, 0, 0] });
    eq(offset.length, 84, 'a frame with four bits ahead of the run-in is 84 bits (premise)');
    eq(run(d, rowOf(offset)).length, 1, 'Jasco finds a run-in that is not at the start of the row');

    const noPreamble = rowOf(manchester(bytesToBits([0x12, 0x34, 0xef, 0xc9])).slice(0, 80));
    eq(noPreamble.search(0, 0, new Uint8Array([0xfc, 0x0c]), 16), noPreamble.bitsPerRow[0],
      'the run-in really is absent from that row (premise)');
    eq(run(d, noPreamble).length, 0, 'Jasco refuses a row with no run-in rather than decoding from anywhere');
  }

  // The length window is 80 to 87 bits inclusive.
  eq(run(d, rowOf(base.slice(0, 79))).length, 0, 'Jasco refuses a 79-bit row');
  eq(run(d, rowOf(jascoBits(0x12, 0x34, 0xef, { trail: new Array(7).fill(0) }))).length, 1,
    'Jasco takes an 87-bit row');
  eq(run(d, rowOf(jascoBits(0x12, 0x34, 0xef, { trail: new Array(8).fill(0) }))).length, 0,
    '  and refuses an 88-bit one');

  // A coding violation inside the payload leaves too few bits to read.
  {
    const broken = [...base];
    ok(broken[30] !== broken[31], 'the pair about to be broken is a legal one (premise)');
    broken[31] = broken[30];
    eq(broken.length, 80, '  and breaking it leaves the row 80 bits long (premise)');
    eq(run(d, rowOf(broken)).length, 0, 'Jasco refuses a frame with a coding violation');
  }
}

// ---------------------------------------------------------------------------
// No decoder here writes to the buffer it was handed
// ---------------------------------------------------------------------------

/**
 * Several of these complement or patch bits before reading, and upstream does it straight into the shared
 * buffer — so in rtl_433 the next protocol to look at the same burst sees bits the previous one rewrote. None
 * of that happens here, and it is asserted for all eleven rather than for the three that were tempted.
 */
{
  const cases = [
    [4, () => rowOf(wavemanBits(0, 9, 0xe))],
    [15, () => syncRowOf(ternaryBits(bytesToBits([0x12, 0x34, 0x56, 0xf6]), 27))],
    [24, () => rowOf(brennenstuhlBits(22, 0x10, 0x02).bits)],
    [46, () => rowOf(ht680Bits([0x3c, 0xa5, 0xdb, 0xe3, 0xa0]))],
    [48, () => rowOf(akhanBits(0xabcde, 0x2))],
    [49, () => repeat(quhwaBits(0x9c, 0x53), 5)],
    [58, () => rowOf(bitsFromHex('ce8e2a6c80', 33))],
    [62, () => repeat(bitsFromHex('37f62a6c80', 33), 5)],
    [72, () => repeat(bitsFromHex('c516c5', 24), 3)],
    [96, () => syncRowOf(ternaryBits(bytesToBits([0x12, 0x34, 0x56, 0xf6])))],
    [204, () => rowOf(jascoBits(0x12, 0x34, 0xef))],
  ];

  for (const [num, build] of cases) {
    const bb = build();
    const before = Uint8Array.from(bb.bb[0].subarray(0, 640));   // five rows' worth of storage
    const got = run(dev(num), bb);
    ok(got.length > 0, `protocol ${num} decodes the frame used for the no-write check (premise)`);
    ok(before.every((v, i) => v === bb.bb[0][i]), `protocol ${num} leaves the shared buffer as it found it`);
  }
}

// ---------------------------------------------------------------------------
// The registrations themselves
// ---------------------------------------------------------------------------

{
  const MINE = [4, 15, 24, 46, 48, 49, 58, 62, 72, 96, 204];
  for (const num of MINE) ok(!!dev(num), `protocol ${num} is registered`);

  /*
   * `disabled` does not switch a decoder off in this app — it marks the reading doubtful — so the flag is
   * mirrored from upstream exactly, set where upstream sets it and nowhere else. Both halves are asserted,
   * since a flag wrongly absent is as much a change as one wrongly added.
   */
  const DISABLED = new Set([24, 48, 62, 72]);
  for (const num of MINE) {
    const want = DISABLED.has(num);
    eq(!!dev(num).disabled, want, `protocol ${num} carries upstream's disabled flag (${want ? 'set' : 'clear'})`);
  }

  // Timings, spot-checked against the r_device tables they were copied from.
  eq(dev(4).tolerance, 200, 'Waveman keeps its explicit tolerance');
  eq(dev(15).syncWidth, 2650, 'KlikAanKlikUit keeps its sync width');
  eq(dev(96).gapLimit, 1500, 'Nexa keeps its gap limit, which KlikAanKlikUit does not have');
  ok(dev(15).gapLimit === undefined, '  and KlikAanKlikUit really has none');
  eq(dev(204).bands?.[0], 318010000, 'Jasco is a 318 MHz device');
  eq(dev(204).shortWidth, dev(204).longWidth, '  carried as NRZ, both widths the same');

  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
