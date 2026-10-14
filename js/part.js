// Guitar parts (plan §7, Guitar part): what the hands actually do, bar by
// bar, for picking that changes through a song and shapes that differ from a
// chord's usual voicing. A part sits on a section, its bars line up with the
// section's chord bars, and each bar has one of:
//   { pattern: "travis" }   a library pattern (or the part's own "a", "b"...), repeated to fill the bar
//   { steps: "pB - pA+i - ..." }   the bar written out, its steps dividing the bar evenly
//   {}                      the bar before it again
// plus an optional `shape` (the fretting hand for that bar; an array for a bar
// with two chords), and, for detected parts, `confidence` and `match`.
// Parts with frets, techniques or mutes taken from a recording stay on the
// device (IndexedDB "parts"); a part of only library patterns and shapes may ship.
// Pure apart from the storage helpers at the end; node tests it.

import { parseSteps, PATTERN_BY_ID, isTranscribed } from "./patterns.js";
import { specFrets } from "./chords.js";

const OWN_NPB = 2;   // a part's own pattern, written as a string, is in eighth notes

// The pattern a bar names: the part's own, else the library's.
// -> { id, steps (parsed), npb, name, own } or null.
export function partPattern(part, id) {
  const own = part && part.patterns && part.patterns[id];
  if (own) {
    const text = typeof own === "string" ? own : own.steps;
    return { id, steps: parseSteps(text), text, npb: (typeof own === "object" && own.npb) || OWN_NPB, name: "Pattern " + id, own: true };
  }
  const lib = PATTERN_BY_ID.get(id);
  return lib ? { id, steps: lib.steps, text: null, npb: lib.npb, name: lib.name, own: false } : null;
}

// A pattern repeated (or cut) to fill a bar of `beats` beats.
export function fillBar(pattern, beats) {
  const n = Math.max(1, Math.round(beats * pattern.npb));
  return Array.from({ length: n }, (_, k) => pattern.steps[k % pattern.steps.length]);
}

// The part's bars, every one resolved: [{ steps (parsed, one per slot), kind:
// "pattern" | "steps" | "repeat", pattern (id or null), shape ([frets] per
// chord, or null), confidence, match, given (the bar as written) }]. Bars past
// the end of the part repeat its last bar. Bars that can't be read come back
// with `error` and no steps.
export function expandPart(part, nBars, beats = 4) {
  const out = [];
  let prev = null;
  const bars = (part && part.bars) || [];
  for (let i = 0; i < nBars; i++) {
    const b = i < bars.length ? bars[i] || {} : {};
    let r;
    try {
      if (b.pattern) {
        const p = partPattern(part, b.pattern);
        if (!p) throw new Error(`No pattern "${b.pattern}".`);
        r = { steps: fillBar(p, beats), kind: "pattern", pattern: b.pattern };
      } else if (b.steps) {
        const steps = parseSteps(b.steps);
        if (!steps.length) throw new Error("A written-out bar needs steps.");
        r = { steps, kind: "steps", pattern: null };
      } else if (prev && !prev.error) {
        r = { steps: prev.steps, kind: "repeat", pattern: prev.pattern, shape: prev.shape };
      } else {
        r = { steps: null, kind: "none", pattern: null };
      }
    } catch (e) {
      r = { steps: null, kind: "error", pattern: b.pattern || null, error: e.message };
    }
    const sh = b.shape !== undefined ? shapesOf(b.shape) : r.shape || null;
    r = { ...r, shape: sh, confidence: b.confidence ?? null, match: b.match || null, given: i < bars.length ? b : null };
    out.push(r);
    if (r.kind !== "error") prev = r;
  }
  return out;
}

// A bar's shape: "x00232" or ["x00232", "x02210"] -> [[frets], ...].
export function shapesOf(shape) {
  const list = Array.isArray(shape) ? shape : [shape];
  return list.map((s) => (s ? specFrets(s) : null));
}

// What's wrong with a part (for checking shipped data and the editor): [messages].
export function checkPart(part) {
  const errs = [];
  if (!part || typeof part !== "object") return ["A part should be an object."];
  if (!["mine", "detected", "verified"].includes(part.source)) errs.push(`A part's source should be mine, detected or verified (got ${part.source}).`);
  if (part.source === "detected" && !part.detector) errs.push("A detected part should name its detector.");
  for (const [k, v] of Object.entries(part.patterns || {})) {
    try { parseSteps(typeof v === "string" ? v : v.steps); } catch (e) { errs.push(`Pattern ${k}: ${e.message}`); }
    if (PATTERN_BY_ID.has(k)) errs.push(`The part's own pattern "${k}" has a library pattern's name.`);
  }
  (part.bars || []).forEach((b, i) => {
    if (b.pattern && !partPattern(part, b.pattern)) errs.push(`Bar ${i + 1}: no pattern "${b.pattern}".`);
    if (b.steps) { try { parseSteps(b.steps); } catch (e) { errs.push(`Bar ${i + 1}: ${e.message}`); } }
    if (b.pattern && b.steps) errs.push(`Bar ${i + 1}: a pattern or written-out steps, not both.`);
    if (b.shape !== undefined && shapesOf(b.shape).some((f) => !f)) errs.push(`Bar ${i + 1}: the shape should be six strings like x00232.`);
  });
  return errs;
}

// A transcription (frets, techniques: notes taken from a recording) stays on the device.
export function isTranscription(part) {
  if (!part) return false;
  const texts = [...Object.values(part.patterns || {}).map((v) => (typeof v === "string" ? v : v.steps)), ...(part.bars || []).map((b) => b.steps || "")];
  return texts.some(isTranscribed);
}

// Where the bars' patterns change: [{ from, to (bar indexes), label }], for the bar strip.
export function patternRuns(expanded) {
  const runs = [];
  expanded.forEach((b, i) => {
    const label = b.kind === "steps" ? "written" : b.pattern || (b.kind === "error" ? "?" : "–");
    const last = runs[runs.length - 1];
    if (last && last.label === label && b.kind !== "steps") last.to = i;
    else runs.push({ from: i, to: i, label });
  });
  return runs;
}

// A part you're editing: a new one is yours ("mine"); a detected one stays
// detected (its edited bars lose their confidence) until you mark it checked.
export function editedPart(part) {
  const p = structuredClone(part || { bars: [] });
  if (!p.source || p.source === "verified") p.source = "mine";
  return p;
}

// Mark as checked: you've played it along with the recording and it's right.
export function checkedPart(part) {
  const p = structuredClone(part);
  if (p.source === "detected") p.checkedFrom = p.detector;
  p.source = "mine";
  for (const b of p.bars || []) { delete b.confidence; delete b.match; }
  return p;
}

/* ---- On the device: IndexedDB "parts", { id: songId, sections: { name: part }, savedAt } ---- */

export async function loadParts(songId) {
  const { get } = await import("./library.js");
  const r = await get("parts", songId).catch(() => null);
  return (r && r.sections) || {};
}

export async function saveSectionPart(songId, sectionName, part) {
  const { get, put } = await import("./library.js");
  const r = (await get("parts", songId).catch(() => null)) || { id: songId, sections: {} };
  if (part) r.sections[sectionName] = part; else delete r.sections[sectionName];
  await put("parts", { ...r, savedAt: Date.now() });
  return r.sections;
}
