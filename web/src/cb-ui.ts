/**
 * CB on the page: the 40-channel board, the channels heard as tiles, a channel's card with its mode and clarifier,
 * and the activity map a row a channel. The live bar, the conversations, the log and the timeline are HAM+'s, named
 * by channel number through [CB_NAMER]. No state of its own beyond what the page passes in.
 */
import { CB_CHANNELS, CB_MODES, cbChannel, cbName, type CbMode } from './dsp/cb/plan.js';
import type { CbSnap, CbChan } from './dsp/cb/engine.js';
import type { HpTile } from './dsp/hamplus/tracker.js';
import { HEAT_SLOTS } from './dsp/hamplus/tracker.js';
import { hpAgo, hpClock, hpColor, hpConvHtml, hpDur, sparkSvg, type HpNamer } from './hamplus-ui.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pill = (text: string, cls = '') => `<em class="hp-pill ${cls}">${esc(text)}</em>`;

/** 27.185 as 27.185: CB frequencies need three decimals, never four. */
export const cbMhz = (hz: number) => (hz / 1e6).toFixed(3);
/** 'CH 19', or the frequency for anything off the plan. */
export const cbTitle = (hz: number) => { const ch = cbChannel(hz); return ch ? `CH ${ch}` : cbMhz(hz); };
/** The second line of a channel: its frequency, and its name when it has one. */
export const cbSub = (hz: number) => { const ch = cbChannel(hz), n = ch ? cbName(ch) : ''; return n ? `${cbMhz(hz)} · ${n}` : cbMhz(hz); };

export const CB_NAMER: HpNamer = {
  chan: cbTitle,
  name: (t: HpTile) => cbSub(t.hz),
  meta: r => r.mode ?? '',
  waiting: hold => cbTitle(Number(hold)),
};

/** The steady carrier on a channel, as the screen says it: measured, so it names its level and how long it held. */
export function cbSteadyText(c: CbChan): string {
  const mins = Math.floor(c.steadyMs / 60_000), held = mins >= 1 ? `${mins} min` : `${Math.max(1, Math.round(c.steadyMs / 1000))} s`;
  return `steady carrier +${c.lineDb} dB, no voice, ${held}${c.steadyPct ? ` · on ${c.steadyPct}% of the last 10 min` : ''}`;
}

/** The counters and the span, and the demodulators in use against what the device keeps up with. */
export function cbHeadHtml(s: CbSnap | null, note = ''): string {
  const tiles = s?.tiles ?? [], onAir = s?.stats.onAir ?? 0, steady = s?.chans.filter(c => c.steady).length ?? 0;
  const inSpan = s?.chans.filter(c => c.inSpan).length ?? 0;
  const cell = (n: string | number, l: string, on = false) => `<div class="${on ? 'on' : ''}"><b>${n}</b><small>${l}</small></div>`;
  return `<div class="hp-hl"><b>CB RADIO</b><span>26.965–27.405 MHz${s && s.rate && inSpan < 40 ? ` · ${inSpan} of 40 channels in the span` : ' · all 40 channels'}</span>${note ? `<span class="hp-scan">${esc(note)}</span>` : ''}</div>`
    + `<div class="hp-stats">${cell(tiles.length, 'HEARD')}${cell(onAir, 'ON AIR', onAir > 0)}${cell(s?.stats.stations ?? 0, 'TALKERS')}${cell(s?.convs.length ?? 0, 'CONVOS')}${cell(steady, 'CARRIERS')}${cell(Math.floor((s?.stats.clipS ?? 0) / 60), 'MIN KEPT')}</div>`
    + (s ? `<div class="hp-cost">demodulating ${s.stats.probes} now · this device keeps up with ${s.stats.cap} at once${s.stats.costMs > 0 ? ` (${Math.round(s.stats.costMs)} ms a channel a second)` : ''} · time machine ${s.stats.clipMB} of ${s.stats.capMB} MB</div>` : '');
}

