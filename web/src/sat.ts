/**
 * Satellite tracking for the HAM app: SGP4 (near-earth, Spacetrack Report #3 / Vallado) from two-line elements,
 * observer look angles (azimuth, elevation, range, range rate) from the phone's GPS position, pass prediction and
 * Doppler-corrected receive frequencies. TLEs come from CelesTrak and are cached for a day.
 */

export type SatKind = 'fm' | 'linear' | 'packet' | 'sstv' | 'apt' | 'lrpt' | 'digi' | 'cw';
export interface SatService {
  name: string; kind: SatKind; down: number; up?: number; tone?: number;
  /** The technical detail: bandwidths, sub-bands, tones. */
  note?: string;
  /** What to actually do on this service, in plain words. */
  how?: string;
}
export interface SatDef {
  name: string; norad: number;
  /** What this thing is and why you would point at it. */
  what?: string;
  services: SatService[];
}

/** The thing people most often mistake for a fault, so it is said the same way wherever it applies. */
const QUIET = 'A transponder relays whatever it hears, so it is silent unless another operator is working through it. '
  + 'It is not broken and you are not mistuned: there is simply nothing to relay. ';

/** Curated amateur / weather birds a HackRF hears with a whip, with what each one offers and how to use it. */
export const SATS: SatDef[] = [
  { name: 'ISS', norad: 25544,
    what: 'The International Space Station, 400 km up and by far the loudest thing in amateur space. A handheld antenna is plenty. Passes last ten minutes at best, and what it is doing depends on the crew: the packet digipeater runs most of the time, the voice repeater and the picture transmissions come and go.',
    services: [
      { name: 'APRS digipeater', kind: 'packet', down: 145_825_000, up: 145_825_000, note: 'AX.25 1200 bd · path ARISS',
        how: 'Uplink and downlink are the same channel, so your packet goes up and comes straight back down and you hear yourself repeated. Everyone in the footprint hears it too, which can be a third of a continent.' },
      { name: 'FM repeater', kind: 'fm', down: 437_800_000, up: 145_990_000, tone: 67.0, note: 'cross-band voice repeater',
        how: 'Talk on 2 m, listen on 70 cm, so you can hear yourself and know you are getting in. It is switched off more often than on. Needs a license to transmit.' },
      { name: 'SSTV', kind: 'sstv', down: 437_550_000, note: 'Robot 36 during ARISS events · the older Russian mode was PD120 on 145.800',
        how: 'Nothing to transmit. The recurring ARISS series moved to 70 cm and Robot 36, two minutes on and two minutes off, during events announced a few days ahead. The old 145.800 PD120 mode still appears occasionally.' },
      { name: 'Crew voice', kind: 'fm', down: 145_800_000, up: 144_490_000, note: 'Region 2 uplink 144.490 · Region 1/3 145.200',
        how: 'The astronauts’ own channel. Almost always silent, and busy only during scheduled school contacts. Listen; do not call.' },
    ] },
  { name: 'SO-50', norad: 27607,
    what: 'SaudiSat 1C, launched in 2002 and still the easiest satellite to work with nothing but a handheld and a small beam. Because it is easy, everyone piles onto its single channel and a pass is a scramble.',
    services: [{ name: 'FM repeater', kind: 'fm', down: 436_795_000, up: 145_850_000, tone: 67.0, note: '74.4 Hz for 2 s arms the 10-minute timer, then 67.0',
      how: 'Send a 74.4 Hz tone for two seconds to arm its ten-minute timer, then talk with 67.0 Hz. One conversation at a time, so listen before calling.' }] },
  { name: 'AO-91', norad: 43017,
    what: 'RadFxSat, a Fox-1 cubesat carrying a radiation-effects experiment for Vanderbilt University. Its battery is worn out, so the repeater only runs while the satellite is in sunlight.',
    services: [{ name: 'FM repeater', kind: 'fm', down: 145_960_000, up: 435_250_000, tone: 67.0, note: 'sunlit passes only',
      how: 'Talk on 70 cm with a 67 Hz tone, listen on 2 m. Expect silence on eclipsed passes; check the pass list for one in daylight.' }] },
  { name: 'PO-101', norad: 43678,
    what: 'Diwata-2, a Philippine earth-observation satellite that carries an amateur voice repeater as a secondary payload. The repeater is switched on to a published schedule rather than left running.',
    services: [{ name: 'FM repeater', kind: 'fm', down: 145_900_000, up: 437_500_000, tone: 141.3, note: 'Diwata-2 · scheduled',
      how: 'Only alive during announced windows, usually posted a few days ahead. Uses an unusual 141.3 Hz tone.' }] },
  { name: 'TEVEL-2', norad: 63217,
    what: 'One of a fleet of identical Israeli school cubesats, built by teams of teenagers and all sharing a single frequency pair. Several can be above the horizon at the same time.',
    services: [{ name: 'FM repeater', kind: 'fm', down: 436_400_000, up: 145_970_000, note: 'nine-satellite fleet on one pair · no tone · this tracks TEVEL2-1',
      how: 'No tone needed. If two of the fleet are in view at once you will hear both repeating you, which sounds like an echo.' }] },
  { name: 'RS-44', norad: 44909,
    what: 'A Russian navigation satellite carrying an amateur linear transponder, in an orbit twice as high as the cubesats. Passes last half an hour rather than ten minutes, and it reaches much further.',
    services: [
      { name: 'Linear transponder', kind: 'linear', down: 435_640_000, up: 145_965_000, note: 'USB down 435.610–435.670 · LSB up',
        how: 'It relays a slice of spectrum rather than one channel, so use single sideband and pick a quiet spot inside it. ' + QUIET + 'Listen to the beacon first to prove you can hear the satellite at all.' },
      { name: 'CW beacon', kind: 'cw', down: 435_605_000, note: 'always transmitting while the satellite is on',
        how: 'This is the one thing that is always there. If you can hear the beacon you are receiving the satellite, whatever the transponder is doing.' },
    ] },
  { name: 'AO-7', norad: 7530,
    what: 'Launched in 1974 and given up for dead in 1981 when its batteries failed. In 2002 one of them went open circuit instead of short, and it came back to life running straight from its solar panels. It is the oldest working amateur satellite by decades.',
    services: [{ name: 'Mode B transponder', kind: 'linear', down: 145_950_000, up: 432_150_000, note: '145.925–145.975 · sunlit only',
      how: 'Works only in sunlight, and flips between its modes on its own roughly every day, so check the beacon first. Keep your power low: too much and it captures the whole transponder.' }] },
  { name: 'FO-29', norad: 24278,
    what: 'JAS-2, a Japanese amateur satellite from 1996 whose transponder still works whenever the satellite is in sunlight.',
    services: [{ name: 'Linear transponder', kind: 'linear', down: 435_850_000, up: 145_950_000, note: '435.800–435.900',
      how: 'Inverting, so as you move up the passband your downlink moves down, and the Doppler on the two links pulls in opposite directions. Single sideband.' }] },
  { name: 'AO-73', norad: 39444,
    what: 'FUNcube-1, built to put a live telemetry beacon in front of school science classes. It runs telemetry in daylight and hands the transponder to amateurs at night.',
    services: [
      { name: 'Linear transponder', kind: 'linear', down: 145_960_000, up: 435_140_000, note: '145.950–145.970 · night passes only',
        how: 'It runs the transponder in eclipse and telemetry in sunlight, so check the beacon to see which mode it is in. ' + QUIET },
      { name: 'Telemetry beacon', kind: 'cw', down: 145_935_000, note: '1200 bd differential BPSK · tuned but not decoded here',
        how: 'Always on, and much stronger than the transponder in daylight. It is data rather than Morse, so it sounds like a warble; hearing it at all proves the pass. The app does not decode it yet.' },
    ] },
  { name: 'JO-97', norad: 43803,
    what: 'JY1SAT, a Jordanian cubesat named after the callsign of the late King Hussein. Carries a linear transponder and sends slow-scan images of its own.',
    services: [{ name: 'Linear transponder', kind: 'linear', down: 145_865_000, up: 435_110_000, note: '145.855–145.875',
      how: 'Single sideband through a narrow passband. Listen across the whole slice; there is often only one contact in progress.' }] },
  { name: 'XW-3', norad: 50466,
    what: 'CAS-9, a Chinese amateur satellite in a high sun-synchronous orbit, so passes are long and predictable and come at about the same time each day.',
    services: [
      { name: 'Linear transponder', kind: 'linear', down: 435_195_000, up: 145_870_000, note: 'CAS-9 · 435.180–435.210 down',
        how: 'Single sideband, across a thirty kilohertz slice. ' + QUIET },
      { name: 'CW beacon', kind: 'cw', down: 435_575_000, note: 'well away from the passband, always on',
        how: 'The quickest way to confirm you are hearing this satellite. It sits clear of the transponder, so nothing else can mask it.' },
    ] },
  { name: 'IO-117', norad: 53109,
    what: 'GreenCube, an Italian satellite six times higher than the usual cubesat. It is above the horizon for hours rather than minutes and its footprint spans continents, so it is used to pass short messages between countries.',
    services: [{ name: 'GreenCube digipeater', kind: 'digi', down: 435_310_000, up: 435_310_000, note: 'MEO · 1200 bd GMSK · not decoded here yet',
      how: 'A store-and-forward message digipeater rather than a voice repeater. This app tunes it and shows the signal, but does not decode it yet.' }] },
  { name: 'NOAA 15', norad: 25338,
    what: 'An American weather satellite that broadcast a live picture, one line at a time, in a format from the 1960s simple enough to decode with a tape recorder. Switched off in 2025 after 27 years.',
    services: [{ name: 'APT images', kind: 'apt', down: 137_620_000, note: 'retired 2025 · no TLE, tuning still works',
      how: 'No longer transmitting. Kept here so you can check the frequency and confirm the silence.' }] },
  { name: 'NOAA 18', norad: 28654,
    what: 'The middle of the three American analog weather satellites, retired in June 2025. Its picture was a live scan of whatever it was flying over, visible light by day and infrared by night.',
    services: [{ name: 'APT images', kind: 'apt', down: 137_912_500, note: 'retired June 2025 · no TLE, tuning still works',
      how: 'No longer transmitting.' }] },
  { name: 'NOAA 19', norad: 33591,
    what: 'The last of the American analog weather satellites, retired in 2025. Between them these three gave anyone with a scanner a live picture of their own weather for half a century.',
    services: [{ name: 'APT images', kind: 'apt', down: 137_100_000, note: 'retired 2025 · no TLE, tuning still works',
      how: 'No longer transmitting.' }] },
  { name: 'METEOR M2-3', norad: 57166,
    what: 'A Russian weather satellite that replaced the old analog picture with a digital one: sharper, in color, and error corrected. This is the one to point at now that the American analog birds are gone.',
    services: [{ name: 'LRPT images', kind: 'lrpt', down: 137_900_000, note: '72 kbaud QPSK · decoded to a color picture',
      how: 'Receive only. Start it as the satellite rises and leave it: the app demodulates, corrects the errors and builds the picture line by line across the pass. A turnstile or a simple V antenna makes a real difference.' }] },
  { name: 'METEOR M2-4', norad: 59051,
    what: 'The newest of the Russian digital weather satellites, launched in 2024. Same picture format as M2-3 on a different channel, so on a good day you can catch both.',
    services: [{ name: 'LRPT images', kind: 'lrpt', down: 137_100_000, note: '72 kbaud QPSK · decoded to a color picture',
      how: 'Receive only, exactly like M2-3. Check the pass list: the two often rise within an hour of each other.' }] },
];

