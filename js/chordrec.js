// Naming chords from bass and treble chroma (js/chroma.js), with a larger
// vocabulary than essentia's major/minor triads: 7, maj7, m7, sus2, sus4,
// dim, and slash chords when the bass sits on another chord tone.
// Each chord is scored like Chordino's chord profiles: how much of the treble
// energy falls on the chord's notes versus elsewhere, plus how clearly the
// bass sits on the chord's bass note. Extensions carry a small penalty, so a
// triad wins unless the extra note is really there. Per beat, a Viterbi pass
// keeps chords from flickering. Pure functions: node tests them.

import { chordName, simplifyChord, parseChord } from "./chords.js";

// Chroma arrays start at A; chord roots in chords.js start at C.
const A_TO_C = 3;

export const VOCAB = [
  { q: "", iv: [0, 4, 7], penalty: 0 },
  { q: "m", iv: [0, 3, 7], penalty: 0 },
  { q: "7", iv: [0, 4, 7, 10], penalty: 0.035 },
  { q: "maj7", iv: [0, 4, 7, 11], penalty: 0.035 },
  { q: "m7", iv: [0, 3, 7, 10], penalty: 0.035 },
  { q: "sus4", iv: [0, 5, 7], penalty: 0.1 },
  { q: "sus2", iv: [0, 2, 7], penalty: 0.12 },
  { q: "dim", iv: [0, 3, 6], penalty: 0.08 },
];
export const SLASH = { penalty: 0.07 };
export const TUNE = { nonChord: 1, bassWeight: 0.35, change: 0.12, keyBonus: 0.04 };

// All candidates: { name, family, root, pcs, bass, penalty } (pitch classes from C).
export const CANDIDATES = (() => {
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const v of VOCAB) {
      const pcs = v.iv.map((i) => (root + i) % 12);
      const base = { root, q: v.q, bass: null };
      const name = chordName(base);
      const family = simplifyChord(name);
      out.push({ name, family, root, pcs, bass: root, penalty: v.penalty });
      // Inversions: bass on the third, fifth or seventh.
      for (const i of v.iv.slice(1)) {
        if (v.q.startsWith("sus") || v.q === "dim") continue;
        const bass = (root + i) % 12;
        out.push({ name: chordName({ ...base, bass }), family, root, pcs, bass, penalty: v.penalty + SLASH.penalty });
      }
    }
  }
  return out;
})();

// 12 values from A -> normalised to the largest, rotated to start at C.
function prep(v) {
  const out = new Array(12);
  let max = 0;
  for (const x of v) if (x > max) max = x;
  for (let i = 0; i < 12; i++) out[(i - A_TO_C + 12) % 12] = max > 0 ? v[i] / max : 0;
  return out;
}

