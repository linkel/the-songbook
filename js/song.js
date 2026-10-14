// The song view (#/song/<id>/<mode>): Sheet (chords over lyrics), Chords
// (sections as bars), Player (js/player.js) and the sheet editor
// (#/song/<id>/edit). Transpose, Simple, Aa and Capo, chord popovers,
// auto-scroll, and Play (the app guitar strums or picks the chart, with the
// sheet or bars lit as it goes; with a recording, the sheet plays that and
// follows its lyric timing). Tap-to-sync and LRCLIB lookups set the timing.

import { loadPrefs, savePrefs, getEntry, getSheet, saveSheet, deleteSheet, deleteManualSong, get, shippedChart, deleteChart } from "./library.js";
import { recordingMeta, fmtBytes } from "./recordings.js";
import { openReview, closeReview } from "./review.js";
import {
  displayChord, transposeChord, transposeKey, guessKey, splitBars, voicingsFor, pimaChord, suggestCapo,
  prettyChord, simplifyChord,
} from "./chords.js";
import { parseChordPro, importText, docChords, sheetChart } from "./chordpro.js";
import { sheetHtml } from "./sheet.js";
import { chordBoxSvg } from "./diagram.js";
import { ChartPlayer } from "./chartplay.js";
import { StringVoices, strum, resumeAudio, warmNotes, plainStrum, audioContext } from "./audio.js";
import { PATTERN_BY_ID, OPEN_MIDI } from "./patterns.js";
import { esc, sourceBadge, sourceSentence, pickingLabel, patternName, ICONS, toast, showPopover, closePopover } from "./ui.js";
import { invalidateSongs } from "./songs.js";
import { openPlayer, leavePlayerView, closePlayer, pitchShift, playerNow, onPlayerFrame, togglePlayer as toggleRecording, playRecording } from "./player.js";
import { lyricLines, getTiming, saveTiming, lineAt, findSyncedLyrics, alignToSheet, sheetFromTiming } from "./lyrics.js";
import { lrclibOn } from "./prefs.js";

const MODES = [["sheet", "Sheet"], ["chords", "Chords"], ["picking", "Picking"], ["player", "Player"]];
const READY = new Set(["sheet", "chords", "edit", "analyse", "player"]);
const MIN_BPM = 30, MAX_BPM = 220, DEFAULT_BPM = 80;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const SCROLL_PX = 24;   // px per second at 1x and the default font size

// { id, entry, chart, sheet, doc, sChart, prefs, mode, view }
let cur = null;
let player = null;
let hearVoices = null;

function getPlayer() {
  if (!player) {
    player = new ChartPlayer("guitar");
    player.addEventListener("bar", (e) => highlight(e.detail.bar));
    player.addEventListener("state", () => { updateTransport(); if (!player.playing) highlight(-1); });
    player.addEventListener("end", () => player.stop(0.4));
  }
  return player;
}

/* ---- What's shown: the chart for Chords, the sheet for Sheet ---- */

// The chart-like source the current mode shows: { capo, key, sections, voicings... }.
function base() {
  if (!cur) return null;
  if (cur.mode === "sheet") return cur.sChart;
  if (cur.showCited && hasChords(cur.shipped)) return cur.shipped;
  return cur.chart || cur.sChart;
}

// The capo you play with: your choice, else what the shown chart or sheet is written for.
function capoNow() {
  if (cur.prefs.capo !== null && cur.prefs.capo !== undefined) return cur.prefs.capo;
  const b = base();
  return (b && b.capo) || 0;
}

const hasChords = (b) => !!b && (b.sections || []).some((s) => s.chords && s.chords.trim());

// Your transpose plus the recording's pitch shift: chords follow pitch.
const tr = () => cur.prefs.transpose + pitchShift(cur.id);

function soundingNames(b) {
  const shift = (b.capo || 0) + tr();
  const names = [];
  for (const s of b.sections || []) for (const bar of splitBars(s.chords)) for (const n of bar) names.push(transposeChord(n, shift));
  return names;
}

function soundingKey(b) {
  if (!b) return null;
  if (b.key) return { key: transposeKey(b.key, tr()), estimated: false };
  const g = guessKey(soundingNames(b));
  return g ? { key: g.key, estimated: true } : null;
}

function makeDisp(b) {
  const k = soundingKey(b);
  const shapeKey = k ? transposeKey(k.key, -capoNow()) : null;
  const view = { transpose: tr(), capo: capoNow(), simple: cur.prefs.simple, shapeKey };
  return (name) => displayChord(name, b, view);
}

// The source's own voicings apply when the shapes are its own.
function voicingMap(b) {
  const shift = (b.capo || 0) + tr() - capoNow();
  const own = shift === 0 && !cur.prefs.simple ? b.voicings || {} : {};
  return { ...own, ...(cur.prefs.voicings || {}) };
}

function uniqueDisplayed(b, disp) {
  const seen = [];
  for (const s of b.sections || []) for (const bar of splitBars(s.chords)) for (const n of bar) {
    const d = disp(n);
    if (!seen.includes(d)) seen.push(d);
  }
  return seen;
}

// Bars in play order. Chords: the form (or sections in order) with repeats.
// Sheet: each chord in reading order is one bar.
function flatBars(b) {
  if (cur.mode === "sheet") return docChords(cur.doc).map((c, k) => ({ k, names: [c.name] }));
  const secs = b.sections || [];
  const order = b.form && b.form.length
    ? b.form.map((n) => secs.findIndex((s) => s.name === n)).filter((i) => i >= 0)
    : secs.map((_, i) => i);
  const out = [];
  for (const si of order) {
    const bars = splitBars(secs[si].chords);
    for (let r = 0; r < (secs[si].repeat || 1); r++) bars.forEach((names, bi) => out.push({ sec: si, bar: bi, names }));
  }
  return out;
}

function playBars() {
  const b = base();
  const disp = makeDisp(b), vm = voicingMap(b);
  return flatBars(b).map((bar) => ({
    ...bar,
    chords: bar.names.map((n) => {
      const d = disp(n);
      const v = voicingsFor(d, vm)[0];
      return { name: d, frets: v ? v.frets : null, pima: v ? pimaChord(d, { [d]: v.spec }) : null };
    }),
  }));
}

// What Play will play, said plainly.
function playPlan() {
  const c = cur.chart;
  const b = base();
  const time = (b && b.time) || (c && c.time) || "4/4";
  const timing = cur.mode === "sheet" ? ", one bar per chord (the sheet doesn't give timing)" : "";
  if (c && c.strum) return { strum: c.strum, time, text: `Strum ${c.strum}${timing}` };
  const pid = c && c.picking && c.picking.patterns && c.picking.patterns[0];
  const pattern = pid && PATTERN_BY_ID.get(pid);
  if (pattern && c.style !== "strummed") {
    return { pattern, time, text: `Picking: ${patternName(pid)} (${pickingLabel(c.picking).text})${timing}` };
  }
  return { strum: plainStrum(time), time, text: `Plain strum, one per beat${timing}` };
}

