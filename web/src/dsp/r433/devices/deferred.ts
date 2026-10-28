/**
 * The last three, deferred until the end because each is the largest of its kind.
 *
 * They have nothing in common but that: a satellite television remote, a door sensor, and a utility mesh
 * endpoint. None publishes a captured frame in any of the four forms rtl_433's files use, so every frame here
 * is built from the transmit side, and each builder was round-tripped through the decoder's own path before
 * anything was asserted on it.
 *
 * The DirecTV remote encodes its data in the *lengths* of runs between transitions rather than in the symbols
 * themselves: one symbol is a zero, two is a one, and three or more is a sync. An inverted signal decodes
 * identically. The run immediately after a sync is a marker rather than data, and a sync at the very end of a
 * row is discarded along with the bit before it.
 *
 * Vivint's frame is straightforward; what is not is the status byte, which is exclusive-ored with a keystream
 * from a Rabbit cipher core keyed by a per-device seed that never goes over the air. Upstream takes that seed
 * on its command line. This app has no way to supply one, and without it upstream itself reports only the raw
 * payload — so the cipher is deliberately not ported, and the payload goes out as hex exactly as upstream does
 * in that case. Both of its checksums are ported, including the unusual packed twelve-bit one.
 *
 * Silver Spring is a mesh endpoint whose payload is scrambled with a per-hop seed that is also not
 * transmitted. That one is recoverable: the decoder tries all 255 seeds and keeps whichever descrambles to a
 * payload matching its trailing CRC-32. That is a real check — on a constructed frame exactly one seed passes,
 * and after flipping a single bit no seed passes at all. Its link layer and TLV structure are ported; its
 * route-advertisement and IPv6 interpretation are not, because that part rests on candidate meanings its own
 * author flags as unconfirmed and there is no published frame to test any of it against. The whole payload is
 * always reported as hex, so nothing is lost by declining to name those fields.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): `directv.c`, `vivint.c`, `silver_spring_mesh.c`.
 */

import { BitBuffer, bitAt } from '../bitbuffer.js';
import {
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY,
  Modulation, register, type DecodeCtx, type R433Data, type RDevice,
} from '../device.js';
import { crc16 } from '../util.js';

const BAND_345 = [345000000];
const BAND_433 = [433920000];
const BAND_915 = [915000000];

const hexOf = (b: Uint8Array, from: number, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += b[from + i].toString(16).padStart(2, '0');
  return s;
};

// ---------------------------------------------------------------------------
// DirecTV RC66RX remote (128)
// ---------------------------------------------------------------------------

/** Button codes seen in the wild; anything else is reported as unknown rather than guessed at. */
const DTV_BUTTON: Record<number, string> = {
  0x01: '1', 0x02: '2', 0x03: '3', 0x04: '4', 0x05: '5', 0x06: '6', 0x07: '7', 0x08: '8', 0x09: '9',
  0x0d: 'CH UP', 0x0e: 'CH DOWN', 0x0f: 'CH PREV', 0x10: 'PWR', 0x11: '0', 0x12: 'DASH', 0x13: 'ENTER',
  0x14: 'DASH REPEAT', 0x15: 'ENTER REPEAT', 0x20: 'MENU', 0x21: 'UP', 0x22: 'DOWN', 0x23: 'LEFT',
  0x24: 'RIGHT', 0x25: 'SELECT', 0x26: 'EXIT', 0x27: 'BACK', 0x28: 'GUIDE', 0x29: 'ACTIVE', 0x2a: 'LIST',
  0x2b: 'LIST REPEAT', 0x2c: 'INFO REPEAT', 0x2d: 'GUIDE REPEAT', 0x2e: 'INFO',
  0x30: 'VCR PLAY', 0x31: 'VCR STOP', 0x32: 'VCR PAUSE', 0x33: 'VCR RWD', 0x34: 'VCR FFD', 0x35: 'VCR REC',
  0x36: 'VCR BACK', 0x37: 'VCR SKIP', 0x38: 'VCR SKIP REPEAT', 0x3a: 'VCR PLAY REPEAT',
  0x3b: 'VCR PAUSE REPEAT', 0x3c: 'VCR RWD REPEAT', 0x3d: 'VCR FFD REPEAT', 0x3e: 'VCR REC REPEAT',
  0x3f: 'VCR BACK REPEAT',
  0x41: 'RED', 0x42: 'YELLOW', 0x43: 'GREEN', 0x44: 'BLUE', 0x45: 'MENU REPEAT', 0x46: 'ACTIVE REPEAT',
  0x4a: 'RED REPEAT', 0x4b: 'YELLOW REPEAT', 0x4c: 'GREEN REPEAT', 0x4d: 'BLUE REPEAT',
  0x51: 'TV: VCR ALERT', 0x59: 'VOLUME ALERT', 0x5a: 'AV1/AV2/TV: IR ALERT 1', 0x5b: 'DTV: IR ALERT',
  0x5c: 'AV1/AV2/TV: IR ALERT 2', 0x5d: 'TV: DTV ALERT', 0x5e: 'AV1: DTV ALERT', 0x5f: 'AV2: DTV ALERT',
  0x60: '0 REPEAT', 0x61: '1 REPEAT', 0x62: '2 REPEAT', 0x63: '3 REPEAT', 0x64: '4 REPEAT', 0x65: '5 REPEAT',
  0x66: '6 REPEAT', 0x67: '7 REPEAT', 0x68: '8 REPEAT', 0x69: '9 REPEAT',
  0x73: 'FORMAT', 0x75: 'FORMAT REPEAT',
  0x80: 'DTV: DTV&TV POWER ON', 0x81: 'DTV: DTV&TV POWER OFF', 0xd6: 'SELECT RELEASE',
};