export interface Tle { name: string; line1: string; line2: string; }
export interface Look { az: number; el: number; rangeKm: number; rangeRate: number; lat: number; lon: number; altKm: number; }
export interface Pass { aos: number; los: number; maxEl: number; aosAz: number; losAz: number; }

// ---------------------------------------------------------------------------------------------- SGP4
const XKE = 0.0743669161, XKMPER = 6378.135, CK2 = 5.413080e-4, CK4 = 0.62098875e-6, E6A = 1e-6, QOMS2T = 1.88027916e-9, S = 1.01222928, AE = 1, XJ3 = -0.253881e-5;
const TWO_PI = 2 * Math.PI, DE2RA = Math.PI / 180, MINS_PER_DAY = 1440;

export class Sgp4 {
  private readonly epoch: number;   // JD
  private readonly xno: number; private readonly eo: number; private readonly xincl: number; private readonly xnodeo: number; private readonly omegao: number; private readonly xmo: number; private readonly bstar: number;
  private aodp = 0; private xnodp = 0; private cosio = 0; private sinio = 0; private eta = 0; private c1 = 0; private c4 = 0; private c5 = 0; private xmdot = 0; private omgdot = 0; private xnodot = 0; private omgcof = 0; private xmcof = 0; private xnodcf = 0; private t2cof = 0; private xlcof = 0; private aycof = 0; private delmo = 0; private sinmo = 0; private x7thm1 = 0; private d2 = 0; private d3 = 0; private d4 = 0; private t3cof = 0; private t4cof = 0; private t5cof = 0; private isimp = false; private x1mth2 = 0; private x3thm1 = 0;
  constructor(tle: Tle) {
    const l1 = tle.line1, l2 = tle.line2;
    const yy = Number(l1.substring(18, 20)), days = Number(l1.substring(20, 32));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    this.epoch = julian(year, 1, 1) - 1 + days;
    const bexp = Number(l1.substring(59, 61)); const bmant = Number((l1.substring(53, 54) + '0.' + l1.substring(54, 59)).replace('+', ''));
    this.bstar = bmant * Math.pow(10, bexp);
    this.xincl = Number(l2.substring(8, 16)) * DE2RA;
    this.xnodeo = Number(l2.substring(17, 25)) * DE2RA;
    this.eo = Number('0.' + l2.substring(26, 33));
    this.omegao = Number(l2.substring(34, 42)) * DE2RA;
    this.xmo = Number(l2.substring(43, 51)) * DE2RA;
    this.xno = Number(l2.substring(52, 63)) * TWO_PI / MINS_PER_DAY;
    this.init();
  }
  private init(): void {
    const a1 = Math.pow(XKE / this.xno, 2 / 3);
    this.cosio = Math.cos(this.xincl); const theta2 = this.cosio * this.cosio;
    this.x3thm1 = 3 * theta2 - 1;
    const eosq = this.eo * this.eo, betao2 = 1 - eosq, betao = Math.sqrt(betao2);
    const del1 = 1.5 * CK2 * this.x3thm1 / (a1 * a1 * betao * betao2);
    const ao = a1 * (1 - del1 * (0.5 * 2 / 3 + del1 * (1 + 134 / 81 * del1)));
    const delo = 1.5 * CK2 * this.x3thm1 / (ao * ao * betao * betao2);
    this.xnodp = this.xno / (1 + delo); this.aodp = ao / (1 - delo);
    this.isimp = this.aodp * (1 - this.eo) / AE < 220 / XKMPER + AE;
    let s4 = S, qoms24 = QOMS2T; const perige = (this.aodp * (1 - this.eo) - AE) * XKMPER;
    if (perige < 156) { s4 = perige - 78; if (perige <= 98) s4 = 20; qoms24 = Math.pow((120 - s4) * AE / XKMPER, 4); s4 = s4 / XKMPER + AE; }
    const pinvsq = 1 / (this.aodp * this.aodp * betao2 * betao2), tsi = 1 / (this.aodp - s4);
    this.eta = this.aodp * this.eo * tsi; const etasq = this.eta * this.eta, eeta = this.eo * this.eta;
    const psisq = Math.abs(1 - etasq), coef = qoms24 * Math.pow(tsi, 4), coef1 = coef / Math.pow(psisq, 3.5);
    const c2 = coef1 * this.xnodp * (this.aodp * (1 + 1.5 * etasq + eeta * (4 + etasq)) + 0.75 * CK2 * tsi / psisq * this.x3thm1 * (8 + 3 * etasq * (8 + etasq)));
    this.c1 = this.bstar * c2;
    this.sinio = Math.sin(this.xincl); const a3ovk2 = -XJ3 / CK2 * Math.pow(AE, 3);
    const c3 = coef * tsi * a3ovk2 * this.xnodp * AE * this.sinio / this.eo;
    this.x1mth2 = 1 - theta2;
    this.c4 = 2 * this.xnodp * coef1 * this.aodp * betao2 * (this.eta * (2 + 0.5 * etasq) + this.eo * (0.5 + 2 * etasq) - 2 * CK2 * tsi / (this.aodp * psisq) * (-3 * this.x3thm1 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) + 0.75 * this.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * this.omegao)));
    this.c5 = 2 * coef1 * this.aodp * betao2 * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
    const theta4 = theta2 * theta2, temp1 = 3 * CK2 * pinvsq * this.xnodp, temp2 = temp1 * CK2 * pinvsq, temp3 = 1.25 * CK4 * pinvsq * pinvsq * this.xnodp;
    this.xmdot = this.xnodp + 0.5 * temp1 * betao * this.x3thm1 + 0.0625 * temp2 * betao * (13 - 78 * theta2 + 137 * theta4);
    const x1m5th = 1 - 5 * theta2;
    this.omgdot = -0.5 * temp1 * x1m5th + 0.0625 * temp2 * (7 - 114 * theta2 + 395 * theta4) + temp3 * (3 - 36 * theta2 + 49 * theta4);
    const xhdot1 = -temp1 * this.cosio;
    this.xnodot = xhdot1 + (0.5 * temp2 * (4 - 19 * theta2) + 2 * temp3 * (3 - 7 * theta2)) * this.cosio;
    this.omgcof = this.bstar * c3 * Math.cos(this.omegao);
    this.xmcof = -2 / 3 * coef * this.bstar * AE / eeta;
    this.xnodcf = 3.5 * betao2 * xhdot1 * this.c1;
    this.t2cof = 1.5 * this.c1;
    this.xlcof = 0.125 * a3ovk2 * this.sinio * (3 + 5 * this.cosio) / (1 + this.cosio);
    this.aycof = 0.25 * a3ovk2 * this.sinio;
    this.delmo = Math.pow(1 + this.eta * Math.cos(this.xmo), 3);
    this.sinmo = Math.sin(this.xmo);
    this.x7thm1 = 7 * theta2 - 1;
    if (!this.isimp) {
      const c1sq = this.c1 * this.c1; this.d2 = 4 * this.aodp * tsi * c1sq; const temp = this.d2 * tsi * this.c1 / 3;
      this.d3 = (17 * this.aodp + s4) * temp; this.d4 = 0.5 * temp * this.aodp * tsi * (221 * this.aodp + 31 * s4) * this.c1;
      this.t3cof = this.d2 + 2 * c1sq; this.t4cof = 0.25 * (3 * this.d3 + this.c1 * (12 * this.d2 + 10 * c1sq));
      this.t5cof = 0.2 * (3 * this.d4 + 12 * this.c1 * this.d3 + 6 * this.d2 * this.d2 + 15 * c1sq * (2 * this.d2 + c1sq));
    }
  }
  /** ECI position (km) and velocity (km/s) at a JS time (ms). */
  propagate(ms: number): { r: [number, number, number]; v: [number, number, number] } {
    const tsince = (ms / 86400000 + 2440587.5 - this.epoch) * MINS_PER_DAY;
    const xmdf = this.xmo + this.xmdot * tsince, omgadf = this.omegao + this.omgdot * tsince, xnoddf = this.xnodeo + this.xnodot * tsince;
    let omega = omgadf, xmp = xmdf; const tsq = tsince * tsince, xnode = xnoddf + this.xnodcf * tsq;
    let tempa = 1 - this.c1 * tsince, tempe = this.bstar * this.c4 * tsince, templ = this.t2cof * tsq;
    if (!this.isimp) {
      const delomg = this.omgcof * tsince, delm = this.xmcof * (Math.pow(1 + this.eta * Math.cos(xmdf), 3) - this.delmo), temp = delomg + delm;
      xmp = xmdf + temp; omega = omgadf - temp;
      const tcube = tsq * tsince, tfour = tsince * tcube;
      tempa = tempa - this.d2 * tsq - this.d3 * tcube - this.d4 * tfour;
      tempe = tempe + this.bstar * this.c5 * (Math.sin(xmp) - this.sinmo);
      templ = templ + this.t3cof * tcube + tfour * (this.t4cof + tsince * this.t5cof);
    }
    const a = this.aodp * tempa * tempa, e = this.eo - tempe, xl = xmp + omega + xnode + this.xnodp * templ;
    const beta = Math.sqrt(1 - e * e), xn = XKE / Math.pow(a, 1.5);
    const axn = e * Math.cos(omega), temp = 1 / (a * beta * beta), xll = temp * this.xlcof * axn, aynl = temp * this.aycof, xlt = xl + xll, ayn = e * Math.sin(omega) + aynl;
    const capu = fmod2p(xlt - xnode); let temp2 = capu, sinepw = 0, cosepw = 0, temp3 = 0, temp4 = 0, temp5 = 0, temp6 = 0;
    for (let i = 0; i < 10; i++) {
      sinepw = Math.sin(temp2); cosepw = Math.cos(temp2);
      temp3 = axn * sinepw; temp4 = ayn * cosepw; temp5 = axn * cosepw; temp6 = ayn * sinepw;
      const epw = (capu - temp4 + temp3 - temp2) / (1 - temp5 - temp6) + temp2;
      if (Math.abs(epw - temp2) <= E6A) break; temp2 = epw;
    }
    const ecose = temp5 + temp6, esine = temp3 - temp4, elsq = axn * axn + ayn * ayn, temp7 = 1 - elsq, pl = a * temp7, r = a * (1 - ecose), temp8 = 1 / r, rdot = XKE * Math.sqrt(a) * esine * temp8, rfdot = XKE * Math.sqrt(pl) * temp8;
    const temp9 = a * temp8, betal = Math.sqrt(temp7), temp10 = esine / (1 + betal), cosu = temp9 * (cosepw - axn + ayn * temp10), sinu = temp9 * (sinepw - ayn - axn * temp10);
    const u = Math.atan2(sinu, cosu), sin2u = 2 * sinu * cosu, cos2u = 2 * cosu * cosu - 1, t1 = CK2 / pl, t2 = t1 / pl;
    const rk = r * (1 - 1.5 * t2 * betal * this.x3thm1) + 0.5 * t1 * this.x1mth2 * cos2u, uk = u - 0.25 * t2 * this.x7thm1 * sin2u, xnodek = xnode + 1.5 * t2 * this.cosio * sin2u, xinck = this.xincl + 1.5 * t2 * this.cosio * this.sinio * cos2u;
    const rdotk = rdot - xn * t1 * this.x1mth2 * sin2u, rfdotk = rfdot + xn * t1 * (this.x1mth2 * cos2u + 1.5 * this.x3thm1);
    const sinuk = Math.sin(uk), cosuk = Math.cos(uk), sinik = Math.sin(xinck), cosik = Math.cos(xinck), sinnok = Math.sin(xnodek), cosnok = Math.cos(xnodek);
    const xmx = -sinnok * cosik, xmy = cosnok * cosik, ux = xmx * sinuk + cosnok * cosuk, uy = xmy * sinuk + sinnok * cosuk, uz = sinik * sinuk, vx = xmx * cosuk - cosnok * sinuk, vy = xmy * cosuk - sinnok * sinuk, vz = sinik * cosuk;
    const kmpm = XKMPER / 60;
    return { r: [rk * ux * XKMPER, rk * uy * XKMPER, rk * uz * XKMPER], v: [(rdotk * ux + rfdotk * vx) * kmpm, (rdotk * uy + rfdotk * vy) * kmpm, (rdotk * uz + rfdotk * vz) * kmpm] };
  }
}
function fmod2p(x: number): number { x = x % TWO_PI; return x < 0 ? x + TWO_PI : x; }
function julian(y: number, m: number, d: number): number { if (m <= 2) { y--; m += 12; } const a = Math.floor(y / 100), b = 2 - a + Math.floor(a / 4); return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5; }
function gmst(ms: number): number { const jd = ms / 86400000 + 2440587.5, t = (jd - 2451545) / 36525; let g = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - t * t * t / 38710000; g = ((g % 360) + 360) % 360; return g * DE2RA; }

