// The part editor in Picking mode (plan Phase 5b, step 3): a section's guitar
// part bar by bar (js/part.js). A bar strip shows each bar's pattern and where
// it changes; tap a bar to choose a library pattern or one of the song's own,
// or write it out on a step grid (strings × steps: tap to place a finger, tap
// again for the next finger, press and hold for the fret, a hammer-on, pull-off
// or slide, or a mute), give it its own shape, repeat it over the next bars or
// copy it. Your edits make the part yours ("mine"); a detected part shows "?"
// on bars the detector wasn't sure of, and "Mark as checked" when it's right.

import { PATTERN_BY_ID, parseSteps, stepsText, noteText, noteString, chordFret, parseVoicing, defaultName } from "./patterns.js";
import { expandPart, partPattern, editedPart, patternRuns } from "./part.js";
import { fingersHtml, diagramSvg, notationHtml, patternListHtml, HOME } from "./picking.js";
import { specFrets, fretsSpec, prettyChord } from "./chords.js";
import { fretPickerHtml, wireFretPicker } from "./diagram.js";
import { esc, toast, showPopover, closePopover, patternName } from "./ui.js";

const FINGERS = ["p", "i", "m", "a"];
const LOW = 0.6;   // a detected bar below this confidence shows "?"
let clipboard = null;

// ctx: { bars (picking.js sectionBars), part, partFrom ("device" | "chart"), beats,
//        tuning, capo, sectionName, save(part) -> Promise, hear(frets), playStep(bar, steps) }

// The bar's chord as Pimapeggio sees it, with the bar's own shape if it has one.
export function barChord(ctx, i, k = 0, exp = null) {
  const b = ctx.bars[i];
  if (!b) return null;
  const ch = b.chords[Math.min(k, b.chords.length - 1)];
  const e = exp || expanded(ctx)[i];
  const shape = e && e.shape && (e.shape[k] || e.shape[0]);
  if (shape) return { ...ch, frets: shape, spec: fretsSpec(shape), pima: parseVoicing(ch.name, fretsSpec(shape)), own: true };
  return ch;
}

export function expanded(ctx) {
  return expandPart(ctx.part, ctx.bars.length, ctx.beats);
}

// The bars to play: each with its own steps (and shapes).
export function partPlayBars(ctx) {
  const ex = expanded(ctx);
  return ctx.bars.map((b, i) => ({
    ...b,
    chords: b.chords.map((_, k) => barChord(ctx, i, k, ex[i])),
    part: ex[i].steps ? { steps: ex[i].steps } : null,
  }));
}

// A bar shown on the stage like a pattern: { steps, npb, letters, name }.
export function barAsPattern(ctx, i) {
  const e = expanded(ctx)[i];
  if (!e || !e.steps) return null;
  const name = e.kind === "steps" ? "Written out" : e.pattern ? (partPattern(ctx.part, e.pattern) || {}).name || e.pattern : "";
  return { steps: e.steps, npb: Math.max(1, Math.round(e.steps.length / ctx.beats)), letters: defaultName(e.steps), name, id: e.pattern };
}

/* ---- The strip ---- */

function label(part, e) {
  if (e.kind === "error") return "?";
  if (e.kind === "steps") return "written";
  if (e.kind === "repeat") return "″";
  if (e.kind === "none") return "–";
  const p = partPattern(part, e.pattern);
  return p && p.own ? "pattern " + e.pattern : e.pattern;
}

export function stripHtml(ctx, sel = -1, lit = -1) {
  const ex = expanded(ctx);
  const runs = patternRuns(ex);
  const starts = new Set(runs.map((r) => r.from));
  return `<div class='part-strip' role='group' aria-label='Bars of ${esc(ctx.sectionName)}: tap one to edit it'>${ex.map((e, i) => {
    const b = ctx.bars[i];
    const unsure = e.confidence !== null && e.confidence < LOW;
    const own = e.shape && e.given && e.given.shape !== undefined;
    return `<button class='pbar${i === sel ? " sel" : ""}${i === lit ? " on" : ""}${starts.has(i) && i > 0 ? " change" : ""}${unsure ? " unsure" : ""}' data-pbar='${i}'
      aria-label='Bar ${i + 1}: ${esc(b.chords.map((c) => c.name).join(" "))}, ${esc(label(ctx.part, e) === "″" ? "same as before" : label(ctx.part, e))}${unsure ? ", unsure" : ""}${own ? ", your shape" : ""}'>
      <span class='ch'>${b.chords.map((c) => esc(prettyChord(c.name))).join(" ")}</span>
      <span class='pl'>${esc(label(ctx.part, e))}${unsure ? " <b class='q'>?</b>" : ""}${own ? " ✎" : ""}</span></button>`;
  }).join("")}</div>`;
}

