/**
 * Multi-sensor weather stations, and one irrigation set that shares their radio.
 *
 * These are the whole-garden units rather than the bare thermometers of the earlier weather files: wind, rain,
 * light and UV alongside temperature and humidity, which means long frames and, mostly, real integrity checks.
 *
 * Three of them are worth knowing about before reading the code.
 *
 * Holman's two variants disagree with themselves about temperature. The PCM decoder holds its reading in an
 * `int` and sign-extends into it, so negative temperatures work; the PWM decoder stores the same expression in
 * a `uint16_t`, which throws the sign away again before the shift that was supposed to preserve it. Upstream's
 * comment on the PWM line still says "uses sign-extend". It does not, and this port does not either — a sensor
 * below freezing reads as roughly 409 C there. That is upstream's behavior and the test pins it.
 *
 * Sainlogic's checksum is the interesting one. Upstream computes a CRC-16 and then never acts on it: a
 * mismatch is logged and the reading is emitted anyway, labelled `mic: "CRC"`. Its own sample frame fails that
 * check, and the code comment says as much — "crc checksum here when guessed". Searching the parameter space
 * over that frame turns up exactly one conventional configuration, and it is the reflected twin of upstream's
 * own guess: CRC-16/MODBUS, poly 0xa001 (which is 0x8005 reversed), init 0xffff, over the same bytes upstream
 * already covers, stored with its high byte first. That reproduces the frame's check bytes exactly. This port
 * therefore computes the CRC that actually works, still declines to reject on it the way upstream declines,
 * and only claims `mic: "CRC"` when the check genuinely passed — an unverifiable reading should not carry the
 * same badge as a verified one.
 *
 * Vevor is a reminder rather than a surprise: its byte sum overflows a byte on real traffic (the documented
 * frame sums to 1504), but upstream narrows it with an explicit `& 0xff` before comparing, so the shared
 * masked `addBytes` is the correct helper here and not the hazard it has been elsewhere.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `holman_ws5029.c`, `cotech_36_7959.c`, `cotech_ft0203.c`,
 * `cotech_36_7900.c`, `vevor_7in1.c`, `sainlogic_sa8.c`, `bresser_garden.c`.
 */

import { BitBuffer } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import {
  addBytes, crc8, crc16, crc16lsb, extractBytesUart8n1, lfsrDigest8Reflect, xorBytes,
} from '../util.js';

const BAND_433 = [433920000];
/** The Vevor ships in a 868 MHz European build and a 915 MHz North American one, same protocol either way. */
const BAND_VEVOR = [868300000, 915000000];
/** The garden set spreads across the low 433 band, but everything sent to the soil sensor sits at 434.57. */
const BAND_GARDEN = [433920000, 434570000];

const round1 = (x: number) => Math.round(x * 10) / 10;
/** Sign-extend a sixteen-bit value, which is what a C `(int16_t)` cast does on these frames. */
const s16 = (v: number) => (v << 16) >> 16;
const hex2 = (v: number) => (v & 0xff).toString(16).padStart(2, '0');
const hexOf = (b: Uint8Array, n: number, at = 0) => {
  let s = '';
  for (let i = 0; i < n; i++) s += hex2(b[at + i] ?? 0);
  return s;
};

// ---------------------------------------------------------------------------
// AOK / Holman WS5029, the PCM build (134)
// ---------------------------------------------------------------------------

/** Sixteen compass points, as whole degrees, exactly as upstream rounds them. */
const WIND_DIR_DEG = [0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338];

/**
 * One station sold under at least four names, in two builds that differ only by whether a light sensor is
 * fitted. Both send the same header and the same first eight bytes; the fitted one simply sends a longer frame.
 *
 * The two builds are told apart by frame length and by whether the light field is zero, which is why the row's
 * total bit count is carried down here rather than just the payload. A short frame with no light reading is the
 * plain Holman; a longer one is the AOK-5056, which additionally reports UV, lux, a battery flag and a counter.
 *
 * The check is a byte-wide exclusive-or of the payload passed through a Galois digest — a single byte fed to
 * `lfsr_digest8_reflect`, which for a one-byte message is just a fixed linear map. Cheap, and enough to keep
 * unrelated 915 MHz traffic out.
 */
