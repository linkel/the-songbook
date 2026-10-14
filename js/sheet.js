// The song view (#/song/<id>/<mode>). Phase 0 has the Chords mode: sections
// as bars, transpose / simple / capo, chord diagrams with popovers, where the
// chart came from, and Play (the app guitar strums or picks the chart).

import { loadChart, loadPrefs, savePrefs } from "./library.js";
import {
  displayChord, transposeChord, transposeKey, guessKey, splitBars, voicingsFor, pimaChord,
  suggestCapo, prettyChord, simplifyChord,
} from "./chords.js";
import { chordBoxSvg } from "./diagram.js";
import { ChartPlayer } from "./chartplay.js";
import { StringVoices, strum, resumeAudio, warmNotes, plainStrum, audioContext } from "./audio.js";
import { PATTERN_BY_ID, OPEN_MIDI } from "./patterns.js";
import { esc, sourceBadge, sourceSentence, pickingLabel, patternName, ICONS, toast } from "./ui.js";

const MODES = [["sheet", "Sheet"], ["chords", "Chords"], ["picking", "Picking"], ["player", "Player"]];
const READY_MODES = new Set(["chords"]);
const MIN_BPM = 30, MAX_BPM = 220, DEFAULT_BPM = 80;

let cur = null;           // { id, chart, prefs, mode, view }
let player = null;
const hearVoices = () => (hearVoices.v = hearVoices.v || new StringVoices("guitar"));

function getPlayer() {
  if (!player) {
    player = new ChartPlayer("guitar");
    player.addEventListener("bar", (e) => highlightBar(e.detail.bar));
    player.addEventListener("state", () => { updateTransport(); if (!player.playing) highlightBar(-1); });
    player.addEventListener("end", () => player.stop(0.4));
  }
  return player;
}

/* ---- Derived chart view ---- */

function viewOpts() {
  const p = cur.prefs;
  return { transpose: p.transpose, capo: p.capo, simple: p.simple };
}

// Sounding chord names (what the recording plays) for key and capo maths.
function soundingNames() {
  const shift = (cur.chart.capo || 0) + cur.prefs.transpose;
  const names = [];
  for (const s of cur.chart.sections || []) for (const bar of splitBars(s.chords)) for (const n of bar) names.push(transposeChord(n, shift));
  return names;
}

function soundingKey() {
  if (cur.chart.key) return { key: transposeKey(cur.chart.key, cur.prefs.transpose), estimated: false };
  const g = guessKey(soundingNames());
  return g ? { key: g.key, estimated: true } : null;
}

function disp(name) {
  const k = soundingKey();
  const shapeKey = k ? transposeKey(k.key, -cur.prefs.capo) : null;
  return displayChord(name, cur.chart, { ...viewOpts(), shapeKey });
}

// The chart's own voicings apply when the shapes are the chart's own.
function voicingMap() {
  const shift = (cur.chart.capo || 0) + cur.prefs.transpose - cur.prefs.capo;
  const own = shift === 0 && !cur.prefs.simple ? cur.chart.voicings || {} : {};
  return { ...own, ...(cur.prefs.voicings || {}) };
}

function voicing(name) {
  const v = voicingsFor(name, voicingMap());
  return v.length ? v[0] : null;
}

// Bars in play order: the form (or the sections in order), with repeats.
function flatBars() {
  const secs = cur.chart.sections || [];
  const order = cur.chart.form && cur.chart.form.length
    ? cur.chart.form.map((n) => secs.findIndex((s) => s.name === n)).filter((i) => i >= 0)
    : secs.map((_, i) => i);
  const out = [];
  for (const si of order) {
    const bars = splitBars(secs[si].chords);
    for (let r = 0; r < (secs[si].repeat || 1); r++) bars.forEach((b, bi) => out.push({ sec: si, bar: bi, names: b }));
  }
  return out;
}

function playBars() {
  const vm = voicingMap();
  return flatBars().map((b) => ({
    sec: b.sec, bar: b.bar,
    chords: b.names.map((n) => {
      const d = disp(n);
      const v = voicingsFor(d, vm)[0];
      return { name: d, frets: v ? v.frets : null, pima: v ? pimaChord(d, { [d]: v.spec }) : null };
    }),
  }));
}

