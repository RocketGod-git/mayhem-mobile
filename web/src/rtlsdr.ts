/**
 * RTL-SDR over WebUSB: an RTL2832U demodulator with a Rafael Micro R820T/R820T2 or R828D tuner.
 *
 * This is the twenty-dollar dongle almost everyone owns, and for most of what this app does it is a perfectly
 * good receiver. It cannot transmit and it stops at about 1.766 GHz, but between 24 MHz and there it hears
 * everything a HackRF hears, and for the Devices screen it is actually the better radio: a HackRF cannot sample
 * below two megahertz, so that screen has to decimate its way down to a quarter of one, while an RTL-SDR is
 * asked for 250 kHz directly and never picks up the noise in between.
 *
 * Ported from the pure-Kotlin driver in Wardrive Go (`usb/RtlSdr.kt`), which is itself a verbatim port of
 * librtlsdr's `src/librtlsdr.c` and `src/tuner_r82xx.c` (GPL-2.0-or-later). The hard-won details are kept
 * because each of them is a day someone lost:
 *
 *  - Control transfers are vendor request 0 in both directions; the register block goes in `index`, the
 *    register address in `value`, and two-byte writes go out big-endian even though reads come back little.
 *  - Every demodulator write must be followed by a dummy read of page 0x0a register 0x01. Without it the part
 *    works for a while and then quietly stops.
 *  - The R82xx returns register reads bit-reversed, so they have to be flipped before anything is tested.
 *  - The RTL2832U's I2C master pushes at most eight bytes per transaction, one of which is the register
 *    address. The tuner's twenty-seven byte init block therefore has to be chunked into sevens; sent whole it
 *    is silently truncated after register 0x0b, the tuner still answers and the PLL still reports lock, and
 *    nothing downconverts. That is the famous "responds but only static" failure.
 *
 * Two things are handled here that the Kotlin does not. The R828D in the RTL-SDR Blog V4 - now the commonest
 * dongle sold - answers at a different I2C address and runs its PLL from a sixteen megahertz crystal rather
 * than the RTL's 28.8, so those are tracked separately. And the dongle delivers offset-binary samples where a
 * HackRF delivers signed ones, so every buffer is rebased before the rest of the app sees it.
 */

import type { Radio, RadioEvents, RadioLimits } from './radio.js';

/**
 * Whether to offer RTL-SDR support to users yet. Currently no.
 *
 * The driver brings a dongle up correctly - it enumerates, detects the tuner, locks the synthesizer, streams
 * IQ at the right rate and answers its gain control, all verified against an RTL-SDR Blog V4. What it does not
 * do is hear anything. With an aerial connected, broadcast FM should be the loudest thing on the spectrum and
 * it measured under two counts across the whole band, barely above the converter's own noise. Something in the
 * signal path is wrong while everything around it is right.
 *
 * The leading suspect is the V4's input routing: that board switches its front end between HF, VHF and UHF
 * filter paths under GPIO control, and this driver never touches those pins, so the aerial may simply not be
 * connected to the mixer. Gain behaving almost identically at nought and twenty decibels points the same way -
 * something upstream of the gain stages is attenuating everything.
 *
 * Until that is found, a dongle owner would connect, see a flat waterfall and conclude the app is broken. So
 * the chooser does not offer one and a remembered one is not opened. Everything else stays: the driver, its
 * tests, and the capability gating all still build and run, so turning this back on is one word.
 */
export const RTLSDR_READY = true;

export const RTLSDR_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2832 },     // Realtek RTL2832U, generic
  { vendorId: 0x0bda, productId: 0x2838 },     // RTL2838, what almost every dongle actually reports
  { vendorId: 0x0ccd, productId: 0x00a9 }, { vendorId: 0x0ccd, productId: 0x00b3 },   // Terratec
  { vendorId: 0x1554, productId: 0x5020 },     // PixelView
  { vendorId: 0x185b, productId: 0x0620 }, { vendorId: 0x185b, productId: 0x0650 },   // Compro
  { vendorId: 0x1f4d, productId: 0xb803 }, { vendorId: 0x1f4d, productId: 0xc803 },   // GTek / Lifeview
];

export function isRtlSdr(d: USBDevice): boolean {
  return RTLSDR_FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId);
}

// ---- USB plumbing ----------------------------------------------------------------------------------------
/** Register blocks, as libusb addresses them through `index`. */
const DEMODB = 0, USBB = 1, SYSB = 2, IICB = 6;
const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
const DEMOD_CTL = 0x3000, DEMOD_CTL_1 = 0x300b;
/** The RTL2832U's general-purpose pins: output value, output enable, direction. */
const GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004;

/** The RTL2832U's own crystal. Sets the resampler ratio and the IF, and is 28.8 MHz on every dongle made. */
const RTL_XTAL = 28_800_000;
/** Where the tuner puts the wanted signal. Low-side injection, so the demodulator inverts the spectrum back. */
const R82XX_IF_HZ = 3_570_000;

const R820T_ADDR = 0x34;
/** The R828D in the RTL-SDR Blog V4 and the Astrometa sticks. Same tuner core, different address and crystal. */
const R828D_ADDR = 0x74;
const R828D_XTAL = 16_000_000;
/**
 * The RTL-SDR Blog V4L ("V4 Lite"). The R828D went out of production, so the V4L carries an R828S instead. That
 * part answers at the R820T's address with the R820T's check value, so nothing on the I2C bus tells it apart:
 * librtlsdr goes by the USB strings the EEPROM programs, and so does this. Compared after trimming, since some
 * stacks hand the strings back with a trailing NUL.
 */
