/**
 * InterMet iMet-1-RSB and iMet-4: Bell 202 AFSK (1200 baud, 1200 Hz = 1, 2200 Hz = 0) on the FM carrier, bytes as
 * 8N1 (start 0, 8 data bits least significant first, stop 1), the line idling on the mark tone. Once a second a burst
 * of packets, each [0x01 SOH, id, data, CRC16 big-endian]: PTU (0x01) or extended PTU (0x04) with the frame counter,
 * pressure, temperature, humidity and battery; GPS (0x02) or extended GPS (0x05, with velocities) with position,
 * satellites and time of day; extra data (0x03, ozone and other instruments). The CRC is CRC-16/AUG-CCITT (0x1021,
 * start 0x1D0F) from the SOH up to the CRC.
 *
 * The sonde sends no serial number. Like radiosonde_auto_rx, the ID is made from the power-on time (GPS time minus the
 * frame counter; the iMet-1 counts twice a second, the iMet-4 once, which two frames tell apart) and the frequency
 * rounded to 100 kHz: "IMET-" + the last 8 hex digits of SHA-256("YYYY-MM-DDTHH:MM:SSZ" + "402.000 MHz" + "SONDE").
 * The channel frequency comes from the receiver through `hz`.
 *
 * Tone detection is a sliding one-bit DFT at the two tones on the discriminator output (a ring of one bit's
 * products), and each byte re-times itself on its start bit's falling edge.
 */
import type { ChannelDecoder } from './bank.js';
import type { SondeFrame, SondeSink } from './types.js';
import { Sha256 } from '../lora/sha256.js';

export const IMET_BAUD = 1200;
export const IMET_MARK = 1200, IMET_SPACE = 2200;
export const PKT_PTU = 0x01, PKT_GPS = 0x02, PKT_XDATA = 0x03, PKT_EPTU = 0x04, PKT_EGPS = 0x05;
/** Packet length by id, SOH and CRC included (XDATA: 5 + N). */
export const IMET_PKT_LEN = [0, 14, 18, 0, 20, 30];

/** CRC-16/AUG-CCITT over `len` bytes from `start`. */
export function imetCrc(b: ArrayLike<number>, start: number, len: number): number {
  let rem = 0x1d0f;
  for (let i = 0; i < len; i++) {
    rem ^= b[start + i] << 8;
    for (let j = 0; j < 8; j++) rem = rem & 0x8000 ? ((rem << 1) ^ 0x1021) & 0xffff : (rem << 1) & 0xffff;
  }
  return rem;
}

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const i16 = (b: Uint8Array, p: number) => (u16(b, p) << 16) >> 16;
const fv = new DataView(new ArrayBuffer(4));
const f32 = (b: Uint8Array, p: number) => { for (let k = 0; k < 4; k++) fv.setUint8(k, b[p + k]); return fv.getFloat32(0, true); };

/** The auto_rx date for a GPS time of day: today's UTC date, moved a day when the sonde and the clock straddle midnight. */
export function imetDateTimeMs(timeS: number, nowMs: number): number {
  const day = Math.floor(nowMs / 86_400_000) * 86_400_000;
  let t = day + Math.floor(timeS) * 1000;
  const nowH = Math.floor((nowMs - day) / 3_600_000), sondeH = Math.floor(timeS / 3600);
  if (nowH === 0 && sondeH === 23) t -= 86_400_000;
  else if (nowH === 23 && sondeH === 0) t += 86_400_000;
  return t;
}
/** "IMET-" + the last 8 hex digits of the SHA-256 of the text. */
export function imetHashId(text: string): string {
  const m = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) m[i] = text.charCodeAt(i) & 0x7f;
  const h = Sha256.hash(m);
  let s = 'IMET-';
  for (let i = 28; i < 32; i++) s += (h[i] < 16 ? '0' : '') + h[i].toString(16).toUpperCase();
  return s;
}
/** The frequency part of the ID: MHz rounded to 100 kHz, three decimals ("" when the channel frequency is unknown). */
export function imetFreqText(hz: number): string {
  return hz > 0 ? `${(Math.round(hz / 1e5) / 10).toFixed(3)} MHz` : '';
}
/** auto_rx's iMet ID from the power-on time (ms since 1970) and the channel frequency. */
export function imetUniqueId(powerOnMs: number, hz: number): string {
  return imetHashId(new Date(powerOnMs).toISOString().slice(0, 19) + 'Z' + imetFreqText(hz) + 'SONDE');
}