// What Play will play, said plainly.
function playPlan() {
  const c = cur.chart;
  const time = c.time || "4/4";
  if (c.strum) return { strum: c.strum, text: `Strum ${c.strum}` };
  const pid = c.picking && c.picking.patterns && c.picking.patterns[0];
  const pattern = pid && PATTERN_BY_ID.get(pid);
  if (pattern && c.style !== "strummed") {
    const lab = pickingLabel(c.picking);
    return { pattern, text: `Picking: ${patternName(pid)} (${lab.text})` };
  }
  return { strum: plainStrum(time), text: "Plain strum, one per beat (no strum pattern in this chart)" };
}

function tempo() { return cur.prefs.tempo || cur.chart.tempo || DEFAULT_BPM; }

/* ---- Rendering ---- */

export async function openSong(view, id, mode) {
  if (!cur || cur.id !== id) {
    stopPlaying();
    const chart = await loadChart(id);
    if (!chart) {
      view.innerHTML = `<div class='topbar'><a class='back' href='#/songs' aria-label='Back'>${ICONS.back}</a>
        <div class='topbar-title'><div class='t'>Song not found</div></div></div>
        <div class='song-scroll'><div class='card empty'>There's no song "${esc(id)}".</div></div>`;
      cur = null;
      return;
    }
    cur = { id, chart, prefs: await loadPrefs(id, chart), mode: null, view };
  }
  cur.view = view;
  cur.mode = READY_MODES.has(mode) ? mode : "chords";
  render();
}

export function closeSong() {
  stopPlaying();
  closePopover();
}

function stopPlaying() { if (player && player.playing) player.stop(); }

function render() {
  const { chart, view } = cur;
  const hasChords = (chart.sections || []).some((s) => s.chords && s.chords.trim());
  const scroll = view.querySelector(".song-scroll");
  const keepScroll = scroll ? scroll.scrollTop : 0;
  view.innerHTML = `
    <div class='topbar'>
      <a class='back' href='#/songs' aria-label='Back to songs'>${ICONS.back}</a>
      <div class='topbar-title'><div class='t'>${esc(chart.title)}</div><div class='meta'>${esc(chart.artist)}</div></div>
      ${sourceBadge(chart)}
    </div>
    <div class='song-body'>
      <div class='song-scroll'><div class='song-main-col'>
        ${headCard(hasChords)}
        <div class='seg' role='tablist' aria-label='Mode'>${MODES.map(([m, label]) =>
          `<button role='tab' data-mode='${m}' class='${m === cur.mode ? "on" : ""}' aria-selected='${m === cur.mode}'
            ${READY_MODES.has(m) ? "" : "disabled title='Coming in a later update'"}>${label}</button>`).join("")}</div>
        ${hasChords ? toolbar() + sectionsHtml() + `<div class='card boxes boxes-card'>${boxesHtml()}</div>` : noChordsCard()}
        ${provenanceCard()}
      </div></div>
      <aside class='song-side' aria-label='Chords and transport'>
        ${hasChords ? `<div class='h2'>Chords</div><div class='boxes'>${boxesHtml()}</div>` : ""}
        <div class='note plays'>${hasChords ? esc(playPlan().text) : ""}</div>
        ${transportHtml(hasChords)}
      </aside>
    </div>
    <div class='transport mobile'>${transportInner(hasChords)}</div>`;
  view.querySelector(".song-scroll").scrollTop = keepScroll;
  wire(view);
  updateTransport();
}

function headCard(hasChords) {
  const c = cur.chart;
  const chips = [];
  if (hasChords) {
    const k = soundingKey();
    if (cur.prefs.capo) chips.push(`<span class='chip'>Capo <b>${cur.prefs.capo}</b></span>`);
    if (k) {
      const shapeKey = transposeKey(k.key, -cur.prefs.capo);
      const txt = cur.prefs.capo ? `${prettyChord(shapeKey)}</b> shapes · sounds <b>${prettyChord(k.key)}` : prettyChord(k.key);
      chips.push(`<span class='chip' title='${k.estimated ? "Estimated from the chords" : "From the chart"}'>Key <b>${txt}</b>${k.estimated ? " <span class='meta'>est.</span>" : ""}</span>`);
    }
    chips.push(`<span class='chip'>${c.tempo ? `<b>${c.tempo}</b> bpm` : "Tempo <span class='meta'>not set</span>"}</span>`);
    if (c.time) chips.push(`<span class='chip'>${esc(c.time)}</span>`);
  }
  const style = [c.style, c.type === "piece" ? "piece" : null].filter(Boolean).join(" · ");
  return `<div class='card head'><h1 class='song-title'>${esc(c.title)}</h1>
    <div class='meta'>${esc(c.artist)}${style ? " · " + esc(style) : ""}</div>
    ${chips.length ? `<div class='chips'>${chips.join("")}</div>` : ""}</div>`;
}

