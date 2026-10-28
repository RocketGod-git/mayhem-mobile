/**
 * Mid-size weather stations and a few things that are not weather stations at all.
 *
 * These seven have little in common beyond their size, and that is the point of collecting them: each one is
 * doing something the smaller sensors never bother with.
 *
 * The two ELV protocols are the oldest code in the batch and read like it. Both carry their payload as small
 * fields each followed by a stop bit, least significant bit first, which means nothing in either frame is byte
 * aligned and every field has to be picked out a bit at a time. The EM 1000 goes further and takes a
 * majority vote across three repeats of the transmission before it looks at anything, so its decoder reads
 * three rows whether or not three rows arrived — which works here because this app's bit buffer, like the C
 * one, keeps every row allocated and zeroed.
 *
 * Archos TBH and NetAtmo are near-twins in shape: an FSK preamble, a sync word, a length byte, then a payload
 * and a CRC-16 over the length byte and everything after it. Archos then obfuscates its payload by chaining
 * each byte against the previous one and a fixed sixteen-byte table, which is reversible but means the length
 * byte is load-bearing twice over.
 *
 * Emax is the awkward one. A single burst carries several repeats, so its decoder loops over the whole row
 * finding preambles rather than stopping at the first, and four different products share the frame with only
 * a byte or two to tell them apart. Omni is the opposite: not a commercial sensor at all but a hobbyist
 * microcontroller sketch, which is why its checksum is seeded with a value the source invites you to change.
 *
 * Elsner Solexa is the deepest reverse engineering of the set. Its payload is not fields but an arithmetic
 * expansion of a single rolling byte, and the command a button sends only becomes visible after the expansion
 * is subtracted back out.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `elv.c`, `archos_tbh.c`, `emax.c`, `netatmo_thw.c`, `omni.c`,
 * `elsner_solexa.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8, crc16, parity8 } from '../util.js';

const BAND_433 = [433920000];
const BAND_868 = [868300000];
const BAND_868_95 = [868950000];

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const hex2 = (n: number) => (n & 0xff).toString(16).padStart(2, '0');
/** Sign-extend the low sixteen bits, the way a C cast to `int16_t` does. */
const int16 = (x: number) => (x << 16) >> 16;
/** Sign-extend the low eight bits, the way a C cast to `int8_t` does. */
const int8 = (x: number) => (x << 24) >> 24;

// ---------------------------------------------------------------------------
// ELV EM 1000 (6) and ELV WS 2000 (7)
// ---------------------------------------------------------------------------

/**
 * Pull `n` bits out of a byte array starting at an absolute bit position, least significant bit first.
 *
 * Both ELV protocols send the low bit of each field first while the bits themselves are laid into the buffer
 * most significant first, so the two orders disagree and every field has to be reassembled bit by bit. This is
 * upstream's `AD_POP` unchanged; writing it as a shift-and-mask would silently reverse every nibble.
 */
function adPop(bb: Uint8Array, n: number, bit: number): number {
  let val = 0;
  for (let i = 0; i < n; i++) {
    const byteNo = (bit + i) >> 3;
    const bitNo = 7 - ((bit + i) % 8);
    if (bb[byteNo] & (1 << bitNo)) val |= 1 << i;
  }
  return val;
}

/**
 * An energy meter that reports a running total, an instantaneous figure and a peak.
 *
 * The distinctive part is the front: before reading anything it takes a majority vote over three repeats of
 * the transmission, byte by byte, and gives up the moment three bytes disagree three ways. Upstream indexes
 * rows zero through two without checking how many arrived, which is safe there because the C bit buffer
 * always has all fifty rows allocated and zeroed. The same is true here — this app's rows are views into one
 * flat, zeroed array — so the indexing is reproduced as written rather than guarded, and it behaves
 * identically: with one row present the vote collapses to all zeroes and the stop-bit check throws it out,
 * while two identical rows still decode, exactly as upstream does.
 *
 * Nine bytes follow the preamble, each with a stop bit that must be set, and then an exclusive-or of those
 * nine bytes as a check. Upstream reports no `mic` field despite having that check, and this follows suit.
 * It is off by default upstream — the timings are marked "guessed, no samples available" — so it is off here.
 */
