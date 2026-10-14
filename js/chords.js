// Chord engine: parse any chord name, transpose with spelling that fits the
// key, simplify for an acoustic version, find fingerings, and suggest a capo.
// Fingerings come from Pimapeggio's shapes, then chords-db (MIT, David Rubert,
// vendor/chords-db), then E- and A-shape barre forms. No DOM: node can import
// it for the unit tests. Call setChordDb() with vendor/chords-db/guitar.json
// before asking for voicings.

import { parseVoicing, resolveChord, EXTRA_VOICINGS, CHORD_BY_ID, OPEN_MIDI } from "./patterns.js";

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
// What chord charts usually write when there's no key to go by.
const COMMON = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const mod12 = (n) => ((n % 12) + 12) % 12;

/* ---- Qualities ----
   iv: intervals above the root. db: chords-db suffix. simple: the quality
   "Simple" turns it into (a triad you'd strum on an acoustic). */
export const QUALITIES = {
  "":      { iv: [0, 4, 7], db: "major", simple: "" },
  "m":     { iv: [0, 3, 7], db: "minor", simple: "m" },
  "5":     { iv: [0, 7], db: null, simple: "" },
  "dim":   { iv: [0, 3, 6], db: "dim", simple: "dim" },
  "dim7":  { iv: [0, 3, 6, 9], db: "dim7", simple: "dim" },
  "aug":   { iv: [0, 4, 8], db: "aug", simple: "aug" },
  "sus2":  { iv: [0, 2, 7], db: "sus2", simple: "" },
  "sus4":  { iv: [0, 5, 7], db: "sus4", simple: "" },
  "7sus4": { iv: [0, 5, 7, 10], db: "7sus4", simple: "" },
  "6":     { iv: [0, 4, 7, 9], db: "6", simple: "" },
  "69":    { iv: [0, 4, 7, 9, 2], db: "69", simple: "" },
  "7":     { iv: [0, 4, 7, 10], db: "7", simple: "" },
  "7b5":   { iv: [0, 4, 6, 10], db: "7b5", simple: "" },
  "aug7":  { iv: [0, 4, 8, 10], db: "aug7", simple: "" },
  "7b9":   { iv: [0, 4, 7, 10, 1], db: "7b9", simple: "" },
  "7#9":   { iv: [0, 4, 7, 10, 3], db: "7#9", simple: "" },
  "9":     { iv: [0, 4, 7, 10, 2], db: "9", simple: "" },
  "11":    { iv: [0, 4, 7, 10, 2, 5], db: "11", simple: "" },
  "13":    { iv: [0, 4, 7, 10, 2, 9], db: "13", simple: "" },
  "maj7":  { iv: [0, 4, 7, 11], db: "maj7", simple: "" },
  "maj9":  { iv: [0, 4, 7, 11, 2], db: "maj9", simple: "" },
  "maj11": { iv: [0, 4, 7, 11, 2, 5], db: "maj11", simple: "" },
  "maj13": { iv: [0, 4, 7, 11, 2, 9], db: "maj13", simple: "" },
  "add9":  { iv: [0, 4, 7, 2], db: "add9", simple: "" },
  "madd9": { iv: [0, 3, 7, 2], db: "madd9", simple: "m" },
  "m6":    { iv: [0, 3, 7, 9], db: "m6", simple: "m" },
  "m69":   { iv: [0, 3, 7, 9, 2], db: "m69", simple: "m" },
  "m7":    { iv: [0, 3, 7, 10], db: "m7", simple: "m" },
  "m9":    { iv: [0, 3, 7, 10, 2], db: "m9", simple: "m" },
  "m11":   { iv: [0, 3, 7, 10, 2, 5], db: "m11", simple: "m" },
  "mmaj7": { iv: [0, 3, 7, 11], db: "mmaj7", simple: "m" },
  "m7b5":  { iv: [0, 3, 6, 10], db: "m7b5", simple: "dim" },
};

