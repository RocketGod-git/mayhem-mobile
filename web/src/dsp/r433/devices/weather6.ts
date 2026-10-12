/**
 * The four that kept getting deferred: a thermometer that also tells the time, a data logger, a wind sensor
 * behind three layers of coding, and a four-in-one weather set with bit-stuffed parity.
 *
 * None of these is hard for the usual reason. They were left until last because each one does something no
 * other decoder in the tree does.
 *
 * The Emos TTX201 spreads one message across eight repeats and reports either a temperature or, on the hour,
 * the time it heard from a DCF77 broadcast. Which one arrived is a three-bit field, and the two layouts share
 * no fields at all beyond the checksum.
 *
 * The TFA wind sensor is the interesting one. Its line coding is return-to-zero inverted — the carrier sits
 * high and dips briefly, so a *short* interval is a zero and a long run is a string of ones, the opposite of
 * this project's usual convention. On top of that raw stream sit three more transforms: a differential phase
 * decode, a differential NRZ-S decode, and a self-synchronizing G3RUH descrambler, and only then does a sync
 * word appear. Each of those is its own inverse given the preceding one, which is what makes the frame
 * recoverable at all — and what lets the tests build a real frame by running the chain forwards.
 *
 * Hideki carries a parity bit after every eight, so nothing is byte aligned until the stuffing is removed,
 * and it packs four different sensors into one protocol told apart purely by how many bytes survive. It also
 * has two upstream quirks that are preserved deliberately and described where they occur.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `ttx201.c`, `arexx_ml.c`, `tfa_30_3307.c`, `hideki.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { addNibbles, crc8, crc8le, parity8, reflectBytes, xorBytes } from '../util.js';

const BAND_433 = [433920000];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const pad2 = (n: number) => n.toString().padStart(2, '0');
/** One bit out of a row, MSB first — rtl_433's `bitrow_get_bit`. */
const bitrowGetBit = (row: Uint8Array, pos: number) => (row[pos >> 3] >> (7 - (pos & 7))) & 1;

// ---------------------------------------------------------------------------
// Emos TTX201 (111)
// ---------------------------------------------------------------------------

/**
 * One packet of the eight. Returns a count, so the caller can stop at the first that checks out.
 *
 * The frame is 54 bits, which is not a whole number of bytes, and the two leading bits are padding — so
 * everything is read from bit two onward, which is what puts the checksum nibble at the top of the first byte.
 * The last repeat is two bits shorter because it drops the trailing separator.
 */
function ttx201Packet(bits: BitBuffer, row: number, ctx: DecodeCtx): number {
  const rowlen = bits.bitsPerRow[row];
  if (rowlen !== 50 && rowlen !== 54) return DECODE_ABORT_LENGTH;

  const b = bits.bytes(row, 2, 56);                // skip the two pad bits, take the packet whole
  const chk = b[0] & 0x3f;
  // Ten nibbles, so at most 150 — under the byte this app's helper narrows to, and safe to use as is.
  const sum = addNibbles(b, 5, 1);
  const dataType = (b[2] & 0x70) >> 4;

  if (sum === 0) return DECODE_ABORT_EARLY;        // an empty row would otherwise check out
  if (chk !== (sum & 0x3f)) return DECODE_FAIL_MIC;

  if (dataType === 0x05) {
    // The sensor heard a time broadcast, so this repeat carries a clock instead of a reading.
    const year = b[1] & 0x7f;
    const month = b[2] & 0x0f;
    const day = (b[3] & 0xf8) >> 3;
    const hour = ((b[3] & 0x07) << 2) | ((b[4] & 0xc0) >> 6);
    const minute = b[4] & 0x3f;
    const second = (b[5] & 0x7e) >> 1;
    const zone = (b[1] & 0x80) ? 'CEST' : 'CET';
    ctx.emit({
      model: 'Emos-TTX201',
      type: 'Weather',
      radio_clock: `${year + 2000}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)} ${zone}`,
      mic: 'CHECKSUM',
    });
    return 1;
  }

  // Twelve signed bits sitting high in a word, which is how the sign comes out for free.
  const raw = ((((b[3] & 0x0f) << 12) | (b[4] << 4)) << 16) >> 16;
  ctx.emit({
    model: 'Emos-TTX201',
    type: 'Weather',
    id: b[1],
    channel: (b[2] & 0x07) + 1,
    battery_ok: (b[2] & 0x08) ? 0 : 1,
    temperature_C: round1((raw >> 4) * 0.1),
    mic: 'CHECKSUM',
  });
  return 1;
}