const tempo = () => cur.prefs.tempo || (cur.chart && cur.chart.tempo) || (cur.sChart && cur.sChart.tempo) || DEFAULT_BPM;

/* ---- Opening ---- */

export async function openSong(view, id, mode, arg = null) {
  if (!cur || cur.id !== id) {
    stopAll();
    const [entry, device, shipped, sheet, rec, timing] = await Promise.all([
      getEntry(id), get("charts", id).catch(() => null), shippedChart(id).catch(() => null), getSheet(id), recordingMeta(id), getTiming(id)]);
    const chart = device || shipped;
    if (!entry && !chart && !sheet) {
      view.innerHTML = `<div class='topbar'><a class='back' href='#/songs' aria-label='Back'>${ICONS.back}</a>
        <div class='topbar-title'><div class='t'>Song not found</div></div></div>
        <div class='song-scroll'><div class='card empty'>There's no song "${esc(id)}" in your library.</div></div>`;
      cur = null;
      return;
    }
    const doc = sheet ? parseChordPro(sheet.chordpro) : null;
    const sChart = doc ? sheetChart(doc, sheet) : null;
    cur = { id, entry, chart, device, shipped, rec, sheet, doc, sChart, timing, prefs: null, mode: null, view, showCited: false, sync: null };
    cur.prefs = await loadPrefs(id, chart || sChart);
  }
  cur.view = view;
  cur.startLoop = mode === "player" ? arg : null;
  const prevMode = cur.mode;
  cur.mode = READY.has(mode) ? mode : cur.doc ? "sheet" : "chords";
  if (prevMode === "analyse" && cur.mode !== "analyse") cur.rec = await recordingMeta(id);
  if (prevMode === "player" && cur.mode !== "player") { cur.rec = await recordingMeta(id); leavePlayerView(); }
  if (cur.mode !== "sheet") cur.sync = null;
  render();
}

async function reload() {
  const id = cur.id;
  cur = null;
  invalidateSongs();
  return id;
}

export function closeSong() { stopAll(); closeReview(); closePopover(); closePlayer(); }

function stopAll() {
  if (player && player.playing) player.stop();
  stopScroll();
}

export const songMode = () => cur && cur.mode;

function songTitle() {
  return (cur.chart && cur.chart.title) || (cur.entry && cur.entry.title) || (cur.doc && cur.doc.meta.title) || "Untitled";
}
function songArtist() {
  return (cur.chart && cur.chart.artist) || (cur.entry && cur.entry.artist) || (cur.doc && cur.doc.meta.artist) || "";
}

/* ---- Rendering ---- */