export const holmanWs5029pcm: RDevice = register({
  num: 134,
  name: 'AOK Weather Station rebrand Holman Industries iWeather WS5029, Conrad AOK-5056, Optex 990018',
  what: 'weather station: temperature, humidity, rain, wind, and UV on some builds',
  modulation: Modulation.FSK_PCM,
  shortWidth: 100,
  longWidth: 100,
  resetLimit: 19200,
  bands: [917000000],                              // 917.0 MHz, not the usual 915 centre
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const rowBits = bits.bitsPerRow[0];
    if (rowBits < 192) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xaa, 0xaa, 0xaa, 0x98, 0xf3, 0xa5]);
    const pos = bits.search(0, 0, preamble, 48);
    if (pos >= rowBits) return DECODE_ABORT_EARLY;

    const b = bits.bytes(0, pos + 48, 18 * 8);

    // Exclusive-or the twelve payload bytes, then run that single byte through the reflected Galois digest.
    const folded = new Uint8Array([xorBytes(b, 12)]);
    if (lfsrDigest8Reflect(folded, 1, 0x00, 0x31) !== b[12]) return DECODE_FAIL_MIC;

    const id = (b[0] << 8) | b[1];
    // An `int` holds this one, so the sign-extension survives the shift back down. The PWM sibling below is
    // where that stops being true.
    const tempC = round1((s16((b[2] << 8) | (b[3] & 0xf0)) >> 4) * 0.1);
    const humidity = ((b[3] & 0x0f) << 4) | ((b[4] & 0xf0) >> 4);
    const rainRaw = ((b[4] & 0x0f) << 8) | b[5];
    const windAvg = b[6];
    const windDir = WIND_DIR_DEG[(b[7] & 0xf0) >> 4];
    const lux = ((b[8] & 0x7f) << 10) | (b[9] << 2) | ((b[10] & 0xc0) >> 6);

    if (rowBits < 200 && lux === 0) {
      // The build with no light sensor. Its rain counter steps in units of 0.79 mm.
      ctx.emit({
        model: 'Holman-WS5029',
        type: 'Weather',
        id,
        temperature_C: tempC,
        humidity,
        rain_mm: round1(rainRaw * 0.79),
        wind_avg_km_h: round1(windAvg),
        wind_dir_deg: windDir,
        mic: 'CHECKSUM',
      });
      return 1;
    }
    if (rowBits < 221) {
      // The AOK-5056, which counts rain in whole millimetres instead and adds the light block.
      ctx.emit({
        model: 'AOK-5056',
        type: 'Weather',
        id,
        temperature_C: tempC,
        humidity,
        rain_mm: round1(rainRaw),
        wind_avg_km_h: round1(windAvg),
        wind_dir_deg: windDir,
        uvi: ((b[7] & 0x07) << 1) | ((b[8] & 0x80) >> 7),
        light_lux: lux,
        counter: ((b[10] & 0x0f) << 8) | b[11],
        battery_ok: ((b[10] & 0x30) >> 4) ? 0 : 1,
        mic: 'CHECKSUM',
      });
      return 1;
    }
    return DECODE_FAIL_OTHER;
  },
});

// ---------------------------------------------------------------------------
// Holman WS5029, the older PWM build (143) and its OOK twin (340)
// ---------------------------------------------------------------------------

/**
 * The checksum the PWM build uses: two interleaved exclusive-or sums, plus the even-index sum shifted up by
 * each set bit of the key and folded back in.
 *
 * The shifts overflow a byte and C throws the overflow away, so every partial result is narrowed here too.
 * Written locally rather than added to the shared helpers, since nothing else on the air uses it.
 */
function xorShiftBytes(m: Uint8Array, numBytes: number, shiftUp: number): number {
  let result0 = 0;
  for (let i = 0; i < numBytes; i += 2) result0 ^= m[i];
  let result1 = 0;
  for (let i = 1; i < numBytes; i += 2) result1 ^= m[i];
  let resultx = 0;
  for (let j = 0; j < 7; j++) {
    if (shiftUp & (1 << j)) resultx ^= (result0 << (j + 1)) & 0xff;
  }
  return (result0 ^ result1 ^ resultx) & 0xff;
}

/**
 * The older Holman, and the BIOWIN unit that sends the identical frame with the carrier keyed on and off
 * instead of shifted. One decode function serves both because only the modulation differs.
 *
 * The frame arrives inverted. The preamble is checked first, against its inverted form, because that can be
 * done before touching the buffer; only then is the whole buffer flipped. Upstream holds a bare pointer into
 * the buffer across that flip, so everything it reads afterwards — checksum included — is the righted data,
 * and the same is true here.
 *
 * The temperature is where this decoder parts company with its own comment. The expression casts to `int16_t`
 * to sign-extend, then stores the result in a `uint16_t`, which discards the sign again before the shift that
 * was meant to keep it. Anything below zero comes out near 409 C. Reproduced deliberately: a decoder that
 * quietly disagrees with its source is worse than one that is faithfully wrong, and the test says so out loud.
 */
function holmanPwmDecode(bits: BitBuffer, ctx: DecodeCtx): number {
  const row = bits.findRepeatedRow(3, 96);
  if (row < 0 || bits.bitsPerRow[row] !== 96) return DECODE_ABORT_LENGTH;

  const b = bits.bb[row];
  // 0xaaa598 inverted; checked before the flip, as upstream does.
  if (b[0] !== 0x55 || b[1] !== 0x5a || b[2] !== 0x67) return DECODE_FAIL_SANITY;

  bits.invert();

  if (xorShiftBytes(b, 10, 0x18) !== b[10]) return DECODE_FAIL_MIC;

  // Sixteen bits wide and unsigned, so the sign never survives. See the note above.
  const tempRaw = (((b[4] & 0x0f) << 12) | (b[5] << 4)) & 0xffff;
  const windDir = b[9] & 0x0f;

  ctx.emit({
    model: 'Holman-WS5029',
    type: 'Weather',
    id: b[3],                                      // reassigned on each power cycle
    battery_ok: (b[4] & 0x80) ? 0 : 1,
    temperature_C: round1((tempRaw >> 4) * 0.1),
    humidity: b[6],
    rain_mm: round1(((b[7] << 4) + (b[8] >> 4)) * 0.79),
    wind_avg_km_h: round1(((b[8] & 0x0f) << 4) + (b[9] >> 4)),
    wind_dir_deg: Math.trunc(windDir * 22.5),      // sixteen points, truncated as upstream truncates
    mic: 'CHECKSUM',
  });
  return 1;
}

