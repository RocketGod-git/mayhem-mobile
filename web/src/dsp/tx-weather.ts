/**
 * TRANSMIT encoder for a spoofed 433.92 MHz weather sensor — a harmless novelty transmitter for the "Troll"
 * app, of the kind Mayhem / Flipper firmware ship. It builds a valid OOK frame that the app's OWN rtl_433
 * decoder (dsp/r433/devices/acurite.ts) reads back as a real reading, so an indoor weather display tuned to
 * that sensor shows a phantom channel with whatever temperature and humidity you pick.
 *
 * TARGET: the Acurite 592TXR / "Acurite-Tower" temperature+humidity sensor — rtl_433 protocol number 40,
 * message type 0x04. It has the cleanest fixed-length frame in the Acurite family: seven bytes, a plain
 * byte-sum check in the last byte, and even parity in the top bit of each data byte. No LFSR digest, no CRC,
 * no bit reversal — everything here is reproducible from the datasheet-level description in the decoder's
 * comments alone.
 *
 * This module deliberately does NOT import from the decoder. The two integrity primitives it needs (a byte
 * sum and a byte parity) are duplicated below with a pointer back to r433/util.ts and r433/devices/acurite.ts
 * as the source of truth. The sibling round-trip test is what guards against drift: if either side changes,
 * the decoder stops reading what this encoder produces and the test goes red.
 */

/** The rtl_433 model string this encoder targets, as the decoder emits it. */
export const WEATHER_MODEL = 'Acurite-Tower';
/** Its rtl_433 protocol number: the `num` field of the acuriteTxr device (r433/devices/acurite.ts). */
export const WEATHER_PROTOCOL = 40;
/** The band the sensor family lives on, matching acuriteTxr.bands. */
export const WEATHER_FREQ_HZ = 433_920_000;

export interface WeatherSpoof {
  /** 14-bit sensor id. Clamped to 0..0x3fff; defaults to a fixed value so a display keeps one phantom sensor. */
  id?: number;
  /** Display channel 1, 2 or 3, shown by the decoder as 'A', 'B' or 'C'. Defaults to 1 ('A'). */
  channel?: number;
  /** Temperature in Celsius. Carried at 0.1 °C resolution; clamped to the decoder's -40..70 °C sanity range. */
  tempC: number;
  /** Relative humidity 0..100 %. Clamped to that range. Omit to send the sensor's "no humidity element" code. */
  humidity?: number;
  /** Battery-good flag. Defaults to true (a healthy battery). */
  battery?: boolean;
}

// --- Encoding limits, from the decoder in r433/devices/acurite.ts (towerDecode + txrCheck). ---
const TEMP_MIN_C = -40;      // towerDecode rejects anything below this
const TEMP_MAX_C = 70;       // ...or above this
const TEMP_OFFSET = 1000;    // tempC = (raw - 1000) * 0.1, so raw = round(tempC * 10) + 1000
const TEMP_STEP = 10;        // tenths of a degree per count
const HUM_MAX = 100;         // humidity > 100 is rejected unless it is exactly 127
const HUM_NONE = 127;        // 127 means "this sensor has no humidity element"; the decoder omits humidity then
const MSG_TOWER = 0x04;      // message type in the low six bits of byte 2 (acurite.ts MSG_TOWER)
const BATTERY_OK = 0x40;     // byte 2 bit 6 set = battery good ((bb[2] & 0x40) === 0 means low)

/**
 * The two-bit channel selector lives in the top of byte 0. The decoder's table is ['C','E','B','A'] indexed by
 * those two bits, and 01 ('E') is treated as an error — so only three codes are usable. Map the friendly
 * channel numbers 1/2/3 onto A/B/C.
 */
const CHANNEL_CODE: Record<number, number> = { 1: 0b11 /* A */, 2: 0b10 /* B */, 3: 0b00 /* C */ };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Parity of a byte: 1 when an odd number of bits are set. Duplicated from r433/util.ts `parity8` (the source
 * of truth) so this module stays independent of the decoder. The Tower checks even parity across the data
 * bytes, so the top bit of each is set to make that byte's bit count even.
 */
function parity8(b: number): number {
  const x = (b ^ (b >> 4)) & 0x0f;
  return (0x6996 >> x) & 1;
}