/** What is heard: ALL or the one channel followed, and MIX or NEWEST. */
export function cbListenHtml(hold: string, mode: 'mix' | 'newest'): string {
  const on = !!hold;
  return `<div class="fl-listen ${on ? 'on' : ''}"><small>${on ? 'FOLLOWING' : 'HEARING'}</small><b>${on ? cbTitle(Number(hold)) : 'ALL'}</b><span>${on ? 'only this channel is heard' : mode === 'mix' ? 'every channel at once' : 'the newest to key up'}</span>${on ? '<button class="chip" data-hpfollow="">ALL</button>' : ''}</div>`
    + `<div class="seg hp-mode"><button data-hpmode="mix" class="${mode === 'mix' ? 'on' : ''}">MIX</button><button data-hpmode="newest" class="${mode === 'newest' ? 'on' : ''}">NEWEST</button></div>`;
}

/**
 * The 40 channels in their order, a cell each: the number, the frequency, and what is on it now (on the air and in
 * which mode, a steady carrier, heard a while ago). Channel 9 and 19 are marked. A tap opens the channel's card.
 */
export function cbBoardHtml(s: CbSnap | null, now: number, hold: string, sel: string): string {
  const chans = s?.chans ?? CB_CHANNELS.map((hz, i) => ({ ch: i + 1, hz, key: String(hz), inSpan: true, open: false, mode: 'AM', measured: '', override: '', clarHz: 0, voiceDb: 0, sigDb: 0, lineDb: 0, steadyMs: 0, steadyPct: 0, steady: false } as CbChan));
  const cells = chans.map(c => {
    const t = s?.tiles.find(x => x.key === c.key), playing = s?.playing.includes(c.key);
    const recent = t && !t.live && now - t.lastMs < 600_000;
    const st = c.open ? `<span class="on">${esc(c.mode)}</span>` : c.steady ? '<span class="cr">CARRIER</span>' : recent ? `<span>${esc(hpAgo(now - t!.lastMs))}</span>` : c.override ? `<span>${esc(c.override)}</span>` : '<span>&nbsp;</span>';
    const mark = c.ch === 9 ? 'em' : c.ch === 19 ? 'hw' : '';
    const cls = ['cb-cell', c.open ? 'live' : '', c.steady ? 'steady' : '', recent ? 'recent' : '', mark, hold === c.key ? 'fol' : '', sel === c.key ? 'sel' : '', c.inSpan ? '' : 'off'].filter(Boolean).join(' ');
    const title = `channel ${c.ch}, ${cbMhz(c.hz)} MHz${cbName(c.ch) ? `, ${cbName(c.ch).toLowerCase()}` : ''}${c.steady ? `, ${cbSteadyText(c)}` : ''}`;
    return `<button class="${cls}" data-hpinfo="${c.key}" title="${esc(title)}" aria-label="${esc(title)}"><b>${c.ch}${playing ? '<i class="hp-note">♪</i>' : ''}</b><small>${cbMhz(c.hz)}</small>${st}${mark ? `<u>${c.ch === 9 ? 'EMERG' : 'HWY'}</u>` : ''}</button>`;
  }).join('');
  const steady = chans.filter(c => c.steady).length;
  const foot = steady ? `<div class="cb-foot">${steady} channel${steady === 1 ? ' holds' : 's hold'} a steady carrier with no voice and stay${steady === 1 ? 's' : ''} closed · a voice under one still opens it</div>` : '';
  return `<div class="cb-board">${cells}</div>${foot}`;
}