export const holmanWs5029pwm: RDevice = register({
  num: 143,
  name: 'Holman Industries iWeather WS5029 weather station (older PWM)',
  what: 'weather station: temperature, humidity, rain and wind',
  modulation: Modulation.FSK_PWM,
  shortWidth: 488,
  longWidth: 976,
  gapLimit: 2000,
  resetLimit: 6000,
  bands: BAND_433,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) => holmanPwmDecode(bits, ctx),
});

/** The same frame keyed on and off rather than shifted, sold as BIOWIN / 2measure / Bioterm 270208. */
export const holmanWs5029pwmOok: RDevice = register({
  num: 340,
  name: 'Holman Industries iWeather WS5029 weather station (older PWM, OOK), BIOWIN 270208',
  what: 'weather station: temperature, humidity, rain and wind',
  modulation: Modulation.OOK_PWM,
  shortWidth: 488,
  longWidth: 976,
  gapLimit: 2000,
  resetLimit: 6000,
  bands: BAND_433,
  decode: (_dev, bits: BitBuffer, ctx: DecodeCtx) => holmanPwmDecode(bits, ctx),
});

// ---------------------------------------------------------------------------
// Cotech 36-7959 (153)
// ---------------------------------------------------------------------------

/**
 * A seven-in-one station sold under a long list of names — SwitchDoc FT020T, Sainlogic WS019T and FT0300,
 * Ragova FT-0310, NicetyMeter 0366 among them.
 *
 * Two rows at most, because the station sometimes sends its message twice; each is searched for a twelve-bit
 * run-in and the first row carrying a full frame behind it wins.
 *
 * The light sensor is optional on some models, and an absent one does not report zero — it reports all ones,
 * which would otherwise decode as a bright day and a UV index of 251. Upstream spots that by testing the UV
 * byte against a bound no real index reaches, and drops both light fields together when it trips. The shipped
 * capture is one of those: its UV byte is 0xfb, so it carries no light reading at all.
 *
 * Temperature is reported in Fahrenheit here, offset by 400 and scaled by ten. Upstream's local variable calls
 * it Celsius but the field it fills is `temperature_F`; the field name is what the station actually means.
 */
export const cotech367959: RDevice = register({
  num: 153,
  name: 'Cotech 36-7959, SwitchDocLabs FT020T wireless weather station with USB',
  what: 'weather station: temperature, humidity, rain, wind, light and UV',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 500,
  longWidth: 0,
  gapLimit: 1200,
  resetLimit: 1200,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows > 2) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[0] < 112 && bits.bitsPerRow[1] < 112) return DECODE_ABORT_EARLY;

    const preamble = new Uint8Array([0x01, 0x40]);  // twelve bits of it
    let b: Uint8Array | undefined;
    for (let i = 0; i < bits.numRows; i++) {
      const pos = bits.search(i, 0, preamble, 12) + 12;
      if (pos + 112 > bits.bitsPerRow[i]) continue; // absent, or too little behind it
      b = bits.bytes(i, pos, 112);
      break;
    }
    if (!b) return DECODE_FAIL_SANITY;

    if (crc8(b, 14, 0x31, 0xc0) !== 0) return DECODE_FAIL_MIC;

    // Four readings carry their top bit back in the flags nibble rather than beside the rest of the value.
    const windDir = (((b[1] & 0x04) >> 2) << 8) | b[4];
    const gust = (((b[1] & 0x02) >> 1) << 8) | b[3];
    const windAvg = ((b[1] & 0x01) << 8) | b[2];
    const uvi = b[12];
    // An unfitted light sensor reads all ones, which lands the UV index far outside its 1..15 range.
    const lightValid = uvi <= 150;

    const data: R433Data = {
      model: 'Cotech-367959',
      type: 'Weather',
      id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
      battery_ok: ((b[1] & 0x08) >> 3) ? 0 : 1,
      temperature_F: round1((((b[7] & 0x0f) << 8 | b[8]) - 400) * 0.1),
      humidity: b[9],
      rain_mm: round1((((b[5] & 0x0f) << 8) | b[6]) * 0.1),
      wind_dir_deg: windDir,
      wind_avg_m_s: round1(windAvg * 0.1),
      wind_max_m_s: round1(gust * 0.1),
      mic: 'CRC',
    };
    if (lightValid) {
      data.light_lux = (b[10] << 8) | b[11] | ((b[7] & 0x80) << 9);
      data.uvi = round1(uvi * 0.1);
    }
    ctx.emit(data);
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Cotech FT0203 / 18-3676 (369)
// ---------------------------------------------------------------------------

