/**
 * ORBCOMM subscriber downlink, 137.2–137.8 MHz.
 *
 * A constellation of small satellites carrying short machine messages for trackers and remote sensors. The
 * messages themselves are encrypted and have resisted twenty-five years of hobbyist effort, so this decodes
 * everything around them: which satellite is overhead, the channel plan it is advertising, and — the useful part
 * — the satellite's own position and velocity, which it broadcasts every four seconds. That means a satellite can
 * be put on the map from its own transmission, with no orbit data fetched from anywhere.
 *
 * The modulation is SDPSK at 4800 symbols a second, which at that rate is the same thing as minimum-shift keying,
 * so an ordinary FM discriminator recovers it. The channel plan deliberately avoids the weather satellites, so
 * ORBCOMM and Meteor never collide on the same waterfall.
 *
 * Ported from the ORBCOMM System Overview A80TD0008 Rev G and Serial Interface Specification E80050015 Rev F,
 * checked against Frank Bieberly's decoder and SatDump's plugin.
 */
import { BitSync, DiscFilter, type Emit, type IqProcessor } from './core.js';

/** f = 137 000 000 + N x 2500. The ones that carry traffic; the rest of the plan is unused or gateway. */
export const ORBCOMM_CHANNELS = [
  137_200_000, 137_225_000, 137_250_000, 137_287_500, 137_312_500, 137_440_000,
  137_460_000, 137_662_500, 137_687_500, 137_712_500, 137_737_500, 137_800_000,
];

const BAUD = 4800;
/** The 24-bit frame sync, in the order it arrives. Reversed within each byte it reads 65 A8 F9. */
const ASM = 0xa6159f;
const ASM_INV = ASM ^ 0xffffff;
/** One minor frame: 4800 bits including the sync, so exactly one second, 600 bytes, 50 packets of 12. */
const FRAME_BITS = 4800;
const FRAME_BYTES = FRAME_BITS / 8;

const PACKET_NAME: Record<number, string> = {
  0x65: 'sync', 0x1a: 'message', 0x1b: 'uplink', 0x1c: 'downlink', 0x1d: 'network',
  0x1e: 'fill', 0x1f: 'ephemeris', 0x22: 'orbit',
};

/** What one satellite has told us about itself. */
export interface OrbcommSat {
  id: number;                       // satellite id from the sync packet
  lat?: number; lon?: number; altKm?: number;
  speedKms?: number;
  utc?: number;                     // satellite's own clock, ms since epoch
  channelHz: number;
  frames: number; bad: number;
  firstMs: number; lastMs: number;
}

/** Bits reversed within a byte: the wire is least-significant-bit first, the packets are not. */
const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 1 << (7 - b);
  REV[i] = v;
}

/**
 * The packet check, from Appendix F of the serial interface specification: a Fletcher-16 taken modulo 256 rather
 * than the usual 255. Run over the whole packet, including its own two check bytes, both sums come out zero when
 * the packet is intact. The same algorithm protects Inmarsat's packets.
 */
function fletcherOk(b: Uint8Array, at: number, len: number): boolean {
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) { s1 = (s1 + b[at + i]) & 0xff; s2 = (s2 + s1) & 0xff; }
  return s1 === 0 && s2 === 0;
}

const hex = (b: Uint8Array, at: number, len: number) => {
  let s = '';
  for (let i = 0; i < len; i++) s += b[at + i].toString(16).padStart(2, '0').toUpperCase();
  return s;
};
const rev = (s: string) => s.split('').reverse().join('');

/**
 * A 20-bit offset-binary field, nibble-packed and byte-swapped. The layout is awkward enough that it is done on
 * the hex text exactly the way the specification describes it, rather than with shifts that would be easy to get
 * subtly wrong.
 */
function field20(p: string, a: number, b: number): number {
  const f = rev(p.slice(a, b));
  return parseInt(rev(f.slice(0, 2)), 16) + 256 * parseInt(rev(f.slice(2, 4)), 16) + 65536 * parseInt(f.slice(4, 5), 16);
}

const MAX_R = 8_378_155, MAX_V = 7700, SPAN20 = 1_048_576;
const scale = (t: number, max: number) => (2 * t * max) / SPAN20 - max;

/** Earth-centered coordinates to latitude, longitude and height, WGS-84, by Bowring's method. */
function ecefToLla(x: number, y: number, z: number): { lat: number; lon: number; altKm: number } {
  const a = 6_378_137, f = 1 / 298.257223563, b = a * (1 - f);
  const e2 = f * (2 - f), ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(x, y), th = Math.atan2(a * z, b * p);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3);
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { lat: lat * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI, altKm: (p / Math.cos(lat) - n) / 1000 };
}

/** GPS week and second-of-week to wall time. The GPS epoch is 6 January 1980, and this stream carries no leap seconds. */
const GPS_EPOCH = Date.UTC(1980, 0, 6);
const gpsToUtc = (week: number, sec: number) => GPS_EPOCH + week * 604_800_000 + sec * 1000;

