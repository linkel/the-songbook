// A guitar part as tablature or staff notation, the whole section at once:
// for parts that don't follow one picking pattern (a classical piece, a
// detected part that's mostly written out), reading it is more use than the
// pattern stage. Tap a bar to play from there (the line shows where); its
// pencil edits it. While it plays, the bar and step light up.

import { noteSound } from "./patterns.js";
import { notationSvg, notationStepX, NOTATION_COLW } from "./notation.js";
import { HOME } from "./picking.js";
import { expanded, barChord } from "./partedit.js";
import { prettyChord } from "./chords.js";
import { stringNames } from "./tuning.js";
import { esc, ICONS } from "./ui.js";

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

function tabBarSvg(ctx, i, e, num = i + 1) {
  const n = e.steps.length;
  const COL = n > 16 ? Math.max(12, Math.round(288 / n)) : COLW;
  const bar = ctx.bars[i];
  const names = i === 0 ? stringNames(ctx.tuning) : null;
  const left = names ? 14 : 0;
  const w = left + PAD * 2 + n * COL;
  const h = TOP + GAP * 5 + PAD;
  const y = (s) => TOP + (s - 1) * GAP;
  const x0 = left + PAD;
  let svg = `<svg class='tab-svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' data-x0='${x0}' data-col='${COL}' aria-hidden='true'>`;
  for (let k = 0; k < n; k++) svg += `<rect class='tcol' data-i='${k}' x='${x0 + k * COL}' y='${TOP - 9}' width='${COL}' height='${GAP * 5 + 18}' rx='4'/>`;
  for (let s = 1; s <= 6; s++) svg += `<line class='tline' x1='${left}' x2='${w}' y1='${y(s)}' y2='${y(s)}'/>`;
  svg += `<line class='tbar' x1='${left + 0.5}' x2='${left + 0.5}' y1='${y(1)}' y2='${y(6)}'/><line class='tbar' x1='${w - 0.5}' x2='${w - 0.5}' y1='${y(1)}' y2='${y(6)}'/>`;
  // The open strings' names by the first bar, high string on top.
  if (names) for (let s = 1; s <= 6; s++) svg += `<text class='tstr' x='6' y='${y(s) + 4}'>${esc(names[6 - s].replace("#", "♯"))}</text>`;
  svg += `<text class='tnum' x='${left + 2}' y='10'>${num}</text>`;
  bar.chords.forEach((c, k) => {
    svg += `<text class='tchord' x='${x0 + Math.round(k * n / bar.chords.length) * COL + (k ? 0 : 12)}' y='11'>${esc(prettyChord(c.name))}</text>`;
  });
  if (e.confidence !== null && e.confidence < LOW) svg += `<text class='tq' x='${w - 34}' y='11'>?</text>`;
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

// The tab's legend: how to read it, in the song's tuning.
export function tabLegend(ctx, view) {
  const names = stringNames(ctx.tuning).map((x) => x.replace("#", "♯"));
  const capo = ctx.capo ? `, counted from the capo at ${ctx.capo}` : "";
  const legend = view === "tab"
    ? `Top line is the high string (${esc(names.slice().reverse().join(" "))}, ${esc(ctx.tuning.name)}); numbers are frets${capo}. h hammer-on, p pull-off, / \\ slide, x muted. The colours are the picking fingers.`
    : "Written an octave above how it sounds, as guitar music is. The letters are the picking fingers.";
  return `<p class='note tab-legend'>${legend}</p>`;
}

// One section's bars as tab or notation, a button each (tap: play from
// there) with a pencil (edit it). start: the bar number before the first (the
// whole song numbers its bars on); form: which play of the song's form this is
// (data-form, for lighting the bar that plays). lyrics: Map(bar index -> the
// words sung from that bar), written under it.
export function partBarsHtml(ctx, view, sel = -1, { start = 0, form = null, sec = null, lyrics = null } = {}) {
  const ex = expanded(ctx);
  const at = (form !== null ? ` data-form='${form}'` : "") + (sec !== null ? ` data-sec='${sec}'` : "");
  return ex.map((e, i) => {
    const chords = ctx.bars[i].chords.map((c) => c.name).join(" ");
    const cls = `pbar tab-bar pv-${view}${i === sel ? " sel" : ""}${e.confidence !== null && e.confidence < LOW ? " unsure" : ""}`;
    const num = start + i + 1;
    const edit = barEditHtml(i, at, `Edit bar ${num}`);
    if (!e.steps) return `<div class='tab-cell'><button class='${cls} empty' data-pbar='${i}'${at} aria-label='Bar ${num}, ${esc(chords)}: nothing written yet'><span class='meta'>${num} · ${esc(prettyChord(ctx.bars[i].chords[0].name))}</span></button>${edit}</div>`;
    const words = lyrics && lyrics.get(i);
    const inner = (view === "tab" ? tabBarSvg(ctx, i, e, num)
      : `<span class='tchord-label'>${num} · ${esc(ctx.bars[i].chords.map((c) => prettyChord(c.name)).join(" "))}</span>${notationBarSvg(ctx, i, e)}`)
      + (lyrics ? `<span class='tab-lyric'>${words ? esc(words) : "&nbsp;"}</span>` : "");
    const npb = Math.max(1, Math.round(e.steps.length / ctx.beats));
    return `<div class='tab-cell'><button class='${cls}${words ? " sung" : ""}' data-pbar='${i}'${at} data-n='${e.steps.length}' data-npb='${npb}' aria-label='Bar ${num}, ${esc(chords)}${words ? ": " + esc(words) : ""}'>${inner}</button>${edit}</div>`;
  }).join("");
}

// A bar's pencil, in its top corner.
export function barEditHtml(i, at, label) {
  return `<button class='bar-edit' data-edit='${i}'${at} aria-label='${esc(label)}'><span>${ICONS.pencil}</span></button>`;
}

// The section as tab or notation: a legend, then one button per bar.
export function partSheetHtml(ctx, view, sel = -1) {
  return `${tabLegend(ctx, view)}<div class='tab-sheet pv-${view}'>${partBarsHtml(ctx, view, sel)}</div>`;
}

// Light step k of the playing bar (-1: none).
export function litTabStep(root, k) {
  root.querySelectorAll(".tcol.cur").forEach((x) => x.classList.remove("cur"));
  if (k < 0) return;
  const el = root.querySelector(`.tab-bar.on .tcol[data-i='${k}']`);
  if (el) el.classList.add("cur");
}

/* ---- The playhead: where the music is, as a line across the bar ---- */

// The bar's staff or tab (null for an empty bar), and how many steps it has.
function barGeom(bar) {
  const svg = bar.querySelector("svg.tab-svg, svg.notation");
  return { svg, n: Math.max(1, +bar.dataset.n || 1), tab: !!svg && svg.classList.contains("tab-svg") };
}

// The scale a notation staff is drawn at (its CSS width over its viewBox).
const notationScale = (svg) => svg.getBoundingClientRect().width / (svg.viewBox.baseVal.width || 1);

// Where position p (in steps from the bar's start, fractional) is across
// the bar, in px from its svg's left edge: through a step's notes as it
// sounds, moving on towards the next.
function svgX(bar, p) {
  const { svg, n, tab } = barGeom(bar);
  p = Math.max(0, Math.min(n, p));
  if (tab) return +svg.dataset.x0 + (p + 0.5) * +svg.dataset.col;
  const k = Math.min(n - 1, Math.floor(p));
  return (notationStepX(k, +bar.dataset.npb || 1) + (p - k) * NOTATION_COLW) * notationScale(svg);
}

// Which step of a bar a tap at clientX lands on: 0..n-1 (0 for an empty bar).
export function stepAtX(bar, clientX) {
  const { svg, n, tab } = barGeom(bar);
  if (!svg) return 0;
  const x = clientX - svg.getBoundingClientRect().left;
  let k;
  if (tab) k = Math.floor((x - +svg.dataset.x0) / +svg.dataset.col);
  else {
    const sc = notationScale(svg), npb = +bar.dataset.npb || 1;
    k = 0;
    while (k + 1 < n && (notationStepX(k + 1, npb) - NOTATION_COLW / 2) * sc <= x) k++;
  }
  return Math.max(0, Math.min(n - 1, k));
}

// The steps in a bar (1 for an empty one).
export const barSteps = (bar) => barGeom(bar).n;

// Draw the line in bar at position p (steps from its start, fractional);
// no bar: take it away. One line per root.
export function showPlayhead(root, bar, p = 0) {
  let ph = root.querySelector(".playhead");
  if (!bar) { if (ph) ph.remove(); return; }
  if (!ph) {
    ph = document.createElement("i");
    ph.className = "playhead";
    ph.setAttribute("aria-hidden", "true");
  }
  if (ph.parentNode !== bar) bar.appendChild(ph);
  const { svg, n, tab } = barGeom(bar);
  const br = bar.getBoundingClientRect();
  let x, top, h;
  if (svg) {
    const sr = svg.getBoundingClientRect();
    x = sr.left - br.left + bar.scrollLeft - bar.clientLeft + svgX(bar, p);
    // On tab, across the strings; on a staff, its height.
    top = sr.top - br.top - bar.clientTop + (tab ? TOP - 9 : 0);
    h = tab ? GAP * 5 + 18 : sr.height;
  } else {
    x = 8 + (bar.clientWidth - 16) * Math.max(0, Math.min(1, p / n));
    top = 6;
    h = bar.clientHeight - 12;
  }
  ph.style.transform = `translateX(${x.toFixed(1)}px)`;
  ph.style.top = top.toFixed(1) + "px";
  ph.style.height = h.toFixed(1) + "px";
}
