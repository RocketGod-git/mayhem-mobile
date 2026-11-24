/**
 * One FM channel's identity: its discriminator goes through the mode detector, and the detector's 4800/s symbol
 * stream through the DMR, D-STAR and Fusion decoders at once (each rejects what is not its own by its checks). A
 * decoder whose checks pass names the mode before the sync count does. The snapshot says who is talking, through
 * which repeater, and where they are when they send it. With [onPcm] set, the voice comes out as 20 ms frames of 8 kHz
 * audio, each with the time it was sent (voice.ts). A channel at 256 kS/s or more also reads D-STAR DD packets.
 *
 * A decoder names its mode only once two of its checked frames came a whole number of frames apart and the mode
 * detector did not hear that mode's sync at some other spacing more often than on its grid; M17 and P25 also need a
 * 4-level eye (framing.ts). Samples pushed as clipped go to no digital decoder, only to the analog signaling. No DOM.
 */
import { ModeDetector, type HamMode } from './mode.js';
import { DmrIdentity, type DmrSlotId } from './dmrid.js';
import { DStarReceiver, repeaterOf, type DStarId } from './dstar.js';
import { YsfReceiver, type YsfId } from './ysf.js';
import type { Position } from './gps.js';
import { DtmfDecoder, dstarFlags, urcallCommand, type DStarFlags, type UrCall } from './signaling.js';
import { HamVoice, type HamPcmFrame, type HamVoiceFrame } from './voice.js';
import { DStarDdReceiver, type DdId } from './dstar-data.js';
import { P25Modes, type P25ModesSnap, type P25ModeName } from './p25modes.js';
import { AnalogSignaling, type AnalogSnap } from './analog.js';
import { M17Receiver, type M17Id } from './m17.js';
import { Codec2Decoder } from './codec2.js';
import { FrameGate, eyeOk } from './framing.js';

export interface HamIdSnap {
  mode: HamMode;
  hits: Record<string, number>;
  /** DMR: the color code and both slots (a slot that has carried nothing has src 0). */
  dmr: { cc: number; slots: DmrSlotId[] } | null;
  dstar: DStarId | null;
  ysf: YsfId | null;
  /** The talking station: a callsign (D-STAR MY, Fusion source) or a DMR radio ID; '' when none is known. */
  station: string;
  /** The repeater the signal names: D-STAR RPT1 (with its module), the Fusion downlink callsign. */
  repeater: string;
  position: Position | null;
  /** DTMF digits heard on the channel so far. */
  dtmf: string;
  /** D-STAR: the header's flags and what its URCALL asks for. */
  dstarFlags: DStarFlags | null; urcall: UrCall | null;
  /** Fusion through the Internet (the FICH's VoIP path): the node's callsign (the downlink) and its ID (Rem3). */
  internet: { node: string; id: string } | null;
  /** D-STAR DD packets (a channel at 256 kS/s or more). */
  dd: DdId | null;
  /** P25 Phase 1 and 2, NXDN and dPMR: who is talking (null unless that mode is named). */
  p25: P25ModesSnap['p25']; p25p2: P25ModesSnap['p25p2']; nxdn: P25ModesSnap['nxdn']; dpmr: P25ModesSnap['dpmr'];
  /** Analog signaling, one summary per transmission: CW ID, selcall, MDC-1200, sub-audio, courtesy tone, tail. */
  analog: AnalogSnap;
  /** M17: the link setup (callsigns, CAN, META text, position, the originator and reflector a repeater names). */
  m17: M17Id | null;
}