function render() {
  if (cur.mode === "edit") { renderEditor(); return; }
  if (cur.mode === "analyse") {
    stopAll();
    openReview(cur.view, {
      id: cur.id, title: songTitle(), artist: songArtist(), chart: cur.device, shipped: cur.shipped,
      cited: hasChords(cur.shipped) ? cur.shipped : null, prefs: cur.prefs,
      setCapo: (c) => { cur.prefs.capo = c; savePrefs(cur.id, cur.prefs); },
      onSaved: async () => { const id = await reload(); location.hash = `#/song/${encodeURIComponent(id)}/chords`; },
    });
    return;
  }
  if (cur.mode === "player") {
    if (player && player.playing) player.stop();
    stopScroll();
    openPlayer(cur.view, playerCtx());
    return;
  }
  closeReview();
  const { view, mode } = cur;
  const b = base();
  const chords = hasChords(b);
  const disp = b ? makeDisp(b) : null;
  const old = view.querySelector("#song-scroll");
  // Keep the scroll position only when re-rendering the same screen.
  const keepScroll = old && cur.renderedMode === mode ? old.scrollTop : 0;
  cur.renderedMode = mode;
  // A sheet's badge says where its chords came from (LRCLIB gives only lyrics).
  const sheetSource = !cur.sheet ? null : cur.sheet.source === "lrclib" ? cur.sheet.chordsFrom : cur.sheet.source || "mine";
  const badgeOf = mode === "sheet" && cur.sheet ? { source: sheetSource, hasChords: chords } : (b || {});
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/songs' aria-label='Back to songs'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>${esc(songTitle())}</div><div class='meta'>${esc(songArtist())}</div></div>
      ${sourceBadge(badgeOf)}
    </div>
    <div class='song-body'>
      <div class='song-scroll' id='song-scroll'><div class='song-main-col'>
        ${mode === "chords" ? headCard(b) : ""}
        ${modesSeg(mode)}
        ${chords || (mode === "sheet" && cur.doc) ? toolbar(mode, chords) : ""}
        ${mode === "sheet" ? sheetBody(b, disp) : chordsBody(b, disp)}
      </div></div>
      <aside class='song-side' aria-label='Chords and transport'>
        ${chords ? `<div class='h2'>Chords</div><div class='boxes'>${boxesHtml(b, disp)}</div>` : ""}
        <div class='note plays'>${chords ? esc(playPlan().text) : ""}</div>
        <div class='transport'>${transportInner(chords)}</div>
      </aside>
    </div>
    ${mode === "sheet" && chords && !cur.sync ? `<div class='chordstrip' aria-label='Chords in this song'>${boxesHtml(b, disp, 58)}</div>` : ""}
    <div class='scroll-ctl hidden' role='group' aria-label='Scroll speed'>
      <span class='meta'>Scrolling</span>
      <button class='btn outline round small-round' data-act='speed-' aria-label='Slower scroll'>−</button>
      <span class='speed'>${SPEEDS[scroll.idx]}×</span>
      <button class='btn outline round small-round' data-act='speed+' aria-label='Faster scroll'>+</button>
    </div>
    ${cur.sync ? syncBarHtml() : ""}
    <div class='transport mobile'>${transportInner(chords)}</div>`;
  view.querySelector("#song-scroll").scrollTop = keepScroll;
  wire(view);
  updateTransport();
  litLine = null;
}

function modesSeg(mode) {
  return `<div class='seg' role='tablist' aria-label='Mode'>${MODES.map(([m, label]) =>
    `<button role='tab' data-mode='${m}' class='${m === mode ? "on" : ""}' aria-selected='${m === mode}'
      ${READY.has(m) ? "" : "disabled title='Coming in a later update'"}>${label}</button>`).join("")}</div>`;
}

/* ---- Player mode ---- */

// The chart with bar times (from an analysed recording), else the chart.
function timedChart() {
  const timed = (c) => c && Array.isArray(c.bars) && c.bars.length && typeof c.bars[0].t === "number";
  if (timed(cur.device)) return cur.device;
  // A shipped chart from your own analysis (tools/add-charts.mjs) has bar times too.
  if (timed(cur.shipped)) return cur.shipped;
  return cur.chart;
}

function playerCtx() {
  const c = timedChart();
  const links = (cur.chart && cur.chart.links) || (cur.shipped && cur.shipped.links) || [];
  let cache = { key: null, fn: null };
  const disp = (name) => {
    if (!c) return name;
    const key = tr() + ":" + capoNow() + ":" + cur.prefs.simple;
    if (cache.key !== key) cache = { key, fn: makeDisp(c) };
    return cache.fn(name);
  };
  return {
    id: cur.id, title: songTitle(), artist: songArtist(), prefs: cur.prefs, rec: cur.rec,
    chart: { ...(c || {}), links, audio: (cur.chart && cur.chart.audio) || (cur.shipped && cur.shipped.audio) || null }, disp,
    modesHtml: modesSeg("player"),
    sideHtml: c && hasChords(c) ? `<div class='h2'>Chords</div><div class='boxes'>${boxesHtml(c, disp)}</div>` : "",
    wireSide: (v) => v.querySelectorAll(".box[data-chord]").forEach((b) => b.addEventListener("click", () => openChord([b.dataset.chord]))),
    lyrics: cur.doc ? { lines: lyricLines(cur.doc).map((x) => x.text), timing: cur.timing ? cur.timing.lines : [] } : null,
    onPitch: () => {},
    startLoop: cur.startLoop,
  };
}

/* ---- The sheet following the recording ---- */

let litLine = null;
onPlayerFrame((f) => {
  if (!cur || f.id !== cur.id || cur.mode !== "sheet" || !cur.view) return;
  if (f.playing !== cur.recPlaying) { cur.recPlaying = f.playing; updateTransport(); }
  const lines = cur.doc ? lyricLines(cur.doc) : [];
  const idx = lineAt(cur.timing ? cur.timing.lines : [], f.pos);
  const ln = idx >= 0 ? lines[idx] : null;
  const el = ln ? cur.view.querySelector(`.sheet .line[data-s='${ln.s}'][data-l='${ln.l}']`) : null;
  if (el !== litLine) {
    if (litLine) litLine.classList.remove("now");
    litLine = el;
    if (el) { el.classList.add("now"); if (f.playing && !cur.sync) follow(el); }
  }
  if (cur.sync) updateSyncBar(f.pos);
});

/* ---- Tap-to-sync ---- */

function syncBarHtml() {
  return `<div class='sync-bar' role='region' aria-label='Sync lyrics'>
    <div class='sync-info meta'></div>
    <div class='sync-btns'>
      <button class='btn outline round' data-sync='play' aria-label='Play or pause the recording'>▶</button>
      <button class='btn outline' data-sync='earlier' aria-label='Line starts earlier'>−0.1 s</button>
      <button class='btn primary' data-sync='tap' style='flex:1'>Next line</button>
      <button class='btn outline' data-sync='later' aria-label='Line starts later'>+0.1 s</button>
    </div>
    <div class='sync-btns'>
      ${lrclibOn() ? "<button class='btn outline small' data-sync='lrclib'>Find on LRCLIB</button>" : ""}
      <button class='btn outline small' data-sync='clear'>Clear timing</button>
      <span class='spacer'></span>
      <button class='btn outline small' data-sync='done'>Done</button>
    </div>
  </div>`;
}

function startSync() {
  if (!cur.doc) return;
  if (!cur.rec) { toast("Add a recording first (Player), then tap along to it."); return; }
  const lines = lyricLines(cur.doc);
  const have = new Map((cur.timing ? cur.timing.lines : []).map((x) => [x.index, x.t]));
  let next = lines.findIndex((_, i) => !have.has(i));
  if (next < 0) next = 0;
  cur.sync = { have, next, last: null };
  stopScroll();
  render();
  updateSyncBar(0);
}

function updateSyncBar(pos) {
  const bar = cur.view.querySelector(".sync-bar");
  if (!bar) return;
  const lines = lyricLines(cur.doc);
  const { next, have } = cur.sync;
  const ln = lines[next];
  const p = playerNow();
  const playBtn = bar.querySelector("[data-sync=play]");
  if (playBtn) playBtn.textContent = p && p.playing ? "❚❚" : "▶";
  const info = bar.querySelector(".sync-info");
  const text = ln ? (ln.text || "(chords)") : "All lines timed";
  const t = p ? " · " + Math.floor(p.pos / 60) + ":" + String(Math.floor(p.pos % 60)).padStart(2, "0") : "";
  info.textContent = `${have.size} of ${lines.length} lines timed${t}. Next: ${text.length > 48 ? text.slice(0, 47) + "…" : text}`;
  cur.view.querySelectorAll(".sheet .line.next").forEach((e) => e.classList.remove("next"));
  if (ln) { const el = cur.view.querySelector(`.sheet .line[data-s='${ln.s}'][data-l='${ln.l}']`); if (el) el.classList.add("next"); }
}

async function syncAct(what) {
  const lines = lyricLines(cur.doc);
  const sy = cur.sync;
  const p = playerNow();
  if (what === "play") {
    if (p && p.id === cur.id) await toggleRecording(); else await playRecording(playerCtx());
  } else if (what === "tap") {
    if (!p || !p.playing) { toast("Play the recording, then tap as each line starts."); return; }
    if (sy.next >= lines.length) return;
    sy.have.set(sy.next, Math.max(0, p.pos - 0.08));
    sy.last = sy.next;
    sy.next = Math.min(lines.length, sy.next + 1);
    await storeSync("tap");
    // Follow the line being timed.
    const ln = lines[Math.min(sy.next, lines.length - 1)];
    const el = ln && cur.view.querySelector(`.sheet .line[data-s='${ln.s}'][data-l='${ln.l}']`);
    if (el) follow(el);
  } else if (what === "earlier" || what === "later") {
    const i = sy.last ?? (sy.next > 0 ? sy.next - 1 : null);
    if (i === null || !sy.have.has(i)) { toast("Tap a line first."); return; }
    sy.have.set(i, Math.max(0, sy.have.get(i) + (what === "later" ? 0.1 : -0.1)));
    await storeSync("tap");
    toast(`Line ${i + 1} starts at ${sy.have.get(i).toFixed(1)} s.`, 1200);
  } else if (what === "clear") {
    sy.have.clear();
    sy.next = 0;
    sy.last = null;
    await storeSync("tap");
  } else if (what === "lrclib") {
    await lrclibForSheet();
  } else if (what === "done") {
    cur.sync = null;
    render();
    return;
  }
  updateSyncBar(p ? p.pos : 0);
}

async function storeSync(source) {
  const lines = [...cur.sync.have].map(([index, t]) => ({ index, t }));
  const saved = await saveTiming(cur.id, lines, source);
  cur.timing = { id: cur.id, lines: saved, source };
}

/* ---- LRCLIB ---- */

async function recordingDuration() {
  const p = playerNow();
  if (p && p.id === cur.id) { const d = (await import("./player.js")).playerState(); if (d && d.duration) return d.duration; }
  return (cur.device && cur.device.analysis && cur.device.analysis.duration) || null;
}

// With a sheet: take LRCLIB's line times for the lines that match.
async function lrclibForSheet() {
  toast("Looking on LRCLIB…", 0);
  try {
    const found = await findSyncedLyrics({ title: songTitle(), artist: songArtist(), duration: await recordingDuration() });
    if (!found) { toast("LRCLIB has no synced lyrics for this song.", 3500); return; }
    const lines = lyricLines(cur.doc);
    const timing = alignToSheet(found.synced, lines);
    if (!timing.length) { toast("LRCLIB found the song, but its lines don't match your sheet.", 4000); return; }
    for (const x of timing) cur.sync.have.set(x.index, x.t);
    cur.sync.next = lines.findIndex((_, i) => !cur.sync.have.has(i));
    if (cur.sync.next < 0) cur.sync.next = lines.length;
    await storeSync("lrclib");
    toast(`Timed ${timing.length} of ${lines.length} lines from LRCLIB. Check them as it plays.`, 4000);
  } catch (e) {
    toast(e.message, 4000);
  }
}

// Without a sheet: LRCLIB's lyrics become one, with your detected chords placed by time.
async function lrclibNewSheet(btn) {
  btn.disabled = true;
  toast("Looking on LRCLIB…", 0);
  try {
    const found = await findSyncedLyrics({ title: songTitle(), artist: songArtist(), duration: await recordingDuration() });
    if (!found) { toast("LRCLIB has no synced lyrics for this song.", 3500); btn.disabled = false; return; }
    const tc = timedChart();
    const timed = tc && Array.isArray(tc.bars) && tc.bars.length && typeof tc.bars[0].t === "number";
    const bars = timed ? tc.bars.map((b, i) => ({ t: b.t, t1: tc.bars[i + 1] ? tc.bars[i + 1].t : b.t + 2, chords: b.chords })) : [];
    const chordpro = sheetFromTiming(found.synced, bars, { title: songTitle(), artist: songArtist() });
    const rec = { id: cur.id, chordpro, source: "lrclib", sources: [found.source], chordsFrom: timed ? (tc.source === "mine" ? "mine" : "detected") : null };
    await saveSheet(rec);
    // The sheet's lyric lines are LRCLIB's lines in order: they keep its times.
    const withText = found.synced.filter((x) => x.text);
    const tl = [];
    let j = 0;
    lyricLines(parseChordPro(chordpro)).forEach((ln, i) => { if (ln.text && j < withText.length) { tl.push({ index: i, t: withText[j].t }); j++; } });
    await saveTiming(cur.id, tl, "lrclib");
    toast(timed ? "Sheet made from LRCLIB's lyrics with your chords placed by time. Check it as it plays." : "Sheet made from LRCLIB's lyrics. Analyse a recording to add chords.", 4500);
    const id = cur.id;
    cur = null;
    invalidateSongs();
    await openSong(document.getElementById("view-song"), id, "sheet");
  } catch (e) {
    toast(e.message, 4000);
    btn.disabled = false;
  }
}

function keyText(b) {
  const k = soundingKey(b);
  if (!k) return "";
  const shapeKey = transposeKey(k.key, -capoNow());
  const est = k.estimated ? " <span class='meta'>est.</span>" : "";
  return capoNow()
    ? `Key <b>${prettyChord(shapeKey)}</b> (sounds <b>${prettyChord(k.key)}</b>)${est}`
    : `Key <b>${prettyChord(k.key)}</b>${est}`;
}

function headCard(b) {
  const c = cur.chart || {};
  const chips = [];
  if (hasChords(b)) {
    if (capoNow()) chips.push(`<span class='chip'>Capo <b>${capoNow()}</b></span>`);
    const k = keyText(b);
    if (k) chips.push(`<span class='chip'>${k}</span>`);
    const t = b.tempo || c.tempo;
    chips.push(`<span class='chip'>${t ? `<b>${t}</b> bpm` : "Tempo <span class='meta'>not set</span>"}</span>`);
    if (b.time) chips.push(`<span class='chip'>${esc(b.time)}</span>`);
  }
  const tuning = (cur.chart && cur.chart.tuning) || (cur.shipped && cur.shipped.tuning);
  if (tuning) chips.push(`<span class='chip' title='${esc(tuning.notes)}'>Tuning <b>${esc(tuning.name)}</b></span>`);
  const style = [c.style, c.type === "piece" ? "piece" : null].filter(Boolean).join(" · ");
  const album = cur.entry && cur.entry.album && ![songTitle(), songArtist()].includes(cur.entry.album) ? cur.entry.album : "";
  return `<div class='card head'><h1 class='song-title'>${esc(songTitle())}</h1>
    <div class='meta'>${esc([songArtist(), style, album].filter(Boolean).join(" · "))}</div>
    ${chips.length ? `<div class='chips'>${chips.join("")}</div>` : ""}</div>`;
}

function toolbar(mode, chords = true) {
  const p = cur.prefs;
  const t = p.transpose > 0 ? "+" + p.transpose : String(p.transpose).replace("-", "−");
  const shift = pitchShift(cur.id);
  return `<div class='toolbar' role='toolbar' aria-label='Chord tools'>
    ${chords ? `<button class='tool' data-act='transpose'>Transpose <b>${t}</b>${shift ? ` <span class='meta'>${shift > 0 ? "+" : "−"}${Math.abs(shift)} pitch</span>` : ""}</button>
    <button class='tool ${p.simple ? "on" : ""}' data-act='simple' aria-pressed='${p.simple}'>Simple</button>` : ""}
    ${mode === "sheet" ? "<button class='tool' data-act='font' aria-label='Text size'>Aa</button>" : ""}
    ${chords ? `<button class='tool' data-act='capo'>Capo ${capoNow()}</button>` : ""}
    ${mode === "sheet" && cur.doc ? `<button class='tool ${cur.sync ? "on" : ""}' data-act='sync' aria-pressed='${!!cur.sync}'>Sync${cur.timing && cur.timing.lines.length ? " ✓" : ""}</button>` : ""}
  </div>`;
}

function provenance(record, sources) {
  return (sources || []).length ? `<ul>${sources.map((s) =>
    `<li><a href='${esc(s.url)}' target='_blank' rel='noopener'>${esc(s.label || s.url)}</a></li>`).join("")}</ul>` : "";
}

function sheetBody(b, disp) {
  if (!cur.doc) {
    return `<div class='card empty'><b>No sheet yet.</b><br>Paste chords over lyrics (the way Ultimate Guitar shows them) or ChordPro. It stays on this device.
      ${lrclibOn() ? `<br><br>Or get synced lyrics from LRCLIB${timedChart() && timedChart().bars ? " and place your detected chords on them by time" : ""}. It sends the title, artist and length to lrclib.net.` : ""}
      <div style='margin-top:12px;display:flex;gap:8px;flex-wrap:wrap'><a class='btn primary' href='#/song/${encodeURIComponent(cur.id)}/edit'>Paste a sheet</a>
      ${lrclibOn() ? "<button class='btn outline' data-act='lrclib-new'>Find on LRCLIB</button>" : ""}</div></div>`;
  }
  const info = [];
  const k = hasChords(b) ? keyText(b) : "";
  if (k) info.push(k);
  if (capoNow()) info.push(`Capo <b>${capoNow()}</b>`);
  const t = b.tempo || (cur.chart && cur.chart.tempo);
  if (t) info.push(`<b>${t}</b> bpm`);
  if (b.time) info.push(esc(b.time));
  const strumText = cur.chart && cur.chart.strum ? `<br>Strum <b>${esc(cur.chart.strum)}</b>` : "";
  const src = cur.sheet.source === "web" ? "From the web, cited below"
    : cur.sheet.source === "lrclib" ? `Lyrics and line times from LRCLIB${cur.sheet.chordsFrom ? `; chords from your ${cur.sheet.chordsFrom === "mine" ? "checked" : "detected"} chart, placed by time (check them)` : ""}`
    : "Your sheet";
  const timed = cur.timing && cur.timing.lines.length
    ? `<div class='note' style='margin-top:6px'>${cur.timing.lines.length} lines timed (${cur.timing.source === "lrclib" ? "LRCLIB" : "tapped"}): the sheet follows the recording.</div>` : "";
  return `<div class='sheet-info'>${info.join(" · ")}${strumText}</div>
    <div class='sheet' style='--scale:${(1 + 0.12 * (cur.prefs.font || 0)).toFixed(2)}'>${sheetHtml(cur.doc, disp)}</div>
    <div class='card sources'>
      <div><b>Sheet:</b> ${src}, stored on this device only.</div>${timed}${provenance(cur.sheet, cur.sheet.sources)}
      <div style='margin-top:10px'><a class='btn outline small' href='#/song/${encodeURIComponent(cur.id)}/edit'>Edit sheet</a></div>
    </div>`;
}

function chordsBody(b, disp) {
  const parts = [];
  const id = encodeURIComponent(cur.id);
  if (cur.device && hasChords(cur.shipped)) {
    parts.push(`<div class='seg' role='group' aria-label='Which chart'>
      <button data-which='mine' class='${cur.showCited ? "" : "on"}' aria-pressed='${!cur.showCited}'>Your chart</button>
      <button data-which='cited' class='${cur.showCited ? "on" : ""}' aria-pressed='${cur.showCited}'>Cited chart</button></div>`);
  }
  if (hasChords(b)) {
    parts.push(sectionsHtml(b, disp));
    parts.push(`<div class='card boxes boxes-card'>${boxesHtml(b, disp)}</div>`);
  } else {
    parts.push(`<div class='card empty'><b>No chord chart yet.</b><br>Nothing here is invented: chords will come from analysing a recording, a cited chart, or a sheet you paste.
      <div style='margin-top:12px;display:flex;gap:8px;flex-wrap:wrap'><a class='btn primary' href='#/song/${id}/analyse'>Analyse a recording</a>
      <a class='btn outline' href='#/song/${id}/edit'>Paste a sheet</a></div></div>`);
  }
  const r = cur.rec;
  const detected = cur.device && cur.device.analysis;
  parts.push(`<div class='card set-group'><div class='set-row'><div style='min-width:0'><div class='set-label'>Recording</div>
    <div class='meta ellipsis'>${r ? esc(r.name) + " · " + fmtBytes(r.size) + " · on this device" : "None yet. Add one to work out the chords."}</div></div>
    <a class='btn outline small' href='#/song/${id}/analyse'>${detected ? "Review chords" : r ? "Analyse" : "Add"}</a></div></div>`);
  parts.push(provenanceCard(b));
  if (cur.entry && cur.entry.manual) {
    parts.push(`<div class='card set-group'><div class='set-row'><div><div class='set-label'>Added by hand</div><div class='meta'>Not from your Spotify library.</div></div>
      <button class='btn outline small' data-act='remove-song'>Remove</button></div></div>`);
  }
  return parts.join("");
}

function sectionsHtml(b, disp) {
  return (b.sections || []).map((s, si) => {
    const bars = splitBars(s.chords);
    return `<div class='card section' data-sec='${si}'>
      <div class='sec-head'><span class='sec-name'>${esc(s.name)}</span><span class='meta'>${s.repeat > 1 ? "×" + s.repeat + " · " : ""}${bars.length} bar${bars.length === 1 ? "" : "s"}</span></div>
      <div class='bars'>${bars.map((bar, bi) => `<button class='bar' data-sec='${si}' data-bar='${bi}' aria-label='Bar ${bi + 1}: ${esc(bar.map(disp).join(" "))}'>${bar.map((n) =>
        `<span class='ch'>${esc(prettyChord(disp(n)))}</span>`).join("")}</button>`).join("")}</div>
    </div>`;
  }).join("");
}

function boxesHtml(b, disp, width = 76) {
  const vm = voicingMap(b);
  return uniqueDisplayed(b, disp).map((d) => {
    const v = voicingsFor(d, vm)[0];
    return `<button class='box' data-chord='${esc(d)}'>${esc(prettyChord(d))}${v ? chordBoxSvg(v.frets, { width, label: d + " " + v.spec }) : "<span class='nobox'>no shape found</span>"}</button>`;
  }).join("");
}

function provenanceCard(b) {
  const parts = [];
  if (hasChords(b)) {
    const what = b.fromSheet ? (b.source === "web" ? "From your sheet (from the web, cited below)." : "From your sheet.")
      : b.checkedFrom ? `Yours: detected by ${b.checkedFrom}, then checked by ear.` : sourceSentence(b);
    parts.push(`<div><b>Chords:</b> ${esc(what)}</div>`);
    if (b.notes) parts.push(`<div class='note' style='margin-top:6px'>${esc(b.notes)}</div>`);
    parts.push(provenance(b, b.sources));
  }
  const tuning = (cur.chart && cur.chart.tuning) || (cur.shipped && cur.shipped.tuning);
  if (tuning) {
    parts.push(`<div style='margin-top:${parts.length ? 12 : 0}px'><b>Tuning:</b> ${esc(tuning.name)} (${esc(prettyChord(tuning.notes))})${tuning.source === "mine" ? ", as you play it" : ""}.
      ${hasChords(b) ? "<span class='note'>Chord diagrams and Play use standard-tuning shapes for now.</span>" : ""}</div>`);
  }
  const links = (cur.chart && cur.chart.links) || (cur.shipped && cur.shipped.links) || [];
  if (links.length) parts.push(`<div style='margin-top:${parts.length ? 12 : 0}px'><b>Links</b></div>${provenance(null, links)}`);
  if (cur.shipped && cur.shipped.notes && !hasChords(b)) parts.push(`<div class='note' style='margin-top:6px'>${esc(cur.shipped.notes)}</div>`);
  if (cur.device && b === cur.device) {
    parts.push(`<div style='margin-top:12px;display:flex;gap:8px;flex-wrap:wrap'>
      ${cur.device.analysis ? `<a class='btn outline small' href='#/song/${encodeURIComponent(cur.id)}/analyse'>Review and edit</a>` : ""}
      <button class='btn outline small' data-act='delete-chart'>Delete your chart</button></div>`);
  }
  const p = cur.chart && cur.chart.picking;
  if (p && p.patterns && p.patterns.length) {
    const lab = pickingLabel(p);
    parts.push(`<div style='margin-top:${parts.length ? 12 : 0}px'><b>Picking${p.part ? " (" + esc(p.part) + ")" : ""}:</b>
      ${p.patterns.map((id) => `<span class='badge pick'>${esc(patternName(id))}</span>`).join(" ")}
      <span class='src-label'>${esc(lab.text)}, ${esc(p.match)} match</span></div>`);
    if (p.description) parts.push(`<div class='note' style='margin-top:6px'>${esc(p.description)}</div>`);
    parts.push(provenance(p, p.sources));
  }
  return parts.length ? `<div class='card sources'>${parts.join("")}</div>` : "";
}

function transportInner(chords) {
  if (cur.mode === "sheet") {
    return `<button class='btn outline scroll-btn' data-act='scroll' aria-pressed='${scroll.on}' ${cur.doc ? "" : "disabled"}>Scroll ${SPEEDS[scroll.idx]}×</button>
      <button class='btn outline tempo-btn' data-act='tempo' aria-label='Tempo'><span class='bpm'>${tempo()}</span><small>BPM</small></button>
      <button class='btn primary play' data-act='play' style='flex:1' ${chords || cur.rec ? "" : "disabled"}>▶ ${cur.rec ? "Recording" : "Play song"}</button>`;
  }
  return `<button class='btn outline round' data-act='bpm-' aria-label='Slower'>−</button>
    <div class='tempo' aria-live='polite'><span class='bpm'>${tempo()}</span><small>BPM</small></div>
    <button class='btn outline round' data-act='bpm+' aria-label='Faster'>+</button>
    <button class='btn primary play' data-act='play' style='flex:1' ${chords ? "" : "disabled"}>▶ Play</button>`;
}

function updateTransport() {
  if (!cur || !cur.view) return;
  const rec = cur.mode === "sheet" && cur.rec;
  const pn = playerNow();
  const playing = rec ? !!(pn && pn.id === cur.id && pn.playing) : player && player.playing;
  const label = cur.mode === "sheet" ? (rec ? "Recording" : "Play song") : "Play";
  cur.view.querySelectorAll(".play").forEach((b) => {
    b.textContent = playing ? (rec ? "❚❚ Pause" : "■ Stop") : "▶ " + label;
    b.classList.toggle("stop", !!playing);
  });
  cur.view.querySelectorAll(".bpm").forEach((el) => { el.textContent = tempo(); });
  cur.view.querySelectorAll(".scroll-btn").forEach((b) => {
    b.textContent = `Scroll ${SPEEDS[scroll.idx]}×`;
    b.classList.toggle("on", scroll.on);
    b.setAttribute("aria-pressed", scroll.on);
  });
  const ctl = cur.view.querySelector(".scroll-ctl");
  if (ctl) {
    ctl.classList.toggle("hidden", !scroll.on);
    ctl.querySelector(".speed").textContent = SPEEDS[scroll.idx] + "×";
  }
}

/* ---- The lit bar or chord while playing ---- */

let lit = [];
function highlight(i) {
  lit.forEach((el) => el.classList.remove("on", "now"));
  lit = [];
  if (!cur || i < 0 || !player || !player.session) return;
  const bar = player.session.bars[i];
  if (!bar) return;
  const v = cur.view;
  if (bar.k !== undefined) {
    const c = v.querySelector(`.sheet .c[data-k='${bar.k}']`);
    if (!c) return;
    const line = c.closest(".line");
    c.classList.add("now");
    line.classList.add("now");
    lit = [c, line];
    follow(line);
  } else {
    const el = v.querySelector(`.bar[data-sec='${bar.sec}'][data-bar='${bar.bar}']`);
    if (!el) return;
    el.classList.add("on");
    lit = [el];
    follow(el);
  }
}

// Keep what's playing about a third of the way down the screen.
function follow(el) {
  const sc = cur.view.querySelector("#song-scroll");
  const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  if (r.top < sr.top + sr.height * 0.12 || r.bottom > sr.top + sr.height * 0.7) {
    sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - sr.height * 0.3, behavior: "smooth" });
  }
}

/* ---- Auto-scroll ---- */

const scroll = { on: false, idx: 2, raf: 0, last: 0, acc: 0 };

export function toggleScroll() {
  if (!cur || cur.mode !== "sheet" || !cur.doc) return;
  if (scroll.on) stopScroll(); else startScroll();
}

function startScroll() {
  scroll.on = true;
  scroll.last = 0;
  scroll.acc = 0;
  scroll.raf = requestAnimationFrame(scrollTick);
  updateTransport();
}

function stopScroll() {
  scroll.on = false;
  if (scroll.raf) cancelAnimationFrame(scroll.raf);
  scroll.raf = 0;
  updateTransport();
}

function scrollTick(ts) {
  if (!scroll.on || !cur) return;
  const sc = cur.view.querySelector("#song-scroll");
  if (!sc) { stopScroll(); return; }
  if (scroll.last) {
    const dt = Math.min(0.1, (ts - scroll.last) / 1000);
    // While Play runs the sheet follows the music instead.
    if (!(player && player.playing)) {
      scroll.acc += dt * SCROLL_PX * SPEEDS[scroll.idx] * (1 + 0.12 * (cur.prefs.font || 0));
      const px = Math.floor(scroll.acc);
      if (px) { sc.scrollTop += px; scroll.acc -= px; }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) { stopScroll(); return; }
    }
  }
  scroll.last = ts;
  scroll.raf = requestAnimationFrame(scrollTick);
}

function setSpeed(d) {
  scroll.idx = Math.max(0, Math.min(SPEEDS.length - 1, scroll.idx + d));
  updateTransport();
}

/* ---- Actions ---- */

function setPrefs(patch) {
  Object.assign(cur.prefs, patch);
  savePrefs(cur.id, cur.prefs);
  render();
  if (player && player.playing) player.setBars(playBars());
}

export function transposeBy(n) {
  if (!cur || !base()) return;
  setPrefs({ transpose: Math.max(-11, Math.min(11, cur.prefs.transpose + n)) });
}

export function setTempo(bpm) {
  if (!cur) return;
  cur.prefs.tempo = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
  savePrefs(cur.id, cur.prefs);
  if (player) player.setTempo(cur.prefs.tempo);
  updateTransport();
  document.querySelectorAll(".popover .bpm").forEach((el) => { el.textContent = tempo(); });
}

export function tempoBy(n) { if (cur) setTempo(tempo() + n); }

export async function togglePlay() {
  if (!cur || cur.mode === "edit") return;
  if (cur.mode === "player") { await toggleRecording(); return; }
  if (cur.mode === "sheet" && cur.rec) {
    const pn = playerNow();
    if (player && player.playing) player.stop();
    if (pn && pn.id === cur.id) await toggleRecording(); else await playRecording(playerCtx());
    updateTransport();
    return;
  }
  if (!hasChords(base())) return;
  const p = getPlayer();
  if (p.playing) { p.stop(); return; }
  const plan = playPlan();
  const bars = playBars();
  if (!bars.length) return;
  if (bars.some((b) => b.chords.some((c) => !c.frets))) toast("Some chords have no shape, so they're silent.");
  await p.start({
    bars, bpm: tempo(), time: plan.time, capo: capoNow(),
    strum: plan.strum, pattern: plan.pattern, countIn: false, loop: false,
  });
}

function wire(view) {
  view.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "bpm-" || act === "bpm+") { holdable(b, () => tempoBy(act === "bpm+" ? 1 : -1)); return; }
    b.addEventListener("click", () => {
      if (act === "transpose") openTranspose();
      else if (act === "simple") setPrefs({ simple: !cur.prefs.simple });
      else if (act === "capo") openCapo();
      else if (act === "font") openFont();
      else if (act === "play") togglePlay();
      else if (act === "scroll") toggleScroll();
      else if (act === "speed-") setSpeed(-1);
      else if (act === "speed+") setSpeed(1);
      else if (act === "tempo") openTempo();
      else if (act === "remove-song") removeSong(b);
      else if (act === "delete-chart") deleteMyChart(b);
      else if (act === "sync") { if (cur.sync) { cur.sync = null; render(); } else startSync(); }
      else if (act === "lrclib-new") lrclibNewSheet(b);
    });
  });
  view.querySelectorAll("[data-sync]").forEach((b) => b.addEventListener("click", () => syncAct(b.dataset.sync)));
  view.querySelectorAll("[data-which]").forEach((b) => b.addEventListener("click", () => {
    cur.showCited = b.dataset.which === "cited";
    render();
  }));
  view.querySelectorAll(".seg button[data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (!b.disabled) location.hash = `#/song/${encodeURIComponent(cur.id)}/${b.dataset.mode}`;
  }));
  view.querySelectorAll(".box[data-chord]").forEach((b) => b.addEventListener("click", () => openChord([b.dataset.chord])));
  view.querySelectorAll(".bar[data-sec]").forEach((b) => b.addEventListener("click", () => {
    const bse = base();
    const disp = makeDisp(bse);
    openChord(splitBars(bse.sections[+b.dataset.sec].chords)[+b.dataset.bar].map(disp));
  }));
  const sheet = view.querySelector(".sheet");
  if (sheet) sheet.addEventListener("click", (e) => {
    // While syncing, a tap on a line makes it the next one to time (and jumps there if it's timed).
    if (cur.sync) {
      const line = e.target.closest(".line");
      if (!line) return;
      const lines = lyricLines(cur.doc);
      const i = lines.findIndex((x) => String(x.s) === line.dataset.s && String(x.l) === line.dataset.l);
      if (i < 0) return;
      cur.sync.next = i;
      cur.sync.last = cur.sync.have.has(i) ? i : null;
      const t = cur.sync.have.get(i);
      if (t !== undefined) import("./player.js").then((m) => { const st = m.playerState(); if (st && st.engine) st.engine.seek(t); });
      updateSyncBar(0);
      return;
    }
    const c = e.target.closest(".c[data-chord]");
    if (c) openChord([c.dataset.chord]);
  });
}