const ALIASES = {
  "maj": "", "M": "", "major": "",
  "min": "m", "mi": "m", "-": "m", "minor": "m",
  "M7": "maj7", "Maj7": "maj7", "ma7": "maj7", "Δ": "maj7", "Δ7": "maj7", "∆": "maj7", "∆7": "maj7",
  "M9": "maj9", "Maj9": "maj9",
  "min7": "m7", "mi7": "m7", "-7": "m7",
  "min6": "m6", "min9": "m9", "-9": "m9",
  "ø": "m7b5", "ø7": "m7b5", "min7b5": "m7b5", "-7b5": "m7b5", "m7-5": "m7b5", "m7(b5)": "m7b5",
  "°": "dim", "o": "dim", "°7": "dim7", "o7": "dim7",
  "+": "aug", "#5": "aug", "+5": "aug",
  "+7": "aug7", "7#5": "aug7", "7+5": "aug7", "7+": "aug7",
  "sus": "sus4", "2": "sus2", "add2": "add9", "7sus": "7sus4",
  "6/9": "69", "m6/9": "m69",
  "m(maj7)": "mmaj7", "mM7": "mmaj7", "m(M7)": "mmaj7", "mMaj7": "mmaj7",
  "m(add9)": "madd9", "(add9)": "add9", "madd2": "madd9",
  "7(b9)": "7b9", "7(#9)": "7#9", "7(b5)": "7b5",
};