export class HamIdChannel {
  readonly mode: ModeDetector;
  readonly dmr = new DmrIdentity();
  readonly dstar = new DStarReceiver();
  readonly ysf = new YsfReceiver();
  readonly dtmf: DtmfDecoder;
  readonly voice = new HamVoice();
  readonly dd: DStarDdReceiver | null;
  /** Set to hear the channel: every vocoder frame, decoded, in the order sent per stream. */
  onPcm: ((f: HamPcmFrame) => void) | null = null;
  readonly m17 = new M17Receiver();
  /** Decoded M17 voice (Codec 2), 16-bit PCM at 8 kHz; voice is decoded only while this is set. */
  onM17Pcm: ((pcm: Int16Array) => void) | null = null;
  private c2: Codec2Decoder | null = null;
  /** Checked frames of the 4800/s decoders on their grids, and the symbol count they are timed by. */
  readonly gate = new FrameGate();
  private t48 = 0;
  /** Discriminator samples pushed, and those pushed while the receiver clipped. */
  samples = 0; clippedSamples = 0;
  readonly analog: AnalogSignaling;
  readonly p25: P25Modes;
  /** Clear digital voice, 160 samples at 8 kHz a frame: the mode and the slot (0, or Phase 2's 0 and 1). */
  onAudio: (mode: P25ModeName, slot: number, pcm: Float32Array) => void = () => undefined;
  constructor(readonly fs: number) {
    this.mode = new ModeDetector(fs); this.dtmf = new DtmfDecoder(fs);
    this.analog = new AnalogSignaling(fs);
    this.dd = fs >= 256000 ? new DStarDdReceiver(fs) : null;
    this.mode.onSymbol48 = s => { this.dmr.pushSymbol(s); this.dstar.pushSymbol(s); this.ysf.pushSymbol(s); this.m17.pushSymbol(s); this.frames(); };
    this.dmr.onVoiceFrame = f => this.pcm(f, this.dmr.slots[f.stream === 'dmr2' ? 1 : 0].privacy);
    this.dstar.onVoiceFrame = f => this.pcm(f, false);
    this.ysf.onVoiceFrame = f => this.pcm(f, false);
    this.m17.onVoice = (f, rate) => {
      if (!this.onM17Pcm) return;
      if (!this.c2 || this.c2.rate !== rate) this.c2 = new Codec2Decoder(rate === 1600 ? 1600 : 3200);
      this.onM17Pcm(this.c2.decode(f));
    };
    this.p25 = new P25Modes(fs); this.p25.onAudio = (m, slot, pcm) => this.onAudio(m, slot, pcm);
    const s48 = this.mode.onSymbol48; this.mode.onSymbol48 = s => { s48(s); this.p25.pushSymbol48(s); };
  }
  private pcm(f: HamVoiceFrame, encrypted: boolean): void { if (this.onPcm) this.onPcm(this.voice.decode(f, encrypted)); }
  reset(): void { this.mode.reset(); this.dmr.reset(); this.dstar.reset(); this.ysf.reset(); this.dtmf.reset(); this.voice.reset(); this.dd?.reset(); this.p25.reset(); this.analog.reset(); this.m17.reset(); this.c2 = null;
    this.gate.reset(); this.t48 = 0; this.samples = 0; this.clippedSamples = 0; }
  /** Discriminator samples, radians per sample, at [fs]. */
  /** Discriminator samples, radians per sample, at [fs]. [clipped]: the receiver clipped while they came (a strong
   *  signal nearby spraying spurs): they go to the analog signaling only, so nothing digital is named from them. */
  push(disc: ArrayLike<number>, n: number, clipped = false): void {
    this.samples += n;
    if (clipped) { this.clippedSamples += n; this.analog.push(disc, n); return; }
    this.mode.push(disc, n); this.dtmf.push(disc, n); this.dd?.push(disc, n); this.p25.push(disc, n); this.analog.push(disc, n);
  }
  /** After each 4800/s symbol: a checked frame of DMR, D-STAR, Fusion or M17 is timed for the frame grid. */
  private frames(): void {
    const t = ++this.t48, g = this.gate;
    g.mark('DMR', this.dmr.checked + this.dmr.clean, t);
    g.mark('D-STAR', this.dstar.id.frames, t);
    g.mark('YSF', this.ysf.id.frames, t);
    g.mark('M17', this.m17.id.lsfs + this.m17.id.frames, t);
  }
  /** Whether a decoder's checks may name [m]: its frames on their grid, its syncs not heard off it, the eye for M17. */
  claims(m: 'DMR' | 'D-STAR' | 'YSF' | 'M17'): boolean {
    const g = this.gate, det = this.mode;
    switch (m) {
      case 'M17': return (this.m17.id.lsfs > 0 || this.m17.id.frames >= 3) && g.framed('M17') && !det.offGrid('M17') && eyeOk(det.eye('M17'));
      case 'YSF': return this.ysf.id.frames > 0 && g.framed('YSF') && !det.offGrid('YSF');
      // a header whose CRC checks is a D-STAR call by itself; data frames need their 20 ms grid
      case 'D-STAR': return this.dstar.id.headers > 0 || (this.dstar.id.frames >= 20 && g.framed('D-STAR'));
      case 'DMR': return (this.dmr.checked > 0 || this.dmr.clean >= 3) && g.framed('DMR') && !det.offGrid('DMR');
    }
  }
  /** P25 Phase 1 and 2, NXDN and dPMR: the mode whose checked frames came last on their grid (P25 with its eye), or ''. */
  private moreMode(): string {
    const m = this.p25.mode;
    if (m === 'P25' && !eyeOk(this.mode.eye('P25'))) return '';
    return m;
  }

