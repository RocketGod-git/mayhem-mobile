/**
 * Water and utility meter endpoints: the radio modules a utility bolts to a meter so it can be read from the street.
 *
 * These are the metering protocols outside the two families already in this app — Itron's ERT range in
 * `meters.ts` and the European wireless M-Bus standard in `mbus.ts`. What the ones here have in common is that
 * none of them were meant to be read by anybody but the utility that installed them, and it shows. Four of the
 * twelve wrap their payload in a layer whose only purpose is to stop it looking like data, and in every case
 * that layer turns out to be keyless: three use the same fixed whitening sequence a CC1101 radio applies to
 * everything it sends, and the Apator pair adds a nibble substitution table that a single capture gives away.
 * None of it is encryption, and none of it is treated here as though it were. The one payload in this file that
 * really is encrypted — a Gridstream frame carrying an AES body — is reported as encrypted and left alone.
 *
 * Where a meter's consumption count needs a scaling table this port cannot honestly reproduce, the raw register
 * value is reported rather than a number in guessed units, the same choice `mbus.ts` makes. Badger's ORION
 * counts whole gallons and says so; Neptune's R900 does not record anywhere in the frame whether its counter is
 * binary or packed decimal, which is why upstream ships two decoders for it and why both are registered here.
 *
 * Evidence is unusually good for a metering batch. Apator's heat allocator ships five real captures with the
 * bytes they unwhiten to, Badger's Orion Endpoint ships two, and Arad's meter ships a frame together with its
 * forty-bit checksum — so the three hardest pieces of arithmetic in this file are each checked against numbers
 * this port had no part in producing. Details of what those captures settled are in `test/meters2.mjs`.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `badger_water.c`, `neptune_r900.c`, `arad_ms_meter.c`,
 * `gridstream.c`, `apator_metra_erm30.c`, `apator_metra_eitn30.c`, `badger_orion_endpoint.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc16, extractBytesUart8n1, ibmWhitening } from '../util.js';

/** North American meter endpoints all live in the 902–928 MHz band. */
const US_METER_BANDS = [912600000, 915000000];

const hex2 = (v: number) => (v & 0xff).toString(16).padStart(2, '0');
const hex4 = (v: number) => (v & 0xffff).toString(16).padStart(4, '0');
const hexOf = (b: Uint8Array, n = b.length, at = 0) => {
  let s = '';
  for (let i = 0; i < n; i++) s += hex2(b[at + i] ?? 0);
  return s;
};

/** One byte read at an arbitrary bit offset, the equivalent of rtl_433's `bitrow_get_byte`. */
function byteAt(m: Uint8Array, off: number): number {
  const i = off >> 3, s = off & 7;
  if (!s) return m[i] ?? 0;
  return ((((m[i] ?? 0) << 8) | (m[i + 1] ?? 0)) >> (8 - s)) & 0xff;
}

// ---------------------------------------------------------------------------
// Badger ORION water meter (223)
// ---------------------------------------------------------------------------

/**
 * Mode T's line code: each nibble travels as six bits with exactly three of them set.
 *
 * `mbus.ts` carries the same sixteen-entry table for the same reason — this meter borrows wireless M-Bus's
 * physical layer wholesale and puts an entirely different payload on top of it. The table is repeated rather
 * than shared because the two files agree only on this one accident of history, and a shared helper would
 * suggest a relationship between the protocols that does not exist.
 */
function decode3of6(byte: number): number {
  switch (byte) {
    case 22: return 0x0;
    case 13: return 0x1;
    case 14: return 0x2;
    case 11: return 0x3;
    case 28: return 0x4;
    case 25: return 0x5;
    case 26: return 0x6;
    case 19: return 0x7;
    case 44: return 0x8;
    case 37: return 0x9;
    case 38: return 0xa;
    case 35: return 0xb;
    case 52: return 0xc;
    case 49: return 0xd;
    case 50: return 0xe;
    case 41: return 0xf;
    default: return 0xff;                          // not a legal symbol
  }
}

/**
 * Badger's ORION endpoint, which speaks M-Bus mode T on the wire and nothing like it above.
 *
 * The specification sheet promises leak detection, cut-wire and reverse-flow indication, but not which bits
 * carry them, so the two flag bytes are reported raw rather than invented into named booleans. The reading
 * itself is unambiguous: whole gallons, little-endian, on meters with one-gallon resolution.
 *
 * Upstream's symbol check here is dead code — its helper returns 1 for a bad symbol and the caller tests for a
 * negative — so a frame containing an illegal six-bit symbol reaches the CRC instead of being rejected early.
 * The check is live in this port. That changes no outcome, because the CRC rejects those frames anyway; it
 * just rejects them for the reason that actually applies.
 */