// Buttons that repeat while held (Pimapeggio's holdable).
function holdable(el, fire) {
  let t1 = null, t2 = null;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fire();
    t1 = setTimeout(() => { t2 = setInterval(fire, 90); }, 450);
  });
  const up = () => { clearTimeout(t1); clearInterval(t2); };
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => el.addEventListener(t, up));
}

async function deleteMyChart(btn) {
  if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "Tap again to delete"; return; }
  await deleteChart(cur.id);
  const id = cur.id;
  cur = null;
  invalidateSongs();
  await openSong(document.getElementById("view-song"), id, "chords");
}

async function removeSong(btn) {
  if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "Tap again to remove"; return; }
  await deleteManualSong(cur.id);
  await reload();
  location.hash = "#/songs";
}

/* ---- Popovers ---- */

async function hear(frets) {
  await resumeAudio();
  const midis = frets.map((f, i) => (f === null ? null : OPEN_MIDI[6 - i] + f + capoNow())).filter((m) => m !== null);
  await warmNotes(midis);
  hearVoices = hearVoices || new StringVoices("guitar");
  strum(hearVoices, frets, audioContext().currentTime + 0.03, { capo: capoNow(), level: 0.4 });
}

function openChord(names) {
  const vm = voicingMap(base());
  const html = names.map((name) => {
    const vs = voicingsFor(name, vm).slice(0, 6);
    return `<div class='popover-head'><span class='popover-name'>${esc(prettyChord(name))}</span>
        ${vs.length ? `<button class='btn outline small' data-hear='${esc(name)}'>▶ Hear it</button>` : ""}</div>
      <div class='boxes'>${vs.length ? vs.map((v, i) => `<button class='box ${i === 0 ? "sel" : ""}' data-name='${esc(name)}' data-spec='${esc(v.spec)}'
        aria-label='${esc(name)} ${esc(v.spec)}'>${esc(v.spec)}${chordBoxSvg(v.frets, { label: name + " " + v.spec })}</button>`).join("")
        : "<span class='note'>No shape found for this chord.</span>"}</div>`;
  }).join("<hr class='rule'>");
  const p = showPopover(html + `<p class='note'>Tap a shape to use it in this song and hear it.</p>
    <button class='btn outline' data-close>Done</button>`, "Chord shapes");
  p.querySelectorAll("[data-hear]").forEach((b) => b.addEventListener("click", () => {
    const v = voicingsFor(b.dataset.hear, voicingMap(base()))[0];
    if (v) hear(v.frets);
  }));
  p.querySelectorAll(".box[data-spec]").forEach((b) => b.addEventListener("click", () => {
    const name = b.dataset.name, spec = b.dataset.spec;
    const v = voicingsFor(name, vm).find((x) => x.spec === spec);
    cur.prefs.voicings = { ...(cur.prefs.voicings || {}), [name]: spec };
    savePrefs(cur.id, cur.prefs);
    b.parentElement.querySelectorAll(".box").forEach((x) => x.classList.toggle("sel", x === b));
    if (v) hear(v.frets);
    render();
  }));
}