const BLOG_MAKER = 'RTLSDRBlog', BLOG_V4L = 'Blog V4L';
const usbString = (s: string | undefined): string => (s ?? '').replace(/\0/g, '').trim();
/** What either part answers at register zero. The one reliable way to tell a tuner is really there. */
const R82XX_CHECK_VAL = 0x69;

/** Tuner gain expressed in tenths of a decibel, or this for the hardware's own automatic control. */
export const GAIN_AUTO = -1;

/** What the R820T's two gain stages are worth, step by step, in tenths of a decibel. From librtlsdr. */
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const MIX_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
/**
 * The most the tuner can actually do: 48.8 dB, the sum of every step above.
 *
 * Not the 49.6 dB usually quoted. That figure is the top of librtlsdr's advertised gain table, which is a
 * hard-coded list that overstates its own step walk by the last eight tenths - ask for 49.6 and you get 48.8,
 * because there is no combination of stages that reaches further.
 */
export const RTL_MAX_GAIN_DB = 48.8;

/** The channel filter, as librtlsdr programs it: eight signed bytes then eight twelve-bit values packed in threes. */
const FIR_DEFAULT = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];

/** Bit-reversal of one byte, because that is how the R82xx hands its registers back. */
const REV4 = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
const bitrev = (b: number) => (REV4[b & 0xf] << 4) | REV4[(b >> 4) & 0xf];

/**
 * The tuner's tracking filter and mixer settings by band, in megahertz. Below about 24 MHz there is no entry
 * that works, which is where the dongle's lower limit comes from.
 */