function toolbar() {
  const p = cur.prefs;
  const t = p.transpose > 0 ? "+" + p.transpose : String(p.transpose).replace("-", "−");
  return `<div class='toolbar' role='toolbar' aria-label='Chord tools'>
    <span class='tool-group'><button class='tool' data-act='tr-' aria-label='Transpose down'>−</button><span class='tool label'>Transpose&nbsp;<b>${t}</b></span><button class='tool' data-act='tr+' aria-label='Transpose up'>+</button></span>
    <button class='tool ${p.simple ? "on" : ""}' data-act='simple' aria-pressed='${p.simple}'>Simple</button>
    <button class='tool' data-act='capo'>Capo ${p.capo}</button>
  </div>`;
}

function sectionsHtml() {
  const secs = cur.chart.sections || [];
  return secs.map((s, si) => {
    const bars = splitBars(s.chords);
    return `<div class='card section' data-sec='${si}'>
      <div class='sec-head'><span class='sec-name'>${esc(s.name)}</span><span class='meta'>${s.repeat > 1 ? "×" + s.repeat + " · " : ""}${bars.length} bar${bars.length === 1 ? "" : "s"}</span></div>
      <div class='bars'>${bars.map((b, bi) => `<button class='bar' data-sec='${si}' data-bar='${bi}' aria-label='Bar ${bi + 1}: ${esc(b.map(disp).join(" "))}'>${b.map((n) =>
        `<span class='ch'>${esc(prettyChord(disp(n)))}</span>`).join("")}</button>`).join("")}</div>
    </div>`;
  }).join("");
}

function uniqueDisplayed() {
  const seen = [];
  for (const s of cur.chart.sections || []) for (const b of splitBars(s.chords)) for (const n of b) {
    const d = disp(n);
    if (!seen.includes(d)) seen.push(d);
  }
  return seen;
}

function boxesHtml() {
  return uniqueDisplayed().map((d) => {
    const v = voicing(d);
    return `<button class='box' data-chord='${esc(d)}'>${esc(prettyChord(d))}${v ? chordBoxSvg(v.frets, { label: d + " " + v.spec }) : "<span class='nobox'>no shape found</span>"}</button>`;
  }).join("");
}

function noChordsCard() {
  return `<div class='card empty'><b>No chord chart yet.</b><br>Nothing here is invented: chords will come from analysing a recording, a cited chart, or a sheet you paste.</div>`;
}

function provenanceCard() {
  const c = cur.chart;
  const parts = [];
  const hasChords = (c.sections || []).some((s) => s.chords);
  if (hasChords) {
    parts.push(`<div><b>Chords:</b> ${esc(sourceSentence(c))}</div>`);
    if (c.notes) parts.push(`<div class='note' style='margin-top:6px'>${esc(c.notes)}</div>`);
    if (c.sources && c.sources.length) parts.push(`<ul>${c.sources.map((s) =>
      `<li><a href='${esc(s.url)}' target='_blank' rel='noopener'>${esc(s.label)}</a></li>`).join("")}</ul>`);
  }
  const p = c.picking;
  if (p && p.patterns && p.patterns.length) {
    const lab = pickingLabel(p);
    parts.push(`<div style='margin-top:${hasChords ? 12 : 0}px'><b>Picking${p.part ? " (" + esc(p.part) + ")" : ""}:</b>
      ${p.patterns.map((id) => `<span class='badge pick'>${esc(patternName(id))}</span>`).join(" ")}
      <span class='src-label'>${esc(lab.text)}, ${esc(p.match)} match</span></div>`);
    if (p.description) parts.push(`<div class='note' style='margin-top:6px'>${esc(p.description)}</div>`);
    if (p.sources && p.sources.length) parts.push(`<ul>${p.sources.map((s) =>
      `<li><a href='${esc(s.url)}' target='_blank' rel='noopener'>${esc(s.label)}</a></li>`).join("")}</ul>`);
  }
  return parts.length ? `<div class='card sources'>${parts.join("")}</div>` : "";
}