/**
 * Build the seven message bytes, checksum and parity included, exactly as towerDecode reads them back:
 *   byte 0: channel in the top two bits, high six bits of the id
 *   byte 1: low eight bits of the id
 *   byte 2: parity | battery flag | message type 0x04
 *   byte 3: parity | humidity (7 bits)
 *   byte 4: parity | high seven bits of the temperature count
 *   byte 5: parity | low seven bits of the temperature count
 *   byte 6: sum of bytes 0..5, modulo 256
 * Temperature is offset by 100 °C before scaling to tenths, so every in-range value is positive and no sign
 * bit is needed; a negative °C (say -20) is simply a smaller count (800), which is why -40..70 all fit.
 */
export function weatherFrame(s: WeatherSpoof): number[] {
  const id = clamp(Math.round(s.id ?? 0x0abc), 0, 0x3fff);
  const chan = CHANNEL_CODE[s.channel ?? 1] ?? CHANNEL_CODE[1];

  const tempC = clamp(s.tempC, TEMP_MIN_C, TEMP_MAX_C);
  const tempRaw = Math.round(tempC * TEMP_STEP) + TEMP_OFFSET;   // 14-bit count, split 7 + 7 across bytes 4,5

  const humidity = s.humidity === undefined ? HUM_NONE : clamp(Math.round(s.humidity), 0, HUM_MAX);
  const battery = (s.battery ?? true) ? BATTERY_OK : 0;

  const bb = [
    (chan << 6) | ((id >> 8) & 0x3f),
    id & 0xff,
    battery | MSG_TOWER,
    humidity & 0x7f,
    (tempRaw >> 7) & 0x7f,
    tempRaw & 0x7f,
    0,
  ];

  // Even parity in the top bit of each data byte (2..5), then the byte-sum check over bytes 0..5.
  for (let i = 2; i <= 5; i++) if (parity8(bb[i])) bb[i] |= 0x80;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += bb[i];
  bb[6] = sum & 0xff;

  return bb;
}

// --- OOK pulse timing, from acuriteTxr in r433/devices/acurite.ts. ---
// PWM: the mark length is the bit and the gap fills the rest of a fixed ~612 us period. The decoder inverts
// the sliced bits, and the PWM slicer reads a short mark as a 1, so on the wire a logical 1 is the LONG mark
// and a logical 0 is the SHORT mark (short mark 220 us + 392 us gap; long mark 408 us + 204 us gap). A burst
// opens with four sync marks, and the sensor repeats the whole frame a few times with a long gap between.
const SYNC_MARK_US = 620;
const SYNC_GAP_US = 596;
const SHORT_MARK_US = 220;   // logical 0
const LONG_MARK_US = 408;    // logical 1
const SHORT_GAP_US = 204;    // the gap after a long mark
const LONG_GAP_US = 392;     // the gap after a short mark
const INTER_FRAME_GAP_US = 2192;
const NUM_SYNC = 4;
const REPEATS = 3;           // the real sensor sends the frame several times; a receiver needs only one clean copy

/**
 * The frame as OOK pulses ready for tx.ookPulses: a list of [level, samples] where level true is carrier-on
 * (a mark) and false is carrier-off (a gap), timed for `rate` samples per second (the transmitter runs at
 * 2_000_000). Each element time is converted from its microseconds above. The frame is sent `REPEATS` times,
 * each copy opened by four sync marks and closed by a long inter-frame gap, exactly as the sensor repeats.
 */
export function weatherPulses(s: WeatherSpoof, rate: number): [boolean, number][] {
  const us = (t: number) => Math.round((t * rate) / 1e6);
  const bytes = weatherFrame(s);

  const bits: number[] = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  const out: [boolean, number][] = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    for (let i = 0; i < NUM_SYNC; i++) {
      out.push([true, us(SYNC_MARK_US)]);
      out.push([false, us(SYNC_GAP_US)]);
    }
    for (const bit of bits) {
      if (bit) { out.push([true, us(LONG_MARK_US)]); out.push([false, us(SHORT_GAP_US)]); }
      else { out.push([true, us(SHORT_MARK_US)]); out.push([false, us(LONG_GAP_US)]); }
    }
    out.push([false, us(INTER_FRAME_GAP_US)]);   // separates this copy from the next
  }
  return out;
}