export const ttx201: RDevice = register({
  num: 111,
  name: 'Emos TTX201 Temperature Sensor',
  what: 'thermometer with a radio clock',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 510,
  longWidth: 0,                                    // unused for Manchester
  resetLimit: 1700,
  tolerance: 250,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let ret = 0;
    let events = 0;
    // A whole transmission is a preamble row, eight repeats and a stray bit — anything outside that is noise.
    if (bits.numRows >= 2 && bits.numRows <= 10) {
      for (let row = 0; row < bits.numRows; row++) {
        ret = ttx201Packet(bits, row, ctx);
        if (ret > 0) events += ret;
        if (events) return events;                 // one good repeat is the whole message
      }
    }
    return events > 0 ? events : ret;
  },
});

// ---------------------------------------------------------------------------
// Arexx Multilogger IP-HA90 / IP-TH78EXT / TSN-70E (264)
// ---------------------------------------------------------------------------

/**
 * A family of data loggers that alternate temperature and humidity every forty-five seconds or so.
 *
 * The length byte picks the layout, and within a length the low bits of the id pick the sensor: even means
 * temperature, odd means humidity, and different id ranges mean different silicon with different conversions.
 * A five-byte message from one range is a Microchip part counting in 1/128 °C; from another it is a Sensirion
 * part needing an offset that upstream notes varies with supply voltage. None of that is guesswork on this
 * side — every branch is upstream's.
 *
 * Its own doc block says the check is a CRC with init 0xc0, and its code uses 0x00. All five of the example
 * messages it publishes verify with 0x00 and none with 0xc0, so the code is right and the comment is not.
 */
