/**
 * Telemetry, tire sensors and assorted radios — ten protocols with little in common beyond being small.
 *
 * Most of this file is sensors that say one or two numbers and stop: a plant moisture probe, two thermometers,
 * a weather station's indoor console, two tire pressure sensors. Three of them are unusual enough to be worth
 * naming. RadioHead is not a sensor at all but a hobbyist radio library, so anything built on it can appear
 * here — its frames carry a length, an address pair and a free-form payload, and one product (the Sensible
 * Living moisture probe) is given its own registration purely to read that payload as named fields. ANT+ is
 * Garmin's sports telemetry, which lives at 2.4 GHz where an ordinary dongle cannot hear it at all. And the
 * cricket scoreboard is a transmitter rather than a sensor: it sends the digits a scoreboard should display.
 *
 * Four are checked against real captures that rtl_433 ships — Steelmate's, whose documented decode this port
 * reproduces byte for byte, and Telldus's two, which pass their CRC and between them exercise both of that
 * decoder's output branches. The rest are built from the transmit side in the test.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `steelmate.c`, `radiohead_ask.c`, `digitech_xc0324.c`,
 * `companion_wtr001.c`, `telldus_ft0385r.c`, `ant_antplus.c`, `shenzhen_wale_wl_th6r.c`, `tpms_gear_hive.c`,
 * `fsl_scoreboard.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addBytes, crc8, crc16, crc16lsb, parityBytes, reflectBytes, reverse8, xorBytes } from '../util.js';

/** American cars transmit at 315 MHz, European ones at 433.92; aftermarket kit is sold into both. */
const TPMS_BANDS = [315000000, 433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const hexLow = (v: number, n: number) => (v >>> 0).toString(16).padStart(n, '0');
const hexUp = (v: number, n: number) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

// ---------------------------------------------------------------------------
// Steelmate tire pressure sensor (59)
// ---------------------------------------------------------------------------

/**
 * A sensor whose bytes arrive upside down and back to front.
 *
 * The payload is inverted Manchester with the bits of every byte reversed as well, so the run-in that gets
 * searched for is `00 00 7f` even though the sensor is really sending `00 00 01`. Both transformations are
 * undone on a copy of the row rather than in the shared buffer — upstream inverts the whole buffer in place,
 * which leaves it inverted for every decoder that runs afterwards if this one then fails its checksum.
 *
 * The pressure scale was re-derived after the original guess drifted further from the dashboard the harder the
 * tire was inflated: it counts thirty-seconds of a bar, not half a pound per square inch.
 */
export const steelmate: RDevice = register({
  num: 59,
  name: 'Steelmate TPMS',
  what: 'tire pressure sensor: Steelmate TP-S15, R-Lake',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 120,
  bands: TPMS_BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0x00, 0x00, 0x7f]);   // inverted; the sensor really sends 00 00 01

    for (let row = 0; row < bits.numRows; row++) {
      const rowLen = bits.bitsPerRow[row];
      // One frame or a run of three, with a trailing bit that may or may not have survived.
      if (rowLen !== 72 && rowLen !== 73 && rowLen !== 208 && rowLen !== 209) continue;

      const pos = bits.search(row, 0, pre, 24);
      if (pos > rowLen - 72) continue;

      const b = bits.bytes(row, pos, 72);
      for (let i = 0; i < 9; i++) b[i] = ~b[i] & 0xff;
      reflectBytes(b, 9);

      // Upstream masks this sum to a byte itself, so the shared helper is the right one here.
      if (addBytes(b, 6, 2) !== b[8]) continue;

      const battery = b[7];
      const data: R433Data = {
        model: 'Steelmate',
        type: 'TPMS',
        id: '0x' + hexLow((b[3] << 8) | b[4], 4),
        pressure_kPa: round1(b[5] * 3.125),           // b[5]/32 bar, which is b[5]*3.125 kPa
        temperature_C: b[6] - 50,
        mic: 'CHECKSUM',
      };
      // Two values of the battery byte are not voltages at all but leak warnings.
      if (battery < 0xfe) data.battery_mV = 3900 - battery * 10;
      if (battery === 0xff) data.alarm = 'fast leak';
      else if (battery === 0xfe) data.alarm = 'slow leak';
      ctx.emit(data);
      return 1;
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// RadioHead ASK (67) and the Sensible Living moisture probe built on it (103)
// ---------------------------------------------------------------------------

const RH_ASK_MAX_PAYLOAD_LEN = 67;
const RH_ASK_HEADER_LEN = 4;
const RH_ASK_MAX_MESSAGE_LEN = RH_ASK_MAX_PAYLOAD_LEN - RH_ASK_HEADER_LEN - 3;   // 60

/**
 * RadioHead's four-to-six line code: every nibble becomes a six-bit symbol with three ones and three zeros.
 *
 * Balancing the symbols that way bounds how long the line can sit at one level — at most three identical bits
 * inside a symbol and four across a join — which is what lets a receiver with no separate clock stay in step.
 */
const RH_SYMBOLS = [
  0x0d, 0x0e, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c,
  0x23, 0x25, 0x26, 0x29, 0x2a, 0x2c, 0x32, 0x34,
];

/** The reverse lookup. Bit five splits the table in half, so only eight entries are ever searched. */
function symbol6to4(symbol: number): number {
  for (let i = (symbol >> 2) & 8; i < 16; i++) {
    if (symbol === RH_SYMBOLS[i]) return i;
  }
  return 0xff;                                        // not a legal symbol
}

/**
 * Pull a RadioHead frame out of a row, returning its length in bytes or a negative failure code.
 *
 * The frame's first byte is its own length, so the loop reads one byte before it knows how many to expect. Each
 * byte occupies twelve bits on air as two six-bit symbols, both sent least significant bit first, which is why
 * the two bytes come out of the buffer reversed and then get shuffled across the byte boundary.
 */
function radioheadExtract(bits: BitBuffer, row: number, payload: Uint8Array): number {
  const len = bits.bitsPerRow[row];
  let msgLen = RH_ASK_MAX_MESSAGE_LEN;

  // Twenty-four bits of alternating run-in, then the start symbol 0xb38 sent least significant bit first.
  const initPattern = new Uint8Array([0x55, 0x55, 0x55, 0x51, 0xcd]);
  const initPatternLen = 40;

  let pos = bits.search(row, 0, initPattern, initPatternLen);
  if (pos === len) return DECODE_ABORT_EARLY;

  let nbBytes = 0;
  pos += initPatternLen;
  for (; pos < len && nbBytes < msgLen; pos += 12) {
    // Sixteen bits are read rather than twelve so the second symbol is whole; the extra four are discarded.
    const rx = bits.bytes(row, pos, 16);
    let r0 = reverse8(rx[0]);
    let r1 = reverse8(rx[1]);
    r1 = ((r1 & 0x0f) << 2) + (r0 >> 6);
    r0 &= 0x3f;

    const hiNibble = symbol6to4(r0);
    if (hiNibble > 0xf) return DECODE_FAIL_SANITY;
    const loNibble = symbol6to4(r1);
    if (loNibble > 0xf) return DECODE_FAIL_SANITY;

    payload[nbBytes] = (hiNibble << 4) | loNibble;
    if (nbBytes === 0) {
      msgLen = payload[0];
      if (msgLen < 2 || msgLen > RH_ASK_MAX_MESSAGE_LEN) break;
    }
    nbBytes++;
  }

  if (msgLen < 2) return DECODE_ABORT_LENGTH;         // too short to hold a CRC at all
  if (msgLen > RH_ASK_MAX_MESSAGE_LEN) return DECODE_ABORT_LENGTH;

  // The CRC sits in the last two bytes, least significant first, and is stored complemented.
  const crc = (payload[msgLen - 1] << 8) | payload[msgLen - 2];
  const crcRecompute = ~crc16lsb(payload, msgLen - 2, 0x8408, 0xffff) & 0xffff;
  if (crcRecompute !== crc) return DECODE_FAIL_MIC;

  return msgLen;
}

export const radioheadAsk: RDevice = register({
  num: 67,
  name: 'Radiohead ASK',
  what: 'generic hobbyist radio link',
  modulation: Modulation.OOK_PCM,
  shortWidth: 500,
  longWidth: 500,
  resetLimit: 5 * 500,
  bands: TPMS_BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;

    const payload = new Uint8Array(RH_ASK_MAX_PAYLOAD_LEN);
    const msgLen = radioheadExtract(bits, 0, payload);
    if (msgLen <= 0) return msgLen;

    // Length byte, four header bytes and two CRC bytes are framing; the rest is the sender's own.
    const dataLen = msgLen - RH_ASK_HEADER_LEN - 3;
    if (dataLen <= 0) return DECODE_FAIL_SANITY;

    const body: number[] = [];
    for (let j = 0; j < dataLen; j++) body.push(payload[5 + j]);

    ctx.emit({
      model: 'RadioHead-ASK',
      len: dataLen,
      to: payload[1],
      from: payload[2],
      id: payload[3],
      flags: payload[4],
      payload: body,
      mic: 'CRC',
    });
    return 1;
  },
});

/**
 * The same frame at half the speed, with the payload read as named fields.
 *
 * This is one product's use of RadioHead rather than a protocol of its own, so it shares every line of the
 * extraction above and differs only in bit rate and in what the bytes are called. Upstream never checks that
 * the frame is long enough to hold all eleven fields it reads, so a short one reads zeros off the end of the
 * buffer rather than being rejected; that is kept, and the buffer is sized so those reads stay in bounds.
 */
export const sensibleLiving: RDevice = register({
  num: 103,
  name: 'Sensible Living Mini-Plant Moisture Sensor',
  what: 'plant moisture probe',
  modulation: Modulation.OOK_PCM,
  shortWidth: 1000,
  longWidth: 1000,
  resetLimit: 5 * 1000,
  bands: TPMS_BANDS,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY;

    const payload = new Uint8Array(RH_ASK_MAX_PAYLOAD_LEN);
    const msgLen = radioheadExtract(bits, 0, payload);
    if (msgLen <= 0) return msgLen;

    ctx.emit({
      model: 'SensibleLiving-Moisture',
      house_id: payload[1],
      module_id: (payload[2] << 8) | payload[3],
      sensor_type: payload[4],
      sensor_count: payload[5],
      alarms: payload[6],
      sensor_value: (payload[7] << 8) | payload[8],
      battery_mV: ((payload[9] << 8) | payload[10]) * 10,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Digitech XC-0324 thermometer (120)
// ---------------------------------------------------------------------------

const XC0324_MESSAGE_BITLEN = 48;

/**
 * Three copies of a six-byte message in one row, and the decoder reports how many of them survived.
 *
 * Everything numeric arrives least significant bit first, so temperature and humidity are read back through a
 * byte reversal. The check byte is the exclusive-or of the five before it, which makes each of its bits a
 * parity bit for the bits above it — so exclusive-oring all six together must give zero.
 *
 * Only the first good copy is reported, but every good copy is counted, and that count goes out as
 * `message_num`: it is the only signal-quality figure this sensor offers.
 */
export const digitechXc0324: RDevice = register({
  num: 120,
  name: 'Digitech XC-0324 / AmbientWeather FT005TH temp/hum sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 520,
  longWidth: 1000,
  resetLimit: 3000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0x5f]);

    let events = 0;
    let ret = 0;
    let out: R433Data | null = null;

    for (let r = 0; r < bits.numRows; r++) {
      if (bits.bitsPerRow[r] < XC0324_MESSAGE_BITLEN) continue;

      let bitpos = 0;
      while ((bitpos = bits.search(r, bitpos, pre, 8)) + XC0324_MESSAGE_BITLEN <= bits.bitsPerRow[r]) {
        // The preamble byte is part of the message, so the extraction starts at the match rather than past it.
        const b = bits.bytes(r, bitpos, XC0324_MESSAGE_BITLEN);
        if (xorBytes(b, 6) !== 0x00) {
          ret = DECODE_FAIL_MIC;
        }
        else {
          ret = 1;
          events += 1;
          if (out === null) {
            const temp = ((reverse8(b[3]) & 0x0f) << 8) | reverse8(b[2]);
            out = {
              model: 'Digitech-XC0324',
              id: hexUp(b[1], 2),
              temperature_C: round1((temp - 400) * 0.1),   // tenths of a degree above minus forty
              humidity: reverse8(b[4]),
              mic: 'CHECKSUM',
            };
          }
        }
        bitpos += XC0324_MESSAGE_BITLEN;
      }
    }

    if (events > 0 && out !== null) {
      out.message_num = events;
      ctx.emit(out);
      return events;
    }
    return ret;
  },
});

// ---------------------------------------------------------------------------
// Companion WTR001 thermometer (126)
// ---------------------------------------------------------------------------

/**
 * Fourteen bits, and the temperature's seven whole degrees are scattered across seven separate positions.
 *
 * The order is 12, 7, 6, 11, 10, 9, 8 — most significant first — which no amount of shifting makes tidy, so it
 * is reassembled the way upstream does it, one group at a time. The fractional part is five bits offset by ten,
 * sent bit-reversed, and the last bit is a parity bit chosen to make the whole message odd.
 *
 * The line code is inverted: this sensor's short pulse is a one, and the slicer's convention is the opposite.
 */
export const companionWtr001: RDevice = register({
  num: 126,
  name: 'Companion WTR001 Temperature Sensor',
  what: 'thermometer',
  modulation: Modulation.OOK_PWM,
  shortWidth: 732,
  longWidth: 2196,
  gapLimit: 4000,
  resetLimit: 8000,
  syncWidth: 1464,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const r = bits.findRepeatedRow(3, 14);
    if (r < 0 || bits.bitsPerRow[r] !== 14) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(r, 0, 14);
    b[0] = ~b[0] & 0xff;
    b[1] = ~b[1] & 0xfc;                              // six bits, so the parity bit is kept and the tail cleared

    // One bit has never been seen set on a real transmission, so a set one says this is not that sensor.
    if ((b[0] & 0x04) === 0x04) return DECODE_FAIL_SANITY;
    if (!parityBytes(b, 2)) return DECODE_FAIL_MIC;   // must come out odd

    let tempTenthRaw = reverse8(b[0] & 0xf8);
    if (tempTenthRaw < 0x0a) return DECODE_FAIL_SANITY;
    if (tempTenthRaw > 0x13) return DECODE_FAIL_SANITY;
    tempTenthRaw -= 0x0a;

    const tempWholeRaw = reverse8(b[1] & 0xf0) | (reverse8(b[0] & 0x03) >> 2) | ((b[1] & 0x08) << 3);
    // The published range is -29.9 to 69.9 C; anything outside it is not a reading this device could take.
    if (tempWholeRaw < 11) return DECODE_FAIL_SANITY;
    if (tempWholeRaw > 111) return DECODE_FAIL_SANITY;

    ctx.emit({
      model: 'Companion-WTR001',
      temperature_C: round1(tempWholeRaw + tempTenthRaw * 0.1 - 41),
      mic: 'PARITY',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Telldus FT0385R weather station console (205)
// ---------------------------------------------------------------------------

/**
 * The indoor console repeating what its outdoor unit just told it, in a frame of its own.
 *
 * Every reading it has arrives at once — wind three different ways, rain over six periods, both thermometers
 * and both barometers — of which upstream reports the handful it is confident about and leaves the rest
 * commented out. That judgment is kept rather than second-guessed.
 *
 * The run-in is nine bits but the frame starts on the ninth, not after it, so the search advances by eight: the
 * last bit of the pattern is the first bit of the message and is covered by the CRC.
 *
 * When the console has not heard from outside, every outdoor field reads as a run of ones ending in 0xb, and
 * the outdoor temperature reading 0x7fb is the flag for it — the console then reports only its own room.
 */
export const telldusFt0385r: RDevice = register({
  num: 205,
  name: 'Telldus weather station FT0385R sensors',
  what: 'weather station console',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 500,
  longWidth: 0,
  gapLimit: 1200,
  resetLimit: 2400,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0x14, 0xe0]);         // nine bits

    if (bits.numRows > 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 296 && bits.bitsPerRow[1] < 296) return DECODE_ABORT_EARLY;

    let b: Uint8Array | null = null;
    for (let i = 0; i < bits.numRows; i++) {
      let pos = bits.search(i, 0, pre, 9);
      pos += 8;                                       // overlapping by one: the ninth bit belongs to the frame
      if (pos + 296 > bits.bitsPerRow[i]) continue;   // absent, or too short to be whole
      b = bits.bytes(i, pos, 296);
      break;
    }
    if (b === null) return DECODE_FAIL_SANITY;

    if (crc8(b, 37, 0x31, 0xc0)) return DECODE_FAIL_MIC;

    // The three wind fields are nine bits each, their top bits collected together in byte two.
    const degMsb = (b[2] & 0x04) >> 2;
    const gustMsb = (b[2] & 0x02) >> 1;
    const windMsb = b[2] & 0x01;
    const wind = (windMsb << 8) | b[3];
    const gust = (gustMsb << 8) | b[4];
    const windDir = (degMsb << 8) | b[5];

    const rainTot = (b[20] << 8) | b[21];
    const temp2Msb = (b[24] & 0xf0) >> 4;             // the indoor reading's top nibble shares a byte
    const tempRaw = ((b[24] & 0x0f) << 8) | b[25];
    const humidity = b[26];
    const temp2Raw = (temp2Msb << 8) | b[27];
    const humidity2 = b[28];
    const pressure = (b[29] << 8) | b[30];

    const data: R433Data = {
      model: 'Telldus-FT0385R',
      temperature_2_F: round1((temp2Raw - 400) * 0.1),
      humidity_2: humidity2,
      pressure_hPa: round1(pressure * 0.1),
      mic: 'CRC',
    };
    if (tempRaw !== 0x7fb) {
      // The outdoor unit was heard from, so its readings are real.
      data.temperature_F = round1((tempRaw - 400) * 0.1);
      data.humidity = humidity;
      data.rain_mm = round1(rainTot * 0.1);
      data.wind_dir_deg = windDir;
      data.wind_avg_m_s = round1(wind * 0.1);
      data.wind_max_m_s = round1(gust * 0.1);
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// ANT and ANT+ (216)
// ---------------------------------------------------------------------------

/**
 * Garmin's sports telemetry, which an ordinary dongle cannot hear.
 *
 * ANT lives between 2.4 and 2.5 GHz, so receiving it needs either a radio that tunes that high or a converter
 * in front of one, and at a megabit per second it wants four megasamples to decode reliably. That is why
 * upstream ships it switched off, and why it is switched off here too.
 *
 * The run-in is one byte whose value depends on the first bit of the message — 0xaa before a one, 0x55 before a
 * zero — so that the alternation continues unbroken into the data. Rather than work out which was sent, the
 * decoder searches for 0xaa, extracts, and if the CRC fails tries again one bit along, keeping whichever
 * passes. The CRC covers its own two bytes, so a good frame checks to zero.
 *
 * Nothing here reads the payload: without the eight-byte network key, which only Garmin issues, the meaning of
 * those bytes is not recoverable from the air. The two-byte on-air key does at least say whether the device is
 * on the managed ANT+ network or a private ANT one.
 */
export const antAntplus: RDevice = register({
  num: 216,
  name: 'ANT and ANT+ devices',
  what: 'sports and fitness telemetry',
  modulation: Modulation.FSK_PCM,
  shortWidth: 1,
  longWidth: 1,
  syncWidth: 8,
  gapLimit: 500,
  resetLimit: 500,
  bands: [2457025000],                                // 2.4 GHz: out of reach without a converter
  // Off by default upstream, because it needs a far higher sampling rate than the default to see anything.
  disabled: true,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const pre = new Uint8Array([0xaa]);

    if (bits.numRows < 1) return DECODE_ABORT_EARLY;
    // A message lasts under 150 microseconds, so about 140 bits at a megabit per second.
    const rowLen = bits.bitsPerRow[0];
    if (rowLen < 120 || rowLen > 200) return DECODE_ABORT_LENGTH;

    const bitOffset = bits.search(0, 0, pre, 8) + 8;
    if (bitOffset + 17 * 8 > rowLen) return DECODE_ABORT_LENGTH;

    let b = bits.bytes(0, bitOffset, 17 * 8);
    if (crc16(b, 17, 0x1021, 0xffff) !== 0) {
      b = bits.bytes(0, bitOffset + 1, 17 * 8);       // the other run-in, one bit along
      if (crc16(b, 17, 0x1021, 0xffff) !== 0) return DECODE_FAIL_MIC;
    }

    const netKey = (b[1] << 8) | b[0];                // undocumented; assumed least significant byte first
    const id = (b[3] << 8) | b[2];

    let payload = '';
    for (let i = 7; i <= 14; i++) payload += (i > 7 ? ' ' : '') + hexLow(b[i], 2);

    ctx.emit({
      model: 'Garmin-ANT',
      network: netKey === 0xc5a6 ? 'ANT+' : 'ANT',    // the one published network key
      channel: '0x' + hexLow(netKey, 4),
      id: '0x' + hexLow(id, 4),
      device_type: b[4],
      tx_type: b[5],
      payload,
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Shenzhen Wale WL-TH6R thermometer (319)
// ---------------------------------------------------------------------------

const WL_TH6R_BITS_PER_ROW = 72;

/**
 * A thermometer that whitens its own payload with a byte it then sends in clear.
 *
 * Bytes zero to six are exclusive-ored with byte seven, which also carries the pairing flag and the measurement
 * counter. That is not encryption — the key is right there in the frame — it just breaks up runs of identical
 * bits so the receiver can hold its clock, and the same exclusive-or undoes it.
 *
 * The check byte folds three things together: an exclusive-or of the payload, the low byte of its sum, and the
 * sum's carry out of that byte. **That carry is the reason the sum has to be taken at full width here** rather
 * than through the shared helper, which masks to a byte and would make the third term always zero.
 *
 * Upstream is candid that this check is weak — frames with a good check byte and a corrupted sensor id have
 * been seen — so a row is only believed if an identical one arrived as well. The row is copied before being
 * unwhitened, because upstream does that work in the shared buffer and leaves it wrecked for everything that
 * decodes afterwards when the check then fails.
 */
export const shenzhenWaleWlTh6r: RDevice = register({
  num: 319,
  name: 'Shenzhen Wale WL-TH6R Temperature & Humidity Sensor',
  what: 'thermometer and hygrometer',
  modulation: Modulation.OOK_PWM,
  tolerance: 50,
  shortWidth: 365,
  longWidth: 605,
  gapLimit: 780,
  resetLimit: 4000,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // The check is too weak to trust once, so the row has to have arrived at least twice.
    const row = bits.findRepeatedPrefix(2, WL_TH6R_BITS_PER_ROW);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] > WL_TH6R_BITS_PER_ROW + 1) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(row, 0, WL_TH6R_BITS_PER_ROW);
    for (let i = 0; i < 9; i++) b[i] = ~b[i] & 0xff;
    for (let i = 0; i < 7; i++) b[i] ^= b[7];         // unwhiten with the byte sent alongside

    const x = xorBytes(b, 7);
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += b[i];          // full width: the check byte folds the carry back in
    const mic = 0xa5 ^ x ^ (sum & 0xff) ^ (sum >> 8);
    if (b[8] !== mic) return DECODE_FAIL_MIC;

    let tempRaw = (b[3] << 8) | b[4];
    if (tempRaw & 0x8000) tempRaw -= 0x10000;         // signed sixteen bit
    const tempC = tempRaw * 0.1;
    // The sensor is specified for -20 to 60 C and does report beyond it, but the maker's own cloud will not.
    if (tempC < -20 || tempC > 60) return DECODE_FAIL_SANITY;

    const humidityPct = b[5];
    if (humidityPct > 127) return DECODE_FAIL_SANITY; // the base station refuses these too

    const batteryPct = b[6];
    const pairing = b[7] >> 7;

    const data: R433Data = {
      model: 'WL-TH6R',
      id: hexUp((b[0] << 16) | (b[1] << 8) | b[2], 6),
      battery_pct: batteryPct,
      temperature_C: round1(tempC),
      humidity: humidityPct,
      // Fresh batteries can leave the counter bits uninitialized, so anything at or above the wrap is pinned.
      cycle: (b[7] & 0x40) ? 0x40 : (b[7] & 0x3f),
      mic: 'CHECKSUM',
    };
    // Reported only when low, matching the threshold at which the maker's app sends a notification.
    if (batteryPct < 20) data.battery_ok = 0;
    if (pairing) data.pairing = pairing;
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Gear Hive tire pressure sensor (322)
// ---------------------------------------------------------------------------

/**
 * An unbranded aftermarket sensor whose payload is a running exclusive-or of itself.
 *
 * Each byte on air is the exclusive-or of the byte before it with the byte it means, seeded from the low half
 * of the sync word, so a single flipped bit corrupts every byte after it as well. Nothing checks that: the
 * final byte is labeled a checksum upstream but is read into a variable that is then commented out, so the
 * only thing standing between noise and a reading is a pair of fixed bit patterns in bytes six and seven.
 * `mic` still says CHECKSUM because upstream says so; the test asserts that byte eight is in fact never
 * verified, so the gap is recorded rather than implied.
 *
 * The pressure zero point moves with the sensor class in the second nibble, which is why it is subtracted
 * rather than the raw byte being scaled directly.
 */
function gearHiveDecode(bits: BitBuffer, ctx: DecodeCtx, row: number, bitpos: number): number {
  const payloadStart = bitpos + 16;
  if (bits.bitsPerRow[row] - payloadStart < 72) return DECODE_ABORT_LENGTH;

  const raw = bits.bytes(row, payloadStart, 72);

  const p = new Uint8Array(9);
  p[0] = raw[0] ^ 0x94;                               // seeded from the low byte of the sync word
  for (let i = 1; i < 9; i++) p[i] = raw[i] ^ raw[i - 1];

  // The only integrity this protocol offers: two runs of bits that never vary.
  if ((p[6] & 0x3c) !== 0x20) return DECODE_FAIL_SANITY;
  if ((p[7] & 0x3f) !== 0x35) return DECODE_FAIL_SANITY;

  const sensorClass = p[1] & 0x0f;
  const base = (80 + sensorClass * 64) & 0xff;        // the pressure zero point depends on the class

  ctx.emit({
    model: 'Gear-Hive',
    type: 'TPMS',
    id: hexLow((p[2] << 16) | (p[3] << 8) | p[4], 6),
    counter: ((p[1] >> 4) << 8) | p[0],
    pressure_kPa: round1(((p[5] - base + 256) & 0xff) * 6.25),
    temperature_C: ((p[7] >> 6) | ((p[6] & 0x03) << 2)) + 21,
    mic: 'CHECKSUM',
  });
  return 1;
}

export const tmpsGearHive: RDevice = register({
  num: 322,
  name: 'Gear Hive TPMS sensor',
  what: 'tire pressure sensor: unbranded aftermarket',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 120,
  longWidth: 224,
  gapLimit: 0,
  resetLimit: 800,
  bands: [433920000],
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const sync = new Uint8Array([0x25, 0x94]);

    let events = 0;
    let ret = 0;
    for (let row = 0; row < bits.numRows; row++) {
      let bitpos = 0;
      while ((bitpos = bits.search(row, bitpos, sync, 16)) + 16 + 72 <= bits.bitsPerRow[row]) {
        ret = gearHiveDecode(bits, ctx, row, bitpos);
        if (ret > 0) events += ret;
        bitpos += 16;
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// FSL cricket scoreboard controller (345)
// ---------------------------------------------------------------------------

/**
 * Not a sensor: the handset that drives a cricket scoreboard, sending one field's digits at a time.
 *
 * A transmission is a long alternating run-in followed by the same seventy-two bit block ten times over, and
 * one good copy is enough. Inside a block, three sync ones are followed by thirty-two Manchester-coded bits
 * holding four pairs: a position marker and a digit, counting the marker down from three to zero. Those markers
 * are the whole of the integrity check — there is no checksum — so all four are required to be exactly right.
 *
 * A digit of fifteen means the display is blank there rather than showing a zero, which is how the board shows
 * a two-digit score without a leading nought; blank digits contribute nothing to the value.
 */
export const fslScoreboard: RDevice = register({
  num: 345,
  name: 'FSL Cricket Scoreboard Controller',
  what: 'cricket scoreboard controller',
  modulation: Modulation.FSK_PCM,
  shortWidth: 528,
  longWidth: 528,
  resetLimit: 3000,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]);   // 32 bits of a 38-bit run-in
    const sync = new Uint8Array([0xe0]);                         // three ones

    for (let row = 0; row < bits.numRows; row++) {
      if (bits.bitsPerRow[row] < 700) continue;

      const preamblePos = bits.search(row, 0, preamble, 32);
      if (preamblePos + 38 + 72 >= bits.bitsPerRow[row]) continue;

      // Ten copies are sent; the first one that reads cleanly is taken and the rest ignored.
      for (let blockPos = preamblePos + 38; blockPos + 72 < bits.bitsPerRow[row]; blockPos += 72) {
        if (bits.search(row, blockPos, sync, 3) !== blockPos) continue;

        const decoded = new BitBuffer();
        bits.manchesterDecode(row, blockPos + 3, decoded, 32);
        if (decoded.bitsPerRow[0] < 32) continue;

        const b = decoded.bytes(0, 0, 32);
        const pos3 = b[0] >> 4, fieldId = b[0] & 0xf;
        const pos2 = b[1] >> 4, hundreds = b[1] & 0xf;
        const pos1 = b[2] >> 4, tens = b[2] & 0xf;
        const pos0 = b[3] >> 4, units = b[3] & 0xf;

        if (pos3 !== 0x3 || pos2 !== 0x2 || pos1 !== 0x1 || pos0 !== 0x0) continue;

        let value = 0;
        if (hundreds !== 0xf) value += hundreds * 100;
        if (tens !== 0xf) value += tens * 10;
        if (units !== 0xf) value += units;

        ctx.emit({ model: 'FSL-Scoreboard', id: fieldId, value });
        return 1;
      }
    }
    return DECODE_ABORT_EARLY;
  },
});