interface FreqRange { freq: number; openD: number; rfMux: number; tfC: number; cap0p: number }
const FREQ_RANGES: FreqRange[] = [
  { freq: 0, openD: 0x08, rfMux: 0x02, tfC: 0xdf, cap0p: 0x00 },
  { freq: 50, openD: 0x08, rfMux: 0x02, tfC: 0xbe, cap0p: 0x00 },
  { freq: 55, openD: 0x08, rfMux: 0x02, tfC: 0x8b, cap0p: 0x00 },
  { freq: 60, openD: 0x08, rfMux: 0x02, tfC: 0x7b, cap0p: 0x00 },
  { freq: 65, openD: 0x08, rfMux: 0x02, tfC: 0x69, cap0p: 0x00 },
  { freq: 70, openD: 0x08, rfMux: 0x02, tfC: 0x58, cap0p: 0x00 },
  { freq: 75, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
  { freq: 80, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
  { freq: 90, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
  { freq: 100, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
  { freq: 110, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
  { freq: 120, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
  { freq: 140, openD: 0x00, rfMux: 0x02, tfC: 0x14, cap0p: 0x00 },
  { freq: 180, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
  { freq: 220, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
  { freq: 250, openD: 0x00, rfMux: 0x02, tfC: 0x11, cap0p: 0x00 },
  { freq: 280, openD: 0x00, rfMux: 0x02, tfC: 0x00, cap0p: 0x00 },
  { freq: 310, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
  { freq: 450, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
  { freq: 588, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
  { freq: 650, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
];

/** The tuner's own power-on register block, registers 0x05 through 0x1f. */
const R82XX_INIT = [
  0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80,
  0x31, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40,
];

/**
 * The channel-filter coefficients as the demodulator wants them: eight signed bytes, then eight twelve-bit
 * values packed two into every three bytes. Twenty bytes in all, written to page 1 registers 0x1c upward.
 *
 * Pulled out because it is fiddly bit-shuffling with no way to tell from the outside that it went wrong - a
 * mis-packed filter degrades sensitivity quietly rather than failing - and because it can then be checked
 * against librtlsdr's own output without a dongle plugged in.
 */
export function firBytes(): number[] {
  const fir = new Array<number>(20).fill(0);
  for (let i = 0; i < 8; i++) fir[i] = FIR_DEFAULT[i] & 0xff;
  for (let i = 0; i < 8; i += 2) {
    const v0 = FIR_DEFAULT[8 + i], v1 = FIR_DEFAULT[8 + i + 1];
    const at = 8 + ((i * 3) >> 1);
    fir[at] = (v0 >> 4) & 0xff;
    fir[at + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
    fir[at + 2] = v1 & 0xff;
  }
  return fir;
}

/**
 * Work out the synthesizer settings for one local-oscillator frequency.
 *
 * The VCO runs between 1.77 and 3.54 GHz whatever is being tuned, so a divider is chosen to bring it into
 * that window and the rest is a fractional-N division of the reference: an integer part and a sixteen-bit
 * fraction. `fine` is the VCO's own fine-tune reading, which shifts the divider by one either way.
 *
 * `vcoPowerRef` is two on an R820T and one on an R828D, and it is not cosmetic: it sets how large the integer
 * part is allowed to grow. An R828D divides a sixteen megahertz reference rather than the RTL's 28.8, so its
 * integer part runs to about 110 where an R820T's stays near 60 - held to the R820T's limit of 63, every
 * R828D dongle would refuse to tune anything above roughly 250 MHz.
 *
 * Separated from the register writes so the arithmetic can be checked against the frequency it claims to
 * produce - the whole calculation is one operator-precedence slip away from tuning somewhere else entirely,
 * and a radio that is quietly off frequency looks exactly like a radio that cannot hear anything.
 */
export function pllPlan(freqHz: number, pllRef: number, fine: number, vcoPowerRef = 2): {
  mixDiv: number; divNum: number; nint: number; sdm: number; ok: boolean;
} {
  const VCO_MIN_KHZ = 1_770_000, VCO_MAX_KHZ = VCO_MIN_KHZ * 2;
  const freqKhz = Math.trunc((freqHz + 500) / 1000);

  let mixDiv = 2, divNum = 0;
  while (mixDiv <= 64) {
    if (freqKhz * mixDiv >= VCO_MIN_KHZ && freqKhz * mixDiv < VCO_MAX_KHZ) {
      let db = mixDiv;
      while (db > 2) { db >>= 1; divNum++; }
      break;
    }
    mixDiv <<= 1;
  }
  if (fine > vcoPowerRef) divNum -= 1; else if (fine < vcoPowerRef) divNum += 1;

  const vcoFreq = freqHz * mixDiv;
  const vcoDiv = Math.trunc((pllRef + 65536 * vcoFreq) / (2 * pllRef));
  const nint = Math.trunc(vcoDiv / 65536);
  const sdm = vcoDiv % 65536;
  return { mixDiv, divNum, nint, sdm, ok: nint <= (128 / vcoPowerRef) - 1 };
}

/** The frequency the settings above actually produce, which is what makes them checkable. */
export function pllFreq(p: { mixDiv: number; nint: number; sdm: number }, pllRef: number): number {
  return (2 * pllRef * (p.nint + p.sdm / 65536)) / p.mixDiv;
}

/**
 * Which amplifier and mixer steps add up to the gain asked for.
 *
 * Neither stage is linear and neither is monotonic - the third LNA step is worth four decibels and the
 * fifteenth mixer step is worth minus one - so this walks the two alternately, exactly as librtlsdr does, and
 * stops at the first combination that reaches the target. That is why an RTL-SDR's gains are the ragged list
 * they are rather than an even ladder.
 */
export function gainSteps(tenthDb: number): { lna: number; mix: number; total: number } {
  let total = 0, lna = 0, mix = 0;
  for (let i = 0; i < 15; i++) {
    if (total >= tenthDb) break;
    total += LNA_STEPS[++lna];
    if (total >= tenthDb) break;
    total += MIX_STEPS[++mix];
  }
  return { lna, mix, total };
}

/** What an RTL-SDR can and cannot be asked for, so an app can say so rather than failing quietly. */
export const RTL_LIMITS: RadioLimits = {
  // The R82xx tracking filter runs out below about 24 MHz and the PLL above 1.766 GHz. Anything outside is
  // not a matter of sensitivity; the tuner simply will not go there.
  minHz: 24_000_000,
  maxHz: 1_766_000_000,
  // Two windows, exactly as the hardware defines them. Between 300 kHz and 900 kHz the resampler produces
  // nothing usable, and above 2.4 Msps the USB link starts dropping samples rather than slowing down.
  rates: [[225_001, 300_000], [900_001, 2_400_000]],
  canTransmit: false,
};

export class RtlSdr implements Radio {
  readonly kind = 'rtlsdr' as const;

  targetFreqHz = 433_920_000;
  targetRateHz = 2_000_000;
  /** Tuner gain in tenths of a decibel, or GAIN_AUTO. Near-maximum by default: too little gain reads as static. */
  targetGainTenthDb = 496;

  running = false;
  readonly limits = RTL_LIMITS;
  tuner = '';
  label = 'RTL-SDR';

  private epIn = 1;
  private stopFlag = false;
  /** A shadow of tuner registers 0x05..0x1f, because the part cannot be read back register by register. */
  private readonly tunerRegs = new Uint8Array(32);
  private tunerAddr = R820T_ADDR;
  /** The tuner's PLL reference, which is the RTL crystal on an R820T and a separate 16 MHz one on an R828D. */
  private tunerXtal = RTL_XTAL;
  /** Two on an R820T, one on an R828D. Sets how far the synthesizer's integer divider may go. */
  private vcoPowerRef = 2;
  private appliedFreq = 0; private appliedRate = 0; private appliedGain = Number.MAX_SAFE_INTEGER;
  private dbgBuffers = 0;
  /** The last transfer error, kept so the give-up message can say what actually went wrong. */
  private lastError: string | null = null;
  /** The last retune failure, so a retry that keeps failing logs once rather than every buffer. */
  private retuneError: string | null = null;
  /** Set once a retune has failed live and then landed with the reads drained: retune drained from then on. */
  private quietRetune = false;
  /** No retune before this time: set after a retune fails even with the reads drained. */
  private retuneAfter = 0;

  constructor(private dev: USBDevice, private ev: RadioEvents) {}

  static async remembered(): Promise<USBDevice | undefined> {
    return (await navigator.usb.getDevices()).find(isRtlSdr);
  }

  static request(): Promise<USBDevice> {
    return navigator.usb.requestDevice({ filters: RTLSDR_FILTERS });
  }

  async open(): Promise<void> {
    await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    await this.dev.claimInterface(0);
    const alt = this.dev.configuration?.interfaces[0]?.alternate;
    const ep = alt?.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
    if (!ep) throw new Error('no bulk-IN endpoint');
    this.epIn = ep.endpointNumber;
    this.ev.onLog(`RTL-SDR: RX endpoint=0x${(0x80 | this.epIn).toString(16)}`);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true; this.stopFlag = false; this.dbgBuffers = 0;
    this.appliedFreq = 0; this.appliedRate = 0; this.appliedGain = Number.MAX_SAFE_INTEGER;
    try {
      this.ev.onLog('=== RTL-SDR bring-up (RTL2832U + R82xx, WebUSB) ===');
      this.ev.onStatus('RTL-SDR · initializing…');
      // A dongle left running by another program halts its endpoint; clear it before touching anything.
      try { await this.dev.clearHalt('in', this.epIn); } catch { /* nothing was stalled */ }

      await this.initBaseband();
      await this.initTuner();
      await this.setSampleRate(this.targetRateHz); this.appliedRate = this.targetRateHz;
      await this.setCenterFreq(this.targetFreqHz); this.appliedFreq = this.targetFreqHz;
      await this.applyGain(this.targetGainTenthDb); this.appliedGain = this.targetGainTenthDb;
      await this.resetBuffer();

      this.ev.onLog(`RTL-SDR: streaming ${(this.targetFreqHz / 1e6).toFixed(3)} MHz @ ${(this.targetRateHz / 1e6).toFixed(3)} Msps`);
      await this.stream();
    } catch (e) {
      this.ev.onLog(`RTL-SDR error: ${(e as Error).message}`);
      this.ev.onStatus(`RTL-SDR stopped: ${(e as Error).message}`);
    } finally {
      try { await this.dev.releaseInterface(0); } catch { /* device may be gone */ }
      try { await this.dev.close(); } catch { /* ignore */ }
      this.running = false;
      this.ev.onLog('RTL-SDR: RX loop stopped');
    }
  }

  stop(): void { this.stopFlag = true; }

  /**
   * Gain, in the three terms the interface offers, mapped onto the one knob this radio has.
   *
   * The tuner's own automatic mode is deliberately not used: the RTL2832U's AGC loops are switched off during
   * bring-up, which leaves hardware auto-gain unreliable and prone to parking near minimum, where everything
   * reads as static. The app's own automatic gain is better anyway - it watches the actual converter level -
   * and it happens to fit: it steps VGA two decibels at a time across nought to sixty-two and only reaches for
   * the LNA when that saturates. Taking VGA as the tuner gain therefore gives the whole 0-49.6 dB range
   * straight from the existing loop, with the LNA and the amplifier left doing nothing, which is the truth.
   */
  setGain(_lnaDb: number, vgaDb: number, _amp: boolean): void {
    this.targetGainTenthDb = Math.max(0, Math.min(Math.round(RTL_MAX_GAIN_DB * 10), Math.round(vgaDb * 10)));
  }

  // ---- streaming ------------------------------------------------------------------------------------------

  private async stream(): Promise<void> {
    const N = 8, SIZE = 65536;
    // Several reads are kept in flight so the dongle never waits on us. Each carries its own catch: when one
    // fails - the device unplugged, the endpoint gone - the other seven fail moments later, and a rejected
    // promise nobody is waiting on yet takes the whole page down rather than the receiver.
    const read = (): Promise<USBInTransferResult> =>
      this.dev.transferIn(this.epIn, SIZE).catch((e: Error) => {
        this.lastError = e.message;
        return { status: 'babble', data: undefined } as unknown as USBInTransferResult;
      });
    const inflight: Promise<USBInTransferResult>[] = [];
    for (let i = 0; i < N; i++) inflight.push(read());
    let lastStatus = 0, bad = 0;
    while (!this.stopFlag) {
      const res = await inflight.shift()!;
      if (!this.stopFlag) inflight.push(read());
      if (res.status !== 'ok' || !res.data) {
        // A run of failures means the radio has gone, not that one buffer was unlucky.
        if (++bad > N * 2) { this.ev.onLog(`RTL-SDR: giving up — ${this.lastError ?? res.status}`); break; }
        if (bad === 1) this.ev.onLog(`RTL-SDR: transfer ${res.status}${this.lastError ? ` — ${this.lastError}` : ''}`);
        if (res.status === 'stall') { try { await this.dev.clearHalt('in', this.epIn); } catch { /* gone */ } }
        continue;
      }
      bad = 0;
      const dv = res.data;
      const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

      // The dongle sends offset binary - zero signal sits at 127 - where every other radio in this app sends
      // signed samples. Flipping the top bit rebases one to the other exactly, in place, with no arithmetic:
      // 0 becomes -128, 255 becomes 127. The half-count of residual offset is far under the noise floor.
      for (let k = 0; k < raw.length; k++) raw[k] ^= 0x80;
      const buf = new Int8Array(dv.buffer, dv.byteOffset, dv.byteLength);

      if (this.dbgBuffers < 3) {
        this.dbgBuffers++;
        let nz = 0, mn = 127, mx = -128;
        for (let k = 0; k < buf.length; k++) { const v = buf[k]; if (v !== 0) nz++; if (v < mn) mn = v; if (v > mx) mx = v; }
        this.ev.onLog(`RTL-SDR raw: n=${buf.length} nonZero=${nz}/${buf.length} min=${mn} max=${mx}`);
        if (nz === 0) {
          this.ev.onLog('RTL-SDR: all-zero samples — the tuner is not delivering. Check the aerial and try a different USB port.');
          this.ev.onStatus('RTL-SDR: no signal — check aerial / cable');
        }
      }

      this.ev.onIq(buf);
      if (this.targetRateHz !== this.appliedRate) {
        // A sample-rate change resets the bulk FIFO (resetBuffer), which aborts any transferIn still in flight
        // ("transfer babble") and the stream never recovers — that is what froze an app switch from 2.4 to
        // 1.92 Msps. Drain the pending reads so the reset lands with nothing outstanding, then re-prime. Freq
        // and gain are I2C-only, touch no endpoint, and stay live in applyPending below.
        const rest = inflight.splice(0);
        await Promise.allSettled(rest);
        try { await this.setSampleRate(this.targetRateHz); await this.resetBuffer(); this.appliedRate = this.targetRateHz; }
        catch (e) { this.ev.onLog(`RTL-SDR: rate change failed — ${(e as Error).message}`); }
        try { await this.dev.clearHalt('in', this.epIn); } catch { /* nothing was stalled */ }
        if (!this.stopFlag) for (let i = 0; i < N; i++) inflight.push(read());
        bad = 0;
      }
      if (this.pending() && performance.now() >= this.retuneAfter) {
        // Retune between buffers. Live first - with reads in flight it costs nothing - unless this machine has
        // already shown it needs a quiet bus. Some USB stacks fail control transfers sent while bulk reads are
        // outstanding; there every retune failed, the radio stayed where it was (stuck on broadcast FM, which
        // the launcher reaches without a retune) and, before retries, the stream closed instead. So on a
        // failure: drain the reads, retune with nothing outstanding, re-prime - exactly what a rate change does.
        let ok = !this.quietRetune && await this.applyPending();
        if (!ok) {
          const rest = inflight.splice(0);
          await Promise.allSettled(rest);
          ok = await this.applyPending();
          try { await this.dev.clearHalt('in', this.epIn); } catch { /* nothing was stalled */ }
          if (!this.stopFlag) for (let i = 0; i < N; i++) inflight.push(read());
          bad = 0;
          // Still failing with the bus quiet: something else is wrong. Back off rather than drain every buffer.
          if (!ok) this.retuneAfter = performance.now() + 1000;
          if (ok && !this.quietRetune) {
            this.quietRetune = true;
            this.ev.onLog('RTL-SDR: this USB stack rejects retunes during streaming — retuning between drained reads from now on');
          }
        }
      }
      const now = performance.now();
      if (now - lastStatus > 1000) { lastStatus = now; this.ev.onStatus(`${this.label} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`); }
    }
    await Promise.allSettled(inflight);
  }

  /** Whether a frequency or gain change is waiting. Rate changes are not here: they reset the bulk FIFO and so
   *  are handled in stream(), which first drains the reads in flight. */
  private pending(): boolean {
    return this.targetFreqHz !== this.appliedFreq || this.targetGainTenthDb !== this.appliedGain;
  }

  /** Apply a pending frequency and gain. True when both landed; on a failure the applied value stays stale. */
  private async applyPending(): Promise<boolean> {
    // A control transfer can fail once without the dongle being gone, and switching apps is exactly when a
    // retune lands on top of a busy bus. Thrown out of here it would end stream() and close the device, which
    // is a disconnect the user has to undo by hand. Caught, the applied value stays stale and the next buffer
    // tries again; a dongle that really has gone still ends the loop through its failed bulk reads.
    try {
      if (this.targetFreqHz !== this.appliedFreq) {
        await this.setCenterFreq(this.targetFreqHz);
        this.appliedFreq = this.targetFreqHz;
      }
      if (this.targetGainTenthDb !== this.appliedGain) {
        await this.applyGain(this.targetGainTenthDb);
        this.appliedGain = this.targetGainTenthDb;
      }
      this.retuneError = null;
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.retuneError) this.ev.onLog(`RTL-SDR: retune failed, retrying — ${msg}`);
      this.retuneError = msg;
      return false;
    }
  }

  // ---- RTL2832U registers ---------------------------------------------------------------------------------

  /** Block register write. Two-byte values go out big-endian, which is not how they read back. */
  private async writeReg(block: number, addr: number, val: number, len: number): Promise<void> {
    const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
    await this.dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: (block << 8) | 0x10 }, data);
  }

  /** Block register read, one byte. */
  private async readReg(block: number, addr: number): Promise<number> {
    const r = await this.dev.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: block << 8 }, 1);
    return r.status === 'ok' && r.data && r.data.byteLength ? r.data.getUint8(0) : 0;
  }

  /** Drive one of the RTL2832U's GPIO pins as an output (librtlsdr rtlsdr_set_gpio_output + _set_gpio_bit). */
  private async setGpio(pin: number, on: boolean): Promise<void> {
    const bit = 1 << pin;
    await this.writeReg(SYSB, GPD, (await this.readReg(SYSB, GPD)) & ~bit, 1);
    await this.writeReg(SYSB, GPOE, (await this.readReg(SYSB, GPOE)) | bit, 1);
    const v = await this.readReg(SYSB, GPO);
    await this.writeReg(SYSB, GPO, on ? v | bit : v & ~bit, 1);
  }

  private async demodWrite(page: number, addr: number, val: number, len: number): Promise<void> {
    const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
    await this.dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: 0x10 | page }, data);
    // Required by the hardware after every demodulator write. Skipping it works until suddenly it does not.
    await this.demodRead(0x0a, 0x01, 1);
  }

  private async demodRead(page: number, addr: number, len: number): Promise<number> {
    const r = await this.dev.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: page }, len);
    if (r.status !== 'ok' || !r.data || r.data.byteLength !== len) return 0;
    return len === 1 ? r.data.getUint8(0) : (r.data.getUint8(1) << 8) | r.data.getUint8(0);
  }

  private async setFir(): Promise<void> {
    const fir = firBytes();
    for (let j = 0; j < 20; j++) await this.demodWrite(1, 0x1c + j, fir[j], 1);
  }

  private async initBaseband(): Promise<void> {
    await this.writeReg(USBB, USB_SYSCTL, 0x09, 1);
    await this.writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2);
    await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
    await this.writeReg(SYSB, DEMOD_CTL_1, 0x22, 1);
    await this.writeReg(SYSB, DEMOD_CTL, 0xe8, 1);
    await this.demodWrite(1, 0x01, 0x14, 1); await this.demodWrite(1, 0x01, 0x10, 1);   // soft reset
    await this.demodWrite(1, 0x15, 0x00, 1); await this.demodWrite(1, 0x16, 0x0000, 2);
    for (let i = 0; i < 6; i++) await this.demodWrite(1, 0x16 + i, 0x00, 1);            // clear DDC shift and IF
    await this.setFir();
    await this.demodWrite(0, 0x19, 0x05, 1);        // SDR mode, digital AGC off
    await this.demodWrite(1, 0x93, 0xf0, 1); await this.demodWrite(1, 0x94, 0x0f, 1);
    await this.demodWrite(1, 0x11, 0x00, 1);        // AGC off
    await this.demodWrite(1, 0x04, 0x00, 1);        // RF and IF AGC loops off
    await this.demodWrite(DEMODB, 0x61, 0x60, 1);   // no PID filter
    await this.demodWrite(DEMODB, 0x06, 0x80, 1);   // the plain ADC I/Q datapath
    await this.demodWrite(1, 0xb1, 0x1b, 1);        // zero-IF, DC cancellation, IQ compensation
    await this.demodWrite(DEMODB, 0x0d, 0x83, 1);   // no clock on TP_CK0
  }

  private async setIfFreq(freqHz: number): Promise<void> {
    const ifFreq = -Math.trunc((freqHz * 0x400000) / RTL_XTAL);
    await this.demodWrite(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
    await this.demodWrite(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
    await this.demodWrite(1, 0x1b, ifFreq & 0xff, 1);
  }

  private async setSampleRate(rate: number): Promise<void> {
    const rsamp = Math.trunc((RTL_XTAL * 0x400000) / rate) & 0x0ffffffc;
    await this.demodWrite(1, 0x9f, (rsamp >> 16) & 0xffff, 2);
    await this.demodWrite(1, 0xa1, rsamp & 0xffff, 2);
    await this.demodWrite(1, 0x3e, 0, 1); await this.demodWrite(1, 0x3f, 0, 1);   // no crystal correction
    await this.demodWrite(1, 0x01, 0x14, 1); await this.demodWrite(1, 0x01, 0x10, 1);
  }

  private setI2cRepeater(on: boolean): Promise<void> {
    return this.demodWrite(1, 0x01, on ? 0x18 : 0x10, 1);
  }

  private async resetBuffer(): Promise<void> {
    await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
    await this.writeReg(USBB, USB_EPA_CTL, 0x0000, 2);
  }

  private async setCenterFreq(freqHz: number): Promise<void> {
    await this.setI2cRepeater(true);
    await this.r82xxSetFreq(freqHz);
    await this.setI2cRepeater(false);
  }

  // ---- I2C to the tuner -----------------------------------------------------------------------------------

  private async i2cWrite(bytes: Uint8Array): Promise<void> {
    await this.dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0, value: this.tunerAddr, index: (IICB << 8) | 0x10 }, bytes);
  }

  /** Read `len` tuner registers - the part always starts at register zero - and un-reverse each byte. */
  private async r82xxRead(len: number): Promise<number[]> {
    const out = new Array<number>(len).fill(0);
    const raw = await this.i2cReadRaw(len);
    for (let i = 0; i < len && i < raw.length; i++) out[i] = bitrev(raw[i]);
    return out;
  }

  /**
   * Read straight from the tuner's I2C address, without un-reversing.
   *
   * A dongle whose tuner is not at the address being asked does not answer with zeroes: it stalls the control
   * endpoint, which surfaces here as a thrown error. That is an answer - "nothing lives here" - and not a
   * failure, so it must not be allowed to escape and take the whole bring-up with it. The Android driver this
   * was ported from never met this because it only ever spoke to one address, and that platform returns a
   * negative length where the browser throws.
   */
  private async i2cReadRaw(len: number): Promise<number[]> {
    try {
      const r = await this.dev.controlTransferIn(
        { requestType: 'vendor', recipient: 'device', request: 0, value: this.tunerAddr, index: IICB << 8 }, len);
      if (r.status !== 'ok' || !r.data) return [];
      const out: number[] = [];
      for (let i = 0; i < len && i < r.data.byteLength; i++) out.push(r.data.getUint8(i));
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Write consecutive tuner registers, in chunks of seven data bytes.
   *
   * The RTL2832U's I2C master carries eight bytes per transaction and the first is the register address, so
   * seven is the ceiling. This only matters for the twenty-seven byte init block, and it matters enormously:
   * sent in one go it is truncated after register 0x0b without any error, leaving the PLL charge pump, the VCO
   * bias and the mixer top at power-on defaults. The tuner acknowledges, the PLL claims lock, and the dongle
   * produces nothing but static that gain has no effect on.
   */
  private async tunerWrite(startReg: number, vals: number[]): Promise<void> {
    for (let pos = 0; pos < vals.length;) {
      const size = Math.min(7, vals.length - pos);
      const b = new Uint8Array(size + 1);
      b[0] = (startReg + pos) & 0xff;
      for (let i = 0; i < size; i++) {
        b[i + 1] = vals[pos + i] & 0xff;
        const reg = startReg + pos + i;
        if (reg >= 5 && reg < 32) this.tunerRegs[reg] = vals[pos + i] & 0xff;
      }
      await this.i2cWrite(b);
      pos += size;
    }
  }

  private tunerWriteReg(reg: number, v: number): Promise<void> { return this.tunerWrite(reg, [v & 0xff]); }

  private tunerWriteMask(reg: number, v: number, mask: number): Promise<void> {
    return this.tunerWriteReg(reg, (this.tunerRegs[reg] & ~mask) | (v & mask));
  }

  // ---- R820T / R820T2 / R828D tuner -----------------------------------------------------------------------

  /**
   * Find which tuner is fitted and bring it up.
   *
   * Both parts answer with a recognisable value at register zero; only the I2C address and the PLL reference
   * crystal differ, which is why librtlsdr drives them with one body of code. Probing rather than assuming is
   * what lets an RTL-SDR Blog V4 work, since those carry an R828D and are most of what is sold now.
   */
  private async initTuner(): Promise<void> {
    // The demodulator side for an R82xx: no zero-IF, in-phase ADC only, 3.57 MHz IF, spectrum inverted back.
    await this.demodWrite(1, 0xb1, 0x1a, 1);
    await this.demodWrite(DEMODB, 0x08, 0x4d, 1);
    await this.setIfFreq(R82XX_IF_HZ);
    await this.demodWrite(1, 0x15, 0x01, 1);

    await this.setI2cRepeater(true);
    let found = false;
    for (const [addr, xtal, ref, name] of [
      [R820T_ADDR, RTL_XTAL, 2, 'R820T/R820T2'],
      [R828D_ADDR, R828D_XTAL, 1, 'R828D'],
    ] as const) {
      this.tunerAddr = addr;
      // Compared raw rather than un-reversed, so this is the same 0x69 librtlsdr looks for at register zero.
      // An address with nothing on it stalls instead of answering, and comes back empty.
      const probe = await this.i2cReadRaw(1);
      if (probe.length && probe[0] === R82XX_CHECK_VAL) {
        this.tunerXtal = xtal; this.vcoPowerRef = ref; this.tuner = name; found = true;
        this.ev.onLog(`RTL-SDR: tuner ${name} at I2C 0x${addr.toString(16)}`);
        break;
      }
    }
    if (!found) {
      this.tunerAddr = R820T_ADDR; this.tunerXtal = RTL_XTAL; this.vcoPowerRef = 2; this.tuner = 'unknown';
      this.ev.onLog('RTL-SDR: no R82xx answered. An E4000 or FC0012 dongle is not supported yet — expect static.');
    }
    // A V4L's R828S passes for an R820T on the bus; its USB strings are what give it away. It runs from the RTL's
    // 28.8 MHz like an R820T but wants the R828D's VCO power reference of one (librtlsdr r82xx_set_pll).
    if (found && this.tunerAddr === R820T_ADDR
        && usbString(this.dev.manufacturerName) === BLOG_MAKER && usbString(this.dev.productName) === BLOG_V4L) {
      this.tuner = 'R828S'; this.vcoPowerRef = 1;
      this.ev.onLog('RTL-SDR: RTL-SDR Blog V4L (R828S)');
    }
    this.label = this.tuner === 'R828S' ? 'RTL-SDR Blog V4L' : `RTL-SDR · ${this.tuner}`;

    for (let i = 0; i < R82XX_INIT.length; i++) this.tunerRegs[5 + i] = R82XX_INIT[i];
    await this.tunerWrite(0x05, R82XX_INIT);
    if (found && this.tuner === 'R828D') await this.pickR828dReference();
    await this.setTvStandard();
    await this.sysFreqSel();
    await this.setI2cRepeater(false);
    // Newer V4L batches route the antenna through an upconverter switch on GPIO5: high is the direct path that
    // everything from 24 MHz up uses, low is the HF upconverter. This driver does not tune HF, so it is set once.
    if (this.tuner === 'R828S') await this.setGpio(5, true);
  }

  /**
   * Find which clock this R828D's synthesizer actually runs from, by trying to lock against each.
   *
   * The part turns up wired two ways. Upstream librtlsdr assumes sixteen megahertz, which is what the Astrometa
   * sticks give it; an RTL-SDR Blog V4 shares the RTL's own 28.8 MHz instead. Get it wrong and the divider is
   * out by nearly a factor of two, which puts the VCO a long way outside the range it can reach, so it never
   * locks - and the dongle still passes a little signal, which makes it look like a weak aerial rather than a
   * mistuned synthesizer.
   *
   * There is no register that answers this, so it is measured: ask for a frequency in the middle of the tuner's
   * range against each candidate and keep whichever one reports lock.
   */
  private async pickR828dReference(): Promise<void> {
    for (const cand of [R828D_XTAL, RTL_XTAL]) {
      this.tunerXtal = cand;
      if (await this.r82xxSetPll(100_000_000, true)) {
        this.ev.onLog(`RTL-SDR: R828D locks against ${(cand / 1e6).toFixed(1)} MHz`);
        return;
      }
    }
    this.tunerXtal = R828D_XTAL;
    this.ev.onLog('RTL-SDR: R828D would not lock against either reference — expect a weak, mistuned front end.');
  }

  /** Calibrate the channel filter, twice if the first attempt lands on a reserved value. */
  private async setTvStandard(): Promise<void> {
    const filtQ = 0x10;
    let filCal = 0;
    for (let i = 0; i < 2; i++) {
      await this.tunerWriteMask(0x0f, 0x04, 0x04);      // calibration clock on
      await this.r82xxSetPll(56_000_000);               // calibrate against 56 MHz
      await this.tunerWriteMask(0x0b, 0x10, 0x10);      // trigger
      await this.tunerWriteMask(0x0b, 0x00, 0x10);
      await this.tunerWriteMask(0x0f, 0x00, 0x04);      // calibration clock off
      filCal = (await this.r82xxRead(5))[4] & 0x0f;
      if (filCal !== 0 && filCal !== 0x0f) break;
    }
    if (filCal === 0x0f) filCal = 0;
    await this.tunerWriteMask(0x0a, filtQ | filCal, 0x1f);
  }

  private async sysFreqSel(): Promise<void> {
    await this.tunerWriteMask(0x05, 0x00, 0x60);
    await this.tunerWriteMask(0x06, 0x00, 0x08);
    await this.tunerWriteMask(0x1d, 0x00, 0x38);
    await this.tunerWriteMask(0x06, 0x00, 0x40);
    await this.tunerWriteMask(0x1a, 0x30, 0x30);
    await this.tunerWriteMask(0x1d, 0x18, 0x38);
    await this.tunerWriteMask(0x1a, 0x20, 0x30);
  }

  private async setMux(loFreqHz: number): Promise<void> {
    const mhz = Math.trunc(loFreqHz / 1_000_000);
    let r = FREQ_RANGES[0];
    for (const fr of FREQ_RANGES) { if (mhz >= fr.freq) r = fr; else break; }
    await this.tunerWriteMask(0x17, r.openD, 0x08);
    await this.tunerWriteMask(0x1a, r.rfMux, 0xc3);
    await this.tunerWriteReg(0x1b, r.tfC);
    await this.tunerWriteMask(0x10, r.cap0p, 0x0b);
    await this.tunerWriteMask(0x08, 0x00, 0x3f);
    await this.tunerWriteMask(0x09, 0x00, 0x3f);
  }

  /** The fractional-N synthesizer. Returns false when it will not lock, which is worth saying out loud. */
  private async r82xxSetPll(freqHz: number, quiet = false): Promise<boolean> {
    const pllRef = this.tunerXtal;
    const VCO_CURR_MIN = 0x80, VCO_CURR_MAX = 0x60;

    await this.tunerWriteMask(0x10, 0x00, 0x10);        // reference divider of one
    await this.tunerWriteMask(0x1a, 0x00, 0x0c);        // autotune at 128 kHz while we settle
    await this.tunerWriteMask(0x12, VCO_CURR_MIN, 0xe0);

    // Nudge the divider by what the VCO's own fine-tune reading says about where it is sitting.
    const fine = ((await this.r82xxRead(5))[4] & 0x30) >> 4;
    const plan = pllPlan(freqHz, pllRef, fine, this.vcoPowerRef);
    await this.tunerWriteMask(0x10, plan.divNum << 5, 0xe0);
    if (!plan.ok) {
      this.ev.onLog(`RTL-SDR: PLL integer out of range at ${(freqHz / 1e6).toFixed(3)} MHz`);
      return false;
    }
    const { nint, sdm } = plan;

    const ni = Math.trunc((nint - 13) / 4);
    const si = nint - 4 * ni - 13;
    await this.tunerWriteReg(0x14, ni + (si << 6));
    await this.tunerWriteMask(0x12, sdm === 0 ? 0x08 : 0x00, 0x18);
    await this.tunerWriteReg(0x16, sdm >> 8);
    await this.tunerWriteReg(0x15, sdm & 0xff);

    let locked = false, saw: number[] = [];
    for (let i = 0; i < 2; i++) {
      saw = await this.r82xxRead(3);
      if ((saw[2] & 0x40) !== 0) { locked = true; break; }
      if (i === 0) await this.tunerWriteMask(0x12, VCO_CURR_MAX, 0xe0);   // more current, try again
    }
    if (!locked) {
      // Say what the part actually reported. An empty read means the I2C never answered, which is a different
      // fault from a synthesizer that answered and said it had not settled.
      if (!quiet) {
        this.ev.onLog(`RTL-SDR: PLL lock bit clear — status ${saw.length ? saw.map(v => v.toString(16).padStart(2, '0')).join(' ') : '(no answer)'}, nint ${nint} sdm ${sdm} mixDiv ${plan.mixDiv}`);
      }
      return false;
    }
    await this.tunerWriteMask(0x1a, 0x08, 0x08);        // back to 8 kHz autotune now it is locked
    return true;
  }

  private async r82xxSetFreq(rfHz: number): Promise<void> {
    const lo = rfHz + R82XX_IF_HZ;                      // low-side injection; the demodulator un-inverts
    await this.setMux(lo);
    // The R828D (RTL-SDR Blog V4, Astrometa) has three RF inputs, and the aerial sits on the air-in below
    // ~345 MHz and the cable-in above it. librtlsdr steers register 0x05 bit 6:5 (mask 0x60) to pick them; the
    // init block leaves it at 0x00 (cable-in), so on a V4 nothing below 345 MHz — FM, APRS, air, 2 m — ever
    // reached the mixer, which read as a dead aerial. An R820T/R820T2 has one input and ignores this bit.
    if (this.tuner === 'R828D') await this.tunerWriteMask(0x05, rfHz > 345_000_000 ? 0x00 : 0x60, 0x60);
    // The V4L's R828S has one input fewer: cable-1 for HF (0x05 bit 6) and the air-in for everything else, with
    // the air-in enabled by clearing bit 5. Above HF both bits are clear (librtlsdr r82xx_set_freq, V4L branch).
    if (this.tuner === 'R828S') await this.tunerWriteMask(0x05, 0x00, 0x60);
    if (!(await this.r82xxSetPll(lo))) {
      this.ev.onLog(`RTL-SDR: PLL did not lock at ${(rfHz / 1e6).toFixed(3)} MHz`);
    }
  }

  /**
   * Set the tuner gain.
   *
   * The R82xx has no single gain control: it has a low-noise amplifier and a mixer, each with sixteen steps
   * worth a different and quite uneven number of decibels. Walking the two alternately until the total reaches
   * what was asked for is what librtlsdr does, and it is why the achievable gains are the ragged list they are.
   */
  private async applyGain(tenthDb: number): Promise<void> {
    await this.setI2cRepeater(true);
    if (tenthDb === GAIN_AUTO) {
      await this.tunerWriteMask(0x05, 0x00, 0x10);      // amplifier automatic
      await this.tunerWriteMask(0x07, 0x10, 0x10);      // mixer automatic
      await this.tunerWriteMask(0x0c, 0x0b, 0x9f);      // output stage fixed mid-scale
    } else {
      const { lna, mix } = gainSteps(tenthDb);
      await this.tunerWriteMask(0x05, 0x10, 0x10);      // amplifier manual
      await this.tunerWriteMask(0x07, 0x00, 0x10);      // mixer manual
      await this.tunerWriteMask(0x05, lna, 0x0f);
      await this.tunerWriteMask(0x07, mix, 0x0f);
      await this.tunerWriteMask(0x0c, 0x08, 0x9f);      // output stage fixed at about 13.5 dB
    }
    await this.setI2cRepeater(false);
  }
}
