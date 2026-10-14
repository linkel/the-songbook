// Chords from audio (#/song/<id>/analyse, mockup 3): pick a recording, analyse
// it on this device, then check the draft: tempo ×2/÷2, bar lines ("this is
// beat 1"), a chord picker per bar, Play along with the recording, agreement
// with a cited chart, Save chords (detected) and Mark as checked (mine).
// Or analyse on the PC helper's GPU (js/pcjob.js): stems, chords, sections and
// lyric timing come back as a bundle, and the draft is checked here the same way.

import { esc, toast, showPopover, closePopover, ICONS } from "./ui.js";
import { decodeToMono, analyseSignal } from "./analysis.js";
import { beatChords, rescaleBeats, findDownbeat, findMeter, makeBars, findSections, keyName, detectedChart, compareWithChart } from "./detect.js";
import { saveRecording, getRecording, recordingMeta, deleteRecording, fmtBytes } from "./recordings.js";
import { saveChart } from "./library.js";
import { keepShippedFacts } from "./chartfile.js";
import { prettyChord, transposeChord, transposeKey, suggestCapo, diatonicChords, bestVoicing, parseChord, chordName, guessKey } from "./chords.js";
import { PlayAlong } from "./playalong.js";
import { helperUrl, helperInfo } from "./helper-client.js";
import { pcJob, onPcJob, startPcJob, cancelPcJob, clearPcJob } from "./pcjob.js";

const ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const QUALS = [["", "maj"], ["m", "m"], ["7", "7"], ["m7", "m7"], ["maj7", "maj7"], ["sus4", "sus4"], ["sus2", "sus2"]];
const MAX_MB = 80;

// rv: { id, ctx, meta, raw: { ticks, chroma (or chords + strength in older charts), keys, bpm, ... },
//       factor, bpb, phase, bars, mono, running, steps, error, strum, from }
let rv = null;
let pa = null;

function player() {
  if (!pa) {
    pa = new PlayAlong();
    pa.addEventListener("bar", (e) => lightBar(e.detail.bar));
    pa.addEventListener("state", () => { if (rv) updateTransport(); if (!pa.playing) lightBar(-1); });
  }
  return pa;
}

export function closeReview() { if (pa && pa.playing) pa.stop(); }
export const reviewState = () => rv && { bars: rv.bars, phase: rv.phase, bpb: rv.bpb, factor: rv.factor, running: rv.running, steps: { ...rv.steps }, saved: rv.saved };
export const playAlong = () => player();

// ctx: { id, title, artist, chart (your chart, if any), shipped (the shipped chart), cited (shipped, with chords),
//        prefs, setCapo(c), onSaved(), view }
export async function openReview(view, ctx) {
  if (!rv || rv.id !== ctx.id) {
    closeReview();
    rv = { id: ctx.id, raw: null, factor: 1, bpb: 4, phase: 0, bars: [], mono: null, running: false, steps: {}, error: null, strum: false, from: 0 };
    const c = ctx.chart;
    if (c && c.analysis && (c.analysis.chroma || c.analysis.beatChords) && c.beats) {
      const a = c.analysis;
      rv.raw = { ticks: a.ticks || c.beats, chords: a.beatChords, strength: a.beatStrength || [], chroma: a.chroma || null,
        keys: a.keys, profile: a.profile, bpm: a.bpm, bpmConfidence: a.bpmConfidence, version: a.version, duration: a.duration, tuning: a.tuning };
      // From the PC helper: its detector's name, and its sections while the bar lines stay its own.
      if (a.helper) Object.assign(rv.raw, { detector: c.detector, helper: a.helper, downbeats: a.downbeats, segments: a.segments, barTimes: c.bars.map((b) => b.t), bundle: a.bundle });
      rv.factor = a.factor || 1;
      rv.bpb = a.bpb || 4;
      rv.phase = a.phase || 0;
      rv.bars = c.bars.map((b) => ({ ...b, t1: b.t1 }));
      rv.checked = c.source === "mine";
      rv.steps = { decode: 1, tempo: 1, key: 1, chords: 1 };
    }
  }
  rv.ctx = ctx;
  rv.view = view;
  rv.meta = await recordingMeta(ctx.id);
  listenPc();
  render();
  if (helperUrl()) helperInfo().then((x) => { if (rv && rv.view === view) { rv.helper = x; renderPc(); } });
}

// A new chart arrived (from the PC): start over from it.
export function resetReview() { closeReview(); rv = null; }

/* ---- Analysing on the PC ---- */

const PC_ACTIVE = new Set(["running", "fetching", "importing"]);

