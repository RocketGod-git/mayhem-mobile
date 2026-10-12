/**
 * FS20 and FHT, RojaFlex shutters, and Somfy io-homecontrol.
 *
 * Somfy is the well-evidenced one: its file publishes about forty complete packets, and eight of them go in
 * here unchanged. They are worth more than usual because each one carries its own CRC and its own length
 * byte, so a frame that decodes at all is confirming the framing, the UART layer and the check together.
 *
 * Those packets are printed as bytes, so they have to be put back through the UART encoding the sensor uses.
 * That encoder is checked first against a fact the file states independently — the sync word `ff33` encodes
 * to `7fd99` — because a builder that frames bytes wrongly is the failure that has cost the most time in this
 * work, and its symptom (decoder returns nothing, every field undefined) looks exactly like a broken port.
 *
 * FS20 and RojaFlex publish nothing, so their frames are built from the transmit side with the checksums
 * computed from their definitions rather than imported from the code under test.
 */
import { BitBuffer } from '../dist/dsp/r433/bitbuffer.js';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const dev = (num) => REGISTRY.find(d => d.num === num);
const run = (d, bb) => { const out = []; d.decode(d, bb, { emit: x => out.push(x) }); return out; };

/** Written from the definitions, not imported, so building and checking stay independent. */
const crc16Ref = (m, n, poly, init) => {
  let r = init & 0xffff;
  for (let i = 0; i < n; i++) { r ^= m[i] << 8; for (let k = 0; k < 8; k++) r = (r & 0x8000) ? ((r << 1) ^ poly) & 0xffff : (r << 1) & 0xffff; }
  return r & 0xffff;
};
const parityRef = (b) => { let n = 0; for (let i = 0; i < 8; i++) if ((b >> i) & 1) n++; return n & 1; };

