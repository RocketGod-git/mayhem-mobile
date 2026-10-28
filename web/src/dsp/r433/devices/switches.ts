/**
 * Mains switches, doorbells and the cheap OOK remotes that drive them.
 *
 * These are the plainest protocols in the whole of rtl_433 and it is worth being blunt about what that means.
 * Nine of the eleven have no integrity check whatsoever — no CRC, no checksum, not even a parity bit. What
 * stands in for one is structure: a fixed frame length, a run of bits the encoder chip can never vary, a
 * command nibble with only two legal values. A decoder here is really a pattern match, and the quality of the
 * pattern is the entire difference between reading a light switch and inventing one out of noise.
 *
 * That is also why four of them ship switched off. `disabled` in this app does not stop a decoder running — it
 * marks the reading doubtful — and upstream's flag is mirrored exactly rather than re-litigated, because the
 * judgment behind it (does this frame catch other people's traffic?) was made against far more radio than
 * anything available here.
 *
 * Three of these are the same product sold under three names. KlikAanKlikUit (15), Nexa (96) and the Proove
 * already in `remotes.ts` (51) are one Scandinavian design, and on a clean sixty-four bit frame all three
 * decode it and all three are right. That is a fact about the products, not a bug to arbitrate: upstream ships
 * the three with no priority between them and so does this port. `test/switches.mjs` asserts the triple decode
 * so a tripled reading is recognized rather than investigated.
 *
 * The odd one out is RF-tech (72), a thermometer rather than a switch. It sits here because it shares the
 * habits of this group entirely — twenty-four fixed bits, no check, trusted only because it repeats.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `waveman.c`, `newkaku.c`, `brennenstuhl_rcs_2044.c`, `ht680.c`,
 * `akhan_100F14.c`, `quhwa.c`, `blyss.c`, `elro_db286a.c`, `rftech.c`, `nexa.c`, `jasco.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type RDevice,
} from '../device.js';

const BAND_433 = [433920000];

const hex2 = (v: number) => (v & 0xff).toString(16).padStart(2, '0');

/**
 * One row lifted into a buffer of its own.
 *
 * Several decoders in this family patch a bit or complement a byte before reading, and upstream does that
 * straight into the shared buffer — which in rtl_433 leaves the *next* decoder looking at bits the previous one
 * rewrote. Nothing here does that: a decoder that needs to alter bits works on a copy, and the ones that only
 * need a complement take it into a local rather than storing it back. The tests assert the input buffer comes
 * out of every decode byte for byte as it went in.
 */
function copyRow(bits: BitBuffer, row: number): BitBuffer {
  const out = new BitBuffer();
  const src = bits.bb[row];
  const n = bits.bitsPerRow[row];
  for (let i = 0; i < n; i++) out.addBit(bitAt(src, i));
  return out;
}

// ---------------------------------------------------------------------------
// Waveman switch transmitter (4)
// ---------------------------------------------------------------------------

/**
 * A PT2262-style mains switch, and one of the few here with a real plausibility test.
 *
 * The encoder sends each of twelve settings as a pair of pulses, and only two of the three possible pairs are
 * used, so every other bit on the wire is a one. That gives twelve bits of payload in a twenty-five bit frame
 * and one strong structural check: three bytes masked with 0xaa must all come out 0xaa.
 *
 * The payload bits arrive reversed relative to how they read, which is why each nibble is assembled bit by bit
 * from masks 0x40, 0x10, 0x04, 0x01 into weights 1, 2, 4, 8 — and inverted at the same time, since a pulse pair
 * that is present means the setting is off.
 *
 * The last nibble is the state, and upstream now insists it be one of the two values real remotes send. That
 * matters more than it looks: without it fourteen of the sixteen possible nibbles were silently reported as
 * "OFF", so any frame that got past the 0xaa test produced a confident wrong answer rather than nothing.
 *
 * The all-ones frame is refused outright ahead of everything else. Upstream found it arriving from other
 * transmitters — it names the Brennenstuhl below — and it passes the 0xaa test trivially.
 */