// The notes of a key ("Gm", "Bb"): its major scale, or for a minor key the
// natural minor plus the raised seventh (so V and V7 count as in key).
export function keyScale(key) {
  const m = /^([A-G][b#]?)(m?)$/.exec(key || "");
  if (!m) return null;
  const c = parseChord(m[1]);
  if (!c || c.nc) return null;
  const minor = !!m[2];
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(steps.map((s) => (c.root + s) % 12));
}

// Scores for every candidate on one chroma pair (treble and bass, from A).
// scale: an optional keyScale(); chords inside it get a small bonus.
export function scoreAll(treble, bass, scale = null) {
  const t = prep(treble), b = prep(bass || new Array(12).fill(0));
  const tSum = t.reduce((s, x) => s + x, 0), bSum = b.reduce((s, x) => s + x, 0);
  const hasBass = bSum > 0;
  return CANDIDATES.map((c) => {
    let on = 0;
    for (const p of c.pcs) on += t[p];
    const inMean = on / c.pcs.length, outMean = (tSum - on) / (12 - c.pcs.length);
    let s = inMean - TUNE.nonChord * outMean - c.penalty;
    if (hasBass) s += TUNE.bassWeight * (b[c.bass] - (bSum - b[c.bass]) / 11);
    if (scale && c.pcs.every((p) => scale.has(p)) && scale.has(c.bass)) s += TUNE.keyBonus;
    return s;
  });
}

// How well chroma fits a chord's notes: correlation with its template (0..1).
export function fit(treble, pcs) {
  const t = prep(treble);
  const tmpl = new Array(12).fill(0);
  for (const p of pcs) tmpl[p] = 1;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / 12;
  const mt = mean(t), mm = mean(tmpl);
  let num = 0, dt = 0, dm = 0;
  for (let i = 0; i < 12; i++) { num += (t[i] - mt) * (tmpl[i] - mm); dt += (t[i] - mt) ** 2; dm += (tmpl[i] - mm) ** 2; }
  return dt && dm ? Math.max(0, num / Math.sqrt(dt * dm)) : 0;
}

// The best chord for one stretch of chroma: { chord, family, strength, margin }.
// margin: how far ahead of the best chord from another family it is.
export function nameChroma(treble, bass, key = null) {
  const s = scoreAll(treble, bass, keyScale(key));
  let best = 0;
  for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i;
  const c = CANDIDATES[best];
  let other = -Infinity;
  for (let i = 0; i < s.length; i++) if (CANDIDATES[i].family !== c.family && s[i] > other) other = s[i];
  return { chord: c.name, family: c.family, strength: Math.round(fit(treble, c.pcs) * 1000) / 1000, margin: Math.round((s[best] - other) * 1000) / 1000 };
}

// Sum of chroma rows.
export function sumRows(rows) {
  const out = new Array(12).fill(0);
  for (const r of rows) if (r) for (let i = 0; i < 12; i++) out[i] += r[i];
  return out;
}

// Chroma for a stretch of beats: each beat scaled to its loudest note, then
// the median per note (the mean for one or two beats). Chord tones last the
// whole stretch; a melody moving over it doesn't, so it counts for less.
export function combineRows(rows) {
  const rs = rows.filter(Boolean).map((r) => {
    const m = Math.max(...r);
    return m > 0 ? r.map((x) => x / m) : r;
  });
  if (!rs.length) return new Array(12).fill(0);
  if (rs.length < 3) return sumRows(rs).map((x) => x / rs.length);
  const out = new Array(12);
  for (let i = 0; i < 12; i++) {
    const v = rs.map((r) => r[i]).sort((a, b) => a - b);
    const h = v.length / 2;
    out[i] = v.length % 2 ? v[Math.floor(h)] : (v[h - 1] + v[h]) / 2;
  }
  return out;
}

// A chord per beat, smoothed: Viterbi over the candidates with a cost for
// changing chord. Quiet beats (energy far below the song's) get null.
// Returns [{ chord, family, strength }].
export function labelBeats(treble, bass, energy = null, key = null) {
  const scale = keyScale(key);
  const n = treble.length;
  if (!n) return [];
  const loud = energy ? [...energy].sort((a, b) => a - b)[Math.floor(energy.length / 2)] : 1;
  const K = CANDIDATES.length;
  let prev = new Float64Array(K);
  const back = [];
  for (let i = 0; i < n; i++) {
    const s = scoreAll(treble[i], bass && bass[i], scale);
    const cur = new Float64Array(K);
    const from = new Int32Array(K);
    let bestPrev = 0;
    for (let k = 1; k < K; k++) if (prev[k] > prev[bestPrev]) bestPrev = k;
    for (let k = 0; k < K; k++) {
      const stay = prev[k], jump = prev[bestPrev] - TUNE.change;
      if (i === 0 || stay >= jump) { cur[k] = stay + s[k]; from[k] = k; }
      else { cur[k] = jump + s[k]; from[k] = bestPrev; }
    }
    back.push(from);
    prev = cur;
  }
  let k = 0;
  for (let j = 1; j < K; j++) if (prev[j] > prev[k]) k = j;
  const path = new Array(n);
  for (let i = n - 1; i >= 0; i--) { path[i] = k; k = back[i][k]; }
  return path.map((k, i) => {
    const c = CANDIDATES[k];
    const quiet = energy && energy[i] < loud * 0.08;
    return quiet ? { chord: null, family: null, strength: 0 } : { chord: c.name, family: c.family, strength: Math.round(fit(treble[i], c.pcs) * 1000) / 1000 };
  });
}