/* ---- Editing ---- */

// Change the part (a copy: yours on this device), then save. A bar you've
// edited is no longer the detector's guess, so its confidence goes.
function mutate(ctx, fn, bar = null) {
  const p = editedPart(ctx.part || { bars: [] });
  if (!p.bars) p.bars = [];
  while (p.bars.length < ctx.bars.length) p.bars.push({});
  fn(p);
  if (bar !== null && p.bars[bar]) { delete p.bars[bar].confidence; delete p.bars[bar].match; }
  // Trailing bars that just repeat aren't needed.
  while (p.bars.length > 1 && Object.keys(p.bars[p.bars.length - 1]).length === 0) p.bars.pop();
  return ctx.save(p);
}

const barOf = (ctx, i) => ((ctx.part && ctx.part.bars) || [])[i] || {};

// Grid <-> steps. A grid is [step][string 1..6] = note | null.
function toGrid(ctx, i, steps) {
  const ch = barChord(ctx, i).pima;
  return steps.map((st) => {
    const row = new Array(7).fill(null);
    for (const n of st) row[noteString(n, ch, HOME)] = { ...n };
    return row;
  });
}

function noteFor(ctx, i, string, f, extra = {}) {
  const ch = barChord(ctx, i).pima;
  let s = string;
  if (f === "p") s = string === ch.bass ? "B" : string === ch.alt ? "A" : string;
  else if (HOME[f] === string) s = null;
  return { f, s, ...extra };
}

function fromGrid(grid) {
  return stepsText(grid.map((row) => {
    const notes = [];
    for (let s = 6; s >= 1; s--) if (row[s]) notes.push(row[s]);
    return notes;
  }));
}

// Default finger for a string: the thumb on the bass strings, i m a on 3 2 1.
const defaultFinger = (s) => (s >= 4 ? "p" : s === 3 ? "i" : s === 2 ? "m" : "a");

