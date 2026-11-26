/**
 * GMRS and MURS on the page: the band tabs, the channel board, the channels heard as tiles, a channel's card, the
 * callsigns heard, the log with its repeater pairs and data bursts, and the activity map a row a channel. The live bar,
 * the conversations and the timeline are HAM+'s, named by channel through [GMRS_NAMER]. No state of its own beyond what
 * the page passes in.
 */
import { channelsOf, gmrsChan, gmrsName, gmrsTitle, type GmrsBand } from './dsp/gmrs/plan.js';
import type { GmrsChanState, GmrsRow, GmrsSnap } from './dsp/gmrs/engine.js';
import type { HpTile, HpTxRow } from './dsp/hamplus/tracker.js';
import { HEAT_SLOTS } from './dsp/hamplus/tracker.js';
import { hpClock, hpColor, hpConvHtml, hpDur, hpHeard, hpIdentLine, hpMhz, hpTone, sparkSvg, type HpNamer } from './hamplus-ui.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pill = (text: string, cls = '') => `<em class="hp-pill ${cls}">${esc(text)}</em>`;

/** 'CH 15', 'CH 15R', 'MURS 4', or the frequency off the plans. */
export const gmrsChanTitle = (hz: number) => { const c = gmrsChan(hz); return c ? gmrsTitle(c) : hpMhz(hz); };
/** The second line of a channel: its frequency, and its name when it has one. */
export const gmrsSub = (hz: number) => { const c = gmrsChan(hz), n = c ? gmrsName(c) : ''; return n ? `${hpMhz(hz)} · ${n}` : hpMhz(hz); };

/** What a keyup carried beyond its voice: its repeater (input and output tones), else its tone; DATA for a burst no decoder named. */
export function gmrsMeta(r: GmrsRow): string {
  const parts: string[] = [], p = r.rpt;
  if (p) {
    if (Math.abs(r.heardHz - p.inHz) < 1_000) parts.push(p.outHeard ? `VIA REPEATER ${hpMhz(p.outHz)}` : `REPEATER INPUT FOR ${hpMhz(p.outHz)}, OUTPUT NOT HEARD`);
    else parts.push(`REPEATER ${hpMhz(p.outHz)}, INPUT ${hpMhz(p.inHz)} HEARD`);
    const it = hpTone(p.inTone, p.inDcs), ot = hpTone(p.outTone, p.outDcs);
    if (it) parts.push(`IN ${it}`);
    if (p.outHeard && ot) parts.push(`OUT ${ot}`);
  } else { const t = hpTone(r.tone, r.dcs); if (t) parts.push(t); }
  if (r.data.length) parts.push('DATA');
  return parts.join(' · ');
}

export const GMRS_NAMER: HpNamer = {
  chan: gmrsChanTitle,
  name: (t: HpTile) => gmrsSub(t.hz),
  meta: (r: HpTxRow) => gmrsMeta(r as GmrsRow),
  waiting: hold => gmrsChanTitle(Number(hold)),
};

/** GMRS or MURS. */
export function gmrsBandsHtml(band: GmrsBand): string {
  return `<div class="ctlrow"><span class="rl">BAND</span><div class="seg"><button data-gmrsband="gmrs" class="${band === 'gmrs' ? 'on' : ''}">GMRS / FRS</button><button data-gmrsband="murs" class="${band === 'murs' ? 'on' : ''}">MURS</button></div></div>`;
}

/** The counters and the span, and the demodulators in use against what the device keeps up with. */
export function gmrsHeadHtml(s: GmrsSnap | null, band: GmrsBand): string {
  const all = channelsOf(band).length, inSpan = s?.chans.filter(c => c.inSpan).length ?? 0, onAir = s?.stats.onAir ?? 0;
  const span = band === 'murs' ? '151.820–154.600 MHz' : '462.550–467.725 MHz';
  const cell = (n: string | number, l: string, on = false) => `<div class="${on ? 'on' : ''}"><b>${n}</b><small>${l}</small></div>`;
  const rpt = s ? new Set(s.rows.filter(r => r.rpt).map(r => r.rpt!.inHz)).size : 0;
  return `<div class="hp-hl"><b>${band === 'murs' ? 'MURS' : 'GMRS'}</b><span>${span}${s && s.rate && inSpan < all ? ` · ${inSpan} of ${all} channels in the span` : ` · all ${all} channels`}</span></div>`
    + `<div class="hp-stats">${cell(s?.tiles.length ?? 0, 'HEARD')}${cell(onAir, 'ON AIR', onAir > 0)}${cell(s?.calls.length ?? 0, 'CALLS')}${cell(rpt, 'REPEATERS')}${cell(s?.chans.filter(c => c.steady).length ?? 0, 'CARRIERS')}${cell(Math.floor((s?.stats.clipS ?? 0) / 60), 'MIN KEPT')}</div>`
    + (s ? `<div class="hp-cost">demodulating ${s.stats.probes} now · this device keeps up with ${s.stats.cap} at once${s.stats.costMs > 0 ? ` (${Math.round(s.stats.costMs)} ms a channel a second)` : ''} · time machine ${s.stats.clipMB} of ${s.stats.capMB} MB</div>` : '');
}