const CHORD_RE = /^([A-G])([#b♯♭]?)([^/]*(?:\/9)?)(?:\/([A-G])([#b♯♭]?))?$/;

function accidental(a) {
  return a === "#" || a === "♯" ? 1 : a === "b" || a === "♭" ? -1 : 0;
}

function canonicalQuality(q) {
  if (q in QUALITIES) return q;
  if (q in ALIASES) return ALIASES[q];
  return null;
}

// "F#m7/C#" -> { root: 6, q: "m7", bass: 1, name }; "N.C." -> { nc: true }.
// Returns null for anything that isn't a chord.
export function parseChord(name) {
  if (typeof name !== "string") return null;
  const s = name.trim();
  if (/^(N\.?C\.?|n\.?c\.?)$/.test(s)) return { nc: true, name: "N.C." };
  const m = s.match(CHORD_RE);
  if (!m) return null;
  const q = canonicalQuality(m[3]);
  if (q === null) return null;
  const root = mod12(LETTER_PC[m[1]] + accidental(m[2]));
  const bass = m[4] ? mod12(LETTER_PC[m[4]] + accidental(m[5])) : null;
  return {
    root, q, bass: bass === root ? null : bass,
    rootName: m[1] + (accidental(m[2]) > 0 ? "#" : accidental(m[2]) < 0 ? "b" : ""),
    bassName: m[4] ? m[4] + (accidental(m[5]) > 0 ? "#" : accidental(m[5]) < 0 ? "b" : "") : null,
    name: s,
  };
}

export function isChord(name) { return parseChord(name) !== null; }

/* ---- Spelling ---- */

const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm", "Abm"]);
const SHARP_KEYS = new Set(["G", "D", "A", "E", "B", "F#", "C#", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m"]);

// "flat" | "sharp" | "common" for a key like "Eb" or "F#m".
export function spellingForKey(key) {
  if (!key) return "common";
  const k = key.replace("♯", "#").replace("♭", "b").replace(/\s*(major|maj)$/i, "").replace(/\s*minor$/i, "m");
  if (FLAT_KEYS.has(k)) return "flat";
  if (SHARP_KEYS.has(k)) return "sharp";
  return "common";
}

export function spellPc(pc, spelling = "common") {
  const t = spelling === "flat" ? FLAT : spelling === "sharp" ? SHARP : COMMON;
  return t[mod12(pc)];
}

export function chordName(c, spelling = "common") {
  if (!c) return "";
  if (c.nc) return "N.C.";
  return spellPc(c.root, spelling) + c.q + (c.bass !== null ? "/" + spellPc(c.bass, spelling) : "");
}

// The key a transposed key name lands on, spelled the usual way for keys.
export function transposeKey(key, n) {
  if (!key) return key;
  const minor = /m$/.test(key) && !/maj$/i.test(key);
  const c = parseChord(minor ? key.slice(0, -1) : key);
  if (!c || c.nc) return key;
  const pc = mod12(c.root + n);
  // Key names: F# major and Eb minor stay as is; otherwise the fewest accidentals.
  const majorNames = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const minorNames = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
  return minor ? minorNames[pc] + "m" : majorNames[pc];
}

// Transpose a chord name by n semitones; spelling follows the target key
// when given, else the common chart spelling.
export function transposeChord(name, n, key) {
  const c = parseChord(name);
  if (!c) return name;
  if (c.nc) return "N.C.";
  const t = { ...c, root: mod12(c.root + n), bass: c.bass === null ? null : mod12(c.bass + n) };
  return chordName(t, spellingForKey(key));
}

/* ---- Simplify ---- */

// A playable triad for an acoustic version: extensions, sus and slash basses
// dropped. "Simple" in the sheet toolbar.
export function simplifyChord(name, key) {
  const c = parseChord(name);
  if (!c || c.nc) return name;
  return chordName({ ...c, q: QUALITIES[c.q].simple, bass: null }, spellingForKey(key));
}

/* ---- Pitch content ---- */

export function chordPcs(name) {
  const c = parseChord(name);
  if (!c || c.nc) return [];
  const pcs = QUALITIES[c.q].iv.map((i) => mod12(c.root + i));
  if (c.bass !== null && !pcs.includes(c.bass)) pcs.push(c.bass);
  return pcs;
}

/* ---- Key estimate from a list of chords ----
   Each of the 24 keys scores the chords that are diatonic to it (V major
   counts in minor), with a bonus when the first or last chord is the tonic.
   Relative major and minor are close; the caller should present this as an
   estimate. */
export function guessKey(names) {
  const chords = names.map(parseChord).filter((c) => c && !c.nc);
  if (!chords.length) return null;
  const MAJ = [[0, ""], [2, "m"], [4, "m"], [5, ""], [7, ""], [9, "m"], [11, "dim"]];
  const triad = (c) => QUALITIES[c.q].simple;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const rel = minor ? mod12(tonic + 3) : tonic;   // relative major
      let score = 0;
      for (const c of chords) {
        const deg = mod12(c.root - rel);
        if (MAJ.some(([d, q]) => d === deg && q === triad(c))) score += 1;
        else if (minor && c.root === mod12(tonic + 7) && triad(c) === "") score += 0.8; // V in minor
        if (c.root === tonic && triad(c) === (minor ? "m" : "")) score += 0.3;
      }
      // The first chord says more than the last: charts are often loops.
      const isTonic = (c) => c.root === tonic && triad(c) === (minor ? "m" : "");
      if (isTonic(chords[0])) score += 1.5;
      if (isTonic(chords[chords.length - 1])) score += 0.75;
      if (!best || score > best.score + 1e-9) best = { tonic, minor, score };
    }
  }
  const name = transposeKey(best.minor ? "Am" : "C", best.minor ? best.tonic - 9 : best.tonic);
  return { key: name, minor: best.minor, score: best.score };
}

/* ---- Voicings ---- */

let chordDb = null;
export function setChordDb(db) { chordDb = db; voicingCache.clear(); }

// Pimapeggio's open shapes, as "x32010" specs: the first choice for these names.
const PIMA_SPECS = {};
for (const c of CHORD_BY_ID.values()) {
  // Pimapeggio's chords fill unused strings for the thumb (ext); the chord box
  // shows the shape you'd strum, so those strings are muted here.
  PIMA_SPECS[c.id] = c.frets.map((f, i) => (c.ext.includes(6 - i) || f === null ? "x" : String(f))).join("");
}
Object.assign(PIMA_SPECS, EXTRA_VOICINGS);

export function specFrets(spec) {
  const parts = /[-,\s]/.test(spec.trim()) ? spec.trim().split(/[-,\s]+/) : spec.trim().split("");
  if (parts.length !== 6) return null;
  const frets = parts.map((p) => (/^[xX]$/.test(p) ? null : +p));
  return frets.some((f) => f !== null && !(f >= 0 && f <= 24)) ? null : frets;
}

export function fretsSpec(frets) {
  const wide = frets.some((f) => f !== null && f >= 10);
  return frets.map((f) => (f === null ? "x" : String(f))).join(wide ? "-" : "");
}

// Sounding MIDI notes of a voicing, low string first (capo in semitones).
export function voicingMidi(frets, capo = 0) {
  const out = [];
  frets.forEach((f, i) => { if (f !== null) out.push(OPEN_MIDI[6 - i] + f + capo); });
  return out;
}

// How hard a shape is to play: fingers needed, stretch, barre, muted inner
// strings, height on the neck, and a root that isn't in the bass.
export function difficulty(frets, bassPc = null) {
  const played = frets.map((f, i) => [i, f]).filter(([, f]) => f !== null);
  if (played.length < 3) return 50;
  const fretted = played.filter(([, f]) => f > 0);
  let score = 0;
  if (fretted.length) {
    const minF = Math.min(...fretted.map(([, f]) => f));
    const maxF = Math.max(...fretted.map(([, f]) => f));
    const span = maxF - minF;
    if (span > 4) return 60;
    let fingers = fretted.length;
    let barre = false;
    if (fingers > 4) {
      // Barre at the lowest fret across the strings it covers.
      barre = true;
      fingers = 1 + fretted.filter(([, f]) => f > minF).length;
      if (fingers > 4) return 40;
      const firstAtMin = fretted.find(([, f]) => f === minF)[0];
      if (played.some(([i, f]) => i > firstAtMin && f === 0)) return 40; // open string under a barre
    }
    score += fingers * 0.6 + span * 0.5 + (barre ? 4 : 0) + Math.max(0, minF - 3) * 0.5;
    if (minF > 5 && played.some(([, f]) => f === 0)) score += 1;
  } else {
    score += 0.5;
  }
  const first = played[0][0], last = played[played.length - 1][0];
  for (let i = first; i <= last; i++) if (frets[i] === null) score += 1.5;
  if (played.length < 5) score += played.length === 4 ? 0.8 : 2;
  if (bassPc !== null) {
    const low = OPEN_MIDI[6 - played[0][0]] + played[0][1];
    if (mod12(low) !== bassPc) score += 3;
  }
  return Math.round(score * 100) / 100;
}

// Whether a voicing plays only chord tones and all the ones that matter: a
// perfect fifth may be left out of four-note chords, and the ninth out of
// 11ths and 13ths, as guitarists do.
function covers(frets, root, iv, bassPc) {
  const notes = voicingMidi(frets).map(mod12);
  if (!notes.length) return false;
  const pcs = iv.map((i) => mod12(root + i));
  if (bassPc !== null && !pcs.includes(bassPc)) pcs.push(bassPc);
  if (notes.some((n) => !pcs.includes(n))) return false;
  if (bassPc !== null && notes[0] !== bassPc) return false;
  return iv.every((i, k) => notes.includes(mod12(root + i)) ||
    (i === 7 && iv.length >= 4) || (i === 2 && iv.length >= 6));
}

// E-shape (root on string 6) and A-shape (root on string 5) barre forms,
// as offsets from the barre fret.
const E_SHAPES = {
  "": [0, 2, 2, 1, 0, 0], "m": [0, 2, 2, 0, 0, 0], "7": [0, 2, 0, 1, 0, 0], "m7": [0, 2, 0, 0, 0, 0],
  "maj7": [0, null, 1, 1, 0, null], "sus4": [0, 2, 2, 2, 0, 0], "7sus4": [0, 2, 0, 2, 0, 0],
  "6": [0, 2, 2, 1, 2, 0], "m6": [0, 2, 2, 0, 2, 0], "5": [0, 2, 2, null, null, null],
};
const A_SHAPES = {
  "": [null, 0, 2, 2, 2, 0], "m": [null, 0, 2, 2, 1, 0], "7": [null, 0, 2, 0, 2, 0], "m7": [null, 0, 2, 0, 1, 0],
  "maj7": [null, 0, 2, 1, 2, 0], "sus2": [null, 0, 2, 2, 0, 0], "sus4": [null, 0, 2, 2, 3, 0],
  "7sus4": [null, 0, 2, 0, 3, 0], "6": [null, 0, 2, 2, 2, 2], "m6": [null, 0, 2, 2, 1, 2],
  "m7b5": [null, 0, 1, 0, 1, null], "dim7": [null, 0, 1, 2, 1, 2], "add9": [null, 0, 2, 4, 2, 0],
  "5": [null, 0, 2, 2, null, null], "dim": [null, 0, 1, 2, 1, null], "9": [null, 0, -1, 0, 0, null],
};

function barreShapes(c) {
  const out = [];
  const add = (shape, rootString) => {
    if (!shape) return;
    const open = rootString === 6 ? 4 : 9;
    let r = mod12(c.root - open);
    for (const fret of [r, r + 12]) {
      if (fret > 12) continue;
      const frets = shape.map((o) => (o === null ? null : o + fret));
      if (frets.some((f) => f !== null && f < 0)) continue;
      out.push(frets);
      break;
    }
  };
  add(E_SHAPES[c.q], 6);
  add(A_SHAPES[c.q], 5);
  return out;
}

// Put a slash chord's bass under a shape of the chord: on string 6 or 5 near
// the shape (or open), muting the strings below it.
function withBass(frets, bassPc) {
  const out = [];
  const fretted = frets.filter((f) => f !== null && f > 0);
  const lo = fretted.length ? Math.min(...fretted) : 0, hi = fretted.length ? Math.max(...fretted) : 3;
  for (const s of [6, 5, 4]) {
    const idx = 6 - s;
    const higher = frets.slice(idx + 1);
    if (higher.filter((f) => f !== null).length < 3) continue;
    for (let f = 0; f <= 12; f++) {
      if (mod12(OPEN_MIDI[s] + f) !== bassPc) continue;
      if (f > 0 && (f < lo - 1 || f > Math.max(hi, lo + 3) + 0)) continue;
      const v = frets.map((x, i) => (i < idx ? null : i === idx ? f : x));
      out.push(v);
    }
  }
  return out;
}

const SYMMETRIC = new Set(["dim7", "aug"]);
const voicingCache = new Map();

// Voicings for a chord name, easiest first, as { spec, frets, difficulty, from }.
// chartVoicings (a chart's own "voicings") come first, then Pimapeggio's
// shapes, then chords-db, then generated forms.
export function voicingsFor(name, chartVoicings = null) {
  const own = chartVoicings && chartVoicings[name];
  const key = name + "|" + (own || "");
  if (voicingCache.has(key)) return voicingCache.get(key);
  const c = parseChord(name);
  const result = [];
  if (c && !c.nc) {
    const iv = QUALITIES[c.q].iv;
    // dim7 and aug are symmetric: any of their notes makes a fine bass.
    const bassPc = c.bass !== null ? c.bass : SYMMETRIC.has(c.q) ? null : c.root;
    const seen = new Set();
    const push = (frets, from, check = true) => {
      if (!frets) return;
      const spec = fretsSpec(frets);
      if (seen.has(spec)) return;
      if (check && !covers(frets, c.root, iv, c.bass)) return;
      seen.add(spec);
      result.push({ spec, frets, from, difficulty: difficulty(frets, bassPc) });
    };
    // Exact-name lookups use the chart's spelling and the common one.
    const names = [...new Set([name, chordName(c), chordName(c, "sharp"), chordName(c, "flat")])];
    if (own) push(specFrets(own), "chart", false);
    for (const n of names) if (PIMA_SPECS[n]) push(specFrets(PIMA_SPECS[n]), "pimapeggio", false);
    const fromDb = [];
    if (chordDb) {
      const entry = chordDb[COMMON[c.root]] || {};
      const q = QUALITIES[c.q].db;
      if (c.bass !== null) {
        const pre = c.q === "m" ? "m/" : c.q === "" ? "/" : null;
        if (pre) for (const b of [SHARP[c.bass], FLAT[c.bass]]) for (const s of entry[pre + b] || []) fromDb.push(specFrets(s));
      } else if (q) {
        for (const s of entry[q] || []) fromDb.push(specFrets(s));
      }
    }
    const generated = c.bass === null ? barreShapes(c) : [];
    const ranked = [];
    for (const f of fromDb) ranked.push([f, "chords-db"]);
    for (const f of generated) ranked.push([f, "barre"]);
    if (c.bass !== null) {
      // Slash chord: the plain chord's shapes with the bass moved under them.
      const plain = chordName({ ...c, bass: null });
      for (const v of voicingsFor(plain)) for (const f of withBass(v.frets, c.bass)) ranked.push([f, v.from === "pimapeggio" ? "pimapeggio+bass" : "generated"]);
    }
    const before = result.length;
    for (const [f, from] of ranked) push(f, from);
    const tail = result.splice(before).sort((a, b) => a.difficulty - b.difficulty);
    result.push(...tail);
  }
  voicingCache.set(key, result);
  return result;
}

export function bestVoicing(name, chartVoicings) {
  const v = voicingsFor(name, chartVoicings);
  return v.length ? v[0] : null;
}

// A chord in Pimapeggio's format ({ id, frets, ext, bass, alt }), so its
// patterns and chordMidi/noteString work over any chord.
export function pimaChord(name, chartVoicings) {
  const own = chartVoicings && chartVoicings[name] ? { [name]: chartVoicings[name] } : null;
  const known = resolveChord(name, own);
  if (known) return known;
  const v = bestVoicing(name, chartVoicings);
  return v ? parseVoicing(name, v.spec) : null;
}

/* ---- Capo ---- */

// Choose capo 0-maxCapo so the shapes are easiest. `names` are sounding
// chords (repeats count: a chord used often matters more). Returns
// { capo, cost, shapes: { sounding: shape }, ranking: [{ capo, cost }] }.
export function suggestCapo(names, { maxCapo = 7, key = null } = {}) {
  const counts = new Map();
  for (const n of names) { const c = parseChord(n); if (c && !c.nc) counts.set(n, (counts.get(n) || 0) + 1); }
  const ranking = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    const shapeKey = key ? transposeKey(key, -capo) : null;
    let cost = 0;
    const shapes = {};
    for (const [n, k] of counts) {
      const shape = transposeChord(n, -capo, shapeKey);
      shapes[n] = shape;
      const v = bestVoicing(shape);
      cost += k * (v ? v.difficulty : 30);
    }
    // A small nudge toward lower capos when shapes are about as easy.
    cost = cost / Math.max(1, names.length) + capo * 0.1;
    ranking.push({ capo, cost: Math.round(cost * 100) / 100, shapes });
  }
  const best = ranking.reduce((a, b) => (b.cost < a.cost ? b : a));
  return { capo: best.capo, cost: best.cost, shapes: best.shapes, ranking: ranking.map(({ capo, cost }) => ({ capo, cost })) };
}

/* ---- Charts ---- */

// "C | G/B | Am7 G/B" -> [["C"], ["G/B"], ["Am7", "G/B"]] (names only).
export function splitBars(str) {
  return String(str || "").split("|").map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s+/));
}

