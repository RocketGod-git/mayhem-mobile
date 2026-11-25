/**
 * One transmission's identity in a few fields, for Repeaters: the mode, who is talking (the callsign the signal
 * carries, the radio ID, a talker alias), to whom (talkgroup, called radio, destination), through what (the repeater
 * and the network the signal names, the color code, NAC, RAN or DG-ID), and what else was heard (encryption, an
 * emergency, a message, a position, analog signaling). Small enough to travel with every log row from the receiver
 * to the screen, where the directories (resolve.ts) put names to the IDs. The same as Android's Ident.kt and the
 * Swift HamIdent. No DOM.
 */
import type { HamIdSnap } from './channel.js';
import type { Position } from './gps.js';
import { analogSummary, type AnalogTx } from './analog.js';
import { lookupKey } from './directory.js';

export interface HamIdent {
  /** 'DMR', 'D-STAR', 'YSF', 'P25', 'P25P2', 'NXDN', 'dPMR', 'M17', or 'analog' for analog signaling alone. */
  mode: string;
  /** The callsign the signal carries (D-STAR MY, Fusion source, M17 source or originator, a DMR alias that is one). */
  callsign: string;
  /** The source radio ID (DMR, P25, NXDN, dPMR), 0 when none. */
  radioId: number;
  /** A DMR talker alias, a D-STAR suffix, a dPMR ID's text, an NXDN Type-D unit. */
  alias: string;
  /** The talkgroup, or the radio called when [group] is false; 0 when none. */
  tg: number; group: boolean;
  /** Where the call goes as text: D-STAR URCALL, the Fusion destination, the M17 destination, the dPMR called ID. */
  dest: string;
  /** The repeater as the signal names it: D-STAR RPT1, the Fusion downlink, the M17 repeater or reflector module. */
  repeater: string;
  /** The network the signal names: Fusion through the Internet (the node, a WIRES-X room), an M17 reflector, a D-STAR gateway. */
  network: string;
  /** The DMR color code, P25 NAC, NXDN RAN, dPMR color code or Fusion DG-ID; -1 when none. */
  code: number;
  /** The DMR time slot (1, 2) or P25 Phase 2 slot; 0 when none. */
  slot: number;
  encrypted: boolean; emergency: boolean;
  /** 'voice', 'data', 'idle' or ''. */
  activity: string;
  /** A D-STAR slow data message, M17 META text, a WIRES-X reply. */
  text: string;
  position: Position | null;
  /** Analog signaling heard (selcall, MDC-1200, FleetSync, a 2-tone page, DTMF, a courtesy tone, a kerchunk). */
  signaling: string[];
}

export const blankIdent = (mode: string): HamIdent => ({ mode, callsign: '', radioId: 0, alias: '', tg: 0, group: true, dest: '', repeater: '', network: '', code: -1, slot: 0, encrypted: false, emergency: false, activity: '', text: '', position: null, signaling: [] });

/** The digital modes the identity layer names. */
export const DIGITAL_MODES = ['DMR', 'D-STAR', 'YSF', 'P25', 'P25P2', 'NXDN', 'dPMR', 'M17'];
export const isDigital = (mode: string) => DIGITAL_MODES.includes(mode);
/** How a mode is badged on screen. */
export const MODE_BADGE: Record<string, string> = { DMR: 'DMR', 'D-STAR': 'D-STAR', YSF: 'FUSION', P25: 'P25', P25P2: 'P25 II', NXDN: 'NXDN', dPMR: 'DPMR', M17: 'M17' };
/** What a mode calls its [code]. */
export const CODE_NAME: Record<string, string> = { DMR: 'CC', P25: 'NAC', P25P2: 'NAC', NXDN: 'RAN', dPMR: 'CC', YSF: 'DG-ID' };
export const codeText = (id: HamIdent) => id.code < 0 || !CODE_NAME[id.mode] ? '' : `${CODE_NAME[id.mode]} ${id.mode === 'P25' || id.mode === 'P25P2' ? id.code.toString(16).toUpperCase().padStart(3, '0') : id.code}`;

/** Analog signaling lines of the transmissions an analog decoder read, without what Repeaters already shows (CW ID, PL, DCS, tail). */
export function signalingLines(txs: AnalogTx[], dtmf: string): string[] {
  const out: string[] = [];
  for (const tx of txs) for (const l of analogSummary(tx)) {
    if (/^(CW ID|PL |DCS |Tail )/.test(l)) continue;
    if (!out.includes(l)) out.push(l);
  }
  if (dtmf) out.push(`DTMF ${dtmf}`);
  return out;
}

