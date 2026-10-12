/** ADS-B / Mode-S decoder from raw IQ at 2 Msps (dump1090 lineage; port of core/AdsbDecoder.kt + AdsbStore). */
import type { Emit, IqProcessor } from './core.js';

export interface Aircraft { icao: string; flight?: string; lat?: number; lon?: number; alt?: number; gs?: number; track?: number; vr?: number; seenMs: number; firstMs: number; }

const PREAMBLE = 8, LONG_BITS = 112, SHORT_BITS = 56, FULL_LEN = PREAMBLE + LONG_BITS;
const AIS_CHARS = '?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????';
const CRC_TABLE = [
  0x3935ea, 0x1c9af5, 0xf1b77e, 0x78dbbf, 0xc397db, 0x9e31e9, 0xb0e2f0, 0x587178, 0x2c38bc, 0x161c5e, 0x0b0e2f, 0xfa7d13, 0x82c48d, 0xbe9842, 0x5f4c21, 0xd05c14,
  0x682e0a, 0x341705, 0xe5f186, 0x72f8c3, 0xc68665, 0x9cb936, 0x4e5c9b, 0xd8d449, 0x939020, 0x49c810, 0x24e408, 0x127204, 0x093902, 0x049c81, 0xfdb444, 0x7eda22,
  0x3f6d11, 0xe04c8c, 0x702646, 0x381323, 0xe3f395, 0x8e03ce, 0x4701e7, 0xdc7af7, 0x91c77f, 0xb719bb, 0xa476d9, 0xadc168, 0x56e0b4, 0x2b705a, 0x15b82d, 0xf52612,
  0x7a9309, 0xc2b380, 0x6159c0, 0x30ace0, 0x185670, 0x0c2b38, 0x06159c, 0x030ace, 0x018567, 0xff38b7, 0x80665f, 0xbfc92b, 0xa01e91, 0xaff54c, 0x57faa6, 0x2bfd53,
  0xea04ad, 0x8af852, 0x457c29, 0xdd4410, 0x6ea208, 0x375104, 0x1ba882, 0x0dd441, 0xf91024, 0x7c8812, 0x3e4409, 0xe0d800, 0x706c00, 0x383600, 0x1c1b00, 0x0e0d80,
  0x0706c0, 0x038360, 0x01c1b0, 0x00e0d8, 0x00706c, 0x003836, 0x001c1b, 0xfff409, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const NL_BP = [14.82817437, 18.18626357, 21.02939493, 23.54504487, 25.82924707, 27.93898710, 29.91135686, 31.77209708, 33.53993436, 35.22899598, 36.85025108, 38.41241892,
  39.92256684, 41.38651832, 42.80914012, 44.19454951, 45.54626723, 46.86733252, 48.16039128, 49.42776439, 50.67150166, 51.89342469, 53.09516153, 54.27817472, 55.44378444,
  56.59318756, 57.72747354, 58.84763776, 59.95459277, 61.04917774, 62.13216659, 63.20427479, 64.26616523, 65.31845310, 66.36171008, 67.39646774, 68.42322022, 69.44242631,
  70.45451075, 71.45986473, 72.45884545, 73.45177442, 74.43893416, 75.42056257, 76.39684391, 77.36789461, 78.33374083, 79.29428225, 80.24923213, 81.19801349, 82.13956981,
  83.07199445, 83.99173563, 84.89166191, 85.75541621, 86.53536998, 87.0];

interface Cpr { evLat: number; evLon: number; odLat: number; odLon: number; evT: number; odT: number; haveEv: boolean; haveOd: boolean; }

export class AdsbDecoder implements IqProcessor {
  private readonly maglut = new Int32Array(129 * 129);
  private readonly carry = new Int32Array(FULL_LEN * 2 + 8);
  private carryLen = 0;
  private readonly cpr = new Map<string, Cpr>();
  private readonly icaoFrames = new Map<string, number>();
  private readonly planes = new Map<string, Aircraft>();
  private frames = 0;
  private dbg = { pre: 0, df: 0, ok: 0, fail: 0, last: 0 };
  private lastPublish = 0;
  /** Receiver position for single-frame CPR (set from the phone's geolocation). */
  ref: { lat: number; lon: number } | null = null;

  constructor(private readonly emit: Emit) {
    for (let i = 0; i <= 128; i++) for (let q = 0; q <= 128; q++) this.maglut[i * 129 + q] = Math.round(Math.sqrt(i * i + q * q) * 360);
  }

  reset(): void { this.carryLen = 0; this.cpr.clear(); this.icaoFrames.clear(); }
  /** CLEAR on the screen: forget every aircraft and the frame count, and say so, or the next frame re-sends them. */
  clear(): void { this.planes.clear(); this.cpr.clear(); this.frames = 0; this.emit({ type: 'aircraft', list: [], frames: 0 }); }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    if (nSamp < 8) return;
    const m = new Int32Array(this.carryLen + nSamp);
    m.set(this.carry.subarray(0, this.carryLen));
    for (let i = 0; i < nSamp; i++) {
      let iv = iq[2 * i]; if (iv < 0) iv = -iv; if (iv > 128) iv = 128;
      let qv = iq[2 * i + 1]; if (qv < 0) qv = -qv; if (qv > 128) qv = 128;
      m[this.carryLen + i] = this.maglut[iv * 129 + qv];
    }
    const mlen = m.length;
    const batch = new Map<string, Aircraft>();
    const nowMs = Date.now();
    const msg = new Int32Array(14);
    const bits = new Int32Array(LONG_BITS);
    let j = 0;
    const limit = mlen - FULL_LEN * 2;
    while (j < limit) {
      if (!(m[j] > m[j + 1] && m[j + 1] < m[j + 2] && m[j + 2] > m[j + 3] && m[j + 3] < m[j] && m[j + 4] < m[j] && m[j + 5] < m[j] && m[j + 6] < m[j] &&
        m[j + 7] > m[j + 8] && m[j + 8] < m[j + 9] && m[j + 9] > m[j + 6])) { j++; continue; }
      const high = ((m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 6) | 0;
      if (m[j + 4] >= high || m[j + 5] >= high) { j++; continue; }
      if (m[j + 11] >= high || m[j + 12] >= high || m[j + 13] >= high || m[j + 14] >= high) { j++; continue; }
      this.dbg.pre++;
      let errors = 0;
      for (let i = 0; i < LONG_BITS * 2; i += 2) {
        const low = m[j + i + PREAMBLE * 2], hi = m[j + i + PREAMBLE * 2 + 1];
        const delta = Math.abs(low - hi);
        let b: number;
        if (i > 0 && delta < 256) b = bits[i / 2 - 1];
        else if (low === hi) { if (i < SHORT_BITS * 2) errors++; b = 2; }
        else b = low > hi ? 1 : 0;
        bits[i / 2] = b;
      }
      for (let k = 0; k < LONG_BITS; k += 8) {
        msg[k / 8] = (bits[k] << 7) | (bits[k + 1] << 6) | (bits[k + 2] << 5) | (bits[k + 3] << 4) | (bits[k + 4] << 3) | (bits[k + 5] << 2) | (bits[k + 6] << 1) | bits[k + 7];
      }
      const df = msg[0] >> 3;
      if (errors > 0 || (df !== 17 && df !== 18)) { j++; continue; }
      this.dbg.df++;
      if (this.checksum(msg, LONG_BITS) !== 0) { this.dbg.fail++; j++; continue; }
      this.dbg.ok++;
      this.frames++;
      this.decode(msg, batch, nowMs);
      j += (LONG_BITS + PREAMBLE) * 2;
    }
    const keep = Math.min(FULL_LEN * 2, mlen);
    this.carry.set(m.subarray(mlen - keep));
    this.carryLen = keep;
    if (batch.size > 0) this.merge(batch, nowMs);
    if (nowMs - this.dbg.last > 1000) {
      this.dbg.last = nowMs;
      this.emit({ type: 'log', line: `ADSB decode: preambles=${this.dbg.pre} df17/18=${this.dbg.df} crcOK=${this.dbg.ok} crcFAIL=${this.dbg.fail} · frames=${this.frames} aircraft=${this.planes.size}` });
      this.dbg.pre = this.dbg.df = this.dbg.ok = this.dbg.fail = 0;
      this.publish(nowMs, true);
    }
  }

  private decode(msg: Int32Array, batch: Map<string, Aircraft>, now: number): void {
    const icao = [msg[1], msg[2], msg[3]].map(b => b.toString(16).padStart(2, '0')).join('');
    const seen = (this.icaoFrames.get(icao) ?? 0) + 1;
    if (this.icaoFrames.size > 4096) this.icaoFrames.clear();
    this.icaoFrames.set(icao, seen);
    if (seen < 2) return;   // a lone CRC-passing noise frame must not create a phantom aircraft
    let a = batch.get(icao);
    if (!a) { a = { icao, seenMs: now, firstMs: now }; batch.set(icao, a); }
    const tc = msg[4] >> 3;
    if (tc >= 1 && tc <= 4) {
      const cs = [msg[5] >> 2, ((msg[5] & 3) << 4) | (msg[6] >> 4), ((msg[6] & 15) << 2) | (msg[7] >> 6), msg[7] & 63,
        msg[8] >> 2, ((msg[8] & 3) << 4) | (msg[9] >> 4), ((msg[9] & 15) << 2) | (msg[10] >> 6), msg[10] & 63]
        .map(c => AIS_CHARS[c]).join('').trim().replace(/\?+$/, '').replace(/\?/g, '');
      if (cs) a.flight = cs;
    } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
      if (msg[5] & 1) { const n = ((msg[5] >> 1) << 4) | ((msg[6] & 0xf0) >> 4); a.alt = n * 25 - 1000; }
      const odd = (msg[6] & 4) !== 0;
      const rawLat = ((msg[6] & 3) << 15) | (msg[7] << 7) | (msg[8] >> 1);
      const rawLon = ((msg[8] & 1) << 16) | (msg[9] << 8) | msg[10];
      const pos = this.cprUpdate(icao, odd, rawLat, rawLon);
      if (pos) { a.lat = pos[0]; a.lon = pos[1]; }
    } else if (tc === 19) {
      const sub = msg[4] & 7;
      if (sub === 1 || sub === 2) {
        const ewDir = (msg[5] & 4) >> 2, ewV = ((msg[5] & 3) << 8) | msg[6];
        const nsDir = (msg[7] & 0x80) >> 7, nsV = ((msg[7] & 0x7f) << 3) | ((msg[8] & 0xe0) >> 5);
        const vrSign = (msg[8] & 8) >> 3, vr = ((msg[8] & 7) << 6) | ((msg[9] & 0xfc) >> 2);
        if (ewV !== 0 && nsV !== 0) {
          const ew = (ewV - 1) * (ewDir ? -1 : 1), ns = (nsV - 1) * (nsDir ? -1 : 1);
          a.gs = Math.round(Math.sqrt(ew * ew + ns * ns));
          let hdg = Math.atan2(ew, ns) * 180 / Math.PI; if (hdg < 0) hdg += 360;
          a.track = Math.floor(hdg);
        }
        if (vr !== 0) a.vr = (vr - 1) * 64 * (vrSign ? -1 : 1);
      }
    }
  }

  private merge(batch: Map<string, Aircraft>, now: number): void {
    for (const [icao, a] of batch) {
      const cur = this.planes.get(icao) ?? { icao, seenMs: now, firstMs: now };
      if (a.flight !== undefined) cur.flight = a.flight;
      if (a.lat !== undefined) cur.lat = a.lat;
      if (a.lon !== undefined) cur.lon = a.lon;
      if (a.alt !== undefined) cur.alt = a.alt;
      if (a.gs !== undefined) cur.gs = a.gs;
      if (a.track !== undefined) cur.track = a.track;
      if (a.vr !== undefined) cur.vr = a.vr;
      cur.seenMs = now;
      this.planes.set(icao, cur);
    }
    this.publish(now, false);
  }

  private publish(now: number, force: boolean): void {
    if (!force && now - this.lastPublish < 500) return;
    this.lastPublish = now;
    for (const [k, v] of this.planes) if (now - v.seenMs > 60_000) this.planes.delete(k);
    const list = [...this.planes.values()].sort((a, b) => a.firstMs - b.firstMs);
    this.emit({ type: 'aircraft', list, frames: this.frames });
  }

  // ---- CPR ----
  private cprUpdate(icao: string, odd: boolean, rawLat: number, rawLon: number): [number, number] | null {
    let st = this.cpr.get(icao);
    if (!st) { st = { evLat: 0, evLon: 0, odLat: 0, odLon: 0, evT: 0, odT: 0, haveEv: false, haveOd: false }; this.cpr.set(icao, st); }
    const now = Date.now();
    if (odd) { st.odLat = rawLat; st.odLon = rawLon; st.odT = now; st.haveOd = true; }
    else { st.evLat = rawLat; st.evLon = rawLon; st.evT = now; st.haveEv = true; }
    if (this.ref) { const p = this.cprLocal(this.ref.lat, this.ref.lon, odd, rawLat, rawLon); if (p) return p; }
    if (!st.haveEv || !st.haveOd) return null;
    if (Math.abs(st.evT - st.odT) > 10_000) return null;
    return this.cprGlobal(st);
  }
  private static modD(a: number, b: number): number { const r = a % b; return r < 0 ? r + b : r; }
  private cprLocal(refLat: number, refLon: number, odd: boolean, rawLat: number, rawLon: number): [number, number] | null {
    const airDlat = odd ? 360 / 59 : 360 / 60;
    const latFrac = rawLat / 131072, lonFrac = rawLon / 131072;
    const j = Math.floor(refLat / airDlat) + Math.floor(0.5 + AdsbDecoder.modD(refLat, airDlat) / airDlat - latFrac);
    let rlat = airDlat * (j + latFrac);
    if (rlat >= 270) rlat -= 360;
    if (rlat < -90 || rlat > 90) return null;
    const airDlon = AdsbDecoder.dlon(rlat, odd ? 1 : 0);
    const m = Math.floor(refLon / airDlon) + Math.floor(0.5 + AdsbDecoder.modD(refLon, airDlon) / airDlon - lonFrac);
    let rlon = airDlon * (m + lonFrac);
    if (rlon > 180) rlon -= 360;
    if (Math.abs(rlon) > 180) return null;
    if (Math.abs(rlat - refLat) > 3 || Math.abs(rlon - refLon) > 5) return null;
    return [rlat, rlon];
  }
  private static modI(a: number, b: number): number { let r = a % b; if (r < 0) r += b; return r; }
  private static nl(latIn: number): number {
    const lat = Math.abs(latIn);
    if (lat < 10.47047130) return 59;
    for (let i = 0; i < NL_BP.length; i++) if (lat < NL_BP[i]) return 58 - i;
    return 1;
  }
  private static n(lat: number, odd: number): number { const nl = AdsbDecoder.nl(lat) - odd; return nl < 1 ? 1 : nl; }
  private static dlon(lat: number, odd: number): number { return 360 / AdsbDecoder.n(lat, odd); }
  private cprGlobal(st: Cpr): [number, number] | null {
    const lat0 = st.evLat, lat1 = st.odLat, lon0 = st.evLon, lon1 = st.odLon;
    const j = Math.floor(((59 * lat0 - 60 * lat1) / 131072) + 0.5);
    let rlat0 = (360 / 60) * (AdsbDecoder.modI(j, 60) + lat0 / 131072);
    let rlat1 = (360 / 59) * (AdsbDecoder.modI(j, 59) + lat1 / 131072);
    if (rlat0 >= 270) rlat0 -= 360;
    if (rlat1 >= 270) rlat1 -= 360;
    if (rlat0 < -90 || rlat0 > 90 || rlat1 < -90 || rlat1 > 90) return null;
    if (AdsbDecoder.nl(rlat0) !== AdsbDecoder.nl(rlat1)) return null;
    let lat: number, lon: number;
    if (st.evT > st.odT) {
      const ni = AdsbDecoder.n(rlat0, 0);
      const m = Math.floor(((lon0 * (AdsbDecoder.nl(rlat0) - 1) - lon1 * AdsbDecoder.nl(rlat0)) / 131072) + 0.5);
      lon = AdsbDecoder.dlon(rlat0, 0) * (AdsbDecoder.modI(m, ni) + lon0 / 131072); lat = rlat0;
    } else {
      const ni = AdsbDecoder.n(rlat1, 1);
      const m = Math.floor(((lon0 * (AdsbDecoder.nl(rlat1) - 1) - lon1 * AdsbDecoder.nl(rlat1)) / 131072) + 0.5);
      lon = AdsbDecoder.dlon(rlat1, 1) * (AdsbDecoder.modI(m, ni) + lon1 / 131072); lat = rlat1;
    }
    if (lon > 180) lon -= 360;
    if (lat < -90 || lat > 90 || Math.abs(lon) > 180) return null;
    return [lat, lon];
  }

  private checksum(msg: Int32Array, bits: number): number {
    let crc = 0;
    const offset = bits === LONG_BITS ? 0 : LONG_BITS - SHORT_BITS;
    for (let jbit = 0; jbit < bits - 24; jbit++) {
      if (msg[jbit >> 3] & (1 << (7 - (jbit & 7)))) crc ^= CRC_TABLE[jbit + offset];
    }
    const rem = (msg[bits / 8 - 3] << 16) | (msg[bits / 8 - 2] << 8) | msg[bits / 8 - 1];
    return (crc ^ rem) & 0xFFFFFF;
  }
}