function listenPc() {
  if (rv.unlisten) rv.unlisten();
  rv.unlisten = onPcJob(rv.id, (st) => {
    if (!rv || rv.id !== st.songId) return;
    if (st.phase === "done" && !rv.imported) {
      rv.imported = true;
      const r = st.result;
      const what = [`${r.chart.bars.length} bars of chords`, r.stems ? `${r.stems} stems` : "", r.parts ? `the guitar part for ${r.parts} section${r.parts === 1 ? "" : "s"}` : "", r.timing ? `timing for ${r.timing} lyric lines` : ""].filter(Boolean);
      toast(`From your PC: ${what.join(", ")}. Check the chords by ear.`, 4500);
      clearPcJob(rv.id);
      if (rv.ctx.onImported) rv.ctx.onImported();
      return;
    }
    renderPc();
  });
}

async function startPc() {
  const file = await getRecording(rv.id);
  if (!file) { toast("Choose the recording first: the PC analyses the same file."); return; }
  rv.imported = false;
  const lyr = rv.ctx.lyrics && rv.pcLyrics !== false ? rv.ctx.lyrics : null;
  const t = rv.ctx.tuning;
  await startPcJob(rv.id, { file, title: rv.ctx.title, artist: rv.ctx.artist, lyrics: lyr, lyricCount: rv.ctx.lyricCount,
    ...(rv.pcPart !== false ? { parts: "guitar", tuning: t && !t.standard ? t.notes : null, capo: rv.ctx.prefs.capo || 0 } : {}) });
  listenPc();
  renderPc();
}

function pcHtml() {
  if (!helperUrl()) return "";
  const st = pcJob(rv.id);
  const h = rv.helper;
  const head = "<div class='set-label'>Analyse on your PC</div>";
  if (st && PC_ACTIVE.has(st.phase)) {
    const steps = (st.job && st.job.steps) || [];
    const rows = steps.map((s) => `<div class='step'><div class='step-row'><span>${s.p >= 1 ? "<span class='ok' aria-hidden='true'>✓</span>" : "<span class='ok pending' aria-hidden='true'>•</span>"}${esc(s.label)}</span>
      <span class='v'>${s.p > 0 && s.p < 1 ? Math.round(s.p * 100) + "%" : ""}</span></div></div>`).join("");
    const where = !st.id ? "Sending the recording to your PC…" : st.phase === "fetching" ? `Bringing the results over… ${Math.round(st.fetched * 100)}%`
      : st.phase === "importing" ? "Keeping them on this device…" : st.offline ? "Can't reach the PC right now; still trying." : st.job && st.job.queue ? `Waiting for ${st.job.queue} other job${st.job.queue === 1 ? "" : "s"}.` : "Working on it. You can leave this screen; it carries on.";
    const p = st.phase === "fetching" ? 1 : (st.job && st.job.progress) || 0;
    return `<div class='card steps pc-card'><div class='set-row'><div>${head}<div class='meta' aria-live='polite'>${esc(where)}</div></div>
        <button class='btn outline small' data-pc='cancel' ${st.id ? "" : "disabled"}>Cancel</button></div>
      <div class='prog' aria-label='PC analysis progress'><i style='width:${Math.round(p * 100)}%'></i></div>${rows}</div>`;
  }
  const failed = st && (st.phase === "failed" || st.phase === "cancelled") ? `<p class='note' role='alert'>${esc(st.error || "That didn't work.")}</p>` : "";
  const ready = h && h.ok && h.analysis && h.analysis.available;
  const meta = !h ? "Checking your PC helper…"
    : !h.ok ? esc(h.error || "Can't reach the helper.")
    : !ready ? esc((h.analysis && h.analysis.reason) || "This helper only downloads; analysis needs the GPU setup in helper/README.md.")
    : `Stems, chords, bar lines and sections on ${esc(h.analysis.gpu || "the PC")}, usually under a minute. The recording goes to your PC over Tailscale and nowhere else.`;
  const lyr = rv.ctx.lyrics && rv.ctx.lyrics.length;
  return `<div class='card set-group pc-card'>
    <div class='set-row'><div>${head}<div class='meta'>${meta}</div></div>
      <button class='btn ${rv.raw ? "outline" : "primary"} small' data-pc='start' ${ready && rv.meta && !rv.running ? "" : "disabled"}>${rv.raw && rv.raw.helper ? "Again" : "Analyse"}</button></div>
    ${ready ? `<div class='set-row'><div><div class='set-label'>The guitar part too</div><div class='meta'>Notes, strings and frets from the guitar stem, for Picking mode${rv.ctx.tuning && !rv.ctx.tuning.standard ? `, in ${esc(rv.ctx.tuning.name)}` : ""}${rv.ctx.prefs.capo ? `, capo ${rv.ctx.prefs.capo}` : ""}. A draft; which finger plays what is inferred.</div></div>
      <button class='switch ${rv.pcPart !== false ? "on" : ""}' role='switch' aria-checked='${rv.pcPart !== false}' data-pc='part' aria-label='The guitar part too'></button></div>` : ""}
    ${lyr && ready ? `<div class='set-row'><div><div class='set-label'>Line up my lyrics</div><div class='meta'>Sends your sheet's ${lyr} lyric lines too, to time them against the singing.</div></div>
      <button class='switch ${rv.pcLyrics !== false ? "on" : ""}' role='switch' aria-checked='${rv.pcLyrics !== false}' data-pc='lyrics' aria-label='Line up my lyrics'></button></div>` : ""}
    ${failed}</div>`;
}

