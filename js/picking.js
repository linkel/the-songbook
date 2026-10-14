// Picking mode (#/song/<id>/picking, mockup 4): Pimapeggio's stage over a
// section's chords. Big finger letters, a string diagram and staff notation
// for the pattern, the section's bars, and Play (the app guitar picks it,
// lit as it goes). Each pattern says where it came from: sourced (web), your
// description (mine), a suggestion, or your own pick here. "Open in
// Pimapeggio" hands the section to the full trainer with the tempo ladder.
// The stage drawing follows Pimapeggio's buildFingers/buildDiagram (app.js).

import { PATTERNS, PATTERN_BY_ID, FAMILIES, noteString, chordMidi } from "./patterns.js";
import { notationSvg, FINGER_COLORS } from "./notation.js";
import { splitBars, voicingsFor, pimaChord, prettyChord } from "./chords.js";
import { esc, pickingLabel, patternName } from "./ui.js";

export const HOME = { i: 3, m: 2, a: 1 };
const FINGER_ORDER = ["p", "i", "m", "a"];
const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];

// The pattern for a section: your pick, else the section's, else the chart's.
// -> { pattern, picking (its provenance) | null, mine: bool, options: [ids] }
export function patternFor(chart, section, prefs) {
  const picking = (section && section.picking) || (chart && chart.picking) || null;
  const options = picking ? [...(picking.patterns || []), ...(picking.also || [])].filter((id) => PATTERN_BY_ID.has(id)) : [];
  const own = prefs && prefs.pickPattern && PATTERN_BY_ID.get(prefs.pickPattern);
  if (own) return { pattern: own, picking, mine: true, options };
  if (options.length) return { pattern: PATTERN_BY_ID.get(options[0]), picking, mine: false, options };
  return { pattern: null, picking: null, mine: false, options };
}

// Where a pattern comes from, as a badge.
export function patternBadge(pf) {
  if (pf.mine) return "<span class='badge pick'>your pick</span>";
  const lab = pickingLabel(pf.picking);
  return lab ? `<span class='badge ${lab.cls}'>${esc(lab.text)}</span>` : "";
}

// A section's bars as chords to play: [{ sec, bar, chords: [{ name, frets, pima }] }].
// disp: sounding name -> what you play (capo, transpose, simple); vm: voicings.
export function sectionBars(chart, si, disp, vm) {
  const s = chart && chart.sections && chart.sections[si];
  if (!s || !s.chords) return [];
  return splitBars(s.chords).map((names, bar) => ({
    sec: si, bar,
    chords: names.map((n) => {
      const d = disp(n);
      const v = voicingsFor(d, vm)[0];
      return { name: d, frets: v ? v.frets : null, spec: v ? v.spec : null, pima: v ? pimaChord(d, { [d]: v.spec }) : null };
    }),
  }));
}

// Finger letters, the highest string on top within a step.
export function fingersHtml(p) {
  const L = p.steps.length;
  const cols = L <= 6 ? L : Math.ceil(L / 2);
  const cells = p.steps.map((st, i) => {
    const notes = [...st].sort((a, b) => FINGER_ORDER.indexOf(b.f) - FINGER_ORDER.indexOf(a.f));
    const inner = notes.map((n) => `<span class='f-${n.f}${notes.length > 1 ? " multi" : ""}'>${n.f}</span>`).join("");
    return `<div class='fcell' data-i='${i}'>${inner}</div>`;
  }).join("");
  return `<div class='fingers' style='--cols:${cols};--rows:${L <= 6 ? 1 : 2}' aria-label='Fingers: ${esc(p.letters)}'>${cells}</div>`;
}