export const elvEm1000: RDevice = register({
  num: 6,
  name: 'ELV EM 1000',
  what: 'energy meter',
  modulation: Modulation.OOK_PPM,
  shortWidth: 500,
  longWidth: 1000,
  gapLimit: 7250,
  resetLimit: 30000,
  disabled: true,
  bands: BAND_868,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // Majority vote across three repeats. Fourteen bytes covers the 107 bits the frame actually uses.
    const voted = new Uint8Array(14);
    for (let i = 0; i < 14; i++) {
      const r0 = bits.bb[0][i], r1 = bits.bb[1][i], r2 = bits.bb[2][i];
      if (r0 === r1 || r0 === r2) voted[i] = r0;
      else if (r1 === r2) voted[i] = r1;
      else return DECODE_ABORT_EARLY;
    }

    let bit = 18;                                  // preamble
    const dec = new Uint8Array(10);
    let checksum = 0;
    for (let i = 0; i < 9; i++) {
      dec[i] = adPop(voted, 8, bit); bit += 8;
      const stopbit = adPop(voted, 1, bit); bit += 1;
      if (!stopbit) return DECODE_ABORT_EARLY;
      checksum ^= dec[i];
    }
    if (adPop(voted, 8, bit) !== checksum) return DECODE_FAIL_MIC;

    ctx.emit({
      model: 'ELV-EM1000',
      type: 'Energy',
      id: dec[1],
      seq: dec[2],
      total: dec[3] | (dec[4] << 8),
      current: dec[5] | (dec[6] << 8),
      peak: dec[7] | (dec[8] << 8),
    });
    return 1;
  },
});

/** The eight sensor kinds the WS 2000 base station accepts. A leading `!` marks one upstream cannot decode. */
const WS2000_TYPES = [
  '!AS3',
  'AS2000/ASH2000/S2000/S2001A/S2001IA/ASH2200/S300IA',
  '!S2000R',
  '!S2000W',
  'S2001I/S2001ID',
  '!S2500H',
  '!Pyrano',
  'KS200/KS300',
];

/**
 * How many nibbles follow the type nibble, indexed by that type.
 *
 * Upstream declares sixteen entries and fills only nine, so types nine through fifteen get a length of zero.
 * That is not a dead end: a zero length skips the payload loop entirely, leaving the running exclusive-or
 * equal to the type nibble itself, which is non-zero for all of those types — so the check rejects them. The
 * trailing zeroes are written out here rather than left implicit, because they are what makes that work.
 */
const WS2000_LENGTHS = [5, 8, 5, 8, 12, 9, 8, 14, 8, 0, 0, 0, 0, 0, 0, 0];

/**
 * A base station that speaks to eight kinds of sensor over one frame format.
 *
 * The type nibble decides how long the frame is, which is why the length table above has to be right: read
 * too few nibbles and the two checks land on the wrong bits. Everything is sent as four-bit nibbles with a
 * stop bit after each, low bit first, and the readings are decimal digits rather than scaled counts — so the
 * temperature is assembled as tens, units and tenths, with a separate sign bit rather than two's complement.
 *
 * Two checks guard it: an exclusive-or over every nibble from the type onward that must come out zero, and a
 * four-bit sum of the same nibbles plus five. Upstream accumulates that sum in a `uint8_t` and then narrows
 * it to four bits, and since 256 is a multiple of 16 the intermediate wrap cannot change the answer — the
 * plain sum used here is the same value.
 *
 * The combo sensor, type seven, reuses the temperature and humidity positions for wind and a rain counter,
 * and its humidity loses its tenths digit. Upstream is off by default and so is this.
 */
export const elvWs2000: RDevice = register({
  num: 7,
  name: 'ELV WS 2000',
  what: 'weather station receiver',
  modulation: Modulation.OOK_PWM,
  shortWidth: 366,
  longWidth: 854,
  resetLimit: 1000,
  disabled: true,
  bands: BAND_868,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.bb[0];
    const dec = new Uint8Array(16);
    let bit = 11;                                  // preamble
    let check = 0, sum = 0;

    dec[0] = adPop(row, 4, bit); bit += 4;
    const firstStop = adPop(row, 1, bit); bit += 1;
    if (!firstStop) return DECODE_ABORT_EARLY;
    check ^= dec[0];
    sum += dec[0];

    for (let i = 1; i <= WS2000_LENGTHS[dec[0]]; i++) {
      dec[i] = adPop(row, 4, bit); bit += 4;
      const stopbit = adPop(row, 1, bit); bit += 1;
      if (!stopbit) return DECODE_ABORT_EARLY;
      check ^= dec[i];
      sum += dec[i];
    }

    if (check) return DECODE_FAIL_MIC;
    if (adPop(row, 4, bit) !== ((sum + 5) & 0x0f)) return DECODE_FAIL_MIC;

    const subtype = dec[0] <= 7 ? WS2000_TYPES[dec[0]] : '?';
    const code = dec[1] & 7;
    // Sign is a flag bit, not two's complement: the digits themselves are always positive.
    const temp = ((dec[1] & 8) ? -1 : 1) * (dec[4] * 10 + dec[3] + dec[2] * 0.1);
    let humidity = dec[7] * 10 + dec[6] + dec[5] * 0.1;

    // Only the barometric sensor carries a pressure, and 200 hPa is its offset, so this is never zero when
    // present — which is what upstream's "report it if non-zero" condition amounts to.
    const pressure = dec[0] === 4 ? 200 + dec[10] * 100 + dec[9] * 10 + dec[8] : 0;

    const out: R433Data = {
      model: 'ELV-WS2000',
      type: 'Weather',
      subtype,
      id: code,
      temperature_C: round1(temp),
    };

    if (dec[0] === 7) {
      // The combo sensor re-uses the humidity and temperature nibbles for wind and rain.
      humidity = dec[6] * 10 + dec[5];
      out.humidity = round1(humidity);
      out.wind_avg_km_h = round1(dec[9] * 10 + dec[8] + dec[7] * 0.1);
      const rainsum = (dec[12] << 8) + (dec[11] << 4) + dec[10];
      out.rain_count = rainsum;
      // The seesaw tips once per 295 ml/m2 by default, which the manual says has to be calibrated per unit.
      out.rain_mm = round1(rainsum * 0.295);
      out.is_raining = (dec[1] & 2) ? 1 : 0;
      out.unknown = dec[13];
    }
    else {
      out.humidity = round1(humidity);
    }
    if (pressure) out.pressure_hPa = pressure;

    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Archos TBH (144)
// ---------------------------------------------------------------------------

const TBH_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91]);