// A −/+ stepper popover; reopened after each step so the value stays current.
function stepper(title, value, sub, onStep, extra = "") {
  const p = showPopover(`<div class='popover-head'><span class='popover-name' style='font-size:20px'>${esc(title)}</span></div>
    <div class='stepper'><button class='btn outline round' data-step='-1' aria-label='Less'>−</button>
      <div class='val'>${value}<small>${sub}</small></div>
      <button class='btn outline round' data-step='1' aria-label='More'>+</button></div>
    ${extra}
    <div style='display:flex;gap:8px'><button class='btn outline' style='flex:1' data-reset>Reset</button>
    <button class='btn outline' style='flex:1' data-close>Done</button></div>`, title);
  p.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => onStep(+b.dataset.step)));
  p.querySelector("[data-reset]").addEventListener("click", () => onStep(0));
  return p;
}

function openTranspose() {
  const t = cur.prefs.transpose;
  const k = soundingKey(base());
  stepper("Transpose", t > 0 ? "+" + t : String(t).replace("-", "−"), "semitones",
    (d) => { setPrefs({ transpose: d === 0 ? 0 : Math.max(-11, Math.min(11, t + d)) }); openTranspose(); },
    `<p class='note'>${k ? `Sounds in ${esc(prettyChord(k.key))}${k.estimated ? " (estimated)" : ""}. ` : ""}Chords, diagrams and Play all follow.</p>`);
}

