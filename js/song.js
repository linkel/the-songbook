// The song view (#/song/<id>/<mode>): Sheet (chords over lyrics), Chords
// (sections as bars), Picking (js/picking.js), Player (js/player.js) and the sheet editor
// (#/song/<id>/edit). Transpose, Simple, Aa and Capo, chord popovers,
// auto-scroll, and Play (the app guitar strums or picks the chart, with the
// sheet or bars lit as it goes; with a recording, the sheet plays that and
// follows its lyric timing). Tap-to-sync and LRCLIB lookups set the timing.

import { loadPrefs, savePrefs, getEntry, getSheet, saveSheet, deleteSheet, deleteManualSong, get, shippedChart, deleteChart } from "./library.js";
import { recordingMeta, fmtBytes } from "./recordings.js";
import { openReview, closeReview, resetReview } from "./review.js";
import {
  displayChord, transposeChord, transposeKey, guessKey, splitBars, voicingsFor, pimaChord, suggestCapo,
  prettyChord, simplifyChord, specFrets, fretsSpec, voicingMidi, chordPcs,
} from "./chords.js";
import { parseChordPro, importText, docChords, sheetChart } from "./chordpro.js";
import { sheetHtml } from "./sheet.js";
import { chordBoxSvg, fretPickerHtml, wireFretPicker } from "./diagram.js";
import { songTuning, tuningFrom, PRESETS, parseTuning, nameFor, stringNames } from "./tuning.js";
import { ChartPlayer, meter } from "./chartplay.js";
import { StringVoices, strum, resumeAudio, warmNotes, plainStrum, audioContext } from "./audio.js";
import { PATTERN_BY_ID, noteSound } from "./patterns.js";
import { esc, sourceBadge, sourceSentence, pickingLabel, patternName, ICONS, toast, showPopover, closePopover } from "./ui.js";
import { invalidateSongs } from "./songs.js";
import { openPlayer, leavePlayerView, closePlayer, pitchShift, playerNow, onPlayerFrame, togglePlayer as toggleRecording, playRecording,
  setPartLayer, setPartAB, partAB } from "./player.js";
import { findSections } from "./detect.js";
import { lyricLines, getTiming, saveTiming, lineAt, findSyncedLyrics, alignToSheet, sheetFromTiming, retime } from "./lyrics.js";
import { lrclibOn } from "./prefs.js";
import { patternFor, patternBadge, sectionBars, fingersHtml, diagramSvg, notationHtml, patternListHtml, pimapeggioLink, pimapeggioAvailable, HOME } from "./picking.js";
import { loadParts, saveSectionPart, checkedPart } from "./part.js";
import { helperUrl, alignOnPc } from "./helper-client.js";
import { pcJob, onPcJob, startPcJob, clearPcJob } from "./pcjob.js";
import { stripHtml, openBarEditor, partPlayBars, barAsPattern, barChord, expanded } from "./partedit.js";
import { partSheetHtml, partBarsHtml, tabLegend, defaultPartView, litTabStep, PART_VIEWS } from "./tab.js";
import { bandTimeline } from "./band.js";
import { checkArrangement } from "./bundle.js";

const MODES = [["sheet", "Sheet"], ["chords", "Chords"], ["picking", "Picking"], ["player", "Player"]];
const READY = new Set(["sheet", "chords", "picking", "edit", "analyse", "player"]);
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
    player.addEventListener("step", (e) => pickStep(e.detail.step));
    player.addEventListener("chord", (e) => pickChord(e.detail));
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

// The tuning the song is played in (yours, else the chart's), with every
// shape, diagram and note in it.
const tun = () => songTuning(cur.chart || cur.shipped, cur.prefs);

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
      const v = voicingsFor(d, vm, tun())[0];
      return { name: d, frets: v ? v.frets : null, pima: v ? pimaChord(d, { [d]: v.spec }, tun()) : null };
    }),
  }));
}