/** What is heard: ALL or the one channel followed, and MIX or NEWEST. */
export function gmrsListenHtml(hold: string, mode: 'mix' | 'newest'): string {
  const on = !!hold;
  return `<div class="fl-listen ${on ? 'on' : ''}"><small>${on ? 'FOLLOWING' : 'HEARING'}</small><b>${on ? gmrsChanTitle(Number(hold)) : 'ALL'}</b><span>${on ? 'only this channel is heard' : mode === 'mix' ? 'every channel at once' : 'the newest to key up'}</span>${on ? '<button class="chip" data-hpfollow="">ALL</button>' : ''}</div>`
    + `<div class="seg hp-mode"><button data-hpmode="mix" class="${mode === 'mix' ? 'on' : ''}">MIX</button><button data-hpmode="newest" class="${mode === 'newest' ? 'on' : ''}">NEWEST</button></div>`;
}

const blankChans = (band: GmrsBand): GmrsChanState[] => channelsOf(band).map(c => ({ id: c.id, hz: c.hz, key: String(Math.round(c.hz / 100) * 100), kind: c.kind, name: gmrsName(c), inSpan: true, open: false, steady: false, tone: 0, dcs: 0, lastMs: 0, txs: 0, call: '', data: false }));

/** Every channel of the band, a cell each: its number, frequency, and what is on it now (on the air and its tone, a steady carrier, heard a while ago). */
export function gmrsBoardHtml(s: GmrsSnap | null, band: GmrsBand, now: number, hold: string, sel: string): string {
  const chans = s && s.band === band ? s.chans : blankChans(band);
  const cells = chans.map(c => {
    const playing = s?.playing.includes(c.key), recent = c.lastMs > 0 && now - c.lastMs < 600_000 && !c.open, tone = hpTone(c.tone, c.dcs);
    const st = c.open ? `<span class="on">${esc(tone || 'ON AIR')}</span>` : c.steady ? '<span class="cr">CARRIER</span>' : recent ? `<span>${esc(hpHeard(now, c.lastMs))}</span>` : '<span>&nbsp;</span>';
    const mark = c.id === '20' ? 'em' : c.kind === 'input' ? 'hw' : '';
    const cls = ['cb-cell', c.open ? 'live' : '', c.steady ? 'steady' : '', recent ? 'recent' : '', mark, hold === c.key ? 'fol' : '', sel === c.key ? 'sel' : '', c.inSpan ? '' : 'off'].filter(Boolean).join(' ');
    const title = `${gmrsTitle(gmrsChan(c.hz)!).toLowerCase()}, ${hpMhz(c.hz)} MHz${c.name ? `, ${c.name.toLowerCase()}` : ''}${tone ? `, ${tone}` : ''}${c.call ? `, ${c.call}` : ''}`;
    return `<button class="${cls}" data-hpinfo="${c.key}" title="${esc(title)}" aria-label="${esc(title)}"><b>${esc(c.id.replace(/^M/, ''))}${playing ? '<i class="hp-note">♪</i>' : ''}</b><small>${hpMhz(c.hz)}</small>${st}${c.id === '20' ? '<u>TRAVEL</u>' : c.kind === 'input' ? '<u>RPT IN</u>' : c.data ? '<u>DATA</u>' : ''}</button>`;
  }).join('');
  const off = chans.filter(c => !c.inSpan).length;
  const foot = off ? `<div class="cb-foot">${off} channel${off === 1 ? ' is' : 's are'} outside what this radio hears at once · a HackRF hears the whole band</div>` : '';
  return `<div class="cb-board">${cells}</div>${foot}`;
}