/** The channels heard, live first: the number, the frequency and name, the mode, the airtime. A tap follows one, the i opens its card. */
export function cbTilesHtml(s: CbSnap | null, now: number, hold: string, emptyHtml: string): string {
  const tiles = s?.tiles ?? [];
  const all = `<div class="fl-tile all hp-tile ${hold ? '' : 'fol'}" role="button" data-hpfollow=""><b>ALL</b><small>EVERY CHANNEL</small><span>${hold ? 'tap to hear them all' : `hearing all ${tiles.length}`}</span></div>`;
  return `<div class="fl-tilegrid hp-grid">${all}${tiles.map(t => {
    const c = s!.chans.find(x => x.key === t.key), ch = cbChannel(t.hz), playing = s?.playing.includes(t.key);
    const mode = c ? (c.override ? `${c.override} (SET)` : c.mode) : '';
    const badges = [ch === 9 ? pill('EMERGENCY', 'bad') : '', ch === 19 ? pill('HIGHWAY', 'warm') : '', c && c.lineDb && !c.open ? pill(`STEADY CARRIER +${c.lineDb} dB`) : '',
      t.followed ? pill('FOLLOWING', 'acc') : '', t.prio ? pill('PRIORITY', 'warm') : '', t.muted ? pill('MUTED') : '', t.unrecorded ? pill(`${t.unrecorded} NOT RECORDED`, 'bad') : ''].join('');
    return `<div class="fl-tile hp-tile cb-tile ${t.live ? 'live' : ''} ${t.followed ? 'fol' : ''} ${t.muted ? 'muted' : ''} ${t.prio ? 'prio' : ''}" role="button" data-hpfollow="${t.key}">`
      + `<b>${esc(cbTitle(t.hz))}${playing ? '<i class="hp-note">♪</i>' : ''}</b><small>${esc(cbSub(t.hz))}</small>`
      + (mode ? `<span class="hp-line">${esc(mode)}</span>` : '')
      + (t.live ? `<span class="hp-air">ON AIR ${hpDur(t.openMs)}<span class="fl-vu"><span><i style="width:${Math.max(5, Math.min(100, t.snrDb * 2.5)).toFixed(0)}%"></i></span></span></span>` : `<span>${hpAgo(now - t.lastMs)} · ${t.txs} tx · ${hpDur(t.talkMs)}</span>`)
      + sparkSvg(t.spark, t.live) + (badges ? `<div class="hp-badges">${badges}</div>` : '')
      + `<button class="fl-ti" data-hpinfo="${t.key}" title="details" aria-label="details">i</button></div>`;
  }).join('')}</div>${tiles.length ? '' : emptyHtml}`;
}

/** The clarifier steps a tap moves it by, and how far it goes either way (Hz). */
export const CB_CLAR_STEP = 50, CB_CLAR_MAX = 1_500;

/**
 * A channel's card: its number, frequency and name, the mode (AUTO or set by hand) and for SSB the clarifier, what is
 * on it now (a steady carrier measured), follow / mute / priority, its talkers and its last conversation.
 */
