/**
 * Positions carried as text inside digital voice signals: NMEA 0183 sentences (RMC, GGA, GLL, any talker) and APRS
 * position reports (uncompressed, with or without a timestamp), as D-STAR's D-PRS, DMR packet data and Fusion data
 * channels carry them. No DOM.
 */

export interface Position { lat: number; lon: number; source: string; alt?: number }

/** "3404.50" with hemisphere "N" → 34.075; [degDigits] is 2 for latitude, 3 for longitude. */
function dm(v: string, hemi: string, degDigits: number): number {
  if (!(degDigits === 2 ? /^\d{4}(\.\d+)?$/ : /^\d{5}(\.\d+)?$/).test(v)) return NaN;
  const deg = parseInt(v.slice(0, degDigits), 10), min = parseFloat(v.slice(degDigits));
  if (!(min >= 0 && min < 60)) return NaN;
  const x = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -x : hemi === 'N' || hemi === 'E' ? x : NaN;
}
const inRange = (p: Position | null) => p !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0) ? p : null;

/** True when the sentence's checksum (the XOR between '$' and '*') is right; a sentence without one fails. */
export function nmeaChecksumOk(s: string): boolean {
  const star = s.lastIndexOf('*');
  if (s[0] !== '$' || star < 0 || star + 3 > s.length) return false;
  let x = 0; for (let i = 1; i < star; i++) x ^= s.charCodeAt(i);
  const hh = s.slice(star + 1, star + 3);
  return /^[0-9A-Fa-f]{2}$/.test(hh) && parseInt(hh, 16) === x;
}

/** One NMEA sentence ("$GPRMC,...*hh"); its checksum must check. */
export function parseNmea(line: string): Position | null {
  const s = line.trim();
  if (!nmeaChecksumOk(s)) return null;
  const f = s.slice(1, s.lastIndexOf('*')).split(',');
  const type = f[0].slice(2);
  let p: Position | null = null;
  if (type === 'RMC' && f.length >= 7 && f[2] === 'A') p = { lat: dm(f[3], f[4], 2), lon: dm(f[5], f[6], 3), source: 'nmea' };
  else if (type === 'GGA' && f.length >= 10 && f[6] !== '0' && f[6] !== '') {
    p = { lat: dm(f[2], f[3], 2), lon: dm(f[4], f[5], 3), source: 'nmea' };
    const alt = parseFloat(f[9]); if (Number.isFinite(alt)) p.alt = alt;
  } else if (type === 'GLL' && f.length >= 5 && (f.length < 7 || f[6] === 'A')) p = { lat: dm(f[1], f[2], 2), lon: dm(f[3], f[4], 3), source: 'nmea' };
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
  return inRange(p);
}

/**
 * An APRS packet or just its information field: "CALL>APxxxx,DSTAR*:!3404.50N/11815.25W>comment", or with a
 * timestamp ("/092345z" or "@092345z" then the position). Position ambiguity spaces read as zeros.
 */
export function parseAprs(text: string): Position | null {
  const colon = text.indexOf(':');
  const info = colon >= 0 && text.indexOf('>') >= 0 && text.indexOf('>') < colon ? text.slice(colon + 1) : text;
  const t = info[0];
  let body: string;
  if (t === '!' || t === '=') body = info.slice(1);
  else if (t === '/' || t === '@') body = info.slice(8);
  else return null;
  const m = /^(\d{2})([\d ]{2}\.[\d ]{2})([NS])(.)(\d{3})([\d ]{2}\.[\d ]{2})([EW])/.exec(body);
  if (!m) return null;
  const lat = dm(m[1] + m[2].replace(/ /g, '0'), m[3], 2), lon = dm(m[5] + m[6].replace(/ /g, '0'), m[7], 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p: Position = { lat, lon, source: 'aprs' };
  const a = /\/A=(-?\d{5,6})/.exec(body); if (a) p.alt = parseInt(a[1], 10) * 0.3048;
  return inRange(p);
}

/** Any position in one line of text: NMEA first, then APRS. */
export function parsePositionLine(line: string): Position | null {
  const s = line.trim();
  if (s.startsWith('$$CRC')) { const c = s.indexOf(','); return c > 0 ? parseAprs(s.slice(c + 1)) : null; }
  if (s.startsWith('$')) return parseNmea(s);
  return parseAprs(s);
}

/** Text arriving a few bytes at a time: complete lines come out on CR or LF. */
export class LineBuffer {
  private buf = '';
  /** Adds text; returns the lines it completed. */
  push(text: string): string[] {
    const out: string[] = [];
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') { if (this.buf.length) out.push(this.buf); this.buf = ''; }
      else if (this.buf.length < 256) this.buf += ch;
    }
    return out;
  }
  /** What has come in since the last line break. */
  get pending(): string { return this.buf; }
  reset(): void { this.buf = ''; }
}