/**
 * The fixed table the payload is chained against. It is not a key in any real sense — the transform is its
 * own inverse and the table is published in the source — but the payload cannot be read without it.
 */
const TBH_INFO = new Uint8Array([
  0x19, 0xf8, 0x28, 0x30, 0x6d, 0x0c, 0x94, 0x54,
  0x22, 0xf2, 0x37, 0xc9, 0x66, 0xa3, 0x97, 0x57,
]);

/**
 * A sensor from an open hardware project rather than a manufacturer, which is why one frame format carries
 * four unrelated kinds of reading.
 *
 * The length byte is doing two jobs. It says how much payload follows, and it is also the first byte the
 * CRC-16 runs over, so a corrupted length fails the check rather than sending the decoder off the end of the
 * buffer. Only after that check passes is the payload unchained: each byte is the exclusive-or of itself, the
 * byte before it, and a fixed table entry, with the byte before the first one taken as zero.
 *
 * The power-index frame then has a second, inner check — a CRC-8 over the payload from the type byte on. To
 * compute it, upstream overwrites that type byte with a length, because the sensor computed it that way; the
 * type has already been read by then, so nothing is lost, but it does mean the byte the CRC covers is not
 * the byte that was on the air.
 */
export const archosTbh: RDevice = register({
  num: 144,
  name: 'TBH weather sensor',
  what: 'weather and power sensor',
  modulation: Modulation.FSK_PCM,
  shortWidth: 212,
  longWidth: 212,
  resetLimit: 3000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const startPos = bits.search(0, 0, TBH_PREAMBLE, 48);
    if (startPos === bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    // sync(4) + preamble(4) + len(1) + data(1) + crc(2)
    if (bits.bitsPerRow[0] < 12 * 8) return DECODE_ABORT_LENGTH;

    const len = bits.bytes(0, startPos + 48, 8)[0];
    if (len > 60) return DECODE_ABORT_LENGTH;

    const frame = new Uint8Array(63);
    frame[0] = len;
    frame.set(bits.bytes(0, startPos + 56, (len + 2) * 8).subarray(0, len + 2), 1);

    if (crc16(frame, len + 1, 0x8005, 0xffff) !== ((frame[len + 1] << 8) | frame[len + 2])) {
      return DECODE_FAIL_MIC;
    }

    const payload = new Uint8Array(62);
    payload[0] = frame[1] ^ TBH_INFO[0];            // the byte before the first is taken as zero
    for (let i = 1; i < len; i++) payload[i] = frame[i] ^ frame[i + 1] ^ TBH_INFO[i % TBH_INFO.length];

    const type = payload[4];
    const id = ((payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0);

    if (type === 1) {
      // The inner check wants a length where the type byte sits, which is how the sensor computed it.
      payload[4] = len - 4;
      if (crc8(payload, len - 5, 0x07, 0x00, 4) !== payload[len - 1]) return DECODE_FAIL_MIC;

      ctx.emit({
        model: 'Archos-TBH',
        type: 'Energy',
        id,
        power_idx: (payload[6] << 16) | (payload[7] << 8) | payload[8],
        power_max: (payload[12] << 8) | payload[13],
        // The counter runs at eight ticks per second and upstream divides before reporting.
        timestamp: ((payload[9] << 16) | (payload[10] << 8) | payload[11]) >> 3,
        mic: 'CRC',
      });
      return 1;
    }

    if (type === 2) {
      // Tenths of a kelvin, offset to freezing, so this goes negative on its own.
      const tempRaw = ((payload[6] << 8) | payload[5]) - 2732;
      ctx.emit({
        model: 'Archos-TBH',
        type: 'Weather',
        id,
        temperature_C: round1(tempRaw * 0.1),
        humidity: payload[7],
        mic: 'CRC',
      });
      return 1;
    }

    if (type === 3) {
      ctx.emit({ model: 'Archos-TBH', type: 'Weather', id, battery_ok: round2(payload[5] * 0.01), mic: 'CRC' });
      return 1;
    }

    if (type === 4) {
      ctx.emit({ model: 'Archos-TBH', type: 'Weather', id, battery_ok: 0, mic: 'CRC' });
      return 1;
    }

    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Emax W6 and its many rebrands (215)
// ---------------------------------------------------------------------------

const EMAX_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xca, 0xca, 0x54]);
const EMAX_MESSAGE_BITLEN = 264;                   // 33 * 8

/**
 * One frame format sold under a dozen names, split between a bare thermometer and a full weather station.
 *
 * Two things make this decoder unusual. The first is the loop: a single burst carries several repeats of the
 * message, and a station reporting maximum light level can produce a gap that looks like a packet boundary,
 * so upstream insists on exactly one row and then walks that row finding preambles until something decodes.
 * A repeat that fails its length check or its checksum does not end the search — the next preamble is tried
 * from where the failed one started, and only the last failure reason is returned if nothing works.
 *
 * The second is that the high nibble of byte one, called `kind`, splits the format in two. Zero means the
 * rain and wind station, where humidity and temperature sit at different offsets from the thermometer's, and
 * a filler byte near the end of the frame is what tells three otherwise identical station variants apart.
 * The station also stores several fields with one added, so a zero reads as 0x01 and a wrap to 0x00 means
 * 255; every one of those is undone with a subtract-then-mask.
 *
 * The checksum is a plain sum of the first thirty-one bytes. Upstream computes it at full width and narrows
 * it only at the comparison, so the byte-wide sum this app's helper returns is the correct one — the offset
 * subtracted for one variant is congruent either way. Real frames do overflow a byte, which the test asserts
 * so the reasoning stays visible.
 *
 * Upstream attaches the model name conditionally on the subtype, which means a thermometer frame claiming
 * neither known subtype produces a reading with no model at all. This app's readings must be named, so those
 * get an explicit `Emax-unknown`, following the `ESA-unknown` already used elsewhere in this tree.
 */
export const emax: RDevice = register({
  num: 215,
  name: 'Emax W6, rebranded as Altronics x7063/4/x7064A, Optex 990040/50/51, Orium 13093/13123, '
    + 'Infactory FWS-1200, Newentor Q9, Otio 810025, Protmex PT3390A, Jula Marquant 014331/32, '
    + 'TechniSat IMETEO X6, weather station or temperature/humidity sensor',
  what: 'weather station',
  modulation: Modulation.FSK_PCM,
  shortWidth: 90,
  longWidth: 90,
  resetLimit: 9000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const rowBits = bits.bitsPerRow[0];
    let ret = 0;
    let pos = 0;

    for (;;) {
      pos = bits.search(0, pos, EMAX_PREAMBLE, 40);
      // A miss returns the row length, which cannot leave room for a message, so this ends the search too.
      if (pos + EMAX_MESSAGE_BITLEN > rowBits) break;

      pos += 40;
      if (pos + 32 * 8 > rowBits) { ret = DECODE_ABORT_LENGTH; continue; }

      const b = bits.bytes(0, pos, 32 * 8);

      const kind = (b[1] & 0xf0) >> 4;
      const subtype = b[3] & 0x03;

      let checksum = addBytes(b, 31);
      if (kind !== 0 && subtype === 0x3) checksum -= 0x9a;   // one variant offsets its sum
      if ((checksum & 0xff) !== b[31]) { ret = DECODE_FAIL_MIC; continue; }

      const channel = b[1] & 0x0f;
      const id = (b[2] << 4) | (b[3] >> 4);
      const batteryLow = b[3] & 0x08;
      const pairing = b[3] & 0x04;

      if (kind !== 0) {
        // The thermometer scatters its temperature across three bytes with a nibble ignored in the middle.
        const tempRaw = ((b[4] & 0x0f) << 8) | (b[5] & 0xf0) | (b[6] & 0x0f);
        const out: R433Data = {
          model: subtype === 0x1 ? 'Altronics-X7064' : subtype === 0x3 ? 'Altronics-X7064A' : 'Emax-unknown',
          type: 'Weather',
          id,
          channel,
          battery_ok: batteryLow ? 0 : 1,
        };
        if (subtype === 0x1) out.temperature_F = round1((tempRaw - 900) * 0.1);
        if (subtype === 0x3) out.temperature_C = round1((tempRaw - 500) * 0.1);
        out.humidity = b[7];
        if (pairing) out.pairing = 1;
        out.mic = 'CHECKSUM';
        ctx.emit(out);
        return 1;
      }

      // The rain and wind station. Everything below is stored with one added.
      const tempRaw = ((b[4] & 0x0f) << 8) | b[5];
      const tempF = round1((tempRaw - 900) * 0.1);
      const humidity = b[6];
      const windRaw = (((b[7] - 1) & 0xff) << 8) | ((b[8] - 1) & 0xff);
      const speedKmh = round1(windRaw * 0.2);
      const directionDeg = (((b[9] - 1) & 0x0f) << 8) | ((b[10] - 1) & 0xff);
      const rainRaw = (((b[11] - 1) & 0xff) << 8) | ((b[12] - 1) & 0xff);
      const rainMm = round1(rainRaw * 0.2);

      const base: R433Data = {
        model: '',
        type: 'Weather',
        id,
        channel,
        battery_ok: batteryLow ? 0 : 1,
      };

      const lux = (): number => {
        const lux14 = (b[14] - 1) & 0xff;
        const lux15 = (b[15] - 1) & 0xff;
        const value = ((lux14 & 0x7f) << 8) | lux15;
        return (lux14 & 0x80) ? value * 10 : value;   // the top bit is a times-ten multiplier
      };

      if (b[29] === 0x17) {
        // UV and light, no gust. A tag of three is the variant that leaves both of them empty.
        const tag = ((b[13] - 1) & 0xc0) >> 6;
        const out: R433Data = {
          ...base,
          model: tag !== 3 ? 'Emax-W6' : 'IMETEO-X6',
          temperature_F: tempF,
          humidity,
          wind_avg_km_h: speedKmh,
          wind_dir_deg: directionDeg,
          rain_mm: rainMm,
        };
        if (tag !== 3) { out.uvi = (b[13] - 1) & 0x1f; out.light_lux = lux(); }
        if (pairing) out.pairing = 1;
        out.mic = 'CHECKSUM';
        ctx.emit(out);
        return 1;
      }

      if (b[29] === 0x16 && b[14] === 0x01 && b[15] === 0x01) {
        // The same filler tail, but bytes fourteen and fifteen are the fixed placeholder, so there is no
        // light sensor and byte sixteen is a gust instead.
        const out: R433Data = {
          ...base,
          model: 'Emax-EM3551H',
          temperature_F: tempF,
          humidity,
          wind_avg_km_h: speedKmh,
          wind_max_km_h: round1(b[16] / 1.5),
          wind_dir_deg: directionDeg,
          rain_mm: rainMm,
        };
        if (pairing) out.pairing = 1;
        out.mic = 'CHECKSUM';
        ctx.emit(out);
        return 1;
      }

      if (b[29] === 0x16) {
        // Same tail again, but with real light readings — and this one reports Celsius, not Fahrenheit.
        const out: R433Data = {
          ...base,
          model: 'Lacrosse-WS6262',
          temperature_C: round1((tempRaw - 500) * 0.1),
          humidity,
          wind_avg_km_h: speedKmh,
          wind_max_km_h: round1(b[16] / 1.5),
          wind_dir_deg: directionDeg,
          rain_mm: rainMm,
          uvi: (b[13] - 1) & 0x1f,
          light_lux: lux(),
        };
        if (pairing) out.pairing = 1;
        out.mic = 'CHECKSUM';
        ctx.emit(out);
        return 1;
      }

      // A station frame with an unrecognized tail: keep looking for another repeat in the same row.
      pos += EMAX_MESSAGE_BITLEN;
    }

    return ret;
  },
});

// ---------------------------------------------------------------------------
// NetAtmo outdoor temperature/humidity and wind sensors (336)
// ---------------------------------------------------------------------------

const NETATMO_PREAMBLE = new Uint8Array([0xaa, 0xaa, 0xe7, 0x12]);

/**
 * The outdoor modules of a NetAtmo weather station, which talk to their base rather than to a receiver.
 *
 * Framing is the same idea as Archos: sync word, length byte, payload, CRC-16 over the length byte and
 * everything after. The length then also selects the message, and there are four of them — a six-byte
 * keep-alive, a twenty-five byte reading, a forty-nine byte wind report, and a request from the base station
 * itself, which this decoder sees because the base transmits on the same channel.
 *
 * Most of each message is still unknown, and the fields that are known are little endian while the frame is
 * not, so the byte pairs read backwards. The signal strength is a signed byte holding a negative decibel
 * figure, and 0x88 means the module heard nothing at all.
 *
 * The anemometer is ultrasonic and reports four raw axis measurements rather than a speed. Two are summed
 * for each of two diagonals, and speed and direction fall out as the magnitude and angle of that pair —
 * which is why the raw four are reported alongside, since the trigonometry is a reconstruction rather than
 * something the sensor sent. Upstream computes it in single precision; this uses doubles, so a reading
 * sitting exactly on a whole degree could in principle round the other way.
 *
 * All four message shapes here are real: they come from the source's own documentation, and every one of
 * their CRCs was recomputed independently before being used as a test.
 */
export const netatmoThw: RDevice = register({
  num: 336,
  name: 'NetAtmo temperature/humidity and wind sensors',
  what: 'weather station outdoor modules',
  modulation: Modulation.FSK_PCM,
  shortWidth: 8.5,
  longWidth: 8.5,
  resetLimit: 800,
  bands: BAND_868_95,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const startPos = bits.search(0, 0, NETATMO_PREAMBLE, 32);
    if (startPos === bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;

    const len = bits.bytes(0, startPos + 32, 8)[0];

    // Upstream sizes this for the largest length a byte can hold and does not range check before extracting;
    // a short row simply reads as zeroes and fails the CRC.
    const b = new Uint8Array(256 + 2 + 1);
    b[0] = len;
    b.set(bits.bytes(0, startPos + 40, (len + 2) * 8).subarray(0, len + 2), 1);

    if (crc16(b, len + 1, 0x8005, 0xffff) !== ((b[len + 1] << 8) | b[len + 2])) return DECODE_FAIL_MIC;

    const id = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    const signal = int8(b[6]);

    if (len === 6) {
      ctx.emit({ model: 'NetAtmo-TH', type: 'Weather', id, signal_dB: signal, mic: 'CRC' });
      return 1;
    }

    if (len === 0x19) {
      ctx.emit({
        model: 'NetAtmo-TH',
        type: 'Weather',
        id,
        battery_mV: (b[8] * 256 + b[7]) * 2,       // counted in half millivolts
        signal_dB: signal,
        temperature_C: round1(int16((b[23] << 8) | b[22]) * 0.1),
        humidity: b[25],
        mic: 'CRC',
      });
      return 1;
    }

    if (len === 0x31) {
      const rawA315 = int16((b[26] << 8) | b[25]);
      const rawB315 = int16((b[28] << 8) | b[27]);
      const rawC045 = int16((b[30] << 8) | b[29]);
      const rawD045 = int16((b[32] << 8) | b[31]);
      const ws315 = rawA315 + rawB315;
      const ws45 = rawC045 + rawD045;
      ctx.emit({
        model: 'NetAtmo-Wind',
        type: 'Weather',
        id,
        battery_mV: b[8] * 256 + b[7],             // the anemometer counts whole millivolts
        signal_dB: signal,
        raw_a_315: rawA315,
        raw_b_315: rawB315,
        raw_c_045: rawC045,
        raw_d_045: rawD045,
        wind_spd_km_h: round1(Math.sqrt(ws45 * ws45 + ws315 * ws315) * 0.05),
        // The axes sit at 45 and 315 degrees, so the angle is offset by 315 before wrapping.
        wind_dir_deg: Math.trunc(Math.atan2(ws45, ws315) / Math.PI * 180 + 315) % 360,
        mic: 'CRC',
      });
      return 1;
    }

    ctx.emit({ model: 'NetAtmo-THW', type: 'Weather', id, signal_dB: signal, mic: 'CRC' });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Omni multisensor (337)
// ---------------------------------------------------------------------------

/**
 * The seed for the frame's CRC-8.
 *
 * Upstream's source invites the owner to change this — "change this to match your device for security" — so a
 * unit built from that sketch with a different seed will not decode here. It is not security in any real
 * sense, since the polynomial and the frame layout are both published, but it does mean this constant is a
 * convention rather than something the protocol fixes.
 */
const OMNI_INITCRC = 0xaa;

/**
 * Not a product but a microcontroller sketch: a Raspberry Pi Pico with whatever sensor its owner attached.
 *
 * Because the payload depends on what is plugged in, the first nibble of the frame is a format number and the
 * eight payload bytes mean different things for each. Two formats are defined — bare core temperature and
 * supply voltage, and a Bosch environmental sensor with two temperatures, humidity, light and pressure — and
 * the remaining fourteen are reported as raw hex so an unrecognized build is still visible.
 *
 * Temperatures are twelve-bit two's complement packed against their neighbors, and upstream sign-extends
 * them by loading each into a sixteen-bit value with the sign bit at the top and shifting back down. The
 * outdoor one relies on the cast discarding everything above sixteen bits, so the nibble above it falls off
 * rather than being masked away; that is reproduced here, since masking first and shifting after would give
 * the same answer only for positive readings.
 *
 * One disagreement with upstream's own documentation is preserved. The header describes byte five as the
 * second humidity reading, outdoor to the first one's indoor, but the code reports it as a light percentage
 * and names the field `light_pct`. The code is what runs, so the code is what is ported.
 */
export const omni: RDevice = register({
  num: 337,
  name: 'Omni Multisensor',
  what: 'multisensor',
  modulation: Modulation.OOK_PWM,
  shortWidth: 200,
  longWidth: 400,
  syncWidth: 600,
  gapLimit: 500,
  resetLimit: 1250,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(2, 80);
    if (r < 0 || bits.bitsPerRow[r] > 82) return DECODE_ABORT_LENGTH;

    const b = bits.bb[r];
    if (crc8(b, 9, 0x97, OMNI_INITCRC) !== b[9]) return DECODE_FAIL_MIC;

    const messageFmt = b[0] >> 4;
    const id = b[0] & 0x0f;

    let payload = '';
    for (let i = 1; i < 9; i++) payload += hex2(b[i]);

    // Twelve bits sitting high in a sixteen-bit word, so the shift back down is the sign extension.
    const itempC = round2((int16((b[1] << 8) | b[2]) >> 4) * 0.1);
    const volts = round2(b[8] * 0.01 + 3.0);

    if (messageFmt === 0) {
      ctx.emit({
        model: 'Omni-Multisensor',
        type: 'Weather',
        id,
        channel: messageFmt,                       // upstream reports the format field as the channel
        temperature_C: itempC,
        voltage_V: volts,
        payload,
        mic: 'CRC',
      });
      return 1;
    }

    if (messageFmt === 1) {
      ctx.emit({
        model: 'Omni-Multisensor',
        type: 'Weather',
        id,
        channel: messageFmt,
        temperature_C: itempC,
        temperature_2_C: round2((int16((b[2] << 12) | (b[3] << 4)) >> 4) * 0.1),
        humidity: b[4],
        light_pct: b[5],
        pressure_hPa: round1(((b[6] << 8) | b[7]) * 0.1),
        voltage_V: volts,
        mic: 'CRC',
      });
      return 1;
    }

    ctx.emit({ model: 'Omni-Multisensor', type: 'Weather', id, channel: messageFmt, payload, mic: 'CRC' });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Elsner Solexa 230V (364)
// ---------------------------------------------------------------------------

/**
 * The rolling state's expansion function: shift left, and smear ones in underneath when the low bit is set.
 *
 * This is not a standard construction, it is what the reverse engineering found, and every byte of the first
 * third of the payload is one of these plus a constant.
 */
function elsnerSpread(x: number, k: number): number {
  let v = (x << k) & 0xff;
  if (x & 1) v |= ((1 << k) - 1) & 0xff;
  return v;
}

/** One step of the command-token normalization: the same spread, plus a base and the parity difference. */
function elsnerStep(prev: number, base: number, oldBit: number, newBit: number): number {
  return (elsnerSpread(prev, 1) + base + newBit - oldBit) & 0xff;
}

/**
 * Undo the self-synchronizing whitening, G(x) = x^7 + x^5 + 1.
 *
 * Each output bit is the input bit exclusive-ored with the input five and seven bits back, with history
 * before the start taken as zero. It only reveals the constant marker and an opaque payload view — every
 * field this decoder actually reports is read from the raw on-air bytes instead.
 */
function elsnerDescramble(input: Uint8Array, nbytes: number): Uint8Array {
  const out = new Uint8Array(nbytes);
  const bitAt = (n: number) => (input[n >> 3] >> (7 - (n % 8))) & 1;
  for (let n = 0; n < nbytes * 8; n++) {
    let bit = bitAt(n);
    if (n - 5 >= 0) bit ^= bitAt(n - 5);
    if (n - 7 >= 0) bit ^= bitAt(n - 7);
    out[n >> 3] |= bit << (7 - (n % 8));
  }
  return out;
}

/** A plain seven-bit lag, used only to expose the two selector bits. */
function elsnerLag7(input: Uint8Array, nbytes: number): Uint8Array {
  const out = new Uint8Array(nbytes);
  const bitAt = (n: number) => (input[n >> 3] >> (7 - (n % 8))) & 1;
  for (let n = 0; n < nbytes * 8; n++) {
    let bit = bitAt(n);
    if (n - 7 >= 0) bit ^= bitAt(n - 7);
    out[n >> 3] |= bit << (7 - (n % 8));
  }
  return out;
}

/**
 * The seven tokens one handset was observed to send, and what each one meant.
 *
 * These were established from a single installation, so they may be a per-unit or per-firmware detail rather
 * than protocol constants; upstream says as much and reports nothing for a token outside this set.
 */
function elsnerCommandName(token: number): string | undefined {
  switch (token) {
    case 0xcc00: return 'close';
    case 0xbb00: return 'open';
    case 0xbd00: return 'stop_or_release';
    case 0x00ef: return 'automode_a';
    case 0x00e3: return 'automode_b';
    case 0xaac0: return 'filler';
    case 0xa9c0: return 'automode_companion';
    default: return undefined;
  }
}

const ELSNER_ANCHOR = new Uint8Array([0x0a]);

/**
 * A wind, light and temperature sensor that drives a sunblind, and the handset that overrides it.
 *
 * The frame is a constant four-byte header, thirty-two payload bytes and a CRC-16, all whitened. The CRC is
 * the only integrity gate — it runs over the whitened bytes, before any of the transforms below — and a frame
 * that fails it is dropped outright.
 *
 * What makes this one interesting is that the payload has almost no fields. The first eleven bytes are an
 * arithmetic expansion of one rolling byte: three of them are fixed functions of it, which is what lets the
 * decoder confirm the model holds, and one carries a transmission counter as an offset from its expected
 * value. When those three identities fail the reading is still reported, since the CRC already vouched for
 * it, but the rolling state and counter are withheld rather than guessed at.
 *
 * The button press is hidden the same way. Two bytes elsewhere carry it, but only as a difference from what
 * the rolling-state arithmetic predicts, and which two depends on a single selector bit. Subtracting the
 * prediction collapsed sixty observed telegrams to seven values. A second selector decides whether the
 * telegram came from the handset this mapping was derived from; when it did not, no command is reported.
 *
 * Upstream also notes that a candidate temperature reading in this frame turned out to be an algebraic
 * identity of the rolling-state formula — constant for all 256 states — so it is deliberately not reported.
 * There is no published capture for this protocol, so unlike NetAtmo and Emax its CRC parameters could not be
 * confirmed against real radio; they are enforced, not verified.
 */
export const elsnerSolexa: RDevice = register({
  num: 364,
  name: 'Elsner Solexa 230V',
  what: 'sunblind wind, light and temperature sensor',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 11,
  longWidth: 11,
  resetLimit: 25,
  bands: BAND_868,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    // A miss returns the row length, so the guard below catches it without a separate test.
    const pos = bits.search(0, 0, ELSNER_ANCHOR, 8) + 8;
    const len = bits.bitsPerRow[0];
    if (pos >= len || len - pos < 38 * 8) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, pos, 38 * 8);

    if (crc16(b, 36, 0x1021, 0x68b3) !== ((b[36] << 8) | b[37])) return DECODE_FAIL_MIC;

    const p = elsnerDescramble(b, 36);
    const id = hex2(p[0]) + hex2(p[1]) + hex2(p[2]) + hex2(p[3]);
    let data = '';
    for (let i = 0; i < 32; i++) data += hex2(p[4 + i]);

    // The rolling state and the three identities that anchor its whole expansion. Payload byte k is b[4 + k].
    const rp0 = b[4];
    const paramOk = b[7] === ((elsnerSpread(rp0, 3) + 0x48) & 0xff)
      && b[8] === ((elsnerSpread(rp0, 4) + 0xd0) & 0xff)
      && b[9] === ((elsnerSpread(rp0, 5) + 0xa0) & 0xff);
    const counter = (b[5] - elsnerSpread(rp0, 1)) & 0xff;

    let command: string | undefined;
    if (paramOk) {
      const q = elsnerLag7(b, 36);
      const family1 = (q[4 + 3] >> 4) & 1;
      if (family1) {
        const branch1 = (q[4 + 17] >> 2) & 1;
        const l12 = parity8(rp0 & 0xf9);
        const l13 = parity8(rp0 & 0xfd);
        const l14 = 1 ^ parity8(rp0 & 0xff);
        const l17 = parity8(rp0 & 0xfe);
        const l18 = 1 ^ parity8(rp0 & 0xff);
        const l19 = parity8(rp0 & 0xfe);

        let exp0: number, exp1: number, obs0: number, obs1: number;
        if (!branch1) {
          exp0 = elsnerStep(b[4 + 12], 0x6a, l12, l13);
          exp1 = elsnerStep(exp0, 0x30, l13, l14);
          obs0 = b[4 + 13];
          obs1 = b[4 + 14];
        }
        else {
          exp0 = elsnerStep(b[4 + 17], 0x30, l17, l18);
          exp1 = elsnerStep(exp0, 0x30, l18, l19);
          obs0 = b[4 + 18];
          obs1 = b[4 + 19];
        }
        command = elsnerCommandName((((obs0 - exp0) & 0xff) << 8) | ((obs1 - exp1) & 0xff));
      }
    }

    const out: R433Data = { model: 'Elsner-Solexa', type: 'Blind', id };
    if (paramOk) { out.rolling = hex2(rp0); out.counter = counter; }
    if (command !== undefined) out.command = command;
    out.data = data;
    out.mic = 'CRC';

    ctx.emit(out);
    return 1;
  },
});