export function cbCardHtml(s: CbSnap, key: string, now: number, prefs: { hold: string; mute: string[]; prio: string[] }, open: Set<number>): string {
  const c = s.chans.find(x => x.key === key); if (!c) return '';
  const t = s.tiles.find(x => x.key === key);
  const kv: [string, string][] = [['FREQUENCY', `${cbMhz(c.hz)} MHz`]];
  if (cbName(c.ch)) kv.push(['USE', c.ch === 9 ? 'emergencies and help to travelers' : c.ch === 19 ? 'highway traffic' : c.ch === 38 ? 'single sideband calling, LSB' : 'single sideband']);
  kv.push(['MODE', c.override ? `${c.override}, set by hand` : c.open && c.measured ? `${c.measured}, measured on this transmission` : `${c.mode}, chosen on each transmission`]);
  if (c.open) kv.push(['ON IT NOW', `${c.mode} on the air, voice ${c.voiceDb.toFixed(0)} dB over the quiet channels${c.lineDb ? `, under a steady carrier +${c.lineDb} dB` : ''}`]);
  else if (c.lineDb) kv.push(['ON IT NOW', cbSteadyText(c)]);
  if (!c.inSpan) kv.push(['SPAN', 'outside what the radio hears now']);
  if (t) {
    kv.push(['HEARD', `${t.txs} transmissions · ${hpDur(t.talkMs)} on the air · ${t.live ? 'on the air now' : hpAgo(now - t.lastMs)}`]);
    if (t.unrecorded) kv.push(['NOT RECORDED', `${t.unrecorded} transmissions came while every demodulator was busy`]);
  }
  const conv = s.convs.find(x => x.key === key);
  const ids = conv ? s.rows.filter(r => r.conv === conv.id && r.recorded && !r.live).map(r => r.id) : [];
  const modes = (['', ...CB_MODES] as (CbMode | '')[]).map(m => `<button data-cbmode="${key}:${m}" class="${c.override === m ? 'on' : ''}">${m || 'AUTO'}</button>`).join('');
  const ssb = c.override === 'USB' || c.override === 'LSB' || (!c.override && (c.mode === 'USB' || c.mode === 'LSB'));
  const clar = ssb ? `<div class="ctlrow cb-clar"><span class="rl">CLARIFIER</span><button class="chip" data-cbclar="${key}:-${CB_CLAR_STEP}" aria-label="clarifier down">−</button><b>${c.clarHz > 0 ? '+' : ''}${c.clarHz} Hz</b><button class="chip" data-cbclar="${key}:${CB_CLAR_STEP}" aria-label="clarifier up">+</button>${c.clarHz ? `<button class="chip" data-cbclar="${key}:0">CENTER</button>` : ''}</div>` : '';
  return `<div class="hp-card cb-card"><div class="hp-ch"><b class="big">CH ${c.ch}</b><span class="acc">${esc(cbSub(c.hz))}</span><button class="chip" data-hpclose="1">CLOSE</button></div>`
    + `<div class="hp-kv">${kv.map(([k, v]) => `<small>${k}</small><span>${esc(v)}</span>`).join('')}</div>`
    + `<div class="ctlrow cb-modes"><span class="rl">MODE</span><div class="seg">${modes}</div></div>${clar}`
    + `<div class="hp-acts"><button class="chip ${prefs.hold === key ? 'on' : ''}" data-hpfollow="${key}">${prefs.hold === key ? 'FOLLOWING' : 'FOLLOW'}</button><button class="chip ${prefs.mute.includes(key) ? 'on' : ''}" data-hppref="mute:${key}">${prefs.mute.includes(key) ? 'MUTED' : 'MUTE'}</button><button class="chip ${prefs.prio.includes(key) ? 'on' : ''}" data-hppref="prio:${key}">PRIORITY</button>`
    + (ids.length ? `<button class="chip" data-hpconv="${ids.join(',')}" data-hplabel="${esc(`CH ${c.ch} conversation from ${hpClock(conv!.startMs)}`)}">▶ LAST CONVERSATION</button>` : '') + '</div>'
    + (t && t.stations.length ? `<small class="hp-sth">TALKERS BY THEIR CARRIER · TAP TO NAME</small><div class="hp-sts">${t.stations.map(st => `<button class="hp-st" style="--st:${hpColor(st.color)}" data-hpname="${esc(st.key)}" data-hpcur="${esc(st.label !== st.letter ? st.label : '')}"><b>${esc(st.label)}</b><span>${st.txs} tx · ${st.offsetHz >= 0 ? '+' : ''}${st.offsetHz} Hz</span></button>`).join('')}</div>` : '')
    + (conv ? hpConvHtml(s, conv.id, now, open.has(conv.id), CB_NAMER) : '') + '</div>';
}

/** The 24 hours a channel: a quarter hour a cell, brighter the more of it was on the air; never listened stays a dot. Skip shows here. */
export function cbHeatHtml(s: CbSnap | null, now: number): string {
  const heat = s?.heat;
  const rows = (heat?.bands ?? []).filter(b => b.slots.some(v => v > 0)).map(b => ({ ch: Number(b.id.slice(2)), slots: b.slots })).filter(b => b.ch > 0).sort((a, b) => a.ch - b.ch);
  if (!heat || !rows.length) return '<div class="hp-heat"><div class="fl-dim">each channel\'s busy hours fill in here as the day goes on, kept between sessions, so a band opening for skip shows up</div></div>';
  const d = new Date(now), nowSlot = Math.floor((d.getHours() * 60 + d.getMinutes()) / (1440 / HEAT_SLOTS));
  const html = rows.map(b => {
    const cells = b.slots.map((v, i) => {
      const cover = heat.cover[i];
      if (cover < 1 && v <= 0) return `<i class="none${i === nowSlot ? ' now' : ''}"></i>`;
      const f = cover > 0 ? Math.min(1, v / Math.max(cover, 1) * 4) : 1;
      return `<i class="${i === nowSlot ? 'now' : ''}" style="--f:${(0.08 + 0.92 * f).toFixed(2)}" title="${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')} · ${Math.round(v)} s on the air"></i>`;
    }).join('');
    return `<div class="hp-hr"><small>CH ${b.ch}</small><div class="hp-cells">${cells}</div></div>`;
  }).join('');
  return `<div class="hp-heat">${html}<div class="hp-hx"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}