function openFont() {
  const f = cur.prefs.font || 0;
  stepper("Text size", Math.round((1 + 0.12 * f) * 100) + "%", "of normal",
    (d) => { setPrefs({ font: d === 0 ? 0 : Math.max(-2, Math.min(5, f + d)) }); openFont(); });
}

function openTempo() {
  const p = stepper("Tempo", `<span class='bpm'>${tempo()}</span>`, "BPM", (d) => {
    if (d === 0) { cur.prefs.tempo = null; savePrefs(cur.id, cur.prefs); updateTransport(); openTempo(); }
  }, `<p class='note'>For Play song. ${cur.chart && cur.chart.tempo ? "" : "This song's tempo isn't known yet, so it starts at " + DEFAULT_BPM + "."}</p>`);
  // Steps repeat while held, without reopening.
  p.querySelectorAll("[data-step]").forEach((b) => {
    const nb = b.cloneNode(true);
    b.replaceWith(nb);
    holdable(nb, () => tempoBy(+nb.dataset.step));
  });
}

function openCapo() {
  const b = base();
  const names = soundingNames(b).map((n) => (cur.prefs.simple ? simplifyChord(n) : n));
  const sug = suggestCapo(names, { key: soundingKey(b)?.key || null });
  const shapes = [...new Set(Object.values(sug.shapes))].slice(0, 6).map(prettyChord).join(" ");
  const html = `<div class='popover-head'><span class='popover-name' style='font-size:20px'>Capo</span></div>
    <div class='seg capo-grid' role='group' aria-label='Capo fret'>${[0, 1, 2, 3, 4, 5, 6, 7].map((c) =>
      `<button data-capo='${c}' class='${c === capoNow() ? "on" : ""}'>${c}</button>`).join("")}</div>
    <p class='note'>Suggested: <b>capo ${sug.capo}</b>${shapes ? `, playing ${esc(shapes)}` : ""}. ${cur.mode === "sheet" ? "The sheet" : "The chart"} is written for capo ${b.capo || 0}. The chords sound the same at any capo; only the shapes change.</p>
    <div style='display:flex;gap:8px'><button class='btn outline' style='flex:1' data-capo='${sug.capo}'>Use capo ${sug.capo}</button>
    <button class='btn outline' style='flex:1' data-close>Done</button></div>`;
  const p = showPopover(html, "Capo");
  p.querySelectorAll("[data-capo]").forEach((btn) => btn.addEventListener("click", () => {
    setPrefs({ capo: +btn.dataset.capo });
    openCapo();
  }));
}