/**
 * Differential pulse width decoding: only the run lengths between transitions carry data.
 *
 * The counter starts at all ones so that the very first transition is treated as the end of a sync of length
 * zero, which is how the leading run — whatever its length — is kept out of the data. Two behaviors matter
 * and are easy to lose: a sync discards everything decoded before it, and the run straight after a sync is a
 * marker, not a bit.
 */
function dpwmDecode(row: Uint8Array, bitLen: number, start: number):
  { bits: number[]; syncPos: number; syncLen: number } {
  const out: number[] = [];
  let bufPos = -1;
  let cur = 0xffffffff;                            // wraps to zero on the first repeat, as upstream's does
  let syncPos = start, syncLen = 0;
  let syncing = 1;
  let prev = 0xff;

  for (let p = start; p < bitLen; p++) {
    const b = bitAt(row, p);
    if (b === prev) {
      cur = (cur + 1) >>> 0;
      if (cur > 1) syncing = 1;                    // three or more alike symbols is a sync, not data
    }
    else {
      if (syncing) {
        syncLen = (cur + 1) >>> 0;
        syncPos = (p - cur - 1) >>> 0;
        bufPos = -1;                               // anything decoded before a sync is discarded
        syncing = 0;
      }
      else {
        if (bufPos >= 0) out[bufPos] = cur;        // the run right after a sync is a marker, not a bit
        bufPos++;
      }
      cur = 0;
    }
    prev = b;
  }

  // A sync running to the end of the row is ignored, and takes the bit before it with it.
  if (syncing) bufPos -= 1;
  if (bufPos < 0) bufPos = 0;
  return { bits: out.slice(0, bufPos), syncPos, syncLen };
}