function renderPc() {
  const el = rv && rv.view && rv.view.querySelector("#pc");
  if (!el) return;
  el.innerHTML = pcHtml();
  el.querySelectorAll("[data-pc]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.pc;
    if (a === "start") startPc();
    else if (a === "cancel") cancelPcJob(rv.id);
    else if (a === "lyrics") { rv.pcLyrics = rv.pcLyrics === false; renderPc(); }
    else if (a === "part") { rv.pcPart = rv.pcPart === false; renderPc(); }
  }));
}

/* ---- Derived ---- */

const capo = () => rv.ctx.prefs.capo || 0;
// The recording's tuning (cents from A440), so the strum-along matches it.
const tuningCents = () => (rv.raw && (rv.raw.chroma ? rv.raw.chroma.tuning : rv.raw.tuning)) || 0;

function soundingKey() {
  const k = rv.raw && keyName(rv.raw.keys && rv.raw.keys[rv.raw.profile || "edma"]);
  return k || (guessKey(rv.bars.flatMap((b) => b.chords)) || {}).key || null;
}

// Bars hold sounding chords; they're shown as shapes for your capo.
function shape(name) {
  const k = soundingKey();
  return transposeChord(name, -capo(), k ? transposeKey(k, -capo()) : null);
}
function sounding(shapeName) { return transposeChord(shapeName, capo()); }

function scaledBeats() {
  return rescaleBeats(beatChords(rv.raw), rv.factor);
}

function ticks() {
  const bs = scaledBeats();
  return bs.length ? bs.map((b) => b.t0).concat(bs[bs.length - 1].t1) : [];
}

// Regroup beats into bars. Your edits are kept by bar time, so they come back
// whenever the bar lines do.
function rebuild({ keepPhase = false } = {}) {
  const beats = scaledBeats();
  if (!keepPhase) rv.phase = findDownbeat(beats, rv.bpb);
  rv.edits = rv.edits || new Map();
  for (const b of rv.bars || []) if (b.edited) rv.edits.set(editKey(b), b.chords);
  rv.bars = makeBars(beats, { bpb: rv.bpb, phase: rv.phase });
  for (const b of rv.bars) {
    const e = rv.edits.get(editKey(b));
    if (e) { b.chords = e.slice(); b.edited = true; }
  }
}
const editKey = (b) => Math.round(b.t * 100) + ":" + b.n;

/* ---- Running an analysis ---- */

// Analyse `file` for song `id` and return the raw result (also used by batch).
export async function analyseFile(file, onStep) {
  onStep("decode", 0);
  const { mono, duration } = await decodeToMono(file);
  onStep("decode", 1);
  const raw = await analyseSignal(mono, (step, p) => onStep(step === "load" ? "load" : step, p));
  return { raw, mono, duration };
}