export const badgerOrion: RDevice = register({
  num: 223,
  name: 'Badger ORION water meter, 100kbps',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,                                  // 100 kb/s, and NRZ so the bit period is the pulse width
  longWidth: 10,
  resetLimit: 1000,
  bands: [916450000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;

    // Sixteen bits of preamble and ten bytes at twelve bits each, plus room for a long run-in and a tail.
    const rowBits = bits.bitsPerRow[0];
    if (rowBits < 16 + 12 * 10 || rowBits > 128 + 16 + 12 * 10 + 96) return DECODE_ABORT_LENGTH;

    // The last six bits of the 01010101 run-in plus the ten-bit sync 0000 1111 01, taken together as two bytes.
    const pre = new Uint8Array([0x54, 0x3d]);
    let pos = bits.search(0, 0, pre, 16);
    if (pos + 12 * 10 >= rowBits) return DECODE_ABORT_EARLY;
    pos += 16;

    const row = bits.bb[0];
    const b = new Uint8Array(10);
    for (let n = 0; n < 10; n++) {
      const hi = decode3of6(byteAt(row, n * 12 + pos) >> 2);
      const lo = decode3of6(byteAt(row, n * 12 + pos + 6) >> 2);
      if (hi > 0x0f || lo > 0x0f) return DECODE_FAIL_MIC;
      b[n] = (hi << 4) | lo;
    }

    const crcRead = ((b[8] << 8) | b[9]) & 0xffff;
    const crcCalc = (~crc16(b, 8, 0x3d65, 0)) & 0xffff;
    if (crcCalc !== crcRead) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'Badger-ORION',
      type: 'Meter',
      id: (b[0] | (b[1] << 8) | (b[2] << 16)) >>> 0,
      flags_1: b[3],                               // fields not published; reported as-is
      volume_gal: (b[4] | (b[5] << 8) | (b[6] << 16)) >>> 0,
      flags_2: b[7],
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Neptune R900 flow meter (228 binary, 385 packed decimal)
// ---------------------------------------------------------------------------

/** Four chips to a base-6 digit. Anything not in this table cannot legally have been sent. */
const MAP16TO6 = [-1, -1, -1, 0, -1, 1, 2, -1, -1, 5, 4, -1, 3, -1, -1, -1];

/**
 * Neptune's R900, whose payload is base six.
 *
 * The frame is not a run of bits with fields in it. Every nibble on the air is one of six legal patterns, each
 * standing for a base-6 digit; pairs of those make a byte-sized value 0–35, and twenty-one of those values are
 * repacked five bits at a time to recover 104 bits of actual message. That is a 62 percent coding overhead
 * spent on making the signal easy to clock rather than on protecting it — there is no checksum anywhere in the
 * frame. What stands in for one is that two thirds of the possible nibble values are illegal, so a corrupted
 * frame almost always fails to decode rather than decoding wrongly.
 *
 * The consumption field is where the two registrations part company. Most R900 meters put a plain binary
 * counter there with three extra high bits carried separately; the T-10 and its relatives pack six decimal
 * digits into the same twenty-four bits. Nothing in the transmission says which, so upstream ships two
 * decoders and so does this. The decimal one rejects any frame containing a nibble above nine, which is what
 * keeps it from claiming most binary meters' frames — but the two genuinely do overlap, and a binary reading
 * that happens to use only digits 0–9 will be reported by both.
 */
function neptuneDecode(bits: BitBuffer, ctx: DecodeCtx, isBcd: boolean): number {
  if (bits.numRows !== 1) return DECODE_ABORT_LENGTH;

  // The real preamble is 0xAA,0xAA,0xAA,0xAB,0x52,0xCC,0xD2; shifted by the leading zero bit it reads as this.
  const pre = new Uint8Array([0x55, 0x55, 0x55, 0xa9, 0x66, 0x69, 0x65]);
  const preLen = pre.length * 8;
  const rowBits = bits.bitsPerRow[0];

  const startPos = bits.search(0, 0, pre, preLen);
  if (startPos + preLen + 168 > rowBits) return DECODE_ABORT_LENGTH;
  if (startPos === rowBits) return DECODE_ABORT_EARLY;

  // Upstream walks these 168 bits with a `uint8_t` counter, which wraps whenever the run-in is found more than
  // thirty-one bits into the row. A full-width counter is used here; on a frame where the two disagree,
  // upstream is reading the wrong bits.
  const row = bits.bb[0];
  const base6 = new Uint8Array(21);
  let count = 0;
  for (let k = startPos + preLen; k < startPos + preLen + 168; k += 8) {
    const byte = byteAt(row, k);
    const hi = MAP16TO6[(byte >> 4) & 0x0f];
    const lo = MAP16TO6[byte & 0x0f];
    if (hi < 0 || lo < 0) return DECODE_ABORT_EARLY;
    base6[count++] = 6 * hi + lo;
  }

  // Five bits out of each base-6 value, which turns 168 bits on the air into 105 of message.
  const packed = new BitBuffer();
  for (let i = 0; i < 21; i++) {
    const v = base6[i];
    for (let s = 4; s >= 0; s--) packed.addBit((v >> s) & 1);
  }
  const b = packed.bytes(0, 0, 13 * 8);

  let consumption = ((((b[9] >> 5) << 24) | (b[6] << 16) | (b[7] << 8) | b[8]) >>> 0);
  if (isBcd) {
    // The same twenty-four bits hold six decimal digits, and the three Wrap bits go unused. A nibble above
    // nine proves this is not one of those meters.
    let bcd = 0;
    for (let i = 5; i >= 0; i--) {
      const digit = (consumption >>> (4 * i)) & 0x0f;
      if (digit > 9) return DECODE_ABORT_EARLY;
      bcd = bcd * 10 + digit;
    }
    consumption = bcd;
  }

  ctx.emit({
    model: isBcd ? 'Neptune-R900BCD' : 'Neptune-R900',
    type: 'Meter',
    id: (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0),
    unkn1: b[4] >> 4,
    metertype: b[4] & 0x0f,
    unkn2: b[5] >> 5,
    // Days without use, as a band rather than a count: 0 none, 1 is 1–2 days, rising to 6 for 35 and over.
    nouse: (b[5] >> 2) & 0x07,
    backflow: b[5] & 0x03,                         // over the last 35 days: 0 none, 1 low, 2 high
    consumption,
    leak: (b[9] >> 2) & 0x07,                      // days of leak, banded the same way as nouse
    // Over the last 24 hours: 1 is intermittent, 2 is water used in every fifteen-minute interval.
    leaknow: b[9] & 0x03,
    extra: hexOf(b, 3, 10),                        // twenty-four trailing bits nobody has identified
  });
  return 1;
}

export const neptuneR900: RDevice = register({
  num: 228,
  name: 'Neptune R900 flow meters',
  what: 'water meter',
  modulation: Modulation.OOK_PCM,
  shortWidth: 30,
  longWidth: 30,
  resetLimit: 320,
  bands: US_METER_BANDS,
  decode: (_dev, bits, ctx) => neptuneDecode(bits, ctx, false),
});

export const neptuneR900bcd: RDevice = register({
  num: 385,
  name: 'Neptune R900 BCD flow meters',
  what: 'water meter',
  modulation: Modulation.OOK_PCM,
  shortWidth: 30,
  longWidth: 30,
  resetLimit: 320,
  bands: US_METER_BANDS,
  // Reads the same frames as the binary decoder above and differs only in how it reads the counter, so on any
  // one meter at most one of the two is telling the truth. Marked doubtful because the frame carries nothing
  // that says which — only the meter's model number, which is not on the air, settles it.
  disabled: true,
  decode: (_dev, bits, ctx) => neptuneDecode(bits, ctx, true),
});

// ---------------------------------------------------------------------------
// Arad / Master Meter Dialog3G water meter (260)
// ---------------------------------------------------------------------------

/*
 * The forty-bit checksum, and why it is worth the trouble.
 *
 * It is a linear digest: a running exclusive-or of a per-bit key, accumulated over every set bit of the
 * eighty-eight payload bits. Linearity is normally a weakness in a checksum, but here it is the whole point.
 * Because flipping one payload bit changes the result by exactly that bit's key and nothing else, the
 * difference between the received and computed values — the syndrome — names which bits are wrong. Matching
 * the syndrome against one key, then against every pair, then every triple, locates and repairs up to three
 * bit errors in a frame that would otherwise be thrown away.
 *
 * The keys come from a forty-bit shift register rolled left with three feedback taps, starting from the key
 * for the *last* payload bit and running backwards. Forty bits does not fit in a JavaScript number with the
 * exclusive-or operator available, so each key is kept as a high byte and a low word.
 */
const ARAD_KEYS_HI = new Uint8Array(88);
const ARAD_KEYS_LO = new Uint32Array(88);
{
  let hi = 0x30, lo = 0x37889dd8 >>> 0;            // the key for payload bit 87
  for (let j = 87; j >= 0; j--) {
    ARAD_KEYS_HI[j] = hi;
    ARAD_KEYS_LO[j] = lo;
    const t39 = (hi >> 7) & 1, t31 = (lo >>> 31) & 1, t23 = (lo >>> 23) & 1;
    let nhi = ((hi << 1) | (lo >>> 31)) & 0xff;
    let nlo = (lo << 1) >>> 0;
    if (t39) { nlo = (nlo ^ 0x014013f8) >>> 0; }                 // generator 0x00014013f8
    if (t31) { nhi ^= 0x20; nlo = (nlo ^ 0x1080d890) >>> 0; }    // generator 0x201080d890
    if (t23) { nlo = (nlo ^ 0x018f36c8) >>> 0; }                 // generator 0x00018f36c8
    hi = nhi; lo = nlo;
  }
}

/** The digest over the eleven payload bytes, as a high byte and a low word. */
function aradChecksum(b: Uint8Array): [number, number] {
  let hi = 0, lo = 0;
  for (let n = 0; n < 11; n++) {
    for (let i = 0; i < 8; i++) {
      if ((b[n] >> (7 - i)) & 1) {
        hi ^= ARAD_KEYS_HI[n * 8 + i];
        lo = (lo ^ ARAD_KEYS_LO[n * 8 + i]) >>> 0;
      }
    }
  }
  return [hi & 0xff, lo >>> 0];
}

function aradFlipBit(b: Uint8Array, bitIndex: number): void {
  b[bitIndex >> 3] ^= 1 << (7 - (bitIndex % 8));
}

/** Find which one, two or three payload bits the syndrome accuses, and repair them. Returns how many. */
function aradCorrectBits(b: Uint8Array, sHi: number, sLo: number): number {
  for (let i = 0; i < 88; i++) {
    if (ARAD_KEYS_HI[i] === sHi && ARAD_KEYS_LO[i] === sLo) {
      aradFlipBit(b, i);
      return 1;
    }
  }
  for (let i = 0; i < 88; i++) {
    for (let j = i + 1; j < 88; j++) {
      if ((ARAD_KEYS_HI[i] ^ ARAD_KEYS_HI[j]) === sHi && ((ARAD_KEYS_LO[i] ^ ARAD_KEYS_LO[j]) >>> 0) === sLo) {
        aradFlipBit(b, i); aradFlipBit(b, j);
        return 2;
      }
    }
  }
  for (let i = 0; i < 88; i++) {
    for (let j = i + 1; j < 88; j++) {
      const xHi = ARAD_KEYS_HI[i] ^ ARAD_KEYS_HI[j];
      const xLo = (ARAD_KEYS_LO[i] ^ ARAD_KEYS_LO[j]) >>> 0;
      for (let k = j + 1; k < 88; k++) {
        if ((xHi ^ ARAD_KEYS_HI[k]) === sHi && ((xLo ^ ARAD_KEYS_LO[k]) >>> 0) === sLo) {
          aradFlipBit(b, i); aradFlipBit(b, j); aradFlipBit(b, k);
          return 3;
        }
      }
    }
  }
  return -1;
}

/**
 * Arad's Dialog3G, which transmits inverted and corrects its own bit errors.
 *
 * Everything after the sync word arrives inverted, so the fixed forty-eight-bit identifier that every one of
 * these meters carries — 3e690aec7ac8 — is searched for as its complement. Upstream inverts the whole shared
 * bit buffer to deal with that; this port complements only the bytes it extracts, because in this app the same
 * buffer is handed to every other decoder afterwards and must come back unchanged.
 *
 * The count factor is programmed into the transponder at installation and is not transmitted directly, so the
 * scale and units are inferred from the serial suffix and a flag byte, exactly as upstream does, and both are
 * reported alongside the volume so a wrong guess is visible rather than silent. Upstream also accepts a serial
 * filter and manual scale and unit overrides as command-line options; those have no equivalent here and are
 * left out, which only ever means this port reports a meter upstream would have filtered away.
 */
export const aradMsMeter: RDevice = register({
  num: 260,
  name: 'Arad/Master Meter Dialog3G water utility meter',
  what: 'water meter',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 8.4,
  longWidth: 8.4,
  resetLimit: 100,
  bands: [915000000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY;
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;

    const rowBits = bits.bitsPerRow[0];
    if (rowBits < 18 * 8) return DECODE_ABORT_LENGTH;

    // The middle four bytes of the fixed identifier, complemented, since the frame arrives inverted.
    const sync4 = new Uint8Array([0xf5, 0x13, 0x85, 0x37]);
    const matchPos = bits.search(0, 0, sync4, 32);
    if (matchPos + 32 > rowBits) return DECODE_ABORT_LENGTH;

    const uidStart = Math.max(0, matchPos - 16);
    const payloadStart = matchPos + 32;
    if (payloadStart + 128 > rowBits) return DECODE_ABORT_LENGTH;
    const uidBits = Math.min(payloadStart - uidStart, 56);

    const u = bits.bytes(0, uidStart, uidBits);
    for (let i = 0; i < u.length; i++) u[i] = ~u[i] & 0xff;
    if (uidBits & 7) u[(uidBits - 1) >> 3] &= (0xff00 >> (uidBits & 7)) & 0xff;

    const b = bits.bytes(0, payloadStart, 128);
    for (let i = 0; i < b.length; i++) b[i] = ~b[i] & 0xff;

    const rxHi = b[11];
    const rxLo = (((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0);
    const [calcHi, calcLo] = aradChecksum(b);

    let corrections = 0;
    if (rxHi !== calcHi || rxLo !== calcLo) {
      corrections = aradCorrectBits(b, (rxHi ^ calcHi) & 0xff, ((rxLo ^ calcLo) >>> 0));
      if (corrections < 0) return DECODE_FAIL_MIC;
    }

    const serno = (b[1] | (b[2] << 8) | (b[3] << 16)) >>> 0;
    const snSufx = b[4];
    const flags1 = b[5];
    const readRaw = (b[6] | (b[7] << 8) | (b[8] << 16)) >>> 0;

    // The register's count factor, deduced from the serial suffix and the flag byte. Any other combination is
    // undocumented, and falls through to the tenth-of-a-cubic-metre default.
    let scale = 0.1, unit = 'm3';
    if (snSufx === 0x00 && (flags1 === 0x00 || flags1 === 0x40)) { scale = 0.01; unit = 'm3'; }
    else if (snSufx === 0x27 && flags1 === 0x00) { scale = 0.1; unit = 'gal'; }

    ctx.emit({
      model: 'AradMsMeter-Dialog3G',
      type: 'Meter',
      id: `${String(serno).padStart(8, '0')}-${hex2(snSufx)}`,
      uid: hexOf(u, (uidBits + 7) >> 3),            // fixed across the product line: 3e690aec7ac8
      leaking: (b[0] & 0x20) >> 5,
      flags1: hex2(flags1),
      gear: scale,
      volume: Math.round(readRaw * scale * 1000) / 1000,
      unit,
      flags2: hex2(b[10]),
      corrections,
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Landis & Gyr Gridstream power meters (271 at 9.6k, 272 at 19.2k, 273 at 38.4k)
// ---------------------------------------------------------------------------

/**
 * The frame check has no fixed starting value: each utility is issued its own.
 *
 * That makes the CRC init an identifier rather than a secret — it does not protect anything, it just means a
 * receiver has to know which deployment it is listening to. Upstream collects the values as they are
 * discovered and tries each in turn, so a frame that checks out has also named the utility that sent it. A
 * deployment whose value is not yet in this list simply fails the check.
 */
const GRIDSTREAM_CRC_INIT: Array<[number, string, string]> = [
  [0xe623, 'Kansas City MO', 'Evergy-Missouri West'],
  [0x5fd6, 'Dallas TX', 'Oncor'],
  [0xd553, 'Austin TX', 'Austin Energy'],
  [0x45f8, 'Dallas TX', 'CoServ'],
  [0x62c1, 'Quebec CAN', 'Hydro-Quebec'],
  [0x23d1, 'Seattle WA', 'Seattle City Light'],
  [0x2c22, 'Santa Barbara CA', 'Southern California Edison'],
  [0x142a, 'Washington', 'Puget Sound Energy'],
  [0x47f7, 'Pennsylvania', 'PPL Electric'],
  [0x22c6, 'Long Island NY', 'PSEG Long Island'],
  [0x8819, 'Alameda CA', 'Alameda Municipal Power'],
  [0x4e2d, 'Milwaukee WI', 'We Energies'],
  [0x1d65, 'Phoenix AZ', 'APS'],
  [0xb9a9, 'Mattoon IL', 'Coles-Moultrie Electric Co-op'],
  [0xd1ff, 'Newark NJ', 'PSEG New Jersey'],
  [0xba1f, 'Burleson TX', 'United Cooperative Services'],
];

/** Which utility's starting value checks this frame out, or a negative decode result if none does. */
function gridstreamChecksum(fullLength: number, length: number, b: Uint8Array, adjust: number): number {
  if (fullLength - 4 + adjust < length) return DECODE_ABORT_LENGTH;
  const crc = ((b[2 + length + adjust] << 8) | b[3 + length + adjust]) & 0xffff;
  for (let i = 0; i < GRIDSTREAM_CRC_INIT.length; i++) {
    if (crc16(b, length - 2, 0x1021, GRIDSTREAM_CRC_INIT[i][0], 4 + adjust) === crc) return i;
  }
  return DECODE_FAIL_MIC;
}

/**
 * Landis & Gyr's mesh, which is a network rather than a broadcast.
 *
 * Unlike every other meter in this file, these frames are not a meter announcing itself into the void. They
 * are traffic between meters and collectors on a mesh, so a frame has a source and a destination and a control
 * byte naming what kind of message it is. What can be read from the outside is the envelope — who is talking
 * to whom, how long since that meter last lost power, and what the mesh clock says. The message bodies are not
 * decoded, and the ones marked encrypted genuinely are.
 *
 * The bytes after the run-in are ordinary 8N1 serial with a start and stop bit around each, which is why this
 * needs a UART extractor rather than a plain byte read. Three registrations differ only in bit rate.
 */
function gridstreamDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  if (bits.numRows < 1) return DECODE_FAIL_SANITY;
  const rowBits = bits.bitsPerRow[0];

  const preV4 = new Uint8Array([0xaa, 0xaa, 0x00, 0x5f, 0xf0]);   // sync 0b0000000001 0b0111111111
  const preV5 = new Uint8Array([0xaa, 0xaa, 0x00, 0x7f, 0xf8]);   // sync 0b0000000001 0b11111111111

  const b = new Uint8Array(256);
  let protocolVersion: number;
  let offset = bits.search(0, 0, preV4, 36) + 36;
  if (offset >= rowBits) {
    offset = bits.search(0, 0, preV5, 37) + 37;
    if (offset >= rowBits) return DECODE_FAIL_SANITY;
    protocolVersion = 5;
  } else {
    protocolVersion = 4;
  }
  const numBits = Math.min(rowBits - offset, b.length * 10);
  const decodedLen = extractBytesUart8n1(bits.bb[0], offset, numBits, b);

  if (decodedLen < 5) return DECODE_FAIL_SANITY;
  if (b[0] !== 0x2a) return DECODE_FAIL_OTHER;     // not this protocol's frame at all

  const subtype = b[1];
  const subtypeMod = subtype === 0xd2 ? -1 : 0;
  const streamLen = subtype === 0xd2 ? b[2] : ((b[2] << 8) | b[3]);

  // The control byte is the first one the CRC covers, immediately after the length, and names the frame class.
  const ci = b[4 + subtypeMod];

  // A 0xD2 frame with control 0x52 carries an AES body ending in an authentication tag rather than a CRC, so
  // it cannot pass the check below. It is reported flagged rather than dropped.
  if (subtype === 0xd2 && ci === 0x52) {
    ctx.emit({
      model: 'LandisGyr-GS',
      type: 'Meter',
      subtype,
      protoversion: protocolVersion,
      ci,
      encrypted: 1,
    });
    return 1;
  }

  const crcIdx = gridstreamChecksum(decodedLen, streamLen, b, subtypeMod);
  if (crcIdx < 0) return DECODE_FAIL_MIC;
  const [initValue, location, provider] = GRIDSTREAM_CRC_INIT[crcIdx];

  const data: R433Data = {
    model: 'LandisGyr-GS',
    type: 'Meter',
    networkID: hex4(initValue),
    location,
    provider,
    subtype,
    protoversion: protocolVersion,
    ci,
    mic: 'CRC',
  };

  let uptime = 0;
  if (subtype === 0x55) {
    data.destaddress = hexOf(b, 6, 5);             // the target meter's wide-area address
    data.wanaddress = hexOf(b, 6, 11);
    data.id = hexOf(b, 4, 24);
    uptime = (((b[18] << 24) | (b[19] << 16) | (b[20] << 8) | b[21]) >>> 0);
  } else if (subtype === 0xd5) {
    data.destaddress = hexOf(b, 4, 5);
    data.id = hexOf(b, 4, 9);
    if (streamLen === 0x47) {
      data.timestamp = (((b[14] << 24) | (b[15] << 16) | (b[16] << 8) | b[17]) >>> 0);
      uptime = (((b[22] << 24) | (b[23] << 16) | (b[24] << 8) | b[25]) >>> 0);
      data.wanaddress = hexOf(b, 6, 30);
    }
  }
  // Any other subtype has no known address layout, so no id is reported. Upstream emits an empty string here;
  // leaving the field off says the same thing without looking like a meter whose id is blank.
  if (uptime > 0) data.uptime = uptime;            // seconds since that meter last lost power

  ctx.emit(data);
  return 1;
}

export const gridstream96: RDevice = register({
  num: 271,
  name: 'Landis & Gyr Gridstream Power Meters 9.6k',
  what: 'electricity meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 104,
  longWidth: 104,
  resetLimit: 20000,
  bands: [915000000],
  decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});

export const gridstream192: RDevice = register({
  num: 272,
  name: 'Landis & Gyr Gridstream Power Meters 19.2k',
  what: 'electricity meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 52,
  longWidth: 52,
  resetLimit: 20000,
  bands: [915000000],
  decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});

export const gridstream384: RDevice = register({
  num: 273,
  name: 'Landis & Gyr Gridstream Power Meters 38.4k',
  what: 'electricity meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 22,
  longWidth: 22,
  resetLimit: 20000,
  bands: [915000000],
  decode: (_dev, bits, ctx) => gridstreamDecode(bits, ctx),
});

// ---------------------------------------------------------------------------
// Apator Metra E-RM 30 water meter (277) and E-ITN 30 heat cost allocator (296)
// ---------------------------------------------------------------------------

/**
 * The substitution table that stands in for encryption on both Apator meters.
 *
 * Every nibble of the payload is replaced by another through this fixed sixteen-entry map. It has no key and
 * never changes, so one capture with a known meter reading breaks it permanently — which is what happened.
 * Note that it is not an involution: 1 becomes 7 but 7 becomes 4, so decoding needs this table and encoding
 * needs its inverse, and applying the same one twice does not get back to where it started.
 */
const APATOR_NIBBLE_MAP = [0x0, 0x7, 0xf, 0x9, 0xe, 0xd, 0x3, 0x4, 0x2, 0x6, 0xc, 0xb, 0x1, 0x8, 0xa, 0x5];

/**
 * Two Apator meters that are one protocol wearing two lengths.
 *
 * The water meter declares nineteen payload bytes and the heat cost allocator seventeen, and that length byte
 * is the only thing in the frame that tells them apart — so each registration insists on its own and steps
 * aside otherwise. Everything else is shared: the same run-in and sync word, the same whitening, the same
 * checksum over the whitening-removed but still substituted bytes, and the same nibble table underneath.
 *
 * The order matters and is easy to get backwards: the check is computed over the frame after the whitening is
 * stripped but *before* the nibble substitution is undone, so it protects the transmitted form rather than the
 * decoded one. The length byte is unwhitened early, by exclusive-or with 0xff, purely because 0xff is the
 * first byte of the whitening sequence.
 */
function apatorDecode(bits: BitBuffer, ctx: DecodeCtx, expectLen: number, model: string): number {
  if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

  const pre = new Uint8Array([0xaa, 0xaa, 0x69, 0x9a]);
  const rowBits = bits.bitsPerRow[0];
  const startPos = bits.search(0, 0, pre, 32);
  if (startPos === rowBits) return DECODE_ABORT_EARLY;

  const at = startPos + 32;
  const frameLen = expectLen + 3;                  // the length byte, the payload, and two bytes of check
  if (at + frameLen * 8 > rowBits) return DECODE_ABORT_LENGTH;

  if ((byteAt(bits.bb[0], at) ^ 0xff) !== expectLen) return DECODE_ABORT_EARLY;

  const frame = bits.bytes(0, at, frameLen * 8);
  ibmWhitening(frame, frameLen);

  const rxCrc = ((frame[expectLen + 1] << 8) | frame[expectLen + 2]) & 0xffff;
  if (crc16(frame, expectLen + 1, 0x8005, 0xffff) !== rxCrc) return DECODE_FAIL_MIC;

  const p = new Uint8Array(expectLen);
  for (let i = 0; i < 2 * expectLen; i++) {
    const shift = (i % 2) ? 0 : 4;
    p[i >> 1] |= APATOR_NIBBLE_MAP[(frame[1 + (i >> 1)] >> shift) & 0x0f] << shift;
  }

  // Year counts from 2000 and sits above the month and day in one little-endian sixteen-bit field.
  const dateAt = expectLen === 0x13 ? 15 : 12;
  const date = ((p[dateAt + 1] << 8) | p[dateAt]) & 0xffff;
  const dateStr = `${2000 + ((date >> 9) & 0x7f)}-`
    + `${String((date >> 5) & 0x0f).padStart(2, '0')}-${String(date & 0x1f).padStart(2, '0')}`;

  const data: R433Data = {
    model,
    type: 'Meter',
    len: expectLen,
    date: dateStr,
    mic: 'CRC',
  };

  if (expectLen === 0x13) {
    // The water meter's identifier is the one printed on the radio module, not the one on the analog dial.
    data.id = ((((p[3] << 24) | (p[2] << 16) | (p[1] << 8) | p[0]) >>> 0) ^ 0x30000000) >>> 0;
    const volRaw = (((((p[7] << 24) | (p[6] << 16) | (p[5] << 8) | p[4]) >>> 0) & 0x0fffffff) >>> 3);
    data.volume_m3 = Math.round(volRaw) / 1000;    // the counter runs in liters
  } else {
    data.id = ((((p[3] << 24) | (p[2] << 16) | (p[1] << 8) | p[0]) >>> 0) ^ 0x38000000) >>> 0;
    data.current_heating = ((p[11] << 8) | p[10]) & 0xffff;
    data.last_yr_heating = ((p[5] << 8) | p[4]) & 0xffff;
  }

  // Neither meter's remaining bytes are identified. The technical manual says the module also sends reverse
  // flow and the dates of magnetic and mechanical tampering, but not where, so the decoded payload goes out
  // as hex rather than being guessed into fields.
  data.payload = hexOf(p, expectLen);

  ctx.emit(data);
  return 1;
}

export const apatorMetraErm30: RDevice = register({
  num: 277,
  name: 'Apator Metra E-RM 30 water meter',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 25,
  longWidth: 25,
  resetLimit: 5000,
  // Upstream records no frequency for either Apator meter, so none is claimed here rather than inventing one;
  // that only means the app offers them in every band instead of just the right one.
  decode: (_dev, bits, ctx) => apatorDecode(bits, ctx, 0x13, 'ApatorMetra-ERM30'),
});

export const apatorMetraEitn30: RDevice = register({
  num: 296,
  name: 'Apator Metra E-ITN 30 heat cost allocator',
  what: 'heat cost allocator',
  modulation: Modulation.FSK_PCM,
  shortWidth: 25,
  longWidth: 25,
  resetLimit: 5000,
  decode: (_dev, bits, ctx) => apatorDecode(bits, ctx, 0x11, 'ApatorMetra-EITN30'),
});

// ---------------------------------------------------------------------------
// Badger Meter Orion Endpoint (282, and 290 for the 2020 hardware)
// ---------------------------------------------------------------------------

/** The endpoint's model is not in the frame — it is implied by which block the serial number falls in. */
function orionEndpointModel(id: number): string {
  if (id >= 30000000 && id <= 59999999) return 'ME or SE';
  if (id >= 60000000 && id <= 69999999) return 'Mobile M';
  if (id >= 70000000 && id <= 89999999) return 'Classic (CE)';
  if (id >= 110000000 && id <= 119999999) return 'LTE';
  if (id >= 120000000 && id <= 129999999) return 'LTE-M or LTE-MS';
  if (id >= 130000000 && id <= 139999999) return 'C or CS';
  if (id >= 140000000 && id <= 148999999) return 'HLA';
  if (id >= 149000000 && id <= 149999999) return 'HLC';
  if (id >= 150000000 && id <= 159999999) return 'HLB';
  if (id >= 160000000 && id <= 169999999) return 'HLD';
  if (id >= 170000000 && id <= 179999999) return 'HLFX';
  if (id >= 180000000 && id <= 189999999) return 'HLG';
  return 'Unknown Model';
}

/**
 * Badger's Orion Endpoint, which hops across the band and whitens what it sends.
 *
 * The endpoint changes frequency every hundred and fifty seconds across roughly fifty channels between 904 and
 * 925 MHz, so catching one is a matter of listening on the right channel at the right time rather than of
 * decoding difficulty. Once caught, the payload is unwhitened with the same fixed sequence a CC1101 applies to
 * everything, and then the whole twenty-three bytes including the check must run to zero — a check over its
 * own CRC, so there is no separate comparison to make.
 *
 * Two registrations differ only in bit rate: the newer 2020 hardware sends at twice the speed. The daily
 * reading is only reported when it is non-zero, matching upstream, because a zero there means the endpoint did
 * not send one rather than that no water was used.
 */
function orionEndpointDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  if (bits.numRows > 1) return DECODE_FAIL_SANITY;
  if (bits.numRows < 1) return DECODE_ABORT_EARLY;

  const msgLen = bits.bitsPerRow[0];
  if (msgLen < 232 || msgLen > 290) return DECODE_ABORT_LENGTH;

  const pre = new Uint8Array([0xaa, 0xaa, 0xec, 0x62, 0xec, 0x62]);
  let offset = bits.search(0, 0, pre, 48);
  if (offset >= msgLen) return DECODE_ABORT_EARLY;
  offset += 48;
  if (msgLen - offset < 184) return DECODE_ABORT_LENGTH;

  const b = bits.bytes(0, offset, 184);
  ibmWhitening(b, 23);

  if (crc16(b, 23, 0x8005, 0xffff) !== 0) return DECODE_FAIL_MIC;

  const id = (((b[8] << 24) | (b[7] << 16) | (b[6] << 8) | b[5]) >>> 0);
  const dailyRaw = (((b[19] << 24) | (b[18] << 16) | (b[17] << 8) | b[16]) >>> 0);

  const data: R433Data = {
    model: 'Orion-Endpoint',
    type: 'Meter',
    id,
    endpoint_model: orionEndpointModel(id),
    leaking: (b[10] & 0x20) >> 5,
    reading: (((b[15] << 24) | (b[14] << 16) | (b[13] << 8) | b[12]) >>> 0),
    flags_1: (((b[9] << 16) | (b[10] << 8) | b[11]) >>> 0),
    flags_2: b[20],
    mic: 'CRC',
  };
  if (dailyRaw) data.daily_reading = dailyRaw;

  ctx.emit(data);
  return 1;
}

export const orionEndpoint: RDevice = register({
  num: 282,
  name: 'Orion Endpoint from Badger Meter, GIF2014W-OSE, water meter',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,
  longWidth: 10,
  resetLimit: 1000,
  bands: [915000000],
  decode: (_dev, bits, ctx) => orionEndpointDecode(bits, ctx),
});

export const orionEndpoint2020: RDevice = register({
  num: 290,
  name: 'Orion Endpoint from Badger Meter, GIF2020OCECNA, water meter',
  what: 'water meter',
  modulation: Modulation.FSK_PCM,
  shortWidth: 5,                                   // the 2020 hardware sends at twice the rate
  longWidth: 5,
  resetLimit: 1000,
  bands: [915000000],
  decode: (_dev, bits, ctx) => orionEndpointDecode(bits, ctx),
});