export const waveman: RDevice = register({
  num: 4,
  name: 'Waveman Switch Transmitter',
  what: 'mains switch remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 357,
  longWidth: 1064,
  gapLimit: 1400,
  resetLimit: 12000,
  tolerance: 200,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 25) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];

    if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff) return DECODE_ABORT_EARLY;
    if ((b[0] & 0xaa) !== 0xaa || (b[1] & 0xaa) !== 0xaa || (b[2] & 0xaa) !== 0xaa) return DECODE_FAIL_SANITY;

    const nb = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      nb[i] = ((b[i] & 0x40) ? 0x00 : 0x01)
        | ((b[i] & 0x10) ? 0x00 : 0x02)
        | ((b[i] & 0x04) ? 0x00 : 0x04)
        | ((b[i] & 0x01) ? 0x00 : 0x08);
    }

    // 0xe is ON and 0x6 is OFF; nothing else has ever been seen from a real remote.
    if (nb[2] !== 0xe && nb[2] !== 0x6) {
      ctx.log?.(`waveman: implausible state nibble ${nb[2].toString(16)}`);
      return DECODE_FAIL_SANITY;
    }

    ctx.emit({
      model: 'Waveman-Switch',
      id: String.fromCharCode(0x41 + nb[0]),         // the house letter printed on the dial, A through P
      channel: (nb[1] >> 2) + 1,
      button: (nb[1] & 3) + 1,
      state: nb[2] === 0xe ? 'ON' : 'OFF',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// The Scandinavian ternary family: KlikAanKlikUit (15) and Nexa (96)
// ---------------------------------------------------------------------------

/**
 * The body both of them share, and Proove in `remotes.ts` with it.
 *
 * The coding is not really Manchester — it is ternary, with a third symbol the Manchester decoder cannot
 * represent — but the two symbols that carry data are a Manchester pair, so decoding it that way works and
 * stopping at the third symbol is exactly the rejection wanted. Hence the position test: the decoder must have
 * consumed the whole row, sixty-four or seventy-two bits of it, rather than having tripped over a pair that did
 * not change level.
 *
 * The returned bytes deliberately over-read by one. On a sixty-four bit row only thirty-two bits decode, so
 * `b[4]` is past the message; it reads as zero here exactly as it does in C, where a fresh bit buffer is zeroed
 * and the rows sit end to end. The dim level is read from it, so a thirty-two bit frame reports a dim value of
 * zero rather than garbage — which is upstream's behavior, not an accident of this port.
 */
function kakuTernary(src: BitBuffer): Uint8Array | null {
  const databits = new BitBuffer();
  const pos = src.manchesterDecode(0, 0, databits, 80);
  databits.invert();
  if (pos !== 64 && pos !== 72) return null;
  return databits.bb[0];
}

/**
 * KlikAanKlikUit, the Dutch build, and the only one of the three that understands dimming.
 *
 * A command of "11" is the third ternary symbol and means dim, with four more bits of level behind it. The
 * Manchester decoder would stop dead on that pair, so upstream rewrites it to "10" — an ON command — before
 * decoding, and remembers that it did. This port makes that edit on a copy of the row: in rtl_433 the patch
 * lands in the buffer every later decoder is handed, and a dim command from one switch would quietly change
 * what the next protocol saw.
 *
 * There is no check of any kind on the twenty-six bit address. The sync mark and the exact frame length are all
 * that stand between this and the neighbors' traffic, which is why no `mic` is claimed.
 */
export const newkaku: RDevice = register({
  num: 15,
  name: 'KlikAanKlikUit Wireless Switch',
  what: 'mains switches and remotes',
  modulation: Modulation.OOK_PPM,
  shortWidth: 300,                                   // 1:1
  longWidth: 1400,                                   // 1:5
  syncWidth: 2650,                                   // 1:10, wide enough to take 2450 through 2850
  tolerance: 200,
  resetLimit: 3200,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.syncsBeforeRow[0] !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n !== 64 && n !== 72) return DECODE_ABORT_LENGTH;

    const dim = (bits.bb[0][6] & 0x03) === 0x03;
    let src: BitBuffer = bits;
    if (dim) {
      src = copyRow(bits, 0);
      src.bb[0][6] &= 0xfe;                          // turn the dim symbol into ON so the pair decodes
    }

    const b = kakuTernary(src);
    if (!b) return DECODE_ABORT_LENGTH;

    ctx.emit({
      model: 'KlikAanKlikUit-Switch',
      id: (b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6),   // 26 bits
      unit: b[3] & 0x0f,
      group_call: ((b[3] >> 5) & 1) ? 'Yes' : 'No',
      command: ((b[3] >> 4) & 1) ? 'On' : 'Off',
      dim: dim ? 'Yes' : 'No',
      dim_value: b[4] >> 4,
    });
    return 1;
  },
});