// A chart, ready to save, from a raw result (bar lines guessed).
export function chartFromRaw(raw, { id, title, artist, file, bpb = null, factor = 1, phase = null, bars = null, checked = false }) {
  const beats = rescaleBeats(beatChords(raw), factor);
  if (bpb === null) ({ bpb, phase } = findMeter(beats));
  const ph = phase === null ? findDownbeat(beats, bpb) : phase;
  const bs = bars || makeBars(beats, { bpb, phase: ph });
  const tk = beats.length ? beats.map((b) => b.t0).concat(beats[beats.length - 1].t1) : [];
  // The helper's sections fit only its own bar lines.
  const sameBars = raw.barTimes && factor === 1 && bs.length === raw.barTimes.length && bs.every((b, i) => Math.abs(b.t - raw.barTimes[i]) < 0.02);
  const chart = detectedChart(bs, tk, { bpm: raw.bpm * factor, bpmConfidence: raw.bpmConfidence, keys: raw.keys, profile: raw.profile || "edma",
    version: raw.version, duration: raw.duration, file, bpb, phase: ph, at: new Date().toISOString(),
    tuning: raw.chroma ? raw.chroma.tuning : raw.tuning ?? null, oldDetector: !raw.chroma && !raw.detector, detector: raw.detector || null,
    segments: sameBars ? raw.segments : null });
  const r2 = (v) => v.map((x) => Math.round(x * 100) / 100);
  Object.assign(chart.analysis, { ticks: raw.ticks.map((t) => Math.round(t * 1000) / 1000), factor, version: raw.version });
  if (raw.helper) Object.assign(chart.analysis, { helper: raw.helper, downbeats: raw.downbeats, bundle: raw.bundle, ...(sameBars ? { segments: raw.segments } : {}) });
  // What the bars were named from, so bar lines and tempo can change later without the audio.
  if (raw.chroma) {
    chart.analysis.chroma = { tuning: raw.chroma.tuning, treble: raw.chroma.treble.map(r2), bass: raw.chroma.bass.map(r2), energy: r2(raw.chroma.energy) };
  } else {
    Object.assign(chart.analysis, { beatChords: raw.chords, beatStrength: raw.strength.map((x) => Math.round(x * 1000) / 1000) });
  }
  Object.assign(chart, { id, title, artist });
  if (checked) markChecked(chart);
  return chart;
}

export { keepShippedFacts };

function markChecked(chart) {
  chart.source = "mine";
  chart.checkedFrom = chart.detector;
  chart.notes = `Detected by ${chart.detector}, then checked by ear by you.`;
}

async function run(file) {
  rv.running = true;
  rv.error = null;
  rv.steps = {};
  render();
  try {
    if (file) {
      if (file.size > MAX_MB * 1024 * 1024) throw new Error(`That file is over ${MAX_MB} MB; try an mp3 or m4a of the song.`);
      rv.meta = await saveRecording(rv.id, file);
    } else {
      file = await getRecording(rv.id);
      if (!file) throw new Error("The recording isn't on this device any more. Choose it again.");
    }
    const { raw, mono } = await analyseFile(file, (step, p) => { rv.steps[step] = p; renderSteps(); });
    rv.raw = raw;
    rv.mono = mono;
    rv.factor = 1;
    rv.checked = false;
    rv.saved = false;
    rv.edits = new Map();
    rv.bars = [];
    ({ bpb: rv.bpb, phase: rv.phase } = findMeter(scaledBeats()));
    rebuild({ keepPhase: true });
    // Offer easier shapes.
    const sug = suggestCapo(rv.bars.flatMap((b) => b.chords), { key: soundingKey(), tuning: rv.ctx.tuning });
    rv.capoSuggestion = sug.capo;
  } catch (e) {
    rv.error = e.message;
  }
  rv.running = false;
  render();
}

/* ---- Rendering ---- */