const INSTRUMENTS: Record<number, string> = { 0x01: 'ozone (ECC)', 0x05: 'ozone (OIF411)', 0x08: 'frost-point hygrometer (CFH)', 0x19: 'aerosol (COBALD)' };

export class ImetDecoder implements ChannelDecoder {
  readonly name = 'iMet';
  /** The channel's frequency, Hz, for the ID (set by the receiver; 0 = unknown). */
  hz = 0;
  /** Wall clock, ms (the date half of the GPS time; replaceable for tests). */
  clock: () => number = () => Date.now();

  // tone detector: sliding DFT over one bit at the two tones
  private readonly L: number;
  private readonly bitLen: number;
  private readonly ring: Float64Array;
  private rp = 0;
  private s1r = 0; private s1i = 0; private s2r = 0; private s2i = 0;
  private o1r = 1; private o1i = 0; private o2r = 1; private o2i = 0;
  private readonly c1r: number; private readonly c1i: number; private readonly c2r: number; private readonly c2i: number;
  private dc = 0; private amp = 0; private n = 0; private prev = 0;
  // UART
  private inByte = false; private nextAt = 0; private bitIx = 0; private cur = 0; private lastByteAt = -1e9;
  private readonly buf = new Uint8Array(512); private nb = 0;
  // packets and identity
  private gpsAt = -1e12; private gLat = 0; private gLon = 0; private gAlt = 0; private gSats = 0; private gTime = -1;
  private gVel = false; private gvE = 0; private gvN = 0; private gvU = 0;
  private model = '';
  private prevFrame = -1; private prevTime = -1;
  private id = ''; private idPowerOn = 0; private idHz = 0;

  constructor(rate: number, private readonly sink: SondeSink) {
    this.L = Math.max(4, Math.round(rate / IMET_BAUD));
    this.bitLen = rate / IMET_BAUD;
    this.ring = new Float64Array(4 * this.L);
    const w1 = 2 * Math.PI * IMET_MARK / rate, w2 = 2 * Math.PI * IMET_SPACE / rate;
    this.c1r = Math.cos(w1); this.c1i = -Math.sin(w1); this.c2r = Math.cos(w2); this.c2i = -Math.sin(w2);
  }

  /** One discriminator sample. */
  push(x: number): void {
    this.dc += (x - this.dc) * 0.002;
    let v = x - this.dc;
    // FM clicks (a near-2π phase jump in a few samples) would ring in both tone filters: clip at 1.5 times the mean level
    this.amp += ((v < 0 ? -v : v) - this.amp) * 0.001;
    const lim = 1.5 * this.amp;
    if (v > lim) v = lim; else if (v < -lim) v = -lim;
    // turn the two oscillators, mix, slide the one-bit sums
    let a = this.o1r * this.c1r - this.o1i * this.c1i; this.o1i = this.o1r * this.c1i + this.o1i * this.c1r; this.o1r = a;
    a = this.o2r * this.c2r - this.o2i * this.c2i; this.o2i = this.o2r * this.c2i + this.o2i * this.c2r; this.o2r = a;
    const r = this.ring, p = this.rp;
    const z1r = v * this.o1r, z1i = v * this.o1i, z2r = v * this.o2r, z2i = v * this.o2i;
    this.s1r += z1r - r[p]; this.s1i += z1i - r[p + 1]; this.s2r += z2r - r[p + 2]; this.s2i += z2i - r[p + 3];
    r[p] = z1r; r[p + 1] = z1i; r[p + 2] = z2r; r[p + 3] = z2i;
    this.rp = p + 4 === r.length ? 0 : p + 4;
    const n = ++this.n;
    if ((n & 4095) === 0) this.renormalize();
    // mark energy minus space energy: > 0 is a 1
    const d = this.s1r * this.s1r + this.s1i * this.s1i - this.s2r * this.s2r - this.s2i * this.s2i;
    if (!this.inByte) {
      if (this.prev >= 0 && d < 0) {
        // the window is half into the start bit now; it covers a whole bit half a bit later, and every bit after
        this.inByte = true; this.bitIx = 0; this.cur = 0; this.nextAt = n + this.bitLen / 2;
      } else if (this.nb > 0 && n - this.lastByteAt > 25 * this.bitLen) this.flush();
    } else if (n >= this.nextAt) {
      this.nextAt += this.bitLen;
      const k = this.bitIx++;
      if (k === 0) { if (d >= 0) this.inByte = false; }
      else if (k <= 8) { if (d > 0) this.cur |= 1 << (k - 1); }
      else {
        this.inByte = false;
        if (d > 0) {
          if (this.nb === this.buf.length) this.flush();
          this.buf[this.nb++] = this.cur; this.lastByteAt = n;
        } else this.flush();   // framing error: whatever came before is a burst of its own
      }
    }
    this.prev = d;
  }