/** The channels heard, live first. A tap follows one, the i opens its card. */
export function gmrsTilesHtml(s: GmrsSnap | null, now: number, hold: string, emptyHtml: string): string {
  const tiles = s?.tiles ?? [];
  const all = `<div class="fl-tile all hp-tile ${hold ? '' : 'fol'}" role="button" data-hpfollow=""><b>ALL</b><small>EVERY CHANNEL</small><span>${hold ? 'tap to hear them all' : `hearing all ${tiles.length}`}</span></div>`;
  return `<div class="fl-tilegrid hp-grid">${all}${tiles.map(t => {
    const c = s!.chans.find(x => x.key === t.key), playing = s?.playing.includes(t.key), tone = hpTone(t.tone, t.dcs);
    const badges = [c?.id === '20' ? pill('TRAVEL', 'warm') : '', t.inputHz ? pill(`REPEATER, INPUT ${hpMhz(t.inputHz)}`, 'acc') : '', c?.kind === 'input' ? pill('REPEATER INPUT') : '',
      t.callsign ? pill(t.callsign, 'acc') : '', c?.data ? pill('DATA', 'warm') : '', c?.steady ? pill('STEADY CARRIER') : '',
      t.followed ? pill('FOLLOWING', 'acc') : '', t.prio ? pill('PRIORITY', 'warm') : '', t.muted ? pill('MUTED') : '', t.unrecorded ? pill(`${t.unrecorded} NOT RECORDED`, 'bad') : ''].join('');
    return `<div class="fl-tile hp-tile cb-tile ${t.live ? 'live' : ''} ${t.followed ? 'fol' : ''} ${t.muted ? 'muted' : ''} ${t.prio ? 'prio' : ''}" role="button" data-hpfollow="${t.key}">`
      + `<b>${esc(gmrsChanTitle(t.hz))}${playing ? '<i class="hp-note">♪</i>' : ''}</b><small>${esc(gmrsSub(t.hz))}</small>`
      + (tone ? `<span class="hp-line">${esc(tone)}</span>` : '')
      + (t.live ? `<span class="hp-air">ON AIR ${hpDur(t.openMs)}<span class="fl-vu"><span><i style="width:${Math.max(5, Math.min(100, t.snrDb * 2.5)).toFixed(0)}%"></i></span></span></span>` : `<span>${hpHeard(now, t.lastMs)} · ${t.txs} tx · ${hpDur(t.talkMs)}</span>`)
      + sparkSvg(t.spark, t.live) + (badges ? `<div class="hp-badges">${badges}</div>` : '')
      + `<button class="fl-ti" data-hpinfo="${t.key}" title="details" aria-label="details">i</button></div>`;
  }).join('')}</div>${tiles.length ? '' : emptyHtml}`;
}

/** What a channel is, in words. */
function kindText(c: GmrsChanState): string {
  switch (c.kind) {
    case 'frs': return 'FRS and GMRS, simplex';
    case 'gmrs': return `GMRS simplex, and a repeater output listening on ${hpMhz(c.hz + 5_000_000)}`;
    case 'input': return `GMRS repeater input, the repeater talks back on ${hpMhz(c.hz - 5_000_000)}`;
    default: return 'MURS, simplex';
  }
}

/** A channel's card: what it is, its last tone and callsign, follow / mute / priority, its talkers and its last conversation. */
export function gmrsCardHtml(s: GmrsSnap, key: string, now: number, prefs: { hold: string; mute: string[]; prio: string[] }, open: Set<number>): string {
  const c = s.chans.find(x => x.key === key); if (!c) return '';
  const t = s.tiles.find(x => x.key === key);
  const kv: [string, string][] = [['FREQUENCY', `${hpMhz(c.hz)} MHz`], ['CHANNEL', kindText(c)]];
  if (c.name && c.kind !== 'input') kv.push(['USE', c.id === '20' ? 'by custom, travelers and emergencies' : c.name.toLowerCase()]);
  const tone = hpTone(c.tone, c.dcs); if (tone) kv.push(['TONE', `${tone}${c.open ? ', on the air now' : ', the last keyup'}`]);
  if (c.call) kv.push(['CALLSIGN', `${c.call}, from its Morse ID`]);
  if (c.steady) kv.push(['ON IT NOW', 'a steady carrier with no voice']);
  if (c.data) kv.push(['DATA', 'the last keyup carried a data burst no decoder here names']);
  if (!c.inSpan) kv.push(['SPAN', 'outside what the radio hears now']);
  if (t) {
    kv.push(['HEARD', `${t.txs} keyups · ${hpDur(t.talkMs)} on the air · ${t.live ? 'on the air now' : hpHeard(now, t.lastMs)}`]);
    if (t.unrecorded) kv.push(['NOT RECORDED', `${t.unrecorded} keyups came while every demodulator was busy`]);
  }
  const conv = s.convs.find(x => x.key === key);
  const ids = conv ? s.rows.filter(r => r.conv === conv.id && r.recorded && !r.live).map(r => r.id) : [];
  const title = gmrsChanTitle(c.hz);
  return `<div class="hp-card cb-card"><div class="hp-ch"><b class="big">${esc(title)}</b><span class="acc">${esc(gmrsSub(c.hz))}</span><button class="chip" data-hpclose="1">CLOSE</button></div>`
    + `<div class="hp-kv">${kv.map(([k, v]) => `<small>${k}</small><span>${esc(v)}</span>`).join('')}</div>`
    + `<div class="hp-acts"><button class="chip ${prefs.hold === key ? 'on' : ''}" data-hpfollow="${key}">${prefs.hold === key ? 'FOLLOWING' : 'FOLLOW'}</button><button class="chip ${prefs.mute.includes(key) ? 'on' : ''}" data-hppref="mute:${key}">${prefs.mute.includes(key) ? 'MUTED' : 'MUTE'}</button><button class="chip ${prefs.prio.includes(key) ? 'on' : ''}" data-hppref="prio:${key}">PRIORITY</button>`
    + (ids.length ? `<button class="chip" data-hpconv="${ids.join(',')}" data-hplabel="${esc(`${title} conversation from ${hpClock(conv!.startMs)}`)}">▶ LAST CONVERSATION</button>` : '') + '</div>'
    + (t && t.stations.length ? `<small class="hp-sth">TALKERS BY THEIR CARRIER · TAP TO NAME</small><div class="hp-sts">${t.stations.map(st => `<button class="hp-st" style="--st:${hpColor(st.color)}" data-hpname="${esc(st.key)}" data-hpcur="${esc(st.label !== st.letter ? st.label : '')}"><b>${esc(st.label)}</b><span>${st.txs} tx · ${st.offsetHz >= 0 ? '+' : ''}${st.offsetHz} Hz</span></button>`).join('')}</div>` : '')
    + (conv ? hpConvHtml(s, conv.id, now, open.has(conv.id), GMRS_NAMER) : '') + '</div>';
}

