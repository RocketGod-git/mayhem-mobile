/**
 * APRS receiver (Mayhem proc_aprsrx; port of core/apps/AprsDecoder.kt): Bell 202 AFSK + AX.25, then the APRS
 * payload — uncompressed, compressed (base-91) and Mic-E positions, course / speed / altitude, status, messages,
 * objects and items, weather reports, third-party (IGate) wrapping. Every station heard keeps a record for the UI.
 */
import { BitSync, DiscFilter, HdlcFramer, type Emit, type IqProcessor } from './core.js';

export interface AprsWx { windDir?: number; windMph?: number; gustMph?: number; tempF?: number; rain1h?: number; rain24h?: number; rainMidnight?: number; humidity?: number; pressureMb?: number }
export interface AprsStation {
  call: string;                                   // station, or the object / item name
  kind: 'station' | 'object' | 'item';
  owner?: string;                                 // who sent the object / item
  lat?: number; lon?: number;
  symbol?: string; table?: string;                // APRS symbol code and table ('/' primary, '\\' alternate, or an overlay)
  course?: number; speed?: number; alt?: number;  // degrees, knots, meters
  comment?: string; status?: string; mice?: string;
  dest?: string; path?: string; via?: string;     // last packet's destination, digipeater path, IGate (third-party) relay
  wx?: AprsWx;
  lastMsg?: { to: string; text: string };
  packets: number; firstMs: number; lastMs: number;
}

const MICE_MSG = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In service', 'En route', 'Off duty'];

export class AprsDecoder implements IqProcessor {
  readonly wantsFm = true;
  private fmRate = 0;
  private spb = 40;
  private ring = new Float32Array(40);
  private ri = 0;
  private ph1 = 0; private ph2 = 0; private w1 = 0; private w2 = 0;
  private c1 = 0; private s1 = 0; private c2 = 0; private s2 = 0;
  private sinceRecompute = 0;
  private sync = new BitSync(1200, 48000);
  private filt = new DiscFilter(3200, 48000);
  private readonly framer = new HdlcFramer(400, f => this.onFrame(f));
  private readonly stations = new Map<string, AprsStation>();

  constructor(private readonly emit: Emit) {}
  reset(): void { this.fmRate = 0; this.framer.reset(); }
  /** CLEAR on the screen: forget every station, and say so, or the next packet re-sends the whole table. */
  clear(): void { this.stations.clear(); this.emit({ type: 'stations', rows: [] }); }
  onIq(): void {}