/**
 * A wind-only head from the same family, and the one device here with no confirmed radio behind it.
 *
 * It was reconstructed in an upstream issue from hand-transcribed hex rather than from a capture — the CRC and
 * the direction field were checked against fifty such codes, but nobody ever posted IQ. Upstream ships it
 * switched off for that reason, and the same flag is carried here, which in this app marks its readings
 * doubtful rather than silencing the decoder.
 *
 * Having no framing to lock onto, it walks every bit offset in every row looking for a sync byte, two fixed
 * 0xff bytes and a passing CRC all at once. That triple is what keeps the brute-force search honest.
 * The battery bit runs the opposite way from its 36-7959 sibling: here a one means healthy.
 */
export const cotechFt0203: RDevice = register({
  num: 369,
  name: 'Cotech FT0203/18-3676 anemometer',
  what: 'anemometer: wind speed, gust and direction',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 500,
  longWidth: 0,
  resetLimit: 1200,
  bands: BAND_433,
  disabled: true,                                  // never verified against a real capture upstream
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const b = new Uint8Array(9);
    for (let row = 0; row < bits.numRows; row++) {
      const rowBits = bits.bitsPerRow[row];
      for (let pos = 0; pos + 72 <= rowBits; pos++) {
        bits.extractBytes(row, pos, b, 72);
        if (b[0] !== 0x14 || b[6] !== 0xff || b[7] !== 0xff) continue;
        if (crc8(b, 9, 0x31, 0xc0) !== 0) continue;

        ctx.emit({
          model: 'Cotech-FT0203',
          type: 'Weather',
          id: (b[1] << 3) | (b[2] >> 5),
          battery_ok: (b[2] >> 4) & 0x01,          // one means healthy, unlike the 36-7959
          wind_dir_deg: (((b[2] >> 2) & 0x01) << 8) | b[5],
          wind_avg_m_s: round1(((b[2] & 0x01) << 8 | b[3]) * 0.1),
          wind_max_m_s: round1((((b[2] >> 1) & 0x01) << 8 | b[4]) * 0.1),
          mic: 'CRC',
        });
        return 1;
      }
    }
    return DECODE_FAIL_SANITY;
  },
});

// ---------------------------------------------------------------------------
// Cotech 36-7900 rain gauge (382)
// ---------------------------------------------------------------------------

/**
 * A rain gauge with a thermometer in it, and no checksum of any kind.
 *
 * What it has instead is a twenty-four-bit span that was zero in every one of the sixty-six distinct messages
 * upstream collected over five days. Those are almost certainly reserved bits rather than a happy accident, and
 * for the purpose of throwing out noise they work as well as a check would, so upstream tests them as one and
 * this does too. Together with the fixed marker and the requirement that the row repeat eight times, that is
 * the entire defense — which is why it ships marked doubtful.
 *
 * The rain figure is deliberately left as a raw count. It climbs by about forty per bucket tip, but nobody has
 * ever calibrated a tip against a measured volume, so converting it to millimetres would be inventing a number.
 */
