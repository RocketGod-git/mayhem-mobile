/**
 * HAM+ on the page: the channel tiles, the live bar, the conversations as threads, the band timeline, the 24-hour
 * activity map and the log, built from the receiver's snapshot. No state of its own beyond what the page passes in.
 */
import { HP_BANDS, hpBandOf } from './dsp/hamplus/plan.js';
import type { HpSnap } from './dsp/hamplus/engine.js';
import type { HpTile, HpTxRow } from './dsp/hamplus/tracker.js';
import { HEAT_SLOTS, cwCallsign } from './dsp/hamplus/tracker.js';

/** A station's color, by its letter (A is 0): the same color everywhere it shows. */
export const HP_COLORS = ['#4C8DFF', '#FFAF00', '#3DDC84', '#FF5BD2', '#00D5FF', '#FF7A45', '#B18CFF', '#E8E14A', '#FF5B52', '#52FFB8'];
export const hpColor = (i: number) => i < 0 ? 'var(--muted)' : HP_COLORS[i % HP_COLORS.length];
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** 146.52 as 146.520, 442.0125 as 442.0125: at least three decimals, a fourth only when it is there. */
export function hpMhz(hz: number): string { const s = (hz / 1e6).toFixed(4); return s.endsWith('0') ? s.slice(0, -1) : s; }
export function hpDur(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  return t < 3600 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
export const hpAgo = (ms: number) => ms < 2_000 ? 'now' : ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
export const hpClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
export const hpTone = (tone: number, dcs: number) => tone > 0 ? `PL ${tone.toFixed(1)}` : dcs > 0 ? `DCS ${String(dcs).padStart(3, '0')}` : '';
/** A tile's name: the CW ID callsign, else the band plan's name for the frequency, else what kind of channel it is. */
export const hpName = (t: HpTile) => t.callsign || t.label || t.kind || (hpBandOf(t.hz) ? `${hpBandOf(t.hz)!.name.toUpperCase()} FM` : '');
const pill = (text: string, cls = '') => `<em class="hp-pill ${cls}">${esc(text)}</em>`;

export const HP_SPAN_MS = 600_000;

/** The counters, the span and the scan, and the demodulators in use against what the device keeps up with. */
export function hpHeadHtml(s: HpSnap | null, scan: string): string {
  const c = s?.centerHz ?? 0, band = hpBandOf(c) ?? HP_BANDS.find(b => c >= b.lo - 4e6 && c <= b.hi + 4e6);
  const tiles = s?.tiles ?? [], onAir = s?.stats.onAir ?? 0, nets = tiles.filter(t => t.net).length;
  const cell = (n: string | number, l: string, on = false) => `<div class="${on ? 'on' : ''}"><b>${n}</b><small>${l}</small></div>`;
  return `<div class="hp-hl"><b>${band ? esc(band.name.toUpperCase()) : ''}</b>${s && s.rate ? `<span>${(s.spanLo / 1e6).toFixed(3)}–${(s.spanHi / 1e6).toFixed(3)} MHz</span>` : ''}<span class="hp-scan">${esc(scan)}</span></div>`
    + `<div class="hp-stats">${cell(tiles.length, 'CHANNELS')}${cell(onAir, 'ON AIR', onAir > 0)}${cell(s?.stats.stations ?? 0, 'STATIONS')}${cell(s?.convs.length ?? 0, 'CONVOS')}${cell(nets, 'NETS')}${cell(Math.floor((s?.stats.clipS ?? 0) / 60), 'MIN KEPT')}</div>`
    + (s ? `<div class="hp-cost">demodulating ${s.stats.probes} now · this device keeps up with ${s.stats.cap} at once${s.stats.costMs > 0 ? ` (${Math.round(s.stats.costMs)} ms a channel a second)` : ''} · time machine ${s.stats.clipMB} of ${s.stats.capMB} MB</div>` : '');
}

/** What is heard: ALL or the one followed, and MIX or NEWEST. */
export function hpListenHtml(hold: string, mode: 'mix' | 'newest'): string {
  const on = !!hold;
  return `<div class="fl-listen ${on ? 'on' : ''}"><small>${on ? 'FOLLOWING' : 'HEARING'}</small><b>${on ? hpMhz(Number(hold)) : 'ALL'}</b><span>${on ? 'only this channel is heard' : mode === 'mix' ? 'every channel at once' : 'the newest to key up'}</span>${on ? '<button class="chip" data-hpfollow="">ALL</button>' : ''}</div>`
    + `<div class="seg hp-mode"><button data-hpmode="mix" class="${mode === 'mix' ? 'on' : ''}">MIX</button><button data-hpmode="newest" class="${mode === 'newest' ? 'on' : ''}">NEWEST</button></div>`;
}

/** The live bar: a replay (with STOP), else a short note (a tap with nothing to replay), else what is heard right now, else LISTENING. Always one height. */
export function hpLiveHtml(s: HpSnap | null, now: number, audioOn: boolean, hold: string, note = ''): { cls: string; html: string; col: string } {
  const rp = s?.replay;
  if (note && !rp?.active) return { cls: 'on note', col: 'var(--accent2)', html: `<div class="hp-lb1"><span class="fl-np-l">REPLAY</span><b>${esc(note)}</b></div><div class="hp-lb2"><span class="hp-lbt">a transmission can be replayed as soon as it ends</span></div>` };
  if (rp?.active) {
    const f = Math.min(100, 100 * rp.pos / Math.max(0.1, rp.total));
    return { cls: 'on replay', col: 'var(--accent2)', html: `<div class="hp-lb1"><span class="fl-np-l"><i></i>REPLAYING</span><b>${esc(rp.label)}</b><button class="chip on" data-hpstop="1">STOP</button></div>`
      + `<div class="hp-lb2"><span class="fl-vu"><span><i style="width:${f.toFixed(0)}%"></i></span></span><span class="hp-lbt">${hpDur(rp.pos * 1000)} / ${hpDur(rp.total * 1000)}</span></div>` };
  }
  const heard = s && audioOn ? s.rows.filter(r => r.live && s.playing.includes(String(r.hz))) : [];
  const r = heard.sort((a, b) => b.startMs - a.startMs)[0];
  if (!r) return { cls: '', col: 'var(--line)', html: `<div class="hp-lb1"><span class="fl-np-l">LISTENING</span></div><div class="hp-lb2"><span class="hp-lbt">${!audioOn ? 'audio is off · every channel is still recorded' : hold ? `waiting for ${hpMhz(Number(hold))} MHz to key up` : 'nothing on the air · every channel is heard the moment it keys up'}</span></div>` };
  const t = s!.tiles.find(x => x.hz === r.hz);
  const who = [t ? hpName(t) : '', r.stationLabel ? `${r.stationLabel} talking` : '', heard.length > 1 ? `+${heard.length - 1} more` : ''].filter(Boolean).join(' · ');
  const meta = [hpTone(r.tone, r.dcs), r.direct ? 'HEARD DIRECT, NEARBY' : '', t?.kind === 'REPEATER' && t.offset ? `REPEATER ${t.offset}` : ''].filter(Boolean).join(' · ');
  const lvl = Math.max(5, Math.min(100, r.peakDb * 2.5));
  return { cls: 'on', col: r.color >= 0 ? hpColor(r.color) : 'var(--ok)', html: `<div class="hp-lb1"><span class="fl-np-l"><i></i>NOW PLAYING</span><b>${hpMhz(r.hz)}</b><span class="hp-lbw">${esc(who)}</span><span class="fl-np-d">${hpDur(now - r.startMs)}</span></div>`
    + `<div class="hp-lb2"><span class="hp-lbt">${esc(meta)}</span><span class="fl-vu"><span><i style="width:${lvl.toFixed(0)}%"></i></span></span></div>` };
}

/** A sparkline of seconds on the air each minute, the last 30 minutes, newest on the right. */
function sparkSvg(spark: number[], live: boolean): string {
  const n = Math.max(1, spark.length), top = Math.max(10, ...spark);
  let r = '';
  spark.forEach((v, i) => { if (v > 0) { const h = Math.max(2, 14 * Math.min(1, v / top)); r += `<rect x="${(i * 100 / n + 0.3).toFixed(2)}" y="${(14 - h).toFixed(1)}" width="${(100 / n - 0.6).toFixed(2)}" height="${h.toFixed(1)}" opacity="${(0.45 + 0.55 * i / n).toFixed(2)}"/>`; } });
  return `<svg class="hp-spark ${live ? 'live' : ''}" viewBox="0 0 100 14" preserveAspectRatio="none"><line x1="0" y1="13.6" x2="100" y2="13.6"/>${r}</svg>`;
}

/** The channel tiles: ALL first, then every channel heard (live first). A tap follows one, the i opens its card. */
export function hpTilesHtml(s: HpSnap | null, now: number, hold: string, emptyHtml: string): string {
  const tiles = s?.tiles ?? [];
  const all = `<div class="fl-tile all hp-tile ${hold ? '' : 'fol'}" role="button" data-hpfollow=""><b>ALL</b><small>EVERY CHANNEL</small><span>${hold ? 'tap to hear them all' : `hearing all ${tiles.length}`}</span></div>`;
  return `<div class="fl-tilegrid hp-grid">${all}${tiles.map(t => {
    const playing = s?.playing.includes(t.key);
    const line = [hpTone(t.tone, t.dcs), t.kind === 'REPEATER' || t.use === 'output' ? t.offset : ''].filter(Boolean).join(' · ');
    const badges = [t.net ? pill(`NET · ${t.net.control}`, 'acc') : '', t.link ? pill(`LINKED ${t.link}`, 'warm') : '', t.inputHz && now - t.nearMs < 600_000 ? pill('NEARBY', 'ok') : '',
      t.followed ? pill('FOLLOWING', 'acc') : '', t.prio ? pill('PRIORITY', 'warm') : '', t.muted ? pill('MUTED') : '', t.unrecorded ? pill(`${t.unrecorded} NOT RECORDED`, 'bad') : ''].join('');
    return `<div class="fl-tile hp-tile ${t.live ? 'live' : ''} ${t.followed ? 'fol' : ''} ${t.muted ? 'muted' : ''} ${t.prio ? 'prio' : ''}" role="button" data-hpfollow="${t.key}">`
      + `<b>${hpMhz(t.hz)}${playing ? '<i class="hp-note">♪</i>' : ''}</b><small class="${t.callsign ? 'call' : ''}">${esc(hpName(t))}</small>`
      + (line ? `<span class="hp-line">${esc(line)}</span>` : '')
      + (t.live ? `<span class="hp-air">ON AIR ${hpDur(t.openMs)}<span class="fl-vu"><span><i style="width:${Math.max(5, Math.min(100, t.snrDb * 2.5)).toFixed(0)}%"></i></span></span></span>` : `<span>${hpAgo(now - t.lastMs)} · ${t.txs} tx · ${hpDur(t.talkMs)}</span>`)
      + sparkSvg(t.spark, t.live) + (badges ? `<div class="hp-badges">${badges}</div>` : '')
      + `<button class="fl-ti" data-hpinfo="${t.key}" title="details" aria-label="details">i</button></div>`;
  }).join('')}</div>${tiles.length ? '' : emptyHtml}`;
}

/** One transmission as a chat bubble: the first talker on the left, the others on the right, each in its own color. */
function bubbleHtml(r: HpTxRow, side: number, repeater: boolean, now: number): string {
  const c = r.color >= 0 ? hpColor(r.color) : 'var(--ink)';
  const who = r.stationLabel || (repeater ? 'VIA REPEATER' : 'UNKNOWN');
  const meta = [hpClock(r.startMs), hpTone(r.tone, r.dcs), Number.isFinite(r.offsetHz) ? `${r.offsetHz >= 0 ? '+' : ''}${Math.round(r.offsetHz)} Hz` : '', r.direct ? 'NEARBY' : '', cwCallsign(r.cw) ? `CW ID ${cwCallsign(r.cw)}` : '', r.recorded ? '' : 'NOT RECORDED'].filter(Boolean).join(' · ');
  const play = r.recorded && !r.live;
  return `<div class="hp-bub ${side > 0 ? 'r' : ''} ${r.live ? 'live' : ''} ${play ? 'tap' : ''}" style="--st:${c}" ${play ? `data-hpplay="${r.id}" data-hplabel="${esc(`${hpMhz(r.hz)} at ${hpClock(r.startMs)}`)}"` : ''}>`
    + `<div><b ${r.station ? `data-hpname="${esc(r.station)}" data-hpcur="${esc(r.stationLabel.length > 1 ? r.stationLabel : '')}"` : ''}>${esc(who)}</b><span class="${r.live ? 'ok' : ''}">${r.live ? `TALKING ${hpDur(now - r.startMs)}` : hpDur(r.endMs - r.startMs)}</span>${play ? '<i>▶</i>' : ''}</div>`
    + `<small>${esc(meta)}</small></div>`;
}

/** A conversation: its channel and name, NET when it is one, replay of all of it, and the last bubbles (or all). */
export function hpConvHtml(s: HpSnap, convId: number, now: number, all: boolean): string {
  const c = s.convs.find(x => x.id === convId); if (!c) return '';
  const rows = s.rows.filter(r => r.conv === convId).sort((a, b) => a.startMs - b.startMs);
  const t = s.tiles.find(x => x.hz === c.hz), rep = t?.kind === 'REPEATER';
  const shown = all ? rows : rows.slice(-8);
  const order = [...new Set(rows.map(r => r.station).filter(Boolean))];
  const ids = rows.filter(r => r.recorded && !r.live).map(r => r.id);
  return `<div class="hp-conv ${c.live ? 'live' : ''}"><div class="hp-ch"><b>${hpMhz(c.hz)}</b><span class="${c.live ? 'ok' : ''}">${esc([t ? hpName(t) : '', c.live ? 'ON THE AIR' : hpAgo(now - c.endMs)].filter(Boolean).join(' · '))}</span>${c.net ? pill('NET', 'acc') : ''}`
    + (ids.length ? `<button class="chip" data-hpconv="${ids.join(',')}" data-hplabel="${esc(`${hpMhz(c.hz)} conversation from ${hpClock(c.startMs)}`)}">▶ ${hpDur(c.talkMs)}</button>` : '') + '</div>'
    + (rows.length > shown.length ? `<button class="hp-more" data-hpall="${convId}">${rows.length - shown.length} earlier · show all</button>` : '')
    + shown.map(r => bubbleHtml(r, order.indexOf(r.station), rep, now)).join('') + '</div>';
}
export function hpConvsHtml(s: HpSnap | null, now: number, open: Set<number>, max: number): string {
  if (!s || !s.convs.length) return '<div class="fl-dim">conversations show here as a thread, a bubble per talker, each radio told apart by its own carrier</div>';
  return s.convs.slice(0, max).map(c => hpConvHtml(s, c.id, now, open.has(c.id))).join('');
}

/** The 24 hours per band: a quarter hour a cell, brighter the more of it was on the air; never listened stays a dot. */
export function hpHeatHtml(s: HpSnap | null, now: number): string {
  const heat = s?.heat;
  const bands = HP_BANDS.filter(b => heat?.bands.some(x => x.id === b.id && x.slots.some(v => v > 0)));
  if (!heat || !bands.length) return '<div class="hp-heat"><div class="fl-dim">each band\'s busy hours fill in here as the day goes on, kept between sessions</div></div>';
  const d = new Date(now), nowSlot = Math.floor((d.getHours() * 60 + d.getMinutes()) / (1440 / HEAT_SLOTS));
  const rows = bands.map(b => {
    const slots = heat.bands.find(x => x.id === b.id)!.slots;
    const cells = slots.map((v, i) => {
      const cover = heat.cover[i];
      if (cover < 1 && v <= 0) return `<i class="none${i === nowSlot ? ' now' : ''}"></i>`;
      const f = cover > 0 ? Math.min(1, v / Math.max(cover, 1) * 4) : 1;
      return `<i class="${i === nowSlot ? 'now' : ''}" style="--f:${(0.08 + 0.92 * f).toFixed(2)}" title="${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')} · ${Math.round(v)} s on the air"></i>`;
    }).join('');
    return `<div class="hp-hr"><small>${esc(b.name.toUpperCase())}</small><div class="hp-cells">${cells}</div></div>`;
  }).join('');
  return `<div class="hp-heat">${rows}<div class="hp-hx"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}

/** Every transmission, newest first. */
export function hpLogHtml(s: HpSnap | null): string {
  const rows = s?.rows.slice(0, 200) ?? [];
  if (!rows.length) return '<div class="fl-dim">every transmission is logged here with its time, channel, length, tone and carrier offset</div>';
  return rows.map(r => `<div class="hp-log"><span>${hpClock(r.startMs)}</span><b>${hpMhz(r.hz)}</b><span class="${r.live ? 'ok' : ''}">${r.live ? 'LIVE' : hpDur(r.endMs - r.startMs)}</span>`
    + `<em style="color:${hpColor(r.color)}">${esc([r.stationLabel, hpTone(r.tone, r.dcs), Number.isFinite(r.offsetHz) ? `${r.offsetHz >= 0 ? '+' : ''}${Math.round(r.offsetHz)} Hz` : '', r.recorded ? '' : 'NOT RECORDED'].filter(Boolean).join(' · '))}</em></div>`).join('');
}

/** A channel's card: what it is known by, follow / mute / priority, its stations (tap to name) and its last conversation. */
export function hpCardHtml(s: HpSnap, key: string, now: number, prefs: { hold: string; mute: string[]; prio: string[] }, open: Set<number>): string {
  const t = s.tiles.find(x => x.key === key); if (!t) return '';
  const kv: [string, string][] = [];
  if (t.label) kv.push(['BAND PLAN', t.label]);
  if (t.kind) kv.push(['KIND', t.kind]);
  if (t.inputHz) kv.push(['INPUT', `${hpMhz(t.inputHz)} MHz heard, talkers there are nearby`]); else if (t.offset) kv.push(['OFFSET', `${t.offset} (band plan)`]);
  if (hpTone(t.tone, t.dcs)) kv.push(['TONE', hpTone(t.tone, t.dcs)]);
  kv.push(['HEARD', `${t.txs} transmissions · ${hpDur(t.talkMs)} on the air · ${t.live ? 'on the air now' : hpAgo(now - t.lastMs)}`]);
  if (t.net) kv.push(['NET', `net control ${t.net.control}, ${t.net.checkins} check-ins`]);
  if (t.link) kv.push(['LINKED', s.tiles.filter(x => x.link === t.link && x.key !== t.key).map(x => hpMhz(x.hz)).join(', ') || `network ${t.link}`]);
  if (t.unrecorded) kv.push(['NOT RECORDED', `${t.unrecorded} transmissions came while every demodulator was busy`]);
  const conv = s.convs.find(c => c.hz === t.hz);
  const ids = conv ? s.rows.filter(r => r.conv === conv.id && r.recorded && !r.live).map(r => r.id) : [];
  return `<div class="hp-card"><div class="hp-ch"><b class="big">${hpMhz(t.hz)}</b><span class="acc">${esc(hpName(t))}</span><button class="chip" data-hpclose="1">CLOSE</button></div>`
    + `<div class="hp-kv">${kv.map(([k, v]) => `<small>${k}</small><span>${esc(v)}</span>`).join('')}</div>`
    + `<div class="hp-acts"><button class="chip ${prefs.hold === key ? 'on' : ''}" data-hpfollow="${key}">${prefs.hold === key ? 'FOLLOWING' : 'FOLLOW'}</button><button class="chip ${prefs.mute.includes(key) ? 'on' : ''}" data-hppref="mute:${key}">${prefs.mute.includes(key) ? 'MUTED' : 'MUTE'}</button><button class="chip ${prefs.prio.includes(key) ? 'on' : ''}" data-hppref="prio:${key}">PRIORITY</button>`
    + (ids.length ? `<button class="chip" data-hpconv="${ids.join(',')}" data-hplabel="${esc(`${hpMhz(t.hz)} conversation from ${hpClock(conv!.startMs)}`)}">▶ LAST CONVERSATION</button>` : '') + '</div>'
    + (t.stations.length ? `<small class="hp-sth">${t.kind === 'REPEATER' ? 'TALKERS HEARD ON THE INPUT · TAP TO NAME' : 'STATIONS BY THEIR CARRIER · TAP TO NAME'}</small><div class="hp-sts">${t.stations.map(st => `<button class="hp-st" style="--st:${hpColor(st.color)}" data-hpname="${esc(st.key)}" data-hpcur="${esc(st.label !== st.letter && st.label !== st.callsign ? st.label : '')}"><b>${esc(st.label)}</b><span>${st.txs} tx · ${st.offsetHz >= 0 ? '+' : ''}${st.offsetHz} Hz</span></button>`).join('')}</div>` : '')
    + (conv ? hpConvHtml(s, conv.id, now, open.has(conv.id)) : '') + '</div>';
}

/** The transmission on lane [hz] nearest [ms], when it is within [tolMs] of its bar; else none (the tap is on empty time). */
export function hpTapTx(rows: HpTxRow[], hz: number, ms: number, now: number, tolMs: number): HpTxRow | undefined {
  let best: HpTxRow | undefined, bd = Infinity;
  for (const r of rows) {
    if (r.hz !== hz) continue;
    const e = r.live ? now : r.endMs, d = ms < r.startMs ? r.startMs - ms : ms > e ? ms - e : 0;
    if (d <= tolMs && d < bd) { bd = d; best = r; }
  }
  return best;
}

/** The lanes the timeline draws: channels heard in the window, the most recently active first, at most [max]. */
export function hpLanes(s: HpSnap | null, now: number, max: number): { lanes: number[]; rows: HpTxRow[]; t0: number; span: number } {
  const first = Math.min(...(s?.rows ?? []).filter(r => r.live || r.endMs > now - HP_SPAN_MS).map(r => r.startMs), now);
  const quiet = !(s?.rows ?? []).some(r => r.live || r.endMs > now - HP_SPAN_MS);
  const span = quiet ? HP_SPAN_MS : Math.min(HP_SPAN_MS, Math.max(120_000, now - first + 10_000)), t0 = now - span;
  const rows = (s?.rows ?? []).filter(r => r.live || r.endMs > t0);
  const last = new Map<number, number>();
  for (const r of rows) last.set(r.hz, Math.max(last.get(r.hz) ?? 0, r.live ? now : r.endMs));
  const lanes = [...last.keys()].sort((a, b) => last.get(b)! - last.get(a)!).slice(0, max).sort((a, b) => a - b);
  return { lanes, rows, t0, span };
}

/** What the quiet timeline says: the last transmission heard (a tap replays from it), else that nothing was heard yet. */
export function hpQuietText(s: HpSnap | null, now: number): { head: string; sub: string } {
  const last = (s?.rows ?? []).filter(r => !r.live).sort((a, b) => b.endMs - a.endMs)[0];
  if (!last) return { head: 'nothing on the air yet', sub: 'every transmission shows here as it happens' };
  return { head: 'nothing on the air for ten minutes', sub: `last heard ${hpMhz(last.hz)}, ${hpAgo(now - last.endMs)}${last.recorded ? ', tap to replay from there' : ''}` };
}

/** A tap within this many pixels of a transmission's bar replays that transmission. */
export const HP_TAP_PX = 10;

/**
 * The band timeline on a canvas: a lane per channel, each transmission a bar in its talker's color, the live ones
 * growing at the right edge and pulsing, the one replaying outlined. Quiet, it keeps one lane's height on a phone (so
 * the first channel to key up moves nothing) and the grid with a line on what was last heard. Returns what a tap at
 * (x, y) hits.
 */
export function hpPaintTimeline(cv: HTMLCanvasElement, s: HpSnap | null, now: number, max: number, colors: { ink: string; muted: string; line: string; ok: string; accent: string }): (x: number, y: number) => { tx?: HpTxRow; ms: number; hz?: number } {
  const { lanes, rows, t0, span } = hpLanes(s, now, max);
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, labelW = 84, laneH = 24, axis = 16;
  const H = Math.max(1, lanes.length) * laneH + axis;
  if (cv.dataset.fill !== '1') cv.style.height = `${H}px`;
  const HH = cv.dataset.fill === '1' ? (cv.clientHeight || H) : H;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(HH * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(HH * dpr); }
  const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, HH);
  const lh = lanes.length ? Math.min(laneH * 1.6, Math.max(laneH, (HH - axis) / lanes.length)) : laneH;
  const pw = W - labelW - 4, px = (ms: number) => labelW + Math.max(0, Math.min(1, (ms - t0) / span)) * pw;
  g.font = '600 10px ui-monospace, Menlo, Consolas, monospace'; g.textBaseline = 'middle';
  // the big view keeps its grid and axis at the bottom however few channels there are, so it reads as a timeline
  const gridH = lanes.length && cv.dataset.fill !== '1' ? lanes.length * lh : HH - axis;
  for (let m = 0; m <= 10; m++) { const x = labelW + pw * m / 10; g.strokeStyle = colors.line; g.globalAlpha = m % 5 === 0 ? 0.9 : 0.35; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, gridH); g.stroke(); }
  g.globalAlpha = 1;
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin(now / 320));
  const replayClip = s?.replay.active ? s.replay.clip : -1;
  lanes.forEach((h, li) => {
    const y = li * lh, t = s?.tiles.find(x => x.hz === h);
    g.fillStyle = rows.some(r => r.live && r.hz === h) ? colors.ok : colors.ink; g.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(hpMhz(h), 2, y + lh * (t ? 0.36 : 0.5));
    if (t) { g.fillStyle = colors.muted; g.font = '7px ui-monospace, Menlo, Consolas, monospace'; g.fillText(hpName(t).slice(0, 13), 2, y + lh * 0.74); }
    g.strokeStyle = colors.line; g.globalAlpha = 0.3; g.beginPath(); g.moveTo(labelW, y + lh); g.lineTo(W, y + lh); g.stroke(); g.globalAlpha = 1;
    for (const r of rows) {
      if (r.hz !== h) continue;
      const a = px(r.startMs), b = px(r.live ? now : r.endMs), top = y + lh * 0.18, hh = lh * 0.64;
      g.fillStyle = r.color >= 0 ? hpColor(r.color) : colors.accent;
      g.globalAlpha = r.live ? pulse : r.recorded ? 0.85 : 0.35;
      g.beginPath(); g.roundRect(a, top, Math.max(2.5, b - a), hh, 3); g.fill(); g.globalAlpha = 1;
      if (r.id === replayClip) { g.strokeStyle = colors.ink; g.lineWidth = 2; g.beginPath(); g.roundRect(a - 1, top - 1, Math.max(2.5, b - a) + 2, hh + 2, 3); g.stroke(); g.lineWidth = 1; }
      if (r.live) { g.fillStyle = colors.ok; g.beginPath(); g.arc(b, y + lh / 2, lh * 0.12, 0, 2 * Math.PI); g.fill(); }
    }
  });
  if (!lanes.length) {
    const q = hpQuietText(s, now), fit = (t: string, w: number) => { while (t.length > 4 && g.measureText(t).width > w) t = t.slice(0, -2).trimEnd() + '…'; return t; };
    if (cv.dataset.fill === '1') {
      // the big view: two lines in the middle of the grid
      g.textAlign = 'center'; g.fillStyle = colors.ink; g.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(fit(q.head.toUpperCase(), pw - 16), labelW + pw / 2, gridH / 2 - 9);
      g.fillStyle = colors.muted; g.font = '10px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(fit(q.sub, pw - 16), labelW + pw / 2, gridH / 2 + 9); g.textAlign = 'left';
    } else {
      // one lane: QUIET where the frequencies go, the line on what was last heard beside it
      g.fillStyle = colors.muted; g.font = '700 10px ui-monospace, Menlo, Consolas, monospace'; g.fillText('QUIET', 2, lh / 2);
      g.font = '10px ui-monospace, Menlo, Consolas, monospace'; g.fillStyle = colors.ink; g.fillText(fit(q.sub, pw - 12), labelW + 6, lh / 2);
    }
  }
  g.strokeStyle = colors.muted; g.lineWidth = 2; g.beginPath(); g.moveTo(W - 5, 0); g.lineTo(W - 5, gridH); g.stroke(); g.lineWidth = 1;
  const mins = Math.round(span / 60_000);
  g.fillStyle = colors.muted; g.font = '9px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'left'; g.fillText(`−${mins} min`, labelW, gridH + axis / 2 + 2);
  g.textAlign = 'center'; g.fillText(`−${mins % 2 ? (mins / 2).toFixed(1) : mins / 2} min`, labelW + pw / 2, gridH + axis / 2 + 2);
  g.textAlign = 'right'; g.fillText('now', W - 5, gridH + axis / 2 + 2); g.textAlign = 'left';
  return (x: number, yy: number) => {
    const ms = t0 + span * Math.max(0, Math.min(1, (x - labelW) / pw));
    if (!lanes.length) return { ms };
    const h = lanes[Math.max(0, Math.min(lanes.length - 1, Math.floor(yy / lh)))];
    if (x < labelW) return { ms, hz: h };
    return { tx: hpTapTx(rows, h, ms, now, HP_TAP_PX * span / pw), ms };
  };
}