// What Play will play, said plainly.
function playPlan() {
  if (cur.mode === "picking") {
    const { pf } = pickPlan();
    return { text: pf.pattern ? `Picking ${pf.pattern.name} over this section, looped${pf.mine ? " (your pick)" : ""}` : "Choose a pattern to hear it" };
  }
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

// What Play plays: your recording (or its stems, or the one that comes with
// the song), or the app's synth. Your choice per song; the recording when
// there is one, until you choose.
const hasRecording = () => !!(cur.rec || (cur.chart && (cur.chart.audio || cur.chart.stems)) || (cur.shipped && (cur.shipped.audio || cur.shipped.stems)));
const playSource = () => (hasRecording() && (cur.prefs || {}).playSource !== "synth" ? "recording" : "synth");
const recPlayingHere = () => { const pn = playerNow(); return !!(pn && pn.id === cur.id && pn.playing); };

/* ---- Opening ---- */

export async function openSong(view, id, mode, arg = null) {
  if (!cur || cur.id !== id) {
    stopAll();
    const [entry, device, shipped, sheet, rec, timing, parts] = await Promise.all([
      getEntry(id), get("charts", id).catch(() => null), shippedChart(id).catch(() => null), getSheet(id), recordingMeta(id), getTiming(id), loadParts(id)]);
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
    cur = { id, entry, chart, device, shipped, rec, sheet, doc, sChart, timing, parts, prefs: null, mode: null, view, showCited: false, sync: null, partSel: 0 };
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
      id: cur.id, title: songTitle(), artist: songArtist(), chart: cur.device, shipped: cur.shipped, tuning: tun(),
      cited: hasChords(cur.shipped) ? cur.shipped : null, prefs: cur.prefs,
      setCapo: (c) => { cur.prefs.capo = c; savePrefs(cur.id, cur.prefs); },
      onSaved: async () => { const id = await reload(); location.hash = `#/song/${encodeURIComponent(id)}/chords`; },
      // For the PC: your sheet's lyric lines (by their index in the sheet), to line up with the singing.
      lyrics: cur.doc ? lyricLines(cur.doc).map((x, index) => ({ index, text: x.text })).filter((x) => x.text) : null,
      lyricCount: cur.doc ? lyricLines(cur.doc).length : 0,
      onImported: async () => {
        const id = await reload();
        resetReview();
        closePlayer();
        if (location.hash === `#/song/${encodeURIComponent(id)}/analyse`) await openSong(cur ? cur.view : document.getElementById("view-song"), id, "analyse");
      },
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
        ${mode === "sheet" ? sheetBody(b, disp) : mode === "picking" ? pickingBody(b, disp) : chordsBody(b, disp)}
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
  if (mode === "picking") checkPimapeggio();
}

function modesSeg(mode) {
  return `<div class='seg' role='tablist' aria-label='Mode'>${MODES.map(([m, label]) =>
    `<button role='tab' data-mode='${m}' class='${m === mode ? "on" : ""}' aria-selected='${m === mode}'
      ${READY.has(m) ? "" : "disabled title='Coming in a later update'"}>${label}</button>`).join("")}</div>`;
}

/* ---- Picking mode ---- */

function pickSection(b) {
  const n = (b && b.sections ? b.sections.length : 0);
  return Math.max(0, Math.min(cur.pickSec === "all" ? 0 : cur.pickSec || 0, n - 1));
}

function pickPlan(si = null) {
  const b = base();
  if (si === null) si = pickSection(b);
  const sec = b && b.sections ? b.sections[si] : null;
  const pf = patternFor(cur.chart || b, sec, cur.prefs);
  const bars = hasChords(b) ? sectionBars(b, si, makeDisp(b), voicingMap(b), tun()) : [];
  // The section's guitar part: yours on this device, else the chart's.
  const devicePart = sec && cur.parts && cur.parts[sec.name];
  const part = devicePart || (sec && sec.part) || null;
  const ctx = part && bars.length ? partCtx(b, sec, bars, part, devicePart ? "device" : "chart") : null;
  return { b, si, sec, pf, bars, part, ctx };
}

// What the part editor (js/partedit.js) works on.
function partCtx(b, sec, bars, part, partFrom) {
  const ctx = {
    bars, part, partFrom, sectionName: sec.name, beats: meter((b && b.time) || "4/4").beats, tuning: tun(), capo: capoNow(),
    hear: (frets) => hear(frets),
  };
  // Saving keeps the edit on this device; the editor carries on with it.
  ctx.save = async (p) => {
    cur.parts = await saveSectionPart(cur.id, sec.name, p);
    ctx.part = p;
    ctx.partFrom = "device";
    render();
    if (player && player.playing && cur.mode === "picking") player.setBars(partPlayBars(ctx));
  };
  ctx.playBar = async (i) => {
    const pl = getPlayer();
    if (pl.playing) pl.stop();
    await pl.start({ bars: [partPlayBars(ctx)[i]], parts: true, bpm: tempo(), time: (b && b.time) || "4/4", capo: capoNow(), countIn: false, loop: false, open: tun().open });
  };
  return ctx;
}

/* ---- A part played along with the recording (plan §8.4 step 8: review) ---- */

// The recording's bars grouped into the sections they belong to: [{ name, bars: [bar indexes] }].
function timedSpans(c) {
  const segs = c.analysis && Array.isArray(c.analysis.segments) && c.analysis.segments.length ? c.analysis.segments : null;
  if (segs && segs.every((x) => x.bars[1] < c.bars.length)) return segs.map((x) => ({ name: x.name, bars: Array.from({ length: x.bars[1] - x.bars[0] + 1 }, (_, k) => x.bars[0] + k) }));
  const { form, spans } = findSections(c.bars);
  return form.map((name, i) => ({ name, bars: spans[i] }));
}

// Every note of every section's part, in song time, at the recording's pitch
// (the player shifts it with the recording): [{ t, string, midi, level, sec, bar }].
// c: a chart with bar times (the recording's, or the synth band's timeline);
// patterns: sections without a part play their picking pattern (the band),
// and covered (a Set) collects the bars that got notes.
function partAlongEvents(c = timedChart(), { patterns = false, covered = null } = {}) {
  if (!c || !Array.isArray(c.bars) || !c.bars.length || typeof c.bars[0].t !== "number") return [];
  const k = soundingKey(c);
  const shapeKey = k ? transposeKey(k.key, -capoNow()) : null;
  const disp0 = (name) => displayChord(name, c, { transpose: 0, capo: capoNow(), simple: false, shapeKey });
  const vm = voicingMap(c);
  const events = [];
  for (const span of timedSpans(c)) {
    const si = (c.sections || []).findIndex((s) => s.name === span.name);
    if (si < 0) continue;
    const sec = c.sections[si];
    const pf = patterns ? patternFor(cur.chart || c, sec, cur.prefs) : null;
    const part = (cur.parts && cur.parts[sec.name]) || sec.part || (pf && pf.pattern ? { source: "mine", bars: [{ pattern: pf.pattern.id }] } : null);
    if (!part) continue;
    const bars = sectionBars(c, si, disp0, vm, tun());
    const ctx = partCtx(c, sec, bars, part, "device");
    const pb = partPlayBars(ctx);
    span.bars.forEach((bi, kk) => {
      // A section played more than once (repeat) plays its part again.
      const tb = c.bars[bi], b = pb.length ? pb[kk % pb.length] : null;
      if (!tb || !b || !b.part) return;
      if (covered) covered.add(bi);
      const t0 = tb.t, t1 = c.bars[bi + 1] ? c.bars[bi + 1].t : t0 + 2;
      const n = b.part.steps.length;
      b.part.steps.forEach((st, j) => {
        const ch = b.chords[Math.min(b.chords.length - 1, Math.floor(j * b.chords.length / n))];
        if (!ch || !ch.pima) return;
        const t = t0 + (t1 - t0) * j / n;
        const level = 0.36 / Math.sqrt(Math.max(1, st.length));
        for (const nt of st) {
          const x = noteSound(nt, ch.pima, HOME, capoNow(), tun().open);
          const l = (nt.f === "p" ? level * 1.15 : level) * (x.mute ? 0.5 : 1);
          events.push({ t, string: x.string, midi: x.midi, level: l, mute: x.mute, sec: sec.name, bar: kk });
          if (x.to) events.push({ t: t + (t1 - t0) / n / 2, string: x.string, midi: x.to.midi, level: l * 0.7, sec: sec.name, bar: kk });
        }
      });
    });
  }
  return events.sort((a, b) => a.t - b.t);
}

async function playPartAlong() {
  const ev = partAlongEvents();
  if (!ev.length) { toast("The chart's bars need times for that: analyse your recording first."); return; }
  setPartLayer(cur.id, ev);
  const pn = playerNow();
  if (player && player.playing) player.stop();
  if (pn && pn.id === cur.id && pn.playing) { await toggleRecording(); updatePartAlong(); return; }
  await playRecording(playerCtx());
  setPartAB(cur.partAB || "both");
  updatePartAlong();
}

function updatePartAlong() {
  if (!cur || cur.mode !== "picking") return;
  const pn = playerNow();
  const b = cur.view.querySelector("[data-act=part-along]");
  if (b) b.textContent = pn && pn.id === cur.id && pn.playing ? "❚❚ Pause" : "▶ Play along";
  cur.view.querySelectorAll("[data-ab]").forEach((x) => { const on = x.dataset.ab === partAB(); x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); });
}

// The recording started or stopped (from any screen): Play says so.
onPlayerFrame((f) => {
  if (!cur || !cur.prefs || f.id !== cur.id || !cur.view || cur.mode === "player") return;
  if (f.playing !== cur.recState) { cur.recState = f.playing; updateTransport(); }
});

// While the recording plays, the strip lights the bar it's in (when it's in this section).
let partLit = null;
onPlayerFrame((f) => {
  if (!cur || f.id !== cur.id || cur.mode !== "picking" || !cur.view) return;
  if (f.playing !== cur.alongPlaying) { cur.alongPlaying = f.playing; updatePartAlong(); }
  const c = timedChart();
  if (!c || !c.bars || typeof (c.bars[0] || {}).t !== "number") return;
  let bi = -1;
  for (let i = 0; i < c.bars.length && c.bars[i].t <= f.pos + 0.02; i++) bi = i;
  // The whole song: whichever section it's in (the spans are the form, in order).
  const whole = cur.pickSec === "all";
  const spans = timedSpans(c);
  const { sec } = pickPlan();
  const fi = whole ? spans.findIndex((s) => s.bars.includes(bi)) : -1;
  const span = whole ? spans[fi] : sec && spans.find((s) => s.name === sec.name && s.bars.includes(bi));
  const k = span ? span.bars.indexOf(bi) : -1;
  const litKey = whole ? fi + ":" + k : k;
  if (litKey !== partLit) {
    partLit = litKey;
    cur.view.querySelectorAll(".pbar.on").forEach((x) => x.classList.remove("on"));
    if (k >= 0) {
      const el = cur.view.querySelector(whole ? `.tab-bar[data-form='${fi}'][data-pbar='${k}']` : `.pbar[data-pbar='${k}']`);
      if (el) { el.classList.add("on"); if (el.classList.contains("tab-bar")) follow(el); }
      showPartBar(k);
    }
  }
  // On the tab, the step too.
  if (k >= 0 && cur.view.querySelector(".tab-bar.on")) {
    const { ctx } = pickPlan();
    const e = ctx && expanded(ctx)[k];
    const t0 = c.bars[bi].t, t1 = c.bars[bi + 1] ? c.bars[bi + 1].t : t0 + 2;
    litTabStep(cur.view, e && e.steps ? Math.min(e.steps.length - 1, Math.floor((f.pos - t0) / (t1 - t0) * e.steps.length)) : -1);
  }
});

// How the part shows: as tab, notation, or the picking stage: yours, else
// what suits the part when you opened it (so it doesn't switch as you write).
function partView(ctx) {
  const v = cur.prefs.partView;
  if (PART_VIEWS.some(([id]) => id === v)) return v;
  cur.partViews = cur.partViews || {};
  return (cur.partViews[ctx.sectionName] = cur.partViews[ctx.sectionName] || defaultPartView(ctx));
}

// The stage shows a bar of the part: the one you chose, or the one playing.
function showPartBar(i) {
  const { ctx } = pickPlan();
  if (!ctx) return;
  const p = barAsPattern(ctx, i);
  const v = cur.view;
  const fingers = v.querySelector(".fingers"), stage = v.querySelector(".pick-stage"), nota = v.querySelector(".pick-notation");
  if (!p) return;
  const ch = barChord(ctx, i).pima;
  if (fingers) fingers.outerHTML = fingersHtml(p);
  if (stage) stage.innerHTML = diagramSvg(p, ch, tun().open);
  if (nota) nota.outerHTML = notationHtml(p, ch, tun().open);
  const head = v.querySelector(".part-bar-name");
  if (head) head.textContent = `Bar ${i + 1}: ${p.name}`;
}

function partBody(b, pills, plan) {
  const { sec, ctx, part } = plan;
  const i = Math.min(cur.partSel || 0, ctx.bars.length - 1);
  const p = barAsPattern(ctx, i);
  const ch = barChord(ctx, i).pima;
  const sel = ctx.bars[i];
  const pv = partView(ctx);
  const views = `<div class='seg small-seg part-views' role='group' aria-label='Show the part as'>${PART_VIEWS.map(([id, label]) =>
    `<button data-pview='${id}' class='${id === pv ? "on" : ""}' aria-pressed='${id === pv}'>${label}</button>`).join("")}</div>`;
  const body = pv === "picking" ? `
      ${p ? fingersHtml(p) : "<div class='fingers'></div>"}
      <div class='pick-stage'>${p ? diagramSvg(p, ch, tun().open) : ""}</div>
      ${p ? notationHtml(p, ch, tun().open) : "<div class='pick-notation'></div>"}
      ${stripHtml(ctx, i)}
      <p class='note' style='margin:8px 0 0'>Tap a bar to choose its pattern, write it out or give it a shape of its own.</p>`
    : `${partSheetHtml(ctx, pv, i)}
      <p class='note' style='margin:8px 0 0'>Tap a bar to edit it.</p>`;
  const pimaArgs = { bars: [sel], capo: capoNow(), bpm: tempo(), name: `${songTitle()} · ${sec.name}, bar ${i + 1}`, tuning: tun(), beats: ctx.beats };
  const link = p && p.id && !p.steps.some((st) => st.some((n) => n.fret !== undefined || n.tech || n.mute)) && PATTERN_BY_ID.has(p.id)
    ? pimapeggioLink({ ...pimaArgs, pattern: PATTERN_BY_ID.get(p.id) }) : p ? pimapeggioLink({ ...pimaArgs, steps: p.steps }) : null;
  return `${pills}
    <div class='card pick-card'>
      <div class='sec-head'><span class='sec-name'>${esc(sec.name)}${pv === "picking" ? ` · <span class='part-bar-name nowrap'>${p ? `Bar ${i + 1}: ${esc(p.name)}` : `Bar ${i + 1}`}</span>` : ""}</span>${partBadge(part)}</div>
      ${views}
      ${body}
    </div>
    ${partInfoCard(plan, i, link)}`;
}

function partBadge(part) {
  return part.source === "detected" ? "<span class='badge detected'>Detected part · check</span>"
    : part.source === "web" ? "<span class='badge web'>Tab · cited</span>"
    : part.source === "verified" ? "<span class='badge verified'>Verified part</span>" : "<span class='badge mine'>Your part</span>";
}

// Where the part is from, what to do with it, and playing it along with the
// recording. i: the selected bar (null in the whole-song view).
function partInfoCard(plan, i, link = null) {
  const { ctx, part } = plan;
  const prov = part.source === "detected"
    ? `Detected from your recording by ${esc(part.detector || "the PC helper")}. The notes and frets are a best guess; which finger plays each one is inferred, not heard. Bars marked ? were unsure. Play it along with the recording, fix what's off, then mark it as checked.`
    : part.source === "web" ? `From ${esc(part.from)}. The notes and frets are the tab's; which finger picks each one is inferred (a tab doesn't say). Edit a bar and the part becomes yours.`
    : part.editedFrom ? `Yours, edited from ${esc(part.editedFrom)}.`
    : part.checkedFrom ? `Yours: detected by ${esc(part.checkedFrom)}, then checked by you.`
    : ctx.partFrom === "chart" ? (part.source === "mine" ? "Your description, from the chart." : "From the chart.") : "Yours, written here.";
  return `<div class='card set-group'>
      <div class='set-row'><div><div class='set-label'>Guitar part</div><div class='meta'>${prov}</div></div></div>
      <div class='row-btns' style='flex-wrap:wrap;padding-bottom:10px'>
        ${i !== null ? `<button class='btn outline small' data-act='part-edit'>Edit bar ${i + 1}</button>` : ""}
        ${part.source === "detected" ? "<button class='btn outline small' data-act='part-check'>Mark as checked</button>" : ""}
        ${part.source === "web" && part.url ? `<a class='btn outline small' href='${esc(part.url)}' target='_blank' rel='noopener'>Where it's from</a>` : ""}
        ${i !== null && ctx.partFrom === "device" ? "<button class='btn outline small' data-act='part-delete'>Delete your part</button>" : ""}
      </div>
      ${timedChart() && timedChart().bars && typeof (timedChart().bars[0] || {}).t === "number" && (cur.rec || (cur.chart && cur.chart.audio) || (cur.shipped && cur.shipped.audio)) ? `
      <div class='set-row'><div><div class='set-label'>With the recording</div><div class='meta'>The app plays the part along with your recording, on its beats at any speed${part.source === "detected" ? ": hear where it's off" : ""}. A/B it against the recording's guitar (the guitar stem, if the PC made stems).</div></div>
        <button class='btn outline small' data-act='part-along'>▶ Play along</button></div>
      <div class='seg small-seg' role='group' aria-label='Hear' style='margin-bottom:10px'>
        <button data-ab='both'>Both</button><button data-ab='recording' aria-label="The recording's guitar only">Recording</button><button data-ab='part' aria-label='The part only'>Part</button></div>` : ""}
      ${link ? `<div class='set-row'><div><div class='set-label'>Practise in Pimapeggio</div><div class='meta' id='pima-note'>Bar ${i + 1} in the full trainer, with the tempo ladder.</div></div>
        <a class='btn outline small' id='pima-link' href='${esc(link)}' target='_blank' rel='noopener'>Open</a></div>` : ""}
    </div>`;
}

// The whole song in the order it's played (its form, repeats played out):
// [{ fi, si, plan, start (bars before it) }].
function wholePlan() {
  const b = base();
  const secs = (b && b.sections) || [];
  const form = b && b.form && b.form.length ? b.form : secs.map((s) => s.name);
  const out = [];
  let start = 0;
  const plans = new Map();
  for (const name of form) {
    const si = secs.findIndex((s) => s.name === name);
    if (si < 0) continue;
    if (!plans.has(si)) plans.set(si, pickPlan(si));
    const plan = plans.get(si);
    for (let r = 0; r < Math.max(1, secs[si].repeat || 1); r++) {
      out.push({ fi: out.length, si, plan, start });
      start += plan.bars.length;
    }
  }
  return out;
}

// What the whole song plays in Picking mode: each section's part, else its
// picking pattern, else silence over its chords (still lit as it goes by).
function wholePlayBars() {
  const b = base();
  return wholePlan().flatMap(({ fi, si, plan }) => {
    let ctx = plan.ctx;
    if (!ctx && plan.pf.pattern && plan.bars.length) ctx = partCtx(b, plan.sec, plan.bars, { source: "mine", bars: [{ pattern: plan.pf.pattern.id }] }, "chart");
    const bars = ctx ? partPlayBars(ctx) : plan.bars.map((x) => ({ ...x, part: { steps: Array.from({ length: 8 }, () => []) } }));
    return bars.map((x) => ({ ...x, form: fi, sec: si }));
  });
}

// The lyric lines sung from each bar of the whole song, by their timing on
// the recording: Map(form index -> Map(bar in the section -> words)), or null
// with no timed lyrics.
function wholeLyrics(entries) {
  const c = timedChart();
  if (!cur.doc || !cur.timing || !cur.timing.lines.length || !c || !Array.isArray(c.bars) || typeof (c.bars[0] || {}).t !== "number") return null;
  const spans = timedSpans(c);
  if (spans.length !== entries.length) return null;
  const lines = lyricLines(cur.doc);
  const out = new Map();
  for (const x of [...cur.timing.lines].sort((a, b) => a.t - b.t)) {
    const text = lines[x.index] && lines[x.index].text;
    if (!text) continue;
    let bi = -1;
    for (let i = 0; i < c.bars.length && c.bars[i].t <= x.t + 0.25; i++) bi = i;
    const fi = spans.findIndex((s) => s.bars.includes(bi));
    if (fi < 0) continue;
    const k = spans[fi].bars.indexOf(bi);
    if (!out.has(fi)) out.set(fi, new Map());
    const m = out.get(fi);
    m.set(k, m.has(k) ? m.get(k) + " / " + text : text);
  }
  return out;
}

const shippedLyricTimes = () => (cur.chart && cur.chart.lyricTiming) || (cur.shipped && cur.shipped.lyricTiming) || null;

// The whole song's tab (or notation), section after section.
function wholeBody(b, pills) {
  const entries = wholePlan();
  const lyr = cur.prefs.tabLyrics ? wholeLyrics(entries) : null;
  const first = entries.find((e) => e.plan.ctx);
  const pv = cur.prefs.partView === "notation" ? "notation" : "tab";
  const views = `<div class='seg small-seg part-views' role='group' aria-label='Show the part as'>${PART_VIEWS.filter(([id]) => id !== "picking").map(([id, label]) =>
    `<button data-pview='${id}' class='${id === pv ? "on" : ""}' aria-pressed='${id === pv}'>${label}</button>`).join("")}</div>`;
  const total = entries.reduce((n, e) => n + e.plan.bars.length, 0);
  const secHtml = entries.map(({ fi, si, plan, start }) => {
    const head = `<div class='whole-sec'><span class='sec-name'>${esc(plan.sec.name)}</span><span class='meta'>bars ${start + 1}–${start + plan.bars.length}</span></div>`;
    if (plan.ctx) return `${head}<div class='tab-sheet pv-${pv}'>${partBarsHtml(plan.ctx, pv, -1, { start, form: fi, sec: si, lyrics: lyr ? lyr.get(fi) || new Map() : null })}</div>`;
    // No part: its chords, a bar each; tapping one goes to the section.
    return `${head}<div class='tab-sheet pv-${pv}'>${plan.bars.map((x, k) => `<button class='pbar tab-bar empty' data-pbar='${k}' data-form='${fi}' data-sec='${si}' aria-label='Bar ${start + k + 1}: ${esc(x.chords.map((c) => c.name).join(" "))}, no part'><span class='meta'>${start + k + 1} · ${esc(x.chords.map((c) => prettyChord(c.name)).join(" "))}</span></button>`).join("")}</div>`;
  }).join("");
  const canLyrics = !!wholeLyrics(entries);
  const lyrBtn = `<button class='tool ${cur.prefs.tabLyrics && canLyrics ? "on" : ""}' data-act='tab-lyrics' aria-pressed='${!!(cur.prefs.tabLyrics && canLyrics)}'>Lyrics</button>`;
  return `${pills}
    <div class='card pick-card whole'>
      <div class='sec-head'><span class='sec-name'>Whole song</span><span class='meta'>${total} bars</span></div>
      <div class='views-row'>${views}${lyrBtn}</div>
      ${cur.prefs.tabLyrics && !canLyrics ? (shippedLyricTimes() && lrclibOn() && !cur.doc
        ? `<div class='set-row'><div class='meta'>This song's words are lined up with its recording; LRCLIB has them (it sends the title and artist to lrclib.net).</div><button class='btn outline small' data-act='lrclib-here'>Get lyrics</button></div>`
        : `<p class='note'>No lyrics timed to the recording yet. In Sheet, Find on LRCLIB gets the words; then Sync lines them up with your recording${helperUrl() ? " (Line up on my PC)" : ""}.</p>`) : ""}
      ${first ? tabLegend(first.plan.ctx, pv) : ""}
      ${secHtml}
      <p class='note' style='margin:8px 0 0'>Tap a bar to edit it. Play goes through the whole song.</p>
    </div>
    ${first ? partInfoCard(first.plan, null) : ""}`;
}

function pickingBody(b, disp) {
  const plan = pickPlan();
  const { si, sec, pf, bars } = plan;
  const secs = (b && b.sections) || [];
  const hasPart = (x) => (cur.parts && cur.parts[x.name]) || x.part;
  const anyPart = secs.some(hasPart);
  // A song written out all through (a tab) opens on the whole song.
  if (cur.pickSec === undefined && secs.length > 1 && secs.every(hasPart) && cur.prefs.partView !== "picking") cur.pickSec = "all";
  const all = cur.pickSec === "all";
  const pills = secs.length > 1 ? `<div class='pills' role='group' aria-label='Section'>${anyPart ? `<button class='pill ${all ? "on" : ""}' data-pick-sec='all' aria-pressed='${all}'>Whole song</button>` : ""}${secs.map((x, i) =>
    `<button class='pill ${!all && i === si ? "on" : ""}' data-pick-sec='${i}' aria-pressed='${!all && i === si}'>${esc(x.name)}${(cur.parts && cur.parts[x.name]) || x.part ? " ·" : ""}</button>`).join("")}</div>` : "";
  if (all && anyPart) return wholeBody(b, pills);
  if (plan.ctx) return partBody(b, pills, plan);
  if (!pf.pattern) {
    return `${pills}<div class='card empty'><b>No picking pattern for this song.</b><br>Nothing is guessed: choose a pattern to try over ${sec ? esc(sec.name) : "its chords"}, and it's labelled as your pick.
      <div style='margin-top:12px;display:flex;gap:8px;flex-wrap:wrap'><button class='btn primary' data-act='pick-pattern'>Choose a pattern</button>
      ${bars.length ? "<button class='btn outline' data-act='part-new'>Write a part bar by bar</button>" : ""}</div>
      ${bars.length && pcPartJob() ? `<div style='margin-top:12px'>${pcPartRow()}</div>` : ""}</div>`;
  }
  const p = pf.pattern;
  const first = bars.find((x) => x.chords[0] && x.chords[0].pima);
  const chord = (first && first.chords[0].pima) || pimaChord("C", null, tun());
  const noChords = !bars.length;
  const pk = pf.picking;
  const prov = pf.mine
    ? `<div class='note'>Your pick${pf.options.length ? `; the song's ${pf.options.length > 1 ? "patterns are" : "pattern is"} ${pf.options.map((id) => esc(patternName(id))).join(", ")}` : ""}.</div>`
    : pk ? `${pk.description ? `<div class='note'>${esc(pk.description)}</div>` : ""}
      <div class='note' style='margin-top:6px'>Pattern: ${esc(pickingLabel(pk).text)}${pk.match ? `, ${esc(pk.match)} match to the song` : ""}${pk.part ? ` (${esc(pk.part)})` : ""}.</div>${provenance(pk, pk.sources)}` : "";
  return `${pills}
    <div class='card pick-card'>
      <div class='sec-head'><span class='sec-name'>${sec ? esc(sec.name) + " · " : ""}<span class='nowrap'>${esc(p.name)}</span></span>${patternBadge(pf)}</div>
      ${fingersHtml(p)}
      <div class='pick-stage'>${diagramSvg(p, chord, tun().open)}</div>
      ${notationHtml(p, chord, tun().open)}
      ${noChords ? "<p class='note'>No chords yet for this song: shown over C.</p>"
        : `<div class='bars'>${bars.map((x) => `<button class='bar' data-sec='${x.sec}' data-bar='${x.bar}' aria-label='Bar ${x.bar + 1}: ${esc(x.chords.map((c) => c.name).join(" "))}'>${x.chords.map((c) =>
          `<span class='ch'>${esc(prettyChord(c.name))}</span>`).join("")}</button>`).join("")}</div>`}
    </div>
    <div class='card set-group'>
      <div class='set-row'><div style='min-width:0'><div class='set-label'>Pattern</div><div class='meta ellipsis'>${esc(p.name)}${p.name !== p.letters ? " · " + esc(p.letters) : ""}</div></div>
        <button class='btn outline small' data-act='pick-pattern'>Change</button></div>
      ${pf.mine && pf.options.length ? `<div class='set-row'><div class='meta'>Back to the song's ${esc(patternName(pf.options[0]))}.</div><button class='btn outline small' data-act='pick-reset'>Use it</button></div>` : ""}
      ${noChords ? "" : pcPartRow()}
      ${noChords ? "" : `<div class='set-row'><div><div class='set-label'>Bar by bar</div><div class='meta'>For picking that changes, or shapes of your own: a part for ${esc(sec ? sec.name : "this section")}, starting from this pattern.</div></div>
        <button class='btn outline small' data-act='part-new'>Write a part</button></div>`}
      <div class='set-row'><div><div class='set-label'>Practise in Pimapeggio</div><div class='meta' id='pima-note'>The full trainer, with the tempo ladder, on this pattern over ${noChords ? "C" : esc(sec ? sec.name : "these chords")}.</div></div>
        <a class='btn outline small' id='pima-link' href='${esc(pimapeggioLink({ pattern: p, bars: noChords ? [{ chords: [{ name: "C", spec: "x32010" }] }] : bars, capo: capoNow(), bpm: tempo(), name: `${songTitle()}${sec ? " · " + sec.name : ""}`, tuning: tun() }))}' target='_blank' rel='noopener'>Open</a></div>
    </div>
    ${prov ? `<div class='card sources'>${prov}</div>` : ""}`;
}

// Pimapeggio isn't online everywhere yet: say so instead of a dead link.
async function checkPimapeggio() {
  const ok = await pimapeggioAvailable();
  if (ok || !cur || cur.mode !== "picking") return;
  const a = cur.view.querySelector("#pima-link"), note = cur.view.querySelector("#pima-note");
  if (a) { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); a.classList.add("disabled"); a.textContent = "Not online yet"; }
  if (note) note.textContent = "Pimapeggio isn't online here yet. Once it's deployed next to the Songbook, this opens it on this pattern and section.";
}

function openPatternChooser() {
  const { pf } = pickPlan();
  const pop = showPopover(`<div class='popover-head'><span class='popover-name'>Picking pattern</span></div>
    <p class='note'>The song's own pattern says where it's from; anything you choose here is labelled as your pick.</p>
    ${patternListHtml(pf.pattern ? pf.pattern.id : null, pf.options)}
    <button class='btn outline' data-close>Done</button>`, "Choose a picking pattern");
  pop.querySelectorAll("[data-pattern]").forEach((x) => x.addEventListener("click", () => {
    const id = x.dataset.pattern;
    // Choosing the song's own first pattern isn't "your pick".
    setPrefs({ pickPattern: pf.options[0] === id ? null : id });
    closePopover();
    if (player && player.playing) togglePlay().then(() => togglePlay());
  }));
}

// The lit finger letter and diagram column while it plays.
let litStep = -1;
function pickStep(i) {
  if (!cur || cur.mode !== "picking") return;
  const v = cur.view;
  v.querySelectorAll(".fcell.cur, .dg-col.cur").forEach((e) => e.classList.remove("cur"));
  litStep = i;
  litTabStep(v, i);
  if (i < 0) return;
  const a = v.querySelector(`.fcell[data-i='${i}']`), c = v.querySelector(`.dg-col[data-i='${i}']`);
  if (a) a.classList.add("cur");
  if (c) c.classList.add("cur");
}

// The diagram and notation follow the chord being played.
function pickChord(d) {
  if (!cur || cur.mode !== "picking" || !player || !player.session) return;
  const bar = player.session.bars[d.bar];
  const ch = bar && bar.chords[d.index];
  if (!ch || !ch.pima || !player.session.pattern) return;
  const p = player.session.pattern;
  const stage = cur.view.querySelector(".pick-stage"), nota = cur.view.querySelector(".pick-notation");
  if (stage) stage.innerHTML = diagramSvg(p, ch.pima, tun().open);
  if (nota) nota.outerHTML = notationHtml(p, ch.pima, tun().open);
  if (litStep >= 0) pickStep(litStep);
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
    id: cur.id, title: songTitle(), artist: songArtist(), prefs: cur.prefs, rec: cur.rec, tuning: tun(),
    chart: { ...(c || {}), links, audio: (cur.chart && cur.chart.audio) || (cur.shipped && cur.shipped.audio) || null,
      stems: (cur.chart && cur.chart.stems) || (cur.shipped && cur.shipped.stems) || null }, disp,
    modesHtml: modesSeg("player"),
    sideHtml: c && hasChords(c) ? `<div class='h2'>Chords</div><div class='boxes'>${boxesHtml(c, disp)}</div>` : "",
    wireSide: (v) => v.querySelectorAll(".box[data-chord]").forEach((b) => b.addEventListener("click", () => openChord([b.dataset.chord]))),
    lyrics: cur.doc ? { lines: lyricLines(cur.doc).map((x) => x.text), timing: cur.timing ? cur.timing.lines : [] } : null,
    onPitch: () => {},
    startLoop: cur.startLoop,
    band: hasChords(base()) ? bandCtx() : null,
    // A link analysed on the PC came back with its recording, chords and stems.
    onImported: async () => {
      const id = await reload();
      closePlayer();
      if (location.hash.startsWith(`#/song/${encodeURIComponent(id)}/player`)) await openSong(document.getElementById("view-song"), id, "player");
    },
  };
}

