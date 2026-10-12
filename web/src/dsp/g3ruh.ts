/**
 * 9600 baud G3RUH packet, the way most cubesats send their telemetry.
 *
 * This is the single most widely used cubesat downlink there is: direct FSK through an ordinary FM receiver,
 * NRZI encoded, scrambled with James Miller's seventeen-stage polynomial, then plain AX.25 with the same framing
 * and checksum as APRS. The app already had every part of that except the descrambler, which is why one small
 * file unlocks well over a hundred satellites rather than one.
 *
 * The chain, in the order it has to happen: slice the discriminator, undo the NRZI, descramble, then hand the
 * bits to the AX.25 framer. Getting NRZI and descrambling the wrong way round produces a stream that looks
 * plausible and never frames, so the order is taken from gr-satellites rather than from memory.
 */
import { BitSync, DiscFilter, HdlcFramer, type Emit, type IqProcessor } from './core.js';

/**
 * The G3RUH descrambler: x^17 + x^12 + 1, self-synchronising, so it needs no agreement about where a frame
 * starts and locks itself within seventeen bits. Written the way the reference implementation does it: the
 * output is the parity of the tapped register exclusive-ored with the input, and it is the input that is fed
 * back, which is what makes it self-synchronising rather than free-running.
 */
class Descrambler {
  private reg = 0;
  /** Taps at bits 0 and 5 of a seventeen-bit register shifting right: seventeen and twelve shifts back. */
  private static readonly MASK = 0x21;
  private static readonly LEN = 16;
  reset(): void { this.reg = 0; }
  push(bit: number): number {
    let t = this.reg & Descrambler.MASK, parity = 0;
    while (t) { parity ^= t & 1; t >>>= 1; }
    const out = parity ^ (bit & 1);
    this.reg = (this.reg >>> 1) | ((bit & 1) << Descrambler.LEN);
    return out;
  }
}

/** One packet heard, decoded as far as the addresses go. */
export interface PacketFrame {
  at: number;
  from: string; to: string; via: string[];
  /** Everything after the address and control fields. */
  payload: Uint8Array;
  /** The payload as text where it is text, otherwise empty. */
  text: string;
  hex: string;
}

/** An AX.25 address field: six characters shifted up one bit, then the SSID. */
function callsign(f: Uint8Array, at: number): string {
  let s = '';
  for (let i = 0; i < 6; i++) { const c = f[at + i] >> 1; if (c !== 0x20) s += String.fromCharCode(c); }
  const ssid = (f[at + 6] >> 1) & 0x0f;
  return ssid ? `${s}-${ssid}` : s;
}

/** Printable if it is mostly text; cubesat telemetry usually is not, and saying so is better than mojibake. */
function asText(b: Uint8Array): string {
  if (!b.length) return '';
  let printable = 0, s = '';
  for (const c of b) {
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) { printable++; s += String.fromCharCode(c); }
    else s += '.';
  }
  return printable / b.length > 0.85 ? s : '';
}

export class G3ruhDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  private baud = 9600;
  private sync = new BitSync(9600, 48_000);
  private filt = new DiscFilter(7200, 48_000);
  private readonly descram = new Descrambler();
  private last = 0;
  private readonly framer: HdlcFramer;
  readonly frames: PacketFrame[] = [];
  heard = 0; bad = 0;

  constructor(private readonly emit: Emit) {
    this.framer = new HdlcFramer(512, f => this.onFrame(f));
  }

  /** 9600 is the common case; a few satellites run the same scheme at 4800 or 19200. */
  setBaud(baud: number): void {
    if (baud === this.baud) return;
    this.baud = baud; this.fmRate = 0;
  }

  reset(): void { this.fmRate = 0; this.framer.reset(); this.descram.reset(); this.last = 0; this.heard = 0; this.bad = 0; this.frames.length = 0; }
  /** CLEAR on the screen: forget the frames, without disturbing the bit sync. */
  clear(): void { this.heard = 0; this.bad = 0; this.frames.length = 0; this.emit({ type: 'packetsat', frames: [], heard: 0, bad: 0 }); }
  onIq(): void { /* everything comes through the discriminator */ }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) {
      this.fmRate = rate;
      this.sync = new BitSync(this.baud, rate);
      this.filt = new DiscFilter(Math.min(0.45 * rate, this.baud * 0.75), rate);
      this.framer.reset(); this.descram.reset();
    }
    for (let i = 0; i < n; i++) {
      const b = this.sync.push(this.filt.push(samples[i]));
      if (b < 0) continue;
      const nrzi = b === this.last ? 1 : 0;     // a one is no transition, exactly as in APRS
      this.last = b;
      this.framer.pushDecoded(this.descram.push(nrzi));
    }
  }

  private onFrame(f: Uint8Array): void {
    if (f.length < 16 || !HdlcFramer.fcsOk(f)) { this.bad++; return; }
    // Addresses: destination, source, then up to eight digipeaters, each ending when bit 0 of the SSID byte is set.
    const to = callsign(f, 0), from = callsign(f, 7);
    const via: string[] = [];
    let at = 14;
    if (!(f[13] & 1)) {
      while (at + 7 <= f.length && via.length < 8) { via.push(callsign(f, at)); const end = f[at + 6] & 1; at += 7; if (end) break; }
    }
    at += 2;                                    // control and protocol identifier
    if (at >= f.length - 2) return;
    const payload = f.slice(at, f.length - 2);
    this.heard++;
    const frame: PacketFrame = {
      at: Date.now(), from, to, via, payload, text: asText(payload),
      hex: [...payload.slice(0, 64)].map(v => v.toString(16).padStart(2, '0')).join(' '),
    };
    this.frames.unshift(frame);
    if (this.frames.length > 100) this.frames.length = 100;
    this.emit({ type: 'packetsat', frames: this.frames.slice(0, 40), heard: this.heard, bad: this.bad });
  }
}