  private configure(rate: number): void {
    this.fmRate = rate;
    this.spb = Math.max(4, Math.round(rate / 1200));
    this.ring = new Float32Array(this.spb); this.ri = 0;
    this.w1 = 2 * Math.PI * 1200 / rate; this.w2 = 2 * Math.PI * 2200 / rate;
    this.ph1 = this.ph2 = this.c1 = this.s1 = this.c2 = this.s2 = 0; this.sinceRecompute = 0;
    this.sync = new BitSync(1200, rate);
    this.filt = new DiscFilter(3200, rate);
    this.framer.reset();
  }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== this.fmRate) this.configure(rate);
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const x = this.filt.push(samples[i]);
      const old = this.ring[this.ri];
      this.ring[this.ri] = x;
      this.ri = this.ri + 1 >= this.spb ? 0 : this.ri + 1;
      let o1 = this.ph1 - this.w1 * this.spb; while (o1 < 0) o1 += twoPi;
      let o2 = this.ph2 - this.w2 * this.spb; while (o2 < 0) o2 += twoPi;
      this.c1 += x * Math.cos(this.ph1) - old * Math.cos(o1); this.s1 += x * Math.sin(this.ph1) - old * Math.sin(o1);
      this.c2 += x * Math.cos(this.ph2) - old * Math.cos(o2); this.s2 += x * Math.sin(this.ph2) - old * Math.sin(o2);
      this.ph1 += this.w1; if (this.ph1 >= twoPi) this.ph1 -= twoPi;
      this.ph2 += this.w2; if (this.ph2 >= twoPi) this.ph2 -= twoPi;
      if (++this.sinceRecompute >= 4096) { this.sinceRecompute = 0; this.recompute(); }
      const d = (this.c1 * this.c1 + this.s1 * this.s1) - (this.c2 * this.c2 + this.s2 * this.s2);
      const b = this.sync.push(d);
      if (b >= 0) this.framer.pushRaw(b);
    }
  }

  private recompute(): void {
    const twoPi = 2 * Math.PI;
    this.c1 = this.s1 = this.c2 = this.s2 = 0;
    for (let j = 0; j < this.spb; j++) {
      const v = this.ring[(this.ri + j) % this.spb];
      let a1 = this.ph1 - this.w1 * (this.spb - j); while (a1 < 0) a1 += twoPi;
      let a2 = this.ph2 - this.w2 * (this.spb - j); while (a2 < 0) a2 += twoPi;
      this.c1 += v * Math.cos(a1); this.s1 += v * Math.sin(a1); this.c2 += v * Math.cos(a2); this.s2 += v * Math.sin(a2);
    }
  }

  private onFrame(f: Uint8Array): void {
    if (f.length < 18 || !HdlcFramer.fcsOk(f)) return;
    let p = 0;
    const addrs: string[] = [];
    let last = false;
    while (!last && p + 7 <= f.length - 2 && addrs.length < 10) {
      let s = '';
      for (let k = 0; k < 6; k++) { const ch = String.fromCharCode(f[p + k] >> 1); if (ch !== ' ') s += ch; }
      const ssidByte = f[p + 6];
      const ssid = (ssidByte >> 1) & 0x0f;
      if (ssid) s += `-${ssid}`;
      if (addrs.length >= 2 && (ssidByte & 0x80)) s += '*';
      last = (ssidByte & 1) !== 0;
      addrs.push(s);
      p += 7;
    }
    if (addrs.length < 2 || p + 2 > f.length - 2) return;
    p += 2;
    let info = '';
    for (let i = p; i < f.length - 2; i++) info += String.fromCharCode(f[i]);
    const dest = addrs[0], src = addrs[1];
    const path = addrs.length > 2 ? addrs.slice(2).join(',') : '';
    const st = this.digest(src, dest, path, info, undefined);
    const pos = st && st.lat !== undefined ? ` [${st.lat.toFixed(4)},${st.lon!.toFixed(4)}]` : '';
    this.emit({ type: 'packet', line: `${src}>${dest}${path ? ',' + path : ''}:${info}${pos}` });
    const now = Date.now();
    for (const [k, s] of this.stations) if (now - s.lastMs > 60 * 60_000) this.stations.delete(k);
    this.emit({ type: 'stations', rows: [...this.stations.values()].sort((a, b) => b.lastMs - a.lastMs).slice(0, 200).map(s => ({ ...s })) });
  }

  private station(call: string, kind: AprsStation['kind'], now: number): AprsStation {
    let s = this.stations.get(call);
    if (!s) { s = { call, kind, packets: 0, firstMs: now, lastMs: now }; this.stations.set(call, s); }
    s.kind = kind; s.lastMs = now; s.packets++;
    return s;
  }

  /** Apply one packet's payload to the station records. Returns the record it mostly concerned. */
  private digest(src: string, dest: string, path: string, info: string, via: string | undefined): AprsStation | null {
    if (!info) return null;
    const now = Date.now();
    // third-party: the IGate wraps the original packet — read the inner one and remember who relayed it
    if (info[0] === '}') {
      const m = info.slice(1).match(/^([A-Za-z0-9-]+)>([^:]+):([\s\S]*)$/); if (!m) return null;
      const [, isrc, addr, iinfo] = m; const parts = addr.split(',');
      return this.digest(isrc, parts[0], parts.slice(1).join(','), iinfo, src);
    }
    const s = this.station(src, 'station', now);
    s.dest = dest; s.path = path; s.via = via;
    const t = info[0];
    if (t === '!' || t === '=') this.position(s, info.slice(1), now);
    else if (t === '/' || t === '@') this.position(s, info.slice(8), now);           // 7-char timestamp first
    else if (t === '`' || t === "'" || t === '\x1c' || t === '\x1d') this.micE(s, dest, info.slice(1));
    else if (t === '>') s.status = info.slice(1).replace(/^\d{6}[zh/]/, '').trim();
    else if (t === ':') {
      const m = info.match(/^:([^:]{9}):([\s\S]*)$/);
      if (m) { const to = m[1].trim(), text = m[2].replace(/\{[^}]*$/, '').trim(); if (!/^(ack|rej)\d+/.test(text)) s.lastMsg = { to, text }; }
    } else if (t === ';') {
      const m = info.match(/^;(.{9})([*_])(.{7})([\s\S]*)$/);
      if (m) { const o = this.station(m[1].trim(), 'object', now); o.owner = src; o.dest = dest; o.path = path; o.via = via; if (m[2] === '*') this.position(o, m[4], now); else o.comment = 'killed'; return o; }
    } else if (t === ')') {
      const m = info.match(/^\)([^!_]{3,9})([!_])([\s\S]*)$/);
      if (m) { const o = this.station(m[1].trim(), 'item', now); o.owner = src; o.dest = dest; o.path = path; o.via = via; if (m[2] === '!') this.position(o, m[3], now); else o.comment = 'killed'; return o; }
    } else if (t === '_') { s.wx = { ...s.wx, ...parseWx(info.slice(9)) }; }
    else if (t === 'T') { /* telemetry: nothing to show yet */ }
    else if (t === '<' || t === '?' || t === '{') { /* capabilities / query / user-defined */ }
    else s.comment = info.trim();
    return s;
  }

  /** Position body (after the data-type indicator and any timestamp): uncompressed or compressed, then the extras. */
  private position(s: AprsStation, body: string, now: number): void {
    let rest = '';
    if (/^\d{4}\.\d{2}[NS]/.test(body) && body.length >= 19) {
      const lat = body.substring(0, 8), lon = body.substring(9, 18);
      const la = parseInt(lat.substring(0, 2), 10) + parseFloat(lat.substring(2, 7).replace(/ /g, '0')) / 60;
      const lo = parseInt(lon.substring(0, 3), 10) + parseFloat(lon.substring(3, 8).replace(/ /g, '0')) / 60;
      if (Number.isFinite(la) && Number.isFinite(lo)) { s.lat = lat[7] === 'S' ? -la : la; s.lon = lon[8] === 'W' ? -lo : lo; }
      s.table = body[8]; s.symbol = body[18]; rest = body.slice(19);
    } else if (/^[/\\A-Za-j]/.test(body) && body.length >= 13) {
      const b91 = (t: string) => { let v = 0; for (const ch of t) v = v * 91 + (ch.charCodeAt(0) - 33); return v; };
      s.table = body[0]; s.lat = 90 - b91(body.substring(1, 5)) / 380926; s.lon = -180 + b91(body.substring(5, 9)) / 190463; s.symbol = body[9];
      const c = body[10], sp = body[11], ty = body.charCodeAt(12) - 33;
      if (c !== ' ') {
        if ((ty & 0x18) === 0x10) s.alt = Math.pow(1.002, b91(body.substring(10, 12))) * 0.3048;
        else if (c !== '{') { s.course = (c.charCodeAt(0) - 33) * 4; s.speed = Math.pow(1.08, sp.charCodeAt(0) - 33) - 1; }
      }
      rest = body.slice(13);
    } else { s.comment = body.trim(); return; }
    if (s.symbol === '_') { s.wx = { ...s.wx, ...parseWx(rest) }; s.comment = rest.replace(/^(\d{3}\/\d{3})?[cSgtrpPhbLls#\d.-]*/, '').trim() || s.comment; return; }
    const cs = rest.match(/^(\d{3})\/(\d{3})/);
    if (cs) { s.course = Number(cs[1]) === 0 && Number(cs[2]) === 0 ? undefined : Number(cs[1]) % 360; s.speed = Number(cs[2]); rest = rest.slice(7); }
    const alt = rest.match(/\/A=(-?\d{6})/); if (alt) { s.alt = Number(alt[1]) * 0.3048; rest = rest.replace(alt[0], ''); }
    rest = rest.replace(/^PHG\d{4}/, '').replace(/^RNG\d{4}/, '').replace(/!w..!/, '').trim();
    if (rest) s.comment = rest;
    void now;
  }

  /** Mic-E: latitude, message and offsets ride in the destination address, the rest in the first bytes of the payload. */
  private micE(s: AprsStation, dest: string, body: string): void {
    const d = dest.split('-')[0]; if (d.length < 6 || body.length < 8) return;
    let lat = '', bits = 0, north = false, off100 = false, west = false;
    for (let i = 0; i < 6; i++) {
      const c = d[i]; let digit = ' ', bit = 0, flag = false;
      if (c >= '0' && c <= '9') { digit = c; } else if (c >= 'A' && c <= 'J') { digit = String(c.charCodeAt(0) - 65); bit = 1; }
      else if (c === 'K') { bit = 1; } else if (c === 'L') { } else if (c >= 'P' && c <= 'Y') { digit = String(c.charCodeAt(0) - 80); bit = 1; flag = true; } else if (c === 'Z') { bit = 1; flag = true; }
      else return;
      lat += digit; if (i < 3) bits = bits * 2 + bit; if (i === 3) north = flag; if (i === 4) off100 = flag; if (i === 5) west = flag;
    }
    lat = lat.replace(/ /g, '0');
    const la = parseInt(lat.substring(0, 2), 10) + parseFloat(lat.substring(2, 4) + '.' + lat.substring(4, 6)) / 60;
    let lonDeg = body.charCodeAt(0) - 28; if (off100) lonDeg += 100; if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80; else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
    let lonMin = body.charCodeAt(1) - 28; if (lonMin >= 60) lonMin -= 60;
    const lonHun = body.charCodeAt(2) - 28;
    const lo = lonDeg + (lonMin + lonHun / 100) / 60;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la > 90 || lo > 180) return;
    s.lat = north ? la : -la; s.lon = west ? -lo : lo;
    let sp = (body.charCodeAt(3) - 28) * 10; const dc = body.charCodeAt(4) - 28; sp += Math.floor(dc / 10); let crs = (dc % 10) * 100 + (body.charCodeAt(5) - 28);
    if (sp >= 800) sp -= 800; if (crs >= 400) crs -= 400;
    s.speed = sp; s.course = crs === 0 && sp === 0 ? undefined : crs % 360;
    s.symbol = body[6]; s.table = body[7];
    s.mice = MICE_MSG[bits];
    let rest = body.slice(8);
    if (rest[0] === '`' || rest[0] === "'") rest = rest.slice(rest[0] === '`' ? 5 : 3);   // Kenwood telemetry bytes
    const alt = rest.match(/^(.{3})\}/); if (alt) { let v = 0; for (const ch of alt[1]) v = v * 91 + (ch.charCodeAt(0) - 33); s.alt = v - 10000; rest = rest.slice(4); }
    rest = rest.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\]>_\^]$/, '').trim();
    if (rest) s.comment = rest;
  }
}