function render() {
  const { view, ctx } = rv;
  const scroll = view.querySelector("#song-scroll");
  const keep = scroll ? scroll.scrollTop : 0;
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/song/${encodeURIComponent(rv.id)}/chords' aria-label='Back to the song'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>Chords from audio</div><div class='meta'>${esc(ctx.title)}${ctx.artist ? " · " + esc(ctx.artist) : ""}</div></div>
    </div>
    <div class='song-body'><div class='song-scroll' id='song-scroll'><div class='song-main-col'>
      ${dropCard()}
      <div id='pc'>${pcHtml()}</div>
      ${rv.error ? `<div class='card empty' role='alert'><b>That didn't work.</b><br>${esc(rv.error)}</div>` : ""}
      <div id='steps'>${stepsHtml()}</div>
      ${rv.raw && !rv.running ? resultHtml() : ""}
    </div></div></div>
    <div class='transport always'>
      <button class='btn outline' data-act='playalong' style='flex:1' ${rv.raw && !rv.running && rv.meta ? "" : "disabled"}>Play along</button>
      <button class='btn primary' data-act='save' style='flex:1' ${rv.raw && !rv.running ? "" : "disabled"}>Save chords</button>
    </div>`;
  view.querySelector("#song-scroll").scrollTop = keep;
  wire();
  renderPc();
  updateTransport();
}

function dropCard() {
  const m = rv.meta;
  const icon = "<svg width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' aria-hidden='true'><path d='M12 16V4M6 10l6-6 6 6M4 20h16'/></svg>";
  const input = "<input type='file' id='rec-file' accept='audio/*,video/mp4,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.mp4,.mov' class='sr-only'>";
  if (!m) {
    return `<label class='drop' for='rec-file'><span class='icon'>${icon}</span>
      <span><b>Choose a recording</b><span class='meta' style='display:block'>mp3, m4a, wav or flac. Analysed on this device; nothing is uploaded.</span></span>${input}</label>`;
  }
  return `<div class='drop'><span class='icon'>${icon}</span>
      <span style='flex:1;min-width:0'><b class='ellipsis'>${esc(m.name)}</b><span class='meta' style='display:block'>${fmtBytes(m.size)} · kept on this device${helperUrl() ? "" : " · nothing uploaded"}</span></span></div>
    <div class='toolbar'>
      <button class='tool' data-act='reanalyse' ${rv.running ? "disabled" : ""}>${helperUrl() ? (rv.raw ? "Again here" : "Analyse here") : rv.raw ? "Analyse again" : "Analyse"}</button>
      <label class='tool' for='rec-file'>Another file${input}</label>
      <button class='tool' data-act='delete-rec' ${rv.running ? "disabled" : ""}>Delete recording</button>
    </div>`;
}

const STEP_NAMES = [["decode", "Reading the file"], ["load", "Loading the analyser"], ["tempo", "Tempo and beats"], ["key", "Key"], ["chords", "Chords"]];

function stepsHtml() {
  if (!rv.running && !rv.raw) return "";
  const r = rv.raw;
  const rows = STEP_NAMES.filter(([k]) => rv.running || k !== "load").map(([k, label]) => {
    const p = rv.steps[k];
    const done = p === 1;
    let v = "";
    if (!rv.running && r) {
      if (k === "tempo") v = `${Math.round(r.bpm * rv.factor)} bpm`;
      if (k === "key") {
        const kn = soundingKey();
        v = kn ? prettyChord(kn) + (/m$/.test(kn) ? "" : " major") : "?";
        const cents = Math.round(tuningCents());
        if (Math.abs(cents) >= 5) v += ` · tuned ${cents > 0 ? "+" : "−"}${Math.abs(cents)}¢`;
      }
      if (k === "chords") v = `${rv.bars.length} bars`;
      if (k === "decode") v = r.duration ? fmtTime(r.duration) : "";
    } else if (p !== undefined && !done) v = Math.round(p * 100) + "%";
    const bar = rv.running && k === "chords" && p !== undefined && !done ? `<div class='prog'><i style='width:${Math.round(p * 100)}%'></i></div>` : "";
    return `<div class='step${bar ? " col" : ""}'><div class='step-row'><span>${done ? "<span class='ok' aria-hidden='true'>✓</span>" : "<span class='ok pending' aria-hidden='true'>•</span>"}${label}</span><span class='v'>${v}</span></div>${bar}</div>`;
  }).join("");
  const tempoTools = !rv.running && r ? `<div class='step-tools'><span class='meta'>Tempo can come out double or half:</span>
      <button class='btn outline small' data-act='half' aria-pressed='${rv.factor === 0.5}'>÷2</button>
      <button class='btn outline small' data-act='double' aria-pressed='${rv.factor === 2}'>×2</button></div>` : "";
  const keyNote = !rv.running && r && r.keys ? `<div class='note' style='padding:0 0 10px'>Key profiles: ${Object.entries(r.keys).map(([p, k]) => `${p} ${esc(prettyChord(k.key))} ${esc(k.scale)}`).join(" · ")}. The relative major or minor is easy to confuse.</div>` : "";
  const pcNote = !rv.running && r && r.helper ? `<div class='note' style='padding:0 0 10px'>Analysed on your PC: ${esc(r.detector || "the helper")}.</div>` : "";
  return `<div class='card steps'>${rows}${tempoTools}${keyNote}${pcNote}</div>`;
}

function renderSteps() {
  const el = rv.view.querySelector("#steps");
  if (el) el.innerHTML = stepsHtml();
}

const fmtTime = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");

function resultHtml() {
  const parts = [];
  // Easier shapes.
  const sug = rv.capoSuggestion || 0;
  // Shapes (and so the capo maths) in the song's tuning.
  if (sug > 0 || capo() > 0) {
    const names = [...new Set(rv.bars.flatMap((b) => b.chords))].slice(0, 5);
    const k = soundingKey();
    const shapes = names.map((n) => transposeChord(n, -sug, k ? transposeKey(k, -sug) : null));
    const on = capo() === sug && sug > 0;
    parts.push(`<div class='card suggest'><div><div class='set-label'>Easier shapes: capo ${sug}${k ? ", play in " + esc(prettyChord(transposeKey(k, -sug))) : ""}</div>
      <div class='meta'>Turns ${esc(names.map(prettyChord).join(" "))} into ${esc(shapes.map(prettyChord).join(" "))}</div></div>
      <button class='switch ${on ? "on" : ""}' role='switch' aria-checked='${on}' data-act='capo' aria-label='Use capo ${sug}'></button></div>`);
  }
  // Bar lines.
  parts.push(`<div class='card set-group'>
    <div class='set-row'><div><div class='set-label'>Bar lines</div><div class='meta'>Move beat 1 if the bars start in the wrong place, or tap "Beat 1" while it plays.</div></div></div>
    <div class='toolbar' style='margin-bottom:12px'>
      <button class='tool' data-act='phase-' aria-label='Beat 1 earlier'>◀ Beat 1</button>
      <button class='tool' data-act='phase+' aria-label='Beat 1 later'>Beat 1 ▶</button>
      <span class='seg small-seg' role='group' aria-label='Beats per bar'>
        <button data-bpb='4' class='${rv.bpb === 4 ? "on" : ""}'>4/4</button><button data-bpb='3' class='${rv.bpb === 3 ? "on" : ""}'>3/4</button></span>
    </div></div>`);
  // Agreement with a cited chart.
  const cmp = comparison();
  if (cmp) {
    parts.push(`<div class='card sources'><b>Cited chart:</b> agrees on ${cmp.agree} of ${cmp.total} bars (as plain triads, at the best alignment).
      Bars that differ have a red corner.</div>`);
  }
  // The bars, by section.
  const { form, spans } = findSections(rv.bars);
  form.forEach((name, i) => {
    const span = spans[i];
    parts.push(`<div class='card section'>
      <div class='sec-head'><span class='sec-name'>${esc(name)} <span class='meta'>${span.length > 1 ? `bars ${span[0] + 1}–${span[span.length - 1] + 1}` : `bar ${span[0] + 1}`}</span></span>
        <span class='badge ${rv.checked ? "mine" : "detected"}'>${rv.checked ? "Checked" : "Detected · check by ear"}</span></div>
      <div class='bars'>${span.map((bi) => barHtml(bi, cmp)).join("")}</div></div>`);
  });
  parts.push(`<p class='note' style='padding:0 2px'>Tap a bar to change it; press and hold to split it in two. Play along to hear the recording with the chords lit. "?" marks bars the analyser wasn't sure about.</p>`);
  parts.push(`<div class='card set-group'>
    <div class='set-row'><div><div class='set-label'>Strum along</div><div class='meta'>The app guitar softly strums the chords on the recording's beats.</div></div>
      <button class='switch ${rv.strum ? "on" : ""}' role='switch' aria-checked='${rv.strum}' data-act='strum' aria-label='Strum along'></button></div>
    <div class='set-row'><div><div class='set-label'>Sounds right?</div><div class='meta'>Mark as checked and the chart becomes yours ("Mine").</div></div>
      <button class='btn outline small' data-act='checked'>${rv.checked ? "Checked ✓" : "Mark as checked"}</button></div>
  </div>`);
  return parts.join("");
}