export function openBarEditor(ctx, i, view = null) {
  const e = expanded(ctx)[i];
  const b = ctx.bars[i];
  const given = barOf(ctx, i);
  const mode = view || (e.kind === "steps" ? "steps" : e.kind === "repeat" && !given.pattern ? "repeat" : "pattern");
  const ownIds = Object.keys((ctx.part && ctx.part.patterns) || {});
  const ch = barChord(ctx, i);
  const grid = e.steps ? toGrid(ctx, i, e.steps) : toGrid(ctx, i, parseSteps("pB i pA m pB i pA m"));
  const sel = openBarEditor.sel && openBarEditor.sel.bar === i ? openBarEditor.sel : null;
  const steps = grid.length;

  const patternView = `<div class='set-label'>Pattern</div>
    <p class='note' style='margin:0 0 6px'>${e.kind === "pattern" ? `Now: <b>${esc(label(ctx.part, e))}</b>${e.pattern && !partPattern(ctx.part, e.pattern).own ? ` (${esc(patternName(e.pattern))})` : ""}, repeated to fill the bar.` : "Choose one; it repeats to fill the bar."}</p>
    ${ownIds.length ? `<div class='h2' style='margin:6px 0'>This song's own</div><div class='pattern-grid'>${ownIds.map((id) =>
      `<button class='pattern-btn ${given.pattern === id ? "on" : ""}' data-own-pat='${esc(id)}' aria-pressed='${given.pattern === id}'><span class='pn'>Pattern ${esc(id)}</span><span class='meta'>${esc(defaultName(partPattern(ctx.part, id).steps))}</span></button>`).join("")}</div>` : ""}
    <details class='lib-list'><summary>Library patterns</summary>${patternListHtml(given.pattern && PATTERN_BY_ID.has(given.pattern) ? given.pattern : null, [])}</details>`;

  const gridView = `<div class='seg small-seg' role='group' aria-label='Steps in the bar' style='margin-bottom:8px'>${[2, 3, 4].map((per) => {
      const n = per * ctx.beats;
      return `<button data-steps='${n}' class='${steps === n ? "on" : ""}' aria-pressed='${steps === n}'>${n} ${per === 2 ? "eighths" : per === 3 ? "triplets" : "16ths"}</button>`;
    }).join("")}</div>
    <div class='step-grid-wrap'><div class='step-grid' style='--steps:${steps}' role='grid' aria-label='Strings by steps: tap to place a finger'>
      ${[1, 2, 3, 4, 5, 6].map((s) => `<span class='sg-s' aria-hidden='true'>${s}</span>` + grid.map((row, k) => {
        const n = row[s];
        const on = sel && sel.step === k && sel.string === s;
        const fret = n && n.fret !== undefined ? n.fret : null;
        const txt = n ? (n.mute ? n.f + "×" : fret !== null ? n.f + fret : n.f) + (n.tech ? n.tech.type + n.tech.to : "") : "";
        return `<button class='sg-c${n ? " f-" + n.f : ""}${on ? " sel" : ""}${k % (steps / ctx.beats) === 0 ? " beat" : ""}' data-st='${k}' data-s='${s}'
          aria-label='String ${s}, step ${k + 1}${n ? ": " + noteText(n) : ", empty"}'>${esc(txt)}</button>`;
      }).join("")).join("")}
    </div></div>
    <p class='note'>Tap a string to place a finger, tap again for the next finger. Press and hold for its fret, a hammer-on, pull-off or slide, or a mute.</p>
    ${sel && grid[sel.step] && grid[sel.step][sel.string] ? noteDetail(grid[sel.step][sel.string], sel) : ""}
    <div class='row-btns' style='flex-wrap:wrap'>
      <button class='btn outline small' data-grid='clear'>Clear the bar</button>
      ${ownIds.length < 6 ? "<button class='btn outline small' data-grid='save-own'>Make it a pattern of the song's</button>" : ""}
    </div>`;

  const shape = (e.shape && e.shape[0]) || ch.frets || [null, 3, 2, 0, 1, 0];
  const shapeView = `<details class='own-shape'${given.shape !== undefined ? " open" : ""}><summary>Shape for this bar${given.shape !== undefined ? ": yours" : ""}</summary>
    <div class='own-row'><input class='text-input bar-spec' value='${esc(fretsSpec(shape))}' maxlength='17' aria-label='Shape for bar ${i + 1}, low string first' autocomplete='off' spellcheck='false'>
      <button class='btn outline small' data-shape='use'>Use</button></div>
    ${fretPickerHtml(shape, { name: b.chords[0].name })}
    ${given.shape !== undefined ? "<button class='btn outline small' data-shape='reset'>Back to the song's shape</button>" : ""}</details>`;

  const html = `<div class='popover-head'><span class='popover-name' style='font-size:22px'>Bar ${i + 1} · ${esc(b.chords.map((c) => prettyChord(c.name)).join(" "))}</span>
      <button class='btn outline small' data-bar-hear>▶ Hear</button></div>
    ${e.confidence !== null ? `<p class='note' style='margin:0'>Detected: ${Math.round(e.confidence * 100)}% sure${e.match ? `, ${e.match.hits} of ${e.match.of} steps fit ${esc(e.match.pattern)}` : ""}. Fingers are inferred, not heard.</p>` : ""}
    <div class='seg' role='group' aria-label='What this bar plays'>
      <button data-view='pattern' class='${mode === "pattern" ? "on" : ""}' aria-pressed='${mode === "pattern"}'>Pattern</button>
      <button data-view='steps' class='${mode === "steps" ? "on" : ""}' aria-pressed='${mode === "steps"}'>Written out</button>
      ${i > 0 ? `<button data-view='repeat' class='${mode === "repeat" ? "on" : ""}' aria-pressed='${mode === "repeat"}'>Same as bar ${i}</button>` : ""}
    </div>
    ${mode === "pattern" ? patternView : mode === "steps" ? gridView : `<p class='note'>Plays what bar ${i} plays${e.shape ? ", with this bar's shape" : ""}.</p>`}
    ${shapeView}
    <div class='set-row'><div class='meta'>Same for the next bars</div>
      <div class='row-btns'>${[1, 3, 7].filter((n) => i + n < ctx.bars.length).map((n) => `<button class='btn outline small' data-repeat='${n}'>+${n}</button>`).join("")}
        ${i + 1 < ctx.bars.length ? `<button class='btn outline small' data-repeat='all'>All</button>` : ""}</div></div>
    <div class='row-btns'><button class='btn outline small' data-copy>Copy bar</button><button class='btn outline small' data-paste ${clipboard ? "" : "disabled"}>Paste</button>
      ${i + 1 < ctx.bars.length ? "<button class='btn outline small' data-next>Next bar ›</button>" : ""}</div>
    <button class='btn outline' data-close>Done</button>`;
  const p = showPopover(html, `Bar ${i + 1}`);
  const again = (v = mode) => openBarEditor(ctx, i, v);
  const save = (fn, v) => mutate(ctx, fn, i).then(() => again(v));

  p.querySelector("[data-bar-hear]").addEventListener("click", () => ctx.playBar(i));
  p.querySelectorAll("[data-view]").forEach((x) => x.addEventListener("click", () => {
    const v = x.dataset.view;
    if (v === "repeat") { save((pt) => { const sh = pt.bars[i].shape; pt.bars[i] = sh !== undefined ? { shape: sh } : {}; }, v); return; }
    if (v === "steps" && e.kind !== "steps") { save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), steps: fromGrid(grid) }; }, v); return; }
    again(v);
  }));
  p.querySelectorAll("[data-own-pat]").forEach((x) => x.addEventListener("click", () => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: x.dataset.ownPat }; }, "pattern")));
  p.querySelectorAll(".lib-list [data-pattern]").forEach((x) => x.addEventListener("click", () => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: x.dataset.pattern }; }, "pattern")));

  // The step grid.
  const setGrid = (g) => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), steps: fromGrid(g) }; }, "steps");
  p.querySelectorAll("[data-steps]").forEach((x) => x.addEventListener("click", () => {
    const n = +x.dataset.steps;
    if (n === steps) return;
    // Keep the notes that land on the new grid's steps.
    const g = Array.from({ length: n }, (_, k) => { const src = (k * steps) / n; return Number.isInteger(src) ? grid[src].slice() : new Array(7).fill(null); });
    setGrid(g);
  }));
  p.querySelectorAll(".sg-c").forEach((c) => {
    const k = +c.dataset.st, s = +c.dataset.s;
    let timer = null, long = false;
    c.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; openBarEditor.sel = { bar: i, step: k, string: s }; if (!grid[k][s]) { grid[k][s] = noteFor(ctx, i, s, defaultFinger(s)); setGrid(grid); } else again("steps"); }, 500); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((t) => c.addEventListener(t, () => clearTimeout(timer)));
    c.addEventListener("contextmenu", (ev) => ev.preventDefault());
    c.addEventListener("click", () => {
      if (long) return;
      const n = grid[k][s];
      openBarEditor.sel = { bar: i, step: k, string: s };
      if (!n) grid[k][s] = noteFor(ctx, i, s, defaultFinger(s));
      else {
        const next = FINGERS.indexOf(n.f) + 1;
        grid[k][s] = next >= FINGERS.length ? null : noteFor(ctx, i, s, FINGERS[next], pick(n));
      }
      setGrid(grid);
    });
  });
  const detail = p.querySelector(".note-detail");
  if (detail && sel) {
    const n = grid[sel.step][sel.string];
    const upd = (patch) => { grid[sel.step][sel.string] = { ...n, ...patch }; for (const k of Object.keys(patch)) if (patch[k] === undefined) delete grid[sel.step][sel.string][k]; setGrid(grid); };
    detail.querySelectorAll("[data-fret]").forEach((x) => x.addEventListener("click", () => {
      const base = n.fret ?? chordFret(ch.pima, sel.string) ?? 0;
      const v = x.dataset.fret === "shape" ? undefined : Math.max(0, Math.min(20, base + +x.dataset.fret));
      upd({ fret: v });
    }));
    detail.querySelectorAll("[data-tech]").forEach((x) => x.addEventListener("click", () => {
      const t = x.dataset.tech;
      const from = n.fret ?? chordFret(ch.pima, sel.string) ?? 0;
      upd({ tech: t === "none" ? undefined : { type: t, to: Math.max(0, from + (t === "h" || t === "/" ? 2 : -2)) } });
    }));
    detail.querySelectorAll("[data-to]").forEach((x) => x.addEventListener("click", () => {
      if (n.tech) upd({ tech: { ...n.tech, to: Math.max(0, Math.min(20, n.tech.to + +x.dataset.to)) } });
    }));
    const mute = detail.querySelector("[data-mute]");
    if (mute) mute.addEventListener("click", () => upd({ mute: n.mute ? undefined : true }));
    const rm = detail.querySelector("[data-remove]");
    if (rm) rm.addEventListener("click", () => { grid[sel.step][sel.string] = null; openBarEditor.sel = null; setGrid(grid); });
  }
  const gb = p.querySelectorAll("[data-grid]");
  gb.forEach((x) => x.addEventListener("click", () => {
    if (x.dataset.grid === "clear") setGrid(grid.map(() => new Array(7).fill(null)));
    else if (x.dataset.grid === "save-own") {
      const id = "abcdef".split("").find((c) => !ownIds.includes(c));
      const text = fromGrid(grid);
      save((pt) => {
        pt.patterns = { ...(pt.patterns || {}), [id]: { steps: text, npb: Math.max(1, Math.round(grid.length / ctx.beats)) } };
        pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: id };
      }, "pattern");
      toast(`Saved as the song's pattern ${id}: choose it for other bars.`);
    }
  }));

  // The shape for this bar.
  const inp = p.querySelector(".bar-spec");
  const useShape = (spec) => {
    const f = specFrets(spec);
    if (!f) { toast("A shape is six strings, low first, like x00232."); return; }
    save((pt) => { pt.bars[i] = { ...pt.bars[i], shape: fretsSpec(f) }; });
    ctx.hear(f);
  };
  p.querySelector("[data-shape=use]").addEventListener("click", () => useShape(inp.value));
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") useShape(inp.value); });
  const reset = p.querySelector("[data-shape=reset]");
  if (reset) reset.addEventListener("click", () => save((pt) => { const x = { ...pt.bars[i] }; delete x.shape; pt.bars[i] = x; }));
  const fp = p.querySelector(".fret-picker");
  if (fp) wireFretPicker(fp, (f) => { inp.value = fretsSpec(f); ctx.hear(f); });

  // Repeat, copy, paste.
  p.querySelectorAll("[data-repeat]").forEach((x) => x.addEventListener("click", () => {
    const n = x.dataset.repeat === "all" ? ctx.bars.length - 1 - i : +x.dataset.repeat;
    save((pt) => { for (let k = i + 1; k <= i + n && k < ctx.bars.length; k++) pt.bars[k] = {}; });
    toast(n === 1 ? `Bar ${i + 2} plays the same.` : `Bars ${i + 2}–${i + 1 + n} play the same.`);
  }));
  p.querySelector("[data-copy]").addEventListener("click", () => {
    clipboard = { ...expanded(ctx)[i].given, ...(e.kind === "repeat" ? { steps: stepsText(e.steps) } : {}) };
    delete clipboard.confidence; delete clipboard.match;
    toast(`Bar ${i + 1} copied.`);
    again();
  });
  p.querySelector("[data-paste]").addEventListener("click", () => { if (clipboard) save((pt) => { pt.bars[i] = structuredClone(clipboard); }); });
  const nx = p.querySelector("[data-next]");
  if (nx) nx.addEventListener("click", () => { openBarEditor.sel = null; openBarEditor(ctx, i + 1); });
}