  snapshot(): HamIdSnap {
    const r = this.mode.result();
    let mode: HamMode = r.mode;
    // a decoder's checks name the mode before the detector's sync count does
    let claimed = true;
    if (this.claims('M17')) mode = 'M17';
    else if (this.claims('YSF')) mode = 'YSF';
    else if (this.claims('D-STAR')) mode = 'D-STAR';
    else if (this.claims('DMR')) mode = 'DMR';
    else if (this.dd && this.dd.id.packets > 0) mode = 'D-STAR';
    else claimed = false;
    const more = this.moreMode() ? this.p25.snapshot() : null;
    if (more && !claimed) mode = more.mode as HamMode;
    const dd = this.dd && this.dd.id.packets > 0 ? { ...this.dd.id, frames: [...this.dd.id.frames] } : null;
    const snap: HamIdSnap = { mode, hits: r.hits, dmr: null, dstar: null, ysf: null, station: '', repeater: '', position: null, dtmf: this.dtmf.text, dstarFlags: null, urcall: null, internet: null, dd, p25: null, p25p2: null, nxdn: null, dpmr: null, m17: null,
      analog: this.analog.snapshot() };
    if (mode === 'DMR') {
      const slots = this.dmr.slots.map(s => ({ ...s }));
      snap.dmr = { cc: this.dmr.cc, slots };
      const live = slots.filter(s => s.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      if (live) { snap.station = live.alias || String(live.src); snap.position = live.position; }
    } else if (mode === 'D-STAR') {
      const id = { ...this.dstar.id }; snap.dstar = id;
      const h = id.header ?? dd?.header;
      if (h) {
        snap.dstarFlags = dstarFlags(h.flag1); snap.urcall = urcallCommand(h.ur);
        snap.station = h.my + (h.suffix ? '/' + h.suffix : '');
        const rp = repeaterOf(h.rpt1);
        if (rp.call && rp.call !== 'DIRECT') snap.repeater = rp.call + (rp.module ? ' ' + rp.module : '');
      }
      snap.position = id.position;
    } else if (mode === 'YSF') {
      const id = { ...this.ysf.id, rem: [...this.ysf.id.rem] as [string, string, string, string] }; snap.ysf = id;
      snap.station = id.src; snap.repeater = id.down; snap.position = id.position;
      if (id.voip) snap.internet = { node: id.down, id: id.rem[2] };
    } else if (mode === 'M17') {
      const id = { ...this.m17.id }; snap.m17 = id;
      // a repeater sends its own callsign as the source and the station it relays as the originator
      snap.station = id.originator || id.src;
      snap.repeater = id.originator ? id.src : id.reflector ? id.reflector + (id.module ? ' ' + id.module : '') : '';
      snap.position = id.position;
    } else if (more && mode === more.mode) Object.assign(snap, { p25: more.p25, p25p2: more.p25p2, nxdn: more.nxdn, dpmr: more.dpmr, station: more.station, repeater: more.repeater, position: more.position });
    return snap;
  }
}