// A string diagram (string 1 on top, as in tab), one column per step, over
// the chord being played (Pimapeggio's buildDiagram).
export function diagramSvg(p, chord) {
  const L = p.steps.length;
  const W = 340, H = 150, left = 40, right = 6, top = 12, bottom = 12;
  const gap = (H - top - bottom) / 5;
  const colW = (W - left - right) / L;
  const y = (s) => top + (s - 1) * gap;
  const r = Math.min(colW * 0.44, gap * 0.45, 15);
  let svg = `<svg class='pick-diagram' viewBox='0 0 ${W} ${H}' role='img' aria-label='String diagram over ${esc(chord.id)}'>`;
  for (let i = 0; i < L; i++) svg += `<rect class='dg-col' data-i='${i}' x='${(left + i * colW + 1).toFixed(1)}' y='0' width='${(colW - 2).toFixed(1)}' height='${H}' rx='6'/>`;
  for (let s = 1; s <= 6; s++) {
    const ext = chord.ext.includes(s);
    svg += `<line class='dg-string${ext ? " ext" : ""}' x1='${left - 4}' x2='${W - right}' y1='${y(s)}' y2='${y(s)}' stroke-width='${(0.8 + s * 0.22).toFixed(2)}'/>`;
    svg += `<text class='dg-label' x='2' y='${y(s) + 4}'>${s}</text>`;
    svg += `<text class='dg-label note' x='13' y='${y(s) + 4}'>${NOTE_NAMES[chordMidi(chord, s) % 12]}</text>`;
  }
  p.steps.forEach((st, i) => {
    const cx = left + (i + 0.5) * colW;
    for (const n of st) {
      const s = noteString(n, chord, HOME);
      svg += `<circle cx='${cx.toFixed(1)}' cy='${y(s)}' r='${r.toFixed(1)}' fill='${FINGER_COLORS[n.f]}'/>`;
      if (r >= 6) svg += `<text class='dg-dot-text' x='${cx.toFixed(1)}' y='${(y(s) + 0.5).toFixed(1)}' font-size='${(r * 1.35).toFixed(1)}'>${n.f}</text>`;
    }
  });
  return svg + "</svg>";
}

export function notationHtml(p, chord) {
  return `<div class='pick-notation' aria-label='The pattern in notation'>${notationSvg(p.steps, chord, HOME, p.npb)}</div>`;
}

// Every pattern by family, for choosing one.
export function patternListHtml(currentId, suggested) {
  const sug = suggested.length ? `<div class='h2'>For this song</div><div class='pattern-grid'>${suggested.map((id) => btn(PATTERN_BY_ID.get(id), currentId)).join("")}</div>` : "";
  return sug + FAMILIES.map((f) => {
    const ps = PATTERNS.filter((p) => p.family === f.id);
    return ps.length ? `<div class='h2'>${esc(f.name)}</div><div class='pattern-grid'>${ps.map((p) => btn(p, currentId)).join("")}</div>` : "";
  }).join("");
}

function btn(p, currentId) {
  return `<button class='pattern-btn ${p.id === currentId ? "on" : ""}' data-pattern='${esc(p.id)}' aria-pressed='${p.id === currentId}'>
    <span class='pn'>${esc(p.name)}</span>${p.name !== p.letters ? `<span class='meta'>${esc(p.letters)}</span>` : ""}</button>`;
}

// Pimapeggio's address: the deployed copy next to this app, or the local one.
export function pimapeggioBase(loc = location) {
  return /^(localhost|127\.0\.0\.1)$/.test(loc.hostname) ? "http://localhost:8318/" : new URL("../pimapeggio/", loc.href).href;
}

// A link that opens the trainer on this pattern over the section's chords.
export function pimapeggioLink({ pattern, bars, capo, bpm, name }, base = pimapeggioBase()) {
  const voicings = new Map();
  for (const b of bars) for (const c of b.chords) if (c.spec) voicings.set(c.name, c.spec);
  const q = new URLSearchParams({
    pattern: pattern.id,
    chords: bars.map((b) => b.chords.map((c) => c.name).join(" ")).join(" | "),
    voicings: [...voicings].map(([n, s]) => `${n}:${s}`).join(","),
    capo: String(capo || 0), bpm: String(Math.round(bpm)), name,
  });
  return base + "?" + q;
}

let pimaUp = null;
// Is Pimapeggio online where the link points? (Checked once.)
export function pimapeggioAvailable(base = pimapeggioBase()) {
  // On another origin (a local copy on its own port) only "it answered" can be seen.
  if (!pimaUp) pimaUp = fetch(base + "manifest.json", { cache: "no-store", mode: "no-cors" }).then((r) => r.type === "opaque" || r.ok).catch(() => false);
  return pimaUp;
}

export { patternName, prettyChord };