function comparison() {
  const cited = rv.ctx.cited;
  if (!cited || !(cited.sections || []).some((s) => s.chords)) return null;
  return compareWithChart(rv.bars, cited, cited.capo || 0, transposeChord);
}

function barHtml(i, cmp) {
  const b = rv.bars[i];
  const unsure = !b.sure && !b.edited;
  const differs = cmp && cmp.bars[i] === false;
  return `<button class='bar${unsure ? " editbar" : ""}${differs ? " differs" : ""}${b.edited ? " edited" : ""}' data-bar='${i}'
    aria-label='Bar ${i + 1}: ${esc(b.chords.map(shape).join(" "))}${unsure ? ", unsure" : ""}${differs ? ", differs from the cited chart" : ""}'>${b.chords.map((c) =>
    `<span class='ch'>${esc(prettyChord(shape(c)))}</span>`).join("")}${unsure ? "<span class='q' aria-hidden='true'>?</span>" : ""}</button>`;
}

function updateTransport() {
  const b = rv.view.querySelector("[data-act=playalong]");
  if (b) {
    const playing = pa && pa.playing;
    b.textContent = playing ? "■ Stop" : "Play along";
    b.classList.toggle("on", !!playing);
  }
  let tap = rv.view.querySelector("#beat1");
  if (pa && pa.playing && !tap) {
    rv.view.querySelector(".transport").insertAdjacentHTML("afterbegin", "<button class='btn outline' id='beat1' data-act='beat1'>Beat 1</button>");
    rv.view.querySelector("#beat1").addEventListener("click", tapBeat1);
  } else if (!(pa && pa.playing) && tap) tap.remove();
}