/* ---- The sheet editor (#/song/<id>/edit) ---- */

function renderEditor() {
  stopAll();
  const { view } = cur;
  const s = cur.sheet;
  const back = `#/song/${encodeURIComponent(cur.id)}/${s ? "sheet" : "chords"}`;
  const web = s && s.source === "web";
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='${back}' aria-label='Cancel'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>${s ? "Edit sheet" : "Paste a sheet"}</div><div class='meta'>${esc(songTitle())}${songArtist() ? " · " + esc(songArtist()) : ""}</div></div>
      <button class='btn primary small' data-act='save'>Save</button>
    </div>
    <div class='song-body'><div class='song-scroll' id='song-scroll'><div class='song-main-col'>
      <p class='note'>Paste chords over lyrics (the way Ultimate Guitar shows them) or ChordPro. Headings like [Verse] or Chorus: and lines like "Capo 3" are recognised. The sheet stays on this device.</p>
      <label class='sr-only' for='sheet-text'>Sheet text</label>
      <textarea id='sheet-text' class='editor' wrap='off' spellcheck='false' autocapitalize='off' autocomplete='off' autocorrect='off'
        placeholder='[Verse 1]&#10;G              Em7&#10;Words of the song go here'>${esc(s ? s.chordpro : "")}</textarea>
      <div class='card set-group'>
        <div class='set-row'><div><div class='set-label'>Where are these chords from?</div><div class='meta'>Every chart says where its chords came from.</div></div></div>
        <div class='seg' role='group' aria-label='Source' style='margin-bottom:12px'>
          <button data-src='mine' class='${web ? "" : "on"}' aria-pressed='${!web}'>Mine</button>
          <button data-src='web' class='${web ? "on" : ""}' aria-pressed='${web}'>A website</button></div>
        <label class='field ${web ? "" : "hidden"}' id='src-url-field' style='margin-bottom:12px'><span>Link to the page</span>
          <input id='src-url' type='url' inputmode='url' autocomplete='off' placeholder='https://' value='${esc(web && s.sources[0] ? s.sources[0].url : "")}'></label>
      </div>
      ${s ? "<div><button class='btn outline' data-act='delete-sheet'>Delete this sheet</button></div>" : ""}
    </div></div></div>`;
  let source = web ? "web" : "mine";
  view.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => {
    source = b.dataset.src;
    view.querySelectorAll("[data-src]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
    view.querySelector("#src-url-field").classList.toggle("hidden", source !== "web");
  }));
  view.querySelector("[data-act=save]").addEventListener("click", () => saveEditor(source));
  const del = view.querySelector("[data-act=delete-sheet]");
  if (del) del.addEventListener("click", async () => {
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Tap again to delete"; return; }
    await deleteSheet(cur.id);
    const id = await reload();
    location.hash = `#/song/${encodeURIComponent(id)}/chords`;
  });
}

