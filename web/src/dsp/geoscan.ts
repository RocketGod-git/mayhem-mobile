/**
 * Geoscan: nine small Russian satellites launched in July 2025 that send photographs of the Earth back as
 * ordinary 9600 baud FSK, which means an FM discriminator and a whip are enough to receive a picture from orbit.
 *
 * The framing is a TI transceiver's: a thirty-two bit sync word, a fixed-length packet, the chip's own PN9
 * scrambler, and the chip's own checksum. The picture arrives as JPEG fragments, each carrying the offset it
 * belongs at, so a pass assembles into a file that a browser can display directly.
 *
 * Constants are from gr-satellites and GNU Radio, which are exact. The one thing that is not published clearly is
 * where inside a frame the picture header begins, because the reference tool reads from a pipeline that adds its
 * own prefix. Rather than guess an offset, the header is found by its own shape: a marker, a length that fits,
 * and one of the two message types. A frame has already passed its checksum by then, so a false match would have
 * to survive both.
 */
import { BitSync, DiscFilter, type Emit, type IqProcessor } from './core.js';

/** The nine that are alive, all launched together in July 2025, plus their downlinks. */
export const GEOSCAN_SATS: [number, number, string][] = [
  [64880, 435_970_000, 'Geoscan-1'],
  [64890, 436_040_000, 'Geoscan-2'],
  [64893, 436_110_000, 'Geoscan-3'],
  [64892, 436_180_000, 'Geoscan-4'],
  [64891, 436_250_000, 'Geoscan-5'],
  [64879, 436_320_000, 'Geoscan-6'],
];

const SYNC = 0x930b51de;
const FRAME = 74;
const MARKER_IMG = 0x0001, CMD_START = 0x0901, CMD_FRAME = 0x0905;

const popcount = (x: number) => { let c = 0; x >>>= 0; while (x) { x &= x - 1; c++; } return c; };

/**
 * The transceiver's PN9 scrambler: a nine-stage register, x^9 + x^5 + 1, reset for every packet, exclusive-ored
 * a whole byte at a time with the least significant bit first.
 */
function pn9(buf: Uint8Array, len: number): void {
  let reg = 0x1ff;
  for (let i = 0; i < len; i++) {
    let sb = 0;
    for (let k = 0; k < 8; k++) {
      sb |= (reg & 1) << k;
      let t = reg & 0x21, p = 0;
      while (t) { p ^= t & 1; t >>>= 1; }
      reg = (reg >>> 1) | (p << 8);
    }
    buf[i] ^= sb;
  }
}

/** The transceiver's own checksum: x^16 + x^15 + x^2 + 1, started at all ones, sent most significant byte first. */
function crc16(buf: Uint8Array, len: number): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A picture being built up across a pass. */
export interface GeoImage {
  started: number;
  bytes: Uint8Array;
  high: number;                      // how far into the file anything has been written
  complete: boolean;
  fragments: number;
}

