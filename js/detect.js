// Turning the analyser's output into a chart: a chord per beat (named from
// bass and treble chroma by js/chordrec.js, or essentia's own per-beat chords
// in charts saved before), gaps filled from neighbours, beat 1 estimated from
// where the chords change, each half bar named from its beats' chroma (or its
// majority chord), doubtful bars marked, and repeated 8- or 4-bar blocks
// turned into sections. Pure functions: node tests them on made-up arrays.

import { parseChord, chordName, guessKey, simplifyChord } from "./chords.js";
import { labelBeats, nameChroma, combineRows } from "./chordrec.js";

export const DETECTOR = "Songbook chord profiles on NNLS-style chroma, beats and key by essentia.js";
export const OLD_DETECTOR = "essentia.js ChordsDetectionBeats";

// "A#m" (essentia spells with sharps) -> "Bbm"; "N" or junk -> null.
export function cleanChord(name) {
  const c = parseChord(String(name || "").trim());
  return c && !c.nc ? chordName(c) : null;
}

// One entry per beat interval: { t0, t1, chord, strength }, with gaps filled
// from the previous chord (or the next, at the start). With chroma, `chord`
// is the beat's triad family (for finding bar lines), `full` the beat's own
// chord, and each beat keeps its chroma and the key for naming bars.
export function beatChords(raw) {
  const { ticks } = raw;
  const out = [];
  if (raw.chroma && raw.chroma.treble) {
    const { treble, bass, energy } = raw.chroma;
    const key = keyName(raw.keys && raw.keys[raw.profile || "edma"]);
    const labels = labelBeats(treble, bass, energy, key);
    for (let i = 0; i + 1 < ticks.length && i < labels.length; i++) {
      out.push({ t0: ticks[i], t1: ticks[i + 1], chord: labels[i].family, full: labels[i].chord, strength: labels[i].strength,
        treble: treble[i], bass: bass && bass[i], key });
    }
  } else {
    const { chords, strength } = raw;
    for (let i = 0; i + 1 < ticks.length; i++) {
      out.push({ t0: ticks[i], t1: ticks[i + 1], chord: cleanChord(chords[i]), strength: strength[i] ?? 0 });
    }
  }
  let last = null;
  for (const b of out) { if (b.chord) last = b.chord; else if (last) { b.chord = last; b.filled = true; } }
  const first = out.find((b) => b.chord);
  for (const b of out) { if (b.chord) break; b.chord = first ? first.chord : null; b.filled = true; }
  return out;
}

// Which beat (0..bpb-1) is beat 1: the phase where chord changes most often
// land on the first beat of a bar.
export function findDownbeat(beats, bpb = 4) {
  const score = new Array(bpb).fill(0);
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].chord !== beats[i - 1].chord) {
      score[i % bpb] += 1;
      // A change on the bar's middle beat is common too; one on an off beat less so.
      if (bpb === 4) score[(i + 2) % bpb] += 0.25;
    }
  }
  let best = 0;
  for (let p = 1; p < bpb; p++) if (score[p] > score[best] + 1e-9) best = p;
  return best;
}

// 4/4 or 3/4, and where beat 1 is: 3/4 wins only when chord changes line
// up with it clearly better than with 4/4.
export function findMeter(beats) {
  const fit = (bpb) => {
    const phase = findDownbeat(beats, bpb);
    let on = 0, all = 0;
    for (let i = 1; i < beats.length; i++) {
      if (beats[i].chord === beats[i - 1].chord) continue;
      all++;
      const pos = (i - phase + bpb * 1000) % bpb;
      if (pos === 0) on++;
      else if (bpb === 4 && pos === 2) on += 0.5;
    }
    return { bpb, phase, fit: all ? on / all : 0 };
  };
  const four = fit(4), three = fit(3);
  return three.fit > four.fit + 0.15 ? three : four;
}

// The chord most present in a run of beats, weighted by strength.
function majority(beats) {
  const w = new Map();
  let total = 0;
  for (const b of beats) {
    if (!b.chord) continue;
    const x = 0.25 + (b.strength || 0);
    w.set(b.chord, (w.get(b.chord) || 0) + x);
    total += x;
  }
  let best = null, bw = 0;
  for (const [c, x] of w) if (x > bw) { best = c; bw = x; }
  return { chord: best, share: total ? bw / total : 0 };
}