/** Every callsign heard in a Morse ID, the latest first. */
export function gmrsCallsHtml(s: GmrsSnap | null, now: number): string {
  const calls = s?.calls ?? [];
  if (!calls.length) return '<div class="fl-dim">every callsign sent in Morse is listed here, GMRS ones (WRAB123) and amateur ones; an ID spoken by voice is heard in the recording but not read</div>';
  return calls.map(c => `<div class="hp-log"><span>${hpClock(c.lastMs)}</span><b>${esc(c.call)}</b><span>${c.gmrs ? 'GMRS' : 'AMATEUR'}</span><em>${esc(`${gmrsChanTitle(c.hz)} · heard ${c.count} time${c.count === 1 ? '' : 's'} · ${hpHeard(now, c.lastMs)}`)}</em></div>`).join('');
}

/** Every keyup, newest first: when, the channel, how long, its signaling, its repeater and tones, the callsigns in its ID. */
export function gmrsLogHtml(s: GmrsSnap | null): string {
  const rows = s?.rows.slice(0, 200) ?? [];
  if (!rows.length) return '<div class="fl-dim">every keyup is logged here with its time, channel, length, tone, its repeater when it went through one, and any ID or data it carried</div>';
  return rows.map(r => `<div class="hp-log"><span>${hpClock(r.startMs)}</span><b>${esc(gmrsChanTitle(r.heardHz))}</b><span class="${r.live ? 'ok' : ''}">${r.live ? 'LIVE' : hpDur(r.endMs - r.startMs)}</span>`
    + `<em style="color:${hpColor(r.color)}">${esc([r.ident ? hpIdentLine(r.ident) : r.stationLabel, gmrsMeta(r), r.calls.length ? `CW ID ${r.calls.join(' ')}` : '', r.recorded ? '' : 'NOT RECORDED'].filter(Boolean).join(' · '))}</em></div>`).join('');
}

/** The 24 hours a channel, in the plan's order. */
export function gmrsHeatHtml(s: GmrsSnap | null, band: GmrsBand, now: number): string {
  const heat = s?.heat, order = channelsOf(band).map(c => c.id);
  const rows = (heat?.bands ?? []).map(b => ({ id: b.id.slice(2), slots: b.slots })).filter(b => order.includes(b.id) && b.slots.some(v => v > 0)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (!heat || !rows.length) return '<div class="hp-heat"><div class="fl-dim">each channel\'s busy hours fill in here as the day goes on, kept between sessions</div></div>';
  const d = new Date(now), nowSlot = Math.floor((d.getHours() * 60 + d.getMinutes()) / (1440 / HEAT_SLOTS));
  const html = rows.map(b => {
    const cells = b.slots.map((v, i) => {
      const cover = heat.cover[i];
      if (cover < 1 && v <= 0) return `<i class="none${i === nowSlot ? ' now' : ''}"></i>`;
      const f = cover > 0 ? Math.min(1, v / Math.max(cover, 1) * 4) : 1;
      return `<i class="${i === nowSlot ? 'now' : ''}" style="--f:${(0.08 + 0.92 * f).toFixed(2)}" title="${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')} · ${Math.round(v)} s on the air"></i>`;
    }).join('');
    return `<div class="hp-hr"><small>${band === 'murs' ? `MURS ${b.id.slice(1)}` : `CH ${b.id}`}</small><div class="hp-cells">${cells}</div></div>`;
  }).join('');
  return `<div class="hp-heat">${html}<div class="hp-hx"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}