let lit = null;
function lightBar(i) {
  if (lit) lit.classList.remove("on");
  lit = null;
  if (!rv || i < 0) return;
  const el = rv.view.querySelector(`.bar[data-bar='${i}']`);
  if (!el) return;
  el.classList.add("on");
  lit = el;
  const sc = rv.view.querySelector("#song-scroll");
  const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - sr.height * 0.3, behavior: "smooth" });
}

/* ---- Actions ---- */

function wire() {
  const v = rv.view;
  const fileInput = v.querySelector("#rec-file");
  if (fileInput) fileInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) run(f); });
  v.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b)));
  v.querySelectorAll("[data-bpb]").forEach((b) => b.addEventListener("click", () => { rv.bpb = +b.dataset.bpb; rebuild(); edited(); }));
  v.querySelectorAll(".bar[data-bar]").forEach((el) => {
    let timer = null, long = false;
    el.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; splitJoin(+el.dataset.bar); }, 550); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((t) => el.addEventListener(t, () => clearTimeout(timer)));
    el.addEventListener("click", () => { if (!long) openPicker(+el.dataset.bar); });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function edited() {
  rv.saved = false;
  if (pa && pa.playing) restartPlay(pa.position);
  render();
}

async function act(a, btn) {
  if (a === "reanalyse") run(null);
  else if (a === "delete-rec") {
    if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "Tap again to delete"; return; }
    closeReview();
    await deleteRecording(rv.id);
    rv.meta = null;
    rv.mono = null;
    toast("Recording deleted. The chords stay until you delete them.");
    render();
  } else if (a === "half" || a === "double") {
    const f = a === "half" ? 0.5 : 2;
    rv.factor = rv.factor === f ? 1 : f;
    rebuild();
    edited();
  } else if (a === "phase-" || a === "phase+") {
    rv.phase = (rv.phase + (a === "phase+" ? 1 : rv.bpb - 1)) % rv.bpb;
    rebuild({ keepPhase: true });
    edited();
  } else if (a === "capo") {
    const sug = rv.capoSuggestion || 0;
    rv.ctx.setCapo(capo() === sug ? 0 : sug);
    render();
  } else if (a === "strum") {
    rv.strum = !rv.strum;
    if (pa && pa.playing) restartPlay(pa.position);
    render();
  } else if (a === "playalong") togglePlay();
  else if (a === "save") save(false);
  else if (a === "checked") save(true);
}

async function ensureMono() {
  if (rv.mono) return rv.mono;
  const file = await getRecording(rv.id);
  if (!file) throw new Error("The recording isn't on this device. Choose it again to play along.");
  toast("Loading the recording…", 1500);
  rv.mono = (await decodeToMono(file)).mono;
  return rv.mono;
}

function playBars() {
  return rv.bars.map((b) => ({ ...b, frets: b.chords.map((c) => { const v = bestVoicing(shape(c), null, rv.ctx.tuning); return v ? v.frets : null; }) }));
}

async function togglePlay(from) {
  const p = player();
  if (p.playing) { rv.from = p.position; p.stop(); return; }
  try {
    const mono = await ensureMono();
    await p.start(mono, playBars(), ticks(), { from: from ?? rv.from ?? 0, strum: rv.strum, capo: capo(), cents: tuningCents(), open: rv.ctx.tuning && rv.ctx.tuning.open });
  } catch (e) {
    toast(e.message, 3500);
  }
}

function restartPlay(at) {
  const p = player();
  p.stop();
  togglePlay(Math.max(0, at));
}

// "This is beat 1": the beat nearest the tap (allowing a little reaction time).
function tapBeat1() {
  const t = player().position - 0.08;
  const tk = ticks();
  let best = 0;
  for (let i = 1; i < tk.length; i++) if (Math.abs(tk[i] - t) < Math.abs(tk[best] - t)) best = i;
  rv.phase = best % rv.bpb;
  rebuild({ keepPhase: true });
  toast(`Bars now start on that beat.`);
  edited();
}

function splitJoin(i) {
  const b = rv.bars[i];
  b.chords = b.chords.length > 1 ? [b.chords[0]] : [b.chords[0], b.chords[0]];
  b.edited = true;
  edited();
  if (b.chords.length > 1) openPicker(i, 1);
}

