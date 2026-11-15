/**
 * UAT aircraft downlinks (DO-282B): what one basic (18-byte) or long (34-byte) ADS-B frame says.
 *
 * Byte 0: payload type (5 bits) and address qualifier (3 bits); bytes 1-3: the 24-bit address. State vector (bytes
 * 4-16): latitude (23 bits) and longitude (24 bits) in units of 360/2^24 degrees, altitude type and 12-bit altitude
 * (25 ft steps from -1000 ft), NIC, air/ground state, north/south and east/west velocity (11 bits each: a sign and
 * knots + 1), vertical rate (a source bit, a sign and 64 ft/min steps + 1). Long frames of payload type 1 and 3 add a
 * mode status block: the emitter category and an 8-character call sign in base 40.
 */
export interface UatTarget {
  address: string;
  /** 0 ADS-B, 1 ADS-B self-assigned address, 2 TIS-B (ICAO), 3 TIS-B (track file), 4 surface vehicle, 5 fixed beacon, 6 ADS-R. */
  qualifier: number;
  payloadType: number;
  lat?: number; lon?: number;
  altFt?: number; altGeo?: boolean;
  onGround?: boolean;
  speedKt?: number; trackDeg?: number;
  vertFpm?: number;
  callsign?: string;
  emitter?: number;
}

const B40 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ  ..';

export function decodeDownlink(b: Uint8Array): UatTarget {
  const t: UatTarget = {
    payloadType: b[0] >> 3,
    qualifier: b[0] & 7,
    address: ((b[1] << 16) | (b[2] << 8) | b[3]).toString(16).toUpperCase().padStart(6, '0'),
  };
  const rawLat = (b[4] << 15) | (b[5] << 7) | (b[6] >> 1);
  const rawLon = ((b[6] & 1) << 23) | (b[7] << 15) | (b[8] << 7) | (b[9] >> 1);
  const rawAlt = (b[10] << 4) | (b[11] >> 4);
  const nic = b[11] & 0x0f;
  if (nic > 0 || rawLat || rawLon) {
    let lat = rawLat * 360 / 2 ** 24; if (lat > 90) lat -= 180;
    let lon = rawLon * 360 / 2 ** 24; if (lon > 180) lon -= 360;
    if (rawLat || rawLon) { t.lat = lat; t.lon = lon; }
  }
  if (rawAlt) { t.altFt = (rawAlt - 1) * 25 - 1000; t.altGeo = (b[9] & 1) === 1; }
  const ag = b[12] >> 6;
  t.onGround = ag === 2;
  if (ag === 0 || ag === 1) {
    const ns = ((b[12] & 0x1f) << 6) | (b[13] >> 2);
    const ew = ((b[13] & 0x03) << 9) | (b[14] << 1) | (b[15] >> 7);
    const nsMag = ns & 0x3ff, ewMag = ew & 0x3ff;
    if (nsMag && ewMag) {
      const scale = ag === 1 ? 4 : 1;            // supersonic: 4-knot steps
      const vn = (nsMag - 1) * scale * (ns & 0x400 ? -1 : 1);
      const ve = (ewMag - 1) * scale * (ew & 0x400 ? -1 : 1);
      t.speedKt = Math.round(Math.hypot(vn, ve));
      t.trackDeg = Math.round((Math.atan2(ve, vn) * 180 / Math.PI + 360) % 360);
    }
    const vv = ((b[15] & 0x7f) << 4) | (b[16] >> 4);
    const vMag = vv & 0x1ff;
    if (vMag) t.vertFpm = (vMag - 1) * 64 * (vv & 0x200 ? -1 : 1);
  }
  if (b.length >= 34 && (t.payloadType === 1 || t.payloadType === 3)) {
    const w1 = (b[17] << 8) | b[18], w2 = (b[19] << 8) | b[20], w3 = (b[21] << 8) | b[22];
    t.emitter = Math.floor(w1 / 1600) % 40;
    const cs = [Math.floor(w1 / 40) % 40, w1 % 40, Math.floor(w2 / 1600) % 40, Math.floor(w2 / 40) % 40, w2 % 40,
      Math.floor(w3 / 1600) % 40, Math.floor(w3 / 40) % 40, w3 % 40].map(c => B40[c]).join('').trim();
    if (cs) t.callsign = cs;
  }
  return t;
}