/** The identity of what a channel carried, from its snapshot; null when it names nothing (plain analog voice). */
export function identOf(s: HamIdSnap): HamIdent | null {
  const sig = signalingLines(s.analog?.txs ?? [], s.dtmf);
  if (!isDigital(s.mode) || !s.verified) {
    if (!sig.length) return null;
    const id = blankIdent('analog'); id.signaling = sig;
    // MDC-1200 and FleetSync carry the talker's unit ID
    const tx = (s.analog?.txs ?? []).find(t => t.mdc.length || t.fleetsync.length);
    if (tx?.mdc.length) { id.alias = `MDC ${tx.mdc[0].unit}`; id.emergency = tx.mdc.some(m => m.emergency); }
    else if (tx?.fleetsync.length) { const f = tx.fleetsync[0]; id.alias = `FleetSync ${f.fromFleet < 0 ? 'all' : f.fromFleet}-${f.fromUnit < 0 ? 'all' : f.fromUnit}`; }
    return id;
  }
  // (analog signaling read on a digital channel is the 4FSK itself: a kerchunk, a tone; none of it is said)
  const id = blankIdent(s.mode); id.position = s.position;
  switch (s.mode) {
    case 'DMR': {
      const d = s.dmr; if (!d) break;
      id.code = d.cc;
      const live = d.slots.filter(x => x.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      const act = d.slots.map(x => x.activity);
      id.activity = act.includes('voice') ? 'voice' : act.includes('data') ? 'data' : act.includes('idle') ? 'idle' : '';
      if (live) {
        id.slot = live.slot; id.radioId = live.src; id.alias = live.alias; id.tg = live.tg; id.group = live.group;
        id.encrypted = live.privacy; id.emergency = live.emergency; id.position = live.position ?? id.position;
        id.callsign = lookupKey(live.alias);
        id.activity = live.activity || id.activity;
      }
      break;
    }
    case 'D-STAR': {
      const h = s.dstar?.header ?? s.dd?.header ?? null;
      if (h) {
        id.callsign = h.my.trim(); id.alias = h.suffix.trim(); id.dest = h.ur.trim();
        // RPT2 ending in G is the gateway: the call goes out to the Internet (a reflector or another repeater)
        if (/G\s*$/.test(h.rpt2)) id.network = s.urcall?.kind === 'link' && s.urcall.target ? `${s.urcall.target}${s.urcall.module ? ' ' + s.urcall.module : ''}`.trim() : 'D-STAR gateway';
      }
      id.repeater = s.repeater; id.text = s.dstar?.message.trim() ?? '';
      id.activity = 'voice';
      break;
    }
    case 'YSF': {
      const y = s.ysf; if (!y) break;
      id.callsign = y.src.trim(); id.dest = y.dest.trim(); id.repeater = y.down.trim(); id.code = y.dgid;
      if (s.internet) id.network = `WIRES-X ${s.internet.node}${s.internet.id ? ' ' + s.internet.id : ''}`.trim();
      if (y.wires) { if (y.wires.room) id.network = `WIRES-X ${y.wires.room}`; id.text = y.wires.name || y.wires.description; }
      id.activity = 'voice';
      break;
    }
    case 'P25': {
      const p = s.p25; if (!p) break;
      id.code = p.nac; id.radioId = p.src; id.tg = p.tg; id.group = p.group; id.encrypted = p.encrypted; id.emergency = p.emergency;
      id.activity = p.voiceFrames > 0 || p.encrypted ? 'voice' : 'data';
      break;
    }
    case 'P25P2': {
      const p = s.p25p2; if (!p) break;
      id.code = p.nac;
      const live = p.slots.filter(x => x.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      if (live) { id.slot = live.lch + 1; id.radioId = live.src; id.tg = live.tg; id.group = live.group; id.encrypted = live.encrypted; id.emergency = live.emergency; id.activity = live.activity || 'voice'; }
      break;
    }
    case 'NXDN': {
      const x = s.nxdn; if (!x) break;
      id.code = x.ran; id.radioId = x.src; id.tg = x.dst; id.group = x.group; id.encrypted = x.cipher > 0; id.emergency = x.emergency;
      if (x.typeD) id.alias = `${x.src >> 11}-${x.src & 0x7ff}`;
      id.activity = x.activity || (x.voiceFrames ? 'voice' : '');
      break;
    }
    case 'dPMR': {
      const x = s.dpmr; if (!x) break;
      id.code = x.cc; id.radioId = x.own >= 0 ? x.own : 0; id.alias = x.ownText; id.dest = x.calledText; id.group = x.group;
      id.activity = x.activity || (x.voiceFrames ? 'voice' : '');
      break;
    }
    case 'M17': {
      const m = s.m17; if (!m) break;
      id.callsign = (m.originator || m.src).trim(); id.dest = m.dst.trim(); id.code = m.can;
      id.repeater = s.repeater; id.network = m.reflector ? m.reflector + (m.module ? ' ' + m.module : '') : '';
      id.encrypted = m.encryption !== ''; id.text = m.text || m.packetText;
      id.activity = m.kind.startsWith('voice') ? 'voice' : m.kind ? 'data' : '';
      break;
    }
  }
  return id;
}

/** Who is talking, as the signal says it: the callsign, else the alias, else the radio ID; '' when unknown. */
export function identWho(id: HamIdent): string {
  return id.callsign || id.alias || (id.radioId ? String(id.radioId) : '');
}