function openPicker(i, half = 0) {
  const b = rv.bars[i];
  half = Math.min(half, b.chords.length - 1);
  const current = shape(b.chords[half]);
  const k = soundingKey();
  const inKey = k ? diatonicChords(k).map(shape) : [];
  const cur = parseChord(current);
  let root = cur ? ROOTS[cur.root] : "C", qual = cur ? cur.q : "";
  const html = `<div class='popover-head'><span class='popover-name'>Bar ${i + 1}</span>
      ${pa && rv.meta ? "<button class='btn outline small' data-from>▶ From here</button>" : ""}</div>
    ${b.chords.length > 1 ? `<div class='seg' role='group' aria-label='Which half'>${b.chords.map((c, h) =>
      `<button data-half='${h}' class='${h === half ? "on" : ""}'>${h ? "Second" : "First"} half: ${esc(prettyChord(shape(c)))}</button>`).join("")}</div>` : ""}
    ${inKey.length ? `<div class='h2' style='margin:0'>In the key of ${esc(prettyChord(transposeKey(k, -capo())))}</div>
      <div class='chord-grid'>${inKey.map((c) => `<button class='pick ${c === current ? "on" : ""}' data-pick='${esc(c)}'>${esc(prettyChord(c))}</button>`).join("")}</div>` : ""}
    <div class='h2' style='margin:0'>Any chord</div>
    <div class='chord-grid roots'>${ROOTS.map((r) => `<button class='pick ${r === root ? "on" : ""}' data-root='${r}'>${prettyChord(r)}</button>`).join("")}</div>
    <div class='chord-grid quals'>${QUALS.map(([q, l]) => `<button class='pick ${q === qual ? "on" : ""}' data-qual='${q}'>${l}</button>`).join("")}</div>
    <div style='display:flex;gap:8px'>
      <button class='btn outline' style='flex:1' data-split>${b.chords.length > 1 ? "Join halves" : "Split bar"}</button>
      <button class='btn primary' style='flex:1' data-use>Use ${esc(prettyChord(root + qual))}</button></div>
    <button class='btn outline' data-close>Done</button>`;
  const p = showPopover(html, `Bar ${i + 1}`);
  const set = (shapeName) => {
    b.chords[half] = sounding(shapeName);
    if (b.chords.length === 2 && b.chords[0] === b.chords[1]) b.chords = [b.chords[0]];
    b.edited = true;
    closePopover();
    edited();
  };
  p.querySelectorAll("[data-pick]").forEach((x) => x.addEventListener("click", () => set(x.dataset.pick)));
  p.querySelectorAll("[data-half]").forEach((x) => x.addEventListener("click", () => openPicker(i, +x.dataset.half)));
  const useBtn = p.querySelector("[data-use]");
  const refresh = () => {
    p.querySelectorAll("[data-root]").forEach((x) => x.classList.toggle("on", x.dataset.root === root));
    p.querySelectorAll("[data-qual]").forEach((x) => x.classList.toggle("on", x.dataset.qual === qual));
    useBtn.textContent = "Use " + prettyChord(chordName(parseChord(root + qual)));
  };
  p.querySelectorAll("[data-root]").forEach((x) => x.addEventListener("click", () => { root = x.dataset.root; refresh(); }));
  p.querySelectorAll("[data-qual]").forEach((x) => x.addEventListener("click", () => { qual = x.dataset.qual; refresh(); }));
  useBtn.addEventListener("click", () => set(chordName(parseChord(root + qual))));
  p.querySelector("[data-split]").addEventListener("click", () => { closePopover(); splitJoin(i); });
  const from = p.querySelector("[data-from]");
  if (from) from.addEventListener("click", () => { closePopover(); rv.from = b.t; restartPlay(b.t); });
}

async function save(checked) {
  if (!rv.raw) return;
  if (checked) rv.checked = true;
  const chart = chartFromRaw(rv.raw, {
    id: rv.id, title: rv.ctx.title, artist: rv.ctx.artist, file: rv.meta ? rv.meta.name : null,
    bpb: rv.bpb, factor: rv.factor, phase: rv.phase, bars: rv.bars, checked: rv.checked,
  });
  keepShippedFacts(chart, rv.ctx.shipped);
  await saveChart(chart);
  rv.saved = true;
  toast(rv.checked ? "Saved as yours (checked)." : "Chords saved as detected. Check them by ear.");
  closeReview();
  rv.ctx.onSaved();
}