export const cotech367900: RDevice = register({
  num: 382,
  name: 'Cotech 36-7900 rain gauge',
  what: 'rain gauge with a thermometer',
  modulation: Modulation.OOK_PPM,
  shortWidth: 1000,
  longWidth: 2000,
  gapLimit: 3500,
  resetLimit: 4500,
  bands: BAND_433,
  disabled: true,                                  // no computed check, only a reserved-bits plausibility test
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const row = bits.findRepeatedRow(8, 60);
    if (row < 0) return DECODE_ABORT_EARLY;
    if (bits.bitsPerRow[row] !== 60) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(row, 0, 60);
    if (b[0] !== 0xab || (b[1] >> 4) !== 0x8) return DECODE_ABORT_EARLY;

    // The stand-in for a checksum: three bytes that have never been anything but zero.
    if (b[3] !== 0x00 || b[4] !== 0x00 || b[5] !== 0x00) return DECODE_FAIL_MIC;

    let tempRaw = ((b[1] & 0x0f) << 8) | b[2];
    if (tempRaw & 0x800) tempRaw -= 0x1000;         // twelve bits, signed

    ctx.emit({
      model: 'Cotech-367900',
      type: 'Weather',
      id: (b[0] << 8) | b[1],                       // the fixed marker doubles as an id; only one unit seen
      temperature_C: round1(tempRaw * 0.1),
      rain_raw: (b[6] << 4) | (b[7] >> 4),          // no confirmed mm-per-count, so it stays a count
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Vevor 7-in-1 (263)
// ---------------------------------------------------------------------------

/**
 * A seven-in-one station from Fujian Youtong, sold as Vevor YT60231 in Europe and YT60234 in North America.
 * Same frame and same checksum on both, only the band moves.
 *
 * Everything arrives in one row on purpose. When the light reading is zero the frame contains a long enough
 * run of nothing that the slicer would otherwise split it, so the reset limit is set wide and the decoder walks
 * the row itself, looking for each run-in in turn and stepping past a whole message when one does not pan out.
 *
 * Three of its fields carry a constant 257 that has to come off before they mean anything — wind, direction and
 * rain all encode as the value plus 0x0101. The light reading uses its top bit as a times-ten flag, so a bright
 * day and a dim one are stored to different precisions.
 *
 * The checksum is a plain byte sum. It genuinely overflows on real frames — the documented one sums to 1504 —
 * but upstream narrows it explicitly before comparing, so the shared masked helper is the right one here.
 */
export const vevor7in1: RDevice = register({
  num: 263,
  name: 'Vevor Wireless Weather Station 7-in-1',
  what: 'weather station: temperature, humidity, rain, wind, light and UV',
  modulation: Modulation.FSK_PCM,
  shortWidth: 87,
  longWidth: 87,
  resetLimit: 9000,
  bands: BAND_VEVOR,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    // A gap inside the message can fake a second row, so only a single row is trusted.
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const preamble = new Uint8Array([0xaa, 0xaa, 0xca, 0xca, 0x54]);
    const rowBits = bits.bitsPerRow[0];
    let ret = DECODE_FAIL_OTHER;
    let pos = 0;

    // Each pass advances `pos` by at least the width of the run-in, so this always terminates.
    for (;;) {
      pos = bits.search(0, pos, preamble, 40);
      if (pos + 264 > rowBits) break;
      pos += 40;

      if (pos + 21 * 8 > rowBits) { ret = DECODE_ABORT_LENGTH; continue; }
      const b = bits.bytes(0, pos, 21 * 8);

      if (addBytes(b, 19) !== b[19]) { ret = DECODE_FAIL_MIC; continue; }

      if (b[0] === 0xaa && b[1] === 0) {
        let lux = ((b[16] << 8) | b[17]) - 257;
        if ((lux & 0x8000) >> 15) lux = (lux & 0x7fff) * 10;   // top bit is a times-ten flag

        ctx.emit({
          model: 'Vevor-7in1',
          type: 'Weather',
          id: (b[2] << 8) | b[3],
          channel: b[1] & 0x0f,
          battery_ok: ((b[4] & 0x80) >> 7) ? 0 : 1,
          temperature_C: round1((((b[5] << 8) | b[6]) - 500) * 0.1),
          humidity: b[7],
          wind_avg_km_h: round1((((b[8] << 8) | b[9]) - 257) / 8.333),
          wind_max_km_h: round1(b[10] / 1.25),
          wind_dir_deg: (((b[11] & 0x0f) << 8) | b[12]) - 257,
          rain_mm: round1(((((b[13] << 8) | b[14]) - 257)) * 0.233),
          uvi: (b[15] & 0x1f) - 1,
          light_lux: lux,
          mic: 'CHECKSUM',
        });
        return 1;
      }
      pos += 264;
    }
    return ret;
  },
});

// ---------------------------------------------------------------------------
// Sainlogic SA8 (293)
// ---------------------------------------------------------------------------

/**
 * An all-in-one station whose payload is carried as ordinary 8N1 serial rather than packed bits, so the frame
 * is found by its two-byte run-in and then handed to the UART extractor.
 *
 * Read the note at the top of this file about the checksum before changing anything here. In short: upstream's
 * CRC parameters do not validate upstream's own sample, upstream never rejects on the result, and the working
 * parameters are CRC-16/MODBUS over the same span. This computes the one that works, still emits whatever
 * arrives, and only claims a verified integrity check when there was one.
 *
 * The identifier is six bytes stored as three little-endian pairs, which is why it comes back out in that
 * shuffled order. Almost everything else in the frame is little-endian too, including the temperature, which is
 * the only signed field.
 */
export const sainlogicSa8: RDevice = register({
  num: 293,
  name: 'Sainlogic SA8, Gevanti SA8 Weather Station',
  what: 'weather station: temperature, humidity, rain and wind',
  modulation: Modulation.OOK_PCM,
  shortWidth: 200,
  longWidth: 200,
  resetLimit: 2500,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const rowBits = bits.bitsPerRow[0];
    const offset = bits.search(0, 0, new Uint8Array([0xfc, 0x95]), 16) + 16;
    if (offset >= rowBits) return DECODE_ABORT_EARLY;

    const b = new Uint8Array(41);
    const numBits = Math.min(rowBits - offset, b.length * 10);
    if (extractBytesUart8n1(bits.bb[0], offset, numBits, b) < 41) return DECODE_ABORT_LENGTH;

    // CRC-16/MODBUS over b[3..38], stored high byte first. Upstream's unreflected 0x8005 never matches, and
    // upstream does not reject either way, so this records the outcome instead of acting on it.
    const crcOk = crc16lsb(b, 36, 0xa001, 0xffff, 3) === ((b[39] << 8) | b[40]);

    ctx.emit({
      model: 'Sainlogic-SA8',
      type: 'Weather',
      id: hexOf(Uint8Array.from([b[4], b[3], b[6], b[5], b[8], b[7]]), 6),
      battery_ok: (b[38] & 0x10) >> 4,
      counter: (b[16] << 8) | b[15],
      temperature_C: round1(s16((b[20] << 8) | b[19]) * 0.1),
      humidity: b[21],
      wind_avg_km_h: round1(((b[30] << 8) | b[29]) * 0.036),
      wind_max_km_h: round1(((b[28] << 8) | b[27]) * 0.036),
      wind_dir_deg: (b[32] << 8) | b[31],
      rain_mm: round1(((b[34] << 8) | b[33]) * 0.42893617),
      unknown: (b[36] << 8) | b[35],               // possibly a rain-per-hour counter
      flags: (b[38] << 8) | b[37],                 // reads like a battery millivolt figure, unconfirmed
      crc_ok: crcOk ? 1 : 0,
      // Only a frame that actually verified gets to claim one; upstream labels every frame `CRC` regardless.
      ...(crcOk ? { mic: 'CRC' } : {}),
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Bresser SmartHome Garden set (384)
// ---------------------------------------------------------------------------

/** The class byte at the top of the source id says which box in the set is talking. */
function bresserGardenModel(sourceId: number): string {
  switch (sourceId >>> 24) {
    case 0x47: return 'Bresser-SoilMoisture';
    case 0x1f: return 'Bresser-WaterTimer';
    case 0x01: return 'Bresser-Gateway';
    default: return 'Bresser-Garden';
  }
}

/**
 * Not a weather station at all, but an irrigation set that shares the band and the framing conventions: a soil
 * moisture probe, a battery valve on a hose, and a mains gateway that bridges the lot to an app. Sold as
 * Bresser SmartHome Garden, Homgar and RainPoint.
 *
 * It is two-way and chatty, which is what makes it long. Every frame is the same shape — a target id, a source
 * id, a counter, a type byte, a payload length, then a fixed thirty-three bytes ending in a CRC that never
 * moves regardless of how much payload there is. The type byte's top bit marks a reply, so an acknowledgement
 * is always the request's type with bit seven set, echoing its counter.
 *
 * The model reported is the sender's, taken from the class byte at the top of its source id, so an
 * acknowledgement from the gateway is a gateway reading rather than being lumped in with the sensor it answers.
 *
 * In normal operation the soil probe reports to the valve, which relays the reading onward and adds the signal
 * strength it saw; turning off relaying in the app makes the probe talk to the gateway directly, in a shorter
 * form, on a different frequency. Both paths are decoded. The valve stores its watering schedule and runs it on
 * its own clock, so watering carries on with the gateway unplugged.
 *
 * Anything not recognized is still emitted, with its payload as raw hex, rather than guessed at — which is what
 * upstream does and the honest thing to do with a protocol this incompletely mapped.
 */
export const bresserGarden: RDevice = register({
  num: 384,
  name: 'Bresser SmartHome Garden soil moisture and water timer valve (Baldr Homgar, RainPoint)',
  what: 'garden irrigation set: soil moisture, water timer valve and gateway',
  modulation: Modulation.FSK_PCM,
  shortWidth: 50,
  longWidth: 50,
  resetLimit: 10000,
  bands: BAND_GARDEN,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_FAIL_SANITY;

    const msgLen = bits.bitsPerRow[0];
    // The soil probe leads with a wake-up preamble that pushes its frames past 1500 bits; nothing runs longer.
    if (msgLen > 2000) return DECODE_ABORT_LENGTH;

    const preamble = new Uint8Array([0xaa, 0xf3, 0xe9, 0x10, 0x5e, 0x51]);
    let offset = bits.search(0, 0, preamble, 48);
    if (offset >= msgLen) return DECODE_ABORT_EARLY;
    offset += 48;

    // Checked after stepping over the run-in: a whole frame has to fit behind it, not merely somewhere in the row.
    if (msgLen - offset < 33 * 8) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, offset, 33 * 8);
    if (crc16(b, 33, 0x1021, 0xd636) !== 0) return DECODE_FAIL_MIC;

    const targetId = ((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0;
    const sourceId = ((b[7] << 24) | (b[6] << 16) | (b[5] << 8) | b[4]) >>> 0;
    const counter = b[8];
    const msgType = b[9];
    const msgLength = b[10];
    const acknowledgement = msgType >> 7;
    const model = bresserGardenModel(sourceId);

    // The payload runs b[11]..b[30]; the last two of the fixed thirty-three are the CRC. A longer declared
    // length cannot be real whatever the CRC says, so it is refused rather than read past the end.
    if (msgLength > 20) return DECODE_FAIL_SANITY;

    const payloadHex = () => hexOf(b, Math.min(msgLength, 20), 11);
    const base = { model, type: 'Weather' as const, id: sourceId, msg_counter: counter, mic: 'CRC' };

    // Init and pairing announce, sent at power-up and re-announced periodically.
    if (msgType === 0x01 && (msgLength === 0x07 || msgLength === 0x08)) {
      ctx.emit({
        ...base, msg_name: 'Init Pairing', target_id: targetId,
        device_type: b[11], firmware: b[17], msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
      });
      return 1;
    }
    // The gateway's answer to a soil probe's init. Its payload varies between captures and is left raw.
    if (msgType === 0x81 && msgLength === 0x10) {
      ctx.emit({
        ...base, msg_name: 'Pairing ack', target_id: targetId, acknowledgement,
        msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
      });
      return 1;
    }
    // Soil probe straight to the gateway, sent when relaying is switched off in the app. Same reading block as
    // the relayed form below, minus the probe address and a spacer, so the markers land two bytes earlier.
    if (msgType === 0x03 && msgLength === 0x07) {
      ctx.emit({
        ...base, msg_name: 'Soil telemetry', station_id: targetId, device_type: b[11],
        msg_type: msgType,
        temperature_F: round1(s16((b[17] << 8) | b[16]) * 0.1),
        moisture: b[14],                           // b[13] and b[15] are field markers, not data
        battery_ok: ((b[12] & 0x10) >> 4) ? 0 : 1,
        battery_level: b[12] & 0x0f,
      });
      return 1;
    }
    // Empty acknowledgements: the acked type with bit seven set, echoing its counter.
    if ((msgType === 0x83 || msgType === 0x84 || msgType === 0x89 || msgType === 0x8a) && msgLength === 0x01) {
      ctx.emit({
        ...base, msg_name: 'Acknowledgement', target_id: targetId, acknowledgement,
        msg_type: msgType, msg_length: msgLength,
      });
      return 1;
    }
    // The valve relaying the probe's reading onward, with the signal strength it measured inserted at b[13].
    if (msgType === 0x0a && msgLength === 0x09) {
      ctx.emit({
        ...base, msg_name: 'Relay telemetry', station_id: targetId, device_type: b[11],
        sensor_number: b[12], msg_type: msgType,
        temperature_F: round1(s16((b[19] << 8) | b[18]) * 0.1),
        moisture: b[16],
        soil_rssi: b[13],                          // raw register; the dBm fit upstream quotes is empirical
        battery_ok: ((b[14] & 0x10) >> 4) ? 0 : 1,
        battery_level: b[14] & 0x0f,
      });
      return 1;
    }
    // The probe's own reading, as sent to the valve — the message the relay above forwards.
    if (msgType === 0x09 && msgLength === 0x09) {
      ctx.emit({
        ...base, msg_name: 'Soil telemetry', station_id: targetId, device_type: b[11],
        sensor_number: b[12], msg_type: msgType,
        temperature_F: round1(s16((b[19] << 8) | b[18]) * 0.1),
        moisture: b[16],
        battery_ok: ((b[14] & 0x10) >> 4) ? 0 : 1,
        battery_level: b[14] & 0x0f,
      });
      return 1;
    }
    // A watering run that actually delivered water. Scheduled slots are skipped while the soil is wet enough,
    // so these are rarer than the schedule implies.
    if (msgType === 0x04 && msgLength === 0x0e) {
      ctx.emit({
        ...base, msg_name: 'Watering', station_id: targetId, sensor_number: b[11], msg_type: msgType,
        programme: (b[14] << 8) | b[15],           // big-endian on purpose, so its hex reads as sent
        cycle_counter: b[16] | (b[17] << 8),
        trigger: b[18],
        water_usage_l: round1((b[19] | (b[20] << 8)) * 0.1),   // metered, not computed from run time
        duration_s: b[23] | (b[24] << 8),          // wall clock, so misting pauses count
      });
      return 1;
    }
    // The schedule and duration settings, pushed whenever they change in the app.
    if (msgType === 0x85 && msgLength === 0x0f) {
      ctx.emit({
        ...base, msg_name: 'Schedule config', target_id: targetId, sensor_number: b[18], msg_type: msgType,
        default_duration_s: b[12] | (b[13] << 8),
        mist_run_s: b[14] | (b[15] << 8),
        mist_interval_s: b[16] | (b[17] << 8),
        stop_moisture: b[19],                      // a plan is skipped while the soil is wetter than this
        flow_rate: (b[24] << 24) >> 24,            // signed byte: the app's -20..+20 per cent trim
        unknown: b[22],
      });
      return 1;
    }
    // A settings-edit counter, sometimes carrying the setting that changed.
    if (msgType === 0x20 && (msgLength === 0x02 || msgLength === 0x03)) {
      const hasChannel = msgLength === 0x03 && b[12] === 0x04;
      ctx.emit({
        ...base, msg_name: 'Config change', target_id: targetId, msg_type: msgType, config_counter: b[11],
        ...(hasChannel ? { rf_channel: b[13] } : {}),
      });
      return 1;
    }
    // The watering plan table, one seven-byte record per plan, paged when it does not fit.
    if (msgType === 0x86 && (msgLength === 0x08 || msgLength === 0x0f)) {
      const dayMode = ['unknown', 'every day', 'odd days', 'even days', 'weekly', 'unknown', 'unknown', 'unknown'];
      const plans: R433Data[] = [];
      const nPlans = ((msgLength - 1) / 7) | 0;
      // Two records is all a thirty-three byte frame holds; the bound also keeps the reads off the CRC.
      for (let p = 0; p < nPlans && plans.length < 2 && (12 + p * 7 + 6) < 33; p++) {
        const at = 12 + p * 7;
        plans.push({
          model,                                   // the shape every reading carries; a plan is a nested one
          plan: plans.length + 1,                  // position in THIS message, not the app's plan number
          enabled: (b[at] & 0x80) ? 1 : 0,
          irrigation: (b[at + 2] & 0x80) ? 'misting' : 'normal',
          start_hour: ((b[at + 2] & 0x07) << 2) | (b[at + 1] >> 6),
          start_minute: b[at + 1] & 0x3f,
          day_mode: dayMode[(b[at + 2] >> 3) & 0x07],
          weekday_mask: b[at] & 0x7f,
          duration_s: b[at + 3] | (b[at + 4] << 8),
          water_limit_l: round1((b[at + 5] | (b[at + 6] << 8)) / 10),
        });
      }
      ctx.emit({
        ...base, msg_name: 'Schedule', target_id: targetId, msg_type: msgType,
        more_parts: b[11] ? 1 : 0, plans,
      });
      return 1;
    }
    // A run command, or the recurring keep-alive that shares its type.
    if (msgType === 0x21 && msgLength >= 0x03) {
      const variant = b[12];
      const mode = b[13];
      let durationS = msgLength >= 0x04 ? b[14] : 0;
      if (msgLength >= 0x05) durationS |= b[15] << 8;
      const isRun = variant === 0x02;
      ctx.emit({
        ...base,
        msg_name: !isRun ? 'Heartbeat' : (mode === 0 ? 'Run stop' : 'Run start'),
        target_id: targetId, msg_type: msgType,
        ...(isRun ? { mode } : {}),
        ...(isRun && msgLength >= 0x04 ? { duration_s: durationS } : {}),
        ...(!isRun && msgLength >= 0x04 ? { heartbeat_interval_s: durationS } : {}),
        msg: payloadHex(),
      });
      return 1;
    }
    // The valve's replies to the gateway's control frames: a bare ack, a run state, or an unexplained beacon.
    if (msgType === 0xa1 || msgType === 0xa0) {
      const hasRun = msgType === 0xa1 && msgLength >= 0x0d
        && b[13] === 0x9f && b[18] === 0x81 && b[21] === 0xad;
      ctx.emit({
        ...base,
        msg_name: msgType === 0xa0 ? 'Acknowledgement' : (hasRun ? 'Run response' : 'Beacon'),
        target_id: targetId, msg_type: msgType, acknowledgement,
        ...(hasRun ? {
          trigger: b[12],
          duration_s: b[22] | (b[23] << 8),
          remaining_s: b[19] | (b[20] << 8),
          water_usage_l: round1((b[14] | (b[15] << 8)) * 0.1),   // the last COMPLETED run, not this one
        } : {}),
        msg: payloadHex(),
      });
      return 1;
    }
    // The gateway's answer to a status poll, sometimes carrying its free-running clock.
    if (msgType === 0x82 && msgLength >= 0x02) {
      ctx.emit({
        ...base, msg_name: 'Status response', target_id: targetId, msg_type: msgType, config_counter: b[12],
        // Seconds-scale and cloud-disciplined, so it jumps; not a wall clock and it wraps twice a year.
        ...(msgLength >= 0x05 ? { gateway_time: (b[13] | (b[14] << 8) | (b[15] << 16)) >>> 0 } : {}),
        msg: payloadHex(),
      });
      return 1;
    }
    // The gateway's answer to a moisture fetch.
    if (msgType === 0x88 && msgLength >= 0x03) {
      ctx.emit({
        ...base, msg_name: 'Moisture response', target_id: targetId, msg_type: msgType,
        moisture: b[13], msg: payloadHex(),
      });
      return 1;
    }
    // The valve's polls. Only the status report carries anything, and only behind its markers.
    if (msgType === 0x02 || msgType === 0x05 || msgType === 0x06 || msgType === 0x08) {
      const hasRun = msgType === 0x02 && msgLength >= 0x0f && b[20] === 0x81 && b[23] === 0xad;
      ctx.emit({
        ...base,
        msg_name: msgType === 0x02 ? 'Status report'
          : msgType === 0x05 ? 'Config request'
            : msgType === 0x08 ? 'Moisture request' : 'Schedule request',
        target_id: targetId, msg_type: msgType, msg_length: msgLength,
        ...(hasRun ? {
          trigger: b[14],
          duration_s: b[24] | (b[25] << 8),
          remaining_s: b[21] | (b[22] << 8),
          water_usage_l: round1((b[16] | (b[17] << 8)) * 0.1),
        } : {}),
        msg: payloadHex(),
      });
      return 1;
    }

    // Everything still unmapped, emitted with its payload raw rather than guessed at.
    ctx.emit({
      ...base, msg_name: 'Unknown msg', target_id: targetId, acknowledgement,
      msg_type: msgType, msg_length: msgLength, msg: payloadHex(),
    });
    return 1;
  },
});