/** Look angles from an observer (deg, deg, km altitude). */
export function look(sat: Sgp4, ms: number, lat: number, lon: number, altKm = 0): Look {
  const { r, v } = sat.propagate(ms);
  const theta = gmst(ms) + lon * DE2RA, la = lat * DE2RA;
  const f = 1 / 298.26, c = 1 / Math.sqrt(1 + f * (f - 2) * Math.sin(la) ** 2), sq = (1 - f) ** 2 * c;
  const achcp = (XKMPER * c + altKm) * Math.cos(la);
  const ox = achcp * Math.cos(theta), oy = achcp * Math.sin(theta), oz = (XKMPER * sq + altKm) * Math.sin(la);
  const omegaE = 7.29211510e-5;
  const ovx = -omegaE * oy, ovy = omegaE * ox;
  const rx = r[0] - ox, ry = r[1] - oy, rz = r[2] - oz, vx = v[0] - ovx, vy = v[1] - ovy, vz = v[2];
  const sinLa = Math.sin(la), cosLa = Math.cos(la), sinTh = Math.sin(theta), cosTh = Math.cos(theta);
  const topS = sinLa * cosTh * rx + sinLa * sinTh * ry - cosLa * rz, topE = -sinTh * rx + cosTh * ry, topZ = cosLa * cosTh * rx + cosLa * sinTh * ry + sinLa * rz;
  const range = Math.sqrt(rx * rx + ry * ry + rz * rz);
  let az = Math.atan2(-topE, topS) + Math.PI; az = ((az % TWO_PI) + TWO_PI) % TWO_PI;
  const el = Math.asin(topZ / range);
  const rangeRate = (rx * vx + ry * vy + rz * vz) / range;
  // sub-satellite point
  const rMag = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const sLon = ((Math.atan2(r[1], r[0]) - gmst(ms)) / DE2RA + 540) % 360 - 180, sLat = Math.asin(r[2] / rMag) / DE2RA;
  return { az: az / DE2RA, el: el / DE2RA, rangeKm: range, rangeRate, lat: sLat, lon: sLon, altKm: rMag - XKMPER };
}