// Beats -> bars: [{ t, t1, n, beat (index of its first beat), chords, strength, sure }].
// Beats before beat 1 make a short pickup bar.
export function makeBars(beats, { bpb = 4, phase = 0 } = {}) {
  const bars = [];
  const add = (from, to) => {
    const bs = beats.slice(from, to);
    if (!bs.length) return;
    let chords, share;
    if (bs.length >= 4 && bpb % 2 === 0) {
      const half = bs.length / 2;
      const whole = majority(bs).chord;
      // A half that's a toss-up goes with the bar's overall chord, so one stray
      // beat doesn't split the bar.
      const halfOf = (part) => {
        const m = majority(part);
        return m.share < 0.6 && part.some((x) => x.chord === whole) ? { chord: whole, share: m.share } : m;
      };
      const a = halfOf(bs.slice(0, half)), b = halfOf(bs.slice(half));
      chords = a.chord === b.chord || !b.chord ? [a.chord] : !a.chord ? [b.chord] : [a.chord, b.chord];
      share = (a.share + b.share) / 2;
    } else {
      const m = majority(bs);
      chords = [m.chord];
      share = m.share;
    }
    let strength = bs.reduce((s, b) => s + (b.strength || 0), 0) / bs.length;
    let sure = share >= 0.6 && strength >= WEAK;
    // With chroma, each part of the bar is named from all its beats together.
    if (bs[0].treble && chords.filter(Boolean).length) {
      const n = chords.filter(Boolean).length;
      const named = [];
      for (let p = 0; p < n; p++) {
        const part = bs.slice(Math.round(p * bs.length / n), Math.round((p + 1) * bs.length / n));
        named.push(nameChroma(combineRows(part.map((x) => x.treble)), combineRows(part.map((x) => x.bass)), bs[0].key));
      }
      chords = named.map((x) => x.chord);
      strength = named.reduce((s, x) => s + x.strength, 0) / n;
      sure = named.every((x) => x.margin >= SURE_MARGIN) && strength >= WEAK;
    }
    bars.push({ t: bs[0].t0, t1: bs[bs.length - 1].t1, n: bs.length, beat: from, chords: chords.filter(Boolean),
      strength: Math.round(strength * 1000) / 1000, sure });
  };
  if (phase > 0) add(0, phase);
  for (let i = phase; i < beats.length; i += bpb) add(i, Math.min(beats.length, i + bpb));
  return bars.filter((b) => b.chords.length);
}

// Below this mean strength a bar shows "?"; with chroma, also when the best
// chord is barely ahead of the best one with another root or triad.
export const WEAK = 0.45;
export const SURE_MARGIN = 0.04;

const barKey = (b) => b.chords.join(" ");

// Repeated blocks of 8 bars (then 4) become sections A, B, C...; bars between
// them become their own sections. Returns { sections, form, spans } where
// spans[i] lists the bar indexes the i-th form entry covers.
export function findSections(bars) {
  const keys = bars.map(barKey);
  const n = keys.length;
  const blockAt = (i, L) => (i + L <= n ? keys.slice(i, i + L).join("|") : null);
  const occurs = (block, from, L) => {
    for (let j = from; j + L <= n; j++) if (blockAt(j, L) === block) return true;
    return false;
  };
  const labels = new Map();   // block -> section name
  const sections = [];
  const form = [];
  const spans = [];
  let loose = [];
  let letter = 0;
  const flushLoose = (atEnd) => {
    if (!loose.length) return;
    const name = form.length === 0 ? "Start" : atEnd ? "End" : "Link " + (sections.filter((s) => s.name.startsWith("Link")).length + 1);
    sections.push({ name, chords: loose.map((i) => bars[i].chords.join(" ")).join(" | "), bars: [...loose] });
    form.push(name);
    spans.push(loose);
    loose = [];
  };
  let i = 0;
  while (i < n) {
    let took = false;
    for (const L of [8, 4]) {
      const block = blockAt(i, L);
      if (!block) continue;
      if (labels.has(block) || occurs(block, i + L, L)) {
        flushLoose(false);
        if (!labels.has(block)) {
          const name = "Part " + String.fromCharCode(65 + letter++);
          labels.set(block, name);
          sections.push({ name, chords: keys.slice(i, i + L).join(" | "), bars: [] });
        }
        const name = labels.get(block);
        const span = Array.from({ length: L }, (_, k) => i + k);
        sections.find((s) => s.name === name).bars.push(...span);
        form.push(name);
        spans.push(span);
        i += L;
        took = true;
        break;
      }
    }
    if (!took) { loose.push(i); i++; }
  }
  flushLoose(true);
  return { sections, form, spans };
}

// Per-beat chords at twice or half the tempo: each beat split in two, or
// pairs of beats merged (keeping the stronger one's chord).
export function rescaleBeats(beats, factor) {
  if (factor === 2) {
    return beats.flatMap((b) => {
      const mid = (b.t0 + b.t1) / 2;
      return [{ ...b, t1: mid }, { ...b, t0: mid }];
    });
  }
  if (factor === 0.5) {
    const out = [];
    for (let i = 0; i < beats.length; i += 2) {
      const a = beats[i], b = beats[i + 1];
      if (!b) { out.push(a); break; }
      const w = (b.strength || 0) > (a.strength || 0) && b.chord !== a.chord ? b : a;
      const m = { t0: a.t0, t1: b.t1, chord: w.chord, full: w.full, strength: (a.strength + b.strength) / 2 };
      if (a.treble) Object.assign(m, { treble: a.treble.map((x, k) => (x + b.treble[k]) / 2), bass: a.bass && a.bass.map((x, k) => (x + b.bass[k]) / 2), key: a.key });
      out.push(m);
    }
    return out;
  }
  return beats;
}

