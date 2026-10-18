// The part editor in Picking mode (plan Phase 5b, step 3): a section's guitar
// part bar by bar (js/part.js). A bar strip shows each bar's pattern and where
// it changes; tap a bar to choose a library pattern or one of the song's own,
// or write it out on a step grid (strings × steps: tap a spot, then type its
// fret on the pad; the finger is filled in and can be changed, as can a
// hammer-on, pull-off, slide or mute), give it its own shape, repeat it over the
// next bars or copy it. Edits are a draft until Save (Cancel puts it back), and
// a bar can go back to the chart's version. Saved, the part is yours ("mine"); a
// detected part shows "?" on bars the detector wasn't sure of, and "Mark as
// checked" when it's right.

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
//        tuning, capo, sectionName, chartPart (the chart's own, or null),
//        save(part) -> Promise, hear(frets), playBar(i, ctx) }

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

// The open editor works on a draft of the part: nothing is kept until Save,
// and Cancel puts it back. { ctx (the song's), part (the draft), dirty, bar
// (shown), sel ({ step, string } on the grid), entry (frets being typed), keys }
let ed = null;

const draftCtx = () => ({ ...ed.ctx, part: ed.part });

// Change the draft (a copy: yours once saved). A bar you've edited is no
// longer the detector's guess, so its confidence goes.
function change(fn, bar = null) {
  const p = editedPart(ed.part || { bars: [] });
  if (!p.bars) p.bars = [];
  while (p.bars.length < ed.ctx.bars.length) p.bars.push({});
  fn(p);
  if (bar !== null && p.bars[bar]) { delete p.bars[bar].confidence; delete p.bars[bar].match; }
  // Trailing bars that just repeat aren't needed.
  while (p.bars.length > 1 && Object.keys(p.bars[p.bars.length - 1]).length === 0) p.bars.pop();
  ed.part = p;
  ed.dirty = true;
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

// A note on a string. With a fret it stays on that string (p5@10); without,
// the thumb follows the shape's bass (pB, pA).
function noteFor(ctx, i, string, f, extra = {}) {
  if (extra.fret !== undefined) return { f, s: f !== "p" && HOME[f] === string ? null : string, ...extra };
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

const TECHS = [["h", "Hammer"], ["o", "Pull-off"], ["/", "Slide ↑"], ["\\", "Slide ↓"]];
const MAX_FRET = 24;

// Open the editor on bar i, with a fresh draft.
export function openBarEditor(ctx, i, view = null) {
  ed = { ctx, part: structuredClone(ctx.part || { bars: [] }), dirty: false, bar: null, sel: null, entry: null, keys: null };
  showBar(i, view);
}

// The chart's own version of bar i (the tab's, the detector's), when there is one.
function chartBar(ctx, i) {
  const cp = ed.ctx.chartPart;
  if (!cp) return null;
  const ce = expandPart(cp, ctx.bars.length, ctx.beats)[i];
  return ce && ce.steps ? ce : null;
}

function showBar(i, view = null) {
  const ctx = draftCtx();
  const pop = document.querySelector(".popover");
  const keep = pop && ed.bar === i ? { top: pop.scrollTop, left: (pop.querySelector(".step-grid-wrap") || {}).scrollLeft || 0 } : null;
  if (ed.bar !== i) { ed.sel = null; ed.entry = null; }
  ed.bar = i;
  ed.keys = null;

  const e = expanded(ctx)[i];
  const b = ctx.bars[i];
  const given = barOf(ctx, i);
  const mode = view || (e.kind === "steps" ? "steps" : e.kind === "repeat" && !given.pattern ? "repeat" : "pattern");
  const ownIds = Object.keys((ctx.part && ctx.part.patterns) || {});
  const ch = barChord(ctx, i);
  const grid = toGrid(ctx, i, e.steps || parseSteps(new Array(2 * ctx.beats).fill("-").join(" ")));
  const steps = grid.length;
  const sel = ed.sel && ed.sel.step < steps ? ed.sel : null;
  const selNote = sel ? grid[sel.step][sel.string] : null;
  const ce = chartBar(ctx, i);
  const differs = ce && (stepsText(ce.steps) !== (e.steps ? stepsText(e.steps) : "") || JSON.stringify(ce.shape) !== JSON.stringify(e.shape));
  const chartWord = ed.ctx.chartPart && ed.ctx.chartPart.source === "web" ? "tab's" : ed.ctx.chartPart && ed.ctx.chartPart.source === "detected" ? "detected" : "chart's";

  const patternView = `<div class='set-label'>Pattern</div>
    <p class='note' style='margin:0 0 6px'>${e.kind === "pattern" ? `Now: <b>${esc(label(ctx.part, e))}</b>${e.pattern && !partPattern(ctx.part, e.pattern).own ? ` (${esc(patternName(e.pattern))})` : ""}, repeated to fill the bar.` : "Choose one; it repeats to fill the bar."}</p>
    ${ownIds.length ? `<div class='h2' style='margin:6px 0'>This song's own</div><div class='pattern-grid'>${ownIds.map((id) =>
      `<button class='pattern-btn ${given.pattern === id ? "on" : ""}' data-own-pat='${esc(id)}' aria-pressed='${given.pattern === id}'><span class='pn'>Pattern ${esc(id)}</span><span class='meta'>${esc(defaultName(partPattern(ctx.part, id).steps))}</span></button>`).join("")}</div>` : ""}
    <details class='lib-list'><summary>Library patterns</summary>${patternListHtml(given.pattern && PATTERN_BY_ID.has(given.pattern) ? given.pattern : null, [])}</details>`;

  const gridView = `<div class='seg small-seg' role='group' aria-label='Steps in the bar' style='margin-bottom:8px'>${[2, 3, 4].map((per) => {
      const n = per * ctx.beats;
      return `<button data-steps='${n}' class='${steps === n ? "on" : ""}' aria-pressed='${steps === n}'>${n} ${per === 2 ? "eighths" : per === 3 ? "triplets" : "16ths"}</button>`;
    }).join("")}</div>
    <div class='step-grid-wrap'><div class='step-grid' style='--steps:${steps}' role='grid' aria-label='Strings by steps: tap a spot, then type its fret'>
      ${[1, 2, 3, 4, 5, 6].map((s) => `<span class='sg-s' aria-hidden='true'>${s}</span>` + grid.map((row, k) => {
        const n = row[s];
        const on = sel && sel.step === k && sel.string === s;
        return `<button class='sg-c${n ? " f-" + n.f : ""}${on ? " sel" : ""}${k % (steps / ctx.beats) === 0 ? " beat" : ""}' data-st='${k}' data-s='${s}'
          aria-label='String ${s}, step ${k + 1}${n ? ": " + esc(noteText(n)) : ", empty"}' aria-pressed='${!!on}'>${cellHtml(n, ch.pima, s)}</button>`;
      }).join("")).join("")}
    </div></div>
    ${keypadHtml(sel, selNote, ch.pima)}
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
    ${differs ? `<button class='btn outline small' data-restore>Back to the ${chartWord} version of this bar</button>` : ""}
    ${shapeView}
    <div class='set-row'><div class='meta'>Same for the next bars</div>
      <div class='row-btns'>${[1, 3, 7].filter((n) => i + n < ctx.bars.length).map((n) => `<button class='btn outline small' data-repeat='${n}'>+${n}</button>`).join("")}
        ${i + 1 < ctx.bars.length ? `<button class='btn outline small' data-repeat='all'>All</button>` : ""}</div></div>
    <div class='row-btns'><button class='btn outline small' data-copy>Copy bar</button><button class='btn outline small' data-paste ${clipboard ? "" : "disabled"}>Paste</button>
      ${i + 1 < ctx.bars.length ? "<button class='btn outline small' data-next>Next bar ›</button>" : ""}</div>
    ${ed.dirty ? `<p class='note' style='margin:0'>Not saved yet.</p>
      <div class='row-btns ed-end'><button class='btn outline' data-cancel>Cancel</button><button class='btn primary' data-save>Save</button></div>`
      : "<button class='btn outline' data-close>Done</button>"}`;
  const p = showPopover(html, `Bar ${i + 1}`, null, () => (ed && ed.dirty ? "Save or cancel your changes first." : null));
  if (keep) {
    p.querySelector(".popover").scrollTop = keep.top;
    const w = p.querySelector(".step-grid-wrap");
    if (w) w.scrollLeft = keep.left;
  }
  const again = (v = mode) => showBar(i, v);
  const save = (fn, v) => { change(fn, i); again(v); };

  p.querySelector("[data-bar-hear]").addEventListener("click", () => ed.ctx.playBar(i, draftCtx()));
  p.querySelectorAll("[data-view]").forEach((x) => x.addEventListener("click", () => {
    const v = x.dataset.view;
    if (v === "repeat") { save((pt) => { const sh = pt.bars[i].shape; pt.bars[i] = sh !== undefined ? { shape: sh } : {}; }, v); return; }
    again(v);
  }));
  p.querySelectorAll("[data-own-pat]").forEach((x) => x.addEventListener("click", () => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: x.dataset.ownPat }; }, "pattern")));
  p.querySelectorAll(".lib-list [data-pattern]").forEach((x) => x.addEventListener("click", () => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: x.dataset.pattern }; }, "pattern")));

  // The step grid: tap a spot to select it, then type its fret on the pad.
  const setGrid = (g) => save((pt) => { pt.bars[i] = { ...keepShape(pt.bars[i]), steps: fromGrid(g) }; }, "steps");
  p.querySelectorAll("[data-steps]").forEach((x) => x.addEventListener("click", () => {
    const n = +x.dataset.steps;
    if (n === steps) return;
    // Keep the notes that land on the new grid's steps.
    const g = Array.from({ length: n }, (_, k) => { const src = (k * steps) / n; return Number.isInteger(src) ? grid[src].slice() : new Array(7).fill(null); });
    ed.sel = null;
    setGrid(g);
  }));
  const select = (k, s) => { ed.sel = { step: k, string: s, to: false }; ed.entry = null; again("steps"); };
  p.querySelectorAll(".sg-c").forEach((c) => c.addEventListener("click", () => select(+c.dataset.st, +c.dataset.s)));
  if (mode === "steps" && sel) {
    const cell = p.querySelector(`.sg-c[data-st='${sel.step}'][data-s='${sel.string}']`);
    if (cell && !keep) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const put = (n) => { grid[sel.step][sel.string] = n; setGrid(grid); };
  const shapeFret = (s) => chordFret(ch.pima, s) ?? 0;
  // Frets: a digit, or two typed quickly (1 then 2 is 12).
  const digit = (d) => {
    if (!sel) return;
    const key = `${sel.step}.${sel.string}.${sel.to}`, now = Date.now();
    const en = ed.entry;
    const two = en && en.key === key && now - en.at < 1500 ? +(en.text + d) : NaN;
    const v = two <= MAX_FRET ? two : d;
    ed.entry = { key, text: String(v), at: now };
    if (sel.to && selNote && selNote.tech) put({ ...selNote, tech: { ...selNote.tech, to: v } });
    else if (selNote) { const n = { ...noteFor(ctx, i, sel.string, selNote.f, { ...pick(selNote), fret: v }) }; delete n.mute; put(n); }
    else put(noteFor(ctx, i, sel.string, defaultFinger(sel.string), { fret: v }));
  };
  const remove = () => { if (sel && selNote) { ed.entry = null; sel.to = false; put(null); } };
  const mute = () => {
    if (!sel) return;
    if (!selNote) { put(noteFor(ctx, i, sel.string, defaultFinger(sel.string), { mute: true })); return; }
    const n = { ...selNote };
    if (n.mute) delete n.mute; else n.mute = true;
    put(n);
  };
  // A technique: tap it, then type the fret it goes to. Tap it again to take it off.
  const tech = (t) => {
    if (!sel || !selNote) return;
    const n = { ...selNote };
    ed.entry = null;
    if (n.tech && n.tech.type === t) { delete n.tech; sel.to = false; put(n); return; }
    const from = n.fret ?? shapeFret(sel.string);
    n.tech = { type: t, to: n.tech ? n.tech.to : Math.max(0, from + (t === "h" || t === "/" ? 2 : -2)) };
    if (n.fret === undefined) n.fret = from;
    sel.to = true;
    put(noteFor(ctx, i, sel.string, n.f, pick(n)));
  };
  const finger = (f) => { if (sel && selNote && selNote.f !== f) put(noteFor(ctx, i, sel.string, f, pick(selNote))); };
  p.querySelectorAll("[data-key]").forEach((x) => x.addEventListener("click", () => {
    const k = x.dataset.key;
    if (k === "del") remove(); else if (k === "mute") mute(); else digit(+k);
  }));
  p.querySelectorAll("[data-tech]").forEach((x) => x.addEventListener("click", () => tech(x.dataset.tech)));
  p.querySelectorAll("[data-finger]").forEach((x) => x.addEventListener("click", () => finger(x.dataset.finger)));
  const tf = p.querySelector("[data-to-fret]");
  if (tf) tf.addEventListener("click", () => { sel.to = !sel.to; ed.entry = null; again("steps"); });
  // On a computer: digits, Backspace, x for a mute, h p / \ for techniques, arrows to move.
  if (mode === "steps") ed.keys = (ev) => {
    const k = ev.key;
    if (/^\d$/.test(k)) digit(+k);
    else if (k === "Backspace" || k === "Delete") remove();
    else if (k === "x" || k === "X") mute();
    else if (k === "h") tech("h");
    else if (k === "p" || k === "o") tech("o");
    else if (k === "/") tech("/");
    else if (k === "\\") tech("\\");
    else if (k.startsWith("Arrow")) {
      const at = sel || { step: 0, string: 1 };
      const st = Math.max(0, Math.min(steps - 1, at.step + (k === "ArrowRight") - (k === "ArrowLeft")));
      const s = Math.max(1, Math.min(6, at.string + (k === "ArrowDown") - (k === "ArrowUp")));
      ed.sel = { step: st, string: s, to: false };
      ed.entry = null;
      showBar(i, "steps");
      const cell = document.querySelector(`.popover .sg-c[data-st='${st}'][data-s='${s}']`);
      if (cell) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else return;
    ev.preventDefault();
  };
  const gb = p.querySelectorAll("[data-grid]");
  gb.forEach((x) => x.addEventListener("click", () => {
    if (x.dataset.grid === "clear") { ed.sel = null; setGrid(grid.map(() => new Array(7).fill(null))); }
    else if (x.dataset.grid === "save-own") {
      const id = "abcdef".split("").find((c) => !ownIds.includes(c));
      const text = fromGrid(grid);
      save((pt) => {
        pt.patterns = { ...(pt.patterns || {}), [id]: { steps: text, npb: Math.max(1, Math.round(grid.length / ctx.beats)) } };
        pt.bars[i] = { ...keepShape(pt.bars[i]), pattern: id };
      }, "pattern");
      toast(`Pattern ${id} of the song's: choose it for other bars.`);
    }
  }));

  // Back to the chart's version of this bar: its pattern or steps, else the notes it plays.
  const rs = p.querySelector("[data-restore]");
  if (rs) rs.addEventListener("click", () => {
    const cp = ed.ctx.chartPart, g = ce.given && Object.keys(ce.given).length ? { ...ce.given } : null;
    ed.sel = null;
    save((pt) => {
      let bar = null;
      if (g && g.steps) bar = g;
      else if (g && g.pattern) {
        const own = cp.patterns && cp.patterns[g.pattern];
        const mine = pt.patterns && pt.patterns[g.pattern];
        if (!own && !mine) bar = g;
        else if (own && (!mine || JSON.stringify(own) === JSON.stringify(mine))) { pt.patterns = { ...(pt.patterns || {}), [g.pattern]: own }; bar = g; }
      }
      if (!bar) {
        bar = { steps: stepsText(ce.steps) };
        if (ce.shape) { const specs = ce.shape.map((f) => (f ? fretsSpec(f) : null)); bar.shape = specs.length === 1 ? specs[0] : specs; }
      }
      pt.bars[i] = bar;
    }, ce.kind === "pattern" ? "pattern" : "steps");
  });

  // The shape for this bar.
  const inp = p.querySelector(".bar-spec");
  const useShape = (spec) => {
    const f = specFrets(spec);
    if (!f) { toast("A shape is six strings, low first, like x00232."); return; }
    save((pt) => { pt.bars[i] = { ...pt.bars[i], shape: fretsSpec(f) }; });
    ed.ctx.hear(f);
  };
  p.querySelector("[data-shape=use]").addEventListener("click", () => useShape(inp.value));
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") useShape(inp.value); });
  const reset = p.querySelector("[data-shape=reset]");
  if (reset) reset.addEventListener("click", () => save((pt) => { const x = { ...pt.bars[i] }; delete x.shape; pt.bars[i] = x; }));
  const fp = p.querySelector(".fret-picker");
  if (fp) wireFretPicker(fp, (f) => { inp.value = fretsSpec(f); ed.ctx.hear(f); });

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
  if (nx) nx.addEventListener("click", () => showBar(i + 1));

  // Save keeps the changes (on this device); Cancel puts it back.
  const sv = p.querySelector("[data-save]");
  if (sv) sv.addEventListener("click", async () => {
    const { ctx: c, part } = ed;
    ed = null;
    closePopover();
    await c.save(part);
  });
  const cn = p.querySelector("[data-cancel]");
  if (cn) cn.addEventListener("click", () => { ed = null; closePopover(); });
}

const keepShape = (b) => (b && b.shape !== undefined ? { shape: b.shape } : {});
const pick = (n) => { const o = {}; for (const k of ["fret", "tech", "mute"]) if (n[k] !== undefined) o[k] = n[k]; return o; };

// A note on the grid: its fret (the shape's if it has none), technique, and finger.
function cellHtml(n, ch, s) {
  if (!n) return "";
  const fret = n.mute ? "×" : n.fret ?? chordFret(ch, s) ?? "?";
  return `${esc(String(fret))}${n.tech ? esc(n.tech.type + n.tech.to) : ""}<span class='sg-f'>${n.f}</span>`;
}

// The pad under the grid: frets, a mute, techniques, and the finger.
function keypadHtml(sel, n, ch) {
  const off = sel ? "" : " disabled";
  const offN = n ? "" : " disabled";
  const t = n && n.tech ? n.tech.type : null;
  const fret = n ? (n.mute ? "muted" : `fret ${n.fret ?? chordFret(ch, sel.string) ?? "?"}${n.fret === undefined ? " (the shape's)" : ""}`) : "";
  const status = !sel ? "Tap a spot on the grid, then type its fret."
    : !n ? `String ${sel.string}, step ${sel.step + 1}: type a fret to put a note here.`
    : sel.to && n.tech ? `String ${sel.string}, step ${sel.step + 1}: ${esc(TECHS.find((x) => x[0] === t)[1].toLowerCase())} from ${n.fret} to <b>${n.tech.to}</b>. Type the fret it goes to.`
    : `String ${sel.string}, step ${sel.step + 1}: <b>${esc(fret)}</b>${n.tech ? `, ${esc(n.tech.type + n.tech.to)}` : ""}.`;
  const key = (k, l, aria) => `<button class='btn outline' data-key='${k}'${off}${aria ? ` aria-label='${aria}'` : ""}>${l}</button>`;
  return `<div class='keypad' role='group' aria-label='The selected note'>
    <p class='kp-status' aria-live='polite'>${status}</p>
    <div class='kp-keys'>${[1, 2, 3, 4, 5].map((d) => key(d, d)).join("")}${key("del", "⌫", "Remove the note")}
      ${[6, 7, 8, 9, 0].map((d) => key(d, d)).join("")}${key("mute", "×", "Muted")}</div>
    <div class='kp-row'><div class='seg small-seg' role='group' aria-label='Technique'>${TECHS.map(([v, l]) =>
      `<button data-tech='${v}' class='${t === v ? "on" : ""}' aria-pressed='${t === v}'${offN}>${l}</button>`).join("")}</div></div>
    <div class='kp-row'><span class='meta'>Finger</span><div class='seg small-seg' role='group' aria-label='Finger'>${FINGERS.map((f) =>
      `<button data-finger='${f}' class='${n && n.f === f ? "on" : ""}' aria-pressed='${!!(n && n.f === f)}'${offN}>${f}</button>`).join("")}</div>
      ${t ? `<button class='btn outline small${sel.to ? " on" : ""}' data-to-fret aria-pressed='${!!sel.to}' aria-label='Type the fret it goes to'>to ${n.tech.to}</button>` : ""}</div>
  </div>`;
}

if (typeof document !== "undefined") document.addEventListener("keydown", (ev) => {
  if (!ed || !ed.keys || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (!document.querySelector(".popover .step-grid")) return;
  if (ev.target.closest && ev.target.closest("input, textarea, select")) return;
  ed.keys(ev);
});

// What a bar's notes are, for screen readers and tests: "pB i3@2h4 ...".
export function barText(ctx, i) {
  const e = expanded(ctx)[i];
  return e && e.steps ? stepsText(e.steps) : "";
}