function transportInner(hasChords) {
  return `<button class='btn outline round' data-act='bpm-' aria-label='Slower'>−</button>
    <div class='tempo' aria-live='polite'><span class='bpm'>${tempo()}</span><small>BPM</small></div>
    <button class='btn outline round' data-act='bpm+' aria-label='Faster'>+</button>
    <button class='btn primary play' data-act='play' style='flex:1' ${hasChords ? "" : "disabled"}>▶ Play</button>`;
}

function transportHtml(hasChords) { return `<div class='transport'>${transportInner(hasChords)}</div>`; }

function updateTransport() {
  if (!cur || !cur.view) return;
  const playing = player && player.playing;
  cur.view.querySelectorAll(".play").forEach((b) => {
    b.textContent = playing ? "■ Stop" : "▶ Play";
    b.classList.toggle("stop", !!playing);
  });
  cur.view.querySelectorAll(".bpm").forEach((el) => { el.textContent = tempo(); });
}

let litBar = null;
function highlightBar(i) {
  if (litBar) litBar.classList.remove("on");
  litBar = null;
  if (!cur || i < 0) return;
  const b = player && player.session ? player.session.bars[i] : null;
  if (!b) return;
  const el = cur.view.querySelector(`.bar[data-sec='${b.sec}'][data-bar='${b.bar}']`);
  if (!el) return;
  el.classList.add("on");
  litBar = el;
  const sc = cur.view.querySelector(".song-scroll");
  const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  if (r.top < sr.top + 8 || r.bottom > sr.bottom - 8) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---- Actions ---- */

function setPrefs(patch) {
  Object.assign(cur.prefs, patch);
  savePrefs(cur.id, cur.prefs);
  render();
  if (player && player.playing) player.setBars(playBars());
}

export function transposeBy(n) {
  if (!cur) return;
  const t = Math.max(-11, Math.min(11, cur.prefs.transpose + n));
  setPrefs({ transpose: t });
}

export function setTempo(bpm) {
  if (!cur) return;
  cur.prefs.tempo = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
  savePrefs(cur.id, cur.prefs);
  if (player) player.setTempo(cur.prefs.tempo);
  updateTransport();
}

export function tempoBy(n) { if (cur) setTempo(tempo() + n); }

export async function togglePlay() {
  if (!cur) return;
  const p = getPlayer();
  if (p.playing) { p.stop(); return; }
  const plan = playPlan();
  const bars = playBars();
  if (!bars.length) return;
  if (bars.some((b) => b.chords.some((c) => !c.frets))) toast("Some chords have no shape, so they're silent.");
  await p.start({
    bars, bpm: tempo(), time: cur.chart.time || "4/4", capo: cur.prefs.capo,
    strum: plan.strum, pattern: plan.pattern, countIn: false, loop: false,
  });
}

function wire(view) {
  view.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "bpm-" || act === "bpm+") {
      holdable(b, act === "bpm+" ? 1 : -1);
      return;
    }
    b.addEventListener("click", () => {
      if (act === "tr-") transposeBy(-1);
      else if (act === "tr+") transposeBy(1);
      else if (act === "simple") setPrefs({ simple: !cur.prefs.simple });
      else if (act === "capo") openCapo();
      else if (act === "play") togglePlay();
    });
  });
  view.querySelectorAll(".seg button[data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (!b.disabled) location.hash = `#/song/${encodeURIComponent(cur.id)}/${b.dataset.mode}`;
  }));
  view.querySelectorAll(".box[data-chord]").forEach((b) => b.addEventListener("click", () => openChord([b.dataset.chord])));
  view.querySelectorAll(".bar[data-sec]").forEach((b) => b.addEventListener("click", () => {
    const s = cur.chart.sections[+b.dataset.sec];
    openChord(splitBars(s.chords)[+b.dataset.bar].map(disp));
  }));
}

