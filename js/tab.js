// A guitar part as tablature or staff notation, the whole section at once:
// for parts that don't follow one picking pattern (a classical piece, a
// detected part that's mostly written out), reading it is more use than the
// pattern stage. Each bar is a button (tap to edit it); while it plays, the
// bar and step light up.

import { noteSound } from "./patterns.js";
import { notationSvg } from "./notation.js";
import { HOME } from "./picking.js";
import { expanded, barChord } from "./partedit.js";
import { prettyChord } from "./chords.js";
import { stringNames } from "./tuning.js";
import { esc } from "./ui.js";

const COLW = 18;         // px per step (less in a bar of more than 16 steps)
const GAP = 13;          // px between strings
const TOP = 26;          // room for the bar number and chord names
const PAD = 8;
const LOW = 0.6;         // a detected bar below this confidence shows "?" (as in partedit.js)
const TECH = { h: "h", o: "p", "/": "/", "\\": "\\" };

export const PART_VIEWS = [["tab", "Tab"], ["notation", "Notation"], ["picking", "Picking"]];

// Which view suits the part: tab when most of its bars are written out (or
// the part's own patterns, as a detected part has), the pattern stage when
// library patterns carry it (or nothing's written yet).
export function defaultPartView(ctx) {
  const given = expanded(ctx).filter((e) => e.given && Object.keys(e.given).length);
  if (!given.length) return "picking";
  const own = (ctx.part && ctx.part.patterns) || {};
  const notes = (e) => !!e.steps && e.steps.some((st) => st.length);
  const written = given.filter((e) => notes(e) && (e.kind === "steps" || (e.pattern && own[e.pattern]))).length;
  return written / given.length > 0.5 ? "tab" : "picking";
}

// What a note looks like on the tab: 3, 3h5, 5/7, x.
function fretText(x) {
  if (x.mute) return "x";
  return String(x.fret) + (x.to ? TECH[x.to.type] + x.to.fret : "");
}

// Which of the bar's chords a step falls under.
const chordAt = (bar, k, n) => Math.min(bar.chords.length - 1, Math.floor(k * bar.chords.length / n));

function tabBarSvg(ctx, i, e) {
  const n = e.steps.length;
  const COL = n > 16 ? Math.max(12, Math.round(288 / n)) : COLW;
  const bar = ctx.bars[i];
  const names = i === 0 ? stringNames(ctx.tuning) : null;
  const left = names ? 14 : 0;
  const w = left + PAD * 2 + n * COL;
  const h = TOP + GAP * 5 + PAD;
  const y = (s) => TOP + (s - 1) * GAP;
  const x0 = left + PAD;
  let svg = `<svg class='tab-svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' aria-hidden='true'>`;
  for (let k = 0; k < n; k++) svg += `<rect class='tcol' data-i='${k}' x='${x0 + k * COL}' y='${TOP - 9}' width='${COL}' height='${GAP * 5 + 18}' rx='4'/>`;
  for (let s = 1; s <= 6; s++) svg += `<line class='tline' x1='${left}' x2='${w}' y1='${y(s)}' y2='${y(s)}'/>`;
  svg += `<line class='tbar' x1='${left + 0.5}' x2='${left + 0.5}' y1='${y(1)}' y2='${y(6)}'/><line class='tbar' x1='${w - 0.5}' x2='${w - 0.5}' y1='${y(1)}' y2='${y(6)}'/>`;
  // The open strings' names by the first bar, high string on top.
  if (names) for (let s = 1; s <= 6; s++) svg += `<text class='tstr' x='6' y='${y(s) + 4}'>${esc(names[6 - s].replace("#", "♯"))}</text>`;
  svg += `<text class='tnum' x='${left + 2}' y='10'>${i + 1}</text>`;
  bar.chords.forEach((c, k) => {
    svg += `<text class='tchord' x='${x0 + Math.round(k * n / bar.chords.length) * COL + (k ? 0 : 12)}' y='11'>${esc(prettyChord(c.name))}</text>`;
  });
  if (e.confidence !== null && e.confidence < LOW) svg += `<text class='tq' x='${w - 10}' y='11'>?</text>`;
  e.steps.forEach((st, k) => {
    const ch = barChord(ctx, i, chordAt(bar, k, n), e);
    if (!ch || !ch.pima) return;
    const cx = x0 + k * COL + COL / 2;
    for (const nt of st) {
      const x = noteSound(nt, ch.pima, HOME, 0, ctx.tuning.open);
      const t = fretText(x);
      const tw = Math.max(10, t.length * 7);
      svg += `<rect class='tknock' x='${cx - tw / 2}' y='${y(x.string) - 6}' width='${tw}' height='12'/>`;
      svg += `<text class='tfret f-${nt.f}' x='${cx}' y='${y(x.string) + 4}'>${esc(t)}</text>`;
    }
  });
  return svg + "</svg>";
}

function notationBarSvg(ctx, i, e) {
  const ch = barChord(ctx, i, 0, e);
  if (!ch || !ch.pima) return "";
  const npb = Math.max(1, Math.round(e.steps.length / ctx.beats));
  return notationSvg(e.steps, ch.pima, HOME, npb, ctx.tuning.open);
}

// The section as tab or notation: a legend, then one button per bar.
export function partSheetHtml(ctx, view, sel = -1) {
  const ex = expanded(ctx);
  const names = stringNames(ctx.tuning).map((x) => x.replace("#", "♯"));
  const capo = ctx.capo ? `, counted from the capo at ${ctx.capo}` : "";
  const legend = view === "tab"
    ? `Top line is the high string (${esc(names.slice().reverse().join(" "))}, ${esc(ctx.tuning.name)}); numbers are frets${capo}. h hammer-on, p pull-off, / \\ slide, x muted. The colours are the picking fingers.`
    : "Written an octave above how it sounds, as guitar music is. The letters are the picking fingers.";
  const bars = ex.map((e, i) => {
    const chords = ctx.bars[i].chords.map((c) => c.name).join(" ");
    const cls = `pbar tab-bar pv-${view}${i === sel ? " sel" : ""}${e.confidence !== null && e.confidence < LOW ? " unsure" : ""}`;
    if (!e.steps) return `<button class='${cls} empty' data-pbar='${i}' aria-label='Bar ${i + 1}, ${esc(chords)}: nothing written yet'><span class='meta'>${i + 1} · ${esc(prettyChord(ctx.bars[i].chords[0].name))}</span></button>`;
    const inner = view === "tab" ? tabBarSvg(ctx, i, e)
      : `<span class='tchord-label'>${i + 1} · ${esc(ctx.bars[i].chords.map((c) => prettyChord(c.name)).join(" "))}</span>${notationBarSvg(ctx, i, e)}`;
    return `<button class='${cls}' data-pbar='${i}' aria-label='Bar ${i + 1}, ${esc(chords)}'>${inner}</button>`;
  }).join("");
  return `<p class='note tab-legend'>${legend}</p><div class='tab-sheet pv-${view}'>${bars}</div>`;
}

// Light step k of the playing bar (-1: none).
export function litTabStep(root, k) {
  root.querySelectorAll(".tcol.cur").forEach((x) => x.classList.remove("cur"));
  if (k < 0) return;
  const el = root.querySelector(`.tab-bar.on .tcol[data-i='${k}']`);
  if (el) el.classList.add("cur");
}