/**
 * Nexa, the Swedish build, tested against an LMST-606 door sensor.
 *
 * Byte for byte this is the frame above with two fields read differently: the channel and unit are stored
 * inverted, and there is no dim symbol, so a "11" pair simply stops the decode and the frame is refused.
 *
 * It is worth being clear about where it differs from Proove (51), which is already in the tree and carries
 * identical timings. Proove accepts only a sixty-four bit row and does not care where the Manchester decode
 * stopped; this one also takes seventy-two and insists the whole row decoded. On radio the two therefore catch
 * slightly different frames, but on any clean sixty-four bit transmission both fire, along with KlikAanKlikUit
 * above. Upstream's comment explains the split: the Nexa sends ON and OFF at different bit lengths and the
 * Proove decoder only ever caught the OFF.
 */
export const nexa: RDevice = register({
  num: 96,
  name: 'Nexa',
  what: 'magnetic door sensor and mains switches',
  modulation: Modulation.OOK_PPM,
  shortWidth: 270,                                   // 1:1
  longWidth: 1300,                                   // 1:5
  syncWidth: 2650,                                   // 1:10, wide enough to take 2450 through 2850
  tolerance: 200,
  gapLimit: 1500,
  resetLimit: 2800,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.syncsBeforeRow[0] !== 1) return DECODE_ABORT_EARLY;
    const n = bits.bitsPerRow[0];
    if (n !== 64 && n !== 72) return DECODE_ABORT_LENGTH;

    const b = kakuTernary(bits);
    if (!b) return DECODE_ABORT_LENGTH;

    ctx.emit({
      model: 'Nexa-Security',
      id: (b[0] << 18) | (b[1] << 10) | (b[2] << 2) | (b[3] >> 6),   // the house code, 26 bits
      channel: ((b[3] >> 2) & 0x03) ^ 0x03,          // stored inverted
      state: ((b[3] >> 4) & 1) ? 'ON' : 'OFF',
      unit: (b[3] & 0x03) ^ 0x03,                    // likewise
      group: (b[3] >> 5) & 1,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Brennenstuhl RCS 2044 (24)
// ---------------------------------------------------------------------------

/**
 * The "RCS 2044 N Comfort" socket set, and a nice example of turning a weakness into a check.
 *
 * Like the Waveman it carries twelve settings in twenty-five bits with every other bit forced to one: five for
 * the address switches inside the handset, five for which of the row buttons is down, two for the ON/OFF
 * column. Because each button has its own bit, holding several down really does send several bits, and the
 * receiver acts on all of them.
 *
 * Upstream uses that. Since nobody presses two buttons deliberately, a frame naming more than one is far more
 * likely to be noise than a command, and it is refused — which is the only thing resembling an integrity check
 * this protocol has. The same reasoning covers ON and OFF arriving together. Key "E" is accepted even though
 * no handset has that button, because a receiver will act on it.
 *
 * Off by default, mirroring upstream: twelve bits of payload behind nothing but a bit-parity pattern catches a
 * lot of other traffic.
 */
function brennenstuhlRow(bits: BitBuffer, ctx: DecodeCtx, row: number): number {
  const b = bits.bb[row];
  if (bits.bitsPerRow[row] !== 25
    || (b[0] & 0xaa) !== 0xaa
    || (b[1] & 0xaa) !== 0xaa
    || (b[2] & 0xaa) !== 0xaa
    || b[3] !== 0x80) return 0;

  const systemCode = ((b[0] & 0x40) >> 2) | ((b[0] & 0x10) >> 1) | (b[0] & 0x04)
    | ((b[0] & 0x01) << 1) | ((b[1] & 0x40) >> 6);

  const controlKey = (b[1] & 0x10) | ((b[1] & 0x04) << 1) | ((b[1] & 0x01) << 2)
    | ((b[2] & 0x40) >> 5) | ((b[2] & 0x10) >> 4);

  // Exactly one key, or this is not a command.
  const key = { 0x10: 'A', 0x08: 'B', 0x04: 'C', 0x02: 'D', 0x01: 'E' }[controlKey];
  if (!key) return 0;

  const onOff = ((b[2] & 0x04) >> 1) | (b[2] & 0x01);
  if (onOff !== 0x02 && onOff !== 0x01) return 0;    // both columns at once is not a command either

  ctx.emit({
    model: 'Brennenstuhl-RCS2044',
    id: systemCode,
    key,
    state: onOff === 0x02 ? 'ON' : 'OFF',
  });
  return 1;
}

export const brennenstuhlRcs2044: RDevice = register({
  num: 24,
  name: 'Brennenstuhl RCS 2044',
  what: 'mains socket remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 320,
  longWidth: 968,
  gapLimit: 1500,
  resetLimit: 4000,
  disabled: true,                                    // mirrors upstream: no check, and it catches other traffic
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let events = 0;
    for (let row = 0; row < bits.numRows; row++) events += brennenstuhlRow(bits, ctx, row);
    return events;
  },
});

// ---------------------------------------------------------------------------
// HT680 remote control (46)
// ---------------------------------------------------------------------------

/** The three tri-state positions an HT680 pin can be strapped to, plus the pattern that cannot occur. */
const HT680_TRISTATE = ['0', 'X', 'Z', '1'];         // 01 is invalid, 10 is the floating state

/**
 * A Holtek HT680 encoder, which turns up in gate and garage remotes across a dozen brands.
 *
 * Thirty-six bits behind a five-bit sync, each pair of bits one physical pin: tied low, tied high, or left
 * floating. Four of those pins are wired the same way in every HT680 product, and those four fixed pairs are
 * what makes this decodable at all — they are checked before anything is reported.
 *
 * Upstream had those four tests joined with `&&`, so a row was only refused when all four failed at once and
 * any one of them matching by chance let noise through. They are separate conditions here, as they now are
 * upstream. The tests below break each of the four independently, because a single `&&` reintroduced would
 * still pass a test that only ever breaks one.
 *
 * The tri-state string is the point of this decoder rather than a curiosity: it is what you would read off the
 * solder pads inside the handset, and it is the only way to tell two HT680 remotes apart. The last two symbols
 * are dropped because thirty-six bits is eighteen pairs and the buffer holds twenty.
 */
export const ht680: RDevice = register({
  num: 46,
  name: 'HT680 Remote control',
  what: 'gate and garage door remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 200,
  longWidth: 600,
  gapLimit: 1200,
  resetLimit: 14000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 41) continue;     // 36 payload bits behind a 5-bit sync
      if ((bits.bb[row][0] & 0xf8) !== 0xa8) continue;

      const b = bits.bytes(row, 5, 36);

      // The four pins every HT680 leaves open. Any one of them wrong means this is not an HT680 frame.
      if ((b[1] & 0xf0) !== 0xa0) continue;          // A4, A5
      if ((b[2] & 0x0c) !== 0x08) continue;          // AD10
      if ((b[3] & 0x30) !== 0x20) continue;          // AD13
      if ((b[4] & 0xf0) !== 0xa0) continue;          // AD16, AD17

      let tristate = '';
      for (let byte = 0; byte < 5; byte++) {
        for (let shift = 6; shift >= 0; shift -= 2) tristate += HT680_TRISTATE[(b[byte] >> shift) & 0x03];
      }
      tristate = tristate.slice(0, 18);              // the last two pairs are padding past the 36th bit

      const address = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
      const pressed = (v: number) => (v === 3 ? 'PRESSED' : '');

      ctx.emit({
        model: 'HT680-Remote',
        id: `0x${address.toString(16).toUpperCase().padStart(6, '0')}`,
        button1: pressed(b[3] & 0x03),
        button2: pressed((b[3] >> 2) & 0x03),
        button3: pressed((b[3] >> 6) & 0x03),
        button4: pressed(b[2] & 0x03),
        tristate,
      });
      return 1;                                      // upstream reports the first good row and stops
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// Akhan 100F14 keyless entry (48)
// ---------------------------------------------------------------------------

/** The four commands the handset sends. Anything else is refused rather than reported as unknown. */
const AKHAN_COMMANDS: Record<number, string> = {
  0x1: '0x1 (Lock)',
  0x2: '0x2 (Unlock)',
  0x4: '0x4 (Mute)',
  0x8: '0x8 (Alarm)',
};

/**
 * A keyless entry handset built on an HS1527, which is to say a garage remote sold for a car.
 *
 * Twenty bits of factory-burned identity and four bits of command, sent upside down. There is no check and no
 * rolling code, so the same four codes go out for the life of the handset — this decodes which button was
 * pressed and nothing that resists a replay.
 *
 * What makes it usable at all is that the command is one-hot: exactly one of four bits, so twelve of the
 * sixteen nibbles are impossible and a frame carrying one is thrown away rather than reported with an unknown
 * command. That is still thin, which is why upstream ships it off — a generic EV1527 remote sends the same
 * twenty-five bits and roughly a quarter of those will land on a legal command by chance.
 *
 * Upstream complements the shared buffer in place and never puts it back, so in rtl_433 every decoder after
 * this one sees an inverted frame. The complement is taken into locals here instead.
 */
export const akhan100F14: RDevice = register({
  num: 48,
  name: 'Akhan 100F14 remote keyless entry',
  what: 'car keyless entry remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 316,
  longWidth: 1020,
  resetLimit: 1800,
  tolerance: 100,                                    // some variants run their long pulses close to 1100 us
  disabled: true,                                    // mirrors upstream: false positives against generic EV1527
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.bitsPerRow[0] !== 25) return DECODE_ABORT_LENGTH;
    const b = bits.bb[0];

    // A short pulse is a zero and a long one a one, which is the opposite way up from the slicer's reading.
    const b0 = ~b[0] & 0xff, b1 = ~b[1] & 0xff, b2 = ~b[2] & 0xff;

    const cmd = b2 & 0x0f;
    const cmdStr = AKHAN_COMMANDS[cmd];
    if (!cmdStr) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Akhan-100F14',
      id: `0x${((b0 << 12) | (b1 << 4) | (b2 >> 4)).toString(16)}`,
      data: cmdStr,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Quhwa doorbell (49)
// ---------------------------------------------------------------------------

/**
 * A QH-C-CE-3V doorbell push, also sold as the "1 by One".
 *
 * Eighteen bits, sent inverted, of which the last four are constant — and that is the whole protocol. There is
 * nothing to report but the identity, and upstream does not even pretend otherwise: the button carries no
 * command because a doorbell has only one thing to say.
 *
 * With fourteen bits of real payload and no check, repetition is the integrity test. Five matching rows are
 * demanded before anything is believed, which is what makes an eighteen-bit frame safe to act on at all.
 *
 * Two things about the order of the tests are load-bearing and are kept as upstream wrote them. The all-zero
 * refusal happens *before* the complement, so what it rejects is a frame of all ones on the wire — silence read
 * as data. The length test happens *after* it, which reads oddly since complementing cannot change a length,
 * but the two constant-field tests beside it must see the complemented bytes.
 */
export const quhwa: RDevice = register({
  num: 49,
  name: 'Quhwa',
  what: 'wireless doorbell push',
  modulation: Modulation.OOK_PWM,
  shortWidth: 360,                                   // pulses and gaps alike: short 360 us, long 1070 us
  longWidth: 1070,
  gapLimit: 1200,
  resetLimit: 6600,                                  // the gap between messages is about 6500 us
  tolerance: 80,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(5, 18);
    if (r < 0) return DECODE_ABORT_EARLY;
    const b = bits.bb[r];

    if (!b[0] && !b[1] && !b[2]) {
      ctx.log?.('quhwa: all bytes zero');
      return DECODE_FAIL_SANITY;
    }

    const b0 = ~b[0] & 0xff, b1 = ~b[1] & 0xff, b2 = ~b[2] & 0xff;

    if (bits.bitsPerRow[r] !== 18 || (b1 & 0x03) !== 0x03 || (b2 & 0xc0) !== 0xc0) return DECODE_ABORT_LENGTH;

    ctx.emit({
      model: 'Quhwa-Doorbell',
      id: (b0 << 8) | b1,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Blyss DC5-UK-WH (58)
// ---------------------------------------------------------------------------

/**
 * A B&Q remote that recognizes exactly two handsets, and says so.
 *
 * There is no decoding here at all: thirty-three bits are compared against two literal codes and reported as
 * an identity if they match. Upstream's author was candid about why — these remotes are paired to their
 * receivers, so the codes are probably specific to the units he had, and nobody has collected enough to work
 * out which bits are the address and which the command.
 *
 * That makes this the narrowest decoder in the file and also the safest: a thirty-three bit exact match against
 * a forty-bit constant cannot false-trigger. It is left enabled for the same reason upstream leaves it enabled.
 *
 * It shares its frame shape with the Elro doorbell below, and the two accept overlapping traffic — see there.
 */
const BLYSS_CODES = [
  [0xce, 0x8e, 0x2a, 0x6c, 0x80],
  [0xe7, 0x37, 0x7a, 0x2c, 0x80],
];

export const blyss: RDevice = register({
  num: 58,
  name: 'Blyss DC5-UK-WH',
  what: 'mains switch remote',
  modulation: Modulation.OOK_PWM,
  shortWidth: 500,
  longWidth: 1500,
  gapLimit: 2500,
  resetLimit: 8000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] !== 33) continue;     // the last row of a burst is 32 and is skipped
      const b = bits.bb[row];

      if (!BLYSS_CODES.some(code => code.every((v, i) => b[i] === v))) continue;

      ctx.emit({
        model: 'Blyss-DC5ukwh',
        id: hex2(b[0]) + hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
      });
      return 1;
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Elro DB286A doorbell (62)
// ---------------------------------------------------------------------------

/**
 * The same thirty-three bit frame as the Blyss, with the literal match taken away.
 *
 * Anything that arrives five times in a burst at exactly thirty-three bits is reported as an Elro doorbell,
 * which is why upstream ships it off. It will claim the Blyss codes above, and on a Blyss transmission both
 * decoders fire — `test/switches.mjs` asserts that, since it is a property of the two protocols rather than of
 * this port, and the `disabled` flag is what marks the Elro reading as the doubtful one.
 *
 * Each push is said to alternate between two codes, so one physical bell legitimately shows up under two
 * identities. The thirty-third bit is dropped: only the four whole bytes go into the identity.
 */
export const elroDb286a: RDevice = register({
  num: 62,
  name: 'Elro DB286A Doorbell',
  what: 'wireless doorbell push',
  modulation: Modulation.OOK_PWM,
  shortWidth: 456,
  longWidth: 1448,
  gapLimit: 2000,
  resetLimit: 8000,
  disabled: true,                                    // mirrors upstream: length and repetition are the only tests
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Fourteen repeats are normal; five is the fewest that will be believed.
    const row = bits.findRepeatedRow(5, 33);
    if (row < 0 || bits.bitsPerRow[row] !== 33) return DECODE_ABORT_LENGTH;
    const b = bits.bb[row];

    ctx.emit({
      model: 'Elro-DB286A',
      id: hex2(b[0]) + hex2(b[1]) + hex2(b[2]) + hex2(b[3]),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// RF-tech / INFRA 217S34 thermometer (72)
// ---------------------------------------------------------------------------

/**
 * A thermometer among the switches, and it belongs here: twenty-four bits, no check, trusted only because it
 * repeats three times.
 *
 * The layout is as plain as it gets — an identity byte, the whole degrees with a sign bit above them, then a
 * nibble of tenths with the battery and button flags packed above that. Upstream ships six captured frames
 * beside the code, and the last of them is unusually good evidence: it is documented as having been taken with
 * fresh batteries and the button held, and the two flag bits in it are exactly the ones that claim so. The
 * tests decode all six.
 *
 * Nothing bounds the temperature, so a corrupt frame reports a corrupt reading with no sign of trouble. That is
 * why upstream has it off, and the flag is mirrored.
 */
export const rftech: RDevice = register({
  num: 72,
  name: 'RF-tech',
  what: 'wireless thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 2000,
  longWidth: 4000,
  gapLimit: 5000,
  resetLimit: 10000,
  disabled: true,                                    // mirrors upstream: no check and no range test
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 24);
    if (r < 0 || bits.bitsPerRow[r] !== 24) return DECODE_ABORT_LENGTH;
    const b = bits.bb[r];

    let tempC = (b[1] & 0x7f) + (b[2] & 0x0f) * 0.1;
    if (b[1] & 0x80) tempC = -tempC;                 // sign, not part of the magnitude

    ctx.emit({
      model: 'RF-tech',
      id: b[0],
      battery_ok: (b[2] & 0x80) === 0x80 ? 1 : 0,
      temperature_C: tempC,
      button: (b[2] & 0x60) !== 0 ? 1 : 0,
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Jasco / GE Choice Alert (204)
// ---------------------------------------------------------------------------

/**
 * A door and window sensor, and the only decoder in this file with a genuine integrity check.
 *
 * Three bytes of message and a fourth that is the exclusive-or of the other three, so the four together come to
 * zero. That is weak as checks go — it catches any single bad byte but not two that cancel — and it is still an
 * enormous improvement on everything above, which is why this is the one device here that claims a `mic`.
 *
 * The frame is Manchester coded behind a sixteen bit run-in, and the run-in is deliberately unbalanced
 * (`fc 0c`, six ones then a run of zeros) so that it cannot occur inside coded data. If it is absent the
 * search returns the row length and the bounds test below refuses the frame rather than decoding from
 * somewhere arbitrary.
 *
 * The closed state is read as a byte matching a mask rather than a single bit, which is upstream's reading of
 * a byte that is not fully understood — the battery line beside it is commented out there for the same reason.
 * Nothing is guessed at here that upstream does not name.
 */
export const jasco: RDevice = register({
  num: 204,
  name: 'Jasco/GE Choice Alert Security Devices',
  what: 'door and window sensor',
  modulation: Modulation.OOK_PCM,
  shortWidth: 250,
  longWidth: 250,                                    // NRZ: the two widths are the same
  resetLimit: 1800,
  bands: [318010000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const rawLen = bits.bitsPerRow[0];
    if (rawLen < 80 || rawLen > 87) {
      if (rawLen > 0) ctx.log?.(`jasco: invalid bit count ${rawLen}`);
      return DECODE_ABORT_EARLY;
    }

    const startPos = bits.search(0, 0, new Uint8Array([0xfc, 0x0c]), 16) + 16;
    if (startPos + 64 > rawLen) return DECODE_ABORT_LENGTH;

    const packet = new BitBuffer();
    bits.manchesterDecode(0, startPos, packet, 32);
    if (packet.bitsPerRow[0] < 32) return DECODE_ABORT_LENGTH;

    const b = packet.bb[0];
    if ((b[0] ^ b[1] ^ b[2] ^ b[3]) !== 0) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Jasco-Security',
      id: (b[0] << 8) | b[1],
      status: (b[2] & 0xef) === 0xef ? 1 : 0,        // 1 is closed
      mic: 'CHECKSUM',
    });
    return 1;
  },
});