// ×2 / ÷2: put a beat between each pair, or keep every other beat.
export function scaleBeats(ticks, factor) {
  if (factor === 2) {
    const out = [];
    for (let i = 0; i < ticks.length; i++) {
      out.push(ticks[i]);
      if (i + 1 < ticks.length) out.push((ticks[i] + ticks[i + 1]) / 2);
    }
    return out;
  }
  if (factor === 0.5) return ticks.filter((_, i) => i % 2 === 0);
  return ticks.slice();
}

// The analyser's key ("Bb", "minor") as a key name ("Gm").
export function keyName(k) {
  if (!k || !k.key) return null;
  const c = cleanChord(k.key);
  return c ? c + (k.scale === "minor" ? "m" : "") : null;
}

// Sections from the PC helper's segments ([{ name, bars: [first, last] }],
// found by sound as well as chords), named with the bars' chords now. A part
// whose chords differ on a repeat gets its own numbered section, as on the PC.
export function sectionsFromSegments(bars, segments) {
  const sections = [], form = [];
  for (const sg of segments) {
    const chords = bars.slice(sg.bars[0], sg.bars[1] + 1).map((b) => b.chords.join(" ")).join(" | ");
    const base = String(sg.name).replace(/ \(\d+\)$/, "");
    const same = sections.filter((s) => s.name === base || s.name.startsWith(base + " ("));
    let sec = same.find((s) => s.chords === chords);
    if (!sec) {
      sec = { name: same.length ? `${base} (${same.length + 1})` : base, chords };
      sections.push(sec);
    }
    form.push(sec.name);
  }
  return { sections, form };
}

const segmentsFit = (segs, bars) => Array.isArray(segs) && segs.length && segs.every((s) => s.bars[0] <= s.bars[1] && s.bars[1] < bars.length);

// A chart from bars. meta: { bpm, bpb, keys, profile, version, duration, file,
// detector (when not this app's), segments (the PC helper's, when the bars are its own) }.
export function detectedChart(bars, ticks, meta) {
  const { sections, form } = segmentsFit(meta.segments, bars) ? sectionsFromSegments(bars, meta.segments) : findSections(bars);
  const names = bars.flatMap((b) => b.chords);
  const fromAnalyser = keyName(meta.keys && meta.keys[meta.profile || "edma"]);
  const sure = bars.filter((b) => b.sure).length / Math.max(1, bars.length);
  return {
    key: fromAnalyser || (guessKey(names) || {}).key || null,
    capo: 0,
    time: meta.bpb === 3 ? "3/4" : "4/4",
    tempo: Math.round(meta.bpm),
    style: null, strum: null, voicings: {},
    sections: sections.map(({ name, chords }) => ({ name, chords })),
    form,
    source: "detected",
    detector: meta.detector || `${meta.oldDetector ? OLD_DETECTOR : DETECTOR} (essentia ${meta.version || "?"})`,
    confidence: sure >= 0.85 ? "medium" : "low",
    sources: [],
    notes: meta.detector ? "Detected from your recording on the PC: a draft. Check it by ear with Play along." : "Detected from your recording: a draft. Check it by ear with Play along.",
    beats: ticks.map((t) => Math.round(t * 1000) / 1000),
    bars: bars.map((b) => ({ t: Math.round(b.t * 1000) / 1000, n: b.n, chords: b.chords, strength: b.strength, sure: b.sure, edited: !!b.edited })),
    analysis: { bpm: meta.bpm, bpmConfidence: meta.bpmConfidence, keys: meta.keys, profile: meta.profile || "edma",
      bpb: meta.bpb || 4, phase: meta.phase || 0, duration: meta.duration, file: meta.file || null, at: meta.at || null,
      tuning: meta.tuning ?? null },
  };
}

// How a detected chart compares with a cited one: the best alignment of the
// cited progression (sounding pitch, as triads) against the detected bars.
// Returns { agree, total, bars: [true|false per detected bar] } or null.
export function compareWithChart(bars, other, transposeOther = 0, transposeFn) {
  const seq = [];
  for (const name of other.form && other.form.length ? other.form : other.sections.map((s) => s.name)) {
    const s = other.sections.find((x) => x.name === name);
    if (!s) continue;
    for (const bar of String(s.chords).split("|").map((x) => x.trim()).filter(Boolean)) {
      const first = bar.split(/\s+/)[0];
      seq.push(simplifyChord(transposeFn ? transposeFn(first, transposeOther) : first));
    }
  }
  if (!seq.length || !bars.length) return null;
  const mine = bars.map((b) => simplifyChord(b.chords[0]));
  let best = null;
  for (let off = 0; off < seq.length; off++) {
    const hit = mine.map((c, i) => c === seq[(i + off) % seq.length]);
    const agree = hit.filter(Boolean).length;
    if (!best || agree > best.agree) best = { agree, total: mine.length, bars: hit, offset: off };
  }
  return best;
}