const keepShape = (b) => (b && b.shape !== undefined ? { shape: b.shape } : {});
const pick = (n) => { const o = {}; for (const k of ["fret", "tech", "mute"]) if (n[k] !== undefined) o[k] = n[k]; return o; };

function noteDetail(n, sel) {
  const t = n.tech ? n.tech.type : "none";
  return `<div class='note-detail card'>
    <div class='set-label'>String ${sel.string}, step ${sel.step + 1}: ${esc(noteText(n))}</div>
    <div class='nd-row'><span class='meta'>Fret</span>
      <button class='btn outline small' data-fret='-1' aria-label='Fret down'>−</button>
      <b>${n.fret ?? "shape's"}</b>
      <button class='btn outline small' data-fret='1' aria-label='Fret up'>+</button>
      ${n.fret !== undefined ? "<button class='btn outline small' data-fret='shape'>Shape's</button>" : ""}</div>
    <div class='seg small-seg' role='group' aria-label='Technique'>${[["none", "None"], ["h", "Hammer"], ["o", "Pull-off"], ["/", "Slide ↑"], ["\\", "Slide ↓"]].map(([v, l]) =>
      `<button data-tech='${v}' class='${t === v ? "on" : ""}' aria-pressed='${t === v}'>${l}</button>`).join("")}</div>
    ${n.tech ? `<div class='nd-row'><span class='meta'>to fret</span><button class='btn outline small' data-to='-1' aria-label='Lower'>−</button><b>${n.tech.to}</b><button class='btn outline small' data-to='1' aria-label='Higher'>+</button></div>` : ""}
    <div class='row-btns'><button class='btn outline small ${n.mute ? "on" : ""}' data-mute aria-pressed='${!!n.mute}'>Muted ×</button>
      <button class='btn outline small' data-remove>Remove</button></div>
  </div>`;
}

// What a bar's notes are, for screen readers and tests: "pB i3@2h4 ...".
export function barText(ctx, i) {
  const e = expanded(ctx)[i];
  return e && e.steps ? stepsText(e.steps) : "";
}