/** Receive frequency of `downHz` at this moment (range rate in km/s; approaching = higher). */
export function doppler(downHz: number, rangeRateKmS: number): number { return Math.round(downHz * (1 - rangeRateKmS / 299792.458)); }
/** What to transmit so the satellite hears `upHz` (the uplink shifts the other way). */
export function dopplerUp(upHz: number, rangeRateKmS: number): number { return Math.round(upHz * (1 + rangeRateKmS / 299792.458)); }

/** Passes over the next `hours` (coarse 30 s scan refined to 1 s at the edges). */
export function passes(sat: Sgp4, lat: number, lon: number, fromMs: number, hours = 24, minEl = 0): Pass[] {
  const out: Pass[] = [];
  let t = fromMs, up = look(sat, t, lat, lon).el > minEl, aos = up ? t : 0, maxEl = 0, aosAz = 0;
  const end = fromMs + hours * 3600_000;
  while (t < end) {
    t += 30_000;
    const l = look(sat, t, lat, lon);
    if (!up && l.el > minEl) { let a = t - 30_000, b = t; for (let i = 0; i < 6; i++) { const m = (a + b) / 2; if (look(sat, m, lat, lon).el > minEl) b = m; else a = m; } aos = b; up = true; maxEl = l.el; aosAz = look(sat, b, lat, lon).az; }
    else if (up && l.el <= minEl) { let a = t - 30_000, b = t; for (let i = 0; i < 6; i++) { const m = (a + b) / 2; if (look(sat, m, lat, lon).el > minEl) a = m; else b = m; } out.push({ aos, los: a, maxEl, aosAz, losAz: look(sat, a, lat, lon).az }); up = false; maxEl = 0; if (out.length >= 8) break; }
    else if (up && l.el > maxEl) maxEl = l.el;
  }
  return out;
}