async function saveEditor(source) {
  const text = cur.view.querySelector("#sheet-text").value;
  if (!text.trim()) { toast("Paste a sheet first."); return; }
  let sources = [];
  if (source === "web") {
    const url = cur.view.querySelector("#src-url").value.trim();
    let u;
    try { u = new URL(url); } catch (e) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) { toast("Add the link to the page these chords are from."); return; }
    sources = [{ label: u.hostname.replace(/^www\./, ""), url: u.href }];
  }
  const chordpro = importText(text, { title: songTitle(), artist: songArtist() });
  const doc = parseChordPro(chordpro);
  if (!docChords(doc).length) toast("No chords found in that text; saved as lyrics only.", 3500);
  await saveSheet({ id: cur.id, chordpro, source, sources });
  const id = await reload();
  location.hash = `#/song/${encodeURIComponent(id)}/sheet`;
}

// For tests and the desktop shortcuts.
export const songState = () => cur && {
  timing: cur.timing, sync: cur.sync && { next: cur.sync.next, have: [...cur.sync.have] },
  id: cur.id, mode: cur.mode, prefs: { ...cur.prefs },
  displayed: base() ? uniqueDisplayed(base(), makeDisp(base())) : [],
  bars: base() ? playBars() : [], scrolling: scroll.on, speed: SPEEDS[scroll.idx],
};
export { getPlayer };
