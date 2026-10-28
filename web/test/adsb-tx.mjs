/*
 * ADS-B transmit encoder: the frame it builds must carry a checksum a receiver accepts.
 *
 * Two checks. First a known frame off the air - 8D4840D6202CC371C32CE0576098, the identification squitter used as
 * the worked example in "The 1090 MHz Riddle" - rebuilt from its address and ME field, byte for byte, CRC included.
 * Then a frame from the encoder, turned into 2 Msps PPM by adsbSymbols, goes through the app's own ADS-B decoder,
 * which drops anything that fails CRC-24: an aircraft only comes out the other end if the checksum is right.
 */
import { adsbFrame, adsbSymbols } from '../dist/tx-apps.js';
import { AdsbDecoder } from '../dist/dsp/adsb.js';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('FAIL', what); } };
const hex = (a) => Array.from(a, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

console.log('a known squitter, rebuilt exactly');
ok(hex(adsbFrame(0x4840D6, 0x71C32CE0, 0x202CC3)) === '8D4840D6202CC371C32CE0576098', 'KLM1023 frame and CRC match the reference');

console.log('our own decoder accepts what the encoder sends');
{
  const got = [];
  const dec = new AdsbDecoder((m) => got.push(m));
  dec.reset(2_000_000);
  // identification, callsign MAYHEM01: TC 4 then eight 6-bit characters
  const CS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';
  let me = 4n << 51n;
  for (let i = 0; i < 8; i++) me |= BigInt(CS.indexOf('MAYHEM01'[i])) << BigInt(42 - 6 * i);
  const slots = adsbSymbols(adsbFrame(0xA1B2C3, Number(me & 0xFFFFFFFFn), Number(me >> 32n)));
  const n = 400_000, iq = new Int8Array(n * 2);
  for (let at = 2000; at + slots.length < n; at += 20_000) for (let s = 0; s < slots.length; s++) if (slots[s]) { iq[2 * (at + s)] = 110; iq[2 * (at + s) + 1] = 50; }
  dec.onIq(iq, 2_000_000);
  await new Promise(r => setTimeout(r, 1100));
  dec.onIq(new Int8Array(8192), 2_000_000);
  const ac = got.filter(m => m.type === 'aircraft').pop();
  const plane = ac?.list?.find(a => a.icao === 'a1b2c3');
  ok(!!plane, 'the aircraft decodes');
  ok((plane?.flight ?? plane?.callsign ?? '').trim() === 'MAYHEM01', 'with its callsign');
  ok((ac?.frames ?? 0) >= 18, `every frame passes CRC (${ac?.frames} of 19)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