// The synth band (js/band.js): the chart's own bar times when it has them,
// else its bars laid out at your tempo, in sounding pitch (capo 0); and the
// app guitar's notes: each section's part, else its picking pattern
// ({ events, covered: bars with notes }; the rest are strummed).
function bandCtx() {
  const c = timedChart();
  const timed = c && Array.isArray(c.bars) && c.bars.length && typeof c.bars[0].t === "number";
  const make = () => {
    if (timed) return c;
    const b = base();
    const shift = b.capo || 0;
    const sections = (b.sections || []).map((s) => ({ ...s, chords: splitBars(s.chords).map((bar) => bar.map((n) => transposeChord(n, shift, transposeKey(b.key, shift))).join(" ")).join(" | ") }));
    const tl = bandTimeline({ ...b, sections }, { tempo: tempo(), beats: meter(b.time || "4/4").beats });
    return { ...b, capo: 0, key: b.key ? transposeKey(b.key, shift) : b.key, sections, bars: tl.bars, beats: tl.beats, analysis: { ...(b.analysis || {}), ...tl.analysis }, band: true };
  };
  let chart = null, cache = { key: null, fn: null };
  return {
    chart: () => (chart = chart || make()),
    timed: !!timed,
    style: (cur.chart && cur.chart.style) || (cur.shipped && cur.shipped.style) || null,
    disp: (name) => {
      const key = tr() + ":" + capoNow() + ":" + cur.prefs.simple;
      if (cache.key !== key) cache = { key, fn: makeDisp(chart = chart || make()) };
      return cache.fn(name);
    },
    guitar: () => {
      const covered = new Set();
      const events = partAlongEvents(chart || make(), { patterns: true, covered });
      return { events, covered };
    },
    // Transcribed parts from the PC (bass, melody, drums), on the recording's
    // clock: from your own analysis on this device, else shipped with the song.
    arrangement: async () => {
      if (!timed) return null;
      const mine = await get("arrangements", cur.id).catch(() => null);
      if (mine && mine.tracks) return checkArrangement({ kind: "arrangement", ...mine });
      const a = (cur.chart && cur.chart.arrangement) || (cur.shipped && cur.shipped.arrangement);
      if (!a || !a.file) return null;
      try {
        const r = await fetch(a.file.split("/").map(encodeURIComponent).join("/"));
        return r.ok ? checkArrangement(await r.json()) : null;
      } catch (e) { return null; }
    },
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
      ${helperUrl() ? "<button class='btn outline small' data-sync='pc'>Line up on my PC</button>" : ""}
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
  } else if (what === "pc") {
    await alignSheetOnPc();
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

// Line the sheet's lyrics up with the vocals in your recording, on the PC
// (the recording must have been analysed there; it uses that vocal stem).
async function alignSheetOnPc() {
  const lines = lyricLines(cur.doc).map((x, index) => ({ index, text: x.text })).filter((x) => x.text);
  if (!lines.length) { toast("The sheet has no lyric lines to line up."); return; }
  try {
    const timing = await alignOnPc({ song: cur.id, lyrics: lines }, (text) => toast(text, 0));
    if (!timing.length) { toast("Your PC couldn't place the lines; try tapping them instead.", 4000); return; }
    for (const x of timing) cur.sync.have.set(x.index, x.t);
    cur.sync.next = lyricLines(cur.doc).findIndex((_, i) => !cur.sync.have.has(i));
    if (cur.sync.next < 0) cur.sync.next = lyricLines(cur.doc).length;
    await storeSync("aligned");
    toast(`Lined up ${timing.length} of ${lines.length} lines with your recording's vocals. Check them as it plays.`, 4500);
  } catch (e) {
    toast(e.message, 5000);
  }
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
// stay: open the song where you are (the tab's Lyrics), not in Sheet.
async function lrclibNewSheet(btn, stay = false) {
  btn.disabled = true;
  toast("Looking on LRCLIB…", 0);
  try {
    // The song may come with LRCLIB's lines already lined up with its recording (times only).
    const lt = (cur.chart && cur.chart.lyricTiming) || (cur.shipped && cur.shipped.lyricTiming);
    const found = await findSyncedLyrics({ title: songTitle(), artist: songArtist(), duration: await recordingDuration(), id: lt && lt.lrclib ? lt.lrclib.id : null });
    if (!found) { toast("LRCLIB has no synced lyrics for this song.", 3500); btn.disabled = false; return; }
    const fitted = lt && lt.lrclib && lt.lrclib.id === found.id;
    if (fitted) found.synced = retime(found.synced, lt.times);
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
    toast(fitted ? (stay ? "Lyrics from LRCLIB, lined up with this song's recording. They're in Sheet too, with the chords." : "Sheet made from LRCLIB's lyrics, lined up with this song's recording, with the chords placed by time.")
      : timed ? `Sheet made from LRCLIB's lyrics with your chords placed by time. LRCLIB times the released track: if your recording is another version, Sync${helperUrl() ? " → Line up on my PC" : ""} fits them to it.`
      : "Sheet made from LRCLIB's lyrics. Analyse a recording to add chords.", 5000);
    const id = cur.id;
    const mode = stay ? cur.mode : "sheet";
    const pick = stay ? cur.pickSec : undefined;
    cur = null;
    invalidateSongs();
    await openSong(document.getElementById("view-song"), id, mode || "sheet");
    if (stay && cur) { cur.pickSec = pick; render(); }
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
  // The tuning: tap to change it (standard shows only once you've changed something).
  const tt = tun();
  if (!tt.standard || cur.prefs.tuning || (c.tuning && c.tuning.notes)) {
    chips.push(`<button class='chip tuning-chip' data-act='tuning' title='${esc(stringNames(tt).join(" "))}'>Tuning <b>${esc(tt.name)}</b></button>`);
  }
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
    ${chords && mode !== "sheet" ? `<button class='tool' data-act='tuning'>${tun().standard ? "Tuning" : esc(tun().name)}</button>` : ""}
    ${mode === "sheet" && cur.doc ? `<button class='tool ${cur.sync ? "on" : ""}' data-act='sync' aria-pressed='${!!cur.sync}'>Sync${cur.timing && cur.timing.lines.length ? " ✓" : ""}</button>` : ""}
    ${hasRecording() ? `<div class='seg small-seg play-source' role='group' aria-label='Play plays'>${[["recording", "Recording"], ["synth", "Synth"]].map(([v, l]) =>
      `<button data-play-source='${v}' class='${playSource() === v ? "on" : ""}' aria-pressed='${playSource() === v}'>${l}</button>`).join("")}</div>` : ""}
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
  // N.C. (no chord) has no box.
  return uniqueDisplayed(b, disp).filter((d) => !/^N\.?C\.?$/i.test(d)).map((d) => {
    const v = voicingsFor(d, vm, tun())[0];
    const yours = v && cur.prefs.voicings && cur.prefs.voicings[d] === v.spec;
    return `<button class='box${yours ? " yours" : ""}' data-chord='${esc(d)}'>${esc(prettyChord(d))}${yours ? "<span class='yours-tag'>yours</span>" : ""}${v ? chordBoxSvg(v.frets, { width, label: d + " " + v.spec + (yours ? ", your shape" : "") }) : "<span class='nobox'>no shape found</span>"}</button>`;
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
  const tt = tun();
  if (!tt.standard || cur.prefs.tuning) {
    const yours = !!cur.prefs.tuning;
    parts.push(`<div style='margin-top:${parts.length ? 12 : 0}px'><b>Tuning:</b> ${esc(tt.name)} (${esc(prettyChord(stringNames(tt).join(" ")))}, low string first)${yours ? ", as you set it" : tt.source === "mine" ? ", as you play it" : ""}.
      ${hasChords(b) && !tt.standard ? "<span class='note'>Diagrams, Hear and Play use shapes in this tuning: yours where you set one, else the easiest found by a fret search.</span>" : ""}</div>`);
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
      <button class='btn primary play' data-act='play' style='flex:1' ${chords || hasRecording() ? "" : "disabled"}>▶ ${playSource() === "recording" ? "Recording" : "Play song"}</button>`;
  }
  return `<button class='btn outline round' data-act='bpm-' aria-label='Slower'>−</button>
    <label class='tempo'><input class='bpm-input' type='text' inputmode='numeric' pattern='[0-9]*' maxlength='3' value='${tempo()}' aria-label='Tempo in BPM' autocomplete='off'><small>BPM</small></label>
    <button class='btn outline round' data-act='bpm+' aria-label='Faster'>+</button>
    <button class='btn primary play' data-act='play' style='flex:1' ${chords || hasRecording() ? "" : "disabled"}>▶ ${playSource() === "recording" ? "Recording" : "Play"}</button>`;
}

function updateTransport() {
  if (!cur || !cur.view) return;
  // Whatever is playing, wherever it was started: the recording pauses, the synth stops.
  const recNow = recPlayingHere();
  const playing = recNow || !!(player && player.playing);
  const rec = playSource() === "recording";
  const label = rec ? "Recording" : cur.mode === "sheet" ? "Play song" : "Play";
  cur.view.querySelectorAll(".play").forEach((b) => {
    b.textContent = playing ? (recNow ? "❚❚ Pause" : "■ Stop") : "▶ " + label;
    b.classList.toggle("stop", !!playing);
  });
  cur.view.querySelectorAll("[data-play-source]").forEach((b) => { const on = b.dataset.playSource === playSource(); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  cur.view.querySelectorAll(".bpm").forEach((el) => { el.textContent = tempo(); });
  cur.view.querySelectorAll(".bpm-input").forEach((el) => { if (document.activeElement !== el) el.value = tempo(); });
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
    const el = (bar.form !== undefined && v.querySelector(`.tab-bar[data-form='${bar.form}'][data-pbar='${bar.bar}']`))
      || v.querySelector(`.bar[data-sec='${bar.sec}'][data-bar='${bar.bar}']`) || v.querySelector(`.pbar[data-pbar='${bar.bar}']`);
    if (!el) return;
    el.classList.add("on");
    lit = [el];
    follow(el);
    if (bar.part && cur.mode === "picking") showPartBar(bar.bar);
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
  if (player && player.playing) {
    if (cur.mode === "picking") { const pl = pickPlan(); if (pl.ctx) player.setBars(partPlayBars(pl.ctx)); else if (pl.bars.length) player.setBars(pl.bars); }
    else player.setBars(playBars());
  }
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
  // Something playing stops (or pauses, the recording: Play carries on from there).
  if (recPlayingHere()) { await toggleRecording(); updateTransport(); return; }
  if (player && player.playing) { player.stop(); return; }
  if (playSource() === "recording") {
    const pn = playerNow();
    if (pn && pn.id === cur.id && pn.kind === "file") await toggleRecording(); else await playRecording(playerCtx());
    updateTransport();
    return;
  }
  if (cur.mode === "picking") {
    const p = getPlayer();
    if (cur.pickSec === "all") {
      const b = base();
      await p.start({ bars: wholePlayBars(), parts: true, bpm: tempo(), time: (b && b.time) || "4/4", capo: capoNow(), countIn: false, loop: false, open: tun().open });
      return;
    }
    const { pf, bars, b, ctx } = pickPlan();
    if (ctx) {
      await p.start({ bars: partPlayBars(ctx), parts: true, bpm: tempo(), time: (b && b.time) || "4/4", capo: capoNow(), countIn: false, loop: true, open: tun().open });
      return;
    }
    if (!pf.pattern) { openPatternChooser(); return; }
    const c0 = pimaChord("C", null, tun());
    const playable = bars.length ? bars : [{ sec: 0, bar: 0, chords: [{ name: "C", frets: c0.frets, pima: c0 }] }];
    await p.start({ bars: playable, bpm: tempo(), time: (b && b.time) || "4/4", capo: capoNow(), pattern: pf.pattern, countIn: false, loop: true, open: tun().open });
    return;
  }
  if (!hasChords(base())) return;
  const p = getPlayer();
  if (p.playing) { p.stop(); return; }
  const plan = playPlan();
  const bars = playBars();
  if (!bars.length) return;
  if (bars.some((b) => b.chords.some((c) => !c.frets && !/^N\.?C\.?$/i.test(c.name)))) toast("Some chords have no shape, so they're silent.");
  await p.start({
    bars, bpm: tempo(), time: plan.time, capo: capoNow(),
    strum: plan.strum, pattern: plan.pattern, countIn: false, loop: false, open: tun().open,
  });
}

function wire(view) {
  view.querySelectorAll("[data-play-source]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.playSource === playSource()) return;
    // Switching stops what's playing.
    if (recPlayingHere()) await toggleRecording();
    if (player && player.playing) player.stop();
    setPrefs({ playSource: b.dataset.playSource });
  }));
  // Type a tempo: it's set when you leave the field or press Enter (out of range, it's clamped).
  view.querySelectorAll(".bpm-input").forEach((inp) => {
    inp.addEventListener("focus", () => inp.select());
    const commit = () => {
      const n = parseInt(inp.value, 10);
      if (Number.isFinite(n) && n !== tempo()) setTempo(n);
      inp.value = tempo();
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { commit(); inp.blur(); }
      else if (e.key === "Escape") { inp.value = tempo(); inp.blur(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); tempoBy(e.key === "ArrowUp" ? 1 : -1); inp.value = tempo(); }
    });
  });
  view.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "bpm-" || act === "bpm+") { holdable(b, () => tempoBy(act === "bpm+" ? 1 : -1)); return; }
    b.addEventListener("click", () => {
      if (act === "transpose") openTranspose();
      else if (act === "simple") setPrefs({ simple: !cur.prefs.simple });
      else if (act === "capo") openCapo();
      else if (act === "tuning") openTuning();
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
      else if (act === "lrclib-here") lrclibNewSheet(b, true);
      else if (act === "tab-lyrics") setPrefs({ tabLyrics: !cur.prefs.tabLyrics });
      else if (act === "pick-pattern") openPatternChooser();
      else if (act === "pick-reset") setPrefs({ pickPattern: null });
      else if (act === "part-new") newPart();
      else if (act === "part-edit") { const pl = pickPlan(); if (pl.ctx) openBarEditor(pl.ctx, Math.min(cur.partSel || 0, pl.ctx.bars.length - 1)); }
      else if (act === "part-check") checkPart();
      else if (act === "part-along") playPartAlong();
      else if (act === "part-pc") findPartOnPc();
      else if (act === "part-delete") deletePart(b);
    });
  });
  view.querySelectorAll("[data-sync]").forEach((b) => b.addEventListener("click", () => syncAct(b.dataset.sync)));
  view.querySelectorAll("[data-pick-sec]").forEach((b) => b.addEventListener("click", () => {
    if (player && player.playing) player.stop();
    cur.pickSec = b.dataset.pickSec === "all" ? "all" : +b.dataset.pickSec;
    cur.partSel = 0;
    render();
  }));
  view.querySelectorAll("[data-pview]").forEach((b) => b.addEventListener("click", () => {
    cur.prefs.partView = b.dataset.pview;
    savePrefs(cur.id, cur.prefs);
    partLit = null;
    render();
  }));
  view.querySelectorAll("[data-ab]").forEach((b) => b.addEventListener("click", () => {
    cur.partAB = b.dataset.ab;
    setPartAB(b.dataset.ab);
    updatePartAlong();
  }));
  if (cur.mode === "picking") updatePartAlong();
  view.querySelectorAll(".pbar[data-pbar]").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.pbar;
    if (b.dataset.form !== undefined) {
      // The whole song: edit the bar in its section (a section with no part opens on its own).
      const pl = pickPlan(+b.dataset.sec);
      if (pl.ctx) openBarEditor(pl.ctx, i);
      else { cur.pickSec = +b.dataset.sec; cur.partSel = 0; render(); }
      return;
    }
    const pl = pickPlan();
    if (!pl.ctx) return;
    if (cur.partSel === i) { openBarEditor(pl.ctx, i); return; }
    cur.partSel = i;
    view.querySelectorAll(".pbar.sel").forEach((x) => x.classList.remove("sel"));
    b.classList.add("sel");
    showPartBar(i);
    const eb = view.querySelector("[data-act=part-edit]");
    if (eb) eb.textContent = `Edit bar ${i + 1}`;
    if (!(player && player.playing)) openBarEditor(pl.ctx, i);
  }));
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
  const midis = voicingMidi(frets, capoNow(), tun());
  await warmNotes(midis);
  hearVoices = hearVoices || new StringVoices("guitar");
  strum(hearVoices, frets, audioContext().currentTime + 0.03, { capo: capoNow(), level: 0.4, open: tun().open });
}

const PC_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

// What a shape plays, for checking your own: its notes, and any that aren't in the chord.
function shapeNote(name, frets) {
  const pcs = chordPcs(name);
  const notes = voicingMidi(frets, 0, tun()).map((m) => m % 12);
  const odd = [...new Set(notes.filter((n) => !pcs.includes(n)))];
  return `Plays ${notes.map((n) => PC_NAMES[n]).join(" ")}${odd.length ? `, with ${odd.map((n) => PC_NAMES[n]).join(" ")} outside ${esc(prettyChord(name))}` : ""}.`;
}

function openChord(names) {
  const vm = voicingMap(base());
  const mine = cur.prefs.voicings || {};
  const html = names.map((name) => {
    const vs = voicingsFor(name, vm, tun()).slice(0, 6);
    const yours = mine[name];
    return `<div class='popover-head'><span class='popover-name'>${esc(prettyChord(name))}</span>
        ${vs.length ? `<button class='btn outline small' data-hear='${esc(name)}'>▶ Hear it</button>` : ""}</div>
      ${tun().standard ? "" : `<p class='note' style='margin:0'>Shapes in ${esc(tun().name)} (${esc(stringNames(tun()).join(" "))}).</p>`}
      <div class='boxes'>${vs.length ? vs.map((v, i) => `<button class='box ${i === 0 ? "sel" : ""}' data-name='${esc(name)}' data-spec='${esc(v.spec)}'
        aria-label='${esc(name)} ${esc(v.spec)}${v.spec === yours ? ", your shape" : ""}'>${esc(v.spec)}${v.spec === yours ? "<span class='yours-tag'>yours</span>" : ""}${chordBoxSvg(v.frets, { label: name + " " + v.spec })}</button>`).join("")
        : "<span class='note'>No shape found for this chord.</span>"}</div>
      <details class='own-shape'${yours ? "" : ""}><summary>Your own shape</summary>
        <div class='own-row'><input class='text-input own-spec' data-name='${esc(name)}' value='${esc(yours || (vs[0] ? vs[0].spec : "x32010"))}' maxlength='17'
          aria-label='Your shape for ${esc(name)}, low string first, x for a string not played' autocomplete='off' spellcheck='false'>
          <button class='btn outline small' data-own='${esc(name)}'>Use</button></div>
        ${fretPickerHtml(specFrets(yours || (vs[0] ? vs[0].spec : "x32010")) || [null, 3, 2, 0, 1, 0], { name })}
        <p class='note own-note' data-for='${esc(name)}'>${shapeNote(name, specFrets(yours || (vs[0] ? vs[0].spec : "x32010")) || [null, 3, 2, 0, 1, 0])}</p>
        ${yours ? `<button class='btn outline small' data-forget='${esc(name)}'>Back to the suggested shapes</button>` : ""}
      </details>`;
  }).join("<hr class='rule'>");
  const p = showPopover(html + `<p class='note'>Tap a shape to use it in this song and hear it, or set your own: type it (low string first, x for a string you don't play) or tap the frets.</p>
    <button class='btn outline' data-close>Done</button>`, "Chord shapes");
  const useShape = (name, spec) => {
    const frets = specFrets(spec);
    if (!frets) { toast("A shape is six strings, low first, like x32010 (or 10-12-12-11-10-10)."); return; }
    cur.prefs.voicings = { ...(cur.prefs.voicings || {}), [name]: fretsSpec(frets) };
    savePrefs(cur.id, cur.prefs);
    hear(frets);
    render();
    openChord(names);
  };
  p.querySelectorAll("[data-hear]").forEach((b) => b.addEventListener("click", () => {
    const v = voicingsFor(b.dataset.hear, voicingMap(base()), tun())[0];
    if (v) hear(v.frets);
  }));
  p.querySelectorAll(".box[data-spec]").forEach((b) => b.addEventListener("click", () => useShape(b.dataset.name, b.dataset.spec)));
  p.querySelectorAll("[data-own]").forEach((b) => b.addEventListener("click", () => {
    const inp = p.querySelector(`.own-spec[data-name='${CSS.escape(b.dataset.own)}']`);
    useShape(b.dataset.own, inp.value);
  }));
  p.querySelectorAll("[data-forget]").forEach((b) => b.addEventListener("click", () => {
    const v = { ...(cur.prefs.voicings || {}) };
    delete v[b.dataset.forget];
    cur.prefs.voicings = v;
    savePrefs(cur.id, cur.prefs);
    render();
    openChord(names);
  }));
  p.querySelectorAll(".fret-picker").forEach((fp) => wireFretPicker(fp, (frets) => {
    const name = fp.dataset.name;
    const inp = p.querySelector(`.own-spec[data-name='${CSS.escape(name)}']`);
    if (inp) inp.value = fretsSpec(frets);
    const note = p.querySelector(`.own-note[data-for='${CSS.escape(name)}']`);
    if (note) note.innerHTML = shapeNote(name, frets);
    hear(frets);
  }));
  p.querySelectorAll(".own-spec").forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") useShape(inp.dataset.name, inp.value); }));
  p.querySelectorAll(".own-spec").forEach((inp) => inp.addEventListener("input", () => {
    const frets = specFrets(inp.value);
    const note = p.querySelector(`.own-note[data-for='${CSS.escape(inp.dataset.name)}']`);
    if (note) note.innerHTML = frets ? shapeNote(inp.dataset.name, frets) : "Six strings, low first: x32010.";
  }));
}

// The tuning: presets, or your own notes. Yours is kept for this song and
// labelled as yours; the chart's is the default.
function openTuning() {
  const t = tun();
  const chartT = tuningFrom((cur.chart && cur.chart.tuning) || (cur.shipped && cur.shipped.tuning) || null);
  const html = `<div class='popover-head'><span class='popover-name' style='font-size:20px'>Tuning</span></div>
    <div class='pattern-grid tuning-grid'>${PRESETS.map((pr) => {
      const on = parseTuning(pr.notes).every((m, i) => m === t.midi[i]);
      return `<button class='pattern-btn ${on ? "on" : ""}' data-tune='${esc(pr.notes)}' data-tname='${esc(pr.name)}' aria-pressed='${on}'><span class='pn'>${esc(pr.name)}</span><span class='meta'>${esc(prettyChord(pr.notes))}</span></button>`;
    }).join("")}</div>
    <label class='set-label' for='tune-notes'>Your own notes, low string first</label>
    <div class='own-row'><input id='tune-notes' class='text-input' value='${esc(stringNames(t).join(" "))}' autocomplete='off' spellcheck='false' aria-label='Tuning notes, low string first'>
      <button class='btn outline small' data-tune-own>Use</button></div>
    <p class='note'>Shapes, diagrams and Play follow the tuning, with the capo on top. ${cur.prefs.tuning ? "This is your setting for this song." : chartT.standard ? "" : `The chart says ${esc(chartT.name)}.`}</p>
    <div style='display:flex;gap:8px'>${cur.prefs.tuning ? "<button class='btn outline' style='flex:1' data-tune-reset>Use the chart's</button>" : ""}
      <button class='btn outline' style='flex:1' data-close>Done</button></div>`;
  const p = showPopover(html, "Tuning");
  const set = (notes, name) => {
    let midi;
    try { midi = parseTuning(notes); } catch (e) { toast(e.message, 3500); return; }
    const same = parseTuning(chartT.notes).every((m, i) => m === midi[i]);
    setPrefs({ tuning: same ? null : { name: name || nameFor(midi), notes, source: "mine" } });
    openTuning();
  };
  p.querySelectorAll("[data-tune]").forEach((b) => b.addEventListener("click", () => set(b.dataset.tune, b.dataset.tname)));
  p.querySelector("[data-tune-own]").addEventListener("click", () => set(p.querySelector("#tune-notes").value.trim()));
  p.querySelector("#tune-notes").addEventListener("keydown", (e) => { if (e.key === "Enter") set(e.target.value.trim()); });
  const r = p.querySelector("[data-tune-reset]");
  if (r) r.addEventListener("click", () => { setPrefs({ tuning: null }); openTuning(); });
}

/* ---- The guitar part found on the PC, for a song analysed there ---- */

// The PC helper keeps an analysis's stems, so the part can be found later.
function pcPartJob() {
  const a = cur.device && cur.device.analysis;
  return helperUrl() && a && a.bundle && a.bundle.job ? a.bundle.job : null;
}

function pcPartRow() {
  if (!pcPartJob()) return "";
  const st = pcJob(cur.id);
  const busy = st && ["running", "fetching", "importing"].includes(st.phase);
  const step = busy && st.job && st.job.steps && st.job.steps[0];
  const text = busy ? (st.phase === "running" ? `On your PC… ${Math.round(((step && step.p) || 0) * 100)}%` : "Bringing it over…")
    : st && st.phase === "failed" ? st.error : `Notes, strings and frets from the guitar stem of your PC analysis${tun().standard ? "" : `, in ${esc(tun().name)}`}. A draft to check by ear.`;
  return `<div class='set-row pc-part'><div><div class='set-label'>Find the guitar part on your PC</div><div class='meta' aria-live='polite'>${esc(text)}</div></div>
    <button class='btn outline small' data-act='part-pc' ${busy ? "disabled" : ""}>${busy ? "Working…" : "Find it"}</button></div>`;
}

async function findPartOnPc() {
  const id = cur.id;
  await startPcJob(id, { job: pcPartJob(), parts: "guitar", tuning: tun().standard ? null : tun().notes, capo: capoNow(), title: songTitle(), artist: songArtist() });
  const off = onPcJob(id, async (st) => {
    if (!cur || cur.id !== id) return;
    if (st.phase === "done") {
      off();
      clearPcJob(id);
      cur.parts = await loadParts(id);
      const n = st.result && st.result.parts;
      toast(n ? `The guitar part for ${n} section${n === 1 ? "" : "s"}, from your PC: a draft. Play it along with the recording to check it.` : "The PC didn't find a guitar part in this recording.", 4500);
      render();
      return;
    }
    const row = cur.view.querySelector(".pc-part");
    if (row) row.outerHTML = pcPartRow();
  });
  render();
}

/* ---- Guitar parts: start one, check it, delete it ---- */

async function newPart() {
  const { sec, pf } = pickPlan();
  if (!sec) return;
  // From the pattern you're looking at, or an empty bar to write out (nothing guessed).
  const beats = meter((base() && base().time) || "4/4").beats;
  const part = { source: "mine", bars: [pf.pattern ? { pattern: pf.pattern.id } : { steps: Array(beats * 2).fill("-").join(" ") }] };
  cur.parts = await saveSectionPart(cur.id, sec.name, part);
  cur.partSel = 0;
  render();
  toast(pf.pattern ? "A part of your own: every bar plays this pattern until you change it. Tap a bar to edit it." : "A part of your own, empty for now: tap a bar to write it out.", 4000);
}

async function checkPart() {
  const { sec, part } = pickPlan();
  if (!part) return;
  cur.parts = await saveSectionPart(cur.id, sec.name, checkedPart(part));
  render();
  toast("Marked as checked: the part is yours now.");
}

async function deletePart(btn) {
  if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "Tap again to delete"; return; }
  const { sec } = pickPlan();
  if (player && player.playing) player.stop();
  cur.parts = await saveSectionPart(cur.id, sec.name, null);
  render();
  toast("Your part is deleted.");
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
  const sug = suggestCapo(names, { key: soundingKey(b)?.key || null, tuning: tun() });
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