/** Weather fields: letter key + fixed-width value (c wind dir, s speed mph, g gust, t °F, r/p/P rain 1/100", h humidity, b pressure 1/10 mb). */
function parseWx(t: string): AprsWx {
  const w: AprsWx = {};
  const cs = t.match(/^(\d{3})\/(\d{3})/); if (cs) { w.windDir = Number(cs[1]); w.windMph = Number(cs[2]); t = t.slice(7); }
  const num = (key: string, len: number): number | undefined => { const m = t.match(new RegExp(key + '(-?[\\d .]{' + len + '})')); if (!m || /\.{2}/.test(m[1])) return undefined; const v = Number(m[1].trim()); return Number.isFinite(v) ? v : undefined; };
  const c = num('c', 3); if (c !== undefined) w.windDir = c;
  const s = num('s', 3); if (s !== undefined) w.windMph = s;
  w.gustMph = num('g', 3); w.tempF = num('t', 3); w.rain1h = num('r', 3); w.rain24h = num('p', 3); w.rainMidnight = num('P', 3);
  const h = num('h', 2); if (h !== undefined) w.humidity = h === 0 ? 100 : h;
  const b = num('b', 5); if (b !== undefined) w.pressureMb = b / 10;
  for (const k of Object.keys(w) as (keyof AprsWx)[]) if (w[k] === undefined) delete w[k];
  return w;
}