  private renormalize(): void {
    let m = Math.sqrt(this.o1r * this.o1r + this.o1i * this.o1i); this.o1r /= m; this.o1i /= m;
    m = Math.sqrt(this.o2r * this.o2r + this.o2i * this.o2i); this.o2r /= m; this.o2i /= m;
    // and re-add the sums so rounding never builds up
    let a = 0, b = 0, c = 0, e = 0;
    for (let i = 0; i < this.ring.length; i += 4) { a += this.ring[i]; b += this.ring[i + 1]; c += this.ring[i + 2]; e += this.ring[i + 3]; }
    this.s1r = a; this.s1i = b; this.s2r = c; this.s2i = e;
  }

  private flush(): void {
    const n = this.nb;
    this.nb = 0;
    if (n >= 14) this.parseBurst(this.buf, n);
  }

  /**
   * One burst of bytes: every packet whose CRC checks, wherever it starts. A report goes out for a good PTU packet,
   * with the GPS packet of the same second.
   */
  parseBurst(b: Uint8Array, n: number): SondeFrame | null {
    let ptu = false, frame = 0, hPa = 0, tempC = 0, rh = 0, battV = 0;
    let ext = false, tInt = 0, tPr = 0, tU = 0;
    let aux = '', auxName = '';
    let i = 0;
    while (i + 5 <= n) {
      if (b[i] !== 0x01 || b[i + 1] < 1 || b[i + 1] > 5) { i++; continue; }
      const id = b[i + 1];
      const len = id === PKT_XDATA ? 5 + b[i + 2] : IMET_PKT_LEN[id];
      if (len <= 5 || i + len > n || imetCrc(b, i, len - 2) !== ((b[i + len - 2] << 8) | b[i + len - 1])) { i++; continue; }
      if (id === PKT_PTU || id === PKT_EPTU) {
        ptu = true;
        frame = u16(b, i + 2);
        hPa = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16)) / 100;
        tempC = i16(b, i + 7) / 100;
        rh = u16(b, i + 9) / 100;
        battV = b[i + 11] / 10;
        if (id === PKT_EPTU) { ext = true; tInt = i16(b, i + 12) / 100; tPr = i16(b, i + 14) / 100; tU = i16(b, i + 16) / 100; }
      } else if (id === PKT_GPS || id === PKT_EGPS) {
        const t = id === PKT_GPS ? i + 13 : i + 25;
        const hh = b[t], mm = b[t + 1], ss = b[t + 2];
        const lat = f32(b, i + 2), lon = f32(b, i + 6), alt = u16(b, i + 10) - 5000;
        if (hh < 24 && mm < 60 && ss < 61 && lat > -91 && lat < 91 && lon > -181 && lon < 181) {
          this.gpsAt = this.n; this.gLat = lat; this.gLon = lon; this.gAlt = alt; this.gSats = b[i + 12];
          this.gTime = hh * 3600 + mm * 60 + ss;
          this.gVel = id === PKT_EGPS;
          if (this.gVel) { this.gvE = f32(b, i + 13); this.gvN = f32(b, i + 17); this.gvU = f32(b, i + 21); }
        }
      } else {
        const N = b[i + 2];
        let hex = '';
        for (let k = 0; k < N; k++) hex += (b[i + 3 + k] < 16 ? '0' : '') + b[i + 3 + k].toString(16).toUpperCase();
        aux += (aux ? '#' : '') + hex;
        if (INSTRUMENTS[b[i + 3]]) auxName = INSTRUMENTS[b[i + 3]];
      }
      i += len;
    }
    if (!ptu) return null;
    // GPS from this burst (or the one just before, if a framing error split them)
    const gpsFresh = this.n - this.gpsAt < 1.5 * IMET_BAUD * this.bitLen && this.gTime >= 0;
    const locked = gpsFresh && this.gSats >= 4;
    const out: SondeFrame = { type: 'iMet', serial: '', frame, battV };
    if (hPa > 0) out.hPa = hPa;
    if (tempC > -100 && tempC < 60) out.tempC = tempC;
    if (rh >= 0 && rh <= 100) out.rh = rh;
    if (ext) out.extra = { 'INTERNAL TEMPERATURE': `${tInt.toFixed(2)} °C`, 'PRESSURE SENSOR': `${tPr.toFixed(2)} °C` };
    if (ext && tU > -100 && tU < 60) out.tHumC = tU;
    if (aux) out.extra = { ...out.extra, 'AUX DATA': aux.length > 40 ? aux.slice(0, 40) + '…' : aux, ...(auxName ? { AUX: auxName } : {}) };
    if (gpsFresh) {
      out.sats = this.gSats;
      if (locked && this.gAlt > -1000 && this.gAlt < 80000) {
        out.lat = this.gLat; out.lon = this.gLon; out.alt = this.gAlt; out.timeS = this.gTime;
        if (this.gVel) {
          const vH = Math.sqrt(this.gvE * this.gvE + this.gvN * this.gvN);
          let hd = Math.atan2(this.gvE, this.gvN) * 180 / Math.PI; if (hd < 0) hd += 360;
          if (vH < 1000 && this.gvU > -1000 && this.gvU < 1000) { out.vH = vH; out.heading = hd; out.climb = this.gvU; }
        }
      }
    }
    if (locked) {
      // iMet-1 or iMet-4: the frame counter against the clock over two frames (the first is held back for this)
      if (!this.model) {
        if (this.prevFrame < 0) { this.prevFrame = frame; this.prevTime = this.gTime; return null; }
        let dt = this.gTime - this.prevTime; if (dt < -43200) dt += 86400;
        const df = frame - this.prevFrame;
        if (dt <= 0 || df <= 0 || dt > 600) { this.prevFrame = frame; this.prevTime = this.gTime; return null; }
        this.model = dt === Math.floor(df / 2) ? 'iMet-1-RSB' : 'iMet-4';
      }
      out.model = this.model;
      const frameS = this.model === 'iMet-1-RSB' ? Math.floor(frame / 2) : frame;
      const powerOn = imetDateTimeMs(this.gTime, this.clock()) - frameS * 1000;
      // the same sonde gives the same power-on time to within the counter's phase against the GPS second
      if (!this.id || Math.abs(powerOn - this.idPowerOn) > 2000 || imetFreqText(this.hz) !== imetFreqText(this.idHz)) {
        this.id = imetUniqueId(powerOn, this.hz); this.idPowerOn = powerOn; this.idHz = this.hz;
      }
      out.serial = this.id;
      out.extra = { ...out.extra, 'POWER-ON': new Date(powerOn).toISOString().slice(0, 19) + 'Z' };
    } else {
      // no GPS lock: keep the ID we had, or one from the frequency alone until the first fix
      out.serial = this.id || imetHashId(imetFreqText(this.hz) + 'SONDE');
      if (this.model) out.model = this.model;
    }
    this.sink(out);
    return out;
  }
}