/**
 * Every satellite in one CelesTrak group, cached for a day. Used to put a name to something that only gives an
 * identifier over the air: propagate them all and see which one is where the satellite says it is.
 */
export async function fetchGroup(group: string): Promise<Tle[]> {
  const key = `mayhem.tle.${group}`;
  try {
    const c = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (c && Date.now() - c.at < 86_400_000) return c.list as Tle[];
  } catch { /* ignore */ }
  const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`);
  const lines = (await res.text()).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const out: Tle[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) out.push({ name: lines[i].trim(), line1: lines[i + 1], line2: lines[i + 2] });
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), list: out })); } catch { /* ignore */ }
  return out;
}


/** TLEs for a set of NORAD ids from CelesTrak, cached in localStorage for 24 h. */
export async function fetchTles(ids: number[]): Promise<Map<number, Tle>> {
  const key = 'mayhem.tle', out = new Map<number, Tle>();
  try { const c = JSON.parse(localStorage.getItem(key) ?? 'null'); if (c && Date.now() - c.at < 86_400_000) { for (const t of c.list as (Tle & { norad: number })[]) out.set(t.norad, t); if (ids.every(i => out.has(i) || (c.absent ?? []).includes(i))) return out; } } catch { /* ignore */ }
  const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=TLE');
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i += 3) { const norad = Number(lines[i + 1].substring(2, 7)); out.set(norad, { name: lines[i].trim(), line1: lines[i + 1], line2: lines[i + 2] }); }
  // the ISS lives in 'stations', the weather birds in 'weather'
  for (const group of ['stations', 'weather']) {
    if (ids.every(i => out.has(i))) break;
    try {
      const r2 = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=TLE`);
      const t2 = (await r2.text()).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
      for (let i = 0; i + 2 < t2.length; i += 3) { const norad = Number(t2[i + 1].substring(2, 7)); out.set(norad, { name: t2[i].trim(), line1: t2[i + 1], line2: t2[i + 2] }); }
    } catch { /* one group down is not fatal */ }
  }
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), absent: ids.filter(i => !out.has(i)), list: [...out.entries()].map(([norad, t]) => ({ norad, ...t })) })); } catch { /* ignore */ }
  return out;
}