export class OrbcommDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  private sync = new BitSync(BAUD, 48_000);
  private filt = new DiscFilter(3600, 48_000);
  /** Rolling 24 bits, looking for the frame sync in either polarity. */
  private shift = 0;
  private inFrame = false;
  private inverted = false;
  private bitN = 0;
  private readonly frame = new Uint8Array(FRAME_BYTES);
  private byteAcc = 0;
  /** Which channel the receiver is on, so a satellite can be tied to a frequency. */
  channelHz = 0;
  readonly sats = new Map<number, OrbcommSat>();
  frames = 0; badFrames = 0; packets = 0; badPackets = 0;
  /** Times the frame sync matched. A signal that is present but marginal shows here long before a whole frame does. */
  syncs = 0;
  private lastReport = 0;
  private lastId = -1;

  constructor(private readonly emit: Emit) {}

  reset(): void {
    this.fmRate = 0; this.shift = 0; this.inFrame = false; this.bitN = 0; this.lastId = -1;
    this.frames = 0; this.badFrames = 0; this.packets = 0; this.badPackets = 0; this.syncs = 0;
  }
  onIq(): void { /* everything comes through the discriminator */ }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) {
      this.fmRate = rate;
      this.sync = new BitSync(BAUD, rate);
      this.filt = new DiscFilter(3600, rate);
      this.shift = 0; this.inFrame = false; this.bitN = 0;
    }
    for (let i = 0; i < n; i++) {
      const b = this.sync.push(this.filt.push(samples[i]));
      if (b >= 0) this.pushBit(b);
    }
  }

  private pushBit(bit: number): void {
    if (this.inFrame) {
      this.byteAcc = (this.byteAcc << 1) | (this.inverted ? bit ^ 1 : bit);
      if ((++this.bitN & 7) === 0) this.frame[(this.bitN >> 3) - 1] = REV[this.byteAcc & 0xff];
      if (this.bitN >= FRAME_BITS) { this.inFrame = false; this.onFrame(); }
      return;
    }
    this.shift = ((this.shift << 1) | bit) & 0xffffff;
    if (this.shift === ASM || this.shift === ASM_INV) {
      this.inverted = this.shift === ASM_INV;
      this.syncs++;
      this.inFrame = true; this.byteAcc = 0;
      // The sync word is the first three bytes of the frame, so plant it rather than skipping over it.
      this.frame[0] = REV[(ASM >> 16) & 0xff]; this.frame[1] = REV[(ASM >> 8) & 0xff]; this.frame[2] = REV[ASM & 0xff];
      this.bitN = 24;
    }
  }

  /** One second of traffic: fifty packets back to back, no gaps. */
  private onFrame(): void {
    this.frames++;
    this.report();
    const f = this.frame;
    let at = 0, good = 0;
    while (at + 12 <= FRAME_BYTES) {
      const type = f[at];
      const len = type === 0x1f && at + 24 <= FRAME_BYTES ? 24 : 12;
      this.packets++;
      if (!fletcherOk(f, at, len) && !this.fixOneBit(f, at, len)) { this.badPackets++; at += len; continue; }
      good++;
      this.onPacket(type, f, at, len);
      at += len;
    }
    if (!good) this.badFrames++;
  }

  /**
   * One wrong bit is common and cheap to undo: ninety-six flips, and the check either comes right or it does not.
   * Nothing else is guessed at.
   */
  private fixOneBit(f: Uint8Array, at: number, len: number): boolean {
    for (let i = 0; i < len; i++) {
      for (let b = 0; b < 8; b++) {
        f[at + i] ^= 1 << b;
        if (fletcherOk(f, at, len)) return true;
        f[at + i] ^= 1 << b;
      }
    }
    return false;
  }

  private sat(id: number): OrbcommSat {
    let s = this.sats.get(id);
    if (!s) { s = { id, channelHz: this.channelHz, frames: 0, bad: 0, firstMs: Date.now(), lastMs: Date.now() }; this.sats.set(id, s); }
    s.lastMs = Date.now(); s.channelHz = this.channelHz;
    return s;
  }

  private onPacket(type: number, f: Uint8Array, at: number, len: number): void {
    if (type === 0x65) {                                   // the frame's own header names the satellite
      this.lastId = f[at + 3];
      this.sat(this.lastId).frames++;
      return;
    }
    if (type !== 0x1f) {
      if (type === 0x1a) this.emit({ type: 'log', line: `ORBCOMM message packet, payload encrypted: ${hex(f, at + 2, 8)}` });
      return;
    }
    // Ephemeris: the satellite's own clock, then its velocity and position in Earth-centered coordinates.
    const p = hex(f, at + 2, len - 2);
    const week = parseInt(p.slice(0, 4), 16), tow = parseInt(p.slice(4, 10), 16);
    const vz = scale(field20(p, 10, 15), MAX_V), vy = scale(field20(p, 15, 20), MAX_V), vx = scale(field20(p, 20, 25), MAX_V);
    const z = scale(field20(p, 25, 30), MAX_R), y = scale(field20(p, 30, 35), MAX_R), x = scale(field20(p, 35, 40), MAX_R);
    const lla = ecefToLla(x, y, z);
    if (!Number.isFinite(lla.lat) || Math.abs(lla.lat) > 90 || lla.altKm < 400 || lla.altKm > 1400) return;
    const id = f[at + 1] || this.lastId;
    if (id < 0) return;
    const s = this.sat(id);
    s.lat = lla.lat; s.lon = lla.lon; s.altKm = lla.altKm;
    s.speedKms = Math.hypot(vx, vy, vz) / 1000;
    s.utc = gpsToUtc(week, tow);
    this.report(true);
  }

  /** Tell the app what is arriving, at most a few times a second, so a marginal pass still shows something. */
  private report(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastReport < 500) return;
    this.lastReport = now;
    this.emit({ type: 'orbcomm', sats: [...this.sats.values()], frames: this.frames, packets: this.packets, bad: this.badPackets, syncs: this.syncs });
  }

  /** Name for a packet type, for the log. */
  static packetName(type: number): string { return PACKET_NAME[type] ?? `0x${type.toString(16)}`; }
}