const B = (h) => Uint8Array.from(h.replace(/[^0-9a-fA-F]/g, '').match(/../g).map(x => parseInt(x, 16)));
const bytesToBits = (bytes) => { const o = []; for (const b of bytes) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const inv = (bits) => bits.map(b => b ^ 1);
const rowOf = (bits) => { const bb = new BitBuffer(); for (const v of bits) bb.addBit(v); return bb; };
/** UART 8n1 as this app's extractor reads it: a zero start bit, the byte least significant bit first, a one. */
const uart = (byte) => { const o = [0]; for (let i = 0; i < 8; i++) o.push((byte >> i) & 1); o.push(1); return o; };
const uartAll = (bytes) => { const o = []; for (const b of bytes) o.push(...uart(b)); return o; };

console.log('FS20/FHT, RojaFlex shutters and Somfy io-homecontrol');

// ---- Somfy io-homecontrol (189): eight published packets ----
{
  const d = dev(189);

  /*
   * The builder has to be right before anything built with it means a thing. The file states that the sync
   * word ff33 UART-encodes to 7fd99, and the decoder searches for 57fd99 — that same twenty-bit encoding
   * behind four bits of run-in. Reproducing both is what proves the encoder frames bytes the way the decoder
   * unframes them.
   */
  {
    const sync = uartAll([0xff, 0x33]);
    eq(sync.length, 20, 'the sync word occupies twenty UART bits (premise)');
    let v = 0;
    for (const b of sync) v = (v * 2) + b;
    eq(v.toString(16), '7fd99', 'and encodes to 7fd99, exactly as the file states');
    const withLead = [...bytesToBits(Uint8Array.from([0x55, 0x55])), ...sync];
    const at = rowOf(withLead).search(0, 0, Uint8Array.from([0x57, 0xfd, 0x99]), 24);
    eq(at, 12, 'so the pattern the decoder searches for is found where expected');
  }

  /** Run-in, the UART-framed sync word, then the packet's own bytes. */
  const build = (hex) => rowOf([
    ...bytesToBits(Uint8Array.from([0x55, 0x55])),
    ...uartAll([0xff, 0x33]),
    ...uartAll(B(hex)),
  ]);

  const PKTS = [
    ['f6 2000003f dacdea00 016100000000 0bdd fd8ef56f15ad aa1e', 'dacdea', '00003f', '016100000000', 0x0bdd, 'fd8ef56f15ad'],
    ['f6 0000003f dacdea00 016100000000 0bdd fd8ef56f15ad 4f9c', 'dacdea', '00003f', '016100000000', 0x0bdd, 'fd8ef56f15ad'],
    ['f8 0000007f e1f57300 0161d40080c80000 0d6c 2c3a3123e6ab 7f1e', 'e1f573', '00007f', '0161d40080c80000', 0x0d6c, '2c3a3123e6ab'],
    ['f8 0000007f c5896700 0161d40080c80000 0c63 04e867ed64ad f055', 'c58967', '00007f', '0161d40080c80000', 0x0c63, '04e867ed64ad'],
    ['f6 0000003f 70875800 0161d2000000 3bd2 e6b62cef54c8 a937', '708758', '00003f', '0161d2000000', 0x3bd2, 'e6b62cef54c8'],
    ['f6 0000003f 17f52300 0147c8000000 18c4 38789cb680cc bc74', '17f523', '00003f', '0147c8000000', 0x18c4, '38789cb680cc'],
    ['f8 0000003f 17f52320 02ff0143010e0000 18c5 045ee107363d 59b4', '17f523', '00003f', '02ff0143010e0000', 0x18c5, '045ee107363d'],
    ['f8 0000007f 70875800 0161d40080c80000 3bd5 05526875499c 7e72', '708758', '00007f', '0161d40080c80000', 0x3bd5, '05526875499c'],
  ];

  for (const [hex, src, dst, payload, counter, mac] of PKTS) {
    const tag = hex.slice(0, 14);
    const out = run(d, build(hex));
    eq(out.length, 1, `Somfy decodes published packet ${tag}`);
    eq(out[0]?.id?.toString(16).padStart(6, '0'), src, `${tag}: source address`);
    eq(out[0]?.dst_id?.toString(16).padStart(6, '0'), dst, `${tag}: destination address`);
    eq(out[0]?.msg, payload, `${tag}: payload`);
    eq(out[0]?.counter, counter, `${tag}: counter`);
    eq(out[0]?.mac, mac, `${tag}: authentication code, reported as hex`);
    eq(out[0]?.mode, 'One-way', `${tag}: protocol mode`);
    eq(out[0]?.mic, 'CRC', `${tag}: reports a CRC`);

    // The length byte has to agree with how many bytes actually arrived.
    const b = B(hex);
    eq((b[0] & 0x1f) + 3, b.length, `${tag}: msg_len + 3 is the whole frame (premise)`);
  }

  /*
   * The file's column headings sit one byte left of what the code reads. What it prints as a four-byte
   * destination is control byte two followed by a three-byte address, and what it prints as a four-byte
   * source is a three-byte address followed by the command id. Pinned so a reader of that file is not
   * misled into thinking this port drops a byte.
   */
  {
    const b = B(PKTS[0][0]);
    eq(b[1].toString(16), '20', 'the first byte of the printed destination column is control byte two');
    eq(((b[2] << 16) | (b[3] << 8) | b[4]).toString(16).padStart(6, '0'), '00003f', 'the address is the three bytes after it');
    eq(b[8], 0x00, 'and the last byte of the printed source column is the command id');
    const out = run(d, build(PKTS[0][0]));
    eq(out[0]?.msg_type, 0x00, 'which is what the decoder reports as the command');
    eq(out[0]?.flag_lpm, 1, 'control byte two also carries the low-power flag');
  }

  // Rejections.
  {
    const bad = B(PKTS[0][0]); bad[bad.length - 1] ^= 0xff;
    eq(run(d, build([...bad].map(x => x.toString(16).padStart(2, '0')).join(''))).length, 0,
      'Somfy rejects a frame whose CRC does not come out zero');
  }
  eq(run(d, rowOf(bytesToBits(Uint8Array.from([0x55, 0x55, 0x55, 0x55])))).length, 0,
    'Somfy finds nothing in a burst with no sync word');
  {
    const short = B('f6 2000003f dacd');
    eq(run(d, build([...short].map(x => x.toString(16).padStart(2, '0')).join(''))).length, 0,
      'Somfy refuses a frame shorter than its own length byte claims');
  }
}

// ---- RojaFlex (187): built from the transmit side ----
{
  const d = dev(187);
  const build = ({ id = 0x1234567, channel = 3, cmdId = 0x1a, cmdValue = 0x01, token = 0x1a2b,
                   withCrc = true, breakCrc = false } = {}) => {
    const msg = new Uint8Array(11);
    msg[0] = 0x08;
    msg[1] = (id >> 20) & 0xff; msg[2] = (id >> 12) & 0xff; msg[3] = (id >> 4) & 0xff;
    msg[4] = ((id & 0x0f) << 4) | (channel & 0x0f);
    msg[5] = cmdId;
    msg[6] = cmdValue;
    msg[7] = (token >> 8) & 0xff; msg[8] = token & 0xff;
    const crc = crc16Ref(msg, 9, 0x8005, 0xffff) ^ (breakCrc ? 0xffff : 0);
    msg[9] = (crc >> 8) & 0xff; msg[10] = crc & 0xff;
    const body = withCrc ? msg : msg.subarray(0, 9);
    return rowOf([...bytesToBits(B('aaaad391d391')), ...bytesToBits(body)]);
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'RojaFlex decodes a well-formed frame');
  eq(out[0]?.id, 0x1234567, 'RojaFlex installation id');
  eq(out[0]?.channel, 3, 'RojaFlex channel');
  eq(out[0]?.cmd_id, 0x1a, 'RojaFlex command id');
  eq(out[0]?.cmd_name, 'Up', 'RojaFlex names the up command');
  eq(out[0]?.token, 0x1a2b, 'RojaFlex message token');
  eq(out[0]?.mic, 'CRC', 'a frame carrying a CRC claims one');

  for (const [code, name] of [[0x0a, 'Stop'], [0x8a, 'Down'], [0xda, 'Go saved position'],
                              [0xea, 'Request Status'], [0xb5, 'Pos. Status 60%']]) {
    eq(run(d, build({ cmdId: code }))[0]?.cmd_name, name, `RojaFlex names command 0x${code.toString(16)}`);
  }
  // An unknown code is reported as itself rather than under an invented name.
  {
    const unknown = run(d, build({ cmdId: 0x77 }))[0];
    eq(unknown?.cmd_name, 'unknown', 'RojaFlex does not invent a name for an unknown command');
    eq(unknown?.cmd_id, 0x77, 'but reports the raw code');
  }

  // A shutter answers with 0x_5; a remote and the bridge both use 0x_a and differ only by the CRC.
  eq(run(d, build({ cmdId: 0x85 }))[0]?.model, 'RojaFlex-Shutter', 'a 0x_5 command is the shutter answering');
  eq(run(d, build({ cmdId: 0x1a }))[0]?.model, 'RojaFlex-Remote', 'a 0x_a command with a CRC is a remote');
  {
    const bridge = run(d, build({ cmdId: 0x1a, withCrc: false }))[0];
    eq(bridge?.model, 'RojaFlex-Bridge', 'the same command without a CRC is the bridge cloning it');
    eq(bridge?.mic, undefined, 'and a frame with no CRC claims no integrity check');
    eq(bridge?.cmd_name, 'Up', 'while still decoding the command');
  }

  eq(run(d, build({ breakCrc: true })).length, 0, 'RojaFlex rejects a bad CRC');
  eq(run(d, rowOf(bytesToBits(B('aaaad391d391')))).length, 0, 'RojaFlex refuses a run-in with no frame behind it');
}

// ---- FS20 / FHT (122): per-byte parity and a residual checksum ----
{
  const d = dev(122);
  /** Twelve zeros, a one, then each byte followed by its parity bit — all sent inverted. */
  const build = ({ hc1 = 0x12, hc2 = 0x34, addr = 0x56, cmd = 0x11, ext = null, type = 6, hop = 0,
                   breakParity = -1, sumOverride = null } = {}) => {
    const bytes = [hc1, hc2, addr, cmd];
    if (ext !== null) bytes.push(ext);
    const sum = sumOverride !== null ? sumOverride
      : (hc1 + hc2 + addr + cmd + (ext ?? 0) + type + hop) & 0xff;
    bytes.push(sum);
    const bits = new Array(12).fill(0);
    bits.push(1);
    bytes.forEach((b, i) => {
      for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
      bits.push(parityRef(b) ^ (i === breakParity ? 1 : 0));
    });
    return rowOf(inv(bits));
  };

  const out = run(d, build({}));
  eq(out.length, 1, 'FS20 decodes a well-formed frame');
  eq(out[0]?.model, 'FS20', 'a residual of six marks a switch or dimmer');
  eq(out[0]?.command, 'on, last value', 'FS20 command 0x11');
  eq(out[0]?.flags, '(none)', 'FS20 flags');
  eq(out[0]?.mic, 'PARITY', 'FS20 reports parity as its integrity check');
  // Housecode and address are shown as base-four digits offset by one, the way the DIP switches read.
  eq(out[0]?.address, 0x2223, 'FS20 address in base-four-plus-one form');
  ok(String(out[0]?.housecode.toString(16)).split('').every(c => c >= '1' && c <= '4'),
    'every housecode digit is between one and four');

  // A radiator valve is the same frame with a different residual band.
  {
    const fht = run(d, build({ type: 0xc, cmd: 0x06 }));
    eq(fht[0]?.model, 'FHT', 'a residual of twelve marks a radiator valve');
    eq(fht[0]?.command, 'valve open <ext>%', 'FHT command 0x6');
  }
  // The extension byte, and the flag that says it is there.
  {
    const e = run(d, build({ cmd: 0x20 | 0x11, ext: 0x2a }));
    eq(e[0]?.ext, 0x2a, 'FS20 reads the extension byte');
    eq(e[0]?.flags, 'Extended', 'and flags the frame as extended');
  }
  // A hop count of one or two is still accepted; three is not.
  eq(run(d, build({ hop: 2 })).length, 1, 'FS20 accepts a frame relayed twice');
  eq(run(d, build({ hop: 3 })).length, 0, 'but not one claiming a third relay');

  /*
   * The band between the two documented types belongs to neither protocol. The premise matters: this frame
   * is otherwise perfect, so only the residual can be rejecting it.
   */
  {
    const between = build({ type: 10 });
    eq(run(d, build({ type: 6 })).length, 1, 'the same frame with a valid type decodes (premise)');
    eq(run(d, between).length, 0, 'FS20 rejects a residual falling between the two documented types');
  }

  eq(run(d, build({ breakParity: 2 })).length, 0, 'FS20 rejects a byte whose parity bit is wrong');
  // Command zero on a valve is only meaningful with an extension byte.
  eq(run(d, build({ type: 0xc, cmd: 0x00 })).length, 0, 'FS20 rejects a bare end-of-sync from a valve');
  eq(run(d, build({ type: 0xc, cmd: 0x20, ext: 0x40 })).length, 1, 'but accepts one carrying its extension');
  // Four command codes are documented as unused and no real device sends them.
  for (const c of [0x1c, 0x1d, 0x1e, 0x1f]) {
    eq(run(d, build({ cmd: c })).length, 0, `FS20 rejects reserved command 0x${c.toString(16)}`);
  }
  eq(run(d, build({ cmd: 0x1b })).length, 1, 'while the code just below them is accepted (premise)');
  // An all-zero housecode and address is what misread foreign traffic looks like.
  eq(run(d, build({ hc1: 0, hc2: 0, addr: 0 })).length, 0, 'FS20 rejects an all-zero housecode and address');

  eq(d.disabled, true, 'FS20 mirrors upstream\'s disabled flag: foreign traffic false-decodes here');
}

// ---- The registrations themselves ----
{
  for (const num of [122, 187, 189]) ok(!!dev(num), `protocol ${num} is registered`);
  const nums = REGISTRY.map(d => d.num).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i && n === nums[i - 1]);
  ok(dupes.length === 0, 'no protocol number is registered twice', dupes.join(', '));

  const handled = new Set([3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 16, 17, 18]);
  const orphans = REGISTRY.filter(d => !handled.has(d.modulation)).map(d => `${d.num}:${d.modulation}`);
  ok(orphans.length === 0, 'every registered device uses a modulation the slicer supports', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