// Tempo buttons repeat while held (Pimapeggio's holdable).
function holdable(el, step) {
  let t1 = null, t2 = null;
  const fire = () => tempoBy(step);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fire();
    t1 = setTimeout(() => { t2 = setInterval(fire, 90); }, 450);
  });
  const up = () => { clearTimeout(t1); clearInterval(t2); };
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => el.addEventListener(t, up));
}

/* ---- Popovers: a chord's shapes, and the capo ---- */

let pop = null;

function closePopover() {
  if (pop) { pop.remove(); pop = null; }
}

function showPopover(html, label) {
  closePopover();
  pop = document.createElement("div");
  pop.className = "popover-scrim";
  pop.innerHTML = `<div class='popover' role='dialog' aria-modal='true' aria-label='${esc(label)}'>${html}</div>`;
  pop.addEventListener("click", (e) => { if (e.target === pop) closePopover(); });
  document.body.appendChild(pop);
  pop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePopover));
  return pop;
}

export function popoverOpen() { return !!pop; }
export { closePopover };

async function hear(frets) {
  await resumeAudio();
  const midis = frets.map((f, i) => (f === null ? null : OPEN_MIDI[6 - i] + f + cur.prefs.capo)).filter((m) => m !== null);
  await warmNotes(midis);
  const v = hearVoices();
  strum(v, frets, audioContext().currentTime + 0.03, { capo: cur.prefs.capo, level: 0.4 });
}

function openChord(names) {
  const vm = voicingMap();
  const html = names.map((name) => {
    const vs = voicingsFor(name, vm).slice(0, 6);
    const chosen = vs[0];
    return `<div class='popover-head'><span class='popover-name'>${esc(prettyChord(name))}</span>
        ${chosen ? `<button class='btn outline small' data-hear='${esc(name)}'>▶ Hear it</button>` : ""}</div>
      <div class='boxes'>${vs.length ? vs.map((v, i) => `<button class='box ${i === 0 ? "sel" : ""}' data-name='${esc(name)}' data-spec='${esc(v.spec)}'
        aria-label='${esc(name)} ${esc(v.spec)}'>${esc(v.spec)}${chordBoxSvg(v.frets, { label: name + " " + v.spec })}</button>`).join("")
        : "<span class='note'>No shape found for this chord.</span>"}</div>`;
  }).join("<hr style='border:none;border-top:1px solid var(--surface0)'>");
  const p = showPopover(html + `<p class='note'>Tap a shape to use it in this song and hear it.</p>
    <button class='btn outline' data-close>Done</button>`, "Chord shapes");
  p.querySelectorAll("[data-hear]").forEach((b) => b.addEventListener("click", () => {
    const v = voicingsFor(b.dataset.hear, voicingMap())[0];
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

function openCapo() {
  const names = soundingNames().map((n) => (cur.prefs.simple ? simplifyChord(n) : n));
  const sug = suggestCapo(names, { key: soundingKey()?.key || null });
  const shapes = [...new Set(Object.values(sug.shapes))].slice(0, 6).map(prettyChord).join(" ");
  const html = `<div class='popover-head'><span class='popover-name' style='font-size:20px'>Capo</span></div>
    <div class='seg capo-grid' role='group' aria-label='Capo fret'>${[0, 1, 2, 3, 4, 5, 6, 7].map((c) =>
      `<button data-capo='${c}' class='${c === cur.prefs.capo ? "on" : ""}'>${c}</button>`).join("")}</div>
    <p class='note'>Suggested: <b>capo ${sug.capo}</b>${shapes ? `, playing ${esc(shapes)}` : ""}. The chords sound the same at any capo; only the shapes change.</p>
    <div style='display:flex;gap:8px'><button class='btn outline' style='flex:1' data-capo='${sug.capo}'>Use capo ${sug.capo}</button>
    <button class='btn outline' style='flex:1' data-close>Done</button></div>`;
  const p = showPopover(html, "Capo");
  p.querySelectorAll("[data-capo]").forEach((b) => b.addEventListener("click", () => {
    setPrefs({ capo: +b.dataset.capo });
    openCapo();
  }));
}

// For tests and the desktop shortcuts.
export const songState = () => cur && { id: cur.id, prefs: { ...cur.prefs }, displayed: uniqueDisplayed(), bars: playBars() };
export { getPlayer };
