/**
 * ACARS aircraft (AcarsPlanesTest.kt / AcarsPlanesTest.swift): decoder lines read back into messages, grouped into one
 * record per aircraft, and US registrations turned into ICAO addresses for the ADS-B link.
 */
import { parseAcarsLine, AcarsPlanes, nNumberToIcao, normReg, labelMeaning, planeKey, MSG_KEEP } from '../dist/acars-planes.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('ACARS aircraft: messages, one record per aircraft, N-number to ICAO');

/** A line exactly as AcarsDecoder.finish() writes it. */
function line({ mhz = '131.550', down = true, reg = 'N12345', label = 'H1', blk = '3', ack = 'NAK', msn = 'M01A', flight = 'UA1234', ok = true, mode = '2', text = '' } = {}) {
  const head = `ACARS ${mhz} ${down ? '↓' : '↑'} ${reg}  ${label}  blk ${blk}  ack ${ack}${msn ? `  #${msn} ${flight}` : ''}${ok ? '' : '  CRC?'}${mode !== '2' ? `  mode ${mode}` : ''}`;
  return text ? `${head}\n${text}` : head;
}

{
  const m = parseAcarsLine(line({ text: 'POS N3412W11824' }), 1000);
  eq(m.mhz, '131.550', 'channel');
  eq(m.down, true, 'downlink');
  eq(m.reg, 'N12345', 'registration');
  eq(m.label, 'H1', 'label');
  eq(m.blk, '3', 'block');
  eq(m.ack, 'NAK', 'ack');
  eq(m.msn, 'M01A', 'message number');
  eq(m.flight, 'UA1234', 'flight');
  eq(m.crcOk, true, 'CRC good');
  eq(m.mode, '2', 'mode');
  eq(m.text, 'POS N3412W11824', 'text');
  eq(m.ms, 1000, 'time');
  const u = parseAcarsLine(line({ down: false, reg: '', label: '_d', blk: 'A', ack: '1', msn: '', ok: false, mode: 'X' }), 5);
  eq(u.down, false, 'uplink');
  eq(u.reg, '', 'no registration');
  eq(u.label, '_d', 'DEL label');
  eq(u.msn, '', 'no message number on an uplink');
  eq(u.crcOk, false, 'CRC bad');
  eq(u.mode, 'X', 'other mode');
  eq(u.text, '', 'no text');
  const sp = parseAcarsLine(line({ msn: 'M02B', flight: '' }), 5);
  eq(sp.flight, '', 'message number without a flight');
  eq(parseAcarsLine(line({ mhz: '131,550' }), 0).mhz, '131.550', 'a decimal comma (a device locale) reads the same');
  eq(parseAcarsLine('ACARS: decoding 131.550 MHz', 0), null, 'not a message line');
  eq(parseAcarsLine('POCSAG 1200 …', 0), null, 'another decoder line');
}

{
  const p = new AcarsPlanes();
  p.add(parseAcarsLine(line({ reg: 'N12345', flight: 'UA1234', text: 'one' }), 1000));
  p.add(parseAcarsLine(line({ reg: 'N12345', flight: 'UA1234', text: 'two' }), 2000));
  p.add(parseAcarsLine(line({ reg: 'G-EUUA', flight: 'BA0123', text: 'three' }), 1500));
  p.add(parseAcarsLine(line({ down: false, reg: '', label: 'SQ', msn: '' }), 1600));
  eq(p.planes.size, 2, 'one record per aircraft, ground squitter left out');
  eq(p.total, 4, 'every message counted');
  const a = p.planes.get('R:N12345');
  eq(a.count, 2, 'messages per aircraft');
  eq(a.msgs[0].text, 'two', 'newest message first');
  eq(a.firstMs, 1000, 'first heard');
  eq(a.lastMs, 2000, 'last heard');
  eq(a.icao, nNumberToIcao('N12345'), 'ICAO from the N-number');
  eq(p.planes.get('R:G-EUUA').icao, '', 'no ICAO from a foreign registration');
  eq(p.list()[0].reg, 'N12345', 'most recent first');
  // a flight heard first without its registration joins it later
  p.add(parseAcarsLine(line({ reg: '', flight: 'DL0042', text: 'a' }), 3000));
  eq(p.planes.has('F:DL0042'), true, 'kept by flight when there is no registration');
  p.add(parseAcarsLine(line({ reg: 'N301DV', flight: 'DL0042', text: 'b' }), 4000));
  eq(p.planes.has('F:DL0042'), false, 'the flight record moves to the registration');
  eq(p.planes.get('R:N301DV').count, 2, 'its messages come along');
  for (let i = 0; i < MSG_KEEP + 5; i++) p.add(parseAcarsLine(line({ reg: 'N1' }), 5000 + i));
  eq(p.planes.get('R:N1').msgs.length, MSG_KEEP, 'messages capped');
  eq(p.planes.get('R:N1').count, MSG_KEEP + 5, 'count keeps going');
  eq(planeKey(parseAcarsLine(line({ reg: '', flight: '', msn: '' }), 0)), '', 'nothing to key on');
  p.clear(); eq(p.planes.size, 0, 'clear');
}

eq(nNumberToIcao('N1'), 'A00001', 'N1');
eq(nNumberToIcao('N628TS'), 'A835AF', 'N628TS');
eq(nNumberToIcao('n-628ts'), 'A835AF', 'lower case with a dash');
eq(nNumberToIcao('N99999'), 'ADF7C7', 'N99999 is the last');
eq(nNumberToIcao('N1A'), 'A00002', 'N1A');
eq(nNumberToIcao('N1AA'), 'A00003', 'N1AA');
eq(nNumberToIcao('N10'), 'A0025A', 'N10');
eq(nNumberToIcao('G-EUUA'), '', 'not a US registration');
eq(nNumberToIcao('N0123'), '', 'no leading zero');
eq(nNumberToIcao('N1I'), '', 'no letter I');
eq(nNumberToIcao('N123456'), '', 'too long');
eq(normReg('N-628TS'), 'N628TS', 'registration normalized');
eq(labelMeaning('Q0'), 'link test', 'label meaning');
eq(labelMeaning('ZZ'), '', 'unknown label');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