export class GeoscanDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  private sync = new BitSync(9600, 48_000);
  private filt = new DiscFilter(7200, 48_000);
  private shift = 0;
  private inFrame = false;
  private bitN = 0;
  private acc = 0;
  private readonly frame = new Uint8Array(FRAME);
  /** Where in the file this picture started, so fragment offsets can be made relative to it. */
  private base = -1;
  frames = 0; bad = 0; imageFrames = 0;
  image: GeoImage | null = null;
  /** The picture is only sent up when it has grown, or when it finishes: it is a quarter of a megabyte. */
  private sentAt = 0; private sentHigh = 0;

  constructor(private readonly emit: Emit) {}

  reset(): void {
    this.fmRate = 0; this.shift = 0; this.inFrame = false; this.bitN = 0;
    this.frames = 0; this.bad = 0; this.imageFrames = 0; this.image = null; this.base = -1; this.sentAt = 0; this.sentHigh = 0;
  }
  onIq(): void { /* everything comes through the discriminator */ }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) {
      this.fmRate = rate;
      this.sync = new BitSync(9600, rate);
      this.filt = new DiscFilter(Math.min(0.45 * rate, 7200), rate);
      this.shift = 0; this.inFrame = false; this.bitN = 0;
    }
    for (let i = 0; i < n; i++) {
      const b = this.sync.push(this.filt.push(samples[i]));
      if (b < 0) continue;
      if (this.inFrame) {
        this.acc = ((this.acc << 1) | b) & 0xff;
        if ((++this.bitN & 7) === 0) this.frame[(this.bitN >> 3) - 1] = this.acc;
        if (this.bitN >= FRAME * 8) { this.inFrame = false; this.onFrame(); }
        continue;
      }
      this.shift = ((this.shift << 1) | b) >>> 0;
      // Four wrong bits in the sync word are tolerated, the same allowance the reference decoder makes.
      if (popcount((this.shift ^ SYNC) >>> 0) <= 4) { this.inFrame = true; this.bitN = 0; this.acc = 0; }
    }
  }

  private onFrame(): void {
    const f = this.frame;
    pn9(f, FRAME);
    if (crc16(f, FRAME - 2) !== ((f[FRAME - 2] << 8) | f[FRAME - 1])) { this.bad++; return; }
    this.frames++;
    this.picture(f);
    const img = this.image;
    const now = Date.now();
    const worthSending = !!img && img.high > this.sentHigh + 512 && (now - this.sentAt > 2000 || img.complete);
    if (worthSending) { this.sentAt = now; this.sentHigh = img!.high; }
    const jpeg = worthSending ? this.jpeg() : null;
    this.emit({
      type: 'geoscan', frames: this.frames, bad: this.bad, imageFrames: this.imageFrames,
      high: img ? img.high : 0, complete: img ? img.complete : false, fragments: img ? img.fragments : 0,
      jpeg,
    }, jpeg ? [jpeg.buffer] : undefined);
  }

  /**
   * Find the picture header inside a frame that has already passed its checksum, and file its fragment. The
   * header is two bytes of marker, a length, a message type, the offset it belongs at, and a subsystem number.
   */
  private picture(f: Uint8Array): void {
    for (let at = 0; at + 8 <= FRAME - 2; at++) {
      if (f[at] !== (MARKER_IMG & 0xff) || f[at + 1] !== (MARKER_IMG >> 8)) continue;
      const dlen = f[at + 2], mtype = f[at + 3] | (f[at + 4] << 8), off = f[at + 5] | (f[at + 6] << 8);
      if (dlen < 7 || dlen > 70 || at + 2 + dlen > FRAME - 2) continue;
      if (mtype !== CMD_START && mtype !== CMD_FRAME) continue;
      const data = f.subarray(at + 8, at + 2 + dlen);
      if (!data.length) continue;
      const soi = data[0] === 0xff && data[1] === 0xd8;
      if (mtype === CMD_START || (soi && this.base < 0)) { this.base = off; if (!this.image || this.image.complete) this.start(); }
      if (!this.image) this.start();
      let put = off - this.base;
      if (put < 0) { this.start(); this.base = off; put = 0; }
      const img = this.image!;
      if (put + data.length > img.bytes.length) return;      // beyond anything a picture from these is
      img.bytes.set(data, put);
      img.high = Math.max(img.high, put + data.length);
      img.fragments++;
      this.imageFrames++;
      for (let k = 0; k + 1 < data.length; k++) if (data[k] === 0xff && data[k + 1] === 0xd9) img.complete = true;
      return;
    }
  }

  private start(): void { this.image = { started: Date.now(), bytes: new Uint8Array(256 * 1024), high: 0, complete: false, fragments: 0 }; }

  /** The picture so far, as JPEG bytes, or null if nothing has arrived. */
  jpeg(): Uint8Array | null {
    const img = this.image;
    return img && img.high > 2 ? img.bytes.slice(0, img.high) : null;
  }
}