// Every chord name in a chart, in order (sections expanded by repeat, not by form).
export function chartChordNames(chart) {
  const out = [];
  for (const s of chart.sections || []) for (const bar of splitBars(s.chords)) out.push(...bar);
  return out;
}

// How a chart's chords are shown: shapes for the capo you play with, after
// transposing (sounding pitch) and simplifying.
// chart.capo is the capo the written shapes assume; view.capo is yours.
export function displayChord(name, chart, view) {
  const shift = (chart.capo || 0) + (view.transpose || 0) - (view.capo ?? (chart.capo || 0));
  const soundingKey = chart.key ? transposeKey(chart.key, view.transpose || 0) : null;
  const shapeKey = soundingKey ? transposeKey(soundingKey, -(view.capo ?? (chart.capo || 0))) : view.shapeKey || null;
  let n = transposeChord(name, shift, shapeKey);
  if (view.simple) n = simplifyChord(n, shapeKey);
  return n;
}

// Pretty names for display: ♯ and ♭.
export function prettyChord(name) {
  return String(name).replace(/([A-G])#/g, "$1♯").replace(/([A-G])b/g, "$1♭");
}

// The chords that belong to a key, for the chord picker: I ii iii IV V vi
// (and V7) in major; i III iv v VI VII and V, V7 in minor.
export function diatonicChords(key) {
  if (!key) return [];
  const minor = /m$/.test(key);
  const c = parseChord(minor ? key.slice(0, -1) : key);
  if (!c || c.nc) return [];
  const sp = spellingForKey(key);
  const name = (iv, q) => spellPc(c.root + iv, sp) + q;
  return minor
    ? [name(0, "m"), name(3, ""), name(5, "m"), name(7, "m"), name(7, ""), name(8, ""), name(10, ""), name(7, "7")]
    : [name(0, ""), name(2, "m"), name(4, "m"), name(5, ""), name(7, ""), name(9, "m"), name(7, "7")];
}