export const directv: RDevice = register({
  num: 128,
  name: 'DirecTV RC66RX Remote Control',
  what: 'satellite television remote',
  modulation: Modulation.FSK_PCM,
  shortWidth: 600,
  longWidth: 600,
  gapLimit: 30000,
  resetLimit: 50000,
  bands: BAND_433,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    const bitLen = bits.bitsPerRow[0];
    if (bitLen < 44 || bitLen > 99) return DECODE_FAIL_SANITY;

    const { bits: logical, syncLen } = dpwmDecode(bits.bb[0], bitLen, 0);
    if (logical.length !== 40) return DECODE_ABORT_LENGTH;

    const b = new Uint8Array(5);
    logical.forEach((v, i) => { if (v) b[i >> 3] |= 0x80 >> (i & 7); });

    if (b[0] !== 0x10) return DECODE_FAIL_SANITY;  // a model marker, always this value

    let sum = 0;
    for (let i = 0; i < 4; i++) sum += (b[i] >> 4) + (b[i] & 0x0f);
    sum = (sum + (b[4] >> 4)) & 0x0f;
    if (sum !== (b[4] & 0x0f)) return DECODE_FAIL_MIC;

    const id = (b[1] << 12) | (b[2] << 4) | (b[3] >> 4);
    if (id > 999999) return DECODE_FAIL_SANITY;    // the field is wider than the printed range allows

    const button = ((b[3] << 4) | (b[4] >> 4)) & 0xff;

    ctx.emit({
      model: 'DirecTV-RC66RX',
      type: 'Remote',
      id,
      button_id: button,
      button_name: DTV_BUTTON[button] ?? 'unknown',
      // A long run-in marks the first time a message is sent; a short one marks a repeat of it.
      event: syncLen > 5 ? 'INITIAL' : 'REPEAT',
      mic: 'CHECKSUM',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Vivint door and window sensor (342)
// ---------------------------------------------------------------------------

/**
 * A door, window, glass-break or motion sensor from a home security system.
 *
 * The status byte is encrypted under a per-device seed that is never transmitted; upstream accepts one on its
 * command line and, without it, reports the raw payload instead. This app has no equivalent facility, so the
 * cipher is not ported and the payload is always reported as hex — which is exactly upstream's behavior for
 * a sensor whose seed it has not been given. Nothing is silently guessed: `state` and `contact_open` simply do
 * not appear.
 *
 * Two different checksums live here, and the frame subtype picks between them. Ordinary frames use a packed
 * twelve-bit check: a CRC-16 over eight bytes plus the *top nibble* of the ninth, compared against a value
 * split across that byte's low nibble and the tenth. Startup beacons use a plain CRC-16 over eight bytes.
 */
export const vivint: RDevice = register({
  num: 342,
  name: 'Vivint Door/Window Sensor, V-DW21R-345/V-DW11-345',
  what: 'security sensor',
  modulation: Modulation.OOK_MANCHESTER_ZEROBIT,
  shortWidth: 150,
  longWidth: 0,
  resetLimit: 300,
  bands: BAND_345,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    bits.invert();

    const pos = bits.search(0, 0, new Uint8Array([0xff, 0xe0]), 12) + 12;
    if (bits.bitsPerRow[0] - pos < 80) return DECODE_ABORT_LENGTH;

    const b = bits.bytes(0, pos, 80);
    const eventType = b[0];
    const counter = (b[1] << 8) | b[2];
    const flags = b[3];
    const id = (((b[4] << 24) >>> 0) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;

    if (id === 0 || id === 0xffffffff) return DECODE_FAIL_SANITY;

    let valid = false;
    if (eventType === 0xd0) {
      valid = ((b[8] << 8) | b[9]) === crc16(b, 8, 0x8050, 0);
    }
    else {
      // The low nibble of b[8] belongs to the check, so the CRC covers only its top nibble.
      const full = b[8];
      b[8] = full & 0xf0;
      const check12 = crc16(b, 9, 0x8050, 0) >> 4;
      b[8] = full;
      valid = check12 === (((full & 0x0f) << 8) | b[9]);
    }
    if (!valid) return DECODE_FAIL_MIC;

    // The identifier is printed on the sensor as two decimal groups.
    const idStr = `${String((id >>> 20) & 0xfff).padStart(4, '0')}-${String(id & 0xfffff).padStart(7, '0')}`;

    ctx.emit({
      model: 'Vivint-Security',
      type: 'Security',
      id: idStr,
      counter,
      flags,
      event_type: eventType,
      // Without the per-device seed the status byte cannot be read, so the frame goes out as it arrived.
      data: hexOf(b, 0, 10),
      mic: 'CRC',
    });
    return 1;
  },
});

// ---------------------------------------------------------------------------
// Silver Spring Networks mesh endpoint (383)
// ---------------------------------------------------------------------------

/** CRC-32/MPEG-2: all ones in, no final inversion, most significant bit first. */
function crc32Mpeg2(d: Uint8Array, len: number, from = 0): number {
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) {
    c = (c ^ (d[from + i] << 24)) >>> 0;
    for (let b = 0; b < 8; b++) c = (c & 0x80000000) ? (((c << 1) ^ 0x04c11db7) >>> 0) : ((c << 1) >>> 0);
  }
  return c >>> 0;
}

/** The payload scrambler: an additive shift register, so the same routine also undoes it. */
function ssnDescramble(buf: Uint8Array, len: number, seed: number): void {
  let reg = seed & 0xff;
  for (let i = 0; i < len; i++) {
    let k = 0;
    for (let b = 0; b < 8; b++) {
      k = ((k << 1) | ((reg >> 7) & 1)) & 0xff;
      let t = reg & 0x8e;
      t ^= t >> 4; t ^= t >> 2; t ^= t >> 1;
      reg = ((reg << 1) | (t & 1)) & 0xff;
    }
    buf[i] ^= k;
  }
}

interface SsnExtras {
  seenDll2: boolean; seenDll4: boolean; seenDll9: boolean; seenMpdu: boolean;
  seq?: { retry: number; fragMore: number; fragNum: number; seqNum: number };
  fet?: number;
  rssi?: number;
  cli?: { txPri: number; txTime: number; rxPri: number; rxTime: number };
  syncChannel?: number;
}

/**
 * One record of the type/length/value stream, and how many bytes it took.
 *
 * The top bit of the first byte picks between two layouts with different field widths, which is why the type
 * and length are pulled out differently for each. Only one record kind nests another.
 *
 * The small fields read here are upstream's, and it marks several of them as candidates rather than
 * established meanings — the sequence control and epoch tick are confident, the link-info packing and the
 * signed reception strength less so. They are reported under upstream's own names so the two agree.
 */
function ssnTlv(psdu: Uint8Array, len: number, i: number, parts: string[], extras: SsnExtras | null):
  { used: number; type: number; isDll: boolean } {
  if (i + 2 > len) return { used: 0, type: 0, isDll: false };

  const h0 = psdu[i], h1 = psdu[i + 1];
  const isMpdu = (h0 & 0x80) !== 0;
  const type = isMpdu ? (h0 >> 3) : (((h0 << 1) | (h1 >> 7)) & 0x1ff);
  const vlen = isMpdu ? (((h0 & 0x07) << 8) | h1) : (h1 & 0x7f);
  if (i + 2 + vlen > len) return { used: 0, type: 0, isDll: false };

  parts.push(`${isMpdu ? 'M' : 'D'}${type}/${vlen}`);

  if (isMpdu && type === 17 && vlen > 0) {
    const nested: string[] = [];
    ssnTlv(psdu, i + 2 + vlen, i + 2, nested, null);
    parts[parts.length - 1] += `{${nested.join(' ')}}`;
  }

  if (extras) {
    const val = i + 2;
    if (isMpdu) {
      extras.seenMpdu = true;
      // Record type 16 carries routing and datagram payloads whose field meanings upstream calls
      // unconfirmed; the record is reported by type and length, and its contents left in the payload hex.
    }
    else if (type === 2) {
      extras.seenDll2 = true;
      if (vlen === 3) {
        const raw = (psdu[val] << 16) | (psdu[val + 1] << 8) | psdu[val + 2];
        extras.cli = {
          txPri: (raw >> 21) & 0x7, txTime: (raw >> 12) & 0x1ff,
          rxPri: (raw >> 9) & 0x7, rxTime: raw & 0x1ff,
        };
      }
    }
    else if (type === 4) {
      extras.seenDll4 = true;
      if (vlen === 2) {
        const raw = (psdu[val] << 8) | psdu[val + 1];
        extras.seq = {
          retry: (raw >> 15) & 1, fragMore: (raw >> 14) & 1,
          fragNum: (raw >> 10) & 0xf, seqNum: raw & 0x3ff,
        };
      }
    }
    else if (type === 9) {
      extras.seenDll9 = true;
      if (vlen === 1) extras.rssi = psdu[val] >= 128 ? psdu[val] - 256 : psdu[val];
    }
    else if (type === 1) {
      if (vlen === 2) extras.fet = (psdu[val] << 8) | psdu[val + 1];
    }
    else if (type === 8) {
      if (vlen === 5) extras.syncChannel = psdu[val + 4];
    }
  }

  return { used: 2 + vlen, type, isDll: !isMpdu };
}

/**
 * Walks the whole record stream.
 *
 * Two record types change the walk rather than carrying data. One marks that the last four bytes of the
 * payload are a checksum over everything before them, but does not end the stream. The other does end it,
 * ahead of a fragment this decoder does not reassemble — whatever remains is reported as a byte count, and
 * the bytes themselves are always in the payload hex.
 */
function ssnTlvs(psdu: Uint8Array, psduLen: number, start: number, extras: SsnExtras): string {
  const parts: string[] = [];
  let i = start;
  let sawCrcMarker = false;

  while (i < psduLen) {
    const { used, type, isDll } = ssnTlv(psdu, psduLen, i, parts, extras);
    if (!used) break;
    i += used;

    if (isDll && type === 6) { sawCrcMarker = true; continue; }
    if (isDll && type === 5) {
      if (i < psduLen) parts.push(`+${psduLen - i}B`);
      return parts.join(' ');
    }
  }

  if (sawCrcMarker && i + 4 === psduLen) {
    const want = (((psdu[i] << 24) >>> 0) | (psdu[i + 1] << 16) | (psdu[i + 2] << 8) | psdu[i + 3]) >>> 0;
    parts.push(crc32Mpeg2(psdu, i) === want ? ':ok' : ':bad');
  }
  else if (i < psduLen) {
    parts.push(`+${psduLen - i}B`);
  }
  return parts.join(' ');
}

/** The role a frame plays, from the control byte and which record types turned up. */
function ssnLink(fctrl: number, e: SsnExtras): string {
  if (fctrl === 2) return 'broadcast';
  if (fctrl === 3) return 'poll';
  if (fctrl === 1) {
    if (e.seenDll4 || e.seenMpdu) return 'data';
    if (e.seenDll2) return 'poll_ack';
    if (e.seenDll9) return 'data_ack';
  }
  return '';
}

export const silverSpringMesh: RDevice = register({
  num: 383,
  name: 'Silver Spring Networks mesh endpoint (-s 1600k)',
  what: 'utility mesh endpoint',
  modulation: Modulation.FSK_PCM,
  shortWidth: 10,
  longWidth: 10,
  resetLimit: 1000,
  bands: BAND_915,
  decode(_dev, bits: BitBuffer, ctx: DecodeCtx): number {
    if (bits.numRows !== 1) return DECODE_ABORT_EARLY;

    const sync = new Uint8Array([0xaa, 0xaa, 0x18, 0xbf]);
    let pos = bits.search(0, 0, sync, 32);
    if (pos >= bits.bitsPerRow[0]) {
      bits.invert();                               // both keying polarities turn up in the wild
      pos = bits.search(0, 0, sync, 32);
      if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY;
    }

    // The frame proper begins on the last bit of the matched sync, and is the complement of what matched.
    const frameStart = pos + 32 - 1;
    const availBits = bits.bitsPerRow[0] - frameStart;
    if (availBits < (3 + 4) * 8) return DECODE_ABORT_LENGTH;

    let availBytes = (availBits / 8) | 0;
    if (availBytes > 512) availBytes = 512;

    bits.invert();                                 // so the extraction below yields the frame the right way up
    const frame = bits.bytes(0, frameStart, availBytes * 8);

    if (frame[1] & 0xf8) return DECODE_FAIL_SANITY; // reserved bits, always clear on a real frame

    const channel = frame[0];
    const psduLen = ((frame[1] & 0x07) << 8) | frame[2];
    if (psduLen < 1 || 3 + psduLen + 4 > availBytes) return DECODE_ABORT_LENGTH;

    // The per-hop seed is not transmitted, so it is recovered by trying every value against the checksum.
    // A wrong seed passing is vanishingly unlikely: on a constructed frame exactly one seed works, and a
    // single flipped bit leaves none.
    const scrLen = psduLen + 4;
    const psdu = new Uint8Array(scrLen);
    let seedFound = -1;
    for (let seed = 1; seed < 256; seed++) {
      psdu.set(frame.subarray(3, 3 + scrLen));
      ssnDescramble(psdu, scrLen, seed);
      const fcs = (((psdu[psduLen] << 24) >>> 0) | (psdu[psduLen + 1] << 16)
        | (psdu[psduLen + 2] << 8) | psdu[psduLen + 3]) >>> 0;
      if (crc32Mpeg2(psdu, psduLen) === fcs) { seedFound = seed; break; }
    }
    if (seedFound < 0) return DECODE_FAIL_MIC;

    const fctrl = psdu[0];
    let at = 1;
    let dst = '', src = '';
    if ((fctrl & 0x01) && at + 8 <= psduLen) { dst = hexOf(psdu, at, 8); at += 8; }
    if ((fctrl & 0x02) && at + 8 <= psduLen) { src = hexOf(psdu, at, 8); at += 8; }

    const extras: SsnExtras = { seenDll2: false, seenDll4: false, seenDll9: false, seenMpdu: false };
    const tlvs = ssnTlvs(psdu, psduLen, at, extras);
    const link = ssnLink(fctrl, extras);

    const out: R433Data = {
      model: 'SilverSpring-Mesh',
      type: 'Meter',
      channel,
      seed: seedFound,
      len: psduLen,
      data: hexOf(psdu, 0, psduLen),               // the whole payload, so nothing is lost to omitted parsing
      mic: 'CRC',
    };
    if (dst) out.dst_id = dst;
    if (src) out.src_id = src;
    if (link) out.link = link;
    if (tlvs) out.tlvs = tlvs;
    if (extras.seq) {
      out.seq_num = extras.seq.seqNum;
      out.frag_num = extras.seq.fragNum;
      out.frag_more = extras.seq.fragMore;
      out.retry = extras.seq.retry;
    }
    if (extras.fet !== undefined) out.fet = extras.fet;
    if (extras.rssi !== undefined) out.rssi = extras.rssi;
    if (extras.cli) {
      out.cli_tx_pri = extras.cli.txPri;
      out.cli_tx_time = extras.cli.txTime;
      out.cli_rx_pri = extras.cli.rxPri;
      out.cli_rx_time = extras.cli.rxTime;
    }
    if (extras.syncChannel !== undefined) out.sync_channel = extras.syncChannel;

    ctx.emit(out);
    return 1;
  },
});