export const arexxMl: RDevice = register({
  num: 264,
  name: 'Arexx Multilogger IP-HA90, IP-TH78EXT, TSN-70E',
  what: 'temperature and humidity logger',
  modulation: Modulation.FSK_MANCHESTER_ZEROBIT,
  shortWidth: 208,                                 // 2400 bit/s Manchester
  longWidth: 208,
  resetLimit: 450,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 64 || bits.bitsPerRow[0] > 140) return DECODE_ABORT_EARLY;

    bits.invert();                                 // the line coding is the other way up

    const preamble = new Uint8Array([0xaa, 0xaa, 0x55]);
    const b = new Uint8Array(9);
    let msgLen = -1;
    for (let i = 0; i < bits.numRows; i++) {
      const pos = bits.search(i, 0, preamble, 24) + 24;
      if (pos + 64 > bits.bitsPerRow[i]) continue;
      bits.extractBytes(i, pos, b, 9 * 8);
      msgLen = b[0];
      break;
    }
    if (msgLen <= 0) return DECODE_FAIL_SANITY;
    if (msgLen > 7) return DECODE_FAIL_SANITY;     // nine bytes less the two checksums

    if (crc8le(b, msgLen, 0x31, 0x00) !== b[msgLen]) return DECODE_FAIL_MIC;

    let id = (b[2] << 8) | b[1];                   // little-endian
    let sensRaw = (b[3] << 8) | b[4];
    const out: R433Data = { model: 'Arexx-ML', type: 'Weather', mic: 'CRC' };

    if (msgLen === 5 && (id & 0xf000) === 0x2000) {
      out.temperature_C = round2(((sensRaw << 16) >> 16) * 0.0078125);
    }
    else if (msgLen === 5 && (id & 0xf001) === 0x4000) {
      out.temperature_C = round2(sensRaw * 0.01 - 40.0);   // the offset drifts with supply voltage
    }
    else if (msgLen === 5 && (id & 0xf001) === 0x4001) {
      sensRaw = (sensRaw << 16) >> 16;
      out.humidity = round1(-2.0468 + 0.0367 * sensRaw - 1.5955e-6 * sensRaw * sensRaw);
    }
    else if (msgLen === 6) {
      // A Microchip ambient-temperature register: three alert bits above a signed thirteen-bit reading.
      out.temperature_alert = (sensRaw >> 13) & 7;
      out.temperature_C = Math.trunc(((sensRaw << 3) << 16) >> 16) / 128;
    }
    else if (msgLen === 7) {
      // Some units carry a wider id, which pushes the reading along by a byte.
      id = (b[3] << 16) | (b[2] << 8) | b[1];
      sensRaw = (b[5] << 8) | b[6];                // b[4] is unused and constant per device
      if (id & 1) {
        sensRaw = (sensRaw << 16) >> 16;
        out.humidity = round1(-2.0468 + 0.0367 * sensRaw - 1.5955e-6 * sensRaw * sensRaw);
      }
      else {
        out.temperature_C = round2(sensRaw * 0.01 - 40.0);
      }
    }

    out.id = id;
    out.sensor_raw = sensRaw & 0xffff;
    ctx.emit(out);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// TFA 30.3307.02 wind sensor (367)
// ---------------------------------------------------------------------------

/**
 * A wind sensor from TFA's WeatherHub range, and the most heavily coded frame in this app.
 *
 * The radio layer is return-to-zero inverted: the carrier is high nearly all the time and dips for about
 * thirty microseconds to mark a zero, so a long high run stands for however many one-bits fit in it. That
 * gives a raw bitstream, and three transforms then sit on top of it — a differential phase decode, a
 * differential NRZ-S decode, and a G3RUH self-synchronizing descrambler whose taps are bits 16 and 11 of a
 * shift register fed with the NRZ-S output. Only after all three does a sync word appear, and the decoder
 * simply runs the whole row through the chain watching for it.
 *
 * The first byte after the sync says where the CRC-32 sits, and the byte after that says which kind of
 * WeatherHub sensor is talking — which matters because the CRC's starting value is chosen per sensor type.
 * Only the wind sensor's is known, so any other type is left alone rather than checked against a guess.
 *
 * The payload holds six readings taken a couple of minutes apart, most recent first. Only the most recent is
 * reported, as upstream does. Its speed and gust fields are nine bits each with the top bit parked away from
 * the other eight, which is why they are reassembled rather than masked out.
 */
export const tfa303307: RDevice = register({
  num: 367,
  name: 'TFA 30.3307.02 Wind sensor',
  what: 'wind sensor',
  modulation: Modulation.OOK_RZI,
  shortWidth: 30,                                  // the dip that marks a zero
  longWidth: 167,                                  // one bit period of carrier
  resetLimit: 500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const len = bits.bitsPerRow[0];
    const row = bits.bb[0];

    let lastBit = 0, psk = 0, lastPsk = 0, nrzs = 0;
    let lfsr = 0, sr = 0, srCount = -1;
    const rdata = new Uint8Array(48);
    let byteCount = 0;

    for (let i = 0; i < len && byteCount < rdata.length; i++) {
      const bit = bitrowGetBit(row, i);
      if (bit === lastBit) psk = 1 - psk;          // differential phase
      if (psk === lastPsk) nrzs = 1 - nrzs;        // differential NRZ-S
      lastBit = bit;
      lastPsk = psk;

      const descrambled = nrzs ^ ((lfsr >>> 16) & 1) ^ ((lfsr >>> 11) & 1);
      lfsr = ((lfsr << 1) | nrzs) >>> 0;
      sr = ((sr >>> 1) | (descrambled << 31)) >>> 0;

      if (sr === 0x2bd42d4b) {
        srCount = 0;
        rdata[0] = sr & 0xff;
        rdata[1] = (sr >>> 8) & 0xff;
        rdata[2] = (sr >>> 16) & 0xff;
        byteCount = 3;
      }
      if (srCount === 0) {
        rdata[byteCount] = (sr >>> 24) & 0xff;
        byteCount++;
      }
      if (srCount >= 0) srCount = (srCount + 1) & 7;
    }

    if (byteCount < 12) return DECODE_ABORT_LENGTH;

    const plen = rdata[4];
    if (plen < 11 || plen + 4 > byteCount) return DECODE_ABORT_LENGTH;

    // The sensor type chooses the CRC's starting value; only the wind sensor's is known.
    if (rdata[5] !== 0x0b) return DECODE_ABORT_EARLY;

    let crc = 0xe7720ae4;
    for (let i = 4; i < plen; i++) {
      crc = (crc ^ (rdata[i] << 24)) >>> 0;
      for (let k = 0; k < 8; k++) {
        crc = (crc & 0x80000000) ? (((crc << 1) ^ 0x04c11db7) >>> 0) : ((crc << 1) >>> 0);
      }
    }
    const crcMsg = (((rdata[plen] << 24) >>> 0) | (rdata[plen + 1] << 16)
      | (rdata[plen + 2] << 8) | rdata[plen + 3]) >>> 0;
    if (crc !== crcMsg) return DECODE_FAIL_MIC;

    if (plen - 11 < 7) return DECODE_FAIL_SANITY;

    const msg = rdata.subarray(11);
    const v = (((msg[3] << 24) >>> 0) | (msg[4] << 16) | (msg[5] << 8) | msg[6]) >>> 0;

    let idStr = '';
    for (let i = 0; i < 6; i++) idStr += rdata[5 + i].toString(16).padStart(2, '0');

    ctx.emit({
      model: 'TFA-303307',
      type: 'Weather',
      id: idStr,
      // Nine-bit fields whose top bit sits apart from the other eight.
      wind_dir_deg: round1(22.5 * (v >>> 28)),
      wind_avg_m_s: round1((((v >>> 16) & 0xff) + 256 * ((v >>> 25) & 1)) / 10),
      wind_max_m_s: round1((((v >>> 8) & 0xff) + 256 * ((v >>> 24) & 1)) / 10),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Hideki TS04 / Bresser 5CH (42)
// ---------------------------------------------------------------------------

/** Which of the four sensors is talking is decided purely by how many bytes survive unstuffing. */
const HIDEKI_WIND = 14, HIDEKI_TS04 = 10, HIDEKI_RAIN = 9, HIDEKI_TEMP = 8;
/** The wind vane's sixteen positions are not in compass order on the wire. */
const HIDEKI_WIND_DIR = [0, 15, 13, 14, 9, 10, 12, 11, 1, 2, 4, 3, 8, 7, 5, 6];
const HIDEKI_APPROACH = [0, 1, -1, 2];             // none, clockwise, counter-clockwise, invalid

export const hidekiTs04: RDevice = register({
  num: 42,
  name: 'HIDEKI TS04 Temperature, Humidity, Wind and Rain Sensor',
  what: 'weather station: temperature, humidity, wind and rain',
  modulation: Modulation.OOK_DMC,
  shortWidth: 520,
  longWidth: 1040,
  resetLimit: 4000,
  tolerance: 240,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    let ret = 0;

    for (let row = 0; row < bits.numRows; row++) {
      // Every eight bits carry a ninth parity bit, so the byte count comes from the row length.
      let unstuffedLen = ((bits.bitsPerRow[row] + 4) / 9) | 0;
      const sensorType = unstuffedLen;
      if (unstuffedLen !== HIDEKI_WIND && unstuffedLen !== HIDEKI_TS04
        && unstuffedLen !== HIDEKI_RAIN && unstuffedLen !== HIDEKI_TEMP) {
        ret = DECODE_ABORT_LENGTH;
        continue;
      }
      unstuffedLen -= 1;                           // the sync word is not part of the packet

      const b = bits.bb[row];
      // The run-in is checked before the inversion below, so it is read the way it arrives.
      let sync = (b[0] << 1) | (b[1] >> 7);
      let startpos = -1;
      for (let i = 0; i < 4; i++) {
        if (sync === 0x0d) { startpos = 9 - i; break; }
        sync >>= 1;
      }
      if (startpos < 0) { ret = DECODE_ABORT_EARLY; continue; }

      // Upstream inverts the shared buffer here, inside the row loop, so a second pass would see it turned
      // back the right way up and fail its own run-in check. Preserved: it is what decides real traffic.
      bits.invert();

      const packet = new Uint8Array(14);
      let unstuffError = 0;
      for (let i = 0; i < unstuffedLen; i++) {
        const offset = startpos + i * 9;
        packet[i] = ((b[(offset / 8) | 0] << (offset % 8)) | (b[((offset / 8) | 0) + 1] >> (8 - (offset % 8)))) & 0xff;
        const parity = (b[((offset / 8) | 0) + 1] >> (7 - (offset % 8))) & 1;
        if (parity !== parity8(packet[i])) {
          ret = DECODE_FAIL_MIC;
          unstuffError = i;
          break;
        }
      }
      // Upstream tests the index rather than a flag, so a parity failure on the very first byte reads as
      // "no error" and falls through to the checksums below. Kept, because the checksums then catch it.
      if (unstuffError) continue;

      if (xorBytes(packet, unstuffedLen - 1) !== 0) { ret = DECODE_FAIL_MIC; continue; }
      if (crc8(packet, unstuffedLen, 0x07, 0x00) !== 0) { ret = DECODE_FAIL_MIC; continue; }

      reflectBytes(packet, unstuffedLen);          // only now are the fields the right way round

      const pktLen = (packet[1] >> 1) & 0x1f;
      if (pktLen + 2 !== unstuffedLen) { ret = DECODE_ABORT_LENGTH; continue; }

      let channel = (packet[0] >> 5) & 0x0f;
      if (channel >= 5) channel -= 1;              // channel 5 is spelled 6 on the wire
      const rc = packet[0] & 0x0f;
      let temp = (packet[4] & 0x0f) * 100 + ((packet[3] & 0xf0) >> 4) * 10 + (packet[3] & 0x0f);
      if (((packet[4] >> 7) & 1) === 0) temp = -temp;
      const batteryOk = (packet[4] >> 6) & 1;

      const common = { id: rc, channel, battery_ok: batteryOk, mic: 'CRC' as const };

      if (sensorType === HIDEKI_TS04) {
        ctx.emit({
          model: 'Hideki-TS04', type: 'Weather', ...common,
          temperature_C: round1(temp / 10),
          humidity: ((packet[5] & 0xf0) >> 4) * 10 + (packet[5] & 0x0f),
        });
        return 1;
      }
      if (sensorType === HIDEKI_WIND) {
        ctx.emit({
          model: 'Hideki-Wind', type: 'Weather', ...common,
          temperature_C: round1(temp * 0.1),
          wind_avg_mi_h: round2(((packet[8] & 0x0f) * 100 + (packet[7] >> 4) * 10 + (packet[7] & 0x0f)) * 0.1),
          wind_max_mi_h: round2(((packet[9] >> 4) * 100 + (packet[9] & 0x0f) * 10 + (packet[8] >> 4)) * 0.1),
          wind_approach: HIDEKI_APPROACH[(packet[10] >> 2) & 0x03],
          wind_dir_deg: round1(HIDEKI_WIND_DIR[(packet[10] & 0xf0) >> 4] * 225 * 0.1),
        });
        return 1;
      }
      if (sensorType === HIDEKI_TEMP) {
        ctx.emit({
          model: 'Hideki-Temperature', type: 'Weather', ...common,
          temperature_C: round1(temp * 0.1),
        });
        return 1;
      }
      if (sensorType === HIDEKI_RAIN) {
        ctx.emit({
          model: 'Hideki-Rain', type: 'Weather', ...common,
          battery_ok: (packet[1] >> 6) & 1,        // the rain gauge keeps its battery bit elsewhere
          rain_mm: round1(((packet[4] << 8) | packet[3]) * 0.7),
        });
        return 1;
      }
      return DECODE_FAIL_SANITY;
    }
    return ret;
  },
});
